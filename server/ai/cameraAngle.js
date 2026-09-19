// 机位朝向一致性校验（防线③：出片前拦截）。
// 背景：1-1「顺着小熊的视线推近」成片却是正面。根因是"朝向"只存在于描述文字里，
// 没有结构化字段，LLM 自由发挥后无校验可拦——分镜图正面、角色卡又是正面特征，三层都往正面拉。
// 本模块把"朝向"变成可断言的数据：出片前检查 camera_angle 与运镜语义、角色文案视角是否一致。
// 职责边界：只做校验 + 按朝向裁剪角色描述，不生成、不改写剧本内容。

// 机位朝向六选一（与 storyboardRules.cameraAngleRule 保持一致）
export const CAMERA_ANGLES = ['正面', '侧面', '背面', '过肩', '俯拍', '仰拍']

// 台词有无判据单点（2026-09-18 P0-3）：shots.dialogue 契约是 JSON 数组，但库里存在
// 4 字符字符串 "null"（历史写入 bug），此前本文件就地写 `String(dlg) !== 'null' && !== '[]'`
// 兜底——那种写法漏一个就出事，且与另外四处特判各自漂移。统一从 dialogue.js 走。
import { hasDialogue } from './dialogue.js'

// 背面/过肩语义关键词：描述或运镜里出现这些，镜头就该是背面/过肩，禁止"正面"
const BACK_ANGLE_HINTS = [
  '顺着视线', '顺着目光', '顺着小熊的视线',
  '过肩', '背对', '背影', '背身',
  '望向画面深处', '望向远处', '望向雪原远端', '望向白熊',
  '盯着...的背影', '盯着背影', '回头看', '回望',
]

// 正面专属特征词：背面/过肩镜头里物理上不可见，角色描述里出现它们会诱导模型转正面
const FRONT_ONLY_FEATURES = [
  '黑点小眼', '粉腮红', '奶黄腮红', '腮红', '粉嘴鼻', '嘴鼻',
  '小领结', '领结', '眼睛', '眼神',
]

const isBackAngle = (angle) => angle === '背面' || angle === '过肩'

/**
 * 从文本推断期望朝向。返回 '背面' 表示文本语义要求背向镜头；否则返回 null（不武断推断）。
 */
export function inferAngleFromText(text) {
  if (!text) return null
  for (const hint of BACK_ANGLE_HINTS) {
    if (text.includes(hint)) return '背面'
  }
  return null
}

/**
 * 按朝向裁剪角色描述：背面/过肩镜头剔除正面专属特征（五官/腮红/领结），
 * 避免 Gemini 优化器为了描述这些特征而把角色拉回正面。
 * @param {string} appearance 角色外观描述（顿号/逗号分隔）
 * @param {string} cameraAngle 机位朝向
 * @returns {string} 裁剪后的描述；非背面镜头原样返回
 */
export function angleFilterAppearance(appearance, cameraAngle) {
  const text = String(appearance || '').trim()
  if (!text) return ''
  if (!isBackAngle(cameraAngle)) return text
  const parts = text.split(/[、,，;；]/).map((p) => p.trim()).filter(Boolean)
  const kept = parts.filter((p) => !FRONT_ONLY_FEATURES.some((f) => p.includes(f)))
  return kept.length ? kept.join('、') : text
}

/**
 * 生成朝向注入文案：把 camera_angle 翻译成一句明确的朝向约束，追加进 idea 供 Gemini 优化器扩写时遵守。
 * 正面镜头返回空串（无需额外约束）。背面/过肩镜头必须显式声明，否则优化器会默认按正面扩写。
 */
export function angleInjection(angle) {
  const map = {
    '背面': '镜头为背面视角，角色全程背对镜头、不转向镜头、不露脸、不看向观众，眼神始终望向画面深处。',
    '过肩': '镜头为过肩视角，从角色身后拍摄，画面只出现角色后脑勺与画面深处的目标，角色全程保持背对镜头。',
    '侧面': '镜头为侧面视角，角色侧脸朝向画面深处，全程不转向镜头。',
    '俯拍': '镜头为俯拍视角，自上而下拍摄。',
    '仰拍': '镜头为仰拍视角，自下而上拍摄。',
  }
  return map[angle] || ''
}

/**
 * 机位朝向一致性校验。
 * @param {object} shot { camera_angle, description, camera_movement, action_note, shot_number, characters }
 * @param {object} opts { charDescriptions?: Array<string> } 出场角色的 appearance/description 列表（用于正面特征冲突检测）
 * @returns {{ errors: string[], warnings: Array<{code:string, shot:string, message:string}> }}
 */
export function validateCameraAngle(shot = {}, opts = {}) {
  const errors = []
  const warnings = []
  const label = shot.shot_number || shot.shotNumber || shot.id || 'unknown'
  const angle = String(shot.camera_angle || '').trim()
  const texts = [shot.description, shot.camera_movement, shot.action_note]
    .filter(Boolean).join(' ')

  // 1) 字段缺失：未输出朝向字段，一致性无从保证
  if (!angle) {
    errors.push(`镜头 ${label}：camera_angle 为空，必须输出机位朝向（正面/侧面/背面/过肩/俯拍/仰拍六选一）`)
    return { errors, warnings }
  }
  if (!CAMERA_ANGLES.includes(angle)) {
    errors.push(`镜头 ${label}：camera_angle="${angle}" 非法，取值限定 ${CAMERA_ANGLES.join('/')}`)
    return { errors, warnings }
  }

  // 2) 运镜语义冲突：描述/运镜要求背面，camera_angle 却写正面
  const inferred = inferAngleFromText(texts)
  if (inferred === '背面' && angle === '正面') {
    errors.push(
      `镜头 ${label}：描述/运镜含背面语义（"${texts.slice(0, 40)}..."），但 camera_angle="正面"。`
      + '二者冲突会让 H3 首帧锚定错朝向。请把 camera_angle 改为 背面/过肩，或改描述/运镜。'
    )
  }

  // 3) 角色文案视角冲突：背面镜头却塞了正面专属特征
  const chars = opts.charDescriptions || []
  const offenders = chars.filter((d) => d && FRONT_ONLY_FEATURES.some((f) => d.includes(f)))
  if (isBackAngle(angle) && offenders.length) {
    warnings.push({
      code: 'CAMERA_ANGLE_FRONT_FEATURE',
      shot: label,
      message:
        `镜头 ${label}：camera_angle="${angle}"，但角色描述含正面专属特征「${offenders.slice(0, 3).join('、')}」。`
        + '背面镜头看不见五官/腮红/领结，Gemini 优化器会为了描述这些特征把角色拉回正面。'
        + '请用 angleFilterAppearance 裁剪角色描述。',
    })
  }

  // 4) 背面/过肩 + 台词冲突
  const hasDlg = hasDialogue(shot.dialogue)
  if (isBackAngle(angle) && hasDlg) {
    warnings.push({
      code: 'CAMERA_ANGLE_BACK_WITH_DIALOGUE',
      shot: label,
      message:
        `镜头 ${label}：camera_angle="${angle}" 但有台词。背面镜头看不到口型，H3 为对口型会把角色拉回正面。`
        + '两条路：台词改为画外音/心声（idea 里注明"角色背面、不露口型、台词为心声"），或 camera_angle 改为 侧面。',
    })
  }

  return { errors, warnings }
}
