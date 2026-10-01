import { Router } from 'express'
import { uploadsUrl, continuityTailImageUrl, continuityTailImagePath, uploadsDir, continuityDir } from '../paths.js'
import path from 'node:path'
import fs from 'node:fs'
import { query, queryOne, execute } from '../db.js'

import { chatCompletion } from '../ai/doubao.js'
import { insecureDownload, queryTaskOutput, isPlausibleMp4, resolveLocalMedia } from '../ai/runninghub.js'
import { generateShotVideoCombat } from '../ai/combatVideo.js'
import { generateShotVideoV4, buildShotVideoPromptV4, extractTailClipForContinuity, normalizeVideoParams } from '../ai/v4Video.js'
import { assertScriptConfirmed, assertNotStale } from '../ai/guards.js'
import { recordAlert, resolveAlertsByShot, buildPromptDegradeAlert } from '../ai/alerts.js'
import { enqueueSalvage } from '../salvageWorker.js'
import { buildGlobalSpeakerMap } from '../ai/h3PromptTranslator.js'
import { classifyShotCombat } from '../ai/shotClassifier.js'
import { config } from '../config.js'
import { resolveWorkflowId } from '../modelConfig.js'
import { clean as cleanText, pickInjectableEnglish } from '../ai/shared.js'
import { parseDialogue } from '../ai/dialogue.js'
import { mergeMasterIntoEpisodeCharacters } from '../characterLibrary.js'
import { TYPE_PROP } from '../ai/assetTypes.js'
import { resolveState } from '../ai/assetState.js'
import { resolvePropName } from '../ai/propNameMatch.js'
import { pickEnglish as pickEnglishGuard, stripResidualCjk as stripCjkGuard } from '../ai/v4Video.js'

import { getStoryboardProvider } from '../storyboard/providers/index.js'
import { isHardCutTransition, shouldCarryContinuityToNextShot } from '../ai/postHooks.js'
import { shotEnglishComplete, shotEnglishStale, compileShotEnglish, translateFromColumns } from '../ai/shotEnglish.js'
import { buildPromptSnapshotInput, findPromptSnapshot, savePromptSnapshot } from '../ai/promptSnapshots.js'
import { normalizeReferenceSet } from '../ai/referenceSet.js'
import { validateStoryboardImport } from '../ai/storyboardContractValidator.js'
import { createVideoJob, listJobsForEpisode, registerVideoJobExecutor } from '../jobs/videoJobRunner.js'
import { VIDEO_ENGINE_GENERAL, VIDEO_ENGINE_COMBAT } from '../ai/videoEngines.js'
const router = Router()

// 道具「本镜状态」拆分（官方 ref-en.txt 口径）：基础外观进 descEn（subject_definitions
// 压缩用），状态变化进 stateEn（retention_analysis 用，标 partially_preserved——官方 L166
// "some defined characteristics are changed"）。旧实现把状态拼在 descEn 尾部
//（`${base}; ${state}`），subject_definitions 改走「main features」压缩后状态句会被
// 裁掉，且镜头级状态变化本就不属于资产定义。
function propStateDescEn(shot, propName, baseDescEn) {
  const base = String(baseDescEn || '').trim()
  if (!config.assetState?.enabled) return { descEn: base, stateEn: '' }
  let map = null
  try {
    map = shot && shot.asset_states_json ? JSON.parse(shot.asset_states_json) : null
  } catch { map = null }
  const entry = (map && typeof map === 'object' && map.prop) ? map.prop[propName] : null
  if (!entry) return { descEn: base, stateEn: '' }
  try {
    const rows = query(
      `SELECT state_key, label_zh, description, description_en, image_url, is_default
       FROM asset_states WHERE asset_type = ? AND asset_key = ?`,
      [TYPE_PROP, propName]
    )
    if (!rows.length) return { descEn: base, stateEn: '' }
    const st = resolveState(entry, rows)
    if (!st.resolved) return { descEn: base, stateEn: '' }
    const stateEn = pickEnglishGuard(st.descriptionEn) || stripCjkGuard(st.descriptionEn)
    if (!stateEn) return { descEn: base, stateEn: '' }
    return { descEn: base, stateEn }
  } catch (e) {
    console.warn(`[generate-video] 道具状态解析失败（降级为无状态）: ${e.message}`)
    return { descEn: base, stateEn: '' }
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
  const missing = []
  const pushRef = (label, desc, kind, image, labelEn, descEn, lightingEn, stateEn) => {
    if (!String(image || '').trim()) {
      missing.push({ label: String(label || ''), kind })
      return
    }
    if (refs.some((r) => r.image === image)) return
    refs.push({
      label: String(label || ''), desc: String(desc || ''), kind, image,
      labelEn: String(labelEn || ''), descEn: String(descEn || ''),
      lightingEn: String(lightingEn || ''),
      stateEn: String(stateEn || ''),
    })
  }
  const collectShot = (shot, alertShotId) => {
    for (const n of parseNames(shot.characters)) {
      const c = charRowsAll.find((x) => x.name === n)
      if (c) pushRef(c.name, c.description, 'character', c.image_url, c.name_en, c.description_en)
      else missing.push({ label: n, kind: 'character' })
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
        pushRef(s.title, s.summary, 'scene', s.image_url, s.title_en, s.summary_en, s.lighting_en)
        continue
      }
      if (s) pushRef(s.title, s.summary, 'scene', s.image_url, s.title_en, s.summary_en, s.lighting_en)
      else {
        missing.push({ label: sn, kind: 'scene' })
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
        missing.push({ label: pn, kind: 'prop' })
        recordAlert({
          episodeId, shotId: alertShotId, shotNumber: shot.shot_number, source: 'propName', level: 'warn',
          message: `镜 ${shot.shot_number} 的道具「${pn}」在道具表中无对应项（多趟 LLM 命名不一致），本${scopeLabel}无该道具参考图；请在设定页核对道具名`,
          detail: JSON.stringify({ raw: pn, candidates: propTableNames }).slice(0, 2000),
        })
        continue
      }
      const p = propRows.find((x) => x.name === matched)
      if (p) {
        const st = propStateDescEn(shot, p.name, p.description_en)
        pushRef(p.name, p.description, 'prop', p.image_url, p.name_en, st.descEn, '', st.stateEn)
      }
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
  return { refs, missing, pushRef, collectShot, trimToMax, buildAudioRefs }
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

function loadShot(shotId) {
  return queryOne(
    `SELECT s.*, ss.episode_id, ss.scene_number FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id WHERE s.id = ?`,
    [shotId]
  )
}

// 提交前校验（轻量、纯库内查询）：分镜容器契约 + 重试保护 + 参考图预检。
// 任何一项不过都快速 4xx 失败，不建任务单不排队。
// 语义契约五件套校验已退役（2026-10-01）：英文版是分镜数据列（同资产 nameEn 模型），
// 这里只计算 englishPending 供执行器自愈——不齐不在此硬拒，任务内会自动补齐再出片。
function validateVideoSubmission(shot, { forceRetry } = {}) {
  // 查"过期"（stale）而非只查"缺失"（complete）：编辑后旧英文虽在但已不对应新中文，
  // 出片前必须重翻同步——这是"所见即所得"的硬保证，代价是编辑后首次出片多一次翻译。
  const englishPending = shotEnglishStale(shot)

  const contractRows = query(
    `SELECT s.*, ss.scene_number, ss.title AS scene_title
     FROM shots s JOIN storyboard_scenes ss ON ss.id = s.storyboard_scene_id
     WHERE ss.episode_id = ? ORDER BY ss.scene_number, s.start_time, s.id`,
    [shot.episode_id]
  )
  // 已定稿/导入的分镜不得再经过生成期美学与连续性规则拦截；这里只确认
  // 数据容器可被 provider 读取。H3 的实际字段限制由 provider/API 返回。
  const contractValidation = validateStoryboardImport({ scenes: [{ shots: contractRows }] }, {
    characters: query('SELECT name FROM characters WHERE episode_id = ?', [shot.episode_id]),
    scenes: query('SELECT title, scene_number AS sceneNumber FROM scenes WHERE episode_id = ?', [shot.episode_id]),
    props: query('SELECT name FROM props WHERE episode_id = ?', [shot.episode_id]),
  })
  if (!contractValidation.ok) {
    return { ok: false, status: 422, error: `分镜未通过 MiniMax H3 Ref2VA 契约校验：${formatStoryboardValidationError(contractValidation)}` }
  }

  const priorRetries = Number(shot.retry_count) || 0
  if (priorRetries >= 2 && String(shot.retry_feedback || '').trim() && !forceRetry) {
    return { ok: false, status: 409, error: `镜 ${shot.shot_number} 已按验收反馈自动回灌重出 ${priorRetries} 次仍未过审，且当前又有新的失败反馈：同样的修正两轮没生效，继续同路径重出大概率重复失败。请先人工看片定位根因（画风/音色/构图基线问题不是回灌能修的）；确认仍要重试，请传 forceRetry: true。` }
  }

  try {
    assertScriptConfirmed(shot.episode_id)
    assertNotStale(shot.episode_id, 'storyboard')
  } catch (err) {
    return { ok: false, status: err.status || 400, error: err.message }
  }

  const ctx = loadStyleAndAssetRows(shot.episode_id)
  const collector = createRefCollector({ episodeId: shot.episode_id, ctx, scopeLabel: '镜' })
  collector.collectShot(shot, shot.id)
  if (collector.missing.length) {
    const labels = collector.missing.map((item) => `${item.kind}:${item.label}`).join('、')
    return { ok: false, status: 422, error: `镜 ${shot.shot_number} 引用的资产缺少有效参考图，H3 Ref2VA 出片已阻断：${labels}` }
  }
  return { ok: true, englishPending }
}

function formatStoryboardValidationError(v) {
  return (v.errors || []).map((e) => e.message).join('；')
}

// ── V4 执行器：任务化后的出片主体（原 /video-v4 handler 的执行部分） ──
async function executeVideoV4Job(job, { updateProgress }) {
  const shotId = job.shot_id
  const shot = loadShot(shotId)
  if (!shot) return { success: false, error: '镜头不存在' }
  const params = JSON.parse(job.params_json || '{}')
  const { aspectRatio, megapixels, duration, secondPass, seed, forceRetry } = params

  const check = validateVideoSubmission(shot, { forceRetry })
  if (!check.ok) return { success: false, error: check.error }

  // 英文版自愈（2026-10-01）：分镜的英文列缺失时（历史数据/编辑后未同步/翻译曾降级），
  // 任务内自动补齐再出片——用户不需要知道"英文版"的存在，C 端零概念。
  // 失败（LLM 不可用等）走任务失败+重试，人话报错，不再是一堵 422 死墙。
  if (check.englishPending) {
    updateProgress({ phase: `正在准备镜 ${shot.shot_number || ''} 的出片数据...` })
    const compiled = await compileShotEnglish(shot)
    if (!compiled.ok) {
      return { success: false, error: `镜 ${shot.shot_number || ''}：${compiled.reason}` }
    }
    Object.assign(shot, compiled.fields)
  }

  try {
    const ctx = loadStyleAndAssetRows(shot.episode_id)
    const isCombat = resolveIsCombat(shot)
    // 打斗 LoRA 触发词与"击倒"判定词表属【工作流契约】，由 config 提供、env 可覆盖，不在路由里写死。
    const knockdownText = String(shot.description || '') + String(shot.action_note || '')
    const isKnockdown = (config.video?.combatKnockdownWords || []).some((w) => knockdownText.includes(w))
    const combatTriggers = isKnockdown
      ? (config.video?.combatLoraTriggerKnockdown || '')
      : (config.video?.combatLoraTrigger || '')
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

    // 参考图只取定稿分镜声明的本镜资产。平台不再把上一镜角色补进本镜，
    // 否则会把“重新构图”的近景/插入镜改写成上一镜的构图。
    collector.collectShot(shot, shotId)

    // 参考锚方案演进：
    // 2026-09-21 拍板（静态四锚）：只喂角色/场景/道具/分镜图，停用链式锚。
    // 尾帧软接续：只有分镜明确声明连续承接时才接力；空值不由平台解释。
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
    // 分镜师声明的硬切（transition_in）："切"本身就是过渡，不挂尾帧起始锚。
    // 留空不代表连续承接。
    const transitionIn = String(shot.transition_in || '').trim().toLowerCase()
    const isHardCutIn = isHardCutTransition(transitionIn)
    // 尾帧软接续（Ref2VA 框架内）：同场景上一镜已出片时，把其尾帧作为 continuity 参考图带给本镜，
    // 激活 buildShotVideoPromptV4 里现成的 continuity 承接句与 keyframe completion 标记。
    // 必须在 buildAudioRefs 之前注入，否则 <Subject N>/<Audio N> 编号会错位。
    // prevAnchorRow 同时取上一镜成片地址：video continuation 要在其成片上抽尾部片段。
    try {
      if (isHardCutIn) {
        // 硬切镜：清掉历史遗留的尾帧锚记录，避免下游误用旧锚。
        if (String(shot.continuity_url || '').trim()) {
          execute('UPDATE shots SET continuity_url = ? WHERE id = ?', ['', shotId])
          shot.continuity_url = ''
        }
        console.log(`[/generate/video-v4] 分镜声明硬切（transition_in=${transitionIn}）：shot ${shotId} 跳过尾帧锚，本镜自主构图`)
      } else {
      const prevForAnchor = queryOne(
        `SELECT s.id AS prev_id, s.shot_number AS prev_number, s.video_url AS prev_video, s.duration AS prev_duration, s.video_generated AS prev_generated, ss.scene_number AS prev_scene FROM shots s
         JOIN storyboard_scenes ss ON ss.id = s.storyboard_scene_id
         WHERE ss.episode_id = ? AND s.id != ? AND s.start_time < ?
         ORDER BY s.start_time DESC, s.id DESC LIMIT 1`,
        [shot.episode_id, shotId, Number(shot.start_time) || 0]
      )
      const carryFromPrev = shouldCarryContinuityToNextShot(shot)
      // 上一镜是否具备可接力的成片 + 尾帧锚（时间轴上一镜不分是否已出片都要查出来，
      // 否则乱序/并行出片时 prevForAnchor 为空，会静默退化成无锚自主构图，链从这里断）。
      const prevAnchorReady = prevForAnchor?.prev_id != null
        && prevForAnchor.prev_generated === 1
        && String(prevForAnchor.prev_video || '').trim() !== ''
        && fs.existsSync(continuityTailImagePath(prevForAnchor.prev_id))
      // 软接续降级说明：本镜声明了连续承接但上一镜还没有成片/尾帧锚（乱序/并行出片、
      // 旧版出片未抽尾帧）时，不再锁链，按无锚自主构图出片；接力锚文件是上一镜出片时
      // 顺手抽取的，出完即接力，乱序产生的窗口期很短。
      if (!carryFromPrev) {
        if (String(shot.continuity_url || '').trim()) {
          execute('UPDATE shots SET continuity_url = ?, seam_check = NULL WHERE id = ?', ['', shotId])
          shot.continuity_url = ''
        }
        console.log(`[/generate/video-v4] 分镜未声明连续承接（transition_in=${transitionIn || 'empty'}）：shot ${shotId} 按本镜构图出片`)
      } else if (prevForAnchor?.prev_id != null && prevAnchorReady) {
        prevAnchorRow = prevForAnchor
        const lastFrameAbs = continuityTailImagePath(prevForAnchor.prev_id)
        // 注入 refs 的 image 带 mtime 作 cache-buster：上一镜重跑会覆盖同名尾帧文件，
        // 不带版本号会命中 RunningHub 上传缓存（TTL 20h）拿到旧图。
        // uploadsUrlToAbs 会剥 query，本地读文件不受影响。
        // tailAnchorUrl 保持干净 URL（无 query）：continuity_url 字段与 resolveLocalMedia
        // 均不剥 query，带版本号会让衔接检测报文件不存在。
        const tailAnchorBase = continuityTailImageUrl(prevForAnchor.prev_id)
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
      } else if (prevForAnchor?.prev_id != null) {
        console.log(`[/generate/video-v4] 上一镜 ${prevForAnchor.prev_number} 缺成片/尾帧锚：shot ${shotId} 按无锚出片`)
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
    // 走 V5 视频参考版工作流。触发条件：同场景尾帧锚在场且上一镜有成片可抽尾片段。
    // 【2026-09-23 暂停】布哥拍板：暂去掉尾部视频，只留尾帧图接力下段首帧（软接续）。
    // 通道保留，config.video.h3VideoContinuation=true 显式开启才恢复（默认关）。
    let continuationVideoSrc = ''
    if (config.video?.h3VideoContinuation === true && tailAnchorUrl && prevAnchorRow?.prev_video && resolveWorkflowId('h3V4vc')) {
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
          updateProgress({ phase: '翻译验收反馈...' })
          const en = await chatCompletion([
            { role: 'system', content: 'Translate the following Chinese film-direction correction notes into concise English imperatives for an AI video generation model (e.g. "the character turns and walks away; the door closes behind them"). Output ONLY the English sentences joined by semicolons, no preamble.' },
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
    // promptDegrades：组装器的降级上报（LLM 无产出时叙事靠 IMD M2 兜底 / 彻底缺失）。
    // 组装器是纯函数不写库，降级事实在此收集、在「重生成功清告警」之后落 system_alert——
    // 否则会被 resolveAlertsByShot 清掉，降级就变成用户看不见的静默行为。
    const WIDE_SHOT_RE = /^(大全景|全景|大远景|远景|全身|广角)$/
    const needSecondPass =
      secondPass === 'on' ? true
      : secondPass === 'off' ? false
      : (isCombat || WIDE_SHOT_RE.test(String(shot.shot_type || '')) || audioRefs.length > 0)

    const promptDegrades = []
    updateProgress({ phase: '编译出片提示词...' })
    // translate 注入读列（2026-10-01）：英文版已在分镜数据列就绪（上方自愈兜底），
    // 组装不再现场调 LLM 翻译——同一镜的英文源唯一，杜绝"契约验一份、出片用另一份"的双份翻译。
    const prompt = await buildShotVideoPromptV4(shot, { stylePrompt: finalStyle, stylePromptEn: finalStyleEn, refs, audioRefs, isCombat, speakerIds: episodeSpeakerIds(shot), retryNote, combatNote, continuationVideo: Boolean(continuationVideoSrc), translate: (translationShot) => translateFromColumns(translationShot), onDegrade: (info) => promptDegrades.push(info) })

    // 单镜 prompt 超过 H3 单条硬上限（官方 API 文档明文 7000）。超限后果为项目经验推断
    //（官方未说明超限行为：可能静默截断丢内容，也可能报错 400）——两种都不可取，硬阻断强制先精简。
    {
      const H3_LIMIT_SN = getStoryboardProvider('h3').capabilities.promptCharLimit
      if (prompt.length > H3_LIMIT_SN) throw new Error(`单镜 prompt 总长 ${prompt.length} 字符，超出 H3 单条 ${H3_LIMIT_SN} 字符硬上限（官方 API 文档明文）。超限后果为项目经验推断：可能被静默截断丢内容。翻译扩写已按预算收缩仍超限：优先减少本镜挂载的场景/道具参考图（每张 ≈1000 字符），其次才精简 description/action_note/final_frame`)
    }

    const { aspectRatio: normalizedAspectRatio, megapixels: normalizedMegapixels, duration: normalizedDuration } = normalizeVideoParams({ aspectRatio, megapixels, duration: duration ?? shot.duration })
    const referenceSet = normalizeReferenceSet({
      shotId,
      episodeId: shot.episode_id,
      images: refs,
      audios: audioRefs,
      videos: continuationVideoSrc ? [{ kind: 'continuity', url: continuationVideoSrc, previousShotId: prevAnchorRow?.prev_id ?? null }] : [],
      anchor: {
        baselineUrl: '',
        layoutUrl: '',
        degraded: false,
      },
      uploadsDir,
    })
    const normalizedParams = {
      aspectRatio: normalizedAspectRatio,
      megapixels: normalizedMegapixels,
      duration: normalizedDuration,
      secondPass: needSecondPass,
      seed: seed != null ? seed : null,
      refImageSize: 'match',
    }
    const snapshotInput = buildPromptSnapshotInput({
      shot,
      semantic: semanticCheck.semantics,
      referenceSet,
      providerId: getStoryboardProvider('h3').id,
      workflowId: resolveWorkflowId('h3V4vc') || '',
      templateVersion: 'h3-v4-video-prompt-1',
      generationParams: normalizedParams,
      retryFeedback: rawFeedback,
    })
    const existingSnapshot = findPromptSnapshot(shotId, snapshotInput.inputFingerprint)
    const promptSnapshot = existingSnapshot || savePromptSnapshot({
      episodeId: shot.episode_id,
      shotId,
      shotVersion: shot.version,
      input: snapshotInput,
      prompt,
    })
    const effectivePrompt = String(promptSnapshot.compiled_prompt || prompt)

    {
      const H3_LIMIT_SN = getStoryboardProvider('h3').capabilities.promptCharLimit
      if (effectivePrompt.length > H3_LIMIT_SN) throw new Error(`快照 prompt 总长 ${effectivePrompt.length} 字符，超过 H3 单条 ${H3_LIMIT_SN} 字符限制`)
    }

    execute(
      'UPDATE shots SET prompt_provider_id = ?, compiled_prompt = ?, prompt_compiled_at = CURRENT_TIMESTAMP WHERE id = ?',
      [getStoryboardProvider('h3').id, effectivePrompt, shotId],
    )

    // 采样参数属工作流契约，由 config.video.sampling 提供（env 可覆盖），不在路由里写死。
    const sp = config.video?.sampling || {}
    const firstMegapixels = megapixels || config.video?.defaultMegapixels || '0.5'
    const sampling = needSecondPass
      ? {
        firstPassSteps: sp.firstPassSteps ?? 6,
        firstPassDenoise: sp.firstPassDenoise ?? 1,
        secondPassSteps: sp.secondPassSteps ?? 4,
        secondPassDenoise: sp.secondPassDenoise ?? 0.4,
        upscaleMegapixels: sp.upscaleMegapixels ?? 1,
      }
      : {
        firstPassSteps: sp.firstPassSteps ?? 6,
        firstPassDenoise: sp.firstPassDenoise ?? 1,
        secondPassSteps: sp.tailSecondPassSteps ?? 1,
        secondPassDenoise: sp.tailSecondPassDenoise ?? 0.01,
        upscaleMegapixels: firstMegapixels,
      }

    updateProgress({ phase: '上传素材并提交云端...' })
    const result = await generateShotVideoV4(
      { shotId: String(shotId), prompt: effectivePrompt, refs, audioRefs: audioRefs.map((a) => a.audio), aspectRatio: normalizedAspectRatio, megapixels: normalizedMegapixels, duration: normalizedDuration, refImageSize: config.video?.refImageSize || 'match',
        combatLoraStrength: isCombat ? String(config.video?.combatLoraStrength ?? '0.5') : '0', seed: seed != null ? seed : undefined, ...sampling, continuationVideoSrc: continuationVideoSrc || undefined },
      { onProgress: (phase, info) => {
        updateProgress({ phase })
        if (info?.taskId) updateProgress({ providerTaskId: String(info.taskId) })
        console.log(`[/generate/video-v4] shot ${shotId} ${phase}${info?.message ? ': ' + info.message : ''}`)
      },
        onTaskId: (taskId) => updateProgress({ providerTaskId: String(taskId) }) }
    )

    if (!result.success || !result.videoUrl) {
      return { success: false, error: result.error || '出片失败', taskId: result.taskId, phase: '云端出片失败' }
    }

    const final = await finalizeV4Video({
      shot, shotId, episodeId: shot.episode_id,
      cloudUrl: result.videoUrl, taskId: result.taskId,
      promptDegrades, tailAnchorUrl, rawFeedback, warning: result.warning,
    })
    return { success: final.success, url: final.url, taskId: result.taskId, warning: final.warning, error: final.error }
  } catch (err) {
    console.error('[/generate/video-v4] error', { shotId, error: err.message })
    return { success: false, error: err.message }
  }
}

// 成片落地 + 回写：V4 执行器与「重启自愈凭云端 taskId 找回」共用此函数。
// cloudUrl 非 /uploads 时下载本地化（含备用节点与 salvage 兜底），然后回写 shots。
async function finalizeV4Video({ shot, shotId, episodeId, cloudUrl, taskId, promptDegrades = [], tailAnchorUrl = '', rawFeedback = '', warning: upstreamWarning = '' } = {}) {
  let resultUrl = cloudUrl
  let warning = upstreamWarning || ''
  if (!/^\/uploads\//i.test(resultUrl)) {
    const localName = `shot_${shotId}_v4_${Date.now()}.mp4`
    const localPath = path.join(uploadsDir, localName)
    let localized = false, lastErr = null
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const buf = await insecureDownload(resultUrl)
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
      resultUrl = `${uploadsUrl(localName)}`
    } else if (taskId) {
      try {
        const q = await queryTaskOutput(taskId)
        const altUrls = (Array.isArray(q?.allResults) ? q.allResults : [])
          .map((r) => String(r?.url || '')).filter(Boolean)
          .filter((u) => u !== resultUrl)
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
        resultUrl = `${uploadsUrl(localName)}`
      } else {
        recordAlert({ episodeId, shotId, shotNumber: shot.shot_number, source: 'writeback', level: 'error',
          message: `镜 ${shot.shot_number} 成片本地化失败（3 次重试 + 备用节点全灭）：video_url 仍是云端 URL——已登记打捞队列，后台每 5 分钟自动重捞（50 分钟窗口）`,
          detail: lastErr })
        enqueueSalvage({ shotId, shotNumber: shot.shot_number, episodeId, taskId, url: resultUrl })
      }
    } else {
      recordAlert({ episodeId, shotId, shotNumber: shot.shot_number, source: 'writeback', level: 'error',
        message: `镜 ${shot.shot_number} 成片本地化失败（3 次重试耗尽）：video_url 仍是云端 URL——已登记打捞队列，后台每 5 分钟自动重捞（50 分钟窗口）`,
        detail: lastErr })
      enqueueSalvage({ shotId, shotNumber: shot.shot_number, episodeId, taskId: null, url: resultUrl })
    }
  }
  let wbWarning = ''
  let wbErrCaught = null
  try {
    const wbResult = execute('UPDATE shots SET video_url = ?, video_generated = 1, retry_feedback = \'\', shot_review = NULL, retry_count = COALESCE(retry_count, 0) + CASE WHEN ? != \'\' THEN 1 ELSE 0 END WHERE id = ?', [resultUrl, rawFeedback, shotId])
    if (wbResult.changes === 0) {
      // 镜头在出片期间被删除/重建（清空或覆盖保存分镜）：成片文件已落盘但无处回写，
      // 保留文件并提示，避免用户在 uploads 里找不到来源。
      console.warn(`[/generate/video-v4] shot ${shotId} 已被删除（分镜被清空/覆盖），成片 ${resultUrl} 未回写，文件保留在 uploads 目录`)
    }
  } catch (wbErr) {
    wbErrCaught = wbErr
    wbWarning = `回写失败：成片已生成（地址：${resultUrl}）+ 数据库回写失败，请勿重复出片，需人工排查`
  }
  console.log('[/generate/video-v4] saved video_url for shot', shotId, resultUrl)
  const clearedAlerts = resolveAlertsByShot(shotId, 'regen')
  if (clearedAlerts) console.log(`[/generate/video-v4] shot ${shotId} 重生成功，清掉 ${clearedAlerts} 条旧告警`)
  // 降级告警必须在 clear 之后落：它描述的是「本次」成片由降级 prompt 产出，
  // 属于本镜的既有事实（重生成功不代表 prompt 没问题），不能随旧告警一起被清掉。
  const degradeAlert = buildPromptDegradeAlert(promptDegrades, { episodeId, shotId, shotNumber: shot.shot_number })
  if (degradeAlert) {
    recordAlert(degradeAlert)
    console.warn(`[/generate/video-v4] shot ${shotId} 出片落库但 prompt 降级，已记 warn 告警（前端告警面板可见）：${degradeAlert.message}`)
  }
  if (wbWarning) {
    recordAlert({ episodeId, shotId, shotNumber: shot.shot_number, source: 'writeback', level: 'error',
      message: `镜 ${shot.shot_number} ${wbWarning}`,
      detail: wbErrCaught })
  }
  // 尾帧软接续：本镜实际使用了尾帧锚（tailAnchorUrl）时回写 continuity_url，
  // 仅作本镜接力事实的记录，供后续排查与可能的续写通道使用。
  try {
    if (tailAnchorUrl) {
      execute('UPDATE shots SET continuity_url = ? WHERE id = ?', [tailAnchorUrl, shotId])
    }
  } catch (e) {
    console.warn(`[/generate/video-v4] 尾帧锚回写失败（不影响成片）: shot ${shotId}: ${e.message}`)
  }
  if (wbWarning) return { success: true, url: resultUrl, warning: [warning, wbWarning].filter(Boolean).join('；') }
  return { success: true, url: resultUrl, warning }
}

// ── V3 打斗执行器 ──
async function executeVideoV3Job(job, { updateProgress }) {
  const shotId = job.shot_id
  const shot = queryOne(
    `SELECT s.*, ss.episode_id
     FROM shots s JOIN storyboard_scenes ss ON ss.id = s.storyboard_scene_id WHERE s.id = ?`,
    [shotId]
  )
  if (!shot) return { success: false, error: '镜头不存在' }
  try {
    assertScriptConfirmed(shot.episode_id)
    assertNotStale(shot.episode_id, 'storyboard')
  } catch (err) {
    return { success: false, error: err.message }
  }
  const params = JSON.parse(job.params_json || '{}')
  const { idea, bgImage = '', aspectRatio, megapixels, duration } = params

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
      return { success: false, error: '打斗出片提示词为空：镜头没有画面描述，且未传 idea' }
    }

    if (!finalIdea.includes('画面文字')) {
      finalIdea = `${finalIdea}。画面中不得出现任何文字、字幕、水印或标志。`
    }

    const requestedDuration = Number(duration ?? shot.duration) || 6

    updateProgress({ phase: '提交打斗工作流...' })
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
          updateProgress({ phase })
          if (info?.taskId) updateProgress({ providerTaskId: String(info.taskId) })
          console.log(
            `[/generate/video-v3] shot ${shotId} ${phase}${info?.taskId ? ' taskId=' + info.taskId : ''}${info?.message ? ': ' + info.message : ''}`
          )
        },
        onTaskId: (taskId) => updateProgress({ providerTaskId: String(taskId) }),
      }
    )

    if (result.success && result.videoUrl) {
      execute('UPDATE shots SET video_url = ?, video_generated = 1 WHERE id = ?', [
        result.videoUrl,
        shotId,
      ])
      console.log('[/generate/video-v3] saved video_url for shot', shotId, result.videoUrl)
      return { success: true, url: result.videoUrl, taskId: result.taskId, warning: result.warning || '' }
    }
    return { success: false, error: result.error || '出片失败', taskId: result.taskId }
  } catch (err) {
    console.error('[/generate/video-v3] error', { shotId, error: err.message })
    return { success: false, error: err.message }
  }
}

// ── 任务化路由：提交即返回 jobId，进度走 GET /video-jobs ──
// 出片时长上下限由后端配置下发：前端不再写死 3/5/15，换环境只改 SHOT_DURATION_*
router.get('/video/duration-limits', (req, res) => {
  res.json({
    min: config.storyboard?.durationMin ?? 4,
    max: config.storyboard?.durationMax ?? 15,
    default: config.storyboard?.defaultDuration ?? 8,
  })
})

router.post('/video-v4', (req, res) => {
  const { shotId, aspectRatio, megapixels, duration, secondPass, seed, forceRetry } = req.body
  if (!shotId) return res.status(400).json({ error: 'shotId 必填' })
  const shot = loadShot(shotId)
  if (!shot) return res.status(404).json({ error: '镜头不存在' })

  const check = validateVideoSubmission(shot, { forceRetry })
  if (!check.ok) return res.status(check.status).json({ error: check.error })

  const { job, duplicated } = createVideoJob({
    episodeId: shot.episode_id,
    shotId: shot.id,
    engine: VIDEO_ENGINE_GENERAL,
    params: { aspectRatio, megapixels, duration, secondPass, seed, forceRetry },
  })
  res.status(duplicated ? 200 : 201).json({
    success: true,
    jobId: job.id,
    status: job.status,
    duplicated,
  })
})

router.post('/video-v3', (req, res) => {
  const { shotId, idea, bgImage = '', aspectRatio, megapixels, duration } = req.body
  if (!shotId) return res.status(400).json({ error: 'shotId 必填' })
  const shot = queryOne(
    `SELECT s.*, ss.episode_id
     FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id WHERE s.id = ?`,
    [shotId]
  )
  if (!shot) return res.status(404).json({ error: '镜头不存在' })
  try {
    assertScriptConfirmed(shot.episode_id)
    assertNotStale(shot.episode_id, 'storyboard')
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message })
  }

  const { job, duplicated } = createVideoJob({
    episodeId: shot.episode_id,
    shotId: shot.id,
    engine: VIDEO_ENGINE_COMBAT,
    params: { idea, bgImage, aspectRatio, megapixels, duration },
  })
  res.status(duplicated ? 200 : 201).json({
    success: true,
    jobId: job.id,
    status: job.status,
    duplicated,
  })
})

router.get('/video-jobs', (req, res) => {
  const episodeId = Number(req.query.episodeId)
  if (!episodeId) return res.status(400).json({ error: 'episodeId 必填' })
  const activeOnly = req.query.activeOnly === '1' || req.query.activeOnly === 'true'
  res.json({ jobs: listJobsForEpisode(episodeId, { activeOnly }) })
})

// ── 执行器注册（服务启动即生效） ──
registerVideoJobExecutor(VIDEO_ENGINE_GENERAL, executeVideoV4Job)
registerVideoJobExecutor(`${VIDEO_ENGINE_GENERAL}:finalize`, async (job, { localUrl }) => {
  const shot = loadShot(job.shot_id)
  if (!shot) return { success: false }
  return finalizeV4Video({ shot, shotId: job.shot_id, episodeId: job.episode_id, cloudUrl: localUrl })
})
registerVideoJobExecutor(VIDEO_ENGINE_COMBAT, executeVideoV3Job)

export default router
