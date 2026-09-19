
export const CAMERA_ANGLES = ['正面', '侧面', '背面', '过肩', '俯拍', '仰拍']

import { hasDialogue } from './dialogue.js'

const BACK_ANGLE_HINTS = [
  '顺着视线', '顺着目光', '顺着小熊的视线',
  '过肩', '背对', '背影', '背身',
  '望向画面深处', '望向远处', '望向雪原远端', '望向白熊',
  '盯着...的背影', '盯着背影', '回头看', '回望',
]

const FRONT_ONLY_FEATURES = [
  '黑点小眼', '粉腮红', '奶黄腮红', '腮红', '粉嘴鼻', '嘴鼻',
  '小领结', '领结', '眼睛', '眼神',
]

const isBackAngle = (angle) => angle === '背面' || angle === '过肩'

export function inferAngleFromText(text) {
  if (!text) return null
  for (const hint of BACK_ANGLE_HINTS) {
    if (text.includes(hint)) return '背面'
  }
  return null
}

export function angleFilterAppearance(appearance, cameraAngle) {
  const text = String(appearance || '').trim()
  if (!text) return ''
  if (!isBackAngle(cameraAngle)) return text
  const parts = text.split(/[、,，;；]/).map((p) => p.trim()).filter(Boolean)
  const kept = parts.filter((p) => !FRONT_ONLY_FEATURES.some((f) => p.includes(f)))
  return kept.length ? kept.join('、') : text
}

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

export function validateCameraAngle(shot = {}, opts = {}) {
  const errors = []
  const warnings = []
  const label = shot.shot_number || shot.shotNumber || shot.id || 'unknown'
  const angle = String(shot.camera_angle || '').trim()
  const texts = [shot.description, shot.camera_movement, shot.action_note]
    .filter(Boolean).join(' ')

  if (!angle) {
    errors.push(`镜头 ${label}：camera_angle 为空，必须输出机位朝向（正面/侧面/背面/过肩/俯拍/仰拍六选一）`)
    return { errors, warnings }
  }
  if (!CAMERA_ANGLES.includes(angle)) {
    errors.push(`镜头 ${label}：camera_angle="${angle}" 非法，取值限定 ${CAMERA_ANGLES.join('/')}`)
    return { errors, warnings }
  }

  const inferred = inferAngleFromText(texts)
  if (inferred === '背面' && angle === '正面') {
    errors.push(
      `镜头 ${label}：描述/运镜含背面语义（"${texts.slice(0, 40)}..."），但 camera_angle="正面"。`
      + '二者冲突会让 H3 首帧锚定错朝向。请把 camera_angle 改为 背面/过肩，或改描述/运镜。'
    )
  }

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
