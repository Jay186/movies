
const LOCK_TIMEOUT_MS = 5 * 60 * 1000

const tails = new Map()

function normalizeKey(key) {
  return String(key == null ? '' : key).trim()
}

export async function acquireSpatialGroupLock(key, holder = '') {
  const k = normalizeKey(key)
  if (!k) return null

  const prevTail = tails.get(k) || Promise.resolve()
  let release = () => {}
  const gate = new Promise((resolve) => { release = resolve })

  const myTail = prevTail.then(() => gate, () => gate)
  tails.set(k, myTail)
  myTail.then(() => { if (tails.get(k) === myTail) tails.delete(k) })

  const waitedFrom = Date.now()
  await prevTail.catch(() => {})
  const waitMs = Date.now() - waitedFrom
  if (waitMs >= 500) {
    console.log(`[spatialLock] ${k} 排队 ${waitMs}ms 后获得锁（${holder}）`)
  }

  const entry = { key: k, holder, tail: myTail, acquiredAt: Date.now(), release, released: false, timer: null }
  entry.timer = setTimeout(() => {
    console.warn(`[spatialLock] ${k} 持锁超过 ${LOCK_TIMEOUT_MS}ms，强制释放（${holder}）——疑似生图调用挂住`)
    releaseSpatialGroupLock(entry)
  }, LOCK_TIMEOUT_MS)
  if (typeof entry.timer.unref === 'function') entry.timer.unref()
  return entry
}

export function releaseSpatialGroupLock(entry) {
  if (!entry || entry.released) return
  entry.released = true
  if (entry.timer) clearTimeout(entry.timer)
  if (tails.get(entry.key) === entry.tail) tails.delete(entry.key)
  entry.release()
  console.log(`[spatialLock] ${entry.key} 释放（${entry.holder}，持锁 ${Date.now() - entry.acquiredAt}ms）`)
}

export async function withSpatialGroupLock(key, holder, task) {
  const entry = await acquireSpatialGroupLock(key, holder)
  try {
    return await task()
  } finally {
    releaseSpatialGroupLock(entry)
  }
}

export function pendingSpatialGroupLocks() {
  return [...tails.keys()]
}
