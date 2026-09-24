import { Router } from 'express'
import path from 'node:path'
import fs from 'node:fs'
import { query, queryOne, execute } from '../db.js'

import { chatCompletion } from '../ai/doubao.js'
import { insecureDownload, queryTaskOutput, isPlausibleMp4, resolveLocalMedia } from '../ai/runninghub.js'
import { generateShotVideoCombat } from '../ai/combatVideo.js'
import { generateShotVideoV4, buildShotVideoPromptV4, extractTailClipForContinuity } from '../ai/v4Video.js'
import { assertScriptConfirmed, assertNotStale, assertNoStylePoison } from '../ai/guards.js'
import { checkSeam, checkOpenerTone } from '../ai/seamCheck.js'
import { recordAlert, resolveAlertsByShot } from '../ai/alerts.js'
import { enqueueSalvage } from '../salvageWorker.js'
import { buildGlobalSpeakerMap } from '../ai/h3PromptTranslator.js'
import { classifyShotCombat } from '../ai/shotClassifier.js'
import { config } from '../config.js'
import { clean as cleanText, pickInjectableEnglish } from '../ai/shared.js'
import { parseDialogue, hasDialogue } from '../ai/dialogue.js'
import { mergeMasterIntoEpisodeCharacters } from '../characterLibrary.js'
import { TYPE_PROP } from '../ai/assetTypes.js'
import { resolveState } from '../ai/assetState.js'
import { resolvePropName } from '../ai/propNameMatch.js'
import { pickEnglish as pickEnglishGuard, stripResidualCjk as stripCjkGuard } from '../ai/v4Video.js'
import { uploadsDir, continuityDir } from '../paths.js'
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


const MAX_VIDEO_REFS = 9


function parseNames(v) {
  if (!v) return []
  try {
    const r = JSON.parse(v)
    return Array.isArray(r) ? r : []
  } catch {
    return []
  }
}


// 画风英文名兜底：label_en 缺失时取 prompt_en 的首个短语。
// 只用库内已有英文，不新造翻译（避免编造画风名）；首短语超长或非纯英文则放弃，退回中性锚。
export function resolveStyleLabelEn(labelEn, promptEn, maxLen = 52) {
  const direct = String(labelEn || '').trim()
  if (direct) return direct
  const head = String(promptEn || '').trim().split(/[,;.。，；]/)[0].trim()
  if (!head || head.length > maxLen) return ''
  // 允许数字开头：「3D origami style」「90s Hong Kong cinema aesthetic」都是规范画风名
  return /^[A-Za-z0-9][A-Za-z0-9\s\-'()/&]*$/.test(head) ? head : ''
}


function loadStyleAndAssetRows(episodeId) {
  const project = queryOne('SELECT art_style FROM projects WHERE id = (SELECT project_id FROM episodes WHERE id = ?)', [episodeId])
  const styleLabel = project?.art_style || ''
  let stylePrompt = styleLabel
  let stylePromptEn = ''
  let styleLabelEn = ''
  try {
    if (styleLabel) {
      const sp = queryOne('SELECT prompt, prompt_en, label_en FROM style_presets WHERE label = ? LIMIT 1', [styleLabel])
      if (sp?.prompt) stylePrompt = sp.prompt
      styleLabelEn = resolveStyleLabelEn(sp?.label_en, sp?.prompt_en)
      stylePromptEn = String(sp?.prompt_en || '').trim() || styleLabelEn
    }
  } catch {  }
  const charRowsAll = mergeMasterIntoEpisodeCharacters(
    query('SELECT id, name, name_en, description, description_en, image_url, audio_url FROM characters WHERE episode_id = ?', [episodeId])
  )
  const sceneRows = query('SELECT id, scene_number, title, title_en, summary, summary_en, image_url, lighting_en FROM scenes WHERE episode_id = ?', [episodeId])
  const propRows = query('SELECT id, name, name_en, description, description_en, image_url FROM props WHERE episode_id = ?', [episodeId])
  return {
    stylePrompt,
    stylePromptEn,
    styleLabelEn,
    charRowsAll,
    sceneRows,
    propRows,
    propTableNames: propRows.map((r) => r.name),
    sceneTitles: sceneRows.map((r) => r.title),
  }
}


export function createRefCollector({ episodeId, ctx, scopeLabel }) {
  const { charRowsAll, sceneRows, propRows, propTableNames, sceneTitles } = ctx
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
  const collectShot = (shot, alertShotId) => {
    for (const n of parseNames(shot.characters)) {
      const c = charRowsAll.find((x) => x.name === n)
      if (c) pushRef(c.name, c.description, 'character', c.image_url, c.name_en, c.description_en)
    }
    for (const sn of parseNames(shot.scene_assets)) {
      const s = sceneRows.find((x) => x.title === sn)
      // 跨场次场景挂载拦截（2026-09-23）：场景资产按场次拆分（同一片空间在不同场次
      // 各有一张图），单镜只准挂本镜所属场次的场景。挂错场次的场景图既撑爆单镜
      // prompt（实测一张 ≈1000 字符：summary_en+lighting_en 在 subject_definitions 与
      // retention_analysis 写两遍）又与基底图互相打架。挂错 → 记告警、不进 refs。
      if (s && s.scene_number != null && shot.scene_number != null && Number(s.scene_number) !== Number(shot.scene_number)) {
        recordAlert({
          episodeId, shotId: alertShotId, shotNumber: shot.shot_number, source: 'sceneCrossScene', level: 'warn',
          message: `镜 ${shot.shot_number} 的场景「${s.title}」属于第 ${s.scene_number} 场，本镜在第 ${shot.scene_number} 场：跨场场景挂载不进本镜出片参考（一张跨场图 ≈1000 字符且与场景基底图打架）。请在第 ${shot.scene_number} 场的场景里选，或把该空间补进本场场景表`,
          detail: JSON.stringify({ sceneId: s.id, sceneTitle: s.title, sceneSceneNumber: s.scene_number, shotSceneNumber: shot.scene_number }).slice(0, 2000),
        })
        continue
      }
      if (s && !String(s.image_url || '').trim()) {
        recordAlert({
          episodeId, shotId: alertShotId, shotNumber: shot.shot_number, source: 'sceneImage', level: 'warn',
          message: `镜 ${shot.shot_number} 的场景「${s.title}」（场景 id ${s.id}）命中场景表但尚无参考图（image_url 为空）：本${scopeLabel}出片拿不到该场景参考图，构图与光影只能靠模型自由发挥；请到设定页给该场景生成或上传参考图`,
          detail: JSON.stringify({ sceneId: s.id, sceneTitle: s.title, imageUrl: String(s.image_url || '') }).slice(0, 2000),
        })
        continue
      }
      if (s) pushRef(s.title, s.summary, 'scene', s.image_url, s.title_en, s.summary_en, s.lighting_en)
      else {
        recordAlert({
          episodeId, shotId: alertShotId, shotNumber: shot.shot_number, source: 'sceneName', level: 'warn',
          message: `镜 ${shot.shot_number} 的场景「${sn}」在场景表中无对应项（多趟 LLM 命名不一致），本${scopeLabel}无该场景参考图；请在设定页核对场景名`,
          detail: JSON.stringify({ raw: sn, candidates: sceneTitles }).slice(0, 2000),
        })
      }
    }
    for (const pn of parseNames(shot.prop_assets)) {
      const matched = resolvePropName(pn, propTableNames)
      if (!matched) {
        recordAlert({
          episodeId, shotId: alertShotId, shotNumber: shot.shot_number, source: 'propName', level: 'warn',
          message: `镜 ${shot.shot_number} 的道具「${pn}」在道具表中无对应项（多趟 LLM 命名不一致），本${scopeLabel}无该道具参考图；请在设定页核对道具名`,
          detail: JSON.stringify({ raw: pn, candidates: propTableNames }).slice(0, 2000),
        })
        continue
      }
      const p = propRows.find((x) => x.name === matched)
      if (p) pushRef(p.name, p.description, 'prop', p.image_url, p.name_en, propStateDescEn(shot, p.name, p.description_en))
    }
  }
  const trimToMax = () => {
    while (refs.length > MAX_VIDEO_REFS) {
      const dropIdx = refs.findLastIndex((r) => r.kind === 'scene' || r.kind === 'prop')
      if (dropIdx >= 0) { refs.splice(dropIdx, 1); continue }
      refs.length = MAX_VIDEO_REFS
    }
  }
  const buildAudioRefs = (speakingNames, limit = 0) => {
    const audioRefs = []
    for (const c of charRowsAll) {
      if (!speakingNames.has(c.name)) continue
      const idx = refs.findIndex((r) => r.kind === 'character' && r.label === c.name)
      if (idx >= 0 && c.audio_url) audioRefs.push({ subjectNum: idx + 1, label: c.name, audio: c.audio_url })
      if (limit && audioRefs.length >= limit) break
    }
    return audioRefs
  }
  return { refs, pushRef, collectShot, trimToMax, buildAudioRefs }
}


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
  const { shotId, aspectRatio, megapixels, duration, allowSilent, secondPass, seed, ignoreSeamAlert, ignoreAnchorPoison, forceRetry } = req.body
  if (!shotId) return res.status(400).json({ error: 'shotId 必填' })

  const shot = queryOne(
    `SELECT s.*, ss.episode_id, ss.scene_number FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id WHERE s.id = ?`,
    [shotId]
  )
  if (!shot) return res.status(404).json({ error: '镜头不存在' })

  const prevShot = queryOne(
    `SELECT s.id, s.shot_number, s.seam_check, ss.scene_number AS prev_scene FROM shots s
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

  const hasDlg = hasDialogue(shot.dialogue)
  if (!hasDlg && !allowSilent) {
    return res.status(400).json({ error: '本镜没有台词（dialogue 为空，通常是 AI 分镜生成时漏了台词）：H3 只念 <d> 标签内的台词，无台词=成片没有角色语音。请补全该镜台词或重新生成分镜；若确认为纯动作无声镜头，请传 allowSilent 再出片。' })
  }
  // 分镜图闸门已移除（2026-09-21 拍板：分镜图是可选增强项，大部分镜不生成）。
  // 无分镜图时构图由文字提示词 + 场景/角色资产图承担（与行业主流一致：场景图+文字机位）。
  // 台词闸门保留：H3 无台词 = 成片无角色语音，属硬限制，与分镜图无关。
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

  const jobKey = `video-v4:${shotId}`
  if (v4VideoJobsInflight.has(jobKey)) {
    return res.status(409).json({ error: '该镜头正在出片中，请等待完成后再试' })
  }
  v4VideoJobsInflight.set(jobKey, { shotId, startedAt: Date.now(), phase: 'submitting' })

  try {
    const ctx = loadStyleAndAssetRows(shot.episode_id)
    const isCombat = resolveIsCombat(shot)
    const combatTriggers = /倒进|倒地|瘫倒|击倒|轰然倒/.test(String(shot.description || '') + String(shot.action_note || ''))
      ? 'prfight1, prfin1'
      : 'prfight1'
    const combatStyleAnchorEn = ctx.styleLabelEn
      ? `SAME art style as the reference images and the rest of the episode (${ctx.styleLabelEn}) — never switch to any other art register or render style`
      : 'SAME art style as the reference images and the rest of the episode — never switch to any other art register or render style'
    const COMBAT_STYLE_EN = combatStyleAnchorEn
      + '; grounded fight and action choreography with real weight and inertia, every impact lands with full body weight — recoil, shockwaves, debris flying on contact, fast decisive motion with follow-through, intensity and physical danger conveyed through scale, motion and physical detail, no magic aura, no energy effects, '
      + combatTriggers
    const combatNote = isCombat ? COMBAT_STYLE_EN : ''
    const finalStyleEn = ctx.stylePromptEn
    const finalStyle = ctx.stylePrompt

    const collector = createRefCollector({ episodeId: shot.episode_id, ctx, scopeLabel: '镜' })
    collector.collectShot(shot, shotId)

    // 参考锚方案演进：
    // 2026-09-21 拍板（静态四锚）：只喂角色/场景/道具/分镜图，停用链式锚。
    // 2026-09-22 拍板（布哥）：恢复尾帧软接续——同场景上一镜尾帧作 continuity 参考图
    // （见下方注入块），解决跨镜拼接感；错误放大风险由 seam_alert 409 锁链 + 人工重生上一镜兜底。
    // 其余链式锚（尾帧目标 frame_url2 / 画风锚 style_anchor）仍维持停用。
    const frameRefUrl = String(shot.frame_url || '').trim()
    if (frameRefUrl) {
      collector.pushRef('storyboard', 'composition reference for viewpoint and subject placement', 'storyboard', frameRefUrl, '', '')
    }
    collector.trimToMax()

    const gridDlg = parseDialogue(shot.dialogue)
    const speakingNames = new Set(
      gridDlg
        .filter((d) => cleanText(d?.text || d?.line || d?.content))
        .map((d) => cleanText(d?.character || d?.speaker || d?.name))
        .filter(Boolean)
    )
    let tailAnchorUrl = ''
    let prevAnchorRow = null
    const refs = collector.refs
    // 尾帧软接续（Ref2VA 框架内）：同场景上一镜已出片时，把其尾帧作为 continuity 参考图带给本镜，
    // 激活 buildShotVideoPromptV4 里现成的 continuity 承接句与 keyframe completion 标记。
    // 必须在 buildAudioRefs 之前注入，否则 <Subject N>/<Audio N> 编号会错位。
    // prevAnchorRow 同时取上一镜成片地址：video continuation 要在其成片上抽尾部片段。
    try {
      const prevForAnchor = queryOne(
        `SELECT s.id AS prev_id, s.video_url AS prev_video, s.duration AS prev_duration FROM shots s
         JOIN storyboard_scenes ss ON ss.id = s.storyboard_scene_id
         WHERE ss.episode_id = ? AND s.id != ? AND s.start_time < ? AND ss.scene_number = ?
           AND s.video_url IS NOT NULL AND s.video_url != '' AND s.video_generated = 1
         ORDER BY s.start_time DESC, s.id DESC LIMIT 1`,
        [shot.episode_id, shotId, Number(shot.start_time) || 0, Number(shot.scene_number)]
      )
      if (prevForAnchor?.prev_id != null) {
        prevAnchorRow = prevForAnchor
        const lastFrameAbs = path.join(continuityDir, `shot_${prevForAnchor.prev_id}_last.jpg`)
        if (fs.existsSync(lastFrameAbs)) {
          // 注入 refs 的 image 带 mtime 作 cache-buster：上一镜重跑会覆盖同名尾帧文件，
          // 不带版本号会命中 RunningHub 上传缓存（TTL 20h）拿到旧图。
          // uploadsUrlToAbs 会剥 query，本地读文件不受影响。
          // tailAnchorUrl 保持干净 URL（无 query）：continuity_url 字段与 resolveLocalMedia
          // 均不剥 query，带版本号会让衔接检测报文件不存在。
          const tailAnchorBase = `/uploads/continuity/shot_${prevForAnchor.prev_id}_last.jpg`
          const tailMtime = fs.statSync(lastFrameAbs).mtimeMs
          tailAnchorUrl = tailAnchorBase
          refs.unshift({
            label: 'Previous shot final frame', desc: '', kind: 'continuity',
            image: `${tailAnchorBase}?v=${tailMtime}`,
            labelEn: 'Previous shot final frame', descEn: '', lightingEn: '',
          })
          // unshift 可能把 refs 顶到 10 个：必须按 trimToMax 语义（砍场景/道具）收敛回 9，
          // 否则 generateShotVideoV4 的 slice(0,9) 会砍掉末位的分镜图
          collector.trimToMax()
          console.log(`[/generate/video-v4] 尾帧续接：shot ${shotId} 带上 shot ${prevForAnchor.prev_id} 的尾帧锚`)
        } else {
          console.log(`[/generate/video-v4] 尾帧续接未生效：上一镜 shot ${prevForAnchor.prev_id} 尚无尾帧锚（旧版出片或抽取失败），本镜按无锚出片`)
        }
      }
    } catch (e) {
      tailAnchorUrl = ''
      console.warn(`[/generate/video-v4] 尾帧锚查询失败（降级为无锚出片）: shot ${shotId}: ${e.message}`)
    }
    // limit=3：工作流音色槽只有 audio0-2 三个，超出的部分 generateShotVideoV4 会 slice 掉，
    // 但 prompt 若已声明 <Audio 4+> 就成了"声明了却不注入"的死标签（官方 ref-en L35/L147：
    // 标签全篇指同一资产、必须有对应注入素材）。
    const audioRefs = collector.buildAudioRefs(speakingNames, 3)

    // video continuation（Ref2VA 官方续写通道，2026-09-22）：同场景上一镜的尾部片段作参考视频，
    // 走 V5 视频参考版工作流（唯一出片工作流，2026-09-23 起 h3V4/h3V4mc 已删除）。
    // 触发条件：同场景尾帧锚在场（锚查询只取同场景上一镜，跨场跳切天然不触发）
    // 且上一镜有成片可抽尾片段；尾帧图同时是 prompt 做 "<Picture N> is the final frame of <Video 1>" 绑定声明的前提。
    // 【2026-09-23 暂停】布哥拍板：暂去掉尾部视频，只留尾帧图接力下段首帧（软接续）。
    // 通道保留，config.video.h3VideoContinuation=true 显式开启才恢复（默认关）；
    // 关闭后 prompt 不声明 <Video 1>、不传 video 槽、不切 ComfyUI B 路径，尾帧图注入不受影响。
    let continuationVideoSrc = ''
    if (config.video?.h3VideoContinuation === true && tailAnchorUrl && prevAnchorRow?.prev_video && config.runninghub?.workflows?.h3V4vc) {
      try {
        const prevAbs = await resolveLocalMedia(prevAnchorRow.prev_video, prevAnchorRow.prev_id, 'vcprev')
        const tailClipAbs = await extractTailClipForContinuity(prevAnchorRow.prev_id, prevAbs)
        // 与尾帧图同款防缓存策略：上传缓存 key 含完整 source，mtime 变了就是新上传；
        // uploadBinary 读本地绝对路径时会剥掉 ?v=，不影响读文件
        continuationVideoSrc = `${tailClipAbs}?v=${fs.statSync(tailClipAbs).mtimeMs}`
        console.log(`[/generate/video-v4] video continuation：shot ${shotId} 带上 shot ${prevAnchorRow.prev_id} 的尾部片段（≤15s）`)
      } catch (e) {
        continuationVideoSrc = ''
        console.warn(`[/generate/video-v4] 尾部片段准备失败（降级为尾帧软接续）: shot ${shotId}: ${e.message}`)
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

    // continuationVideo：VC 续接时 prompt 同步声明 <Video 1>（官方 ref-en §2.3/L147：
    // 注入的参考视频必须在 subject_definitions 声明标签，不得"挂了素材 prompt 不提"）；
    // 与 generateShotVideoV4 的素材挂载两侧一致（续接镜必挂尾片段，普通镜必不声明）。
    const prompt = await buildShotVideoPromptV4(shot, { stylePrompt: finalStyle, stylePromptEn: finalStyleEn, refs, audioRefs, isCombat, speakerIds: episodeSpeakerIds(shot), retryNote, combatNote, continuationVideo: Boolean(continuationVideoSrc) })

    // 单镜 prompt 超过 H3 单条硬上限（官方 API 文档明文 7000）。超限后果为项目经验推断
    //（官方未说明超限行为：可能静默截断丢内容，也可能报错 400）——两种都不可取，硬阻断强制先精简。
    // 注意：组装层已按预算制（v4Video.js 两遍组装）把翻译扩写压进剩余空间；此处仍超限，
    // 多半是翻译器未守住预算或本镜 refs 挂载过多——优先减挂图，其次才精简正文。
    {
      const H3_LIMIT_SN = config.storyboard?.h3PromptCharLimit ?? 7000
      if (prompt.length > H3_LIMIT_SN) throw new Error(`单镜 prompt 总长 ${prompt.length} 字符，超出 H3 单条 ${H3_LIMIT_SN} 字符硬上限（官方 API 文档明文）。超限后果为项目经验推断：可能被静默截断丢内容。翻译扩写已按预算收缩仍超限：优先减少本镜挂载的场景/道具参考图（每张 ≈1000 字符），其次才精简 description/action_note/final_frame`)
    }

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
      { shotId: String(shotId), prompt, refs, audioRefs: audioRefs.map((a) => a.audio), aspectRatio, megapixels, duration: duration ?? shot.duration, combatLoraStrength: isCombat ? '0.5' : '0', seed: seed != null ? seed : undefined, ...sampling, continuationVideoSrc: continuationVideoSrc || undefined },
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

      // 链式 postHook（末帧接力/画风锚提取）已按静态四锚方案停用：
      // 出片参考改为文件协议直读上一镜尾帧（见上方注入块），不再从 continuity_url 读取；
      // 画风锚 style_anchor_url 维持停用。
      // 2026-09-22 恢复尾帧软接续后：本镜若实际使用了尾帧锚（tailAnchorUrl），回写本镜
      // continuity_url 并触发衔接检测——seam alert 409 锁链（防上一镜错误沿链放大）依赖此检测。
      try {
        if (tailAnchorUrl) {
          execute('UPDATE shots SET continuity_url = ? WHERE id = ?', [tailAnchorUrl, shotId])
        }
      } catch (e) {
        console.warn(`[/generate/video-v4] 尾帧锚回写失败（不影响成片，仅影响衔接检测）: shot ${shotId}: ${e.message}`)
      }
      const seamAnchorUrl = tailAnchorUrl || String(shot.continuity_url || '').trim()
      if (seamAnchorUrl) {
        checkSeam({ ...shot, video_url: result.videoUrl, continuity_url: seamAnchorUrl })
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
      res.json({ success: true, url: result.videoUrl, taskId: result.taskId, vcApplied: result.vcApplied === true, warning: [result.warning, wbWarning].filter(Boolean).join('；') || '', alertsCleared: clearedAlerts })
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

  const jobKey = `videoV3:${shotId}`
  if (v3VideoJobsInflight.has(jobKey)) {
    return res.status(409).json({ error: '该镜头正在出片（打斗工作流），请等待完成后再试' })
  }
  v3VideoJobsInflight.set(jobKey, { shotId, startedAt: Date.now(), phase: 'submitting' })
  const job = v3VideoJobsInflight.get(jobKey)

  try {
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
