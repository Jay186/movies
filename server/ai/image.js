// 统一生图入口（zikl 路线）：
//  - 文生图：generateImage（gpt-image-2 images 接口）
//  - 多图生图：generateStoryboardImage（gpt-image-2 images/edits，多参考图合成）
// 历史 runninghub 路线（imageGenerator / storyboardGenerator / frameGridGenerator 三槽）
// 已下线，分镜图生成只走 zikl。资产图生成仍可由全局 IMAGE_PROVIDER 切到 runninghub。
import { config } from '../config.js'
import { runWorkflow } from './runninghub.js'
import { ziklGenerateImage, ziklEditImage } from './ziklImage.js'
import { visionaryGenerateImage, visionaryEditImage } from './visionaryImage.js'

// Visionary 平台模型（/v1/models 返回：gpt-image-2, Nano_Banana_Pro,
// nano-banana-2-lite, nano-banana-pro-cl）。Nano_Banana_Pro 是平台官方命名，
// nano-banana-pro 是平台兼容的别名，两者都收。
const VISIONARY_MODELS = new Set([
  'gpt-image-2',
  'nano-banana-pro',
  'Nano_Banana_Pro',
  'nano-banana-pro-cl',
  'nano-banana-2-lite',
])
// 支持"带参考图的图生图"（body.images）的模型。实测：
//  - gpt-image-2 只支持文生图，传 images 会报 400「当前模型不受支持」
//  - Nano Banana 系列支持多参考图合成（四宫格角色/场景绑定依赖此能力）
const VISIONARY_EDIT_MODELS = new Set([
  'nano-banana-pro',
  'Nano_Banana_Pro',
  'nano-banana-pro-cl',
  'nano-banana-2-lite',
])

// 退役模型映射（2026-09-16）：visionary 侧的 gpt-image-2 平台已不受支持——
// 实测（ai_calls 历史）文生图与图生图全部 HTTP 400「当前模型不受支持。」，无一次成功。
// 这里统一映射到 nano-banana-pro，文生图 / 图生图两条链路都兜住。
// ⚠️ zikl 侧的 gpt-image-2 是主力模型，不受影响（映射仅在 provider=visionary 时生效）。
const VISIONARY_RETIRED_MODELS = new Map([
  ['gpt-image-2', 'nano-banana-pro'],
])

/**
 * 统一解析 provider / model：
 * - 'runninghub' | 'zikl'：保持历史行为
 * - 'visionary-xxx' / 直接传 visionary 模型名：走 Visionary 并分离出 model
 */
export function resolveProvider(options = {}) {
  let provider = options.provider || config.image.provider
  let model = options.model

  // 前端下拉框 value 形如 'visionary-gpt-image-2'（带 visionary- 前缀），
  // 这里剥离前缀还原模型名，否则平台会收到非法 model 报 400「当前模型不受支持」
  if (typeof model === 'string' && model.startsWith('visionary-')) {
    model = model.slice('visionary-'.length)
    provider = 'visionary'
  }
  if (provider?.startsWith('visionary-')) {
    model = provider.slice('visionary-'.length)
    provider = 'visionary'
  } else if (VISIONARY_MODELS.has(provider)) {
    model = provider
    provider = 'visionary'
  }
  // 显式 model 是 Visionary 模型但 provider 未指定时，也走 Visionary
  if (provider !== 'visionary' && VISIONARY_MODELS.has(model)) {
    provider = 'visionary'
  }
  // 退役模型兜底：visionary 侧不可用的模型自动改切到可用模型（避免直接 400）
  if (provider === 'visionary' && VISIONARY_RETIRED_MODELS.has(model)) {
    const fallback = VISIONARY_RETIRED_MODELS.get(model)
    console.warn(`[resolveProvider] visionary 模型 ${model} 平台已不受支持（实测 400），自动改用 ${fallback}`)
    model = fallback
  }
  return { provider, model }
}

/**
 * 生成一张图片（纯文生图）。返回 { success, url }，url 为 /uploads/ 本地路径。
 * @param {string} prompt
 * @param {Object} options - 透传给底层：{ size, quality, filename, timeoutMs, usageContext, cancelToken, onProgress, provider, model, ... }
 */
export async function generateImage(prompt, options = {}) {
  const { provider, model } = resolveProvider(options)
  console.log('[generateImage] provider=', provider, '| model=', model, '| options.provider=', options.provider, '| config.default=', config.image.provider, '| prompt=', String(prompt).slice(0, 60))
  if (provider === 'runninghub') {
    return runWorkflow('imageGenerator', { prompt }, options)
  }
  if (provider === 'visionary') {
    return visionaryGenerateImage(prompt, { ...options, model })
  }
  return ziklGenerateImage(prompt, options)
}

/**
 * 生成分镜图（多图生图）：角色图 + 场景图作为参考图，合成保持角色/场景一致的新画面。
 * 支持 zikl（gpt-image-2 图生图 /v1/images/edits）和 Visionary（gpt-image-2 / Nano Banana 系列）。
 * @param {string} prompt
 * @param {Array<string>} imageList - 参考图源列表（按顺序：image1 角色图、image2 场景图...）
 * @param {Object} options
 * @returns {Promise<{success: boolean, url?: string, warnings?: string[], error?: string}>}
 */
export async function generateStoryboardImage(prompt, imageList = [], options = {}) {
  const { provider, model } = resolveProvider(options)
  // 防御（2026-09-16）：Visionary 侧只有 Nano Banana 系列支持参考图（body.images），
  // gpt-image-2 传 images 会 400「当前模型不受支持」（实测）。UI 下拉已下线不支持的组合，
  // 这里再兜一层——旧 localStorage / 直接调 API 也不会硬失败。
  // ⚠️ 平台新增「支持图生图」的模型时，同步加入 VISIONARY_EDIT_MODELS。
  let effectiveModel = model
  if (provider === 'visionary') {
    const resolvedModel = model || config.image.visionary.model
    if (!VISIONARY_EDIT_MODELS.has(resolvedModel)) {
      effectiveModel = 'nano-banana-pro'
      console.warn(`[generateStoryboardImage] Visionary 模型 ${resolvedModel} 不支持参考图，已自动改用 nano-banana-pro`)
    }
  }
  console.log('[generateStoryboardImage] provider=', provider, '| model=', effectiveModel, '| refs.len=', imageList.length, '| prompt=', String(prompt).slice(0, 60))
  if (provider === 'visionary') {
    // 平台文档明确支持 images 参数；不要在代码层硬猜哪些模型支持图生图，
    // 让真实请求走平台，由平台返回真实错误（403/400 等），前端/日志如实转发。
    return visionaryEditImage(imageList, prompt, { ...options, model: effectiveModel })
  }
  // runninghub 只做文生图工作流（imageGenerator），没有参考图槽；带参考图时统一落到 zikl edits 通道。
  // 前端下拉中它的定位是「四宫格通道（文生图）」——四宫格走 /shot-grid 的 shotGridApp 分支，不经过这里。
  // 若在这里出现，说明有人拿它生成资产图/分镜图：日志留痕，便于确认实际走的是哪条通道。
  if (provider === 'runninghub') {
    console.warn('[generateStoryboardImage] runninghub 无参考图槽，本次图生图实际走 zikl 通道（gpt-image-2）')
  }
  return ziklEditImage(imageList, prompt, options)
}
