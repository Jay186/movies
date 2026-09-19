
const SHOT_TYPE_EN = {
  大远景: 'extreme wide establishing shot',
  远景: 'wide establishing shot',
  全景: 'wide establishing shot, full body view',
  中景: 'medium shot',
  中近景: 'medium close-up',
  近景: 'medium close-up',
  特写: 'close-up',
  大特写: 'extreme close-up',
}
const CAMERA_EN = {
  固定: 'static camera',
  推近: 'the camera pushes in slowly',
  推: 'the camera pushes in slowly',
  拉远: 'the camera pulls back slowly',
  拉: 'the camera pulls back slowly',
  跟拍: 'tracking shot following the subjects',
  摇: 'panning shot',
  移: 'tracking movement',
  升降: 'crane movement',
}


export const ASSET_NEGATIVE_PHRASE =
  'no people, no characters, no animals, no hands, no creatures, empty scene, 无人物, 无角色, 无动物'

export const ELEMENT_WEIGHT = 1.35

export const ELEMENT_NOTE_TAG = '【本场必须可见的要素】'
export const SHARED_ENV_NOTE_TAG = '【同空间共有环境】'

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

const CHARACTER_TERMS =
  /角色|人物|主角|配角|萌宠|宠物|动物|男孩|女孩|小孩|儿童|小人|人偶|拟人|卡通形象|表情|神态|动作|造型|服装|皮肤|眼睛|五官|头身|四肢|全身|可爱度|Q版|豆豆眼|mascot|character|person|human|animal|cute|chibi|kawaii|full.?body|face|eye/i

const SAFE_STYLE_SECTIONS = ['色彩关键词', '配色', '光影关键词', '光影', '材质关键词', '材质', '环境关键词', '环境']

const STYLE_AMBIENT_TERMS =
  /自然天光|天光光影|自然光|环境光|氛围|色调|色温|晨光|晨雾|黄昏|日落|日出|傍晚|夜色|夜间|白昼|光线|光照|光影|柔光|暖光|冷光|氛围感|清新|治愈|明亮|温暖|欢快|轻快|暖色|冷色|饱和|mood|atmosphere|ambient|lighting|daylight|sunset|sunrise|dusk|dawn|night|tone|warmth|coolness|saturated|vibrant|bright|warm|cheerful|pastel/i

const STYLE_ANCHOR_TERMS =
  /笔触|笔法|笔意|笔刷|画笔|笔痕|线条|线稿|勾线|描边|肌理|质感|质地|材质|上色|涂色|叠色|铺色|色块|拼接|颗粒|纸纹|纸面|网点|纹理|版画|印刷|厚涂|薄涂|渲染|水彩|油画|水墨|粉彩|蜡笔|素描|brush|stroke|texture|canvas|paint|sketch|grain|hatch|ink|render/i

const STYLE_NEGATIVE_CLAUSE = /^\s*(避免|禁止|不要|不用|不宜|拒绝|规避|无|不)/

function filterStyleClauses(text) {
  return String(text || '')
    .split(/[，。；;,\n]/)
    .map((s) => s.trim())
    .filter((s) => s && !CHARACTER_TERMS.test(s))
    .join('，')
}

function filterAssetStyleClauses(text) {
  return String(text || '')
    .split(/[，。；;,\n]/)
    .map((s) => s.trim())
    .filter((s) => {
      if (!s) return false
      if (CHARACTER_TERMS.test(s)) return false 
      if (STYLE_AMBIENT_TERMS.test(s) && !STYLE_ANCHOR_TERMS.test(s) && !STYLE_NEGATIVE_CLAUSE.test(s)) return false
      return true
    })
    .join('，')
}

function extractAssetStyle(stylePrompt) {
  if (!stylePrompt) return ''
  const parts = String(stylePrompt).split(/(色彩关键词|配色|光影关键词|光影|材质关键词|材质|环境关键词|环境|镜头关键词|核心描述|镜头)[：:]/)
  if (parts.length > 1) {
    const head = filterAssetStyleClauses(parts[0]) 
    const kept = []
    for (let i = 1; i < parts.length; i += 2) {
      const label = parts[i]
      const text = parts[i + 1] || ''
      if (SAFE_STYLE_SECTIONS.includes(label)) {
        const t = filterAssetStyleClauses(text)
        if (t) kept.push(t)
      }
    }
    const joined = [head, ...kept].filter(Boolean).join('，')
    if (joined.trim()) return joined
  }
  return filterAssetStyleClauses(stylePrompt)
}

export function resolveAssetStyleText(stylePrompt, styleLabel) {
  const full = String(stylePrompt || '').trim()
  const label = String(styleLabel || '').trim()
  if (full && full !== label) return full
  return full || label
}

const LIGHT_COLD_ENV = /冰|雪|霜|寒|凛|冻|雾|frozen|ice|snow|cold|chill|mist|fog|frost|haze/i
const LIGHT_WARM_ENV = /黄昏|日落|夕阳|傍晚|暖光|温暖|暖|金黄|蜜色|金光|sunset|dusk|golden|warm|amber|honey/i
const LIGHT_COLD_TONE = /cold|cool|blue|icy|grey|gray|desaturat|wintry|polar|steel|frost|frozen|冷|蓝灰|青灰|冷冽|冷调/i
const LIGHT_WARM_TONE = /warm|golden|sunlit|amber|sunny|gilded|honey|温暖|暖|金黄|金/i

function lightingConflictsWithScene(summary, lightingEn) {
  const s = String(summary || '').trim()
  const l = String(lightingEn || '').trim()
  if (!s || !l) return false
  const coldEnv = LIGHT_COLD_ENV.test(s)
  const warmEnv = LIGHT_WARM_ENV.test(s)
  const coldTone = LIGHT_COLD_TONE.test(l)
  const warmTone = LIGHT_WARM_TONE.test(l)
  if (coldEnv && warmTone && !coldTone) return true
  if (warmEnv && coldTone && !warmTone) return true
  return false
}

export function buildAssetImagePrompt(type, p = {}) {
  const {
    description = '', name = '', stylePrompt = '', styleLabel = '', excludeProps = [],
    lightingEn = '', spatialRole = '', elements = [], sharedEnv = [],
  } = p
  const desc = String(description || '').trim()
  const guardLabel = (type === 'character' || !CHARACTER_TERMS.test(styleLabel)) ? styleLabel : ''
  const guard = guardLabel
    ? `。【画风统一约束】整幅画面风格统一为「${guardLabel}」画风，线条、上色、光影、质感与上述画面描述完全一致，禁止偏离画风。`
    : '。整幅画面风格、线条、上色、光影、质感与上述画面描述完全一致，禁止偏离。'

  if (type === 'character') {
    const nameTag = name ? `【${name}】` : ''
    const styleText = stylePrompt || ''
    return `(${desc}:1.2)，角色标准三视图设定稿（character turnaround sheet），纯白背景，${nameTag}${styleText}。` +
      `画面为该角色同一形象的「正面、侧面、背面」三个视角，从左到右依次并排排列（正面 → 侧面/3/4 侧身 → 背面）；` +
      `三个视角为同一个角色，体型比例、毛色、五官、服装、配色、画风完全一致，姿势端正、双臂自然下垂的中性站姿，无动作、无夸张表情。` +
      `纯白背景，无场景、无道具、无文字、无其他人物${guard}`
  }

  const style = extractAssetStyle(resolveAssetStyleText(stylePrompt, styleLabel))
  if (type === 'scene') {
    const excludeNote = (excludeProps || []).length
      ? `。画面中不出现${excludeProps.join('、')}等可移动道具，这些道具由独立设定图统一提供`
      : ''
    const effectiveLightingEn = lightingEn && !lightingConflictsWithScene(desc, lightingEn) ? lightingEn : ''
    const lightingNote = effectiveLightingEn
      ? `（本场景光照常量：${effectiveLightingEn}）本画面的时间、光线方向与色调以该光照常量与场景描述为准，画风只统一笔触、上色与线条质感，不改变本场景既定光照。`
      : `本画面的时间、光线方向与色调以场景描述为准，画风只统一笔触、上色与线条质感，不改变本场景既定光照。`
    const roleNote = String(spatialRole || '').trim()
      ? `【本场机位】${String(spatialRole).trim()}——画面必须体现这个视角与机位高度，` +
        `与同空间的其它视角区分开，不得照搬任何参考图或基准图的构图。`
      : ''
    const elementNote = buildElementNote(elements)
    const sharedEnvNote = buildSharedEnvNote(sharedEnv)
    return `(空无一人的${name || '场景'}环境空镜头：1.3)，${roleNote}(${desc}:1.2)，${name ? `【${name}】` : ''}，${style}。` +
      `${elementNote}${sharedEnvNote}` +
      `画面只呈现场景环境与陈设，无角色、无人物、无动物${excludeNote}。` +
      `${lightingNote}` +
      `${ASSET_NEGATIVE_PHRASE}${guard}`
  }

  return `(${desc}:1.2)，道具特写，纯白背景，${name ? `【${name}】` : ''}，${style}。画面中只有该道具这一个物体，纯白背景，道具居中占据画面主体，无人物、无动物、无人手。${ASSET_NEGATIVE_PHRASE}${guard}`
}
