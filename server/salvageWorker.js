import path from 'node:path'
import fs from 'node:fs'
import { query, execute } from './db.js'
import { insecureDownload, isPlausibleMp4, queryTaskOutput } from './ai/runninghub.js'
import { recordAlert } from './ai/alerts.js'
import { uploadsDir } from './paths.js'


const WINDOW_MS = 50 * 60 * 1000   
const INTERVAL_MS = 5 * 60 * 1000  

execute(`CREATE TABLE IF NOT EXISTS salvage_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shot_id INTEGER NOT NULL DEFAULT 0,
  shot_number TEXT,
  episode_id INTEGER,
  task_id TEXT,
  url TEXT,
  enqueued_at TEXT NOT NULL,
  attempts INTEGER DEFAULT 0,
  last_attempt_at TEXT,
  last_error TEXT,
  status TEXT DEFAULT 'pending'
)`)

{
  const cols = query('PRAGMA table_info(salvage_queue)').map((c) => c.name)
  if (!cols.includes('target_kind')) {
    execute("ALTER TABLE salvage_queue ADD COLUMN target_kind TEXT NOT NULL DEFAULT 'shot'")
    console.log('[salvage] 迁移：salvage_queue 添加 target_kind 字段')
  }
  if (!cols.includes('segment_id')) {
    execute('ALTER TABLE salvage_queue ADD COLUMN segment_id INTEGER')
    console.log('[salvage] 迁移：salvage_queue 添加 segment_id 字段')
  }
}

export function enqueueSalvage({ shotId, shotNumber, segmentId, segmentLabel, episodeId, taskId, url }) {
  const isSegment = segmentId != null
  const targetKind = isSegment ? 'segment' : 'shot'
  try {
    const existing = isSegment
      ? query("SELECT id FROM salvage_queue WHERE segment_id = ? AND target_kind = 'segment' AND status = 'pending'", [Number(segmentId)])[0]
      : query("SELECT id FROM salvage_queue WHERE shot_id = ? AND target_kind = 'shot' AND status = 'pending'", [Number(shotId)])[0]
    const label = isSegment ? (segmentLabel || `段 ${segmentId}`) : (shotNumber || shotId)
    if (existing) {
      execute(`UPDATE salvage_queue SET task_id = COALESCE(?, task_id), url = COALESCE(?, url), episode_id = COALESCE(?, episode_id), shot_number = COALESCE(?, shot_number), enqueued_at = ?, attempts = 0, last_error = NULL WHERE id = ?`,
        [taskId || null, url || null, episodeId || null, label || null, new Date().toISOString(), existing.id])
    } else {
      execute(
        `INSERT INTO salvage_queue (shot_id, shot_number, episode_id, task_id, url, enqueued_at, target_kind, segment_id)
         VALUES (?,?,?,?,?,?,?,?)`,
        [isSegment ? 0 : (Number(shotId) || 0), label || null, episodeId || null, taskId || null, url || null,
          new Date().toISOString(), targetKind, isSegment ? Number(segmentId) : null]
      )
    }
    console.log(`[salvage] ${isSegment ? `段 ${label}` : `镜 ${label}`} 已登记打捞队列（taskId=${taskId || '无'}）`)
  } catch (e) {
    console.warn('[salvage] 登记打捞失败（不影响主流程）:', e.message)
  }
}

function describeTarget(row) {
  return row.target_kind === 'segment'
    ? `段 ${row.shot_number || row.segment_id}`
    : `镜 ${row.shot_number || row.shot_id}`
}

async function collectCandidates(row) {
  const candidates = new Set()
  if (row.url) candidates.add(row.url)
  if (row.task_id) {
    try {
      const q = await queryTaskOutput(row.task_id)
      for (const r of (Array.isArray(q?.allResults) ? q.allResults : [])) {
        if (r?.url) candidates.add(String(r.url))
      }
    } catch (e) {
      console.warn(`[salvage] ${describeTarget(row)} 重查任务输出失败（下轮再试）:`, e.message)
    }
  }
  return candidates
}

async function tryDownloadAny(candidateUrls) {
  for (const u of candidateUrls) {
    try {
      const buf = await insecureDownload(u)
      if (isPlausibleMp4(buf)) return buf
    } catch {  }
  }
  return null
}

async function salvageOnce() {
  const rows = query(`SELECT * FROM salvage_queue WHERE status = 'pending' ORDER BY enqueued_at`)
  if (!rows.length) return
  for (const row of rows) {
    const ageMs = Date.now() - new Date(row.enqueued_at).getTime()
    if (ageMs > WINDOW_MS) {
      execute(`UPDATE salvage_queue SET status = 'dead', last_attempt_at = ?, last_error = '打捞窗口耗尽' WHERE id = ?`, [new Date().toISOString(), row.id])
      recordAlert({ episodeId: row.episode_id, shotId: Number(row.shot_id) || null, shotNumber: row.shot_number, source: 'salvage', level: 'error',
        message: `${describeTarget(row)} 成片打捞失败：50 分钟窗口内 ${row.attempts} 次尝试全灭，云端链接已过期——需重新出片` })
      console.warn(`[salvage] ${describeTarget(row)} 打捞窗口耗尽（${row.attempts} 次），标 dead`)
      continue
    }
    try {
      const candidates = await collectCandidates(row)
      const buf = await tryDownloadAny([...candidates])
      if (!buf) {
        execute(`UPDATE salvage_queue SET attempts = attempts + 1, last_attempt_at = ?, last_error = ? WHERE id = ?`,
          [new Date().toISOString(), `${candidates.size} 个候选链接全部下载失败或校验不过`, row.id])
        console.warn(`[salvage] ${describeTarget(row)} 第 ${row.attempts + 1} 次打捞失败（${candidates.size} 个候选），5 分钟后再试`)
        continue
      }
      if (row.target_kind === 'segment') {
        await salvageSegmentRow(row, buf)
      } else {
        salvageShotRow(row, buf)
      }
    } catch (e) {
      execute(`UPDATE salvage_queue SET attempts = attempts + 1, last_attempt_at = ?, last_error = ? WHERE id = ?`,
        [new Date().toISOString(), String(e.message || e).slice(0, 200), row.id])
      console.warn(`[salvage] ${describeTarget(row)} 打捞异常（下轮再试）:`, e.message)
    }
  }
}

function salvageShotRow(row, buf) {
  const filename = `shot_${row.shot_id}_salvage_${Date.now()}.mp4`
  fs.mkdirSync(uploadsDir, { recursive: true })
  fs.writeFileSync(path.join(uploadsDir, filename), buf)
  const res = execute(`UPDATE shots SET video_url = ?, video_generated = 1 WHERE id = ? AND (video_url IS NULL OR video_url NOT LIKE '/uploads/%')`,
    [`/uploads/${filename}`, row.shot_id])
  if (res.changes > 0) {
    execute(`UPDATE salvage_queue SET status = 'done', last_attempt_at = ? WHERE id = ?`, [new Date().toISOString(), row.id])
    recordAlert({ episodeId: row.episode_id, shotId: row.shot_id, shotNumber: row.shot_number, source: 'salvage', level: 'info',
      message: `镜 ${row.shot_number} 成片打捞成功（第 ${row.attempts + 1} 次尝试）：已回写 /uploads/${filename}（${(buf.length / 1048576).toFixed(1)}MB），钩子链恢复可用` })
    console.log(`[salvage] ✓ 镜 ${row.shot_number} 打捞成功 → /uploads/${filename}（${(buf.length / 1048576).toFixed(1)}MB）`)
  } else {
    try { fs.unlinkSync(path.join(uploadsDir, filename)) } catch {  }
    execute(`UPDATE salvage_queue SET status = 'done', last_attempt_at = ?, last_error = '库里已是本地新片，打捞旧片弃用' WHERE id = ?`, [new Date().toISOString(), row.id])
    console.log(`[salvage] 镜 ${row.shot_number} 库里已是本地新片，打捞到的旧片弃用`)
  }
}

async function sliceAfterSegSalvage(segmentId, row) {
  try {
    const { sliceSegment } = await import('./ai/segmentSlicer.js')
    const r = await sliceSegment(Number(segmentId), { force: true })
    if (r?.success) {
      console.log(`[salvage] 段 ${segmentId} 捞回后补切片成功：${r.slices?.length || 0} 份`)
      return r
    }
    const msg = r?.stale
      ? '段方案已过期（指纹失配）'
      : (r?.warning || '未知原因')
    console.warn(`[salvage] 段 ${segmentId} 捞回后补切片未成功：${msg}`)
    recordAlert({
      episodeId: row.episode_id, shotId: null, shotNumber: String(row.shot_number || ''),
      source: 'salvage', level: 'error',
      message: `段 ${row.shot_number || segmentId} 成片已捞回本地，但补切片未成功（${msg}）。段内镜头仍无画面——请在分镜页重算段方案后手动切片。`,
    })
    return r
  } catch (e) {
    console.warn(`[salvage] 段 ${segmentId} 补切片异常：`, e.message)
    recordAlert({
      episodeId: row.episode_id, shotId: null, shotNumber: String(row.shot_number || ''),
      source: 'salvage', level: 'error',
      message: `段 ${row.shot_number || segmentId} 成片已捞回本地，但补切片抛错：${String(e.message || e).slice(0, 200)}。段内镜头仍无画面。`,
    })
    return null
  }
}

async function salvageSegmentRow(row, buf) {
  const segmentId = Number(row.segment_id)
  const filename = `segment_${segmentId}_salvage_${Date.now()}.mp4`
  fs.mkdirSync(uploadsDir, { recursive: true })
  fs.writeFileSync(path.join(uploadsDir, filename), buf)
  const res = execute(
    `UPDATE video_segments SET video_url = ?, status = 'done', error = ''
      WHERE id = ? AND (video_url IS NULL OR video_url = '' OR video_url NOT LIKE '/uploads/%')`,
    [`/uploads/${filename}`, segmentId]
  )
  if (res.changes > 0) {
    console.log(`[salvage] ✓ 段 ${segmentId} 打捞成功 → /uploads/${filename}（${(buf.length / 1048576).toFixed(1)}MB），开始补切片`)
    execute(`UPDATE salvage_queue SET status = 'done', last_attempt_at = ? WHERE id = ?`, [new Date().toISOString(), row.id])
    recordAlert({ episodeId: row.episode_id, shotId: null, shotNumber: String(row.shot_number || ''), source: 'salvage', level: 'info',
      message: `段 ${row.shot_number || segmentId} 成片打捞成功（第 ${row.attempts + 1} 次尝试）：已回写本地并自动补切片，段内镜头画面恢复` })
    await sliceAfterSegSalvage(segmentId, row)
  } else {
    try { fs.unlinkSync(path.join(uploadsDir, filename)) } catch {  }
    execute(`UPDATE salvage_queue SET status = 'done', last_attempt_at = ?, last_error = '库里段成片已是本地片，打捞旧片弃用' WHERE id = ?`, [new Date().toISOString(), row.id])
    console.log(`[salvage] 段 ${segmentId} 库里已是本地成片，打捞到的旧片弃用`)
  }
}

let timer = null
export function startSalvageWorker() {
  if (timer) return 
  setTimeout(() => { salvageOnce().catch((e) => console.warn('[salvage] 扫描异常:', e.message)) }, 60000)
  timer = setInterval(() => { salvageOnce().catch((e) => console.warn('[salvage] 扫描异常:', e.message)) }, INTERVAL_MS)
  timer.unref?.() 
  console.log('[salvage] 成片打捞守护已启动（每 5 分钟扫描，50 分钟窗口；覆盖镜头与段）')
}

export { salvageOnce as salvageOnceForTest }
