/**
 * 导演核 · 观看事件抽取
 * ============================================================================
 * 把节拍文本 → 「观看事件」序列。
 *
 * 为什么需要这一层？
 * 因为切镜决策必须建立在一个**可比较的中间表示**上。直接拿中文句子去问
 * "这里该不该切"，答案必然随机——句子不是镜头，句子里的逗号也不是切点。
 *
 * 观看事件 = (主体, 动作类, 对象, 结果) 四元组，它同时携带三个可计算的量：
 *   · 自然信息半径 → 决定这一事件"看不看得清"需要多近
 *   · 自然时长     → 决定这一事件"发生完"需要多久
 *   · 张力标记     → 危险 / 发现 / 新主体，决定它是否有资格触发切镜
 *
 * 抽到事件之后，"切不切"就变成一个几何问题，而不是文学问题。
 */

import { ACTION_LEXICON, ACTION_CLASSES, DANGER_MARKERS, DISCOVERY_MARKERS, DURATION } from './ontology.js'

/** 言语动词：用来判断"哪一拍是真正开口的那一拍" */
const SPEAK_VERB_RE = new RegExp(ACTION_CLASSES.speak.words.filter((w) => w.length >= 1).join('|'))

/* ==========================================================================
 * 事件抽取主入口
 * ========================================================================== */

/**
 * @param {Object} scene parseScreenplay 产出的场次对象
 * @param {Object} [ctx]   { knownCharacters: string[] }
 * @returns {Array<ViewEvent>}
 */
export function extractViewEvents(scene, ctx = {}) {
  const known = buildSubjectRoster(scene, ctx)
  const events = []
  const seenSubjects = new Set()
  let carrySubject = known[0] || ''

  /* ---- 1. 台词分配 ----
     两轮绑定，因为「谁在哪一拍开口」决定了这个镜头是不是一个"发言镜头"：
       第一轮：这一拍既提到该角色、又含言语动词（喊/说/问/答…）—— 这才是真正开口的那一拍。
       第二轮：只提到该角色但没有言语动词 —— 退而求其次。
     两轮都没绑上的一律留给末尾，绝不丢弃：丢一句台词就是丢一条信息。 */
  const linePool = (scene.lines || []).map((l) => ({ ...l, _used: false }))
  const beatLineMap = new Map()
  const bind = (b, l) => {
    if (!beatLineMap.has(b.index)) beatLineMap.set(b.index, [])
    beatLineMap.get(b.index).push(l)
    l._used = true
  }
  for (const requireCue of [true, false]) {
    for (const b of scene.beats || []) {
      if (requireCue && !b.cue) continue
      for (const l of linePool) {
        if (l._used) continue
        // 第一轮：必须命中"这个角色的台词位"（按原文位置，不靠猜）
        if (requireCue) { if (b.cue !== l.character) continue }
        else { if (!l.character || !b.text.includes(l.character)) continue }
        bind(b, l)
      }
    }
  }
  const orphanLines = linePool.filter((l) => !l._used)

  /* ---- 2. 逐节拍抽事件 ---- */
  for (const beat of scene.beats || []) {
    const clauses = splitClauses(beat.text)
    for (const clause of clauses) {
      const parts = segmentByVerbs(clause)
      for (const part of parts) {
        const ev = buildEvent(part, {
          beatIndex: beat.index,
          known,
          carrySubject,
          seenSubjects,
          ctx,
        })
        if (!ev) continue
        carrySubject = ev.subject || carrySubject
        if (ev.subject && !seenSubjects.has(ev.subject)) {
          seenSubjects.add(ev.subject)
          ev.isNewSubject = true
        }
        events.push(ev)
      }
    }
    /* 台词：作为独立事件紧随本拍 —— 说话本身就是一次"观看事件" */
    const bound = beatLineMap.get(beat.index) || []
    for (const l of bound) {
      events.push(lineEvent(l, beat.index, carrySubject, seenSubjects))
      if (!seenSubjects.has(l.character)) seenSubjects.add(l.character)
    }
  }

  /* ---- 3. 无主台词：按顺序补在末尾，不丢弃 ---- */
  for (const l of orphanLines) {
    events.push(lineEvent(l, (scene.beats || []).length, carrySubject, seenSubjects))
  }

  /* ---- 4. 空事件兜底：一个事件都没有时，整场正文当一个环境事件 ---- */
  if (!events.length) {
    events.push({
      id: 'E0',
      beatIndex: 1,
      subject: '',
      cls: 'environment',
      verb: '',
      object: '',
      radius: ACTION_CLASSES.environment.radius,
      duration: ACTION_CLASSES.environment.duration,
      danger: false,
      discovery: false,
      isNewSubject: false,
      text: String(scene.body || scene.title || '').trim(),
      source: 'fallback',
    })
  }

  return events.map((e, i) => ({ ...e, id: `E${String(i + 1).padStart(2, '0')}` }))
}

/* ==========================================================================
 * 分句与分段
 * ========================================================================== */

/** 节拍 → 小句。顿号不断句（顿号两侧通常是同一动作的两个宾语） */
function splitClauses(text) {
  return String(text || '')
    .split(/[，,。！？!?；;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * 小句按动作词切成若干段。
 * 「站起来喊一二」→ [站起](move) + [喊一二](speak)：这是两个动作，两笔时长账。
 * 一句话里有几个动作词，就有几个事件；合并与否是切镜层的事，不是这里的事。
 */
function segmentByVerbs(clause) {
  const hits = findAllVerbs(clause)
  /* 没有动作词的小句，要分成两种命运：
       · 长句 = 空间在交代什么（「谷底那座横跨河面的腐朽木桥正对着他们」）→ 环境事件，值得一个远镜；
       · 短句 = 时间或方位的标记（「翌日清晨」「站到」「四下白茫茫」）→ **不是事件**。
     后者占一个镜头就是废镜：观众看不见任何人做任何事，只会觉得片子卡了一下。
     以前它们被一律当成 state 事件（半径 3.0 / 时长 1.6s），于是每句时间状语
     都能凭空长出一个中景镜头 —— 这是过切的第二条隐蔽路径。 */
  if (!hits.length) {
    if (clause.replace(/[^\u4e00-\u9fa5]/g, '').length < 6) return []
    return [{ text: clause, verb: '', cls: 'environment', from: 0 }]
  }

  const segs = []
  let cursor = 0
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i]
    const nextStart = i + 1 < hits.length ? hits[i + 1].index : clause.length
    const segText = clause.slice(cursor, nextStart).trim()
    segs.push({ text: segText, verb: h.word, cls: h.cls, from: cursor })
    cursor = nextStart
  }
  const tail = clause.slice(cursor).trim()
  if (tail) segs[segs.length - 1].text = `${segs[segs.length - 1].text}${tail}`
  return segs.filter((s) => s.text)
}

/** 找出小句里所有动作词的位置，长词优先、不重叠 */
function findAllVerbs(clause) {
  const taken = new Array(clause.length).fill(false)
  const hits = []
  for (const entry of ACTION_LEXICON) {
    let from = 0
    for (;;) {
      const idx = clause.indexOf(entry.word, from)
      if (idx < 0) break
      const end = idx + entry.word.length
      let free = true
      for (let i = idx; i < end; i++) if (taken[i]) { free = false; break }
      if (free) {
        for (let i = idx; i < end; i++) taken[i] = true
        hits.push({ word: entry.word, cls: entry.cls, index: idx })
      }
      from = idx + 1
    }
  }
  return hits.sort((a, b) => a.index - b.index)
}

/* ==========================================================================
 * 事件构造
 * ========================================================================== */

function buildEvent(seg, { beatIndex, known, carrySubject, seenSubjects, ctx }) {
  const text = String(seg.text || '').trim()
  if (!text) return null

  /* 纯时间/地点状语不是动作。
     「翌日清晨」「午后」「这时」这类片段没有动词，也不会有主体 ——
     它们描述的是"什么时候"，不是"发生了什么"。放它们进事件序列，
     就会凭空长出一个没有人、没有事、却占满一个镜头的空事件。
     判据：无动词 + 长度短 + 以时间词开头或全部由时间词构成。 */
  if (!seg.verb && text.length <= 10 && TIME_ADVERBIAL_RE.test(text) && !known.some((n) => n && text.includes(n))) {
    return null
  }

  const cls = seg.cls in ACTION_CLASSES ? seg.cls : 'state'
  const def = ACTION_CLASSES[cls]

  const subject = pickSubject(text, seg.from, seg.verb, known, carrySubject)
  const object = pickObject(text, seg.verb)
  // 宾语若命中名册，说明这一动作指向了另一个在场主体（如「喊一二」）——
  // 它直接决定本镜是否该把两个人放进同一个画面
  const recipient = object && known.includes(object) ? object : ''
  // 危险判定必须同时满足「有威胁词」+「这件事正在发生」。
  // 否则「断桥横跨在河面上方」会因为是静态事实而被当成威胁，
  // 一集里就会多出十几个"让观众亲眼看见威胁"的假警告镜头。
  const dangerWord = DANGER_MARKERS.some((w) => text.includes(w))
  const danger = dangerWord && DANGER_MOTION_RE.test(text)
  const discovery = DISCOVERY_MARKERS.some((w) => text.includes(w))

  // 张力词会把事件的信息半径拉近、时长拉长：危险必须先被清楚地看见
  const radius = danger ? Math.min(def.radius, 3.0) : def.radius
  const duration = def.duration * (danger ? 1.25 : 1) * (discovery ? 1.1 : 1)

  return {
    id: '',
    beatIndex,
    subject,
    cls,
    verb: seg.verb || '',
    object,
    recipient,
    radius,
    duration: round2(duration),
    danger,
    discovery,
    isNewSubject: false,
    hasOwnSubject: !!subject && subject !== carrySubject,
    text,
    source: 'beat',
  }
}

/**
 * 主体判定。三步降级，每一步都比下一步更可信：
 *   ① 名册命中 —— 动作词之前最近的一个已知主体名（最可信）
 *   ② 削功能字 —— 把动词前的片段里的虚词削掉，剩下 1–3 个实义字就是主体
 *      （「浪已经拍」→「浪」；中文里非人主体常这么出现）
 *   ③ 段首短词 —— 段首 2–3 字、既无功能字也不是动作词，才敢当人名用
 *      （这道闸门很关键：「站起来喊」的段首是「站起来」，它不是人，它是动作）
 *   ③ 都不成立时承接上一事件的主语（中文主语常承前省略）
 */
function pickSubject(text, from, verb, known, carrySubject) {
  const verbAt = verb ? text.indexOf(verb) : -1
  const before = verbAt >= 0 ? text.slice(0, verbAt) : ''

  /* ① 名册命中（精确优先，其次简称包含：「大白」→「大白熊」） */
  const hit = matchRoster(before, known)
  if (hit) return hit

  /* ② 代词承接。他/她/它 必须有先行词，所以只能承接上一个主体。
        这一条**取代**了原来"从文本里抠一个 2–3 字当人名"的做法 ——
        那个做法会把「其中一段」「翌日清晨」「一块碎石」统统变成人名，
        每假造出一个人，就多骗出一刀切镜，最后一集 8 场长出 166 个镜头。 */
  if (/(他们|她们|它们|他|她|它|祂)/.test(before)) return carrySubject || ''

  /* ③ 无名、无姓、无代词 —— 那就是没有可指认的观看主体
        （环境、时间、方位、泛称）。返回空串：planner 对无主体事件
        既不算"新主体"收益，也不算关系位移，因此不会凭空切镜。 */
  return ''
}

/** 名册匹配：先找完整名字，再找简称前缀（「大白」→「大白熊」）。找不到返回空串。 */
function matchRoster(text, known) {
  if (!text || !known || !known.length) return ''
  let best = ''
  for (const name of known) {
    if (name && text.includes(name) && name.length > best.length) best = name
  }
  if (best) return best
  // 简称：正文里常写「大白」指「大白熊」。只在 3 字及以上的名字上做，避免 2 字名误配。
  for (const name of known) {
    if (!name || name.length < 3) continue
    for (let n = name.length - 1; n >= 2; n--) {
      if (text.includes(name.slice(0, n))) { if (name.length > best.length) best = name; break }
    }
  }
  return best
}

const FUNCTION_CHARS_RE = /[的了着过是在有和与把被给从对向到又只都也还很就才而且但如若不没为以们这那已经将正会能要想使让被]/
const FUNCTION_CHARS_RE_G = /[的了着过是在有和与把被给从对向到又只都也还很就才而且但如若不没为以们这那已经将正会能要想使让被]/g

/** 身体部位：出现在动词前时，它是上一个主体的动作载体，不是新的观看主体 */
const BODY_PARTS = new Set(['脚', '手', '头', '眼', '脸', '心', '背', '肩', '腿', '腰', '臂', '掌', '指', '膝', '身'])

/** 威胁必须"正在发生"。静态描述（横跨 / 挂着 / 立着）不构成威胁。 */
const DANGER_MOTION_RE = /(滚|落|砸|撞|裂|崩|塌|坠|扑|冲|涌|袭|逼|追|退|晃|摇|碎|倒|沉|爆|燃|烧|溅|甩|卷|拽|抛|飞|滑|猛地|忽然|突然|一下)/

/** 纯时间状语：它描述"什么时候"，不描述"发生了什么" */
const TIME_ADVERBIAL_RE = /^(翌日|次日|第二天|当天|清晨|早晨|上午|正午|中午|午后|下午|傍晚|黄昏|入夜|夜幕|夜里|深夜|凌晨|黎明|这时|此时|片刻|半晌|许久|良久|后来|随后|转眼|不久|过了一会儿)/

/** 宾语判定：动作词之后最长的名词性片段（去掉助词与标点） */
function pickObject(text, verb) {
  if (!verb) return ''
  const i = text.indexOf(verb)
  if (i < 0) return ''
  let tail = text.slice(i + verb.length)
  tail = tail.replace(/^[了着过掉好到再又就都也还只把被给和与及、]+/, '')
  const m = tail.match(/^[\u4e00-\u9fa5A-Za-z0-9]{1,12}/)
  return m ? m[0] : ''
}

function lineEvent(line, beatIndex, carrySubject, seenSubjects) {
  const chars = Math.max(1, String(line.text || '').replace(/[「」『』"“”\s]/g, '').length)
  const speechDur = chars / DURATION.charsPerSecond + DURATION.linePadding
  return {
    id: '',
    beatIndex,
    subject: line.character || carrySubject || '',
    cls: 'speak',
    verb: '说',
    object: '',
    radius: ACTION_CLASSES.speak.radius,
    duration: round2(Math.max(ACTION_CLASSES.speak.duration, speechDur)),
    danger: false,
    discovery: false,
    isNewSubject: !!(line.character && !seenSubjects.has(line.character)),
    hasOwnSubject: !!line.character,
    line: { character: line.character || '', tone: line.tone || '', text: line.text || '' },
    text: `${line.character || '—'}：${line.text || ''}`,
    source: 'line',
  }
}

/* ==========================================================================
 * 可用主体名册
 * ========================================================================== */

export function buildSubjectRoster(scene, ctx = {}) {
  const out = []
  const add = (n) => {
    const s = String(n || '').trim()
    if (s && s.length <= 8 && !out.includes(s)) out.push(s)
  }
  /* 名册只收**权威来源**。
     这里刻意不收 actionLines / props.owner —— 它们本身是推断产物，
     而推断用的 n-gram 会把「谷底」「悬崖」「浮冰」这类环境名词也当成主体。
     一旦它们进了名册，pickSubject 就会名正言顺地把它们当人名接受，
     于是每出现一个假人，planner 就多算一次「新主体」收益、多切一刀。
     名册污染是过切最隐蔽的一条路径：链条是
       frequentSubjects → principals → actionLines.subject → 名册
     在这里斩断它。 */
  for (const c of ctx.knownCharacters || []) add(typeof c === 'string' ? c : c?.name)
  for (const l of scene.lines || []) add(l.character)
  if (scene.axis?.a) add(scene.axis.a)
  if (scene.axis?.b) add(scene.axis.b)
  // 长名优先匹配，避免短名抢走长名
  return out.sort((a, b) => b.length - a.length)
}

const round2 = (n) => Math.round(n * 100) / 100
