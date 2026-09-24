
import { backfillShotAssets } from './assetBackfill.js'
import { config } from '../config.js'
import { qcMeta } from './qcCodes.js'
import { escapeRegExp } from './shared.js'
import { classifyShotCombat } from './shotClassifier.js'

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

const DURATION_MIN = config.storyboard?.durationMin ?? 4
const DURATION_MAX = config.storyboard?.durationMax ?? 15

export const SPEECH_RATE_MAX = config.storyboard?.speechRateMaxCharsPerSec ?? 5
export const SPEECH_RATE_MIN_CHARS = config.storyboard?.speechRateMinChars ?? 3
const LONG_SHOT_MIN_SEC = config.storyboard?.longShotMinSec ?? 8
const THIN_PROMPT_CHARS = config.storyboard?.thinPromptChars ?? 80

const MULTI_BEAT_ACTION_THRESHOLD = config.storyboard?.multiBeatActionThreshold ?? 4
const MULTI_BEAT_ACTION_WITH_CONNECTOR = config.storyboard?.multiBeatActionWithConnector ?? 3
const MULTI_BEAT_CONNECTOR_THRESHOLD = config.storyboard?.multiBeatConnectorThreshold ?? 3
const CUT_GAIN_JACCARD_THRESHOLD = config.storyboard?.cutGainJaccardThreshold ?? 0.4
const CUT_GAIN_STRUCTURAL_CHECK = config.storyboard?.cutGainStructuralCheck !== false
const REACTION_SHOT_ENABLED = config.storyboard?.reactionShotEnabled !== false
const ENDING_RUSHED_RATIO = config.storyboard?.endingRushedRatio ?? 1.3
const LIGHT_FLIP_ENABLED = config.storyboard?.lightFlipEnabled !== false
const CAMERA_MOVE_CHECK_ENABLED = config.storyboard?.cameraMoveCheckEnabled !== false
const SOUND_ARC_ENABLED = config.storyboard?.soundArcEnabled !== false
const SILENCE_GAP_ENABLED = config.storyboard?.silenceGapEnabled !== false

const COSTUME_WORDS = ['围巾', '帽子', '背包', '书包', '披风', '斗篷', '眼镜', '项链', '手环', '手套', '耳环', '发卡', '蝴蝶结', '外套', '大衣', '雨衣', '口罩', '皇冠', '发带', '腰带', '披肩']

function checkCostumeConflict(shot, warnings, label, ctx) {
  const texts = [shot.description, shot.integratedMultimodalDescription || shot.integrated_multimodal_description]
    .filter(Boolean).join(' ')
  if (!texts) return
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

export function extractMentions(text) {
  if (!text) return []
  const matches = text.match(/@[\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9_]*/g) || []
  return [...new Set(matches.map((m) => m.slice(1)))]
}

function checkAirlockInheritance(prevShot, currShot, warnings, shotLabel, charNames) {
  if (!prevShot || !charNames) return
  const currPrompt = currShot.integratedMultimodalDescription || currShot.integrated_multimodal_description || ''
  if (!currPrompt) return

  const charSet = new Set(charNames)
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

const SIDE_PATTERNS = [
  [/\bat frame left\b/i, 'left'],
  [/\bat frame right\b/i, 'right'],
  [/\bat center frame\b|\bat the center of the frame\b|\bcenter frame\b/i, 'center'],
  [/\bframe[- ]left\b|\bleft side of the frame\b|\bscreen left\b/i, 'left'],
  [/\bframe[- ]right\b|\bright side of the frame\b|\bscreen right\b/i, 'right'],
]

export function hasExplicitReposition(text, side) {
  if (!text || !side) return false
  return new RegExp(
    `(walks?|runs?|moves?|crosses?|steps?|circles?|drifts?|shifts?|sidesteps?|repositions?)[^@\\.]{0,60}frame ${side}`,
    'i'
  ).test(text)
}

function buildNameForms(name, extraAliases = []) {
  const forms = new Set()
  const push = (s) => {
    const v = String(s || '').trim()
    if (v) forms.add(v)
  }
  push(name)
  for (const part of String(name || '').split('/')) push(part)
  for (const a of extraAliases) {
    for (const part of String(a || '').split(',')) push(part)
  }
  return [...forms].filter(Boolean).sort((a, b) => b.length - a.length) 
}

export function extractScreenSides(text, charNames, aliasMap = null) {
  const sides = new Map()
  if (!text || !charNames) return sides
  for (const name of charNames) {
    const aliases = aliasMap?.get?.(name) || []
    const forms = buildNameForms(name, aliases)
    let matched = false
    for (const form of forms) {
      if (matched) break
      const re = new RegExp(`@?${escapeRegExp(form)}(?![\\w\\u4e00-\\u9fa5])`, 'gi')
      let m
      while ((m = re.exec(text))) {
        const start = m.index
        const window = text.slice(start, start + form.length + 120)
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

  const currSides = extractScreenSides(currFinalFrame, charNames, aliasCtx)
  for (const [name, prevSide] of prevSides) {
    const cSide = currSides.get(name)
    if (cSide && prevSide !== 'center' && cSide !== 'center' && cSide !== prevSide) {
      const movedInShot = hasExplicitReposition(currPrompt, cSide)
      if (!movedInShot) {
        warnings.push({
          code: 'SCREEN_SIDE_FLIP',
          shot: shotLabel,
          message: `镜头 ${shotLabel}：@${name} 画面侧位从上一镜 frame ${prevSide} 翻转到 frame ${cSide}，但本镜没有显式走位。若是合法越轴请在模块4 与 action_note 双落点补走位（模块4 供越轴机检识别、action_note 供出片模型执行）；否则角色会凭空换边（180 度轴线被破坏）。`,
        })
      }
    }
  }
}

const EMOTION_TONE_WORDS = ['鼓气', '逞强', '怒', '怒吼', '哭', '喊', '大喊', '惊', '兴奋', '哽咽', '坚定', '焦急', '害怕']
const WIDE_SHOT_TYPES = ['全景', '远景', '大远景']
const BEAT_CONNECTORS = ['突然', '紧接着', '随后', '然后', '与此同时', '接着', '随即', '于是', '便', '刚', '就']
const ACTION_BODY = [
  '扑', '抓', '推', '拉', '撞', '甩', '跳', '摔', '跑', '走', '坐', '站', '转', '缩', '抖',
  '躲', '举', '放', '抱', '拍', '打', '踢', '咬', '爬', '滚', '跌', '滑', '退', '拽', '凑',
  '蹭', '跃', '冲', '踩', '钻', '攀', '压低', '挺起', '竖起', '凑近', '起身', '迈步', '挪',
  '落下', '张开', '攥', '揪', '抠', '抵', '扳', '刨', '砸',
]

const MOVE_VERBS = /\b(jump\w*|leap\w*|climb\w*|slide\w*|slid|dismount\w*|drop\w*|descend\w*|fall\w*|fell|hop\w*|scramble\w*|run\w*|walk\w*|move\w*|dash\w*)\b/i

// 位置载体通用提取：从角色名后 200 字符窗口抓英文介词短语（on/at/in/atop/under/behind + 名词），
// 不依赖预定义项目词典——任何剧本的位置载体（bear's back / table / car / doorway）统一处理。
const POSITION_PREP_RE = /\b(?:on|onto|upon|atop|in|inside|at|under|beneath|behind)\s+(?:the\s+|a\s+|an\s+|his\s+|her\s+|its\s+|their\s+)?([a-z][a-z'-]*(?:\s+[a-z][a-z'-]*)?)/i
// "at the top/bottom of the X" 这类方位词后面跟 of the 的，取真正的载体 X
const POSITION_OF_RE = /\b(?:top|middle|bottom|edge|end|foot|base|peak|summit|heart)\s+of\s+the\s+([a-z][a-z'-]*(?:\s+[a-z][a-z'-]*)?)/i

function extractLocations(text, charNames) {
  const locs = new Map()
  if (!text || !charNames) return locs
  for (const name of charNames) {
    const re = new RegExp('@' + escapeRegExp(name), 'g')
    let m
    while ((m = re.exec(text))) {
      const window = text.slice(m.index, m.index + name.length + 200)
      const prep = POSITION_PREP_RE.exec(window)
      if (prep) {
        let tag = prep[1]
        const of = POSITION_OF_RE.exec(window.slice(prep.index))
        if (of) tag = of[1]
        locs.set(name, tag)
        break
      }
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


export function countSpokenChars(text) {
  return String(text || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').length
}

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

function checkLongShotThinPrompt(shot, warnings, label) {
  const dur = Number(shot.duration)
  if (!Number.isFinite(dur) || dur < LONG_SHOT_MIN_SEC) return
  // 出片时间轴来源是 action_note（出片提示词不读 IMD 模块4）：
  // 长镜无 action_note = 出片完全没有过程动作可演，画面必死气，必告警。
  // 与下方 IMD 维度互补，覆盖"IMD 够长但 action_note 空"的漏报。
  const note = String(shot.actionNote || shot.action_note || '').replace(/\s/g, '')
  if (!note) {
    warnings.push({
      code: 'LONG_SHOT_THIN_PROMPT',
      shot: label,
      message: `镜头 ${label}：${dur}s 长镜但 action_note（出片时间轴）为空——出片模型完全没有过程动作可演，画面必死气。请按拍点补全「At X.Xs，动作」时间轴。`,
    })
    return
  }
  const prompt = String(shot.integratedMultimodalDescription || shot.integrated_multimodal_description || '')
  const chars = prompt.replace(/\s/g, '').length
  if (chars >= THIN_PROMPT_CHARS) return
  warnings.push({
    code: 'LONG_SHOT_THIN_PROMPT',
    shot: label,
    message: `镜头 ${label}：${dur}s 长镜但提示词只有 ${chars} 字（< ${THIN_PROMPT_CHARS}）——长镜需要过程性描述撑住时长，提示词太薄出片要么画面死气、要么模型自由发挥跑偏。请补全本镜的动作过程与画面变化描述。`,
  })
}

function hasDialogueContent(d) {
  if (d == null) return false
  let arr = d
  if (typeof d === 'string') {
    const s = d.trim()
    if (!s || s === 'null') return false
    try { arr = JSON.parse(s) } catch { return s.length > 2 } 
  }
  if (Array.isArray(arr)) return arr.some((x) => x && String(x.text || '').trim())
  if (typeof arr === 'object') return !!String(arr.text || '').trim()
  return false
}

function checkDialogueFloor(flatShots, warnings) {
  const total = flatShots.length
  if (total < 8) return 
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
      message: `全片 ${total} 镜只有 ${dlgCount} 镜有台词（占比 ${Math.round((dlgCount / total) * 100)}% < 25%）——纯动作哑段落撑不起情感线（历史实锤：2 分半仅 3 句台词）。请在关键情绪节点补对白/心声/呼喊。`,
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

// 重复桥段通用检测：不依赖预定义梗家族词表，直接统计全片描述中 3~4 字纯中文短语
// 在 ≥3 个不同镜头重复出现的情况（题材无关）。停用虚字过滤掉语法碎片；4 字短语优先，
// 3 字短语若是已入选 4 字短语的子串则不再单报。
const GAG_NGRAM_STOPCHARS = /[的了着呢吧吗啊呀哦嗯把被和与或而就很也又都不没在是有过地得之其此该每某各]/

function collectRepeatGrams(flatShots, len, banned) {
  const map = new Map()
  for (const s of flatShots) {
    const text = String(s.description || '')
    if (text.length < len) continue
    const seen = new Set()
    for (let i = 0; i + len <= text.length; i++) {
      const gram = text.slice(i, i + len)
      if (!/^[\u4e00-\u9fa5]+$/.test(gram)) continue
      if (GAG_NGRAM_STOPCHARS.test(gram)) continue
      if (banned && banned.size && [...banned].some((b) => b.includes(gram))) continue
      if (seen.has(gram)) continue
      seen.add(gram)
      if (!map.has(gram)) map.set(gram, new Set())
      map.get(gram).add(s.label)
    }
  }
  return map
}

function checkGagRepeat(flatShots, warnings) {
  const four = collectRepeatGrams(flatShots, 4)
  const hits4 = new Set([...four.entries()].filter(([, shots]) => shots.size >= 3).map(([g]) => g))
  const three = collectRepeatGrams(flatShots, 3, hits4)
  const merged = [
    ...[...four.entries()].filter(([, shots]) => shots.size >= 3),
    ...[...three.entries()].filter(([, shots]) => shots.size >= 3),
  ]
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 3)
  for (const [phrase, shots] of merged) {
    warnings.push({
      code: 'GAG_REPEAT',
      shot: '*',
      message: `短语「${phrase}」在全片 ${shots.size} 个镜头重复出现（${[...shots].join('、')}）——同一桥段第 3 次观众只会疲劳。请确认是否过度重复，换花样、升级或反转。`,
    })
  }
}

// ⚠️ 画风毒词唯一权威源：storyboardRules.styleLockRule 从这里引用，禁止各写一份。
export const STYLE_POISON_ZH = ['写实CGI', '写实CG', '写实', 'CG定格', 'CG感', '真实感', '照片级', '电影质感', '3D', '三维', '立体渲染', '实拍']
export const STYLE_POISON_EN = ['realistic', 'CGI', 'photoreal', 'photorealistic', 'hyperreal', 'hyper-realistic', 'live-action', '3D render', 'CG render']

// 按画风类别豁免的毒词桶（键对应 style_presets.category_key）。
// 语义：项目本身属于该类别时，这些词是在描述「项目自己的画风」，不构成切换画风。
// 反例仍生效：realistic 项目写「写实CGI／3D／CG感」= 切到别的画风，照样拦。
export const STYLE_EXEMPT_BY_CATEGORY = {
  realistic: ['写实', '实拍', '真实感', '照片级', '电影质感', 'realistic', 'photoreal', 'photorealistic', 'hyperreal', 'hyper-realistic', 'live-action'],
  '3d-special': ['3D', '三维', '立体渲染', 'CG感', 'CG定格', 'CGI', '3D render', 'CG render'],
  '2d': [],
  custom: [],
}

// 豁免词集合 = 画风名命中 ∪ 类别桶命中 ∪ 附加文本（prompt/prompt_en）命中。
// 用集合精确匹配（非 includes），「写实CGI」不会因为豁免「CGI」而被连带放过。
export function styleExemptWords(projectStyleText = '', styleCategory = '', extraText = '') {
  const text = [String(projectStyleText || ''), String(extraText || '')].join('\n')
  const bucket = STYLE_EXEMPT_BY_CATEGORY[String(styleCategory || '').trim()] || []
  const zh = new Set()
  const en = new Set()
  for (const w of STYLE_POISON_ZH) {
    if (text.includes(w) || bucket.includes(w)) zh.add(w)
  }
  for (const w of STYLE_POISON_EN) {
    const re = new RegExp(`\\b${w.replace(/[-]/g, '[- ]')}\\b`, 'i')
    if (re.test(text) || bucket.includes(w)) en.add(w)
  }
  return { zh, en }
}

// 豁免文本：画风名 + 类别桶词。供「只能传字符串」的旧调用点使用（如 doubao.js 的 projectStyleText），
// 不改 findStylePoison 的匹配算法——把桶词并进文本即可生效。
export function stylePoisonText(label = '', styleCategory = '') {
  const bucket = STYLE_EXEMPT_BY_CATEGORY[String(styleCategory || '').trim()] || []
  return [String(label || '').trim(), ...bucket].filter(Boolean).join('\n')
}

const POISON_NEGATION_ZH_RE = /(?:无|非|不|勿|避免|不要|不能|不得|不含|绝非|毫不|并不|从未|禁止)\s*$/
const POISON_NEGATION_EN_RE = /(?:no|not|never|without|avoid|non)(?:[\s-]+[\w-]+){0,1}[\s-]*$/i
function isPoisonNegatedAt(s, idx) {
  const before = s.slice(Math.max(0, idx - 16), idx)
  return POISON_NEGATION_ZH_RE.test(before) || POISON_NEGATION_EN_RE.test(before)
}

export function findStylePoison(texts, projectStyleText = '', styleCategory = '', extraText = '') {
  const exempt = styleExemptWords(projectStyleText, styleCategory, extraText)
  const hits = []
  for (const t of texts) {
    const s = String(t || '')
    if (!s) continue
    for (const w of STYLE_POISON_ZH) {
      if (exempt.zh.has(w)) continue
      let i = s.indexOf(w)
      let flagged = false
      while (i !== -1) {
        if (!isPoisonNegatedAt(s, i)) { flagged = true; break }
        i = s.indexOf(w, i + w.length)
      }
      if (flagged) hits.push(w)
    }
    for (const w of STYLE_POISON_EN) {
      if (exempt.en.has(w)) continue
      const re = new RegExp(`\\b${w.replace(/[-]/g, '[- ]')}\\b`, 'gi')
      let m
      let flagged = false
      while ((m = re.exec(s)) !== null) {
        if (!isPoisonNegatedAt(s, m.index)) { flagged = true; break }
      }
      if (flagged) hits.push(w)
    }
  }
  return [...new Set(hits)]
}

// 风格毒词扫描字段集（检出 check 与 QC 修复 handler 共用，单一源）。
// blockingPlan 在 QC 路径已被解析成对象——String(对象) 恒为 "[object Object]"，毒词永远匹配不上，
// 对象必须先 JSON.stringify 再扫；videoPromptOverride 会直接顶替出片提示词开头，漏扫等于没修。
export function stylePoisonScanTexts(shot = {}) {
  const bp = shot.blockingPlan || shot.blocking_plan
  return [
    shot.description,
    shot.integratedMultimodalDescription || shot.integrated_multimodal_description,
    shot.finalFrame || shot.final_frame,
    shot.actionNote || shot.action_note,
    bp && typeof bp === 'object' ? JSON.stringify(bp) : bp,
    shot.videoPromptOverride || shot.video_prompt_override,
  ].filter(Boolean)
}

function checkStylePoison(shot, errors, label, ctx, codedErrors) {
  const hits = findStylePoison(stylePoisonScanTexts(shot), ctx?.projectStyleText || '', ctx?.projectStyleCategory || '')
  if (hits.length) {
    const message = `镜头 ${label}：文本含风格切换毒词「${hits.join('、')}」——全片画风统一是铁律，"变强/异变/变身"只能用画面内容表达（体型/毛发/红眼/蒸汽/特效），不能切换画风。请删除这些词并把演出意图改写成画面语言。`
    errors.push(message)
    if (Array.isArray(codedErrors)) codedErrors.push({ code: 'STYLE_POISON', shot: label, message })
  }
}

function stripDialogue(text) {
  return String(text || '').replace(/[""].*?[""]/g, '')
}

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

function countActionBody(text) {
  return ACTION_BODY.reduce((n, w) => n + (String(text).split(w).length - 1), 0)
}

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

const CUT_GAIN_STRUCTURAL_CUES = [
  '突然', '忽然', '发现', '看见', '出现', '显现', '靠近', '移动', '逼近', '火光', '水汽', '雾', '裂', '碎', '下沉', '滑出', '冲来', '退回', '跌', '摔', '失去', '挡在', '转身', '跳起', '落地', '抓住', '救', '停住', '骤停',
  'suddenly', 'reveals', 'reveal', 'appears', 'emerges', 'approaches', 'moves toward', 'moving', 'firelight', 'steam', 'fog', 'cracks', 'splinters', 'sinks', 'slides', 'surges', 'retreats', 'falls', 'turns', 'jumps', 'lands', 'grabs', 'blocks',
]
function hasStructuralCutGain(prevShot, currShot) {
  if (!CUT_GAIN_STRUCTURAL_CHECK) return false
  const prevText = String(prevShot.description || '') + ' ' + String(prevShot.finalFrame || prevShot.final_frame || '')
  const currText = String(currShot.description || '') + ' ' + String(currShot.finalFrame || currShot.final_frame || '')
  const curr = currText.toLowerCase()
  const prev = prevText.toLowerCase()
  return CUT_GAIN_STRUCTURAL_CUES.some((cue) => curr.includes(cue.toLowerCase()) && !prev.includes(cue.toLowerCase()))
}
// 无收益切镜判定（纯函数，供 checkCutGain 告警与 shotMergeEngine 合并决策共用）。
// 返回 { gainless, sim }：gainless=true 表示这一刀没有可检测的叙事收益（画面高度相似、
// 后镜无台词、无结构变化词）——既该告警，也是镜头合并引擎的合并依据。
export function isCutWithoutGain(prevShot, currShot) {
  const prevFf = prevShot.finalFrame || prevShot.final_frame || ''
  const currFf = currShot.finalFrame || currShot.final_frame || ''
  if (!prevFf || !currFf) return { gainless: false, sim: 0 }
  const sim = jaccardSet(tokenizeFrame(prevFf), tokenizeFrame(currFf))
  if (sim <= CUT_GAIN_JACCARD_THRESHOLD) return { gainless: false, sim }

  const dlg = Array.isArray(currShot.dialogue)
    ? currShot.dialogue
    : (currShot.dialogue && typeof currShot.dialogue === 'object' ? [currShot.dialogue] : [])
  const hasDialogue = dlg.some((d) => d && String(d?.text || '').trim())
  if (hasDialogue || hasStructuralCutGain(prevShot, currShot)) return { gainless: false, sim }
  return { gainless: true, sim }
}

function checkCutGain(prevShot, currShot, warnings, shotLabel, sameScene) {
  if (!prevShot || !sameScene) return
  const { gainless, sim } = isCutWithoutGain(prevShot, currShot)
  if (!gainless) return

  warnings.push({
    code: 'CUT_WITHOUT_GAIN',
    shot: shotLabel,
    message: `镜头 ${shotLabel}：与上一镜 finalFrame 相似度 ${sim.toFixed(2)} 且本镜无台词、未检测到主体/空间/状态/信息变化——这一刀可能没挣到叙事收益，建议合并走一镜流。若有意保留（反应停顿、节奏断点或隐性信息）可忽略此告警。`,
  })
}

// 在场检测：从 finalFrame+description+台词对象+characters 字段聚合"本镜实际在场"的角色集合。
// 抽成 helper 供 checkReactionShot 在本镜/下一镜两处复用，避免在场逻辑重复定义。
function presentCharsOf(shot, knownChars, charNames) {
  const ff = shot.finalFrame || shot.final_frame || ''
  const desc = shot.description || ''
  const mentions = new Set([...extractMentions(ff + ' ' + desc)].filter((c) => knownChars.has(c)))
  const dlg = Array.isArray(shot.dialogue)
    ? shot.dialogue
    : (shot.dialogue && typeof shot.dialogue === 'object' ? [shot.dialogue] : [])
  const speakers = new Set(dlg.filter((d) => d && d.character).map((d) => d.character))
  const textMentions = new Set()
  for (const d of dlg) {
    if (d && d.text) for (const name of charNames) if (name && String(d.text).includes(name)) textMentions.add(name)
  }
  let charsField = new Set()
  try {
    const cc = typeof shot.characters === 'string' ? JSON.parse(shot.characters) : shot.characters
    if (Array.isArray(cc)) charsField = new Set(cc.map(String).filter((c) => knownChars.has(c)))
  } catch {}
  return new Set([...mentions, ...speakers, ...textMentions, ...charsField])
}

function checkReactionShot(prevShot, currShot, nextShot, warnings, shotLabel, charNames) {
  if (!prevShot || !REACTION_SHOT_ENABLED) return
  const dlg = Array.isArray(prevShot.dialogue)
    ? prevShot.dialogue
    : (prevShot.dialogue && typeof prevShot.dialogue === 'object' ? [prevShot.dialogue] : [])
  if (!dlg.length) return
  const speakers = new Set(dlg.filter((d) => d && d.text && d.character).map((d) => d.character))
  if (!speakers.size || !charNames?.length) return

  const prevFf = prevShot.finalFrame || prevShot.final_frame || ''
  const knownChars = new Set(charNames)
  const prevChars = new Set(extractMentions(prevFf).filter((c) => knownChars.has(c)))
  const textChars = new Set()
  for (const d of dlg) {
    if (d && d.text) for (const name of charNames) if (name && String(d.text).includes(name)) textChars.add(name)
  }
  const targets = new Set([...prevChars, ...textChars].filter((c) => !speakers.has(c)))
  if (!targets.size) return

  const currPresent = presentCharsOf(currShot, knownChars, charNames)
  const missing = [...targets].filter((t) => !currPresent.has(t))
  if (!missing.length) return

  // 反应镜铁律允许"≤2 镜内闭合"：本镜缺反应时，先看下一镜是否补了该 target 的反应
  // （画面/台词出现）。补了则不告警（2 镜窗口闭合）；无下一镜或下一镜仍未补才告警。
  // 注意：两类合法例外（有意不对位 / 双向寻找·失联结构）需客观文本特征才能识别，
  // 暂不机检（避免凭空编造识别规则），留给人工按 hint 判断。
  if (nextShot) {
    const nextPresent = presentCharsOf(nextShot, knownChars, charNames)
    const stillMissing = missing.filter((t) => !nextPresent.has(t))
    if (!stillMissing.length) return
  }

  warnings.push({
    code: 'REACTION_SHOT_MISSING',
    shot: shotLabel,
    message: `镜头 ${shotLabel}：上一镜 ${prevShot.shotNumber || prevShot.shot_number || ''} 里 ${[...speakers].join('、')} 对 ${missing.join('、')} 说话，但本镜与下一镜 ${missing.join('、')} 都不在画面也没台词——看与被看不对位，缺反应镜（2 镜内未闭合）。请补 ${missing.join('、')} 的反应（听见/回应/动作），或调整对话对象的在场性。`,
  })
}


const LIGHT_DIRECTION_PATTERNS = {
  left: [/from frame left/i, /from the left/i, /light from (?:the )?left/i],
  right: [/from frame right/i, /from the right/i, /light from (?:the )?right/i],
}
const LIGHT_WARM_WORDS = ['warm', 'golden', 'amber', 'sunset', 'honey', 'orange', 'fiery']
const LIGHT_COOL_WORDS = ['cool', 'cold', 'icy', 'blue', 'grey', 'gray', 'silver', 'pale', 'frost']

export const CAMERA_MOVE_LEXICON = {
  static: ['static', 'locked', 'fixed', 'holds', 'held'],
  push_in: ['push in', 'push-in', 'zoom in', 'zoom-in', 'dolly in', 'push forward'],
  pull_back: ['pull back', 'pull-back', 'pull out', 'pull-out', 'zoom out', 'dolly out'],
  pan: ['pan left', 'pan right', 'pans', 'panning', 'gentle pan'],
  tilt: ['tilt up', 'tilt down', 'camera tilts', 'tilt shot'],
  tracking: ['tracking shot', 'tracking', 'follow shot', 'follows'],
  orbit: ['orbit', 'orbiting', 'circles', 'circle around', 'arcs around'],
  crane: ['crane up', 'crane down', 'crane shot', 'jib'],
}

const ACTION_POWER = ['扑', '猛扑', '飞扑', '扑倒', '扑咬', '跃起', '纵身跃', '撞飞', '掀翻', '踢飞', '打斗', '狂奔', '猛冲', '猛撞']

const MUSIC_CALM_WORDS = ['轻柔', '慢板', '舒缓', '安静', '宁静', '柔和', '温柔', '温暖', '悠远', '木吉他', '钢琴', 'arpeggio', 'gentle', 'calm', 'soft', 'slow', 'peaceful', 'warm', 'tender', 'serene']
const MUSIC_INTENSE_WORDS = ['紧张', '急促', '激烈', '激昂', '压迫', '危机', '冲突', '鼓点', '快节奏', '悬疑', '不安', 'intense', 'tense', 'urgent', 'dramatic', 'drum', 'anxious', 'suspense', 'aggressive']
const PLOT_TURN_WORDS = ['突然', '忽然', '惊', '发现', '出现', '危险', '危机', '遇到', '遭遇', '撞上', '看见', '转折', '决定', '坚定', '明白', '意识到', '惊喜', '突破', '完成', '到达']
const MUSIC_TRANSITION_WORDS = ['渐', '骤', '转折', '柔和下来', '沉下来', '静下来', '柔下来', '缓下来', '弱下来', '淡入', '淡出', '停']
const SILENCE_CUE_WORDS = ['静静', '沉默', '怔住', '呆住', '无言', '屏住', '愣住', '僵住', '静默', '鸦雀无声', '一动不动', '目不转睛', '屏息', '窒息般']

function shotMusicText(shot) {
  return String(shot?.nonDiegeticMusic ?? shot?.non_diegetic_music ?? '')
}
function shotImdFirstLine(shot) {
  const imd = String(shot?.integratedMultimodalDescription ?? shot?.integrated_multimodal_description ?? '')
  return imd.split('\n')[0] || ''
}

export function extractLightCues(text) {
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

function musicEmotion(musicText) {
  const m = String(musicText || '').toLowerCase()
  if (!m.trim()) return 'none'
  const calm = MUSIC_CALM_WORDS.reduce((n, w) => n + (m.includes(w.toLowerCase()) ? 1 : 0), 0)
  const intense = MUSIC_INTENSE_WORDS.reduce((n, w) => n + (m.includes(w.toLowerCase()) ? 1 : 0), 0)
  if (calm > intense) return 'calm'
  if (intense > calm) return 'intense'
  return 'none'
}

function checkSoundArc(prevShot, currShot, warnings, shotLabel, sameScene) {
  if (!prevShot || !sameScene || !SOUND_ARC_ENABLED) return
  const prevMusic = shotMusicText(prevShot)
  const currMusic = shotMusicText(currShot)
  const prevEmotion = musicEmotion(prevMusic)
  const currEmotion = musicEmotion(currMusic)
  if (prevEmotion === 'none' || currEmotion === 'none' || prevEmotion === currEmotion) return
  const desc = String(currShot.description || '')
  if (PLOT_TURN_WORDS.some((w) => desc.includes(w))) return
  if (MUSIC_TRANSITION_WORDS.some((w) => prevMusic.includes(w) || currMusic.includes(w))) return
  warnings.push({
    code: 'SOUND_ARC_BREAK',
    shot: shotLabel,
    message: `镜头 ${shotLabel}：音乐情绪从 ${prevEmotion} 突跳 ${currEmotion}，且本镜无剧情转折、音乐文本也无渐变意图——声弧突兀断裂，音乐转折该跟剧情走（加过渡，或在 music 里写明渐变）。`,
  })
}

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


const CHAIN_CAUSE_WORDS = ['导致', '致使', '使得', '拽走', '拖走', '带飞', '撞翻', '掀翻', '压垮', '压塌', '撞飞', '踢飞', '卷走', '冲垮', '震落', '砸断', '压断']
const CHAIN_REACTION_CHECK_ENABLED = config.storyboard?.chainReactionCheckEnabled !== false

const OPENING_HOOK_WORDS = ['断', '裂', '追', '逃', '躺', '倒', '喊', '惊', '危险', '危机', '异常', '忽然', '突然', '发现', '撞', '坠', '滚落', '着火', '血', '尸体', '陌生人', '哭声', '求救']
const OPENING_HOOK_CHECK_ENABLED = config.storyboard?.openingHookCheckEnabled !== false

function checkChainReactionOverload(shot, warnings, shotLabel) {
  if (!CHAIN_REACTION_CHECK_ENABLED) return
  const desc = String(shot.description || '')
  if (!desc) return
  const causeHits = CHAIN_CAUSE_WORDS.filter((w) => desc.includes(w))
  if (causeHits.length < 1) return
  const mentions = new Set(extractMentions(desc))
  const bodyCount = countActionBody(stripDialogue(desc))
  if (mentions.size >= 3 && bodyCount >= 4) {
    warnings.push({
      code: 'CHAIN_REACTION_OVERLOAD',
      shot: shotLabel,
      message: `镜头 ${shotLabel}：${mentions.size} 个主体 + 因果词「${causeHits.join('、')}」+ ${bodyCount} 个动作——多主体连锁反应塞一镜，出片模型只能演开头。按因果转折点拆镜：前一镜停在「因」（失衡/起跳），后一镜从「果」（被拖走/翻倒）开始。`,
    })
  }
}

const EMPTY_LONG_SHOT_MIN_SEC = config.storyboard?.emptyLongShotMinSec ?? 8
const EMPTY_LONG_SHOT_ENABLED = config.storyboard?.emptyLongShotEnabled !== false
function checkEmptyLongShot(shot, warnings, shotLabel, isLastShot = false) {
  if (!EMPTY_LONG_SHOT_ENABLED) return
  if (isLastShot) return 
  const dur = Number(shot.duration) || 0
  if (dur < EMPTY_LONG_SHOT_MIN_SEC) return
  if (hasDialogueContent(shot.dialogue)) return
  const cam = String(shot.cameraMovement || shot.camera_movement || '')
  if (cam !== '固定') return 
  const shotType = String(shot.shotType || shot.shot_type || '')
  if (!WIDE_SHOT_TYPES.includes(shotType)) return 
  const music = shotMusicText(shot)
  if (music.trim() && MUSIC_TRANSITION_WORDS.some((w) => music.includes(w))) return
  warnings.push({
    code: 'EMPTY_LONG_SHOT',
    shot: shotLabel,
    message: `镜头 ${shotLabel}：${dur}s 全景/远景 + 固定机位 + 无台词——死画面长镜，观众会走神。长镜要有名分：要么运镜推进（缓慢推近到表情）、要么明确氛围留白设计（写明 micro-movement 与环境声）。`,
  })
}

const MUSIC_LANG_CHECK_ENABLED = config.storyboard?.musicLangCheckEnabled !== false
function isMostlyChinese(text) {
  const t = String(text || '')
  if (!t.trim()) return null 
  const zh = (t.match(/[一-龥]/g) || []).length
  const en = (t.match(/[A-Za-z]/g) || []).length
  if (zh + en === 0) return null
  return zh >= en
}
function checkMusicLanguageConsistency(flatShots, warnings) {
  if (!MUSIC_LANG_CHECK_ENABLED) return
  const votes = flatShots.map((s) => isMostlyChinese(s.music)).filter((v) => v !== null)
  if (votes.length < 4) return 
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


const CUT_ACTION_OVERLAP_ENABLED = config.storyboard?.cutActionOverlapCheckEnabled !== false
const EN_ING_TO_ZH_ACTION = {
  stepping: ['踩', '踏', '迈'], reaching: ['伸', '够'], grabbing: ['抓', '拽'],
  lifting: ['抬', '举'], raising: ['抬', '举'], lowering: ['压', '低'], turning: ['转', '扭'],
  jumping: ['跳', '跃'], running: ['跑', '冲'], pushing: ['推'], pulling: ['拉', '拽'],
  climbing: ['爬', '攀'], rising: ['起身', '站起'], pointing: ['指'], boarding: ['上'],
}
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
// 切点动作重复检出器（check 与 QC 修复 handler 预检共用，单一源）：
// 上一镜末帧停在 @某人 的 ing 动作上，本镜描述开头 30 字又用中文动词重述同一动作 → 观众看到叙事原地倒带。
export function detectCutActionOverlapHits(prevFrame, currDesc) {
  const pf = String(prevFrame || '')
  const headDesc = String(currDesc || '').slice(0, 30)
  if (!pf || !headDesc) return []
  const hits = []
  for (const { actor, ing } of extractActorIngPairs(pf)) {
    const zh = EN_ING_TO_ZH_ACTION[ing]
    if (!zh) continue
    if (!headDesc.includes('@' + actor)) continue
    const hit = zh.filter((z) => headDesc.includes(z))
    if (hit.length) hits.push({ actor, hit })
  }
  return hits
}

function checkCutActionOverlap(prevShot, currShot, warnings, shotLabel) {
  if (!CUT_ACTION_OVERLAP_ENABLED) return
  if (!prevShot || !currShot) return
  const hits = detectCutActionOverlapHits(prevShot.finalFrame || prevShot.final_frame || '', currShot.description || '')
  if (!hits.length) return
  const { actor, hit } = hits[0]
  warnings.push({
    code: 'CUT_ACTION_OVERLAP',
    shot: shotLabel,
    message: `镜头 ${shotLabel}：上一镜最终画面停在 @${actor} 的「${hit.join('/')}」动作上，本镜描述开头又写了一次「${hit.join('/')}」——同一个动作被陈述两遍，观众会看到叙事原地倒带（上镜刚做完，本镜重做）。把上镜末帧收在该动作**之前**（如"转身面向断桥"），把动作整段让给本镜。`,
  })
}

const ACTION_DENSITY_ENABLED = config.storyboard?.actionDensityCheckEnabled !== false
const ACTION_DENSITY_MAX = config.storyboard?.actionDensityMax ?? 0.6
function checkActionDensity(shot, warnings, shotLabel) {
  if (!ACTION_DENSITY_ENABLED) return
  const dur = Number(shot.duration) || 0
  if (dur <= 0) return
  const body = countActionBody(stripDialogue(String(shot.description || '')))
  if (body < 3) return 
  const density = body / dur
  if (density <= ACTION_DENSITY_MAX) return
  const needSec = Math.ceil(body / ACTION_DENSITY_MAX)
  warnings.push({
    code: 'ACTION_DENSITY_HIGH',
    shot: shotLabel,
    message: `镜头 ${shotLabel}：${dur}s 内 ${body} 个肢体动作（密度 ${density.toFixed(1)} 个/秒，上限 ${ACTION_DENSITY_MAX}）——时长装不下这个动作量，出片模型只能演开头、或把手部动作演糊。要么按任务边界拆镜，要么把时长延到约 ${needSec}s。`,
  })
}

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
  if (flatShots.length < 8) return 
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
  if (!known.size) {
    // 纵深防御：场景清单为空不是「名字对不上」，而是「根本没有场景资产」。
    // 入口已被 assertAssetsExist 拦截，此处兜住「生成后场景资产被删」等边角情况，避免静默放行。
    warnings.push({
      code: 'SCENE_ASSET_EMPTY',
      shot: label,
      message: `镜头 ${label}：本集场景资产清单为空，sceneAssets 无法锚定——请先提取场景资产。`,
    })
    return
  }
  const unknown = names.filter((n) => !known.has(n))
  if (unknown.length) {
    warnings.push({
      code: 'SCENE_ASSET_UNKNOWN',
      shot: label,
      message: `镜头 ${label}：sceneAssets 里的「${unknown.join('、')}」在场景资产清单里找不到——按名解析会落空，等同没有场景锚。请先建场景资产，或把名字改成清单里的现有场景（V7 对"名字不存在"不告警，故在此单独补）。`,
    })
  }
}

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

const SPECIES_DRIFT_CHECK_ENABLED = config.storyboard?.speciesDriftCheckEnabled !== false
const DIALOGUE_WINDOW_CHECK_ENABLED = config.storyboard?.dialogueWindowCheckEnabled !== false
export const AIRLOCK_SEC = config.storyboard?.airlockSec ?? 2
export const DIALOGUE_OVERFLOW_EPS = config.storyboard?.dialogueOverflowEpsSec ?? 0.5
const DIALOGUE_TIGHT_MIN = config.storyboard?.dialogueTightMinSec ?? 2.5
const SCENE_TEMPLATE_CHECK_ENABLED = config.storyboard?.sceneTemplateCheckEnabled !== false
const SCENE_TEMPLATE_TOLERANCE = config.storyboard?.sceneTemplateToleranceSec ?? 1
const SCENE_TEMPLATE_MIN_SCENES = config.storyboard?.sceneTemplateMinScenes ?? 3
const FAST_CUT_CHECK_ENABLED = config.storyboard?.fastCutCheckEnabled !== false
const FAST_CUT_MAX_SEC = config.storyboard?.fastCutMaxSec ?? 5
const FAST_CUT_MIN_SHOTS = config.storyboard?.fastCutMinShots ?? 20
const PROP_REGISTER_CHECK_ENABLED = config.storyboard?.propRegisterCheckEnabled !== false
const PROP_CANDIDATE_MIN_MENTIONS = config.storyboard?.propCandidateMinMentions ?? 3
const EMOTION_SCENE_STATIC_CHECK_ENABLED = config.storyboard?.emotionSceneStaticCheckEnabled !== false
const EMOTION_SCENE_STATIC_RATIO = config.storyboard?.emotionSceneStaticRatio ?? 0.5
// 上限出处：MiniMax 官方 API 文档 platform.minimax.io "Prompt length limit ≤ 7000 characters"
//（非 base-en/ref-en prompt 指南——指南里无此数字）。官方未说明超限行为，"静默截断"是本项目经验推断。
// 注意：config.js 未定义 h3PromptCharLimit，此 env 口子当前不存在，恒走 7000 默认值。
const H3_PROMPT_CHAR_LIMIT = config.storyboard?.h3PromptCharLimit ?? 7000
const MUSIC_MOOD_CHECK_ENABLED = config.storyboard?.musicMoodCheckEnabled !== false

const SPECIES_PATTERNS = [
  [/熊猫|panda/i, 'panda'],
  [/北极熊|polar bear/i, 'bear'],
  [/猫头鹰|\bowl\b/i, 'bird'],
  [/树袋熊|\bkoala\b/i, 'koala'],
  [/熊|\bbear\b/i, 'bear'],
  [/兔子|野兔|\brabbit\b|\bbunny\b|\bhare\b/i, 'rabbit'],
  [/狮子|狮|\blion\b/i, 'lion'],
  [/老虎|虎|\btiger\b/i, 'tiger'],
  [/狐狸|狐|\bfox\b/i, 'fox'],
  [/狼|\bwolf\b/i, 'wolf'],
  [/狗|犬|\bdog\b|\bpuppy\b/i, 'dog'],
  [/猫|\bcat\b|\bkitten\b/i, 'cat'],
  [/鼠|\bmouse\b|\brat\b/i, 'mouse'],
  [/鹿|\bdeer\b|\bfawn\b/i, 'deer'],
  [/马|\bhorse\b|\bpony\b/i, 'horse'],
  [/猪|\bpig\b/i, 'pig'],
  [/羊|\bsheep\b|\bgoat\b/i, 'sheep'],
  [/猴|\bmonkey\b/i, 'monkey'],
  [/青蛙|蛙|\bfrog\b|\btoad\b/i, 'frog'],
  [/鸭子|鸭|\bduck\b/i, 'duck'],
  [/企鹅|\bpenguin\b/i, 'penguin'],
  [/松鼠|\bsquirrel\b/i, 'squirrel'],
  [/仓鼠|\bhamster\b/i, 'hamster'],
  [/刺猬|\bhedgehog\b/i, 'hedgehog'],
  [/浣熊|\braccoon\b/i, 'raccoon'],
  [/大象|\belephant\b/i, 'elephant'],
  [/蛇|\bsnake\b/i, 'snake'],
  [/龙|\bdragon\b/i, 'dragon'],
  [/鸟|鹰|雀|\bbird\b|\beagle\b/i, 'bird'],
  [/鱼|\bfish\b/i, 'fish'],
]

function extractSpeciesSet(text) {
  const found = new Set()
  let s = String(text || '')
  for (const [re, canon] of SPECIES_PATTERNS) {
    s = s.replace(re, (m) => { found.add(canon); return ' '.repeat(m.length) })
  }
  return found
}

function charDescriptionText(c) {
  if (!c) return ''
  if (typeof c === 'string') return c
  return [c.description, c.description_en, c.appearance].filter(Boolean).join(' ')
}

const APPEARANCE_CUES = ['fur', 'ear', 'cub', 'fluffy', 'paw', 'paws', 'snout', 'muzzle', 'tail',
  'wear', 'wearing', 'scarf', 'exactly as shown', 'whisker', 'mane', 'hoof', 'wing', 'beak',
  '毛', '耳', '爪', '尾', '嘴', '鼻', '围巾', '团子', '体型', '毛发', '耳朵', '四肢', '轮廓']

function clauseAfterMention(text, idx, nameLen) {
  const start = idx + nameLen
  let end = start + 120
  for (const stop of ['@', '\n', '. ', '。', '。 ', '；', '; ']) {
    const p = text.indexOf(stop, start)
    if (p !== -1 && p < end) end = p
  }
  return text.slice(start, end)
}

function buildCharacterSpeciesMap(charRows = []) {
  const map = new Map()
  for (const c of charRows) {
    const name = typeof c === 'string' ? c : (c?.name || '')
    if (!name) continue
    if (typeof c === 'string') continue
    const set = extractSpeciesSet(charDescriptionText(c))
    if (set.size) map.set(name, set)
  }
  return map
}

function checkCharacterSpeciesDrift(shot, errors, label, ctx, codedErrors) {
  if (!SPECIES_DRIFT_CHECK_ENABLED) return
  const charRows = ctx.assetNames?.characters
  if (!Array.isArray(charRows) || !charRows.length) return
  const speciesMap = ctx.speciesMap || buildCharacterSpeciesMap(charRows)
  if (!speciesMap.size) return
  const aliasMap = ctx.aliasMap || null
  const text = String(shot.integratedMultimodalDescription || shot.integrated_multimodal_description || '') + '\n' +
    String(shot.finalFrame || shot.final_frame || '') + '\n' + String(shot.description || '')
  if (!text.trim()) return
  for (const [name, cardSet] of speciesMap) {
    const forms = buildNameForms(name, aliasMap?.get?.(name) || [])
    for (const form of forms) {
      const re = new RegExp('@?' + escapeRegExp(form) + '(?![\\w\\u4e00-\\u9fa5])', 'gi')
      let m
      while ((m = re.exec(text))) {
        const clause = clauseAfterMention(text, m.index, m[0].length)
        if (clause.length < 4) continue
        const hasAppearanceCue = APPEARANCE_CUES.some((c) => clause.toLowerCase().includes(c))
        if (!hasAppearanceCue) continue
        const shotSpecies = extractSpeciesSet(clause)
        if (!shotSpecies.size) continue
        const drift = [...shotSpecies].filter((s) => !cardSet.has(s))
        if (drift.length) {
          const message = `镜头 ${label}：@${name} 的描述含物种词「${drift.join('、')}」，但角色卡设定物种为「${[...cardSet].join('、')}」——物种漂移，出片会换成另一个物种，前后对不上。锚定词必须与角色卡逐字一致。`
          errors.push(message)
          if (Array.isArray(codedErrors)) codedErrors.push({ code: 'CHARACTER_SPECIES_DRIFT', shot: label, message })
          return
        }
      }
    }
  }
}

// ---- world_state 镜间衔接检查（#8）----

// 解析出场状态快照："@甲：画面左·右手持@乙·面向右；@乙：@甲右手·直立" → [{ name, sideZh, clause }]
const WS_SIDE_ZH_RE = /画面(左|右|中|中间)/
function parseWorldStateEntries(ws) {
  const text = String(ws || '')
  if (!text.trim()) return []
  const entries = []
  const re = /@([\u4e00-\u9fa5A-Za-z0-9_]+)/g
  let m
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length
    let end = text.length
    for (const stop of ['；', ';', '@']) {
      const p = text.indexOf(stop, start)
      if (p !== -1) end = Math.min(end, p)
    }
    const clause = text.slice(start, end)
    const sideZh = WS_SIDE_ZH_RE.exec(clause)?.[0] || ''
    entries.push({ name: m[1], sideZh, clause })
  }
  return entries
}

const WS_SIDE_MAP = [
  { zh: '画面左', enRe: /frame\s+left/i },
  { zh: '画面右', enRe: /frame\s+right/i },
  { zh: '画面中', enRe: /cent(?:er|ral)\s+frame|frame\s+cent(?:er|re)|at\s+the\s+center/i },
  { zh: '画面中间', enRe: /cent(?:er|ral)\s+frame|frame\s+cent(?:er|re)|at\s+the\s+center/i },
]

// 本镜出场状态快照的完整性 + 与 finalFrame 的侧位一致性（衔接错误从"等成片"提前到"落库即可查"）
// hasAnyWorldState：全集是否至少一镜有 world_state_out——旧链路分镜全空时不报 WS_OUT_EMPTY（避免存量洪水），新链路分镜里漏写才报
function checkWorldStateSeam(shot, errors, warnings, label, codedErrors, hasAnyWorldState) {
  const wsOut = String(shot.worldStateOut || shot.world_state_out || '').trim()
  const finalFrame = String(shot.finalFrame || shot.final_frame || '')

  if (!wsOut) {
    if (hasAnyWorldState) {
      warnings.push({
        code: 'WS_OUT_EMPTY',
        shot: label,
        message: `镜头 ${label}：world_state_out 为空（本集其他镜头有出场状态快照）——下一镜 Airlock 继承与镜间衔接只能退回 finalFrame 文本，状态校验失效。请补写出场状态快照（每个出场角色的"画面位置·手持·朝向"与关键道具状态）。`,
      })
    }
    return
  }

  const entries = parseWorldStateEntries(wsOut)
  const entryNames = new Set(entries.map((e) => e.name))

  // 台词说话人必须在出场状态里（error：台词归属与画面状态脱节）
  const dlgList = Array.isArray(shot.dialogue)
    ? shot.dialogue
    : (shot.dialogue && typeof shot.dialogue === 'object' ? [shot.dialogue] : [])
  const speakers = [...new Set(dlgList.map((d) => String(d?.character || '').trim()).filter(Boolean))]
  const missingSpeakers = speakers.filter((n) => !entryNames.has(n))
  if (missingSpeakers.length) {
    const message = `镜头 ${label}：台词说话人 ${missingSpeakers.map((n) => `@${n}`).join('、')} 不在 world_state_out 出场状态快照里——台词归属与画面状态脱节，镜间衔接无法追踪该角色。请在快照中补该角色条目。`
    errors.push(message)
    if (Array.isArray(codedErrors)) codedErrors.push({ code: 'WS_SPEAKER_MISSING', shot: label, message })
  }

  // 出场角色应有序目（warning：漏人）
  const charNames = (shot.characters || []).map(String).filter(Boolean)
  const missingChars = charNames.filter((n) => !entryNames.has(n))
  if (missingChars.length) {
    warnings.push({
      code: 'WS_CHAR_MISSING',
      shot: label,
      message: `镜头 ${label}：出场角色 ${missingChars.map((n) => `@${n}`).join('、')} 未写入 world_state_out——下一镜衔接时该角色状态未知。`,
    })
  }

  // 关键道具应有序目（warning：道具去向不明）
  const propNames = (shot.propAssets || []).map(String).filter(Boolean)
  const missingProps = propNames.filter((n) => !entryNames.has(n))
  if (missingProps.length) {
    warnings.push({
      code: 'WS_PROP_MISSING',
      shot: label,
      message: `镜头 ${label}：关键道具 ${missingProps.map((n) => `@${n}`).join('、')} 未写入 world_state_out——道具去向无法被下一镜继承。`,
    })
  }

  // 侧位一致性：world_state_out 的"画面左/右/中"必须与 finalFrame 的 frame left/right/center 一致（error：结构化快照与英文画面矛盾）
  if (finalFrame) {
    for (const e of entries) {
      if (!e.sideZh) continue
      // 从 finalFrame 中提取该实体名后的从句
      const nameIdx = finalFrame.indexOf(`@${e.name}`)
      if (nameIdx === -1) continue
      const clauseStart = nameIdx + e.name.length + 1
      let clauseEnd = finalFrame.length
      for (const stop of ['@', '.']) {
        const p = finalFrame.indexOf(stop, clauseStart)
        if (p !== -1) clauseEnd = Math.min(clauseEnd, p)
      }
      const ffClause = finalFrame.slice(clauseStart, clauseEnd)
      const zhSide = WS_SIDE_MAP.find((s) => s.zh === e.sideZh)
      if (!zhSide) continue
      // 位置描述通常紧跟角色名（"stands at frame right"），视线锚（"gazing toward frame left"）在后——
      // 只认从句中第一个出现的侧位，避免视线锚掩盖站位冲突
      let enSide = null
      let enSideIdx = Infinity
      for (const s of WS_SIDE_MAP) {
        const m = s.enRe.exec(ffClause)
        if (m && m.index < enSideIdx) { enSideIdx = m.index; enSide = s }
      }
      if (enSide && enSide.zh !== e.sideZh) {
        const message = `镜头 ${label}：@${e.name} 的 world_state_out 写「${e.sideZh}」，但 finalFrame 中为「${enSide.zh}」——结构化快照与英文最终画面侧位矛盾，出片必有一边错。请统一两处侧位。`
        errors.push(message)
        if (Array.isArray(codedErrors)) codedErrors.push({ code: 'WS_SIDE_MISMATCH', shot: label, message })
        break
      }
    }
  }
}

function checkDialogueWindow(shot, errors, warnings, label, codedErrors) {
  if (!DIALOGUE_WINDOW_CHECK_ENABLED) return
  const shotStart = Number(shot.startTime)
  const shotEnd = Number(shot.endTime)
  if (!Number.isFinite(shotStart) || !Number.isFinite(shotEnd) || shotEnd <= shotStart) return
  const dlgList = Array.isArray(shot.dialogue)
    ? shot.dialogue
    : (shot.dialogue && typeof shot.dialogue === 'object' ? [shot.dialogue] : [])
  if (!dlgList.length) return
  const airlockEnd = shotStart + AIRLOCK_SEC
  let lastStart = -Infinity
  for (const d of dlgList) {
    const lineStart = Number(d?.startTime)
    if (!Number.isFinite(lineStart)) continue
    if (lineStart > lastStart) lastStart = lineStart
    if (lineStart >= shotStart && lineStart < airlockEnd) {
      const message = `镜头 ${label}：台词「${String(d?.text || '').slice(0, 12)}」startTime=${lineStart}s 落在 Airlock 禁语期 [${shotStart}, ${airlockEnd})s——Airlock 期嘴唇应闭合，台词与口型/时间轴冲突。请把台词移到 ${airlockEnd}s 之后。`
      errors.push(message)
      if (Array.isArray(codedErrors)) codedErrors.push({ code: 'DIALOGUE_IN_AIRLOCK', shot: label, message })
    }
    const chars = countSpokenChars(d?.text)
    if (chars >= SPEECH_RATE_MIN_CHARS) {
      const lineDur = chars / SPEECH_RATE_MAX
      const lineEnd = lineStart + lineDur
      if (lineEnd > shotEnd + DIALOGUE_OVERFLOW_EPS) {
        const message = `镜头 ${label}：台词「${String(d?.text || '').slice(0, 12)}」按 ${SPEECH_RATE_MAX} 字/秒估算需 ${lineDur.toFixed(1)}s，结束于 ${lineEnd.toFixed(1)}s 超过镜尾 ${shotEnd}s——台词会被截断或溢出到下一镜。请加长镜头或删减台词。`
        errors.push(message)
        if (Array.isArray(codedErrors)) codedErrors.push({ code: 'DIALOGUE_OVERFLOW', shot: label, message })
      }
    }
  }
  if (lastStart > -Infinity) {
    const window = shotEnd - lastStart
    if (window < DIALOGUE_TIGHT_MIN && window >= 0) {
      warnings.push({
        code: 'DIALOGUE_WINDOW_TIGHT',
        shot: label,
        message: `镜头 ${label}：末句 startTime=${lastStart}s，距镜尾 ${shotEnd}s 仅剩 ${window.toFixed(1)}s（< ${DIALOGUE_TIGHT_MIN}s）——虽不溢出但留白不足，换气/收音仓促，建议加长镜头或提前台词。`,
      })
    }
  }
}

const H3_MUSIC_MOOD_WORDS = ['不安', '紧张', '悬疑', '温暖', '悲伤', '欢快', '恐怖', '浪漫', '感动',
  '治愈', '绝望', '孤独', '恐惧', '喜悦', '忧伤', '悲壮', '热血', '温馨', '压抑', '激昂', '深情',
  '甜蜜', '苦涩', '心碎', '寂寥', '苍凉', '欣慰', '振奋', '忐忑', '焦躁', '神圣', '肃穆', '明媚',
  '阴森', '诡异', '悲凉', '悸动', '空灵', '磅礴', '温柔']

const H3_MUSIC_MOOD_WORDS_EN = ['tense', 'warm', 'sad', 'happy', 'romantic', 'exciting', 'emotional',
  'moving', 'heartwarming', 'horror', 'suspense', 'joyful', 'gloomy', 'hopeful', 'despair', 'eerie',
  'uplifting', 'sorrowful', 'triumphant', 'melancholy']

export function findMusicMoodWords(musicText) {
  const music = String(musicText || '')
  if (!music.trim()) return []
  const lower = music.toLowerCase()
  return H3_MUSIC_MOOD_WORDS.filter((w) => music.includes(w))
    .concat(H3_MUSIC_MOOD_WORDS_EN.filter((w) => lower.includes(w)))
}

function checkMusicMoodWord(shot, warnings, label) {
  if (!MUSIC_MOOD_CHECK_ENABLED) return
  const music = String(shot.nonDiegeticMusic || shot.non_diegetic_music || '')
  if (!music.trim()) return
  const hits = findMusicMoodWords(music)
  if (!hits.length) return
  warnings.push({
    code: 'MUSIC_MOOD_WORD',
    shot: label,
    message: `镜头 ${label}：non_diegetic_music 含抽象情绪词「${hits.join('、')}」——官方提示词指南（base-en §4.7）要求只用乐器/速度/节奏/动态变化等可听属性，不写抽象情绪词或解释情绪功能。请把「${hits[0]}」改写成可听见的配器或动态描述（例：把"紧张"写成"低音鼓点以急促节奏敲击、弦乐音量渐进上行"）。`,
  })
}

// H3 是出片模型；出片 prompt 由 description/action_note/final_frame/dialogue/声景/配乐/运镜/景别等
// 结构化字段重建（见 v4Video.js），不含 IMD（IMD 是出图提示词，不进出片）。
// 此前把 IMD（出图）+ 声景/配乐（出片）混量，既不是出图限长也不是出片限长。
// 现改为量出片源字段总长——它是 builder 输出长度的忠实下界（builder = 这些字段 + 固定骨架开销）。
// 注意：H3 硬上限作用于【builder 组装后】的完整 prompt，逐镜量无法精确预判实际长度；
// 此 check 是逐镜保守代理，抓"单镜源字段已严重超长"的极端情况，权威检查是 post-build 量真实组装结果。
export const SHOT_VIDEO_PROMPT_OVERHEAD = 2000
export function dialogueTextLen(d) {
  if (d == null) return 0
  let arr = d
  if (typeof d === 'string') {
    const s = d.trim()
    if (!s || s === 'null') return s.length
    try { arr = JSON.parse(s) } catch { return s.length }
  }
  if (Array.isArray(arr)) return arr.reduce((n, x) => n + String(x?.text || '').length, 0)
  if (typeof arr === 'object') return String(arr.text || '').length
  return 0
}
// 出片源字段总长 + 骨架开销 + 参考素材开销估算——validator（告警）与 qc.js（condense 触发）共用，避免长度逻辑两处定义。
// 参考素材开销按 2026-09-23 实测标定（镜 4-4 复算）：builder 会把每个 ref 的英文描述在
// subject_definitions 与 retention_analysis 各写一遍，且每场景附一条 lighting 常量句、
// 每角色附一条多视角提示句——ref 模板开销远高于此前"纯源字段"估算的认知。
const REF_TEMPLATE_COST = 230        // 单 ref 净模板（subject + retention 两处句式，不含资产描述）
const REF_DESC_REPEAT = 2            // 资产英文描述在两段各写一遍
const SCENE_LIGHTING_COST = 110      // 场景 lighting 常量句（subject_definitions）
const CHAR_MULTIVIEW_COST = 130      // 角色多视角提示句（retention_analysis）
const REF_FALLBACK_COST = 850        // 无资产数据可匹配时的单 ref 均值（实测标定）

function parseAssetNameList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x || '').trim()).filter(Boolean)
  return []
}

// ctx.assetNames 可提供 characters/scenes/props 行（含 description_en/summary_en/lighting_en），
// 有则用实值估，没有则按 REF_FALLBACK_COST 均值估（宁可高估不误放）。
export function estimateRefsPromptCost(shot, ctx = {}) {
  const charNames = parseAssetNameList(shot.characters)
  const sceneNames = parseAssetNameList(shot.sceneAssets || shot.scene_assets)
  const propNames = parseAssetNameList(shot.propAssets || shot.prop_assets)
  const total = charNames.length + sceneNames.length + propNames.length
  if (!total) return 0
  const assets = ctx?.assetNames
  if (!assets) return total * REF_FALLBACK_COST
  const findRow = (rows, name) => (rows || []).find((x) =>
    typeof x === 'string' ? x === name : (x.title === name || x.name === name))
  let cost = 0
  for (const n of charNames) {
    const r = findRow(assets.characters, n)
    const d = r && typeof r !== 'string' ? String(r.description_en || r.description || r.appearance || '').length : 0
    cost += d ? REF_TEMPLATE_COST + d * REF_DESC_REPEAT + CHAR_MULTIVIEW_COST : REF_FALLBACK_COST
  }
  for (const n of sceneNames) {
    const r = findRow(assets.scenes, n)
    // 与出片组装层同口径（generate-video.js collectShot 的跨场拦截）：挂错场次的场景图
    // 出片时不会进 refs，估算同样不计——否则 QC 会报「出片实际不会发生」的超限（误报）。
    // 跨场挂载本身由 checkCrossSceneMount 单独告警。ctx.sceneNumber 缺失时不排除（高估安全）。
    if (r && typeof r !== 'string' && r.scene_number != null && ctx?.sceneNumber != null
      && Number(r.scene_number) !== Number(ctx.sceneNumber)) continue
    // 场景描述字段取值：scenes 表的描述列是 summary/summary_en（不是 description_en/description），
    // 取值需双口径覆盖——否则取不到描述会走 REF_FALLBACK_COST 兜底，估算与实际组装不符。
    const d = r && typeof r !== 'string' ? String(r.description_en || r.summary_en || r.description || r.summary || '').length : 0
    const l = r && typeof r !== 'string' ? String(r.lighting_en || '').length : 0
    cost += (d || l) ? REF_TEMPLATE_COST + d * REF_DESC_REPEAT + (l ? SCENE_LIGHTING_COST + l : 0) : REF_FALLBACK_COST
  }
  for (const n of propNames) {
    const r = findRow(assets.props, n)
    const d = r && typeof r !== 'string' ? String(r.description_en || r.description || '').length : 0
    cost += d ? REF_TEMPLATE_COST + d * REF_DESC_REPEAT : REF_FALLBACK_COST
  }
  return cost
}

export function estimateShotVideoPromptChars(shot, ctx = {}) {
  const fieldTotal =
    String(shot.description || '').length +
    String(shot.actionNote || shot.action_note || '').length +
    String(shot.finalFrame || shot.final_frame || '').length +
    String(shot.overallSoundscape || shot.overall_soundscape || '').length +
    String(shot.nonDiegeticMusic || shot.non_diegetic_music || '').length +
    String(shot.cameraMovement || shot.camera_movement || '').length +
    String(shot.shotType || shot.shot_type || '').length +
    dialogueTextLen(shot.dialogue)
  const refsCost = estimateRefsPromptCost(shot, ctx)
  return { fieldTotal, refsCost, estimated: fieldTotal + SHOT_VIDEO_PROMPT_OVERHEAD + refsCost }
}
// 贴线预警阈值：估算超过 H3 上限的 90%（默认 6300）即 warn。理由：估算与组装后真实长度之间
// 存在英译长度波动（实测残差可达 ±500），贴线镜出片时可能实际超 7000 被硬阻断——
// 与其出片时炸，不如 QC 阶段就给预警留精简余量。
const H3_PROMPT_WARN_THRESHOLD = Math.floor((config.storyboard?.h3PromptCharLimit ?? 7000) * 0.9)

function checkH3PromptLimit(shot, errors, warnings, label, codedErrors, ctx) {
  const { fieldTotal, refsCost, estimated } = estimateShotVideoPromptChars(shot, ctx)
  if (estimated > H3_PROMPT_CHAR_LIMIT) {
    const message = `镜头 ${label}：出片提示词估算总长 ≈ ${estimated} 字符（源字段 ${fieldTotal} + 骨架 ${SHOT_VIDEO_PROMPT_OVERHEAD} + 参考素材 ${refsCost}），超出 MiniMax H3 单条 ${H3_PROMPT_CHAR_LIMIT} 字符硬上限（官方 API 文档明文）。大头通常是参考素材（每个 ref 约 230 模板 + 英文描述写两遍 + 场景 lighting/角色多视角句；一张场景图 ≈1000 字符）——优先减少单镜挂的场景/道具图（尤其跨场重复挂的），其次才精简 description/action_note/final_frame 正文`
    errors.push(message)
    if (Array.isArray(codedErrors)) codedErrors.push({ code: 'PROMPT_OVER_LIMIT', shot: label, message })
    return
  }
  if (estimated > H3_PROMPT_WARN_THRESHOLD && Array.isArray(warnings)) {
    const message = `镜头 ${label}：出片提示词估算总长 ≈ ${estimated} 字符，已达 H3 上限 ${H3_PROMPT_CHAR_LIMIT} 的 90%（贴线）。组装后长度受英译波动影响（±500 字符量级），出片时可能实际超限被硬阻断——建议留余量：减少本镜挂的场景/道具图或精简正文`
    warnings.push({ code: 'PROMPT_NEAR_LIMIT', shot: label, message })
  }
}

// 跨场次场景挂载检查（与 generate-video.js collectShot 的运行时拦截同源）：
// 场景资产按场次拆分，单镜只应挂本镜所属场次的场景；出片时挂错的图会被自动跳过，
// 此处让问题在 QC/分镜阶段可见。
function checkCrossSceneMount(shot, warnings, label, ctx) {
  const assets = ctx?.assetNames
  if (!assets) return
  const names = parseAssetNameList(shot.sceneAssets || shot.scene_assets)
  if (!names.length) return
  const shotSceneNo = ctx.sceneNumber ?? shot.sceneNumber ?? shot.scene_number
  if (shotSceneNo == null) return
  for (const n of names) {
    const s = (assets.scenes || []).find((x) => typeof x !== 'string' && (x.title === n || x.name === n))
    if (s && s.scene_number != null && Number(s.scene_number) !== Number(shotSceneNo)) {
      warnings.push({
        code: 'SCENE_CROSS_SCENE_MOUNT',
        shot: label,
        message: `镜头 ${label}：场景「${n}」属于第 ${s.scene_number} 场，本镜在第 ${shotSceneNo} 场——跨场场景挂载不进出片参考（一张跨场图 ≈1000 字符且与基底图打架），出片时会被自动跳过；请在本场场景里选`,
      })
    }
  }
}

// 服饰类词复用 COSTUME_WORDS，其后为可被登记为道具的物件词
const PROP_CANDIDATE_LEXICON = [
  ...COSTUME_WORDS,
  '灯笼', '地图', '罗盘',
  '钥匙', '蜡烛', '旗帜', '护身符', '卷轴', '沙漏', '令牌', '徽章', '勋章', '怀表', '布偶', '玩偶',
  '气球', '风筝', '木马', '摇篮', '拐杖', '宝石', '水晶', '戒指',
]

function collectPropCandidates(storyboard, assetNames) {
  const registered = new Set(
    (assetNames?.props || []).map((p) => (typeof p === 'string' ? p : (p?.name || ''))).filter(Boolean)
  )
  const charText = (assetNames?.characters || [])
    .map((c) => (typeof c === 'string' ? c : charDescriptionText(c))).join(' ')
  const tally = new Map()
  for (const scene of (storyboard?.scenes || [])) {
    for (const shot of (scene?.shots || [])) {
      const label = shot.shotNumber || shot.shot_number || `scene${scene.sceneNumber || ''}`
      const text = String(shot.integratedMultimodalDescription || shot.integrated_multimodal_description || '') + '\n' +
        String(shot.finalFrame || shot.final_frame || '') + '\n' + String(shot.description || '')
      for (const cand of PROP_CANDIDATE_LEXICON) {
        if (!text.includes(cand)) continue
        if (registered.has(cand)) continue
        if (charText.includes(cand)) continue
        if (!tally.has(cand)) tally.set(cand, [])
        tally.get(cand).push(label)
      }
    }
  }
  return tally
}

function checkPropUnregistered(storyboard, warnings, assetNames) {
  if (!PROP_REGISTER_CHECK_ENABLED) return
  const tally = collectPropCandidates(storyboard, assetNames)
  for (const [cand, shots] of tally) {
    if (shots.length < PROP_CANDIDATE_MIN_MENTIONS) continue
    warnings.push({
      code: 'PROP_UNREGISTERED',
      shot: '*',
      message: `道具「${cand}」在 ${shots.length} 镜出现（${shots.slice(0, 6).join('、')}）但未在 props 表登记——颜色/形态/系法逐镜自由发挥必漂。请先登记并生设定图，再挂到相关镜头的 propAssets。`,
    })
  }
}

const EMOTION_SCENE_WORDS = ['迷雾', '雾', '黑暗', '夜', '夜里', '夜晚', '深夜', '夜色', '暮色', '黄昏',
  '恐惧', '害怕', '惊恐', '走失', '迷路', '离别', '告别', '失落', '孤独', '绝望', '危机', '危险',
  '未知', '凝视', '注视', '黑暗中']

function sceneEmotionText(scene) {
  const parts = [scene?.title, scene?.summary, scene?.description]
  for (const s of (scene?.shots || [])) parts.push(s?.description)
  return parts.filter(Boolean).join(' ')
}

function checkEmotionSceneStatic(storyboard, warnings) {
  if (!EMOTION_SCENE_STATIC_CHECK_ENABLED) return
  for (const scene of (storyboard?.scenes || [])) {
    const text = sceneEmotionText(scene)
    if (!EMOTION_SCENE_WORDS.some((w) => text.includes(w))) continue
    const shots = (scene?.shots || []).filter((s) => s)
    if (shots.length < 2) continue
    const fixedCount = shots.filter((s) => String(s.cameraMovement || s.camera_movement || '') === '固定').length
    if (fixedCount / shots.length < EMOTION_SCENE_STATIC_RATIO) continue
    const sceneLabel = `场次${scene.sceneNumber || '?'}`
    warnings.push({
      code: 'EMOTION_SCENE_STATIC',
      shot: sceneLabel,
      message: `${sceneLabel}（${scene.title || ''}）含情绪词且 ${fixedCount}/${shots.length} 镜为固定机位——情绪段该让画面自己焦虑/沉浸，却钉死不动，观感接近幻灯片。建议改用极缓呼吸推/手持微晃。`,
    })
  }
}

function checkSceneDurationTemplate(storyboard, warnings) {
  if (!SCENE_TEMPLATE_CHECK_ENABLED) return
  const scenes = (storyboard?.scenes || []).filter((s) => s)
  if (scenes.length < SCENE_TEMPLATE_MIN_SCENES) return
  const totals = scenes.map((s) => {
    const t = (s?.shots || []).reduce((n, sh) => n + (Number(sh?.duration) || 0), 0)
    return { scene: s, total: t }
  }).filter((x) => x.total > 0)
  const buckets = new Map()
  for (const x of totals) {
    const bucket = Math.round(x.total / SCENE_TEMPLATE_TOLERANCE)
    if (!buckets.has(bucket)) buckets.set(bucket, [])
    buckets.get(bucket).push(x)
  }
  for (const [, group] of buckets) {
    if (group.length < SCENE_TEMPLATE_MIN_SCENES) continue
    const labels = group.map((x) => `场${x.scene.sceneNumber || '?'}(${x.total}s)`).join('、')
    warnings.push({
      code: 'SCENE_DURATION_TEMPLATE',
      shot: '*',
      message: `场次时长模板化：${labels} 总时长雷同——观众看三场就能预判下一场呼吸，悬疑与情绪落点被磨平。打破节拍，让各场时长差异化。`,
    })
    return
  }
}

function checkNoFastCut(flatShots, warnings) {
  if (!FAST_CUT_CHECK_ENABLED) return
  if (flatShots.length < FAST_CUT_MIN_SHOTS) return
  const hasFast = flatShots.some((s) => (Number(s.duration) || 0) <= FAST_CUT_MAX_SEC)
  if (hasFast) return
  warnings.push({
    code: 'NO_FAST_CUT',
    shot: '*',
    message: `全片 ${flatShots.length} 镜无一镜 ≤ ${FAST_CUT_MAX_SEC}s——整片匀速，危机段无法提速。在情绪高点把镜头压到贴近时长下限（MiniMax H3 最短 4s）的短镜（特写/反应/局部）制造节奏差，不要再指望 2-3s 碎镜，H3 不支持。`,
  })
}

function checkAxisDriftScene(storyboard, warnings, charNames, aliasMap) {
  if (!charNames?.length) return
  for (const scene of (storyboard?.scenes || [])) {
    const shots = (scene?.shots || []).filter((s) => s)
    if (shots.length < 3) continue
    const perCharSides = new Map()
    const perCharCount = new Map()
    for (const shot of shots) {
      const ff = String(shot.finalFrame || shot.final_frame || '')
      if (!ff) continue
      const sides = extractScreenSides(ff, charNames, aliasMap)
      for (const [name, side] of sides) {
        if (!perCharSides.has(name)) perCharSides.set(name, new Set())
        perCharSides.get(name).add(side)
        perCharCount.set(name, (perCharCount.get(name) || 0) + 1)
      }
    }
    const sceneLabel = `场次${scene.sceneNumber || '?'}`
    for (const [name, sideSet] of perCharSides) {
      const withoutCenter = new Set([...sideSet].filter((s) => s !== 'center'))
      if (withoutCenter.size >= 2 && (perCharCount.get(name) || 0) >= 3) {
        warnings.push({
          code: 'AXIS_DRIFT',
          shot: sceneLabel,
          message: `${sceneLabel}（${scene.title || ''}）：@${name} 在同一场内 ${perCharCount.get(name)} 次出场、画面侧位 ${[...withoutCenter].join('↔')} 反复翻转——180 度轴线被反复破坏，观众空间感混乱。固定一句空间铁律（如"河岸永远在画面右下"）并逐镜校验。`,
        })
        break
      }
    }
  }
}

export function suggestUnregisteredProps(storyboard, assetNames) {
  const tally = collectPropCandidates(storyboard, assetNames)
  const out = []
  for (const [name, shots] of tally) {
    if (shots.length >= PROP_CANDIDATE_MIN_MENTIONS) out.push({ name, shotCount: shots.length, shots })
  }
  return out
}

export function validateShot(shot, ctx = {}) {
  const errors = []
  const warnings = makeWarnings()
  const fixed = []
  const codedErrors = []
  const label = ctx.shotLabel || shot.shotNumber || shot.shot_number || shot.id || 'unknown'

  if (!shot.finalFrame && !shot.final_frame) {
    errors.push(`镜头 ${label}：finalFrame 字段为空，必须填写本镜最终画面描述（下一镜 Airlock 继承依据）`)
  }
  if (!shot.integratedMultimodalDescription && !shot.integrated_multimodal_description) {
    errors.push(`镜头 ${label}：integratedMultimodalDescription 字段为空，必须填写 AI 图像/视频模型使用的完整提示词`)
  }

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

  if (ctx.assetNames) {
    const before = JSON.stringify(shot.characters || [])
    backfillShotAssets(shot, ctx.assetNames)
    const after = JSON.stringify(shot.characters || [])
    if (before !== after) {
      fixed.push(`镜头 ${label}：characters 已程序化补齐（${before} → ${after}）`)
    }
  }

  const descMentions = new Set(extractMentions(shot.description || ''))
  const promptMentions = new Set(extractMentions(shot.integratedMultimodalDescription || shot.integrated_multimodal_description || ''))
  const frameMentions = new Set(extractMentions(shot.finalFrame || shot.final_frame || ''))
  const allMentions = new Set([...descMentions, ...promptMentions, ...frameMentions])

  const charSet = new Set(shot.characters || [])
  const extra = [...charSet].filter((c) => !allMentions.has(c))
  if (extra.length > 0 && ctx.assetNames) {
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

  const charRows = ctx.assetNames ? (ctx.assetNames.characters || []) : null
  const charNames = charRows
    ? charRows.map((c) => (typeof c === 'string' ? c : c.name))
    : null
  const aliasCtx = charRows
    ? buildAliasMap(charRows.filter((c) => typeof c !== 'string'))
    : null
  checkAirlockInheritance(ctx.prevShot, shot, warnings, label, charNames)

  checkFrameGeography(ctx.prevShot, shot, warnings, label, charNames, aliasCtx)

  checkLocationTeleport(ctx.prevShot, shot, warnings, label, charNames)

  checkCinematicGrammar(shot, warnings, label)

  checkDialogueSpeed(shot, warnings, label)

    if (ctx.prevShot && ctx.sceneIndex != null && ctx.prevSceneIndex != null && ctx.sceneIndex === ctx.prevSceneIndex) {
    checkAdjacentSimilarity(ctx.prevShot, shot, warnings, label)
  }

  if (ctx.prevShot && ctx.sceneIndex != null && ctx.prevSceneIndex != null && ctx.sceneIndex === ctx.prevSceneIndex) {
    checkCutGain(ctx.prevShot, shot, warnings, label, true)
  }

  checkReactionShot(ctx.prevShot, shot, ctx.nextShot, warnings, label, charNames)

  if (ctx.prevShot && ctx.sceneIndex != null && ctx.prevSceneIndex != null && ctx.sceneIndex === ctx.prevSceneIndex) {
    checkLightFlip(ctx.prevShot, shot, warnings, label, true)
  }

  checkMultiCameraMove(shot, warnings, label)
  checkActionCameraMismatch(shot, warnings, label)

  if (ctx.prevShot && ctx.sceneIndex != null && ctx.prevSceneIndex != null && ctx.sceneIndex === ctx.prevSceneIndex) {
    checkSoundArc(ctx.prevShot, shot, warnings, label, true)
  }
  checkSilenceGap(shot, warnings, label)

  checkChainReactionOverload(shot, warnings, label)
  checkEmptyLongShot(shot, warnings, label, Boolean(ctx.isLastShot))

  checkLongShotThinPrompt(shot, warnings, label)

  // 戏型交叉校验：LLM 显式 isCombat 与确定性关键词分类冲突时提示。
  // 分类器仅在 LLM 未给值时兜底（episodes.js 落库），这里补「显式值」复核；漏判武戏代价大。
  {
    const rawCombat = shot.isCombat !== undefined && shot.isCombat !== null
      ? shot.isCombat
      : shot.is_combat
    const llmCombat = rawCombat === true || rawCombat === 1
      ? true
      : (rawCombat === false || rawCombat === 0 ? false : null)
    if (llmCombat !== null) {
      const clsCombat = classifyShotCombat(shot)
      if (llmCombat !== clsCombat) {
        warnings.push({
          code: 'COMBAT_CLASS_MISMATCH',
          shot: label,
          message: llmCombat === false
            ? `镜头 ${label}：标记为文戏，但描述/动作/音效含打斗或物理撞击关键词、确定性分类判为武戏——若确为武戏，出片不加载打斗LoRA会毁掉画面调性，请复核 isCombat`
            : `镜头 ${label}：标记为武戏，但内容无明显打斗/物理对抗关键词——若确为文戏会白加载打斗LoRA，请复核 isCombat`,
        })
      }
    }
  }

  checkStylePoison(shot, errors, label, ctx, codedErrors)

  checkCharacterSpeciesDrift(shot, errors, label, ctx, codedErrors)

  checkDialogueWindow(shot, errors, warnings, label, codedErrors)

  checkMusicMoodWord(shot, warnings, label)

  checkH3PromptLimit(shot, errors, warnings, label, codedErrors, ctx)

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

  checkSceneAnchor(shot, warnings, label, ctx)

  checkCrossSceneMount(shot, warnings, label, ctx)

  checkCostumeConflict(shot, warnings, label, ctx)

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

export function validateStoryboard(storyboard, assetNames, opts = {}) {
  const errors = []
  const warnings = makeWarnings()
  const fixed = []
  const codedErrors = []
  let prevShot = null
  let prevSceneIndex = null
  let scenes_seen = 0
  let shotCount = 0
  const totalShots = (storyboard?.scenes || []).reduce((n, sc) => n + (sc?.shots || []).length, 0)

  let expectedStart = 0
  const timelineIssues = []
  const hasAnyWorldState = (storyboard?.scenes || []).some((sc) =>
    (sc?.shots || []).some((s) => String(s.worldStateOut || s.world_state_out || '').trim())
  )

  const charRowsForMap = Array.isArray(assetNames?.characters) ? assetNames.characters : []
  const speciesMap = buildCharacterSpeciesMap(charRowsForMap)
  const aliasMap = buildAliasMap(charRowsForMap.filter((c) => typeof c !== 'string'))
  const charNames = charRowsForMap.map((c) => (typeof c === 'string' ? c : c?.name)).filter(Boolean)

  for (const scene of (storyboard?.scenes || [])) {
    const sceneIndex = scenes_seen++
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
    const sceneShots = scene?.shots || []
    for (let si = 0; si < sceneShots.length; si++) {
      const shot = sceneShots[si]
      const nextShot = si + 1 < sceneShots.length ? sceneShots[si + 1] : null
      shotCount++
      const label = shot.shotNumber || shot.shot_number || `scene${scene.sceneNumber || ''}-shot${shotCount}`

      const res = validateShot(shot, { assetNames, prevShot, nextShot, shotLabel: label, projectStyleText: opts.projectStyleText, projectStyleCategory: opts.projectStyleCategory, sceneIndex, prevSceneIndex, isLastShot: shotCount === totalShots, speciesMap, aliasMap, sceneNumber: scene.sceneNumber ?? scene.scene_number })
      errors.push(...res.errors)
      warnings.push(...res.warnings)
      fixed.push(...res.fixed)
      codedErrors.push(...(res.codedErrors || []))

      checkCutActionOverlap(prevShot, shot, warnings, label)
      checkActionDensity(shot, warnings, label)
      checkWorldStateSeam(shot, errors, warnings, label, codedErrors, hasAnyWorldState)

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
      prevSceneIndex = sceneIndex
    }
  }

  for (const issue of timelineIssues) {
    warnings.push({ code: 'TIMELINE_DISCONTINUITY', shot: '*', message: issue })
  }

  const flatShots = []
  for (const scene of (storyboard?.scenes || [])) {
    for (const shot of (scene?.shots || [])) {
      flatShots.push({
        label: shot.shotNumber || shot.shot_number || `shot${flatShots.length + 1}`,
        description: String(shot.description || ''),
        hasDialogue: hasDialogueContent(shot.dialogue),
        duration: Number(shot.duration) || 0,
        music: String(shot.nonDiegeticMusic ?? shot.non_diegetic_music ?? ''),
        shotType: String(shot.shotType || shot.shot_type || ''),
        cameraAngle: String(shot.cameraAngle || shot.camera_angle || ''),
        cameraMovement: String(shot.cameraMovement || shot.camera_movement || ''),
      })
    }
  }
  checkDialogueFloor(flatShots, warnings)
  checkGagRepeat(flatShots, warnings)
  checkEndingRushed(flatShots, warnings)
  checkMusicLanguageConsistency(flatShots, warnings)
  checkOpeningHook(flatShots, warnings)
  checkShotAttributeMonotone(flatShots, warnings)

  checkPropUnregistered(storyboard, warnings, assetNames)
  checkEmotionSceneStatic(storyboard, warnings)
  checkSceneDurationTemplate(storyboard, warnings)
  checkNoFastCut(flatShots, warnings)
  checkAxisDriftScene(storyboard, warnings, charNames, aliasMap)

  if (Array.isArray(opts.sceneRows)) {
    const boardNumbers = (storyboard?.scenes || []).map((s, i) => Number(s?.sceneNumber) || i + 1)
    for (const p of checkSceneIndexAlignment(boardNumbers, opts.sceneRows)) {
      warnings.push({ code: 'SCENE_INDEX_MISMATCH', shot: '*', message: p })
    }
  }

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
    worldStateOut: row.world_state_out || '',
    worldStateIn: row.world_state_in || '',
    nonDiegeticMusic: row.non_diegetic_music || '',
    blockingPlan: parseObj(row.blocking_plan),
    videoPromptOverride: row.video_prompt_override || '',
    isCombat: row.is_combat,
  }
}
