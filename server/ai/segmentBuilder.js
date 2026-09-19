
import { createHash } from 'node:crypto'
import { parseDialogue } from './dialogue.js'
import { query, execute } from '../db.js'

export const SEG_MIN_SEC = 3
export const SEG_MAX_SEC = 15

export function segmentDurationSec(seg, shots = null, opts = {}) {
  const clamp = opts.clamp !== false
  const start = Number(seg?.start_time)
  const end = Number(seg?.end_time)
  let raw = Number.isFinite(start) && Number.isFinite(end) ? end - start : NaN
  if (!Number.isFinite(raw) || raw <= 0) {
    if (Array.isArray(shots) && shots.length) {
      raw = shots.reduce((a, s) => a + (Number(s?.duration) || 0), 0)
    }
  }
  if (!Number.isFinite(raw) || raw <= 0) raw = 5
  if (!clamp) return raw
  return Math.min(SEG_MAX_SEC, Math.max(SEG_MIN_SEC, Math.round(raw)))
}

const CHARS_PER_SECOND = 5

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


export function shotsFingerprint(episodeId) {
  const lines = []
  for (const g of loadEpisodeShots(episodeId)) {
    for (const s of g.shots) {
      lines.push(`${g.sceneNumber}:${s.id}:${s.shotNumber}:${s.startTime}:${s.endTime}:${s.duration}`)
    }
  }
  return createHash('md5').update(lines.join('\n'), 'utf8').digest('hex')
}

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

function packScene(shots) {
  const segs = []
  let cur = []
  let acc = 0
  for (const sh of shots) {
    if (sh.duration > SEG_MAX_SEC) {
      if (cur.length) { segs.push({ shots: cur, durationSec: acc }); cur = []; acc = 0 }
      segs.push({ shots: [sh], durationSec: sh.duration })
      continue
    }
    if (cur.length && acc + sh.duration > SEG_MAX_SEC) {
      segs.push({ shots: cur, durationSec: acc })
      cur = []
      acc = 0
    }
    cur.push(sh)
    acc += sh.duration
  }
  if (cur.length) segs.push({ shots: cur, durationSec: acc })

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

export function buildSegments(episodeId, opts = {}) {
  let sceneGroups = loadEpisodeShots(episodeId)
  if (opts.scene != null) sceneGroups = sceneGroups.filter((g) => g.sceneNumber === Number(opts.scene))

  const warnings = []
  const scenes = []
  let segIndexGlobal = 0
  const shotsFp = shotsFingerprint(episodeId)

  if (sceneGroups.length === 0) {
    warnings.push('该集没有镜头（或指定场次无镜），段方案为空')
    return { episodeId, scenes, totals: summarize(scenes), warnings, shotsFp, isEmpty: true }
  }

  const singleScene = sceneGroups.length <= 1
  if (singleScene && sceneGroups.length === 1) {
    const all = sceneGroups[0].shots
    const segs = packScene(all)
    const packed = segs.map((s, i) => finalizeSegment(s, episodeId, sceneGroups[0].sceneNumber, i + 1, all, ++segIndexGlobal, warnings))
    scenes.push({ sceneNumber: sceneGroups[0].sceneNumber, segments: packed })
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

function finalizeSegment(seg, episodeId, sceneNumber, segIndexInScene, sceneShots, segIndexGlobal, warnings) {
  const first = seg.shots[0]
  const last = seg.shots[seg.shots.length - 1]
  const startTime = first.startTime
  const endTime = last.endTime
  const shotNumbers = seg.shots.map((s) => s.shotNumber)
  const shotIds = seg.shots.map((s) => s.id)

  const anchorMode = segIndexInScene === 1 ? 'none' : 'prev-segment-last'
  const existingShotAnchor = String(first.continuityUrl || '')

  const rawSpanSec = segmentDurationSec({ start_time: startTime, end_time: endTime }, seg.shots, { clamp: false })
  const spanSec = segmentDurationSec({ start_time: startTime, end_time: endTime }, seg.shots)
  const sumDurSec = seg.durationSec
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

  const dlg = dialogueRanges(seg.shots, startTime)
  const conflicts = []
  for (const d of dlg) {
    if (d.relEnd > seg.durationSec + 0.2) {
      conflicts.push(`台词"${d.text}"（${d.character}）估算 ${d.relStart.toFixed(1)}–${d.relEnd.toFixed(1)}s 超出段尾 ${seg.durationSec}s，可能被切断`)
    }
  }
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
    durationSec: spanSec,
    rawSpanSec,
    sumDurationSec: sumDurSec,
    anchorMode,
    anchorFrameUrl: existingShotAnchor,
    status: unusable ? 'unusable' : 'pending',
    dialogue: dlg.map((d) => ({ character: d.character, text: d.text, relStart: Number(d.relStart.toFixed(3)), relEnd: Number(d.relEnd.toFixed(3)) })),
    conflicts,
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

export function persistSegments(plan, { replace = true, episodeId = null } = {}) {
  const epId = episodeId ?? plan.episodeId

  if (!plan.scenes.length || plan.isEmpty) {
    throw new Error('段方案为空，拒绝落库（该集没有镜头，或指定场次无镜）')
  }
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
      if (s.status === 'unusable') continue
      const key = `${s.sceneNumber}:${s.segIndexInScene}`
      const doneRow = keptKeys.has(key) ? doneByKey.get(key) : null

      if (doneRow) {
        const wantIds = s.shotIds.map(Number)
        const sameShots = doneRow.shotIds.length === wantIds.length
          && doneRow.shotIds.every((id, i) => id === wantIds[i])
        const fpStale = fpChanged && doneRow.shotsFp && doneRow.shotsFp !== plan.shotsFp

        if (sameShots && !fpStale) {
          kept++
          continue
        }
        const reason = sameShots
          ? '分镜已修改（镜表指纹变化），段成片时长可能与镜表不符，需确认是否重出'
          : '分镜已变，段边界与现值不符（本段现含 '
            + s.shotNumbers.join('+') + '，与已出片的段不一致），需重出'
        execute(
          "UPDATE video_segments SET status = 'stale', error = ?, shots_fp = ? WHERE id = ?",
          [reason, plan.shotsFp || '', doneRow.id]
        )
        stale++
        continue 
      }

      if (keptKeys.has(key)) { kept++; continue } 
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
