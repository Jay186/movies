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
const replaceMode = ref(false) // true=替换当前卡片图片, false=添加新资产
const replaceTarget = ref(null) // { type, id }
// 详情编辑弹窗
const showDetailDialog = ref(false)
const detailAsset = ref(null)
const detailType = ref('character')
const showScriptConfirmDialog = ref(false) // 剧本未确认提示弹窗
const showStoryboardMethodDialog = ref(false) // 分镜方式选择弹窗
const storyboardLoading = ref(false) // 分镜生成中
const showImportDialog = ref(false) // 通用分镜脚本导入弹窗
const fileInputRef = ref(null) // 文件上传input引用（旧JSON入口，保留兼容）
const audioFileInput = ref(null) // 音频上传input引用
const audioUploadTarget = ref(null) // 当前正在上传音频的角色

// 生图模型：RunningHub / gpt-image-2（zikl）/ Visionary（gpt-image-2 / Nano Banana 系列）。
// 全局唯一状态放 store（imageModel），设定页/分镜页共用同一选择，localStorage 记忆在 store 内完成

// 自定义确认弹窗
const showConfirmDialog = ref(false)
const confirmConfig = ref({ title: '', message: '', confirmText: '确认', cancelText: '取消', onConfirm: null })

// ── 场景 tab：多选删除（2026-09-16）──
// 仅作用于「场景」tab；角色/道具 tab 的既有行为保持不变。
const sceneMultiSelect = ref(false) // 场景多选模式
const selectedSceneIds = ref([]) // 多选模式下选中的场景 id（生成中的不可选）
// 组重画（doRefreshGroup）进行中的防重锁，同时让「多选」按钮在此期间不可误触。
// 标题行的批量生成按钮已于 2026-09-17 删除（与组卡重复），此锁只服务组级批量。
const sceneBatchGenerating = ref(false)

// 响应式 tabs count
const tabs = computed(() => [
  { key: 'characters', label: '角色', count: store.characters.length },
  { key: 'scenes', label: '场景', count: store.assetScenes.length },
  { key: 'props', label: '道具', count: store.props.length },
])

// ── 工具条三锚点重构（2026-09-17）──────────────────────────────────
// 规则：一条横条只允许「一个左锚点 + 一个右锚点」，组内按语义成簇、簇间用 1px 分隔。
//  ① 页面工具条：左=导航簇，右=生成配置簇（模型 + 画风）+ ⋯ 维护菜单
//  ② 提示条：内联提示条（非卡片），异常态下的唯一「重新提取资产」主入口
//  ③ 内容标题行：所有 tab 通用，消除切 tab 时的布局跳动
const showMoreMenu = ref(false)
const moreMenuRef = ref(null)

function onDocClickMore(e) {
  if (showMoreMenu.value && moreMenuRef.value && !moreMenuRef.value.contains(e.target)) {
    showMoreMenu.value = false
  }
}

// ⋯ 菜单里的重新提取资产：assetsStale 为 false 时的手动兜底入口，
// 有 stale 提示时走 ② 号条的橙色主按钮，保证同一动作只有一个主入口。
function onMoreExtract() {
  showMoreMenu.value = false
  if (store.aiLoading) return
  store.extractAssets()
}

// 画风在 /art 页显式选择，设定页只做回显 + 跳转入口（不在这里做下拉改画风，
// 因为换画风需要整条资产链路重跑，不是一次轻量切换）。
function goStylePage() {
  router.push('/art')
}

// ── 「还等着生成」的数量口径（2026-09-17）────────────────────────
// 标题行批量按钮已按布哥定案全删（缺图→成员卡「AI生成」单张出图；
// 整组重画→组卡组级入口），本函数现在只喂「N 个待生成图片」pill。
//
// 「还等着生成」的唯一口径：无图 且 当前不在生成中。
// 生成中的会被 store 跳过（见 batchGenerateAssetImages 里 targets 的过滤），
// 所以 pill 上的数字必须把它们减掉，否则显示 3 张实际只跑 2 张。
function countPending(list) {
  return list.filter((x) => !x.imageUrl && !store.generatingAssetIds.includes(x.id)).length
}

// 内容标题行数据：三个 tab 通用
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

// 查找某集角色对应的项目主设定使用集数（用于显示"项目库 · N 集共用"）
function projectCharUsage(item) {
  if (!item.linkedToProject) return null
  const master = store.projectCharacters.find((p) => p.id === item.projectCharacterId)
  if (!master) return null
  return { episodes: master.usageEpisodes || 1 }
}

onMounted(() => {
  // 剧本→画风的流程已迁移到独立画风步骤页（/art）：
  // 确认剧本后跳 /art 选择画风并显式提取，此处不再自动弹画风选择器
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

// Esc：先关 ⋯ 菜单，再退场景多选（与项目其它页面多选交互保持一致）
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

// 切换 tab 时退出场景多选，避免状态串到角色/道具 tab
watch(activeTab, (val) => {
  if (val !== 'scenes') exitSceneMultiSelect()
})

function goNext() {
  if (!store.scriptConfirmed) {
    showScriptConfirmDialog.value = true
    return
  }
  // 该集已有分镜则直接进入分镜页；「选择分镜方式」只在该集还没有任何分镜时弹出，
  // 避免生成过分镜后每次经过设定页都被要求重新 AI 分镜
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

// allowEmpty=true：删除流程可能把列表清空，显式告诉后端「这是用户确认过的删光」，
// 否则后端空列表护栏会 400 拒收（防误清库），删除最后一张卡会永远失败。
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

// AI 生成分镜
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

// 本地上传分镜脚本
function handleUploadStoryboard() {
  showImportDialog.value = true
}

async function handleImported() {
  showImportDialog.value = false
  showStoryboardMethodDialog.value = false

  // 导入组件保存成功后，这里再显式同步一次当前集，避免跳转到分镜页时仍显示旧方案。
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
    // 保存分镜到后端
    if (store.currentEpisodeId && data.scenes) {
      await api.saveStoryboard(store.currentEpisodeId, {
        storyboardScenes: data.scenes,
        storyboard_confirmed: false,
        storyboard_source: 'imported',
      })
      const reloadResult = await store.loadEpisode(store.currentEpisodeId)
      if (!reloadResult?.success) {
        // 刷新失败单独提示（别走 catch，否则会被误报成 JSON 解析失败）
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
  e.target.value = '' // 重置input
}
function openDialog(type) {
  dialogType.value = type
  showAddDialog.value = true
}

// 从素材库选择资产后添加到项目
async function handleLibrarySelect(payload) {
  // 兼容新旧格式：新格式 { items, type }，旧格式直接是数组
  const items = Array.isArray(payload) ? payload : (payload.items || [])
  const type = Array.isArray(payload) ? libraryPickerType.value : (payload.type || libraryPickerType.value)

  // 替换图片模式：用选中的第一个素材的封面图替换当前卡片图片
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

  // 添加新资产模式
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

// 2026-09-17：原 handleSettingAction 已移除——它唯一的作用是给工具条上那个
// 「重新提取资产」按钮分发动作。该入口已按三锚点规则收进 ⋯ 溢出菜单（onMoreExtract）
// 与 ② 号提示条主按钮，函数不再有调用方。

// 实际执行整卡删除：从列表摘除 → 全量保存 → 失败原位还原。
// 注意不能用 item.id 反查存活项：saveAssets 成功后会把后端自增 id
// 回写到存活的数组项上，此时旧 id 已是脱离列表的陈旧值（对不上任何一行）。
// 这里保留 item 对象引用，失败时原样插回，用户看到的就是「卡片回来了」。
async function performAssetDelete(type, id) {
  const config = assetCollections[type]
  if (!config) return
  const list = config.list()
  const index = list.findIndex((x) => x.id === id)
  if (index < 0) return
  const item = list[index]
  list.splice(index, 1)
  // silent：本条流程自带失败 toast（含还原说明），不再叠一层「保存失败」
  const ok = await saveAssets(type, { silent: true, allowEmpty: type === 'scene' })
  if (!ok) {
    // 保存失败 = 后端仍是旧数据。不回滚的话界面会显示「已删除」，
    // 但一刷新/切集卡片就复活（删除在感知上「没做完」）。故原样还原并明确告知。
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

  // 项目自有确认弹窗（不用原生 confirm：它会冻结渲染线程，失败态完全无反馈）。
  openConfirmDialog({
    title: `删除${label}${name ? `「${name}」` : ''}？`,
    message: `将永久删除该${label}及其图片，删除后无法恢复。`,
    confirmText: '删除',
    cancelText: '取消',
    danger: true,
    onConfirm: () => performAssetDelete(type, id),
  })
}

// ── 场景删除双选（2026-09-17 布哥需求）──────────────────────────────
// 删除入口给两个档位：「仅删图片」保留场景卡片与描述（清空后进「待生成」，可再补生成）；
// 「删除场景」永久删掉整个场景。无图场景没有「仅删图片」可选，直接走整卡删除确认。
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

// 仅删场景图：清空 imageUrl 并全量保存；失败时把原图地址还原，避免「看着删了、刷新复活」。
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

// ── 场景 tab · 多选与批量（2026-09-16）──────────────────────────────

// 正在生成的场景 id 视为「不可操作」：既不能选中，也不能被批量删除
function isSceneGenerating(item) {
  return store.generatingAssetIds.includes(item.id)
}

// 可选的场景 id（排除生成中）
const sceneSelectableIds = computed(() =>
  store.assetScenes.filter((s) => !isSceneGenerating(s)).map((s) => s.id),
)

// 是否「全选」（可选集合为空时不算全选）
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

// 点击卡片 / 勾选框：多选模式下切换选中态，否则打开详情
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

// 批量整卡删除：与单个删除同式——先摘除、全量保存、失败原位还原。
async function performBatchDeleteScenes(deletable) {
  const delSet = new Set(deletable)
  // 备份被删项与它们在原数组里的位置：保存失败要能原位还原（见下）。
  // 同 performAssetDelete：只需存位置，不能依赖 item.id 反查——saveAssets 会把后端自增 id
  // 回写到存活项上，删除项的 id 原地失效。
  const removed = store.assetScenes
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => delSet.has(s.id))
  store.assetScenes = store.assetScenes.filter((s) => !delSet.has(s.id))
  selectedSceneIds.value = selectedSceneIds.value.filter((id) => !delSet.has(id))
  // allowEmpty：全选删除时列表清空，显式告知后端这是用户确认过的删光（否则空列表护栏 400）
  const ok = await saveAssets('scene', { silent: true, allowEmpty: true })
  if (!ok) {
    // 保存失败 → 后端仍是旧数据，不回滚会让界面「看着删掉了」但刷新即复活。
    const restored = store.assetScenes.slice()
    for (const { s, i } of removed) restored.splice(Math.min(i, restored.length), 0, s)
    store.assetScenes = restored
    toastError('批量删除失败', { detail: '已还原被删除的场景，请重试' })
    return
  }
  toastSuccess(`已删除 ${deletable.length} 个场景`)
  if (!store.assetScenes.length) exitSceneMultiSelect()
}

// 批量仅删图片：保留场景卡片，只清空 imageUrl；失败逐张还原原图地址。
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

// 批量删除入口：生成中的项一律跳过（后端可能正在回写该资产，删除会造成数据不一致）。
// 与单个删除同规则：选中项里有图时给「仅删图片 / 删除场景」双选，全都没图则只确认整卡删除。
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

// ── 批量生成场景图（2026-09-17 布哥定案：标题行批量按钮全删）─────────
// 原有「补生成缺图 / 全部重做」两档批量入口已删除——
//   · 缺图场景 → 成员卡「AI生成」单张出图（每张卡都有按钮，批量补图多余）；
//   · 整组重画 → 组卡「整组照参考图重画」（批量入口在组级，语义才对位）；
//   · 集级批量重做与组卡功能重复（单基准组场景下 100% 等价），删。
// sceneBatchGenerating 保留：它还是组重画（doRefreshGroup）的防重锁，
// 也让「多选」按钮在组重画进行中不可误触。
// pending 组的批量兜底随按钮一并消失——锁定态（isGroupPending）仍在，
// 单张出图入口被锁就是锁，没有批量通道可以绕过它。

// ── 场景 tab · 空间组视图（2026-09-17）──────────────────────────────
// 星型拓扑落地页：组分区（SpatialGroupCard：参考图大卡 + 轨道）× 组内成员卡（SceneMemberCard）。
// 数据源 = /generate/spatial-group-review/status，组状态与锁定态（isGroupPending）同源。
// 降级铁律：接口失败 → sceneGroupsError → 整页回退旧平铺卡片视图，功能一个不少。
const sceneGroups = ref([])         // status.groups：组分区数据
const sceneReviewPending = ref(0)   // status.pending：未决组数（横幅计数）
const sceneGroupsError = ref(false) // true = 降级回旧平铺视图
const sceneGroupsLoading = ref(false)
const groupBusyKey = ref('')        // 正在决策/重画的组 key（组头显示「处理中」）
// 布局图生成中的组 key（A3，2026-09-18）。与 groupBusyKey 分开：布局图只锁它自己那张卡，
// 不该把整组按钮（定参考图/整组重画）一起冻住——两件事互不依赖，锁一起是过度约束。
const layoutBusyKey = ref('')
let sceneGroupRefreshTimer = null   // 生成结束/资产增删后的防抖刷新

async function fetchSceneGroups(force = false) {
  if (!store.currentEpisodeId) return
  if (sceneGroupsLoading.value && !force) return
  sceneGroupsLoading.value = true
  try {
    const status = await api.getSpatialGroupReviewStatus(store.currentEpisodeId)
    sceneGroups.value = Array.isArray(status?.groups) ? status.groups : []
    sceneReviewPending.value = Number(status?.pending) || 0
    sceneGroupsError.value = false
    // 组数据到位后拉参考图版本带（组数有限，且已加载过的会跳过，不会反复打接口）
    for (const g of sceneGroups.value) loadBaselineHistory(g)
    // 分组锁状态与组数据同源刷新（重析后锁的归属可能变化，孤儿锚检测也依赖最新归属）
    fetchGroupLocks()
  } catch (e) {
    // 降级铁律：视图可以没有，场景页不能卡死——回退旧平铺视图，生图/多选/删除照常可用
    if (!sceneGroupsError.value) {
      toastInfo('空间组视图加载失败，已切换为平铺模式', { detail: String(e.message) })
    }
    sceneGroupsError.value = true
  } finally {
    sceneGroupsLoading.value = false
  }
}

// ── 参考图版本历史（2026-09-17 布哥："留历史记录参照对比"）──────────────
// 复用后端既有能力：asset_image_history 表 + GET /generate/asset-image/history
// （资产详情弹窗里已在用，组视图此前没接）。代表场的每次生成/改造都会自动入历史。
//
// 按 repSceneId 缓存：组卡按需（展开且未加载过）触发，避免一屏多组时并发打接口。
const baselineHistoryMap = ref({})    // repSceneId -> [{id,image_url,is_current,...}]
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
// 生成结束/组数据刷新后，已加载过的组重新拉一次（新版本要立刻出现在带子里）
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

// ── 分组人审锁定（2026-09-17）────────────────────────────────────────
// 背景：spatial_group 由 LLM 逐次自由裁量，重析（改剧本、加删场景、force）会重新分组。
// 实测同一剧本连析两次，4 组被并成 2 组 → 已确认的组锚变孤儿、人审基线静默失效。
// 修法：把「某场归某组」固化成数据（后端 scene_group_locks 表），重析时已锁场景复用锁定组名。
//
// 前端职责只有两件：把锁的状态显示出来、给个切锁的入口。分组逻辑一律在后端。
// 判定逻辑（哪些组算已锁 / 孤儿锚该挂到哪张卡）全部下沉到 src/utils/groupLockView.js——
// 纯函数、零 Vue 依赖，因此能被 server/tests 直接 import 做用例，不靠肉眼看界面。
// 降级铁律：/locks 接口失败 → locksOverview 保持空 → 卡片不显示锁定徽章与孤儿告警，
//   但「重析/生成」等主流程一个不少（锁是保护，不是功能前置条件）。
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
    // 静默降级：锁状态拿不到不影响出图（它只是"保护可见性"，不是功能依赖）
    locksOverview.value = { locks: [], orphanAnchors: [] }
  }
}

// 切锁：组内还有未锁成员 → 先把**当前**分组整体锁住；已全锁 → 只解这一组的成员。
// 为什么按组而不是按全集：用户的心智单位是"这一组"，不是"全部"。
// 服务端按「当前 scene_analysis 的实际归属」落锁，前端不传组名（避免前端算错覆盖真值）。
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
      // 锁整集（服务端按当前归属落锁，幂等）——只锁这一组的成员做不到"锁住组结构"：
      // 组结构是全集划分的结果，只锁部分成员会让 LLM 在剩余场次里重新划出边界。
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

// 汇总条上的「重新锁定分组」：漂移已发生后的一键兜底。
// 与组卡上那颗按钮不重复：组卡是"预防/微调"（按组），这里是"事故后收口"（按全集）。
// 漂移发生后用户未必找得到是哪一组出的事，所以给一个不挑目标的出口。
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

// 换回某个旧版本当参考图：把该版本的图写回代表场当前图 + 重新定参考图。
// 不做"只改 baseline 不动 scenes"——参考图与代表场定稿图必须一致，
// 否则组卡显示的和场景卡显示的会是两张不同的图（正是本轮要消灭的错位）。
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
        await store.loadEpisode(store.currentEpisodeId)   // 代表场图更新 → 组卡/成员卡同步
        await api.decideSpatialGroupReview({ episodeId: store.currentEpisodeId, group: group.group, action: 'confirm' })
        toastSuccess('已换回该版本并设为参考图')
      } catch (e) {
        toastError('换版本失败', { detail: String(e.message) })
      } finally {
        groupBusyKey.value = ''
        await fetchSceneGroups(true)
        invalidateAndReloadHistory(group.repSceneId)   // is_current 归属变了，带子重拉
      }
    },
  })
}

// 成员 id → store 资产对象。memberScenes 与 assetScenes 同源于 DB，正常必然匹配；
// 兜底合成对象只保证渲染不炸，动作 handler 里仍以 sceneById 找得到为准。
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

// 组没定参考图 → 组内成员锁定（只锁 pending 组；多选模式下解锁，保证批量删除/
// 全选不被组状态绑架——锁定只管生成，不管删除）
// 成员卡是否锁死生成：仅"多场景组 + 还没定参考图"才锁。
// 单场景组永远不锁——它不需要参考图（后端 sync 恒置 skipped），锁定只会逼用户
// 去点一个点了图也不变的按钮（2026-09-17 修正）。前端这里再兜一层，
// 防后端旧进程/降级数据把单场景组算成 pending 时又把成员卡锁上。
function isGroupPending(group) {
  if ((group?.memberScenes?.length || 0) <= 1) return false
  return group?.status === 'pending'
}

// 「全部收起 / 展开」：一次点击把所有组容器收成标题行（组多时一屏扫览）。
// 用受控 prop 下发而非遍历子组件实例——v-for + 降级分支下实例拿不稳，
// 而"全部"的判断依据（有几组、当前是否全收）本来就只有父级知道。
// forceToken 每次点击 +1：让 prop 值变化必然触发子组件 watch（连点两次"收起全部"
// 时 boolean 值不变，光靠值本身传不下去）。
const allGroupsCollapsed = ref(false)
const forceCollapseToken = ref(0)
const forceCollapsedValue = ref(null)
function toggleAllGroups() {
  allGroupsCollapsed.value = !allGroupsCollapsed.value
  forceCollapsedValue.value = allGroupsCollapsed.value
  forceCollapseToken.value += 1
}

// LLM 没归组的场景（新加的、老数据）：平铺兜底区，不做空间约束
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

// 成员卡动作统一分发：memberScenes 的 id 与 store 对不上（刚删除/换集瞬间）时兜底刷新
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

// 组级：定参考图（decide confirm，幂等——confirmed 组「就用这张当参考图」走同一出口）。
// 服务端一律取代表场当前定稿图，不采信前端传图（KD5），所以前端只传组键。
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

// 组级：重画参考图（= 重出代表场定稿图，画完**自动定为参考图**）。
//
// 2026-09-17 布哥反馈：「重画一张，应该是参考图重画啊？」+「留历史记录参照对比」。
// 旧行为是两步：点「重新画一张」→ 场景图变了但参考图还指着旧图 → 必须再点一次
// 「就用这张当参考图」。症状是"点了重画，左边的图没变"，用户以为没画成功。
// 根因：assets 图的生成流程只写 scenes.image_url，不碰 spatial_group_review.baseline_image_url。
//
// 所以这里生成成功后立刻补一次 decide confirm（服务端一律取代表场当前定稿图，天然幂等），
// 让参考图与新图对齐——一步到位，不再需要第二颗按钮。
// 历史对比：生成本身已自动写入 asset_image_history（后端既有能力），
// 组视图下方新增版本带消费它，见 loadBaselineHistory。
async function regenBaseline(group) {
  const rep = sceneById(group.repSceneId)
  if (!rep) {
    toastWarn('找不到代表场景', { detail: '该场景可能已被删除，请重新提取资产' })
    return
  }
  const run = async () => {
    const res = await store.generateAssetImage('scene', rep.id, genDesc(rep), store.imageModel)
    if (!res?.success) return
    // 画完即定：让参考图跟上新图（幂等，服务端按当前定稿图落库）
    try {
      await api.decideSpatialGroupReview({ episodeId: store.currentEpisodeId, group: group.group, action: 'confirm' })
      toastSuccess('已重画并设为参考图', { detail: '组内其它场景可照这张重画；旧版本已存入下方版本带' })
    } catch (e) {
      // 图已画好、只是没定上：不吞错，提示用户手动补定（组卡上仍有「就用这张当参考图」）
      toastWarn('图已重画，但设为参考图失败', { detail: `${e.message}；可点「就用这张当参考图」重试` })
    }
    await fetchSceneGroups(true)
    // 新版本要立刻出现在版本带里（fetchSceneGroups 只拉组数据，历史需单独重拉）
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

// 组级：整组照参考图重画（覆盖式 + 计费 → 二次确认；ids 定向走 batchGenerateAssetImages，
// 组内串行链由 store 按 spatial_group 自动排队）。复用 sceneBatchGenerating 做防重复锁，
// 反馈在组卡自身（busy 态），进度不占标题行。
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

// 组级：跳过定参考图（decide skip，幂等）——这组场景不做空间约束、自由出图；
// 跳过后随时可回来「就用这张当参考图」（skipped 组与 pending 组同款按钮）。
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

// ── 布局示意图（A3，2026-09-18）──────────────────────────────────────────────
// 布局图 = 只表达「什么在哪、朝哪、多远」的俯视示意图，不含视角/光影/画风。
// 它解决的是一个结构性矛盾：参考图是**照片**，同时携带视角/光影/画风/主体占比，
// 让模型"继承它、但别照搬构图"天然自相矛盾（cliff_river 视角塌陷、
// 「场2 被场1 覆盖重画」两次事故都长在这块土壤上）。
// 有了布局图，组内每个视角都能照它对齐空间而不冲突。
//
// 重画是覆盖式 + 计费（与参考图重画同规则）→ 已有图时二次确认；
// 首次生成没有"覆盖"可损失，直接跑（不拿确认框骚扰用户）。
function generateLayout(group) {
  if (layoutBusyKey.value) return
  const run = () => doGenerateLayout(group)
  if (group.layoutAnchor?.imageUrl) {
    // 过时的图，确认框里要说明"为什么现在该重画"——否则用户看到一句"若没改动静通常不用重画"
    // 反而更犹豫。过时是客观事实（素材指纹不一致），直接讲清楚比让用户自己回忆更好。
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
    // 质检回执：服务端含"生成→视觉质检→仅对检出问题针对性重试"闭环。
    // 带伤上岗是我们接受的（宁可有一张略有瑕疵的图，也不要卡住流程），
    // 但必须让用户知道"这张没过质检"，否则他会拿一张有问题的图当权威空间基准。
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

// 看大图：布局图信息密度高（多个地标 + 朝向关系），小卡里看不清。
// 不做站内 lightbox —— 新标签页能让用户用浏览器原生缩放，对他们更顺手。
// noopener：新窗口拿不到 window.opener，避免被打开的页面反向操纵本页。
function previewLayout(layoutAnchor) {
  const url = layoutAnchor?.imageUrl
  if (!url) return
  window.open(url, '_blank', 'noopener')
}

// 去定参考图（横幅按钮）：弹窗退役后决策动作全在组卡上——滚动定位到第一个未决组卡并高亮。
// 找不到（都在视口外渲染层）时退化为直接刷新组数据。
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

// 场景 tab 打开时拉取（首次可能触发 LLM 全集分析，最长两分钟；降级后不再自动重试）
watch(activeTab, (val) => {
  if (val === 'scenes' && !sceneGroups.value.length && !sceneGroupsError.value) fetchSceneGroups()
})

// 换集：组数据清空重拉（不同集的空间组完全不同）
watch(() => store.currentEpisodeId, () => {
  sceneGroups.value = []
  sceneReviewPending.value = 0
  locksOverview.value = { locks: [], orphanAnchors: [] }   // 不同集的空间组与锁完全不同，不能串
  if (activeTab.value === 'scenes') fetchSceneGroups()
})

// 生成结束 / 场景增删 → 组图、成员图、分组归属都可能变化，防抖合并成一次刷新
function scheduleSceneGroupsRefresh() {
  if (activeTab.value !== 'scenes' || sceneGroupsError.value) return
  clearTimeout(sceneGroupRefreshTimer)
  sceneGroupRefreshTimer = setTimeout(async () => {
    await fetchSceneGroups(true)
    // 成员卡单张生成也会给代表场加版本（若生成的就是代表场）→ 带子跟着刷新
    reloadLoadedBaselineHistories()
  }, 800)
}
watch(() => store.generatingAssetIds.length, (len, old) => {
  if (old > len) scheduleSceneGroupsRefresh() // 有生成结束（含取消）→ 参考图卡/成员图可能已更新
})
watch(() => store.assetScenes.length, () => {
  if (sceneGroups.value.length) scheduleSceneGroupsRefresh() // 新增/删除场景 → 分组归属变化
})
onBeforeUnmount(() => clearTimeout(sceneGroupRefreshTimer))

// 触发音频文件选择
function handleAudioUpload(item) {
  audioUploadTarget.value = item
  audioFileInput.value?.click()
}

// 音色参考的合理上限：H3 音色克隆只需几秒样本，且 base64 再膨胀 33%
const AUDIO_MAX_BYTES = 10 * 1024 * 1024
const AUDIO_EXT_RE = /\.(mp3|wav|m4a|aac|ogg|flac|webm)$/i

// 处理音频文件选择
async function onAudioFileSelected(e) {
  const file = e.target.files?.[0]
  if (!file || !audioUploadTarget.value) return

  // 类型白名单：accept 只过滤文件选择对话框，拖放/改后缀可绕过
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
    // 转成 base64
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
        // 用后端返回的数据更新 store 中的角色
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

// 删除角色音频
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

// 打开资产详情编辑弹窗
function openDetail(type, item) {
  detailType.value = type
  detailAsset.value = item
  showDetailDialog.value = true
}

// 保存资产详情修改
async function saveDetail(data) {
  const type = detailType.value
  const oldId = detailAsset.value.id
  const hasImage = !!detailAsset.value.imageUrl
  // 更新 store
  // 英文常量透传（2026-09-16）：`data` 里带了 nameEn/descriptionEn/titleEn/summaryEn/
  // lightingEn（AssetDetailDialog 采集），此前这里只写中文 name/description，
  // 英文键被静默丢弃 → 用户改了英文名再保存会「改了个寂寞」。
  // 用 `!== undefined` 判据：详情弹窗对不相关类型不传该键，不能拿 undefined 覆盖掉已有值。
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
      // 场景光影常量：详情弹窗保存（undefined = 非 scene 类型，不动）
      if (data.lightingEn !== undefined) s.lightingEn = data.lightingEn
      // 场景英文标题/摘要：模块3 环境冻结声明逐字复用，同样必须能改能存
      if (data.titleEn !== undefined) s.titleEn = data.titleEn
      if (data.summaryEn !== undefined) s.summaryEn = data.summaryEn
      // 场景地点（scenes.location）：undefined = 非 scene 类型，不动
      if (data.location !== undefined) s.location = data.location
    }
  } else if (type === 'prop') {
    const p = store.props.find(x => x.id === oldId)
    if (p) {
      p.name = data.name
      p.description = data.description
      // 道具英文名（props.name_en）：H3 全英文提示词的必填生产资产
      if (data.nameEn !== undefined) p.nameEn = data.nameEn
      // 道具英文描述（props.description_en）：H3 模块2「道具描述」逐字复用
      if (data.descriptionEn !== undefined) p.descriptionEn = data.descriptionEn
      // owner 有意不在此处兜底（2026-09-16 布哥决定）：留空优于猜错，
      // 填错会在 doubao.js 生成「专属角色」硬约束并主动判正确画面为违规。
      if (data.owner !== undefined) p.owner = data.owner
    }
  }
  await saveAssets(type)
  showDetailDialog.value = false

  // 保存后重新获取最新 ID（新建资产保存后 ID 会从临时 ID 更新为数据库自增 ID）
  const list = type === 'character' ? store.characters : type === 'scene' ? store.assetScenes : store.props
  const updated = list.find(x => x.name === data.name)
  const latestId = updated?.id || oldId

  // 只有当资产没有图片时，才自动调用 AI 生图
  // 已有图片（用户上传或之前生成）时，只保存描述，不覆盖已有图片
  // 用户想根据新描述重新生成时，可手动点击卡片上的"AI生成"按钮
  console.log('[saveDetail] type:', type, 'hasImage:', hasImage, 'latestId:', latestId)
  if (!hasImage && data.description && data.description.trim()) {
    const prompt = genDesc({ name: data.name, description: data.description })
    setTimeout(() => {
      store.generateAssetImage(type, latestId, prompt, store.imageModel)
    }, 300)
  }
}

// 点击卡片"本地上传"→ 打开素材库（替换模式）：上传完成后新图自动替换当前卡片图片，
// 图片同时已存入"我的素材"成为可复用的固定资产；也可改为从库中选已有素材替换
function handleLocalUpload(type, item) {
  replaceMode.value = true
  replaceTarget.value = { type, id: item.id }
  libraryPickerType.value = type
  showLibraryPicker.value = true
}

// 打开自定义确认弹窗。
// altConfirmText + onAltConfirm = 可选的「次选项」按钮（如删除场景时的「仅删图片」）；
// danger = true 时图标与主按钮走 danger 红，把破坏性操作和生成类确认在视觉上区分开。
function openConfirmDialog({ title, message, confirmText = '确认', altConfirmText = '', cancelText = '取消', danger = false, onConfirm, onAltConfirm = null }) {
  confirmConfig.value = { title, message, confirmText, altConfirmText, cancelText, danger, onConfirm, onAltConfirm }
  showConfirmDialog.value = true
}

// 确认弹窗：点击确认
function handleConfirmOk() {
  showConfirmDialog.value = false
  if (confirmConfig.value.onConfirm) {
    confirmConfig.value.onConfirm()
  }
}

// 确认弹窗：点击次选项（如「仅删图片」）
function handleConfirmAlt() {
  showConfirmDialog.value = false
  if (confirmConfig.value.onAltConfirm) {
    confirmConfig.value.onAltConfirm()
  }
}

// 确认弹窗：点击取消
function handleConfirmCancel() {
  showConfirmDialog.value = false
}

// 手动点击"AI生成"：如果已有图片，先确认再生成，避免误覆盖用户上传的图片
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

// 以当前图为底图改造（换装/加饰品/微调）：图生图保持形象，只按指令修改指定部分。
// 成功后自动把改造内容追加进描述——保证分镜 prompt 文字与参考图始终一致（图文不打架）。
async function handleEditAsset(type, item) {
  if (!item.imageUrl) {
    toastWarn(`「${item.name}」还没有图片，无法改造`, { detail: '请先「AI生成」一张基础形象图' })
    return
  }
  const instruction = (window.prompt(`要在「${item.name}」这个形象上改什么？\n例：戴一条红色针织围巾 / 背一个棕色小书包 / 换成冬季厚披风`) || '').trim()
  if (!instruction) return
  const res = await store.generateAssetImage(type, item.id, genDesc(item), store.imageModel, instruction)
  if (res?.success) {
    // 描述已由后端同步进主设定（含指令追加），这里只把 store 对象对齐为后端返回值，不再手工拼接防重复
    const list = type === 'character' ? store.characters : type === 'scene' ? store.assetScenes : store.props
    const target = list.find(x => String(x.id) === String(item.id))
    if (target && res.description) {
      target.description = res.description
      await saveAssets(type, { silent: true })
    }
  }
}

// 统一资产卡片的生成图片描述
function genDesc(item) { return item.name + '：' + (item.description || '') }
</script>

<template>
  <div class="flex h-full w-full flex-col">
    <!-- ① 页面工具条 · 左锚点 = 导航簇 / 右锚点 = 生成配置簇 + 低频维护 -->
    <div class="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border px-6">
      <!-- 左锚点：返回 + 角色 / 场景 / 道具 -->
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

      <!-- 右锚点：生成配置簇（模型 + 画风）│ 维护 -->
      <div class="flex min-w-0 items-center gap-2">
        <!-- 生图模型：全局选择，整批资产生图统一走该模型。前列均为支持「以图生图」的模型
             （资产图/分镜图全链路带参考图：角色图 + 场景图 + 道具图 + 画风锚）；
             末项「四宫格通道（文生图）」仅用于分镜四宫格（RunningHub AI 应用，4 槽参考池），
             不是通用生图模型——资产图/分镜图请选上方模型。 -->
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

        <!-- 画风胶囊：与模型对仗（同为全局生成参数），点击去画风页更换 -->
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

        <!-- 簇间分隔：把「可改的配置」与「低频维护」切开 -->
        <span class="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden="true"></span>

        <!-- AI 处理中：提取资产要等大模型十几秒以上，必须有可见反馈；紧邻触发入口，不挤压配置簇 -->
        <span v-if="store.aiLoading" class="flex min-w-0 items-center gap-1.5 text-2xs text-warn">
          <svg class="h-3.5 w-3.5 shrink-0 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
          <span class="truncate">{{ store.aiProgressMessage || 'AI 处理中…' }}</span>
        </span>

        <!-- ⋯ 溢出菜单：收纳低频维护动作，常态下不抢视线 -->
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
    <!-- ② 剧本已改提示条 · 内联提示条（非卡片）：异常态下「重新提取资产」的唯一主入口 -->
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
    <!-- ③ 内容标题行 · 所有 tab 通用（消除切 tab 时的布局跳动）
         左锚点 = 内容标识（标题 + 计数）；右锚点 = 内容级操作，按「模式 → 破坏性 → 主操作」排列 -->
    <div class="flex shrink-0 items-center justify-between gap-3 px-6 pt-5 pb-3">
      <div class="flex min-w-0 items-center gap-2.5">
        <h2 class="shrink-0 text-sm font-medium text-text-primary">{{ tabMeta.title }}</h2>
        <!-- 多选模式：计数让位给「已选 N / M」，避免两组数字打架 -->
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
        <!-- 多选模式 -->
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

        <!-- 常规模式：标题行只留「多选」。
             2026-09-17 布哥定案：批量生成按钮全删——
             · 缺图场景 → 成员卡「AI生成」单张出图（每张卡都有按钮，批量补图多余）；
             · 整组重画 → 组卡「整组照参考图重画」（批量入口在组级，语义才对位）；
             · 集级批量重做按钮与组卡功能重复，删（单 confirmed 组场景下 100% 等价）。 -->
        <template v-else>
          <!-- 全部收起 / 展开（仅场景 tab 的组视图有意义：组多时一键扫览） -->
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
          <!-- 幽灵按钮：模式切换 -->
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
    <!-- 卡片容器：标题行已负责上方留白，这里不再重复 padding-top，让标题与网格成为一个整体 -->
    <div class="flex flex-1 flex-wrap content-start gap-4 overflow-y-auto px-6 pb-6 pt-0">
    <!-- 角色卡片 -->
    <template v-if="activeTab==='characters'">
      <div v-for="item in store.characters" :key="item.id" class="group flex w-64 cursor-pointer flex-col overflow-hidden rounded-xl border border-border bg-bg-card transition hover:border-accent/30" @click="openDetail('character', item)">
        <div class="relative h-40 overflow-hidden bg-white">
          <img v-if="item.imageUrl" :src="item.imageUrl" :alt="item.name" class="h-full w-full object-cover" />
          <div v-else class="flex h-full items-center justify-center">
            <svg class="h-10 w-10 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
          </div>
          <!-- 生成中覆盖层 -->
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
        <!-- 底部音频上传/播放（移到描述下方） -->
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

        <!-- 场景 tab：场景组视图（星型拓扑：参考图 → 组内照着画）。
             降级铁律：status 接口失败 → 回退旧平铺卡片视图，生图/多选/批量/删除功能一个不少 -->
        <template v-else-if="activeTab==='scenes'">
          <!-- 降级路径：旧平铺卡片（原样保留全部行为） -->
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
              <!-- 多选勾选框（点击由卡片统一处理，此处 pointer-events-none 避免重复触发） -->
              <div v-if="sceneMultiSelect"
                   class="pointer-events-none absolute left-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-md border transition"
                   :class="[isSceneSelected(item) ? 'border-accent bg-accent' : 'border-white/70 bg-black/50 backdrop-blur', isSceneGenerating(item) ? 'opacity-40' : '']">
                <svg v-if="isSceneSelected(item)" class="h-3.5 w-3.5 text-black" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" /></svg>
              </div>
              <!-- 生成中覆盖层 -->
              <div v-if="store.generatingAssetIds.includes(item.id)" class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 backdrop-blur-sm">
                <svg class="h-8 w-8 animate-spin text-accent" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
                <span class="text-xs text-white">AI生成中...</span>
                <button class="rounded bg-white/15 px-2.5 py-0.5 text-[10px] text-white transition hover:bg-red-500" @click.stop="store.cancelAssetImageGen(item.id)">取消</button>
              </div>
              <!-- 多选模式下隐藏单张删除按钮与操作栏，避免误操作；删除入口走双选弹窗（仅删图片 / 删除场景） -->
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

          <!-- 组视图路径 -->
          <template v-else>
            <!-- 首载分析中：status 首次可能触发 LLM 全集分析（最长两分钟），必须有可见反馈 -->
            <div v-if="sceneGroupsLoading && !sceneGroups.length" class="flex h-[300px] w-full flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border">
              <svg class="h-8 w-8 animate-spin text-warn" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
              <div class="text-2xs text-text-secondary">正在分析场景空间关系…</div>
              <div class="text-micro text-text-muted">首次分析约需十几秒到两分钟，完成后场景按空间组呈现</div>
            </div>

            <template v-else>
              <!-- 基准失效汇总条（2026-09-17）：只要有任何一组的组锚成了孤儿，就在顶部显式告警。
                   为什么要有汇总：孤儿锚的卡片上虽然也有 banner，但漂移后组名可能已变，
                   用户扫一眼列表未必找得到"是哪个组出事了"。汇总条 + 一键重新锁定是兜底出口。
                   无孤儿时整块不渲染（不占位、不噪音）。 -->
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

              <!-- 未决提示条：还有组没定参考图（弹窗退役后，决策动作收口在组卡上） -->
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

              <!-- 组分区：参考图大卡（左） + 轨道 + 成员卡（右） -->
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

              <!-- 未分组场景：LLM 没归组的（新增的/老数据），平铺兜底，不做空间约束 -->
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

              <!-- 空态：没有任何场景 -->
              <div v-if="!sceneGroups.length && !ungroupedScenes.length" class="flex h-[300px] w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border">
                <span class="text-2xs text-text-secondary">暂无场景</span>
                <span class="text-micro text-text-muted">点下方「添加场景」，或剧本确认后重新提取资产</span>
              </div>
            </template>
          </template>
        </template>

        <!-- 道具卡片（同布局） -->
        <template v-else>
          <div v-for="item in store.props" :key="item.id" class="group flex w-64 cursor-pointer flex-col overflow-hidden rounded-xl border border-border bg-bg-card transition hover:border-accent/30" @click="openDetail('prop', item)">
            <div class="relative h-40 overflow-hidden bg-white">
              <img v-if="item.imageUrl" :src="item.imageUrl" :alt="item.name" class="h-full w-full object-cover" />
              <div v-else class="flex h-full items-center justify-center">
                <svg class="h-10 w-10 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
              </div>
              <!-- 生成中覆盖层 -->
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

        <!-- 添加卡片按钮（场景多选模式下隐藏，避免与批量选择混淆）。
             场景组视图形态下用通栏细条——与 w-full 组分区对仗，不再垫一块 340px 的大空卡 -->
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

    <!-- 底部进入下一步 -->
    <div class="flex shrink-0 justify-center border-t border-border py-4">
      <!-- AI 处理中禁用：资产提取未完成时跳走会带着旧数据进下一步 -->
      <button :disabled="store.aiLoading" class="flex items-center gap-2 rounded-xl bg-accent px-8 py-2.5 text-sm font-medium text-black transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50" @click="goNext">
        <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" /></svg>
        {{ store.aiLoading ? '资产处理中...' : '进入下一步' }}
      </button>
    </div>

    <!-- 全局隐藏的音频文件 input（角色音频上传用） -->
    <input ref="audioFileInput" type="file" accept="audio/*" class="hidden" @change="onAudioFileSelected" />

    <AssetFormDialog v-model="showAddDialog" :type="dialogType" :project-id="store.currentProjectId" @create="handleCreate" @select="handleSelect" />
    <LibraryAssetPicker v-model="showLibraryPicker" :type="libraryPickerType" :project-id="store.currentProjectId" :auto-use-on-upload="replaceMode" @select="handleLibrarySelect" />
    <AssetDetailDialog :visible="showDetailDialog" :asset="detailAsset" :type="detailType" @close="showDetailDialog=false" @save="saveDetail" />

    <!-- 剧本未确认提示弹窗 -->
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

    <!-- 分镜方式选择弹窗 -->
    <div v-if="showStoryboardMethodDialog" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" @click.self="showStoryboardMethodDialog=false">
      <div class="w-[480px] overflow-hidden rounded-2xl border border-border bg-bg-card shadow-2xl">
        <div class="border-b border-border p-5">
          <h3 class="text-base font-medium text-white">选择分镜方式</h3>
          <p class="mt-1 text-xs text-text-secondary">可以使用 AI 自动生成分镜脚本，或上传已有的分镜脚本（txt / xlsx / docx）。</p>
        </div>
        <div class="p-5">
          <div class="grid grid-cols-2 gap-4">
            <!-- AI 分镜 -->
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

            <!-- 本地上传 -->
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

          <!-- 隐藏的文件 input -->
          <input ref="fileInputRef" type="file" accept=".json" class="hidden" @change="handleFileChange" />
        </div>
        <div class="border-t border-border p-4">
          <button class="w-full rounded-xl border border-border py-2.5 text-sm text-text-secondary transition hover:border-border-light hover:text-white" @click="showStoryboardMethodDialog=false">
            取消
          </button>
        </div>
      </div>
    </div>

    <!-- 通用分镜脚本导入弹窗 -->
    <ImportStoryboardDialog
      v-model="showImportDialog"
      :episode-id="store.currentEpisodeId"
      @imported="handleImported"
    />

    <!-- 自定义确认弹窗 -->
    <Teleport to="body">
      <Transition name="fade">
        <div v-if="showConfirmDialog" class="fixed inset-0 z-[9999] flex items-center justify-center">
          <!-- 遮罩层 -->
          <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" @click="handleConfirmCancel"></div>
          <!-- 弹窗卡片 -->
          <div class="relative w-[420px] max-w-[90vw] overflow-hidden rounded-2xl border border-border bg-bg-card shadow-2xl">
            <!-- 顶部装饰条 -->
            <div class="h-1 w-full bg-accent"></div>
            <!-- 内容区 -->
            <div class="p-6">
              <!-- 图标 + 标题（danger 弹窗用垃圾桶图标 + 红色，与生成类确认的闪电图标区分） -->
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
              <!-- 按钮区 -->
              <div class="mt-6 flex justify-end gap-3">
                <button
                  class="rounded-lg border border-border bg-transparent px-4 py-2 text-sm font-medium text-text-secondary transition hover:border-border-light hover:text-white"
                  @click="handleConfirmCancel"
                >
                  {{ confirmConfig.cancelText }}
                </button>
                <!-- 次选项：与主按钮并存的另一种删除档位（如「仅删图片」），描边红弱化一档 -->
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
/* 确认弹窗淡入淡出动画 */
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

/* 「去定参考图」横幅按钮：滚动定位到第一个未决组卡后的呼吸高亮（openGroupReview 加 class） */
@keyframes group-pulse-kf {
  0%, 100% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0); }
  25%, 75% { box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.35); }
}
.group-pulse {
  animation: group-pulse-kf 1.2s ease-in-out 2;
  border-radius: 10px;
}
</style>
