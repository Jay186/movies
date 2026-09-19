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
import ImportStoryboardDialog from '../components/ImportStoryboardDialog.vue'
import { characterColor } from '../constants/palette'
import SpatialGroupCard from '../components/SpatialGroupCard.vue'
import SceneMemberCard from '../components/SceneMemberCard.vue'
import {
  countOrphanAnchors,
  isGroupLocked as groupLockViewIsGroupLocked,
  isSceneLocked as groupLockViewIsSceneLocked,
  matchOrphanAnchor,
} from '../utils/groupLockView.js'

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
const showStoryboardMethodDialog = ref(false) 
const storyboardLoading = ref(false) 
const showImportDialog = ref(false) 
const fileInputRef = ref(null) 
const audioFileInput = ref(null) 
const audioUploadTarget = ref(null) 


const showConfirmDialog = ref(false)
const confirmConfig = ref({ title: '', message: '', confirmText: '确认', cancelText: '取消', onConfirm: null })

const sceneMultiSelect = ref(false) 
const selectedSceneIds = ref([]) 
const sceneBatchGenerating = ref(false)

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

function countPending(list) {
  return list.filter((x) => !x.imageUrl && !store.generatingAssetIds.includes(x.id)).length
}

const tabMeta = computed(() => {
  const source =
    {
      characters: { title: '角色', list: store.characters },
      scenes: { title: '场景', list: store.assetScenes },
      props: { title: '道具', list: store.props },
    }[activeTab.value] || { title: '角色', list: store.characters }
  return {
    title: source.title,
    total: source.list.length,
    missing: countPending(source.list),
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
})

function onSceneEsc(e) {
  if (e.key !== 'Escape') return
  if (showMoreMenu.value) {
    showMoreMenu.value = false
    return
  }
  if (sceneMultiSelect.value) {
    exitSceneMultiSelect()
  }
}

watch(activeTab, (val) => {
  if (val !== 'scenes') exitSceneMultiSelect()
})

function goNext() {
  if (!store.scriptConfirmed) {
    showScriptConfirmDialog.value = true
    return
  }
  if (store.storyboardScenes.length > 0) {
    router.push('/storyboard')
    return
  }
  showStoryboardMethodDialog.value = true
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
    const result = await config.save(store.currentEpisodeId, {
      [config.key]: config.list(),
      ...(allowEmpty ? { allowEmpty: true } : {}),
    })
    const savedItems = Array.isArray(result) ? result : []
    const localItems = config.list()
    savedItems.forEach((saved, index) => {
      const local = localItems[index]
      if (local && saved.id) local.id = saved.id
    })
    return true
  } catch (e) {
    console.error(`保存${config.label}失败:`, e)
    if (!silent) toastError(`保存${config.label}失败`, { detail: String(e.message) })
    return false
  }
}

async function handleAiStoryboard() {
  storyboardLoading.value = true
  try {
    const result = await store.extractStoryboard()
    if (result.success) {
      showStoryboardMethodDialog.value = false
      router.push('/storyboard')
    }
  } catch (e) {
    toastError('生成分镜失败', { detail: String(e.message) })
  }
  storyboardLoading.value = false
}

function handleUploadStoryboard() {
  showImportDialog.value = true
}

async function handleImported() {
  showImportDialog.value = false
  showStoryboardMethodDialog.value = false

  const result = await store.loadEpisode(store.currentEpisodeId)
  if (!result?.success) {
    toastInfo('分镜已保存，但页面刷新失败', {
      detail: result?.error || '进入分镜页后可手动刷新查看最新方案。',
      duration: 0,
    })
  } else {
    toastSuccess('分镜导入完成，已加载最新分镜方案')
  }
  router.push('/storyboard')
}

async function handleFileChange(e) {
  const file = e.target.files[0]
  if (!file) return
  try {
    const text = await file.text()
    const data = JSON.parse(text)
    if (store.currentEpisodeId && data.scenes) {
      await api.saveStoryboard(store.currentEpisodeId, {
        storyboardScenes: data.scenes,
        storyboard_confirmed: false,
        storyboard_source: 'imported',
      })
      const reloadResult = await store.loadEpisode(store.currentEpisodeId)
      if (!reloadResult?.success) {
        toastInfo('分镜已保存，但页面刷新失败', {
          detail: reloadResult?.error || '进入分镜页后可手动刷新查看最新方案。',
          duration: 0,
        })
      } else {
        store.storyboardSource = 'imported'
        toastSuccess('分镜导入完成，已加载最新分镜方案')
      }
    }
    showStoryboardMethodDialog.value = false
    router.push('/storyboard')
  } catch (err) {
    toastError('分镜脚本解析失败', { detail: '请检查 JSON 格式：' + String(err.message) })
  }
  e.target.value = '' 
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
        const c = store.characters.find(x => x.id === id)
        if (c) c.imageUrl = coverUrl
      } else if (t === 'scene') {
        const s = store.assetScenes.find(x => x.id === id)
        if (s) s.imageUrl = coverUrl
      } else if (t === 'prop') {
        const p = store.props.find(x => x.id === id)
        if (p) p.imageUrl = coverUrl
      }
      await saveAssets(t)
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
          id: Date.now() + Math.random(),
          name, role: '配角', description: desc,
          imageUrl: coverUrl,
          color: characterColor(store.characters.length),
        })
      }
    } else if (type === 'scene') {
      if (!store.assetScenes.find(s => s.name === name)) {
        store.assetScenes.push({ id: Date.now()+Math.random(), name, description: desc, imageUrl: coverUrl })
      }
    } else if (type === 'prop') {
      if (!store.props.find(p => p.name === name)) {
        store.props.push({ id: Date.now()+Math.random(), name, description: desc, imageUrl: coverUrl })
      }
    }
  }
  await saveAssets(type)
}

async function handleCreate(data) {
  const id = Date.now()
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
        store.characters.push({ id: Date.now()+Math.random(), name: item.name, role: item.role || '配角', description: item.description || '', color: characterColor(store.characters.length) })
      }
    }
  } else if (dialogType.value === 'scene') {
    for (const item of items) {
      const name = item.name || item.title
      if (!store.assetScenes.find(s => s.name === name)) {
        store.assetScenes.push({ id: Date.now()+Math.random(), name, description: item.description || item.summary || '' })
      }
    }
  } else if (dialogType.value === 'prop') {
    for (const item of items) {
      if (!store.props.find(p => p.name === item.name)) {
        store.props.push({ id: Date.now()+Math.random(), name: item.name, description: item.description || '' })
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


function isSceneGenerating(item) {
  return store.generatingAssetIds.includes(item.id)
}

const sceneSelectableIds = computed(() =>
  store.assetScenes.filter((s) => !isSceneGenerating(s)).map((s) => s.id),
)

const allScenesSelected = computed(
  () => sceneSelectableIds.value.length > 0
    && selectedSceneIds.value.length === sceneSelectableIds.value.length,
)

function isSceneSelected(item) {
  return selectedSceneIds.value.includes(item.id)
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
  if (isSceneGenerating(item)) {
    toastInfo(`「${item.name}」正在生成中，暂不能选择`, { detail: '请等生成结束后再操作' })
    return
  }
  const i = selectedSceneIds.value.indexOf(item.id)
  if (i >= 0) selectedSceneIds.value.splice(i, 1)
  else selectedSceneIds.value.push(item.id)
}

function toggleSelectAllScenes() {
  selectedSceneIds.value = allScenesSelected.value ? [] : sceneSelectableIds.value.slice()
}

async function performBatchDeleteScenes(deletable) {
  const delSet = new Set(deletable)
  const removed = store.assetScenes
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => delSet.has(s.id))
  store.assetScenes = store.assetScenes.filter((s) => !delSet.has(s.id))
  selectedSceneIds.value = selectedSceneIds.value.filter((id) => !delSet.has(id))
  const ok = await saveAssets('scene', { silent: true, allowEmpty: true })
  if (!ok) {
    const restored = store.assetScenes.slice()
    for (const { s, i } of removed) restored.splice(Math.min(i, restored.length), 0, s)
    store.assetScenes = restored
    toastError('批量删除失败', { detail: '已还原被删除的场景，请重试' })
    return
  }
  toastSuccess(`已删除 ${deletable.length} 个场景`)
  if (!store.assetScenes.length) exitSceneMultiSelect()
}

async function performBatchDeleteSceneImages(deletable) {
  const delSet = new Set(deletable)
  const targets = store.assetScenes.filter((s) => delSet.has(s.id) && s.imageUrl)
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
  const generatingCount = selected.filter((id) => store.generatingAssetIds.includes(id)).length
  const deletable = selected.filter((id) => !store.generatingAssetIds.includes(id))
  if (!deletable.length) {
    toastWarn('选中的场景都在生成中', { detail: '请等生成结束后再删除，避免与后端写回冲突' })
    return
  }
  const delSet = new Set(deletable)
  const imageCount = store.assetScenes.filter((s) => delSet.has(s.id) && s.imageUrl).length
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
const groupBusyKey = ref('')        
const layoutBusyKey = ref('')
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
    for (const g of sceneGroups.value) loadBaselineHistory(g)
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
      const r = await api.lockGrouping({ episodeId: store.currentEpisodeId, note: '组卡手动锁定' })
      toastSuccess(`已锁定当前分组（${r?.locked ?? 0} 个场景）`, {
        detail: '重析不会再重组这些场景；要恢复自由分组时点同一颗按钮解锁',
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
    message: `代表场「${rep?.name || group.group}」的当前图会被换成该版本，并设为参考图；现在的版本仍保留在版本带里，随时可换回。组内其它场景需要时可整组重画。`,
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
  return store.assetScenes.find((s) => String(s.id) === String(id)) || null
}function memberScene(member) {
  return sceneById(member.id) || {
    id: member.id,
    name: member.title || `场${member.sceneNumber || ''}`,
    description: '',
    imageUrl: member.imageUrl || '',
  }
}
function isSceneGeneratingById(id) {
  return store.generatingAssetIds.some((x) => String(x) === String(id))
}
function isIdSelected(id) {
  return selectedSceneIds.value.some((x) => String(x) === String(id))
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
    for (const m of (g.memberScenes || [])) set.add(String(m.id))
  }
  return set
})
const ungroupedScenes = computed(() =>
  store.assetScenes.filter((s) => !groupedSceneIdSet.value.has(String(s.id))),
)

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
  else if (action === 'delete') onDeleteSceneClick(s)
}

async function confirmGroup(group) {
  if (!store.currentEpisodeId || groupBusyKey.value) return
  groupBusyKey.value = group.group
  try {
    await api.decideSpatialGroupReview({ episodeId: store.currentEpisodeId, group: group.group, action: 'confirm' })
    toastSuccess(`已把「${group.repSceneTitle || group.group}」的这张图定为参考图`, { detail: '组内其它场景都会照这张图画' })
    await fetchSceneGroups(true)
  } catch (e) {
    toastError('定参考图失败', { detail: String(e.message) })
  } finally {
    groupBusyKey.value = ''
  }
}

async function regenBaseline(group) {
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
      toastSuccess('已重画并设为参考图', { detail: '组内其它场景可照这张重画；旧版本已存入下方版本带' })
    } catch (e) {
      toastWarn('图已重画，但设为参考图失败', { detail: `${e.message}；可点「就用这张当参考图」重试` })
    }
    await fetchSceneGroups(true)
    invalidateAndReloadHistory(group.repSceneId)
  }
  if (rep.imageUrl) {
    openConfirmDialog({
      title: '重新画会替换当前的图',
      message: `「${rep.name}」已有图片，重新画一张会替换掉当前这张，并自动设为参考图；旧图会留在下方的版本带里，可随时换回。组内其它场景需要时可整组重画。是否继续？`,
      confirmText: '重新画一张',
      cancelText: '取消',
      onConfirm: run,
    })
  } else {
    run()
  }
}

function refreshGroup(group) {
  const memberIds = (group.memberScenes || []).map((m) => m.id)
  if (!memberIds.length || sceneBatchGenerating.value) return
  openConfirmDialog({
    title: `整组照参考图重画「${group.repSceneTitle || group.group}」的 ${memberIds.length} 张？`,
    message: '组内每张图都会照着这张参考图重新生成并覆盖（计费）；已手动精修或上传的图也会被替换。',
    confirmText: `重画 ${memberIds.length} 张`,
    cancelText: '取消',
    onConfirm: () => doRefreshGroup(group, memberIds),
  })
}

async function doRefreshGroup(group, memberIds) {
  if (sceneBatchGenerating.value) return
  sceneBatchGenerating.value = true
  groupBusyKey.value = group.group
  try {
    const res = await store.batchGenerateAssetImages('scene', {
      ids: memberIds,
      onlyMissing: false,
      concurrency: 3,
      provider: store.imageModel,
    })
    const parts = []
    if (res.successCount) parts.push(`成功 ${res.successCount} 张`)
    if (res.failCount) parts.push(`失败 ${res.failCount} 张`)
    if (res.skipped) parts.push(`${res.skipped} 张已在生成中，已跳过`)
    if (res.total) {
      const msg = `整组重画完成：${parts.join('，')}`
      if (res.failCount > 0) toastWarn(msg, { detail: '失败项可点对应卡片上的「AI生成」单独重试' })
      else toastSuccess(msg)
    }
  } catch (e) {
    toastError('整组重画失败', { detail: String(e.message) })
  } finally {
    sceneBatchGenerating.value = false
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

function generateLayout(group) {
  if (layoutBusyKey.value) return
  const run = () => doGenerateLayout(group)
  if (group.layoutAnchor?.imageUrl) {
    openConfirmDialog({
      title: `重画「${group.repSceneTitle || group.group}」的布局示意图？`,
      message: group.layoutStale === true
        ? '这组的场景内容改过了，当前这张布局图可能已经对不上实际空间（组内场景会照它对齐，图错了一起错），建议重画。会覆盖当前这张（计费），画完自动质检，有明显问题会自动重画几次。'
        : '会给这组重新画一张俯视布局示意图并覆盖当前这张（计费）。画完会自动质检，有明显问题会自动重画几次。若这组场景还没改动静，通常不需要重画。',
      confirmText: '重画布局图',
      cancelText: '取消',
      onConfirm: run,
    })
  } else {
    run()
  }
}

async function doGenerateLayout(group) {
  if (!store.currentEpisodeId || layoutBusyKey.value) return
  layoutBusyKey.value = group.group
  try {
    const res = await api.generateLayoutAnchor({
      episodeId: store.currentEpisodeId,
      group: group.group,
      provider: store.imageModel,
    })
    if (!res?.success) {
      toastError('布局图生成失败', { detail: String(res?.error || '未知错误') })
      return
    }
    const rv = res.layoutReview || {}
    if (rv.verdict === 'fail') {
      const kinds = (rv.defects || []).map((d) => d.type).filter(Boolean)
      toastWarn('布局图已生成，但质检没过', {
        detail: `重画了 ${rv.attempts || 1} 次仍未通过（${kinds.join('、') || '未明'}）。图上若有多余文字/标注，建议再重画一次。${rv.summary ? `（${rv.summary}）` : ''}`,
      })
    } else {
      toastSuccess('布局图已生成', { detail: '组内场景现在都能照它对齐空间位置了' })
    }
    await fetchSceneGroups(true)
  } catch (e) {
    toastError('布局图生成失败', { detail: String(e.message) })
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
  if (val === 'scenes' && !sceneGroups.value.length && !sceneGroupsError.value) fetchSceneGroups()
})

watch(() => store.currentEpisodeId, () => {
  sceneGroups.value = []
  sceneReviewPending.value = 0
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
  if (sceneGroups.value.length) scheduleSceneGroupsRefresh() 
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

async function deleteAudio(item) {
  if (!confirm('确定删除该角色的音频吗？')) return
  try {
    const updated = await api.deleteCharacterAudio(store.currentEpisodeId, item.id)
    const idx = store.characters.findIndex(c => c.id === item.id)
    if (idx >= 0) {
      store.characters[idx].audioUrl = ''
    }
  } catch (err) {
    toastError('删除音频失败', { detail: String(err.message || err) })
  }
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

  console.log('[saveDetail] type:', type, 'hasImage:', hasImage, 'latestId:', latestId)
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

function handleAiGenerate(type, item) {
  if (item.imageUrl) {
    openConfirmDialog({
      title: '重新生成将覆盖原图',
      message: `「${item.name}」已有图片，AI 重新生成后会替换当前图片，是否继续？`,
      confirmText: '重新生成',
      cancelText: '取消',
      onConfirm: () => {
        store.generateAssetImage(type, item.id, genDesc(item), store.imageModel)
      }
    })
  } else {
    store.generateAssetImage(type, item.id, genDesc(item), store.imageModel)
  }
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
            v-if="activeTab === 'scenes' && !sceneGroupsError && sceneGroups.length > 1"
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
          <div v-if="store.generatingAssetIds.includes(item.id)" class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 backdrop-blur-sm">
            <svg class="h-8 w-8 animate-spin text-accent" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
            <span class="text-xs text-white">AI生成中...</span>
            <button class="rounded bg-white/15 px-2.5 py-0.5 text-[10px] text-white transition hover:bg-red-500" @click.stop="store.cancelAssetImageGen(item.id)">取消</button>
          </div>
          <button v-if="!store.generatingAssetIds.includes(item.id)" class="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-md bg-black/60 text-white backdrop-blur opacity-0 transition hover:bg-red-500 group-hover:opacity-100" title="删除" @click.stop="deleteAsset('character', item.id)">
            <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
          </button>
          <div class="absolute bottom-0 left-0 right-0 flex gap-1 bg-black/70 p-1.5 backdrop-blur">
            <button class="flex flex-1 items-center justify-center gap-1 rounded bg-accent/90 py-1 text-[10px] font-medium text-black transition hover:bg-accent disabled:opacity-60" :disabled="store.generatingAssetIds.includes(item.id)" @click.stop="handleAiGenerate('character', item)">
              <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>{{ store.generatingAssetIds.includes(item.id) ? '生成中...' : 'AI生成' }}
            </button>
            <button v-if="item.imageUrl" class="flex flex-1 items-center justify-center gap-1 rounded bg-white/10 py-1 text-[10px] text-white transition hover:bg-white/20 disabled:opacity-60" :disabled="store.generatingAssetIds.includes(item.id)" title="以当前图为底图换装/加饰品，保持形象不变" @click.stop="handleEditAsset('character', item)">
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
                 sceneMultiSelect && isSceneGenerating(item) ? 'cursor-not-allowed opacity-70' : '',
               ]"
               @click="onSceneCardClick(item)">
            <div class="relative h-40 overflow-hidden bg-white">
              <img v-if="item.imageUrl" :src="item.imageUrl" :alt="item.name" class="h-full w-full object-cover" />
              <div v-else class="flex h-full items-center justify-center">
                <svg class="h-10 w-10 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
              </div>
              <div v-if="sceneMultiSelect"
                   class="pointer-events-none absolute left-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-md border transition"
                   :class="[isSceneSelected(item) ? 'border-accent bg-accent' : 'border-white/70 bg-black/50 backdrop-blur', isSceneGenerating(item) ? 'opacity-40' : '']">
                <svg v-if="isSceneSelected(item)" class="h-3.5 w-3.5 text-black" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" /></svg>
              </div>
              <div v-if="store.generatingAssetIds.includes(item.id)" class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 backdrop-blur-sm">
                <svg class="h-8 w-8 animate-spin text-accent" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
                <span class="text-xs text-white">AI生成中...</span>
                <button class="rounded bg-white/15 px-2.5 py-0.5 text-[10px] text-white transition hover:bg-red-500" @click.stop="store.cancelAssetImageGen(item.id)">取消</button>
              </div>
              <button v-if="!store.generatingAssetIds.includes(item.id) && !sceneMultiSelect" class="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-md bg-black/60 text-white backdrop-blur opacity-0 transition hover:bg-red-500 group-hover:opacity-100" title="删除" @click.stop="onDeleteSceneClick(item)">
                <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
              </button>
              <div v-if="!sceneMultiSelect" class="absolute bottom-0 left-0 right-0 flex gap-1 bg-black/70 p-1.5 backdrop-blur">
                <button class="flex flex-1 items-center justify-center gap-1 rounded bg-accent/90 py-1 text-[10px] font-medium text-black transition hover:bg-accent disabled:opacity-60" :disabled="store.generatingAssetIds.includes(item.id)" @click.stop="handleAiGenerate('scene', item)">
                  <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>{{ store.generatingAssetIds.includes(item.id) ? '生成中...' : 'AI生成' }}
                </button>
                <button v-if="item.imageUrl" class="flex flex-1 items-center justify-center gap-1 rounded bg-white/10 py-1 text-[10px] text-white transition hover:bg-white/20 disabled:opacity-60" :disabled="store.generatingAssetIds.includes(item.id)" title="以当前图为底图调整场景细节，保持整体不变" @click.stop="handleEditAsset('scene', item)">
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
            <div v-if="sceneGroupsLoading && !sceneGroups.length" class="flex h-[300px] w-full flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border">
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

              <div v-for="group in sceneGroups" :key="group.group" class="w-full">
                <SpatialGroupCard
                  :group="group"
                  :busy="groupBusyKey === group.group"
                  :force-collapsed="forceCollapsedValue"
                  :force-collapse-token="forceCollapseToken"
                  :baseline-history="baselineHistoryMap[group.repSceneId] || []"
                  :locked="isGroupLocked(group)"
                  :orphan-anchor="orphanAnchorForGroup(group)"
                  :layout-anchor="group.layoutAnchor"
                  :layout-busy="layoutBusyKey === group.group"
                  :layout-stale="group.layoutStale"
                  @confirm="confirmGroup(group)"
                  @skip="skipGroup(group)"
                  @regen-baseline="regenBaseline(group)"
                  @refresh-group="refreshGroup(group)"
                  @restore-version="restoreBaselineVersion(group, $event)"
                  @toggle-lock="toggleGroupLock(group)"
                  @generate-layout="generateLayout(group)"
                  @preview-layout="previewLayout($event)"
                >
                  <template #members>
                    <SceneMemberCard
                      v-for="member in group.memberScenes"
                      :key="member.id"
                      :scene="memberScene(member)"
                      :member="member"
                      :locked="isGroupPending(group) && !sceneMultiSelect"
                      :generating="isSceneGeneratingById(member.id)"
                      :multi-select="sceneMultiSelect"
                      :selected="isIdSelected(member.id)"
                      @card-click="onMemberAction('card-click', member)"
                      @generate="onMemberAction('generate', member)"
                      @edit="onMemberAction('edit', member)"
                      @upload="onMemberAction('upload', member)"
                      @delete="onMemberAction('delete', member)"
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
                    :generating="isSceneGenerating(s)"
                    :multi-select="sceneMultiSelect"
                    :selected="isSceneSelected(s)"
                    @card-click="onSceneCardClick(s)"
                    @generate="handleAiGenerate('scene', s)"
                    @edit="handleEditAsset('scene', s)"
                    @upload="handleLocalUpload('scene', s)"
                    @delete="onDeleteSceneClick(s)"
                    @cancel-generate="store.cancelAssetImageGen(s.id)"
                  />
                </div>
              </div>

              <div v-if="!sceneGroups.length && !ungroupedScenes.length" class="flex h-[300px] w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border">
                <span class="text-2xs text-text-secondary">暂无场景</span>
                <span class="text-micro text-text-muted">点下方「添加场景」，或剧本确认后重新提取资产</span>
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
              <div v-if="store.generatingAssetIds.includes(item.id)" class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 backdrop-blur-sm">
                <svg class="h-8 w-8 animate-spin text-accent" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
                <span class="text-xs text-white">AI生成中...</span>
                <button class="rounded bg-white/15 px-2.5 py-0.5 text-[10px] text-white transition hover:bg-red-500" @click.stop="store.cancelAssetImageGen(item.id)">取消</button>
              </div>
              <button v-if="!store.generatingAssetIds.includes(item.id)" class="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-md bg-black/60 text-white backdrop-blur opacity-0 transition hover:bg-red-500 group-hover:opacity-100" title="删除" @click.stop="deleteAsset('prop', item.id)">
                <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
              </button>
              <div class="absolute bottom-0 left-0 right-0 flex gap-1 bg-black/70 p-1.5 backdrop-blur">
                <button class="flex flex-1 items-center justify-center gap-1 rounded bg-accent/90 py-1 text-[10px] font-medium text-black transition hover:bg-accent disabled:opacity-60" :disabled="store.generatingAssetIds.includes(item.id)" @click.stop="handleAiGenerate('prop', item)">
                  <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>{{ store.generatingAssetIds.includes(item.id) ? '生成中...' : 'AI生成' }}
                </button>
                <button v-if="item.imageUrl" class="flex flex-1 items-center justify-center gap-1 rounded bg-white/10 py-1 text-[10px] text-white transition hover:bg-white/20 disabled:opacity-60" :disabled="store.generatingAssetIds.includes(item.id)" title="以当前图为底图调整道具细节，保持整体不变" @click.stop="handleEditAsset('prop', item)">
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
          v-if="activeTab==='scenes' && !sceneGroupsError && sceneGroups.length && !sceneMultiSelect && !(sceneGroupsLoading && !sceneGroups.length)"
          class="flex h-14 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border transition hover:border-accent/50"
          @click="openDialog('scene')"
        >
          <svg class="h-4 w-4 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 4v16m8-8H4" /></svg>
          <span class="text-2xs text-text-secondary">添加场景</span>
          <span class="text-micro text-text-muted">（新场景先进未分组，重新提取资产后归组）</span>
        </button>
        <button v-else-if="!(activeTab==='scenes' && sceneMultiSelect)" class="flex h-[340px] w-64 items-center justify-center rounded-xl border border-dashed border-border transition hover:border-accent/50" @click="openDialog(activeTab==='characters'?'character':activeTab==='scenes'?'scene':'prop')">
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

    <div v-if="showStoryboardMethodDialog" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" @click.self="showStoryboardMethodDialog=false">
      <div class="w-[480px] overflow-hidden rounded-2xl border border-border bg-bg-card shadow-2xl">
        <div class="border-b border-border p-5">
          <h3 class="text-base font-medium text-white">选择分镜方式</h3>
          <p class="mt-1 text-xs text-text-secondary">可以使用 AI 自动生成分镜脚本，或上传已有的分镜脚本（txt / xlsx / docx）。</p>
        </div>
        <div class="p-5">
          <div class="grid grid-cols-2 gap-4">
            <button
              class="flex flex-col items-center gap-3 rounded-xl border border-border p-5 text-center transition hover:border-accent/50 hover:bg-bg-secondary disabled:opacity-50"
              :disabled="storyboardLoading"
              @click="handleAiStoryboard"
            >
              <div class="flex h-12 w-12 items-center justify-center rounded-full bg-accent/20">
                <svg v-if="!storyboardLoading" class="h-6 w-6 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                <svg v-else class="h-6 w-6 animate-spin text-accent" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
              </div>
              <div>
                <div class="text-sm font-medium text-white">{{ storyboardLoading ? '生成中...' : 'AI 分镜' }}</div>
                <div class="mt-1 text-[11px] text-text-secondary">根据剧本自动生成分镜脚本</div>
              </div>
            </button>

            <button
              class="flex flex-col items-center gap-3 rounded-xl border border-border p-5 text-center transition hover:border-accent/50 hover:bg-bg-secondary"
              @click="handleUploadStoryboard"
            >
              <div class="flex h-12 w-12 items-center justify-center rounded-full bg-bg-hover">
                <svg class="h-6 w-6 text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
              </div>
              <div>
                <div class="text-sm font-medium text-white">本地上传</div>
                <div class="mt-1 text-[11px] text-text-secondary">上传 .txt / .xlsx / .docx</div>
              </div>
            </button>
          </div>

          <input ref="fileInputRef" type="file" accept=".json" class="hidden" @change="handleFileChange" />
        </div>
        <div class="border-t border-border p-4">
          <button class="w-full rounded-xl border border-border py-2.5 text-sm text-text-secondary transition hover:border-border-light hover:text-white" @click="showStoryboardMethodDialog=false">
            取消
          </button>
        </div>
      </div>
    </div>

    <ImportStoryboardDialog
      v-model="showImportDialog"
      :episode-id="store.currentEpisodeId"
      @imported="handleImported"
    />

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
