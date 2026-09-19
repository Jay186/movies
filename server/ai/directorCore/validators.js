/**
 * 导演核 · 确定性自检器
 * ============================================================================
 * 这一层存在的意义：**把"好不好"变成"对不对"。**
 *
 * 一份分镜的绝大多数毛病，本质上不是审美分歧，而是结构错误：
 *   · 两镜之间什么都没变，却切了 —— 假切镜
 *   · 摄影机动了，但说不出为什么动 —— 无动机运镜
 *   · 角色的画面侧位跳了，中间没有任何交代 —— 越轴
 *   · 道具在没有人碰它的情况下换了持有者 —— 状态凭空改变
 *   · 剧本里的一句台词在分镜里不见了 —— 信息丢包
 *   · 某个节拍没有任何镜头承载 —— 遗漏
 *
 * 这些全部可以用代码判定，因此全部在离线阶段判定，
 * 不留给大模型"自我审查"（模型自审等于没有审查）。
 *
 * 每个错误都带 code / 位置 / 原因 / 最小修复动作。可修的自动修，不可修的留给人。
 */

import { CUT_GAIN_FLOOR, MOVE_BY_KEY, SIZE_ORDER } from './ontology.js'
import { composeShots, durationOfGroup } from './planner.js'

export const CODES = {
  FAKE_CUT: 'FAKE_CUT',
  MOVE_NO_MOTIVE: 'MOVE_NO_MOTIVE',
  MOVE_ILLEGAL_MOTIVE: 'MOVE_ILLEGAL_MOTIVE',
  STATE_CHAIN_BREAK: 'STATE_CHAIN_BREAK',
  PROP_TELEPORT: 'PROP_TELEPORT',
  AXIS_VIOLATION: 'AXIS_VIOLATION',
  DURATION_OUT_OF_RANGE: 'DURATION_OUT_OF_RANGE',
  BEAT_UNCOVERED: 'BEAT_UNCOVERED',
  LINE_LOST: 'LINE_LOST',
  SHOT_MONOTONY: 'SHOT_MONOTONY',
  SUBJECT_VANISH: 'SUBJECT_VANISH',
}

/* ==========================================================================
 * 主校验
 * ========================================================================== */

/**
 * @param {Object} scene
 * @param {Array}  shots  planner 产出的镜头数组
 * @param {Array}  events 观看事件数组
 * @param {Object} opts   { minShot, maxShot }
 * @returns {{ errors: Finding[], warnings: Finding[], ok: boolean }}
 */
export function validateScene(scene, shots, events, opts = {}) {
  const minShot = opts.minShot ?? 4
  const maxShot = opts.maxShot ?? 15
  const errors = []
  const warnings = []

  const push = (level, code, shotId, message, fix) => {
    const f = { level, code, shot: shotId, message, fix }
    ;(level === 'error' ? errors : warnings).push(f)
  }

  /* ---------- 1. 假切镜：切了，但什么都没变 ---------- */
  for (let i = 1; i < shots.length; i++) {
    const a = shots[i - 1]
    const b = shots[i]
    const sameFraming =
      a.framing.size === b.framing.size &&
      a.framing.angle === b.framing.angle &&
      a.framing.ownership === b.framing.ownership
    const gain = b.cutIn?.total ?? 0
    const forced = b.cutIn?.forced === 'maxShot'
    if (sameFraming && gain < CUT_GAIN_FLOOR && !forced) {
      push('error', CODES.FAKE_CUT, b.id,
        `与上一镜取景完全相同（${a.framing.size}/${a.framing.angle}/${a.framing.ownership}）且收益仅 ${gain}（阈 ${CUT_GAIN_FLOOR}）：这是一次没有内容的切镜，观众只会感到画面抖了一下`,
        `与 ${a.id} 合并`)
    }
  }

  /* ---------- 2. 运镜：必须说出理由，且理由必须合法 ---------- */
  for (const s of shots) {
    const m = s.movement
    if (m.key === '固定') continue
    const def = MOVE_BY_KEY[m.key]
    if (!def) {
      push('error', CODES.MOVE_ILLEGAL_MOTIVE, s.id, `运镜「${m.key}」不在本体表里`, '改为固定')
      continue
    }
    if (!m.motivation || !m.motivation.trim()) {
      push('error', CODES.MOVE_NO_MOTIVE, s.id, `运镜「${m.key}」没有给出动机。摄影机不会无缘无故地动`, '改为固定，或补上动机')
      continue
    }
    const motiveKey = m.motivation.split('：')[0].trim()
    if (!def.motive.includes(motiveKey)) {
      push('warn', CODES.MOVE_ILLEGAL_MOTIVE, s.id,
        `运镜「${m.key}」的动机「${motiveKey}」不在该运镜的合法动机表内（合法：${def.motive.join('、')}）`,
        `改用一个动机合法的运镜，或把动作改为固定`)
    }
  }

  /* ---------- 3. 越轴：侧位翻转必须有中介 ---------- */
  const axisDeclared = !!(scene.axis?.a && scene.axis?.b)
  if (axisDeclared) {
    let lastSide = null
    let neutralSinceFlip = false
    for (const s of shots) {
      const side = s.framing.side
      if (side === '轴上' || side === '无轴线') { neutralSinceFlip = true; continue }
      if (side === 'not in frame') continue
      if (lastSide && side !== lastSide && !neutralSinceFlip) {
        push('error', CODES.AXIS_VIOLATION, s.id,
          `机位从 ${lastSide} 翻到 ${side}，中间没有中性镜（正打/背打）也没有镜内跨轴：观众的空间方位被欺骗了`,
          '在本镜前插入一个轴上机位，或把本镜改为正面')
      }
      if (lastSide && side !== lastSide) neutralSinceFlip = false
      lastSide = side
    }
  }

  /* ---------- 4. 状态链：出口即下一镜入口，语义上也要接得住 ---------- */
  for (let i = 1; i < shots.length; i++) {
    const prev = shots[i - 1].exit
    const cur = shots[i].entry

    // 结构层面：必须逐字一致（同一条链）
    if (JSON.stringify(prev) !== JSON.stringify(cur)) {
      push('error', CODES.STATE_CHAIN_BREAK, shots[i].id, '本镜入口状态与上一镜出口状态不一致，状态链断开', '以上一镜出口覆盖本镜入口')
    }

    // 语义层面一：在场的角色侧位发生跳变却没有换轴/走位交代
    for (const ps of prev.subjects) {
      const cs = cur.subjects.find((x) => x.name === ps.name)
      if (!cs) continue
      if (ps.side !== cs.side && ps.side !== 'not in frame' && cs.side !== 'not in frame') {
        if (shots[i - 1].framing.side === shots[i].framing.side) {
          push('warn', CODES.STATE_CHAIN_BREAK, shots[i].id,
            `${ps.name} 的画面侧位在机位未变的情况下从 ${ps.side} 跳到 ${cs.side}`, '检查本镜是否漏了一次走位交代')
        }
      }
    }

    // 语义层面二：道具持有者凭空改变
    for (const pp of prev.props || []) {
      const cp = (cur.props || []).find((x) => x.name === pp.name)
      if (!cp) continue
      if (pp.holder !== cp.holder) {
        const motivated = (shots[i].beats || []).some((b) => b.what && b.what.includes(pp.name))
          || shots[i].intent.includes(pp.name)
        if (!motivated) {
          push('error', CODES.PROP_TELEPORT, shots[i].id,
            `道具「${pp.name}」从 ${pp.holder || '无主'} 换到了 ${cp.holder || '无主'}，但本镜没有任何一次接触动作交代这件事`,
            '补一次交接动作，或把持有者改回上一镜的值')
        }
      }
    }
  }

  /* ---------- 5. 时长越界 ---------- */
  for (const s of shots) {
    if (s.duration < minShot - 0.01) {
      push('error', CODES.DURATION_OUT_OF_RANGE, s.id, `时长 ${s.duration}s 低于单镜下限 ${minShot}s：这个镜头短到观众来不及看清`, `延长到 ${minShot}s 或与相邻镜合并`)
    } else if (s.duration > maxShot + 0.01) {
      push('error', CODES.DURATION_OUT_OF_RANGE, s.id, `时长 ${s.duration}s 超过单镜上限 ${maxShot}s`, `压缩到 ${maxShot}s 或在内部切开`)
    }
  }

  /* ---------- 6. 节拍覆盖：剧本里写的事，分镜里必须都有 ---------- */
  const coveredEventIds = new Set(shots.flatMap((s) => s.members || []))
  const beats = (scene.beats || []).map((b) => b.index)
  const coveredBeats = new Set(
    events.filter((e) => coveredEventIds.has(e.id)).map((e) => e.beatIndex)
  )
  for (const bi of beats) {
    if (coveredBeats.has(bi)) continue
    const evs = events.filter((e) => e.beatIndex === bi)
    // 这一拍压根没抽出任何事件（纯时间状语、纯描写，被事件抽取层有意丢弃）——
    // 那不是"内容丢了"，而是"这一拍本来就没有可执行的动作"，不该报错。
    if (!evs.length) continue
    push('error', CODES.BEAT_UNCOVERED, `节拍${bi}`, `剧本节拍 ${bi} 没有任何镜头承载（事件 ${evs.map((e) => e.id).join('、')} 落空）：这一段内容在成片里会凭空消失`, '为它增加一个镜头')
  }

  /* ---------- 7. 台词完整性：一句都不能丢，也不能被拆 ---------- */
  const declaredLines = (scene.lines || []).map((l) => `${l.character}：${l.text}`)
  const shotLines = shots.flatMap((s) => s.lines || []).map((l) => `${l.character}：${l.text}`)
  for (const dl of declaredLines) {
    const n = shotLines.filter((x) => x === dl).length
    if (n === 0) {
      push('error', CODES.LINE_LOST, scene.index, `台词「${dl}」在分镜里不见了`, '补回承载它的镜头')
    } else if (n > 1) {
      push('warn', CODES.LINE_LOST, scene.index, `台词「${dl}」被重复分配到 ${n} 个镜头`, '只保留一个')
    }
  }

  /* ---------- 8. 景别单调：连续三镜取景雷同，观众会失去空间感 ---------- */
  for (let i = 2; i < shots.length; i++) {
    const [a, b, c] = [shots[i - 2], shots[i - 1], shots[i]]
    if (a.framing.size === b.framing.size && b.framing.size === c.framing.size
      && a.framing.angle === b.framing.angle && b.framing.angle === c.framing.angle) {
      push('warn', CODES.SHOT_MONOTONY, c.id,
        `连续三镜都是 ${c.framing.size}/${c.framing.angle}，视觉上会糊成一片`, '把其中一镜换成相邻景别或换机位朝向')
    }
  }

  /* ---------- 9. 说话的人必须在画面里 ----------
     这是唯一值得专项检查的"人物消失"：如果某个镜头里有人开口说话，
     而他/她的画面侧位是「不在画面」，那这一镜的表演是接不住的。
     至于"某角色本镜没出场"——那是正常的取舍，不该报错。 */
  for (const s of shots) {
    for (const l of s.lines || []) {
      if (!l.character) continue
      const row = (s.exit.subjects || []).find((x) => x.name === l.character)
      if (row && row.side === 'not in frame') {
        push('error', CODES.SUBJECT_VANISH, s.id,
          `${l.character} 在本镜开口说「${l.text}」，但本镜的画面里没有他/她。观众会听见一句没有来源的话`,
          `把 ${l.character} 纳入本镜画面，或把台词移到真正装得下他/她的那一镜`)
      }
    }
  }

  return { errors, warnings, ok: errors.length === 0 }
}

/* ==========================================================================
 * 自动修复
 * --------------------------------------------------------------------------
 * 原则：只修**结构错误**（有唯一正确答案的），不修**审美判断**（有多种合理答案的）。
 * 假切镜 → 合并；越轴 → 改成轴上机位；无动机运镜 → 固定；时长越界 → 夹回边界。
 * 每次修复都记录：改了什么、为什么、影响哪几镜。
 * ========================================================================== */

export function repairScene(scene, shots, events, opts = {}) {
  const minShot = opts.minShot ?? 4
  const maxShot = opts.maxShot ?? 15
  const applied = []
  let cur = shots.map((s) => ({ ...s }))

  /* ---- 修 1：假切镜合并（可能与上镜合并成一镜） ---- */
  {
    const keep = []
    for (const s of cur) {
      const prev = keep[keep.length - 1]
      const gain = s.cutIn?.total ?? 0
      const same =
        prev &&
        prev.framing.size === s.framing.size &&
        prev.framing.angle === s.framing.angle &&
        prev.framing.ownership === s.framing.ownership
      if (prev && same && gain < CUT_GAIN_FLOOR && s.cutIn?.forced !== 'maxShot') {
        // 用**累积列表**而不是单个字段：连续三镜取景都相同时，若写成 _mergeWith: s，
        // 第二次会把第一次的覆盖掉，中间那一镜的事件就整段消失，
        // 下游表现为 BEAT_UNCOVERED（剧本内容在成片里凭空不见）。
        keep[keep.length - 1] = { ...prev, _mergeList: [...(prev._mergeList || []), s] }
        applied.push({ code: CODES.FAKE_CUT, action: `把 ${s.id} 并入 ${prev.id}`, reason: '两镜取景相同且切镜收益不足' })
      } else {
        keep.push(s)
      }
    }
    if (applied.length) {
      // 重新走一遍取景/运镜/状态链，保证合并后的镜头本身是自洽的
      cur = rebuild(keep, scene, events, { minShot, maxShot })
    }
  }

  /* ---- 修 2：越轴 → 把违规镜改成轴上机位 ---- */
  {
    const axisDeclared = !!(scene.axis?.a && scene.axis?.b)
    if (axisDeclared) {
      let lastSide = null
      let neutral = false
      for (const s of cur) {
        const side = s.framing.side
        if (side === '轴上' || side === '无轴线') { neutral = true; continue }
        if (lastSide && side !== lastSide && !neutral) {
          applied.push({ code: CODES.AXIS_VIOLATION, action: `把 ${s.id} 改为轴上机位（正面）`, reason: `机位从 ${lastSide} 翻到 ${side} 而中间没有中性镜` })
          s.framing.angle = '正面'
          s.framing.side = '轴上'
          neutral = true
          lastSide = '轴上'
          continue
        }
        if (lastSide && side !== lastSide) neutral = false
        lastSide = side
      }
    }
  }

  /* ---- 修 3：无动机运镜 → 固定 ---- */
  for (const s of cur) {
    const m = s.movement
    if (m.key === '固定') continue
    const def = MOVE_BY_KEY[m.key]
    const motiveKey = String(m.motivation || '').split('：')[0].trim()
    if (!def || !m.motivation || !def.motive.includes(motiveKey)) {
      applied.push({ code: CODES.MOVE_NO_MOTIVE, action: `把 ${s.id} 的「${m.key}」改为固定`, reason: '说不出动机的运镜不该存在' })
      s.movement = {
        key: '固定', en: MOVE_BY_KEY['固定'].en, amplitude: null, axis: null,
        motivation: '静观：本镜没有需要摄影机参与的变化，让场面自己成立',
        curve: 'hold', alternatives: [], considered: 0,
      }
    }
  }

  /* ---- 修 4：时长越界 → 夹回（夹不动的交给自检报错） ---- */
  for (const s of cur) {
    const clamped = Math.max(minShot, Math.min(maxShot, s.duration))
    if (Math.abs(clamped - s.duration) > 0.01) {
      applied.push({ code: CODES.DURATION_OUT_OF_RANGE, action: `把 ${s.id} 的时长从 ${s.duration}s 改为 ${clamped}s`, reason: `超出单镜 ${minShot}–${maxShot}s 的边界` })
      s.duration = clamped
    }
  }

  /* ---- 修 5：说话人不在画面 → 把他/她纳入本镜 ----
     必须先于状态链重接：状态改了，链就要按改后的值重接，否则重接白做。 */
  for (const s of cur) {
    for (const l of s.lines || []) {
      if (!l.character) continue
      const row = (s.exit.subjects || []).find((x) => x.name === l.character)
      if (row && row.side === 'not in frame') {
        applied.push({ code: CODES.SUBJECT_VANISH, action: `把 ${l.character} 纳入 ${s.id} 的画面`, reason: `本镜有他/她的台词「${l.text}」，人不在画面就接不住这句` })
        row.side = 'at center frame'
      }
    }
  }

  /* ---- 修 6：状态链重接 + 重排时间轴 ---- */
  for (let i = 1; i < cur.length; i++) cur[i].entry = JSON.parse(JSON.stringify(cur[i - 1].exit))
  let cursor = 0
  for (const s of cur) {
    s.startTime = round2(cursor)
    s.endTime = round2(cursor + s.duration)
    cursor = s.endTime
  }

  return { shots: cur, applied }
}

/** 用合并后的成员重新组装镜头（复用 planner 的组装逻辑，保证合并结果本身自洽） */
function rebuild(shots, scene, events, { minShot, maxShot }) {
  const evById = new Map(events.map((e) => [e.id, e]))
  const groups = shots.map((s) => {
    const members = []
    for (const id of s.members || []) if (evById.has(id)) members.push(evById.get(id))
    for (const extra of s._mergeList || []) {
      for (const id of extra.members || []) if (evById.has(id)) members.push(evById.get(id))
    }
    return { members: members.length ? members : [{ ...dummyEvent(), id: s.id }], gain: s.cutIn }
  })
  const roster = new Set(events.map((e) => e.subject).filter(Boolean))
  return composeShots(groups, scene, { roster: [...roster], minShot, maxShot })
}

function dummyEvent() {
  return { id: '', beatIndex: 1, subject: '', cls: 'environment', verb: '', object: '', radius: 5, duration: 2, danger: false, discovery: false, isNewSubject: false, text: '', source: 'merge' }
}

const round2 = (n) => Math.round(n * 100) / 100

/* ==========================================================================
 * 报告渲染
 * ========================================================================== */

export function renderReport(report) {
  const lines = []
  const { errors, warnings } = report
  lines.push(`自检结果：${errors.length} 个硬错误 / ${warnings.length} 个告警`)
  if (errors.length) {
    lines.push('')
    lines.push('■ 硬错误（必须修）')
    for (const e of errors) lines.push(`  [${e.code}] ${e.shot} — ${e.message}\n      最小修复：${e.fix}`)
  }
  if (warnings.length) {
    lines.push('')
    lines.push('■ 告警（建议复核）')
    for (const w of warnings) lines.push(`  [${w.code}] ${w.shot} — ${w.message}${w.fix ? `\n      建议：${w.fix}` : ''}`)
  }
  return lines.join('\n')
}
