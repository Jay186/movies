// 资产图（场景/道具/角色）画风文本过滤器。
// 与 src/services/promptBuilder.js 中的同款逻辑是同一份实现的两份拷贝（前后端无法互相 import），
// 修改任何一边必须同步另一边。
//
// 用途：画风全文（style_presets.prompt）里混着多个维度的描述（人物外貌、镜头语言、背景空间、色彩材质），
// 不同资产类型要的维度不同，直接整段拼进提示词会互相打架：
//   - 场景空镜头/道具特写：剔除人物维度（空场景不该出现角色特征）
//   - 角色三视图：剔除环境/镜头维度（纯白背景标准站姿，不能被镜头语言和背景空间带跑）
// 只保留色彩/光影/材质/环境等"安全段落"与带笔触/材质锚点的句子，否定句（避免XX）保留。

// 人物维度词：场景/道具图要剔除
const CHARACTER_TERMS =
  /角色|人物|主角|配角|萌宠|宠物|动物|男孩|女孩|小孩|儿童|小人|人偶|拟人|卡通形象|表情|神态|动作|造型|服装|皮肤|肤色|发色|发型|发丝|睫毛|眉毛|腮红|瞳孔|身材|体态|眼睛|五官|头身|四肢|全身|可爱度|Q版|豆豆眼|mascot|character|person|human|animal|cute|chibi|kawaii|full.?body|face|eye/i

// 环境/镜头维度词：角色三视图要剔除
const ENV_SHOT_TERMS =
  /环境|背景|场景|空间|室内|室外|街|城市|建筑|房屋|墙面|地面|天空|天气|季节|道具|陈设|家具|镜头|景深|特写|构图|机位|视角|氛围元素|environment|background|scene|space|indoor|outdoor|street|city|building|wall|floor|sky|weather|season|prop|furniture|lens|depth|close.?up|composition|camera/i

// 画风提示词的段落标签：长名必须排在短名之前——split 的交替捕获按顺序匹配，
// 短名在前会把「环境关键词」截成「环境」+「关键词」，段落白名单随即失配。
// 新增/改名只改这里（src/services/promptBuilder.js 有同款定义，需同步）。
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

// 散句过滤（无标签的头部或整段无结构文本）：维度词 + 氛围词双重过滤
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
export function extractAssetStyle(stylePrompt) {
  return extractStyleSections(stylePrompt, SCENE_SAFE_SECTIONS, CHARACTER_TERMS)
}

// 角色图：剔除环境/镜头维度
export function extractCharacterStyle(stylePrompt) {
  return extractStyleSections(stylePrompt, CHARACTER_SAFE_SECTIONS, ENV_SHOT_TERMS)
}
