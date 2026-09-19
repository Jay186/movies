
const toArray = (x) => (Array.isArray(x) ? x : [])
const normTitle = (s) => String(s == null ? '' : s).trim()
const toPosInt = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

export function remapSceneRefs(oldScenes, newScenes, refRows) {
  const oldById = new Map()
  for (const s of toArray(oldScenes)) {
    const id = toPosInt(s?.id)
    if (id == null) continue
    oldById.set(id, { title: normTitle(s?.title), scene_number: toPosInt(s?.scene_number) })
  }

  const newByTitle = new Map()
  const newByNumber = new Map()
  for (const s of toArray(newScenes)) {
    const id = toPosInt(s?.id)
    if (id == null) continue
    const title = normTitle(s?.title)
    if (title) {
      if (!newByTitle.has(title)) newByTitle.set(title, [])
      newByTitle.get(title).push(id)
    }
    const no = toPosInt(s?.scene_number)
    if (no != null) {
      if (!newByNumber.has(no)) newByNumber.set(no, [])
      newByNumber.get(no).push(id)
    }
  }

  const updates = []
  const unmatched = []
  const skipped = []
  let unchanged = 0

  for (const ref of toArray(refRows)) {
    const refId = ref?.id
    const oldId = toPosInt(ref?.scene_id)
    if (oldId == null || !oldById.has(oldId)) {
      skipped.push({ id: refId, scene_id: ref?.scene_id })
      continue
    }
    const old = oldById.get(oldId)

    let newId = null
    let via = ''
    if (old.title) {
      const hits = newByTitle.get(old.title)
      if (hits && hits.length === 1) { newId = hits[0]; via = 'title' }
    }
    if (newId == null && old.scene_number != null) {
      const hits = newByNumber.get(old.scene_number)
      if (hits && hits.length === 1) { newId = hits[0]; via = 'scene_number' }
    }

    if (newId == null) { unmatched.push({ id: refId, scene_id: oldId }); continue }
    if (newId === oldId) { unchanged++; continue }
    updates.push({ id: refId, from: oldId, to: newId, via })
  }

  return { updates, unmatched, skipped, unchanged }
}
