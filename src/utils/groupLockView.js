
export function countLocksByGroup(locks) {
  const map = {}
  for (const l of Array.isArray(locks) ? locks : []) {
    const g = String(l?.group || '').trim()
    if (!g) continue
    map[g] = (map[g] || 0) + 1
  }
  return map
}

export function isSceneLocked(sceneId, locks) {
  const id = String(sceneId)
  return (Array.isArray(locks) ? locks : []).some((l) => String(l?.sceneId) === id)
}

export function isGroupLocked(group, locks) {
  const members = group?.memberScenes || []
  if (!members.length) return false
  return members.every((m) => isSceneLocked(m.id, locks))
}

export function matchOrphanAnchor(group, overview) {
  const anchored = (overview?.orphanAnchors || []).filter((a) => a && String(a.group || '').trim())
  if (!anchored.length) return null

  const name = String(group?.group || '').trim()

  const direct = anchored.find((a) => String(a.group).trim() === name)
  if (direct) return direct

  if (anchored.some((a) => String(a.group).trim() === name)) return null

  const memberIds = new Set((group?.memberScenes || []).map((m) => String(m.id)))
  if (!memberIds.size) return null

  const locks = Array.isArray(overview?.locks) ? overview.locks : []

  for (const a of anchored) {
    const key = String(a.group).trim()
    const ids = locks.filter((l) => String(l?.group || '').trim() === key).map((l) => String(l?.sceneId))
    if (!ids.length) continue   
    if (!ids.every((id) => memberIds.has(id))) continue
    return a
  }
  return null
}

export function countOrphanAnchors(overview) {
  const names = new Set(
    (overview?.orphanAnchors || []).map((a) => String(a?.group || '').trim()).filter(Boolean),
  )
  return names.size
}
