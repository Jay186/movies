import { Router } from 'express'
import fs from 'fs'
import path from 'path'

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true })

import { removeLocalUploads as removeLocalUploadsShared, filterUnreferencedUploadUrls } from '../ai/shared.js'
const removeLocalUploads = (urls) => removeLocalUploadsShared(urls, uploadsDir)

import { query, queryOne, execute, transaction } from '../db.js'
import { ensureStandardScript } from '../ai/scriptFormat.js'
import { scriptHash } from '../scriptHash.js'
import {
  mergeMasterIntoEpisodeCharacters,
  replaceEpisodeCharacters,
  updateProjectCharacter,
  syncProjectCharacterToEpisodes,
} from '../characterLibrary.js'
import { backfillShotAssets } from '../ai/assetBackfill.js'
import { parseDialogue, serializeDialogue } from '../ai/dialogue.js'
import { resolveAlertsByShot, recordAlert } from '../ai/alerts.js'
import { runLightingChecks } from '../ai/lightingCheckRuntime.js'
import {
  snapshotBeforeExtract,
  computeExtractDiff,
  applyKeepForScenes,
  applyKeepForProps,
} from '../ai/extractGuard.js'
import { clearQcIgnores } from './qc.js'
import { config } from '../config.js'
import { ASSET_TYPES } from '../ai/assetTypes.js'
import { fingerprintOf } from '../ai/sceneAnchors.js'
import { serverDir, uploadsDir } from '../paths.js'

const router = Router()

const STATE_COLS = ['asset_type', 'asset_key', 'state_key', 'label_zh', 'description', 'description_en', 'image_url', 'is_default', 'source']

function snapshotAssetStatesForNames(assetType, names) {
  if (!config.assetState?.enabled) return []
  if (!ASSET_TYPES.includes(assetType)) return []
  const keys = [...new Set((names || []).map((n) => String(n || '').trim()).filter(Boolean))]
  if (!keys.length) return []
  try {
    const out = []
    for (const k of keys) {
      const rows = query(
        `SELECT ${STATE_COLS.join(', ')} FROM asset_states WHERE asset_type = ? AND asset_key = ?`,
        [assetType, k]
      )
      out.push(...rows)
    }
    return out
  } catch (e) {
    console.warn(`[episodes] 状态行快照失败（不阻断保存）: ${e.message}`)
    return []
  }
}

function restoreAssetStates(rows) {
  if (!config.assetState?.enabled) return 0
  if (!Array.isArray(rows) || !rows.length) return 0
  let n = 0
  try {
    for (const r of rows) {
      execute(
        `INSERT OR IGNORE INTO asset_states (${STATE_COLS.join(', ')})
         VALUES (${STATE_COLS.map(() => '?').join(', ')})`,
        STATE_COLS.map((c) => r[c])
      )
      n++
    }
  } catch (e) {
    console.warn(`[episodes] 状态行回迁失败（不阻断保存）: ${e.message}`)
  }
  return n
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
  const ownedSceneIds = query('SELECT id FROM scenes WHERE episode_id = ?', [episode.id]).map((r) => r.id)
  const ownedPropIds = query('SELECT id FROM props WHERE episode_id = ?', [episode.id]).map((r) => r.id)

  const rows = query(
    `SELECT c.image_url u FROM characters c WHERE c.episode_id = ?
     UNION ALL SELECT c2.audio_url FROM characters c2 WHERE c2.episode_id = ?
     UNION ALL SELECT p.image_url FROM props p WHERE p.episode_id = ?
     UNION ALL SELECT sc.image_url FROM scenes sc WHERE sc.episode_id = ?
     UNION ALL SELECT s.storyboard_url FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id WHERE ss.episode_id = ?
     UNION ALL SELECT s.frame_url FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id WHERE ss.episode_id = ?
     UNION ALL SELECT s.frame_url2 FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id WHERE ss.episode_id = ?
     UNION ALL SELECT s.blocking_url FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id WHERE ss.episode_id = ?
     UNION ALL SELECT s.video_url FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id WHERE ss.episode_id = ?
     UNION ALL SELECT s.continuity_url FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id WHERE ss.episode_id = ?
     UNION ALL SELECT ss2.grid_image_url FROM storyboard_scenes ss2 WHERE ss2.episode_id = ?`,
    [episode.id, episode.id, episode.id, episode.id, episode.id, episode.id, episode.id, episode.id, episode.id, episode.id, episode.id]
  )
  execute('DELETE FROM episodes WHERE id = ?', [episode.id])

  try {
    for (const [assetType, ids] of [['scene', ownedSceneIds], ['prop', ownedPropIds]]) {
      if (!ids.length) continue
      execute(
        `DELETE FROM asset_image_history WHERE asset_type = ? AND asset_id IN (${ids.map(() => '?').join(',')})`,
        [assetType, ...ids]
      )
    }
    execute('DELETE FROM ai_calls WHERE episode_id = ?', [episode.id])
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

  const segments = query(
    "SELECT * FROM video_segments WHERE episode_id = ? ORDER BY scene_number, segment_index",
    [req.params.id]
  )
  const segmentByShot = new Map()
  for (const seg of segments) {
    if (!seg.video_url) continue
    let segShotIds = []
    try { segShotIds = JSON.parse(seg.shot_ids || '[]') } catch { segShotIds = [] }
    for (const sid of segShotIds) segmentByShot.set(sid, seg)
  }
  const segmentPlan = segments.map((seg) => {
    let segShotIds = []
    try { segShotIds = JSON.parse(seg.shot_ids || '[]') } catch { segShotIds = [] }
    const rawSpan = (seg.start_time != null && seg.end_time != null)
      ? Number(seg.end_time) - Number(seg.start_time)
      : null
    const span = rawSpan != null ? Number(rawSpan.toFixed(3)) : null
    return {
      id: seg.id,
      sceneNumber: seg.scene_number,
      segmentIndex: seg.segment_index,
      shotIds: segShotIds,
      shotNumbers: seg.shot_numbers || '',
      startTime: seg.start_time,
      endTime: seg.end_time,
      duration: span,
      durationSec: span,
      videoUrl: seg.video_url || '',
      anchorFrameUrl: seg.anchor_frame_url || '',
      trimStart: Number(seg.trim_start) || 0,
      status: seg.status || 'pending',
      error: seg.error || '',
    }
  })

  const storyboardScenes = query(
    'SELECT * FROM storyboard_scenes WHERE episode_id = ? ORDER BY scene_number',
    [req.params.id]
  )
  for (const s of storyboardScenes) {
    s.shots = query(
      'SELECT * FROM shots WHERE storyboard_scene_id = ? ORDER BY start_time, id',
      [s.id]
    ).map((shot) => ({
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
      overallSoundscape: shot.overall_soundscape || '',
      nonDiegeticMusic: shot.non_diegetic_music || '',
      integratedMultimodalDescription: shot.integrated_multimodal_description || '',
      blockingPlan: (() => {
        try { return shot.blocking_plan ? JSON.parse(shot.blocking_plan) : null } catch { return null }
      })(),
      finalFrame: shot.final_frame || '',
      dialogue: (() => {
        const lines = parseDialogue(shot.dialogue)
        return lines.length ? lines : null
      })(),
      description: shot.description || '',
      storyboardUrl: shot.storyboard_url || '',
      frameUrl: shot.frame_url || '',
      frameUrl2: shot.frame_url2 || '',
      videoUrl: shot.video_url || '',
      segmentVideoUrl: segmentByShot.get(shot.id)?.video_url || '',
      segmentOffset: (() => {
        const seg = segmentByShot.get(shot.id)
        if (!seg || seg.start_time == null || shot.start_time == null) return 0
        return Math.max(0, Number(shot.start_time) - Number(seg.start_time))
      })(),
      segmentLabel: (() => {
        const seg = segmentByShot.get(shot.id)
        return seg ? `场${seg.scene_number}·段${seg.segment_index}（${seg.shot_numbers || ''}）` : ''
      })(),
      continuityUrl: shot.continuity_url || '',
      keyframeUrl: shot.keyframe_url || '',
      seamCheck: (() => {
        try { return shot.seam_check ? JSON.parse(shot.seam_check) : null } catch { return null }
      })(),
      shotReview: (() => {
        try { return shot.shot_review ? JSON.parse(shot.shot_review) : null } catch { return null }
      })(),
    }))
  }

  res.json({
    ...episode,
    scriptConfirmed: !!episode.script_confirmed,
    scriptHash: scriptHash(episode.script_content),
    assetsScriptFp: episode.assets_script_fp || '',
    storyboardScriptFp: episode.storyboard_script_fp || '',
    storyboardSource: episode.storyboard_source || 'generated',
    directorNotes: episode.director_notes || '',
    aiChatHistory,
    characters,
    props,
    scenes,
    segmentPlan,
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

router.put('/:id/director-notes', (req, res) => {
  const { director_notes } = req.body
  if (director_notes === undefined) return res.status(400).json({ error: 'director_notes 必填' })
  execute('UPDATE episodes SET director_notes = ? WHERE id = ?', [String(director_notes), req.params.id])
  res.json({ success: true })
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
  const { characters = [], source = 'edit', decision = '' } = req.body
  if (!Array.isArray(characters) || characters.length === 0) {
    return res.status(400).json({ error: '角色列表不能为空，已拒绝保存以保护现有数据' })
  }
  const episode = queryOne('SELECT project_id FROM episodes WHERE id = ?', [req.params.id])
  const guardResult = replaceEpisodeCharacters(
    req.params.id,
    episode?.project_id || null,
    characters,
    { source, decision, guard: source === 'extract' }
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

  const lightingQueue = []
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
        execute(
          'UPDATE scenes SET scene_number = ?, title = ?, summary = ?, image_url = ?, prop_names = ?, title_en = ?, summary_en = ?, lighting_en = ?, location = ? WHERE id = ?',
          [i + 1, name, finalSummary, imgUrl, JSON.stringify(propNames), finalTitleEn, finalSummaryEn, finalLightingEn, finalLocation, target.id]
        )
        finalSceneId = target.id
      } else {
        inserted++
        const ins = execute(
          'INSERT INTO scenes (episode_id, scene_number, title, summary, image_url, prop_names, title_en, summary_en, lighting_en, location) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [episodeId, i + 1, name, finalSummary, imgUrl, JSON.stringify(propNames), finalTitleEn, finalSummaryEn, finalLightingEn, finalLocation]
        )
        finalSceneId = Number(ins.lastInsertRowid) || null
      }
      lightingQueue.push({
        name,
        sceneId: finalSceneId,
        sceneNumber: i + 1,
        summary: finalSummary,
        lightingEn: finalLightingEn,
      })
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

    if (deletedRows.length > 0 && inserted === 0 && contentChanged === 0) {
      const analysisCount = queryOne('SELECT COUNT(*) AS c FROM scene_analysis WHERE episode_id = ?', [episodeId])?.c || 0
      const liveCount = queryOne('SELECT COUNT(*) AS c FROM scenes WHERE episode_id = ?', [episodeId])?.c || 0
      if (analysisCount === liveCount) {
        const live = query('SELECT id, scene_number, title, summary, image_url FROM scenes WHERE episode_id = ? ORDER BY scene_number', [episodeId])
        execute('UPDATE scene_analysis SET fingerprint = ? WHERE episode_id = ?', [fingerprintOf(live), episodeId])
      }
    }
  })

  const result = query('SELECT * FROM scenes WHERE episode_id = ? ORDER BY scene_number', [episodeId])

  runLightingChecks(lightingQueue, episodeId, recordAlert)
    .catch((e) => console.warn('[lightingCheck] 后置校验整体异常（已忽略）:', e.message))

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
  const { storyboardScenes = [], storyboard_confirmed, storyboard_source } = req.body
  if (!Array.isArray(storyboardScenes) || storyboardScenes.length === 0) {
    return res.status(400).json({ error: 'storyboardScenes 不能为空' })
  }
  transaction(() => {
    const episodeId = req.params.id

    const existingScenes = query('SELECT id, scene_number FROM storyboard_scenes WHERE episode_id = ?', [episodeId])
    const sceneIdByNum = new Map(existingScenes.map((s) => [s.scene_number, s.id]))
    const existingShots = query(
      `SELECT s.id, s.storyboard_scene_id, s.shot_number
       FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id
       WHERE ss.episode_id = ?`,
      [episodeId]
    )

    const episodeAssetNames = {
      characters: query('SELECT name FROM characters WHERE episode_id = ?', [episodeId]).map((r) => r.name),
      scenes: query('SELECT title FROM scenes WHERE episode_id = ?', [episodeId]).map((r) => r.title),
      props: query('SELECT name FROM props WHERE episode_id = ?', [episodeId]).map((r) => r.name),
    }
    const shotIdByKey = new Map(existingShots.map((s) => [`${s.storyboard_scene_id}:${s.shot_number}`, s.id]))

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
        const shotId = shotIdByKey.get(`${sceneId}:${shotNumber}`)

        backfillShotAssets(shot, episodeAssetNames)

        const fields = [
          shot.duration || 8,
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
          shot.isCombat === true || shot.isCombat === false
            ? (shot.isCombat ? 1 : 0)
            : (shot.is_combat === 0 || shot.is_combat === 1 ? shot.is_combat : null),
        ]
        const camAngle = shot.camera_angle || shot.cameraAngle || null

        if (shotId == null) {
          const r = execute(
            `INSERT INTO shots (storyboard_scene_id, shot_number, duration, description, characters, scene_assets, prop_assets, storyboard_url, frame_url, blocking_url, video_url, video_generated, shot_type, start_time, end_time, action_note, sound_effects, dialogue, camera_movement, overall_soundscape, non_diegetic_music, integrated_multimodal_description, final_frame, is_combat, camera_angle)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [sceneId, shotNumber, ...fields, camAngle || '']
          )
          keepShotIds.add(r.lastInsertRowid)
        } else {
          const planValue = shot.blockingPlan ? JSON.stringify(shot.blockingPlan) : ''
          const frameUrl2Value = shot.frameUrl2 !== undefined ? shot.frameUrl2 : ''
          const continuityUrlValue = shot.continuityUrl !== undefined ? shot.continuityUrl : ''
          const keyframeUrlValue = shot.keyframeUrl !== undefined ? shot.keyframeUrl : ''
          execute(
            `UPDATE shots SET duration=?, description=?, characters=?, scene_assets=?, prop_assets=?, storyboard_url=?, frame_url=?, blocking_url=?, video_url=?, video_generated=?, shot_type=?, start_time=?, end_time=?, action_note=?, sound_effects=?, dialogue=?, camera_movement=?, overall_soundscape=COALESCE(NULLIF(?, ''), overall_soundscape), non_diegetic_music=COALESCE(NULLIF(?, ''), non_diegetic_music), integrated_multimodal_description=?, final_frame=?, is_combat=COALESCE(?, is_combat), camera_angle=COALESCE(?, camera_angle), blocking_plan=?, frame_url2=?, continuity_url=?, keyframe_url=? WHERE id=?`,
            [...fields, camAngle, planValue, frameUrl2Value, continuityUrlValue, keyframeUrlValue, shotId]
          )
          keepShotIds.add(shotId)
        }
      }
    }

    for (const s of existingShots) {
      if (!keepShotIds.has(s.id)) execute('DELETE FROM shots WHERE id = ?', [s.id])
    }
    for (const s of existingScenes) {
      if (!keepSceneIds.has(s.id)) execute('DELETE FROM storyboard_scenes WHERE id = ?', [s.id])
    }
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
  })
  const epForFp = queryOne('SELECT script_content FROM episodes WHERE id = ?', [req.params.id])
  if (epForFp?.script_content) {
    execute('UPDATE episodes SET storyboard_script_fp = ? WHERE id = ?', [scriptHash(epForFp.script_content), req.params.id])
  }
  const normalizedSource = storyboard_source === 'imported' ? 'imported' : 'generated'
  execute('UPDATE episodes SET storyboard_source = ? WHERE id = ?', [normalizedSource, req.params.id])
  if (storyboard_confirmed !== undefined) {
    execute('UPDATE episodes SET storyboard_confirmed = ? WHERE id = ?', [storyboard_confirmed ? 1 : 0, req.params.id])
  }
  res.json({ success: true })
})

router.delete('/:id/storyboard', (req, res) => {
  const episodeId = req.params.id
  try {
    const segIds = query('SELECT id FROM video_segments WHERE episode_id = ?', [episodeId]).map((r) => r.id)
    transaction(() => {
      execute(
        `DELETE FROM shots WHERE storyboard_scene_id IN (SELECT id FROM storyboard_scenes WHERE episode_id = ?)`,
        [episodeId]
      )
      execute('DELETE FROM storyboard_scenes WHERE episode_id = ?', [episodeId])
      execute('DELETE FROM video_segments WHERE episode_id = ?', [episodeId])
      execute('UPDATE episodes SET storyboard_script_fp = NULL, storyboard_confirmed = 0, storyboard_source = ? WHERE id = ?', ['generated', episodeId])
    })
    clearQcIgnores(episodeId)
    if (segIds.length) {
      const trashDir = path.join(serverDir, '..', '_video_trash', String(Date.now()))
      for (const sid of segIds) recycleSliceDir(path.join('segments', `seg${sid}`), trashDir)
    }
    res.json({ success: true })
  } catch (e) {
    console.error('[清空分镜失败]', e)
    res.status(500).json({ error: e.message || '清空分镜失败' })
  }
})

router.get('/:id/segments', (req, res) => {
  const episodeId = Number(req.params.id)
  const rows = query(
    'SELECT * FROM video_segments WHERE episode_id = ? ORDER BY scene_number, segment_index',
    [episodeId]
  )
  res.json({
    segments: rows.map((r) => {
      const span = (r.start_time != null && r.end_time != null)
        ? Number((Number(r.end_time) - Number(r.start_time)).toFixed(3))
        : null
      return {
        id: r.id,
        sceneNumber: r.scene_number,
        segmentIndex: r.segment_index,
        shotNumbers: r.shot_numbers,
        startTime: r.start_time,
        endTime: r.end_time,
        duration: span,
        durationSec: span,
        videoUrl: r.video_url || '',
        anchorFrameUrl: r.anchor_frame_url || '',
        status: r.status,
        error: r.error || '',
      }
    }),
  })
})

router.get('/:id/segments/staleness', async (req, res) => {
  const episodeId = Number(req.params.id)
  try {
    const { segmentStaleness } = await import('../ai/segmentBuilder.js')
    const rows = query(
      'SELECT id, shots_fp, status, episode_id FROM video_segments WHERE episode_id = ?',
      [episodeId]
    )
    if (!rows.length) {
      return res.json({ episodeId, hasPlan: false, stale: false, staleCount: 0, total: 0, reason: 'no_plan' })
    }
    const judged = rows.map((r) => ({ row: r, verdict: segmentStaleness(r) }))
    const isStale = (j) => j.verdict.stale || j.row.status === 'stale'
    const staleRows = judged.filter(isStale)
    res.json({
      episodeId,
      hasPlan: true,
      stale: staleRows.length > 0,
      staleCount: staleRows.length,
      total: rows.length,
      emptyFingerprint: staleRows.filter((j) => !j.row.shots_fp).length,
      fingerprintMismatch: staleRows.filter((j) => j.row.shots_fp && j.verdict.stale).length,
      currentFingerprint: judged[0]?.verdict.currentFingerprint || '',
      reason: staleRows.length ? 'stale' : 'fresh',
    })
  } catch (e) {
    res.json({ episodeId, hasPlan: false, stale: false, staleCount: 0, total: 0, reason: 'error', error: String(e?.message || e) })
  }
})

router.post('/:id/segments', async (req, res) => {
  const episodeId = Number(req.params.id)
  const { persist = false, replace = true, scene = null } = req.body || {}
  try {
    const { buildSegments, formatPlan, persistSegments, SEG_MIN_SEC, SEG_MAX_SEC } = await import('../ai/segmentBuilder.js')
    const plan = buildSegments(episodeId, scene != null ? { scene: Number(scene) } : {})
    let write = null
    if (persist) {
      write = persistSegments(plan, { replace, episodeId })
    }
    const unusableSegments = plan.scenes.flatMap((sc) => sc.segments
      .filter((s) => s.status === 'unusable')
      .map((s) => ({ sceneNumber: s.sceneNumber, segmentIndex: s.segIndexInScene, shotNumbers: s.shotNumbers.join('+'), durationSec: s.durationSec })))
    res.json({
      success: true,
      totals: plan.totals,
      warnings: plan.warnings,
      plan: formatPlan(plan),
      shotsFp: plan.shotsFp || '',
      isEmpty: Boolean(plan.isEmpty),
      unusableSegments,
      segments: plan.scenes.flatMap((sc) => sc.segments.map((s) => ({
        sceneNumber: s.sceneNumber,
        segmentIndex: s.segIndexInScene,
        shotNumbers: s.shotNumbers,
        duration: s.durationSec,
        startTime: s.startTime,
        endTime: s.endTime,
        anchorMode: s.anchorMode,
        status: s.status,
        shotsFp: plan.shotsFp || '',
      }))),
      write,
    })
  } catch (e) {
    console.error('[段方案] 计算失败', e)
    res.status(500).json({ error: e.message || '段方案计算失败' })
  }
})

router.post('/:id/segments/slice', async (req, res) => {
  const episodeId = Number(req.params.id)
  const { scene = null, force = false, segmentId = null } = req.body || {}
  try {
    const { sliceSegment, sliceEpisode } = await import('../ai/segmentSlicer.js')
    if (segmentId != null) {
      const r = await sliceSegment(Number(segmentId), { force })
      return res.json(r)
    }
    const r = await sliceEpisode(episodeId, { scene: scene != null ? Number(scene) : null, force })
    res.json(r)
  } catch (e) {
    console.error('[段切片] 失败', e)
    res.status(500).json({ error: e.message || '段切片失败' })
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
    camera_angle, cameraAngle,
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
  let blockingPlanValue
  if (blocking_plan !== undefined) {
    blockingPlanValue = typeof blocking_plan === 'object' ? JSON.stringify(blocking_plan) : blocking_plan
  } else if (blockingPlan !== undefined) {
    blockingPlanValue = typeof blockingPlan === 'object' ? JSON.stringify(blockingPlan) : blockingPlan
  } else {
    blockingPlanValue = null
  }
  const finalFrameValue = final_frame !== undefined ? final_frame : (finalFrame !== undefined ? finalFrame : null)
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
       camera_angle = COALESCE(?, camera_angle)
     WHERE id = ?`,
    [storyboard_url, frame_url, frame_url2, blocking_url, video_url, video_generated, description, duration,
      shot_type, start_time, end_time, action_note, sound_effects, dialogue,
      camera_movement, overall_soundscape, non_diegetic_music,
      integrated_multimodal_description, blockingPlanValue, finalFrameValue,
      (typeof video_prompt_override === 'string' && video_prompt_override.trim()) ? video_prompt_override.trim() : null,
      is_combat !== undefined ? (is_combat ? 1 : 0) : null,
      (camera_angle !== undefined ? camera_angle : cameraAngle) || null,
      req.params.shotId]
  )
  const shot = queryOne('SELECT * FROM shots WHERE id = ?', [req.params.shotId])
  res.json(shot)
})


function moveUploadsToTrash(urls, trashDir) {
  const root = path.resolve(uploadsDir)
  let moved = 0
  for (const u of urls || []) {
    if (!u || !String(u).startsWith('/uploads/')) continue
    try {
      const rel = decodeURIComponent(String(u).split(/[?#]/)[0]).replace(/^\/uploads\//, '')
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

function recycleSliceDir(relDir, trashDir) {
  const root = path.resolve(uploadsDir)
  const absDir = path.resolve(root, relDir)
  if (absDir === root || !absDir.startsWith(root + path.sep)) return 0
  if (!fs.existsSync(absDir)) return 0
  let files = []
  try { files = fs.readdirSync(absDir) } catch { return 0 }
  const urls = files
    .map((f) => `/uploads/${relDir.replace(/\\/g, '/')}/${f}`)
    .filter((u) => fs.existsSync(path.resolve(root, decodeURIComponent(u).replace(/^\/uploads\//, ''))))
  const movable = filterUnreferencedUploadUrls(urls)
  let moved = 0
  for (const u of movable) {
    try {
      const rel = decodeURIComponent(String(u).split(/[?#]/)[0]).replace(/^\/uploads\//, '')
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
  try {
    if (fs.existsSync(absDir) && fs.readdirSync(absDir).length === 0) fs.rmdirSync(absDir)
  } catch {  }
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

  const segments = query('SELECT * FROM video_segments WHERE episode_id = ?', [episodeId])
  const segmentByShot = new Map()
  for (const seg of segments) {
    if (!seg.video_url) continue
    let ids = []
    try { ids = JSON.parse(seg.shot_ids || '[]') } catch { ids = [] }
    for (const sid of ids) segmentByShot.set(Number(sid), seg)
  }

  const segmentIdsToClear = new Map() 
  const shotIdsToClear = new Set()    
  for (const sid of requested) {
    const shot = shotById.get(sid)
    if (!shot) { skipped.push({ shotId: sid, reason: '镜头不存在' }); continue }
    const seg = segmentByShot.get(sid)
    if (seg) {
      segmentIdsToClear.set(Number(seg.id), seg)
      let ids = []
      try { ids = JSON.parse(seg.shot_ids || '[]') } catch { ids = [] }
      for (const s2 of ids) if (shotById.has(Number(s2))) shotIdsToClear.add(Number(s2))
    } else if (shot.video_url) {
      shotIdsToClear.add(sid)
    } else {
      skipped.push({ shotId: sid, reason: '该镜头没有成片' })
    }
  }

  const fileCandidates = []
  for (const sid of shotIdsToClear) {
    const u = shotById.get(sid)?.video_url
    if (u) fileCandidates.push(u)
  }
  for (const seg of segmentIdsToClear.values()) {
    if (seg.video_url) fileCandidates.push(seg.video_url)
  }
  const segmentSliceDirs = []
  for (const seg of segmentIdsToClear.values()) {
    segmentSliceDirs.push(path.join('segments', `seg${seg.id}`))
  }

  transaction(() => {
    for (const sid of shotIdsToClear) {
      execute(
        "UPDATE shots SET video_url = '', video_generated = 0, shot_review = NULL, seam_check = '', retry_feedback = '' WHERE id = ?",
        [sid]
      )
    }
    for (const seg of segmentIdsToClear.values()) {
      execute("UPDATE video_segments SET video_url = '', status = 'pending', error = '' WHERE id = ?", [seg.id])
    }
    for (const sid of shotIdsToClear) {
      try { execute('DELETE FROM salvage_queue WHERE shot_id = ?', [sid]) } catch {  }
    }
  })

  let alertsCleared = 0
  for (const sid of shotIdsToClear) alertsCleared += resolveAlertsByShot(sid, 'del')

  const trashDir = path.join(serverDir, '..', '_video_trash', String(Date.now()))
  const movedFiles = moveUploadsToTrash(filterUnreferencedUploadUrls(fileCandidates), trashDir)
  let removedSliceDirs = 0
  for (const relDir of segmentSliceDirs) {
    removedSliceDirs += recycleSliceDir(relDir, trashDir)
  }

  const shotsOut = [...shotIdsToClear]
    .sort((a, b) => a - b)
    .map((sid) => ({ id: sid, shotNumber: shotById.get(sid)?.shot_number || '' }))
  const segmentsOut = [...segmentIdsToClear.values()]
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((seg) => ({
      id: seg.id,
      sceneNumber: seg.scene_number,
      segmentIndex: seg.segment_index,
      shotNumbers: seg.shot_numbers || '',
      shotIds: (() => { try { return JSON.parse(seg.shot_ids || '[]') } catch { return [] } })(),
    }))

  return { ok: true, episodeId: Number(episodeId), shots: shotsOut, segments: segmentsOut, movedFiles, removedSliceDirs, alertsCleared, skipped }
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

    const audioUrl = `/uploads/${filename}`

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
