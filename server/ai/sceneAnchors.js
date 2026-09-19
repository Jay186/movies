// 视觉锚点集系统 v2（2026-09-16，LLM 驱动）
//
// 解决什么问题：场景图独立生成导致"同一座桥画成两个样"——
// 场景2 不知道场景1 长什么样，文字提示词管不住 AI 的自由发挥。
//
// 方案：锚点集（Anchor Set），松耦合星型结构——
//   空间锚：同一物理空间的不同视角（崖顶/谷底/对岸），生成时互相参考
//   道具锚：跨场出现的同一物体（桥/船/门），首次定稿后全程参考
//
// 通用性硬约束（为什么用 LLM 而不是词表/正则）：
//   "哪些场景是同一空间""哪些物体跨场共享"是语义判断，任何手写规则都会
//   被下一个剧本打破（"断桥"的"断"是动词还是名字？"崖下"是场景位置还是
//   场景里的景物？）。本项目本来就有 LLM 资产提取，同样用 LLM 做一次性
//   分析并落库缓存——代码里零词表、零正则，换题材/换语言都不用改代码。
//
// 数据流：
//   资产生成（场景有 title/summary）
//     → ensureSceneAnalysis：LLM 一次性分析全集，缓存进 scene_analysis（指纹失效自动重析）
//     → 场景图生成时 buildAnchorRefsForScene：查库取参考图（纯 SQL，无 LLM）
//     → 生成成功后 registerSceneAnchors：把定稿图登记为锚点（纯 SQL）
//
// 降级原则：LLM 失败/未配置 → 无锚点出图（行为同旧版），绝不阻断生成。

import crypto from 'crypto'
import { query, queryOne, execute } from '../db.js'
import { chatCompletion } from './doubao.js'
import { config } from '../config.js'
import { recordAlert } from './alerts.js'
import { ASSET_TYPES } from './assetTypes.js'
import { SCENE_ANCHOR_TYPE, PROP_ANCHOR_TYPE, SPATIAL_ANCHOR_TYPE, LAYOUT_ANCHOR_TYPE, LAYOUT_ANCHOR_HINT, parseElementList } from './anchorTypes.js'
// 分组人审锁定（2026-09-17）：spatial_group 是 LLM 逐次自由裁量的产物，
// 重析会把已验证的组结构重组（实测 4 组→2 组），使已确认的组锚静默变孤儿。
// 锁把"某场归某组"固化成人审数据，重析时复用 → 见 ai/sceneGroupLock.js 头部。
import { loadGroupLocks, applyGroupLocks, getGroupLockOverview } from './sceneGroupLock.js'
import {
  buildAnchorKey, stripStateSuffix, scanOrphanStates, resolveState, displayLabel,
} from './assetState.js'
// 道具名跨层归一（2026-09-18，P1-Q1）：scene_analysis.props_json 用的是场景分析 LLM 的名字，
// 可能与 props 表名不一致（ep4 实证「断桥」vs「腐朽木桥」）。登记锚前先归一到 props 表名，
// 否则下游按表名精确匹配会拿不到该道具的参考图。判据单点在 ai/propNameMatch.js（纯函数）。
// buildPropLexiconHint：FIX-8 根因修复——把本集已有道具清单注入场景分析 prompt，从源头统一命名。
import { resolvePropName, buildPropLexiconHint } from './propNameMatch.js'

// 道具类型键（从共享常量取，避免字面量散落）
const TYPE_PROP = ASSET_TYPES.includes('prop') ? 'prop' : ASSET_TYPES[ASSET_TYPES.length - 1]

// 单个场景生成时最多带几张锚点参考图（参考图过多会稀释主描述，模型也吃不下）
const MAX_SPATIAL_REFS = 2
const MAX_PROP_REFS = 2

// A1/A2 清单上限（2026-09-17）：要素句会挤占画面描述的注意力预算，故设硬上限。
// 与 analyzeWithLlm 提示词里的"最多 5 条 / 最多 6 条"一致；超出部分在 validateAnalysis 里丢弃。
// 超量丢弃而非报错：LLM 偶尔多吐一条，不值得让整次分析失败（降级铁律）。
const MAX_ELEMENT_COUNT = 5
const MAX_SHARED_ENV_COUNT = 6

const bareUrl = (u) => String(u || '').split('?')[0].trim()

// 组锚（人审基准图，第 3 层）提示词：与 P0-6 修复口径对齐（空间结构/光照方向以锚图为准；
// 视角/构图与时段/天气/色温以文字描述为准）。由 buildAnchorRefsForScene 在命中 manual+confirmed spatial 锚时 push。
// 不写「参考图1」——redraw 分支里参考图1 是本场旧图，组锚排其后；索引声明会错。
//
// ⚠️ 2026-09-17 视角塌陷修复（本文件最重要的口径约定，改前必读）：
//   原口径把「构图」与「空间结构/光照方向」并列为必须继承项，实测导致 cliff_river 组
//   场1/场2/场3 全部输出成同一个崖顶俯视机位——同一空间的不同视角是空间组存在的唯一意义，
//   而「构图必须连续」恰好把这件事抹掉了。模型面对「构图要连续」只能照抄基准图机位。
//   现口径把继承项收敛为「空间结构 / 地标形态与相对位置 / 光照方向」这三项**真该跨视角连续**的
//   空间事实，并显式豁免「视角 / 机位高度 / 景别 / 画面主体占比」——这四项由本场描述支配。
//   同步契约：server/ai/sceneAnchorPrompt.js 的 PLAIN_ANCHORED 必须同口径（两层加强，改一处等于没改）。
const GROUP_ANCHOR_HINT =
  '本空间的「人审基准图」已作为参考图提供：本场景与基准图是同一物理空间，' +
  '空间结构、地标物体的形态与相对位置、光照方向必须与基准图连续；' +
  '但视角、机位高度、景别与画面主体占比一律以本场景文字描述为准，严禁照搬基准图的构图；' +
  '时段、天气、色温同样以本场景文字描述为准'

// ===================================================================
// 资产状态接入（P2'，2026-09-17）—— 判据全部委托 ai/assetState.js（单点，铁律 2）
// ===================================================================

/**
 * 读某道具的全部状态行（asset_states，asset_type='prop'，业务键=裸名）。
 * 机制关闭 / 表不存在 / 异常 → 返回 []（消费侧据此走默认态 = 改造前行为）。
 */
function loadPropStateRows(propName) {
  if (!config.assetState?.enabled) return []
  const name = String(propName || '').trim()
  if (!name) return []
  try {
    return query(
      `SELECT id, state_key, label_zh, description, description_en, image_url, is_default
       FROM asset_states WHERE asset_type = ? AND asset_key = ?`,
      [TYPE_PROP, name]
    )
  } catch (e) {
    console.warn(`[sceneAnchors] 读资产状态失败（降级为默认态）: ${e.message}`)
    return []
  }
}

/**
 * 某道具在某场应处于的状态键（默认态返回 assetState 的裸名语义键 'intact'）。
 * 无状态行 / 机制关闭 → 返回 ''（调用方 buildAnchorKey(name,'') 即得裸名，锚点键不变）。
 * 注：场景图生成阶段没有"镜头级"状态（状态挂 shot），故此处取该道具的**默认态/完好态**，
 *     仅用于锚点键后缀的稳定拼装；镜头级状态注入在出片链路（generate-video.js）完成。
 */
function defaultPropStateKey(propName) {
  const rows = loadPropStateRows(propName)
  if (!rows.length) return ''
  const def = rows.find((r) => Number(r.is_default) === 1) || rows[0]
  return String(def?.state_key || '')
}

// 生成"某道具在第 6 段生命周期内应处的状态"的提示词后缀（语言中立的英文约束；无状态→空串）
function stateHintFor(propName) {
  const rows = loadPropStateRows(propName)
  if (!rows.length) return ''
  const def = rows.find((r) => Number(r.is_default) === 1) || rows[0]
  const st = resolveState(def?.state_key, rows)
  if (!st.resolved) return ''
  const label = displayLabel(st.stateKey, st.labelZh)
  return `道具「${propName}」本场应处于「${label}」状态` +
    (st.descriptionEn ? `（${st.descriptionEn}）` : '') +
    `，其形态、颜色、材质与破损程度必须与该状态一致`
}

// ===== 场景指纹 =====
// 全集场景的 id+标题+描述 的 md5。任何一场改动（重提资产/改描述/增删场）
// 指纹都变，触发重析。按"集"缓存，不按"场"——空间分组是全局判断。
// 2026-09-17 导出：episodes.js 保存场景后的「纯删除快速通道」复用同一算法顺延指纹，
// 两处必须同源，否则顺延值与 ensureSceneAnalysis 的重算值不一致 = 白顺延。
export function fingerprintOf(scenes) {
  const h = crypto.createHash('md5')
  for (const s of scenes) h.update(`${s.id}${s.scene_number}${s.title}${s.summary}#`)
  return h.digest('hex')
}

// ===== LLM 一次性分析 =====
// 输入全集场景（编号/标题/环境描述），输出：
//   每场 → 空间组（同组=同一物理空间）+ 组内视角 + 本场出现的共享道具
//          + A1 本场要素清单 + A2 组内共享环境特征
//   全集 → 共享道具清单（跨≥2场、外观必须一致的有形物体）
//
// A1/A2 为什么也交给 LLM（而不是代码扫描摘要）：判断"清晨浓雾"是不是本场要素、
//   组内哪些环境特征该共享，都是语义判断。写词表/正则会立刻被下一个剧本打破。
// 与既有分析**同一次调用**完成（不额外烧一次 LLM）：这批场景原文本来就要全读一遍。
async function analyzeWithLlm(scenes, episodeId) {
  const sceneList = scenes
    .map((s) => `【场景${s.scene_number}】(scene_id=${s.id}) ${s.title}\n${s.summary || '（无描述）'}`)
    .join('\n\n')

  // FIX-8（2026-09-18）根因修复：把本集 props 表**已有道具名**注入 prompt，作为第 3 条
  // （shared_props）的子约束。此前 prompt 只要求"场景 props 名与 shared_props 一致"（**仅内部
  // 自洽**），从未告知 LLM 已有道具名 → LLM 自由起名（ep4 实证：场景分析产出「断桥」，而
  // props 表是「腐朽木桥」）→ 道具锚成孤儿、下游按表名匹配落空。修消费端只是打补丁，根因在此。
  // 清单为空 → hint 为 ''，插值即**无任何改动**（逐字保持改造前 prompt）。
  // 通用性：清单来自数据库（只读查询），零题材词表/零同义词表。
  // ⚠️ 本改动**只有重跑场景分析才生效**（指纹不变时 ensureSceneAnalysis 命中缓存）。
  const propLexiconHint = buildPropLexiconHint(
    query('SELECT name FROM props WHERE episode_id = ?', [episodeId]).map((r) => r.name)
  )

  const messages = [
    {
      role: 'system',
      content: '你是影视美术统筹，负责跨镜头的视觉连续性资产管理。只输出 JSON，不要输出任何解释。',
    },
    {
      role: 'user',
      content:
        `以下是同一集的全部场景（编号/标题/环境描述）：\n\n${sceneList}\n\n` +
        `请完成视觉连续性分析：\n` +
        `1. spatial_group：把发生在同一物理空间的场景归为同组，组名用简短英文 snake_case（如 cliff_river、palace_hall）。\n` +
        `   判断标准：站在一处能互相看见、或同一地点的不同视角/不同高度/内外关系，都算同组；剧情上完全无关的地点各自成组。\n` +
        `   每个场景都必须有组名（独立空间也要给唯一组名），不允许为空。\n` +
        `2. spatial_role：每个场景在其组内的具体位置或视角，用中文短语（如"崖顶俯视谷底""谷底浅滩仰视"）。\n` +
        `3. shared_props：全集中**在 2 个及以上场景重复出现、外观必须保持一致**的具体有形物体（如桥、船、门、马车、古树）。\n` +
        `   只列有形物体，不列天气/光照/水面等泛化环境；名字用简短中文（2~6 字）。\n` +
        propLexiconHint +
        `4. 每个场景的 props：该场景描述中实际出现的、属于 shared_props 的物体，名称必须与 shared_props 完全一致。\n` +
        `5. 每个场景的 elements：**该场景描述里明文写了、且必须在画面上看得见**的要素，用 2~6 字中文短语，\n` +
        `   按重要性排序，最多 5 条（如"清晨浓雾""冰面浮冰""两截朽桥""石阶栈道"）。\n` +
        `   只列**描述里真实写了的**，严禁推断或补充；描述没提的一律不得列入。\n` +
        `   判断标准：一条要素若在画面中缺失，这场景就画错了 —— 只有这样的才列。\n` +
        `   ⚠️ **天气与大气现象只要写了就必须列**（雾/云/雨/雪/风/水汽/天光/日晒/光线）：\n` +
        `   这类词最容易被当成"只是氛围"而被省略，而它们恰恰是最常丢的——描述写了雾，就必须画得出雾。\n` +
        `   ⚠️ 描述里写了**具体数量或形态**的，要连形态一起写进短语（"断了一半斜挂"→"半截斜挂的断桥"，\n` +
        `   "水流挤在乱石堆里翻着白花"→"乱石堆翻白花"）——只写"桥"等于把形态信息丢了。\n` +
        `6. 每组（spatial_group）的 shared_env：**同组所有场景共享**的环境特征，用 2~8 字中文短语，最多 6 条。\n` +
        `   从组内各场描述的交集与空间常识中提取属于该地点本身的稳定特征：植被、地质、水体、色调倾向、标志性地形。\n` +
        `   只写"这个地方长什么样"，不写只在某一场出现的天气/时段，不写可移动道具（那些归 shared_props）。\n` +
        `   ⚠️ 判断"是否共享"看的是**这个地点本身有没有**，不是"每场都写了没有"：\n` +
        `   某场若明确写了"这里没有雾"（如"谷底无雾"），说明雾是该地点的**局部现象**，不得进组卡；\n` +
        `   而植被/地质这类实存特征，哪怕某一场的描述只字未提，也照样进组卡——\n` +
        `   某场没提不代表那个地方没有，那一片山崖不会因为某一镜没写就没有松林。\n` +
        `   举例：某组是冰河峡谷，则"灰白砾石滩""半山松林""冷蓝色调"都应列出——它们属于该地点，不随场次改变。\n\n` +
        `输出 JSON（严格遵守此结构）：\n` +
        `{"scenes":[{"scene_id":数字,"spatial_group":"...","spatial_role":"...","props":["..."],"elements":["..."]}],` +
        ` "shared_props":["..."],"shared_env":{"组名":["..."]}}`,
    },
  ]

  const text = await chatCompletion(messages, {
    responseFormat: { type: 'json_object' },
    temperature: 0.2,
    maxTokens: 4000,
    usageContext: { task: 'scene_anchor_analysis', episodeId },
  })

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    // json_object 模式下仍可能截断/夹杂文本，取第一个 {...} 块兜底
    const m = text.match(/\{[\s\S]*\}/)
    if (!m) throw new Error('LLM 场景分析返回非 JSON')
    parsed = JSON.parse(m[0])
  }
  return validateAnalysis(parsed, scenes)
}

// ===== 分析结果校验与归一化 =====
// 不信任 LLM 输出的完备性：scene_id 必须真实存在；道具名取并集（LLM 漏列 shared_props
// 但在场景 props 里写了的，并回来）；缺行的场景补空行（无锚点，不影响生成）。
// A1/A2：elements / shared_env 同样只做「清洗 + 限量 + 去重」，不做语义筛选——
//   一个短语该不该出现是 LLM 判的，代码只保证它不会污染 prompt（脏 JSON / 长句 / 空项）。
function validateAnalysis(parsed, scenes) {
  const validIds = new Set(scenes.map((s) => s.id))
  const rows = []

  // 道具名全集 = shared_props ∪ 各场景 props（LLM 两边写得不一致时以并集为准）
  const propSet = new Set()
  if (Array.isArray(parsed?.shared_props)) {
    for (const p of parsed.shared_props) {
      const name = String(p || '').trim()
      if (name) propSet.add(name)
    }
  }
  if (Array.isArray(parsed?.scenes)) {
    for (const r of parsed.scenes) {
      if (!Array.isArray(r?.props)) continue
      for (const p of r.props) {
        const name = String(p || '').trim()
        if (name) propSet.add(name)
      }
    }
  }

  for (const r of Array.isArray(parsed?.scenes) ? parsed.scenes : []) {
    const sceneId = Number(r?.scene_id)
    if (!validIds.has(sceneId)) continue
    rows.push({
      scene_id: sceneId,
      spatial_group: String(r?.spatial_group || '').trim(),
      spatial_role: String(r?.spatial_role || '').trim(),
      props: (Array.isArray(r?.props) ? r.props : [])
        .map((p) => String(p || '').trim())
        .filter((p) => p && propSet.has(p)),
      // A1 本场要素清单（limit 5 —— 与 prompt 里的 prompt 长度预算对齐，超出部分丢弃）
      elements: parseElementList(JSON.stringify(Array.isArray(r?.elements) ? r.elements : [])).slice(0, MAX_ELEMENT_COUNT),
    })
  }
  // 缺行补空：LLM 漏掉的场景降级为"无空间组、无道具、无要素"，不阻断流程
  for (const s of scenes) {
    if (!rows.some((r) => r.scene_id === s.id)) {
      rows.push({ scene_id: s.id, spatial_group: '', spatial_role: '', props: [], elements: [] })
    }
  }

  // A2 组级环境卡：LLM 给的是 {组名: [短语]}，这里归一化为 {组名: [干净短语]}。
  // 组名以**各场自己声明的 spatial_group**为准做交集清洗——LLM 可能写了个不存在的组名，
  // 那它的环境卡没有任何成员去消费，留着只会让人困惑。孤儿组名直接丢弃。
  const liveGroups = new Set(rows.map((r) => r.spatial_group).filter(Boolean))
  const sharedEnv = {}
  const rawEnv = parsed?.shared_env && typeof parsed.shared_env === 'object' ? parsed.shared_env : {}
  for (const [g, list] of Object.entries(rawEnv)) {
    const name = String(g || '').trim()
    if (!name || !liveGroups.has(name)) continue
    const cleaned = parseElementList(JSON.stringify(Array.isArray(list) ? list : [])).slice(0, MAX_SHARED_ENV_COUNT)
    if (cleaned.length) sharedEnv[name] = cleaned
  }

  return { rows, sharedProps: [...propSet], sharedEnv }
}

// 并发合并（2026-09-18）：批量生图时多场会**同时**调用 ensureSceneAnalysis（buildAnchorRefsForScene
// 里懒加载），而它内部是「DELETE 全部 + 逐行 INSERT」且未包事务——并发跑会互相删掉对方刚写的行，
// 留下半套/重复的分析行。这里用 in-flight Promise 合并同一集的并发分析：谁先到谁真跑，其余复用同一结果。
const analysisInFlight = new Map()

/**
 * 确保当前集的场景分析是最新的（指纹不变直接命中缓存，否则 LLM 重析并重建自动锚点）
 * @param {number} episodeId
 * @param {{ force?: boolean }} opts force=true 无视指纹强制重析（人工触发用）
 * @returns {Promise<{ok:boolean, cached?:boolean, reason?:string, sceneCount:number, sharedProps?:string[]}>}
 */
export function ensureSceneAnalysis(episodeId, { force = false } = {}) {
  const key = `${episodeId}:${force ? 'force' : 'auto'}`
  const running = analysisInFlight.get(key)
  if (running) return running
  const task = runEnsureSceneAnalysis(episodeId, { force })
    // 无论成败都注销：失败也要让下次重试能真正重跑
    .finally(() => { analysisInFlight.delete(key) })
  analysisInFlight.set(key, task)
  return task
}

async function runEnsureSceneAnalysis(episodeId, { force = false } = {}) {
  const scenes = query(
    'SELECT id, scene_number, title, summary, image_url FROM scenes WHERE episode_id = ? ORDER BY scene_number',
    [episodeId]
  )
  if (!scenes.length) return { ok: false, reason: 'no_scenes', sceneCount: 0 }

  const fp = fingerprintOf(scenes)
  const cur = queryOne('SELECT fingerprint FROM scene_analysis WHERE episode_id = ? LIMIT 1', [episodeId])
  if (!force && cur?.fingerprint === fp) return { ok: true, cached: true, sceneCount: scenes.length }

  const { rows: llmRows, sharedProps, sharedEnv } = await analyzeWithLlm(scenes, episodeId)

  // ── 分组人审锁定（2026-09-17）────────────────────────────────────────────
  // 把已锁定的场景强制归回锁定组，覆盖 LLM 本轮的判定。
  // 动机：LLM 每次重析都自由裁量分组，会把已验证的组结构重组，
  //   导致已确认的组锚（source=manual/confirmed=1）变孤儿、人审基线静默失效。
  // 边界：只覆盖 spatial_group 一个字段；未锁定的场景（新增场次）仍用 LLM 判定。
  // 降级：读锁失败 → 空 Map → applyGroupLocks 原样返回 → 逐字退回未改造行为。
  const locks = loadGroupLocks(episodeId, { query, queryOne })
  const { rows, lockedCount, changedCount } = applyGroupLocks(llmRows, locks)
  if (lockedCount) {
    console.log(`[sceneAnchors] 分组锁定生效：${lockedCount} 场已锁（其中 ${changedCount} 场纠正了 LLM 的重组）`)
  }

  // 落库：先删后插（行数少，无需事务优化；指纹闸保证失败时下次重试）
  execute('DELETE FROM scene_analysis WHERE episode_id = ?', [episodeId])
  for (const r of rows) {
    const sn = scenes.find((s) => s.id === r.scene_id)?.scene_number || 0
    // A2：本场所在组的共享环境卡（无组名 / LLM 没给该组 → 空数组，不注入）
    const env = (r.spatial_group && sharedEnv[r.spatial_group]) || []
    execute(
      `INSERT INTO scene_analysis (episode_id, scene_id, scene_number, spatial_group, spatial_role, props_json, elements_json, shared_env_json, fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [episodeId, r.scene_id, sn, r.spatial_group, r.spatial_role, JSON.stringify(r.props),
        JSON.stringify(r.elements || []), JSON.stringify(env), fp]
    )
  }

  // 场景集变了 → 自动锚点按新分析重建（用各场景现有定稿图；manual 锚点保留）
  execute(`DELETE FROM scene_anchors WHERE episode_id = ? AND source = 'auto'`, [episodeId])
  for (const s of scenes) {
    const img = bareUrl(s.image_url)
    if (img) registerSceneAnchors(episodeId, s.id, img)
  }

  // ── P2'-b 状态孤儿兜底（2026-09-17，终审阻断项）──────────────────────────
  // 为什么必然触发：props/scenes 是 AUTOINCREMENT，重提资产 DELETE+INSERT 后 id 必换新；
  //   指纹含 id（fingerprintOf）→ 指纹必变 → 必触发本重析 → 上方全删 auto 锚点重建
  //   → 挂在旧 anchor_key 下的 asset_states 行静默孤儿、零告警。
  // 做什么：以"重建后的 scene_anchors.anchor_key"为存活基准，扫 prop 状态行的裸名是否还在，
  //   不在 → 复用 ai/alerts.js recordAlert 告警（不新造告警体系）。
  // 降级铁律（T6）：整段 try/catch，失败仅 console.warn，绝不阻断重析与出片。
  // ⚠️ 已知可接受误报：重析只删 source='auto' 锚点、且只遍历**有定稿图**的场景登记锚点，
  //   故**无定稿图的场景其名下状态会被判孤儿**。可接受（warn 级、无图本就无法出片），勿当 bug 修。
  try {
    if (config.assetState?.enabled) {
      const stateRows = query(
        `SELECT id, asset_key, state_key FROM asset_states WHERE asset_type = ?`,
        [TYPE_PROP]
      )
      const liveAnchorKeys = query(
        `SELECT anchor_key FROM scene_anchors WHERE episode_id = ? AND anchor_type = '${PROP_ANCHOR_TYPE}'`,
        [episodeId]
      ).map((a) => a.anchor_key)
      const orphanReport = scanOrphanStates(stateRows, liveAnchorKeys)
      if (orphanReport.orphans.length) {
        recordAlert({
          level: 'warn',
          source: 'assetState',
          episodeId,
          message: `资产状态漂移：${orphanReport.orphans.length} 条状态行找不到对应锚点（重提资产后 id 变更所致），需人工重建`,
          detail: JSON.stringify(orphanReport.orphans).slice(0, 2000),
        })
      }
    }
  } catch (e) {
    console.warn('[sceneAnchors] 状态孤儿扫描失败（已忽略，不阻断）:', e.message)
  }

  return { ok: true, cached: false, sceneCount: scenes.length, sharedProps }
}

/**
 * 取单个场景的空间组（会顺带懒分析并落库缓存；失败降级为空组，绝不阻断调用方）。
 * 用途：/asset-image 用它决定「按哪个键排队」（空间组串行锁），前端批量生图用它做组内排序。
 * @returns {Promise<{group:string, role:string, sceneNumber:number}>}
 */
export async function resolveSceneSpatialGroup(episodeId, sceneId) {
  const empty = { group: '', role: '', sceneNumber: 0 }
  try {
    await ensureSceneAnalysis(episodeId)
  } catch (e) {
    // 分析失败 → 当作「不属于任何空间组」：不排队、不串行，行为与改造前一致
    console.warn(`[sceneAnchors] 空间组解析失败（降级为不串行）: ${e.message}`)
    return empty
  }
  const row = queryOne(
    'SELECT spatial_group, spatial_role, scene_number FROM scene_analysis WHERE episode_id = ? AND scene_id = ?',
    [episodeId, sceneId]
  )
  if (!row) return empty
  return {
    group: String(row.spatial_group || '').trim(),
    role: String(row.spatial_role || '').trim(),
    sceneNumber: Number(row.scene_number || 0),
  }
}

/**
 * 取整集的空间分组（懒分析 + 纯 SQL）。给前端批量生图做「组内串行、组间并发」调度用。
 * 为什么不用 GET /scene-anchors：那张表只在**出过图**后才登记，批量补生成时绝大多数
 * 场景还没有锚点行，拿不到分组。
 * @returns {Promise<Array<{sceneId:number, sceneNumber:number, spatialGroup:string, spatialRole:string, hasImage:boolean}>>}
 */
export async function listSceneSpatialGroups(episodeId) {
  try {
    await ensureSceneAnalysis(episodeId)
  } catch (e) {
    console.warn(`[sceneAnchors] 空间分组列表查询失败（降级为空）: ${e.message}`)
    return []
  }
  const rows = query(
    `SELECT sa.scene_id, sa.scene_number, sa.spatial_group, sa.spatial_role, COALESCE(s.image_url, '') AS image_url
     FROM scene_analysis sa
     LEFT JOIN scenes s ON s.id = sa.scene_id
     WHERE sa.episode_id = ?
     ORDER BY sa.scene_number ASC`,
    [episodeId]
  )
  return rows.map((r) => ({
    sceneId: Number(r.scene_id),
    sceneNumber: Number(r.scene_number || 0),
    spatialGroup: String(r.spatial_group || '').trim(),
    spatialRole: String(r.spatial_role || '').trim(),
    hasImage: String(r.image_url || '').trim() !== '',
  }))
}

/**
 * 场景图生成前：从锚点集取参考图（纯 SQL 查询，无 LLM）
 * @returns {Promise<{refs:string[], promptHints:string[], anchors:object[], elements:string[], sharedEnv:string[], spatialRole:string}>}
 *   refs        参考图 URL（裸路径，已去重、已限量）
 *   promptHints 每张参考图对应的提示词约束（与 refs 同序对应关系体现在 anchors 里）
 *   anchors     命中的锚点明细（回执/日志用）
 *   elements    A1 本场要素清单（已清洗去重限量）
 *   sharedEnv   A2 本场所在组的环境卡（已清洗去重限量）
 *   spatialRole 本场机位声明（回执用；prompt 侧由前端注入，这里供服务端日志/质检比对）
 */
export async function buildAnchorRefsForScene(episodeId, sceneId) {
  const empty = { refs: [], promptHints: [], anchors: [], elements: [], sharedEnv: [], spatialRole: '' }
  // 懒分析：首次生成时自动补齐；失败降级为无锚点（不阻断出图）
  try {
    await ensureSceneAnalysis(episodeId)
  } catch (e) {
    console.warn(`[sceneAnchors] 场景分析失败（降级为无锚点）: ${e.message}`)
    return empty
  }

  const row = queryOne('SELECT * FROM scene_analysis WHERE episode_id = ? AND scene_id = ?', [episodeId, sceneId])
  if (!row) return empty

  // A1/A2 清单：解析失败降级为空数组（= 不注入，行为同改造前）
  const elements = parseElementList(row.elements_json)
  const sharedEnv = parseElementList(row.shared_env_json)

  const refs = []
  const promptHints = []
  const anchors = []

  // 0. 组锚（人审基准图，第 3 层）：manual + confirmed 的 spatial 行固定排 refs[0]，
  //    不占 MAX_SPATIAL_REFS 名额（设计 §4.1）。不校验 review 状态——锚行本身
  //    （source='manual', confirmed=1）就是「人已确认」的充分证据，且 ensureSceneAnalysis
  //    重析不会冲掉它（只删 source='auto'）。
  //
  // ── A3（2026-09-17）布局图锚插在组锚**之前** ─────────────────────────────
  // 为什么排最前：布局图是唯一**只表达空间事实、不携带视角**的锚图。放在 refs[0] 的好处是
  //   「参考图1」在提示词里天然被模型当作"空间基准"的默认对象，而布局图正好只该承担这个角色；
  //   照片类锚（spatial 组锚 / 邻场图）都带视角，排在其后 + hint 显式豁免视角，两者不打架。
  // 为什么可以与组锚并存：两者信息不重叠——布局图给"位置关系"，照片给"长什么样"。
  //   布局图缺失（未生成/生成失败）时整段跳过，退化为改造前行为（降级铁律）。
  if (row.spatial_group) {
    const la = queryOne(
      `SELECT anchor_key, image_url FROM scene_anchors
       WHERE episode_id = ? AND anchor_type = '${LAYOUT_ANCHOR_TYPE}' AND anchor_key = ?`,
      [episodeId, row.spatial_group]
    )
    const laImg = bareUrl(la?.image_url)
    if (laImg) {
      refs.push(laImg)
      promptHints.push(LAYOUT_ANCHOR_HINT)
      anchors.push({ type: LAYOUT_ANCHOR_TYPE, key: la.anchor_key, image: laImg, role: '空间布局示意图' })
    }
  }

  if (row.spatial_group) {
    const ga = queryOne(
      `SELECT anchor_key, scene_id, scene_number, image_url FROM scene_anchors
       WHERE episode_id = ? AND anchor_type = '${SPATIAL_ANCHOR_TYPE}' AND anchor_key = ?
         AND source = 'manual' AND confirmed = 1`,
      [episodeId, row.spatial_group]
    )
    const gaImg = bareUrl(ga?.image_url)
    if (gaImg) {
      refs.push(gaImg)                       // 永远第一个 push → 永远 refs[0]
      promptHints.push(GROUP_ANCHOR_HINT)
      anchors.push({ type: SPATIAL_ANCHOR_TYPE, key: ga.anchor_key, image: gaImg, role: '人审基准图' })
    }
  }

  // 1. 空间锚：同空间组的其他场景，已有定稿图的按场次距离取最近 N 张
  if (row.spatial_group) {
    const cur = queryOne('SELECT scene_number FROM scenes WHERE id = ?', [sceneId])
    const mates = query(
      `SELECT s.id, s.title, s.image_url, s.scene_number, sa.spatial_role
       FROM scene_analysis sa
       JOIN scenes s ON s.id = sa.scene_id
       WHERE sa.episode_id = ? AND sa.spatial_group = ? AND sa.scene_id != ? AND TRIM(s.image_url) != ''
       ORDER BY ABS(s.scene_number - ?) ASC`,
      [episodeId, row.spatial_group, sceneId, cur?.scene_number || 0]
    ).slice(0, MAX_SPATIAL_REFS)

    for (const m of mates) {
      const img = bareUrl(m.image_url)
      if (!img || refs.includes(img)) continue
      refs.push(img)
      // 口径与 GROUP_ANCHOR_HINT 一致：邻场图只校准「空间事实」，不继承「视角」。
      // 本场自己是「${m.spatial_role}」的**另一个机位**，若照搬其构图即等于该视角被吞掉。
      promptHints.push(
        `参考图是本空间的「${m.spatial_role || m.title}」视角：本场景与它是同一物理空间，` +
        `空间结构、地标物体的形态与相对位置、光照方向必须与参考图连续；` +
        `但视角、机位高度、景别与画面主体占比一律以本场景文字描述为准，严禁照搬参考图的构图；` +
        `时段、天气、色温同样以本场景文字描述为准`
      )
      anchors.push({ type: SCENE_ANCHOR_TYPE, key: m.title, image: img, role: m.spatial_role })
    }
  }

  // 2. 道具锚：本场出现的共享道具，取首次定稿的锚点图
  let props = []
  try { props = JSON.parse(row.props_json || '[]') } catch { props = [] }
  let propCount = 0
  for (const name of props) {
    if (propCount >= MAX_PROP_REFS) break
    // 锚点键按状态后缀拼装（intact 省略后缀 = 裸名，与现有 7 行锚点一致）。
    // 先按"默认态键"查；查不到再回退裸名查（兼容历史裸名锚点）。判据单点见 buildAnchorKey。
    const stateKey = defaultPropStateKey(name)
    const keyWithState = buildAnchorKey(name, stateKey)
    let a = keyWithState === name
      ? null
      : queryOne(
        `SELECT * FROM scene_anchors WHERE episode_id = ? AND anchor_type = '${PROP_ANCHOR_TYPE}' AND anchor_key = ?`,
        [episodeId, keyWithState]
      )
    if (!a) {
      a = queryOne(
        `SELECT * FROM scene_anchors WHERE episode_id = ? AND anchor_type = '${PROP_ANCHOR_TYPE}' AND anchor_key = ?`,
        [episodeId, name]
      )
    }
    if (!a) continue
    const img = bareUrl(a.image_url)
    if (!img) continue
    if (!refs.includes(img)) refs.push(img)
    // 命中状态记录 → 动态提示词（携带真实状态）；无状态 → 原文案（= 改造前行为）
    const stateHint = stateKey ? stateHintFor(name) : ''
    promptHints.push(
      stateHint
      || `道具「${name}」必须与参考图中的同一物体保持形态、颜色、材质与破损状态一致`
    )
    anchors.push({ type: PROP_ANCHOR_TYPE, key: stripStateSuffix(a.anchor_key || name), image: img })
    propCount++
  }

  return {
    refs, promptHints, anchors,
    elements, sharedEnv,
    spatialRole: String(row.spatial_role || '').trim(),
  }
}

/**
 * 场景图生成成功后：登记为锚点（纯 SQL，幂等）
 *   场景锚：按场景标题 upsert（重画即换图）
 *   道具锚：本场出现的共享道具，**首次出现即定稿**（已存在则不覆盖——先定稿的图是基准）
 */
export function registerSceneAnchors(episodeId, sceneId, imageUrl) {
  const img = bareUrl(imageUrl)
  if (!img) return { registered: false }

  const scene = queryOne('SELECT title, scene_number FROM scenes WHERE id = ?', [sceneId])
  if (!scene) return { registered: false }

  execute(
    `INSERT INTO scene_anchors (episode_id, anchor_type, anchor_key, scene_id, scene_number, image_url, description, source)
     VALUES (?, '${SCENE_ANCHOR_TYPE}', ?, ?, ?, ?, ?, 'auto')
     ON CONFLICT(episode_id, anchor_type, anchor_key)
     DO UPDATE SET image_url = excluded.image_url, scene_id = excluded.scene_id, scene_number = excluded.scene_number`,
    [episodeId, scene.title, sceneId, scene.scene_number || 0, img, `场景「${scene.title}」定稿图`]
  )

  const row = queryOne('SELECT props_json FROM scene_analysis WHERE episode_id = ? AND scene_id = ?', [episodeId, sceneId])
  let props = []
  try { props = row ? JSON.parse(row.props_json || '[]') : [] } catch { props = [] }

  // FIX-1a（2026-09-18，P1-Q1）：登记道具锚前，先把「场景分析 LLM 的名字」归一到「props 表名」。
  // 为什么：scene_analysis.props_json 来自场景分析 LLM，props.name 来自剧本提取 LLM，两趟各说各话
  //   （ep4 实证：「断桥」在 props 表里叫「腐朽木桥」）→ 下游按表名精确匹配拿不到参考图。
  // 未命中（resolvePropName 返回 null）：保持原名**不阻断**，但记 warn 告警把"静默丢失"变"可见"。
  // 归一是纯机械策略（见 ai/propNameMatch.js），绝不猜配。
  const propTableNames = query('SELECT name FROM props WHERE episode_id = ?', [episodeId]).map((r) => r.name)

  for (const rawName of props) {
    const matchedPropName = resolvePropName(rawName, propTableNames)
    if (!matchedPropName) {
      try {
        recordAlert({
          level: 'warn',
          source: 'propName',
          episodeId,
          message: `场景分析道具名「${rawName}」在道具表中无对应项（多趟 LLM 命名不一致），其锚点按原名登记，下游出片可能匹配不到该道具参考图，建议在设定页核对道具名`,
          detail: JSON.stringify({ raw: rawName, candidates: propTableNames }).slice(0, 2000),
        })
      } catch { /* 记告警失败绝不能反过来阻断锚登记 */ }
    }
    const name = matchedPropName || rawName
    // 道具锚更新策略（2026-09-17 修正）：
    //   - 道具锚不存在 → 以本场图首次定稿
    //   - 道具锚出自**本场** → 本场重画了，锚点同步换新图（否则锚点永远挂着旧图）
    //   - 道具锚出自**他场** → 不动（他场的定稿是基准，本场重画不该篡夺）
    // P2'（2026-09-17）：锚点键按状态后缀拼装（intact 省略后缀 = 裸名，与历史 7 行锚点一致）。
    // 状态键取该道具默认态（场景图阶段无镜头级状态）；机制关闭 → 空串 → 裸名（=改造前行为）。
    const anchorKey = buildAnchorKey(name, defaultPropStateKey(name))
    execute(
      `INSERT INTO scene_anchors (episode_id, anchor_type, anchor_key, scene_id, scene_number, image_url, description, source)
       VALUES (?, '${PROP_ANCHOR_TYPE}', ?, ?, ?, ?, ?, 'auto')
       ON CONFLICT(episode_id, anchor_type, anchor_key) DO UPDATE SET
         image_url = excluded.image_url,
         scene_id = excluded.scene_id,
         scene_number = excluded.scene_number
       WHERE scene_anchors.scene_id = excluded.scene_id`,
      [episodeId, anchorKey, sceneId, scene.scene_number || 0, img, `出自场景「${scene.title}」（首次定稿）`]
    )
  }
  return { registered: true, props }
}

// ===================================================================
// 分组人审锁定（2026-09-17）
// ===================================================================
//
// 职责边界：本段只做「读写锁 + 概览」，业务语义全在 ai/sceneGroupLock.js。
// 放在这里是为了让路由层统一从 sceneAnchors 取（与其它锚点能力同源，调用方少一个 import）。
// 详见 ai/sceneGroupLock.js 头部——为什么必须锁、锁什么、通用性如何保证。

/** 把**当前**分组状态锁住（人审确认后调用）。 */
export function lockCurrentGrouping(episodeId, opts = {}) {
  const rows = query(
    // ⚠️ 空串用单引号：SQLite 里双引号是标识符，会报 no such column: ""（实测踩过）
    "SELECT scene_id, spatial_group FROM scene_analysis WHERE episode_id = ? AND TRIM(spatial_group) != ''",
    [episodeId]
  )
  if (!rows.length) return { locked: 0, reason: '无可锁的分组（分析未跑或组名为空）' }
  const note = String(opts.note || '人审确认').slice(0, 200)
  let locked = 0
  for (const r of rows) {
    const sid = Number(r.scene_id)
    const g = String(r.spatial_group || '').trim()
    if (!Number.isFinite(sid) || sid <= 0 || !g) continue
    execute(
      `INSERT INTO scene_group_locks (episode_id, scene_id, spatial_group, note)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(episode_id, scene_id) DO UPDATE SET spatial_group = excluded.spatial_group, note = excluded.note`,
      [episodeId, sid, g, note]
    )
    locked++
  }
  console.log(`[sceneAnchors] 已锁定 ${locked} 场的分组（episode=${episodeId}）`)
  return { locked }
}

/** 解除锁定（全部或指定场次）。 */
export function unlockGrouping(episodeId, opts = {}) {
  const ids = Array.isArray(opts.sceneIds)
    ? opts.sceneIds.map(Number).filter((n) => Number.isFinite(n) && n > 0)
    : []
  if (!ids.length) {
    const before = queryOne('SELECT COUNT(*) AS c FROM scene_group_locks WHERE episode_id = ?', [episodeId])
    execute('DELETE FROM scene_group_locks WHERE episode_id = ?', [episodeId])
    return { removed: Number(before?.c || 0) }
  }
  execute(
    `DELETE FROM scene_group_locks WHERE episode_id = ? AND scene_id IN (${ids.map(() => '?').join(',')})`,
    [episodeId, ...ids]
  )
  return { removed: ids.length }
}

/** 锁定概览 + 孤儿组锚检测（前端提示「人审基准已失效」用）。 */
export function describeGroupLocks(episodeId) {
  return getGroupLockOverview(episodeId, { query, queryOne })
}

/**
 * 人工触发：强制重析并回填锚点（/scene-anchors/init 端点用）
 */
export async function initAnchorSetFromExisting(episodeId) {
  const r = await ensureSceneAnalysis(episodeId, { force: true })
  if (!r.ok) return r
  const anchors = query(
    'SELECT anchor_type, anchor_key, scene_id, scene_number, image_url FROM scene_anchors WHERE episode_id = ? ORDER BY anchor_type, scene_number',
    [episodeId]
  )
  const analysis = query(
    'SELECT scene_id, scene_number, spatial_group, spatial_role, props_json, elements_json, shared_env_json FROM scene_analysis WHERE episode_id = ? ORDER BY scene_number',
    [episodeId]
  )
  return { ...r, anchorCount: anchors.length, anchors, analysis }
}

// ===================================================================
// A3 布局图锚：素材汇总 / 登记 / 取用（2026-09-17）
// ===================================================================
//
// 职责边界：本模块只做「读分析 → 汇总素材」与「登记/读取锚行」，
//   **不调用生图**（不 import ai/image.js）——生图由路由层调，保持本模块可测试、
//   零网络依赖（与文件头部的设计原则一致）。

/**
 * 汇总某空间组的布局图素材（纯 SQL，供路由层构建 prompt）。
 *
 * 地标来源三层，缺一不可（2026-09-17 实测修正）：
 *   ① 组内各场的 shared_props 并集 —— 跨场共享的有形物体（断桥/船/门）
 *   ② 组内各场的 elements 的并集 —— A1 抽的"本场必须可见的要素"，这是**布局图的主要素材**：
 *      只有 props 时 layout 图会空得只剩一座桥（实测：cliff_river 只收到「断桥」一条），
 *      而地形/水体/植被这些构成空间骨架的东西全在 elements 里（雪线悬崖/深谷冰河/窄下山道）。
 *   ③ 组级环境卡 —— 地点固有特征（雪线悬崖/灰白砾石滩），与 elements 有重叠，去重后合并。
 *
 * 不做语义筛选（哪些词算实体）—— 那是 LLM 在分析阶段的分工（elements 是"可见要素"、
 *   shared_env 是"地点特征"，都已是视觉实词）。代码只做并集与去重（通用性硬约束）。
 *
 * @returns {{group:string, roles:string[], landmarks:string[], env:string[], memberCount:number}|null}
 *   null = 该组不存在（调用方 404）
 */
export function collectGroupLayoutMaterials(episodeId, group) {
  const g = String(group || '').trim()
  if (!g) return null
  const members = query(
    `SELECT s.scene_number, s.title, sa.spatial_role, sa.props_json, sa.elements_json, sa.shared_env_json
     FROM scene_analysis sa
     JOIN scenes s ON s.id = sa.scene_id
     WHERE sa.episode_id = ? AND sa.spatial_group = ?
     ORDER BY s.scene_number ASC`,
    [episodeId, g]
  )
  if (!members.length) return null

  const roles = []
  const landmarks = []
  const env = []
  const seen = { roles: new Set(), landmarks: new Set(), env: new Set() }
  const parseArr = (raw) => {
    try {
      const v = JSON.parse(raw || '[]')
      return Array.isArray(v) ? v : []
    } catch { return [] }
  }

  for (const m of members) {
    const role = String(m.spatial_role || '').trim()
    if (role && !seen.roles.has(role)) { seen.roles.add(role); roles.push(role) }
    // ① shared_props + ② elements 合并入 landmarks
    for (const list of [parseArr(m.props_json), parseArr(m.elements_json)]) {
      for (const x of list) {
        const s = String(x || '').trim()
        if (s && !seen.landmarks.has(s)) { seen.landmarks.add(s); landmarks.push(s) }
      }
    }
  }
  // ③ 组级环境卡（同组各场逐字相同，取第一份即可）
  for (const x of parseArr(members[0].shared_env_json)) {
    const s = String(x || '').trim()
    if (s && !seen.env.has(s)) { seen.env.add(s); env.push(s) }
  }

  return { group: g, roles, landmarks, env, memberCount: members.length }
}

/**
 * 布局图素材指纹（2026-09-18，布局图时效提示用）。
 *
 * 只对**真正进 prompt 的三样东西**取指纹：roles / landmarks / env。
 * 为什么不是对场景原文取指纹：布局图 prompt 只由这三样构成，
 *   场景描述里改了不相关的字（错别字、语气词）不该让一张正确的布局图被标成"过时"——
 *   那种误报累积起来会让提示失去可信度，用户就再也不看它了。
 *
 * **顺序无关**：对每项排序后再 hash。
 *   因为 roles/landmarks/env 的顺序取决于场景遍历顺序，而场次顺序变化（重排/增删无关场）
 *   并不会改变"这组空间里有什么"，不该误判为过时。
 *   去重也在这里再做一次（素材侧已有，这里是防御性冗余，保证同一集合必得同一指纹）。
 *
 * @returns {string} 形如 'a1b2c3…'（空素材 → 空串，调用方据此跳过时效判断）
 */
export function layoutMaterialsFingerprint(materials) {
  if (!materials) return ''
  const norm = (arr) => [...new Set((arr || []).map((x) => String(x || '').trim()).filter(Boolean))].sort()
  const payload = [
    norm(materials.roles).join('\u0001'),
    norm(materials.landmarks).join('\u0001'),
    norm(materials.env).join('\u0001'),
  ].join('\u0002')
  // 三样全空 → 没有可比对的素材，返回空串（宁可不判断，也不误报"过时"）
  if (!payload.replace(/[\u0001\u0002]/g, '')) return ''
  return crypto.createHash('md5').update(payload).digest('hex')
}

/**
 * 登记某组的布局图锚（幂等 upsert）。
 *
 * ⚠️ source='manual' 是刻意的（2026-09-17）：ensureSceneAnalysis 重析时会
 *   `DELETE FROM scene_anchors WHERE source='auto'`（场景集一变就重建自动锚点）。
 *   布局图是**花钱生成 + 一次一张**的资产，不能因为改了某场描述就被静默删除——
 *   那会让用户在毫无察觉的情况下退回到"只有照片锚"的旧状态（正是本方案要消灭的静默降级）。
 *   故用 manual：重析永不动它。素材是否过时由 UI 侧比对素材指纹提示（见 GET /layout-anchor
 *   返回的 materials），由人决定要不要重画。
 */
export function registerLayoutAnchor(episodeId, group, imageUrl, opts = {}) {
  const g = String(group || '').trim()
  const img = bareUrl(imageUrl)
  if (!g || !img) return { registered: false }
  const fp = String(opts.sourceFingerprint || '')
  execute(
    `INSERT INTO scene_anchors (episode_id, anchor_type, anchor_key, scene_id, scene_number, image_url, description, source, source_fingerprint)
     VALUES (?, '${LAYOUT_ANCHOR_TYPE}', ?, ?, ?, ?, ?, 'manual', ?)
     ON CONFLICT(episode_id, anchor_type, anchor_key) DO UPDATE SET
       image_url = excluded.image_url,
       description = excluded.description,
       scene_id = excluded.scene_id,
       scene_number = excluded.scene_number,
       source = 'manual',
       source_fingerprint = excluded.source_fingerprint,
       confirmed = 1`,
    [
      episodeId, g, Number(opts.repSceneId) || 0, Number(opts.repSceneNumber) || 0, img,
      String(opts.description || `空间组「${g}」布局示意图`), fp,
    ]
  )
  return { registered: true, group: g, image: img, sourceFingerprint: fp }
}

/**
 * 读某组的布局图锚（无 → null）。供路由/前端查询用。
 *
 * sourceFingerprint：画这张图时所用素材的指纹（老数据/未记 → 空串）。
 * 调用方拿它与**当前**素材指纹比对，判断这张图是否已过时。
 */
export function getLayoutAnchor(episodeId, group) {
  const g = String(group || '').trim()
  if (!g) return null
  const row = queryOne(
    `SELECT anchor_key, image_url, description, source_fingerprint FROM scene_anchors
     WHERE episode_id = ? AND anchor_type = '${LAYOUT_ANCHOR_TYPE}' AND anchor_key = ?`,
    [episodeId, g]
  )
  if (!row) return null
  const img = bareUrl(row.image_url)
  return img
    ? {
        group: row.anchor_key,
        imageUrl: img,
        description: row.description || '',
        sourceFingerprint: String(row.source_fingerprint || ''),
      }
    : null
}
