
export function buildSceneGroupChains(targets, groupInfo) {
  const list = Array.isArray(targets) ? targets.slice() : []

  if (!groupInfo || !Object.keys(groupInfo).length) return list.length ? [list] : []

  const buckets = new Map() 
  const solo = [] 
  list.forEach((t, idx) => {
    const g = String(groupInfo[String(t.id)]?.group || groupInfo[t.id]?.group || '').trim()
    if (!g) {
      solo.push({ scene: t, idx })
      return
    }
    if (!buckets.has(g)) buckets.set(g, { scenes: [], firstIndex: idx })
    buckets.get(g).scenes.push({
      scene: t,
      order: Number(groupInfo[String(t.id)]?.sceneNumber || groupInfo[t.id]?.sceneNumber || 0) || idx + 1,
      idx,
    })
  })

  for (const b of buckets.values()) {
    b.scenes.sort((a, z) => (a.order - z.order) || (a.idx - z.idx))
  }

  const chains = [...buckets.values()]
    .sort((a, z) => a.firstIndex - z.firstIndex)
    .map((b) => b.scenes.map((x) => x.scene))
  for (const s of solo) chains.push([s.scene])
  return chains
}
