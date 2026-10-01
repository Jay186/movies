<script setup>
import { ref, reactive, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import { useModelConfigStore } from '../stores/modelConfig'
import ModelPicker from './ModelPicker.vue'
import { confirmDialog, toastSuccess, toastError, toastWarn, dialogState } from '../services/dialog'
import {
  ACCOUNT_KEYS,
  ACCOUNT_META,
  ENTRY_KINDS,
  TEXT_MODEL_SUGGESTIONS,
  VIDEO_WORKFLOW_KEYS,
  videoWorkflowKeyLabel,
  MODEL_CONFIG_TEXT as T,
} from '../constants/modelConfig'

const props = defineProps({
  open: { type: Boolean, default: false },
})
const emit = defineEmits(['close'])

const modelConfig = useModelConfigStore()

const FIELD_INPUT =
  'w-full min-w-0 rounded-control border border-border-light bg-bg-secondary px-[11px] py-[7px] text-[13px] text-text-primary outline-none transition hover:border-border-strong focus:border-accent read-only:text-text-muted'
const BTN_GHOST_SM =
  'shrink-0 rounded-control border border-border-light px-2.5 py-1.5 text-[11px] text-text-secondary transition hover:border-border-strong hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45'
const ROW_ACTION = 'rounded-[8px] px-2.5 py-1 text-[11px] transition'

const VISION_INPUT_ID = 'ai-model-config-vision'

// ── 可用模型候选（启明星模型广场）──
// 接口优先；仅当接口失败且列表为空时，文本条目才回落到硬编码建议值作兜底，仍允许手填
function fallbackOptions(names, kind) {
  return names.map((name) => ({ name, kind }))
}
const textModelOptions = computed(() => {
  const remote = modelConfig.availableModels?.text
  if (Array.isArray(remote) && remote.length) return remote
  if (modelConfig.availableModelsError) return fallbackOptions(TEXT_MODEL_SUGGESTIONS, 'text')
  return Array.isArray(remote) ? remote : []
})
// 生图条目只认接口数据，不做硬编码兜底（无内建生图模型清单）
const imageModelOptions = computed(() => {
  const remote = modelConfig.availableModels?.image
  return Array.isArray(remote) ? remote : []
})

// ── 生图条目「下拉选中即添加」──
// 候选 = 模型广场生图列表，剔除已添加过的 model_id，避免重复入库
const imageAddDraft = ref('')
const imageAddOptions = computed(() => {
  const exist = new Set(imageEntries.value.map((e) => String(e.model_id || '').trim().toLowerCase()))
  return imageModelOptions.value.filter((o) => !exist.has(String(o?.name || '').trim().toLowerCase()))
})
// 广场不可用（失败或没有生图数据）时保留手动填写兜底入口
const imageAddFallbackVisible = computed(
  () => !!modelConfig.availableModelsError || (!modelConfig.availableModelsLoading && !imageModelOptions.value.length)
)

async function addImageFromPlaza(model) {
  const name = String(model?.name || '').trim()
  if (!name) return
  imageAddDraft.value = ''
  const dup = imageEntries.value.some((e) => String(e.model_id || '').trim().toLowerCase() === name.toLowerCase())
  if (dup) {
    toastWarn(T.imageAlreadyAdded(name))
    return
  }
  try {
    await modelConfig.addEntry('image', { name, model_id: name })
    toastSuccess(T.entryAdded(name))
  } catch (e) {
    toastError(T.entrySaveFailed, { detail: e.message })
  }
}

// ── 账号草稿（base_url / api_key 逐字段提交，未改动的 Key 原样回传掩码）─
const accountDraft = reactive({
  text: { base_url: '', api_key: '' },
  image: { base_url: '', api_key: '' },
  video: { base_url: '', api_key: '' },
})
const accountTouched = reactive({
  text: { base_url: false, api_key: false },
  image: { base_url: false, api_key: false },
  video: { base_url: false, api_key: false },
})
const keyShown = reactive({ text: false, image: false, video: false })
const savingAccount = reactive({ text: false, image: false, video: false })

const testing = reactive({ text: false, image: false, video: false })
const testState = reactive({
  text: { status: 'idle', latencyMs: null, message: '' },
  image: { status: 'idle', latencyMs: null, message: '' },
  video: { status: 'idle', latencyMs: null, message: '' },
})

function syncAccounts(force = false) {
  for (const key of ACCOUNT_KEYS) {
    const acc = modelConfig.accounts?.[key]
    if (!acc) continue
    if (force || !accountTouched[key].base_url) accountDraft[key].base_url = acc.base_url || ''
    if (force || !accountTouched[key].api_key) accountDraft[key].api_key = acc.api_key || ''
  }
}

watch(
  [() => modelConfig.accounts, () => modelConfig.loaded],
  () => {
    if (modelConfig.loaded) syncAccounts(false)
  },
  { immediate: true, deep: true }
)

function touch(key, field) {
  accountTouched[key][field] = true
}

async function commitBaseUrl(key) {
  if (!accountTouched[key].base_url || savingAccount[key]) return
  const value = accountDraft[key].base_url.trim()
  if (value === (modelConfig.accounts?.[key]?.base_url || '')) {
    accountTouched[key].base_url = false
    return
  }
  savingAccount[key] = true
  try {
    await modelConfig.saveAccount(key, { base_url: value })
    accountTouched[key].base_url = false
    toastSuccess(T.accountSaved)
  } catch (e) {
    toastError(T.accountSaveFailed, { detail: e.message })
  } finally {
    savingAccount[key] = false
  }
}

async function commitApiKey(key) {
  if (!accountTouched[key].api_key || savingAccount[key]) return
  const current = modelConfig.accounts?.[key]?.api_key || ''
  const value = accountDraft[key].api_key.trim()
  if (value === current) {
    accountTouched[key].api_key = false
    return
  }
  if (!value) {
    accountTouched[key].api_key = false
    accountDraft[key].api_key = current
    toastWarn(T.keyRequired)
    return
  }
  savingAccount[key] = true
  try {
    await modelConfig.saveAccount(key, { api_key: value })
    accountTouched[key].api_key = false
    // 保存后立即换成后端最新掩码，明文不留在内存与输入框里
    accountDraft[key].api_key = modelConfig.accounts?.[key]?.api_key || ''
    toastSuccess(T.keySaved)
  } catch (e) {
    toastError(T.keySaveFailed, { detail: e.message })
  } finally {
    savingAccount[key] = false
  }
}

// ── 文本模型 ──
const textDraft = ref('')
const textDirty = ref(false)
const visionDraft = ref(false)

watch(
  () => modelConfig.text,
  (text) => {
    if (!text) return
    if (!textDirty.value) textDraft.value = text.model_id || ''
    // 后端 text.vision 已是布尔，这里 !! 属防御性幂等兜底（类型漂移时不至于把字符串当真值）
    visionDraft.value = !!text.vision
  },
  { immediate: true, deep: true }
)

async function commitTextModel() {
  const value = textDraft.value.trim()
  if (value === (modelConfig.text?.model_id || '')) {
    textDirty.value = false
    return
  }
  try {
    await modelConfig.saveText({ model_id: value })
    textDirty.value = false
    toastSuccess(T.textModelSaved)
  } catch (e) {
    toastError(T.textModelSaveFailed, { detail: e.message })
  }
}

async function commitVision(next) {
  const prev = visionDraft.value
  visionDraft.value = next
  try {
    await modelConfig.saveText({ vision: next })
    toastSuccess(next ? T.visionOn : T.visionOff)
  } catch (e) {
    visionDraft.value = prev
    toastError(T.textModelSaveFailed, { detail: e.message })
  }
}

// ── 条目列表 ──
const imageEntries = computed(() => modelConfig.imageEntries || [])
const videoEntries = computed(() => modelConfig.videoEntries || [])

function entryList(kind) {
  return kind === 'video' ? videoEntries.value : imageEntries.value
}

function entryMeta(entry) {
  return entry.model_id || entry.workflow_id || ''
}

function entryEngineLabel(entry) {
  return entry.workflow_key ? videoWorkflowKeyLabel(entry.workflow_key) : ''
}

async function onSetDefault(entry) {
  if (entry.is_default) return
  try {
    await modelConfig.setDefault(entry.id)
    toastSuccess(T.defaultSet(entry.name))
  } catch (e) {
    toastError(T.defaultSetFailed, { detail: e.message })
  }
}

async function onToggleEnabled(entry) {
  const enable = entry.enabled === false
  try {
    await modelConfig.setEntryEnabled(entry.id, enable)
    if (enable) toastSuccess(T.entryEnabled(entry.name))
    else toastWarn(T.entryDisabled(entry.name))
  } catch (e) {
    toastError(T.entryToggleFailed, { detail: e.message })
  }
}

async function onRemove(entry) {
  const ok = await confirmDialog({
    title: T.deleteConfirmTitle(entry.name),
    description: T.deleteConfirmDesc,
    confirmText: T.rowRemove,
    tone: 'danger',
  })
  // 确认框关闭时会还原 body 滚动，抽屉仍开着则重新锁住
  if (props.open) document.body.style.overflow = 'hidden'
  if (!ok) return
  try {
    await modelConfig.removeEntry(entry.id)
    toastSuccess(T.entryRemoved(entry.name))
  } catch (e) {
    toastError(T.entryRemoveFailed, { detail: e.message })
  }
}

// ── 条目编辑弹窗 ──
const modal = reactive({
  open: false,
  kind: 'image',
  id: null,
  name: '',
  modelId: '',
  workflowId: '',
  workflowKey: VIDEO_WORKFLOW_KEYS[0].value,
  saving: false,
})

const modalKindMeta = computed(() => ENTRY_KINDS[modal.kind])
const modalTitle = computed(() =>
  modal.id != null
    ? `编辑${modalKindMeta.value.label} · ${modal.name || ''}`.trim()
    : `添加${modalKindMeta.value.label}`
)

function openCreate(kind) {
  modal.kind = kind
  modal.id = null
  modal.name = ''
  modal.modelId = ''
  modal.workflowId = ''
  modal.workflowKey = VIDEO_WORKFLOW_KEYS[0].value
  modal.saving = false
  modal.open = true
}

function openEdit(kind, entry) {
  modal.kind = kind
  modal.id = entry.id
  modal.name = entry.name || ''
  modal.modelId = entry.model_id || ''
  modal.workflowId = entry.workflow_id || ''
  modal.workflowKey = entry.workflow_key || VIDEO_WORKFLOW_KEYS[0].value
  modal.saving = false
  modal.open = true
}

function closeModal() {
  modal.open = false
}

// 下拉选中（或输入完成）模型后，名称为空则自动带出模型 ID，省一遍手打；
// 已有名称不覆盖，保留用户自定义命名
function autoFillEntryName() {
  const id = modal.modelId.trim()
  if (id && !modal.name.trim()) modal.name = id
}

async function saveItem() {
  if (modal.saving) return
  const name = modal.name.trim()
  if (!name) {
    toastWarn(T.nameRequired)
    return
  }
  let payload
  if (modal.kind === 'video') {
    const workflowId = modal.workflowId.trim()
    if (!workflowId) {
      toastWarn(T.workflowIdRequired)
      return
    }
    if (!modal.workflowKey) {
      toastWarn(T.engineRequired)
      return
    }
    payload = { name, workflow_id: workflowId, workflow_key: modal.workflowKey }
  } else {
    const modelId = modal.modelId.trim()
    if (!modelId) {
      toastWarn(T.modelIdRequired)
      return
    }
    payload = { name, model_id: modelId }
  }

  modal.saving = true
  try {
    if (modal.id != null) {
      await modelConfig.updateEntry(modal.id, payload)
      toastSuccess(T.entryUpdated(name))
    } else {
      await modelConfig.addEntry(modal.kind, payload)
      toastSuccess(T.entryAdded(name))
    }
    modal.open = false
  } catch (e) {
    toastError(T.entrySaveFailed, { detail: e.message })
  } finally {
    modal.saving = false
  }
}

// ── 连通测试 ──
function statusDotClass(key) {
  const s = testState[key].status
  if (s === 'ok') return 'bg-ok'
  if (s === 'err') return 'bg-danger'
  return 'bg-text-muted'
}

function statusText(key) {
  const s = testState[key].status
  if (s === 'ok') return key === 'video' ? T.statusOkRunningHub : T.statusOk
  if (s === 'err') return T.statusErr
  if (s === 'testing') return T.statusTesting
  return T.statusIdle
}

async function runTest(key) {
  if (testing[key]) return
  testing[key] = true
  testState[key].status = 'testing'
  testState[key].message = ''
  const label = ACCOUNT_META[key].name
  try {
    const r = await modelConfig.testConnection(key)
    const ok = r?.ok !== false
    const latencyMs = Number.isFinite(Number(r?.latencyMs)) ? Number(r.latencyMs) : null
    testState[key].status = ok ? 'ok' : 'err'
    testState[key].latencyMs = latencyMs
    testState[key].message = r?.message || ''
    if (ok) {
      toastSuccess(T.testOk(label, latencyMs, key === 'video'), { detail: testState[key].message })
    } else {
      toastError(T.testFail(label), { detail: testState[key].message })
    }
  } catch (e) {
    testState[key].status = 'err'
    testState[key].latencyMs = null
    testState[key].message = e.message
    toastError(T.testFail(label), { detail: e.message })
  } finally {
    testing[key] = false
  }
}

// ── 抽屉开关 ──
const closeBtn = ref(null)

const viewState = computed(() => {
  if (modelConfig.loaded) return 'ready'
  if (modelConfig.error) return 'error'
  return 'loading'
})

function requestClose() {
  emit('close')
}

function onKeydown(e) {
  if (e.key !== 'Escape') return
  // 全局确认框打开时，Esc 交给它处理（用捕获阶段抢在它之前判断）
  if (dialogState.confirmQueue.value.length) return
  if (modal.open) {
    closeModal()
    return
  }
  requestClose()
}

watch(
  () => props.open,
  (opened) => {
    if (opened) {
      document.body.style.overflow = 'hidden'
      window.addEventListener('keydown', onKeydown, true)
      syncAccounts(true)
      closeModal()
      modelConfig.load().catch(() => {})
      // 非阻塞拉取可用模型：失败只体现在选择器内部，不影响抽屉其它数据
      modelConfig.loadAvailableModels()
      nextTick(() => {
        try { closeBtn.value?.focus() } catch {  }
      })
    } else {
      window.removeEventListener('keydown', onKeydown, true)
      document.body.style.overflow = ''
      closeModal()
    }
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
  document.body.style.overflow = ''
})
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition-opacity duration-200"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition-opacity duration-150"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div v-if="open" class="fixed inset-0 z-[70] bg-black/60" @click="requestClose" />
    </Transition>

    <Transition
      enter-active-class="transition-transform duration-200 ease-out"
      enter-from-class="translate-x-full"
      enter-to-class="translate-x-0"
      leave-active-class="transition-transform duration-200 ease-in"
      leave-from-class="translate-x-0"
      leave-to-class="translate-x-full"
    >
      <aside
        v-if="open"
        class="fixed right-0 top-0 z-[75] flex h-full w-full max-w-[560px] flex-col border-l border-border bg-bg-primary shadow-pop"
        role="dialog"
        aria-modal="true"
        :aria-label="T.drawerTitle"
      >
        <div class="flex shrink-0 items-start gap-3 border-b border-border px-5 py-4">
          <div class="min-w-0 flex-1">
            <h2 class="text-[15px] font-medium text-text-primary">{{ T.drawerTitle }}</h2>
            <p class="mt-0.5 text-[12px] text-text-secondary">{{ T.drawerSubtitle }}</p>
          </div>
          <button
            ref="closeBtn"
            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-btn text-text-secondary transition hover:bg-bg-hover hover:text-text-primary"
            :aria-label="T.closeAria"
            :title="T.closeAria"
            @click="requestClose"
          >
            <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <!-- 加载骨架 -->
          <div v-if="viewState === 'loading'" class="space-y-4" aria-busy="true">
            <p class="text-[12px] text-text-muted">{{ T.loading }}</p>
            <div
              v-for="n in 3"
              :key="n"
              class="overflow-hidden rounded-panel border border-border bg-bg-card"
            >
              <div class="flex items-center gap-3 border-b border-border bg-bg-secondary/50 px-[18px] py-[14px]">
                <span class="h-3 w-16 rounded-full bg-bg-hover" />
                <span class="h-3 w-24 rounded-full bg-bg-hover" />
              </div>
              <div class="space-y-3 px-[18px] py-[14px]">
                <span class="block h-8 w-full rounded-control bg-bg-hover/70" />
                <span class="block h-8 w-full rounded-control bg-bg-hover/70" />
                <span class="block h-8 w-2/3 rounded-control bg-bg-hover/70" />
              </div>
            </div>
          </div>

          <!-- 错误态 -->
          <div
            v-else-if="viewState === 'error'"
            class="rounded-panel border border-danger/40 bg-danger/5 px-[18px] py-4"
          >
            <p class="text-[13px] font-medium text-danger">{{ T.loadFailed }}</p>
            <p class="mt-1 break-words text-[12px] text-text-secondary">{{ modelConfig.error }}</p>
            <button
              class="mt-3 rounded-btn border border-border-light px-3.5 py-1.5 text-[12px] text-text-secondary transition hover:border-border-strong hover:text-text-primary"
              @click="modelConfig.load({ force: true }).catch(() => {})"
            >
              {{ T.retry }}
            </button>
          </div>

          <!-- 账号卡 -->
          <template v-else>
            <div
              v-for="key in ACCOUNT_KEYS"
              v-show="modelConfig.accounts?.[key]"
              :key="key"
              class="mb-5 rounded-panel border border-border bg-bg-card last:mb-0"
            >
              <div class="flex items-center gap-2.5 rounded-t-[19px] border-b border-border bg-bg-secondary/50 px-[18px] py-[14px]">
                <span class="text-[13px] font-medium text-text-primary">{{ ACCOUNT_META[key].name }}</span>
                <span class="text-[11px] text-text-muted">{{ ACCOUNT_META[key].role }}</span>
                <span
                  class="ml-auto flex shrink-0 items-center gap-1.5 text-[12px] text-text-secondary"
                  :title="testState[key].message"
                >
                  <span class="h-[7px] w-[7px] rounded-full" :class="statusDotClass(key)" />
                  {{ statusText(key) }}
                  <span v-if="testState[key].latencyMs != null" class="font-mono text-[11px] text-text-muted">
                    {{ testState[key].latencyMs }}ms
                  </span>
                </span>
              </div>

              <div class="px-[18px] py-[14px]">
                <div class="grid grid-cols-[76px_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5">
                  <label class="text-[12px] text-text-secondary">{{ T.baseUrlLabel }}</label>
                  <div class="flex min-w-0 items-center gap-2">
                    <input
                      v-model="accountDraft[key].base_url"
                      :readonly="ACCOUNT_META[key].baseUrlReadonly"
                      class="font-mono"
                      :class="FIELD_INPUT"
                      @input="touch(key, 'base_url')"
                      @change="commitBaseUrl(key)"
                    />
                    <span v-if="ACCOUNT_META[key].baseUrlReadonly" class="shrink-0 text-[11px] text-text-muted">
                      {{ T.baseUrlFixed }}
                    </span>
                  </div>

                  <label class="text-[12px] text-text-secondary">{{ T.apiKeyLabel }}</label>
                  <div class="flex min-w-0 items-center gap-2">
                    <input
                      v-model="accountDraft[key].api_key"
                      :type="keyShown[key] ? 'text' : 'password'"
                      autocomplete="off"
                      class="font-mono"
                      :class="FIELD_INPUT"
                      @input="touch(key, 'api_key')"
                      @change="commitApiKey(key)"
                    />
                    <button class="font-mono" :class="BTN_GHOST_SM" @click="keyShown[key] = !keyShown[key]">
                      {{ keyShown[key] ? T.keyHide : T.keyShow }}
                    </button>
                    <button :class="BTN_GHOST_SM" :disabled="testing[key]" @click="runTest(key)">
                      {{ testing[key] ? T.testing : T.testConnection }}
                    </button>
                  </div>
                </div>
              </div>

              <!-- 能力区块：由 ACCOUNT_META[key].caps 驱动 -->
              <template v-for="cap in ACCOUNT_META[key].caps" :key="cap">
              <!-- 文本模型 -->
              <div v-if="cap === 'text'" class="border-t border-border px-[18px] pb-[14px] pt-[12px]">
                <div class="mb-2.5 flex flex-wrap items-center gap-2">
                  <span class="text-[12px] font-medium text-info">{{ T.textCapTitle }}</span>
                  <span class="text-[11px] text-text-muted">{{ T.textCapNote }}</span>
                  <span class="ml-auto text-[11px] text-text-muted">{{ T.textCapRight }}</span>
                </div>
                <div class="flex min-w-0 items-start gap-2">
                  <ModelPicker
                    v-model="textDraft"
                    :options="textModelOptions"
                    :loading="modelConfig.availableModelsLoading"
                    :error="modelConfig.availableModelsError"
                    :placeholder="T.modelPickerPlaceholder"
                    @update:model-value="textDirty = true"
                    @change="commitTextModel"
                  />
                  <span class="shrink-0 pt-[7px] text-[11px] text-text-muted">{{ T.textModelHint }}</span>
                </div>
                <div class="mt-2.5 flex items-start gap-2">
                  <input
                    :id="VISION_INPUT_ID"
                    type="checkbox"
                    class="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-accent"
                    :checked="visionDraft"
                    @change="commitVision($event.target.checked)"
                  />
                  <label :for="VISION_INPUT_ID" class="cursor-pointer text-[12px] text-text-primary">
                    {{ T.visionLabel }}
                  </label>
                  <span class="text-[11px] text-text-muted">{{ T.visionHint }}</span>
                </div>
              </div>

              <!-- 生图模型 -->
              <div v-else-if="cap === 'image'" class="border-t border-border px-[18px] pb-[14px] pt-[12px]">
                <div class="mb-2.5 flex flex-wrap items-center gap-2">
                  <span class="text-[12px] font-medium text-info">{{ ENTRY_KINDS.image.capTitle }}</span>
                  <span class="text-[11px] text-text-muted">{{ ENTRY_KINDS.image.capNote }}</span>
                  <span class="ml-auto text-[11px] text-text-muted">{{ ENTRY_KINDS.image.capRight }}</span>
                </div>
                <p v-if="!imageEntries.length" class="px-1 py-1.5 text-[12px] text-text-muted">
                  {{ T.imageEmptyEntries }}
                </p>
                <div
                  v-for="entry in imageEntries"
                  :key="entry.id"
                  class="group flex cursor-pointer items-center gap-2 rounded-control border px-[11px] py-[9px] transition"
                  :class="entry.is_default
                    ? 'border-accent/25 bg-accent/[0.04] hover:border-accent/40'
                    : 'border-transparent hover:border-border-light hover:bg-bg-hover/35'"
                  @click="openEdit('image', entry)"
                >
                  <span
                    class="h-[7px] w-[7px] shrink-0 rounded-full"
                    :class="entry.enabled === false ? 'bg-text-muted' : 'bg-ok'"
                  />
                  <span
                    class="text-[12px] font-medium"
                    :class="entry.enabled === false ? 'text-text-muted' : 'text-text-primary'"
                  >{{ entry.name }}</span>
                  <span
                    v-if="entry.is_default"
                    class="rounded-full border border-accent/30 bg-accent/10 px-1.5 py-[1px] text-[10px] text-accent"
                  >{{ T.badgeDefault }}</span>
                  <span
                    v-if="entry.enabled === false"
                    class="rounded-full border border-border bg-bg-secondary px-1.5 py-[1px] text-[10px] text-text-muted"
                  >{{ T.badgeDisabled }}</span>
                  <span class="ml-auto shrink-0 font-mono text-[11px] text-text-muted">{{ entryMeta(entry) }}</span>
                  <span class="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                    <button
                      v-if="!entry.is_default"
                      :class="[ROW_ACTION, 'text-accent hover:bg-accent/10']"
                      @click.stop="onSetDefault(entry)"
                    >{{ T.rowSetDefault }}</button>
                    <button
                      :class="[ROW_ACTION, 'text-text-secondary hover:bg-bg-hover hover:text-text-primary']"
                      @click.stop="onToggleEnabled(entry)"
                    >{{ entry.enabled === false ? T.rowEnable : T.rowDisable }}</button>
                    <button
                      :class="[ROW_ACTION, 'text-text-secondary hover:bg-bg-hover hover:text-text-primary']"
                      @click.stop="openEdit('image', entry)"
                    >{{ T.rowEdit }}</button>
                    <button
                      :class="[ROW_ACTION, 'text-text-secondary hover:bg-bg-hover hover:text-danger']"
                      @click.stop="onRemove(entry)"
                    >{{ T.rowRemove }}</button>
                  </span>
                </div>
                <!-- 选中即添加：下拉候选来自模型广场，已添加的自动剔除；广场不可用时显示手动兜底 -->
                <ModelPicker
                  v-model="imageAddDraft"
                  class="mt-1.5"
                  :options="imageAddOptions"
                  :loading="modelConfig.availableModelsLoading"
                  :error="modelConfig.availableModelsError"
                  :placeholder="T.imageAddPlaceholder"
                  @pick="addImageFromPlaza"
                />
                <button
                  v-if="imageAddFallbackVisible"
                  class="mt-1.5 w-full rounded-control border border-dashed border-border-light px-[11px] py-2 text-left text-[12px] text-text-muted transition hover:border-border-strong hover:text-text-primary"
                  @click="openCreate('image')"
                >{{ T.imageAddFallback }}</button>
              </div>

              <!-- 视频工作流 -->
              <div v-else class="border-t border-border px-[18px] pb-[14px] pt-[12px]">
                  <div class="mb-2.5 flex flex-wrap items-center gap-2">
                    <span class="text-[12px] font-medium text-info">{{ ENTRY_KINDS.video.capTitle }}</span>
                    <span class="text-[11px] text-text-muted">{{ ENTRY_KINDS.video.capNote }}</span>
                    <span class="ml-auto text-[11px] text-text-muted">{{ ENTRY_KINDS.video.capRight }}</span>
                  </div>
                  <p v-if="!videoEntries.length" class="px-1 py-1.5 text-[12px] text-text-muted">
                    {{ T.emptyEntries }}
                  </p>
                  <div
                    v-for="entry in videoEntries"
                    :key="entry.id"
                    class="group flex cursor-pointer items-center gap-2 rounded-control border px-[11px] py-[9px] transition"
                    :class="entry.is_default
                      ? 'border-accent/25 bg-accent/[0.04] hover:border-accent/40'
                      : 'border-transparent hover:border-border-light hover:bg-bg-hover/35'"
                    @click="openEdit('video', entry)"
                  >
                    <span
                      class="h-[7px] w-[7px] shrink-0 rounded-full"
                      :class="entry.enabled === false ? 'bg-text-muted' : 'bg-ok'"
                    />
                    <span
                      class="text-[12px] font-medium"
                      :class="entry.enabled === false ? 'text-text-muted' : 'text-text-primary'"
                    >{{ entry.name }}</span>
                    <span
                      v-if="entry.is_default"
                      class="rounded-full border border-accent/30 bg-accent/10 px-1.5 py-[1px] text-[10px] text-accent"
                    >{{ T.badgeDefault }}</span>
                    <span class="ml-auto flex shrink-0 items-center gap-2">
                      <span v-if="entryEngineLabel(entry)" class="text-[10px] text-text-muted">
                        {{ entryEngineLabel(entry) }}
                      </span>
                      <span class="font-mono text-[11px] text-text-muted">{{ entryMeta(entry) }}</span>
                    </span>
                    <span class="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                      <button
                        v-if="!entry.is_default"
                        :class="[ROW_ACTION, 'text-accent hover:bg-accent/10']"
                        @click.stop="onSetDefault(entry)"
                      >{{ T.rowSetDefault }}</button>
                      <button
                        :class="[ROW_ACTION, 'text-text-secondary hover:bg-bg-hover hover:text-text-primary']"
                        @click.stop="openEdit('video', entry)"
                      >{{ T.rowEdit }}</button>
                      <button
                        :class="[ROW_ACTION, 'text-text-secondary hover:bg-bg-hover hover:text-danger']"
                        @click.stop="onRemove(entry)"
                      >{{ T.rowRemove }}</button>
                    </span>
                  </div>
                  <button
                    class="mt-1.5 w-full rounded-control border border-dashed border-border-light px-[11px] py-2 text-left text-[12px] text-text-muted transition hover:border-border-strong hover:text-text-primary"
                    @click="openCreate('video')"
                  >{{ ENTRY_KINDS.video.addLabel }}</button>
                  <p class="px-1 pt-2 text-[11px] leading-relaxed text-text-muted">{{ T.runningHubFootNote }}</p>
                </div>
              </template>
            </div>
          </template>
        </div>
      </aside>
    </Transition>

    <!-- 条目编辑弹窗 -->
    <Transition
      enter-active-class="transition-opacity duration-150"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition-opacity duration-100"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="modal.open"
        class="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-5"
        @click.self="closeModal"
      >
        <div class="w-full max-w-[460px] rounded-panel border border-border-light bg-bg-card p-5 shadow-pop" role="dialog" aria-modal="true">
          <h3 class="text-[14px] font-medium text-text-primary">{{ modalTitle }}</h3>
          <p class="mt-1 mb-4 text-[12px] text-text-secondary">{{ T.modalSubtitle }}</p>

          <div class="mb-4 grid grid-cols-[76px_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5">
            <label class="text-[12px] text-text-secondary">
              {{ T.fieldName }}<span class="text-danger"> *</span>
            </label>
            <input v-model="modal.name" :placeholder="T.fieldNamePlaceholder" :class="FIELD_INPUT" />

            <label class="text-[12px] text-text-secondary">
              {{ modalKindMeta.idLabel }}<span class="text-danger"> *</span>
            </label>
            <input
              v-if="modal.kind === 'video'"
              v-model="modal.workflowId"
              class="font-mono"
              :placeholder="modalKindMeta.idPlaceholder"
              :class="FIELD_INPUT"
            />
            <ModelPicker
              v-else
              v-model="modal.modelId"
              :options="imageModelOptions"
              :loading="modelConfig.availableModelsLoading"
              :error="modelConfig.availableModelsError"
              :placeholder="T.modelPickerPlaceholder"
              @change="autoFillEntryName"
            />

            <template v-if="modal.kind === 'video'">
              <label class="text-[12px] text-text-secondary">
                {{ T.fieldEngine }}<span class="text-danger"> *</span>
              </label>
              <select v-model="modal.workflowKey" :class="FIELD_INPUT">
                <option v-for="opt in VIDEO_WORKFLOW_KEYS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
              </select>
            </template>
          </div>

          <div class="flex justify-end gap-2">
            <button
              class="rounded-btn border border-border px-4 py-1.5 text-[12px] text-text-secondary transition hover:border-border-light hover:text-text-primary"
              @click="closeModal"
            >{{ T.modalCancel }}</button>
            <button
              class="rounded-btn bg-accent px-4 py-1.5 text-[12px] font-medium text-black transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-45"
              :disabled="modal.saving"
              @click="saveItem"
            >{{ modal.saving ? T.modalSaving : T.modalSave }}</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
