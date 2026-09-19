import { Router } from 'express'
import { randomUUID } from 'crypto'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { query, queryOne, execute, transaction } from '../db.js'
import { scriptHash } from '../scriptHash.js'

const execFile = promisify(execFileCb)
import { generateScript, classifyScriptIntent, reviseScriptEdits, applyScriptEdits, rewriteFullScript, rewriteScriptSegment, extractAssets, generateStoryboard, generateStoryboardFromFile, extractBlockingForScene, assembleBlockingPlan, enrichShotIntegrated, chatCompletion } from '../ai/doubao.js'
import { ensureStandardScript } from '../ai/scriptFormat.js'
import { buildSceneGridPrompt, buildShotGridPrompt, buildShotGridContentApp, allocateShotRefs, splitSceneGrid } from '../ai/directorRequest.js'
import { runWorkflow, uploadImageV2, insecureDownload } from '../ai/runninghub.js'
import { generateShotVideoCombat } from '../ai/combatVideo.js'
import { generateShotVideoV4, buildShotVideoPromptV4 } from '../ai/v4Video.js'
import { assertScriptConfirmed, assertNotStale, assertNoStylePoison } from '../ai/guards.js'
import { uploadsUrlToAbs } from '../ai/shared.js'
import { relayLastFrameToNextShot } from '../ai/postHooks.js'
import { generateShotGridApp } from '../ai/rhShotGrid.js'
// （死 import 已删：buildShotVideoPrompt / cameraPhrase 全项目零调用点。见 ai/videoPrompt.js 头部标识）
import { checkSeam, checkOpenerTone } from '../ai/seamCheck.js'
import { reviewShot, reviewShotByShotId } from '../ai/shotReview.js'
// 系统告警（2026-09-13）：出片后置钩子链失败可见化——落 system_alerts，前端亮角标、响应带 warnings
// 只导入本文件真正调用的：多导入会在"调用了却没导入"这类接线漏检中制造噪音（见 sceneReview.test.mjs 8b 节）
import { listAlerts, countUnresolved, resolveAlert, resolveAlertsByShot, resolveAlertsByScene } from '../ai/alerts.js'
import { buildGlobalSpeakerMap } from '../ai/h3PromptTranslator.js'
import { validateCameraAngle, inferAngleFromText, angleInjection } from '../ai/cameraAngle.js'
import { generateImage, generateStoryboardImage, resolveProvider } from '../ai/image.js'
import { backfillStoryboardAssets } from '../ai/assetBackfill.js'
import { classifyShotCombat } from '../ai/shotClassifier.js'
import { config } from '../config.js'
// cleanText 统一到 ai/shared.js（原此处与 ai/videoPrompt.js 各有一份实现）
import { clean as cleanText } from '../ai/shared.js'
import { replaceEpisodeCharacters, mergeMasterIntoEpisodeCharacters, syncProjectCharacterToEpisodes } from '../characterLibrary.js'
import { routeIp, buildCharacterContext, resolveExplicitCharacters } from '../ai/ipRouter.js'
// ffmpeg-static 已用于分镜图切分（directorRequest.js），这里复用同一份二进制
import ffmpegStaticPath from 'ffmpeg-static'
// LUFS 响度归一（2026-09-14）：逐镜 -20 消段间跳变 + BGM 后整片 -16 终遍，见 audioLoudnorm.js 头注
import { measureLoudness, loudnormFilter, normalizeFinalLoudness, PER_SHOT_TARGET, FINAL_TARGET } from '../audioLoudnorm.js'

const router = Router()

// server/uploads：本路由的文件落盘基准目录（BGM 列表、成片拼接口都基于它）
const uploadsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'uploads')
fs.mkdirSync(uploadsDir, { recursive: true })

// [清理 2026-09-19] 本文件原先抄有 buildAssetContextForPrompt / persistRemoteAsset / updateTask /
// dedupeAssets / isFurniture / filterFurnitureProps 六个函数的副本，外加 FRAME_DUAL_KEYFRAME_SEC
// 与 runningFullTasks 两个常量 —— 经逐一核对**全部零调用点**（本文件只做成片拼接/BGM/后处理，
// 不做剧本生成、不出图、不建任务），已整块删除。这些函数的唯一使用方分别是
// generate-script.js（剧本/资产）与 generate-image.js（persistRemoteAsset 落图）。


router.get('/bgm-list', (req, res) => {
  try {
    const bgmDir = path.join(uploadsDir, 'bgm')
    fs.mkdirSync(bgmDir, { recursive: true })
    const files = fs.readdirSync(bgmDir)
      .filter((f) => /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(f) && fs.statSync(path.join(bgmDir, f)).isFile())
    res.json({ files })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ===== 系统告警（2026-09-13）：出片后置钩子链失败可见化 =====
// 背景：末帧接力/接缝检测/色向闸/观片闸全是 fire-and-forget，原本失败只落 console.warn，
// 批量出片时无人可见——「成片在但验收链全灭」长期静默。现落 system_alerts 表并可查询。
// GET /alerts?episodeId=&includeResolved=1 → { alerts:[], unresolved:N }
router.get('/alerts', (req, res) => {
  try {
    const episodeId = req.query.episodeId != null && req.query.episodeId !== '' ? Number(req.query.episodeId) : null
    const includeResolved = req.query.includeResolved === '1' || req.query.includeResolved === 'true'
    const alerts = listAlerts({ episodeId, includeResolved })
    res.json({ alerts, unresolved: countUnresolved(episodeId) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /alerts/resolve { id } | { shotId } | { sceneId }（三选一）→ 处置单条 / 某镜全部 / 某场全部
// sceneId 于 2026-09-17 加入（A4/A5 场景图质检）：场景告警按场景清，与按镜头清并列而非复用——
// 两者是不同的域，混用会让"点了处置之后到底清了什么"变得靠猜。
router.post('/alerts/resolve', (req, res) => {
  try {
    const { id, shotId, sceneId, source } = req.body || {}
    if (id != null) {
      const okFlag = resolveAlert(Number(id), 'manual')
      return res.json({ success: okFlag, resolved: okFlag ? 1 : 0, unresolved: countUnresolved() })
    }
    if (shotId != null) {
      const n = resolveAlertsByShot(Number(shotId), 'manual', source ? String(source) : '')
      return res.json({ success: true, resolved: n, unresolved: countUnresolved() })
    }
    if (sceneId != null) {
      const n = resolveAlertsByScene(Number(sceneId), 'manual', source ? String(source) : '')
      return res.json({ success: true, resolved: n, unresolved: countUnresolved() })
    }
    res.status(400).json({ error: '需提供 id（处置单条）、shotId（处置某镜全部）或 sceneId（处置某场全部）' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ===== 保存至成片：把该集所有已生成镜头视频按场次/镜头顺序拼接为一个完整 mp4 =====
// 每个单镜都是同 workflow 输出（h264+aac，分辨率随项目级 aspect_ratio：9:16/16:9…），
// 归一化统一编码与音轨（不裁切，保留原始分辨率），再拼接——避免不同镜头音轨缺失导致失败。
// 转场按宪法第四条「叠化只用于时空转换、动作戏禁叠化」逐接缝判定，
// 详见函数内「转场策略」注释；fade 参数 true(智能)/false(全硬切)/'all'(全叠化)。
router.post('/video/compose', async (req, res) => {
  const { episodeId, fade = true, bgm = '', loudnorm = true } = req.body
  if (!episodeId) return res.status(400).json({ error: 'episodeId 必填' })

  // BGM 白名单校验（防路径穿越）：只接受 uploads/bgm/ 下真实存在的音频文件
  let bgmPath = ''
  if (String(bgm || '').trim()) {
    const bgmName = path.basename(String(bgm).trim())
    const cand = path.join(uploadsDir, 'bgm', bgmName)
    if (bgmName !== String(bgm).trim() || !/\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(bgmName) || !fs.existsSync(cand)) {
      return res.status(400).json({ error: `BGM「${bgm}」不可用。请把音频文件（mp3/wav/m4a 等）放进 server/uploads/bgm/ 目录后刷新重试` })
    }
    bgmPath = cand
  }

  // 排序口径与分镜页/编号重编一致（scene_number + start_time，同分用 id 稳定），
  // 不用 ss.id/s.id：场次删插重排后 id 序与逻辑序会漂移，拼出镜头乱序的成片
  // scene_number / is_combat 供转场策略判定（见下方「转场策略」注释）
  const allShots = query(
    `SELECT s.id, s.shot_number, s.duration, s.video_url, s.is_combat, ss.scene_number
     FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id
     WHERE ss.episode_id = ?
     ORDER BY ss.scene_number, s.start_time, s.id`,
    [episodeId]
  )
  const withVideo = allShots.filter((s) => s.video_url && String(s.video_url).trim())
  // 未出片镜头不再静默跳过：显式回传镜头号列表，前端弹告警——否则成片叙事断层
  // （实测 18 镜只出 5 镜时拼出 31 秒残片，剧情直接腰斩且无任何提示）
  const missingShots = allShots
    .filter((s) => !withVideo.some((v) => v.id === s.id))
    .map((s) => s.shot_number || String(s.id))
  if (!withVideo.length) {
    return res.status(400).json({ error: '还没有已生成的镜头视频，请先出片' })
  }

  const tmpDir = path.join(uploadsDir, `.compose_tmp_${episodeId}_${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  try {
    // 探测媒体真实时长与分辨率（只解码 1 帧，读 stderr header；duration 字段可能
    // 与成片实际不符——v4 出片有 +1s 补偿 clamp，offset 计算必须用真实值）
    const probeMedia = async (f) => {
      const { stderr } = await execFile(ffmpegStaticPath, ['-hide_banner', '-i', f, '-frames:v', '1', '-f', 'null', '-'])
      const s = String(stderr)
      const dm = s.match(/Duration: ([\d:.]+),/)
      const vm = s.match(/Video:.*?, (\d+)x(\d+)/)
      return {
        duration: dm ? dm[1].split(':').reduce((a, p) => a * 60 + Number(p), 0) : 0,
        w: vm ? Number(vm[1]) : 0,
        h: vm ? Number(vm[2]) : 0,
      }
    }

    // 1) 逐镜归一化：统一到批次最高分辨率（H3 存在 1MP/0.5MP 交替，分辨率不一致
    //    会让 xfade 报错、concat 版成片忽大忽小）+ 24fps / 44100Hz + 静音兜底音轨
    const probes = []
    for (const s of withVideo) {
      // 保留子目录解析（2026-09-16 审核修复 P0-2）：切片回填的 video_url 形如
      // /uploads/segments/segN/镜号_id.mp4，旧实现用 basename 压到 uploads 根 →
      // 指向不存在的路径，段级出片后拼片必定 400「视频文件缺失」。
      // 统一走 shared.uploadsUrlToAbs（与 shotReview/seamCheck 同口径）。
      const absSrc = uploadsUrlToAbs(s.video_url, uploadsDir)
      if (!absSrc) {
        const shown = String(s.video_url).split('/').pop().split('?')[0]
        return res.status(400).json({ error: `镜头 ${s.shot_number || s.id} 的视频文件缺失（${shown}），请重新生成该镜` })
      }
      probes.push({ s, absSrc, ...(await probeMedia(absSrc)) })
    }
    const target = probes.reduce((best, p) => (p.w * p.h > best.w * best.h ? p : best), { w: 0, h: 0 })
    if (!target.w) return res.status(400).json({ error: '无法读取镜头视频信息（分辨率探测失败）' })

    // LUFS 逐镜归一（响度跳变第一层）：每镜独立出音轨，实测 -13~-42dB 跨度 29dB——
    // 拼起来观众要一直调音量。每镜拉到 -20 LUFS（留 4dB headroom 给 BGM 混音），
    // 段间跳变即消。静音/近静音镜跳过（归一无意义且会炸 NaN）。
    // 艺术口子：要保留某镜「故意极响/极轻」的设计时，请求传 loudnorm:false 整链关。
    const perShotLoud = { applied: 0, skipped: 0 }
    const normList = []
    for (const p of probes) {
      const normPath = path.join(tmpDir, `${p.s.id}.mp4`)
      const normArgs = [
        '-y',
        '-i', p.absSrc,
        '-f', 'lavfi', '-t', '600', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
        '-map', '0:v:0', '-map', '0:a:0?',
        '-vf', `scale=${target.w}:${target.h}:flags=lanczos,setsar=1`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-r', '24', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
        '-shortest',
        '-movflags', '+faststart',
      ]
      if (loudnorm) {
        const lm = await measureLoudness(p.absSrc)
        if (lm) {
          normArgs.push('-af', loudnormFilter(lm, PER_SHOT_TARGET))
          perShotLoud.applied++
        } else {
          perShotLoud.skipped++
        }
      }
      await execFile(ffmpegStaticPath, [...normArgs, normPath])
      normList.push(normPath)
    }

    const outName = `compose_${episodeId}_${Date.now()}.mp4`
    const outPath = path.join(uploadsDir, outName)
    const FADE = 0.5

    // ── 转场策略（2026-09-14 重做）──
    // 宪法第四条明文：「严肃动作戏禁叠化，叠化只用于时空转换。0.5s 叠化全片 = PPT。」
    // 旧实现是 `fade !== false` 就给**所有**接缝上 0.5s 叠化——26 镜 → 25 个接缝全叠化，
    // 正好撞在宪法禁的那句话上：动作段被"化"出 PPT 感，该硬切的情绪点全在融化。
    // 现按镜头语义逐个接缝判定，判据全部可机读（不依赖人工逐镜标注）：
    //   · 同一场次内           = 同一时空连续 → 硬切（宪法：情绪点景别切换必须硬切）
    //   · 跨场次 + 任一侧武戏   = 动作戏禁叠化 → 硬切
    //   · 跨场次 + 两侧都文戏   = 时空转换     → 叠化 0.5s
    // fade 取值：true(默认)=智能判定 / false=全硬切 / 'all'=全叠化（保留旧行为，应急用）
    const dissolveAt = []
    for (let i = 1; i < probes.length; i++) {
      const prev = probes[i - 1].s
      const cur = probes[i].s
      let dis
      if (fade === false) dis = false
      else if (fade === 'all') dis = true
      else {
        const crossScene = Number(prev.scene_number) !== Number(cur.scene_number)
        const hasCombat = Number(prev.is_combat) === 1 || Number(cur.is_combat) === 1
        dis = crossScene && !hasCombat
      }
      dissolveAt.push(dis)
    }
    const dissolveCount = dissolveAt.filter(Boolean).length
    const cutCount = dissolveAt.length - dissolveCount
    const useChain = dissolveCount > 0
    let finalSeconds = 0

    if (useChain) {
      // 2a) 混合链式拼接：叠化接缝走 xfade/acrossfade，硬切接缝走 concat，两者可在同一
      //     filter_complex 内混用。硬切**不能**用「duration≈0 的 xfade」糊弄——那会真的
      //     渲染一段极短过渡，且 offset 误差逐接缝累积，尾部会漂出黑帧。
      const durations = []
      for (const p of normList) durations.push((await probeMedia(p)).duration)
      const vChain = []
      const aChain = []
      // 时基统一（2026-09-14 实测踩坑）：xfade 要求两路输入时基一致，而 concat 的**输出**
      // 时基会被抬到 1/1000000，与原始流的 1/12288 不匹配。于是只要出现「硬切 → 叠化」的
      // 接缝顺序（真实数据第 1 个接缝就是硬切），xfade 就报
      //   "First input link main timebase (1/1000000) do not match ... (1/12288)"
      // 并整体 500。修复：每条输入先 settb=AVTB + setpts 归零，concat/xfade 的输出便同处一个时基。
      // 回归测试：server/_test_transition_ffmpeg.mjs（含负对照，证明该测试确实能抓到本 bug）
      for (let i = 0; i < normList.length; i++) {
        vChain.push(`[${i}:v]settb=AVTB,setpts=PTS-STARTPTS[vi${i}]`)
        aChain.push(`[${i}:a]asettb=AVTB,asetpts=PTS-STARTPTS[ai${i}]`)
      }
      let vLast = '[vi0]'
      let aLast = '[ai0]'
      let acc = durations[0] || 0
      for (let i = 1; i < normList.length; i++) {
        const tag = `j${i}`
        if (dissolveAt[i - 1]) {
          const offset = Math.max(0, acc - FADE).toFixed(3)
          vChain.push(`${vLast}[vi${i}]xfade=transition=fade:duration=${FADE}:offset=${offset}[v${tag}]`)
          aChain.push(`${aLast}[ai${i}]acrossfade=d=${FADE}[a${tag}]`)
          acc = acc + durations[i] - FADE
        } else {
          vChain.push(`${vLast}[vi${i}]concat=n=2:v=1:a=0[v${tag}]`)
          aChain.push(`${aLast}[ai${i}]concat=n=2:v=0:a=1[a${tag}]`)
          acc = acc + durations[i]
        }
        vLast = `[v${tag}]`
        aLast = `[a${tag}]`
      }
      const args = ['-y']
      for (const p of normList) args.push('-i', p)
      args.push(
        '-filter_complex', [...vChain, ...aChain].join(';'),
        '-map', vLast, '-map', aLast,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '160k',
        '-movflags', '+faststart',
        outPath,
      )
      await execFile(ffmpegStaticPath, args)
      finalSeconds = acc
    } else {
      // 2b) 全硬切（单镜 / 场内全硬切 / 全武戏 / 显式关转场）：concat demuxer 直拼。
      //     归一化已统一编码与音轨，copy 即可不重编码（比 filter chain 快得多）
      const listPath = path.join(tmpDir, 'list.txt')
      fs.writeFileSync(listPath, normList.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'))
      await execFile(ffmpegStaticPath, [
        '-y',
        '-f', 'concat', '-safe', '0',
        '-i', listPath,
        '-c', 'copy',
        '-movflags', '+faststart',
        outPath,
      ])
      finalSeconds = (await probeMedia(outPath)).duration
    }

    // 3) BGM 铺底（可选）：循环 + 音量 0.22 + 尾部 2s 淡出；amix normalize=0 不压原声
    let bgmUsed = ''
    if (bgmPath) {
      const total = finalSeconds || 30
      const tmpMix = path.join(tmpDir, 'mix.mp4')
      await execFile(ffmpegStaticPath, [
        '-y',
        '-i', outPath,
        '-stream_loop', '-1', '-i', bgmPath,
        '-filter_complex',
        `[1:a]volume=0.22,afade=t=out:st=${Math.max(0, total - 2).toFixed(2)}:d=2[bg];` +
        `[0:a][bg]amix=inputs=2:duration=first:normalize=0[aout]`,
        '-map', '0:v', '-map', '[aout]',
        '-t', String(total),
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k',
        '-movflags', '+faststart',
        tmpMix,
      ])
      fs.copyFileSync(tmpMix, outPath)
      bgmUsed = path.basename(bgmPath)
    }

    // 4) LUFS 整片终遍（响度跳变第二层）：必须在 BGM 之后——amix 会改变整体响度，
    //    放前面就白做。逐镜已各归 -20，终遍把整体（原声+BGM）线性定到 -16 LUFS
    //    （流媒体交付标准）。视频流 copy 零损失，只重编码音频；静音片自动跳过。
    let loudFinal = { applied: false, reason: 'off' }
    if (loudnorm) {
      loudFinal = await normalizeFinalLoudness(outPath, tmpDir)
    }

    res.json({
      success: true,
      url: `/uploads/${outName}`,
      shotCount: normList.length,
      totalSeconds: Math.round(finalSeconds * 10) / 10,
      // fade 保留旧字段（前端可能读）：语义变为「是否存在叠化接缝」
      fade: dissolveCount > 0,
      // 转场决策明细：让"为什么这段是硬切/叠化"可解释，不用回头翻代码
      transitions: {
        policy: fade === false ? 'hard-cut' : fade === 'all' ? 'all-dissolve' : 'smart',
        dissolveCount,
        cutCount,
        dissolveSeconds: FADE,
      },
      bgmUsed,
      // 响度归一报告（2026-09-14）：perShot=逐镜归一到 -20 的覆盖情况；final=整片终遍
      loudnorm: loudnorm ? {
        perShotTarget: PER_SHOT_TARGET,
        finalTarget: FINAL_TARGET,
        perShot: perShotLoud,
        final: loudFinal,
      } : null,
      resolution: `${target.w}x${target.h}`,
      // 未出片镜头号（按播放序）：前端据此弹告警"成片缺 N 镜，剧情可能断层"
      missingShots,
      totalShots: allShots.length,
    })
  } catch (err) {
    console.error('[/generate/video/compose] error:', err.message)
    res.status(500).json({ error: `成片合成失败：${err.message}` })
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 临时目录清理失败可忽略 */ }
  }
})

router.post('/continuity-frame', async (req, res) => {
  const { shotId } = req.body
  if (!shotId) return res.status(400).json({ error: 'shotId 必填' })
  const shot = queryOne('SELECT * FROM shots WHERE id = ?', [Number(shotId)])
  if (!shot) return res.status(404).json({ error: `镜头不存在 (shotId=${shotId})` })
  try {
    const r = await relayLastFrameToNextShot(shot)
    console.log(`[/generate/continuity-frame] shot ${shotId} 末帧 → shot ${r.nextShotId} (${r.nextShotNumber}) 作 continuity 锚`)
    res.json({ success: true, ...r })
  } catch (e) {
    const msg = String(e.message || e)
    const status = /没有成片|最后一镜|无法识别|不存在/.test(msg) ? 400 : 500
    console.warn(`[/generate/continuity-frame] shot ${shotId} 接力失败:`, msg)
    res.status(status).json({ error: msg })
  }
})

// 兜底手动接口：重新检测某镜衔接质量（#3；自动钩子失败或阈值调整后想重检时用，正常流程不需要）
// 路由口径与出片钩子一致：有 continuity 锚 → 接缝检测；无锚（开场镜）→ 色向闸（锁3）。
router.post('/seam-check', async (req, res) => {
  const { shotId } = req.body
  if (!shotId) return res.status(400).json({ error: 'shotId 必填' })
  try {
    const shot = queryOne('SELECT * FROM shots WHERE id = ?', [Number(shotId)])
    if (!shot) return res.status(404).json({ error: `镜头不存在 (shotId=${shotId})` })
    const hasAnchor = !!String(shot.continuity_url || '').trim()
    const r = hasAnchor ? await checkSeam(shot) : await checkOpenerTone(shot)
    console.log(`[/generate/seam-check] shot ${shotId} ${hasAnchor ? `衔接检测: CCT差${r.cctDiffK ?? 'n/a'}K / 亮度差${r.lumaDiff} / 构图差${r.hashDist}/64` : `开场色向闸: R-B=${r.rb} 带宽[${r.band.rbMin},${r.band.rbMax}]`} ${r.alert ? '⚠️ 超阈值' : 'OK'}`)
    res.json({ success: true, ...r })
  } catch (e) {
    const msg = String(e.message || e)
    const status = /没有成片|没有 continuity|不存在|无法识别/.test(msg) ? 400 : 500
    console.warn(`[/generate/seam-check] shot ${shotId} 检测失败:`, msg)
    res.status(status).json({ error: msg })
  }
})

// 兜底手动接口：VLM 观片评审某镜（自动钩子失败/额度恢复后补评存量镜头）
router.post('/shot-review', async (req, res) => {
  const { shotId } = req.body
  if (!shotId) return res.status(400).json({ error: 'shotId 必填' })
  try {
    const r = await reviewShotByShotId(Number(shotId))
    console.log(`[/generate/shot-review] shot ${shotId} 观片评审: 均分${r.avgScore} ${r.verdict === 'fail' ? '⚠️ fail' : r.verdict === 'warn' ? '⚠️ warn' : 'OK'} — ${r.summary}`)
    res.json({ success: true, ...r })
  } catch (e) {
    const msg = String(e.message || e)
    console.warn(`[/generate/shot-review] shot ${shotId} 评审失败:`, msg)
    res.status(/不存在|没有成片|未配置/.test(msg) ? 400 : 500).json({ error: msg })
  }
})

router.post('/blocking', async (req, res) => {
  const { shotId, sceneId } = req.body
  if (!shotId && !sceneId) return res.status(400).json({ error: 'shotId 或 sceneId 必填' })

  const scene = sceneId
    ? queryOne('SELECT * FROM storyboard_scenes WHERE id = ?', [Number(sceneId)])
    : queryOne(
        'SELECT ss.* FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id WHERE s.id = ?',
        [Number(shotId)]
      )
  if (!scene) return res.status(404).json({ error: '场次不存在' })
  try {
    assertScriptConfirmed(scene.episode_id)
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message })
  }

  const shotRows = query('SELECT * FROM shots WHERE storyboard_scene_id = ? ORDER BY start_time, id', [scene.id])
  if (!shotRows.length) return res.status(400).json({ error: '该场次没有镜头' })

  // 场景设定：按场次标题匹配资产库场景（布局描述与关联道具以此为权威）
  const sceneAsset = queryOne(
    'SELECT title, summary, prop_names FROM scenes WHERE episode_id = ? AND title = ?',
    [scene.episode_id, scene.title]
  )
  let scenePropNames = []
  try { scenePropNames = JSON.parse(sceneAsset?.prop_names || '[]') } catch { scenePropNames = [] }

  const characters = mergeMasterIntoEpisodeCharacters(
    query('SELECT name, description, project_character_id FROM characters WHERE episode_id = ?', [scene.episode_id])
  )

  const dialogueTextOf = (d) => {
    try {
      const obj = typeof d === 'string' ? JSON.parse(d) : d
      if (!obj) return ''
      // 数据契约：dialogue 是 JSON 数组 [{character,tone,text,startTime}]；
      // 兼容历史单对象形态。此前按单对象读，数组一律取出空串，站位 AI 拿不到台词
      const list = Array.isArray(obj) ? obj : [obj]
      return list
        .map((x) => [x?.character, x?.text].filter(Boolean).join('：'))
        .filter(Boolean)
        .join('；')
    } catch {
      return typeof d === 'string' ? d : ''
    }
  }

  const shotsForAI = shotRows.map((s) => ({
    shotNumber: s.shot_number,
    description: s.description || '',
    actionNote: s.action_note || '',
    dialogueText: dialogueTextOf(s.dialogue),
    characters: JSON.parse(s.characters || '[]'),
    propAssets: JSON.parse(s.prop_assets || '[]'),
    finalFrame: s.final_frame || '',
  }))

  try {
    const result = await extractBlockingForScene(
      { title: scene.title, description: sceneAsset?.summary || '', propNames: scenePropNames },
      shotsForAI,
      { characters }
    )
    const sceneLayout = result.sceneLayout || { description: '', walls: [], furniture: [] }
    const updated = []
    shotRows.forEach((s, i) => {
      const shotPlan = (result.shots || [])[i]
      if (!shotPlan) return
      const plan = assembleBlockingPlan(shotPlan, sceneLayout)
      execute('UPDATE shots SET blocking_plan = ? WHERE id = ?', [JSON.stringify(plan), s.id])
      updated.push({ shotId: s.id, shotNumber: s.shot_number, plan })
    })
    if (!updated.length) throw new Error('AI 未返回任何镜头的站位调度')
    console.log(`[/generate/blocking] 场次「${scene.title}」整场重排完成：${updated.length}/${shotRows.length} 镜`)
    res.json({ success: true, sceneId: scene.id, sceneTitle: scene.title, updated })
  } catch (err) {
    console.error('[/generate/blocking] error:', err)
    res.status(500).json({ error: err.message })
  }
})

export default router
