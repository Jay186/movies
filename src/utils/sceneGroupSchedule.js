
// targets：待出图场景；groupInfo：场景ID → { group, sceneNumber }；
// options.parallel === true 时组内不编链——每个目标独立成单链，
// 由批量层的 worker 池按 concurrency 统一并发（同组也并行）。
// 默认（parallel 不开）：同组编一条链严格串行，保证锚点生效时序。
export function buildSceneGroupChains(targets, groupInfo, options = {}) {
  const list = Array.isArray(targets) ? targets.slice() : []

  if (!list.length) return []

  if (options.parallel) return list.map((t) => [t])

  if (!groupInfo || !Object.keys(groupInfo).length) return [list]

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
