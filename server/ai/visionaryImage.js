import { config } from '../config.js'
import { logAiCall } from './aiLog.js'
import { mimeFromExt, netErrMsg, assertSafeDownloadTarget } from './shared.js'
import { insecureDownload } from './runninghub.js'
import undiciPkg from 'undici'
const { fetch: undiciFetch, EnvHttpProxyAgent } = undiciPkg
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const uploadsDir = path.join(__dirname, '..', 'uploads')


async function resolveImageSource(source) {
  const s = String(source).trim()

  if (/^data:image\/[\w+.-]+;base64,/i.test(s)) {
    return { kind: 'base64', value: s }
  }

  if (/^https?:\/\//i.test(s)) {
    return { kind: 'url', value: s }
  }

  const stripped = s.split(/[?#]/)[0]
  const localPath = stripped.startsWith('/uploads/')
    ? path.join(uploadsDir, decodeURIComponent(stripped).replace(/^\/uploads\//, ''))
    : decodeURIComponent(stripped)
  const buffer = fs.readFileSync(localPath)
  const mime = mimeFromExt(localPath)
  return { kind: 'base64', value: `data:${mime};base64,${buffer.toString('base64')}` }
}

const REF_MAX_BYTES = 400 * 1024
const REF_MAX_EDGE = 1024
async function shrinkRef(buffer, filename, mimeType) {
  if (buffer.length <= REF_MAX_BYTES) return { buffer, filename, mimeType }
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const tmpDir = os.tmpdir()
  const inPath = path.join(tmpDir, `visionary_ref_in_${stamp}.img`)
  const outPath = path.join(tmpDir, `visionary_ref_out_${stamp}.jpg`)
  try {
    const ffmpegPath = (await import('ffmpeg-static')).default
    fs.writeFileSync(inPath, buffer)
    await execFileAsync(ffmpegPath, [
      '-y', '-i', inPath,
      '-vf', `scale='min(${REF_MAX_EDGE},iw)':-2`,
      '-q:v', '4', outPath,
    ])
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
      return { buffer: fs.readFileSync(outPath), filename: 'ref.jpg', mimeType: 'image/jpeg' }
    }
  } catch (e) {
    console.warn('[visionaryImage] 参考图压缩失败，改用原图:', e.message)
  } finally {
    for (const p of [inPath, outPath]) {
      try { fs.rmSync(p, { force: true }) } catch {  }
    }
  }
  return { buffer, filename, mimeType }
}

async function buildReferenceImages(sources) {
  const out = []
  for (const src of sources) {
    const resolved = await resolveImageSource(src)
    if (resolved.kind === 'url') {
      out.push(resolved.value)
      continue
    }
    const raw = resolved.value.replace(/^data:image\/[\w+.-]+;base64,/i, '')
    const buffer = Buffer.from(raw, 'base64')
    const mime = (resolved.value.match(/^data:(image\/[\w+.-]+);base64,/i)?.[1]) || 'image/png'
    const ext = mime.split('/')[1]
    const filename = `ref.${ext === 'jpeg' ? 'jpg' : ext}`
    const shrunk = await shrinkRef(buffer, filename, mime)
    out.push(`data:${shrunk.mimeType};base64,${shrunk.buffer.toString('base64')}`)
  }
  return out
}


async function fetchJson(url, init, timeoutMs = 30000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await undiciFetch(url, { ...init, signal: controller.signal })
    clearTimeout(timer)
    return res
  } catch (e) {
    clearTimeout(timer)
    throw e
  }
}

async function submitTask(body, ctx) {
  const { apiKey, baseURL } = config.image.visionary
  const startedAt = Date.now()
  const res = await fetchJson(`${baseURL}/v1/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  }, 60000)

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    const family = res.status === 401 || res.status === 403 ? 'auth'
      : res.status === 429 ? 'rate_limit'
      : res.status >= 500 ? 'server'
      : 'content'
    const msg = `提交生图任务失败 (HTTP ${res.status})${errText ? ': ' + errText.slice(0, 300) : ''}`
    logAiCall({ kind: 'image', model: body.model, episodeId: ctx.episodeId, task: ctx.task || 'image', latencyMs: Date.now() - startedAt, success: false, errorFamily: family, errorMsg: msg })
    throw new Error(msg)
  }

  const data = await res.json()
  const item = data?.data?.[0]
  if (!item?.task_id) {
    const msg = '提交生图任务未返回 task_id'
    logAiCall({ kind: 'image', model: body.model, episodeId: ctx.episodeId, task: ctx.task || 'image', latencyMs: Date.now() - startedAt, success: false, errorFamily: 'content', errorMsg: msg })
    throw new Error(msg)
  }
  return { taskId: item.task_id, retryAfter: Number(item.retry_after) || 3 }
}

async function queryTask(taskId, ctx) {
  const { apiKey, baseURL } = config.image.visionary
  const res = await fetchJson(`${baseURL}/v1/tasks/${encodeURIComponent(taskId)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  }, 30000)

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`查询任务失败 (HTTP ${res.status})${errText ? ': ' + errText.slice(0, 300) : ''}`)
  }
  const data = await res.json()
  return data?.data
}

async function pollTask(taskId, initialRetryAfter, ctx) {
  const { pollIntervalMs, maxPollMs } = config.image.visionary
  const startedAt = Date.now()
  let retryAfter = Number(initialRetryAfter) || Math.max(1, Math.round(pollIntervalMs / 1000))
  while (Date.now() - startedAt < maxPollMs) {
    await new Promise((r) => setTimeout(r, retryAfter * 1000))
    const task = await queryTask(taskId, ctx)
    const status = task?.status
    retryAfter = Number(task?.retry_after) || Math.max(1, Math.round(pollIntervalMs / 1000))
    if (status === 'completed') {
      const url = task?.result?.images?.[0]?.url?.[0]
      if (!url) throw new Error('任务已完成但未返回图片地址')
      return url
    }
    if (status === 'failed' || task?.error) {
      throw new Error(task?.error?.message || '生图任务失败')
    }
  }
  throw new Error(`生图任务轮询超时(${Math.round(maxPollMs / 1000)}s)`)
}

const DOWNLOAD_ALLOW_HOSTS = config.security?.downloadAllowHosts || []
let visionaryDispatcher = null
function getVisionaryDispatcher() {
  if (!visionaryDispatcher) {
    const explicit = config.image.visionary.proxy
    visionaryDispatcher = explicit === 'direct'
      ? new EnvHttpProxyAgent() 
      : new EnvHttpProxyAgent({ httpProxy: explicit, httpsProxy: explicit })
    console.log(`[visionaryImage] 下载兜底 dispatcher = ${explicit === 'direct' ? '环境变量自适应' : explicit}`)
  }
  return visionaryDispatcher
}

async function proxiedDownload(url, maxRedirects = 3, timeoutMs = 180000) {
  await assertSafeDownloadTarget(url, DOWNLOAD_ALLOW_HOSTS)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await undiciFetch(url, {
      dispatcher: getVisionaryDispatcher(),
      redirect: 'manual',
      signal: controller.signal,
    })
    if (res.status >= 300 && res.status < 400 && maxRedirects > 0) {
      const loc = res.headers.get('location')
      if (loc) return await proxiedDownload(new URL(loc, url).toString(), maxRedirects - 1, timeoutMs)
    }
    if (res.status >= 400) throw new Error(`下载失败 HTTP ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`下载超时（${Math.round(timeoutMs / 1000)} 秒）`)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

export async function persistResult(url, filename) {
  fs.mkdirSync(uploadsDir, { recursive: true })
  let buf
  try {
    buf = await insecureDownload(url)
  } catch (e) {
    console.warn(`[visionaryImage] 直连下载失败（${e.message}），改用代理重试`)
    buf = await proxiedDownload(url)
  }
  filename = path.basename(String(filename)) || `visionary_${Date.now()}.png`
  fs.writeFileSync(path.join(uploadsDir, filename), buf)
  return `/uploads/${filename}`
}

function buildBody(prompt, model, options = {}) {
  const { resolution, size, optimizeChineseText } = config.image.visionary
  const body = {
    model,
    prompt: String(prompt),
  }
  let effectiveResolution
  if (model === 'nano-banana-2-lite') {
    effectiveResolution = '1K'
  } else if (options.resolution) {
    effectiveResolution = options.resolution
  } else if (model === 'gpt-image-2') {
    effectiveResolution = '1K'
  } else if (/^nano-banana/.test(model)) {
    effectiveResolution = '2K'
  } else {
    effectiveResolution = resolution || undefined
  }
  if (effectiveResolution) body.resolution = effectiveResolution
  if (options.size || size) {
    body.size = options.size || size
  }
  if (model === 'nano-banana-pro' && (options.optimizeChineseText != null ? options.optimizeChineseText : optimizeChineseText)) {
    body.optimizeChineseText = true
  }
  if (model === 'gpt-image-2' && options.quality) {
    body.quality = options.quality
  }
  return body
}

export async function visionaryGenerateImage(prompt, options = {}) {
  const startedAt = Date.now()
  const ctx = options.usageContext || {}
  const { apiKey } = config.image.visionary
  if (!apiKey) return { success: false, error: 'VISIONARY_API_KEY 未配置，请在 server/.env 设置' }
  if (!prompt || !String(prompt).trim()) return { success: false, error: 'prompt 必填' }

  const model = options.model || config.image.visionary.model
  const body = buildBody(prompt, model, options)

  try {
    const { taskId, retryAfter } = await submitTask(body, ctx)
    const imageUrl = await pollTask(taskId, retryAfter, ctx)
    const filename = options.filename || `visionary_${Date.now()}.png`
    const localUrl = await persistResult(imageUrl, filename)
    logAiCall({ kind: 'image', model, episodeId: ctx.episodeId, task: ctx.task || 'image', latencyMs: Date.now() - startedAt, success: true })
    return { success: true, url: localUrl }
  } catch (e) {
    const msg = netErrMsg(e)
    logAiCall({ kind: 'image', model, episodeId: ctx.episodeId, task: ctx.task || 'image', latencyMs: Date.now() - startedAt, success: false, errorFamily: /超时/.test(msg) ? 'timeout' : 'unknown', errorMsg: msg })
    return { success: false, error: msg }
  }
}

export async function visionaryEditImage(images, prompt, options = {}) {
  const startedAt = Date.now()
  const ctx = options.usageContext || {}
  const { apiKey } = config.image.visionary
  if (!apiKey) return { success: false, error: 'VISIONARY_API_KEY 未配置，请在 server/.env 设置' }
  if (!Array.isArray(images) || !images.length) return { success: false, error: '图生图缺少参考图' }
  if (!prompt || !String(prompt).trim()) return { success: false, error: 'prompt 必填' }

  const model = options.model || config.image.visionary.model
  const body = buildBody(prompt, model, { ...options, size: options.size })

  try {
    body.images = await buildReferenceImages(images)
    const { taskId, retryAfter } = await submitTask(body, ctx)
    const imageUrl = await pollTask(taskId, retryAfter, ctx)
    const filename = options.filename || `visionary_edit_${Date.now()}.png`
    const localUrl = await persistResult(imageUrl, filename)
    logAiCall({ kind: 'image', model, episodeId: ctx.episodeId, task: ctx.task || 'image-edit', latencyMs: Date.now() - startedAt, success: true })
    return { success: true, url: localUrl }
  } catch (e) {
    const msg = netErrMsg(e)
    logAiCall({ kind: 'image', model, episodeId: ctx.episodeId, task: ctx.task || 'image-edit', latencyMs: Date.now() - startedAt, success: false, errorFamily: /超时/.test(msg) ? 'timeout' : 'unknown', errorMsg: msg })
    return { success: false, error: msg }
  }
}
