<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { useProjectStore } from '../stores/project'
import BlockingChart from './BlockingChart.vue'
import { api } from '../services/api'
import { characterColor } from '../constants/palette'

const props = defineProps({
  shot: { type: Object, required: true },
  index: { type: Number, default: 0 },
  showVideo: { type: Boolean, default: true },
  highlighted: { type: Boolean, default: false },
})

const store = useProjectStore()
const showPromptModal = ref(false)

const isCombat = computed(() => props.shot.isCombat === 1)
async function toggleCombat() {
  const next = !isCombat.value
  try {
    await api.updateShot(store.currentEpisodeId, props.shot.id, { is_combat: next ? 1 : 0 })
    props.shot.isCombat = next ? 1 : 0
  } catch (e) {
    console.error('[ShotRow] 切换戏型失败', e)
  }
}

const isLocked = computed(() => props.shot.locked === 1 || props.shot.locked === true)
async function toggleLock() {
  const next = !isLocked.value
  try {
    await api.updateShot(store.currentEpisodeId, props.shot.id, { locked: next ? 1 : 0 })
    props.shot.locked = next ? 1 : 0
  } catch (e) {
    console.error('[ShotRow] 切换锁定失败', e)
  }
}

// 叙事四件套的就地编辑（提示词弹窗内）
const narrativeEditing = ref(false)
const narrativeSaving = ref(false)
const narrativeForm = ref({ purpose: '', goal: '', emotionTone: '', infoPointsText: '' })
function startNarrativeEdit() {
  narrativeForm.value = {
    purpose: props.shot.purpose || '',
    goal: props.shot.goal || '',
    emotionTone: props.shot.emotionTone || '',
    infoPointsText: (props.shot.infoPoints || []).join('；'),
  }
  narrativeEditing.value = true
}
async function saveNarrative() {
  narrativeSaving.value = true
  try {
    const infoPoints = narrativeForm.value.infoPointsText.split(/[；;\n]/).map((s) => s.trim()).filter(Boolean)
    await api.updateShot(store.currentEpisodeId, props.shot.id, {
      purpose: narrativeForm.value.purpose.trim(),
      goal: narrativeForm.value.goal.trim(),
      emotion_tone: narrativeForm.value.emotionTone.trim(),
      info_points: infoPoints,
    })
    props.shot.purpose = narrativeForm.value.purpose.trim()
    props.shot.goal = narrativeForm.value.goal.trim()
    props.shot.emotionTone = narrativeForm.value.emotionTone.trim()
    props.shot.infoPoints = infoPoints
    narrativeEditing.value = false
  } catch (e) {
    console.error('[ShotRow] 保存叙事字段失败', e)
  } finally {
    narrativeSaving.value = false
  }
}
const showDescModal = ref(false)
const copied = ref(false)

const FALLBACK_CHAR_COLOR = '#7E7E8C'

// 角色色板按名称稳定取色：store 里已登记的用其 color，
// 未登记的按本镜出场序号取色，避免把具体角色名写死在组件里
function charColor(name) {
  const known = getCharacter(name)?.color
  if (known) return known
  const i = (props.shot.characters || []).indexOf(name)
  return i >= 0 ? characterColor(i) : FALLBACK_CHAR_COLOR
}

function getCharacter(name) {
  return store.characters.find(c => c.name === name) || null
}

function getScene(name) {
  return store.assetScenes.find(s => s.name === name) || null
}

function getProp(name) {
  return store.props.find(p => p.name === name) || null
}

function getAssetImage(asset) {
  return asset?.imageUrl || asset?.image_url || ''
}

const assetStats = computed(() => {
  const charCount = props.shot.characters?.length || 0
  const sceneCount = props.shot.sceneAssets?.length || 0
  const propCount = props.shot.propAssets?.length || 0
  const imageCount = charCount + sceneCount + propCount
  const audioCount = (props.shot.characters || []).filter(name => !!getCharacter(name)?.audioUrl).length
  const videoCount = props.shot.videoUrl ? 1 : 0
  return { imageCount, videoCount, audioCount }
})

const relationBadges = computed(() => {
  const badges = []
  if (props.shot.englishPending) badges.push({ label: '翻译待完成', title: '本镜的英文版正在后台准备；不处理也不影响出片，出片时会自动完成' })
  if (props.shot.beatId) badges.push({ label: `节拍 ${props.shot.beatId}`, title: '剧情节拍' })
  if (props.shot.coverageId) badges.push({ label: `覆盖 ${props.shot.coverageId}`, title: '同组覆盖镜头' })
  if (props.shot.relationType) badges.push({ label: props.shot.relationType, title: '镜头关系类型' })
  if (props.shot.relatedShots?.length) badges.push({ label: `关联 ${props.shot.relatedShots.length}`, title: '关联镜头数量' })
  return badges
})

const parsedDescription = computed(() => {
  const text = props.shot.description || ''
  const allNames = [
    ...(props.shot.characters || []).map(n => ({ name: n, type: 'character' })),
    ...(props.shot.sceneAssets || []).map(n => ({ name: n, type: 'scene' })),
    ...(props.shot.propAssets || []).map(n => ({ name: n, type: 'prop' })),
  ]
  allNames.sort((a, b) => b.name.length - a.name.length)

  const segments = []
  let remaining = text

  while (remaining.length > 0) {
    let earliestIndex = -1
    let earliestMatch = null
    for (const item of allNames) {
      const pattern = `@${item.name}`
      const index = remaining.indexOf(pattern)
      if (index !== -1 && (earliestIndex === -1 || index < earliestIndex)) {
        earliestIndex = index
        earliestMatch = item
      }
    }
    if (earliestMatch) {
      if (earliestIndex > 0) {
        segments.push({ type: 'text', content: remaining.slice(0, earliestIndex) })
      }
      segments.push({ type: earliestMatch.type, content: earliestMatch.name })
      remaining = remaining.slice(earliestIndex + earliestMatch.name.length + 1)
    } else {
      segments.push({ type: 'text', content: remaining })
      break
    }
  }
  return segments
})

const hasBlockingContent = computed(
  () => !!props.shot.blockingPlan || !!props.shot.blockingUrl || props.shot.hasBlocking
)

const chartRef = ref(null)
function regenerateBlocking() {
  store.generateBlocking(props.shot.id)
}
function zoomBlocking() {
  if (props.shot.blockingPlan) chartRef.value?.open()
}

const generatingVideo = computed(() => store.generatingVideoIds.includes(props.shot.id))
const videoBtnText = computed(() =>
  generatingVideo.value ? '出片中...' : (props.shot.videoUrl ? '重新出片' : '生成成片')
)
const videoPhaseText = '云端生成中，约 3~15 分钟'
function generateVideo() {
  store.generateShotVideoByModel(props.shot.id)
}

const frameImage = computed(() => props.shot.frameUrl || '')
const frameImages = computed(() => {
  const list = [frameImage.value]
  if (props.shot.frameUrl2) list.push(props.shot.frameUrl2)
  return list.filter(Boolean)
})
const showFrameModal = ref(false)
function generateFrame() {
  store.generateShotImage(props.shot.id, 'frame', store.imageModel)
}
const shotGridLoading = computed(() => store.generatingShotGridIds.includes(props.shot.id))
const shotGridFailed = computed(() => store.shotGridFailed[props.shot.id] || '')
const shotGridStartedAt = computed(() => store.shotGridStartedAt[props.shot.id] || 0)
const nowTick = ref(Date.now())
let tickTimer = null
onMounted(() => { tickTimer = setInterval(() => { nowTick.value = Date.now() }, 1000) })
onBeforeUnmount(() => { if (tickTimer) { clearInterval(tickTimer); tickTimer = null } })
const shotGridElapsed = computed(() => {
  if (!shotGridLoading.value || !shotGridStartedAt.value) return ''
  const sec = Math.max(0, Math.floor((nowTick.value - shotGridStartedAt.value) / 1000))
  return sec >= 60 ? `已 ${Math.floor(sec / 60)} 分 ${sec % 60} 秒` : `已 ${sec} 秒`
})
function clearShotGridFailed() {
  store.clearShotGridFailed(props.shot.id)
}
function generateShotGrid() {
  if (!props.shot.id) return
  if (!confirm('将为本镜头生成 2x2 四宫格分镜图（覆盖当前 frame_url），继续？')) return
  store.generateShotGrid(props.shot.id, store.imageModel)
}
function zoomFrame(idx = 0) {
  if (!frameImages.value.length) return
  showFrameModal.value = true
}
async function setPrimary(idx) {
  if (idx === 0) return
  await store.setPrimaryFrame(props.shot.id, idx + 1)
}

// —— 空间锚出图依据（服务端注入管线落库的快照，随镜头数据下发）——
const anchorSnapshot = computed(() => props.shot.anchorSnapshot || null)
// 五态：anchored 有锚 / stale 依据已变（出图后组基准换过）/ degraded 注入失败降级 /
// none 无锚（仅凭文字描述）/ missing 管线接入前的老图（无记录）
const anchorState = computed(() => {
  if (!frameImage.value) return ''
  if (!anchorSnapshot.value) return 'missing'
  if (anchorSnapshot.value.degraded) return 'degraded'
  if (anchorSnapshot.value.scene?.baseline_url) {
    return props.shot.anchorStale ? 'stale' : 'anchored'
  }
  return 'none'
})
const ANCHOR_BADGE = {
  anchored: { text: '空间锚', cls: 'bg-ok/15 text-ok', title: '本图注入了所在空间组的已确认基准图（点击看出图依据）' },
  stale: { text: '依据已变', cls: 'bg-warn/15 text-warn', title: '出图后该组基准图已更换，本图按旧基准生成（点击看详情，建议重出）' },
  degraded: { text: '锚降级', cls: 'bg-warn/15 text-warn', title: '空间锚注入失败，本图按普通场景参考图出图（点击看原因）' },
  none: { text: '无锚', cls: 'bg-bg-hover text-text-muted', title: '本图未注入空间锚，仅凭文字描述生成（点击看详情）' },
  missing: { text: '无记录', cls: 'bg-bg-hover text-text-muted', title: '本图生成于注入管线接入前，无出图依据记录' },
}
const anchorBadge = computed(() => ANCHOR_BADGE[anchorState.value] || null)
const showAnchorPanel = ref(false)
const anchorElements = computed(() => anchorSnapshot.value?.elements || [])
const anchorSharedEnv = computed(() => anchorSnapshot.value?.shared_env || [])
const anchorBudget = computed(() => anchorSnapshot.value?.budget || null)
const anchorGeneratedAtText = computed(() => {
  const d = new Date(anchorSnapshot.value?.generated_at || '')
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
})

const keyframeImage = computed(() => props.shot.keyframeUrl || '')
const keyframeLoading = computed(() => store.generatingKeyframeIds.includes(props.shot.id))
const showKeyframeModal = ref(false)
const canGenerateKeyframe = computed(() => !!(props.shot.finalFrame || '').trim())
function generateKeyframe() {
  store.generateShotImage(props.shot.id, 'keyframe', store.imageModel)
}

const hovKey = ref('')
function hovEnter(key) { hovKey.value = key }
function hovLeave(key) { if (hovKey.value === key) hovKey.value = '' }

const statusDetail = computed(() => ({
  stateRows: statusDots.value.map((d) => ({
    key: d.key,
    label: d.label,
    text: d.failed ? '生成失败' : d.done ? '已就绪' : '待产出',
    cls: d.failed ? 'text-danger' : d.done ? 'text-ok' : 'text-text-muted',
  })),
}))

const assetDetail = computed(() => {
  const a = assetStats.value
  return {
    rows: [
      { key: 'char', label: '角色', n: props.shot.characters?.length || 0 },
      { key: 'scene', label: '场景', n: props.shot.scene ? 1 : 0 },
      { key: 'prop', label: '道具', n: props.shot.props?.length || 0 },
    ],
    counts: [
      { key: 'image', label: '图像资产', n: a.imageCount, dot: 'bg-info' },
      { key: 'video', label: '视频资产', n: a.videoCount, dot: 'bg-accent' },
      { key: 'audio', label: '音频资产', n: a.audioCount, dot: 'bg-ok' },
    ],
  }
})


const statusDots = computed(() => {
  const s = props.shot
  const videoReady = !!(s.videoUrl || s.video_url || s.videoGenerated || s.video_generated)
  return [
    { key: 'frame', label: '分镜图', done: !!frameImage.value, failed: shotGridFailed.value },
    { key: 'keyframe', label: '尾帧锚', done: !!keyframeImage.value, failed: false },
    { key: 'blocking', label: '站位图', done: hasBlockingContent.value, failed: false },
    { key: 'video', label: '成片', done: videoReady, failed: false },
  ]
})
const pendingLabels = computed(() =>
  statusDots.value.filter((d) => !d.done).map((d) => d.label)
)
const statusTitle = computed(() => {
  const failed = statusDots.value.filter((d) => d.failed).map((d) => d.label)
  const parts = []
  if (failed.length) parts.push(`失败：${failed.join('、')}`)
  if (pendingLabels.value.length) parts.push(`待产出：${pendingLabels.value.join('、')}`)
  if (!parts.length) parts.push('四路产出物齐全')
  return parts.join('\n')
})

// ---- 单镜 AI 重写（#10）：保持时长与时轴不变，按前后镜衔接约束重写内容 ----
const showRegenModal = ref(false)
const regenInstruction = ref('')
const regenError = ref('')
const regenBusy = computed(() => store.regeneratingShotIds.includes(props.shot.id))
function openRegen() {
  regenInstruction.value = ''
  regenError.value = ''
  showRegenModal.value = true
}
async function submitRegen() {
  if (regenBusy.value) return
  regenError.value = ''
  const r = await store.regenerateShot(props.shot.id, regenInstruction.value)
  if (r.success) {
    showRegenModal.value = false
  } else {
    regenError.value = r.error || '重写失败'
  }
}

// ---- 历史版本：列表 + 快照详情对比 + 回退（回退本身可撤销）----
const showVersionsModal = ref(false)
const versionsLoading = ref(false)
const versionsError = ref('')
const versionsData = ref(null)
const selectedVersionId = ref(null)
const restoringId = ref(null)
// 与后端 withShotVersionSnapshot 的 reason 取值对应（协议枚举，非项目数据）
const VERSION_REASON_LABELS = {
  storyboard_reset: '整场重置前',
  save_overwrite: '整场重存前',
  save_prune: '整场重存裁剪前',
  scene_prune: '场次删除前',
  manual_edit: '人工编辑前',
  regenerate: 'AI 重写前',
  version_restore: '版本回退前',
}
function reasonLabel(reason) {
  return VERSION_REASON_LABELS[reason] || reason || '快照'
}
function fmtTime(t) {
  return String(t || '').slice(5, 16)
}
async function openVersions() {
  showVersionsModal.value = true
  versionsLoading.value = true
  versionsError.value = ''
  selectedVersionId.value = null
  try {
    versionsData.value = await api.getShotVersions(store.currentEpisodeId, props.shot.id)
    const first = versionsData.value?.versions?.[0]
    if (first) selectedVersionId.value = first.id
  } catch (e) {
    versionsError.value = e.message || '加载版本失败'
  } finally {
    versionsLoading.value = false
  }
}
const selectedVersion = computed(() =>
  (versionsData.value?.versions || []).find((v) => v.id === selectedVersionId.value) || null
)
const snapDialogueText = computed(() => {
  const raw = selectedVersion.value?.snapshot?.dialogue
  if (!raw) return ''
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (Array.isArray(arr)) return arr.map((d) => `${d?.character || ''}：${d?.text || ''}`).join('\n')
  } catch { }
  return String(raw)
})
// 选中快照与当前镜的关键差异（人工比对辅助；不含全文 diff）
const snapDiff = computed(() => {
  const snap = selectedVersion.value?.snapshot
  if (!snap) return []
  const rows = []
  const snapDur = Number(snap.duration)
  if (Number.isFinite(snapDur) && snapDur !== Number(props.shot.duration)) {
    rows.push({ label: '时长', text: `当前 ${props.shot.duration}s → 回退后 ${snapDur}s` })
  }
  if ((snap.description || '') !== (props.shot.description || '')) rows.push({ label: '画面描述', text: '有差异，见下方快照全文' })
  if ((snap.final_frame || '') !== (props.shot.finalFrame || '')) rows.push({ label: '最终画面', text: '有差异，见下方快照全文' })
  let snapChars = []
  try { snapChars = JSON.parse(snap.characters || '[]') } catch { snapChars = [] }
  if (snapChars.join('、') !== (props.shot.characters || []).join('、')) {
    rows.push({ label: '出场角色', text: `当前：${(props.shot.characters || []).join('、') || '无'} / 快照：${snapChars.join('、') || '无'}` })
  }
  const prodLabels = [
    ['分镜图', snap.frame_url],
    ['站位图', snap.blocking_url],
    ['成片', snap.video_url],
  ].filter(([, v]) => !!v).map(([k]) => k)
  if (prodLabels.length) rows.push({ label: '快照含产出物', text: `回退会一并恢复：${prodLabels.join('、')}` })
  return rows
})
async function restoreVersion() {
  const v = selectedVersion.value
  if (!v || restoringId.value) return
  if (!confirm(`回退到 v${v.version}？当前内容会先自动存入历史版本，之后仍可再回退回来。`)) return
  restoringId.value = v.id
  versionsError.value = ''
  try {
    await api.restoreShotVersion(store.currentEpisodeId, props.shot.id, v.id)
    await store.refreshStoryboardShots()
    versionsData.value = await api.getShotVersions(store.currentEpisodeId, props.shot.id)
    const first = versionsData.value?.versions?.[0]
    selectedVersionId.value = first?.id ?? null
  } catch (e) {
    versionsError.value = e.message || '回退失败'
  } finally {
    restoringId.value = null
  }
}

// ---- 时长编辑（#10）：保存后本镜之后的所有镜头（含跨场）时间轴自动顺延 ----
const showDurationModal = ref(false)
const durationForm = ref('')
const durationSaving = ref(false)
const durationError = ref('')
function openDurationEdit() {
  if (isLocked.value) return
  durationForm.value = String(props.shot.duration ?? '')
  durationError.value = ''
  showDurationModal.value = true
}
async function saveDuration() {
  const v = Number(durationForm.value)
  if (!Number.isFinite(v) || v <= 0) {
    durationError.value = '请输入正数秒数'
    return
  }
  durationSaving.value = true
  durationError.value = ''
  try {
    await api.updateShot(store.currentEpisodeId, props.shot.id, { duration: v })
    await store.refreshStoryboardShots()
    showDurationModal.value = false
  } catch (e) {
    durationError.value = e.message || '保存失败'
  } finally {
    durationSaving.value = false
  }
}

</script>

<template>
  <div
    :data-shot-number="shot.shotNumber || ''"
    class="group/row grid grid-cols-[52px_200px_minmax(280px,1fr)_156px_156px_156px_56px] items-stretch gap-3 border-b border-border/60 px-4 py-3 transition-colors duration-150 last:border-b-0 hover:bg-bg-hover/40"
    :class="[
      index % 2 === 1 ? 'bg-bg-primary/40' : '',
      highlighted ? 'ring-2 ring-inset ring-accent bg-accent/10' : '',
    ]"
  >
    <div class="flex flex-col items-start gap-1.5 pt-0.5">
      <span class="rounded-control border border-border bg-bg-primary/70 px-1.5 py-0.5 font-mono text-micro font-medium text-text-secondary transition group-hover/row:border-accent/50 group-hover/row:text-accent">
        {{ shot.shotNumber || shot.displayId || shot.id }}
      </span>

      <div
        class="relative flex cursor-help items-center gap-1"
        :title="statusTitle"
        @mouseenter="hovEnter('lamp')"
        @mouseleave="hovLeave('lamp')"
      >
        <span
          v-for="d in statusDots"
          :key="d.key"
          class="h-1.5 w-1.5 rounded-full transition"
          :class="d.failed
            ? 'bg-danger'
            : d.done
              ? 'bg-ok'
              : 'border border-border-strong'"
        ></span>

        <div
          v-if="hovKey === 'lamp'"
          class="pointer-events-none absolute left-0 top-[calc(100%+8px)] z-30 w-max overflow-hidden rounded-card border border-border bg-bg-card px-3 py-2.5 shadow-pop animate-fade-up"
        >
          <div class="mb-1.5 flex items-center gap-1.5 text-micro font-medium text-text-primary">
            <span>镜头产出</span>
            <span class="text-text-muted">· 对应右侧四列</span>
          </div>
          <div class="space-y-1">
            <div
              v-for="r in statusDetail.stateRows"
              :key="r.key"
              class="flex items-center gap-2 whitespace-nowrap text-micro"
            >
              <span class="h-3 w-3 shrink-0" :class="r.cls" aria-hidden="true">·</span>
              <span class="w-12 shrink-0 text-text-secondary">{{ r.label }}</span>
              <span :class="r.cls">{{ r.text }}</span>
            </div>
          </div>
        </div>
      </div>

      <span
        v-if="pendingLabels.length"
        class="rounded-tag bg-bg-hover px-1 text-micro leading-snug text-text-muted"
        :title="`待产出：${pendingLabels.join('、')}`"
      >缺 {{ pendingLabels.length }}</span>
    </div>

    <div class="space-y-2">
      <div v-if="relationBadges.length" class="flex flex-wrap gap-1">
        <span
          v-for="badge in relationBadges"
          :key="`${badge.title}-${badge.label}`"
          class="rounded-control border border-accent/25 bg-accent/5 px-1.5 py-0.5 text-micro text-accent"
          :title="badge.title"
        >{{ badge.label }}</span>
      </div>
      <div
        class="relative flex flex-wrap gap-1 text-micro"
        @mouseenter="hovEnter('assets')"
        @mouseleave="hovLeave('assets')"
      >
        <span class="inline-flex cursor-help items-center gap-1 rounded-control border border-info/25 bg-info/10 px-1.5 py-0.5 text-info">
          <span class="h-1 w-1 rounded-full bg-info"></span>图 {{ assetStats.imageCount }}
        </span>
        <span class="inline-flex cursor-help items-center gap-1 rounded-control border border-accent/25 bg-accent/10 px-1.5 py-0.5 text-accent">
          <span class="h-1 w-1 rounded-full bg-accent"></span>视 {{ assetStats.videoCount }}
        </span>
        <span class="inline-flex cursor-help items-center gap-1 rounded-control border border-ok/25 bg-ok/10 px-1.5 py-0.5 text-ok">
          <span class="h-1 w-1 rounded-full bg-ok"></span>音 {{ assetStats.audioCount }}
        </span>

        <div
          v-if="hovKey === 'assets'"
          class="pointer-events-none absolute left-0 top-[calc(100%+8px)] z-30 w-max overflow-hidden rounded-card border border-border bg-bg-card px-3 py-2.5 shadow-pop animate-fade-up"
        >
          <div class="mb-1.5 text-micro font-medium text-text-primary">本镜资产</div>
          <div class="space-y-1">
            <div
              v-for="r in assetDetail.rows"
              :key="r.key"
              class="flex items-center gap-2 whitespace-nowrap text-micro"
            >
              <span class="w-8 shrink-0 text-text-secondary">{{ r.label }}</span>
              <span :class="r.n ? 'text-text-primary' : 'text-text-muted'">{{ r.n ? `${r.n} 个` : '未绑定' }}</span>
            </div>
          </div>
          <div class="mt-1.5 space-y-1 border-t border-border pt-1.5">
            <div
              v-for="c in assetDetail.counts"
              :key="c.key"
              class="flex items-center gap-2 whitespace-nowrap text-micro"
            >
              <span class="h-1 w-1 shrink-0 rounded-full" :class="c.dot"></span>
              <span class="w-16 shrink-0 text-text-secondary">{{ c.label }}</span>
              <span class="text-text-primary">{{ c.n }}</span>
            </div>
          </div>
        </div>
      </div>

      <div v-if="shot.characters?.length" class="space-y-1">
        <div class="text-micro text-text-muted">角色</div>
        <div class="flex flex-wrap gap-1">
          <div
            v-for="name in shot.characters"
            :key="name"
            class="flex items-center gap-1 overflow-hidden rounded-control border border-border bg-bg-card transition hover:border-border-light"
          >
            <span class="h-5 w-0.5 shrink-0 rounded-full" :style="{ background: charColor(name) }"></span>
            <div class="h-5 w-5 shrink-0 overflow-hidden rounded-[6px] bg-bg-hover">
              <img v-if="getAssetImage(getCharacter(name))" :src="getAssetImage(getCharacter(name))" class="h-full w-full object-cover" />
              <div v-else class="flex h-full w-full items-center justify-center text-micro text-text-muted">{{ name.charAt(0) }}</div>
            </div>
            <span class="pr-1.5 text-micro text-text-secondary">{{ name }}</span>
          </div>
        </div>
      </div>

      <div v-if="shot.sceneAssets?.length" class="space-y-1">
        <div class="text-micro text-text-muted">场景</div>
        <div class="flex flex-wrap gap-1">
          <div
            v-for="(scene, idx) in shot.sceneAssets"
            :key="scene"
            class="flex items-center gap-1 overflow-hidden rounded-control border border-info/30 bg-info/5 transition hover:border-info/50"
          >
            <span class="flex h-5 w-4 shrink-0 items-center justify-center rounded-[5px] bg-info/20 text-micro font-medium text-info">{{ idx + 1 }}</span>
            <div class="h-5 w-5 shrink-0 overflow-hidden rounded-[6px] bg-bg-hover">
              <img v-if="getAssetImage(getScene(scene))" :src="getAssetImage(getScene(scene))" class="h-full w-full object-cover" />
              <div v-else class="flex h-full w-full items-center justify-center text-micro text-text-muted">景</div>
            </div>
            <span class="pr-1.5 text-micro text-text-secondary">{{ scene }}</span>
          </div>
        </div>
      </div>

      <div v-if="shot.propAssets?.length" class="space-y-1">
        <div class="text-micro text-text-muted">道具</div>
        <div class="flex flex-wrap gap-1">
          <div
            v-for="prop in shot.propAssets"
            :key="prop"
            class="flex items-center gap-1 overflow-hidden rounded-control border border-warn/30 bg-warn/5 transition hover:border-warn/50"
          >
            <div class="h-5 w-5 shrink-0 overflow-hidden rounded-[6px] bg-bg-hover">
              <img v-if="getAssetImage(getProp(prop))" :src="getAssetImage(getProp(prop))" class="h-full w-full object-cover" />
              <div v-else class="flex h-full w-full items-center justify-center text-micro text-text-muted">物</div>
            </div>
            <span class="pr-1.5 text-micro text-text-secondary">{{ prop }}</span>
          </div>
        </div>
      </div>
    </div>

    <div class="flex min-h-[112px] flex-col rounded-btn border border-border bg-bg-card p-2.5">
      <button
        class="flex-1 cursor-pointer overflow-auto text-left text-[12px] leading-relaxed text-text-secondary transition hover:text-text-primary"
        type="button"
        title="点击查看完整描述"
        @click="showDescModal = true"
      >
        <template v-for="(seg, idx) in parsedDescription" :key="idx">
          <span v-if="seg.type === 'text'">{{ seg.content }}</span>
          <span v-else-if="seg.type === 'character'" class="rounded-tag bg-warn/20 px-1 text-warn">{{ seg.content }}</span>
          <span v-else-if="seg.type === 'scene'" class="rounded-tag bg-info/20 px-1 text-info">{{ seg.content }}</span>
          <span v-else-if="seg.type === 'prop'" class="rounded-tag bg-warn/20 px-1 text-warn">{{ seg.content }}</span>
        </template>
      </button>

      <div class="mt-2 flex shrink-0 flex-wrap items-center gap-1 border-t border-border/60 pt-2 text-micro">
        <span v-if="shot.shotType" class="rounded-control border border-info/30 bg-info/10 px-1.5 py-0.5 text-info" title="景别">
          {{ shot.shotType.length > 26 ? shot.shotType.slice(0, 26) + '…' : shot.shotType }}
        </span>
        <span v-if="shot.cameraMovement" class="rounded-control border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-accent" title="运镜">
          {{ shot.cameraMovement }}
        </span>
        <span v-if="shot.cameraAngle" class="rounded-control border border-border bg-bg-primary/60 px-1.5 py-0.5 text-text-secondary" title="机位角度">
          {{ shot.cameraAngle }}
        </span>
        <span v-if="shot.overallSoundscape" class="rounded-control border border-ok/30 bg-ok/10 px-1.5 py-0.5 text-ok" title="环境声">环境声</span>
        <span v-if="shot.nonDiegeticMusic" class="rounded-control border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-accent" title="配乐">配乐</span>

        <button
          v-if="shot.integratedMultimodalDescription"
          class="ml-auto flex items-center gap-1 rounded-control bg-accent/10 px-2 py-0.5 font-medium text-accent transition hover:bg-accent/20"
          title="查看完整 AI 视频 Prompt（6 模块结构化）"
          @click="showPromptModal = true"
        >
          <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" /></svg>
          查看提示词
        </button>
        <span
          v-else
          class="ml-auto flex items-center gap-1 rounded-control border border-danger/40 bg-danger/10 px-2 py-0.5 font-medium text-danger"
          title="该镜头缺少 AI 视频提示词，生图/出片质量会受影响。可在分镜页顶部点「补全提示词」批量补全"
        >
          <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
          缺提示词
        </span>
      </div>
    </div>

    <div class="group/frame-col relative flex min-h-[112px] flex-col rounded-btn border border-border bg-bg-card p-2">
      <div class="relative flex-1 overflow-hidden rounded-btn bg-bg-primary">
        <div
          v-if="frameImages.length"
          class="grid h-full w-full gap-0.5"
          :class="frameImages.length > 1 ? 'grid-cols-2' : 'grid-cols-1'"
        >
          <div
            v-for="(img, idx) in frameImages"
            :key="img"
            class="group/frame relative min-h-0 overflow-hidden"
          >
            <img
              :src="img"
              :alt="`镜头 ${shot.id} 分镜图${idx + 1}`"
              class="h-full w-full cursor-zoom-in object-cover"
              @click.stop="zoomFrame(idx)"
            />
            <span
              class="absolute left-0.5 top-0.5 rounded-tag px-1 text-micro font-medium"
              :class="idx === 0 ? 'bg-ok text-black' : 'bg-black/70 text-white'"
            >{{ idx === 0 ? '主图' : '候选' }}</span>
            <button
              v-if="idx > 0"
              class="absolute bottom-1 left-1/2 hidden -translate-x-1/2 rounded-tag bg-black/80 px-1.5 py-0.5 text-micro text-white hover:bg-black group-hover/frame:block"
              @click.stop="setPrimary(idx)"
              title="把这张设为主图（主图参与视频生成参考）"
            >设为主图</button>
          </div>
        </div>
        <div v-else class="flex h-full items-center justify-center bg-bg-primary">
          <svg class="h-7 w-7 text-text-muted/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
        </div>

        <div v-if="store.generatingStoryboardIds.includes(shot.id) || store.batchStoryboardGenerating" class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/75 backdrop-blur-sm">
          <svg class="h-5 w-5 animate-spin text-accent" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
          <span class="text-micro text-white">生成中...</span>
        </div>

        <div v-else-if="shotGridLoading" class="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/75 backdrop-blur-sm">
          <svg class="h-5 w-5 animate-spin text-accent" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
          <span class="text-micro font-medium text-text-primary">出四宫格中 {{ shotGridElapsed }}</span>
          <span class="text-micro text-white/60">约 1~3 分钟</span>
        </div>

      </div>

      <div class="mt-1.5 flex shrink-0 items-center gap-1 border-t border-border/50 pt-1.5 text-micro">
        <span
          class="rounded-tag px-1.5"
          :class="frameImage ? 'bg-ok/15 text-ok' : 'text-text-muted'"
        >{{ frameImage ? '已出图' : '未出图' }}</span>
        <button
          v-if="anchorBadge"
          class="shrink-0 rounded-tag px-1.5 transition hover:opacity-80"
          :class="anchorBadge.cls"
          :title="anchorBadge.title"
          @click="showAnchorPanel = !showAnchorPanel"
        >{{ anchorBadge.text }}</button>
        <span
          v-if="shotGridFailed && !shotGridLoading"
          class="cursor-pointer rounded-tag bg-danger/15 px-1.5 text-danger"
          :title="`出四宫格失败：${shotGridFailed}（点击清除标记）`"
          @click="clearShotGridFailed"
        >失败</span>
        <span
          v-if="shot.frameDualKeyframe"
          class="rounded-tag bg-info/15 px-1.5 text-info"
          title="该镜头时长较长，两张候选分别是动作首帧与尾帧（主图为首帧）"
        >首帧+尾帧</span>

        <button
          class="ml-auto shrink-0 rounded-tag border px-1.5 py-0.5 font-medium transition disabled:cursor-not-allowed disabled:opacity-40"
          :class="frameImage
            ? 'border-accent/40 text-accent hover:bg-accent/15'
            : 'border-accent/40 bg-accent/10 text-accent hover:bg-accent/20'"
          :disabled="shotGridLoading || store.generatingStoryboardIds.includes(shot.id) || store.batchStoryboardGenerating"
          title="为本镜头出 2x2 四宫格分镜图（4 格 = 同一镜头的 4 个时间瞬间）。会覆盖本镜 frame_url。"
          @click="generateShotGrid"
        >{{ shotGridLoading ? '出图中…' : (frameImage ? '重出图' : '出图') }}</button>

        <button
          v-if="frameImage"
          class="shrink-0 rounded-tag px-1.5 py-0.5 text-text-secondary transition hover:bg-bg-hover hover:text-text-primary"
          @click="zoomFrame"
          title="放大查看分镜图"
        >放大</button>
      </div>

      <div
        v-if="showAnchorPanel && anchorBadge"
        class="mt-1.5 shrink-0 space-y-1.5 rounded-btn border border-border/60 bg-bg-primary/60 p-2 text-micro"
      >
        <template v-if="anchorState === 'anchored' || anchorState === 'stale'">
          <div v-if="anchorState === 'stale'" class="rounded-tag bg-warn/15 px-1.5 py-0.5 text-warn">
            该组基准图已更换，本图按旧基准生成——建议复核后重出
          </div>
          <div class="flex gap-2">
            <a
              v-if="anchorSnapshot?.scene?.baseline_url"
              :href="anchorSnapshot.scene.baseline_url"
              target="_blank"
              class="block shrink-0"
              title="点击在新窗口查看基准图原图"
            >
              <img :src="anchorSnapshot.scene.baseline_url" alt="基准图" class="h-16 w-24 rounded-tag object-cover" />
              <span class="mt-0.5 block text-center text-text-secondary">基准图</span>
            </a>
            <a
              v-if="anchorSnapshot?.scene?.layout_url"
              :href="anchorSnapshot.scene.layout_url"
              target="_blank"
              class="block shrink-0"
              title="点击在新窗口查看布局图原图"
            >
              <img :src="anchorSnapshot.scene.layout_url" alt="布局图" class="h-16 w-24 rounded-tag object-cover" />
              <span class="mt-0.5 block text-center text-text-secondary">布局图</span>
            </a>
            <div class="min-w-0 flex-1 space-y-0.5">
              <div class="truncate text-text-secondary" :title="anchorSnapshot?.scene?.title || ''">
                场景：{{ anchorSnapshot?.scene?.title || '—' }}
                <span v-if="anchorSnapshot?.scene?.group" class="text-text-muted">（组 {{ anchorSnapshot.scene.group }}）</span>
              </div>
              <div v-if="anchorBudget" class="text-text-muted">锚参考 {{ anchorBudget.used }}/{{ anchorBudget.max }} 张</div>
              <div v-if="anchorGeneratedAtText" class="text-text-muted">出图时间 {{ anchorGeneratedAtText }}</div>
            </div>
          </div>
          <div v-if="anchorElements.length" class="flex flex-wrap gap-1">
            <span class="text-text-muted">要素：</span>
            <span v-for="el in anchorElements" :key="el" class="rounded-tag bg-bg-hover px-1 text-text-secondary">{{ el }}</span>
          </div>
          <div v-if="anchorSharedEnv.length" class="flex flex-wrap gap-1">
            <span class="text-text-muted">共有环境：</span>
            <span v-for="ev in anchorSharedEnv" :key="ev" class="rounded-tag bg-bg-hover px-1 text-text-secondary">{{ ev }}</span>
          </div>
        </template>
        <div v-else-if="anchorState === 'degraded'" class="space-y-0.5">
          <div class="text-warn">空间锚注入失败，本图按普通场景参考图出图</div>
          <div v-if="anchorSnapshot?.reason" class="text-text-muted">原因：{{ anchorSnapshot.reason }}</div>
        </div>
        <div v-else-if="anchorState === 'none'" class="text-text-muted">
          本图仅凭文字描述生成：镜头场景未命中场景表，或所在空间组未确认基准图
        </div>
        <div v-else-if="anchorState === 'missing'" class="text-text-muted">
          本图生成于注入管线接入前，无出图依据记录
        </div>
      </div>
    </div>

    <div class="group/kf-col relative flex min-h-[112px] flex-col rounded-btn border border-border bg-bg-card p-2">
      <div class="relative flex-1 overflow-hidden rounded-btn bg-bg-primary">
        <img
          v-if="keyframeImage"
          :src="keyframeImage"
          :alt="`镜头 ${shot.id} 尾帧锚`"
          class="h-full w-full cursor-zoom-in object-cover"
          @click.stop="showKeyframeModal = true"
        />
        <div v-else class="flex h-full flex-col items-center justify-center gap-1 bg-bg-primary">
          <svg class="h-7 w-7 text-text-muted/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
          </svg>
          <span class="text-micro text-text-muted">无尾帧锚</span>
        </div>

        <div v-if="keyframeLoading" class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/75 backdrop-blur-sm">
          <svg class="h-5 w-5 animate-spin text-accent" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
          <span class="text-micro text-white">出尾帧中...</span>
        </div>

      </div>

      <div class="mt-1.5 flex shrink-0 items-center gap-1 border-t border-border/50 pt-1.5 text-micro">
        <span
          class="rounded-tag px-1.5"
          :class="keyframeImage ? 'bg-ok/15 text-ok' : 'text-text-muted'"
        >{{ keyframeImage ? '已出图' : '未出图' }}</span>
        <span
          v-if="!canGenerateKeyframe"
          class="rounded-tag bg-bg-hover px-1 text-text-muted"
          title="final_frame 为空，无从生图"
        >无描述</span>

        <button
          class="ml-auto shrink-0 rounded-tag border px-1.5 py-0.5 font-medium transition disabled:cursor-not-allowed disabled:opacity-40"
          :class="keyframeImage
            ? 'border-accent/40 text-accent hover:bg-accent/15'
            : 'border-accent/40 bg-accent/10 text-accent hover:bg-accent/20'"
          :disabled="keyframeLoading || !canGenerateKeyframe"
          :title="canGenerateKeyframe
            ? `由本镜最终画面描述生成尾帧锚（本镜结束画面，供下一镜对齐接缝）。${keyframeImage ? '会覆盖当前尾帧锚。' : ''}`
            : '本镜没有「最终画面」描述，无法出尾帧锚。请先在 AI 提示词里补全'"
          @click="generateKeyframe"
        >{{ keyframeLoading ? '出图中…' : (keyframeImage ? '重出' : '出图') }}</button>

        <button
          v-if="keyframeImage"
          class="shrink-0 rounded-tag px-1.5 py-0.5 text-text-secondary transition hover:bg-bg-hover hover:text-text-primary"
          @click="showKeyframeModal = true"
          title="放大查看尾帧锚"
        >放大</button>
      </div>
    </div>

    <div class="group/block-col relative flex min-h-[112px] flex-col rounded-btn border border-border bg-bg-card p-2">
      <div class="relative flex-1 overflow-hidden rounded-btn bg-bg-primary">
        <BlockingChart
          ref="chartRef"
          v-if="shot.blockingPlan"
          :plan="shot.blockingPlan"
          :shot="shot"
          compact
        />
        <img
          v-else-if="shot.blockingUrl"
          :src="shot.blockingUrl"
          :alt="`镜头 ${shot.id} 站位图`"
          class="h-full w-full object-cover"
        />
        <div v-else class="flex h-full items-center justify-center">
          <div class="relative h-16 w-11 rounded-tag border border-border">
            <div class="absolute left-1.5 top-2.5 h-1.5 w-1.5 rounded-full bg-info/70"></div>
            <div class="absolute right-1.5 top-5 h-1.5 w-1.5 rounded-full bg-warn/70"></div>
            <div class="absolute bottom-2 left-1/2 h-1 w-2.5 -translate-x-1/2 rounded-sm bg-border-strong"></div>
          </div>
        </div>

        <div v-if="store.generatingBlockingIds.includes(shot.id) || store.batchBlockingGenerating" class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/75 backdrop-blur-sm">
          <svg class="h-5 w-5 animate-spin text-accent" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
          <span class="text-micro text-white">生成中...</span>
        </div>

      </div>

      <div class="mt-1.5 flex shrink-0 items-center gap-1 border-t border-border/50 pt-1.5 text-micro">
        <span
          class="rounded-tag px-1.5"
          :class="hasBlockingContent ? 'bg-ok/15 text-ok' : 'text-text-muted'"
        >{{ hasBlockingContent ? '已生成' : '未生成' }}</span>
        <span v-if="shot.blockingPlan" class="rounded-tag bg-warn/15 px-1 text-warn" title="程序化 SVG 站位图">程序化</span>

        <button
          class="ml-auto shrink-0 rounded-tag border px-1.5 py-0.5 font-medium transition disabled:cursor-not-allowed disabled:opacity-40"
          :class="hasBlockingContent
            ? 'border-border-light text-text-secondary hover:bg-bg-hover hover:text-text-primary'
            : 'border-accent/40 bg-accent/10 text-accent hover:bg-accent/20'"
          :disabled="store.generatingBlockingIds.includes(shot.id) || store.batchBlockingGenerating"
          title="按本镜走位重新生成站位图"
          @click="regenerateBlocking"
        >{{ shot.blockingPlan ? '重生成' : '生成' }}</button>

        <button
          v-if="shot.blockingPlan"
          class="shrink-0 rounded-tag px-1.5 py-0.5 text-text-secondary transition hover:bg-bg-hover hover:text-text-primary"
          @click="zoomBlocking"
          title="放大查看站位图"
        >放大</button>
      </div>
    </div>

    <div v-if="showVideo" class="flex flex-col items-stretch gap-1 pt-1">
      <video
        v-if="shot.videoUrl"
        :src="shot.videoUrl"
        controls
        preload="metadata"
        class="w-full rounded-tag border border-border bg-black"
        :title="`成片 ${shot.duration}s`"
      ></video>
      <div v-else-if="generatingVideo" class="flex h-[70px] w-full items-center justify-center rounded-tag border border-info/30 bg-info/10">
        <span class="animate-pulse text-micro text-info">{{ videoPhaseText }}</span>
      </div>
      <div v-else class="flex h-[70px] w-full items-center justify-center rounded-tag border border-dashed border-border text-micro text-text-muted">
        未出片
      </div>
      <button
        class="w-full rounded-tag px-1.5 py-0.5 text-micro font-medium disabled:opacity-50"
        :class="shot.videoUrl
          ? 'bg-bg-hover text-text-secondary hover:text-text-primary'
          : 'bg-info/20 text-info hover:bg-info/30'"
        :disabled="generatingVideo"
        :title="generatingVideo ? '出片中，请稍候' : `单镜出片（${shot.duration}s）`"
        @click.stop="generateVideo"
      >{{ videoBtnText }}</button>
    </div>

    <div class="flex flex-col items-center gap-1.5 pt-1">
      <span
        class="group/dur inline-flex cursor-pointer items-center gap-0.5 rounded-control bg-accent/15 px-2 py-0.5 font-mono text-[12px] font-medium text-accent transition hover:bg-accent/25"
        :class="isLocked ? 'cursor-not-allowed opacity-60' : ''"
        :title="isLocked
          ? '锁定镜不可改时长，请先解锁'
          : '点击修改时长；保存后本镜之后的所有镜头（含跨场）开始/结束时间自动顺延，台词时间同步平移'"
        @click.stop="openDurationEdit"
      >
        {{ shot.duration }}s
        <svg v-if="!isLocked" class="h-2.5 w-2.5 opacity-60 transition group-hover/dur:opacity-100" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
      </span>
      <button
        class="w-full rounded-control px-1 py-0.5 text-micro font-medium transition"
        :class="isCombat
          ? 'bg-danger/20 text-danger hover:bg-danger/30'
          : 'bg-info/20 text-info hover:bg-info/30'"
        :title="isCombat
          ? '武戏：出片加载打斗 LoRA。点击切换为文戏'
          : '文戏：出片不加载打斗 LoRA。点击切换为武戏'"
        @click.stop="toggleCombat"
      >{{ isCombat ? '武戏' : '文戏' }}</button>
      <button
        class="w-full rounded-control px-1 py-0.5 text-micro font-medium transition"
        :class="isLocked
          ? 'bg-warn/25 text-warn hover:bg-warn/35'
          : 'bg-bg-hover text-text-muted hover:text-text-secondary'"
        :title="isLocked
          ? '已锁定：整场重存/重置分镜时本镜跳过删除，删除前自动存版本表可回溯。点击解锁'
          : '锁定本镜：整场重存/重置分镜时不会被删，删除前自动存版本表'"
        @click.stop="toggleLock"
      >{{ isLocked ? '已锁定' : '锁定' }}</button>
      <button
        class="w-full rounded-control px-1 py-0.5 text-micro font-medium transition disabled:cursor-not-allowed disabled:opacity-40"
        :class="regenBusy
          ? 'bg-accent/25 text-accent'
          : 'bg-accent/10 text-accent hover:bg-accent/20'"
        :disabled="isLocked || regenBusy"
        :title="isLocked
          ? '锁定镜不可 AI 重写，请先解锁'
          : 'AI 单镜重写：保持时长与时轴不变，按前镜落帧承接、后镜出画约束、剧本片段与资产库重写本镜内容；已产出的分镜图/尾帧/站位/成片会被清空'"
        @click.stop="openRegen"
      >{{ regenBusy ? '重写中…' : '重写' }}</button>
      <button
        class="w-full rounded-control px-1 py-0.5 text-micro font-medium transition"
        :class="(versionsData?.versions?.length || shot.version > 1)
          ? 'bg-bg-hover text-text-secondary hover:text-text-primary'
          : 'bg-bg-hover text-text-muted hover:text-text-secondary'"
        title="查看本镜历史版本（重写/编辑/回退前自动存档），可对比后回退"
        @click.stop="openVersions"
      >版本</button>
    </div>
  </div>

  <Teleport to="body">
    <div v-if="showDescModal" class="fixed inset-0 z-[70] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm" @click.self="showDescModal = false">
      <div class="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-shell border border-border bg-bg-card shadow-pop">
        <div class="flex shrink-0 items-center justify-between border-b border-border px-5 py-3">
          <div class="flex items-center gap-3">
            <span class="rounded-tag bg-accent/20 px-2 py-0.5 text-xs font-medium text-accent">{{ shot.shotNumber || shot.id }}</span>
            <span class="text-[13px] font-medium text-text-primary">画面描述（完整）</span>
            <span class="text-xs text-text-muted">{{ shot.duration }}s · {{ shot.shotType }}</span>
          </div>
          <button @click="showDescModal = false" class="flex h-7 w-7 items-center justify-center rounded-btn text-text-muted hover:bg-bg-hover hover:text-text-primary">
            <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <div class="flex-1 overflow-auto px-5 py-4 text-sm leading-relaxed text-text-secondary whitespace-pre-wrap break-words">
          <template v-for="(seg, idx) in parsedDescription" :key="idx">
            <span v-if="seg.type === 'text'">{{ seg.content }}</span>
            <span v-else-if="seg.type === 'character'" class="inline-flex items-center gap-0.5 rounded-tag bg-warn/20 px-1 text-warn">{{ seg.content }}</span>
            <span v-else-if="seg.type === 'scene'" class="inline-flex items-center gap-0.5 rounded-tag bg-info/20 px-1 text-info">{{ seg.content }}</span>
            <span v-else-if="seg.type === 'prop'" class="inline-flex items-center gap-0.5 rounded-tag bg-orange-500/20 px-1 text-orange-300">{{ seg.content }}</span>
          </template>
        </div>
        <div class="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-2 text-xs text-text-muted">
          <button
            @click="navigator.clipboard.writeText(props.shot.description || '').then(() => { copied = true; setTimeout(() => copied = false, 1500) })"
            class="rounded-tag bg-accent/20 px-3 py-1 text-accent hover:bg-accent/30"
          >
            {{ copied ? '已复制' : '复制纯文本' }}
          </button>
          <button @click="showDescModal = false" class="rounded-tag bg-bg-hover px-3 py-1 text-text-muted hover:text-white">关闭</button>
        </div>
      </div>
    </div>

    <div v-if="showPromptModal" class="fixed inset-0 z-[70] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm" @click.self="showPromptModal = false">
      <div class="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-shell border border-border bg-bg-card shadow-pop">
        <div class="flex shrink-0 items-center justify-between border-b border-border px-5 py-3">
          <div class="flex items-center gap-3">
            <span class="rounded-tag bg-accent/20 px-2 py-0.5 text-xs font-medium text-accent">{{ shot.shotNumber || shot.id }}</span>
            <span class="text-[13px] font-medium text-text-primary">AI 视频 Prompt（6 模块结构化）</span>
            <span class="text-xs text-text-muted">{{ shot.duration }}s · {{ shot.shotType }}</span>
          </div>
          <button @click="showPromptModal = false" class="flex h-7 w-7 items-center justify-center rounded-btn text-text-muted hover:bg-bg-hover hover:text-text-primary">
            <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <div class="flex-1 space-y-4 overflow-y-auto p-5 text-xs">
          <section>
            <h4 class="mb-2 flex items-center gap-2 text-text-secondary">
              <span class="rounded-tag bg-info/20 px-1.5 py-0.5 text-micro font-medium text-info">主结构</span>
              <span>integrated_multimodal_description（图像六模块：镜头声明 / 风格与角色锁定 / 环境冻结声明 / 时间轴动作 / 道具专属声明 / 最终画面）</span>
            </h4>
            <pre class="whitespace-pre-wrap rounded-btn border border-border bg-bg-card p-3 font-mono text-[11px] leading-relaxed text-text-secondary">{{ shot.integratedMultimodalDescription }}</pre>
          </section>

          <section v-if="shot.finalFrame">
            <h4 class="mb-2 flex items-center gap-2 text-text-secondary">
              <span class="rounded-tag bg-warn/20 px-1.5 py-0.5 text-micro font-medium text-warn">Final Frame</span>
              <span>本镜最终画面（供下镜承接）</span>
            </h4>
            <pre class="whitespace-pre-wrap rounded-btn border border-border bg-bg-card p-3 font-mono text-[11px] leading-relaxed text-text-secondary">{{ shot.finalFrame }}</pre>
          </section>

          <section>
            <h4 class="mb-2 flex items-center gap-2 text-text-secondary">
              <span class="rounded-tag bg-accent/20 px-1.5 py-0.5 text-micro font-medium text-accent">叙事任务</span>
              <span>这一刀为什么存在（任务 / 目标 / 基调 / 信息点）</span>
              <button
                v-if="!narrativeEditing"
                class="ml-auto rounded-tag bg-bg-hover px-2 py-0.5 text-micro text-text-secondary transition hover:text-text-primary"
                @click="startNarrativeEdit"
              >编辑</button>
              <template v-else>
                <button
                  :disabled="narrativeSaving"
                  class="ml-auto rounded-tag bg-accent/20 px-2 py-0.5 text-micro font-medium text-accent transition hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-50"
                  @click="saveNarrative"
                >{{ narrativeSaving ? '保存中…' : '保存' }}</button>
                <button
                  :disabled="narrativeSaving"
                  class="rounded-tag bg-bg-hover px-2 py-0.5 text-micro text-text-muted transition hover:text-text-primary disabled:opacity-50"
                  @click="narrativeEditing = false"
                >取消</button>
              </template>
            </h4>

            <div v-if="!narrativeEditing" class="space-y-1.5 rounded-btn border border-border bg-bg-card p-3 text-xs leading-relaxed text-text-secondary">
              <div v-if="shot.purpose"><span class="text-text-muted">镜头任务：</span>{{ shot.purpose }}</div>
              <div v-if="shot.goal"><span class="text-text-muted">观众任务：</span>{{ shot.goal }}</div>
              <div v-if="shot.emotionTone"><span class="text-text-muted">情绪基调：</span>{{ shot.emotionTone }}</div>
              <div v-if="shot.infoPoints?.length"><span class="text-text-muted">信息点：</span>{{ shot.infoPoints.join('；') }}</div>
              <div v-if="shot.worldStateIn" class="border-t border-border/60 pt-1.5"><span class="text-text-muted">入场状态（承接上一镜）：</span>{{ shot.worldStateIn }}</div>
              <div v-if="shot.worldStateOut"><span class="text-text-muted">出场状态（本镜结束）：</span>{{ shot.worldStateOut }}</div>
              <div
                v-if="!shot.purpose && !shot.goal && !shot.emotionTone && !shot.infoPoints?.length && !shot.worldStateIn && !shot.worldStateOut"
                class="text-text-muted"
              >暂无叙事字段（旧分镜或 AI 未输出），点右上「编辑」补录</div>
            </div>

            <div v-else class="space-y-2.5 rounded-btn border border-border bg-bg-card p-3">
              <label class="block text-micro text-text-muted">
                镜头任务 purpose（这一刀为什么存在）
                <input v-model="narrativeForm.purpose" class="mt-1 w-full rounded-btn border border-border bg-bg-primary px-2 py-1.5 text-xs text-text-primary" placeholder="如：危机升级推动逃跑决定" />
              </label>
              <label class="block text-micro text-text-muted">
                观众任务 goal（本镜结束时观众获得什么）
                <input v-model="narrativeForm.goal" class="mt-1 w-full rounded-btn border border-border bg-bg-primary px-2 py-1.5 text-xs text-text-primary" placeholder="如：知道篮里装的是过冬食物" />
              </label>
              <label class="block text-micro text-text-muted">
                情绪基调
                <input v-model="narrativeForm.emotionTone" class="mt-1 w-full rounded-btn border border-border bg-bg-primary px-2 py-1.5 text-xs text-text-primary" placeholder="如：克制不安" />
              </label>
              <label class="block text-micro text-text-muted">
                信息点（用分号分隔多个）
                <input v-model="narrativeForm.infoPointsText" class="mt-1 w-full rounded-btn border border-border bg-bg-primary px-2 py-1.5 text-xs text-text-primary" placeholder="如：玩偶外观；两人站位关系" />
              </label>
            </div>
          </section>

          <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
            <section v-if="shot.overallSoundscape">
              <h4 class="mb-2 text-text-secondary">
                <span class="rounded-tag bg-ok/20 px-1.5 py-0.5 text-micro font-medium text-ok">环境声</span>
              </h4>
              <pre class="whitespace-pre-wrap rounded-btn border border-border bg-bg-card p-3 text-text-secondary">{{ shot.overallSoundscape }}</pre>
            </section>
            <section v-if="shot.nonDiegeticMusic">
              <h4 class="mb-2 text-text-secondary">
                <span class="rounded-tag bg-accent/20 px-1.5 py-0.5 text-micro font-medium text-accent">背景音乐</span>
              </h4>
              <pre class="whitespace-pre-wrap rounded-btn border border-border bg-bg-card p-3 text-text-secondary">{{ shot.nonDiegeticMusic }}</pre>
            </section>
            <section v-if="shot.dialogue">
              <h4 class="mb-2 text-text-secondary">
                <span class="rounded-tag bg-danger/20 px-1.5 py-0.5 text-micro font-medium text-danger">台词</span>
              </h4>
              <pre class="whitespace-pre-wrap rounded-btn border border-border bg-bg-card p-3 text-text-secondary">{{ Array.isArray(shot.dialogue) ? shot.dialogue.map((d) => `${d.character || ''}（${d.tone || ''}）：${d.text || ''}`).join('\n') : (typeof shot.dialogue === 'object' ? `${shot.dialogue.character || ''}（${shot.dialogue.tone || ''}）：${shot.dialogue.text || ''}` : shot.dialogue) }}</pre>
            </section>
            <section v-if="shot.actionNote">
              <h4 class="mb-2 text-text-secondary">
                <span class="rounded-tag bg-warn/20 px-1.5 py-0.5 text-micro font-medium text-warn">动作说明</span>
              </h4>
              <pre class="whitespace-pre-wrap rounded-btn border border-border bg-bg-card p-3 text-text-secondary">{{ shot.actionNote }}</pre>
            </section>
          </div>
        </div>
      </div>
    </div>
    <div v-if="showFrameModal" class="fixed inset-0 z-[70] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm" @click.self="showFrameModal = false">
      <div class="flex max-h-[85vh] max-w-[90vw] flex-col overflow-hidden rounded-shell border border-border bg-bg-card shadow-pop">
        <div class="flex shrink-0 items-center justify-between border-b border-border px-5 py-3">
          <div class="flex items-center gap-3">
            <span class="rounded-tag bg-accent/20 px-2 py-0.5 text-xs font-medium text-accent">{{ shot.shotNumber || shot.id }}</span>
            <span class="text-[13px] font-medium text-text-primary">分镜图</span>
            <span class="text-xs text-text-muted">{{ shot.duration }}s · {{ shot.shotType }} · 共 {{ frameImages.length }} 张</span>
          </div>
          <button @click="showFrameModal = false" class="flex h-7 w-7 items-center justify-center rounded-btn text-text-muted hover:bg-bg-hover hover:text-text-primary">
            <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <div class="flex flex-1 flex-col gap-4 overflow-auto p-4 md:flex-row">
          <div
            v-for="(img, idx) in frameImages"
            :key="img"
            class="flex flex-col items-center gap-2"
          >
            <img
              :src="img"
              :alt="`镜头 ${shot.id} 分镜图${idx + 1}`"
              class="max-h-[60vh] w-auto max-w-full rounded-btn object-contain"
            />
            <div class="flex shrink-0 items-center gap-2">
              <span
                class="rounded-tag px-2 py-0.5 text-micro font-medium"
                :class="idx === 0 ? 'bg-emerald-500/20 text-emerald-300' : 'bg-bg-hover text-text-muted'"
              >{{ idx === 0 ? '主图（参与视频参考）' : `候选 ${idx + 1}` }}</span>
              <button
                v-if="idx > 0"
                class="rounded-tag bg-accent/20 px-2 py-0.5 text-micro font-medium text-accent hover:bg-accent/30"
                @click="setPrimary(idx)"
              >设为主图</button>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div v-if="showKeyframeModal" class="fixed inset-0 z-[70] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm" @click.self="showKeyframeModal = false">
      <div class="flex max-h-[85vh] max-w-[90vw] flex-col overflow-hidden rounded-shell border border-border bg-bg-card shadow-pop">
        <div class="flex shrink-0 items-center justify-between border-b border-border px-5 py-3">
          <div class="flex items-center gap-3">
            <span class="rounded-tag bg-accent/20 px-2 py-0.5 text-xs font-medium text-accent">{{ shot.shotNumber || shot.id }}</span>
            <span class="text-[13px] font-medium text-text-primary">尾帧锚（本镜结束画面）</span>
            <span class="text-xs text-text-muted">{{ shot.duration }}s · {{ shot.shotType }}</span>
          </div>
          <button @click="showKeyframeModal = false" class="flex h-7 w-7 items-center justify-center rounded-btn text-text-muted hover:bg-bg-hover hover:text-text-primary">
            <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <div class="flex flex-1 flex-col gap-3 overflow-auto p-4">
          <img
            :src="keyframeImage"
            :alt="`镜头 ${shot.id} 尾帧锚`"
            class="max-h-[60vh] w-auto max-w-full self-center rounded-btn object-contain"
          />
          <div v-if="shot.finalFrame" class="rounded-btn border border-border bg-bg-secondary/50 p-3">
            <div class="mb-1.5 text-micro font-medium text-warn">本镜最终画面描述（出图依据）</div>
            <p class="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-text-secondary">{{ shot.finalFrame }}</p>
          </div>
        </div>
      </div>
    </div>

    <div v-if="showRegenModal" class="fixed inset-0 z-[70] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm" @click.self="!regenBusy && (showRegenModal = false)">
      <div class="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-shell border border-border bg-bg-card shadow-pop">
        <div class="flex shrink-0 items-center justify-between border-b border-border px-5 py-3">
          <div class="flex items-center gap-3">
            <span class="rounded-tag bg-accent/20 px-2 py-0.5 text-xs font-medium text-accent">{{ shot.shotNumber || shot.id }}</span>
            <span class="text-[13px] font-medium text-text-primary">AI 重写本镜</span>
            <span class="text-xs text-text-muted">{{ shot.duration }}s · {{ shot.shotType }}</span>
          </div>
          <button :disabled="regenBusy" @click="showRegenModal = false" class="flex h-7 w-7 items-center justify-center rounded-btn text-text-muted transition hover:bg-bg-hover hover:text-text-primary disabled:opacity-40">
            <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <div class="flex-1 space-y-3 overflow-y-auto p-5">
          <div class="rounded-btn border border-info/30 bg-info/5 p-3 text-xs leading-relaxed text-text-secondary">
            <div class="mb-1 font-medium text-info">重写规则</div>
            <ul class="list-disc space-y-0.5 pl-4">
              <li>时长 {{ shot.duration }}s 与时间轴位置<b>保持不变</b>，只重写内容</li>
              <li>自动承接前镜结尾画面与后镜出画约束，角色/场景外形锁定资产库设定</li>
              <li>重写前当前内容自动存入历史版本，可随时回退</li>
              <li>本镜已产出的分镜图 / 尾帧锚 / 站位图 / 成片会被<b>清空</b>，需重新生成</li>
            </ul>
          </div>
          <label class="block text-micro text-text-muted">
            重写指令（可选，留空则按原意重写）
            <textarea
              v-model="regenInstruction"
              rows="3"
              class="mt-1 w-full resize-none rounded-btn border border-border bg-bg-primary px-2 py-1.5 text-xs text-text-primary placeholder:text-text-muted/60 focus:border-accent/50 focus:outline-none"
              placeholder="如：动作节奏放慢一些；台词改成疑问语气；让情绪更克制"
              :disabled="regenBusy"
            ></textarea>
          </label>
          <div v-if="regenError" class="rounded-btn border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{{ regenError }}</div>
          <div v-if="regenBusy" class="flex items-center gap-2 text-xs text-accent">
            <svg class="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
            AI 重写中，约 30~90 秒…
          </div>
        </div>
        <div class="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-3 text-xs">
          <button :disabled="regenBusy" @click="showRegenModal = false" class="rounded-tag bg-bg-hover px-3 py-1.5 text-text-muted transition hover:text-text-primary disabled:opacity-40">取消</button>
          <button
            :disabled="regenBusy"
            @click="submitRegen"
            class="rounded-tag bg-accent/20 px-3 py-1.5 font-medium text-accent transition hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-50"
          >{{ regenBusy ? '重写中…' : '开始重写' }}</button>
        </div>
      </div>
    </div>

    <div v-if="showVersionsModal" class="fixed inset-0 z-[70] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm" @click.self="!restoringId && (showVersionsModal = false)">
      <div class="flex max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-shell border border-border bg-bg-card shadow-pop">
        <div class="flex shrink-0 items-center justify-between border-b border-border px-5 py-3">
          <div class="flex items-center gap-3">
            <span class="rounded-tag bg-accent/20 px-2 py-0.5 text-xs font-medium text-accent">{{ shot.shotNumber || shot.id }}</span>
            <span class="text-[13px] font-medium text-text-primary">历史版本</span>
            <span class="text-xs text-text-muted">当前 v{{ versionsData?.current?.version || shot.version || 1 }}</span>
          </div>
          <button :disabled="!!restoringId" @click="showVersionsModal = false" class="flex h-7 w-7 items-center justify-center rounded-btn text-text-muted transition hover:bg-bg-hover hover:text-text-primary disabled:opacity-40">
            <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <div class="flex min-h-0 flex-1">
          <div class="w-60 shrink-0 space-y-1 overflow-y-auto border-r border-border p-2.5">
            <div class="rounded-btn border border-ok/40 bg-ok/10 px-2.5 py-2">
              <div class="flex items-center gap-1.5 text-xs font-medium text-ok">
                <span>v{{ versionsData?.current?.version || shot.version || 1 }}</span>
                <span class="rounded-tag bg-ok/20 px-1 text-micro">当前</span>
              </div>
              <div class="mt-0.5 text-micro text-text-muted">{{ versionsData?.current?.shot?.duration || shot.duration }}s · {{ fmtTime(versionsData?.current?.shot?.created_at) }}</div>
            </div>
            <div v-if="versionsLoading" class="px-2 py-3 text-center text-micro text-text-muted">加载版本中…</div>
            <div v-else-if="!(versionsData?.versions || []).length" class="px-2 py-3 text-center text-micro text-text-muted">暂无历史版本</div>
            <button
              v-for="v in versionsData?.versions || []"
              :key="v.id"
              class="w-full rounded-btn border px-2.5 py-2 text-left transition"
              :class="selectedVersionId === v.id
                ? 'border-accent/60 bg-accent/10'
                : 'border-border bg-bg-primary/40 hover:border-border-light hover:bg-bg-hover'"
              :disabled="!!restoringId"
              @click="selectedVersionId = v.id"
            >
              <div class="flex items-center gap-1.5 text-xs font-medium" :class="selectedVersionId === v.id ? 'text-accent' : 'text-text-secondary'">
                <span>v{{ v.version }}</span>
                <span class="rounded-tag bg-bg-hover px-1 text-micro text-text-muted">{{ v.editedBy === 'ai' ? 'AI' : (v.editedBy === 'manual' ? '人工' : (v.editedBy || '—')) }}</span>
              </div>
              <div class="mt-0.5 text-micro text-text-muted">{{ reasonLabel(v.reason) }} · {{ fmtTime(v.createdAt) }}</div>
            </button>
          </div>
          <div class="min-w-0 flex-1 space-y-3 overflow-y-auto p-4">
            <div v-if="versionsError" class="rounded-btn border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{{ versionsError }}</div>
            <template v-if="selectedVersion">
              <div v-if="snapDiff.length" class="rounded-btn border border-warn/30 bg-warn/5 p-3">
                <div class="mb-1.5 text-micro font-medium text-warn">与当前的差异</div>
                <div class="space-y-1">
                  <div v-for="row in snapDiff" :key="row.label" class="flex gap-2 text-xs leading-relaxed">
                    <span class="w-16 shrink-0 text-text-muted">{{ row.label }}</span>
                    <span class="text-text-secondary">{{ row.text }}</span>
                  </div>
                </div>
              </div>
              <div v-else class="rounded-btn border border-ok/30 bg-ok/5 px-3 py-2 text-xs text-ok">与当前内容一致（无差异）</div>
              <section>
                <h4 class="mb-1.5 text-micro font-medium text-text-secondary">画面描述（快照全文）</h4>
                <pre class="whitespace-pre-wrap rounded-btn border border-border bg-bg-primary/40 p-3 text-xs leading-relaxed text-text-secondary">{{ selectedVersion.snapshot?.description || '（空）' }}</pre>
              </section>
              <section v-if="selectedVersion.snapshot?.final_frame">
                <h4 class="mb-1.5 text-micro font-medium text-text-secondary">最终画面（快照）</h4>
                <pre class="whitespace-pre-wrap rounded-btn border border-border bg-bg-primary/40 p-3 text-xs leading-relaxed text-text-secondary">{{ selectedVersion.snapshot.final_frame }}</pre>
              </section>
              <section v-if="snapDialogueText">
                <h4 class="mb-1.5 text-micro font-medium text-text-secondary">台词（快照）</h4>
                <pre class="whitespace-pre-wrap rounded-btn border border-border bg-bg-primary/40 p-3 text-xs leading-relaxed text-text-secondary">{{ snapDialogueText }}</pre>
              </section>
            </template>
            <div v-else-if="!versionsLoading" class="flex h-full items-center justify-center text-micro text-text-muted">选择左侧版本查看快照</div>
          </div>
        </div>
        <div class="flex shrink-0 items-center justify-between gap-2 border-t border-border px-5 py-3 text-xs">
          <span class="text-text-muted">回退前会先把当前内容存入历史版本（回退本身可撤销）</span>
          <div class="flex items-center gap-2">
            <button :disabled="!!restoringId" @click="showVersionsModal = false" class="rounded-tag bg-bg-hover px-3 py-1.5 text-text-muted transition hover:text-text-primary disabled:opacity-40">关闭</button>
            <button
              :disabled="!selectedVersion || !!restoringId || isLocked"
              :title="isLocked ? '锁定镜不可回退版本，请先解锁' : '把本镜内容恢复为选中版本的快照'"
              @click="restoreVersion"
              class="rounded-tag bg-accent/20 px-3 py-1.5 font-medium text-accent transition hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-50"
            >{{ restoringId ? '回退中…' : `回退到 v${selectedVersion?.version ?? ''}` }}</button>
          </div>
        </div>
      </div>
    </div>

    <div v-if="showDurationModal" class="fixed inset-0 z-[70] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm" @click.self="!durationSaving && (showDurationModal = false)">
      <div class="flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-shell border border-border bg-bg-card shadow-pop">
        <div class="flex shrink-0 items-center justify-between border-b border-border px-5 py-3">
          <div class="flex items-center gap-3">
            <span class="rounded-tag bg-accent/20 px-2 py-0.5 text-xs font-medium text-accent">{{ shot.shotNumber || shot.id }}</span>
            <span class="text-[13px] font-medium text-text-primary">修改时长</span>
            <span class="text-xs text-text-muted">当前 {{ shot.duration }}s · {{ shot.startTime }}s–{{ shot.endTime }}s</span>
          </div>
          <button :disabled="durationSaving" @click="showDurationModal = false" class="flex h-7 w-7 items-center justify-center rounded-btn text-text-muted transition hover:bg-bg-hover hover:text-text-primary disabled:opacity-40">
            <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <div class="flex-1 space-y-3 p-5">
          <label class="block text-micro text-text-muted">
            新时长（秒）
            <input
              v-model="durationForm"
              type="number"
              min="1"
              step="0.5"
              class="mt-1 w-full rounded-btn border border-border bg-bg-primary px-2 py-1.5 text-xs text-text-primary focus:border-accent/50 focus:outline-none"
              :disabled="durationSaving"
            />
          </label>
          <div class="rounded-btn border border-info/30 bg-info/5 p-3 text-xs leading-relaxed text-text-secondary">
            <div class="mb-1 font-medium text-info">保存后自动顺延</div>
            本镜之后的所有镜头（含跨场）开始/结束时间按差值自动平移，台词时间同步调整；后续镜头如已锁定，其时间轴仍会被顺延（锁定冻结的是内容，不是时轴）。
          </div>
          <div class="text-micro text-text-muted">时长过短或过长不阻止保存（分镜质检已移除，时长由生成规则与出片预算约束）。</div>
          <div v-if="durationError" class="rounded-btn border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{{ durationError }}</div>
        </div>
        <div class="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-3 text-xs">
          <button :disabled="durationSaving" @click="showDurationModal = false" class="rounded-tag bg-bg-hover px-3 py-1.5 text-text-muted transition hover:text-text-primary disabled:opacity-40">取消</button>
          <button
            :disabled="durationSaving"
            @click="saveDuration"
            class="rounded-tag bg-accent/20 px-3 py-1.5 font-medium text-accent transition hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-50"
          >{{ durationSaving ? '保存中…' : '保存并顺延' }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
