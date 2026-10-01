import { config } from '../config.js'

// 景别（shotType）口径的单一事实源。
// 三处共用：脚本/分镜提示词的档位枚举、产出归一（normalizeShotType）、出片英文映射（translateShotSize）。
// 换景别体系（比如改成英文本位或增删档位）只改这张表，三个调用点不动。

// 产线归一后的档位：脚本与分镜只允许产出这些值
export const CANONICAL_SHOT_TYPES = ['全景', '中景', '近景', '特写']

// 原始档位词（Skill §3 口径，含归一档位与中间档）——表头解析与提示词枚举共用
export const SHOT_TYPE_TERMS = [
  '大远景', '远景', '大全景', '中全景', '全景', '中景', '中近景', '近景', '特写', '大特写',
]

// 提示词里给模型的档位枚举串（如「大远景/远景/…/大特写」）
export const shotTypeTermsText = (sep = '/') => SHOT_TYPE_TERMS.join(sep)

// 九档原始口径（Skill §3）与常见别名 → 归一档位
export const SHOT_TYPE_MERGE = {
  '大远景': '全景',
  '远景': '全景',
  '大全景': '全景',
  '中全景': '全景',
  '远全': '全景',
  '广角': '全景',
  '中近景': '近景',
  '中近': '近景',
  '半身': '近景',
  '大特写': '特写',
  '极特': '特写',
  '微距': '特写',
}

// 未命中任何档位时的兜底档位（可在 .env 用 STORYBOARD_DEFAULT_SHOT_TYPE 覆盖）
export const defaultShotType = () => config.storyboard?.defaultShotType || CANONICAL_SHOT_TYPES[1]

// 归一：命中档位表 → 归并表 → 语义子串 → 兜底
export function normalizeShotType(raw) {
  const t = String(raw || '').trim()
  if (CANONICAL_SHOT_TYPES.includes(t)) return t
  if (SHOT_TYPE_MERGE[t]) return SHOT_TYPE_MERGE[t]
  // 子串兜底：优先匹配更长/更具体的档位语义
  if (t.includes('特写')) return '特写'
  if (t.includes('近')) return '近景'
  if (t.includes('远') || t.includes('全')) return '全景'
  return defaultShotType()
}

// 九档 / 别名的英文映射（对齐出片模型的官方景别词）
export const SHOT_SIZE_MAP = {
  '大远景': 'extreme long establishing shot',
  '远景': 'long establishing shot',
  '大全景': 'extreme wide shot',
  '全景': 'wide shot',
  '中全景': 'medium-wide shot',
  '中景': 'medium shot',
  '中近景': 'medium close-up',
  '近景': 'medium close-up',
  '特写': 'close-up',
  '大特写': 'extreme close-up',
}

export function translateShotSize(cn) {
  const key = String(cn || '').trim()
  return SHOT_SIZE_MAP[key] || SHOT_SIZE_MAP[defaultShotType()] || 'medium shot'
}
