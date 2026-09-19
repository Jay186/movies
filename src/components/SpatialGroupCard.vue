<script setup>
// 空间组卡片（2026-09-17 空间组视图）：组容器 = 组头 + 参考图大卡 + 轨道（成员行走 slot）
//
// 设计依据：design/scene-groups-design-spec.md §4 GroupSection / BaselineCard + 原型
// 星型拓扑的视觉化：参考图卡在左、成员在右，中间带圆点的竖轨道 —— 结构即设计。
// 状态三重编码：左状态条（3px）+ 组头徽章（icon+文字）+ 参考图卡标签，不单靠颜色。
// 业务动作全部 emit 给父级（SettingsView 接 decide / 生成 / 整组重画），本组件零业务依赖。
import { computed, ref, watch } from 'vue'

const props = defineProps({
  // status API 的组对象：group/status/repScene*/baselineImageUrl/baselineReused/sharedProps/memberScenes
  group: { type: Object, required: true },
  busy: { type: Boolean, default: false }, // 组级决策/整组重画进行中
  // 外部（父级"全部收起/展开"）下发的折叠指令。null = 不干预，各组自由；true/false = 强制收/展。
  // forceCollapseToken 每次父级点击 +1 —— 让 watch 必然触发（连点两次"收起全部"时
  // boolean 值不变，只监听值本身会在第二次失效）。
  forceCollapsed: { type: Boolean, default: null },
  forceCollapseToken: { type: Number, default: 0 },
  // 参考图版本历史（2026-09-17 布哥："留历史记录参照对比"）：
  // 代表场每次生成/改造都自动入 asset_image_history，这里消费它做并排对比 + 换回。
  // 由父级按需加载（展开且未加载过才拉），空数组 = 还没加载或无历史。
  baselineHistory: { type: Array, default: () => [] },
  // 分组人审锁定（2026-09-17）：该组是否已被锁定 —— 锁定后 LLM 重析不能重组这些场次。
  // 由父级从 /scene-groups/locks 读出后按组名下发（父级掌握全集，本组件只管单组呈现）。
  locked: { type: Boolean, default: false },
  // 该组锚是否为孤儿（已确认但当前无场次归属 = 人审基准已失效）。
  // 这是"分组漂移"留下的伤口，必须显式提示，不能沿用旧的静默失效。
  orphanAnchor: { type: Object, default: null },
  // 布局示意图锚（A3，2026-09-18）：{ imageUrl, description } 或 null。
  // 由父级从 status 接口的 group.layoutAnchor 直接下发（已并入，免逐组查询）。
  layoutAnchor: { type: Object, default: null },
  // 布局图生成进行中（父级下发；与 busy 分开是因为它只锁这一张图，不该锁整卡按钮）
  layoutBusy: { type: Boolean, default: false },
  // 布局图是否已过时（素材变了）：true=建议重画 / false=仍有效 / null=不适用（没图或无法判断）。
  // 三档必须区分：null 不提示（老数据没有指纹是我们的历史欠账，不能变成一片噪音），
  // 只有确定的 true 才提示——提示一旦有误报，用户就再也不看它了。
  //
  // ⚠️ 类型刻意写 [Boolean, null] 而不是 Boolean：Vue 对纯 Boolean prop 有特殊转换
  //   （未传 → default，但传 0/''/undefined 等假值时行为反直觉，空串甚至会变 true）。
  //   写成联合类型才能让 null 原样透传，保住"不适用"这第三档的语义。
  //   模板里一律用 `layoutStale === true` 严格比较，不依赖真假值转换。
  layoutStale: { type: [Boolean, null], default: null },
})
const emit = defineEmits(['confirm', 'skip', 'regen-baseline', 'refresh-group', 'restore-version', 'toggle-lock', 'generate-layout', 'preview-layout'])

// 组收缩（2026-09-17 布哥提）：点组头把「参考图大卡 + 成员行」收起，只留标题行。
// 收起时保留 64px 缩略图 —— 纯粹为了「一屏能扫更多组」而不丢识别信息：
//   组名可能抽象（forest_high_rock），一眼看图比读名字快。
// 状态不持久化（刻意）：刷新后一律展开。组数少时展开态是有效默认，
//   记忆收起态反而会让用户"上次明明收过怎么又开了/怎么还是收的"两头困惑。
const collapsed = ref(false)
function toggleCollapse() {
  collapsed.value = !collapsed.value
}

// 父级"全部收起/展开"：以 token 变化为触发信号（不是以值为信号，见 prop 注释）。
watch(
  () => props.forceCollapseToken,
  () => {
    if (props.forceCollapsed === null) return
    collapsed.value = props.forceCollapsed
  }
)

const isSolo = computed(() => (props.group?.memberScenes?.length || 0) === 1)
const memberCount = computed(() => props.group?.memberScenes?.length || 0)
const sharedPropsText = computed(() => (props.group?.sharedProps || []).join(' · '))

// 组容器左状态条颜色：pending=warn / confirmed=ok / skipped=中性
const stateBarClass = computed(() => {
  if (props.group?.status === 'pending') return 'border-l-warn'
  if (props.group?.status === 'confirmed') return 'border-l-ok'
  return 'border-l-border-strong'
})

const statusBadge = computed(() => {
  // 单场景组：不存在"定参考图"这件事（后端恒为 skipped），徽章只说事实，不提示待办
  if (isSolo.value) return { cls: 'bg-bg-hover text-text-secondary border border-border', icon: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z', text: '单场景 · 用自己的图' }
  if (props.group?.status === 'pending') return { cls: 'bg-warn/15 text-warn border border-warn/30', icon: 'M12 7.5v6M12 16.5h.01', text: '还没定参考图' }
  if (props.group?.status === 'confirmed') return { cls: 'bg-ok/12 text-ok border border-ok/30', icon: 'M5 13l4 4L19 7', text: '参考图已定' }
  return { cls: 'bg-bg-hover text-text-secondary border border-border', icon: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z', text: '已跳过 · 自由出图' }
})

// 参考图卡角标：单场景组不标（它不是"参考图"）；confirmed=ok 参考图 / pending=warn 备选图 / skipped=中性
const baselineBadge = computed(() => {
  if (isSolo.value) return null
  if (props.group?.status === 'confirmed') return { cls: 'border-ok/50 bg-black/75 text-ok', text: '参考图' }
  if (props.group?.status === 'pending') return { cls: 'border-warn/50 bg-black/75 text-warn', text: '备选图' }
  return { cls: 'border-white/20 bg-black/75 text-white/80', text: '没定参考图' }
})

// 版本带：只显示"有对比价值"的版本——单条历史说明还没画过第二张，带子没有意义。
// 场景表没有 description 列（只有 summary），恢复接口已做兼容，这里只做展示。
const showHistory = computed(() => !isSolo.value && (props.baselineHistory?.length || 0) > 1)
// 版本标签：场景来源只有 generate/edit 两种，弱化成"第 N 版 + 时间"，比英文枚举好读。
// 宽度只有 76px，故不带"生成/改造"前缀（绝大多数是生成，前缀纯占位还挤掉时间）。
function versionLabel(h, idx, total) {
  const n = total - idx   // 倒序展示（最新在前），故第 idx 条 = 倒数第 (total-idx) 版
  const t = String(h.created_at || '').slice(11, 16)   // 'YYYY-MM-DD HH:MM:SS' → 'HH:MM'
  return h.is_current ? `第 ${n} 版 · 当前` : `第 ${n} 版 · ${t}`
}

// ── 布局示意图（A3，2026-09-18）─────────────────────────────────────────────
// 只有多场景组才需要布局图：它的价值是"给一组不同视角的场景一个无冲突的空间共识"。
// 单场景组没有第二个视角要共识，画了纯属花钱（与参考图同一条判断，前后端口径一致）。
const showLayout = computed(() => !isSolo.value && memberCount.value > 1)
const hasLayout = computed(() => !!props.layoutAnchor?.imageUrl)
</script>

<template>
  <section
    class="flex w-full flex-col rounded-panel border border-border bg-[#16161B] p-4 pl-[18px] shadow-card"
    :class="stateBarClass"
    style="border-left-width: 3px"
    :data-group-card="group.status || ''"
    :aria-label="`场景组 ${group.group}`"
  >
    <!-- 组头：中文名（代表场）· 英文 key · 计数 · 状态徽章 · 组操作 -->
    <!-- 整行可点：折叠/展开（组头是天然的折叠把手，比只在右侧放个小箭头好点得多） -->
    <div
      class="flex cursor-pointer select-none items-center gap-2.5 rounded-control px-1.5 py-1 transition hover:bg-bg-hover/40"
      :class="collapsed ? '' : 'mb-3.5'"
      role="button"
      :aria-expanded="!collapsed"
      :aria-label="`${collapsed ? '展开' : '收起'}场景组 ${group.group}`"
      :title="collapsed ? '展开这组' : '收起这组'"
      @click="toggleCollapse"
    >
      <!-- 收起态缩略图（64px）：只读参考图，保住"一眼识别" -->
      <img
        v-if="collapsed && group.baselineImageUrl"
        :src="group.baselineImageUrl"
        :alt="`场景组 ${group.group} 缩略图`"
        class="h-9 w-14 shrink-0 rounded-md border border-border object-cover"
      />
      <span class="shrink-0 text-2xs font-medium text-text-primary" :title="`代表场景：${group.repSceneTitle || ''}`">{{ group.repSceneTitle || group.group }}</span>
      <span class="shrink-0 font-mono text-micro text-text-muted" :title="`组键（对照日志）：${group.group}`">{{ group.group }}</span>
      <span class="shrink-0 text-micro text-text-muted">{{ memberCount }} 个场景</span>
      <span class="flex h-[22px] shrink-0 items-center gap-1 rounded-pill px-2.5 text-micro" :class="statusBadge.cls">
        <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" :d="statusBadge.icon" /></svg>
        {{ statusBadge.text }}
      </span>
      <!-- 分组锁定徽章（2026-09-17）：显示"这组的分组已被锁住"。
           为什么要显式展示：锁是**看不见的保护**——用户看不到它，就不知道自己受保护，
           也不会在需要重分组时知道该先解锁。徽章可点，直接切锁。 -->
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
      <!-- 组级操作：已定参考图才给「整组照参考图重画」（覆盖式 + 计费 → 交给父级二次确认）
           点按钮不该连带折叠，故 stop（组头整行是折叠把手）。
           收起态隐藏：组都收起来了还提供"整组重画"是错位的（用户此刻只在扫览，不在操作） -->
      <button
        v-if="group.status === 'confirmed' && memberCount > 1 && !busy && !collapsed"
        class="flex h-7 items-center gap-1.5 rounded-control px-2.5 text-micro text-text-secondary transition hover:bg-bg-hover hover:text-white"
        title="照这张参考图重画组内全部场景（覆盖式，计费）"
        @click.stop="emit('refresh-group')"
      >
        <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
        整组照参考图重画
      </button>
      <span v-else-if="busy" class="flex items-center gap-1.5 text-micro text-text-muted">
        <svg class="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" /><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
        处理中
      </span>
      <!-- 折叠把手：chevron 随状态旋转，是"这里能点"的显式信号（整行可点也要给视觉线索） -->
      <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-text-muted transition hover:bg-bg-hover hover:text-white">
        <svg class="h-3.5 w-3.5 transition-transform" :class="collapsed ? '' : 'rotate-90'" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" /></svg>
      </span>
    </div>

    <!-- 孤儿锚警告（2026-09-17）：已确认的组锚没有了场次归属 = 人审基准失效。
         必须显式告警：这个状态以前是**完全静默**的（锚还在库里、confirm=1，
         但没有任何场次指向它），用户以为基准还在，实际早就不生效了。
         只在这一组有孤儿时显示；无孤儿时整块不渲染（不占位、不噪音）。 -->
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

    <!-- 组体：参考图卡（左） + 轨道 + 成员行（右，slot）；收起时整体隐藏 -->
    <div v-show="!collapsed" class="flex items-start gap-0">
      <!-- 参考图大卡 -->
      <div class="w-[348px] shrink-0">
        <div class="overflow-hidden rounded-2xl border border-border bg-bg-card transition hover:border-border-light">
          <div class="relative h-[196px] bg-black">
            <img v-if="group.baselineImageUrl" :src="group.baselineImageUrl" :alt="`场景组 ${group.group} 参考图`" class="h-full w-full object-cover" />
            <div v-else class="flex h-full flex-col items-center justify-center gap-2">
              <svg class="h-8 w-8 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
              <span class="text-micro text-text-muted">代表场景还没有图</span>
            </div>
            <!-- 参考图卡标签（图上角）：状态三重编码的第三重；单场景组无此标签（baselineBadge=null） -->
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
              <!-- 地标清单：人审判断依据（组内反复出现的共享地标） -->
              <template v-if="isSolo">单场景组：用自己的图就行</template>
              <template v-else-if="sharedPropsText">地标清单：{{ sharedPropsText }}</template>
              <template v-else>组内 {{ memberCount }} 个场景都照这张图画</template>
            </div>
            <!-- 参考图卡操作：按状态分流。
                 单场景组（isSolo）：无下游可参考，不显示任何参考图按钮——
                   参考图的价值是「一图定义空间、其余照着画」，只有一个场景时没有"其余"。
                   后端 sync 已把这类组恒置 skipped（不计待办、不锁成员卡），
                   这里只保留「重新画一张」这一颗真正有作用的按钮。
                 pending 三按钮：就用这张当参考图（主） + 重新画一张 + 跳过（弹窗退役后的 skip 出口，
                 跳过后组内场景自由出图、不做空间约束）；
                 skipped 双按钮：随时可以回来定参考图（decide 接口幂等支持重决），
                 不留「跳过之后再也定不了」的死胡同，也不再显示「跳过」（已是跳过态）；
                 confirmed：重新画一张 + 就用这张当参考图。
                   注（2026-09-17）：重新画一张现在会**画完自动定参考图**（一步到位），
                   「就用这张当参考图」保留给"用已有图换锚"的场景（如从版本带换回旧版后落定）。 -->
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
                  class="flex h-[30px] flex-1 items-center justify-center gap-1.5 rounded-control bg-accent text-2xs font-medium text-black transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                  :disabled="busy || !group.baselineImageUrl"
                  :title="group.baselineImageUrl ? '定了之后，组内其它场景都照这张图画' : '代表场景还没图，先点「重新画一张」'"
                  @click="emit('confirm')"
                >
                  <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" /></svg>
                  就用这张当参考图
                </button>
                <button
                  class="flex h-[30px] items-center gap-1.5 rounded-control border border-border px-3 text-2xs text-text-secondary transition hover:border-border-light hover:text-white disabled:opacity-50"
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
            </div>

            <!-- 版本带（2026-09-17 布哥："留历史记录参照对比"）：
                 代表场每画一次就多一版，并排摆开做视觉对比；点旧版 = 换回它当参考图。
                 只在 ≥2 版时出现（单版没有"对比"可言，带子纯占地方）。
                 复用 asset_image_history（后端既有），组视图此前没接。 -->
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

        <!-- 布局示意图卡（A3，2026-09-18）：
             为什么单独一张而不是并进参考图卡：它和参考图是**两种不同性质的锚**，用途相反——
               参考图 = 一张照片（定光影/画风/质感，但带视角，不能照搬构图）
               布局图 = 一张俯视示意图（只定"什么在哪、朝哪、多远"，无视角/光影/画风）
             混在一张卡里会让人以为它们是同一类东西、可互相替代，实际是互补的两层。
             只在多场景组出现（单场景组没有第二个视角要共识）。 -->
        <div v-if="showLayout" class="mt-3 overflow-hidden rounded-2xl border border-border bg-bg-card transition hover:border-border-light">
          <div class="relative h-[124px] bg-black">
            <img
              v-if="hasLayout"
              :src="layoutAnchor.imageUrl"
              :alt="`场景组 ${group.group} 布局示意图`"
              class="h-full w-full cursor-zoom-in object-contain"
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
              <template v-if="hasLayout">
                只定位置/朝向/远近，不带视角光影 —— 组内 {{ memberCount }} 个视角都能照它对齐空间
              </template>
              <template v-else>
                给这 {{ memberCount }} 个场景一张共同的空间底图，避免各画各的、接不上
              </template>
            </div>

            <!-- 过时提示（2026-09-18）：布局图记录着"画它时用的素材"，与当前素材不一致 = 场景描述改过。
                 为什么必须显式提示：布局图是重析不删的（保护花钱生成的图），所以它会**悄悄过时**。
                 而过时的布局图比没有更糟 —— 组内场景会照着一张不再对应实际的底图对齐空间，
                 错误还会顺着锚放大到整组。以前这个状态完全静默，用户根本无从察觉。 -->
            <div
              v-if="layoutStale === true"
              class="mt-2 flex items-start gap-1.5 rounded-control border border-warn/30 bg-warn/10 px-2 py-1.5 text-micro leading-relaxed text-warn"
              role="alert"
            >
              <svg class="mt-px h-3 w-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" /></svg>
              <span>
                <span class="font-medium">这张图可能已过时</span>
                —— 这组的场景内容改过，图上的空间关系可能对不上了，建议重画。
              </span>
            </div>

            <button
              class="mt-2.5 flex h-[30px] w-full items-center justify-center gap-1.5 rounded-control border text-2xs transition disabled:opacity-50"
              :class="layoutStale === true
                ? 'border-warn/40 text-warn hover:bg-warn/10'
                : 'border-border text-text-secondary hover:border-accent/40 hover:text-accent'"
              :disabled="layoutBusy"
              :title="hasLayout ? '重画这张布局示意图（覆盖式，计费）' : '给这组画一张俯视布局示意图（计费）'"
              @click="emit('generate-layout')"
            >
              <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
              {{ hasLayout ? '重画布局图' : '生成布局图' }}
            </button>
          </div>
        </div>
      </div>

      <!-- 轨道 + 成员行（slot）：星型拓扑的视觉化 -->
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
