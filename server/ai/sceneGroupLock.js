
export function loadGroupLocks(episodeId, db) {
  const out = new Map()
  try {
    const rows = db.query(
      'SELECT scene_id, spatial_group FROM scene_group_locks WHERE episode_id = ?',
      [episodeId]
    )
    for (const r of rows || []) {
      const sid = Number(r.scene_id)
      const g = String(r.spatial_group || '').trim()
      if (Number.isFinite(sid) && sid > 0 && g) out.set(sid, g)
    }
  } catch (e) {
    console.warn('[groupLock] 读取分组锁失败，按无锁处理:', e.message)
  }
  return out
}

export function applyGroupLocks(rows, locks) {
  const list = Array.isArray(rows) ? rows : []
  if (!(locks instanceof Map) || locks.size === 0) {
    return { rows: list, lockedCount: 0, changedCount: 0 }
  }
  let lockedCount = 0
  let changedCount = 0
  const next = list.map((r) => {
    const sid = Number(r?.scene_id)
    const locked = locks.get(sid)
    if (!locked) return r
    lockedCount++
    const llmGroup = String(r?.spatial_group || '').trim()
    if (llmGroup !== locked) changedCount++
    return { ...r, spatial_group: locked }
  })
  return { rows: next, lockedCount, changedCount }
}



export function getGroupLockOverview(episodeId, db) {
  let locks = []
  try {
    locks = db.query(
      `SELECT l.scene_id, l.spatial_group, l.note, s.scene_number
       FROM scene_group_locks l
       LEFT JOIN scenes s ON s.id = l.scene_id
       WHERE l.episode_id = ?
       ORDER BY s.scene_number ASC`,
      [episodeId]
    ) || []
  } catch (e) {
    console.warn('[groupLock] 读取锁定概览失败:', e.message)
  }

  let orphanAnchors = []
  try {
    const live = new Set(
      (db.query(
        "SELECT DISTINCT spatial_group FROM scene_analysis WHERE episode_id = ? AND TRIM(spatial_group) != ''",
        [episodeId]
      ) || []).map((r) => String(r.spatial_group || '').trim()).filter(Boolean)
    )
    const anchors = db.query(
      `SELECT anchor_key, image_url, confirmed FROM scene_anchors
       WHERE episode_id = ? AND anchor_type = 'spatial'`,
      [episodeId]
    ) || []
    orphanAnchors = anchors
      .filter((a) => !live.has(String(a.anchor_key || '').trim()))
      .map((a) => ({
        group: String(a.anchor_key || ''),
        image: String(a.image_url || ''),
        confirmed: Number(a.confirmed || 0) === 1,
      }))
  } catch (e) {
    console.warn('[groupLock] 检测孤儿锚失败:', e.message)
  }

  return {
    locks: (locks || []).map((r) => ({
      sceneId: Number(r.scene_id),
      sceneNumber: Number(r.scene_number || 0),
      group: String(r.spatial_group || ''),
      note: String(r.note || ''),
    })),
    orphanAnchors,
  }
}
