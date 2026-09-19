// 段切分（E 路线 v2 产品化，2026-09-15）：读 shots → 按场分组 → 段内累加 3–15s → 段方案。
//
// 定位：段是**出片包装层**，本模块只做纯计算（读库），默认不写库。
// 镜表/分镜数据一个字不动（宪法第四条切镜规则与出片粒度无关，改分镜会触发指纹失配）。
//
// 三条铁律 + 一条收尾（AGENTS.md §九）：
//   1. 段不跨场（换场跳切是设计，上一场画面/环境音不该带进下一场）
//   2. 段内总时长 3–15s（下限=H3 可生成下限，上限=H3 单次生成上限）
//   3. 按播放序累加，再加下一镜就超 15s 则收段
//   4. 收尾：尾部不足 3s 的段并入前段（合并后不超 15s 时）
//
// 三道保险（换剧本时的健壮性，2026-09-15）：
//   · 保险1 段长校验：非法段（<3s 或 >15s）标记 unusable，调用方降级为逐镜出片 + 告警
//   · 保险2 台词切点冲突：段边界若落在某镜台词播放区间内 → 标记 conflict，人工处理
//   · 保险3 无场次降级：全部镜同场（或场次号缺失）时，跳过"不跨场"按总时长连续切段
//
// 镜表指纹（2026-09-15 审计修复 P0-A/P0-D）：
//   段记录只存 shot_ids 快照。分镜改动后（删镜/改序/改时长），段边界与切片时间轴会静默漂移，
//   切片器按错误时间轴切出内容错位的视频。故落库存一份镜表指纹（shotsFingerprint），
//   分镜一变即整批判 stale，切片前先校验，过期则拒绝切并提示重算段方案。
//
// 用法（模块）：
//   import { buildSegments } from './ai/segmentBuilder.js'
//   const plan = buildSegments(4)            // 算第2集全部分段方案
//   const plan = buildSegments(4, { scene: 2 })  // 只算场2
//
// 用法（CLI，打印不落库）：
//   node -e "import('./ai/segmentBuilder.js').then(m=>console.log(m.formatPlan(m.buildSegments(4))))"

import { createHash } from 'node:crypto'
// 台词解析判据单点（2026-09-18 P0-3）：本文件原有一份本地 parseDialogue（含 'null'/'[]'
// 两处特判），与另外三份副本各自漂移。统一从 dialogue.js 走——含 "null" 的脏值一律得 []。
import { parseDialogue } from './dialogue.js'
import { query, queryOne, execute } from '../db.js'

// ── 参数（宪法/AGENTS.md §九口径）──
// 下限 3s：H3 可生成下限（generate-video.js / segmentPrompt.js 的 Math.max(3,...) 同口径）。
// 曾定 4s 是产品约束，但导致「单场只有 1 个 3s 镜」时整集段方案无法落库（审计 P1-1），已对齐。
export const SEG_MIN_SEC = 3
export const SEG_MAX_SEC = 15

/**
 * 段时长（秒）**唯一口径**（2026-09-16 审核修复 P1-2）。
 *
 * 为什么要有这个函数：段时长此前在两处各算一遍，口径不同——
 *   · segmentBuilder.finalizeSegment：`Σ 各镜 duration`（决定合法/超限 → unusable）
 *   · segmentPrompt / generate-video.js：`round(end_time - start_time)`（决定 H3 生成几秒）
 * 正常情况下两者相等（实测全库 36 镜 duration 与 end_time-start_time 100% 一致），
 * 但那是**巧合而非保证**——`PUT /episodes/:id/shots/:shotId` 允许只传 duration 不传
 * end_time（或反之）。一旦漂移，同一个段会得到三个不同的长度：
 *   ① 合法性判定用 Σduration  ② H3 生成时长用 end-start  ③ 切片按 start_time 相对偏移
 * 静默不一致，成片长度与镜表对不上且无从追查。
 *
 * 取 `end_time - start_time` 为准：它是**切片的真实依据**（`sliceSegment` 的切点全部由
 * start_time 推出），也是 H3 时间轴（`[Shot N] At MM:SS.mmm`）的锚。
 *
 * ⚠️ `clamp=true` 时结果被夹到 [SEG_MIN_SEC, SEG_MAX_SEC]——这是**给生成用的**（H3 硬边界）。
 *    **合法性判定必须用 `clamp=false` 取原始区间**，否则「先 clamp 再判区间」永远合法
 *    （自证闭环），unusable 检测形同虚设。这是本函数 2026-09-16 修复中踩到并纠正的坑。
 *
 * @param {{ start_time?: number, end_time?: number }} seg video_segments 行（或其形状）
 * @param {Array<{duration?: number}>} [shots] 段内镜（end/start 缺失时的兜底来源）
 * @param {{ clamp?: boolean }} [opts] 默认 clamp=true
 * @returns {number} 秒
 */
export function segmentDurationSec(seg, shots = null, opts = {}) {
  const clamp = opts.clamp !== false
  const start = Number(seg?.start_time)
  const end = Number(seg?.end_time)
  let raw = Number.isFinite(start) && Number.isFinite(end) ? end - start : NaN
  // 区间不可用（缺失 / 零 / 负）时回落到镜 duration 之和（老数据、手工构造的段）
  if (!Number.isFinite(raw) || raw <= 0) {
    if (Array.isArray(shots) && shots.length) {
      raw = shots.reduce((a, s) => a + (Number(s?.duration) || 0), 0)
    }
  }
  if (!Number.isFinite(raw) || raw <= 0) raw = 5
  if (!clamp) return raw
  return Math.min(SEG_MAX_SEC, Math.max(SEG_MIN_SEC, Math.round(raw)))
}

// 台词估算时长：中文按每秒 5 字（保守偏高，宁可误报冲突也不漏报）
const CHARS_PER_SECOND = 5

/**
 * 读某集的镜表（含所属场次、台词），按场分组。
 * @returns {Array<{ sceneNumber, shots: Array }>}
 */
export function loadEpisodeShots(episodeId) {
  const rows = query(
    `SELECT s.id, s.shot_number, s.duration, s.start_time, s.end_time, s.dialogue,
            s.integrated_multimodal_description, s.continuity_url, s.video_url,
            ss.scene_number
       FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id
      WHERE ss.episode_id = ?
      ORDER BY ss.scene_number, s.start_time, s.id`,
    [episodeId]
  )
  const byScene = new Map()
  for (const r of rows) {
    const sn = Number(r.scene_number) || 0
    if (!byScene.has(sn)) byScene.set(sn, [])
    byScene.get(sn).push({
      id: r.id,
      shotNumber: r.shot_number,
      duration: Number(r.duration) || 0,
      startTime: Number(r.start_time) || 0,
      endTime: Number(r.end_time) || 0,
      dialogue: parseDialogue(r.dialogue),
      ims: String(r.integrated_multimodal_description || ''),
      continuityUrl: String(r.continuity_url || ''),
      videoUrl: String(r.video_url || ''),
    })
  }
  return [...byScene.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([sceneNumber, shots]) => ({ sceneNumber, shots }))
}


/**
 * 该集镜表指纹（md5）：段边界与切片时间轴所依赖字段的完整快照。
 *
 * 覆盖：场次号 + 镜 id/编号/起止/时长 —— 任一项变化都会让已落库的段边界与切片时间轴失真，
 * 故必须全部进指纹。**走 loadEpisodeShots() 取数**，保证「算指纹的镜集合」与「切段用的镜集合」
 * 同源（不再写第二份 SQL，避免两处口径漂移）。
 *
 * 顺序用 loadEpisodeShots 的固有顺序（场次号、start_time、id），**不再额外 sort**——
 * 该顺序就是切段顺序，顺序变了指纹必须跟着变。
 *
 * @param {number} episodeId
 * @returns {string} 32 位 md5（该集无镜时为空串的 md5，恒定值）
 */
export function shotsFingerprint(episodeId) {
  const lines = []
  for (const g of loadEpisodeShots(episodeId)) {
    for (const s of g.shots) {
      lines.push(`${g.sceneNumber}:${s.id}:${s.shotNumber}:${s.startTime}:${s.endTime}:${s.duration}`)
    }
  }
  return createHash('md5').update(lines.join('\n'), 'utf8').digest('hex')
}

/**
 * 段是否已过期 —— **判定口径的唯一实现**（2026-09-16）。
 *
 * 为什么必须收口：这个判据此前有三处各自实现（切片器、出片闸门、UI 探测接口），
 * 一旦某处改了规则（比如「空指纹算不算过期」）另两处就静默漂移，出现
 * 「出片时认为新鲜、切片时认为过期」这种自相矛盾的状态。本项目已因「口径重复实现」
 * 吃过一次亏（见 overview「越轴走位正则三处各写一份」），故此处只保留一份。
 *
 * 规则（两条，缺一不可）：
 *   1. 空指纹 → 过期。落库于指纹机制（2026-09-15）之前的段没有指纹，无法证明与当前
 *      镜表一致；「空串视为不过期」会让迁移期老数据变成免检（这正是 P0-NEW-1 的根因）。
 *   2. 指纹失配 → 过期。分镜的镜长/镜号/顺序/时长任一变化都会改变指纹，
 *      段边界与切片时间轴随之漂移，按旧记录切片会切出内容错位的视频。
 *
 * @param {{episode_id?: number, shots_fp?: string}} seg video_segments 行
 * @returns {{ stale: boolean, reason: string, currentFingerprint: string }}
 *   stale=false 时 reason 为空串。
 */
export function segmentStaleness(seg) {
  const curFp = shotsFingerprint(seg?.episode_id)
  if (!seg?.shots_fp) {
    return {
      stale: true,
      reason: '段记录没有镜表指纹（落库于指纹机制之前），无法证明与当前分镜一致',
      currentFingerprint: curFp,
    }
  }
  if (seg.shots_fp !== curFp) {
    return {
      stale: true,
      reason: '镜表指纹与落库时不一致（分镜已修改，段边界/时间轴可能已漂移）',
      currentFingerprint: curFp,
    }
  }
  return { stale: false, reason: '', currentFingerprint: curFp }
}

/**
 * 台词播放区间（全片绝对秒 → 相对段首秒）。
 * 中文按 CHARS_PER_SECOND 估时长，用于检测段边界是否把台词切两半。
 */
function dialogueRanges(shots, segStartAbs) {
  const out = []
  for (const sh of shots) {
    for (const d of sh.dialogue) {
      const text = String(d?.text || '').trim()
      if (!text) continue
      const absStart = Number(d?.startTime)
      if (!Number.isFinite(absStart)) continue
      const dur = Math.max(0.4, text.length / CHARS_PER_SECOND)
      out.push({
        character: String(d?.character || ''),
        text,
        absStart,
        absEnd: absStart + dur,
        relStart: absStart - segStartAbs,
        relEnd: absStart + dur - segStartAbs,
      })
    }
  }
  return out
}

/**
 * 单场内切段（铁律 2/3/4）。
 * @returns {Array<{ shotNumbers, shots, durationSec }>}
 */
function packScene(shots) {
  const segs = []
  let cur = []
  let acc = 0
  for (const sh of shots) {
    // 单镜本身就超上限：独占一段（标记 unusable，调用方降级）
    if (sh.duration > SEG_MAX_SEC) {
      if (cur.length) { segs.push({ shots: cur, durationSec: acc }); cur = []; acc = 0 }
      segs.push({ shots: [sh], durationSec: sh.duration })
      continue
    }
    // 铁律 3：再加这一镜就超 15s → 收段
    if (cur.length && acc + sh.duration > SEG_MAX_SEC) {
      segs.push({ shots: cur, durationSec: acc })
      cur = []
      acc = 0
    }
    cur.push(sh)
    acc += sh.duration
  }
  if (cur.length) segs.push({ shots: cur, durationSec: acc })

  // 铁律 4（收尾）：尾部不足 4s → 试并入前段
  if (segs.length > 1 && segs[segs.length - 1].durationSec < SEG_MIN_SEC) {
    const last = segs[segs.length - 1]
    const prev = segs[segs.length - 2]
    if (prev.durationSec + last.durationSec <= SEG_MAX_SEC) {
      segs.splice(-2, 2, {
        shots: [...prev.shots, ...last.shots],
        durationSec: prev.durationSec + last.durationSec,
      })
    }
  }
  return segs
}

/**
 * 算某集（或某场）的段方案。纯计算，不写库。
 *
 * @param {number} episodeId
 * @param {{ scene?: number }} [opts] scene 限定只算某场
 * @returns {{ episodeId, scenes: Array, totals: Object, warnings: string[], shotsFp: string, isEmpty?: boolean }}
 */
export function buildSegments(episodeId, opts = {}) {
  let sceneGroups = loadEpisodeShots(episodeId)
  if (opts.scene != null) sceneGroups = sceneGroups.filter((g) => g.sceneNumber === Number(opts.scene))

  const warnings = []
  const scenes = []
  let segIndexGlobal = 0
  // 指纹算一次，三个 return 分支都带上（分镜一变，已落库的段即判 stale）
  const shotsFp = shotsFingerprint(episodeId)

  // 保险 3 前置：完全没镜（该集无分镜，或 opts.scene 过滤后无匹配场）
  // 必须早返回并置 isEmpty —— 否则落库层拿到「成功但空」的方案，
  // replace=true 时会先 DELETE 掉该集全部非 done 段、再一行不插（审计 P1-2）。
  if (sceneGroups.length === 0) {
    warnings.push('该集没有镜头（或指定场次无镜），段方案为空')
    return { episodeId, scenes, totals: summarize(scenes), warnings, shotsFp, isEmpty: true }
  }

  // 保险 3：无有效场次（只有一场 / 场次号为 0）→ 拍平按总时长连续切
  const singleScene = sceneGroups.length <= 1
  if (singleScene && sceneGroups.length === 1) {
    const all = sceneGroups[0].shots
    const segs = packScene(all)
    const packed = segs.map((s, i) => finalizeSegment(s, episodeId, sceneGroups[0].sceneNumber, i + 1, all, ++segIndexGlobal, warnings))
    scenes.push({ sceneNumber: sceneGroups[0].sceneNumber, segments: packed })
    // 只在场次号缺失/为 0 时告警：单场单集本就不存在「跨场」问题，告警是噪声（审计 P2-3）
    if (all.length && !sceneGroups[0].sceneNumber) {
      warnings.push('场次号缺失（为 0）：已跳过"不跨场"规则，按总时长连续切段')
    }
    return { episodeId, scenes, totals: summarize(scenes), warnings, shotsFp }
  }

  for (const g of sceneGroups) {
    const segs = packScene(g.shots)
    let idx = 0
    const packed = segs.map((s) => finalizeSegment(s, episodeId, g.sceneNumber, ++idx, g.shots, ++segIndexGlobal, warnings))
    scenes.push({ sceneNumber: g.sceneNumber, segments: packed })
  }
  return { episodeId, scenes, totals: summarize(scenes), warnings, shotsFp }
}

/**
 * 段收尾处理：补编号、算绝对时间、跑三道保险。
 */
function finalizeSegment(seg, episodeId, sceneNumber, segIndexInScene, sceneShots, segIndexGlobal, warnings) {
  const first = seg.shots[0]
  const last = seg.shots[seg.shots.length - 1]
  const startTime = first.startTime
  const endTime = last.endTime
  const shotNumbers = seg.shots.map((s) => s.shotNumber)
  const shotIds = seg.shots.map((s) => s.id)

  // 段前锚（语义分两种，出片时区分）：
  //   · 场首段（segIndexInScene === 1）→ 无锚开场（纯参考槽）。跨场硬边界，不透传上一场末帧。
  //   · 场次内第 2 段及之后 → 锚 = **上一段成片的末帧**，该帧在上一段出片成功后才存在
  //     （场一实测：段1 出完抽末帧 → uploads/continuity/segN_last.jpg → 段2 引用）。
  //     本模块只算"是否需要段间接力锚"，不预先给 URL；出片模块按 anchorMode 动态注入。
  const anchorMode = segIndexInScene === 1 ? 'none' : 'prev-segment-last'
  // 兼容：若本段首镜已有镜级 continuity_url（场上已逐镜出过片），记下来供复用判断
  const existingShotAnchor = String(first.continuityUrl || '')

  // 保险 1：段长校验
  // ⚠️ 判定口径 = 与出片/切片同一个「区间长度」（P1-2 修复）：旧写法用 `Σ镜duration`，
  //    与 segmentPrompt/路由的 `end_time - start_time` 各异，镜表一漂移就静默不一致。
  // ⚠️ 合法性判定必须取**未 clamp 的原始区间**（clamp=false）：否则「先夹到 3–15 再判
  //    是否落在 3–15」永远为真，unusable 永远检不出来（自证闭环）。
  const rawSpanSec = segmentDurationSec({ start_time: startTime, end_time: endTime }, seg.shots, { clamp: false })
  // 落库/展示用的段时长取 clamp 后的值（= 实际会生成的秒数）
  const spanSec = segmentDurationSec({ start_time: startTime, end_time: endTime }, seg.shots)
  const sumDurSec = seg.durationSec
  // 镜表内部不自洽（Σduration ≠ 原始区间）时告警但不阻断：这是数据卫生问题，
  // 出片/切片统一按区间长度走，行为是确定的。
  if (Math.abs(sumDurSec - rawSpanSec) > 0.001) {
    warnings.push(
      `场${sceneNumber} 段（${shotNumbers.join('+')}）镜表不自洽：`
      + `各镜 duration 之和 ${sumDurSec}s ≠ 区间长度 ${rawSpanSec.toFixed(3)}s；`
      + `出片与切片统一按区间长度执行，建议核对镜表 duration/end_time`
    )
  }
  const unusable = rawSpanSec < SEG_MIN_SEC || rawSpanSec > SEG_MAX_SEC
  if (unusable) {
    warnings.push(
      `场${sceneNumber} 段${segIndexGlobal}（${shotNumbers.join('+')}）时长 ${rawSpanSec}s 不合法（须 ${SEG_MIN_SEC}–${SEG_MAX_SEC}s）：该段标 unusable，调用方降级为逐镜出片`
    )
  }

  // 保险 2：台词切点冲突（段边界落在某镜台词播放区间内 → 台词被切两半）
  const dlg = dialogueRanges(seg.shots, startTime)
  const conflicts = []
  for (const d of dlg) {
    // 段内台词若跨出段尾（relEnd > 段长 + 0.2s 容差），说明台词被下一段切掉
    if (d.relEnd > seg.durationSec + 0.2) {
      conflicts.push(`台词"${d.text}"（${d.character}）估算 ${d.relStart.toFixed(1)}–${d.relEnd.toFixed(1)}s 超出段尾 ${seg.durationSec}s，可能被切断`)
    }
  }
  // 段首若正落在某镜台词中途（该台词的绝对起点早于段首）
  for (const d of dlg) {
    if (d.relStart < -0.1 && d.relEnd > 0.1) {
      conflicts.push(`段首落在台词"${d.text}"（${d.character}）播放中途，台词可能被上一段切走`)
    }
  }
  if (conflicts.length) {
    warnings.push(`场${sceneNumber} 段（${shotNumbers.join('+')}）台词切点冲突：${conflicts.join('；')}`)
  }

  return {
    segIndexGlobal,
    segIndexInScene,
    sceneNumber,
    shotIds,
    shotNumbers,
    startTime,
    endTime,
    // durationSec = **落库/生成用的权威段时长**（区间长度 clamp 到 3–15）= H3 实际生成秒数。
    // rawSpanSec  = 未 clamp 的原始区间长度（合法性判定依据，仅诊断用）。
    // sumDurationSec = 各镜 duration 之和（仅用于自洽性核对/展示，不参与行为决策）。
    durationSec: spanSec,
    rawSpanSec,
    sumDurationSec: sumDurSec,
    anchorMode,
    anchorFrameUrl: existingShotAnchor,
    status: unusable ? 'unusable' : 'pending',
    dialogue: dlg.map((d) => ({ character: d.character, text: d.text, relStart: Number(d.relStart.toFixed(3)), relEnd: Number(d.relEnd.toFixed(3)) })),
    conflicts,
    // 已出片的镜（可复用，不必重出）
    existingVideoUrls: seg.shots.map((s) => s.videoUrl || '').filter(Boolean),
  }
}

function summarize(scenes) {
  let shotCount = 0
  let segCount = 0
  let totalSec = 0
  let unusableCount = 0
  let existingSegCount = 0
  for (const sc of scenes) {
    for (const s of sc.segments) {
      segCount++
      shotCount += s.shotIds.length
      totalSec += s.durationSec
      if (s.status === 'unusable') unusableCount++
      if (s.existingVideoUrls.length === s.shotIds.length) existingSegCount++
    }
  }
  return {
    sceneCount: scenes.length,
    shotCount,
    segCount,
    totalSec,
    unusableCount,
    existingSegCount,
    savedGenerations: shotCount - segCount,
  }
}

/** 人话格式化（CLI / 日志用） */
export function formatPlan(plan) {
  const L = []
  L.push(`第 ${plan.episodeId} 集段方案`)
  L.push('')
  for (const sc of plan.scenes) {
    L.push(`场 ${sc.sceneNumber}（${sc.segments.reduce((n, s) => n + s.shotIds.length, 0)} 镜 → ${sc.segments.length} 段）`)
    for (const s of sc.segments) {
      const flag = s.status === 'unusable' ? ' ❌非法' : ''
      const reuse = s.existingVideoUrls.length === s.shotIds.length ? ' ♻️可复用' : ''
      const anchor = s.anchorMode === 'prev-segment-last' ? ' 锚:接上段末帧' : ' 无锚开场'
      L.push(`  段${s.segIndexGlobal} [${s.shotNumbers.join('+')}] ${s.durationSec}s${anchor}${flag}${reuse}`)
      if (s.dialogue.length) {
        L.push(`      台词: ${s.dialogue.map((d) => `${d.character}"${d.text}"@${d.relStart}s`).join(' · ')}`)
      }
      if (s.conflicts.length) L.push(`      ⚠️ ${s.conflicts.join('；')}`)
    }
  }
  const t = plan.totals
  L.push('')
  L.push(`${t.sceneCount} 场 / ${t.shotCount} 镜 / ${t.totalSec}s / ${t.segCount} 段`)
  L.push(`生成次数 ${t.shotCount} → ${t.segCount}（省 ${t.savedGenerations} 次，${Math.round((t.savedGenerations / t.shotCount) * 100)}%）`)
  if (t.unusableCount) L.push(`⚠️ ${t.unusableCount} 段非法，需降级逐镜出片`)
  if (t.existingSegCount) L.push(`♻️ ${t.existingSegCount} 段已有成片可复用`)
  if (plan.warnings.length) {
    L.push('')
    L.push('告警：')
    for (const w of plan.warnings) L.push(`  · ${w}`)
  }
  return L.join('\n')
}

/**
 * 落库：把段方案写入 video_segments。
 *
 * 幂等策略（2026-09-15 定，同日审计修复 P0-D/P1-2/P2-1）：
 *   · 默认**只补不删**——已存在 done/出片中的段一律保留（成片是真金白银换的），
 *     只对 missing 的 (scene_number, segment_index) 插 pending 行。
 *   · replace=true 时先删该集**所有非 done** 的段（pending/failed/unusable），done 段仍保留。
 *     用于段边界调整后重算（已出的段不会白扔）。
 *
 * 边界漂移（P0-D，核心修复）：
 *   同键（scene:segment_index）的 done 段**不能只看键存不存在就跳过**——重算后同一个键
 *   可能对应一组完全不同的镜。若盲目保留，会出现「同一镜被两个段声称拥有」，
 *   切片回填时互相覆盖 shots.video_url，卡片播哪个视频不确定。
 *   故命中 done 键时必须**逐元素比对 shot_ids**（顺序敏感）：
 *     · 一致 → kept++，跳过插入（真·同一段）
 *     · 不一致 → 标 stale（不动边界，见下），stale++，且不插入同键新行（键唯一，插了冲突）
 *
 * stale 为什么不就地改边界（C2 策略）：
 *   就地 UPDATE shot_ids 会让「记录=新边界」而「video_url=旧边界成片」自相矛盾，
 *   后续 sliceSegment 会拿新边界去切旧成片 → 切出的内容错位。
 *   保留边界不动，可维持「这条记录与其成片始终自洽」这个不变量，
 *   由 stale 状态 + error 文案把决策权交给用户（重出 or 忽略）。
 *
 * ⚠️ unusable 段不再让整批落库失败（2026-09-16 审核修复 P1-1）：
 *   旧实现是 `throw`「方案含 N 个非法段，拒绝落库」——**整批拒绝**。
 *   但 UI（VideoView.vue 的 generateScene / sceneSegmentStats / 按钮 title）早已按
 *   「段队列里存在 unusable 段、出片时跳过它们、对用户明示 ⚠ 需逐镜出片」来设计。
 *   两套语义互斥的结果是：只要全集**有一个**镜超 15s，整集段方案就无法落库，
 *   UI 那套跳过 unusable 的分支成为**永远走不到的死代码**，用户既拿不到能跑的段，
 *   也拿不到「被跳过的那几段」的提示——比"部分降级"更糟。
 *   现在改为：**过滤掉 unusable 段后落库其余段**，被跳过的段号通过返回值 `skipped`
 *   上报（调用方转成告警展示）。空方案（全部 unusable）仍拒绝——那不是降级，是无方案。
 *
 * @returns {{ inserted: number, kept: number, stale: number, skipped: Array<{sceneNumber, segmentIndex, shotNumbers, durationSec}> }}
 *
 * ⚠️ `replace` 默认 **true**（2026-09-16 修正）。旧默认 false 是个陷阱：
 *   `replace=false` 只「补缺键、不删旧行」，而**指纹只在 INSERT 时写入**——
 *   已存在的键永远走不到 INSERT，于是空指纹**永远不会被修复**。
 *   而全站过期文案恰恰让用户「重算段方案」来恢复指纹：默认值下点了也没用，
 *   形成「报错 → 重算 → 仍报错」死循环（实测 ins1/kept20，22 段空指纹原样保留）。
 *   更根本的是：镜表指纹是**整集级**的，任一镜变化都会让全集段失效，
 *   所以「部分保留旧段」在本机制下不可能产出自洽结果 —— replace=false 无正确用例。
 *   注：replace=true 只删 `status <> 'done'` 的行，**已出片的段始终保留**（见下方 DELETE 子句）。
 */
export function persistSegments(plan, { replace = true, episodeId = null } = {}) {
  const epId = episodeId ?? plan.episodeId

  // 空方案拒绝落库（P1-2）：必须在任何 DELETE 之前拦——
  // 否则 replace=true 会「先删光该集非 done 段、再一行不插」。
  if (!plan.scenes.length || plan.isEmpty) {
    throw new Error('段方案为空，拒绝落库（该集没有镜头，或指定场次无镜）')
  }
  // 从计划里剔除 unusable 段（不落库、不进 DELETE 后的重建循环），只报给调用方
  const skipped = []
  for (const sc of plan.scenes) {
    for (const s of sc.segments) {
      if (s.status === 'unusable') {
        skipped.push({
          sceneNumber: s.sceneNumber,
          segmentIndex: s.segIndexInScene,
          shotNumbers: s.shotNumbers,
          durationSec: s.durationSec,
        })
      }
    }
  }
  const usableSegCount = plan.totals.segCount - skipped.length
  if (usableSegCount <= 0) {
    throw new Error(`方案 ${plan.totals.segCount} 段全部为非法段（时长不在 ${SEG_MIN_SEC}–${SEG_MAX_SEC}s），拒绝落库（请先修镜长）`)
  }

  const keptRows = query(
    'SELECT id, scene_number, segment_index, status, shot_ids, shots_fp FROM video_segments WHERE episode_id = ?',
    [epId]
  )
  const keptKeys = new Set(keptRows.map((r) => `${r.scene_number}:${r.segment_index}`))
  // done 段明细：键 → { id, shotIds 数组, shotsFp }，供内容比对
  const doneByKey = new Map()
  for (const r of keptRows) {
    if (r.status !== 'done') continue
    let ids = []
    try { const p = JSON.parse(r.shot_ids || '[]'); ids = Array.isArray(p) ? p.map(Number) : [] } catch { ids = [] }
    doneByKey.set(`${r.scene_number}:${r.segment_index}`, { id: r.id, shotIds: ids, shotsFp: String(r.shots_fp || '') })
  }

  if (replace) {
    execute(
      "DELETE FROM video_segments WHERE episode_id = ? AND status <> 'done'",
      [epId]
    )
    for (const k of [...keptKeys]) {
      if (!doneByKey.has(k)) keptKeys.delete(k)
    }
  }

  const fpChanged = Boolean(plan.shotsFp)

  let inserted = 0
  let kept = 0
  let stale = 0
  for (const sc of plan.scenes) {
    for (const s of sc.segments) {
      // unusable 段不落库（见函数头注 P1-1）：已由 skipped 上报，调用方转为告警展示。
      // 必须在 DELETE 之后的插入循环里跳过——否则它们会被当成正常 pending 段插入。
      if (s.status === 'unusable') continue
      const key = `${s.sceneNumber}:${s.segIndexInScene}`
      const doneRow = keptKeys.has(key) ? doneByKey.get(key) : null

      if (doneRow) {
        // 逐元素比对（顺序敏感）：同键同内容 = 真·同一段，可保留
        const wantIds = s.shotIds.map(Number)
        const sameShots = doneRow.shotIds.length === wantIds.length
          && doneRow.shotIds.every((id, i) => id === wantIds[i])
        // 指纹变了但边界没变（如仅镜时长微调）：成片时长可能已与镜表不符，也判 stale
        const fpStale = fpChanged && doneRow.shotsFp && doneRow.shotsFp !== plan.shotsFp

        if (sameShots && !fpStale) {
          kept++
          continue
        }
        // 边界漂移或指纹失配 → 标 stale（不动边界，保留 video_url 与其自洽性）
        const reason = sameShots
          ? '分镜已修改（镜表指纹变化），段成片时长可能与镜表不符，需确认是否重出'
          : '分镜已变，段边界与现值不符（本段现含 '
            + s.shotNumbers.join('+') + '，与已出片的段不一致），需重出'
        execute(
          "UPDATE video_segments SET status = 'stale', error = ?, shots_fp = ? WHERE id = ?",
          [reason, plan.shotsFp || '', doneRow.id]
        )
        stale++
        continue // 同键不插入新行（键唯一，插了会冲突）
      }

      if (keptKeys.has(key)) { kept++; continue } // 非 done 且未 replace：出片中的段保留
      execute(
        `INSERT INTO video_segments
           (episode_id, scene_number, segment_index, shot_ids, shot_numbers,
            start_time, end_time, video_url, anchor_frame_url, trim_start, shots_fp, status, error)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          epId,
          s.sceneNumber,
          s.segIndexInScene,
          JSON.stringify(s.shotIds),
          s.shotNumbers.join('>'),
          s.startTime,
          s.endTime,
          '',
          s.anchorFrameUrl || '',
          0,
          plan.shotsFp || '',
          s.status,
          '',
        ]
      )
      inserted++
    }
  }
  return { inserted, kept, stale, skipped }
}
