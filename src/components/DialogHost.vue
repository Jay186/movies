<script setup>
/**
 * DialogHost（2026-09-16）：全局唯一的弹窗渲染宿主。
 *
 * 职责：
 *  - 渲染 confirm 队列的队首（一次只显示一个，不叠弹）
 *  - 渲染右下角 toast 队列
 *  - 处理焦点管理：打开时聚焦到「安全的那一侧」，关闭时把焦点还给原来的元素
 *
 * 焦点策略（关键）：
 *   普通操作 → 聚焦主按钮（回车即确认，快速路径）
 *   警告/危险操作 → 聚焦「取消」。回车=取消，想确认必须主动移过去点/按 Tab。
 *   这样「习惯性一路回车」的人不会把不可逆操作点出去。
 */
import { computed, ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { dialogState, dismissToast, _settleConfirm } from '../services/dialog'

const confirmQueue = dialogState.confirmQueue
const toasts = dialogState.toasts

const current = computed(() => confirmQueue.value[0] || null)
const isDanger = computed(() => current.value?.tone === 'danger')
// 危险/警告默认焦点落在「取消」上
const focusCancelFirst = computed(() => ['danger', 'warn'].includes(current.value?.tone))

const dialogEl = ref(null)
const cancelBtn = ref(null)
const confirmBtn = ref(null)
let restoreFocusTo = null

// ── 配色：不同危险等级 → 图标与主按钮 ──
const TONE = {
  normal: { wrap: 'border-info/45 bg-info/15 text-info', solid: 'bg-accent text-black hover:bg-accent-hover', icon: 'info' },
  warn: { wrap: 'border-warn/45 bg-warn/15 text-warn', solid: 'bg-warn text-black hover:bg-warn/85', icon: 'warn' },
  danger: { wrap: 'border-danger/45 bg-danger/15 text-danger', solid: 'bg-danger text-black hover:bg-danger/85', icon: 'danger' },
}
const tone = computed(() => TONE[current.value?.tone] || TONE.normal)

const TOAST_TONE = {
  success: { bar: 'bg-ok', text: 'text-ok', label: '完成' },
  info: { bar: 'bg-info', text: 'text-info', label: '提示' },
  warn: { bar: 'bg-warn', text: 'text-warn', label: '注意' },
  error: { bar: 'bg-danger', text: 'text-danger', label: '失败' },
}
const toastTone = (t) => TOAST_TONE[t] || TOAST_TONE.info

function settle(result) {
  if (!current.value) return
  _settleConfirm(current.value.id, result)
}

function onKeydown(e) {
  if (!current.value) return
  if (e.key === 'Escape') {
    e.preventDefault()
    settle(false)
    return
  }
  // 焦点陷阱：Tab 在弹窗内循环，不跑到背后的页面上
  if (e.key === 'Tab') {
    const nodes = [cancelBtn.value, confirmBtn.value].filter(Boolean)
    if (nodes.length < 2) return
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }
}

// 弹窗开启/切换时：锁滚动、抢焦点、记下归还点
watch(current, async (val, old) => {
  if (val && !old) {
    restoreFocusTo = document.activeElement
    document.addEventListener('keydown', onKeydown, true)
    document.body.style.overflow = 'hidden'
  }
  if (!val && old) {
    document.removeEventListener('keydown', onKeydown, true)
    document.body.style.overflow = ''
    try { restoreFocusTo?.focus?.() } catch { /* 原元素可能已卸载 */ }
    restoreFocusTo = null
  }
  if (val) {
    await nextTick()
    // 队列里换了下一个弹窗时也要重新落焦
    ;(focusCancelFirst.value ? cancelBtn.value : confirmBtn.value)?.focus()
  }
})

onMounted(() => {
  if (current.value) {
    document.addEventListener('keydown', onKeydown, true)
    document.body.style.overflow = 'hidden'
  }
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown, true)
  document.body.style.overflow = ''
})
</script>

<template>
  <!-- ═══ 确认框 ═══ -->
  <div
    v-if="current"
    class="fixed inset-0 z-[100] flex items-center justify-center p-5"
    @click.self="current.dismissOnBackdrop && settle(false)"
  >
    <div class="absolute inset-0 bg-black/65 backdrop-blur-[2px]"></div>

    <div
      ref="dialogEl"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="dlg-title"
      class="relative w-full max-w-[440px] overflow-hidden rounded-card border border-border bg-bg-card shadow-pop animate-fade-up"
    >
      <div class="p-5">
        <!-- 标题行：危险等级图标 + 标题 -->
        <div class="flex items-start gap-3">
          <span
            class="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border"
            :class="tone.wrap"
            aria-hidden="true"
          >
            <svg v-if="tone.icon === 'danger'" class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
            <svg v-else-if="tone.icon === 'warn'" class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M12 9v4m0 4h.01M12 3a9 9 0 100 18 9 9 0 000-18z" />
            </svg>
            <svg v-else class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M12 8h.01M11 12h1v4h1M12 3a9 9 0 100 18 9 9 0 000-18z" />
            </svg>
          </span>
          <h2 id="dlg-title" class="text-[14px] font-medium leading-6 text-text-primary">{{ current.title }}</h2>
        </div>

        <!-- 说明：一句话讲清后果 -->
        <p
          v-if="current.description"
          class="ml-9 mt-1.5 whitespace-pre-line text-[12px] leading-relaxed text-text-secondary"
        >{{ current.description }}</p>

        <!-- 结构化明细：键值对齐，关键数字（计费/数量）可单独标色 -->
        <div
          v-if="current.details.length"
          class="ml-9 mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-btn border border-border bg-bg-primary px-3 py-2.5"
        >
          <template v-for="d in current.details" :key="d.label">
            <span class="text-[12px] text-text-muted">{{ d.label }}</span>
            <span
              class="break-words text-[12px]"
              :class="d.tone === 'warn'
                ? 'font-medium text-warn'
                : d.tone === 'danger'
                  ? 'font-medium text-danger'
                  : 'text-text-primary'"
            >{{ d.value }}</span>
          </template>
        </div>

        <!-- 额外次要动作：给用户一条「不做这件事，先去做别的」的出路 -->
        <div v-if="current.extraActions.length" class="ml-9 mt-2.5 flex flex-wrap gap-2">
          <button
            v-for="a in current.extraActions"
            :key="a.label"
            class="rounded-tag border border-border px-2.5 py-1 text-[12px] text-text-secondary transition hover:border-border-light hover:text-text-primary"
            @click="a.onClick?.()"
          >{{ a.label }}</button>
        </div>
      </div>

      <!-- 按钮区：取消在左、主操作在右（主操作用动作词，不用「确定」） -->
      <div class="flex items-center justify-end gap-2 border-t border-border bg-bg-secondary/50 px-5 py-3">
        <button
          ref="cancelBtn"
          class="rounded-btn border border-border bg-bg-card px-4 py-1.5 text-[12px] font-medium text-text-secondary transition hover:border-border-light hover:text-text-primary"
          @click="settle(false)"
        >{{ current.cancelText }}</button>
        <button
          ref="confirmBtn"
          class="rounded-btn px-4 py-1.5 text-[12px] font-medium transition disabled:cursor-not-allowed disabled:opacity-45"
          :class="tone.solid"
          @click="settle(true)"
        >{{ current.confirmText }}</button>
      </div>
    </div>
  </div>

  <!-- ═══ 提示条：右下角堆叠（不打断操作） ═══ -->
  <div
    class="pointer-events-none fixed bottom-5 right-5 z-[95] flex w-[360px] max-w-[calc(100vw-2.5rem)] flex-col gap-2"
    aria-live="polite"
    aria-atomic="false"
  >
    <div
      v-for="t in toasts"
      :key="t.id"
      class="pointer-events-auto flex overflow-hidden rounded-panel border border-border bg-bg-card shadow-pop animate-fade-up"
    >
      <!-- 左侧语义色条：一眼分辨成/败，不靠读文字 -->
      <span class="w-1 shrink-0" :class="toastTone(t.type).bar"></span>
      <div class="flex min-w-0 flex-1 gap-2.5 px-3.5 py-3">
        <div class="min-w-0 flex-1">
          <p class="text-[12px] font-medium leading-snug text-text-primary">
            {{ t.message }}
            <span v-if="t.count > 1" class="ml-1 font-mono text-micro text-text-muted">×{{ t.count }}</span>
          </p>
          <p
            v-if="t.detail"
            class="mt-1 whitespace-pre-line break-words text-micro leading-relaxed text-text-secondary"
          >{{ t.detail }}</p>
          <button
            v-if="t.action"
            class="mt-1.5 rounded-tag border border-border px-2 py-0.5 text-micro text-text-secondary transition hover:border-border-light hover:text-text-primary"
            @click="t.action.onClick?.(); dismissToast(t.id)"
          >{{ t.action.label }}</button>
        </div>
        <!-- 错误必须手动关：失败原因错过就没了，不能自动消失 -->
        <button
          class="shrink-0 self-start rounded-tag p-0.5 text-text-muted transition hover:text-text-primary"
          :title="t.type === 'error' ? '关闭（错误提示不会自动消失）' : '关闭'"
          @click="dismissToast(t.id)"
        >
          <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  </div>
</template>
