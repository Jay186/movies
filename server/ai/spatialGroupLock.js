// 空间组串行锁（2026-09-18）
//
// 解决什么问题：
//   同一物理空间的不同场景（scene_analysis.spatial_group 相同）批量并发出图时，
//   每张图开画那一刻邻场的 scenes.image_url 还是空串 —— 而空间锚只认已落库的定稿图
//   （sceneAnchors.buildAnchorRefsForScene 里 `TRIM(s.image_url) != ''`）。
//   结果：空间锚返回空数组 → 退化成各画各的纯文生图 → 同一座断桥在崖顶场画成绳索吊桥、
//   谷底场画成木栈桥。并发度越高，错得越彻底。
//
// 为什么按 key 排队而不是全局互斥：
//   不同空间组之间没有任何共享状态，串行它们纯属浪费吞吐。故只按
//   `${episodeId}:${spatialGroup}` 排队——组内串行、组间并发。
//
// 为什么自己写而不用 npm 的 mutex 库：
//   需要「持锁者可被查询 + 超时强制释放」这类兜底语义。生图是外部 HTTP 调用，
//   可能既不 resolve 也不 reject（对端挂住），持锁者就永远走不到 release；
//   没有超时兜底的话，该组后续任务会被永久卡死。
//
// 只用 Promise，零外部依赖。进程内锁——本项目单进程部署，够用且无分布式复杂度。

// 超时兜底：单次生图实测 26~40s，给 5 分钟已是很宽的余量（7 倍以上）。
// 不能设得比前端超时（600s）还大——后面排队的那张还要留出自己的生图时间。
const LOCK_TIMEOUT_MS = 5 * 60 * 1000

// key → 该 key 上「最后一个持锁者」的 Promise，新来的 acquire 排在它后面
const tails = new Map()

function normalizeKey(key) {
  return String(key == null ? '' : key).trim()
}

/**
 * 获取某空间组的串行锁。
 * 空 key 表示无需串行（不属于任何空间组 / 非 scene 类型），直接返回 null，
 * 调用方按「未加锁」处理即可，不影响既有行为。
 *
 * @param {string} key 锁键，形如 `4:cliff_river`
 * @param {string} [holder] 持锁者标识，仅用于日志排查
 * @returns {Promise<null|object>} 锁句柄，交给 releaseSpatialGroupLock 释放；无需加锁时为 null
 */
export async function acquireSpatialGroupLock(key, holder = '') {
  const k = normalizeKey(key)
  if (!k) return null

  const prevTail = tails.get(k) || Promise.resolve()
  let release = () => {}
  const gate = new Promise((resolve) => { release = resolve })

  // 关键：前一段无论成功还是抛异常都不能打断整条链，否则后面排队的任务全部永久等待。
  // 所以这里吞掉 prevTail 的 rejection，只等它「结束」。
  const myTail = prevTail.then(() => gate, () => gate)
  tails.set(k, myTail)
  // 链尾清理：自己结束后若还没有后继者，把 key 从 Map 里摘掉，避免 key 越积越多
  myTail.then(() => { if (tails.get(k) === myTail) tails.delete(k) })

  const waitedFrom = Date.now()
  await prevTail.catch(() => {})
  const waitMs = Date.now() - waitedFrom
  if (waitMs >= 500) {
    console.log(`[spatialLock] ${k} 排队 ${waitMs}ms 后获得锁（${holder}）`)
  }

  const entry = { key: k, holder, tail: myTail, acquiredAt: Date.now(), release, released: false, timer: null }
  // 超时兜底：宁可让极个别任务重叠，也不能让整组后续任务永久卡死
  entry.timer = setTimeout(() => {
    console.warn(`[spatialLock] ${k} 持锁超过 ${LOCK_TIMEOUT_MS}ms，强制释放（${holder}）——疑似生图调用挂住`)
    releaseSpatialGroupLock(entry)
  }, LOCK_TIMEOUT_MS)
  // 不阻止进程退出（unref 在 Node 的 Timeout 对象上可用）
  if (typeof entry.timer.unref === 'function') entry.timer.unref()
  return entry
}

/**
 * 释放锁。幂等：重复调用 / 传 null 均无副作用。
 * 必须放在 finally 里调用——生图失败、抛异常、提前 return 都要放锁。
 * @param {null|object} entry acquireSpatialGroupLock 的返回值
 */
export function releaseSpatialGroupLock(entry) {
  if (!entry || entry.released) return
  entry.released = true
  if (entry.timer) clearTimeout(entry.timer)
  if (tails.get(entry.key) === entry.tail) tails.delete(entry.key)
  entry.release()
  console.log(`[spatialLock] ${entry.key} 释放（${entry.holder}，持锁 ${Date.now() - entry.acquiredAt}ms）`)
}

/**
 * 便捷封装：在锁内执行 task，无论成败都释放。
 * 路由里用两段式（acquire/release）是为了「生图 → 落库 → 才释放」的精确时机，
 * 这个封装只给脚本/一次性逻辑用。
 * @returns {Promise<any>} task 的返回值
 */
export async function withSpatialGroupLock(key, holder, task) {
  const entry = await acquireSpatialGroupLock(key, holder)
  try {
    return await task()
  } finally {
    releaseSpatialGroupLock(entry)
  }
}

/**
 * 当前排队中的锁键（排查/验收用）。
 * @returns {string[]}
 */
export function pendingSpatialGroupLocks() {
  return [...tails.keys()]
}
