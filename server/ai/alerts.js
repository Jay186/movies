
import { execute, query, queryOne } from '../db.js'

// —— 出片 prompt 降级 → 告警载荷 ——
// 背景（2026-09-27 实拍事故）：dashscope 额度耗尽时 translate 返回空，中文 description 被
// pickEnglish 静默丢弃，镜内叙事从未送达模型（实测某镜成片角色只是原地走动、并未按剧本执行指定动作）。
// 组装器 v4Video 是纯函数（被估算器与测试复用），只通过 ctx.onDegrade 上报事实；
// 载荷组装与文案在此收口，路由只负责在「重生成功清旧告警」之后落库。
// 同一镜的多项降级**聚合成一条**，避免前端告警面板被刷屏。
const PROMPT_DEGRADE_LABEL = {
  'narrative-fallback': '镜内叙事由 IMD M2 兜底（动作时间轴不受影响）',
  'narrative-lost': '镜内叙事缺失（IMD 无可用 M2）',
  'worldstate-in-lost': '开场 0.00s 构图约束缺失（world_state_in 需 LLM 翻译，库内无英文副本）',
  'worldstate-out-lost': '收尾构图约束缺失（world_state_out 需 LLM 翻译，库内无英文副本）',
  'soundscape-lost': '声景段缺失（overall_soundscape 需 LLM 翻译，库内无英文副本）',
}

export function buildPromptDegradeAlert(degrades = [], { episodeId = null, shotId = null, shotNumber = '' } = {}) {
  const list = Array.isArray(degrades) ? degrades : []
  const kinds = [...new Set(list.map((d) => String(d?.kind || '')).filter(Boolean))]
  if (!kinds.length) return null
  // 未登记的 kind 回退成原名：不丢信息、不崩，方便新降级项上线时先跑通再补文案
  const items = kinds.map((k) => PROMPT_DEGRADE_LABEL[k] || k)
  const rescued = list.find((d) => d?.kind === 'narrative-fallback')
  return {
    episodeId,
    shotId,
    shotNumber,
    source: 'prompt-degrade',
    level: 'warn',
    message: `镜 ${shotNumber} 出片 prompt 降级（LLM 无产出）：${items.join('；')}。建议恢复 LLM 或跑离线代理后重出本镜。`,
    // detail 只给「有 M2 兜底」的项：它是唯一有可核对内容（兜底文本）的降级，
    // 其余（world_state 缺失）没有文本可摘，写了也是空壳。截到 300 免得撑爆告警面板。
    detail: rescued
      ? `兜底叙事来源：${String(rescued.source || 'unknown').toUpperCase()} —— ${String(rescued.text || '').slice(0, 300)}`
      : '',
  }
}

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

const ALERT_REF_COLUMNS = { shot: 'shot_id', scene: 'scene_id', episode: 'episode_id' }

export function clearAlertsByRef(refType, refIds) {
  const column = ALERT_REF_COLUMNS[refType]
  const ids = (Array.isArray(refIds) ? refIds : [refIds])
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v))
  if (!column || !ids.length) return 0
  try {
    const placeholders = ids.map(() => '?').join(',')
    const r = execute(`DELETE FROM system_alerts WHERE ${column} IN (${placeholders})`, ids)
    return r.changes || 0
  } catch (e) {
    console.warn(`[alerts] 清理${refType}告警失败:`, e.message)
    return 0
  }
}

