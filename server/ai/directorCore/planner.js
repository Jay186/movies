/**
 * 导演核 · 切镜与运镜规划器
 * ============================================================================
 * 这里是整个内核的心脏。它做的唯一一件事：
 *   把「观看事件序列」变成「镜头序列」，并把每一个决定都留下可审计的理由。
 *
 * 与"让大模型自由发挥"的根本区别：
 *   切不切镜、怎么运、给多长、站哪一侧 —— 全部由确定性规则给出。
 *   同剧本两次运行，结果**逐字相同**。LLM 不参与任何决定，只负责把结果写成文字。
 *
 * 五步走（每一步的产物都可单独检查）：
 *   A. 分组 —— 按注意力五维位移 + 收益闸门决定镜头边界
 *   B. 复核 —— 合并最不该切的那一刀；拆开不得不拆的长镜
 *   C. 取景 —— 由事件自身的信息半径推出景别/朝向/归属，不由导演偏好决定
 *   D. 运镜 —— 从"这一镜内部要发生什么变化"反推摄影机是否必须动
 *   E. 状态链 —— 每镜算出入口/出口状态，出口即下一镜入口；轴线作为守恒量登记
 */

import {
  ACTION_CLASSES,
  CUT_GAIN_FLOOR,
  DURATION,
  MOVE_AMPLITUDE,
  MOVE_BY_KEY,
  MOVES,
  SIZE_ORDER,
  TONE_PROFILES,
  DEFAULT_TONE,
  VIEW_DIMENSIONS,
  FRAME_SIDE_EN,
  SIZE_ORDER as SHOT_SIZE_ORDER,
  sizeForRadius,
  sizeShift,
  resolveProfile,
} from './ontology.js'
import { extractViewEvents, buildSubjectRoster } from './events.js'

/* ==========================================================================
 * 入口
 * ========================================================================== */

/**
 * @param {Object} scene  parseScreenplay 的场次对象
 * @param {Object} [opts] { profile, assets, toneOverride }
 * @returns {{ shots: Array, diagnostics: Object }}
 */
export function planScene(scene, opts = {}) {
  const profile = typeof opts.profile === 'string' ? resolveProfile(opts.profile) : (opts.profile || resolveProfile('default'))
  const minShot = opts.minShot ?? Math.max(DURATION.min, profile.minShot)
  const maxShot = opts.maxShot ?? Math.min(DURATION.max, profile.maxShot)

  const roster = buildSubjectRoster(scene, { knownCharacters: opts.assets?.characters })
  const events = extractViewEvents(scene, { knownCharacters: opts.assets?.characters })

  /* ---------- A. 分组：确定镜头边界 ---------- */
  // 节拍号 → 段落号。段落是作者划分的镜头单位，是分组时最可靠的一条锚。
  const paraOfBeat = new Map((scene.beats || []).filter((b) => b.para !== undefined).map((b) => [b.index, b.para]))
  const raw = groupIntoShots(events, scene, { minShot, maxShot, roster, tone: toneAt(scene, 0), paraOfBeat })

  /* ---------- B. 复核：合并碎镜 / 拆分超长镜 ---------- */
  const repaired = repairBoundaries(raw, { minShot, maxShot, scene })

  /* ---------- C/D/E. 逐镜取景、运镜、状态链 ---------- */
  const shots = composeShots(repaired, scene, { roster, minShot, maxShot, toneCurve: scene.toneCurve || [DEFAULT_TONE], profile })

  const diagnostics = {
    sceneIndex: scene.index,
    eventCount: events.length,
    shotCount: shots.length,
    rawCutCount: raw.length - 1,
    mergedForMin: raw.length - repaired.length > 0 ? raw.length - repaired.length : 0,
    splitForMax: repaired.length - raw.length > 0 ? repaired.length - raw.length : 0,
    totalDuration: round2(shots.reduce((s, x) => s + x.duration, 0)),
    avgShot: round2(shots.reduce((s, x) => s + x.duration, 0) / (shots.length || 1)),
    moves: countBy(shots.map((s) => s.movement.key)),
    cutReasons: shots.filter((s) => s.cutIn).map((s) => ({ shot: s.id, total: s.cutIn.total, gates: s.cutIn.gates.map((g) => g.label) })),
    axis: shots.map((s) => ({ shot: s.id, side: s.framing.side, angle: s.framing.angle })),
    toneCurve: scene.toneCurve || [DEFAULT_TONE],
  }
  return { shots, events, diagnostics }
}

/* ==========================================================================
 * A. 分组：按「任务」切，不按时钟切
 * --------------------------------------------------------------------------
 * 一个镜头 = 一段任务：谁在什么空间里、为了什么目的、完成什么可见变化。
 * **镜头该多长，由这段任务自己需要多久决定。**
 * 单镜上限（15s）只是保险 —— 一段任务的自然时长实在装不下才拆。
 *
 * 因此这里既不做"塞满到 15 秒"的填充（那会把三段任务压成一个镜头），
 * 也不做"看到差异就切"的阈值判断（那会把一段任务切成碎片）。
 * 唯一的判据是：**这里是不是一次任务转移**。
 *
 * 构成任务转移的（可以落刀）：
 *   B1 危险出现，观众必须先看见
 *   B2 行动结束、进入反应（人做完了事，接下来是他的所见所感）
 *   B3 反应成形、重新行动
 *   B4 观看对象换人（同一空间里注意力从一个人移到另一个人）
 *   B5 时间断裂
 *
 * 不构成任务转移的（必须用运镜在镜内完成，不许落刀）：
 *   景别变化、角度变化、情绪起伏、同一主体的连续动作、环境描写。
 * ========================================================================== */

/** 明确的时间断裂标记：出现它才是"时间上跳了一段"，否则只是下一句 */
const TIME_JUMP_RE = /(翌日|第二天|次日|入夜|夜幕|黄昏|傍晚|清晨|正午|午后|过了|片刻|半晌|许久|良久|此时|这时|随后|后来|转眼|不久)/

function groupIntoShots(events, scene, ctx) {
  const groups = []
  let cur = null

  for (let i = 0; i < events.length; i++) {
    const ev = events[i]
    if (!cur) { cur = { members: [ev], gain: null }; groups.push(cur); continue }

    const verdict = isTaskBoundary(cur, ev, scene, ctx)
    // 单镜上限只做保险：这一段任务的自然时长实在装不下了才拆，
    // 而不是"还能再塞一个就继续塞"。镜头长度由内容决定，不由时钟决定。
    const overCeiling = durationOfGroup([...cur.members, ev], scene, ctx.tone) > ctx.maxShot

    // 段落边界：作者亲手划分的镜头单位。
    // 剧本的每一个自然段，是作者写下来时心里就已经成形的"一个镜头"——
    // 一段里可能有好几个动作（雾中下山：每一步都先点地、踩实、再压重心），
    // 但那些是**同一镜内的过程**，由表演和运镜完成，不是几个镜头。
    const para = ctx.paraOfBeat?.get(ev.beatIndex)
    const curPara = ctx.paraOfBeat?.get(cur.members[0].beatIndex)
    const paraBreak = para !== undefined && curPara !== undefined && para !== curPara

    if (verdict.cut || overCeiling || paraBreak) {
      cur = {
        members: [ev],
        gain: paraBreak && !verdict.cut && !overCeiling
          ? { total: 0, dims: [{ key: 'para', label: '段落边界', gain: 1, note: '作者在这里换段，等于换了一个镜头单位' }], gates: [], forced: null, reason: '段落边界' }
          : verdict.cut
            ? { total: verdict.total, dims: verdict.dims || [], gates: verdict.gates || [], forced: verdict.forced || null, reason: verdict.reason }
            : { total: 0, dims: [], gates: [], forced: 'maxShot', reason: '这一段任务的自然时长超过单镜上限，必须拆' },
      }
      groups.push(cur)
    } else {
      cur.members.push(ev)
    }
  }
  return groups
}

/**
 * 这一刀该不该落。默认不落。
 * @returns {{cut:boolean, total:number, dims?:Array, gates?:Array, forced?:string, reason:string|null}}
 */
/** 事件在「任务」层面的性质。
 *  act  = 行动：做一件事。任务的主体内容。
 *  react= 反应：看见 / 情绪。人做完事之后的注意力落点。
 *  hold = 状态：停住、保持。它是上一段动作的收尾，不构成新任务。
 *  setting = 环境：描述当前空间长什么样。它是镜头的背景层，不构成新任务。 */
const KIND_OF = {
  move: 'act', interact: 'act', speak: 'act',
  perceive: 'react', emotion: 'react',
  state: 'hold',
  environment: 'setting',
}

/** 反打类边界（换人、重新行动）需要镜头先"立住"一会儿，避免一秒钟里来回甩 */
const MIN_STANDING = 0.55   // 占单镜下限的比例

/**
 * 这一刀该不该落。
 *
 * 判据是**任务边界**，不是时长：一段"同一主体、同一意图"的连续内容就是一个镜头。
 * 镜头该多长，由这段内容自己需要多久决定 —— 该 6 秒就 6 秒，该 12 秒就 12 秒。
 * 单镜上限只做保险：一段任务实在装不下（自然时长超过上限）才拆。
 *
 * 不构成任务边界、因而必须用运镜在镜内完成的：
 *   景别变化、角度变化、情绪起伏、同一主体的连续动作、环境描写。
 */
function isTaskBoundary(group, ev, scene, ctx) {
  const members = group.members
  if (!members.length) return { cut: false, total: 0, reason: null }

  const kind = KIND_OF[ev.cls] || 'act'

  /* ---- 透明事件：既不开新任务，也不结束旧任务 ---- */
  // 环境描写是当前空间的背景层，不是一件"事"
  if (kind === 'setting') return { cut: false, total: 0, reason: null }
  // 停住 / 保持是上一段动作的收尾，归上一段
  if (kind === 'hold') return { cut: false, total: 0, reason: null }

  // 上一个"有内容"的事件，用来判断任务是否转向
  const prev = [...members].reverse().find((m) => {
    const k = KIND_OF[m.cls] || 'act'
    return k !== 'setting' && k !== 'hold'
  }) || members[members.length - 1]
  const prevKind = KIND_OF[prev.cls] || 'act'

  /* ---- B1 危险：新威胁出现，观众必须先看见它 ---- */
  if (ev.danger && !members.some((m) => m.danger)) {
    return {
      cut: true, total: 2.0, reason: '危险必须先被看见',
      gates: [{ key: 'danger', label: '新危险', gain: 1.3, note: `威胁出现：${ev.object || ev.text}，观众必须先看见它` }],
    }
  }

  const standing = durationOfGroup(members, scene, ctx.tone) >= ctx.minShot * MIN_STANDING

  /* ---- B2 行动结束、进入反应（最常见也最正当的一刀：
         人把事情做完了，接下来要看的是他看见了什么、反应如何） ---- */
  if (prevKind === 'act' && kind === 'react') {
    return {
      cut: true, total: 1.4, reason: '行动结束，进入反应',
      gates: [{ key: 'reaction', label: '独立反应', gain: 1.0, note: '动作已经完成，接下来要看的是人物的反应' }],
    }
  }

  /* ---- B3 反应成形、重新行动 ---- */
  if (prevKind === 'react' && kind === 'act' && standing) {
    return {
      cut: true, total: 1.2, reason: '反应结束，重新行动',
      gates: [{ key: 'result', label: '动作结果', gain: 1.0, note: '情绪已经成形，接下来是一个新动作' }],
    }
  }

  /* ---- B4 观看对象换人：注意力从一个人移到另一个人 ---- */
  if (ev.subject && prev.subject && ev.subject !== prev.subject && standing) {
    return {
      cut: true, total: 1.1, reason: '观看对象换人',
      gates: [{ key: 'subject', label: '新主体', gain: 1.0, note: `注意力从 ${prev.subject} 移到 ${ev.subject}` }],
    }
  }

  /* ---- B5 时间断裂 ---- */
  if (TIME_JUMP_RE.test(ev.text || '') && ev.beatIndex > prev.beatIndex) {
    return {
      cut: true, total: 1.0, reason: '时间上跳了一段',
      dims: [{ key: 'time', label: '时间', gain: 1.1, from: `节拍${prev.beatIndex}`, to: `节拍${ev.beatIndex}`, note: '时间出现断裂，需要重新建立' }],
    }
  }

  /* ---- 都不是边界 → 不切。
         景别、角度、情绪起伏、同一主体的连续动作，全部交给运镜在镜内完成。 */
  return { cut: false, total: 0, reason: null }
}

/**
 * 切镜收益评分。**不再用于决定切不切**（那由 shouldCut 的硬闸门决定），
 * 只用于"镜太长必须拆"时，挑出内部最该切的那条边界。
 */
function judgeCut(group, ev, scene, ctx, eventIndex) {
  const last = group.members[group.members.length - 1]
  const dims = dimensionShift(group, ev, scene)
  const gates = gateGains(group, ev, scene)

  const dimGain = dims.reduce((s, d) => s + d.gain, 0)
  const gateGain = gates.reduce((s, g) => s + g.gain, 0)
  const tone = ctx.tone || DEFAULT_TONE
  const toneBias = (TONE_PROFILES[tone]?.cutBias || 0)

  let total = dimGain + gateGain + toneBias

  /* --- 硬规则零：同一拍内的描写属于同一个连续时刻，默认不许切 ---
     一条节拍是剧本里最小的"同一时刻"单位。在同一个时刻里切镜，观众感到的是画面抖了一下，
     而不是"看到了新东西"。要切，必须拿出危险/发现这类硬收益来换。 */
  if (ev.beatIndex === last.beatIndex && !ev.danger && !ev.discovery) total -= 2.2

  /* --- 硬规则零之二：只有"距离"一维动了，就不用切，用推近/拉远完成 ---
     全景→特写是运镜能干的事。为了它切一刀，等于用切镜去做运镜的活。 */
  if (dims.length === 1 && dims[0].key === 'distance') total -= 2.5

  /* --- 硬规则一：连续任务优先（同一主体、同一空间、同一目的的连续动作，优先一镜到底） --- */
  const sameSubject = ev.subject && ev.subject === dominantSubject(group)
  const chainable = ['move', 'state', 'interact'].includes(ev.cls)
  const noNewInfo = !ev.danger && !ev.discovery && !ev.line && !ev.isNewSubject
  if (sameSubject && chainable && noNewInfo && group.members.length <= 2) {
    // 连续动作不是切镜的理由，只是运镜的理由
    total -= 1.2
  }

  /* --- 硬规则二：危险必须先被看见 --- */
  if (ev.danger && !group.members.some((m) => m.danger)) {
    total += 2.0
  }

  /* --- 硬规则三：景别落差过大（信息尺度根本不同）必然要切 --- */
  const widest = Math.max(...group.members.map((m) => m.radius))
  if (sizeShift(sizeForRadius(widest), sizeForRadius(ev.radius)) >= 3) total += 2.0

  return {
    cut: total >= CUT_GAIN_FLOOR,
    total: round2(total),
    dims,
    gates,
  }
}

/** 五维位移：逐维算"这一维动了多少" */
function dimensionShift(group, ev, scene) {
  const out = []
  const members = group.members
  const last = members[members.length - 1]

  // 距离
  const anchorSize = sizeForRadius(meanRadius(members))
  const evSize = sizeForRadius(ev.radius)
  const dShift = sizeShift(anchorSize, evSize)
  if (dShift > 0) {
    out.push({
      key: 'distance', label: '距离', gain: dShift * 0.75,
      from: anchorSize, to: evSize,
      note: `${anchorSize} → ${evSize}，观众与对象的距离发生了 ${dShift} 档变化`,
    })
  }

  // 角度：主体位移方向改变机位落点
  const evAngleWish = wishAngle(last, ev)
  if (evAngleWish.changed) {
    out.push({ key: 'angle', label: '角度', gain: VIEW_DIMENSIONS.find((d) => d.key === 'angle').width, from: evAngleWish.from, to: evAngleWish.to, note: evAngleWish.note })
  }

  // 归属：从客观变成某个角色的眼睛，或反过来
  if (last.cls !== 'perceive' && ev.cls === 'perceive' && ev.object) {
    out.push({ key: 'ownership', label: '归属', gain: VIEW_DIMENSIONS.find((d) => d.key === 'ownership').width, from: '客观', to: `${ev.subject || '某人'}的眼睛`, note: '观众的视线被交还给一个角色' })
  }

  // 关系：入画主体集合改变
  const prevSet = subjectSet(members)
  const nextSet = subjectSet([ev])
  if (!sameSet(prevSet, nextSet) && nextSet.length) {
    const added = nextSet.filter((x) => !prevSet.includes(x))
    const removed = prevSet.filter((x) => !nextSet.includes(x))
    out.push({
      key: 'relation', label: '关系', gain: added.length ? 1.4 : 1.1,
      from: prevSet.join('+') || '—', to: nextSet.join('+'),
      note: added.length ? `${added.join('、')} 进入观看范围` : `${removed.join('、')} 离开画面`,
    })
  }

  // 时间：节拍大幅跳跃（换拍且非承接）
  if (ev.beatIndex - last.beatIndex >= 2) {
    out.push({ key: 'time', label: '时间', gain: 1.1, from: `节拍${last.beatIndex}`, to: `节拍${ev.beatIndex}`, note: '中间跳过了一个节拍，时间上出现断裂' })
  }

  return out
}

/** 收益闸门 */
function gateGains(group, ev, scene) {
  const out = []
  const members = group.members
  const has = (pred) => members.some(pred)

  if (ev.isNewSubject && !has((m) => m.subject === ev.subject)) {
    out.push({ key: 'subject', label: '新主体', gain: 1.0, note: `${ev.subject} 本场首次进入观看` })
  }
  if (ev.cls === 'environment' && !has((m) => m.cls === 'environment')) {
    out.push({ key: 'space', label: '新空间', gain: 1.0, note: '揭开了一块此前不在画面里的空间' })
  }
  if (ev.discovery && !has((m) => m.discovery)) {
    out.push({ key: 'information', label: '新信息', gain: 1.1, note: `发现：${ev.object || ev.text}` })
  }
  if (ev.danger && !has((m) => m.danger)) {
    out.push({ key: 'danger', label: '新危险', gain: 1.3, note: `威胁出现：${ev.object || ev.text}，观众必须先看见它` })
  }
  if (ev.cls === 'emotion' && ev.subject && !members.some((m) => m.subject === ev.subject && m.cls === 'emotion')) {
    out.push({ key: 'reaction', label: '独立反应', gain: 0.9, note: `${ev.subject} 的情绪需要一个被单独观看的镜头` })
  }
  if (ev.cls === 'interact' && ev.object) {
    out.push({ key: 'relation', label: '关系改变', gain: 1.2, note: `发生了一次真实的接触：${ev.text}` })
  }
  if (ev.cls === 'speak' && ev.line && ev.subject && ev.subject !== dominantSubject(group)) {
    out.push({ key: 'subject', label: '新主体', gain: 1.0, note: '发言权易手，需要把视线交给说话的人' })
  }
  // 动作结果：上一组以动作结尾，本事件是它的可见结果
  const last = members[members.length - 1]
  if (['move', 'interact'].includes(last.cls) && ['state', 'emotion'].includes(ev.cls) && ev.subject === last.subject) {
    out.push({ key: 'result', label: '动作结果', gain: 1.0, note: '上一动作的可见结果需要被单独读到' })
  }
  return out
}

/* ==========================================================================
 * B. 复核：合并最不该切的那一刀 / 拆分不得不拆的长镜
 * ========================================================================== */

function repairBoundaries(groups, { minShot, maxShot, scene }) {
  let out = groups.map((g) => ({ ...g, members: [...g.members] }))
  const ctx = { tone: toneAt(scene, 0) }

  /* --- 合并：时长不足 minShot 的镜头，并入"切镜收益最低"的那一侧 --- */
  let guard = 0
  while (guard++ < 64) {
    const dur = out.map((g) => durationOfGroup(g.members, scene, ctx.tone))
    const i = dur.findIndex((d) => d < minShot && out.length > 1)
    if (i < 0) break

    // 这个碎镜的左右两侧，哪个切点的收益更低，就往哪边并
    const leftGain = i > 0 ? (out[i].gain?.total ?? 0) : Infinity
    const rightGain = i < out.length - 1 ? (out[i + 1].gain?.total ?? 0) : Infinity
    const target = leftGain <= rightGain ? i - 1 : i + 1
    if (target < 0 || target >= out.length) break

    const merged = mergeGroups(out[target], out[i])
    const next = out.filter((_, k) => k !== i && k !== target)
    next.splice(Math.min(target, i), 0, merged)
    out = next
  }

  /* --- 拆分：超出 maxShot 的镜头，在最该切的内部边界切开 --- */
  guard = 0
  while (guard++ < 64) {
    const dur = out.map((g) => durationOfGroup(g.members, scene, ctx.tone))
    const i = dur.findIndex((d) => d > maxShot)
    if (i < 0) break
    const g = out[i]
    if (g.members.length < 2) break

    // 找内部收益最高的边界（即"本来就是两个任务"）
    let bestCut = -1
    let bestScore = -Infinity
    for (let k = 0; k < g.members.length - 1; k++) {
      const sub = { members: g.members.slice(0, k + 1), gain: null }
      const v = judgeCut(sub, g.members[k + 1], scene, ctx, k + 1)
      const clsShift = g.members[k].cls !== g.members[k + 1].cls ? 0.4 : 0
      const score = v.total + clsShift
      if (score > bestScore) { bestScore = score; bestCut = k }
    }
    if (bestCut < 0) break

    const a = { members: g.members.slice(0, bestCut + 1), gain: g.gain }
    const b = { members: g.members.slice(bestCut + 1), gain: { forced: 'maxShot', total: round2(bestScore), dims: [], gates: [] } }
    out.splice(i, 1, a, b)
  }

  return out
}

function mergeGroups(a, b) {
  const members = [...a.members, ...b.members].sort((x, y) => (x.beatIndex - y.beatIndex) || 0)
  return { members, gain: a.gain }
}

/* ==========================================================================
 * C/D/E. 逐镜组装
 * ========================================================================== */

export function composeShots(groups, scene, ctx) {
  const shots = []
  let prevExit = initialSceneState(scene, ctx)
  let prevAngle = ''
  let currentSide = scene.axis?.a ? 'A侧' : '无轴线'
  let sideChangedSinceNeutral = false

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]
    const tone = toneAt(scene, g.members[0]?.beatIndex || 1)
    const isFirstInScene = i === 0

    /* ---- 取景 ---- */
    const subjects = subjectSet(g.members)
    const ownership = designOwnership(g.members, subjects, isFirstInScene)
    let angle = designAngle(g.members, scene, { prevAngle, isFirstInScene, ownership, subjects })

    /* ---- 运镜 ---- */
    const movement = designMovement(g.members, { scene, tone, isFirstInScene, angle })

    /* ---- 轴线侧位（在取景定下之后才能算）---- */
    let side = designAxisSide({ angle, subjects, scene, currentSide })
    // 防越轴：侧位翻转且中间没有中性镜时，自动插入一个中性机位而不是放任跳轴
    if (side !== currentSide && currentSide !== '无轴线' && side !== '轴上' && !sideChangedSinceNeutral && i > 0) {
      angle = '正面'
      side = '轴上'
    }
    if (side === '轴上' || side === '无轴线') sideChangedSinceNeutral = true
    else if (side !== currentSide) { sideChangedSinceNeutral = false; currentSide = side }
    else if (side === currentSide) { /* 同侧，无变化 */ }

    /* ---- 时长 ---- */
    const duration = durationOfGroup(g.members, scene, tone, movement)
    const clamped = clamp(duration, ctx.minShot, ctx.maxShot)

    /* ---- 状态链 ---- */
    const entry = cloneState(prevExit)
    const exit = advanceState(entry, g.members, scene)
    // 出口侧位必须与本镜取景一致：取景是"观众站哪"，状态是"人站哪"
    applyFrameSides(exit, subjects, scene, side)

    /* ---- 台词 / 音频 / 资产 ---- */
    const lines = g.members.filter((m) => m.line).map((m) => m.line)

    shots.push({
      id: `${scene.index}-${i + 1}`,
      sceneIndex: scene.index,
      index: i + 1,
      intent: buildIntent(g.members, subjects),
      members: g.members.map((m) => m.id),
      framing: { size: sizeForRadius(meanRadius(g.members)), angle, ownership, side },
      movement,
      duration: round2(clamped),
      entry,
      exit,
      beats: buildBeats(g.members, clamped),
      lines,
      audio: suggestAudio(g.members, scene, tone),
      assets: collectAssets(g.members, scene, ctx),
      cutIn: g.gain && g.gain.total > 0
        ? { total: g.gain.total, dims: g.gain.dims || [], gates: g.gain.gates || [], forced: g.gain.forced || null }
        : null,
      tone,
      provenance: scene.provenance,
    })

    prevExit = exit
    prevAngle = angle
  }

  return retime(shots)
}

/* ==========================================================================
 * 取景设计
 * ========================================================================== */

function designOwnership(members, subjects, isFirstInScene) {
  const perception = members.find((m) => m.cls === 'perceive' && m.object)
  // 主观镜必须有"谁的眼睛"。说不清是谁在看，就不是主观镜，老老实实客观 ——
  // 否则会产出「主观:」这种空的观看归属，下游拿它锁不住任何东西。
  if (perception && perception.subject && subjects.length === 1 && !isFirstInScene) {
    return `主观:${perception.subject}`
  }
  return '客观'
}

function designAngle(members, scene, { prevAngle, isFirstInScene, ownership, subjects }) {
  if (String(ownership).startsWith('主观')) return '主观'
  const dominant = dominantEvent(members)
  const two = subjects.length >= 2

  if (!two) {
    if (dominant.cls === 'move' && /(离|出|走|逃|退|奔|远)/.test(dominant.text)) return '背面'
    if (dominant.cls === 'emotion' || dominant.cls === 'speak') return '正面'
    if (dominant.cls === 'environment') return '侧面'
    return isFirstInScene ? '侧面' : '正面'
  }

  if (dominant.danger) return '过肩'
  if (/对|面|喊|问|答|递|接|抱|拉|看|望|说/.test(dominant.text)) return prevAngle === '过肩' ? '正面' : '过肩'
  return isFirstInScene ? '侧面' : '侧面'
}

/* ==========================================================================
 * 运镜设计
 * --------------------------------------------------------------------------
 * 唯一判据：**这一镜内部的变化，需要摄影机动，还是只需要被看着？**
 * 需要动 → 从动机表里挑一个合法的运镜。
 * 不需要 → 固定，并把"为什么不动的理由"记下来。
 * ========================================================================== */

function designMovement(members, { scene, tone, isFirstInScene, angle }) {
  const dominant = dominantEvent(members)
  const profile = TONE_PROFILES[tone] || TONE_PROFILES[DEFAULT_TONE]
  const radius0 = members[0].radius
  const radiusN = members[members.length - 1].radius

  const candidates = []

  /* 1) 主体在镜内持续位移 → 必须跟随，否则主体会走出画 */
  const moving = members.filter((m) => m.cls === 'move')
  if (moving.length && moving.some((m) => /(奔|跑|追|逃|冲|滑|游|飞)/.test(m.text))) {
    candidates.push({ key: '跟拍', motive: '主体持续位移', note: '主体在镜内移动，摄影机不跟就会失位' })
  }
  /* 2) 镜内信息半径收紧 → 推近 */
  if (sizeShift(sizeForRadius(radius0), sizeForRadius(radiusN)) >= 1 && radiusN < radius0) {
    candidates.push({ key: '推近', motive: '注意收拢', note: '从较宽的处境收到一处细节，观众需要被带着靠近' })
  }
  /* 3) 镜内信息半径放开 → 拉远 */
  if (sizeShift(sizeForRadius(radius0), sizeForRadius(radiusN)) >= 1 && radiusN > radius0) {
    candidates.push({ key: '拉远', motive: '揭示环境', note: '先把注意力放在局部，再交出局部所在的世界' })
  }
  /* 4) 新危险在同一镜内被察觉 → 摇到它 */
  if (dominant.danger && members.length > 1) {
    candidates.push({ key: '横摇', motive: '揭示画外之物', note: '威胁在画外，需要摇过去让观众自己看见' })
  }
  /* 5) 双主体关系在本镜内重组 → 环绕 */
  const two = new Set(members.map((m) => m.subject).filter(Boolean)).size >= 2
  if (two && members.some((m) => m.cls === 'interact')) {
    candidates.push({ key: '环绕', motive: '关系重组', note: '接触改变了彼此的相对位置，环绕能持续说明谁在谁身后' })
  }
  /* 6) 紧张/危险基调 → 取消稳定 */
  if (['紧张', '危险', '爆发'].includes(tone) && members.length >= 2) {
    candidates.push({ key: '手持', motive: '危险临近', note: '基调要求观众失去稳定感' })
  }
  /* 7) 本场第一镜且是环境/大空间开场 → 交代大势用升降 */
  if (isFirstInScene && dominant.cls === 'environment' && ['紧张', '危险', '压抑'].includes(tone)) {
    candidates.push({ key: '升降', motive: '交代大势', note: '开场需要先说明人物在世界里的位置' })
  }
  /* 8) 作者在场次头写了景别走向（如「中景 → 大全景」）→ 照它的方向推/拉
        这是剧本作者的意图，优先级高于内核的默认判断：他写"中景 → 大全景"，
        就是要在这一场里把观众从人身上放开到整片环境。 */
  if (isFirstInScene && Array.isArray(scene.sizePlan) && scene.sizePlan.length === 2) {
    const [from, to] = scene.sizePlan.map((x) => SHOT_SIZE_ORDER.indexOf(x))
    if (from >= 0 && to >= 0 && from !== to) {
      if (to > from) candidates.push({ key: '拉远', motive: '揭示环境', note: `作者在场次头指定了景别走向「${scene.sizePlan.join(' → ')}」，本场要从局部放开到整体` })
      else candidates.push({ key: '推近', motive: '注意收拢', note: `作者在场次头指定了景别走向「${scene.sizePlan.join(' → ')}」，本场要从整体收拢到局部` })
    }
  }

  if (!candidates.length) {
    return {
      key: '固定',
      en: MOVE_BY_KEY['固定'].en,
      amplitude: null,
      axis: null,
      motivation: '静观：本镜没有需要摄影机参与的变化，让场面自己成立',
      curve: 'hold',
      alternatives: [],
      considered: MOVES.length,
    }
  }

  /* 在候选里挑一个：优先基调偏好的运镜，其次按"心理功能强度" */
  candidates.sort((a, b) => scoreMove(b, profile) - scoreMove(a, profile))
  const picked = candidates[0]
  const def = MOVE_BY_KEY[picked.key]
  const amplitude = pickAmplitude(members, picked.key)

  return {
    key: picked.key,
    en: def.en,
    amplitude,
    axis: /横移|跟拍|推近|拉远|环绕/.test(picked.key) ? '沿轴线' : null,
    motivation: `${picked.motive}：${picked.note}`,
    curve: `${def.ease || 'hold'}`,
    alternatives: candidates.slice(1).map((c) => `${c.key}（备选动机：${c.motive}）`),
    considered: MOVES.length,
  }
}

function scoreMove(cand, profile) {
  const def = MOVE_BY_KEY[cand.key]
  const preferred = profile.prefer.includes(cand.key) ? 2 : 0
  // 动机强度：危险/揭示类动机优先级高于伴随类
  const strength = { 危险临近: 3, 揭示画外之物: 2.6, 关系重组: 2.2, 揭示环境: 2, 注意收拢: 2, 主体持续位移: 1.8, 交代大势: 1.6 }[cand.motive] || 1
  return preferred + strength + (def.cost * 0.1)
}

function pickAmplitude(members, key) {
  const internal = members.length
  if (key === '甩镜' || key === '变焦') return '小'
  if (internal >= 4) return '大'
  if (internal >= 2) return '中'
  return '小'
}

/* ==========================================================================
 * 轴线
 * ========================================================================== */

function designAxisSide({ angle, subjects, scene, currentSide }) {
  if (!scene.axis?.a || !scene.axis?.b) return '无轴线'
  if (subjects.length < 2) return '轴上'
  if (['正面', '背面', '主观'].includes(angle)) return '轴上'
  // 过肩：前景肩属于谁，摄影机就在谁那一侧
  if (angle === '过肩') return currentSide === 'A侧' ? 'A侧' : 'B侧'
  // 侧面：并置观察，不改变侧位
  return currentSide
}

/* ==========================================================================
 * 时长模型
 * ========================================================================== */

export function durationOfGroup(members, scene, tone, movement = null) {
  const profile = TONE_PROFILES[tone] || TONE_PROFILES[DEFAULT_TONE]
  let d = DURATION.settle + DURATION.linger
  for (const m of members) {
    d += m.duration
    if (m.line) d += 0 // 台词时长已含在事件时长里
  }
  if (movement && movement.key !== '固定') {
    const def = MOVE_BY_KEY[movement.key]
    const amp = MOVE_AMPLITUDE[movement.amplitude] || MOVE_AMPLITUDE['中']
    d += def.cost * amp.factor
  }
  d *= profile.scale
  return round2(d)
}

/* ==========================================================================
 * 状态链
 * ========================================================================== */

function initialSceneState(scene, ctx) {
  const state = { subjects: [], props: [], env: { anchor: scene.anchors?.[0] || '', light: scene.timeOfDay || '', space: scene.space || '' } }
  // 主体名册优先用剧本收敛出的 principals（最多三人），退回轴线两端
  const order = (scene.principals?.length ? scene.principals : [scene.axis?.a, scene.axis?.b]).filter(Boolean).slice(0, 3)
  order.forEach((name, i) => {
    state.subjects.push({
      name,
      side: FRAME_SIDE_EN[i === 0 ? 'left' : i === 1 ? 'right' : 'center'],
      posture: 'standing',
      facing: '',
      note: '场次开场时的初始站位',
    })
  })
  for (const p of scene.props || []) state.props.push({ name: p.name, holder: p.owner || '', state: 'in hand' })
  return state
}

/**
 * 推进状态：把本镜事件造成的状态变化写进 exit。
 * 这是状态链的意义所在——下一镜的入口就是这一镜的出口，
 * 连续性不需要靠"复刻上一镜最终画面"的祈祷，而是结构性成立。
 */
function advanceState(entry, members, scene) {
  const s = cloneState(entry)
  for (const m of members) {
    const subj = s.subjects.find((x) => x.name === m.subject)
    if (subj) {
      if (/坐/.test(m.text)) subj.posture = 'seated'
      else if (/躺|倒|卧/.test(m.text)) subj.posture = 'lying'
      else if (/站|起/.test(m.text)) subj.posture = 'standing'
      else if (/跑|奔/.test(m.text)) subj.posture = 'running'
      if (/转身|回头/.test(m.text)) subj.facing = 'turned'
    }
    // 道具易手必须有明确的交互事件才允许，否则不写（防止状态凭空改变）
    if (m.cls === 'interact' && m.object) {
      const prop = s.props.find((p) => m.object.includes(p.name))
      if (prop) {
        prop.holder = m.subject || prop.holder
        prop.state = /放|搁|置|落/.test(m.text) ? 'set down' : /举起|抬/.test(m.text) ? 'raised' : 'held'
      }
    }
    if (m.cls === 'environment' && m.object) {
      s.env.anchor = s.env.anchor || m.object
    }
  }
  return s
}

/** 出口状态的画面侧位必须与本镜取景一致 */
function applyFrameSides(state, subjectsInFrame, scene, side) {
  if (!scene.axis?.a || !scene.axis?.b) {
    state.subjects.forEach((s, i) => { s.side = FRAME_SIDE_EN[i === 0 ? 'left' : i === 1 ? 'right' : 'center'] })
    return
  }
  const [a, b] = [scene.axis.a, scene.axis.b]
  // 摄影机在 A 侧时：a 在画面左、b 在画面右；翻到 B 侧时左右互换 —— 这就是轴线的全部几何
  const flipped = side === 'B侧'
  for (const subj of state.subjects) {
    if (subj.name === a) subj.side = FRAME_SIDE_EN[flipped ? 'right' : 'left']
    else if (subj.name === b) subj.side = FRAME_SIDE_EN[flipped ? 'left' : 'right']
    else subj.side = FRAME_SIDE_EN.center
  }
  // 不在场的角色不写侧位，避免下游把背景人物画进来
  for (const subj of state.subjects) {
    if (!subjectsInFrame.includes(subj.name)) subj.side = 'not in frame'
  }
}

/* ==========================================================================
 * 辅助
 * ========================================================================== */

function toneAt(scene, beatIndex) {
  const curve = scene.toneCurve && scene.toneCurve.length ? scene.toneCurve : [DEFAULT_TONE]
  if (curve.length === 1) return curve[0]
  const beats = (scene.beats || []).length || 1
  const seg = Math.min(curve.length - 1, Math.floor(((beatIndex - 1) / beats) * curve.length))
  return curve[Math.max(0, seg)]
}

function buildIntent(members, subjects) {
  const dom = dominantEvent(members)
  const cls = ACTION_CLASSES[dom.cls]?.label || '动作'
  if (dom.danger) return `让观众亲眼看见威胁：${dom.text}`
  if (members.some((m) => m.line)) return `承接 ${dom.subject || '角色'} 的发言，让对话有落点`
  if (dom.cls === 'environment') return `交代空间与处境：${dom.text}`
  if (dom.cls === 'emotion') return `把注意力交给 ${dom.subject} 的情绪`
  return `完整交付「${dom.text}」这一动作，观众看清${subjects.join('、') || '画面主体'}的所作所为`
}

function buildBeats(members, total) {
  const sum = members.reduce((s, m) => s + m.duration, 0) || 1
  let t = DURATION.settle
  return members.map((m) => {
    const at = round2(Math.min(total - 0.1, t))
    t += m.duration * (total - DURATION.settle - DURATION.linger) / sum
    return { at: Math.max(0, at), what: m.text, cls: ACTION_CLASSES[m.cls]?.label || '', subject: m.subject }
  })
}

function suggestAudio(members, scene, tone) {
  const diegetic = members
    .filter((m) => ['move', 'interact', 'environment'].includes(m.cls))
    .map((m) => `${m.subject || ''}${ACTION_CLASSES[m.cls].label}声`.replace(/^·/, ''))
    .filter(Boolean)
  return {
    diegetic,
    ambience: scene.space ? `${scene.space}${scene.timeOfDay ? `·${scene.timeOfDay}` : ''}的环境底噪` : '',
    score: ['紧张', '危险', '爆发'].includes(tone) ? '低频持续推进，无旋律' : ['舒缓', '压抑'].includes(tone) ? '留白为主，仅余环境声' : '',
  }
}

function collectAssets(members, scene, ctx) {
  const chars = new Set()
  const props = new Set()
  for (const m of members) {
    if (m.subject && (ctx.roster || []).includes(m.subject)) chars.add(m.subject)
    if (m.object) for (const p of scene.props || []) if (m.object.includes(p.name)) props.add(p.name)
  }
  return { characters: [...chars], scenes: scene.space ? [scene.space] : [], props: [...props] }
}

function retime(shots) {
  let cursor = 0
  for (const s of shots) {
    s.startTime = round2(cursor)
    s.endTime = round2(cursor + s.duration)
    cursor = s.endTime
  }
  return shots
}

function dominantEvent(members) {
  return members.reduce((a, b) => (eventWeight(b) > eventWeight(a) ? b : a))
}
function eventWeight(m) {
  return m.duration + (m.danger ? 3 : 0) + (m.discovery ? 1.5 : 0) + (m.line ? 1 : 0)
}
function dominantSubject(group) {
  const counts = new Map()
  for (const m of group.members) if (m.subject) counts.set(m.subject, (counts.get(m.subject) || 0) + m.duration)
  let best = ''
  let bestN = -1
  for (const [k, v] of counts) if (v > bestN) { bestN = v; best = k }
  return best
}
/** 入画主体集合。
 *  动作的承受者只有发生**物理接触**时才算在场：「抱住 @一二」是两人同框，
 *  「喊 @一二」不是——被喊的人可能在很远的地方，甚至不在画面里。 */
function subjectSet(members) {
  const out = []
  const add = (n) => { if (n && !out.includes(n)) out.push(n) }
  for (const m of members) {
    add(m.subject)
    if (m.cls === 'interact') add(m.recipient)
  }
  return out
}
function meanRadius(members) {
  const valid = members.filter((m) => m.radius > 0)
  if (!valid.length) return 5
  return valid.reduce((s, m) => s + m.radius, 0) / valid.length
}
function sameSet(a, b) {
  return a.length === b.length && a.every((x) => b.includes(x))
}
function wishAngle(last, ev) {
  const from = last.cls
  const to = ev.cls
  const table = {
    'move->perceive': { changed: true, from: '伴随', to: '主观倾向', note: '行动停下来变成了观看，机位必须换立场' },
    'perceive->speak': { changed: true, from: '看', to: '被看', note: '看的动作结束，视线交还给说话的人' },
    'speak->speak': { changed: true, from: '说话人A', to: '说话人B', note: '发言权易手' },
    'emotion->speak': { changed: true, from: '情绪特写', to: '言语机位', note: '情绪成形后开口，需要一个能装下两人的机位' },
  }
  return table[`${from}->${to}`] || { changed: false }
}

const cloneState = (s) => JSON.parse(JSON.stringify(s))
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))
const round2 = (n) => Math.round(n * 100) / 100
const countBy = (arr) => arr.reduce((acc, k) => { acc[k] = (acc[k] || 0) + 1; return acc }, {})
