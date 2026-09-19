<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { useProjectStore } from '../stores/project'
import { api } from '../services/api'
import { confirmDialog, toastInfo } from '../services/dialog'
import ShotRow from '../components/ShotRow.vue'
import ImportStoryboardDialog from '../components/ImportStoryboardDialog.vue'
import StyleBadge from '../components/StyleBadge.vue'
import QcPanel from '../components/QcPanel.vue'
import SbProgressBar from '../components/SbProgressBar.vue'
import { ASPECT_RATIO_OPTIONS, DELAYS } from '../constants/app'

const store = useProjectStore()
const router = useRouter()
const showImportDialog = ref(false)

async function handleStoryboardImported() {
  const result = await store.loadEpisode(store.currentEpisodeId)
  if (!result?.success) {
    toastInfo('分镜已保存，但页面刷新失败', {
      detail: result?.error || '请稍后重新进入本页查看最新方案。',
      duration: 0,
    })
    return
  }
  toastInfo('分镜导入完成，已加载最新分镜方案')
}
const enriching = ref(false)
const enrichResult = ref('')

const QC_PANEL_KEY = 'storyboard_qc_panel_open'
const showQcPanel = ref(localStorage.getItem(QC_PANEL_KEY) !== '0')
function toggleQcPanel() {
  showQcPanel.value = !showQcPanel.value
  localStorage.setItem(QC_PANEL_KEY, showQcPanel.value ? '1' : '0')
}

const scrollRef = ref(null)
const highlightedShot = ref('')
const highlightSceneIds = ref([]) 
let highlightTimer = null
async function locateShot(shotNumber) {
  const key = String(shotNumber || '')
  if (!key) return
  collapsedScenes.value = []
  highlightSceneIds.value = []
  highlightedShot.value = ''
  await nextTick()
  const root = scrollRef.value
  const el = root?.querySelector?.(`[data-shot-number="${CSS.escape(key)}"]`)
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  highlightedShot.value = key
  if (highlightTimer) clearTimeout(highlightTimer)
  highlightTimer = setTimeout(() => { highlightedShot.value = '' }, 2200)
}
onBeforeUnmount(() => { if (highlightTimer) clearTimeout(highlightTimer) })

const qcErrorCount = computed(() => store.qcReport?.errorCount || 0)
const qcWarningCount = computed(() => store.qcReport?.warningCount || 0)

watch(
  () => [store.currentEpisodeId, store.storyboardScenes],
  ([id]) => { if (id) store.loadQcReport({ silent: true }) },
  { immediate: true }
)

const moreOpen = ref(false)
const menuRef = ref(null)
function onDocClick(e) {
  if (!moreOpen.value) return
  if (menuRef.value && !menuRef.value.contains(e.target)) moreOpen.value = false
}
function onEsc(e) {
  if (e.key === 'Escape') moreOpen.value = false
}
onMounted(() => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onEsc)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onEsc)
})
function menuAction(name) {
  moreOpen.value = false
  handleStoryboardAction(name)
}

function sceneDuration(scene) {
  return (scene.shots || []).reduce((n, sh) => n + (Number(sh.duration) || 0), 0)
}

const ratioShort = computed(() => {
  const opt = ASPECT_RATIO_OPTIONS.find((o) => o.value === store.aspectRatio)
  return opt ? opt.label : '16:9'
})

const missingPromptCount = computed(() =>
  store.storyboardScenes.reduce(
    (n, s) => n + s.shots.filter(sh => !(sh.integratedMultimodalDescription || '').trim()).length,
    0
  )
)

async function enrichPrompts() {
  if (!store.currentEpisodeId || enriching.value) return
  if (!missingPromptCount.value) {
    toastInfo('所有镜头都已有 AI 提示词，无需补全')
    return
  }
  enriching.value = true
  enrichResult.value = ''
  store.startSbProgressPolling(store.currentEpisodeId)
  try {
    const res = await api.enrichStoryboard(store.currentEpisodeId, { onlyMissing: true })
    const errMsg = res?.errors?.length
      ? res.errors.map(e => `镜头${e.shot}：${e.error?.slice(0, 60)}`).join('；')
      : ''
    enrichResult.value = res?.failed > 0
      ? `补全：${res.enriched} 条成功 / ${res.failed} 条失败${errMsg ? '（' + errMsg + '）' : ''}`
      : `补全完成：${res?.enriched || missingPromptCount.value} 条`
    await store.loadEpisode(store.currentEpisodeId)
  } catch (e) {
    enrichResult.value = '补全失败：' + (e.message || '未知错误')
  } finally {
    enriching.value = false
    store.stopSbProgressPolling()
    store.settleSbProgress('提示词补全完成')
    setTimeout(() => { enrichResult.value = '' }, DELAYS.RESULT_BANNER_MS)
    store.clearSbProgressAfter()
  }
}

const collapsedScenes = ref([])
function toggleScene(sceneId) {
  const next = [...collapsedScenes.value]
  const i = next.indexOf(sceneId)
  if (i >= 0) next.splice(i, 1)
  else next.push(sceneId)
  collapsedScenes.value = next
}
function isCollapsed(sceneId) {
  return collapsedScenes.value.includes(sceneId)
}
const allCollapsed = computed(() => {
  const total = store.storyboardScenes.length
  return total > 0 && collapsedScenes.value.length >= total
})
function toggleAllScenes() {
  if (allCollapsed.value) collapsedScenes.value = []
  else collapsedScenes.value = store.storyboardScenes.map((s) => s.id)
}

async function goNext() {
  await store.confirmStoryboard()
  router.push('/video')
}
function handleStoryboardAction(btn) {
  if (btn === '重新提取分镜脚本') {
    if (store.storyboardSource === 'imported') {
      confirmDialog({
        title: '重新提取分镜',
        description: '当前分镜来自文件导入。重新提取会用剧本重新生成，并覆盖掉导入的内容。',
        details: [{ label: '现有分镜', value: `${store.storyboardScenes.length} 场 · ${store.totalShots} 镜` }],
        confirmText: '覆盖并重新提取',
        cancelText: '保留导入的分镜',
        tone: 'warn',
      }).then((ok) => { if (ok) store.extractStoryboard() })
      return
    }
    store.extractStoryboard()
  } else if (btn === '批量分镜图') {
    store.batchGenerateImages('frame', store.imageModel)
  } else if (btn === '批量站位图') {
    store.batchGenerateImages('blocking')
  } else if (btn === '导入分镜脚本') {
    showImportDialog.value = true
  } else if (btn === '补全提示词') {
    enrichPrompts()
  } else if (btn === '清空分镜') {
    clearStoryboard()
  }
}

const clearing = ref(false)
async function clearStoryboard() {
  if (!store.storyboardScenes.length) {
    showImportDialog.value = true
    return
  }
  const withMedia = store.storyboardScenes.reduce(
    (n, s) => n + s.shots.filter((sh) => sh.frameUrl || sh.videoUrl || sh.blockingUrl || sh.keyframeUrl).length,
    0
  )
  const ok = await confirmDialog({
    title: '清空当前分镜',
    description: '清空后从头再来，且无法撤销。',
    details: [
      { label: '现有分镜', value: `${store.storyboardScenes.length} 场 · ${store.totalShots} 镜` },
      {
        label: '将丢失的产出',
        value: withMedia ? `${withMedia} 个镜头的图片 / 视频关联会被一并删除` : '暂无已生成的图片或视频',
        ...(withMedia ? { tone: 'danger' } : {}),
      },
    ],
    confirmText: '清空分镜',
    cancelText: '保留',
    tone: 'danger',
  })
  if (!ok) return
  clearing.value = true
  try {
    await store.clearStoryboard()
    showImportDialog.value = true
  } catch {
  } finally {
    clearing.value = false
  }
}
</script>

<template>
  <div class="flex h-full w-full flex-col bg-bg-primary">
    <div class="shrink-0 border-b border-border bg-bg-primary">
      <div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-6 py-3.5">
        <div class="flex min-w-0 items-center gap-4">
          <h2 class="text-[15px] font-medium text-text-primary">分镜脚本</h2>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <div class="flex items-center overflow-hidden rounded-btn border border-border bg-bg-secondary/60">
            <button
              class="flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] text-text-secondary transition hover:bg-bg-hover hover:text-text-primary"
              :title="allCollapsed ? '展开全部场次' : '折叠全部场次'"
              @click="toggleAllScenes"
            >
              <svg class="h-3.5 w-3.5 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h7" /></svg>
              {{ allCollapsed ? '展开全部' : '折叠全部' }}
            </button>

            <span class="h-4 w-px shrink-0 bg-border"></span>
            <span class="flex items-center px-2.5 py-1.5">
              <StyleBadge />
            </span>

            <span class="h-4 w-px shrink-0 bg-border"></span>
            <label class="flex cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-[12px]" title="分镜图与站位图使用的生图模型（前列支持以图生图；末项为分镜四宫格专用通道）">
              <span class="text-text-muted">模型</span>
              <select v-model="store.imageModel" class="cursor-pointer bg-transparent text-[12px] text-text-primary outline-none">
                <option value="zikl">gpt-image-2 (ZIKL)</option>
                <option value="visionary-nano-banana-pro">Nano Banana Pro</option>
                <option value="visionary-nano-banana-pro-cl">Nano Banana Pro CL</option>
                <option value="visionary-nano-banana-2-lite">Nano Banana 2 Lite</option>
                <option value="runninghub">四宫格通道（文生图）</option>
              </select>
            </label>

            <span class="h-4 w-px shrink-0 bg-border"></span>
            <span
              class="flex items-center px-2.5 py-1.5 font-mono text-[12px] text-text-secondary"
              :title="`项目级设置（在剧集页顶部修改）：分镜图与出片统一 ${ratioShort}`"
            >{{ ratioShort }}</span>
          </div>

          <button
            v-if="missingPromptCount > 0"
            class="flex items-center gap-1.5 rounded-btn border border-warn/40 bg-warn/10 px-3 py-1.5 text-[12px] font-medium text-warn transition hover:border-warn/60 hover:bg-warn/15 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="enriching || store.aiLoading"
            :title="`有 ${missingPromptCount} 个镜头缺少 AI 提示词，点击为它们调用 LLM 补全`"
            @click="enrichPrompts"
          >
            <svg v-if="!enriching" class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" /></svg>
            <svg v-else class="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
            {{ enriching ? '补全中...' : `补全提示词 (${missingPromptCount})` }}
          </button>

          <div ref="menuRef" class="relative">
            <button
              class="flex h-[30px] w-[30px] items-center justify-center rounded-btn border border-border bg-bg-secondary/60 text-text-secondary transition hover:border-border-light hover:bg-bg-hover hover:text-text-primary"
              title="更多操作"
              @click="moreOpen = !moreOpen"
            >
              <svg class="h-4 w-4" fill="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="12" cy="19" r="1.6" /></svg>
            </button>
            <div
              v-if="moreOpen"
              class="absolute right-0 top-[calc(100%+6px)] z-40 w-56 overflow-hidden rounded-card border border-border bg-bg-card py-1 shadow-pop animate-fade-up"
            >
              <button
                class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12px] text-text-secondary transition hover:bg-bg-hover hover:text-text-primary"
                :disabled="store.aiLoading"
                @click="menuAction('重新提取分镜脚本')"
              >
                <svg class="h-3.5 w-3.5 shrink-0 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                <span class="flex-1">{{ store.storyboardSource === 'imported' ? '重新提取（覆盖导入）' : '重新提取分镜' }}</span>
              </button>
              <button
                class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12px] text-text-secondary transition hover:bg-bg-hover hover:text-text-primary"
                @click="menuAction('导入分镜脚本')"
              >
                <svg class="h-3.5 w-3.5 shrink-0 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" /></svg>
                <span class="flex-1">导入分镜脚本</span>
              </button>
              <button
                class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12px] text-text-secondary transition hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
                :disabled="store.batchStoryboardGenerating"
                :title="`为所有尚无分镜图的镜头批量出图（当前模型：${store.imageModel}）`"
                @click="menuAction('批量分镜图')"
              >
                <svg class="h-3.5 w-3.5 shrink-0 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" /></svg>
                <span class="flex-1">{{ store.batchStoryboardGenerating ? '分镜图生成中…' : '批量分镜图' }}</span>
              </button>
              <button
                class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12px] text-text-secondary transition hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
                :disabled="store.batchBlockingGenerating"
                title="为所有尚无站位图的镜头批量出图（俯视图，标角色走位）"
                @click="menuAction('批量站位图')"
              >
                <svg class="h-3.5 w-3.5 shrink-0 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" /></svg>
                <span class="flex-1">{{ store.batchBlockingGenerating ? '站位图生成中…' : '批量站位图' }}</span>
              </button>
              <div class="my-1 h-px bg-border"></div>
              <button
                class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12px] text-danger transition hover:bg-danger/10"
                :disabled="clearing"
                @click="menuAction('清空分镜')"
              >
                <svg class="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                <span class="flex-1">{{ clearing ? '清空中...' : '清空分镜' }}</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="mt-2.5 space-y-2 px-6 pb-1">
        <div
          v-if="enrichResult"
          class="flex items-center gap-2 rounded-panel border px-3.5 py-2.5 text-[12px] animate-fade-up"
          :class="enrichResult.includes('失败') && !enrichResult.includes('成功')
            ? 'border-danger/30 bg-danger/10 text-danger'
            : 'border-ok/30 bg-ok/10 text-ok'"
        >
          <svg class="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          {{ enrichResult }}
        </div>

        <SbProgressBar v-if="store.sbProgress" :progress="store.sbProgress" />
        <div
          v-else-if="store.aiLoading && store.aiProgressMessage"
          class="flex items-center gap-2.5 rounded-panel border border-info/30 bg-info/10 px-3.5 py-2.5 text-[12px] text-info animate-fade-up"
        >
          <svg class="h-3.5 w-3.5 shrink-0 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path>
          </svg>
          <span>{{ store.aiProgressMessage }}</span>
        </div>

        <div v-if="store.storyboardStale" class="flex items-center justify-between gap-4 rounded-panel border border-warn/40 bg-warn/10 px-3.5 py-3 animate-fade-up">
          <div class="flex items-center gap-2 text-[12px] leading-relaxed text-warn">
            <svg class="h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
            <span>剧本已修改，当前分镜基于旧剧本生成，镜头内容可能与新剧本不符</span>
          </div>
          <button
            class="shrink-0 rounded-btn bg-warn px-3 py-1.5 text-[12px] font-medium text-black transition hover:bg-warn/85 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="store.aiLoading"
            @click="handleStoryboardAction('重新提取分镜脚本')"
          >
            {{ store.aiLoading ? '生成中...' : '重新生成分镜' }}
          </button>
        </div>

        <div
          v-if="store.totalShots > 0"
          class="overflow-hidden rounded-panel border transition-colors"
          :class="qcErrorCount
            ? 'border-danger/40 bg-danger/5'
            : qcWarningCount
              ? 'border-warn/40 bg-warn/5'
              : 'border-border bg-bg-secondary/40'"
        >
          <div class="flex items-center justify-between gap-3 px-3 py-2">
            <button class="group flex min-w-0 flex-1 items-center gap-2 text-left" @click="toggleQcPanel">
              <svg
                class="h-3 w-3 shrink-0 text-text-muted transition-transform duration-200"
                :class="showQcPanel ? 'rotate-90' : ''"
                fill="none" stroke="currentColor" viewBox="0 0 24 24"
              ><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 5l7 7-7 7" /></svg>
              <span class="text-[12px] font-medium text-text-primary">分镜质检</span>
              <span
                v-if="store.qcReport"
                class="flex shrink-0 items-center gap-2 text-micro"
              >
                <span v-if="qcErrorCount" class="inline-flex items-center gap-1 rounded-full border border-danger/40 bg-danger/10 px-2 py-0.5 font-medium text-danger">
                  <span class="h-1.5 w-1.5 rounded-full bg-danger"></span>{{ qcErrorCount }} 必须修
                </span>
                <span v-if="qcWarningCount" class="inline-flex items-center gap-1 rounded-full border border-warn/40 bg-warn/10 px-2 py-0.5 font-medium text-warn">
                  <span class="h-1.5 w-1.5 rounded-full bg-warn"></span>{{ qcWarningCount }} 建议修
                </span>
                <span v-if="!qcErrorCount && !qcWarningCount" class="inline-flex items-center gap-1 text-ok">
                  <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7" /></svg>
                  全部通过
                </span>
              </span>
              <span v-else-if="store.qcLoading" class="shrink-0 text-micro text-text-muted">质检中…</span>
              <span v-else class="shrink-0 text-micro text-text-muted" title="尚未质检——展开面板可立即跑一遍（不消耗 AI 额度）">未质检</span>
            </button>
            <span class="shrink-0 text-micro text-text-muted">{{ showQcPanel ? '收起' : '展开' }}</span>
          </div>
          <div v-if="showQcPanel" class="border-t border-border/60 p-2">
            <QcPanel @locate="locateShot" />
          </div>
        </div>
      </div>
    </div>

    <div ref="scrollRef" class="flex-1 overflow-y-auto px-6 py-4">
      <div v-if="!store.storyboardScenes.length" class="flex h-full flex-col items-center justify-center gap-4">
        <div class="flex h-16 w-16 items-center justify-center rounded-full border border-dashed border-border">
          <svg class="h-7 w-7 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM14 13a1 1 0 011-1h5a1 1 0 011 1v6a1 1 0 01-1 1h-5a1 1 0 01-1-1v-6z" />
          </svg>
        </div>
        <div class="text-center">
          <p class="text-[13px] text-text-secondary">还没有分镜脚本</p>
          <p class="mt-1 text-[12px] text-text-muted">从剧本自动提取，或导入已有的分镜文件</p>
        </div>
        <div class="flex items-center gap-2">
          <button
            class="rounded-btn bg-accent px-4 py-2 text-[12px] font-medium text-black transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="store.aiLoading"
            @click="handleStoryboardAction('重新提取分镜脚本')"
          >
            {{ store.aiLoading ? '提取中...' : '从剧本提取分镜' }}
          </button>
          <button
            class="rounded-btn border border-border px-4 py-2 text-[12px] text-text-secondary transition hover:border-border-light hover:text-text-primary"
            @click="handleStoryboardAction('导入分镜脚本')"
          >
            导入分镜脚本
          </button>
        </div>
      </div>

      <div
        v-for="scene in store.storyboardScenes"
        :key="scene.id"
        class="mb-5 overflow-hidden rounded-card border border-border/50 bg-bg-card shadow-card transition-all duration-200 hover:border-border/80 hover:shadow-card-hover"
      >
        <div class="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-border/40 bg-bg-card/95 px-4 py-3 backdrop-blur">
          <button
            class="group flex min-w-0 flex-1 items-center gap-3 text-left"
            :title="isCollapsed(scene.id) ? '点击展开该场次' : '点击折叠该场次'"
            @click="toggleScene(scene.id)"
          >
            <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-btn text-text-muted transition group-hover:bg-bg-hover group-hover:text-accent">
              <svg
                class="h-3.5 w-3.5 transition-transform duration-200"
                :class="isCollapsed(scene.id) ? '' : 'rotate-90'"
                fill="none" stroke="currentColor" viewBox="0 0 24 24"
              ><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 5l7 7-7 7" /></svg>
            </span>
            <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-[12px] font-bold text-black">
              {{ scene.sceneNumber || scene.id }}
            </span>
            <span class="truncate text-[14px] font-medium text-text-primary" :title="scene.title">{{ scene.title }}</span>
            <span class="shrink-0 rounded-full border border-border bg-bg-primary/60 px-2.5 py-0.5 text-micro text-text-secondary">
              {{ scene.shots.length }} 镜
            </span>
            <span class="shrink-0 font-mono text-micro text-text-muted">{{ sceneDuration(scene) }}s</span>
          </button>
          <div class="flex shrink-0 items-center gap-1.5">
            <span v-if="isCollapsed(scene.id)" class="text-micro text-text-muted">已折叠</span>
            <button
              class="flex items-center gap-1.5 rounded-btn px-2.5 py-1 text-micro text-text-muted transition hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="store.aiLoading"
              title="从当前剧本重新提取全部分镜"
              @click="handleStoryboardAction('重新提取分镜脚本')"
            >
              <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
              重新提取
            </button>
          </div>
        </div>

        <template v-if="!isCollapsed(scene.id)">
          <div class="sticky top-[53px] z-10 mx-4 mb-1 mt-2 overflow-hidden rounded-panel border border-border/40 bg-bg-secondary/95 shadow-inset backdrop-blur">
            <div class="grid grid-cols-[52px_200px_minmax(280px,1fr)_156px_156px_156px_56px] items-center gap-3 px-4 py-2.5 text-micro font-medium text-text-muted">
            <span>镜头</span>
            <span>美术资产</span>
            <span>画面描述 / AI 提示词</span>
            <span class="text-center">分镜图</span>
            <span class="text-center" title="本镜结束画面（由 final_frame 出图），供下一镜对齐接缝">尾帧锚</span>
            <span class="text-center">站位图</span>
            <span class="text-center">时长</span>
            </div>
          </div>

          <ShotRow
            v-for="(shot, idx) in scene.shots"
            :key="shot.id"
            :shot="shot"
            :index="idx"
            :show-video="false"
            :highlighted="highlightedShot === String(shot.shotNumber || '')"
          />
        </template>
      </div>
    </div>

    <ImportStoryboardDialog
      v-model="showImportDialog"
      :episode-id="store.currentEpisodeId"
      @imported="handleStoryboardImported"
    />

    <div class="shrink-0 px-6 py-4">
      <div class="flex items-center justify-between gap-4 rounded-panel border border-border/50 bg-bg-secondary px-5 py-3 shadow-card">
        <div class="flex min-w-0 items-center gap-2 text-[12px] text-text-muted">
          <svg class="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          <span class="truncate">分镜确认后将作为短片合成的输入，镜头顺序与时长将影响最终成片</span>
        </div>
        <button
          :disabled="store.aiLoading || !store.totalShots"
          class="group flex shrink-0 items-center gap-2 rounded-btn bg-accent px-5 py-2 text-[13px] font-medium text-black transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
          @click="goNext"
        >
          <span>{{ store.aiLoading ? '分镜生成中...' : (store.storyboardConfirmed ? '进入短片创作' : '确认分镜并进入短片创作') }}</span>
          <svg class="h-4 w-4 transition group-hover:translate-x-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M13 7l5 5m0 0l-5 5m5-5H6" />
          </svg>
        </button>
      </div>
    </div>
  </div>
</template>
