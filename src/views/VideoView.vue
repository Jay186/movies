<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useProjectStore } from '../stores/project'
import { api } from '../services/api'
import {
  confirmDialog, toast, toastInfo, toastSuccess, toastWarn, toastError,
} from '../services/dialog'
import { VIDEO_ENGINES, getVideoEngine, engineCostText } from '../data/videoEngines'
import { ASPECT_RATIO_OPTIONS } from '../constants/app'

const store = useProjectStore()

const settingsOpen = ref(false)
const settingsRef = ref(null)
function onDocClick(e) {
  if (settingsOpen.value && settingsRef.value && !settingsRef.value.contains(e.target)) {
    settingsOpen.value = false
  }
}
function onDocEsc(e) {
  if (e.key === 'Escape') settingsOpen.value = false
}
onMounted(() => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onDocEsc)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onDocEsc)
})

const allShots = computed(() => store.storyboardScenes.flatMap((s) => s.shots))
const displayVideoUrl = (shot) => shot.videoUrl || ''
const hasDisplayVideo = (shot) => !!(shot.videoUrl || shot.videoGenerated)
const playableCount = computed(() => allShots.value.filter((s) => hasDisplayVideo(s)).length)
const shotVideoCount = computed(
  () => allShots.value.filter((s) => !!(s.videoUrl || s.videoGenerated)).length
)
const generatedCount = playableCount
const batchGenerating = computed(() => store.generatingVideoIds.length > 0)
const generatedPercent = computed(() => {
  if (!allShots.value.length) return 0
  return Math.round((playableCount.value / allShots.value.length) * 100)
})
const shotAlerts = (shot) => store.alertsForShot(shot.id)
const shotErrAlerts = (shot) => shotAlerts(shot).filter((a) => a.level === 'error')
const alertsTip = (shot) => shotAlerts(shot).map((a) => `[${a.source}] ${a.message}`).join('\n')
const unattachedAlerts = computed(() => store.alertsUnattached())
const unattachedTip = computed(() =>
  unattachedAlerts.value.map((a) => `[${a.source}] ${a.message}`).join('\n'))
async function dismissOneUnattached() {
  const list = unattachedAlerts.value
  if (!list.length) return
  const ok = await confirmDialog({
    title: `标记 ${list.length} 条告警为已处置`,
    description: `这批告警未关联到具体镜头或场景（多为历史数据或集级问题），共 ${list.length} 条。仅记录「已知悉」，不会重跑任何生成。`,
    confirmText: `标记 ${list.length} 条已处置`,
    cancelText: '先不标',
    tone: 'warn',
  })
  if (!ok) return
  for (const a of list) await store.resolveAlerts({ id: a.id })
}
const alertSources = computed(() => {
  const set = new Set(store.systemAlerts.map((a) => String(a.source || '').trim()).filter(Boolean))
  return [...set].sort()
})
const alertSourceSuffix = computed(() =>
  alertSources.value.length ? `（${alertSources.value.join(' / ')}）` : '')
async function dismissShotAlerts(shot) {
  const n = shotAlerts(shot).length
  if (!n) return
  const ok = await confirmDialog({
    title: `标记镜 ${shot.shotNumber || shot.id} 的 ${n} 条告警为已处置`,
    description: '仅记录「已知悉」，不会重跑任何生成。如需真正修好，重生该镜即可。',
    confirmText: `标记 ${n} 条已处置`,
    cancelText: '先不标',
    tone: 'warn',
  })
  if (!ok) return
  await store.resolveAlerts({ shotId: shot.id })
}
async function dismissOneAlert(a) {
  await store.resolveAlerts({ id: a.id })
}
let alertPoll = null

const videoEngine = computed(() => getVideoEngine(store.videoModel))
const ratioShort = computed(() => {
  const opt = ASPECT_RATIO_OPTIONS.find((o) => o.value === store.aspectRatio)
  return opt ? opt.label : '16:9'
})

const previewAspect = computed(() => ratioShort.value.replace(':', ' / '))

const PREVIEW_SIZE_KEY = 'storyboard.previewSize'
const previewSize = ref(localStorage.getItem(PREVIEW_SIZE_KEY) || 'medium')
watch(previewSize, (v) => localStorage.setItem(PREVIEW_SIZE_KEY, v))

const ratioHW = computed(() => {
  const [w, h] = String(ratioShort.value).split(':').map(Number)
  return w > 0 && h > 0 ? h / w : 16 / 9
})

const orientation = computed(() =>
  ratioHW.value >= 1.15 ? 'portrait' : ratioHW.value >= 0.9 ? 'square' : 'landscape'
)

const PREVIEW_LAYOUT_KEY = 'storyboard.previewLayout'
const previewLayout = ref(
  localStorage.getItem(PREVIEW_LAYOUT_KEY) || (orientation.value === 'portrait' ? 'list' : 'grid')
)
watch(previewLayout, (v) => localStorage.setItem(PREVIEW_LAYOUT_KEY, v))
const isList = computed(() => previewLayout.value === 'list')
const PREVIEW_LAYOUTS = [
  { key: 'grid', label: '网格', tip: '卡片按画面比例铺开并排，一屏看到最多镜头；适合横屏项目' },
  { key: 'list', label: '列表', tip: '缩略图在左、信息与操作在右，一行一张；适合竖屏项目' },
]

const ROW_H_PX = { large: 152, medium: 124, small: 100 }
const rowH = computed(() => ROW_H_PX[previewSize.value] ?? ROW_H_PX.medium)
const thumbH = computed(() => rowH.value - 18)

const LIST_INFO_MIN_W = 190 
const listMinW = computed(
  () => Math.round(thumbH.value / ratioHW.value) + LIST_INFO_MIN_W + 30
)
const LIST_COLS = 'grid-cols-1 sm:grid-cols-[repeat(auto-fill,minmax(var(--list-min),1fr))]'

const previewBoxStyle = computed(() => {
  const s = { aspectRatio: previewAspect.value }
  if (isList.value) s.height = `${thumbH.value}px`
  return s
})

const CARD_MIN_PX = {
  portrait: { large: 200, medium: 180, small: 160 },
  square: { large: 300, medium: 250, small: 205 },
  landscape: { large: 420, medium: 340, small: 272 },
}
const cardMin = computed(() => {
  const m = CARD_MIN_PX[orientation.value]
  return m[previewSize.value] ?? m.medium
})

const AUTO_COLS = 'sm:grid-cols-[repeat(auto-fill,minmax(var(--card-min),1fr))]'
const PREVIEW_SIZES = [
  { key: 'large', label: '大', base: 'grid-cols-1', desc: '逐镜审表演' },
  { key: 'medium', label: '中', base: 'grid-cols-2', desc: '画面与密度兼顾' },
  { key: 'small', label: '小', base: 'grid-cols-3', desc: '一屏扫最多镜' },
]
const previewCols = computed(() => {
  if (isList.value) return LIST_COLS
  const sz = PREVIEW_SIZES.find((x) => x.key === previewSize.value) || PREVIEW_SIZES[1]
  return `${sz.base} ${AUTO_COLS}`
})
const gridStyle = computed(() => ({
  '--card-min': `${cardMin.value}px`,
  '--list-min': `${listMinW.value}px`,
}))

function sizeTip(key) {
  const desc = (PREVIEW_SIZES.find((x) => x.key === key) || {}).desc || ''
  if (isList.value) {
    const rh = ROW_H_PX[key] ?? ROW_H_PX.medium
    const th = rh - 18
    const tw = Math.round(th / ratioHW.value)
    return `行高 ${rh}px，缩略图 ${tw} × ${th}px，${desc}（当前 ${ratioShort.value}）`
  }
  const m = CARD_MIN_PX[orientation.value]
  return `单卡约 ${m[key] ?? m.medium}px 宽，${desc}（当前项目比例 ${ratioShort.value}）`
}

const sizeGroupLabel = computed(() => (isList.value ? '行高' : '预览尺寸'))

const shotFilter = ref('all')
const shotStates = computed(() =>
  allShots.value.map((shot) => {
    const shotVideo = !!(shot.videoUrl || shot.videoGenerated)
    return { shot, shotVideo, hasVideo: shotVideo }
  })
)
const filterCounts = computed(() => ({
  all: shotStates.value.length,
  pending: shotStates.value.filter((x) => !x.hasVideo).length,
  done: shotStates.value.filter((x) => x.shotVideo).length,
}))
const visibleShots = computed(() => {
  const list = shotStates.value
  if (shotFilter.value === 'pending') return list.filter((x) => !x.hasVideo).map((x) => x.shot)
  if (shotFilter.value === 'done') return list.filter((x) => x.shotVideo).map((x) => x.shot)
  return list.map((x) => x.shot)
})

const shotFilterChips = computed(() => [
  { key: 'all', label: '全部', n: filterCounts.value.all, activeClass: 'bg-bg-elevated text-text-primary', tip: '全部镜头' },
  { key: 'pending', label: '未出片', n: filterCounts.value.pending, activeClass: 'bg-bg-elevated text-text-primary', tip: '本镜还没有成片' },
  { key: 'done', label: '单独出片', n: filterCounts.value.done, activeClass: 'bg-ok/15 text-ok ring-1 ring-inset ring-ok/25', tip: '本镜已独立生成视频' },
])

const multiSelect = ref(false)
const selectedShotIds = ref([])
const deleting = ref(false)
const selectedSet = computed(() => new Set(selectedShotIds.value))
const selectedCount = computed(() => selectedShotIds.value.length)

function isSelectable(shot) {
  return hasDisplayVideo(shot) && !store.generatingVideoIds.includes(shot.id)
}
function enterMultiSelect() {
  settingsOpen.value = false 
  multiSelect.value = true
}
function exitMultiSelect() {
  multiSelect.value = false
  selectedShotIds.value = []
}
function toggleMultiSelect() {
  multiSelect.value ? exitMultiSelect() : enterMultiSelect()
}
function toggleShotSelect(shotId) {
  const i = selectedShotIds.value.indexOf(shotId)
  if (i >= 0) selectedShotIds.value.splice(i, 1)
  else selectedShotIds.value.push(shotId)
}
function onCardClick(shot) {
  if (multiSelect.value) {
    if (isSelectable(shot)) toggleShotSelect(shot.id)
    return
  }
  if (hasDisplayVideo(shot) && !store.generatingVideoIds.includes(shot.id)) openPlayerAtShot(shot.id)
}
function selectAllVisible() {
  const set = new Set(selectedShotIds.value)
  for (const s of visibleShots.value) if (isSelectable(s)) set.add(s.id)
  selectedShotIds.value = [...set]
}
function invertVisible() {
  const cur = new Set(selectedShotIds.value)
  for (const s of visibleShots.value) {
    if (!isSelectable(s)) continue
    cur.has(s.id) ? cur.delete(s.id) : cur.add(s.id)
  }
  selectedShotIds.value = [...cur]
}

const shotLabel = (id) => {
  const s = allShots.value.find((x) => Number(x.id) === Number(id))
  return s ? (s.shotNumber || s.displayId || s.id) : `#${id}`
}
function buildDeleteConfirm(shotIds) {
  const nums = shotIds.map((id) => shotLabel(id))
  const shown = nums.slice(0, 10).join('、')
  const more = nums.length > 10 ? ` …等共 ${nums.length} 镜` : ''
  const details = [{ label: '镜号', value: `${shown}${more}` }]
  details.push({ label: '文件去向', value: '移入服务端回收站，可手工找回' })

  return {
    title: `删除 ${shotIds.length} 个镜头的成片`,
    description: '删除后这些镜头退回未出片状态，可重新出片。',
    details,
    confirmText: `删除 ${shotIds.length} 个成片`,
    cancelText: '保留',
    tone: 'danger',
  }
}
function summarizeDelete(r) {
  const n = r?.shots?.length ?? 0
  const files = r?.movedFiles ?? 0
  const message = `已删除 ${n} 个镜头的成片`
  const lines = [`${files} 个文件移入回收站`]
  const alerts = r?.alertsCleared ?? 0
  if (alerts) lines.push(`顺手销掉 ${alerts} 条已失效告警`)
  const skipped = r?.skipped || []
  if (skipped.length) {
    lines.push(`有 ${skipped.length} 项未处理：`)
    lines.push(...skipped.slice(0, 10).map((s) => `· 镜 ${s.shotId}：${s.reason}`))
  }
  return { message, detail: lines.join('\n'), type: skipped.length ? 'warn' : 'success' }
}

function pruneSelection() {
  selectedShotIds.value = selectedShotIds.value.filter((id) => {
    const s = allShots.value.find((x) => Number(x.id) === Number(id))
    return !!s && hasDisplayVideo(s)
  })
}

async function deleteSingleShotVideo(shot) {
  if (store.generatingVideoIds.includes(shot.id)) return
  const epId = store.currentEpisodeId
  if (!epId) { toastError('当前没有选中的集'); return }
  if (!(await confirmDialog(buildDeleteConfirm([shot.id])))) return
  deleting.value = true
  try {
    const r = await api.deleteShotVideo(epId, shot.id)
    await refreshEpisodeData()
    pruneSelection()
    const s = summarizeDelete(r)
    toast(s.message, s.type, { detail: s.detail })
    if (!allShots.value.some((s) => hasDisplayVideo(s))) exitMultiSelect()
  } catch (e) {
    toastError('删除失败', { detail: String(e?.message || e) })
  } finally {
    deleting.value = false
  }
}

async function deleteSelectedShotVideos() {
  const ids = [...selectedShotIds.value]
  if (!ids.length) return
  const epId = store.currentEpisodeId
  if (!epId) { toastError('当前没有选中的集'); return }
  if (!(await confirmDialog(buildDeleteConfirm(ids)))) return
  deleting.value = true
  try {
    const r = await api.deleteShotsVideo(epId, ids)
    await refreshEpisodeData()
    selectedShotIds.value = []
    const s = summarizeDelete(r)
    toast(s.message, s.type, { detail: s.detail })
    if (!allShots.value.some((s) => hasDisplayVideo(s))) exitMultiSelect()
  } catch (e) {
    toastError('删除失败', { detail: String(e?.message || e) })
  } finally {
    deleting.value = false
  }
}

async function generateShot(shotId, overrides = {}) {
  const r = await store.generateShotVideoByModel(shotId, overrides)
  if (r?.success) {
    store.loadAlerts()
    setTimeout(() => store.loadAlerts(), 6000)
    setTimeout(() => store.loadAlerts(), 20000)
  }
  return r
}

async function generateAllVideos() {
  if (batchGenerating.value) return
  const pending = allShots.value.filter((s) => !hasDisplayVideo(s))
  if (pending.length === 0) {
    toastInfo('所有镜头已生成')
    return
  }
  const totalSec = pending.reduce((sum, s) => sum + (Number(s.duration) || 5), 0)
  const eng = videoEngine.value
  const ok = await confirmDialog({
    title: `批量出片 ${pending.length} 个镜头`,
    description: '任务队列执行（最多 2 个并行，其余排队），可刷新页面，进度实时可查。',
    details: [
      { label: '镜头数', value: `${pending.length} 个（共约 ${totalSec}s）` },
      { label: '引擎', value: eng.label },
      { label: '计费', value: engineCostText(eng), tone: 'warn' },
    ],
    confirmText: '开始批量出片',
    cancelText: '先不生成',
    tone: 'warn',
  })
  if (!ok) return
  let failed = 0
  for (const shot of pending) {
    if (batchGenerating.value && store.generatingVideoIds.includes(shot.id)) continue
    const r = await generateShot(shot.id, { skipConfirm: true })
    if (!r?.success && !r?.cancelled) failed++
  }
  const remain = allShots.value.filter((s) => !hasDisplayVideo(s)).length
  if (failed > 0 || remain > 0) toastWarn(`批量生成完成，仍有 ${remain} 个镜头未成功`, { detail: '可在卡片上单独重试失败的镜头' })
}

function generateSingle(shotId) {
  generateShot(shotId)
}

async function refreshEpisodeData() {
  const epId = store.currentEpisodeId
  if (!epId) return
  try { await store.loadEpisode(epId) } catch (e) { console.warn('[刷新集数据] 失败：', e?.message || e) }
  try { await store.loadAlerts?.() } catch {  }
}

const playModal = ref(false)
const playingIndex = ref(0)
const playVideoRef = ref(null)
const playList = computed(() => allShots.value.filter((s) => displayVideoUrl(s)))
const playingShot = computed(() => playList.value[playingIndex.value] || null)
function syncPlayerToShot() {
  const shot = playingShot.value
  const v = playVideoRef.value
  if (!v || !shot) return
  const url = displayVideoUrl(shot)
  if (!url) return
  let abs = ''
  try { abs = new URL(url, window.location.href).href } catch { return }
  if (v.src !== abs) return 
  v.play?.().catch(() => {})
}
function jumpTo(idx) {
  playingIndex.value = idx
  syncPlayerToShot()
}
function openPlayer() {
  if (!playList.value.length) {
    toastInfo('还没有已生成的镜头视频，请先出片')
    return
  }
  playingIndex.value = 0
  playModal.value = true
  setTimeout(() => playVideoRef.value?.play?.().catch(() => {}), 100)
}
function openPlayerAtShot(shotId) {
  const idx = playList.value.findIndex((s) => s.id === shotId)
  if (idx < 0) {
    toastInfo('该镜头还没有生成视频，请先出片')
    return
  }
  playingIndex.value = idx
  playModal.value = true
  setTimeout(() => playVideoRef.value?.play?.().catch(() => {}), 100)
}
function previewSeekPlay(evt) {
  evt.target.play()
}
function closePlayer() {
  playModal.value = false
  playVideoRef.value?.pause?.()
}
function prevShot() {
  if (playingIndex.value > 0) {
    playingIndex.value--
    syncPlayerToShot()
  }
}
function nextShot() {
  if (playingIndex.value < playList.value.length - 1) {
    playingIndex.value++
    syncPlayerToShot()
  }
}
function onPlayEnded() {
  if (playingIndex.value < playList.value.length - 1) {
    playingIndex.value++
    syncPlayerToShot()
  } else {
    closePlayer()
  }
}

const composing = ref(false)
const composeResult = ref(null)
const fadeEnabled = ref(true)
const selectedBgm = ref('')
const bgmFiles = ref([])
async function loadBgmList() {
  try {
    const r = await api.getBgmList()
    bgmFiles.value = r?.files || []
    if (selectedBgm.value && !bgmFiles.value.includes(selectedBgm.value)) selectedBgm.value = ''
  } catch {  }
}
onMounted(loadBgmList)
async function handleCompose() {
  if (composing.value) return
  if (!playList.value.length) {
    toastInfo('还没有已生成的镜头视频，请先出片')
    return
  }
  composing.value = true
  composeResult.value = null
  try {
    const r = await api.composeVideo({
      episodeId: store.currentEpisodeId,
      fade: fadeEnabled.value,
      bgm: selectedBgm.value,
    })
    if (r?.success && r.url) {
      composeResult.value = r
      loadCompositions()
      const missing = r.missingShots || []
      if (missing.length) {
        const shown = missing.slice(0, 10).join('、')
        const more = missing.length > 10 ? ` …等共 ${missing.length} 镜` : ''
        toastWarn(`成片已生成，但有 ${missing.length} 镜尚未出片被跳过`, {
          detail: `跳过：${shown}${more}\n缺镜会导致剧情断层，建议补出后再合成。`,
        })
      } else {
        toastSuccess('成片合成完成')
      }
    } else {
      toastError('成片合成失败', { detail: String(r?.error || '未知错误') })
    }
  } catch (e) {
    toastError('成片合成失败', { detail: String(e.message || e) })
  } finally {
    composing.value = false
  }
}
function closeComposeResult() {
  composeResult.value = null
}

// ── 成片历史：拼片产物已入服务端库，刷新后仍可回放下载 ──
const compositions = ref([])
async function loadCompositions() {
  if (!store.currentEpisodeId) return
  try {
    const r = await api.getCompositions(store.currentEpisodeId)
    compositions.value = r?.compositions || []
  } catch {  }
}
function compositionTime(row) {
  const d = new Date(String(row.created_at || '').replace(' ', 'T'))
  return Number.isNaN(d.getTime()) ? String(row.created_at || '') : d.toLocaleString('zh-CN', { hour12: false })
}
const composeFilename = computed(() => {
  const stamp = new Date()
  const s = `${stamp.getFullYear()}${String(stamp.getMonth() + 1).padStart(2, '0')}${String(stamp.getDate()).padStart(2, '0')}_${String(stamp.getHours()).padStart(2, '0')}${String(stamp.getMinutes()).padStart(2, '0')}`
  return `成片_${store.projectTitle || '项目'}_${s}.mp4`
})

function onGlobalKeydown(e) {
  if (e.key === 'Escape') {
    if (composeResult.value) closeComposeResult()
    else if (playModal.value) closePlayer()
    else if (multiSelect.value) exitMultiSelect()
  }
}
onMounted(() => {
  window.addEventListener('keydown', onGlobalKeydown)
  store.loadAlerts()
  loadCompositions()
  alertPoll = setInterval(() => {
    if (store.generatingVideoIds.length || store.systemAlertCount) store.loadAlerts()
  }, 8000)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown)
  playVideoRef.value?.pause?.()
  if (alertPoll) { clearInterval(alertPoll); alertPoll = null }
})
</script>

<template>
  <div class="flex h-full w-full flex-col bg-bg-primary">
    <div
      v-if="store.systemAlertCount"
      class="flex shrink-0 items-start gap-3 border-b border-warn/25 bg-warn/[0.07] px-6 py-2.5"
    >
      <svg class="mt-px h-4 w-4 shrink-0 text-warn" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
      </svg>
      <span class="min-w-0 flex-1 text-[12px] leading-relaxed text-warn">
        有 <b class="font-mono">{{ store.systemAlertCount }}</b> 条系统告警未处置{{ alertSourceSuffix }}：多为生成/回写环节的异常提示
      </span>
      <button
        v-if="unattachedAlerts.length"
        class="shrink-0 rounded-full border border-warn/40 px-2.5 py-0.5 text-micro text-warn transition hover:bg-warn/15"
        :title="unattachedTip"
        @click="dismissOneUnattached()"
      >处置未关联的 {{ unattachedAlerts.length }} 条</button>
      <button
        class="shrink-0 rounded-full border border-warn/40 px-2.5 py-0.5 text-micro text-warn transition hover:bg-warn/15"
        @click="store.loadAlerts()"
      >刷新</button>
    </div>

    <div class="shrink-0 border-b border-border/70 px-6 py-3.5">
      <div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div class="flex min-w-0 flex-1 items-center gap-5">
          <h2 class="flex shrink-0 items-center gap-2.5 text-[15px] font-medium text-text-primary">
            短片创作
            <span
              v-if="allShots.length > 0 && shotVideoCount === allShots.length"
              class="inline-flex items-center gap-1 rounded-full bg-ok/15 px-2 py-0.5 text-micro font-medium text-ok"
            >
              <svg class="h-2.5 w-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" /></svg>
              全部出片
            </span>
          </h2>

          <div class="flex min-w-0 items-center gap-3">
            <span
              class="shrink-0 font-mono text-[13px]"
              :title="`可播放 ${playableCount} 镜；本镜独立出片 ${shotVideoCount} 镜`"
            >
              <span class="font-medium text-text-primary">{{ playableCount }}</span><span class="text-text-muted">/{{ allShots.length }}</span>
            </span>
            <div class="h-1.5 w-[140px] shrink-0 overflow-hidden rounded-full bg-bg-hover">
              <div
                class="h-full rounded-full bg-accent transition-all duration-500"
                :style="{ width: generatedPercent + '%' }"
              ></div>
            </div>
            <span
              class="hidden shrink-0 font-mono text-micro text-text-muted sm:inline"
              title="全片预计时长"
            >{{ store.totalDuration }}s</span>
          </div>
        </div>

        <div class="flex shrink-0 flex-wrap items-center gap-2">
          <div
            class="flex h-8 items-center rounded-control border px-2.5"
            :class="!videoEngine.isDefault ? 'border-accent/40 bg-accent/10' : 'border-border bg-bg-card'"
            :title="`出片引擎：${videoEngine.label} · ${videoEngine.desc}`"
          >
            <select
              v-model="store.videoModel"
              class="cursor-pointer bg-transparent text-[12px] outline-none"
              :class="!videoEngine.isDefault ? 'text-accent' : 'text-text-primary'"
            >
              <option v-for="eng in VIDEO_ENGINES" :key="eng.value" :value="eng.value">
                {{ eng.label }}
              </option>
            </select>
          </div>

          <div ref="settingsRef" class="relative">
            <button
              class="relative flex h-8 w-8 items-center justify-center rounded-control border transition"
              :class="settingsOpen
                ? 'border-border-light bg-bg-hover text-text-primary'
                : 'border-border bg-bg-card text-text-secondary hover:border-border-light hover:bg-bg-hover hover:text-text-primary'"
              title="出片设置：画面比例 / 背景音乐 / 转场"
              @click="settingsOpen = !settingsOpen"
            >
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
              <span
                v-if="selectedBgm || fadeEnabled"
                class="absolute right-[5px] top-[5px] h-1.5 w-1.5 rounded-full bg-accent"
                :title="`已配置：${[selectedBgm && '背景音乐', fadeEnabled && '交叉淡化转场'].filter(Boolean).join(' / ')}`"
              ></span>
            </button>

            <div
              v-if="settingsOpen"
              class="absolute right-0 top-[calc(100%+6px)] z-40 w-[320px] overflow-hidden rounded-panel border border-border bg-bg-card shadow-pop animate-fade-up"
            >
              <div class="divide-y divide-border/60">
                <div class="flex min-h-[44px] items-center justify-between gap-3 px-3.5">
                  <span class="text-[12px] text-text-secondary">画面比例</span>
                  <span
                    class="rounded-full bg-bg-secondary px-2.5 py-0.5 font-mono text-micro text-text-secondary"
                    :title="`项目级设置（在剧集页顶部修改）：出片统一 ${ratioShort}，与分镜图参考一致`"
                  >{{ ratioShort }}</span>
                </div>
                <div class="flex min-h-[44px] items-center justify-between gap-3 px-3.5">
                  <span class="text-[12px] text-text-secondary">背景音乐</span>
                  <div class="flex items-center gap-1.5">
                    <select
                      v-model="selectedBgm"
                      class="h-7 max-w-[160px] rounded-control border border-border bg-bg-secondary px-2 text-micro text-text-secondary outline-none transition hover:border-border-light"
                      title="选择已上传的背景音乐（支持 mp3 / wav / m4a 等音频格式）"
                    >
                      <option value="">无 BGM</option>
                      <option v-for="f in bgmFiles" :key="f" :value="f">{{ f }}</option>
                    </select>
                    <button
                      class="flex h-7 w-7 shrink-0 items-center justify-center rounded-control border border-border text-text-muted transition hover:border-border-light hover:text-text-primary"
                      title="刷新 BGM 列表"
                      @click="loadBgmList"
                    >
                      <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                    </button>
                  </div>
                </div>
                <div class="flex min-h-[44px] items-center justify-between gap-3 px-3.5 py-2">
                  <div>
                    <div class="text-[12px] text-text-secondary">交叉淡化转场</div>
                    <div class="mt-px text-micro text-text-muted">镜头间 0.5 秒淡化，关闭则硬切</div>
                  </div>
                  <button
                    class="relative flex h-4 w-7 shrink-0 items-center rounded-full transition"
                    :class="fadeEnabled ? 'bg-accent' : 'bg-border-strong'"
                    role="switch"
                    :aria-checked="fadeEnabled"
                    title="镜头间 0.5 秒交叉淡化转场（关闭则为硬切）"
                    @click="fadeEnabled = !fadeEnabled"
                  >
                    <span class="absolute h-3 w-3 rounded-full bg-white transition-all" :class="fadeEnabled ? 'left-[15px]' : 'left-0.5'"></span>
                  </button>
                </div>
              </div>

              <div class="border-t border-border/60 bg-bg-secondary/50 px-3.5 py-2 text-micro leading-relaxed text-text-muted">
                当前引擎 {{ videoEngine.label }}（{{ videoEngine.desc }}），{{ engineCostText(videoEngine) }}
              </div>
            </div>
          </div>

          <span class="mx-0.5 h-4 w-px bg-border"></span>

          <button
            class="flex h-8 items-center gap-1.5 rounded-control border px-3 text-[12px] transition disabled:cursor-not-allowed disabled:opacity-40"
            :class="composing
              ? 'border-accent/40 bg-accent/10 text-accent'
              : 'border-border bg-bg-card text-text-secondary hover:border-border-light hover:bg-bg-hover hover:text-text-primary'"
            :disabled="composing"
            title="把已生成的镜头合成为一部完整短片"
            @click="handleCompose"
          >
            <svg v-if="!composing" class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" /></svg>
            <svg v-else class="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
            {{ composing ? '合成中...' : '保存至成片' }}
          </button>

          <button
            class="flex h-8 items-center gap-2 rounded-control bg-accent px-4 text-[12px] font-medium text-black transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="batchGenerating"
            title="为所有未出片的镜头批量生成视频"
            @click="generateAllVideos"
          >
            <svg v-if="!batchGenerating" class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            <svg v-else class="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
            {{ batchGenerating ? '批量生成中...' : '批量生成短片' }}
          </button>
        </div>
      </div>


    </div>

    <div v-if="composeResult" class="shrink-0 px-6 pt-3">
      <div class="overflow-hidden rounded-card border border-accent/30 bg-bg-card shadow-card">
        <div class="flex items-center justify-between gap-3 border-b border-border bg-accent/[0.06] px-4 py-2.5">
          <div class="flex min-w-0 items-center gap-2.5">
            <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/20 text-accent">
              <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" /></svg>
            </span>
            <span class="shrink-0 text-[13px] font-medium text-text-primary">成片已合成</span>
            <span class="truncate rounded-full bg-bg-secondary px-2.5 py-0.5 font-mono text-micro text-text-secondary">
              {{ composeResult.shotCount }} 镜 · {{ composeResult.totalSeconds }}s · {{ composeResult.fade ? '交叉淡化' : '硬切' }}{{ composeResult.bgmUsed ? ` · BGM ${composeResult.bgmUsed}` : '' }}
            </span>
          </div>
          <button
            class="flex h-7 w-7 shrink-0 items-center justify-center rounded-control border border-border text-text-muted transition hover:border-danger/40 hover:bg-danger/10 hover:text-danger"
            title="关闭（成片文件仍保留）"
            @click="closeComposeResult"
          >
            <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <div class="flex justify-center bg-black">
          <video :src="composeResult.url" controls class="max-h-[62vh] w-full object-contain" />
        </div>
        <div class="flex items-center justify-between gap-3 border-t border-border px-4 py-2.5">
          <span class="text-micro text-text-muted">共 {{ composeResult.shotCount }} 个镜头按顺序拼接</span>
          <a
            :href="composeResult.url"
            :download="composeFilename"
            class="flex h-8 shrink-0 items-center gap-1.5 rounded-control bg-accent px-3.5 text-[12px] font-medium text-black transition hover:bg-accent-hover"
          >
            <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
            下载成片
          </a>
        </div>
      </div>
    </div>

    <div v-if="compositions.length" class="shrink-0 px-6 pt-1 pb-2">
      <div class="rounded-card border border-border/60 bg-bg-card">
        <div class="flex items-center justify-between border-b border-border/60 px-4 py-2">
          <span class="text-[12px] font-medium text-text-secondary">历史成片（{{ compositions.length }}）</span>
          <button
            class="rounded-control px-2 py-0.5 text-micro text-text-muted transition hover:bg-bg-hover hover:text-text-primary"
            @click="loadCompositions"
          >刷新</button>
        </div>
        <div class="divide-y divide-border/50">
          <div
            v-for="c in compositions"
            :key="c.id"
            class="flex items-center gap-3 px-4 py-2"
          >
            <video :src="c.url" controls preload="metadata" class="h-12 w-20 shrink-0 rounded-control bg-black object-cover" />
            <div class="min-w-0 flex-1">
              <div class="truncate font-mono text-micro text-text-primary">{{ c.url.split('/').pop() }}</div>
              <div class="mt-0.5 text-micro text-text-muted">{{ c.shot_count }} 镜 · {{ c.total_seconds }}s · {{ compositionTime(c) }}</div>
            </div>
            <a
              :href="c.url"
              download
              class="flex h-7 shrink-0 items-center gap-1 rounded-control border border-border px-2.5 text-micro text-text-secondary transition hover:border-border-light hover:text-text-primary"
            >
              <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
              下载
            </a>
          </div>
        </div>
      </div>
    </div>

    <div class="flex-1 overflow-y-auto px-6 py-4">
      <div v-if="allShots.length === 0" class="flex h-full flex-col items-center justify-center gap-4">
        <div class="flex h-16 w-16 items-center justify-center rounded-panel border border-dashed border-border-strong/60 bg-bg-secondary/60">
          <svg class="h-7 w-7 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        </div>
        <div class="text-center">
          <p class="text-[13px] text-text-secondary">暂无镜头</p>
          <p class="mt-1 text-[12px] text-text-muted">请先在分镜页完成分镜脚本</p>
        </div>
      </div>

      <template v-else>
      <div class="mb-4 flex flex-wrap items-center gap-2">
        <div class="flex items-center gap-0.5 rounded-full bg-bg-card p-1">
          <button
            v-for="f in shotFilterChips"
            :key="f.key"
            class="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] transition"
            :class="[
              shotFilter === f.key ? f.activeClass : 'text-text-secondary hover:bg-bg-hover/60 hover:text-text-primary',
              f.n === 0 && shotFilter !== f.key ? 'opacity-45' : '',
            ]"
            :title="f.tip"
            @click="shotFilter = f.key"
          >
            {{ f.label }}
            <span class="font-mono text-micro opacity-70">{{ f.n }}</span>
          </button>
        </div>

        <div class="ml-auto flex flex-wrap items-center gap-3">
          <div class="flex items-center gap-1">
            <button
              class="flex h-7 items-center gap-1.5 rounded-control px-2.5 text-micro transition disabled:cursor-not-allowed disabled:opacity-40"
              :class="multiSelect
                ? 'bg-accent/15 text-accent hover:bg-accent/25'
                : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'"
              :disabled="!playableCount"
              :title="multiSelect ? '退出多选（也可按 Esc）' : '进入多选，勾选多个镜头批量删除成片'"
              @click="toggleMultiSelect"
            >
              <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" /></svg>
              {{ multiSelect ? '多选中' : '多选' }}
            </button>
            <button
              class="flex h-7 items-center gap-1.5 rounded-control px-2.5 text-micro text-text-secondary transition hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
              :disabled="!playList.length"
              title="按顺序连续播放所有已生成镜头"
              @click="openPlayer"
            >
              <svg class="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
              连续播放
            </button>
          </div>

          <span class="h-4 w-px bg-border"></span>

          <div class="flex items-center gap-2">
            <span class="text-micro text-text-muted">视图</span>
            <div class="flex items-center gap-0.5 rounded-full bg-bg-card p-1">
              <button
                v-for="ly in PREVIEW_LAYOUTS"
                :key="ly.key"
                class="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-micro transition"
                :class="previewLayout === ly.key
                  ? 'bg-accent/15 font-medium text-accent'
                  : 'text-text-secondary hover:bg-bg-hover/60 hover:text-text-primary'"
                :title="ly.tip"
                @click="previewLayout = ly.key"
              >
                <svg v-if="ly.key === 'grid'" class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 5h6v6H4zM14 5h6v6h-6zM4 15h6v6H4zM14 15h6v6h-6z" />
                </svg>
                <svg v-else class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h4v12H4zM12 7h8M12 12h8M12 17h8" />
                </svg>
                {{ ly.label }}
              </button>
            </div>
          </div>

          <div class="flex items-center gap-2">
            <span class="text-micro text-text-muted">{{ sizeGroupLabel }}</span>
            <div class="flex items-center gap-0.5 rounded-full bg-bg-card p-1">
              <button
                v-for="sz in PREVIEW_SIZES"
                :key="sz.key"
                class="rounded-full px-3 py-1.5 text-micro transition"
                :class="previewSize === sz.key
                  ? 'bg-accent/15 font-medium text-accent'
                  : 'text-text-secondary hover:bg-bg-hover/60 hover:text-text-primary'"
                :title="sizeTip(sz.key)"
                @click="previewSize = sz.key"
              >{{ sz.label }}</button>
            </div>
          </div>
        </div>
      </div>

      <div
        v-if="visibleShots.length === 0"
        class="flex flex-col items-center justify-center gap-3 py-24"
      >
        <div class="flex h-12 w-12 items-center justify-center rounded-full bg-bg-card">
          <svg class="h-5 w-5 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
          </svg>
        </div>
        <p class="text-[13px] text-text-secondary">当前筛选下没有镜头</p>
        <button
          class="h-8 rounded-control border border-border px-4 text-[12px] text-text-secondary transition hover:border-border-light hover:text-text-primary"
          @click="shotFilter = 'all'"
        >查看全部 {{ filterCounts.all }} 镜</button>
      </div>

      <div v-else class="grid gap-3" :class="previewCols" :style="gridStyle">
        <div
          v-for="shot in visibleShots"
          :key="shot.id"
          class="group relative flex overflow-hidden rounded-panel border bg-bg-card transition-all duration-200"
          :class="[
            isList ? 'flex-row items-stretch gap-3 p-2' : 'flex-col',
            'border-border/50 shadow-card hover:border-border/90 hover:shadow-card-hover',
            selectedSet.has(shot.id) ? 'border-accent/60 ring-2 ring-inset ring-accent/45' : '',
          ]"
          @click="onCardClick(shot)"
        >
          <div
            class="relative shrink-0 overflow-hidden bg-black"
            :style="previewBoxStyle"
            :class="[
              isList ? 'rounded-control ring-1 ring-inset ring-white/[0.07]' : '',
              isSelectable(shot) ? 'cursor-pointer' : '',
            ]"
          >
            <video
              v-if="displayVideoUrl(shot)"
              :src="displayVideoUrl(shot)"
              class="h-full w-full object-cover"
              muted
              loop
              preload="auto"
              @mouseenter="previewSeekPlay($event)"
              @mouseleave="$event.target.pause()"
            />
            <div v-else class="flex h-full w-full flex-col items-center justify-center gap-2 bg-bg-secondary">
              <span class="flex h-10 w-10 items-center justify-center rounded-full border border-dashed border-border-strong/70">
                <svg class="h-4 w-4 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </span>
              <span class="text-micro text-text-muted">未出片</span>
            </div>

            <div v-if="!isList" class="pointer-events-none absolute inset-x-0 top-0 z-[4] h-16 bg-gradient-to-b from-black/55 to-transparent"></div>

            <div
              v-if="hasDisplayVideo(shot) && !store.generatingVideoIds.includes(shot.id)"
              class="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center bg-black/25 opacity-0 transition group-hover:opacity-100"
            >
              <span class="flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-white ring-1 ring-inset ring-white/25 backdrop-blur-md">
                <svg class="ml-0.5 h-4 w-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
              </span>
            </div>

            <div
              v-if="store.generatingVideoIds.includes(shot.id)"
              class="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2.5 bg-black/80 backdrop-blur-sm"
            >
              <div class="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-accent"></div>
              <span class="text-[12px] font-medium text-white">出片中...</span>
              <span v-if="!isList" class="text-micro text-text-muted">约 3~15 分钟</span>
            </div>

            <button
              v-if="multiSelect && isSelectable(shot)"
              class="absolute bottom-2 left-2 z-[7] flex h-6 w-6 items-center justify-center rounded-full border transition"
              :class="selectedSet.has(shot.id)
                ? 'border-accent bg-accent text-black'
                : 'border-white/50 bg-black/55 text-transparent hover:border-white/90'"
              :title="selectedSet.has(shot.id) ? '取消选择' : '选择此镜'"
              @click.stop="toggleShotSelect(shot.id)"
            >
              <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" /></svg>
            </button>

            <div
              v-if="!isList"
              class="absolute bottom-2 right-2 rounded-full bg-black/60 px-2 py-0.5 font-mono text-micro text-white backdrop-blur-sm"
            >
              {{ shot.duration }}s
            </div>
          </div>

          <div
            :class="isList
              ? 'flex min-w-0 flex-1 flex-col justify-between gap-2'
              : 'flex items-center justify-between gap-1.5 px-2 py-1.5'"
          >
            <div class="flex min-w-0 items-center gap-1.5">
              <span class="truncate font-mono text-[12px] font-medium text-text-primary">{{ shot.shotNumber || shot.displayId || shot.id }}</span>
              <span v-if="shot.isCombat" class="shrink-0 rounded-full bg-info/15 px-1.5 py-px text-micro text-info">武戏</span>
              <span v-if="isList" class="shrink-0 font-mono text-micro text-text-muted">{{ shot.duration }}s</span>
            </div>
            <div :class="isList ? 'flex min-w-0 flex-wrap items-center gap-1.5' : ''">
              <div
                :class="isList
                  ? 'flex flex-wrap items-center gap-1'
                  : 'absolute right-2 top-2 z-[6] flex max-w-[calc(100%-16px)] flex-col items-end gap-1'"
              >
                <span
                  v-if="hasDisplayVideo(shot)"
                  class="flex h-5 items-center gap-1 rounded-full bg-black/65 px-2 text-micro font-medium text-white ring-1 ring-inset ring-white/15 backdrop-blur-sm"
                >
                  <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-ok"></span>
                  已生成
                </span>
                <span
                  v-if="shotErrAlerts(shot).length"
                  :title="alertsTip(shot)"
                  class="flex h-5 items-center gap-1 rounded-full bg-danger px-2 text-micro font-medium text-white"
                >
                  <svg class="h-3 w-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                  告警 {{ shotErrAlerts(shot).length }}
                </span>
              </div>
            </div>
            <div
              :class="isList
                ? 'flex w-full items-center justify-end gap-1'
                : 'flex shrink-0 items-center gap-1'"
            >
              <button
                v-if="!hasDisplayVideo(shot)"
                class="h-6 shrink-0 rounded-control border border-accent/40 bg-accent/10 px-2 text-micro text-accent transition hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-40"
                :disabled="store.generatingVideoIds.includes(shot.id)"
                @click.stop="generateSingle(shot.id)"
              >
                {{ store.generatingVideoIds.includes(shot.id) ? '出片中' : '出片' }}
              </button>
              <button
                v-else
                class="h-6 shrink-0 rounded-control border border-border px-2 text-micro text-text-secondary transition hover:border-border-light hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
                :disabled="store.generatingVideoIds.includes(shot.id)"
                @click.stop="generateSingle(shot.id)"
              >重出</button>

              <button
                v-if="hasDisplayVideo(shot)"
                class="h-6 shrink-0 rounded-control px-2 text-micro text-text-muted transition hover:bg-danger/10 hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"
                :disabled="store.generatingVideoIds.includes(shot.id) || deleting"
                title="删除本镜成片，镜头退回未出片"
                @click.stop="deleteSingleShotVideo(shot)"
              >删除</button>
            </div>
          </div>
        </div>
      </div>
      </template>
    </div>


    <Teleport to="body">
      <div
        v-if="multiSelect"
        class="fixed bottom-6 left-1/2 z-[70] flex max-w-[calc(100vw-48px)] -translate-x-1/2 flex-wrap items-center gap-2 rounded-panel border border-border bg-bg-card px-4 py-2.5 shadow-pop animate-fade-up"
      >
        <span class="pl-1 text-[12px] text-text-secondary">
          已选 <b class="font-mono text-text-primary">{{ selectedCount }}</b> 个
        </span>
        <span class="h-4 w-px bg-border"></span>
        <button
          class="h-8 rounded-control px-3 text-[12px] text-text-secondary transition hover:bg-bg-hover hover:text-text-primary"
          title="选中当前筛选下所有已出片、且未在出片的镜头"
          @click="selectAllVisible"
        >全选当前筛选</button>
        <button
          class="h-8 rounded-control px-3 text-[12px] text-text-secondary transition hover:bg-bg-hover hover:text-text-primary"
          title="在当前筛选范围内反选"
          @click="invertVisible"
        >反选</button>
        <button
          class="flex h-8 items-center gap-1.5 rounded-control border border-danger/40 bg-danger/10 px-3 text-[12px] font-medium text-danger transition hover:bg-danger/20 disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="!selectedCount || deleting"
          title="删除选中镜头的成片（文件移入服务端回收站，可手工找回）"
          @click="deleteSelectedShotVideos"
        >
          <svg v-if="!deleting" class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
          <svg v-else class="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
          {{ deleting ? '删除中...' : '删除选中视频' }}
        </button>
        <button
          class="h-8 rounded-control px-3 text-[12px] text-text-muted transition hover:bg-bg-hover hover:text-text-primary"
          title="退出多选（也可按 Esc）"
          @click="exitMultiSelect"
        >退出多选</button>
      </div>
    </Teleport>

    <Teleport to="body">
      <div
        v-if="playModal"
        class="fixed inset-0 z-[80] flex items-center justify-center bg-black/85 p-6 backdrop-blur-sm"
        @click.self="closePlayer"
      >
        <div class="flex w-fit min-w-[340px] max-w-[92vw] flex-col overflow-hidden rounded-shell border border-border bg-bg-card shadow-pop">
          <div class="flex shrink-0 items-center justify-between gap-3 px-4 py-2.5">
            <div class="flex min-w-0 items-center gap-3">
              <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/20 text-accent">
                <svg class="h-3 w-3" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
              </span>
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <span class="text-[13px] font-medium text-text-primary">连续播放</span>
                  <span class="rounded-full bg-bg-secondary px-2 py-0.5 font-mono text-micro text-text-secondary">
                    {{ playingIndex + 1 }} / {{ playList.length }}
                  </span>
                </div>
                <div class="mt-0.5 truncate text-micro text-text-muted">
                  镜头 {{ playingShot?.shotNumber || playingShot?.displayId || playingShot?.id }} · {{ playingShot?.duration }}s
                </div>
              </div>
            </div>
            <button
              @click="closePlayer"
              class="flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-text-muted transition hover:bg-bg-hover hover:text-text-primary"
              title="关闭"
            >
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
          <div class="relative flex items-center justify-center bg-black">
            <video
              ref="playVideoRef"
              :src="playingShot ? displayVideoUrl(playingShot) : ''"
              controls
              autoplay
              class="h-[68vh] w-auto max-w-[92vw] object-contain"
              @ended="onPlayEnded"
            ></video>
            <button
              class="absolute left-3 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white ring-1 ring-inset ring-white/20 backdrop-blur transition hover:bg-black/80 disabled:cursor-not-allowed disabled:opacity-30"
              :disabled="playingIndex === 0"
              title="上一个镜头"
              @click="prevShot"
            >
              <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" /></svg>
            </button>
            <button
              class="absolute right-3 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white ring-1 ring-inset ring-white/20 backdrop-blur transition hover:bg-black/80 disabled:cursor-not-allowed disabled:opacity-30"
              :disabled="playingIndex >= playList.length - 1"
              title="下一个镜头"
              @click="nextShot"
            >
              <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" /></svg>
            </button>
          </div>
          <div class="flex shrink-0 items-center gap-3 border-t border-border px-4 py-2.5">
            <div class="flex flex-1 gap-1">
              <button
                v-for="(shot, idx) in playList"
                :key="shot.id"
                @click="jumpTo(idx)"
                class="group relative h-1.5 flex-1 overflow-hidden rounded-full bg-bg-hover transition hover:h-2.5"
                :class="{ 'bg-accent/60': idx === playingIndex, 'bg-accent/25': idx < playingIndex }"
                :title="`镜头 ${shot.shotNumber || shot.displayId || shot.id}`"
              >
                <span v-if="idx === playingIndex" class="absolute inset-0 bg-accent/40"></span>
              </button>
            </div>
            <span class="shrink-0 text-micro text-text-muted">播完自动下一镜 · Esc 关闭</span>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
