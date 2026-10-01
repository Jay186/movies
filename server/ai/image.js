import { ziklGenerateImage, ziklEditImage } from './ziklImage.js'
import { getImageEntry, getDefaultImageEntry, getEffectiveImageAccount } from '../modelConfig.js'

// 生图通道唯一走「AI 模型配置」的图片条目（OpenAI 兼容聚合网关）。
// 运行期不再回退 .env：无可用条目或通道未配真实 Key → 抛可读 400，由路由层映射给前端。
const QMX_PROVIDER = 'qimingxing'

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 })
}

function normalizeEntryId(v) {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim())
  return null
}

// 入参为 ai_model_entries.id（前端下发的生图条目 id）→ 按条目解析；
// 旧渠道字符串（非数字条目 id）或找不到条目 / 条目已停用 → 回落默认生图条目；
// 无可用条目或通道未配 Key → 明确报错，绝不静默套用 .env。
export function resolveProvider(options = {}) {
  const id = normalizeEntryId(options.provider) ?? normalizeEntryId(options.model)
  const picked = id != null ? getImageEntry(id) : null
  const entry = picked && picked.enabled ? picked : getDefaultImageEntry()
  if (!entry) {
    throw badRequest('生图模型未配置：请在「AI 模型配置」的「生图通道」里添加并启用至少一个生图模型')
  }
  const account = getEffectiveImageAccount()
  if (!account.configured) {
    throw badRequest('生图通道未配置：请在「AI 模型配置」里为「生图通道」填写 API Key')
  }
  return {
    provider: QMX_PROVIDER,
    model: entry.model_id,
    entry,
    baseURL: account.baseURL,
    apiKey: account.apiKey,
  }
}

export async function generateImage(prompt, options = {}) {
  const resolved = resolveProvider(options)
  console.log('[generateImage] provider=', resolved.provider, '| model=', resolved.model, '| options.provider=', options.provider, '| prompt=', String(prompt).slice(0, 60))
  return ziklGenerateImage(prompt, {
    ...options,
    baseURL: resolved.baseURL,
    apiKey: resolved.apiKey,
    model: resolved.model,
  })
}

export async function generateStoryboardImage(prompt, imageList = [], options = {}) {
  const resolved = resolveProvider(options)
  console.log('[generateStoryboardImage] provider=', resolved.provider, '| model=', resolved.model, '| refs.len=', imageList.length, '| prompt=', String(prompt).slice(0, 60))
  return ziklEditImage(imageList, prompt, {
    ...options,
    baseURL: resolved.baseURL,
    apiKey: resolved.apiKey,
    model: resolved.model,
  })
}
