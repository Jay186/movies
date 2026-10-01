import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api } from '../services/api'
import { MODEL_CONFIG_TEXT } from '../constants/modelConfig'

function readError(e) {
  return String(e?.message || MODEL_CONFIG_TEXT.unknownError)
}

const sameId = (a, b) => String(a) === String(b)

// 后端 GET /api/model-config 已返回规范化字段（布尔 enabled/is_default、video 的 workflow_id 别名）。
// 这里再做一层同义转换属防御性幂等兜底：字段缺失或类型漂移时前端不至于崩，而非补偿后端字段错位。
function normalizeEntry(e, kind) {
  const modelId = e?.model_id || ''
  return {
    id: e?.id,
    name: e?.name || '',
    model_id: modelId,
    workflow_key: e?.workflow_key || '',
    workflow_id: kind === 'video' ? (e?.workflow_id ?? modelId) : '',
    is_default: !!e?.is_default,
    enabled: e?.enabled === undefined ? true : !!e?.enabled,
  }
}

function normalizeEntries(list, kind) {
  return (Array.isArray(list) ? list : []).map((e) => normalizeEntry(e, kind))
}

export const useModelConfigStore = defineStore('modelConfig', () => {
  const accounts = ref({ text: null, image: null, video: null })
  const text = ref(null)
  const imageEntries = ref([])
  const videoEntries = ref([])
  const loading = ref(false)
  const loaded = ref(false)
  const error = ref('')

  // 启明星模型广场「可用模型」列表（文本 / 生图条目选型用），与 model_config 本身解耦：
  // 该接口失败只影响选择器，不影响账号 / 条目等其它数据的可用性
  const availableModels = ref({ text: [], image: [] })
  const availableModelsLoading = ref(false)
  const availableModelsError = ref('')
  const availableModelsLoaded = ref(false)

  // 只含启用条目：已停用项不进下拉，与后端 getDefaultImageEntry() / resolveWorkflowId() 的硬过滤语义对齐
  const enabledImageEntries = computed(() => (imageEntries.value || []).filter((e) => e.enabled !== false))

  function listOf(kind) {
    return kind === 'video' ? videoEntries : imageEntries
  }

  function findList(id) {
    if (imageEntries.value.some((e) => sameId(e.id, id))) return imageEntries
    if (videoEntries.value.some((e) => sameId(e.id, id))) return videoEntries
    return null
  }

  // 幂等加载：已加载成功或正在加载时直接返回，避免重复请求
  async function load({ force = false } = {}) {
    if (loading.value) return
    if (loaded.value && !force) return
    loading.value = true
    error.value = ''
    try {
      const data = await api.getModelConfig()
      accounts.value = data?.accounts || { text: null, image: null, video: null }
      text.value = data?.text || null
      imageEntries.value = normalizeEntries(data?.imageEntries, 'image')
      videoEntries.value = normalizeEntries(data?.videoEntries, 'video')
      loaded.value = true
    } catch (e) {
      error.value = readError(e)
      throw new Error(error.value)
    } finally {
      loading.value = false
    }
  }

  // 幂等加载「可用模型」：与 load() 同款短路；失败只记 availableModelsError 并吞掉异常，
  // 绝不 rethrow —— 该列表仅用于选型辅助，不能因外部模型广场不可用而拖垮抽屉其它功能
  async function loadAvailableModels({ force = false } = {}) {
    if (availableModelsLoading.value) return
    if (availableModelsLoaded.value && !force) return
    availableModelsLoading.value = true
    availableModelsError.value = ''
    try {
      const data = await api.getAvailableModels(force)
      const models = data?.models || {}
      // 逐路防御：某一路不是数组时跳过该路，保留其已有结果，不用脏值覆盖
      if (Array.isArray(models.text)) availableModels.value.text = models.text
      if (Array.isArray(models.image)) availableModels.value.image = models.image
      availableModelsLoaded.value = true
    } catch (e) {
      availableModelsError.value = readError(e)
    } finally {
      availableModelsLoading.value = false
    }
  }

  async function saveAccount(key, patch) {
    try {
      await api.updateModelAccount(key, patch)
    } catch (e) {
      throw new Error(readError(e))
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'api_key')) {
      // Key 保存成功后必须换成后端最新掩码，避免明文留在内存里被再次回传或显示
      try {
        const data = await api.getModelConfig()
        if (data?.accounts) accounts.value = data.accounts
      } catch {
        if (accounts.value[key]) {
          accounts.value[key] = { ...accounts.value[key], api_key: patch.api_key }
        }
      }
      return
    }
    if (accounts.value[key]) {
      accounts.value[key] = { ...accounts.value[key], ...patch }
    }
  }

  async function saveText(patch) {
    try {
      await api.updateModelText(patch)
    } catch (e) {
      throw new Error(readError(e))
    }
    text.value = { ...(text.value || {}), ...patch }
  }

  async function addEntry(kind, payload) {
    let created
    try {
      created = await api.createModelEntry({ kind, ...payload })
    } catch (e) {
      throw new Error(readError(e))
    }
    const list = listOf(kind)
    // 默认归属以后端回传的 defaultId 为准（与 updateEntry / removeEntry 同一模式）。
    // 前端不再本地推断「谁该是默认」：组内可能只剩停用项，按本地 list 长度推断会与后端背离
    // （后端只统计【启用】条目，前端 list 含停用项）。
    const defaultId = created?.defaultId ?? null
    const isDefault = (id) => defaultId != null && sameId(id, defaultId)
    const item = { ...payload, id: created?.id, enabled: true, is_default: isDefault(created?.id) }
    list.value = [...list.value.map((e) => ({ ...e, is_default: isDefault(e.id) })), item]
    return item
  }

  async function updateEntry(id, patch) {
    const list = findList(id)
    if (!list) return
    let res
    try {
      res = await api.updateModelEntry(id, patch)
    } catch (e) {
      throw new Error(readError(e))
    }
    // 后端在「停用默认项」时会清默认并顺位提升，并以 defaultId 回传当前生效默认；
    // 本地据此同步 is_default，避免「后端已提升到 Y、前端仍显示 X 是默认」的状态漂移
    const defaultId = res?.defaultId ?? null
    list.value = list.value.map((e) => {
      const next = sameId(e.id, id) ? { ...e, ...patch } : e
      return { ...next, is_default: defaultId != null && sameId(next.id, defaultId) }
    })
  }

  async function removeEntry(id) {
    const list = findList(id)
    if (!list) return
    let res
    try {
      res = await api.deleteModelEntry(id)
    } catch (e) {
      throw new Error(readError(e))
    }
    // 提升结果以后端 defaultId 为准（后端按 sort_order 顺位提升，与本地数组顺序可能不同）
    const defaultId = res?.defaultId ?? null
    list.value = list.value
      .filter((e) => !sameId(e.id, id))
      .map((e) => ({ ...e, is_default: defaultId != null && sameId(e.id, defaultId) }))
  }

  async function setDefault(id) {
    const list = findList(id)
    if (!list) return
    let res
    try {
      res = await api.setModelEntryDefault(id)
    } catch (e) {
      throw new Error(readError(e))
    }
    // 后端设为默认时会一并启用该条目（响应带 enabled:true），本地同步以免状态漂移
    const nowEnabled = res?.enabled !== false
    list.value = list.value.map((e) =>
      sameId(e.id, id)
        ? { ...e, is_default: true, enabled: nowEnabled }
        : { ...e, is_default: false }
    )
  }

  function setEntryEnabled(id, enabled) {
    return updateEntry(id, { enabled })
  }

  async function testConnection(target) {
    try {
      return await api.testModelConnection(target)
    } catch (e) {
      throw new Error(readError(e))
    }
  }

  return {
    accounts,
    text,
    imageEntries,
    videoEntries,
    loading,
    loaded,
    error,
    availableModels,
    availableModelsLoading,
    availableModelsError,
    availableModelsLoaded,
    enabledImageEntries,
    load,
    loadAvailableModels,
    saveAccount,
    saveText,
    addEntry,
    updateEntry,
    removeEntry,
    setDefault,
    setEntryEnabled,
    testConnection,
  }
})
