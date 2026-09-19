<template>
  <!-- 抽屉遮罩 -->
  <div v-if="visible" class="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm transition-opacity" @click.self="close">
    <!-- 右侧抽屉 -->
    <div class="absolute right-0 top-0 flex h-full w-[720px] max-w-[95vw] flex-col bg-bg-card shadow-2xl animate-slide-in">
      <!-- 顶部标题栏 -->
      <div class="flex items-center justify-between border-b border-border px-6 py-4">
        <div class="flex items-center gap-2">
          <span class="rounded bg-bg-hover px-2 py-0.5 text-xs text-text-secondary">{{ typeLabel[type] }}</span>
          <span class="text-sm font-medium text-white">{{ asset?.name || '未命名' }}</span>
        </div>
        <button class="flex h-8 w-8 items-center justify-center rounded-full text-text-secondary transition hover:bg-bg-hover hover:text-white" @click="close">
          <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
      </div>

      <!-- 内容区 -->
      <div class="flex-1 overflow-y-auto p-6">
        <!-- 图片区 -->
        <div class="mb-6">
          <label class="mb-2 block text-xs font-medium text-text-secondary">图片</label>
          <div class="aspect-video w-full overflow-hidden rounded-xl border border-border bg-black">
            <img v-if="asset?.imageUrl" :src="asset.imageUrl" :alt="asset.name" class="h-full w-full object-contain" />
            <div v-else class="flex h-full items-center justify-center">
              <svg class="h-16 w-16 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
            </div>
          </div>
        </div>

        <!-- 形象版本历史：图 + 描述快照一起回滚 -->
        <div v-if="history.length" class="mb-6">
          <label class="mb-2 block text-xs font-medium text-text-secondary">形象版本 <span class="font-normal text-text-muted">— 当前使用中，点击旧版可恢复（描述同步回滚）</span></label>
          <div class="flex gap-3 overflow-x-auto pb-1">
            <div v-for="h in history" :key="h.id" class="group relative w-28 shrink-0 cursor-pointer" :title="h.instruction || ''" @click="restoreVersion(h)">
              <div class="overflow-hidden rounded-lg border-2 transition" :class="h.is_current ? 'border-accent' : 'border-transparent opacity-75 group-hover:opacity-100'">
                <img :src="h.image_url" :alt="versionLabel(h)" class="h-16 w-full bg-black object-cover" />
              </div>
              <div class="mt-1 truncate text-[10px]" :class="h.is_current ? 'text-accent' : 'text-text-muted'">{{ versionLabel(h) }}</div>
              <div v-if="!h.is_current" class="pointer-events-none absolute inset-x-0 top-5 flex justify-center opacity-0 transition group-hover:opacity-100">
                <span class="rounded bg-accent px-2 py-0.5 text-[10px] font-medium text-black">{{ restoringId === h.id ? '恢复中...' : '恢复此版本' }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 改造此形象：以当前图为底图的图生图，换装/加饰品不漂移 -->
        <div v-if="asset?.imageUrl" class="mb-6 rounded-xl border border-border bg-bg-secondary p-3">
          <div class="mb-2 text-sm font-medium text-accent">改造此形象</div>
          <div class="flex gap-2">
            <input v-model="editInstruction" type="text" class="flex-1 rounded-lg border border-border bg-bg-card px-3 py-2 text-sm text-white outline-none transition focus:border-accent/50" placeholder="例：戴一条红色针织围巾，其余不变" @keyup.enter="submitEdit" />
            <button class="whitespace-nowrap rounded-lg bg-accent px-4 py-2 text-sm font-medium text-black transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60" :disabled="generating || !editInstruction.trim()" @click="submitEdit">{{ generating ? '改造中...' : '以此图改造' }}</button>
          </div>
          <div class="mt-1.5 text-[11px] text-text-muted">以当前形象为底图，形象不变只改指令部分；新版本自动入历史，描述自动同步</div>
        </div>

        <!-- 名称（大标题 + 点击编辑） -->
        <div class="mb-4">
          <div v-if="!editingName" class="flex items-center gap-2 group cursor-pointer" @click="editingName=true">
            <span class="text-2xl font-bold text-white">{{ editName || '未命名' }}</span>
            <svg class="h-4 w-4 text-text-muted opacity-0 transition group-hover:opacity-100" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
          </div>
          <input v-else v-model="editName" type="text" ref="nameInput" class="w-full rounded-lg border border-accent/50 bg-bg-secondary px-3 py-2 text-2xl font-bold text-white outline-none transition" placeholder="请输入名称" @blur="editingName=false" @keyup.enter="editingName=false" />
        </div>

        <!-- 描述 -->
        <div class="mb-4">
          <label class="mb-1.5 block text-xs font-medium text-text-secondary">描述（可直接用于 AI 生图）</label>
          <textarea v-model="editDescription" rows="8" class="w-full resize-none rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm leading-relaxed text-white outline-none transition focus:border-accent/50" placeholder="详细描述，用于 AI 生图"></textarea>
        </div>

        <!-- 场景光影常量（仅场景）：跨镜头不变的英文光照句，出片/生图逐字复用 -->
        <div v-if="type === 'scene'" class="mb-4">
          <label class="mb-1.5 block text-xs font-medium text-text-secondary">场景光影常量（英文，出片跨镜锁定光照）</label>
          <textarea v-model="editLightingEn" rows="3" class="w-full resize-none rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm leading-relaxed text-white outline-none transition focus:border-accent/50" placeholder="光源方位 + 色温 + 时间氛围，全英文 25 词以内。例：low slanting sunlight from the left, cold clear daylight, faint glints on the snow。留空 = 不注入"></textarea>
          <div class="mt-1 text-[11px] leading-relaxed text-text-muted">同一场景所有镜头的出片 prompt 与分镜图环境冻结声明会逐字复用这一句，钉死色温/光照方向；改动它 = 全场景生效。必须全英文，含中文不会注入。</div>
        </div>

        <!-- 英文常量（2026-09-16）：H3 官方要求提示词全英文，这些字段为空会静默回退中文名 → 中文混进英文提示词 -->
        <div class="mb-4 rounded-xl border border-border bg-bg-secondary p-3">
          <div class="mb-2 text-xs font-medium text-text-secondary">英文常量（H3 提示词必填，为空会退回中文名）</div>

          <!-- 角色：name_en + description_en -->
          <template v-if="type === 'character'">
            <input v-model="editNameEn" type="text" class="mb-2 w-full rounded-lg border border-border bg-bg-card px-3 py-2 text-sm text-white outline-none transition focus:border-accent/50" placeholder="角色英文名，例：Bubu" />
            <textarea v-model="editDescriptionEn" rows="3" class="w-full resize-none rounded-lg border border-border bg-bg-card px-3 py-2 text-sm leading-relaxed text-white outline-none transition focus:border-accent/50" placeholder="角色英文外貌描述，模块2 逐字复用。例：a light-brown bear dumpling with small round brown ears, small black dot eyes"></textarea>
          </template>

          <!-- 道具：name_en + description_en + location -->
          <template v-else-if="type === 'prop'">
            <input v-model="editNameEn" type="text" class="mb-2 w-full rounded-lg border border-border bg-bg-card px-3 py-2 text-sm text-white outline-none transition focus:border-accent/50" placeholder="道具英文名，例：giant snowball" />
            <textarea v-model="editDescriptionEn" rows="3" class="w-full resize-none rounded-lg border border-border bg-bg-card px-3 py-2 text-sm leading-relaxed text-white outline-none transition focus:border-accent/50" placeholder="道具英文描述，模块2 逐字复用。例：a giant rolled snowball, packed snow with faint trail lines"></textarea>
          </template>

          <!-- 场景：location + title_en + summary_en -->
          <template v-else-if="type === 'scene'">
            <input v-model="editLocation" type="text" class="mb-2 w-full rounded-lg border border-border bg-bg-card px-3 py-2 text-sm text-white outline-none transition focus:border-accent/50" placeholder="场景地点，例：冰河浅滩" />
            <input v-model="editTitleEn" type="text" class="mb-2 w-full rounded-lg border border-border bg-bg-card px-3 py-2 text-sm text-white outline-none transition focus:border-accent/50" placeholder="场景英文名，例：Snowy Mountain Path" />
            <textarea v-model="editSummaryEn" rows="3" class="w-full resize-none rounded-lg border border-border bg-bg-card px-3 py-2 text-sm leading-relaxed text-white outline-none transition focus:border-accent/50" placeholder="场景英文环境描述，模块3 逐字复用。例：a narrow snow-covered mountain path with a cliff edge on the right"></textarea>
          </template>

          <div class="mt-1.5 text-[11px] leading-relaxed text-text-muted">出片提示词为全英文，这些字段为空时系统会静默改用中文名 → 中文会混进英文提示词。留空不会清空已有值（同名资产自动继承）。</div>
        </div>
      </div>

      <!-- 底部按钮 -->
      <div class="flex gap-3 border-t border-border p-4">
        <button class="flex-1 rounded-lg border border-border py-2.5 text-sm text-text-secondary transition hover:border-accent/50 hover:text-white" @click="close">取消</button>
        <button class="flex-1 rounded-lg bg-accent py-2.5 text-sm font-medium text-black transition hover:bg-accent/90" @click="save">保存修改</button>
        <button class="flex-1 rounded-lg border border-border bg-bg-secondary py-2.5 text-sm text-text-muted transition hover:border-border-light" @click="toastInfo('衍生形象功能开发中，敬请期待')">
          衍生形象
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, nextTick, computed } from 'vue'
import { useProjectStore } from '../stores/project'
import { api } from '../services/api'
import { confirmDialog, toastError, toastInfo } from '../services/dialog'

const props = defineProps({
  visible: Boolean,
  asset: Object,
  type: String, // 'character' | 'scene' | 'prop'
})

const emit = defineEmits(['close', 'save'])

const store = useProjectStore()
const editName = ref('')
const editRole = ref('配角')
const editDescription = ref('')
// 场景光影常量（scenes.lighting_en）：仅场景类型展示/提交
const editLightingEn = ref('')
// 英文常量（2026-09-16）：H3 提示词全英文，这些是必填生产资产。
// 与 editLightingEn 同源问题——不在 watch 里初始化就会「以空串提交」抹掉 DB 值。
const editNameEn = ref('')          // characters.name_en / props.name_en
const editDescriptionEn = ref('')   // characters.description_en / props.description_en
const editTitleEn = ref('')         // scenes.title_en
const editSummaryEn = ref('')       // scenes.summary_en
const editLocation = ref('')        // scenes.location（场景地点，入出片参考）
const editingName = ref(false)
const nameInput = ref(null)

// 形象版本历史
const history = ref([])
const restoringId = ref(null)
const editInstruction = ref('')
const generating = computed(() => store.generatingAssetIds.includes(props.asset?.id))

const sourceLabel = { generate: '生成', edit: '改造', upload: '上传', initial: '初始' }
function versionLabel(h) {
  return `${sourceLabel[h.source] || h.source}${h.is_current ? ' · 当前' : ''}${h.instruction && h.source === 'edit' ? ' · ' + h.instruction : ''}`
}

async function loadHistory() {
  if (!props.asset?.id) { history.value = []; return }
  try {
    const r = await api.getAssetImageHistory({ type: props.type, id: props.asset.id })
    history.value = r.history || []
  } catch { history.value = [] }
}

watch(() => [props.visible, props.asset?.id], ([v]) => {
  if (v) loadHistory()
}, { immediate: true })

async function restoreVersion(h) {
  if (h.is_current || restoringId.value) return
  const ok = await confirmDialog({
    title: `恢复到「${versionLabel(h)}」`,
    description: '图和描述会一起回滚（当前版本仍保留在历史中，随时可切回）。',
    details: h.createdAt ? [{ label: '该版本', value: String(h.createdAt) }] : [],
    confirmText: '恢复到此版本',
    cancelText: '保留当前',
    tone: 'danger',
  })
  if (!ok) return
  restoringId.value = h.id
  try {
    const r = await api.restoreAssetImage({ type: props.type, id: props.asset.id, historyId: h.id })
    if (r.success) {
      if (props.asset) {
        props.asset.imageUrl = r.url
        if (r.description) {
          props.asset.description = r.description
          editDescription.value = r.description
        }
      }
      await loadHistory()
    }
  } catch (e) {
    toastError('恢复失败', { detail: String(e.message) })
  } finally {
    restoringId.value = null
  }
}

async function submitEdit() {
  const instruction = editInstruction.value.trim()
  if (!instruction || generating.value || !props.asset?.id) return
  const res = await store.generateAssetImage(
    props.type,
    props.asset.id,
    (props.asset.name || '') + '：' + (props.asset.description || ''),
    store.imageModel,
    instruction
  )
  if (res?.success) {
    if (res.description) {
      props.asset.description = res.description
      editDescription.value = res.description
    }
    if (props.asset) props.asset.imageUrl = res.url || props.asset.imageUrl
    editInstruction.value = ''
    await loadHistory()
  }
}

const typeLabel = {
  character: '角色',
  scene: '场景',
  prop: '道具',
}

watch(() => props.asset, (val) => {
  if (val) {
    editName.value = val.name || ''
    editRole.value = val.role || '配角'
    editDescription.value = val.description || ''
    // 场景光影常量必须随资产初始化：不初始化时永远以空串提交，
    // 保存接口的「显式带了值就用请求值」规则会把 DB 里维护好的 lighting_en 抹成空串
    editLightingEn.value = val.lightingEn || ''
    // 英文常量同理会「以空串提交 → 抹掉 DB 值」（2026-09-16 补齐）：
    // name_en / description_en / title_en / summary_en 是 H3 全英文提示词的必填生产资产，
    // 必须随资产一起初始化，否则一进详情弹窗点保存就把手工维护的英文常量清空。
    editNameEn.value = val.nameEn || val.name_en || ''
    editDescriptionEn.value = val.descriptionEn || val.description_en || ''
    editTitleEn.value = val.titleEn || val.title_en || ''
    editSummaryEn.value = val.summaryEn || val.summary_en || ''
    editLocation.value = val.location || ''
  }
}, { immediate: true })

// 进入名称编辑模式时自动聚焦
watch(editingName, (val) => {
  if (val) {
    nextTick(() => { nameInput.value?.focus() })
  }
})

function close() {
  emit('close')
}

function save() {
  const payload = {
    name: editName.value,
    role: editRole.value,
    description: editDescription.value,
  }
  // 场景光影常量：仅场景类型提交（角色/道具没有这个字段）
  if (props.type === 'scene') payload.lightingEn = editLightingEn.value.trim()
  // 英文常量（2026-09-16）：按类型提交，避免把 undefined 传给后端触发误伤。
  // 注意：这里提交的是**显式值**（含空串），后端 scenes/props 分支按「显式带值优先」处理，
  // 所以用户在弹窗里主动清空是生效的；没打开过弹窗的资产走的是「不带键 → 后端继承旧值」。
  if (props.type === 'character') {
    payload.nameEn = editNameEn.value.trim()
    payload.descriptionEn = editDescriptionEn.value.trim()
  }
  // 道具英文描述（props.description_en）：模块2「道具描述」逐字复用
  if (props.type === 'prop') {
    payload.nameEn = editNameEn.value.trim()
    payload.descriptionEn = editDescriptionEn.value.trim()
  }
  // 场景地点（scenes.location）：场景基础属性，入出片参考
  if (props.type === 'scene') {
    payload.location = editLocation.value.trim()
    payload.titleEn = editTitleEn.value.trim()
    payload.summaryEn = editSummaryEn.value.trim()
  }
  emit('save', payload)
}
</script>

<style scoped>
@keyframes slideIn {
  from { transform: translateX(100%); }
  to { transform: translateX(0); }
}
.animate-slide-in {
  animation: slideIn 0.25s ease-out;
}
</style>
