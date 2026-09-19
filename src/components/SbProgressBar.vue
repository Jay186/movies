<script setup>
// 长任务进度条（2026-09-16）
//
// 用途：分镜流程三条长任务路径（从剧本生成分镜 / 从文件规整分镜 / 补全镜头提示词）
// 统一展示进度。此前只有一个转圈 + 一行文案，用户看不出"进行到哪一步、还剩多少"，
// 分钟级等待里无法判断是"正常工作"还是"卡死了"。
//
// 设计取舍：
// - 定量 + 定性双轨：有 total 就画百分比进度条；没有 total（如文件规整是单次长调用）
//   就画流动条。两种情况都给"已用时"，让用户对等待有预期。
// - 阶段标签把内部 phase 翻译成人话，用户不需要知道后端有几个阶段。
// - 组件不持有轮询逻辑：数据由 store.sbProgress 传入，组件纯展示，便于复用与测试。
import { computed } from 'vue'

const props = defineProps({
  // store.sbProgress 快照：
  // { active, task, phase, phaseLabel, message, currentLabel, doneCount, total, percent, elapsedMs }
  progress: { type: Object, default: null },
  // 紧凑模式：用于空间受限处（只一行文案 + 细进度条）
  compact: { type: Boolean, default: false },
})

// 阶段标签直接采用后端下发的 phaseLabel（真源在 server/ai/progressPhases.js）。
// 前端【不】维护"英文 phase → 中文"的映射表——那种前后端各写一份的重复，
// 在后端新增/改名阶段时不会报错，只会让标签静默消失，是最难发现的一类失效。
// 兜底：老后端或不带 phaseLabel 的调用，退化为显示 phase 原值（仍不空白）。
const phaseLabel = computed(() => {
  const p = props.progress
  if (!p) return ''
  return p.phaseLabel || p.phase || ''
})

// 进度百分比：后端算好 percent 直接透传（未知总量为 null）
const percent = computed(() => {
  const p = props.progress?.percent
  return typeof p === 'number' && Number.isFinite(p) ? Math.max(0, Math.min(100, p)) : null
})
const hasTotal = computed(() => percent.value !== null)

// 是否有活在后端跑：终态时收尾展示（绿色 + "已完成"），不再转圈
const active = computed(() => props.progress?.active !== false)

// 已用时：人话格式（<1 分钟显示秒，否则分秒）
const elapsedText = computed(() => {
  const ms = props.progress?.elapsedMs
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
  const totalSec = Math.floor(ms / 1000)
  if (totalSec < 60) return `${totalSec} 秒`
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return s ? `${m} 分 ${s} 秒` : `${m} 分`
})

// 计数文案："3/8 场"。只有拿到数值 + 总量时才拼，避免出现 "null/null"
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
      <!-- 运行中转圈；结束后换成对勾，让"已结束"一眼可辨 -->
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

      <!-- 阶段徽章：把后端 phase 翻译成人话 -->
      <span
        v-if="phaseLabel && !compact"
        class="shrink-0 rounded-full px-2 py-0.5 text-micro font-medium"
        :class="active ? 'bg-info/20 text-info' : 'bg-ok/20 text-ok'"
      >{{ phaseLabel }}</span>

      <!-- 主文案 -->
      <span class="min-w-0 flex-1 truncate" :class="active ? 'text-info' : 'text-ok'">
        {{ progress.message || '处理中…' }}
      </span>

      <!-- 计数 + 已用时（右侧，不换行） -->
      <span class="flex shrink-0 items-center gap-2">
        <span
          v-if="countText && !compact"
          class="rounded-full bg-bg-hover px-2 py-0.5 font-mono text-micro text-text-secondary"
        >{{ countText }}</span>
        <span v-if="elapsedText" class="font-mono text-micro text-text-muted">已用 {{ elapsedText }}</span>
      </span>
    </div>

    <!-- 进度条：有总量走定量填充，无总量走流动条纹（表示"在跑但不知还剩多少"） -->
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
