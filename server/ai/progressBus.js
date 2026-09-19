import { config } from '../config.js'
import { labelOfPhase } from './progressPhases.js'

const TTL_AFTER_DONE_MS = config.progress?.ttlAfterDoneMs ?? 30_000
const STALE_ACTIVE_MS = config.progress?.staleActiveMs ?? 30 * 60 * 1000
const MAX_ENTRIES = config.progress?.maxEntries ?? 200

const store = new Map()

let globalSeq = 0

function keyOf(episodeId, task) {
  return `${String(episodeId || '')}::${String(task || 'default')}`
}

function sweep(now = Date.now()) {
  for (const [k, v] of store) {
    if (!v) { store.delete(k); continue }
    if (v.done) {
      if (now - (v.finishedAt || v.updatedAt || 0) > TTL_AFTER_DONE_MS) store.delete(k)
    } else if (now - (v.updatedAt || 0) > STALE_ACTIVE_MS) {
      store.delete(k)
    }
  }
  if (store.size > MAX_ENTRIES) {
    const candidates = [...store.entries()]
      .filter(([, v]) => v && v.done)
      .sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0))
    while (store.size > MAX_ENTRIES && candidates.length) {
      store.delete(candidates.shift()[0])
    }
  }
}

export function reportProgress(episodeId, task, payload = {}) {
  try {
    const key = keyOf(episodeId, task)
    const now = Date.now()
    const prev = store.get(key)

    const isDone = payload.finished === true || payload.done === true

    const numericDone = typeof payload.done === 'number' ? payload.done : null
    const hasNumericDone = numericDone !== null && Number.isFinite(numericDone)

    const { done: _rawDone, finished: _rawFinished, ...rest } = payload

    const startedAt = prev?.startedAt || now

    const next = {
      ...(prev || {}),
      ...rest,
      doneCount: hasNumericDone ? numericDone : (prev?.doneCount ?? null),
      done: isDone,
      seq: ++globalSeq,
      startedAt,
      updatedAt: now,
    }
    if (isDone) next.finishedAt = now

    store.set(key, next)
    sweep(now)
  } catch {
  }
}

export function finishProgress(episodeId, task, payload = {}) {
  reportProgress(episodeId, task, { ...payload, finished: true })
}

export function makeReporter(episodeId, task) {
  return (payload) => reportProgress(episodeId, task, payload)
}

export function getProgress(episodeId, task) {
  try {
    const v = store.get(keyOf(episodeId, task))
    if (!v) return null
    return decorate(v)
  } catch {
    return null
  }
}

export function getActiveProgress(episodeId) {
  try {
    const prefix = `${String(episodeId || '')}::`
    let best = null
    for (const [k, v] of store) {
      if (!k.startsWith(prefix) || !v) continue
      if (!best) { best = v; continue }
      if (best.done && !v.done) { best = v; continue }
      if (best.done === v.done && isNewer(v, best)) best = v
    }
    return best ? decorate(best) : null
  } catch {
    return null
  }
}

function isNewer(a, b) {
  const sa = Number(a?.seq)
  const sb = Number(b?.seq)
  if (Number.isFinite(sa) && Number.isFinite(sb)) return sa > sb
  return (a?.updatedAt || 0) > (b?.updatedAt || 0)
}

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

function decorate(v) {
  const now = Date.now()
  const total = Number(v.total) || 0
  const raw = v.doneCount
  const hasCount = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0
  const percent = total > 0 && hasCount
    ? Math.min(100, Math.round((raw / total) * 100))
    : (v.done ? 100 : null)
  const startAt = v.startedAt || v.updatedAt || now
  const endAt = v.done ? (v.finishedAt || v.updatedAt || now) : now
  const elapsedMs = Math.max(0, endAt - startAt)
  return {
    ...v,
    active: !v.done,
    phaseLabel: labelOfPhase(v.phase),
    doneCount: hasCount ? raw : null,
    total: total || null,
    percent,
    elapsedMs,
  }
}

export function __clearAllProgress() {
  store.clear()
}
