import 'dotenv/config'
import express from 'express'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { config } from './config.js'
import { initDB } from './db.js'
import { runBootChecks, printBootReport } from './bootCheck.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// 进程级兜底：未捕获异常/Promise 拒绝只记日志不退出（退出会让所有进行中任务全部失败，
// 且前端只看到莫名的 500）。堆栈完整落盘 server/crash.log 便于定位元凶。
const crashLogPath = path.join(__dirname, 'crash.log')
function logCrash(kind, err) {
  const line = `\n[${new Date().toISOString()}] ${kind}: ${err?.stack || err?.message || JSON.stringify(err)}\n`
  try { fs.appendFileSync(crashLogPath, line) } catch { /* ignore */ }
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
import qcRouter from './routes/qc.js'
import libraryRouter from './routes/library.js'
import stylesRouter from './routes/styles.js'
import projectCharactersRouter from './routes/projectCharacters.js'
import ipCharactersRouter from './routes/ipCharacters.js'
import spatialGroupReviewRouter from './routes/spatial-group-review.js'

const app = express()

// 中间件
// [安全 2026-09-18] 移除 cors()：前端经 Vite 同源代理（/api、/uploads → 127.0.0.1:3000）访问，
// 浏览器侧不存在跨源需求；通配 CORS 会让任意恶意网页跨源读写本服务 API（含触发付费生成）。
// 若未来需要真跨源访问，用显式 Origin 白名单，不要用 cors() 默认反射。
// 图片/音频上传走 base64 JSON：前端单文件上限 10MB，base64 膨胀约 4/3 → 约 13.4MB，
// limit 若仍按 10MB 卡，7.4MB 以上的合法文件会被 body-parser 以 413 拦在路由之外
app.use(express.json({ limit: '20mb' }))

// 可选鉴权：设置环境变量 API_TOKEN 后，所有 /api 接口要求请求头 x-api-token 匹配。
// 本地开发默认不设置（零影响）；部署到局域网/公网时启用，前端在 localStorage 存 api_token 即可。
const apiToken = process.env.API_TOKEN
if (apiToken) {
  console.log('[Server] API_TOKEN 已设置：/api 接口已启用 Token 鉴权')
  app.use('/api', (req, res, next) => {
    if (req.path === '/health') return next() // 健康检查保持开放（探活用）
    if (req.get('x-api-token') === apiToken) return next()
    res.status(401).json({ error: '未授权：缺少或错误的 x-api-token 请求头' })
  })
}

// 初始化数据库
initDB()

// 成片打捞守护（2026-09-15）：本地化全灭的镜头自动重捞，见 salvageWorker.js 头注
import { startSalvageWorker } from './salvageWorker.js'
startSalvageWorker()

// 僵尸段复位（2026-09-16）：段出片是同步长跑，进程被杀后库里会永久停在 running
// （前端「出片中…」不结束 + 旧闸门只查内存锁 → 可重复提交双倍烧币）。
// 启动期内存 inflight 必为空，此时复位绝对安全。详见 generate-video.js resetZombieSegments。
try {
  const { resetZombieSegments } = await import('./routes/generate-video.js')
  const n = resetZombieSegments()
  if (n > 0) console.log(`[Server] 已复位 ${n} 个中断的出片段（running → failed）`)
} catch (e) {
  console.warn('[Server] 僵尸段复位失败（不影响服务）：', e?.message || e)
}

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() })
})

// 静态文件服务（上传的图片）
app.use('/uploads', express.static(path.join(__dirname, 'uploads')))

// 路由
app.use('/api/projects', projectsRouter)
app.use('/api/episodes', episodesRouter)
app.use('/api/generate', generateScriptRouter)
app.use('/api/generate', generateImageRouter)
app.use('/api/generate', generateVideoRouter)
app.use('/api/generate', generatePostRouter)
// 分镜质检面板（2026-09-16）：/qc-report 聚合问题、/qc-fix 一键修复、/qc-ignore 忽略
app.use('/api/generate', qcRouter)
app.use('/api/generate', spatialGroupReviewRouter)
app.use('/api/tasks', tasksRouter)
app.use('/api/library-assets', libraryRouter)
app.use('/api/styles', stylesRouter)
app.use('/api/project-characters', projectCharactersRouter)
app.use('/api/ip-characters', ipCharactersRouter)

// 错误处理（带完整堆栈落日志，响应体仍只回 message 不泄露内部细节）
app.use((err, req, res, next) => {
  console.error('[ERROR]', req.method, req.originalUrl, '\n', err.stack || err)
  res.status(err.status || 500).json({ error: err.message })
})

app.listen(config.port, config.host, () => {
  console.log(`[Server] 后端运行在 http://${config.host}:${config.port}`)
  // 启动自检（2026-09-13）：原 MC 单项自检扩充为完整健康清单。
  // 起因（overview 09-12）：某进程带着缺 MC 配置的 env 跑了一整天，28 次出片静默降级无人察觉。
  // 根因是「.env 改了 ≠ 跑着的进程知道」（进程级配置无热重载），唯一可靠的解法就是开机亮灯。
  // 检查逻辑全在 bootCheck.js；这里只负责调用与打印，不阻断启动（任何异常都降级成 warn）。
  try {
    printBootReport(runBootChecks())
  } catch (e) {
    // 自检自身故障绝不能拖垮启动
    console.warn('[Server] 启动自检失败（不影响服务）：', e?.message || e)
  }
})
