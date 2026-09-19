// 出片后置钩子：末帧接力 + 全集风格锚（2026-09-14 从 routes/generate.js 抽出）
//
// 抽取背景：generate.js 拆分时，这两个钩子同时被「出片组」和「缝合组」使用——
// 出片成功后 fire-and-forget 调它们；/continuity-frame 兜底接口也调 relayLastFrameToNextShot。
// 若留在某个路由文件里，另一组就得跨路由文件 import，不如收敛到 ai/ 下当共享能力。
// 依赖自包含（不含 generate.js 的模块级状态），只读 DB + 写本地文件，无副作用。
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { queryOne, execute } from '../db.js'
import { insecureDownload } from './runninghub.js'
import { checkSeamByShotId } from './seamCheck.js'
import { uploadsUrlToAbs } from './shared.js'
import ffmpegStaticPath from 'ffmpeg-static'

const execFile = promisify(execFileCb)
const uploadsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'uploads')

// 本镜末帧自动成为下一镜的 continuity 锚。下一镜出片时走 v4Video.js 的
// keyframe completion / "The shot begins from <Picture N>" 开场帧锚定。
// 设计：写独立的 shots.continuity_url（不覆盖 frame_url，四宫格/构图锚不丢）；
// 末帧文件名确定性（shot_<id>_last.jpg），重新出片幂等覆盖不堆积。
export async function relayLastFrameToNextShot(shot) {
  const videoUrl = String(shot.video_url || '').trim()
  if (!videoUrl) throw new Error('该镜还没有成片')

  // 定位成片本地文件；远端 URL（成片落本地失败时的 24h 时效链接）则下载兜底
  let absVideo
  if (videoUrl.startsWith('/uploads/')) {
    // 保留子目录解析（2026-09-16 审核修复 P0-3）：段切片回填的 video_url 在
    // /uploads/segments/segN/ 下，旧实现用 basename 压到 uploads 根 → 找不到文件，
    // 接力失败。统一走 shared.uploadsUrlToAbs（与 shotReview/seamCheck/generate-post 同口径）。
    absVideo = uploadsUrlToAbs(videoUrl, uploadsDir)
    if (!absVideo) throw new Error('成片本地文件已不存在（可能被清理）')
  } else if (/^https?:/i.test(videoUrl)) {
    const buf = await insecureDownload(videoUrl)
    // 确定性文件名：同一镜反复接力不堆积临时下载
    absVideo = path.join(uploadsDir, `shot_${shot.id}_relay.mp4`)
    fs.writeFileSync(absVideo, buf)
  } else {
    throw new Error(`无法识别的成片地址: ${videoUrl}`)
  }

  // 找全片播放序的下一镜（episode 内按 start_time, id 排序）
  const nextShot = queryOne(
    `SELECT s.id, s.shot_number, ss.scene_number AS next_scene FROM shots s
     JOIN storyboard_scenes ss ON ss.id = s.storyboard_scene_id
     WHERE ss.episode_id = (SELECT episode_id FROM storyboard_scenes WHERE id = ?)
       AND (s.start_time > ? OR (s.start_time = ? AND s.id > ?))
     ORDER BY s.start_time, s.id LIMIT 1`,
    [shot.storyboard_scene_id, shot.start_time, shot.start_time, shot.id]
  )
  if (!nextShot) throw new Error('本集最后一镜，没有下一镜可以接力')

  // 跨场判定（2026-09-14，2-1→3-1 场次盲硬接事故的代码层根治，与 mcPolicy 同思想）：
  // 换场跳切是设计，上一场的末帧不该作为下一场的构图/接力锚。末帧仍抽——
  // 首镜风格锚 anchorEpisodeStyle 依赖落盘文件，且日志/排查也需要；只是不写
  // continuity_url。旧注释「跨场次衔接也正确」已被 9-11 事故证伪，废除。
  const myScene = queryOne(
    'SELECT scene_number FROM storyboard_scenes WHERE id = ?',
    [shot.storyboard_scene_id]
  )
  const crossScene = myScene
    ? Number(myScene.scene_number) !== Number(nextShot.next_scene)
    : false

  // ffmpeg 抽末帧（-sseof 从尾部 seek，取 1 帧）
  const contDir = path.join(uploadsDir, 'continuity')
  fs.mkdirSync(contDir, { recursive: true })
  const outName = `shot_${shot.id}_last.jpg`
  const outPath = path.join(contDir, outName)
  await execFile(ffmpegStaticPath, ['-y', '-sseof', '-0.1', '-i', absVideo, '-update', '1', '-frames:v', '1', outPath])
  if (!fs.existsSync(outPath)) throw new Error('末帧抽取失败：输出为空')

  // 跨场：末帧抽完即返回，不把上一场末帧写进下一场的接力锚（见上方跨场判定注释）
  if (crossScene) {
    // 跨场首镜语义上不该有锚（换场不接力），但**历史残留必须清**：场次重排或早期版本
    // 留下的 continuity_url 会被 v4Video.js 当锚用（episodes.js 已记录过"残留锚把新镜头
    // 锚死在旧构图上"的坑）。同时作废其 seam_check——旧结论是对旧锚算的，锚没了结论即失效。
    execute('UPDATE shots SET continuity_url = NULL, seam_check = NULL WHERE id = ?', [nextShot.id])
    console.log(`[relayLastFrame] 跨场跳切：shot ${shot.id}（场 ${myScene.scene_number}）→ shot ${nextShot.id}（场 ${nextShot.next_scene}）不写接力锚，清残留锚；末帧仅落盘（风格锚/排查用）`)
    return { skipped: 'cross-scene', continuityUrl: null, nextShotId: nextShot.id, nextShotNumber: nextShot.shot_number }
  }

  const continuityUrl = `/uploads/continuity/${outName}`
  // 写新锚帧的同时作废下一镜的旧 seam_check：下一镜若已有成片，其检测记录是对
  // 旧锚帧算的，锚帧一换结论即失效——不清理会让前端卡片拿过期结论"没标红"背书
  // （2026-09-11 实锤：3-1 重生后 3-2 的存档检测仍 OK，重算亮度差 56 已超阈值 45）。
  execute('UPDATE shots SET continuity_url = ?, seam_check = NULL WHERE id = ?', [continuityUrl, nextShot.id])
  // 2026-09-15 补口（「上游重出 → 下游接缝记录永久悬空」的根治）：
  // 旧逻辑置 NULL 之后就完事了——若下一镜已有成片且此后不再重出，它的接缝结论便永久缺席
  // （前端显示"接缝质量未知"，锁4 失去判断依据，坏接缝没人拦）。实测第2集 1-3/1-5/2-3
  // 三镜即因此悬空，其中 2-3 离线复算 Δluma=51 已超阈值 45——真实告警却无人知晓。
  // 现在置空后立即补检：有锚有片即刻重算；无片（正常首次出片流程）静默跳过。
  // fire-and-forget：补检失败只记日志，绝不影响接力主流程（与末帧接力同口径）。
  checkSeamByShotId(nextShot.id).catch((e) => {
    const msg = String(e.message || e)
    const benign = /还没有成片|没有 continuity 锚/.test(msg)
    console.log(`[relayLastFrame] shot ${nextShot.id} 接缝补检${benign ? '跳过（尚无成片/无锚，属正常）' : '失败'}: ${msg.slice(0, 100)}`)
  })
  return { continuityUrl, nextShotId: nextShot.id, nextShotNumber: nextShot.shot_number }
}

// 全集风格锚（Sora 招，2026-09-12）：本镜是全集第一镜时，复用接力刚抽的末帧
// 存为 episodes.style_anchor_url——后续每镜 refs 自动补风格锚槽。出片成功后 fire-and-forget。
export async function anchorEpisodeStyle(shot) {
  const first = queryOne(
    `SELECT s.id FROM shots s
     JOIN storyboard_scenes ss ON ss.id = s.storyboard_scene_id
     WHERE ss.episode_id = ? ORDER BY s.start_time, s.id LIMIT 1`,
    [shot.episode_id]
  )
  if (first?.id !== shot.id) return null // 不是首镜，不动锚
  const lastFrame = path.join(uploadsDir, 'continuity', `shot_${shot.id}_last.jpg`)
  if (!fs.existsSync(lastFrame)) return null // 接力末帧还没落盘（接力失败时不抢跑）
  const dir = path.join(uploadsDir, 'style_anchor')
  fs.mkdirSync(dir, { recursive: true })
  const outName = `ep${shot.episode_id}_style.jpg`
  fs.copyFileSync(lastFrame, path.join(dir, outName))
  const url = `/uploads/style_anchor/${outName}`
  execute('UPDATE episodes SET style_anchor_url = ? WHERE id = ?', [url, shot.episode_id])
  return url
}
