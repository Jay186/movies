
import { getLanguagePack, buildLexicon } from './continuityGuard.js'

const DEFAULT_STATE_KEY = 'intact'   
const DEFAULT_STATE_MARKER = '__default__' 
const KEY_SEP = '#'                  


export function getStateAliases(opts = {}) {
  try {
    const L = buildLexicon(opts)
    const raw = L.stateAliases && typeof L.stateAliases === 'object' ? L.stateAliases : {}
    const out = {}
    for (const [key, aliases] of Object.entries(raw)) {
      const k = String(key || '').trim()
      if (!k) continue
      out[k.toLowerCase()] = (Array.isArray(aliases) ? aliases : [aliases])
        .map((a) => String(a || '').trim())
        .filter(Boolean)
    }
    return out
  } catch {
    return {}
  }
}

function slugifyAscii(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

export function normalizeStateKey(label, opts = {}) {
  const raw = String(label || '').trim()
  if (!raw) return ''
  const lower = raw.toLowerCase()
  if (/^[a-z0-9_]+$/.test(lower)) return lower
  const aliases = getStateAliases(opts)
  for (const [key, list] of Object.entries(aliases)) {
    if (list.some((a) => a.toLowerCase() === lower)) return key
  }
  return slugifyAscii(raw)
}


export function resolveState(shotStateEntry, assetStatesList) {
  const empty = {
    stateKey: '', labelZh: '', description: '', descriptionEn: '',
    imageUrl: '', isDefault: true, resolved: false,
  }
  if (!Array.isArray(assetStatesList) || !assetStatesList.length) return empty

  let want = ''
  if (typeof shotStateEntry === 'string') want = shotStateEntry
  else if (shotStateEntry && typeof shotStateEntry === 'object') want = shotStateEntry.state
  want = String(want || '').trim()
  if (!want) return empty

  if (isDefaultStateRequest(shotStateEntry)) {
    const def = assetStatesList.find((r) => Number(r.is_default) === 1)
      || assetStatesList.find((r) => String(r.state_key) === DEFAULT_STATE_KEY)
    return def ? rowToState(def, true) : empty
  }

  const key = want.toLowerCase()
  const hit = assetStatesList.find((r) => String(r.state_key || '').toLowerCase() === key)
  return hit ? rowToState(hit, false) : empty
}

function rowToState(row, isDefault) {
  return {
    stateKey: String(row.state_key || ''),
    labelZh: String(row.label_zh || ''),
    description: String(row.description || ''),
    descriptionEn: String(row.description_en || ''),
    imageUrl: String(row.image_url || ''),
    isDefault: !!isDefault || Number(row.is_default) === 1,
    resolved: true,
  }
}


export function isDefaultStateRequest(entry) {
  const s = typeof entry === 'string' ? entry : (entry && typeof entry === 'object' ? entry.state : '')
  return String(s || '').trim().toLowerCase() === DEFAULT_STATE_MARKER
}


export function buildAnchorKey(assetName, stateKey) {
  const name = String(assetName || '').trim()
  if (!name) return ''
  const key = String(stateKey || '').trim().toLowerCase()
  if (!key || key === DEFAULT_STATE_KEY) return name
  return `${name}${KEY_SEP}${key}`
}

export function stripStateSuffix(anchorKey) {
  const s = String(anchorKey || '')
  const i = s.indexOf(KEY_SEP)
  return (i >= 0 ? s.slice(0, i) : s).trim()
}


export function scanOrphanStates(stateRows, liveAnchorKeys) {
  const rows = Array.isArray(stateRows) ? stateRows : []
  const liveBare = new Set(
    (Array.isArray(liveAnchorKeys) ? liveAnchorKeys : [])
      .map((k) => stripStateSuffix(k))
      .filter(Boolean)
  )
  const orphans = []
  for (const r of rows) {
    const bare = stripStateSuffix(r?.asset_key)
    if (!bare) continue
    if (!liveBare.has(bare)) {
      orphans.push({ assetKey: bare, stateKey: String(r?.state_key || ''), rowId: r?.id })
    }
  }
  return { orphans, checked: rows.length }
}


export function displayLabel(stateKey, labelZh) {
  const zh = String(labelZh || '').trim()
  if (zh) return zh
  const key = String(stateKey || '').trim()
  return key ? `${key}〔未登记〕` : ''
}

export const _defaultStateKey = DEFAULT_STATE_KEY
