import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chatCompletion } from './doubao.js'

const tasksDirForBackup = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tasks')

const CANONICAL_SCENE_RE = /^场次[一二三四五六七八九十\d]+[：:]\s*(.+)/

const VARIANT_SCENE_RES = [
  /^[\t ]*【\s*场次\s*[^】]*】[\t ]*[：:]?[\t ]*(.*)$/,
  /^[\t ]*===\s*场次\s*[^=]*?===[\t ]*[：:]?[\t ]*(.*)$/,
  /^[\t ]*第\s*[0-9一二三四五六七八九十百]+\s*场[\t ]*[：:、.\-～—\s][\t ]*(.*)$/,
  /^[\t ]*Scene\s*\d+[\t ]*[：:\-.]?[\t ]*(.*)$/i,
  /^场次[一二三四五六七八九十\d]+[ \t]+(.+)$/,
]

const DIALOGUE_LINE_RE = /^[\t ]*([^（\t:：""]+?)(（([^）]+)）)?[\t\s]*[：:]?[\t ]*["“]([^”"]*)["”][\t ]*$/

const LLM_SPLIT_MIN_LENGTH = 600
const LLM_SPLIT_MAX_LENGTH = 4000

const SCENE_LINE_RE = /^[\t ]*场次\s*([一二三四五六七八九十\d]+)\s*[：:\s]\s*(.+)$/

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
  if (!scenes.length && String(script || '').trim()) {
    scenes.push({ sceneNumber: 1, title: '', text: String(script).trim() })
  }
  return scenes.map((s) => ({ ...s, text: s.text.trim() }))
}

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

export function normalizeScriptFormat(script) {
  const text = String(script || '').replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  const sceneLines = detectSceneLines(lines)

  if (sceneLines.length === 0) {
    const { lines: normalized, speakers } = normalizeDialogueLines(lines)
    const header = ['场次1：（标题待补）']
    if (speakers.length) {
      header.push('', `场景：（待补充：内景/外景·地点·时间·天气）`, `人物：${speakers.join('、')}`)
    }
    const framed = [...header, '', ...normalized, ''].join('\n')
    return { text: framed, changed: true, status: 'none' }
  }

  if (sceneLines.every((s) => s.canonical)) {
    return { text, changed: false, status: 'standard' }
  }

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

export async function ensureStandardScript(script, opts = {}) {
  const original = String(script || '')
  if (!original.trim()) return { text: original, changed: false, method: 'standard' }

  let result = normalizeScriptFormat(original)
  if (result.status === 'standard') {
    return { text: result.text, changed: false, method: 'standard' }
  }
  if (result.status === 'variant') {
    return { text: result.text, changed: true, method: 'regex' }
  }

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
    }
  }
  return { text: framedText, changed: true, method: 'regex' }
}

function backupOriginalScript(original, episodeId, tag) {
  try {
    if (!fs.existsSync(tasksDirForBackup)) fs.mkdirSync(tasksDirForBackup, { recursive: true })
    const file = path.join(tasksDirForBackup, `script-original-${episodeId || 'unknown'}-${Date.now()}-${tag}.txt`)
    fs.writeFileSync(file, original, 'utf8')
  } catch {
  }
}
