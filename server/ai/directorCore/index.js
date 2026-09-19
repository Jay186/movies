/**
 * 导演核 · 总入口
 * ============================================================================
 * 一句话概括这套内核与旧做法的区别：
 *
 *   旧做法：把剧本和一堆规则丢给大模型，问它"这里该怎么切"。
 *   新做法：内核自己把剧本切成镜头，切完再让大模型把每一镜写出来。
 *
 * 前者把**决定**交给了概率，后者把决定留给了规则。
 * 因此新内核有两个旧做法给不了的性质：
 *   · 可复现 —— 同一份剧本跑两次，镜头序列逐字相同
 *   · 可审计 —— 每一个镜头都能回答"它为什么存在"、"为什么在这里切"
 *
 * 流水线（每一步的产物都单独可查）：
 *
 *   剧本 ──① screenplay──▶ 结构化剧本（空间/轴线/基调/节拍/行动线）
 *         ──② events────▶ 观看事件序列（主体/动作类/信息半径/时长/张力）
 *         ──③ planner───▶ 镜头序列（切镜决策 + 取景 + 运镜动机 + 状态链）
 *         ──④ validators▶ 自检与自动修复（越轴/假切镜/状态断裂/信息丢包）
 *         ──⑤ prompt────▶ 交办单（LLM 只在这里出场，且只负责写）
 *
 * ①②③④ 全部是纯函数，不联网、不花钱、毫秒级完成，因此可以单测、可以回滚、可以跑一万遍。
 */

import { annotateScreenplay, parseScreenplay, renderScreenplay } from './screenplay.js'
import { planScene } from './planner.js'
import { validateScene, repairScene, renderReport, CODES } from './validators.js'
import { resolveProfile } from './ontology.js'

export {
  parseScreenplay,
  renderScreenplay,
  annotateScreenplay,
  planScene,
  validateScene,
  repairScene,
  renderReport,
  CODES,
}
export { extractViewEvents } from './events.js'
export { buildShotExpressionMessages, buildScreenplayAnnotationMessages, renderShotBrief, checkExpression } from './prompt.js'
export * from './ontology.js'

/* ==========================================================================
 * 主入口
 * ========================================================================== */

/**
 * 从剧本提取分镜。
 *
 * @param {string} scriptText 剧本原文（裸本或导演标注本均可）
 * @param {Object} [opts]
 *   style          画风名，仅用于交付与表达层
 *   assets         资产库 { characters:[], scenes:[], props:[] }，用于主体识别
 *   profile        平台档位名（'default'|'h3'|'shortform'）或自定义 profile 对象
 *   minShot/maxShot 覆盖单镜时长边界
 *   targetDuration 全片目标总时长（秒）；只做"提示与微调"，绝不为了凑时长删内容
 *   repair         是否自动修复结构错误（默认 true）
 *   keepEvents     是否在返回值里带上观看事件（默认 false，体积较大）
 *
 * @returns {{
 *   screenplay: Object,
 *   scenes: Array,
 *   stats: Object,
 *   selfCheck: { before: Object, after: Object, repairs: Array },
 *   diagnostics: Array
 * }}
 */
export function extractStoryboard(scriptText, opts = {}) {
  const profile = typeof opts.profile === 'string' ? resolveProfile(opts.profile) : (opts.profile || resolveProfile('default'))
  const minShot = opts.minShot ?? Math.max(4, profile.minShot)
  const maxShot = opts.maxShot ?? Math.min(15, profile.maxShot)
  const doRepair = opts.repair !== false

  const screenplay = parseScreenplay(scriptText)
  if (!screenplay.scenes.length) {
    return {
      screenplay,
      scenes: [],
      stats: emptyStats(),
      selfCheck: { before: { errors: [], warnings: [], ok: true }, after: null, repairs: [] },
      diagnostics: [],
      warnings: ['剧本为空或无法识别出任何场次'],
    }
  }

  const scenes = []
  const diagnostics = []
  const allRepairs = []
  const selfCheckBefore = { errors: [], warnings: [] }
  const selfCheckAfter = { errors: [], warnings: [] }

  for (const scene of screenplay.scenes) {
    const plan = planScene(scene, { profile, assets: opts.assets, minShot, maxShot })
    diagnostics.push(plan.diagnostics)

    /* ---- ④ 自检 ---- */
    const before = validateScene(scene, plan.shots, plan.events, { minShot, maxShot })
    selfCheckBefore.errors.push(...before.errors.map(tag(scene)))
    selfCheckBefore.warnings.push(...before.warnings.map(tag(scene)))

    let shots = plan.shots
    let repairs = []
    let after = before
    if (doRepair) {
      const r = repairScene(scene, plan.shots, plan.events, { minShot, maxShot })
      shots = r.shots
      repairs = r.applied.map((a) => ({ ...a, scene: scene.index }))
      allRepairs.push(...repairs)
      after = validateScene(scene, shots, plan.events, { minShot, maxShot })
    } else {
      after = before
    }
    selfCheckAfter.errors.push(...after.errors.map(tag(scene)))
    selfCheckAfter.warnings.push(...after.warnings.map(tag(scene)))

    scenes.push({
      index: scene.index,
      title: scene.title,
      space: scene.space,
      timeOfDay: scene.timeOfDay,
      intExt: scene.intExt,
      axis: scene.axis,
      anchors: scene.anchors,
      toneCurve: scene.toneCurve,
      actionLines: scene.actionLines,
      props: scene.props,
      shots,
      _events: opts.keepEvents ? plan.events : undefined,
      _repairs: repairs,
      _selfCheck: after,
    })
  }

  /* ---- 全片时间轴重排 + 目标时长校准 ---- */
  const timeline = retimeAll(scenes)
  const fit = opts.targetDuration
    ? fitToTarget(scenes, Number(opts.targetDuration), { minShot, maxShot, tolerance: profile.totalTolerance })
    : null
  if (fit) retimeAll(scenes)

  const stats = buildStats(scenes, { before: selfCheckBefore, after: selfCheckAfter, repairs: allRepairs, fit })

  const warnings = []
  if (fit && fit.driftAfter > (profile.totalTolerance * 100)) {
    warnings.push(`总时长 ${fit.totalAfter}s 与目标 ${fit.target}s 偏差 ${fit.driftAfter.toFixed(1)}%（超出容差 ${(profile.totalTolerance * 100).toFixed(0)}%）。为凑时长删场次是错的，这里只做了单镜级微调，剩下的偏差请人决定。`)
  }
  if (selfCheckAfter.errors.length) {
    warnings.push(`自检仍有 ${selfCheckAfter.errors.length} 个硬错误未修复（见 selfCheck.after.errors）。这些需要人判断，不该由内核自作主张。`)
  }

  return {
    screenplay,
    scenes,
    stats,
    selfCheck: { before: selfCheckBefore, after: selfCheckAfter, repairs: allRepairs },
    diagnostics,
    timeline,
    fit,
    warnings,
  }
}

/* ==========================================================================
 * 目标时长校准
 * --------------------------------------------------------------------------
 * 唯一原则：**时长约束只能压缩每一镜的冗余，不能压缩戏。**
 * 因此这里只做三件事：整体等比缩放 → 夹回单镜边界 → 如实报告还差多少。
 * 绝不删除、合并或跳过任何场次 —— 那是内容决策，不是排期决策。
 * ========================================================================== */

function fitToTarget(scenes, target, { minShot, maxShot, tolerance }) {
  const shots = scenes.flatMap((s) => s.shots)
  const totalBefore = round2(shots.reduce((s, x) => s + x.duration, 0))
  if (!shots.length || !target) return null

  const scale = target / totalBefore
  if (Math.abs(1 - scale) <= tolerance) {
    return { target, totalBefore, totalAfter: totalBefore, scale: 1, driftAfter: Math.abs(totalBefore - target) / target * 100, adjusted: 0, unreachable: 0 }
  }

  let adjusted = 0
  let unreachable = 0
  for (const s of shots) {
    // 缩放的锚点是"进出与停留"，动作本身的时间不该被压缩
    const rigid = s.beats.reduce((acc, b) => acc + (ACTION_RIGID[s.movement.key] || 0), 0)
    const wanted = Math.max(s.duration * scale, rigid)
    const clamped = Math.max(minShot, Math.min(maxShot, wanted))
    if (Math.abs(clamped - s.duration) > 0.01) adjusted++
    if (Math.abs(wanted - clamped) > 0.01) unreachable++
    s.duration = round2(clamped)
  }

  const totalAfter = round2(shots.reduce((s, x) => s + x.duration, 0))
  return {
    target,
    totalBefore,
    totalAfter,
    scale: round2(scale),
    driftAfter: Math.abs(totalAfter - target) / target * 100,
    adjusted,
    unreachable,
  }
}

/** 各类镜头的"不可压缩时间"：进入/停留/运镜过程是刚性的 */
const ACTION_RIGID = { 固定: 2.6, 推近: 2.6, 拉远: 2.6, 横摇: 2.6, 横移: 2.7, 跟拍: 2.8, 升降: 2.8, 环绕: 3.0, 变焦: 2.4, 手持: 2.2, 甩镜: 2.0 }

/* ==========================================================================
 * 时间轴与统计
 * ========================================================================== */

function retimeAll(scenes) {
  let cursor = 0
  const rows = []
  for (const scene of scenes) {
    for (const s of scene.shots) {
      s.startTime = round2(cursor)
      s.endTime = round2(cursor + s.duration)
      s.absStart = s.startTime
      cursor = s.endTime
      rows.push({ scene: scene.index, shot: s.id, start: s.startTime, end: s.endTime, size: s.framing.size, angle: s.framing.angle, move: s.movement.key, duration: s.duration })
    }
  }
  return rows
}

function buildStats(scenes, { before, after, repairs, fit }) {
  const shots = scenes.flatMap((s) => s.shots)
  const total = round2(shots.reduce((s, x) => s + x.duration, 0))
  const byMove = {}
  const bySize = {}
  const byAngle = {}
  let subjectives = 0
  for (const s of shots) {
    byMove[s.movement.key] = (byMove[s.movement.key] || 0) + 1
    bySize[s.framing.size] = (bySize[s.framing.size] || 0) + 1
    byAngle[s.framing.angle] = (byAngle[s.framing.angle] || 0) + 1
    if (String(s.framing.ownership).startsWith('主观')) subjectives++
  }
  return {
    sceneCount: scenes.length,
    shotCount: shots.length,
    totalDuration: total,
    avgShotDuration: round2(total / (shots.length || 1)),
    minShotDuration: shots.length ? Math.min(...shots.map((s) => s.duration)) : 0,
    maxShotDuration: shots.length ? Math.max(...shots.map((s) => s.duration)) : 0,
    subjectiveShare: round2(subjectives / (shots.length || 1)),
    movementDistribution: byMove,
    sizeDistribution: bySize,
    angleDistribution: byAngle,
    errorBefore: before.errors.length,
    errorAfter: after.errors.length,
    warningAfter: after.warnings.length,
    autoRepairs: repairs.length,
    fit,
  }
}

function emptyStats() {
  return { sceneCount: 0, shotCount: 0, totalDuration: 0, avgShotDuration: 0, errorBefore: 0, errorAfter: 0, warningAfter: 0, autoRepairs: 0 }
}

const tag = (scene) => (f) => ({ ...f, scene: scene.index })
const round2 = (n) => Math.round(n * 100) / 100

/* ==========================================================================
 * 交付视图：把镜头序列渲染成可读的分镜表
 * ========================================================================== */

export function renderStoryboardTable(result, { maxShots = Infinity } = {}) {
  const L = []
  const st = result.stats
  L.push(`分镜表　${st.sceneCount} 场 / ${st.shotCount} 镜 / 总长 ${st.totalDuration}s / 平均 ${st.avgShotDuration}s`)
  L.push(`自检：修前 ${st.errorBefore} 个硬错误 → 修后 ${st.errorAfter} 个 / ${st.warningAfter} 个告警 / 自动修复 ${st.autoRepairs} 处`)
  L.push('')
  let n = 0
  for (const scene of result.scenes) {
    L.push(`━━ 场 ${String(scene.index).padStart(2, '0')}　${scene.title}　${[scene.space, scene.timeOfDay, scene.intExt].filter(Boolean).join(' · ')}`)
    if (scene.axis?.a) L.push(`   轴线 ${scene.axis.a} ←→ ${scene.axis.b || '—'}｜基调 ${scene.toneCurve.join(' → ')}｜锚点 ${scene.anchors.join('、') || '—'}`)
    L.push('')
    for (const s of scene.shots) {
      if (++n > maxShots) { L.push('   …（已截断）'); return L.join('\n') }
      // 「为什么在这里切」必须逐镜可读。
      // 注意：判断依据是"本场第几镜"，不是 cutIn 是否为空 ——
      // 内部重建（合并/拆分修过后）会让首镜也带上 cutIn，而中间镜可能丢掉它，
      // 用 cutIn 判空会把中间镜错标成"本场首镜"，审计时就成了误导。
      const isSceneHead = s.index === 1
      const cut = isSceneHead
        ? '本场首镜（无切镜收益概念）'
        : s.cutIn
          ? `切镜理由：${[...(s.cutIn.dims || []).map((d) => d.label), ...(s.cutIn.gates || []).map((g) => g.label)].join('+') || s.cutIn.forced || '—'}（收益 ${s.cutIn.total}）`
          : '切镜理由：未记录（经内部重建，见 DESIGN.md 的边界复核小节）'
      L.push(`  ${s.id}　${fmtTime(s.startTime)}–${fmtTime(s.endTime)}　${s.duration}s　${s.framing.size}｜${s.framing.angle}｜${s.framing.ownership}｜${s.framing.side}`)
      L.push(`        意图：${s.intent}`)
      L.push(`        运镜：${s.movement.key}${s.movement.amplitude ? `(${s.movement.amplitude})` : ''} —— ${s.movement.motivation}`)
      L.push(`        ${cut}`)
      if (s.lines?.length) L.push(`        台词：${s.lines.map((l) => `${l.character}「${l.text}」`).join('；')}`)
      L.push('')
    }
  }
  return L.join('\n')
}

function fmtTime(t) {
  const m = Math.floor(t / 60)
  const s = (t % 60).toFixed(2).padStart(5, '0')
  return `${String(m).padStart(2, '0')}:${s}`
}
