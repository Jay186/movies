import { Router } from 'express'
import { randomUUID } from 'crypto'
import path from 'node:path'
import fs from 'node:fs'
import { query, queryOne, execute, transaction } from '../db.js'
import { scriptHash } from '../scriptHash.js'

import { generateScript, classifyScriptIntent, reviseScriptEdits, applyScriptEdits, rewriteFullScript, rewriteScriptSegment, extractAssets, generateStoryboard, generateStoryboardFromFile, enrichShotIntegrated, fixAxisFlips, extractFinalFrameFromIntegrated } from '../ai/doubao.js'
import { ensureStandardScript } from '../ai/scriptFormat.js'
import { assertScriptConfirmed, assertNotStale, assertAssetsExist } from '../ai/guards.js'
import { clearQcIgnores } from './qc.js'
import { recordAlert, clearAlertsByRef } from '../ai/alerts.js'
import { backfillStoryboardAssets } from '../ai/assetBackfill.js'
import { runLightingChecks } from '../ai/lightingCheckRuntime.js'
import { snapshotBeforeExtract, computeExtractDiff } from '../ai/extractGuard.js'
import { classifyShotCombat } from '../ai/shotClassifier.js'
import { config } from '../config.js'
import { CJK_DIRTY_RE } from '../ai/shared.js'
import { parseDialogue, serializeDialogue } from '../ai/dialogue.js'
import { buildAliasMap } from '../ai/storyboardValidator.js'
import { reportProgress, finishProgress, makeReporter, getProgress, getActiveProgress, listProgress } from '../ai/progressBus.js'
import { PHASE } from '../ai/progressPhases.js'
import { replaceEpisodeCharacters, mergeMasterIntoEpisodeCharacters } from '../characterLibrary.js'
import { routeIp, buildCharacterContext, resolveExplicitCharacters } from '../ai/ipRouter.js'
import { remapSceneRefs } from '../ai/sceneIdRemap.js'
import { uploadsDir, tasksDir } from '../paths.js'

// 项目画风的类别（realistic / 3d-special / 2d …），供毒词豁免分桶使用；查不到返回空（退回仅按画风名豁免）。
function styleCategoryOf(label) {
  const s = String(label || '').trim()
  if (!s) return ''
  try {
    return String(queryOne('SELECT category_key FROM style_presets WHERE label = ? LIMIT 1', [s])?.category_key || '')
  } catch { return '' }
}

const SB_TASK = {
  GENERATE: 'storyboard',
  FROM_FILE: 'file',
  ENRICH: 'enrich',
}

const router = Router()

function remapSceneReferencesAfterRebuild(episodeId, oldScenes) {
  try {
    const newScenes = query('SELECT id, title, scene_number FROM scenes WHERE episode_id = ?', [episodeId])
    for (const table of ['scene_group_locks', 'scene_anchors']) {
      const refs = query(`SELECT id, scene_id FROM ${table} WHERE episode_id = ?`, [episodeId])
      const { updates, unmatched } = remapSceneRefs(oldScenes, newScenes, refs)
      for (const u of updates) {
        execute(`UPDATE ${table} SET scene_id = ? WHERE id = ?`, [u.to, u.id])
      }
      if (updates.length) {
        console.log(`[sceneIdRemap] ${table}: ${updates.length} 行 scene_id 已按稳定键重挂到新场景 id（episode=${episodeId}）`)
      }
      if (unmatched.length) {
        recordAlert({
          level: 'warn', source: 'sceneIdRemap', episodeId,
          message: `场景重建后有 ${unmatched.length} 条 ${table} 引用无法按标题/场次重挂（对应旧场景已不存在，行已保留待人工处置）`,
          detail: JSON.stringify(unmatched).slice(0, 2000),
        })
      }
    }
  } catch (e) {
    console.warn('[sceneIdRemap] 场景引用重挂失败（已忽略，不阻断资产提取）:', e.message)
  }
}

async function buildAssetContextForPrompt(prompt, episodeId, characterIds = null) {
  try {
    if (Array.isArray(characterIds) && characterIds.length) {
      const resolved = resolveExplicitCharacters(characterIds)
      if (resolved.characters.length) {
        return buildCharacterContext(resolved.characters, resolved.ip)
      }
    }
    const ep = queryOne('SELECT project_id FROM episodes WHERE id = ?', [episodeId])
    const route = await routeIp(String(prompt || ''), { projectId: ep?.project_id })
    if (route.confidence === 'high' && route.characters.length) {
      return buildCharacterContext(route.characters, route.ip)
    }
    return ''
  } catch (e) {
    console.warn('[ip-route] 资产定位失败，按裸主题生成:', e.message)
    return ''
  }
}

fs.mkdirSync(uploadsDir, { recursive: true })

const runningFullTasks = new Set()

function updateTask(taskId, updates) {
  const fields = []
  const values = []
  for (const [key, value] of Object.entries(updates)) {
    fields.push(`${key} = ?`)
    values.push(typeof value === 'object' ? JSON.stringify(value) : value)
  }
  values.push(taskId)
  execute(`UPDATE tasks SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, values)
}

function dedupeAssets(list, keyFn) {
  if (!Array.isArray(list)) return list || []
  const seen = new Set()
  const result = []
  for (const item of list) {
    const raw = keyFn(item)
    if (!raw) continue
    const norm = String(raw).replace(/[\s，。！？、,.\s]/g, '').toLowerCase()
    if (!norm || seen.has(norm)) continue
    seen.add(norm)
    result.push(item)
  }
  return result
}

const FURNITURE_KEYWORDS = [
  '沙发', '茶几', '电视', '柜子', '桌子', '椅子', '书架', '衣柜', '餐桌',
  '地毯', '窗帘', '冰箱', '空调', '楼梯', '地板', '天花板', '台灯', '吊灯',
  '凳子', '床头柜', '鞋柜', '橱柜', '灶台',
]
function isFurniture(name) {
  const n = String(name || '').trim()
  return FURNITURE_KEYWORDS.some((kw) => {
    const k = kw.trim()
    return k && n.includes(k) && n.length <= k.length + 2
  })
}

function filterFurnitureProps(assets) {
  if (Array.isArray(assets?.props)) {
    assets.props = assets.props.filter((p) => {
      const name = typeof p === 'string' ? p : p.name
      return !isFurniture(name)
    })
  }
  if (Array.isArray(assets?.scenes)) {
    for (const s of assets.scenes) {
      if (Array.isArray(s.props)) {
        s.props = s.props.filter((n) => !isFurniture(n))
      }
    }
  }
  return assets
}


router.post('/ip-route', async (req, res) => {
  const { prompt, projectId, characterIds } = req.body
  if (!prompt || !String(prompt).trim()) {
    return res.status(400).json({ error: 'prompt 必填' })
  }
  try {
    if (Array.isArray(characterIds) && characterIds.length) {
      const resolved = resolveExplicitCharacters(characterIds)
      return res.json({
        confidence: 'high',
        characters: resolved.characters,
        ip: resolved.ip,
        matched: [],
        reason: '用户已确认出场角色',
        via: 'explicit',
      })
    }
    const route = await routeIp(String(prompt), { projectId: projectId || null })
    res.json(route)
  } catch (err) {
    console.error('[ip-route] 失败:', err.message)
    res.status(500).json({ error: err.message })
  }
})

router.post('/full', async (req, res) => {
  const { episodeId, prompt, options = {} } = req.body
  if (!episodeId || !prompt) {
    return res.status(400).json({ error: 'episodeId 和 prompt 必填' })
  }

  if (runningFullTasks.has(String(episodeId))) {
    return res.status(400).json({ error: '该集已有进行中的一键生成任务' })
  }
  runningFullTasks.add(String(episodeId))

  const taskId = randomUUID()
  execute(
    'INSERT INTO tasks (id, episode_id, type, status, progress, message) VALUES (?, ?, ?, ?, ?, ?)',
    [taskId, episodeId, 'full', 'pending', 0, '任务已创建']
  )

  res.json({ taskId, message: '任务已提交，正在后台执行' })

  runFullPipeline(taskId, episodeId, prompt, options)
    .catch((err) => {
      console.error('[Full Pipeline Error]', err)
      updateTask(taskId, { status: 'failed', error: err.message, message: '生成失败' })
    })
    .finally(() => {
      runningFullTasks.delete(String(episodeId))
    })
})

function recordPipelineDiff(trigger, episodeId, table, oldMap, incoming) {
  try {
    const oldRows = [...oldMap.values()]
    const incomingRows = (incoming || []).map((item) => {
      const isStr = typeof item === 'string'
      const name = isStr ? item : (item.name || '')
      const old = oldMap.get(name)
      if (table === 'props') {
        return {
          name,
          description: isStr ? '' : (item.description || ''),
          owner: old?.owner || (isStr ? '' : (item.owner || '')) || '',
          image_url: old?.image_url || '',
          name_en: old?.name_en || (isStr ? '' : (item.nameEn ?? item.name_en ?? '')) || '',
        }
      }
      const oldScene = oldMap.get(name)
      return {
        title: name,
        summary: isStr ? '' : (item.description || ''),
        image_url: oldScene?.image_url || '',
        prop_names: JSON.stringify(isStr ? [] : (item.props || item.propNames || [])),
        title_en: oldScene?.title_en || '',
        summary_en: oldScene?.summary_en || '',
        lighting_en: oldScene?.lighting_en || '',
      }
    })
    const report = computeExtractDiff({ table, oldRows, incoming: incomingRows })
    if (report.hasRisk) {
      const MAX_DETAIL = 5
      const owDetail = (report.overwrites || []).map(
        (o) => `${o.name}(${(o.fields || []).map((f) => f.field).join(',')})`
      )
      const delDetail = (report.deletions || []).map((d) => `${d.name}(整条删除)`)
      const allDetail = [...owDetail, ...delDetail]
      const shown = allDetail.slice(0, MAX_DETAIL).join('；')
      const more = allDetail.length > MAX_DETAIL ? ` 等共 ${allDetail.length} 项` : ''
      const detailText = allDetail.length ? `明细：${shown}${more}。` : ''
      recordAlert({
        level: 'warn',
        source: 'extract-overwrite',
        episodeId,
        message: `一键全流程重建 ${table} 检测到覆盖风险（${trigger}，集 ${episodeId}）：`
          + `字段覆盖 ${report.counts.overwrites} 项、条目删除 ${report.counts.deletions} 项。`
          + `${detailText}已写入覆盖前快照，可在资产的「还原快照」里回退。`,
      })
    }
  } catch (e) {
    console.warn(`[extract-overwrite] ${trigger} 留证失败（已忽略）:`, e.message)
  }
}

async function runFullPipeline(taskId, episodeId, prompt, options) {  const { generateImages = true } = options

  const assetContext = await buildAssetContextForPrompt(prompt, episodeId, options.characterIds)

  updateTask(taskId, { status: 'running', progress: 5, message: '正在生成剧本...' })
  const rawScript = await generateScript(prompt, '', assetContext)
  const { text: script } = await ensureStandardScript(rawScript, { episodeId })
  execute('UPDATE episodes SET script_content = ?, script_confirmed = 1 WHERE id = ?', [script, episodeId])
  updateTask(taskId, { progress: 20, message: '剧本生成完成' })

  updateTask(taskId, { progress: 25, message: '正在提取角色/场景/道具...' })
  const episodeForStyle = queryOne('SELECT project_id FROM episodes WHERE id = ?', [episodeId])
  const projectForStyle = episodeForStyle ? queryOne('SELECT art_style FROM projects WHERE id = ?', [episodeForStyle.project_id]) : null
  const artStyle = projectForStyle?.art_style || ''
  const assets = await extractAssets(script, artStyle)
  assets.characters = Array.isArray(assets.characters) ? assets.characters : []
  assets.props = Array.isArray(assets.props) ? assets.props : []
  assets.scenes = Array.isArray(assets.scenes) ? assets.scenes : []
  if (!assets.characters.length && !assets.props.length && !assets.scenes.length) {
    throw new Error('AI 未提取到任何资产，请重试')
  }
  assets.characters = dedupeAssets(assets.characters, (c) => (typeof c === 'string' ? c : c.name))
  assets.props = dedupeAssets(assets.props, (p) => (typeof p === 'string' ? p : p.name))
  assets.scenes = dedupeAssets(assets.scenes, (s) => (typeof s === 'string' ? s : s.name))
  filterFurnitureProps(assets)

  const oldCharMap = new Map(
    mergeMasterIntoEpisodeCharacters(
      query('SELECT name, image_url, audio_url, project_character_id FROM characters WHERE episode_id = ?', [episodeId])
    ).map((c) => [c.name, c])
  )
  if (assets.characters?.length) {
    replaceEpisodeCharacters(episodeId, episodeForStyle?.project_id || null, assets.characters, { source: 'extract' })
  }
  const oldPropMap = new Map(
    query('SELECT name, image_url, owner, name_en, description_en FROM props WHERE episode_id = ?', [episodeId]).map((p) => [p.name, p])
  )
  if (assets.props?.length) {
    snapshotBeforeExtract({ episodeId, trigger: 'pipeline-props', tables: ['props'] })
    recordPipelineDiff('pipeline-props', episodeId, 'props', oldPropMap, assets.props)
    execute('DELETE FROM props WHERE episode_id = ?', [episodeId])
    for (const p of assets.props) {
      const name = typeof p === 'string' ? p : (p.name || '')
      const description = typeof p === 'string' ? '' : (p.description || '')
      const llmOwner = typeof p === 'string' ? '' : (p.owner || '')
      const old = oldPropMap.get(name)
      const finalNameEn = old?.name_en || (typeof p === 'string' ? '' : (p.nameEn ?? p.name_en ?? '')) || ''
      const finalDescriptionEn = old?.description_en ?? (typeof p === 'string' ? '' : (p.descriptionEn ?? p.description_en ?? '')) ?? ''
      execute('INSERT INTO props (episode_id, name, description, owner, image_url, name_en, description_en) VALUES (?, ?, ?, ?, ?, ?, ?)', [episodeId, name, description, old?.owner || llmOwner || '', old?.image_url || '', finalNameEn, finalDescriptionEn])
    }
  }
  const oldSceneMap = new Map(
    query('SELECT title, image_url, title_en, summary_en, lighting_en, location FROM scenes WHERE episode_id = ?', [episodeId]).map((s) => [s.title, s])
  )
  if (assets.scenes?.length) {
    snapshotBeforeExtract({ episodeId, trigger: 'pipeline-scenes', tables: ['scenes'] })
    recordPipelineDiff('pipeline-scenes', episodeId, 'scenes', oldSceneMap, assets.scenes)
    const oldSceneIdSnapshot = query('SELECT id, title, scene_number FROM scenes WHERE episode_id = ?', [episodeId])
    execute('DELETE FROM scenes WHERE episode_id = ?', [episodeId])
    let sceneNum = 0
    const lightingQueue = []
    for (const s of assets.scenes) {
      sceneNum++
      const name = typeof s === 'string' ? s : (s.name || `场景${sceneNum}`)
      const description = typeof s === 'string' ? '' : (s.description || '')
      const propNames = typeof s === 'string' ? [] : (s.props || s.propNames || [])
      const old = oldSceneMap.get(name)
      const llmLighting = typeof s === 'string' ? '' : String(s.lightingEn || '').trim()
      const llmLightingEn = llmLighting && !CJK_DIRTY_RE.test(llmLighting) ? llmLighting : ''
      const finalLightingEn = old?.lighting_en || llmLightingEn || ''
      const finalLocation = old?.location ?? (typeof s === 'string' ? '' : (s.location ?? s.location_en ?? '')) ?? ''
      const finalTitleEn = old?.title_en || (typeof s === 'string' ? '' : (s.titleEn || s.title_en)) || ''
      const finalSummaryEn = old?.summary_en || (typeof s === 'string' ? '' : (s.summaryEn || s.summary_en)) || ''
      const ins = execute(
        'INSERT INTO scenes (episode_id, scene_number, title, summary, image_url, prop_names, title_en, summary_en, lighting_en, location) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [episodeId, sceneNum, name, description, old?.image_url || '', JSON.stringify(propNames), finalTitleEn, finalSummaryEn, finalLightingEn, finalLocation]
      )
      lightingQueue.push({
        name,
        sceneId: Number(ins.lastInsertRowid) || null,
        sceneNumber: sceneNum,
        summary: description,
        lightingEn: finalLightingEn,
      })
    }
    remapSceneReferencesAfterRebuild(episodeId, oldSceneIdSnapshot)
    await runLightingChecks(lightingQueue, episodeId, recordAlert)
  }
  updateTask(taskId, { progress: 35, message: '资产提取完成' })
  execute('UPDATE episodes SET assets_script_fp = ? WHERE id = ?', [scriptHash(script), episodeId])

  updateTask(taskId, { progress: 40, message: '正在生成分镜脚本...' })
  const episode = queryOne('SELECT * FROM episodes WHERE id = ?', [episodeId])
  const project = queryOne('SELECT * FROM projects WHERE id = ?', [episode.project_id])
  const savedCharMap = new Map(
    mergeMasterIntoEpisodeCharacters(
      query('SELECT name, name_en, description, description_en, image_url, project_character_id FROM characters WHERE episode_id = ?', [episodeId])
    ).map((c) => [c.name, c])
  )
  assets.characters = (assets.characters || []).map((c) => {
    const name = typeof c === 'string' ? c : (c.name || '')
    const saved = savedCharMap.get(name) || oldCharMap.get(name)
    const imageUrl = saved?.image_url || ''
    const description = saved?.description || (typeof c === 'string' ? '' : c.description) || ''
    const nameEn = saved?.name_en || (typeof c === 'string' ? '' : (c.nameEn || c.name_en)) || ''
    const descriptionEn = saved?.description_en || (typeof c === 'string' ? '' : (c.descriptionEn || c.description_en)) || ''
    return typeof c === 'string'
      ? { name: c, description, name_en: nameEn, description_en: descriptionEn, image_url: imageUrl }
      : { ...c, description, name_en: nameEn, description_en: descriptionEn, image_url: imageUrl }
  })
  assets.scenes = (assets.scenes || []).map((s) => {
    const name = typeof s === 'string' ? s : (s.name || '')
    const old = oldSceneMap.get(name)
    const titleEn = old?.title_en || (typeof s === 'string' ? '' : (s.titleEn || s.title_en)) || ''
    const summaryEn = old?.summary_en || (typeof s === 'string' ? '' : (s.summaryEn || s.summary_en)) || ''
    const lightingEn = old?.lighting_en || (typeof s === 'string' ? '' : (s.lightingEn || s.lighting_en)) || ''
    return typeof s === 'string'
      ? { name: s, title_en: titleEn, summary_en: summaryEn, lighting_en: lightingEn, image_url: old?.image_url || '' }
      : { ...s, title_en: titleEn, summary_en: summaryEn, lighting_en: lightingEn, image_url: old?.image_url || '' }
  })
  assets.props = (assets.props || []).map((p) => {
    const name = typeof p === 'string' ? p : (p.name || '')
    const old = oldPropMap.get(name)
    const nameEn = old?.name_en || (typeof p === 'string' ? '' : (p.nameEn || p.name_en)) || ''
    const descriptionEn = old?.description_en || (typeof p === 'string' ? '' : (p.descriptionEn || p.description_en)) || ''
    const owner = old?.owner || (typeof p === 'string' ? '' : p.owner) || ''
    return typeof p === 'string'
      ? { name: p, name_en: nameEn, description_en: descriptionEn, owner, image_url: old?.image_url || '' }
      : { ...p, name_en: nameEn, description_en: descriptionEn, owner, image_url: old?.image_url || '' }
  })
  const storyboard = await generateStoryboard(script, project?.art_style || config.defaultArtStyle, assets, {
    targetDuration: options.targetDuration,
    onProgress: makeReporter(episodeId, SB_TASK.GENERATE),
    styleCategory: styleCategoryOf(project?.art_style || config.defaultArtStyle),
  })

  backfillStoryboardAssets(storyboard, assets)

  execute('UPDATE episodes SET storyboard_confirmed = 0 WHERE id = ?', [episodeId])
  execute('UPDATE episodes SET storyboard_script_fp = ? WHERE id = ?', [scriptHash(script), episodeId])

  const shotIds = transaction(() => {
    const oldScenes = query('SELECT id FROM storyboard_scenes WHERE episode_id = ?', [episodeId])
    const removedShotIds = []
    for (const s of oldScenes) {
      const ids = query('SELECT id FROM shots WHERE storyboard_scene_id = ?', [s.id]).map((r) => r.id)
      removedShotIds.push(...ids)
      execute('DELETE FROM shots WHERE storyboard_scene_id = ?', [s.id])
    }
    clearAlertsByRef('shot', removedShotIds)
    execute('DELETE FROM storyboard_scenes WHERE episode_id = ?', [episodeId])
    clearAlertsByRef('scene', oldScenes.map((s) => s.id))

    const ids = []
    for (let si = 0; si < (storyboard.scenes || []).length; si++) {
      const s = storyboard.scenes[si]
      const sceneResult = execute(
        'INSERT INTO storyboard_scenes (episode_id, scene_number, title) VALUES (?, ?, ?)',
        [episodeId, si + 1, s.title || `场次${si + 1}`]
      )
      const sceneId = sceneResult.lastInsertRowid

      for (let shi = 0; shi < (s.shots || []).length; shi++) {
        const shot = s.shots[shi]
        const shotResult = execute(
          `INSERT INTO shots (storyboard_scene_id, shot_number, duration, description, characters, scene_assets, prop_assets, shot_type, start_time, end_time, action_note, sound_effects, dialogue, camera_movement, overall_soundscape, non_diegetic_music, integrated_multimodal_description, final_frame, is_combat, camera_angle, purpose, goal, emotion_tone, info_points, world_state_out)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            sceneId,
            `${si + 1}-${shi + 1}`,
            shot.duration || 8,
            shot.description || '',
            JSON.stringify(shot.characters || []),
            JSON.stringify(shot.sceneAssets || []),
            JSON.stringify(shot.propAssets || []),
            shot.shotType || '',
            shot.startTime || 0,
            shot.endTime || shot.duration || 0,
            shot.actionNote || '',
            shot.soundEffects || '',
            serializeDialogue(shot.dialogue),
            shot.cameraMovement || '',
            shot.overallSoundscape || '',
            shot.nonDiegeticMusic || '',
            shot.integratedMultimodalDescription || '',
            shot.finalFrame || '',
            shot.isCombat === true || shot.isCombat === false
              ? (shot.isCombat ? 1 : 0)
              : (classifyShotCombat(shot) ? 1 : 0),
            shot.camera_angle || shot.cameraAngle || '',
            // /full 为 DELETE 后全新建，无旧值，叙事层字段直接写值（与 episodes.js 的 narrativeFields 同口径）
            shot.purpose || null,
            shot.goal || null,
            shot.emotionTone || shot.emotion_tone || null,
            shot.infoPoints?.length ? JSON.stringify(shot.infoPoints)
              : (shot.info_points?.length ? JSON.stringify(shot.info_points) : null),
            shot.worldStateOut || shot.world_state_out || null,
          ]
        )
        ids.push(shotResult.lastInsertRowid)
      }
    }
    return ids
  })
  clearQcIgnores(episodeId)
  updateTask(taskId, { progress: 50, message: '分镜脚本生成完成' })

  const failedImageCount = 0
  const attemptedImages = generateImages ? shotIds.length : 0
  const allImageFailed = attemptedImages > 0 && failedImageCount >= attemptedImages
  const parts = []
  if (failedImageCount > 0) parts.push(`故事板图片失败 ${failedImageCount}/${attemptedImages}`)
  const failSummary = parts.length ? `（${parts.join('，')}）` : ''
  if (allImageFailed) {
    updateTask(taskId, {
      status: 'failed',
      progress: 100,
      message: `全流程生成失败：所有镜头的图片均生成失败${failSummary}`,
      result: { episodeId, shotCount: shotIds.length, failedImageCount },
    })
  } else {
    updateTask(taskId, {
      status: 'completed',
      progress: 100,
      message: `全流程生成完成${failSummary}`,
      result: { episodeId, shotCount: shotIds.length, failedImageCount },
    })
  }
}

router.post('/script-rewrite', async (req, res) => {
  const { instruction, selectedText, context = '' } = req.body
  if (!instruction || !String(instruction).trim()) return res.status(400).json({ error: '改写要求必填' })
  if (!selectedText || !String(selectedText).trim()) return res.status(400).json({ error: '请先选中要改写的段落' })

  try {
    const rewrittenText = await rewriteScriptSegment(String(selectedText), String(instruction), String(context))
    if (!rewrittenText) throw new Error('大模型返回空内容')
    res.json({ success: true, rewrittenText })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/script', async (req, res) => {  const { episodeId, prompt, context = '', mode = '' } = req.body
  if (!episodeId || !prompt) return res.status(400).json({ error: 'episodeId 和 prompt 必填' })

  try {
    const current = queryOne('SELECT script_content FROM episodes WHERE id = ?', [episodeId])

    let script
    let outMode = mode === 'revise' || mode === 'rewrite' || mode === 'generate' ? mode : 'auto'
    if (outMode === 'auto') {
      try {
        outMode = await classifyScriptIntent(String(prompt))
      } catch (e) {
        console.warn('[script] 意图分类失败，按定点修改处理:', e.message)
        outMode = 'revise'
      }
    }
    if (outMode === 'revise') {
      const baseText = String(context || '')
      if (!baseText.trim()) {
        return res.status(400).json({ error: '当前正文为空，无法定点修改' })
      }
      let lastEdits = []
      const runRevise = async (instruction) => {
        const r = await reviseScriptEdits(baseText, instruction)
        lastEdits = r.edits
        if (r.needFullRewrite) return { fullRewrite: true, reason: r.reason }
        return { fullRewrite: false, script: applyScriptEdits(baseText, r.edits) }
      }
      try {
        const r = await runRevise(prompt)
        if (r.fullRewrite) {
          console.warn('[script] 定点修改无法表达该要求，转整本整理:', r.reason)
          script = await rewriteFullScript(baseText, prompt)
          outMode = 'rewrite'
        } else {
          script = r.script
        }
      } catch (e) {
        console.warn('[reviseScript] 编辑指令应用失败，带错误重试一次:', e.message)
        try {
          const r = await runRevise(
            `${prompt}\n\n【上一次失败原因】${e.message}。请重新输出编辑指令 JSON：find 必须从当前剧本逐字复制粘贴，禁止改写其中任何字符；全文改名/统一换词用 {"replaceAll": "...", "with": "..."} 形式；新增内容用 {"append": "..."} 或 {"insertAfter": "...", "text": "..."} 形式且只写新增内容，严禁复制原剧本已有内容；确属全文性改动时输出 {"edits": [], "needFullRewrite": true, "reason": "..."}。`
          )
          if (r.fullRewrite) {
            console.warn('[script] 定点修改无法表达该要求，转整本整理:', r.reason)
            script = await rewriteFullScript(baseText, prompt)
            outMode = 'rewrite'
          } else {
            script = r.script
          }
        } catch (e2) {
          try {
            fs.mkdirSync(tasksDir, { recursive: true })
            fs.writeFileSync(
              path.join(tasksDir, `revise-fail-${episodeId}-${Date.now()}.json`),
              JSON.stringify({ instruction: prompt, error: e2.message, edits: lastEdits }, null, 2),
              'utf8'
            )
          } catch {  }
          throw e2
        }
      }
    } else if (outMode === 'rewrite') {
      const baseText = String(context || '').trim() ? String(context) : current?.script_content || ''
      if (!baseText.trim()) {
        return res.status(400).json({ error: '当前正文为空，无法整本整理' })
      }
      script = await rewriteFullScript(baseText, prompt)
    } else {
      const assetContext = await buildAssetContextForPrompt(prompt, episodeId, req.body.characterIds)
      const rawScript = await generateScript(prompt, context, assetContext)
      const { text } = await ensureStandardScript(rawScript, { episodeId })
      script = text
    }

    if (outMode === 'revise') {
      return res.json({ success: true, script, mode: outMode, changed: script !== String(context || '') })
    }

    const scriptChanged = script !== current?.script_content
    execute(
      'UPDATE episodes SET script_content = ?, script_confirmed = CASE WHEN ? THEN 0 ELSE script_confirmed END, storyboard_confirmed = CASE WHEN ? THEN 0 ELSE storyboard_confirmed END WHERE id = ?',
      [script, scriptChanged ? 1 : 0, scriptChanged ? 1 : 0, episodeId]
    )
    res.json({ success: true, script, mode: outMode, changed: script !== String(context || '') })
  } catch (err) {
    console.error('[script] 处理失败:', err.message)
    res.status(500).json({ error: err.message })
  }
})

router.post('/assets', async (req, res) => {
  const { episodeId, style } = req.body
  if (!episodeId) return res.status(400).json({ error: 'episodeId 必填' })

  try {
    assertScriptConfirmed(episodeId)
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message })
  }

  const episode = queryOne('SELECT * FROM episodes WHERE id = ?', [episodeId])
  if (!episode?.script_content) return res.status(400).json({ error: '请先生成剧本' })

  let artStyle = style
  if (!artStyle) {
    const project = queryOne('SELECT art_style FROM projects WHERE id = ?', [episode.project_id])
    artStyle = project?.art_style || ''
  }

  try {
    const assets = await extractAssets(episode.script_content, artStyle)
    assets.characters = Array.isArray(assets.characters) ? assets.characters : []
    assets.props = Array.isArray(assets.props) ? assets.props : []
    assets.scenes = Array.isArray(assets.scenes) ? assets.scenes : []
    if (!assets.characters.length && !assets.props.length && !assets.scenes.length) {
      return res.status(500).json({ error: 'AI 未提取到任何资产，请重试' })
    }
    assets.characters = dedupeAssets(assets.characters, (c) => (typeof c === 'string' ? c : c.name))
    assets.props = dedupeAssets(assets.props, (p) => (typeof p === 'string' ? p : p.name))
    assets.scenes = dedupeAssets(assets.scenes, (s) => (typeof s === 'string' ? s : s.name))
    filterFurnitureProps(assets)
    res.json({ success: true, assets, scriptFp: scriptHash(episode.script_content) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/enrich-storyboard', async (req, res) => {
  const { episodeId, onlyMissing = false } = req.body
  if (!episodeId) return res.status(400).json({ error: 'episodeId 必填' })

  try {
    assertScriptConfirmed(episodeId)
    assertAssetsExist(episodeId)
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message })
  }

  const episode = queryOne('SELECT * FROM episodes WHERE id = ?', [episodeId])
  if (!episode) return res.status(404).json({ error: '集不存在' })
  const project = queryOne('SELECT art_style FROM projects WHERE id = ?', [episode.project_id])

  const characters = mergeMasterIntoEpisodeCharacters(
    query('SELECT name, name_en, description, description_en, image_url, project_character_id FROM characters WHERE episode_id = ?', [episodeId])
  )
  const scenes = query('SELECT title AS name, title_en, summary AS description, summary_en, image_url, prop_names, lighting_en FROM scenes WHERE episode_id = ?', [episodeId]).map((s) => {
    let propNames = []
    try { propNames = JSON.parse(s.prop_names || '[]') } catch { propNames = [] }
    return { ...s, props: propNames }
  })
  const props = query('SELECT name, name_en, description, description_en, image_url, owner FROM props WHERE episode_id = ?', [episodeId])
  const assets = { characters, scenes, props }

  const shots = query(
    `SELECT s.* FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id
     WHERE ss.episode_id = ? ORDER BY s.id`,
    [episodeId]
  )

  let enriched = 0
  let failed = 0
  let skipped = 0
  const errors = []
  const ENRICH_CONCURRENCY = config.storyboard?.enrichConcurrency || 4
  let enrichDone = 0
  reportProgress(episodeId, SB_TASK.ENRICH, {
    phase: PHASE.ENRICH,
    done: 0,
    total: shots.length,
    message: shots.length ? `正在补全镜头提示词：0/${shots.length}` : '没有需要补全的镜头',
  })
  let cursor = 0
  async function enrichWorker() {
    while (cursor < shots.length) {
      const shot = shots[cursor++]
      const tick = () => {
        enrichDone++
        reportProgress(episodeId, SB_TASK.ENRICH, {
          phase: PHASE.ENRICH,
          done: enrichDone,
          total: shots.length,
          currentLabel: shot.shot_number || String(shot.id),
          message: `正在补全镜头提示词：${enrichDone}/${shots.length}`,
        })
      }
      if (onlyMissing && (shot.integrated_multimodal_description || '').trim()) {
        skipped++
        tick()
        continue
      }
      const shotForAI = {
        description: shot.description || '',
        duration: shot.duration || 8,
        shotType: shot.shot_type || '中景',
        characters: JSON.parse(shot.characters || '[]'),
        sceneAssets: JSON.parse(shot.scene_assets || '[]'),
        propAssets: JSON.parse(shot.prop_assets || '[]'),
        dialogue: (() => {
          const lines = parseDialogue(shot.dialogue)
          return lines.length ? lines : null
        })(),
        actionNote: shot.action_note || '',
      }
      let lastErr = null
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (attempt > 0) {
            await new Promise(r => setTimeout(r, 3000 * attempt))
          }
          const integrated = await enrichShotIntegrated(shotForAI, assets, project?.art_style || config.defaultArtStyle, { directorNotes: episode.director_notes || '', styleCategory: styleCategoryOf(project?.art_style || config.defaultArtStyle) })
          if (integrated) {
            const finalFrame = extractFinalFrameFromIntegrated(integrated)
            execute(
              `UPDATE shots SET integrated_multimodal_description = ?, final_frame = COALESCE(NULLIF(?, ''), final_frame) WHERE id = ?`,
              [integrated, finalFrame, shot.id]
            )
            enriched++
            lastErr = null
            break
          }
        } catch (e) {
          lastErr = e
          console.warn(`[enrich] 镜头 ${shot.shot_number || shot.id} 补全失败(第${attempt + 1}次):`, e.message)
        }
      }
      if (lastErr) {
        failed++
        errors.push({ shot: shot.shot_number || shot.id, error: lastErr.message })
      }
      tick()
    }
  }
  await Promise.all(Array.from({ length: Math.min(ENRICH_CONCURRENCY, shots.length || 1) }, () => enrichWorker()))
  console.log(`[enrich] 并行补全完成（并发 ${ENRICH_CONCURRENCY}）：${enriched} 成功 / ${failed} 失败 / ${skipped} 跳过`)
  reportProgress(episodeId, SB_TASK.ENRICH, {
    phase: PHASE.AXIS,
    done: shots.length,
    total: shots.length,
    message: '补全完成，正在做越轴巡检…',
  })

  let axisFixed = 0
  let axisFailed = 0
  let axisUnresolved = []
  try {
    const rows = query(
      `SELECT s.id, s.shot_number, s.final_frame, s.integrated_multimodal_description, s.storyboard_scene_id
       FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id
       WHERE ss.episode_id = ?
       ORDER BY ss.scene_number, s.start_time, s.id`,
      [episodeId]
    )
    const byScene = new Map()
    for (const r of rows) {
      const list = byScene.get(r.storyboard_scene_id) || []
      list.push({
        id: r.id,
        shotNumber: r.shot_number,
        finalFrame: r.final_frame || '',
        integratedMultimodalDescription: r.integrated_multimodal_description || '',
      })
      byScene.set(r.storyboard_scene_id, list)
    }
    const sceneList = [...byScene.values()].map((shots) => ({ shots }))
    const charNames = characters.map((c) => c.name).filter(Boolean)
    const aliasMap = buildAliasMap(characters)
    const axisRes = await fixAxisFlips(sceneList, charNames, project?.art_style || config.defaultArtStyle, aliasMap)
    for (const sh of axisRes.repairedShots || []) {
      execute('UPDATE shots SET integrated_multimodal_description = ? WHERE id = ?', [sh.integratedMultimodalDescription, sh.id])
      axisFixed++
    }
    axisFailed = axisRes.failed || 0
    axisUnresolved = axisRes.unresolved || []
    for (const u of axisUnresolved) {
      const row = rows.find((r) => (r.shot_number || r.id) === u.shot)
      recordAlert({
        source: 'axis',
        level: 'warn',
        episodeId,
        shotId: row?.id ?? null,
        shotNumber: u.shot,
        message: `越轴未修复：@${u.name} ${u.reason}。请人工检查本镜模块4 是否需补走位，或确认该翻转是合法调度。`,
        detail: u.reason,
      })
    }
    if (axisFixed || axisFailed) {
      console.log(`[enrich] 越轴巡检：${axisFixed} 个镜头已自动补走位${axisFailed ? `，${axisFailed} 处未修复（已落告警）` : ''}`)
    }
  } catch (e) {
    console.warn('[enrich] 越轴巡检失败（不影响补全结果）:', e.message)
  }

  res.json({ success: true, enriched, failed, skipped, total: shots.length, axisFixed, axisFailed, errors: errors.length ? errors : undefined })
  finishProgress(episodeId, SB_TASK.ENRICH, {
    phase: PHASE.DONE,
    done: shots.length,
    total: shots.length,
    message: `补全完成：${enriched} 成功${failed ? ` / ${failed} 失败` : ''}${skipped ? ` / ${skipped} 跳过` : ''}`,
  })
})

router.get('/storyboard-progress', (req, res) => {
  const { episodeId, task } = req.query
  if (!episodeId) return res.json({ active: false })
  const payload = task
    ? getProgress(episodeId, task)
    : getActiveProgress(episodeId)
  if (!payload) return res.json({ active: false })
  res.json({ ...payload, active: payload.active !== false })
})

router.get('/storyboard-progress-all', (req, res) => {
  const { episodeId } = req.query
  if (!episodeId) return res.status(400).json({ error: 'episodeId 必填' })
  res.json({ list: listProgress(episodeId) })
})

router.post('/storyboard', async (req, res) => {
  const { episodeId, targetDuration } = req.body
  if (!episodeId) return res.status(400).json({ error: 'episodeId 必填' })

  try {
    assertScriptConfirmed(episodeId)
    assertNotStale(episodeId, 'assets')
    assertAssetsExist(episodeId)
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message })
  }

  const episode = queryOne('SELECT * FROM episodes WHERE id = ?', [episodeId])
  if (!episode?.script_content) return res.status(400).json({ error: '请先生成剧本' })

  const project = queryOne('SELECT * FROM projects WHERE id = ?', [episode.project_id])

  const characters = mergeMasterIntoEpisodeCharacters(
    query('SELECT name, name_en, description, description_en, image_url, project_character_id FROM characters WHERE episode_id = ?', [episodeId])
  )
  const props = query('SELECT name, name_en, description, description_en, image_url, owner FROM props WHERE episode_id = ?', [episodeId])
  const scenes = query('SELECT title AS name, title_en, summary AS description, summary_en, image_url, prop_names, lighting_en FROM scenes WHERE episode_id = ?', [episodeId]).map((s) => {
    let propNames = []
    try { propNames = JSON.parse(s.prop_names || '[]') } catch { propNames = [] }
    return { ...s, props: propNames }
  })
  const assets = { characters, props, scenes }

  reportProgress(episodeId, SB_TASK.GENERATE, { phase: PHASE.START, done: 0, total: 0, message: '正在准备分镜生成…' })
  let ok = false
  try {
    const storyboard = await generateStoryboard(episode.script_content, project?.art_style || config.defaultArtStyle, assets, {
      targetDuration,
      directorNotes: episode.director_notes || '',
      onProgress: makeReporter(episodeId, SB_TASK.GENERATE),
      styleCategory: styleCategoryOf(project?.art_style || config.defaultArtStyle),
    })
    backfillStoryboardAssets(storyboard, assets)
    res.json({ success: true, storyboard, unmatched: storyboard.unmatched || [] })
    ok = true
  } catch (err) {
    res.status(500).json({ error: err.message })
  } finally {
    finishProgress(episodeId, SB_TASK.GENERATE, {
      phase: PHASE.DONE,
      done: 1,
      total: 1,
      message: ok ? '分镜生成完成' : '分镜生成已结束',
    })
  }
})

router.post('/storyboard-from-file', async (req, res) => {
  const { episodeId, fileContent } = req.body
  if (!episodeId) return res.status(400).json({ error: 'episodeId 必填' })
  if (!fileContent || !String(fileContent).trim()) return res.status(400).json({ error: 'fileContent 不能为空' })

  try {
    assertNotStale(episodeId, 'assets')
    assertAssetsExist(episodeId)
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message })
  }

  const episode = queryOne('SELECT * FROM episodes WHERE id = ?', [episodeId])
  if (!episode) return res.status(400).json({ error: 'episode 不存在' })

  const project = queryOne('SELECT * FROM projects WHERE id = ?', [episode.project_id])

  const characters = mergeMasterIntoEpisodeCharacters(
    query('SELECT name, name_en, description, description_en, image_url, project_character_id FROM characters WHERE episode_id = ?', [episodeId])
  )
  const props = query('SELECT name, name_en, description, description_en, image_url, owner FROM props WHERE episode_id = ?', [episodeId])
  const scenes = query('SELECT title AS name, title_en, summary AS description, summary_en, image_url, prop_names, lighting_en FROM scenes WHERE episode_id = ?', [episodeId]).map((s) => {
    let propNames = []
    try { propNames = JSON.parse(s.prop_names || '[]') } catch { propNames = [] }
    return { ...s, props: propNames }
  })
  const assets = { characters, props, scenes }

  const charCount = String(fileContent).replace(/\s+/g, '').length
  reportProgress(episodeId, SB_TASK.FROM_FILE, {
    phase: PHASE.PREPARE,
    done: 0,
    total: 1,
    message: `正在准备规整（原文约 ${charCount} 字）…`,
  })

  let ok = false
  try {
    const storyboard = await generateStoryboardFromFile(fileContent, project?.art_style || config.defaultArtStyle, assets, {
      directorNotes: episode.director_notes || '',
      onProgress: makeReporter(episodeId, SB_TASK.FROM_FILE),
      styleCategory: styleCategoryOf(project?.art_style || config.defaultArtStyle),
    })
    backfillStoryboardAssets(storyboard, assets)
    res.json({ success: true, storyboard, unmatched: storyboard.unmatched || [] })
    ok = true
  } catch (err) {
    res.status(500).json({ error: err.message })
  } finally {
    finishProgress(episodeId, SB_TASK.FROM_FILE, {
      phase: PHASE.DONE,
      done: 1,
      total: 1,
      message: ok ? '分镜规整完成' : '分镜规整已结束',
    })
  }
})

export default router
