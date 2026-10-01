import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'
import { getEffectiveLlm } from '../modelConfig.js'
import { openaiChatUrl } from './openaiUrl.js'
import { logAiCall, classifyError } from './aiLog.js'
import { compileIntegratedModules, canonicalizeImdCharacterNames } from './imdCompiler.js'
import { extractScreenSides, hasExplicitReposition } from './storyboardValidator.js'
import { estimateH3ShotVideoPromptChars as estimateShotVideoPromptChars, h3ProviderProfile } from '../storyboard/providers/h3.js'
import { PHASE } from './progressPhases.js'
import { pickContainmentCandidate } from './propNameMatch.js'
import {
  assetNameRule, characterCoverageRule, integratedModulesRule,
  beatLayerRule, cameraBeatRule, cinematographyRule,
  holdRule, editRule,
  frameGeographyRule, styleLockRule,
  stagingRule, pointOfViewRule, cameraCraftRule,
} from './storyboardRules.js'
import { loadSkillRules } from './skillRules.js'
import { buildStoryboardContract, buildH3PhysicsBlock, buildSpaceTypeTable } from './skillContract.js'
import { validateStoryboardImport, formatStoryboardValidationError } from './storyboardContractValidator.js'



const BLOCKING_STAGE = { aspectRatio: '9:16', width: 540, height: 960 }

const LLM_MAX_CONCURRENT = config.llm.maxConcurrent
let llmActive = 0
const llmWaiters = []
function acquireLlm() {
  if (llmActive < LLM_MAX_CONCURRENT) { llmActive++; return Promise.resolve() }
  return new Promise((resolve) => llmWaiters.push(resolve))
}
function releaseLlm() {
  if (llmWaiters.length) { llmWaiters.shift()(); return }
  llmActive = Math.max(0, llmActive - 1)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const thinkingLockedModels = new Set()

async function readChatResponse(res, stream) {
  if (!stream || !String(res.headers.get('content-type') || '').includes('text/event-stream')) {
    const data = await res.json()
    return {
      message: data.choices?.[0]?.message,
      finishReason: String(data.choices?.[0]?.finish_reason || ''),
      usage: data.usage || {},
    }
  }

  const reader = res.body?.getReader()
  if (!reader) throw Object.assign(new Error('模型流式响应没有可读取的正文'), { code: 'content' })
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let reasoning = ''
  let finishReason = ''
  let usage = {}
  const consume = (event) => {
    const payload = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n')
    if (!payload || payload === '[DONE]') return
    let data
    try { data = JSON.parse(payload) } catch { return }
    const choice = data.choices?.[0]
    const delta = choice?.delta || choice?.message || {}
    const deltaContent = delta.content
    if (Array.isArray(deltaContent)) {
      content += deltaContent.map((part) => typeof part === 'string' ? part : (part?.text || part?.content || '')).join('')
    } else if (typeof deltaContent === 'string') {
      content += deltaContent
    }
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content
    if (choice?.finish_reason) finishReason = String(choice.finish_reason)
    if (data.usage) usage = data.usage
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
      const events = buffer.split(/\r?\n\r?\n/)
      buffer = events.pop() || ''
      for (const event of events) consume(event)
      if (done) break
    }
    if (buffer) consume(buffer)
  } finally {
    reader.releaseLock()
  }
  return { message: { content, reasoning_content: reasoning }, finishReason, usage }
}

export async function chatCompletion(messages, options = {}) {
  // 运行时读取（AI 模型配置热生效）：Key / baseURL / 模型均不再走 config 快照
  const { apiKey, baseURL, model: effectiveModel, configured } = getEffectiveLlm()
  if (!configured) {
    throw Object.assign(new Error('文本大模型未配置：请在「AI 模型配置」里为「文本通道」填写 API Key'), { status: 400 })
  }

  const model = options.model || effectiveModel
  const body = {
    model,
    messages,
    temperature: options.temperature ?? 0.7,
    max_tokens: options.maxTokens ?? 4000,
  }
  if (options.stream) body.stream = true
  if (options.responseFormat) body.response_format = options.responseFormat
  if ((options.responseFormat?.type === 'json_object' || options.disableThinking) && !thinkingLockedModels.has(model)) {
    body.enable_thinking = false
  }

  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 120000)
  const maxAttempts = Math.max(1, Number(options.maxAttempts) || 3)
  // 重试总预算必须独立于单次超时，否则一次分场请求可能连续挂起数次。
  const retryBudgetMs = Math.max(timeoutMs, Number(options.retryBudgetMs) || timeoutMs * maxAttempts)
  const deadline = Date.now() + retryBudgetMs
  const task = options.usageContext?.task || ''
  const episodeId = options.usageContext?.episodeId
  const startedAt = Date.now()
  let lastErr = null

  await acquireLlm()
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        lastErr = Object.assign(new Error(`AI 请求超过重试总时长（${Math.round(retryBudgetMs / 1000)} 秒）`), { code: 'timeout' })
        break
      }
      const controller = new AbortController()
      const timeoutTimer = setTimeout(() => controller.abort(), Math.min(timeoutMs, remainingMs))
      let res, httpStatus
      try {
        res = await fetch(openaiChatUrl(baseURL), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        httpStatus = res.status
      } catch (e) {
        clearTimeout(timeoutTimer)
        const { family, message } = classifyError(e)
        lastErr = Object.assign(new Error(message), { code: family, status: 0 })
        if (family !== 'timeout' && family !== 'rate_limit' && family !== 'server') break
        if (attempt < maxAttempts) {
          await sleep(1000 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 300))
          continue
        }
        break
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        clearTimeout(timeoutTimer)
        if (httpStatus === 400 && body.enable_thinking === false
          && /enable_thinking parameter is restricted to True/i.test(errText)) {
          thinkingLockedModels.add(model)
          delete body.enable_thinking
          console.warn(`[chatCompletion] 模型 ${model} 服务端强制思考（不可关闭），已记住并去掉 enable_thinking 重试`)
          attempt--
          continue
        }
        const { family, message } = classifyError(new Error(`status ${httpStatus}: ${errText}`), httpStatus)
        lastErr = Object.assign(new Error(`${message} (${httpStatus})`), {
          code: family, status: httpStatus, raw: String(errText).slice(0, 500),
        })
        // timeout 也要重试：上游网关超时（如 Cloudflare 524，100s 内源站未响应）
        // 与本地 AbortError 同属偶发可重试错误；网络层超时已重试，HTTP 层保持一致。
        if ((family === 'rate_limit' || family === 'server' || family === 'timeout') && attempt < maxAttempts) {
          await sleep(1000 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 300))
          continue
        }
        break
      }

      let responseData
      try {
        responseData = await readChatResponse(res, options.stream === true)
      } catch (e) {
        const { family, message } = classifyError(e)
        lastErr = Object.assign(new Error(message), { code: family, status: 0 })
        if ((family === 'timeout' || family === 'server') && attempt < maxAttempts) {
          await sleep(1000 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 300))
          continue
        }
        break
      } finally {
        clearTimeout(timeoutTimer)
      }
      const { message, finishReason, usage } = responseData
      const content = message?.content

      let text = ''
      if (Array.isArray(content)) {
        text = content
          .map((part) => typeof part === 'string' ? part : (part?.text || part?.content || ''))
          .join('')
          .trim()
      } else if (typeof content === 'string' && content.trim()) {
        text = content.trim()
      } else if (typeof message?.reasoning_content === 'string' && message.reasoning_content.trim()) {
        // reasoning_content 不是业务正文，不能拿来当分镜 JSON 解析。
        const detail = finishReason === 'length'
          ? '大模型思考阶段耗尽输出预算，未返回正文，请确认已关闭思考或提高输出预算'
          : '大模型只返回了思考内容，未返回正文，请检查模型的思考参数'
        lastErr = Object.assign(new Error(detail), { code: 'content', status: 0 })
        break
      } else {
        lastErr = Object.assign(new Error('大模型未返回正文内容'), { code: 'content', status: 0 })
        break 
      }

      logAiCall({
        kind: 'llm', model, episodeId, task,
        inTokens: usage.prompt_tokens, outTokens: usage.completion_tokens,
        latencyMs: Date.now() - startedAt, success: true,
      })
      if (options.returnMeta) return { text, finishReason }
      return text
    }

    const fam = lastErr?.code || 'unknown'
    logAiCall({
      kind: 'llm', model, episodeId, task,
      latencyMs: Date.now() - startedAt, success: false,
      errorFamily: fam, errorMsg: lastErr?.raw ? `${lastErr.message} | 服务端原文: ${lastErr.raw}` : lastErr?.message,
    })
    // 单档模型：不再区分主/轻/视觉，失败后不再回退到其他模型
    throw lastErr || new Error('大模型调用失败')
  } finally {
    releaseLlm()
  }
}

export async function generateScript(prompt, context = '', assetContext = '', options = {}) {
  const assetBlock = assetContext
    ? `\n\n【角色资产设定】\n本剧本使用下列已有角色。写作时必须严格沿用这些角色的名字与外貌设定，不得改动、不得新增形象冲突的描述，戏份围绕他们展开：\n${assetContext}`
    : ''

  // 题材 / 受众定位由调用方（项目配置）注入。平台本身不预设任何具体题材，
  // 任何剧本（古装 / 都市 / 悬疑 / 科幻 / 儿童 / 纪录向……）都走同一条主流程。
  const genre = String(options.genre || '').trim()
  const genreBlock = genre
    ? `\n- 本剧题材与受众定位：${genre}。必须严格贴合该题材创作，不得偏离，也不得套用与本项目无关的其他题材`
    : ''
  const scriptCfg = config.script || {}
  const minChars = scriptCfg.minChars ?? 800
  const maxChars = scriptCfg.maxChars ?? 1500
  const sceneCountMin = scriptCfg.sceneCountMin ?? 3
  const sceneCountMax = scriptCfg.sceneCountMax ?? 5

  const messages = [
    {
      role: 'system',
      content: `你是一名专业短剧编剧。请根据用户的创作意图，编写一个结构化的短剧剧本。

格式要求：
- 每个场次以"场次X：标题"开头
- 每场包含：场景（外景/内景·地点·时间·天气）、人物、对白、舞台指示（用括号括起来）
- 语言生动，画面感强
- 总长度 ${minChars}-${maxChars} 字，${sceneCountMin}-${sceneCountMax} 个场次${genreBlock}
- 场次编号必须从 1 开始连续递增，修改或续写时保持已有场次编号不变，新场次接着最后一场往后编，禁止重复或重排编号${assetBlock}

直接输出剧本内容，不要额外解释。`,
    },
  ]

  if (context) {
    messages.push({ role: 'user', content: `当前剧本：\n${context}\n\n请根据以下要求修改或续写：${prompt}` })
  } else {
    messages.push({ role: 'user', content: `创作意图：${prompt}` })
  }

  const { text, finishReason } = await chatCompletion(messages, {
    temperature: scriptCfg.temperature ?? 0.8,
    maxTokens: scriptCfg.maxTokens ?? 6000,
    returnMeta: true,
    usageContext: { task: 'script' },
  })
  if (finishReason === 'length' || finishReason === 'max_tokens') {
    throw new Error(`剧本生成被截断（长度上限，finish_reason=${finishReason}）。请缩短创作要求后重试`)
  }
  return text
}

export async function rewriteScriptSegment(selectedText, instruction, context = '', options = {}) {
  // 题材 / 受众定位由调用方注入，平台不预设具体题材（原"儿童动画"假设已移除）。
  const genre = String(options.genre || '').trim()
  const genreBlock = genre ? `\n- 本剧题材与受众定位：${genre}。改写后必须仍贴合该题材` : ''
  const messages = [
    {
      role: 'system',
      content: `你是一名专业短剧编剧，负责改稿。下面给你【原段落】和【整篇上下文】，请根据【改写要求】改写原段落。

【硬性约束】
- 只输出改写后的段落本身，直接可替换原段落。
- 严禁输出整篇剧本、严禁输出任何解释、前言、标题或 markdown 标记。
- 只改选中段落，不得改动上下文中的其他场次、对白或内容。
- 保持短剧格式：场景/人物/对白/舞台指示（括号）结构清晰，语言生动、画面感强。${genreBlock}
- 如果改写要求只是微调，尽量保留原段落风格与细节，不要无谓扩写。
- 直接输出结果文本，不要任何多余文字。`,
    },
  ]

  let userContent = `【原段落】\n${selectedText}\n\n【改写要求】\n${instruction}`
  if (context && context.trim()) {
    userContent += `\n\n【整篇上下文（仅供理解剧情，禁止修改此范围外的内容）】\n${context}`
  }

  messages.push({ role: 'user', content: userContent })
  return chatCompletion(messages, { temperature: 0.7, maxTokens: 2000 })
}

export async function classifyScriptIntent(instruction) {
  const messages = [
    {
      role: 'system',
      content: `你是剧本编辑指令分类器。用户当前已有一份剧本，给出一条指令，判断执行方式：

- revise（定点修改）：局部改动——改名、换称谓、改某几行台词、删一段、加一场戏、调整某场的氛围/开头/结尾等
- rewrite（整本整理）：全文性操作——整理全局格式、统一场景结构、全文换风格/语气、全文压缩或扩写
- generate（全新剧本）：明确不要现有剧本，要从头写一个新故事

【易错判别】
- 【混合要求】指令同时含"改名/修改"和"生成/写一个 X 秒（或 X 字）的完整剧本"时，选 rewrite——它要的是产出完整新剧本（基于现有剧本改写），不是局部改动
- 【无效改名】"把A改成A"（前后同名）说明指令有歧义：主要意图是产出新剧本/新故事选 rewrite；只是改台词细节选 revise
- 只要求"新场景/新对话+时长"而未要求改动的，按是"加一场戏"（revise）还是"重写整个故事"（rewrite）判断

输出严格 JSON：{ "mode": "revise|rewrite|generate", "reason": "一句话理由" }
只输出 JSON，不要任何其他文字。`,
    },
    { role: 'user', content: `用户指令：${instruction}` },
  ]
  const text = await chatCompletion(messages, {
    temperature: 0,
    maxTokens: 100,
    responseFormat: { type: 'json_object' },
    timeoutMs: config.timeouts.llm.short,
    usageContext: { task: 'intent' },
  })
  try {
    const parsed = JSON.parse(text)
    const mode = String(parsed.mode || '').toLowerCase()
    if (mode === 'revise' || mode === 'rewrite' || mode === 'generate') return mode
  } catch {  }
  return 'revise' 
}

export async function reviseScriptEdits(script, instruction) {
  const messages = [
    {
      role: 'system',
      content: `你是剧本定点修改助手。给你【当前剧本】和一条【修改要求】，你只输出编辑指令 JSON，绝不输出整个剧本。

输出严格 JSON：{ "edits": [ ... ], "needFullRewrite": false, "reason": "" }
edits 支持四种形式：
1. 定点修改：{ "find": "原文片段", "replace": "替换后的文本" }
2. 全局替换：{ "replaceAll": "原词", "with": "新词" }
3. 结尾追加：{ "append": "新增内容" }
4. 指定行后插入：{ "insertAfter": "原剧中某一行的原文", "text": "新增内容" }

【选用规则】
- 新增一场戏/新增一段内容：用 append（追加到剧本结尾）或 insertAfter（插入到某一行之后）。text/append 里只写新增内容本身，严禁复述、改写或复制剧本里已有的任何内容
- 修改某一段具体内容（改台词、改描写、删一行）用 find/replace
- 改名、换称谓、统一用词这类"把某词全部换成另一个词"的请求，必须用 replaceAll，禁止逐处罗列
- 【全文性逃生舱】当要求无法用上述指令表达（如"全文改口语化""整体换一种叙事风格""全文压缩"这类涉及每一句台词的改动）时：edits 留空数组，needFullRewrite 置 true，reason 用一句话说明；禁止硬凑 find/replace

【内容红线（违反会导致编辑被拒收）】
- append/insertAfter 的 text、replace 的值只能是剧本正文本身：场次标题、场景描述、人物对白、舞台指示
- 严禁把【修改要求】的原文或其复述/转述（如"按上述内容把A改成B生成一个30秒的剧本"）当作新增内容写进剧本——那是给您的指令，不是剧情
- 严禁输出任何对用户的回应、解释、确认语（如"好的，已为您改名"）
- 如果修改要求本身无法落实（如改名前后是同一个名字、要求有歧义、要求与剧本无关），输出 { "edits": [], "needFullRewrite": false, "reason": "一句话说明原因" }，让上层转交用户澄清

【find/replace 规则】
- find 必须是【当前剧本】中逐字连续存在的一段原文（至少一整行，可多行），必须从原剧本原样复制粘贴，禁止凭印象改写、增删字词或调整标点
- replace 只写这一段改动后的样子，严禁把 find 之外的原剧本内容复制进来
- 删除内容：replace 为空字符串
- 需要多处修改就输出多个 edits（按剧本中出现顺序）；用户只是提问、无需修改时输出 { "edits": [] }
- find 范围最小化：只覆盖需要改动的行；确属整段/整场重写才扩大范围
- 只输出 JSON，不要任何解释或 markdown 标记`,
    },
    {
      role: 'user',
      content: `【当前剧本】\n${script}\n\n【修改要求】\n${instruction}`,
    },
  ]
  const maxTokens = Math.min(16000, Math.max(4000, Math.ceil(countNonSpace(script) * 2)))
  const text = await chatCompletion(messages, {
    temperature: 0.2,
    maxTokens,
    responseFormat: { type: 'json_object' },
    timeoutMs: config.timeouts.llm.longScript,
    usageContext: { task: 'revise' },
  })
  const normalize = (parsed) => ({
    edits: Array.isArray(parsed?.edits) ? parsed.edits : [],
    needFullRewrite: parsed?.needFullRewrite === true,
    reason: String(parsed?.reason || ''),
  })
  try {
    return normalize(JSON.parse(text))
  } catch {
    const jsonStr = extractFirstJson(text)
    if (!jsonStr) throw new Error('无法解析定点修改结果')
    return normalize(JSON.parse(jsonStr))
  }
}

export async function rewriteFullScript(script, instruction) {
  const messages = [
    {
      role: 'system',
      content: `你是专业剧本编辑。给你【当前剧本】和一条【整理/重写要求】，请对整份剧本做整理或重写，直接输出完整剧本。

【规则】
- 可按用户要求调整结构、格式、场景组织、动作提示，也可补写标题、场次标注、人物表等组织性内容
- 台词与既有剧情内容：除用户明确要求改动外，必须原样保留（可整理排版，禁止无端删减、合并、改写或缩写）
- 用户要求改动的内容（改名、换场景、调结构等）要彻底执行到位
- 保持纯文本格式（不要 markdown 表格、代码块或标题井号），输出长度与内容量跟随剧本本身，不要为了凑长度或压缩长度增删情节
- 直接输出完整剧本，不要任何解释、前言或后记`,
    },
    {
      role: 'user',
      content: `【当前剧本】\n${script}\n\n【整理/重写要求】\n${instruction}`,
    },
  ]
  const maxTokens = Math.min(16000, Math.max(4000, Math.ceil(countNonSpace(script) * 2)))
  const { text, finishReason } = await chatCompletion(messages, {
    temperature: 0.5,
    maxTokens,
    timeoutMs: config.timeouts.llm.longScript,
    returnMeta: true,
    usageContext: { task: 'rewrite' },
  })
  if (finishReason === 'length' || finishReason === 'max_tokens') {
    throw new Error(`整本整理结果被截断（剧本过长，超出模型单次输出上限，finish_reason=${finishReason}）。请缩短剧本或分场次整理`)
  }
  return text
}

import { escapeRegExp, CJK_DIRTY_RE, extractFirstJson } from './shared.js'
import { tasksDir } from '../paths.js'
import { normalizeShotType, shotTypeTermsText } from './shotTypes.js'
// 兼容历史调用方：景别归一原本在 doubao.js 导出，现转由 shotTypes.js 提供
export { normalizeShotType } from './shotTypes.js'

function normalizeForMatch(s) {
  return String(s)
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/，/g, ',')
    .replace(/、/g, ',')
    .replace(/：/g, ':')
    .replace(/；/g, ';')
    .replace(/！/g, '!')
    .replace(/？/g, '?')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
}

function locateText(hay, needle) {
  if (!needle) return null
  const exact = hay.indexOf(needle)
  if (exact !== -1) return { index: exact, length: needle.length }
  const pattern = needle
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => `[ \\t]*${escapeRegExp(l.trim())}[ \\t]*`)
    .join('\\n')
  if (pattern) {
    const m = new RegExp(pattern).exec(hay)
    if (m) return { index: m.index, length: m[0].length }
  }
  const normIdx = normalizeForMatch(hay).indexOf(normalizeForMatch(needle))
  if (normIdx !== -1) return { index: normIdx, length: needle.length }
  return null
}

const COPIED_LINE_LIMIT = 3

const INSTRUCTION_ECHO_PATTERNS = [
  /按[上照]述|根据上述/,
  /把.{1,16}改成.{0,40}(生成|一个?\d+\s*秒)/,
  /生成.{0,10}一个?.{0,6}\d+\s*秒.{0,8}的?剧本/,
  /\d+\s*秒(左右)?的(剧本|故事)/,
  /^(请|帮我?)?(改写|生成|编写?|输出).{0,8}(剧本|故事)[，。:].{0,60}(把|将).{1,16}改成/,
]

function looksLikeInstructionEcho(text) {
  const t = String(text || '').trim()
  if (!t || t.length > 120) return false
  return INSTRUCTION_ECHO_PATTERNS.some((re) => re.test(t))
}

function countCopiedLinesOutsideFind(originalScript, find, replace) {
  const findLines = new Set(find.split('\n').map((l) => l.trim()))
  const originalLines = new Set(originalScript.split('\n').map((l) => l.trim()).filter(Boolean))
  let copied = 0
  for (const line of replace.split('\n')) {
    const t = line.trim()
    if (!t || findLines.has(t)) continue
    if (originalLines.has(t)) copied++
  }
  return copied
}

export function applyScriptEdits(script, edits) {
  let out = String(script || '').replace(/\r\n/g, '\n')
  const list = Array.isArray(edits) ? edits : []
  let applied = 0
  for (let i = 0; i < list.length; i++) {
    const edit = list[i] || {}
    if (edit.append !== undefined) {
      const text = String(edit.append).trim()
      if (text && looksLikeInstructionEcho(text)) {
        throw new Error(`第 ${i + 1} 处追加的内容疑似用户指令原文而非剧本内容（如"按上述内容把X改成Y生成剧本"）。新增内容必须是场次/对白/舞台指示等剧本正文`)
      }
      if (text) out = `${out.trimEnd()}\n\n${text}`
      applied++
      continue
    }
    if (edit.insertAfter !== undefined) {
      const anchor = String(edit.insertAfter)
      const text = String(edit.text ?? '').trim()
      if (!anchor.trim()) continue
      if (text && looksLikeInstructionEcho(text)) {
        throw new Error(`第 ${i + 1} 处插入的内容疑似用户指令原文而非剧本内容。插入内容必须是场次/对白/舞台指示等剧本正文`)
      }
      const loc = locateText(out, anchor)
      if (!loc) throw new Error(`第 ${i + 1} 处插入的锚点行无法在剧本中定位`)
      const at = loc.index + loc.length
      out = `${out.slice(0, at)}\n${text}${out.slice(at)}`
      applied++
      continue
    }
    if (edit.replaceAll !== undefined) {
      const from = String(edit.replaceAll)
      const to = String(edit['with'] ?? '')
      if (from) {
        out = out.split(from).join(to)
        applied++
      }
      continue
    }
    const find = String(edit.find ?? '')
    const replace = String(edit.replace ?? '')
    if (!find.trim()) continue
    if (countCopiedLinesOutsideFind(script, find, replace) >= COPIED_LINE_LIMIT) {
      throw new Error(`第 ${i + 1} 处修改的 replace 里复制了原剧本已有内容（新增内容请用 append/insertAfter 形式）`)
    }
    const loc = locateText(out, find)
    if (!loc) throw new Error(`第 ${i + 1} 处修改无法在剧本中定位原文`)
    out = out.slice(0, loc.index) + replace + out.slice(loc.index + loc.length)
    applied++
  }
  if (list.length && !applied) throw new Error('没有可应用的修改')
  return out
}

export async function extractAssets(script, style = '') {
  const skillRules = loadSkillRules()
  const styleInstruction = style
    ? `\n\n【画风参考】本项目整体视觉风格参考「${style}」。description 中**严禁**直接出现画风词、渲染词、背景词（如"${style}"、"纯白背景"、"2D/3D"、"手绘"、"写实"等），只描述资产本身的视觉内容。`
    : ''

  const messages = [
    {
      role: 'system',      content: `你是一名影视美术指导（角色/道具/场景概念设计）。你的资产提取方法论以【Skill 资产规则】为唯一权威来源（xiaomo-film-studio 模块A），下方规则全文必须先通读、全部硬性约束严格遵守（人·物·场分离、六要素整段文字、场景正面全景微俯视大白话、编号闭环、服化道场自洽、原文优先推导必标）。
【冲突仲裁】Skill 规则教你输出三份 Markdown 文档；本平台是生产管线——【提取方法论服从 Skill 规则，输出格式服从平台 JSON 契约】。${styleInstruction}
【重要】立刻输出 JSON，禁止任何其他文字、解释或 markdown 标记。

<skill_asset_rules>
${skillRules.asset}
</skill_asset_rules>

【平台 JSON 输出契约】
{
  "characters": [{"name": "角色名", "role": "主角/配角", "description": "六要素一整段连贯文字（年龄/性别/肤色/发型发色/五官特征/服装），抓辨识度特征不过度展开；只写静态特征，严禁动作/姿态/剧情瞬态；饰品可随服装带出，武器装备一律不写在此", "nameEn": "English Name", "descriptionEn": "与中文同信息量的英文外貌（必须含物种与毛色/肤色；同物种多角色用≥2个硬视觉特征区分，严禁只靠配饰颜色）"}],
  "scenes": [{"name": "场景名（必须逐字取自剧本原文的地点词，禁止添加形容/后缀/分隔符——剧本写「旧仓库」就只能写「旧仓库」，不得写成「废弃·旧仓库」）", "description": "正面全景微俯视大白话一整段：站位→近景地面→左到右中景→纵深远景→光线氛围；搬不走的固定环境才写在此，能搬走的物件一律不写；禁文学意境词", "spaceType": "S1/S2/S3/S4/O1/O2/X【尽力标注，不确定就填空字符串】——分镜侧会依据本场景的空间结构复核判定，错误标注反而有害，宁可留空", "spaceEvidence": "判定依据（面积/层高/开敞度一句话）；spaceType 留空时本项一并留空", "spatialGroup": "本场归属的物理空间组名：与同一物理空间的其它场景逐字同名（2-6字中文或snake_case英文）；独立空间写「独立空间」；不确定留空——同组各场的 spatialRole 必须互不相同", "spatialRole": "本场在组内的站位视角一句话（如「崖顶平台远望谷底」「窄道中段贴壁前行」），与同组其它场景不得重复", "sharedLandmarks": ["与同组其它场景共同出现的、搬不走的固定大型地标名（2-6字中文，如「断裂的古桥」「谷底河道」）——判定同人·物·场分离：能搬走的归 props，严禁列入；独立空间或无共享地标时省略本字段"], "titleEn": "English Title", "summaryEn": "与中文同信息量的英文环境摘要（光线氛围句同样翻译进英文摘要）", "props": ["该场景实际出现的道具名（须在本结果 props 里有同名条目）"]}],
  "props": [{"name": "道具名", "description": "外形/材质/配色/细节/尺寸参照一整段；只写静态视觉特征，不写用途/使用方式/与角色的关系", "nameEn": "English Name", "descriptionEn": "与中文同信息量的英文外形", "owner": "主要持有者角色名（无则空字符串）", "states": [{"stateKey": "intact", "labelZh": "完整", "description": "该阶段中文形态", "descriptionEn": "该阶段英文形态"}]}]
契约补充硬约束（平台出片实测教训，与 Skill 规则同级）：
- ${buildSpaceTypeTable()}
- 同一件道具/同一场景出现多次只提取一次；同一道具被多角色共用标全部持有者。
- 场景 description 严禁出现可移动道具（手机/书本/食物/家具陈设），那些归 props。
- 环境材质与气候保真：剧本写到的水体状态/气候季节/地表材质/大气现象必须原词保留，禁泛化；光照按剧本该时刻的原文写实（阳光照到哪、背光面是什么状态就写什么），禁止按环境类型一刀切色调（如"冰雪必须冷调"——剧本写了对岸有暖金阳光就必须写出来）。
- nameEn/titleEn/summaryEn/descriptionEn 必须全英文（官方 ref-en 要求六个 section 用英文撰写；防汉字被模型误读为台词属平台实测考虑）。
- states 仅在本集有可见状态变化（损毁/断裂/消耗/浸泡/易主损坏）时输出，首项 stateKey 固定 "intact"；无变化整个省略。
- 只输出 JSON，不要任何其他文字、解释或 markdown 标记。`,
    },
    { role: 'user', content: `剧本内容：\n${script}` },
  ]

  const callLLM = (extraNote = '') =>
    chatCompletion(
      extraNote
        ? [{ role: 'system', content: messages[0].content + extraNote }, ...messages.slice(1)]
        : messages,
      {
        temperature: 0.3,
        maxTokens: 6000,
        responseFormat: { type: 'json_object' },
        timeoutMs: config.timeouts.llm.standard, 
        usageContext: { task: 'assets' },
      }
    )

  const parseAndCoerce = (t) => {
    let obj = null
    try { obj = JSON.parse(t) } catch {
      const js = extractFirstJson(t)
      if (js) { try { obj = JSON.parse(js) } catch { obj = null } }
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
    const withName = (list) =>
      (Array.isArray(list) ? list : [])
        .map((x) => (typeof x === 'string' ? { name: x } : x))
        .filter((x) => x && typeof x === 'object' && String(x.name || '').trim())
    return {
      characters: withName(obj.characters),
      scenes: withName(obj.scenes),
      props: withName(obj.props),
    }
  }

  let text = await callLLM()
  let parsed = parseAndCoerce(text)
  if (!parsed || (!parsed.characters.length && !parsed.scenes.length && !parsed.props.length)) {
    const retryNote = `\n\n【纠错重试】上一次输出无法解析为合法资产结构（需 {characters,scenes,props} 三个数组，每项含 name 字段）。请重新输出完整 JSON，只输出 JSON 不要任何其他文字。`
    text = await callLLM(retryNote)
    parsed = parseAndCoerce(text)
    if (!parsed || (!parsed.characters.length && !parsed.scenes.length && !parsed.props.length)) {
      throw new Error('AI 资产提取结果结构异常，请重试')
    }
  }
  return parsed
}

function normalizeAssetName(name) {
  return String(name || '')
    .replace(/[\s，。！？、,\.\s]/g, '')
    .toLowerCase()
}

function buildAssetMaps(assets) {
  const maps = { characters: new Map(), scenes: new Map(), props: new Map() }
  const add = (list, keyField, map) => {
    for (const item of list || []) {
      const name = typeof item === 'string' ? item : (item[keyField] || item.name || '')
      if (!name) continue
      const norm = normalizeAssetName(name)
      map.set(norm, name)
      map.set(name, name)
    }
  }
  add(assets?.characters, 'name', maps.characters)
  add(assets?.scenes, 'title', maps.scenes)
  add(assets?.props, 'name', maps.props)
  return maps
}

// IMD 混合编译（#6）：整场/单镜生成后统一重写每个镜头 IMD 的模块2/3（资产库英文原文程序注入）
function applyImdHybridCompile(storyboard, assets) {
  if (!assets || !storyboard?.scenes) return
  let injected = 0
  let kept = 0
  for (const scene of storyboard.scenes) {
    for (const shot of scene.shots || []) {
      const r = compileIntegratedModules(shot.integratedMultimodalDescription, shot, assets)
      if (r.injected.length) {
        shot.integratedMultimodalDescription = r.text
        injected++
      }
      if (r.kept.length) kept++
    }
  }
  if (injected || kept) {
    console.log(`[IMD混合编译] 模块2/3 程序注入 ${injected} 镜${kept ? `，${kept} 镜缺英文原文保留 AI 版` : ''}`)
  }
}

function matchAssetName(input, map) {
  if (!input || !map) return null
  const raw = String(input).trim()
  if (!raw) return null
  if (map.has(raw)) return map.get(raw)
  const norm = normalizeAssetName(raw)
  if (map.has(norm)) return map.get(norm)
  const candidates = [...new Set(map.values())]
  const hit = pickContainmentCandidate(raw, candidates, { normalize: normalizeAssetName })
  return hit != null ? hit : null
}

function normalizeShotAssets(shot, assetMaps) {
  const norm = (names, map) => {
    const result = []
    const dropped = []
    const seen = new Set()
    for (const n of names || []) {
      const matched = matchAssetName(n, map)
      if (matched && !seen.has(matched)) {
        seen.add(matched)
        result.push(matched)
      } else if (!matched) {
        dropped.push(String(n))
      }
    }
    return { result, dropped }
  }
  const c = norm(shot.characters, assetMaps.characters)
  const s = norm(shot.sceneAssets, assetMaps.scenes)
  const p = norm(shot.propAssets, assetMaps.props)
  const droppedAssets = {
    characters: c.dropped,
    scenes: s.dropped,
    props: p.dropped,
  }
  const hasDropped = c.dropped.length || s.dropped.length || p.dropped.length
  return {
    ...shot,
    characters: c.result,
    sceneAssets: s.result,
    propAssets: p.result,
    ...(hasDropped ? { droppedAssets } : {}),
  }
}

// 场次标题解析（2026-09-26 修复）：原正则有两处失配——① 要求行首即「场次」，遇 Markdown
// 标题（`### 场次 1：...`）全灭；② 要求「场次」与数字紧邻，遇「场次 1」（中间有空格）失配。
// 两者叠加导致 8 场剧本被判为"无分场标记"→ 退化成按段落瞎切块，场次一一对应约束整体失效。
const SCENE_TITLE_RE = /^#{0,6}\s*场次\s*[一二三四五六七八九十\d]+\s*[：:]\s*(.+?)\s*#*\s*$/

export function parseScriptSceneTitles(script) {
  const titles = []
  for (const line of String(script || '').split('\n')) {
    const m = line.match(SCENE_TITLE_RE)
    if (m) titles.push(m[1].trim())
  }
  return titles
}

export function parseScriptSceneBlocks(script) {
  const lines = String(script || '').split('\n')
  const blocks = []
  let current = null
  for (const line of lines) {
    const m = line.match(SCENE_TITLE_RE)
    if (m) {
      if (current) blocks.push(current)
      // 块文本保留完整的场次标题行，供生成侧识别场次边界
      current = { title: m[1].trim(), text: line.trim() + '\n' }
    } else if (current) {
      current.text += line + '\n'
    }
  }
  if (current) blocks.push(current)
  return blocks.map((b) => ({ title: b.title, text: b.text.trim() }))
}

const AUTO_CHUNK_MIN_CHARS = 2400
const AUTO_CHUNK_MAX_CHARS = 2000
// 文件规整的单批上限必须低于上游网关常见等待窗口；规整输出字段多，
// 比剧本生成使用更保守的输入批次，避免 524 后整份文件重跑。
const FILE_NORMALIZE_CHUNK_MIN_CHARS = 5200
const FILE_NORMALIZE_CHUNK_MAX_CHARS = 7000

function countNonSpace(text) {
  return String(text || '').replace(/\s/g, '').length
}

function chunkScriptByParagraphs(text, maxChars = AUTO_CHUNK_MAX_CHARS) {
  const source = String(text || '').replace(/\r\n/g, '\n').trim()
  if (!source) return []

  const units = [] 
  for (const para of source.split(/\n{2,}/)) {
    units.push(para.split('\n'))
  }
  const fineUnits = []
  for (const lines of units) {
    let cur = []
    let curLen = 0
    for (let line of lines) {
      while (line.length > maxChars) {
        const cutAt = Math.max(
          line.lastIndexOf('。', maxChars),
          line.lastIndexOf('！', maxChars),
          line.lastIndexOf('？', maxChars),
          maxChars
        )
        fineUnits.push([line.slice(0, cutAt + 1)])
        line = line.slice(cutAt + 1)
      }
      if (!line) continue
      if (curLen + line.length + 1 > maxChars && cur.length) {
        fineUnits.push(cur)
        cur = []
        curLen = 0
      }
      cur.push(line)
      curLen += line.length + 1
    }
    if (cur.length) fineUnits.push(cur)
  }

  const chunks = []
  let cur = []
  let curLen = 0
  for (const unit of fineUnits) {
    const unitLen = unit.join('\n').length
    if (curLen + unitLen + 2 > maxChars && cur.length) {
      chunks.push(cur.join('\n\n'))
      cur = []
      curLen = 0
    }
    cur.push(unit.join('\n'))
    curLen += unitLen + 2
  }
  if (cur.length) chunks.push(cur.join('\n\n'))
  return chunks
}

function splitStoryboardFileIntoChunks(text, maxChars = FILE_NORMALIZE_CHUNK_MAX_CHARS) {
  const source = String(text || '').replace(/\r\n/g, '\n').trim()
  if (!source) return []
  const headerRe = /^\s*(?:#{0,6}\s*)?(?:镜头|shot)\s*\d+\b.*$/i
  const sceneRe = /^\s*(?:#{0,6}\s*)?(?:场次|第\s*[一二三四五六七八九十\d]+场)\s*\d*[：:]?.*$/
  const lines = source.split('\n')
  const shots = []
  let preamble = []
  let current = []
  for (const line of lines) {
    if ((headerRe.test(line) || sceneRe.test(line)) && current.length) {
      shots.push(current.join('\n').trim())
      current = []
    }
    if ((headerRe.test(line) || sceneRe.test(line)) && !shots.length && preamble.length) {
      current.push(...preamble)
      preamble = []
    }
    if (current.length || headerRe.test(line) || sceneRe.test(line)) current.push(line)
    else preamble.push(line)
  }
  if (current.length) shots.push(current.join('\n').trim())
  if (!shots.length) return chunkScriptByParagraphs(source, maxChars)
  const chunks = []
  let bucket = []
  let length = 0
  for (const shot of shots) {
    if (bucket.length && length + shot.length + 2 > maxChars) {
      chunks.push(bucket.join('\n\n'))
      bucket = []
      length = 0
    }
    bucket.push(shot)
    length += shot.length + 2
  }
  if (bucket.length) chunks.push(bucket.join('\n\n'))
  return chunks
}

function reportProgressForFileChunks(onProgress, total) {
  if (typeof onProgress !== 'function') return
  try {
    onProgress({ phase: PHASE.NORMALIZE, done: 0, total, message: `文件较大，已拆为 ${total} 批规整，避免上游网关超时…` })
  } catch { }
}

function buildAssetListPrompt(assets) {
  if (!assets) return ''
  const enCn = (en, cn) => {
    const e = String(en || '').trim()
    const c = String(cn || '').trim()
    if (e && c) return `${e}（中文对照：${c}）`
    return e || c
  }
  const charLines = (assets.characters || []).map((c) => {
    const name = typeof c === 'string' ? c : (c.name || '')
    const nameEn = typeof c === 'string' ? '' : (c.name_en || '')
    const desc = typeof c === 'string' ? '' : enCn(c.description_en, c.description)
    const hasRef = typeof c !== 'string' && (c.image_url || c.imageUrl)
    const label = nameEn ? `${name} / ${nameEn}` : name
    return `${desc ? `- ${label}：${desc}` : `- ${label}`}${hasRef ? `【该角色已有参考图（参考图由本 description 生成），其中【英文描述】即角色唯一权威外貌，模块2 必须逐字复制英文部分，严禁粘贴中文】` : ''}`
  })
  const sceneLines = (assets.scenes || []).map((s) => {
    const name = typeof s === 'string' ? s : (s.title || s.name || '')
    const nameEn = typeof s === 'string' ? '' : (s.title_en || '')
    const desc = typeof s === 'string' ? '' : enCn(s.summary_en, s.description || s.summary || '')
    const hasRef = typeof s !== 'string' && (s.image_url || s.imageUrl)
    const label = nameEn ? `${name} / ${nameEn}` : name
    let line = desc ? `- ${label}：${desc}` : `- ${label}`
    const spaceTypeRaw = typeof s === 'string' ? '' : String(s.space_type || s.spaceType || '').trim()
    if (spaceTypeRaw) {
      line += `【空间类型：${spaceTypeRaw}——本场景所有镜头的景别上限与运镜禁令按 Skill 规则 §9 的 ${spaceTypeRaw} 条款执行】`
    }
    const sceneProps = typeof s === 'string' ? [] : (s.props || s.propNames || [])
    if (Array.isArray(sceneProps) && sceneProps.length) {
      line += `（该场景关联道具：${sceneProps.map(String).join('、')}）`
    }
    const lightingRaw = typeof s === 'string' ? '' : String(s.lightingEn || s.lighting_en || '').trim()
    const lighting = lightingRaw && !CJK_DIRTY_RE.test(lightingRaw) ? lightingRaw : ''
    if (lighting) {
      line += `；【场景光影常量】${lighting}（此英文句是该场景唯一权威光照描述：模块3 必须逐字复制并声明该光照在整个片段保持恒定，禁止改写、翻译或省略）`
    }
    if (hasRef) line += `【该场景已有参考图（由本 description 生成），其中【英文描述】即场景唯一权威环境描述，模块3 必须逐字复制英文部分，严禁粘贴中文】`
    return line
  })
  const propLines = (assets.props || []).map((p) => {
    const name = typeof p === 'string' ? p : (p.name || '')
    const nameEn = typeof p === 'string' ? '' : (p.name_en || '')
    const desc = typeof p === 'string' ? '' : enCn(p.description_en, p.description)
    const owner = typeof p === 'string' ? '' : (p.owner || '')
    const hasRef = typeof p !== 'string' && (p.image_url || p.imageUrl)
    const label = nameEn ? `${name} / ${nameEn}` : name
    let line = desc ? `- ${label}：${desc}` : `- ${label}`
    if (owner) line += `（专属角色：${owner}，其他角色不持有此道具）`
    if (hasRef) line += `【该道具已有参考图（由本 description 生成），其中【英文描述】即道具唯一权威外观，禁止增删改；模块5 写道具时必须用英文名】`
    return line
  })
  return `

═══════════════════════════════════════
【本项目已确认的资产清单】（必须严格复用这些资产，禁止重新提取或创造新资产）
═══════════════════════════════════════
角色：
${charLines.join('\n') || '（无）'}
场景：
${sceneLines.join('\n') || '（无）'}
道具：
${propLines.join('\n') || '（无）'}

强制关联规则：
- characters/sceneAssets/propAssets 数组中的每个名字必须严格出现在上方对应清单中。
- description 中用 @名字 标记的角色/场景/道具也必须来自上方清单。
- 如果剧本中出现了清单外的实体，只在 description 中用文字描述，不要把它加入数组，也不要用 @标记。
- **propAssets 只能从上方「道具」清单中选择**；若镜头的场景标注了关联道具，则该镜头的道具必须来自该场景的关联道具清单。
- **严禁把家具或环境陈设当作道具**：沙发、茶几、电视、柜子、床、门窗、地板、墙壁等属于场景固定陈设，绝不能写入 propAssets，也不要写入道具清单中没有的其他物品。
- 【角色外貌唯一来源】integratedMultimodalDescription 模块2 中每个角色的 "exactly as shown" 外貌描写，必须【逐字复制】上方「角色」清单中该角色的【英文描述】部分，一字不差；禁止改写、扩写、增减任何特征，禁止为角色添加清单外的帽子/服装/性别/年龄/体型。**【全英文硬约束】整段 integratedMultimodalDescription 除 @中文资产名 外，不得出现任何中文字符**——中文残留会稀释英文外貌锁定描述、导致出图角色外貌漂移（出图模型按英文描述锁定外貌，中文对照词不进锁定）。严禁直接粘贴清单里的「中文对照」描述，必须使用其英文部分；若清单未提供英文，就把该特征改写成英文。道具描述同理：模块5 中的道具名与属性必须与上方「道具」清单一致（写英文名），禁止给道具添加清单外的外形细节。`
}


async function generateWithVerify(gen, validate, opts = {}) {
  const attempts = Math.max(1, opts.attempts ?? 2)
  const label = opts.label || 'rewrite'
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const val = await gen(attempt)
      if (validate(val)) return val
      console.warn(`[${label}] 第 ${attempt}/${attempts} 次产出未通过验收${attempt < attempts ? '，重试' : '，放弃'}`)
    } catch (e) {
      console.warn(`[${label}] 第 ${attempt}/${attempts} 次调用异常：${e.message}${attempt < attempts ? '，重试' : ''}`)
    }
  }
  return null
}

export async function repairShotAxis(shot, charName, prevSide, currSide, style = '') {
  const original = (shot?.integratedMultimodalDescription || '').trim()
  const origNote = String(shot?.actionNote || shot?.action_note || '').trim()
  if (!original || !charName || !prevSide || !currSide) return null
  const prevZh = prevSide === 'left' ? '左' : prevSide === 'right' ? '右' : prevSide
  const currZh = currSide === 'left' ? '左' : currSide === 'right' ? '右' : currSide
  const messages = [
    {
      role: 'system',
      content: `你是专业的 AI 视频提示词工程师，精通 AI 视频控制式 prompt 写法（用于本项目的画面描述字段，按其六模块结构书写）。立刻输出改写结果，不要任何思考、分析、解释或前言。画风：${style || config.defaultArtStyle}（与原稿一致，禁止偏离）。

【任务】原稿存在越轴隐患：角色 @${charName} 在上一镜的画面侧位是 frame ${prevSide}，本镜却出现在 frame ${currSide}，而本镜没有交代这次换位——直接生成会造成角色凭空换边、画面空间跳变。
请在【完全保留原稿其他内容】的前提下，把该角色的走位【写两处】：
① 模块4（镜头内动作时间轴）：例如 "walks from frame ${prevSide} toward frame ${currSide}"，措辞风格与原稿一致——越轴机检按 IMD 关键词识别"显式走位"，不写会被判越轴错误；
② action_note（中文镜内时间轴，按拍点写「At X.Xs，动作」）：例如「At 0.0s，@${charName} 从画面${prevZh}走向画面${currZh}」——出片提示词只读 action_note，不写则出片模型完全不知道这个位移。
要求：
- 两处都要写，缺一即视为未交代；不改变本镜总时长，不增删角色，不改动角色外貌锁定文字；
- 模块1/2/3/5/6 的内容保持不变；保持原稿的 6 模块结构与英文语言；
- 输出严格 JSON：{"integrated_multimodal_description":"...","action_note":"..."}，action_note 用中文，原 action_note 有内容则在其基础上追加走位拍点而非整段替换，不要省略任何字段，不要 JSON 外的任何文字。`,
    },
    {
      role: 'user',
      content: `【本镜原稿】\nintegrated_multimodal_description:\n${original}\n\naction_note:\n${origNote || '（空）'}`,
    },
  ]
  const raw = await generateWithVerify(
    (attempt) => chatCompletion(messages, {
      temperature: attempt === 1 ? 0.3 : 0.1,
      maxTokens: 3500,
      timeoutMs: config.timeouts.llm.repair,
      maxAttempts: 2,
      disableThinking: true,
      responseFormat: { type: 'json_object' },
      usageContext: { task: 'storyboard-axis', attempt },
    }),
    (r) => {
      const parsed = tryParseJson(r)
      if (!parsed) return null
      const imd = sanitizeIntegrated(String(parsed.integrated_multimodal_description || ''))
      const note = String(parsed.action_note || '').trim()
      if (!imd || !note) return null
      if (!hasExplicitReposition(imd, currSide)) return null
      if (note === origNote) return null
      return { integratedMultimodalDescription: imd, actionNote: note }
    },
    { attempts: 2, label: 'repairShotAxis' }
  )
  if (!raw) {
    console.warn(`[repairShotAxis] 重试后仍未产出双落点有效改写，按修补失败处理`)
    return null
  }
  return raw
}

function stripCodeFence(raw) {
  let s = String(raw || '').trim()
  s = s.replace(/^```[a-zA-Z]*\s*/i, '').replace(/\s*```\s*$/i, '')
  return s.trim()
}

function tryParseJson(raw) {
  const s = stripCodeFence(raw)
  if (!s) return null
  try { return JSON.parse(s) } catch { return null }
}

export async function fixAxisFlips(scenes, charNames, style = '', aliasMap = null, onProgress = null) {
  const flat = (scenes || []).flatMap((s) => s.shots || [])
  if (!charNames?.length || flat.length < 2) {
    return { pending: 0, fixed: 0, failed: 0, unresolved: [], repairedShots: [] }
  }
  const pending = []
  for (let i = 1; i < flat.length; i++) {
    const prevSides = extractScreenSides(flat[i - 1].finalFrame || '', charNames, aliasMap)
    const currSides = extractScreenSides(flat[i].finalFrame || '', charNames, aliasMap)
    for (const [name, pSide] of prevSides) {
      const cSide = currSides.get(name)
      if (!cSide || pSide === 'center' || cSide === 'center' || cSide === pSide) continue
      const imd = flat[i].integratedMultimodalDescription || ''
      if (!hasExplicitReposition(imd, cSide)) pending.push({ shot: flat[i], name, pSide, cSide, index: i })
    }
  }
  if (!pending.length) return { pending: 0, fixed: 0, failed: 0, unresolved: [], repairedShots: [] }
  console.log(`[generateStoryboard] 越轴检测：${pending.length} 处侧位翻转无走位交代，开始修补`)
  let axisReported = 0
  const reportAxis = () => {
    axisReported++
    try { onProgress?.(axisReported, pending.length) } catch {  }
  }
  let fixed = 0
  let failed = 0
  const unresolved = []
  const repairedShots = []
  const verifyAfterFix = config.storyboard?.axisVerify !== false
  const SHOT_HARD_CAP_MS = 240000
  await Promise.all(pending.map(async (p) => {
    try {
      const repair = repairShotAxis(p.shot, p.name, p.pSide, p.cSide, style)
      repair.catch(() => {})
      const rewritten = await Promise.race([
        repair,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('单镜修补硬超时（4 分钟），自动放弃并保留原稿')), SHOT_HARD_CAP_MS)
        ),
      ])
      if (!rewritten) {
        failed++
        unresolved.push({ shot: p.shot.shotNumber || p.shot.id, name: p.name, reason: '改写失败（未产出有效走位表达）' })
        reportAxis()
        return
      }
      if (verifyAfterFix && !hasExplicitReposition(rewritten.integratedMultimodalDescription, p.cSide)) {
        failed++
        unresolved.push({ shot: p.shot.shotNumber || p.shot.id, name: p.name, reason: `复检未过：改写稿仍无走向 frame ${p.cSide} 的走位交代` })
        console.warn(`[generateStoryboard] 第 ${p.index + 1} 镜 @${p.name} 越轴修补复检未过，保留原稿`)
        reportAxis()
        return
      }
      p.shot.integratedMultimodalDescription = rewritten.integratedMultimodalDescription
      if (rewritten.actionNote) p.shot.actionNote = rewritten.actionNote
      repairedShots.push(p.shot)
      fixed++
      console.log(`[generateStoryboard] 第 ${p.index + 1} 镜 @${p.name} 走位已补双落点（frame ${p.pSide} → frame ${p.cSide}）`)
      reportAxis()
    } catch (e) {
      failed++
      unresolved.push({ shot: p.shot.shotNumber || p.shot.id, name: p.name, reason: e.message })
      console.warn(`[generateStoryboard] 第 ${p.index + 1} 镜越轴修补失败，保留原稿:`, e.message)
      reportAxis()
    }
  }))
  console.log(`[generateStoryboard] 越轴修补完成：${fixed}/${pending.length} 成功${failed ? `，${failed} 处未修复` : ''}${verifyAfterFix ? '（已闭环复检）' : ''}`)
  for (const u of unresolved) {
    const target = flat.find((s) => (s.shotNumber || s.id) === u.shot)
    if (target) {
      if (!Array.isArray(target._axisUnresolved)) target._axisUnresolved = []
      target._axisUnresolved.push(u)
    }
  }
  return { pending: pending.length, fixed, failed, unresolved, repairedShots }
}

function buildAssetEnglishNameMap(assets) {
  const map = new Map()
  for (const group of ['characters', 'scenes', 'props']) {
    for (const asset of Array.isArray(assets?.[group]) ? assets[group] : []) {
      const name = String(asset?.name || asset?.title || '').trim()
      const nameEn = String(asset?.name_en || asset?.title_en || '').trim()
      if (name && nameEn) map.set(name, nameEn)
    }
  }
  return map
}

// The IMD intentionally uses @ChineseName for deterministic asset binding. H3's
// final-frame field is a separate English-only contract, so translate only known
// asset placeholders from the asset registry and leave unknown CJK text invalid.
export function extractFinalFrameFromIntegrated(imd, assets = null) {
  const text = String(imd || '')
  const matches = [...text.matchAll(/the\s+final\s+frame\s*:/gi)]
  if (!matches.length) return ''
  let frame = text.slice(matches[matches.length - 1].index).trim().slice(0, 1500)
  const names = buildAssetEnglishNameMap(assets)
  if (names.size) {
    for (const [name, nameEn] of [...names.entries()].sort((a, b) => b[0].length - a[0].length)) {
      frame = frame.replaceAll(`@${name}`, nameEn)
    }
  }
  return frame
}

function replaceKnownAssetNamesInEnglish(text, assets) {
  let value = String(text || '').trim()
  if (!value) return value
  const entries = []
  for (const group of ['characters', 'scenes', 'props']) {
    for (const asset of Array.isArray(assets?.[group]) ? assets[group] : []) {
      const name = String(asset?.name || asset?.title || '').trim()
      const nameEn = String(asset?.name_en || asset?.title_en || '').trim()
      if (name && nameEn) entries.push([name, nameEn])
    }
  }
  for (const [name, nameEn] of entries.sort((a, b) => b[0].length - a[0].length)) {
    value = value.replaceAll(`@${name}`, nameEn)
    value = value.replaceAll(name, nameEn)
  }
  return value.trim()
}

const FINAL_FRAME_CJK_RE = /[\u3400-\u9fff]/
const FINAL_FRAME_FACING_RE = /\bfacing\b|gazing\s+toward|looking\s+toward|turned\s+toward/i
const FINAL_FRAME_BACK_RE = /back\s+to\s+(?:the\s+)?camera|facing\s+away|with\s+their\s+back\s+to/i
const FINAL_FRAME_SEATED_RE = /\b(?:sit(?:s|ting)?|seated|crouch(?:es|ing)?)\b/i
const FINAL_FRAME_STANDING_RE = /\bstand(?:s|ing)?\b|\bon\s+(?:their|her|his)\s+feet\b/i
const FINAL_FRAME_KNEELING_RE = /\bkneel(?:s|ing)?\b/i

// Repair only the fields that are mechanically derivable from the contract. The
// source finalFrame remains preferred; IMD/worldStateOutEn are fallbacks when a
// model accidentally emits CJK text or drops the orientation anchor.
export function repairFinalFrameForContract(shot, assets = null) {
  if (!shot || typeof shot !== 'object') return false
  const original = String(shot.finalFrame || shot.final_frame || '').trim()
  const candidates = [
    original,
    extractFinalFrameFromIntegrated(shot.integratedMultimodalDescription, assets),
    String(shot.worldStateOutEn || shot.world_state_out_en || '').trim(),
  ].map((value) => replaceKnownAssetNamesInEnglish(value, assets)).filter(Boolean)
  let frame = candidates.find((value) => !FINAL_FRAME_CJK_RE.test(value)) || candidates[0] || ''
  const state = String(shot.worldStateOut || shot.world_state_out || '')
  const stateEn = replaceKnownAssetNamesInEnglish(String(shot.worldStateOutEn || shot.world_state_out_en || ''), assets)

  if (/(背对|背向)/.test(state) && !FINAL_FRAME_BACK_RE.test(frame)) {
    frame = `${frame.replace(/[.!?\s]+$/, '')}, with their back to the camera.`
  }
  if (/(坐|蹲)/.test(state) && !FINAL_FRAME_SEATED_RE.test(frame)) {
    const clause = stateEn.match(/\b(?:sit(?:s|ting)?|seated|crouch(?:es|ing)?)\b[^.;,]*/i)?.[0]
    frame = `${frame.replace(/[.!?\s]+$/, '')}, ${clause || 'seated'}.`
  }
  if (/(站|立)/.test(state) && !FINAL_FRAME_STANDING_RE.test(frame)) {
    const clause = stateEn.match(/\b(?:stand(?:s|ing)?|on\s+(?:their|her|his)\s+feet)\b[^.;,]*/i)?.[0]
    frame = `${frame.replace(/[.!?\s]+$/, '')}, ${clause || 'standing'}.`
  }
  if (/(跪)/.test(state) && !FINAL_FRAME_KNEELING_RE.test(frame)) {
    const clause = stateEn.match(/\bkneel(?:s|ing)?\b[^.;,]*/i)?.[0]
    frame = `${frame.replace(/[.!?\s]+$/, '')}, ${clause || 'kneeling'}.`
  }
  if (/(面向|朝向|朝着)/.test(state) && !FINAL_FRAME_FACING_RE.test(frame)) {
    const clause = stateEn.match(/(?:facing|gazing\s+toward|looking\s+toward|turned\s+toward)\b[^.;,]*/i)?.[0]
    frame = `${frame.replace(/[.!?\s]+$/, '')}, ${clause || 'facing forward'}.`
  }
  if (!frame) return false
  const changed = String(shot.finalFrame || '').trim() !== frame
  shot.finalFrame = frame
  return changed
}

// 景别归一已抽到 ai/shotTypes.js（档位表 / 归并表 / 英文映射三处共用同一份数据）


export async function generateStoryboard(script, style = config.defaultArtStyle, assets = null, options = {}) {
  const targetDuration = Number(options.targetDuration) || 0
  const assetMaps = assets ? buildAssetMaps(assets) : null
  const scriptSceneTitles = parseScriptSceneTitles(script)
  const assetListPrompt = assets ? buildAssetListPrompt(assets) : ''
  // Skill 规则（唯一事实源）+ 平台契约适配段：方法论服从 Skill，格式/物理边界服从契约
  const skillRules = loadSkillRules()
  const contractBlock = buildStoryboardContract()
  const physicsBlock = buildH3PhysicsBlock()

  const buildAndRun = async (retryNote, sceneScope = null) => {
    const messages = [
      {
        role: 'system',
        content: `你是一名电影分镜导演。你的镜头设计方法论以【Skill 分镜规则】为唯一权威来源（xiaomo-film-studio 小墨影视工作室），下方规则全文必须先通读、全部硬性约束严格遵守（场景空间适配 S1-S4/O1/O2/X、侧45度默认机位体系、情绪匹配、180°轴线与30°规则、站桩说话禁令与长镜头拆分、表演克制三通道、五层色彩、光源动机与物理雾双检、全程无背景音乐）。
【冲突仲裁】Skill 规则教你输出 Markdown 文档；本平台是生产管线——【镜头设计方法论服从 Skill 规则，输出格式服从平台 JSON 契约】（时长/字段/BGM 等冲突处一律服从契约）。【重要】立刻输出 JSON，禁止任何思考、分析、解释或前言。回复必须以一个左大括号 { 开头，以一个右大括号 } 结尾，中间是合法 JSON。

<skill_storyboard_rules>
${skillRules.storyboard}
</skill_storyboard_rules>

<skill_visual_quality>
${skillRules.visualQuality}
</skill_visual_quality>

${contractBlock}
${physicsBlock}
${assetListPrompt}
【剧本格式说明·必读】剧本的每一行/每一段是一个叙事信息点，【不是镜头】——严禁把剧本的换行、空行或分行当作镜头切点；一场戏的镜头数由剧本情形与 Skill 规则裁决。${styleLockRule(style, options.styleCategory || '')}${retryNote}

每个镜头必须输出以下字段（JSON 键名严格如下，定义见上方【平台 JSON 输出契约】）：

输出格式（严格合法 JSON，以 { 开头 } 结尾，字段名与契约一致）：
{
  "scenes": [
    {
      "title": "场次标题",
      "shots": [
        {
          "shotType": "中景",
          "spaceType": "O2",
          "spaceEvidence": "两侧高墙夹持的窄巷，只容一人通过，左侧高墙右侧临空",
          "lens": "标准 35mm",
          "cameraAngle": "侧45度",
          "cameraElevation": "微俯",
          "cameraMovement": "跟拍",
          "startTime": 0,
          "endTime": 8,
          "duration": 8,
          "description": "画面内容 3-6 句：覆盖关键人物位置与动作、声明视觉中心；光影叙事直接写在本字段（光源方向/光位/色温/明暗交界线）；情绪用可见动作与微表情外化，禁形容词直给",
          "colorLighting": "按本集视觉基调填写：主色调定性+高光/阴影参考色值+色温数值+五层参数（palette主色调/saturation饱和度/film_stock胶片感/grain颗粒/halation光晕），全部从剧本视觉基调推导，不得自造基调",
          "actionNote": "0-1s 保持静止；At 1.5s 抬头看向目标；末 1s 静止无动作",
          "dialogue": null,
          "soundEffects": "环境风声、衣料摩擦的细响",
          "overallSoundscape": "本场景的环境底噪（按剧本环境描述写，如风声/雨声/街市人声/虫鸣）",
          "nonDiegeticMusic": "",
          "humanVoice": "",
          "finalFrame": "The final frame: X stands at frame left facing frame right, gazing toward the target, key light from frame left, shadows cast on the ground.",
          "integratedMultimodalDescription": "[Shot 1] [本项目画风的英文风格声明，按 styleLockRule 指定的画风填写，不得套用其他画风]. Medium shot, medium distance, 45-degree side angle slightly from above, the camera tracks forward at slow speed. Module 2 [Style & Character Lock]: @角色甲, exactly as shown, [资产清单该角色 description_en 原句]. Speaking rule for this segment: no character speaks, all lips remain completely closed. Module 3 [Environment Freeze]: The [场景甲 summary_en 原句] remains completely unchanged in structure, color, and arrangement throughout the entire segment. Module 4 [Timeline Action]: At 00:01.500, @角色甲 [动作+最终状态+否定约束]. Module 5 [Prop Declaration]: no prop appears in this frame. Module 6 [Final Frame]: The final frame: [与 finalFrame 字段逐字一致].（完整英文 6 模块，规范见上方 integratedMultimodalDescription 字段说明，整段 220 词内）",
          "isCombat": false,
          "purpose": "建立空间与行进状态",
          "emotionTone": "克制不安",
          "worldStateOut": "@角色甲：画面左·手空·面向右",
          "worldStateOutEn": "Character A is at frame left, both hands empty, facing frame right.",
          "characters": ["角色甲"],
          "sceneAssets": ["场景甲"],
          "propAssets": []
        }
      ]
    }
  ]
}
}

${sceneScope
? `${style ? `画风：${style}。` : ''}【本场范围】${sceneScope.title
? `整个剧本共 ${sceneScope.total} 个场次，你只负责第 ${sceneScope.index} 场「${sceneScope.title}」。输出的 scenes 数组必须包含且仅包含 1 个场次对象，其 title 必须是「${sceneScope.title}」。`
: `整份剧本没有分场标记，已被自动切成 ${sceneScope.total} 个连续部分，你只负责第 ${sceneScope.index} 部分。输出的 scenes 数组必须包含且仅包含 1 个场次对象，title 请根据该部分剧情自行概括（2-8 个字）。`}${sceneScope.perSceneDuration ? `本场内容量参考约 ${sceneScope.perSceneDuration} 秒——★这是【长度参考】，不是镜头数目标：不要用"时长÷单镜"反推镜头数，镜头数完全由剧本情形决定。单镜 4-15 秒（物理兜底）。【拆分与流动（Skill §17/§19）】连续情形靠微运镜+镜内动作调度保持画面流动（不做一镜到底），突变情形果断碎切（切镜即节奏），空间与注意力移动用运镜；慢节奏段允许少数内部有持续动作/光影变化的长镜。` : '本场镜头数不设配额，完全由剧本情形决定：连续情形靠微运镜+镜内调度保持流动（不做一镜到底）、突变情形果断碎切、空间与注意力移动用运镜；慢节奏段允许少数内部有持续动作的长镜（单镜 4-15s 物理兜底）。'}${sceneScope.prevFinalFrame ? `\n【跨场衔接】上一场最后一个镜头的最终画面：${sceneScope.prevFinalFrame}\n本场第一个镜头的开场构图以该最终画面为参考（人物姿态、位置、构图、光线延续），承接即刻完成，不设冻结期，动作与台词可从第 0 秒直接开始。` : ''}`
: `${style && targetDuration ? `画风：${style}。【时长目标】整个分镜总时长控制在 ${targetDuration} 秒左右（允许 ±10% 浮动）。★这是【总长度参考】，不要用"时长÷单镜"反推镜头数——镜头数完全由剧本情形决定。【拆分与流动（Skill §17/§19）】连续情形靠微运镜+镜内动作调度保持画面流动（不做一镜到底），突变情形果断碎切，空间与注意力移动用运镜；慢节奏段允许少数内部有持续动作/光影变化的长镜。注意：时长约束只能压缩每场的镜头数，【绝对不允许删减、合并或跳过任何场次】。` : `画风：${style}。镜头数不设每场配额，完全由剧本情形决定：连续情形靠微运镜+镜内调度保持流动（不做一镜到底）、突变情形果断碎切、空间与注意力移动用运镜；慢节奏段允许少数内部有持续动作的长镜（单镜 4-15s 物理兜底）。`}

${scriptSceneTitles.length ? `【场次结构硬约束】剧本共 ${scriptSceneTitles.length} 个场次，你的输出 scenes 数组必须与之【一一对应】：数量相同、顺序相同、标题对应。分镜场次清单（必须全部出现，一个都不能少，也不能新增）：
${scriptSceneTitles.map((t, i) => `${i + 1}. ${t}`).join('\n')}` : ''}`}【JSON 语法要求】所有字符串值（description/finalFrame/integratedMultimodalDescription 等）内部禁止出现未转义的双引号（用单引号替代）和裸换行符；数组元素之间必须有逗号；输出必须是一次性可解析的完整合法 JSON。只输出 JSON，不要其他文字。`,
    },
    {
      role: 'user',
      content: sceneScope
        ? `本场剧本内容（第 ${sceneScope.index}/${sceneScope.total} 场「${sceneScope.title}」）：\n${sceneScope.text}`
        : `剧本内容：\n${script}`,
    },
    ]

    const normTarget = sceneScope ? (sceneScope.perSceneDuration || 0) : targetDuration
    const text = await chatCompletion(messages, {
      temperature: 0.5,
      maxTokens: config.storyboard.maxOutputTokens,
      responseFormat: { type: 'json_object' },
      timeoutMs: config.timeouts.llm.longScript, 
      maxAttempts: 1,
      retryBudgetMs: config.timeouts.llm.longScript,
      disableThinking: true,
      stream: true,
      usageContext: { task: 'storyboard' },
    })

    const parseStoryboardJson = async (raw) => {
      const jsonStr = extractFirstJson(raw)
      if (jsonStr) {
        try {
          return normalizeStoryboard(JSON.parse(jsonStr), normTarget)
        } catch (parseError) {
          try {
            const dumpPath = path.join(tasksDir, `storyboard-raw-${Date.now()}.txt`)
            fs.mkdirSync(tasksDir, { recursive: true })
            fs.writeFileSync(dumpPath, raw)
            console.warn(`[generateStoryboard] JSON 解析失败，原始输出已存 ${dumpPath}:`, parseError.message)
          } catch {  }
          throw new Error(parseError.message || '无法解析分镜生成结果')
        }
      }
      try {
        const dumpPath = path.join(tasksDir, `storyboard-raw-${Date.now()}.txt`)
        fs.mkdirSync(tasksDir, { recursive: true })
        fs.writeFileSync(dumpPath, raw)
        console.warn(`[generateStoryboard] 输出中未提取到 JSON，原始输出已存 ${dumpPath}（长度 ${String(raw || '').length}）`)
      } catch {  }
      throw new Error('无法从模型输出中提取 JSON')
    }

    const storyboard = await parseStoryboardJson(text)
      .catch((e) => ({ parseError: e }))
    if (storyboard.parseError) {
      return { storyboard: null, rawText: text, parseError: storyboard.parseError }
    }
    if (assetMaps) {
      const unmatched = []
      storyboard.scenes.forEach((scene, sceneIdx) => {
        ;(scene.shots || []).forEach((shot, shotIdx) => {
          const normalized = normalizeShotAssets(shot, assetMaps)
          if (normalized.droppedAssets) {
            const d = normalized.droppedAssets
            if (d.characters.length || d.scenes.length || d.props.length) {
              unmatched.push({
                shotNumber: normalized.shotNumber || `${sceneIdx + 1}-${shotIdx + 1}`,
                characters: d.characters,
                scenes: d.scenes,
                props: d.props,
              })
            }
          }
          scene.shots[shotIdx] = normalized
        })
      })
      applyImdHybridCompile(storyboard, assets)
      return { storyboard, rawText: text, parseError: null, unmatched }
    }
    return { storyboard, rawText: text, parseError: null, unmatched: [] }
  }

  // 只对生成结果做结构层检查。来源文档没有授权的平台语义规则不得触发模型重写。
  const contractCheck = (storyboard) => {
    if (!assets || !storyboard?.scenes?.length) return null
    try { return validateStoryboardImport(storyboard) } catch { return null }
  }
  const repairNoteFor = (validation) => `\n\n【平台结构修复重试】上一次输出的 JSON 存在平台字段结构问题：\n${formatStoryboardValidationError(validation)}\n请只修复 JSON 语法、场次/镜头容器和字段类型，完整保留原镜头数量、时长、动作、角色、台词、声音与画面语义。不要根据未在输入文件或来源文档中出现的规则新增、删除或改写内容。`
  const repairOnContract = async (r, scope = null) => {
    if (!r?.storyboard) return r
    const first = contractCheck(r.storyboard)
    if (!first || first.ok) return r
    console.warn(`[generateStoryboard] 契约校验未过（${first.errors.length} 项：${first.errors.slice(0, 3).map((e) => e.code).join(', ')}${first.errors.length > 3 ? '…' : ''}），带错误清单修复重试一次`)
    const repaired = await buildAndRun(repairNoteFor(first), scope)
    if (repaired.parseError || !repaired.storyboard) return r
    const second = contractCheck(repaired.storyboard)
    if (!second || second.errors.length < first.errors.length) return repaired
    return r
  }

  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null
  const report = (payload) => {
    if (!onProgress) return
    try { onProgress(payload) } catch {  }
  }
  let sceneBlocks = parseScriptSceneBlocks(script)

  if (sceneBlocks.length <= 1 && countNonSpace(script) > AUTO_CHUNK_MIN_CHARS) {
    const chunks = chunkScriptByParagraphs(script)
    if (chunks.length > 1) {
      console.log(`[generateStoryboard] 剧本无场次标记，按段落自动分块：${chunks.length} 块`)
      sceneBlocks = chunks.map((text) => ({ title: '', text }))
    }
  }

  if (sceneBlocks.length > 1) {
    const perSceneDurations = allocateSceneDurations(targetDuration, sceneBlocks)
    if (targetDuration > 0 && perSceneDurations.some((d) => d > 0)) {
      console.log(`[generateStoryboard] 目标 ${targetDuration}s 按内容量加权分配到 ${sceneBlocks.length} 场：${perSceneDurations.join('/')}s`)
    }
    const parallelScenes = config.storyboard?.parallel !== false

    const generateSceneAt = async (i) => {
      const scope = {
        title: sceneBlocks[i].title,
        text: sceneBlocks[i].text,
        index: i + 1,
        total: sceneBlocks.length,
        perSceneDuration: perSceneDurations[i] || 0,
      }
      console.log(`[generateStoryboard] 分场生成 第 ${i + 1}/${sceneBlocks.length} ${scope.title ? `场「${scope.title}」` : '块（自动分块）'}`)
      let r = await buildAndRun('', scope)
      if (r.parseError) {
        console.warn(`[generateStoryboard] 第 ${i + 1} 场 JSON 解析失败，自动重试:`, r.parseError.message)
        const retryNote = `\n\n【纠错重试】你上一次输出的 JSON 存在语法错误（${r.parseError.message}）。请重新输出本场分镜 JSON：数组元素间必须有逗号、字符串值内不出现未转义的双引号和换行、括号完整闭合。`
        r = await buildAndRun(retryNote, scope)
        if (r.parseError) throw r.parseError
      }
      r = await repairOnContract(r, scope)
      if (!r.storyboard.scenes.length) throw new Error(`第 ${i + 1} 块（${scope.title || '自动分块'}）未返回分镜`)
      if (r.storyboard.scenes.length > 1) {
        console.warn(`[generateStoryboard] 第 ${i + 1}/${sceneBlocks.length} 场「${scope.title || '自动分块'}」要求仅返回 1 个场次，模型返回了 ${r.storyboard.scenes.length} 个，已取第 1 个，其余场次的镜头被丢弃`)
      }
      const scene = r.storyboard.scenes[0]
      const sceneSource = r

      if (scope.title) scene.title = scope.title 
      console.log(`[generateStoryboard] 第 ${i + 1}/${sceneBlocks.length} 场完成（${(scene.shots || []).length} 镜）`)
      return { scene, unmatched: Array.isArray(sceneSource.unmatched) ? sceneSource.unmatched : [] }
    }

    const allScenes = []
    const allUnmatched = []
    report({ phase: PHASE.SCENES, done: 0, total: sceneBlocks.length, message: `分场生成中：0/${sceneBlocks.length} 场完成` })

    if (!parallelScenes) {
      for (let i = 0; i < sceneBlocks.length; i++) {
        report({
          phase: PHASE.SCENES,
          done: i,
          total: sceneBlocks.length,
          currentLabel: sceneBlocks[i].title || `第 ${i + 1} 块`,
          message: `正在生成第 ${i + 1}/${sceneBlocks.length} 场${sceneBlocks[i].title ? `「${sceneBlocks[i].title}」` : ''}…`,
        })
        const { scene, unmatched } = await generateSceneAt(i)
        allScenes.push(scene)
        allUnmatched.push(...unmatched)
        report({
          phase: PHASE.SCENES,
          done: i + 1,
          total: sceneBlocks.length,
          currentLabel: sceneBlocks[i].title || `第 ${i + 1} 块`,
          message: `分场生成中：${i + 1}/${sceneBlocks.length} 场完成`,
        })
      }
      // 保留 Skill 原始镜头边界，不执行平台自定义合并。
    } else {
      console.log(`[generateStoryboard] 两阶段并行：${sceneBlocks.length} 场同时发起，完成后进入归一化`)
      let doneCount = 0
      const results = await Promise.all(sceneBlocks.map(async (_, i) => {
        const r = await generateSceneAt(i)
        doneCount++
        report({
          phase: PHASE.SCENES,
          done: doneCount,
          total: sceneBlocks.length,
          currentLabel: sceneBlocks[i].title || `第 ${i + 1} 块`,
          message: `分场并行生成中：${doneCount}/${sceneBlocks.length} 场完成`,
        })
        return r
      }))
      for (const { scene, unmatched } of results) {
        allScenes.push(scene)
        allUnmatched.push(...unmatched)
      }

      // 保留 Skill 原始镜头边界，不执行平台自定义合并。

      // 跨场衔接由「尾帧参考图 + 提示词承接句」承担，无跨场文本修补阶段
      //（原 Airlock 跨场修补链已于 2026-09-24 事故整改中整体废除，不再有任何跨场文本改写/修补。）
      console.log('[generateStoryboard] 跳过跨场文本修补：跨场衔接改由尾帧参考图 + 提示词承接句承担')

      // Skill 已决定机位与轴线。生成后不再调用 LLM 重写镜头，避免把已定稿的
      // 构图、动作或镜头边界改成平台自己的解释。
    }
    const normalizedMulti = normalizeStoryboard({ scenes: allScenes }, targetDuration)
    normalizedMulti.unmatched = allUnmatched
    // 出片提示词预算守卫（H3 硬上限 7000）——超限镜头自动瘦身，保证可出片
    enforcePromptBudget(normalizedMulti, assets)
    return normalizedMulti
  }

  report({ phase: PHASE.SINGLE, done: 0, total: 1, message: '整本生成中（剧本未分场，单次输出较长，约 1-2 分钟）…' })
  let result = await buildAndRun('')

  if (result.parseError) {
    console.warn('[generateStoryboard] JSON 解析失败，自动重试:', result.parseError.message)
    const retryNote = `\n\n【纠错重试】你上一次输出的 JSON 存在语法错误（${result.parseError.message}），导致解析失败。请重新输出完整分镜 JSON：确保所有数组元素之间有逗号、字符串值内不出现未转义的双引号和换行、括号完整闭合。`
    result = await buildAndRun(retryNote)
    if (result.parseError) throw result.parseError
  }
  result = await repairOnContract(result)

  const finalizeStoryboard = (sb) => {
    // H3 适配只处理 prompt 的物理上限，不改变 Skill 已定稿的镜头数量和顺序。
    enforcePromptBudget(sb, assets)
    return sb
  }

  const storyboard = result.storyboard
  if (scriptSceneTitles.length && storyboard.scenes.length !== scriptSceneTitles.length) {
    console.warn(
      `[generateStoryboard] 场次数不匹配：剧本 ${scriptSceneTitles.length} 场，分镜只有 ${storyboard.scenes.length} 场（${storyboard.scenes.map((s) => s.title).join('、')}），自动重试`
    )
    const retryNote = `\n\n【纠错重试】上一次输出只有 ${storyboard.scenes.length} 个场次，与剧本的 ${scriptSceneTitles.length} 个场次不符。本次必须输出完整 ${scriptSceneTitles.length} 个场次：${scriptSceneTitles.join('、')}，一场都不能少，每个场次至少 1 个镜头。`
    const retried = await buildAndRun(retryNote)
    if (retried.parseError) throw retried.parseError
    const retriedFixed = await repairOnContract(retried)
    const retriedStoryboard = retriedFixed.storyboard || retried.storyboard
    retriedStoryboard.unmatched = Array.isArray(retried.unmatched) ? retried.unmatched : []
    return finalizeStoryboard(retriedStoryboard)
  }
  storyboard.unmatched = Array.isArray(result.unmatched) ? result.unmatched : []
  return finalizeStoryboard(storyboard)
}

export async function generateStoryboardFromFile(fileContent, style = config.defaultArtStyle, assets = null, options = {}) {
  const normalizedFileText = String(fileContent || '').replace(/\r\n/g, '\n').trim()
  if (countNonSpace(normalizedFileText) > FILE_NORMALIZE_CHUNK_MIN_CHARS && !options.__fileChunk) {
      const chunks = splitStoryboardFileIntoChunks(normalizedFileText)
      if (chunks.length > 1) {
      const mergedScenes = []
      const unmatched = []
      reportProgressForFileChunks(options.onProgress, chunks.length)
        for (let index = 0; index < chunks.length; index += 1) {
          console.log(`[generateStoryboardFromFile] 文件分批规整 ${index + 1}/${chunks.length}（${countNonSpace(chunks[index])} 字）`)
        const chunkResult = await generateStoryboardFromFile(chunks[index], style, assets, {
          ...options,
          __fileChunk: true,
          onProgress: (payload) => {
            if (typeof options.onProgress !== 'function') return
            try {
              options.onProgress({ ...payload, done: index + (payload.done ? 1 : 0), total: chunks.length, message: `正在分批规整分镜：${index + 1}/${chunks.length}…` })
            } catch { }
          },
        })
        if (Array.isArray(chunkResult.scenes)) {
          for (const scene of chunkResult.scenes) {
            const existing = mergedScenes.find((item) => String(item.title || '') === String(scene.title || ''))
            if (existing) existing.shots.push(...(scene.shots || []))
            else mergedScenes.push({ ...scene, shots: [...(scene.shots || [])] })
          }
        }
        if (Array.isArray(chunkResult.unmatched)) unmatched.push(...chunkResult.unmatched)
      }
      let cursor = 0
      for (const scene of mergedScenes) {
        for (const shot of scene.shots || []) {
          const duration = Math.max(
            config.storyboard?.durationMin ?? 4,
            Math.min(config.storyboard?.durationMax ?? 15, Math.round(Number(shot.duration) || config.storyboard?.defaultDuration || 8))
          )
          shot.startTime = cursor
          shot.endTime = cursor + duration
          shot.duration = duration
          cursor += duration
        }
      }
      return { scenes: mergedScenes, unmatched }
    }
  }
  const assetMaps = assets ? buildAssetMaps(assets) : null
  const assetListPrompt = assets ? buildAssetListPrompt(assets) : ''
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null
  const report = (payload) => {
    if (!onProgress) return
    try { onProgress(payload) } catch {  }
  }
  report({ phase: PHASE.NORMALIZE, done: 0, total: 1, message: '正在规整分镜结构（首次调用，约 1-3 分钟）…' })

  const buildAndRun = async (retryNote) => {
    const messages = [
      {
        role: 'system',
        content: `你是一个专业的分镜结构规整器（不是分镜创作师）。输入是一份【已经是分镜】的内容——可能是从 Excel/Word 导出的表格文本、Markdown 列表、或不规范的纯文本分镜脚本，字段顺序混乱、措辞口语化、甚至可能缺失某些字段。你的唯一任务是对它做【忠实提取 + 结构规整】，把它映射到标准镜头 JSON，绝不要把它当成剧本去重新创作。

【核心铁律·不可违反】
1. 不创作：原文件有几个镜头，就输出几个镜头。禁止新增镜头、禁止凭空补充画面内容、禁止合并或拆分镜头。
2. 不改写画面含义：保留用户原有的镜头语义。只允许把口语/不规范表述规整成标准字段写法，不允许改变"拍什么"。如果用户原文描述已连贯合规，尽量保留字面原话。
3. 不改动用户给定时长：只要用户在原内容里给出了某镜时长（如"5s""时长3秒"），必须原样保留到 duration 字段（整数秒）；只有在用户完全没给时长时，才由你按动作复杂度合理估算 4-15 秒。
4. 不合并/不重建场次：若原文件本身有场景/场次划分（如"第1场""场景A"），原样保留为 scenes；若原文件没有分场，则把所有镜头归到一个 scene（title 可写"全片"或留空）。禁止自创分场。
5. ${assetNameRule()}清单外出现的 @名 一律不要写进资产数组，改为在输出末尾的 __unmatched 里列出（见下方格式）。清单里没有的角色/道具/场景，宁可不列也不要编造新名。
6. 时间轴：若用户给了每镜时长，按 startTime 累加（首镜 startTime=0，后续=上一镜 endTime），连续不重叠；否则从 0 起按估算时长累加。
7. 【伪台词识别】原文中"台词：音效(...)「...」""台词：字幕淡入(...)「...」""台词：题材(...)「...」"这类行【不是任何角色的台词】——音效内容并入该镜 soundEffects 字段；字幕内容写入 description 末尾（前缀"片尾字幕："）或直接丢弃；题材/角色表/风格等元信息直接丢弃。绝不能把 character 写成"音效/字幕/题材"塞进 dialogue——对话生成模型会把它们当成台词念出来，属于严重缺陷。
8. 【字段保真】输出必须保留原文件已有的 transitionIn/transitionOut、worldStateIn/worldStateOut；没有原值才留空。不得为了补字段改写原镜头语义。
9. 【时间轴保真】原文件已有的 actionNote、台词、声音和时长必须原样保留；不要为了平台自定义格式删除、合并或改写动作语义。

每个镜头必须输出以下字段（缺失字段填空字符串或 null，不要省略键）：
- shotType: 景别，取值（Skill §3 档位表）：${shotTypeTermsText()}（用户原文明确标注其他写法则原样保留；未标注按描述推断，至少给"中景"）
- spaceType: 空间类型代号 S1/S2/S3/S4/O1/O2/X（用户原文有则提取，无则按场景尺度推断）
- spaceEvidence: 空间判定依据中文一句话（用户原文有则提取，无则按场景结构写一句，如「两侧高墙夹持的窄巷，只容一人通过」）；与 spaceType 成对，不得留空
- lens: 焦段（如「中长焦 85mm」「广角 24mm」，用户原文有则提取，无则空字符串）
- cameraAngle: 水平机位（Skill §5 方向轴）：正面/侧45度/侧面/过肩/主观（用户原文有则提取；如「侧45度+微俯」拆为 cameraAngle=侧45度 + cameraElevation=微俯）
- cameraElevation: 俯仰：平视/微俯/俯拍/大俯角/微仰/仰拍/大仰角（无则空字符串）
- startTime/endTime: 整数秒
- duration: 整数秒
- description: 中文画面描述，用 @角色名/@道具名/@场景名 标记出现的资产；若用户原描述已合规则保留原话，不塞 integratedMultimodalDescription 内容、不写"音效：""角色："等带冒号小标题；原文的「画面内容」「光影」两段合并进本字段
- colorLighting: 色调方案整行（原文「色调」字段原样提取，无则空字符串）
- humanVoice: 表演性人声（原文「人声」字段提取，"无"则空字符串）
- actionNote: 动作说明（无则空字符串）
- cameraMovement: 运镜（原文表头「推镜/跟拍/手持剧烈晃动/微运镜（极缓慢推）」等原样提取；可复合；俯拍/仰拍属 cameraElevation 不写这里；无则"固定"）
- soundEffects: 画内音效（原文「音效」字段提取"音桥入/出"标注，无则空字符串）
- overallSoundscape: 环境声（无则空字符串）
- nonDiegeticMusic: 一律空字符串 ""（Skill 规则全程无 BGM；原文若含配乐建议也丢弃）
- dialogue: 台词对象或数组 {character, tone, text, startTime}；character 必须是真实角色名（与资产清单 characters 匹配）；无台词为 null（"台词：音效/字幕/题材"这类伪台词行禁止进入本字段，见铁律 7）
- transitionIn/transitionOut: 入/出场转场原值；worldStateIn/worldStateOut 有原值就保留，没有原值填空；不得根据平台自定义连续性规则改写角色在场、离场或硬切语义
- isCombat: 布尔，本镜有无动作对抗（原文表头「人物镜头/非人物镜头」不是本字段；按内容判定，无把握填 false）
- purpose: 本镜叙事任务一句话（可从原文推断，10-30 字）
- emotionTone: 情绪基调 2-6 字（可从原文推断）
- worldStateOut: 末帧实体状态快照（可从末帧描述推断，紧凑中文格式）
- worldStateOutEn: 上一条的中文快照对应的纯英文版，逐项对齐不许增删（谁在画面哪个位置·姿态·朝向·手持/驮负关系）。用 "X is at ... facing ..." 直陈句式，30-80 英文词；角色名与场景名保留中文原样（如 "角色中文名 is at frame center"）。此字段与 worldStateOut 必须严格同义，不得独立发挥
- characters/sceneAssets/propAssets: 资产名数组，逐字匹配资产清单
- finalFrame: 本镜最终画面描述，必须是纯 ASCII 英文（禁止任何中文字符）；角色/场景/道具必须使用资产的 name_en/title_en，不得直接写中文资产名。逐项复述 worldStateOut 的位置、姿态、手持和朝向：面向/朝向/朝着必须写 facing/gazing toward/looking toward，背对/背向必须写 back to the camera/facing away；含画面侧位与光位方向色温
- integratedMultimodalDescription: 用户原文若已含多模态提示词则原样提取，否则空字符串（不强制补全）

输出格式（严格合法 JSON，以 { 开头 } 结尾）：
{
  "scenes": [
    { "title": "场次标题或空字符串",
      "shots": [ { 上述字段... } ] }
  ],
  "__unmatched": [ "清单外出现的资产名1", "资产名2" ]
}

${assetListPrompt}【JSON 语法要求】字符串值内部禁止未转义双引号和裸换行；数组元素间必须有逗号；只输出 JSON 不输出其他文字。${retryNote}`,
      },
      {
        role: 'user',
        content: `以下是需要规整的分镜内容：\n${fileContent}`,
      },
    ]

    const text = await chatCompletion(messages, {
      temperature: 0.3,
      maxTokens: 12000,
      responseFormat: { type: 'json_object' },
      timeoutMs: config.timeouts.llm.longScript,
      maxAttempts: 1,
      retryBudgetMs: config.timeouts.llm.longScript,
      disableThinking: true,
      stream: true,
      usageContext: { task: 'storyboard' },
    })

    const parseStoryboardJson = async (raw) => {
      const jsonStr = extractFirstJson(raw)
      if (jsonStr) {
        try {
          const parsed = JSON.parse(jsonStr)
          // sourceText 传原始分镜文本（不是 LLM 的 JSON 输出）：表头是确定性来源，
          // 机位/俯仰/焦段的权威值在原文表头里，不在模型的 JSON 里。
          const storyboard = normalizeStoryboard(parsed, 0, { sourceText: fileContent })
          const unmatched = []
          const fileUnmatched = Array.isArray(parsed.__unmatched) ? parsed.__unmatched.map(String) : []
          if (fileUnmatched.length) {
            unmatched.push({ shotNumber: 'file', characters: [], scenes: [], props: fileUnmatched })
          }
          if (assetMaps) {
            storyboard.scenes.forEach((scene, sceneIdx) => {
              ;(scene.shots || []).forEach((shot, shotIdx) => {
                const normalized = normalizeShotAssets(shot, assetMaps)
                if (normalized.droppedAssets) {
                  const d = normalized.droppedAssets
                  if (d.characters.length || d.scenes.length || d.props.length) {
                    unmatched.push({
                      shotNumber: normalized.shotNumber || `${sceneIdx + 1}-${shotIdx + 1}`,
                      characters: d.characters,
                      scenes: d.scenes,
                      props: d.props,
                    })
                  }
                }
                scene.shots[shotIdx] = normalized
              })
            })
          }
          // 文件导入只做字段规整与资产名绑定；不自动补写末帧、静音声明或画面语义。
          return { storyboard, rawText: text, parseError: null, unmatched }
        } catch (parseError) {
          try {
            const dumpPath = path.join(tasksDir, `storyboard-file-raw-${Date.now()}.txt`)
            fs.mkdirSync(tasksDir, { recursive: true })
            fs.writeFileSync(dumpPath, raw)
            console.warn(`[generateStoryboardFromFile] JSON 解析失败，原始输出已存 ${dumpPath}:`, parseError.message)
          } catch {  }
          throw new Error(parseError.message || '无法解析规整结果')
        }
      }
      throw new Error('无法从模型输出中提取 JSON')
    }

    const storyboard = await parseStoryboardJson(text).catch((e) => ({ parseError: e }))
    if (storyboard.parseError) return { storyboard: null, rawText: text, parseError: storyboard.parseError }
    return { storyboard: storyboard.storyboard, rawText: text, parseError: null, unmatched: storyboard.unmatched || [] }
  }

  let result = await buildAndRun('')
  if (result.parseError) {
    console.warn('[generateStoryboardFromFile] JSON 解析失败，自动重试:', result.parseError.message)
    report({ phase: PHASE.RETRY, done: 0, total: 1, message: '首次规整结果格式有误，正在自动重试…' })
    const retryNote = `\n\n【纠错重试】你上一次输出的 JSON 存在语法错误（${result.parseError.message}），导致解析失败。请重新输出完整分镜 JSON：确保所有数组元素之间有逗号、字符串值内不出现未转义的双引号和换行、括号完整闭合。`
    result = await buildAndRun(retryNote)
    if (result.parseError) throw result.parseError
  }
   report({ phase: PHASE.NORMALIZE, done: 1, total: 1, message: '结构规整完成，正在对齐资产…' })

  const storyboard = result.storyboard
  if (!storyboard.scenes || !storyboard.scenes.length) throw new Error('规整结果缺少 scenes')
  storyboard.unmatched = Array.isArray(result.unmatched) ? result.unmatched : []
  return storyboard
}

// IMD 清洗规则由 config 提供（默认全空 = 不清洗）。
// 平台不内置任何剧集专属的外观禁忌词表：换一部剧不需要改代码，需要禁词时配 env 即可。
function sanitizeIntegrated(text) {
  if (!text) return text
  const cfg = config.video?.integrated || {}
  const hints = Array.isArray(cfg.prohibitedHints) ? cfg.prohibitedHints : []
  const patterns = Array.isArray(cfg.stripClausePatterns) ? cfg.stripClausePatterns : []
  if (!hints.length && !patterns.length) return text

  let cleaned = text
  if (hints.length) {
    cleaned = cleaned.replace(
      /(@[\u4e00-\u9fa5A-Za-z0-9]+,\s*exactly as shown,\s*)[^.\n]*([.\n])/g,
      (m, prefix, terminator) => {
        const tail = m.slice(prefix.length, m.length - terminator.length)
        const hasProhibited = hints.some((kw) => tail.toLowerCase().includes(String(kw).toLowerCase()))
        return hasProhibited ? prefix.trimEnd() + terminator : m
      }
    )
  }
  for (const p of patterns) {
    try {
      cleaned = cleaned.replace(new RegExp(p, 'gi'), '')
    } catch { /* 配置正则非法时跳过，不阻断主流程 */ }
  }
  return cleaned.trim()
}

function formatDialogueText(dialogue) {
  if (!dialogue) return '无'
  if (typeof dialogue === 'string') return dialogue
  const list = Array.isArray(dialogue) ? dialogue : [dialogue]
  const lines = list
    .map((d) => `${d?.character || ''}：${d?.text || ''}`.trim())
    .filter((l) => l && l !== '：')
  return lines.length ? lines.join('；') : '无'
}

export async function enrichShotIntegrated(shot, assets, style = '', opts = {}) {
  const assetListPrompt = buildAssetListPrompt(assets)
  const dialogue = formatDialogueText(shot.dialogue)

  const messages = [
    {
      role: 'system',
      content: `你是专业的 AI 视频提示词工程师，精通 AI 视频控制式 prompt 写法（用于本项目的画面描述字段，按其六模块结构书写）。【重要】立刻输出 integrated_multimodal_description 正文，不要任何思考、分析、解释或前言。请根据给定的单个镜头信息，为该镜头生成完整的 integrated_multimodal_description（英文，6 模块结构）。${assetListPrompt}

画风：${style || config.defaultArtStyle}（画面开头声明画风，全片严格统一，禁止偏离）。

6 模块结构（严格按此书写，用换行分隔）：
${integratedModulesRule()}${frameGeographyRule()}
【硬约束】
- 模块2/3 的角色与环境外貌必须【逐字复制】资产清单 description，禁止增删改、禁止编造清单外特征（帽子/服装/性别/年龄/体型等）。
- 镜头描述或最终画面中 @ 提到的所有角色（含不说话的角色）都必须在模块2 中出现并锁定外观。
- 模块内提及角色一律写 @中文名（如 @角色名），平台解析为规范英文名；禁止自造英文名/音译/别名——名字对不上，出片时角色与参考图的绑定会静默丢失。
${styleLockRule(style, opts.styleCategory || '')}
- 只输出 integrated_multimodal_description 正文，不要输出 JSON、不要标题、不要解释。`,
    },
    {
      role: 'user',
      content: `镜头描述：${shot.description || ''}
时长：${shot.duration || config.storyboard?.defaultDuration || 8} 秒
景别：${shot.shotType || config.storyboard?.defaultShotType || '中景'}
角色：${(shot.characters || []).join('、') || '无'}
场景：${(shot.sceneAssets || []).join('、') || '无'}
道具：${(shot.propAssets || []).join('、') || '无'}
台词：${dialogue}
动作说明：${shot.actionNote || '无'}
本镜开场状态：${shot.worldStateIn || '无'}
本镜收尾状态：${shot.worldStateOut || '无'}
收尾状态必须在 The final frame 中逐项可见；不要添加状态字段之外的新主体或道具。`,
    },
  ]

  const text = await chatCompletion(messages, {
    temperature: 0.5,
    maxTokens: 2000,
    timeoutMs: config.timeouts.llm.standard,
    disableThinking: true,
  })
  // IMD 混合编译：模块2/3 由资产库英文原文程序注入，LLM 版仅作结构填充
  const compiled = compileIntegratedModules(sanitizeIntegrated(text), shot, assets)
  if (compiled.injected.length) {
    console.log(`[enrichShotIntegrated] 混合编译注入模块：${compiled.injected.join('/')}${compiled.kept.length ? `（${compiled.kept.join('/')} 缺英文原文，保留 AI 版）` : ''}`)
  }
  // 角色称呼确定性归一（治本）：LLM 可能把两字中文名拼音粘连音译、描述型中文名意译回英文，
  // 落库前按资产表改回规范名，保证出片侧 <Subject N> 绑定必中。空转无副作用。
  const canon = canonicalizeImdCharacterNames(compiled.text, assets)
  if (canon.replaced.length) {
    console.log(`[enrichShotIntegrated] 角色称呼归一：${canon.replaced.map((r) => `${r.name}×${r.count}(${r.kind})`).join('，')}`)
  }
  // 画风是项目级生产约束，不能只依赖模型是否听懂提示词；在 IMD 落库前
  // 确定性写入可追溯锚点，供出片和契约校验复用。
  const styleLabel = String(style || config.defaultArtStyle || '').trim()
  if (styleLabel && !/(arts*style|visuals*style|render(?:ing)?s*style|sames+style|styles+as|画风|风格)/i.test(canon.text)) {
    return `Visual style lock: ${styleLabel}.\n${canon.text}`
  }
  return canon.text
}

// ---- 单镜重生成（供 POST /episodes/:id/shots/:shotId/regenerate 使用）----

const REGEN_SHOT_MAX_TOKENS = 6000
const REGEN_SHOT_ATTEMPTS = 2

function regenCtxBlock(title, lines) {
  const body = lines.filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
    .map(([k, v]) => `${k}：${v}`).join('\n')
  return body ? `【${title}】\n${body}` : ''
}

// 上下文素材里的资产引用块（角色/场景/道具三行）
function regenAssetLines(shot) {
  return [
    ['角色', (shot?.characters || []).join('、') || '无'],
    ['场景', (shot?.sceneAssets || []).join('、') || '无'],
    ['道具', (shot?.propAssets || []).join('、') || '无'],
  ]
}

// 单镜重生成：以前镜承接（Airlock）+ 本镜叙事任务 + 后镜期望状态为上下文，LLM 重写整镜。
// ctx: { current, prev, next, related, sceneTitle, scriptSpan, instruction }，字段驼峰。
// 返回 { shot, rawText }：shot 为归一后的单镜对象（含叙事四件套；时轴字段由调用方决定是否采用）。
export async function regenerateShot(ctx, assets, style = '', opts = {}) {
  const { current, prev, next, related, sceneTitle, scriptSpan, instruction } = ctx || {}
  if (!current || (!current.description && !current.integratedMultimodalDescription)) {
    throw new Error('本镜缺少可重生成的内容')
  }
  const assetMaps = assets ? buildAssetMaps(assets) : null
  const assetListPrompt = assets ? buildAssetListPrompt(assets) : ''
  const duration = Number(current.duration) || 8
  const baseStart = Number(current.startTime) || 0
  const durationLock = `【时长硬约束】本镜 duration 固定为 ${duration} 秒，禁止改变（时轴由系统管理，AI 只负责在此时长内完成调度）。本镜在全片时间轴上从第 ${baseStart} 秒开始、第 ${baseStart + duration} 秒结束；镜 startTime 输出 ${baseStart}，台词 startTime 用全片绝对秒（介于 ${baseStart} 与 ${baseStart + duration} 之间）。`

  const prevBlock = prev
    ? regenCtxBlock(`上一镜（${prev.shotNumber || ''}）· 本镜开场构图承接其最终画面`, [
        ['最终画面 finalFrame', prev.finalFrame],
        ['出场状态 worldStateOut', prev.worldStateOut],
      ])
    : ''
  const nextBlock = next
    ? regenCtxBlock(`下一镜（${next.shotNumber || ''}）· 其开头将复刻本镜的最终画面`, [
        ['下一镜入场状态（= 本镜结束必须交付的状态）', next.worldStateIn],
      ])
    : ''
  const relatedBlock = related
    ? regenCtxBlock(`关联镜头（${related.shotNumber || ''}）· 与本镜存在叙事/空间关联`, [
        ['画面描述', related.description],
        ['出场状态', related.worldStateOut],
      ])
    : ''
  const scriptBlock = scriptSpan ? `【本镜对应的剧本片段】\n${scriptSpan}` : ''

  const skillRules = loadSkillRules()

  const messages = [
    {
      role: 'system',
      content: `你是专业的分镜师，精通 AI 视频生成的"控制式 prompt"写法。任务：在保持叙事任务与前后镜衔接不变的前提下，重写【单个镜头】的全部内容。输出严格的 JSON 格式，立刻输出 JSON，禁止任何思考、分析、解释或前言。${assetListPrompt}

画风：${style || config.defaultArtStyle}（与全片一致，禁止偏离）。

【冲突仲裁】你的镜头设计方法论以【Skill 分镜规则】为唯一权威来源（xiaomo-film-studio 小墨影视工作室），下方规则全文必须先通读、全部硬性约束严格遵守；下方平台条款只规定输出格式与出片物理边界——【镜头设计方法论服从 Skill 规则，输出格式与时长字段服从平台契约】。

<skill_storyboard_rules>
${skillRules.storyboard}
</skill_storyboard_rules>

<skill_visual_quality>
${skillRules.visualQuality}
</skill_visual_quality>

【铁律】
1. 视觉锁定：角色外貌必须【逐字复制】资产清单中该角色的 description；清单里没有的特征绝对禁止添加。场景描写必须【逐字复制】该场景的 description，禁止编造清单外元素。
2. 道具专属：每个道具声明 "belongs exclusively to @XX"，其他角色 "paws/hands remain empty"。
3. 动作微分解：道具动作拆成 动作方式 → 最终状态 → 材质确认 → 否定约束 四段。
4. 多模态分离：画面/声景/音乐/台词分模块独立书写。
${frameGeographyRule()}
${stagingRule()}
${pointOfViewRule()}
${cameraCraftRule()}
${cameraBeatRule()}
${beatLayerRule()}
${holdRule()}
${editRule()}
${cinematographyRule()}
${styleLockRule(style, opts.styleCategory || '')}
${durationLock}

【重写边界】
- 保持本镜的叙事任务（purpose/goal/emotionTone/infoPoints）不变，除非用户指令明确要求调整；
- 本镜结束状态 worldStateOut 必须与【下一镜入场状态】完全兼容（位置·手持·朝向逐项对齐）；
- 资产只能使用清单内的名字，禁止新增角色/场景/道具；${assetNameRule()}${characterCoverageRule()}
- 台词措辞可润色，但说话人与信息量不得增删。

【输出字段】（单镜 JSON）
{
  "shot": {
    "shotType": "${shotTypeTermsText()}（Skill §3 档位表，按本镜内容选一）",
    "startTime": ${baseStart},
    "cameraMovement": "运镜（一镜一个主运镜；固定镜头全片≤10%，Skill §6）",
    "camera_angle": "Skill §5 方向×高度组合（如 侧45度+微仰）：方向取 正面/侧45度/侧面/过肩/主观，高度取 平视/微仰/微俯/仰拍/俯拍/大仰角/大俯角；纯平视只写方向",
    "transition_in": "原稿有值时原样保留；场内普通直接切镜填「切」；仅当 xiaomo-film-studio 明确设计动作/视线/图形匹配或视桥时填写「动作匹配」「视桥」等连续承接语义；原稿未填写则留空，平台不得自动推断连续承接",
    "duration": ${duration},
    "description": "中文画面描述 3-6 句（信息密度优先于句数，Skill 单镜头模板），用 @角色名/@道具名/@场景名 标记资产",
    "actionNote": "动作说明",
    "soundEffects": "画内音效，没有则为空字符串",
    "overallSoundscape": "环境声，没有则为空字符串",
    "nonDiegeticMusic": "一律输出空字符串（Skill §14 全程无背景音乐，硬规则无例外）",
    "isCombat": true/false,
    "purpose": "本镜叙事任务（10-30字）",
    "goal": "观众任务（10-30字）",
    "emotionTone": "情绪基调（2-6字）",
    "infoPoints": ["关键信息点（0-3个）"],
    "worldStateOut": "@角色：画面位置·手持·朝向；@道具：位置·状态",
    "worldStateOutEn": "纯英文版末帧状态快照，与 worldStateOut 逐项同义（谁在画面哪个位置·姿态·朝向·手持/驮负关系），30-80 英文词，用 \"X is at ... facing ...\" 直陈句式；角色名与场景名保留中文原样",
    "dialogue": "台词，对象或对象数组（一镜多句写数组）；每句 {character, tone, text, startTime}，startTime 用全片绝对秒；无对白写 null。凡本镜原有台词必须全部保留，禁止漏句或合并",
    "characters": ["角色名"],
    "sceneAssets": ["场景名"],
    "propAssets": ["道具名"],
    "finalFrame": "The final frame: 每个角色的精确位置/朝向/表情、道具位置状态、环境光照（英文，含画面侧位与视线锚物）",
    "integratedMultimodalDescription": "英文 6 模块结构提示词（模块间用换行分隔，整段不超过 220 词）"
  }
}

${integratedModulesRule()}

【JSON 语法要求】字符串值内部禁止未转义的双引号和裸换行；只输出 JSON，不要其他文字。`,
    },
    {
      role: 'user',
      content: [
        regenCtxBlock(`本镜当前内容（场次：${sceneTitle || '未命名'}）· 重写对象`, [
          ['镜号', current.shotNumber],
          ['时长', `${duration} 秒`],
          ['景别', current.shotType],
          ['运镜', current.cameraMovement],
          ['机位朝向', current.cameraAngle],
          ['画面描述', current.description],
          ['动作说明', current.actionNote],
          ...regenAssetLines(current),
          ['台词', formatDialogueText(current.dialogue)],
          ['叙事任务 purpose', current.purpose],
          ['观众任务 goal', current.goal],
          ['情绪基调', current.emotionTone],
          ['信息点', (current.infoPoints || []).join('；')],
          ['出场状态 worldStateOut', current.worldStateOut],
        ]),
        scriptBlock,
        prevBlock,
        nextBlock,
        relatedBlock,
        `【重生成指令】\n${(instruction || '').trim() || '在保持叙事任务与前后镜衔接不变的前提下，重写本镜的画面调度与提示词，使其更有表现力。'}`,
      ].filter(Boolean).join('\n\n'),
    },
  ]

  // 解析 + 归一：extractFirstJson → 单镜对象 → 包 scenes 壳复用整场归一（duration clamp、对白 endTime、IMD 清洗）→ 资产名匹配
  const parseRegenShot = (raw) => {
    try {
      const jsonStr = extractFirstJson(raw)
      if (!jsonStr) return null
      const data = JSON.parse(jsonStr)
      const shotRaw = data?.shot || data
      if (!shotRaw || typeof shotRaw !== 'object') return null
      const normalized = normalizeStoryboard(
        { scenes: [{ title: sceneTitle || '单镜', shots: [shotRaw] }] }, 0
      )
      let shot = normalized.scenes[0].shots[0]
      if (assetMaps) shot = normalizeShotAssets(shot, assetMaps)
      // IMD 混合编译：模块2/3 由资产库英文原文程序注入
      const compiled = compileIntegratedModules(shot.integratedMultimodalDescription, shot, assets)
      if (compiled.injected.length) shot.integratedMultimodalDescription = compiled.text
      // 关键内容必须齐全，否则视为无效产出
      if (!shot.description || !shot.integratedMultimodalDescription || !shot.finalFrame) return null
      return shot
    } catch { return null }
  }

  // generateWithVerify 返回的是原始产出文本（validate 仅做验收），验收通过后再解析归一
  const rawResult = await generateWithVerify(
    (attempt) => chatCompletion(messages, {
      temperature: attempt === 1 ? 0.6 : 0.3,
      maxTokens: REGEN_SHOT_MAX_TOKENS,
      timeoutMs: config.timeouts.llm.standard,
      maxAttempts: 2,
      disableThinking: true,
      usageContext: { task: 'shot-regenerate', attempt },
    }),
    (raw) => !!parseRegenShot(raw),
    { attempts: REGEN_SHOT_ATTEMPTS, label: 'regenerateShot' }
  )
  const regenShot = rawResult ? parseRegenShot(rawResult) : null
  if (!regenShot) throw new Error('AI 未产出有效的单镜重写结果')
  return { shot: regenShot }
}

// 出片提示词预算守卫（H3 硬上限 7000 字符，超限则出片直接被拒）：
// 按「对成片影响最小」的顺序自动瘦身——先移除道具引用（道具图是为近景交互准备的，仅出现在
// 远景/背景中的道具纯属冗余，靠场景图与文字描述即可），仍超再移除次要场景引用（保留首个 = 本场主场景）。
// ratio 为安全系数（默认 0.98，留 2% 余量防英译长度波动，实测残差可达 ±500）。
export function enforcePromptBudget(storyboard, assets, ratio = 0.98) {
  const limit = h3ProviderProfile.capabilities.promptCharLimit * ratio
  const budgetCtx = { assetNames: assets }
  let trimmedProp = 0
  let trimmedScene = 0
  for (const scene of (storyboard?.scenes || [])) {
    for (const shot of (scene.shots || [])) {
      let est = estimateShotVideoPromptChars(shot, budgetCtx).estimated
      while (est > limit && (shot.propAssets || []).length) {
        shot.propAssets = shot.propAssets.slice(0, -1)
        trimmedProp++
        est = estimateShotVideoPromptChars(shot, budgetCtx).estimated
      }
      while (est > limit && (shot.sceneAssets || []).length > 1) {
        shot.sceneAssets = shot.sceneAssets.slice(0, 1)
        trimmedScene++
        est = estimateShotVideoPromptChars(shot, budgetCtx).estimated
      }
    }
  }
  if (trimmedProp || trimmedScene) {
    console.log(`[generateStoryboard] 出片提示词预算守卫：自动瘦身 ${trimmedProp} 个道具引用 + ${trimmedScene} 个次要场景引用（保证 ≤ H3 上限）`)
  }
  return trimmedProp + trimmedScene
}

const FAKE_SPEAKER_WORDS = new Set(['音效', '音效台词', '字幕', '字幕淡入', '片尾字幕', '题材', '旁白字幕', 'BGM', 'bgm', '音乐'])
const isFakeSpeaker = (name) => FAKE_SPEAKER_WORDS.has(String(name || '').trim())

// 水平机位枚举（2026-09-26 对齐 Skill §5：侧45度为对话与叙事默认机位，新增侧45度/正侧/主观）
const CAMERA_ANGLE_VALUES = ['正面', '侧45度', '侧面', '正侧', '背面', '过肩', '主观', '俯拍', '仰拍']
// 俯仰枚举（Skill §5/§9：与水平机位正交的第二维）
const CAMERA_ELEVATION_VALUES = ['平视', '微俯', '俯拍', '大俯角', '微仰', '仰拍', '大仰角']

// ─── Skill 表头 → 结构化字段的确定性解析（2026-09-27）───────────────────────
// 根因：Skill 分镜表头形如「### 镜头 01 | O2 室外半封闭 | 中景 | 标准 35mm | 侧45度+微俯 | 跟拍 | 人物镜头」，
// 七个槽位中「侧45度+微俯」是两个正交维度（水平机位 × 俯仰）、「标准 35mm」是焦段——
// 但规整链路只有 LLM 一条入口，表头从未被结构化解析。实测全库 camera_elevation 全空、
// camera_angle 只剩「正面/侧面」两档（LLM 把复合机位拍扁成一档），lens 全空：
// 下游 h3PromptTranslator 明明完整支持 侧45度/微俯/大俯角 与 mm 焦段，却永远收不到值——
// 分镜设计的机位体系在入库这一步就丢了，出片侧只能按「正面/侧面」重建，镜间衔接必然跳。
// 解法：表头是确定性文本，不依赖 LLM 自觉。规整后按镜头序号回读原始文本表头，补全空缺字段
// （只填空缺，LLM 已正确拆出的值不覆盖）。
const HEADER_ANGLE_PATTERNS = [
  // 长词优先：「侧45度」含「侧」，「大俯角」含「俯」，必须先匹配更具体的
  { value: '侧45度', re: /侧\s*45\s*度/ },
  { value: '正侧', re: /正侧/ },
  { value: '侧面', re: /侧面/ },
  { value: '正面', re: /正面/ },
  { value: '过肩', re: /过肩/ },
  { value: '背面', re: /背面/ },
  { value: '主观', re: /主观|POV/i },
]
const HEADER_ELEVATION_PATTERNS = [
  { value: '大俯角', re: /大俯角/ },
  { value: '大仰角', re: /大仰角/ },
  { value: '微俯', re: /微俯/ },
  { value: '微仰', re: /微仰/ },
  { value: '俯拍', re: /俯拍|俯视/ },
  { value: '仰拍', re: /仰拍|仰视/ },
  { value: '平视', re: /平视/ },
]
// 从表头槽位文本解析水平机位 + 俯仰（两维独立，可同时命中，如「侧45度+微俯」）
function parseHeaderAngleElevation(slot) {
  const s = String(slot || '')
  const angle = HEADER_ANGLE_PATTERNS.find((p) => p.re.test(s))?.value || ''
  const elevation = HEADER_ELEVATION_PATTERNS.find((p) => p.re.test(s))?.value || ''
  return { angle, elevation }
}
// 从表头槽位解析焦段：「标准 35mm」「中长焦 85mm」「微距 100mm」原样返回该槽
function parseHeaderLens(slot) {
  const s = String(slot || '').trim()
  if (!s) return ''
  // 必须含 mm 数字或镜头类型词，否则不是焦段槽（避免把景别/运镜误当焦段）
  if (/\d+\s*mm/i.test(s) || /超广角|广角|中长焦|长焦|微距|标准/.test(s)) return s
  return ''
}
// 景别槽：整槽即景别词（十档口径，与 skillContract 一致；归一到产线四档由 normalizeShotType 负责）
const HEADER_SHOT_TYPE_RE = new RegExp(`^(${shotTypeTermsText('|')})$`)
// 空间类型槽：槽首即代号（S1-S4/O1/O2/X），后可跟名称，如「O2 室外半封闭」「S4 室内超大型」
const HEADER_SPACE_TYPE_RE = /^(S[1-4]|O[12]|X)(?=[\s\u4e00-\u9fa5]|$)/
// 运镜词（与 h3PromptTranslator.CAMERA_MAP 的中文键同族；俯拍/仰拍属机位俯仰，不在此列）
const HEADER_MOVEMENT_RE = /固定|推|拉|摇|移|跟|升|降|环绕|旋转|手持|甩/
// 从表头槽位解析景别：整槽精确命中才认（避免把「中近景的镜头缓缓推近」这类长句误当景别槽）
function parseHeaderShotType(slot) {
  const s = String(slot || '').trim()
  return HEADER_SHOT_TYPE_RE.test(s) ? s : ''
}
// 从表头槽位解析空间类型代号
function parseHeaderSpaceType(slot) {
  const m = String(slot || '').trim().match(HEADER_SPACE_TYPE_RE)
  return m ? m[1] : ''
}
// 从表头槽位解析运镜：含运镜词即认（运镜词集合与机位/景别/焦段/空间/主体槽词汇不相交，不会误挂）
function parseHeaderMovement(slot) {
  const s = String(slot || '').trim()
  return HEADER_MOVEMENT_RE.test(s) ? s : ''
}
// 把一份原始分镜文本切成「镜头序号 → 表头槽位数组」。
// 兼容 Skill 的 `### 镜头 01 | ... | ...` 与规整前的 `镜头 1 | ...` 等写法。
export function parseStoryboardTextHeaders(sourceText) {
  const map = new Map()
  const lines = String(sourceText || '').split('\n')
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    // 必须含竖线分隔且首段以「镜头」开头（Skill 表头特征）
    if (!t.includes('|') || !/^#{0,6}\s*\**\s*(?:镜头|shot)\s*\d+/i.test(t)) continue
    const cells = t
      .replace(/^#{0,6}\s*/, '')   // 去 Markdown 标题标记
      .replace(/\*\*/g, '')         // 去加粗标记
      .split('|')
      .map((c) => c.trim())
    if (cells.length < 3) continue
    const numMatch = cells[0].match(/(?:镜头|shot)\s*(\d+)/i)
    if (!numMatch) continue
    const shotNo = Number(numMatch[1])
    if (Number.isFinite(shotNo)) map.set(shotNo, cells)
  }
  return map
}
// 按镜头序号对应的表头，补全 LLM 漏拆的机位/俯仰/焦段/景别/空间类型/运镜。
// 槽位归属不靠猜位置：全表头扫一遍，用「模式命中」直接定位（机位槽含角度词、焦段槽含 mm、
// 景别槽整槽即景别词、空间槽槽首是代号、运镜槽含运镜词），位置漂移（少槽/多槽/表头被改）都不会误挂。
export function backfillFromHeader(shot, cells) {
  if (!cells || !cells.length) return shot
  const joined = cells.join(' | ')
  const { angle, elevation } = parseHeaderAngleElevation(joined)
  const lens = cells.map(parseHeaderLens).find(Boolean) || ''
  const shotType = cells.map(parseHeaderShotType).find(Boolean) || ''
  const spaceType = cells.map(parseHeaderSpaceType).find(Boolean) || ''
  const movement = cells.map(parseHeaderMovement).find(Boolean) || ''
  const next = { ...shot }
  if (!next.cameraAngle && !next.camera_angle) {
    if (angle) next.cameraAngle = angle
  }
  if (!next.cameraElevation && !next.camera_elevation) {
    if (elevation) next.cameraElevation = elevation
  }
  if (!String(next.lens || '').trim() && lens) next.lens = lens
  if (!String(next.shotType || next.shot_type || '').trim() && shotType) next.shotType = shotType
  if (!String(next.spaceType || next.space_type || '').trim() && spaceType) next.spaceType = spaceType
  // 运镜特例：规整契约默认「固定」，LLM 漏拆时库里的「固定」与真空无法区分——
  // 表头是权威：只要表头有运镜且不是「固定」，而当前值是空或默认「固定」，就以表头为准。
  if (movement && movement !== '固定') {
    const cur = String(next.cameraMovement || next.camera_movement || '').trim()
    if (!cur || cur === '固定') next.cameraMovement = movement
  } else if (movement === '固定' && !String(next.cameraMovement || '').trim()) {
    next.cameraMovement = movement
  }
  return next
}

// 与 storyboardValidator 的台词语速估算保持同一口径（chars / speechRateMaxCharsPerSec），
// 用于推导每句台词的 endTime（AI 不输出该字段，程序统一计算）
const DIALOGUE_SPEECH_RATE = Number(config.storyboard?.speechRateMaxCharsPerSec) || 5
const DIALOGUE_SPEECH_MIN_CHARS = Number(config.storyboard?.speechRateMinChars) || 3
const DIALOGUE_MIN_LINE_SEC = 1

// 按各场内容量（非空字符数）加权分配目标时长：每场保底能容纳 1 条最短镜，
// 余量按内容比例分配、最大余数法取整。替代 targetDuration/场数 的机械均除——
// 内容厚的场拿更多呼吸空间，内容薄的场不硬凑镜头。
function allocateSceneDurations(targetDuration, sceneBlocks) {
  const n = sceneBlocks.length
  if (!n) return []
  if (!(targetDuration > 0)) return sceneBlocks.map(() => 0)
  const minPer = config.storyboard?.durationMin ?? 4
  if (targetDuration < minPer * n) {
    return sceneBlocks.map(() => Math.round(targetDuration / n))
  }
  const weights = sceneBlocks.map((b) => Math.max(1, countNonSpace(b.text || '')))
  const sum = weights.reduce((a, b) => a + b, 0)
  const remaining = targetDuration - minPer * n
  const quotas = weights.map((w) => (remaining * w) / sum)
  const ints = quotas.map((q) => Math.floor(q))
  let err = remaining - ints.reduce((a, b) => a + b, 0)
  const order = quotas.map((q, i) => [q - Math.floor(q), i]).sort((a, b) => b[0] - a[0])
  for (let k = 0; err > 0 && k < order.length; k++, err--) ints[order[k][1]]++
  return ints.map((v) => v + minPer)
}

export function normalizeStoryboard(storyboard, targetDuration = 0, { minDuration = config.storyboard?.durationMin ?? 4, sourceText = '' } = {}) {
  const scenes = Array.isArray(storyboard?.scenes) ? storyboard.scenes : []
  if (!scenes.length) throw new Error('分镜结果缺少 scenes')

  // Skill 表头确定性回填（2026-09-27）：源文本里的表头是机位/俯仰/焦段/景别/空间/运镜的唯一权威来源，
  // LLM 拍扁或漏拆时在此补全。按「全局镜头序号」对齐表头（分镜文件的镜头编号全场连续；
  // 若 LLM 把场次划错，全局序号仍然对得上——匹配不到就不补，绝不猜）。
  const headerIndex = parseStoryboardTextHeaders(sourceText)
  let headerFilled = 0
  let globalShotNo = 0

  const durationCeil = config.storyboard?.durationMax ?? 15
  let cursor = 0
  let clampedCount = 0
  const normalizedScenes = scenes.map((scene, sceneIndex) => {
    const shots = Array.isArray(scene.shots) ? scene.shots : []
    if (!shots.length) throw new Error(`场次 ${sceneIndex + 1} 没有镜头`)

    const normalizedShots = shots.map((rawShot, shotIndex) => {
      // 表头回填：按全局序号（1-based）取表头。只在 LLM 未给出对应字段时补，已拆出的一律保留。
      // 用别名而非改参数——下游大量 shot.xxx 引用必须读到回填后的值。
      globalShotNo += 1
      const headerCells = headerIndex.get(globalShotNo)
      const shot = headerCells ? backfillFromHeader(rawShot, headerCells) : rawShot
      if (shot !== rawShot) {
        const key = (s) =>
          `${s.cameraAngle || ''}|${s.cameraElevation || ''}|${s.lens || ''}|${s.shotType || ''}|${s.spaceType || ''}|${s.cameraMovement || ''}`
        if (key(shot) !== key(rawShot)) headerFilled++
      }
      const rawDur = Number(shot.duration) || 8
      const duration = Math.round(Math.max(minDuration, Math.min(durationCeil, rawDur)))
      if (duration !== rawDur) clampedCount++
      const startTime = cursor
      const endTime = startTime + duration
      cursor = endTime

      const aiStart = Number(shot.startTime)
      const timelineDelta = Number.isFinite(aiStart) ? startTime - aiStart : 0

      const normDialogue = (d, fallbackStart) => {
        const start = Number.isFinite(Number(d?.startTime))
          ? Math.round((Number(d.startTime) + timelineDelta) * 1000) / 1000
          : fallbackStart
        const spoken = String(d?.text || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').length
        const lineSec = spoken >= DIALOGUE_SPEECH_MIN_CHARS ? spoken / DIALOGUE_SPEECH_RATE : DIALOGUE_MIN_LINE_SEC
        return {
          character: String(d?.character || ''),
          tone: String(d?.tone || ''),
          text: String(d?.text || ''),
          startTime: start,
          endTime: Math.round((start + lineSec) * 1000) / 1000,
        }
      }
      let dialogue = null
      let fakeSfx = ''
      const collectDialogue = (rawList) => {
        const list = []
        for (const d of rawList) {
          const n = normDialogue(d, startTime)
          if (isFakeSpeaker(n.character)) {
            fakeSfx = [fakeSfx, n.text].filter(Boolean).join('；')
            continue
          }
          if (n.text) list.push(n)
        }
        return list
      }
      const rawDialogue = shot.dialogue
      if (Array.isArray(rawDialogue)) {
        const list = collectDialogue(rawDialogue)
        dialogue = list.length ? list : null
      } else if (rawDialogue && typeof rawDialogue === 'object') {
        const list = collectDialogue([rawDialogue])
        dialogue = list.length ? list : null
      }
      if (fakeSfx) {
        shot.soundEffects = [shot.soundEffects, fakeSfx].filter(Boolean).join('；')
      }

      return {
        shotNumber: String(shot.shotNumber || shot.shot_number || `${sceneIndex + 1}-${shotIndex + 1}`).trim(),
        shotType: normalizeShotType(shot.shotType),
        startTime,
        endTime,
        duration,
        description: String(shot.description || '').trim(),
        integratedMultimodalDescription: sanitizeIntegrated(String(shot.integratedMultimodalDescription || '').trim()),
        actionNote: String(shot.actionNote || '').trim(),
        cameraMovement: String(shot.cameraMovement || '固定').trim(),
        soundEffects: String(shot.soundEffects || '').trim(),
        overallSoundscape: String(shot.overallSoundscape || '').trim(),
        nonDiegeticMusic: String(shot.nonDiegeticMusic || '').trim(),
        dialogue,
        characters: Array.isArray(shot.characters) ? shot.characters.map(String) : [],
        sceneAssets: Array.isArray(shot.sceneAssets) ? shot.sceneAssets.map(String) : [],
        propAssets: Array.isArray(shot.propAssets) ? shot.propAssets.map(String) : [],
        finalFrame: String(shot.finalFrame || '').trim(),
        purpose: String(shot.purpose || '').trim(),
        goal: String(shot.goal || '').trim(),
        emotionTone: String(shot.emotionTone || shot.emotion_tone || '').trim(),
        infoPoints: (Array.isArray(shot.infoPoints) ? shot.infoPoints : (Array.isArray(shot.info_points) ? shot.info_points : []))
          .map((p) => String(p || '').trim()).filter(Boolean),
        worldStateOut: String(shot.worldStateOut || shot.world_state_out || '').trim(),
        // 末帧状态的英文副本（2026-09-27）：分镜阶段 LLM 上下文最全，此时产出的英文
        // 位置/朝向语义最准；出片链路优先消费，缺才回落翻译（见 v4Video / h3PromptTranslator）。
        worldStateOutEn: String(shot.worldStateOutEn || shot.world_state_out_en || '').trim(),
        // ─── Skill 新增字段（2026-09-26）：此前本函数的固定键集合会把它们整段丢弃，
        // 导致镜头契约产出的焦段/机位俯仰/五层色彩/人声/空间类型全部到不了下游。
        // 保留条件：枚举型字段做取值校验（防模型吐垃圾），文本型字段直接透传。
        spaceType: String(shot.spaceType || shot.space_type || '').trim(),
        spaceEvidence: String(shot.spaceEvidence || shot.space_evidence || '').trim(),
        lens: String(shot.lens || '').trim(),
        colorLighting: String(shot.colorLighting || shot.color_lighting || '').trim(),
        humanVoice: String(shot.humanVoice || shot.human_voice || '').trim(),
        // 接续字段必须在规整时保真，否则下游会把原本声明的硬切/离场降级成软接续。
        transitionIn: String(shot.transitionIn || shot.transition_in || '').trim(),
        transitionOut: String(shot.transitionOut || shot.transition_out || '').trim(),
        worldStateIn: String(shot.worldStateIn || shot.world_state_in || '').trim(),
        worldStateInEn: String(shot.worldStateInEn || shot.world_state_in_en || '').trim(),
        ...(typeof shot.isCombat === 'boolean' ? { isCombat: shot.isCombat } : {}),
        ...(CAMERA_ANGLE_VALUES.includes(shot.cameraAngle || shot.camera_angle)
          ? { cameraAngle: shot.cameraAngle || shot.camera_angle }
          : {}),
        ...(CAMERA_ELEVATION_VALUES.includes(shot.cameraElevation || shot.camera_elevation)
          ? { cameraElevation: shot.cameraElevation || shot.camera_elevation }
          : {}),
        // 兼容旧数据键：历史分镜若仍带驼峰/下划线 camera_angle 亦一并保留
        ...(CAMERA_ANGLE_VALUES.includes(shot.camera_angle) ? { camera_angle: shot.camera_angle } : {}),
      }
    })

    return {
      title: String(scene.title || `场次${sceneIndex + 1}`).trim(),
      shots: normalizedShots,
    }
  })

  const total = cursor
  if (headerFilled > 0) {
    console.log(
      `[generateStoryboard] Skill 表头确定性回填：${headerFilled} 个镜头的机位/俯仰/焦段/景别/空间/运镜由表头补全（LLM 未拆出的表头信息在此归位，下游不再只拿到「正面/侧面」两档）`
    )
  }
  if (clampedCount > 0) {
    console.warn(
      `[generateStoryboard] ${clampedCount} 个镜头的 AI 输出时长超出 ${minDuration}-${durationCeil}s，已归一到范围内（镜头数未变——碎切由后续镜头合并引擎复核）`
    )
  }
  if (targetDuration > 0 && total > targetDuration * 1.3) {
    console.warn(
      `[generateStoryboard] 分镜总时长 ${total}s 超出目标 ${targetDuration}s 约 ${Math.round((total / targetDuration - 1) * 100)}%，已保留 AI 原始节奏，建议人工审核镜头时长`
    )
  }

  return { scenes: normalizedScenes }
}

const BLOCKING_REGIONS = [
  { id: 'C3', label: '正中区', x: 270, y: 600 },
  { id: 'C4', label: '左后区', x: 195, y: 475 },
  { id: 'C5', label: '右后区', x: 345, y: 475 },
  { id: 'C6', label: '高台/远景', x: 270, y: 335 },
  { id: 'C7', label: '左前区', x: 195, y: 750 },
  { id: 'C8', label: '右前区', x: 345, y: 750 },
]

const CHAR_COLOR_POOL = ['#6b9bd1', '#e8a849', '#a86bd1', '#6bd1a8', '#d16b9b', '#d1a86b']


export async function extractBlockingForScene(sceneInfo, shots, assets = null) {
  const charDetailLines = (assets?.characters || [])
    .map((c) => `- ${c.name}${c.description ? '：' + c.description : ''}`)
    .join('\n')

  const shotsText = (shots || [])
    .map((s, i) => {
      const dl = s.dialogueText ? `台词：${s.dialogueText}` : '台词：无'
      const fp = s.finalFrame ? `finalFrame（本镜结束画面的权威描述）：${s.finalFrame}` : 'finalFrame：无'
      return `【第 ${i + 1} 镜（${s.shotNumber || i + 1}）】
画面描述：${s.description || ''}
动作说明：${s.actionNote || '无'}
出场角色：${(s.characters || []).join('、') || '无'}
镜头道具：${(s.propAssets || []).join('、') || '无'}
${dl}
${fp}`
    })
    .join('\n\n')

  const systemPrompt = `你是一个专业的舞台调度设计师。给你一整场戏（含若干连续镜头），请输出整场的俯视站位调度 JSON，用于程序化渲染。

【生成原则（最高优先级）】
1. 场景布局只排一次：sceneLayout 描述该场的完整空间（墙壁、家具、固定陈设），全场所有镜头共享同一布局，物件命名全场一致。
2. 镜头链式衔接：按镜头顺序排位，第 N 镜每个角色的 start 必须与第 N-1 镜该角色的 end 完全一致（坐标和区域都相同）；第 1 镜的 start 由画面描述合理推导。
3. finalFrame 是唯一权威：每镜每个角色/道具的 end 位置和朝向，必须严格符合该镜的 finalFrame 描述；finalFrame 说什么就排什么，禁止另行想象。
4. 命名一致：角色/道具/家具名字全场统一（用资产清单和镜头道具的原名），叙事元素（脚印、蒸汽、黑影等）也要全场同名。
5. 跨角色关系显式化：剧情中有遮挡（"挡在面前"）、拉拽、跟随、躲藏等关系时，用 relation 字段写明（如 "shielding @角色甲" / "hidden behind 遮挡物 with @角色乙"），并且用前后景深坐标体现（前景 y 更大，遮挡者必须比被遮挡者更靠近威胁方向）。
6. 每镜坐标独立完整：每个镜头对象里都要有该镜的全部角色（含 start/end/facing/gaze/actions）、道具、机位、交汇点，不许省略或引用其他镜头。

画布与坐标系：
- 9:16 竖屏画布，尺寸 540 × 960 像素（俯视图，y 越小越远/越高，y 越大越近/越低）
- 坐标原点在左上角，x 向右增，y 向下增
- 舞台是梯形（顶窄底宽，模拟透视），中心 x ≈ 270
- 前景区域：y > 700；中景区域：y 450-700；后景区域：y < 450

区域编号（固定使用）：
${BLOCKING_REGIONS.map((r) => `- ${r.id} ${r.label}：(${r.x}, ${r.y})`).join('\n')}

输出格式（严格 JSON，只输出 JSON）：
{
  "sceneLayout": {
    "description": "整场空间布局简述（1-2 句）",
    "walls": [{ "id": "back", "label": "后墙", "points": [[80,180],[460,180]] }],
    "furniture": [{ "name": "物件名", "x": 270, "y": 600, "width": 120, "height": 60, "rotation": 0 }]
  },
  "shots": [
    {
      "shotNumber": "镜头号（原样返回）",
      "characters": [
        {
          "name": "角色名",
          "start": { "x": 100, "y": 700, "region": "C4" },
          "end": { "x": 270, "y": 600, "region": "C3" },
          "facing": "左/右/上/下",
          "gaze": "看向@另一角色名 / 看向@道具名 / 看向镜头 / 左 / 右 / 上 / 下",
          "relation": "与他人的空间关系，没有则为空字符串",
          "actions": [{ "seq": 1, "label": "转身", "to": { "x": 200, "y": 650, "region": "C3" } }]
        }
      ],
      "props": [{ "name": "道具名", "x": 270, "y": 600, "region": "C3" }],
      "cameras": [{ "id": "A", "label": "全景高处俯拍", "x": 270, "y": 200 }],
      "intersections": [{ "id": "X1", "x": 270, "y": 600, "label": "C3 交汇", "characters": ["角色1", "角色2"] }],
      "dialogue": [{ "character": "角色名", "text": "台词", "x": 250, "y": 580 }]
    }
  ]
}

强制要求：
- sceneLayout.furniture 列出该场全部固定物件；walls 列出主要墙壁/边界线段
- 角色站位不能与家具重叠（除非坐在椅子上或站在桌旁）
- 每镜 cameras 1-2 个机位，id 为字母（A/B/C/D）；action.label 不超过 4 个汉字
- 台词气泡坐标放在说话角色 end 位置附近（偏移 20-40 像素）
- 多角色镜头至少一个交汇点；单角色镜头 intersections 为空数组
- 所有坐标为整数且在 540×960 范围内；静态镜头 start 可以等于 end
- 不适用的字段返回空数组，不要捏造`

  const messages = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `场次：${sceneInfo?.title || ''}
场景设定（布局以此为准）：${sceneInfo?.description || '（无，按画面描述合理构建）'}
场景关联道具：${(sceneInfo?.propNames || []).join('、') || '无'}

角色详情：
${charDetailLines || '（无）'}

本场全部镜头（按顺序）：
${shotsText}

请先在脑海中构建整场统一的三维空间，再按镜头顺序输出整场站位调度 JSON。`,
    },
  ]

  const text = await chatCompletion(messages, {
    temperature: 0.3,
    maxTokens: 8000,
    responseFormat: { type: 'json_object' },
    timeoutMs: config.timeouts.llm.extended, 
  })

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    const jsonStr = extractFirstJson(text)
    if (!jsonStr) throw new Error('无法解析整场站位调度结果')
    parsed = JSON.parse(jsonStr)
  }
  if (!Array.isArray(parsed.shots) || !parsed.shots.length) {
    throw new Error('站位调度结果缺少 shots 数组')
  }
  return parsed
}

export function assembleBlockingPlan(shotPlan, sceneLayout = {}) {
  const characters = Array.isArray(shotPlan.characters) ? shotPlan.characters : []
  const props = Array.isArray(shotPlan.props) ? shotPlan.props : []
  const usedRegions = new Set()
  for (const c of characters) {
    for (const p of [c.start, c.end, ...(c.actions || []).map((a) => a?.to)]) {
      if (p && p.region) usedRegions.add(p.region)
    }
  }
  for (const p of props) if (p && p.region) usedRegions.add(p.region)
  const regions = BLOCKING_REGIONS.filter((r) => usedRegions.has(r.id))
  return {
    stage: { ...BLOCKING_STAGE },
    sceneLayout,
    regions: regions.length ? regions : BLOCKING_REGIONS.slice(0, 4),
    characters: characters.map((c, i) => ({
      ...c,
      color: CHAR_COLOR_POOL[i % CHAR_COLOR_POOL.length],
    })),
    props,
    cameras: Array.isArray(shotPlan.cameras) ? shotPlan.cameras : [],
    intersections: Array.isArray(shotPlan.intersections) ? shotPlan.intersections : [],
    dialogue: Array.isArray(shotPlan.dialogue) ? shotPlan.dialogue : [],
  }
}
