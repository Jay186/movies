import { Router } from 'express'
import path from 'node:path'
import fs from 'node:fs'
import { query, queryOne, execute } from '../db.js'

import { buildSceneGridPrompt, buildShotGridPrompt, buildShotGridContentApp, allocateShotRefs, splitSceneGrid } from '../ai/directorRequest.js'
import { insecureDownload } from '../ai/runninghub.js'
import { assertScriptConfirmed, assertNotStale, assertNoStylePoison } from '../ai/guards.js'
import { generateShotGridApp } from '../ai/rhShotGrid.js'
import { reviewFrameImage } from '../ai/frameReview.js'
import { reviewSceneImage, buildSceneRetryNote } from '../ai/sceneReview.js'
import { recordAlert, resolveAlertsByShot, resolveAlertsByScene } from '../ai/alerts.js'
import { resolvePropName } from '../ai/propNameMatch.js'
import { buildAnchorRefsForScene, registerSceneAnchors, initAnchorSetFromExisting, resolveSceneSpatialGroup, listSceneSpatialGroups, collectGroupLayoutMaterials, layoutMaterialsFingerprint, registerLayoutAnchor, getLayoutAnchor, ensureSceneAnalysis, lockCurrentGrouping, unlockGrouping, describeGroupLocks } from '../ai/sceneAnchors.js'
import { swapSceneLightingNote, ANCHOR_PRIORITY_NOTE, buildLayoutImagePrompt } from '../ai/sceneAnchorPrompt.js'
import { isSpatialSeriesAnchor } from '../ai/anchorTypes.js'
import { buildElementNote, buildSharedEnvNote, ELEMENT_NOTE_TAG, SHARED_ENV_NOTE_TAG } from '../ai/anchorTypes.js'
import { reviewLayoutImage, buildLayoutRetryNote, MAX_LAYOUT_ATTEMPTS } from '../ai/layoutReview.js'
import { acquireSpatialGroupLock, releaseSpatialGroupLock } from '../ai/spatialGroupLock.js'
import { generateImage, generateStoryboardImage, resolveProvider } from '../ai/image.js'
import { config } from '../config.js'
import { mergeMasterIntoEpisodeCharacters, syncProjectCharacterToEpisodes } from '../characterLibrary.js'
import { uploadsDir } from '../paths.js'

const router = Router()

const FRAME_DUAL_KEYFRAME_SEC = 7

fs.mkdirSync(uploadsDir, { recursive: true })


async function persistRemoteAsset(url, filename) {
  if (!url || url.startsWith('/uploads/')) return url
  try {
    const buf = await insecureDownload(url)
    fs.writeFileSync(path.join(uploadsDir, filename), buf)
    return `/uploads/${filename}`
  } catch (e) {
    console.warn(`[persistRemoteAsset] 落本地失败（${filename}），保留原 URL:`, e.message)
    return url
  }
}


export function resolveStyleAnchorUrl(episodeId) {
  if (!episodeId) return ''
  const ep = queryOne('SELECT style_anchor_url FROM episodes WHERE id = ?', [episodeId])
  const epAnchor = String(ep?.style_anchor_url || '').split('?')[0].trim()
  if (epAnchor) return epAnchor
  const preset = queryOne(
    `SELECT sp.cover_path AS cover_path
       FROM episodes e
       JOIN projects p ON p.id = e.project_id
       LEFT JOIN style_presets sp ON sp.label = p.art_style
      WHERE e.id = ? LIMIT 1`,
    [episodeId]
  )
  return String(preset?.cover_path || '').split('?')[0].trim()
}

const STYLE_ANCHOR_NOTE =
  '（注意：参考图中最后一张为【画风锚图】，仅用于锁定笔触、上色、线条与材质质感；' +
  '禁止继承其中的内容、构图、人物、光照，更不得继承其季节、天气、植被与整体色温倾向；' +
  '必须严格保留本段文字描述中的季节、气候与环境特征（如冰雪、寒冷、雾气等）。' +
  '画面内容、空间与光照一律以本段文字描述为准。）'

export function buildAnchorNote(frontCount) {
  if (frontCount <= 0) return STYLE_ANCHOR_NOTE
  const frontLabel = frontCount > 1 ? `参考图1-${frontCount}` : '参考图1'
  return `（注意：${frontLabel}只用于锁定空间布局、陈设与形象特征，其画风、笔触、上色、光影、季节与色调倾向一律不作为依据；` +
    `参考图${frontCount + 1}为【画风锚图】，是唯一的画风基准——但只取笔触、上色、线条与材质质感这四项技法，` +
    `严禁继承其内容、构图、季节、天气、植被与整体色温倾向；` +
    `必须严格保留本段文字描述中的季节、气候与环境特征（如冰雪、寒冷、雾气等）。` +
    `画面内容、空间与光照以本段文字描述为准。）`
}

export function isLiveRefUrl(u) {
  const s = String(u).split(/[?#]/)[0]
  if (!/^\/uploads\//i.test(s)) return true 
  try {
    const rel = decodeURIComponent(s).replace(/^\/uploads\//i, '')
    const abs = path.resolve(uploadsDir, rel)
    if (!abs.startsWith(path.resolve(uploadsDir) + path.sep)) return false
    return fs.existsSync(abs)
  } catch { return false }
}

export const imageJobsInflight = new Map()

function buildCharLabelByUrl(shotId, charImages) {
  if (!shotId || !charImages?.length) return {}
  const shot = queryOne(
    `SELECT s.id, s.characters FROM shots s WHERE s.id = ?`,
    [shotId]
  )
  if (!shot) return {}
  let charNames = []
  try { charNames = JSON.parse(shot.characters || '[]') } catch { charNames = [] }
  if (!charNames.length) return {}
  const episodeId = queryOne(
    `SELECT ss.episode_id FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id WHERE s.id = ?`,
    [shotId]
  )?.episode_id
  if (!episodeId) return {}
  const nameByUrl = new Map()
  for (const c of query(`SELECT name, image_url FROM characters WHERE episode_id = ?`, [episodeId])) {
    if (c.image_url) nameByUrl.set(c.image_url, c.name)
  }
  for (const s of query(`SELECT title AS name, image_url FROM scenes WHERE episode_id = ?`, [episodeId])) {
    if (s.image_url) nameByUrl.set(s.image_url, s.name)
  }
  for (const p of query(`SELECT name, image_url FROM props WHERE episode_id = ?`, [episodeId])) {
    if (p.image_url) nameByUrl.set(p.image_url, p.name)
  }
  const labelByUrl = {}
  for (const url of charImages) {
    const name = nameByUrl.get(url)
    if (name) labelByUrl[url] = name
  }
  return labelByUrl
}
const IMAGE_JOB_STALE_MS = 30 * 60 * 1000 
router.get('/image/inflight', (req, res) => {
  const now = Date.now()
  const jobs = []
  const assets = []
  for (const [key, job] of imageJobsInflight) {
    if (now - job.startedAt > IMAGE_JOB_STALE_MS) {
      imageJobsInflight.delete(key)
      continue
    }
    if (job.assetType) {
      assets.push({ assetType: job.assetType, assetId: job.assetId, startedAt: job.startedAt })
    } else {
      jobs.push({ shotId: job.shotId, imageType: job.imageType, startedAt: job.startedAt })
    }
  }
  res.json({ jobs, assets })
})

const shotGridJobs = new Map() 
const SHOT_GRID_FAILED_TTL_MS = 10 * 60 * 1000
const SHOT_GRID_STALE_MS = 30 * 60 * 1000 
router.get('/shot-grid/status', (req, res) => {
  const now = Date.now()
  const jobs = []
  for (const [key, job] of shotGridJobs) {
    if (job.state === 'running' && now - job.startedAt > SHOT_GRID_STALE_MS) {
      shotGridJobs.delete(key)
      continue
    }
    if (job.state === 'failed' && job.finishedAt && now - job.finishedAt > SHOT_GRID_FAILED_TTL_MS) {
      shotGridJobs.delete(key)
      continue
    }
    jobs.push({
      shotId: job.shotId,
      state: job.state,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt || null,
      error: job.error || null,
    })
  }
  res.json({ jobs })
})

const IMAGE_TYPES = ['frame', 'blocking', 'keyframe']

router.post('/image', async (req, res) => {
  const { shotId, prompt, imageType = 'frame', provider } = req.body
  if (!shotId) return res.status(400).json({ error: 'shotId 必填' })
  if (!prompt) {
    return res.status(400).json({ error: 'shotId 和 prompt 必填' })
  }
  if (!IMAGE_TYPES.includes(imageType)) {
    return res.status(400).json({ error: `imageType 必须是 ${IMAGE_TYPES.join('/')}` })
  }

  const shot = queryOne(
    'SELECT s.id, s.shot_number, s.duration, s.final_frame, ss.episode_id FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id WHERE s.id = ?',
    [shotId]
  )
  if (!shot) return res.status(404).json({ error: '镜头不存在' })
  try {
    assertScriptConfirmed(shot.episode_id)
    assertNotStale(shot.episode_id, 'storyboard')
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message })
  }

  const jobKey = `${imageType}:${shotId}`
  imageJobsInflight.set(jobKey, { shotId, imageType, startedAt: Date.now() })

  try {
    let result
    if (imageType === 'frame' || imageType === 'keyframe') {
      const isKeyframe = imageType === 'keyframe'
      const finalFrameText = String(shot.final_frame || '').trim()
      const charImages = (Array.isArray(req.body.charImages) ? req.body.charImages : []).filter(Boolean)
      const sceneImage = req.body.sceneImage || ''
      const propImages = (Array.isArray(req.body.propImages) ? req.body.propImages : []).filter(Boolean)
      const refs = []
      let framePrompt = prompt

      const allImageUrls = [...charImages, ...(sceneImage ? [sceneImage] : []), ...propImages]
      const labelByUrl = buildCharLabelByUrl(shotId, allImageUrls)
      for (let i = 0; i < charImages.length; i++) {
        const u = charImages[i]
        refs.push(u)
        const name = labelByUrl[u]
        if (name) framePrompt += `\n（注意：参考图${i + 1}（按上传顺序）是@${name}；画面中这些角色必须全部出现并各自保持自己的外形、颜色、特征，禁止把不同角色画成同一种造型。）`
      }
      if (sceneImage) {
        refs.push(sceneImage)
        const sceneName = labelByUrl[sceneImage]
        framePrompt += `\n（注意：参考图是@${sceneName || '未知场景'}场景图，仅用于锁定环境、空间、色调与光影氛围。）`
      }
      for (let i = 0; i < propImages.length; i++) {
        const p = propImages[i]
        refs.push(p)
        const name = labelByUrl[p]
        framePrompt += `\n（注意：道具参考图为@${name || '未知道具'}，仅用于锁定其外形、配色与材质，背景与文字标注一律不要出现在画面里。）`
      }
      const projectRow = queryOne(
        'SELECT p.aspect_ratio FROM projects p JOIN episodes e ON e.project_id = p.id WHERE e.id = ?',
        [shot.episode_id]
      )
      const arRaw = String(projectRow?.aspect_ratio || config.video.defaultAspectRatio)
      const arShort = arRaw.split(' ')[0] 
      const isPortrait = /^9:16$|^3:4$|^2:3$/.test(arShort)
      const isSquare = arShort === '1:1'
      const frameWording = isSquare
        ? `标准 ${arShort} 方形构图的单一完整场景`
        : isPortrait
          ? `标准 ${arShort} 竖幅构图的单一完整场景`
          : `标准 ${arShort} 横幅构图的单一完整场景`
      framePrompt += `\n（注意：参考图中每张角色设定图都是同一个角色的多视角展示（正面/侧面/背面/细节标注格），仅用于锁定该角色的外形、配色与服饰，绝对不要把不同视角画成多个角色；设定图中的文字标注、细节小格一律不要出现在画面里。最终画面必须是${frameWording}：把所有角色放进同一个场景中自然互动，每个角色只出现一次，禁止复制、重复任何角色，禁止分栏、拼贴、并排多格或超宽全景长图。）`
      framePrompt += '\n【比例约束】所有出场角色（包括 @一二、@布布 等）体型大小必须符合场景参考图的真实空间尺度，与门窗、地面、茶几等环境元素保持合理比例，禁止放大某个角色或缩小其他角色导致比例失调（刻意的特写镜头除外）。多个角色共处一景时，它们之间的相对大小也必须符合实际空间关系，禁止把"说话者"画得明显大于"沉默者"。'
      const durationSec = Number(shot?.duration) || 0
      const dualKeyframe = !isKeyframe && durationSec >= FRAME_DUAL_KEYFRAME_SEC
      const keyframePrompt = isKeyframe
        ? `${framePrompt}\n（时间锚点：这是本镜头的【尾帧】，定格在动作全部完成后的结束状态——呈现本镜动作造成的结果与最终画面，不包含已经过去的过程。${finalFrameText ? `本镜最终画面描述为：「${finalFrameText}」，请以此为画面内容的准绳。` : ''}）`
        : ''
      const promptStart = dualKeyframe
        ? `${framePrompt}\n（时间锚点：这是本镜头的【首帧】，定格在动作开始前的起始状态——人物处于动作起点、尚未进入后续变化，画面呈现本镜开始的瞬间。）`
        : framePrompt
      const promptEnd = dualKeyframe
        ? `${framePrompt}\n（时间锚点：这是本镜头的【尾帧】，定格在动作全部完成后的结束状态——呈现本镜动作造成的结果与最终画面，不包含已经过去的过程。）`
        : framePrompt
      if (isKeyframe) {
        console.log('[/generate/image] keyframe single-shot', { shotId, durationSec, hasFinalFrame: !!finalFrameText })
      } else if (dualKeyframe) {
        console.log('[/generate/image] frame dual-keyframe', { shotId, durationSec, threshold: FRAME_DUAL_KEYFRAME_SEC })
      } else {
        console.log('[/generate/image] frame single-shot', { shotId, durationSec })
      }
      const reviewEnabled = config.storyboard?.frameReview !== false
      const reviewRetry = reviewEnabled ? Math.max(0, config.storyboard?.frameReviewRetry ?? 1) : 0
      const promptPerKey = isKeyframe
        ? [keyframePrompt]
        : dualKeyframe
          ? [promptStart, promptEnd]
          : [framePrompt]

      const fileTag = isKeyframe ? 'keyframe' : 'frame'
      const columnForIndex = (i) => {
        if (isKeyframe) return 'keyframe_url'
        return i === 0 ? 'frame_url' : 'frame_url2'
      }

      const generateVerifyOne = async (promptText, idx) => {
        let last = null
        for (let attempt = 0; attempt <= reviewRetry; attempt++) {
          const stamp = Date.now()
          const filename = `shot_${shotId}_${fileTag}_${stamp}_${idx}_a${attempt}.png`
          const gen = await generateStoryboardImage(promptText, refs, { filename, provider })
          if (!gen?.success || !gen.url) return { error: gen?.error || '生成失败' }
          const storedUrl = await persistRemoteAsset(gen.url, filename)
          const review = reviewEnabled
            ? await reviewFrameImage(storedUrl, { episodeId: shot.episode_id, shotId, attempt })
            : { verdict: 'skip', defects: [], summary: '' }
          last = { url: storedUrl, review }
          if (review.verdict !== 'fail') return last
          if (attempt < reviewRetry) {
            console.log(`[/generate/image] 镜 ${shotId} 第 ${idx + 1} 张验收不合格，自动重抽 ${attempt + 1}/${reviewRetry}：`,
              (review.defects || []).map((d) => d.type).join(',') || review.summary)
          } else {
            console.warn(`[/generate/image] 镜 ${shotId} 第 ${idx + 1} 张重抽后仍不合格，沿用当前结果（不阻塞出图）：`,
              (review.defects || []).map((d) => d.type).join(',') || review.summary)
            recordAlert({
              source: 'frameReview',
              level: 'warn',
              episodeId: shot.episode_id,
              shotId: Number(shotId),
              shotNumber: shot.shot_number || '',
              message: `镜 ${shot.shot_number || shotId} 分镜图重抽 ${reviewRetry} 次后仍不合格（${(review.defects || []).map((d) => d.type).join(',') || review.summary}），当前图带伤上岗——建议人工改提示词后重出，或确认接受。`,
              detail: JSON.stringify({ defects: review.defects || [], summary: review.summary || '' }),
            })
          }
        }
        return last
      }

      const settled = await Promise.allSettled(promptPerKey.map((p, idx) => generateVerifyOne(p, idx)))
      const urls = []
      const reviews = []
      let lastError = ''
      let retriedCount = 0
      for (let i = 0; i < settled.length; i++) {
        const s = settled[i]
        const val = s.status === 'fulfilled' ? s.value : { error: s.reason?.message || String(s.reason) }
        if (val?.url) {
          execute(`UPDATE shots SET ${columnForIndex(i)} = ? WHERE id = ?`, [val.url, shotId])
          urls.push(val.url)
          if (val.review?.verdict === 'fail') retriedCount++
          if (val.review?.verdict !== 'fail') {
            resolveAlertsByShot(Number(shotId), 'frame-regen', 'frameReview')
          }
          reviews.push({
            index: i,
            verdict: val.review?.verdict || 'skip',
            defects: val.review?.defects || [],
            summary: val.review?.summary || '',
          })
        } else {
          lastError = val?.error || '生成失败'
        }
      }
      if (!dualKeyframe && !isKeyframe) {
        execute("UPDATE shots SET frame_url2 = '' WHERE id = ?", [shotId])
      }
      console.log('[/generate/image] frame batch done', { shotId, imageType, okCount: urls.length, error: lastError || 'none' })
      if (urls.length) {
        result = { success: true, url: urls[0], urls, imageType, dualKeyframe: !!dualKeyframe && urls.length > 1, reviews, retriedCount }
      } else {
        result = { success: false, error: lastError }
      }
    } else {
      result = await generateImage(prompt, { filename: `shot_${shotId}_${imageType}_${Date.now()}.png`, provider })

      console.log('[/generate/image] start', { shotId, imageType, promptLength: prompt?.length })
      console.log('[/generate/image] result', { shotId, imageType, success: result.success, hasUrl: !!result.url, url: result.url?.slice(0, 120) })
      if (result.success && result.url) {
        const urlField = `${imageType}_url`
        const storedUrl = await persistRemoteAsset(result.url, `shot_${shotId}_${imageType}_${Date.now()}.png`)
        execute(`UPDATE shots SET ${urlField} = ? WHERE id = ?`, [storedUrl, shotId])
        result.url = storedUrl
        console.log(`[/generate/image] saved ${urlField} for shot`, shotId)
      }
    }
    res.json(result)
  } catch (err) {
    console.error('[/generate/image] error', { shotId, error: err.message })
    res.status(500).json({ error: err.message })
  } finally {
    imageJobsInflight.delete(jobKey)
  }
})

router.post('/shot-grid', async (req, res) => {
  const { shotId, provider, model } = req.body
  if (!shotId) return res.status(400).json({ error: 'shotId 必填' })
  const shot = queryOne('SELECT * FROM shots WHERE id = ?', [Number(shotId)])
  if (!shot) return res.status(404).json({ error: `镜头不存在 (shotId=${shotId})` })
  const sceneRow = queryOne('SELECT episode_id FROM storyboard_scenes WHERE id = ?', [shot.storyboard_scene_id])
  if (!sceneRow) return res.status(404).json({ error: '镜头所属场次不存在' })
  const episodeId = sceneRow.episode_id
  try {
    assertNoStylePoison({ ...shot, episode_id: episodeId }, req.body.allowStyleShift)
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message })
  }
  const shotGridJobKey = Number(shotId)
  const existingGridJob = shotGridJobs.get(shotGridJobKey)
  if (existingGridJob?.state === 'running' && Date.now() - existingGridJob.startedAt <= SHOT_GRID_STALE_MS) {
    return res.status(409).json({ error: '该镜头正在出四宫格，请等待完成后再试' })
  }
  shotGridJobs.set(shotGridJobKey, { state: 'running', shotId: shotGridJobKey, startedAt: Date.now() })

  try {
    const project = queryOne('SELECT art_style FROM projects WHERE id = (SELECT project_id FROM episodes WHERE id = ?)', [episodeId])
    let stylePrompt = project?.art_style || ''
    try {
      if (stylePrompt) {
        const sp = queryOne('SELECT prompt FROM style_presets WHERE label = ? LIMIT 1', [stylePrompt])
        if (sp?.prompt) stylePrompt = sp.prompt
      }
    } catch {  }

    const charRowsAll = mergeMasterIntoEpisodeCharacters(
      query('SELECT id, name, description, image_url FROM characters WHERE episode_id = ?', [episodeId])
    )
    const parseNames = (v) => {
      if (!v) return []
      try {
        const r = JSON.parse(v)
        return Array.isArray(r) ? r : []
      } catch {
        return []
      }
    }
    const charRows = []
    for (const n of parseNames(shot.characters)) {
      const c = charRowsAll.find((x) => x.name === n)
      if (c?.image_url && !charRows.some((r) => r.name === c.name)) charRows.push(c)
    }
    const boundChars = charRows.slice(0, 3)
    const sceneRows = query('SELECT id, title, summary, image_url FROM scenes WHERE episode_id = ?', [episodeId])
    const sceneRow = sceneRows.find((s) => parseNames(shot.scene_assets).includes(s.title)) || null
    const refs = [...boundChars.map((c) => c.image_url)]
    if (sceneRow?.image_url) refs.push(sceneRow.image_url)

    const promptResult = buildShotGridPrompt(shot, stylePrompt, boundChars, sceneRow)
    const prompt = promptResult.prompt
    if (promptResult.warnings?.length) console.warn('[/generate/shot-grid] 降级警告:', promptResult.warnings)
    console.log('[/generate/shot-grid] start', { shotId, refs: refs.length, scene: sceneRow?.title || null, promptLength: prompt.length })

    const rawProvider = provider || model || ''
    let result
    if (rawProvider === 'runninghub') {
      const propNames = parseNames(shot.prop_assets)
      const allPropRows = query('SELECT id, name, image_url FROM props WHERE episode_id = ?', [episodeId])
      const propRows = []
      if (propNames.length) {
        const allPropNames = allPropRows.map((r) => r.name)
        for (const pn of propNames) {
          const matched = resolvePropName(pn, allPropNames)
          if (!matched) {
            recordAlert({
              episodeId, shotId, shotNumber: shot.shot_number || '', source: 'propName', level: 'warn',
              message: `镜 ${shot.shot_number || shotId} 的道具「${pn}」在道具表中无对应项（多趟 LLM 命名不一致），四宫格无该道具参考图；请在设定页核对道具名`,
              detail: JSON.stringify({ raw: pn, candidates: allPropNames }).slice(0, 2000),
            })
            continue
          }
          const row = allPropRows.find((r) => r.name === matched)
          if (row && !propRows.some((r) => r.id === row.id)) propRows.push(row)
        }
      }
      const sceneRowsMatched = sceneRows.filter((s) => parseNames(shot.scene_assets).includes(s.title) && s.image_url)
      const slotsCount = Object.keys(config.runninghub.nodeMap.shotGridApp).filter((k) => /^image\d+$/.test(k)).length
      const refs = allocateShotRefs({
        charRows: charRows.filter((c) => c.image_url),
        sceneRows: sceneRowsMatched,
        propRows: propRows.filter((p) => p.image_url),
        slots: slotsCount,
        fill: false,
      })
      console.log('[/generate/shot-grid] runninghub refs:', refs.map((r) => `${r.slot ? '#' + r.slot : 'x(' + r.type + ')'}${r.name}`).join(' '))
      const rhChars = charRows.slice(0, 9)
      const content = buildShotGridContentApp({ shot, charRows: rhChars, sceneRow, propRows, refs, stylePrompt })
      result = await generateShotGridApp({
        prompt: content,
        refs,
        usageContext: { episodeId, task: 'shot-grid', frames: 1 },
        aspectRatio: String(req.body.aspectRatio || '').split(' ')[0] || undefined,
      })
      console.log('[/generate/shot-grid] runninghub result:', result)
    } else {
      const resolution = resolutionForModel(model)
      result = await generateStoryboardImage(prompt, refs, {
        filename: `shot_${shotId}_grid_${Date.now()}.png`,
        provider: provider || 'visionary',
        model: model || undefined,
        size: '1:1',
        resolution,
      })
    }
    if (promptResult.warnings?.length) result.warnings = promptResult.warnings
    if (result.success && result.url) {
      const storedUrl = await persistRemoteAsset(result.url, `shot_${shotId}_grid_${Date.now()}.png`)
      execute('UPDATE shots SET frame_url = ? WHERE id = ?', [storedUrl, shot.id])
      result.url = storedUrl
      result.gridImageUrl = storedUrl
      console.log('[/generate/shot-grid] saved frame_url for shot', shotId)
    }
    if (result?.success) {
      shotGridJobs.delete(shotGridJobKey)
    } else {
      shotGridJobs.set(shotGridJobKey, {
        state: 'failed', shotId: shotGridJobKey,
        startedAt: shotGridJobs.get(shotGridJobKey)?.startedAt || Date.now(),
        finishedAt: Date.now(), error: result?.error || '生成失败',
      })
    }
    res.json(result)
  } catch (err) {
    console.error('[/generate/shot-grid] error:', err)
    shotGridJobs.set(shotGridJobKey, {
      state: 'failed', shotId: shotGridJobKey,
      startedAt: shotGridJobs.get(shotGridJobKey)?.startedAt || Date.now(),
      finishedAt: Date.now(), error: err.message,
    })
    res.status(500).json({ error: err.message })
  }
})

router.post('/scene-grid', async (req, res) => {
  const { sceneId, provider, model } = req.body
  if (!sceneId) return res.status(400).json({ error: 'sceneId 必填' })
  const scene = queryOne('SELECT * FROM storyboard_scenes WHERE id = ?', [Number(sceneId)])
  if (!scene) return res.status(404).json({ error: `场次不存在 (sceneId=${sceneId})` })

  const shots = query('SELECT * FROM shots WHERE storyboard_scene_id = ? ORDER BY start_time, id', [scene.id]).slice(0, 4)
  if (shots.length === 0) return res.status(400).json({ error: '该场没有镜头，无法生成四宫格' })
  const episodeId = scene.episode_id

  try {
    const project = queryOne('SELECT art_style FROM projects WHERE id = (SELECT project_id FROM episodes WHERE id = ?)', [episodeId])
    let stylePrompt = project?.art_style || ''
    try {
      if (stylePrompt) {
        const sp = queryOne('SELECT prompt FROM style_presets WHERE label = ? LIMIT 1', [stylePrompt])
        if (sp?.prompt) stylePrompt = sp.prompt
      }
    } catch {  }

    const parseNames = (v) => {
      if (!v) return []
      try {
        const r = JSON.parse(v)
        return Array.isArray(r) ? r : []
      } catch {
        return []
      }
    }
    const charRowsAll = mergeMasterIntoEpisodeCharacters(
      query('SELECT id, name, description, image_url FROM characters WHERE episode_id = ?', [episodeId])
    )
    const charRows = []
    for (const shot of shots) {
      for (const n of parseNames(shot.characters)) {
        const c = charRowsAll.find((x) => x.name === n)
        if (c?.image_url && !charRows.some((r) => r.name === c.name)) charRows.push(c)
      }
    }
    const boundChars = charRows.slice(0, 3)
    const sceneRows = query('SELECT id, title, summary, image_url FROM scenes WHERE episode_id = ?', [episodeId])
    const sceneRow = sceneRows.find((s) => parseNames(shots[0].scene_assets).includes(s.title)) || null
    const refs = [...boundChars.map((c) => c.image_url)]
    if (sceneRow?.image_url) refs.push(sceneRow.image_url)

    const prompt = buildSceneGridPrompt(shots, stylePrompt, boundChars, sceneRow)
    console.log('[/generate/scene-grid] start', { sceneId, shots: shots.length, refs: refs.length, scene: sceneRow?.title || null, promptLength: prompt.length })

    const result = await generateStoryboardImage(prompt, refs, {
      filename: `scene_${sceneId}_grid_${Date.now()}.png`,
      provider: provider || 'visionary',
      model: model || undefined,
      size: '1:1',
      resolution: resolutionForModel(model),
    })
    if (result.success && result.url) {
      const storedUrl = await persistRemoteAsset(result.url, `scene_${sceneId}_grid_${Date.now()}.png`)
      execute('UPDATE storyboard_scenes SET grid_image_url = ? WHERE id = ?', [storedUrl, scene.id])
      result.url = storedUrl
      result.gridImageUrl = storedUrl
      try {
        const split = await splitSceneGrid(storedUrl, shots, scene.id)
        result.shotUpdates = split.updates
        console.log('[/generate/scene-grid] split cells:', split.updates.length, 'cellSize:', split.cellSize)
      } catch (e) {
        console.warn('[/generate/scene-grid] 切分失败，grid_image_url 已存但单镜图未回写:', e.message)
        result.splitError = e.message
      }
      console.log('[/generate/scene-grid] saved grid_image_url for scene', sceneId)
    }
    res.json(result)
  } catch (err) {
    console.error('[/generate/scene-grid] error:', err)
    res.status(500).json({ error: err.message })
  }
})

router.post('/asset-image', async (req, res) => {
  const { type, id, prompt, provider, refImageUrl, editInstruction } = req.body
  if (!type || !id || !prompt) return res.status(400).json({ error: 'type, id, prompt 必填' })

  const validTypes = {
    character: { table: 'characters', idField: 'id' },
    scene: { table: 'scenes', idField: 'id' },
    prop: { table: 'props', idField: 'id' },
  }
  if (!validTypes[type]) return res.status(400).json({ error: 'type 必须是 character/scene/prop' })

  const assetCols = type === 'scene' ? 'id, episode_id, scene_number' : 'id, episode_id'
  const asset = queryOne(`SELECT ${assetCols} FROM ${validTypes[type].table} WHERE id = ?`, [id])
  if (!asset) return res.status(404).json({ error: '资产不存在' })
  try {
    assertScriptConfirmed(asset.episode_id)
    assertNotStale(asset.episode_id, 'assets')
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message })
  }

  const jobKey = `asset:${type}:${id}`
  imageJobsInflight.set(jobKey, { assetType: type, assetId: id, startedAt: Date.now() })

  let spatialLock = null
  if (type === 'scene') {
    try {
      const g = await resolveSceneSpatialGroup(asset.episode_id, id)
      if (g && g.group) {
        spatialLock = await acquireSpatialGroupLock(`${asset.episode_id}:${g.group}`, `scene#${id}`)
      }
    } catch (e) {
      console.warn('[/generate/asset-image] 空间组串行锁获取失败（降级为不串行）:', e.message)
      spatialLock = null
    }
  }

  try {
    const safeId = String(id).replace(/[^\w-]/g, '')
    const refList = (Array.isArray(refImageUrl) ? refImageUrl : refImageUrl ? [refImageUrl] : [])
      .map((u) => String(u).split('?')[0].trim()).filter(Boolean)
    const anchorRefs = [...refList]
    if (!anchorRefs.length) {
      let curUrl = (queryOne(`SELECT image_url FROM ${validTypes[type].table} WHERE id = ?`, [id])?.image_url || '').split('?')[0]
      if (type === 'character') {
        const mc = queryOne('SELECT project_character_id FROM characters WHERE id = ?', [id])
        if (mc?.project_character_id) {
          curUrl = (queryOne('SELECT image_url FROM project_characters WHERE id = ?', [mc.project_character_id])?.image_url || '').split('?')[0]
        }
      }
      if (curUrl) anchorRefs.push(curUrl)
    }
    const liveRefs = anchorRefs.filter(isLiveRefUrl)
    const uniqueName = `asset-${type}-${safeId}-${Date.now()}.png`
    const subject = type === 'character' ? '角色' : type === 'scene' ? '场景' : '道具'
    const imgOpts = { filename: uniqueName, provider }
    if (type === 'character') {
      const { provider: rp } = resolveProvider({ provider })
      const assetSize = config.image[rp]?.assetSize
      if (assetSize) imgOpts.size = assetSize
    }
    const styleAnchor = (type === 'scene' || type === 'prop') ? resolveStyleAnchorUrl(asset.episode_id) : ''
    const anchorLive = styleAnchor && !liveRefs.includes(styleAnchor) && isLiveRefUrl(styleAnchor) ? styleAnchor : ''

    let sceneAnchorRefs = []
    let sceneAnchorHints = []
    let hasSpatialRef = false 
    let sceneElements = []    
    let sceneSharedEnv = []   
    let sceneSpatialRole = ''
    if (type === 'scene') {
      try {
        const anchorResult = await buildAnchorRefsForScene(asset.episode_id, id)
        sceneAnchorRefs = anchorResult.refs.filter((u) => isLiveRefUrl(u))
        sceneAnchorHints = anchorResult.promptHints
        sceneElements = anchorResult.elements || []
        sceneSharedEnv = anchorResult.sharedEnv || []
        sceneSpatialRole = String(anchorResult.spatialRole || '').trim()
        hasSpatialRef = (anchorResult.anchors || []).some(isSpatialSeriesAnchor)
        sceneAnchorRefs = sceneAnchorRefs.filter((u) => !liveRefs.includes(u) && u !== anchorLive)
        if (sceneAnchorRefs.length) {
          console.log(`[/generate/asset-image] 场景锚点 ${sceneAnchorRefs.length} 张:`, sceneAnchorHints)
        }
        if (hasSpatialRef) {
          console.log(`[/generate/asset-image] 组锚生效: ${JSON.stringify(anchorResult.anchors.filter(isSpatialSeriesAnchor).map((a) => a.key))}`)
        }
      } catch (e) {
        console.warn('[/generate/asset-image] 场景锚点查询失败（降级为无锚点）:', e.message)
      }
    }

    let promptFinal = String(prompt || '')
    if (type === 'scene') {
      const elNote = buildElementNote(sceneElements)
      if (elNote && !promptFinal.includes(ELEMENT_NOTE_TAG)) promptFinal += elNote
      const envNote = buildSharedEnvNote(sceneSharedEnv)
      if (envNote && !promptFinal.includes(SHARED_ENV_NOTE_TAG)) promptFinal += envNote
    }

    const sceneReviewEnabled = type === 'scene' && config.storyboard?.sceneReview === true
    const sceneReviewRetry = sceneReviewEnabled ? Math.max(0, config.storyboard?.sceneReviewRetry ?? 1) : 0
    const sceneReviewCtx = {
      elements: sceneElements,
      sharedEnv: sceneSharedEnv,
      spatialRole: sceneSpatialRole,
      hasLayout: sceneAnchorRefs.length > 0 && hasSpatialRef,
    }

    let result
    const runSceneGeneration = async (retryNote = '', fileName = uniqueName) => {
    const promptWithRetry = retryNote ? promptFinal + retryNote : promptFinal
    const basePrompt = hasSpatialRef ? swapSceneLightingNote(promptWithRetry) : promptWithRetry
    const imgOptsAttempt = { ...imgOpts, filename: fileName }
    const sceneHintNote = sceneAnchorHints.length
      ? `特别注意：${sceneAnchorHints.join('；')}。${hasSpatialRef ? ANCHOR_PRIORITY_NOTE : ''}`
      : ''
    if (refList.length && liveRefs.length) {
      const instruction = String(editInstruction || basePrompt).trim()
      const saRefs = sceneAnchorRefs.slice(0, Math.max(0, config.asset.maxRefs - liveRefs.length))
      const editPrompt =
        `以参考图中的${subject}为唯一形象基准，` +
        `严格保持其物种/体型/毛色/五官/表情风格/配色/描边等一切既有特征完全不变，` +
        `仅按以下要求修改画面：${instruction}。` +
        sceneHintNote +
        (anchorLive
          ? `除该修改外，其余形象细节与参考图保持一致，不要新增参考图中不存在的元素。` + buildAnchorNote(liveRefs.length + saRefs.length)
          : `除该修改外，其余所有细节与参考图保持一致，不要新增参考图中不存在的元素。`)
      result = await generateStoryboardImage(editPrompt, [...liveRefs, ...saRefs, ...(anchorLive ? [anchorLive] : [])], { filename: fileName, provider })
    } else if (refList.length) {
      const refs2 = [...sceneAnchorRefs, ...(anchorLive ? [anchorLive] : [])]
      if (!refs2.length) {
        result = await generateImage(basePrompt, imgOptsAttempt)
      } else {
        const lead = sceneAnchorRefs.length
          ? `以参考图${anchorLive ? `1~${sceneAnchorRefs.length}` : ''}为【空间与道具锚点】，严格保持同一物理空间的结构、地标物体形态与光照方向连续；按以下描述绘制：`
          : ''
        const p2 = lead + basePrompt + sceneHintNote + (anchorLive ? buildAnchorNote(sceneAnchorRefs.length) : '')
        result = await generateStoryboardImage(p2, refs2, { filename: fileName, provider })
      }
    } else if (liveRefs.length) {
      const saRefs = sceneAnchorRefs.slice(0, Math.max(0, config.asset.maxRefs - liveRefs.length))
      const saRoleNote = saRefs.length
        ? `（参考图${liveRefs.length + 1}${saRefs.length > 1 ? `~${liveRefs.length + saRefs.length}` : ''}为【同空间邻场锚点】：` +
          `仅用于校准与本场共有物体的形态、颜色、材质与破损状态，以及跨场空间结构的连续性；` +
          `严禁继承其视角、构图与光照——本图的视角、构图与空间布局一律以参考图1（本场旧图）和文字描述为准。）`
        : ''
      const styleRoleNote = anchorLive
        ? (saRefs.length
            ? `（参考图${liveRefs.length + saRefs.length + 1}为【画风锚图】，仅用于锁定笔触、上色、线条与材质质感；` +
              `禁止继承其内容、构图、季节、天气与整体色温倾向。）`
            : buildAnchorNote(liveRefs.length))
        : ''
      const redrawPrompt = anchorLive
        ? `以参考图1中的${subject}为视角、构图与空间基准，严格保持其视角、空间布局、物体位置、物种/体型/比例/毛色/五官/配色与描边特征不变，` +
          `按以下要求重绘一张规范的设定图：${basePrompt}。` +
          sceneHintNote + saRoleNote +
          `禁止改变参考图1中${subject}的视角、空间结构与形象特征，禁止自由发挥添加参考图中不存在的元素。` +
          styleRoleNote
        : `以参考图1中的${subject}为视角、构图与形象基准，严格保持其视角、构图、物种/体型/比例/毛色/五官/配色/描边与画风完全一致，` +
          `按以下要求重绘一张规范的设定图：${basePrompt}。` +
          sceneHintNote + saRoleNote +
          `禁止改变参考图1中${subject}的任何视角、形象特征与画风，禁止自由发挥添加参考图中不存在的特征。`
      result = await generateStoryboardImage(redrawPrompt, [...liveRefs, ...saRefs, ...(anchorLive ? [anchorLive] : [])], { filename: fileName, provider })
    } else if (anchorLive) {
      const anchorOnlyPrompt =
        `按以下描述绘制一张全新的环境空镜头：${basePrompt}。` +
        sceneHintNote +
        buildAnchorNote(sceneAnchorRefs.length)
      const allRefs = [...sceneAnchorRefs, anchorLive]
      result = await generateStoryboardImage(anchorOnlyPrompt, allRefs, { filename: fileName, provider })
    } else if (sceneAnchorRefs.length) {
      const sceneAnchorPrompt =
        `以参考图为【空间与道具锚点】，严格保持其中场景的空间布局、物体形态、光照方向一致；` +
        `按以下描述绘制当前视角：${basePrompt}。` +
        sceneHintNote +
        `禁止改变参考图中已有物体的形态与位置关系，禁止自由发挥添加参考图中不存在的元素。`
      result = await generateStoryboardImage(sceneAnchorPrompt, sceneAnchorRefs, { filename: fileName, provider })
    } else {
      result = await generateImage(basePrompt, imgOptsAttempt)
    }
    return result
    }   

    let sceneReviews = []
    let lastRetryNote = ''
    for (let attempt = 0; attempt <= sceneReviewRetry; attempt++) {
      const attemptName = attempt === 0 ? uniqueName : uniqueName.replace(/\.png$/, `_a${attempt}.png`)
      result = await runSceneGeneration(attempt === 0 ? '' : lastRetryNote, attemptName)
      if (!result?.success) break
      if (!sceneReviewEnabled) break
      const reviewUrl = result.url && String(result.url).startsWith('/uploads/') ? result.url : ''
      if (!reviewUrl) {
        console.warn('[/generate/asset-image] 场景质检跳过：生成结果尚未落盘')
        break
      }
      const review = await reviewSceneImage(reviewUrl, {
        episodeId: asset.episode_id,
        sceneId: id,
        sceneNumber: asset.scene_number,
        ctx: sceneReviewCtx,
        attempt: attempt + 1,
      })
      sceneReviews.push({ attempt: attempt + 1, url: reviewUrl, verdict: review.verdict, defects: review.defects || [], summary: review.summary || '' })
      if (review.verdict !== 'fail') break
      if (attempt < sceneReviewRetry) {
        lastRetryNote = buildSceneRetryNote(review.defects)
        console.log(`[/generate/asset-image] 场景 ${id} 质检不合格，自动重抽 ${attempt + 1}/${sceneReviewRetry}：`,
          (review.defects || []).map((d) => d.type).join(',') || review.summary)
      } else {
        console.warn(`[/generate/asset-image] 场景 ${id} 重抽后仍不合格，沿用当前结果（不阻塞出图）：`,
          (review.defects || []).map((d) => d.type).join(',') || review.summary)
      }
    }
    if (result.success) {
      let storedUrl = result.url
      if (!storedUrl.startsWith('/uploads/')) {
        let lastErr = null
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const buf = await insecureDownload(storedUrl)
            fs.writeFileSync(path.join(uploadsDir, uniqueName), buf)
            storedUrl = `/uploads/${uniqueName}`
            lastErr = null
            break
          } catch (e) {
            lastErr = e
            console.warn(`[/asset-image] 远程图落本地第 ${attempt} 次失败：`, e.message)
          }
        }
        if (lastErr) {
          return res.json({ success: false, error: '图片已生成但本地保存失败（远程链接无法下载），请重试' })
        }
      }
      const cacheBust = `${storedUrl}${storedUrl.includes('?') ? '&' : '?'}t=${Date.now()}`
      const bareUrl = storedUrl.split('?')[0]

      const histAssetId = type === 'character'
        ? (queryOne('SELECT project_character_id FROM characters WHERE id = ?', [id])?.project_character_id || null)
        : id

      const descCol = type === 'scene' ? 'summary' : 'description'
      const oldRow = queryOne(`SELECT image_url, ${descCol} AS description FROM ${validTypes[type].table} WHERE id = ?`, [id])
      let oldDesc = oldRow?.description || ''
      let oldImg = (oldRow?.image_url || '').split('?')[0]
      if (histAssetId && type === 'character') {
        const master = queryOne('SELECT image_url, description FROM project_characters WHERE id = ?', [histAssetId])
        if (master) { oldImg = (master.image_url || '').split('?')[0]; oldDesc = master.description || '' }
      }
      if (histAssetId && oldImg && oldImg !== bareUrl) {
        const hasInitial = queryOne('SELECT id FROM asset_image_history WHERE asset_type = ? AND asset_id = ? AND image_url = ?', [type, histAssetId, oldImg])
        if (!hasInitial) {
          execute('INSERT INTO asset_image_history (asset_type, asset_id, image_url, description, source, instruction) VALUES (?, ?, ?, ?, ?, ?)',
            [type, histAssetId, oldImg, oldDesc, 'initial', '历史版本'])
        }
      }

      execute(`UPDATE ${validTypes[type].table} SET image_url = ? WHERE id = ?`, [cacheBust, id])
      if (type === 'character' && histAssetId) {
        const newDesc = refList.length && editInstruction
          ? (() => { const cur = queryOne('SELECT description FROM project_characters WHERE id = ?', [histAssetId])?.description || ''; const base = cur.replace(/[。；;\s]*$/, ''); return (base ? base + '，' : '') + editInstruction + '。' })()
          : oldDesc
        execute('UPDATE project_characters SET image_url = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [cacheBust, newDesc, histAssetId])
        syncProjectCharacterToEpisodes(histAssetId)
        execute('INSERT INTO asset_image_history (asset_type, asset_id, image_url, description, source, instruction) VALUES (?, ?, ?, ?, ?, ?)',
          [type, histAssetId, bareUrl, newDesc, refList.length ? 'edit' : 'generate', editInstruction || ''])
      } else if (histAssetId) {
        execute('INSERT INTO asset_image_history (asset_type, asset_id, image_url, description, source, instruction) VALUES (?, ?, ?, ?, ?, ?)',
          [type, histAssetId, bareUrl, oldDesc, refList.length ? 'edit' : 'generate', editInstruction || ''])
      }
      result.url = cacheBust
      result.styleAnchor = anchorLive || null
      if (type === 'scene') {
        result.sceneElements = sceneElements
        result.sceneSharedEnv = sceneSharedEnv
      }
      result.description = type === 'character' && histAssetId
        ? (queryOne('SELECT description FROM project_characters WHERE id = ?', [histAssetId])?.description || '')
        : undefined

      if (type === 'scene' && sceneReviewEnabled && sceneReviews.length) {
        const lastReview = sceneReviews[sceneReviews.length - 1]
        result.sceneReview = {
          verdict: lastReview.verdict,
          defects: lastReview.defects,
          summary: lastReview.summary,
          attempts: sceneReviews.length,
          maxAttempts: sceneReviewRetry + 1,
        }
        result.sceneReviews = sceneReviews
        if (lastReview.verdict !== 'fail') {
          try { resolveAlertsByScene(Number(id), 'scene-regen', 'sceneReview') } catch {  }
        } else {
          try {
            recordAlert({
              source: 'sceneReview',
              level: 'warn',
              episodeId: asset.episode_id,
              sceneNumber: String(asset.scene_number || ''),
              sceneId: Number(id),
              message: `场 ${asset.scene_number || id} 场景图重抽 ${sceneReviewRetry} 次后仍与剧本不符（${(lastReview.defects || []).map((d) => d.type).join(',') || lastReview.summary}），当前图带伤上岗——建议人工确认或改提示词后重出。`,
              detail: JSON.stringify({ defects: lastReview.defects || [], summary: lastReview.summary || '' }),
            })
          } catch {  }
        }
      }

      if (type === 'scene' && result.success) {
        try {
          const reg = registerSceneAnchors(asset.episode_id, id, bareUrl)
          if (reg.registered) {
            console.log(`[/generate/asset-image] 场景 ${id} 已登记为锚点${reg.props?.length ? `（含道具锚: ${reg.props.join('、')}）` : ''}`)
          }
        } catch (e) {
          console.warn('[/generate/asset-image] 场景锚点登记失败（不影响出图）:', e.message)
        }
      }
    }
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  } finally {
    releaseSpatialGroupLock(spatialLock)
    imageJobsInflight.delete(jobKey)
  }
})


router.post('/scene-anchors/init', async (req, res) => {
  const { episodeId } = req.body
  if (!episodeId) return res.status(400).json({ error: 'episodeId 必填' })
  try {
    const result = await initAnchorSetFromExisting(Number(episodeId))
    res.json({ success: true, ...result })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.get('/scene-spatial-groups', async (req, res) => {
  const episodeId = Number(req.query.episodeId)
  if (!episodeId) return res.status(400).json({ error: 'episodeId 必填' })
  try {
    const rows = await listSceneSpatialGroups(episodeId)
    const groups = {}
    for (const r of rows) {
      groups[String(r.sceneId)] = {
        group: r.spatialGroup || '',
        role: r.spatialRole || '',
        sceneNumber: r.sceneNumber || 0,
        hasImage: !!r.hasImage,
      }
    }
    res.json({ success: true, episodeId, groups })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})


router.get('/layout-anchor', async (req, res) => {
  const episodeId = Number(req.query.episodeId)
  const group = String(req.query.group || '').trim()
  if (!episodeId || !group) return res.status(400).json({ error: 'episodeId/group 必填' })
  try {
    try { await ensureSceneAnalysis(episodeId) } catch (e) {
      console.warn('[/layout-anchor] 场景分析失败（降级为读现有锚）：', e.message)
    }
    const materials = collectGroupLayoutMaterials(episodeId, group)
    if (!materials) return res.status(404).json({ error: 'group 不存在（无成员场景）' })
    const anchor = getLayoutAnchor(episodeId, group)
    res.json({ success: true, episodeId, group, anchor, materials })
  } catch (e) {
    console.error('[/layout-anchor] GET 失败:', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.post('/layout-anchor', async (req, res) => {
  const { episodeId, group, provider } = req.body || {}
  const ep = Number(episodeId)
  const g = String(group || '').trim()
  if (!ep || !g) return res.status(400).json({ error: 'episodeId/group 必填' })
  try {
    assertScriptConfirmed(ep)
    try { await ensureSceneAnalysis(ep) } catch (e) {
      console.warn('[/layout-anchor] 场景分析失败（素材可能不全）:', e.message)
    }
    const materials = collectGroupLayoutMaterials(ep, g)
    if (!materials) return res.status(404).json({ error: 'group 不存在（无成员场景）' })

    const layoutStyleText = (() => {
      const proj = queryOne(
        'SELECT p.art_style FROM projects p JOIN episodes e ON e.project_id = p.id WHERE e.id = ?',
        [ep]
      )
      const label = String(proj?.art_style || '').trim()
      if (!label) return ''
      const sp = queryOne('SELECT prompt FROM style_presets WHERE label = ? LIMIT 1', [label])
      return String(sp?.prompt || label).trim()
    })()
    const layoutPrompt = buildLayoutImagePrompt({
      group: g,
      roles: materials.roles,
      landmarks: materials.landmarks,
      env: materials.env,
      styleText: layoutStyleText,
    })
    console.log(`[/layout-anchor] 生成布局图 group=${g} 素材: roles=${materials.roles.length} landmarks=${materials.landmarks.length} env=${materials.env.length}`)

    const attempts = []
    let finalUrl = null
    let finalReview = null
    let retryNote = ''
    for (let attempt = 1; attempt <= MAX_LAYOUT_ATTEMPTS; attempt++) {
      const p = attempt === 1
        ? layoutPrompt
        : buildLayoutImagePrompt({
            group: g,
            roles: materials.roles,
            landmarks: materials.landmarks,
            env: materials.env,
            styleText: layoutStyleText,
            retryNote,
          })
      const filename = `layout-${String(g).replace(/[^\w-]/g, '')}-${Date.now()}-a${attempt}.png`
      const gen = await generateImage(p, { filename, provider })
      if (!gen?.success || !gen.url) {
        attempts.push({ attempt, ok: false, error: gen?.error || '生成失败' })
        if (attempt === MAX_LAYOUT_ATTEMPTS) {
          return res.json({ success: false, error: gen?.error || '布局图生成失败', attempts })
        }
        continue
      }
      let storedUrl = gen.url
      if (!storedUrl.startsWith('/uploads/')) {
        let lastErr = null
        for (let d = 1; d <= 3; d++) {
          try {
            const buf = await insecureDownload(storedUrl)
            fs.writeFileSync(path.join(uploadsDir, filename), buf)
            storedUrl = `/uploads/${filename}`
            lastErr = null
            break
          } catch (e) {
            lastErr = e
            console.warn(`[/layout-anchor] 远程图落本地第 ${d} 次失败：`, e.message)
          }
        }
        if (lastErr) {
          attempts.push({ attempt, ok: false, error: '本地保存失败' })
          continue
        }
      }
      const bare = storedUrl.split('?')[0]

      const review = await reviewLayoutImage(bare, { episodeId: ep, attempt })
      attempts.push({
        attempt, ok: true, url: bare,
        verdict: review.verdict,
        defects: review.defects || [],
        skipReason: review.skipReason,
      })

      finalUrl = bare
      finalReview = review

      if (review.verdict !== 'fail') {
        console.log(`[/layout-anchor] 第 ${attempt} 版通过质检（verdict=${review.verdict}）: ${bare}`)
        break
      }
      console.warn(`[/layout-anchor] 第 ${attempt} 版未通过质检：${(review.defects || []).map((d) => d.type).join(',')} — ${review.summary || ''}`)
      retryNote = buildLayoutRetryNote(review.defects)
      if (attempt === MAX_LAYOUT_ATTEMPTS) {
        console.warn(`[/layout-anchor] 已达重试上限 ${MAX_LAYOUT_ATTEMPTS} 次，仍用最后一版（不阻断流程）`)
      }
    }
    if (!finalUrl) {
      return res.json({ success: false, error: '布局图生成失败（无可用版本）', attempts })
    }
    const storedUrl = finalUrl
    const bareStored = storedUrl.split('?')[0]

    const rep = queryOne(
      `SELECT s.id AS scene_id, s.scene_number FROM scene_analysis sa
       JOIN scenes s ON s.id = sa.scene_id
       WHERE sa.episode_id = ? AND sa.spatial_group = ?
       ORDER BY s.scene_number ASC LIMIT 1`,
      [ep, g]
    )
    const materialsFp = layoutMaterialsFingerprint(materials)
    const reg = registerLayoutAnchor(ep, g, bareStored, {
      repSceneId: rep?.scene_id, repSceneNumber: rep?.scene_number,
      description: `空间组「${g}」布局示意图（${materials.landmarks.length} 个地标 · ${materials.memberCount} 个视角）`,
      sourceFingerprint: materialsFp,
    })
    console.log(`[/layout-anchor] 已登记 layout 锚 group=${g}: ${bareStored}（素材指纹 ${materialsFp.slice(0, 8) || '空'}）`)
    res.json({
      success: true,
      group: g,
      url: bareStored,
      registered: !!reg.registered,
      materials,
      layoutReview: {
        verdict: finalReview?.verdict || 'skip',
        defects: finalReview?.defects || [],
        summary: finalReview?.summary || '',
        skipReason: finalReview?.skipReason,
        attempts: attempts.length,
        maxAttempts: MAX_LAYOUT_ATTEMPTS,
      },
      attempts,
      cacheBust: `${bareStored}?t=${Date.now()}`,
    })
  } catch (err) {
    console.error('[/layout-anchor] POST 失败:', err.message)
    res.status(err.status || 500).json({ error: err.message })
  }
})

router.get('/scene-anchors', (req, res) => {
  const { episodeId } = req.query
  if (!episodeId) return res.status(400).json({ error: 'episodeId 必填' })
  try {
    const anchors = query(
      `SELECT sa.*, ana.spatial_group, ana.spatial_role
       FROM scene_anchors sa
       LEFT JOIN scene_analysis ana ON ana.episode_id = sa.episode_id AND ana.scene_id = sa.scene_id
       WHERE sa.episode_id = ? ORDER BY sa.anchor_type, sa.scene_number`,
      [Number(episodeId)]
    )
    const byType = {}
    for (const a of anchors) {
      if (!byType[a.anchor_type]) byType[a.anchor_type] = []
      byType[a.anchor_type].push(a)
    }
    res.json({ success: true, anchors, byType })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.post('/scene-anchors/confirm', (req, res) => {
  const { anchorId, confirmed = 1 } = req.body
  if (!anchorId) return res.status(400).json({ error: 'anchorId 必填' })
  try {
    execute('UPDATE scene_anchors SET confirmed = ? WHERE id = ?', [confirmed ? 1 : 0, anchorId])
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})


router.get('/scene-groups/locks', (req, res) => {
  const ep = Number(req.query.episodeId)
  if (!ep) return res.status(400).json({ error: 'episodeId 必填' })
  try {
    const overview = describeGroupLocks(ep)
    res.json({ success: true, episodeId: ep, ...overview })
  } catch (e) {
    console.error('[/scene-groups/locks] GET 失败:', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.post('/scene-groups/locks', (req, res) => {
  const { episodeId, note } = req.body || {}
  const ep = Number(episodeId)
  if (!ep) return res.status(400).json({ error: 'episodeId 必填' })
  try {
    const r = lockCurrentGrouping(ep, { note })
    res.json({ success: true, episodeId: ep, ...r, ...describeGroupLocks(ep) })
  } catch (e) {
    console.error('[/scene-groups/locks] POST 失败:', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.delete('/scene-groups/locks', (req, res) => {
  const ep = Number(req.query.episodeId || req.body?.episodeId)
  if (!ep) return res.status(400).json({ error: 'episodeId 必填' })
  try {
    const sceneIds = req.body?.sceneIds
    const r = unlockGrouping(ep, { sceneIds })
    res.json({ success: true, episodeId: ep, ...r, ...describeGroupLocks(ep) })
  } catch (e) {
    console.error('[/scene-groups/locks] DELETE 失败:', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.get('/asset-image/history', (req, res) => {
  const { type, id } = req.query
  const assetTables = { character: 'characters', scene: 'scenes', prop: 'props' }
  if (!type || !id || !assetTables[type]) return res.status(400).json({ error: 'type, id 必填' })

  let histAssetId = Number(id)
  let currentImg = ''
  let currentDesc = ''
  if (type === 'character') {
    const row = queryOne('SELECT project_character_id FROM characters WHERE id = ?', [id])
    if (!row?.project_character_id) return res.json({ success: true, history: [] })
    histAssetId = row.project_character_id
    const master = queryOne('SELECT image_url, description FROM project_characters WHERE id = ?', [histAssetId])
    currentImg = (master?.image_url || '').split('?')[0]
    currentDesc = master?.description || ''
  } else {
    const descCol2 = type === 'scene' ? 'summary' : 'description'
    const row = queryOne(`SELECT image_url, ${descCol2} AS description FROM ${assetTables[type]} WHERE id = ?`, [id])
    currentImg = (row?.image_url || '').split('?')[0]
    currentDesc = row?.description || ''
  }

  const history = query(
    'SELECT id, image_url, description, source, instruction, created_at FROM asset_image_history WHERE asset_type = ? AND asset_id = ? ORDER BY id DESC LIMIT 30',
    [type, histAssetId]
  ).map((h) => ({ ...h, is_current: h.image_url === currentImg }))

  if (!history.length && currentImg) {
    execute('INSERT INTO asset_image_history (asset_type, asset_id, image_url, description, source, instruction) VALUES (?, ?, ?, ?, ?, ?)',
      [type, histAssetId, currentImg, currentDesc, 'initial', '当前版本'])
    const lid = queryOne('SELECT last_insert_rowid() AS lid').lid
    history.unshift({ id: lid, image_url: currentImg, description: currentDesc, source: 'initial', instruction: '当前版本', is_current: true })
  }

  res.json({ success: true, history, current: { image_url: currentImg, description: currentDesc } })
})

router.post('/asset-image/restore', (req, res) => {
  const { type, id, historyId } = req.body
  const assetTables = { character: 'characters', scene: 'scenes', prop: 'props' }
  if (!type || !id || !historyId || !assetTables[type]) return res.status(400).json({ error: 'type, id, historyId 必填' })

  try {
    let histAssetId = Number(id)
    if (type === 'character') {
      const row = queryOne('SELECT project_character_id FROM characters WHERE id = ?', [id])
      if (!row?.project_character_id) return res.status(400).json({ error: '该角色未关联项目库，无历史可恢复' })
      histAssetId = row.project_character_id
    }
    const hist = queryOne('SELECT * FROM asset_image_history WHERE id = ? AND asset_type = ? AND asset_id = ?',
      [historyId, type, histAssetId])
    if (!hist) return res.status(404).json({ error: '历史版本不存在' })

    const cacheBust = `${hist.image_url}?t=${Date.now()}`
    if (type === 'character') {
      execute('UPDATE project_characters SET image_url = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [cacheBust, hist.description, histAssetId])
      syncProjectCharacterToEpisodes(histAssetId)
    } else {
      const descCol = type === 'scene' ? 'summary' : 'description'
      execute(`UPDATE ${assetTables[type]} SET image_url = ?, ${descCol} = ? WHERE id = ?`, [cacheBust, hist.description, id])
    }
    console.log('[/asset-image/restore] restored', { type, histAssetId, historyId })
    res.json({ success: true, url: cacheBust, description: hist.description })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
