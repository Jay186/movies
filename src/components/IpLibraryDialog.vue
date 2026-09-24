<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { api } from '../services/api'
import { confirmDialog } from '../services/dialog'
import LibraryAssetPicker from './LibraryAssetPicker.vue'

const emit = defineEmits(['close'])

const list = ref([])
const projects = ref([])
const loading = ref(true)
const saving = ref(false)
const errorMsg = ref('')
const toast = ref('')

const busyId = ref(null)
const busyLabel = ref('')

const expandedIds = ref(new Set())

const descRefs = new Map()
const overflowIds = ref(new Set())

function setDescRef(el, id) {
  if (el) descRefs.set(id, el)
  else descRefs.delete(id)
}

function isClamped(el) {
  const clampedHeight = el.clientHeight
  el.style.webkitLineClamp = 'unset'
  const fullHeight = el.scrollHeight
  el.style.removeProperty('-webkit-line-clamp')
  return fullHeight > clampedHeight + 2
}

function measureDescriptions() {
  const next = new Set(overflowIds.value)
  for (const [id, el] of descRefs) {
    if (!el || !el.isConnected) {
      descRefs.delete(id)
      continue
    }
    if (expandedIds.value.has(id)) continue
    if (isClamped(el)) next.add(id)
    else next.delete(id)
  }
  overflowIds.value = next
}


const applyPanelIpId = ref(null)
const applyPanelIp = computed(() => list.value.find((i) => i.id === applyPanelIpId.value) || null)
function openApplyPanel(ip) {
  applyPanelIpId.value = ip.id
}
function closeApplyPanel() {
  applyPanelIpId.value = null
}

const showCreate = ref(false)
const createForm = ref({ name: '', description: '' })
const editingId = ref(null)
const editForm = ref({ name: '', description: '' })

const audioInput = ref(null)
const audioTarget = ref(null)

const importProjectId = ref('')
const importList = ref([])
const importLoading = ref(false)

function flash(message) {
  toast.value = message
  setTimeout(() => { if (toast.value === message) toast.value = '' }, 3000)
}

let errorTimer = null
function setError(message) {
  errorMsg.value = message
  if (errorTimer) clearTimeout(errorTimer)
  errorTimer = setTimeout(() => {
    errorMsg.value = ''
    errorTimer = null
  }, 8000)
}
function clearError() {
  if (errorTimer) {
    clearTimeout(errorTimer)
    errorTimer = null
  }
  errorMsg.value = ''
}

async function loadIp() {
  loading.value = true
  clearError()
  try {
    list.value = await api.getIpCharacters()
    projects.value = await api.getIpProjectOptions()
  } catch (e) {
    setError(e.message || 'IP 角色库加载失败')
  } finally {
    loading.value = false
  }
  await nextTick()
  measureDescriptions()
}

onMounted(() => {
  loadIp()
  nextTick(measureDescriptions)
})
onUnmounted(() => {
  if (errorTimer) clearTimeout(errorTimer)
  descRefs.clear()
})

async function askConfirm({ title, message, confirmText = '确认', danger = false, onConfirm }) {
  const ok = await confirmDialog({
    title,
    description: message,
    confirmText,
    tone: danger ? 'danger' : 'normal',
  })
  if (ok && typeof onConfirm === 'function') onConfirm()
}

function toggleExpanded(id) {
  const next = new Set(expandedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedIds.value = next
}

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

async function createIp() {
  const name = createForm.value.name.trim()
  if (!name || saving.value) return
  saving.value = true
  try {
    await api.createIpCharacter({ name, description: createForm.value.description.trim() })
    createForm.value = { name: '', description: '' }
    showCreate.value = false
    flash(`已创建 IP 角色「${name}」`)
    await loadIp()
  } catch (e) {
    setError(e.message || '创建失败')
  } finally {
    saving.value = false
  }
}

function startEdit(ip) {
  editingId.value = ip.id
  editForm.value = { name: ip.name, description: ip.description || '' }
}

async function saveEdit() {
  if (saving.value) return
  saving.value = true
  busyId.value = editingId.value
  busyLabel.value = '保存中…'
  try {
    await api.updateIpCharacter(editingId.value, {
      name: editForm.value.name.trim(),
      description: editForm.value.description.trim(),
    })
    editingId.value = null
    flash('已保存')
    await loadIp()
  } catch (e) {
    setError(e.message || '保存失败')
  } finally {
    saving.value = false
    busyId.value = null
    busyLabel.value = ''
  }
}

const showImagePicker = ref(false)
const pickerTarget = ref(null)
function pickImage(ip) {
  pickerTarget.value = ip
  showImagePicker.value = true
}

async function onPickerSelect({ items }) {
  const item = items?.[0]
  const ip = pickerTarget.value
  if (!item?.cover_url || !ip) return
  showImagePicker.value = false
  saving.value = true
  busyId.value = ip.id
  busyLabel.value = '应用形象中…'
  try {
    await api.updateIpCharacter(ip.id, { image_url: item.cover_url })
    flash(`「${ip.name}」形象已更新`)
    await loadIp()
  } catch (e) {
    setError(e.message || '应用形象失败')
  } finally {
    saving.value = false
    busyId.value = null
    busyLabel.value = ''
    pickerTarget.value = null
  }
}

function pickAudio(ip) {
  audioTarget.value = ip
  if (audioInput.value) audioInput.value.value = ''
  audioInput.value?.click()
}

const AUDIO_MAX_BYTES = 10 * 1024 * 1024
const AUDIO_EXT_RE = /\.(mp3|wav|m4a|aac|ogg|flac|webm)$/i

async function onAudioPicked(event) {
  const file = event.target.files?.[0]
  if (!file || !audioTarget.value) return
  const isAudio = (file.type || '').startsWith('audio/') || AUDIO_EXT_RE.test(file.name)
  if (!isAudio) {
    setError('请选择音频文件（mp3/wav/m4a/aac/ogg/flac）')
    audioTarget.value = null
    event.target.value = ''
    return
  }
  if (file.size > AUDIO_MAX_BYTES) {
    setError(`音频文件不能超过 ${Math.round(AUDIO_MAX_BYTES / 1024 / 1024)}MB（音色参考只需几秒样本，请裁剪后上传）`)
    audioTarget.value = null
    event.target.value = ''
    return
  }
  saving.value = true
  busyId.value = audioTarget.value.id
  busyLabel.value = '上传音色中…'
  try {
    const base64 = await toBase64(file)
    await api.uploadIpAudio(audioTarget.value.id, base64)
    flash('音色已更新')
    await loadIp()
  } catch (e) {
    setError(e.message || '音色上传失败')
  } finally {
    saving.value = false
    busyId.value = null
    busyLabel.value = ''
    audioTarget.value = null
  }
}

function deleteAudio(ip) {
  if (saving.value) return
  askConfirm({
    title: '删除音色',
    message: `确定删除「${ip.name}」的音色吗？应用该 IP 后会一并覆盖到各项目。`,
    confirmText: '删除',
    danger: true,
    onConfirm: () => runDeleteAudio(ip),
  })
}

async function runDeleteAudio(ip) {
  saving.value = true
  busyId.value = ip.id
  busyLabel.value = '删除音色中…'
  try {
    await api.deleteIpAudio(ip.id)
    flash('音色已删除')
    await loadIp()
  } catch (e) {
    setError(e.message || '删除失败')
  } finally {
    saving.value = false
    busyId.value = null
    busyLabel.value = ''
  }
}

function askSyncProject(ip, pj) {
  if (saving.value) return
  askConfirm({
    title: `同步到「${pj.title}」`,
    message: `将把「${ip.name}」的形象、描述、音色覆盖到「${pj.title}」，该项目下所有集的同名角色都会同步更新。不可撤销。`,
    confirmText: '同步',
    danger: false,
    onConfirm: () => runApplyOne(ip, pj.projectId, pj.title, false),
  })
}

function diffLabel(pj) {
  if (!pj.diffFields?.length) return ''
  const map = { image: '形象', description: '描述', audio: '音色' }
  return pj.diffFields.map((f) => map[f] || f).join('、')
}

function askImportProject(ip, pj) {
  if (saving.value) return
  askConfirm({
    title: `引入到「${pj.title}」`,
    message: `「${pj.title}」中还没有「${ip.name}」，引入后将创建该角色并同步到其所有集。`,
    confirmText: '引入',
    danger: false,
    onConfirm: () => runApplyOne(ip, pj.projectId, pj.title, true),
  })
}

function askRemoveFromProject(ip, pj) {
  if (saving.value) return
  if (!pj.projectCharacterId) return
  askConfirm({
    title: '移除角色',
    message: `确定把「${ip.name}」从「${pj.title}」移除吗？该项目所有集的同名角色将解除与 IP 的关联，保留当前形象、不再跟随同步。之后可随时用「引入」加回来。`,
    confirmText: '确认移除',
    danger: true,
    onConfirm: () => runRemoveFromProject(ip, pj),
  })
}

async function runRemoveFromProject(ip, pj) {
  if (saving.value) return
  saving.value = true
  busyId.value = ip.id
  busyLabel.value = '移除中…'
  try {
    await api.deleteProjectCharacter(pj.projectCharacterId)
    closeApplyPanel()
    flash(`已把「${ip.name}」从「${pj.title}」移除`)
    await loadIp()
  } catch (e) {
    setError(e.message || '移除失败')
  } finally {
    saving.value = false
    busyId.value = null
    busyLabel.value = ''
  }
}

async function runApplyOne(ip, projectId, label, create) {
  if (saving.value) return
  saving.value = true
  busyId.value = ip.id
  busyLabel.value = create ? '引入中…' : '同步中…'
  try {
    const payload = create ? { projectId, create: true } : { projectId }
    const result = await api.applyIpCharacter(ip.id, payload)
    const rows = (result.results || [])
    const syncedRows = rows.reduce((sum, r) => sum + (r.syncedEpisodeRows || 0), 0)
    closeApplyPanel()
    if (rows[0] && rows[0].skipped === true) {
      flash(`「${label}」里还没有「${ip.name}」，已跳过。请先在该项目的设定页添加这个角色。`)
    } else {
      flash(create ? `已在「${label}」引入「${ip.name}」，同步 ${syncedRows} 处集角色` : `已同步到「${label}」，更新 ${syncedRows} 处集角色`)
    }
    await loadIp()
  } catch (e) {
    setError(e.message || (create ? '引入失败' : '同步失败'))
  } finally {
    saving.value = false
    busyId.value = null
    busyLabel.value = ''
  }
}

function removeIp(ip) {
  if (saving.value) return
  askConfirm({
    title: '移出 IP 库',
    message: `确定把「${ip.name}」移出 IP 角色库吗？将解除与「所有项目」的关联（各项目现有角色不受影响，但不再跟随 IP 同步）。`,
    confirmText: '移出',
    danger: true,
    onConfirm: () => runRemoveIp(ip),
  })
}

async function runRemoveIp(ip) {
  saving.value = true
  busyId.value = ip.id
  busyLabel.value = '移除中…'
  try {
    await api.deleteIpCharacter(ip.id)
    expandedIds.value.delete(ip.id)
    flash('已移除')
    await loadIp()
  } catch (e) {
    setError(e.message || '删除失败')
  } finally {
    saving.value = false
    busyId.value = null
    busyLabel.value = ''
  }
}

async function loadImportList() {
  if (!importProjectId.value) {
    importList.value = []
    return
  }
  importLoading.value = true
  try {
    importList.value = await api.getProjectCharacters(importProjectId.value)
  } catch (e) {
    setError(e.message || '项目角色加载失败')
  } finally {
    importLoading.value = false
  }
}

async function promote(pc) {
  if (saving.value) return
  saving.value = true
  busyId.value = `promote-${pc.id}`
  busyLabel.value = '提升中…'
  try {
    await api.promoteToIpCharacter(pc.id)
    flash(`「${pc.name}」已提升为 IP 角色`)
    await loadIp()
    await loadImportList()
  } catch (e) {
    setError(e.message || '提升失败')
  } finally {
    saving.value = false
    busyId.value = null
    busyLabel.value = ''
  }
}
</script>

<template>
  <div class="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-4" @click.self="emit('close')">
    <div class="flex max-h-[86vh] w-full max-w-5xl flex-col overflow-hidden border border-[#3c3c3c] bg-[#1b1b1d] shadow-2xl">
      <div class="flex shrink-0 items-center justify-between border-b border-[#303030] px-6 py-4">
        <div>
          <h2 class="text-base font-semibold text-white">IP 角色库</h2>
          <p class="mt-1 text-[11px] text-white/65">跨项目共用的角色源头设定。改这里再「应用到项目」，所有项目同名角色一次性对齐。</p>
        </div>
        <button class="text-white/40 transition hover:text-white" @click="emit('close')">×</button>
      </div>

      <div v-if="errorMsg" class="flex shrink-0 items-center gap-3 border-b border-red-400/30 bg-red-400/10 px-6 py-2 text-xs text-red-200">
        <span class="flex-1">{{ errorMsg }}</span>
        <button type="button" class="shrink-0 text-red-200/70 transition hover:text-red-100" title="关闭" @click="clearError">×</button>
      </div>
      <div v-if="toast" class="shrink-0 border-b border-[#c7ff00]/30 bg-[#c7ff00]/10 px-6 py-2 text-xs text-[#c7ff00]">{{ toast }}</div>

      <div class="flex shrink-0 flex-wrap items-center gap-3 border-b border-[#2a2a2a] px-6 py-3">
        <button class="bg-[#c7ff00] px-4 py-2 text-xs font-semibold text-black hover:bg-[#d8ff4a] disabled:opacity-50" :disabled="saving" @click="showCreate = !showCreate">新建 IP 角色</button>
        <div class="flex items-center gap-2">
          <span class="text-[11px] text-white/65">从项目导入</span>
          <select v-model="importProjectId" class="border border-[#404040] bg-[#151515] px-2 py-1.5 text-xs text-white outline-none" @change="loadImportList">
            <option value="">选择项目</option>
            <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.title }}</option>
          </select>
        </div>
        <span v-if="loading" class="text-[11px] text-white/65">加载中...</span>
      </div>

      <div v-if="showCreate" class="shrink-0 border-b border-[#2a2a2a] bg-[#171717] px-6 py-4">
        <div class="grid grid-cols-[180px_1fr_auto] items-start gap-3">
          <input v-model="createForm.name" class="border border-[#404040] bg-[#151515] px-3 py-2 text-xs text-white outline-none focus:border-[#c7ff00]" placeholder="角色名" />
          <textarea v-model="createForm.description" rows="2" class="resize-none border border-[#404040] bg-[#151515] px-3 py-2 text-xs text-white outline-none focus:border-[#c7ff00]" placeholder="外观描述：毛色、眼睛、配饰等，越具体生成越稳定" />
          <div class="flex gap-2">
            <button class="bg-[#c7ff00] px-4 py-2 text-xs font-semibold text-black disabled:opacity-50" :disabled="saving || !createForm.name.trim()" @click="createIp">创建</button>
            <button class="border border-[#444] px-3 py-2 text-xs text-white/60" @click="showCreate = false">取消</button>
          </div>
        </div>
      </div>

      <div v-if="importList.length" class="shrink-0 border-b border-[#2a2a2a] bg-[#171717] px-6 py-3">
        <div class="mb-2 text-[11px] text-white/65">该项目下的角色，点「提升」即可加入 IP 角色库</div>
        <div class="flex flex-wrap gap-2">
          <div v-for="pc in importList" :key="pc.id" class="flex items-center gap-2 border border-[#383838] bg-[#202020] px-3 py-1.5">
            <span class="text-xs text-white">{{ pc.name }}</span>
            <span class="text-[10px] text-white/60">{{ pc.usageEpisodes || 0 }} 集在用</span>
            <button class="border border-[#c7ff00] px-2 py-0.5 text-[10px] text-[#c7ff00] hover:bg-[#c7ff00]/10 disabled:opacity-50" :disabled="saving" @click="promote(pc)">{{ busyId === 'promote-' + pc.id ? busyLabel : '提升为 IP' }}</button>
          </div>
        </div>
      </div>

      <div class="flex-1 overflow-y-auto p-6">
        <div v-if="!loading && !errorMsg && !list.length" class="py-16 text-center text-sm text-white/60">IP 角色库还是空的。点上方「新建 IP 角色」，或用上方「从项目导入」把已有角色提升为 IP。</div>

        <div v-else class="grid grid-cols-2 gap-4 lg:grid-cols-3">
          <div v-for="ip in list" :key="ip.id" class="relative flex flex-col overflow-hidden border border-[#303030] bg-[#202020]">
            <div v-if="busyId === ip.id" class="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-black/60">
              <svg class="h-6 w-6 animate-spin text-white" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                <path class="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v3a5 5 0 00-5 5H4z" />
              </svg>
              <span class="text-[11px] text-white/80">{{ busyLabel }}</span>
            </div>

            <div class="relative h-36 bg-white">
              <img v-if="ip.imageUrl" :src="ip.imageUrl" :alt="ip.name" class="h-full w-full object-cover" />
              <div v-else class="flex h-full items-center justify-center text-[11px] text-gray-400">暂无形象</div>
            </div>

            <div class="flex-1 p-3">
              <template v-if="editingId === ip.id">
                <input v-model="editForm.name" class="mb-2 w-full border border-[#404040] bg-[#151515] px-2 py-1.5 text-xs text-white outline-none focus:border-[#c7ff00]" />
                <textarea v-model="editForm.description" rows="3" class="w-full resize-none border border-[#404040] bg-[#151515] px-2 py-1.5 text-xs text-white outline-none focus:border-[#c7ff00]" />
                <div class="mt-2 flex gap-2">
                  <button class="bg-[#c7ff00] px-3 py-1 text-[11px] font-semibold text-black disabled:opacity-50" :disabled="saving" @click="saveEdit">保存</button>
                  <button class="border border-[#444] px-3 py-1 text-[11px] text-white/60" @click="editingId = null">取消</button>
                </div>
              </template>
              <template v-else>
                <div class="flex items-center gap-2">
                  <span class="text-sm font-medium text-white">{{ ip.name }}</span>
                  <span class="rounded border border-[#c7ff00]/40 px-1.5 py-0.5 text-[10px] text-[#c7ff00]">{{ ip.usedByProjects }} 个项目在用</span>
                  <span v-if="ip.modifiedCount > 0" class="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-400">{{ ip.modifiedCount }} 个有改动</span>
                </div>
                <p
                  :ref="(el) => setDescRef(el, ip.id)"
                  class="mt-1.5 text-[11px] leading-relaxed text-white/70"
                  :class="[expandedIds.has(ip.id) ? 'max-h-[40vh] overflow-y-auto' : 'line-clamp-3', overflowIds.has(ip.id) ? 'cursor-pointer' : '']"
                  @click="overflowIds.has(ip.id) && toggleExpanded(ip.id)"
                >{{ ip.description || '（暂无描述）' }}</p>
                <button
                  v-if="overflowIds.has(ip.id)"
                  class="mt-1 text-[10px] text-[#c7ff00] hover:underline"
                  @click="toggleExpanded(ip.id)"
                >{{ expandedIds.has(ip.id) ? '收起' : '展开' }}</button>
              </template>
            </div>

            <div class="border-t border-[#303030] p-2">
              <div v-if="ip.audioUrl" class="flex items-center gap-2">
                <audio :src="ip.audioUrl" controls class="h-8 min-w-0 flex-1" />
                <button class="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-[#404040] text-white/70 hover:border-red-500 hover:text-red-400" title="删除音色" @click="deleteAudio(ip)">
                  <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                </button>
              </div>
              <button v-else class="w-full border border-[#404040] py-1.5 text-[11px] text-white/70 hover:border-[#c7ff00]/50 hover:text-white" @click="pickAudio(ip)">上传音色</button>
            </div>

            <div class="flex flex-wrap gap-1 border-t border-[#303030] p-2">
              <button class="border border-[#404040] px-2 py-1 text-[10px] text-white/70 hover:border-[#c7ff00]/50 hover:text-white disabled:opacity-50" :disabled="saving" @click="pickImage(ip)">换形象</button>
              <button class="border border-[#404040] px-2 py-1 text-[10px] text-white/70 hover:border-[#c7ff00]/50 hover:text-white disabled:opacity-50" :disabled="saving" @click="startEdit(ip)">编辑</button>
              <button class="border border-[#404040] px-2 py-1 text-[10px] text-white/70 hover:border-red-500 hover:text-red-400 disabled:opacity-50" title="移出 IP 库（解除与所有项目的关联）" :disabled="saving" @click="removeIp(ip)">移出库</button>
            </div>

            <div class="border-t border-[#303030] bg-[#1a1a1a] p-2">
              <button class="border border-[#383838] px-2 py-1 text-[10px] text-white/70 hover:border-[#c7ff00]/50 hover:text-white disabled:opacity-50" :disabled="saving" @click="openApplyPanel(ip)">应用到项目…</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <input ref="audioInput" type="file" accept="audio/*" class="hidden" @change="onAudioPicked" />

    <LibraryAssetPicker v-model="showImagePicker" type="character" @select="onPickerSelect" />
  </div>

  <div v-if="applyPanelIp" class="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4" @click.self="closeApplyPanel">
    <div class="flex max-h-[80vh] w-full max-w-md flex-col border border-[#3c3c3c] bg-[#202020] shadow-2xl">
      <div class="shrink-0 border-b border-[#303030] px-5 py-4">
        <h2 class="text-base font-semibold text-white">应用到项目 —「{{ applyPanelIp.name }}」</h2>
        <p v-if="busyId === applyPanelIp.id" class="mt-1.5 flex items-center gap-1.5 text-[11px] text-amber-400">
          <svg class="h-3 w-3 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" /><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
          {{ busyLabel }}
        </p>
      </div>
      <div class="flex-1 overflow-y-auto px-5 py-2">
        <div v-for="pj in applyPanelIp.projects" :key="pj.projectId" class="flex items-center gap-2 border-b border-[#2a2a2a] py-2.5 last:border-b-0">
          <span class="flex-1 truncate text-xs text-white">{{ pj.title }}</span>
          <span v-if="pj.status === 'synced'" class="shrink-0 text-[10px] text-emerald-400">已同步</span>
          <template v-else-if="pj.status === 'modified'">
            <span class="shrink-0 rounded px-1.5 py-0.5 text-[10px]" :class="pj.stale ? 'bg-sky-500/10 text-sky-400' : 'bg-amber-500/10 text-amber-400'">{{ pj.stale ? '落后' : '项目定制' }}</span>
            <span class="shrink-0 text-[10px] text-white/50">{{ diffLabel(pj) }}</span>
            <button class="shrink-0 border border-[#383838] px-2 py-1 text-[10px] text-white/70 hover:border-[#c7ff00]/50 hover:text-white disabled:opacity-50" :disabled="saving" @click="askSyncProject(applyPanelIp, pj)">同步</button>
          </template>
          <template v-else>
            <span class="shrink-0 text-[10px] text-white/60">未引入</span>
            <button class="shrink-0 border border-[#383838] px-2 py-1 text-[10px] text-white/70 hover:border-[#c7ff00]/50 hover:text-white disabled:opacity-50" :disabled="saving" @click="askImportProject(applyPanelIp, pj)">引入</button>
          </template>
          <button
            v-if="pj.projectCharacterId"
            class="shrink-0 px-2 py-1 text-[10px] text-white/40 transition hover:text-red-400 disabled:opacity-50"
            title="移出该项目（只解除该项目关联，可随时引入回来）"
            :disabled="saving"
            @click="askRemoveFromProject(applyPanelIp, pj)"
          >移出项目</button>
        </div>
      </div>
      <div class="shrink-0 border-t border-[#303030] px-5 py-3">
        <p class="text-[11px] leading-relaxed text-white/60">同步会把 IP 当前的形象、描述、音色覆盖到该项目，其下所有集同步更新，不可撤销。</p>
      </div>
    </div>
  </div>

</template>
