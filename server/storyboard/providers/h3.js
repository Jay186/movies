import { config } from '../../config.js'
import { identityFeatures } from '../../ai/shared.js'

// 7000 是 MiniMax 官方硬性上限，非经验值（2026-09-27 复核属实）：
// 官方 API 文档《Video Generation》→ Model Specs & Input Requirements → Input Requirements
// 表格明文「Prompt length limit | ≤ 7000 characters」（模型 MiniMax-H3，端点 /v2/video_generation）。
// 官方只给了上限，未说明超限行为（无错误码、也未声明截断）——故出片侧按硬阻断处理，
// 宁可本镜失败重来，也不赌「静默截断丢内容」。可用 h3PromptCharLimit 覆盖，但勿高于 7000。
const promptCharLimit = config.storyboard?.h3PromptCharLimit ?? 7000

export const h3ProviderProfile = Object.freeze({
  id: 'h3',
  label: 'MiniMax H3',
  capabilities: Object.freeze({
    promptCharLimit,
    promptWarnRatio: 0.9,
    promptOverheadChars: 2000,
    durationMin: config.storyboard?.durationMin ?? 4,
    durationMax: config.storyboard?.durationMax ?? 15,
  }),
  // （原 checks 能力块随 QC 整体移除：2026-09-26。Provider 差异改由 capabilities（字符上限/时长范围）
  //  与 lexicons（方言词表）表达——两者均有真实消费方；「启用哪些检查」属 QC 判定层，不再由 Provider 声明。）
  lexicons: Object.freeze({
    cameraMove: Object.freeze({
      static: ['static', 'locked', 'fixed', 'holds', 'held'],
      push_in: ['push in', 'push-in', 'zoom in', 'zoom-in', 'dolly in', 'push forward'],
      pull_back: ['pull back', 'pull-back', 'pull out', 'pull-out', 'zoom out', 'dolly out'],
      pan: ['pan left', 'pan right', 'pans', 'panning', 'gentle pan'],
      tilt: ['tilt up', 'tilt down', 'camera tilts', 'tilt shot'],
      tracking: ['tracking shot', 'tracking', 'follow shot', 'follows'],
      orbit: ['orbit', 'orbiting', 'circles', 'circle around', 'arcs around'],
      crane: ['crane up', 'crane down', 'crane shot', 'jib'],
    }),
    musicMoodZh: Object.freeze(['不安', '紧张', '悬疑', '温暖', '悲伤', '欢快', '恐怖', '浪漫', '感动',
      '治愈', '绝望', '孤独', '恐惧', '喜悦', '忧伤', '悲壮', '热血', '温馨', '压抑', '激昂', '深情',
      '甜蜜', '苦涩', '心碎', '寂寥', '苍凉', '欣慰', '振奋', '忐忑', '焦躁', '神圣', '肃穆', '明媚',
      '阴森', '诡异', '悲凉', '悸动', '空灵', '磅礴', '温柔']),
    musicMoodEn: Object.freeze(['tense', 'warm', 'sad', 'happy', 'romantic', 'exciting', 'emotional',
      'moving', 'heartwarming', 'horror', 'suspense', 'joyful', 'gloomy', 'hopeful', 'despair', 'eerie',
      'uplifting', 'sorrowful', 'triumphant', 'melancholy']),
  }),
})

export const CAMERA_MOVE_LEXICON = h3ProviderProfile.lexicons.cameraMove

export function findH3MusicMoodWords(musicText) {
  const music = String(musicText || '')
  if (!music.trim()) return []
  const lower = music.toLowerCase()
  return h3ProviderProfile.lexicons.musicMoodZh.filter((word) => music.includes(word))
    .concat(h3ProviderProfile.lexicons.musicMoodEn.filter((word) => lower.includes(word)))
}

export function estimateH3RefsPromptCost(shot, ctx = {}) {
  const names = (value) => Array.isArray(value) ? value.map((v) => String(v || '').trim()).filter(Boolean) : []
  const charNames = names(shot.characters)
  const sceneNames = names(shot.sceneAssets || shot.scene_assets)
  const propNames = names(shot.propAssets || shot.prop_assets)
  const total = charNames.length + sceneNames.length + propNames.length
  if (!total) return 0

  const REF_TEMPLATE_COST = 230
  // 资产描述在 prompt 里出现几次、各按什么长度计：
  //   subject_definitions 份：默认 identityFeatures 压缩（官方「main features」口径），
  //     h3SubjectFullDesc=1 时完整原文；
  //   retention_analysis 份：默认不重复（官方 ref-en §4 只要求 "preserve the meaning
  //     established"，重复整段 descEn 是纯冗余），h3RetentionFullDesc=1 时完整原文。
  // 两个开关独立计费——半开组合（retention 开、subject 关）下旧式 ×2 会把 retention 份
  // 也按压缩长度计，比实际出片（完整原文）少估。此前恒取 2 的旧账：3 角色 + 1 场景的镜
  // 实测参考素材 2561 字符，估算 5878（实锤 #1-1：估算 8194 / 实测 5877）——估算必须
  // 与出片同口径，这是它的全部意义。
  // 注：道具「本镜状态」（stateEn）走 retention 的 partially_preserved 句，估算吃不到
  // asset_states（ctx.assetNames 无状态字段），维持不计（宁少估这一小项，不引入跨表查询）。
  const retentionRepeat = config.video?.h3RetentionFullDesc ? 1 : 0
  // 出片侧 subject_definitions 只写官方「main features to follow」（identityFeatures 压缩），
  // 估算必须同口径——否则估算仍按完整外观（478-660 字符/条）计，比实际出片高出 2000+，
  // 会把本不超限的镜误判成超限。
  const featureLen = (s) => (config.video?.h3SubjectFullDesc ? String(s || '') : identityFeatures(s)).length
  const descCost = (raw) => {
    const s = String(raw || '')
    if (!s) return 0
    return featureLen(s) + retentionRepeat * s.length
  }
  const SCENE_LIGHTING_COST = 110
  const CHAR_MULTIVIEW_COST = 130
  const REF_FALLBACK_COST = 850
  const assets = ctx?.assetNames
  if (!assets) return total * REF_FALLBACK_COST

  const findRow = (rows, name) => (rows || []).find((row) =>
    typeof row === 'string' ? row === name : row.title === name || row.name === name)
  let cost = 0
  for (const name of charNames) {
    const row = findRow(assets.characters, name)
    const descriptionCost = row && typeof row !== 'string'
      ? descCost(row.description_en || row.description || row.appearance || '')
      : 0
    cost += descriptionCost
      ? REF_TEMPLATE_COST + descriptionCost + CHAR_MULTIVIEW_COST
      : REF_FALLBACK_COST
  }
  for (const name of sceneNames) {
    const row = findRow(assets.scenes, name)
    if (row && typeof row !== 'string' && row.scene_number != null && ctx?.sceneNumber != null
      && Number(row.scene_number) !== Number(ctx.sceneNumber)) continue
    const descriptionCost = row && typeof row !== 'string'
      ? descCost(row.description_en || row.summary_en || row.description || row.summary || '')
      : 0
    const lightingLength = row && typeof row !== 'string' ? String(row.lighting_en || '').length : 0
    cost += (descriptionCost || lightingLength)
      ? REF_TEMPLATE_COST + descriptionCost + (lightingLength ? SCENE_LIGHTING_COST + lightingLength : 0)
      : REF_FALLBACK_COST
  }
  for (const name of propNames) {
    const row = findRow(assets.props, name)
    const descriptionCost = row && typeof row !== 'string'
      ? descCost(row.description_en || row.description || '')
      : 0
    cost += descriptionCost ? REF_TEMPLATE_COST + descriptionCost : REF_FALLBACK_COST
  }
  return cost
}

export function estimateH3ShotVideoPromptChars(shot, ctx = {}) {
  const dialogueTextLen = (dialogue) => {
    if (dialogue == null) return 0
    let value = dialogue
    if (typeof value === 'string') {
      const text = value.trim()
      if (!text || text === 'null') return text.length
      try { value = JSON.parse(text) } catch { return text.length }
    }
    if (Array.isArray(value)) return value.reduce((sum, item) => sum + String(item?.text || '').length, 0)
    if (typeof value === 'object') return String(value.text || '').length
    return 0
  }
  const fieldTotal =
    String(shot.description || '').length +
    String(shot.actionNote || shot.action_note || '').length +
    String(shot.finalFrame || shot.final_frame || '').length +
    String(shot.overallSoundscape || shot.overall_soundscape || '').length +
    String(shot.nonDiegeticMusic || shot.non_diegetic_music || '').length +
    String(shot.cameraMovement || shot.camera_movement || '').length +
    String(shot.shotType || shot.shot_type || '').length +
    dialogueTextLen(shot.dialogue)
  const refsCost = estimateH3RefsPromptCost(shot, ctx)
  return {
    fieldTotal,
    refsCost,
    estimated: fieldTotal + h3ProviderProfile.capabilities.promptOverheadChars + refsCost,
  }
}
