// 资产物理状态判据（唯一实现，2026-09-17 P2'）
//
// ===== 这个模块解决什么 =====
//
// 「同一物体跨镜出现时物理状态须一致」——例如「桥」在场景1 是完好、场景2 断了半截，
// 这是**有意的叙事变化**；但同一场/相邻镜内状态无故跳变就是连续性 bug。
// sceneAnchors.js 的道具锚提示词早就写了「须与参考图中的同一物体保持…破损状态一致」，
// 但没有数据结构化承载"某资产在某场到底处于哪个状态"——该提示词此前是空头支票。
// 本模块提供承载该判断的**判据函数**（纯逻辑），数据落 asset_states 表。
//
// ===== 通用性硬约束（本文件铁律，改动前必读）=====
//
// 1. **零业务词**：本文件不出现任何具体资产名/状态名的中文（"断桥""破损"等）。
//    所有状态词表外置在 ai/lexicons/zh-CN.js 的 `stateAliases` 段，
//    经 continuityGuard.buildLexicon 的既有契约（项目注入覆盖语言包）合并。
//    换题材/换语言只改 lexicon 数据文件，本文件零改动。
// 2. **判据单点**：resolveState / normalizeStateKey / isDefaultStateRequest /
//    buildAnchorKey / scanOrphanStates / displayLabel 全仓唯一定义处。
//    接入方（sceneAnchors.js / generate-video.js / episodes.js）**只 import，不复制逻辑体**
//    （本项目 hasExplicitReposition 三处重复导致静默漂移的教训）。
// 3. **降级不阻断**：任何查不到/为空的分支，返回值恒等于"改造前行为"（回退资产主表默认值）。
//    本模块是纯逻辑 + 只读，绝不抛错阻断出片主流程。
// 4. **零硬编码规模**：不写死状态数、资产数、任何长度阈值。

import { getLanguagePack, buildLexicon } from './continuityGuard.js'

const DEFAULT_STATE_KEY = 'intact'   // 默认/原始态键（ASCII，语言中立）
const DEFAULT_STATE_MARKER = '__default__' // 镜头显式请求"回退默认态"（闪回）的哨兵值
const KEY_SEP = '#'                  // 锚点键状态后缀分隔符（现有 7 行锚点无此符，安全）

// ===================================================================
// 词表层 · 状态别名归一
// ===================================================================

/**
 * 取状态别名词表（稳定键 → 别名数组）。
 * 走 continuityGuard 的既有语言包体系：语言包 stateAliases 段 + 项目注入覆盖。
 * 词表缺失/异常 → 返回空对象（normalizeStateKey 退化为 slugify，不阻断）。
 * @param {object} [opts] { lexicon, languagePack } 同 continuityGuard.buildLexicon
 * @returns {Object<string,string[]>} 如 { intact: [...], broken: [...] }
 */
export function getStateAliases(opts = {}) {
  try {
    const L = buildLexicon(opts)
    const raw = L.stateAliases && typeof L.stateAliases === 'object' ? L.stateAliases : {}
    const out = {}
    for (const [key, aliases] of Object.entries(raw)) {
      const k = String(key || '').trim()
      if (!k) continue
      out[k.toLowerCase()] = (Array.isArray(aliases) ? aliases : [aliases])
        .map((a) => String(a || '').trim())
        .filter(Boolean)
    }
    return out
  } catch {
    return {}
  }
}

/** 把任意文本 slugify 成 ASCII 稳定键（去 CJK、空格转下划线、小写）。纯函数。 */
function slugifyAscii(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/**
 * 状态名归一：把人类可读的状态名（中文/英文/任意）映射为 ASCII 稳定键。
 *   ① 命中 lexicon.stateAliases 的任一别名 → 返回对应稳定键；
 *   ② 本身就是合法 ASCII 键（如 'broken'/'intact'）→ 原样返回（小写）；
 *   ③ 都未命中 → slugify(英文) 兜底；slugify 为空（纯中文未登记）→ 返回 ''（调用方按未登记处理，不阻断）。
 * 纯函数、词表外置（铁律 1）。
 * @param {string} label 状态名
 * @param {object} [opts] 词表选项（同 getStateAliases）
 * @returns {string} ASCII 稳定键或 ''
 */
export function normalizeStateKey(label, opts = {}) {
  const raw = String(label || '').trim()
  if (!raw) return ''
  const lower = raw.toLowerCase()
  // 已是合法 ASCII 键
  if (/^[a-z0-9_]+$/.test(lower)) return lower
  // 命中词表别名
  const aliases = getStateAliases(opts)
  for (const [key, list] of Object.entries(aliases)) {
    if (list.some((a) => a.toLowerCase() === lower)) return key
  }
  // slugify 兜底
  return slugifyAscii(raw)
}

// ===================================================================
// C1 · 某资产在某镜应处于哪个状态
// ===================================================================

/**
 * 某个资产条目在**某个镜头**下应处于哪个状态。
 *
 * @param {Object|null} shotStateEntry 镜头级状态条目 `{ state: string }`，
 *   来自 shots.asset_states_json 里该资产（业务键）对应的值。
 *   形状：可直接是 state 字符串，或 `{ state: 'broken' }`。
 *   - 为 null/undefined → 表示该镜头未指定状态 → 回退默认态（= 改造前行为）。
 * @param {Array<Object>} assetStatesList 该资产（type+key）下的 asset_states 行数组，
 *   每行形如 `{ state_key, label_zh, description, description_en, image_url, is_default }`。
 * @returns {{stateKey:string, labelZh:string, description:string, descriptionEn:string, imageUrl:string, isDefault:boolean, resolved:boolean}}
 *   - 查不到 / 列表为空 / entry 无状态 → 返回默认态占位（resolved=false，调用方据此回退主表）。
 */
export function resolveState(shotStateEntry, assetStatesList) {
  const empty = {
    stateKey: '', labelZh: '', description: '', descriptionEn: '',
    imageUrl: '', isDefault: true, resolved: false,
  }
  if (!Array.isArray(assetStatesList) || !assetStatesList.length) return empty

  // 归一 entry → 目标 state_key
  let want = ''
  if (typeof shotStateEntry === 'string') want = shotStateEntry
  else if (shotStateEntry && typeof shotStateEntry === 'object') want = shotStateEntry.state
  want = String(want || '').trim()
  if (!want) return empty

  // 闪回：显式请求默认态 → 取 is_default=1（或 state_key='intact'）那行
  if (isDefaultStateRequest(shotStateEntry)) {
    const def = assetStatesList.find((r) => Number(r.is_default) === 1)
      || assetStatesList.find((r) => String(r.state_key) === DEFAULT_STATE_KEY)
    return def ? rowToState(def, true) : empty
  }

  const key = want.toLowerCase()
  const hit = assetStatesList.find((r) => String(r.state_key || '').toLowerCase() === key)
  return hit ? rowToState(hit, false) : empty
}

function rowToState(row, isDefault) {
  return {
    stateKey: String(row.state_key || ''),
    labelZh: String(row.label_zh || ''),
    description: String(row.description || ''),
    descriptionEn: String(row.description_en || ''),
    imageUrl: String(row.image_url || ''),
    isDefault: !!isDefault || Number(row.is_default) === 1,
    resolved: true,
  }
}

// ===================================================================
// C3 · 闪回默认态判定
// ===================================================================

/**
 * 该条目是否显式请求"回退默认/原始态"（闪回场景用）。
 * @param {Object|string|null} entry
 * @returns {boolean}
 */
export function isDefaultStateRequest(entry) {
  const s = typeof entry === 'string' ? entry : (entry && typeof entry === 'object' ? entry.state : '')
  return String(s || '').trim().toLowerCase() === DEFAULT_STATE_MARKER
}

// ===================================================================
// 锚点键拼装（后缀方案；与 scene_anchors.anchor_key 自洽）
// ===================================================================

/**
 * 拼装锚点键：`intact`（默认态）**省略后缀**（返回裸名，保持现有 7 行锚点零改动）；
 * 其他状态返回 `裸名#state_key`。
 * 逆运算见 stripStateSuffix。禁各处手拼（铁律 2）。
 * @param {string} assetName 资产裸名（如锚点裸名/场景标题）
 * @param {string} [stateKey] ASCII 稳定键
 * @returns {string}
 */
export function buildAnchorKey(assetName, stateKey) {
  const name = String(assetName || '').trim()
  if (!name) return ''
  const key = String(stateKey || '').trim().toLowerCase()
  if (!key || key === DEFAULT_STATE_KEY) return name
  return `${name}${KEY_SEP}${key}`
}

/**
 * buildAnchorKey 逆运算：去掉状态后缀，取回资产裸名。
 * @param {string} anchorKey
 * @returns {string}
 */
export function stripStateSuffix(anchorKey) {
  const s = String(anchorKey || '')
  const i = s.indexOf(KEY_SEP)
  return (i >= 0 ? s.slice(0, i) : s).trim()
}

// ===================================================================
// 孤儿检测（P2'-b 兜底；纯函数，无 IO）
// ===================================================================

/**
 * 状态行孤儿检测：asset_states 中的 prop 状态行，其**裸名**若不在
 * "重建后的存活锚点键集合"（同样去后缀取裸名）中 → 判为孤儿。
 *
 * 背景（为什么必然触发）：props/scenes 是 AUTOINCREMENT，重提资产 DELETE+INSERT 后 id 必换新；
 * sceneAnchors 的指纹含 id → 指纹必变 → 必触发重析 → auto 锚点全删重建。
 * 若锚点重建后不再包含某状态行对应的裸名，该状态行即"静默孤儿"——靠本函数让其实体可见（告警）。
 *
 * ⚠️ 已知可接受误报：重析只删 source='auto' 锚点、且只遍历**有定稿图**的场景登记锚点，
 *    故**无定稿图的场景其名下状态会被判孤儿**。这是可接受的（warn 级、无图本就无法出片），
 *    勿当 bug 修。
 *
 * @param {Array<Object>} stateRows asset_states 中 asset_type='prop' 的行（含 asset_key/state_key/id）
 * @param {Array<string>} liveAnchorKeys 重建后 scene_anchors.anchor_key 全量（含带后缀与裸名）
 * @returns {{orphans:Array<{assetKey:string,stateKey:string,rowId:any}>, checked:number}}
 */
export function scanOrphanStates(stateRows, liveAnchorKeys) {
  const rows = Array.isArray(stateRows) ? stateRows : []
  const liveBare = new Set(
    (Array.isArray(liveAnchorKeys) ? liveAnchorKeys : [])
      .map((k) => stripStateSuffix(k))
      .filter(Boolean)
  )
  const orphans = []
  for (const r of rows) {
    const bare = stripStateSuffix(r?.asset_key)
    if (!bare) continue
    if (!liveBare.has(bare)) {
      orphans.push({ assetKey: bare, stateKey: String(r?.state_key || ''), rowId: r?.id })
    }
  }
  return { orphans, checked: rows.length }
}

// ===================================================================
// UI 回显
// ===================================================================

/**
 * 状态展示名：有 label_zh 用之；没有（lexicon 未登记）→ 回退 `state_key〔未登记〕`。
 * 文案固定、非业务枚举，符合铁律 1。
 * @param {string} stateKey
 * @param {string} [labelZh]
 * @returns {string}
 */
export function displayLabel(stateKey, labelZh) {
  const zh = String(labelZh || '').trim()
  if (zh) return zh
  const key = String(stateKey || '').trim()
  return key ? `${key}〔未登记〕` : ''
}

export const _defaultStateKey = DEFAULT_STATE_KEY
