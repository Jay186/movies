import { config } from '../config.js'
import { logAiCall } from './aiLog.js'
import { insecureDownload } from './runninghub.js'
import { mimeFromExt, netErrMsg } from './shared.js'
import undiciPkg from 'undici'
const { fetch: undiciFetch, EnvHttpProxyAgent, FormData: UndiciFormData } = undiciPkg
import fs from 'node:fs'
import path from 'node:path'
import { uploadsDir } from '../paths.js'
import { shrinkRefImage } from './refImage.js'


let ziklDispatcher = null
function getZiklDispatcher() {
  if (!ziklDispatcher) {
    const explicit = config.image.zikl.proxy
    ziklDispatcher = explicit === 'direct'
      ? new EnvHttpProxyAgent() 
      : new EnvHttpProxyAgent({ httpProxy: explicit, httpsProxy: explicit })
    console.log(`[ziklImage] dispatcher = ${explicit === 'direct' ? '环境变量自适应' : explicit}`)
  }
  return ziklDispatcher
}

async function fetchWithRetry(url, init, { timeoutMs = 300000, attempts = 3, backoff = [1500, 4000] } = {}) {
  let res = null
  let lastErr = null
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const r = await undiciFetch(url, { ...init, signal: controller.signal, dispatcher: getZiklDispatcher() })
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

async function shrinkRef(ref) {
  if (!ref?.buffer) return ref
  const out = await shrinkRefImage(ref.buffer, 'zikl', ref.filename, ref.mimeType)
  return { ...ref, ...out }
}

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
    response_format: 'b64_json', 
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

  let filename = options.filename || `zikl_${Date.now()}.png`
  filename = path.basename(String(filename))
  if (!filename) filename = `zikl_${Date.now()}.png`

  try {
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
    const relPath = decodeURIComponent(s.split(/[?#]/)[0]).replace(/^\/uploads\//, '')
    const filename = path.basename(relPath)
    const buffer = fs.readFileSync(path.join(uploadsDir, relPath))
    return { buffer, filename, mimeType: mimeFromExt(filename) }
  }

  const decoded = decodeURIComponent(s.split(/[?#]/)[0])
  const buffer = fs.readFileSync(decoded)
  const basename = path.basename(decoded)
  return { buffer, filename: basename, mimeType: mimeFromExt(basename) }
}

export async function ziklEditImage(images, prompt, options = {}) {
  const { apiKey, baseURL, model: defaultModel } = config.image.zikl
  const startedAt = Date.now()
  const ctx = options.usageContext || {}

  if (!apiKey) return { success: false, error: 'ZIKL_API_KEY 未配置，请在 server/.env 设置' }
  if (!Array.isArray(images) || !images.length) return { success: false, error: '图生图缺少参考图' }
  if (!prompt || !String(prompt).trim()) return { success: false, error: 'prompt 必填' }

  let refs
  try {
    refs = await Promise.all((await Promise.all(images.map(resolveImageBuffer))).map(shrinkRef))
  } catch (e) {
    const msg = `参考图读取失败: ${e.message}`
    logAiCall({ kind: 'image', model: options.model || defaultModel, episodeId: ctx.episodeId, task: ctx.task || 'image-edit', latencyMs: Date.now() - startedAt, success: false, errorFamily: 'content', errorMsg: msg })
    return { success: false, error: msg }
  }

  const model = options.model || defaultModel
  const formData = new UndiciFormData()
  formData.append('model', model)
  formData.append('prompt', String(prompt))
  formData.append('n', String(options.n || 1))
  formData.append('response_format', 'b64_json') 
  if (options.size) formData.append('size', options.size)
  if (options.quality) formData.append('quality', options.quality)
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
