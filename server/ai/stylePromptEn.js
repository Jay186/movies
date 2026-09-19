
import { chatCompletion } from './doubao.js'
import { CJK_DIRTY_RE } from './shared.js'

const MIN_WORDS = 8
const MAX_WORDS = 90


function sanitize(raw) {
  let s = String(raw ?? '').trim()
  s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '')
  for (let i = 0; i < 3; i++) {
    const before = s
    s = s.replace(/^\s*(english|translation|英文|翻译|output)\s*[:：]\s*/i, '')
    if (s === before) break
  }
  s = s.replace(/[‘’]/g, "'").replace(/[“”]/g, '')
  s = s.replace(/^["']+/, '').replace(/["']+$/, '')
  s = s.replace(/"/g, '')
  s = s.replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim()
  s = s.replace(/[。.]+$/, '').trim()
  return s
}

export function validateStyleEn(en) {
  const s = String(en || '').trim()
  if (!s) return { ok: false, reason: '空串' }
  if (CJK_DIRTY_RE.test(s)) return { ok: false, reason: '含中日韩字符' }
  if (/["“”]/.test(s)) return { ok: false, reason: '含双引号（可能被当成画面文字定界符）' }
  if (/[`<>{}]/.test(s)) return { ok: false, reason: '含标签/代码符号' }
  const words = s.split(/\s+/).filter(Boolean)
  if (words.length < MIN_WORDS) return { ok: false, reason: `词数过少（${words.length} < ${MIN_WORDS}）` }
  if (words.length > MAX_WORDS) return { ok: false, reason: `词数过多（${words.length} > ${MAX_WORDS}）` }
  return { ok: true, reason: '' }
}

const SYSTEM_PROMPT = `你是影视 AI 生成管线的「画风提示词翻译器」。把中文画风描述译成英文「画风锚」，它会作为英文 prompt 的画风段喂给视频生成模型。

硬性要求：
1. 只输出英文本身。不要解释、不要前缀（如 English:）、不要引号、不要 markdown 代码块。
2. 用逗号分隔的短语罗列画面风格属性：媒介/技法、光照、色调、材质肌理、氛围、渲染特征。
3. 忠实保留原文的全部风格属性：不新增原文没有的元素，也不遗漏。
4. 原文若夹带「个别角色的外貌细节」（发型、五官、服装款式、身材等），只保留其中代表整体渲染风格的成分，不要逐条翻译角色外貌——角色外观由角色卡负责，不该占用画风段。
5. 控制在 20-60 个英文单词，单行输出。
6. 不得出现任何中日韩字符。`

export async function translateStylePrompt({ label = '', labelEn = '', prompt = '', model } = {}) {
  const zh = String(prompt || '').trim()
  if (!zh) return { ok: false, en: '', reason: '中文提示词为空', attempts: 0 }

  const user = `画风名称：${label || '(未命名)'}\n英文名：${labelEn || '(无)'}\n中文画风描述：\n${zh}`

  let lastReason = ''
  let lastRaw = ''
  for (let attempt = 1; attempt <= 2; attempt++) {
    let raw = ''
    try {
      const msgs = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: user },
      ]
      if (attempt === 2 && lastRaw) {
        msgs.push({ role: 'assistant', content: lastRaw })
        msgs.push({ role: 'user', content: `上一次输出不合格（${lastReason}）。请重新输出，只给英文风格短语，无引号、无解释、无中日韩字符。` })
      }
      raw = await chatCompletion(msgs, {
        ...(model ? { model } : {}),
        temperature: 0.3,
        maxTokens: 500,
        timeoutMs: 60000,
        disableThinking: true,
        usageContext: { task: 'style-prompt-en' },
      })
    } catch (e) {
      lastReason = `调用失败：${e.message}`
      continue
    }
    const en = sanitize(raw)
    const v = validateStyleEn(en)
    if (v.ok) return { ok: true, en, reason: '', attempts: attempt }
    lastReason = v.reason
    lastRaw = String(raw || '').trim().slice(0, 600)
  }

  return { ok: false, en: '', reason: lastReason || '未知原因', attempts: 2 }
}
