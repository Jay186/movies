#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = __dirname
const SERVER_DIR = path.join(ROOT, 'server')

const argv = process.argv.slice(2)
const OPT = {
  watch: argv.includes('--watch') || argv.includes('-w'),
  open: !argv.includes('--no-open'),
  backendOnly: argv.includes('--backend'),
  frontendOnly: argv.includes('--frontend'),
  skipInstall: argv.includes('--no-install'),
}

function readEnvPort() {
  try {
    const envPath = path.join(SERVER_DIR, '.env')
    if (!fs.existsSync(envPath)) return 3000
    const txt = fs.readFileSync(envPath, 'utf8')
    const m = txt.match(/^\s*PORT\s*=\s*(\d+)\s*$/m)
    return m ? Number(m[1]) : 3000
  } catch {
    return 3000
  }
}
const BACKEND_PORT = Number(process.env.PORT) || readEnvPort()
const FRONTEND_PORT = Number(process.env.VITE_PORT) || 5173

const C = {
  reset: '\x1b[0m',
  gray: '\x1b[90m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  bold: '\x1b[1m',
}
const ts = () => new Date().toTimeString().slice(0, 8)
function info(msg) { console.log(`${C.gray}[${ts()}]${C.reset} ${msg}`) }
function ok(msg) { console.log(`${C.gray}[${ts()}]${C.reset} ${C.green}✓${C.reset} ${msg}`) }
function warn(msg) { console.log(`${C.gray}[${ts()}]${C.reset} ${C.yellow}!${C.reset} ${msg}`) }
function err(msg) { console.log(`${C.gray}[${ts()}]${C.reset} ${C.red}✗${C.reset} ${msg}`) }
function step(msg) { console.log(`\n${C.bold}${C.cyan}▶ ${msg}${C.reset}`) }

function pidsOnPort(port) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32'
    const cmd = isWin ? 'netstat -ano -p TCP' : 'lsof -nP -iTCP -sTCP:LISTEN'
    const child = spawn(cmd, { shell: true, windowsHide: true })
    let out = ''
    child.stdout.on('data', (d) => (out += d.toString()))
    child.on('close', () => {
      const pids = new Set()
      for (const line of out.split(/\r?\n/)) {
        if (isWin) {
          if (!/LISTENING/i.test(line)) continue
          const m = line.match(/^\s*TCP\s+.*[:.](\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i)
          if (m && Number(m[1]) === port) pids.add(m[2])
        } else {
          const m = line.match(/:(\d+)\s+\(LISTEN\)/)
          const pid = line.match(/\s(\d+)\s/)
          if (m && Number(m[1]) === port && pid) pids.add(pid[1])
        }
      }
      resolve([...pids])
    })
    child.on('error', () => resolve([]))
  })
}

function killPid(pid) {
  return new Promise((resolve) => {
    if (String(pid) === String(process.pid)) return resolve(false)
    const cmd = process.platform === 'win32'
      ? `taskkill /PID ${pid} /T /F`
      : `kill -9 ${pid}`
    const child = spawn(cmd, { shell: true, windowsHide: true })
    child.on('close', () => resolve(true))
    child.on('error', () => resolve(false))
  })
}

async function freePort(port, label) {
  const pids = await pidsOnPort(port)
  if (!pids.length) return
  warn(`${label} 端口 ${port} 被占用（PID: ${pids.join(', ')}），正在释放…`)
  for (const pid of pids) await killPid(pid)
  await sleep(700)
  const left = await pidsOnPort(port)
  if (left.length) err(`端口 ${port} 仍被占用（PID: ${left.join(', ')}），请手动处理`)
  else ok(`端口 ${port} 已释放`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function probe(port, pathname = '/', timeout = 1200) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: pathname, timeout },
      (res) => { res.resume(); resolve(res.statusCode !== undefined) }
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

async function waitUp(port, pathname, label, timeoutMs = 60000) {
  const start = Date.now()
  let dots = 0
  process.stdout.write(`   等待 ${label} 就绪 `)
  while (Date.now() - start < timeoutMs) {
    if (await probe(port, pathname)) {
      process.stdout.write(` ${C.green}就绪${C.reset}\n`)
      return true
    }
    process.stdout.write('.')
    dots++
    await sleep(500)
  }
  process.stdout.write(` ${C.red}超时${C.reset}\n`)
  return false
}

function ensureDeps(dir, label) {
  if (OPT.skipInstall) return
  if (fs.existsSync(path.join(dir, 'node_modules'))) return
  step(`安装 ${label} 依赖（首次运行需要一点时间）…`)
  const r = spawnSync('npm', ['install'], { cwd: dir, stdio: 'inherit', shell: true })
  if (r.status !== 0) {
    err(`${label} 依赖安装失败，请手动在 ${dir} 执行 npm install`)
    process.exit(1)
  }
  ok(`${label} 依赖安装完成`)
}

function openBrowser(url) {
  const p = process.platform
  const cmd = p === 'win32' ? `start "" "${url}"`
    : p === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`
  spawn(cmd, { shell: true, windowsHide: true, stdio: 'ignore' })
}

const children = []
let backendRestarts = 0
let frontendRestarts = 0
const MAX_RESTARTS = 30

function pipeOutput(child, tag, color, onLine) {
  const prefix = `${color}[${tag}]${C.reset} `
  const handle = (buf) => {
    const text = buf.toString()
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === '') continue
      console.log(prefix + line)
      if (onLine) onLine(line)
    }
  }
  child.stdout?.on('data', handle)
  child.stderr?.on('data', handle)
}

let frontendUrl = `http://127.0.0.1:${FRONTEND_PORT}`

function startBackend() {
  const args = []
  if (OPT.watch) args.push('--watch')
  args.push('index.js')
  info(`后端启动命令：node ${args.join(' ')}  (cwd: ${SERVER_DIR})`)
  const child = spawn(process.execPath, args, {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(BACKEND_PORT) },
    windowsHide: true,
  })
  children.push(child)
  pipeOutput(child, '后端', '\x1b[35m')
  child.on('exit', (code, signal) => {
    if (shuttingDown) return
    const idx = children.indexOf(child)
    if (idx >= 0) children.splice(idx, 1)
    backendRestarts++
    if (backendRestarts > MAX_RESTARTS) {
      err(`后端进程退出（code=${code} signal=${signal}），已重试 ${MAX_RESTARTS} 次仍失败，放弃`)
      cleanup(1)
      return
    }
    warn(`后端进程退出（code=${code} signal=${signal}），1 秒后自动重启（第 ${backendRestarts} 次）…`)
    setTimeout(() => {
      if (shuttingDown) return
      info(`自动重启后端（第 ${backendRestarts} 次）`)
      startBackend()
    }, 1000)
  })
  return child
}

function startFrontend() {
  const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
  const useLocal = fs.existsSync(viteBin)
  const args = useLocal
    ? [viteBin, '--host', '127.0.0.1', '--port', String(FRONTEND_PORT), '--strictPort']
    : ['vite', '--host', '127.0.0.1', '--port', String(FRONTEND_PORT), '--strictPort']
  info(`前端启动命令：${useLocal ? 'node ' + path.relative(ROOT, viteBin) : 'npx vite'}  (cwd: ${ROOT})`)
  const child = useLocal
    ? spawn(process.execPath, args, { cwd: ROOT, windowsHide: true })
    : spawn('npx', args, { cwd: ROOT, shell: true, windowsHide: true })
  children.push(child)
  pipeOutput(child, '前端', '\x1b[36m', (line) => {
    const m = line.match(/https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/)
    if (m) frontendUrl = `http://127.0.0.1:${m[1]}`
  })
  child.on('exit', (code, signal) => {
    if (shuttingDown) return
    const idx = children.indexOf(child)
    if (idx >= 0) children.splice(idx, 1)
    frontendRestarts++
    if (frontendRestarts > MAX_RESTARTS) {
      err(`前端进程退出（code=${code} signal=${signal}），已重试 ${MAX_RESTARTS} 次仍失败，放弃`)
      cleanup(1)
      return
    }
    warn(`前端进程退出（code=${code} signal=${signal}），1 秒后自动重启（第 ${frontendRestarts} 次）…`)
    setTimeout(() => {
      if (shuttingDown) return
      info(`自动重启前端（第 ${frontendRestarts} 次）`)
      startFrontend()
    }, 1000)
  })
  return child
}

let shuttingDown = false
function cleanup(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  info('正在关闭服务…')
  for (const c of children) {
    if (c.exitCode !== null) continue
    try {
      if (process.platform === 'win32') {
        spawn(`taskkill /PID ${c.pid} /T /F`, { shell: true, windowsHide: true, stdio: 'ignore' })
      } else {
        c.kill('SIGTERM')
      }
    } catch {  }
  }
  setTimeout(() => process.exit(code), 400)
}

process.on('SIGINT', () => { console.log(''); cleanup(0) })
process.on('SIGTERM', () => cleanup(0))
process.on('exit', () => { if (!shuttingDown) cleanup(0) })

async function main() {
  console.log(`${C.bold}============================================${C.reset}`)
  console.log(`${C.bold}  分镜项目 · 一键启动${C.reset}`)
  console.log(`${C.bold}  后端 http://127.0.0.1:${BACKEND_PORT}   前端 ${frontendUrl}${C.reset}`)
  console.log(`${C.bold}============================================${C.reset}`)

  if (argv.includes('--stop')) {
    step('停止服务')
    await freePort(BACKEND_PORT, '后端')
    await freePort(FRONTEND_PORT, '前端')
    shuttingDown = true
    ok('已停止（若窗口是直接关掉的，用这个命令清残留进程）')
    return
  }

  if (!fs.existsSync(SERVER_DIR)) {
    err(`找不到 server 目录：${SERVER_DIR}`)
    process.exit(1)
  }

  step('检查依赖')
  if (!OPT.frontendOnly) ensureDeps(SERVER_DIR, '后端')
  if (!OPT.backendOnly) ensureDeps(ROOT, '前端')

  step('清理端口占用')
  if (!OPT.frontendOnly) await freePort(BACKEND_PORT, '后端')
  if (!OPT.backendOnly) await freePort(FRONTEND_PORT, '前端')

  step('启动服务')
  if (!OPT.frontendOnly) startBackend()
  if (!OPT.backendOnly) startFrontend()

  step('健康检查')
  let allOk = true
  if (!OPT.frontendOnly) {
    allOk = (await waitUp(BACKEND_PORT, '/api/health', `后端 :${BACKEND_PORT}`)) && allOk
  }
  if (!OPT.backendOnly) {
    allOk = (await waitUp(FRONTEND_PORT, '/', `前端 :${FRONTEND_PORT}`)) && allOk
  }

  console.log('')
  if (allOk) {
    console.log(`${C.green}${C.bold}  全部就绪${C.reset}`)
    if (!OPT.frontendOnly) console.log(`  后端 API  ${C.cyan}http://127.0.0.1:${BACKEND_PORT}/api/health${C.reset}`)
    if (!OPT.backendOnly) console.log(`  前端页面  ${C.cyan}${frontendUrl}${C.reset}`)
    console.log(`\n  ${C.gray}按 Ctrl+C 停止所有服务${C.reset}\n`)
    if (OPT.open && !OPT.backendOnly) setTimeout(() => openBrowser(frontendUrl), 500)
  } else {
    err('有服务未启动成功，请看上方日志排查')
    cleanup(1)
  }
}

main().catch((e) => {
  err(`启动失败：${e?.stack || e}`)
  process.exit(1)
})
