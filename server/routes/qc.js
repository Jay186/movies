
import { Router } from 'express'
import { query, queryOne, execute, transaction } from '../db.js'
import { config } from '../config.js'
import {
  validateStoryboard,
  rowToShotForQc,
  extractScreenSides,
  hasExplicitReposition,
  buildAliasMap,
} from '../ai/storyboardValidator.js'
import {
  repairShotAirlock,
  repairShotAxis,
  enrichShotIntegrated,
  extractFinalFrameFromIntegrated,
} from '../ai/doubao.js'
import { summarizeQc, qcMeta, isRegisteredQcCode, QC_ACTION } from '../ai/qcCodes.js'
import { checkContinuity } from '../ai/continuityGuard.js'
import { splitScriptScenes } from '../ai/scriptFormat.js'
import { mergeMasterIntoEpisodeCharacters } from '../characterLibrary.js'

const router = Router()

function loadEpisodeShots(episodeId) {
  const sceneRows = query(
    'SELECT id, scene_number, title FROM storyboard_scenes WHERE episode_id = ? ORDER BY scene_number',
    [episodeId]
  )
  const scenes = []
  const shotIndex = new Map() 
  for (let i = 0; i < sceneRows.length; i++) {
    const rows = query(
      'SELECT * FROM shots WHERE storyboard_scene_id = ? ORDER BY start_time, id',
      [sceneRows[i].id]
    )
    const shots = rows.map((r, idx) => {
      const s = rowToShotForQc(r)
      if (!s.shotNumber) s.shotNumber = `${sceneRows[i].scene_number}-${idx + 1}`
      shotIndex.set(r.id, { sceneIdx: i, shot: s, raw: r })
      return s
    })
    scenes.push({ sceneNumber: sceneRows[i].scene_number, title: sceneRows[i].title, shots })
  }
  return { scenes, sceneRows, shotIndex }
}

function loadAssetNames(episodeId) {
  const episode = queryOne('SELECT project_id FROM episodes WHERE id = ?', [episodeId])
  const characters = mergeMasterIntoEpisodeCharacters(
    query('SELECT name, description, image_url, project_character_id FROM characters WHERE episode_id = ?', [episodeId])
  )
  return {
    characters,
    scenes: query('SELECT title AS name, title, summary AS description, image_url FROM scenes WHERE episode_id = ?', [episodeId]),
    props: query('SELECT name, description, image_url FROM props WHERE episode_id = ?', [episodeId]),
    projectStyleText: (() => {
      const p = episode ? queryOne('SELECT art_style FROM projects WHERE id = ?', [episode.project_id]) : null
      return p?.art_style || ''
    })(),
    projectId: episode?.project_id ?? null,
  }
}

function loadScriptSceneTexts(episodeId) {
  const ep = queryOne('SELECT script_content FROM episodes WHERE id = ?', [episodeId])
  const script = String(ep?.script_content || '')
  if (!script.trim()) return []
  return splitScriptScenes(script)
}

function collectContinuityWarnings(episodeId) {
  try {
    const scenes = loadScriptSceneTexts(episodeId)
    if (scenes.length < 2) return { warnings: [], scriptSceneCount: scenes.length }
    const { warnings } = checkContinuity({ scenes }, { only: ['env', 'handoff', 'form'] })
    return {
      scriptSceneCount: scenes.length,
      warnings: warnings.map((w) => ({
        code: w.code,
        shot: `场次${w.scene}`,
        message: w.message,
      })),
    }
  } catch (e) {
    console.warn('[qc] 跨场事理检查失败（已跳过）:', e.message)
    return { warnings: [], scriptSceneCount: 0 }
  }
}

function ensureIgnoreTable() {
  try {
    execute(`CREATE TABLE IF NOT EXISTS qc_ignores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      episode_id INTEGER NOT NULL,
      code TEXT NOT NULL,
      shot_number TEXT NOT NULL DEFAULT '',
      shot_id INTEGER,
      reason TEXT DEFAULT '',
      UNIQUE(episode_id, code, shot_number)
    )`)
    try { execute('ALTER TABLE qc_ignores ADD COLUMN shot_id INTEGER') } catch {  }
  } catch (e) {
    console.warn('[qc] 建 qc_ignores 表失败（忽略功能降级）:', e.message)
  }
}

function getActiveIgnores(episodeId) {
  const byId = new Set()
  const byNum = new Set()
  try {
    ensureIgnoreTable()
    execute(
      `DELETE FROM qc_ignores WHERE episode_id = ? AND shot_id IS NOT NULL AND shot_id NOT IN (
         SELECT s.id FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id
         WHERE ss.episode_id = ?)`,
      [episodeId, episodeId]
    )
    const rows = query('SELECT code, shot_number, shot_id FROM qc_ignores WHERE episode_id = ?', [episodeId])
    for (const r of rows) {
      if (r.shot_id != null) byId.add(`${r.code}\u0000${r.shot_id}`)
      else byNum.add(`${r.code}\u0000${r.shot_number}`)
    }
  } catch {  }
  return { byId, byNum }
}

function buildNumToId(shotIndex) {
  const map = new Map()
  for (const [rawId, entry] of shotIndex) map.set(String(entry.shot.shotNumber), rawId)
  return map
}

function isIgnored(ignores, code, shotNumber, numToId) {
  if (!ignores) return false
  const sid = numToId?.get(String(shotNumber))
  if (sid != null && ignores.byId.has(`${code}\u0000${sid}`)) return true
  return ignores.byNum.has(`${code}\u0000${shotNumber}`)
}

export function clearQcIgnores(episodeId) {
  try {
    ensureIgnoreTable()
    execute('DELETE FROM qc_ignores WHERE episode_id = ?', [episodeId])
  } catch (e) {
    console.warn('[qc] 清空忽略记录失败（不影响分镜保存）:', e.message)
  }
}

export function buildQcReport(episodeId, opts = {}) {
  const { scenes, sceneRows, shotIndex } = loadEpisodeShots(episodeId)
  const assetNames = loadAssetNames(episodeId)
  const qc = validateStoryboard(
    { scenes },
    { characters: assetNames.characters, scenes: assetNames.scenes, props: assetNames.props },
    { projectStyleText: assetNames.projectStyleText, sceneRows }
  )
  const continuity = collectContinuityWarnings(episodeId)
  qc.warnings.push(...continuity.warnings)
  const summary = summarizeQc(qc)

  const numToId = buildNumToId(shotIndex)
  const ignores = opts.includeIgnored ? null : getActiveIgnores(episodeId)
  if (ignores && (ignores.byId.size || ignores.byNum.size)) {
    for (const g of summary.groups) {
      g.items = g.items.filter((it) => !isIgnored(ignores, g.code, it.shot, numToId))
      g.count = g.items.length
    }
    summary.groups = summary.groups.filter((g) => g.items.length > 0)
    summary.ignoredCount = (summary.total - summary.groups.reduce((n, g) => n + g.items.length, 0))
    summary.errorCount = summary.groups.filter((g) => g.level === 'error').reduce((n, g) => n + g.items.length, 0)
    summary.warningCount = summary.groups.filter((g) => g.level === 'warning').reduce((n, g) => n + g.items.length, 0)
    summary.total = summary.errorCount + summary.warningCount
  }

  const limit = config.storyboard?.qcPanelLimit || 2000
  let trimmed = false
  for (const g of summary.groups) {
    g.count = g.items.length
    if (g.items.length > limit) { g.items = g.items.slice(0, limit); trimmed = true }
  }

  return {
    episodeId,
    total: summary.total,
    errorCount: summary.errorCount,
    warningCount: summary.warningCount,
    ignoredCount: summary.ignoredCount || 0,
    shotCount: qc.summary?.shotCount || 0,
    sceneCount: sceneRows.length,
    scriptSceneCount: continuity.scriptSceneCount,
    fixedCount: qc.summary?.fixedCount || 0,
    trimmed,
    groups: summary.groups,
    actions: QC_ACTION,
  }
}

router.get('/qc-report', (req, res) => {
  const episodeId = Number(req.query.episodeId)
  if (!Number.isFinite(episodeId) || episodeId <= 0) {
    return res.status(400).json({ error: 'episodeId 必填' })
  }
  try {
    ensureIgnoreTable()
    const episode = queryOne('SELECT id FROM episodes WHERE id = ?', [episodeId])
    if (!episode) return res.status(404).json({ error: '集不存在' })
    const includeIgnored = req.query.includeIgnored === '1' || req.query.includeIgnored === 'true'
    res.json({ success: true, ...buildQcReport(episodeId, { includeIgnored }) })
  } catch (e) {
    console.error('[qc-report] 失败:', e)
    res.status(500).json({ error: e.message || '质检失败' })
  }
})

const REFRAME_TYPES = ['全景', '中景', '近景', '特写']
const REFRAME_ANGLES_ANY = ['正面', '侧面', '过肩', '背面', '俯拍', '仰拍']
const REFRAME_ANGLES_DIALOGUE = ['正面', '侧面', '过肩']

const FIX_HANDLERS = {
  [QC_ACTION.AIRLOCK_LINK]: async (episodeId, items, ctx) => {
    const details = []
    let fixed = 0
    let failed = 0
    for (const it of items) {
      const entry = findShotEntry(episodeId, ctx, it.shot)
      if (!entry) { failed++; details.push({ shot: it.shot, ok: false, reason: '镜头不存在' }); continue }
      const { sceneIdx, shot, raw } = entry
      const prev = prevShotOf(episodeId, ctx, sceneIdx, shot)
      if (!prev) { failed++; details.push({ shot: it.shot, ok: false, reason: '没有上一镜（本镜是全集首镜）' }); continue }
      const prevFinal = prev.shot.finalFrame || ''
      if (!prevFinal) { failed++; details.push({ shot: it.shot, ok: false, reason: '上一镜没有最终画面描述（final_frame 为空），无法复刻' }); continue }
      try {
        const rewritten = await repairShotAirlock(shot, prevFinal, ctx.style)
        if (!rewritten) { failed++; details.push({ shot: it.shot, ok: false, reason: 'AI 未产出有效的 Airlock 改写' }); continue }
        execute('UPDATE shots SET integrated_multimodal_description = ? WHERE id = ?', [rewritten, raw.id])
        shot.integratedMultimodalDescription = rewritten
        fixed++
        details.push({ shot: it.shot, ok: true })
      } catch (e) {
        failed++
        details.push({ shot: it.shot, ok: false, reason: e.message })
      }
    }
    return { fixed, failed, details }
  },

  [QC_ACTION.AXIS_REPOSITION]: async (episodeId, items, ctx) => {
    const details = []
    let fixed = 0
    let failed = 0
    for (const it of items) {
      const entry = findShotEntry(episodeId, ctx, it.shot)
      if (!entry) { failed++; details.push({ shot: it.shot, ok: false, reason: '镜头不存在' }); continue }
      const { sceneIdx, shot, raw } = entry
      const prev = prevShotOf(episodeId, ctx, sceneIdx, shot)
      if (!prev) { failed++; details.push({ shot: it.shot, ok: false, reason: '没有上一镜，无法判定侧位翻转' }); continue }
      const charNames = (ctx.assetNames.characters || []).map((c) => c.name).filter(Boolean)
      const aliasMap = buildAliasMap(ctx.assetNames.characters || [])
      const prevSides = extractScreenSides(prev.shot.finalFrame || '', charNames, aliasMap)
      const currSides = extractScreenSides(shot.finalFrame || '', charNames, aliasMap)
      let done = false
      let lastReason = '未检出侧位翻转'
      for (const [name, pSide] of prevSides) {
        const cSide = currSides.get(name)
        if (!cSide || pSide === 'center' || cSide === 'center' || cSide === pSide) continue
        if (hasExplicitReposition(shot.integratedMultimodalDescription || '', cSide)) continue 
        try {
          const rewritten = await repairShotAxis(shot, name, pSide, cSide, ctx.style)
          if (!rewritten) { lastReason = `@${name} 的走位改写未产出有效结果`; continue }
          execute('UPDATE shots SET integrated_multimodal_description = ? WHERE id = ?', [rewritten, raw.id])
          shot.integratedMultimodalDescription = rewritten
          done = true
          fixed++
          details.push({ shot: it.shot, ok: true, note: `已补 @${name} 走位（frame ${pSide} → frame ${cSide}）` })
          break
        } catch (e) {
          lastReason = e.message
        }
      }
      if (!done) {
        const alreadyOk = [...prevSides].every(([name, pSide]) => {
          const cSide = currSides.get(name)
          if (!cSide || pSide === 'center' || cSide === 'center' || cSide === pSide) return true
          return hasExplicitReposition(shot.integratedMultimodalDescription || '', cSide)
        })
        if (alreadyOk) { fixed++; details.push({ shot: it.shot, ok: true, note: '本镜已有走位交代，问题已不存在' }) }
        else { failed++; details.push({ shot: it.shot, ok: false, reason: lastReason }) }
      }
    }
    return { fixed, failed, details }
  },

  [QC_ACTION.CAMERA_DIVERSIFY]: async (episodeId, items, ctx) => {
    const details = []
    let fixed = 0
    let failed = 0
    for (const it of items) {
      const sceneMatch = /^场次(\d+)$/.exec(String(it.shot || '').trim())
      if (sceneMatch) {
        const r = await reframeFlatScene(episodeId, ctx, Number(sceneMatch[1]), details)
        fixed += r.fixed
        failed += r.failed
      } else {
        const r = await reframeOneShot(episodeId, ctx, String(it.shot).trim(), details)
        fixed += r.fixed
        failed += r.failed
      }
    }
    return { fixed, failed, details }
  },
}

function findShotEntry(episodeId, ctx, shotNumber) {
  const key = String(shotNumber)
  for (const [rawId, entry] of ctx.shotIndex) {
    if (entry.shot.shotNumber === key) return { ...entry, rawId }
  }
  return null
}

function prevShotOf(episodeId, ctx, sceneIdx, shot) {
  const flat = []
  for (const sc of ctx.scenes) for (const s of sc.shots) flat.push(s)
  const i = flat.findIndex((s) => s.shotNumber === shot.shotNumber)
  if (i <= 0) return null
  const prevShot = flat[i - 1]
  const entry = findShotEntry(episodeId, ctx, prevShot.shotNumber)
  return entry ? { shot: prevShot, ...entry } : { shot: prevShot }
}

function hasDialogueContentLocal(d) {
  if (d == null) return false
  let arr = d
  if (typeof d === 'string') {
    const s = d.trim()
    if (!s || s === 'null') return false
    try { arr = JSON.parse(s) } catch { return s.length > 2 }
  }
  if (Array.isArray(arr)) return arr.some((x) => String(x?.text || '').trim())
  if (typeof arr === 'object') return Boolean(String(arr.text || '').trim())
  return false
}

function pickDifferent(candidates, ...avoid) {
  const avoidSet = new Set(avoid.filter(Boolean))
  return candidates.find((c) => !avoidSet.has(c)) || candidates[0]
}

async function reframeFlatScene(episodeId, ctx, sceneNumber, details) {
  const scene = ctx.scenes.find((s) => Number(s.sceneNumber) === sceneNumber)
  const label = `场次${sceneNumber}`
  if (!scene) { details.push({ shot: label, ok: false, reason: '场次不存在' }); return { fixed: 0, failed: 1 } }
  const shots = scene.shots || []
  const types = shots.map((s) => String(s.shotType || '').trim()).filter(Boolean)
  if (types.length < 3 || new Set(types).size > 1) {
    details.push({ shot: label, ok: true, note: '本场景别已不再全同，问题已不存在' })
    return { fixed: 1, failed: 0 }
  }
  let fixed = 0
  let failed = 0
  let prevType = String(shots[0].shotType || '').trim()
  let prevAngle = String(shots[0].cameraAngle || '').trim()
  for (let i = 1; i < shots.length; i++) {
    const shot = shots[i]
    const shotLabel = shot.shotNumber || `${label}-${i + 1}`
    const entry = findShotEntry(episodeId, ctx, shotLabel)
    if (!entry) { failed++; details.push({ shot: shotLabel, ok: false, reason: '镜头不存在' }); continue }
    const newType = pickDifferent(REFRAME_TYPES, String(shot.shotType || '').trim(), prevType)
    const pool = hasDialogueContentLocal(shot.dialogue) ? REFRAME_ANGLES_DIALOGUE : REFRAME_ANGLES_ANY
    const newAngle = pickDifferent(pool, String(shot.cameraAngle || '').trim(), prevAngle)
    const ok = await regenerateWithFrame(entry, shot, { shotType: newType, cameraAngle: newAngle }, ctx, shotLabel, details)
    if (ok) { fixed++; prevType = newType; prevAngle = newAngle } else { failed++ }
  }
  return { fixed, failed }
}

async function reframeOneShot(episodeId, ctx, shotNumber, details) {
  const entry = findShotEntry(episodeId, ctx, shotNumber)
  if (!entry) { details.push({ shot: shotNumber, ok: false, reason: '镜头不存在' }); return { fixed: 0, failed: 1 } }
  const { sceneIdx, shot } = entry
  const scene = ctx.scenes[sceneIdx]
  const idx = (scene?.shots || []).findIndex((s) => s.shotNumber === shot.shotNumber)
  const prev = idx > 0 ? scene.shots[idx - 1] : null
  const t = (s) => String(s?.shotType || '').trim()
  const a = (s) => String(s?.cameraAngle || '').trim()
  const m = (s) => String(s?.cameraMovement || '').trim()
  const stillViolates = Boolean(prev)
    && t(prev) && t(prev) === t(shot)
    && a(prev) && a(prev) === a(shot)
    && (!m(prev) || m(prev) === m(shot))
    && (() => {
        const pc = new Set(prev.characters || [])
        const cc = new Set(shot.characters || [])
        return (pc.size === 0 && cc.size === 0) || [...cc].some((c) => pc.has(c))
      })()
  if (!stillViolates) {
    details.push({ shot: shotNumber, ok: true, note: '与上一镜已不再同构（或跨场），问题已不存在' })
    return { fixed: 1, failed: 0 }
  }
  const pool = hasDialogueContentLocal(shot.dialogue) ? REFRAME_ANGLES_DIALOGUE : REFRAME_ANGLES_ANY
  const newAngle = pickDifferent(pool, a(shot), a(prev))
  const ok = await regenerateWithFrame(entry, shot, { cameraAngle: newAngle }, ctx, shotNumber, details)
  return ok ? { fixed: 1, failed: 0 } : { fixed: 0, failed: 1 }
}

async function regenerateWithFrame(entry, shot, frame, ctx, label, details) {
  const { raw } = entry
  const note = `【机位重排·质检修复】硬性要求：本镜必须采用${frame.shotType ? frame.shotType + '景、' : ''}${frame.cameraAngle}机位拍摄`
    + `（以此覆盖一切默认机位假设），运镜与其余调度保持原样。`
  const shotForAI = {
    description: shot.description || '',
    duration: shot.duration || 8,
    shotType: frame.shotType || shot.shotType || '中景',
    characters: shot.characters || [],
    sceneAssets: shot.sceneAssets || [],
    propAssets: shot.propAssets || [],
    dialogue: shot.dialogue || null,
    actionNote: note + (shot.actionNote ? `\n原动作说明：${shot.actionNote}` : ''),
  }
  try {
    const integrated = await enrichShotIntegrated(shotForAI, ctx.assetNames, ctx.style)
    if (!integrated) { details.push({ shot: label, ok: false, reason: 'AI 未产出有效的提示词改写' }); return false }
    const finalFrame = extractFinalFrameFromIntegrated(integrated) || ''
    execute(
      'UPDATE shots SET camera_angle = ?, shot_type = ?, integrated_multimodal_description = ?, final_frame = ? WHERE id = ?',
      [frame.cameraAngle || shot.cameraAngle || '', shotForAI.shotType, integrated, finalFrame, raw.id]
    )
    if (frame.cameraAngle) shot.cameraAngle = frame.cameraAngle
    if (frame.shotType) shot.shotType = frame.shotType
    shot.integratedMultimodalDescription = integrated
    shot.finalFrame = finalFrame
    details.push({ shot: label, ok: true, note: `已重排为${frame.shotType ? frame.shotType + '景 + ' : ''}${frame.cameraAngle}机位并重生成提示词` })
    return true
  } catch (e) {
    details.push({ shot: label, ok: false, reason: e.message })
    return false
  }
}

router.post('/qc-fix', async (req, res) => {
  const { episodeId, code, shots = null } = req.body || {}
  const epId = Number(episodeId)
  if (!Number.isFinite(epId) || epId <= 0) return res.status(400).json({ error: 'episodeId 必填' })
  if (!code || !String(code).trim()) return res.status(400).json({ error: 'code 必填' })

  const meta = qcMeta(code)
  const handler = FIX_HANDLERS[meta.action]
  if (!handler) {
    const registered = isRegisteredQcCode(code)
    const message = !registered
      ? `未登记的质检码「${code}」没有一键修复动作（在 server/ai/qcCodes.js 登记 action 后即可支持）`
      : meta.action === QC_ACTION.MANUAL
        ? `「${meta.title || code}」需要人工处理，没有一键修复（这类问题涉及剧情/资产设定，自动改会改坏内容）`
        : `暂不支持自动修复该问题类型（${code}）`
    return res.status(400).json({ error: message, action: meta.action, registered })
  }

  try {
    const { scenes, shotIndex } = loadEpisodeShots(epId)
    const assetNames = loadAssetNames(epId)
    let targets
    if (Array.isArray(shots) && shots.length) {
      targets = shots.map((s) => String(s))
    } else {
      const report = buildQcReport(epId, { includeIgnored: false })
      const g = report.groups.find((x) => x.code === code)
      if (!g) return res.json({ success: true, fixed: 0, failed: 0, details: [], message: '该问题当前已不存在（可能已被修复或已被忽略）' })
      targets = g.items.map((it) => it.shot).filter((s) => s && s !== '*')
      if (!targets.length) {
        return res.status(400).json({ error: `「${meta.title || code}」是整集级问题（不指向具体镜头），需要人工处理` })
      }
    }

    const batchLimit = config.storyboard?.qcFixBatchLimit || 20
    const truncated = targets.length > batchLimit
    const work = truncated ? targets.slice(0, batchLimit) : targets

    const ctx = { scenes, shotIndex, assetNames, style: assetNames.projectStyleText || config.defaultArtStyle }
    const result = await handler(epId, work.map((s) => ({ shot: s })), ctx)
    console.log(`[qc-fix] code=${code} 目标 ${work.length} 镜 → 修好 ${result.fixed}，失败 ${result.failed}`)
    res.json({
      success: true,
      code,
      title: meta.title,
      requested: targets.length,
      processed: work.length,
      truncated,
      batchLimit,
      fixed: result.fixed,
      failed: result.failed,
      details: result.details,
      message: truncated
        ? `本次处理前 ${work.length} 镜（单批上限 ${batchLimit}），剩余 ${targets.length - work.length} 镜请再次点击`
        : `处理完成：修好 ${result.fixed} 镜${result.failed ? `，${result.failed} 镜未成功` : ''}`,
    })
  } catch (e) {
    console.error('[qc-fix] 失败:', e)
    res.status(500).json({ error: e.message || '修复失败' })
  }
})

router.post('/qc-ignore', (req, res) => {
  const { episodeId, code, shots = null, reason = '' } = req.body || {}
  const epId = Number(episodeId)
  if (!Number.isFinite(epId) || epId <= 0) return res.status(400).json({ error: 'episodeId 必填' })
  if (!code || !String(code).trim()) return res.status(400).json({ error: 'code 必填' })
  try {
    ensureIgnoreTable()
    let targets = Array.isArray(shots) && shots.length ? shots.map((s) => String(s)) : null
    if (!targets) {
      const report = buildQcReport(epId, { includeIgnored: false })
      const g = report.groups.find((x) => x.code === code)
      if (!g) return res.json({ success: true, ignored: 0, message: '该问题当前已不存在' })
      targets = g.items.map((it) => it.shot)
    }
    const numToId = buildNumToId(loadEpisodeShots(epId).shotIndex)
    let n = 0
    transaction(() => {
      for (const s of targets) {
        try {
          execute(
            'INSERT OR REPLACE INTO qc_ignores (episode_id, code, shot_number, shot_id, reason) VALUES (?, ?, ?, ?, ?)',
            [epId, String(code), String(s), numToId.get(String(s)) ?? null, String(reason).slice(0, 300)]
          )
          n++
        } catch {  }
      }
    })
    res.json({ success: true, ignored: n })
  } catch (e) {
    console.error('[qc-ignore] 失败:', e)
    res.status(500).json({ error: e.message || '标记失败' })
  }
})

router.post('/qc-unignore', (req, res) => {
  const { episodeId, code, shots = null } = req.body || {}
  const epId = Number(episodeId)
  if (!Number.isFinite(epId) || epId <= 0) return res.status(400).json({ error: 'episodeId 必填' })
  try {
    ensureIgnoreTable()
    const params = [epId]
    let sql = 'DELETE FROM qc_ignores WHERE episode_id = ?'
    if (code) { sql += ' AND code = ?'; params.push(String(code)) }
    if (Array.isArray(shots) && shots.length) {
      sql += ` AND shot_number IN (${shots.map(() => '?').join(',')})`
      params.push(...shots.map((s) => String(s)))
    }
    execute(sql, params)
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.get('/qc-ignores', (req, res) => {
  const epId = Number(req.query.episodeId)
  if (!Number.isFinite(epId) || epId <= 0) return res.status(400).json({ error: 'episodeId 必填' })
  try {
    ensureIgnoreTable()
    const rows = query(
      'SELECT id, code, shot_number, reason, created_at FROM qc_ignores WHERE episode_id = ? ORDER BY id DESC',
      [epId]
    )
    res.json({ success: true, ignores: rows.map((r) => ({ ...r, title: qcMeta(r.code).title || r.code })) })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router
