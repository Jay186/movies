<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useProjectStore } from '../stores/project'
import { api } from '../services/api'
import { toastWarn, toastError, toastInfo, toastSuccess } from '../services/dialog'
import StyleBadge from '../components/StyleBadge.vue'
import AssetFormDialog from '../components/AssetFormDialog.vue'
import LibraryAssetPicker from '../components/LibraryAssetPicker.vue'
import AssetDetailDialog from '../components/AssetDetailDialog.vue'
import { characterColor } from '../constants/palette'
import SpatialGroupCard from '../components/SpatialGroupCard.vue'
import SceneMemberCard from '../components/SceneMemberCard.vue'
import {
  countOrphanAnchors,
  isGroupLocked as groupLockViewIsGroupLocked,
  isSceneLocked as groupLockViewIsSceneLocked,
  matchOrphanAnchor,
} from '../utils/groupLockView.js'
import { hasId, indexOfId, sameId, toIdKey, toIdKeySet, makeLocalId } from '../utils/assetId.js'

const store = useProjectStore()
const router = useRouter()
const route = useRoute()

const activeTab = ref('characters')
const mode = ref('standard')
const showAddDialog = ref(false)
const dialogType = ref('character')
const showLibraryPicker = ref(false)
const libraryPickerType = ref('character')
const replaceMode = ref(false) 
const replaceTarget = ref(null) 
const showDetailDialog = ref(false)
const detailAsset = ref(null)
const detailType = ref('character')
const showScriptConfirmDialog = ref(false) 
const audioFileInput = ref(null)
const audioUploadTarget = ref(null)


const showConfirmDialog = ref(false)
const confirmConfig = ref({ title: '', message: '', confirmText: '确认', cancelText: '取消', onConfirm: null })

const sceneMultiSelect = ref(false)
const selectedSceneIds = ref([])
const sceneBatchGenerating = ref(false)
// 批量出图的波次进度文案（按钮上实时可见），空串 = 不在批量中
const sceneBatchProgress = ref('')
// —— 批量出图总体进度（悬浮进度面板）：done/total 跨波次累计，startedAt 算已用时间 ——
const sceneBatchDone = ref(0)
const sceneBatchTotal = ref(0)
const sceneBatchStartedAt = ref(0)
const sceneBatchTick = ref(0)
let sceneBatchTimer = null

function sceneBatchBegin(total) {
  sceneBatchDone.value = 0
  sceneBatchTotal.value = total
  sceneBatchStartedAt.value = Date.now()
  sceneBatchTick.value = Date.now()
  if (sceneBatchTimer) clearInterval(sceneBatchTimer)
  sceneBatchTimer = setInterval(() => { sceneBatchTick.value = Date.now() }, 1000)
}

function sceneBatchEnd() {
  sceneBatchGenerating.value = false
  sceneBatchProgress.value = ''
  sceneBatchDone.value = 0
  sceneBatchTotal.value = 0
  sceneBatchStartedAt.value = 0
  if (sceneBatchTimer) { clearInterval(sceneBatchTimer); sceneBatchTimer = null }
}

const sceneBatchPercent = computed(() =>
  sceneBatchTotal.value > 0 ? Math.min(100, Math.round((sceneBatchDone.value / sceneBatchTotal.value) * 100)) : 0
)

const sceneBatchElapsed = computed(() => {
  if (!sceneBatchStartedAt.value || !sceneBatchTick.value) return ''
  const s = Math.max(0, Math.floor((sceneBatchTick.value - sceneBatchStartedAt.value) / 1000))
  const m = Math.floor(s / 60)
  return m ? `${m} 分 ${s % 60} 秒` : `${s} 秒`
})

const tabs = computed(() => [
  { key: 'characters', label: '角色', count: store.characters.length },
  { key: 'scenes', label: '场景', count: store.assetScenes.length },
  { key: 'props', label: '道具', count: store.props.length },
])

const showMoreMenu = ref(false)
const moreMenuRef = ref(null)

function onDocClickMore(e) {
  if (showMoreMenu.value && moreMenuRef.value && !moreMenuRef.value.contains(e.target)) {
    showMoreMenu.value = false
  }
}

function onMoreExtract() {
  showMoreMenu.value = false
  if (store.aiLoading) return
  store.extractAssets()
}

function goStylePage() {
  router.push('/art')
}

function isGenerating(id) {
  return hasId(store.generatingAssetIds, id)
}

function countPending(list) {
  return list.filter((x) => !x.imageUrl && !isGenerating(x.id)).length
}

const tabMeta = computed(() => {
  const source =
    {
      characters: { title: '角色', list: () => store.characters },
      scenes: { title: '场景', list: () => renderedScenes.value },
      props: { title: '道具', list: () => store.props },
    }[activeTab.value] || { title: '角色', list: () => store.characters }
  const list = source.list()
  return {
    title: source.title,
    total: list.length,
    missing: countPending(list),
  }
})

function projectCharUsage(item) {
  if (!item.linkedToProject) return null
  const master = store.projectCharacters.find((p) => p.id === item.projectCharacterId)
  if (!master) return null
  return { episodes: master.usageEpisodes || 1 }
}

onMounted(() => {
  if (route.query.from === 'script') {
    router.replace({ query: { ...route.query, from: undefined, reconfirm: undefined } })
  }
  document.addEventListener('keydown', onSceneEsc)
  document.addEventListener('click', onDocClickMore)
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onSceneEsc)
  document.removeEventListener('click', onDocClickMore)
  if (sceneBatchTimer) { clearInterval(sceneBatchTimer); sceneBatchTimer = null }
})

function onSceneEsc(e) {
  if (e.key !== 'Escape') return
  if (showMoreMenu.value) {
    showMoreMenu.value = false
    return
  }
  if (isEditableTarget(e.target)) return
  if (sceneMultiSelect.value) {
    exitSceneMultiSelect()
  }
}

function isEditableTarget(el) {
  if (!el || !el.tagName) return false
  const tag = el.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true
}

watch(activeTab, (val) => {
  if (val !== 'scenes') exitSceneMultiSelect()
})

function goNext() {
  if (!store.scriptConfirmed) {
    showScriptConfirmDialog.value = true
    return
  }
  // 分镜的生成/导入入口统一收敛到分镜页（空态自带完整引导），设定页只负责资产
  router.push('/storyboard')
}
function goToScript() {
  showScriptConfirmDialog.value = false
  router.push('/script')
}

const assetCollections = {
  character: { key: 'characters', list: () => store.characters, save: api.saveCharacters, label: '角色' },
  scene: { key: 'scenes', list: () => store.assetScenes, save: api.saveScenes, label: '场景' },
  prop: { key: 'props', list: () => store.props, save: api.saveProps, label: '道具' },
}

async function saveAssets(type, { silent = false, allowEmpty = false } = {}) {
  const config = assetCollections[type]
  if (!config || !store.currentEpisodeId) {
    if (!silent) toastWarn('当前没有选中的集，数据无法保存')
    return false
  }
  try {
    await config.save(store.currentEpisodeId, {
      [config.key]: config.list(),
      ...(allowEmpty ? { allowEmpty: true } : {}),
    })
    await store.loadEpisode(store.currentEpisodeId)
    // 场景保存后立刻刷新组状态，不等 800ms 防抖：
    // 新场景此时已经由 renderGroups 本地兜底成组卡，这里只是尽快补上服务端的权威组信息
    if (config.key === 'scenes' && activeTab.value === 'scenes') fetchSceneGroups(true)
    return true
  } catch (e) {
    console.error(`保存${config.label}失败:`, e)
    if (!silent) toastError(`保存${config.label}失败`, { detail: String(e.message) })
    return false
  }
}

function openDialog(type) {
  dialogType.value = type
  showAddDialog.value = true
}

async function handleLibrarySelect(payload) {
  const items = Array.isArray(payload) ? payload : (payload.items || [])
  const type = Array.isArray(payload) ? libraryPickerType.value : (payload.type || libraryPickerType.value)

  if (replaceMode.value && replaceTarget.value) {
    const coverUrl = items[0]?.cover_url || ''
    if (coverUrl) {
      const { type: t, id } = replaceTarget.value
      if (t === 'character') {
        const c = store.characters.find(x => sameId(x.id, id))
        if (c) c.imageUrl = coverUrl
      } else if (t === 'scene') {
        const s = store.assetScenes.find(x => sameId(x.id, id))
        if (s) s.imageUrl = coverUrl
      } else if (t === 'prop') {
        const p = store.props.find(x => sameId(x.id, id))
        if (p) p.imageUrl = coverUrl
      }
      await saveAssets(t)
      if (t === 'scene' && activeTab.value === 'scenes') fetchSceneGroups(true)
    }
    replaceMode.value = false
    replaceTarget.value = null
    return
  }

  for (const item of items) {
    const name = item.name || ''
    const desc = item.description || ''
    const coverUrl = item.cover_url || ''
    if (type === 'character') {
      if (!store.characters.find(c => c.name === name)) {
        store.characters.push({
          id: makeLocalId(),
          name, role: '配角', description: desc,
          imageUrl: coverUrl,
          color: characterColor(store.characters.length),
        })
      }
    } else if (type === 'scene') {
      if (!store.assetScenes.find(s => s.name === name)) {
        store.assetScenes.push({ id: makeLocalId(), name, description: desc, imageUrl: coverUrl })
      }
    } else if (type === 'prop') {
      if (!store.props.find(p => p.name === name)) {
        store.props.push({ id: makeLocalId(), name, description: desc, imageUrl: coverUrl })
      }
    }
  }
  await saveAssets(type)
}

async function handleCreate(data) {
  const id = makeLocalId()
  if (dialogType.value === 'character') {
    store.characters.push({ id, name: data.name, role: data.role || '配角', description: data.description || '', color: characterColor(store.characters.length) })
  } else if (dialogType.value === 'scene') {
    store.assetScenes.push({ id, name: data.name, description: data.description || '' })
  } else if (dialogType.value === 'prop') {
    store.props.push({ id, name: data.name, description: data.description || '' })
  }
  await saveAssets(dialogType.value)
}

async function handleSelect(items) {
  if (dialogType.value === 'character') {
    for (const item of items) {
      if (!store.characters.find(c => c.name === item.name)) {
        store.characters.push({ id: makeLocalId(), name: item.name, role: item.role || '配角', description: item.description || '', color: characterColor(store.characters.length) })
      }
    }
  } else if (dialogType.value === 'scene') {
    for (const item of items) {
      const name = item.name || item.title
      if (!store.assetScenes.find(s => s.name === name)) {
        store.assetScenes.push({ id: makeLocalId(), name, description: item.description || item.summary || '' })
      }
    }
  } else if (dialogType.value === 'prop') {
    for (const item of items) {
      if (!store.props.find(p => p.name === item.name)) {
        store.props.push({ id: makeLocalId(), name: item.name, description: item.description || '' })
      }
    }
  }
  await saveAssets(dialogType.value)
}


async function performAssetDelete(type, id) {
  const config = assetCollections[type]
  if (!config) return
  const list = config.list()
  const index = list.findIndex((x) => x.id === id)
  if (index < 0) return
  const item = list[index]
  list.splice(index, 1)
  const ok = await saveAssets(type, { silent: true, allowEmpty: type === 'scene' })
  if (!ok) {
    list.splice(Math.min(index, list.length), 0, item)
    toastError(`删除${config.label}失败`, { detail: '已还原该卡片，请重试' })
    return
  }
  if (type === 'scene' && !store.assetScenes.length) exitSceneMultiSelect()
  toastSuccess(`已删除${item.name ? `「${item.name}」` : `该${config.label}`}`)
}

async function deleteAsset(type, id) {
  const config = assetCollections[type]
  if (!config) return
  const item = config.list().find((x) => x.id === id)
  const label = config.label
  const name = item?.name || ''

  openConfirmDialog({
    title: `删除${label}${name ? `「${name}」` : ''}？`,
    message: `将永久删除该${label}及其图片，删除后无法恢复。`,
    confirmText: '删除',
    cancelText: '取消',
    danger: true,
    onConfirm: () => performAssetDelete(type, id),
  })
}

function onDeleteSceneClick(item) {
  if (!item.imageUrl) {
    deleteAsset('scene', item.id)
    return
  }
  openConfirmDialog({
    title: `删除场景「${item.name}」？`,
    message: '「仅删图片」保留场景卡片和描述，图片清空后可用「补生成缺图」重新出图；「删除场景」将永久删除整个场景及其图片，无法恢复。',
    confirmText: '删除场景',
    altConfirmText: '仅删图片',
    cancelText: '取消',
    danger: true,
    onConfirm: () => performAssetDelete('scene', item.id),
    onAltConfirm: () => deleteSceneImageOnly(item),
  })
}

async function deleteSceneImageOnly(item) {
  const s = store.assetScenes.find((x) => x.id === item.id)
  if (!s || !s.imageUrl) return
  const oldUrl = s.imageUrl
  s.imageUrl = ''
  const ok = await saveAssets('scene', { silent: true })
  if (!ok) {
    s.imageUrl = oldUrl
    toastError('删除图片失败', { detail: '已还原原图，请重试' })
    return
  }
  toastSuccess(`已删除「${s.name}」的图片`, { detail: '场景已保留，可重新生成图片' })
}

function onDeleteSceneImageClick(item) {
  if (!item?.imageUrl) {
    toastInfo(`「${item?.name || '该场景'}」还没有图片`)
    return
  }
  openConfirmDialog({
    title: `删除「${item.name}」的图片？`,
    message: '只清空图片，场景卡片和描述都保留；之后可以重新上传，或让 AI 重画一张。',
    confirmText: '删除图片',
    cancelText: '取消',
    danger: true,
    onConfirm: () => deleteSceneImageOnly(item),
  })
}


const sceneSelectableIds = computed(() =>
  renderedScenes.value.filter((s) => !isGenerating(s.id)).map((s) => s.id),
)

const allScenesSelected = computed(
  () => sceneSelectableIds.value.length > 0
    && selectedSceneIds.value.length === sceneSelectableIds.value.length,
)

function isSceneSelected(item) {
  return hasId(selectedSceneIds.value, item.id)
}

function enterSceneMultiSelect() {
  selectedSceneIds.value = []
  sceneMultiSelect.value = true
}

function exitSceneMultiSelect() {
  sceneMultiSelect.value = false
  selectedSceneIds.value = []
}

function onSceneCardClick(item) {
  if (!sceneMultiSelect.value) {
    openDetail('scene', item)
    return
  }
  if (isGenerating(item.id)) {
    toastInfo(`「${item.name}」正在生成中，暂不能选择`, { detail: '请等生成结束后再操作' })
    return
  }
  const i = indexOfId(selectedSceneIds.value, item.id)
  if (i >= 0) selectedSceneIds.value.splice(i, 1)
  else selectedSceneIds.value.push(item.id)
}

function toggleSelectAllScenes() {
  selectedSceneIds.value = allScenesSelected.value ? [] : sceneSelectableIds.value.slice()
}

async function performBatchDeleteScenes(deletable) {
  const delKeySet = toIdKeySet(deletable)
  const snapshot = store.assetScenes.slice()
  store.assetScenes = store.assetScenes.filter((s) => !delKeySet.has(toIdKey(s.id)))
  selectedSceneIds.value = selectedSceneIds.value.filter((id) => !delKeySet.has(toIdKey(id)))
  const ok = await saveAssets('scene', { silent: true, allowEmpty: true })
  if (!ok) {
    store.assetScenes = snapshot
    toastError('批量删除失败', { detail: '已还原被删除的场景，请重试' })
    return
  }
  toastSuccess(`已删除 ${deletable.length} 个场景`)
  if (!store.assetScenes.length) exitSceneMultiSelect()
}

async function performBatchDeleteSceneImages(deletable) {
  const delSet = toIdKeySet(deletable)
  const targets = store.assetScenes.filter((s) => delSet.has(toIdKey(s.id)) && s.imageUrl)
  if (!targets.length) {
    toastInfo('选中的场景都没有图片', { detail: '无需删除' })
    return
  }
  const backup = targets.map((s) => ({ s, url: s.imageUrl }))
  targets.forEach((s) => { s.imageUrl = '' })
  const ok = await saveAssets('scene', { silent: true })
  if (!ok) {
    for (const { s, url } of backup) s.imageUrl = url
    toastError('批量删除图片失败', { detail: '已还原原图，请重试' })
    return
  }
  toastSuccess(`已删除 ${targets.length} 张场景图`, { detail: '场景已保留，可用「补生成缺图」重新生成' })
}

function deleteSelectedScenes() {
  const selected = selectedSceneIds.value.slice()
  const generatingCount = selected.filter((id) => isGenerating(id)).length
  const deletable = selected.filter((id) => !isGenerating(id))
  if (!deletable.length) {
    toastWarn('选中的场景都在生成中', { detail: '请等生成结束后再删除，避免与后端写回冲突' })
    return
  }
  const delSet = toIdKeySet(deletable)
  const imageCount = store.assetScenes.filter((s) => delSet.has(toIdKey(s.id)) && s.imageUrl).length
  const skippedNote = generatingCount ? `另有 ${generatingCount} 个生成中的场景会被跳过。` : ''
  openConfirmDialog({
    title: `删除 ${deletable.length} 个场景？`,
    message: imageCount
      ? `「删除场景」将永久删除选中的 ${deletable.length} 个场景及其图片，无法恢复；「仅删图片」保留场景卡片，只清空其中 ${imageCount} 张已有图片。${skippedNote}`
      : `将永久删除选中的 ${deletable.length} 个场景及其图片，删除后无法恢复。${skippedNote}`,
    confirmText: `删除 ${deletable.length} 个`,
    altConfirmText: imageCount ? '仅删图片' : '',
    cancelText: '取消',
    danger: true,
    onConfirm: () => performBatchDeleteScenes(deletable),
    onAltConfirm: imageCount ? () => performBatchDeleteSceneImages(deletable) : null,
  })
}


const sceneGroups = ref([])
const sceneReviewPending = ref(0)
const sceneGroupsError = ref(false)
const sceneGroupsLoading = ref(false)
// 出图计划（/scene-out-plan）：过时角标的数据源，随组列表一起刷新
const sceneOutPlan = ref(null)
const groupBusyKey = ref('')
const layoutBusyKey = ref('')
// 集级布局路线（'on'=布局路线激活 / 'off'=整集不走布局路线）：
// 门禁、串联链、组卡布局区域、批量出图文案都以它为总路由
const layoutRoute = ref('on')
// 组卡片内联错误条（key=组键，value=错误摘要）：确认/重画失败时可见可重试，成功即清除
const groupErrorMap = ref({})
function setGroupError(groupKey, message) {
  groupErrorMap.value = { ...groupErrorMap.value, [groupKey]: String(message || '服务器未响应') }
}
function clearGroupError(groupKey) {
  if (!(groupKey in groupErrorMap.value)) return
  const next = { ...groupErrorMap.value }
  delete next[groupKey]
  groupErrorMap.value = next
}
let sceneGroupRefreshTimer = null   

async function fetchSceneGroups(force = false) {
  if (!store.currentEpisodeId) return
  if (sceneGroupsLoading.value && !force) return
  sceneGroupsLoading.value = true
  try {
    const status = await api.getSpatialGroupReviewStatus(store.currentEpisodeId)
    sceneGroups.value = Array.isArray(status?.groups) ? status.groups : []
    sceneReviewPending.value = Number(status?.pending) || 0
    sceneGroupsError.value = false
    // 布局总路由状态（全开/全关）：拉组列表时同步刷新，失败静默保持原值
    api.getLayoutRoute(store.currentEpisodeId).then((r) => {
      layoutRoute.value = r?.route === 'off' ? 'off' : 'on'
    }).catch(() => {})
    // 出图计划（过时判定）：同款并行拉、失败静默——角标缺数据总比页面报错强
    api.getSceneOutPlan(store.currentEpisodeId).then((plan) => {
      sceneOutPlan.value = plan || null
    }).catch(() => {})
    for (const g of sceneGroups.value) loadBaselineHistory(g)
    for (const g of sceneGroups.value) loadLayoutHistory(g)
    fetchGroupLocks()
  } catch (e) {
    if (!sceneGroupsError.value) {
      toastInfo('空间组视图加载失败，已切换为平铺模式', { detail: String(e.message) })
    }
    sceneGroupsError.value = true
  } finally {
    sceneGroupsLoading.value = false
  }
}

const baselineHistoryMap = ref({})    
const baselineHistoryLoading = ref({})
async function loadBaselineHistory(group) {
  const id = group?.repSceneId
  if (!id) return
  if (baselineHistoryMap.value[id] || baselineHistoryLoading.value[id]) return
  baselineHistoryLoading.value = { ...baselineHistoryLoading.value, [id]: true }
  try {
    const r = await api.getAssetImageHistory({ type: 'scene', id })
    baselineHistoryMap.value = { ...baselineHistoryMap.value, [id]: r.history || [] }
  } catch {
    baselineHistoryMap.value = { ...baselineHistoryMap.value, [id]: [] }
  } finally {
    const next = { ...baselineHistoryLoading.value }
    delete next[id]
    baselineHistoryLoading.value = next
  }
}
function invalidateAndReloadHistory(repSceneId) {
  if (!repSceneId) return
  const next = { ...baselineHistoryMap.value }
  delete next[repSceneId]
  baselineHistoryMap.value = next
  const g = sceneGroups.value.find((x) => String(x.repSceneId) === String(repSceneId))
  if (g) loadBaselineHistory(g)
}
function reloadLoadedBaselineHistories() {
  for (const g of sceneGroups.value) {
    const id = g?.repSceneId
    if (id && baselineHistoryMap.value[id]) {
      const next = { ...baselineHistoryMap.value }
      delete next[id]
      baselineHistoryMap.value = next
      loadBaselineHistory(g)
    }
  }
}

const layoutHistoryMap = ref({})
const layoutHistoryLoading = ref({})
async function loadLayoutHistory(group) {
  const g = group?.group
  if (!g || !store.currentEpisodeId) return
  if (layoutHistoryMap.value[g] || layoutHistoryLoading.value[g]) return
  layoutHistoryLoading.value = { ...layoutHistoryLoading.value, [g]: true }
  try {
    const r = await api.getLayoutAnchorHistory(store.currentEpisodeId, g)
    layoutHistoryMap.value = { ...layoutHistoryMap.value, [g]: r.history || [] }
  } catch {
    layoutHistoryMap.value = { ...layoutHistoryMap.value, [g]: [] }
  } finally {
    const next = { ...layoutHistoryLoading.value }
    delete next[g]
    layoutHistoryLoading.value = next
  }
}

const locksOverview = ref({ locks: [], orphanAnchors: [] })

function isGroupLocked(group) {
  return groupLockViewIsGroupLocked(group, locksOverview.value.locks)
}
function isSceneLocked(sceneId) {
  return groupLockViewIsSceneLocked(sceneId, locksOverview.value.locks)
}
function orphanAnchorForGroup(group) {
  return matchOrphanAnchor(group, locksOverview.value)
}
const orphanAnchorCount = computed(() => countOrphanAnchors(locksOverview.value))

async function fetchGroupLocks() {
  if (!store.currentEpisodeId) return
  try {
    const r = await api.getGroupLocks(store.currentEpisodeId)
    locksOverview.value = {
      locks: Array.isArray(r?.locks) ? r.locks : [],
      orphanAnchors: Array.isArray(r?.orphanAnchors) ? r.orphanAnchors : [],
    }
  } catch {
    locksOverview.value = { locks: [], orphanAnchors: [] }
  }
}

async function toggleGroupLock(group) {
  if (!store.currentEpisodeId || !group) return
  const members = (group.memberScenes || []).map((m) => Number(m.id)).filter((n) => Number.isFinite(n) && n > 0)
  if (!members.length) return
  const alreadyLocked = isGroupLocked(group)
  try {
    if (alreadyLocked) {
      const r = await api.unlockGrouping({ episodeId: store.currentEpisodeId, sceneIds: members })
      toastInfo(`已解锁「${group.repSceneTitle || group.group}」的 ${r?.removed ?? members.length} 个场景`, {
        detail: '下次重析时这组的分组会重新交给 LLM 决定',
      })
    } else {
      const r = await api.lockGrouping({ episodeId: store.currentEpisodeId, sceneIds: members, note: '组卡手动锁定' })
      toastSuccess(`已锁定「${group.repSceneTitle || group.group}」的 ${r?.locked ?? members.length} 个场景`, {
        detail: '重析不会再重组这组；要恢复自由分组时点同一颗按钮解锁',
      })
    }
    await fetchGroupLocks()
  } catch (e) {
    toastError('锁定操作失败', { detail: String(e.message) })
  }
}

async function relockAllGroups() {
  if (!store.currentEpisodeId) return
  try {
    const r = await api.lockGrouping({ episodeId: store.currentEpisodeId, note: '孤儿锚事故后重新锁定' })
    toastSuccess(`已按当前分组重新锁定（${r?.locked ?? 0} 个场景）`, {
      detail: '这能防止分组再变；已失效的那张参考图需要重新生成才会恢复生效',
    })
    await fetchGroupLocks()
    await fetchSceneGroups(true)
  } catch (e) {
    toastError('重新锁定失败', { detail: String(e.message) })
  }
}

async function restoreBaselineVersion(group, version) {
  if (!group || !version || version.is_current || groupBusyKey.value) return
  const rep = sceneById(group.repSceneId)
  openConfirmDialog({
    title: '换回这个版本当参考图？',
    message: `代表场「${rep?.name || group.group}」的当前图会被换成该版本，并设为参考图；现在的版本仍保留在版本带里，随时可换回。组内其它场景需要时可并行/串联出图。`,
    confirmText: '换回这个版本',
    cancelText: '取消',
    onConfirm: async () => {
      groupBusyKey.value = group.group
      try {
        await api.restoreAssetImage({ type: 'scene', id: group.repSceneId, historyId: version.id })
        await store.loadEpisode(store.currentEpisodeId)   
        await api.decideSpatialGroupReview({ episodeId: store.currentEpisodeId, group: group.group, action: 'confirm' })
        toastSuccess('已换回该版本并设为参考图')
      } catch (e) {
        toastError('换版本失败', { detail: String(e.message) })
      } finally {
        groupBusyKey.value = ''
        await fetchSceneGroups(true)
        invalidateAndReloadHistory(group.repSceneId)   
      }
    },
  })
}

function sceneById(id) {
  return store.assetScenes.find((s) => sameId(s.id, id)) || null
}

function memberScene(member) {
  return sceneById(member.id) || {
    id: member.id,
    name: member.title || `场${member.sceneNumber || ''}`,
    description: '',
    imageUrl: member.imageUrl || '',
  }
}

function isIdSelected(id) {
  return hasId(selectedSceneIds.value, id)
}

function isGroupPending(group) {
  if ((group?.memberScenes?.length || 0) <= 1) return false
  return group?.status === 'pending'
}

const allGroupsCollapsed = ref(false)
const forceCollapseToken = ref(0)
const forceCollapsedValue = ref(null)
function toggleAllGroups() {
  allGroupsCollapsed.value = !allGroupsCollapsed.value
  forceCollapsedValue.value = allGroupsCollapsed.value
  forceCollapseToken.value += 1
}

const groupedSceneIdSet = computed(() => {
  const set = new Set()
  for (const g of sceneGroups.value) {
    for (const m of (g.memberScenes || [])) {
      const key = toIdKey(m.id)
      if (key) set.add(key)
    }
  }
  return set
})

const ungroupedScenes = computed(() =>
  store.assetScenes.filter((s) => {
    // store 里已经带 spatialGroup 的场景一律不算未分组：
    // 保存接口是同一个事务里兜底归组的，组状态接口只是刷新慢一点，
    // 如果不排除它就会在刷新落地前闪一下平铺小卡（见 renderGroups 的本地兜底）
    if (toIdKey(s.spatialGroup)) return false
    return !groupedSceneIdSet.value.has(toIdKey(s.id))
  }),
)

// 过时角标数据源：plan 里 stale 且非 missing 的场景 → { label, detail }。
// 单原因直接显示具体文案；多原因合并成「图已过时」，完整原因放 tooltip
const STALE_REASON_LABELS = { baseline: '基准已换', layout: '布局已变', desc: '描述已改' }
const outPlanMap = computed(() => {
  const map = new Map()
  const plan = sceneOutPlan.value
  if (!plan) return map
  const collect = (m) => {
    if (!m || m.missing || !m.stale || !Array.isArray(m.staleReasons) || !m.staleReasons.length) return
    const key = toIdKey(m.id)
    if (!key) return
    const labels = m.staleReasons.map((r) => STALE_REASON_LABELS[r] || r)
    map.set(key, {
      label: labels.length === 1 ? labels[0] : '图已过时',
      detail: `图已过时：${labels.join('、')}，重出可对齐`,
    })
  }
  for (const g of (plan.groups || [])) for (const m of (g.members || [])) collect(m)
  for (const m of (plan.ungrouped || [])) collect(m)
  return map
})
function sceneStaleInfo(id) {
  return outPlanMap.value.get(toIdKey(id)) || null
}

function localMember(s) {
  return {
    id: s.id,
    sceneNumber: s.sceneNumber || 0,
    title: s.name || '',
    spatialRole: s.spatialRole || '',
    hasImage: !!s.imageUrl,
    imageUrl: s.imageUrl || '',
  }
}

function localGroup(name, scenes) {
  const members = scenes.map(localMember)
  const rep = members[0]
  const solo = members.length === 1
  return {
    group: name,
    status: 'skipped',
    repSceneId: rep?.id || 0,
    repSceneNumber: rep?.sceneNumber || 0,
    repSceneTitle: rep?.title || name,
    baselineImageUrl: solo ? (rep?.imageUrl || '') : '',
    baselineReused: solo && !!rep?.imageUrl,
    sharedLandmarks: [],
    memberScenes: members,
    layoutAnchor: null,
    layoutStale: null,
    local: true,
  }
}

// 实际渲染用的组列表：组状态接口的结果 + 本地兜底合成的组。
// 场景列表来自剧集接口、分组来自组状态接口，两者有时间差；
// 用 store 里权威的 spatialGroup 先合成出组卡，新场景就不会先掉进平铺小卡区
const renderGroups = computed(() => {
  const inStatus = new Set()
  for (const g of sceneGroups.value) {
    for (const m of (g.memberScenes || [])) {
      const key = toIdKey(m.id)
      if (key) inStatus.add(key)
    }
  }
  const pending = new Map()
  for (const s of store.assetScenes) {
    const key = toIdKey(s.id)
    if (!key || inStatus.has(key)) continue
    const name = String(s.spatialGroup || '').trim()
    if (!name) continue
    if (!pending.has(name)) pending.set(name, [])
    pending.get(name).push(s)
  }
  if (!pending.size) return sceneGroups.value

  const out = []
  for (const g of sceneGroups.value) {
    const extra = pending.get(g.group)
    if (!extra) { out.push(g); continue }
    out.push({ ...g, memberScenes: [...(g.memberScenes || []), ...extra.map(localMember)] })
    pending.delete(g.group)
  }
  for (const [name, list] of pending) out.push(localGroup(name, list))
  return out
})

const renderedScenes = computed(() => {
  const out = []
  const seen = new Set()
  for (const g of renderGroups.value) {
    for (const m of (g.memberScenes || [])) {
      const s = sceneById(m.id)
      const key = toIdKey(m.id)
      if (!s || seen.has(key)) continue
      seen.add(key)
      out.push(s)
    }
  }
  for (const s of ungroupedScenes.value) {
    const key = toIdKey(s.id)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
})

function onMemberAction(action, member) {
  const s = sceneById(member.id)
  if (!s) {
    toastWarn('找不到该场景', { detail: '可能刚被删除，列表刷新后重试' })
    fetchSceneGroups(true)
    return
  }
  if (action === 'card-click') onSceneCardClick(s)
  else if (action === 'generate') handleAiGenerate('scene', s)
  else if (action === 'edit') handleEditAsset('scene', s)
  else if (action === 'upload') handleLocalUpload('scene', s)
  else if (action === 'delete-image') onDeleteSceneImageClick(s)
  else if (action === 'delete') onDeleteSceneClick(s)
  else if (action === 'set-baseline') setBaselineFromScene(s)
}

async function setBaselineFromScene(s) {
  if (!store.currentEpisodeId) return
  const group = sceneGroupOf(s.id)
  if (!group?.group) {
    toastWarn('找不到该场景所属的组', { detail: '可能还没分组，列表刷新后重试' })
    return
  }
  groupBusyKey.value = group.group
  try {
    await api.decideSpatialGroupReview({ episodeId: store.currentEpisodeId, group: group.group, action: 'confirm', sceneId: s.id })
    clearGroupError(group.group)
    toastSuccess(`已把「${s.title || s.name}」的图设为这组的参考图`)
    await fetchSceneGroups(true)
  } catch (e) {
    setGroupError(group.group, e.message)
    toastError('设为参考图失败', { detail: String(e.message) })
  } finally {
    groupBusyKey.value = ''
  }
}

async function confirmGroup(group) {
  if (!store.currentEpisodeId || groupBusyKey.value) return
  groupBusyKey.value = group.group
  try {
    await api.decideSpatialGroupReview({ episodeId: store.currentEpisodeId, group: group.group, action: 'confirm' })
    clearGroupError(group.group)
    toastSuccess(`已把「${group.repSceneTitle || group.group}」的这张图定为参考图`, { detail: '组内其它场景都会照这张图画' })
    await fetchSceneGroups(true)
  } catch (e) {
    setGroupError(group.group, e.message)
    toastError('定参考图失败', { detail: String(e.message) })
  } finally {
    groupBusyKey.value = ''
  }
}

async function regenBaseline(group) {
  if (sceneBatchBusy()) return
  const rep = sceneById(group.repSceneId)
  if (!rep) {
    toastWarn('找不到代表场景', { detail: '该场景可能已被删除，请重新提取资产' })
    return
  }
  const run = async () => {
    const res = await store.generateAssetImage('scene', rep.id, genDesc(rep), store.imageModel)
    if (!res?.success) return
    try {
      await api.decideSpatialGroupReview({ episodeId: store.currentEpisodeId, group: group.group, action: 'confirm' })
      clearGroupError(group.group)
      toastSuccess('已重画并设为参考图', { detail: '组内其它场景可照这张重画；旧版本已存入下方版本带' })
    } catch (e) {
      setGroupError(group.group, `图已重画，但设为参考图失败（${e.message}）`)
      toastWarn('图已重画，但设为参考图失败', { detail: `${e.message}；可点「就用这张当参考图」重试` })
    }
    await fetchSceneGroups(true)
    invalidateAndReloadHistory(group.repSceneId)
  }
  // 素材检查通过（或用户在「没有生成依据」框里选了「照样生成」）之后，
  // 一律先定布局路线再出图：pending＋未画且布局路线激活走串联链，其余状态走布局总门禁
  const afterMaterial = () => {
    // 布局参考还没画、组也还没定基准：出参考图前自动先画布局图。
    // 基准图生成时会把布局图当参考、从它的空间结构里长出来，全组天然对齐。
    // 集级全关（route=off）时不进这条链——整集不走布局路线，直接出参考图。
    if (group.status === 'pending' && !group.layoutAnchor?.imageUrl && layoutRoute.value !== 'off') {
      openConfirmDialog({
        title: `先画布局图，再出「${rep.name}」的参考图？`,
        message: `这组还没画布局示意图、也没定参考图。会先画一张俯视布局示意图（约一分钟，自动质检），完成后自动出「${rep.name}」的参考图并设为基准——基准图从布局的空间结构里长出来，全组天然对齐。共 2 张图（计费）${rep.imageUrl ? '；当前旧图会进版本带，可随时换回' : ''}。`,
        confirmText: '画布局图＋出参考图',
        cancelText: '取消',
        onConfirm: async () => {
          toastInfo('先画布局图，完成后自动出参考图', { detail: '布局图约一分钟（含自动质检），期间请勿关闭页面' })
          const layoutOk = await doGenerateLayout(group, { chained: true })
          if (!layoutOk) return
          await run()
        },
      })
      return
    }
    // 布局总门禁：出基准前先确认布局参考状态（停用/confirmed 组未画布局都会先问）
    layoutGateCheck(group, {
      actionLabel: '重画参考图',
      onProceed: () => {
        if (rep.imageUrl) {
          openConfirmDialog({
            title: '重新画会替换当前的图',
            message: `「${rep.name}」已有图片，重新画一张会替换掉当前这张，并自动设为参考图；旧图会留在下方的版本带里，可随时换回。组内其它场景需要时可并行/串联出图。是否继续？`,
            confirmText: '重新画一张',
            cancelText: '取消',
            onConfirm: run,
          })
        } else {
          openConfirmDialog({
            title: `给「${rep.name}」出一张图并设为参考图？`,
            message: `会给这组的代表场景「${rep.name}」画一张图（计费），画完自动设为这组的参考图（基准）。组内其它场景出图时会照它对齐空间。是否继续？`,
            confirmText: '出图并设为参考图',
            cancelText: '取消',
            onConfirm: run,
          })
        }
      },
    })
  }
  if (!hasSceneGenerationTarget(rep)) {
    promptMissingGenerationTarget(rep, afterMaterial)
    return
  }
  afterMaterial()
}

function uploadGroupBaseline(group) {
  const repId = group?.repSceneId
  const rep = sceneById(repId)
  if (!rep) {
    toastWarn('这组还没有可用的代表场景', { detail: '列表刷新后再试，或重新提取资产' })
    return
  }
  replaceMode.value = true
  replaceTarget.value = { type: 'scene', id: repId }
  libraryPickerType.value = 'scene'
  showLibraryPicker.value = true
}

async function deleteGroupBaseline(group) {
  if (!store.currentEpisodeId || groupBusyKey.value) return
  if (sceneBatchBusy()) return
  const rep = sceneById(group?.repSceneId)
  const fromGroupAnchor = !!group?.baselineImageUrl && group?.baselineReused === false
  if (fromGroupAnchor) {
    openConfirmDialog({
      title: '删除这组的参考图？',
      message: `删掉后这组回到「没定参考图」，组内 ${group.memberScenes?.length || 0} 个场景各自出图；代表场景自己那张图不受影响，随时可以重新上传或重画。`,
      confirmText: '删除参考图',
      cancelText: '取消',
      danger: true,
      onConfirm: async () => {
        groupBusyKey.value = group.group
        try {
          await api.decideSpatialGroupReview({ episodeId: store.currentEpisodeId, group: group.group, action: 'clear' })
          toastSuccess('已删除这组的参考图')
          await fetchSceneGroups(true)
        } catch (e) {
          toastError('删除参考图失败', { detail: String(e.message) })
        } finally {
          groupBusyKey.value = ''
        }
      },
    })
    return
  }
  if (!rep || !rep.imageUrl) {
    toastInfo('这组还没有图可删')
    return
  }
  openConfirmDialog({
    title: `删除「${rep.name}」的图片？`,
    message: '只清空图片，场景卡片和描述都保留；之后可以重新上传，或让 AI 重画一张。',
    confirmText: '删除图片',
    cancelText: '取消',
    danger: true,
    onConfirm: () => deleteSceneImageOnly(rep),
  })
}

function refreshGroup(group, mode = 'parallel') {
  const memberIds = (group.memberScenes || []).map((m) => m.id)
  if (!memberIds.length || sceneBatchGenerating.value) return
  const modeLabel = mode === 'serial' ? '串联' : '并行'
  const modeNote = mode === 'serial'
    ? '同组一张画完落库再画下一张（保锚点时序，慢但稳）'
    : '同组场景同时开画（快，默认）'
  // 布局总门禁：整组出图前先确认布局参考状态（开启→带布局出图；停用/未画→先问再走）
  layoutGateCheck(group, {
    actionLabel: `${modeLabel}出图`,
    onProceed: async () => {
      // 拉过时判定：整组出图也按「缺失＋过时」智能补，不漏该重出的、不带病全重出
      let staleIds = []
      try {
        const plan = await api.getSceneOutPlan(store.currentEpisodeId)
        const pg = (plan?.groups || []).find((x) => x.group === group.group)
        staleIds = ((pg?.members || [])).filter((m) => m.stale).map((m) => m.id)
      } catch { /* 判定失败降级为只看缺失 */ }
      const members = group.memberScenes || []
      const missingIds = members.filter((m) => !m.hasImage).map((m) => m.id)
      const smartIds = [...new Set([...missingIds, ...staleIds])]
      const missingN = missingIds.length
      const staleN = smartIds.length - missingN
      const haveN = memberIds.length - missingN
      const isPending = group.status === 'pending' && memberIds.length > 1

      if (isPending) {
        // 还没定基准的组：整组出图走单组管线（代表 → 自动确认 → 成员照基准出）
        openConfirmDialog({
          title: `${modeLabel}出图「${group.repSceneTitle || group.group}」的 ${memberIds.length} 个场景？`,
          message: `这组还没定基准图。会先出代表场景「${group.repSceneTitle || ''}」并自动确认为基准，其余 ${memberIds.length - 1} 个成员再照基准${modeLabel}出图${missingN ? '' : '（已有图不重出）'}。${modeNote}。`,
          confirmText: `出代表＋自动确认＋补成员`,
          cancelText: '取消',
          onConfirm: () => doRefreshPendingGroup(group, smartIds, mode),
        })
        return
      }
      if (smartIds.length) {
        openConfirmDialog({
          title: `${modeLabel}出图「${group.repSceneTitle || group.group}」的 ${memberIds.length} 个场景？`,
          message: (missingN > 0
            ? `这组有 ${missingN} 个场景还没图${haveN ? `、${haveN} 个已有图` : ''}${staleN ? `，另有 ${staleN} 张已过时（基准/布局/描述变了）` : ''}。点「出缺失＋过时」只补该补的；点「全部重出」会覆盖整组。`
            : `这组 ${memberIds.length} 个场景都有图${staleN ? `，但 ${staleN} 张已过时（基准/布局/描述变了）` : ''}。点「出缺失＋过时」只重出过时的；点「全部重出」会覆盖整组。`)
            + ` 成员将${modeNote}。`,
          confirmText: `出 ${smartIds.length} 张（缺失 ${missingN}${staleN ? `＋过时 ${staleN}` : ''}）`,
          altConfirmText: `全部重出 ${memberIds.length} 张`,
          cancelText: '取消',
          onConfirm: () => doRefreshGroup(group, smartIds, `缺失${missingN}${staleN ? `＋过时${staleN}` : ''}`, mode),
          onAltConfirm: () => doRefreshGroup(group, memberIds, '全部重出', mode),
        })
        return
      }
      // 全有图且不过时：只剩全部重出一档
      openConfirmDialog({
        title: `整组重出「${group.repSceneTitle || group.group}」的 ${memberIds.length} 个场景？`,
        message: `这组 ${memberIds.length} 个场景都有图且未过时（基准/布局/描述都没变）。只想重画个别场景，可点那张卡上的「AI生成」。成员将${modeNote}。`,
        confirmText: `全部重出 ${memberIds.length} 张`,
        cancelText: '取消',
        onConfirm: () => doRefreshGroup(group, memberIds, '全部重出', mode),
      })
    },
  })
}

// pending 组的单组管线：代表（缺则出）→ 自动确认基准 → 成员照基准出（缺失＋过时）
async function doRefreshPendingGroup(group, smartIds, mode = 'parallel') {
  if (sceneBatchGenerating.value) return
  sceneBatchGenerating.value = true
  groupBusyKey.value = group.group
  const modeLabel = mode === 'serial' ? '串联' : '并行'
  const repId = group.repSceneId
  const repHas = (group.memberScenes || []).some((m) => sameId(m.id, repId) && m.hasImage)
  const repTodo = repHas ? 0 : 1
  const memberTodo = (group.memberScenes || []).filter((m) => !sameId(m.id, repId) && (smartIds || []).some((x) => sameId(x, m.id))).length
  sceneBatchBegin(repTodo + memberTodo)
  try {
    if (!repHas) {
      const src = store.assetScenes.find((s) => sameId(s.id, repId))
      batchProgressText('代表场景', 0, 1)
      const res = await store.generateAssetImage('scene', repId, src ? `${src.name}：${src.description || ''}` : String(group.repSceneTitle || ''), store.imageModel)
      sceneBatchDone.value++
      batchProgressText('代表场景', 1, 1)
      if (!res?.success) {
        toastWarn('代表场景出图失败，整组中止', { detail: '可点代表卡上的「AI生成」单独重试，确认基准后再并行/串联出图' })
        return
      }
    }
    try {
      await api.decideSpatialGroupReview({ episodeId: store.currentEpisodeId, group: group.group, action: 'confirm', sceneId: repId })
    } catch (e) {
      toastWarn('代表已就绪，但自动确认基准失败', { detail: `${e.message}；可在组卡点「就用这张当参考图」手动确认后再并行/串联出图` })
      return
    }
    const memberIds = (group.memberScenes || []).map((m) => m.id).filter((id) => !sameId(id, repId) && (smartIds || []).some((x) => sameId(x, id)))
    if (!memberIds.length) {
      toastSuccess('代表已出并确认为基准', { detail: '组内成员没有缺失或过时的图，无需补出' })
      return
    }
    batchProgressText('成员场景', 0, memberIds.length)
    const res = await store.batchGenerateAssetImages('scene', {
      ids: memberIds, onlyMissing: false, concurrency: 3, provider: store.imageModel, groupParallel: mode !== 'serial',
      onProgress: (d, t) => { batchProgressText('成员场景', d, t); sceneBatchDone.value = repTodo + d },
    })
    let okN = res.successCount || 0
    let failN = res.failCount || 0
    if (failN > 0 && (res.failedIds || []).length) {
      const retry = await store.batchGenerateAssetImages('scene', { ids: res.failedIds, onlyMissing: false, concurrency: 3, provider: store.imageModel, groupParallel: mode !== 'serial' })
      okN += retry.successCount || 0
      failN = retry.failCount || 0
    }
    const parts = []
    if (okN) parts.push(`成功 ${okN} 张`)
    if (failN) parts.push(`失败 ${failN} 张`)
    if (res.skipped) parts.push(`${res.skipped} 张跳过`)
    const msg = `整组${modeLabel}出图完成（代表＋自动确认＋补成员）：${parts.join('，')}`
    if (failN > 0) toastWarn(msg, { detail: '失败项可点对应卡片上的「AI生成」单独重试' })
    else toastSuccess(msg)
  } catch (e) {
    toastError(`整组${modeLabel}出图失败`, { detail: String(e.message) })
  } finally {
    sceneBatchEnd()
    groupBusyKey.value = ''
    fetchSceneGroups(true)
  }
}

async function doRefreshGroup(group, ids, label = '', mode = 'parallel') {
  if (sceneBatchGenerating.value) return
  sceneBatchGenerating.value = true
  groupBusyKey.value = group.group
  const modeLabel = mode === 'serial' ? '串联' : '并行'
  sceneBatchBegin(ids.length)
  try {
    batchProgressText(`${modeLabel}出图`, 0, ids.length)
    const res = await store.batchGenerateAssetImages('scene', {
      ids,
      onlyMissing: false,
      concurrency: 3,
      provider: store.imageModel,
      groupParallel: mode !== 'serial',
      onProgress: (d, t) => { batchProgressText(`${modeLabel}出图`, d, t); sceneBatchDone.value = d },
    })
    let okN = res.successCount || 0
    let failN = res.failCount || 0
    if (failN > 0 && (res.failedIds || []).length) {
      const retry = await store.batchGenerateAssetImages('scene', { ids: res.failedIds, onlyMissing: false, concurrency: 3, provider: store.imageModel, groupParallel: mode !== 'serial' })
      okN += retry.successCount || 0
      failN = retry.failCount || 0
    }
    const parts = []
    if (okN) parts.push(`成功 ${okN} 张`)
    if (failN) parts.push(`失败 ${failN} 张`)
    if (res.skipped) parts.push(`${res.skipped} 张跳过`)
    const msg = `整组${modeLabel}出图完成${label ? `（${label}）` : ''}：${parts.join('，')}`
    if (failN > 0) toastWarn(msg, { detail: '失败项可点对应卡片上的「AI生成」单独重试' })
    else toastSuccess(msg)
  } catch (e) {
    toastError(`整组${modeLabel}出图失败`, { detail: String(e.message) })
  } finally {
    sceneBatchEnd()
    groupBusyKey.value = ''
    fetchSceneGroups(true)
  }
}

async function skipGroup(group) {
  if (!store.currentEpisodeId || groupBusyKey.value) return
  groupBusyKey.value = group.group
  try {
    await api.decideSpatialGroupReview({ episodeId: store.currentEpisodeId, group: group.group, action: 'skip' })
    toastInfo(`「${group.repSceneTitle || group.group}」这组没定参考图`, { detail: '组内场景自由出图；想定随时点「就用这张当参考图」' })
    await fetchSceneGroups(true)
  } catch (e) {
    toastError('跳过失败', { detail: String(e.message) })
  } finally {
    groupBusyKey.value = ''
  }
}

async function toggleLayoutRef(group) {
  if (!store.currentEpisodeId || !group?.group) return
  if (sceneBatchBusy()) return
  const la = group.layoutAnchor
  if (!la) return
  const nextEnabled = la.confirmed === false
  try {
    await api.setLayoutAnchorEnabled({
      episodeId: store.currentEpisodeId,
      group: group.group,
      enabled: nextEnabled,
    })
    toastSuccess(nextEnabled ? '已恢复：出图时会带上这张布局图' : '已停用：出图时不带这张布局图')
    await fetchSceneGroups(true)
  } catch (e) {
    toastError('切换布局图参考失败', { detail: String(e.message) })
  }
}

async function toggleAllLayoutRefs() {
  if (!store.currentEpisodeId) return
  if (sceneBatchBusy()) return
  const withLayout = sceneGroups.value.filter((g) => g.layoutAnchor?.imageUrl)
  const next = layoutRoute.value !== 'on'
  openConfirmDialog({
    title: next ? '开启布局图参考路线？' : '关闭布局图参考路线？',
    message: next
      ? `布局路线激活：出图时带上布局底图（只约束位置/朝向/远近），还没画布局图的组，出图前会引导先画。${withLayout.length ? `已画布局图的 ${withLayout.length} 个组全部恢复参考。` : ''}已有图不变。`
      : `整集不走布局路线：出图一律不带布局底图、不再引导画布局图，组卡的布局区域会收起${withLayout.length ? `（已画的 ${withLayout.length} 张布局图保留，随时全开回来）` : ''}。已有图不变。`,
    confirmText: next ? '全开布局参考' : '全关布局参考',
    cancelText: '取消',
    onConfirm: async () => {
      try {
        const r = await api.setAllLayoutAnchorEnabled({ episodeId: store.currentEpisodeId, enabled: next })
        if (r?.route) layoutRoute.value = r.route === 'off' ? 'off' : 'on'
        else layoutRoute.value = next ? 'on' : 'off'
        toastSuccess(next ? '已开启布局图参考路线' : '已关闭布局图参考路线')
        await fetchSceneGroups(true)
      } catch (e) {
        toastError('全局切换失败', { detail: String(e.message) })
      }
    },
  })
}

// —— 智能批量出图（补出全部）——
// 调 /scene-out-plan 拿全量判定，按波次执行：
//   W1 布局图（route=on、组内>1、未停用、缺或过时）→ W2 代表场景 + pending 组自动确认
//   → W3 组员与未分组（缺失 + 过时）。波内并发，单张失败自动重试 1 次。
// 布局质检不过 → 该组布局停用（降级为不带布局继续）；自动确认失败 → 该组组员跳过。

// 批量出图期间的互锁：波次引擎按开跑时的基准/布局状态分波执行，
// 中途换开关/换版本/删图/重画会造成后续波次的注入上下文与计划错位
function sceneBatchBusy() {
  if (!sceneBatchGenerating.value) return false
  toastWarn('批量出图进行中，请等完成后再改布局或基准', { detail: '批量按开跑时的基准/布局状态分波执行，中途变更会导致注入错位' })
  return true
}

async function batchGenerateAllScenes() {
  if (sceneBatchGenerating.value || !store.currentEpisodeId) return
  let plan
  try {
    plan = await api.getSceneOutPlan(store.currentEpisodeId)
  } catch (e) {
    toastError('出图计划获取失败', { detail: String(e.message) })
    return
  }
  if (!plan?.success || !Array.isArray(plan.groups)) {
    toastError('出图计划获取失败', { detail: plan?.error || '返回结构异常' })
    return
  }
  const route = plan.route === 'off' ? 'off' : 'on'
  const groups = plan.groups
  const ungrouped = Array.isArray(plan.ungrouped) ? plan.ungrouped : []

  // —— 从计划组装三波任务清单 ——
  const w1Layouts = route === 'off' ? [] : groups.filter((g) =>
    g.memberCount > 1 && g.layoutState !== 'off' && (g.layoutState === 'none' || g.layoutStale)
  )
  const w1New = w1Layouts.filter((g) => g.layoutState === 'none').length
  const w1Redo = w1Layouts.length - w1New
  const needConfirm = groups.filter((g) => g.status === 'pending' && g.memberCount > 1)
  const w2Reps = groups.filter((g) => {
    const rep = (g.members || []).find((m) => m.id === g.repSceneId)
    return rep && (rep.missing || rep.stale)
  })
  const w2OnlyConfirm = needConfirm.filter((g) => !w2Reps.some((x) => x.group === g.group))
  const w3Ids = []
  let w3Miss = 0
  let w3Stale = 0
  for (const g of groups) {
    for (const m of g.members || []) {
      if (m.id === g.repSceneId) continue
      if (!(m.missing || m.stale)) continue
      w3Ids.push(m.id)
      if (m.missing) w3Miss++
      else w3Stale++
    }
  }
  for (const m of ungrouped) {
    if (!(m.missing || m.stale)) continue
    w3Ids.push(m.id)
    if (m.missing) w3Miss++
    else w3Stale++
  }
  const smartTotal = w1Layouts.length + w2Reps.length + w3Ids.length
  const missingTotal = plan.summary?.missingCount ?? (w3Miss + w2Reps.filter((g) => (g.members.find((m) => m.id === g.repSceneId) || {}).missing).length)

  if (!smartTotal && !w2OnlyConfirm.length) {
    toastInfo('场景图都齐了，无需补出', { detail: '有图且未过时的场景不会重画（省成本）。想让某组全部重画，用组卡上的「并行出图」或「串联出图」' })
    return
  }

  // —— 确认框文案（智能档披露三波任务，保守档只补缺失）——
  const lines = []
  if (w1Layouts.length) lines.push(`布局示意图 ${w1Layouts.length} 张${w1New && w1Redo ? `（新建 ${w1New}、按素材变化重画 ${w1Redo}）` : w1New ? '（新建）' : '（按素材变化重画）'}`)
  if (w2Reps.length) lines.push(`代表场景 ${w2Reps.length} 张（先定基准）`)
  if (w3Ids.length) lines.push(`成员场景 ${w3Ids.length} 张（缺失 ${w3Miss}${w3Stale ? `、过时重出 ${w3Stale}` : ''}）`)
  const confirmN = needConfirm.length
  const routeLine = route === 'off'
    ? '布局参考全关：本次出图一律不带布局底图。'
    : (w1Layouts.length ? '出图顺序：布局 → 代表定基准 → 成员照基准＋布局出图（组间并行）。' : '各组按现有基准与布局状态出图（组间并行）。')
  const smartMsg = `按当前管线状态一次补齐：${lines.join('；')}。${confirmN ? `其中 ${confirmN} 组还没定基准，代表出完后将自动确认（不想自动确认请选另一档）。` : ''}${routeLine}`
  const showAlt = missingTotal > 0 && (w1Layouts.length > 0 || w3Stale > 0 || confirmN > 0)
  const smartBtn = smartTotal > 0
    ? `智能补出 ${smartTotal} 张`
    : `确认 ${w2OnlyConfirm.length} 组基准`

  openConfirmDialog({
    title: '智能补出场景图？',
    message: smartMsg,
    confirmText: smartBtn,
    altConfirmText: showAlt ? `只补缺失 ${missingTotal} 张` : '',
    cancelText: '取消',
    onConfirm: () => runSceneOutWaves(plan),
    onAltConfirm: showAlt ? () => runSceneOutMissingOnly(plan) : null,
  })
}

// 通用并发池：worker 模式跑任务，单任务失败立即重试 1 次
async function runPool(tasks, concurrency, runner) {
  const ok = []
  const failed = []
  let idx = 0
  async function worker() {
    while (idx < tasks.length) {
      const t = tasks[idx++]
      let done = false
      try { done = await runner(t) === true } catch { done = false }
      if (!done) {
        try { done = await runner(t) === true } catch { done = false }
      }
      ;(done ? ok : failed).push(t)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, () => worker()))
  return { ok, failed }
}

function batchProgressText(label, done, total) {
  sceneBatchProgress.value = total > 1 ? `${label} ${done}/${total}` : label
}

// 智能档：W1 布局 → W2 代表+自动确认 → W3 组员，波间串行、波内并发
async function runSceneOutWaves(plan) {
  if (sceneBatchGenerating.value) return
  sceneBatchGenerating.value = true
  const route = plan.route === 'off' ? 'off' : 'on'
  const groups = plan.groups || []
  const ungrouped = plan.ungrouped || []
  const stat = { layoutOk: 0, layoutFail: 0, degraded: 0, repOk: 0, repFail: 0, confirmOk: 0, confirmFail: [], memberOk: 0, memberFail: 0 }
  const titleOf = (groupName) => (groups.find((g) => g.group === groupName) || {}).repSceneTitle || groupName
  try {
    // —— 开跑前先把三波任务量都算出来，撑起总体进度条 ——
    const w1 = route === 'off' ? [] : groups.filter((g) =>
      g.memberCount > 1 && g.layoutState !== 'off' && (g.layoutState === 'none' || g.layoutStale)
    )
    const w2 = groups.filter((g) => {
      const rep = (g.members || []).find((m) => m.id === g.repSceneId)
      return rep && (rep.missing || rep.stale)
    })
    const w3est = []
    for (const g of groups) {
      for (const m of g.members || []) {
        if (m.id === g.repSceneId) continue
        if (m.missing || m.stale) w3est.push(m.id)
      }
    }
    for (const m of ungrouped) if (m.missing || m.stale) w3est.push(m.id)
    sceneBatchBegin(w1.length + w2.length + w3est.length)

    // —— W1 布局示意图（质检不过 → 停用该组布局，降级继续）——
    if (w1.length) {
      let w1Done = 0
      const r1 = await runPool(w1, 2, async (g) => {
        const res = await api.generateLayoutAnchor({ episodeId: store.currentEpisodeId, group: g.group, provider: store.imageModel })
        w1Done++
        sceneBatchDone.value++
        batchProgressText('布局图', w1Done, w1.length)
        if (!res?.success) return false
        if (res.layoutReview?.verdict === 'fail') {
          // 质检不过：停用该组布局（出图不带底图，免得瑕疵布局污染整组），用户可手动重画后再启用
          try { await api.setLayoutAnchorEnabled({ episodeId: store.currentEpisodeId, group: g.group, enabled: false }) } catch { }
          stat.degraded++
        }
        return true
      })
      stat.layoutOk = r1.ok.length
      stat.layoutFail = r1.failed.length
      if (r1.ok.length) await fetchSceneGroups(true).catch(() => {})
    }

    // —— W2 代表场景（出完自动确认 pending 组基准）——
    const confirmGroup = async (g, sceneId) => {
      try {
        await api.decideSpatialGroupReview({ episodeId: store.currentEpisodeId, group: g.group, action: 'confirm', sceneId })
        stat.confirmOk++
        return true
      } catch (e) {
        stat.confirmFail.push(g.group)
        return false
      }
    }
    if (w2.length) {
      let w2Done = 0
      const r2 = await runPool(w2, 3, async (g) => {
        const src = store.assetScenes.find((s) => sameId(s.id, g.repSceneId))
        const desc = src ? `${src.name}：${src.description || ''}` : String(g.repSceneTitle || '')
        const res = await store.generateAssetImage('scene', g.repSceneId, desc, store.imageModel)
        w2Done++
        sceneBatchDone.value++
        batchProgressText('代表场景', w2Done, w2.length)
        if (!res?.success) return false
        if (g.status === 'pending' && g.memberCount > 1) await confirmGroup(g, g.repSceneId)
        return true
      })
      stat.repOk = r2.ok.length
      stat.repFail = r2.failed.length
    }
    // pending 组代表已有图（不缺失不过时）→ 只补自动确认
    const w2c = groups.filter((g) =>
      g.status === 'pending' && g.memberCount > 1 && !w2.some((x) => x.group === g.group)
    )
    if (w2c.length && !sceneBatchTotal.value) batchProgressText('自动确认基准', 0, 1)
    for (const g of w2c) await confirmGroup(g, g.repSceneId)

    // —— W3 组员与未分组：缺失 + 过时都出；确认失败的组自动被服务端 409 剔除 ——
    const confirmFailSet = new Set(stat.confirmFail)
    const w3Ids = []
    for (const g of groups) {
      if (confirmFailSet.has(g.group) && g.status === 'pending') continue
      for (const m of g.members || []) {
        if (m.id === g.repSceneId) continue
        if (m.missing || m.stale) w3Ids.push(m.id)
      }
    }
    for (const m of ungrouped) if (m.missing || m.stale) w3Ids.push(m.id)
    // 确认失败被跳过的组员从总量里减掉，进度条才能走到 100%
    if (w3est.length > w3Ids.length) sceneBatchTotal.value = Math.max(sceneBatchDone.value, sceneBatchTotal.value - (w3est.length - w3Ids.length))
    if (w3Ids.length) {
      batchProgressText('成员场景', 0, w3Ids.length)
      const w3Base = w1.length + w2.length
      const res = await store.batchGenerateAssetImages('scene', {
        ids: w3Ids, onlyMissing: false, concurrency: 3, provider: store.imageModel,
        onProgress: (d, t) => { batchProgressText('成员场景', d, t); sceneBatchDone.value = w3Base + d },
      })
      stat.memberOk = res.successCount || 0
      stat.memberFail = res.failCount || 0
      if (stat.memberFail > 0 && (res.failedIds || []).length) {
        // 失败项统一重试 1 次：总体进度已计满，只更新阶段文案
        const retry = await store.batchGenerateAssetImages('scene', {
          ids: res.failedIds, onlyMissing: false, concurrency: 3, provider: store.imageModel,
          onProgress: (d, t) => batchProgressText('重试失败项', d, t),
        })
        stat.memberOk += retry.successCount || 0
        stat.memberFail = retry.failCount || 0
      }
    }
  } catch (e) {
    toastError('智能补出中断', { detail: String(e.message) })
  } finally {
    sceneBatchEnd()
    fetchSceneGroups(true)
  }

  const imgOk = stat.layoutOk + stat.repOk + stat.memberOk
  const imgFail = stat.layoutFail + stat.repFail + stat.memberFail
  const parts = []
  if (imgOk) parts.push(`成功 ${imgOk} 张`)
  if (imgFail) parts.push(`失败 ${imgFail} 张`)
  if (stat.confirmOk) parts.push(`自动确认基准 ${stat.confirmOk} 组`)
  if (stat.degraded) parts.push(`${stat.degraded} 组布局质检未过、已停用布局参考（可重画布局后再启用）`)
  if (stat.confirmFail.length) parts.push(`${stat.confirmFail.length} 组确认失败（${stat.confirmFail.map(titleOf).join('、')}），组员已跳过`)
  const msg = `智能补出完成：${parts.join('，') || '没有需要生成的'}`
  if (imgFail > 0 || stat.confirmFail.length) toastWarn(msg, { detail: '失败项可点对应卡片上的「AI生成」单独重试' })
  else if (imgOk > 0) toastSuccess(msg)
  else toastInfo(msg)
}

// 保守档：只补缺失（不画布局、不自动确认、过时不重出——与旧「补出全部」行为一致）
async function runSceneOutMissingOnly(plan) {
  if (sceneBatchGenerating.value) return
  sceneBatchGenerating.value = true
  try {
    const ids = []
    let blocked = 0
    for (const g of plan.groups || []) {
      for (const m of g.members || []) {
        if (!m.missing) continue
        if (g.status === 'pending' && g.memberCount > 1 && m.id !== g.repSceneId) { blocked++; continue }
        ids.push(m.id)
      }
    }
    for (const m of plan.ungrouped || []) if (m.missing) ids.push(m.id)
    if (!ids.length) {
      toastInfo('没有缺失的场景图')
      return
    }
    sceneBatchBegin(ids.length)
    batchProgressText('补缺失', 0, ids.length)
    const res = await store.batchGenerateAssetImages('scene', {
      ids, onlyMissing: true, concurrency: 3, provider: store.imageModel,
      onProgress: (d, t) => { batchProgressText('补缺失', d, t); sceneBatchDone.value = d },
    })
    const parts = []
    if (res.successCount) parts.push(`成功 ${res.successCount} 张`)
    if (res.failCount) parts.push(`失败 ${res.failCount} 张`)
    if (blocked) parts.push(`${blocked} 张跳过（所在组没定基准）`)
    const msg = `补出缺失完成：${parts.join('，')}`
    if (res.failCount > 0) toastWarn(msg, { detail: '失败项可点对应卡片上的「AI生成」单独重试' })
    else if (res.successCount > 0) toastSuccess(msg)
    else toastInfo(msg)
  } catch (e) {
    toastError('补出缺失失败', { detail: String(e.message) })
  } finally {
    sceneBatchEnd()
    fetchSceneGroups(true)
  }
}

async function deleteLayout(group) {
  if (!store.currentEpisodeId || !group?.group) return
  if (sceneBatchBusy()) return
  openConfirmDialog({
    title: `删除「${group.repSceneTitle || group.group}」的布局示意图？`,
    message: '删除后这组出图不再带空间底图。历史版本保留，可随时从版本带换回。',
    confirmText: '删除布局图',
    cancelText: '取消',
    danger: true,
    onConfirm: async () => {
      layoutBusyKey.value = group.group
      try {
        const r = await api.deleteLayoutAnchor({ episodeId: store.currentEpisodeId, group: group.group })
        if (!r?.success) {
          toastError('删除失败', { detail: r?.error || '未知错误' })
          return
        }
        toastSuccess('已删除布局示意图')
        const next = { ...layoutHistoryMap.value }
        delete next[group.group]
        layoutHistoryMap.value = next
        await fetchSceneGroups(true)
        loadLayoutHistory(group)
      } catch (e) {
        toastError('删除布局图失败', { detail: String(e.message) })
      } finally {
        layoutBusyKey.value = ''
      }
    },
  })
}

function uploadLayout(group) {
  if (!store.currentEpisodeId || !group?.group) return
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.onchange = () => {
    const file = input.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = async () => {
      layoutBusyKey.value = group.group
      try {
        const r = await api.uploadLayoutAnchor({
          episodeId: store.currentEpisodeId,
          group: group.group,
          imageBase64: reader.result,
          filename: file.name,
        })
        if (!r?.success) {
          toastError('上传失败', { detail: r?.error || '未知错误' })
          return
        }
        toastSuccess('布局图已上传')
        const next = { ...layoutHistoryMap.value }
        delete next[group.group]
        layoutHistoryMap.value = next
        await fetchSceneGroups(true)
        loadLayoutHistory(group)
      } catch (e) {
        toastError('上传布局图失败', { detail: String(e.message) })
      } finally {
        layoutBusyKey.value = ''
      }
    }
    reader.readAsDataURL(file)
  }
  input.click()
}

async function restoreLayoutVersion(group, version) {
  if (!store.currentEpisodeId || !group?.group || !version?.id) return
  if (sceneBatchBusy()) return
  openConfirmDialog({
    title: '换回这版布局图？',
    message: '这组的布局图会换成所选旧版，并恢复为出图参考。注意：组内已按当前布局出的图不会跟着变，可能和新布局对不上——有这类图时建议换完后「并行出图」重新对齐。是否继续？',
    confirmText: '换回这版',
    cancelText: '取消',
    onConfirm: async () => {
      try {
        const r = await api.restoreLayoutAnchor({
          episodeId: store.currentEpisodeId,
          group: group.group,
          historyId: version.id,
        })
        if (!r?.success) {
          toastError('换回失败', { detail: r?.error || '未知错误' })
          return
        }
        toastSuccess('已换回这版布局图')
        const next = { ...layoutHistoryMap.value }
        delete next[group.group]
        layoutHistoryMap.value = next
        await fetchSceneGroups(true)
        loadLayoutHistory(group)
      } catch (e) {
        toastError('换回布局图失败', { detail: String(e.message) })
      }
    },
  })
}

function generateLayout(group) {
  if (layoutBusyKey.value) return
  if (sceneBatchBusy()) return
  const run = () => doGenerateLayout(group)
  if (group.layoutAnchor?.imageUrl) {
    openConfirmDialog({
      title: `重画「${group.repSceneTitle || group.group}」的布局示意图？`,
      message: (group.layoutStale === true
        ? '这组的场景内容改过了，当前这张布局图可能已经对不上实际空间（组内场景会照它对齐，图错了一起错），建议重画。会覆盖当前这张（计费），画完自动质检，有明显问题会自动重画几次。'
        : '会给这组重新画一张俯视布局示意图并覆盖当前这张（计费）。画完会自动质检，有明显问题会自动重画几次。若这组场景还没改动静，通常不需要重画。')
        + ' 重画完成后会自动作为出图参考（此前若已停用也会一并恢复）。',
      confirmText: '重画布局图',
      cancelText: '取消',
      onConfirm: run,
    })
  } else {
    run()
  }
}

async function doGenerateLayout(group, { chained = false } = {}) {
  if (!store.currentEpisodeId || layoutBusyKey.value) return false
  if (sceneBatchBusy()) return false
  layoutBusyKey.value = group.group
  try {
    const res = await api.generateLayoutAnchor({
      episodeId: store.currentEpisodeId,
      group: group.group,
      provider: store.imageModel,
    })
    if (!res?.success) {
      toastError('布局图生成失败', { detail: String(res?.error || '未知错误') })
      return false
    }
    const rv = res.layoutReview || {}
    if (rv.verdict === 'fail') {
      const kinds = (rv.defects || []).map((d) => d.type).filter(Boolean)
      toastWarn('布局图已生成，但质检没过', {
        detail: `重画了 ${rv.attempts || 1} 次仍未通过（${kinds.join('、') || '未明'}）。图上若有多余文字/标注，建议再重画一次。${rv.summary ? `（${rv.summary}）` : ''}`,
      })
    } else if (!chained) {
      const nextHint = group.status === 'confirmed'
        ? '这组的成员图是之前出的、未参考布局图——点「并行出图」让全部成员吃到布局图对齐'
        : '下一步：点「重新画一张」出代表场景参考图，确认基准后组内成员照基准＋布局图画'
      toastSuccess('布局图已生成', { detail: nextHint })
    }
    const nextH = { ...layoutHistoryMap.value }
    delete nextH[group.group]
    layoutHistoryMap.value = nextH
    await fetchSceneGroups(true)
    loadLayoutHistory(group)
    return true
  } catch (e) {
    toastError('布局图生成失败', { detail: String(e.message) })
    return false
  } finally {
    layoutBusyKey.value = ''
  }
}

function previewLayout(layoutAnchor) {
  const url = layoutAnchor?.imageUrl
  if (!url) return
  window.open(url, '_blank', 'noopener')
}

function openGroupReview() {
  const el = document.querySelector('[data-group-card="pending"]')
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('group-pulse')
    setTimeout(() => el.classList.remove('group-pulse'), 2400)
  } else {
    fetchSceneGroups(true)
  }
}

watch(activeTab, (val) => {
  if (val === 'scenes') fetchSceneGroups(true)
})

watch(() => store.currentEpisodeId, () => {
  sceneGroups.value = []
  sceneReviewPending.value = 0
  sceneOutPlan.value = null
  layoutRoute.value = 'on'
  locksOverview.value = { locks: [], orphanAnchors: [] }
  if (activeTab.value === 'scenes') fetchSceneGroups()
})

function scheduleSceneGroupsRefresh() {
  if (activeTab.value !== 'scenes' || sceneGroupsError.value) return
  clearTimeout(sceneGroupRefreshTimer)
  sceneGroupRefreshTimer = setTimeout(async () => {
    await fetchSceneGroups(true)
    reloadLoadedBaselineHistories()
  }, 800)
}
watch(() => store.generatingAssetIds.length, (len, old) => {
  if (old > len) scheduleSceneGroupsRefresh() 
})
watch(() => store.assetScenes.length, () => {
  // 场景增删后组状态要跟着刷：以前只在「已经有组」时才刷，
  // 新建集加第一个场景时组数是 0，新场景就一直停在未分组平铺区
  if (activeTab.value === 'scenes') scheduleSceneGroupsRefresh()
})
onBeforeUnmount(() => clearTimeout(sceneGroupRefreshTimer))

function handleAudioUpload(item) {
  audioUploadTarget.value = item
  audioFileInput.value?.click()
}

const AUDIO_MAX_BYTES = 10 * 1024 * 1024
const AUDIO_EXT_RE = /\.(mp3|wav|m4a|aac|ogg|flac|webm)$/i

async function onAudioFileSelected(e) {
  const file = e.target.files?.[0]
  if (!file || !audioUploadTarget.value) return

  const isAudio = (file.type || '').startsWith('audio/') || AUDIO_EXT_RE.test(file.name)
  if (!isAudio) {
    toastWarn('请选择音频文件', { detail: '支持 mp3 / wav / m4a / aac / ogg / flac' })
    audioUploadTarget.value = null
    e.target.value = ''
    return
  }
  if (file.size > AUDIO_MAX_BYTES) {
    toastWarn(`音频文件不能超过 ${Math.round(AUDIO_MAX_BYTES / 1024 / 1024)}MB`, { detail: '音色参考只需几秒样本，请裁剪后上传' })
    audioUploadTarget.value = null
    e.target.value = ''
    return
  }

  try {
    const reader = new FileReader()
    reader.onerror = () => {
      toastError('读取文件失败')
      audioUploadTarget.value = null
      e.target.value = ''
    }
    reader.onload = async () => {
      const base64 = reader.result
      const item = audioUploadTarget.value
      try {
        const updated = await api.uploadCharacterAudio(store.currentEpisodeId, item.id, base64)
        const idx = store.characters.findIndex(c => c.id === item.id)
        if (idx >= 0 && updated) {
          store.characters[idx].audioUrl = updated.audio_url || updated.audioUrl || ''
        }
      } catch (err) {
        toastError('音频上传失败', { detail: String(err.message || err) })
      } finally {
        audioUploadTarget.value = null
        e.target.value = ''
      }
    }
    reader.readAsDataURL(file)
  } catch (err) {
    toastError('读取文件失败', { detail: String(err.message) })
    audioUploadTarget.value = null
    e.target.value = ''
  }
}

function deleteAudio(item) {
  openConfirmDialog({
    title: `删除「${item.name}」的音频？`,
    message: '删除后该角色的音色参考将被移除，需要时可重新上传。',
    confirmText: '删除',
    cancelText: '取消',
    danger: true,
    onConfirm: async () => {
      try {
        await api.deleteCharacterAudio(store.currentEpisodeId, item.id)
        const idx = store.characters.findIndex(c => sameId(c.id, item.id))
        if (idx >= 0) {
          store.characters[idx].audioUrl = ''
        }
      } catch (err) {
        toastError('删除音频失败', { detail: String(err.message || err) })
      }
    },
  })
}

function openDetail(type, item) {
  detailType.value = type
  detailAsset.value = item
  showDetailDialog.value = true
}

async function saveDetail(data) {
  const type = detailType.value
  const oldId = detailAsset.value.id
  const hasImage = !!detailAsset.value.imageUrl
  if (type === 'character') {
    const c = store.characters.find(x => x.id === oldId)
    if (c) {
      c.name = data.name
      c.role = data.role
      c.description = data.description
      if (data.nameEn !== undefined) c.nameEn = data.nameEn
      if (data.descriptionEn !== undefined) c.descriptionEn = data.descriptionEn
    }
  } else if (type === 'scene') {
    const s = store.assetScenes.find(x => x.id === oldId)
    if (s) {
      s.name = data.name
      s.description = data.description
      if (data.lightingEn !== undefined) s.lightingEn = data.lightingEn
      if (data.titleEn !== undefined) s.titleEn = data.titleEn
      if (data.summaryEn !== undefined) s.summaryEn = data.summaryEn
      if (data.location !== undefined) s.location = data.location
    }
  } else if (type === 'prop') {
    const p = store.props.find(x => x.id === oldId)
    if (p) {
      p.name = data.name
      p.description = data.description
      if (data.nameEn !== undefined) p.nameEn = data.nameEn
      if (data.descriptionEn !== undefined) p.descriptionEn = data.descriptionEn
      if (data.owner !== undefined) p.owner = data.owner
    }
  }
  await saveAssets(type)
  showDetailDialog.value = false

  const list = type === 'character' ? store.characters : type === 'scene' ? store.assetScenes : store.props
  const updated = list.find(x => x.name === data.name)
  const latestId = updated?.id || oldId

  if (!hasImage && data.description && data.description.trim()) {
    const prompt = genDesc({ name: data.name, description: data.description })
    setTimeout(() => {
      store.generateAssetImage(type, latestId, prompt, store.imageModel)
    }, 300)
  }
}

function handleLocalUpload(type, item) {
  replaceMode.value = true
  replaceTarget.value = { type, id: item.id }
  libraryPickerType.value = type
  showLibraryPicker.value = true
}

function openConfirmDialog({ title, message, confirmText = '确认', altConfirmText = '', cancelText = '取消', danger = false, onConfirm, onAltConfirm = null }) {
  confirmConfig.value = { title, message, confirmText, altConfirmText, cancelText, danger, onConfirm, onAltConfirm }
  showConfirmDialog.value = true
}

function handleConfirmOk() {
  showConfirmDialog.value = false
  if (confirmConfig.value.onConfirm) {
    confirmConfig.value.onConfirm()
  }
}

function handleConfirmAlt() {
  showConfirmDialog.value = false
  if (confirmConfig.value.onAltConfirm) {
    confirmConfig.value.onAltConfirm()
  }
}

function handleConfirmCancel() {
  showConfirmDialog.value = false
}

function sceneGroupOf(sceneId) {
  for (const g of sceneGroups.value) {
    if ((g.memberScenes || []).some((m) => sameId(m.id, sceneId))) return g
  }
  return null
}

function hasSceneGenerationTarget(item) {
  if (item?.imageUrl) return true
  if (String(item?.description || '').trim()) return true
  const g = sceneGroupOf(item?.id)
  if (g?.baselineImageUrl) return true
  return false
}

function promptMissingGenerationTarget(item, onProceed) {
  openConfirmDialog({
    title: `「${item.name}」还没有生成依据`,
    message: '这个场景没有描述、也没有参考图，AI 只能照着场景名猜着画（会消耗生成额度）。建议先上传一张参考图当基准，或点开卡片补一句场景描述再生成。',
    confirmText: '先上传参考图',
    altConfirmText: '照样生成',
    cancelText: '取消',
    onConfirm: () => handleLocalUpload('scene', item),
    onAltConfirm: onProceed,
  })
}

// —— 管线流程拦截：场景出图前校验所在组的管线状态 ——
// pending 组里只有代表场景能出图（它就是未来的基准）；
// 其它成员必须等基准定完（或跳过）才能照基准画。服务端已 409 兜底，
// 这里前置拦截并把用户引导到「去定基准」，而不是等请求失败。
function sceneOutPipelineBlock(item) {
  const grp = sceneGroupOf(item?.id)
  if (!grp || grp.status !== 'pending') return null
  if (sameId(grp.repSceneId, item.id)) return null
  return () => openConfirmDialog({
    title: `「${item.name}」所在组还没定参考图`,
    message: `它属于「${grp.repSceneTitle || grp.group}」组。管线顺序：先出代表场景图并确认基准（或跳过），组内其它场景再照基准出图——现在出这张会被拒。`,
    confirmText: '去定基准',
    cancelText: '取消',
    onConfirm: () => regenBaseline(grp),
  })
}

// —— 布局总门禁：一切出图流程执行前，先确认所在组布局参考的状态，开关即路线 ——
// 开启（有图且未停用）→ 放行，出图时注入布局底图；
// 停用（有图但 confirmed=false）→ 先问：开启并继续 / 不带布局继续 / 取消；
// 未画（无图）→ 先问：先画布局图再继续 / 不画直接继续 / 取消；
// 单场景组和未分组场景没有布局概念，直接放行。
function layoutGateCheck(group, { actionLabel = '出图', onProceed } = {}) {
  const proceed = typeof onProceed === 'function' ? onProceed : () => {}
  // 集级路由优先：全关 = 整集不走布局路线，一切出图直接放行、不弹布局问题
  if (layoutRoute.value === 'off') { proceed(); return }
  if (!group?.group || (group.memberScenes || []).length <= 1) { proceed(); return }
  const la = group.layoutAnchor
  if (!la?.imageUrl) {
    openConfirmDialog({
      title: `「${group.repSceneTitle || group.group}」还没画布局示意图`,
      message: `布局示意图（俯视）是这组 ${group.memberScenes.length} 个场景共用的空间底图。还没画就${actionLabel}，这组图会按文字各画各的，位置、朝向可能对不上。要先画一张吗？约一分钟（自动质检），画完自动继续。`,
      confirmText: '先画布局图，再继续',
      altConfirmText: `直接${actionLabel}（不带布局）`,
      cancelText: '取消',
      onConfirm: async () => {
        toastInfo('先画布局图，完成后自动继续', { detail: '布局图约一分钟（含自动质检），期间请勿关闭页面' })
        const ok = await doGenerateLayout(group, { chained: true })
        if (!ok) return
        proceed()
      },
      onAltConfirm: proceed,
    })
    return
  }
  if (la.confirmed === false) {
    openConfirmDialog({
      title: `「${group.repSceneTitle || group.group}」的布局参考是停用的`,
      message: `这组有布局示意图，但布局参考当前停用——${actionLabel}不会带上它，这组图会按文字各画各的，位置、朝向可能对不上。要先开启再继续吗？`,
      confirmText: '开启布局参考并继续',
      altConfirmText: `直接${actionLabel}（不带布局）`,
      cancelText: '取消',
      onConfirm: async () => {
        try {
          await api.setLayoutAnchorEnabled({ episodeId: store.currentEpisodeId, group: group.group, enabled: true })
          toastSuccess('已开启布局图参考', { detail: '之后的出图会带上这张布局图（只约束位置/朝向/远近）' })
          await fetchSceneGroups(true)
        } catch (e) {
          toastError('开启布局参考失败', { detail: String(e.message) })
          return
        }
        proceed()
      },
      onAltConfirm: proceed,
    })
    return
  }
  proceed()
}

function confirmOverwriteOrGenerate(item, doGenerate) {
  if (item.imageUrl) {
    openConfirmDialog({
      title: '重新生成将覆盖原图',
      message: `「${item.name}」已有图片，AI 重新生成后会替换当前图片，是否继续？`,
      confirmText: '重新生成',
      cancelText: '取消',
      onConfirm: doGenerate,
    })
  } else {
    doGenerate()
  }
}

// 场景出图的统一出口：覆盖确认前先过布局总门禁（未分组场景无布局概念，直接走）
function gatedSceneGenerate(item, grp, doGenerate) {
  const proceed = () => confirmOverwriteOrGenerate(item, doGenerate)
  if (!grp) { proceed(); return }
  layoutGateCheck(grp, {
    actionLabel: `出「${item.name}」的图`,
    onProceed: proceed,
  })
}

function handleAiGenerate(type, item) {
  const doGenerate = () => store.generateAssetImage(type, item.id, genDesc(item), store.imageModel)
  if (type === 'scene') {
    const grp = sceneGroupOf(item.id)
    // pending 组的代表场景出图＝定基准：走组卡同款链（布局串联＋出图＋自动确认基准），
    // 不再从平铺按钮裸出一张「没确认基准」的图
    if (grp && grp.status === 'pending' && sameId(grp.repSceneId, item.id)) {
      regenBaseline(grp)
      return
    }
    const pipelineBlock = sceneOutPipelineBlock(item)
    if (pipelineBlock) { pipelineBlock(); return }
    if (!hasSceneGenerationTarget(item)) {
      // 「照样生成」也要过布局门禁：先补依据、再定路线，顺序不乱
      promptMissingGenerationTarget(item, () => gatedSceneGenerate(item, grp, doGenerate))
      return
    }
    gatedSceneGenerate(item, grp, doGenerate)
    return
  }
  confirmOverwriteOrGenerate(item, doGenerate)
}

async function handleEditAsset(type, item) {
  if (!item.imageUrl) {
    toastWarn(`「${item.name}」还没有图片，无法改造`, { detail: '请先「AI生成」一张基础形象图' })
    return
  }
  const instruction = (window.prompt(`要在「${item.name}」这个形象上改什么？\n例：戴一条红色针织围巾 / 背一个棕色小书包 / 换成冬季厚披风`) || '').trim()
  if (!instruction) return
  const res = await store.generateAssetImage(type, item.id, genDesc(item), store.imageModel, instruction)
  if (res?.success) {
    const list = type === 'character' ? store.characters : type === 'scene' ? store.assetScenes : store.props
    const target = list.find(x => String(x.id) === String(item.id))
    if (target && res.description) {
      target.description = res.description
      await saveAssets(type, { silent: true })
    }
  }
}

function genDesc(item) { return item.name + '：' + (item.description || '') }
</script>

<template>
  <div class="flex h-full w-full flex-col">
    <div class="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border px-6">
      <div class="flex min-w-0 items-center gap-3">
        <button
          type="button"
          class="flex h-8 shrink-0 items-center gap-1 rounded-control px-2.5 text-2xs text-text-secondary transition hover:bg-bg-hover hover:text-white"
          @click="$router.push('/script')"
        >
          <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" /></svg>
          返回
        </button>
        <div class="flex shrink-0 items-center gap-0.5 rounded-control bg-bg-secondary p-1">
          <button
            v-for="tab in tabs"
            :key="tab.key"
            type="button"
            class="rounded-tag px-3.5 py-1.5 text-2xs transition"
            :class="activeTab === tab.key ? 'bg-accent font-medium text-black' : 'text-text-secondary hover:bg-bg-hover hover:text-white'"
            :aria-pressed="activeTab === tab.key"
            @click="activeTab = tab.key"
          >{{ tab.label }}</button>
        </div>
      </div>

      <div class="flex min-w-0 items-center gap-2">
        <label class="flex h-8 shrink-0 items-center gap-2 rounded-control border border-border bg-bg-secondary pl-3 pr-2 transition hover:border-border-light focus-within:border-accent">
          <span class="text-2xs text-text-muted">模型</span>
          <span class="relative flex items-center">
            <select
              v-model="store.imageModel"
              aria-label="生图模型"
              class="cursor-pointer appearance-none bg-transparent pr-4 text-2xs font-medium text-text-primary outline-none"
            >
              <option value="zikl" class="bg-bg-card text-text-primary">gpt-image-2 (ZIKL)</option>
              <option value="visionary-nano-banana-pro" class="bg-bg-card text-text-primary">Nano Banana Pro</option>
              <option value="visionary-nano-banana-pro-cl" class="bg-bg-card text-text-primary">Nano Banana Pro CL</option>
              <option value="visionary-nano-banana-2-lite" class="bg-bg-card text-text-primary">Nano Banana 2 Lite</option>
              <option value="runninghub" class="bg-bg-card text-text-primary">四宫格通道（文生图）</option>
            </select>
            <svg class="pointer-events-none absolute right-0 h-2.5 w-2.5 text-text-muted" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2 4L5 7L8 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
          </span>
        </label>

        <button
          type="button"
          class="flex h-8 shrink-0 items-center gap-2 rounded-control border border-border bg-bg-secondary px-3 transition hover:border-border-light"
          :title="`当前画风：${store.currentStyle?.label || '未选择'}，点击前往画风页更换`"
          @click="goStylePage"
        >
          <span class="text-2xs text-text-muted">画风</span>
          <StyleBadge />
          <svg class="h-2.5 w-2.5 shrink-0 text-text-muted" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M4 2L7 5L4 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </button>

        <span class="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden="true"></span>

        <span v-if="store.aiLoading" class="flex min-w-0 items-center gap-1.5 text-2xs text-warn">
          <svg class="h-3.5 w-3.5 shrink-0 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
          <span class="truncate">{{ store.aiProgressMessage || 'AI 处理中…' }}</span>
        </span>

        <div ref="moreMenuRef" class="relative shrink-0">
          <button
            type="button"
            class="flex h-8 w-8 items-center justify-center rounded-control border transition"
            :class="showMoreMenu ? 'border-accent bg-bg-hover text-white' : 'border-border text-text-secondary hover:border-border-light hover:bg-bg-hover hover:text-white'"
            aria-label="更多操作"
            aria-haspopup="true"
            :aria-expanded="showMoreMenu"
            @click.stop="showMoreMenu = !showMoreMenu"
          >
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
          </button>
          <Transition
            enter-active-class="transition duration-100 ease-out"
            enter-from-class="opacity-0 -translate-y-1"
            enter-to-class="opacity-100 translate-y-0"
            leave-active-class="transition duration-75 ease-in"
            leave-from-class="opacity-100 translate-y-0"
            leave-to-class="opacity-0 -translate-y-1"
          >
            <div
              v-if="showMoreMenu"
              class="absolute right-0 top-full z-50 mt-1.5 w-60 overflow-hidden rounded-panel border border-border bg-bg-secondary shadow-pop"
              @click.stop
            >
              <div class="px-3 pt-2 pb-1 text-micro uppercase tracking-wider text-text-muted">维护</div>
              <button
                type="button"
                class="flex w-full items-start gap-2 px-3 py-2 text-left text-2xs text-text-secondary transition hover:bg-bg-hover hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                :disabled="store.aiLoading"
                @click="onMoreExtract"
              >
                <svg class="mt-0.5 h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                <span class="min-w-0 flex-1">
                  重新提取资产
                  <span class="mt-0.5 block text-micro text-text-muted">从当前剧本重跑角色 / 场景 / 道具</span>
                </span>
              </button>
            </div>
          </Transition>
        </div>
      </div>
    </div>
    <div
      v-if="store.assetsStale"
      class="mx-6 mt-4 flex shrink-0 items-center gap-3 rounded-control border border-l-[3px] border-warn/30 border-l-warn bg-warn/10 px-3.5 py-2.5"
    >
      <svg class="h-4 w-4 shrink-0 text-warn" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke-width="1.5" /><path stroke-linecap="round" stroke-width="1.5" d="M12 7.5v6" /><circle cx="12" cy="16.5" r="1" fill="currentColor" stroke="none" /></svg>
      <div class="min-w-0 flex-1">
        <div class="text-2xs text-warn">资产可能已过期</div>
        <div class="mt-0.5 text-micro text-text-secondary">剧本已修改，当前角色 / 场景 / 道具基于旧剧本提取，可能缺少新增内容或残留已删除内容</div>
      </div>
      <button
        type="button"
        class="h-8 shrink-0 rounded-control bg-warn px-3.5 text-2xs font-medium text-black transition hover:bg-warn/90 disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="store.aiLoading"
        @click="store.extractAssets()"
      >
        {{ store.aiLoading ? '提取中…' : '重新提取资产' }}
      </button>
    </div>
    <div class="flex shrink-0 items-center justify-between gap-3 px-6 pt-5 pb-3">
      <div class="flex min-w-0 items-center gap-2.5">
        <h2 class="shrink-0 text-sm font-medium text-text-primary">{{ tabMeta.title }}</h2>
        <span
          v-if="sceneMultiSelect && activeTab === 'scenes'"
          class="flex h-5 shrink-0 items-center rounded-pill bg-accent/15 px-2 text-micro text-accent"
        >已选 {{ selectedSceneIds.length }} / {{ sceneSelectableIds.length }}</span>
        <template v-else>
          <span class="shrink-0 text-2xs text-text-muted">{{ tabMeta.total }} 个</span>
          <span
            v-if="tabMeta.missing"
            class="flex h-5 shrink-0 items-center rounded-pill bg-warn/15 px-2 text-micro text-warn"
          >{{ tabMeta.missing }} 个待生成图片</span>
        </template>
      </div>

      <div v-if="activeTab === 'scenes'" class="flex shrink-0 items-center gap-1">
        <template v-if="sceneMultiSelect">
          <button type="button" class="flex h-8 items-center rounded-control border border-border px-2.5 text-2xs text-text-secondary transition hover:border-border-light hover:text-white disabled:cursor-not-allowed disabled:opacity-40" :disabled="!sceneSelectableIds.length" @click="toggleSelectAllScenes">
            {{ allScenesSelected ? '取消全选' : '全选' }}
          </button>
          <button type="button" class="flex h-8 items-center gap-1.5 rounded-control px-2.5 text-2xs text-danger transition hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-40" :disabled="!selectedSceneIds.length" @click="deleteSelectedScenes">
            <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
            删除选中{{ selectedSceneIds.length ? ` (${selectedSceneIds.length})` : '' }}
          </button>
          <button type="button" class="flex h-8 items-center rounded-control px-2.5 text-2xs text-text-muted transition hover:bg-bg-hover hover:text-white" @click="exitSceneMultiSelect">退出多选</button>
        </template>

        <template v-else>
          <button
            v-if="activeTab === 'scenes' && !sceneGroupsError && renderGroups.length > 1"
            type="button"
            class="flex h-8 items-center gap-1.5 rounded-control px-2.5 text-2xs text-text-secondary transition hover:bg-bg-hover hover:text-white"
            :title="allGroupsCollapsed ? '展开全部场景组' : '收起全部场景组，一屏扫览'"
            @click="toggleAllGroups"
          >
            <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" :d="allGroupsCollapsed ? 'M4 8V4m0 0h4M4 4l5 5m11-5h-4m4 0v4m0-4l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4' : 'M4 8V4m0 0h4M4 4l5 5m11-5h-4m4 0v4m0-4l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4'" />
            </svg>
            {{ allGroupsCollapsed ? '展开全部' : '收起全部' }}
          </button>
          <button
            v-if="activeTab === 'scenes'"
            type="button"
            class="flex h-8 items-center gap-1.5 rounded-control px-2.5 text-2xs transition"
            :class="layoutRoute === 'on' ? 'text-accent hover:bg-accent/12' : 'text-text-muted hover:bg-bg-hover hover:text-white'"
            :title="layoutRoute === 'on'
              ? '布局路线已开启：出图带布局底图，没画的组出图前会引导先画。点击全关'
              : '布局路线已全关：出图一律不带布局、不再引导画布局图，组卡的布局区域已收起。点击全开'"
            :aria-pressed="layoutRoute === 'on'"
            @click="toggleAllLayoutRefs"
          >
            <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 7m0 13V7m0 0L9 7" /></svg>
            布局图参考：{{ layoutRoute === 'on' ? '全开' : '全关' }}
          </button>
          <button
            v-if="activeTab === 'scenes' && !sceneGroupsError && renderGroups.length >= 1"
            type="button"
            class="flex h-8 items-center gap-1.5 rounded-control px-2.5 text-2xs text-text-secondary transition hover:bg-bg-hover hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="sceneBatchGenerating"
            title="按管线状态智能补齐：布局 → 代表定基准（自动确认）→ 成员照基准出图；缺的补、过时的重出、好的不动。也可只补缺失"
            @click="batchGenerateAllScenes"
          >
            <svg v-if="sceneBatchGenerating" class="h-3.5 w-3.5 animate-spin text-accent" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" /><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
            <svg v-else class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
            {{ sceneBatchGenerating ? (sceneBatchProgress || '智能出图中…') : '补出全部' }}
          </button>
          <button
            type="button"
            class="flex h-8 items-center gap-1.5 rounded-control px-2.5 text-2xs text-text-secondary transition hover:bg-bg-hover hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="sceneBatchGenerating"
            :aria-pressed="false"
            @click="enterSceneMultiSelect"
          >
            <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            多选
          </button>
        </template>
      </div>
    </div>
    <div class="flex flex-1 flex-wrap content-start gap-4 overflow-y-auto px-6 pb-6 pt-0">
    <template v-if="activeTab==='characters'">
      <div v-for="item in store.characters" :key="item.id" class="group flex w-64 cursor-pointer flex-col overflow-hidden rounded-xl border border-border bg-bg-card transition hover:border-accent/30" @click="openDetail('character', item)">
        <div class="relative h-40 overflow-hidden bg-white">
          <img v-if="item.imageUrl" :src="item.imageUrl" :alt="item.name" class="h-full w-full object-cover" />
          <div v-else class="flex h-full items-center justify-center">
            <svg class="h-10 w-10 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
          </div>
          <div v-if="isGenerating(item.id)" class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 backdrop-blur-sm">
            <svg class="h-8 w-8 animate-spin text-accent" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
            <span class="text-xs text-white">AI生成中...</span>
            <button class="rounded bg-white/15 px-2.5 py-0.5 text-[10px] text-white transition hover:bg-red-500" @click.stop="store.cancelAssetImageGen(item.id)">取消</button>
          </div>
          <button v-if="!isGenerating(item.id)" class="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-md bg-black/60 text-white backdrop-blur opacity-0 transition hover:bg-red-500 group-hover:opacity-100" title="删除" @click.stop="deleteAsset('character', item.id)">
            <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
          </button>
          <div class="absolute bottom-0 left-0 right-0 flex gap-1 bg-black/70 p-1.5 backdrop-blur">
            <button class="flex flex-1 items-center justify-center gap-1 rounded bg-accent/90 py-1 text-[10px] font-medium text-black transition hover:bg-accent disabled:opacity-60" :disabled="isGenerating(item.id)" @click.stop="handleAiGenerate('character', item)">
              <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>{{ isGenerating(item.id) ? '生成中...' : 'AI生成' }}
            </button>
            <button v-if="item.imageUrl" class="flex flex-1 items-center justify-center gap-1 rounded bg-white/10 py-1 text-[10px] text-white transition hover:bg-white/20 disabled:opacity-60" :disabled="isGenerating(item.id)" title="以当前图为底图换装/加饰品，保持形象不变" @click.stop="handleEditAsset('character', item)">
              <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>改造
            </button>
            <button class="flex flex-1 items-center justify-center gap-1 rounded bg-white/10 py-1 text-[10px] text-white transition hover:bg-white/20" @click.stop="handleLocalUpload('character', item)">
              <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>本地上传
            </button>
          </div>
        </div>
        <div class="flex-1 p-3">
          <div class="flex items-center gap-1.5">
            <span class="text-sm font-medium text-white">{{ item.name }}</span>
            <span v-if="item.linkedToProject" class="rounded bg-accent/20 px-1.5 py-0.5 text-[10px] text-accent" :title="`项目角色库主设定 · 已用于 ${projectCharUsage(item)?.episodes || 1} 集。修改此角色会同步到项目下所有集。`">项目库</span>
          </div>
          <p v-if="item.description" class="mt-1.5 line-clamp-2 text-[11px] leading-relaxed text-text-secondary">{{ item.description }}</p>
        </div>
        <div class="border-t border-border p-2">
          <div v-if="item.audioUrl" class="flex items-center gap-2">
            <audio :src="item.audioUrl" controls class="h-8 flex-1 min-w-0" />
            <button class="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-border text-text-secondary transition hover:border-red-500 hover:text-red-400" title="删除音频" @click.stop="deleteAudio(item)">
              <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
            </button>
          </div>
          <button v-else class="flex w-full items-center justify-center gap-1.5 rounded-lg border border-border py-1.5 text-[11px] text-text-secondary transition hover:border-accent/50 hover:text-white" @click.stop="handleAudioUpload(item)">
            <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
            音频上传 | {{ item.name }}
          </button>
        </div>
      </div>
    </template>

        <template v-else-if="activeTab==='scenes'">
          <template v-if="sceneGroupsError">
          <div v-for="item in store.assetScenes" :key="item.id"
               class="group flex w-64 cursor-pointer flex-col overflow-hidden rounded-xl border bg-bg-card transition"
               :class="[
                 sceneMultiSelect && isSceneSelected(item) ? 'border-accent ring-2 ring-accent/40' : 'border-border hover:border-accent/30',
                 sceneMultiSelect && isGenerating(item.id) ? 'cursor-not-allowed opacity-70' : '',
               ]"
               @click="onSceneCardClick(item)">
            <div class="relative h-40 overflow-hidden bg-white">
              <img v-if="item.imageUrl" :src="item.imageUrl" :alt="item.name" class="h-full w-full object-cover" />
              <div v-else class="flex h-full items-center justify-center">
                <svg class="h-10 w-10 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
              </div>
              <div v-if="sceneMultiSelect"
                   class="pointer-events-none absolute left-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-md border transition"
                   :class="[isSceneSelected(item) ? 'border-accent bg-accent' : 'border-white/70 bg-black/50 backdrop-blur', isGenerating(item.id) ? 'opacity-40' : '']">
                <svg v-if="isSceneSelected(item)" class="h-3.5 w-3.5 text-black" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" /></svg>
              </div>
              <div v-if="isGenerating(item.id)" class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 backdrop-blur-sm">
                <svg class="h-8 w-8 animate-spin text-accent" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
                <span class="text-xs text-white">AI生成中...</span>
                <button class="rounded bg-white/15 px-2.5 py-0.5 text-[10px] text-white transition hover:bg-red-500" @click.stop="store.cancelAssetImageGen(item.id)">取消</button>
              </div>
              <button v-if="!isGenerating(item.id) && !sceneMultiSelect" class="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-md bg-black/60 text-white backdrop-blur opacity-0 transition hover:bg-red-500 group-hover:opacity-100" title="删除" @click.stop="onDeleteSceneClick(item)">
                <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
              </button>
              <div v-if="!sceneMultiSelect" class="absolute bottom-0 left-0 right-0 flex gap-1 bg-black/70 p-1.5 backdrop-blur">
                <button class="flex flex-1 items-center justify-center gap-1 rounded bg-accent/90 py-1 text-[10px] font-medium text-black transition hover:bg-accent disabled:opacity-60" :disabled="isGenerating(item.id)" @click.stop="handleAiGenerate('scene', item)">
                  <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>{{ isGenerating(item.id) ? '生成中...' : 'AI生成' }}
                </button>
                <button v-if="item.imageUrl" class="flex flex-1 items-center justify-center gap-1 rounded bg-white/10 py-1 text-[10px] text-white transition hover:bg-white/20 disabled:opacity-60" :disabled="isGenerating(item.id)" title="以当前图为底图调整场景细节，保持整体不变" @click.stop="handleEditAsset('scene', item)">
                  <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>改造
                </button>
                <button class="flex flex-1 items-center justify-center gap-1 rounded bg-white/10 py-1 text-[10px] text-white transition hover:bg-white/20" @click.stop="handleLocalUpload('scene', item)">
                  <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>本地上传
                </button>
              </div>
            </div>
            <div class="flex-1 p-3">
              <div class="flex items-center gap-1.5"><span class="text-sm font-medium text-white">{{ item.name }}</span></div>
              <p class="mt-1.5 line-clamp-2 text-[11px] leading-relaxed text-text-secondary">{{ item.description }}</p>
            </div>
          </div>
          </template>

          <template v-else>
            <div v-if="sceneGroupsLoading && !renderGroups.length" class="flex h-[300px] w-full flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border">
              <svg class="h-8 w-8 animate-spin text-warn" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
              <div class="text-2xs text-text-secondary">正在分析场景空间关系…</div>
              <div class="text-micro text-text-muted">首次分析约需十几秒到两分钟，完成后场景按空间组呈现</div>
            </div>

            <template v-else>
              <div v-if="orphanAnchorCount > 0" class="flex w-full items-center gap-3 rounded-control border border-l-[3px] border-danger/30 border-l-danger bg-danger/10 px-3.5 py-2.5" role="alert">
                <svg class="h-4 w-4 shrink-0 text-danger" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" /></svg>
                <div class="min-w-0 flex-1">
                  <div class="text-2xs text-danger">{{ orphanAnchorCount }} 组的参考图基准已失效</div>
                  <div class="mt-0.5 text-micro text-text-secondary">这些组的参考图还在，但没有场景归它了——通常是场景重新分析时分组变了。重新锁定可防止再发生</div>
                </div>
                <button type="button" class="h-8 shrink-0 rounded-control bg-danger px-3.5 text-2xs font-medium text-black transition hover:bg-danger/90" @click="relockAllGroups">
                  重新锁定分组
                </button>
              </div>

              <div v-if="sceneReviewPending > 0" class="flex w-full items-center gap-3 rounded-control border border-l-[3px] border-warn/30 border-l-warn bg-warn/10 px-3.5 py-2.5">
                <svg class="h-4 w-4 shrink-0 text-warn" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
                <div class="min-w-0 flex-1">
                  <div class="text-2xs text-warn">还有 {{ sceneReviewPending }} 组场景没定参考图</div>
                  <div class="mt-0.5 text-micro text-text-secondary">同一地点的场景定一张参考图，后面画的都会照着它，场景更连贯</div>
                </div>
                <button type="button" class="h-8 shrink-0 rounded-control bg-warn px-3.5 text-2xs font-medium text-black transition hover:bg-warn/90" @click="openGroupReview">
                  去定参考图
                </button>
              </div>

              <div v-for="group in renderGroups" :key="group.group" class="w-full">
                <SpatialGroupCard
                  :group="group"
                  :busy="groupBusyKey === group.group"
                  :error="groupErrorMap[group.group] || ''"
                  :force-collapsed="forceCollapsedValue"
                  :force-collapse-token="forceCollapseToken"
                  :baseline-history="baselineHistoryMap[group.repSceneId] || []"
                  :locked="isGroupLocked(group)"
                  :orphan-anchor="orphanAnchorForGroup(group)"
                  :layout-anchor="group.layoutAnchor"
                  :layout-busy="layoutBusyKey === group.group"
                  :layout-stale="group.layoutStale"
                  :layout-history="layoutHistoryMap[group.group] || []"
                  :layout-route="layoutRoute"
                  @confirm="confirmGroup(group)"
                  @skip="skipGroup(group)"
                  @regen-baseline="regenBaseline(group)"
                  @refresh-group="(mode) => refreshGroup(group, mode)"
                  @restore-version="restoreBaselineVersion(group, $event)"
                  @toggle-lock="toggleGroupLock(group)"
                  @generate-layout="generateLayout(group)"
                  @preview-layout="previewLayout($event)"
                  @toggle-layout-ref="toggleLayoutRef(group)"
                  @restore-layout="restoreLayoutVersion(group, $event)"
                  @delete-layout="deleteLayout(group)"
                  @upload-layout="uploadLayout(group)"
                  @upload-baseline="uploadGroupBaseline(group)"
                  @delete-baseline="deleteGroupBaseline(group)"
                >
                  <template #members>
                    <SceneMemberCard
                      v-for="member in group.memberScenes"
                      :key="member.id"
                      :scene="memberScene(member)"
                      :member="member"
                      :locked="isGroupPending(group) && !sceneMultiSelect"
                      :generating="isGenerating(member.id)"
                      :stale="sceneStaleInfo(member.id)"
                      :multi-select="sceneMultiSelect"
                      :selected="isIdSelected(member.id)"
                      @card-click="onMemberAction('card-click', member)"
                      @generate="onMemberAction('generate', member)"
                      @edit="onMemberAction('edit', member)"
                      @upload="onMemberAction('upload', member)"
                      @delete-image="onMemberAction('delete-image', member)"
                      @delete="onMemberAction('delete', member)"
                      @set-baseline="onMemberAction('set-baseline', member)"
                      @cancel-generate="store.cancelAssetImageGen(member.id)"
                    />
                  </template>
                </SpatialGroupCard>
              </div>

              <div v-if="ungroupedScenes.length" class="w-full">
                <div class="mb-2.5 flex items-baseline gap-2">
                  <span class="text-micro text-text-muted">未分组场景</span>
                  <span class="text-micro text-text-muted/70">没归入场景组，可单独生成</span>
                </div>
                <div class="flex flex-wrap gap-3">
                  <SceneMemberCard
                    v-for="s in ungroupedScenes"
                    :key="s.id"
                    :scene="s"
                    :generating="isGenerating(s.id)"
                    :stale="sceneStaleInfo(s.id)"
                    :multi-select="sceneMultiSelect"
                    :selected="isSceneSelected(s)"
                    @card-click="onSceneCardClick(s)"
                    @generate="handleAiGenerate('scene', s)"
                    @edit="handleEditAsset('scene', s)"
                    @upload="handleLocalUpload('scene', s)"
                    @delete-image="onDeleteSceneImageClick(s)"
                    @delete="onDeleteSceneClick(s)"
                    @cancel-generate="store.cancelAssetImageGen(s.id)"
                  />
                </div>
              </div>

              <div v-if="!renderGroups.length && !ungroupedScenes.length" class="flex h-[300px] w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border">
                <span class="text-2xs text-text-secondary">暂无场景</span>
                <span class="text-micro text-text-muted">点下方「添加场景」手动新增，或确认剧本后重新提取资产</span>
              </div>
            </template>
          </template>
        </template>

        <template v-else>
          <div v-for="item in store.props" :key="item.id" class="group flex w-64 cursor-pointer flex-col overflow-hidden rounded-xl border border-border bg-bg-card transition hover:border-accent/30" @click="openDetail('prop', item)">
            <div class="relative h-40 overflow-hidden bg-white">
              <img v-if="item.imageUrl" :src="item.imageUrl" :alt="item.name" class="h-full w-full object-cover" />
              <div v-else class="flex h-full items-center justify-center">
                <svg class="h-10 w-10 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
              </div>
              <div v-if="isGenerating(item.id)" class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 backdrop-blur-sm">
                <svg class="h-8 w-8 animate-spin text-accent" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
                <span class="text-xs text-white">AI生成中...</span>
                <button class="rounded bg-white/15 px-2.5 py-0.5 text-[10px] text-white transition hover:bg-red-500" @click.stop="store.cancelAssetImageGen(item.id)">取消</button>
              </div>
              <button v-if="!isGenerating(item.id)" class="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-md bg-black/60 text-white backdrop-blur opacity-0 transition hover:bg-red-500 group-hover:opacity-100" title="删除" @click.stop="deleteAsset('prop', item.id)">
                <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
              </button>
              <div class="absolute bottom-0 left-0 right-0 flex gap-1 bg-black/70 p-1.5 backdrop-blur">
                <button class="flex flex-1 items-center justify-center gap-1 rounded bg-accent/90 py-1 text-[10px] font-medium text-black transition hover:bg-accent disabled:opacity-60" :disabled="isGenerating(item.id)" @click.stop="handleAiGenerate('prop', item)">
                  <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>{{ isGenerating(item.id) ? '生成中...' : 'AI生成' }}
                </button>
                <button v-if="item.imageUrl" class="flex flex-1 items-center justify-center gap-1 rounded bg-white/10 py-1 text-[10px] text-white transition hover:bg-white/20 disabled:opacity-60" :disabled="isGenerating(item.id)" title="以当前图为底图调整道具细节，保持整体不变" @click.stop="handleEditAsset('prop', item)">
                  <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>改造
                </button>
                <button class="flex flex-1 items-center justify-center gap-1 rounded bg-white/10 py-1 text-[10px] text-white transition hover:bg-white/20" @click.stop="handleLocalUpload('prop', item)">
                  <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>本地上传
                </button>
              </div>
            </div>
            <div class="flex-1 p-3">
              <div class="flex items-center gap-1.5"><span class="text-sm font-medium text-white">{{ item.name }}</span></div>
              <p v-if="item.description" class="mt-1.5 line-clamp-2 text-[11px] leading-relaxed text-text-secondary">{{ item.description }}</p>
            </div>
          </div>
        </template>

        <button
          v-if="activeTab==='scenes' && !sceneMultiSelect && !(sceneGroupsLoading && !sceneGroups.length)"
          class="flex h-14 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border transition hover:border-accent/50"
          @click="openDialog('scene')"
        >
          <svg class="h-4 w-4 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 4v16m8-8H4" /></svg>
          <span class="text-2xs text-text-secondary">添加场景</span>
          <span class="text-micro text-text-muted">（加完直接成组卡，重新提取资产时才由 AI 并组）</span>
        </button>
        <button v-else-if="activeTab!=='scenes'" class="flex h-[340px] w-64 items-center justify-center rounded-xl border border-dashed border-border transition hover:border-accent/50" @click="openDialog(activeTab==='characters'?'character':'prop')">
          <svg class="h-10 w-10 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 4v16m8-8H4" /></svg>
        </button>
      </div>

    <div class="flex shrink-0 justify-center border-t border-border py-4">
      <button :disabled="store.aiLoading" class="flex items-center gap-2 rounded-xl bg-accent px-8 py-2.5 text-sm font-medium text-black transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50" @click="goNext">
        <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" /></svg>
        {{ store.aiLoading ? '资产处理中...' : '进入下一步' }}
      </button>
    </div>

    <input ref="audioFileInput" type="file" accept="audio/*" class="hidden" @change="onAudioFileSelected" />

    <AssetFormDialog v-model="showAddDialog" :type="dialogType" :project-id="store.currentProjectId" @create="handleCreate" @select="handleSelect" />
    <LibraryAssetPicker v-model="showLibraryPicker" :type="libraryPickerType" :project-id="store.currentProjectId" :auto-use-on-upload="replaceMode" @select="handleLibrarySelect" />
    <AssetDetailDialog :visible="showDetailDialog" :asset="detailAsset" :type="detailType" @close="showDetailDialog=false" @save="saveDetail" />

    <div v-if="showScriptConfirmDialog" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" @click.self="showScriptConfirmDialog=false">
      <div class="w-[400px] overflow-hidden rounded-2xl border border-border bg-bg-card shadow-2xl">
        <div class="p-6 text-center">
          <div class="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-accent/20">
            <svg class="h-6 w-6 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
          </div>
          <h3 class="mb-2 text-lg font-medium text-white">请先确认剧本</h3>
          <p class="text-sm leading-relaxed text-text-secondary">当前剧本尚未确认，无法进入分镜创作。请先回到剧本页完成剧本确认。</p>
        </div>
        <div class="border-t border-border p-4">
          <button class="w-full rounded-xl bg-accent py-2.5 text-sm font-medium text-black transition hover:bg-accent-hover" @click="goToScript">
            去确认剧本
          </button>
        </div>
      </div>
    </div>

    <Teleport to="body">
      <Transition name="fade">
        <div v-if="showConfirmDialog" class="fixed inset-0 z-[9999] flex items-center justify-center">
          <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" @click="handleConfirmCancel"></div>
          <div class="relative w-[420px] max-w-[90vw] overflow-hidden rounded-2xl border border-border bg-bg-card shadow-2xl">
            <div class="h-1 w-full bg-accent"></div>
            <div class="p-6">
              <div class="flex items-start gap-4">
                <div class="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl" :class="confirmConfig.danger ? 'bg-danger/10' : 'bg-accent/10'">
                  <svg v-if="confirmConfig.danger" class="h-5 w-5 text-danger" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                  <svg v-else class="h-5 w-5 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                </div>
                <div class="flex-1 pt-0.5">
                  <h3 class="text-base font-semibold text-white">{{ confirmConfig.title }}</h3>
                  <p class="mt-1.5 text-sm leading-relaxed text-text-secondary">{{ confirmConfig.message }}</p>
                </div>
              </div>
              <div class="mt-6 flex justify-end gap-3">
                <button
                  class="rounded-lg border border-border bg-transparent px-4 py-2 text-sm font-medium text-text-secondary transition hover:border-border-light hover:text-white"
                  @click="handleConfirmCancel"
                >
                  {{ confirmConfig.cancelText }}
                </button>
                <button
                  v-if="confirmConfig.onAltConfirm"
                  class="rounded-lg border border-danger/40 bg-danger/10 px-4 py-2 text-sm font-medium text-danger transition hover:bg-danger/20"
                  @click="handleConfirmAlt"
                >
                  {{ confirmConfig.altConfirmText }}
                </button>
                <button
                  class="rounded-lg px-4 py-2 text-sm font-semibold transition"
                  :class="confirmConfig.danger ? 'bg-danger text-white hover:bg-danger/90' : 'bg-accent text-black hover:bg-accent-hover'"
                  @click="handleConfirmOk"
                >
                  {{ confirmConfig.confirmText }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- 批量出图（补出全部 / 整组并行·串联出图）进度面板：右下角悬浮，随出图实时刷新 -->
    <Teleport to="body">
      <Transition name="fade">
        <div v-if="sceneBatchGenerating" class="fixed bottom-6 right-6 z-[9998] w-80 rounded-2xl border border-border bg-bg-card/95 p-4 shadow-2xl backdrop-blur">
          <div class="flex items-center gap-3">
            <svg class="h-5 w-5 shrink-0 animate-spin text-accent" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" /><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
            <div class="min-w-0 flex-1">
              <div class="truncate text-2xs font-medium text-white">{{ sceneBatchProgress || '智能出图中…' }}</div>
              <div class="mt-0.5 text-micro text-text-muted">
                <template v-if="sceneBatchTotal > 0">总进度 {{ Math.min(sceneBatchDone, sceneBatchTotal) }}/{{ sceneBatchTotal }}</template>
                <template v-else>准备中…</template>
                <span v-if="sceneBatchElapsed"> · 已用 {{ sceneBatchElapsed }}</span>
              </div>
            </div>
            <span v-if="sceneBatchTotal > 0" class="shrink-0 text-sm font-semibold text-accent">{{ sceneBatchPercent }}%</span>
          </div>
          <div class="mt-3 h-1.5 w-full overflow-hidden rounded-pill bg-bg-hover">
            <div
              class="h-full rounded-pill bg-accent transition-all duration-500"
              :class="{ 'animate-pulse': sceneBatchTotal === 0 }"
              :style="{ width: (sceneBatchTotal > 0 ? sceneBatchPercent : 100) + '%' }"
            ></div>
          </div>
          <div class="mt-2 text-micro text-text-muted/80">出图期间请别改布局或基准，可继续浏览页面，完成会自动提示</div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
.fade-enter-active .relative,
.fade-leave-active .relative {
  transition: transform 0.2s ease, opacity 0.2s ease;
}
.fade-enter-from .relative,
.fade-leave-to .relative {
  transform: scale(0.95) translateY(-10px);
  opacity: 0;
}

@keyframes group-pulse-kf {
  0%, 100% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0); }
  25%, 75% { box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.35); }
}
.group-pulse {
  animation: group-pulse-kf 1.2s ease-in-out 2;
  border-radius: 10px;
}
</style>
