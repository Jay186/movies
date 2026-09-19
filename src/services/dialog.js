
import { ref } from 'vue'

const confirmQueue = ref([])
const toasts = ref([])

let seq = 0
const nextId = (p) => `${p}-${++seq}`

const TOAST_DURATION = { success: 3200, info: 3800, warn: 5200, error: 0 }
const TOAST_MAX = 4

export function confirmDialog(o = {}) {
  const tone = o.tone || 'normal'
  return new Promise((resolve) => {
    confirmQueue.value.push({
      id: nextId('c'),
      title: o.title || '确认操作',
      description: o.description || '',
      details: Array.isArray(o.details) ? o.details.filter((d) => d && d.label) : [],
      confirmText: o.confirmText || '确认',
      cancelText: o.cancelText || '取消',
      tone,
      dismissOnBackdrop: o.dismissOnBackdrop ?? tone !== 'danger',
      extraActions: Array.isArray(o.extraActions) ? o.extraActions : [],
      resolve,
    })
  })
}

export function toast(message, type = 'info', o = {}) {
  const msg = String(message ?? '').trim()
  if (!msg) return null

  const dup = toasts.value.find((t) => t.type === type && t.message === msg)
  if (dup) {
    dup.count = (dup.count || 1) + 1
    if (dup.timer) clearTimeout(dup.timer)
    const d = o.duration ?? TOAST_DURATION[type] ?? TOAST_DURATION.info
    if (d > 0) dup.timer = setTimeout(() => dismissToast(dup.id), d)
    return dup.id
  }

  const item = {
    id: nextId('t'),
    message: msg,
    detail: o.detail || '',
    type,
    count: 1,
    action: o.action || null,
    timer: null,
  }
  toasts.value.push(item)

  while (toasts.value.length > TOAST_MAX) {
    const old = toasts.value.shift()
    if (old?.timer) clearTimeout(old.timer)
  }

  const duration = o.duration ?? TOAST_DURATION[type] ?? TOAST_DURATION.info
  if (duration > 0) item.timer = setTimeout(() => dismissToast(item.id), duration)
  return item.id
}

export function dismissToast(id) {
  const i = toasts.value.findIndex((t) => t.id === id)
  if (i < 0) return
  const [item] = toasts.value.splice(i, 1)
  if (item?.timer) clearTimeout(item.timer)
}

export const toastSuccess = (m, o) => toast(m, 'success', o)
export const toastError = (m, o) => toast(m, 'error', o)
export const toastWarn = (m, o) => toast(m, 'warn', o)
export const toastInfo = (m, o) => toast(m, 'info', o)

export function splitMessage(raw) {
  const lines = String(raw ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
  if (!lines.length) return { message: '', detail: '' }
  if (lines.length === 1) return { message: lines[0], detail: '' }
  return { message: lines[0], detail: lines.slice(1).join('\n') }
}

export function _settleConfirm(id, result) {
  const i = confirmQueue.value.findIndex((c) => c.id === id)
  if (i < 0) return
  const [item] = confirmQueue.value.splice(i, 1)
  item?.resolve?.(result)
}

export const dialogState = { confirmQueue, toasts }
