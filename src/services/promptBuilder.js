// 视频生成 prompt 组装（从 stores/project.js 拆出的纯函数层）
// 这里只放不依赖 store 内部状态的纯函数：依赖（角色/场景/道具列表、画风文案）
// 通过 ctx 显式注入，保证本模块可独立测试、可被多端复用。
// 约束需与后端 ai/videoPrompt.js 保持同文。

// 【形象锁定约束】文字描述可能与参考图冲突（设定库快照过期/AI 整改自定义），显式声明参考图永远赢。
// 常用景别 → 英文（官方 detailed_description 用英文分镜术语）
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
// 常用运镜 → 英文
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

// ===================================================================
// A1 本场要素硬约束 / A2 组级环境卡（2026-09-17）
// ===================================================================
// ⚠️ 字面量耦合：以下三个函数必须与 server/ai/anchorTypes.js 的同名实现**逐字符一致**
//   （含全角标点与权重符号）。前后端分属两个 bundle 无法互相 import，故此处手工镜像，
//   由 server/tests/sceneElements.test.mjs 的「跨端静态断言」逐字比对守护——改一边必炸测试。
// 为什么需要它们：场1 摘要写了"清晨浓雾"、出图是晴空；场2 摘要没提植被、整片秃。
//   这两件事的共同根因是「摘要里明文写了的事实」被 1.2 权重的长描述当作氛围形容词淡化了。
//   解法是把它们抽成清单、加权成独立句（1.35 > 长描述 1.2），而非在描述里多写几遍。
// 通用性：本段只做「JSON 数组 → 中文短语」的搬运与去重，零词表零正则。
//   一条要素该不该出现，是 LLM 从本场摘要里判的（见 sceneAnchors.analyzeWithLlm）。
export const ELEMENT_WEIGHT = 1.35

// 两段 note 的标题标签（与 server/ai/anchorTypes.js 逐字一致，跨端断言守护）
export const ELEMENT_NOTE_TAG = '【本场必须可见的要素】'
export const SHARED_ENV_NOTE_TAG = '【同空间共有环境】'

/** 单条要素/环境特征进 prompt 前的清洗：去空白、去尾标点、限长 */
export function normalizeElementPhrase(x) {
  return String(x ?? '')
    // 先压空白再 trim（不能在末标点之后留空格——LLM 常吐 "浓雾。 "，先 trim 会漏掉那个句号）
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[。．.；;，,、;:！!？?~～\-—－]+$/, '')
    .trim()
    .slice(0, 24)
}

/** JSON 列 → 干净短语数组。非法 JSON / 非数组 / 空项丢弃，跨项去重，失败返回 []（绝不抛错） */
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

/** A1：本场要素清单 → 硬约束句。空清单 → ''（逐字不变，保证老数据行为完全一致） */
export function buildElementNote(elements) {
  const list = Array.isArray(elements) ? elements.filter(Boolean) : []
  if (!list.length) return ''
  return `${ELEMENT_NOTE_TAG}(以下每一项都必须在画面中明确可见，不得省略或替换：${list.join('、')}：${ELEMENT_WEIGHT})。`
}

/** A2：组级环境卡 → 连续句。空清单 → ''（逐字不变） */
export function buildSharedEnvNote(sharedEnv) {
  const list = Array.isArray(sharedEnv) ? sharedEnv.filter(Boolean) : []
  if (!list.length) return ''
  return `${SHARED_ENV_NOTE_TAG}(本场景与同空间的其它场景共享以下环境特征，必须一致：${list.join('、')}：${ELEMENT_WEIGHT})。`
}

// 角色相关术语：场景/道具图需要从画风描述里剔除的角色类关键词
const CHARACTER_TERMS =
  /角色|人物|主角|配角|萌宠|宠物|动物|男孩|女孩|小孩|儿童|小人|人偶|拟人|卡通形象|表情|神态|动作|造型|服装|皮肤|眼睛|五官|头身|四肢|全身|可爱度|Q版|豆豆眼|mascot|character|person|human|animal|cute|chibi|kawaii|full.?body|face|eye/i

// 画风 prompt 中场景/道具图可安全引用的结构化段落标签
const SAFE_STYLE_SECTIONS = ['色彩关键词', '配色', '光影关键词', '光影', '材质关键词', '材质', '环境关键词', '环境']

// 画风自带的「氛围/时间」词（2026-09-16 场景一致性实锤后新增）：
// 场景的 summary / lighting_en 里已经把「清晨浓雾 / 午后 / 黄昏蜜色 / 入夜冷月」写死了，
// 而画风 prompt 里的「自然天光光影 / 治愈自然氛围」这类**氛围词会与场景自身光照打架**——
// 一条从清晨流到深夜的场景链被画风拉回统一暖调，观感就是"前后不是同一条河/同一块岩"。
// 处理：场景/道具图的风格里保留画风**笔触/上色/线条/材质**（真正决定"画得像不像同一个片"的部分），
// 剥掉会覆盖场景光照的时段与氛围断言。角色三视图不受影响（走完整画风，人物设定稿是中性棚拍）。
//
// 2026-09-16 P2-a 扩容（审计 §2.3）：原词表只拦「色调/色温/氛围」，漏掉会覆盖场景调性的
// 清新/治愈/明亮/温暖 等词，导致「清新柔和配色」「宫崎骏原生治愈画风」整句存活、把冰雪/深渊
// 场景拉向明亮暖调（同集 8 张场景画风漂移的直接成因）。补入这部分词。
//
// ⚠️ 回归修正（2026-09-16，QA 复验实锤 §2）：初版扩容误把 `配色|色彩|柔和` 也纳入，导致
//   ① `配色/色彩` 与本文件 SAFE_STYLE_SECTIONS（含「色彩关键词/配色」）**自相矛盾**——
//      把「只定义民艺色彩、线条和装饰秩序」这类**调色板/材质锚**整句删掉；
//   ② `柔和` 在 46 个画风里承载**笔触/材质**语义（柔和笔触/柔和动态模糊/柔和油画布肌理），非光照语义。
//   全库实测：4 个画风被剥成空壳、58 个画风丢失材质描述（正是"画风自由发挥→分层"的成因）。
//   → 移除这 3 个词。剥「清新柔和配色」改由 `清新` 负责，剥「治愈…」由 `治愈` 负责，效果不变。
// 必须仍然存活的三个画风本体锚：`吉卜力手绘动画` / `真实水彩手绘肌理` / `细腻手绘线条`。
const STYLE_AMBIENT_TERMS =
  /自然天光|天光光影|自然光|环境光|氛围|色调|色温|晨光|晨雾|黄昏|日落|日出|傍晚|夜色|夜间|白昼|光线|光照|光影|柔光|暖光|冷光|氛围感|清新|治愈|明亮|温暖|欢快|轻快|暖色|冷色|饱和|mood|atmosphere|ambient|lighting|daylight|sunset|sunrise|dusk|dawn|night|tone|warmth|coolness|saturated|vibrant|bright|warm|cheerful|pastel/i

// 画风本体硬锚（2026-09-16 QA 复验回归修正）：笔触 / 线条 / 材质 / 上色 类实词。
// 落在同一子句里的氛围词（如「柔和动态模糊」「高饱和色块并置」「冷色体积」）往往是**材质/技法**
// 修饰而非光照断言——这些子句是"画得像同一个片"的锚，**必须保留**，否则画风段被剥空 → 画风自由发挥分层。
const STYLE_ANCHOR_TERMS =
  /笔触|笔法|笔意|笔刷|画笔|笔痕|线条|线稿|勾线|描边|肌理|质感|质地|材质|上色|涂色|叠色|铺色|色块|拼接|颗粒|纸纹|纸面|网点|纹理|版画|印刷|厚涂|薄涂|渲染|水彩|油画|水墨|粉彩|蜡笔|素描|brush|stroke|texture|canvas|paint|sketch|grain|hatch|ink|render/i

// 负向/规避子句（"避免明亮偶像剧…""无过度饱和"）：是**约束**而非氛围，整句删除会丢规则，必须保留。
const STYLE_NEGATIVE_CLAUSE = /^\s*(避免|禁止|不要|不用|不宜|拒绝|规避|无|不)/

function filterStyleClauses(text) {
  return String(text || '')
    .split(/[，。；;,\n]/)
    .map((s) => s.trim())
    .filter((s) => s && !CHARACTER_TERMS.test(s))
    .join('，')
}

// 场景/道具图专用：在角色词过滤之上，再剥掉与场景自身光照打架的氛围词。
// 例外（2026-09-16 QA 复验回归修正）：① 含画风本体硬锚（笔触/线条/材质/上色）的子句——保留；
// ② 负向/规避子句（"避免明亮…""无过度饱和"）——保留。
function filterAssetStyleClauses(text) {
  return String(text || '')
    .split(/[，。；;,\n]/)
    .map((s) => s.trim())
    .filter((s) => {
      if (!s) return false
      if (CHARACTER_TERMS.test(s)) return false // 角色指令词一律剥
      if (STYLE_AMBIENT_TERMS.test(s) && !STYLE_ANCHOR_TERMS.test(s) && !STYLE_NEGATIVE_CLAUSE.test(s)) return false
      return true
    })
    .join('，')
}

// 从画风 prompt 抽取"场景/道具可用"的风格描述：结构化优先，黑名单兜底
function extractAssetStyle(stylePrompt) {
  if (!stylePrompt) return ''
  const parts = String(stylePrompt).split(/(色彩关键词|配色|光影关键词|光影|材质关键词|材质|环境关键词|环境|镜头关键词|核心描述|镜头)[：:]/)
  if (parts.length > 1) {
    const head = filterAssetStyleClauses(parts[0]) // 标签前的内容（风格名 + 可能角色描述）
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
  // 无结构化标签：整体黑名单过滤
  return filterAssetStyleClauses(stylePrompt)
}

// 场景图 prompt 里的画风段降级链（2026-09-16）：
// 实测历史事故——画风库未命中时 stylePrompt 会退化成「吉卜力风格」四个字，
// 此时场景图 prompt 里**一个画风实词都没有**（无 水彩/厚涂/线条/配色 任何锚），
// 模型只能自由发挥，直接导致同一集里 #5 水彩 / #7 厚涂的画风分层。
// 约定：只要风格库里拿得到完整 prompt，就用它；拿不到则退回风格名本身，
// 至少保证 prompt 里有一个模型能识别的画风标签（比空着强）。
export function resolveAssetStyleText(stylePrompt, styleLabel) {
  const full = String(stylePrompt || '').trim()
  const label = String(styleLabel || '').trim()
  // stylePrompt 与 styleLabel 相同 = 没查到完整 prompt（getStylePrompt 的兜底返回值）
  if (full && full !== label) return full
  return full || label
}

// 【场景光照常量自洽短路】判据与 server/ai/assetQuality.js 的 detectLightingConflict **同源**，
// 改动需两处同步（本文件头部亦声明"约束需与后端保持同文"）。
// 背景（2026-09-16 QA 复验 §4）：ep4 场1 的 lighting_en 现存值本身是暖金色，与"白茫茫雪原"冲突。
// P2-b 若无条件注入，会把这条**已知错误**的光照写进图 prompt 并赋予与场景描述同等优先级 →
// 在常量被纠正前，场1 场景图反而更偏暖，与用户诉求（要冷/要深渊感）相悖。
// 处理：冷环境描述 + 暖调常量（且常量无冷调词）→ 丢弃该常量，以场景描述为准；反向同理。
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

/**
 * 构建资产图 prompt
 * @param {'character'|'scene'|'prop'} type
 * @param {{description:string, name:string, stylePrompt:string, styleLabel:string, excludeProps:string[], lightingEn:string, spatialRole:string, elements:string[], sharedEnv:string[]}} p
 * @returns {string} 完整正向 prompt
 */
export function buildAssetImagePrompt(type, p = {}) {
  const {
    description = '', name = '', stylePrompt = '', styleLabel = '', excludeProps = [],
    lightingEn = '', spatialRole = '', elements = [], sharedEnv = [],
  } = p
  const desc = String(description || '').trim()
  // 场景/道具图的画风约束里，若风格名本身含角色词（如"豆豆眼Q版"），不再引用风格名，
  // 只保留"与描述一致"——避免风格名作为角色标签再次把萌角色带进空场景/静物图
  const guardLabel = (type === 'character' || !CHARACTER_TERMS.test(styleLabel)) ? styleLabel : ''
  const guard = guardLabel
    ? `。【画风统一约束】整幅画面风格统一为「${guardLabel}」画风，线条、上色、光影、质感与上述画面描述完全一致，禁止偏离画风。`
    : '。整幅画面风格、线条、上色、光影、质感与上述画面描述完全一致，禁止偏离。'

  if (type === 'character') {
    // 角色图：标准三视图设定稿（turnaround sheet）——正面/侧面/背面并排，纯白背景
    // 与「一二 / 布布」风格一致：横版画布、同一角色三视角、体型配色画风完全锁定
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
    // 【场景光照以本场景描述 + 光照常量为准】场景的 summary 已写死时段与光质（清晨浓雾/午后/黄昏/入夜），
    // 画风段里的氛围断言已在 extractAssetStyle 阶段剥掉，这里再显式声明一次优先级，
    // 避免模型把"画风统一"误读成"所有场景光照统一"——那正是"不是同一条河"的成因。
    //
    // 2026-09-16 P2-b：注入场景的英文光照常量 lighting_en（与出片链 v4Video/videoPrompt 同源）。
    // 原缺陷——lighting_en 只进视频链、不进资产图，导致"图一套光、片一套光"（审计 §2.3）。
    // 空值时**逐字保持**旧输出（不留空括号/悬空标点），保证既有调用方行为不变。
    // 2026-09-16 修正（QA 复验 §4）：常量与场景描述冷暖矛盾时**丢弃**，以场景描述为准——
    // 否则会把已知错误的光照（如场1 的暖金常量配"白茫茫"）写进图、反而加剧偏暖。
    const effectiveLightingEn = lightingEn && !lightingConflictsWithScene(desc, lightingEn) ? lightingEn : ''
    const lightingNote = effectiveLightingEn
      ? `（本场景光照常量：${effectiveLightingEn}）本画面的时间、光线方向与色调以该光照常量与场景描述为准，画风只统一笔触、上色与线条质感，不改变本场景既定光照。`
      : `本画面的时间、光线方向与色调以场景描述为准，画风只统一笔触、上色与线条质感，不改变本场景既定光照。`
    // 【机位声明提权】2026-09-17 视角塌陷修复（cliff_river 事故）。
    // 背景：spatial_role（"崖顶俯视谷底"/"谷底浅滩仰视"/"河面平视"）是 LLM 判定的**本场机位**，
    //   此前只显示在设定页 UI 上、从未进入图片 prompt。同组多视角于是失去唯一能区分彼此的信息，
    //   加上锚图 hint 曾要求「构图必须连续」，三场全部输出成同一个崖顶俯视机位。
    // 位置：紧跟在开头的 `(空无一人…环境空镜头：1.3)` 之后、长描述之前——**高权重位**。
    //   为什么不放句尾：句尾权重低，会被 1.2 权重的长描述和画风段盖过（"硬压软"）。
    // 空值逐字保持旧输出（不留空句/悬空标点），保证无空间组场景与既有调用方行为完全不变。
    const roleNote = String(spatialRole || '').trim()
      ? `【本场机位】${String(spatialRole).trim()}——画面必须体现这个视角与机位高度，` +
        `与同空间的其它视角区分开，不得照搬任何参考图或基准图的构图。`
      : ''
    // 【A1 本场要素硬约束 + A2 组级环境卡】2026-09-17
    // 起因（两个实测缺陷）：场1 摘要写了"清晨浓雾"、出图是晴空；场2 摘要没提植被、整片秃。
    // 根因同一类——「摘要里明文写了的事实」被 1.2 权重的长描述当"氛围形容词"淡化掉了。
    // 口径单点：字符串由 server/ai/anchorTypes.js 的 buildElementNote / buildSharedEnvNote 生成，
    //   前后端必须逐字一致（server/tests/sceneElements.test.mjs 跨端静态断言守护）。
    // 空数组 → 两个 note 都是 ''（逐字保持旧输出，无空间组/无分析的场景行为完全不变）。
    const elementNote = buildElementNote(elements)
    const sharedEnvNote = buildSharedEnvNote(sharedEnv)
    return `(空无一人的${name || '场景'}环境空镜头：1.3)，${roleNote}(${desc}:1.2)，${name ? `【${name}】` : ''}，${style}。` +
      `${elementNote}${sharedEnvNote}` +
      `画面只呈现场景环境与陈设，无角色、无人物、无动物${excludeNote}。` +
      `${lightingNote}` +
      `${ASSET_NEGATIVE_PHRASE}${guard}`
  }

  // prop
  return `(${desc}:1.2)，道具特写，纯白背景，${name ? `【${name}】` : ''}，${style}。画面中只有该道具这一个物体，纯白背景，道具居中占据画面主体，无人物、无动物、无人手。${ASSET_NEGATIVE_PHRASE}${guard}`
}
