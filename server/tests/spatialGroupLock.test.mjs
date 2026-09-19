// 空间组串行锁 —— 并发语义独立验证（QA / 严过关，2026-09-18）
//
// 不复用工程师的 _check_spatial_lock.mjs，独立设计用例打薄弱处：
//   1. 同 key 峰值并发必须恒为 1 且 FIFO
//   2. 不同 key 并发不降（吞吐没被牺牲）
//   3. 持锁者抛异常 → 后续任务照常执行（不许永久卡死）
//   4. 持锁者既不 resolve 也不 reject → 超时兜底必须真的走到（用短超时桩实测，不看常量）
//   5. 重复释放 / 释放 null / 空 key 安全性
//
// 幂等、只读、零网络、零 AI 费用。可重复运行：node server/tests/spatialGroupLock.test.mjs

import {
  acquireSpatialGroupLock,
  releaseSpatialGroupLock,
  withSpatialGroupLock,
  pendingSpatialGroupLocks,
} from '../ai/spatialGroupLock.js'

const results = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function record(name, ok, detail = '') {
  results.push({ name, ok })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ::  ${detail}` : ''}\n`)
}

async function t(name, fn) {
  try {
    await fn()
  } catch (e) {
    record(name, false, `EXCEPTION ${e && e.message}`)
  }
}

// ── 1. 同 key：峰值并发恒为 1 + FIFO ────────────────────────────────────────
await t('同 key 串行', async () => {
  const key = '4:cliff_river'
  let cur = 0
  let peak = 0
  const order = []
  await Promise.all([1, 2, 3, 4].map(async (i) => {
    const e = await acquireSpatialGroupLock(key, `t${i}`)
    order.push(i)
    cur += 1
    peak = Math.max(peak, cur)
    await sleep(15)
    cur -= 1
    releaseSpatialGroupLock(e)
  }))
  record('同 key 峰值并发恒为 1', peak === 1, `peak=${peak}`)
  record('同 key 严格 FIFO', JSON.stringify(order) === '[1,2,3,4]', `order=${JSON.stringify(order)}`)
  record('全部结束后无残留 pending 锁', pendingSpatialGroupLocks().length === 0, `pending=${JSON.stringify(pendingSpatialGroupLocks())}`)
})

// ── 2. 不同 key：并发不降 ───────────────────────────────────────────────────
await t('不同 key 并发', async () => {
  let cur = 0
  let peak = 0
  await Promise.all(['4:cliff_river', '4:ice_cave', '4:village'].map(async (k) => {
    const e = await acquireSpatialGroupLock(k, k)
    cur += 1
    peak = Math.max(peak, cur)
    await sleep(30)
    cur -= 1
    releaseSpatialGroupLock(e)
  }))
  record('不同 key 并发不降（吞吐未被牺牲）', peak === 3, `peak=${peak}`)
})

// ── 3. 持锁者抛异常 → 后续任务不许卡死 ──────────────────────────────────────
// 打的就是 spatialGroupLock.js:51 `prevTail.then(() => gate, () => gate)` 这一行
await t('持锁者抛异常', async () => {
  const key = '4:throw_group'
  const done = []
  let caught = null
  const p1 = withSpatialGroupLock(key, 't1', async () => {
    await sleep(10)
    throw new Error('生图失败(模拟)')
  }).catch((e) => { caught = e })
  const p2 = withSpatialGroupLock(key, 't2', async () => { await sleep(5); done.push(2) })
  const p3 = withSpatialGroupLock(key, 't3', async () => { await sleep(5); done.push(3) })
  const settled = await Promise.race([
    Promise.all([p1, p2, p3]).then(() => 'done'),
    sleep(2000).then(() => 'timeout'),
  ])
  record('持锁者抛异常后队列未卡死', settled === 'done', `settled=${settled}`)
  record('异常确实冒泡到调用方', !!caught && caught.message === '生图失败(模拟)', `caught=${caught && caught.message}`)
  record('后续两个任务都执行了', JSON.stringify(done) === '[2,3]', `done=${JSON.stringify(done)}`)
})

// ── 4. 持锁者挂死（既不 resolve 也不 reject）→ 超时兜底 ─────────────────────
// 用短超时桩实测超时分支真的能走到：把模块里唯一的 300000 调度替换成 90ms
await t('持锁者挂死超时', async () => {
  const origSetTimeout = globalThis.setTimeout
  const origWarn = console.warn
  const warns = []
  let replaced = 0
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (ms === 300000) { replaced += 1; return origSetTimeout(fn, 90, ...rest) }
    return origSetTimeout(fn, ms, ...rest)
  }
  console.warn = (...a) => { warns.push(a.map(String).join(' ')) }
  try {
    const key = '4:hang_group'
    // 故意永不释放：模拟生图 HTTP 对端挂住
    const hanger = await acquireSpatialGroupLock(key, 'hanger')
    const t0 = Date.now()
    const waiter = await Promise.race([
      acquireSpatialGroupLock(key, 'waiter'),
      sleep(3000).then(() => 'STUCK'),
    ])
    const dt = Date.now() - t0
    record('超时分支被调用（300000 被替换）', replaced >= 1, `replaced=${replaced}`)
    record('持锁挂死时后续任务未被永久卡死', waiter !== 'STUCK' && waiter && waiter.key === key, `waiter=${waiter === 'STUCK' ? 'STUCK(永久卡死!)' : 'ok'}`)
    record('释放发生在超时窗口附近（非立刻放行）', dt >= 80 && dt < 2000, `等待 ${dt}ms`)
    record('超时打出了强制释放告警', warns.some((w) => String(w).includes('强制释放')), warns.join(' | ').slice(0, 160))
    releaseSpatialGroupLock(waiter === 'STUCK' ? null : waiter)
    releaseSpatialGroupLock(hanger)
    await sleep(0)
  } finally {
    globalThis.setTimeout = origSetTimeout
    console.warn = origWarn
  }
})

// ── 5. 重复释放 / 释放 null / 空 key ────────────────────────────────────────
await t('释放幂等与空 key', async () => {
  let threw = null
  try {
    releaseSpatialGroupLock(null)
    releaseSpatialGroupLock(undefined)
  } catch (e) { threw = e }
  record('释放 null/undefined 安全', threw === null, `threw=${threw && threw.message}`)

  const empty = await acquireSpatialGroupLock('', 'no-group')
  const empty2 = await acquireSpatialGroupLock('   ', 'blank-group')
  const empty3 = await acquireSpatialGroupLock(null, 'null-group')
  record('空/空白/null key 返回 null（不加锁）', empty === null && empty2 === null && empty3 === null, `${empty} / ${empty2} / ${empty3}`)

  // 空 key 必须完全并发（character / prop 及无空间组场景不受影响）
  let cur = 0
  let peak = 0
  await Promise.all([1, 2, 3, 4, 5].map(async () => {
    await acquireSpatialGroupLock('', 'x')
    cur += 1
    peak = Math.max(peak, cur)
    await sleep(20)
    cur -= 1
  }))
  record('空 key 完全并发（并发度=5）', peak === 5, `peak=${peak}`)

  // 重复释放
  const e = await acquireSpatialGroupLock('4:dup', 'dup')
  threw = null
  try {
    releaseSpatialGroupLock(e)
    releaseSpatialGroupLock(e)
    releaseSpatialGroupLock(e)
  } catch (err) { threw = err }
  record('重复释放幂等无副作用', threw === null, `threw=${threw && threw.message}`)
  const after = await Promise.race([
    acquireSpatialGroupLock('4:dup', 'after-dup'),
    sleep(500).then(() => 'STUCK'),
  ])
  record('重复释放后锁仍可正常获取', after !== 'STUCK', `after=${after === 'STUCK' ? 'STUCK' : 'ok'}`)
  releaseSpatialGroupLock(after === 'STUCK' ? null : after)
})

// ── 6. 交错：两个 key 各自串行、彼此并发 ────────────────────────────────────
await t('两 key 交错', async () => {
  const stat = { A: { cur: 0, peak: 0 }, B: { cur: 0, peak: 0 } }
  let globalCur = 0
  let globalPeak = 0
  const mk = (g, i) => (async () => {
    const e = await acquireSpatialGroupLock(`9:${g}`, `${g}${i}`)
    stat[g].cur += 1; stat[g].peak = Math.max(stat[g].peak, stat[g].cur)
    globalCur += 1; globalPeak = Math.max(globalPeak, globalCur)
    await sleep(15)
    stat[g].cur -= 1; globalCur -= 1
    releaseSpatialGroupLock(e)
  })()
  await Promise.all([mk('A', 1), mk('B', 1), mk('A', 2), mk('B', 2), mk('A', 3), mk('B', 3)])
  record('组内峰值并发=1', stat.A.peak === 1 && stat.B.peak === 1, `A=${stat.A.peak} B=${stat.B.peak}`)
  record('组间并发（全局峰值>=2）', globalPeak >= 2, `globalPeak=${globalPeak}`)
})

const failed = results.filter((r) => !r.ok)
process.stdout.write(`\n==== spatialGroupLock: ${results.length - failed.length}/${results.length} passed ====\n`)
if (failed.length) {
  process.stdout.write(`FAILED: ${failed.map((f) => f.name).join(', ')}\n`)
  process.exit(1)
}
