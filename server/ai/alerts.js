
import { execute, query, queryOne } from '../db.js'

export function recordAlert(a = {}) {
  try {
    const detail = a.detail == null
      ? ''
      : String(a.detail?.stack || a.detail?.message || a.detail)
    const source = String(a.source || 'unknown')
    const episodeId = a.episodeId ?? null
    const message = String(a.message || '').slice(0, 500)

    try {
      const dup = queryOne(
        `SELECT id FROM system_alerts
         WHERE source = ? AND message = ?
           AND IFNULL(episode_id, -1) = IFNULL(?, -1)
           AND (resolved_at IS NULL OR resolved_at = '')
         ORDER BY id DESC LIMIT 1`,
        [source, message, episodeId]
      )
      if (dup) return Number(dup.id) || null
    } catch {  }

    const r = execute(
      `INSERT INTO system_alerts (level, source, episode_id, shot_id, shot_number, scene_id, scene_number, message, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        a.level === 'info' ? 'info' : (a.level === 'warn' ? 'warn' : 'error'),
        source,
        episodeId,
        a.shotId ?? null,
        String(a.shotNumber || ''),
        a.sceneId ?? null,
        String(a.sceneNumber || ''),
        message,
        detail.slice(0, 2000),
      ]
    )
    return Number(r.lastInsertRowid) || null
  } catch (e) {
    console.warn('[alerts] 记告警失败（已忽略）:', e.message)
    return null
  }
}

export function listAlerts(opts = {}) {
  try {
    const where = []
    const params = []
    if (!opts.includeResolved) where.push("(resolved_at IS NULL OR resolved_at = '')")
    if (opts.episodeId != null) { where.push('episode_id = ?'); params.push(Number(opts.episodeId)) }
    const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.min(500, opts.limit)) : 200
    const sql = `SELECT * FROM system_alerts
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY id DESC LIMIT ${limit}`
    return query(sql, params)
  } catch (e) {
    console.warn('[alerts] 查询告警失败（返回空）:', e.message)
    return []
  }
}

export function countUnresolved(episodeId = null) {
  try {
    const row = episodeId != null
      ? queryOne("SELECT COUNT(*) AS n FROM system_alerts WHERE (resolved_at IS NULL OR resolved_at = '') AND episode_id = ?", [Number(episodeId)])
      : queryOne("SELECT COUNT(*) AS n FROM system_alerts WHERE (resolved_at IS NULL OR resolved_at = '')")
    return Number(row?.n) || 0
  } catch {
    return 0
  }
}

export function resolveAlert(id, by = 'manual') {
  try {
    const r = execute(
      "UPDATE system_alerts SET resolved_at = ? WHERE id = ? AND (resolved_at IS NULL OR resolved_at = '')",
      [`${new Date().toISOString()}${by ? ' #' + by : ''}`, Number(id)]
    )
    return r.changes > 0
  } catch (e) {
    console.warn('[alerts] 处置告警失败:', e.message)
    return false
  }
}

export function resolveAlertsByShot(shotId, by = 'regen', source = '') {
  if (shotId == null) return 0
  try {
    const stamp = `${new Date().toISOString()}${by ? ' #' + by : ''}`
    const r = source
      ? execute(
        "UPDATE system_alerts SET resolved_at = ? WHERE shot_id = ? AND (resolved_at IS NULL OR resolved_at = '') AND source = ?",
        [stamp, Number(shotId), String(source)]
      )
      : execute(
        "UPDATE system_alerts SET resolved_at = ? WHERE shot_id = ? AND (resolved_at IS NULL OR resolved_at = '')",
        [stamp, Number(shotId)]
      )
    return r.changes || 0
  } catch (e) {
    console.warn('[alerts] 批量处置告警失败:', e.message)
    return 0
  }
}

export function resolveAlertsByScene(sceneId, by = 'regen', source = '') {
  if (sceneId == null) return 0
  try {
    const stamp = `${new Date().toISOString()}${by ? ' #' + by : ''}`
    const r = source
      ? execute(
        "UPDATE system_alerts SET resolved_at = ? WHERE scene_id = ? AND (resolved_at IS NULL OR resolved_at = '') AND source = ?",
        [stamp, Number(sceneId), String(source)]
      )
      : execute(
        "UPDATE system_alerts SET resolved_at = ? WHERE scene_id = ? AND (resolved_at IS NULL OR resolved_at = '')",
        [stamp, Number(sceneId)]
      )
    return r.changes || 0
  } catch (e) {
    console.warn('[alerts] 批量处置场景告警失败:', e.message)
    return 0
  }
}

export function alertSummaryForShot(shotId) {  if (shotId == null) return ''
  try {
    const rows = query(
      "SELECT source, message FROM system_alerts WHERE shot_id = ? AND (resolved_at IS NULL OR resolved_at = '') ORDER BY id DESC LIMIT 3",
      [Number(shotId)]
    )
    if (!rows.length) return ''
    return rows.map((r) => r.message).join('；')
  } catch {
    return ''
  }
}
