import { randomUUID } from 'node:crypto'
import { uploadsUrl, uploadsDir } from '../paths.js'
import { query, queryOne, execute } from '../db.js'
import { config } from '../config.js'
import { insecureDownload, isPlausibleMp4, queryTaskOutput } from '../ai/runninghub.js'
import { recordAlert } from '../ai/alerts.js'
import { DEFAULT_VIDEO_ENGINE } from '../ai/videoEngines.js'

import fs from 'node:fs'
import path from 'node:path'

// ── 出片任务执行器 ─────────────────────────────────────────────
// 提交与执行分离：POST /video-v4|v3 只做校验+建单（毫秒级返回 jobId），
// 真正的生成在这里排队执行。状态全量落 video_jobs 表——页面刷新、
// 浏览器关闭、服务重启都能凭 jobId/shotId 查到任务现状。
//
// 执行器与生成实现解耦：generate-video.js 启动时调用
// registerVideoJobExecutor(engine, fn) 注入具体生成函数，避免循环依赖。

const executors = new Map()   // engine -> async (job) => { success, url, taskId, warning, ... }
let runningCount = 0

export function registerVideoJobExecutor(engine, fn) {
  executors.set(engine, fn)
}

function concurrency() {
  const n = Number(config.video?.jobConcurrency)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2
}

export function getActiveJobForShot(shotId) {
  return queryOne(
    `SELECT * FROM video_jobs WHERE shot_id = ? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`,
    [Number(shotId)]
  )
}

export function createVideoJob({ episodeId, shotId, engine, params }) {
  const existing = getActiveJobForShot(shotId)
  if (existing) return { job: existing, duplicated: true }
  const job = {
    id: randomUUID(),
    episode_id: Number(episodeId),
    shot_id: Number(shotId),
    engine: engine || DEFAULT_VIDEO_ENGINE,
    status: 'queued',
    phase: '排队中',
    provider_task_id: '',
    error: '',
    result_url: '',
    params_json: JSON.stringify(params || {}),
    attempts: 0,
  }
  execute(
    `INSERT INTO video_jobs (id, episode_id, shot_id, engine, status, phase, provider_task_id, error, result_url, params_json, attempts)
     VALUES (@id, @episode_id, @shot_id, @engine, @status, @phase, @provider_task_id, @error, @result_url, @params_json, @attempts)`,
    job
  )
  kickQueue()
  return { job, duplicated: false }
}

export function updateJobProgress(jobId, { phase, providerTaskId } = {}) {
  try {
    if (providerTaskId) {
      execute('UPDATE video_jobs SET phase = COALESCE(?, phase), provider_task_id = ? WHERE id = ?', [phase || null, String(providerTaskId), jobId])
    } else if (phase) {
      execute('UPDATE video_jobs SET phase = ? WHERE id = ?', [String(phase), jobId])
    }
  } catch (e) {
    console.warn('[videoJobs] 进度更新失败（不影响任务）:', e.message)
  }
}

function finishJob(jobId, patch) {
  // cancelled（镜头被删除/集被重置）优先：执行中的任务跑完后不得覆盖取消态
  const r = execute(
    `UPDATE video_jobs SET status = ?, phase = ?, error = ?, result_url = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ? AND status != 'cancelled'`,
    [patch.status, patch.phase || '', patch.error || '', patch.resultUrl || '', jobId]
  )
  return r.changes > 0
}

// 镜头被删除（清空/覆盖保存分镜、删集）时取消其未完成任务：
// queued 的直接作废不再执行；running 的标记取消，跑完后结果不覆盖取消态。
export function cancelJobsForShots(shotIds) {
  const ids = (Array.isArray(shotIds) ? shotIds : []).map(Number).filter(Number.isFinite)
  if (!ids.length) return 0
  const marks = ids.map(() => '?').join(',')
  const r = execute(
    `UPDATE video_jobs SET status = 'cancelled', phase = '镜头已删除，任务取消', finished_at = CURRENT_TIMESTAMP
     WHERE status IN ('queued','running') AND shot_id IN (${marks})`,
    ids
  )
  if (r.changes) console.log(`[videoJobs] 镜头删除联动：已取消 ${r.changes} 个未完成任务`)
  return r.changes
}

export function listJobsForEpisode(episodeId, { activeOnly = false } = {}) {
  const sql = activeOnly
    ? `SELECT * FROM video_jobs WHERE episode_id = ? AND status IN ('queued','running') ORDER BY created_at`
    : `SELECT * FROM video_jobs WHERE episode_id = ? ORDER BY created_at DESC LIMIT 100`
  return query(sql, [Number(episodeId)])
}

export function kickQueue() {
  const free = concurrency() - runningCount
  if (free <= 0) return
  const next = query(
    `SELECT * FROM video_jobs WHERE status = 'queued' ORDER BY created_at LIMIT ?`,
    [free]
  )
  for (const job of next) {
    runningCount++
    runJob(job).finally(() => {
      runningCount--
      setImmediate(kickQueue)
    })
  }
}

async function runJob(job) {
  const executor = executors.get(job.engine)
  execute(`UPDATE video_jobs SET status = 'running', phase = '准备中', started_at = CURRENT_TIMESTAMP, attempts = attempts + 1 WHERE id = ?`, [job.id])
  if (!executor) {
    finishJob(job.id, { status: 'failed', error: `出片引擎 ${job.engine} 未注册执行器`, phase: '执行器缺失' })
    return
  }
  console.log(`[videoJobs] 开始执行 ${job.engine} job ${job.id.slice(0, 8)}（镜 ${job.shot_id}）`)
  try {
    const result = await executor(job, { updateProgress: (p) => updateJobProgress(job.id, p) })
    if (result?.success && result.url) {
      finishJob(job.id, { status: 'succeeded', resultUrl: result.url, phase: '完成' })
      console.log(`[videoJobs] ✓ job ${job.id.slice(0, 8)}（镜 ${job.shot_id}）→ ${result.url}`)
    } else {
      finishJob(job.id, { status: 'failed', error: result?.error || '出片失败', phase: result?.phase || '失败' })
      console.warn(`[videoJobs] ✗ job ${job.id.slice(0, 8)}（镜 ${job.shot_id}）: ${result?.error || '出片失败'}`)
    }
  } catch (e) {
    finishJob(job.id, { status: 'failed', error: String(e?.message || e).slice(0, 500), phase: '异常' })
    console.warn(`[videoJobs] ✗ job ${job.id.slice(0, 8)}（镜 ${job.shot_id}）异常: ${e?.message || e}`)
  }
}

// ── 重启自愈 ─────────────────────────────────────────────────
// 1) queued 的任务直接重新排队执行；
// 2) running 的任务标记 interrupted，若已拿到云端 taskId 则异步凭 taskId
//    回查 RunningHub：成片已出就下载落盘、回写 shots、任务置 succeeded；
//    还在跑/已失败则保留 interrupted，前端显示"可重新出片"。
export function resumeInterruptedJobs() {
  const queued = query(`SELECT id FROM video_jobs WHERE status = 'queued'`)
  const running = query(`SELECT * FROM video_jobs WHERE status = 'running'`)

  for (const job of running) {
    execute(`UPDATE video_jobs SET status = 'interrupted', phase = '服务重启，任务中断', finished_at = CURRENT_TIMESTAMP WHERE id = ?`, [job.id])
    console.log(`[videoJobs] 重启自愈：job ${job.id.slice(0, 8)}（镜 ${job.shot_id}）标为 interrupted`)
    if (job.provider_task_id) recoverByTaskId(job)
  }
  if (queued.length) {
    console.log(`[videoJobs] 重启自愈：${queued.length} 个排队任务重新入队`)
    setImmediate(kickQueue)
  }
}

async function recoverByTaskId(job) {
  try {
    const q = await queryTaskOutput(job.provider_task_id)
    const urls = (Array.isArray(q?.allResults) ? q.allResults : [])
      .map((r) => String(r?.url || '')).filter(Boolean)
    if (!urls.length) return // 云端还在跑或已失败：保持 interrupted
    const finalize = executors.get(`${job.engine}:finalize`)
    if (!finalize) return
    console.log(`[videoJobs] 重启自愈：job ${job.id.slice(0, 8)} 凭云端任务找回 ${urls.length} 个候选成片，尝试落盘`)
    let buf = null
    for (const u of urls) {
      try {
        const b = await insecureDownload(u)
        if (isPlausibleMp4(b)) { buf = b; break }
      } catch {  }
    }
    if (!buf) return
    const filename = `shot_${job.shot_id}_recovered_${Date.now()}.mp4`
    fs.mkdirSync(uploadsDir, { recursive: true })
    fs.writeFileSync(path.join(uploadsDir, filename), buf)
    const r = await finalize(job, { localUrl: `${uploadsUrl(filename)}`, cloudUrl: urls[0], buf })
    if (r?.success) {
      execute(`UPDATE video_jobs SET status = 'succeeded', result_url = ?, phase = '重启自愈找回', error = '', finished_at = CURRENT_TIMESTAMP WHERE id = ?`, [`${uploadsUrl(filename)}`, job.id])
      console.log(`[videoJobs] ✓ 重启自愈找回成功：镜 ${job.shot_id} → /uploads/${filename}`)
    }
  } catch (e) {
    console.warn(`[videoJobs] 重启自愈回查失败（job ${job.id.slice(0, 8)}，保持 interrupted）:`, e.message)
  }
}
