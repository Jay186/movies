<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useProjectStore } from '../stores/project'
import { api } from '../services/api'
import {
  confirmDialog, toast, toastInfo, toastSuccess, toastWarn, toastError,
} from '../services/dialog'
import { VIDEO_ENGINES, getVideoEngine } from '../data/videoEngines'
import { ASPECT_RATIO_OPTIONS } from '../constants/app'

const store = useProjectStore()

// ── 弹出面板状态 ──
// settingsOpen：出片设置（比例/BGM/转场）从工具栏收纳进弹出面板，减少常驻控件数
// segmentPanelOpen：段级出片面板默认折叠，展开才显示段计划与按场按钮
const settingsOpen = ref(false)
const segmentPanelOpen = ref(false)
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
// ===== 出片粒度（E路线v2 + 切片回填，2026-09-15 定稿）=====
// 段是**生成包装层**：后端把相邻镜拼成一段（4–15s，H3 单次上限）一次性生成，
// 出片成功后**按镜边界切片回填 shots.video_url**——每镜有自己的 mp4。
//
// 所以界面只认 shots.video_url，不做段级播放：
//   · 卡片/播放器/导出全部是「一镜一片」，不会出现"1-1 和 1-2 播同一视频"
//   · 段信息（segmentLabel）只作为**来源提示**保留（让用户知道这镜是和谁一起生成的），
//     不参与播放逻辑。segmentVideoUrl 仅作降级兜底：切片失败时卡片仍能看整段成片，
//     此时徽章显示「段成片·未切片」提醒需要补切（POST /episodes/:id/segments/slice）。
const displayVideoUrl = (shot) => shot.videoUrl || ''
// 切片兜底：镜级切片缺失但段成片在 → 播段成片（只有切片失败/未跑时才会出现）
const fallbackSegUrl = (shot) => (shot.videoUrl ? '' : shot.segmentVideoUrl || '')
const displayFallbackOffset = (shot) => (shot.videoUrl ? 0 : Number(shot.segmentOffset) || 0)
const isFallbackOnly = (shot) => !shot.videoUrl && !!shot.segmentVideoUrl
const hasDisplayVideo = (shot) => !!(shot.videoUrl || shot.videoGenerated || shot.segmentVideoUrl)
// 段来源提示：本镜所属段（仅展示用，不影响播放）
const segmentTip = (shot) => (shot.segmentLabel ? `本镜与 ${shot.segmentLabel} 同批生成（段级出片，已按镜切片）` : '')
// 进度口径要与筛选条一致，否则会出现「顶部说 5/44 已生成、筛选条说单独出片 0」的自相矛盾。
// playableCount = 有画面可播（含仅切片兜底）：用于进度条，代表"这段能看了"
// shotVideoCount = 本镜独立出片：用于「全部出片」判定，代表"这一镜真做完了"
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
// 衔接质量检测（#3）：出片后后端与本镜锚帧（continuity_url）比对色温/亮度，超阈值时 alert=true
// 锁3 开场色向闸（checkType='openerTone'）：无锚开场镜改比首帧 R-B 与色调家族带宽
// ⚠️ 两个告警判定都必须挂在「本镜有画面」之上（2026-09-16 修）：
// seamCheck / shotReview 是**针对某一版成片**的检测结论（观片闸打分、接缝色温亮度差）。
// 成片被删除/清空后，库里可能还留着这些字段（历史数据、或删除前就存在的残留），
// 此时卡片没有任何画面可播——却会亮起「观片不合格」红徽章，还会被「待处理」筛选捞出来，
// 让用户面对一张空卡片无从处置（实锤：镜 1-2 删片后仍挂 fail 7.8，导致
// 「待处理 1 + 未出片 36 = 37 > 全部 36」的计数自相矛盾）。
// 后端删除成片时已一并清空这些字段，这里是第二道防线：即使库里还有残留，界面也不说谎。
const seamAlert = (shot) => hasDisplayVideo(shot) && !!shot.seamCheck?.alert
// VLM 观片闸：四维评分（情绪/一拍一镜/台词对脸/AI味穿帮），verdict fail/warn 亮徽章
const reviewAlert = (shot) => hasDisplayVideo(shot) && ['fail', 'warn'].includes(shot.shotReview?.verdict)
const reviewTip = (shot) => {
  const r = shot.shotReview
  if (!r) return ''
  const dims = [`情绪${r.emotion}`, `叙事${r.clarity}`]
  if (r.dialogueFace != null) dims.push(`台词对脸${r.dialogueFace}`)
  dims.push(`画面${r.visualQuality}`)
  const issues = (r.issues || []).length ? ` · 问题：${r.issues.join('；')}` : ''
  return `观片评审：${dims.join(' / ')}，均分 ${r.avgScore}（${r.verdict}）· ${r.summary || '无总评'}${issues}`
}
const seamTip = (shot) => {
  const c = shot.seamCheck
  if (!c) return ''
  if (c.checkType === 'openerTone') {
    return `开场色向闸：首帧 R-B ${c.rb}，带宽 [${c.band?.rbMin}, ${c.band?.rbMax}] · ${c.alert ? '色调跑偏：建议重新生成本镜（修好前下游出片会被拦截）' : '正常'}`
  }
  const parts = []
  if (c.cctDiffK != null) parts.push(`色温差 ${c.cctDiffK}K`)
  else parts.push('色温差 n/a（近黑/近灰帧无法测 CCT）')
  parts.push(`亮度差 ${c.lumaDiff}`)
  if (c.hashDist != null) parts.push(`构图差 ${c.hashDist}/64`)
  parts.push(c.alert ? '超阈值：建议重新生成本镜（修好前下游出片会被拦截）' : '正常')
  return parts.join(' · ')
}

// ===== 系统告警（2026-09-13 建 / 2026-09-18 修补可见性）=====
// 末帧接力/接缝检测/色向闸/观片闸失败时后端写 system_alerts，这里按镜展示。
// 这些失败原本只落服务端 console.warn，批量出片时无人可见（"成片在但验收链全灭"长期静默）。
//
// ⚠️ 2026-09-18：告警来源已不止"出片钩子链"——场景图质检（sceneReview）、资产质检
//   （asset-lighting）也会写这张表，且它们的 shot_id 为 NULL。
//   故新增 alertsForScene / alertsUnattached 两条并列的展示路径（见 store），
//   并在汇总条给出**无处安放告警**的入口——否则顶部数字与可见条数会对不上。
const shotAlerts = (shot) => store.alertsForShot(shot.id)
// 角标只显示 error 级（warn 级如 MC 降级、info 级如 salvage 打捞成功都不叠加视觉噪音，展示在 tooltip 里）。
// ⚠️ 2026-09-18（Q4）：后端新增 'info' 级后，原 `a.level !== 'warn'` 会把 info 误当 error 亮红角标；
//    故改为**只认 error**，与上行注释口径一致（默认 level='error'，见 ai/alerts.js 三档映射）。
const shotErrAlerts = (shot) => shotAlerts(shot).filter((a) => a.level === 'error')
const alertsTip = (shot) => shotAlerts(shot).map((a) => `[${a.source}] ${a.message}`).join('\n')
// 无处安放的告警（既无 shot_id 也无 scene_id）：必须可见，否则计数与列表不符（见 store 注释）
const unattachedAlerts = computed(() => store.alertsUnattached())
const unattachedTip = computed(() =>
  unattachedAlerts.value.map((a) => `[${a.source}] ${a.message}`).join('\n'))
// 处置一条无处安放的告警（按 id）
async function dismissOneUnattached() {
  const list = unattachedAlerts.value
  if (!list.length) return
  const ok = await confirmDialog({
    title: `标记 ${list.length} 条告警为已处置`,
    description: `这批告警未关联到具体镜头或场景（多为历史数据或集级问题），共 ${list.length} 条。仅记录「已知悉」，不会重跑任何校验。`,
    confirmText: `标记 ${list.length} 条已处置`,
    cancelText: '先不标',
    tone: 'warn',
  })
  if (!ok) return
  for (const a of list) await store.resolveAlerts({ id: a.id })
}
// 汇总条上列出**实际出现**的告警来源（去重、稳定排序）。
// 不硬编码来源清单：来源会随功能增加而变（本轮就多了 sceneReview / asset-lighting），
// 硬编码的名单必然过期，而过期的说明比不说更误导。
const alertSources = computed(() => {
  const set = new Set(store.systemAlerts.map((a) => String(a.source || '').trim()).filter(Boolean))
  return [...set].sort()
})
// 汇总条文案里的来源后缀。做成计算属性而非在模板里 join：
// 模板中行内 <template v-if> 夹插值会被 Vue 解析器误判（实测报
// "Error parsing JavaScript expression: Unexpected token"），且分隔符带引号更易踩坑。
const alertSourceSuffix = computed(() =>
  alertSources.value.length ? `（${alertSources.value.join(' / ')}）` : '')
// 处置某镜全部告警
async function dismissShotAlerts(shot) {
  const n = shotAlerts(shot).length
  if (!n) return
  const ok = await confirmDialog({
    title: `标记镜 ${shot.shotNumber || shot.id} 的 ${n} 条告警为已处置`,
    description: '仅记录「已知悉」，不会重跑接力 / 接缝 / 观片钩子。如需真正修好，重生该镜即可重跑全链。',
    confirmText: `标记 ${n} 条已处置`,
    cancelText: '先不标',
    tone: 'warn',
  })
  if (!ok) return
  await store.resolveAlerts({ shotId: shot.id })
}
// 处置单条
async function dismissOneAlert(a) {
  await store.resolveAlerts({ id: a.id })
}
// 告警轮询计时器（fire-and-forget 钩子的结果兜底拉取）
let alertPoll = null

// 当前引擎元数据（standard / h3v2 / 未来其他 API），UI 文案统一从这里取
const videoEngine = computed(() => getVideoEngine(store.videoModel))
// 项目级出片比例：只读展示（配置入口在剧集页）。出片请求由 store 统一从项目设置取值，
// 保证成片与分镜图（参考图）比例一致，避免 Ref2VA 裁切构图。
const ratioShort = computed(() => {
  const opt = ASPECT_RATIO_OPTIONS.find((o) => o.value === store.aspectRatio)
  return opt ? opt.label : '16:9'
})

// 预览区比例：跟随项目级比例（默认 9:16 竖屏）。
// 原来固定 aspect-video(16:9) + object-cover，会把竖版片子裁掉大半，
// 这里改用真实比例，让镜头卡片直接反映成片构图。
const previewAspect = computed(() => ratioShort.value.replace(':', ' / '))

// 预览尺寸档位（2026-09-16 三次修订）
//
// 演进过程值得留一句，因为两次都是被同一个坑绊的：
//   一版用固定列数 → 卡片宽度随屏幕变宽而膨胀，卡越长越多；
//   二版锁定了"单卡宽度" → 但那是**把竖屏数值当成了通用值**。比例是动态的。
//
// ⚠️ 项目比例由 store.aspectRatio 决定，共 6 种（9:16 / 16:9 / 21:9 / 1:1 / 4:3 / 3:4，
// 见 ASPECT_RATIO_OPTIONS），预览区按真实比例渲染（见上面 previewAspect）。
// 于是 卡片高度 = 宽度 × (高 ÷ 宽)，同一个宽度在不同比例下完全不是一回事：
//   9:16 → ×1.78：宽 180px 的卡预览高 320px（舒服）
//   16:9 → ×0.56：宽 180px 的卡预览只剩 101px（细成一条）
// 注意 ratioShort 的兜底值恰恰是 '16:9'——横屏不是例外，是必须正确处理的常态。
//
// 所以真正的锚点既不是宽度也不是高度，而是**预览区面积**：画面要大到能看清构图。
// 由面积反推宽度 width = √(面积 ÷ 比例)，竖屏自然窄、横屏自然宽，两种朝向视觉分量才相当。
// 反推结果按朝向取整分档（保证三档在常见屏宽下落进不同列数，否则切档会"点了没反应"）。
//
// 下限 160px 是卡片底栏的硬约束，两种朝向都要守：
//   左「镜头号 22px + 武戏 34px」 + 右「重出 38px + 删除 38px」 + 内边距 ≈ 160px
// 再窄，镜头号就会被挤成「S…」——为了紧凑丢掉辨识镜头的能力，不划算。
//
// 记忆到 localStorage，避免每次进来都要重设；改过就记住，不强制覆盖已有偏好。
const PREVIEW_SIZE_KEY = 'storyboard.previewSize'
const previewSize = ref(localStorage.getItem(PREVIEW_SIZE_KEY) || 'medium')
watch(previewSize, (v) => localStorage.setItem(PREVIEW_SIZE_KEY, v))

// 预览宽高比（高 ÷ 宽）：9:16 → 1.78，3:4 → 1.33，1:1 → 1，4:3 → 0.75，16:9 → 0.56
// 兜底 16/9 读起来像"横屏"，其实正是 9:16 的「高÷宽」= 1.78，即按项目默认比例（竖屏短剧）处理。
const ratioHW = computed(() => {
  const [w, h] = String(ratioShort.value).split(':').map(Number)
  return w > 0 && h > 0 ? h / w : 16 / 9
})

// 朝向分档：决定"同样的视觉分量"需要多宽。1.15 / 0.9 两个阈值恰好把六种比例分成三组：
//   竖屏 9:16(1.78)、3:4(1.33) ｜ 方形 1:1(1.00) ｜ 横屏 4:3(0.75)、16:9(0.56)、21:9(0.43)
const orientation = computed(() =>
  ratioHW.value >= 1.15 ? 'portrait' : ratioHW.value >= 0.9 ? 'square' : 'landscape'
)

// 视图布局（2026-09-16 新增）：grid = 网格铺开 / list = 紧凑行。
//
// ⚠️ 这两个布局不是"密度高低"的关系，别当成同一个旋钮的两端。实测（内容区 1027px、列表区 336px）：
//     网格（小档 6 列）：一屏 6 张，画面 161×286  → 36 张扫完约 6 屏
//     列表（缩略图 160px）：一屏约 1.8 行，缩略图 90×160 → 36 张扫完约 20 屏
//   网格之所以更密，是因为它把横向空间全部用来并排画面；列表每行要用横向上百像素排徽章和按钮。
//   所以：
//     · 要「一屏看到最多镜头」→ 用网格
//     · 要「每张卡的信息排得开、画面不挤」→ 用列表（窗口窄时尤其明显，网格在那时塞不下几列）
//   竖屏项目默认落到列表：9:16 的画面在网格里必然是一根长条，那是比例决定的，不是 bug。
//   横屏项目默认留在网格：16:9 的卡本来就矮，网格既省滚动又并排更多。
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

// ⚠️ 列表模式的档位语义与网格**不同**，这一点花了好几轮才想清楚：
//     网格的档位 = 画面面积（画面是主角，行高由宽度 × 比例撑出来）
//     列表的档位 = **行高**（信息是主角，缩略图反过来跟着行高走）
// 把网格的语义搬到列表上，就会得到「218px 高的卡片里只装 68px 的信息」——
// 中间 150px 无论怎么摆都像卡片没长齐（实测渲染出来是一块深色空洞，用户反馈"巨丑无比"）。
// 所以列表的行高必须压到 100~160px，让三行信息（编号 / 状态 / 操作）把卡片填满。
//
// 缩略图高度 = 行高 − 上下内边距 16 − 边框 2；宽度由项目比例推出：
// 9:16 → 宽 ≈ 高的 0.56 倍；16:9 → 宽 ≈ 高的 1.78 倍（横图自然更宽）。
const ROW_H_PX = { large: 152, medium: 124, small: 100 }
const rowH = computed(() => ROW_H_PX[previewSize.value] ?? ROW_H_PX.medium)
const thumbH = computed(() => rowH.value - 18)

// ⚠️ 列表**不能整页宽**（2026-09-16 修正）：一行铺满时，编号在最左、它自己的「出片」按钮
// 被 flex-1 + justify-between 甩到屏幕最右——1090px 窗口下两者相隔约 900px，信息散成两摊，
// 看起来就像坏了。所以列表也用多列网格，列宽 = 缩略图宽 + 信息区宽，
// 一行刚好装下缩略图和它的信息，不留荒漠。
// 列宽随比例变化：9:16 的缩略图窄（90px），一行能放 3 张；16:9 的缩略图宽（284px），只放得下 2 张。
const LIST_INFO_MIN_W = 190 // 信息区净宽：编号 40 + 武戏 34 + 操作按钮 80 + 余量
const listMinW = computed(
  // +30 = 缩略图与信息区的间距 12 + 卡片左右内边距 16 + 边框 2
  // （第一版漏算了这 30px，导致 1512px 下信息区只剩 160px，编号会被按钮挤住）
  () => Math.round(thumbH.value / ratioHW.value) + LIST_INFO_MIN_W + 30
)
const LIST_COLS = 'grid-cols-1 sm:grid-cols-[repeat(auto-fill,minmax(var(--list-min),1fr))]'

// 预览区尺寸：网格模式高度由比例自动撑开；列表模式改为钉死高度、宽度由比例推。
const previewBoxStyle = computed(() => {
  const s = { aspectRatio: previewAspect.value }
  if (isList.value) s.height = `${thumbH.value}px`
  return s
})

// 单卡最小宽度（px）= 朝向 × 尺寸档位。由"预览区面积"反推而来：
//   竖屏 中档：180 × 320 = 57600 px²  →  16:9 下反推得 √(57600 ÷ 0.5625) ≈ 320px
// 横屏的数值明显更大不是"手抖写大了"——16:9 的卡矮，必须更宽才能有同等画面分量。
// 三档数值都校验过：在 1280 / 1512 / 1920 三种屏宽下各自落进不同列数，不会切了没反应。
const CARD_MIN_PX = {
  portrait: { large: 200, medium: 180, small: 160 },
  square: { large: 300, medium: 250, small: 205 },
  landscape: { large: 420, medium: 340, small: 272 },
}
const cardMin = computed(() => {
  const m = CARD_MIN_PX[orientation.value]
  return m[previewSize.value] ?? m.medium
})

// 列数不再写死：交给 auto-fill + 由 --card-min 给出的单卡最小宽度，
// 轨道宽度被钉在 min 附近，卡片不再随屏幕变宽而膨胀。
// 用 CSS 变量而不是运行时拼类名，是因为 Tailwind 只能扫到源码里的**完整类名**——
// `grid-cols-[repeat(auto-fill,minmax(${w}px,1fr))]` 这种拼出来的串不会被生成，样式会静默失效。
// <640px 退化为固定 1/2/3 列：那么窄的屏上 min 值算不出合理列数。
const AUTO_COLS = 'sm:grid-cols-[repeat(auto-fill,minmax(var(--card-min),1fr))]'
const PREVIEW_SIZES = [
  { key: 'large', label: '大', base: 'grid-cols-1', desc: '逐镜审表演' },
  { key: 'medium', label: '中', base: 'grid-cols-2', desc: '画面与密度兼顾' },
  { key: 'small', label: '小', base: 'grid-cols-3', desc: '一屏扫最多镜' },
]
const previewCols = computed(() => {
  // 列表模式：多列「紧凑卡」，列宽由 listMinW 决定（缩略图宽 + 信息区最小宽）。
  if (isList.value) return LIST_COLS
  const sz = PREVIEW_SIZES.find((x) => x.key === previewSize.value) || PREVIEW_SIZES[1]
  return `${sz.base} ${AUTO_COLS}`
})
// 两个布局各自需要的 CSS 变量一起注入：网格用 --card-min，列表用 --list-min。
const gridStyle = computed(() => ({
  '--card-min': `${cardMin.value}px`,
  '--list-min': `${listMinW.value}px`,
}))

// 悬停提示带上实际数值：比例不同、布局不同，同一个档位的画面尺寸本来就不同，
// 写死"约 180px"会在 16:9 或列表模式下说错话。
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

// 尺寸档位的组标题：网格管画面大小，列表管行高——标题跟着切，别让用户猜数字在管什么。
const sizeGroupLabel = computed(() => (isList.value ? '行高' : '预览尺寸'))

// 镜头筛选（对齐分镜页的状态灯语义）：扫废片时只看有问题的，不必在 44 张里翻。
//
// ⚠️ 这里刻意区分「本镜已出片」与「只有段切片」：
// hasDisplayVideo 为了让预览能播，把 segmentVideoUrl 也算作"有画面"；
// 但那只是段成片切出来的一段，不等于这一镜真的单独出过片。
// 若筛选沿用 hasDisplayVideo，「已出片」会把只切片未独立出片的也算进去，
// 数字与实际不符 —— 状态就说了谎。所以：
//   shotVideo   = 本镜真正独立出片（videoUrl / videoGenerated）
//   segFallback = 仅靠段切片兜底显示
// 「未出片」口径 = 连切片都没有的；「仅切片」单独成档，便于决定哪些要补单独出片。
const shotFilter = ref('all')
const shotStates = computed(() =>
  allShots.value.map((shot) => {
    const shotVideo = !!(shot.videoUrl || shot.videoGenerated)
    const segFallback = !shotVideo && !!shot.segmentVideoUrl
    const alert = seamAlert(shot) || reviewAlert(shot)
    return { shot, shotVideo, segFallback, hasVideo: shotVideo || segFallback, alert }
  })
)
const filterCounts = computed(() => ({
  all: shotStates.value.length,
  alert: shotStates.value.filter((x) => x.alert).length,
  pending: shotStates.value.filter((x) => !x.hasVideo).length,
  slice: shotStates.value.filter((x) => x.segFallback).length,
  done: shotStates.value.filter((x) => x.shotVideo).length,
}))
const visibleShots = computed(() => {
  const list = shotStates.value
  if (shotFilter.value === 'alert') return list.filter((x) => x.alert).map((x) => x.shot)
  if (shotFilter.value === 'pending') return list.filter((x) => !x.hasVideo).map((x) => x.shot)
  if (shotFilter.value === 'slice') return list.filter((x) => x.segFallback).map((x) => x.shot)
  if (shotFilter.value === 'done') return list.filter((x) => x.shotVideo).map((x) => x.shot)
  return list.map((x) => x.shot)
})

// 筛选档位定义：文案 + 计数 + 选中态配色 + 悬停解释集中一处，
// 避免在模板里塞嵌套三元（可读性差、加档位容易漏分支）。
// 选中态规格统一为「语义色 /15 底 + 实色字 + /25 内描边」：
// 旧版是 5 个形状相同、底色各异的色块，看着像五种不同的东西；加上同一道内描边后，
// 它们才读起来是「同一组筛选，只是筛的东西不同」。
const shotFilterChips = computed(() => [
  { key: 'all', label: '全部', n: filterCounts.value.all, activeClass: 'bg-bg-elevated text-text-primary', tip: '全部镜头' },
  { key: 'alert', label: '待处理', n: filterCounts.value.alert, activeClass: 'bg-danger/15 text-danger ring-1 ring-inset ring-danger/25', tip: '接缝异常或观片未通过，需要处置' },
  { key: 'pending', label: '未出片', n: filterCounts.value.pending, activeClass: 'bg-bg-elevated text-text-primary', tip: '连段切片都没有，画面完全空着' },
  { key: 'slice', label: '仅切片', n: filterCounts.value.slice, activeClass: 'bg-warn/15 text-warn ring-1 ring-inset ring-warn/25', tip: '只有段成片切出来的一段，本镜未单独出片' },
  { key: 'done', label: '单独出片', n: filterCounts.value.done, activeClass: 'bg-ok/15 text-ok ring-1 ring-inset ring-ok/25', tip: '本镜已独立生成视频' },
])

// ===== 成片删除：单镜 + 卡片勾选批量（2026-09-16）=====
// 场景：扫废片时发现某几镜表演/画面废掉，要退回未出片重做。两条路径——
//   ① 卡片信息区的小「删除」按钮：单镜（含仅切片兜底的镜）
//   ② 工具栏「多选」→ 卡片勾选 → 底部批量条：一次清一批，不必逐张点确认
//
// ⚠️ 段联动是本功能最容易踩的坑：段是「生成包装层」，一段成片按镜边界切片回填后，
// 多个镜共用同一份段成片文件。删其中任一镜，后端必须把整段成片一起删——否则同段其他镜
// 会留下"文件已不在"的死切片。所以前端删除前必须先用 segmentPlan 算出「这次会连带删掉
// 哪些同段镜」写进确认框；且 isFallbackOnly（仅切片兜底）的镜同样要能删，
// 只是它只能走段联动路径——它压根没有自己的镜级成片。
const multiSelect = ref(false)
// 只存镜 id 用数组而非 Set：Vue 3 对 Set 的原生修改不触发依赖，数组 push/splice 才可靠
const selectedShotIds = ref([])
const deleting = ref(false)
const selectedSet = computed(() => new Set(selectedShotIds.value))
const selectedCount = computed(() => selectedShotIds.value.length)

// 可勾选判定：有画面可播，且当前没在出片。
// 生成中的镜不能删（后端可能正在写文件，删了必竞态），干脆连勾选框都不给，
// 免得用户勾上后才在删除时被告知"这镜不能删"。
function isSelectable(shot) {
  return hasDisplayVideo(shot) && !store.generatingVideoIds.includes(shot.id)
}
function enterMultiSelect() {
  settingsOpen.value = false // 弹出面板会跟勾选操作抢注意力，进多选时先收起
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
// 卡片点击分流：多选模式下点卡片 = 切换选中，必须屏蔽 openPlayerAtShot，
// 否则用户勾选时会被弹出来的播放器打断（这是多选交互最常见的破功点）。
function onCardClick(shot) {
  if (multiSelect.value) {
    if (isSelectable(shot)) toggleShotSelect(shot.id)
    return
  }
  if (hasDisplayVideo(shot) && !store.generatingVideoIds.includes(shot.id)) openPlayerAtShot(shot.id)
}
// 全选/反选只作用于「当前筛选可见」的镜——用户筛到某档就是要处理这一屏，
// 若把隐藏的镜也选进来，批量条上的 N 会跟眼前看到的张数对不上。
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

// ── 段联动影响面计算 ──
// 反查某镜所属的「已出片段」：段边界会随重算变动，直接用 segmentPlan.shotIds 反查最可靠。
// 只认 status==='done' 的段：未出片的段根本没有成片文件，删单镜不会牵连它，
// 也不该在确认框里拿它吓唬用户。
function owningSegments(shotId) {
  return segmentPlan.value.filter(
    (seg) => seg.status === 'done' && Array.isArray(seg.shotIds) && seg.shotIds.includes(shotId)
  )
}
// 返回 { segments, linkedShotIds }：
//   segments      = 会被连带删除的段
//   linkedShotIds = 同段里「不在本次删除名单内」的镜（它们也会被退回未出片，必须提前告知）
function computeDeleteImpact(shotIds) {
  const idSet = new Set(shotIds.map(Number))
  const segMap = new Map()
  for (const sid of shotIds) for (const seg of owningSegments(sid)) segMap.set(seg.id, seg)
  const linked = new Set()
  for (const seg of segMap.values()) {
    for (const sid of seg.shotIds) if (!idSet.has(Number(sid))) linked.add(Number(sid))
  }
  return { segments: [...segMap.values()], linkedShotIds: [...linked] }
}
const shotLabel = (id) => {
  const s = allShots.value.find((x) => Number(x.id) === Number(id))
  return s ? (s.shotNumber || s.displayId || s.id) : `#${id}`
}
// 确认框文案：把"删什么 / 会连带删什么 / 文件去哪了 / 删完什么状态"四件事一次说清。
// 段联动必须逐条列出同段镜头号——用户没被告知就连带删掉别人的成片，是不可接受的。
// 删除确认的入参（2026-09-16 改结构化）：原来拼一大坨带 \n 和 ⚠️ 的字符串塞给
// 原生 confirm，关键信息（连带多少段、多少镜退回）全糊在正文里。现在返回对象，
// 由统一弹窗按键值行渲染，连带影响单独标色。
function buildDeleteConfirm(shotIds) {
  const nums = shotIds.map((id) => shotLabel(id))
  const shown = nums.slice(0, 10).join('、')
  const more = nums.length > 10 ? ` …等共 ${nums.length} 镜` : ''
  const { segments, linkedShotIds } = computeDeleteImpact(shotIds)

  const details = [{ label: '镜号', value: `${shown}${more}` }]
  if (segments.length) {
    const linkedNums = linkedShotIds.map((id) => shotLabel(id))
    const lShown = linkedNums.slice(0, 10).join('、')
    const lMore = linkedNums.length > 10 ? ` …等共 ${linkedNums.length} 镜` : ''
    details.push({
      label: '连带段',
      value: `${segments.length} 段（${segments.map((s) => s.shotNumbers).join('、')}）`,
      tone: 'danger',
    })
    details.push({
      label: '一并退回',
      value: `同段 ${linkedShotIds.length} 镜${linkedShotIds.length ? `：${lShown}${lMore}` : ''}`,
      tone: 'warn',
    })
  }
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
// 结果汇报：接口返回的 shots/segments 是「后端实际清掉的」，比前端预期更可信——
// 段联动会多清掉一些镜，直接按返回值报数才不会让用户觉得数量对不上。
// 删除结果 → toast 入参（2026-09-16）：原 alert 是一坨多行文本，
// 现在拆成「一句话主文案 + 明细」，跳过的项进 detail。
function summarizeDelete(r) {
  const n = r?.shots?.length ?? 0
  const segs = r?.segments?.length ?? 0
  const files = r?.movedFiles ?? 0
  const message = `已删除 ${n} 个镜头的成片` + (segs ? `，连带清理 ${segs} 段段成片` : '')
  const lines = [`${files} 个文件移入回收站`]
  // 观片/接缝结论描述的是被删掉的那一版成片，后端会顺手销掉相关未处置告警——
  // 这里如实回报条数，避免用户以为告警是"自己消失"的
  const alerts = r?.alertsCleared ?? 0
  if (alerts) lines.push(`顺手销掉 ${alerts} 条已失效告警`)
  const skipped = r?.skipped || []
  if (skipped.length) {
    lines.push(`有 ${skipped.length} 项未处理：`)
    lines.push(...skipped.slice(0, 10).map((s) => `· 镜 ${s.shotId}：${s.reason}`))
  }
  return { message, detail: lines.join('\n'), type: skipped.length ? 'warn' : 'success' }
}

// 刷新后把已失效（无成片）的镜从选中集合里剔掉——单镜删除可能发生在多选模式下，
// 被删的镜若还留在选中集合里，批量条的数字会虚高。
function pruneSelection() {
  selectedShotIds.value = selectedShotIds.value.filter((id) => {
    const s = allShots.value.find((x) => Number(x.id) === Number(id))
    return !!s && hasDisplayVideo(s)
  })
}

// 单镜删除（含仅切片兜底：此时后端走段联动，会连带整段）
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
    // 删空后自动退出多选（可能恰好在多选模式下点了单镜删除）
    if (!allShots.value.some((s) => hasDisplayVideo(s))) exitMultiSelect()
  } catch (e) {
    toastError('删除失败', { detail: String(e?.message || e) })
  } finally {
    deleting.value = false
  }
}

// 批量删除：一次提交全部选中镜号，后端做段联动去重（同段多镜只清一次段）
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
    // 本集已无任何成片 → 多选没意义了，自动退出（否则留一个空的多选态很困惑）
    if (!allShots.value.some((s) => hasDisplayVideo(s))) exitMultiSelect()
  } catch (e) {
    toastError('删除失败', { detail: String(e?.message || e) })
  } finally {
    deleting.value = false
  }
}

// 单镜出片统一入口：走 store 的全局分发（分镜页 ShotRow 与这里共用 videoModel）
async function generateShot(shotId, overrides = {}) {
  const r = await store.generateShotVideoByModel(shotId, overrides)
  // 出片成功 → 立刻拉一次告警（钩子可能已在数秒内失败），再延迟一次兜住慢钩子（观片闸要调 VLM）
  if (r?.success) {
    store.loadAlerts()
    setTimeout(() => store.loadAlerts(), 6000)
    setTimeout(() => store.loadAlerts(), 20000)
  }
  return r
}

// 批量出片：串行逐镜（不并发，避免云端多任务排队），skipConfirm 已由本函数统一确认一次
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
    description: '串行逐镜生成，中途可在卡片上看到每个镜头的进度。',
    details: [
      { label: '镜头数', value: `${pending.length} 个（共约 ${totalSec}s）` },
      { label: '引擎', value: eng.label },
      { label: '计费', value: eng.coinLow != null ? `约 ${eng.coinLow}~${eng.coinHigh} 币/条` : '按 RunningHub 计费', tone: 'warn' },
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

// ===== 按场出片（E 路线 v2 段级出片，2026-09-15）=====
// 一段一任务：后端把相邻镜拼成 4–15s 的段（H3 单次上限），一次生成整段，
// 出片成功后自动按镜边界切片回填 shots.video_url——每镜仍有自己的 mp4。
// 收益：生成次数 40 → 22（省 45% 币），且段内画风/表演天然一致。
//
// 为什么按钮按场而不是按段：段是算法产物（镜长一变段边界就变），让用户点单段没有意义；
// 按场出片 = 该场所有段串行跑一遍，中途可看进度，比"全片批量"风险小（一场一场验收）。
const segmentPlan = computed(() => store.segmentPlan || [])
// 按场分组统计（场号 → { total, done, running, pending }）
const sceneSegmentStats = computed(() => {
  const m = new Map()
  for (const seg of segmentPlan.value) {
    const k = seg.sceneNumber
    if (!m.has(k)) m.set(k, { total: 0, done: 0, pending: 0, running: 0, unusable: 0 })
    const s = m.get(k)
    s.total++
    if (seg.status === 'done') s.done++
    else if (seg.status === 'running') s.running++
    else if (seg.status === 'unusable') s.unusable++
    else s.pending++
  }
  return m
})
const hasSegmentPlan = computed(() => segmentPlan.value.length > 0)
const segmentGenerating = ref(false)
const segmentProgress = ref('')
// 重算分段是「静默替换段记录」的操作：段列表前后都还是 pending、场次结构也不变，
// 若不给显式反馈，用户会以为按钮没生效（2026-09-16 实测踩过）。这里用独立状态驱动
// 按钮内的加载态 + 完成后的手动关闭提示，与出片/切片的忙碌态互不干扰。
const segmentRecomputing = ref(false)
// 重算完成后在按钮旁留一条「已重建」的短状态，几秒后自动淡出（比 toast 更贴近操作发生处）
const segmentRecomputedHint = ref('')
let recomputeHintTimer = null
// 段方案过期状态（镜表指纹失配）。改了镜长/删镜/重排后段记录会过期，
// 此前只在切片那一刻才暴露——那时币已经烧了。现在提前探测并在界面上主动提示重算。
const segmentsStale = ref(false)
const segmentsStaleInfo = ref(null)

// 按场出片：串行跑该场所有未出片段（不并发，避免云端排队；与单镜批量同口径）
async function generateScene(sceneNumber) {
  if (segmentGenerating.value) return
  const segs = segmentPlan.value
    .filter((s) => s.sceneNumber === sceneNumber && s.status !== 'unusable')
    .sort((a, b) => a.segmentIndex - b.segmentIndex)
  if (!segs.length) {
    toastInfo(`场 ${sceneNumber} 没有待出片的段`)
    return
  }
  // 已出片段不再计入（段状态为 done 时该段成片已存在，重跑会白烧币）
  const todo = segs.filter((s) => s.status !== 'done')
  const doneCnt = segs.length - todo.length
  if (!todo.length) {
    toastSuccess(`场 ${sceneNumber} 的 ${segs.length} 段全部已出片`)
    return
  }
  const totalSec = todo.reduce((n, s) => n + (Number(s.duration) || 0), 0)
  const eng = videoEngine.value
  const ok = await confirmDialog({
    title: `按场出片 · 场 ${sceneNumber}`,
    description: '每段一次生成，出片后自动按镜边界切片，每镜各得独立视频。',
    details: [
      { label: '段数', value: `${todo.length} 段 · 约 ${totalSec}s` },
      { label: '段内容', value: todo.map((s) => s.shotNumbers).join(' / ') },
      {
        label: '计费',
        value: eng.coinLow != null
          ? `约 ${eng.coinLow}~${eng.coinHigh} 币/段（${eng.label}）`
          : `按 RunningHub 计费（${eng.label}）`,
        tone: 'warn',
      },
      ...(doneCnt ? [{ label: '跳过', value: `已出片 ${doneCnt} 段不再重跑` }] : []),
    ],
    confirmText: `开始出片 · ${todo.length} 段`,
    cancelText: '再想想',
    tone: 'warn',
  })
  if (!ok) return

  segmentGenerating.value = true
  let failed = 0
  const failReasons = []
  try {
    for (let i = 0; i < todo.length; i++) {
      const seg = todo[i]
      segmentProgress.value = `场 ${sceneNumber} · 第 ${i + 1}/${todo.length} 段（${seg.shotNumbers}）`
      try {
        const r = await api.generateVideoSegment(seg.id)
        if (!r?.success) {
          failed++
          // 后端闸门拒绝（缺构图锚/台词/防烧币等）必须让用户看到原因，不能只 console 吞掉
          if (r?.error) { console.warn(`[按场出片] 段${seg.id} 失败：`, r.error); failReasons.push(r.error) }
        }
      } catch (e) {
        failed++
        console.warn(`[按场出片] 段${seg.id} 异常：`, e?.message || e)
        failReasons.push(e?.message || String(e))
      }
      // 每段完成即刷新（段状态 + 告警）
      await refreshEpisodeData()
    }
  } finally {
    segmentGenerating.value = false
    segmentProgress.value = ''
  }
  const remain = segmentPlan.value.filter((s) => s.sceneNumber === sceneNumber && s.status !== 'done' && s.status !== 'unusable').length
  if (failed > 0 || remain > 0) {
    // 拒绝原因去重（同因多段只提示一次），最多列 3 条防刷屏
    const uniq = [...new Set(failReasons)].slice(0, 3)
    toastWarn(`场 ${sceneNumber} 出片完成，${failed} 段失败、${remain} 段未完成`, {
      detail: uniq.length ? `失败原因：\n${uniq.join('\n')}` : `可重试该场`,
    })
  }
  else toastSuccess(`场 ${sceneNumber} 全部出片完成`)
}

// 重算段方案（镜长/场次改动后段边界会变；默认只预览不落库）
// 反馈设计（2026-09-16）：本操作会静默替换段记录，界面表象几乎不变，必须让用户
// 在三个时点都有确定感 —— ① 点击瞬间按钮进入加载态 ② 计算完弹出待确认的方案
// ③ 落库成功后给一条需要手动关闭的结果提示 + 按钮旁的短状态。
async function recomputeSegments(persist = false) {
  const epId = store.currentEpisodeId
  if (!epId) { toastError('当前没有选中的集'); return null }
  if (segmentRecomputing.value) return null
  segmentRecomputing.value = true
  try {
    const r = await api.saveEpisodeSegments(epId, { persist, replace: persist })
    const t = r?.totals
    if (!t) { toastError('段方案计算失败'); return null }
    const details = [
      { label: '规模', value: `${t.sceneCount} 场 · ${t.shotCount} 镜 · ${t.segCount} 段` },
      { label: '总时长', value: `${t.totalSec}s` },
      { label: '生成次数', value: `${t.shotCount} → ${t.segCount}（省 ${t.savedGenerations} 次）`, tone: 'warn' },
    ]
    // 非法段（时长不在 3–15s）：落库时被后端过滤，不会出现在段队列里 →
    // 必须在这里告知用户「这几段要逐镜出片」，否则它们会无声消失（P1-1 修复配套）。
    const unusable = Array.isArray(r?.unusableSegments) ? r.unusableSegments : []
    if (unusable.length) {
      details.push({
        label: '需逐镜出片',
        value: `${unusable.length} 段时长不在 3–15s（${unusable.map((u) => u.shotNumbers).join(' / ')}）`,
        tone: 'danger',
      })
    }
    if (!persist) {
      const ok = await confirmDialog({
        title: '按此方案重新分段',
        description: unusable.length
          ? '已出片的段会保留，不会被清掉。非法段不会被落库，需逐镜出片。'
          : '已出片的段会保留，不会被清掉。',
        details,
        confirmText: '落库并应用',
        cancelText: '仅预览',
        tone: 'warn',
      })
      if (!ok) return r
      // 落库期间保持加载态：这一步会重建段记录 + 写入指纹，是本操作真正干活的时刻
      segmentRecomputing.value = true
      const w = await api.saveEpisodeSegments(epId, { persist: true, replace: true })
      const wt = w?.totals
      await refreshEpisodeData()
      // 落库后必须回读真实段数，不能拿落库前的预览数字充数
      const segCount = segmentPlan.value.length
      // 用 error 型（不自动消失）确保用户一定能看见；这是「看起来没反应」的根治点
      toastSuccess('分段方案已重建', {
        detail: [
          `已写入 ${segCount} 个段，段与镜表的指纹已对齐`,
          unusable.length ? `${unusable.length} 段非法，需逐镜出片` : '',
          '此后出片与切片可正常进行',
        ].filter(Boolean).join('\n'),
        duration: 0,
      })
      setRecomputeHint(`已重建 ${segCount} 段`)
      // 重算即恢复新鲜：显式复探一次，避免提示条滞后
      await refreshSegmentsStaleness()
      return w ?? r
    } else {
      const segCount = segmentPlan.value.length
      toastSuccess('分段方案已应用', {
        detail: details.map((d) => `${d.label}：${d.value}`).join('\n'),
      })
      setRecomputeHint(`已重建 ${segCount} 段`)
      await refreshSegmentsStaleness()
    }
    return r
  } catch (e) {
    toastError('段方案计算失败', { detail: String(e?.message || e) })
    return null
  } finally {
    segmentRecomputing.value = false
  }
}

// 按钮旁的「已重建 N 段」短状态：8 秒后自动淡出，不打扰但足以确认操作生效
function setRecomputeHint(text) {
  segmentRecomputedHint.value = text
  if (recomputeHintTimer) clearTimeout(recomputeHintTimer)
  recomputeHintTimer = setTimeout(() => { segmentRecomputedHint.value = '' }, 8000)
}

// 补切片：段成片在、切片缺（历史数据或切片失败）时手动重切。
// force=true 时忽略旧的切片文件强制重切——段重出后必须走这条，否则卡片播的是旧切片。
async function resliceSegments(force = false) {
  const epId = store.currentEpisodeId
  if (!epId) { toastError('当前没有选中的集'); return }
  segmentGenerating.value = true
  segmentProgress.value = '正在按镜边界切片…'
  try {
    const r = force ? await api.sliceEpisodeSegments(epId, { force: true }) : await api.sliceEpisodeSegments(epId)
    const sliced = r?.sliced?.length ?? 0
    const skipped = r?.skipped?.length ?? 0
    toastSuccess(`切片完成：新切 ${sliced} 镜，跳过 ${skipped} 镜`)
    await refreshEpisodeData()
  } catch (e) {
    toastError('切片失败', { detail: String(e?.message || e) })
  } finally {
    segmentGenerating.value = false
    segmentProgress.value = ''
  }
}

// 段状态/告警变化的统一刷新（必须带 episodeId，否则请求 /episodes/undefined 404）
async function refreshEpisodeData() {
  const epId = store.currentEpisodeId
  if (!epId) return
  try { await store.loadEpisode(epId) } catch (e) { console.warn('[段出片] 刷新集数据失败：', e?.message || e) }
  try { await store.loadAlerts?.() } catch { /* 告警拉取失败不影响主流程 */ }
  await refreshSegmentsStaleness()
}

// 探测段方案是否过期。失败静默（探测不能干扰出片主流程，也不该弹错误打扰用户）。
async function refreshSegmentsStaleness() {
  const epId = store.currentEpisodeId
  if (!epId) { segmentsStale.value = false; segmentsStaleInfo.value = null; return }
  try {
    const r = await api.getSegmentsStaleness(epId)
    segmentsStale.value = !!r?.stale
    segmentsStaleInfo.value = r || null
  } catch {
    // 探测失败 → 保持「未知即不提示」，避免旧后端/网络抖动时误报
    segmentsStale.value = false
    segmentsStaleInfo.value = null
  }
}

// ===== 连续播放：把已生成镜头视频按顺序连续播放（一个播完自动播下一个）=====
const playModal = ref(false)
const playingIndex = ref(0)
const playVideoRef = ref(null)
const playList = computed(() => allShots.value.filter((s) => displayVideoUrl(s) || fallbackSegUrl(s)))
const playingShot = computed(() => playList.value[playingIndex.value] || null)
// 播放器 seek：正常情况下每镜一片，播放器只播本镜，无需 seek。
// 仅**切片兜底**场景（segmentVideoUrl 存在但本镜无切片）才需要 seek 到段内偏移。
function syncPlayerToShot() {
  const shot = playingShot.value
  const v = playVideoRef.value
  if (!v || !shot) return
  const url = displayVideoUrl(shot) || fallbackSegUrl(shot)
  if (!url) return
  let abs = ''
  try { abs = new URL(url, window.location.href).href } catch { return }
  if (v.src !== abs) return // src 变化：等重载后 loadedmetadata 再 seek
  const off = displayFallbackOffset(shot)
  if (off > 0.05 && Math.abs(v.currentTime - off) > 0.2) {
    try { v.currentTime = off } catch { /* ignore */ }
  }
  v.play?.().catch(() => {})
}
function onPlayerMeta() {
  const shot = playingShot.value
  const v = playVideoRef.value
  if (!v || !shot) return
  const off = displayFallbackOffset(shot)
  if (off > 0.05) { try { v.currentTime = off } catch { /* ignore */ } }
}
// 播放器逐镜边界：切片兜底时（播的是整段成片）本镜区间播完自动切下一镜；
// 正常情况每镜一片，播完由 ended 事件自然切下一镜，这里不参与。
function onPlayerTimeUpdate() {
  const shot = playingShot.value
  const v = playVideoRef.value
  if (!v || !shot) return
  if (!isFallbackOnly(shot)) return // 有镜级切片 → 播完自动 ended，不在这里切
  const off = displayFallbackOffset(shot)
  const dur = Number(shot.duration) || 0
  if (dur > 0 && v.currentTime > off + dur + 0.3) {
    if (playingIndex.value < playList.value.length - 1) {
      playingIndex.value++
      syncPlayerToShot()
    }
  }
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
// 点击单个镜头卡片：从该镜开始播放（带原生控件 + 有声音）
// 卡片上的 hover 预览是 muted 静音循环，点开这里才出声，避免鼠标扫过时一排视频同时炸响
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
// 卡片缩略帧定位（仅切片兜底需要）：段成片的静止帧是段头帧，会让段内第二镜的
// 缩略图与第一镜一模一样。正常情况每镜一片，首帧天然就是本镜起始画面，无需 seek。
function onPreviewLoaded(evt, shot) {
  const off = displayFallbackOffset(shot)
  if (off > 0.05) { try { evt.target.currentTime = off } catch { /* ignore */ } }
}
// 卡片 hover 预览：切片兜底时从本镜段内偏移起播；每镜一片时直接播
function previewSeekPlay(evt, shot) {
  const v = evt.target
  const off = displayFallbackOffset(shot)
  if (off > 0.05 && Math.abs(v.currentTime - off) > 0.3) {
    try { v.currentTime = off } catch { /* ignore */ }
  }
  v.play()
}
function keepPreviewRange(evt, shot) {
  const off = displayFallbackOffset(shot)
  if (off <= 0.05) return
  const v = evt.target
  const end = off + (Number(shot.duration) || 0) + 0.35
  if (v.currentTime < off - 0.25 || v.currentTime > end) {
    try { v.currentTime = off } catch { /* ignore */ }
  }
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

// ===== 保存至成片：把所有已生成镜头视频按顺序拼接为一个完整 mp4 =====
// 用 ref 拆开 composing / result，不用 reactive 对象：之前用 reactive 时 Vue 3.5 vite-dev
// 下赋值不会触发组件重渲染，被迫加 forceRender() hack 手动 update()，结果把全应用的
// 事件绑定都搞废了（导航点不动、X 按钮点不动），改成两个 ref 让响应式自然生效。
const composing = ref(false)
const composeResult = ref(null)
// 成片合成选项：交叉淡化转场（默认开）+ BGM 铺底（文件放 server/uploads/bgm/）
const fadeEnabled = ref(true)
const selectedBgm = ref('')
const bgmFiles = ref([])
async function loadBgmList() {
  try {
    const r = await api.getBgmList()
    bgmFiles.value = r?.files || []
    if (selectedBgm.value && !bgmFiles.value.includes(selectedBgm.value)) selectedBgm.value = ''
  } catch { /* BGM 列表拉取失败不阻塞合成 */ }
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
      // 未出片镜头显式告警：compose 只拼有视频的镜头，缺镜会静默腰斩叙事
      const missing = r.missingShots || []
      if (missing.length) {
        const shown = missing.slice(0, 10).join('、')
        const more = missing.length > 10 ? ` …等共 ${missing.length} 镜` : ''
        // 缺镜是「合成成功但有隐患」，用 warn 而不是 success —— 不能让人以为万事大吉
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
const composeFilename = computed(() => {
  const stamp = new Date()
  const s = `${stamp.getFullYear()}${String(stamp.getMonth() + 1).padStart(2, '0')}${String(stamp.getDate()).padStart(2, '0')}_${String(stamp.getHours()).padStart(2, '0')}${String(stamp.getMinutes()).padStart(2, '0')}`
  return `成片_${store.projectTitle || '项目'}_${s}.mp4`
})

// Esc 键依次兜底关：合成结果卡片 → 连续播放弹窗 → 退出多选。
// 用 else-if 链保证一次 Esc 只关一层（多选模式可能恰好也开着播放器，
// 直接一起关会让用户丢掉勾选进度）。
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
  // 进页面即探测一次段方案是否过期（用户可能刚在分镜页改过镜长）
  refreshSegmentsStaleness()
  // 钩子链是 fire-and-forget，出片响应返回时告警可能还没写完——定时轻量轮询兜底
  // （只在有镜头生成中或有未处置告警时才轮询，避免空转请求）
  alertPoll = setInterval(() => {
    if (store.generatingVideoIds.length || store.systemAlertCount) store.loadAlerts()
  }, 8000)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown)
  playVideoRef.value?.pause?.()
  if (alertPoll) { clearInterval(alertPoll); alertPoll = null }
  if (recomputeHintTimer) { clearTimeout(recomputeHintTimer); recomputeHintTimer = null }
})
</script>

<template>
  <div class="flex h-full w-full flex-col bg-bg-primary">
    <!-- 系统告警汇总条：失败可见化（保留业务逻辑与全部信息，改为通栏细条，
         不再与命令栏抢"卡片"身份——页面上出现三个圆角面板正是此前层叠感的来源）。
         ⚠️ 2026-09-18：文案不再硬编码"出片后置钩子链（末帧接力/接缝检测/色向闸/观片闸）"——
         该表现有多个来源（出片钩子链 / 场景图质检 / 资产质检），点名其中一类既不全也易过期；
         改为按**实际来源**动态列出（去重），信息更准且换题材/加新来源都不用改这里。 -->
    <div
      v-if="store.systemAlertCount"
      class="flex shrink-0 items-start gap-3 border-b border-warn/25 bg-warn/[0.07] px-6 py-2.5"
    >
      <svg class="mt-px h-4 w-4 shrink-0 text-warn" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
      </svg>
      <span class="min-w-0 flex-1 text-[12px] leading-relaxed text-warn">
        有 <b class="font-mono">{{ store.systemAlertCount }}</b> 条系统告警未处置{{ alertSourceSuffix }}：多为生成后的自动验收未通过，成片已生成但那几项没有结论
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

    <!-- ═══ 命令栏 ═══
         左：身份 + 进度指标；右：配置 + 次操作 │ 主操作。
         视觉规则：全页只有「批量生成短片」一个实心按钮，其余按钮一律描边或幽灵，
         并用一道竖线把「查看类操作」和「主操作」分开——原来 5 个同尺寸描边按钮并排，
         主操作被自己人淹没了。 -->
    <div class="shrink-0 border-b border-border/70 px-6 py-3.5">
      <div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <!-- 左：身份 + 进度。
             做减法：百分比（进度条本身已表达）、"可播"字样、"独立出片"常驻 pill
             全部去掉 —— 原版一个 36 镜的项目在顶栏挂了 5 个指标，其中三个在说同一件事。
             现在只留三件真正不同的信息：已完成多少 / 进度条 / 全片时长。
             被去掉的口径没有丢，收进了 tooltip。 -->
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
              :title="`可播放 ${playableCount} 镜（含仅靠段切片兜底的 ${filterCounts.slice} 镜）；本镜独立出片 ${shotVideoCount} 镜`"
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
              v-if="filterCounts.slice > 0"
              class="flex shrink-0 items-center gap-1 rounded-full bg-warn/10 px-2 py-0.5 text-micro text-warn"
              title="这些镜头只有段成片切出来的一段，未单独出片。要单独的成片需逐镜出片。"
            >
              <span class="font-mono font-medium">{{ filterCounts.slice }}</span> 镜仅切片
            </span>
            <span
              class="hidden shrink-0 font-mono text-micro text-text-muted sm:inline"
              title="全片预计时长"
            >{{ store.totalDuration }}s</span>
          </div>
        </div>

        <!-- 右：配置（描边/图标）+ 次操作（幽灵）│ 主操作（实心） -->
        <div class="flex shrink-0 flex-wrap items-center gap-2">
          <!-- 出片引擎：去掉前置图标（下拉里已经写着引擎名，图标只是重复一遍） -->
          <div
            class="flex h-8 items-center rounded-control border px-2.5"
            :class="videoEngine.value !== 'h3v4' ? 'border-accent/40 bg-accent/10' : 'border-border bg-bg-card'"
            :title="`出片引擎：${videoEngine.label} · ${videoEngine.desc}`"
          >
            <select
              v-model="store.videoModel"
              class="cursor-pointer bg-transparent text-[12px] outline-none"
              :class="videoEngine.value !== 'h3v4' ? 'text-accent' : 'text-text-primary'"
            >
              <option v-for="eng in VIDEO_ENGINES" :key="eng.value" :value="eng.value">
                {{ eng.label }}
              </option>
            </select>
          </div>

          <!-- 出片设置：收成一个纯齿轮图标按钮（32px）。
               原来那 90px 宽的「出片设置 BGM 转场」里，文字是标题、两个黄标签是状态 —— 
               一个按钮塞了三件事，是全栏最宽的非主操作控件。现在齿轮自带标题语义，
               配置状态交给右上角一个小圆点。 -->
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
              <!-- 不再重复一个「出片设置」标题栏：按钮本身就是标题，去掉一层视觉噪音 -->
              <div class="divide-y divide-border/60">
                <!-- 比例（只读，跟随项目级） -->
                <div class="flex min-h-[44px] items-center justify-between gap-3 px-3.5">
                  <span class="text-[12px] text-text-secondary">画面比例</span>
                  <span
                    class="rounded-full bg-bg-secondary px-2.5 py-0.5 font-mono text-micro text-text-secondary"
                    :title="`项目级设置（在剧集页顶部修改）：出片统一 ${ratioShort}，与分镜图参考一致`"
                  >{{ ratioShort }}</span>
                </div>
                <!-- BGM -->
                <div class="flex min-h-[44px] items-center justify-between gap-3 px-3.5">
                  <span class="text-[12px] text-text-secondary">背景音乐</span>
                  <div class="flex items-center gap-1.5">
                    <select
                      v-model="selectedBgm"
                      class="h-7 max-w-[160px] rounded-control border border-border bg-bg-secondary px-2 text-micro text-text-secondary outline-none transition hover:border-border-light"
                      title="BGM 音频文件请放进 server/uploads/bgm/ 目录（mp3/wav/m4a 等）"
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
                <!-- 转场 -->
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

              <!-- 引擎与计费说明：原底部状态条的常驻文案，收敛进「设置」语境，不再单占一条底栏 -->
              <div class="border-t border-border/60 bg-bg-secondary/50 px-3.5 py-2 text-micro leading-relaxed text-text-muted">
                当前引擎 {{ videoEngine.label }}（{{ videoEngine.desc }}），按 RunningHub 计费
              </div>
            </div>
          </div>

          <!-- 分割线：分开「出片配置」与「产出操作」两组 -->
          <span class="mx-0.5 h-4 w-px bg-border"></span>

          <!-- 保存至成片：产出最终交付物，给描边（次要强调），比查看类重、比主操作轻 -->
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

          <!-- 主操作：全页唯一实心按钮 -->
          <button
            class="flex h-8 items-center gap-2 rounded-control bg-accent px-4 text-[12px] font-medium text-black transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="batchGenerating || segmentGenerating"
            title="为所有未出片的镜头批量生成视频"
            @click="generateAllVideos"
          >
            <svg v-if="!batchGenerating" class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            <svg v-else class="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
            {{ batchGenerating ? '批量生成中...' : '批量生成短片' }}
          </button>
        </div>
      </div>

      <!-- ── 段级出片：默认折叠，已从「一整行圆角面板」压成一条紧凑折叠行。
           原来它独占一整行、左边一小截文字、右边大片空白，视觉重量却和命令栏相当。
           长说明「一段一次生成，出片后按镜自动切片」移进 title，悬停即可看到；
           「段级出片」的蓝色也改回中性色 —— 一个折叠标题不该是全栏唯一的彩色文字。 -->
      <div v-if="hasSegmentPlan" class="mt-2.5">
      <div class="overflow-hidden rounded-control border border-border/50 bg-bg-secondary/50">
        <button
          class="flex w-full items-center gap-2.5 px-3.5 py-2 text-left transition hover:bg-bg-hover/40"
          title="一段一次生成，出片后按镜自动切片"
          @click="segmentPanelOpen = !segmentPanelOpen"
        >
          <svg
            class="h-3 w-3 shrink-0 text-text-muted transition-transform duration-200"
            :class="segmentPanelOpen ? 'rotate-90' : ''"
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          ><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 5l7 7-7 7" /></svg>
          <span class="text-[12px] text-text-secondary">段级出片</span>
          <span class="font-mono text-micro text-text-muted">
            {{ segmentPlan.length }} 段 · 完成 <span class="text-text-secondary">{{ segmentPlan.filter((s) => s.status === 'done').length }}</span>
          </span>
          <span
            v-if="segmentGenerating"
            class="rounded-full bg-info/15 px-2 py-0.5 text-micro text-info"
          >{{ segmentProgress }}</span>
          <!-- 折叠态也要能看见过期：否则用户不展开面板就完全不知道需要重算 -->
          <span
            v-else-if="segmentsStale"
            class="rounded-full bg-warn/15 px-2 py-0.5 text-micro text-warn"
          >分镜已改动 · 需重算</span>
          <span class="ml-auto text-micro text-text-muted">{{ segmentPanelOpen ? '收起' : '展开' }}</span>
        </button>

        <!-- 段方案过期警示条：改了镜长/删镜/重排后段边界会漂移，
             此时出片会先烧币、再在切片那一步被拒 —— 必须在这里提前拦住。
             嵌套圆角递减：外层 panel(20) 内的块用 control(12)，避免"圆角打架" -->
        <div
          v-if="segmentsStale && !segmentGenerating"
          class="mx-3.5 mb-3 mt-0.5 flex items-start gap-3 rounded-control border border-warn/35 bg-warn/[0.08] px-3.5 py-3"
        >
          <svg class="mt-0.5 h-4 w-4 shrink-0 text-warn" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
          </svg>
          <div class="min-w-0 flex-1">
            <div class="text-[12px] font-medium text-warn">分镜已改动，需要重算分段</div>
            <div class="mt-0.5 text-micro leading-relaxed text-text-muted">
              {{ segmentsStaleInfo?.staleCount || 0 }}/{{ segmentsStaleInfo?.total || 0 }} 个段的时间轴与当前分镜对不上。
              <template v-if="segmentsStaleInfo?.fingerprintMismatch">
                分镜的镜长、镜头数量或顺序被改过；</template>
              <template v-else-if="segmentsStaleInfo?.emptyFingerprint">
                这些段是早期数据，缺少与分镜的对应标记；</template>
              现在出片会在切片那一步失败，白花生成费用。请先点右侧「重算分段」。
            </div>
          </div>
          <button
            class="h-7 shrink-0 rounded-control border border-warn/45 bg-warn/15 px-3 text-[12px] font-medium text-warn transition hover:bg-warn/25 disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="segmentRecomputing || segmentGenerating || batchGenerating"
            @click="recomputeSegments(false)"
          >立即重算</button>
        </div>

        <div v-if="segmentPanelOpen" class="flex flex-wrap items-center gap-2 border-t border-border/40 py-2.5 pl-7 pr-3.5 animate-fade-up">
          <button
            v-for="[sceneNo, st] in [...sceneSegmentStats.entries()]"
            :key="sceneNo"
            class="flex h-7 items-center gap-1.5 rounded-control border px-2.5 text-[12px] font-medium transition disabled:cursor-not-allowed disabled:opacity-40"
            :class="st.pending + st.running > 0
              ? 'border-info/35 bg-info/10 text-info hover:bg-info/20'
              : 'border-border bg-bg-card text-text-muted'"
            :disabled="segmentGenerating || batchGenerating"
            :title="st.unusable ? `场 ${sceneNo}：${st.unusable} 段非法（时长不在 4–15s），这些段需逐镜出片` : `场 ${sceneNo}：${st.total} 段，已完成 ${st.done}，待出 ${st.pending + st.running}`"
            @click="generateScene(sceneNo)"
          >
            场 {{ sceneNo }}
            <span class="rounded-full bg-bg-primary/70 px-1.5 py-px font-mono text-micro">{{ st.done }}/{{ st.total }}</span>
            <span v-if="st.unusable" class="text-warn" title="含非法段">⚠</span>
          </button>

          <div class="ml-auto flex items-center gap-2">
            <!-- 重算组件的显式反馈：忙碌态（转圈 + 文案变化）与完成态（已重建 N 段）都贴在按钮上，
                 因为这个操作本身不改变段列表的外观，用户只能靠这里的反馈确认是否点到了 -->
            <span
              v-if="segmentRecomputing || segmentRecomputedHint"
              class="flex items-center gap-1 text-micro"
              :class="segmentRecomputing ? 'text-info' : 'text-ok'"
            >
              <svg
                v-if="!segmentRecomputing"
                class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"
              ><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7" /></svg>
              {{ segmentRecomputing ? '正在重算…' : segmentRecomputedHint }}
            </span>
            <button
              class="flex h-7 items-center gap-1.5 rounded-control border px-2.5 text-[12px] transition disabled:cursor-not-allowed disabled:opacity-40"
              :class="segmentRecomputing
                ? 'border-border-light bg-bg-hover text-text-primary'
                : 'border-border bg-bg-card text-text-muted hover:border-border-light hover:text-text-primary'"
              :disabled="segmentGenerating || batchGenerating || segmentRecomputing"
              title="按当前镜长重算段边界（相邻镜拼成 4–15s 的段）。镜长改过才需要重算；已出片的段会保留。"
              @click="recomputeSegments(false)"
            >
              <svg
                class="h-3 w-3" :class="segmentRecomputing && 'animate-spin'" fill="none" stroke="currentColor" viewBox="0 0 24 24"
              ><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
              {{ segmentRecomputing ? '处理中' : '重算分段' }}
            </button>
            <button
              class="flex h-7 items-center gap-1.5 rounded-control border border-border bg-bg-card px-2.5 text-[12px] text-text-muted transition hover:border-border-light hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
              :disabled="segmentGenerating || batchGenerating || !segmentPlan.some((s) => s.status === 'done')"
              title="按镜边界重切所有已出片段（覆盖旧切片）。段重新生成后必须点一次，否则卡片播的是旧切片。"
              @click="resliceSegments(true)"
            >
              <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.121 14.121L19 19m-7-7l7-7m-7 7l-2.879 2.879M12 12L9.121 9.121m0 5.758a3 3 0 10-4.243 4.243 3 3 0 004.243-4.243zm0-5.758a3 3 0 10-4.243-4.243 3 3 0 004.243 4.243z" /></svg>
              重切切片
            </button>
          </div>
        </div>
        </div>
      </div>
    </div>

    <!-- ═══ 成片展示 ═══ -->
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
        <!-- ⚠️ 成片是 9:16 竖屏，原来写死 aspect-video(16:9) + w-full 会把竖版画面横向拉扁。
             现在用「宽度自适应 + 高度上限 + object-contain」：既不变形，长片子也不会撑破一屏。 -->
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

    <!-- ═══ 镜头网格 ═══ -->
    <div class="flex-1 overflow-y-auto px-6 py-4">
      <!-- 无镜头：全页**唯一**的空状态。
           旧版在下方又写了一份条件完全相同的空状态块，导致无镜头时同屏渲染两块
           「暂无镜头」。这里收成一个，并用 template v-else 让筛选条/网格互斥。 -->
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
      <!-- 筛选条 + 尺寸档位：扫废片时先筛到「待处理」，再决定看多大。
           共 5 档，各自对应一个明确的问题：「还有多少没做 / 多少只靠切片兜底 / 多少真出好了」。
           注意「单独出片」与「仅切片」是两回事——切片只是段成片切出来的一段，
           不代表这一镜独立出过片，混在一起会让状态失真。 -->
      <div class="mb-4 flex flex-wrap items-center gap-2">
        <!-- 筛选 chips：计数为 0 且未选中的档位压暗到 45%。
             一屏 5 个 chip 里有 3 个是「0」时，它们和「36」同等响亮，
             筛选条本身就成了一种噪音。 -->
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

        <!-- 右侧：列表操作 + 预览尺寸。
             多选 / 连续播放从顶栏下移到这里 —— 它们操作的对象是「镜头列表」，
             和筛选、尺寸同属一类；挤在「出片配置」旁边既语义不搭，也把那一栏撑得过宽。 -->
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

          <!-- 视图：网格 / 列表。和「预览尺寸」是两个独立的旋钮——
               视图决定卡片怎么排，尺寸决定画面多大，互不替代。 -->
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

      <!-- 筛选后为空：给出「清空筛选」出口，避免用户以为没数据 -->
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

      <!-- gap-3：卡片宽度降到 160~230px 后，16px 的间距在视觉上已接近卡片宽度的 1/8，
           缝隙比画面本身还抢眼；12px 让一屏能多挤下 1 列。
           --card-min / --list-min 由 gridStyle 注入，分别对应网格的单卡最大宽度
           和列表的单行最大宽度（两者都按「朝向 × 档位」算，见上面的推导）。 -->
      <div v-else class="grid gap-3" :class="previewCols" :style="gridStyle">
        <div
          v-for="shot in visibleShots"
          :key="shot.id"
          class="group relative flex overflow-hidden rounded-panel border bg-bg-card transition-all duration-200"
          :class="[
            isList ? 'flex-row items-stretch gap-3 p-2' : 'flex-col',
            seamAlert(shot)
              ? 'border-danger/45 shadow-card ring-1 ring-inset ring-danger/15'
              : 'border-border/50 shadow-card hover:border-border/90 hover:shadow-card-hover',
            selectedSet.has(shot.id) ? 'border-accent/60 ring-2 ring-inset ring-accent/45' : '',
          ]"
          @click="onCardClick(shot)"
        >
          <!-- 预览区。网格模式高度由比例撑开；列表模式 height 被 previewBoxStyle 钉死，
               宽度反过来由比例推出（9:16 → 90px，16:9 → 285px）。
               列表模式补一道内描边：缩略图底色与卡片底色都是深色，不描边就糊成一团，
               看不出"这里是一格画面"。 -->
          <div
            class="relative shrink-0 overflow-hidden bg-black"
            :style="previewBoxStyle"
            :class="[
              isList ? 'rounded-control ring-1 ring-inset ring-white/[0.07]' : '',
              isSelectable(shot) ? 'cursor-pointer' : '',
            ]"
          >
            <video
              v-if="displayVideoUrl(shot) || fallbackSegUrl(shot)"
              :src="displayVideoUrl(shot) || fallbackSegUrl(shot)"
              class="h-full w-full object-cover"
              muted
              loop
              preload="auto"
              @loadeddata="onPreviewLoaded($event, shot)"
              @mouseenter="previewSeekPlay($event, shot)"
              @mouseleave="$event.target.pause()"
              @timeupdate="keepPreviewRange($event, shot)"
            />
            <!-- 未出片占位：不用纯黑 + 大灰图标（像个坏掉的播放器），
                 改用表面色 + 细描边图标 + 明确文案 -->
            <div v-else class="flex h-full w-full flex-col items-center justify-center gap-2 bg-bg-secondary">
              <span class="flex h-10 w-10 items-center justify-center rounded-full border border-dashed border-border-strong/70">
                <svg class="h-4 w-4 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </span>
              <span class="text-micro text-text-muted">未出片</span>
            </div>

            <!-- 顶部渐变压暗：让四角徽章在亮画面上也能读清。
                 比给每个徽章加白描边干净得多——旧版那种 border-white/25 正是"塑料感"的来源。
                 仅网格模式需要：列表模式的徽章已经移到信息栏，画面上方不再压字。 -->
            <div v-if="!isList" class="pointer-events-none absolute inset-x-0 top-0 z-[4] h-16 bg-gradient-to-b from-black/55 to-transparent"></div>

            <!-- 播放提示 -->
            <div
              v-if="hasDisplayVideo(shot) && !store.generatingVideoIds.includes(shot.id)"
              class="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center bg-black/25 opacity-0 transition group-hover:opacity-100"
            >
              <span class="flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-white ring-1 ring-inset ring-white/25 backdrop-blur-md">
                <svg class="ml-0.5 h-4 w-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
              </span>
            </div>

            <!-- 生成中 -->
            <div
              v-if="store.generatingVideoIds.includes(shot.id)"
              class="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2.5 bg-black/80 backdrop-blur-sm"
            >
              <div class="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-accent"></div>
              <span class="text-[12px] font-medium text-white">出片中...</span>
              <!-- 列表模式的缩略图只有 90px 宽，这行副文案会被挤到换行，故只在网格模式显示 -->
              <span v-if="!isList" class="text-micro text-text-muted">约 3~15 分钟</span>
            </div>

            <!-- 勾选框（多选模式 + 可选中时出现在左下角，避开左上告警角标与右下时长角标） -->
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

            <!-- 时长角标：列表模式的缩略图只有 46~75px 宽，这里再挂一个角标就会和
                 左下角的勾选框撞在一起（24 + 30 + 边距 > 卡片宽），所以列表模式把时长
                 移到信息区的编号旁边——本来就是同一条元信息，跟着编号更自然。 -->
            <div
              v-if="!isList"
              class="absolute bottom-2 right-2 rounded-full bg-black/60 px-2 py-0.5 font-mono text-micro text-white backdrop-blur-sm"
            >
              {{ shot.duration }}s
            </div>
          </div>

          <!-- 信息区（2026-09-16 精简 / 2026-09-16 支持列表布局）：
               编号 + 武戏标签 + 行内操作。时长交给画面上那个角标显示，这里不再重复一遍。
               危险操作（删除）改为中性色，hover 才转红：44 张卡片上挂 44 个红按钮，
               红色就不再是"警告"了。
               ⚠️ 外层容器在两种布局下方向相反（网格=横排 / 列表=竖排），
               但内部「编号行」始终是两端对齐的一行 ——
               网格模式靠 flex-1 撑满，列表模式靠 w-full，按钮因此都停在右端。 -->
          <div
            :class="isList
              ? 'flex min-w-0 flex-1 flex-col justify-between gap-2'
              : 'flex items-center justify-between gap-1.5 px-2 py-1.5'"
          >
            <div class="flex min-w-0 items-center gap-1.5">
              <span class="truncate font-mono text-[12px] font-medium text-text-primary">{{ shot.shotNumber || shot.displayId || shot.id }}</span>
              <!-- 武戏是「题材标签」不是「错误」：原来用 danger 红，会让用户在一屏 44 张卡片里
                   白白紧张一下。红色应当只留给真正需要处置的问题。 -->
              <span v-if="shot.isCombat" class="shrink-0 rounded-full bg-info/15 px-1.5 py-px text-micro text-info">武戏</span>
              <!-- 列表模式的时长（网格模式在画面右下角，见上面的角标） -->
              <span v-if="isList" class="shrink-0 font-mono text-micro text-text-muted">{{ shot.duration }}s</span>
            </div>
            <!-- 徽章区（2026-09-16 从预览区移出，二次修订后进入信息区）：
                 列表模式的缩略图只有 90px 宽，「衔接异常 CCT差120K」这类徽章根本排不下，
                 所以它必须独立于预览区。网格模式用绝对定位盖在画面上（相对卡片根节点，
                 预览区就贴在该角，位置不变）；列表模式随流落在信息区的中段换行。 -->
            <div :class="isList ? 'flex min-w-0 flex-wrap items-center gap-1.5' : ''">
              <!-- 左上角状态列：需要用户处置的问题，用实色徽章"跳"出来。
                   规格全部统一为 h-5 / rounded-full / text-micro——旧版混用 22px 高的
                   rounded-control 与 rounded-full 两种形状，一眼就看得出是拼的。 -->
              <div
                :class="isList
                  ? 'flex flex-wrap items-center gap-1'
                  : 'absolute left-2 top-2 z-[6] flex max-w-[calc(100%-16px)] flex-col items-start gap-1'"
              >
                <span
                  v-if="seamAlert(shot)"
                  :title="seamTip(shot)"
                  class="flex h-5 max-w-full items-center gap-1 rounded-full bg-danger px-2 text-micro font-medium text-white"
                >
                  <svg class="h-3 w-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" /></svg>
                  <span class="truncate">{{ shot.seamCheck?.checkType === 'openerTone' ? `色调跑偏 R-B${shot.seamCheck?.rb}` : `衔接异常${shot.seamCheck?.cctDiffK != null ? ` CCT差${shot.seamCheck.cctDiffK}K` : ''}` }}</span>
                </span>
                <span
                  v-if="reviewAlert(shot)"
                  :title="reviewTip(shot)"
                  class="flex h-5 max-w-full items-center gap-1 rounded-full px-2 text-micro font-medium text-white"
                  :class="shot.shotReview?.verdict === 'fail' ? 'bg-danger' : 'bg-warn'"
                >
                  <svg class="h-3 w-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                  <span class="truncate">观片{{ shot.shotReview?.verdict === 'fail' ? '不合格' : '待复核' }} {{ shot.shotReview?.avgScore }}</span>
                </span>
              </div>

              <!-- 右上角状态列：正常态用「半透明黑底 + 语义色圆点」，
                   比绿底/橙底实色徽章安静得多 —— 44 张卡片全挂绿牌子时，页面只剩吵闹。 -->
              <div
                :class="isList
                  ? 'flex flex-wrap items-center gap-1'
                  : 'absolute right-2 top-2 z-[6] flex max-w-[calc(100%-16px)] flex-col items-end gap-1'"
              >
                <span
                  v-if="hasDisplayVideo(shot)"
                  :title="isFallbackOnly(shot) ? `本镜切片缺失，暂播整段成片 ${shot.segmentLabel}（可在段管线补切）` : segmentTip(shot)"
                  class="flex h-5 items-center gap-1 rounded-full bg-black/65 px-2 text-micro font-medium text-white ring-1 ring-inset ring-white/15 backdrop-blur-sm"
                >
                  <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="isFallbackOnly(shot) ? 'bg-warn' : 'bg-ok'"></span>
                  {{ isFallbackOnly(shot) ? '段成片' : '已生成' }}
                </span>
                <span
                  v-if="shotErrAlerts(shot).length"
                  :title="alertsTip(shot)"
                  class="flex h-5 items-center gap-1 rounded-full bg-danger px-2 text-micro font-medium text-white"
                >
                  <svg class="h-3 w-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                  未验收 {{ shotErrAlerts(shot).length }}
                </span>
              </div>
            </div>
            <!-- 主操作：网格模式缩在编号行右端；列表模式独占底部一行、右对齐，
                 让卡片形成"上（编号）— 中（徽章）— 下（操作）"的结构。 -->
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
              <span
                v-else-if="isFallbackOnly(shot)"
                class="flex h-6 shrink-0 items-center rounded-control bg-warn/15 px-2 text-micro text-warn"
                :title="`本镜切片缺失，暂播整段成片 ${shot.segmentLabel}（点击卡片画面可看，建议在段管线补切）`"
              >切片缺失</span>
              <button
                v-else
                class="h-6 shrink-0 rounded-control border border-border px-2 text-micro text-text-secondary transition hover:border-border-light hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
                :disabled="store.generatingVideoIds.includes(shot.id)"
                @click.stop="generateSingle(shot.id)"
              >重出</button>

              <!-- 删除成片：仅已有视频的镜显示。仅切片兜底的镜也有按钮，但走段联动（连带整段） -->
              <button
                v-if="hasDisplayVideo(shot)"
                class="h-6 shrink-0 rounded-control px-2 text-micro text-text-muted transition hover:bg-danger/10 hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"
                :disabled="store.generatingVideoIds.includes(shot.id) || deleting"
                :title="isFallbackOnly(shot)
                  ? '删除本镜成片：本镜无独立切片，按段联动会连带删除其所属整段成片'
                  : '删除本镜成片，镜头退回未出片'"
                @click.stop="deleteSingleShotVideo(shot)"
              >删除</button>
            </div>
          </div>
        </div>
      </div>
      </template>
    </div>

    <!-- ═══ 底部状态条：已移除 ═══
         原底栏「可播 N/M · 独立出片 N · 总时长 Ns · 引擎说明」四项与命令栏进度组、
         「出片设置」弹层三处 100% 重复，独占一整条 60px 高度。数字已上移到命令栏，
         引擎说明收进设置弹层——信息一条不少，页面少一层噪声。 -->

    <!-- ═══ 批量删除操作条（多选模式时浮出）═══
         Teleport 到 body：页面根容器带 overflow/transform 时 fixed 会退化成相对定位，
         Teleport 出去才能稳定贴住视口。
         bottom-6：底部状态条已移除，浮条不再需要 bottom-24 去躲它——原来那个高度让它
         悬在半空、跟底栏之间空出一段莫名其妙的缝。 -->
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
          title="删除选中镜头的成片（文件移入服务端回收站，可手工找回；段级出片会连带整段）"
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

    <!-- 连续播放模态 -->
    <Teleport to="body">
      <div
        v-if="playModal"
        class="fixed inset-0 z-[80] flex items-center justify-center bg-black/85 p-6 backdrop-blur-sm"
        @click.self="closePlayer"
      >
        <!-- 弹窗宽度「随画面比例收缩」：竖屏项目下就是一个窄竖窗。
             旧版固定 max-w-5xl + aspect-video，等于把 9:16 画面塞进 16:9 的大黑框，
             两侧空掉一大半、画面还被压扁 —— 播放器是看片的地方，这里最不该出错。 -->
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
                  镜头 {{ playingShot?.shotNumber || playingShot?.displayId || playingShot?.id }} · {{ playingShot?.duration }}s{{ isFallbackOnly(playingShot) ? ` · ${playingShot.segmentLabel} 段内起播` : '' }}
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
          <!-- 高度按视口封顶、宽度按画面自身比例自适应，object-contain 兜底保证永不变形 -->
          <div class="relative flex items-center justify-center bg-black">
            <video
              ref="playVideoRef"
              :src="playingShot ? (displayVideoUrl(playingShot) || fallbackSegUrl(playingShot)) : ''"
              controls
              autoplay
              class="h-[68vh] w-auto max-w-[92vw] object-contain"
              @ended="onPlayEnded"
              @loadedmetadata="onPlayerMeta"
              @timeupdate="onPlayerTimeUpdate"
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
