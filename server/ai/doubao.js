import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'
import { logAiCall, classifyError } from './aiLog.js'
import { compileIntegratedModules } from './imdCompiler.js'
import { validateStoryboard, extractScreenSides, hasExplicitReposition, buildAliasMap, findMusicMoodWords, findStylePoison, stylePoisonText, CAMERA_MOVE_LEXICON, extractLightCues, estimateShotVideoPromptChars } from './storyboardValidator.js'
import { PHASE } from './progressPhases.js'
import { pickContainmentCandidate } from './propNameMatch.js'
import {
  dialogueRule, assetNameRule, characterCoverageRule, integratedModulesRule,
  timelineRule, directorNotesPrompt, llmBoundaryRule, episodeStructureRule,
  actionDensityRule, beatLayerRule, cameraAngleRule, cameraBeatRule, cinematographyRule,
  holdRule, genreTemplateRule, editRule,
  frameGeographyRule, cinematicGrammarRule, styleLockRule,
  stagingRule, pointOfViewRule, emotionArcRule, cameraCraftRule,
} from './storyboardRules.js'
import { applyShotMergeToStoryboard } from './shotMergeEngine.js'
import { backfillShotAssets, backfillSceneByTitle } from './assetBackfill.js'
import { qcMeta } from './qcCodes.js'



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

export async function chatCompletion(messages, options = {}) {
  if (!config.llm.apiKey) {
    throw new Error('大模型 API Key 未配置，请设置 DASHSCOPE_API_KEY 环境变量')
  }

  const LIGHT_TASKS = new Set(config.storyboard?.lightTasks || [])
  const lightModel = config.llm.lightModel
  const model = options.model
    || (LIGHT_TASKS.has(options.usageContext?.task) && lightModel ? lightModel : config.llm.model)
  const body = {
    model,
    messages,
    temperature: options.temperature ?? 0.7,
    max_tokens: options.maxTokens ?? 4000,
  }
  if (options.responseFormat) body.response_format = options.responseFormat
  if ((options.responseFormat?.type === 'json_object' || options.disableThinking) && !thinkingLockedModels.has(model)) {
    body.enable_thinking = false
  }

  const timeoutMs = options.timeoutMs ?? 120000
  const maxAttempts = Math.max(1, Number(options.maxAttempts) || 3)
  const task = options.usageContext?.task || ''
  const episodeId = options.usageContext?.episodeId
  const startedAt = Date.now()
  let lastErr = null

  await acquireLlm()
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController()
      const timeoutTimer = setTimeout(() => controller.abort(), timeoutMs)
      let res, httpStatus
      try {
        res = await fetch(`${config.llm.baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.llm.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        httpStatus = res.status
      } catch (e) {
        const { family, message } = classifyError(e)
        lastErr = Object.assign(new Error(message), { code: family, status: 0 })
        if (family !== 'timeout' && family !== 'rate_limit' && family !== 'server') break
        if (attempt < maxAttempts) {
          await sleep(1000 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 300))
          continue
        }
        break
      } finally {
        clearTimeout(timeoutTimer)
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => '')
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
        if ((family === 'rate_limit' || family === 'server') && attempt < maxAttempts) {
          await sleep(1000 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 300))
          continue
        }
        break
      }

      const data = await res.json()
      const message = data.choices?.[0]?.message
      const content = message?.content
      const finishReason = String(data.choices?.[0]?.finish_reason || '')
      const usage = data.usage || {}

      let text = ''
      if (Array.isArray(content)) {
        text = content
          .map((part) => typeof part === 'string' ? part : (part?.text || part?.content || ''))
          .join('')
          .trim()
      } else if (typeof content === 'string' && content.trim()) {
        text = content.trim()
      } else if (typeof message?.reasoning_content === 'string' && message.reasoning_content.trim()) {
        if (finishReason === 'length') {
          lastErr = Object.assign(
            new Error('大模型思考内容被 max_tokens 截断且未输出正文，请增大 maxTokens 或关闭思考'),
            { code: 'content', status: 0 }
          )
          break
        }
        text = message.reasoning_content.trim()
      } else {
        const { family, message: msg } = classifyError(new Error('大模型返回了空内容'))
        lastErr = Object.assign(new Error(msg), { code: family })
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
    if (model === lightModel && lightModel && config.llm.model && lightModel !== config.llm.model) {
      console.warn(`[chatCompletion] 轻量模型 ${lightModel} 失败（${fam}），自动回退主模型 ${config.llm.model} 重试`)
      return chatCompletion(messages, { ...options, model: config.llm.model })
    }
    throw lastErr || new Error('大模型调用失败')
  } finally {
    releaseLlm()
  }
}

export async function generateScript(prompt, context = '', assetContext = '') {
  const assetBlock = assetContext
    ? `\n\n【角色资产设定】\n本剧本使用下列已有角色。写作时必须严格沿用这些角色的名字与外貌设定，不得改动、不得新增形象冲突的描述，戏份围绕他们展开：\n${assetContext}`
    : ''

  const messages = [
    {
      role: 'system',
      content: `你是一个专业的儿童动画编剧。请根据用户的创作意图，编写一个结构化的短剧剧本。

格式要求：
- 每个场次以"场次X：标题"开头
- 每场包含：场景（外景/内景·地点·时间·天气）、人物、对白、舞台指示（用括号括起来）
- 语言生动，适合儿童动画，画面感强
- 总长度 800-1500 字，3-5 个场次
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
    temperature: 0.8,
    maxTokens: 6000,
    returnMeta: true,
    usageContext: { task: 'script' },
  })
  if (finishReason === 'length' || finishReason === 'max_tokens') {
    throw new Error(`剧本生成被截断（长度上限，finish_reason=${finishReason}）。请缩短创作要求后重试`)
  }
  return text
}

export async function rewriteScriptSegment(selectedText, instruction, context = '') {
  const messages = [
    {
      role: 'system',
      content: `你是一个专业的儿童动画编剧，负责改稿。下面给你【原段落】和【整篇上下文】，请根据【改写要求】改写原段落。

【硬性约束】
- 只输出改写后的段落本身，直接可替换原段落。
- 严禁输出整篇剧本、严禁输出任何解释、前言、标题或 markdown 标记。
- 只改选中段落，不得改动上下文中的其他场次、对白或内容。
- 保持短剧格式：场景/人物/对白/舞台指示（括号）结构清晰，语言生动适合儿童动画。
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
  const styleInstruction = style
    ? `\n\n【画风参考】本项目整体视觉风格参考「${style}」。description 中**严禁**直接出现画风词、渲染词、背景词（如"${style}"、"纯白背景"、"2D/3D"、"手绘"、"写实"等），只描述资产本身的视觉内容。`
    : ''

  const messages = [
    {
      role: 'system',
      content: `你是一个专业的剧本美术设定分析师。请从给定的剧本中严格提取角色、场景、道具三类资产，输出严格的 JSON 格式。${styleInstruction}

【核心原则】
- 所有资产必须独立拆分：角色、场景、道具之间互不影响。
- description 必须是一段连贯的纯文本，**禁止使用列表符号、JSON、键值对、换行**。
- 描述要**简洁具体**，控制在 60-120 个汉字，避免冗长和模糊形容词（如"可爱的""漂亮的"）。
- 描述中只写资产本身在剧本里真实出现的视觉信息，不要编造剧本没有的细节。

═══════════════════════════════════════
【角色资产提取要求】
═══════════════════════════════════════
- 只提取角色本身，不包含任何场景、背景、道具。
- description 聚焦：物种/性别/年龄感、外貌特征、发型发色、服装款式与颜色、标志性配饰、性格气质。
- description **只写静态视觉特征（定妆照视角）**：严禁写入动作、姿态、剧情瞬态（如"奔跑时身体前倾""被撞击后沾满尘土""浑身湿透""气喘吁吁"）——这些是镜头内的临时状态，不是角色固定外貌；设定图按此描述生成，瞬态会污染所有镜头的参考图。
- 禁止出现：树木、房屋、天空、地面、家具、其他物品等场景元素；禁止出现画风词或"纯白背景"等工程词。
- 【相似角色硬特征区分】多个角色属于同一物种/相似体型时（如两个同物种幼崽、两个小孩），每只的 description 必须用**至少两个硬视觉特征**明确区分（毛色/肤色、脸型、耳形、脸部配色、体型比例），**严禁只靠配饰（围巾/帽子/领结）颜色区分**——中远景镜头里配饰只占几个像素，视频模型会认错人（历史实锤：同物种角色只差配饰色，出片选角错配两轮未被任何闸门发现）。物种必须写实：同一物种的不同个体要写出可区分的具体特征（毛色/体型/纹路），不许两只都写笼统的同一句。
- 【英文字段必填】每个角色必须同时输出 nameEn（英文名，音译或意译，单词首字母大写）和 descriptionEn（英文外貌描述，与中文 description 同信息量）。descriptionEn 同样受上述硬特征区分规则约束，且**必须包含物种与毛色**（如 a small brown bear cub / a white panda-like cub with black ear patches）——它是 H3 全英文出片 prompt 的角色锁定文本，缺失会让角色只剩名字锁定，选角错配风险直线上升。nameEn/descriptionEn 出现任何中文字符即违规。

═══════════════════════════════════════
【场景资产提取要求】
═══════════════════════════════════════
- 【命名规则】使用剧本中实际提到的具体场景名（如"家中客厅"、"庭院"、"小河边"），禁止使用"场景1"、"第一场"等序号。
- 【去重规则】同一具体场景出现多次只提取一次。
- 场景为无人物、无动物环境；description 只写固定建筑结构、大型家具、绿化、光源方向、天气时间、整体氛围。
- 【环境材质与气候必须保真·硬约束】剧本明确写到的环境关键特征必须**原词保留**，严禁泛化或省略，重点覆盖四类：
  ① 水体状态（河流/浮冰/急流/浅滩/湖面/瀑布）② 气候与季节（积雪/薄冰/霜/梅雨/闷热/落叶）
  ③ 地表材质（碎石/冰面/草坡/泥泞/沙地）④ 大气现象（浓雾/水汽/风沙/烟尘）。
  反例（违规）：剧本写"河面有浮冰漂来"，description 却只写"河水湍急、河面宽阔"——**丢失剧本写到的关键特征即违规**。
  正例：以剧本原词组合，如"水面宽阔、水流湍急，河心有浮冰顺流而下"。
  剧本没有明确写到气候线索时，按场景类型推断一个合理值，但不得与剧本已写的特征冲突。
- 【光影常量 lightingEn】每个场景必须输出 lightingEn 字段：用**英文**描述该场景固定不变的光照——光源从哪个方向来（如 low sun from the left）、色温冷暖（cold blue daylight / warm golden light）、时间氛围，25 词以内。这是跨镜头不变量：同场景所有镜头共用这一句，出片与生图逐字复制；剧本没写光照线索就按场景类型推断一个合理值。**lightingEn 必须全英文，出现任何中文字符即违规。** 若剧本写明冰雪/寒冷环境，色温必须体现冷调（cold blue-grey / icy highlights / biting air），**不得写成暖调或夏日明亮调**。
- **严禁在 description 中出现任何可移动道具**（如手机、书本、食物、零食、瓜子、奶茶、铅笔、笔记本、杯子、盘子、小物件、装饰品等），这些物品由独立道具设定统一提供；示例："茶几上堆满零食"属于违规描述，应改为"客厅中央摆放着木质茶几和柔软沙发"。
- 严禁出现：角色、动物、人物、画风词或"空旷无人物"等工程词；场景本身即可作为独立背景。
- 【道具关联】每个场景必须带 props 字段：字符串数组，列出该场景中剧本实际出现的道具名。只能使用本次提取结果中的道具名，禁止凭空创造；该场景没有道具则为空数组。

═══════════════════════════════════════
【道具资产提取要求】
═══════════════════════════════════════
- 【去重规则】同一件道具即使出现多次也只提取一次，禁止重复/近似重复。
- 【范围约束】只提取**可交互、小型、推动剧情**的物件——即角色能拿在手里、使用或操作的物件（如手机、书本、钥匙、药瓶、火把）。不可移动的大型物体（建筑结构、地形、大型植物、固定设施如桥、门、石碑、古树、井台）和固定家具陈设（沙发、茶几、电视、床、柜子）属于场景本身的组成部分，不作为独立道具提取（除非该物件是剧情核心物件，如角色要搬走的宝箱）。
- 只提取无生命道具或动物伙伴等非主角物体，绝对不包含人物、场景、环境。
- **严禁把道具拟人化**：不要给道具添加人脸、眼睛、表情、肢体、情绪、站姿或拟人动作。
- description **只写道具本身的静态视觉特征**：整体形状、尺寸参照、材质纹理、颜色细节、表面图案、开合/摆放状态。
- **禁止写入**：功能用途、使用方式、使用场景、与角色的关系、角色手持/使用动作、周围环境、画风词或"纯白背景"等工程词。
- 【专属角色 owner】每个道具必须标注 owner 字段：该道具在剧本中主要持有或使用的角色名（必须来自本次提取的角色清单）。多人共用时填主要持有者；无明确专属角色则填空字符串""。owner 是独立字段，description 仍不写角色关系。
- 例如：手机只写"一部智能手机，外壳光滑，屏幕明亮"，不要写"用来拍摄短视频"；瓜子只写"一小袋散装瓜子，颗粒饱满，外壳浅褐色"，不要写"角色随手取用嗑食"。

═══════════════════════════════════════
【输出格式】
═══════════════════════════════════════
【英文字段·出片 prompt 直接消费】nameEn / descriptionEn（角色与道具）、titleEn / summaryEn（场景）、
lightingEn（场景）是 H3 全英文出片 prompt 的**权威英文常量**，会被逐字复制进英文正文——
**必须全英文，出现任何中文字符即违规**（汉字会被模型当台词念出来，本项目踩过多次事故）。
summaryEn / descriptionEn 必须与对应中文 description 同信息量（分别是场景英文摘要、道具英文外形）。
{
  "characters": [{"name": "角色名", "role": "主角/配角", "description": "简洁连贯的角色外貌与穿着描述", "nameEn": "English Name", "descriptionEn": "A small brown bear cub with round ears and a blue scarf... (must include species and fur color)"}],
  "scenes": [{"name": "家中客厅", "description": "简洁连贯的场景环境、光照与氛围描述", "titleEn": "Living Room at Home", "summaryEn": "A compact living room with wooden furniture, soft natural light and a warm atmosphere... (English, matches description)", "lightingEn": "low slanting sunlight from the left, cold clear daylight, faint glints on the snow", "props": ["该场景中出现的道具名"]}],
  "props": [{"name": "道具名", "description": "简洁连贯的道具外形、材质与状态描述（不含用途）", "nameEn": "English Prop Name", "descriptionEn": "A small worn wooden bowl with rough bark texture and chipped edges... (English, matches description)", "owner": "专属角色名"}]
}

只输出 JSON，不要任何其他文字、解释或 markdown 标记。`,
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

function parseScriptSceneTitles(script) {
  const titles = []
  for (const line of String(script || '').split('\n')) {
    const m = line.match(/^场次[一二三四五六七八九十\d]+[：:\s]\s*(.+)/)
    if (m) titles.push(m[1].trim())
  }
  return titles
}

function parseScriptSceneBlocks(script) {
  const lines = String(script || '').split('\n')
  const blocks = []
  let current = null
  for (const line of lines) {
    const m = line.match(/^(场次[一二三四五六七八九十\d]+[：:\s]\s*(.+))$/)
    if (m) {
      if (current) blocks.push(current)
      current = { title: m[2].trim(), text: m[1] + '\n' }
    } else if (current) {
      current.text += line + '\n'
    }
  }
  if (current) blocks.push(current)
  return blocks.map((b) => ({ title: b.title, text: b.text.trim() }))
}

const AUTO_CHUNK_MIN_CHARS = 2400
const AUTO_CHUNK_MAX_CHARS = 2000

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

const MUSIC_REWRITE_MAX_CHARS = 200

function sanitizeMusicText(raw) {
  let s = String(raw || '').trim()
  s = s.replace(/^```[a-zA-Z]*\s*/i, '').replace(/\s*```\s*$/i, '')
  s = s.replace(/^(?:配乐|音乐)\s*[:：]\s*/, '')
  return s.trim()
}

export async function rewriteShotMusic(shot) {
  const original = String(shot?.nonDiegeticMusic || shot?.non_diegetic_music || '').trim()
  if (!original) return null
  const hits = findMusicMoodWords(original)
  if (!hits.length) return original
  const messages = [
    {
      role: 'system',
      content: `你是专业的 AI 视频配乐提示词工程师，精通 MiniMax H3 的 non_diegetic_music 写法。立刻输出改写后的配乐文本，不要任何思考、分析、解释或前言。

【任务】原稿配乐文本里出现了 H3 规范禁止的情绪/氛围形容词：${hits.join('、')}。这类词描述的是"观众听了该有什么感受"，直接写给配乐模型反而与画面内容冲突。请把它们改写为可听的声音属性描述：
- 配器：用什么乐器（如弦乐、钢琴、鼓、木管、合成器）；
- 速度与节奏：慢速/中速/快速、节拍松紧、碎弓/连奏/切分；
- 动态与技法：轻柔、渐强、渐弱、骤停、低音区持续、拨奏。
例如"紧张"可写成"低音区弦乐碎弓，快节奏，短弓拉奏"——不出现"紧张"二字，但听感紧张。

要求：
- 保持原稿语言与声弧意图（该安静处仍安静，该渐强处仍渐强）；
- 长度与原稿相当，一句话即可，禁止扩写；
- 只输出改写后的配乐文本本身，不要 JSON、不要标题、不要解释。`,
    },
    { role: 'user', content: `【配乐原稿】\n${original}` },
  ]
  const text = await generateWithVerify(
    (attempt) => chatCompletion(messages, {
      temperature: attempt === 1 ? 0.2 : 0.1,
      maxTokens: 400,
      timeoutMs: config.timeouts.llm.repair,
      maxAttempts: 2,
      disableThinking: true,
      usageContext: { task: 'storyboard-music', attempt },
    }),
    (raw) => {
      const rewritten = sanitizeMusicText(raw)
      if (!rewritten || findMusicMoodWords(rewritten).length) return null
      if (rewritten.length > MUSIC_REWRITE_MAX_CHARS) return null
      return rewritten
    },
    { attempts: 2, label: 'rewriteShotMusic' }
  )
  if (!text) {
    console.warn('[rewriteShotMusic] 重试后仍含情绪词或超长，按修复失败处理')
    return null
  }
  return text
}

const DYNAMIC_CAMERA_WORDS = Object.entries(CAMERA_MOVE_LEXICON)
  .filter(([k]) => k !== 'static')
  .flatMap(([, v]) => v)

// H3 prompt 上限出处：MiniMax 官方 API 文档 platform.minimax.io "Prompt length limit ≤ 7000 characters"
//（非 base-en/ref-en prompt 指南——指南里无此数字）。官方未说明超限行为，"静默截断"是本项目经验推断。
const H3_PROMPT_LIMIT = 7000
const CONDENSE_TARGET = 6900
const LONG_SHOT_MIN_PROMPT_CHARS = 180

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

// 质检修复：画风毒词改写——删去写实/CGI/照片级等风格切换词，把演出意图改写成画面语言。
// 字段集与 validator stylePoisonScanTexts 对齐（含 blocking_plan / video_prompt_override）：
// video_prompt_override 会直接顶替出片提示词开头、blocking_plan 会进导演请求，漏在这两处等于没修。
// 返回键为 snake_case（即 shots 表列名），调用方可直接拼 SQL。
export async function stripStylePoison(shot, styleTexts = '', style = '') {
  const rawBp = shot?.blockingPlan || shot?.blocking_plan
  const bpText = rawBp ? (typeof rawBp === 'object' ? JSON.stringify(rawBp) : String(rawBp)).trim() : ''
  const fields = [
    ['integrated_multimodal_description', String(shot?.integratedMultimodalDescription || '').trim()],
    ['description', String(shot?.description || '').trim()],
    ['final_frame', String(shot?.finalFrame || '').trim()],
    ['action_note', String(shot?.actionNote || '').trim()],
    ['blocking_plan', bpText],
    ['video_prompt_override', String(shot?.videoPromptOverride || shot?.video_prompt_override || '').trim()],
  ].filter(([, v]) => v)
  if (!fields.length) return null
  if (!findStylePoison(fields.map(([, v]) => v), styleTexts).length) return null
  const messages = [
    {
      role: 'system',
      content: `你是专业的 AI 视频提示词工程师。立刻输出改写结果，不要任何思考、分析、解释或前言。画风：${style || config.defaultArtStyle}（与原稿一致，禁止偏离）。

【任务】本镜文本含风格切换毒词——全片画风统一是铁律，"变强/异变/变身"只能用画面内容表达（体型/毛发/红眼/蒸汽/特效），不能切换画风。请删除这些风格切换词并把演出意图改写成画面语言。
要求：
- 保持原稿 6 模块结构、英文语言、@中文资产名、角色外貌锁定文字不变；
- 只删毒词并改写演出意图，不增删角色、不改时长、不改景别与台词；
- blocking_plan 是 JSON 调度方案：保持 JSON 结构与全部键名可解析，只改写文本值里的毒词；
- 没有改动的字段原样回传，不要省略任何字段；
- 输出严格 JSON：{${fields.map(([k]) => `"${k}":"..."`).join(', ')}}，不要 JSON 外的任何文字。`,
    },
    {
      role: 'user',
      content: `【本镜原稿】\n${fields.map(([k, v]) => `【${k}】\n${v}`).join('\n\n')}`,
    },
  ]
  const raw = await generateWithVerify(
    (attempt) => chatCompletion(messages, {
      temperature: attempt === 1 ? 0.3 : 0.1,
      maxTokens: 4000,
      timeoutMs: config.timeouts.llm.repair,
      maxAttempts: 2,
      disableThinking: true,
      responseFormat: { type: 'json_object' },
      usageContext: { task: 'qc-style-poison', attempt },
    }),
    (r) => {
      const parsed = tryParseJson(r)
      if (!parsed) return null
      const out = {}
      for (const [k] of fields) {
        const v = String(parsed[k] || '').trim()
        if (!v) return null
        out[k] = v
      }
      if (findStylePoison(Object.values(out), styleTexts).length) return null
      // blocking_plan 原本是可解析 JSON 对象时，改写后必须仍是可解析 JSON（否则下游导演请求读不了）
      if (bpText && typeof rawBp === 'object') {
        try { JSON.parse(out.blocking_plan) } catch { return null }
      }
      return out
    },
    { attempts: 2, label: 'stripStylePoison' }
  )
  if (!raw) {
    console.warn('[stripStylePoison] 重试后仍含毒词或解析失败，按修复失败处理')
    return null
  }
  return raw
}

// 字段归一：camera_movement 是单值字段，模块1 只保留表现力最强的一个动态运镜
// 注意：MiniMax H3 官方未规定"一镜一运镜"，此处归一仅因本项目的 camera_movement 字段为单值存储
export async function unifyCameraMove(shot, style = '') {
  const original = String(shot?.integratedMultimodalDescription || '').trim()
  if (!original) return null
  const firstLine = original.split('\n')[0].toLowerCase()
  const found = DYNAMIC_CAMERA_WORDS.filter((w) => firstLine.includes(w))
  if (found.length <= 1) return original
  const messages = [
    {
      role: 'system',
      content: `你是专业的 AI 视频提示词工程师，精通 AI 视频控制式 prompt 写法（用于本项目的画面描述字段，按其六模块结构书写）。立刻输出改写后的正文，不要任何思考、分析、解释或前言。画风：${style || config.defaultArtStyle}（与原稿一致，禁止偏离）。

【任务】原稿模块1 声明了 ${found.length} 个动态运镜（${found.join(',')}），超出本镜 camera_movement 单值字段的承载范围。请只保留其中表现力最强的一个运镜，删去其余运镜表述；选择标准：优先保留与主体动作最匹配、最能强化本镜叙事张力的那个。
要求：
- 只改模块1 的运镜表述，其余模块（画面/景别/台词/动作时间轴/声音/最终画面）原样保留；
- 保持原稿 6 模块结构、英文语言、@中文资产名、角色外貌锁定不变；
- 只输出改写后的 integrated_multimodal_description 正文，不要 JSON、不要标题、不要解释。`,
    },
    { role: 'user', content: `【本镜原稿】\n${original}` },
  ]
  const text = await generateWithVerify(
    (attempt) => chatCompletion(messages, {
      temperature: attempt === 1 ? 0.3 : 0.1,
      maxTokens: 3000,
      timeoutMs: config.timeouts.llm.repair,
      maxAttempts: 2,
      disableThinking: true,
      usageContext: { task: 'qc-camera-unify', attempt },
    }),
    (r) => {
      const rewritten = sanitizeIntegrated(r)
      if (!rewritten) return null
      const fl = rewritten.split('\n')[0].toLowerCase()
      return DYNAMIC_CAMERA_WORDS.filter((w) => fl.includes(w)).length <= 1 ? rewritten : null
    },
    { attempts: 2, label: 'unifyCameraMove' }
  )
  if (!text) {
    console.warn('[unifyCameraMove] 重试后仍含多个动态运镜，按修复失败处理')
    return null
  }
  return text
}

// 质检修复：动作运镜失配——把固定机位改为与主体动作匹配的动态运镜
export async function fixActionCameraMismatch(shot, style = '') {
  const original = String(shot?.integratedMultimodalDescription || '').trim()
  if (!original) return null
  const messages = [
    {
      role: 'system',
      content: `你是专业的 AI 视频提示词工程师，精通 AI 视频控制式 prompt 写法（用于本项目的画面描述字段，按其六模块结构书写）。立刻输出改写结果，不要任何思考、分析、解释或前言。画风：${style || config.defaultArtStyle}（与原稿一致，禁止偏离）。

【任务】本镜描述含主体强发力动作，但运镜是"固定"——大动作在静止画框里会死（动作即运镜被违反）。请把运镜改为与主体动作匹配的动态运镜（跟拍/环绕/手持晃动/推拉等，按动作类型择优）。
要求：
- 同时改写模块1 的运镜表述与本镜 camera_movement 字段值；
- 其余模块原样保留，不增删角色、不改时长、不改景别与台词；
- 保持原稿 6 模块结构、英文语言、@中文资产名、角色外貌锁定不变；
- 输出严格 JSON：{"integrated_multimodal_description":"...","camera_movement":"..."}，camera_movement 用中文（如 跟拍/环绕/手持晃动/推近），不要 JSON 外的任何文字。`,
    },
    { role: 'user', content: `【本镜原稿】\n${original}` },
  ]
  const raw = await generateWithVerify(
    (attempt) => chatCompletion(messages, {
      temperature: attempt === 1 ? 0.3 : 0.1,
      maxTokens: 3000,
      timeoutMs: config.timeouts.llm.repair,
      maxAttempts: 2,
      disableThinking: true,
      responseFormat: { type: 'json_object' },
      usageContext: { task: 'qc-action-camera', attempt },
    }),
    (r) => {
      const parsed = tryParseJson(r)
      if (!parsed) return null
      const imd = sanitizeIntegrated(String(parsed.integrated_multimodal_description || ''))
      const cam = String(parsed.camera_movement || '').trim()
      if (!imd || !cam || cam === '固定') return null
      const fl = imd.split('\n')[0].toLowerCase()
      if (!DYNAMIC_CAMERA_WORDS.some((w) => fl.includes(w))) return null
      return { integratedMultimodalDescription: imd, cameraMovement: cam }
    },
    { attempts: 2, label: 'fixActionCameraMismatch' }
  )
  if (!raw) {
    console.warn('[fixActionCameraMismatch] 重试后运镜仍非动态，按修复失败处理')
    return null
  }
  return raw
}

// 质检修复：音乐语言漂移——把配乐翻译改写为全片主流语言
export async function translateMusicLanguage(shot, targetLang = '', style = '') {
  const original = String(shot?.nonDiegeticMusic || shot?.non_diegetic_music || '').trim()
  if (!original) return null
  const langDesc = targetLang === 'zh' ? '中文' : '英文'
  const messages = [
    {
      role: 'system',
      content: `你是专业的 AI 视频配乐提示词工程师，精通 MiniMax H3 的 non_diegetic_music 写法。立刻输出改写后的配乐文本，不要任何思考、分析、解释或前言。

【任务】原稿配乐文本语言与全片主流不一致。请把它翻译改写为${langDesc}，保持原稿的配器、速度、节奏、动态与声弧意图不变（该安静处仍安静、该渐强处仍渐强）。
要求：
- 只改语言，不增减音乐信息，一句话即可，禁止扩写；
- 不出现抽象情绪词（如"紧张/悲伤"），只写可听的声音属性；
- 只输出改写后的配乐文本本身，不要 JSON、不要标题、不要解释。`,
    },
    { role: 'user', content: `【配乐原稿】\n${original}` },
  ]
  const text = await generateWithVerify(
    (attempt) => chatCompletion(messages, {
      temperature: attempt === 1 ? 0.2 : 0.1,
      maxTokens: 400,
      timeoutMs: config.timeouts.llm.repair,
      maxAttempts: 2,
      disableThinking: true,
      usageContext: { task: 'qc-music-translate', attempt },
    }),
    (r) => {
      const rewritten = sanitizeMusicText(r)
      if (!rewritten) return null
      if (findMusicMoodWords(rewritten).length) return null
      if (rewritten.length > MUSIC_REWRITE_MAX_CHARS) return null
      // 收敛校验：改写后语言必须与目标一致，否则复检照样告警（检测按全片多数语言逐镜比对）。
      // 口径与 validator isMostlyChinese 相同：中文表意字计数 vs 英文字母计数，无字素时不判。
      if (targetLang === 'zh' || targetLang === 'en') {
        const zh = (rewritten.match(/[一-龥]/g) || []).length
        const en = (rewritten.match(/[A-Za-z]/g) || []).length
        if (zh + en > 0 && (zh >= en ? 'zh' : 'en') !== targetLang) return null
      }
      return rewritten
    },
    { attempts: 2, label: 'translateMusicLanguage' }
  )
  if (!text) {
    console.warn('[translateMusicLanguage] 重试后仍含情绪词或超长，按修复失败处理')
    return null
  }
  return text
}

// 质检修复：提示词超限精简——压缩到 H3 单条上限以内
export async function condensePrompt(shot, style = '') {
  // H3 出片提示词由 description/action_note/final_frame 等结构化字段重建（不含 IMD——IMD 是出图提示词）。
  // 超限应压缩这些出片源字段，而非 IMD。dialogue/运镜/景别是短字段或不可改（台词文本/侧位铁律），不动。
  const origDesc = String(shot?.description || '').trim()
  const origNote = String(shot?.actionNote || shot?.action_note || '').trim()
  const origFf = String(shot?.finalFrame || shot?.final_frame || '').trim()
  const origTotal = origDesc.length + origNote.length + origFf.length
  if (!origTotal || origTotal <= CONDENSE_TARGET) return { description: origDesc, actionNote: origNote, finalFrame: origFf }
  const messages = [
    {
      role: 'system',
      content: `你是专业的 AI 视频提示词工程师。立刻输出精简结果，不要任何思考、分析、解释或前言。画风：${style || config.defaultArtStyle}（与原稿一致，禁止偏离）。

【任务】本镜出片提示词源字段（description + action_note + final_frame）总长 ${origTotal} 字符，接近/超出 H3 单条 ${H3_PROMPT_LIMIT} 字符硬上限（官方 API 文档明文），超限可能被静默截断丢内容。请把这三个字段精简到合计 ${CONDENSE_TARGET} 字符以内。
精简策略（按优先级）：
1. 压缩 action_note 动作时间轴的冗余过程描写（保留动作起点、转折、终点与拍点时间码，删去中间过渡的形容词铺陈）；
2. 压缩 description 的冗余环境/氛围铺陈（保留角色站位、关键道具、空间关系）；
3. 压缩 final_frame 的冗余描写（保留关键姿态、侧位 frame left/right、光位方向与色温）。
要求：
- 绝不删改：角色名、台词文本、景别、运镜、时长、关键姿态与侧位、光位方向；
- action_note 保持「At X.Xs，动作」拍点格式；description/final_frame 保持原语言；
- 输出严格 JSON：{"description":"...","action_note":"...","final_frame":"..."}，没有改动的字段原样回传，不要省略任何字段，不要 JSON 外的任何文字。`,
    },
    {
      role: 'user',
      content: `【原稿合计 ${origTotal} 字符】\ndescription:\n${origDesc}\n\naction_note:\n${origNote || '（空）'}\n\nfinal_frame:\n${origFf}`,
    },
  ]
  const raw = await generateWithVerify(
    (attempt) => chatCompletion(messages, {
      temperature: attempt === 1 ? 0.3 : 0.1,
      maxTokens: 4000,
      timeoutMs: config.timeouts.llm.repair,
      maxAttempts: 2,
      disableThinking: true,
      responseFormat: { type: 'json_object' },
      usageContext: { task: 'qc-prompt-condense', attempt },
    }),
    (r) => {
      const parsed = tryParseJson(r)
      if (!parsed) return null
      const desc = String(parsed.description || '').trim()
      const note = String(parsed.action_note || '').trim()
      const ff = String(parsed.final_frame || '').trim()
      if (!desc || !ff) return null
      const newTotal = desc.length + note.length + ff.length
      if (newTotal >= H3_PROMPT_LIMIT) return null
      if (newTotal < origTotal * 0.3) return null
      return { description: desc, actionNote: note, finalFrame: ff }
    },
    { attempts: 2, label: 'condensePrompt' }
  )
  if (!raw) {
    console.warn('[condensePrompt] 重试后仍超限或精简过度，按修复失败处理')
    return null
  }
  return raw
}

// 质检修复：长镜薄提示词扩写——补过程性动作描写撑住时长
export async function expandThinPrompt(shot, style = '') {
  const original = String(shot?.integratedMultimodalDescription || '').trim()
  const origNote = String(shot?.actionNote || shot?.action_note || '').trim()
  if (!original) return null
  // action_note 空时即使 IMD 够长也要继续扩——出片时间轴来源是 action_note，空则出片死气。
  if (original.length >= LONG_SHOT_MIN_PROMPT_CHARS && origNote) return { integratedMultimodalDescription: original, actionNote: origNote }
  const messages = [
    {
      role: 'system',
      content: `你是专业的 AI 视频提示词工程师，精通 AI 视频控制式 prompt 写法（用于本项目的画面描述字段，按其六模块结构书写）。立刻输出扩写结果，不要任何思考、分析、解释或前言。画风：${style || config.defaultArtStyle}（与原稿一致，禁止偏离）。

【任务】本镜是长镜但提示词过短——长镜更需要过程性描述撑住时长，否则出片画面死气或模型自由发挥跑偏。请在不改变原稿核心动作、角色、台词、景别、运镜的前提下，【同时扩写两处】：
① 模块4（英文动作时间轴）：补充过程性动作描写（动作的起势、进行、收势与身体细节），让画面有内容可演——出图通道读这里；
② action_note（中文镜内时间轴，按拍点写「At X.Xs，动作」）：为本镜的过程动作补拍点描述（如「At 1.0s，…起势；At 2.5s，…进行；末 1.0s …收势」）——出片提示词只读 action_note，不写则出片模型看不到这些过程。
要求：
- 两处都要扩写，过程描写内容对应一致（模块4 英文版与 action_note 中文版描述同一组动作）；绝不新增剧情事件、不增删角色、不改台词与时长；
- 保持原稿 6 模块结构、英文语言、@中文资产名、角色外貌锁定不变；
- 输出严格 JSON：{"integrated_multimodal_description":"...","action_note":"..."}，action_note 用中文，不要省略任何字段，不要 JSON 外的任何文字。`,
    },
    {
      role: 'user',
      content: `【本镜原稿长度 ${original.length} 字符】\nintegrated_multimodal_description:\n${original}\n\naction_note:\n${origNote || '（空）'}`,
    },
  ]
  const raw = await generateWithVerify(
    (attempt) => chatCompletion(messages, {
      temperature: attempt === 1 ? 0.4 : 0.2,
      maxTokens: 4000,
      timeoutMs: config.timeouts.llm.repair,
      maxAttempts: 2,
      disableThinking: true,
      responseFormat: { type: 'json_object' },
      usageContext: { task: 'qc-prompt-expand', attempt },
    }),
    (r) => {
      const parsed = tryParseJson(r)
      if (!parsed) return null
      const imd = sanitizeIntegrated(String(parsed.integrated_multimodal_description || ''))
      const note = String(parsed.action_note || '').trim()
      if (!imd || !note) return null
      if (imd.length <= original.length * 1.3) return null
      if (imd.length >= H3_PROMPT_LIMIT) return null
      return { integratedMultimodalDescription: imd, actionNote: note }
    },
    { attempts: 2, label: 'expandThinPrompt' }
  )
  if (!raw) {
    console.warn('[expandThinPrompt] 重试后扩写不足或超限，按修复失败处理')
    return null
  }
  return raw
}

// 质检修复：光线跳变对齐——把本镜光线对齐到同场上一镜
// 质检修复：同场相邻镜光线方向/色温对齐。
// 收敛口径与 validator checkLightFlip 完全对齐（同一 extractLightCues 提取器）：
// - 基准 = prev finalFrame + prev IMD 首行（检出端两个都读，缺一个就会误导模型）；
// - 双落点改写：模块2 与 final_frame 一起改——检出端读 curr(finalFrame + IMD 首行)，
//   只改 IMD 会把跳变 cue 留在末帧里，复检照样告警、修复死循环。
export async function alignLighting(shot, prevShot, style = '') {
  const original = String(shot?.integratedMultimodalDescription || '').trim()
  const origFf = String(shot?.finalFrame || shot?.final_frame || '').trim()
  if (!original) return null
  const prevBaseline = [
    String(prevShot?.finalFrame || prevShot?.final_frame || '').trim(),
    String(prevShot?.integratedMultimodalDescription || prevShot?.integrated_multimodal_description || '').split('\n')[0].trim(),
  ].filter(Boolean).join(' ')
  if (!prevBaseline) return null
  const baselineCues = extractLightCues(prevBaseline)
  const messages = [
    {
      role: 'system',
      content: `你是专业的 AI 视频提示词工程师，精通 AI 视频控制式 prompt 写法（用于本项目的画面描述字段，按其六模块结构书写）。立刻输出改写结果，不要任何思考、分析、解释或前言。画风：${style || config.defaultArtStyle}（与原稿一致，禁止偏离）。

【任务】本镜与同场上一镜的光线方向/色温跳变，违反"同一场戏光线一致"。请把本镜模块2 环境描写的光线方向与色温、以及 final_frame（最终画面描述）里的光线描写，都对齐到【光线基准】，让两镜光线连贯。
要求：
- 只改模块2 与 final_frame 里的光线相关描写，其余模块原样保留，不增删角色、不改时长、不改景别与台词；
- final_frame 若没有光线描写，保持其内容原样回传，不强行新增；
- 保持原稿 6 模块结构、英文语言、@中文资产名、角色外貌锁定不变；
- 输出严格 JSON：{"integrated_multimodal_description":"...","final_frame":"..."}，两字段都必须回传（没改动的原样回传），不要 JSON 外的任何文字。`,
    },
    {
      role: 'user',
      content: `【光线基准（上一镜最终画面 + 模块1）】\n${prevBaseline}\n\n【本镜原稿】\nintegrated_multimodal_description:\n${original}\n\nfinal_frame:\n${origFf || '（空）'}`,
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
      usageContext: { task: 'qc-lighting-align', attempt },
    }),
    (r) => {
      const parsed = tryParseJson(r)
      if (!parsed) return null
      const imd = sanitizeIntegrated(String(parsed.integrated_multimodal_description || ''))
      const ff = String(parsed.final_frame || '').trim()
      if (!imd) return null
      if (origFf && !ff) return null
      if (imd.length < original.length * 0.5) return null
      // 收敛校验：改写后 (IMD 首行 + final_frame) 的光线 cue 不得再与基准冲突
      const newCues = extractLightCues([imd.split('\n')[0], ff].filter(Boolean).join(' '))
      if (baselineCues.direction && newCues.direction && baselineCues.direction !== newCues.direction) return null
      if (baselineCues.warmth && newCues.warmth && baselineCues.warmth !== newCues.warmth) return null
      return { integratedMultimodalDescription: imd, finalFrame: ff }
    },
    { attempts: 2, label: 'alignLighting' }
  )
  if (!raw) {
    console.warn('[alignLighting] 改写失败，按修复失败处理')
    return null
  }
  return raw
}

// 质检修复：切点动作重复去重——删去本镜开头与上镜末帧重复的动作
export async function dedupeActionOverlap(shot, prevShot, style = '') {
  const desc = String(shot?.description || '').trim()
  const imd = String(shot?.integratedMultimodalDescription || '').trim()
  const prevFinal = String(prevShot?.finalFrame || prevShot?.final_frame || '').trim()
  if ((!desc && !imd) || !prevFinal) return null
  const messages = [
    {
      role: 'system',
      content: `你是专业的 AI 视频提示词工程师。立刻输出改写结果，不要任何思考、分析、解释或前言。画风：${style || config.defaultArtStyle}（与原稿一致，禁止偏离）。

【任务】上一镜最终画面停在某个动作上，本镜开头又把它从零做了一遍——同一动作被陈述两遍，叙事原地倒带。请把本镜开头的重复动作描述删去，让动作整段归本镜（即本镜从该动作的"进行/收势"开始，不从"起势"重做），或把重复动作收束为"承接上一镜末态继续"的衔接表述。
要求：
- 只删去与本镜开头重复的那段动作，绝不新增剧情、不增删角色、不改台词与时长、不改景别与运镜；
- description 与 integrated_multimodal_description 都要改写（保持二者一致）；
- 保持原稿 6 模块结构、英文语言、@中文资产名、角色外貌锁定不变；
- 输出严格 JSON：{"description":"...","integrated_multimodal_description":"..."}，不要 JSON 外的任何文字。`,
    },
    {
      role: 'user',
      content: `【上一镜最终画面（动作末态）】\n${prevFinal}\n\n【本镜原稿】\ndescription:\n${desc}\n\nintegrated_multimodal_description:\n${imd}`,
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
      usageContext: { task: 'qc-action-dedupe', attempt },
    }),
    (r) => {
      const parsed = tryParseJson(r)
      if (!parsed) return null
      const newDesc = String(parsed.description || '').trim()
      const newImd = sanitizeIntegrated(String(parsed.integrated_multimodal_description || ''))
      if (!newDesc || !newImd) return null
      if (newDesc === desc && newImd === imd) return null
      return { description: newDesc, integratedMultimodalDescription: newImd }
    },
    { attempts: 2, label: 'dedupeActionOverlap' }
  )
  if (!raw) {
    console.warn('[dedupeActionOverlap] 重试后未有效去重，按修复失败处理')
    return null
  }
  return raw
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

export function extractFinalFrameFromIntegrated(imd) {
  const text = String(imd || '')
  const idx = text.lastIndexOf('The final frame:')
  if (idx < 0) return ''
  return text.slice(idx).trim().slice(0, 1500)
}

// 景别归一化：产线只认 4 个值（全景/中景/近景/特写，见 shotType 提示词与 h3PromptTranslator.SHOT_SIZE_MAP）。
// 旧实现在白名单未命中时一律兜底成「中景」，会把 LLM 偶尔自由发挥的「大远景/远景/中全景」静默压成中景（跨度 3 档）；
// 现改为按语义取最近档归并，只有真正无法判断的值才落中景。
const SHOT_TYPE_FALLBACK = {
  '大远景': '全景', '远景': '全景', '大全景': '全景', '中全景': '全景', '远全': '全景', '广角': '全景',
  '中近景': '近景', '中近': '近景', '半身': '近景',
  '大特写': '特写', '极特': '特写', '微距': '特写',
}
export function normalizeShotType(raw) {
  const t = String(raw || '').trim()
  if (['全景', '中景', '近景', '特写'].includes(t)) return t
  if (SHOT_TYPE_FALLBACK[t]) return SHOT_TYPE_FALLBACK[t]
  // 子串兜底：优先匹配更长/更具体的档位语义
  if (t.includes('特写')) return '特写'
  if (t.includes('近')) return '近景'
  if (t.includes('远') || t.includes('全')) return '全景'
  return '中景'
}


export async function generateStoryboard(script, style = config.defaultArtStyle, assets = null, options = {}) {
  // 画风毒词豁免文本：画风名 + 类别桶词（realistic / 3d-special 等）。realistic 类项目
  // 写「照片级/真实感」属描述自己的画风，不应判定为切画风。
  const styleForPoison = stylePoisonText(style, options.styleCategory)
  const targetDuration = Number(options.targetDuration) || 0
  const assetMaps = assets ? buildAssetMaps(assets) : null
  const scriptSceneTitles = parseScriptSceneTitles(script)
  const assetListPrompt = assets ? buildAssetListPrompt(assets) : ''
  const directorNotesPromptText = directorNotesPrompt(options?.directorNotes || '')

  const buildAndRun = async (retryNote, sceneScope = null) => {
    const messages = [
      {
        role: 'system',
        content: `你是一个专业的分镜师，精通 AI 视频生成的"控制式 prompt"写法，同时是一名有强烈导演意识的镜头设计者。请根据剧本和画风，生成详细的分镜脚本，输出严格的 JSON 格式。【重要】立刻输出 JSON，禁止任何思考、分析、解释或前言。回复必须以一个左大括号 { 开头，以一个右大括号 } 结尾，中间是合法 JSON。${assetListPrompt}
【最高优先级 · 切镜总纲（压过后文一切规则）】默认长镜，例外才切。同一主体、同一空间、同一目的下的连续动作，优先用一条 8-15s 长镜完成——"运镜能带观众走到的，不用切镜去看"。只有切镜能挣得下列收益时才切：①新主体登场 ②时空跳变（换场景/换时间）③新危险或新发现且同一机位无法完整表达 ④独立情绪反应需独立承接 ⑤关系或决定改变 ⑥台词信息推进（说话对象切换）。景别变化用推近/拉远完成、不切；无新增信息的连续对白同镜闭合；无明确收益就【不切】。后文所有规则的解读，以本条总纲为准。
【剧本格式说明·必读】剧本的每一行/每一段是一个叙事信息点，【不是镜头】——严禁把剧本的换行、空行或分行当作镜头切点。请按任务边界重新组织：同一主体、同一空间、同一目的下的多个连续信息点必须合成一条 8-15s 长镜；一场戏的镜头数由【任务边界的数量】决定，与剧本的行数/段落数无关。${directorNotesPromptText}${episodeStructureRule()}${genreTemplateRule()}${actionDensityRule()}${beatLayerRule()}${cinematicGrammarRule()}${stagingRule()}${pointOfViewRule()}${emotionArcRule()}${cameraCraftRule()}${cameraBeatRule()}${holdRule()}${editRule()}${cameraAngleRule()}${cinematographyRule()}${frameGeographyRule()}${styleLockRule(style, options.styleCategory || '')}${llmBoundaryRule()}${retryNote}

【核心原则】AI 视频生成不是描述氛围，而是用文字在 AI 潜在空间里建立一个搬不走的三维空间。必须遵循六大铁律：
1. 时间切片与切镜准则——【总纲：默认长镜，例外才切】
   【第一原则·压过一切】运镜能带观众走到的，不用切镜去看。同一主体、同一空间、同一目的下的连续动作，优先用一条 8-15s 长镜完成——"跟拍主体移动→主体停驻→环视揭示新方位"、"听见声音→判断方向→循声走去"、"跳上岸→拍掉身上的水→抬头看四周"、"落地→站稳→抬头发现目标"，都是一条镜头的事。动作多不等于必须切镜。
   【切镜是例外，必须挣得收益】只有切镜能获得下列至少一项真实收益时才切：① 新主体登场（新角色首次入画）；② 时空跳变（换场景/换时间）；③ 新危险或新发现（且同一机位无法完整表达"发生+反应"）；④ 独立情绪反应需要独立承接；⑤ 关系或决定发生改变；⑥ 台词信息推进（说话对象切换、信息需要独立承接）。
   【明确不要切】景别变化（全景→中景→特写）用推近/拉远完成，不切；单纯动作推进用一镜到底；无新增信息的连续对白同镜闭合（台词不得为凑切点被拆散）；"缩手→压低肩背"这类同一反应任务不切；危险与反应可由同一机位表达时优先一镜到底。无明确收益就【不切】。
   【时长预算用长镜消化】在满足本场时长目标的前提下，优先通过加长单镜（8-15s 一镜到底的连续任务/连续运镜）来消化时长，而不是增加镜头数——如"跟拍主体移动→停驻→环视揭示"应写成一条 10-14s 长镜，而非拆成 3 条短镜。4-6s 短镜仅用于：对话反打、独立反应承接、危险瞬间的节奏断点。
   【一个镜头一个任务句】若发现需要塞入第二个【独立任务】（新主体登场 / 时空跳变 / 新危险爆发 / 关系或决定改变）才必须拆成两镜；同一连续任务内的动作推进与运镜揭示（跟拍走近→停驻→环视看到新景物）仍属一条镜头，不拆。禁止多任务挤一镜。
   【拆后复核】如果确实拆了，逐对检查后镜是否新增主体/空间/视角/状态/信息/危险/情绪/关系——没有新增就撤销切镜、合回一条。
   【若确实要切：跳切预防】相邻两镜的景别与机位必须至少拉开一项（景别不同；本项目景别只有 全景/中景/近景/特写 四档，全景→中景 跨一档、全景→近景 跨两档；或机位朝向换档满足 30° 法则：正面→侧面→背面）。景别相同且机位相同的硬切 = 跳切，禁止（前后镜动作连续的动作匹配剪辑除外）。
   【节奏】连续动作段落可用跟拍、推拉、环绕和时长变化制造速度，不得为了"快"机械切碎；只有对抗双方独立发力、视角反打或危险升级需要分别承接时才缩短镜头。安静与抒情段落允许 7-15 秒长镜，用时长和运镜完成余韵。
   【时间切片基础】每镜 4-15 秒（H3 模型官方上限 15s；实际成片会对齐 17 帧网格档位，如请求 15s 出 15.08s，属正常）；镜头边界按"任务完成或任务转向"划分，不按逗号、动作动词数量或剧本句号机械切片。
2. 状态继承：非首镜开头承接上一镜最终画面（人物姿态、位置、构图、光线延续），承接即刻完成、不设冻结期，本镜动作与台词可从第 0 秒直接开始
3. 视觉锁定：角色必须用 "exactly as shown" + 完整外貌（物种/颜色/耳朵/眼睛/腮红/鼻子/嘴巴/轮廓/服装逐部位描写）。【外貌内容硬约束】描写内容必须【逐字复制】资产清单中该角色的 description（有参考图的角色同样如此：文字特征与参考图互为双重锚定，参考图本身也从该 description 生成）——它是角色唯一权威外貌；清单里没有的特征（帽子、服装、性别、年龄、体型等）绝对禁止自行添加，禁止为了让画面更"有趣"而改编角色形象
4. 道具专属：每个道具声明 "belongs exclusively to @XX"，其他角色 "paws/hands remain empty"。【有参考图的道具】外观以参考图为准，不要描写外观细节
5. 动作微分解：道具动作必须拆成 动作方式(gently/slowly) → 最终状态(rests upright/stands steady) → 材质确认(weave/color unchanged) → 否定约束(does not fall/disappear/change hands) 四段
6. 多模态分离：画面/声景/音乐/台词分模块独立书写
7. 场景锁定：环境描写内容必须【逐字复制】资产清单中该场景的 description（有参考图的场景同样如此：文字与参考图互为双重锚定），禁止编造清单外的环境元素（植被/建筑/光线等）

每个镜头必须输出以下字段：
- shotType: 景别 全景/中景/近景/特写
- startTime/endTime: 时间轴（秒，整数），duration = endTime - startTime，范围 4-15 秒
- description: 中文画面描述。【硬约束·必读】必须是一句连贯叙事，【40-80 字】，不能短于 30 字也不能超 100 字；用 @角色名 / @道具名 / @场景名 标记每一个出现的资产；严禁：换行/分段/列表/项目符号/JSON 风格、"音效：..."/"角色：..."/"场景：..."/"BGM：..."/"画面：..." 等任何带冒号的段落小标题、"（无 BGM 配乐）"这类元注释、英文 AI prompt 词汇（Audio/Visual/Camera/Characters 等）、【结构性标记，会原样泄漏进出片提示词】"模块1~6"/"Module 1~6"/"At 00:02.000"这类时间戳/结构名/字段名（shotType/finalFrame/cameraMovement 等）、把 integratedMultimodalDescription 的内容塞进来。正确示例："@角色乙 踩着 @道具丙 沿 @地点丙 滑行，@角色甲 从后面跃上 @角色乙 的背。"；错误示例（绝不能这样写）："音效：海浪、海风、海鸥"（这是 overallSoundscape）、"角色甲：浅棕色幼犬团子..."（这是 integratedMultimodalDescription 模块2）、"模块1 [Shot 1] 全景..."（结构标记，出片时会被翻译成噪音）。【摄影落点】景深/影调/光质/焦段质感写进本字段（10-15 字，如"侧逆光勾出轮廓，背景虚化"），不要只写进模块3——出片提示词不读模块3
- purpose: 【必填】本镜叙事任务（中文一句话，10-30字）：这个镜头承担的叙事功能、"为什么切这一刀"，如"建立空间关系""危机升级推动逃跑决定""反应镜头承接发现"
- goal: 【必填】观众任务（中文一句话，10-30字）：本镜结束时观众应获得的信息增量或情绪变化，如"知道篮里装的是过冬食物""为角色乙的安危担忧"
- emotionTone: 【必填】本镜情绪基调（中文2-6字），如"克制不安""明快温暖""压抑紧绷""释然"
- infoPoints: 【必填】本镜必须让观众看清的关键信息点（中文短语数组，0-3个；纯氛围镜可为空数组）。【硬约束】每个信息点都必须织入 description 或 actionNote 的可见描写中——出片提示词只从这两个字段取料，信息点只写在本字段而不进画面描写，等于没写
- worldStateOut: 【必填】本镜结束瞬间的实体状态快照（中文，分号分隔的紧凑格式）：列出每个出场角色的"画面位置·手持·朝向"和每个关键道具的"位置·状态"。这是镜间一致性校验与下一镜画面承接的结构化依据，必须与 finalFrame 完全一致。示例："@角色甲：画面左·右手持@道具甲·面向右；@角色乙：画面右·手空·面向左；@道具甲：@角色甲右手·直立"
- actionNote: 【必填·本镜镜内时间轴】动作说明，按拍点写（中文）：「At X.Xs，动作」。例「0-2s 保持静止；At 2.0s 攥紧信纸；At 4.5s 抬头看向门口；末 0.8s 静止无动作」。本字段是【出片提示词的时间轴来源】——拍点、运镜三段式起止时刻、留白秒数都写在这里。（写进 integratedMultimodalDescription 模块4 对出片无效：出片提示词不读模块4。）
- cameraMovement: 固定/推近/拉远/变焦推近/变焦拉远/左摇/右摇/左移/右移/摇上/摇下/升高/降低/环绕/跟拍/手持跟拍/主观/滚转【运镜规则】本字段为单值，只填一个运镜（H3 官方运镜规范 base-en.txt §4.3：运动类型 + 幅度 small/large + 速度 slow/fast 三维，出片时写成画面描述的自然英文句，禁止句尾堆标签）。情绪升级/震惊发现/危机逼近用快速变体（急推/快推/急拉/快甩/快摇左/快摇右/急移左/急移右/急摇上/急升/急降/急环绕/急跟）；安静抒情/情绪沉淀段落用缓慢变体（缓推/缓拉/缓摇左/缓摇右/缓移左/缓移右/缓摇上/缓升/缓降/缓环绕/缓跟/缓变焦）；移动段落用跟拍或手持跟拍。俯拍/仰拍是机位朝向不是运镜，写进 camera_angle，不要写在这里
- camera_angle: 机位朝向，六选一：正面/侧面/背面/过肩/俯拍/仰拍（必须与运镜语义一致，见上方【机位朝向硬约束】；出片靠这个字段锚定首帧朝向，缺失会导致朝向被参考图带偏）
- soundEffects: 画内音效描述，没有则为空字符串
- overallSoundscape: 环境声和空间氛围，没有则为空字符串
- nonDiegeticMusic: 非画内音乐建议，没有则为空字符串
- isCombat: 【必填】本镜戏型布尔值。true=武戏（有肢体冲突/物理撞击/打斗/变身/狂暴/追击/破坏等动作对抗），false=文戏（对话、情绪、观望、行走、静态展示等无对抗动作）。判定看【本镜自身内容】，不要看场次号或它在剧本里的位置。出片时武戏会加载打斗 LoRA，文戏不加载，判错会直接毁掉画面调性，务必准确。
- dialogue: ${dialogueRule()}
- characters/sceneAssets/propAssets: 资产名数组。${assetNameRule()}${characterCoverageRule()}无法确定某个名字是否在清单里时，宁可不列也不要猜
- finalFrame: 【必填】本镜最终画面精确描述（英文）：每个角色的精确位置和朝向、每个道具的精确位置和状态、环境光照氛围、角色表情。这是下一镜画面承接的依据。【摄影落点】光位 + 绝对方向 + 色温必须同时写全（如 "warm golden light from frame left"）——只写色温不写方向等于没声明，出图时光源位置会随参考图漂移。【画面地理硬约束】每个可见角色必须带画面侧位（at frame left / at frame right / at center frame）与视线锚物（gazes toward @角色/具体物体），并至少声明一个不动环境锚点的画面位置，详见上方【画面地理硬约束（Frame Geography）】。
- integratedMultimodalDescription: 【必填】给 AI **图像**模型使用的完整多模态提示词（用途：生成分镜图 / 首帧 / 尾帧锚），必须严格按以下 6 模块结构书写（英文，用换行分隔）。【重要·落点】出片（视频）提示词**不读本字段**——它是按 shot_type / description / action_note / camera_movement / camera_angle / finalFrame 重建的。因此：留白、镜内拍点、运镜三段式起止时刻写入 actionNote；景深/影调/光质/焦段质感写入 description；光位+方向+色温写入 finalFrame。只写在本字段里的时间维度内容对出片无效。【篇幅硬约束】每个模块 1-2 句，整段不超过 220 词——超长会被输出截断导致整体失败，精炼比详尽更重要：

  ${integratedModulesRule()}

${timelineRule()}

输出格式：
{
  "scenes": [
    {
      "title": "场次标题",
      "shots": [
        {
          "shotType": "全景",
          "startTime": 0,
          "endTime": 6,
          "duration": 6,
          "description": "@角色甲抱着@道具甲走到@地点乙旁...",
          "actionNote": "角色入画，道具就位",
          "cameraMovement": "固定",
          "soundEffects": "脚步声、道具轻放声",
          "overallSoundscape": "微风拂过树叶沙沙声，远处鸟鸣",
          "nonDiegeticMusic": "木吉他慢板琶音",
          "isCombat": false,
          "purpose": "建立野餐场景的空间与角色站位关系",
          "goal": "观众知道两人已就位、即将开始野餐",
          "emotionTone": "明快温暖",
          "infoPoints": ["野餐垫与食物篮的位置", "两人并肩的站位关系"],
          "worldStateOut": "@角色甲：画面左·右手挎篮·面向镜头；@角色乙：画面右·手空·面向镜头；篮子：毯子近左角·直立；烤炉：右侧草地·立稳",
          "dialogue": null,
          "characters": ["角色甲","角色乙"],
          "sceneAssets": ["地点甲"],
          "propAssets": ["道具甲","道具乙"],
          "finalFrame": "The final frame: @角色甲 stands at frame left and @角色乙 at frame right, side by side at the near edge of the blanket facing the camera, @角色甲's basket resting upright on the blanket's left corner, @角色乙's grill standing on the grass at frame right, the picnic tree standing at frame right behind them, both characters smiling softly under the dappled tree shade, their gazes toward the camera.",
          "integratedMultimodalDescription": "[Shot 1] the project's declared art style, warm late-morning sunlight. Wide establishing shot, 中距离, 正前方平视, static then slow push in.\\n@角色甲, exactly as shown, a white panda dumpling with two solid dark-brown round ears, small black dot eyes, pink blush cheeks, a dark-brown bow tie, dark-brown paw pads, clean dark-brown outlines. @角色乙, exactly as shown, a light-brown bear dumpling with small round brown ears, small black dot eyes, creamy-yellow blush cheeks, a pink nose and mouth, clean dark-brown outlines. 本片段无台词，两角色 lips remain completely closed.\\nThe blanket, tree, stream, meadow, hills, and clouds remain completely unchanged in structure, color, and arrangement throughout the entire segment — no flower shifts, no cloud disappears.\\nAt 00:00.000, @角色甲 holds the bamboo basket gently in her right hand; at 00:03.000, @角色甲 lowers the bamboo basket gently onto the corner of the blanket; the basket rests upright on the blanket's near-left corner, its light tan cross-hatched bamboo weave unchanged, it does not fall, does not disappear. @角色乙 sets the charcoal grill down on the grass; the grill rests on the grass, its matte black cast-iron body unchanged.\\nThe bamboo basket belongs exclusively to @角色甲, and @角色乙 does not hold or carry the bamboo basket at any point, his paws remain empty. The charcoal grill belongs exclusively to @角色乙, and @角色甲 does not hold or carry the charcoal grill at any point.\\nThe final frame: @角色甲 stands at frame left and @角色乙 at frame right, side by side at the near edge of the blanket facing the camera, @角色甲's basket resting upright on the blanket's left corner, @角色乙's grill standing on the grass at frame right, the picnic tree standing at frame right behind them, both characters smiling softly under the dappled tree shade, their gazes toward the camera."
        }
      ]
    }
  ]
}

${sceneScope
? `${style ? `画风：${style}。` : ''}【本场范围】${sceneScope.title
? `整个剧本共 ${sceneScope.total} 个场次，你只负责第 ${sceneScope.index} 场「${sceneScope.title}」。输出的 scenes 数组必须包含且仅包含 1 个场次对象，其 title 必须是「${sceneScope.title}」。`
: `整份剧本没有分场标记，已被自动切成 ${sceneScope.total} 个连续部分，你只负责第 ${sceneScope.index} 部分。输出的 scenes 数组必须包含且仅包含 1 个场次对象，title 请根据该部分剧情自行概括（2-8 个字）。`}${sceneScope.perSceneDuration ? `本场内容量参考约 ${sceneScope.perSceneDuration} 秒——★这是【长度参考】，不是镜头数目标：不要用"时长÷单镜"反推镜头数，镜头数完全由任务边界决定。单镜 4-15 秒。【镜头数纪律】默认一个连续任务只出一条镜头（8-15s，运镜承载过渡）；同一主体、同一空间、同一目的下的连续动作必须一镜到底，只有切镜能挣得新主体/新信息/新情绪收益时才切。切碎没有补救——在这一步就切对，宁少勿多。` : '本场镜头数不设配额，完全由任务边界决定：连续动作/情绪优先一镜到底（单镜 4-15s），只有新主体、新信息、新情绪收益时才切，宁少勿多。'}${sceneScope.prevFinalFrame ? `\n【跨场衔接】上一场最后一个镜头的最终画面：${sceneScope.prevFinalFrame}\n本场第一个镜头的开场构图以该最终画面为参考（人物姿态、位置、构图、光线延续），承接即刻完成，不设冻结期，动作与台词可从第 0 秒直接开始。` : ''}`
: `${style && targetDuration ? `画风：${style}。【时长目标】整个分镜总时长控制在 ${targetDuration} 秒左右（允许 ±10% 浮动）。★这是【总长度参考】，不要用"时长÷单镜"反推镜头数——镜头数完全由任务边界决定。【镜头数纪律】默认一个连续任务只出一条镜头（8-15s，运镜承载过渡），同一主体/空间/目的下的连续动作必须一镜到底，只有新主体/新信息/新情绪收益才切镜。切碎没有补救，宁少勿多。注意：时长约束只能压缩每场的镜头数，【绝对不允许删减、合并或跳过任何场次】。` : `画风：${style}。镜头数不设每场配额，完全由任务边界决定：连续动作/情绪优先一镜到底（单镜 4-15s），只有新主体、新信息、新情绪收益时才切，宁少勿多。`}

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
      maxTokens: 30000,
      responseFormat: { type: 'json_object' },
      timeoutMs: config.timeouts.llm.longScript, 
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

    // 镜头合并引擎入口（分场模式）：全部分场生成完毕后执行。
    // 连续叙事默认合并（黑名单制）——同场景+主体连续+非对话反打的连续戏合成一条长镜；
    // 合并后 QC 硬错误增加则整体回退。首镜参与合并扩展（跨场衔接由尾帧参考图承担，
    // 出片侧 continuity 锚图 + "begins from <Picture N>" 承接句已覆盖，无需文本冻结段）。
    const mergeAllScenes = () => {
      if (config.storyboard?.shotMerge === false) return
      // 合并判定日志落盘（生产可观测性）：把每对的判定结果与字段快照写入 generated/logs/，
      // 便于在无法实时读取 stdout 时定位"为什么没合 / 合了什么 / 判定被什么条件挡住"。
      const dumpMergeLog = (tag, payload) => {
        try {
          const logDir = path.resolve(process.cwd(), '..', 'generated', 'logs')
          fs.mkdirSync(logDir, { recursive: true })
          const stamp = new Date().toISOString().replace(/[:.]/g, '-')
          fs.writeFileSync(path.join(logDir, `merge-${stamp}-${tag}.json`), JSON.stringify(payload, null, 1), 'utf8')
        } catch (e) {
          console.warn('[generateStoryboard] 合并日志落盘失败:', e.message)
        }
      }
      const snapShots = (scenes) => scenes.map((sc, i) => ({
        sceneIndex: i + 1,
        title: sc.title,
        shotCount: (sc.shots || []).length,
        shots: (sc.shots || []).map((sh) => {
          const dlg = Array.isArray(sh.dialogue) ? sh.dialogue : []
          const withText = dlg.filter((d) => String(d?.text || '').trim())
          return {
            n: sh.shotNumber || sh.shot_number,
            dur: sh.duration,
            sceneAssets: sh.sceneAssets || sh.scene_assets,
            characters: sh.characters,
            hasTextDlg: withText.length > 0,
            speakers: [...new Set(withText.map((d) => d?.character))],
            move: sh.cameraMovement || sh.camera_movement,
          }
        }),
      }))
      try {
        // 合并判定前的字段对齐（关键）：AI 输出常漏登记资产（sceneAssets/characters 为空或不全），
        // 而资产回填原本在路由层、合并【之后】才执行——若不先对齐，sameScene/subjectsContinuous
        // 会把"空 vs 有值"误判为场景/主体不同，导致合并大面积失败。此处先对齐再判定。
        if (assets) {
          for (const scene of allScenes) {
            for (const shot of (scene.shots || [])) {
              backfillShotAssets(shot, assets)
              backfillSceneByTitle(shot, scene.title, assets.scenes)
            }
          }
        }
        const { storyboard: merged, mergedCount, mergeLog } = applyShotMergeToStoryboard({ scenes: allScenes }, {
          durationMax: config.storyboard?.durationMax ?? 15,
          dialogueReverseBlock: config.storyboard?.dialogueReverseBlock === true,
        })
        if (mergedCount <= 0) {
          dumpMergeLog('nomerged', { tag: 'mergedCount=0', note: '判定无可合并对（全部被拒）', decisions: mergeLog, before: snapShots(allScenes) })
          return
        }
        const beforeQc = runStoryboardQC({ scenes: allScenes }, assets, styleForPoison)
        const afterQc = runStoryboardQC(merged, assets, styleForPoison)
        // 守卫：只对比「实质性」硬错误（剔除素材超长类——它是参考素材挂载量的固有属性，与合并无关；
        // 若纳入对比，素材偏重的集会让合并被整体误判回退）
        const qualityBefore = countQualityErrors(beforeQc)
        const qualityAfter = countQualityErrors(afterQc)
        if (qualityAfter > qualityBefore) {
          console.warn(`[generateStoryboard] 镜头合并后实质性 QC 硬错误 ${qualityAfter} > 合并前 ${qualityBefore}（已剔除素材超长类），放弃合并保留原稿`)
          dumpMergeLog('guardblocked', { tag: 'QC守卫回退', qualityBefore, qualityAfter, mergedCount, decisions: mergeLog })
          return
        }
        dumpMergeLog('ok', {
          tag: 'merged',
          mergedCount,
          beforeShotCounts: allScenes.map((s) => (s.shots || []).length),
          afterShotCounts: merged.scenes.map((s) => (s.shots || []).length),
          mergedPairs: mergeLog.filter((m) => m.merged),
          blockedPairs: mergeLog.filter((m) => !m.merged),
          before: snapShots(allScenes),
        })
        const detail = mergeLog.filter((m) => m.merged).map((m) => `${m.from}+${m.to}`).join('、')
        console.log(`[generateStoryboard] 镜头合并引擎：${mergedCount} 处无收益切镜已合并（${detail || '详见日志'}）`)
        allScenes.length = 0
        allScenes.push(...merged.scenes)
      } catch (e) {
        dumpMergeLog('error', { tag: 'exception', error: e.message, stack: String(e.stack || '').split('\n').slice(0, 6) })
        console.warn('[generateStoryboard] 镜头合并执行失败，保留原稿:', e.message)
      }
    }

    // QC 修复链（定点修补 → 整场重跑）全部失败时的兜底标记：不再静默采纳带病分镜。
    // 未解决错误写到镜头对象 qcStatus/qcReport，随保存落库（qc_status='fail'），QC 面板按镜号可见。
    // 2026-09-24 前行为：console.warn 后原版直接落库，带病数据无声进库、带病出片。
    function markSceneQcUnresolved(scene, qc) {
      const now = new Date().toISOString()
      const byShot = new Map()
      for (const c of qc.codedErrors || []) {
        const items = byShot.get(c.shot) || []
        items.push({ code: c.code, level: 'error', title: qcMeta(c.code)?.title || c.code, message: c.message })
        byShot.set(c.shot, items)
      }
      const shots = scene.shots || []
      if (byShot.size === 0) {
        // 无码硬错误（MUST_FIX：字段缺失等）：无法定位到具体镜，整场标记
        const items = (qc.errors || []).map((message) => ({ code: 'MUST_FIX', level: 'error', title: qcMeta('MUST_FIX')?.title || '必须修', message }))
        const report = JSON.stringify({ checkedAt: now, source: 'generate-unresolved', items })
        for (const sh of shots) { sh.qcStatus = 'fail'; sh.qcReport = report }
        return
      }
      let n = 0
      for (const sh of shots) {
        n++
        const label = sh.shotNumber || sh.shot_number || `scene${scene.sceneNumber || scene.scene_number || ''}-shot${n}`
        const items = byShot.get(label)
        if (items) {
          sh.qcStatus = 'fail'
          sh.qcReport = JSON.stringify({ checkedAt: now, source: 'generate-unresolved', items })
        }
      }
    }

    const generateSceneAt = async (i, prevFinalFrame) => {
      const scope = {
        title: sceneBlocks[i].title,
        text: sceneBlocks[i].text,
        index: i + 1,
        total: sceneBlocks.length,
        perSceneDuration: perSceneDurations[i] || 0,
        prevFinalFrame,
      }
      console.log(`[generateStoryboard] 分场生成 第 ${i + 1}/${sceneBlocks.length} ${scope.title ? `场「${scope.title}」` : '块（自动分块）'}`)
      let r = await buildAndRun('', scope)
      if (r.parseError) {
        console.warn(`[generateStoryboard] 第 ${i + 1} 场 JSON 解析失败，自动重试:`, r.parseError.message)
        const retryNote = `\n\n【纠错重试】你上一次输出的 JSON 存在语法错误（${r.parseError.message}）。请重新输出本场分镜 JSON：数组元素间必须有逗号、字符串值内不出现未转义的双引号和换行、括号完整闭合。`
        r = await buildAndRun(retryNote, scope)
        if (r.parseError) throw r.parseError
      }
      if (!r.storyboard.scenes.length) throw new Error(`第 ${i + 1} 块（${scope.title || '自动分块'}）未返回分镜`)
      if (r.storyboard.scenes.length > 1) {
        console.warn(`[generateStoryboard] 第 ${i + 1}/${sceneBlocks.length} 场「${scope.title || '自动分块'}」要求仅返回 1 个场次，模型返回了 ${r.storyboard.scenes.length} 个，已取第 1 个，其余场次的镜头被丢弃`)
      }
      let scene = r.storyboard.scenes[0]
      let sceneSource = r

      const sceneQc = validateStoryboard({ scenes: [scene] }, assets, { projectStyleText: styleForPoison, scriptText: scope.text })
      let qcClean = sceneQc.errors.length === 0
      if (!qcClean) {
        console.warn(`[generateStoryboard] 第 ${i + 1} 场 QC 发现 ${sceneQc.errors.length} 个硬错误:`, sceneQc.errors.join('; '))
        // 先试定点修补：只回炉报错的镜头，避免整场重发（整场输入约 2.2 万 tokens、单次 150s+）。
        // 修补内部已含整场复检；任一步不通过则 repaired 为 null，落到下面的整场重跑兜底。
        let repaired = null
        if (config.storyboard?.shotRepair !== false) {
          repaired = await applyQcShotRepair(scene, sceneQc.errors, assets, style, i, options.styleCategory)
          if (repaired) {
            console.log(`[generateStoryboard] 第 ${i + 1} 场 QC 定点修补通过（镜头 ${repaired.labels.join('、')}）`)
            scene = repaired.scene
            qcClean = true
          } else {
            console.warn(`[generateStoryboard] 第 ${i + 1} 场 QC 定点修补未通过，回退整场重跑`)
          }
        }
        if (!repaired) {
          const r2 = await buildAndRun(qcRetryNote(sceneQc), scope)
          if (!r2.parseError && r2.storyboard.scenes.length) {
            const scene2 = r2.storyboard.scenes[0]
            if (!validateStoryboard({ scenes: [scene2] }, assets, { projectStyleText: styleForPoison, scriptText: scope.text }).errors.length) {
              scene = scene2
              sceneSource = r2
              qcClean = true
            }
          }
        }
      }
      if (!qcClean) {
        console.warn(`[generateStoryboard] 第 ${i + 1} 场 QC 未解决（定点修补与整场重跑均未通过），已标记 QC 失败待人工确认:`, sceneQc.errors.join('; '))
        markSceneQcUnresolved(scene, sceneQc)
      }

      if (scope.title) scene.title = scope.title 
      console.log(`[generateStoryboard] 第 ${i + 1}/${sceneBlocks.length} 场完成（${(scene.shots || []).length} 镜）`)
      return { scene, unmatched: Array.isArray(sceneSource.unmatched) ? sceneSource.unmatched : [] }
    }

    const allScenes = []
    const allUnmatched = []
    report({ phase: PHASE.SCENES, done: 0, total: sceneBlocks.length, message: `分场生成中：0/${sceneBlocks.length} 场完成` })

    if (!parallelScenes) {
      let prevFinalFrame = ''
      for (let i = 0; i < sceneBlocks.length; i++) {
        report({
          phase: PHASE.SCENES,
          done: i,
          total: sceneBlocks.length,
          currentLabel: sceneBlocks[i].title || `第 ${i + 1} 块`,
          message: `正在生成第 ${i + 1}/${sceneBlocks.length} 场${sceneBlocks[i].title ? `「${sceneBlocks[i].title}」` : ''}…`,
        })
        const { scene, unmatched } = await generateSceneAt(i, prevFinalFrame)
        allScenes.push(scene)
        allUnmatched.push(...unmatched)
        const shots = scene.shots || []
        prevFinalFrame = shots.length ? shots[shots.length - 1].finalFrame : ''
        report({
          phase: PHASE.SCENES,
          done: i + 1,
          total: sceneBlocks.length,
          currentLabel: sceneBlocks[i].title || `第 ${i + 1} 块`,
          message: `分场生成中：${i + 1}/${sceneBlocks.length} 场完成`,
        })
      }
      mergeAllScenes()
    } else {
      console.log(`[generateStoryboard] 两阶段并行：${sceneBlocks.length} 场同时发起，完成后进入归一化`)
      let doneCount = 0
      const results = await Promise.all(sceneBlocks.map(async (_, i) => {
        const r = await generateSceneAt(i, '')
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

      mergeAllScenes()

      // 跨场衔接由「尾帧参考图 + 提示词承接句」承担，无跨场文本修补阶段
      //（原 Airlock 跨场修补链已于 2026-09-24 事故整改中整体废除，不再有任何跨场文本改写/修补。）
      console.log('[generateStoryboard] 跳过跨场文本修补：跨场衔接改由尾帧参考图 + 提示词承接句承担')

      if (config.storyboard?.fixAxis !== false) {
        const charNames = (assets?.characters || []).map((c) => c.name).filter(Boolean)
        const aliasMap = buildAliasMap(assets?.characters || [])
        report({ phase: PHASE.AXIS, done: 0, total: 0, message: '正在做越轴巡检（检测侧位翻转）…' })
        const axisRes = await fixAxisFlips(allScenes, charNames, style, aliasMap, (done, total) => {
          report({ phase: PHASE.AXIS, done, total, message: `越轴修补中：${done}/${total} 处` })
        })
        if (axisRes?.unresolved?.length) {
          console.warn(`[generateStoryboard] 越轴修补后仍有 ${axisRes.unresolved.length} 处未修复：`,
            axisRes.unresolved.map((u) => `${u.shot}@${u.name}(${u.reason})`).join('; '))
        }
      }
    }
    const normalizedMulti = normalizeStoryboard({ scenes: allScenes }, targetDuration)
    normalizedMulti.unmatched = allUnmatched
    // 出片提示词预算守卫（H3 硬上限 7000）——超限镜头自动瘦身，保证可出片
    enforcePromptBudget(normalizedMulti, assets)
    const finalQc = runStoryboardQC(normalizedMulti, assets, styleForPoison)
    if (finalQc.errors.length) {
      console.warn(`[generateStoryboard] 分场合并后 QC 仍有 ${finalQc.errors.length} 个硬错误，已透传 storyboard.qc:`, finalQc.errors.join('; '))
    }
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

  // 镜头合并引擎入口（单场模式）：所有 return 出口统一过这道闸——
  // 把无收益的相邻碎镜合并成连续运镜长镜；QC 硬错误增加或执行异常则回退原稿。
  const finalizeWithMergeInner = (sb) => {
    if (!sb || config.storyboard?.shotMerge === false) return sb
    try {
      const { storyboard: merged, mergedCount, mergeLog } = applyShotMergeToStoryboard(sb, {
        durationMax: config.storyboard?.durationMax ?? 15,
        dialogueReverseBlock: config.storyboard?.dialogueReverseBlock === true,
      })
      if (mergedCount <= 0) return sb
      const beforeQc = runStoryboardQC(sb, assets, styleForPoison)
      const afterQc = runStoryboardQC(merged, assets, styleForPoison)
      // 守卫：只对比「实质性」硬错误（剔除素材超长类——参考素材挂载量的固有属性，与合并无关）
      const qualityBefore = countQualityErrors(beforeQc)
      const qualityAfter = countQualityErrors(afterQc)
      if (qualityAfter > qualityBefore) {
        console.warn(`[generateStoryboard] 镜头合并后实质性 QC 硬错误 ${qualityAfter} > 合并前 ${qualityBefore}（已剔除素材超长类），放弃合并保留原稿`)
        return sb
      }
      merged.unmatched = sb.unmatched
      const detail = mergeLog.filter((m) => m.merged).map((m) => `${m.from}+${m.to}`).join('、')
      console.log(`[generateStoryboard] 镜头合并引擎：${mergedCount} 处无收益切镜已合并（${detail || '详见日志'}）`)
      return merged
    } catch (e) {
      console.warn('[generateStoryboard] 镜头合并执行失败，保留原稿:', e.message)
      return sb
    }
  }
  // 单场模式统一出口：先过合并闸（finalizeWithMergeInner），再过「出片提示词预算守卫」
  // （H3 硬上限 7000——超限镜头自动瘦身，保证可出片；无匹配资产/未超限时零开销）
  const finalizeWithMerge = (sb) => {
    const out = finalizeWithMergeInner(sb)
    enforcePromptBudget(out, assets)
    return out
  }

  const storyboard = result.storyboard
  if (scriptSceneTitles.length && storyboard.scenes.length !== scriptSceneTitles.length) {
    console.warn(
      `[generateStoryboard] 场次数不匹配：剧本 ${scriptSceneTitles.length} 场，分镜只有 ${storyboard.scenes.length} 场（${storyboard.scenes.map((s) => s.title).join('、')}），自动重试`
    )
    const retryNote = `\n\n【纠错重试】上一次输出只有 ${storyboard.scenes.length} 个场次，与剧本的 ${scriptSceneTitles.length} 个场次不符。本次必须输出完整 ${scriptSceneTitles.length} 个场次：${scriptSceneTitles.join('、')}，一场都不能少，每个场次至少 1 个镜头。`
    const retried = await buildAndRun(retryNote)
    if (retried.parseError) throw retried.parseError
    retried.storyboard.unmatched = Array.isArray(retried.unmatched) ? retried.unmatched : []
    const retriedQc = runStoryboardQC(retried.storyboard, assets, styleForPoison)
    if (retriedQc.errors.length) {
      console.warn(`[generateStoryboard] 场次数重试后 QC 仍有 ${retriedQc.errors.length} 个硬错误，已透传 storyboard.qc:`, retriedQc.errors.join('; '))
    }
    return finalizeWithMerge(retried.storyboard)
  }
  storyboard.unmatched = Array.isArray(result.unmatched) ? result.unmatched : []
  const qc = runStoryboardQC(storyboard, assets, styleForPoison)
  if (qc.errors.length) {
    console.warn(`[generateStoryboard] QC 发现 ${qc.errors.length} 个硬错误，喂回重试:`, qc.errors.join('; '))
    const qcRetried = await buildAndRun(qcRetryNote(qc))
    if (!qcRetried.parseError) {
      qcRetried.storyboard.unmatched = Array.isArray(qcRetried.unmatched) ? qcRetried.unmatched : []
      const retriedQc = runStoryboardQC(qcRetried.storyboard, assets, styleForPoison)
      if (!retriedQc.errors.length) return finalizeWithMerge(qcRetried.storyboard)
      console.warn(`[generateStoryboard] QC 重试后仍有 ${retriedQc.errors.length} 个硬错误，沿用重试版并透传 qc 结果供人工审核`)
      return finalizeWithMerge(qcRetried.storyboard)
    }
    console.warn('[generateStoryboard] QC 重试解析失败，沿用上一版并透传 qc 结果')
  }
  return finalizeWithMerge(storyboard)
}

export async function generateStoryboardFromFile(fileContent, style = config.defaultArtStyle, assets = null, options = {}) {
  // 画风毒词豁免文本：画风名 + 类别桶词，与 generateStoryboard 同口径
  const styleForPoison = stylePoisonText(style, options.styleCategory)
  const assetMaps = assets ? buildAssetMaps(assets) : null
  const assetListPrompt = assets ? buildAssetListPrompt(assets) : ''
  const specHint = directorNotesPrompt(options?.directorNotes || '', { mode: 'gentle' })

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

每个镜头必须输出以下字段（缺失字段填空字符串或 null，不要省略键）：
- shotType: 全景/中景/近景/特写（用户未标注则你按描述推断，至少给"中景"）
- startTime/endTime: 整数秒
- duration: 整数秒
- description: 中文画面描述，用 @角色名/@道具名/@场景名 标记出现的资产；若用户原描述已合规则保留原话，不塞 integratedMultimodalDescription 内容、不写"音效：""角色："等带冒号小标题
- actionNote: 动作说明（无则空字符串）
- cameraMovement: 固定/推近/拉远/变焦推近/变焦拉远/左摇/右摇/左移/右移/摇上/摇下/升高/降低/环绕/跟拍/手持跟拍/主观/滚转（无则"固定"；本字段为单值，只填一个运镜；情绪升级可用急推/快甩/急跟/急升等快速变体，抒情段落可用缓推/缓摇/缓环绕等缓慢变体；俯拍/仰拍属 camera_angle 不写这里）
- soundEffects: 画内音效（无则空字符串）
- overallSoundscape: 环境声（无则空字符串）
- nonDiegeticMusic: 非画内音乐建议（无则空字符串）
- dialogue: 台词对象 {character, tone, text, startTime}；character 必须是真实角色名（与资产清单 characters 匹配）；无台词为 null（"台词：音效/字幕/题材"这类伪台词行禁止进入本字段，见铁律 7）
- characters/sceneAssets/propAssets: 资产名数组，逐字匹配资产清单
- finalFrame: 本镜最终画面描述（用户原文有则提取，无则空字符串）
- integratedMultimodalDescription: 用户原文若已含多模态提示词则原样提取，否则空字符串（不强制补全）

输出格式（严格合法 JSON，以 { 开头 } 结尾）：
{
  "scenes": [
    { "title": "场次标题或空字符串",
      "shots": [ { 上述字段... } ] }
  ],
  "__unmatched": [ "清单外出现的资产名1", "资产名2" ]
}

${assetListPrompt}【JSON 语法要求】字符串值内部禁止未转义双引号和裸换行；数组元素间必须有逗号；只输出 JSON 不输出其他文字。${specHint}${retryNote}`,
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
      usageContext: { task: 'storyboard' },
    })

    const parseStoryboardJson = async (raw) => {
      const jsonStr = extractFirstJson(raw)
      if (jsonStr) {
        try {
          const parsed = JSON.parse(jsonStr)
          const storyboard = normalizeStoryboard(parsed, 0)
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
          applyImdHybridCompile(storyboard, assets)
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
  const fileQc = runStoryboardQC(storyboard, assets, styleForPoison)
  if (fileQc.errors.length) {
    console.warn(`[generateStoryboardFromFile] QC ${fileQc.errors.length} 个硬错误（源文件缺字段，已透传供人工确认）:`, fileQc.errors.join('; '))
  }
  return storyboard
}

const PROHIBITED_OUTFIT_HINTS = [
  'explorer hat', 'daisies', 'daisy', 'adventurer', 'wearing a hat', 'wearing a cap', 'wearing a dress',
  'wearing clothes', 'wearing a scarf', 'wearing glasses', 'male ', 'female ', ' girl', ' boy',
  'woman', 'man', 'tall', 'short', 'sturdy', 'chubby', 'slender', ' petite',
  'round belly', 'belly jiggling', 'chubby belly', 'round chubby', 'fluffy round ears',
]
function sanitizeIntegrated(text) {
  if (!text) return text
  let cleaned = text
  cleaned = cleaned.replace(
    /(@[\u4e00-\u9fa5A-Za-z0-9]+,\s*exactly as shown,\s*)[^.\n]*([.\n])/g,
    (m, prefix, terminator) => {
      const tail = m.slice(prefix.length, m.length - terminator.length)
      const hasProhibited = PROHIBITED_OUTFIT_HINTS.some((kw) => tail.toLowerCase().includes(kw.toLowerCase()))
      return hasProhibited ? prefix.trimEnd() + terminator : m
    }
  )
  cleaned = cleaned.replace(/,\s*[^,.\n]*?(round belly|belly jiggling|chubby belly|round chubby)[^,.\n]*?(?=[,.\n])/gi, '')
  cleaned = cleaned.replace(/,\s*(decorated|adorned)\s+with[^,.\n]*/gi, '')
  cleaned = cleaned.replace(/,\s*wearing\s+[^,.\n]*/gi, '')
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
      content: `你是专业的 AI 视频提示词工程师，精通 AI 视频控制式 prompt 写法（用于本项目的画面描述字段，按其六模块结构书写）。【重要】立刻输出 integrated_multimodal_description 正文，不要任何思考、分析、解释或前言。请根据给定的单个镜头信息，为该镜头生成完整的 integrated_multimodal_description（英文，6 模块结构）。${assetListPrompt}${directorNotesPrompt(opts?.directorNotes || '')}

画风：${style || config.defaultArtStyle}（画面开头声明画风，全片严格统一，禁止偏离）。

6 模块结构（严格按此书写，用换行分隔）：
${integratedModulesRule()}${frameGeographyRule()}
【硬约束】
- 模块2/3 的角色与环境外貌必须【逐字复制】资产清单 description，禁止增删改、禁止编造清单外特征（帽子/服装/性别/年龄/体型等）。
- 镜头描述或最终画面中 @ 提到的所有角色（含不说话的角色）都必须在模块2 中出现并锁定外观。
${styleLockRule(style, opts.styleCategory || '')}
- 只输出 integrated_multimodal_description 正文，不要输出 JSON、不要标题、不要解释。`,
    },
    {
      role: 'user',
      content: `镜头描述：${shot.description || ''}
时长：${shot.duration || 8} 秒
景别：${shot.shotType || '中景'}
角色：${(shot.characters || []).join('、') || '无'}
场景：${(shot.sceneAssets || []).join('、') || '无'}
道具：${(shot.propAssets || []).join('、') || '无'}
台词：${dialogue}
动作说明：${shot.actionNote || '无'}`,
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
  return compiled.text
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

  const messages = [
    {
      role: 'system',
      content: `你是专业的分镜师，精通 AI 视频生成的"控制式 prompt"写法。任务：在保持叙事任务与前后镜衔接不变的前提下，重写【单个镜头】的全部内容。输出严格的 JSON 格式，立刻输出 JSON，禁止任何思考、分析、解释或前言。${assetListPrompt}${directorNotesPrompt(opts?.directorNotes || '')}

画风：${style || config.defaultArtStyle}（与全片一致，禁止偏离）。

【铁律】
1. 视觉锁定：角色外貌必须【逐字复制】资产清单中该角色的 description；清单里没有的特征绝对禁止添加。场景描写必须【逐字复制】该场景的 description，禁止编造清单外元素。
2. 道具专属：每个道具声明 "belongs exclusively to @XX"，其他角色 "paws/hands remain empty"。
3. 动作微分解：道具动作拆成 动作方式 → 最终状态 → 材质确认 → 否定约束 四段。
4. 多模态分离：画面/声景/音乐/台词分模块独立书写。
${cameraAngleRule()}
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
    "shotType": "全景/中景/近景/特写",
    "startTime": ${baseStart},
    "cameraMovement": "运镜（一镜一个主运镜）",
    "camera_angle": "正面/侧面/背面/过肩/俯拍/仰拍",
    "duration": ${duration},
    "description": "中文画面描述 40-80 字，用 @角色名/@道具名/@场景名 标记资产",
    "actionNote": "动作说明",
    "soundEffects": "画内音效，没有则为空字符串",
    "overallSoundscape": "环境声，没有则为空字符串",
    "nonDiegeticMusic": "非画内音乐建议，没有则为空字符串",
    "isCombat": true/false,
    "purpose": "本镜叙事任务（10-30字）",
    "goal": "观众任务（10-30字）",
    "emotionTone": "情绪基调（2-6字）",
    "infoPoints": ["关键信息点（0-3个）"],
    "worldStateOut": "@角色：画面位置·手持·朝向；@道具：位置·状态",
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

// QC 错误消息里「镜头 X：…」的镜号前缀（与 storyboardValidator 的 label 口径保持一致）
const QC_SHOT_LABEL_RE = /^镜头\s*([^：:]+?)\s*[：:]/

// 复现 storyboardValidator 的镜头 label 口径：优先用已编号的 shotNumber，否则回落到
// `scene{场号}-shot{本场累计镜号}`。生成中间态（AI 刚输出、尚未落库）没有 shotNumber，
// 走的正是回落分支——只按 shotNumber 匹配会让定点修补永远找不到目标镜头。
function shotLabelsOfScene(scene) {
  let shotCount = 0
  return (scene?.shots || []).map((shot) => {
    shotCount++
    const raw = shot?.shotNumber || shot?.shot_number || `scene${scene?.sceneNumber || ''}-shot${shotCount}`
    return String(raw).trim()
  })
}

// QC 定点修补：把「镜头 X：…」形式的硬错误按镜号归组，只回炉这些镜头，替代整场重跑。
// 整场重跑要把规则与资产清单整份重发（实测约 2.2 万 tokens 输入 / 单次 150s+）；
// 定点修补复用单镜重写器，只带本镜与相邻镜上下文（约 1~2k tokens），快一个量级。
// 归组失败、任一镜修补失败、或整场复检仍有硬错误，都返回 null，由调用方回退整场重跑。
async function applyQcShotRepair(scene, qcErrors, assets, style, sceneIndex = 0, styleCategory = '') {
  const shots = scene?.shots || []
  if (!shots.length) return null

  const labels = shotLabelsOfScene(scene)
  const errorsByIndex = new Map()
  for (const err of qcErrors || []) {
    const matched = QC_SHOT_LABEL_RE.exec(String(err || ''))
    if (!matched) return null
    const idx = labels.indexOf(matched[1].trim())
    if (idx < 0) return null
    const list = errorsByIndex.get(idx) || []
    list.push(String(err))
    errorsByIndex.set(idx, list)
  }
  const targets = [...errorsByIndex.keys()]
  if (!targets.length) return null

  const patched = new Array(shots.length).fill(null)
  let cursor = 0
  let aborted = false
  const worker = async () => {
    while (!aborted) {
      const at = cursor++
      if (at >= targets.length) return
      const idx = targets[at]
      try {
        const { shot } = await regenerateShot({
          current: shots[idx],
          prev: idx > 0 ? shots[idx - 1] : null,
          next: idx + 1 < shots.length ? shots[idx + 1] : null,
          sceneTitle: scene.title || '',
          instruction: `本镜存在以下硬性校验错误，必须逐条修正；除修正所必需的内容外，其余字段与叙事任务保持原样：\n${errorsByIndex.get(idx).map((e, n) => `${n + 1}. ${e}`).join('\n')}`,
        }, assets, style, { styleCategory })
        patched[idx] = shot
      } catch (e) {
        console.warn(`[generateStoryboard] 第 ${sceneIndex + 1} 场镜头 ${labels[idx]} 定点修补失败:`, e.message)
        aborted = true
      }
    }
  }
  const concurrency = Math.min(
    Math.max(1, Number(config.storyboard?.repairConcurrency) || 4),
    targets.length
  )
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  if (aborted) return null

  const nextScene = { ...scene, shots: shots.map((s, idx) => (patched[idx] ? { ...s, ...patched[idx] } : s)) }
  if (validateStoryboard({ scenes: [nextScene] }, assets, { projectStyleText: stylePoisonText(style, styleCategory) }).errors.length) return null
  return { scene: nextScene, labels: targets.map((idx) => labels[idx]) }
}

function runStoryboardQC(storyboard, assets, styleText = '') {
  const qc = validateStoryboard(storyboard, assets, { projectStyleText: styleText })
  storyboard.qc = { errors: qc.errors, warnings: qc.warnings, fixed: qc.fixed }
  return qc
}

// QC 硬错误计数（剔除「出片提示词超长」类）：该类错误源于参考素材挂载总量（骨架+素材固定开销占大头），
// 是镜头宿主的固有属性、与镜头合并无关——若纳入对比，素材挂载偏重的集会让合并被整体误判回退。
function countQualityErrors(qc) {
  return (qc?.errors || []).filter((e) => !/出片提示词/.test(String(e.message || e))).length
}

// 出片提示词预算守卫（H3 硬上限 7000 字符，超限则出片直接被拒）：
// 按「对成片影响最小」的顺序自动瘦身——先移除道具引用（道具图是为近景交互准备的，仅出现在
// 远景/背景中的道具纯属冗余，靠场景图与文字描述即可），仍超再移除次要场景引用（保留首个 = 本场主场景）。
// ratio 为安全系数（默认 0.98，留 2% 余量防英译长度波动，实测残差可达 ±500）。
export function enforcePromptBudget(storyboard, assets, ratio = 0.98) {
  const limit = (config.storyboard?.h3PromptCharLimit ?? 7000) * ratio
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

function qcRetryNote(qc) {
  return `\n\n【QC纠错重试】你上一次输出的分镜存在硬性校验错误：${qc.errors.join('；')}。请修正后重新输出完整分镜 JSON：每个镜头的 finalFrame 与 integratedMultimodalDescription 必填、duration 必须是数字、characters 里的名字必须与资产清单逐字一致。`
}

const FAKE_SPEAKER_WORDS = new Set(['音效', '音效台词', '字幕', '字幕淡入', '片尾字幕', '题材', '旁白字幕', 'BGM', 'bgm', '音乐'])
const isFakeSpeaker = (name) => FAKE_SPEAKER_WORDS.has(String(name || '').trim())

const CAMERA_ANGLE_VALUES = ['正面', '侧面', '背面', '过肩', '俯拍', '仰拍']

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

function normalizeStoryboard(storyboard, targetDuration = 0, { minDuration = 4 } = {}) {
  const scenes = Array.isArray(storyboard?.scenes) ? storyboard.scenes : []
  if (!scenes.length) throw new Error('分镜结果缺少 scenes')

  const durationCeil = config.storyboard?.durationMax ?? 15
  let cursor = 0
  let clampedCount = 0
  const normalizedScenes = scenes.map((scene, sceneIndex) => {
    const shots = Array.isArray(scene.shots) ? scene.shots : []
    if (!shots.length) throw new Error(`场次 ${sceneIndex + 1} 没有镜头`)

    const normalizedShots = shots.map((shot, shotIndex) => {
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
        ...(typeof shot.isCombat === 'boolean' ? { isCombat: shot.isCombat } : {}),
        ...(CAMERA_ANGLE_VALUES.includes(shot.camera_angle) ? { camera_angle: shot.camera_angle } : {}),
      }
    })

    return {
      title: String(scene.title || `场次${sceneIndex + 1}`).trim(),
      shots: normalizedShots,
    }
  })

  const total = cursor
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
5. 跨角色关系显式化：剧情中有遮挡（"挡在面前"）、拉拽、跟随、躲藏等关系时，用 relation 字段写明（如 "shielding @角色甲" / "hidden behind 巨石 with @角色乙"），并且用前后景深坐标体现（前景 y 更大，遮挡者必须比被遮挡者更靠近威胁方向）。
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
