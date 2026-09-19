import { Router } from 'express'
import { randomUUID } from 'crypto'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { query, queryOne, execute, transaction } from '../db.js'
import { scriptHash } from '../scriptHash.js'

const execFile = promisify(execFileCb)
import { generateScript, classifyScriptIntent, reviseScriptEdits, applyScriptEdits, rewriteFullScript, rewriteScriptSegment, extractAssets, generateStoryboard, generateStoryboardFromFile, extractBlockingForScene, assembleBlockingPlan, enrichShotIntegrated, chatCompletion } from '../ai/doubao.js'
import { ensureStandardScript } from '../ai/scriptFormat.js'
import { buildSceneGridPrompt, buildShotGridPrompt, buildShotGridContentApp, allocateShotRefs, splitSceneGrid } from '../ai/directorRequest.js'
import { runWorkflow, uploadImageV2, insecureDownload } from '../ai/runninghub.js'
import { generateShotVideoCombat } from '../ai/combatVideo.js'
import { generateShotVideoV4, buildShotVideoPromptV4 } from '../ai/v4Video.js'
import { assertScriptConfirmed, assertNotStale, assertNoStylePoison } from '../ai/guards.js'
import { relayLastFrameToNextShot } from '../ai/postHooks.js'
import { generateShotGridApp } from '../ai/rhShotGrid.js'
// （死 import 已删：buildShotVideoPrompt / cameraPhrase 全项目零调用点。见 ai/videoPrompt.js 头部标识）
import { checkSeam, checkOpenerTone } from '../ai/seamCheck.js'
import { reviewShot, reviewShotByShotId } from '../ai/shotReview.js'
// 分镜图出图即验收（2026-09-15）：硬伤（畸形/崩脸/复制角色/文字水印/画风漂移/分栏拼贴）自动重抽
import { reviewFrameImage } from '../ai/frameReview.js'
// A4/A5 场景图内容质检（2026-09-17）：核对要素/环境/机位/结构有没有真画出来
import { reviewSceneImage, buildSceneRetryNote } from '../ai/sceneReview.js'
// 系统告警（2026-09-13）：出片后置钩子链失败可见化——落 system_alerts，前端亮角标、响应带 warnings
// 只导入本文件真正调用的（recordAlert 落告警；两个 resolve* 用于重新生成时清旧告警）
import { recordAlert, resolveAlertsByShot, resolveAlertsByScene } from '../ai/alerts.js'
// 道具名跨层归一（2026-09-18，P1-Q1）：shots.prop_assets 的名字与 props 表名可能不一致
// （两趟 LLM 各说各话），原 SQL `name IN (...)` 精确匹配对不上就静默无道具参考图 →
// 改用内存归一（见 /shot-grid 参考图装配处），未命中记 warn。判据单点 ai/propNameMatch.js。
import { resolvePropName } from '../ai/propNameMatch.js'
import { buildAnchorRefsForScene, registerSceneAnchors, initAnchorSetFromExisting, resolveSceneSpatialGroup, listSceneSpatialGroups, collectGroupLayoutMaterials, layoutMaterialsFingerprint, registerLayoutAnchor, getLayoutAnchor, ensureSceneAnalysis, lockCurrentGrouping, unlockGrouping, describeGroupLocks } from '../ai/sceneAnchors.js'
// 空间组人审基准图 · P0-6 提示词修复（方案 C：字面替换 prompt 冲突句），纯函数，无副作用
// A3：buildLayoutImagePrompt —— 布局图 prompt 构建（纯函数，素材来自 LLM 分析）
import { swapSceneLightingNote, ANCHOR_PRIORITY_NOTE, buildLayoutImagePrompt } from '../ai/sceneAnchorPrompt.js'
// 锚点类型/审核状态单点常量（勿在调用方写死 'scene' / 'spatial' 字面量）
import { isSpatialSeriesAnchor } from '../ai/anchorTypes.js'
// A1/A2 要素硬约束 + 组级环境卡（2026-09-17）：口径单点，与 src/services/promptBuilder.js 逐字一致
import { buildElementNote, buildSharedEnvNote, ELEMENT_NOTE_TAG, SHARED_ENV_NOTE_TAG } from '../ai/anchorTypes.js'
// A3 布局图生成后闸（2026-09-17）：示意图先验天然带标注文字，靠 prompt 对抗不可复现，
// 改为「视觉模型检出 → 针对性加固 → 重试」。纯函数部分（解析/加固文案）可测；故障一律放行。
import { reviewLayoutImage, buildLayoutRetryNote, MAX_LAYOUT_ATTEMPTS } from '../ai/layoutReview.js'
// 空间组串行锁（2026-09-18）：同组场景图必须串行出图，否则空间锚永远为空。见 acquireSpatialGroupLock 头部注释
import { acquireSpatialGroupLock, releaseSpatialGroupLock } from '../ai/spatialGroupLock.js'
import { buildGlobalSpeakerMap } from '../ai/h3PromptTranslator.js'
import { validateCameraAngle, inferAngleFromText, angleInjection } from '../ai/cameraAngle.js'
import { generateImage, generateStoryboardImage, resolveProvider } from '../ai/image.js'
import { backfillStoryboardAssets } from '../ai/assetBackfill.js'
import { classifyShotCombat } from '../ai/shotClassifier.js'
import { config } from '../config.js'
// cleanText 统一到 ai/shared.js（原此处与 ai/videoPrompt.js 各有一份实现）
import { clean as cleanText } from '../ai/shared.js'
import { replaceEpisodeCharacters, mergeMasterIntoEpisodeCharacters, syncProjectCharacterToEpisodes } from '../characterLibrary.js'
import { routeIp, buildCharacterContext, resolveExplicitCharacters } from '../ai/ipRouter.js'
// 成片拼接（保存至成片）：ffmpeg-static 已用于分镜图切分（directorRequest.js），这里复用同一份二进制
import ffmpegStaticPath from 'ffmpeg-static'

const router = Router()

// 分镜图自动出图规则（无需配置，按镜头自带时长自动判定）：
// - 长镜（时长 ≥ 7s）：动作有过程，出 2 张「首帧 + 尾帧」，分别锁定动作起始与结束状态，
//   作为视频工作流的起止锚点（主图=首帧 frame_url，候选=尾帧 frame_url2）
// - 短镜（时长 < 7s）：动作单一，只出 1 张代表画面（frame_url），不再出同拍双候选
const FRAME_DUAL_KEYFRAME_SEC = 7

// ===== 资产定位 → 编剧上下文 =====
// 前端确认过角色时传 characterIds（显式指定，直接用）；
// 没传则自动路由，仅高置信（主题里点了角色名）才注入，绝不瞎绑。
// 定位失败不挡生成流程 —— 最坏情况回到裸主题生成，与改造前行为一致。
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

// server/uploads：资产图落本地（RunningHub 输出 URL 仅 24h 有效，落盘后永久可用）
const uploadsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'uploads')
fs.mkdirSync(uploadsDir, { recursive: true })

// 一键生成（/full）进行中的集（episodeId 字符串集合）：
// 同一集同时只允许一个 /full 任务，防止两个任务交错删插分镜/资产互相覆盖
const runningFullTasks = new Set()

// 下载 RunningHub 生成产物到本地，返回可直接存库的 /uploads/ 路径；失败时返回原 URL（退化为 24h 有效）
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

// 更新任务状态
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

// 资产去重：同名/近似同名（去除标点空格后一致）只保留第一条，兼容字符串与对象格式
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

// 大型固定家具属于场景陈设而非独立道具：若提取为道具，
// 场景生图会把家具排除出画面、镜头又会画出来，两边互相打架
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

// 家具类道具从 props 中剔除，并同步清掉场景关联里的对应名称
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

// ===== 画风锚图（2026-09-16）=====
// 场景/道具图的画风一致性锚，机制对标 MJ --sref / LTX Style Element：
// 锚图只提供「笔触 / 上色 / 线条 / 材质」，不提供内容、构图与光照——靠 prompt 职责声明约束。
// 优先级：episodes.style_anchor_url（出片成功后自动落的锚帧）
//        > 所选画风预设的封面样张 style_presets.cover_path（内置画风样张，169 张）
// 两者皆无 → 返回 ''，调用方降级为纯文生图（不阻塞生成）。
export function resolveStyleAnchorUrl(episodeId) {
  if (!episodeId) return ''
  const ep = queryOne('SELECT style_anchor_url FROM episodes WHERE id = ?', [episodeId])
  const epAnchor = String(ep?.style_anchor_url || '').split('?')[0].trim()
  if (epAnchor) return epAnchor
  // 画风预设封面：projects.art_style 存的是画风 label，与 style_presets.label 同源
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

// 参考图职责声明：告知模型锚图只锁「手法」不锁「内容」（MJ style reference 语义的 prompt 实现）
// 2026-09-16 加固：实测发现锚图会带来「季节感污染」——夏日村庄样张当锚时，冰河场景被画成明亮夏日清流。
// 锚图不只传递笔触，还会传递季节/天气/植被/色温倾向，必须显式禁止，并用正向约束保住文字里的气候特征。
const STYLE_ANCHOR_NOTE =
  '（注意：参考图中最后一张为【画风锚图】，仅用于锁定笔触、上色、线条与材质质感；' +
  '禁止继承其中的内容、构图、人物、光照，更不得继承其季节、天气、植被与整体色温倾向；' +
  '必须严格保留本段文字描述中的季节、气候与环境特征（如冰雪、寒冷、雾气等）。' +
  '画面内容、空间与光照一律以本段文字描述为准。）'

// 双锚职责声明（前方还有空间/形象参考图时）：
// 旧图自带「漂移画风」，不显式切割职责时模型会优先跟随旧图画风、把锚图压掉。
// frontCount = 锚图之前的参考图数量（空间/形象锚），锚图固定排在最后一位。
export function buildAnchorNote(frontCount) {
  if (frontCount <= 0) return STYLE_ANCHOR_NOTE
  const frontLabel = frontCount > 1 ? `参考图1-${frontCount}` : '参考图1'
  return `（注意：${frontLabel}只用于锁定空间布局、陈设与形象特征，其画风、笔触、上色、光影、季节与色调倾向一律不作为依据；` +
    `参考图${frontCount + 1}为【画风锚图】，是唯一的画风基准——但只取笔触、上色、线条与材质质感这四项技法，` +
    `严禁继承其内容、构图、季节、天气、植被与整体色温倾向；` +
    `必须严格保留本段文字描述中的季节、气候与环境特征（如冰雪、寒冷、雾气等）。` +
    `画面内容、空间与光照以本段文字描述为准。）`
}

// 参考图本地文件存在性校验：/uploads/ 下文件被清理时静默剔除，让流程降级而不是 ENOENT 硬失败
export function isLiveRefUrl(u) {
  const s = String(u).split(/[?#]/)[0]
  if (!/^\/uploads\//i.test(s)) return true // 远程 URL 无法本地校验，保留
  try {
    // 保留 /uploads/ 下的子目录（library / continuity / style_anchor 等）：
    // basename 会把子目录文件误判成「已丢失」，导致参考图被静默丢弃
    const rel = decodeURIComponent(s).replace(/^\/uploads\//i, '')
    const abs = path.resolve(uploadsDir, rel)
    if (!abs.startsWith(path.resolve(uploadsDir) + path.sep)) return false
    return fs.existsSync(abs)
  } catch { return false }
}

// 进行中图片任务登记（进程内存态，后端重启即清空——重启后任务本就真没了）。
// 两种 key 形状共存于同一 Map：
//   · 分镜图：`${imageType}:${shotId}` → { shotId, imageType, startedAt }（/image 登记）
//   · 资产图：`asset:${type}:${id}`   → { assetType, assetId, startedAt }（/asset-image 登记）
// 前端刷新后据 /image/inflight 的返回判定「后端是否真在跑」，避免僵尸 loading。
// export 仅用于验收脚本 `_audit_asset_inflight.mjs` 直接驱动（不影响路由行为）。
export const imageJobsInflight = new Map()

// 资产参考图 URL → 名称映射：给 LLM 节点显式告知参考图里每个资产是谁，
// 否则模型随机识别会把多个角色画成同一只（实测：1-3 一二被画成布布的棕色）。
// 同时查角色/场景/道具三类，覆盖 zikl 路线下场景图与道具图的标注需求。
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
  // 取 episode 下所有角色，按名字查 image_url
  const episodeId = queryOne(
    `SELECT ss.episode_id FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id WHERE s.id = ?`,
    [shotId]
  )?.episode_id
  if (!episodeId) return {}
  // 合并三类资产的 name↔image_url 映射，角色 + 场景 + 道具全覆盖
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
  // 按 charImages 顺序产出 URL → 名称映射（前端按 mentionedNames 顺序产出，顺序与之一致）
  const labelByUrl = {}
  for (const url of charImages) {
    const name = nameByUrl.get(url)
    if (name) labelByUrl[url] = name
  }
  return labelByUrl
}
const IMAGE_JOB_STALE_MS = 30 * 60 * 1000 // 兜底：超 30 分钟的任务视为已死，不再下发
router.get('/image/inflight', (req, res) => {
  const now = Date.now()
  const jobs = []
  const assets = []
  for (const [key, job] of imageJobsInflight) {
    if (now - job.startedAt > IMAGE_JOB_STALE_MS) {
      imageJobsInflight.delete(key)
      continue
    }
    // 按是否带 assetType 区分任务类型：
    //  · 分镜图任务 → jobs（元素结构 {shotId, imageType, startedAt} **保持不变**，既有前端解析不受影响）
    //  · 资产图任务 → 独立 assets 数组（新字段，向后兼容），前端用它确认资产 pending 是否真在跑
    if (job.assetType) {
      assets.push({ assetType: job.assetType, assetId: job.assetId, startedAt: job.startedAt })
    } else {
      jobs.push({ shotId: job.shotId, imageType: job.imageType, startedAt: job.startedAt })
    }
  }
  res.json({ jobs, assets })
})

// ===== 四宫格分镜图任务登记：分镜页镜头卡片显示 生成中/失败 状态（刷新页面可恢复） =====
// 进程内存态即可：running 任务后端重启即真没了，前端轮询拿空列表自动清遮罩；
// failed 状态保留 10 分钟供前端展示（避免一闪而过看不见），超时自动清除
const shotGridJobs = new Map() // key: shotId(Number) → { state: 'running'|'failed', shotId, startedAt, finishedAt, error }
const SHOT_GRID_FAILED_TTL_MS = 10 * 60 * 1000
const SHOT_GRID_STALE_MS = 30 * 60 * 1000 // running 超 30 分钟视为已死（正常 1-3 分钟）
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

// 单独生成单张图片（故事板/分镜图/站位图）
// 分镜图合法类型（唯一白名单，路由校验与前端按钮共用同一口径）：
// - frame     分镜图（首帧/代表画面 → frame_url / frame_url2）
// - blocking  站位图（→ blocking_url）
// - keyframe  尾帧锚（由本镜 final_frame 生成 → continuity_url 的对偶：keyframe_url）
//   「final_frame 一键生图」用：把本镜最终画面描述直接落成一张图，作为下一镜出片的
//   参考首帧（帧对帧连贯）。与 frame 的区别：frame 画的是**本镜开头**，keyframe 画的是
//   **本镜结束**——两者成对，才能让相邻镜的接缝在画面上真正接得上。
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

  // 通过 shotId 反查 episodeId，校验剧本是否已确认（duration 用于长镜首帧/尾帧判定）
  // final_frame 供 keyframe（尾帧锚）出图时作为画面内容准绳——这是「final_frame 一键生图」的语义根基：
  // 用户看到某个镜头的最终画面描述，点一下就能把它落成图，不必手写 prompt。
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

  // 登记进行中任务（前端刷新后恢复遮罩用）；校验通过后才登记，避免无效请求污染
  const jobKey = `${imageType}:${shotId}`
  imageJobsInflight.set(jobKey, { shotId, imageType, startedAt: Date.now() })

  try {
    let result
    if (imageType === 'frame' || imageType === 'keyframe') {
      // 分镜图（frame）/ 尾帧锚（keyframe）：参考图 = 角色设定图 + 场景图 + 道具设定图（关联美术资产全用上）
      // 两者共用同一条生图链（参考图装配 / 画风锚 / 比例约束 / VLM 验收），差异只在：
      //   · 出图张数：frame 长镜出首尾 2 张，keyframe 恒定 1 张（尾帧只要一张锚）
      //   · 落库字段：frame → frame_url/frame_url2，keyframe → keyframe_url
      const isKeyframe = imageType === 'keyframe'
      // 本镜最终画面描述（keyframe 出图的内容准绳）。空则不额外追加约束段，退化为纯 framePrompt。
      const finalFrameText = String(shot.final_frame || '').trim()
      const charImages = (Array.isArray(req.body.charImages) ? req.body.charImages : []).filter(Boolean)
      const sceneImage = req.body.sceneImage || ''
      const propImages = (Array.isArray(req.body.propImages) ? req.body.propImages : []).filter(Boolean)
      const refs = []
      let framePrompt = prompt

      // 分镜图（frame）只走 zikl（gpt-image-2 多图生图）：角色/场景/道具图逐张直传，
      // 不再拼合成集合图（拼合会让模型跟随参考图比例输出超宽长图，且模型不知道集合图里哪个是谁）。
      // 多角色名→参考图显式映射：必须在 prompt 文字里告诉模型每张图是哪个角色，
      // 否则模型随机认定会把多个角色画成同一只（实测 1-3 一二被画成布布色）
      const allImageUrls = [...charImages, ...(sceneImage ? [sceneImage] : []), ...propImages]
      const labelByUrl = buildCharLabelByUrl(shotId, allImageUrls)
      // 角色参考图：逐张直传 + 名字标注
      for (let i = 0; i < charImages.length; i++) {
        const u = charImages[i]
        refs.push(u)
        const name = labelByUrl[u]
        if (name) framePrompt += `\n（注意：参考图${i + 1}（按上传顺序）是@${name}；画面中这些角色必须全部出现并各自保持自己的外形、颜色、特征，禁止把不同角色画成同一种造型。）`
      }
      // 场景参考图：单张直传 + 名字标注
      if (sceneImage) {
        refs.push(sceneImage)
        const sceneName = labelByUrl[sceneImage]
        framePrompt += `\n（注意：参考图是@${sceneName || '未知场景'}场景图，仅用于锁定环境、空间、色调与光影氛围。）`
      }
      // 道具参考图：逐张直传 + 名字标注
      for (let i = 0; i < propImages.length; i++) {
        const p = propImages[i]
        refs.push(p)
        const name = labelByUrl[p]
        framePrompt += `\n（注意：道具参考图为@${name || '未知道具'}，仅用于锁定其外形、配色与材质，背景与文字标注一律不要出现在画面里。）`
      }
      // 防多视图误读 + 构图约束：角色设定图自带正面/侧面/背面多视图与细节标注格，
      // 1-1 实测"侧面视图"被当成第二个角色画进成图（沙发上一两只一二）
      // 构图比例随项目级设置（projects.aspect_ratio，剧集页顶部下拉）：横屏→横幅构图，
      // 竖屏→竖幅构图。zikl/visionary 图生图不传 size，比例靠这段文字锚定，改项目比例后
      // 新出的分镜图自动跟随（已出图不追溯）。
      const projectRow = queryOne(
        'SELECT p.aspect_ratio FROM projects p JOIN episodes e ON e.project_id = p.id WHERE e.id = ?',
        [shot.episode_id]
      )
      const arRaw = String(projectRow?.aspect_ratio || '9:16 (Portrait Widescreen)')
      const arShort = arRaw.split(' ')[0] // '16:9 (Widescreen)' → '16:9'
      const isPortrait = /^9:16$|^3:4$|^2:3$/.test(arShort)
      const isSquare = arShort === '1:1'
      const frameWording = isSquare
        ? `标准 ${arShort} 方形构图的单一完整场景`
        : isPortrait
          ? `标准 ${arShort} 竖幅构图的单一完整场景`
          : `标准 ${arShort} 横幅构图的单一完整场景`
      framePrompt += `\n（注意：参考图中每张角色设定图都是同一个角色的多视角展示（正面/侧面/背面/细节标注格），仅用于锁定该角色的外形、配色与服饰，绝对不要把不同视角画成多个角色；设定图中的文字标注、细节小格一律不要出现在画面里。最终画面必须是${frameWording}：把所有角色放进同一个场景中自然互动，每个角色只出现一次，禁止复制、重复任何角色，禁止分栏、拼贴、并排多格或超宽全景长图。）`
      // 比例约束：角色参考图多为怼脸设定图，模型容易把角色画得比场景尺度大（实测 1-3 布布被画成比一二大 1.5 倍）。
      // 强制参照场景参考图的真实空间尺度安排角色大小，与门窗/地面等环境元素保持合理比例。
      framePrompt += '\n【比例约束】所有出场角色（包括 @一二、@布布 等）体型大小必须符合场景参考图的真实空间尺度，与门窗、地面、茶几等环境元素保持合理比例，禁止放大某个角色或缩小其他角色导致比例失调（刻意的特写镜头除外）。多个角色共处一景时，它们之间的相对大小也必须符合实际空间关系，禁止把"说话者"画得明显大于"沉默者"。'
      // 自动判定：长镜 → 首帧+尾帧；短镜 → 单张代表画面（时长 < 7s 不再出同拍双候选）
      // keyframe 例外：它本身就是"尾帧"，恒定 1 张——再出两张首尾帧就自相矛盾了（两张都叫尾帧）。
      const durationSec = Number(shot?.duration) || 0
      const dualKeyframe = !isKeyframe && durationSec >= FRAME_DUAL_KEYFRAME_SEC
      // keyframe 的 prompt 用尾帧语义：画面定格在本镜动作全部完成后的结束状态，
      // 并显式带上 final_frame 原文（若剧本给了），让出图对齐"本镜收尾规划画面"这一确定目标。
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
      // 并行生成：长镜 2 张（首帧/尾帧），短镜 1 张。第一张存 frame_url（主图），第二张存 frame_url2
      // keyframe：恒定 1 张，存 keyframe_url（尾帧锚，不碰 frame_url/frame_url2）
      // 每张「生成 → 落盘 → VLM 验收 → 不合格自动重抽」（2026-09-15）：
      // 只判废图硬伤（frameReview.js 清单），验收失败/模型不可用时静默跳过，绝不阻塞出图。
      // 开关与重抽次数集中在 config.storyboard（env FRAME_REVIEW / FRAME_REVIEW_RETRY）。
      const reviewEnabled = config.storyboard?.frameReview !== false
      const reviewRetry = reviewEnabled ? Math.max(0, config.storyboard?.frameReviewRetry ?? 1) : 0
      const promptPerKey = isKeyframe
        ? [keyframePrompt]
        : dualKeyframe
          ? [promptStart, promptEnd]
          : [framePrompt]

      // 文件前缀/落库字段都随类型走，避免 keyframe 的图被命名成 frame_ 混进分镜图目录。
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
            // 重抽封顶治理（2026-09-16）：仍不合格只落 console 批量出图时无人可见——
            // 带伤上岗必须落系统告警（前端镜头卡片亮角标），由人决定改提示词重抽或接受。
            // 与出片链告警同库（source='frameReview'）；本镜重新出图且新图合格时自动清掉。
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
          // 新图合格 → 清掉本镜旧的「分镜图带伤」告警（只清 frameReview 来源：
          // 出片链告警描述的是旧成片，成片没换不能误清）
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
      // 短镜只有 1 张：清掉可能残留的旧尾帧，避免界面误显示首尾帧
      // keyframe 不适用：它写的是 keyframe_url，绝不能顺手清掉本镜已有的 frame_url2。
      if (!dualKeyframe && !isKeyframe) {
        execute("UPDATE shots SET frame_url2 = '' WHERE id = ?", [shotId])
      }
      console.log('[/generate/image] frame batch done', { shotId, imageType, okCount: urls.length, error: lastError || 'none' })
      if (urls.length) {
        // reviews 透传给前端（哪些张经过了验收、是否留下硬伤），不落库以免动 schema
        result = { success: true, url: urls[0], urls, imageType, dualKeyframe: !!dualKeyframe && urls.length > 1, reviews, retriedCount }
      } else {
        result = { success: false, error: lastError }
      }
    } else {
      // 故事板图（storyboard）/站位图（blocking）走统一生图入口：默认 gpt-image-2，可切 RunningHub
      result = await generateImage(prompt, { filename: `shot_${shotId}_${imageType}_${Date.now()}.png`, provider })

      console.log('[/generate/image] start', { shotId, imageType, promptLength: prompt?.length })
      console.log('[/generate/image] result', { shotId, imageType, success: result.success, hasUrl: !!result.url, url: result.url?.slice(0, 120) })
      if (result.success && result.url) {
        // 按 imageType 存到对应 _url 列；下载落本地（远程 URL 仅 24h 有效）
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
  // 画风毒词硬闸（V12）：四宫格图是下游出片的参考图源头，画风跑偏会顺着 ref 链污染成片。
  // shot 行没带 episode_id（SELECT * 不含），合并进去供白名单查询。
  try {
    assertNoStylePoison({ ...shot, episode_id: episodeId }, req.body.allowStyleShift)
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message })
  }
  // 登记任务开始：分镜页镜头卡片显示"出四宫格中"，刷新页面后可按此恢复
  // 并发防护（与 /video-v3 同口径）：同镜重复提交会起两份 RunningHub 任务、烧双倍币，
  // 且两次 UPDATE frame_url 互相覆盖，先判重再登记。
  // 只拦「活着的 running」：failed 条目要保留 10 分钟供前端展示，但不能挡用户重试；
  // running 超 30 分钟按状态端点同口径视为已死，放行重进
  const shotGridJobKey = Number(shotId)
  const existingGridJob = shotGridJobs.get(shotGridJobKey)
  if (existingGridJob?.state === 'running' && Date.now() - existingGridJob.startedAt <= SHOT_GRID_STALE_MS) {
    return res.status(409).json({ error: '该镜头正在出四宫格，请等待完成后再试' })
  }
  shotGridJobs.set(shotGridJobKey, { state: 'running', shotId: shotGridJobKey, startedAt: Date.now() })

  try {
    // 画风（与生图/视频链路同源）
    const project = queryOne('SELECT art_style FROM projects WHERE id = (SELECT project_id FROM episodes WHERE id = ?)', [episodeId])
    let stylePrompt = project?.art_style || ''
    try {
      if (stylePrompt) {
        const sp = queryOne('SELECT prompt FROM style_presets WHERE label = ? LIMIT 1', [stylePrompt])
        if (sp?.prompt) stylePrompt = sp.prompt
      }
    } catch { /* 风格库缺失时退回风格名 */ }

    // 参考图：本镜出场角色（按出场顺序去重），顺序与 buildShotGridPrompt 的 charRows 严格一致
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
    // 场景设定图：作为最后一张参考图（锁场景陈设/布局/色调，与角色图区分）
    const sceneRows = query('SELECT id, title, summary, image_url FROM scenes WHERE episode_id = ?', [episodeId])
    const sceneRow = sceneRows.find((s) => parseNames(shot.scene_assets).includes(s.title)) || null
    const refs = [...boundChars.map((c) => c.image_url)]
    if (sceneRow?.image_url) refs.push(sceneRow.image_url)

    const promptResult = buildShotGridPrompt(shot, stylePrompt, boundChars, sceneRow)
    const prompt = promptResult.prompt
    if (promptResult.warnings?.length) console.warn('[/generate/shot-grid] 降级警告:', promptResult.warnings)
    console.log('[/generate/shot-grid] start', { shotId, refs: refs.length, scene: sceneRow?.title || null, promptLength: prompt.length })

    // 渠道分发：切到 RunningHub 时走四宫格 AI 应用（shotGridApp，2048139846660657154；
    // 2026-09-09 弃用旧低价渠道工作流 shotGridGenerator/2095734156394323970），
    // 其余（runninghub 之外）保持原 zikl / Visionary 图生图路线
    const rawProvider = provider || model || ''
    let result
    if (rawProvider === 'runninghub') {
      // RunningHub 四宫格 AI 应用：参考槽为通用资源池（4 槽），allocateShotRefs 按优先级动态分配
      // （出场角色按出场顺序 > 场景 > 道具），refs 同时喂剧情文本首行"图N是X"声明与填槽——单一真源，图/文不漂移。
      // 与旧 5 槽工作流不同：不补位、不占满（fill=false）——空槽直接不上传，靠文字兜底，
      // 避免把无关角色图/重复图塞进参考槽误导模型。
      const propNames = parseNames(shot.prop_assets)
      // FIX-1d（2026-09-18，P1-Q1）：原实现 `SELECT ... WHERE name IN (...)` 是**精确串匹配**，
      // 道具名跨层不一致（shots.prop_assets ↔ props.name，两趟 LLM 各说各话）就静默匹配不到 →
      // 该道具无参考图、零告警。SQL 层做不了归一，故先取该集全部 props，再用 resolvePropName
      // 在内存归一到表名。未命中记 warn（带镜头号 + 原始道具名），把"静默丢失"变"可见"。
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
      // aspectRatio 走项目级（剧集页顶部下拉），前端从 project.aspect_ratio 透传。
      // 注意：AI 应用 nodeId 14 的枚举是短格式（'16:9'/'9:16'，无括号后缀），
      // 项目级值带后缀（'9:16 (Portrait Widescreen)'）——取首段归一后再传，避免节点校验拒收。
      result = await generateShotGridApp({
        prompt: content,
        refs,
        usageContext: { episodeId, task: 'shot-grid', frames: 1 },
        aspectRatio: String(req.body.aspectRatio || '').split(' ')[0] || undefined,
      })
      console.log('[/generate/shot-grid] runninghub result:', result)
    } else {
      // 分辨率按模型自适应（不能一刀切）：
      // - gpt-image-2 → 1K：平台默认即 1K，且文档注明 2K/4K 按 high 质量计费，用 1K 省钱
      // - Nano Banana 系列 → 2K：实测 1K 会报「当前模型不支持所选分辨率」，必须 ≥2K
      const effectiveModel = model || config.image.visionary.model
      const resolution = effectiveModel === 'gpt-image-2' ? '1K' : '2K'
      result = await generateStoryboardImage(prompt, refs, {
        filename: `shot_${shotId}_grid_${Date.now()}.png`,
        // 前端 UI 选的模型通过 provider 字段透传（runninghub / zikl / visionary-xxx）；
        // image.js resolveProvider 会把 visionary-xxx 前缀剥离归到 provider=visionary。
        provider: provider || 'visionary',
        model: model || undefined,
        size: '1:1',
        resolution,
      })
    }
    if (promptResult.warnings?.length) result.warnings = promptResult.warnings
    if (result.success && result.url) {
      const storedUrl = await persistRemoteAsset(result.url, `shot_${shotId}_grid_${Date.now()}.png`)
      // 整张 2x2 作为该镜分镜图（frame_url），不切分
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
    // 画风：与生图/视频链路同源（风格库完整 prompt）
    const project = queryOne('SELECT art_style FROM projects WHERE id = (SELECT project_id FROM episodes WHERE id = ?)', [episodeId])
    let stylePrompt = project?.art_style || ''
    try {
      if (stylePrompt) {
        const sp = queryOne('SELECT prompt FROM style_presets WHERE label = ? LIMIT 1', [stylePrompt])
        if (sp?.prompt) stylePrompt = sp.prompt
      }
    } catch { /* 风格库缺失时退回风格名 */ }

    // 参考图：段内出场角色（按出场顺序去重），顺序必须与 buildSceneGridPrompt 的
    // charRows 严格一致（第 i 个角色 = 参考图 i），prompt 里声明"角色=参考图 N"绑定。
    // 只传角色图，场景靠文字描述——多张图混传会让模型分不清哪个图对应哪个角色。
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
    // 场景设定图：最后一张参考图（锁场景陈设/布局/色调）
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
      // 四宫格是 2x2 方形网格：显式 1:1
      // 分辨率按模型自适应：gpt-image-2 → 1K（省钱/平台默认），Nano Banana 系列 → 2K（不支持 1K）
      size: '1:1',
      resolution: (model || config.image.visionary.model) === 'gpt-image-2' ? '1K' : '2K',
    })
    if (result.success && result.url) {
      const storedUrl = await persistRemoteAsset(result.url, `scene_${sceneId}_grid_${Date.now()}.png`)
      execute('UPDATE storyboard_scenes SET grid_image_url = ? WHERE id = ?', [storedUrl, scene.id])
      result.url = storedUrl
      result.gridImageUrl = storedUrl
      // 切 4 份写回各 shot.frame_url：让分镜图列每镜自动有图（"出四宫格"一次出 4 镜）
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

// 把段落整段视频按镜头时间线切分（ffmpeg-static，项目已有）
router.post('/asset-image', async (req, res) => {
  const { type, id, prompt, provider, refImageUrl, editInstruction } = req.body
  if (!type || !id || !prompt) return res.status(400).json({ error: 'type, id, prompt 必填' })

  const validTypes = {
    character: { table: 'characters', idField: 'id' },
    scene: { table: 'scenes', idField: 'id' },
    prop: { table: 'props', idField: 'id' },
  }
  if (!validTypes[type]) return res.status(400).json({ error: 'type 必须是 character/scene/prop' })

  // 反查 episode_id 校验剧本确认状态；scene 额外取 scene_number（A4/A5 质检告警要写"场 N"人话）
  const assetCols = type === 'scene' ? 'id, episode_id, scene_number' : 'id, episode_id'
  const asset = queryOne(`SELECT ${assetCols} FROM ${validTypes[type].table} WHERE id = ?`, [id])
  if (!asset) return res.status(404).json({ error: '资产不存在' })
  try {
    assertScriptConfirmed(asset.episode_id)
    // 2026-09-16 P7：补资产过期校验（与 /storyboard、/video 对齐）——剧本已改、资产已过期时
    // 不允许再用旧资产出图，否则产出与当前剧本不一致的图。空指纹（老数据）由 guards 内放行
    // （guards.js:44 `if (!fp) return`），故 ep3 这类存量数据不受影响；错误带 status（404/409），
    // 下方 catch 已按 err.status 返回，行为一致。
    assertNotStale(asset.episode_id, 'assets')
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message })
  }

  // 登记进行中资产任务（校验通过后才登记，避免无效请求污染）：
  // 前端刷新后用 /image/inflight 的 assets 数组确认本任务是否真在后端运行，
  // 从而清理「请求被中断（服务重启 / 关页面）后残留」的僵尸 loading。
  const jobKey = `asset:${type}:${id}`
  imageJobsInflight.set(jobKey, { assetType: type, assetId: id, startedAt: Date.now() })

  // ===== 空间组串行锁（2026-09-18）=====
  // 为什么必须有：空间锚「只认已落库 image_url 的邻场」（sceneAnchors.buildAnchorRefsForScene
  // 的 WHERE TRIM(s.image_url) != ''）。批量并发出图时，同组场景开画那一刻彼此的 image_url
  // 全是空串 → 锚点全被过滤掉 → 退化成各画各的纯文生图（实测：崖顶场与谷底场把同一座断桥
  // 画成了两种形制）。修复办法就是让同组场景排队——前一张 image_url 落库之后，后一张才开画。
  // 只锁 type==='scene' 且真的有空间组的场景：character / prop 的批量行为完全不变。
  // 释放时机：本函数 finally（image_url 的 UPDATE 在 try 内第 1019 行前后，finally 必在其后执行）。
  let spatialLock = null
  if (type === 'scene') {
    try {
      const g = await resolveSceneSpatialGroup(asset.episode_id, id)
      if (g && g.group) {
        spatialLock = await acquireSpatialGroupLock(`${asset.episode_id}:${g.group}`, `scene#${id}`)
      }
    } catch (e) {
      // 拿不到锁就降级为不串行（宁可偶发不一致，也不能让出图请求直接失败）
      console.warn('[/generate/asset-image] 空间组串行锁获取失败（降级为不串行）:', e.message)
      spatialLock = null
    }
  }

  try {
    const safeId = String(id).replace(/[^\w-]/g, '')
    // 图生图改造模式：带 refImageUrl（现有设定图）时以底图为形象锚——换装/加饰品只动指令要求的部分，
    // 其余纹丝不变。纯文字重画会丢失脸部/领结/腮红等细节（文字是弱锚，图才是强锚）。
    const refList = (Array.isArray(refImageUrl) ? refImageUrl : refImageUrl ? [refImageUrl] : [])
      .map((u) => String(u).split('?')[0].trim()).filter(Boolean)
    // 形象锚定兜底：普通"AI生成"（重画）时，若资产已有图，自动把旧图并入参考——
    // 防止纯文生图被画风词带跑（实测：Q版团子被画成写实水彩熊）。想彻底换形象先删图，无图才走纯文生图。
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
    // 【文件丢失防御】图生图会 fs.readFileSync 本地参考图，文件已被清理时抛 ENOENT 硬失败。
    // 这里先过滤掉「指向 /uploads/ 但磁盘上已不存在」的参考图，让流程自然降级为纯文生图，
    // 避免把「参考图文件丢失」误报成生图失败（场景/道具图文件被清理后重新生成即会触发）。
    const liveRefs = anchorRefs.filter(isLiveRefUrl)
    // 文件名必须唯一：固定名会覆盖旧文件，历史版本全部失效
    const uniqueName = `asset-${type}-${safeId}-${Date.now()}.png`
    const subject = type === 'character' ? '角色' : type === 'scene' ? '场景' : '道具'
    // 纯文生图尺寸：角色三视图设定稿需要横向画布，按 provider 给合适比例（与「一二/布布」16:9 横版约定一致）
    // - zikl(gpt-image-2)：1536x1024 横版（gpt-image-2 文生图支持的横向档位，最长边=上限）
    // - visionary：16:9（其文生图默认即 16:9，这里显式锁定，避免回退成方形）
    // - runninghub 等：不强制（工作流固定尺寸）
    // 图生图分支不强制尺寸：会沿用参考图既有尺寸，已生成的角色图本就是 16:9 横版
    const imgOpts = { filename: uniqueName, provider }
    if (type === 'character') {
      const { provider: rp } = resolveProvider({ provider })
      if (rp === 'visionary') imgOpts.size = '16:9'
      else if (rp === 'zikl') imgOpts.size = '1536x1024'
    }
    // 画风锚（2026-09-16）：场景/道具图叠加画风锚图，解决「8 张场景各画各的」画风漂移。
    // 角色三视图不叠加——角色走完整画风且已有项目库主设定自锚，画风锚会干扰其设定稿中性棚拍。
    // 锚图来源见 resolveStyleAnchorUrl（episode 锚 > 画风预设封面样张）；取不到则自动降级为纯文生图。
    const styleAnchor = (type === 'scene' || type === 'prop') ? resolveStyleAnchorUrl(asset.episode_id) : ''
    const anchorLive = styleAnchor && !liveRefs.includes(styleAnchor) && isLiveRefUrl(styleAnchor) ? styleAnchor : ''

    // ===== 场景锚点集（2026-09-16 新增）=====
    // 场景图生成时，自动从锚点集取参考图——解决"同一座桥画成两个样"。
    // 松耦合设计：不强制"场景2 参考场景1"，而是"所有场景共享锚点，按需组合"。
    // 支持：空间锚（同一场景不同视角）、道具锚（跨场同一物体）、风格锚（全局画风）。
    let sceneAnchorRefs = []
    let sceneAnchorHints = []
    let hasSpatialRef = false // 本场是否命中空间类锚（scene 邻场锚 或 spatial 组锚）；仅此判据驱动 P0-6 注入
    let sceneElements = []    // A1：本场必须可见的要素清单（回执 + 补注）
    let sceneSharedEnv = []   // A2：组级环境卡（回执 + 补注）
    // 本场机位声明（2026-09-19 修复）：A4/A5 质检要把「机位」也当比对真值之一，
    // 但该值此前只在 if 块内的 anchorResult 上，外层的 sceneReviewCtx 直接写了简写属性
    // `spatialRole` —— 未声明变量 → ReferenceError，把每次 /asset-image 调用都打成 500。
    // 这里提到与 sceneElements/sceneSharedEnv 同层（无锚点/非场景时保持空串），语义与 buildAnchorRefsForScene 一致。
    let sceneSpatialRole = ''
    if (type === 'scene') {
      try {
        // LLM 分析在模块内懒加载（指纹缓存），这里是纯 SQL 取锚点
        const anchorResult = await buildAnchorRefsForScene(asset.episode_id, id)
        sceneAnchorRefs = anchorResult.refs.filter((u) => isLiveRefUrl(u))
        sceneAnchorHints = anchorResult.promptHints
        sceneElements = anchorResult.elements || []
        sceneSharedEnv = anchorResult.sharedEnv || []
        sceneSpatialRole = String(anchorResult.spatialRole || '').trim()
        // hasSpatialRef 仅统计「空间类锚」（isSpatialSeriesAnchor：scene 邻场锚 | spatial 组锚）；纯道具锚不计入，
        // 否则会错误约束一张道具特写图「构图以参考图为准」（设计 §1.2 架构师坑 2）
        hasSpatialRef = (anchorResult.anchors || []).some(isSpatialSeriesAnchor)
        // 锚点图与旧图/画风锚去重
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

    // ===== A1/A2 要素硬约束 · 服务端幂等补注（2026-09-17）=====
    // 前端 promptBuilder 已在拼 prompt 时注入这两段（见 src/services/promptBuilder.js）。
    // 这里再补一次，理由是**版本滞后**：prompt 由前端拼好传过来，用户浏览器可能还跑着旧 bundle
    // （或 prompt 来自任何非本项目的调用方）——那要素清单就永远进不了画面，而这类"静默缺失"
    // 正是本方案要消灭的那类故障。补注按「标题是否已出现」判定，已注入则逐字不动（幂等）。
    // 空清单 → 两段 note 均为 ''，prompt 逐字不变（老数据/分析未跑的场景行为完全一致）。
    let promptFinal = String(prompt || '')
    if (type === 'scene') {
      const elNote = buildElementNote(sceneElements)
      if (elNote && !promptFinal.includes(ELEMENT_NOTE_TAG)) promptFinal += elNote
      const envNote = buildSharedEnvNote(sceneSharedEnv)
      if (envNote && !promptFinal.includes(SHARED_ENV_NOTE_TAG)) promptFinal += envNote
    }

    // ===== A4/A5 场景图内容质检（2026-09-17）=====
    // 与 frameReview（分镜图硬伤）不同：这里比对的是「prompt 里写明的清单 vs 画面实际内容」。
    // 比对基准 = 本次真实注入的两份清单 + 机位 + 是否带了布局结构锚（全部取自本次调用上下文，
    // 不重新查库 —— 避免"注入的"和"质检用的"两份数据不一致）。
    // 开关 sceneReview 默认 false（见 config.js 注释：让布哥主动开启，不被默认值扣费）。
    const sceneReviewEnabled = type === 'scene' && config.storyboard?.sceneReview === true
    const sceneReviewRetry = sceneReviewEnabled ? Math.max(0, config.storyboard?.sceneReviewRetry ?? 1) : 0
    const sceneReviewCtx = {
      elements: sceneElements,
      sharedEnv: sceneSharedEnv,
      spatialRole: sceneSpatialRole,
      hasLayout: sceneAnchorRefs.length > 0 && hasSpatialRef,
    }

    let result
    // 场景锚点的特别提示（道具连续/空间连续），有锚点时拼进各分支提示词
    // ── 人审基准图 · 优先级注入（P0-6）── 唯一注入点（设计 §4.4）：
    //   ① basePrompt：有空间锚时把 prompt 里的「以场景描述为准」冲突句字面替换为「以锚图为准」（方案 C）；
    //      无空间锚 → basePrompt === prompt（同引用），AC6 成立。
    //   ② sceneHintNote：在锚点提示后追加剧本优先级子句（方案 A）。
    //   注：用 promptFinal（= prompt + A1/A2 补注）而非原始 prompt —— 补注的要素句不含光照断言，
    //       与 swapSceneLightingNote 的替换目标互不干扰，顺序无关。
    //   retryNote（A4/A5）：质检不合格时由 buildSceneRetryNote 生成的针对性加固句，
    //       只在重抽时非空 —— 首轮为空串，prompt 逐字不变（老行为完全一致）。
    const runSceneGeneration = async (retryNote = '', fileName = uniqueName) => {
    const promptWithRetry = retryNote ? promptFinal + retryNote : promptFinal
    const basePrompt = hasSpatialRef ? swapSceneLightingNote(promptWithRetry) : promptWithRetry
    // 本次尝试的落盘文件名与出图尺寸（重抽时换名，避免覆盖上一版）
    const imgOptsAttempt = { ...imgOpts, filename: fileName }
    const sceneHintNote = sceneAnchorHints.length
      ? `特别注意：${sceneAnchorHints.join('；')}。${hasSpatialRef ? ANCHOR_PRIORITY_NOTE : ''}`
      : ''
    if (refList.length && liveRefs.length) {
      const instruction = String(editInstruction || basePrompt).trim()
      // 参考图总量封顶 5 张：用户参考图 + 场景锚点 + 画风锚
      const saRefs = sceneAnchorRefs.slice(0, Math.max(0, 4 - liveRefs.length))
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
      // 改造参考图文件已丢失：场景锚点/画风锚能带都带上，否则纯文生图（宁出新图，不报错）
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
      // 重画（带旧图）：参考图角色必须分离——
      //   参考图1（本场旧图）= 视角与构图基准（本场长什么样它说了算）
      //   场景锚点（邻场图）  = 只校准"共有物体的形态/颜色/破损"与跨场空间连续，严禁照搬其视角
      //   画风锚             = 只锁笔触质感
      // ⚠️ 2026-09-17 实测教训：旧图与空间锚若都声明为"空间基准"（buildAnchorNote 合并计数），
      //    模型面对两张视角矛盾的"空间真相"会二选一——场2（谷底视角）的正确旧图
      //    被场1（崖顶视角）的空间锚覆盖，重画成了邻场克隆。角色必须分开声明。
      const saRefs = sceneAnchorRefs.slice(0, Math.max(0, 4 - liveRefs.length))
      const saRoleNote = saRefs.length
        ? `（参考图${liveRefs.length + 1}${saRefs.length > 1 ? `~${liveRefs.length + saRefs.length}` : ''}为【同空间邻场锚点】：` +
          `仅用于校准与本场共有物体的形态、颜色、材质与破损状态，以及跨场空间结构的连续性；` +
          `严禁继承其视角、构图与光照——本图的视角、构图与空间布局一律以参考图1（本场旧图）和文字描述为准。）`
        : ''
      const styleRoleNote = anchorLive
        ? (saRefs.length
            // 有场景锚点时不用 buildAnchorNote 合并计数（它会把锚点也标成"空间基准"，见上方教训）
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
      // 首次生成 + 有画风锚（懒锚：不要求从场 1 开始，先画的场景同样带上锚）：
      // 场景锚点锁空间/道具连续，画风锚锁笔触；空间与光照以场景自身文字描述为准
      const anchorOnlyPrompt =
        `按以下描述绘制一张全新的环境空镜头：${basePrompt}。` +
        sceneHintNote +
        buildAnchorNote(sceneAnchorRefs.length)
      // 场景锚点与画风锚合并（场景锚点在前，优先保证空间一致性）
      const allRefs = [...sceneAnchorRefs, anchorLive]
      result = await generateStoryboardImage(anchorOnlyPrompt, allRefs, { filename: fileName, provider })
    } else if (sceneAnchorRefs.length) {
      // 无画风锚但有场景锚点：用锚点保证空间/道具一致性
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
    }   // ← runSceneGeneration 结束

    // ===== A4/A5 生成 → 质检 → 针对性重抽 循环 =====
    // 非场景（character/prop）恒走一轮：sceneReviewEnabled=false → 循环体只执行一次，
    // 行为与改造前**逐字一致**（降级铁律）。
    // 每次重抽必须换文件名：沿用同一个 uniqueName 会覆盖上一版，历史版本全失效。
    let sceneReviews = []
    let lastRetryNote = ''
    for (let attempt = 0; attempt <= sceneReviewRetry; attempt++) {
      const attemptName = attempt === 0 ? uniqueName : uniqueName.replace(/\.png$/, `_a${attempt}.png`)
      result = await runSceneGeneration(attempt === 0 ? '' : lastRetryNote, attemptName)
      if (!result?.success) break
      if (!sceneReviewEnabled) break
      // 质检必须拿到**已落盘**的本地图：远程 URL 未落盘时跳过（绝不为此多下一次）
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
      // zikl 路径已落盘为 /uploads/asset-xxx.png；runninghub 等返回远程 URL（有时效，刷新后即失效）必须落本地
      let storedUrl = result.url
      if (!storedUrl.startsWith('/uploads/')) {
        // 重试下载，应对瞬时超时/网络抖动；全部失败则明确报错，绝不把会失效的远程 URL 当成功返回
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
          // 图片已生成但无法本地化保存：返回失败让前端明确提示重试，避免"假成功→刷新消失"
          return res.json({ success: false, error: '图片已生成但本地保存失败（远程链接无法下载），请重试' })
        }
      }
      // 加时间戳破坏浏览器缓存：URL 不变时浏览器一直显示旧图
      const cacheBust = `${storedUrl}${storedUrl.includes('?') ? '&' : '?'}t=${Date.now()}`
      const bareUrl = storedUrl.split('?')[0]

      // 形象历史归属：character 挂项目库主设定（换装是项目级能力）；scene/prop 挂集行
      const histAssetId = type === 'character'
        ? (queryOne('SELECT project_character_id FROM characters WHERE id = ?', [id])?.project_character_id || null)
        : id

      // 旧当前形象入史（initial）：历史功能上线前已存在的图也能随时找回
      // scenes 表没有 description 列（只有 summary），用 descCol 兼容；其他表 (characters/props) 用 description
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
      // 项目库托管角色：设定图与描述都是主设定级资产，同步主设定（含描述——前端会把改造指令追加进描述）
      if (type === 'character' && histAssetId) {
        const newDesc = refList.length && editInstruction
          ? (() => { const cur = queryOne('SELECT description FROM project_characters WHERE id = ?', [histAssetId])?.description || ''; const base = cur.replace(/[。；;\s]*$/, ''); return (base ? base + '，' : '') + editInstruction + '。' })()
          : oldDesc
        execute('UPDATE project_characters SET image_url = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [cacheBust, newDesc, histAssetId])
        syncProjectCharacterToEpisodes(histAssetId)
        // 新版本入史：图 + 描述快照一起存，恢复时图文一起回滚
        execute('INSERT INTO asset_image_history (asset_type, asset_id, image_url, description, source, instruction) VALUES (?, ?, ?, ?, ?, ?)',
          [type, histAssetId, bareUrl, newDesc, refList.length ? 'edit' : 'generate', editInstruction || ''])
      } else if (histAssetId) {
        execute('INSERT INTO asset_image_history (asset_type, asset_id, image_url, description, source, instruction) VALUES (?, ?, ?, ?, ?, ?)',
          [type, histAssetId, bareUrl, oldDesc, refList.length ? 'edit' : 'generate', editInstruction || ''])
      }
      result.url = cacheBust
      // 画风锚来源回执：null = 未使用锚图（纯文生图 / 角色图 / 无可用锚），便于前端与日志排查
      result.styleAnchor = anchorLive || null
      // A1/A2 要素回执（2026-09-17）：把本场实际用于硬约束的清单带回前端——
      // A4/A5 的视觉质检（下一阶段）要用它作为「这张图该有什么」的比对基准；
      // 也给排查「摘要写了浓雾却没画出来」这类问题一个肉眼可核对的现场。
      if (type === 'scene') {
        result.sceneElements = sceneElements
        result.sceneSharedEnv = sceneSharedEnv
      }
      result.description = type === 'character' && histAssetId
        ? (queryOne('SELECT description FROM project_characters WHERE id = ?', [histAssetId])?.description || '')
        : undefined

      // ===== A4/A5 质检回执与告警（2026-09-17）=====
      // 回执透传给前端（哪些轮经过了质检、检出什么），不落库以免动 schema —— 与 frame 分支同口径。
      // 落尽重抽仍不合格 → 落系统告警：批量出图时 console 无人可见，带伤上岗必须让人知道。
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
        // 本场重新出图且新图合格 → 清掉旧的「场景图与剧本不符」告警（只清 sceneReview 来源）
        if (lastReview.verdict !== 'fail') {
          try { resolveAlertsByScene(Number(id), 'scene-regen', 'sceneReview') } catch { /* 清告警失败不影响出图 */ }
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
          } catch { /* 记告警失败不影响出图 */ }
        }
      }

      // ===== 场景锚点自动登记（2026-09-16）=====
      // 场景图生成成功后，自动登记为锚点，供后续场景参考
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
    // 无论成功/失败/异常/提前 return 都必须放锁，否则同组后续任务被永久卡死
    releaseSpatialGroupLock(spatialLock)
    // 无论成功/失败/提前 return 都注销登记，避免留下永久 in-flight 假任务
    imageJobsInflight.delete(jobKey)
  }
})

// ===== 场景锚点集管理（2026-09-16）=====

// 初始化锚点集：LLM 强制重析全集 + 用现有定稿图回填锚点（用于已有项目的回填）
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

// 场景空间分组（2026-09-18）：给前端批量生图做「组内串行、组间并发」调度用。
// 为什么不复用 GET /scene-anchors：那张表只在**出过图**后才登记锚点行，批量补生成时
// 绝大多数场景还没出图、查不到分组；而 scene_analysis 是「提取资产即落库」的全量行。
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

// ===== A3 布局图锚（2026-09-17）=====
//
// 为什么需要：现有的「人审基准图」是一张**照片**，同时携带视角/光影/画风/主体占比。
//   让模型"继承它、但别照搬构图"天然是自相矛盾的指令——cliff_river 视角塌陷与
//   「场2 被场1 覆盖重画」两次事故都长在这块土壤上。
// 解法：给每个空间组额外生成一张**俯视布局示意图**，只表达「什么在什么位置、朝向、距离比例」，
//   不含视角/光影/画风。它因此可以被组内所有视角无冲突地继承。
// 两级入口：
//   GET  /layout-anchor?episodeId=&group=   查当前布局图（前端展示"布局图"卡）
//   POST /layout-anchor                      生成/重画（幂等 upsert 到 scene_anchors）

// GET：查某组布局图（含素材预览，让人知道"这张图该画什么"）
router.get('/layout-anchor', async (req, res) => {
  const episodeId = Number(req.query.episodeId)
  const group = String(req.query.group || '').trim()
  if (!episodeId || !group) return res.status(400).json({ error: 'episodeId/group 必填' })
  try {
    // 懒分析：保证素材新鲜（失败不阻断查询）
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

// POST：生成布局图并登记为 layout 锚
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

    // 布局图 prompt：全部素材来自 LLM 分析结果，零题材词表
    // 画风文案：与资产图/分镜图同源——project.art_style 若命中 style_presets.label 则取其完整 prompt，
    // 否则用 art_style 原文（与服务端其它生图入口同一套 fallback，不新造口径）。
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

    // ===== 生成 + 生成后闸 + 针对性重试 =====
    //
    // 为什么要这个循环（六轮实测结论，详见 ai/sceneAnchorPrompt.js 顶部与 ai/layoutReview.js）：
    //   布局图是「等轴测示意图」，而"示意图"这个图像分布**天然带标注文字与引线**。
    //   六版 prompt 迭代中只有一版干净，且无法复现 → 靠 prompt 对抗这个先验收益极低。
    //   故改为工程闭环：生成 → 视觉模型判定 → 只对**实际检出的问题**加固 → 重试。
    //
    // 降级铁律：闸门故障（未配模型/网络/JSON 异常）一律放行（verdict='skip'），
    //   绝不因为"验收跑不起来"就阻断出图。
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
      // 纯文生图（不叠任何锚）：布局图是**权威源**，被别的图影响会引入视角污染
      const gen = await generateImage(p, { filename, provider })
      if (!gen?.success || !gen.url) {
        attempts.push({ attempt, ok: false, error: gen?.error || '生成失败' })
        if (attempt === MAX_LAYOUT_ATTEMPTS) {
          return res.json({ success: false, error: gen?.error || '布局图生成失败', attempts })
        }
        continue
      }
      // 远程图必须落本地（与资产图同规则：URL 有时效，不落本地会刷新即失效）
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

      // 生成后闸：判定这张图是否会被同组每个场景继承污染
      const review = await reviewLayoutImage(bare, { episodeId: ep, attempt })
      attempts.push({
        attempt, ok: true, url: bare,
        verdict: review.verdict,
        defects: review.defects || [],
        skipReason: review.skipReason,
      })

      // 保留"最后一版"作为兜底（即便从未通过，也要有图可用 —— 降级可用性优先）
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

    // 代表场信息（布局图卡展示用；取自组内最小场次）
    const rep = queryOne(
      `SELECT s.id AS scene_id, s.scene_number FROM scene_analysis sa
       JOIN scenes s ON s.id = sa.scene_id
       WHERE sa.episode_id = ? AND sa.spatial_group = ?
       ORDER BY s.scene_number ASC LIMIT 1`,
      [ep, g]
    )
    // 记下"画这张图时用的素材指纹"（2026-09-18）：日后场景描述改了，
    // status 接口据此比对出"素材已变、布局图可能过时"，前端显式提示重画。
    // 不记指纹 → 用户会一直拿一张基于旧素材的图当权威空间基准，错误顺锚放大到整组。
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
      // A3 质检回执：前端可据此提示"此图质检未通过/已被重试N次"
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

// 查询锚点集
router.get('/scene-anchors', (req, res) => {
  const { episodeId } = req.query
  if (!episodeId) return res.status(400).json({ error: 'episodeId 必填' })
  try {
    // 锚点 + 空间分析一起返回（空间组在 scene_analysis，不在 scene_anchors）
    const anchors = query(
      `SELECT sa.*, ana.spatial_group, ana.spatial_role
       FROM scene_anchors sa
       LEFT JOIN scene_analysis ana ON ana.episode_id = sa.episode_id AND ana.scene_id = sa.scene_id
       WHERE sa.episode_id = ? ORDER BY sa.anchor_type, sa.scene_number`,
      [Number(episodeId)]
    )
    // 按类型分组
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

// 确认锚点（人工审核后标记为可用）
// ⚠️ 2026-09-17 起已被 /spatial-group-review/decide 取代（人审基准图第 3 层）。保留仅为兼容，
//    新代码勿调用：decide 按 episodeId+group 写完整 spatial 锚行 + 更新 review 状态，
//    本路由仅按 anchorId 翻 confirmed 位，语义不同。
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

// ===== 分组人审锁定（2026-09-17）=====
//
// 动机：spatial_group 由 LLM 逐次自由裁量，重析会重组已验证的组结构，
//   使已确认的组锚变孤儿、人审基线静默失效（实测 4 组→2 组）。
// 锁 = 把「某场归某组」固化成数据，重析时复用（见 ai/sceneGroupLock.js）。
// 三个端点都只读写锁，**不触发重析**（锁与重析解耦，避免误触）。

// 查：当前锁定状态 + 孤儿组锚（前端提示「人审基准已失效」用）
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

// 锁：把**当前**分组状态锁住（人审确认后调用）。幂等。
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

// 解锁：body.sceneIds 为空 → 解除该集全部
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

// 形象版本历史：?type=character&id=<集行id>。character 历史挂主设定，未链项目库的角色无历史。
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

  // 老资产首次打开且历史为空：把当前图补录为 initial 版本
  if (!history.length && currentImg) {
    execute('INSERT INTO asset_image_history (asset_type, asset_id, image_url, description, source, instruction) VALUES (?, ?, ?, ?, ?, ?)',
      [type, histAssetId, currentImg, currentDesc, 'initial', '当前版本'])
    const lid = queryOne('SELECT last_insert_rowid() AS lid').lid
    history.unshift({ id: lid, image_url: currentImg, description: currentDesc, source: 'initial', instruction: '当前版本', is_current: true })
  }

  res.json({ success: true, history, current: { image_url: currentImg, description: currentDesc } })
})

// 恢复历史版本：图 + 描述快照一起回滚（只回图不回文会重新造成图文打架）
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
      // scenes 表没有 description 列（只有 summary）：与读取侧 descCol 同款兼容，
      // 否则场景恢复历史版本必撞「no such column: description」
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
