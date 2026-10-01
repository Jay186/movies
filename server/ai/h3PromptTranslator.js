
import { chatCompletion } from './doubao.js'
import { CJK_DIRTY_RE, pickInjectableEnglish } from './shared.js'
import { config } from '../config.js'
import { recordAlert } from './alerts.js'

// 景别英文映射已抽到 ai/shotTypes.js，与归一档位表 / 提示词枚举共用同一份数据。
// 映射口径说明（原注释保留）：
// 出片模型官方未给景别枚举表，官方范例只出现过 4 个景别词：
//   medium-wide shot · medium shot · close-up · extreme close-up
// 故映射以"官方范例原词 + 导演语义"双重对齐，避免整体上移一级：
//   近景 = 半身/胸上景 → medium close-up（MCU）
//   特写 = 看脸/细节   → close-up（CU，官方原词）
//   大特写 = 更极端    → extreme close-up（ECU，唯一入口）
export { translateShotSize } from './shotTypes.js'

// MiniMax H3 官方 camera-motion 三维语法（base-en.txt §4.3）：
//   Motion type: Zoom In/Out · Push In/Pull Out · Pan Left/Right · Truck Left/Right ·
//                Tilt Up/Down · Pedestal Up/Down · Arc Shot · Tracking Shot · Static Shot ·
//                Shake Slightly/Strongly · POV · Roll Clockwise/Counterclockwise
//   Amplitude:   仅 with small amplitude / with large amplitude（中等幅度=省略不写）
//   Speed:       仅 at slow speed / at fast speed（常速=省略不写）
// 本表只输出官方枚举值；方向是 Pan/Truck/Pedestal 的必选组成部分（Left/Right、Up/Down）。
// 中文词未指明方向时，取一个官方方向的默认值，绝不臆造 medium amplitude / 自由速度描述。
const CAMERA_MAP = {
  // 官方枚举为 Static Shot；不再追加官方没有的 "with no camera movement throughout" 尾句。
  '固定': 'holds a static shot',
  '静止': 'holds a static shot',
  '静态': 'holds a static shot',
  '不动': 'holds a static shot',
  '推近': 'pushes in with small amplitude at slow speed',
  '推': 'pushes in with small amplitude at slow speed',
  '推镜头': 'pushes in with small amplitude at slow speed',
  '拉近': 'pushes in with small amplitude at slow speed',
  '拉远': 'pulls out with small amplitude at slow speed',
  '拉': 'pulls out with small amplitude at slow speed',
  '拉镜头': 'pulls out with small amplitude at slow speed',
  '变焦': 'zooms in with small amplitude at slow speed',
  '变焦推近': 'zooms in with small amplitude at slow speed',
  '推焦': 'zooms in with small amplitude at slow speed',
  '变焦拉远': 'zooms out with small amplitude at slow speed',
  '拉焦': 'zooms out with small amplitude at slow speed',
  '横摇': 'pans left with small amplitude at slow speed',
  '摇镜头': 'pans left with small amplitude at slow speed',
  '左摇': 'pans left with small amplitude at slow speed',
  '右摇': 'pans right with small amplitude at slow speed',
  '摇上': 'tilts up with small amplitude at slow speed',
  '摇下': 'tilts down with small amplitude at slow speed',
  '上摇': 'tilts up with small amplitude at slow speed',
  '下摇': 'tilts down with small amplitude at slow speed',
  '横移': 'trucks left with small amplitude at slow speed',
  '平移': 'trucks left with small amplitude at slow speed',
  '移镜': 'trucks left with small amplitude at slow speed',
  '左移': 'trucks left with small amplitude at slow speed',
  '右移': 'trucks right with small amplitude at slow speed',
  '升降': 'pedestals up with small amplitude at slow speed',
  '升降镜头': 'pedestals up with small amplitude at slow speed',
  '升高': 'pedestals up with small amplitude at slow speed',
  '降低': 'pedestals down with small amplitude at slow speed',
  '升镜': 'pedestals up with small amplitude at slow speed',
  '降镜': 'pedestals down with small amplitude at slow speed',
  '环绕': 'arcs around the subject with small amplitude at slow speed',
  '环摇': 'arcs around the subject with small amplitude at slow speed',
  '绕拍': 'arcs around the subject with small amplitude at slow speed',
  '弧形环绕': 'arcs around the subject with small amplitude at slow speed',
  '跟拍': 'tracks the subject with small amplitude',
  '跟随': 'tracks the subject with small amplitude',
  '跟镜': 'tracks the subject with small amplitude',
  '跟移': 'tracks the subject with small amplitude',
  // 官方 §4.3 运动类型枚举无 Dolly 型；中文「推轨/滑轨/轨道」在实拍里就是推/移，
  // 按官方枚举落到 Push In / Truck，不再自造 "on a dolly" / "along a dolly track"。
  '推轨': 'pushes in with small amplitude at slow speed',
  '滑轨': 'trucks right with small amplitude at slow speed',
  '轨道': 'trucks right with small amplitude at slow speed',
  // 官方运动类型枚举无 handheld / shoulder-mounted 修饰语；手持感由 Shake Slightly/Strongly 承担。
  '手持': 'shakes slightly',
  '手持跟拍': 'shakes slightly while tracking the subject with small amplitude',
  '肩扛': 'shakes slightly',
  '轻微晃动': 'shakes slightly',
  '剧烈晃动': 'shakes strongly',
  '强烈晃动': 'shakes strongly',
  // 官方枚举为 POV（语义即"主体视点"）；不再追加官方没有的 "from the subject eyeline"。
  'POV': 'holds a POV shot',
  '主观': 'holds a POV shot',
  '主观镜头': 'holds a POV shot',
  '第一人称': 'holds a POV shot',
  '旋转': 'rolls clockwise around the lens axis with small amplitude at slow speed',
  '旋转镜头': 'rolls clockwise around the lens axis with small amplitude at slow speed',
  '滚转': 'rolls clockwise around the lens axis with small amplitude at slow speed',

  // —— 幅度/速度变体：对齐官方三维语法（只有 small/large × slow/fast 四种组合，无 medium）
  '急推': 'pushes in with large amplitude at fast speed',
  '猛推': 'pushes in with large amplitude at fast speed',
  '快推': 'pushes in with large amplitude at fast speed',
  '缓推': 'pushes in with small amplitude at slow speed',
  '大范围推近': 'pushes in with large amplitude at slow speed',
  '急拉': 'pulls out with large amplitude at fast speed',
  '快拉': 'pulls out with large amplitude at fast speed',
  '缓拉': 'pulls out with small amplitude at slow speed',
  '大范围拉远': 'pulls out with large amplitude at slow speed',
  // 变焦无方向语义：中文「急/缓变焦」只表达速度快慢，不指定推/拉方向，故此处不做 in/out 单向化
  '急变焦': 'zooms in with large amplitude at fast speed',
  '缓变焦': 'zooms in with small amplitude at slow speed',
  '急摇': 'pans left with large amplitude at fast speed',
  '快甩': 'pans left with large amplitude at fast speed',
  '缓摇': 'pans left with small amplitude at slow speed',
  '快摇左': 'pans left with large amplitude at fast speed',
  '快摇右': 'pans right with large amplitude at fast speed',
  '缓摇左': 'pans left with small amplitude at slow speed',
  '缓摇右': 'pans right with small amplitude at slow speed',
  '大范围摇': 'pans left with large amplitude at slow speed',
  '急移左': 'trucks left with large amplitude at fast speed',
  '急移右': 'trucks right with large amplitude at fast speed',
  '快移左': 'trucks left with large amplitude at fast speed',
  '快移右': 'trucks right with large amplitude at fast speed',
  '缓移左': 'trucks left with small amplitude at slow speed',
  '缓移右': 'trucks right with small amplitude at slow speed',
  '急摇上': 'tilts up with large amplitude at fast speed',
  '急摇下': 'tilts down with large amplitude at fast speed',
  '缓摇上': 'tilts up with small amplitude at slow speed',
  '缓摇下': 'tilts down with small amplitude at slow speed',
  '急升': 'pedestals up with large amplitude at fast speed',
  '急降': 'pedestals down with large amplitude at fast speed',
  '缓升': 'pedestals up with small amplitude at slow speed',
  '缓降': 'pedestals down with small amplitude at slow speed',
  '急环绕': 'arcs around the subject with large amplitude at fast speed',
  '快环绕': 'arcs around the subject with large amplitude at fast speed',
  '缓环绕': 'arcs around the subject with small amplitude at slow speed',
  '急跟': 'tracks the subject with large amplitude at fast speed',
  '快跟': 'tracks the subject with large amplitude at fast speed',
  '缓跟': 'tracks the subject with small amplitude at slow speed',
  '急旋转': 'rolls clockwise around the lens axis with large amplitude at fast speed',
  '缓旋转': 'rolls clockwise around the lens axis with small amplitude at slow speed',
  '剧烈手持跟拍': 'shakes strongly while tracking the subject with small amplitude',

  // 俯拍/仰拍 = 机位角度，不是运镜：此处只作为「静置俯角/仰角」的运镜兜底，
  // 真实机位朝向由 CAMERA_ANGLE_MAP 输出（见 camera_angle 字段），避免一词双籍。
  // 官方枚举只到 Static Shot；"high-angle/low-angle looking down/up" 属机位措辞，保留描述但去掉冗余尾句。
  '俯拍': 'holds a static shot from a high angle looking down',
  '俯视': 'holds a static shot from a high angle looking down',
  '仰拍': 'holds a static shot from a low angle looking up',
  '仰视': 'holds a static shot from a low angle looking up',
}

const CAMERA_ANGLE_MAP = {
  '正面': 'the camera is positioned front-on at eye level, facing the subject directly',
  '侧面': 'the camera is positioned at a 45-degree three-quarter side view of the subject',
  '侧45度': 'the camera is positioned at a 45-degree three-quarter side view of the subject',
  '正侧': 'the camera is positioned in a full side profile view of the subject',
  '背面': 'the camera is positioned behind the subject, framing the back of the character',
  '过肩': 'the camera is positioned in an over-the-shoulder framing behind the subject',
  '俯拍': 'the camera is positioned high above, looking down at the subject',
  '仰拍': 'the camera is positioned low, looking up at the subject',
}

export function translateCameraAngle(cn) {
  const key = String(cn || '').trim()
  return CAMERA_ANGLE_MAP[key] || ''
}

// 俯仰维度（中性中文 → H3 英文从句）：与 CAMERA_ANGLE_MAP 的水平机位正交组合，
// 表达 Skill 的复合机位（如「侧45度+微俯」）。来源：xiaomo-film-studio storyboard-rules §5/§9。
const ELEVATION_MAP = {
  '平视': '',
  '微俯': 'from a slightly elevated angle looking down',
  '俯拍': 'from a high angle looking down',
  '大俯角': 'from a steep overhead angle looking down',
  '微仰': 'from a slightly low angle looking up',
  '仰拍': 'from a low angle looking up',
  '大仰角': 'from a steep low angle looking up',
}

// 机位 = 水平角度 × 俯仰 两字段组合翻译；俯仰为空/平视时退回纯角度句。
export function translateCameraAngleElevation(angle, elevation) {
  const baseRaw = translateCameraAngle(angle)
  if (!baseRaw) return ''
  const el = ELEVATION_MAP[String(elevation || '').trim()]
  if (!el) return baseRaw
  const base = baseRaw.replace(/,? at eye level,?/i, '')
  return `${base}, ${el}`
}

// 焦段（中性中文 → H3 英文句）：Skill 表头写「标准 35mm / 中长焦 85mm / 微距 100mm」，
// 提取 mm 数与镜头类型，拼成实拍语言。mm 与类型都缺时返回空（不瞎编）。
const LENS_TYPE_MAP = {
  '超广角': 'an ultra-wide-angle',
  '广角': 'a wide-angle',
  '标准': 'a standard',
  '中长焦': 'a medium-telephoto',
  '长焦': 'a telephoto',
  '微距': 'a macro',
}

export function translateLens(cn) {
  const s = String(cn || '').trim()
  if (!s) return ''
  const mm = s.match(/(\d+)\s*mm/i)
  const typeKey = Object.keys(LENS_TYPE_MAP).find((k) => s.includes(k))
  if (mm && typeKey) return `shot on ${LENS_TYPE_MAP[typeKey]} ${mm[1]}mm lens`
  if (mm) return `shot on a ${mm[1]}mm lens`
  if (typeKey) return `shot on ${LENS_TYPE_MAP[typeKey]} lens`
  return ''
}

// 运镜无安全默认值（瞎给"固定"会把动态运镜降级成胡编），故 translateCameraMovement
// 精确匹配失败时用中文子串兜底：按键长度降序取首个被输入包含的中文键（抓基础动词，
// 如"缓慢推近"→命中"推近"）。幅度/速度可能降级（取基础键的档），但运镜类型不丢、不静默。
// 英文/复合运镜值（如"arc right + dolly out"）子串兜底覆盖不了，仍返空串——不瞎翻，
// 这类值应在生成时归一为单一中文枚举，不是 translator 的职责。
const CAMERA_SUBSTR_KEYS = Object.keys(CAMERA_MAP)
  .filter((k) => k && /[\u4e00-\u9fa5]/.test(k))
  .sort((a, b) => b.length - a.length)

export function translateCameraMovement(cn) {
  const key = String(cn || '').trim()
  if (!key) return ''
  if (CAMERA_MAP[key]) return CAMERA_MAP[key]
  for (const k of CAMERA_SUBSTR_KEYS) {
    if (key.includes(k)) return CAMERA_MAP[k]
  }
  return ''
}

const TONE_MAP = {
  '压低声音': 'in a hushed tone',
  '低声': 'in a hushed tone',
  '小声': 'in a quiet tone',
  '小声嘀咕': 'while muttering quietly',
  '耳语': 'in a whisper',
  '兴奋': 'excitedly',
  '好奇': 'curiously',
  '鼓起腮帮': 'while puffing out cheeks',
  '鼓气逞强': 'while putting on a brave front',
  '逞强': 'while putting on a brave front',
  '壮胆': 'while trying to sound brave',
  '大喊': 'while shouting',
  '大喊道': 'while shouting',
  '喊道': 'while shouting',
  '惊呼': 'in a startled cry',
  '低吼': 'in a low growl',
  '怒吼': 'in a furious roar',
  '咆哮': 'in a roar',
  '喘气': 'while panting',
  '喘息': 'while panting',
  '喘着气': 'while panting for breath',
  '虚弱地呻吟': 'while moaning weakly',
  '呻吟': 'while moaning',
  '虚弱': 'weakly',
  '晃着腿': 'while swinging legs',
  '笑眯眯': 'while smiling gently',
  '微笑': 'while smiling softly',
  '温柔': 'gently',
  '温柔坚定': 'in a gentle but firm tone',
  '胆怯发飘': 'in a timid quavering thin voice',
  '胆怯': 'in a timid quavering tone',
  '发飘': 'in a thin unsteady voice',
  '轻快期待': 'lightly and expectantly',
  '期待': 'expectantly',
  '认真': 'earnestly',
  '坚定': 'determinedly',
  '害怕': 'fearfully',
  '惊恐': 'in terror',
  '紧张': 'nervously',
  '惊讶': 'in surprise',
  '诧异': 'in surprise',
  '开心': 'happily',
  '开心地': 'happily',
  '高兴': 'happily',
  '沮丧': 'dejectedly',
  '愤怒': 'angrily',
  '咬牙': 'through gritted teeth',
  '咬牙切齿': 'through gritted teeth',
  '急切': 'urgently',
  '急促': 'in quick breaths',
  '沉重': 'heavily',
  '颤抖': 'tremblingly',
  '颤声': 'in a trembling voice',
  '平静': 'calmly',
  '沉稳': 'steadily',
}

export function translateTone(cn) {
  const key = String(cn || '').trim()
  if (!key) return ''
  const segs = key.split(/[，,、/｜|]+/).map((s) => s.trim()).filter(Boolean)
  const hits = []
  for (const seg of segs) {
    let hit = TONE_MAP[seg]
    if (!hit) {
      for (const [k, v] of Object.entries(TONE_MAP)) { if (seg.includes(k)) { hit = v; break } }
    }
    if (hit && !hits.includes(hit)) hits.push(hit)
  }
  if (hits.length) return hits.join(', ')
  if (TONE_MAP[key]) return TONE_MAP[key]
  for (const [k, v] of Object.entries(TONE_MAP)) { if (key.includes(k)) return v }
  return ''
}

const translationCache = new Map()

// 首尾状态翻译规则：world_state_in/out 分别是本镜 0.00s 与结束时的结构化状态快照。
// 两者都必须独立保留，不能把出场状态误当成开场状态，否则上一镜末态会在本镜被重置。
const WORLD_STATE_RULES = `8. **开场状态（world_state_in）翻译**：输入的「开场状态」是 0.00s 首帧构图硬约束——谁在画面哪个位置、什么姿态、面向哪边、谁驮着谁、谁抱着谁。必须**逐字忠实**翻译，一个位置关系/姿态/朝向都不许省略、合并或改写；输出 30-80 英文词，用 "X is at ... facing ..." 的直陈句式。这是首帧构图的决定性信息，优先级高于一切铺陈。
9. **收尾状态（world_state_out）翻译**：输入的「收尾状态」是本镜结束时必须成立的状态快照。必须**逐字忠实**翻译，一个位置关系/姿态/朝向/道具状态都不许省略、合并或改写；输出 30-80 英文词。它约束动作完成后的结果，禁止退回开场状态。
10. **末帧（final_frame）翻译**：仅当末帧含中文时才翻译，输出 40-100 英文词的末帧构图描述，忠实保留每个角色的位置/姿态/朝向与环境状态；末帧纯英文时返回空字符串。`

const TRANSLATE_SYSTEM_PROMPT = `你是 AI 视频 prompt 翻译与扩写专家，把中文分镜描述翻译成符合 MiniMax H3 Ref2VA 规范的英文。

【翻译规则】
1. 只翻译并扩写给定字段，**不得添加原文没有的角色、道具、情节、镜头切换或对白**；
   **空间关系是硬约束，必须逐字忠实保留、禁止改写或省略**——谁在哪儿、面向哪个方向
   （背对镜头/侧对镜头/面对镜头）、被什么遮挡（躲在某物后/只露出头部）、露了多少、
   谁在看谁、相对远近与高低。这些是镜头的戏剧核心，即使与扩写词数冲突，也**宁少勿改**。
2. 角色名/场景名直接保留原文（中文名不变，如"角色甲""角色乙""角色丙"原样保留）
3. 运镜不要翻译（已在别处处理），只翻译画面与动作
4. 语气词翻译成英文副词短语（如"压低声音"→"in a hushed tone"）
5. 不要翻译台词内容（台词单独处理）
6. **输出必须是纯英文**，除角色名/场景名外不得出现任何中文字符
7. **音色克隆约束**（本次任务若标注「音色克隆角色」，下列角色台词由克隆音色朗读）：
   凡描写这些角色**发声方式**的内容，必须写成平稳克制的说法，**禁止**出现：
   鼓腮/鼓气（puffed cheeks、inflating cheeks、cheeks into spheres）、张大嘴（opening its mouth wide）、
   大口吸气（drawing in a large/deep breath、a large volume of air）、用力投射（projecting a call）、
   喊叫（shouting / screaming / yelling）、提高音量（raising its voice）、怒吼低吼（roar / growl）、
   用力到极限（to its maximum extent）。
   替代写法：站直、挺胸、攥紧拳头、眼神坚定、下巴抬起等**不改变发声方式的肢体语言**；
   递送措辞用 "in a steady low voice"、"firmly but quietly" 这类稳态短语。
   （硬原因：H3 一旦把该镜判定为喊叫场景，会抛弃 <Audio N> 克隆音色改用通用嗓音——实测 F0 543Hz vs 样本 286Hz。）

【扩写要求】官方 ref-en.txt §5.2：detailed_description 正常需要 **350-500 英文词**，且明确反对
「reducing the description to a plot summary / A single shot does not automatically justify a shorter
description」。注意 description_en + action_note_en 会拼成同一段 detailed_description，
所以两者的词数之和必须落进 350-500（若用户消息末尾给出【本次词数预算】，预算优先于该区间——
API 单条 7000 字符硬上限优先于词数质量指导）。按「首帧锚定 → 动作起始 → 连续发展 → 结果或反应」展开：

- description_en：**300-380 英文词**。**首先**逐字忠实保留原文的空间关系与朝向（谁背对/面对/侧对镜头、谁躲在什么后、只露出什么、谁看谁、远近高低）；**然后**在保留这些硬信息的前提下，扩写景别与构图布局、光线的方向/质量/色温、材质与色彩细节、环境元素与空间纵深、角色的姿态变化与面部表情。用可拍摄的视觉化语言，不要复述剧情。**一个镜头也要写满**，信息分部在前景/中景/远景三层铺开。
- action_note_en：**60-100 英文词**。按时间进程分解动作：起始姿态 → 动作过程 → 结束状态，写明动作幅度与节奏。
- soundscape_en：1-4 个英文句子成段（官方 base-en §4.6 口径，词数不限），写环境音与物理音效的层次。
- music_en：1-3 个英文句子（官方 base-en §4.7 口径，词数不限），写观众能听到的背景配乐（角色听不到的）；原文为空则返回空字符串。**禁止抽象情绪词、禁止解释配乐的情绪功能**，只写乐器编制/速度/节奏/动态变化。
- tone_en：英文语气短语；原文为空则返回空字符串。

【输出格式】严格 JSON：
{
  "description_en": "...",
  "action_note_en": "...",
  "soundscape_en": "...",
  "music_en": "...",
  "tone_en": "...",
  "world_state_en": "...",
  "world_state_end_en": "...",
  "final_frame_en": "..."
}

${WORLD_STATE_RULES}

字段为空就返回空字符串。只输出 JSON，不要任何其他文字。`

// ── 首尾状态单字段翻译（回填/质检用）────────────────────────────────────
// 与 translateShotFields 的第 8/9 条规则同源，但只发一条最小请求：
// 存量回填时若走完整 translateShotFields，会被迫连带翻译画面/动作/声景/配乐四个大字段
// （每次 2600 tokens、单镜最多 2 次重试），36 镜的代价是几十倍。首尾状态之间是强上下文关系，
// 所以这里一次性翻译「首→末」成对送入，保证两句的用词和空间关系互不漂移。
const WORLD_STATE_ONLY_PROMPT = `你是 AI 视频 prompt 翻译专家，把中文分镜的「开场状态 / 收尾状态」翻译成英文。

这两句分别是本镜 0.00s 首帧与结束帧的构图硬约束：谁在画面哪个位置、什么姿态、面向哪边、
谁驮着谁、谁抱着谁、手持什么道具。

【规则】
1. **逐字忠实**：一个位置关系、姿态、朝向、道具状态都不许省略、合并或改写。
   原文说「停步」就写 stopped walking，不许简化成 paused；原文说「面向画面深处」就必须
   落在 facing 短语里，不许漏译成中英混排。
2. 输出 30-80 英文词/句，用 "X is at ... facing ..." 的直陈句式。
3. 角色名/场景名保留中文原样（如 "角色中文名 is at frame center"），其余必须是纯英文。
4. 原文为空的字段返回空字符串。
5. 只输出 JSON，不要任何其他文字。`

export async function translateWorldStateOnly(zhIn = '', zhOut = '', ctx = {}) {
  const { characterNames = [], sceneNames = [] } = ctx
  const srcIn = String(zhIn || '').replace(/@/g, '').trim()
  const srcOut = String(zhOut || '').replace(/@/g, '').trim()
  if (!srcIn && !srcOut) return { world_state_en: '', world_state_end_en: '', failed: false }

  const nameList = [...characterNames, ...sceneNames].filter(Boolean).map((n) => `- ${n}`).join('\n')
  const messages = [
    { role: 'system', content: WORLD_STATE_ONLY_PROMPT },
    {
      role: 'user',
      content: `角色/场景名（保留原文不翻译）：
${nameList || '（无）'}

开场状态（0.00s 首帧硬约束，按规则 1 逐字忠实翻译）：${srcIn || '（空）'}
收尾状态（本镜结束时必须成立，按规则 1 逐字忠实翻译）：${srcOut || '（空）'}

输出 JSON：{"world_state_en": "...", "world_state_end_en": "..."}`,
    },
  ]

  const NAME_SAFE = new Set([...characterNames, ...sceneNames].filter(Boolean))
  const hasLeakedChinese = (s) => {
    if (!s) return false
    let probe = s
    for (const n of NAME_SAFE) probe = probe.split(n).join('')
    return CJK_DIRTY_RE.test(probe)
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const msgs = attempt === 0
        ? messages
        : [
            messages[0],
            { role: 'assistant', content: '（上一次输出含中文，请重新输出纯英文 JSON）' },
            { ...messages[1], content: messages[1].content + '\n\n【重要】除角色名/场景名外不得出现任何中文字符。' },
          ]
      const text = await chatCompletion(msgs, {
        temperature: 0.3,
        maxTokens: 700,
        responseFormat: { type: 'json_object' },
        timeoutMs: config.timeouts.llm.repair,
        usageContext: { task: 'h3-worldstate-translate' },
      })
      // 实测部分模型在 json_object 模式下仍偶发包裹 ```json 围栏（2026-10-01 回填验证抓出），
      // 不剥则 JSON.parse 整次失败、全部字段跟着降级为空——剥围栏是纯防御性清洗，无行为变化。
      const parsed = JSON.parse(String(text || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim())
      const result = {
        world_state_en: String(parsed.world_state_en || '').trim(),
        world_state_end_en: String(parsed.world_state_end_en || '').trim(),
        failed: false,
      }
      if (!hasLeakedChinese(result.world_state_en) && !hasLeakedChinese(result.world_state_end_en)) return result
      if (attempt === 1) return { ...result, failed: true }
    } catch (e) {
      if (attempt === 1) return { world_state_en: '', world_state_end_en: '', failed: true }
    }
  }
  return { world_state_en: '', world_state_end_en: '', failed: true }
}

function rescueLeakedFields(result = {}, hasLeaked = () => true) {
  const FIELDS = ['description_en', 'action_note_en', 'soundscape_en', 'music_en', 'tone_en', 'final_frame_en']
  // 首尾状态（world_state_en / world_state_end_en）不参与删残救援：
  // 它们是 0.00s 与末帧的构图硬约束（WORLD_STATE_RULES「逐字忠实、一个位置关系都不许省略」），
  // pickInjectableEnglish 只挑可注入的英文句子，含一处汉字即可能整句丢弃 → 首帧约束静默消失，
  // 上一镜末态在本镜被重置（即 h3-prompt-pipeline ⑧ 的失败形态）。
  // 宁可保留含残留 CJK 的原文交给下游 zhNamesToEn + stripResidualCjk 处理，也不整句报废。
  const rescued = {}
  for (const k of FIELDS) {
    const v = String(result[k] || '').trim()
    rescued[k] = v && hasLeaked(v) ? pickInjectableEnglish(v) : v
  }
  // 首尾状态走「原样保留 + 下游剥残」通道，不经过 pickInjectableEnglish
  for (const k of ['world_state_en', 'world_state_end_en']) {
    rescued[k] = String(result[k] || '').trim()
  }
  return FIELDS.some((k) => rescued[k]) ? { ...rescued, failed: false } : null
}

export async function translateShotFields(shot = {}, ctx = {}) {
  const { characterNames = [], sceneNames = [], voiceClone = false, voicedNames = [], wordBudget = null } = ctx

  const dlgRaw = shot.dialogue
  const dlgArr = Array.isArray(dlgRaw) ? dlgRaw : (dlgRaw && typeof dlgRaw === 'object' ? [dlgRaw] : [])
  const toneList = dlgArr.map((x) => String(x?.tone || '').trim()).filter(Boolean)

  // 首尾状态与含中文的末帧分别接入出片链路，禁止把末态复用成首态。
  const worldStateRaw = String(shot.world_state_in || shot.worldStateIn || '').replace(/@/g, '').trim()
  const worldStateEndRaw = String(shot.world_state_out || shot.worldStateOut || '').replace(/@/g, '').trim()
  const finalFrameRaw = String(shot.final_frame || shot.finalFrame || '').replace(/@/g, '').trim()
  const finalFrameNeedsTranslate = finalFrameRaw && CJK_DIRTY_RE.test(finalFrameRaw)
  // 首尾状态的英文副本（2026-09-27）：分镜阶段已落库的英文优先，命中即直用、不再送 LLM 盲翻。
  // 中文源走 LLM 时看不到前后镜上下文，会把「停步」翻成 paused、把「面向」漏成中英混排
  // （实测 1-2/1-3 compiled_prompt），而分镜那一刻 LLM 上下文最全、英文语义最准。
  const worldStateInEnRaw = String(shot.world_state_in_en || shot.worldStateInEn || '').trim()
  const worldStateOutEnRaw = String(shot.world_state_out_en || shot.worldStateOutEn || '').trim()
  const worldStateProvided = Boolean(worldStateInEnRaw && !CJK_DIRTY_RE.test(worldStateInEnRaw))
  const worldStateEndProvided = Boolean(worldStateOutEnRaw && !CJK_DIRTY_RE.test(worldStateOutEnRaw))
  // 库内已有合规英文时，从中文源里摘掉对应字段：既省一次无谓翻译，也避免 LLM 产出被丢弃后
  // 仍被判「含中文」而触发重试/降级（原逻辑会因中文源必然产出中文而误判整批失败）。
  const cnWorldState = worldStateProvided ? '' : worldStateRaw
  const cnWorldStateEnd = worldStateEndProvided ? '' : worldStateEndRaw

  const cacheKey = JSON.stringify({
    d: shot.description || '',
    a: shot.action_note || shot.actionNote || '',
    s: [shot.overall_soundscape || shot.overallSoundscape, shot.sound_effects || shot.soundEffects].filter(Boolean).join('；'),
    m: shot.non_diegetic_music || shot.nonDiegeticMusic || '',
    t: toneList,
    n: [...characterNames, ...sceneNames],
    vc: voiceClone ? voicedNames : false,
    wb: wordBudget?.descActionMax ?? 0, // 预算进缓存键：同文本不同预算须重译，否则收缩预算会命中旧长译文
    w: cnWorldState,
    we: cnWorldStateEnd,
    f: finalFrameNeedsTranslate ? finalFrameRaw : '',
    // 库内英文副本进缓存键：中文相同但英文副本变了（重新分镜/人工编辑）必须重译，
    // 否则会命中「按中文源缓存」的旧结果，把已落库的英文副本覆盖回 LLM 盲翻版本
    wi: worldStateProvided ? worldStateInEnRaw : '',
    wo: worldStateEndProvided ? worldStateOutEnRaw : '',
  })

  if (translationCache.has(cacheKey)) return translationCache.get(cacheKey)

  const cn = {
    description: String(shot.description || '').replace(/@/g, '').trim(),
    actionNote: String(shot.action_note || shot.actionNote || '').trim(),
    soundscape: [shot.overall_soundscape || shot.overallSoundscape, shot.sound_effects || shot.soundEffects].filter(Boolean).join('；').trim(),
    music: String(shot.non_diegetic_music || shot.nonDiegeticMusic || '').trim(),
    tone: toneList.join('，'),
    worldState: cnWorldState,
    worldStateEnd: cnWorldStateEnd,
    finalFrame: finalFrameNeedsTranslate ? finalFrameRaw : '',
  }

  const empty = { description_en: '', action_note_en: '', soundscape_en: '', music_en: '', tone_en: '', world_state_en: '', world_state_end_en: '', final_frame_en: '', failed: false }
  // 降级壳仍要带上库内英文副本：LLM 全挂时这两句是首帧/末帧构图约束的唯一英文源，
  // 不能跟着一起丢（否则回到「LLM 掉线 = 首尾约束整段消失」的老问题）
  const emptyWithProvided = {
    ...empty,
    world_state_en: worldStateProvided ? worldStateInEnRaw : '',
    world_state_end_en: worldStateEndProvided ? worldStateOutEnRaw : '',
  }

  if (!cn.description && !cn.actionNote && !cn.soundscape && !cn.music && !cn.tone && !cn.worldState && !cn.worldStateEnd && !cn.finalFrame) {
    translationCache.set(cacheKey, emptyWithProvided)
    return emptyWithProvided
  }

  const nameList = [...characterNames, ...sceneNames].filter(Boolean).map((n) => `- ${n}`).join('\n')

  // 预算制（buildShotVideoPromptV4 两遍组装传入）：本镜参考素材多、detailed_description
  // 可用空间有限时，按预算收缩扩写——API 7000 字符硬上限优先于 350-500 词质量区间。
  const budgetNote = wordBudget?.descActionMax
    ? `\n【本次词数预算】本镜参考素材较多、detailed_description 可用空间有限，此预算优先于系统提示词的默认词数区间：\n- description_en + action_note_en 合计 ≤ ${wordBudget.descActionMax} 英文词。先逐字保住空间关系/朝向与动作时间轴，再按预算压缩景别铺陈与次要细节，宁短勿超\n- soundscape_en ≤ 30 词、music_en ≤ 30 词（原文为空仍返回空字符串）`
    : ''

  const messages = [
    { role: 'system', content: TRANSLATE_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `角色/场景名（保留原文不翻译）：
${nameList || '（无）'}
${voiceClone && voicedNames.length ? `\n音色克隆角色（这些角色的台词由克隆音色朗读，必须遵守规则 7）：${voicedNames.join('、')}\n` : ''}
需要翻译并扩写的内容：
画面描述：${cn.description || '（空）'}
动作说明：${cn.actionNote || '（空）'}
开场状态（0.00s 首帧硬约束，按规则 8 逐字忠实翻译）：${cn.worldState || '（空）'}
收尾状态（本镜结束时必须成立，按规则 9 逐字忠实翻译）：${cn.worldStateEnd || '（空）'}
末帧（含中文时按规则 10 翻译，纯英文则返回空）：${cn.finalFrame || '（空）'}
环境音与画内音效：${cn.soundscape || '（空）'}
配乐：${cn.music || '（空）'}
语气：${cn.tone || '（空）'}${budgetNote}`,
    },
  ]

  const NAME_SAFE = new Set([...characterNames, ...sceneNames].filter(Boolean))

  const hasLeakedChinese = (s) => {
    if (!s) return false
    let probe = s
    for (const n of NAME_SAFE) probe = probe.split(n).join('')
    return CJK_DIRTY_RE.test(probe)
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const msgs = attempt === 0
        ? messages
        : [
            messages[0],
            { role: 'assistant', content: '（上一次输出含中文，请重新输出纯英文 JSON）' },
            { ...messages[1], content: messages[1].content + '\n\n【重要】输出必须是纯英文（角色名/场景名除外），不得出现任何中文描述词。' },
          ]
      const text = await chatCompletion(msgs, {
        temperature: 0.4,
        maxTokens: 2600,
        responseFormat: { type: 'json_object' },
        timeoutMs: config.timeouts.llm.repair,
        usageContext: { task: 'h3-prompt-translate' },
      })
      // 实测部分模型在 json_object 模式下仍偶发包裹 ```json 围栏（2026-10-01 回填验证抓出），
      // 不剥则 JSON.parse 整次失败、全部字段跟着降级为空——剥围栏是纯防御性清洗，无行为变化。
      const parsed = JSON.parse(String(text || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim())
      const result = {
        description_en: String(parsed.description_en || '').trim(),
        action_note_en: String(parsed.action_note_en || '').trim(),
        soundscape_en: String(parsed.soundscape_en || '').trim(),
        music_en: String(parsed.music_en || '').trim(),
        tone_en: String(parsed.tone_en || '').trim(),
        // 首尾状态：库内英文副本优先于 LLM 盲翻结果（见上方 worldStateProvided 注释）
        world_state_en: worldStateProvided ? worldStateInEnRaw : String(parsed.world_state_en || '').trim(),
        world_state_end_en: worldStateEndProvided ? worldStateOutEnRaw : String(parsed.world_state_end_en || '').trim(),
        final_frame_en: String(parsed.final_frame_en || '').trim(),
        failed: false,
      }
      const leaked = hasLeakedChinese(result.description_en)
        || hasLeakedChinese(result.action_note_en)
        || hasLeakedChinese(result.soundscape_en)
        || hasLeakedChinese(result.music_en)
        || hasLeakedChinese(result.tone_en)
        || hasLeakedChinese(result.world_state_en)
        || hasLeakedChinese(result.world_state_end_en)
        || hasLeakedChinese(result.final_frame_en)
      if (leaked) {
        console.warn(`[h3PromptTranslator] 第 ${attempt + 1} 次翻译输出含中文，${attempt === 0 ? '重试' : '先试删残救济'}`)
        if (attempt === 0) continue
        const rescued = rescueLeakedFields(result, hasLeakedChinese)
        if (rescued) {
          console.warn('[h3PromptTranslator] 两次翻译仍含中文，已删残救济保住英文主体（残留 CJK 已剔除）')
          translationCache.set(cacheKey, rescued)
          return rescued
        }
        console.warn('[h3PromptTranslator] 第 2 次翻译仍含中文且删残后无英文主体，放弃并降级')
        recordAlert({
          episodeId: shot.episode_id ?? null, shotId: shot.id ?? null, shotNumber: shot.shot_number || '',
          source: 'translate', level: 'warn',
          message: `镜 ${shot.shot_number || '?'} 的分镜字段翻译两次仍含中文、删残后无英文主体，已降级为空：本镜出片 prompt 将缺画面/动作/声景描述，请人工核对原文后重试`,
          detail: JSON.stringify({ leakedFields: ['description_en', 'action_note_en', 'soundscape_en', 'music_en', 'tone_en', 'world_state_en', 'world_state_end_en', 'final_frame_en'].filter((k) => hasLeakedChinese(result[k])) }).slice(0, 2000),
        })
        const degraded = { ...emptyWithProvided, failed: true }
        translationCache.set(cacheKey, degraded)
        return degraded
      }
      translationCache.set(cacheKey, result)
      return result
    } catch (e) {
      console.warn(`[h3PromptTranslator] 第 ${attempt + 1} 次翻译失败:`, e.message)
      if (attempt === 0) continue
      const degraded = { ...emptyWithProvided, failed: true }
      translationCache.set(cacheKey, degraded)
      return degraded
    }
  }

  const degraded = { ...emptyWithProvided, failed: true }
  translationCache.set(cacheKey, degraded)
  return degraded
}

const parseDialogueLines = (raw) => {
  if (!raw) return []
  let o = raw
  if (typeof raw === 'string') {
    try { o = JSON.parse(raw) } catch { return [] }
  }
  if (!o) return []
  if (Array.isArray(o)) return o.filter((x) => x && typeof x === 'object')
  return typeof o === 'object' ? [o] : []
}

const cleanSpeakerName = (s) => String(s || '').replace(/@/g, '').replace(/\s+/g, ' ').trim()

export function buildGlobalSpeakerMap(shotsInOrder = []) {
  const map = new Map()
  for (const shot of Array.isArray(shotsInOrder) ? shotsInOrder : []) {
    for (const d of parseDialogueLines(shot?.dialogue)) {
      const who = cleanSpeakerName(d?.character || d?.speaker || d?.name)
      const text = cleanSpeakerName(d?.text || d?.line || d?.content)
      if (!who || !text) continue
      if (!map.has(who)) map.set(who, 'S' + (map.size + 1))
    }
  }
  return map
}
