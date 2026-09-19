// 长任务进度总线（2026-09-16）
//
// 背景：分镜相关的三条长任务路径——从剧本创作分镜（/storyboard）、从文件规整分镜
// （/storyboard-from-file）、补全镜头提示词（/enrich-storyboard）——耗时都是分钟级，
// 此前只有第一条会上报进度，另两条前端只能干等（"卡住了？"）。
//
// 设计要点（为什么不是一个普通 Map）：
// 1. 按 (episodeId, task) 双键隔离：同一集可能"边补全边重新生成"，单键会互相覆盖，
//    前端看到的是 A 的 phase 配 B 的计数，比不显示更误导。task 是开放的字符串键
//    （storyboard / file / enrich / …），新增任务类型不需要改本文件。
// 2. 结构化优先，message 兜底：前端要画"3/8 场"进度条就得拿到 done/total 数值，
//    只有文案没法画。message 保留成人话，供不需解析的简单场景直接用。
// 3. 终态保活：任务结束后进度不立刻删——前端按固定间隔轮询，删太早会读到 active=false
//    然后展示状态错乱。保活一段时间（TTL_AFTER_DONE_MS）让最后一次轮询拿到收尾结论。
// 4. 防泄漏：长跑服务里如果有 task 忘了标终态，Map 会无限增长。这里做两层防护——
//    写入时清理过期项 + 超上限时淘汰最旧的终态项（活跃项永不淘汰）。
// 5. 绝不抛错：进度上报是体验增强，任何异常都不能影响主流程。所有对外方法内部吞异常。
//
// 阈值（TTL / 僵尸判定 / 条目上限）全部从 config.progress 读取——见 server/config.js，
// 可用 env PROGRESS_TTL_AFTER_DONE_MS / PROGRESS_STALE_ACTIVE_MS / PROGRESS_MAX_ENTRIES 覆盖。
import { config } from '../config.js'
// 阶段注册表：phase 名与中文标签的唯一真源。上报时顺带把标签一起算好下发，
// 前端直接用，不再自己维护"英文 phase → 中文"的映射表（那种重复必然静默失配）。
import { labelOfPhase } from './progressPhases.js'

// 读取时给兜底默认值：即使 config 缺字段（如单测直接引入本模块）也能正常工作。
const TTL_AFTER_DONE_MS = config.progress?.ttlAfterDoneMs ?? 30_000
const STALE_ACTIVE_MS = config.progress?.staleActiveMs ?? 30 * 60 * 1000
const MAX_ENTRIES = config.progress?.maxEntries ?? 200

/** @type {Map<string, object>} key = `${episodeId}::${task}` */
const store = new Map()

// 全局单调序号：每次写入自增。用于"取最近更新的任务"这类跨 key 比较——
// 每 key 各自计数会在不同任务间并列（都从 1 开始），全局计数才严格可比。
let globalSeq = 0

function keyOf(episodeId, task) {
  return `${String(episodeId || '')}::${String(task || 'default')}`
}

/**
 * 清理过期条目。活跃项仅在超过僵尸阈值时清理；终态项超过 TTL 即清理。
 * 仅在写入路径调用（读路径不清理，避免"读一下就删"的副作用）。
 */
function sweep(now = Date.now()) {
  for (const [k, v] of store) {
    if (!v) { store.delete(k); continue }
    if (v.done) {
      // 终态：从结束时刻起算 TTL
      if (now - (v.finishedAt || v.updatedAt || 0) > TTL_AFTER_DONE_MS) store.delete(k)
    } else if (now - (v.updatedAt || 0) > STALE_ACTIVE_MS) {
      // 活跃但太久没更新：判定为僵尸任务（进程异常退出 / 忘记收尾）
      store.delete(k)
    }
  }
  // 超上限：按 updatedAt 升序淘汰终态项，活跃项不动（保护正在跑的任务）
  if (store.size > MAX_ENTRIES) {
    const candidates = [...store.entries()]
      .filter(([, v]) => v && v.done)
      .sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0))
    while (store.size > MAX_ENTRIES && candidates.length) {
      store.delete(candidates.shift()[0])
    }
  }
}

/**
 * 写入/更新进度。
 *
 * payload.done 承担双重语义，这里显式拆开以免互相覆盖：
 *   - 数值  → 已完成计数（doneCount）
 *   - true  → 任务终态标记
 * 因此 `{ done: 9, total: 9 }` 是"完成 9 项"，而 `{ done: true }` 是"任务结束"。
 * 二者可同时表达：`{ done: 9, total: 9, finished: true }`——但通常用 finishProgress 更清楚。
 *
 * @param {string|number} episodeId 集 id
 * @param {string} task 任务类型键（storyboard / file / enrich / …）
 * @param {object} payload 进度数据
 * @param {string} [payload.phase]    阶段标识（prepare / scenes / airlock / enrich / axis / done …）
 * @param {string} [payload.message]  人话文案（前端可直接展示）
 * @param {number} [payload.done]     已完成的计数（数值）
 * @param {boolean} [payload.finished] 是否终态（显式终态标记，避免与计数冲突）
 * @param {number} [payload.total]    总计数（0 或缺失 = 未知总量，前端展示不定量进度）
 * @param {string} [payload.currentLabel] 当前正在处理的对象名（如场次标题、镜头号）
 */
export function reportProgress(episodeId, task, payload = {}) {
  try {
    const key = keyOf(episodeId, task)
    const now = Date.now()
    const prev = store.get(key)

    // 终态标记：显式 finished 字段；兼容旧调用里用布尔 done 表达的写法
    const isDone = payload.finished === true || payload.done === true

    // 数值型 done 是计数，布尔型不是——必须分流，否则会把计数覆盖成 true
    const numericDone = typeof payload.done === 'number' ? payload.done : null
    const hasNumericDone = numericDone !== null && Number.isFinite(numericDone)

    // 先剔除两个语义重叠的原始字段，再用规范化后的值写回，避免 ...payload 把它们原样带进来
    const { done: _rawDone, finished: _rawFinished, ...rest } = payload

    // startedAt 只在首次写入时定格；后续更新沿用，保证耗时统计从任务真正开始算起
    const startedAt = prev?.startedAt || now

    const next = {
      ...(prev || {}),
      ...rest,
      doneCount: hasNumericDone ? numericDone : (prev?.doneCount ?? null),
      done: isDone,
      // 全局单调序号：updatedAt 精度只到毫秒，同毫秒内两次写入会并列，
      // 且不同 key 各自计数无法跨任务比较。全局 seq 保证严格可比较。
      seq: ++globalSeq,
      startedAt,
      updatedAt: now,
    }
    if (isDone) next.finishedAt = now

    store.set(key, next)
    sweep(now)
  } catch {
    // 进度上报失败绝不影响主流程
  }
}

/**
 * 标记任务终态：可同时携带最终计数。
 *   finishProgress(4, 'file', { message: '完成', done: 9, total: 9 })
 */
export function finishProgress(episodeId, task, payload = {}) {
  reportProgress(episodeId, task, { ...payload, finished: true })
}

/**
 * 构造一个 report 回调，供 ai 层（generateStoryboard 等）注入使用。
 * 内部自带 try 包裹，调用方无需再防御。
 *
 * @returns {(payload: object) => void}
 */
export function makeReporter(episodeId, task) {
  return (payload) => reportProgress(episodeId, task, payload)
}

/**
 * 读取某任务的进度快照（含派生字段 percent / elapsedMs）。
 * 不存在返回 null——由调用方决定"没有进度"如何表达。
 */
export function getProgress(episodeId, task) {
  try {
    const v = store.get(keyOf(episodeId, task))
    if (!v) return null
    return decorate(v)
  } catch {
    return null
  }
}

/**
 * 读取某集当前最"值得展示"的任务进度：优先活跃项（取最近更新的），
 * 没有活跃项时取最近结束的终态项（供前端做收尾展示）。
 * 这样一个集页只用一个轮询就能拿到正确的那条进度，不必关心是哪种任务。
 */
export function getActiveProgress(episodeId) {
  try {
    const prefix = `${String(episodeId || '')}::`
    let best = null
    for (const [k, v] of store) {
      if (!k.startsWith(prefix) || !v) continue
      if (!best) { best = v; continue }
      // 活跃项优先于终态项
      if (best.done && !v.done) { best = v; continue }
      if (best.done === v.done && isNewer(v, best)) best = v
    }
    return best ? decorate(best) : null
  } catch {
    return null
  }
}

/**
 * 判定 a 是否比 b 更新。
 * 用每次写入自增的 seq 做严格比较（updatedAt 同毫秒会并列，seq 不会）；
 * 兼容 seq 缺失的历史条目，回落到 updatedAt。
 */
function isNewer(a, b) {
  const sa = Number(a?.seq)
  const sb = Number(b?.seq)
  if (Number.isFinite(sa) && Number.isFinite(sb)) return sa > sb
  return (a?.updatedAt || 0) > (b?.updatedAt || 0)
}

/**
 * 列出某集全部任务进度（调试 / 多任务并跑时前端想全展示用）。
 */
export function listProgress(episodeId) {
  try {
    const prefix = `${String(episodeId || '')}::`
    const out = []
    for (const [k, v] of store) {
      if (!k.startsWith(prefix) || !v) continue
      out.push({ task: k.slice(prefix.length), ...decorate(v) })
    }
    return out
  } catch {
    return []
  }
}

/** 派生字段：percent（0~100，未知总量返回 null）、elapsedMs、phaseLabel。 */
function decorate(v) {
  const now = Date.now()
  const total = Number(v.total) || 0
  // 注意：不能写 Number(v.doneCount)，因为 Number(null) === 0——会把"无计数"
  // 误判成"完成了 0 项"。必须先用 typeof 区分"没这个数"与"数字 0"。
  const raw = v.doneCount
  const hasCount = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0
  const percent = total > 0 && hasCount
    ? Math.min(100, Math.round((raw / total) * 100))
    : (v.done ? 100 : null)
  // 耗时口径：活跃时是"到此刻为止"（持续增长），终态时冻结为"开始→结束"，
  // 否则任务结束后 elapsedMs 会随查询时间无限膨胀，前端会显示一个假的总耗时。
  const startAt = v.startedAt || v.updatedAt || now
  const endAt = v.done ? (v.finishedAt || v.updatedAt || now) : now
  const elapsedMs = Math.max(0, endAt - startAt)
  return {
    ...v,
    // 统一字段名，前端只认这些：active / phase / phaseLabel / message / doneCount / total / percent / currentLabel
    active: !v.done,
    // 阶段中文标签由后端算好下发（真源见 progressPhases.js）——
    // 前端不再持有 phase→中文 映射，新增阶段无需改前端。
    phaseLabel: labelOfPhase(v.phase),
    doneCount: hasCount ? raw : null,
    total: total || null,
    percent,
    elapsedMs,
  }
}

/** 测试用：清空全部进度（不在业务路径调用）。 */
export function __clearAllProgress() {
  store.clear()
}
