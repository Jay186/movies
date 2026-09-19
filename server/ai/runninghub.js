// RunningHub 工作流封装（后端版）
import { config } from '../config.js'
import { logAiCall } from './aiLog.js'
// mimeFromExt 统一到 shared.js（原此处 / visionaryImage.js / ziklImage.js 各有一份）
// assertSafeDownloadTarget：下载 SSRF 守卫（2026-09-16），由 insecureDownload 每跳调用
// uploadsUrlToAbs：本地资产路径解析 + 防穿越（2026-09-18 收口上传读文件路径）
import { mimeFromExt, assertSafeDownloadTarget, uploadsUrlToAbs } from './shared.js'
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import { fileURLToPath } from 'node:url'

const { apiKey, baseURL, workflows, nodeMap } = config.runninghub
// 下载白名单：自建 CDN / 内网对象存储的部署可用 env 放行（默认空 = 只允许公网）
const DOWNLOAD_ALLOW_HOSTS = config.security?.downloadAllowHosts || []

/**
 * 带超时的 fetch：超时后 abort 并抛出明确错误，防止裸 fetch 永久挂起任务链路
 * @param {string} url
 * @param {Object} options - 透传给 fetch 的选项
 * @param {number} timeoutMs - 超时毫秒数（默认 30 秒；二进制上传建议 60 秒）
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
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

// server/uploads：本地资产图目录（与 routes/generate.js 一致）
// 使用 fileURLToPath 正确处理 Windows 路径和中文字符（避免 URL 编码问题）
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const uploadsDir = path.join(__dirname, '..', 'uploads')

// 已上传资源的进程内缓存：key = 命名空间 + 来源（本地路径或原始 URL），value = { value, at }
// RunningHub download_url 仅 24h 有效，缓存超过 20h 强制重传，避免跨天用过期 URL
// 注意：必须带命名空间前缀（dl: / fn:）——同一张图既可能要 download_url（LoadImage URL 槽）
// 也可能要 fileName（COMBO/timeline 槽），裸 source 作 key 会互相串值
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

/**
 * 下载文件（绕过证书过期：RunningHub 老 CDN 证书已过期）
 * 带超时（默认 180 秒，防止永久挂起 pipeline）并跟随 3xx 重定向（否则 302 会落一个空文件）
 * 注：原为 60 秒，实测国内 → 腾讯云 COS（北京）链路偶发慢到 60s 都拉不完 2MB 成片，
 * 一旦超时，调用方只能退化成 24h 时效的云端 URL，本地文件永久缺失（86/88 都踩过，靠手工 curl 抢救）。
 *
 * ⚠️ SSRF 守卫（2026-09-16）：下载地址来自用户可写的 `video_url`/图片 URL，必须校验为公网目标，
 * 否则可被用来探测内网/云元数据（169.254.169.254）。校验放在**函数入口**：
 * 重定向分支是递归调用本函数，所以每一跳都会重新校验，公网 → 内网的跳转绕过被堵死。
 * 放行名单见 config.security.downloadAllowHosts（默认空 = 只允许公网）。
 * @param {string} url
 * @returns {Promise<Buffer>}
 */
export async function insecureDownload(url, maxRedirects = 3, timeoutMs = 180000) {
  // 校验不通过直接抛（消息面向用户，调用方按普通下载失败处理）
  await assertSafeDownloadTarget(url, DOWNLOAD_ALLOW_HOSTS)
  return new Promise((resolve, reject) => {
    const req = https.get(url, { rejectUnauthorized: false }, (res) => {
      // 跟随重定向
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
        res.resume()
        const nextUrl = new URL(res.headers.location, url).toString()
        // 递归 → 下一跳入口会再校验一次 SSRF（勿改成内联请求，否则丢掉逐跳校验）
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

/**
 * 把媒体地址解析成本地绝对路径（出片后处理链公共入口：衔接检测 / 观片闸）。
 *
 * 2026-09-19 收口：ai/seamCheck.js 与 ai/shotReview.js 原先各写一份近乎逐字节相同的
 * 本函数，唯一差别是远端兜底的落盘文件名（seamCheck 用 `shot_${id}_${tag}.mp4`，
 * shotReview 把 tag 写死成 'review_src'）。两处注释互相写着「与 X 同范式」，
 * 实际改一处另一处不生效。
 *
 * 为什么落在这里：本模块已拥有 `insecureDownload`（远端兜底那半）与 `uploadsDir`
 * （本地路径那半），是两半的自然交汇点；放 ai/shared.js 反而会构成
 * shared ↔ runninghub 循环导入（runninghub 自身要 import shared）。
 *
 * 两条铁律（与 shared.uploadsUrlToAbs 同口径；历史由 path.basename 扁平化写法导致
 * `/uploads/segments/segN/x.mp4` 解析失败、段级出片后拼片 400）：
 *   ① 保留子目录：不得用 basename 压平路径；
 *   ② 防路径穿越：URL 里不允许出现 `..` 段。
 *
 * @param {string} url 媒体地址（落库的 video_url / continuity_url 等）
 * @param {string|number} id 镜头 id（仅用于远端兜底文件名，保证同镜反复调用幂等覆盖）
 * @param {string} tag 用途标签（'seam' / 'anchor' / 'tone' / 'review_src'），决定兜底文件名
 * @returns {Promise<string>} 本地绝对路径
 */
export async function resolveLocalMedia(url, id, tag) {
  const u = String(url || '').trim()
  if (u.startsWith('/uploads/')) {
    const rel = decodeURIComponent(u.slice('/uploads/'.length))
    // 防路径穿越：URL 不允许出现 .. 段
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

/**
 * 成片内容校验（2026-09-15）：COS 偶发返回 HTTP 200 但 body 是 XML 错误页或截断残片——
 * HTTP 状态码挡不住，不校验就落盘会得到一个"文件存在但播不了"的假 mp4（比下载失败更阴：
 * 下游钩子链拿到假文件全部静默坏掉）。ISO BMFF 规定第 5~8 字节固定为 'ftyp'；>10KB 防碎片。
 * @param {Buffer} buf
 */
export function isPlausibleMp4(buf) {
  return Buffer.isBuffer(buf) && buf.length > 10240 && buf.subarray(4, 8).toString('latin1') === 'ftyp'
}

/**
 * 成片下载（带退避重试，2026-09-12）：出片刚完成时 COS/CDN 链接偶发未就绪（403/未同步/连接抖动），
 * 单次+立即重试等于连撞同一堵墙——第 1 集实锤约 40% 失败率（105/87/109 三次手动转存）。
 * 退避 2s/5s/10s 跨过就绪窗口；全部失败才抛（调用方降级 24h 云端 URL）。
 * 2026-09-15 起 validate:'mp4' 时对 body 做 ftyp+体积校验，假成片当作下载失败进重试。
 * @param {string} url
 * @param {{retries?: number, onRetry?: (n:number, waitMs:number, err:Error)=>void, validate?: 'mp4'}} opts
 */
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

/**
 * 把图片上传到 RunningHub（v2 media upload），返回可直接作为 LoadImage fieldValue 的 download_url
 * @param {string} source - 本地绝对路径 或 http(s) URL
 * @returns {Promise<string>} download_url（24h 有效）
 */
// 根据文件扩展名推断媒体 MIME（图片/音频）
// mimeFromExt 已统一到 shared.js（原此处 / visionaryImage.js / ziklImage.js 各有一份）
export async function uploadImageV2(source) {
  const cached = cacheGet('dl:' + source)
  if (cached) return cached

  let buffer
  let filename = 'image.png'
  let mimeType = 'image/png'
  const base64Match = source.match(/^data:(image|audio)\/([\w+.-]+);base64,(.+)$/i)
  if (base64Match) {
    buffer = Buffer.from(base64Match[3], 'base64')
    const kind = base64Match[1].toLowerCase()
    let ext = base64Match[2].toLowerCase()
    if (ext === 'jpeg') ext = 'jpg'
    if (kind === 'audio' && ext === 'mpeg') ext = 'mp3'
    filename = `upload.${ext}`
    mimeType = `${kind}/${base64Match[2].toLowerCase()}`
  } else if (/^https?:\/\//i.test(source)) {
    buffer = await insecureDownload(source)
    filename = source.split('/').pop()?.split('?')[0] || 'image.png'
    mimeType = mimeFromExt(filename)
  } else if (source.startsWith('/uploads/')) {
    // 本地资产相对 URL → 读 server/uploads 下的文件（图片/音频共用）
    // [安全 2026-09-18] 收口到 uploadsUrlToAbs：统一防穿越校验（/uploads/../.env 一律拒绝），
    // 该函数同时处理查询串剥离（cache-buster）、URL 解码与存在性检查，越界/不存在返回 null。
    // 保留子目录能力：资产库存 /uploads/library/scene/xxx.webp，basename 拼法会吃掉子目录段
    const abs = uploadsUrlToAbs(source, uploadsDir)
    if (!abs) throw new Error(`本地素材路径非法或不存在（已拒绝穿越/不存在）: ${source}`)
    buffer = fs.readFileSync(abs)
    filename = path.basename(abs)
    mimeType = mimeFromExt(filename)
  } else {
    // 完整本地路径（可能包含 URL 编码与 cache-buster 查询串，先处理）
    // [安全 2026-09-18] 仅接受落在 uploads 目录内的路径；之外的本地路径一律拒绝。
    // source 可能来自用户可写字段（角色/场景/道具的 image_url/audio_url），
    // 不设防 = 任意本地文件读取原语（可把 server/.env 密钥上传外传）
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
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  }, 60000)
  const jr = await res.json()
  if (jr.code !== 0 || !jr.data?.download_url) {
    throw new Error(jr.message || jr.msg || '上传失败')
  }
  cacheSet('dl:' + source, jr.data.download_url)
  return jr.data.download_url
}

/**
 * 上传媒体并返回 fileName（RunningHub input 目录相对路径）。
 * LoadAudio 等 COMBO 字段、以及导演台 timeline_data 里 refs[].imageFile 都需要文件名；
 * download_url 填不进这些字段，且仅 24h 有效。
 */
export async function uploadMediaFileName(source, fallbackName = 'upload.bin') {
  const cached = cacheGet('fn:' + source)
  if (cached) return cached
  let buffer, filename = fallbackName, mimeType = 'application/octet-stream'
  const base64Match = source.match(/^data:(image|audio)\/([\w+.-]+);base64,(.+)$/i)
  if (base64Match) {
    buffer = Buffer.from(base64Match[3], 'base64')
    const kind = base64Match[1].toLowerCase()
    let ext = base64Match[2].toLowerCase()
    if (ext === 'jpeg') ext = 'jpg'
    if (kind === 'audio' && ext === 'mpeg') ext = 'mp3'
    filename = 'upload.' + ext
    mimeType = kind + '/' + base64Match[2].toLowerCase()
  } else if (/^https?:\/\//i.test(source)) {
    buffer = await insecureDownload(source)
    filename = source.split('/').pop()?.split('?')[0] || 'audio.mp3'
    mimeType = mimeFromExt(filename)
  } else if (source.startsWith('/uploads/')) {
    // [安全 2026-09-18] 同 uploadImageV2：收口到 uploadsUrlToAbs（剥 cache-buster 查询串、
    // 保留 library/scene 等子目录、防穿越校验），与全库其他读 /uploads/ 的口径一致
    const abs = uploadsUrlToAbs(source, uploadsDir)
    if (!abs) throw new Error(`本地素材路径非法或不存在（已拒绝穿越/不存在）: ${source}`)
    buffer = fs.readFileSync(abs)
    filename = path.basename(abs)
    mimeType = mimeFromExt(filename)
  } else {
    // [安全 2026-09-18] 仅接受落在 uploads 目录内的路径；source 可能来自用户可写字段，
    // uploads 之外的本地路径一律拒绝（防任意本地文件读取外传）
    const decodedPath = decodeURIComponent(source)
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
  const res = await fetchWithTimeout(baseURL + '/openapi/v2/media/upload/binary', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey },
    body: formData,
  }, 60000)
  const jr = await res.json()
  if (jr.code !== 0 || !jr.data?.fileName) throw new Error(jr.message || jr.msg || '上传失败')
  cacheSet('fn:' + source, jr.data.fileName)
  return jr.data.fileName
}

// 音频上传：返回 fileName（LoadAudio 节点 COMBO 字段需要文件名）
export async function uploadAudioV2(source) {
  return uploadMediaFileName(source, 'audio.mp3')
}

/**
 * v1 接口（imageGenerator / videoGenerator）：apiKey 放 body，/task/openapi/*
 */
async function createTaskV1(workflowId, nodeInfoList) {
  const res = await fetchWithTimeout(`${baseURL}/task/openapi/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey, workflowId, nodeInfoList }),
  })
  return res.json()
}

/**
 * v1 查询任务输出
 * code: 0=成功, 804=运行中, 813=排队中, 805=失败
 */
async function queryOutputsV1(taskId) {
  const res = await fetchWithTimeout(`${baseURL}/task/openapi/outputs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey, taskId }),
  })
  return res.json()
}

/**
 * v2 接口（storyboardGenerator 等新工作流）：Bearer 鉴权，
 * 提交 /openapi/v2/run/{workflow|ai-app}/{id}，taskId 在响应顶层；
 * 查询 /openapi/v2/query，结果在 results[].url
 * @param {string} workflowId - workflowId 或 appId
 * @param {Array} nodeInfoList
 * @param {string} kind - 'workflow' | 'ai-app'
 * @param {string} instanceType - 'default' | 'lite' | 'plus'
 */
async function createTaskV2(workflowId, nodeInfoList, kind = 'workflow', instanceType = 'default') {
  const path = kind === 'ai-app' ? 'ai-app' : 'workflow'
  const body =
    kind === 'ai-app'
      ? { nodeInfoList, instanceType, usePersonalQueue: 'false' }
      : { addMetadata: true, nodeInfoList, instanceType, usePersonalQueue: 'false' }
  const res = await fetchWithTimeout(`${baseURL}/openapi/v2/run/${path}/${workflowId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  })
  return res.json()
}

async function queryOutputsV2(taskId) {
  const res = await fetchWithTimeout(`${baseURL}/openapi/v2/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ taskId }),
  })
  return res.json()
}

/**
 * 上传文件到 RunningHub
 */
export async function uploadFile(fileBuffer, filename, mimeType) {
  const formData = new FormData()
  formData.append('apiKey', apiKey)
  formData.append('fileType', 'input')
  formData.append('file', new Blob([fileBuffer], { type: mimeType }), filename)

  const res = await fetchWithTimeout(`${baseURL}/task/openapi/upload`, {
    method: 'POST',
    body: formData,
  }, 60000)
  return res.json()
}

/**
 * 运行工作流（提交 + 轮询 + 返回结果 URL）
 * @param {string} workflowKey - 'imageGenerator' | 'videoGenerator'
 * @param {Object} values - 业务参数 { prompt, image, image2 }
 * @param {Object} options - { onProgress, timeout }
 * @returns {Promise<{success: boolean, url?: string, error?: string, taskId?: string}>}
 */
/**
 * 查询云端任务状态（v1 接口，供重启后恢复视频任务用）
 * @returns {Promise<{status: 'success'|'running'|'queued'|'failed', url?: string, error?: string}>}
 */
export async function queryTaskOutput(taskId) {
  // 2026-09-15 改走 v2 接口（/openapi/v2/query）：v1（/task/openapi/outputs）只回单个 fileUrl，
  // 拿不到多输出节点列表——备用节点机制因此名存实亡（9-15 实锤：主节点 2001 生成即 404、
  // 245 音轨节点完好，备用逻辑一次都没拿到过 245 的 URL，1-4/2-2 连烧 6 次出片）。
  // v2 返回完整 results[]（含 nodeId/outputType），备用节点与打捞守护才真正有米下锅。
  // v2 查不到（老 v1 任务）时回落 v1。
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
  } catch { /* v2 查询异常，回落 v1 */ }
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

/**
 * 取消 ComfyUI 任务（v1 接口 /task/openapi/cancel）
 * 可取消 running 或 queued 状态的任务；返回是否取消成功
 * @param {string} taskId
 * @returns {Promise<boolean>}
 */
export async function cancelTask(taskId) {
  if (!taskId) return false
  try {
    const res = await fetchWithTimeout(`${baseURL}/task/openapi/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ apiKey, taskId: String(taskId) }),
    })
    const jr = await res.json()
    return jr.code === 0
  } catch (e) {
    console.error('[cancelTask] error:', e.message)
    return false
  }
}

async function runWorkflowImpl(workflowKey, values = {}, options = {}) {
  const workflowId = workflows[workflowKey]
  const mapping = nodeMap[workflowKey]
  if (!workflowId || !mapping) {
    return { success: false, error: `工作流「${workflowKey}」未配置` }
  }

  // 该工作流是否走 v2 接口（Bearer + /openapi/v2/*）
  const isV2 = mapping.apiVersion === 'v2'
  const kind = mapping.kind || 'workflow'
  const instanceType = mapping.instanceType || 'default'
  const { onProgress, timeout = 600000 } = options
  const pollInterval = isV2 ? 5000 : 3000

  // 构造 nodeInfoList
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

  // 提交任务（TASK_QUEUE_MAXED = 云端队列已满时自动重试等待空闲，尊重取消信号）
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

  // 解析 taskId
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
  // 把真实 taskId 抛给调用方（用于取消）
  options.onTaskId?.(taskId)
  onProgress?.('queued', { taskId, message: '排队中...' })

  // 轮询
  const startTime = Date.now()
  // 连续查询失败计数：网络抖动可容忍，但持续失败必须中止，否则任务会空转整个超时周期
  let consecutiveErrors = 0
  while (Date.now() - startTime < timeout) {
    // 取消信号：命中后立即向 RunningHub 取消云端任务并退出轮询
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
      // v2: status = QUEUED/RUNNING/SUCCESS/FAILED，结果在 results[].url
      // 工作流有多个 Save/SaveVideo 节点时 results 会有多项，带上 nodeId 供调用方挑选
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
      // allResults：多个 SaveVideo 时按 nodeId 挑选（导演台有主输出 #7 与一采 #18 两路）
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

    // 804=运行中, 813=排队中
    const status = code === 813 ? 'queued' : 'running'
    onProgress?.(status, { taskId, message: status === 'queued' ? '排队中...' : '生成中...' })
  }

  return { success: false, error: '任务超时', taskId, timeout: true }
}

// 观测包装：每次 RunningHub 工作流调用落 ai_calls（成功率/延迟统计的数据源）。
// 调用方可在 options.usageContext 传 {episodeId, task, frames} 做按集/按任务归集。
export async function runWorkflow(workflowKey, values = {}, options = {}) {
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
