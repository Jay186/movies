// 系统告警（2026-09-13）：把「出片链静默失败」变成「系统自己喊」。
//
// 背景（overview.md 09-12/09-13 多次实锤）：
// 出片成功后有一串 fire-and-forget 后置钩子——末帧接力、风格锚、接缝检测/色向闸、观片闸。
// 它们原本失败只落一行 console.warn，批量出片时无人可见，结论就是：
//   成片文件出来了 → 但验收链全灭 → 系统"看起来成功" → 布哥看片才发现不对。
// 最严重一次是 v4 回写链 RangeError 被 catch 吞掉，回写+接力+接缝+观片四项全灭而无人知。
//
// 设计原则（同 aiLog.js）：记告警绝不能反过来打断出片主流程——所有内部异常吞掉只 console.warn。
// 告警落 system_alerts 表，前端镜头卡片亮角标、出片响应带 warnings。

import { execute, query, queryOne } from '../db.js'

/**
 * 记一条系统告警。
 * @param {Object} a
 * @param {string} a.source        - 钩子标识：'relay'|'styleAnchor'|'seam'|'openerTone'|'review'|'writeback'|'mc'
 * @param {string} a.message       - 一句话人话描述（前端直接展示）
 * @param {string} [a.level]       - 'error'（默认，该镜验收缺失）| 'warn'（非致命降级）| 'info'（成功/信息类，非故障）
 * @param {number} [a.episodeId]
 * @param {number} [a.shotId]
 * @param {string} [a.shotNumber]
 * @param {any}    [a.detail]      - 原始错误对象或字符串，落库前转字符串截断
 * @returns {number|null} 告警行 id；写库失败返回 null（不影响主流程）
 */
export function recordAlert(a = {}) {
  try {
    const detail = a.detail == null
      ? ''
      : String(a.detail?.stack || a.detail?.message || a.detail)
    const source = String(a.source || 'unknown')
    const episodeId = a.episodeId ?? null
    const message = String(a.message || '').slice(0, 500)

    // 去重（2026-09-16，P1 顺手项）：同一 (source, episodeId, message) 已有**未处置**告警时不再重复写。
    // 动机：批量/重复操作会反复命中同一问题（如多次重提资产 → 同一场景冷暖冲突），
    // 不去重则告警列表被同一条刷屏，用户反而忽略真正的新问题。
    // 已在别处读到的旧结论：**已处置(resolved_at 非空)的不算**——处置过代表「那次已确认过」，
    // 再犯应视为新问题重新出现，故只跟未处置的比。
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
    } catch { /* 去重查询失败 → 退化为「照常写入」，绝不因去重影响告警记录 */ }

    const r = execute(
      `INSERT INTO system_alerts (level, source, episode_id, shot_id, shot_number, scene_id, scene_number, message, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        // 级别三档映射（2026-09-18，Q4/P2）：原实现 `a.level==='warn'?'warn':'error'` 把
        // 'info'（如 salvage 打捞成功）也落成 error → UI 上显示红色假告警、用户对告警脱敏。
        // 现显式支持 'info'；其余未知值一律保守回落 'error'（宁可显性，不可漏报）。
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
    // 告警记不上绝不能反过来搞挂出片
    console.warn('[alerts] 记告警失败（已忽略）:', e.message)
    return null
  }
}

/**
 * 列出未处置告警（默认全部；传 episodeId 只看本集）。
 * @param {Object} [opts]
 * @param {number} [opts.episodeId]
 * @param {number} [opts.limit]
 * @param {boolean} [opts.includeResolved] - true 时连已处置一起返回
 */
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

/** 未处置告警计数（前端角标用，避免拉全量）。 */
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

/**
 * 处置告警：不删行，落 resolved_at 时间戳（留档：那次确实断过链）。
 * @param {number} id
 * @param {string} [by] - 处置来源备注，如 'manual' | 'regen'
 */
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

/**
 * 批量处置某镜的未处置告警。用于「该镜重生成功」时自动清掉旧告警——
 * 旧告警描述的是上一版成片的断链，成片已换，结论失效（同 relayLastFrameToNextShot
 * 里"锚帧一换旧 seam_check 即失效"的口径）。
 * @param {number} shotId
 * @param {string} [by]
 * @param {string} [source] 可选：只清该 source 的告警（如 'frameReview'）。
 *   分镜图重出只应清「图带伤」告警，不能误清出片链告警（relay/seam 描述的是
 *   旧成片的断链，成片没换，结论依然有效）。
 * @returns {number} 清理条数
 */
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

/**
 * 场景维度批量处置（2026-09-17，A4/A5 场景图质检）。
 * 与 resolveAlertsByShot 同口径，只是把判据从 shot_id 换成 scene_id。
 * 为什么必须按 source 过滤：场景图重出只应清「图与剧本不符」的告警；
 * 别处写的场景相关告警（若日后有）描述的是别的事，清了就是丢信息。
 * @param {number} sceneId
 * @param {string} [by]
 * @param {string} [source] 可选：只清该 source 的告警（如 'sceneReview'）
 * @returns {number} 清理条数
 */
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

/**
 * 供出片响应体使用的「本镜未处置告警」摘要串（有则前端弹提示，无则空串）。
 * 只取最近 3 条拼成一句，避免响应体过长。
 */
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
