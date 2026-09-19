<script setup>
// 分镜质检面板（2026-09-16）
//
// 存在理由：storyboardValidator 早就查得出十几类问题（越轴 / Airlock 角色消失 / 场景锚对不上 …），
// 但结论只落在后端 console.warn 里——系统查得出来，人却看不见，上百条 warning 躺在库里没人处理。
// 本面板把「查得出问题」变成「看得见问题 + 点得动修复」。
//
// 设计原则：
// 1. **不自带校验逻辑**：全部数据来自 GET /generate/qc-report，前端只做展示与触发。
//    分组/级别/能不能一键修，全部由后端 qcCodes 注册表给出（groups[].level / action / fixLabel）。
//    面板里**没有**任何 `if (code === 'XXX')` 分支——新增 QC 类型零改前端。
// 2. **不可修的问题也照实展示**：action=manual 的分组不给按钮，但给出 hint 与命中的镜头号，
//    让人知道"这里有问题，得手动处理"，而不是从面板上凭空消失。
// 3. **修复批量上限由后端管**：单批 20 镜（config.storyboard.qcFixBatchLimit），
//    返回 truncated 时面板提示"再点一次"，不在前端做分片循环——避免长时间挂起无进度。
import { computed, ref, watch } from 'vue'
import { useProjectStore } from '../stores/project'
import { confirmDialog } from '../services/dialog'

const store = useProjectStore()
const emit = defineEmits(['locate'])

const expandedCode = ref('') // 当前展开的分组（手风琴，一次开一个，避免长列表失控）
const confirming = ref('')   // 正在二次确认的 code

const report = computed(() => store.qcReport)
const groups = computed(() => report.value?.groups || [])
const counts = computed(() => ({
  error: report.value?.errorCount || 0,
  warning: report.value?.warningCount || 0,
  total: report.value?.total || 0,
  ignored: report.value?.ignoredCount || 0,
  shots: report.value?.shotCount || 0,
  scenes: report.value?.sceneCount || 0,
  scriptScenes: report.value?.scriptSceneCount || 0,
}))

// 质检作用域描述：镜级检查看分镜，跨场事理检查看剧本，两者作用域不同。
// 分镜被清空（0 镜）而剧本仍在时，事理检查照样出结论——此时写"0 镜"会让人以为没检查，
// 故按实际有数据的部分拼描述（2026-09-16 接入跨场事理检查时补）。
const scopeText = computed(() => {
  const parts = []
  if (counts.value.shots) parts.push(`${counts.value.shots} 镜`)
  if (counts.value.scenes) parts.push(`${counts.value.scenes} 分镜场次`)
  if (counts.value.scriptScenes) parts.push(`${counts.value.scriptScenes} 剧本场次`)
  return parts.join(' / ')
})

// 面板整体状态：空 / 干净 / 有问题，三态文案由计数推导
const status = computed(() => {
  if (store.qcLoading && !report.value) return { key: 'loading', text: '质检中…' }
  if (!report.value) return { key: 'idle', text: '未质检' }
  if (counts.value.total === 0) return { key: 'clean', text: '全部通过' }
  if (counts.value.error > 0) return { key: 'error', text: `${counts.value.error} 处必须修` }
  return { key: 'warn', text: `${counts.value.warning} 处建议修` }
})

// 最近一次修复结果的语气：含"未成功/失败/未登记/需要人工"→ 警示色；否则成功色。
// 判据放在一处，避免模板里写多个 includes 条件（改文案时容易漏同步）。
const lastResultTone = computed(() => {
  const t = store.qcLastResult || ''
  return /失败|未成功|未登记|需要人工|无法/.test(t) ? 'bad' : 'good'
})

// 每个分组的可达性：有 items 且不是集级（shot==='*'）才能批量修
function removable(g) {
  return g.items?.some((it) => it.shot && it.shot !== '*')
}

// 问题条目能否定位到具体镜头。
// 除集级 '*' 外，**场级结论**（'场次N'）同样不可定位——跨场事理检查的作用域是剧本场次，
// 不是镜头，store 的 shotIndex 里没有这个键，点了只会静默无反应（2026-09-16 接入时补）。
// 判据与后端产出口径一致：场级用"场次N"标签（见 routes/qc.js collectContinuityWarnings）。
function isLocatable(shot) {
  if (!shot || shot === '*') return false
  return !/^场次\d+$/.test(String(shot))
}
function shotLabel(shot) {
  if (shot === '*') return '整集'
  return String(shot)
}
function shotTitle(it) {
  if (it.shot === '*') return '整集级问题，不指向具体镜头'
  if (!isLocatable(it.shot)) return '场级问题（跨场事理检查），请到剧本页对应场次处理'
  return '点击定位到该镜头'
}
function isFixing(code) {
  return store.qcFixing.includes(code)
}

function toggle(code) {
  expandedCode.value = expandedCode.value === code ? '' : code
  confirming.value = ''
}

function levelClass(level) {
  return level === 'error'
    ? 'border-danger/40 bg-danger/10 text-danger'
    : 'border-warn/40 bg-warn/10 text-warn'
}

// 一键修复：manual 类不给按钮；其余交给 store（store 只透传，动作分流在后端）
async function runFix(g) {
  if (g.action === 'manual' || isFixing(g.code)) return
  if (confirming.value !== g.code) {
    // 两段式：先亮出"要改几个镜头"，再点确认——LLM 改写有成本，不做无确认的批量烧币
    confirming.value = g.code
    return
  }
  confirming.value = ''
  await store.qcFix(g.code)
}

// 忽略某条 / 忽略整组
// 「必须修」级例外（2026-09-16 审核修正）：error 级问题会**阻断出片**，忽略只在面板里隐藏它，
// 不解除出片拦截——不确认就点会出现"面板全绿、出片被拦"的分裂。故先确认一次，把语义讲明。
// warning 级不受影响（本来就是弱信号，忽略即"人工确认接受"）。
async function confirmErrorIgnore(g) {
  return confirmDialog({
    title: `忽略「${g.title || g.code}」？`,
    description: '这是「必须修」类问题——它会阻断出片。忽略只在面板里隐藏提示，不会解除出片拦截，建议先修复。',
    confirmText: '仍然忽略',
    cancelText: '去修复',
    tone: 'warn',
  })
}
async function ignoreOne(g, it) {
  if (g.level === 'error' && !(await confirmErrorIgnore(g))) return
  await store.qcIgnore(g.code, it.shot)
}
async function ignoreGroup(g) {
  if (g.level === 'error' && !(await confirmErrorIgnore(g))) return
  await store.qcIgnore(g.code, null)
}

async function refresh() {
  await store.loadQcReport()
}

// 点击镜头号 → 让父级滚动到那一行并高亮（父级实现定位，面板不碰 DOM）
function locate(shotNumber) {
  if (!shotNumber || shotNumber === '*') return
  emit('locate', shotNumber)
}

// 集切换：只重置面板内 UI 态（展开项/二次确认）。
// 报告加载已上移到 StoryboardView（2026-09-16）：本组件挂在 v-if 下，收起时不挂载，
// 在这里拉会导致"收起面板 = 永不质检"；且两边都拉会重复请求。
watch(
  () => store.currentEpisodeId,
  () => {
    expandedCode.value = ''
    confirming.value = ''
  },
  { immediate: true }
)
</script>

<template>
  <div class="overflow-hidden rounded-card border border-border bg-bg-secondary/50">
    <!-- ═══ 面板头：计数 + 刷新 + 已忽略开关 ═══ -->
    <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-4 py-2.5">
      <div class="flex min-w-0 items-center gap-2.5">
        <span class="text-[13px] font-medium text-text-primary">质检</span>

        <!-- 状态徽章：三态由计数推导，颜色即结论 -->
        <span
          class="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-micro font-medium"
          :class="{
            'border-border bg-bg-card text-text-muted': status.key === 'idle' || status.key === 'loading',
            'border-ok/30 bg-ok/10 text-ok': status.key === 'clean',
            'border-danger/40 bg-danger/10 text-danger': status.key === 'error',
            'border-warn/40 bg-warn/10 text-warn': status.key === 'warn',
          }"
        >
          <span
            class="h-1.5 w-1.5 rounded-full"
            :class="{
              'bg-text-muted': status.key === 'idle' || status.key === 'loading',
              'bg-ok': status.key === 'clean',
              'bg-danger': status.key === 'error',
              'bg-warn': status.key === 'warn',
            }"
          ></span>
          {{ status.text }}
        </span>

        <!-- 计数明细：只在有报告时显示，避免空数据噪音 -->
        <span v-if="report" class="flex items-center gap-2.5 text-micro text-text-muted">
          <span v-if="counts.error" class="text-danger"><b class="font-mono font-medium">{{ counts.error }}</b> 必须修</span>
          <span v-if="counts.warning" class="text-warn"><b class="font-mono font-medium">{{ counts.warning }}</b> 建议修</span>
          <span v-if="counts.ignored" class="text-text-muted"><b class="font-mono font-medium">{{ counts.ignored }}</b> 已忽略</span>
          <span v-if="report.trimmed" class="text-info" :title="`单类问题条数较多，已截断展示（上限 ${report.actions ? 2000 : ''}）`">已截断</span>
        </span>
      </div>

      <div class="flex shrink-0 items-center gap-2">
        <!-- 显示已忽略：忽略项由后端过滤，前端只切开关后重拉（口径单一） -->
        <label class="flex cursor-pointer items-center gap-1.5 text-micro text-text-muted transition hover:text-text-secondary">
          <input
            type="checkbox"
            class="h-3 w-3 cursor-pointer accent-info"
            :checked="store.qcShowIgnored"
            @change="store.toggleQcShowIgnored()"
          />
          显示已忽略
        </label>
        <button
          class="flex items-center gap-1.5 rounded-btn border border-border bg-bg-secondary/60 px-2.5 py-1 text-micro text-text-secondary transition hover:border-border-light hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="store.qcLoading"
          title="重新跑一遍质检（复用分镜校验器，不额外调用 AI）"
          @click="refresh"
        >
          <svg
            class="h-3 w-3"
            :class="store.qcLoading ? 'animate-spin' : ''"
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          ><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
          {{ store.qcLoading ? '质检中' : '重新质检' }}
        </button>
      </div>
    </div>

    <!-- ═══ 最近一次修复结果提示条 ═══ -->
    <div
      v-if="store.qcLastResult"
      class="flex items-start gap-2 border-b border-border/70 px-4 py-2 text-micro animate-fade-up"
      :class="lastResultTone === 'bad' ? 'bg-danger/8 text-danger' : 'bg-ok/8 text-ok'"
    >
      <svg class="mt-0.5 h-3 w-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
      <span class="leading-relaxed">{{ store.qcLastResult }}</span>
    </div>

    <!-- ═══ 分组列表 ═══ -->
    <div v-if="groups.length" class="divide-y divide-border/60">
      <div v-for="g in groups" :key="g.code">
        <!-- 分组头（点击展开） -->
        <div class="flex items-center gap-2 px-4 py-2 transition hover:bg-bg-hover/40">
          <button class="group flex min-w-0 flex-1 items-center gap-2.5 text-left" @click="toggle(g.code)">
            <svg
              class="h-3 w-3 shrink-0 text-text-muted transition-transform duration-200"
              :class="expandedCode === g.code ? 'rotate-90' : ''"
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            ><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 5l7 7-7 7" /></svg>
            <span
              class="inline-flex shrink-0 items-center rounded-control border px-1.5 py-0.5 text-micro font-medium"
              :class="levelClass(g.level)"
            >{{ g.level === 'error' ? '必须修' : '建议修' }}</span>
            <span class="truncate text-[12px] font-medium text-text-primary">{{ g.title || g.code }}</span>
            <span class="shrink-0 rounded-full border border-border bg-bg-primary/50 px-1.5 py-0.5 font-mono text-micro text-text-secondary">{{ g.items.length }}</span>
            <span v-if="g.hint" class="hidden min-w-0 flex-1 truncate text-micro text-text-muted lg:block" :title="g.hint">{{ g.hint }}</span>
          </button>

          <!-- 分组操作：可自动修的给按钮，其余只给忽略 -->
          <div class="flex shrink-0 items-center gap-1.5">
            <button
              v-if="g.action !== 'manual' && removable(g)"
              class="flex items-center gap-1 rounded-btn px-2 py-1 text-micro font-medium transition disabled:cursor-not-allowed disabled:opacity-50"
              :class="confirming === g.code
                ? 'bg-accent text-black hover:bg-accent-hover'
                : 'bg-accent/15 text-accent hover:bg-accent/25'"
              :disabled="isFixing(g.code)"
              :title="confirming === g.code
                ? `确认修复 ${g.items.length} 处（AI 改写，会消耗额度）`
                : (g.fixLabel || '一键修复')"
              @click="runFix(g)"
            >
              <svg v-if="isFixing(g.code)" class="h-3 w-3 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
              <svg v-else-if="confirming === g.code" class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7" /></svg>
              {{
                isFixing(g.code)
                  ? '修复中…'
                  : confirming === g.code
                    ? `确认修 ${g.items.length} 处`
                    : (g.fixLabel || '一键修复')
              }}
            </button>
            <span
              v-else-if="g.action === 'manual'"
              class="rounded-control px-1.5 py-0.5 text-micro text-text-muted"
              :title="g.hint || '这类问题涉及剧情/资产设定，自动改会改坏内容，需人工处理'"
            >需人工</span>
            <button
              class="rounded-btn px-1.5 py-1 text-micro text-text-muted transition hover:bg-bg-hover hover:text-text-secondary"
              :title="g.level === 'error'
                ? '忽略该类型下的全部问题（必须修类会阻断出片，忽略只隐藏面板提示、不解除拦截）'
                : '忽略该类型下的全部问题（标记为已知且接受，可撤销）'"
              @click="ignoreGroup(g)"
            >忽略整类</button>
          </div>
        </div>

        <!-- 展开：逐条问题 -->
        <div v-if="expandedCode === g.code" class="border-t border-border/50 bg-bg-primary/40 px-4 py-2">
          <p v-if="g.hint" class="mb-2 text-micro leading-relaxed text-text-muted">{{ g.hint }}</p>
          <ul class="space-y-1">
            <li
              v-for="(it, i) in g.items"
              :key="`${it.shot}-${i}`"
              class="group/item flex items-start gap-2 rounded-btn px-2 py-1.5 transition hover:bg-bg-hover/50"
            >
              <button
                class="mt-px shrink-0 rounded-control border px-1.5 py-0.5 font-mono text-micro transition"
                :class="isLocatable(it.shot)
                  ? 'border-border bg-bg-primary/60 text-text-secondary hover:border-accent/50 hover:text-accent'
                  : 'cursor-default border-border bg-bg-primary/60 text-text-muted'"
                :disabled="!isLocatable(it.shot)"
                :title="shotTitle(it)"
                @click="locate(it.shot)"
              >{{ shotLabel(it.shot) }}</button>
              <span class="min-w-0 flex-1 break-words text-micro leading-relaxed text-text-secondary">{{ it.message }}</span>
              <button
                class="shrink-0 rounded-tag px-1.5 py-0.5 text-micro text-text-muted opacity-0 transition group-hover/item:opacity-100 hover:text-text-secondary"
                title="忽略这一条"
                @click="ignoreOne(g, it)"
              >忽略</button>
            </li>
          </ul>
          <p v-if="g.items.length >= 200" class="mt-1.5 text-micro text-text-muted">（列表已截断，仅显示前 200 条）</p>
        </div>
      </div>
    </div>

    <!-- ═══ 空态 ═══ -->
    <div v-else class="flex items-center gap-2 px-4 py-3 text-micro text-text-muted">
      <template v-if="store.qcLoading">
        <svg class="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
        正在跑质检…
      </template>
      <template v-else-if="report">
        <svg class="h-3.5 w-3.5 text-ok" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7" /></svg>
        未检出问题（{{ scopeText || '无数据' }}）
      </template>
      <template v-else>
        暂无质检数据，点「重新质检」跑一次
      </template>
    </div>
  </div>
</template>
