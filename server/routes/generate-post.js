import { Router } from 'express'
import path from 'node:path'
import fs from 'node:fs'
import { query, queryOne, execute } from '../db.js'

import { extractBlockingForScene, assembleBlockingPlan } from '../ai/doubao.js'
import { assertScriptConfirmed } from '../ai/guards.js'
import { uploadsUrlToAbs } from '../ai/shared.js'
import { relayLastFrameToNextShot } from '../ai/postHooks.js'
import { checkSeam, checkOpenerTone } from '../ai/seamCheck.js'
import { reviewShotByShotId } from '../ai/shotReview.js'
import { listAlerts, countUnresolved, resolveAlert, resolveAlertsByShot, resolveAlertsByScene } from '../ai/alerts.js'
import { mergeMasterIntoEpisodeCharacters } from '../characterLibrary.js'
import { measureLoudness, loudnormFilter, normalizeFinalLoudness, PER_SHOT_TARGET, FINAL_TARGET } from '../audioLoudnorm.js'
import { uploadsDir } from '../paths.js'

const router = Router()

fs.mkdirSync(uploadsDir, { recursive: true })



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

router.post('/video/compose', async (req, res) => {
  const { episodeId, fade = true, bgm = '', loudnorm = true } = req.body
  if (!episodeId) return res.status(400).json({ error: 'episodeId 必填' })

  let bgmPath = ''
  if (String(bgm || '').trim()) {
    const bgmName = path.basename(String(bgm).trim())
    const cand = path.join(uploadsDir, 'bgm', bgmName)
    if (bgmName !== String(bgm).trim() || !/\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(bgmName) || !fs.existsSync(cand)) {
      return res.status(400).json({ error: `BGM「${bgm}」不可用。请把音频文件（mp3/wav/m4a 等）放进 server/uploads/bgm/ 目录后刷新重试` })
    }
    bgmPath = cand
  }

  const allShots = query(
    `SELECT s.id, s.shot_number, s.duration, s.video_url, s.is_combat, ss.scene_number
     FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id
     WHERE ss.episode_id = ?
     ORDER BY ss.scene_number, s.start_time, s.id`,
    [episodeId]
  )
  const withVideo = allShots.filter((s) => s.video_url && String(s.video_url).trim())
  const missingShots = allShots
    .filter((s) => !withVideo.some((v) => v.id === s.id))
    .map((s) => s.shot_number || String(s.id))
  if (!withVideo.length) {
    return res.status(400).json({ error: '还没有已生成的镜头视频，请先出片' })
  }

  const tmpDir = path.join(uploadsDir, `.compose_tmp_${episodeId}_${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  try {
    const probeMedia = async (f) => {
      const { stderr } = await runFfmpeg(['-hide_banner', '-i', f, '-frames:v', '1', '-f', 'null', '-'])
      const s = String(stderr)
      const dm = s.match(/Duration: ([\d:.]+),/)
      const vm = s.match(/Video:.*?, (\d+)x(\d+)/)
      return {
        duration: dm ? dm[1].split(':').reduce((a, p) => a * 60 + Number(p), 0) : 0,
        w: vm ? Number(vm[1]) : 0,
        h: vm ? Number(vm[2]) : 0,
      }
    }

    const probes = []
    for (const s of withVideo) {
      const absSrc = uploadsUrlToAbs(s.video_url, uploadsDir)
      if (!absSrc) {
        const shown = String(s.video_url).split('/').pop().split('?')[0]
        return res.status(400).json({ error: `镜头 ${s.shot_number || s.id} 的视频文件缺失（${shown}），请重新生成该镜` })
      }
      probes.push({ s, absSrc, ...(await probeMedia(absSrc)) })
    }
    const target = probes.reduce((best, p) => (p.w * p.h > best.w * best.h ? p : best), { w: 0, h: 0 })
    if (!target.w) return res.status(400).json({ error: '无法读取镜头视频信息（分辨率探测失败）' })

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
      await runFfmpeg([...normArgs, normPath])
      normList.push(normPath)
    }

    const outName = `compose_${episodeId}_${Date.now()}.mp4`
    const outPath = path.join(uploadsDir, outName)
    const FADE = 0.5

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
      const durations = []
      for (const p of normList) durations.push((await probeMedia(p)).duration)
      const vChain = []
      const aChain = []
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
      await runFfmpeg(args)
      finalSeconds = acc
    } else {
      const listPath = path.join(tmpDir, 'list.txt')
      fs.writeFileSync(listPath, normList.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'))
      await runFfmpeg([
        '-y',
        '-f', 'concat', '-safe', '0',
        '-i', listPath,
        '-c', 'copy',
        '-movflags', '+faststart',
        outPath,
      ])
      finalSeconds = (await probeMedia(outPath)).duration
    }

    let bgmUsed = ''
    if (bgmPath) {
      const total = finalSeconds || 30
      const tmpMix = path.join(tmpDir, 'mix.mp4')
      await runFfmpeg([
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

    let loudFinal = { applied: false, reason: 'off' }
    if (loudnorm) {
      loudFinal = await normalizeFinalLoudness(outPath, tmpDir)
    }

    res.json({
      success: true,
      url: `/uploads/${outName}`,
      shotCount: normList.length,
      totalSeconds: Math.round(finalSeconds * 10) / 10,
      fade: dissolveCount > 0,
      transitions: {
        policy: fade === false ? 'hard-cut' : fade === 'all' ? 'all-dissolve' : 'smart',
        dissolveCount,
        cutCount,
        dissolveSeconds: FADE,
      },
      bgmUsed,
      loudnorm: loudnorm ? {
        perShotTarget: PER_SHOT_TARGET,
        finalTarget: FINAL_TARGET,
        perShot: perShotLoud,
        final: loudFinal,
      } : null,
      resolution: `${target.w}x${target.h}`,
      missingShots,
      totalShots: allShots.length,
    })
  } catch (err) {
    console.error('[/generate/video/compose] error:', err.message)
    res.status(500).json({ error: `成片合成失败：${err.message}` })
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {  }
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
