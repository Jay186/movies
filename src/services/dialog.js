/**
 * 统一弹窗 / 提示服务（2026-09-16）
 *
 * 为什么不用原生 window.confirm / window.alert：
 * 1. 顶部那条「127.0.0.1:5173 显示」是浏览器 chrome，去不掉，露出来像半成品
 * 2. 中文 Windows 下原生弹窗把「取消」渲染成深色实心、「确定」渲染成描边——
 *    视觉权重正好相反，危险操作反而更抢眼，容易点错
 * 3. 信息只能靠 \n 堆，没有层级；计费这类关键数字淹没在正文里
 * 4. 阻塞主线程，无法做焦点管理、无法带结构化明细、无法带额外的次要动作
 *
 * 本模块是「无组件依赖的单例」：组件与 Pinia store 都能直接 import 调用，
 * 由 App.vue 里唯一挂载的 <DialogHost /> 负责渲染。这样 store 里那 40+ 处
 * alert 也能一并收口，不必把弹窗逻辑塞进每个业务函数。
 */

import { ref } from 'vue'

// ── 确认框队列：一次只显示一个，避免两个弹窗叠在一起 ──
const confirmQueue = ref([])
// ── 提示条队列：右下角堆叠 ──
const toasts = ref([])

let seq = 0
const nextId = (p) => `${p}-${++seq}`

// 提示条存活时长（ms）。0 = 不自动关闭，必须手动点掉。
// 错误不自动消失：失败原因错过就没了，而用户很可能正忙着别的事。
const TOAST_DURATION = { success: 3200, info: 3800, warn: 5200, error: 0 }
// 同屏最多几条；超出时挤掉最早的一条
const TOAST_MAX = 4

/**
 * 统一确认框
 *
 * @param {object} o
 * @param {string} o.title          标题：动词短语，说清要做什么（「按场出片 · 场 1」）
 * @param {string} [o.description]  一句话说清后果，跟在标题下方
 * @param {Array}  [o.details]      结构化明细 [{ label, value, tone }]，tone: 'default'|'warn'|'danger'
 * @param {string} [o.confirmText]  主按钮文案。**用动作词**（「开始出片」「删除 3 个镜头」），
 *                                  不要用「确定」——动作词让人看清自己即将做什么
 * @param {string} [o.cancelText]   次按钮文案，默认「取消」
 * @param {'normal'|'warn'|'danger'} [o.tone] 危险等级：决定主按钮配色、默认焦点、遮罩可否点击
 * @param {Array}  [o.extraActions] 额外的次要动作 [{ label, onClick }]（如「先看版本历史」）
 * @returns {Promise<boolean>} true = 走了主操作；false = 取消 / Esc / 点遮罩
 */
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
      // 危险操作不吃「点遮罩 = 取消」：随手一点就关掉，反而让人以为已经取消了
      dismissOnBackdrop: o.dismissOnBackdrop ?? tone !== 'danger',
      extraActions: Array.isArray(o.extraActions) ? o.extraActions : [],
      resolve,
    })
  })
}

/**
 * 右下角提示条
 *
 * @param {string} message            主文案，一句话
 * @param {'success'|'info'|'warn'|'error'} [type]
 * @param {object} [o]
 * @param {string} [o.detail]         补充说明（如失败原因、路径）
 * @param {number} [o.duration]       覆盖默认存活时长；0 = 手动关闭
 * @param {{label:string,onClick:Function}} [o.action] 可选的一个动作按钮（如「重试」「去查看」）
 */
export function toast(message, type = 'info', o = {}) {
  const msg = String(message ?? '').trim()
  if (!msg) return null

  // 去重：同类型同文案的提示若已在屏上，只累加次数、重置计时。
  // 批量操作里同一句「保存失败」可能连着弹十几次，堆十条没有意义。
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

  // 超限时挤掉最早的一条（连同它的定时器一起清掉，避免残留回调）
  while (toasts.value.length > TOAST_MAX) {
    const old = toasts.value.shift()
    if (old?.timer) clearTimeout(old.timer)
  }

  const duration = o.duration ?? TOAST_DURATION[type] ?? TOAST_DURATION.info
  if (duration > 0) item.timer = setTimeout(() => dismissToast(item.id), duration)
  return item.id
}

/** 关闭指定提示条 */
export function dismissToast(id) {
  const i = toasts.value.findIndex((t) => t.id === id)
  if (i < 0) return
  const [item] = toasts.value.splice(i, 1)
  if (item?.timer) clearTimeout(item.timer)
}

/** 语义化快捷方式：省得每处都写类型字符串 */
export const toastSuccess = (m, o) => toast(m, 'success', o)
export const toastError = (m, o) => toast(m, 'error', o)
export const toastWarn = (m, o) => toast(m, 'warn', o)
export const toastInfo = (m, o) => toast(m, 'info', o)

/**
 * 把「一句话 + 若干行明细」的旧式 alert 文案自动拆成
 * { message, detail }：首行作为主文案，其余行合并进 detail。
 * 用于把历史 alert 调用平移到 toast 时保留原本的换行结构。
 */
export function splitMessage(raw) {
  const lines = String(raw ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
  if (!lines.length) return { message: '', detail: '' }
  if (lines.length === 1) return { message: lines[0], detail: '' }
  return { message: lines[0], detail: lines.slice(1).join('\n') }
}

// ── 内部：确认框的收尾（DialogHost 调用）──
export function _settleConfirm(id, result) {
  const i = confirmQueue.value.findIndex((c) => c.id === id)
  if (i < 0) return
  const [item] = confirmQueue.value.splice(i, 1)
  item?.resolve?.(result)
}

export const dialogState = { confirmQueue, toasts }
