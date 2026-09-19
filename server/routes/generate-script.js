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
import { generateScript, classifyScriptIntent, reviseScriptEdits, applyScriptEdits, rewriteFullScript, rewriteScriptSegment, extractAssets, generateStoryboard, generateStoryboardFromFile, extractBlockingForScene, assembleBlockingPlan, enrichShotIntegrated, chatCompletion, fixAxisFlips, extractFinalFrameFromIntegrated } from '../ai/doubao.js'
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
import { clearQcIgnores } from './qc.js'
// 系统告警（2026-09-13）：出片后置钩子链失败可见化——落 system_alerts，前端亮角标、响应带 warnings
import { recordAlert } from '../ai/alerts.js'
import { buildGlobalSpeakerMap } from '../ai/h3PromptTranslator.js'
import { validateCameraAngle, inferAngleFromText, angleInjection } from '../ai/cameraAngle.js'
import { generateImage, generateStoryboardImage, resolveProvider } from '../ai/image.js'
import { backfillStoryboardAssets } from '../ai/assetBackfill.js'
// 资产质量后置校验（2026-09-16 建 / 2026-09-18 改为 LLM 判定）：
// 场景 summary 与 lighting_en 的冷暖自洽检测（只告警不阻断）
import { runLightingChecks } from '../ai/lightingCheckRuntime.js'
// 重新提取覆盖保护（2026-09-16 P1）：一键全流程后台无人可确认，只做「覆盖前快照」兜底
import { snapshotBeforeExtract, computeExtractDiff } from '../ai/extractGuard.js'
import { classifyShotCombat } from '../ai/shotClassifier.js'
import { config } from '../config.js'
// cleanText 统一到 ai/shared.js（原此处与 ai/videoPrompt.js 各有一份实现）
import { clean as cleanText, CJK_DIRTY_RE } from '../ai/shared.js'
// 台词读写判据单点（2026-09-18 P0-3）：本文件读侧原写 JSON.parse（脏值靠 try/catch 兜），
// 写侧原写 `shot.dialogue ? JSON.stringify(shot.dialogue) : ''`——与 episodes.js 同源同病，
// 只是那条路径走到 falsy 分支写了 ''。两处都统一到 dialogue.js，判据不再两份。
import { parseDialogue, serializeDialogue } from '../ai/dialogue.js'
// 角色名 → 别名映射（name_en / aliases）：越轴巡检的侧位解析需要它才能认出模型写的英文名
import { buildAliasMap } from '../ai/storyboardValidator.js'
// 长任务进度总线（2026-09-16）：分镜提取 / 文件规整 / 补全 三条路径共用，
// 前端 1.5s 轮询回显结构化进度（第几场 / 共几场 / 阶段 / 已用时）
import { reportProgress, finishProgress, makeReporter, getProgress, getActiveProgress, listProgress } from '../ai/progressBus.js'
// 进度阶段常量（真源见 progressPhases.js）：上报点只引用常量，不散写字符串字面量
import { PHASE } from '../ai/progressPhases.js'
import { replaceEpisodeCharacters, mergeMasterIntoEpisodeCharacters, syncProjectCharacterToEpisodes } from '../characterLibrary.js'
import { routeIp, buildCharacterContext, resolveExplicitCharacters } from '../ai/ipRouter.js'
// 成片拼接（保存至成片）：ffmpeg-static 已用于分镜图切分（directorRequest.js），这里复用同一份二进制
import ffmpegStaticPath from 'ffmpeg-static'
// 场景重建后的引用重挂（2026-09-18，P1-Q2）：scenes 重建换 id 后，把 scene_group_locks /
// scene_anchors 的 scene_id 按稳定键（title → scene_number）重挂到新 id，否则分组锁按旧 id
// 悬空 → loadGroupLocks 匹配不到 → 防漂移保护静默归零。纯映射逻辑在 ai/sceneIdRemap.js（可单测）。
import { remapSceneRefs } from '../ai/sceneIdRemap.js'

// 分镜流程的进度任务类型（2026-09-16）：作为 progressBus 的 task 键。
// 用常量而非散落字符串字面量——前端要靠这些值区分任务类型，写错就静默对不上。
// ⚠️ 必须在文件顶部定义：本文件多处（/full、/enrich-storyboard、/storyboard 等）在
// 各自 handler 里引用它，而 handler 虽在调用时才执行，常量却要保证在模块求值阶段就已初始化。
const SB_TASK = {
  // 从剧本创作分镜（/storyboard、/full）
  GENERATE: 'storyboard',
  // 从文件规整分镜（/storyboard-from-file）
  FROM_FILE: 'file',
  // 补全镜头提示词（/enrich-storyboard）
  ENRICH: 'enrich',
}

const router = Router()

/**
 * FIX-2（2026-09-18，P1-Q2）：scenes 重建后，把 scene_group_locks / scene_anchors 的 scene_id
 * 按稳定键（title → scene_number）从旧 id 重挂到新 id。
 *
 * 为什么必须做：本文件的资产提取走 `DELETE FROM scenes` + 逐条重插 → scenes.id 全部换新，
 *   而锁/锚仍指向旧 id → loadGroupLocks 按 scene_id 查不到 → applyGroupLocks 全不命中 →
 *   分组防漂移保护**静默归零**。
 * 匹配不到的锁/锚行：只记 warn 告警，**绝不删除**（行保留 → 人在前端可见可处置）。
 * 降级铁律：整体 try/catch，失败只 console.warn，绝不阻断资产提取主流程。
 * 纯映射逻辑在 ai/sceneIdRemap.js（可单测），此处只做 DB 读写与告警。
 */
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

// [清理 2026-09-19] 以上 7 项是本文件独用的实现，故**留在本文件**（不抽共享模块）。
// 核实依据：逐函数统计三处 generate-*.js 的调用点 ——
//   buildAssetContextForPrompt ×2 / updateTask ×9 / dedupeAssets ×6 / filterFurnitureProps ×2
//   （isFurniture 仅被 filterFurnitureProps 内部调用）
// 全部只在本文件出现；generate-image.js 只用一个 persistRemoteAsset，generate-post.js 六个全零。
// 故那两个文件里的副本按死代码直接删除，无需引入任何新模块。

// 创作主题 → 定位资产库里的角色。前端在用户点"生成"前调用：
// high 直接展示已识别角色徽章；low/none 弹候选让用户勾选，
// 用户确认后把 characterIds 回传给 /script 或 /full。
router.post('/ip-route', async (req, res) => {
  const { prompt, projectId, characterIds } = req.body
  if (!prompt || !String(prompt).trim()) {
    return res.status(400).json({ error: 'prompt 必填' })
  }
  try {
    // characterIds：用户在候选里勾选后重新路由（如输入变化触发重判）时带上
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

// 一键生成全流程
router.post('/full', async (req, res) => {
  const { episodeId, prompt, options = {} } = req.body
  if (!episodeId || !prompt) {
    return res.status(400).json({ error: 'episodeId 和 prompt 必填' })
  }

  // 并发防护：该集已有进行中的一键生成任务时拒绝，避免两个任务交错写库互相覆盖
  if (runningFullTasks.has(String(episodeId))) {
    return res.status(400).json({ error: '该集已有进行中的一键生成任务' })
  }
  runningFullTasks.add(String(episodeId))

  const taskId = randomUUID()
  execute(
    'INSERT INTO tasks (id, episode_id, type, status, progress, message) VALUES (?, ?, ?, ?, ?, ?)',
    [taskId, episodeId, 'full', 'pending', 0, '任务已创建']
  )

  // 立即返回，后台异步执行
  res.json({ taskId, message: '任务已提交，正在后台执行' })

  // 异步执行全流程；无论成功失败，任务终态后释放该集的并发锁
  runFullPipeline(taskId, episodeId, prompt, options)
    .catch((err) => {
      console.error('[Full Pipeline Error]', err)
      updateTask(taskId, { status: 'failed', error: err.message, message: '生成失败' })
    })
    .finally(() => {
      runningFullTasks.delete(String(episodeId))
    })
})

/**
 * /full 路径的 P1 覆盖保护（2026-09-16 补齐）。
 *
 * 背景：/full 是后台一键生成，无人可在弹窗上确认「保留我的 / 接受新值」，
 * 所以不能像单表路由那样返回 risk 让前端决策。这里做的是**留证**：
 * 用与路由同一套 computeExtractDiff 判据比对「本次将写入的最终行 vs 库中现有行」，
 * 一旦检出覆盖/删除风险就写一条 warn 告警进 system_alerts（前端亮角标可见），
 * 配合覆盖前的 snapshotBeforeExtract 快照，事后可定位并一键还原。
 *
 * 该函数**绝不抛错**（辅助链路失败不能搞挂主流程）。
 *
 * @param {string} trigger    告警来源标记（如 'pipeline-props'）
 * @param {number} episodeId
 * @param {'characters'|'props'|'scenes'} table
 * @param {Map<string, Object>} oldMap 旧行（按 name/title 索引），用于算最终生效值
 * @param {Array} incoming   LLM 本次提取结果（对象或字符串）
 */
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
          // 最终生效值：旧值优先（与下方 INSERT 参数同式），否则会把「实际不会被覆盖」误报为风险
          owner: old?.owner || (isStr ? '' : (item.owner || '')) || '',
          image_url: old?.image_url || '',
          name_en: old?.name_en || (isStr ? '' : (item.nameEn ?? item.name_en ?? '')) || '',
        }
      }
      // scenes：name 与 INSERT 循环同式兜底（'场景N'）无法在无序号时复现，这里按 s.name 直取，
      // 匹配不上旧行的会被 diff 判为「新增条目」而非风险，属可接受的保守偏差。
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
      // 明细内联进 message（2026-09-16 QA 复核 OBS-1）：告警只存 message 字符串，
      // report 对象不会被持久化——原文案「明细见 report」指向了不存在的东西，用户无从定位。
      // 故把条目级明细（哪个资产 / 哪些字段）直接写进文案。report 真实结构见
      // computeExtractDiff：overwrites=[{name, fields:[{field,from,to}]}]、deletions=[{name, row}]。
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
    // 留证失败不影响主流程
    console.warn(`[extract-overwrite] ${trigger} 留证失败（已忽略）:`, e.message)
  }
}

// 全流程编排
async function runFullPipeline(taskId, episodeId, prompt, options) {  const { generateImages = true, generateVideos = true } = options

  // ===== Step 0: 从资产定位出场角色 =====
  // 主题里点了角色名（高置信）才注入；定位失败或置信不足时不挡流程，按裸主题生成。
  // 前端已通过 /ip-route 预路由并让用户确认过时，可直接传 options.characterIds。
  const assetContext = await buildAssetContextForPrompt(prompt, episodeId, options.characterIds)

  // ===== Step 1: 生成剧本 =====
  updateTask(taskId, { status: 'running', progress: 5, message: '正在生成剧本...' })
  const rawScript = await generateScript(prompt, '', assetContext)
  // 格式兜底：模型偶发不按「场次N：标题」输出时自动归一化
  const { text: script } = await ensureStandardScript(rawScript, { episodeId })
  execute('UPDATE episodes SET script_content = ?, script_confirmed = 1 WHERE id = ?', [script, episodeId])
  updateTask(taskId, { progress: 20, message: '剧本生成完成' })

  // ===== Step 2: 提取资产 =====
  updateTask(taskId, { progress: 25, message: '正在提取角色/场景/道具...' })
  // 获取项目画风，传入资产提取
  const episodeForStyle = queryOne('SELECT project_id FROM episodes WHERE id = ?', [episodeId])
  const projectForStyle = episodeForStyle ? queryOne('SELECT art_style FROM projects WHERE id = ?', [episodeForStyle.project_id]) : null
  const artStyle = projectForStyle?.art_style || ''
  const assets = await extractAssets(script, artStyle)
  // 结构防御：AI 偶发返回非数组（对象/字符串/null）时统一 coerce 成数组，
  // 防止非数组透传给 replaceEpisodeCharacters/落库循环清空资产表
  assets.characters = Array.isArray(assets.characters) ? assets.characters : []
  assets.props = Array.isArray(assets.props) ? assets.props : []
  assets.scenes = Array.isArray(assets.scenes) ? assets.scenes : []
  // 三类全空说明提取结果不可用：直接失败，不落任何资产和指纹（用户重新发起即可）
  if (!assets.characters.length && !assets.props.length && !assets.scenes.length) {
    throw new Error('AI 未提取到任何资产，请重试')
  }
  // 去重（大模型偶发会重复提取同名道具/角色/场景）
  assets.characters = dedupeAssets(assets.characters, (c) => (typeof c === 'string' ? c : c.name))
  assets.props = dedupeAssets(assets.props, (p) => (typeof p === 'string' ? p : p.name))
  assets.scenes = dedupeAssets(assets.scenes, (s) => (typeof s === 'string' ? s : s.name))
  filterFurnitureProps(assets)

  // 保存角色（重提取前按名字记住旧资产的图片/音频，重插时带回，避免已生成的资产图丢失）
  // 读时主设定合并：图片/音频回落时也用主设定版本，而不是 characters 表里的旧副本
  const oldCharMap = new Map(
    mergeMasterIntoEpisodeCharacters(
      query('SELECT name, image_url, audio_url, project_character_id FROM characters WHERE episode_id = ?', [episodeId])
    ).map((c) => [c.name, c])
  )
  if (assets.characters?.length) {
    // 走项目角色库：同名角色继承主设定的形象/描述/音色，LLM 每次提取的猜测不再覆盖已有设定
    replaceEpisodeCharacters(episodeId, episodeForStyle?.project_id || null, assets.characters, { source: 'extract' })
  }
  // 保存道具（同样保留旧图）
  // 英文字段（name_en / description_en）按同名道具继承旧值：重提取不抹掉手工维护的英文常量
  // （H3 提示词全英文，name_en/description_en 为空会静默回退中文）。owner 同理继承，空值会让
  // 道具提示词的「专属角色」约束静默消失。
  // ⚠️ 两类字段的判据不同，不要统一：
  //   · name_en 走「旧值优先」（`||`）——本文件既有语义，LLM 新值仅在旧值为空时生效；
  //   · description_en 走「显式带值优先」（`??`）——空串 = 用户主动清空，必须能落库，
  //     用 `||` 会让清空操作静默失效（回退旧值）。这是 T2 铁律，故此处不跟随文件既有 `||` 风格。
  const oldPropMap = new Map(
    query('SELECT name, image_url, owner, name_en, description_en FROM props WHERE episode_id = ?', [episodeId]).map((p) => [p.name, p])
  )
  if (assets.props?.length) {
    // P1（2026-09-16）重新提取覆盖保护：DELETE 之前把现有道具行整体快照（失败只记告警、不阻断）
    snapshotBeforeExtract({ episodeId, trigger: 'pipeline-props', tables: ['props'] })
    // 后台无人可确认覆盖风险 → 逐条比对后写 system_alerts 留证，让人事后能发现并还原
    // （此前 /full 路径完全没有 P1 覆盖保护，是本路径的缺口）
    recordPipelineDiff('pipeline-props', episodeId, 'props', oldPropMap, assets.props)
    execute('DELETE FROM props WHERE episode_id = ?', [episodeId])
    for (const p of assets.props) {
      // 兼容字符串和对象两种格式
      const name = typeof p === 'string' ? p : (p.name || '')
      const description = typeof p === 'string' ? '' : (p.description || '')
      const llmOwner = typeof p === 'string' ? '' : (p.owner || '')
      const old = oldPropMap.get(name)
      // name_en 最终生效值：旧值优先（重提取不抹掉手工维护的英文名），与下方 INSERT 参数同式
      const finalNameEn = old?.name_en || (typeof p === 'string' ? '' : (p.nameEn ?? p.name_en ?? '')) || ''
      // description_en 最终生效值：**显式带值优先**（`??`，非 `||`）——空串代表用户主动清空，
      // 若用 `||` 会回退旧值导致清空无效。旧值仅在提取结果没带该键（undefined）时兜底。
      const finalDescriptionEn = old?.description_en ?? (typeof p === 'string' ? '' : (p.descriptionEn ?? p.description_en ?? '')) ?? ''
      execute('INSERT INTO props (episode_id, name, description, owner, image_url, name_en, description_en) VALUES (?, ?, ?, ?, ?, ?, ?)', [episodeId, name, description, old?.owner || llmOwner || '', old?.image_url || '', finalNameEn, finalDescriptionEn])
    }
  }
  // 保存场景（此前一键流程从未落库，导致场景资产丢失、生图 prompt 里场景描述为空）
  // 英文字段（title_en/summary_en/lighting_en）按同名场景继承旧值：重提取不抹掉手工维护的
  // 英文描述与光影常量（与 image_url 的保留语义一致——旧值优先，LLM 新值仅在旧值为空时生效）。
  // location（场景地点，2026-09-17 补齐）：走「显式带值优先」`??`，空串 = 用户主动清空，
  // 不得用 `||` 回退旧值；旧值仅在提取结果没带该键（undefined）时兜底。
  const oldSceneMap = new Map(
    query('SELECT title, image_url, title_en, summary_en, lighting_en, location FROM scenes WHERE episode_id = ?', [episodeId]).map((s) => [s.title, s])
  )
  if (assets.scenes?.length) {
    // P1（2026-09-16）重新提取覆盖保护：DELETE 之前把现有场景行整体快照（失败只记告警、不阻断）
    snapshotBeforeExtract({ episodeId, trigger: 'pipeline-scenes', tables: ['scenes'] })
    // 后台无人可确认覆盖风险 → 写 system_alerts 留证（与 props 分支同源保护）
    recordPipelineDiff('pipeline-scenes', episodeId, 'scenes', oldSceneMap, assets.scenes)
    // FIX-2（2026-09-18，P1-Q2）：重建前快照旧 scenes（id/title/scene_number），供重建后把
    // scene_group_locks / scene_anchors 的 scene_id 按稳定键重挂到新 id（否则锁/锚悬空、静默失效）。
    const oldSceneIdSnapshot = query('SELECT id, title, scene_number FROM scenes WHERE episode_id = ?', [episodeId])
    execute('DELETE FROM scenes WHERE episode_id = ?', [episodeId])
    let sceneNum = 0
    // 冷暖判定待办清单（2026-09-18）：与 episodes.js 同式，先在循环内收集，循环后统一判定。
    //   本处不在 SQLite 事务内（后台任务流程），但依然采用"先收集后判定"：
    //   避免在循环里逐条 await 让 N 个场景串行等待 N 次网络往返。
    const lightingQueue = []
    for (const s of assets.scenes) {
      sceneNum++
      const name = typeof s === 'string' ? s : (s.name || `场景${sceneNum}`)
      const description = typeof s === 'string' ? '' : (s.description || '')
      const propNames = typeof s === 'string' ? [] : (s.props || s.propNames || [])
      const old = oldSceneMap.get(name)
      // lightingEn：LLM 提取的英文光影常量；含中文一律丢弃（宁缺勿脏，与 buildAssetListPrompt 同判据）
      const llmLighting = typeof s === 'string' ? '' : String(s.lightingEn || '').trim()
      // 判据改用 shared.CJK_DIRTY_RE（R15）：原内联 [\u4e00-\u9fff] 只认表意文字，
      // 全角标点（「：」U+FF1A）会漏过闸门 → 脏字符串混进 lighting_en 英文常量。
      const llmLightingEn = llmLighting && !CJK_DIRTY_RE.test(llmLighting) ? llmLighting : ''
      // 最终生效的光照常量：旧值优先（重提取不抹掉手工维护的英文光影），与下方 INSERT 参数保持同式
      const finalLightingEn = old?.lighting_en || llmLightingEn || ''
      // 场景地点最终生效值：**显式带值优先**（`??`）——空串代表用户主动清空，用 `||` 会让清空失效。
      // LLM 提取结果可能是 snake_case（location_en），故双键兜底。
      const finalLocation = old?.location ?? (typeof s === 'string' ? '' : (s.location ?? s.location_en ?? '')) ?? ''
      // title_en / summary_en 最终生效值：**旧值优先**（`||`，与同函数道具分支 L432 及 episodes.js 同语义
      // 「重提取不抹掉手工维护的英文常量」）。LLM 提取结果可能是 snake_case，故双键兜底；s 可能是字符串。
      // 2026-09-18 修链：此前 INSERT 只读 old?.title_en / old?.summary_en，**完全丢弃** LLM 提取的
      // titleEn/summaryEn —— 首次提取（old 为空）后 scenes.title_en/summary_en 恒为空，出片 prompt
      // 资产名退化成 reference N / 中文名（ep4 段1 报错「<d> 标签外出现中文：雪山边界悬崖」的数据源）。
      const finalTitleEn = old?.title_en || (typeof s === 'string' ? '' : (s.titleEn || s.title_en)) || ''
      const finalSummaryEn = old?.summary_en || (typeof s === 'string' ? '' : (s.summaryEn || s.summary_en)) || ''
      const ins = execute(
        'INSERT INTO scenes (episode_id, scene_number, title, summary, image_url, prop_names, title_en, summary_en, lighting_en, location) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [episodeId, sceneNum, name, description, old?.image_url || '', JSON.stringify(propNames), finalTitleEn, finalSummaryEn, finalLightingEn, finalLocation]
      )
      // P3（2026-09-18 改造）：冷暖自洽校验改为 LLM 语义判定（原词表正则违反「零题材词表」铁律）。
      //   校验对象仍是 **finalLightingEn**（最终生效值）——旧值优先时 LLM 新暖调本就不生效，不该报。
      //   sceneId 取刚插入的行 id：告警必须带场景身份，否则前端按场景过滤的展示路径看不到它。
      lightingQueue.push({
        name,
        sceneId: Number(ins.lastInsertRowid) || null,
        sceneNumber: sceneNum,
        summary: description,
        lightingEn: finalLightingEn,
      })
    }
    // FIX-2（2026-09-18，P1-Q2）：场景重建完成 → 立刻重挂锁/锚的 scene_id（旧 id → 新 id）。
    // 放在 runLightingChecks 之前：重挂是纯 SQL 快操作，不该被 LLM 校验拖后。
    remapSceneReferencesAfterRebuild(episodeId, oldSceneIdSnapshot)
    // 循环外统一判定（await：本函数是后台任务，等待不阻塞任何用户请求；顺序执行避免并发打爆额度闸门）
    await runLightingChecks(lightingQueue, episodeId, recordAlert)
  }
  updateTask(taskId, { progress: 35, message: '资产提取完成' })
  // 一键流程的资产提取自 Step 1 新剧本，登记指纹
  execute('UPDATE episodes SET assets_script_fp = ? WHERE id = ?', [scriptHash(script), episodeId])

  // ===== Step 3: 生成分镜 =====
  updateTask(taskId, { progress: 40, message: '正在生成分镜脚本...' })
  const episode = queryOne('SELECT * FROM episodes WHERE id = ?', [episodeId])
  const project = queryOne('SELECT * FROM projects WHERE id = ?', [episode.project_id])
  // 给角色补 image_url（有参考图的角色，分镜 AI 不写外貌文字，交由参考图锁定）
  // 以落库后的数据为准：项目角色库可能已把形象/描述改写成主设定版本，直接用内存里的
  // LLM 原始提取结果会让分镜/视频 prompt 拿到与主设定不一致的描述
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
    // 英文常量（name_en/description_en，2026-09-17 补链）：落库值优先（含主设定合并结果），
    // LLM 提取结果兜底。此前只补 image_url/description，分镜 AI 的资产清单拿不到英文常量，
    // 只能自己改写英文 → 与出片 prompt 用的英文漂移（doubao.js buildAssetListPrompt 消费这些键）
    const nameEn = saved?.name_en || (typeof c === 'string' ? '' : (c.nameEn || c.name_en)) || ''
    const descriptionEn = saved?.description_en || (typeof c === 'string' ? '' : (c.descriptionEn || c.description_en)) || ''
    return typeof c === 'string'
      ? { name: c, description, name_en: nameEn, description_en: descriptionEn, image_url: imageUrl }
      : { ...c, description, name_en: nameEn, description_en: descriptionEn, image_url: imageUrl }
  })
  // 场景/道具同样补 image_url（有参考图的场景/道具，分镜 AI 不写外观文字）；
  // 英文常量（title_en/summary_en/lighting_en/name_en/description_en）与 owner 同步补链（2026-09-17）
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
  // 分镜必须复用 Step 2 已提取的资产，禁止 AI 再从剧本重新提取，避免两边错乱
  // 进度上报（2026-09-15）：一键流程走到分镜阶段时，分镜页/前端轮询同样能看到"第几场/共几场"
  const storyboard = await generateStoryboard(script, project?.art_style || config.defaultArtStyle, assets, {
    targetDuration: options.targetDuration,
    onProgress: makeReporter(episodeId, SB_TASK.GENERATE),
  })

  // 兜底：AI Prompt/finalFrame 里 @ 提到的资产强制并入关联数组，
  // 防止 Airlock 继承的在场角色被漏登记导致生图缺参考图
  backfillStoryboardAssets(storyboard, assets)

  // 新分镜生成后必须重新审核，不能沿用旧确认状态
  execute('UPDATE episodes SET storyboard_confirmed = 0 WHERE id = ?', [episodeId])
  // 一键流程的分镜提取自 Step 1 新剧本，登记指纹
  execute('UPDATE episodes SET storyboard_script_fp = ? WHERE id = ?', [scriptHash(script), episodeId])

  // 保存分镜到数据库：删旧插新整段包进事务，中途失败整体回滚，
  // 避免出现「旧分镜已删、新分镜只插了一半」的中间态（历史数据被清且不可恢复）
  const shotIds = transaction(() => {
    const oldScenes = query('SELECT id FROM storyboard_scenes WHERE episode_id = ?', [episodeId])
    for (const s of oldScenes) {
      execute('DELETE FROM shots WHERE storyboard_scene_id = ?', [s.id])
    }
    execute('DELETE FROM storyboard_scenes WHERE episode_id = ?', [episodeId])

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
          `INSERT INTO shots (storyboard_scene_id, shot_number, duration, description, characters, scene_assets, prop_assets, shot_type, start_time, end_time, action_note, sound_effects, dialogue, camera_movement, overall_soundscape, non_diegetic_music, integrated_multimodal_description, final_frame, is_combat, camera_angle)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            // 写侧统一（null/undefined → ''，不再可能产出 "null" 脏值）
            serializeDialogue(shot.dialogue),
            shot.cameraMovement || '',
            shot.overallSoundscape || '',
            shot.nonDiegeticMusic || '',
            shot.integratedMultimodalDescription || '',
            shot.finalFrame || '',
            // 戏型：AI 标注优先，缺失时按镜头内容自动判定（换任何剧本都通用）
            shot.isCombat === true || shot.isCombat === false
              ? (shot.isCombat ? 1 : 0)
              : (classifyShotCombat(shot) ? 1 : 0),
            // 机位朝向：AI 标注（normalize 已做六选一校验）优先，缺失落 '' 走出片时语义推断
            shot.camera_angle || shot.cameraAngle || '',
          ]
        )
        ids.push(shotResult.lastInsertRowid)
      }
    }
    return ids
  })
  // 分镜已整体重建（旧镜全删、镜号重排）→ 该集的人工忽略记录一并作废，
  // 否则旧忽略会静默屏蔽"恰好同镜号 + 同 code"的新问题（面板看着干净，实际漏检）。
  clearQcIgnores(episodeId)
  updateTask(taskId, { progress: 50, message: '分镜脚本生成完成' })

  // 汇总资产设定描述，拼进每个镜头的生图/生视频 prompt，保证角色/场景/道具跨图一致
  // 读时主设定合并：与视频 prompt 同源，避免分镜生图拿到主设定更新前的旧描述
  const assetIndex = new Map()
  for (const c of mergeMasterIntoEpisodeCharacters(
    query('SELECT id, name, description, project_character_id FROM characters WHERE episode_id = ?', [episodeId])
  )) {
    if (c.description) assetIndex.set(c.name, `角色「${c.name}」：${c.description}`)
  }
  for (const sc of query('SELECT title, summary FROM scenes WHERE episode_id = ?', [episodeId])) {
    if (sc.summary) assetIndex.set(sc.title, `场景「${sc.title}」：${sc.summary}`)
  }
  for (const p of query('SELECT name, description FROM props WHERE episode_id = ?', [episodeId])) {
    if (p.description) assetIndex.set(p.name, `道具「${p.name}」：${p.description}`)
  }
  function buildShotAssetBrief(shot) {
    try {
      const names = [
        ...JSON.parse(shot.characters || '[]'),
        ...JSON.parse(shot.scene_assets || '[]'),
        ...JSON.parse(shot.prop_assets || '[]'),
      ]
      const parts = names.map((n) => assetIndex.get(n)).filter(Boolean)
      if (!parts.length) return ''
      return `。画面要素必须严格遵循以下设定：【${parts.join('；')}】`
    } catch {
      return ''
    }
  }
  // 镜头站位图调度（结构化 JSON），注入视频 prompt 的 Blocking 行；无站位图时为 null 不注入
  function parseShotBlocking(s) {
    try { return s.blocking_plan ? JSON.parse(s.blocking_plan) : null } catch { return null }
  }
  // 画风统一：从风格库按项目风格名取完整画风 prompt（与前端生图同源同强度），
  // 一键 pipeline 与手动生图注入完全一致的画风，避免两条链路风格漂移
  let stylePromptText = project?.art_style || ''
  try {
    if (stylePromptText) {
      const sp = queryOne('SELECT prompt FROM style_presets WHERE label = ? LIMIT 1', [stylePromptText])
      if (sp?.prompt) stylePromptText = sp.prompt
    }
  } catch { /* 风格库缺失时退回风格名 */ }
  const stylePrefix = stylePromptText ? `${stylePromptText}，` : ''
  const styleGuard = project?.art_style
    ? `。【画风统一约束】整幅画面严格统一为「${project.art_style}」画风，线条、上色、光影、质感与上述画风描述完全一致，禁止偏离画风`
    : ''

  // ===== Step 4: 故事板图片生成已下线 =====
  // 历史 Step4 用 generateImage 文生图批量生成「故事板图」（存 storyboard_url 字段），
  // 现已被「分镜图」（frame_url，带角色/场景参考图的多图生图）取代——
  // 前端走单独 /image 端点按需触发，不再在一键流程里批量生成。
  // 删除此步骤后，进度直接对齐 Step5。
  const failedImageCount = 0
  // ===== 完成 =====
  // 失败可见性：所有镜头图/视频全部失败时标记任务失败，否则完成但消息带上失败计数
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

// AI 改稿助手：局部改写选中段落（只返回改写后的段落，不落库、不改其他内容）
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

// 单独生成剧本 / 定点修改剧本 / 整本整理重写
// mode='auto'（前端已有剧本时的默认值）→ 由后端模型按语义分类 revise/rewrite/generate，
//   替代前端正则分流（"把男生重写成布布"命中"重写"却只是改名，正则会误判成整本整理）
// mode='revise' → 定点修改：基准是前端实时传来的正文（context），不是数据库旧副本——
//   用户粘贴/手动编辑后可能尚未保存，按旧文本修改会把用户眼前的内容整体冲掉；
//   模型只输出 [find/replace]/[replaceAll]/[append]/[insertAfter] 编辑指令，剧本在本地拼装。
//   声明"表达不了"（needFullRewrite）时自动转整本整理。
//   定点修改不直接落库：结果回前端走 diff 预览，用户接受后才生效。
// mode='rewrite' → 整本整理/重写（格式重组、统一场景等全文性操作），prompt 约束保留台词原意。
// 其余情况整本重新生成（AI 生成稿的格式兜底在此内部完成）
router.post('/script', async (req, res) => {  const { episodeId, prompt, context = '', mode = '' } = req.body
  if (!episodeId || !prompt) return res.status(400).json({ error: 'episodeId 和 prompt 必填' })

  try {
    const current = queryOne('SELECT script_content FROM episodes WHERE id = ?', [episodeId])

    let script
    let outMode = mode === 'revise' || mode === 'rewrite' || mode === 'generate' ? mode : 'auto'
    if (outMode === 'auto') {
      // 意图分类：一次轻量调用（temperature 0 / maxTokens 100），失败兜底为 revise
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
      // 定点修改 → 编辑指令本地拼装；模型声明"表达不了"时自动转整本整理
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
        // 常见失败：模型复制 find 时改动了字词导致定位不到。带错误信息重试一次
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
          // 诊断落盘：模型到底输出了什么指令，方便定位是 prompt 问题还是数据问题
          try {
            fs.mkdirSync(tasksDir, { recursive: true })
            fs.writeFileSync(
              path.join(tasksDir, `revise-fail-${episodeId}-${Date.now()}.json`),
              JSON.stringify({ instruction: prompt, error: e2.message, edits: lastEdits }, null, 2),
              'utf8'
            )
          } catch { /* 诊断落盘失败不影响主流程 */ }
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
      // 纯生成：先从资产定位出场角色（前端确认过则用传来的 characterIds），
      // 高置信注入形象设定，让剧本直接用上资产库里的角色
      const assetContext = await buildAssetContextForPrompt(prompt, episodeId, req.body.characterIds)
      const rawScript = await generateScript(prompt, context, assetContext)
      // 格式兜底：模型偶发不按「场次N：标题」输出时自动归一化
      const { text } = await ensureStandardScript(rawScript, { episodeId })
      script = text
    }

    // 定点修改不落库：结果回前端走 diff 预览，用户点「接受」才生效（与选中改写一致），
    // 避免"用户回退了改动、库里却已是被改过的版本"的不一致
    if (outMode === 'revise') {
      return res.json({ success: true, script, mode: outMode, changed: script !== String(context || '') })
    }

    // 只保存剧本内容，不自动确认，让用户手动点确认后弹出风格选择
    // 剧本实质变化后旧分镜不可信、且新剧本必须重新走人工确认：
    // 与 PUT /episodes/:id/script 对齐，重置 storyboard_confirmed 和 script_confirmed
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

// 单独提取资产
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

  // 如果没传 style，从 project 表取 art_style
  let artStyle = style
  if (!artStyle) {
    const project = queryOne('SELECT art_style FROM projects WHERE id = ?', [episode.project_id])
    artStyle = project?.art_style || ''
  }

  try {
    const assets = await extractAssets(episode.script_content, artStyle)
    // 结构防御：AI 偶发返回非数组（对象/字符串/null）时统一 coerce 成数组，
    // 防止非数组透传给 replaceEpisodeCharacters/落库循环清空资产表
    assets.characters = Array.isArray(assets.characters) ? assets.characters : []
    assets.props = Array.isArray(assets.props) ? assets.props : []
    assets.scenes = Array.isArray(assets.scenes) ? assets.scenes : []
    // 三类全空说明提取结果不可用：直接拒绝，不落任何资产和指纹
    if (!assets.characters.length && !assets.props.length && !assets.scenes.length) {
      return res.status(500).json({ error: 'AI 未提取到任何资产，请重试' })
    }
    // 去重（大模型偶发会重复提取同名道具/角色/场景）
    assets.characters = dedupeAssets(assets.characters, (c) => (typeof c === 'string' ? c : c.name))
    assets.props = dedupeAssets(assets.props, (p) => (typeof p === 'string' ? p : p.name))
    assets.scenes = dedupeAssets(assets.scenes, (s) => (typeof s === 'string' ? s : s.name))
    filterFurnitureProps(assets)
    // 指纹不再在此登记：提取后资产是否真正落库要靠前端再调保存接口，
    // 若此处就写指纹，用户提取后放弃保存会让 stale 判定永久假阴性。
    // 改为把指纹回传前端，由前端在三类资产全部保存成功后调 extract-info 端点登记
    res.json({ success: true, assets, scriptFp: scriptHash(episode.script_content) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// 补全分镜缺失的 integrated_multimodal_description（本地导入的分镜只有 description 时使用）。
// onlyMissing=true 时跳过已有提示词的镜头（外部 AI 已写好的内容不覆盖、不重复计费），只补缺失的
router.post('/enrich-storyboard', async (req, res) => {
  const { episodeId, onlyMissing = false } = req.body
  if (!episodeId) return res.status(400).json({ error: 'episodeId 必填' })

  const episode = queryOne('SELECT * FROM episodes WHERE id = ?', [episodeId])
  if (!episode) return res.status(404).json({ error: '集不存在' })
  const project = queryOne('SELECT art_style FROM projects WHERE id = ?', [episode.project_id])

  const characters = mergeMasterIntoEpisodeCharacters(
    query('SELECT name, name_en, description, description_en, image_url, project_character_id FROM characters WHERE episode_id = ?', [episodeId])
  )
  // 与 /storyboard 主路由同形（title_en/summary_en/lighting_en/prop_names 全带）：
  // enrich 的资产清单走同一个 buildAssetListPrompt 消费端，字段缺了 = 单镜增强时英文常量/光影/关联道具静默丢失
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
  // 并行补全（2026-09-15）：镜头间零依赖，用 worker 池并发跑，40+ 镜从 7~13 分钟降到约 2~3 分钟。
  // 并发数见 config.storyboard.enrichConcurrency（env ENRICH_CONCURRENCY）；
  // chatCompletion 自带 LLM_MAX_CONCURRENT 闸门兜底防 429。
  // 单镜重试策略不变（最多 3 次、间隔 3s/6s 错峰），计数与 errors 结构与旧串行版一致（响应格式不变）。
  const ENRICH_CONCURRENCY = config.storyboard?.enrichConcurrency || 4
  // 进度上报（2026-09-16）：补全是 worker 池并行跑，用共享计数器汇报"已完成/总数"。
  // 只算真正处理过的镜头（含跳过/失败），保证进度单调递增到 total，不会卡在 99%。
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
        // 读侧统一：脏值 / 'null' / '' 一律得 []；空时对 AI 传 null（与改前形状一致）
        dialogue: (() => {
          const lines = parseDialogue(shot.dialogue)
          return lines.length ? lines : null
        })(),
        actionNote: shot.action_note || '',
      }
      // 每个镜头最多重试 2 次（LLM 限流时等一下再试）
      let lastErr = null
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (attempt > 0) {
            // 重试间隔递增：3s, 6s
            await new Promise(r => setTimeout(r, 3000 * attempt))
          }
          const integrated = await enrichShotIntegrated(shotForAI, assets, project?.art_style || config.defaultArtStyle, { directorNotes: episode.director_notes || '' })
          if (integrated) {
            // 回填 final_frame（2026-09-15）：从 imd 的模块6【最终画面】解析写入——
            // 导入分镜此前 final_frame 全空，越轴 / Airlock 检查对它们等于空转；已有值不覆盖。
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
  // 补全阶段结束，切到越轴巡检阶段（若有）。先报一次，避免补全 100% 后长时间无更新像卡死。
  reportProgress(episodeId, SB_TASK.ENRICH, {
    phase: PHASE.AXIS,
    done: shots.length,
    total: shots.length,
    message: '补全完成，正在做越轴巡检…',
  })

  // 补全后越轴巡检（2026-09-15）：补全刚写入 final_frame，越轴检查这才有数据可查。
  // 只改"侧位翻转且无走位交代"的镜头（补模块4 走位），失败保留原稿、绝不影响补全结果。
  // 闭环复检（2026-09-16）：修补后回头再验，未修好的落 system_alerts，由质检面板明示。
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
    // 别名映射（name_en / aliases）：模型常写英文名，只拿中文名清单查侧位会让这批镜头
    // 整段跳过越轴检查（实测 EP4 5/40）。与 storyboardValidator 的 QC 侧位检查同口径。
    const aliasMap = buildAliasMap(characters)
    const axisRes = await fixAxisFlips(sceneList, charNames, project?.art_style || config.defaultArtStyle, aliasMap)
    for (const sh of axisRes.repairedShots || []) {
      execute('UPDATE shots SET integrated_multimodal_description = ? WHERE id = ?', [sh.integratedMultimodalDescription, sh.id])
      axisFixed++
    }
    axisFailed = axisRes.failed || 0
    axisUnresolved = axisRes.unresolved || []
    // 越轴未修复 → 落告警（与出片链的 system_alerts 同一张表，前端角标可见）
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

// 分镜提取进度（2026-09-16 改用 ai/progressBus 统一承载）：
// 旧实现是路由内的单 Map（key=episodeId），一集同时跑两个任务会互相覆盖。
// 现在按 (episodeId, task) 双键隔离，三条路径各报各的，前端一次轮询取"最值得展示的那个"。
// 前端轮询入口：活跃时返回 active=true + 结构化进度，空闲返回 active=false。
// task 参数可选——不传时返回该集最活跃（或最近结束）的任务，兼容旧调用。
router.get('/storyboard-progress', (req, res) => {
  const { episodeId, task } = req.query
  if (!episodeId) return res.json({ active: false })
  const payload = task
    ? getProgress(episodeId, task)
    : getActiveProgress(episodeId)
  if (!payload) return res.json({ active: false })
  // 保留 message 字段（旧前端只读它），同时给出结构化明细供进度条渲染
  res.json({ ...payload, active: payload.active !== false })
})

// 调试用：列出某集全部任务进度（多任务并跑时排查"进度条显示的是谁"）
router.get('/storyboard-progress-all', (req, res) => {
  const { episodeId } = req.query
  if (!episodeId) return res.status(400).json({ error: 'episodeId 必填' })
  res.json({ list: listProgress(episodeId) })
})

// 单独生成分镜
router.post('/storyboard', async (req, res) => {
  const { episodeId, targetDuration } = req.body
  if (!episodeId) return res.status(400).json({ error: 'episodeId 必填' })

  try {
    assertScriptConfirmed(episodeId)
    assertNotStale(episodeId, 'assets')
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message })
  }

  const episode = queryOne('SELECT * FROM episodes WHERE id = ?', [episodeId])
  if (!episode?.script_content) return res.status(400).json({ error: '请先生成剧本' })

  const project = queryOne('SELECT * FROM projects WHERE id = ?', [episode.project_id])

  // 从项目资产库读取已确认资产，强制分镜复用，禁止 AI 从剧本重新提取
  // 角色带 image_url：分镜 AI 据此判断该角色是否有参考图（有图则不写外貌文字，交由参考图锁定）
  // 读时主设定合并：分镜 AI 拿到的必须是项目角色库的最新形象，而不是旧副本
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
      // 进度上报（2026-09-15）：ai 层通过回调汇报"第几场/共几场"，本层直接转发到进度总线
      onProgress: makeReporter(episodeId, SB_TASK.GENERATE),
    })
    // 兜底：@ 提到的资产强制并入关联数组，前端展示与后续落库都拿到修正后的结果
    backfillStoryboardAssets(storyboard, assets)
    // 指纹不再在此登记：分镜生成后是否真正落库要靠前端调保存接口，
    // 此处写指纹会让"生成后放弃保存"出现 stale 假阴性。改由保存端点登记
    res.json({ success: true, storyboard, unmatched: storyboard.unmatched || [] })
    ok = true
  } catch (err) {
    res.status(500).json({ error: err.message })
  } finally {
    // 终态保活：进度总线内部按 TTL 保留一段时间，让前端最后一次轮询读到收尾结论
    finishProgress(episodeId, SB_TASK.GENERATE, {
      phase: PHASE.DONE,
      done: 1,
      total: 1,
      message: ok ? '分镜生成完成' : '分镜生成已结束',
    })
  }
})

// 分镜文件规整：把"已经是分镜"的内容（表格/Markdown/纯文本）交给规整型 LLM 提取为标准镜头结构。
// 与 /storyboard（从剧本创作分镜）对立，本路由不要求 episode 有剧本，也不要求 assets 已确认之外的其他前置。
router.post('/storyboard-from-file', async (req, res) => {
  const { episodeId, fileContent } = req.body
  if (!episodeId) return res.status(400).json({ error: 'episodeId 必填' })
  if (!fileContent || !String(fileContent).trim()) return res.status(400).json({ error: 'fileContent 不能为空' })

  try {
    assertNotStale(episodeId, 'assets')
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message })
  }

  const episode = queryOne('SELECT * FROM episodes WHERE id = ?', [episodeId])
  if (!episode) return res.status(400).json({ error: 'episode 不存在' })

  const project = queryOne('SELECT * FROM projects WHERE id = ?', [episode.project_id])

  // 复用创作型相同的资产读取，强制规整结果里的资产名对齐到项目资产库
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

  // 进度上报（2026-09-16）：文件规整是单次长 LLM 调用（可能含一次解析重试），
  // 主耗时集中在"规整中"这一段且无法细分——用不定量（total=0）进度 + 阶段文案表达，
  // 前端显示为流动条 + "正在规整…（已用 1 分 20 秒）"，避免"卡住了吗"的焦虑。
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
    })
    // 兜底：@ 提到的资产强制并入关联数组
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
