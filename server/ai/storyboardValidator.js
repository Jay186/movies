
import { backfillShotAssets } from './assetBackfill.js'
import { config } from '../config.js'
import { qcMeta } from './qcCodes.js'
import { escapeRegExp } from './shared.js'

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

const SPEECH_RATE_MAX = config.storyboard?.speechRateMaxCharsPerSec ?? 5
const SPEECH_RATE_MIN_CHARS = config.storyboard?.speechRateMinChars ?? 3
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

function extractMentions(text) {
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
          message: `镜头 ${shotLabel}：@${name} 画面侧位从上一镜 frame ${prevSide} 翻转到 frame ${cSide}，但本镜动作时间轴里没有显式走位（walks/moves to frame ${cSide}）。若是合法越轴请在模块4 补走位动作；否则角色会凭空换边（180 度轴线被破坏）。`,
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


function countSpokenChars(text) {
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

const STYLE_POISON_ZH = ['写实CGI', '写实CG', '写实', 'CG定格', 'CG感', '真实感', '照片级', '电影质感', '3D', '三维', '立体渲染', '实拍']
const STYLE_POISON_EN = ['realistic', 'CGI', 'photoreal', 'photorealistic', 'hyperreal', 'hyper-realistic', 'live-action', '3D render', 'CG render']

const POISON_NEGATION_ZH_RE = /(?:无|非|不|勿|避免|不要|不能|不得|不含|绝非|毫不|并不|从未|禁止)\s*$/
const POISON_NEGATION_EN_RE = /(?:no|not|never|without|avoid|non)(?:[\s-]+[\w-]+){0,1}[\s-]*$/i
function isPoisonNegatedAt(s, idx) {
  const before = s.slice(Math.max(0, idx - 16), idx)
  return POISON_NEGATION_ZH_RE.test(before) || POISON_NEGATION_EN_RE.test(before)
}

export function findStylePoison(texts, projectStyleText = '') {
  const hits = []
  for (const t of texts) {
    const s = String(t || '')
    if (!s) continue
    for (const w of STYLE_POISON_ZH) {
      if (projectStyleText.includes(w)) continue
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
    shot.actionNote || shot.action_note,
    shot.blockingPlan || shot.blocking_plan,
    shot.videoPromptOverride || shot.video_prompt_override,
  ]
  const hits = findStylePoison(texts, ctx?.projectStyleText || '')
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
function checkCutGain(prevShot, currShot, warnings, shotLabel, sameScene) {
  if (!prevShot || !sameScene) return
  const prevFf = prevShot.finalFrame || prevShot.final_frame || ''
  const currFf = currShot.finalFrame || currShot.final_frame || ''
  if (!prevFf || !currFf) return
  const sim = jaccardSet(tokenizeFrame(prevFf), tokenizeFrame(currFf))
  if (sim <= CUT_GAIN_JACCARD_THRESHOLD) return

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

function checkReactionShot(prevShot, currShot, warnings, shotLabel, charNames) {
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


const LIGHT_DIRECTION_PATTERNS = {
  left: [/from frame left/i, /from the left/i, /light from (?:the )?left/i],
  right: [/from frame right/i, /from the right/i, /light from (?:the )?right/i],
}
const LIGHT_WARM_WORDS = ['warm', 'golden', 'amber', 'sunset', 'honey', 'orange', 'fiery']
const LIGHT_COOL_WORDS = ['cool', 'cold', 'icy', 'blue', 'grey', 'gray', 'silver', 'pale', 'frost']

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
    if (!headDesc.includes('@' + actor)) continue
    const hit = zh.filter((z) => headDesc.includes(z))
    if (!hit.length) continue
    warnings.push({
      code: 'CUT_ACTION_OVERLAP',
      shot: shotLabel,
      message: `镜头 ${shotLabel}：上一镜最终画面停在 @${actor} 的「${hit.join('/')}」动作上，本镜描述开头又写了一次「${hit.join('/')}」——同一个动作被陈述两遍，观众会看到叙事原地倒带（上镜刚做完，本镜重做）。把上镜末帧收在该动作**之前**（如"转身面向断桥"），把动作整段让给本镜。`,
    })
    break 
  }
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

  checkReactionShot(ctx.prevShot, shot, warnings, label, charNames)

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

  checkStylePoison(shot, errors, label, ctx, codedErrors)

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
    for (const shot of (scene?.shots || [])) {
      shotCount++
      const label = shot.shotNumber || shot.shot_number || `scene${scene.sceneNumber || ''}-shot${shotCount}`

      const res = validateShot(shot, { assetNames, prevShot, shotLabel: label, projectStyleText: opts.projectStyleText, sceneIndex, prevSceneIndex, isLastShot: shotCount === totalShots })
      errors.push(...res.errors)
      warnings.push(...res.warnings)
      fixed.push(...res.fixed)
      codedErrors.push(...(res.codedErrors || []))

      checkCutActionOverlap(prevShot, shot, warnings, label)
      checkActionDensity(shot, warnings, label)

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
    nonDiegeticMusic: row.non_diegetic_music || '',
    blockingPlan: parseObj(row.blocking_plan),
    videoPromptOverride: row.video_prompt_override || '',
    isCombat: row.is_combat,
  }
}
