<template>
  <div v-if="visible" class="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm transition-opacity" @click.self="close">
    <div class="absolute right-0 top-0 flex h-full w-[720px] max-w-[95vw] flex-col bg-bg-card shadow-2xl animate-slide-in">
      <div class="flex items-center justify-between border-b border-border px-6 py-4">
        <div class="flex items-center gap-2">
          <span class="rounded bg-bg-hover px-2 py-0.5 text-xs text-text-secondary">{{ typeLabel[type] }}</span>
          <span class="text-sm font-medium text-white">{{ asset?.name || '未命名' }}</span>
        </div>
        <button class="flex h-8 w-8 items-center justify-center rounded-full text-text-secondary transition hover:bg-bg-hover hover:text-white" @click="close">
          <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
      </div>

      <div class="flex-1 overflow-y-auto p-6">
        <div class="mb-6">
          <label class="mb-2 block text-xs font-medium text-text-secondary">图片</label>
          <div class="aspect-video w-full overflow-hidden rounded-xl border border-border bg-black">
            <img v-if="asset?.imageUrl" :src="asset.imageUrl" :alt="asset.name" class="h-full w-full object-contain" />
            <div v-else class="flex h-full items-center justify-center">
              <svg class="h-16 w-16 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
            </div>
          </div>
        </div>

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

        <div v-if="asset?.imageUrl" class="mb-6 rounded-xl border border-border bg-bg-secondary p-3">
          <div class="mb-2 text-sm font-medium text-accent">改造此形象</div>
          <div class="flex gap-2">
            <input v-model="editInstruction" type="text" class="flex-1 rounded-lg border border-border bg-bg-card px-3 py-2 text-sm text-white outline-none transition focus:border-accent/50" placeholder="例：戴一条红色针织围巾，其余不变" @keyup.enter="submitEdit" />
            <button class="whitespace-nowrap rounded-lg bg-accent px-4 py-2 text-sm font-medium text-black transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60" :disabled="generating || !editInstruction.trim()" @click="submitEdit">{{ generating ? '改造中...' : '以此图改造' }}</button>
          </div>
          <div class="mt-1.5 text-[11px] text-text-muted">以当前形象为底图，形象不变只改指令部分；新版本自动入历史，描述自动同步</div>
        </div>

        <div class="mb-4">
          <div v-if="!editingName" class="flex items-center gap-2 group cursor-pointer" @click="editingName=true">
            <span class="text-2xl font-bold text-white">{{ editName || '未命名' }}</span>
            <svg class="h-4 w-4 text-text-muted opacity-0 transition group-hover:opacity-100" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
          </div>
          <input v-else v-model="editName" type="text" ref="nameInput" class="w-full rounded-lg border border-accent/50 bg-bg-secondary px-3 py-2 text-2xl font-bold text-white outline-none transition" placeholder="请输入名称" @blur="editingName=false" @keyup.enter="editingName=false" />
        </div>

        <div class="mb-4">
          <label class="mb-1.5 block text-xs font-medium text-text-secondary">描述（可直接用于 AI 生图）</label>
          <textarea v-model="editDescription" rows="8" class="w-full resize-none rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm leading-relaxed text-white outline-none transition focus:border-accent/50" placeholder="详细描述，用于 AI 生图"></textarea>
        </div>

        <div v-if="type === 'scene'" class="mb-4">
          <label class="mb-1.5 block text-xs font-medium text-text-secondary">场景光影常量（英文，出片跨镜锁定光照）</label>
          <textarea v-model="editLightingEn" rows="3" class="w-full resize-none rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm leading-relaxed text-white outline-none transition focus:border-accent/50" placeholder="光源方位 + 色温 + 时间氛围，全英文 25 词以内。例：low slanting sunlight from the left, cold clear daylight, faint glints on the snow。留空 = 不注入"></textarea>
          <div class="mt-1 text-[11px] leading-relaxed text-text-muted">同一场景所有镜头的出片 prompt 与分镜图环境冻结声明会逐字复用这一句，钉死色温/光照方向；改动它 = 全场景生效。必须全英文，含中文不会注入。</div>
        </div>

        <div class="mb-4 rounded-xl border border-border bg-bg-secondary p-3">
          <div class="mb-2 text-xs font-medium text-text-secondary">英文常量（H3 提示词必填，为空会退回中文名）</div>

          <template v-if="type === 'character'">
            <input v-model="editNameEn" type="text" class="mb-2 w-full rounded-lg border border-border bg-bg-card px-3 py-2 text-sm text-white outline-none transition focus:border-accent/50" placeholder="角色英文名，例：Bubu" />
            <textarea v-model="editDescriptionEn" rows="3" class="w-full resize-none rounded-lg border border-border bg-bg-card px-3 py-2 text-sm leading-relaxed text-white outline-none transition focus:border-accent/50" placeholder="角色英文外貌描述，模块2 逐字复用。例：a light-brown bear dumpling with small round brown ears, small black dot eyes"></textarea>
          </template>

          <template v-else-if="type === 'prop'">
            <input v-model="editNameEn" type="text" class="mb-2 w-full rounded-lg border border-border bg-bg-card px-3 py-2 text-sm text-white outline-none transition focus:border-accent/50" placeholder="道具英文名，例：giant snowball" />
            <textarea v-model="editDescriptionEn" rows="3" class="w-full resize-none rounded-lg border border-border bg-bg-card px-3 py-2 text-sm leading-relaxed text-white outline-none transition focus:border-accent/50" placeholder="道具英文描述，模块2 逐字复用。例：a giant rolled snowball, packed snow with faint trail lines"></textarea>
          </template>

          <template v-else-if="type === 'scene'">
            <input v-model="editLocation" type="text" class="mb-2 w-full rounded-lg border border-border bg-bg-card px-3 py-2 text-sm text-white outline-none transition focus:border-accent/50" placeholder="场景地点，例：冰河浅滩" />
            <input v-model="editTitleEn" type="text" class="mb-2 w-full rounded-lg border border-border bg-bg-card px-3 py-2 text-sm text-white outline-none transition focus:border-accent/50" placeholder="场景英文名，例：Snowy Mountain Path" />
            <textarea v-model="editSummaryEn" rows="3" class="w-full resize-none rounded-lg border border-border bg-bg-card px-3 py-2 text-sm leading-relaxed text-white outline-none transition focus:border-accent/50" placeholder="场景英文环境描述，模块3 逐字复用。例：a narrow snow-covered mountain path with a cliff edge on the right"></textarea>
          </template>

          <div class="mt-1.5 text-[11px] leading-relaxed text-text-muted">出片提示词为全英文，这些字段为空时系统会静默改用中文名 → 中文会混进英文提示词。留空不会清空已有值（同名资产自动继承）。</div>
        </div>
      </div>

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
  type: String, 
})

const emit = defineEmits(['close', 'save'])

const store = useProjectStore()
const editName = ref('')
const editRole = ref('配角')
const editDescription = ref('')
const editLightingEn = ref('')
const editNameEn = ref('')          
const editDescriptionEn = ref('')   
const editTitleEn = ref('')         
const editSummaryEn = ref('')       
const editLocation = ref('')        
const editingName = ref(false)
const nameInput = ref(null)

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
    editLightingEn.value = val.lightingEn || ''
    editNameEn.value = val.nameEn || val.name_en || ''
    editDescriptionEn.value = val.descriptionEn || val.description_en || ''
    editTitleEn.value = val.titleEn || val.title_en || ''
    editSummaryEn.value = val.summaryEn || val.summary_en || ''
    editLocation.value = val.location || ''
  }
}, { immediate: true })

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
  if (props.type === 'scene') payload.lightingEn = editLightingEn.value.trim()
  if (props.type === 'character') {
    payload.nameEn = editNameEn.value.trim()
    payload.descriptionEn = editDescriptionEn.value.trim()
  }
  if (props.type === 'prop') {
    payload.nameEn = editNameEn.value.trim()
    payload.descriptionEn = editDescriptionEn.value.trim()
  }
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
