

export const SPATIAL_ANCHOR_TYPE = 'spatial'

export const SCENE_ANCHOR_TYPE = 'scene'

export const PROP_ANCHOR_TYPE = 'prop'

export const LAYOUT_ANCHOR_TYPE = 'layout'

export const SPATIAL_SERIES_ANCHOR_TYPES = ['scene', SPATIAL_ANCHOR_TYPE, LAYOUT_ANCHOR_TYPE]

export function isSpatialSeriesAnchor(anchor) {
  return SPATIAL_SERIES_ANCHOR_TYPES.includes(String(anchor?.type || ''))
}

export const REVIEW_STATUS = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  SKIPPED: 'skipped',
}


export const REVIEW_ACTION = {
  CONFIRM: 'confirm',
  SKIP: 'skip',
}


export function normalizeElementPhrase(x) {
  return String(x ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[。．.；;，,、;:！!？?~～\-—－]+$/, '')
    .trim()
    .slice(0, 24)
}

export function parseElementList(raw) {
  let arr = []
  try {
    const v = JSON.parse(raw || '[]')
    arr = Array.isArray(v) ? v : []
  } catch {
    return []
  }
  const seen = new Set()
  const out = []
  for (const item of arr) {
    const s = normalizeElementPhrase(item)
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

export const ELEMENT_WEIGHT = 1.35

export const ELEMENT_NOTE_TAG = '【本场必须可见的要素】'
export const SHARED_ENV_NOTE_TAG = '【同空间共有环境】'

export function buildElementNote(elements) {
  const list = Array.isArray(elements) ? elements.filter(Boolean) : []
  if (!list.length) return ''
  return `${ELEMENT_NOTE_TAG}(以下每一项都必须在画面中明确可见，不得省略或替换：${list.join('、')}：${ELEMENT_WEIGHT})。`
}

export function buildSharedEnvNote(sharedEnv) {
  const list = Array.isArray(sharedEnv) ? sharedEnv.filter(Boolean) : []
  if (!list.length) return ''
  return `${SHARED_ENV_NOTE_TAG}(本场景与同空间的其它场景共享以下环境特征，必须一致：${list.join('、')}：${ELEMENT_WEIGHT})。`
}



export const LAYOUT_ANCHOR_HINT =
  '本空间的「布局示意图」已作为参考图提供（该图是俯视/轴测的示意画法，只表达位置关系，不是画面效果图）：' +
  '本场景中各物体的**相对位置、朝向、彼此距离比例**必须与布局图一致；' +
  '但该图**不约束**本画面的视角、机位高度、景别、光影、时段、天气、色温、画风、材质与画面主体占比——' +
  '这些一律以本场景文字描述为准。' +
  '严禁把布局图的俯视/轴测画法当作本画面的视角，也严禁照搬它的示意画风。'

export const LAYOUT_IMAGE_SUBJECT = '空间布局示意图'

export const LAYOUT_IMAGE_NEGATIVE =
  '画面为纯图形化的等轴测或斜俯视空间关系示意图，是美术设计用的平面示意，不是摄影作品、不是场景效果图。' +
  '⚠️ 画面中**绝对不要出现任何文字、汉字、字母、数字、标签、注记、标题、题注**——' +
  '常见的"示意图带名称标注"范式在这里是错的，被标注的物体用图形本身表达即可，不要用文字指认。' +
  '不要出现图例框、比例尺、指北针、箭头、指引线、坐标格、边框、眼睛/机位图标或任何符号标记。' +
  '不要出现任何角色、人物、动物（包括本片主角），也不要画雪地脚印、足迹或任何暗示角色在场的痕迹。' +
  '不要新增未被列出的物体（不要自行添加树木、花草动物、建筑、器物）。' +
  '不要画天空、不要画地平线、不要画光照氛围与光线方向、不要表现色温或色调氛围。' +
  '不要画雾、云、水汽、雨、雪等任何大气现象，也不要画雪地反光、冰面高光或云絮质感——本图只表达地形与物体的平面位置和朝向。'
