<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../services/api'
import { useProjectStore } from '../stores/project'
import { toastError } from '../services/dialog'
import CreateStyleDialog from '../components/CreateStyleDialog.vue'

const router = useRouter()
const store = useProjectStore()

const activeCategory = ref('')
const selectedKey = ref(store.currentStyle?.key || '')
const searchQuery = ref('')
const failed = ref({})
const styles = ref([])
const categories = ref([])
const loading = ref(true)
const loadError = ref('')
const showConfirmDialog = ref(false)
const extracting = ref(false)
const showCreateDialog = ref(false)
const editingStyle = ref(null) 
const showDeleteDialog = ref(false)
const deletingStyle = ref(null) 
const deleting = ref(false)

onMounted(async () => {
  try {
    const data = await api.getStyles()
    categories.value = data.categories.map((c) => ({
      key: c.key,
      label: c.label,
      count: c.presets.length,
      presets: c.presets,
    }))
    styles.value = data.categories.flatMap((c) => c.presets.map((p) => ({ ...p, category: c.key })))
    if (categories.value.length) {
      activeCategory.value = categories.value[0].key
    }
  } catch (e) {
    loadError.value = e.message || '风格数据加载失败'
  } finally {
    loading.value = false
  }
})

function markFailed(key) {
  failed.value[key] = true
}

const filteredStyles = computed(() => {
  let list = styles.value.filter((s) => s.category === activeCategory.value)
  if (searchQuery.value.trim()) {
    const q = searchQuery.value.toLowerCase()
    list = list.filter(
      (s) =>
        s.label.toLowerCase().includes(q) ||
        (s.labelEn || '').toLowerCase().includes(q) ||
        s.prompt.toLowerCase().includes(q)
    )
  }
  return list
})

const selectedStyle = computed(() => styles.value.find((s) => s.key === selectedKey.value))

const assetEstimate = computed(() => {
  const text = store.scriptContent || ''
  const roleSet = new Set()
  let sceneCount = 0
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (/^场次[一二三四五六七八九十\d]+[：:]/.test(t)) sceneCount++
    const m = t.match(/^人物[：:]\s*(.+)$/)
    if (m) {
      m[1].split(/[、,，\s]+/).filter(Boolean).forEach((r) => roleSet.add(r))
    }
  }
  return { roles: roleSet.size, scenes: Math.max(sceneCount, store.scenes.length) }
})

const extractedCounts = computed(() => ({
  characters: store.characters.length,
  scenes: store.assetScenes.length,
  props: store.props.length,
}))
const hasExtractedAssets = computed(
  () => extractedCounts.value.characters + extractedCounts.value.scenes + extractedCounts.value.props > 0
)

const extractState = computed(() => {
  if (!hasExtractedAssets.value) return 'none'
  const fp = store.lastExtractInfo
  if (!fp) return 'done'
  const scriptChanged = fp.script !== (store.scriptContent || '')
  const styleChanged = Boolean(
    store.currentStyle?.label && fp.styleLabel && fp.styleLabel !== store.currentStyle.label
  )
  if (scriptChanged && styleChanged) return 'both-changed'
  if (scriptChanged) return 'script-changed'
  if (styleChanged) return 'style-changed'
  return 'fresh'
})

const extractStateHint = computed(() => {
  const state = extractState.value
  if (state === 'both-changed') return '剧本和画风都改过了，建议重新提取资产，让资产跟上最新的内容与画风'
  if (state === 'style-changed')
    return `画风已换为「${store.currentStyle?.label || ''}」，当前资产与已生成的图还是旧画风「${store.lastExtractInfo?.styleLabel || ''}」的，建议重新提取`
  if (state === 'script-changed') return '剧本已更新（新增或修改了场次），建议重新提取资产以覆盖新内容'
  return '剧本与画风均未改动，无需重复提取，可直接前往设定页查看'
})

const needsExtract = computed(() =>
  ['script-changed', 'style-changed', 'both-changed'].includes(extractState.value)
)

function selectStyle(style) {
  selectedKey.value = style.key
  store.setStyle(style)
}

async function confirmExtract() {
  showConfirmDialog.value = false
  extracting.value = true
  try {
    const r = await store.extractAssets()
    if (r?.success) {
      router.push('/settings')
    }
  } finally {
    extracting.value = false
  }
}

async function handleStyleCreated(style) {
  try {
    const data = await api.getStyles()
    categories.value = data.categories.map((c) => ({
      key: c.key,
      label: c.label,
      count: c.presets.length,
      presets: c.presets,
    }))
    styles.value = data.categories.flatMap((c) => c.presets.map((p) => ({ ...p, category: c.key })))
    const custom = categories.value.find((c) => c.key === 'custom')
    if (custom) activeCategory.value = custom.key
    if (style?.key) {
      selectedKey.value = style.key
      store.setStyle({ ...style, category: style.category || 'custom' })
    }
  } catch (e) {
    console.error('刷新画风列表失败:', e)
  }
}

async function handleStyleUpdated(style) {
  try {
    const data = await api.getStyles()
    categories.value = data.categories.map((c) => ({
      key: c.key,
      label: c.label,
      count: c.presets.length,
      presets: c.presets,
    }))
    styles.value = data.categories.flatMap((c) => c.presets.map((p) => ({ ...p, category: c.key })))
    if (style?.key && style.key === selectedKey.value) {
      store.setStyle({ ...style, category: style.category || 'custom' })
    }
  } catch (e) {
    console.error('刷新画风列表失败:', e)
  }
}

function openCreate() {
  editingStyle.value = null
  showCreateDialog.value = true
}

function openEdit(style) {
  editingStyle.value = style
  showCreateDialog.value = true
}

function askDelete(style) {
  deletingStyle.value = style
  showDeleteDialog.value = true
}

async function confirmDelete() {
  const style = deletingStyle.value
  if (!style) return
  deleting.value = true
  try {
    await api.deleteStyle(style.key)
    const data = await api.getStyles()
    categories.value = data.categories.map((c) => ({
      key: c.key,
      label: c.label,
      count: c.presets.length,
      presets: c.presets,
    }))
    styles.value = data.categories.flatMap((c) => c.presets.map((p) => ({ ...p, category: c.key })))
    if (selectedKey.value === style.key) {
      const custom = categories.value.find((c) => c.key === 'custom')
      if (custom && custom.presets.length) {
        selectedKey.value = custom.presets[0].key
      } else {
        const firstCat = categories.value.find((c) => c.presets.length)
        selectedKey.value = firstCat ? firstCat.presets[0].key : ''
      }
      const sel = styles.value.find((s) => s.key === selectedKey.value)
      if (sel) store.setStyle(sel)
    }
    showDeleteDialog.value = false
    deletingStyle.value = null
  } catch (e) {
    console.error('删除画风失败:', e)
    toastError('删除失败', { detail: String(e.message || '未知错误') })
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <div class="flex h-full w-full flex-col">
    <div class="flex shrink-0 items-center justify-between border-b border-border px-6 py-3">
      <div class="flex items-center gap-4">
        <button
          class="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-text-secondary transition hover:text-white"
          @click="router.push('/script')"
        >
          <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" /></svg>
          返回剧本
        </button>
        <h1 class="text-sm font-medium">选择画风</h1>
        <p class="text-xs text-text-muted">全局美术风格，将应用到后续所有图片与视频生成</p>
        <button
          class="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs text-text-secondary transition hover:border-accent/50 hover:text-white"
          title="新建画风"
          @click="openCreate"
        >
          <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" /></svg>
          新增风格
        </button>
      </div>
    </div>

    <div class="flex min-h-0 flex-1 overflow-hidden">
      <div class="flex w-48 shrink-0 flex-col border-r border-border bg-bg-secondary/50">
        <div class="p-3">
          <input
            v-model="searchQuery"
            type="text"
            placeholder="搜索风格..."
            class="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-xs text-white placeholder-text-muted outline-none focus:border-accent/50"
          />
        </div>
        <div class="flex-1 overflow-y-auto px-2 pb-3">
          <button
            v-for="cat in categories"
            :key="cat.key"
            class="mb-1 flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition"
            :class="activeCategory === cat.key ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:bg-bg-hover hover:text-white'"
            @click="activeCategory = cat.key"
          >
            <span>{{ cat.label }}</span>
            <span class="flex items-center gap-1.5">
              <span
                v-if="cat.key === 'custom'"
                role="button"
                title="新建画风"
                class="flex h-5 w-5 items-center justify-center rounded text-text-muted transition hover:bg-accent/20 hover:text-accent"
                @click.stop="openCreate"
              >
                <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" /></svg>
              </span>
              <span class="text-xs opacity-60">{{ cat.count }}</span>
            </span>
          </button>
        </div>
      </div>

      <div class="min-w-0 flex-1 overflow-y-auto p-4">
        <div v-if="loading" class="flex h-40 items-center justify-center text-sm text-text-muted">加载风格中...</div>
        <div v-else-if="loadError" class="flex h-40 items-center justify-center text-sm text-red-400">{{ loadError }}</div>
        <template v-else>
          <div class="grid grid-cols-3 gap-3 sm:grid-cols-4">
            <div
              v-for="style in filteredStyles"
              :key="style.key"
              class="group relative cursor-pointer overflow-hidden rounded-xl border-2 transition"
              :class="selectedKey === style.key ? 'border-accent' : 'border-border hover:border-border-light'"
              @click="selectStyle(style)"
            >
              <div class="relative aspect-square overflow-hidden bg-bg-secondary">
                <img
                  v-if="style.coverUrl && !failed[style.key]"
                  :src="style.coverUrl"
                  :alt="style.label"
                  class="h-full w-full object-cover transition group-hover:scale-105"
                  loading="lazy"
                  @error="markFailed(style.key)"
                />
                <div v-else class="flex h-full w-full items-center justify-center text-4xl">{{ style.emoji }}</div>
                <div
                  v-if="selectedKey === style.key"
                  class="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-accent text-black"
                >
                  <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" /></svg>
                </div>

                <div
                  v-if="style.source === 'USER'"
                  class="absolute left-1.5 top-1.5 flex gap-1 opacity-0 transition group-hover:opacity-100"
                >
                  <button
                    class="flex h-6 w-6 items-center justify-center rounded-md bg-black/55 text-white backdrop-blur transition hover:bg-accent hover:text-black"
                    title="编辑"
                    @click.stop="openEdit(style)"
                  >
                    <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 4h2m-1-1v2m-4 13l1-4 9-9 3 3-9 9-4 1z" /></svg>
                  </button>
                  <button
                    class="flex h-6 w-6 items-center justify-center rounded-md bg-black/55 text-white backdrop-blur transition hover:bg-red-500"
                    title="删除"
                    @click.stop="askDelete(style)"
                  >
                    <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2m2 0v14a1 1 0 01-1 1H6a1 1 0 01-1-1V6h14z" /></svg>
                  </button>
                </div>
                <span
                  v-if="style.source === 'USER'"
                  class="absolute bottom-1.5 left-1.5 rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-white backdrop-blur"
                >我的</span>
              </div>
              <div class="px-2 py-1.5">
                <div class="truncate text-xs font-medium">{{ style.emoji }} {{ style.label }}</div>
              </div>
            </div>

            <div
              v-if="activeCategory === 'custom'"
              class="group cursor-pointer overflow-hidden rounded-xl border-2 border-dashed border-border bg-bg-secondary/30 transition hover:border-accent/50 hover:bg-bg-secondary"
              @click="openCreate"
            >
              <div class="relative aspect-square overflow-hidden">
                <div class="flex h-full w-full flex-col items-center justify-center gap-2 text-text-muted">
                  <svg class="h-8 w-8 transition group-hover:text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" /></svg>
                  <span class="text-xs">新增风格</span>
                </div>
              </div>
              <div class="px-2 py-1.5">
                <div class="truncate text-center text-xs font-medium text-text-muted group-hover:text-white">
                  {{ filteredStyles.length === 0 ? '还没有自定义风格' : '创建你的风格' }}
                </div>
              </div>
            </div>
          </div>
          <div v-if="filteredStyles.length === 0" class="flex h-40 items-center justify-center text-sm text-text-muted">
            {{ activeCategory === 'custom' ? '点击上方「新增风格」卡片，创建你的第一个自定义风格' : '没有找到匹配的风格' }}
          </div>
        </template>
      </div>

      <div class="flex w-64 shrink-0 flex-col border-l border-border bg-bg-secondary/50 p-4">
        <div v-if="selectedStyle" class="flex flex-1 flex-col">
          <div class="aspect-square overflow-hidden rounded-xl border border-border bg-bg-primary">
            <img
              v-if="selectedStyle.coverUrl && !failed[selectedStyle.key]"
              :src="selectedStyle.coverUrl"
              :alt="selectedStyle.label"
              class="h-full w-full object-cover"
              @error="markFailed(selectedStyle.key)"
            />
            <div v-else class="flex h-full w-full items-center justify-center text-6xl">{{ selectedStyle.emoji }}</div>
          </div>
          <div class="mt-3">
            <div class="text-sm font-semibold">{{ selectedStyle.emoji }} {{ selectedStyle.label }}</div>
            <div class="mt-0.5 text-xs text-text-muted">{{ selectedStyle.labelEn }}</div>
          </div>
          <div class="mt-3 flex-1 overflow-y-auto">
            <div class="text-[10px] font-medium uppercase tracking-wider text-text-muted">风格提示词</div>
            <p class="mt-1 text-xs leading-relaxed text-text-secondary">{{ selectedStyle.prompt }}</p>
          </div>

          <div
            v-if="hasExtractedAssets"
            class="mb-3 rounded-lg border px-3 py-2 text-xs"
            :class="
              extractState === 'fresh' || extractState === 'done'
                ? 'border-accent/40 bg-accent/5'
                : 'border-amber-500/40 bg-amber-500/10'
            "
          >
            <div
              class="flex items-center gap-1.5 font-medium"
              :class="extractState === 'fresh' || extractState === 'done' ? 'text-accent' : 'text-amber-400'"
            >
              <svg v-if="extractState === 'fresh' || extractState === 'done'" class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7" /></svg>
              <svg v-else class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /></svg>
              {{ extractState === 'fresh' || extractState === 'done' ? '资产已提取' : '资产需要更新' }}
            </div>
            <div class="mt-1 text-text-secondary">
              {{ extractedCounts.characters }} 角色 · {{ extractedCounts.scenes }} 场景 · {{ extractedCounts.props }} 道具
            </div>
            <div class="mt-1 text-[10px] leading-relaxed" :class="extractState === 'fresh' || extractState === 'done' ? 'text-text-muted' : 'text-amber-400/80'">
              {{ extractStateHint }}
            </div>
          </div>

          <div class="mb-3 flex items-center gap-2 rounded-lg border border-border bg-bg-primary px-3 py-2 text-xs">
            <span class="text-text-muted">预计提取：</span>
            <span class="font-medium text-white">{{ assetEstimate.roles }} 角色</span>
            <span class="text-text-muted">·</span>
            <span class="font-medium text-white">{{ assetEstimate.scenes }} 场景</span>
          </div>

          <template v-if="needsExtract">
            <button
              class="mt-4 w-full rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-medium text-black transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="extracting || store.aiLoading"
              @click="showConfirmDialog = true"
            >
              {{ extracting || store.aiLoading ? '提取中...' : '重新提取资产' }}
            </button>
            <button
              class="mt-2 w-full text-center text-[11px] text-text-muted underline-offset-2 transition hover:text-white hover:underline"
              @click="router.push('/settings')"
            >
              跳过，直接前往设定页 →
            </button>
          </template>

          <template v-else-if="hasExtractedAssets">
            <button
              class="mt-4 w-full rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-black transition hover:bg-accent-hover"
              @click="router.push('/settings')"
            >
              下一步：查看设定资产 →
            </button>
            <button
              class="mt-2 w-full text-center text-[11px] text-text-muted underline-offset-2 transition hover:text-white hover:underline"
              :disabled="extracting || store.aiLoading"
              @click="showConfirmDialog = true"
            >
              {{ extracting || store.aiLoading ? '提取中...' : '画风有改动？重新提取并覆盖' }}
            </button>
          </template>

          <template v-else>
            <button
              class="mt-4 w-full rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-medium text-black transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="extracting || store.aiLoading"
              @click="showConfirmDialog = true"
            >
              {{ extracting || store.aiLoading ? '提取中...' : '提取角色与场景资产' }}
            </button>
            <p class="mt-2 text-center text-[10px] leading-relaxed text-text-muted">
              画风只做展示，点击提取才会消耗余额
            </p>
          </template>
        </div>
        <div v-else class="flex flex-1 items-center justify-center text-center text-sm text-text-muted">
          <div>
            <svg class="mx-auto mb-2 h-10 w-10 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
            先选一个画风
          </div>
        </div>
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="showConfirmDialog"
        class="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm"
        @click.self="showConfirmDialog = false"
      >
        <div class="w-[400px] overflow-hidden rounded-2xl border border-border bg-bg-card shadow-2xl">
          <div class="h-1 w-full bg-amber-500"></div>
          <div class="p-6">
            <h3 class="text-base font-medium text-white">确认提取资产？</h3>
            <p class="mt-2 text-sm leading-relaxed text-text-secondary">
              将根据剧本提取角色 / 场景 / 道具，并消耗余额。
            </p>
            <div
              v-if="hasExtractedAssets"
              class="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-400"
            >
              当前已有资产（{{ extractedCounts.characters }} 角色 · {{ extractedCounts.scenes }} 场景 · {{ extractedCounts.props }} 道具）。重新提取将覆盖现有资产；剧本未改动时无需重复提取。
            </div>
            <div class="mt-6 flex justify-end gap-3">
              <button
                class="rounded-lg border border-border px-4 py-2 text-sm text-text-secondary transition hover:border-border-light hover:text-white"
                @click="showConfirmDialog = false"
              >
                取消
              </button>
              <button
                class="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-black transition hover:bg-amber-400"
                @click="confirmExtract"
              >
                确认提取
              </button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <CreateStyleDialog
      v-model="showCreateDialog"
      :edit-style="editingStyle"
      @created="handleStyleCreated"
      @updated="handleStyleUpdated"
    />

    <Teleport to="body">
      <div
        v-if="showDeleteDialog"
        class="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
        @click.self="!deleting && (showDeleteDialog = false)"
      >
        <div class="w-[400px] max-w-[95vw] overflow-hidden rounded-2xl border border-border bg-bg-card shadow-2xl">
          <div class="border-b border-border px-5 py-3.5">
            <h2 class="text-base font-semibold text-white">删除画风</h2>
          </div>
          <div class="px-5 py-4 text-sm text-text-secondary">
            确定要删除「<span class="font-medium text-white">{{ deletingStyle?.label }}</span>」吗？此操作不可撤销。
          </div>
          <div class="flex justify-end gap-3 border-t border-border px-5 py-3.5">
            <button
              class="rounded-lg border border-border px-4 py-2 text-sm text-text-secondary transition hover:border-border-light hover:text-white"
              :disabled="deleting"
              @click="showDeleteDialog = false"
            >
              取消
            </button>
            <button
              class="rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="deleting"
              @click="confirmDelete"
            >
              {{ deleting ? '删除中...' : '删除' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
