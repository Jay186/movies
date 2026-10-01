import { Router } from 'express'
import { UPLOADS_URL_SLASH, UPLOADS_PREFIX_RE, uploadsUrl, serverDir, uploadsDir } from '../paths.js'
import fs from 'fs'
import path from 'path'

import { removeLocalUploads as removeLocalUploadsShared, filterUnreferencedUploadUrls } from '../ai/shared.js'
import { query, queryOne, execute, transaction } from '../db.js'
import { ensureStandardScript } from '../ai/scriptFormat.js'
import { scriptHash } from '../scriptHash.js'
import {
  mergeMasterIntoEpisodeCharacters,
  replaceEpisodeCharacters,
  updateProjectCharacter,
  syncProjectCharacterToEpisodes,
} from '../characterLibrary.js'
import { backfillShotAssets, backfillSceneByTitle, backfillShotSpaceFromScene } from '../ai/assetBackfill.js'
import { classifyShotCombat } from '../ai/shotClassifier.js'
import { currentBaselineUrlForGroup } from '../ai/sceneAnchors.js'
import { parseDialogue, serializeDialogue } from '../ai/dialogue.js'
import { resolveAlertsByShot, recordAlert, clearAlertsByRef } from '../ai/alerts.js'
import { cancelJobsForShots } from '../jobs/videoJobRunner.js'
import {
  snapshotBeforeExtract,
  computeExtractDiff,
  applyKeepForScenes,
  applyKeepForProps,
} from '../ai/extractGuard.js'
import { snapshotAssetStatesForNames, restoreAssetStates } from '../ai/assetPipeline.js'
import { regenerateShot } from '../ai/doubao.js'
import { config } from '../config.js'
import { ASSET_META, uploadRefEpisodeSql } from '../ai/assetTypes.js'
import { fingerprintOf, normalizeSceneGrouping } from '../ai/sceneAnchors.js'
import { syncEpisodeEnglish, shotEnglishStale } from '../ai/shotEnglish.js'
import {
  FIELD_SOURCE,
  buildFieldSourcesForInput,
  buildPromptProvenanceForInput,
  buildStructuralFieldsForInput,
  buildShotRelationGraph,
  ensureShotUid,
  mergeFieldSources,
  normalizeStoryboardDocument,
  parseRelatedShots,
  resolveStoryboardSource,
} from '../storyboard/model.js'
import { validateStoryboardImport, formatStoryboardValidationError } from '../ai/storyboardContractValidator.js'

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true })
const removeLocalUploads = (urls) => removeLocalUploadsShared(urls, uploadsDir)

const router = Router()

function applyShotMetadataUpdate(shotId, input = {}) {
  const values = { ...buildStructuralFieldsForInput(input), ...buildPromptProvenanceForInput(input) }
  const entries = Object.entries(values).filter(([, value]) => value !== undefined)
  if (!entries.length) return
  const setSql = entries.map(([column]) => `${column} = COALESCE(?, ${column})`).join(', ')
  execute(`UPDATE shots SET ${setSql} WHERE id = ?`, [...entries.map(([, value]) => value), shotId])
}

const SHOT_VERSION_META_COLS = new Set(['version', 'edited_by', 'field_sources_json'])

// 英文版后台同步（2026-10-01）：分镜保存/编辑后 fire-and-forget 触发，
// 只编译"中文变了或英文缺失"的镜（指纹判新鲜，其余零成本跳过），不阻塞保存响应。
// 编译失败的镜由出片任务内自愈兜底（compileShotEnglish 重试），此处只尽力而为。
function scheduleEnglishSync(episodeId) {
  if (!episodeId) return
  setImmediate(() => {
    syncEpisodeEnglish(episodeId).catch((e) => console.warn(`[shotEnglish] 集 ${episodeId} 后台同步异常:`, e.message))
  })
}

// shot_versions.shot_number 是后加迁移列：老库在迁移执行前可能尚未存在，探测一次并缓存
let _svNumberColCache = null
function hasShotVersionNumberCol() {
  if (_svNumberColCache !== null) return _svNumberColCache
  try {
    _svNumberColCache = query('PRAGMA table_info(shot_versions)').some((c) => c.name === 'shot_number')
  } catch {
    _svNumberColCache = false
  }
  return _svNumberColCache
}

// 包装 shots 行更新：仅在内容发生实质变化时，把被覆盖的旧值快照进 shot_versions
function withShotVersionSnapshot(shotId, episodeId, reason, editedBy, updateFn) {
  const before = queryOne('SELECT * FROM shots WHERE id = ?', [shotId])
  if (!before) { updateFn(); return }
  updateFn()
  const after = queryOne('SELECT * FROM shots WHERE id = ?', [shotId])
  if (!after) return
  const changed = Object.keys(after).some(
    (k) => !SHOT_VERSION_META_COLS.has(k) && String(before[k] ?? '') !== String(after[k] ?? '')
  )
  if (!changed) return
  execute(
    `INSERT INTO shot_versions (shot_id, episode_id, storyboard_scene_id, version, edited_by, reason, snapshot, shot_number)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [shotId, episodeId, before.storyboard_scene_id, before.version || 1, editedBy || '', reason || '', JSON.stringify(before), before.shot_number || '']
  )
  execute('UPDATE shots SET version = COALESCE(version, 1) + 1, edited_by = ? WHERE id = ?', [editedBy || '', shotId])
}

// 删除 shots 行前的无条件快照（行即将消失，不做变化检测）
function forceSnapshotShot(shotId, episodeId, reason, editedBy) {
  const row = queryOne('SELECT * FROM shots WHERE id = ?', [shotId])
  if (!row) return
  execute(
    `INSERT INTO shot_versions (shot_id, episode_id, storyboard_scene_id, version, edited_by, reason, snapshot, shot_number)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [shotId, episodeId, row.storyboard_scene_id, row.version || 1, editedBy || '', reason || '', JSON.stringify(row), row.shot_number || '']
  )
}

// world_state_in 是派生字段：按时间轴顺序回填为上一镜的 world_state_out（首镜无上一镜则为空串）
// 供镜间衔接检查器（#8）与单镜重生成（#2）使用；保存与单镜编辑后都需要刷新
// world_state_in_en 同源派生自上一镜 world_state_out_en：英文副本必须与中文严格同源，
// 否则本镜首帧约束的英文与上一镜末帧的中文描述会指向两个不同状态（2026-09-27）
function refreshWorldStateIn(episodeId) {
  execute(
    `UPDATE shots SET world_state_in = COALESCE((
       SELECT s2.world_state_out FROM shots s2
       JOIN storyboard_scenes ss2 ON ss2.id = s2.storyboard_scene_id
       WHERE ss2.episode_id = ?
         AND (s2.start_time < shots.start_time
              OR (s2.start_time = shots.start_time AND s2.id < shots.id))
       ORDER BY s2.start_time DESC, s2.id DESC LIMIT 1
     ), ''),
     world_state_in_en = COALESCE((
       SELECT s2.world_state_out_en FROM shots s2
       JOIN storyboard_scenes ss2 ON ss2.id = s2.storyboard_scene_id
       WHERE ss2.episode_id = ?
         AND (s2.start_time < shots.start_time
              OR (s2.start_time = shots.start_time AND s2.id < shots.id))
       ORDER BY s2.start_time DESC, s2.id DESC LIMIT 1
     ), '')
     WHERE storyboard_scene_id IN (SELECT id FROM storyboard_scenes WHERE episode_id = ?)`,
    [episodeId, episodeId, episodeId]
  )
}

// 时轴顺延（#4 编辑侧联动）：本镜 duration/start_time 变化后，
// 强制 end_time = start_time + duration，并把同集时间序后续镜整体平移 delta（对白绝对秒同步平移）
function shiftFollowingShots(episodeId, shotId, oldEndTime) {
  const row = queryOne('SELECT start_time, duration, end_time FROM shots WHERE id = ?', [shotId])
  if (!row) return 0
  const start = Number(row.start_time) || 0
  const duration = Number(row.duration) || 0
  const newEndTime = Math.round((start + duration) * 1000) / 1000
  const delta = Math.round((newEndTime - (Number(oldEndTime) || 0)) * 1000) / 1000
  if (!delta) return 0
  execute('UPDATE shots SET end_time = ? WHERE id = ?', [newEndTime, shotId])
  const followers = query(
    `SELECT s.id, s.dialogue FROM shots s
       JOIN storyboard_scenes ss ON ss.id = s.storyboard_scene_id
      WHERE ss.episode_id = ?
        AND (s.start_time > ? OR (s.start_time = ? AND s.id > ?))
      ORDER BY s.start_time ASC, s.id ASC`,
    [episodeId, row.start_time, row.start_time, shotId]
  )
  for (const f of followers) {
    const dlg = parseDialogue(f.dialogue)
    const shiftedDlg = Array.isArray(dlg) && dlg.length
      ? dlg.map((d) => ({
          ...d,
          startTime: Math.round(((Number(d.startTime) || 0) + delta) * 1000) / 1000,
          endTime: Math.round(((Number(d.endTime) || 0) + delta) * 1000) / 1000,
        }))
      : null
    execute(
      'UPDATE shots SET start_time = start_time + ?, end_time = end_time + ?, dialogue = COALESCE(?, dialogue) WHERE id = ?',
      [delta, delta, shiftedDlg ? serializeDialogue(shiftedDlg) : null, f.id]
    )
  }
  return followers.length
}

router.get('/project/:projectId', (req, res) => {
  const episodes = query(
    'SELECT * FROM episodes WHERE project_id = ? ORDER BY episode_number',
    [req.params.projectId]
  )
  res.json(episodes)
})

router.post('/', (req, res) => {
  const { project_id, title } = req.body || {}
  if (!project_id) return res.status(400).json({ error: 'project_id 必填' })
  const project = queryOne('SELECT id FROM projects WHERE id = ?', [project_id])
  if (!project) return res.status(404).json({ error: '项目不存在' })
  const maxRow = queryOne('SELECT MAX(episode_number) AS m FROM episodes WHERE project_id = ?', [project_id])
  const nextNumber = (maxRow && maxRow.m ? maxRow.m : 0) + 1
  const epTitle = title && String(title).trim() ? String(title).trim() : `第 ${nextNumber} 集`
  const result = execute(
    'INSERT INTO episodes (project_id, episode_number, title) VALUES (?, ?, ?)',
    [project_id, nextNumber, epTitle]
  )
  const episode = queryOne('SELECT * FROM episodes WHERE id = ?', [result.lastInsertRowid])
  res.status(201).json(episode)
})

router.put('/:id', (req, res) => {
  const { title } = req.body || {}
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'title 必填' })
  const episode = queryOne('SELECT id FROM episodes WHERE id = ?', [req.params.id])
  if (!episode) return res.status(404).json({ error: '集不存在' })
  execute('UPDATE episodes SET title = ? WHERE id = ?', [String(title).trim(), req.params.id])
  const updated = queryOne('SELECT * FROM episodes WHERE id = ?', [req.params.id])
  res.json(updated)
})

router.delete('/:id', (req, res) => {
  const episode = queryOne('SELECT id, project_id FROM episodes WHERE id = ?', [req.params.id])
  if (!episode) return res.status(404).json({ error: '集不存在' })
  const countRow = queryOne('SELECT COUNT(*) AS c FROM episodes WHERE project_id = ?', [episode.project_id])
  if (countRow.c <= 1) return res.status(400).json({ error: '项目至少保留 1 集，无法删除最后一集' })
  const { sql: refSql, paramCount } = uploadRefEpisodeSql()
  const rows = paramCount ? query(refSql, new Array(paramCount).fill(episode.id)) : []
  // 先取出本集名下各类型资产的 id（删集后再查可能已被其他清理逻辑影响）
  const ownedAssetIds = Object.entries(ASSET_META).map(([assetType, meta]) => [
    assetType,
    query(`SELECT ${meta.idField} FROM ${meta.table} WHERE episode_id = ?`, [episode.id]).map((r) => r[meta.idField]),
  ])
  execute('DELETE FROM episodes WHERE id = ?', [episode.id])

  try {
    // 资产历史按类型清理：类型清单来自 ASSET_META，新增资产类型不用改这里
    for (const [assetType, ids] of ownedAssetIds) {
      if (!ids.length) continue
      execute(
        `DELETE FROM asset_image_history WHERE asset_type = ? AND asset_id IN (${ids.map(() => '?').join(',')})`,
        [assetType, ...ids]
      )
    }
    execute('DELETE FROM ai_calls WHERE episode_id = ?', [episode.id])
    execute('DELETE FROM video_jobs WHERE episode_id = ?', [episode.id])
    execute('DELETE FROM compose_outputs WHERE episode_id = ?', [episode.id])
    clearAlertsByRef('episode', [episode.id])
  } catch (e) {
    console.warn(`[episodes] 无外键表清理失败（删除已生效，仅残留日志/历史）: ${e.message}`)
  }

  removeLocalUploads(filterUnreferencedUploadUrls(rows.map((r) => r.u)))
  res.json({ success: true })
})

router.get('/:id', (req, res) => {
  const episode = queryOne('SELECT * FROM episodes WHERE id = ?', [req.params.id])
  if (!episode) return res.status(404).json({ error: '集不存在' })

  const characters = mergeMasterIntoEpisodeCharacters(
    query('SELECT * FROM characters WHERE episode_id = ? ORDER BY id', [req.params.id])
  )
  const props = query('SELECT * FROM props WHERE episode_id = ? ORDER BY id', [req.params.id])
  const roleBySceneId = (() => {
    try {
      const rows = query(
        'SELECT scene_id, spatial_group, spatial_role, elements_json, shared_env_json FROM scene_analysis WHERE episode_id = ?',
        [req.params.id]
      )
      return new Map(rows.map((r) => [r.scene_id, r]))
    } catch (e) {
      console.warn('[GET /episodes/:id] scene_analysis 读取失败（降级为无机位声明）:', e.message)
      return new Map()
    }
  })()
  const scenes = query('SELECT * FROM scenes WHERE episode_id = ? ORDER BY scene_number', [req.params.id]).map((s) => ({
    ...s,
    propNames: (() => {
      try { return JSON.parse(s.prop_names || '[]') } catch { return [] }
    })(),
    spatialGroup: String(roleBySceneId.get(s.id)?.spatial_group || ''),
    spatialRole: String(roleBySceneId.get(s.id)?.spatial_role || ''),
    elements: (() => {
      try {
        const v = JSON.parse(roleBySceneId.get(s.id)?.elements_json || '[]')
        return Array.isArray(v) ? v : []
      } catch { return [] }
    })(),
    sharedEnv: (() => {
      try {
        const v = JSON.parse(roleBySceneId.get(s.id)?.shared_env_json || '[]')
        return Array.isArray(v) ? v : []
      } catch { return [] }
    })(),
  }))
  let aiChatHistory = []
  try {
    aiChatHistory = JSON.parse(episode.ai_chat_history || '[]')
  } catch {
    aiChatHistory = []
  }

  const storyboardScenes = query(
    'SELECT * FROM storyboard_scenes WHERE episode_id = ? ORDER BY scene_number',
    [req.params.id]
  )
  const sceneIds = storyboardScenes.map((s) => s.id)
  const shotsByScene = new Map()
  if (sceneIds.length) {
    const placeholders = sceneIds.map(() => '?').join(', ')
    const allShots = query(
      `SELECT * FROM shots WHERE storyboard_scene_id IN (${placeholders}) ORDER BY start_time, id`,
      sceneIds
    )
    for (const shot of allShots) {
      const list = shotsByScene.get(shot.storyboard_scene_id)
      if (list) list.push(shot)
      else shotsByScene.set(shot.storyboard_scene_id, [shot])
    }
  }
  for (const s of storyboardScenes) {
    s.shots = (shotsByScene.get(s.id) || []).map((shot) => ({
      ...shot,
      characters: JSON.parse(shot.characters || '[]'),
      sceneAssets: JSON.parse(shot.scene_assets || '[]'),
      propAssets: JSON.parse(shot.prop_assets || '[]'),
      videoGenerated: !!shot.video_generated,
      shotNumber: shot.shot_number || '',
      shotType: shot.shot_type || '',
      startTime: shot.start_time || 0,
      endTime: shot.end_time || 0,
      actionNote: shot.action_note || '',
      soundEffects: shot.sound_effects || '',
      cameraMovement: shot.camera_movement || '',
      cameraAngle: shot.camera_angle || '',
      cameraElevation: shot.camera_elevation || '',
      overallSoundscape: shot.overall_soundscape || '',
      nonDiegeticMusic: shot.non_diegetic_music || '',
      integratedMultimodalDescription: shot.integrated_multimodal_description || '',
      blockingPlan: (() => {
        try { return shot.blocking_plan ? JSON.parse(shot.blocking_plan) : null } catch { return null }
      })(),
      finalFrame: shot.final_frame || '',
      purpose: shot.purpose || '',
      goal: shot.goal || '',
      emotionTone: shot.emotion_tone || '',
      infoPoints: (() => {
        try { const v = JSON.parse(shot.info_points || '[]'); return Array.isArray(v) ? v : [] } catch { return [] }
      })(),
      worldStateIn: shot.world_state_in || '',
      worldStateOut: shot.world_state_out || '',
      // 英文版待准备标记：分镜列表黄点用（1=待准备，出片时会自动补齐）
      englishPending: shotEnglishStale(shot) ? 1 : 0,
      dialogue: (() => {
        const lines = parseDialogue(shot.dialogue)
        return lines.length ? lines : null
      })(),
      description: shot.description || '',
      storyboardUrl: shot.storyboard_url || '',
      frameUrl: shot.frame_url || '',
      frameUrl2: shot.frame_url2 || '',
      videoUrl: shot.video_url || '',
      continuityUrl: shot.continuity_url || '',
      keyframeUrl: shot.keyframe_url || '',
      seamCheck: (() => {
        try { return shot.seam_check ? JSON.parse(shot.seam_check) : null } catch { return null }
      })(),
      fieldSources: (() => {
        try { return shot.field_sources_json ? JSON.parse(shot.field_sources_json) : {} } catch { return {} }
      })(),
      shotUid: shot.shot_uid || '',
      beatId: shot.beat_id || '',
      coverageId: shot.coverage_id || '',
      relationType: shot.relation_type || '',
      relatedShots: parseRelatedShots(shot.related_shots_json),
      composition: shot.composition || '',
      lens: shot.lens || '',
      depthOfField: shot.depth_of_field || '',
      transitionIn: shot.transition_in || '',
      transitionOut: shot.transition_out || '',
      colorLighting: shot.color_lighting || '',
      spaceType: shot.space_type || '',
      spaceEvidence: shot.space_evidence || '',
      promptProviderId: shot.prompt_provider_id || '',
      compiledPrompt: shot.compiled_prompt || '',
      promptCompiledAt: shot.prompt_compiled_at || null,
      anchorSnapshot: (() => {
        try { return shot.anchor_refs_snapshot ? JSON.parse(shot.anchor_refs_snapshot) : null } catch { return null }
      })(),
    }))
  }

  // 空间锚「依据已变」判定：快照里记的是出图当时的组基准，与当前已确认基准比对；
  // 组级缓存，一次列表加载每组最多查一次。
  const baselineNowByGroup = new Map()
  for (const s of storyboardScenes) {
    for (const shot of s.shots) {
      const snapGroup = shot.anchorSnapshot?.scene?.group || ''
      const snapBaseline = shot.anchorSnapshot?.scene?.baseline_url || ''
      if (snapGroup && snapBaseline) {
        if (!baselineNowByGroup.has(snapGroup)) {
          baselineNowByGroup.set(snapGroup, currentBaselineUrlForGroup(req.params.id, snapGroup))
        }
        shot.anchorStale = baselineNowByGroup.get(snapGroup) !== snapBaseline
      } else {
        shot.anchorStale = false
      }
    }
  }

  res.json({
    ...episode,
    scriptConfirmed: !!episode.script_confirmed,
    scriptHash: scriptHash(episode.script_content),
    assetsScriptFp: episode.assets_script_fp || '',
    storyboardScriptFp: episode.storyboard_script_fp || '',
    storyboardSource: episode.storyboard_source || 'generated',
    aiChatHistory,
    characters,
    props,
    scenes,
    storyboardScenes: storyboardScenes.map((scene, sceneIndex) => ({
      ...scene,
      scene_number: sceneIndex + 1,
      shots: scene.shots.map((shot, shotIndex) => ({
        ...shot,
        shot_number: shot.shot_number || `${sceneIndex + 1}-${shotIndex + 1}`,
      })),
    })),
    storyboardConfirmed: !!episode.storyboard_confirmed,
  })
})

router.get('/:id/storyboard-graph', (req, res) => {
  const episode = queryOne('SELECT id FROM episodes WHERE id = ?', [req.params.id])
  if (!episode) return res.status(404).json({ error: '集不存在' })
  const scenes = query('SELECT id, scene_number, title FROM storyboard_scenes WHERE episode_id = ? ORDER BY scene_number', [req.params.id])
  const sceneIds = scenes.map((scene) => scene.id)
  const shotsByScene = new Map()
  if (sceneIds.length) {
    const placeholders = sceneIds.map(() => '?').join(', ')
    const shots = query(
      `SELECT id, storyboard_scene_id, shot_uid, shot_number, beat_id, coverage_id, relation_type, related_shots_json
       FROM shots WHERE storyboard_scene_id IN (${placeholders}) ORDER BY start_time, id`,
      sceneIds,
    )
    for (const shot of shots) {
      const list = shotsByScene.get(shot.storyboard_scene_id) || []
      list.push({
        ...shot,
        shotUid: shot.shot_uid || '',
        shotNumber: shot.shot_number || '',
        beatId: shot.beat_id || '',
        coverageId: shot.coverage_id || '',
        relationType: shot.relation_type || '',
        relatedShots: parseRelatedShots(shot.related_shots_json),
      })
      shotsByScene.set(shot.storyboard_scene_id, list)
    }
  }
  const document = {
    scenes: scenes.map((scene) => ({
      ...scene,
      sceneNumber: scene.scene_number,
      shots: shotsByScene.get(scene.id) || [],
    })),
  }
  res.json({ success: true, graph: buildShotRelationGraph(document) })
})

router.put('/:id/script', async (req, res) => {
  const { script_content, script_confirmed, ai_chat_history } = req.body
  const current = queryOne('SELECT script_content FROM episodes WHERE id = ?', [req.params.id])

  let content = script_content
  if (script_confirmed) {
    const source = script_content !== undefined ? script_content : current?.script_content
    if (source && String(source).trim()) {
      try {
        const normalized = await ensureStandardScript(source, { episodeId: req.params.id })
        if (normalized.changed) content = normalized.text
      } catch (e) {
        console.warn('[script normalize] 确认剧本格式转换失败，按原文入库:', e.message)
      }
    }
  }

  const scriptChanged = content !== undefined && content !== current?.script_content
  execute(
    'UPDATE episodes SET script_content = COALESCE(?, script_content), script_confirmed = COALESCE(?, script_confirmed), ai_chat_history = COALESCE(?, ai_chat_history), storyboard_confirmed = CASE WHEN ? THEN 0 ELSE storyboard_confirmed END WHERE id = ?',
    [
      content,
      script_confirmed,
      ai_chat_history === undefined ? null : JSON.stringify(ai_chat_history),
      scriptChanged ? 1 : 0,
      req.params.id,
    ]
  )
  const episode = queryOne('SELECT * FROM episodes WHERE id = ?', [req.params.id])
  res.json(episode)
})

router.post('/:id/script/preview', async (req, res) => {
  const { text } = req.body
  if (!text || !String(text).trim()) return res.status(400).json({ error: '请粘贴或上传剧本内容' })

  try {
    const raw = String(text)
    const normalized = await ensureStandardScript(raw, { episodeId: req.params.id })

    const sceneCount = normalized.text
      .split('\n')
      .filter((l) => /^场次[一二三四五六七八九十\d]+[：:]\s*/.test(l)).length

    const unparsedLines = raw.split('\n').map((l) => l.trim()).filter((line) => {
      if (!line) return false
      if (/^场次[一二三四五六七八九十\d]+[：:]/.test(line)) return false
      if (/^(【\s*场次|===\s*场次|第\s*[0-9一二三四五六七八九十百]+\s*场|Scene\s*\d+)/i.test(line)) return false
      return /^(第\s*[0-9一二三四五六七八九十百]+[幕章卷]|Act\s*\d+|Part\s*\d+|镜头\s*\d+|分场\s*\d+)/i.test(line)
    })

    res.json({
      success: true,
      sceneCount,
      unparsedCount: unparsedLines.length,
      unparsedLines: unparsedLines.slice(0, 20),
      changed: normalized.changed,
      method: normalized.method,
      normalizedText: normalized.text,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.post('/:id/characters', (req, res) => {
  const { characters = [], source = 'edit', decision = '', mergeStrategy = 'preserve' } = req.body
  if (!Array.isArray(characters) || characters.length === 0) {
    return res.status(400).json({ error: '角色列表不能为空，已拒绝保存以保护现有数据' })
  }
  const episode = queryOne('SELECT project_id FROM episodes WHERE id = ?', [req.params.id])
  const guardResult = replaceEpisodeCharacters(
    req.params.id,
    episode?.project_id || null,
    characters,
    { source, decision, guard: source === 'extract', mergeStrategy }
  )
  if (guardResult?.risk) return res.json(guardResult)

  const result = mergeMasterIntoEpisodeCharacters(
    query('SELECT * FROM characters WHERE episode_id = ? ORDER BY id', [req.params.id])
  )
  res.json(result)
})

router.post('/:id/props', (req, res) => {
  const { props = [], source = 'edit', decision = '' } = req.body
  if (!Array.isArray(props) || props.length === 0) {
    return res.status(400).json({ error: '道具列表不能为空，已拒绝保存以保护现有数据' })
  }
  const episodeId = Number(req.params.id)

  let effectiveProps = props
  if (source === 'extract') {
    const oldRows = query('SELECT * FROM props WHERE episode_id = ? ORDER BY id', [episodeId])
    const incomingRows = props.map((p) => {
      const oldRow = oldRows.find((r) => r.name === p.name)
      return {
        name: p.name,
        description: p.description || '',
        owner: p.owner || '',
        image_url: p.imageUrl || p.image_url || '',
        name_en: p.nameEn ?? oldRow?.name_en ?? '',
        description_en: p.descriptionEn ?? oldRow?.description_en ?? '',
      }
    })
    const report = computeExtractDiff({ table: 'props', oldRows, incoming: incomingRows })
    if (report.hasRisk && decision !== 'keep' && decision !== 'accept') {
      return res.json({ risk: true, table: 'props', report })
    }
    if (report.hasRisk && decision === 'keep') {
      effectiveProps = applyKeepForProps(props, oldRows)
    }
    snapshotBeforeExtract({ episodeId, trigger: 'extract-props', tables: ['props'] })
  }

  transaction(() => {
    const oldEn = new Map(
      query('SELECT name, name_en, description_en, owner FROM props WHERE episode_id = ?', [episodeId])
        .map((r) => [r.name, r])
    )
    const stateSnapshot = snapshotAssetStatesForNames('prop', [
      ...oldEn.keys(),
      ...props.map((p) => p.name),
    ])
    execute('DELETE FROM props WHERE episode_id = ?', [episodeId])
    for (const p of effectiveProps) {
      const imgUrl = p.imageUrl || p.image_url || ''
      const old = oldEn.get(p.name)
      const finalOwner = p.owner ?? old?.owner ?? ''
      execute(
        'INSERT INTO props (episode_id, name, description, owner, image_url, name_en, description_en) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [episodeId, p.name, p.description || '', finalOwner, imgUrl, p.nameEn ?? old?.name_en ?? '', p.descriptionEn ?? old?.description_en ?? '']
      )
    }
    restoreAssetStates(stateSnapshot)
  })
  const result = query('SELECT * FROM props WHERE episode_id = ? ORDER BY id', [episodeId])
  res.json(result)
})

router.post('/:id/scenes', (req, res) => {
  const { scenes = [], source = 'edit', decision = '', allowEmpty = false } = req.body
  if (!Array.isArray(scenes) || (scenes.length === 0 && !(source === 'edit' && allowEmpty === true))) {
    return res.status(400).json({ error: '场景列表不能为空，已拒绝保存以保护现有数据' })
  }
  const episodeId = Number(req.params.id)

  let effectiveScenes = scenes
  if (source === 'extract') {
    const oldRows = query('SELECT * FROM scenes WHERE episode_id = ? ORDER BY scene_number', [episodeId])
    const incomingRows = scenes.map((s, i) => {
      const name = s.name || s.title || `场景${i + 1}`
      const old = oldRows.find((r) => r.title === name)
      const rawProps = Array.isArray(s.propNames) ? s.propNames : (Array.isArray(s.props) ? s.props : [])
      const propNames = rawProps.map(String).filter(Boolean)
      return {
        scene_number: i + 1,
        title: name,
        summary: s.description || s.summary || '',
        image_url: s.image_url || s.imageUrl || '',
        prop_names: JSON.stringify(propNames),
        title_en: s.titleEn ?? old?.title_en ?? '',
        summary_en: s.summaryEn ?? old?.summary_en ?? '',
        lighting_en: s.lightingEn ?? old?.lighting_en ?? '',
        space_type: (s.spaceType || s.space_type) || old?.space_type || '',
        space_evidence: (s.spaceEvidence || s.space_evidence) || old?.space_evidence || '',
      }
    })
    const report = computeExtractDiff({ table: 'scenes', oldRows, incoming: incomingRows })
    if (report.hasRisk && decision !== 'keep' && decision !== 'accept') {
      return res.json({ risk: true, table: 'scenes', report })
    }
    if (report.hasRisk && decision === 'keep') {
      effectiveScenes = applyKeepForScenes(scenes, oldRows)
    }
    snapshotBeforeExtract({ episodeId, trigger: 'extract-scenes', tables: ['scenes'] })
  }

  transaction(() => {
    const oldEn = new Map(
      query('SELECT title, title_en, summary_en, lighting_en, location FROM scenes WHERE episode_id = ?', [episodeId])
        .map((r) => [r.title, r])
    )
    const stateSnapshot = snapshotAssetStatesForNames('scene', [
      ...oldEn.keys(),
      ...scenes.map((s, i) => s.name || s.title || `场景${i + 1}`),
    ])
    const oldRowsTx = query('SELECT * FROM scenes WHERE episode_id = ? ORDER BY scene_number', [episodeId])
    const oldById = new Map(oldRowsTx.map((r) => [r.id, r]))
    const oldByTitle = new Map(oldRowsTx.map((r) => [r.title, r]))
    const seenOldIds = new Set()
    let inserted = 0
    let contentChanged = 0

    for (let i = 0; i < effectiveScenes.length; i++) {
      const s = effectiveScenes[i]
      const name = s.name || s.title || `场景${i + 1}`
      const imgUrl = s.image_url || s.imageUrl || ''
      const rawProps = Array.isArray(s.propNames) ? s.propNames : (Array.isArray(s.props) ? s.props : [])
      let finalSceneId = null
      const propNames = rawProps.map(String).filter(Boolean)
      const old = oldEn.get(name)
      const finalSummary = s.description || s.summary || ''
      const finalLightingEn = s.lightingEn ?? old?.lighting_en ?? ''
      const finalLocation = s.location
        ?? (source === 'extract' ? old?.location : undefined)
        ?? name
      const finalTitleEn = s.titleEn ?? old?.title_en ?? ''
      const finalSummaryEn = s.summaryEn ?? old?.summary_en ?? ''
      const finalSpaceType = (s.spaceType || s.space_type)
        || (source === 'extract' ? old?.space_type : undefined)
        || ''
      const finalSpaceEvidence = (s.spaceEvidence || s.space_evidence)
        || (source === 'extract' ? old?.space_evidence : undefined)
        || ''

      let target = null
      const rawId = Number(s.id)
      if (rawId && oldById.has(rawId)) {
        target = oldById.get(rawId)
      } else {
        const byTitle = oldByTitle.get(name)
        if (byTitle && !seenOldIds.has(byTitle.id)) target = byTitle
      }

      if (target) {
        seenOldIds.add(target.id)
        if (target.scene_number !== i + 1 || target.title !== name || (target.summary || '') !== finalSummary) contentChanged++
        // 图片换了（上传/替换）才清空 gen_context——出图快照属于旧图；
        // 只改描述不动图时保留快照，让「描述改过→图过时」的判定继续成立
        const imgChanged = String(imgUrl || '').split('?')[0] !== String(target.image_url || '').split('?')[0]
        execute(
          'UPDATE scenes SET scene_number = ?, title = ?, summary = ?, image_url = ?, prop_names = ?, title_en = ?, summary_en = ?, lighting_en = ?, location = ?, space_type = ?, space_evidence = ?, gen_context = CASE WHEN ? THEN \'\' ELSE gen_context END WHERE id = ?',
          [i + 1, name, finalSummary, imgUrl, JSON.stringify(propNames), finalTitleEn, finalSummaryEn, finalLightingEn, finalLocation, finalSpaceType, finalSpaceEvidence, imgChanged ? 1 : 0, target.id]
        )
        finalSceneId = target.id
      } else {
        inserted++
        const ins = execute(
          'INSERT INTO scenes (episode_id, scene_number, title, summary, image_url, prop_names, title_en, summary_en, lighting_en, location, space_type, space_evidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [episodeId, i + 1, name, finalSummary, imgUrl, JSON.stringify(propNames), finalTitleEn, finalSummaryEn, finalLightingEn, finalLocation, finalSpaceType, finalSpaceEvidence]
        )
        finalSceneId = Number(ins.lastInsertRowid) || null
      }
    }

    const deletedRows = oldRowsTx.filter((r) => !seenOldIds.has(r.id))
    for (const r of deletedRows) execute('DELETE FROM scenes WHERE id = ?', [r.id])

    execute('DELETE FROM scene_analysis WHERE episode_id = ? AND scene_id NOT IN (SELECT id FROM scenes WHERE episode_id = ?)', [episodeId, episodeId])
    const deadSpatial = query(
      `SELECT anchor_key FROM scene_anchors WHERE episode_id = ? AND anchor_type = 'spatial' AND scene_id NOT IN (SELECT id FROM scenes WHERE episode_id = ?)`,
      [episodeId, episodeId]
    )
    for (const row of deadSpatial) {
      execute(`UPDATE spatial_group_review SET status = 'pending', baseline_image_url = '', updated_at = CURRENT_TIMESTAMP WHERE episode_id = ? AND spatial_group = ?`, [episodeId, row.anchor_key])
      execute(`DELETE FROM scene_anchors WHERE episode_id = ? AND anchor_type = 'spatial' AND anchor_key = ?`, [episodeId, row.anchor_key])
    }
    execute(`DELETE FROM scene_anchors WHERE episode_id = ? AND anchor_type = 'scene' AND scene_id NOT IN (SELECT id FROM scenes WHERE episode_id = ?)`, [episodeId, episodeId])

    restoreAssetStates(stateSnapshot)

    // 手动保存（source != extract）不做 AI 重析：把尚未归组的场景兜底补成「一场一组」，
    // 让新场景直接以组卡形态出现；再把指纹对齐到当前场景列表，让 ensureSceneAnalysis
    // 命中缓存、不触发 LLM。只有「重新提取资产」（source='extract'）才会让 AI 重新分组。
    if (source !== 'extract') {
      normalizeSceneGrouping(episodeId)
      const live = query('SELECT id, scene_number, title, summary, image_url FROM scenes WHERE episode_id = ? ORDER BY scene_number', [episodeId])
      execute('UPDATE scene_analysis SET fingerprint = ? WHERE episode_id = ?', [fingerprintOf(live), episodeId])
    }
  })

  const result = query('SELECT * FROM scenes WHERE episode_id = ? ORDER BY scene_number', [episodeId])

  res.json(result)
})

router.post('/:id/extract-info', (req, res) => {
  const { assetsScriptFp } = req.body
  if (!assetsScriptFp || !String(assetsScriptFp).trim()) {
    return res.status(400).json({ error: 'assetsScriptFp 必填' })
  }
  const episode = queryOne('SELECT id FROM episodes WHERE id = ?', [req.params.id])
  if (!episode) return res.status(404).json({ error: '集不存在' })
  execute('UPDATE episodes SET assets_script_fp = ? WHERE id = ?', [String(assetsScriptFp), req.params.id])
  res.json({ success: true })
})

router.post('/:id/storyboard', (req, res) => {
  const { storyboardScenes: incomingStoryboardScenes = [], storyboard_confirmed, storyboard_source } = req.body
  const defaultFieldSource = resolveStoryboardSource(storyboard_source)
  const storyboardScenes = normalizeStoryboardDocument({ scenes: incomingStoryboardScenes, source: defaultFieldSource }).scenes
  if (!Array.isArray(storyboardScenes) || storyboardScenes.length === 0) {
    return res.status(400).json({ error: 'storyboardScenes 不能为空' })
  }

  const episode = queryOne('SELECT id FROM episodes WHERE id = ?', [req.params.id])
  if (!episode) return res.status(404).json({ error: '集不存在' })

  const episodeCharacters = query('SELECT name, image_url FROM characters WHERE episode_id = ?', [req.params.id])
  const episodeScenes = query('SELECT scene_number, title, space_type, space_evidence, image_url FROM scenes WHERE episode_id = ?', [req.params.id])
  const episodeProps = query('SELECT name, image_url FROM props WHERE episode_id = ?', [req.params.id])
  const episodeAssetNames = {
    characters: episodeCharacters.map((r) => r.name),
    scenes: episodeScenes.map((r) => r.title),
    props: episodeProps.map((r) => r.name),
  }
  const sceneSpaceByNumber = new Map(episodeScenes.map((row) => [Number(row.scene_number), row]))
  for (const [sceneIndex, scene] of storyboardScenes.entries()) {
    const sceneNumber = Number(scene.sceneNumber ?? scene.scene_number ?? sceneIndex + 1)
    const sceneContext = sceneSpaceByNumber.get(sceneNumber) || episodeScenes.find((row) => {
      const title = String(scene.title || '').trim()
      const candidate = String(row.title || '').trim()
      return title && candidate && (title === candidate || title.includes(candidate) || candidate.includes(title))
    })
    for (const shot of scene.shots || []) {
      backfillShotAssets(shot, episodeAssetNames)
      backfillSceneByTitle(shot, scene.title, episodeAssetNames.scenes)
      backfillShotSpaceFromScene(shot, sceneContext)
    }
  }
  const validation = validateStoryboardImport({ scenes: storyboardScenes }, {
    characters: episodeCharacters,
    scenes: episodeScenes,
    props: episodeProps,
    requireReferenceImages: true,
    requireStyleDeclaration: true,
  })
  const wantsConfirmed = storyboard_confirmed === true || storyboard_confirmed === 1 || storyboard_confirmed === '1' || storyboard_confirmed === 'true'
  if (wantsConfirmed && !validation.ok) {
    return res.status(422).json({
      error: formatStoryboardValidationError(validation),
      code: 'STORYBOARD_CONTRACT_INVALID',
      errors: validation.errors,
      warnings: validation.warnings,
    })
  }

  transaction(() => {
    const episodeId = req.params.id

    const existingScenes = query('SELECT id, scene_number FROM storyboard_scenes WHERE episode_id = ?', [episodeId])
    const sceneIdByNum = new Map(existingScenes.map((s) => [s.scene_number, s.id]))
    const existingShots = query(
      `SELECT s.id, s.shot_uid, s.storyboard_scene_id, s.shot_number, s.description
       FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id
       WHERE ss.episode_id = ?
       ORDER BY ss.scene_number, s.start_time, s.id`,
      [episodeId]
    )

    const episodeAssetNames = {
      characters: episodeCharacters.map((r) => r.name),
      scenes: episodeScenes.map((r) => r.title),
      props: episodeProps.map((r) => r.name),
    }
    const shotIdByKey = new Map(existingShots.map((s) => [`${s.storyboard_scene_id}:${s.shot_number}`, s.id]))
    const shotIdByUid = new Map(existingShots.filter((s) => s.shot_uid).map((s) => [s.shot_uid, s.id]))
    // 兜底定位（镜号重排/本地镜号漂移时，避免把既有镜头误判成「新增+删除」而重建，令版本链断裂）
    // 分两级，均要求既有镜头尚未被认领、且同场次：
    //   1) 描述精确匹配 —— 内容未改动的镜头稳定命中（重排场景下最可靠）
    //   2) 同理时间轴起点 —— 描述也改过时就近对位，避免整体错位
    // 两者都不中才按新增插入，从而保留「真新增」语义
    const bySceneUnclaimed = (sceneId) =>
      existingShots.filter((s) => s.storyboard_scene_id === sceneId && !keepShotIds.has(s.id))

    const keepSceneIds = new Set()
    const keepShotIds = new Set()
    for (let si = 0; si < storyboardScenes.length; si++) {
      const s = storyboardScenes[si]
      const sceneNumber = si + 1
      const sceneTitle = s.title || `场次${sceneNumber}`
      let sceneId = sceneIdByNum.get(sceneNumber)
      if (sceneId == null) {
        const r = execute(
          'INSERT INTO storyboard_scenes (episode_id, scene_number, title) VALUES (?, ?, ?)',
          [episodeId, sceneNumber, sceneTitle]
        )
        sceneId = r.lastInsertRowid
      } else {
        execute('UPDATE storyboard_scenes SET title = ? WHERE id = ?', [sceneTitle, sceneId])
      }
      keepSceneIds.add(sceneId)

      for (let shi = 0; shi < (s.shots || []).length; shi++) {
        const shot = s.shots[shi]
        const shotNumber = shot.shotNumber || shot.shot_number || `${sceneNumber}-${shi + 1}`
        const desc = String(shot.description || '').trim()
        const incomingShotUid = shot.shotUid || shot.shot_uid || ''
        let shotId = incomingShotUid ? shotIdByUid.get(incomingShotUid) : null
        if (shotId == null) shotId = shotIdByKey.get(`${sceneId}:${shotNumber}`)
        // 内容优先：镜号命中行的描述与本次提交不符、而同场次另有未认领镜头描述精确匹配时，
        // 说明镜号不可信（重排/漂移），改认内容一致的那个，避免把既有镜头覆盖成别的镜
        if (shotId != null && desc) {
          const keyed = existingShots.find((s) => s.id === shotId)
          if (keyed && String(keyed.description || '').trim() !== desc) {
            const hit = bySceneUnclaimed(sceneId).find((s) => String(s.description || '').trim() === desc)
            if (hit) shotId = hit.id
          }
        }
        if (shotId == null) {
          const pool = bySceneUnclaimed(sceneId)
          // 1) 描述精确匹配：内容未改的镜头稳定命中
          if (desc) {
            const hit = pool.find((s) => String(s.description || '').trim() === desc)
            if (hit) shotId = hit.id
          }
          // 2) 描述也改过：按同场次内未认领镜头的时间轴顺序就近对位
          if (shotId == null) {
            const hit = pool[0]
            if (hit) shotId = hit.id
          }
        }

        // 锁定镜冻结：整场重存时既不删除、也不被新数据覆盖（人工精修优先于重生成结果）
        // 必须计入 keepShotIds，否则该镜会被下面 droppedShots 判定为「已删除」
        let frozenByLock = false
        if (shotId != null) {
          const existingLocked = queryOne('SELECT locked FROM shots WHERE id = ?', [shotId])
          if (existingLocked && existingLocked.locked) {
            keepShotIds.add(shotId)
            frozenByLock = true
            console.log(`[storyboard-save] 锁定镜头 ${shotNumber} 跳过重存覆盖`)
          }
        }
        if (frozenByLock) continue

        // 确定性回填已在校验前完成；这里再次调用仅覆盖锁定/并发场景下的输入保护。
        backfillShotAssets(shot, episodeAssetNames)
        backfillSceneByTitle(shot, sceneTitle, episodeAssetNames.scenes)
        backfillShotSpaceFromScene(shot, sceneSpaceByNumber.get(sceneNumber))

        // is_combat：显式布尔 → 1/0；显式 0/1 → 原值；否则 INSERT 走 classifyShotCombat 兜底、
        // UPDATE 传 null（配合 COALESCE 保留库中旧值）。与 /full 路径（generate-script.js）判定口径一致。
        const isCombatValue = shot.isCombat === true || shot.isCombat === false
          ? (shot.isCombat ? 1 : 0)
          : (shot.is_combat === 0 || shot.is_combat === 1
              ? shot.is_combat
              : (shotId == null ? (classifyShotCombat(shot) ? 1 : 0) : null))
        const fields = [
          shot.duration || config.storyboard?.defaultDuration || 8,
          shot.description || '',
          JSON.stringify(shot.characters || []),
          JSON.stringify(shot.sceneAssets || []),
          JSON.stringify(shot.propAssets || []),
          shot.storyboardUrl || '',
          shot.frameUrl || '',
          shot.blockingUrl || '',
          shot.videoUrl || '',
          shot.videoGenerated ? 1 : 0,
          shot.shotType || shot.shot_type || '',
          shot.startTime || shot.start_time || 0,
          shot.endTime || shot.end_time || 0,
          shot.actionNote || shot.action_note || '',
          shot.soundEffects || shot.sound_effects || '',
          serializeDialogue(shot.dialogue),
          shot.cameraMovement || shot.camera_movement || '',
          shot.overallSoundscape || shot.overall_soundscape || '',
          shot.nonDiegeticMusic || shot.non_diegetic_music || '',
          shot.integratedMultimodalDescription || shot.integrated_multimodal_description || '',
          shot.finalFrame || shot.final_frame || '',
          isCombatValue,
        ]
        const camAngle = shot.camera_angle || shot.cameraAngle || null
        // 叙事层字段：空值传 null，配合 COALESCE 在 UPDATE 时保留库中旧值
        const narrativeFields = [
          shot.purpose || null,
          shot.goal || null,
          shot.emotionTone || shot.emotion_tone || null,
          shot.infoPoints?.length ? JSON.stringify(shot.infoPoints)
            : (shot.info_points?.length ? JSON.stringify(shot.info_points) : null),
          shot.worldStateOut || shot.world_state_out || null,
          shot.worldStateOutEn || shot.world_state_out_en || null,
        ]
        const hasExplicitFieldSources = shot.fieldSources && Object.keys(shot.fieldSources).length > 0
        const incomingFieldSources = hasExplicitFieldSources
          ? mergeFieldSources({}, shot.fieldSources)
          : buildFieldSourcesForInput(shot, defaultFieldSource)
        const existingFieldSources = shotId == null
          ? {}
          : queryOne('SELECT field_sources_json FROM shots WHERE id = ?', [shotId])?.field_sources_json
        const fieldSourcesValue = JSON.stringify(mergeFieldSources(existingFieldSources, incomingFieldSources))

        if (shotId == null) {
          const r = execute(
            `INSERT INTO shots (storyboard_scene_id, shot_number, duration, description, characters, scene_assets, prop_assets, storyboard_url, frame_url, blocking_url, video_url, video_generated, shot_type, start_time, end_time, action_note, sound_effects, dialogue, camera_movement, overall_soundscape, non_diegetic_music, integrated_multimodal_description, final_frame, is_combat, camera_angle, purpose, goal, emotion_tone, info_points, world_state_out, world_state_out_en, field_sources_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [sceneId, shotNumber, ...fields, camAngle || '', ...narrativeFields, fieldSourcesValue]
          )
          const newShotId = r.lastInsertRowid
          execute('UPDATE shots SET shot_uid = ? WHERE id = ?', [ensureShotUid(incomingShotUid), newShotId])
          applyShotMetadataUpdate(newShotId, shot)
          keepShotIds.add(newShotId)
        } else {
          const planValue = shot.blockingPlan ? JSON.stringify(shot.blockingPlan) : ''
          const frameUrl2Value = shot.frameUrl2 !== undefined ? shot.frameUrl2 : ''
          const continuityUrlValue = shot.continuityUrl !== undefined ? shot.continuityUrl : ''
          const keyframeUrlValue = shot.keyframeUrl !== undefined ? shot.keyframeUrl : ''
          withShotVersionSnapshot(shotId, episodeId, 'save_overwrite', 'save', () => {
            execute(
              `UPDATE shots SET duration=?, description=?, characters=?, scene_assets=?, prop_assets=?, storyboard_url=?, frame_url=?, blocking_url=?, video_url=?, video_generated=?, shot_type=?, start_time=?, end_time=?, action_note=?, sound_effects=?, dialogue=?, camera_movement=?, overall_soundscape=COALESCE(NULLIF(?, ''), overall_soundscape), non_diegetic_music=COALESCE(NULLIF(?, ''), non_diegetic_music), integrated_multimodal_description=?, final_frame=?, is_combat=COALESCE(?, is_combat), camera_angle=COALESCE(?, camera_angle), purpose=COALESCE(?, purpose), goal=COALESCE(?, goal), emotion_tone=COALESCE(?, emotion_tone), info_points=COALESCE(?, info_points), world_state_out=COALESCE(?, world_state_out), world_state_out_en=COALESCE(?, world_state_out_en), blocking_plan=?, frame_url2=?, continuity_url=?, keyframe_url=?, field_sources_json=? WHERE id=?`,
              [...fields, camAngle, ...narrativeFields, planValue, frameUrl2Value, continuityUrlValue, keyframeUrlValue, fieldSourcesValue, shotId]
            )
            applyShotMetadataUpdate(shotId, shot)
          })
          keepShotIds.add(shotId)
        }
      }
    }

    const droppedShots = existingShots.filter((s) => !keepShotIds.has(s.id))
    const prunedShotIds = []
    for (const s of droppedShots) {
      const lockedRow = queryOne('SELECT locked FROM shots WHERE id = ?', [s.id])
      if (lockedRow && lockedRow.locked) {
        console.log(`[storyboard-save] 锁定镜头 ${s.shot_number || s.id} 跳过删除`)
        continue
      }
      forceSnapshotShot(s.id, episodeId, 'save_prune', 'save')
      execute('DELETE FROM shots WHERE id = ?', [s.id])
      prunedShotIds.push(s.id)
    }
    clearAlertsByRef('shot', prunedShotIds)
    const droppedSceneIds = existingScenes.filter((s) => !keepSceneIds.has(s.id)).map((s) => s.id)
    const prunedSceneIds = []
    const prunedSceneShotIds = []
    for (const s of droppedSceneIds) {
      const hasLocked = queryOne('SELECT id FROM shots WHERE storyboard_scene_id = ? AND locked = 1 LIMIT 1', [s])
      if (hasLocked) {
        console.log(`[storyboard-save] 场次 ${s} 含锁定镜头，跳过删除`)
        continue
      }
      const sceneShotIds = query('SELECT id FROM shots WHERE storyboard_scene_id = ?', [s]).map((r) => r.id)
      for (const sid of sceneShotIds) forceSnapshotShot(sid, episodeId, 'scene_prune', 'save')
      execute('DELETE FROM storyboard_scenes WHERE id = ?', [s])
      prunedSceneIds.push(s)
      prunedSceneShotIds.push(...sceneShotIds)
    }
    cancelJobsForShots([...prunedShotIds, ...prunedSceneShotIds])
    clearAlertsByRef('scene', prunedSceneIds)
    clearAlertsByRef('shot', prunedSceneShotIds)
    execute(
      `UPDATE shots SET shot_number = (
         SELECT ss.scene_number || '-' || (
           (SELECT COUNT(*) FROM shots s2
            WHERE s2.storyboard_scene_id = shots.storyboard_scene_id
              AND (s2.start_time < shots.start_time
                   OR (s2.start_time = shots.start_time AND s2.id < shots.id))
           ) + 1
         )
         FROM storyboard_scenes ss WHERE ss.id = shots.storyboard_scene_id
       )
       WHERE storyboard_scene_id IN (SELECT id FROM storyboard_scenes WHERE episode_id = ?)`,
      [episodeId]
    )
    // 镜号重排后同步刷新版本冗余镜号：历史版本始终跟随后端当前镜号，避免按旧镜号回溯落空
    if (hasShotVersionNumberCol()) {
      execute(
        `UPDATE shot_versions SET shot_number = COALESCE((
           SELECT s.shot_number FROM shots s WHERE s.id = shot_versions.shot_id
         ), shot_number)
         WHERE shot_id IN (
           SELECT s.id FROM shots s JOIN storyboard_scenes ss ON ss.id = s.storyboard_scene_id
           WHERE ss.episode_id = ?
         )`,
        [episodeId]
      )
    }
    refreshWorldStateIn(episodeId)
  })
  const epForFp = queryOne('SELECT script_content FROM episodes WHERE id = ?', [req.params.id])
  if (epForFp?.script_content) {
    execute('UPDATE episodes SET storyboard_script_fp = ? WHERE id = ?', [scriptHash(epForFp.script_content), req.params.id])
  }
  const normalizedSource = storyboard_source === 'imported' ? 'imported' : 'generated'
  execute('UPDATE episodes SET storyboard_source = ? WHERE id = ?', [normalizedSource, req.params.id])
  const confirmed = storyboard_confirmed === true || storyboard_confirmed === 1 || storyboard_confirmed === '1' || storyboard_confirmed === 'true'
  // 草稿始终保持未确认；只有通过完整契约校验的提交才能进入确认态。
  execute('UPDATE episodes SET storyboard_confirmed = ? WHERE id = ?', [confirmed && validation.ok ? 1 : 0, req.params.id])
  scheduleEnglishSync(req.params.id)
  res.json({ success: true, validation, storyboard_confirmed: confirmed && validation.ok })
})

router.delete('/:id/storyboard', (req, res) => {
  const episodeId = req.params.id
  try {
    transaction(() => {
      const droppedShotIds = query(
        `SELECT shots.id FROM shots
         JOIN storyboard_scenes ss ON ss.id = shots.storyboard_scene_id
         WHERE ss.episode_id = ?`,
        [episodeId]
      ).map((r) => r.id)
      for (const id of droppedShotIds) forceSnapshotShot(id, episodeId, 'storyboard_reset', 'save')
      if (droppedShotIds.length) console.log(`[storyboard-reset] 删除前已快照 ${droppedShotIds.length} 个镜头进 shot_versions`)
      for (const id of droppedShotIds) execute('DELETE FROM shots WHERE id = ?', [id])
      cancelJobsForShots(droppedShotIds)
      clearAlertsByRef('shot', droppedShotIds)
      const droppedSceneIds = query('SELECT id FROM storyboard_scenes WHERE episode_id = ?', [episodeId]).map((r) => r.id)
      execute('DELETE FROM storyboard_scenes WHERE episode_id = ?', [episodeId])
      clearAlertsByRef('scene', droppedSceneIds)
      execute('UPDATE episodes SET storyboard_script_fp = NULL, storyboard_confirmed = 0, storyboard_source = ? WHERE id = ?', ['generated', episodeId])
    })
    res.json({ success: true })
  } catch (e) {
    console.error('[清空分镜失败]', e)
    res.status(500).json({ error: e.message || '清空分镜失败' })
  }
})

router.put('/:id/shots/:shotId', (req, res) => {
  const {
    storyboard_url, frame_url, frame_url2, blocking_url, video_url, video_generated,
    description, duration, shot_type, start_time, end_time, action_note,
    sound_effects, dialogue, camera_movement, overall_soundscape,
    non_diegetic_music, integrated_multimodal_description, blocking_plan, blockingPlan, final_frame, finalFrame,
    video_prompt_override,
    is_combat,
    locked,
    camera_angle, cameraAngle,
    purpose, goal,
    emotion_tone, emotionTone,
    info_points, infoPoints,
    world_state_out, worldStateOut,
    world_state_out_en, worldStateOutEn,
  } = req.body
  console.log('[/episodes/:id/shots/:shotId] update', { episodeId: req.params.id, shotId: req.params.shotId, hasStoryboardUrl: !!storyboard_url, hasFrameUrl: !!frame_url, hasFrameUrl2: frame_url2 !== undefined, hasBlockingUrl: !!blocking_url, hasBlockingPlan: blocking_plan !== undefined })

  const ownedShot = queryOne(
    `SELECT s.id FROM shots s
       JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id
      WHERE s.id = ? AND ss.episode_id = ?`,
    [req.params.shotId, req.params.id]
  )
  if (!ownedShot) {
    return res.status(404).json({ error: '镜头不存在或不属于该集' })
  }
  // 锁定镜拒写：锁定 = 冻结，仅放行"单独解锁"（body 只含 locked: 0），其余编辑一律 409
  const existingShot = queryOne('SELECT locked, start_time, end_time, duration FROM shots WHERE id = ?', [req.params.shotId])
  if (existingShot?.locked) {
    const bodyKeys = Object.keys(req.body || {}).filter((k) => req.body[k] !== undefined)
    const isUnlockOnly = bodyKeys.length === 1 && bodyKeys[0] === 'locked' && !req.body.locked
    if (!isUnlockOnly) {
      return res.status(409).json({ error: '镜头已锁定，编辑被拒绝；请先解锁（锁定镜仅允许单独的解锁操作）' })
    }
  }
  let blockingPlanValue
  if (blocking_plan !== undefined) {
    blockingPlanValue = typeof blocking_plan === 'object' ? JSON.stringify(blocking_plan) : blocking_plan
  } else if (blockingPlan !== undefined) {
    blockingPlanValue = typeof blockingPlan === 'object' ? JSON.stringify(blockingPlan) : blockingPlan
  } else {
    blockingPlanValue = null
  }
  const finalFrameValue = final_frame !== undefined ? final_frame : (finalFrame !== undefined ? finalFrame : null)
  const infoPointsValue = (() => {
    const v = info_points ?? infoPoints
    if (Array.isArray(v)) return v.length ? JSON.stringify(v) : null
    if (typeof v === 'string' && v.trim()) return v
    return null
  })()
  const narrativeValues = [
    purpose ?? null,
    goal ?? null,
    emotion_tone ?? emotionTone ?? null,
    infoPointsValue,
    world_state_out ?? worldStateOut ?? null,
    world_state_out_en ?? worldStateOutEn ?? null,
  ]
  const manualFieldSources = JSON.stringify(mergeFieldSources(
    queryOne('SELECT field_sources_json FROM shots WHERE id = ?', [req.params.shotId])?.field_sources_json,
    buildFieldSourcesForInput(req.body, FIELD_SOURCE.MANUAL),
  ))
  // 契约五件套已退役（2026-10-01）：不再写入。英文新鲜度由 english_source_fp 指纹管理，
  // 编辑后的英文同步由 scheduleEnglishSync 负责。
  withShotVersionSnapshot(req.params.shotId, req.params.id, 'manual_edit', 'manual', () => {
    execute(
      `UPDATE shots SET
         storyboard_url = COALESCE(?, storyboard_url),
         frame_url = COALESCE(?, frame_url),
         frame_url2 = COALESCE(?, frame_url2),
         blocking_url = COALESCE(?, blocking_url),
         video_url = COALESCE(?, video_url),
         video_generated = COALESCE(?, video_generated),
         description = COALESCE(?, description),
         duration = COALESCE(?, duration),
         shot_type = COALESCE(?, shot_type),
         start_time = COALESCE(?, start_time),
         end_time = COALESCE(?, end_time),
         action_note = COALESCE(?, action_note),
         sound_effects = COALESCE(?, sound_effects),
         dialogue = COALESCE(?, dialogue),
         camera_movement = COALESCE(?, camera_movement),
         overall_soundscape = COALESCE(NULLIF(?, ''), overall_soundscape),
         non_diegetic_music = COALESCE(NULLIF(?, ''), non_diegetic_music),
         integrated_multimodal_description = COALESCE(?, integrated_multimodal_description),
         blocking_plan = COALESCE(?, blocking_plan),
         final_frame = COALESCE(?, final_frame),
         video_prompt_override = COALESCE(?, video_prompt_override),
         is_combat = COALESCE(?, is_combat),
         locked = COALESCE(?, locked),
         camera_angle = COALESCE(?, camera_angle),
         purpose = COALESCE(?, purpose),
         goal = COALESCE(?, goal),
         emotion_tone = COALESCE(?, emotion_tone),
         info_points = COALESCE(?, info_points),
        world_state_out = COALESCE(?, world_state_out),
        world_state_out_en = COALESCE(?, world_state_out_en),
        field_sources_json = ?
      WHERE id = ?`,
      [storyboard_url, frame_url, frame_url2, blocking_url, video_url, video_generated, description, duration,
        shot_type, start_time, end_time, action_note, sound_effects, dialogue,
        camera_movement, overall_soundscape, non_diegetic_music,
        integrated_multimodal_description, blockingPlanValue, finalFrameValue,
        (typeof video_prompt_override === 'string' && video_prompt_override.trim()) ? video_prompt_override.trim() : null,
        is_combat !== undefined ? (is_combat ? 1 : 0) : null,
        locked !== undefined ? (locked ? 1 : 0) : null,
        (camera_angle !== undefined ? camera_angle : cameraAngle) || null,
        ...narrativeValues, manualFieldSources,
        req.params.shotId,
      ]
    )
    applyShotMetadataUpdate(req.params.shotId, req.body)
  })
  // 时轴顺延（#4）：duration/start_time/end_time 任一被编辑时，重算本镜 end_time 并平移后续镜
  const timelineTouched = duration !== undefined || start_time !== undefined || end_time !== undefined
  if (timelineTouched && existingShot) {
    const shiftedCount = shiftFollowingShots(req.params.id, req.params.shotId, existingShot.end_time)
    if (shiftedCount) console.log(`[PUT shot] 时轴顺延：后续 ${shiftedCount} 镜已平移`)
  }
  refreshWorldStateIn(req.params.id)
  scheduleEnglishSync(req.params.id)
  const shot = queryOne('SELECT * FROM shots WHERE id = ?', [req.params.shotId])
  // 单镜编辑可能破坏整集契约；合法编辑保留确认态，失败则自动撤销，阻止旧确认状态绕过 H3 门禁。
  const episodeRows = query(
    `SELECT s.*, ss.scene_number, ss.title AS scene_title
       FROM shots s JOIN storyboard_scenes ss ON ss.id = s.storyboard_scene_id
      WHERE ss.episode_id = ? ORDER BY ss.scene_number, s.start_time, s.id`,
    [req.params.id]
  )
  const editValidation = validateStoryboardImport(
    { scenes: (() => {
      const byScene = new Map()
      for (const row of episodeRows) {
        const key = Number(row.scene_number)
        if (!byScene.has(key)) byScene.set(key, { sceneNumber: key, title: row.scene_title, shots: [] })
        byScene.get(key).shots.push(row)
      }
      return [...byScene.values()]
    })() },
    {
      characters: query('SELECT name, image_url FROM characters WHERE episode_id = ?', [req.params.id]),
      scenes: query('SELECT title, image_url FROM scenes WHERE episode_id = ?', [req.params.id]),
      props: query('SELECT name, image_url FROM props WHERE episode_id = ?', [req.params.id]),
      requireReferenceImages: true,
      requireStyleDeclaration: true,
    }
  )
  const currentEpisode = queryOne('SELECT storyboard_confirmed FROM episodes WHERE id = ?', [req.params.id])
  if (currentEpisode?.storyboard_confirmed && !editValidation.ok) {
    execute('UPDATE episodes SET storyboard_confirmed = 0 WHERE id = ?', [req.params.id])
  }
  res.json({ ...shot, storyboardConfirmed: !!(currentEpisode?.storyboard_confirmed && editValidation.ok), validation: editValidation })
})

// ---- 单镜重生成 + 版本链（#2）----

// 时间轴相邻镜（跨场口径，与 refreshWorldStateIn 一致）：prev 供 Airlock 继承，next 供出画状态约束
function getTimelineNeighbors(episodeId, shotRow) {
  const prev = queryOne(
    `SELECT s.shot_number, s.final_frame, s.world_state_out FROM shots s
       JOIN storyboard_scenes ss ON ss.id = s.storyboard_scene_id
      WHERE ss.episode_id = ?
        AND (s.start_time < ? OR (s.start_time = ? AND s.id < ?))
      ORDER BY s.start_time DESC, s.id DESC LIMIT 1`,
    [episodeId, shotRow.start_time, shotRow.start_time, shotRow.id]
  )
  const next = queryOne(
    `SELECT s.shot_number, s.world_state_in FROM shots s
       JOIN storyboard_scenes ss ON ss.id = s.storyboard_scene_id
      WHERE ss.episode_id = ?
        AND (s.start_time > ? OR (s.start_time = ? AND s.id > ?))
      ORDER BY s.start_time ASC, s.id ASC LIMIT 1`,
    [episodeId, shotRow.start_time, shotRow.start_time, shotRow.id]
  )
  return { prev: prev || null, next: next || null }
}

// 供 AI 使用的资产清单（名字 + 描述 + 参考图标记，喂给 buildAssetListPrompt）
function getEpisodeAssetsForAi(episodeId) {
  const characters = query(
    'SELECT name, name_en, description, description_en, image_url FROM characters WHERE episode_id = ?',
    [episodeId]
  )
  const scenes = query(
    'SELECT title, title_en, summary, summary_en, image_url, prop_names, lighting_en, space_type FROM scenes WHERE episode_id = ?',
    [episodeId]
  ).map((s) => {
    let propNames = []
    try { propNames = JSON.parse(s.prop_names || '[]') } catch { propNames = [] }
    return { ...s, description: s.summary, props: propNames }
  })
  const props = query(
    'SELECT name, name_en, description, description_en, image_url, owner FROM props WHERE episode_id = ?',
    [episodeId]
  )
  return { characters, scenes, props }
}

function parseJsonArraySafe(raw, fallback = []) {
  try {
    const v = JSON.parse(raw || '[]')
    return Array.isArray(v) ? v : fallback
  } catch { return fallback }
}

// 单镜重生成：锁定镜拒绝；重写内容字段 + 清空衍生产出物（旧图/旧视频与新内容不符，回退版本可找回）
router.post('/:id/shots/:shotId/regenerate', async (req, res) => {
  const { instruction = '' } = req.body || {}
  const ownedShot = queryOne(
    `SELECT s.id FROM shots s
       JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id
      WHERE s.id = ? AND ss.episode_id = ?`,
    [req.params.shotId, req.params.id]
  )
  if (!ownedShot) {
    return res.status(404).json({ error: '镜头不存在或不属于该集' })
  }
  const row = queryOne('SELECT * FROM shots WHERE id = ?', [req.params.shotId])
  if (!row) return res.status(404).json({ error: '镜头不存在' })
  if (row.locked) {
    return res.status(409).json({ error: '镜头已锁定，锁定镜头不会被重生成覆盖，请先解锁' })
  }

  const episode = queryOne('SELECT * FROM episodes WHERE id = ?', [req.params.id])
  if (!episode) return res.status(404).json({ error: '集不存在' })
  const project = queryOne('SELECT p.art_style, sp.category_key AS style_category FROM projects p LEFT JOIN style_presets sp ON sp.label = p.art_style WHERE p.id = ?', [episode.project_id])
  const scene = queryOne('SELECT title FROM storyboard_scenes WHERE id = ?', [row.storyboard_scene_id])
  const { prev, next } = getTimelineNeighbors(req.params.id, row)
  const related = row.related_shot_id
    ? queryOne('SELECT shot_number, description, world_state_out FROM shots WHERE id = ?', [row.related_shot_id])
    : null
  const assets = getEpisodeAssetsForAi(req.params.id)

  const ctx = {
    current: {
      shotNumber: row.shot_number,
      duration: row.duration,
      startTime: row.start_time,
      shotType: row.shot_type,
      cameraMovement: row.camera_movement,
      cameraAngle: row.camera_angle,
      description: row.description,
      actionNote: row.action_note,
      characters: parseJsonArraySafe(row.characters),
      sceneAssets: parseJsonArraySafe(row.scene_assets),
      propAssets: parseJsonArraySafe(row.prop_assets),
      dialogue: parseDialogue(row.dialogue),
      purpose: row.purpose,
      goal: row.goal,
      emotionTone: row.emotion_tone,
      infoPoints: parseJsonArraySafe(row.info_points),
      worldStateOut: row.world_state_out,
      worldStateOutEn: row.world_state_out_en,
    },
    prev,
    next,
    related: related || null,
    sceneTitle: scene?.title || '',
    scriptSpan: row.script_span || '',
    instruction: String(instruction || '').trim(),
  }

  let regen
  try {
    regen = await regenerateShot(ctx, assets, project?.art_style || config.defaultArtStyle, {
      styleCategory: project?.style_category || '',
    })
  } catch (e) {
    console.error('[单镜重生成] 失败', e)
    return res.status(502).json({ error: e.message || '单镜重生成失败' })
  }

  const shot = regen.shot
  // 对白时间从镜内相对秒换算为全片绝对秒（与整场生成的存储口径一致）
  const baseStart = Number(row.start_time) || 0
  const dialogueList = Array.isArray(shot.dialogue)
    ? shot.dialogue.map((d) => ({
        ...d,
        startTime: Math.round(((Number(d.startTime) || 0) + baseStart) * 1000) / 1000,
        endTime: Math.round(((Number(d.endTime) || 0) + baseStart) * 1000) / 1000,
      }))
    : null

  const aiFieldSources = JSON.stringify(mergeFieldSources(
    row.field_sources_json,
    buildFieldSourcesForInput(shot, FIELD_SOURCE.AI),
  ))

  withShotVersionSnapshot(req.params.shotId, req.params.id, 'regenerate', 'ai', () => {
    execute(
      `UPDATE shots SET
         description = ?, shot_type = ?, camera_movement = ?, camera_angle = COALESCE(?, camera_angle),
         action_note = ?, sound_effects = ?,
         overall_soundscape = COALESCE(NULLIF(?, ''), overall_soundscape),
         non_diegetic_music = COALESCE(NULLIF(?, ''), non_diegetic_music),
         integrated_multimodal_description = ?, final_frame = ?,
         is_combat = COALESCE(?, is_combat),
         purpose = COALESCE(?, purpose), goal = COALESCE(?, goal),
         emotion_tone = COALESCE(?, emotion_tone), info_points = COALESCE(?, info_points),
         world_state_out = COALESCE(?, world_state_out),
         world_state_out_en = COALESCE(?, world_state_out_en),
         dialogue = ?, characters = ?, scene_assets = ?, prop_assets = ?,
         frame_url = '', frame_url2 = '', continuity_url = '', keyframe_url = '',
         blocking_url = '', blocking_plan = NULL, video_url = '', video_generated = 0, video_prompt_override = '',
         compiled_prompt = '', prompt_provider_id = '', prompt_compiled_at = NULL,
         field_sources_json = ?
       WHERE id = ?`,
      [
        shot.description || '', shot.shotType || '', shot.cameraMovement || '',
        shot.camera_angle || null,
        shot.actionNote || '', shot.soundEffects || '',
        shot.overallSoundscape || '', shot.nonDiegeticMusic || '',
        shot.integratedMultimodalDescription || '', shot.finalFrame || '',
        typeof shot.isCombat === 'boolean' ? (shot.isCombat ? 1 : 0) : null,
        shot.purpose || null, shot.goal || null,
        shot.emotionTone || null,
        shot.infoPoints?.length ? JSON.stringify(shot.infoPoints) : null,
        shot.worldStateOut || null,
        shot.worldStateOutEn || null,
        dialogueList?.length ? serializeDialogue(dialogueList) : null,
        JSON.stringify(shot.characters || []), JSON.stringify(shot.sceneAssets || []), JSON.stringify(shot.propAssets || []), aiFieldSources,
        req.params.shotId,
      ]
    )
    applyShotMetadataUpdate(req.params.shotId, shot)
  })
  refreshWorldStateIn(req.params.id)
  scheduleEnglishSync(req.params.id)
  const updated = queryOne('SELECT * FROM shots WHERE id = ?', [req.params.shotId])
  res.json({ success: true, shot: updated })
})

// 版本列表：当前版（shots 行）+ 历史快照（shot_versions 倒序）
router.get('/:id/shots/:shotId/versions', (req, res) => {
  const ownedShot = queryOne(
    `SELECT s.id FROM shots s
       JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id
      WHERE s.id = ? AND ss.episode_id = ?`,
    [req.params.shotId, req.params.id]
  )
  if (!ownedShot) {
    return res.status(404).json({ error: '镜头不存在或不属于该集' })
  }
  const current = queryOne('SELECT * FROM shots WHERE id = ?', [req.params.shotId])
  if (!current) return res.status(404).json({ error: '镜头不存在' })
  const versions = query(
    'SELECT id, version, edited_by, reason, snapshot, created_at FROM shot_versions WHERE shot_id = ? ORDER BY version DESC, id DESC',
    [req.params.shotId]
  ).map((v) => {
    let snapshot = null
    try { snapshot = JSON.parse(v.snapshot || '{}') } catch { snapshot = {} }
    return {
      id: v.id,
      version: v.version,
      editedBy: v.edited_by,
      reason: v.reason,
      createdAt: v.created_at,
      snapshot,
    }
  })
  res.json({
    current: {
      version: current.version || 1,
      editedBy: current.edited_by || '',
      shot: current,
    },
    versions,
  })
})

// 版本内容字段清单：回退时恢复"内容 + 衍生产出物"，不恢复时轴位置/锁定/结构字段
const SHOT_RESTORE_CONTENT_COLS = [
  'description', 'shot_type', 'camera_movement', 'camera_angle', 'camera_elevation', 'action_note', 'sound_effects',
  'overall_soundscape', 'non_diegetic_music', 'integrated_multimodal_description', 'final_frame',
  'is_combat', 'purpose', 'goal', 'emotion_tone', 'info_points', 'world_state_out', 'world_state_out_en',
  'dialogue', 'characters', 'scene_assets', 'prop_assets',
  'frame_url', 'frame_url2', 'continuity_url', 'keyframe_url', 'blocking_url', 'blocking_plan',
  'video_url', 'video_generated', 'video_prompt_override',
  'beat_id', 'coverage_id', 'relation_type', 'related_shots_json',
  'composition', 'lens', 'depth_of_field', 'transition_in', 'transition_out', 'color_lighting',
  'space_type', 'space_evidence',
  'prompt_provider_id', 'compiled_prompt', 'prompt_compiled_at',
]

// 回退到指定版本快照：先快照当前值（回退本身可撤销），再用快照覆盖内容与产出物
router.post('/:id/shots/:shotId/versions/:versionId/restore', (req, res) => {
  const ownedShot = queryOne(
    `SELECT s.id FROM shots s
       JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id
      WHERE s.id = ? AND ss.episode_id = ?`,
    [req.params.shotId, req.params.id]
  )
  if (!ownedShot) {
    return res.status(404).json({ error: '镜头不存在或不属于该集' })
  }
  const current = queryOne('SELECT * FROM shots WHERE id = ?', [req.params.shotId])
  if (!current) return res.status(404).json({ error: '镜头不存在' })
  if (current.locked) {
    return res.status(409).json({ error: '镜头已锁定，锁定镜头不回退版本，请先解锁' })
  }
  const versionRow = queryOne(
    'SELECT * FROM shot_versions WHERE id = ? AND shot_id = ?',
    [req.params.versionId, req.params.shotId]
  )
  if (!versionRow) return res.status(404).json({ error: '版本不存在' })
  let snapshot
  try { snapshot = JSON.parse(versionRow.snapshot || '{}') } catch { snapshot = null }
  if (!snapshot || !Object.keys(snapshot).length) {
    return res.status(422).json({ error: '版本快照数据损坏，无法回退' })
  }

  let restoredDuration = null
  withShotVersionSnapshot(req.params.shotId, req.params.id, 'version_restore', 'manual', () => {
    const sets = SHOT_RESTORE_CONTENT_COLS.map((c) => `${c} = ?`).join(', ')
    const values = SHOT_RESTORE_CONTENT_COLS.map((c) => snapshot[c] ?? null)
    const restoredFieldSources = JSON.stringify(mergeFieldSources(
      current.field_sources_json,
      buildFieldSourcesForInput(snapshot, FIELD_SOURCE.VERSION_RESTORE),
    ))
    // duration 属于内容属性：恢复并同步本镜 end_time（后续镜时轴由顺延逻辑/质检处理）
    restoredDuration = Number.isFinite(Number(snapshot.duration)) ? Number(snapshot.duration) : null
    const setClause = restoredDuration != null
      ? `${sets}, field_sources_json = ?, duration = ?, end_time = ? + start_time`
      : `${sets}, field_sources_json = ?`
    const tail = restoredDuration != null
      ? [restoredFieldSources, restoredDuration, restoredDuration]
      : [restoredFieldSources]
    execute(
      `UPDATE shots SET ${setClause} WHERE id = ?`,
      [...values, ...tail, req.params.shotId]
    )
  })
  if (restoredDuration != null && Number(restoredDuration) !== Number(current.duration)) {
    shiftFollowingShots(req.params.id, req.params.shotId, current.end_time)
  }
  refreshWorldStateIn(req.params.id)
  const updated = queryOne('SELECT * FROM shots WHERE id = ?', [req.params.shotId])
  res.json({ success: true, shot: updated })
})

function moveUploadsToTrash(urls, trashDir) {
  const root = path.resolve(uploadsDir)
  let moved = 0
  for (const u of urls || []) {
    if (!u || !String(u).startsWith(UPLOADS_URL_SLASH)) continue
    try {
      const rel = decodeURIComponent(String(u).split(/[?#]/)[0]).replace(UPLOADS_PREFIX_RE, '')
      const abs = path.resolve(root, rel)
      if (abs === root || !abs.startsWith(root + path.sep)) continue
      if (!fs.existsSync(abs)) continue
      const dest = path.join(trashDir, rel)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      try {
        fs.renameSync(abs, dest)
      } catch {
        fs.copyFileSync(abs, dest)
        fs.unlinkSync(abs)
      }
      moved++
    } catch {  }
  }
  return moved
}

function deleteShotVideos(episodeId, rawShotIds) {
  const skipped = []
  const requested = [...new Set(
    (Array.isArray(rawShotIds) ? rawShotIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0)
  )]

  const epShots = query(
    `SELECT s.id, s.shot_number, s.video_url
       FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id
       WHERE ss.episode_id = ?`,
    [episodeId]
  )
  const shotById = new Map(epShots.map((s) => [Number(s.id), s]))

  const shotIdsToClear = new Set()
  for (const sid of requested) {
    const shot = shotById.get(sid)
    if (!shot) { skipped.push({ shotId: sid, reason: '镜头不存在' }); continue }
    if (shot.video_url) shotIdsToClear.add(sid)
    else skipped.push({ shotId: sid, reason: '该镜头没有成片' })
  }
  const fileCandidates = []
  for (const sid of shotIdsToClear) {
    const u = shotById.get(sid)?.video_url
    if (u) fileCandidates.push(u)
  }
  transaction(() => {
    for (const sid of shotIdsToClear) {
      execute(
        "UPDATE shots SET video_url = '', video_generated = 0, shot_review = NULL, seam_check = '', retry_feedback = '' WHERE id = ?",
        [sid]
      )
    }
    for (const sid of shotIdsToClear) {
      try { execute('DELETE FROM salvage_queue WHERE shot_id = ?', [sid]) } catch {  }
    }
  })

  let alertsCleared = 0
  for (const sid of shotIdsToClear) alertsCleared += resolveAlertsByShot(sid, 'del')

  const trashDir = path.join(serverDir, '..', '_video_trash', String(Date.now()))
  const movedFiles = moveUploadsToTrash(filterUnreferencedUploadUrls(fileCandidates), trashDir)
  const shotsOut = [...shotIdsToClear]
    .sort((a, b) => a - b)
    .map((sid) => ({ id: sid, shotNumber: shotById.get(sid)?.shot_number || '' }))
  return { ok: true, episodeId: Number(episodeId), shots: shotsOut, movedFiles, alertsCleared, skipped }
}

router.delete('/:episodeId/shots/:shotId/video', (req, res) => {
  const episode = queryOne('SELECT id FROM episodes WHERE id = ?', [req.params.episodeId])
  if (!episode) return res.status(404).json({ error: '集不存在' })
  try {
    res.json(deleteShotVideos(episode.id, [req.params.shotId]))
  } catch (e) {
    console.error('[删除成片失败]', e)
    res.status(500).json({ error: e.message || '删除成片失败' })
  }
})

router.post('/:episodeId/shots/video-delete', (req, res) => {
  const episode = queryOne('SELECT id FROM episodes WHERE id = ?', [req.params.episodeId])
  if (!episode) return res.status(404).json({ error: '集不存在' })
  const { shotIds } = req.body || {}
  if (!Array.isArray(shotIds)) return res.status(400).json({ error: 'shotIds 必须是数组' })
  try {
    res.json(deleteShotVideos(episode.id, shotIds))
  } catch (e) {
    console.error('[批量删除成片失败]', e)
    res.status(500).json({ error: e.message || '批量删除成片失败' })
  }
})

router.post('/:id/characters/:characterId/audio', (req, res) => {
  try {
    const { audioBase64 } = req.body
    if (!audioBase64) {
      return res.status(400).json({ error: '缺少音频数据' })
    }

    const base64Data = audioBase64.replace(/^data:audio\/\w+;base64,/, '')
    const extMatch = audioBase64.match(/^data:audio\/(\w+);base64,/)
    let ext = extMatch ? extMatch[1] : 'mp3'
    if (ext === 'mpeg') ext = 'mp3'

    const timestamp = Date.now()
    const random = Math.random().toString(36).substring(2, 8)
    const filename = `char_audio_${timestamp}_${random}.${ext}`
    const filepath = path.join(uploadsDir, filename)

    fs.writeFileSync(filepath, Buffer.from(base64Data, 'base64'))

    const audioUrl = `${uploadsUrl(filename)}`

    const target = queryOne('SELECT * FROM characters WHERE id = ?', [req.params.characterId])
    if (target?.project_character_id) {
      updateProjectCharacter(target.project_character_id, { audio_url: audioUrl })
      syncProjectCharacterToEpisodes(target.project_character_id)
    } else {
      execute('UPDATE characters SET audio_url = ? WHERE id = ?', [audioUrl, req.params.characterId])
    }

    const character = queryOne('SELECT * FROM characters WHERE id = ?', [req.params.characterId])
    res.json(character)
  } catch (e) {
    console.error('[AUDIO UPLOAD ERROR]', e)
    res.status(500).json({ error: '上传失败: ' + e.message })
  }
})

router.delete('/:id/characters/:characterId/audio', (req, res) => {
  try {
    const character = queryOne('SELECT * FROM characters WHERE id = ?', [req.params.characterId])
    if (!character) {
      return res.status(404).json({ error: '角色不存在' })
    }

    if (character.project_character_id) {
      updateProjectCharacter(character.project_character_id, { audio_url: '' }, { allowClear: true })
      syncProjectCharacterToEpisodes(character.project_character_id)
    } else {
      execute('UPDATE characters SET audio_url = ? WHERE id = ?', ['', req.params.characterId])
    }

    if (character.audio_url) {
      removeLocalUploads(filterUnreferencedUploadUrls([character.audio_url]))
    }

    const updated = queryOne('SELECT * FROM characters WHERE id = ?', [req.params.characterId])
    res.json(updated)
  } catch (e) {
    console.error('[AUDIO DELETE ERROR]', e)
    res.status(500).json({ error: '删除失败: ' + e.message })
  }
})

export default router
