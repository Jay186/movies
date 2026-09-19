// 锚点类型 / 审核状态枚举（共享常量，2026-09-17）
//
// 为什么单独成文件：`scene_anchors.anchor_type` 的取值集合要同时被四处引用——
//   ① schema.sql 的列注释（字面写死，SQL 层无法 import）；
//   ② ai/sceneAnchors.js 取锚（读 'spatial'/'prop'）；
//   ③ routes/generate-image.js 判定「本场是否命中空间类锚」（读 'scene'/'spatial'）；
//   ④ ai/spatialGroupReview.js 写锚（写 'spatial'）。
// 若各处各写一份字面量，任何一处改名都会静默漂移——「group 锚写进去了但取不出」
// 这类漏锚故障不会报错，只会安静地退化成各画各的。故抽成单点常量（同 assetTypes.js 的处置）。
//
// ⚠️ 与 schema.sql 的列注释必须同步（SQL 无法 import JS 常量，只能人工对齐 + 静态断言）。

/** scene_anchors.anchor_type 的全部取值 */
export const ANCHOR_TYPES = ['scene', 'prop', 'spatial', 'layout']

/** 空间组人审基准图锚（人工确认后写入，重析时保留不重建） */
export const SPATIAL_ANCHOR_TYPE = 'spatial'

/** 场景自身定稿图锚（自动登记，重析时重建） */
export const SCENE_ANCHOR_TYPE = 'scene'

/** 道具锚 */
export const PROP_ANCHOR_TYPE = 'prop'

/**
 * 空间组布局图锚（A3，2026-09-17）——「结构权威」锚，与 spatial 组锚的分工是**本质不同**的：
 *
 *   spatial 组锚（现有）= 一张**照片**（某场的人审基准图）。它同时携带了视角、光影、画风、
 *     主体占比——于是"继承它"与"别照搬它的构图"这两句话天然打架。这正是 cliff_river 视角
 *     塌陷与「场2 被场1 覆盖重画」两次事故的共同土壤：模型面对一张照片，无法只继承其中一部分。
 *
 *   layout 布局图锚（新）= 一张**俯视/轴测示意图**，只画「什么在什么位置、什么朝哪个方向、
 *     彼此距离比例」，**刻意不含**视角、不含时段光影、不含画风、不含人物。
 *     它只表达一种信息：空间事实。因此它可以被组内**所有视角无冲突地继承**——
 *     这张图本来就没有"机位"可言，不存在"照搬构图"的风险。
 *
 * 分工后的三层锚图：
 *   layout  → 锁「空间结构/地标相对位置/朝向/距离」（唯一权威，全组共享，无视角冲突）
 *   spatial → 锁「这个空间长什么样」（画风/材质/地标外观），但视角以本场描述为准
 *   scene   → 邻场照片，只校准共有物体形态，视角严禁继承
 *
 * 通用性：布局图的"该画哪些东西"完全来自 scene_analysis（组内 props ∪ 组标准地标），
 *   代码里零词表零正则；换题材（宫廷/太空站/学校）无需改一行代码。
 */
export const LAYOUT_ANCHOR_TYPE = 'layout'

/**
 * 「空间类锚」集合（区别于道具锚）：只有它能约束画面的空间结构/光照方向。
 * 判据单点——不要再在调用方写 `type === 'scene' || type === 'spatial'`：
 * 纯道具锚若被误判为空间锚，会让一张道具特写图被要求「构图以参考图为准」。
 * A3：'layout' 也属于空间类——但它是**结构专用**锚，其约束范围更窄（见 LAYOUT_ANCHOR_HINT）。
 */
export const SPATIAL_SERIES_ANCHOR_TYPES = ['scene', SPATIAL_ANCHOR_TYPE, LAYOUT_ANCHOR_TYPE]

/** 某条锚点明细是否属于「空间类锚」（空间结构/构图/光照方向的约束来源） */
export function isSpatialSeriesAnchor(anchor) {
  return SPATIAL_SERIES_ANCHOR_TYPES.includes(String(anchor?.type || ''))
}

/** 空间组审核状态（与 DB 列值、API 响应、前端常量三处同串） */
export const REVIEW_STATUS = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  SKIPPED: 'skipped',
}

/** 全部状态的合法取值（入参校验用） */
export const REVIEW_STATUSES = Object.values(REVIEW_STATUS)

/** 人审决策动作（API 请求体 action 的取值，与前端常量同串） */
export const REVIEW_ACTION = {
  CONFIRM: 'confirm',
  SKIP: 'skip',
}

// ===================================================================
// A1/A2 要素清单与组级环境卡的提示词拼装（2026-09-17）
// ===================================================================
//
// 为什么放这里（而不是 promptBuilder 里就地写）：两处需要**逐字同口径**——
//   ① 前端 src/services/promptBuilder.js 拼场景图 prompt（文生图 / 图生图）；
//   ② 服务端 routes/generate-image.js 返回要素回执（result.sceneElements）供 A4/A5 质检比对。
// 且这两处分属前后端两个 bundle，无法互相 import——故此处作为**口径单点**，
// 由 server/tests/sceneElements.test.mjs 的跨端静态断言守护「两边字符串完全一致」。
//
// 通用性硬约束：本段只做「JSON 数组 → 中文短语」的搬运与去重，不做任何词表/正则判断。
// 一个要素该不该出现，是 LLM 从本场摘要里判的，这里只负责拼装。

/** 单条要素/环境特征进 prompt 前的清洗：去空白、去尾标点、限长（防 LLM 吐长句挤占画面描述） */
export function normalizeElementPhrase(x) {
  return String(x ?? '')
    // 先压空白再 trim（不能在末标点之后留空格——LLM 常吐 "浓雾。 "，先 trim 会漏掉那个句号）
    .replace(/\s+/g, ' ')
    .trim()
    // 去尾部标点：中英文标点全列（半角/全角句号、逗号、顿号、分号、冒号、叹问号、破折号、波浪号）
    .replace(/[。．.；;，,、;:！!？?~～\-—－]+$/, '')
    .trim()
    .slice(0, 24)
}

/**
 * JSON 列（elements_json / shared_env_json）→ 干净短语数组。
 * 非法 JSON / 非数组 / 空项一律丢弃；顺序保留 LLM 给的优先级顺序；跨项去重。
 * 失败绝不抛错（降级为空数组 = 不注入，行为同改造前）。
 */
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

// 权重：1.35 —— 高于长描述的 1.2、与机位声明同档。
// 为什么用权重语法而不是自然语句：「清晨浓雾」这类要素在 1.2 权重的长描述里
// 会被模型当"氛围形容词"淡化（实测：摘要写浓雾、出图是晴空）。加权 + 独立成句
// 才能把它从"氛围"提升为"必须在画面里看得见的事实"。
export const ELEMENT_WEIGHT = 1.35

// 两段 note 的标题标签（**幂等注入的判据**，别改）：
// 前端已注入 → 服务端补注时用 includes(TAG) 判定，命中则不加第二遍。
// 故标签内容须与函数体里输出的前缀逐字一致，改动需同步两处（本文件内部即为一处）。
export const ELEMENT_NOTE_TAG = '【本场必须可见的要素】'
export const SHARED_ENV_NOTE_TAG = '【同空间共有环境】'

/** A1：本场要素清单 → 硬约束句。空清单 → ''（逐字不变） */
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

/** 便捷：从 JSON 列直接拼装（调用方拿不到已解析数组时用） */
export function buildElementNoteFromJson(raw) {
  return buildElementNote(parseElementList(raw))
}
export function buildSharedEnvNoteFromJson(raw) {
  return buildSharedEnvNote(parseElementList(raw))
}

// ===================================================================
// A3 布局图锚 · 口径单点（2026-09-17）
// ===================================================================
//
// 为什么单独抽一段常量而不是就地写：这句话是 A3 全部价值所在——
//   一旦它变成"空间结构以参考图为准"这种宽口径，布局图就退化成第二张照片，
//   视角塌陷会以新形式复发（模型会把俯视图的构图翻译成斜俯视）。必须极窄。

/**
 * 传给图片模型的 layout 锚 hint（进 promptHints，与参考图同序）。
 * 三段式：① 明确它是"俯视示意图"而非照片（防模型当成画风/光影来源）；
 *        ② 继承项极窄——只有位置关系/朝向/距离比例；
 *        ③ 显式豁免一切视觉属性——视角、光影、时段、画风、材质、主体占比。
 */
export const LAYOUT_ANCHOR_HINT =
  '本空间的「布局示意图」已作为参考图提供（该图是俯视/轴测的示意画法，只表达位置关系，不是画面效果图）：' +
  '本场景中各物体的**相对位置、朝向、彼此距离比例**必须与布局图一致；' +
  '但该图**不约束**本画面的视角、机位高度、景别、光影、时段、天气、色温、画风、材质与画面主体占比——' +
  '这些一律以本场景文字描述为准。' +
  '严禁把布局图的俯视/轴测画法当作本画面的视角，也严禁照搬它的示意画风。'

/** 布局图本身的生成 prompt 骨架（builder 填内容）。刻意强调"示意图"。 */
export const LAYOUT_IMAGE_SUBJECT = '空间布局示意图'

/**
 * 布局图的**风格锚**（正向表述，替代"不要写文字"式否定）。
 *
 * ⚠️ 2026-09-17 第五次实测确立的口径（A3 最重要的一条经验）：
 *   实测 v1→v5 五轮，唯一稳定的规律是——**否定词越多，结果越差**。
 *   v3（约束较少）干净零文字；v5（1353 字 / 28 个否定词）反而退回"教科书带标签示意图"，
 *   满图中英标注。原因：要否定"示意图带标签"这个先验，就得先在 prompt 里**提到**它，
 *   而提到就是强化；叠加过多后模型放弃逐条遵守，退回最强先验。
 *
 *   真正有效的做法是**用一个本身就不含文字的格式来锚定风格**：
 *   「扁平矢量 / 教学挂图 / 儿童科普插画 / 分层积木」这几个词所指向的图像分布，
 *   天然就是"用形状和色块表达、没有标注文字"的。用它们锚住格式，
 *   比写十句"不要写文字"都管用，且不引入任何否定词。
 *
 *   注意：此处**刻意不接项目的 art_style**（原本会传"吉卜力风格"进来）。
 *   吉卜力风格属于写实插画范畴，会与"扁平矢量示意图"对撞，把模型拉回效果图范式——
 *   而布局图的价值恰恰在于它**不是**效果图（若它是效果图，它就会去锁视角与光影，
 *   正是本项目已修复的"视角塌陷"的成因）。画风由最终场景图承担。
 */
export const LAYOUT_IMAGE_STYLE_ANCHOR =
  '这是一张**扁平矢量风格的教学挂图**，像儿童科普书里用来讲解空间的示意图：' +
  '只用干净的色块、简单的几何形状和利落的线条来表达物体，没有渲染、没有质感、没有光影。' +
  '整张图是"一块可以拿在手里把玩的地形模型"那种感觉。'

export const LAYOUT_IMAGE_NEGATIVE =
  '画面为纯图形化的等轴测或斜俯视空间关系示意图，是美术设计用的平面示意，不是摄影作品、不是场景效果图。' +
  '⚠️ 画面中**绝对不要出现任何文字、汉字、字母、数字、标签、注记、标题、题注**——' +
  '常见的"示意图带名称标注"范式在这里是错的，被标注的物体用图形本身表达即可，不要用文字指认。' +
  '不要出现图例框、比例尺、指北针、箭头、指引线、坐标格、边框、眼睛/机位图标或任何符号标记。' +
  '不要出现任何角色、人物、动物（包括本片主角），也不要画雪地脚印、足迹或任何暗示角色在场的痕迹。' +
  '不要新增未被列出的物体（不要自行添加树木、花草动物、建筑、器物）。' +
  // ⚠️ 2026-09-17 第五次实测（P0）：本常量曾一度膨胀为 6 句、含"大气现象可用无色块画范围与边界"
  //    这类**自相矛盾**的让步句，加上 prompt 主体里的 28 个否定词，直接把模型推回
  //    "教科书式带标签示意图"先验（v5 满图中英标注）。
  //    **教训：示意图类提示词里，否定词越堆越糟——每写一条"不要X"都在提示"X"这个概念。**
  //    故此处只保留**最危险的副作用**（文字与角色，二者会污染全组生成），
  //    其余约束改用正向的 LAYOUT_IMAGE_STYLE_ANCHOR 锚定格式来达成。
  '不要画天空、不要画地平线、不要画光照氛围与光线方向、不要表现色温或色调氛围。' +
  '不要画雾、云、水汽、雨、雪等任何大气现象，也不要画雪地反光、冰面高光或云絮质感——本图只表达地形与物体的平面位置和朝向。'
