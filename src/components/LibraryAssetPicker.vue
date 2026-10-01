<script setup>
import { ref, computed, watch } from 'vue'
import { api } from '../services/api'
import { toastError } from '../services/dialog'
import UploadAssetDialog from './UploadAssetDialog.vue'
import { assetLabel } from '../constants/assetTypes'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  type: { type: String, default: 'character' },
  projectId: { type: [String, Number], default: null },
  autoUseOnUpload: { type: Boolean, default: false },
})

const emit = defineEmits(['update:modelValue', 'select'])

const activeSource = ref('library')
const activeType = ref(props.type)
const keyword = ref('')
const page = ref(1)
const pageSize = ref(32)
const total = ref(0)
const records = ref([])
const loading = ref(false)
const selectedId = ref(null) 
const showUploadDialog = ref(false)

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))
const typeLabel = computed(() => assetLabel(activeType.value))

function displayName(item) {
  const n = String(item.name || '').trim()
  if (!n) return '未命名素材'
  if (/^mine_\d+/.test(n)) return `我的素材 #${item.id}`
  return n
}

const groupedRecords = computed(() => {
  if (activeSource.value !== 'mine') return records.value
  return [...records.value].sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'))
})

const editingNameId = ref(null)
const renameDraft = ref('')
function startRename(item) {
  editingNameId.value = item.id
  renameDraft.value = item.name || ''
}
function cancelRename() {
  editingNameId.value = null
  renameDraft.value = ''
}
async function saveRename(item) {
  const name = renameDraft.value.trim()
  if (!name || name === item.name) return cancelRename()
  try {
    await api.updateLibraryAsset(item.id, { name })
    cancelRename()
    await fetchData()
  } catch (e) {
    toastError('重命名失败', { detail: String(e.message || '未知错误') })
  }
}

watch(() => props.modelValue, (val) => {
  if (val) {
    activeType.value = props.type
    activeSource.value = 'library'
    page.value = 1
    keyword.value = ''
    selectedId.value = null
    fetchData()
  }
})

watch([activeType, activeSource, page], () => {
  if (props.modelValue) fetchData()
})

async function fetchData() {
  loading.value = true
  try {
    const res = await api.getLibraryAssets(activeType.value, page.value, pageSize.value, keyword.value, activeSource.value)
    records.value = res.data.records || []
    total.value = res.data.total || 0
  } catch (e) {
    console.error('获取资产库失败:', e)
    records.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

function search() {
  page.value = 1
  fetchData()
}

function toggleSelect(item) {
  const id = item.cluster_key || item.id
  selectedId.value = selectedId.value === id ? null : id
}

function isSelected(item) {
  return selectedId.value === (item.cluster_key || item.id)
}

function useAsset(item) {
  emit('select', { items: [item], type: activeType.value })
  close()
}

async function deleteAsset(item) {
  if (!confirm(`确定删除「${item.name}」吗？`)) return
  try {
    await api.deleteLibraryAsset(item.id)
    if (isSelected(item)) selectedId.value = null
    await fetchData()
  } catch (e) {
    console.error('删除失败:', e)
    toastError('删除失败', { detail: String(e.message || '未知错误') })
  }
}

function close() {
  emit('update:modelValue', false)
}

const showDetailDialog = ref(false)
const detailLoading = ref(false)
const detailItems = ref([])
const detailCluster = ref(null)

async function openDetail(item) {
  detailCluster.value = item
  detailItems.value = []
  showDetailDialog.value = true
  detailLoading.value = true
  try {
    const res = await api.getLibraryAssetItems(item.cluster_key)
    detailItems.value = res.data || []
  } catch (e) {
    console.error('获取素材详情失败:', e)
    detailItems.value = []
  } finally {
    detailLoading.value = false
  }
}

function closeDetail() {
  showDetailDialog.value = false
}

function useDetailItem(detailItem) {
  if (!detailCluster.value) return
  emit('select', {
    items: [{ ...detailCluster.value, cover_url: detailItem.media_url }],
    type: activeType.value,
  })
  closeDetail()
  close()
}

function goPage(p) {
  if (p < 1 || p > totalPages.value || p === page.value) return
  page.value = p
}

function openUpload() {
  showUploadDialog.value = true
}

function onUploaded(asset) {
  if (props.autoUseOnUpload && asset?.cover_url) {
    emit('select', { items: [asset], type: activeType.value })
    close()
    return
  }
  page.value = 1
  fetchData()
}
</script>

<template>
  <Teleport to="body">
    <div v-if="modelValue" class="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4" @click.self="close">
      <div class="flex max-h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-border bg-bg-primary shadow-2xl">
        <div class="flex shrink-0 items-center justify-between border-b border-border px-6 py-4">
          <h2 class="text-lg font-medium text-white">选择图片</h2>
          <button class="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition hover:bg-bg-hover hover:text-white" @click="close">
            <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div class="flex shrink-0 items-center justify-between border-b border-border px-6 py-3">
          <div class="flex items-center gap-4">
            <div class="flex rounded-lg border border-border bg-bg-secondary p-0.5 text-xs">
              <button class="rounded-md px-3 py-1.5 transition" :class="activeSource==='library'?'bg-accent text-black':'text-text-secondary hover:text-white'" @click="activeSource='library';page=1">系统素材</button>
              <button class="rounded-md px-3 py-1.5 transition" :class="activeSource==='mine'?'bg-accent text-black':'text-text-secondary hover:text-white'" @click="activeSource='mine';page=1">我的图库</button>
            </div>
            <div class="flex rounded-lg border border-border bg-bg-secondary p-0.5 text-xs">
              <button v-for="t in [{key:'character',label:'角色'},{key:'scene',label:'场景'},{key:'prop',label:'道具'}]" :key="t.key" class="rounded-md px-3 py-1.5 transition" :class="activeType===t.key?'bg-bg-hover text-white':'text-text-secondary hover:text-white'" @click="activeType=t.key;page=1">{{ t.label }}</button>
            </div>
          </div>
          <div class="relative">
            <svg class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
            <input v-model="keyword" class="w-56 rounded-lg border border-border bg-bg-secondary py-1.5 pl-9 pr-3 text-xs text-white placeholder:text-text-muted focus:border-accent focus:outline-none" placeholder="搜索素材名称" @keyup.enter="search" />
          </div>
        </div>

        <div class="flex-1 overflow-y-auto p-6">
          <div v-if="loading" class="flex h-40 items-center justify-center text-sm text-text-muted">加载中...</div>
          <div v-else class="grid grid-cols-4 gap-4">
            <div v-if="activeSource==='mine'" class="flex cursor-pointer flex-col items-center justify-center overflow-hidden rounded-xl border border-dashed border-border bg-bg-card transition hover:border-accent/50" @click="openUpload">
              <div class="flex flex-1 items-center justify-center py-10">
                <svg class="h-12 w-12 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 4v16m8-8H4" /></svg>
              </div>
              <div class="w-full border-t border-border py-2 text-center text-xs text-text-secondary">上传</div>
            </div>

            <template v-for="(item, idx) in groupedRecords" :key="item.cluster_key || item.id">
              <div v-if="activeSource==='mine' && idx > 0 && displayName(groupedRecords[idx-1]) !== displayName(item)" class="col-span-4 mt-2 border-b border-border pb-1 text-xs text-text-muted">{{ displayName(item) }}</div>
              <div class="group relative overflow-hidden rounded-xl border transition" :class="isSelected(item)?'border-accent bg-accent/5':'border-border bg-bg-card hover:border-border-light'" @click="toggleSelect(item)">
                <div class="relative aspect-[4/3] overflow-hidden bg-white">
                  <img v-if="item.cover_url" :src="item.cover_url" :alt="item.name" class="h-full w-full object-cover" loading="lazy" />
                  <div v-else class="flex h-full items-center justify-center">
                    <svg class="h-10 w-10 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                  </div>
                  <span v-if="item.item_count" class="absolute left-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white backdrop-blur">{{ item.item_count }}个素材</span>

                  <button v-if="activeSource==='library' && item.item_count > 1" class="absolute bottom-2 right-2 flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur transition hover:bg-accent hover:text-black" title="查看详情" @click.stop="openDetail(item)">
                    <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                  </button>

                  <div v-if="isSelected(item)" class="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-accent text-black">
                    <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" /></svg>
                  </div>

                  <div v-if="isSelected(item)" class="absolute bottom-0 left-0 right-0 flex gap-1 bg-black/70 p-1.5 backdrop-blur">
                    <button class="flex flex-1 items-center justify-center gap-1 rounded bg-accent/90 py-1 text-[10px] font-medium text-black transition hover:bg-accent" @click.stop="useAsset(item)">
                      <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" /></svg>
                      使用
                    </button>
                    <button v-if="activeSource==='mine'" class="flex flex-1 items-center justify-center gap-1 rounded bg-white/10 py-1 text-[10px] text-white transition hover:bg-white/25" @click.stop="startRename(item)">
                      <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                      重命名
                    </button>
                    <button v-if="activeSource==='mine'" class="flex flex-1 items-center justify-center gap-1 rounded bg-white/10 py-1 text-[10px] text-white transition hover:bg-red-500/80" @click.stop="deleteAsset(item)">
                      <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                      删除
                    </button>
                  </div>
                </div>
                <div v-if="editingNameId === item.id" class="flex items-center gap-1 border-t border-border px-2 py-1.5">
                  <input v-model="renameDraft" class="w-full min-w-0 rounded border border-accent bg-bg-secondary px-1.5 py-0.5 text-xs text-white outline-none" @keyup.enter="saveRename(item)" @blur="saveRename(item)" />
                </div>
                <div v-else class="border-t border-border px-3 py-2">
                  <div class="truncate text-xs text-white">{{ displayName(item) }}</div>
                  <div v-if="item.referencedBy > 0" class="mt-0.5 text-[10px] text-text-muted">被 {{ item.referencedBy }} 处引用</div>
                </div>
              </div>
            </template>
          </div>

          <div v-if="!loading && records.length===0 && activeSource!=='mine'" class="flex h-40 items-center justify-center text-sm text-text-muted">暂无{{ typeLabel }}素材</div>
        </div>

        <div class="flex shrink-0 items-center justify-center border-t border-border px-6 py-3">
          <div class="flex items-center gap-1">
            <button class="flex h-8 w-8 items-center justify-center rounded-md border border-border text-text-muted transition hover:border-border-light hover:text-white disabled:opacity-30" :disabled="page<=1" @click="goPage(page-1)">
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" /></svg>
            </button>
            <button v-for="p in Math.min(7, totalPages)" :key="p" class="h-8 w-8 rounded-md border text-xs transition" :class="page===p?'border-accent bg-accent text-black':'border-border text-text-secondary hover:border-border-light hover:text-white'" @click="goPage(p)">{{ p }}</button>
            <button class="flex h-8 w-8 items-center justify-center rounded-md border border-border text-text-muted transition hover:border-border-light hover:text-white disabled:opacity-30" :disabled="page>=totalPages" @click="goPage(page+1)">
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" /></svg>
            </button>
          </div>
        </div>
      </div>
    </div>

    <UploadAssetDialog v-model="showUploadDialog" :type="activeType" @uploaded="onUploaded" />

    <div v-if="showDetailDialog" class="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4" @click.self="closeDetail">
      <div class="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-bg-primary shadow-2xl">
        <div class="flex shrink-0 items-center justify-between border-b border-border px-6 py-4">
          <h2 class="text-lg font-medium text-white">{{ displayName(detailCluster) }} <span class="ml-2 text-xs font-normal text-text-muted">{{ detailItems.length }} 个视角</span></h2>
          <button class="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition hover:bg-bg-hover hover:text-white" @click="closeDetail">
            <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <div class="flex-1 overflow-y-auto p-6">
          <div v-if="detailLoading" class="flex h-40 items-center justify-center text-sm text-text-muted">加载中...</div>
          <div v-else-if="detailItems.length === 0" class="flex h-40 items-center justify-center text-sm text-text-muted">暂无详情图</div>
          <div v-else class="grid grid-cols-3 gap-4">
            <div v-for="(d, i) in detailItems" :key="d.id" class="group cursor-pointer overflow-hidden rounded-xl border border-border bg-bg-card transition hover:border-accent" @click="useDetailItem(d)">
              <div class="relative aspect-[4/3] overflow-hidden bg-white">
                <img :src="d.media_url" :alt="d.name" class="h-full w-full object-cover" loading="lazy" />
                <div class="absolute bottom-0 left-0 right-0 bg-black/70 px-2 py-1.5 text-center text-[10px] text-white opacity-0 backdrop-blur transition group-hover:opacity-100">使用此视角</div>
              </div>
              <div class="border-t border-border px-3 py-2 text-center text-xs text-white">视角 {{ i + 1 }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
