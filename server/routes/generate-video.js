import { Router } from 'express'
import path from 'node:path'
import fs from 'node:fs'
import { query, queryOne, execute } from '../db.js'

import { chatCompletion } from '../ai/doubao.js'
import { insecureDownload, queryTaskOutput, isPlausibleMp4 } from '../ai/runninghub.js'
import { generateShotVideoCombat } from '../ai/combatVideo.js'
import { generateShotVideoV4, buildShotVideoPromptV4 } from '../ai/v4Video.js'
import { assertScriptConfirmed, assertNotStale, assertNoStylePoison } from '../ai/guards.js'
import { relayLastFrameToNextShot, anchorEpisodeStyle } from '../ai/postHooks.js'
import { resolveMc } from '../ai/mcPolicy.js'
import { checkSeam, checkOpenerTone } from '../ai/seamCheck.js'
import { reviewShot } from '../ai/shotReview.js'
import { recordAlert, resolveAlertsByShot } from '../ai/alerts.js'
import { enqueueSalvage } from '../salvageWorker.js'
import { buildGlobalSpeakerMap } from '../ai/h3PromptTranslator.js'
import { classifyShotCombat } from '../ai/shotClassifier.js'
import { config } from '../config.js'
import { clean as cleanText, pickInjectableEnglish } from '../ai/shared.js'
import { parseDialogue, hasDialogue } from '../ai/dialogue.js'
import { mergeMasterIntoEpisodeCharacters } from '../characterLibrary.js'
import { ASSET_TYPES, TYPE_PROP } from '../ai/assetTypes.js'
import { resolveState } from '../ai/assetState.js'
import { resolvePropName } from '../ai/propNameMatch.js'
import { pickEnglish as pickEnglishGuard, stripResidualCjk as stripCjkGuard } from '../ai/v4Video.js'
import { uploadsDir } from '../paths.js'
const router = Router()


function propStateDescEn(shot, propName, baseDescEn) {
  const base = String(baseDescEn || '').trim()
  if (!config.assetState?.enabled) return base
  let map = null
  try {
    map = shot && shot.asset_states_json ? JSON.parse(shot.asset_states_json) : null
  } catch { map = null }
  const entry = (map && typeof map === 'object' && map.prop) ? map.prop[propName] : null
  if (!entry) return base
  try {
    const rows = query(
      `SELECT state_key, label_zh, description, description_en, image_url, is_default
       FROM asset_states WHERE asset_type = ? AND asset_key = ?`,
      [TYPE_PROP, propName]
    )
    if (!rows.length) return base
    const st = resolveState(entry, rows)
    if (!st.resolved) return base
    const stateEn = pickEnglishGuard(st.descriptionEn) || stripCjkGuard(st.descriptionEn)
    if (!stateEn) return base
    return base ? `${base}; ${stateEn}` : stateEn
  } catch (e) {
    console.warn(`[generate-video] 道具状态解析失败（降级为无状态）: ${e.message}`)
    return base
  }
}

export const __propStateDescEn = propStateDescEn


fs.mkdirSync(uploadsDir, { recursive: true })

function episodeSpeakerIds(shot) {
  const sceneRowId = shot?.storyboard_scene_id
  if (!sceneRowId) return new Map()
  const ep = queryOne('SELECT episode_id FROM storyboard_scenes WHERE id = ?', [sceneRowId])
  if (!ep?.episode_id) return new Map()
  const rows = query(
    `SELECT s.dialogue FROM shots s
     JOIN storyboard_scenes ss ON ss.id = s.storyboard_scene_id
     WHERE ss.episode_id = ? ORDER BY s.start_time, s.id`,
    [ep.episode_id]
  )
  return buildGlobalSpeakerMap(rows)
}
function resolveIsCombat(shot) {
  if (shot?.is_combat === 1 || shot?.is_combat === 0) return shot.is_combat === 1
  return classifyShotCombat(shot)
}
const V4_VIDEO_JOB_STALE_MS = 30 * 60 * 1000
const v4VideoJobsInflight = new Map()

router.get('/video-v4/inflight', (req, res) => {
  const now = Date.now()
  const list = []
  for (const [k, j] of v4VideoJobsInflight) {
    if (now - j.startedAt > V4_VIDEO_JOB_STALE_MS) { v4VideoJobsInflight.delete(k); continue }
    list.push({ shotId: j.shotId, phase: j.phase, taskId: j.taskId || '', startedAt: j.startedAt })
  }
  res.json(list)
})

router.post('/video-v4', async (req, res) => {
  const { shotId, aspectRatio, megapixels, duration, allowSilent, allowNoFrame, secondPass, seed, useMotionContext, ignoreSeamAlert, ignoreAnchorPoison, forceRetry } = req.body
  if (!shotId) return res.status(400).json({ error: 'shotId 必填' })

  const shot = queryOne(
    `SELECT s.*, ss.episode_id, ss.scene_number FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id WHERE s.id = ?`,
    [shotId]
  )
  if (!shot) return res.status(404).json({ error: '镜头不存在' })

  const prevShot = queryOne(
    `SELECT s.id, s.shot_number, s.seam_check, s.shot_review, ss.scene_number AS prev_scene FROM shots s
     JOIN storyboard_scenes ss ON ss.id = s.storyboard_scene_id
     WHERE ss.episode_id = ? AND (s.start_time < ? OR (s.start_time = ? AND s.id < ?))
     ORDER BY s.start_time DESC, s.id DESC LIMIT 1`,
    [shot.episode_id, shot.start_time, shot.start_time, shot.id]
  )
  if (prevShot?.seam_check) {
    let prevSeam = null
    try { prevSeam = JSON.parse(prevShot.seam_check) } catch {  }
    if (prevSeam?.alert === true && !prevSeam.acknowledgedAt) {
      if (!ignoreSeamAlert) {
        return res.status(409).json({
          error: `上一镜 ${prevShot.shot_number} 有未处置的${prevSeam.checkType === 'openerTone' ? '开场色调跑偏' : '衔接异常'}告警，出片链已锁死：请先重生上一镜消除告警，或人工确认接受现状后带 ignoreSeamAlert 重试（不会自动重 roll）。`,
          prevShotId: prevShot.id,
          prevShotNumber: prevShot.shot_number,
          seamAlert: prevSeam,
        })
      }
      try {
        prevSeam.acknowledgedAt = new Date().toISOString()
        execute('UPDATE shots SET seam_check = ? WHERE id = ?', [JSON.stringify(prevSeam), prevShot.id])
        console.log(`[/generate/video-v4] shot ${shotId}：人工放行上一镜 ${prevShot.shot_number} 的${prevSeam.checkType === 'openerTone' ? '色向' : '衔接'}告警（ignoreSeamAlert）`)
      } catch {  }
    }
  }

  if (prevShot?.shot_review && Number(prevShot.prev_scene) === Number(shot.scene_number)) {
    let prevReview = null
    try { prevReview = JSON.parse(prevShot.shot_review) } catch {  }
    const poisonText = prevReview ? [...(prevReview.issues || []), prevReview.summary || ''].join('\n') : ''
    if (prevReview?.verdict === 'fail' && /(穿帮|变成|被替换|换成了|漂移|不一致|消失|闯入|选角|错演)/.test(poisonText) && !prevReview.acknowledgedAt) {
      if (!ignoreAnchorPoison) {
        return res.status(409).json({
          error: `上一镜 ${prevShot.shot_number} 观片不合格且问题涉及角色一致性/末帧穿帮（${(prevReview.issues || [])[0] || '详见观片记录'}），接力锚可能已污染，出片链已锁死：请先重生上一镜（新观片合格自动放行），或人工确认接受现状后带 ignoreAnchorPoison 重试（不会自动重 roll）。`,
          prevShotId: prevShot.id,
          prevShotNumber: prevShot.shot_number,
          anchorPoison: true,
          review: prevReview,
        })
      }
      try {
        prevReview.acknowledgedAt = new Date().toISOString()
        prevReview.acknowledgedBy = 'ignoreAnchorPoison'
        execute('UPDATE shots SET shot_review = ? WHERE id = ?', [JSON.stringify(prevReview), prevShot.id])
        console.log(`[/generate/video-v4] shot ${shotId}：人工放行上一镜 ${prevShot.shot_number} 的观片污染告警（ignoreAnchorPoison）`)
      } catch {  }
    }
  }

  const hasDlg = hasDialogue(shot.dialogue)
  if (!hasDlg && !allowSilent) {
    return res.status(400).json({ error: '本镜没有台词（dialogue 为空，通常是 AI 分镜生成时漏了台词）：H3 只念 <d> 标签内的台词，无台词=成片没有角色语音。请补全该镜台词或重新生成分镜；若确认为纯动作无声镜头，请传 allowSilent 再出片。' })
  }
  const hasFrameAnchor = String(shot.frame_url || '').trim() || String(shot.continuity_url || '').trim()
  if (!hasFrameAnchor && !allowNoFrame) {
    return res.status(400).json({ error: '本镜没有分镜图（frame_url 为空）也没有接力锚（continuity_url 为空）：出片没有任何构图锚，机位/构图靠模型自由发挥，成片与分镜大概率对不上。请先生成分镜图再出片；若确认要纯文字出片，请传 allowNoFrame。' })
  }
  try {
    assertNoStylePoison(shot, req.body.allowStyleShift)
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message })
  }
  const priorRetries = Number(shot.retry_count) || 0
  if (priorRetries >= 2 && String(shot.retry_feedback || '').trim() && !forceRetry) {
    return res.status(409).json({
      error: `镜 ${shot.shot_number} 已按验收反馈自动回灌重出 ${priorRetries} 次仍未过审，且当前又有新的失败反馈：同样的修正两轮没生效，继续同路径重出大概率重复失败。请先人工看片定位根因（画风/音色/构图基线问题不是回灌能修的）；确认仍要重试，请传 forceRetry: true。`,
    })
  }
  try {
    assertScriptConfirmed(shot.episode_id)
    assertNotStale(shot.episode_id, 'storyboard')
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message })
  }

  const inSegment = shotBusyInSegmentChannel(shotId)
  if (inSegment) {
    return res.status(409).json({
      error: `该镜头属于正在出片的段（${inSegment.key}），段的成片会切片回填本镜——现在单独出片会与段级出片互相覆盖，且两笔生成费用都花掉。请等该段完成后再操作。`,
      conflict: 'segment', segmentKey: inSegment.key,
    })
  }

  const jobKey = `video-v4:${shotId}`
  if (v4VideoJobsInflight.has(jobKey)) {
    return res.status(409).json({ error: '该镜头正在出片中，请等待完成后再试' })
  }
  v4VideoJobsInflight.set(jobKey, { shotId, startedAt: Date.now(), phase: 'submitting' })

  try {
    const project = queryOne('SELECT art_style FROM projects WHERE id = (SELECT project_id FROM episodes WHERE id = ?)', [shot.episode_id])
    const styleLabel = project?.art_style || ''
    let stylePrompt = styleLabel
    let stylePromptEn = ''
    try {
      if (styleLabel) {
        const sp = queryOne('SELECT prompt, prompt_en, label_en FROM style_presets WHERE label = ? LIMIT 1', [styleLabel])
        if (sp?.prompt) stylePrompt = sp.prompt
        stylePromptEn = String(sp?.prompt_en || '').trim() || String(sp?.label_en || '').trim()
      }
    } catch {  }
    const isCombat = resolveIsCombat(shot)
    const combatTriggers = /倒进|倒地|瘫倒|击倒|轰然倒/.test(String(shot.description || '') + String(shot.action_note || ''))
      ? 'prfight1, prfin1'
      : 'prfight1'
    const COMBAT_STYLE_EN = 'SAME hand-drawn watercolor animation art style as the reference images and the rest of the episode — never switch to any other art register or render style; grounded fight and action choreography with real weight and inertia, every impact lands with full body weight — recoil, shockwaves, debris flying on contact, fast decisive motion with follow-through, intensity and physical danger conveyed through scale, motion and physical detail, no magic aura, no energy effects, ' + combatTriggers
    const combatNote = isCombat ? COMBAT_STYLE_EN : ''
    const finalStyleEn = stylePromptEn
    const finalStyle = stylePrompt

    const parseNames = (v) => { if (!v) return []; try { const r = JSON.parse(v); return Array.isArray(r) ? r : [] } catch { return [] } }
    const charRowsAll = mergeMasterIntoEpisodeCharacters(
      query('SELECT id, name, name_en, description, description_en, image_url, audio_url FROM characters WHERE episode_id = ?', [shot.episode_id])
    )
    const sceneRows = query('SELECT id, title, title_en, summary, summary_en, image_url, lighting_en FROM scenes WHERE episode_id = ?', [shot.episode_id])
    const propRows = query('SELECT id, name, name_en, description, description_en, image_url FROM props WHERE episode_id = ?', [shot.episode_id])
    const propTableNames = propRows.map((r) => r.name)
    const sceneTitles = sceneRows.map((r) => r.title)

    const refs = []
    const pushRef = (label, desc, kind, image, labelEn, descEn, lightingEn) => {
      if (!image) return
      if (refs.some((r) => r.image === image)) return
      refs.push({
        label: String(label || ''), desc: String(desc || ''), kind, image,
        labelEn: String(labelEn || ''), descEn: String(descEn || ''),
        lightingEn: String(lightingEn || ''),
      })
    }
    for (const n of parseNames(shot.characters)) { const c = charRowsAll.find((x) => x.name === n); if (c) pushRef(c.name, c.description, 'character', c.image_url, c.name_en, c.description_en) }
    for (const sn of parseNames(shot.scene_assets)) {
      const s = sceneRows.find((x) => x.title === sn)
      if (s && !String(s.image_url || '').trim()) {
        recordAlert({
          episodeId: shot.episode_id, shotId, shotNumber: shot.shot_number, source: 'sceneImage', level: 'warn',
          message: `镜 ${shot.shot_number} 的场景「${s.title}」（场景 id ${s.id}）命中场景表但尚无参考图（image_url 为空）：本镜出片拿不到该场景参考图，构图与光影只能靠模型自由发挥；请到设定页给该场景生成或上传参考图`,
          detail: JSON.stringify({ sceneId: s.id, sceneTitle: s.title, imageUrl: String(s.image_url || '') }).slice(0, 2000),
        })
        continue
      }
      if (s) pushRef(s.title, s.summary, 'scene', s.image_url, s.title_en, s.summary_en, s.lighting_en)
      else {
        recordAlert({
          episodeId: shot.episode_id, shotId, shotNumber: shot.shot_number, source: 'sceneName', level: 'warn',
          message: `镜 ${shot.shot_number} 的场景「${sn}」在场景表中无对应项（多趟 LLM 命名不一致），本镜无该场景参考图；请在设定页核对场景名`,
          detail: JSON.stringify({ raw: sn, candidates: sceneTitles }).slice(0, 2000),
        })
      }
    }
    for (const pn of parseNames(shot.prop_assets)) {
      const matched = resolvePropName(pn, propTableNames)
      if (!matched) {
        recordAlert({
          episodeId: shot.episode_id, shotId, shotNumber: shot.shot_number, source: 'propName', level: 'warn',
          message: `镜 ${shot.shot_number} 的道具「${pn}」在道具表中无对应项（多趟 LLM 命名不一致），本镜无该道具参考图；请在设定页核对道具名`,
          detail: JSON.stringify({ raw: pn, candidates: propTableNames }).slice(0, 2000),
        })
        continue
      }
      const p = propRows.find((x) => x.name === matched)
      if (p) pushRef(p.name, p.description, 'prop', p.image_url, p.name_en, propStateDescEn(shot, p.name, p.description_en))
    }
    const frameEndUrl = String(shot.frame_url2 || '').trim()
    if (frameEndUrl) {
      pushRef('endframe', 'the target final frame of this shot', 'endframe', frameEndUrl, '', '')
    }
    const frameRefUrl = String(shot.frame_url || '').trim()
    const continuityUrl = String(shot.continuity_url || '').trim()
    if (continuityUrl) {
      pushRef('continuity', 'final frame of the previous shot, continuity anchor for character and environment state', 'continuity', continuityUrl, '', '')
    } else if (frameRefUrl) {
      pushRef('storyboard', 'composition reference for viewpoint and subject placement', 'storyboard', frameRefUrl, '', '')
    }
    let styleAnchorUrl = ''
    try {
      styleAnchorUrl = String(queryOne('SELECT style_anchor_url FROM episodes WHERE id = ?', [shot.episode_id])?.style_anchor_url || '').trim()
    } catch {  }
    if (styleAnchorUrl && refs.length < 9) {
      pushRef('styleanchor', 'final frame of the episode opening shot, absolute art-style anchor', 'styleanchor', styleAnchorUrl, '', '')
    }
    while (refs.length > 9) {
      const dropIdx = refs.findLastIndex((r) => r.kind === 'scene' || r.kind === 'prop')
      if (dropIdx >= 0) { refs.splice(dropIdx, 1); continue }
      refs.length = 9
    }
    const gridDlg = parseDialogue(shot.dialogue)
    const speakingNames = new Set(
      gridDlg
        .filter((d) => cleanText(d?.text || d?.line || d?.content)) 
        .map((d) => cleanText(d?.character || d?.speaker || d?.name))
        .filter(Boolean)
    )
    const audioRefs = []
    for (const c of charRowsAll) {
      if (!speakingNames.has(c.name)) continue 
      const idx = refs.findIndex((r) => r.kind === 'character' && r.label === c.name)
      if (idx >= 0 && c.audio_url) audioRefs.push({ subjectNum: idx + 1, label: c.name, audio: c.audio_url })
    }

    const prevShot = queryOne(
      `SELECT s.id AS prev_id, s.video_url AS prev_video, ss.scene_number AS prev_scene
       FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id
       WHERE ss.episode_id = ? AND s.id != ? AND s.start_time < ?
         AND s.video_url IS NOT NULL AND s.video_url != '' AND s.video_generated = 1
       ORDER BY s.start_time DESC, s.id DESC LIMIT 1`,
      [shot.episode_id, shotId, Number(shot.start_time) || 0]
    )
    const crossScene = prevShot
      ? Number(prevShot.prev_scene) !== Number(shot.scene_number)
      : false
    const mcPolicy = resolveMc({
      explicit: useMotionContext,
      globalEnabled: config.runninghub.motionContext.enabled === true,
      crossScene,
    })
    const mcWanted = mcPolicy.wanted
    if (mcPolicy.reason === 'cross-scene') {
      console.log(`[/generate/video-v4] MC 跨场自动关：shot ${shotId}（场 ${shot.scene_number}）上一镜 shot ${prevShot.prev_id}（场 ${prevShot.prev_scene}）——换场跳切按设计不接龙`)
    }
    let prevVideoUrl = ''
    let mcDegradeNote = ''
    if (mcWanted) {
      if (prevShot?.prev_video) {
        prevVideoUrl = prevShot.prev_video
        console.log(`[/generate/video-v4] MC 续镜：shot ${shotId} 接上一镜 shot ${prevShot.prev_id} 成片 ${prevVideoUrl}`)
      } else {
        const hasAnyPrev = queryOne(
          `SELECT s.id FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id
           WHERE ss.episode_id = ? AND s.id != ? AND s.start_time < ? LIMIT 1`,
          [shot.episode_id, shotId, Number(shot.start_time) || 0]
        )
        if (hasAnyPrev) {
          mcDegradeNote = 'MC 续镜未生效：上一镜尚无成片（或未完成回写），本镜按普通版出片，接缝不保证连贯'
          console.warn(`[/generate/video-v4] shot ${shotId} ${mcDegradeNote}`)
          recordAlert({ episodeId: shot.episode_id, shotId, shotNumber: shot.shot_number, source: 'mc', level: 'warn',
            message: `镜 ${shot.shot_number} MC 续镜未生效（上一镜无成片/回写未完成），本镜按普通版出片：接缝连贯性不保证` })
        }
      }
    }

    let retryNote = ''
    const rawFeedback = String(shot.retry_feedback || '').trim()
    if (rawFeedback && rawFeedback !== 'null') {
      try {
        const fb = JSON.parse(rawFeedback)
        const items = [
          ...(Array.isArray(fb.missingBeats) ? fb.missingBeats : []).map((b) => `剧本节拍未演出：${String(b)}`),
          ...(Array.isArray(fb.issues) ? fb.issues.slice(0, 3) : []),
        ]
        if (items.length) {
          const en = await chatCompletion([
            { role: 'system', content: 'Translate the following Chinese film-direction correction notes into concise English imperatives for an AI video generation model (e.g. "the bear collapses into the snow; the red glow fades from its eyes"). Output ONLY the English sentences joined by semicolons, no preamble.' },
            { role: 'user', content: items.join('\n') },
          ], { temperature: 0.2, maxTokens: 400, disableThinking: true })
          const retryNoteEn = pickInjectableEnglish(en)
          retryNote = retryNoteEn
          if (!retryNoteEn) {
            console.warn(`[/generate/video-v4] shot ${shotId} 验收回灌译文删除残留中文后为空壳（无实质英文指令），本次不注入`)
          } else {
            console.log(`[/generate/video-v4] shot ${shotId} 注入验收失败回灌（第 ${1 + (Number(shot.retry_count) || 0)} 次重试）: ${retryNoteEn.slice(0, 120)}`)
          }
        }
      } catch {  }
    }

    const prompt = await buildShotVideoPromptV4(shot, { stylePrompt: finalStyle, stylePromptEn: finalStyleEn, refs, audioRefs, isCombat, speakerIds: episodeSpeakerIds(shot), retryNote, combatNote })

    const WIDE_SHOT_RE = /^(大全景|全景|大远景|远景|全身|广角)$/
    const needSecondPass =
      secondPass === 'on' ? true
      : secondPass === 'off' ? false
      : (isCombat || WIDE_SHOT_RE.test(String(shot.shot_type || '')) || audioRefs.length > 0)
    const firstMegapixels = megapixels || '0.5'
    const sampling = needSecondPass
      ? { firstPassSteps: 6, firstPassDenoise: 1, secondPassSteps: 4, secondPassDenoise: 0.4, upscaleMegapixels: 1 }
      : { firstPassSteps: 6, firstPassDenoise: 1, secondPassSteps: 1, secondPassDenoise: 0.01, upscaleMegapixels: firstMegapixels }

    const result = await generateShotVideoV4(
      { shotId: String(shotId), prompt, refs, audioRefs: audioRefs.map((a) => a.audio), aspectRatio, megapixels, duration: duration ?? shot.duration, combatLoraStrength: isCombat ? '0.5' : '0', seed: seed != null ? seed : undefined, ...sampling, prevVideoUrl: prevVideoUrl || undefined },
      { onProgress: (phase, info) => {
        const j = v4VideoJobsInflight.get(jobKey)
        if (j) {
          j.phase = String(phase || '')
          if (info?.taskId) j.taskId = String(info.taskId)
        }
        console.log(`[/generate/video-v4] shot ${shotId} ${phase}${info?.message ? ': ' + info.message : ''}`)
      } }
    )

    if (result.success && result.videoUrl) {
      if (!/^\/uploads\//i.test(result.videoUrl)) {
        const localName = `shot_${shotId}_v4_${Date.now()}.mp4`
        const localPath = path.join(uploadsDir, localName)
        let localized = false, lastErr = null
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const buf = await insecureDownload(result.videoUrl)
            if (!isPlausibleMp4(buf)) throw new Error(`下载内容不是有效 mp4（${buf ? buf.length : 0} 字节，疑为错误页/残片）`)
            fs.writeFileSync(localPath, buf)
            console.log(`[/generate/video-v4] shot ${shotId} 云端成片已本地化 → /uploads/${localName}（第 ${attempt} 次）`)
            localized = true
            break
          } catch (e) {
            lastErr = e
            console.warn(`[/generate/video-v4] shot ${shotId} 成片本地化第 ${attempt} 次失败:`, e.message)
            if (attempt < 3) await new Promise((r) => setTimeout(r, 3000 * attempt))
          }
        }
        if (localized) {
          result.videoUrl = `/uploads/${localName}`
        } else if (result.taskId) {
          try {
            const q = await queryTaskOutput(result.taskId)
            const altUrls = (Array.isArray(q?.allResults) ? q.allResults : [])
              .map((r) => String(r?.url || '')).filter(Boolean)
              .filter((u) => u !== result.videoUrl)
            console.log(`[/generate/video-v4] shot ${shotId} 主 URL 下载失败，尝试备用节点（${altUrls.length} 个）`)
            for (const u of altUrls) {
              try {
                const buf = await insecureDownload(u)
                if (!isPlausibleMp4(buf)) continue
                fs.writeFileSync(localPath, buf)
                console.log(`[/generate/video-v4] shot ${shotId} 备用节点下载成功 → /uploads/${localName}（${(buf.length / 1048576).toFixed(1)}MB）`)
                localized = true
                break
              } catch {  }
            }
          } catch (e) {
            console.warn(`[/generate/video-v4] shot ${shotId} 备用节点查询失败:`, e.message)
          }
          if (localized) {
            result.videoUrl = `/uploads/${localName}`
          } else {
            recordAlert({ episodeId: shot.episode_id, shotId, shotNumber: shot.shot_number, source: 'writeback', level: 'error',
              message: `镜 ${shot.shot_number} 成片本地化失败（3 次重试 + 备用节点全灭）：video_url 仍是云端 URL——已登记打捞队列，后台每 5 分钟自动重捞（50 分钟窗口）`,
              detail: lastErr })
            enqueueSalvage({ shotId, shotNumber: shot.shot_number, episodeId: shot.episode_id, taskId: result.taskId, url: result.videoUrl })
          }
        } else {
          recordAlert({ episodeId: shot.episode_id, shotId, shotNumber: shot.shot_number, source: 'writeback', level: 'error',
            message: `镜 ${shot.shot_number} 成片本地化失败（3 次重试耗尽）：video_url 仍是云端 URL——已登记打捞队列，后台每 5 分钟自动重捞（50 分钟窗口）`,
            detail: lastErr })
          enqueueSalvage({ shotId, shotNumber: shot.shot_number, episodeId: shot.episode_id, taskId: null, url: result.videoUrl })
        }
      }
      let wbWarning = ''
      let wbErrCaught = null
      try {
        execute('UPDATE shots SET video_url = ?, video_generated = 1, retry_feedback = \'\', shot_review = NULL, retry_count = COALESCE(retry_count, 0) + CASE WHEN ? != \'\' THEN 1 ELSE 0 END WHERE id = ?', [result.videoUrl, rawFeedback, shotId])
      } catch (wbErr) {
        wbErrCaught = wbErr
        wbWarning = `回写失败：成片已生成（地址：${result.videoUrl}）+ 数据库回写失败，请勿重复出片，需人工排查`
      }
      console.log('[/generate/video-v4] saved video_url for shot', shotId, result.videoUrl)
      const clearedAlerts = resolveAlertsByShot(shotId, 'regen')
      if (clearedAlerts) console.log(`[/generate/video-v4] shot ${shotId} 重生成功，清掉 ${clearedAlerts} 条旧告警`)
      if (wbWarning) {
        recordAlert({ episodeId: shot.episode_id, shotId, shotNumber: shot.shot_number, source: 'writeback', level: 'error',
          message: `镜 ${shot.shot_number} ${wbWarning}`,
          detail: wbErrCaught })
      }
      const alertCtx = { episodeId: shot.episode_id, shotId, shotNumber: shot.shot_number }

      relayLastFrameToNextShot({ ...shot, video_url: result.videoUrl })
        .then((r) => {
          console.log(`[/generate/video-v4] shot ${shotId} 末帧已自动接力 → 下一镜 ${r.nextShotNumber || r.nextShotId}`)
          return anchorEpisodeStyle({ ...shot, video_url: result.videoUrl })
        })
        .then((a) => { if (a) console.log(`[/generate/video-v4] shot ${shotId} 是全集首镜，风格锚已更新: ${a}`) })
        .catch((e) => {
          const lastShot = /最后一镜|没有下一镜/.test(String(e.message || ''))
          if (!lastShot) {
            recordAlert({ ...alertCtx, source: 'relay', level: 'error', message: `镜 ${shot.shot_number} 末帧自动接力失败：下一镜将以无锚开场（接缝连贯性不保证），需手动补接力`, detail: e })
          }
          console.warn(`[/generate/video-v4] shot ${shotId} 末帧自动接力失败（不影响成片）:`, e.message)
        })
      if (String(shot.continuity_url || '').trim()) {
        checkSeam({ ...shot, video_url: result.videoUrl })
          .then((r) => console.log(`[/generate/video-v4] shot ${shotId} 衔接检测: CCT差${r.cctDiffK ?? 'n/a'}K / 亮度差${r.lumaDiff} / 构图差${r.hashDist}/64 ${r.alert ? '⚠️ 超阈值，镜头卡片已标红' : 'OK'}`))
          .catch((e) => {
            recordAlert({ ...alertCtx, source: 'seam', level: 'error', message: `镜 ${shot.shot_number} 衔接质量检测失败：本镜接缝质量未知（无色温/亮度结论），上游告警可能漏拦，需手动重检`, detail: e })
            console.warn(`[/generate/video-v4] shot ${shotId} 衔接检测失败（不影响成片）:`, e.message)
          })
      } else {
        checkOpenerTone({ ...shot, video_url: result.videoUrl })
          .then((r) => console.log(`[/generate/video-v4] shot ${shotId} 开场色向闸: R-B=${r.rb} 带宽[${r.band.rbMin},${r.band.rbMax}] ${r.alert ? '⚠️ 色调跑偏，镜头卡片已标红' : 'OK'}`))
          .catch((e) => {
            recordAlert({ ...alertCtx, source: 'openerTone', level: 'error', message: `镜 ${shot.shot_number} 开场色向闸失败：色调跑偏未被把关（此镜是接力链色调源头，跑偏会顺锚放大到下游），需手动重检`, detail: e })
            console.warn(`[/generate/video-v4] shot ${shotId} 开场色向闸失败（不影响成片）:`, e.message)
          })
      }
      reviewShot({ ...shot, video_url: result.videoUrl })
        .then((r) => console.log(`[/generate/video-v4] shot ${shotId} 观片闸: 均分${r.avgScore} [${r.verdict}] ${r.summary}`))
        .catch((e) => {
          const notConfigured = /未配置/.test(String(e.message || ''))
          recordAlert({
            ...alertCtx, source: 'review', level: notConfigured ? 'warn' : 'error',
            message: `镜 ${shot.shot_number} 观片闸未出结论：${notConfigured ? 'VLM 模型未配置（配置后可用 POST /generate/shot-review 补评）' : '评审调用失败，本镜无第一观众结论，需人工看片或补评'}`,
            detail: e,
          })
          console.warn(`[/generate/video-v4] shot ${shotId} 观片闸跳过（不影响成片）:`, e.message)
        })
      res.json({ success: true, url: result.videoUrl, taskId: result.taskId, warning: [result.warning, mcDegradeNote, wbWarning].filter(Boolean).join('；') || '', alertsCleared: clearedAlerts })
    } else {
      res.json({ success: false, error: result.error || '出片失败', taskId: result.taskId })
    }
  } catch (err) {
    console.error('[/generate/video-v4] error', { shotId, error: err.message })
    res.status(500).json({ error: err.message })
  } finally {
    v4VideoJobsInflight.delete(jobKey)
  }
})

const VIDEO_JOB_STALE_MS = 30 * 60 * 1000 

function shotBusyInShotChannels(shotId) {
  const now = Date.now()
  for (const [key, map] of [[`video-v4:${shotId}`, v4VideoJobsInflight], [`videoV3:${shotId}`, v3VideoJobsInflight]]) {
    const j = map.get(key)
    if (!j) continue
    if (now - j.startedAt > VIDEO_JOB_STALE_MS) { map.delete(key); continue }
    return { key, job: j }
  }
  return null
}

function shotBusyInSegmentChannel(shotId) {
  const now = Date.now()
  for (const [key, job] of segmentJobsInflight) {
    if (now - job.startedAt > VIDEO_JOB_STALE_MS) { segmentJobsInflight.delete(key); continue }
    if (!Array.isArray(job.shotIds)) continue
    if (job.shotIds.some((id) => Number(id) === Number(shotId))) return { key, job }
  }
  return null
}

function segmentBusyInShotChannels(shotIds) {
  for (const sid of shotIds || []) {
    const hit = shotBusyInShotChannels(sid)
    if (hit) return { shotId: Number(sid), ...hit }
  }
  return null
}

const segmentJobsInflight = new Map()

export function resetZombieSegments() {
  try {
    const zombies = query("SELECT id, shot_numbers FROM video_segments WHERE status = 'running'")
    if (!zombies.length) return 0
    execute(
      "UPDATE video_segments SET status = 'failed', error = ? WHERE status = 'running'",
      ['出片被中断（服务重启/进程退出）：状态已复位，请重新出片']
    )
    for (const z of zombies) {
      console.warn(`[generate/video-segment] 启动复位僵尸段 ${z.id}（${z.shot_numbers || ''}）：running → failed`)
    }
    return zombies.length
  } catch (e) {
    console.warn('[generate/video-segment] 僵尸段复位失败（不影响启动）:', e?.message || e)
    return 0
  }
}

router.get('/video-segment/inflight', (req, res) => {
  res.json({ inflight: [...segmentJobsInflight.values()] })
})

router.post('/video-segment/cancel', async (req, res) => {
  const segmentId = Number(req.body?.segmentId)
  const job = [...segmentJobsInflight.values()].find((j) => j.segmentId === segmentId)
  if (!job) return res.status(404).json({ error: `段 ${segmentId} 没有正在进行的出片任务` })
  if (!job.taskId) return res.status(409).json({ error: '该任务的 taskId 未捕获（旧进程发起或尚未提交成功），无法云端取消，只能等它自然结束' })
  const { cancelTask } = await import('../ai/runninghub.js')
  const ok = await cancelTask(job.taskId)
  if (!ok) return res.status(500).json({ error: `RunningHub 取消失败（taskId=${job.taskId}），可能任务已完成或已不在队列` })
  job.phase = 'cancelling'
  res.json({ success: true, taskId: job.taskId, note: '云端任务已请求取消；本地轮询感知到失败状态后自动收敛，成片不会回灌' })
})

function buildSegmentAssets(seg, shots) {
  const episodeId = seg.episode_id
  const project = queryOne('SELECT art_style FROM projects WHERE id = (SELECT project_id FROM episodes WHERE id = ?)', [episodeId])
  const styleLabel = project?.art_style || ''
  let stylePrompt = styleLabel
  let stylePromptEn = ''
  try {
    if (styleLabel) {
      const sp = queryOne('SELECT prompt, prompt_en, label_en FROM style_presets WHERE label = ? LIMIT 1', [styleLabel])
      if (sp?.prompt) stylePrompt = sp.prompt
      stylePromptEn = String(sp?.prompt_en || '').trim() || String(sp?.label_en || '').trim()
    }
  } catch {  }

  const parseNames = (v) => { if (!v) return []; try { const r = JSON.parse(v); return Array.isArray(r) ? r : [] } catch { return [] } }
  const charRowsAll = mergeMasterIntoEpisodeCharacters(
    query('SELECT id, name, name_en, description, description_en, image_url, audio_url FROM characters WHERE episode_id = ?', [episodeId])
  )
  const sceneRows = query('SELECT id, title, title_en, summary, summary_en, image_url, lighting_en FROM scenes WHERE episode_id = ?', [episodeId])
  const propRows = query('SELECT id, name, name_en, description, description_en, image_url FROM props WHERE episode_id = ?', [episodeId])
  const propTableNames = propRows.map((r) => r.name)
  const sceneTitles = sceneRows.map((r) => r.title)

  const refs = []
  const pushRef = (label, desc, kind, image, labelEn, descEn, lightingEn) => {
    if (!image) return
    if (refs.some((r) => r.image === image)) return
    refs.push({
      label: String(label || ''), desc: String(desc || ''), kind, image,
      labelEn: String(labelEn || ''), descEn: String(descEn || ''),
      lightingEn: String(lightingEn || ''),
    })
  }
  const speakingNames = new Set()
  for (const sh of shots) {
    for (const n of parseNames(sh.characters)) {
      const c = charRowsAll.find((x) => x.name === n)
      if (c) pushRef(c.name, c.description, 'character', c.image_url, c.name_en, c.description_en)
    }
    for (const sn of parseNames(sh.scene_assets)) {
      const s = sceneRows.find((x) => x.title === sn)
      if (s && !String(s.image_url || '').trim()) {
        recordAlert({
          episodeId, shotId: sh.id, shotNumber: sh.shot_number, source: 'sceneImage', level: 'warn',
          message: `镜 ${sh.shot_number} 的场景「${s.title}」（场景 id ${s.id}）命中场景表但尚无参考图（image_url 为空）：本段出片拿不到该场景参考图，构图与光影只能靠模型自由发挥；请到设定页给该场景生成或上传参考图`,
          detail: JSON.stringify({ sceneId: s.id, sceneTitle: s.title, imageUrl: String(s.image_url || '') }).slice(0, 2000),
        })
        continue
      }
      if (s) pushRef(s.title, s.summary, 'scene', s.image_url, s.title_en, s.summary_en, s.lighting_en)
      else {
        recordAlert({
          episodeId, shotId: sh.id, shotNumber: sh.shot_number, source: 'sceneName', level: 'warn',
          message: `镜 ${sh.shot_number} 的场景「${sn}」在场景表中无对应项（多趟 LLM 命名不一致），本段无该场景参考图；请在设定页核对场景名`,
          detail: JSON.stringify({ raw: sn, candidates: sceneTitles }).slice(0, 2000),
        })
      }
    }
    for (const pn of parseNames(sh.prop_assets)) {
      const matched = resolvePropName(pn, propTableNames)
      if (!matched) {
        recordAlert({
          episodeId, shotId: sh.id, shotNumber: sh.shot_number, source: 'propName', level: 'warn',
          message: `镜 ${sh.shot_number} 的道具「${pn}」在道具表中无对应项（多趟 LLM 命名不一致），本段无该道具参考图；请在设定页核对道具名`,
          detail: JSON.stringify({ raw: pn, candidates: propTableNames }).slice(0, 2000),
        })
        continue
      }
      const p = propRows.find((x) => x.name === matched)
      if (p) pushRef(p.name, p.description, 'prop', p.image_url, p.name_en, propStateDescEn(sh, p.name, p.description_en))
    }
    const dlg = parseDialogue(sh.dialogue)
    for (const d of dlg) {
      const who = cleanText(d?.character || d?.speaker || d?.name)
      const text = cleanText(d?.text || d?.line || d?.content)
      if (who && text) speakingNames.add(who)
    }
  }

  if (seg.anchor_frame_url) {
    pushRef('continuity', 'final frame of the previous segment, continuity anchor for character and environment state', 'continuity', seg.anchor_frame_url, '', '')
  }
  let styleAnchorUrl = ''
  try {
    styleAnchorUrl = String(queryOne('SELECT style_anchor_url FROM episodes WHERE id = ?', [episodeId])?.style_anchor_url || '').trim()
  } catch {  }
  if (styleAnchorUrl && refs.length < 9) {
    pushRef('styleanchor', 'final frame of the episode opening shot, absolute art-style anchor', 'styleanchor', styleAnchorUrl, '', '')
  }
  while (refs.length > 9) {
    const dropIdx = refs.findLastIndex((r) => r.kind === 'scene' || r.kind === 'prop')
    if (dropIdx >= 0) { refs.splice(dropIdx, 1); continue }
    refs.length = 9
  }

  const audioRefs = []
  for (const c of charRowsAll) {
    if (!speakingNames.has(c.name)) continue
    const idx = refs.findIndex((r) => r.kind === 'character' && r.label === c.name)
    if (idx >= 0 && c.audio_url) audioRefs.push({ subjectNum: idx + 1, label: c.name, audio: c.audio_url })
    if (audioRefs.length >= 3) break
  }

  const isCombat = shots.some((sh) => resolveIsCombat(sh))
  return { stylePrompt, stylePromptEn, refs, audioRefs, isCombat }
}


router.post('/video-segment/:id', async (req, res) => {
  const segmentId = Number(req.params.id)
  const { allowSilent = false, allowNoFrame = false, forceRetry = false, skipSlice = false } = req.body || {}

  const seg = queryOne('SELECT * FROM video_segments WHERE id = ?', [segmentId])
  if (!seg) return res.status(404).json({ error: '段不存在' })
  if (seg.status === 'unusable') {
    return res.status(400).json({ error: `段 ${segmentId} 标记为 unusable（段长非法），请逐镜出片` })
  }

  if (seg.status === 'running' && !req.body?.forceSteal) {
    return res.status(409).json({
      error: `段 ${segmentId}（${seg.shot_numbers}）当前标记为「出片中」。若你的上一次出片因进程重启而中断，`
        + `该状态可能已失效——请稍候片刻重试（服务启动时会自动复位僵尸段），或用「取消」按钮终止后再出片。`,
      segmentId, running: true,
    })
  }

  const { shots, missingIds } = (await import('../ai/segmentPrompt.js')).loadSegment(segmentId)
  if (!shots.length) return res.status(400).json({ error: `段 ${segmentId} 无镜（shot_ids 为空）` })

  if (missingIds.length) {
    const alive = shots.map((s) => s.shot_number).join('、')
    return res.status(400).json({
      error: `段 ${segmentId} 的记录已过期：记录含 ${shots.length + missingIds.length} 镜，`
        + `但 ${missingIds.length} 镜已被删除或重建（现存：${alive}）。`
        + `若按此出片，缺失镜的内容不会出现在成片里，且该镜永远拿不到视频。`
        + `请到分镜页「重算段方案」后再出片。`,
      segmentId,
      missingShotIds: missingIds,
      aliveShotNumbers: shots.map((s) => s.shot_number),
    })
  }

  {
    const { segmentStaleness } = await import('../ai/segmentBuilder.js')
    const fp = segmentStaleness(seg)
    if (fp.stale) {
      return res.status(400).json({
        error: `段 ${segmentId}（${seg.shot_numbers}）的方案已过期：${fp.reason}。`
          + `若按此出片，成片会在切片那一步被拒绝，本段的生成费用白花且段内镜头拿不到视频。`
          + `请到短片页点「重算分段」后再出片。`,
        segmentId,
        stale: true,
        staleReason: fp.reason,
        storedFingerprint: seg.shots_fp || '',
        currentFingerprint: fp.currentFingerprint,
      })
    }
  }

  const anyDlg = shots.some((sh) => hasDialogue(sh.dialogue))
  if (!anyDlg && !allowSilent) {
    return res.status(400).json({ error: '本段所有镜都没有台词（dialogue 全空）：H3 只念 <d> 标签内的台词，无台词=成片没有角色语音。请补全台词或重新生成分镜；若确认为纯动作无声段，请传 allowSilent 再出片。' })
  }

  const noAnchorShots = shots.filter((sh) => !String(sh.frame_url || '').trim() && !String(sh.continuity_url || '').trim())
  if (noAnchorShots.length && !allowNoFrame) {
    const list = noAnchorShots.map((s) => s.shot_number).join('、')
    return res.status(400).json({
      error: `段内 ${noAnchorShots.length} 镜没有分镜图也没有接力锚（${list}）：这些镜出片没有构图锚，构图靠模型自由发挥，与分镜大概率对不上——段是一体生成，一镜跑偏整段返工。请先补分镜图再出段；确认纯文字出片请传 allowNoFrame。`,
      missingFrameShots: noAnchorShots.map((s) => ({ shotId: s.id, shotNumber: s.shot_number })),
    })
  }

  try {
    assertScriptConfirmed(seg.episode_id)
    assertNotStale(seg.episode_id, 'storyboard')
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message })
  }
  const poisoned = shots.find((sh) => {
    try { assertNoStylePoison(sh, req.body?.allowStyleShift); return false } catch { return true }
  })
  if (poisoned) {
    try { assertNoStylePoison(poisoned, req.body?.allowStyleShift) } catch (err) {
      return res.status(err.status || 400).json({ error: `段内镜 ${poisoned.shot_number} ${err.message}` })
    }
  }
  if (!forceRetry) {
    const tired = shots.find((sh) => (Number(sh.retry_count) || 0) >= 2 && String(sh.retry_feedback || '').trim())
    if (tired) {
      return res.status(409).json({ error: `段内镜 ${tired.shot_number} 已按验收反馈自动回灌 ${tired.retry_count} 次仍未过审，且当前又有新的失败反馈：继续同路径重出大概率重复失败。请先人工看片定位根因；确认仍要重试请传 forceRetry: true。` })
    }
  }

  const inShotChannel = segmentBusyInShotChannels(shots.map((s) => s.id))
  if (inShotChannel) {
    const busyShot = shots.find((s) => Number(s.id) === Number(inShotChannel.shotId))
    return res.status(409).json({
      error: `段内镜 ${busyShot?.shot_number || inShotChannel.shotId} 正在单独出片（${inShotChannel.key}）：段的成片会切片覆盖它，两条通道都在烧币。请等该镜完成或取消后再出段。`,
      conflict: 'shot', shotKey: inShotChannel.key, shotId: inShotChannel.shotId,
    })
  }

  const jobKey = `video-segment:${segmentId}`
  if (segmentJobsInflight.has(jobKey)) {
    return res.status(409).json({ error: '该段正在出片中，请等待完成后再试' })
  }
  segmentJobsInflight.set(jobKey, { segmentId, sceneNumber: seg.scene_number, segmentIndex: seg.segment_index, shotIds: shots.map((s) => Number(s.id)), startedAt: Date.now(), phase: 'submitting' })
  execute("UPDATE video_segments SET status = 'running', error = '' WHERE id = ?", [segmentId])

  let generatedUrl = ''

  try {
    const { buildSegmentVideoPrompt } = await import('../ai/segmentPrompt.js')
    const { sliceSegment, extractSegmentLastFrame } = await import('../ai/segmentSlicer.js')

    const assets = buildSegmentAssets(seg, shots)
    const { segmentDurationSec } = await import('../ai/segmentBuilder.js')
    const duration = segmentDurationSec(seg, shots)
    const speakerIds = episodeSpeakerIds(shots[0])

    const combatTriggers = /倒进|倒地|瘫倒|击倒|轰然倒/.test(shots.map((s) => `${s.description || ''}${s.action_note || ''}`).join(' '))
      ? 'prfight1, prfin1'
      : 'prfight1'
    const COMBAT_STYLE_EN = 'SAME hand-drawn watercolor animation art style as the reference images and the rest of the episode — never switch to any other art register or render style; grounded fight and action choreography with real weight and inertia, every impact lands with full body weight — recoil, shockwaves, debris flying on contact, fast decisive motion with follow-through, intensity and physical danger conveyed through scale, motion and physical detail, no magic aura, no energy effects, ' + combatTriggers
    const combatNote = assets.isCombat ? COMBAT_STYLE_EN : ''

    const prompt = await buildSegmentVideoPrompt({
      seg, shots,
      refs: assets.refs,
      audioRefs: assets.audioRefs,
      stylePromptEn: assets.stylePromptEn,
      speakerIds,
      isCombat: assets.isCombat,
      combatNote,
    })

    const { validateSegmentPrompt } = await import('../ai/segmentPrompt.js')
    const v = validateSegmentPrompt(prompt, shots.length)
    if (!v.ok) {
      const msg = `段级 prompt 结构校验失败：${v.errors.join('；')}`
      execute("UPDATE video_segments SET status = 'failed', error = ? WHERE id = ?", [msg.slice(0, 500), segmentId])
      return res.status(500).json({ error: msg, errors: v.errors })
    }

    segmentJobsInflight.get(jobKey).phase = 'generating'
    console.log(`[/generate/video-segment] 段${segmentId}（场${seg.scene_number}段${seg.segment_index}）提交：${shots.map((s) => s.shot_number).join('+')} ${duration}s，refs ${assets.refs.length} 槽，音色 ${assets.audioRefs.length} 槽，戏型 ${assets.isCombat ? '武戏' : '文戏'}`)

    const result = await generateShotVideoV4(
      {
        shotId: `segment-${segmentId}`,
        prompt,
        refs: assets.refs,
        audioRefs: assets.audioRefs.map((a) => a.audio),
        aspectRatio: shots[0].__aspectRatio || config.video.defaultAspectRatio,
        duration,
        combatLoraStrength: assets.isCombat ? '0.5' : '0',
      },
      { onProgress: (phase, info) => { const j = segmentJobsInflight.get(jobKey); if (j) { j.phase = `${phase}${info?.message ? ': ' + info.message : ''}`; if (info?.taskId) j.taskId = String(info.taskId) } } }
    )

    if (!result.success || !result.videoUrl) {
      execute("UPDATE video_segments SET status = 'failed', error = ? WHERE id = ?", [String(result.error || '出片失败').slice(0, 500), segmentId])
      return res.json({ success: false, error: result.error || '出片失败', taskId: result.taskId })
    }
    generatedUrl = result.videoUrl

    const segmentLocalized = String(result.videoUrl).startsWith('/uploads/')
    if (!segmentLocalized) {
      const segLabel = `${seg.scene_number}-${seg.segment_index}（${seg.shot_numbers}）`
      recordAlert({
        episodeId: seg.episode_id, shotId: shots[0].id, shotNumber: String(shots[0].shot_number || ''),
        source: 'writeback', level: 'error',
        message: `段 ${segLabel} 成片本地化失败：video_url 仍是 24h 时效的云端链接，切片无法进行（段内 ${shots.length} 镜拿不到画面）。已登记段级打捞队列，后台每 5 分钟自动重捞，捞到后自动补切片。`,
        detail: { segmentId, videoUrl: result.videoUrl },
      })
      enqueueSalvage({
        segmentId, segmentLabel: segLabel, episodeId: seg.episode_id,
        taskId: result.taskId, url: result.videoUrl,
      })
    }

    let segWbWarning = ''
    try {
      execute("UPDATE video_segments SET status = 'done', video_url = ?, error = ? WHERE id = ?", [result.videoUrl, result.warning || '', segmentId])
    } catch (wbErr) {
      segWbWarning = `回写失败：段成片已生成（地址：${result.videoUrl}）+ 数据库回写失败，请勿重复出片，需人工排查`
      recordAlert({
        episodeId: seg.episode_id, shotId: shots[0].id, shotNumber: String(shots[0].shot_number || ''),
        source: 'writeback', level: 'error',
        message: `段 ${seg.scene_number}-${seg.segment_index}（${seg.shot_numbers}）${segWbWarning}`,
        detail: wbErr,
      })
    }

    let anchorUrl = ''
    try {
      const fr = await extractSegmentLastFrame(segmentId)
      if (fr.success) {
        anchorUrl = fr.url
        execute(
          "UPDATE video_segments SET anchor_frame_url = ? WHERE episode_id = ? AND scene_number = ? AND segment_index = ? AND status IN ('pending','failed')",
          [anchorUrl, seg.episode_id, seg.scene_number, seg.segment_index + 1]
        )
      }
    } catch (e) {
      console.warn(`[/generate/video-segment] 段${segmentId} 末帧抽取失败（不影响成片，下游段少一个接力锚）:`, e.message)
    }

    let sliceResult = null
    if (!skipSlice) {
      segmentJobsInflight.get(jobKey).phase = 'slicing'
      sliceResult = await sliceSegment(segmentId, { force: true })
      if (!sliceResult.success) {
        recordAlert({
          level: 'error', source: 'writeback', episodeId: seg.episode_id,
          shotId: shots[0].id, shotNumber: shots[0].shot_number,
          message: `段 ${seg.scene_number}-${seg.segment_index}（${seg.shot_numbers}）切片回填失败：卡片仍会播放整段成片。${sliceResult.warning}`,
          detail: sliceResult,
        })
      }
    }

    res.json({
      success: true,
      url: result.videoUrl,
      taskId: result.taskId,
      anchorUrl,
      slice: sliceResult ? { ok: sliceResult.success, count: sliceResult.slices?.length || 0, warning: sliceResult.warning || '' } : { skipped: true },
      warning: [result.warning, segWbWarning].filter(Boolean).join('；') || '',
    })
  } catch (err) {
    console.error(`[/generate/video-segment] 段${segmentId} error`, err.message)
    if (generatedUrl) {
      return res.json({
        success: true,
        url: generatedUrl,
        warning: `段成片已生成（地址：${generatedUrl}），但后续步骤出错：${String(err.message || '').slice(0, 300)}；请勿重复出片，需人工排查`,
      })
    }
    execute("UPDATE video_segments SET status = 'failed', error = ? WHERE id = ?", [String(err.message).slice(0, 500), segmentId])
    res.status(500).json({ error: err.message })
  } finally {
    segmentJobsInflight.delete(jobKey)
  }
})

const V3_VIDEO_JOB_STALE_MS = 30 * 60 * 1000
const v3VideoJobsInflight = new Map()

router.get('/video-v3/inflight', (req, res) => {
  const now = Date.now()
  const jobs = []
  for (const [key, job] of v3VideoJobsInflight) {
    if (now - job.startedAt > V3_VIDEO_JOB_STALE_MS) {
      v3VideoJobsInflight.delete(key)
      continue
    }
    jobs.push({ shotId: job.shotId, startedAt: job.startedAt, phase: job.phase || '' })
  }
  res.json({ jobs })
})

router.post('/video-v3', async (req, res) => {
  const {
    shotId,
    idea,          
    bgImage = '',  
    aspectRatio,
    megapixels,
    duration,
  } = req.body
  if (!shotId) return res.status(400).json({ error: 'shotId 必填' })

  const shot = queryOne(
    `SELECT s.*, ss.episode_id
     FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id WHERE s.id = ?`,
    [shotId]
  )
  if (!shot) return res.status(404).json({ error: '镜头不存在' })

  try {
    assertNoStylePoison(shot, req.body.allowStyleShift)
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message })
  }

  try {
    assertScriptConfirmed(shot.episode_id)
    assertNotStale(shot.episode_id, 'storyboard')
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message })
  }

  const v3InSegment = shotBusyInSegmentChannel(shotId)
  if (v3InSegment) {
    return res.status(409).json({
      error: `该镜头属于正在出片的段（${v3InSegment.key}），段的成片会切片回填本镜——现在用打斗通道单独出片会与之互相覆盖且双倍计费。请等该段完成后再操作。`,
      conflict: 'segment', segmentKey: v3InSegment.key,
    })
  }

  const jobKey = `videoV3:${shotId}`
  if (v3VideoJobsInflight.has(jobKey)) {
    return res.status(409).json({ error: '该镜头正在出片（打斗工作流），请等待完成后再试' })
  }
  v3VideoJobsInflight.set(jobKey, { shotId, startedAt: Date.now(), phase: 'submitting' })
  const job = v3VideoJobsInflight.get(jobKey)

  try {
    const parseNames = (v) => {
      if (!v) return []
      try {
        const r = JSON.parse(v)
        return Array.isArray(r) ? r : []
      } catch {
        return []
      }
    }
    const charNames = parseNames(shot.characters)

    const finalStoryboardImage = bgImage || shot.frame_url || shot.frame_url2 || ''

    const cleanClause = (s) => String(s || '').replace(/[。，、；,;\s]+$/g, '').trim()
    const autoIdea = [
      charNames.length ? `对阵：${charNames.join(' 对 ')}` : '',
      shot.action_note ? `关键动作：${cleanText(shot.action_note)}` : '',
      shot.shot_type ? `${cleanText(shot.shot_type)}镜头` : '',
      cleanText(shot.description),
      shot.camera_movement ? `运镜：${cleanText(shot.camera_movement)}` : '',
    ].map(cleanClause).filter(Boolean).join('，') + '。'
    let finalIdea =
      (idea != null && String(idea).trim()) ||
      String(shot.video_prompt_override || '').trim() ||
      autoIdea
    if (!finalIdea) {
      return res.status(400).json({ error: '打斗出片提示词为空：镜头没有画面描述，且未传 idea' })
    }

    if (!finalIdea.includes('画面文字')) {
      finalIdea = `${finalIdea}。画面中不得出现任何文字、字幕、水印或标志。`
    }

    const requestedDuration = Number(duration ?? shot.duration) || 6

    const result = await generateShotVideoCombat(
      {
        shotId: String(shotId),
        idea: finalIdea,
        storyboardImage: finalStoryboardImage,
        aspectRatio,
        megapixels,
        duration: requestedDuration,
      },
      {
        onProgress: (phase, info) => {
          job.phase = phase
          console.log(
            `[/generate/video-v3] shot ${shotId} ${phase}${info?.taskId ? ' taskId=' + info.taskId : ''}${info?.message ? ': ' + info.message : ''}`
          )
        },
      }
    )

    if (result.success && result.videoUrl) {
      execute('UPDATE shots SET video_url = ?, video_generated = 1 WHERE id = ?', [
        result.videoUrl,
        shotId,
      ])
      console.log('[/generate/video-v3] saved video_url for shot', shotId, result.videoUrl)
      res.json({
        success: true,
        url: result.videoUrl,
        taskId: result.taskId,
        warning: result.warning || '',
      })
    } else {
      res.json({ success: false, error: result.error || '出片失败', taskId: result.taskId })
    }
  } catch (err) {
    console.error('[/generate/video-v3] error', { shotId, error: err.message })
    res.status(500).json({ error: err.message })
  } finally {
    v3VideoJobsInflight.delete(jobKey)
  }
})

export default router
