// 跨场连续性检查器（V18，2026-09-16；通用化重构 2026-09-16 晚）
//
// ===== 这个模块解决什么 =====
//
// 背景：2026-09-16 第2集全维度体检发现，现有三道闸门全在"格式与合规"维度，
// 没有一道查"事理"。用户原始反馈「场1 和场2 的桥一看就是两个地方」——
// 根因不是画错，是场1→场2 之间缺下降过程、雾的去向未交代，且桥的形态
// 在文字层（腐朽木桥）与视觉层（场景图画成石墩桥）之间无任何机制做校验。
// （详见 deliverables/第2集剧本全维度体检_2026-09-16.md 与 剧本事理检查清单_交稿前必过.md）
//
// 与 storyboardValidator.js 的关系：互补，不重叠。
//   - storyboardValidator：**镜级**（单镜字段、景别搭配、台词地板、画风毒词、时间轴）
//   - continuityGuard（本模块）：**场级**（空间锚点、环境状态、物体形态、多源一致）
//
// ===== 通用性架构（重构后：代码零业务词）=====
//
// 本文件只装**算法**——"怎么比较两场戏"。所有"词"都在数据文件里：
//
//   ai/lexicons/zh-CN.js           中文语言包（雾/光/位移/地形等词表 + 分词正则）
//   ai/lexicons/object-forms.zh.js 通用物体形态表（桥/门/船…的材质族）
//
//   词汇来源优先级：
//     ① opts.lexicon       项目注入（最高优先，项目专属地点名与物体）
//     ② opts.languagePack  指定语言包（默认加载 zh-CN）
//     ③ 自动抽取           不传词典时从场景数据归纳（零配置兜底）
//
// 换语言 / 换题材只需替换数据文件或注入词典，算法逻辑一行不动。
//
// ===== 判据维护铁律（六次踩坑换来的，改动前必读）=====
//
// 1. 禁止单字词——单字会命中无关复合词（"碎石"命中"石"、"溪谷"命中"谷"）
// 2. 区分"地点"与"位移"——"溪谷"是地名，"谷底"是层级，混用必误报
// 3. 判据写宽会空转、写窄会误报——改完必须跑三回归：
//      node _audit_continuity_real.mjs     # 真实数据零误报
//      node _audit_continuity_generic.mjs  # 跨题材仍有效
//      node _audit_continuity_regress.mjs  # 历史 bug 仍抓得住

import zhCN from './lexicons/zh-CN.js'
import enUS from './lexicons/en-US.js'
import objectFormsZh from './lexicons/object-forms.zh.js'

// 已内置的语言包（新增语言在此登记）
const LANGUAGE_PACKS = { 'zh-CN': zhCN, 'en-US': enUS }
const DEFAULT_LANG = 'zh-CN'

// 已内置的物体形态内容包（新增题材内容包在此登记）
const OBJECT_FORM_PACKS = { zh: objectFormsZh }

/**
 * 取语言包。
 * @param {string|object} [lang] 语言包 id（如 'zh-CN'）或语言包对象
 */
export function getLanguagePack(lang) {
  if (lang && typeof lang === 'object') return lang
  return LANGUAGE_PACKS[lang || DEFAULT_LANG] || LANGUAGE_PACKS[DEFAULT_LANG]
}

/**
 * 取物体形态内容包。
 * @param {string|object} [pack]
 */
export function getObjectFormPack(pack) {
  if (pack && typeof pack === 'object') return pack
  return OBJECT_FORM_PACKS[pack || 'zh'] || OBJECT_FORM_PACKS.zh
}

// ===================================================================
// 第 1 层 · 词典装配（语言包 + 项目注入 + 自动抽取）
// ===================================================================

/**
 * 从场景数据里自动抽取候选地点词（零配置兜底）。
 *
 * 策略（三轮实测修正后的终版）：
 *   初版：只取标题第一段 + 要求跨场重复 ≥2 → 抽取为空，同地点豁免失效 → 误报。
 *   二版：取标题所有段 + 正文后缀词 → 抽出垃圾片段（"从谷底翻"），污染判断。
 *   三版：只从标题取 + 启发式过滤 → 仍抽整段标题（"冰河边断桥"），
 *         整段不可能跨场复现，共享地点判据恒为空 → 再次误报。
 *   终版：**字符级滑窗**（长段拆 2~4 字子词），使跨场匹配可行。
 *
 * @param {Array} scenes
 * @param {object} opts { hint: string[] 提示词, pack: 语言包 }
 * @returns {string[]}
 */
function autoExtractPlaceNouns(scenes = [], opts = {}) {
  const pack = opts.pack || getLanguagePack()
  const NOISE = new Set(pack.placeNoise || [])
  const BAD_HEAD = pack.placeBadHead
  const PLACE_TAIL = pack.placeTail
  const SEP = pack.separators || /[·\-—/｜|,，、\s]+/

  const counter = new Map()
  const add = (w, weight) => {
    const t = String(w || '').trim()
    if (t.length < 2 || t.length > 8) return
    if (NOISE.has(t)) return
    if (BAD_HEAD && BAD_HEAD.test(t)) return
    const base = weight + (PLACE_TAIL && PLACE_TAIL.test(t) ? 2 : 0)
    counter.set(t, (counter.get(t) || 0) + base)
  }

  // hint 优先（项目已有场景名，最可靠）
  for (const h of (opts.hint || [])) add(h, 10)

  for (const sc of scenes) {
    const t = String(sc?.title || '')
    // 标题按分隔符切段；长段再按 2~4 字滑窗拆子词
    // （实测：标题段常是"冰河边断桥"这样的复合地点名，整段不可能跨场复现，
    //   必须拆成"冰河""断桥"这类可复现的子词。）
    for (const seg of t.split(SEP)) {
      const s = String(seg || '').trim()
      if (s.length >= 2 && s.length <= 8) add(s, 1)
      if (s.length > 4) {
        for (let len = 2; len <= 4; len++) {
          for (let i = 0; i + len <= s.length; i++) add(s.slice(i, i + len), 1)
        }
      }
    }
  }

  return [...counter.entries()].filter(([, n]) => n >= 3).map(([w]) => w)
}

/**
 * 装配最终词典。
 *
 * @param {object} opts
 * @param {object} [opts.lexicon] 项目词典（**覆盖/追加**语言包的同名字段）：
 *   { env:{fog:[],light:[],weather:[]}, verticalTerrain:[], moveVerbs:[], transition:[],
 *     placeNouns:[], objects:{物体:[族1[],族2[]]} }
 * @param {string|object} [opts.languagePack] 语言包 id 或对象（默认 zh-CN）
 * @param {string|object} [opts.objectFormPack] 物体形态内容包（默认 zh）
 * @param {Array}  [opts.scenes] 用于 autoExtract
 * @param {string[]}[opts.placeHint] 地点提示词，提高自动抽取精度
 * @param {boolean}[opts.autoExtract=true] 未提供 lexicon 时是否自动抽取
 * @returns {object} 合并后的词典
 */
export function buildLexicon(opts = {}) {
  const L = opts.lexicon || {}
  const pack = getLanguagePack(opts.languagePack)
  const formPack = getObjectFormPack(opts.objectFormPack)
  const uniq = (...arrs) => [...new Set(arrs.flat().filter(Boolean))]

  const env = {
    fog: uniq(L.env?.fog || [], pack.env?.fog || []),
    light: uniq(L.env?.light || [], pack.env?.light || []),
    weather: uniq(L.env?.weather || [], pack.env?.weather || []),
  }
  const verticalTerrain = uniq(L.verticalTerrain || L.vertical || [], pack.verticalTerrain || [])
  const moveVerbs = uniq(L.moveVerbs || [], pack.moveVerbs || [])
  const transition = uniq(L.transition || [], pack.transition || [])
  const gradualMarkers = uniq(L.gradualMarkers || [], pack.gradualMarkers || [])

  // 地点词：项目注入优先；未注入则自动抽取（可传 hint 提高精度）
  let placeNouns = L.placeNouns || []
  if (!placeNouns.length && opts.autoExtract !== false && Array.isArray(opts.scenes)) {
    placeNouns = autoExtractPlaceNouns(opts.scenes, { hint: opts.placeHint, pack })
  }

  // 物体形态：内容包 + 项目注入（项目同名物体**覆盖**内容包，允许精确化）
  const objects = { ...(formPack || {}) }
  if (L.objects && typeof L.objects === 'object') {
    for (const [k, v] of Object.entries(L.objects)) {
      if (Array.isArray(v) && v.length) objects[k] = v
    }
  }

  // 资产物理状态别名（P2'，2026-09-17）：语言包 stateAliases（稳定键→中文别名数组）
  // + 项目注入（L.stateAliases，同键**合并追加**，允许项目补充剧本专属状态词）。
  // 与 objects 同式的对象合并；词表缺失时为空对象，assetState.normalizeStateKey 退化为 slugify。
  const stateAliases = {}
  const mergeAliases = (src) => {
    if (!src || typeof src !== 'object') return
    for (const [k, v] of Object.entries(src)) {
      const key = String(k || '').trim().toLowerCase()
      if (!key) continue
      const list = Array.isArray(v) ? v : [v]
      const clean = list.map((a) => String(a || '').trim()).filter(Boolean)
      if (!clean.length) continue
      stateAliases[key] = [...new Set([...(stateAliases[key] || []), ...clean])]
    }
  }
  mergeAliases(pack.stateAliases)
  mergeAliases(L.stateAliases)

  // 分词辅助（供抽取与未来扩展使用）
  const separators = pack.separators || /[·\-—/｜|,，、\s]+/

  return {
    env, verticalTerrain, moveVerbs, transition, gradualMarkers, placeNouns, objects, separators,
    lang: pack.id || DEFAULT_LANG,
    // 文案模板与环境族名（供告警构造；语言包的一部分，不进匹配逻辑）
    messages: pack.messages || {},
    familyLabel: pack.familyLabel || {},
    // 资产物理状态别名（稳定键→别名数组；语言知识，见 zh-CN.js stateAliases 段）
    stateAliases,
    // 剧本结构判据（切"位移承接段"等窗口用；同样是语言知识，换语言需换一套）
    structure: L.structure || pack.structure || {},
  }
}

// ===================================================================
// 第 2 层 · 检查实现（全部接受 lexicon，代码内零业务词）
// ===================================================================

/**
 * 从文本抽环境状态。
 * @param {string} text
 * @param {object} lexicon buildLexicon 的产物（必传；不传则无词表可用）
 */
export function extractEnvState(text = '', lexicon) {
  const t = String(text || '')
  const env = lexicon?.env || {}
  const hit = (words) => [...new Set((words || []).filter((w) => t.includes(w)))]
  return {
    fog: hit(env.fog),
    light: hit(env.light),
    weather: hit(env.weather),
  }
}

// ---- 检查 1 · 环境状态跳变 ----
/**
 * 相邻两场同一环境族从"有"变"无"，且本场无过渡交代 → 告警。
 *
 * 判据边界（2026-09-16 真剧本回归修正）：
 * 环境要素消失**未必**是断裂——要分两种情形：
 *   · 换地点（上一场崖顶 → 本场谷底）：环境变化是**空间切换的结果**，必须交代，
 *     否则两场看起来像两个不相干的地方（用户原始反馈就是这个）；
 *   · 同地点（上一场冰河 → 本场冰河）：环境变化是**叙事推进的结果**，不要求交代
 *     （场2 在山脚有雾、场3 移到河面上，镜头焦点转移，观众不会觉得断裂）。
 * 故加"同地点豁免"：两场共享地点词时跳过。
 *
 * 实测噪声来源：第2集场2→场3 因"雾留在半山腰"（那是**山那边**的雾）被判跳变，
 * 而场3 在同一地点（冰河）——属误报。同地点豁免修掉这类。
 */
export function checkEnvTransition(scenes = [], lexicon) {
  const out = []
  const transition = lexicon?.transition || []
  const placeNouns = lexicon?.placeNouns || []
  for (let i = 1; i < scenes.length; i++) {
    const prev = scenes[i - 1]
    const cur = scenes[i]
    if (!prev || !cur) continue
    const a = extractEnvState(prev.text, lexicon)
    const b = extractEnvState(cur.text, lexicon)
    const curText = String(cur.text || '')
    const prevText = String(prev.text || '')

    // 多族同时跳变时**合并为一条**告警：实测中「天台上→大堂下」会同时触发
    // 雾/光/天气三族，报三条是同一件事的噪音。
    const jumped = []
    for (const family of ['fog', 'light', 'weather']) {
      const hadBefore = a[family].length > 0
      const hasNow = b[family].length > 0
      // 只查"有 → 无"：观众最容易察觉断裂的方向。反向通常是新环境建立，视觉更自然。
      if (hadBefore && !hasNow) jumped.push({ family, prevHits: a[family] })
    }
    if (!jumped.length) continue
    if (transition.some((w) => curText.includes(w))) continue

    // 同地点豁免：两场共享地点词 = 同一空间内的叙事推进，环境变化不必交代。
    // 注：与 checkHandoffAnchor 的豁免判据同源但**条件不同**——那里还要排除
    // "跨层位移"（共享"河"字但一个在崖顶一个在谷底），这里不需要：
    // 环境检查关心的是"地点有没有换"，跨层位移已由交接锚点检查覆盖。
    if (placeNouns.some((w) => prevText.includes(w) && curText.includes(w))) continue

    const M = lexicon?.messages || {}
    out.push({
      code: 'ENV_STATE_JUMP',
      scene: cur.sceneNumber,
      message: M.envJump
        ? M.envJump({
            curNo: cur.sceneNumber, prevNo: prev.sceneNumber, jumped,
            familyLabel: lexicon?.familyLabel || {},
          })
        : `[ENV_STATE_JUMP] scene ${prev.sceneNumber}->${cur.sceneNumber}: ` +
          jumped.map((j) => `${j.family}(${j.prevHits.join(',')})`).join('; ') +
          ` — environment state disappeared without transition description.`,
      detail: { jumped, prevScene: prev.sceneNumber },
    })
  }
  return out
}

// ---- 检查 2 · 交接锚点缺失 ----
/**
 * 相邻两场之间，若上一场含垂直空间要素，本场必须写明**位移过程**（静态地点词不算）。
 *
 * ⚠️ 判据不止"有没有位移动词"（2026-09-16 真剧本两轮回归修正）：
 *
 * 第一轮教训——只要是场内有任一位移动词就判合规：第2集改前原文
 * 「三小只贴着峭壁，沿下山道绕下谷底，来到河边浅滩」含「绕下」→ 判合规，
 * 但这 7 个字给不出过渡镜锚点，用户反馈的"桥一看就是两个地方"正是这个。
 *
 * 第二轮教训——改为"有渐进锚点即可"后仍漏检：判据在全场文本上匹配，
 * 而场次是 800 字的完整戏，里面另有"先…再…"等词（不属位移段），
 * 把"下崖过程没展开"掩盖掉了。**判据的作用域错了**。
 *
 * 终版判据——只看**位移承接段**：本场开头到第一个"明显不是承接"的边界
 * （场景说明段之后的第一段正文，长度封顶 HANDOFF_WINDOW）。
 * 理由：交代"怎么从上一场来到这里"必然发生在场次开头；
 * 场次中后段的词与跨场衔接无关，不该参与判定。
 */
export function checkHandoffAnchor(scenes = [], lexicon) {
  const vertical = lexicon?.verticalTerrain || []
  const moveVerbs = lexicon?.moveVerbs || []
  const placeNouns = lexicon?.placeNouns || []
  const gradual = lexicon?.gradualMarkers || []
  const out = []

  for (let i = 1; i < scenes.length; i++) {
    const prev = scenes[i - 1]
    const cur = scenes[i]
    if (!prev || !cur) continue
    const prevText = String(prev.text || prev.finalFrame || '')
    const curText = String(cur.text || '')

    const prevVHits = vertical.filter((w) => prevText.includes(w))
    if (!prevVHits.length) continue
    const curVHits = vertical.filter((w) => curText.includes(w))

    // 同地点豁免：两场共享同一地点词，且**不是**跨层位移（两场都带垂直地形词）时豁免。
    //   · 豁免场景：相邻两场是同一地点的连续动作（"河边浅滩 → 下河"），不该要求位移过程。
    //   · 不豁免：上一场在崖顶、本场在谷底——虽可能共享"河"字，但分属两个层级，
    //     正是需要交代"怎么下来的"的情形。
    const sharedPlace = placeNouns.some((w) => prevText.includes(w) && curText.includes(w))
    const bothVertical = prevVHits.length > 0 && curVHits.length > 0
    if (sharedPlace && !bothVertical) continue

    // ★ 只取"位移承接段"：场次开头那一小段（越过场次标题行与空间关系说明段），
    //   结构判据来自语言包（structure.sceneHeader / settingHead）——中文剧本的行首约定
    //   属语言知识，换英文剧本需换一套正则，故不写死在算法里。
    const windowText = handoffWindow(curText, lexicon?.structure)
    const moveHits = moveVerbs.filter((w) => windowText.includes(w))
    const gradualHits = gradual.filter((w) => windowText.includes(w))
    const M = lexicon?.messages || {}

    // 承接段里既无位移动词、也无渐变锚点 → 完全没交代
    if (!moveHits.length && !gradualHits.length) {
      out.push({
        code: 'HANDOFF_ANCHOR_MISSING',
        scene: cur.sceneNumber,
        message: M.handoffMissing
          ? M.handoffMissing({
              curNo: cur.sceneNumber, prevNo: prev.sceneNumber, prevVHits,
            })
          : `[HANDOFF_ANCHOR_MISSING] scene ${prev.sceneNumber}->${cur.sceneNumber}: ` +
            `previous scene has vertical terrain (${prevVHits.join(',')}) but this scene ` +
            `describes no movement process — storyboard has no transition basis.`,
        detail: { prevScene: prev.sceneNumber, prevVerticalHits: prevVHits, window: windowText.length },
      })
    } else if (!gradualHits.length) {
      // 有位移动词、但没有任何"过程被展开"的锚点 → 过程过薄，切不出过渡镜。
      //
      // 为什么不看位移动词个数（2026-09-16 三轮修正）：动词多不等于过程展开——
      // 改前原文「贴着峭壁，沿下山道绕下谷底，来到河边浅滩」在承接段里能命中
      // 绕下/滑下/下山/爬上/来到/退回 6 个动词（后几个来自紧接的同一段戏），
      // 但整句仍是一笔带过。**锚点词的有无**才是判据，动词个数不是。
      out.push({
        code: 'HANDOFF_ANCHOR_THIN',
        scene: cur.sceneNumber,
        message: M.handoffThin
          ? M.handoffThin({
              curNo: cur.sceneNumber, prevNo: prev.sceneNumber,
              prevVHits, moveHits,
            })
          : `[HANDOFF_ANCHOR_THIN] scene ${prev.sceneNumber}->${cur.sceneNumber}: ` +
            `previous scene has vertical terrain (${prevVHits.join(',')}) but this scene ` +
            `compresses the movement into isolated verb(s) (${moveHits.join(',')}) ` +
            `with no gradual markers — storyboard cannot derive transition shots.`,
        detail: { prevScene: prev.sceneNumber, prevVerticalHits: prevVHits, moveHits, window: windowText.length },
      })
    }
  }
  return out
}

/**
 * 取"位移承接段"——场次开头用于交代"怎么从上一场来到这里"的那一段。
 *
 * 结构：场次标题行 → （可选）空间关系说明段 → 正文首段。
 * 跨场衔接只可能写在正文首段（说明段是设定，不是叙事过程），
 * 故跳过标题行与说明段，取正文首段；长度封顶，避免把整场算进来。
 *
 * 结构判据（怎么认标题行、怎么认说明段）由语言包提供：
 * 这是剧本的**书写约定**，属语言知识——中文剧本写「场次1：」「空间关系：」，
 * 英文剧本写「SCENE 1」「INT. …」或干脆不写说明段。算法只负责切，不负责认。
 *
 * @param {string} text 场次全文
 * @param {{sceneHeader?:RegExp, settingHead?:RegExp}} [structure] 语言包的结构判据
 * @returns {string} 承接段文本
 */
function handoffWindow(text, structure = {}) {
  const WINDOW = 400
  const sceneHeader = structure.sceneHeader
  const settingHead = structure.settingHead
  const lines = String(text || '').split('\n')
  const body = []
  let skippedHeader = false
  let skippedSetting = false
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    // 1) 跳过场次标题行（判据来自语言包；未提供则用"首行即标题"的位置判据兜底）
    if (!skippedHeader) {
      skippedHeader = true
      if (sceneHeader ? sceneHeader.test(t) : true) continue
      // 首行不是标题（如英文剧本无标题行）：不跳，按正文处理
    }
    // 2) 跳过空间关系/场景说明段（设置段是设定，不是叙事过程）
    if (!skippedSetting && settingHead && settingHead.test(t)) {
      skippedSetting = true
      continue
    }
    body.push(t)
    if (body.join('\n').length >= WINDOW) break
  }
  // 尚未取到正文（如无说明段的短场次）：退回全文前 WINDOW 字
  const joined = body.join('\n')
  return (joined || String(text || '')).slice(0, WINDOW)
}

// ---- 检查 3 · 同物形态跨场不一致 ----
/**
 * 同一物体跨场出现但材质/结构族不一致 → 告警。
 */
export function checkObjectFormConsistency(scenes = [], lexicon) {
  const objects = lexicon?.objects || {}
  const out = []

  for (const [obj, formGroups] of Object.entries(objects)) {
    const seen = []
    for (const sc of scenes) {
      const t = String(sc?.text || '')
      if (!t.includes(obj)) continue
      for (let fi = 0; fi < formGroups.length; fi++) {
        const hits = (formGroups[fi] || []).filter((w) => t.includes(w))
        if (hits.length) {
          // scene 缺失时回退为序号，避免拼出空标签（实测出现过 "场次/"）
          const sceneNo = sc?.sceneNumber ?? sc?.scene_number ?? null
          const M = lexicon?.messages || {}
          seen.push({
            scene: sceneNo == null ? (M.unknownScene || '?') : sceneNo,
            label: sceneNo == null
              ? (M.sceneLabel ? M.sceneLabel(seen.length + 1) : `#${seen.length + 1}`)
              : (M.sceneLabelWithNo ? M.sceneLabelWithNo(sceneNo) : `scene ${sceneNo}`),
            formIdx: fi,
            hits,
          })
          break
        }
      }
    }
    if (seen.length >= 2) {
      const forms = [...new Set(seen.map((s) => s.formIdx))]
      if (forms.length > 1) {
        const M = lexicon?.messages || {}
        out.push({
          code: 'OBJECT_FORM_INCONSISTENT',
          scene: seen.map((s) => s.scene).join('/'),
          message: M.objectForm
            ? M.objectForm({ object: obj, seen })
            : `[OBJECT_FORM_INCONSISTENT] "${obj}" has inconsistent form across scenes: ` +
              seen.map((s) => `${s.label}=${s.hits.join(',')}`).join('; ') +
              ` — same object must keep one form across scenes.`,
          detail: { object: obj, seen },
        })
      }
    }
  }
  return out
}

// ---- 检查 4 · summary 与剧本正文语义漂移 ----
/**
 * 同一场景的两份文本（剧本正文 vs 场景资产 summary）环境要素集合差异过大 → 告警。
 */
export function checkSummaryDrift(rows = [], lexicon) {
  const out = []
  for (const r of rows) {
    if (!r) continue
    const a = extractEnvState(r.scriptText, lexicon)
    const b = extractEnvState(r.summaryText, lexicon)
    const diffs = []
    for (const family of ['fog', 'light', 'weather']) {
      const A = new Set(a[family])
      const B = new Set(b[family])
      const onlyScript = [...A].filter((x) => !B.has(x))
      const onlySummary = [...B].filter((x) => !A.has(x))
      if (onlyScript.length || onlySummary.length) diffs.push({ family, onlyScript, onlySummary })
    }
    if (diffs.length) {
      const onlyS = diffs.flatMap((d) => d.onlySummary)
      const onlyC = diffs.flatMap((d) => d.onlyScript)
      const M = lexicon?.messages || {}
      out.push({
        code: 'SUMMARY_SCRIPT_DRIFT',
        scene: r.sceneNumber,
        message: M.summaryDrift
          ? M.summaryDrift({ sceneNo: r.sceneNumber, onlySummary: onlyS, onlyScript: onlyC })
          : `[SUMMARY_SCRIPT_DRIFT] scene ${r.sceneNumber}: script and scene summary ` +
            `describe different environments` +
            (onlyS.length ? `; summary-only: ${onlyS.join(',')}` : '') +
            (onlyC.length ? `; script-only: ${onlyC.join(',')}` : '') +
            ` — downstream storyboard consumes summary and will drift from the script.`,
        detail: { diffs },
      })
    }
  }
  return out
}

// ===================================================================
// 集级入口
// ===================================================================

// 注：告警文案与环境族名均来自语言包（lexicon.messages / lexicon.familyLabel），
// 本文件不含任何硬编码的业务词与文案——换语言只需新增 lexicons/<lang>.js。

/**
 * 跑全部跨场连续性检查。
 *
 * @param {object} input
 * @param {Array} input.scenes 场景列表（按场次顺序），每项可含
 *        { sceneNumber, title, text, summaryText, scriptText, finalFrame }
 * @param {object} [opts]
 * @param {string[]} [opts.only]   只跑指定检查：['env','handoff','form','drift']
 * @param {object}   [opts.lexicon] 项目词典（见 buildLexicon）
 * @param {string|object} [opts.languagePack]  语言包 id 或对象（默认 zh-CN）
 * @param {string|object} [opts.objectFormPack] 物体形态内容包（默认 zh）
 * @param {boolean}  [opts.autoExtract=true] 未传 lexicon 时是否自动抽取地点词
 * @param {string[]} [opts.placeHint] 地点提示词，提高自动抽取精度
 * @returns {{warnings: Array, summary: object, lexicon: object}}
 *
 * @example 零配置（自动抽词，精度略低但能跑）
 *   checkContinuity({ scenes })
 *
 * @example 项目词典注入（推荐，精度最高）
 *   checkContinuity({ scenes }, {
 *     lexicon: { placeNouns: ['冰河', '浅滩'], objects: { 桥: [['木桥'], ['石桥']] } },
 *   })
 *
 * @example 换语言（新增 ai/lexicons/ja-JP.js 并在 LANGUAGE_PACKS 登记后）
 *   checkContinuity({ scenes }, { languagePack: 'ja-JP' })
 */
export function checkContinuity(input = {}, opts = {}) {
  const scenes = Array.isArray(input.scenes) ? input.scenes : []
  const lexicon = buildLexicon({
    lexicon: opts.lexicon,
    languagePack: opts.languagePack,
    objectFormPack: opts.objectFormPack,
    scenes,
    placeHint: opts.placeHint,
    autoExtract: opts.autoExtract,
  })
  const only = Array.isArray(opts.only) && opts.only.length ? new Set(opts.only) : null
  const run = (key) => !only || only.has(key)

  const warnings = []
  if (run('env')) warnings.push(...checkEnvTransition(scenes, lexicon))
  if (run('handoff')) warnings.push(...checkHandoffAnchor(scenes, lexicon))
  if (run('form')) warnings.push(...checkObjectFormConsistency(scenes, lexicon))
  if (run('drift')) {
    const rows = scenes
      .filter((s) => s && (s.summaryText != null || s.scriptText != null))
      .map((s) => ({
        sceneNumber: s.sceneNumber,
        scriptText: s.scriptText ?? s.text,
        summaryText: s.summaryText ?? '',
      }))
    warnings.push(...checkSummaryDrift(rows, lexicon))
  }

  if (warnings.length) {
    const M = lexicon.messages || {}
    const log = M.logSummary
      ? M.logSummary({
          sceneCount: scenes.length,
          warnCount: warnings.length,
          items: warnings,
        })
      : `[continuityGuard] ${scenes.length} scenes, ${warnings.length} warnings.` +
        warnings.map((w) => ` [${w.code}]scene${w.scene}`).join('')
    console.warn(log)
  }
  return {
    warnings,
    summary: { sceneCount: scenes.length, warningCount: warnings.length },
    lexicon,
  }
}
