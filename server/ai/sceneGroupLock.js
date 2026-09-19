// 空间分组人审锁定（2026-09-17）
//
// ── 为什么需要 ────────────────────────────────────────────────────────────
// spatial_group 由 LLM 在每次重析时**自由裁量**，无任何稳定性保障。
// 实测：同一份剧本连析两次，原本 4 组（cliff_river / forest_edge / forest_valley /
// forest_high_rock）被合并成 2 组（cliff_river / forest_lake）。
//
// 这不是"分得对不对"的问题（合并后组内确实同属一片森林），而是**破坏性问题**：
//   · 已确认的 spatial 组锚以组名为业务键（anchor_key = 组名）。
//     组名一变/组被合并 → 旧锚**成为孤儿**（没有任何场次归属它），
//     而它是 source='manual', confirmed=1 —— **人审基线静默失效，零告警**。
//   · 同一个空间此前积累的出图经验（哪张图是基准）全部作废。
//
// ── 做法 ──────────────────────────────────────────────────────────────────
// 把"某场景归在某组"固化成**人审数据**。锁定后：
//   · 重析时，已锁定的场景**直接复用锁定的组名**，不让 LLM 改；
//   · 只有**尚未锁定**的场景才由 LLM 自由决定归属。
// 这样重析不再能自由重组已验证过的结构，同时新场次仍能正常参与分析。
//
// ── 通用性（项目铁律）────────────────────────────────────────────────────
// 本模块**锁的是分组数据本身**（scene_id → group 映射），
// 不含任何题材 / 语言 / 词表 / 正则假设。
// 换题材、换语言、换成完全不同的剧本结构，一律照常工作 ——
// 它甚至不知道"森林""悬崖"是什么，只认 scene_id 与组名字符串。

/**
 * 读取某集已锁定的全部分组。
 * @param {number} episodeId
 * @param {{query:Function, queryOne:Function}} db
 * @returns {Map<number,string>} scene_id → 锁定组名（无锁 → 空 Map）
 */
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
    // 表不存在（极老库/测试库）→ 无锁，逐字退回未改造行为
    console.warn('[groupLock] 读取分组锁失败，按无锁处理:', e.message)
  }
  return out
}

/**
 * 把锁定结果应用到 LLM 的分析结果上。**纯函数**，便于测试。
 *
 * 语义：
 *   · 锁定的场景 → 组名强制取锁定值（LLM 分得不一样也不采纳）
 *   · 未锁定的场景 → 保留 LLM 的判定（新增场次照常分析）
 *   · 不新增、不删除任何行；只改 spatial_group 一个字段
 *
 * ⚠️ 刻意**不做**的事：不因为"某组的成员全被锁到别组去了"就删组、也不合并同空组。
 *   组是否还有成员，由下游按实际归属自然得出（`liveGroups` 交集清洗早已处理）。
 *   在这里做"清理"只会让本函数从"应用数据"变成"做判断"，那就得引入规则。
 *
 * @param {Array<{scene_id:number, spatial_group:string}>} rows - LLM 分析出的行
 * @param {Map<number,string>} locks - scene_id → 锁定组名
 * @returns {{rows:Array, lockedCount:number, changedCount:number}}
 */
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
    // 只覆盖 spatial_group，其余字段（role/props/elements）仍用 LLM 本轮结果
    return { ...r, spatial_group: locked }
  })
  return { rows: next, lockedCount, changedCount }
}

/**
 * 写入/更新锁定。幂等（同 scene_id 重复锁 → 更新组名与 note）。
 * @param {number} episodeId
 * @param {Array<{scene_id:number, spatial_group:string}>} rows
 * @param {{execute:Function}} db
 * @param {{note?:string}} opts
 * @returns {{locked:number}}
 */
export function saveGroupLocks(episodeId, rows, db, opts = {}) {
  const note = String(opts.note || '').slice(0, 200)
  let locked = 0
  for (const r of Array.isArray(rows) ? rows : []) {
    const sid = Number(r?.scene_id)
    const g = String(r?.spatial_group || '').trim()
    if (!Number.isFinite(sid) || sid <= 0 || !g) continue
    db.execute(
      `INSERT INTO scene_group_locks (episode_id, scene_id, spatial_group, note)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(episode_id, scene_id) DO UPDATE SET spatial_group = excluded.spatial_group, note = excluded.note`,
      [episodeId, sid, g, note]
    )
    locked++
  }
  return { locked }
}

/**
 * 解除锁定。
 * @param {number} episodeId
 * @param {{sceneIds?:number[]}} opts sceneIds 为空 → 解除该集全部
 * @param {{execute:Function}} db
 * @returns {{removed:number}}
 */
export function clearGroupLocks(episodeId, db, opts = {}) {
  const ids = Array.isArray(opts.sceneIds) ? opts.sceneIds.map(Number).filter((n) => Number.isFinite(n) && n > 0) : []
  if (!ids.length) {
    const before = db.queryOne('SELECT COUNT(*) AS c FROM scene_group_locks WHERE episode_id = ?', [episodeId])
    db.execute('DELETE FROM scene_group_locks WHERE episode_id = ?', [episodeId])
    return { removed: Number(before?.c || 0) }
  }
  let removed = 0
  for (const sid of ids) {
    const before = db.queryOne(
      'SELECT COUNT(*) AS c FROM scene_group_locks WHERE episode_id = ? AND scene_id = ?',
      [episodeId, sid]
    )
    db.execute('DELETE FROM scene_group_locks WHERE episode_id = ? AND scene_id = ?', [episodeId, sid])
    removed += Number(before?.c || 0)
  }
  return { removed }
}

/**
 * 给前端用的锁定概览：哪些场被锁、锁在哪个组、以及是否有**孤儿锚**。
 *
 * "孤儿组锚" = 存在一个已确认的 spatial 组锚，但当前**没有任何场次**归在该组名下。
 * 这正是分组漂移造成的伤口的直接体现，前端可据此提示「人审基准已失效」。
 *
 * @param {number} episodeId
 * @param {{query:Function, queryOne:Function}} db
 * @returns {{locks:Array, orphanAnchors:Array}}
 */
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

  // 孤儿组锚：已确认的 spatial 锚，其 anchor_key 不在当前任何场景的组名集合里
  let orphanAnchors = []
  try {
    // ⚠️ 空串必须用单引号：SQLite 里双引号会被解析成**标识符**并报
    //    `no such column: ""`（实测踩过），单引号才是字符串字面量。
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
