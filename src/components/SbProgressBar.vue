<script setup>
import { computed } from 'vue'

const props = defineProps({
  progress: { type: Object, default: null },
  compact: { type: Boolean, default: false },
})

const phaseLabel = computed(() => {
  const p = props.progress
  if (!p) return ''
  return p.phaseLabel || p.phase || ''
})

const percent = computed(() => {
  const p = props.progress?.percent
  return typeof p === 'number' && Number.isFinite(p) ? Math.max(0, Math.min(100, p)) : null
})
const hasTotal = computed(() => percent.value !== null)

const active = computed(() => props.progress?.active !== false)

const elapsedText = computed(() => {
  const ms = props.progress?.elapsedMs
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
  const totalSec = Math.floor(ms / 1000)
  if (totalSec < 60) return `${totalSec} 秒`
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return s ? `${m} 分 ${s} 秒` : `${m} 分`
})

const countText = computed(() => {
  const d = props.progress?.doneCount
  const t = props.progress?.total
  if (typeof d !== 'number' || typeof t !== 'number' || t <= 0) return ''
  return `${d}/${t}`
})
</script>

<template>
  <div
    v-if="progress"
    class="rounded-panel border px-3.5 py-2.5 animate-fade-up transition-colors"
    :class="active
      ? 'border-info/30 bg-info/10'
      : 'border-ok/30 bg-ok/10'"
    role="status"
    aria-live="polite"
  >
    <div class="flex items-center gap-2.5" :class="compact ? 'text-[12px]' : 'text-[12px]'">
      <svg
        v-if="active"
        class="h-3.5 w-3.5 shrink-0 animate-spin text-info"
        viewBox="0 0 24 24" fill="none"
      >
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path>
      </svg>
      <svg
        v-else
        class="h-3.5 w-3.5 shrink-0 text-ok"
        fill="none" stroke="currentColor" viewBox="0 0 24 24"
      >
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7" />
      </svg>

      <span
        v-if="phaseLabel && !compact"
        class="shrink-0 rounded-full px-2 py-0.5 text-micro font-medium"
        :class="active ? 'bg-info/20 text-info' : 'bg-ok/20 text-ok'"
      >{{ phaseLabel }}</span>

      <span class="min-w-0 flex-1 truncate" :class="active ? 'text-info' : 'text-ok'">
        {{ progress.message || '处理中…' }}
      </span>

      <span class="flex shrink-0 items-center gap-2">
        <span
          v-if="countText && !compact"
          class="rounded-full bg-bg-hover px-2 py-0.5 font-mono text-micro text-text-secondary"
        >{{ countText }}</span>
        <span v-if="elapsedText" class="font-mono text-micro text-text-muted">已用 {{ elapsedText }}</span>
      </span>
    </div>

    <div v-if="!compact" class="mt-2 h-1.5 overflow-hidden rounded-full bg-bg-hover">
      <div
        v-if="hasTotal"
        class="h-full rounded-full transition-all duration-500"
        :class="active ? 'bg-info' : 'bg-ok'"
        :style="{ width: percent + '%' }"
      />
      <div
        v-else
        class="h-full w-full animate-shimmer rounded-full"
        :style="{
          backgroundImage: 'linear-gradient(90deg, transparent, rgba(91,157,249,0.75), transparent)',
          backgroundSize: '200% 100%',
        }"
      />
    </div>
  </div>
</template>
