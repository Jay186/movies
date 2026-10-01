import { Router } from 'express'
import { randomUUID } from 'crypto'
import path from 'node:path'
import fs from 'node:fs'
import { query, queryOne, execute, transaction } from '../db.js'
import { scriptHash } from '../scriptHash.js'

import { generateScript, classifyScriptIntent, reviseScriptEdits, applyScriptEdits, rewriteFullScript, rewriteScriptSegment, extractAssets, generateStoryboard, generateStoryboardFromFile, enrichShotIntegrated, extractFinalFrameFromIntegrated } from '../ai/doubao.js'
import { ensureStandardScript } from '../ai/scriptFormat.js'
import { assertScriptConfirmed, assertNotStale, assertAssetsExist } from '../ai/guards.js'
import { recordAlert, clearAlertsByRef } from '../ai/alerts.js'
import { backfillStoryboardAssets, backfillStoryboardSpace } from '../ai/assetBackfill.js'
import { normalizeExtractedAssets, persistAssets, stageAssets, takeStagedAssets, clearStagedAssets } from '../ai/assetPipeline.js'
import { classifyShotCombat } from '../ai/shotClassifier.js'
import { config } from '../config.js'
import { parseDialogue, serializeDialogue } from '../ai/dialogue.js'
import { validateStoryboardImport, formatStoryboardValidationError } from '../ai/storyboardContractValidator.js'
import { reportProgress, finishProgress, makeReporter, getProgress, getActiveProgress, listProgress } from '../ai/progressBus.js'
import { PHASE } from '../ai/progressPhases.js'
import { mergeMasterIntoEpisodeCharacters } from '../characterLibrary.js'
import { routeIp, buildCharacterContext, resolveExplicitCharacters } from '../ai/ipRouter.js'
import { finalFrameHasUndeclaredChinese } from '../ai/shotEnglish.js'
import { cancelJobsForShots } from '../jobs/videoJobRunner.js'
import { uploadsDir, tasksDir } from '../paths.js'

// 项目画风的类别（realistic / 3d-special / 2d …），供毒词豁免分桶使用；查不到返回空（退回仅按画风名豁免）。
function styleCategoryOf(label) {
  const s = String(label || '').trim()
  if (!s) return ''
  try {
    return String(queryOne('SELECT category_key FROM style_presets WHERE label = ? LIMIT 1', [s])?.category_key || '')
  } catch { return '' }
}

// 项目题材（projects.theme）：作为"题材定位"注入剧本生成与改稿，让同一套主流程服务任何剧本。
// 平台本身不预设题材——theme 为空时不注入任何题材约束，完全由用户创作意图决定。
function projectGenreOf(episodeId) {
  try {
    const ep = queryOne('SELECT project_id FROM episodes WHERE id = ?', [episodeId])
    if (!ep) return ''
    return String(queryOne('SELECT theme FROM projects WHERE id = ?', [ep.project_id])?.theme || '').trim()
  } catch { return '' }
}

const SB_TASK = {
  GENERATE: 'storyboard',
  FROM_FILE: 'file',
  ENRICH: 'enrich',
}

const router = Router()

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

async function runFullPipeline(taskId, episodeId, prompt, options) {  const { generateImages = true } = options

  const assetContext = await buildAssetContextForPrompt(prompt, episodeId, options.characterIds)

  updateTask(taskId, { status: 'running', progress: 5, message: '正在生成剧本...' })
  const rawScript = await generateScript(prompt, '', assetContext, { genre: projectGenreOf(episodeId) })
  const { text: script } = await ensureStandardScript(rawScript, { episodeId })
  execute('UPDATE episodes SET script_content = ?, script_confirmed = 1 WHERE id = ?', [script, episodeId])
  updateTask(taskId, { progress: 20, message: '剧本生成完成' })

  updateTask(taskId, { progress: 25, message: '正在提取角色/场景/道具...' })
  const episodeForStyle = queryOne('SELECT project_id FROM episodes WHERE id = ?', [episodeId])
  const projectForStyle = episodeForStyle ? queryOne('SELECT art_style FROM projects WHERE id = ?', [episodeForStyle.project_id]) : null
  const artStyle = projectForStyle?.art_style || ''
  const assets = await extractAssets(script, artStyle)
  // 统一落库（assetPipeline）：归一化 → 快照 → 三表写入 → 场景引用重挂 → 指纹回写
  const persisted = await persistAssets(episodeId, assets, {
    trigger: 'pipeline',
    recordAlerts: true,
  })
  updateTask(taskId, { progress: 35, message: '资产提取完成' })

  updateTask(taskId, { progress: 40, message: '正在生成分镜脚本...' })
  const episode = queryOne('SELECT * FROM episodes WHERE id = ?', [episodeId])
  const project = queryOne('SELECT * FROM projects WHERE id = ?', [episode.project_id])
  const savedCharMap = new Map((persisted.saved.characters || []).map((c) => [c.name, c]))
  assets.characters = (assets.characters || []).map((c) => {
    const name = typeof c === 'string' ? c : (c.name || '')
    const saved = savedCharMap.get(name) || {}
    const imageUrl = saved.image_url || ''
    const description = saved.description || (typeof c === 'string' ? '' : c.description) || ''
    const nameEn = saved.name_en || (typeof c === 'string' ? '' : (c.nameEn || c.name_en)) || ''
    const descriptionEn = saved.description_en || (typeof c === 'string' ? '' : (c.descriptionEn || c.description_en)) || ''
    return typeof c === 'string'
      ? { name: c, description, name_en: nameEn, description_en: descriptionEn, image_url: imageUrl }
      : { ...c, description, name_en: nameEn, description_en: descriptionEn, image_url: imageUrl }
  })
  const finalSceneMap = new Map((persisted.saved.scenes || []).map((s) => [s.title, s]))
  assets.scenes = (assets.scenes || []).map((s) => {
    const name = typeof s === 'string' ? s : (s.name || '')
    const old = finalSceneMap.get(name) || {}
    const titleEn = old.title_en || (typeof s === 'string' ? '' : (s.titleEn || s.title_en)) || ''
    const summaryEn = old.summary_en || (typeof s === 'string' ? '' : (s.summaryEn || s.summary_en)) || ''
    const lightingEn = old.lighting_en || (typeof s === 'string' ? '' : (s.lightingEn || s.lighting_en)) || ''
    const spaceType = old.space_type || old.spaceType || (typeof s === 'string' ? '' : (s.spaceType || s.space_type)) || ''
    const spaceEvidence = old.space_evidence || old.spaceEvidence || (typeof s === 'string' ? '' : (s.spaceEvidence || s.space_evidence)) || ''
    return typeof s === 'string'
      ? { name: s, title_en: titleEn, summary_en: summaryEn, lighting_en: lightingEn, space_type: spaceType, space_evidence: spaceEvidence, image_url: old.image_url || '' }
      : { ...s, title_en: titleEn, summary_en: summaryEn, lighting_en: lightingEn, space_type: spaceType, space_evidence: spaceEvidence, image_url: old.image_url || '' }
  })
  const finalPropMap = new Map((persisted.saved.props || []).map((p) => [p.name, p]))
  assets.props = (assets.props || []).map((p) => {
    const name = typeof p === 'string' ? p : (p.name || '')
    const old = finalPropMap.get(name) || {}
    const nameEn = old.name_en || (typeof p === 'string' ? '' : (p.nameEn || p.name_en)) || ''
    const descriptionEn = old.description_en || (typeof p === 'string' ? '' : (p.descriptionEn || p.description_en)) || ''
    const owner = old.owner || (typeof p === 'string' ? '' : p.owner) || ''
    return typeof p === 'string'
      ? { name: p, name_en: nameEn, description_en: descriptionEn, owner, image_url: old.image_url || '' }
      : { ...p, name_en: nameEn, description_en: descriptionEn, owner, image_url: old.image_url || '' }
  })
  const storyboard = await generateStoryboard(script, project?.art_style || config.defaultArtStyle, assets, {
    targetDuration: options.targetDuration,
    onProgress: makeReporter(episodeId, SB_TASK.GENERATE),
    styleCategory: styleCategoryOf(project?.art_style || config.defaultArtStyle),
  })

  backfillStoryboardAssets(storyboard, assets)
  // 场景空间约束属于已登记资产事实；一键生成也必须把它确定性继承到镜头，
  // 否则同一套场景资产在保存/出片门禁处会被判定为空间字段缺失。
  backfillStoryboardSpace(storyboard, assets.scenes)

  const storyboardValidation = validateStoryboardImport(storyboard, {
    characters: assets.characters,
    scenes: assets.scenes,
    props: assets.props,
    requireReferenceImages: true,
    // 综合描述尚未补全；画风声明由 enrichShotIntegrated 在最终 IMD 落库前确定性注入。
    requireStyleDeclaration: false,
    targetDuration: options.targetDuration,
  })
  if (!storyboardValidation.ok) {
    throw new Error(`生成的分镜未通过 H3 契约校验：${formatStoryboardValidationError(storyboardValidation)}`)
  }

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
    cancelJobsForShots(removedShotIds)
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
          `INSERT INTO shots (storyboard_scene_id, shot_number, duration, description, characters, scene_assets, prop_assets, shot_type, start_time, end_time, action_note, sound_effects, dialogue, camera_movement, overall_soundscape, non_diegetic_music, integrated_multimodal_description, final_frame, is_combat, camera_angle, purpose, goal, emotion_tone, info_points, world_state_out, world_state_out_en)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            sceneId,
            `${si + 1}-${shi + 1}`,
            shot.duration || config.storyboard?.defaultDuration || 8,
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
            shot.worldStateOutEn || shot.world_state_out_en || null,
          ]
        )
        // Skill 新字段（lens/colorLighting/cameraElevation）不在上方固定 INSERT 列内，
        // 生成侧产出后经此 UPDATE 落库（与 model.js buildStructuralFieldsForInput 同口径）
        const skillExtraLens = shot.lens || ''
        const skillExtraColor = shot.colorLighting || shot.color_lighting || ''
        const skillExtraElevation = shot.cameraElevation || shot.camera_elevation || ''
        const skillExtraSpace = shot.spaceType || shot.space_type || ''
        const skillExtraSpaceEvidence = shot.spaceEvidence || shot.space_evidence || ''
        if (skillExtraLens || skillExtraColor || skillExtraElevation || skillExtraSpace || skillExtraSpaceEvidence) {
          execute(
            'UPDATE shots SET lens = COALESCE(NULLIF(?, \'\'), lens), color_lighting = COALESCE(NULLIF(?, \'\'), color_lighting), camera_elevation = COALESCE(NULLIF(?, \'\'), camera_elevation), space_type = COALESCE(NULLIF(?, \'\'), space_type), space_evidence = COALESCE(NULLIF(?, \'\'), space_evidence) WHERE id = ?',
            [skillExtraLens, skillExtraColor, skillExtraElevation, skillExtraSpace, skillExtraSpaceEvidence, shotResult.lastInsertRowid]
          )
        }
        ids.push(shotResult.lastInsertRowid)
      }
    }
    return ids
  })
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
  const { instruction, selectedText, context = '', episodeId } = req.body
  if (!instruction || !String(instruction).trim()) return res.status(400).json({ error: '改写要求必填' })
  if (!selectedText || !String(selectedText).trim()) return res.status(400).json({ error: '请先选中要改写的段落' })

  try {
    const rewrittenText = await rewriteScriptSegment(String(selectedText), String(instruction), String(context), {
      genre: projectGenreOf(episodeId),
    })
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
      const rawScript = await generateScript(prompt, context, assetContext, { genre: projectGenreOf(episodeId) })
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
  const { episodeId, style, decision = '', mergeStrategy = 'preserve' } = req.body
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
    // 决策重试（risk 拍板后的二次调用）：优先消费服务端暂存的上次提取结果，不重复调用模型
    let assets = decision ? takeStagedAssets(episodeId) : null
    if (!assets) {
      assets = await extractAssets(episode.script_content, artStyle)
      normalizeExtractedAssets(assets)
      if (!decision) stageAssets(episodeId, assets)
    }
    // 统一落库：有风险未拍板 → 整体不写并返回三表合并报告；拍板/无风险 → 写入并回写指纹
    const persisted = await persistAssets(episodeId, assets, {
      guard: true,
      decision,
      mergeStrategy,
      trigger: 'extract-assets',
    })
    if (persisted.risk) {
      return res.json({ success: true, risk: persisted.reports, assets })
    }
    clearStagedAssets(episodeId)
    res.json({
      success: true,
      persisted: true,
      assets: persisted.saved,
      staleAssets: persisted.staleAssets,
      scriptFp: persisted.scriptFp,
    })
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
  const scenes = query('SELECT title AS name, title_en, summary AS description, summary_en, image_url, prop_names, lighting_en, space_type, space_evidence FROM scenes WHERE episode_id = ?', [episodeId]).map((s) => {
    let propNames = []
    try { propNames = JSON.parse(s.prop_names || '[]') } catch { propNames = [] }
    return { ...s, props: propNames }
  })
  const props = query('SELECT name, name_en, description, description_en, image_url, owner FROM props WHERE episode_id = ?', [episodeId])
  const assets = { characters, scenes, props }

  // 既有镜头的空间字段只从场景资产继承；补全 IMD 前先完成确定性回填，
  // 这样补全后的统一契约校验不会因为历史镜头缺字段而误报。
  execute(
    `UPDATE shots SET
       space_type = COALESCE(NULLIF(space_type, ''), NULLIF((SELECT sc.space_type FROM scenes sc JOIN storyboard_scenes ss2 ON ss2.episode_id = sc.episode_id AND ss2.scene_number = sc.scene_number WHERE ss2.id = shots.storyboard_scene_id LIMIT 1), '')),
       space_evidence = COALESCE(NULLIF(space_evidence, ''), NULLIF((SELECT sc.space_evidence FROM scenes sc JOIN storyboard_scenes ss2 ON ss2.episode_id = sc.episode_id AND ss2.scene_number = sc.scene_number WHERE ss2.id = shots.storyboard_scene_id LIMIT 1), ''))
     WHERE storyboard_scene_id IN (SELECT id FROM storyboard_scenes WHERE episode_id = ?)`,
    [episodeId]
  )

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
      // 契约编译已退役（2026-10-01）：英文版是分镜数据列，由保存同步（scheduleEnglishSync）
      // 与出片自愈（compileShotEnglish）负责，enrich 只补 IMD（图像提示词），跳过条件只看 IMD。
      if (onlyMissing && (shot.integrated_multimodal_description || '').trim()) {
        skipped++
        tick()
        continue
      }
      const shotForAI = {
        description: shot.description || '',
        duration: shot.duration || config.storyboard?.defaultDuration || 8,
        shotType: shot.shot_type || config.storyboard?.defaultShotType || '中景',
        characters: JSON.parse(shot.characters || '[]'),
        sceneAssets: JSON.parse(shot.scene_assets || '[]'),
        propAssets: JSON.parse(shot.prop_assets || '[]'),
        dialogue: (() => {
          const lines = parseDialogue(shot.dialogue)
          return lines.length ? lines : null
        })(),
        actionNote: shot.action_note || '',
        worldStateIn: shot.world_state_in || '',
        worldStateOut: shot.world_state_out || '',
      }
      let lastErr = null
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (attempt > 0) {
            await new Promise(r => setTimeout(r, 3000 * attempt))
          }
          const integrated = await enrichShotIntegrated(shotForAI, assets, project?.art_style || config.defaultArtStyle, { styleCategory: styleCategoryOf(project?.art_style || config.defaultArtStyle) })
          if (integrated) {
            const finalFrame = extractFinalFrameFromIntegrated(integrated, assets)
            // 末帧校验与出片门禁同一口径：@角色名引用（角色名保留原文）合法，
            // 只拦"空末帧 / 未声明主体的中文叙述"（2026-10-01 与 shotEnglish 对齐）
            if (!finalFrame || finalFrameHasUndeclaredChinese(finalFrame, shot)) {
              throw new Error('模型未产出可用末帧（末帧为空或含未声明主体的中文），本镜不落库')
            }
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
    message: '补全完成，正在做结构检查…',
  })

  // 越轴是否成立取决于 Skill 的镜头设计和实际调度。补全接口只补齐缺失的
  // 图像提示词，不再调用另一个模型改写已定稿镜头或自动落越轴告警。
  let axisFixed = 0
  let axisFailed = 0
  let axisUnresolved = []
  const postEnrichRows = query(
    `SELECT s.*, ss.scene_number, ss.title AS scene_title
     FROM shots s JOIN storyboard_scenes ss ON ss.id = s.storyboard_scene_id
     WHERE ss.episode_id = ? ORDER BY ss.scene_number, s.start_time, s.id`,
    [episodeId]
  )
  const postEnrichValidation = validateStoryboardImport({ scenes: [{ shots: postEnrichRows }] }, {
    characters: query('SELECT name, image_url FROM characters WHERE episode_id = ?', [episodeId]),
    scenes: query('SELECT title, image_url FROM scenes WHERE episode_id = ?', [episodeId]),
    props: query('SELECT name, image_url FROM props WHERE episode_id = ?', [episodeId]),
    requireReferenceImages: true,
    requireStyleDeclaration: true,
  })
  const enrichSuccess = failed === 0 && postEnrichValidation.ok
  res.status(enrichSuccess ? 200 : 422).json({ success: enrichSuccess, enriched, failed, skipped, total: shots.length, axisFixed, axisFailed, errors: errors.length ? errors : undefined, validation: postEnrichValidation })
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
  const scenes = query('SELECT title AS name, title_en, summary AS description, summary_en, image_url, prop_names, lighting_en, space_type, space_evidence FROM scenes WHERE episode_id = ?', [episodeId]).map((s) => {
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
      onProgress: makeReporter(episodeId, SB_TASK.GENERATE),
      styleCategory: styleCategoryOf(project?.art_style || config.defaultArtStyle),
    })
    backfillStoryboardAssets(storyboard, assets)
    backfillStoryboardSpace(storyboard, scenes)
    const validation = validateStoryboardImport(storyboard, {
      characters,
      scenes,
      props,
      targetDuration,
      requireReferenceImages: true,
      // 原始分镜阶段没有最终 IMD，画风门禁在补全后执行。
      requireStyleDeclaration: false,
    })
    if (!validation.ok) {
      return res.status(422).json({
        error: formatStoryboardValidationError(validation),
        code: 'STORYBOARD_CONTRACT_INVALID',
        errors: validation.errors,
        warnings: validation.warnings,
        storyboard,
      })
    }
    res.json({ success: true, storyboard, unmatched: storyboard.unmatched || [], validation })
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
  const scenes = query('SELECT title AS name, title_en, summary AS description, summary_en, image_url, prop_names, lighting_en, space_type, space_evidence FROM scenes WHERE episode_id = ?', [episodeId]).map((s) => {
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
      onProgress: makeReporter(episodeId, SB_TASK.FROM_FILE),
      styleCategory: styleCategoryOf(project?.art_style || config.defaultArtStyle),
    })
    backfillStoryboardAssets(storyboard, assets)
    backfillStoryboardSpace(storyboard, scenes)
    const validation = validateStoryboardImport(storyboard, {
      characters, scenes, props,
      requireReferenceImages: true,
      // 文件规整阶段只产出镜头结构；综合描述补全后才检查画风锚点。
      requireStyleDeclaration: false,
    })
    if (!validation.ok) {
      return res.status(422).json({
        error: formatStoryboardValidationError(validation),
        code: 'STORYBOARD_CONTRACT_INVALID',
        errors: validation.errors,
        warnings: validation.warnings,
        storyboard,
      })
    }
    res.json({ success: true, storyboard, unmatched: storyboard.unmatched || [], validation })
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
