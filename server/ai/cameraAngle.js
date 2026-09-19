
export const CAMERA_ANGLES = ['正面', '侧面', '背面', '过肩', '俯拍', '仰拍']


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


