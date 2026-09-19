/**
 * 导演核 · 剧本层
 * ============================================================================
 * 立场：**标注是可选增益，不是必需输入。**
 *
 * 剧本被当成一份"给导演看的文档"来对待：它必须同时携带三样东西，
 * 缺一样，分镜就只能靠猜——
 *   1. 空间（在哪，方位如何，观众站在哪一侧）
 *   2. 意图（谁想要什么，被什么挡住，最后选了哪条路）
 *   3. 时间（节拍，也就是"发生了什么"的有序列表）
 *
 * 本层支持两种输入，且**优先读作者已经写下的东西**：
 *
 *   A. 生产剧本格式（本项目现行）——信息本来就在里面，只是从前的内核当普通文本读了：
 *        【风格与声音设定】 / 【台词语声档案】 / 人物表        → 全片级设定
 *        场次1：雪山边界 · 悬崖 · 中景 → 大全景 · 清晨         → 空间 + 景别走向 + 时间
 *        空间关系：雪线边缘，一条窄窄的下山道贴着峭壁盘旋而下…   → 轴线与空间锚定的依据
 *        〔钩子〕 大白熊刚要迈步，一块碎石忽然从崖壁上的乱石坡滚落… → 作者亲手标的强制切点
 *        一二（扒着熊耳朵站起来，朝对岸一指，眼睛亮亮）          → 说话人 + 动作提示
 *        看！林子的那边！                                    → 台词（下一行）
 *
 *   B. 导演标注格式（renderScreenplay 的输出）——游戏规则显式写出来：
 *        场 01 · 珊瑚浅滩 · 傍晚 · 外
 *        @轴线 一二 ←→ 布布
 *        @锚点 礁石群（画面右）、木栈道
 *        @基调 舒缓 → 紧张
 *        节拍 01 | 一二在浅水里踩水，布布坐在岸边礁石上看着
 *
 * 两样都没有时（纯裸本），本层会自动推断，推断结果标 provenance='inferred'，人可覆盖。
 * 任何无法识别的行都不会被丢弃：它们进入 scene.body，照样会被事件抽取器读。
 */

import { DEFAULT_TONE, TONE_PROFILES, DANGER_MARKERS, DISCOVERY_MARKERS, ACTION_CLASSES, SIZE_ORDER } from './ontology.js'

/* ==========================================================================
 * 常量
 * ========================================================================== */

const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }

function cn2num(s) {
  const t = String(s || '').trim()
  if (!t) return NaN
  if (/^\d+$/.test(t)) return Number(t)
  if (t.includes('十')) {
    const [a, b] = t.split('十')
    return (a ? CN_NUM[a] || 1 : 1) * 10 + (b ? CN_NUM[b] || 0 : 0)
  }
  let n = 0
  for (const ch of t) n = n * 10 + (CN_NUM[ch] || 0)
  return n || NaN
}

/**
 * 场次头。必须能认「场次1」也能认「场次一」（本项目第 1 集用中文数字）。
 * 注意 (?:场次|场|第) 的次序不可颠倒：正则择先匹配，写「场」在前会把「场次一」
 * 吃成「场」+「次一」，中文数字分支随即失配，整场戏直接消失。
 * 另加两道护栏：场次头必须短、且不含句末标点（否则正文里提一句"场次四~八…"就会凭空长出场景）。
 */
const SCENE_HEAD_RE = /^(?:#{1,6}\s*)?(?:场次|场|第)\s*([0-9]+|[一二三四五六七八九十]+)\s*场?\s*[·:：.\-–—|]?\s*([^。！？!?]{0,60})$/
const SCENE_HEAD_EN_RE = /^\s*(?:#{1,6}\s*)?(INT\.?|EXT\.?|INT\/EXT\.?|内景|外景|室内|室外)\s*[.。]?\s*[-－—]?\s*([^。！？!?]{0,60})$/
/** 场次标题里的分隔符：场 01 · 珊瑚浅滩 · 傍晚 · 外 */
const SCENE_TITLE_SEP = /\s*[·|｜]\s*/
/** 钩子标记：作者亲手标的剧情转折点 */
const HOOK_RE = /〔\s*钩子\s*〕/

/** 环境锚物后缀 —— 判定"什么算一个不动的空间参照" */
const ANCHOR_SUFFIX = /(?:石|岩|树|门|窗|桌|椅|船|桥|墙|柱|灯|岸|崖|山|河|湖|海|路|台阶|栈道|栏杆|礁|滩|坡|井|塔|牌|栅|篱|梁|檐)$/
/** 地点后缀 —— 用于从标题或正文里认出"空间名" */
const PLACE_SUFFIX = /(?:房|屋|室|厅|院|楼|馆|店|铺|厂|仓|站|港|渡|街|巷|路|道|桥|滩|岸|崖|山|谷|林|森|原|野|田|湖|河|海|江|溪|洞|窟|塔|台|场|园|廊|阁|营|城|镇|村|庄|岛|湾|地|界|口|边|缘)$/
const TIME_OF_DAY = ['清晨', '早晨', '上午', '正午', '中午', '午后', '下午', '傍晚', '黄昏', '入夜', '夜幕', '夜', '深夜', '凌晨', '黎明', '翌日', '日']
const INT_EXT_WORDS = ['内', '外', '内外']
const SIZE_RE = new RegExp(`(${SIZE_ORDER.join('|')})`, 'g')

/* ==========================================================================
 * 一、解析：文本 → 结构化剧本
 * ========================================================================== */

/**
 * @returns {{ scenes: Array, settings: Object, cast: Array, meta: Object }}
 * scene = {
 *   index, title, space, placeParts, timeOfDay, intExt,
 *   sizePlan: string[],            // 场次头里的景别走向，如 ['中景','大全景']
 *   spaceRelation: string,         // 「空间关系：」原文
 *   axis: { a, b, provenance } | null,
 *   principals: string[],
 *   anchors: string[],
 *   toneCurve: string[],
 *   beats: [{ index, text, provenance, hook }],
 *   hooks: string[],
 *   actionLines, props, lines,
 *   body,                          // 未归类正文（事件抽取仍会读它）
 *   provenance: 'authored'|'inferred'
 * }
 */
export function parseScreenplay(text) {
  const src = String(text || '').replace(/\r\n?/g, '\n')
  const rawLines = src.split('\n').map((l) => l.trim())

  const scenes = []
  const preLines = []
  let cur = null

  const push = () => { if (cur) scenes.push(finalizeScene(cur, scenes.length + 1)) }

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]
    if (!line) continue

    /* ---- 场次头 ---- */
    let m = line.match(SCENE_HEAD_RE)
    if (m && !/^(?:@|节拍|beat)/i.test(line)) {
      push()
      cur = blankScene()
      cur.declaredNumber = cn2num(m[1])
      cur.headerRaw = (m[2] || '').trim()
      continue
    }
    m = line.match(SCENE_HEAD_EN_RE)
    if (m) {
      push()
      cur = blankScene()
      cur.intExtRaw = m[1].replace(/\./g, '')
      cur.headerRaw = (m[2] || '').trim()
      continue
    }

    /* ---- 幕前设定块：全片级信息，不属于任何场次 ---- */
    if (!cur) { preLines.push(line); continue }

    /* ---- 空间关系：作者写好的空间锚定 ----
       它**不能进 body**。body 是"发生了什么"，空间关系是"这里是什么样"——
       混在一起，「冰河轰鸣」「断桥横跨」就会被抽成动作事件，凭空长出镜头。 */
    const sr = line.match(/^空间关系\s*[:：]\s*(.+)$/)
    if (sr) { cur.spaceRelation = sr[1].trim(); continue }

    /* ---- 标注行 ---- */
    if (line.startsWith('@') || /^【(空间|轴线|基调|锚点|道具|台词|行动)】/.test(line)) {
      parseAnnotation(cur, line)
      continue
    }

    /* ---- 钩子：作者亲手标的转折点，是最可靠的强制切镜信号 ---- */
    if (HOOK_RE.test(line)) {
      for (const h of extractHooks(line)) if (!cur.hooks.includes(h)) cur.hooks.push(h)
      // 钩子段落照常进正文 —— 危险/发现的动作用词都在里面，事件抽取必须读到
    }

    /* ---- 节拍行 ---- */
    if (/^(?:节拍|beat)\s*\d*/i.test(line) || /^[-*·•]\s+/.test(line) || /^\d+\s*[、.)）]\s*/.test(line)) {
      const t = line
        .replace(/^(?:节拍|beat)\s*\d*\s*[|｜:：]?\s*/i, '')
        .replace(/^[-*·•]\s+/, '')
        .replace(/^\d+\s*[、.)）]\s*/, '')
        .trim()
      if (t) { cur.beats.push({ text: t, provenance: 'authored' }); continue }
    }

    /* ---- 台词：两种写法都要认 ----
       ① 一行式：布布（急）：一二，回来！
       ② 两行式（本项目现行写法）：
            一二（扒着熊耳朵站起来，朝对岸一指，眼睛亮亮）
            看！林子的那边！
          说话提示行单独成行、不加冒号，下一非空行才是台词。
          提示行本身含真实动作（站起来、朝对岸一指），要进正文；
          台词文本本身不进正文 —— 否则「看！…」会被当成一个"看见"事件重复计一次。 */
    const cue = line.match(/^([^\s：:（）()【】〔〕]{1,10})\s*[（(]([^）)]{0,80})[）)]$/)
    if (cue && looksLikeSpeaker(cue[1])) {
      const ni = nextNonEmpty(rawLines, i + 1)
      const nextLine = ni >= 0 ? rawLines[ni] : ''
      if (nextLine && !isStructuralLine(nextLine) && nextLine.length <= 60) {
        cur.lines.push({
          character: cue[1].trim(),
          tone: '',
          action: cue[2].trim(),
          text: nextLine.replace(/^[「『"“]|[」』"”]$/g, ''),
          provenance: 'authored',
        })
        cur.body += `\n${line}`
        i = ni
        continue
      }
    }
    const dm = line.match(/^([^：:（）()【】〔〕]{1,12})\s*(?:[（(]([^）)]{1,40})[）)])?\s*[：:]\s*(.{1,200})$/)
    if (dm && looksLikeSpeaker(dm[1])) {
      cur.lines.push({ character: dm[1].trim(), tone: (dm[2] || '').trim(), text: dm[3].trim(), provenance: 'authored' })
      cur.body += `\n${line}`
      continue
    }

    cur.body += `\n${line}`
  }
  push()

  const metaInfo = parsePreamble(preLines)

  const meta = { warnings: [] }
  for (const s of scenes) {
    if (!s.axis?.a) meta.warnings.push(`场 ${s.index}「${s.title}」未声明轴线，且未能从正文推断出主体`)
    else if (s.axis.provenance === 'inferred') meta.warnings.push(`场 ${s.index}「${s.title}」轴线为推断值（${s.axis.a} ←→ ${s.axis.b || '—'}），建议人工确认`)
    if (!s.beats.length) meta.warnings.push(`场 ${s.index}「${s.title}」没有任何节拍，整场将退化为单个环境镜头`)
  }

  return { scenes, settings: metaInfo.settings, cast: metaInfo.cast, voiceProfiles: metaInfo.voiceProfiles, meta }
}

function blankScene() {
  return {
    declaredNumber: null,
    headerRaw: '',
    intExtRaw: '',
    title: '',
    space: '',
    placeParts: [],
    timeOfDay: '',
    intExt: '',
    sizePlan: [],
    spaceRelation: '',
    axis: null,
    principals: [],
    anchors: [],
    toneCurve: [],
    beats: [],
    hooks: [],
    actionLines: [],
    props: [],
    lines: [],
    body: '',
    provenance: 'authored',
  }
}

/* ==========================================================================
 * 幕前设定块：【风格与声音设定】/【台词语声档案】/人物表
 * --------------------------------------------------------------------------
 * 这三块是全片级的，从前它们只是"剧本开头的一段话"。
 * 实际上：声音设定直接就是音频三层（画内/环境/配乐）的分布规则；
 * 声语档案直接决定台词该怎么拆、语气标成什么；
 * 人物表就是资产清单的雏形。
 * ========================================================================== */

function parsePreamble(lines) {
  const settings = { visual: '', sound: '', conflict: '', raw: lines.join('\n') }
  const cast = []
  const voiceProfiles = {}
  let mode = ''

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (/^【\s*风格与声音设定\s*】/.test(line)) { mode = 'style'; continue }
    if (/^【\s*台词语声档案\s*】/.test(line)) { mode = 'voice'; continue }
    if (/^人物表/.test(line)) { mode = 'cast'; continue }

    const item = line.replace(/^[-*·•]\s*/, '')
    const kv = item.match(/^([^：:]{1,12})\s*[:：]\s*(.+)$/)

    if (mode === 'style' && kv) {
      const k = kv[1].trim()
      const v = kv[2].trim()
      if (k === '视觉') settings.visual = v
      else if (k === '声音') settings.sound = v
      else if (k === '冲突设计') settings.conflict = v
      continue
    }
    if (mode === 'voice' && kv) { voiceProfiles[kv[1].trim()] = kv[2].trim(); continue }
    if (mode === 'cast' && kv) {
      cast.push({ name: kv[1].trim(), description: kv[2].trim() })
      continue
    }
    // 兜底：未归类的设定行并进 conflict，宁多不少
    if (mode === 'style' && item) settings.conflict += (settings.conflict ? ' ' : '') + item
  }
  return { settings, cast, voiceProfiles }
}

/* ==========================================================================
 * 台词提示行 / 结构行 判定
 * ========================================================================== */

function nextNonEmpty(lines, from) {
  for (let i = from; i < lines.length; i++) if (lines[i]) return i
  return -1
}

function isStructuralLine(s) {
  return SCENE_HEAD_RE.test(s) || SCENE_HEAD_EN_RE.test(s) || HOOK_RE.test(s)
    || /^空间关系\s*[:：]/.test(s) || s.startsWith('@') || s.startsWith('【')
}

function extractHooks(line) {
  const out = []
  const re = /〔\s*钩子\s*〕([^〔]*)/g
  let m
  while ((m = re.exec(line))) {
    const t = m[1].trim().replace(/[。！？\s]+$/, '')
    if (t) out.push(t)
  }
  return out
}

/* ==========================================================================
 * 二、收敛：补齐作者没写、但切镜必须知道的字段
 * --------------------------------------------------------------------------
 * 顺序很重要：锚点与道具必须先于轴线确定，否则锚物/道具名会被人名识别抢走。
 * ========================================================================== */

export function finalizeScene(cur, index) {
  const s = cur
  s.index = index

  /* ---- 场次头：空间 / 时间 / 内外 / 景别走向 ---- */
  const headParts = String(s.headerRaw || '').split(SCENE_TITLE_SEP).map((x) => x.trim()).filter(Boolean)
  const sizeHits = String(s.headerRaw || '').match(SIZE_RE)
  if (sizeHits?.length) s.sizePlan = [...new Set(sizeHits)]

  s.placeParts = headParts.filter((p) => !TIME_OF_DAY.some((t) => p.includes(t)) && !(/景|特写/.test(p)))
  s.title = s.placeParts[0] || s.space || `场次${index}`
  if (!s.space) s.space = s.placeParts[0] || guessPlace(s) || s.title
  if (!s.timeOfDay) s.timeOfDay = headParts.find((p) => TIME_OF_DAY.some((t) => p.includes(t))) || guessTime(s)
  if (!s.intExt) s.intExt = headParts.find((p) => INT_EXT_WORDS.includes(p)) || s.intExtRaw || guessIntExt(s)

  /* ---- 节拍：作者显式写了就用；否则按段落推断（钩子段落强制成拍） ---- */
  if (!s.beats.length) {
    // 一行式台词已经从正文摘除；这里再兜一次两行式可能残留的说话人前缀
    let bodyForBeats = s.body
    for (const l of s.lines) {
      if (!l.text) continue
      const raw = l.text.replace(/[「」『』]/g, '')
      bodyForBeats = bodyForBeats.split(`${l.character}：${l.text}`).join(' ')
      bodyForBeats = bodyForBeats.split(`${l.character}：${raw}`).join(' ')
      bodyForBeats = bodyForBeats.split(`${l.character}:${raw}`).join(' ')
    }
    s.beats = splitBodyIntoBeats(bodyForBeats)
    if (s.beats.length) s.provenance = 'inferred'
  }
  s.beats = s.beats.map((b, i) => ({ ...b, index: i + 1 }))

  /* ---- 锚点：优先用作者写的「空间关系」，其次从正文里找环境参照物 ---- */
  if (!s.anchors.length) {
    const found = []
    const hay = `${s.spaceRelation}\n${s.body}\n${s.beats.map((b) => b.text).join('\n')}`
    for (const w of tokenizeNouns(hay)) {
      if (ANCHOR_SUFFIX.test(w) && w.length <= 6 && !found.includes(w)) found.push(w)
    }
    // 场次头里除第一个之外的地点词，也是天然的锚点（"雪山边界 · 悬崖"里的"悬崖"）
    for (const p of s.placeParts.slice(1)) if (!found.includes(p)) found.unshift(p)
    s.anchors = found.slice(0, 4)
  }

  /* ---- 道具（先于轴线：道具名不能被人名识别抢走） ---- */
  if (!s.props.length) s.props = guessProps(s)

  /* ---- 主体名册与轴线 ---- */
  const names = frequentSubjects(s)
  if (names.length) s.principals = names.slice(0, 3)
  if (!s.axis) {
    if (names.length >= 2) s.axis = { a: names[0], b: names[1], provenance: 'inferred' }
    else if (names.length === 1) s.axis = { a: names[0], b: '', provenance: 'inferred' }
    else s.axis = { a: '', b: '', provenance: 'inferred' }
  }

  /* ---- 基调：钩子段落强制成紧张/危险，其余按张力词密度 ---- */
  if (!s.toneCurve.length) s.toneCurve = inferToneCurve(s)
  s.toneCurve = s.toneCurve.filter((t) => TONE_PROFILES[t]).length ? s.toneCurve : [DEFAULT_TONE]

  /* ---- 行动线兜底 ---- */
  if (!s.actionLines.length) s.actionLines = inferActionLines(s)

  return s
}

/**
 * 正文 → 节拍。
 * 关键改动：**按段落切，而不是把所有行连成一片**。
 * 因为在这个项目的剧本里，"一段"就是作者心里的一场连续动作；
 * 把段与段连起来再按句号切，会让两段之间的转场被算成同一节拍，凭空少一次切镜机会。
 * 钩子段落用句末标点替换掉标记本身，保证转折点自成一拍。
 */
function splitBodyIntoBeats(body) {
  const paras = String(body || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('@'))

  const out = []
  paras.forEach((para, pi) => {
    const isHook = HOOK_RE.test(para)
    // 说话提示行（「一二（扒着熊耳朵站起来，朝对岸一指）」）本身就是正文的一段。
    // 把它标成"这个角色的台词位"，台词就能**按原文位置**挂上去，
    // 而不是靠"名字出现过"去猜 —— 那样会把台词整段提前到错误的镜头里。
    const cueM = para.match(/^([^\s：:（）()【】〔〕]{1,10})\s*[（(][^）)]{0,80}[）)]/)
    const cueChar = cueM ? cueM[1].trim() : ''
    const text = para.replace(new RegExp(HOOK_RE.source, 'g'), '。')
    let lastOfThisPara = null
    for (const seg of text.split(/[。！？!?；;]+/).map((x) => x.trim()).filter(Boolean)) {
      // 过短片段并入**同一段**的前一句。绝不跨段合并：
      // 段落是作者亲手划分的镜头单位，跨段合并等于把两个镜头粘成一个。
      if (lastOfThisPara && seg.length < 6) {
        lastOfThisPara.text += `，${seg}`
        if (isHook) lastOfThisPara.hook = true
      } else {
        const beat = { text: seg, provenance: 'inferred', hook: isHook, para: pi }
        if (!lastOfThisPara && cueChar) beat.cue = cueChar
        out.push(beat)
        lastOfThisPara = beat
      }
    }
  })
  return out
}

/** 粗分词：只取连续汉字串（够用且不引入分词依赖） */
function tokenizeNouns(text) {
  const out = new Set()
  const re = /[\u4e00-\u9fa5]{2,8}/g
  let m
  while ((m = re.exec(String(text || '')))) out.add(m[0])
  return [...out]
}

function guessPlace(s) {
  const hay = `${s.title} ${s.spaceRelation} ${s.body}`
  for (const w of tokenizeNouns(hay)) if (PLACE_SUFFIX.test(w) && w.length <= 6) return w
  return ''
}
function guessTime(s) {
  const hay = `${s.title} ${s.headerRaw} ${s.body}`
  return TIME_OF_DAY.find((t) => hay.includes(t)) || ''
}
function guessIntExt(s) {
  if (/(屋|房|室|厅|舱|车|店|楼|内)/.test(`${s.title}${s.space}`)) return '内'
  if (/(滩|岸|山|路|野|林|街|广场|外)/.test(`${s.title}${s.space}`)) return '外'
  return ''
}

/**
 * 本场出场主体（用于推断轴线两端）。
 * 三路证据加权：① 台词说话人（最可信）② 动作发生者 ③ 高频实义 gram。
 * 排除项很关键：道具名、锚点、含动作词的 gram、含功能字的 gram —— 都不是人名。
 */
function frequentSubjects(s) {
  const freq = new Map()
  const bump = (k, n) => { if (k) freq.set(k, (freq.get(k) || 0) + n) }

  for (const l of s.lines) if (l.character) bump(l.character, 100)
  for (const a of s.actionLines || []) if (a.subject) bump(a.subject, 60)
  for (const p of s.props || []) if (p.owner) bump(p.owner, 40)

  const propNames = new Set((s.props || []).map((p) => p.name))
  const actionWords = Object.values(ACTION_CLASSES).flatMap((d) => d.words)
  const hay = `${(s.beats || []).map((b) => b.text).join('。')}。${s.spaceRelation}。${s.body}`

  for (const seg of hay.split(/[^\u4e00-\u9fa5]+/)) {
    for (const n of [2, 3]) {
      for (let i = 0; i + n <= seg.length; i++) {
        const g = seg.slice(i, i + n)
        if (FUNCTION_CHARS_RE.test(g)) continue
        if (propNames.has(g)) continue
        if (actionWords.some((w) => g.includes(w))) continue
        if ((s.anchors || []).some((a) => g.includes(a) || a.includes(g))) continue
        bump(g, 1)
      }
    }
  }

  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
  const picked = []
  for (const [name, n] of sorted) {
    if (n < 2) continue
    if (picked.some((p) => p.includes(name) || name.includes(p))) continue
    picked.push(name)
    if (picked.length >= 3) break
  }
  return picked
}

const FUNCTION_CHARS_RE = /[的了着过是在有和与把被给从对向到又只都也还很就才而且但如若不没为以们这那已经将正会能要想使让被]/

/**
 * 基调推断：逐拍打分 → 平滑 → 段化。
 *
 * 为什么必须平滑：基调是**节奏参数**（它决定镜头时长与运镜倾向）。
 * 一个"平稳/紧张"来回横跳的基调，等于让镜头每分钟变一次速度，
 * 而且每次跳到"紧张"都会触发危险闸门 —— 实测这样能让一集多长出几十个镜头。
 * 基调是一条曲线，不是一串闪烁。
 */
function inferToneCurve(s) {
  const beats = s.beats
  if (!beats.length) return [DEFAULT_TONE]

  let score = beats.map(tensionOf)

  /* 平滑一：中值滤波（±1 窗）。单拍的孤立尖峰不是基调，只是句子里有一个词。 */
  score = score.map((_, i) => {
    const win = [score[i - 1], score[i], score[i + 1]].filter((x) => typeof x === 'number')
    win.sort((a, b) => a - b)
    return win[Math.floor(win.length / 2)]
  })

  /* 平滑二：太短的段并入相邻更温和的一段（把尖峰磨平，而不是把平静段拉高）。 */
  const MIN_RUN = Math.max(2, Math.round(beats.length * 0.15))
  for (let pass = 0; pass < 8; pass++) {
    const runs = runsOf(score)
    if (runs.length <= 1) break
    const si = runs.findIndex((r) => r.len < MIN_RUN)
    if (si < 0) break
    const left = runs[si - 1]
    const right = runs[si + 1]
    const target = !left ? right : !right ? left : (left.value <= right.value ? left : right)
    if (!target) break
    for (let i = target.start; i < target.start + target.len; i++) score[i] = target.value
    for (let i = runs[si].start; i < runs[si].start + runs[si].len; i++) score[i] = target.value
  }

  const curve = []
  for (const r of runsOf(score)) {
    const name = r.value >= 2 ? '危险' : r.value >= 1 ? '紧张' : DEFAULT_TONE
    if (curve[curve.length - 1] !== name) curve.push(name)
  }
  return curve.length ? curve : [DEFAULT_TONE]
}

/** 单拍紧张度：0 平静 / 1 紧绷 / 2 危险 */
function tensionOf(b) {
  const t = b.text || ''
  const danger = DANGER_MARKERS.filter((w) => t.includes(w)).length
  const disc = DISCOVERY_MARKERS.filter((w) => t.includes(w)).length
  if (danger >= 2) return 2
  if (danger >= 1) return 1
  if (b.hook) return 1          // 作者亲手标的转折点，默认是紧绷的
  if (disc >= 1) return 1
  return 0
}

function runsOf(score) {
  const runs = []
  for (let i = 0; i < score.length; i++) {
    const last = runs[runs.length - 1]
    if (last && last.value === score[i]) last.len++
    else runs.push({ value: score[i], start: i, len: 1 })
  }
  return runs
}

function inferActionLines(s) {
  const out = []
  for (const name of (s.principals || []).slice(0, 3)) {
    out.push({ subject: name, want: '', obstacle: '', choice: '', provenance: 'inferred' })
  }
  if (!out.length && s.axis?.a) out.push({ subject: s.axis.a, want: '', obstacle: '', choice: '', provenance: 'inferred' })
  return out
}

function guessProps(s) {
  const owner = s.axis?.a || ''
  const out = []
  for (const w of tokenizeNouns(`${s.body} ${s.spaceRelation}`)) {
    if (w.length >= 2 && w.length <= 4 && /(篮|包|刀|伞|绳|瓶|书|灯|钥|杯|碗|杖|铃|镜|笔|纸|袋|箱|食|水|桥|冰|雪|球|舟|筏)/.test(w)) {
      if (!out.find((p) => p.name === w)) out.push({ name: w, owner, provenance: 'inferred' })
    }
  }
  return out.slice(0, 6)
}

/* ==========================================================================
 * 三、显式标注（@ 开头 / 【】包裹）
 * ========================================================================== */

function parseAnnotation(cur, line) {
  const s = line.replace(/^@/, '').replace(/^【|】$/g, '').trim()
  const m = s.match(/^([^\s:：|｜]{1,6})\s*[|｜:：]?\s*([\s\S]*)$/)
  if (!m) return
  const key = m[1].trim()
  const val = (m[2] || '').trim()
  if (!val && key !== '轴线') return

  switch (key) {
    case '空间': {
      const parts = val.split(SCENE_TITLE_SEP).map((x) => x.trim()).filter(Boolean)
      cur.space = parts[0] || ''
      for (const p of parts.slice(1)) {
        if (TIME_OF_DAY.some((t) => p.includes(t))) cur.timeOfDay = p
        else if (INT_EXT_WORDS.includes(p)) cur.intExt = p
      }
      break
    }
    case '轴线': {
      const parts = val.split(/[←→<>=＝~～\-]+|\s+/).map((x) => x.trim()).filter(Boolean)
      if (parts.length >= 2) cur.axis = { a: parts[0], b: parts[1], note: '', provenance: 'authored' }
      else if (parts.length === 1) cur.axis = { a: parts[0], b: '', note: val, provenance: 'authored' }
      break
    }
    case '锚点': {
      const items = val.split(/[、,，|｜]/).map((x) => x.replace(/[（(].*?[）)]/g, '').trim()).filter(Boolean)
      for (const it of items) if (!cur.anchors.includes(it)) cur.anchors.push(it)
      break
    }
    case '基调': {
      const ts = val.split(/[→>~～\-–—]+/).map((x) => x.trim()).filter(Boolean)
      cur.toneCurve = ts.length ? ts : [val]
      break
    }
    case '行动': {
      const p = val.split(/[|｜]/).map((x) => x.trim())
      cur.actionLines.push({ subject: p[0] || '', want: p[1] || '', obstacle: p[2] || '', choice: p[3] || '', provenance: 'authored' })
      break
    }
    case '道具': {
      const p = val.split(/[|｜]/).map((x) => x.trim())
      cur.props.push({ name: p[0] || '', owner: p[1] || '', provenance: 'authored' })
      break
    }
    case '台词': {
      const p = val.split(/[|｜]/).map((x) => x.trim())
      const sp = (p[0] || '').match(/^([^（(]+)\s*(?:[（(]([^）)]*)[）)])?$/)
      cur.lines.push({
        character: sp ? sp[1].trim() : (p[0] || ''),
        tone: sp ? (sp[2] || '').trim() : '',
        text: (p[1] || '').replace(/^[「『"“]|[」』"”]$/g, ''),
        provenance: 'authored',
      })
      break
    }
    default:
      break
  }
}

const SPEAKER_STOPWORDS = new Set(['音效', '环境声', '配乐', '画外音', '字幕', '旁白', '备注', '说明', '注', '画面', '时间', '地点', '人物', '道具', '景别', '运镜', '空间关系'])
function looksLikeSpeaker(name) {
  const n = String(name || '').trim()
  if (!n || n.length > 8) return false
  if (SPEAKER_STOPWORDS.has(n)) return false
  if (/[。！？!?；;，,]/.test(n)) return false
  return true
}

/* ==========================================================================
 * 四、渲染：结构化剧本 → 规范文本
 * ========================================================================== */

export function renderScreenplay(screenplay) {
  const scenes = Array.isArray(screenplay) ? screenplay : screenplay.scenes
  const out = []
  for (const s of scenes) {
    const head = [`场 ${String(s.index).padStart(2, '0')}`, s.title]
    const metaBits = []
    if (s.space) metaBits.push(s.space)
    if (s.timeOfDay) metaBits.push(s.timeOfDay)
    if (s.intExt) metaBits.push(s.intExt)
    if (s.sizePlan?.length) metaBits.push(s.sizePlan.join(' → '))
    out.push(`# ${head.concat(metaBits).join(' · ')}`)

    if (s.axis?.a) out.push(`@轴线 ${s.axis.a}${s.axis.b ? ` ←→ ${s.axis.b}` : ''}`)
    if (s.anchors?.length) out.push(`@锚点 ${s.anchors.join('、')}`)
    if (s.toneCurve?.length) out.push(`@基调 ${s.toneCurve.join(' → ')}`)
    out.push('')
    for (const b of s.beats) out.push(`节拍 ${String(b.index).padStart(2, '0')} | ${b.hook ? '〔钩子〕' : ''}${b.text}`)
    if (s.actionLines?.length) {
      out.push('')
      for (const a of s.actionLines) out.push(`@行动 ${a.subject} | ${a.want || '—'} | ${a.obstacle || '—'} | ${a.choice || '—'}`)
    }
    if (s.props?.length) {
      out.push('')
      for (const p of s.props) out.push(`@道具 ${p.name} | ${p.owner || '—'}`)
    }
    if (s.lines?.length) {
      out.push('')
      for (const l of s.lines) out.push(`@台词 ${l.character}${l.tone ? `（${l.tone}）` : ''} | ${l.text}`)
    }
    out.push('')
  }
  return out.join('\n').trim() + '\n'
}

/**
 * 生产剧本 → 导演标注本（一步到位）。
 * 这是接入现有链路的适配器：不改剧本正文，只把已经写在里面的信息读出来。
 */
export function annotateScreenplay(rawText) {
  const parsed = parseScreenplay(rawText)
  return { screenplay: parsed, text: renderScreenplay(parsed), meta: parsed.meta }
}
