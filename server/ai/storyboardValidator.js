// 分镜结构化校验层。
// 背景：generateStoryboard 返回的 JSON 只做语法校验和场次数校验，
// 缺少跨字段一致性、时间轴连续性、Airlock 继承精确度等语义校验。
// AI 输出内部不一致（如 1-3 characters 漏一二但 prompt @ 了一二）无法被现有逻辑发现。
//
// 本模块在 generateStoryboard 返回后、落库前调用，输出三类结果：
// - errors: 必须修的（字段缺失/时间轴断裂），喂回 AI 重试
// - warnings: 建议修的（Airlock 不精确/字段不一致），打日志可观测
// - fixed: 程序化自动修的（characters 补齐，复用 assetBackfill），直接修
//
// 可观测性：warnings/errors 都打日志，量化 AI 分镜不合规率，
// 作为模板优化和是否升级两阶段生成的反馈信号。

import { backfillShotAssets } from './assetBackfill.js'
import { config } from '../config.js'
import { qcMeta } from './qcCodes.js'
// [去重 2026-09-19] escapeRegExp 收口到 shared（shared.js 头注「已合并」清单里本就登记了它，
// 本文件的局部拷贝是漏删的残留——旧实现无 String() 强转，传入非字符串会抛 TypeError）。
import { escapeRegExp } from './shared.js'

/**
 * 统一的 warning 落账（2026-09-16）：code 的级别不再由各校验函数自己心里记，
 * 一律从 qcCodes 注册表取——新增一个 QC code 只需在注册表登记，校验层这里自动带上 level。
 * 未登记的 code 走 WARNING 兜底（列表照常展示，只是没有专属标题）。
 *
 * ⚠️ 用「运行期打标」而不是改写 20 处 warnings.push 字面量：字面量里 shot/message 都是
 * 复杂的模板表达式，批量正则改写极易改错。这里在 created 时给数组的 push 包一层，
 * 自动补 level 字段——零侵入、语义完全等价。
 */
function makeWarnings() {
  const arr = []
  const orig = arr.push.bind(arr)
  arr.push = (...items) => {
    for (const w of items) {
      if (w && typeof w === 'object' && w.code && w.level === undefined) {
        w.level = qcMeta(w.code).level
      }
    }
    return orig(...items)
  }
  return arr
}

// 时长口径（2026-09-13 放宽到 15）：H3 模型官方支持 4-15s；h3V4 工作流 #1411 表达式
// （max(5,·)+17帧对齐）无上限、#1412 的 10 只是默认值——旧"工作流 duration 槽上限 10s"
// 系误记（overview.md 已纠正），故数据层与 normalize、prompt 模板统一 4-15，
// 出片端 v4Video.js clamp 3~15。V2（5-15）/武戏（5-15）引擎 clamp 独立，不受此约束。
// 2026-09-16：上下界改从 config.storyboard 读（env SHOT_DURATION_MIN/MAX 可覆盖），
// 不再在本文件写死——QC 面板、时长编辑控件与校验器共用同一个口径。
const DURATION_MIN = config.storyboard?.durationMin ?? 4
const DURATION_MAX = config.storyboard?.durationMax ?? 15

// V18/V20 阈值（2026-09-16 同批收进 config，env 可覆盖，见 config.storyboard 注释）
const SPEECH_RATE_MAX = config.storyboard?.speechRateMaxCharsPerSec ?? 5
const SPEECH_RATE_MIN_CHARS = config.storyboard?.speechRateMinChars ?? 3
const LONG_SHOT_MIN_SEC = config.storyboard?.longShotMinSec ?? 8
const THIN_PROMPT_CHARS = config.storyboard?.thinPromptChars ?? 80

// 七层美学心法 P0 阈值（2026-09-18 分镜规则重构）：与上面同风格，env 可覆盖
// 验证依据：第1集42镜真实数据——旧规则13条真实多拍零报，升级后全中；L6阈值0.4让8-4→8-5真合并候选进池
const MULTI_BEAT_ACTION_THRESHOLD = config.storyboard?.multiBeatActionThreshold ?? 4
const MULTI_BEAT_ACTION_WITH_CONNECTOR = config.storyboard?.multiBeatActionWithConnector ?? 3
const MULTI_BEAT_CONNECTOR_THRESHOLD = config.storyboard?.multiBeatConnectorThreshold ?? 3
const CUT_GAIN_JACCARD_THRESHOLD = config.storyboard?.cutGainJaccardThreshold ?? 0.4
const CUT_GAIN_STRUCTURAL_CHECK = config.storyboard?.cutGainStructuralCheck !== false
const REACTION_SHOT_ENABLED = config.storyboard?.reactionShotEnabled !== false
// P2 阈值（2026-09-18）：L2 光线 / L3 结尾留白 / L5 运镜 / L7 声弧
const ENDING_RUSHED_RATIO = config.storyboard?.endingRushedRatio ?? 1.3
const LIGHT_FLIP_ENABLED = config.storyboard?.lightFlipEnabled !== false
const CAMERA_MOVE_CHECK_ENABLED = config.storyboard?.cameraMoveCheckEnabled !== false
const SOUND_ARC_ENABLED = config.storyboard?.soundArcEnabled !== false
const SILENCE_GAP_ENABLED = config.storyboard?.silenceGapEnabled !== false

// V8 图文服装一致性：描述/integrated 提到的服装配饰若在角色设定描述和道具清单中都找不到，
// 参考图里必然也没有——生图时"文有图无"互相打架，模型输出随机摇摆。
const COSTUME_WORDS = ['围巾', '帽子', '背包', '书包', '披风', '斗篷', '眼镜', '项链', '手环', '手套', '耳环', '发卡', '蝴蝶结', '外套', '大衣', '雨衣', '口罩', '皇冠', '发带', '腰带', '披肩']

function checkCostumeConflict(shot, warnings, label, ctx) {
  const texts = [shot.description, shot.integratedMultimodalDescription || shot.integrated_multimodal_description]
    .filter(Boolean).join(' ')
  if (!texts) return
  // 已知服装来源：出场角色描述（含主设定）+ 本镜道具清单——服装词在其中视为合法
  const known = [
    ...(shot.characters || []).map(String),
    ...((ctx.assetNames?.characters || []).map((c) => (typeof c === 'string' ? c : c.description || ''))),
    ...(shot.propAssets || []).map(String),
  ].join(' ')
  const found = COSTUME_WORDS.filter((w) => texts.includes(w) && !known.includes(w))
  if (found.length) {
    warnings.push({
      code: 'COSTUME_TEXT_MISMATCH',
      shot: label,
      message: `镜头 ${label}：描述提到「${found.join('、')}」，但出场角色的设定描述与道具清单中都没有——参考图里也没有它，生图会图文打架。两条路：确要佩戴 → 先在资产页用「改造」把角色设定图更新；文字误写 → 从镜头描述中删掉。`,
    })
  }
}

// 从文本中提取所有 @资产名（支持中英文）
function extractMentions(text) {
  if (!text) return []
  const matches = text.match(/@[\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9_]*/g) || []
  return [...new Set(matches.map((m) => m.slice(1)))]
}

// V5 Airlock 继承精确度：非首镜 prompt 开头是否复刻上一镜 finalFrame 的关键角色
// 只校验角色继承，不校验道具/场景——特写镜头道具不在画面是正常的
function checkAirlockInheritance(prevShot, currShot, warnings, shotLabel, charNames) {
  if (!prevShot || !charNames) return
  const currPrompt = currShot.integratedMultimodalDescription || currShot.integrated_multimodal_description || ''
  if (!currPrompt) return

  const charSet = new Set(charNames)
  // 上一镜 finalFrame 里的 @角色（过滤掉非角色资产）
  const prevFinalFrame = prevShot.finalFrame || prevShot.final_frame || ''
  const prevMentions = extractMentions(prevFinalFrame)
  const prevChars = prevMentions.filter((m) => charSet.has(m))
  if (prevChars.length === 0) return

  const currMentions = new Set(extractMentions(currPrompt + ' ' + (currShot.finalFrame || currShot.final_frame || '')))
  const missing = prevChars.filter((c) => !currMentions.has(c))
  if (missing.length > 0) {
    warnings.push({
      code: 'AIRLOCK_CHAR_MISSING',
      shot: shotLabel,
      message: `Airlock 继承缺失角色：上一镜 finalFrame 有 @${prevChars.join(' @')}，当前镜未提及 @${missing.join(' @')}。Airlock 要求复刻上一镜最终画面，角色不应消失。`,
    })
  }
}

// V10 画面地理（Frame Geography）跨镜一致性：同一角色相邻镜画面侧位不得凭空翻转（180 度轴线）。
// 侧位从 finalFrame / Airlock 文本里机读解析（at frame left/right/center frame），
// 与 frameGeographyRule 规定的写法同口径——规则要求这么写，这里就能这么查。
// 两级信号：
// - AIRLOCK_SIDE_FLIP（强）：Airlock 段本应逐字复刻上一镜 finalFrame，复刻完侧位却相反 = 复制腐化；
// - SCREEN_SIDE_FLIP（弱）：上一镜 finalFrame 与本镜 finalFrame 侧位相反——可能是合法越轴
//   （本镜内显式走位/中性镜过渡），也可能越轴错误，告警由人判。
const SIDE_PATTERNS = [
  [/\bat frame left\b/i, 'left'],
  [/\bat frame right\b/i, 'right'],
  [/\bat center frame\b|\bat the center of the frame\b|\bcenter frame\b/i, 'center'],
  [/\bframe[- ]left\b|\bleft side of the frame\b|\bscreen left\b/i, 'left'],
  [/\bframe[- ]right\b|\bright side of the frame\b|\bscreen right\b/i, 'right'],
]

// 显式走位交代的判定（唯一口径）：QC 校验（SCREEN_SIDE_FLIP 的豁免）与 doubao.js 阶段3
// 自动越轴修补共用同一实现——此前两处各写一份正则，口径必然漂移。
// 动词覆盖位移类表达（walk/run/move/cross/step/circle/drift/shift/sidestep/reposition），
// 要求 60 字符窗口内出现 "frame <side>"；窗口内出现 @ 视为换主语，不算同一次走位。
export function hasExplicitReposition(text, side) {
  if (!text || !side) return false
  return new RegExp(
    `(walks?|runs?|moves?|crosses?|steps?|circles?|drifts?|shifts?|sidesteps?|repositions?)[^@\\.]{0,60}frame ${side}`,
    'i'
  ).test(text)
}

// 从文本中解析每个角色的画面侧位。返回 Map<charName, 'left'|'right'|'center'>
// 匹配窗口取角色名之后 120 字符（侧位声明习惯跟在角色后），多个侧位词取最近的。
// 导出供 doubao.js 阶段 3 越轴修补复用（同一口径，避免两处实现漂移）。
//
// 匹配形态（2026-09-16 放宽，此前只认 '@角色名' 一种，导致侧位检查大面积静默空转）：
//   · '@一二 / Yier'   规范写法（@ + 中文名 + 英文名）
//   · '@Bubu'          模型有时只写英文名，而 charNames 里是中文名 → 也必须认得
//   · 'Bubu stands …'  无 @ 的裸名（模型自由发挥时）
//   · 'the Great White Bear lies …'  英文长名裸写
// 为什么放宽：实测 EP4 的 40 个含侧位描述的镜头里有 5 个（12.5%）因写法不规范被解析为空，
// 而解析为空会让 checkFrameGeography 在 `prevSides.size === 0` 处直接 return——
// **既不报越轴、也不进修补、更不出现在质检面板**，是最难发现的那类静默失效。
// 放宽匹配只会让更多镜头进入检查视野（可能多报几个 warning），不会漏报；
// 而"漏报"在这里的代价是永久性画面错位，代价远高于"多报"（多报可由人忽略）。
//
// 别名来源：characters 表可有 aliases 字段（逗号分隔）；name 里含 '/'-分隔的双语名
// （如 '大白熊 / the Great White Bear'）时，两侧都作为可匹配形态。
function buildNameForms(name, extraAliases = []) {
  const forms = new Set()
  const push = (s) => {
    const v = String(s || '').trim()
    if (v) forms.add(v)
  }
  push(name)
  // 双语名拆分：'大白熊 / the Great White Bear' → 中英两段都可作为匹配形态
  for (const part of String(name || '').split('/')) push(part)
  for (const a of extraAliases) {
    // 别名可能是 '小一,布布酱' 这种逗号串
    for (const part of String(a || '').split(',')) push(part)
  }
  return [...forms].filter(Boolean).sort((a, b) => b.length - a.length) // 长名优先，避免短名先匹配
}

/**
 * @param {string} text 待解析文本（finalFrame / Airlock 段 等）
 * @param {string[]} charNames 角色名清单
 * @param {Map<string,string[]>} [aliasMap] 可选：角色名 → 别名数组（来自 characters.aliases）
 */
export function extractScreenSides(text, charNames, aliasMap = null) {
  const sides = new Map()
  if (!text || !charNames) return sides
  for (const name of charNames) {
    const aliases = aliasMap?.get?.(name) || []
    const forms = buildNameForms(name, aliases)
    let matched = false
    for (const form of forms) {
      if (matched) break
      // 匹配形态：可选 '@' 前缀 + 名字本身。
      // 用 lookbehind 防止匹配到更长名字的中段（如名字 '一二' 不应匹配到 '一二三' 里的 '一二'）。
      // 'i' 大小写不敏感：别名里的英文名可能是 'the Great White Bear'，而正文句首写成
      // 'The Great White Bear'——不加 i 就会在句首那一次漏掉（实测 1-6/8-1 正是这种写法）。
      const re = new RegExp(`@?${escapeRegExp(form)}(?![\\w\\u4e00-\\u9fa5])`, 'gi')
      let m
      while ((m = re.exec(text))) {
        // 英文名后可能紧跟 ' / 中文名'，窗口起点仍从名字实际位置算
        const start = m.index
        const window = text.slice(start, start + form.length + 120)
        // 侧位词必须出现在名字之后（窗口内取最近的一个）
        let best = null
        for (const [pat, side] of SIDE_PATTERNS) {
          const sm = window.match(pat)
          if (sm && (best === null || sm.index < best.index)) best = { index: sm.index, side }
        }
        if (best) {
          sides.set(name, best.side)
          matched = true
          break
        }
      }
    }
  }
  return sides
}

/**
 * 从 DB 取「角色名 → 别名数组」映射，供 extractScreenSides 做别名召回。
 * 别名来源（两处，都是既有数据，不新增字段）：
 *   · characters.name_en —— 英文名（'Yier' / 'Bubu' / 'the Great White Bear'），
 *     模型写英文名是常态，中文名清单匹配不到就会静默漏检
 *   · characters.aliases —— 别名，逗号分隔（列不存在时忽略）
 * 表里两列都空时返回空 Map（调用方无需分支）。
 * @param {Array<{name:string, name_en?:string, aliases?:string}>} charRows characters 表行
 */
export function buildAliasMap(charRows) {
  const map = new Map()
  for (const r of charRows || []) {
    const name = String(r?.name || '').trim()
    if (!name) continue
    const aliases = [
      ...String(r?.name_en || '').split(','),
      ...String(r?.aliases || '').split(','),
    ]
      .map((s) => s.trim())
      .filter(Boolean)
    if (aliases.length) map.set(name, aliases)
  }
  return map
}

function checkFrameGeography(prevShot, currShot, warnings, shotLabel, charNames, aliasCtx = null) {
  if (!prevShot || !charNames) return
  const prevFinalFrame = prevShot.finalFrame || prevShot.final_frame || ''
  if (!prevFinalFrame) return
  const prevSides = extractScreenSides(prevFinalFrame, charNames, aliasCtx)
  if (prevSides.size === 0) return

  const currPrompt = currShot.integratedMultimodalDescription || currShot.integrated_multimodal_description || ''
  const currFinalFrame = currShot.finalFrame || currShot.final_frame || ''

  // 强信号：Airlock 段（开头到模块2 角色锁定之前的复刻区）侧位与上一镜 finalFrame 相反
  // Airlock 段以 "The camera opens holding the exact final-frame composition" 开头，
  // 截止于 "exactly as shown"（模块2 起点）或 600 字符，取先到者。
  if (currPrompt) {
    const airlockStart = currPrompt.indexOf('The camera opens holding')
    if (airlockStart !== -1) {
      const module2 = currPrompt.indexOf('exactly as shown', airlockStart)
      const airlockText = currPrompt.slice(airlockStart, module2 !== -1 ? module2 : airlockStart + 600)
      const airlockSides = extractScreenSides(airlockText, charNames, aliasCtx)
      for (const [name, prevSide] of prevSides) {
        const aSide = airlockSides.get(name)
        if (aSide && prevSide !== 'center' && aSide !== 'center' && aSide !== prevSide) {
          warnings.push({
            code: 'AIRLOCK_SIDE_FLIP',
            shot: shotLabel,
            message: `镜头 ${shotLabel}：Airlock 复刻段里 @${name} 在 frame ${aSide}，但上一镜 finalFrame 里在 frame ${prevSide}。Airlock 应逐字复刻上一镜最终画面，侧位相反说明复刻被改写，首帧空间直接错位。`,
          })
        }
      }
    }
  }

  // 弱信号：相邻镜 finalFrame 侧位翻转——可能是本镜内显式走位（合法），也可能越轴（错误）
  const currSides = extractScreenSides(currFinalFrame, charNames, aliasCtx)
  for (const [name, prevSide] of prevSides) {
    const cSide = currSides.get(name)
    if (cSide && prevSide !== 'center' && cSide !== 'center' && cSide !== prevSide) {
      const movedInShot = hasExplicitReposition(currPrompt, cSide)
      if (!movedInShot) {
        warnings.push({
          code: 'SCREEN_SIDE_FLIP',
          shot: shotLabel,
          message: `镜头 ${shotLabel}：@${name} 画面侧位从上一镜 frame ${prevSide} 翻转到 frame ${cSide}，但本镜动作时间轴里没有显式走位（walks/moves to frame ${cSide}）。若是合法越轴请在模块4 补走位动作；否则角色会凭空换边（180 度轴线被破坏）。`,
        })
      }
    }
  }
}

// V11 镜头语言（cinematicGrammarRule 的可机读部分，同口径——规则要求这么写，这里就能这么查）：
// - EMOTION_SHOT_TOO_WIDE：强情绪台词镜景别却是全景/远景 → 情绪点在远景里"指甲盖大"
//   （实锤：旧 3-2 布布"别怕……有我在！"在中景，全片情绪最高点打不出来）；
// - SCENE_SHOTTYPE_FLAT：单场 ≥3 镜且景别全同 → 景别平推（实锤：旧场1~场4 五镜全远景=动态PPT）；
// - MULTI_BEAT_SUSPECT：描述里节拍连接词 ≥3 → 疑似一镜多拍，文戏节拍被压扁
//   （实锤：旧 2-1 一镜塞六拍；actionDensityRule 管武戏动作，文戏节拍靠这里兜底）。弱信号，告警由人判。
const EMOTION_TONE_WORDS = ['鼓气', '逞强', '怒', '怒吼', '哭', '喊', '大喊', '惊', '兴奋', '哽咽', '坚定', '焦急', '害怕']
const WIDE_SHOT_TYPES = ['全景', '远景', '大远景']
// 一拍一镜（L1）：连接词扩充（旧版只7个，漏"于是/便/刚/就"），肢体动作动词新增
// 验证：第1集42镜——旧版纯连接词≥3 零报，13条真实多拍全漏；升级后13条全中零误报
const BEAT_CONNECTORS = ['突然', '紧接着', '随后', '然后', '与此同时', '接着', '随即', '于是', '便', '刚', '就']
// 肢体/位移/事件动作动词（不含视觉词望/看/盯、不含纯环境状态词勾勒/闪/铺/染/沉——那些不构成"拍"）
// '砸' 虽是环境动作但常构成危机节拍（碎石砸脚=危机信号），第1集 1-4 靠它补到阈值
const ACTION_BODY = [
  '扑', '抓', '推', '拉', '撞', '甩', '跳', '摔', '跑', '走', '坐', '站', '转', '缩', '抖',
  '躲', '举', '放', '抱', '拍', '打', '踢', '咬', '爬', '滚', '跌', '滑', '退', '拽', '凑',
  '蹭', '跃', '冲', '踩', '钻', '攀', '压低', '挺起', '竖起', '凑近', '起身', '迈步', '挪',
  '落下', '张开', '攥', '揪', '抠', '抵', '扳', '刨', '砸',
]

// V13 跨镜空间位置跳变（2026-09-12 武戏段瞬移事故的事前闸，P5 缺口）：
// 同一角色在相邻镜的"位置载体"（熊背上/坡顶/雪地里/冰面上）凭空变化，且本镜
// prompt 里没有显式移动动作（jump/leap/climb/slide/dismount…）交代——就是瞬移。
// 侧位检查（V10）管"画面左右"，这里管"剧情空间"。弱信号，告警由人判。
// 背景：6-3 布布在熊肩 → 7-1 直接在坡顶推雪球，V1~V12 全部放行（剧本层就没写过渡）。
const LOCATION_PATTERNS = [
  [/\b(?:on|onto|upon|atop|riding on) (?:the )?(?:giant |big |snow )?bear'?s? (?:back|shoulder)|\briding (?:on )?(?:the )?bear|\batop (?:the )?bear/i, 'bear'],
  [/\bon (?:the )?bear'?s? (?:round |furry )?belly|\bon (?:its|his|her) belly/i, 'bear-belly'],
  [/\b(?:at |on )(?:the )?(?:snow )?(?:slope|hill|ridge)(?:'?s)? top|\bat the top of (?:the )?(?:slope|hill|ridge)/i, 'slope-top'],
  [/\bon (?:the )?(?:snow )?slope\b/i, 'slope'],
  [/\b(?:lying|lies|buried|sprawled|sitting|sits|landed|lands|flung|dumped|is) (?:in|on) (?:a |the )?snow\b|\bin (?:a )?snow ?(?:drift|pile)/i, 'snow'],
  [/\b(?:on|from|across) (?:the )?ice(?: ?field)?\b/i, 'ice'],
]
const MOVE_VERBS = /\b(jump\w*|leap\w*|climb\w*|slide\w*|slid|dismount\w*|drop\w*|descend\w*|fall\w*|fell|hop\w*|scramble\w*|run\w*|walk\w*|move\w*|dash\w*)\b/i

function extractLocations(text, charNames) {
  const locs = new Map()
  if (!text || !charNames) return locs
  for (const name of charNames) {
    const re = new RegExp('@' + escapeRegExp(name), 'g')
    let m
    while ((m = re.exec(text))) {
      const window = text.slice(m.index, m.index + name.length + 200)
      for (const [pat, tag] of LOCATION_PATTERNS) {
        if (pat.test(window)) { locs.set(name, tag); break }
      }
      if (locs.has(name)) break
    }
  }
  return locs
}

function checkLocationTeleport(prevShot, currShot, warnings, shotLabel, charNames) {
  if (!prevShot || !charNames) return
  const prevFinalFrame = prevShot.finalFrame || prevShot.final_frame || ''
  if (!prevFinalFrame) return
  const prevLocs = extractLocations(prevFinalFrame, charNames)
  if (prevLocs.size === 0) return

  const currPrompt = currShot.integratedMultimodalDescription || currShot.integrated_multimodal_description || ''
  const currFinalFrame = currShot.finalFrame || currShot.final_frame || ''
  const currLocs = extractLocations(currFinalFrame + ' ' + currPrompt, charNames)

  for (const [name, prevTag] of prevLocs) {
    const currTag = currLocs.get(name)
    if (!currTag || currTag === prevTag) continue
    // 本镜有显式移动动作交代（角色附近 200 字符内有移动动词）→ 合法走位
    const re = new RegExp('@' + escapeRegExp(name), 'g')
    let moved = false
    let m
    while ((m = re.exec(currPrompt))) {
      if (MOVE_VERBS.test(currPrompt.slice(m.index, m.index + 200))) { moved = true; break }
    }
    if (!moved) {
      warnings.push({
        code: 'LOCATION_TELEPORT',
        shot: shotLabel,
        message: `镜头 ${shotLabel}：@${name} 的位置从上一镜的「${prevTag}」变成「${currTag}」，但本镜动作时间轴里没有显式移动动作（jump/leap/climb/slide 等）——角色瞬移。请在模块4 补移动过程，或在本镜 Airlock 后立即交代位置变化。`,
      })
    }
  }
}

// ===== V18/V19/V20（2026-09-16 导演审计补强：声音节奏 + 相邻镜过近 + 长镜薄提示词）=====
// 设计原则同既有检查：只做可机读的结构断言，弱信号告警由人判；阈值全走 config（env 可覆盖）。

// 会念出声的字符数：中英文与数字（标点/空白不念不算）
function countSpokenChars(text) {
  return String(text || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').length
}

// V18 台词语速（镜级总量法）：本镜台词总字数 ÷ 镜时长 > 自然语速上限 → 物理上说不完。
// 为什么不用逐条 startTime 切时间槽：实数据里台词 startTime 既有全片绝对秒也有镜内 0，
// 两种口径混存（V9 查越界的正是它），按它切槽会把好台词误判成超载。镜级总量是最稳的
// 物理约束——不管每句从哪秒开口，duration 秒内必须念完 text 总字数。
// 出片后果：TTS 加速到不自然（赶），或台词溢出到下一镜（Airlock 首帧对位被破坏）。
function checkDialogueSpeed(shot, warnings, label) {
  const dur = Number(shot.duration)
  if (!Number.isFinite(dur) || dur <= 0) return
  const dlgList = Array.isArray(shot.dialogue)
    ? shot.dialogue
    : (shot.dialogue && typeof shot.dialogue === 'object' ? [shot.dialogue] : [])
  const chars = dlgList.reduce((n, d) => n + countSpokenChars(d?.text), 0)
  if (chars < SPEECH_RATE_MIN_CHARS) return
  const rate = chars / dur
  if (rate > SPEECH_RATE_MAX) {
    warnings.push({
      code: 'DIALOGUE_SPEED_TIGHT',
      shot: label,
      message: `镜头 ${label}：${chars} 字台词 ÷ ${dur}s = ${rate.toFixed(1)} 字/秒，超过自然语速上限（${SPEECH_RATE_MAX} 字/秒）——配音要么赶得不自然，要么溢出到下一镜、破坏 Airlock 首帧对位。请删减台词，或把部分台词挪到相邻镜，或加长本镜时长。`,
    })
  }
}

// V19 相邻镜过近（30° 规则）：同主体相邻镜 景别+机位朝向 全同（运镜也同/缺）→ 跳切风险。
// 两条几乎相同的提示词会出两张几乎相同的图，剪起来像定格/跳切，白烧一次出片。
// 豁免：运镜不同（推近 vs 横摇，画面有运动变化）不算；机位或景别任一缺失不判（宁可漏报不误报）；
//       跨场不比（新场景新空间，30° 规则只约束同场相邻）——由调用方传 sceneIndex 控制。
function checkAdjacentSimilarity(prevShot, currShot, warnings, shotLabel) {
    if (!prevShot) return
  const typeOf = (s) => String(s?.shotType || s?.shot_type || '').trim()
  const angleOf = (s) => String(s?.cameraAngle || s?.camera_angle || '').trim()
  const moveOf = (s) => String(s?.cameraMovement || s?.camera_movement || '').trim()
  const prevType = typeOf(prevShot), currType = typeOf(currShot)
  const prevAngle = angleOf(prevShot), currAngle = angleOf(currShot)
  if (!prevType || !currType || !prevAngle || !currAngle) return
  if (prevType !== currType || prevAngle !== currAngle) return
  const prevMove = moveOf(prevShot)
  if (prevMove && prevMove !== moveOf(currShot)) return
  // 同主体判定：出场角色有交集；两镜都无角色视为同环境空镜，也比
  const prevChars = new Set(prevShot.characters || [])
  const currChars = new Set(currShot.characters || [])
  const sameSubject = (prevChars.size === 0 && currChars.size === 0)
    || [...currChars].some((c) => prevChars.has(c))
  if (!sameSubject) return
  warnings.push({
    code: 'ADJACENT_SHOT_TOO_SIMILAR',
    shot: shotLabel,
    message: `镜头 ${shotLabel}：与上一镜同为「${currType} + ${currAngle}${prevMove ? ' + 同运镜' : ''}」且主体相同（30°规则）——两条几乎相同的提示词会出两张几乎相同的图，剪起来像跳切/定格。建议相邻镜改变景别或机位朝向，让画面有视觉变化。`,
  })
}

// V20 长镜薄提示词：时长 ≥ longShotMinSec 且提示词过短（去空白字符数 < thinPromptChars）。
// 长镜更依赖过程性描述撑住时长：薄提示词出片要么画面死气（模型不敢发挥）要么自由发挥跑偏。
// 阈值是"明显缺过程"的保守线（正常补全后的提示词几百字起），宁可漏报不误报。
function checkLongShotThinPrompt(shot, warnings, label) {
  const dur = Number(shot.duration)
  if (!Number.isFinite(dur) || dur < LONG_SHOT_MIN_SEC) return
  const prompt = String(shot.integratedMultimodalDescription || shot.integrated_multimodal_description || '')
  const chars = prompt.replace(/\s/g, '').length
  if (chars >= THIN_PROMPT_CHARS) return
  warnings.push({
    code: 'LONG_SHOT_THIN_PROMPT',
    shot: label,
    message: `镜头 ${label}：${dur}s 长镜但提示词只有 ${chars} 字（< ${THIN_PROMPT_CHARS}）——长镜需要过程性描述撑住时长，提示词太薄出片要么画面死气、要么模型自由发挥跑偏。请补全本镜的动作过程与画面变化描述。`,
  })
}

// V14 情感线台词地板（2026-09-12 第1集 F5 根焊）：2 分半全片仅 3 句台词，情感线立不住。
// 台词铁律管"该有对白的镜不许漏句"、对话信息密度管"每句要推进剧情"——都管质量，
// 没人管总量：纯动作哑段落连成片，观众记不住角色。弱信号告警由人判。
function hasDialogueContent(d) {
  if (d == null) return false
  let arr = d
  if (typeof d === 'string') {
    const s = d.trim()
    if (!s || s === 'null') return false
    try { arr = JSON.parse(s) } catch { return s.length > 2 } // 非 JSON 非空串按有台词算
  }
  if (Array.isArray(arr)) return arr.some((x) => x && String(x.text || '').trim())
  if (typeof arr === 'object') return !!String(arr.text || '').trim()
  return false
}

function checkDialogueFloor(flatShots, warnings) {
  const total = flatShots.length
  if (total < 8) return // 短集不评占比
  const dlgCount = flatShots.filter((s) => s.hasDialogue).length
  let maxStreak = 0
  let streak = 0
  for (const s of flatShots) {
    streak = s.hasDialogue ? 0 : streak + 1
    if (streak > maxStreak) maxStreak = streak
  }
  if (dlgCount / total < 0.25) {
    warnings.push({
      code: 'DIALOGUE_FLOOR',
      shot: '*',
      message: `全片 ${total} 镜只有 ${dlgCount} 镜有台词（占比 ${Math.round((dlgCount / total) * 100)}% < 25%）——纯动作哑段落撑不起情感线（第1集 F5 实锤：2 分半仅 3 句台词）。请在关键情绪节点补对白/心声/呼喊。`,
    })
  }
  if (maxStreak >= 6) {
    warnings.push({
      code: 'DIALOGUE_DROUGHT',
      shot: '*',
      message: `全片存在连续 ${maxStreak} 镜完全无台词——观众会长时间听不到角色声音，情感线断档。请在这段里插一句心声、呼喊或对白（哪怕一个字）。`,
    })
  }
}

// V15 同类梗重复上限（2026-09-12 第1集 F6 根焊）：雪埋梗三遍（2-3 雪崩埋 / 3-1 爬出 / 6-1 雪浪卷翻），
// 观众第 3 次只会疲劳。关键词族对剧情描述粗筛，≥3 镜命中同一族 → 告警由人判。
const GAG_FAMILIES = [
  { tag: '雪埋/雪崩类', re: /埋[进在住到]|卷[起翻飞]|砸进|甩飞|钻出|爬出|从雪里|雪崩埋/ },
  { tag: '滑倒/失足类', re: /滑倒|脚滑|摔倒|滑铲|跌落|失足|打滑/ },
  { tag: '怒吼/炸毛类', re: /怒吼|咆哮|炸毛|红眼|瞪眼/ },
  { tag: '撞飞/弹飞类', re: /撞飞|弹飞|击飞|掀飞|甩飞/ },
]

function checkGagRepeat(flatShots, warnings) {
  for (const fam of GAG_FAMILIES) {
    const hits = flatShots.filter((s) => fam.re.test(s.description))
    if (hits.length >= 3) {
      warnings.push({
        code: 'GAG_REPEAT',
        shot: '*',
        message: `「${fam.tag}」桥段在全片出现 ${hits.length} 次（${hits.map((h) => h.label).join('、')}）——同一梗第 3 次观众只会疲劳（第1集 F6 实锤：雪埋梗三遍）。请换花样、升级或反转。`,
      })
    }
  }
}

// V12 画风毒词（2026-09-12 画风统一铁律）：全片禁止风格切换词。
// 背景实锤：第1集 5-3 描述写"写实CGI定格"，出片 8 镜全被拉去写实 CGI，"像换了部片子"全段返工。
// 中文词子串匹配；英文词整词边界匹配（防 atmosphere 里的 at 误伤类问题）。
// 白名单：项目画风本身含该词时合法（写实风项目写"写实"是正常的）——ctx.projectStyleText 传入画风全文。
const STYLE_POISON_ZH = ['写实CGI', '写实CG', '写实', 'CG定格', 'CG感', '真实感', '照片级', '电影质感', '3D', '三维', '立体渲染', '实拍']
const STYLE_POISON_EN = ['realistic', 'CGI', 'photoreal', 'photorealistic', 'hyperreal', 'hyper-realistic', 'live-action', '3D render', 'CG render']

// 否定语境豁免（2026-09-16 实锤）：补全后 imd 的风格头常写 "no realistic rendering, no CGI"
// 来**加固**吉卜力画风——否定用法与"切换画风"恰恰相反，硬闸误杀会把好提示词挡在出片外。
// 只抓"正面携带"（肯定语境）；词前紧邻否定标记即放行。
// 中文否定词直接绑定（不/无/非…），正则不加间隔要求；英文允许否定词与毒词间最多夹一个小词
// （"no realistic" 直连、"never use CGI" 隔动词）， gap 结构自带词中缀防护（another/denote 不误放）。
// 注：豁免只管前缀否定；"CGI-free" 后缀式极少见，不为它复杂化。
const POISON_NEGATION_ZH_RE = /(?:无|非|不|勿|避免|不要|不能|不得|不含|绝非|毫不|并不|从未|禁止)\s*$/
const POISON_NEGATION_EN_RE = /(?:no|not|never|without|avoid|non)(?:[\s-]+[\w-]+){0,1}[\s-]*$/i
function isPoisonNegatedAt(s, idx) {
  const before = s.slice(Math.max(0, idx - 16), idx)
  return POISON_NEGATION_ZH_RE.test(before) || POISON_NEGATION_EN_RE.test(before)
}

// 画风毒词检测（V12 核心函数）：供本文件校验 + routes/generate.js 出片硬闸复用（同一份词表，一处维护）
// texts: 待检文本数组；projectStyleText: 项目画风全文（含该词=白名单放行，写实风项目"写实"合法）
export function findStylePoison(texts, projectStyleText = '') {
  const hits = []
  for (const t of texts) {
    const s = String(t || '')
    if (!s) continue
    for (const w of STYLE_POISON_ZH) {
      if (projectStyleText.includes(w)) continue
      // 扫全部出现位置：任一处非否定携带即算命中（同一词可能先否定后肯定地各出现一次）
      let i = s.indexOf(w)
      let flagged = false
      while (i !== -1) {
        if (!isPoisonNegatedAt(s, i)) { flagged = true; break }
        i = s.indexOf(w, i + w.length)
      }
      if (flagged) hits.push(w)
    }
    for (const w of STYLE_POISON_EN) {
      const re = new RegExp(`\\b${w.replace(/[-]/g, '[- ]')}\\b`, 'gi')
      let m
      let flagged = false
      while ((m = re.exec(s)) !== null) {
        if (!isPoisonNegatedAt(s, m.index)) { flagged = true; break }
      }
      if (flagged && !new RegExp(`\\b${w}\\b`, 'i').test(projectStyleText)) hits.push(w)
    }
  }
  return [...new Set(hits)]
}

function checkStylePoison(shot, errors, label, ctx, codedErrors) {
  const texts = [
    shot.description,
    shot.integratedMultimodalDescription || shot.integrated_multimodal_description,
    shot.finalFrame || shot.final_frame,
    // 字段覆盖补齐（2026-09-12 晚，与出片硬闸 assertNoStylePoison 同口径）：action_note /
    // blocking_plan / video_prompt_override 都会流进出片 prompt，校验层同样要扫。
    shot.actionNote || shot.action_note,
    shot.blockingPlan || shot.blocking_plan,
    shot.videoPromptOverride || shot.video_prompt_override,
  ]
  const hits = findStylePoison(texts, ctx?.projectStyleText || '')
  if (hits.length) {
    const message = `镜头 ${label}：文本含风格切换毒词「${hits.join('、')}」——全片画风统一是铁律，"变强/异变/变身"只能用画面内容表达（体型/毛发/红眼/蒸汽/特效），不能切换画风。请删除这些词并把演出意图改写成画面语言。`
    errors.push(message)
    // 带 code 通道：面板据此归到「画风毒词」分组，展示专属 hint（第1集 5-3 八镜返工实锤）。
    // 此前只进 errors 字符串数组，面板里被归到通用的「必须修（硬错误）」，标题与说明全看不到。
    if (Array.isArray(codedErrors)) codedErrors.push({ code: 'STYLE_POISON', shot: label, message })
  }
}

// ===== 七层美学心法 P0（2026-09-18）工具函数 =====
// 去掉引号内台词（中文"" + 英文""）——动作动词计数不该把台词里的动词算进去
function stripDialogue(text) {
  return String(text || '').replace(/[""].*?[""]/g, '')
}

// 数 @角色 切换次数（不同角色名交替出现 = 多主体各自发力）
function countCharSwitches(desc) {
  const mentions = String(desc || '').match(/@[\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9_]*/g) || []
  let switches = 0
  let prev = null
  for (const m of mentions) {
    const name = m.slice(1)
    if (prev && name !== prev) switches++
    if (name) prev = name
  }
  return switches
}

// 数肢体动作动词出现次数
function countActionBody(text) {
  return ACTION_BODY.reduce((n, w) => n + (String(text).split(w).length - 1), 0)
}

// finalFrame 词袋（英文去停用词 + 中文 2-gram，去 @资产名）
const EN_STOPWORDS = new Set([
  'the','a','an','is','are','was','were','be','been','at','in','on','of','to','and','or','but',
  'his','her','their','its','with','from','by','for','this','that','these','those','it','he','she',
  'they','them','both','all','up','down','out','into','over','under','behind','frame','toward','towards',
  'above','below','left','right','center','front','back','still','now','then','here','there','final',
])
function tokenizeFrame(text) {
  const clean = String(text || '').replace(/@[\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9_]*/g, '')
  const tokens = new Set()
  for (const w of clean.match(/[A-Za-z]{3,}/g) || []) {
    const lw = w.toLowerCase()
    if (!EN_STOPWORDS.has(lw)) tokens.add(lw)
  }
  for (const seg of clean.match(/[\u4e00-\u9fa5]+/g) || []) {
    for (let i = 0; i < seg.length - 1; i++) tokens.add(seg.slice(i, i + 2))
  }
  return tokens
}
function jaccardSet(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}

// L6 接缝（切镜收益）：先用 finalFrame 相似度粗筛，再检查结构性收益；不是画面相似就机械合并。
// 结构性收益包括：新危险/新发现/状态改变/空间或关系改变/明显动作结果。
// 只有“画面相似 + 无台词 + 无结构性收益”才告警；弱信号仍由人判。
const CUT_GAIN_STRUCTURAL_CUES = [
  // 中文：危险、发现、状态与关系变化
  '突然', '忽然', '发现', '看见', '出现', '显现', '靠近', '移动', '逼近', '火光', '水汽', '雾', '裂', '碎', '下沉', '滑出', '冲来', '退回', '跌', '摔', '失去', '挡在', '转身', '跳起', '落地', '抓住', '救', '停住', '骤停',
  // English：兼容 finalFrame / integrated 文本
  'suddenly', 'reveals', 'reveal', 'appears', 'emerges', 'approaches', 'moves toward', 'moving', 'firelight', 'steam', 'fog', 'cracks', 'splinters', 'sinks', 'slides', 'surges', 'retreats', 'falls', 'turns', 'jumps', 'lands', 'grabs', 'blocks',
]
function hasStructuralCutGain(prevShot, currShot) {
  if (!CUT_GAIN_STRUCTURAL_CHECK) return false
  const prevText = String(prevShot.description || '') + ' ' + String(prevShot.finalFrame || prevShot.final_frame || '')
  const currText = String(currShot.description || '') + ' ' + String(currShot.finalFrame || currShot.final_frame || '')
  const curr = currText.toLowerCase()
  const prev = prevText.toLowerCase()
  // 变化词只在下镜出现、上镜没有时算收益，避免两镜都重复写“站/看/雾”等常量词。
  return CUT_GAIN_STRUCTURAL_CUES.some((cue) => curr.includes(cue.toLowerCase()) && !prev.includes(cue.toLowerCase()))
}
function checkCutGain(prevShot, currShot, warnings, shotLabel, sameScene) {
  if (!prevShot || !sameScene) return
  const prevFf = prevShot.finalFrame || prevShot.final_frame || ''
  const currFf = currShot.finalFrame || currShot.final_frame || ''
  if (!prevFf || !currFf) return
  const sim = jaccardSet(tokenizeFrame(prevFf), tokenizeFrame(currFf))
  if (sim <= CUT_GAIN_JACCARD_THRESHOLD) return

  // 台词豁免：下镜有台词 = 这一刀挣到了叙事收益（台词让画面重复变得合理）
  const dlg = Array.isArray(currShot.dialogue)
    ? currShot.dialogue
    : (currShot.dialogue && typeof currShot.dialogue === 'object' ? [currShot.dialogue] : [])
  const hasDialogue = dlg.some((d) => d && String(d?.text || '').trim())
  if (hasDialogue || hasStructuralCutGain(prevShot, currShot)) return

  warnings.push({
    code: 'CUT_WITHOUT_GAIN',
    shot: shotLabel,
    message: `镜头 ${shotLabel}：与上一镜 finalFrame 相似度 ${sim.toFixed(2)} 且本镜无台词、未检测到主体/空间/状态/信息变化——这一刀可能没挣到叙事收益，建议合并走一镜流。若有意保留（反应停顿、节奏断点或隐性信息）可忽略此告警。`,
  })
}

// L4 视角（反应镜）：本镜 A 对 B 说话（画面或台词 text 提到 B），下一镜 B 既不在画面也没台词 → 缺反应镜
// 验证：第1集 6-2 布布喊"别怕…一二"→6-3 一二不在画面没台词，真实缺反应镜；偷看/暗恋有意不对位不抓（判据只看对戏）
// 弱信号告警由人判（B 可能在后续镜回应，但相邻镜缺席已是断档信号）
function checkReactionShot(prevShot, currShot, warnings, shotLabel, charNames) {
  if (!prevShot || !REACTION_SHOT_ENABLED) return
  const dlg = Array.isArray(prevShot.dialogue)
    ? prevShot.dialogue
    : (prevShot.dialogue && typeof prevShot.dialogue === 'object' ? [prevShot.dialogue] : [])
  if (!dlg.length) return
  const speakers = new Set(dlg.filter((d) => d && d.text && d.character).map((d) => d.character))
  if (!speakers.size || !charNames?.length) return

  // 对话对象 B = 画面出现但没说话的角色 + 台词 text 里被提到的非说话角色
  // ⚠️ finalFrame 里的 @ 提及必须用【已知角色名单】过滤：@ 也会标场景/道具（实测 4-5 的 finalFrame
  // 出现 @冰河，被判据当成对话对象，误报 5-1 缺反应镜）。只保留 charNames 里的真角色。
  const prevFf = prevShot.finalFrame || prevShot.final_frame || ''
  const knownChars = new Set(charNames)
  const prevChars = new Set(extractMentions(prevFf).filter((c) => knownChars.has(c)))
  const textChars = new Set()
  for (const d of dlg) {
    if (d && d.text) for (const name of charNames) if (name && String(d.text).includes(name)) textChars.add(name)
  }
  const targets = new Set([...prevChars, ...textChars].filter((c) => !speakers.has(c)))
  if (!targets.size) return

  // 下一镜：B 是否出现（finalFrame/description mentions + dialogue.character + dialogue.text 提到 + characters 字段）
  // 同样用已知角色名单过滤 mentions（@冰河 这类场景/道具标注不算"角色在场"）
  const currFf = currShot.finalFrame || currShot.final_frame || ''
  const currDesc = currShot.description || ''
  const currMentions = new Set([...extractMentions(currFf + ' ' + currDesc)].filter((c) => knownChars.has(c)))
  const currDlg = Array.isArray(currShot.dialogue)
    ? currShot.dialogue
    : (currShot.dialogue && typeof currShot.dialogue === 'object' ? [currShot.dialogue] : [])
  const currSpeakers = new Set(currDlg.filter((d) => d && d.character).map((d) => d.character))
  const currTextMentions = new Set()
  for (const d of currDlg) {
    if (d && d.text) for (const name of charNames) if (name && String(d.text).includes(name)) currTextMentions.add(name)
  }
  let currCharsField = new Set()
  try {
    const cc = typeof currShot.characters === 'string' ? JSON.parse(currShot.characters) : currShot.characters
    if (Array.isArray(cc)) currCharsField = new Set(cc.map(String).filter((c) => knownChars.has(c)))
  } catch {}
  const currPresent = new Set([...currMentions, ...currSpeakers, ...currTextMentions, ...currCharsField])

  const missing = [...targets].filter((t) => !currPresent.has(t))
  if (missing.length) {
    warnings.push({
      code: 'REACTION_SHOT_MISSING',
      shot: shotLabel,
      message: `镜头 ${shotLabel}：上一镜 ${prevShot.shotNumber || prevShot.shot_number || ''} 里 ${[...speakers].join('、')} 对 ${missing.join('、')} 说话，但本镜 ${missing.join('、')} 既不在画面也没台词——看与被看不对位，缺反应镜。请在下一镜补 ${missing.join('、')} 的反应（听见/回应/动作），或调整对话对象的在场性。`,
    })
  }
}

// ===== 七层美学心法 P2（2026-09-18）：L2 光线 / L3 结尾留白 / L5 运镜 / L7 声弧 =====
// 与 P0 同原则：只做可机读的结构断言，弱信号告警由人判；词表通用不绑项目；阈值走 config.storyboard。
// 判据先经 scripts/verify_p2_checks.py 在第1集 42 镜真实数据上调准（3 条真告警、0 误报），再落进本文件。

// L2 光线方向词（finalFrame/mod1 是英文；left↔right 跳变才算空间错位，above/below 不算）
const LIGHT_DIRECTION_PATTERNS = {
  left: [/from frame left/i, /from the left/i, /light from (?:the )?left/i],
  right: [/from frame right/i, /from the right/i, /light from (?:the )?right/i],
}
const LIGHT_WARM_WORDS = ['warm', 'golden', 'amber', 'sunset', 'honey', 'orange', 'fiery']
const LIGHT_COOL_WORDS = ['cool', 'cold', 'icy', 'blue', 'grey', 'gray', 'silver', 'pale', 'frost']

// L5 运镜声明词（mod1 运镜段；static=固定机位不算运镜，计数时排除）
const CAMERA_MOVE_LEXICON = {
  static: ['static', 'locked', 'fixed', 'holds', 'held'],
  push_in: ['push in', 'push-in', 'zoom in', 'zoom-in', 'dolly in', 'push forward'],
  pull_back: ['pull back', 'pull-back', 'pull out', 'pull-out', 'zoom out', 'dolly out'],
  pan: ['pan left', 'pan right', 'pans', 'panning', 'gentle pan'],
  tilt: ['tilt up', 'tilt down', 'camera tilts', 'tilt shot'],
  tracking: ['tracking shot', 'tracking', 'follow shot', 'follows'],
  orbit: ['orbit', 'orbiting', 'circles', 'circle around', 'arcs around'],
  crane: ['crane up', 'crane down', 'crane shot', 'jib'],
}

// L5b 主体性强发力动作（角色自身爆发的大幅动作，固定运镜配它会死画面）。
// 判定严格：不收中等动作（冲/扳/攀）与环境动作（砸/塌/落）——验证时这三类全是误报。
const ACTION_POWER = ['扑', '猛扑', '飞扑', '扑倒', '扑咬', '跃起', '纵身跃', '撞飞', '掀翻', '踢飞', '打斗', '狂奔', '猛冲', '猛撞']

// L7 音乐情绪词（music 文本中英混排，统一小写匹配）
const MUSIC_CALM_WORDS = ['轻柔', '慢板', '舒缓', '安静', '宁静', '柔和', '温柔', '温暖', '悠远', '木吉他', '钢琴', 'arpeggio', 'gentle', 'calm', 'soft', 'slow', 'peaceful', 'warm', 'tender', 'serene']
const MUSIC_INTENSE_WORDS = ['紧张', '急促', '激烈', '激昂', '压迫', '危机', '冲突', '鼓点', '快节奏', '悬疑', '不安', 'intense', 'tense', 'urgent', 'dramatic', 'drum', 'anxious', 'suspense', 'aggressive']
// 剧情转折信号（本镜 description 有转折 = 音乐跳变合理，跟剧情走）
const PLOT_TURN_WORDS = ['突然', '忽然', '惊', '发现', '出现', '危险', '危机', '遇到', '遭遇', '撞上', '看见', '转折', '决定', '坚定', '明白', '意识到', '惊喜', '突破', '完成', '到达']
// 音乐变化类词（music 文本自带变化意图：渐强/渐弱/骤停/柔和下来… = AI 有意设计，跳变豁免）
const MUSIC_TRANSITION_WORDS = ['渐', '骤', '转折', '柔和下来', '沉下来', '静下来', '柔下来', '缓下来', '弱下来', '淡入', '淡出', '停']
// 情绪低点词（该留白的地方该安静）
const SILENCE_CUE_WORDS = ['静静', '沉默', '怔住', '呆住', '无言', '屏住', '愣住', '僵住', '静默', '鸦雀无声', '一动不动', '目不转睛', '屏息', '窒息般']

function shotMusicText(shot) {
  return String(shot?.nonDiegeticMusic ?? shot?.non_diegetic_music ?? '')
}
function shotImdFirstLine(shot) {
  const imd = String(shot?.integratedMultimodalDescription ?? shot?.integrated_multimodal_description ?? '')
  return imd.split('\n')[0] || ''
}

// L2 提取光线方向+色温（从 finalFrame + mod1 文本）
function extractLightCues(text) {
  const t = String(text || '').toLowerCase()
  if (!t) return { direction: null, warmth: null }
  let direction = null
  for (const [dir, patterns] of Object.entries(LIGHT_DIRECTION_PATTERNS)) {
    if (patterns.some((p) => p.test(t))) { direction = dir; break }
  }
  let warmth = null
  if (LIGHT_WARM_WORDS.some((w) => t.includes(w))) warmth = 'warm'
  else if (LIGHT_COOL_WORDS.some((w) => t.includes(w))) warmth = 'cool'
  return { direction, warmth }
}

// L2 主体锁（光线一致性）：同场相邻镜方向 left↔right / 色温 warm↔cool 跳变 → 告警
// 验证：第1集 6-1(warm golden)→6-2(blue) 同场雾戏色温跳变无叙事理由，真问题
// 弱信号人判：开场镜 mod1 带风格声明、连续镜 mod1 是继承模板，提取源不对称时人工排除
function checkLightFlip(prevShot, currShot, warnings, shotLabel, sameScene) {
  if (!prevShot || !sameScene || !LIGHT_FLIP_ENABLED) return
  const prevCues = extractLightCues(`${prevShot.finalFrame || prevShot.final_frame || ''} ${shotImdFirstLine(prevShot)}`)
  const currCues = extractLightCues(`${currShot.finalFrame || currShot.final_frame || ''} ${shotImdFirstLine(currShot)}`)
  const issues = []
  if (prevCues.direction && currCues.direction && prevCues.direction !== currCues.direction) {
    issues.push(`光线方向跳变：${prevCues.direction}→${currCues.direction}`)
  }
  if (prevCues.warmth && currCues.warmth && prevCues.warmth !== currCues.warmth) {
    issues.push(`色温跳变：${prevCues.warmth}→${currCues.warmth}`)
  }
  if (!issues.length) return
  warnings.push({
    code: 'LIGHT_DIRECTION_FLIP',
    shot: shotLabel,
    message: `镜头 ${shotLabel}：${issues.join('、')}——同场相邻镜光线应一致，方向/色温跳变会让画面空间错位。若是有意的氛围转换（如回忆/幻想/时间推移）可忽略此告警。`,
  })
}

// L3 节奏（结尾留白）：结尾镜时长 < 全片平均×阈值 → 余韵不足（集级检查，放 validateStoryboard）
// 验证：第1集 8-5 结尾镜 6s < 平均 6.1s×1.3=7.9s，压轴镜仓促，真问题
function checkEndingRushed(flatShots, warnings) {
  if (!Array.isArray(flatShots) || flatShots.length < 5) return
  const durations = flatShots.map((s) => Number(s.duration) || 0)
  const avg = durations.reduce((a, b) => a + b, 0) / durations.length
  const ending = durations[durations.length - 1]
  if (!avg || !ending) return
  const threshold = avg * ENDING_RUSHED_RATIO
  if (ending >= threshold) return
  const last = flatShots[flatShots.length - 1]
  warnings.push({
    code: 'ENDING_RUSHED',
    shot: last.label,
    message: `结尾镜 ${last.label} 时长 ${ending}s < 全片平均 ${avg.toFixed(1)}s × ${ENDING_RUSHED_RATIO} = ${threshold.toFixed(1)}s——情绪升华需要余韵，结尾该留白让画面多停一拍（台词结束后画面继续停留，给出余味）。`,
  })
}

// L5a 一镜一主运镜：mod1 动态运镜声明词 >1（static 固定机位不算运镜，不计数）
// 验证：第1集 4-4 "static…tilt" 是固定+上摇的组合描述，static 不计后只剩 1 个动态运镜 → 0 误报
function checkMultiCameraMove(shot, warnings, shotLabel) {
  if (!CAMERA_MOVE_CHECK_ENABLED) return
  const mod1 = shotImdFirstLine(shot).toLowerCase()
  if (!mod1) return
  const moves = []
  for (const [moveType, words] of Object.entries(CAMERA_MOVE_LEXICON)) {
    if (moveType === 'static') continue
    if (words.some((w) => mod1.includes(w))) moves.push(moveType)
  }
  if (moves.length <= 1) return
  warnings.push({
    code: 'MULTI_CAMERA_MOVE',
    shot: shotLabel,
    message: `镜头 ${shotLabel}：模块1 声明了 ${moves.length} 个动态运镜（${moves.join(',')}）——一镜一主运镜，多运镜拆成多镜或只选一个最强的。`,
  })
}

// L5b 动作-运镜匹配：主体强发力动作 + 固定运镜 = 动作死画面（动作即运镜被违反）
// 验证：第1集 7-1「跃/纵身跃」上巨石配固定镜，真问题；1-4「砸」(环境)/2-1「冲」(中等)/4-4「扳」(持续) 收紧词表后不再误报
function checkActionCameraMismatch(shot, warnings, shotLabel) {
  if (!CAMERA_MOVE_CHECK_ENABLED) return
  const cam = String(shot.cameraMovement || shot.camera_movement || '')
  if (cam !== '固定') return
  const desc = String(shot.description || '')
  if (!desc) return
  const hits = ACTION_POWER.filter((w) => desc.includes(w))
  if (!hits.length) return
  warnings.push({
    code: 'ACTION_CAMERA_MISMATCH',
    shot: shotLabel,
    message: `镜头 ${shotLabel}：描述含主体强发力动作「${hits.join('、')}」但运镜是"固定"——动作即运镜被违反，大动作在静止画框里会死。建议改为跟拍/环绕/手持晃动配合动作；若发力的是环境而非角色主体可忽略此告警。`,
  })
}

// L7 音乐情绪分类：calm / intense / none（none=留白或无音乐，不参与跳变判定）
function musicEmotion(musicText) {
  const m = String(musicText || '').toLowerCase()
  if (!m.trim()) return 'none'
  const calm = MUSIC_CALM_WORDS.reduce((n, w) => n + (m.includes(w.toLowerCase()) ? 1 : 0), 0)
  const intense = MUSIC_INTENSE_WORDS.reduce((n, w) => n + (m.includes(w.toLowerCase()) ? 1 : 0), 0)
  if (calm > intense) return 'calm'
  if (intense > calm) return 'intense'
  return 'none'
}

// L7a 声弧连续：相邻同场镜音乐情绪 calm↔intense 硬跳变，且无剧情转折、无音乐变化意图 → 告警
// 验证：第1集 5 条候选全是 AI 有意设计（music 文本自带「柔和下来/情绪转折/渐强」），加变化词豁免后 0 误报
function checkSoundArc(prevShot, currShot, warnings, shotLabel, sameScene) {
  if (!prevShot || !sameScene || !SOUND_ARC_ENABLED) return
  const prevMusic = shotMusicText(prevShot)
  const currMusic = shotMusicText(currShot)
  const prevEmotion = musicEmotion(prevMusic)
  const currEmotion = musicEmotion(currMusic)
  if (prevEmotion === 'none' || currEmotion === 'none' || prevEmotion === currEmotion) return
  // 豁免1：本镜 description 有剧情转折信号 = 跳变合理（音乐跟剧情走）
  const desc = String(currShot.description || '')
  if (PLOT_TURN_WORDS.some((w) => desc.includes(w))) return
  // 豁免2：相邻镜任一 music 文本含变化类词 = AI 有意设计的渐变/突变
  if (MUSIC_TRANSITION_WORDS.some((w) => prevMusic.includes(w) || currMusic.includes(w))) return
  warnings.push({
    code: 'SOUND_ARC_BREAK',
    shot: shotLabel,
    message: `镜头 ${shotLabel}：音乐情绪从 ${prevEmotion} 突跳 ${currEmotion}，且本镜无剧情转折、音乐文本也无渐变意图——声弧突兀断裂，音乐转折该跟剧情走（加过渡，或在 music 里写明渐变）。`,
  })
}

// L7b 该留白的地方该安静：description 含情绪低点词（静静/沉默/怔住…）但本镜有台词/音乐 → 告警
// 验证：第1集 0 条（防御性判据，防未来剧本在情绪低点把声音塞满）
function checkSilenceGap(shot, warnings, shotLabel) {
  if (!SILENCE_GAP_ENABLED) return
  const desc = String(shot.description || '')
  if (!SILENCE_CUE_WORDS.some((w) => desc.includes(w))) return
  const music = shotMusicText(shot)
  const hasMusic = Boolean(music.trim()) && !music.includes('无') && !music.includes('停')
  const hasDlg = hasDialogueContent(shot.dialogue)
  if (!hasMusic && !hasDlg) return
  warnings.push({
    code: 'SILENCE_GAP',
    shot: shotLabel,
    message: `镜头 ${shotLabel}：description 含情绪低点词（静静/沉默/怔住等）但本镜有${hasMusic ? '音乐' : ''}${hasMusic && hasDlg ? '和' : ''}${hasDlg ? '台词' : ''}——该留白的地方该安静，让观众听到呼吸/风声。`,
  })
}

// ===== 第四轮美学级校验（2026-09-19）：因果链 / 死画面长镜 / 音乐语言 / 开场钩子 =====
// 来源：34镜导演级美学评估发现的四类通用问题。词表与判据通用，不绑任何剧本。

// 因果连接词：A 动作直接导致 B/物体状态改变。单镜 ≥2 环且 ≥3 主体 = 连锁超载。
const CHAIN_CAUSE_WORDS = ['导致', '致使', '使得', '拽走', '拖走', '带飞', '撞翻', '掀翻', '压垮', '压塌', '撞飞', '踢飞', '卷走', '冲垮', '震落', '砸断', '压断']
const CHAIN_REACTION_CHECK_ENABLED = config.storyboard?.chainReactionCheckEnabled !== false

// 开场钩子冲突词：第一镜画面里应有"异常物/危险/动作"之一
const OPENING_HOOK_WORDS = ['断', '裂', '追', '逃', '躺', '倒', '喊', '惊', '危险', '危机', '异常', '忽然', '突然', '发现', '撞', '坠', '滚落', '着火', '血', '尸体', '陌生人', '哭声', '求救']
const OPENING_HOOK_CHECK_ENABLED = config.storyboard?.openingHookCheckEnabled !== false

// L8a 因果链超载：单镜 ≥2 个因果连接 + ≥3 个不同 @主体 → 连锁反应塞一镜，出片必糊
// 验证：34镜 3-3（布布起跳→冰面倾斜→熊换脚→冰被水流拽走，4环3主体）真问题
function checkChainReactionOverload(shot, warnings, shotLabel) {
  if (!CHAIN_REACTION_CHECK_ENABLED) return
  const desc = String(shot.description || '')
  if (!desc) return
  const causeHits = CHAIN_CAUSE_WORDS.filter((w) => desc.includes(w))
  if (causeHits.length < 1) return
  const mentions = new Set(extractMentions(desc))
  // 因果词≥1 + 主体≥3 + 动作动词≥4：多主体连锁反应
  const bodyCount = countActionBody(stripDialogue(desc))
  if (mentions.size >= 3 && bodyCount >= 4) {
    warnings.push({
      code: 'CHAIN_REACTION_OVERLOAD',
      shot: shotLabel,
      message: `镜头 ${shotLabel}：${mentions.size} 个主体 + 因果词「${causeHits.join('、')}」+ ${bodyCount} 个动作——多主体连锁反应塞一镜，出片模型只能演开头。按因果转折点拆镜：前一镜停在「因」（失衡/起跳），后一镜从「果」（被拖走/翻倒）开始。`,
    })
  }
}

// L8b 死画面长镜：长镜 + 无台词 + 固定机位 + 远景别 = 空转（防御性判据）
// 设计原则：长镜必须有名分——运镜在推进、情绪在沉淀、或空间在揭示；"四无"死画面禁止
// 豁免：有音乐且音乐文本含变化/留白意图（渐/柔/弱/静）= 氛围长镜有名分（实测 34镜 8-1 入夜建境配渐弱钢琴，该豁免）
const EMPTY_LONG_SHOT_MIN_SEC = config.storyboard?.emptyLongShotMinSec ?? 8
const EMPTY_LONG_SHOT_ENABLED = config.storyboard?.emptyLongShotEnabled !== false
function checkEmptyLongShot(shot, warnings, shotLabel, isLastShot = false) {
  if (!EMPTY_LONG_SHOT_ENABLED) return
  if (isLastShot) return // 结尾镜豁免：结尾留白规则（L3）鼓励长镜，两规则在此让路——留白归 L3 管
  const dur = Number(shot.duration) || 0
  if (dur < EMPTY_LONG_SHOT_MIN_SEC) return
  if (hasDialogueContent(shot.dialogue)) return
  const cam = String(shot.cameraMovement || shot.camera_movement || '')
  if (cam !== '固定') return // 有运镜就有名分（横摇/推近都在做事）
  const shotType = String(shot.shotType || shot.shot_type || '')
  if (!WIDE_SHOT_TYPES.includes(shotType)) return // 中近景固定长镜是文戏常态，不管
  // 音乐有名分豁免：音乐文本非空且带变化/留白意图 = 氛围长镜（声音在替画面做事）
  const music = shotMusicText(shot)
  if (music.trim() && MUSIC_TRANSITION_WORDS.some((w) => music.includes(w))) return
  warnings.push({
    code: 'EMPTY_LONG_SHOT',
    shot: shotLabel,
    message: `镜头 ${shotLabel}：${dur}s 全景/远景 + 固定机位 + 无台词——死画面长镜，观众会走神。长镜要有名分：要么运镜推进（缓慢推近到表情）、要么明确氛围留白设计（写明 micro-movement 与环境声）。`,
  })
}

// L8c 音乐文本语言漂移：同集内音乐文本主语言应统一（集级检查）
// 验证：34镜 5-1 "tense drums..." 纯英文，其余33镜全中文 → 风格跳变
const MUSIC_LANG_CHECK_ENABLED = config.storyboard?.musicLangCheckEnabled !== false
function isMostlyChinese(text) {
  const t = String(text || '')
  if (!t.trim()) return null // 无音乐不参与
  const zh = (t.match(/[一-龥]/g) || []).length
  const en = (t.match(/[A-Za-z]/g) || []).length
  if (zh + en === 0) return null
  return zh >= en
}
function checkMusicLanguageConsistency(flatShots, warnings) {
  if (!MUSIC_LANG_CHECK_ENABLED) return
  const votes = flatShots.map((s) => isMostlyChinese(s.music)).filter((v) => v !== null)
  if (votes.length < 4) return // 音乐文本太少不评
  const zhCount = votes.filter(Boolean).length
  const majorityZh = zhCount > votes.length / 2
  for (const s of flatShots) {
    const v = isMostlyChinese(s.music)
    if (v === null || v === majorityZh) continue
    warnings.push({
      code: 'MUSIC_LANGUAGE_INCONSISTENT',
      shot: s.label,
      message: `镜头 ${s.label}：音乐文本「${String(s.music).slice(0, 30)}…」是${v ? '中文' : '英文'}，但全片主流是${majorityZh ? '中文' : '英文'}——音乐描述语言应全片统一（建议统一中文），混排会让音乐模型理解不稳定。`,
    })
  }
}

// L8d 开场钩子慢：前两镜无冲突词 + 无台词 + 总时长超阈值 → 钩子没建立
// 【生成严、验收宽的双层设计——非矛盾】prompt 层（episodeStructureRule 第1条）要求"3 秒内建立冲突、禁纯氛围建境>4 秒"，
// 那是生成期硬约束，卡的是第一镜内部结构；本校验"前两镜共 10s"是验收期弱信号，卡的是前两镜合计节奏——
// 生成严（防懒）、验收宽（防误报有设计意图的开场），两层阈值不同属刻意设计，不是逻辑打架。
// 验证：34镜 1-1行进6s+1-2拉远8s=14s 无台词无冲突物，第14秒才有第一句台词
const OPENING_HOOK_MAX_SEC = config.storyboard?.openingHookMaxSec ?? 10
function checkOpeningHook(flatShots, warnings) {
  if (!OPENING_HOOK_CHECK_ENABLED) return
  if (flatShots.length < 5) return
  const first = flatShots[0]
  const firstTwo = flatShots.slice(0, 2)
  const totalSec = firstTwo.reduce((a, s) => a + (Number(s.duration) || 0), 0)
  const hasConflict = OPENING_HOOK_WORDS.some((w) => String(first.description || '').includes(w))
  const hasDialogue = firstTwo.some((s) => s.hasDialogue)
  if (hasConflict || hasDialogue) return
  if (totalSec <= OPENING_HOOK_MAX_SEC) return
  warnings.push({
    code: 'OPENING_HOOK_SLOW',
    shot: first.label,
    message: `开场两镜共 ${totalSec}s：无冲突/危险/异常画面，也无台词——钩子建立太慢，观众在前 ${OPENING_HOOK_MAX_SEC}s 内没有"异常物"可看。第一镜应让冲突/悬念/危险/异常与建境同镜完成（如"行进中发现前方躺着巨物"），或把第一句有信息的台词提前。`,
  })
}

// ===== 第五轮 纪律级校验（2026-09-19）：切点重复 / 动作密度 / 属性分布 =====
// 来源：《第2集37镜导演评审》暴露的三类"机器完全没看到、靠人眼才捞出"的问题。
//
// 为什么要单独做成一轮：前四轮解决的是"生成期该不该那么写"，这一轮解决的是
// **"生成结果的纪律体检"**——三者都是纯机械判断（不需要创作判断），所以判据必须确定、
// 可复现，不依赖模型这次心情好不好。它们不改写分镜（内容归模型创作），只把问题捞出来，
// 让"重提一次 → 照清单过一遍"成为稳定流程，而不是每版都要导演从头扫一遍。
//
// 与既有判据的分工（避免看起来像重复告警）：
//   CUT_ACTION_OVERLAP ← 切点两侧「同一动作说了两遍」（叙事倒带），CUT_WITHOUT_GAIN 管的是「画面重复」；
//   ACTION_DENSITY_HIGH ← 动作量 ÷ 时长（装不装得下），MULTI_BEAT_SUSPECT 管的是「节拍结构」；
//   SHOT_ATTRIBUTE_MONOTONE ← 全片分布（拍法是否单一），SCENE_SHOTTYPE_FLAT 管的是「单场平推」。

// L9a 切点动作重复：上镜最终画面里"正在做的动作"，被下镜描述又从零做了一遍。
// 症状：观众看到"一只脚刚踩上桥板"停一拍，下一镜"又踩上桥板"——叙事原地倒带（37镜 2-1→2-2 实锤）。
// 实现：上镜 finalFrame（英文）取 -ing 进行时动作 → 映射中文动作词 → 下镜描述开头若出现
//       「同一主体 + 同一动作」，判切点重复。主体必须相同，否则可能只是两个不相关的动作。
const CUT_ACTION_OVERLAP_ENABLED = config.storyboard?.cutActionOverlapCheckEnabled !== false
// 词表刻意**只收有过程性的动作**，不收 standing / sitting / leaning / crouching / walking / gripping
// 这类姿态与静态握持词：它们在 finalFrame 里几乎是必现的末帧状态描写（"the cliff wall standing at frame right"），
// 而下镜开头也常写"站着/握着"，会把同一个姿态误判成"动作被重复"——实测收进来时 7 条告警里 6 条是这类误报。
const EN_ING_TO_ZH_ACTION = {
  stepping: ['踩', '踏', '迈'], reaching: ['伸', '够'], grabbing: ['抓', '拽'],
  lifting: ['抬', '举'], raising: ['抬', '举'], lowering: ['压', '低'], turning: ['转', '扭'],
  jumping: ['跳', '跃'], running: ['跑', '冲'], pushing: ['推'], pulling: ['拉', '拽'],
  climbing: ['爬', '攀'], rising: ['起身', '站起'], pointing: ['指'], boarding: ['上'],
}
// 取"每个进行时动作 + 它的主语"：动作前 60 字符内最近的 @角色 才算这个动作的主语。
// 这一步是精度关键——只看"有没有同一动作词"会把两个不同主体的相似动作也算进来（如 1-3 一二抬爪指对岸、
// 1-4 大白熊抬爪急停，是两回事），加上主语约束后只剩"同一主体把同一动作又做了一遍"。
function extractActorIngPairs(frame) {
  const out = []
  const re = /@([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9_]*)|([A-Za-z]+ing)\b/g
  let m
  let lastActor = ''
  let lastActorIdx = -1
  while ((m = re.exec(frame)) !== null) {
    if (m[1]) {
      lastActor = m[1]
      lastActorIdx = m.index
    } else if (m[2] && lastActor && m.index - lastActorIdx <= 60) {
      out.push({ actor: lastActor, ing: m[2].toLowerCase() })
    }
  }
  return out
}
function checkCutActionOverlap(prevShot, currShot, warnings, shotLabel) {
  if (!CUT_ACTION_OVERLAP_ENABLED) return
  if (!prevShot || !currShot) return
  const prevFrame = String(prevShot.finalFrame || prevShot.final_frame || '')
  const currDesc = String(currShot.description || '')
  if (!prevFrame || !currDesc) return
  const headDesc = currDesc.slice(0, 30)
  for (const { actor, ing } of extractActorIngPairs(prevFrame)) {
    const zh = EN_ING_TO_ZH_ACTION[ing]
    if (!zh) continue
    // 同一主体：上镜该动作的主语，必须也在本镜描述开头出现
    if (!headDesc.includes('@' + actor)) continue
    // 本镜开头把同一动作又写了一遍
    const hit = zh.filter((z) => headDesc.includes(z))
    if (!hit.length) continue
    warnings.push({
      code: 'CUT_ACTION_OVERLAP',
      shot: shotLabel,
      message: `镜头 ${shotLabel}：上一镜最终画面停在 @${actor} 的「${hit.join('/')}」动作上，本镜描述开头又写了一次「${hit.join('/')}」——同一个动作被陈述两遍，观众会看到叙事原地倒带（上镜刚做完，本镜重做）。把上镜末帧收在该动作**之前**（如"转身面向断桥"），把动作整段让给本镜。`,
    })
    break // 一镜最多报一条
  }
}

// L9b 动作密度：肢体动作数 ÷ 时长超上限 → 时长装不下这个动作量，出片只能演开头或演糊。
// 验证：37镜 2-3（6s 装 6 个动作，密度 1.0）。判据复用 countActionBody，与 CHAIN/MULTI_BEAT 同词表。
const ACTION_DENSITY_ENABLED = config.storyboard?.actionDensityCheckEnabled !== false
const ACTION_DENSITY_MAX = config.storyboard?.actionDensityMax ?? 0.6
function checkActionDensity(shot, warnings, shotLabel) {
  if (!ACTION_DENSITY_ENABLED) return
  const dur = Number(shot.duration) || 0
  if (dur <= 0) return
  const body = countActionBody(stripDialogue(String(shot.description || '')))
  if (body < 3) return // 1~2 个动作的短镜正常，不评
  const density = body / dur
  if (density <= ACTION_DENSITY_MAX) return
  const needSec = Math.ceil(body / ACTION_DENSITY_MAX)
  warnings.push({
    code: 'ACTION_DENSITY_HIGH',
    shot: shotLabel,
    message: `镜头 ${shotLabel}：${dur}s 内 ${body} 个肢体动作（密度 ${density.toFixed(1)} 个/秒，上限 ${ACTION_DENSITY_MAX}）——时长装不下这个动作量，出片模型只能演开头、或把手部动作演糊。要么按任务边界拆镜，要么把时长延到约 ${needSec}s。`,
  })
}

// L9c 属性分布单调（集级）：单一机位朝向/景别/运镜占比过高 → 全片拍法单一。
// 验证：37镜 侧面 18/37=49%、跟拍 14/37=38%——导演评审最直观的问题，此前机器完全没看到。
// 阈值取"电影常见配比"的宽松上限：机位侧向 45%、景别 40%、运镜 30%。
const ATTR_MONOTONE_ENABLED = config.storyboard?.attrMonotoneCheckEnabled !== false
const ATTR_MONOTONE_LIMITS = [
  {
    key: 'cameraAngle',
    name: '机位朝向',
    max: config.storyboard?.attrMonotoneAngleMax ?? 0.45,
    hint: '渡河/追逐这类横向调度最省事的就是一路侧面，但连着七八个侧面会让观众空间感麻木——插一个反打、一个 POV 主观镜、或换一次侧，就能打破这堵墙',
  },
  {
    key: 'shotType',
    name: '景别',
    max: config.storyboard?.attrMonotoneShotTypeMax ?? 0.4,
    hint: '单一景别占比过高，全片会像同一台机器拍的——按"远景交代空间 → 中景建立关系 → 近景/特写承担情绪"搭配，别让中景承包全片',
  },
  {
    key: 'cameraMovement',
    name: '运镜',
    max: config.storyboard?.attrMonotoneMoveMax ?? 0.3,
    hint: '同一运镜用得太密，强调手段用多了等于没有强调——换固定/升降/环绕制造节奏差，情绪镜宁可用固定机位让画面自己说话',
  },
]
function checkShotAttributeMonotone(flatShots, warnings) {
  if (!ATTR_MONOTONE_ENABLED) return
  if (flatShots.length < 8) return // 镜头太少，占比没有统计意义
  for (const cfg of ATTR_MONOTONE_LIMITS) {
    const tally = new Map()
    for (const s of flatShots) {
      const v = String(s[cfg.key] || '').trim()
      if (v) tally.set(v, (tally.get(v) || 0) + 1)
    }
    const valid = [...tally.values()].reduce((a, b) => a + b, 0)
    if (!valid) continue
    let top = ''
    let cnt = 0
    for (const [k, c] of tally) if (c > cnt) { cnt = c; top = k }
    if (cnt / valid <= cfg.max) continue
    warnings.push({
      code: 'SHOT_ATTRIBUTE_MONOTONE',
      shot: '*',
      message: `全片${cfg.name}分布单调：${top} 占 ${cnt}/${valid}（${Math.round((cnt / valid) * 100)}%，上限 ${Math.round(cfg.max * 100)}%）——${cfg.hint}。`,
    })
  }
}

function checkCinematicGrammar(shot, warnings, label) {
  const shotType = String(shot.shotType || shot.shot_type || '')
  // V11a 情绪点景别：台词 tone 命中强情绪词 + 景别为远/全景 → 告警
  const dlgList = Array.isArray(shot.dialogue)
    ? shot.dialogue
    : (shot.dialogue && typeof shot.dialogue === 'object' ? [shot.dialogue] : [])
  if (dlgList.length && WIDE_SHOT_TYPES.includes(shotType)) {
    const emo = dlgList.filter((d) => EMOTION_TONE_WORDS.some((w) => String(d?.tone || '').includes(w)))
    if (emo.length) {
      warnings.push({
        code: 'EMOTION_SHOT_TOO_WIDE',
        shot: label,
        message: `镜头 ${label}：台词「${String(emo[0]?.text || '').slice(0, 12)}」（语气:${emo[0]?.tone}）是强情绪点，但景别是${shotType}——情绪点在远景里看不清脸。按镜头语言规则，该镜应改为特写/近景，或把台词挪到特写镜。`,
      })
    }
  }

  // V11c 多拍嫌疑（L1 一镜一任务，2026-09-18 升级）：
  // 旧版纯靠连接词≥3 触发，模型不用连接词也能塞多拍（"她看见熊，缩肩，转头就跑"），13条真实多拍零报。
  // 升级：去台词后三信号——连接词≥3 或 (肢体动作≥4 且角色切换≥1) 或 (肢体动作≥3 且连接词≥1)
  // 验证：第1集42镜——13条真实多拍全中零误报（1-4/1-6/2-1/2-2/2-3/2-4/2-5/3-4/5-1/5-2/6-3/6-8/7-1）
  const desc = String(shot.description || '')
  if (desc) {
    const hits = BEAT_CONNECTORS.filter((w) => desc.includes(w))
    const connectorCount = hits.length
    const stripped = stripDialogue(desc)
    const bodyCount = countActionBody(stripped)
    const switchCount = countCharSwitches(desc)
    const triggered = (connectorCount >= MULTI_BEAT_CONNECTOR_THRESHOLD)
      || (bodyCount >= MULTI_BEAT_ACTION_THRESHOLD && switchCount >= 1)
      || (bodyCount >= MULTI_BEAT_ACTION_WITH_CONNECTOR && connectorCount >= 1)
    if (triggered) {
      warnings.push({
        code: 'MULTI_BEAT_SUSPECT',
        shot: label,
        message: `镜头 ${label}：疑似一镜多拍（连接词${connectorCount} + 肢体动作${bodyCount} + 角色切换${switchCount}）——请按任务边界复核：若这些动作分属多个独立任务（发现/反应/新动作各自独立），拆成多镜靠 Airlock 衔接；若为同一任务的连续动作链（如听见→决定→循声走去），可保留一镜，忽略此告警。`,
      })
    }
  }
}

// V16 场景锚完整性（2026-09-15 第2集场1 重建时发现）：
// sceneAssets 为空 → 出片没有场景参考图，环境与画风跟着其他参考图漂；
// sceneAssets 名字不在场景资产清单里 → 按名解析落空，等同没有场景锚。
// 与 V7 的分工：V7 只在「资产存在但 image_url 为空」时告警，名字根本不存在时 V7 静默放行——
// 实测场1 有 3 镜 scene_assets=[]、另有 4 镜挂的名字与场景库对不上，V7 一条都没报。
function checkSceneAnchor(shot, warnings, label, ctx) {
  if (!ctx.assetNames) return
  const names = Array.isArray(shot.sceneAssets)
    ? shot.sceneAssets.map((x) => String(x || '').trim()).filter(Boolean)
    : []
  if (!names.length) {
    warnings.push({
      code: 'SCENE_ASSET_EMPTY',
      shot: label,
      message: `镜头 ${label}：sceneAssets 为空——该镜出片时没有场景参考图，环境与画风会跟着角色参考图漂。每个镜头至少挂一个场景资产（同场连续镜可复用同一场景）。`,
    })
    return
  }
  const known = new Set(
    (ctx.assetNames.scenes || [])
      .map((s) => (typeof s === 'string' ? s : (s?.name || s?.title || '')))
      .filter(Boolean)
  )
  if (!known.size) return
  const unknown = names.filter((n) => !known.has(n))
  if (unknown.length) {
    warnings.push({
      code: 'SCENE_ASSET_UNKNOWN',
      shot: label,
      message: `镜头 ${label}：sceneAssets 里的「${unknown.join('、')}」在场景资产清单里找不到——按名解析会落空，等同没有场景锚。请先建场景资产，或把名字改成清单里的现有场景（V7 对"名字不存在"不告警，故在此单独补）。`,
    })
  }
}

// V17 场次编号对齐（2026-09-15 第2集场1 重建时发现；**已修正结论**）。
//
// ⚠ 重要更正（2026-09-15 二次核实）：本检查最初写成「下游按 scene_number 取场景图会拿错别场场景」——
// 这句是**错的**。实际核查 routes/generate-image.js:448/585、generate-video.js:246/653、
// generate-script.js:754/799 等处，场景图解析一律是
//     sceneRows.find((s) => parseNames(shot.scene_assets).includes(s.title))
// 即**按名字匹配，从不使用 scene_number**。所以场次数不一致本身**不会**导致取错图。
//
// 真正会出事的是"名字对不上"，而且出事方式是**静默降级**：
// sceneRow === null → `if (sceneRow?.image_url) refs.push(...)` 静默少推一张参考图，
// 不报错、不告警、不落 alerts，只是画面环境/画风悄悄漂。这才是第2集 26 镜的真实故障机理。
//
// 故本检查**降级为提示**（不是缺陷）：不同场次共用同一场景资产是合法的
// （如第2集场3「浮冰摆渡」与场4「河中惊险」共用一个冰河场景资产）。
// 要命的那条是 SCENE_ASSET_UNKNOWN / SCENE_ASSET_EMPTY（V16）。
export function checkSceneIndexAlignment(storyboardSceneNumbers = [], sceneRows = []) {
  const board = [...new Set(storyboardSceneNumbers.map(Number).filter(Number.isFinite))].sort((a, b) => a - b)
  const table = [...new Set(sceneRows.map((r) => Number(typeof r === 'object' ? r?.scene_number : r)).filter(Number.isFinite))].sort((a, b) => a - b)
  if (board.length === table.length) return []
  return [
    `场次数与场景资产数不一致：分镜 ${board.length} 场（${board.join('/')}）vs 场景资产 ${table.length} 个（${table.join('/')}）。` +
    `这是**提示不是缺陷**——多个场次共用同一场景资产是合法的（同一地点）、也是常见的。` +
    `只有当天数少到某个镜头的场景资产名在场景表里找不到时才是真问题（见 SCENE_ASSET_UNKNOWN）。`,
  ]
}

/**
 * 校验单个镜头。
 * @param {object} shot 镜头对象（会被 backfillShotAssets 就地修改）
 * @param {object} ctx { assetNames, prevShot, shotLabel }
 * @returns {{ errors: string[], warnings: object[], fixed: string[], codedErrors: object[] }}
 */
export function validateShot(shot, ctx = {}) {
  const errors = []
  const warnings = makeWarnings()
  const fixed = []
  // 带 code 的错误通道（2026-09-16）：errors 是字符串数组（生成阶段直接喂回 LLM 重试，
  // 保持原样不动），但面板需要 code 才能给出专属标题与说明。凡是"有 code 的硬错误"
  // 都同时记进这里，由 summarizeQc 优先按 code 归类，避免落进通用的「必须修（硬错误）」。
  const codedErrors = []
  const label = ctx.shotLabel || shot.shotNumber || shot.shot_number || shot.id || 'unknown'

  // V1 必填字段非空
  if (!shot.finalFrame && !shot.final_frame) {
    errors.push(`镜头 ${label}：finalFrame 字段为空，必须填写本镜最终画面描述（下一镜 Airlock 继承依据）`)
  }
  if (!shot.integratedMultimodalDescription && !shot.integrated_multimodal_description) {
    errors.push(`镜头 ${label}：integratedMultimodalDescription 字段为空，必须填写 AI 图像/视频模型使用的完整提示词`)
  }

  // V2 duration 范围
  const dur = Number(shot.duration)
  if (!dur || isNaN(dur)) {
    errors.push(`镜头 ${label}：duration 缺失或非数字`)
  } else if (dur < DURATION_MIN || dur > DURATION_MAX) {
    warnings.push({
      code: 'DURATION_OUT_OF_RANGE',
      shot: label,
      message: `镜头 ${label}：duration=${dur}s，超出 ${DURATION_MIN}-${DURATION_MAX}s 范围`,
    })
  }

  // V6 角色覆盖（程序化修复，复用 assetBackfill）
  if (ctx.assetNames) {
    const before = JSON.stringify(shot.characters || [])
    backfillShotAssets(shot, ctx.assetNames)
    const after = JSON.stringify(shot.characters || [])
    if (before !== after) {
      fixed.push(`镜头 ${label}：characters 已程序化补齐（${before} → ${after}）`)
    }
  }

  // V4 跨字段 @角色一致性
  // characters 应是 description / AI Prompt / finalFrame 里 @角色的并集（已在 V6 修复）
  // 这里只校验反向：characters 里的角色是否都在画面中出现（避免多登记）
  const descMentions = new Set(extractMentions(shot.description || ''))
  const promptMentions = new Set(extractMentions(shot.integratedMultimodalDescription || shot.integrated_multimodal_description || ''))
  const frameMentions = new Set(extractMentions(shot.finalFrame || shot.final_frame || ''))
  const allMentions = new Set([...descMentions, ...promptMentions, ...frameMentions])

  // 注意：@ 角色名可能出现在场景/道具里，这里只看 characters 是否"多登记"
  // （即 characters 里有但三个文本字段都没 @ 到——可能是 AI 误加）
  const charSet = new Set(shot.characters || [])
  const extra = [...charSet].filter((c) => !allMentions.has(c))
  if (extra.length > 0 && ctx.assetNames) {
    // 只在 extra 是已知角色时才告警（过滤掉 @ 没标但确实在场的边缘情况）
    const knownChars = new Set((ctx.assetNames.characters || []).map((c) => (typeof c === 'string' ? c : c.name)))
    const realExtra = extra.filter((c) => knownChars.has(c))
    if (realExtra.length > 0) {
      warnings.push({
        code: 'CHAR_OVER_REGISTERED',
        shot: label,
        message: `镜头 ${label}：characters 含 @${realExtra.join(' @')}，但 description/AI Prompt/finalFrame 均未提及，可能多登记`,
      })
    }
  }

  // V5 Airlock 继承精确度（只校验角色，道具/场景特写不继承是正常的）
  const charRows = ctx.assetNames ? (ctx.assetNames.characters || []) : null
  const charNames = charRows
    ? charRows.map((c) => (typeof c === 'string' ? c : c.name))
    : null
  // 别名映射（name_en / aliases）：模型常写英文名，只拿中文名清单查侧位会大面积漏检。
  // 组装一次、全镜头复用（aliasCtx 是纯数据，跨 shot 无状态）。
  const aliasCtx = charRows
    ? buildAliasMap(charRows.filter((c) => typeof c !== 'string'))
    : null
  checkAirlockInheritance(ctx.prevShot, shot, warnings, label, charNames)

  // V10 画面地理：跨镜侧位翻转检测（Airlock 复刻腐化 = 强信号；finalFrame 翻转无走位 = 弱信号）
  checkFrameGeography(ctx.prevShot, shot, warnings, label, charNames, aliasCtx)

  // V13 跨镜位置跳变：同角色位置载体凭空变化且无移动动作 → 剧本级瞬移（弱信号，人判）
  checkLocationTeleport(ctx.prevShot, shot, warnings, label, charNames)

  // V11 镜头语言：情绪点景别（V11a）+ 多拍嫌疑（V11c）
  checkCinematicGrammar(shot, warnings, label)

  // V18 台词语速（声音节奏）：镜级总量法
  checkDialogueSpeed(shot, warnings, label)

  // V19 相邻镜过近（30° 规则）：仅同场相邻比——跨场是新空间，不适用
    if (ctx.prevShot && ctx.sceneIndex != null && ctx.prevSceneIndex != null && ctx.sceneIndex === ctx.prevSceneIndex) {
    checkAdjacentSimilarity(ctx.prevShot, shot, warnings, label)
  }

  // L6 接缝（切镜收益，2026-09-18 P0）：相邻同场镜 finalFrame 重复 + 下镜无台词 = 这一刀没挣到收益
  if (ctx.prevShot && ctx.sceneIndex != null && ctx.prevSceneIndex != null && ctx.sceneIndex === ctx.prevSceneIndex) {
    checkCutGain(ctx.prevShot, shot, warnings, label, true)
  }

  // L4 视角（反应镜，2026-09-18 P0）：本镜 A 对 B 说话，下一镜 B 既不在画面也没台词 = 缺反应镜
  checkReactionShot(ctx.prevShot, shot, warnings, label, charNames)

  // L2 主体锁（光线一致性，2026-09-18 P2）：同场相邻镜光线方向/色温跳变（弱信号，人判）
  if (ctx.prevShot && ctx.sceneIndex != null && ctx.prevSceneIndex != null && ctx.sceneIndex === ctx.prevSceneIndex) {
    checkLightFlip(ctx.prevShot, shot, warnings, label, true)
  }

  // L5 运镜（2026-09-18 P2）：一镜一主运镜（静态不计）+ 主体强发力动作禁配固定镜
  checkMultiCameraMove(shot, warnings, label)
  checkActionCameraMismatch(shot, warnings, label)

  // L7 声弧（2026-09-18 P2）：相邻同场镜音乐情绪硬跳变 + 情绪低点该安静
  if (ctx.prevShot && ctx.sceneIndex != null && ctx.prevSceneIndex != null && ctx.sceneIndex === ctx.prevSceneIndex) {
    checkSoundArc(ctx.prevShot, shot, warnings, label, true)
  }
  checkSilenceGap(shot, warnings, label)

  // 第四轮美学级（2026-09-19）：因果链超载（3-3型）+ 死画面长镜（防御，结尾镜豁免）
  checkChainReactionOverload(shot, warnings, label)
  checkEmptyLongShot(shot, warnings, label, Boolean(ctx.isLastShot))

  // V20 长镜薄提示词
  checkLongShotThinPrompt(shot, warnings, label)

  // V12 画风毒词（错误级，喂回重试）：写实/CGI/photoreal 等风格切换词与全片画风统一铁律冲突
  checkStylePoison(shot, errors, label, ctx, codedErrors)

  // V7 资产设定图缺失校验：characters/sceneAssets/propAssets 里登记的资产，
  // 若在 assetNames 里没有 image_url，生图时该资产没有参考图，
  // 会被照着其他参考图画错（实测 1-3 一二漏设定图 → 被画成布布）
  if (ctx.assetNames) {
    const checkImg = (registered, list, type, label) => {
      const byName = new Map()
      for (const item of (list || [])) {
        const name = typeof item === 'string' ? item : (item?.name || item?.title || '')
        if (name) byName.set(name, item)
      }
      for (const name of (registered || [])) {
        const item = byName.get(name)
        const imgUrl = item && (typeof item === 'string' ? '' : (item.image_url || item.imageUrl || ''))
        if (item && !imgUrl) {
          warnings.push({
            code: 'ASSET_MISSING_IMAGE',
            shot: label,
            message: `镜头 ${label}：${type}「${name}」未生成设定图（image_url 为空）。生图时该资产无参考图，可能被画错。建议先在资产库为该${type}生成设定图，再重新生成分镜图。`,
          })
        }
      }
    }
    checkImg(shot.characters, ctx.assetNames.characters, '角色', label)
    checkImg(shot.sceneAssets, ctx.assetNames.scenes, '场景', label)
    checkImg(shot.propAssets, ctx.assetNames.props, '道具', label)
  }

  // V16 场景锚完整性：空锚 / 未知锚（V7 对"场景资产名不存在"静默放行，这里补上）
  checkSceneAnchor(shot, warnings, label, ctx)

  // V8 图文服装一致性：文有图无的服装配饰会让生图两头摇摆
  checkCostumeConflict(shot, warnings, label, ctx)

  // V9 台词时间戳越界：dialogue.startTime 是全片绝对秒，必须落在本镜 [startTime, endTime] 内。
  // 越界时出片（v4Video）换算镜内相对秒为负/超时，时间戳被静默丢弃，台词失去锚点。
  const dlgList = Array.isArray(shot.dialogue)
    ? shot.dialogue
    : (shot.dialogue && typeof shot.dialogue === 'object' ? [shot.dialogue] : [])
  const shotStart = Number(shot.startTime)
  const shotEnd = Number(shot.endTime)
  if (dlgList.length && Number.isFinite(shotStart) && Number.isFinite(shotEnd)) {
    for (const d of dlgList) {
      const t = Number(d?.startTime)
      if (Number.isFinite(t) && (t < shotStart || t > shotEnd)) {
        warnings.push({
          code: 'DIALOGUE_TIME_OUT_OF_RANGE',
          shot: label,
          message: `镜头 ${label}：台词「${String(d?.text || '').slice(0, 12)}」startTime=${t}s 超出本镜范围 [${shotStart}, ${shotEnd}]s，出片时该句时间戳会被丢弃。检查该句是否属于本镜，或修正 startTime。`,
        })
      }
    }
  }

  return { errors, warnings, fixed, codedErrors }
}

/**
 * 校验整集分镜。
 * @param {object} storyboard { scenes: [{ shots: [] }] }
 * @param {object} assetNames { characters, scenes, props }
 * @param {object} [opts] { projectStyleText, sceneRows } 项目画风全文（zh+en）——画风毒词白名单：
 *        项目画风本身含"写实/realistic"等词时（写实风项目）该词合法，不算毒词
 *        sceneRows：集级 scenes 表的行（至少含 scene_number）——传入才做 V17 场次编号对齐；
 *        纯 LLM QC 阶段拿不到库表，故不传则跳过（对应审计在 routes 落库前/审计脚本里做）
 * @returns {{ errors: string[], warnings: object[], fixed: string[], summary: object }}
 */
export function validateStoryboard(storyboard, assetNames, opts = {}) {
  const errors = []
  const warnings = makeWarnings()
  const fixed = []
  // 带 code 的硬错误（面板归类用，见 validateShot 的 codedErrors 说明）：errors 保持字符串数组
  // 不动（生成阶段 qcRetryNote 直接读它喂回 LLM），这里额外给面板一份可归类的副本。
  const codedErrors = []
  let prevShot = null
  let prevSceneIndex = null
  let scenes_seen = 0
  let shotCount = 0
  // 先算总镜数：供 ctx.isLastShot 判定（EMPTY_LONG_SHOT 的结尾镜豁免——结尾留白归 L3 管，不与长镜规则打架）
  const totalShots = (storyboard?.scenes || []).reduce((n, sc) => n + (sc?.shots || []).length, 0)

  // V3 时间轴连续性（全片维度）
  let expectedStart = 0
  const timelineIssues = []

  for (const scene of (storyboard?.scenes || [])) {
    const sceneIndex = scenes_seen++
    // V11b 景别平推：单场 ≥3 镜且景别全部相同 → 整场一个景别平推=动态PPT（旧场1~场4 实锤）
    const sceneTypes = (scene?.shots || [])
      .map((s) => String(s.shotType || s.shot_type || ''))
      .filter(Boolean)
    if (sceneTypes.length >= 3 && new Set(sceneTypes).size === 1) {
      warnings.push({
        code: 'SCENE_SHOTTYPE_FLAT',
        shot: `场次${scene.sceneNumber || '?'}`,
        message: `场次${scene.sceneNumber || '?'}：${sceneTypes.length} 个镜头全是${sceneTypes[0]}——整场同一景别平推是"动态PPT"的典型特征。按镜头语言规则，场内需远/中/近搭配：全景交代空间 → 中景建立关系 → 近景/特写承担情绪。`,
      })
    }
    for (const shot of (scene?.shots || [])) {
      shotCount++
      const label = shot.shotNumber || shot.shot_number || `scene${scene.sceneNumber || ''}-shot${shotCount}`

      const res = validateShot(shot, { assetNames, prevShot, shotLabel: label, projectStyleText: opts.projectStyleText, sceneIndex, prevSceneIndex, isLastShot: shotCount === totalShots })
      errors.push(...res.errors)
      warnings.push(...res.warnings)
      fixed.push(...res.fixed)
      codedErrors.push(...(res.codedErrors || []))

      // 第五轮纪律检查（逐镜）：切点动作重复（比对上镜末帧）+ 动作密度 vs 时长
      checkCutActionOverlap(prevShot, shot, warnings, label)
      checkActionDensity(shot, warnings, label)

      // 时间轴校验
      const st = Number(shot.startTime)
      const et = Number(shot.endTime)
      if (!isNaN(st) && st !== expectedStart) {
        timelineIssues.push(`镜头 ${label}：startTime=${st}，期望 ${expectedStart}`)
      }
      if (!isNaN(et) && !isNaN(st) && et - st !== Number(shot.duration)) {
        timelineIssues.push(`镜头 ${label}：endTime-startTime=${et - st} ≠ duration=${shot.duration}`)
      }
      if (!isNaN(et)) expectedStart = et

      prevShot = shot
      // 「上一镜所属场」必须在镜循环内更新（不是场循环末尾）：同场相邻比较
      // 读的是它——放场末尾会让同场第二镜读到 null，相邻检查整场空转（实测踩坑）。
      prevSceneIndex = sceneIndex
    }
  }

  for (const issue of timelineIssues) {
    warnings.push({ code: 'TIMELINE_DISCONTINUITY', shot: '*', message: issue })
  }

  // V14/V15 集级检查（2026-09-12 F5/F6 根焊）：台词地板 + 同类梗上限。与逐镜检查同口径，弱信号告警由人判。
  const flatShots = []
  for (const scene of (storyboard?.scenes || [])) {
    for (const shot of (scene?.shots || [])) {
      flatShots.push({
        label: shot.shotNumber || shot.shot_number || `shot${flatShots.length + 1}`,
        description: String(shot.description || ''),
        hasDialogue: hasDialogueContent(shot.dialogue),
        duration: Number(shot.duration) || 0,
        music: String(shot.nonDiegeticMusic ?? shot.non_diegetic_music ?? ''),
        // 第五轮属性分布统计用（机位朝向/景别/运镜）——此前只做逐镜检查，没有集级占比视角
        shotType: String(shot.shotType || shot.shot_type || ''),
        cameraAngle: String(shot.cameraAngle || shot.camera_angle || ''),
        cameraMovement: String(shot.cameraMovement || shot.camera_movement || ''),
      })
    }
  }
  checkDialogueFloor(flatShots, warnings)
  checkGagRepeat(flatShots, warnings)
  // L3 节奏（结尾留白，2026-09-18 P2）：结尾镜时长 < 全片平均×阈值 = 余韵不足
  checkEndingRushed(flatShots, warnings)
  // 第四轮集级（2026-09-19）：音乐文本语言漂移 + 开场钩子慢
  checkMusicLanguageConsistency(flatShots, warnings)
  checkOpeningHook(flatShots, warnings)
  // 第五轮集级（2026-09-19）：机位/景别/运镜分布单调（导演评审"机器完全没看到"的那类）
  checkShotAttributeMonotone(flatShots, warnings)

  // V17 场次编号对齐（调用方传入集级场景表行时才跑；不传则跳过）
  if (Array.isArray(opts.sceneRows)) {
    const boardNumbers = (storyboard?.scenes || []).map((s, i) => Number(s?.sceneNumber) || i + 1)
    for (const p of checkSceneIndexAlignment(boardNumbers, opts.sceneRows)) {
      warnings.push({ code: 'SCENE_INDEX_MISMATCH', shot: '*', message: p })
    }
  }

  // 汇总日志
  const summary = {
    shotCount,
    errorCount: errors.length,
    warningCount: warnings.length,
    fixedCount: fixed.length,
  }
  if (errors.length > 0 || warnings.length > 0 || fixed.length > 0) {
    console.warn(
      `[storyboardValidator] 校验完成：${shotCount} 镜头，` +
      `${errors.length} 错误，${warnings.length} 警告，${fixed.length} 已修复。` +
      (errors.length ? ` 错误：${errors.join('; ')}` : '') +
      (warnings.length ? ` 警告：${warnings.map((w) => `[${w.code}]${w.message}`).join('; ')}` : '')
    )
  }

  return { errors, warnings, fixed, codedErrors, summary }
}

// ===== 数据库行 → 校验视角的转换（2026-09-16，质检面板用）=====
// 面板要在**已落库的分镜**上跑质检，而落库行是 snake_case + JSON 字符串，
// 校验器认的是 camelCase + 数组。这层转换收口在此，避免面板路由自己拼（拼错了
// 校验器会静默少检——例如 characters 传了 JSON 字符串，V6 的 backfill 就全失效）。
//
// ⚠️ 只转校验器真正读的字段。任何校验器新增的字段依赖都必须在这里补上，
// 否则该检查在面板里会静默空转（这正是 final_frame 全空导致越轴检查空转的同类坑）。
/**
 * @param {object} row shots 表原始行
 * @returns {object} 校验器可消费的镜头对象
 */
export function rowToShotForQc(row = {}) {
  const parse = (v, fallback) => {
    if (Array.isArray(v)) return v
    try {
      const p = JSON.parse(v || '[]')
      return Array.isArray(p) ? p : fallback
    } catch { return fallback }
  }
  const parseObj = (v) => {
    if (v && typeof v === 'object') return v
    try { return v ? JSON.parse(v) : null } catch { return null }
  }
  return {
    id: row.id,
    shotNumber: row.shot_number || '',
    shotType: row.shot_type || '',
    cameraAngle: row.camera_angle || '',
    cameraMovement: row.camera_movement || '',
    duration: row.duration,
    description: row.description || '',
    characters: parse(row.characters, []),
    sceneAssets: parse(row.scene_assets, []),
    propAssets: parse(row.prop_assets, []),
    startTime: row.start_time,
    endTime: row.end_time,
    actionNote: row.action_note || '',
    dialogue: parseObj(row.dialogue),
    integratedMultimodalDescription: row.integrated_multimodal_description || '',
    finalFrame: row.final_frame || '',
    nonDiegeticMusic: row.non_diegetic_music || '',
    blockingPlan: parseObj(row.blocking_plan),
    videoPromptOverride: row.video_prompt_override || '',
    isCombat: row.is_combat,
  }
}
