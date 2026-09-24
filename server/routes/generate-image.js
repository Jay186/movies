import { Router } from 'express'
import path from 'node:path'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { query, queryOne, execute } from '../db.js'

import { buildSceneGridPrompt, buildShotGridPrompt, buildShotGridContentApp, allocateShotRefs, splitSceneGrid } from '../ai/directorRequest.js'
import { insecureDownload } from '../ai/runninghub.js'
import { assertScriptConfirmed, assertNotStale, assertNoStylePoison } from '../ai/guards.js'
import { generateShotGridApp } from '../ai/rhShotGrid.js'
import { reviewFrameImage } from '../ai/frameReview.js'
import { reviewSceneImage, buildSceneRetryNote } from '../ai/sceneReview.js'
import { recordAlert, resolveAlertsByShot, resolveAlertsByScene } from '../ai/alerts.js'
import { resolvePropName } from '../ai/propNameMatch.js'
import { buildAnchorRefsForScene, buildShotAnchorInjection, resolveSceneSpatialGroup, listSceneSpatialGroups, collectGroupLayoutMaterials, layoutMaterialsFingerprint, registerLayoutAnchor, getLayoutAnchor, getLayoutAnchorHistory, restoreLayoutAnchor, ensureSceneAnalysis, lockCurrentGrouping, unlockGrouping, describeGroupLocks, getLayoutRoute, setLayoutRoute, normalizeSceneGrouping } from '../ai/sceneAnchors.js'
import { bareUrl } from '../ai/shared.js'
import { swapSceneLightingNote, ANCHOR_PRIORITY_NOTE, buildLayoutImagePrompt } from '../ai/sceneAnchorPrompt.js'
import { isSpatialSeriesAnchor, LAYOUT_ANCHOR_TYPE, SPATIAL_ANCHOR_TYPE } from '../ai/anchorTypes.js'
import { buildElementNote, buildSharedEnvNote, ELEMENT_NOTE_TAG, SHARED_ENV_NOTE_TAG } from '../ai/anchorTypes.js'
import { reviewLayoutImage, buildLayoutRetryNote, MAX_LAYOUT_ATTEMPTS } from '../ai/layoutReview.js'
import { acquireSpatialGroupLock, releaseSpatialGroupLock } from '../ai/spatialGroupLock.js'
import { generateImage, generateStoryboardImage, resolveProvider, resolutionForModel } from '../ai/image.js'
import { config } from '../config.js'
import { mergeMasterIntoEpisodeCharacters, syncProjectCharacterToEpisodes } from '../characterLibrary.js'
import { uploadsDir } from '../paths.js'

const router = Router()

// scenes.gen_context：场景图出图时的注入上下文快照（JSON：b=基准图指纹 l=布局图指纹 d=描述hash），
// 是「过时判定」的地基——现在应注入什么 ≠ 当时注入了什么 = 该重出。旧库运行时迁移。
try {
  execute("ALTER TABLE scenes ADD COLUMN gen_context TEXT DEFAULT ''")
} catch (e) {
  if (!/duplicate column/i.test(String(e.message || ''))) throw e
}

// 指纹用裸 URL（去 cache 参数）：换图/换版本必换 URL，天然区分版本
function assetDescHash(text) {
  return createHash('md5').update(String(text || '')).digest('hex').slice(0, 16)
}

// 单张场景图的过时判定（/scene-out-plan 用）。规则与 gen_context 的写入口一一对应：
//   baseline —— 当时注入的基准指纹 ≠ 现在应注入的（换基准/重确认）→ 过时；
//               「有→无」降级（skip/清基准是用户拍板）→ 豁免；
//               基准锚的源头场景（图被确认成基准的那张）→ 豁免：
//               代表场景首次出图时组还未确认、ctx.b 必为空，确认后 curB=自己的图，
//               不豁免会把所有已确认组的代表全判过时，点一次智能补出 = 全集重出
//   layout   —— 布局「无→有」升级或换版 → 过时；「有→无」降级（停用/全关）→ 豁免
//   desc     —— 场景描述 hash 变了（只改描述不清快照，靠 hash 比对兜住）
//   gen_context 为空（上传 / 换历史版本 / 功能上线前的存量图）＝ 用户拍板，一律不过时
function judgeSceneOutdated(row, { curBaselineFp = '', baselineSourceSceneId = 0, curLayoutFp = '' } = {}) {
  const hasImage = String(row.image_url || '').trim() !== ''
  const staleReasons = []
  if (hasImage) {
    let ctx = null
    try { ctx = JSON.parse(row.gen_context || '') } catch { ctx = null }
    if (ctx && typeof ctx === 'object') {
      const b = String(ctx.b ?? '')
      const l = String(ctx.l ?? '')
      const d = String(ctx.d ?? '')
      if (b !== curBaselineFp && !(b !== '' && curBaselineFp === '') && Number(baselineSourceSceneId) !== Number(row.id)) {
        staleReasons.push('baseline')
      }
      if (l !== curLayoutFp && !(l !== '' && curLayoutFp === '')) {
        staleReasons.push('layout')
      }
      if (d !== assetDescHash(row.summary)) {
        staleReasons.push('desc')
      }
    }
  }
  return {
    id: Number(row.id),
    sceneNumber: Number(row.scene_number || 0),
    title: String(row.title || ''),
    hasImage,
    missing: !hasImage,
    stale: staleReasons.length > 0,
    staleReasons,
  }
}

const FRAME_DUAL_KEYFRAME_SEC = 7

const MAX_GRID_CHARS = 3

function parseNames(v) {
  if (!v) return []
  try {
    const r = JSON.parse(v)
    return Array.isArray(r) ? r : []
  } catch {
    return []
  }
}

function loadStylePrompt(episodeId) {
  const project = queryOne('SELECT art_style FROM projects WHERE id = (SELECT project_id FROM episodes WHERE id = ?)', [episodeId])
  let stylePrompt = project?.art_style || ''
  try {
    if (stylePrompt) {
      const sp = queryOne('SELECT prompt FROM style_presets WHERE label = ? LIMIT 1', [stylePrompt])
      if (sp?.prompt) stylePrompt = sp.prompt
    }
  } catch {  }
  return stylePrompt
}

function loadGridAssets(episodeId, shots) {
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
  const boundChars = charRows.slice(0, MAX_GRID_CHARS)
  const sceneRows = query('SELECT id, title, summary, image_url FROM scenes WHERE episode_id = ?', [episodeId])
  const sceneRow = sceneRows.find((s) => parseNames(shots[0].scene_assets).includes(s.title)) || null
  const refs = [...boundChars.map((c) => c.image_url)]
  if (sceneRow?.image_url) refs.push(sceneRow.image_url)
  // charRows：本批镜头出场的全部有图角色行（不截 MAX_GRID_CHARS），runninghub 四宫格按槽位自行取用
  return { boundChars, charRows, sceneRow, sceneRows, refs }
}

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

function resolveStyleAnchorUrl(episodeId) {
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

function buildAnchorNote(frontCount) {
  if (frontCount <= 0) return STYLE_ANCHOR_NOTE
  const frontLabel = frontCount > 1 ? `参考图1-${frontCount}` : '参考图1'
  return `（注意：${frontLabel}只用于锁定空间布局、陈设与形象特征，其画风、笔触、上色、光影、季节与色调倾向一律不作为依据；` +
    `参考图${frontCount + 1}为【画风锚图】，是唯一的画风基准——但只取笔触、上色、线条与材质质感这四项技法，` +
    `严禁继承其内容、构图、季节、天气、植被与整体色温倾向；` +
    `必须严格保留本段文字描述中的季节、气候与环境特征（如冰雪、寒冷、雾气等）。` +
    `画面内容、空间与光照以本段文字描述为准。）`
}

function isLiveRefUrl(u) {
  const s = String(u).split(/[?#]/)[0]
  if (!/^\/uploads\//i.test(s)) return true 
  try {
    const rel = decodeURIComponent(s).replace(/^\/uploads\//i, '')
    const abs = path.resolve(uploadsDir, rel)
    if (!abs.startsWith(path.resolve(uploadsDir) + path.sep)) return false
    return fs.existsSync(abs)
  } catch { return false }
}

const imageJobsInflight = new Map()

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

// 单镜头空间锚注入预算（基准图 + 布局图张数上限）：env 可配；超限时布局图让位、基准图必保
const MAX_SHOT_ANCHOR_REFS = Math.max(1, Number(process.env.MAX_SHOT_ANCHOR_REFS) || 4)

// 空间锚注记（锚提示/要素/共有环境）：/image 与 /shot-grid 共用同一拼装逻辑，避免两处漂移。
// 未命中锚（基准图、布局图皆无）时不注入——组未确认人审基准时不做半套注入。
function buildAnchorPromptNotes(injection) {
  if (!injection || (!injection.baselineUrl && !injection.layoutUrl)) return ''
  let note = ''
  if (injection.promptHints?.length) {
    note += `\n（空间锚提示：${injection.promptHints.join('；')}。）`
  }
  const elNote = buildElementNote(injection.elements)
  if (elNote && !note.includes(ELEMENT_NOTE_TAG)) note += elNote
  const envNote = buildSharedEnvNote(injection.sharedEnv)
  if (envNote && !note.includes(SHARED_ENV_NOTE_TAG)) note += envNote
  return note
}

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
    'SELECT s.id, s.shot_number, s.duration, s.final_frame, s.scene_assets, ss.episode_id FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id WHERE s.id = ?',
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
      let sceneImage = req.body.sceneImage || ''
      const propImages = (Array.isArray(req.body.propImages) ? req.body.propImages : []).filter(Boolean)
      const refs = []
      let framePrompt = prompt

      // —— 空间一致性注入（服务端强制，不依赖前端拼装）：按镜头场景查已确认人审基准图与
      // 启用中的布局图。基准图替换前端传的场景图（服务端优先）；布局图追加；要素/共有环境
      // 注记与锚提示拼进提示词。任何异常降级为前端 refs 照旧出图，快照记 degraded，不阻塞产能。
      let anchorSnapshot = null
      let anchorLayoutUrl = ''
      let anchorSceneTitle = ''
      let sceneImageIsAnchor = false
      try {
        const injection = await buildShotAnchorInjection({
          episodeId: shot.episode_id,
          sceneNames: parseNames(shot.scene_assets),
        })
        anchorSceneTitle = injection.sceneTitle || ''
        anchorLayoutUrl = injection.layoutUrl || ''
        if (injection.baselineUrl) {
          sceneImage = injection.baselineUrl
          sceneImageIsAnchor = true
        }
        if (injection.snapshot) {
          anchorSnapshot = injection.snapshot
          anchorSnapshot.budget = {
            used: (injection.baselineUrl ? 1 : 0) + (injection.layoutUrl ? 1 : 0),
            max: MAX_SHOT_ANCHOR_REFS,
          }
          framePrompt += buildAnchorPromptNotes(injection)
        } else {
          // 场景未命中场景表：如实记"无锚"，面板明示"本图仅凭文字描述生成"
          anchorSnapshot = { version: 1, generated_at: new Date().toISOString(), scene: null }
        }
      } catch (e) {
        console.warn('[/generate/image] 空间锚注入失败（降级为前端 refs）:', e.message)
        anchorSnapshot = { version: 1, generated_at: new Date().toISOString(), degraded: true, reason: String(e.message || '') }
        anchorLayoutUrl = ''
        sceneImageIsAnchor = false
      }

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
        const sceneName = labelByUrl[sceneImage] || anchorSceneTitle
        framePrompt += sceneImageIsAnchor
          ? `\n（注意：参考图是@${sceneName || '未知场景'}的已确认基准图，必须严格保持同一空间结构、地标物体、色调与光影氛围。）`
          : `\n（注意：参考图是@${sceneName || '未知场景'}场景图，仅用于锁定环境、空间、色调与光影氛围。）`
      }
      if (anchorLayoutUrl && MAX_SHOT_ANCHOR_REFS >= 2) {
        refs.push(anchorLayoutUrl)
        framePrompt += `\n（注意：参考图是@${anchorSceneTitle || '本场景'}的布局示意图（俯视），仅用于锁定空间位置关系与物体相对方位，不代表实际视角与光影。）`
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
      framePrompt += '\n【比例约束】所有出场角色（包括 @角色甲、@角色乙 等）体型大小必须符合场景参考图的真实空间尺度，与门窗、地面、茶几等环境元素保持合理比例，禁止放大某个角色或缩小其他角色导致比例失调（刻意的特写镜头除外）。多个角色共处一景时，它们之间的相对大小也必须符合实际空间关系，禁止把"说话者"画得明显大于"沉默者"。'
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
        // 出图依据快照：有锚/无锚/降级都如实落库（失败不出图不写），供④分镜页面板展示
        if (anchorSnapshot) {
          execute('UPDATE shots SET anchor_refs_snapshot = ? WHERE id = ?', [JSON.stringify(anchorSnapshot), shotId])
        }
        result = {
          success: true, url: urls[0], urls, imageType,
          dualKeyframe: !!dualKeyframe && urls.length > 1, reviews, retriedCount,
          anchorSnapshot: anchorSnapshot || null,
          anchor: anchorSnapshot ? {
            anchored: Boolean(anchorSnapshot.scene?.baseline_url),
            degraded: Boolean(anchorSnapshot.degraded),
            baselineUrl: anchorSnapshot.scene?.baseline_url || '',
            layoutUrl: anchorSnapshot.scene?.layout_url || '',
          } : null,
        }
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
    const stylePrompt = loadStylePrompt(episodeId)
    const { boundChars, charRows, sceneRow, sceneRows, refs } = loadGridAssets(episodeId, [shot])

    // —— 空间一致性注入（与 /image 同源）：按镜头场景取已确认人审基准图与启用中的布局图。
    // 基准图替换场景参考图（服务端优先）、布局图按预算追加、锚注记拼进提示词；
    // 任何异常降级为原 refs 照旧出图，快照记 degraded，不阻塞产能。
    let anchorSnapshot = null
    let anchorInjection = null
    try {
      anchorInjection = await buildShotAnchorInjection({ episodeId, sceneNames: parseNames(shot.scene_assets) })
      if (anchorInjection.snapshot) {
        anchorSnapshot = anchorInjection.snapshot
        anchorSnapshot.budget = {
          used: (anchorInjection.baselineUrl ? 1 : 0) + (anchorInjection.layoutUrl ? 1 : 0),
          max: MAX_SHOT_ANCHOR_REFS,
        }
      } else {
        // 场景未命中场景表：如实记"无锚"，分镜页面板明示"本图仅凭文字描述生成"
        anchorSnapshot = { version: 1, generated_at: new Date().toISOString(), scene: null }
      }
    } catch (e) {
      console.warn('[/generate/shot-grid] 空间锚注入失败（降级为原 refs）:', e.message)
      anchorSnapshot = { version: 1, generated_at: new Date().toISOString(), degraded: true, reason: String(e.message || '') }
      anchorInjection = null
    }
    const anchorNotes = buildAnchorPromptNotes(anchorInjection)

    const promptResult = buildShotGridPrompt(shot, stylePrompt, boundChars, sceneRow)
    let prompt = promptResult.prompt + anchorNotes
    if (promptResult.warnings?.length) console.warn('[/generate/shot-grid] 降级警告:', promptResult.warnings)
    console.log('[/generate/shot-grid] start', { shotId, refs: refs.length, scene: sceneRow?.title || null, anchor: anchorInjection?.sceneTitle || null, promptLength: prompt.length })

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
      let sceneRowsMatched = sceneRows.filter((s) => parseNames(shot.scene_assets).includes(s.title) && s.image_url)
      // 命中锚时：该场景参考行换成已确认基准图（参考行缺失则补一行），
      // 布局图作为额外场景参考行并入（预算内，超预算让位）。
      const anchorTitle = anchorInjection?.sceneTitle || ''
      if (anchorInjection?.baselineUrl) {
        const hitIdx = sceneRowsMatched.findIndex((s) => s.title === anchorTitle)
        if (hitIdx >= 0) sceneRowsMatched[hitIdx] = { ...sceneRowsMatched[hitIdx], image_url: anchorInjection.baselineUrl }
        else sceneRowsMatched.push({ title: anchorTitle, image_url: anchorInjection.baselineUrl })
        if (anchorInjection.layoutUrl && MAX_SHOT_ANCHOR_REFS >= 2) {
          sceneRowsMatched.push({ title: `${anchorTitle}布局示意`, image_url: anchorInjection.layoutUrl })
        }
      }
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
      // 基准图/布局图的角色说明拼进 content（锚提示/要素/环境注记已在 prompt 侧拼过，这里补参考图语义）
      const anchorRefNote = anchorInjection?.baselineUrl
        ? `\n（注意：@${anchorTitle || '本场景'}的场景参考图为已确认基准图，必须严格保持同一空间结构、地标物体、色调与光影氛围。${
            anchorInjection.layoutUrl && MAX_SHOT_ANCHOR_REFS >= 2
              ? `@${anchorTitle || '本场景'}布局示意 为俯视布局示意图，仅用于锁定空间位置关系与物体相对方位，不代表实际视角与光影。`
              : ''
          }）`
        : ''
      const content = buildShotGridContentApp({ shot, charRows: rhChars, sceneRow, propRows, refs, stylePrompt }) + anchorRefNote + anchorNotes
      result = await generateShotGridApp({
        prompt: content,
        refs,
        usageContext: { episodeId, task: 'shot-grid', frames: 1 },
        aspectRatio: String(req.body.aspectRatio || '').split(' ')[0] || undefined,
      })
      console.log('[/generate/shot-grid] runninghub result:', result)
    } else {
      // 本地分支：命中锚时场景参考图替换为已确认基准图（服务端优先），布局图按预算追加
      let localRefs = refs
      if (anchorInjection?.baselineUrl) {
        localRefs = [...refs]
        const sceneIdx = sceneRow?.image_url ? localRefs.indexOf(sceneRow.image_url) : -1
        if (sceneIdx >= 0) localRefs[sceneIdx] = anchorInjection.baselineUrl
        else localRefs.push(anchorInjection.baselineUrl)
        prompt += `\n（注意：@${anchorInjection.sceneTitle || '本场景'}的场景参考图为已确认基准图，必须严格保持同一空间结构、地标物体、色调与光影氛围。）`
        if (anchorInjection.layoutUrl && MAX_SHOT_ANCHOR_REFS >= 2) {
          localRefs.push(anchorInjection.layoutUrl)
          prompt += `\n（注意：@${anchorInjection.sceneTitle || '本场景'}的布局示意图（俯视）仅用于锁定空间位置关系与物体相对方位，不代表实际视角与光影。）`
        }
      }
      const resolution = resolutionForModel(model)
      result = await generateStoryboardImage(prompt, localRefs, {
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
      // 出图依据快照落库（有锚/无锚/降级如实记录），供分镜页锚徽标与依据面板展示
      if (anchorSnapshot) {
        execute('UPDATE shots SET anchor_refs_snapshot = ? WHERE id = ?', [JSON.stringify(anchorSnapshot), shot.id])
        result.anchor = {
          anchored: Boolean(anchorSnapshot.scene?.baseline_url),
          degraded: Boolean(anchorSnapshot.degraded),
          baselineUrl: anchorSnapshot.scene?.baseline_url || '',
          layoutUrl: anchorSnapshot.scene?.layout_url || '',
        }
      }
      // 四宫格验收（grid 模式：逐格评残 + 格间一致性）：一次验收不重抽，不合格落告警由人工处置
      if (config.storyboard?.frameReview !== false) {
        try {
          const review = await reviewFrameImage(storedUrl, { episodeId, shotId: shot.id, grid: true })
          result.review = { verdict: review.verdict, defects: review.defects || [], summary: review.summary || '' }
          if (review.verdict === 'fail') {
            recordAlert({
              source: 'frameReview',
              level: 'warn',
              episodeId,
              shotId: shot.id,
              shotNumber: shot.shot_number || '',
              message: `镜 ${shot.shot_number || shot.id} 四宫格验收不合格（${(review.defects || []).map((d) => d.type).join(',') || review.summary}）——未自动重抽，建议人工复核或重出`,
              detail: JSON.stringify({ defects: review.defects || [], summary: review.summary || '' }),
            })
          } else if (review.verdict !== 'fail') {
            resolveAlertsByShot(Number(shot.id), 'frame-regen', 'frameReview')
          }
        } catch (e) {
          console.warn('[/generate/shot-grid] 四宫格验收失败（不阻塞出图）:', e.message)
        }
      }
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
    const stylePrompt = loadStylePrompt(episodeId)
    const { boundChars, sceneRow, refs } = loadGridAssets(episodeId, shots)

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

  const assetCols = type === 'scene' ? 'id, episode_id, scene_number, summary' : 'id, episode_id'
  const asset = queryOne(`SELECT ${assetCols} FROM ${validTypes[type].table} WHERE id = ?`, [id])
  if (!asset) return res.status(404).json({ error: '资产不存在' })
  try {
    assertScriptConfirmed(asset.episode_id)
    assertNotStale(asset.episode_id, 'assets')
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message })
  }

  // 场景图出图前置校验：所在组还没定基准图（pending）时拒绝出图。
  // 「代表场景先出图 → 人审定基准 → 其他成员照基准画」是功能成立的先后，
  // 前端成员卡已锁，这里兜底防绕过。单场景组与已跳过的组不受影响。
  // 豁免：代表场景（组内场景号最小）自己必须能出图，否则基准图死锁。
  if (type === 'scene') {
    try {
      const sa = queryOne('SELECT spatial_group FROM scene_analysis WHERE episode_id = ? AND scene_id = ?', [asset.episode_id, id])
      if (sa?.spatial_group) {
        const review = queryOne('SELECT status FROM spatial_group_review WHERE episode_id = ? AND spatial_group = ?', [asset.episode_id, sa.spatial_group])
        if (review?.status === 'pending') {
          const rep = queryOne(
            `SELECT sa.scene_id FROM scene_analysis sa
             JOIN scenes s ON s.id = sa.scene_id
             WHERE sa.episode_id = ? AND sa.spatial_group = ?
             ORDER BY s.scene_number ASC, s.id ASC
             LIMIT 1`,
            [asset.episode_id, sa.spatial_group]
          )
          if (!rep || Number(rep.scene_id) !== Number(id)) {
            return res.status(409).json({ error: `该场景所在组（${sa.spatial_group}）还没定参考图，请先在场景页生成并确认基准图` })
          }
        }
      }
    } catch (err) {
      console.warn('[/generate/asset-image] 组状态校验失败（放行）:', err.message)
    }
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
    // 本次出图实际注入的锚指纹（成功后写进 scenes.gen_context，供过时判定比对）
    let sceneGenBaselineFp = ''
    let sceneGenLayoutFp = ''
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
        for (const a of anchorResult.anchors || []) {
          if (a?.type === LAYOUT_ANCHOR_TYPE && a.image) sceneGenLayoutFp = String(a.image)
          if (a?.type === SPATIAL_ANCHOR_TYPE && a.image) sceneGenBaselineFp = String(a.image)
        }
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
      const newBareUrl = storedUrl.split('?')[0]

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
      if (histAssetId && oldImg && oldImg !== newBareUrl) {
        const hasInitial = queryOne('SELECT id FROM asset_image_history WHERE asset_type = ? AND asset_id = ? AND image_url = ?', [type, histAssetId, oldImg])
        if (!hasInitial) {
          execute('INSERT INTO asset_image_history (asset_type, asset_id, image_url, description, source, instruction) VALUES (?, ?, ?, ?, ?, ?)',
            [type, histAssetId, oldImg, oldDesc, 'initial', '历史版本'])
        }
      }

      if (type === 'scene') {
        // 记录本次出图的注入上下文：之后基准/布局换了版本、或场景描述改了，
        // 比对 gen_context 即可判定这张图「过时」该不该重出
        const genCtx = JSON.stringify({
          b: sceneGenBaselineFp,
          l: sceneGenLayoutFp,
          d: assetDescHash(asset.summary),
        })
        execute('UPDATE scenes SET image_url = ?, gen_context = ? WHERE id = ?', [cacheBust, genCtx, id])
      } else {
        execute(`UPDATE ${validTypes[type].table} SET image_url = ? WHERE id = ?`, [cacheBust, id])
      }
      if (type === 'character' && histAssetId) {
        const newDesc = refList.length && editInstruction
          ? (() => { const cur = queryOne('SELECT description FROM project_characters WHERE id = ?', [histAssetId])?.description || ''; const base = cur.replace(/[。；;\s]*$/, ''); return (base ? base + '，' : '') + editInstruction + '。' })()
          : oldDesc
        execute('UPDATE project_characters SET image_url = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [cacheBust, newDesc, histAssetId])
        syncProjectCharacterToEpisodes(histAssetId)
        execute('INSERT INTO asset_image_history (asset_type, asset_id, image_url, description, source, instruction) VALUES (?, ?, ?, ?, ?, ?)',
          [type, histAssetId, newBareUrl, newDesc, refList.length ? 'edit' : 'generate', editInstruction || ''])
      } else if (histAssetId) {
        execute('INSERT INTO asset_image_history (asset_type, asset_id, image_url, description, source, instruction) VALUES (?, ?, ?, ?, ?, ?)',
          [type, histAssetId, newBareUrl, oldDesc, refList.length ? 'edit' : 'generate', editInstruction || ''])
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

    }
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  } finally {
    releaseSpatialGroupLock(spatialLock)
    imageJobsInflight.delete(jobKey)
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
        status: r.reviewStatus || '',
      }
    }
    res.json({ success: true, episodeId, groups })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// 智能批量出图的计划接口：一次查全每组的管线状态（组 status / 布局三态 / 集级
// route / 基准指纹）+ 每张图的判定（missing / stale / staleReasons）。
// 前端「补出全部」「整组出图」据此分波执行（W1 布局 → W2 代表+自动确认 → W3 组员），
// 波次编排在前端，这里只负责给判定，不发起任何生成。
router.get('/scene-out-plan', async (req, res) => {
  const episodeId = Number(req.query.episodeId)
  if (!episodeId) return res.status(400).json({ error: 'episodeId 必填' })
  try {
    const ep = queryOne('SELECT id FROM episodes WHERE id = ?', [episodeId])
    if (!ep) return res.status(404).json({ error: 'episode 不存在' })
    try { await ensureSceneAnalysis(episodeId) } catch (e) {
      console.warn('[/scene-out-plan] 场景分析失败（降级为无组）:', e.message)
    }
    // 未归组场景兜底成一场一组：与 /spatial-group-review/status 的行为保持一致，
    // 否则场景页显示组卡、plan 却把它归进 ungrouped，两边对不上
    try { normalizeSceneGrouping(episodeId) } catch (e) {
      console.warn('[/scene-out-plan] 兜底归组失败（降级为原样）:', e.message)
    }
    const route = getLayoutRoute(episodeId)

    const groupRows = query(
      `SELECT spatial_group, COUNT(*) AS member_count
       FROM scene_analysis
       WHERE episode_id = ? AND TRIM(COALESCE(spatial_group, '')) != ''
       GROUP BY spatial_group
       ORDER BY MIN(scene_number) ASC`,
      [episodeId]
    )
    const reviewMap = new Map(
      query('SELECT * FROM spatial_group_review WHERE episode_id = ?', [episodeId])
        .map((r) => [r.spatial_group, r])
    )

    const groups = []
    let missingCount = 0
    let staleCount = 0
    for (const g of groupRows) {
      const groupName = g.spatial_group
      const memberCount = Number(g.member_count || 0)
      const review = reviewMap.get(groupName)
      // 无 review 行时按 syncSpatialGroupReview 会写入的值推导：solo → skipped，多成员 → pending
      const status = review?.status || (memberCount <= 1 ? 'skipped' : 'pending')
      const rep = queryOne(
        `SELECT s.id AS scene_id, s.scene_number, s.title
         FROM scene_analysis sa JOIN scenes s ON s.id = sa.scene_id
         WHERE sa.episode_id = ? AND sa.spatial_group = ?
         ORDER BY s.scene_number ASC, s.id ASC LIMIT 1`,
        [episodeId, groupName]
      )
      // 当前应注入的基准 / 布局指纹：与 buildAnchorRefsForScene 的筛法逐字对齐
      // （基准 source='manual' AND confirmed=1；布局 confirmed=1 才算注入）
      const ga = queryOne(
        `SELECT image_url, scene_id FROM scene_anchors
         WHERE episode_id = ? AND anchor_type = '${SPATIAL_ANCHOR_TYPE}' AND anchor_key = ?
           AND source = 'manual' AND confirmed = 1`,
        [episodeId, groupName]
      )
      const baselineFp = bareUrl(ga?.image_url)
      const baselineSourceSceneId = Number(ga?.scene_id || 0)
      const la = getLayoutAnchor(episodeId, groupName)
      const layoutFp = la?.imageUrl || ''
      const layoutState = !la ? 'none' : (la.confirmed ? 'on' : 'off')
      const curLayoutFp = layoutState === 'on' ? layoutFp : ''

      // 布局图自身的过时（成员素材指纹变了）：与 /spatial-group-review/status 同算法
      let layoutStale = false
      if (la && la.sourceFingerprint) {
        try {
          const curFp = layoutMaterialsFingerprint(collectGroupLayoutMaterials(episodeId, groupName))
          layoutStale = !!curFp && curFp !== la.sourceFingerprint
        } catch (e) {
          console.warn('[/scene-out-plan] 布局时效比对失败（降级为不过时）:', e.message)
        }
      }

      const members = query(
        `SELECT s.id, s.scene_number, s.title, s.image_url, s.summary, s.gen_context, sa.spatial_role
         FROM scene_analysis sa JOIN scenes s ON s.id = sa.scene_id
         WHERE sa.episode_id = ? AND sa.spatial_group = ?
         ORDER BY s.scene_number ASC, s.id ASC`,
        [episodeId, groupName]
      ).map((m) => judgeSceneOutdated(m, { curBaselineFp: baselineFp, baselineSourceSceneId, curLayoutFp }))
      for (const m of members) {
        if (m.missing) missingCount++
        else if (m.stale) staleCount++
      }

      groups.push({
        group: groupName,
        status,
        memberCount,
        repSceneId: Number(rep?.scene_id || 0),
        repSceneNumber: Number(rep?.scene_number || 0),
        repSceneTitle: String(rep?.title || ''),
        baselineFp,
        layoutState,
        layoutFp,
        layoutStale,
        members,
      })
    }

    const ungrouped = query(
      `SELECT s.id, s.scene_number, s.title, s.image_url, s.summary, s.gen_context
       FROM scene_analysis sa JOIN scenes s ON s.id = sa.scene_id
       WHERE sa.episode_id = ? AND TRIM(COALESCE(sa.spatial_group, '')) = ''
       ORDER BY s.scene_number ASC, s.id ASC`,
      [episodeId]
    ).map((m) => judgeSceneOutdated(m, {}))
    for (const m of ungrouped) {
      if (m.missing) missingCount++
      else if (m.stale) staleCount++
    }

    // W1（要画的布局）只统计 route=on、成员>1、未停用、且「从未画过或素材过时」的组；
    // 停用（layoutState='off'）是用户拍板，即便过时也不自动重画
    const layoutsNeeded = route === 'off' ? 0 : groups.filter((g) =>
      g.memberCount > 1 && g.layoutState !== 'off' && (g.layoutState === 'none' || g.layoutStale)
    ).length

    res.json({
      success: true,
      episodeId,
      route,
      groups,
      ungrouped,
      summary: {
        totalScenes: groups.reduce((n, g) => n + g.members.length, 0) + ungrouped.length,
        missingCount,
        staleCount,
        groupsPending: groups.filter((g) => g.status === 'pending' && g.memberCount > 1).length,
        layoutsNeeded,
      },
    })
  } catch (e) {
    console.error('[/scene-out-plan] GET 失败:', e.message)
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

router.post('/layout-anchor/toggle', async (req, res) => {
  const { episodeId, group, enabled } = req.body || {}
  const ep = Number(episodeId)
  const g = String(group || '').trim()
  if (!ep || !g) return res.status(400).json({ error: 'episodeId/group 必填' })
  try {
    const r = execute(
      `UPDATE scene_anchors SET confirmed = ? WHERE episode_id = ? AND anchor_type = '${LAYOUT_ANCHOR_TYPE}' AND anchor_key = ?`,
      [enabled ? 1 : 0, ep, g]
    )
    if (!Number(r?.changes)) return res.status(404).json({ error: '该组还没有布局图' })
    console.log(`[/layout-anchor/toggle] group=${g} confirmed=${enabled ? 1 : 0}（episode=${ep}）`)
    res.json({ success: true, group: g, confirmed: enabled ? 1 : 0 })
  } catch (e) {
    console.error('[/layout-anchor/toggle] 失败:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// 集级布局路线状态：门禁、串联链、界面收起都以它为准（全开/全关的真正持久层）
router.get('/layout-route', (req, res) => {
  const ep = Number(req.query.episodeId)
  if (!ep) return res.status(400).json({ error: 'episodeId 必填' })
  res.json({ route: getLayoutRoute(ep) })
})

router.post('/layout-anchor/toggle-all', async (req, res) => {
  const { episodeId, enabled } = req.body || {}
  const ep = Number(episodeId)
  if (!ep) return res.status(400).json({ error: 'episodeId 必填' })
  try {
    // 全开/全关是集级管线路由：先固化路线状态，再批量对齐各组 confirmed
    const route = enabled ? 'on' : 'off'
    setLayoutRoute(ep, route)
    const r = execute(
      `UPDATE scene_anchors SET confirmed = ? WHERE episode_id = ? AND anchor_type = '${LAYOUT_ANCHOR_TYPE}'`,
      [enabled ? 1 : 0, ep]
    )
    console.log(`[/layout-anchor/toggle-all] episode=${ep} route=${route} confirmed=${enabled ? 1 : 0} changes=${r?.changes || 0}`)
    res.json({ success: true, enabled: enabled ? 1 : 0, route, changes: r?.changes || 0 })
  } catch (e) {
    console.error('[/layout-anchor/toggle-all] 失败:', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.delete('/layout-anchor', async (req, res) => {
  const ep = Number(req.query.episodeId || req.body?.episodeId)
  const g = String(req.query.group || req.body?.group || '').trim()
  if (!ep || !g) return res.status(400).json({ error: 'episodeId/group 必填' })
  try {
    const r = execute(
      `DELETE FROM scene_anchors WHERE episode_id = ? AND anchor_type = '${LAYOUT_ANCHOR_TYPE}' AND anchor_key = ?`,
      [ep, g]
    )
    if (!Number(r?.changes)) return res.status(404).json({ error: '该组还没有布局图' })
    console.log(`[/layout-anchor] 删除 group=${g} 的布局图锚（episode=${ep}，历史版本保留）`)
    res.json({ success: true, group: g })
  } catch (e) {
    console.error('[/layout-anchor] 删除失败:', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.post('/layout-anchor/upload', async (req, res) => {
  const { episodeId, group, imageBase64, filename } = req.body || {}
  const ep = Number(episodeId)
  const g = String(group || '').trim()
  if (!ep || !g) return res.status(400).json({ error: 'episodeId/group 必填' })
  const dataUrl = String(imageBase64 || '')
  const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/)
  if (!match) return res.status(400).json({ error: 'imageBase64 必须是 data URL 格式（data:image/xxx;base64,...）' })
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1]
  const buf = Buffer.from(match[2], 'base64')
  const safeGroup = g.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40)
  const name = `layout_${ep}_${safeGroup}_${Date.now()}.${ext}`
  try {
    fs.writeFileSync(path.join(uploadsDir, name), buf)
    const imageUrl = `/uploads/${name}`
    registerLayoutAnchor(ep, g, imageUrl, {
      description: `空间组「${g}」布局示意图（用户上传）`,
      sourceFingerprint: '',
    })
    console.log(`[/layout-anchor/upload] group=${g} 用户上传布局图 → ${imageUrl}`)
    res.json({ success: true, group: g, imageUrl })
  } catch (e) {
    console.error('[/layout-anchor/upload] 失败:', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.get('/layout-anchor/history', (req, res) => {
  const ep = Number(req.query.episodeId)
  const g = String(req.query.group || '').trim()
  if (!ep || !g) return res.status(400).json({ error: 'episodeId/group 必填' })
  try {
    const history = getLayoutAnchorHistory(ep, g)
    res.json({ success: true, group: g, history })
  } catch (e) {
    console.error('[/layout-anchor/history] 失败:', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.post('/layout-anchor/restore', async (req, res) => {
  const { episodeId, group, historyId } = req.body || {}
  const ep = Number(episodeId)
  const g = String(group || '').trim()
  const hid = Number(historyId)
  if (!ep || !g || !Number.isFinite(hid)) return res.status(400).json({ error: 'episodeId/group/historyId 必填' })
  try {
    const r = restoreLayoutAnchor(ep, g, hid)
    if (!r.restored) return res.status(404).json({ error: '历史版本不存在' })
    console.log(`[/layout-anchor/restore] group=${g} 换回历史版（episode=${ep}）`)
    res.json({ success: true, ...r })
  } catch (e) {
    console.error('[/layout-anchor/restore] 失败:', e.message)
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
  const { episodeId, note, sceneIds } = req.body || {}
  const ep = Number(episodeId)
  if (!ep) return res.status(400).json({ error: 'episodeId 必填' })
  try {
    const r = lockCurrentGrouping(ep, { note, sceneIds })
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
      // 换回历史版本是用户主动拍板：置空 gen_context，不参与过时判定
      const ctxCol = type === 'scene' ? ', gen_context = \'\'' : ''
      execute(`UPDATE ${assetTables[type]} SET image_url = ?, ${descCol} = ?${ctxCol} WHERE id = ?`, [cacheBust, hist.description, id])
    }
    console.log('[/asset-image/restore] restored', { type, histAssetId, historyId })
    res.json({ success: true, url: cacheBust, description: hist.description })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
