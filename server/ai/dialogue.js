
export function parseDialogue(raw) {
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === 'object') return [raw]

  const s = String(raw ?? '').trim()
  if (!s) return []

  let p
  try {
    p = JSON.parse(s)
  } catch {
    return []
  }
  if (Array.isArray(p)) return p
  if (p && typeof p === 'object') return Object.keys(p).length ? [p] : []
  return []
}

const TEXT_KEYS = ['text', 'line', 'content']

export function hasDialogue(raw) {
  return parseDialogue(raw).some((d) =>
    TEXT_KEYS.some((k) => String(d?.[k] ?? '').trim() !== '')
  )
}

export function serializeDialogue(v) {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v)
    } catch {
      return ''
    }
  }
  return ''
}
