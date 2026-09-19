<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { useProjectStore } from '../stores/project'

const store = useProjectStore()
const router = useRouter()

const open = ref(false)
const rootRef = ref(null)
const busy = ref(false)

const currentEp = computed(() => {
  return store.episodes.find((e) => e.id === store.currentEpisodeId) || store.episodes[0] || null
})

function displayName(ep) {
  return ep?.title || `第 ${ep?.episode_number || '?'} 集`
}

function toggleOpen() {
  open.value = !open.value
}

function close() {
  open.value = false
}

function onDocClick(e) {
  if (open.value && rootRef.value && !rootRef.value.contains(e.target)) {
    close()
  }
}

function onKey(e) {
  if (e.key === 'Escape' && open.value) close()
}

onMounted(() => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onKey)
})

async function onSwitch(ep) {
  if (busy.value) return
  if (ep.id === store.currentEpisodeId) {
    close()
    return
  }
  busy.value = true
  try {
    await store.switchEpisode(ep.id)
    close()
  } finally {
    busy.value = false
  }
}

function goManage() {
  close()
  router.push('/episodes')
}
</script>

<template>
  <div ref="rootRef" class="relative">
    <!-- 触发按钮 -->
    <button
      type="button"
      class="flex h-7 items-center gap-2 rounded-md border bg-bg-secondary px-2.5 text-xs transition"
      :class="
        open
          ? 'border-accent text-white shadow-[0_0_0_3px_rgba(199,255,0,0.08)]'
          : 'border-border text-text-secondary hover:border-text-secondary hover:text-white'
      "
      :disabled="store.episodes.length === 0"
      :title="currentEp ? `当前剧集：${displayName(currentEp)}（共 ${store.episodes.length} 集）` : ''"
      @click.stop="toggleOpen"
    >
      <!-- 剧集切换图标 -->
      <svg class="h-3.5 w-3.5 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V7a2 2 0 00-2-2H5a2 2 0 00-2 2m14 0H5" />
      </svg>
      <!-- 当前剧集名 -->
      <span class="max-w-[10rem] truncate font-medium">
        {{ currentEp ? displayName(currentEp) : '加载中…' }}
      </span>
      <!-- 集数小标 -->
      <span v-if="store.episodes.length > 0" class="rounded bg-bg-primary px-1.5 py-0.5 text-[10px] font-medium text-text-muted">
        {{ store.episodes.length > 1 ? `${store.currentEpisode} / ${store.episodes.length}` : '单集' }}
      </span>
      <!-- 下拉箭头 -->
      <svg
        class="h-3 w-3 text-text-muted transition-transform duration-150"
        :class="{ 'rotate-180 text-accent': open }"
        fill="none" stroke="currentColor" viewBox="0 0 24 24"
      >
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M19 9l-7 7-7-7" />
      </svg>
    </button>

    <!-- 下拉面板（仅切换） -->
    <Transition
      enter-active-class="transition duration-100 ease-out"
      enter-from-class="opacity-0 -translate-y-1"
      enter-to-class="opacity-100 translate-y-0"
      leave-active-class="transition duration-75 ease-in"
      leave-from-class="opacity-100 translate-y-0"
      leave-to-class="opacity-0 -translate-y-1"
    >
      <div
        v-if="open"
        class="absolute left-0 top-full z-50 mt-1.5 min-w-[14rem] overflow-hidden rounded-lg border border-border bg-bg-secondary shadow-2xl"
        @click.stop
      >
        <!-- 分组标题 -->
        <div class="flex items-center justify-between px-3 pt-2 pb-1">
          <span class="text-[10px] font-semibold uppercase tracking-wider text-text-muted">切换剧集</span>
          <span class="text-[10px] text-text-muted">{{ store.episodes.length }} 集</span>
        </div>
        <!-- 剧集列表 -->
        <div class="max-h-72 overflow-y-auto px-1 pb-1.5">
          <div
            v-for="ep in store.episodes"
            :key="ep.id"
            class="group flex h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-xs transition"
            :class="
              ep.id === store.currentEpisodeId
                ? 'bg-accent/15 text-accent'
                : 'text-text-secondary hover:bg-bg-hover hover:text-white'
            "
            :title="displayName(ep)"
            @click="onSwitch(ep)"
          >
            <!-- 左侧：勾 / 集号 -->
            <span class="flex h-4 w-4 shrink-0 items-center justify-center">
              <svg
                v-if="ep.id === store.currentEpisodeId"
                class="h-3.5 w-3.5 text-accent"
                fill="none" stroke="currentColor" viewBox="0 0 24 24"
              >
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7" />
              </svg>
              <span v-else class="text-[10px] font-medium text-text-muted">{{ ep.episode_number }}</span>
            </span>
            <!-- 剧名 -->
            <span class="flex-1 truncate">{{ displayName(ep) }}</span>
          </div>
        </div>
        <!-- 底部中转：去剧集列表做新增 / 管理 -->
        <div class="border-t border-border">
          <button
            type="button"
            class="flex h-8 w-full items-center justify-center gap-1 text-[11px] text-text-muted transition hover:text-accent"
            @click.stop="goManage"
          >
            剧集列表（新增 / 管理）
            <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </div>
    </Transition>
  </div>
</template>