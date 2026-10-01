import { config } from '../config.js'
import { UPLOADS_URL_SLASH, uploadsDir } from '../paths.js'
import { getEffectiveRunningHub, resolveWorkflowId } from '../modelConfig.js'
import { logAiCall } from './aiLog.js'
import { mimeFromExt, assertSafeDownloadTarget, uploadsUrlToAbs, allowHosts } from './shared.js'
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'

// baseURL 用户不可配，保持读 config；nodeMap 是代码资产，保持静态。
// apiKey 与 workflowId 走运行时配置（AI 模型配置热生效），不再做加载期快照。
const { baseURL, nodeMap } = config.runninghub

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 })
}

// 视频通道未配置 → 抛可读 400（不再回退 .env）
function currentApiKey() {
  const { apiKey, configured } = getEffectiveRunningHub()
  if (!configured) throw badRequest('视频通道未配置：请在「AI 模型配置」里为「视频通道」填写 API Key')
  return apiKey
}

async function fetchWithTimeout(url, options = {}, timeoutMs = config.timeouts.http.default) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`请求超时(${timeoutMs}s)`)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

const uploadCache = new Map()
const UPLOAD_CACHE_TTL = 20 * 60 * 60 * 1000

function cacheGet(key) {
  const hit = uploadCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > UPLOAD_CACHE_TTL) {
    uploadCache.delete(key)
    return null
  }
  return hit.value
}

function cacheSet(key, value) {
  uploadCache.set(key, { value, at: Date.now() })
}

export async function insecureDownload(url, maxRedirects = 3, timeoutMs = config.timeouts.http.download) {
  await assertSafeDownloadTarget(url, allowHosts())
  return new Promise((resolve, reject) => {
    const req = https.get(url, { rejectUnauthorized: false }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
        res.resume()
        const nextUrl = new URL(res.headers.location, url).toString()
        insecureDownload(nextUrl, maxRedirects - 1, timeoutMs).then(resolve, reject)
        return
      }
      if (res.statusCode >= 400) {
        res.resume()
        reject(new Error(`下载失败 HTTP ${res.statusCode}`))
        return
      }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`下载超时（${Math.round(timeoutMs / 1000)} 秒）`)))
    req.on('error', reject)
  })
}

export async function resolveLocalMedia(url, id, tag) {
  const u = String(url || '').trim()
  if (u.startsWith(UPLOADS_URL_SLASH)) {
    const rel = decodeURIComponent(u.slice(UPLOADS_URL_SLASH.length))
    if (rel.split('/').some((seg) => seg === '..')) throw new Error(`非法的媒体地址: ${u}`)
    const p = path.join(uploadsDir, rel)
    if (!fs.existsSync(p)) throw new Error(`本地文件已不存在: ${u}`)
    return p
  }
  if (/^https?:/i.test(u)) {
    const buf = await insecureDownload(u)
    const p = path.join(uploadsDir, `shot_${id}_${tag}.mp4`)
    fs.writeFileSync(p, buf)
    return p
  }
  throw new Error(`无法识别的媒体地址: ${u}`)
}

export function isPlausibleMp4(buf) {
  return Buffer.isBuffer(buf) && buf.length > 10240 && buf.subarray(4, 8).toString('latin1') === 'ftyp'
}

export async function downloadWithRetry(url, opts = {}) {
  const { retries = 3, onRetry, validate } = opts
  const delays = [2000, 5000, 10000]
  let lastErr
  for (let i = 0; i <= retries; i++) {
    try {
      const buf = await insecureDownload(url)
      if (validate === 'mp4' && !isPlausibleMp4(buf)) {
        throw new Error(`下载内容不是有效 mp4（${buf ? buf.length : 0} 字节，疑为错误页/残片）`)
      }
      return buf
    } catch (e) {
      lastErr = e
      if (i < retries) {
        const wait = delays[Math.min(i, delays.length - 1)]
        if (onRetry) onRetry(i + 1, wait, e)
        await new Promise((r) => setTimeout(r, wait))
      }
    }
  }
  throw lastErr
}

const BASE64_RE = /^data:(image|audio)\/([\w+.-]+);base64,(.+)$/i
const HTTP_URL_RE = /^https?:\/\//i
const UPLOAD_TIMEOUT_MS = config.timeouts.http.upload

async function uploadBinary(source, { cacheKey, pickValue, fallbackName }) {
  const key = `${cacheKey}:${source}`
  const cached = cacheGet(key)
  if (cached) return cached

  let buffer
  let filename = fallbackName
  let mimeType = 'application/octet-stream'
  const base64Match = source.match(BASE64_RE)
  if (base64Match) {
    buffer = Buffer.from(base64Match[3], 'base64')
    const kind = base64Match[1].toLowerCase()
    const rawExt = base64Match[2].toLowerCase()
    let ext = rawExt
    if (ext === 'jpeg') ext = 'jpg'
    if (kind === 'audio' && ext === 'mpeg') ext = 'mp3'
    filename = `upload.${ext}`
    mimeType = `${kind}/${rawExt}`
  } else if (HTTP_URL_RE.test(source)) {
    buffer = await insecureDownload(source)
    filename = source.split('/').pop()?.split('?')[0] || fallbackName
    mimeType = mimeFromExt(filename)
  } else if (source.startsWith(UPLOADS_URL_SLASH)) {
    const abs = uploadsUrlToAbs(source, uploadsDir)
    if (!abs) throw new Error(`本地素材路径非法或不存在（已拒绝穿越/不存在）: ${source}`)
    buffer = fs.readFileSync(abs)
    filename = path.basename(abs)
    mimeType = mimeFromExt(filename)
  } else {
    const decodedPath = decodeURIComponent(source.split(/[?#]/)[0])
    const abs = path.resolve(decodedPath)
    const root = path.resolve(uploadsDir)
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error(`拒绝读取 uploads 目录之外的本地路径: ${decodedPath}`)
    }
    buffer = fs.readFileSync(abs)
    filename = path.basename(abs)
    mimeType = mimeFromExt(filename)
  }

  const formData = new FormData()
  formData.append('file', new Blob([buffer], { type: mimeType }), filename)
  const res = await fetchWithTimeout(`${baseURL}/openapi/v2/media/upload/binary`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${currentApiKey()}` },
    body: formData,
  }, UPLOAD_TIMEOUT_MS)
  const jr = await res.json()
  const value = jr.data ? pickValue(jr.data) : ''
  if (jr.code !== 0 || !value) throw new Error(jr.message || jr.msg || '上传失败')
  cacheSet(key, value)
  return value
}

export async function uploadImageV2(source) {
  return uploadBinary(source, {
    cacheKey: 'dl',
    pickValue: (data) => data.download_url,
    fallbackName: 'image.png',
  })
}

export async function uploadMediaFileName(source, fallbackName = 'upload.bin') {
  return uploadBinary(source, {
    cacheKey: 'fn',
    pickValue: (data) => data.fileName,
    fallbackName,
  })
}

export async function uploadAudioV2(source) {
  return uploadMediaFileName(source, 'audio.mp3')
}

async function createTaskV1(workflowId, nodeInfoList) {
  const res = await fetchWithTimeout(`${baseURL}/task/openapi/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: currentApiKey(), workflowId, nodeInfoList }),
  })
  return res.json()
}

async function queryOutputsV1(taskId) {
  const res = await fetchWithTimeout(`${baseURL}/task/openapi/outputs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: currentApiKey(), taskId }),
  })
  return res.json()
}

async function createTaskV2(workflowId, nodeInfoList, kind = 'workflow', instanceType = 'default') {
  const path = kind === 'ai-app' ? 'ai-app' : 'workflow'
  const body =
    kind === 'ai-app'
      ? { nodeInfoList, instanceType, usePersonalQueue: 'false' }
      : { addMetadata: true, nodeInfoList, instanceType, usePersonalQueue: 'false' }
  const res = await fetchWithTimeout(`${baseURL}/openapi/v2/run/${path}/${workflowId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${currentApiKey()}` },
    body: JSON.stringify(body),
  })
  return res.json()
}

async function queryOutputsV2(taskId) {
  const res = await fetchWithTimeout(`${baseURL}/openapi/v2/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${currentApiKey()}` },
    body: JSON.stringify({ taskId }),
  })
  return res.json()
}

export async function queryTaskOutput(taskId) {
  try {
    const output = await queryOutputsV2(taskId)
    if (output && !output.errorCode) {
      const { status, results } = output
      if (status === 'SUCCESS') {
        const all = Array.isArray(results) ? results : []
        return { status: 'success', url: all[0]?.url || '', allResults: all }
      }
      if (status === 'FAILED') {
        const reason = output.failedReason || {}
        return { status: 'failed', error: reason.exception_message || output.errorMessage || '任务执行失败' }
      }
      if (status) return { status: status === 'QUEUED' ? 'queued' : 'running' }
    }
  } catch {  }
  const output = await queryOutputsV1(taskId)
  const { code, data } = output
  if (code === 0 && data) {
    const urls = Array.isArray(data) ? data : [data]
    return { status: 'success', url: urls[0]?.fileUrl || '', allResults: urls }
  }
  if (code === 805) {
    return { status: 'failed', error: data?.failedReason?.exception_message || '任务执行失败' }
  }
  return { status: code === 813 ? 'queued' : 'running' }
}

export async function cancelTask(taskId) {
  if (!taskId) return false
  try {
    const res = await fetchWithTimeout(`${baseURL}/task/openapi/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${currentApiKey()}` },
      body: JSON.stringify({ apiKey: currentApiKey(), taskId: String(taskId) }),
    })
    const jr = await res.json()
    return jr.code === 0
  } catch (e) {
    console.error('[cancelTask] error:', e.message)
    return false
  }
}

async function runWorkflowImpl(workflowKey, values = {}, options = {}) {
  const workflowId = resolveWorkflowId(workflowKey)
  const mapping = nodeMap[workflowKey]
  if (!workflowId || !mapping) {
    return { success: false, error: `工作流「${workflowKey}」未配置` }
  }

  const isV2 = mapping.apiVersion === 'v2'
  const kind = mapping.kind || 'workflow'
  const instanceType = mapping.instanceType || 'default'
  const { onProgress, timeout = config.timeouts.workflow.poll } = options
  const pollInterval = isV2 ? 5000 : 3000

  const nodeInfoList = []
  for (const [fieldKey, fieldValue] of Object.entries(values)) {
    const nodeMapping = mapping[fieldKey]
    if (!nodeMapping) continue
    if (!nodeMapping.nodeId) continue
    if (fieldValue === undefined || fieldValue === null || fieldValue === '') continue
    nodeInfoList.push({
      nodeId: String(nodeMapping.nodeId),
      fieldName: nodeMapping.fieldName,
      fieldValue: String(fieldValue),
    })
  }

  const isQueueMaxed = (r) =>
    `${r?.code ?? ''} ${r?.msg ?? ''} ${r?.errorMessage ?? ''} ${r?.message ?? ''}`
      .toUpperCase()
      .includes('TASK_QUEUE_MAXED')
  const maxSubmitAttempts = 45
  const submitBackoff = 8000
  onProgress?.('submitting', { message: '提交任务中...' })
  let createResult
  try {
    for (let attempt = 1; attempt <= maxSubmitAttempts; attempt++) {
      if (options.cancelToken?.cancelled) {
        return { success: false, cancelled: true }
      }
      createResult = isV2
        ? await createTaskV2(workflowId, nodeInfoList, kind, instanceType)
        : await createTaskV1(workflowId, nodeInfoList)
      if (!isQueueMaxed(createResult)) break
      onProgress?.('queued', { message: `云端队列已满，等待空闲(${attempt}/${maxSubmitAttempts})...` })
      await new Promise((r) => setTimeout(r, submitBackoff))
    }
  } catch (e) {
    return { success: false, error: `提交任务失败: ${e.message}` }
  }
  if (isQueueMaxed(createResult)) {
    return {
      success: false,
      error: '云端任务队列持续已满：已多次等待仍无空闲，请稍后在 RunningHub 平台确认是否有卡住/未释放的任务后再试',
    }
  }

  let taskId
  if (isV2) {
    if (!createResult.taskId) {
      console.error('[runWorkflow] create failed (v2):', createResult)
      return { success: false, error: createResult.errorMessage || createResult.msg || '任务提交失败', detail: createResult }
    }
    taskId = createResult.taskId
  } else {
    if (createResult.code !== 0) {
      console.error('[runWorkflow] create failed (v1):', createResult)
      return { success: false, error: createResult.msg || '任务提交失败', detail: createResult }
    }
    taskId = createResult.data?.taskId
  }
  options.onTaskId?.(taskId)
  onProgress?.('queued', { taskId, message: '排队中...' })
  // 提交留痕：把本次发给 RunningHub 的完整参数落盘（纯出片参数，不含任何密钥），便于核对传参
  try {
    const dumpDir = path.resolve(process.cwd(), 'generated')
    fs.mkdirSync(dumpDir, { recursive: true })
    fs.writeFileSync(path.join(dumpDir, 'last-submit-params.json'), JSON.stringify({ at: new Date().toISOString(), workflowKey, workflowId, taskId, nodeInfoList }, null, 2))
  } catch {  }

  const startTime = Date.now()
  let consecutiveErrors = 0
  while (Date.now() - startTime < timeout) {
    if (options.cancelToken?.cancelled) {
      await cancelTask(taskId)
      return { success: false, cancelled: true, taskId }
    }
    await new Promise((r) => setTimeout(r, pollInterval))

    let output
    try {
      output = isV2 ? await queryOutputsV2(taskId) : await queryOutputsV1(taskId)
    } catch (e) {
      consecutiveErrors++
      console.warn(`[runWorkflow] 查询任务状态失败（连续 ${consecutiveErrors} 次）:`, e.message)
      if (consecutiveErrors >= 100) {
        return { success: false, error: '连续查询失败，已中止', taskId }
      }
      continue
    }
    consecutiveErrors = 0

    if (isV2) {
      const { status, results } = output
      if (status === 'SUCCESS') {
        const url = Array.isArray(results) && results.length ? results[0].url : ''
        onProgress?.('done', { taskId, message: '生成完成' })
        return { success: !!url, url, taskId, allResults: Array.isArray(results) ? results : [], raw: output }
      }
      if (status === 'FAILED') {
        const reason = output.failedReason || {}
        const errMsg = reason.exception_message || (Array.isArray(reason.traceback) ? reason.traceback[0] : '') || '任务执行失败'
        return { success: false, error: errMsg, taskId, raw: output }
      }
      onProgress?.('running', { taskId, message: '生成中...' })
      continue
    }

    const { code, data } = output

    if (code === 0 && data) {
      const urls = Array.isArray(data) ? data : [data]
      const fileUrl = urls[0]?.fileUrl || ''
      onProgress?.('done', { taskId, message: '生成完成' })
      return { success: true, url: fileUrl, taskId, allResults: urls, raw: output }
    }

    if (code === 805) {
      const reason = data?.failedReason
      return {
        success: false,
        error: reason ? `节点 ${reason.node_name} 失败: ${reason.exception_message}` : '任务执行失败',
        taskId,
      }
    }

    const status = code === 813 ? 'queued' : 'running'
    onProgress?.(status, { taskId, message: status === 'queued' ? '排队中...' : '生成中...' })
  }

  return { success: false, error: '任务超时', taskId, timeout: true }
}

export async function runWorkflow(workflowKey, values = {}, options = {}) {
  // 前置校验：视频通道未配置 / 该工作流条目缺失或全部停用 → 抛可读 400。
  // 不再回退 .env，也绝不把空 workflowId 发出去（空 ID 会被 RunningHub 拒绝且难定位）。
  const { configured } = getEffectiveRunningHub()
  if (!configured) throw badRequest('视频通道未配置：请在「AI 模型配置」里为「视频通道」填写 API Key')
  if (!resolveWorkflowId(workflowKey)) {
    throw badRequest(`工作流「${workflowKey}」未配置：请在「AI 模型配置」的「视频通道」里添加并启用该工作流`)
  }
  const startedAt = Date.now()
  const ctx = options.usageContext || {}
  try {
    const result = await runWorkflowImpl(workflowKey, values, options)
    logAiCall({
      kind: 'runninghub',
      model: workflowKey,
      episodeId: ctx.episodeId,
      task: ctx.task || workflowKey,
      frames: ctx.frames,
      latencyMs: Date.now() - startedAt,
      success: !!(result.success),
      errorFamily: result.success ? '' : (result.cancelled ? 'cancelled' : (result.timeout ? 'timeout' : 'content')),
      errorMsg: result.success ? '' : (result.error || ''),
    })
    return result
  } catch (e) {
    const { family } = (function () {
      if (/超时|timeout|abort/i.test(e?.message || '')) return { family: 'timeout' }
      if (/cancel|取消/i.test(e?.message || '')) return { family: 'cancelled' }
      return { family: 'unknown' }
    })()
    logAiCall({
      kind: 'runninghub',
      model: workflowKey,
      episodeId: ctx.episodeId,
      task: ctx.task || workflowKey,
      frames: ctx.frames,
      latencyMs: Date.now() - startedAt,
      success: false,
      errorFamily: family,
      errorMsg: e?.message || String(e),
    })
    throw e
  }
}
