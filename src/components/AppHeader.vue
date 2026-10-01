<script setup>
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useProjectStore } from '../stores/project'
import EpisodeSwitcher from './EpisodeSwitcher.vue'
import AiModelConfigDrawer from './AiModelConfigDrawer.vue'

const route = useRoute()
const router = useRouter()
const store = useProjectStore()
const showGuide = ref(false)
const guideMessage = ref('')
const guideTarget = ref('')
const showModelConfig = ref(false)

const steps = [
  { key: 'script', label: '剧本', path: '/script' },
  { key: 'art', label: '画风', path: '/art' },
  { key: 'settings', label: '设定', path: '/settings' },
  { key: 'storyboard', label: '分镜', path: '/storyboard' },
  { key: 'video', label: '短片', path: '/video' },
]

const activeIndex = computed(() => steps.findIndex(s => s.key === (route.meta.tab || 'script')))

function stepStatus(index) {
  if (index === activeIndex.value) return 'current'
  const done = {
    script: store.scriptConfirmed,
    art: !!store.currentStyle?.key,
    settings: store.characters.length + store.assetScenes.length + store.props.length > 0,
    storyboard: store.storyboardScenes.length > 0,
    video: store.storyboardScenes.some(s => s.shots.some(sh => sh.videoUrl || sh.videoGenerated)),
  }
  if (isUnlocked(index) && done[steps[index].key]) return 'completed'
  return 'pending'
}

function isUnlocked(index) {
  if (index === 0) return true
  if (!store.scriptConfirmed) return false
  if (index === 1) return true
  if (index >= 4) return !!store.currentStyle?.key && store.storyboardConfirmed
  return !!store.currentStyle?.key
}

function getGuide(index) {
  const target = steps[index].label
  if (!store.scriptConfirmed) {
    return { message: `请先完成「剧本」步骤：编辑剧本、点击底部「锁定剧本快照」后，再进入「${target}」。`, target: steps[0].path }
  }
  if (!store.currentStyle?.key) {
    return { message: `请先进入「画风」步骤选择画风并提取资产，再进入「${target}」。`, target: steps[1].path }
  }
  return { message: `请先完成「${steps[activeIndex.value].label}」后，再进入「${target}」。`, target: steps[activeIndex.value].path }
}

function navigate(index) {
  if (index === activeIndex.value) return
  if (isUnlocked(index)) {
    router.push(steps[index].path)
    return
  }
  const guide = getGuide(index)
  guideMessage.value = guide.message
  guideTarget.value = guide.target
  showGuide.value = true
}

function confirmGuide() {
  showGuide.value = false
  router.push(guideTarget.value)
}
</script>

<template>
  <header class="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border bg-bg-primary/95 px-4 backdrop-blur">
    <div class="flex min-w-0 shrink-0 items-center gap-2.5">
      <button
        class="flex h-8 w-8 items-center justify-center rounded-btn text-text-secondary transition hover:bg-bg-hover hover:text-text-primary"
        title="返回剧集列表"
        @click="router.push('/episodes')"
      >
        <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
        </svg>
      </button>
      <span class="max-w-[180px] truncate text-[13px] font-medium text-text-primary" :title="store.projectTitle">
        {{ store.projectTitle }}
      </span>
      <EpisodeSwitcher />
      <div
        class="flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-micro font-medium"
        :class="store.scriptConfirmed
          ? 'border-accent/30 bg-accent/10 text-accent'
          : 'border-border bg-bg-secondary text-text-secondary'"
      >
        <span class="h-1.5 w-1.5 rounded-full" :class="store.scriptConfirmed ? 'bg-accent' : 'bg-text-muted'" />
        {{ store.scriptConfirmed ? `已锁定 V${store.currentVersion || 1}` : '草稿' }}
      </div>
    </div>

    <nav class="flex shrink-0 items-center gap-0.5 rounded-shell border border-border/70 bg-bg-secondary/60 p-1">
      <template v-for="(step, index) in steps" :key="step.key">
        <button
          class="group relative flex items-center gap-2 rounded-[10px] px-2.5 py-1.5 transition"
          :class="{
            'bg-bg-hover': stepStatus(index) === 'current',
            'hover:bg-bg-hover/60': stepStatus(index) !== 'current' && isUnlocked(index),
            'cursor-not-allowed': stepStatus(index) !== 'current' && !isUnlocked(index),
          }"
          :title="stepStatus(index) === 'current' ? `当前：${step.label}` : (isUnlocked(index) ? `前往「${step.label}」` : `「${step.label}」尚未解锁`)"
          @click="navigate(index)"
        >
          <span
            class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border font-mono text-[11px] font-bold transition"
            :class="{
              'border-accent bg-accent text-black': stepStatus(index) === 'current',
              'border-accent/50 bg-accent/10 text-accent': stepStatus(index) === 'completed',
              'border-border text-text-muted group-hover:border-text-secondary group-hover:text-text-secondary': stepStatus(index) === 'pending',
            }"
          >
            <template v-if="stepStatus(index) === 'completed'">
              <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
              </svg>
            </template>
            <template v-else>{{ index + 1 }}</template>
          </span>
          <span
            class="text-[12px] font-medium transition"
            :class="{
              'text-text-primary': stepStatus(index) === 'current',
              'text-text-muted group-hover:text-text-secondary': stepStatus(index) === 'pending',
              'text-accent': stepStatus(index) === 'completed',
            }"
          >
            {{ step.label }}
          </span>
          <span
            v-if="stepStatus(index) === 'current'"
            class="step-underline absolute -bottom-1 left-2.5 right-2.5 h-0.5 rounded-full bg-accent"
          />
        </button>
        <div v-if="index < steps.length - 1" class="text-border-strong">
          <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
          </svg>
        </div>
      </template>
    </nav>

    <div class="flex shrink-0 items-center gap-3">
      <button
        class="relative flex h-8 w-8 items-center justify-center rounded-btn transition"
        :class="showModelConfig ? 'bg-bg-hover text-accent' : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'"
        title="AI 模型配置"
        aria-label="AI 模型配置"
        @click="showModelConfig = true"
      >
        <span class="absolute right-1 top-1 h-[7px] w-[7px] animate-pulse rounded-full bg-accent ring-2 ring-bg-primary" />
        <svg class="h-[17px] w-[17px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </button>
      <div class="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-bg-hover text-[12px] text-text-secondary">
        我
      </div>
    </div>

    <AiModelConfigDrawer :open="showModelConfig" @close="showModelConfig = false" />

    <Teleport to="body">
      <div
        v-if="showGuide"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
        @click.self="showGuide = false"
      >
        <div class="w-full max-w-md rounded-shell border border-border bg-bg-card p-6 shadow-pop">
          <h3 class="mb-2 text-[14px] font-medium text-text-primary">当前步骤不可跳过</h3>
          <p class="mb-6 text-[13px] leading-relaxed text-text-secondary">{{ guideMessage }}</p>
          <div class="flex justify-end gap-2">
            <button
              class="rounded-btn border border-border px-4 py-1.5 text-[12px] text-text-secondary transition hover:border-border-light hover:text-text-primary"
              @click="showGuide = false"
            >
              取消
            </button>
            <button
              class="rounded-btn bg-accent px-4 py-1.5 text-[12px] font-medium text-black transition hover:bg-accent-hover"
              @click="confirmGuide"
            >
              带我去
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </header>
</template>

<style scoped>
.step-underline {
  animation: stepflash 0.9s ease-in-out 2;
}
@keyframes stepflash {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
@media (prefers-reduced-motion: reduce) {
  .step-underline {
    animation: none;
  }
}
</style>
