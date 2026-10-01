// 分镜工具函数模块（QC 质检已整体移除）。
//
// 2026-09-26：本文件原承载的 QC 质检能力（67 个检查码、validateShot / validateStoryboard /
// rowToShotForQc，以及配套的 ai/qcCodes.js 注册表、routes/qc.js 路由与前端质检面板）已全部删除。
// 删除原因：误报率高，且 error 级硬校验会触发「整场重跑 / 定点重写」，反过来拉低 Skill 分镜质量。
//
// 保留的是生成链路仍在生产调用的纯工具函数——它们不做「检测→判定→改写/重跑」，只是被调用的能力：
//   · 越轴修复：hasExplicitReposition / extractScreenSides / buildAliasMap
//   · 画风毒词词典：STYLE_POISON_ZH / STYLE_POISON_EN / STYLE_EXEMPT_BY_CATEGORY / styleExemptWords
//     （storyboardRules.styleLockRule 引用它把禁用词写进提示词规则——事前约束，不是事后检测）
//   · 光位线索提取：extractLightCues（光线对齐用）
//   · 配乐情绪词识别：findMusicMoodWords（配乐改写预检用）
//   · 出片提示词长度估算：estimateShotVideoPromptChars / estimateRefsPromptCost / dialogueTextLen
//     （H3 7000 字符预算裁剪用——是适配层的裁剪依据，不是质检判定）

import { escapeRegExp } from './shared.js'
import {
  estimateH3ShotVideoPromptChars,
  findH3MusicMoodWords,
} from '../storyboard/providers/h3.js'

const SIDE_PATTERNS = [
  [/\bat frame left\b/i, 'left'],
  [/\bat frame right\b/i, 'right'],
  [/\bat center frame\b|\bat the center of the frame\b|\bcenter frame\b/i, 'center'],
  [/\bframe[- ]left\b|\bleft side of the frame\b|\bscreen left\b/i, 'left'],
  [/\bframe[- ]right\b|\bright side of the frame\b|\bscreen right\b/i, 'right'],
]

export function hasExplicitReposition(text, side) {
  if (!text || !side) return false
  return new RegExp(
    `(walks?|runs?|moves?|crosses?|steps?|circles?|drifts?|shifts?|sidesteps?|repositions?)[^@\\.]{0,60}frame ${side}`,
    'i'
  ).test(text)
}

function buildNameForms(name, extraAliases = []) {
  const forms = new Set()
  const push = (s) => {
    const v = String(s || '').trim()
    if (v) forms.add(v)
  }
  push(name)
  for (const part of String(name || '').split('/')) push(part)
  for (const a of extraAliases) {
    for (const part of String(a || '').split(',')) push(part)
  }
  return [...forms].filter(Boolean).sort((a, b) => b.length - a.length) 
}

export function extractScreenSides(text, charNames, aliasMap = null) {
  const sides = new Map()
  if (!text || !charNames) return sides
  for (const name of charNames) {
    const aliases = aliasMap?.get?.(name) || []
    const forms = buildNameForms(name, aliases)
    let matched = false
    for (const form of forms) {
      if (matched) break
      const re = new RegExp(`@?${escapeRegExp(form)}(?![\\w\\u4e00-\\u9fa5])`, 'gi')
      let m
      while ((m = re.exec(text))) {
        const start = m.index
        const window = text.slice(start, start + form.length + 120)
        let best = null
        for (const [pat, side] of SIDE_PATTERNS) {
          const sm = window.match(pat)
          if (sm && (best === null || sm.index < best.index)) best = { index: sm.index, side }
        }
        if (best) {
          sides.set(name, best.side)
          matched = true
          break
        }
      }
    }
  }
  return sides
}

export function buildAliasMap(charRows) {
  const map = new Map()
  for (const r of charRows || []) {
    const name = String(r?.name || '').trim()
    if (!name) continue
    const aliases = [
      ...String(r?.name_en || '').split(','),
      ...String(r?.aliases || '').split(','),
    ]
      .map((s) => s.trim())
      .filter(Boolean)
    if (aliases.length) map.set(name, aliases)
  }
  return map
}

// ⚠️ 画风毒词唯一权威源：storyboardRules.styleLockRule 从这里引用，禁止各写一份。
export const STYLE_POISON_ZH = ['写实CGI', '写实CG', '写实', 'CG定格', 'CG感', '真实感', '照片级', '电影质感', '3D', '三维', '立体渲染', '实拍']
export const STYLE_POISON_EN = ['realistic', 'CGI', 'photoreal', 'photorealistic', 'hyperreal', 'hyper-realistic', 'live-action', '3D render', 'CG render']

// 按画风类别豁免的毒词桶（键对应 style_presets.category_key）。
// 语义：项目本身属于该类别时，这些词是在描述「项目自己的画风」，不构成切换画风。
// 反例仍生效：realistic 项目写「写实CGI／3D／CG感」= 切到别的画风，照样拦。
export const STYLE_EXEMPT_BY_CATEGORY = {
  realistic: ['写实', '实拍', '真实感', '照片级', '电影质感', 'realistic', 'photoreal', 'photorealistic', 'hyperreal', 'hyper-realistic', 'live-action'],
  '3d-special': ['3D', '三维', '立体渲染', 'CG感', 'CG定格', 'CGI', '3D render', 'CG render'],
  '2d': [],
  custom: [],
}

// 豁免词集合 = 画风名命中 ∪ 类别桶命中 ∪ 附加文本（prompt/prompt_en）命中。
// 用集合精确匹配（非 includes），「写实CGI」不会因为豁免「CGI」而被连带放过。
export function styleExemptWords(projectStyleText = '', styleCategory = '', extraText = '') {
  const text = [String(projectStyleText || ''), String(extraText || '')].join('\n')
  const bucket = STYLE_EXEMPT_BY_CATEGORY[String(styleCategory || '').trim()] || []
  const zh = new Set()
  const en = new Set()
  for (const w of STYLE_POISON_ZH) {
    if (text.includes(w) || bucket.includes(w)) zh.add(w)
  }
  for (const w of STYLE_POISON_EN) {
    const re = new RegExp(`\\b${w.replace(/[-]/g, '[- ]')}\\b`, 'i')
    if (re.test(text) || bucket.includes(w)) en.add(w)
  }
  return { zh, en }
}

const LIGHT_DIRECTION_PATTERNS = {
  left: [/from frame left/i, /from the left/i, /light from (?:the )?left/i],
  right: [/from frame right/i, /from the right/i, /light from (?:the )?right/i],
}
const LIGHT_WARM_WORDS = ['warm', 'golden', 'amber', 'sunset', 'honey', 'orange', 'fiery']
const LIGHT_COOL_WORDS = ['cool', 'cold', 'icy', 'blue', 'grey', 'gray', 'silver', 'pale', 'frost']

export function extractLightCues(text) {
  const t = String(text || '').toLowerCase()
  if (!t) return { direction: null, warmth: null }
  let direction = null
  for (const [dir, patterns] of Object.entries(LIGHT_DIRECTION_PATTERNS)) {
    if (patterns.some((p) => p.test(t))) { direction = dir; break }
  }
  let warmth = null
  if (LIGHT_WARM_WORDS.some((w) => t.includes(w))) warmth = 'warm'
  else if (LIGHT_COOL_WORDS.some((w) => t.includes(w))) warmth = 'cool'
  return { direction, warmth }
}

export function findMusicMoodWords(musicText) {
  return findH3MusicMoodWords(musicText)
}

export function dialogueTextLen(d) {
  if (d == null) return 0
  let arr = d
  if (typeof d === 'string') {
    const s = d.trim()
    if (!s || s === 'null') return s.length
    try { arr = JSON.parse(s) } catch { return s.length }
  }
  if (Array.isArray(arr)) return arr.reduce((n, x) => n + String(x?.text || '').length, 0)
  if (typeof arr === 'object') return String(arr.text || '').length
  return 0
}

// ctx.assetNames 可提供 characters/scenes/props 行（含 description_en/summary_en/lighting_en），
// 有则用实值估，没有则按 REF_FALLBACK_COST 均值估（宁可高估不误放）。
export function estimateRefsPromptCost(shot, ctx = {}) {
  return estimateH3ShotVideoPromptChars(shot, ctx).refsCost
}

export function estimateShotVideoPromptChars(shot, ctx = {}) {
  return estimateH3ShotVideoPromptChars(shot, ctx)
}
