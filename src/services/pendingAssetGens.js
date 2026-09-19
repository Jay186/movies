export function reconcilePendingAssetGens({ pending = [], episodeId = '', runningAssetIds = null } = {}) {
  const epId = String(episodeId)
  const mine = (Array.isArray(pending) ? pending : []).filter((t) => String(t.episodeId) === epId)

  const zombies = []
  const toRestore = []
  for (const t of mine) {
    if (runningAssetIds && !runningAssetIds.has(String(t.id))) {
      zombies.push(String(t.id))
    } else {
      toRestore.push(t.id)
    }
  }

  const zombieSet = new Set(zombies)
  const kept = runningAssetIds
    ? (Array.isArray(pending) ? pending : []).filter((t) => !zombieSet.has(String(t.id)))
    : (Array.isArray(pending) ? pending : []).slice()

  return { zombies, toRestore, kept }
}
