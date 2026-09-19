<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { useProjectStore } from '../stores/project'
import BlockingChart from './BlockingChart.vue'
import { api } from '../services/api'

const props = defineProps({
  shot: { type: Object, required: true },
  // 行序号，用于斑马纹（奇数行浅底色），由父级 v-for 传入
  index: { type: Number, default: 0 },
  // 是否显示「成片」列（默认显示；分镜本编辑页传 false 隐藏。时长列作为分镜信息始终显示，不受此控制）
  // 出片/预览统一在 VideoView 短片创作页完成，避免编辑页与出片页功能重叠）
  showVideo: { type: Boolean, default: true },
  // 质检面板点镜头号后高亮该行（2 秒后由父级清除）。纯展示态，本组件不改任何数据
  highlighted: { type: Boolean, default: false },
})

const store = useProjectStore()
const showPromptModal = ref(false)

// 戏型（文戏/武戏）：决定出片时打斗 LoRA 是否加载。null=未判定，出片时后端按内容自动判
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
const showDescModal = ref(false)
const copied = ref(false)

const charColors = {
  一二: '#6b9bd1',
  布布: '#e8a849',
}

// 获取角色详情（含图片）
function getCharacter(name) {
  return store.characters.find(c => c.name === name) || null
}

// 获取场景详情（含图片）
function getScene(name) {
  return store.assetScenes.find(s => s.name === name) || null
}

// 获取道具详情（含图片）
function getProp(name) {
  return store.props.find(p => p.name === name) || null
}

// 获取资产图片 URL
function getAssetImage(asset) {
  return asset?.imageUrl || asset?.image_url || ''
}

// 顶部统计：图片/视频/音频数量
const assetStats = computed(() => {
  const charCount = props.shot.characters?.length || 0
  const sceneCount = props.shot.sceneAssets?.length || 0
  const propCount = props.shot.propAssets?.length || 0
  const imageCount = charCount + sceneCount + propCount
  const audioCount = (props.shot.characters || []).filter(name => !!getCharacter(name)?.audioUrl).length
  const videoCount = props.shot.videoUrl ? 1 : 0
  return { imageCount, videoCount, audioCount }
})

// 解析 description，把 @角色 @场景 @道具 拆分成高亮片段
const parsedDescription = computed(() => {
  const text = props.shot.description || ''
  const allNames = [
    ...(props.shot.characters || []).map(n => ({ name: n, type: 'character' })),
    ...(props.shot.sceneAssets || []).map(n => ({ name: n, type: 'scene' })),
    ...(props.shot.propAssets || []).map(n => ({ name: n, type: 'prop' })),
  ]
  // 按名称长度降序，避免短名先匹配
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

// 站位图是否有内容（程序化 plan / 旧 blockingUrl / 演示标记）
const hasBlockingContent = computed(
  () => !!props.shot.blockingPlan || !!props.shot.blockingUrl || props.shot.hasBlocking
)

const chartRef = ref(null)
function regenerateBlocking() {
  // 优先用程序化站位图（LLM 出结构化 JSON，SVG 渲染）；保留旧 blockingUrl 兼容
  store.generateBlocking(props.shot.id)
}
function zoomBlocking() {
  // 仅在有站位图数据时打开放大视图
  if (props.shot.blockingPlan) chartRef.value?.open()
}

// ===== 成片（跟随全局 videoModel：标准 / 增强 / 未来其他视频 API）=====
const generatingVideo = computed(() => store.generatingVideoIds.includes(props.shot.id))
const videoBtnText = computed(() =>
  generatingVideo.value ? '出片中...' : (props.shot.videoUrl ? '重新出片' : '生成成片')
)
const videoPhaseText = '云端生成中，约 3~15 分钟'
function generateVideo() {
  // 与短片页一致走统一入口：出片引擎 = 页面上方/设定里的全局 videoModel
  store.generateShotVideoByModel(props.shot.id)
}

// ===== 分镜图（frame）：带角色/场景参考图的多图生图 =====
// 历史故事板（storyboard_url）已下线，分镜图统一用 frame_url。
// 每次生成产出 2 张：frameUrl 为主图（参与下游视频参考），frameUrl2 为第二候选
const frameImage = computed(() => props.shot.frameUrl || '')
const frameImages = computed(() => {
  const list = [frameImage.value]
  if (props.shot.frameUrl2) list.push(props.shot.frameUrl2)
  return list.filter(Boolean)
})
const showFrameModal = ref(false)
function generateFrame() {
  // 分镜图跟随全局模型选择（zikl / Visionary）
  store.generateShotImage(props.shot.id, 'frame', store.imageModel)
}
// 单镜头出 2x2 四宫格：4 格 = 同一镜头的 4 个时间瞬间，整张作为该镜分镜图
const shotGridLoading = computed(() => store.generatingShotGridIds.includes(props.shot.id))
// ===== 四宫格出图状态：生成中（含已耗时）/ 失败（红标，点击清除）=====
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
// 把第 idx 张设为主图（与第二张交换位置，落库）
async function setPrimary(idx) {
  if (idx === 0) return
  await store.setPrimaryFrame(props.shot.id, idx + 1)
}

// ===== 质检角标（2026-09-16）=====
// 数据来自 store.qcReport.shotIndex（由后端 buildQcReport 生成：镜头号 → 命中的 code 列表）。
// 前端只做展示，不判断"哪个 code 算严重"——级别由后端 qcCodes 注册表给。
const qcCodes = computed(() => store.qcCodesForShot(props.shot.shotNumber))
const qcHasError = computed(() => store.qcHasErrorForShot(props.shot.shotNumber))
// 悬停提示：把该镜命中的问题标题列出来（标题也来自后端分组，前端不硬编码文案）
const qcTitle = computed(() => {
  if (!qcCodes.value.length) return ''
  const groups = store.qcReport?.groups || []
  const lines = qcCodes.value.map((c) => {
    const g = groups.find((x) => x.code === c)
    const n = g?.items?.filter((it) => it.shot === String(props.shot.shotNumber || '')).length || 0
    return `${g?.title || c}${n > 1 ? ` ×${n}` : ''}${g?.level === 'error' ? '（必须修）' : ''}`
  })
  return `该镜质检问题（${qcCodes.value.length} 类）：\n${lines.join('\n')}`
})

// ===== 尾帧锚（keyframe）：本镜结束画面，由 finalFrame 一键出图（2026-09-16）=====
// 与分镜图（frameUrl＝本镜开头）成对：两张都在，下一镜的接缝才在画面上真正接得上。
const keyframeImage = computed(() => props.shot.keyframeUrl || '')
const keyframeLoading = computed(() => store.generatingKeyframeIds.includes(props.shot.id))
const showKeyframeModal = ref(false)
const canGenerateKeyframe = computed(() => !!(props.shot.finalFrame || '').trim())
function generateKeyframe() {
  store.generateShotImage(props.shot.id, 'keyframe', store.imageModel)
}

// 悬浮卡开合（状态灯 / 资产统计条共用）。
// 点灯的状态灯只有 6px，无法承载文字，所以四个点的含义靠悬浮卡补全——
// 不展开时保持"扫一眼"的低噪音，需要时鼠标停一下就知道每个点的名字。
const hovKey = ref('')
function hovEnter(key) { hovKey.value = key }
function hovLeave(key) { if (hovKey.value === key) hovKey.value = '' }

// 状态灯悬浮卡：把四个点翻译成文字行（名字 + 已就绪/待产出/失败）。
// 顺序与右侧四列完全一致，鼠标停在任意一个点上都能读到全套映射。
const statusDetail = computed(() => {
  const qc = qcCodes.value.length
  return {
    stateRows: statusDots.value.map((d) => ({
      key: d.key,
      label: d.label,
      text: d.failed ? '生成失败' : d.done ? '已就绪' : '待产出',
      cls: d.failed ? 'text-danger' : d.done ? 'text-ok' : 'text-text-muted',
    })),
    qc,
    qcHasError: qcHasError.value,
  }
})

// 资产统计条悬浮卡：三个计数（图/视/音）分别指向哪类资产。
// 资产统计条悬浮卡的「已绑定」行：只列出真的有绑定的类别。
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


// 把三路产出物的完成情况压成一组小圆点，替代原来散落各处的角标。
// 语义：实心=已就绪，描边=未产出，红=失败需处置，不做「正在生成」态（进度条另有地方显示）。
// 顺序固定为 图 / 尾 / 位 / 片，与右侧四列（分镜图/尾帧锚/站位图/成片）一一对应，
// 用户从状态灯读到缺哪项，视线右移就能找到那一列，不用记图标含义。
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
// 未完成项汇总，用于 title 提示与「待办」计数徽章
const pendingLabels = computed(() =>
  statusDots.value.filter((d) => !d.done).map((d) => d.label)
)
const statusTitle = computed(() => {
  const failed = statusDots.value.filter((d) => d.failed).map((d) => d.label)
  const parts = []
  if (failed.length) parts.push(`失败：${failed.join('、')}`)
  if (pendingLabels.value.length) parts.push(`待产出：${pendingLabels.value.join('、')}`)
  if (!parts.length) parts.push('四路产出物齐全')
  if (qcCodes.value.length) parts.push(`质检问题 ${qcCodes.value.length} 类`)
  return parts.join('\n')
})

</script>

<template>
  <!-- 镜头行：网格列宽与分镜页列头严格对齐（52/200/minmax/156/156/156/56）
       data-shot-number 供质检面板滚动定位（面板不碰 DOM，靠这个锚点找到行） -->
  <div
    :data-shot-number="shot.shotNumber || ''"
    class="group/row grid grid-cols-[52px_200px_minmax(280px,1fr)_156px_156px_156px_56px] items-stretch gap-3 border-b border-border/60 px-4 py-3 transition-colors duration-150 last:border-b-0 hover:bg-bg-hover/40"
    :class="[
      index % 2 === 1 ? 'bg-bg-primary/40' : '',
      highlighted ? 'ring-2 ring-inset ring-accent bg-accent/10' : '',
    ]"
  >
    <!-- 镜头号 + 状态灯：状态灯让「这个镜头缺什么」一眼可辨，不必逐列去看 -->
    <div class="flex flex-col items-start gap-1.5 pt-0.5">
      <span class="rounded-control border border-border bg-bg-primary/70 px-1.5 py-0.5 font-mono text-micro font-medium text-text-secondary transition group-hover/row:border-accent/50 group-hover/row:text-accent">
        {{ shot.shotNumber || shot.displayId || shot.id }}
      </span>

      <!-- 状态灯：图/尾/位/片 四路产出，实心=就绪、描边=待产出、红=失败。
           6px 的点放不下文字，故悬浮出一张映射卡：四个点分别叫什么、现在什么状态。
           卡里同时带出质检问题，省去用户去别处找。 -->
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

        <!-- 悬浮卡：状态灯 vs 右侧四列 的映射表（顺序一一对应） -->
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
          <div v-if="statusDetail.qc" class="mt-1.5 flex items-center gap-2 whitespace-nowrap border-t border-border pt-1.5 text-micro">
            <span class="w-12 shrink-0 text-text-secondary">质检</span>
            <span :class="statusDetail.qcHasError ? 'text-danger' : 'text-warn'">
              {{ statusDetail.qc }} 处{{ statusDetail.qcHasError ? '必须修' : '建议改' }}
            </span>
          </div>
        </div>
      </div>

      <!-- 待产出计数：只在有缺口时出现。
           原来写 "0/4" 会被读成「第 0 个 / 共 4 个」，含义歧义；
           改成「缺 4」——直接说还差几项，动词在前不产生计数误读。 -->
      <span
        v-if="pendingLabels.length"
        class="rounded-tag bg-bg-hover px-1 text-micro leading-snug text-text-muted"
        :title="`待产出：${pendingLabels.join('、')}`"
      >缺 {{ pendingLabels.length }}</span>

      <!-- 质检角标：命中问题才出现。error 红、warning 黄，级别由后端判定 -->
      <span
        v-if="qcCodes.length"
        class="inline-flex items-center gap-0.5 rounded-control border px-1 py-0.5 text-micro font-medium"
        :class="qcHasError
          ? 'border-danger/40 bg-danger/10 text-danger'
          : 'border-warn/40 bg-warn/10 text-warn'"
        :title="qcTitle"
      >
        <svg class="h-2.5 w-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 9v2m0 4h.01M4.5 19h15a1.5 1.5 0 001.3-2.25l-7.5-13a1.5 1.5 0 00-2.6 0l-7.5 13A1.5 1.5 0 004.5 19z" /></svg>
        {{ qcCodes.length }}
      </span>
    </div>

    <!-- 美术资产：角色 / 场景 / 道具，统一 3 组扁平标签 -->
    <div class="space-y-2">
      <!-- 资产统计条：图/视/音计数。
           三个色点本身不表意（图/视/音 文字已说明），悬浮卡补的是
           「这三类资产分别绑在谁身上」——角色/场景/道具的归属关系。 -->
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

        <!-- 悬浮卡：资产构成（绑定关系 + 已生成的媒体数量） -->
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

      <!-- 角色 -->
      <div v-if="shot.characters?.length" class="space-y-1">
        <div class="text-micro text-text-muted">角色</div>
        <div class="flex flex-wrap gap-1">
          <div
            v-for="name in shot.characters"
            :key="name"
            class="flex items-center gap-1 overflow-hidden rounded-control border border-border bg-bg-card transition hover:border-border-light"
          >
            <span class="h-5 w-0.5 shrink-0 rounded-full" :style="{ background: getCharacter(name)?.color || charColors[name] || '#7E7E8C' }"></span>
            <div class="h-5 w-5 shrink-0 overflow-hidden rounded-[6px] bg-bg-hover">
              <img v-if="getAssetImage(getCharacter(name))" :src="getAssetImage(getCharacter(name))" class="h-full w-full object-cover" />
              <div v-else class="flex h-full w-full items-center justify-center text-micro text-text-muted">{{ name.charAt(0) }}</div>
            </div>
            <span class="pr-1.5 text-micro text-text-secondary">{{ name }}</span>
          </div>
        </div>
      </div>

      <!-- 场景 -->
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

      <!-- 道具 -->
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

    <!-- 画面描述 + 镜头标签 + AI 提示词入口 -->
    <div class="flex min-h-[112px] flex-col rounded-btn border border-border bg-bg-card p-2.5">
      <!-- 描述文本：点击看全文 -->
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

      <!-- 镜头标签条：只保留高价值信息，避免小徽章堆砌 -->
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

        <!-- 提示词状态：齐全 → 一个入口按钮；缺失 → 醒目标记 -->
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

    <!-- 分镜图列 -->
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

        <!-- 生成中 -->
        <div v-if="store.generatingStoryboardIds.includes(shot.id) || store.batchStoryboardGenerating" class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/75 backdrop-blur-sm">
          <svg class="h-5 w-5 animate-spin text-accent" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
          <span class="text-micro text-white">生成中...</span>
        </div>

        <!-- 四宫格出图 -->
        <div v-else-if="shotGridLoading" class="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/75 backdrop-blur-sm">
          <svg class="h-5 w-5 animate-spin text-accent" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
          <span class="text-micro font-medium text-text-primary">出四宫格中 {{ shotGridElapsed }}</span>
          <span class="text-micro text-white/60">约 1~3 分钟</span>
        </div>

        <!-- 操作层去掉了 hover 浮层：
             原来「放大」（免费、随手）与「出四宫格」（花钱、要等 1~3 分钟）挤在同一个
             淡入浮层里，权重相同且都不可发现。现在拆开——
             看：点图即放大（图片本体已是 cursor-zoom-in）；
             出：沉到下方常驻状态条，与状态并排，始终可见。 -->
      </div>

      <!-- 状态条：常驻可点，不依赖 hover（可达性）。
           左边读状态、右边做出图动作，中间用 ml-auto 隔开，避免误点花钱按钮。 -->
      <div class="mt-1.5 flex shrink-0 items-center gap-1 border-t border-border/50 pt-1.5 text-micro">
        <span
          class="rounded-tag px-1.5"
          :class="frameImage ? 'bg-ok/15 text-ok' : 'text-text-muted'"
        >{{ frameImage ? '已出图' : '未出图' }}</span>
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

        <!-- 出图：主操作（花钱），有图时是「重出」。用 outline 而非实心，
             避免与页面唯一的实心主操作（批量生成）抢注意力。 -->
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
    </div>

    <!-- 尾帧锚列（keyframe）：本镜结束画面，与左列分镜图（本镜开头）成对。
         有图 → 显示并可放大；无图 → 一键由 final_frame 出图（final_frame 为空则禁用并说明原因）。 -->
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

        <!-- 生成中遮罩 -->
        <div v-if="keyframeLoading" class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/75 backdrop-blur-sm">
          <svg class="h-5 w-5 animate-spin text-accent" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
          <span class="text-micro text-white">出尾帧中...</span>
        </div>

        <!-- 操作层同「分镜图列」：撤掉 hover 浮层，看=点图、出=常驻状态条 -->
      </div>

      <!-- 状态条 -->
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

    <!-- 站位图列 -->
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

        <!-- 操作层同前两列：撤掉 hover 浮层，看=点图、出=常驻状态条 -->
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

    <!-- 成片列（分镜本编辑页隐藏，出片统一在短片页完成） -->
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
        :title="generatingVideo ? '出片中，约 3~15 分钟' : `单镜出片（${shot.duration}s，按 RunningHub 计费）`"
        @click.stop="generateVideo"
      >{{ videoBtnText }}</button>
    </div>

    <!-- 时长 + 戏型 -->
    <div class="flex flex-col items-center gap-1.5 pt-1">
      <span class="rounded-control bg-accent/15 px-2 py-0.5 font-mono text-[12px] font-medium text-accent">
        {{ shot.duration }}s
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
    </div>
  </div>

  <!-- AI Prompt 全屏查看（6 模块结构化描述 + 多模态字段） -->
  <Teleport to="body">
    <!-- 描述完整内容弹窗（点击卡片描述区触发；保留 @角色/场景/道具 高亮，可选中复制） -->
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
          <!-- integrated_multimodal_description（6 模块主结构） -->
          <section>
            <h4 class="mb-2 flex items-center gap-2 text-text-secondary">
              <span class="rounded-tag bg-info/20 px-1.5 py-0.5 text-micro font-medium text-info">主结构</span>
              <span>integrated_multimodal_description（含 Airlock 继承 / 视觉锁定 / 环境冻结 / 动作微分解 / 道具专属 / 最终画面）</span>
            </h4>
            <pre class="whitespace-pre-wrap rounded-btn border border-border bg-bg-card p-3 font-mono text-[11px] leading-relaxed text-text-secondary">{{ shot.integratedMultimodalDescription }}</pre>
          </section>

          <!-- finalFrame -->
          <section v-if="shot.finalFrame">
            <h4 class="mb-2 flex items-center gap-2 text-text-secondary">
              <span class="rounded-tag bg-warn/20 px-1.5 py-0.5 text-micro font-medium text-warn">Final Frame</span>
              <span>本镜最终画面（供下镜 Airlock 继承）</span>
            </h4>
            <pre class="whitespace-pre-wrap rounded-btn border border-border bg-bg-card p-3 font-mono text-[11px] leading-relaxed text-text-secondary">{{ shot.finalFrame }}</pre>
          </section>

          <!-- 声景 / 音乐 / 台词 -->
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
    <!-- 分镜图放大查看（两张候选，可切换主图） -->
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
    <!-- 尾帧锚放大查看 -->
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
          <!-- 与尾帧锚对应的文字依据：让人能核对"图跟描述是否一致" -->
          <div v-if="shot.finalFrame" class="rounded-btn border border-border bg-bg-secondary/50 p-3">
            <div class="mb-1.5 text-micro font-medium text-warn">本镜最终画面描述（出图依据）</div>
            <p class="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-text-secondary">{{ shot.finalFrame }}</p>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
