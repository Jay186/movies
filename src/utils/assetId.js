export function toIdKey(value) {
  return value === null || value === undefined ? '' : String(value)
}

export function sameId(a, b) {
  return toIdKey(a) === toIdKey(b)
}

export function hasId(list, id) {
  return (Array.isArray(list) ? list : []).some((x) => sameId(x, id))
}

export function indexOfId(list, id) {
  return (Array.isArray(list) ? list : []).findIndex((x) => sameId(x, id))
}

export function toIdKeySet(list, pick = (x) => x) {
  const set = new Set()
  for (const item of (Array.isArray(list) ? list : [])) {
    const key = toIdKey(pick(item))
    if (key) set.add(key)
  }
  return set
}

export function makeLocalId() {
  return Date.now() * 1000 + Math.floor(Math.random() * 1000)
}
