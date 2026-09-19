// 创作主题 → 定位到资产里的角色。
//
// 数据源是 ip_characters（角色名 + 形象描述 + 参考图 + 音色），这是平台里
// 本来就有的资产，加角色即可用，零配置。
// ips 表（世界观 / 画风 / 禁忌）是可选的补充层：填了就一并带上，没填不影响定位。
//
// 召回分两层：
//   1. 名字快通道 —— 角色名在主题里出现，直接命中，免费且确定
//   2. 模型判断   —— 把角色清单交给模型，由它按名字和形象特征认人
//
// 分档原则：宁可返回 none，也不把不相关的角色塞进来。
// 误绑会让整集的形象和音色串味，代价远高于漏绑。

import { query, queryOne } from '../db.js'
import { chatCompletion } from './doubao.js'
import { config } from '../config.js'

// 打分参数来自 config.js，支持环境变量覆盖。
// 这里刻意不出现任何具体角色或 IP 的名字 —— 资产是数据库里的数据，不是代码里的常量。
const R = config.ipRouter || {}
const HIGH_CONFIDENCE_SCORE = R.highConfidenceScore ?? 4
const SCORE_CHARACTER = R.scoreCharacter ?? 2
const SCORE_ALIAS = R.scoreAlias ?? 1
const SCORE_MULTI_CHARACTER = R.scoreMultiCharacter ?? 2
const SCORE_IP_NAME = R.scoreIpName ?? 3
const SCORE_BOUND_IP = R.scoreBoundIp ?? 2

function parseAliasField(raw) {
  return String(raw || '')
    .split(/[,，;；\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

// escapeRegExp 已统一到 shared.js（原此处与 doubao.js 各有一份实现）
import { escapeRegExp } from './shared.js'

// 纯 ASCII 别名走正则词边界，避免 "bubu" 命中 "bubble"；
// 中文没有词边界，只能子串匹配。短名误伤（"一二" 落在 "一二三四五" 里）
// 不在这里硬防，靠打分层的"多角色加成"抵消：孤立的短名只值 2 分，
// 够不到高置信线，会进模型二次确认。
function matchWithBoundary(text, alias) {
  const t = String(text || '').toLowerCase()
  const a = String(alias || '').toLowerCase().trim()
  if (!a) return false
  if (/^[\x20-\x7e]+$/.test(a)) {
    return new RegExp(`(^|[^a-z0-9])${escapeRegExp(a)}([^a-z0-9]|$)`, 'i').test(t)
  }
  return t.includes(a)
}

function extractJsonObject(raw) {
  const text = String(raw || '').trim()
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced ? fenced[1] : text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型未返回 JSON 对象')
  return JSON.parse(body.slice(start, end + 1))
}

/**
 * 读取角色资产。项目内已用过的角色会被标记，打分时给加成。
 */
function loadCharacterAssets(projectId) {
  const chars = query('SELECT * FROM ip_characters ORDER BY id')
  if (!projectId) return chars.map((c) => ({ ...c, inProject: false }))
  const ids = new Set(
    query('SELECT ip_character_id AS id FROM project_characters WHERE project_id = ? AND ip_character_id IS NOT NULL', [
      projectId,
    ]).map((r) => r.id),
  )
  return chars.map((c) => ({ ...c, inProject: ids.has(c.id) }))
}

/**
 * 名字快通道：扫角色名（及可选别名），按所属 IP 聚合成候选组。
 * 没有 IP 归属的角色自成一组 —— 定位不依赖 IP 卡是否存在。
 */
function scoreByAlias(text, chars) {
  const groups = new Map()

  const ensureGroup = (key, ipId) => {
    if (!groups.has(key)) groups.set(key, { ipId, characterIds: [], score: 0, hits: [] })
    return groups.get(key)
  }

  for (const c of chars) {
    for (const alias of [c.name, ...parseAliasField(c.aliases)]) {
      if (!matchWithBoundary(text, alias)) continue
      const key = c.ip_id ? `ip:${c.ip_id}` : `char:${c.id}`
      const g = ensureGroup(key, c.ip_id ?? null)
      g.characterIds.push(c.id)
      g.score += alias === c.name ? SCORE_CHARACTER : SCORE_ALIAS
      g.score += c.inProject ? SCORE_BOUND_IP : 0
      g.hits.push({ value: alias, characterId: c.id })
      break
    }
  }

  // 一句话点到多个角色，基本不可能是巧合
  for (const g of groups.values()) {
    if (g.hits.length >= 2) g.score += SCORE_MULTI_CHARACTER
  }

  // IP 名命中时，即便没点到具体角色，也把该 IP 的主要角色整体拉进来
  for (const ip of query('SELECT id, name, aliases FROM ips')) {
    for (const alias of [ip.name, ...parseAliasField(ip.aliases)]) {
      if (!matchWithBoundary(text, alias)) continue
      const key = `ip:${ip.id}`
      let g = groups.get(key)
      if (!g) {
        g = ensureGroup(key, ip.id)
        const members = chars.filter((c) => c.ip_id === ip.id)
        g.characterIds.push(...members.map((c) => c.id))
      }
      g.score += SCORE_IP_NAME
      g.hits.push({ value: alias })
      break
    }
  }

  return [...groups.values()].sort((a, b) => b.score - a.score)
}

function toCharacterAssets(ids) {
  if (!ids.length) return []
  const marks = ids.map(() => '?').join(', ')
  return query(`SELECT * FROM ip_characters WHERE id IN (${marks})`, ids).map((c) => ({
    id: c.id,
    name: c.name,
    role: c.role || '角色',
    description: c.description || '',
    appearance: c.appearance || '',
    imageUrl: c.image_url || '',
    audioUrl: c.audio_url || '',
    ipId: c.ip_id ?? null,
  }))
}

function attachIp(groupId) {
  if (!groupId) return null
  const ip = queryOne('SELECT * FROM ips WHERE id = ?', [groupId])
  if (!ip) return null
  return {
    id: ip.id,
    name: ip.name,
    worldview: ip.worldview || '',
    artStyle: ip.art_style || '',
    palette: ip.palette || '',
    voiceBind: ip.voice_bind || '',
    relations: ip.relations || '',
    forbidden: ip.forbidden || '',
  }
}

/**
 * 模型定位：把角色清单交给模型，由它按名字和形象特征判断出场角色。
 * 模型不可用时静默降级到名字层结果，不抛错。
 */
async function locateByLlm(text, chars, scored) {
  // 没有形象描述的角色对模型没有判断依据，跳过以免污染清单
  const catalog = chars
    .map((c) => {
      const lines = [`ID ${c.id}｜${c.name}`]
      const traits = [c.description, c.appearance].filter(Boolean).join('；')
      if (traits) lines.push(`特征：${traits}`)
      if (c.ip_id) {
        const ip = queryOne('SELECT name FROM ips WHERE id = ?', [c.ip_id])
        if (ip) lines.push(`所属 IP：${ip.name}`)
      }
      return lines.join('\n')
    })
    .join('\n\n')

  const system = `你是短剧资产库的检索助手。下面是资产库里的角色清单。请判断用户的创作主题里，哪些角色会出场。

只输出一个 JSON 对象，不要任何解释：
{"characterIds": [<角色ID...>], "confidence": "high"|"low"|"none", "reason": "<一句话说明理由>"}

判定规则，按顺序执行：
1. 主题里出现角色名，或描述的形象与某角色的外貌特征吻合 → 加入 characterIds
2. 主题与清单里所有角色都对不上（一个全新的故事）→ characterIds 为 []，confidence 为 "none"
3. 提到了名字但有歧义（常见词、数字序列的一部分、同名不同人）→ "low"

铁律一：只认名字或形象对得上的。不要因为题材、画风相似就往上凑。
铁律二：宁可返回空数组，也不要硬塞角色。塞错角色会让整集形象和音色串味，代价远高于漏掉。`

  try {
    const raw = await chatCompletion(
      [
        { role: 'system', content: system },
        { role: 'user', content: `角色资产库：\n\n${catalog}\n\n创作主题：${text}` },
      ],
      { temperature: 0.1, maxTokens: 500, responseFormat: { type: 'json_object' }, timeoutMs: 30000 },
    )

    const parsed = extractJsonObject(raw)
    let ids = Array.isArray(parsed.characterIds) ? parsed.characterIds.map(Number).filter((n) => Number.isFinite(n)) : []
    // 模型可能返回库里不存在的 ID，过滤掉，避免下游拿到空资产
    const valid = new Set(chars.map((c) => c.id))
    ids = ids.filter((id) => valid.has(id))

    let confidence = ['high', 'low', 'none'].includes(parsed.confidence) ? parsed.confidence : 'low'
    let reason = parsed.reason || '模型语义判定'

    // 程序防线：模型会因"题材像"而自信，但主题里一个字面证据都没有时，
    // 它的 high 不作数 —— 降为 low，让前端弹候选问用户，绝不静默绑定。
    if (confidence === 'high' && !scored.length) {
      confidence = 'low'
      reason = `${reason}（主题未出现任何角色名，已降级待确认）`
    }

    if (!ids.length) {
      return { confidence: 'none', characters: [], ip: null, matched: [], reason, via: 'llm' }
    }

    const assets = toCharacterAssets(ids)
    // 角色同属一个 IP 时顺带把 IP 的补充设定捞出来
    const ipIds = [...new Set(assets.map((c) => c.ipId).filter(Boolean))]

    return {
      confidence,
      characters: assets,
      ip: ipIds.length === 1 ? attachIp(ipIds[0]) : null,
      matched: scored.map((g) => ({
        score: g.score,
        characterIds: g.characterIds,
        ipId: g.ipId,
        ip: attachIp(g.ipId)?.name ?? null,
      })),
      reason,
      via: 'llm',
    }
  } catch (e) {
    const group = scored[0]
    const assets = group ? toCharacterAssets(group.characterIds) : []
    return {
      confidence: group ? 'low' : 'none',
      characters: assets,
      ip: group ? attachIp(group.ipId) : null,
      matched: scored.map((g) => ({ score: g.score, characterIds: g.characterIds, ipId: g.ipId })),
      reason: `模型不可用（${e.message}），已降级为名字匹配`,
      via: 'alias-fallback',
    }
  }
}

/**
 * 显式指定角色 ID 时的解析入口（前端用户确认过候选后回传）。
 * 返回与 routeIp 一致的 { characters, ip } 结构，角色同属一个 IP 时顺带带出 IP 卡。
 */
export function resolveExplicitCharacters(characterIds) {
  const ids = (Array.isArray(characterIds) ? characterIds : [])
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0)
  const characters = toCharacterAssets(ids)
  if (!characters.length) return { characters: [], ip: null }
  const ipIds = [...new Set(characters.map((c) => c.ipId).filter(Boolean))]
  return { characters, ip: ipIds.length === 1 ? attachIp(ipIds[0]) : null }
}

/**
 * 把创作主题定位到资产里的角色。
 *
 * @param {string} text 创作主题，如"一二和布布去逛街"
 * @param {Object} options
 * @param {number} [options.projectId] 当前项目 ID；该项目用过的角色会有打分加成
 * @param {boolean} [options.useLlm] 是否启用模型判断，默认取 config.ipRouter.enableLlm
 * @returns {Promise<{confidence: string, characters: Array, ip: Object|null, matched: Array, reason: string, via: string}>}
 */
export async function routeIp(text, { projectId = null, useLlm = R.enableLlm !== false } = {}) {
  const q = String(text || '').trim()
  if (!q) {
    return { confidence: 'none', characters: [], ip: null, matched: [], reason: '输入为空', via: 'alias' }
  }

  const chars = loadCharacterAssets(projectId)
  if (!chars.length) {
    return { confidence: 'none', characters: [], ip: null, matched: [], reason: '角色资产库为空', via: 'alias' }
  }

  const scored = scoreByAlias(q, chars)
  const top = scored[0]

  if (top && top.score >= HIGH_CONFIDENCE_SCORE) {
    return {
      confidence: 'high',
      characters: toCharacterAssets(top.characterIds),
      ip: attachIp(top.ipId),
      matched: scored.map((g) => ({
        score: g.score,
        characterIds: g.characterIds,
        ipId: g.ipId,
        ip: attachIp(g.ipId)?.name ?? null,
      })),
      reason: `命中 ${top.hits.map((h) => h.value).join('、')}`,
      via: 'alias',
    }
  }

  if (!useLlm) {
    const group = top ?? null
    return {
      confidence: group ? 'low' : 'none',
      characters: group ? toCharacterAssets(group.characterIds) : [],
      ip: group ? attachIp(group.ipId) : null,
      matched: scored.map((g) => ({ score: g.score, characterIds: g.characterIds, ipId: g.ipId })),
      reason: group ? '仅弱名字命中，未启用模型确认' : '无名字命中，未启用模型',
      via: 'alias',
    }
  }

  return await locateByLlm(q, chars, scored)
}

/**
 * 把定位到的角色资产组装成可直接塞进编剧 prompt 的文本块。
 * IP 卡（世界观 / 画风 / 禁忌）有就带上，没有就只给角色 —— 不填 IP 也能用。
 *
 * @param {Array} characters routeIp 返回的 characters
 * @param {Object|null} ip routeIp 返回的 ip
 * @returns {string}
 */
export function buildCharacterContext(characters, ip = null) {
  const list = Array.isArray(characters) ? characters.filter(Boolean) : []
  if (!list.length && !ip) return ''

  const lines = []

  if (ip) {
    lines.push(`【IP：${ip.name}】`)
    const fields = [
      ['世界观 / 调性', ip.worldview],
      ['画风', ip.artStyle],
      ['主配色', ip.palette],
      ['人物关系', ip.relations],
      ['音色绑定', ip.voiceBind],
    ]
    for (const [label, value] of fields) {
      if (value) lines.push(`${label}：${value}`)
    }
  }

  if (list.length) {
    lines.push(ip ? '出场角色（必须严格沿用下列形象设定，不得改动外貌）：' : '出场角色：')
    for (const c of list) {
      const head = `- ${c.name}（${c.role}）`
      const body = [c.description, c.appearance ? `外貌：${c.appearance}` : ''].filter(Boolean).join('；')
      lines.push(body ? `${head}：${body}` : head)
    }
  }

  if (ip?.forbidden) lines.push(`禁忌，必须遵守：${ip.forbidden}`)

  return lines.join('\n')
}
