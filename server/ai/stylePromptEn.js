// 中文画风提示词 → 英文「画风锚」（2026-09-14）
//
// 背景：`style_presets.prompt_en` 是 H3 出片 prompt 里**唯一**能用的画风段来源。
// `routes/generate.js` 取画风的口径是 `prompt_en || label_en`——中文 `prompt` 按
// AGENTS.md §二「中文画风一律丢弃」的规则进不了英文正文。历史问题：170 条预设里
// 169 条 `prompt_en` 为空，于是**换任何非「吉卜力风格」的画风立项，画风锚就退化成
// label_en 一个短标签**（如 "Cinematic Hyper-realistic"），整段中文描述被丢掉，且全链无告警。
//
// 本模块把"翻译 + 校验"收敛到一处，供三处复用：
//   1. 一次性回填脚本 `_backfill_style_en.mjs`
//   2. `routes/styles.js` 新建自定义画风（POST）
//   3. `routes/styles.js` 编辑自定义画风（PATCH）——编辑只改中文会导致英文串陈旧，
//      必须同步重译，否则「中英不一致」比「英文为空」更危险（英文看起来有值、实则过期）
//
// 设计口径：
// - 输出必须是**逗号分隔的英文风格属性短语**，对齐现有唯一基准（吉卜力风格那条：
//   "hand-drawn 2D animation, classic Japanese-animated-film style, watercolor paper
//    texture, soft natural daylight, ..."）。
// - **校验闸**：纯英文（无 CJK）、词数区间、无引号/换行注入。校验不过重试一次，
//   仍不过则返回 ok:false 且**不产出英文**——宁缺勿脏（同 §二 对 name_en 的口径）。
// - 只翻译、不新增要素；角色级外貌细节不进画风段（角色外观由角色卡负责）。

import { chatCompletion } from './doubao.js'
import { CJK_DIRTY_RE } from './shared.js'

// 输出校验参数
const MIN_WORDS = 8
const MAX_WORDS = 90

// F2（2026-09-18，第四轮）：判据直连 shared.CJK_DIRTY_RE 单点，不再就地合成。
//
// 此前此处是「CJK_DIRTY_RE.source + 追加 CJK 扩展 A 段」的 new RegExp 合成——因为主字符集
// 当时没覆盖扩展 A，直接换会放宽闸门。第四轮 F2 已把扩展 A（及竖排形式/兼容表意/部首笔画）
// 并进 shared 单点，本文件的「画风段必须纯英文」口径 = CJK_DIRTY_RE 全集，直接用即可：
// 只做并集、不做差集（不放宽），也不再残留任何内联字面量。

/** 清掉模型可能带回的包装：markdown 代码块、前后引号、"英文："之类前缀 */
function sanitize(raw) {
  let s = String(raw ?? '').trim()
  // 去掉 ```...``` 包裹
  s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '')
  // 去掉行首的 "English:" / "英文：" / "Translation:" 之类标签（可能重复出现）
  for (let i = 0; i < 3; i++) {
    const before = s
    s = s.replace(/^\s*(english|translation|英文|翻译|output)\s*[:：]\s*/i, '')
    if (s === before) break
  }
  // 引号归一（重要）：
  //  · 弯撇号 ‘ ’ 一律转成直撇号——children's / painter's 这类正常英文要用，不能当非法字符拦掉
  //  · 双引号 “ ” 与直双引号一律删除：AGENTS.md §1.5 规定英文双引号是「画面内文字」的定界符，
  //    画风段里出现双引号可能被模型当成要渲染进画面的文字
  s = s.replace(/[‘’]/g, "'").replace(/[“”]/g, '')
  // 去首尾包裹引号
  s = s.replace(/^["']+/, '').replace(/["']+$/, '')
  // 清掉残留的直双引号（保留撇号）
  s = s.replace(/"/g, '')
  // 换行折成空格，连续空白归一
  s = s.replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim()
  // 去掉尾部的句号（风格短语用逗号分隔，不需要句末点）
  s = s.replace(/[。.]+$/, '').trim()
  return s
}

/**
 * 校验英文串是否可用于出片 prompt。
 * 注意：撇号 `'` 是**合法**的（children's book 这类正常英文），不拦；
 * 只有双引号要拦——它是「画面内文字」的定界符（AGENTS.md §1.5）。
 * @returns {{ok: boolean, reason: string}}
 */
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

/**
 * 翻译一条画风提示词。
 * @param {{label?:string, labelEn?:string, prompt:string, model?:string}} opts
 * @returns {Promise<{ok:boolean, en:string, reason:string, attempts:number}>}
 */
export async function translateStylePrompt({ label = '', labelEn = '', prompt = '', model } = {}) {
  const zh = String(prompt || '').trim()
  if (!zh) return { ok: false, en: '', reason: '中文提示词为空', attempts: 0 }

  const user = `画风名称：${label || '(未命名)'}\n英文名：${labelEn || '(无)'}\n中文画风描述：\n${zh}`

  let lastReason = ''
  let lastRaw = ''
  // 共两次机会：首次 + 一次重试（校验不过时把上一次的坏输出与失败原因回灌，让模型自纠）
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
        // 翻译是直给任务，不需要思考链。qwen3.8-flash 默认走思考，实测单条
        // 输出 1000~3000 token（正文只有 30~60 词），均延迟 30s、最长 183s；
        // 关掉后延迟与成本都降一个量级。chatCompletion 会把 enable_thinking=false 透传给 DashScope。
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
