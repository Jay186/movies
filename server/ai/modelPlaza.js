// 启明星「模型广场」只读拉取：供设置抽屉「从网站拉取模型列表」选文本 / 生图 model_id 用。
// 端点免鉴权（credentials: omit），只读失败不影响手动填写。
//
// 关键约定：
// 1) 文本 / 生图判别只认 pricing.billing_mode，经 BILLING_MODE_TO_KIND 映射成 kind；
//    表里没有的 billing_mode 一律丢弃（不猜、不返回）。平台新增计费方式时只改这张表。
// 2) 同一模型名会出现在多个分组、且各分组价格不同 → 按 name + kind 去重，
//    保留 priceScore 最小的分组为主分组，并保留全部来源分组供 UI 显示「共 N 个分组」。
// 3) pricing 单价单位无法从响应确认，因此不生成任何格式化价格串；
//    展示以分组级 rate_multiplier 为准，原始 pricing 原样放进 raw_pricing 备用。

import { config } from '../config.js'

// billing_mode → kind 映射表（数据驱动，唯一判别依据）。
const BILLING_MODE_TO_KIND = {
  token: 'text',
  image: 'image',
}

// 分组/模型的判优数值：越小越优。
// 优先取区间首档按次价，其次 input_price + output_price，都拿不到 → Infinity（排最后）。
function priceScore(pricing) {
  const perRequest = Number(pricing?.intervals?.[0]?.per_request_price)
  if (Number.isFinite(perRequest)) return perRequest

  const input = Number(pricing?.input_price)
  const output = Number(pricing?.output_price)
  const hasInput = Number.isFinite(input)
  const hasOutput = Number.isFinite(output)
  if (hasInput || hasOutput) return (hasInput ? input : 0) + (hasOutput ? output : 0)

  return Infinity
}

// 把 data.groups 展平成「每个分组内每个模型一条」，未知 billing_mode 直接丢弃。
function flattenModels(groups) {
  const flat = []
  for (const group of groups) {
    if (!group || !Array.isArray(group.models)) continue
    for (const model of group.models) {
      if (!model || !model.name) continue
      const pricing = model.pricing || {}
      const kind = BILLING_MODE_TO_KIND[pricing.billing_mode]
      if (!kind) continue
      flat.push({
        name: String(model.name),
        kind,
        platform: model.platform ?? group.platform ?? null,
        pricing,
        group: {
          name: group.name ?? null,
          rate_multiplier: group.rate_multiplier ?? null,
          price_score: priceScore(pricing),
        },
      })
    }
  }
  return flat
}

function cmpScore(a, b) {
  if (a === b) return 0
  if (a === Infinity) return 1
  if (b === Infinity) return -1
  return a - b
}

const cmpStr = (a, b) => String(a ?? '').localeCompare(String(b ?? ''))

// 按 name + kind 去重：主分组取 price_score 最小者（并列按分组名升序），保留全部来源分组。
function buildOptions(flat, kind) {
  const byKey = new Map()
  for (const item of flat) {
    if (item.kind !== kind) continue
    const key = `${item.name}\u0000${item.kind}`
    let entry = byKey.get(key)
    if (!entry) {
      entry = { name: item.name, kind: item.kind, platform: item.platform, groups: [] }
      byKey.set(key, entry)
    }
    if (entry.platform == null && item.platform != null) entry.platform = item.platform
    entry.groups.push(item.group)
  }

  const options = []
  for (const entry of byKey.values()) {
    entry.groups.sort((a, b) => cmpScore(a.price_score, b.price_score) || cmpStr(a.name, b.name))
    const best = entry.groups[0]
    options.push({
      name: entry.name,
      kind: entry.kind,
      platform: entry.platform,
      group_name: best.name,
      rate_multiplier: best.rate_multiplier,
      price_score: best.price_score,
      groups: entry.groups,
    })
  }
  options.sort((a, b) => cmpScore(a.price_score, b.price_score) || cmpStr(a.name, b.name))
  return options
}

// 每个 name + kind 的原始 pricing（取最优分组的）
function indexRawPricing(flat) {
  const best = new Map()
  for (const item of flat) {
    const key = `${item.name}\u0000${item.kind}`
    const prev = best.get(key)
    if (!prev || cmpScore(item.group.price_score, prev.score) < 0) {
      best.set(key, { pricing: item.pricing, score: item.group.price_score })
    }
  }
  const out = new Map()
  for (const [key, v] of best) out.set(key, v.pricing)
  return out
}

let cache = null // { fetchedAt, models }

function fail(message, cause) {
  const err = new Error(message)
  err.status = 502
  if (cause) err.cause = cause
  return err
}

// 拉取原始分组；任何失败都抛带 status=502 的错误（路由层据此映射）。
async function requestPlaza() {
  const url = config.qmx.plazaUrl
  const timeoutMs = config.qmx.plazaTimeoutMs
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      signal: controller.signal,
    })
  } catch (e) {
    throw fail(
      e?.name === 'AbortError'
        ? `请求模型广场超时（${timeoutMs}ms）：${url}`
        : `请求模型广场失败（${url}）：${e?.message || '网络错误'}`,
      e,
    )
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) throw fail(`模型广场返回 HTTP ${res.status}：${url}`)

  let json
  try {
    json = await res.json()
  } catch (e) {
    throw fail(`模型广场响应不是合法 JSON：${url}`, e)
  }

  if (json?.code !== 0) throw fail(`模型广场业务错误 code=${json?.code}：${json?.message || ''}`)

  const groups = json?.data?.groups
  if (!Array.isArray(groups)) throw fail('模型广场响应缺少 data.groups 数组')

  return groups
}

/**
 * 拉取并规范化启明星模型广场。
 * @param {{ refresh?: boolean }} [opts] refresh=true 绕过缓存强制回源
 * @returns {Promise<{ok: boolean, source: string, fetchedAt: number, cached: boolean, models: {text: Array, image: Array}}>}
 */
export async function fetchModelPlaza({ refresh = false } = {}) {
  const ttl = config.qmx.plazaCacheTtlMs
  if (!refresh && cache && Date.now() - cache.fetchedAt < ttl) {
    console.log('[model-plaza] 命中缓存 fetchedAt=%d', cache.fetchedAt)
    return { ok: true, source: 'qimingxing', fetchedAt: cache.fetchedAt, cached: true, models: cache.models }
  }

  const groups = await requestPlaza()
  const flat = flattenModels(groups)
  const rawByName = indexRawPricing(flat)
  const models = {
    text: buildOptions(flat, 'text').map((o) => ({ ...o, raw_pricing: rawByName.get(`${o.name}\u0000text`) || {} })),
    image: buildOptions(flat, 'image').map((o) => ({ ...o, raw_pricing: rawByName.get(`${o.name}\u0000image`) || {} })),
  }

  const fetchedAt = Date.now()
  cache = { fetchedAt, models }
  console.log(
    '[model-plaza] 拉取成功 groups=%d text=%d image=%d',
    groups.length,
    models.text.length,
    models.image.length,
  )
  return { ok: true, source: 'qimingxing', fetchedAt, cached: false, models }
}
