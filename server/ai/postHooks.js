const HARD_CUT_TRANSITION_RE = /^(cut|切|切镜|跳切|hard.?cut)$/i
// 只识别 xiaomo-film-studio 明确表达的视觉承接语义。
// 音桥属于声音先行，不代表画面沿用上一镜尾帧，因此不在此列。
const CONTINUITY_TRANSITION_RE = /^(continue|continuity|carry|match.?cut|soft.?continuity|action.?match|eyeline.?match|graphic.?match|visual.?bridge|承接|连续承接|软接续|视桥|动作匹配(?:切)?|视线匹配|图形匹配|匹配切)$/i

export function isHardCutTransition(value) {
  return HARD_CUT_TRANSITION_RE.test(String(value || '').trim())
}

export function isContinuityTransition(value) {
  return CONTINUITY_TRANSITION_RE.test(String(value || '').trim())
}

// 尾帧接力必须由分镜明确声明。空值不再被平台解释为连续承接，
// 因为空值也可能只是原始分镜没有填写转场字段；此时应让 H3 按本镜
// 的构图和资产自主生成。跨场/同场均由同一个字段决定，不追加平台语义。
export function shouldCarryContinuityToNextShot(nextShot) {
  if (isHardCutTransition(nextShot?.transition_in ?? nextShot?.transitionIn)) return false
  return isContinuityTransition(nextShot?.transition_in ?? nextShot?.transitionIn)
}
