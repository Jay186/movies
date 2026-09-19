// 剧本格式识别与归一化
// 目标：任何来源的剧本（AI 生成 / 手写 / 外部粘贴）在进入流水线（确认剧本）时，
// 都被转成主链路可解析的标准格式——行首「场次N：标题」标记（project.js 与 doubao.js 的解析口径）。
// 原则：正文内容一字不改；只重写标记行、规整可识别的对白行、必要时补场次框架。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chatCompletion } from './doubao.js'

const tasksDirForBackup = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tasks')

// 标准场次标记（与 src/stores/project.js / doubao.js 同口径）
const CANONICAL_SCENE_RE = /^场次[一二三四五六七八九十\d]+[：:]\s*(.+)/

// 常见变体标记：【场次N】 / ===场次N=== / 第N场 / Scene N（与导入对话框口径一致）
// 「场次N 标题」空格分隔无冒号写法也归入变体：确认剧本时统一重写成「场次N：标题」标准格式，
// 避免下游只认冒号的解析链（分场生成/场次硬约束）静默失效
const VARIANT_SCENE_RES = [
  /^[\t ]*【\s*场次\s*[^】]*】[\t ]*[：:]?[\t ]*(.*)$/,
  /^[\t ]*===\s*场次\s*[^=]*?===[\t ]*[：:]?[\t ]*(.*)$/,
  /^[\t ]*第\s*[0-9一二三四五六七八九十百]+\s*场[\t ]*[：:、.\-～—\s][\t ]*(.*)$/,
  /^[\t ]*Scene\s*\d+[\t ]*[：:\-.]?[\t ]*(.*)$/i,
  /^场次[一二三四五六七八九十\d]+[ \t]+(.+)$/,
]

// 对白行：角色（情绪）＋ 引号台词，如「布布（压抑）	"你还想不想谈了？"
const DIALOGUE_LINE_RE = /^[\t ]*([^（\t:：""]+?)(（([^）]+)）)?[\t\s]*[：:]?[\t ]*["“]([^”"]*)["”][\t ]*$/

// 超过该长度的无标记剧本交给 LLM 切分场次，否则按单场次框架处理
const LLM_SPLIT_MIN_LENGTH = 600
// LLM 切分适用的长度上限：更长文本单次输出易截断，退回单场次框架
const LLM_SPLIT_MAX_LENGTH = 4000

// ===== 剧本切场（共用出口，2026-09-16）=====
// 为什么收口在这里：场次正则此前在 7 处各写一份（doubao / scriptFormat / episodes 路由 /
// 前端 project.js / ScriptView / StyleStepView），口径还不完全一致——检查类代码用哪一份、
// 是否与落库用的一致，全靠人记。事理检查（continuityGuard 接入质检面板）需要按**剧本的**
// 场次切块，若自己再抄一份正则，就会出现"检查按 A 口径切、落库按 B 口径切"的分裂。
// 故统一从本函数取，判据集中一处。
//
// 与 doubao.parseScriptSceneBlocks 的区别：那边服务的是"喂给模型的分场调用"，
// 额外做了 trim 与 title 提取；这里返回带场次号的结构，供检查类代码逐场比对。
// 两者共用同一行首正则口径（冒号或空白分隔），改一处必须同步另一处。
const SCENE_LINE_RE = /^[\t ]*场次\s*([一二三四五六七八九十\d]+)\s*[：:\s]\s*(.+)$/

/**
 * 按场次标记把剧本切成场次数组（供检查 / 统计类代码使用）。
 * 场次号取标记里的序号；无法解析为数字时按出现顺序递增。
 * 无任何场次标记时：整本作为单场返回（宁少不误——不臆造场次边界）。
 *
 * @param {string} script 剧本正文
 * @returns {Array<{sceneNumber:number, title:string, text:string}>} text 含场次标题行及其后正文
 */
export function splitScriptScenes(script) {
  const lines = String(script || '').replace(/\r\n/g, '\n').split('\n')
  const scenes = []
  let current = null
  let seq = 0
  for (const line of lines) {
    const m = line.match(SCENE_LINE_RE)
    if (m) {
      if (current) scenes.push(current)
      seq++
      current = {
        sceneNumber: chineseNumeralToInt(m[1]) ?? seq,
        title: m[2].trim(),
        text: line + '\n',
      }
    } else if (current) {
      current.text += line + '\n'
    }
  }
  if (current) scenes.push(current)
  // 无标记：整本单场
  if (!scenes.length && String(script || '').trim()) {
    scenes.push({ sceneNumber: 1, title: '', text: String(script).trim() })
  }
  return scenes.map((s) => ({ ...s, text: s.text.trim() }))
}

/** 中文数字 → 整数（仅支持剧本场次号的常见写法：一~九十九）；解析失败返回 null */
function chineseNumeralToInt(s) {
  const t = String(s || '').trim()
  if (/^\d+$/.test(t)) return Number(t)
  const digits = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  if (t === '十') return 10
  let m = /^十([一二三四五六七八九])$/.exec(t)
  if (m) return 10 + digits[m[1]]
  m = /^([一二三四五六七八九])十([一二三四五六七八九])?$/.exec(t)
  if (m) return digits[m[1]] * 10 + (m[2] ? digits[m[2]] : 0)
  return digits[t] ?? null
}

/**
 * 逐行识别场次标记
 * @returns {Array<{index: number, title: string, canonical: boolean}>}
 */
function detectSceneLines(lines) {
  const found = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const canonical = line.match(CANONICAL_SCENE_RE)
    if (canonical) {
      found.push({ index: i, title: canonical[1].trim(), canonical: true })
      continue
    }
    for (const re of VARIANT_SCENE_RES) {
      const m = line.match(re)
      if (m) {
        found.push({ index: i, title: (m[1] || '').trim(), canonical: false })
        break
      }
    }
  }
  return found
}

/**
 * 规整对白行：统一成「角色（情绪）："台词"」，未匹配的行原样保留
 */
function normalizeDialogueLines(lines) {
  let touched = false
  const out = lines.map((line) => {
    const m = line.match(DIALOGUE_LINE_RE)
    if (!m) return line
    const name = m[1].trim()
    if (!name) return line
    const emotion = m[3] ? `（${m[3]}）` : ''
    const normalized = `${name}${emotion}："${m[4]}"`
    if (normalized !== line) touched = true
    return normalized
  })
  return { lines: out, touched, speakers: collectSpeakers(lines) }
}

function collectSpeakers(lines) {
  const speakers = []
  for (const line of lines) {
    const m = line.match(DIALOGUE_LINE_RE)
    const name = m?.[1]?.trim()
    if (name && !speakers.includes(name)) speakers.push(name)
  }
  return speakers
}

/**
 * 同步归一化（纯正则，无网络请求）
 * @returns {{ text: string, changed: boolean, status: 'standard'|'variant'|'none' }}
 */
export function normalizeScriptFormat(script) {
  const text = String(script || '').replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  const sceneLines = detectSceneLines(lines)

  if (sceneLines.length === 0) {
    // 无任何场次标记：规整对白行后，补「场次1」框架
    const { lines: normalized, speakers } = normalizeDialogueLines(lines)
    const header = ['场次1：（标题待补）']
    if (speakers.length) {
      header.push('', `场景：（待补充：内景/外景·地点·时间·天气）`, `人物：${speakers.join('、')}`)
    }
    const framed = [...header, '', ...normalized, ''].join('\n')
    return { text: framed, changed: true, status: 'none' }
  }

  if (sceneLines.every((s) => s.canonical)) {
    // 已是标准格式：原样返回，不做任何改动
    return { text, changed: false, status: 'standard' }
  }

  // 存在变体标记：按行序重写所有标记行（含标准行，统一连续编号），正文只做对白行规整
  const markerByIndex = new Map(sceneLines.map((s) => [s.index, s]))
  const { lines: dialogueNormalized } = normalizeDialogueLines(lines)
  const out = dialogueNormalized.map((line, i) => {
    if (!markerByIndex.has(i)) return line
    const seq = sceneLines.findIndex((s) => s.index === i) + 1
    const title = markerByIndex.get(i).title || '（标题待补）'
    return `场次${seq}：${title}`
  })
  return { text: out.join('\n'), changed: true, status: 'variant' }
}

/**
 * LLM 兜底：为无标记长剧本插入场次标记（只插入，不改写正文）
 */
async function splitScenesWithLLM(script) {
  const messages = [
    {
      role: 'system',
      content: `你是剧本格式化助手。下面这份剧本没有任何场次标记。请在场景切换的合适位置插入场次标记行，规则：
- 标记行格式严格为「场次N：标题」，N 从 1 开始连续递增
- 只允许插入标记行，正文内容一字不改、不删不增、不调整顺序、不添加任何其他文字
- 标题根据该场内容概括（2-8 个字）
- 直接输出插入标记后的完整剧本，不要任何解释或前后缀`,
    },
    { role: 'user', content: script },
  ]
  return chatCompletion(messages, { temperature: 0.2, maxTokens: 6000 })
}

/**
 * 确保剧本为标准格式（确认剧本前的最后一道关口，绝不抛错、绝不返回空文本）
 * @param {string} script - 原始剧本文本
 * @param {Object} [opts]
 * @param {string|number} [opts.episodeId] - 用于 LLM 改写前备份原文件命名
 * @returns {Promise<{text: string, changed: boolean, method: 'standard'|'regex'|'llm'}>}
 */
export async function ensureStandardScript(script, opts = {}) {
  const original = String(script || '')
  if (!original.trim()) return { text: original, changed: false, method: 'standard' }

  // 第一步：纯正则归一化（覆盖：标准稿直通、变体标记改写、无标记稿补框架）
  let result = normalizeScriptFormat(original)
  if (result.status === 'standard') {
    return { text: result.text, changed: false, method: 'standard' }
  }
  if (result.status === 'variant') {
    return { text: result.text, changed: true, method: 'regex' }
  }

  // 第二步：无标记剧本——长文尝试 LLM 切分，失败或超长则退回单场次框架
  const bodyLength = result.text.replace(/\s/g, '').length
  const framedText = result.text
  if (bodyLength >= LLM_SPLIT_MIN_LENGTH && bodyLength <= LLM_SPLIT_MAX_LENGTH) {
    try {
      const llmText = await splitScenesWithLLM(framedText)
      const hasMarker = String(llmText || '')
        .split('\n')
        .some((l) => CANONICAL_SCENE_RE.test(l))
      const notTruncated = String(llmText || '').replace(/\s/g, '').length >= bodyLength * 0.6
      if (hasMarker && notTruncated) {
        backupOriginalScript(original, opts.episodeId, 'llm-split')
        return { text: llmText.trim() + '\n', changed: true, method: 'llm' }
      }
    } catch {
      // LLM 不可用时不阻塞确认流程，退回单场次框架
    }
  }
  return { text: framedText, changed: true, method: 'regex' }
}

// LLM 改写有覆盖正文的风险，改写前把原文落盘备份（与 tasks 目录里其他诊断文件同惯例）
function backupOriginalScript(original, episodeId, tag) {
  try {
    if (!fs.existsSync(tasksDirForBackup)) fs.mkdirSync(tasksDirForBackup, { recursive: true })
    const file = path.join(tasksDirForBackup, `script-original-${episodeId || 'unknown'}-${Date.now()}-${tag}.txt`)
    fs.writeFileSync(file, original, 'utf8')
  } catch {
    // 备份失败不影响主流程
  }
}
