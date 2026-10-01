import path from 'node:path'
import { UPLOADS_URL_SLASH, UPLOADS_PREFIX_RE } from '../paths.js'
import fs from 'node:fs'
import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { query } from '../db.js'
import { config } from '../config.js'
import { uploadRefGlobalSql } from './assetTypes.js'

export function allowHosts() {
  return config.security?.downloadAllowHosts || []
}

export function bareUrl(u) {
  return String(u || '').split('?')[0].trim()
}

export function clean(s) {
  return String(s || '')
    .replace(/@/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function cleanDesc(s) {
  return clean(s).replace(/[。.]+$/, '')
}

// 中文标点 → 英文标点（2026-09-27）：world_state 的中文源用「：」分隔主体、「·」分隔字段，
// 分镜 LLM 产出英文副本时容易把这些标点原样带进英文句（实测 1-2/1-3 compiled_prompt 里
// 出现 "Character A：center frame·paused·head raised" 与 "Character B：frame left·standing
// at the cliff edge·面向into scene depth"）——这对英文 prompt 是非法标点，模型理解全凭运气。
// 此处做「标点归一」而非「字符删除」：「·」是字段分隔符，直接删会把 "frame centerpaused"
// 粘成一个词，故按位置语义分别处理。
//   「：」→ 逗号（"X：A·B" → "X, A, B" 的自然断句）
//   「·」→ 逗号（字段分隔，保留断句语义）
// 其余全角标点统一降级为半角等价物。
const UNICODE_PUNCT_MAP = [
  [/[：]/g, ', '],
  [/[·・]/g, ', '],
  [/[，、]/g, ', '],
  [/[。；]/g, '; '],
  [/[！]/g, '! '],
  [/[？]/g, '? '],
  [/[（]/g, ' ('],
  [/[）]/g, ') '],
  [/[「『]/g, ' "'],
  [/[」』]/g, '" '],
  [/[～]/g, '~'],
]

export function normalizeCjkPunct(s) {
  let out = String(s || '')
  for (const [re, rep] of UNICODE_PUNCT_MAP) out = out.replace(re, rep)
  return out
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/,\s*,/g, ',')
    .trim()
}

export function lowerFirst(s) {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : ''
}

// MiniMax H3 Ref2VA 官方 ref-en.txt §5.2 L231 / §5.3 L246：重要主体必须在 detailed_description
// 的首次出现处打 <Subject N> 标签（"at their first appearance"；标签全篇含义一致见 L35）。
// 只处理 <d>...</d> 之外的文本——官方 §7 范例（L330-332）台词 <d> 内保持自然语言不打标签。
// 匹配规则：名字首字母可能因句首大写/lowerFirst 变形，故同时匹配原样与首字母大小写翻转
// 两个变体；前后必须是非字母边界（防 "Ann" 命中 "Anna"）；长名优先（防 "Lin" 抢 "Lin Xiao"）。
// 每次调用内每个主体只标首次出现。
//
// 保护句（2026-09-26 修复）：首尾状态句是 0.00s 与末帧的构图硬约束，句式固定为
// "The opening frame at 0.00s must show exactly:${...}" / "By the final frame, ... must be exactly:${...}"，
// 其内容是「谁在画面哪个位置、什么姿态」的直陈事实。若在此处打 <Subject N> 标签，
// 名字会被替换成裸标签（"<Subject 1> begins seated at frame left"），姿态与位置信息与主体名的
// 绑定被切断；同时因为「每主体只标首次」名额已被这些前置句消耗，后文真正需要标签的
// 主体描述句反而标不上。故这两处区间整体跳过，标签顺延到其后的自然叙事句。
const PROTECTED_CLAUSES = [
  /The opening frame at 0\.00s must show exactly:[^.]*\./g,
  /By the final frame, the blocking and object state must be exactly:[^.]*\./g,
]

export function tagSubjectFirstMentions(text, subjectRefs) {
  const src = String(text || '')
  if (!src || !Array.isArray(subjectRefs) || !subjectRefs.length) return src
  const refs = [...subjectRefs]
    .map((r) => ({ index: Number(r.index) || 0, name: String(r.name || '').trim() }))
    .filter((r) => r.index > 0 && r.name)
    .sort((a, b) => b.name.length - a.name.length)
  if (!refs.length) return src
  const claimed = new Set()
  const tagChunk = (chunk) => {
    let s = chunk
    for (const r of refs) {
      if (claimed.has(r.index)) continue
      const hit = findNameOccurrence(s, r.name)
      if (!hit) continue
      s = s.slice(0, hit.start) + `<Subject ${r.index}>` + s.slice(hit.end)
      claimed.add(r.index)
    }
    return s
  }
  // 先把受保护区间切出来原样保留，只对区间外的文本做打标
  const guards = []
  for (const re of PROTECTED_CLAUSES) {
    let gm
    while ((gm = re.exec(src))) guards.push({ start: gm.index, end: gm.index + gm[0].length })
  }
  guards.sort((a, b) => a.start - b.start)
  const D_RE = /<d>[\s\S]*?<\/d>/g
  const out = []
  let last = 0
  let m
  // 逐段推进：受保护区间与 <d> 台词区间都原样透传，其余文本走打标
  const flush = (end) => {
    if (end <= last) return
    let segStart = last
    while (segStart < end) {
      const guard = guards.find((g) => g.start >= segStart && g.start < end)
      if (!guard) { out.push(tagChunk(src.slice(segStart, end))); break }
      if (guard.start > segStart) out.push(tagChunk(src.slice(segStart, guard.start)))
      out.push(src.slice(guard.start, Math.min(guard.end, end)))
      segStart = Math.min(guard.end, end)
    }
  }
  while ((m = D_RE.exec(src))) {
    flush(m.index)
    out.push(m[0])
    last = m.index + m[0].length
  }
  flush(src.length)
  return out.join('')
}

function findNameOccurrence(s, name) {
  const head = name.charAt(0)
  const flipped = (head === head.toUpperCase() ? head.toLowerCase() : head.toUpperCase()) + name.slice(1)
  const variants = flipped === name ? [name] : [name, flipped]
  // 各变体分别找最早合法命中，再取 start 最小者：同一段里可能同时存在
  // "Lin Xiao"（句中大写）与 "lin Xiao"（lowerFirst 句首变形），首现必须按位置而非变体顺序定。
  let best = null
  for (const v of variants) {
    let from = 0
    while (true) {
      const i = s.indexOf(v, from)
      if (i < 0) break
      const before = i === 0 ? '' : s.charAt(i - 1)
      const after = s.charAt(i + v.length)
      if (!/[A-Za-z]/.test(before) && !/[A-Za-z]/.test(after)) {
        if (!best || i < best.start) best = { start: i, end: i + v.length }
        break
      }
      from = i + 1
    }
  }
  return best
}

// 去重：出片层句式是 `[Shot N] A <shotSize>`，后面接 `, <visualDesc>`。
// LLM 扩写的 description_en 常以景别词开头（如 "medium shot captures..."），
// 会拼成 "A medium shot, medium shot captures..." 的重复。此处剥掉描述开头的景别词，
// 并同时吃掉紧随的标点，避免拼出 ", captures..." 这种逗号悬空。
//
// 守卫：若景别词后紧跟 shot/frame/view/angle 等名词（说明它是在作定语，如 "the close-up shot is reviewed"），
// 视为普通描述而非景别声明，不剥——避免误伤正文。
// 去重：出片层句式是 `[Shot N] A <shotSize>`，后面接 `, <visualDesc>`。
// LLM 扩写的 description_en 常以景别词开头（如 "medium shot captures..."），
// 会拼成 "A medium shot, medium shot captures..." 的重复。此处剥掉描述开头的景别词，
// 并同时吃掉紧随的标点，避免拼出 ", captures..." 这种逗号悬空。
//
// 只在「景别词 = 一个完整的名词短语（后面紧跟动词/逗号/介词）」时才剥；
// 若景别词后面还跟着名词（作定语，如 "the close-up shot is reviewed" / "wide shot frames" 里的 frames 是动词则照剥），
// 交给下方的动词白名单判断——命中动词才剥，否则保留，避免误伤正文。
const SHOT_SIZE_HEAD_RE = /^(?:a|an|the)?\s*(?:extreme\s+close-?up|medium\s+close-?up|close-?up|medium-?wide(?:\s+shot)?|extreme\s+wide(?:\s+shot)?|wide\s+shot|medium\s+shot|long\s+shot|establishing\s+shot|full\s+shot)\b/i
// 景别词后紧跟这些词，说明它在句中作主语的谓语（是陈述景别本身，可剥）
const SHOT_SIZE_FOLLOW_VERB_RE = /^\s*[\s,，:：\-—]*(?:captures?|capturing|frames?|framing|shows?|showing|establishes?|establishing|follows?|following|depicts?|depicting|reveals?|revealing|holds?|holding|renders?|opening|opens?|begins?|starts?|closes?|ends?|cuts?|fades?|pans?|tracks?|pushes?|pulls?|zooms?|tilts?|arcs?|is|are|was|were)\b/i
export function stripLeadingShotSize(desc) {
  const v = String(desc || '').trim()
  if (!v) return v
  const head = SHOT_SIZE_HEAD_RE.exec(v)
  if (!head) return v
  const rest = v.slice(head[0].length)
  // 情形一：景别词后直接跟标点（"medium shot, the woman..." / "close-up: her eyes..."）→ 剥
  // 情形二：景别词后无标点但紧跟谓语动词（"wide shot frames the riverbank"）→ 剥
  // 其余（"the close-up shot is reviewed" 中景别词作定语）→ 保留
  const afterPunct = /^[\s]*[,，:：\-—]/.test(rest)
  const stripped = rest.replace(/^[\s,，:：\-—]+/, '').trim()
  if (afterPunct) return stripped || v
  if (SHOT_SIZE_FOLLOW_VERB_RE.test(rest)) return stripped || v
  return v
}

export const CJK_DIRTY_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af\u3000-\u303f\ufe30-\ufe4f\ufe10-\ufe19\u2e80-\u2eff\u2f00-\u2fdf\u31c0-\u31ef\uff00-\uffef]/

// 景别强度序（越紧越大）：用于判定「描述里的景别词是否比 shot_type 更极端」。
// 根因（2026-09-27 实拍事故 1-3）：shot_type=特写 → shotSize="A close-up"，
// 而同一条 prompt 的 visualDesc 被 LLM 扩写成 "extreme close-up focuses on ... hands"，
// 拼出 "A close-up, extreme close-up focuses on ..." —— 两个景别词叠加且后者更极端，
// 尺度自相矛盾；同一 prompt 的 final_frame 又要求拍脸（facing forward, expression tense）。
// 模型被同时要求"极端特写拍手"与"中近景拍脸"，只能把五官挤变形。
// 解法：景别是分镜阶段的权威决策（shot_type 字段），描述里的景别词只应作修辞；
// 当描述里的景别比 shot_type 更极端时，按 shot_type 的档位把它降回同档或剔除——
// 让整条 prompt 的尺度只有一个权威来源，而不是靠事后校验去发现冲突。
const SHOT_SIZE_RANK = {
  'extreme wide': 0, 'extreme long': 0, 'long shot': 1, 'wide shot': 2,
  'medium-wide': 4, 'medium wide': 4, 'medium shot': 5, 'medium close-up': 7, 'medium close up': 7,
  'close-up': 8, 'close up': 8, 'extreme close-up': 9, 'extreme close up': 9,
}
const SHOT_SIZE_TOKEN_RE = /(extreme\s+close-?\s?up|medium\s+close-?\s?up|close-?\s?up|medium-?wide(?:\s+shot)?|extreme\s+wide(?:\s+shot)?|wide\s+shot|medium\s+shot|long\s+shot|establishing\s+shot|full\s+shot)/gi
function rankOfToken(token) {
  const k = String(token || '').toLowerCase().replace(/\s+/g, ' ').trim()
  return SHOT_SIZE_RANK[k]
}
// 把描述里「比基准景别更极端」的景别词降回基准档（更紧的改写成基准的写法），
// 基准档之上的（更松的）保持原样——描述比 shot_type 更松是合法的叙事铺垫，不算冲突。
// 占位角色名归一（2026-09-27）：分镜阶段产出的 world_state_*_en 由 LLM 自由书写，
// 实测出现「Character A / Character B」这类自造占位名（全库 6/19 镜），而资产库真实英文名是
// 资产表登记的英文名。后果：首帧/末帧硬约束里的主体名与 subject_definitions
// 的参考图标签对不上，模型当成两个不同角色处理——主体漂移与人物变形的直接来源之一。
// 修法是确定性归一，不是校验：中文 world_state 里的 @主体名 是权威，按出现顺序
// 把占位名逐一对位换成本镜真实角色的英文标签；对不上（主体少于占位）就不换，绝不瞎猜。
const PLACEHOLDER_SUBJECT_RE = /\bCharacter\s+[A-Z]\b/g
const ZH_SUBJECT_RE = /@?([^@：:·\n]{1,40}?)\s*[：:]/g
export function resolvePlaceholderSubjectNames(en, zh, zhToEn) {
  const src = String(en || '').trim()
  const zhSrc = String(zh || '').trim()
  if (!src || !zhSrc) return src
  const placeholders = [...new Set(src.match(PLACEHOLDER_SUBJECT_RE) || [])]
  if (!placeholders.length) return src
  const subjects = []
  for (const m of zhSrc.matchAll(ZH_SUBJECT_RE)) {
    const name = String(m[1] || '').trim()
    if (name) subjects.push(name)
  }
  if (!subjects.length) return src
  const enNames = subjects
    .map((n) => (typeof zhToEn === 'function' ? zhToEn(n) : n))
    .filter(Boolean)
  // 占位按字母序（A→第1个主体、B→第2个）与中文主体对位
  const ordered = [...placeholders].sort((a, b) => a.localeCompare(b))
  if (ordered.length > enNames.length) return src
  let out = src
  ordered.forEach((ph, i) => {
    out = out.split(ph).join(enNames[i])
  })
  return out.trim().replace(/\s{2,}/g, ' ')
}

export function reconcileShotSizeScale(desc, baseShotSizeEn) {
  const base = rankOfToken(baseShotSizeEn)
  if (base == null) return String(desc || '')
  return String(desc || '').replace(SHOT_SIZE_TOKEN_RE, (m) => {
    const r = rankOfToken(m)
    if (r == null || r <= base) return m
    return baseShotSizeEn
  })
}

export function pickEnglish(s) {
  const v = clean(s)
  return v && !CJK_DIRTY_RE.test(v) ? v : ''
}

const RESIDUAL_CJK_RE = new RegExp(CJK_DIRTY_RE.source + '+', 'g')

export function stripResidualCjk(s) {
  const v = clean(s)
  if (!v) return ''
  return v
    .replace(RESIDUAL_CJK_RE, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim()
}

const ASCII_LETTER_RE = /[A-Za-z]/

export function pickInjectableEnglish(s) {
  const v = stripResidualCjk(s)
  return v && ASCII_LETTER_RE.test(v) ? v : ''
}

export function resolveAssetName(nameEn, nameCn) {
  return pickEnglish(nameEn) || stripResidualCjk(nameEn) || pickEnglish(nameCn)
}

export function resolveDesc(descEn, descCn) {
  return lowerFirst(cleanDesc(pickEnglish(descEn) || pickEnglish(descCn)))
}

// —— 出片提示词的「身份识别特征」压缩（官方 ref2va subject_definitions 口径）——
// 依据（MiniMax 官方《Full-Reference Mode Rewrite Output Format Guide》，即 ref-en.txt）：
//   L37：subject_definitions 每条只需写「the main features to follow」（要跟随的主要特征），
//        而非复述完整外观；官方示例 L51 / L312-315 每条 130-165 字符。
//   L68：「If an image is used only to define a character, scene, costume, or style, do not
//        create a standalone picture entry. Instead, cite the image source inside the
//        corresponding <Subject N> definition.」
//        —— 即：定义用图的外观由图片本身承载，文字只给锚点与少量特征，
//           项目里 9 张图走 RunningHub 独立 image0~image8 节点，本就不占 ≤7000 字符预算。
// 背景：项目 description_en 是**生图**用的完整外观（实测 478-660 字符），出片原样复述后
// 4 refs 即吃掉 3029 字符、5 refs 约 3947，把官方 §5.2 要求的 detailed_description
//（生成任务 350-500 英文词 ≈2200-3100 字符）挤到 1476，是撑爆官方 ≤7000 的真正成因。
// 选取规则（确定性，无随机、无 LLM）：
//   P0 首句：品类/体型/物种/性别——资产按 xiaomo asset-rules 的固定要素顺序撰写，身份核心在前。
//   P1 服装/配饰句：串件（围巾/帽子跨角色漂移）是实测第一大漂移源，必须存活。
//   其余按原文顺序补足（原文顺序即要素重要度顺序），放不下则按子句边界截断。
//   硬约束：**只允许出现完整句或完整子句**。可选填充句凑不出完整子句时整句让位，绝不产出
//   半截英文——实测词边界退路会给出「Large rounded head with two small round ears set.」
//   「The slope runs.」「an old tree.」「stacked forest canopy spreading.」这类残缺句，
//   在 subject_definitions 的指令句流里会被当成未完成的指令读。按官方 L68「外观由参考图
//   承载」+ L37「只写 main features」，少一条完整特征优于给半句残句。
//   cap 取值须保证「身份特征句」（服装句、体色句等）存活——两只以上同形态角色时，
//   单边丢体色会加剧混淆。实测标定见 config.video.h3SubjectFeaturesCap 注释。
// 词表里刻意不含 crown/cap 等「头顶/盖子」多义词：实测某角色外观描述中 "the sides of the crown"
// 会被 crown 误命中，把体色句挤掉。声明"没有穿戴"的句子（No clothing and no accessories.）
// 同样是身份锚，必须一并纳入。
const GARMENT_RE = /\b(wears?|wearing|dressed|clad|scarf|scarves|cloak|cape|hood|hat|helm(?:et)?|armou?r|garment|clothing|accessories|attire|outfit|costume|collar|belt|boots?|gloves?|glasses|necklace|earrings?|bracelet|satchel|bag|sash|ribbon|coat|jacket|dress|shirt|tunic|apron|armband|bandana|mask|kimono|robe|suit|uniform)\b/i
const MIN_CLAUSE_CHARS = 24
// 词边界退路会留下半截尾巴（"runs up to the" / "fur with no"），收尾时反复剥掉这些悬空词
const DANGLING_TAIL_RE = /\s+(?:a|an|the|and|or|but|of|to|with|in|on|at|for|from|by|into|over|under|through|across|against|towards?|beneath|beside|behind|near|onto|upon|its|his|her|their|this|that|these|those|which|than|as|no|very|extremely|quite|slightly|faintly|softly|heavily|more|most|less|up|out|off|away|down)$/i

// 子句前缀：按 , ; 边界累加到 max 以内，返回完整子句拼成的前缀；凑不出任何完整子句则返回空串
function clausePrefix(s, max) {
  const v = String(s || '')
  if (v.length <= max) return v
  const clauses = v.split(/(?<=[;,])\s+/)
  let out = ''
  for (const c of clauses) {
    const piece = out ? `${out} ${c}` : c
    if (piece.length > max) break
    out = piece
  }
  return out.trim()
}

// 无子句边界可用时的最后退路（只用于单句资产）：退到词边界，宁可半截也不能整条落空
function truncateAtClause(s, max) {
  const out = clausePrefix(s, max)
  if (out) return out
  const v = String(s || '')
  const cut = v.slice(0, max)
  const i = cut.lastIndexOf(' ')
  return (i >= Math.floor(max * 0.5) ? cut.slice(0, i) : cut).trim()
}

export function identityFeatures(desc, cap = config.video?.h3SubjectFeaturesCap ?? 300) {
  const text = clean(String(desc || ''))
  if (!text) return ''
  const limit = Math.max(MIN_CLAUSE_CHARS, Number(cap) || 300)
  if (text.length <= limit) return text
  const sentences = text.split(/(?<=\.)\s+/).filter(Boolean)
  // 单句资产没有整句收口的余地：优先取子句前缀，无子句边界才退到词边界
  if (sentences.length <= 1) return finishFeatureText(truncateAtClause(text, limit))
  const first = sentences[0]
  // 服装句先按完整长度预留额度，其余内容只在剩余额度内按原文顺序填充——
  // 否则长填充句会把服装句整个挤掉（串件是实测第一大漂移源，不能让它被牺牲）。
  const garment = sentences.slice(1).find((s) => GARMENT_RE.test(s))
  const fillLimit = Math.max(first.length, limit - (garment ? garment.length + 1 : 0))
  let joined = first
  for (const s of sentences.slice(1)) {
    if (s === garment) continue
    if (joined.length + 1 + s.length <= fillLimit) { joined += ` ${s}`; continue }
    const room = fillLimit - joined.length - 1
    if (room >= MIN_CLAUSE_CHARS) joined = appendFeature(joined, clausePrefix(s, room))
    break
  }
  if (garment) {
    const room = limit - joined.length - 1
    if (room >= garment.length) joined = appendFeature(joined, garment)
    else if (room >= MIN_CLAUSE_CHARS) joined = appendFeature(joined, clausePrefix(garment, room))
  }
  return finishFeatureText(joined)
}

// 拼接前先把片段收成完整句：截断片段若带着悬空介词（"ears set against"）直接接下一句，
// 会被读成反义（"ears set against no clothing"）——每个片段独立断句即可避免。
function appendFeature(base, piece) {
  const tail = finishFeatureText(piece)
  return tail ? `${base} ${tail}` : base
}

// 收尾：剥悬空尾词与连接标点、补句号，保证拼进 <Subject N> 定义行后是完整句
function finishFeatureText(s) {
  let v = String(s || '').trim()
  for (let i = 0; i < 4; i++) {
    const next = v.replace(DANGLING_TAIL_RE, '').replace(/[,;:\s]+$/, '').trim()
    if (next === v || !next) break
    v = next
  }
  if (!v) return ''
  return /[.!?]$/.test(v) ? v : `${v}.`
}

export function normalizeTone(t) {
  const v = clean(t)
  if (!v) return ''
  if (/^(in|with|through|at|while)\b/i.test(v)) return v
  if (/ly$/i.test(v)) return v
  return `in a ${v.replace(/\s+tone$/i, '')} tone`
}

const ARTICLE_REPEAT_PAIRS = [
  [/\b(the)\s+the\b/gi, 'the'],
  [/\b(a)\s+a\b/gi, 'a'],
  [/\b(an)\s+an\b/gi, 'an'],
]

export function dedupeArticles(s) {
  let out = String(s || '')
  let prev = ''
  while (prev !== out) {
    prev = out
    for (const [re, rep] of ARTICLE_REPEAT_PAIRS) out = out.replace(re, rep)
  }
  return out.replace(/\s+/g, ' ').trim()
}

export function truncateStyle(s, max = 300) {
  const v = clean(s)
  if (v.length <= max) return v
  const cut = v.slice(0, max)
  const i = cut.lastIndexOf(' ')
  return i >= max * 0.5 ? cut.slice(0, i) : cut
}

export function formatCutTimestamp(sec) {
  const t = Math.max(0, Math.round(Number(sec) * 1000))
  const total = Math.floor(t / 1000)
  const mmm = String(t % 1000).padStart(3, '0')
  const mm = String(Math.floor(total / 60)).padStart(2, '0')
  const ss = String(total % 60).padStart(2, '0')
  return `${mm}:${ss}.${mmm}`
}

export function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const AUDIO_MIME_MAP = {
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
  ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', webm: 'audio/webm',
  wma: 'audio/x-ms-wma', amr: 'audio/amr', mpeg: 'audio/mpeg',
}

export function mimeFromExt(filename) {
  const ext = (String(filename || '').split('.').pop() || '').toLowerCase()
  if (AUDIO_MIME_MAP[ext]) return AUDIO_MIME_MAP[ext]
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  return 'image/png'
}

export function netErrMsg(e) {
  const cause = e?.cause?.code || e?.cause?.message
  return cause ? `${e.message} (${cause})` : e?.message
}

export function removeLocalUploads(urls, uploadDir) {
  const root = path.resolve(uploadDir)
  for (const u of urls || []) {
    if (!u || !String(u).startsWith(UPLOADS_URL_SLASH)) continue
    try {
      const rel = decodeURIComponent(String(u).split(/[?#]/)[0]).replace(UPLOADS_PREFIX_RE, '')
      const abs = path.resolve(root, rel)
      if (abs !== root && !abs.startsWith(root + path.sep)) continue
      fs.rmSync(abs, { force: true })
    } catch {  }
  }
}

export function uploadsUrlToAbs(url, uploadDir) {
  if (!url || typeof url !== 'string' || !url.startsWith(UPLOADS_URL_SLASH)) return null
  try {
    const root = path.resolve(uploadDir)
    const rel = decodeURIComponent(String(url).split(/[?#]/)[0]).replace(UPLOADS_PREFIX_RE, '')
    if (!rel) return null
    const abs = path.resolve(root, rel)
    if (abs !== root && !abs.startsWith(root + path.sep)) return null
    return fs.existsSync(abs) ? abs : null
  } catch {
    return null 
  }
}

export function extractFirstJson(text) {
  const t = String(text == null ? '' : text)
  const start = t.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inStr = false
  let escaped = false
  for (let i = start; i < t.length; i++) {
    const ch = t[i]
    if (inStr) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return t.slice(start, i + 1)
    }
  }
  return null
}

export function parseJsonLoose(raw, fallback) {
  const text = String(raw == null ? '' : raw)
  const candidates = [text, extractFirstJson(text)]
  for (const c of candidates) {
    if (!c) continue
    try {
      return JSON.parse(c)
    } catch { }
  }
  if (fallback === undefined) throw new Error('返回内容不是合法 JSON')
  return fallback
}

export function parseDefectReview(raw, allowedTypes = [], defaultType = '') {
  try {
    const parsed = parseJsonLoose(raw, null)
    if (!parsed) return { defects: [], summary: '' }
    const fallback = defaultType || allowedTypes[0] || ''
    const defects = Array.isArray(parsed.defects)
      ? parsed.defects
          .filter((d) => d && typeof d.type === 'string')
          .map((d) => ({
            type: allowedTypes.includes(d.type) ? d.type : fallback,
            evidence: String(d.evidence || '').slice(0, 200),
          }))
      : []
    return { defects, summary: String(parsed.summary || '').slice(0, 200) }
  } catch {
    return { defects: [], summary: '' }
  }
}

export function filterUnreferencedUploadUrls(urls) {
  const candidates = [...new Set((urls || []).map(String).filter((u) => u.startsWith(UPLOADS_URL_SLASH)))]
  if (!candidates.length) return []
  const referenced = new Set()
  for (const sql of uploadRefGlobalSql()) {
    try {
      for (const row of query(sql)) { if (row.u) referenced.add(row.u) }
    } catch {  }
  }
  return candidates.filter((u) => !referenced.has(u))
}


function isPrivateIPv4(ip) {
  const p = String(ip).split('.').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = p
  if (a === 0) return true                              
  if (a === 10) return true                             
  if (a === 127) return true                            
  if (a === 169 && b === 254) return true               
  if (a === 172 && b >= 16 && b <= 31) return true      
  if (a === 192 && b === 168) return true               
  if (a === 192 && b === 0 && p[2] === 0) return true   
  if (a === 100 && b >= 64 && b <= 127) return true     
  if (a === 198 && (b === 18 || b === 19)) return true  
  if (a >= 224) return true                             
  return false
}

function hexGroupsToIPv4(rest) {
  const gs = String(rest).split(':').filter(Boolean)
  if (gs.length < 2) return ''
  const hi = parseInt(gs[gs.length - 2], 16)
  const lo = parseInt(gs[gs.length - 1], 16)
  if (!Number.isInteger(hi) || !Number.isInteger(lo) || hi < 0 || lo < 0) return ''
  return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`
}

function isPrivateIPv6(ip) {
  const s = String(ip).toLowerCase().replace(/^\[|\]$/g, '')
  if (s === '::' || s === '::1') return true            
  if (s.startsWith('fe80')) return true                 
  if (s.startsWith('fec0')) return true                 
  if (/^f[cd]/.test(s)) return true                     
  if (s.startsWith('ff')) return true                   

  const mapped = s.match(/^::ffff:(.+)$/) || s.match(/^::(?!1$|ffff:)(.+)$/)
  if (mapped) {
    const rest = mapped[1]
    const v4 = rest.includes('.') ? rest : hexGroupsToIPv4(rest)
    if (!v4 || isIP(v4) !== 4) return true
    return isPrivateIPv4(v4)
  }
  return false
}

export async function assertSafeDownloadTarget(rawUrl, allowHosts = []) {
  let u
  try {
    u = new URL(String(rawUrl))
  } catch {
    throw new Error(`下载地址不是合法 URL：${String(rawUrl).slice(0, 120)}`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`下载地址协议不受支持（仅允许 http/https）：${u.protocol}`)
  }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()

  if (allowHosts.some((h) => host === h || host.endsWith('.' + h))) return

  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/.test(host)) {
    throw new Error(`下载地址指向本机/内网主机名，已拒绝（SSRF 防护）：${host}`)
  }

  const ipVer = isIP(host)
  if (ipVer === 4) {
    if (isPrivateIPv4(host)) throw new Error(`下载地址指向内网/保留 IP，已拒绝（SSRF 防护）：${host}`)
    return
  }
  if (ipVer === 6) {
    if (isPrivateIPv6(host)) throw new Error(`下载地址指向内网/保留 IP，已拒绝（SSRF 防护）：${host}`)
    return
  }

  let addrs = []
  try {
    addrs = await lookup(host, { all: true })
  } catch (e) {
    throw new Error(`下载地址无法解析：${host}（${e?.code || e?.message || 'DNS 失败'}）`)
  }
  if (!addrs.length) throw new Error(`下载地址无法解析：${host}`)
  for (const a of addrs) {
    const bad = a.family === 4 ? isPrivateIPv4(a.address) : isPrivateIPv6(a.address)
    if (bad) throw new Error(`下载地址解析到内网/保留 IP，已拒绝（SSRF 防护）：${host} → ${a.address}`)
  }
}

