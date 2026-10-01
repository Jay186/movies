
const ASSET_NEGATIVE_PHRASE =
  'no people, no characters, no animals, no hands, no creatures, empty scene, 无人物, 无角色, 无动物'

// 以下常量与函数在 server/ai/anchorTypes.js 有一份逐字相同的副本（server 端路由直接用那份做幂等追加，
// 两份的 TAG 文案是跨端去重协议的依据），修改任何一边必须同步另一边。
const ELEMENT_WEIGHT = 1.35

const ELEMENT_NOTE_TAG = '【本场必须可见的要素】'
const SHARED_ENV_NOTE_TAG = '【同空间共有环境】'

function buildElementNote(elements) {
  const list = Array.isArray(elements) ? elements.filter(Boolean) : []
  if (!list.length) return ''
  return `${ELEMENT_NOTE_TAG}(以下每一项都必须在画面中明确可见，不得省略或替换：${list.join('、')}：${ELEMENT_WEIGHT})。`
}

function buildSharedEnvNote(sharedEnv) {
  const list = Array.isArray(sharedEnv) ? sharedEnv.filter(Boolean) : []
  if (!list.length) return ''
  return `${SHARED_ENV_NOTE_TAG}(本场景与同空间的其它场景共享以下环境特征，必须一致：${list.join('、')}：${ELEMENT_WEIGHT})。`
}

// 人物维度词：场景/道具图要剔除（空场景不该出现角色特征）
const CHARACTER_TERMS =
  /角色|人物|主角|配角|萌宠|宠物|动物|男孩|女孩|小孩|儿童|小人|人偶|拟人|卡通形象|表情|神态|动作|造型|服装|皮肤|肤色|发色|发型|发丝|睫毛|眉毛|腮红|瞳孔|身材|体态|眼睛|五官|头身|四肢|全身|可爱度|Q版|豆豆眼|mascot|character|person|human|animal|cute|chibi|kawaii|full.?body|face|eye/i

// 环境/镜头维度词：角色三视图要剔除——三视图是纯白背景标准站姿，
// 画风文本里的镜头语言（浅景深特写、前景遮挡）与背景空间（夜景灯串、窗边、雨后街道）
// 会与「纯白背景、无场景、正视/侧视/背视并列」直接冲突，必须挡在门外。
const ENV_SHOT_TERMS =
  /环境|背景|场景|空间|室内|室外|街|城市|建筑|房屋|墙面|地面|天空|天气|季节|道具|陈设|家具|镜头|景深|特写|构图|机位|视角|氛围元素|environment|background|scene|space|indoor|outdoor|street|city|building|wall|floor|sky|weather|season|prop|furniture|lens|depth|close.?up|composition|camera/i

// 画风提示词的段落标签：长名必须排在短名之前——split 的交替捕获按顺序匹配，
// 短名在前会把「环境关键词」截成「环境」+「关键词」，段落白名单随即失配。
// 新增/改名只改这里（server/ai/assetStyleFilter.js 有同款定义，需同步）。
const STYLE_SECTION_LABELS = [
  '色彩关键词', '光影关键词', '材质关键词', '环境关键词', '镜头关键词', '核心描述',
  '配色', '光影', '材质', '环境', '镜头',
]
const STYLE_SECTION_SPLIT_RE = new RegExp(`(${STYLE_SECTION_LABELS.join('|')})[：:]`)

// 场景/道具图保留的段落：色彩、光影、材质、环境
const SCENE_SAFE_SECTIONS = ['色彩关键词', '配色', '光影关键词', '光影', '材质关键词', '材质', '环境关键词', '环境']
// 角色图保留的段落：色彩、光影、材质、核心描述（剔除镜头与环境两段）
const CHARACTER_SAFE_SECTIONS = ['色彩关键词', '配色', '光影关键词', '光影', '材质关键词', '材质', '核心描述']

const STYLE_AMBIENT_TERMS =
  /自然天光|天光光影|自然光|环境光|氛围|色调|色温|晨光|晨雾|黄昏|日落|日出|傍晚|夜色|夜间|白昼|光线|光照|光影|柔光|暖光|冷光|氛围感|清新|治愈|明亮|温暖|欢快|轻快|暖色|冷色|饱和|mood|atmosphere|ambient|lighting|daylight|sunset|sunrise|dusk|dawn|night|tone|warmth|coolness|saturated|vibrant|bright|warm|cheerful|pastel/i

const STYLE_ANCHOR_TERMS =
  /笔触|笔法|笔意|笔刷|画笔|笔痕|线条|线稿|勾线|描边|肌理|质感|质地|材质|上色|涂色|叠色|铺色|色块|拼接|颗粒|纸纹|纸面|网点|纹理|版画|印刷|厚涂|薄涂|渲染|水彩|油画|水墨|粉彩|蜡笔|素描|brush|stroke|texture|canvas|paint|sketch|grain|hatch|ink|render/i

const STYLE_NEGATIVE_CLAUSE = /^\s*(避免|禁止|不要|不用|不宜|拒绝|规避|无|不)/

// 「生成时需要把风格落实到……而不是只写风格名称」这类是写给生成流程看的元指令，不是画面描述，
// 对绘图模型是噪音。在按标签/顿号切分之前整句剔除，避免被切碎后残留半句
// （如「背景空间和整体画面气质中」这种没有主语、模型读不懂的残句）。
const STYLE_META_CLAUSE = /生成时需要|生成时把|而不是只写风格名称|只写风格名|需要把.{0,16}落实到/

function stripMetaClauses(text) {
  return String(text || '')
    .split(/[。；;\n]/)
    .map((s) => s.trim())
    .filter((s) => s && !STYLE_META_CLAUSE.test(s))
    .join('。')
}

// dropTermsRe：本类型不该出现的维度词（场景图传人物词、角色图传环境/镜头词）

// 散句过滤（无标签的头部或整段无结构文本）：维度词 + 氛围词双重过滤——
// 没有标签兜底时，纯氛围/光照虚词（朦胧情绪、温暖氛围）需要挡掉。
function filterStyleClauses(text, dropTermsRe) {
  return String(text || '')
    .split(/[，。；;,\n]/)
    .map((s) => s.trim())
    .filter((s) => {
      if (!s) return false
      if (dropTermsRe.test(s)) return false
      if (STYLE_AMBIENT_TERMS.test(s) && !STYLE_ANCHOR_TERMS.test(s) && !STYLE_NEGATIVE_CLAUSE.test(s)) return false
      return true
    })
    .join('，')
}

// 白名单段落内的过滤：只剔维度词，不再跑氛围词过滤——
// 段落既已被声明为可信，再叠一层氛围词过滤会把「柔暖色」「低饱和肤色」这类
// 色彩/材质核心词误删，导致资产图丢掉画风主体信息（光照冲突另有专门机制处理）。
// 这里额外把顿号也当分隔符：段内多个词以顿号并列，只该剔掉命中的那一个，
// 否则「柔暖色、低饱和肤色、淡蓝」里的「肤色」会连累整段色彩词一起丢失。
function filterSectionClauses(text, dropTermsRe) {
  return String(text || '')
    .split(/[，。；;,\n、]/)
    .map((s) => s.trim())
    .filter((s) => s && !dropTermsRe.test(s))
    .join('，')
}

function extractStyleSections(stylePrompt, safeSections, dropTermsRe) {
  if (!stylePrompt) return ''
  const src = stripMetaClauses(stylePrompt)
  if (!src) return ''
  const parts = src.split(STYLE_SECTION_SPLIT_RE)
  if (parts.length > 1) {
    const head = filterStyleClauses(parts[0], dropTermsRe)
    const kept = []
    for (let i = 1; i < parts.length; i += 2) {
      const label = parts[i]
      const text = parts[i + 1] || ''
      if (safeSections.includes(label)) {
        const t = filterSectionClauses(text, dropTermsRe)
        if (t) kept.push(t)
      }
    }
    const joined = [head, ...kept].filter(Boolean).join('，')
    if (joined.trim()) return joined
  }
  return filterStyleClauses(src, dropTermsRe)
}

// 场景/道具图：剔除人物维度
function extractAssetStyle(stylePrompt) {
  return extractStyleSections(stylePrompt, SCENE_SAFE_SECTIONS, CHARACTER_TERMS)
}

// 角色图：剔除环境/镜头维度（保留角色造型、服装、神态与色彩材质）
function extractCharacterStyle(stylePrompt) {
  return extractStyleSections(stylePrompt, CHARACTER_SAFE_SECTIONS, ENV_SHOT_TERMS)
}

function resolveAssetStyleText(stylePrompt, styleLabel) {
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
    // 角色三视图只保留色彩/光影/材质/造型维度，挡住画风文本里的镜头语言与背景空间
    // （浅景深特写、夜景灯串、雨后街道等），否则三视图会被带成特写构图或带回场景背景。
    // 过滤结果为空时回退原文，避免画风整个丢失。
    const styleText = extractCharacterStyle(stylePrompt || '') || stylePrompt || ''
    return `(${desc}:1.2)，角色标准三视图设定稿（character turnaround sheet），纯白背景，${nameTag}${styleText}。` +
      `画面为该角色同一形象的「正面、侧面、背面」三个视角，从左到右依次并排排列（正面 → 侧面/3/4 侧身 → 背面）；` +
      `三个视角为同一个角色，体型比例、五官、服装、配色、画风完全一致，姿势端正、自然放松的中性站姿，无动作、无夸张表情。` +
      `纯白背景，无场景、无道具、无文字、无其他人物${guard}`
  }

  const style = extractAssetStyle(resolveAssetStyleText(stylePrompt, styleLabel))
  if (type === 'scene') {
    const excludeNote = (excludeProps || []).length
      ? `。画面中不出现${excludeProps.join('、')}等可移动道具，这些道具由独立设定图统一提供`
      : ''
    // 组级光照常量（sharedEnv 中"光照｜"条目）是同组光照一致性的唯一事实源：
    // 它在场时场级 lightingEn 不得再自称"本场景光照常量"——历史上两个"常量"并存、
    // 模型按场级文本出图，导致同组场景光照各画各的（雪山窄道/崖边实证）。
    const groupLighting = (Array.isArray(sharedEnv) ? sharedEnv : [])
      .map((x) => String(x || '').trim())
      .find((x) => x.startsWith('光照｜'))
    const effectiveLightingEn = lightingEn && !groupLighting && !lightingConflictsWithScene(desc, lightingEn) ? lightingEn : ''
    const lightingNote = groupLighting
      ? `（本场景光照服从组级光照常量）本画面的光源方向、色温、受光面与背光面关系一律以【同空间共有环境】中的组级光照常量为准；场景描述仅在不与其冲突的范围内补充本场时段与大气细节；画风只统一笔触、上色与线条质感，不改变本场景既定光照。`
      : effectiveLightingEn
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
