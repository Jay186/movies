import { config } from '../config.js'
import { runWorkflow } from './runninghub.js'
import { ziklGenerateImage, ziklEditImage } from './ziklImage.js'
import { visionaryGenerateImage, visionaryEditImage } from './visionaryImage.js'

const VISIONARY_MODELS = new Set([
  'gpt-image-2',
  'nano-banana-pro',
  'Nano_Banana_Pro',
  'nano-banana-pro-cl',
  'nano-banana-2-lite',
])
const VISIONARY_EDIT_MODELS = new Set([
  'nano-banana-pro',
  'Nano_Banana_Pro',
  'nano-banana-pro-cl',
  'nano-banana-2-lite',
])

const VISIONARY_RETIRED_MODELS = new Map([
  ['gpt-image-2', 'nano-banana-pro'],
])

export function resolutionForModel(model) {
  const effective = model || config.image.visionary.model
  return effective === 'gpt-image-2' ? '1K' : config.image.visionary.resolution
}

export function resolveProvider(options = {}) {
  let provider = options.provider || config.image.provider
  let model = options.model

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
  if (provider !== 'visionary' && VISIONARY_MODELS.has(model)) {
    provider = 'visionary'
  }
  if (provider === 'visionary' && VISIONARY_RETIRED_MODELS.has(model)) {
    const fallback = VISIONARY_RETIRED_MODELS.get(model)
    console.warn(`[resolveProvider] visionary 模型 ${model} 平台已不受支持（实测 400），自动改用 ${fallback}`)
    model = fallback
  }
  return { provider, model }
}

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

export async function generateStoryboardImage(prompt, imageList = [], options = {}) {
  const { provider, model } = resolveProvider(options)
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
    return visionaryEditImage(imageList, prompt, { ...options, model: effectiveModel })
  }
  if (provider === 'runninghub') {
    console.warn('[generateStoryboardImage] runninghub 无参考图槽，本次图生图实际走 zikl 通道（gpt-image-2）')
  }
  return ziklEditImage(imageList, prompt, options)
}
