// Visionary（https://visionary.beer）异步生图封装
// 统一接口：POST /v1/images/generations 提交任务 → GET /v1/tasks/:id 轮询 → 下载落盘
// 支持模型：gpt-image-2 / nano-banana-pro / nano-banana-pro-cl / nano-banana-2-lite
import { config } from '../config.js'
import { logAiCall } from './aiLog.js'
// mimeFromExt / netErrMsg 统一到 shared.js（原来本文件与 ziklImage.js 各有一份）
// assertSafeDownloadTarget：结果图下载的 SSRF 校验（与 runninghub 的 insecureDownload 同标准）
import { mimeFromExt, netErrMsg, assertSafeDownloadTarget } from './shared.js'
// insecureDownload：结果图下载的**主路径**——https.get + rejectUnauthorized:false，容忍证书异常
// （原实现口径，见 runninghub.js insecureDownload）。visionary 结果图 CDN 证书偶尔过期/不受信，
// undici 默认校验证书会直接 CERT_HAS_EXPIRED 失败，必须走这个容忍版。
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

// mimeFromExt 已统一到 shared.js（原此处 / runninghub.js / ziklImage.js 各有一份）

/**
 * 解析图片源。
 * 返回 { kind: 'url', value: string } 或 { kind: 'base64', value: dataUri }。
 * Visionary 接口要求参考图必须是公开 HTTPS URL 或完整 Base64 Data URI。
 */
async function resolveImageSource(source) {
  const s = String(source).trim()

  // 已是 base64 data URI，直接透传
  if (/^data:image\/[\w+.-]+;base64,/i.test(s)) {
    return { kind: 'base64', value: s }
  }

  // 公开/远端 URL，直接透传（速度更快）
  if (/^https?:\/\//i.test(s)) {
    return { kind: 'url', value: s }
  }

  // 本地路径：/uploads/ 相对路径 或 绝对路径 → 读取并编码为 base64 data URI
  // /uploads/ 必须保留子目录：资产库图存成 /uploads/library/scene/xxx.webp，
  // 用 basename 会吃掉 library/scene 一段拼到根目录 → ENOENT（runninghub.js 同款事故，那边已修）
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
// ⚠️ 故意与 ai/ziklImage.js 的 shrinkRef 保持两份实现，不要合并！
//    签名不同：本文件 (buffer, filename, mimeType) → 返回对象；ziklImage.js (ref{...}) → 返回 ref。
//    详见 ai/shared.js 顶部「故意不合并清单」。
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
      try { fs.rmSync(p, { force: true }) } catch { /* ignore */ }
    }
  }
  return { buffer, filename, mimeType }
}

/**
 * 将参考图源列表解析为 Visionary 可接受的 images 数组。
 * 优先返回原始 URL；本地文件压缩后转 base64 data URI。
 */
async function buildReferenceImages(sources) {
  const out = []
  for (const src of sources) {
    const resolved = await resolveImageSource(src)
    if (resolved.kind === 'url') {
      out.push(resolved.value)
      continue
    }
    // base64 形式：先把 data URI 还原成 buffer，压缩后再重新编码
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

// netErrMsg 已统一到 shared.js（原此处与 ziklImage.js 各有一份）

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
    // 继续轮询：submitted / processing
  }
  throw new Error(`生图任务轮询超时(${Math.round(maxPollMs / 1000)}s)`)
}

// ===== 结果图下载：直连优先 + 代理兜底（2026-09-16）=====
// 设计（修复回归）：**主路径用 insecureDownload** —— https.get 直连 + rejectUnauthorized:false，
// 与旧实现一致，**容忍证书异常**（海外结果图 CDN 证书偶尔过期/不受信，undici 默认校验会直接
// CERT_HAS_EXPIRED 失败）。仅当直连失败（超时 / ECONNRESET / 证书）才降级走代理重试。
// ⚠️ 历史教训：曾把主路径改成 proxiedDownload（undici fetch + 走代理 + 默认校验证书），
// 结果代理链路不通时（TLS 握手前即断开）所有下载直接失败（fetch failed / CERT_HAS_EXPIRED）。
// 代理只是兜底，**绝不能作主路径**。SSRF 校验（assertSafeDownloadTarget）两条路径都有，不降安全性。
const DOWNLOAD_ALLOW_HOSTS = config.security?.downloadAllowHosts || []
let visionaryDispatcher = null
function getVisionaryDispatcher() {
  if (!visionaryDispatcher) {
    const explicit = config.image.visionary.proxy
    visionaryDispatcher = explicit === 'direct'
      ? new EnvHttpProxyAgent() // 纯环境变量自适应（无变量=直连）
      : new EnvHttpProxyAgent({ httpProxy: explicit, httpsProxy: explicit })
    console.log(`[visionaryImage] 下载兜底 dispatcher = ${explicit === 'direct' ? '环境变量自适应' : explicit}`)
  }
  return visionaryDispatcher
}

// 代理下载（**仅作兜底**）：直连失败时才调用。SSRF 校验与逐跳重定向沿用共享标准，不降安全性。
async function proxiedDownload(url, maxRedirects = 3, timeoutMs = 180000) {
  await assertSafeDownloadTarget(url, DOWNLOAD_ALLOW_HOSTS)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await undiciFetch(url, {
      dispatcher: getVisionaryDispatcher(),
      // 手动跟随重定向：每一跳都要重新过 SSRF 校验（与 insecureDownload 同标准）
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

// 结果图落盘：**直连优先（insecureDownload，容忍证书异常）→ 失败才代理兜底**。
// 导出仅供验收脚本 `_p1_vis_download.mjs` 直接驱动（不失为上锁点：回归会立即被发现）。
export async function persistResult(url, filename) {
  fs.mkdirSync(uploadsDir, { recursive: true })
  let buf
  try {
    // 主路径：直连（与原实现一致 —— rejectUnauthorized:false 容忍证书异常）
    buf = await insecureDownload(url)
  } catch (e) {
    // 兜底：直连失败（超时 / RST / 证书）→ 才用代理重试
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
  // 清晰度按模型自适应（不能一刀切，配置值与模型不匹配会 400「当前模型不支持所选分辨率」）：
  // - nano-banana-2-lite：固定 1K
  // - nano-banana-pro / nano-banana-2：实测 1K 会 400，必须 ≥2K
  // - gpt-image-2：1K（平台默认即 1K，2K/4K 按 high 质量计费，省钱）
  // - 调用方显式传的 options.resolution 最优先（如 shot-grid 已按模型算好）
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
  // 比例：图生图不传 size 时沿用参考图尺寸；调用方显式传 size 才发
  if (options.size || size) {
    body.size = options.size || size
  }
  // AI 增强仅 nano-banana-pro 生效
  if (model === 'nano-banana-pro' && (options.optimizeChineseText != null ? options.optimizeChineseText : optimizeChineseText)) {
    body.optimizeChineseText = true
  }
  // gpt-image-2 专有质量参数
  if (model === 'gpt-image-2' && options.quality) {
    body.quality = options.quality
  }
  return body
}

/**
 * 文生图：Visionary 异步接口。
 * @param {string} prompt
 * @param {Object} options - { model, size, resolution, quality, filename, usageContext, timeoutMs, ... }
 */
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

/**
 * 图生图：Visionary 异步接口，支持多张参考图。
 * @param {Array<string>} images - 参考图源列表（URL / /uploads/ / base64）
 * @param {string} prompt
 * @param {Object} options - 同 visionaryGenerateImage
 */
export async function visionaryEditImage(images, prompt, options = {}) {
  const startedAt = Date.now()
  const ctx = options.usageContext || {}
  const { apiKey } = config.image.visionary
  if (!apiKey) return { success: false, error: 'VISIONARY_API_KEY 未配置，请在 server/.env 设置' }
  if (!Array.isArray(images) || !images.length) return { success: false, error: '图生图缺少参考图' }
  if (!prompt || !String(prompt).trim()) return { success: false, error: 'prompt 必填' }

  const model = options.model || config.image.visionary.model
  // 图生图不沿用 config.size（如 16:9 会把竖版三视图裁成横版）；只有调用方显式传 size 才发，否则沿用参考图比例
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
