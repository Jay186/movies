// 道具名跨层归一（2026-09-18，P1-Q1）
//
// ── 这个模块解决什么 ────────────────────────────────────────────────────────
// 同一件道具在不同层由**不同趟 LLM** 命名，彼此没有任何归一桥接：
//   · `scene_analysis.props_json` / `scene_anchors.anchor_key` ← 场景分析 LLM（ep4 实际值「断桥」）
//   · `props.name`                                             ← 剧本提取 LLM（ep4 实际值「腐朽木桥」）
// 而出片消费端（generate-video.js / generate-image.js）拿 `shots.prop_assets` 的名字与
// `props` 表做**精确串匹配** → 名字对不上 = 匹配不到 = `pushRef` 因 `!image` 静默 return =
// 道具参考图 **静默丢失、零告警**（本项目核心目标「道具跨镜一致性」由此失效）。
//
// ── 做法（三级保守策略，宁可不匹配也不错配）─────────────────────────────────
// 「断桥」到底等不等于「腐朽木桥」是**语义判断**，任何手写词表/正则都会被下一个剧本打破。
// 故本模块只做**不引入题材/语言假设的机械归一**，且任何不确定一律返回 null（交调用方记告警），
// 绝不做"猜一个最像的"——错配一个道具比丢一个道具更糟（会把 A 的外观锚到 B 上）。三级：
//   ① normalize 后精确相等；
//   ② 去掉**状态后缀**后精确（后缀规则**复用** ai/assetState.js 的 stripStateSuffix，禁复制）；
//   ③ 包含候选挑选（判据单点 pickContainmentCandidate）：raw 与候选**有包含关系**（任一方向）
//      且 raw 归一后长度 ≥2；0 个 → null，恰好 1 个 → 采用，≥2 个 → 取归一后**最短**者，
//      最短长度并列（≥2 个同长）→ null（不猜）。
//
// ── 通用性硬约束（项目铁律）────────────────────────────────────────────────
// 零题材词表、零中文正则、零具体语言假设：标点/空白按 Unicode 类别处理，
// 换题材（仙侠/都市）、换语言（英文道具名）一律照常工作。
//
// ── 纯函数 ──────────────────────────────────────────────────────────────────
// 零副作用、零 IO、零 DB：便于单测；由调用方负责查 props 名单与记告警。

import { stripStateSuffix } from './assetState.js'

// 全角空格 U+3000 → 半角空格：LLM / 输入法常见，肉眼不可辨，是"看起来一样却匹配不上"的经典来源。
const FULLWIDTH_SPACE = /\u3000/g
// 首尾标点/符号/空白（Unicode 类别，语言中立）：去掉 "《断桥》" / "「桥」" / " 桥 " / "桥。" 之类噪声。
const EDGE_NOISE = /^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu

/**
 * 道具名归一：全角空格转半角、去首尾标点/符号/空白。纯机械处理，不含任何语义假设。
 * @param {any} s 任意输入（数字/null 也安全）
 * @returns {string} 归一后的名字（可能为空串）
 */
export function normalizePropName(s) {
  let t = String(s == null ? '' : s).replace(FULLWIDTH_SPACE, ' ')
  t = t.replace(EDGE_NOISE, '')
  return t.trim()
}

/**
 * 在给定道具名单里为 raw 找一个对应的 **props 表名**。
 * 三级保守策略（见文件头注释），命中即返回**原样**的表名，否则返回 null。
 * @param {any} raw 待归一的道具名（来自 scene_analysis.props_json 或 shots.prop_assets）
 * @param {string[]} propNames props 表中该集的道具名数组
 * @returns {string|null} 命中的 props 表名（原样返回，不做二次加工）或 null（调用方据此记 warn）
 */
export function resolvePropName(raw, propNames) {
  const names = (Array.isArray(propNames) ? propNames : [])
    .filter((n) => n != null && String(n).trim() !== '')
  const target = normalizePropName(raw)
  if (!target || !names.length) return null

  // ① 归一后精确相等（唯一命中才采用；归一后重名 → 不确定，不猜）
  const exact = names.filter((n) => normalizePropName(n) === target)
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) return null

  // ② 去状态后缀后精确（后缀规则单点：assetState.stripStateSuffix；禁在本模块复制一份）
  const targetBare = stripStateSuffix(target)
  if (targetBare) {
    const bareHits = names.filter((n) => {
      const nb = stripStateSuffix(normalizePropName(n))
      return nb !== '' && nb === targetBare
    })
    if (bareHits.length === 1) return bareHits[0]
    if (bareHits.length > 1) return null
  }

  // ③ 包含候选挑选（判据单点：pickContainmentCandidate，与 ai/doubao.js 的资产名匹配共用）。
  // 道具侧更严：要求 raw 归一后长度 ≥2（单字极易误配，如「桥」→「桥头堡」），故传 minRawLen=2。
  return pickContainmentCandidate(target, names, { minRawLen: 2 })
}

/**
 * 从候选集中挑出与 raw 有「包含关系」（任一方向）的那一个。**判据单点**（FIX-7，2026-09-18）。
 *
 * ── 为什么必须单点 ──────────────────────────────────────────────────────────
 * 资产名模糊匹配（ai/doubao.js 的 matchAssetName）与道具名跨层归一（本模块 resolvePropName）
 * 都要做同一件事：「raw 与候选中哪一个存在包含关系」。此前各写一份，且**并列歧义无判据**——
 * doubao 旧实现取「遍历序最短」，候选并列时命中谁由 Map 遍历顺序决定
 * （`raw='桥'`、候选 `['断桥','木桥']` → 随机构成一个）。把道具图挂到错误道具上，比丢图更糟。
 * 故判据收敛到本函数**唯一一处**，两处消费端只传各自的 normalize。
 *
 * 判据（严格、绝不猜）：
 *   · 收集**所有**满足包含关系的候选（按原名去重）：0 个 → null；恰好 1 个 → 用它；
 *   · ≥2 个 → 取归一后长度**最短**者；**最短长度并列（≥2 个同长）→ null**（不猜）。
 *
 * @param {any} raw
 * @param {string[]} candidates
 * @param {{normalize?:(s:any)=>string, minRawLen?:number}} [opts]
 *   · normalize：归一函数（默认 normalizePropName）。⚠️ 差异是**刻意的**：doubao 的资产业务键
 *     要求「去所有空白/标点 + 小写」（normalizeAssetName），而道具侧只做「去首尾标点空白」
 *     （normalizePropName）——两者是不同的键空间，不得混用（在注释里写明，杜绝无声分歧）。
 *   · minRawLen：raw 归一后最小长度护栏（默认 1 = 不设护栏）。道具侧传 2（防单字误配），
 *     资产匹配侧保持 1（向后兼容，不新增丢弃）。
 * @returns {string|null} 命中的候选原名，或 null
 */
export function pickContainmentCandidate(raw, candidates, opts = {}) {
  const normalize = typeof opts.normalize === 'function' ? opts.normalize : normalizePropName
  const minRawLen = Number.isFinite(opts.minRawLen) ? Math.max(1, opts.minRawLen) : 1
  const target = normalize(raw)
  if (!target || target.length < minRawLen) return null

  const list = Array.isArray(candidates) ? candidates : []
  const seen = new Set()
  const hits = []
  for (const c of list) {
    if (c == null) continue
    const key = String(c)
    if (!key || seen.has(key)) continue
    const cn = normalize(key)
    if (!cn) continue
    if (cn.includes(target) || target.includes(cn)) { seen.add(key); hits.push(key) }
  }

  if (hits.length === 0) return null
  if (hits.length === 1) return hits[0]

  // ≥2：取归一后最短者；最短长度并列 → null（不猜）
  let minLen = Infinity
  for (const h of hits) minLen = Math.min(minLen, normalize(h).length)
  const shortest = hits.filter((h) => normalize(h).length === minLen)
  return shortest.length === 1 ? shortest[0] : null
}

/**
 * 拼装「本集已有道具清单」提示词段（FIX-8，2026-09-18）。
 *
 * 背景：`sceneAnchors.analyzeWithLlm` 的 prompt 此前只要求「场景 props 名与 shared_props 一致」
 *   （**仅内部自洽**），**从未告知 LLM 本集 `props` 表已有名字** → LLM 自由起名（ep4 实证：
 *   场景分析产出「断桥」，而 `props` 表是「腐朽木桥」）→ 道具锚成孤儿、下游按表名匹配落空。
 *   修消费端只是打补丁；根因是 prompt 缺了「统一命名」的锚——本函数提供该锚。
 *
 * 输入：本集 `props` 表的道具名数组（来自 DB）。
 *   · 清单为空 → 返回 `''`（调用方插值即**无任何改动**，逐字保持改造前 prompt）；
 *   · 清单非空 → 返回提示段（含末尾换行），要求「与清单中某项是同一物体」时逐字使用清单写法。
 *
 * 通用性铁律：清单**完全来自数据库**，本函数零题材词/零同义词表/零语言假设。
 * @param {string[]} propNames
 * @returns {string} 提示段（含末尾换行）或 ''
 */
export function buildPropLexiconHint(propNames) {
  const names = []
  for (const n of Array.isArray(propNames) ? propNames : []) {
    const s = String(n == null ? '' : n).trim()
    if (s && !names.includes(s)) names.push(s)
  }
  if (!names.length) return ''
  return '   【本集已有道具清单】（已由剧本提取确认，用于跨环节统一命名）：\n' +
    `   ${names.join('、')}\n` +
    '   若某场景出现的有形物体与清单中某一项**是同一物体**，其 props 名称必须**逐字使用清单中的写法**，\n' +
    '   不得另起别名；清单中没有的物体仍按你的判断命名，并正常参与 shared_props 判定。\n'
}

