
import { stripStateSuffix } from './assetState.js'

const FULLWIDTH_SPACE = /\u3000/g
const EDGE_NOISE = /^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu

export function normalizePropName(s) {
  let t = String(s == null ? '' : s).replace(FULLWIDTH_SPACE, ' ')
  t = t.replace(EDGE_NOISE, '')
  return t.trim()
}

export function resolvePropName(raw, propNames) {
  const names = (Array.isArray(propNames) ? propNames : [])
    .filter((n) => n != null && String(n).trim() !== '')
  const target = normalizePropName(raw)
  if (!target || !names.length) return null

  const exact = names.filter((n) => normalizePropName(n) === target)
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) return null

  const targetBare = stripStateSuffix(target)
  if (targetBare) {
    const bareHits = names.filter((n) => {
      const nb = stripStateSuffix(normalizePropName(n))
      return nb !== '' && nb === targetBare
    })
    if (bareHits.length === 1) return bareHits[0]
    if (bareHits.length > 1) return null
  }

  return pickContainmentCandidate(target, names, { minRawLen: 2 })
}

export function pickContainmentCandidate(raw, candidates, opts = {}) {
  const normalize = typeof opts.normalize === 'function' ? opts.normalize : normalizePropName
  const minRawLen = Number.isFinite(opts.minRawLen) ? Math.max(1, opts.minRawLen) : 1
  const target = normalize(raw)
  if (!target || target.length < minRawLen) return null

  const list = Array.isArray(candidates) ? candidates : []
  const seen = new Set()
  const hits = []
  for (const c of list) {
    if (c == null) continue
    const key = String(c)
    if (!key || seen.has(key)) continue
    const cn = normalize(key)
    if (!cn) continue
    if (cn.includes(target) || target.includes(cn)) { seen.add(key); hits.push(key) }
  }

  if (hits.length === 0) return null
  if (hits.length === 1) return hits[0]

  let minLen = Infinity
  for (const h of hits) minLen = Math.min(minLen, normalize(h).length)
  const shortest = hits.filter((h) => normalize(h).length === minLen)
  return shortest.length === 1 ? shortest[0] : null
}

export function buildPropLexiconHint(propNames) {
  const names = []
  for (const n of Array.isArray(propNames) ? propNames : []) {
    const s = String(n == null ? '' : n).trim()
    if (s && !names.includes(s)) names.push(s)
  }
  if (!names.length) return ''
  return '   【本集已有道具清单】（已由剧本提取确认，用于跨环节统一命名）：\n' +
    `   ${names.join('、')}\n` +
    '   若某场景出现的有形物体与清单中某一项**是同一物体**，其 props 名称必须**逐字使用清单中的写法**，\n' +
    '   不得另起别名；清单中没有的物体仍按你的判断命名，并正常参与 shared_props 判定。\n'
}

