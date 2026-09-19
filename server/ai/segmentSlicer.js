
import fs from 'node:fs'
import path from 'node:path'
import { query, queryOne, execute, transaction } from '../db.js'
import { segmentStaleness } from './segmentBuilder.js'
import { recordAlert } from './alerts.js'
import { uploadsUrlToAbs } from './shared.js'
import { uploadsDir } from '../paths.js'



const MIN_SLICE_SEC = 0.8

export function uploadsToAbs(url) {
  return uploadsUrlToAbs(url, uploadsDir)
}

async function probeDuration(absPath) {
  const probe = await runFfmpeg(['-i', absPath], { maxBuffer: 4 * 1024 * 1024 }).catch((e) => e)
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(String(probe?.stderr || ''))
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : null
}

async function cutOne(absIn, outAbs, startSec, durSec) {
  fs.mkdirSync(path.dirname(outAbs), { recursive: true })
  const tmpAbs = `${outAbs}.${process.pid}.tmp.mp4`
  try {
    await runFfmpeg([
      '-y',
      '-i', absIn,
      '-ss', String(startSec),
      '-t', String(durSec),
      '-c:v', 'libx264', '-crf', '18', '-preset', 'medium',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
      '-movflags', '+faststart',
      '-fps_mode', 'passthrough',
      tmpAbs,
    ], { maxBuffer: 64 * 1024 * 1024 })
    fs.renameSync(tmpAbs, outAbs)
  } catch (err) {
    try { fs.rmSync(tmpAbs, { force: true }) } catch {  }
    throw err
  }
}

export async function sliceSegment(segmentId, opts = {}) {
  const seg = queryOne('SELECT * FROM video_segments WHERE id = ?', [segmentId])
  if (!seg) return { success: false, warning: `段 ${segmentId} 不存在` }
  if (seg.status !== 'done' || !seg.video_url) {
    return { success: false, warning: `段 ${segmentId} 未出片（status=${seg.status}），先出片再切` }
  }

  let shotIds = []
  try { shotIds = JSON.parse(seg.shot_ids || '[]') } catch { shotIds = [] }
  if (!shotIds.length) return { success: false, warning: `段 ${segmentId} shot_ids 为空` }

  const absIn = uploadsToAbs(seg.video_url)
  if (!absIn) return { success: false, warning: `段成片本地缺失：${seg.video_url}` }

  const placeholders = shotIds.map(() => '?').join(',')
  const rows = query(
    `SELECT id, shot_number, storyboard_scene_id, start_time, end_time, duration, video_url
       FROM shots WHERE id IN (${placeholders})`,
    shotIds
  )
  const byId = new Map(rows.map((s) => [Number(s.id), s]))
  const shots = shotIds.map((id) => byId.get(Number(id))).filter(Boolean)

  const staleReasons = []
  if (shots.length !== shotIds.length) {
    staleReasons.push(`段内 ${shotIds.length} 镜中有 ${shotIds.length - shots.length} 镜已被删除或重建`)
  }
  const sceneIds = new Set(shots.map((s) => Number(s.storyboard_scene_id)))
  if (sceneIds.size > 1) {
    staleReasons.push(`段内镜已不属于同一场（查到 ${sceneIds.size} 个场），分镜已重排`)
  }
  const fp = segmentStaleness(seg)
  if (fp.stale) staleReasons.push(fp.reason)

  if (staleReasons.length) {
    const reason = `段 ${seg.scene_number}-${seg.segment_index}（${seg.shot_numbers}）记录已过期：${staleReasons.join('；')}。请到分镜页重算段方案后重出，本段不再切片。`
    execute("UPDATE video_segments SET status = 'stale', error = ? WHERE id = ?", [reason.slice(0, 500), segmentId])
    try {
      recordAlert({
        level: 'error', source: 'writeback', episodeId: seg.episode_id,
        shotId: shots[0]?.id ?? null, shotNumber: String(shots[0]?.shot_number || ''),
        message: reason, detail: { segmentId, staleReasons, storedFp: seg.shots_fp, currentFp: fp.currentFingerprint },
      })
    } catch {  }
    return { success: false, stale: true, warning: reason }
  }

  for (let i = 1; i < shots.length; i++) {
    if (Number(shots[i].start_time) < Number(shots[i - 1].start_time)) {
      console.warn(`[segmentSlicer] 段${segmentId} 镜序与 start_time 不同调（第 ${i} 镜 ${shots[i].shot_number}）：按存储序切片，请核查段记录`)
      break
    }
  }

  const trimStart = Number(seg.trim_start) || 0
  const segStart = Number(seg.start_time) || 0
  const segEnd = Number(seg.end_time) || 0
  const videoDur = await probeDuration(absIn)

  const plannedTotal = Math.max(0, (segEnd - segStart) + trimStart)
  const cuts = shots.map((s, i) => {
    const relStart = Number(s.start_time) - segStart
    const start = Math.max(0, relStart + trimStart)
    const next = i + 1 < shots.length
      ? Math.max(0, Number(shots[i + 1].start_time) - segStart + trimStart)
      : null
    const plannedEnd = next != null ? next : plannedTotal
    const avail = videoDur != null ? Math.min(videoDur, plannedEnd) : plannedEnd
    const dur = next != null ? (next - start) : (avail - start)
    return { shot: s, index: i, start: Number(start.toFixed(3)), dur: Number(Math.max(MIN_SLICE_SEC, dur).toFixed(3)) }
  })

  if (videoDur != null) {
    const declaredSec = Math.max(0, segEnd - segStart)
    const overflowSec = videoDur - plannedTotal
    if (overflowSec > 0.05) {
      console.warn(
        `[segmentSlicer] 段${segmentId} 尾部溢出 ${overflowSec.toFixed(2)}s 已丢弃（设计行为）：`
        + `段声明 ${declaredSec.toFixed(2)}s + 前跳 trim ${trimStart.toFixed(2)}s = ${plannedTotal.toFixed(2)}s，`
        + `源视频实测 ${videoDur.toFixed(2)}s；末镜收尾约 ${overflowSec.toFixed(2)}s 素材不进成片`
        + `${overflowSec > 0.5 ? '（>0.5s，建议复查该段 AI 声明时长是否偏短）' : ''}`
      )
    }
  }

  const tooShort = cuts.filter((c) => c.dur < MIN_SLICE_SEC)
  if (tooShort.length) {
    return {
      success: false,
      warning: `切点异常：${tooShort.map((c) => `镜${c.shot.shot_number} ${c.dur}s`).join('、')} 短于 ${MIN_SLICE_SEC}s——段成片切点与镜表不符，未切片（先核查段内镜时长）`,
    }
  }

  if (opts.dryRun) {
    return { success: true, dryRun: true, slices: cuts.map((c) => ({ shotId: c.shot.id, shotNumber: c.shot.shot_number, start: c.start, dur: c.dur })) }
  }

  const outDirRel = path.join('segments', `seg${segmentId}`)
  const outDirAbs = path.join(uploadsDir, outDirRel)
  fs.mkdirSync(outDirAbs, { recursive: true })

  const slices = []
  const skipped = []
  for (const c of cuts) {
    const fileName = `${String(c.shot.shot_number).replace(/[^\w-]/g, '_')}_${c.shot.id}.mp4`
    const outAbs = path.join(outDirAbs, fileName)
    const outUrl = `/uploads/${outDirRel.replace(/\\/g, '/')}/${fileName}`

    let reuse = false
    if (!opts.force && fs.existsSync(outAbs)) {
      const existDur = await probeDuration(outAbs)
      reuse = existDur != null && Math.abs(existDur - c.dur) <= 0.2
    }

    if (reuse) {
      skipped.push({ shotId: c.shot.id, shotNumber: c.shot.shot_number, url: outUrl })
    } else {
      try {
        await cutOne(absIn, outAbs, c.start, c.dur)
      } catch (err) {
        return {
          success: false,
          warning: `镜 ${c.shot.shot_number} 切片失败（起 ${c.start}s 长 ${c.dur}s）：${String(err.message || err).slice(0, 300)}。本段所有镜均未回填（避免半个段）。`,
          slices: [],
        }
      }
    }

    slices.push({
      shotId: c.shot.id,
      shotNumber: c.shot.shot_number,
      url: outUrl,
      start: c.start,
      dur: c.dur,
      reused: reuse,
    })
  }

  transaction(() => {
    for (const sl of slices) {
      execute(
        "UPDATE shots SET video_url = ?, video_generated = 1 WHERE id = ?",
        [sl.url, sl.shotId]
      )
    }
  })

  console.log(`[segmentSlicer] 段${segmentId} 切片完成：${slices.length} 份（复用 ${skipped.length}）`)

  return { success: true, slices, skipped }
}

export async function extractSegmentLastFrame(segmentId) {
  const seg = queryOne('SELECT * FROM video_segments WHERE id = ?', [segmentId])
  if (!seg) return { success: false, warning: `段 ${segmentId} 不存在` }
  if (!seg.video_url) return { success: false, warning: `段 ${segmentId} 无成片，抽不到末帧` }

  const absIn = uploadsToAbs(seg.video_url)
  if (!absIn) return { success: false, warning: `段成片本地缺失：${seg.video_url}` }

  const relPath = path.join('continuity', `seg${segmentId}_last.jpg`)
  const absOut = path.join(uploadsDir, relPath)
  fs.mkdirSync(path.dirname(absOut), { recursive: true })

  try {
    await runFfmpeg(['-y', '-sseof', '-0.1', '-i', absIn, '-update', '1', '-frames:v', '1', absOut])
  } catch (err) {
    return { success: false, warning: `段${segmentId} 末帧抽取失败：${String(err.message || err).slice(0, 200)}` }
  }
  if (!fs.existsSync(absOut)) return { success: false, warning: `段${segmentId} 末帧文件未生成` }

  const url = `/uploads/continuity/seg${segmentId}_last.jpg`
  return { success: true, url, absPath: absOut }
}

export async function sliceEpisode(episodeId, opts = {}) {
  let sql = "SELECT id FROM video_segments WHERE episode_id = ? AND status = 'done' ORDER BY scene_number, segment_index"
  const params = [episodeId]
  if (opts.scene != null) { sql = "SELECT id FROM video_segments WHERE episode_id = ? AND scene_number = ? AND status = 'done' ORDER BY segment_index"; params.push(Number(opts.scene)) }
  const segRows = query(sql, params)

  const results = []
  for (const r of segRows) {
    const res = await sliceSegment(r.id, { force: opts.force })
    results.push({ segmentId: r.id, ...res })
  }
  const ok = results.filter((r) => r.success).length
  return {
    total: results.length,
    ok,
    failed: results.filter((r) => !r.success).map((r) => ({ segmentId: r.segmentId, warning: r.warning })),
    results,
  }
}
