import 'dotenv/config'
import express from 'express'
import path from 'path'
import fs from 'fs'
import { config } from './config.js'
import { initDB } from './db.js'
import { initModelConfig } from './modelConfig.js'
import { runBootChecks, printBootReport } from './bootCheck.js'


const crashLogPath = path.join(serverDir, 'crash.log')
const CRASH_LOG_MAX_BYTES = 10 * 1024 * 1024
function logCrash(kind, err) {
  const line = `\n[${new Date().toISOString()}] ${kind}: ${err?.stack || err?.message || JSON.stringify(err)}\n`
  try {
    // 单文件超过 10MB 先归档（保留最近 3 份），避免无限膨胀
    const st = fs.existsSync(crashLogPath) ? fs.statSync(crashLogPath) : null
    if (st && st.size > CRASH_LOG_MAX_BYTES) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      fs.renameSync(crashLogPath, path.join(serverDir, `crash-${stamp}.log`))
      const archives = fs.readdirSync(serverDir)
        .filter((f) => /^crash-.*\.log$/.test(f))
        .sort()
      for (const old of archives.slice(0, Math.max(0, archives.length - 3))) {
        try { fs.unlinkSync(path.join(serverDir, old)) } catch {  }
      }
    }
    fs.appendFileSync(crashLogPath, line)
  } catch {  }
  console.error(`[CRASH-GUARD] ${kind}:`, err?.stack || err)
}
process.on('uncaughtException', (err) => logCrash('uncaughtException', err))
process.on('unhandledRejection', (reason) => logCrash('unhandledRejection', reason))

import projectsRouter from './routes/projects.js'
import episodesRouter from './routes/episodes.js'
import generateScriptRouter from './routes/generate-script.js'
import generateImageRouter from './routes/generate-image.js'
import generateVideoRouter from './routes/generate-video.js'
import generatePostRouter from './routes/generate-post.js'
import tasksRouter from './routes/tasks.js'
import libraryRouter from './routes/library.js'
import stylesRouter from './routes/styles.js'
import projectCharactersRouter from './routes/projectCharacters.js'
import ipCharactersRouter from './routes/ipCharacters.js'
import spatialGroupReviewRouter from './routes/spatial-group-review.js'
import modelConfigRouter from './routes/model-config.js'

const app = express()

app.use(express.json({ limit: '20mb' }))

const apiToken = process.env.API_TOKEN
if (apiToken) {
  console.log('[Server] API_TOKEN 已设置：/api 接口已启用 Token 鉴权')
  app.use('/api', (req, res, next) => {
    if (req.path === '/health') return next() 
    if (req.get('x-api-token') === apiToken) return next()
    res.status(401).json({ error: '未授权：缺少或错误的 x-api-token 请求头' })
  })
}

initDB()
initModelConfig()

import { startSalvageWorker } from './salvageWorker.js'
import { resumeInterruptedJobs } from './jobs/videoJobRunner.js'
import { serverDir } from './paths.js'
startSalvageWorker()
resumeInterruptedJobs()

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() })
})

app.use('/uploads', express.static(path.join(serverDir, 'uploads')))

app.use('/api/projects', projectsRouter)
app.use('/api/episodes', episodesRouter)
app.use('/api/generate', generateScriptRouter)
app.use('/api/generate', generateImageRouter)
app.use('/api/generate', generateVideoRouter)
app.use('/api/generate', generatePostRouter)
app.use('/api/generate', spatialGroupReviewRouter)
app.use('/api/tasks', tasksRouter)
app.use('/api/library-assets', libraryRouter)
app.use('/api/styles', stylesRouter)
app.use('/api/project-characters', projectCharactersRouter)
app.use('/api/ip-characters', ipCharactersRouter)
app.use('/api/model-config', modelConfigRouter)

app.use((err, req, res, next) => {
  console.error('[ERROR]', req.method, req.originalUrl, '\n', err.stack || err)
  res.status(err.status || 500).json({ error: err.message })
})

app.listen(config.port, config.host, () => {
  console.log(`[Server] 后端运行在 http://${config.host}:${config.port}`)
  try {
    printBootReport(runBootChecks())
  } catch (e) {
    console.warn('[Server] 启动自检失败（不影响服务）：', e?.message || e)
  }
})
