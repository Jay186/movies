// ZIKL 生图站（gpt-image-2）文生图封装（后端版）
// OpenAI 兼容 images 接口：POST {baseURL}/v1/images/generations，返回 b64_json。
// 与 RunningHub 工作流并行存在：纯文生图默认走这里（可由 IMAGE_PROVIDER 切回 RunningHub）。
import { config } from '../config.js'
import { logAiCall } from './aiLog.js'
import { insecureDownload } from './runninghub.js'
// mimeFromExt / netErrMsg 统一到 shared.js（原来本文件与 visionaryImage.js 各有一份）
import { mimeFromExt, netErrMsg } from './shared.js'
import undiciPkg from 'undici'
// Blob 用 Node 全局标准类型即可（undici fetch 原生识别），FormData 必须用 undici 自带的
const { fetch: undiciFetch, EnvHttpProxyAgent, FormData: UndiciFormData } = undiciPkg
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const uploadsDir = path.join(__dirname, '..', 'uploads')

// zikl 站点在海外：本机直连时好时坏（代理软件规则模式下直连被墙 → UND_ERR_CONNECT_TIMEOUT，
// TUN/全局模式下又能直连，行为随代理模式漂移）。系统代理对 Node 全局 fetch 不生效，
// 用 undici + EnvHttpProxyAgent 显式走代理。
// 注意：EnvHttpProxyAgent 只认「进程环境变量」——服务若从没带 HTTPS_PROXY 的终端/自启
// 方式启动，会退化成直连而被墙（2026-08-31 复现 fetch failed）。因此默认显式固定本机
// 代理端口；可用 ZIKL_PROXY 覆盖地址，设 ZIKL_PROXY=direct 恢复"跟随环境变量"的自适应行为。
let ziklDispatcher = null
function getZiklDispatcher() {
  if (!ziklDispatcher) {
    const explicit = config.image.zikl.proxy
    ziklDispatcher = explicit === 'direct'
      ? new EnvHttpProxyAgent() // 纯环境变量自适应（无变量=直连）
      : new EnvHttpProxyAgent({ httpProxy: explicit, httpsProxy: explicit })
    console.log(`[ziklImage] dispatcher = ${explicit === 'direct' ? '环境变量自适应' : explicit}`)
  }
  return ziklDispatcher
}
// undici 把真实网络原因（如 UND_ERR_CONNECT_TIMEOUT / ECONNRESET）藏在 e.cause，拼进错误信息便于排查
// netErrMsg 已统一到 shared.js（原此处与 visionaryImage.js 各有一份）

/**
 * 带重试的请求：网络瞬断（ECONNRESET / upstream reset）与上游 5xx 多为瞬时故障，
 * 实测多张参考图的请求重置率不低，重试往往一次就过。
 * 自身超时（AbortError）不重试——那说明生图本身慢，重试只会重复扣费。
 */
async function fetchWithRetry(url, init, { timeoutMs = 300000, attempts = 3, backoff = [1500, 4000] } = {}) {
  let res = null
  let lastErr = null
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const r = await undiciFetch(url, { ...init, signal: controller.signal, dispatcher: getZiklDispatcher() })
      // 4xx（400/401 等）是请求本身的问题，重试无意义，直接返回
      if (r.ok || r.status < 500) {
        res = r
        clearTimeout(timer)
        break
      }
      lastErr = new Error(`HTTP ${r.status}`)
    } catch (e) {
      lastErr = e
      if (e.name === 'AbortError') {
        clearTimeout(timer)
        break
      }
    } finally {
      clearTimeout(timer)
    }
    if (attempt < attempts - 1) {
      console.warn(`[ziklImage] 请求第 ${attempt + 1} 次失败，${backoff[attempt]}ms 后重试:`, lastErr?.message)
      await new Promise((r) => setTimeout(r, backoff[attempt]))
    }
  }
  if (!res) {
    throw lastErr?.name === 'AbortError'
      ? new Error(`请求超时(${Math.round(timeoutMs / 1000)}s)`)
      : (lastErr || new Error('请求失败'))
  }
  return res
}

// 参考图体积压缩：资产图普遍 1.5MB+ PNG，一个镜头多张（角色×N + 场景 + 道具）叠加后
// multipart 会到十几 MB，代理/上游常在传输中重置连接（ECONNRESET，2026-08-31 实测）。
// 统一缩到 1024 边长 JPEG 再传——参考图只用于锁定外形，这个尺寸对一致性无可观测影响。
const REF_MAX_BYTES = 400 * 1024
const REF_MAX_EDGE = 1024
// ⚠️ 故意与 ai/visionaryImage.js 的 shrinkRef 保持两份实现，不要合并！
//    签名不同：本文件 (ref{...}) → 返回 ref；visionaryImage.js (buffer, filename, mimeType) → 返回对象。
//    2026-09-11 修复：旧版对回调版 execFile 直接 await（不等 ffmpeg 跑完就查输出文件），
//    existsSync 几乎必为 false → 静默放弃压缩、原图直传，multipart 超大 ECONNRESET 的根因
//    从未真正消除。已改 promisify 版本，await 真正等待转码完成。
//    详见 ai/shared.js 顶部「故意不合并清单」。
const execFile = promisify(execFileCb)
async function shrinkRef(ref) {
  if (!ref?.buffer || ref.buffer.length <= REF_MAX_BYTES) return ref
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  // 用系统临时目录：uploads 目录的删除操作在某些环境会被安全策略拦截，导致临时文件堆积
  const tmpDir = os.tmpdir()
  const inPath = path.join(tmpDir, `zikl_ref_in_${stamp}.img`)
  const outPath = path.join(tmpDir, `zikl_ref_out_${stamp}.jpg`)
  try {
    const ffmpegPath = (await import('ffmpeg-static')).default
    fs.writeFileSync(inPath, ref.buffer)
    await execFile(ffmpegPath, [
      '-y', '-i', inPath,
      '-vf', `scale='min(${REF_MAX_EDGE},iw)':-2`,
      '-q:v', '4', outPath,
    ])
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
      return { buffer: fs.readFileSync(outPath), filename: 'ref.jpg', mimeType: 'image/jpeg' }
    }
  } catch (e) {
    console.warn('[ziklImage] 参考图压缩失败，改用原图:', e.message)
  } finally {
    for (const p of [inPath, outPath]) {
      try { fs.rmSync(p, { force: true }) } catch { /* ignore */ }
    }
  }
  return ref
}

/**
 * 调 ZIKL 生图站文生图，落盘到 server/uploads，返回可直接存库的 /uploads/ 本地路径。
 * @param {string} prompt - 提示词
 * @param {Object} options
 *   - size: 尺寸（可选，如 1024x1024；不传用网关默认）
 *   - quality: 质量（可选）
 *   - n: 张数（默认 1，业务当前只用单张）
 *   - filename: 落盘文件名（可选，默认 zikl_<ts>.png；会做 basename 防穿越）
 *   - model: 覆盖默认模型
 *   - timeoutMs: 超时（默认 300s，单张实测约 40s，留足余量）
 *   - usageContext: { episodeId, task } 供成本归集
 * @returns {Promise<{success: boolean, url?: string, width?: number, height?: number, error?: string}>}
 */
export async function ziklGenerateImage(prompt, options = {}) {
  const { apiKey, baseURL, model: defaultModel, size: defaultSize } = config.image.zikl
  const startedAt = Date.now()
  const ctx = options.usageContext || {}

  if (!apiKey) {
    return { success: false, error: 'ZIKL_API_KEY 未配置，请在 server/.env 设置' }
  }
  if (!prompt || !String(prompt).trim()) {
    return { success: false, error: 'prompt 必填' }
  }

  const body = {
    model: options.model || defaultModel,
    prompt: String(prompt),
    n: options.n || 1,
    response_format: 'b64_json', // 显式要 base64，避免默认 url（仅 15 分钟有效）导致取不到图
    size: options.size || defaultSize || '1K',
  }
  if (options.quality) body.quality = options.quality

  const timeoutMs = options.timeoutMs || 300000

  let res
  try {
    res = await fetchWithRetry(`${baseURL}/v1/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    }, { timeoutMs })
  } catch (e) {
    const msg = netErrMsg(e)
    logAiCall({
      kind: 'image', model: body.model, episodeId: ctx.episodeId, task: ctx.task || 'image',
      latencyMs: Date.now() - startedAt, success: false, errorFamily: /超时/.test(msg) ? 'timeout' : 'unknown', errorMsg: msg,
    })
    return { success: false, error: msg }
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    const family = res.status === 401 || res.status === 403 ? 'auth'
      : res.status === 429 ? 'rate_limit'
      : res.status >= 500 ? 'server'
      : 'content'
    const msg = `生图失败 (HTTP ${res.status})${errText ? ': ' + errText.slice(0, 300) : ''}`
    logAiCall({
      kind: 'image', model: body.model, episodeId: ctx.episodeId, task: ctx.task || 'image',
      latencyMs: Date.now() - startedAt, success: false, errorFamily: family, errorMsg: msg,
    })
    return { success: false, error: msg }
  }

  let data
  try {
    data = await res.json()
  } catch (e) {
    const msg = `生图返回解析失败: ${e.message}`
    logAiCall({ kind: 'image', model: body.model, episodeId: ctx.episodeId, task: ctx.task || 'image', latencyMs: Date.now() - startedAt, success: false, errorFamily: 'content', errorMsg: msg })
    return { success: false, error: msg }
  }

  const items = Array.isArray(data?.data) ? data.data : []
  const item = items[0]
  if (!item || (!item.b64_json && !item.url)) {
    const msg = '生图返回缺少图片数据'
    logAiCall({ kind: 'image', model: body.model, episodeId: ctx.episodeId, task: ctx.task || 'image', latencyMs: Date.now() - startedAt, success: false, errorFamily: 'content', errorMsg: msg })
    return { success: false, error: msg }
  }

  // 业务当前只需单张，取第一张落盘
  let filename = options.filename || `zikl_${Date.now()}.png`
  filename = path.basename(String(filename))
  if (!filename) filename = `zikl_${Date.now()}.png`

  try {
    // 优先 base64；网关若返回 url（15 分钟有效）则下载落本地
    const buf = item.b64_json ? Buffer.from(item.b64_json, 'base64') : await insecureDownload(item.url)
    fs.mkdirSync(uploadsDir, { recursive: true })
    fs.writeFileSync(path.join(uploadsDir, filename), buf)
  } catch (e) {
    const msg = `图片落盘失败: ${e.message}`
    logAiCall({ kind: 'image', model: body.model, episodeId: ctx.episodeId, task: ctx.task || 'image', latencyMs: Date.now() - startedAt, success: false, errorFamily: 'unknown', errorMsg: msg })
    return { success: false, error: msg }
  }

  logAiCall({ kind: 'image', model: body.model, episodeId: ctx.episodeId, task: ctx.task || 'image', latencyMs: Date.now() - startedAt, success: true })
  return { success: true, url: `/uploads/${filename}`, width: item.width, height: item.height }
}

// ===== 图生图（edits）：gpt-image-2 支持多张参考图合成/编辑 =====

// mimeFromExt 已统一到 shared.js（原此处 / runninghub.js / visionaryImage.js 各有一份）

/**
 * 解析图片源为 { buffer, filename, mimeType }。
 * 支持：base64 data URI、http(s) URL、/uploads/ 相对路径、本地绝对路径。
 */
async function resolveImageBuffer(source) {
  const s = String(source)
  const base64Match = s.match(/^data:(image)\/([\w+.-]+);base64,(.+)$/i)
  if (base64Match) {
    const kind = base64Match[1].toLowerCase()
    const ext0 = base64Match[2].toLowerCase()
    const ext = ext0 === 'jpeg' ? 'jpg' : ext0
    return {
      buffer: Buffer.from(base64Match[3], 'base64'),
      filename: `ref.${ext}`,
      mimeType: `${kind}/${ext0}`,
    }
  }

  if (/^https?:\/\//i.test(s)) {
    const buffer = await insecureDownload(s)
    const filename = s.split('/').pop()?.split('?')[0] || 'ref.png'
    return { buffer, filename, mimeType: mimeFromExt(filename) }
  }

  if (s.startsWith('/uploads/')) {
    // 先剥查询串（cache-buster），并保留子目录：资产库图存成 /uploads/library/scene/xxx.webp，
    // basename 会吃掉 library/scene 一段拼到根目录 → ENOENT（runninghub.js 已修过同款）
    const relPath = decodeURIComponent(s.split(/[?#]/)[0]).replace(/^\/uploads\//, '')
    const filename = path.basename(relPath)
    const buffer = fs.readFileSync(path.join(uploadsDir, relPath))
    return { buffer, filename, mimeType: mimeFromExt(filename) }
  }

  // 完整本地路径（可能包含 URL 编码与 cache-buster 查询串，先处理）
  const decoded = decodeURIComponent(s.split(/[?#]/)[0])
  const buffer = fs.readFileSync(decoded)
  const basename = path.basename(decoded)
  return { buffer, filename: basename, mimeType: mimeFromExt(basename) }
}

/**
 * 图生图：走 /v1/images/edits（multipart/form-data），支持多张参考图。
 * 对应分镜图（frame）：角色图 + 场景图 → 合成新画面，保持角色/场景一致性。
 * @param {Array<string>} images - 参考图源列表（本地路径 /uploads/、URL 或 base64）
 * @param {string} prompt
 * @param {Object} options - 同 ziklGenerateImage
 * @returns {Promise<{success: boolean, url?: string, width?: number, height?: number, error?: string}>}
 */
export async function ziklEditImage(images, prompt, options = {}) {
  const { apiKey, baseURL, model: defaultModel } = config.image.zikl
  const startedAt = Date.now()
  const ctx = options.usageContext || {}

  if (!apiKey) return { success: false, error: 'ZIKL_API_KEY 未配置，请在 server/.env 设置' }
  if (!Array.isArray(images) || !images.length) return { success: false, error: '图生图缺少参考图' }
  if (!prompt || !String(prompt).trim()) return { success: false, error: 'prompt 必填' }

  let refs
  try {
    // 解析后统一压缩：多张 1.5MB+ 参考图会让 multipart 过大，传输中易被重置
    refs = await Promise.all((await Promise.all(images.map(resolveImageBuffer))).map(shrinkRef))
  } catch (e) {
    const msg = `参考图读取失败: ${e.message}`
    logAiCall({ kind: 'image', model: options.model || defaultModel, episodeId: ctx.episodeId, task: ctx.task || 'image-edit', latencyMs: Date.now() - startedAt, success: false, errorFamily: 'content', errorMsg: msg })
    return { success: false, error: msg }
  }

  const model = options.model || defaultModel
  // 必须用 undici 自己的 FormData/Blob：npm 版 undici fetch 不认 Node 内置的全局 FormData，
  // 会把 multipart 序列化弄坏（网关报 "Model name not specified"，2026-08-31 实测复现）
  const formData = new UndiciFormData()
  formData.append('model', model)
  formData.append('prompt', String(prompt))
  formData.append('n', String(options.n || 1))
  formData.append('response_format', 'b64_json') // 显式要 base64，避免默认 url（仅 15 分钟有效）
  // 图生图：文档要求「不传 size 则沿用参考图尺寸」，默认不发 size；
  // 仅调用方显式指定时才传（如分镜图强制 16:9 可传 1536x1024 / 1344x768，需注意 1K/4K 分组上限）
  if (options.size) formData.append('size', options.size)
  if (options.quality) formData.append('quality', options.quality)
  // 单图用 image 字段；多图用 image[] 字段（官方文档规范）
  const imageField = refs.length === 1 ? 'image' : 'image[]'
  for (const ref of refs) {
    formData.append(imageField, new Blob([ref.buffer], { type: ref.mimeType }), ref.filename)
  }

  const timeoutMs = options.timeoutMs || 300000

  let res
  try {
    res = await fetchWithRetry(`${baseURL}/v1/images/edits`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    }, { timeoutMs })
  } catch (e) {
    const msg = netErrMsg(e)
    logAiCall({ kind: 'image', model, episodeId: ctx.episodeId, task: ctx.task || 'image-edit', latencyMs: Date.now() - startedAt, success: false, errorFamily: /超时/.test(msg) ? 'timeout' : 'unknown', errorMsg: msg })
    return { success: false, error: msg }
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    const family = res.status === 401 || res.status === 403 ? 'auth'
      : res.status === 429 ? 'rate_limit'
      : res.status >= 500 ? 'server'
      : 'content'
    const msg = `图生图失败 (HTTP ${res.status})${errText ? ': ' + errText.slice(0, 300) : ''}`
    logAiCall({ kind: 'image', model, episodeId: ctx.episodeId, task: ctx.task || 'image-edit', latencyMs: Date.now() - startedAt, success: false, errorFamily: family, errorMsg: msg })
    return { success: false, error: msg }
  }

  let data
  try {
    data = await res.json()
  } catch (e) {
    const msg = `图生图返回解析失败: ${e.message}`
    logAiCall({ kind: 'image', model, episodeId: ctx.episodeId, task: ctx.task || 'image-edit', latencyMs: Date.now() - startedAt, success: false, errorFamily: 'content', errorMsg: msg })
    return { success: false, error: msg }
  }

  const items = Array.isArray(data?.data) ? data.data : []
  const item = items[0]
  if (!item || (!item.b64_json && !item.url)) {
    const msg = '图生图返回缺少图片数据'
    logAiCall({ kind: 'image', model, episodeId: ctx.episodeId, task: ctx.task || 'image-edit', latencyMs: Date.now() - startedAt, success: false, errorFamily: 'content', errorMsg: msg })
    return { success: false, error: msg }
  }

  let filename = options.filename || `zikl_edit_${Date.now()}.png`
  filename = path.basename(String(filename))
  if (!filename) filename = `zikl_edit_${Date.now()}.png`

  try {
    // 优先 base64；网关若返回 url（15 分钟有效）则下载落本地
    const buf = item.b64_json ? Buffer.from(item.b64_json, 'base64') : await insecureDownload(item.url)
    fs.mkdirSync(uploadsDir, { recursive: true })
    fs.writeFileSync(path.join(uploadsDir, filename), buf)
  } catch (e) {
    const msg = `图片落盘失败: ${e.message}`
    logAiCall({ kind: 'image', model, episodeId: ctx.episodeId, task: ctx.task || 'image-edit', latencyMs: Date.now() - startedAt, success: false, errorFamily: 'unknown', errorMsg: msg })
    return { success: false, error: msg }
  }

  logAiCall({ kind: 'image', model, episodeId: ctx.episodeId, task: ctx.task || 'image-edit', latencyMs: Date.now() - startedAt, success: true })
  return { success: true, url: `/uploads/${filename}`, width: item.width, height: item.height }
}
