// 成片打捞守护（2026-09-15）：本地化全灭（v4Video 3 次退避 + 路由 3 次重试 + 备用节点）之后，
// 旧逻辑只发一条告警就完事——RH COS 裸 URL 实测 ~1 小时内 404，告警没人立刻看到 = 成片永久丢
//（第 2 集 1-2 / 1-4 / 2-2 三镜实踩）。本模块在 server 进程内挂定时器：
//   每 5 分钟扫打捞队列 → 重查任务全部输出节点拿新链接 + 原 URL 一起重试（ftyp 校验）→
//   捞到：写本地文件、回写目标、销队列、记 info 告警；
//   超 50 分钟窗口未捞到：标 dead、升级 error 告警（此时云端链接大概率已死，需重出）。
// 队列落 DB（salvage_queue 表），server 重启后守护自动恢复，不丢任务。
//
// 2026-09-16 扩展：**段级目标**（target_kind='segment'）。
//   原实现只认镜头（shot_id NOT NULL），段级出片本地化失败时 video_url 是 24h 云端链接——
//   而切片器只认本地 /uploads/ 路径 → **永不切片** → 段内镜 video_url 永久为空，
//   币花了、镜表却没有画面（段是主要出片路径，这个洞比单镜更致命）。
//   段级捞到后必须**补跑切片**，否则只恢复段、段内镜仍是空的。
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { query, execute } from './db.js'
import { insecureDownload, isPlausibleMp4, queryTaskOutput } from './ai/runninghub.js'
import { recordAlert } from './ai/alerts.js'

const serverDir = path.dirname(fileURLToPath(import.meta.url))
const uploadsDir = path.join(serverDir, 'uploads')

const WINDOW_MS = 50 * 60 * 1000   // 打捞窗口：COS 裸 URL 实测 ~1 小时内 404，留 10 分钟余量
const INTERVAL_MS = 5 * 60 * 1000  // 扫描间隔

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

// 迁移（历史库）：补 target_kind / segment_id。
//   target_kind：'shot'（默认，兼容全部历史行）| 'segment'
//   segment_id ：段级目标的 video_segments.id（镜头目标为 NULL）
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

/**
 * 登记打捞（本地化全灭点调用）。同一目标已有 pending 行则刷新 url/task_id（重出会产生新链接），不重复插行。
 *
 * 两种目标：
 *   · 镜头：{ shotId, shotNumber, episodeId, taskId, url }
 *   · 段  ：{ segmentId, segmentLabel, episodeId, taskId, url }
 *     （segmentLabel 形如 "1-1（1-1>1-2）"，仅用于文案；复用 shot_number 字段落库）
 * 幂等键按目标类型区分——段的 shot_id 记 0，语义上必须与镜头分开判。
 */
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

/** 统一的目标描述（告警文案用） */
function describeTarget(row) {
  return row.target_kind === 'segment'
    ? `段 ${row.shot_number || row.segment_id}`
    : `镜 ${row.shot_number || row.shot_id}`
}

/** 收集某行的候选链接：库中原 URL + 重查任务的全部输出节点 */
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
    } catch { /* 该链接失败，试下一个 */ }
  }
  return null
}

async function salvageOnce() {
  const rows = query(`SELECT * FROM salvage_queue WHERE status = 'pending' ORDER BY enqueued_at`)
  if (!rows.length) return
  for (const row of rows) {
    const ageMs = Date.now() - new Date(row.enqueued_at).getTime()
    // 超窗：云端链接大概率已死，标 dead 并升级告警（此后只能重出）
    if (ageMs > WINDOW_MS) {
      execute(`UPDATE salvage_queue SET status = 'dead', last_attempt_at = ?, last_error = '打捞窗口耗尽' WHERE id = ?`, [new Date().toISOString(), row.id])
      recordAlert({ episodeId: row.episode_id, shotId: Number(row.shot_id) || null, shotNumber: row.shot_number, source: 'salvage', level: 'error',
        message: `${describeTarget(row)} 成片打捞失败：50 分钟窗口内 ${row.attempts} 次尝试全灭，云端链接已过期——需重新出片` })
      console.warn(`[salvage] ${describeTarget(row)} 打捞窗口耗尽（${row.attempts} 次），标 dead`)
      continue
    }
    try {
      // 候选链接：原 URL + 重查任务拿到的全部输出节点（节点间寿命不同，2-2 实锤主节点 404、备用节点完好）
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

/** 镜头级回写（原逻辑保持）：写本地 mp4 + 回写 shots.video_url（仅当库里仍是远程 URL） */
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
    // 库里已是本地新片：打捞到的旧片弃用（删掉，防误用）
    try { fs.unlinkSync(path.join(uploadsDir, filename)) } catch { /* ignore */ }
    execute(`UPDATE salvage_queue SET status = 'done', last_attempt_at = ?, last_error = '库里已是本地新片，打捞旧片弃用' WHERE id = ?`, [new Date().toISOString(), row.id])
    console.log(`[salvage] 镜 ${row.shot_number} 库里已是本地新片，打捞到的旧片弃用`)
  }
}

/**
 * 段级捞回后的补切片（关键一步）：
 *   段 video_url 一恢复成本地路径，切片器就能跑了。不补这一刀，段成片"看起来好了"，
 *   但段内镜的 video_url 仍是空的（卡片无画面）——正是段级打捞存在的意义所在。
 *   sliceSegment 自带指纹/缺镜校验，过期时返回 { success:false, stale:true }——属预期分支，
 *   不抛错、只落一条 error 告警提示人工重算段方案后手动切片。
 */
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

/** 段级回写：写本地 mp4 + 回写 video_segments.video_url/status（仅当库里仍是远程/空）+ 补切片 */
async function salvageSegmentRow(row, buf) {
  const segmentId = Number(row.segment_id)
  const filename = `segment_${segmentId}_salvage_${Date.now()}.mp4`
  fs.mkdirSync(uploadsDir, { recursive: true })
  fs.writeFileSync(path.join(uploadsDir, filename), buf)
  // 防覆盖口径同镜头级：库里若已被人工重出成**本地**片，则不覆盖（视为已恢复，销队列）
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
    try { fs.unlinkSync(path.join(uploadsDir, filename)) } catch { /* ignore */ }
    execute(`UPDATE salvage_queue SET status = 'done', last_attempt_at = ?, last_error = '库里段成片已是本地片，打捞旧片弃用' WHERE id = ?`, [new Date().toISOString(), row.id])
    console.log(`[salvage] 段 ${segmentId} 库里已是本地成片，打捞到的旧片弃用`)
  }
}

let timer = null
export function startSalvageWorker() {
  if (timer) return // 防重复挂载（热重载场景）
  // 首扫延迟 60s：避开 boot 期 DB/网络未稳，也给刚落库的登记行一点 COS 就绪时间
  setTimeout(() => { salvageOnce().catch((e) => console.warn('[salvage] 扫描异常:', e.message)) }, 60000)
  timer = setInterval(() => { salvageOnce().catch((e) => console.warn('[salvage] 扫描异常:', e.message)) }, INTERVAL_MS)
  timer.unref?.() // 不阻止进程退出（脚本化调用 server 模块时不挂死）
  console.log('[salvage] 成片打捞守护已启动（每 5 分钟扫描，50 分钟窗口；覆盖镜头与段）')
}

// 供离线测试直接调用单轮扫描（不启动定时器）
export { salvageOnce as salvageOnceForTest }
