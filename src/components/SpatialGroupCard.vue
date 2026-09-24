<script setup>
import { computed, ref, watch } from 'vue'

const props = defineProps({
  group: { type: Object, required: true },
  busy: { type: Boolean, default: false }, 
  forceCollapsed: { type: Boolean, default: null },
  forceCollapseToken: { type: Number, default: 0 },
  baselineHistory: { type: Array, default: () => [] },
  locked: { type: Boolean, default: false },
  orphanAnchor: { type: Object, default: null },
  layoutAnchor: { type: Object, default: null },
  layoutBusy: { type: Boolean, default: false },
  layoutStale: { type: [Boolean, null], default: null },
  layoutHistory: { type: Array, default: () => [] },
  // 集级布局路线：'on' = 布局路线激活；'off' = 整集不走布局路线（布局区域整个收起）
  layoutRoute: { type: String, default: 'on' },
  error: { type: String, default: '' },
})
const emit = defineEmits(['confirm', 'skip', 'regen-baseline', 'refresh-group', 'restore-version', 'toggle-lock', 'generate-layout', 'preview-layout', 'upload-baseline', 'delete-baseline', 'toggle-layout-ref', 'restore-layout', 'delete-layout', 'upload-layout'])

const collapsed = ref(false)
function toggleCollapse() {
  collapsed.value = !collapsed.value
}

watch(
  () => props.forceCollapseToken,
  () => {
    if (props.forceCollapsed === null) return
    collapsed.value = props.forceCollapsed
  }
)

const isSolo = computed(() => (props.group?.memberScenes?.length || 0) === 1)
const memberCount = computed(() => props.group?.memberScenes?.length || 0)
const sharedLandmarksText = computed(() => (props.group?.sharedLandmarks || []).join(' · '))
// 组键和代表场景标题一样时没必要重复显示（手动加的单场景组正是这种情况）
const showGroupKey = computed(() => {
  const key = String(props.group?.group || '').trim()
  const title = String(props.group?.repSceneTitle || '').trim()
  return Boolean(key) && key !== title
})

const confirmedAtText = computed(() => {
  const raw = String(props.group?.confirmedAt || '').trim()
  if (!raw) return ''
  const [datePart, timePart = ''] = raw.split(' ')
  const hm = timePart.slice(0, 5)
  const [y, m, d] = datePart.split('-').map(Number)
  const today = new Date()
  if (y === today.getFullYear() && m === today.getMonth() + 1 && d === today.getDate()) return hm
  return `${m}-${d} ${hm}`
})

// 依据已变：基准确认后，这组的素材指纹变过（服务端 layoutStale 按指纹比对得出）
const baselineStale = computed(() => props.group?.status === 'confirmed' && props.layoutStale === true)

const stateBarClass = computed(() => {
  if (props.group?.status === 'pending') return 'border-l-warn'
  if (props.group?.status === 'confirmed') return baselineStale.value ? 'border-l-warn' : 'border-l-ok'
  return 'border-l-border-strong'
})

const statusBadge = computed(() => {
  if (isSolo.value) return { cls: 'bg-bg-hover text-text-secondary border border-border', icon: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z', text: '单场景 · 用自己的图' }
  if (props.group?.status === 'pending') return { cls: 'bg-warn/15 text-warn border border-warn/30', icon: 'M12 7.5v6M12 16.5h.01', text: '还没定参考图' }
  if (props.group?.status === 'confirmed') {
    if (baselineStale.value) return { cls: 'bg-warn/15 text-warn border border-warn/30', icon: 'M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z', text: '依据已变 · 建议复核' }
    return { cls: 'bg-ok/12 text-ok border border-ok/30', icon: 'M5 13l4 4L19 7', text: confirmedAtText.value ? `参考图已定 · ${confirmedAtText.value}` : '参考图已定' }
  }
  return { cls: 'bg-bg-hover text-text-secondary border border-border', icon: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z', text: '已跳过 · 自由出图' }
})

const baselineBadge = computed(() => {
  if (isSolo.value) return null
  if (props.group?.status === 'confirmed') {
    if (baselineStale.value) return { cls: 'border-warn/50 bg-black/75 text-warn', text: '需复核' }
    return { cls: 'border-ok/50 bg-black/75 text-ok', text: '参考图' }
  }
  if (props.group?.status === 'pending') return { cls: 'border-warn/50 bg-black/75 text-warn', text: '备选图' }
  return { cls: 'border-white/20 bg-black/75 text-white/80', text: '没定参考图' }
})

const showHistory = computed(() => (props.baselineHistory?.length || 0) > 1)
function versionLabel(h, idx, total) {
  const n = total - idx   
  const t = String(h.created_at || '').slice(11, 16)   
  return h.is_current ? `第 ${n} 版 · 当前` : `第 ${n} 版 · ${t}`
}

// 布局区域显示条件：多场景组（有布局概念）且集级布局路线开启；
// 全关（layoutRoute=off）时整条布局路线从组卡上收起——图、按钮、版本带全部不可见
const layoutRouteOn = computed(() => props.layoutRoute !== 'off')
const showLayout = computed(() => !isSolo.value && memberCount.value > 1 && layoutRouteOn.value)
const hasLayout = computed(() => !!props.layoutAnchor?.imageUrl)
function layoutVersionLabel(h) {
  if (h?.isCurrent) return '当前'
  const t = String(h?.createdAt || '').slice(11, 16)
  return t ? `旧版 · ${t}` : '旧版'
}

// 管线阶段条：定基准 → 布局图（路线激活时）→ 组内出图。引导以管线位置为准：
// 高亮 = 当前该做的步骤；灰 = 还没到；停用/跳过如实标注。
// 集级全关时布局这条路线不存在，阶段条只留「定基准 › 组内出图」。
const PIPELINE_CLS = {
  done: 'text-ok',
  current: 'text-accent font-medium',
  todo: 'text-text-muted',
  skipped: 'text-text-muted',
  off: 'text-text-muted',
}
const pipelineStages = computed(() => {
  const s = String(props.group?.status || '')
  const layoutOn = hasLayout.value && props.layoutAnchor?.confirmed !== false
  const layoutOff = hasLayout.value && props.layoutAnchor?.confirmed === false
  const members = props.group?.memberScenes || []
  const withImage = members.filter((m) => m.hasImage).length
  const allDone = members.length > 0 && withImage === members.length
  let outLabel = '组内出图'
  if (s !== 'pending' && members.length && !allDone) outLabel += ` ${withImage}/${members.length}`
  const stages = []
  stages.push(
    s === 'confirmed'
      ? { label: '定基准', state: 'done' }
      : s === 'pending'
        ? { label: '定基准', state: 'current' }
        : { label: '定基准', state: 'skipped' }
  )
  if (layoutRouteOn.value && !isSolo.value && memberCount.value > 1) {
    stages.push(
      s === 'pending'
        ? { label: '布局图', state: 'todo' }
        : layoutOn
          ? { label: '布局图', state: 'done' }
          : layoutOff
            ? { label: '布局图', state: 'off' }
            : { label: '布局图', state: 'current' }
    )
  }
  stages.push(
    s === 'pending'
      ? { label: '组内出图', state: 'todo' }
      : allDone
        ? { label: '组内出图', state: 'done' }
        : { label: outLabel, state: 'current' }
  )
  return stages
})
</script>

<template>
  <section
    class="flex w-full flex-col rounded-panel border border-border bg-[#16161B] p-4 pl-[18px] shadow-card"
    :class="stateBarClass"
    style="border-left-width: 3px"
    :data-group-card="group.status || ''"
    :aria-label="`场景组 ${group.group}`"
  >
    <div
      class="flex cursor-pointer select-none items-center gap-2.5 rounded-control px-1.5 py-1 transition hover:bg-bg-hover/40"
      :class="collapsed ? '' : 'mb-3.5'"
      role="button"
      :aria-expanded="!collapsed"
      :aria-label="`${collapsed ? '展开' : '收起'}场景组 ${group.group}`"
      :title="collapsed ? '展开这组' : '收起这组'"
      @click="toggleCollapse"
    >
      <img
        v-if="collapsed && group.baselineImageUrl"
        :src="group.baselineImageUrl"
        :alt="`场景组 ${group.group} 缩略图`"
        class="h-9 w-14 shrink-0 rounded-md border border-border object-cover"
      />
      <span class="shrink-0 text-2xs font-medium text-text-primary" :title="`代表场景：${group.repSceneTitle || ''}`">{{ group.repSceneTitle || group.group }}</span>
      <span v-if="showGroupKey" class="shrink-0 font-mono text-micro text-text-muted" :title="`组键（对照日志）：${group.group}`">{{ group.group }}</span>
      <span class="shrink-0 text-micro text-text-muted">{{ memberCount }} 个场景</span>
      <span class="flex h-[22px] shrink-0 items-center gap-1 rounded-pill px-2.5 text-micro" :class="statusBadge.cls">
        <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" :d="statusBadge.icon" /></svg>
        {{ statusBadge.text }}
      </span>
      <button
        v-if="locked"
        class="flex h-[22px] shrink-0 items-center gap-1 rounded-pill border border-accent/30 bg-accent/12 px-2.5 text-micro text-accent transition hover:bg-accent/20"
        title="这组的分组已锁定：重析不会重组它的成员。点击解锁（解锁后 LLM 可自由重分组）"
        @click.stop="emit('toggle-lock')"
      >
        <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
        已锁定
      </button>
      <span class="flex-1"></span>
      <template v-if="group.status === 'confirmed' && memberCount > 1 && !busy && !collapsed">
        <button
          class="flex h-7 items-center gap-1.5 rounded-control px-2.5 text-micro text-accent transition hover:bg-accent/12"
          title="并行出图：这组该出的场景（缺失＋过时）同时开画，快。走确认框选范围"
          @click.stop="emit('refresh-group', 'parallel')"
        >
          <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
          并行出图
        </button>
        <button
          class="flex h-7 items-center gap-1.5 rounded-control px-2.5 text-micro text-text-secondary transition hover:bg-bg-hover hover:text-white"
          title="串联出图：这组一张画完落库再画下一张（保锚点时序，慢但稳）。走确认框选范围"
          @click.stop="emit('refresh-group', 'serial')"
        >
          <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
          串联出图
        </button>
      </template>
      <span v-else-if="busy" class="flex items-center gap-1.5 text-micro text-text-muted">
        <svg class="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" /><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
        处理中
      </span>
      <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-text-muted transition hover:bg-bg-hover hover:text-white">
        <svg class="h-3.5 w-3.5 transition-transform" :class="collapsed ? '' : 'rotate-90'" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" /></svg>
      </span>
    </div>

    <div
      v-if="orphanAnchor && !collapsed"
      class="mb-3 flex items-start gap-2 rounded-control border border-warn/30 bg-warn/10 px-3 py-2"
      role="alert"
    >
      <svg class="mt-px h-3.5 w-3.5 shrink-0 text-warn" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" /></svg>
      <div class="min-w-0 flex-1 text-micro leading-relaxed text-warn">
        <span class="font-medium">这组的人审基准已失效：</span>
        组锚 <span class="font-mono">«{{ orphanAnchor.group }}»</span> 已被确认过，但当前没有任何场次归属它
        ——通常是 LLM 重析改变了分组所致。
        <span class="text-warn/70">锁定这组的分组可防止它再次发生。</span>
      </div>
      <button
        v-if="!locked"
        class="shrink-0 rounded-control border border-warn/40 px-2 py-0.5 text-micro text-warn transition hover:bg-warn/20"
        title="锁住当前分组，防止 LLM 重析再次重组这组"
        @click.stop="emit('toggle-lock')"
      >
        锁定分组
      </button>
    </div>

    <div
      v-if="error && !collapsed"
      class="mb-3 flex items-start gap-2 rounded-control border border-danger/30 bg-danger/10 px-3 py-2"
      role="alert"
    >
      <svg class="mt-px h-3.5 w-3.5 shrink-0 text-danger" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
      <div class="min-w-0 flex-1 text-micro leading-relaxed text-danger">
        <span class="font-medium">刚才那步没成功：</span>{{ error }}
        <span class="text-danger/70">——本组状态未变，可再点一次原按钮重试。</span>
      </div>
    </div>

    <div
      v-if="!isSolo && !collapsed"
      class="mb-2.5 flex flex-wrap items-center gap-x-1 gap-y-1 pl-1 text-micro"
      title="空间资产管线：先定基准（或跳过），再画布局图（可选），最后组内出图——高亮的是当前该做的步骤"
    >
      <template v-for="(st, i) in pipelineStages" :key="st.label">
        <span v-if="i" class="text-text-muted">›</span>
        <span class="flex items-center gap-1" :class="PIPELINE_CLS[st.state]">
          <svg v-if="st.state === 'done'" class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7" /></svg>
          <span v-else-if="st.state === 'current'" class="h-1.5 w-1.5 rounded-full bg-accent"></span>
          <span v-else class="h-1.5 w-1.5 rounded-full border border-current opacity-40"></span>
          {{ st.label }}{{ st.state === 'skipped' ? '（跳过）' : st.state === 'off' ? '（停用）' : '' }}
        </span>
      </template>
    </div>

    <div v-show="!collapsed" class="flex items-start gap-0">
      <div class="w-[348px] shrink-0">
        <div class="overflow-hidden rounded-2xl border border-border bg-bg-card transition hover:border-border-light">
          <div class="relative h-[196px] bg-black">
            <img v-if="group.baselineImageUrl" :src="group.baselineImageUrl" :alt="`场景组 ${group.group} 参考图`" class="h-full w-full object-cover" />
            <div v-else class="flex h-full flex-col items-center justify-center gap-2">
              <svg class="h-8 w-8 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
              <span class="text-micro text-text-muted">还没有图 · 点下方「重新画一张」出这组的第一张</span>
            </div>
            <span
              v-if="group.baselineImageUrl && baselineBadge"
              class="absolute left-2.5 top-2.5 flex h-6 items-center gap-1 rounded-pill border px-2.5 text-micro font-medium backdrop-blur"
              :class="baselineBadge.cls"
            >
              <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path v-if="group.status === 'confirmed'" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 6L9 17l-5-5" />
                <path v-else stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v9m0 0l-3.5-3.5M12 12l3.5-3.5M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
              </svg>
              {{ baselineBadge.text }}
            </span>
          </div>
          <div class="p-2.5">
            <div class="text-2xs font-medium text-text-primary">
              <template v-if="isSolo">场景图（= 场 {{ group.repSceneNumber }}）</template>
              <template v-else>参考图{{ group.repSceneNumber ? `（= 场 ${group.repSceneNumber} 的图）` : '' }}</template>
            </div>
            <div class="mt-0.5 text-micro text-text-muted">
              <template v-if="isSolo">单场景组：用自己的图就行</template>
              <template v-else-if="sharedLandmarksText">地标清单：{{ sharedLandmarksText }}</template>
              <template v-else>组内 {{ memberCount }} 个场景都照这张图画</template>
            </div>
            <div v-if="showLayout && !hasLayout && layoutAnchor?.confirmed !== false" class="mt-1.5 flex items-center gap-1 text-micro text-warn">
              <svg class="h-3 w-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" /></svg>
              布局图未生成，出图时不带空间底图
            </div>
            <div class="mt-2.5 flex gap-2">
              <template v-if="isSolo">
                <button
                  class="flex h-[30px] flex-1 items-center justify-center gap-1.5 rounded-control border border-border text-2xs text-text-secondary transition hover:border-border-light hover:text-white disabled:opacity-50"
                  :disabled="busy"
                  title="重新画一张这张场景的图"
                  @click="emit('regen-baseline')"
                >
                  <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                  重新画一张
                </button>
              </template>
              <template v-else-if="group.status === 'confirmed'">
                <button
                  class="flex h-[30px] flex-1 items-center justify-center gap-1.5 rounded-control border border-border text-2xs text-text-secondary transition hover:border-border-light hover:text-white disabled:opacity-50"
                  :disabled="busy"
                  title="重新画一张代表场景的图，画完自动成为参考图（旧版留在下方版本带）"
                  @click="emit('regen-baseline')"
                >
                  <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                  重新画一张
                </button>
                <button
                  class="flex h-[30px] flex-1 items-center justify-center gap-1.5 rounded-control border border-border text-2xs text-text-secondary transition hover:border-ok/40 hover:text-ok disabled:opacity-50"
                  :disabled="busy || !group.baselineImageUrl"
                  title="把代表场景当前这张图定为参考图，组内其它场景照着它画"
                  @click="emit('confirm')"
                >
                  <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" /></svg>
                  就用这张当参考图
                </button>
              </template>
              <template v-else>
                <button
                  v-if="group.baselineImageUrl"
                  class="flex h-[30px] flex-1 items-center justify-center gap-1.5 rounded-control bg-accent text-2xs font-medium text-black transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                  :disabled="busy"
                  title="定了之后，组内其它场景都照这张图画"
                  @click="emit('confirm')"
                >
                  <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" /></svg>
                  就用这张当参考图
                </button>
                <button
                  class="flex h-[30px] items-center justify-center gap-1.5 rounded-control border text-2xs transition disabled:opacity-50"
                  :class="group.baselineImageUrl
                    ? 'border-border px-3 text-text-secondary hover:border-border-light hover:text-white'
                    : 'flex-1 border-transparent bg-accent px-3 font-medium text-black hover:bg-accent-hover'"
                  :disabled="busy"
                  title="重新画一张代表场景的图"
                  @click="emit('regen-baseline')"
                >
                  <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                  重新画一张
                </button>
                <button
                  v-if="group.status === 'pending'"
                  class="flex h-[30px] items-center gap-1.5 rounded-control px-2.5 text-2xs text-text-muted transition hover:bg-bg-hover hover:text-text-secondary disabled:opacity-50"
                  :disabled="busy"
                  title="这组不定参考图：组内场景自由出图（之后随时可以回来定）"
                  @click="emit('skip')"
                >
                  <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 5l7 7-7 7M5 5l7 7-7 7" /></svg>
                  跳过
                </button>
              </template>
              <button
                class="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-control border border-border text-text-secondary transition hover:border-border-light hover:text-white disabled:opacity-50"
                :disabled="busy"
                :title="isSolo ? '上传一张自己的图当这个场景的图（可上传本地图片）' : '上传一张自己的图当这组的参考图（可上传本地图片）'"
                @click="emit('upload-baseline')"
              >
                <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
              </button>
              <button
                v-if="group.baselineImageUrl"
                class="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-control border border-border text-text-secondary transition hover:border-danger/50 hover:text-danger disabled:opacity-50"
                :disabled="busy"
                :title="isSolo ? '删除这个场景的图' : '删除这组的参考图'"
                @click="emit('delete-baseline')"
              >
                <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
              </button>
            </div>

            <div v-if="showHistory" class="mt-3 border-t border-border pt-2.5">
              <div class="mb-1.5 flex items-center gap-1.5 text-micro text-text-muted">
                <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                历史版本（{{ baselineHistory.length }}）· 点旧版换回来当参考图
              </div>
              <div class="flex gap-2 overflow-x-auto pb-0.5">
                <div
                  v-for="(h, idx) in baselineHistory"
                  :key="h.id"
                  class="group/ver relative w-[76px] shrink-0"
                  :class="h.is_current ? '' : 'cursor-pointer'"
                  :title="h.is_current ? '当前参考图' : '点这里换回这一版当参考图'"
                  @click="!h.is_current && emit('restore-version', h)"
                >
                  <div
                    class="overflow-hidden rounded-lg border-2 transition"
                    :class="h.is_current ? 'border-accent' : 'border-transparent opacity-70 hover:opacity-100 hover:border-border-light'"
                  >
                    <img :src="h.image_url" :alt="versionLabel(h, idx, baselineHistory.length)" class="h-[44px] w-full bg-black object-cover" />
                  </div>
                  <div class="mt-1 truncate text-[10px]" :class="h.is_current ? 'text-accent' : 'text-text-muted'">
                    {{ versionLabel(h, idx, baselineHistory.length) }}
                  </div>
                  <div
                    v-if="!h.is_current"
                    class="pointer-events-none absolute inset-x-0 top-3 flex justify-center opacity-0 transition group-hover/ver:opacity-100"
                  >
                    <span class="rounded bg-accent px-1.5 py-0.5 text-[9px] font-medium text-black">换回此版</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div v-if="showLayout" class="mt-3 overflow-hidden rounded-2xl border border-border bg-bg-card transition hover:border-border-light">
          <div class="relative h-[124px] bg-black">
            <img
              v-if="hasLayout"
              :src="layoutAnchor.imageUrl"
              :alt="`场景组 ${group.group} 布局示意图`"
              :class="['h-full w-full cursor-zoom-in object-contain', layoutAnchor.confirmed === false ? 'opacity-40 grayscale' : '']"
              :title="'点开看大图'"
              @click="emit('preview-layout', layoutAnchor)"
            />
            <div v-else class="flex h-full flex-col items-center justify-center gap-1.5">
              <svg class="h-6 w-6 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 7m0 13V7m0 0L9 7" /></svg>
              <span class="text-micro text-text-muted">还没有布局示意图</span>
            </div>
            <span
              v-if="hasLayout"
              class="absolute left-2.5 top-2.5 flex h-6 items-center gap-1 rounded-pill border border-accent/50 bg-black/75 px-2.5 text-micro font-medium text-accent backdrop-blur"
            >
              <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 7m0 13V7m0 0L9 7" /></svg>
              布局示意图
            </span>
            <button
              v-if="hasLayout && !layoutBusy"
              class="absolute right-2.5 top-2.5 flex h-6 items-center gap-1.5 rounded-pill border px-2.5 text-micro font-medium backdrop-blur transition"
              :class="layoutAnchor.confirmed === false
                ? 'border-white/20 bg-black/75 text-white/60 hover:border-white/40 hover:text-white'
                : 'border-accent/50 bg-black/75 text-accent hover:bg-accent/20'"
              :title="layoutAnchor.confirmed === false
                ? '出图时不带这张布局图（组内场景不受它约束）。点击恢复为出图参考'
                : '出图时会把这张布局图作为参考（只约束位置/朝向/远近）。点击停用'"
              :aria-pressed="layoutAnchor.confirmed !== false"
              @click.stop="emit('toggle-layout-ref')"
            >
              <svg v-if="layoutAnchor.confirmed !== false" class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" /></svg>
              {{ layoutAnchor.confirmed === false ? '已停用' : '出图参考' }}
            </button>
            <span
              v-if="layoutBusy"
              class="absolute inset-0 flex items-center justify-center gap-2 bg-black/70 text-micro text-text-secondary"
            >
              <svg class="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" /><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
              正在画布局图（会自动质检，可能要一分钟）
            </span>
          </div>
          <div class="p-2.5">
            <div class="text-2xs font-medium text-text-primary">布局示意图</div>
            <div class="mt-0.5 text-micro leading-relaxed text-text-muted">
              <template v-if="hasLayout && layoutAnchor.confirmed === false">
                已停用 —— 组内场景出图时不带这张图，按各自描述自由发挥
              </template>
              <template v-else-if="hasLayout">
                只定位置/朝向/远近，不带视角光影 —— 组内 {{ memberCount }} 个视角都能照它对齐空间
              </template>
              <template v-else>
                给这 {{ memberCount }} 个场景一张共同的空间底图，避免各画各的、接不上
              </template>
            </div>

            <div
              v-if="layoutStale === true && layoutAnchor.confirmed !== false"
              class="mt-2 flex items-start gap-1.5 rounded-control border border-warn/30 bg-warn/10 px-2 py-1.5 text-micro leading-relaxed text-warn"
              role="alert"
            >
              <svg class="mt-px h-3 w-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" /></svg>
              <span>
                <span class="font-medium">这张图可能已过时</span>
                —— 这组的场景内容改过，图上的空间关系可能对不上了，建议重画。
              </span>
            </div>

            <div v-if="hasLayout" class="mt-2.5 flex gap-2">
              <button
                class="flex h-[30px] flex-1 items-center justify-center gap-1.5 rounded-control border text-2xs transition disabled:opacity-50"
                :class="layoutStale === true && layoutAnchor.confirmed !== false
                  ? 'border-warn/40 text-warn hover:bg-warn/10'
                  : 'border-border text-text-secondary hover:border-accent/40 hover:text-accent'"
                :disabled="layoutBusy"
                :title="hasLayout ? '重画这张布局示意图（覆盖式，计费）' : '给这组画一张俯视布局示意图（计费）'"
                @click="emit('generate-layout')"
              >
                <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                重画布局图
              </button>
              <button
                class="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-control border border-border text-text-secondary transition hover:border-border-light hover:text-white disabled:opacity-50"
                :disabled="layoutBusy"
                title="上传一张自己的俯视示意图当布局图（手绘平面图、设计稿等）"
                @click="emit('upload-layout')"
              >
                <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
              </button>
              <button
                class="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-control border border-border text-text-secondary transition hover:border-danger/50 hover:text-danger disabled:opacity-50"
                :disabled="layoutBusy"
                title="删除这张布局示意图（出图不再带它；历史版本保留，可从版本带换回）"
                @click="emit('delete-layout')"
              >
                <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
              </button>
            </div>
            <div v-else class="mt-2.5 flex gap-2">
              <button
                class="flex h-[30px] flex-1 items-center justify-center gap-1.5 rounded-control border border-border text-2xs text-text-secondary transition hover:border-accent/40 hover:text-accent disabled:opacity-50"
                :disabled="layoutBusy"
                title="给这组画一张俯视布局示意图（计费）"
                @click="emit('generate-layout')"
              >
                <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                生成布局图
              </button>
              <button
                class="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-control border border-border text-text-secondary transition hover:border-border-light hover:text-white disabled:opacity-50"
                :disabled="layoutBusy"
                title="上传一张自己的俯视示意图当布局图（手绘平面图、设计稿等）"
                @click="emit('upload-layout')"
              >
                <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
              </button>
            </div>

            <div v-if="(layoutHistory || []).length - (hasLayout ? 1 : 0) > 0" class="mt-2.5 border-t border-border pt-2">
              <div class="mb-1.5 flex items-center gap-1.5 text-micro text-text-muted">
                <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                历史版本（{{ layoutHistory.length }}）· 点旧版换回来
              </div>
              <div class="flex gap-2 overflow-x-auto pb-0.5">
                <div
                  v-for="h in layoutHistory"
                  :key="h.id"
                  class="group/ver relative w-[76px] shrink-0"
                  :class="h.isCurrent ? '' : 'cursor-pointer'"
                  :title="h.isCurrent ? '当前布局图' : '点这里换回这一版布局图'"
                  @click="!h.isCurrent && emit('restore-layout', h)"
                >
                  <div class="overflow-hidden rounded-lg border-2 transition" :class="h.isCurrent ? 'border-accent' : 'border-transparent opacity-70 hover:opacity-100 hover:border-border-light'">
                    <img :src="h.imageUrl" :alt="layoutVersionLabel(h)" class="h-[44px] w-full bg-black object-contain" />
                  </div>
                  <div class="mt-1 truncate text-[10px]" :class="h.isCurrent ? 'text-accent' : 'text-text-muted'">
                    {{ layoutVersionLabel(h) }}
                  </div>
                  <div v-if="!h.isCurrent" class="pointer-events-none absolute inset-x-0 top-3 flex justify-center opacity-0 transition group-hover/ver:opacity-100">
                    <span class="rounded bg-accent px-1.5 py-0.5 text-[9px] font-medium text-black">换回此版</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="rail relative ml-5 min-w-0 flex-1 border-l-2 border-border-light pl-5">
        <span class="absolute -left-[7px] top-[14px] h-3 w-3 rounded-full border-2 border-border-light bg-bg-secondary" aria-hidden="true"></span>
        <span class="absolute left-3.5 -top-0.5 text-[10px] tracking-widest text-text-muted">
          {{ isSolo
            ? '这个场景'
            : group.status === 'pending'
              ? '这组的场景 · 定好参考图后照着画'
              : group.status === 'confirmed'
                ? `这组的场景 · ${memberCount} 张都照参考图画`
                : '这组的场景 · 没定参考图，自由出图' }}
        </span>
        <div class="flex flex-wrap gap-3 pt-4">
          <slot name="members" />
        </div>
      </div>
    </div>
  </section>
</template>
