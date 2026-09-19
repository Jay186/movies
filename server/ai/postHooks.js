import path from 'node:path'
import fs from 'node:fs'
import { queryOne, execute } from '../db.js'
import { insecureDownload } from './runninghub.js'
import { checkSeamByShotId } from './seamCheck.js'
import { uploadsUrlToAbs } from './shared.js'
import { uploadsDir } from '../paths.js'


export async function relayLastFrameToNextShot(shot) {
  const videoUrl = String(shot.video_url || '').trim()
  if (!videoUrl) throw new Error('该镜还没有成片')

  let absVideo
  if (videoUrl.startsWith('/uploads/')) {
    absVideo = uploadsUrlToAbs(videoUrl, uploadsDir)
    if (!absVideo) throw new Error('成片本地文件已不存在（可能被清理）')
  } else if (/^https?:/i.test(videoUrl)) {
    const buf = await insecureDownload(videoUrl)
    absVideo = path.join(uploadsDir, `shot_${shot.id}_relay.mp4`)
    fs.writeFileSync(absVideo, buf)
  } else {
    throw new Error(`无法识别的成片地址: ${videoUrl}`)
  }

  const nextShot = queryOne(
    `SELECT s.id, s.shot_number, ss.scene_number AS next_scene FROM shots s
     JOIN storyboard_scenes ss ON ss.id = s.storyboard_scene_id
     WHERE ss.episode_id = (SELECT episode_id FROM storyboard_scenes WHERE id = ?)
       AND (s.start_time > ? OR (s.start_time = ? AND s.id > ?))
     ORDER BY s.start_time, s.id LIMIT 1`,
    [shot.storyboard_scene_id, shot.start_time, shot.start_time, shot.id]
  )
  if (!nextShot) throw new Error('本集最后一镜，没有下一镜可以接力')

  const myScene = queryOne(
    'SELECT scene_number FROM storyboard_scenes WHERE id = ?',
    [shot.storyboard_scene_id]
  )
  const crossScene = myScene
    ? Number(myScene.scene_number) !== Number(nextShot.next_scene)
    : false

  const contDir = path.join(uploadsDir, 'continuity')
  fs.mkdirSync(contDir, { recursive: true })
  const outName = `shot_${shot.id}_last.jpg`
  const outPath = path.join(contDir, outName)
  await runFfmpeg(['-y', '-sseof', '-0.1', '-i', absVideo, '-update', '1', '-frames:v', '1', outPath])
  if (!fs.existsSync(outPath)) throw new Error('末帧抽取失败：输出为空')

  if (crossScene) {
    execute('UPDATE shots SET continuity_url = NULL, seam_check = NULL WHERE id = ?', [nextShot.id])
    console.log(`[relayLastFrame] 跨场跳切：shot ${shot.id}（场 ${myScene.scene_number}）→ shot ${nextShot.id}（场 ${nextShot.next_scene}）不写接力锚，清残留锚；末帧仅落盘（风格锚/排查用）`)
    return { skipped: 'cross-scene', continuityUrl: null, nextShotId: nextShot.id, nextShotNumber: nextShot.shot_number }
  }

  const continuityUrl = `/uploads/continuity/${outName}`
  execute('UPDATE shots SET continuity_url = ?, seam_check = NULL WHERE id = ?', [continuityUrl, nextShot.id])
  checkSeamByShotId(nextShot.id).catch((e) => {
    const msg = String(e.message || e)
    const benign = /还没有成片|没有 continuity 锚/.test(msg)
    console.log(`[relayLastFrame] shot ${nextShot.id} 接缝补检${benign ? '跳过（尚无成片/无锚，属正常）' : '失败'}: ${msg.slice(0, 100)}`)
  })
  return { continuityUrl, nextShotId: nextShot.id, nextShotNumber: nextShot.shot_number }
}

export async function anchorEpisodeStyle(shot) {
  const first = queryOne(
    `SELECT s.id FROM shots s
     JOIN storyboard_scenes ss ON ss.id = s.storyboard_scene_id
     WHERE ss.episode_id = ? ORDER BY s.start_time, s.id LIMIT 1`,
    [shot.episode_id]
  )
  if (first?.id !== shot.id) return null 
  const lastFrame = path.join(uploadsDir, 'continuity', `shot_${shot.id}_last.jpg`)
  if (!fs.existsSync(lastFrame)) return null 
  const dir = path.join(uploadsDir, 'style_anchor')
  fs.mkdirSync(dir, { recursive: true })
  const outName = `ep${shot.episode_id}_style.jpg`
  fs.copyFileSync(lastFrame, path.join(dir, outName))
  const url = `/uploads/style_anchor/${outName}`
  execute('UPDATE episodes SET style_anchor_url = ? WHERE id = ?', [url, shot.episode_id])
  return url
}
