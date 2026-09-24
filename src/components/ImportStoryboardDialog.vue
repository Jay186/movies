<script setup>
import { ref, computed, watch } from 'vue'
import { api } from '../services/api'
import { useProjectStore } from '../stores/project'
import { confirmDialog } from '../services/dialog'
import SbProgressBar from './SbProgressBar.vue'
import {
  parseStoryboard,
  parseStoryboardRows,
  rebuildFromTable,
  decodeFileBuffer,
  mergeShortShots,
  mergeShotsByScene,
  FIELD_DEFS,
} from '../utils/storyboardImport'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  episodeId: { type: Number, default: null },
})

const emit = defineEmits(['update:modelValue', 'imported'])

const store = useProjectStore()

const fileInput = ref(null)
const selectedFile = ref(null)
const isParsing = ref(false)
const importLoading = ref(false)
const errorMsg = ref('')
const activeTab = ref('upload') 
const dragOver = ref(false)

const result = ref(null)
const rawParsed = ref(null)
const mapping = ref(null)
const manualFields = ref(new Set())
const episodeAssets = ref({ characters: [], scenes: [], props: [] })
const existingMediaShots = ref(0)
const createUnknownAssets = ref(false)
const enrichMissing = ref(true)
const mergeShort = ref(false)
const mergeByScene = ref(true)
const sceneMaxDuration = ref(15)
const enrichStatus = ref(null)
const aiParse = ref(false)

const scenes = computed(() => result.value?.scenes || [])
const totalShots = computed(() => result.value?.stats.shotCount || 0)
const totalDuration = computed(() => result.value?.stats.totalDuration || 0)
const isTable = computed(() => result.value?.format === 'table' && !!result.value.table)

const rawShotCount = computed(() => rawParsed.value?.stats.shotCount || 0)
const shotsMerged = computed(() => (mergeShort.value || mergeByScene.value) && rawShotCount.value !== totalShots.value)
const mergeLabel = computed(() => {
  if (!shotsMerged.value) return ''
  if (mergeByScene.value) return `按段合并：${rawShotCount.value} 镜 → ${totalShots.value} 镜`
  return `短镜合并：${rawShotCount.value} 镜 → ${totalShots.value} 镜`
})

const unknownAssets = computed(() => result.value?.unknownAssets || { characters: [], scenes: [], props: [] })
const unknownCount = computed(
  () => unknownAssets.value.characters.length + unknownAssets.value.scenes.length + unknownAssets.value.props.length
)

const shownFields = computed(() => {
  if (!isTable.value) return []
  return FIELD_DEFS.map((d) => ({ ...d, mapped: (mapping.value?.[d.key] ?? -1) >= 0 }))
})

const columnOptions = computed(() => {
  const t = result.value?.table
  if (!t) return []
  const colCount = Math.max(...t.rows.map((r) => r.length))
  return Array.from({ length: colCount }, (_, i) => {
    const sample = t.rows.slice(t.hasHeader ? 1 : 0, 4).map((r) => String(r[i] ?? '').trim()).filter(Boolean)[0] || ''
    return {
      index: i,
      label: t.hasHeader && t.header[i] ? `${t.header[i]}` : `第 ${i + 1} 列`,
      sample: sample.slice(0, 18),
    }
  })
})

const confidenceText = { high: '表头识别', mid: '内容推断', low: '内容推断' }
const confidenceClass = {
  high: 'bg-green-500/15 text-green-400',
  mid: 'bg-accent/15 text-accent',
  low: 'bg-amber-500/15 text-amber-400',
}

watch(() => props.modelValue, async (val) => {
  if (!val) return
  reset()
  if (props.episodeId) {
    try {
      const ep = await api.getEpisode(props.episodeId)
      episodeAssets.value = {
        characters: ep.characters || [],
        scenes: ep.scenes || [],
        props: ep.props || [],
      }
      existingMediaShots.value = (ep.storyboardScenes || []).reduce(
        (n, s) => n + (s.shots || []).filter((sh) => sh.frame_url || sh.video_url || sh.blocking_url || sh.blockingUrl).length,
        0
      )
    } catch (e) {
      console.error('加载资产库失败', e)
    }
  }
})

function reset() {
  selectedFile.value = null
  result.value = null
  rawParsed.value = null
  mapping.value = null
  manualFields.value = new Set()
  isParsing.value = false
  importLoading.value = false
  errorMsg.value = ''
  activeTab.value = 'upload'
  dragOver.value = false
  createUnknownAssets.value = false
  enrichMissing.value = true
  mergeShort.value = false
  mergeByScene.value = true
  sceneMaxDuration.value = 15
  enrichStatus.value = null
  aiParse.value = false
  if (fileInput.value) fileInput.value.value = ''
}

function close() {
  emit('update:modelValue', false)
}

function triggerFileSelect() {
  fileInput.value?.click()
}

function handleDragOver(e) {
  e.preventDefault()
  dragOver.value = true
}

function handleDragLeave() {
  dragOver.value = false
}

function handleDrop(e) {
  e.preventDefault()
  dragOver.value = false
  const file = e.dataTransfer.files?.[0]
  if (file) processFile(file)
}

function handleFileChange(e) {
  const file = e.target.files?.[0]
  if (!file) return
  processFile(file)
  e.target.value = ''
}

async function processFile(file) {
  selectedFile.value = file
  errorMsg.value = ''
  result.value = null
  mapping.value = null
  isParsing.value = true

  const ext = file.name.split('.').pop().toLowerCase()
  const knownAssets = episodeAssets.value
  let fileText = ''

  try {
    if (ext === 'xlsx' || ext === 'xls') {
      const XLSXMod = await import('xlsx')
      const XLSX = XLSXMod.read ? XLSXMod : XLSXMod.default
      const buf = await file.arrayBuffer()
      const workbook = XLSX.read(new Uint8Array(buf), { type: 'array' })
      const sheet = workbook.Sheets[workbook.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })
      fileText = rows.map((r) => (Array.isArray(r) ? r.join('\t') : String(r))).join('\n')
      finish(parseStoryboardRows(rows, { knownAssets }))
    } else if (ext === 'docx') {
      const mammothMod = await import('mammoth')
      const mammoth = mammothMod.default || mammothMod
      const buf = await file.arrayBuffer()
      const html = (await mammoth.convertToHtml({ arrayBuffer: buf })).value
      const rows = extractRowsFromHtml(html)
      if (rows.length > 1) {
        fileText = rows.map((r) => (Array.isArray(r) ? r.join('\t') : String(r))).join('\n')
        finish(parseStoryboardRows(rows, { knownAssets }))
      } else {
        const raw = (await mammoth.extractRawText({ arrayBuffer: buf })).value || ''
        fileText = raw
        finish(parseStoryboard(raw, { knownAssets }))
      }
    } else {
      const text = await decodeFileBuffer(await file.arrayBuffer())
      fileText = text
      finish(parseStoryboard(text, { knownAssets }))
    }

    if (aiParse.value && fileText.trim()) {
      store.startSbProgressPolling(props.episodeId)
      try {
        await runAiParse(fileText)
      } finally {
        store.stopSbProgressPolling()
        store.clearSbProgressAfter()
      }
    }
  } catch (err) {
    errorMsg.value = '解析失败：' + (err.message || '未知错误')
  } finally {
    isParsing.value = false
  }
}

async function runAiParse(fileText) {
  try {
    const res = await api.extractStoryboardFromFile({ episodeId: props.episodeId, fileContent: fileText })
    const scenes = res?.storyboard?.scenes || []
    if (!scenes.length) {
      errorMsg.value = 'AI 智能解析未返回镜头，已回退到本地解析结果'
      return
    }
    const shotCount = scenes.reduce((n, s) => n + (s.shots || []).length, 0)
    const totalDuration = Math.round(scenes.reduce((n, s) => n + (s.shots || []).reduce((m, x) => m + (x.duration || 0), 0), 0) * 10) / 10
    rawParsed.value = { scenes, table: null, stats: { sceneCount: scenes.length, shotCount, totalDuration }, warnings: [] }
    result.value = rawParsed.value
    if (scenes.length) activeTab.value = 'result'
  } catch (e) {
    // 409 = 资产守卫拦截（assertAssetsExist），不是 AI 解析失败——透出真实原因，避免误导用户重试
    if (e.status === 409) {
      errorMsg.value = `${e.message} 已回退到本地解析。建议先去「设定」页补齐资产后再解析。`
    } else {
      errorMsg.value = 'AI 智能解析失败，已回退到本地解析结果：' + (e.message || '未知错误')
    }
  }
}

function finish(r) {
  rawParsed.value = r
  if (r.table) mapping.value = { ...r.table.mapping }
  refreshResult()
  if (r.scenes.length) {
    activeTab.value = 'result'
  } else {
    errorMsg.value = r.warnings[0] || '没能从这份文件里读出镜头，可在右侧预览里手动调整列对应关系'
  }
}

function refreshResult() {
  const r = rawParsed.value
  if (!r) {
    result.value = null
    return
  }
  let scenes = r.scenes
  if (mergeByScene.value) scenes = mergeShotsByScene(scenes, { maxDuration: sceneMaxDuration.value })
  else if (mergeShort.value) scenes = mergeShortShots(scenes)
  result.value = {
    ...r,
    scenes,
    stats: {
      ...r.stats,
      sceneCount: scenes.length,
      shotCount: scenes.reduce((n, s) => n + s.shots.length, 0),
      totalDuration: Math.round(scenes.reduce((n, s) => n + s.shots.reduce((m, x) => m + (x.duration || 0), 0), 0) * 10) / 10,
    },
  }
}

watch(mergeShort, (on) => { if (on) mergeByScene.value = false; refreshResult() })
watch(mergeByScene, (on) => { if (on) mergeShort.value = false; refreshResult() })
watch(sceneMaxDuration, () => { if (mergeByScene.value) refreshResult() })

function extractRowsFromHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const table = doc.querySelector('table')
  if (!table) return []
  return [...table.querySelectorAll('tr')].map((tr) =>
    [...tr.querySelectorAll('td, th')].map((c) => c.textContent.trim())
  )
}

function applyMapping(next, changedKey) {
  const t = rawParsed.value.table
  mapping.value = next
  if (changedKey) manualFields.value.add(changedKey)
  const rebuilt = rebuildFromTable(t.rows, next, {
    hasHeader: t.hasHeader,
    knownAssets: episodeAssets.value,
    sections: t.sections || [],
  })
  rawParsed.value = {
    ...rawParsed.value,
    scenes: rebuilt.scenes,
    stats: rebuilt.stats,
    unknownAssets: rebuilt.unknownAssets,
    warnings: rebuilt.warnings,
  }
  refreshResult()
}

function onMappingChange(fieldKey, colIndex) {
  if (!mapping.value) return
  const next = { ...mapping.value }
  if (colIndex === '' || colIndex === null || colIndex === undefined) {
    delete next[fieldKey]
  } else {
    for (const k of Object.keys(next)) {
      if (k !== fieldKey && next[k] === Number(colIndex)) delete next[k]
    }
    next[fieldKey] = Number(colIndex)
  }
  applyMapping(next, fieldKey)
}

function resetMapping() {
  if (!result.value?.table) return
  manualFields.value.clear()
  applyMapping({ ...result.value.table.mapping }, null)
}

async function handleImport() {
  if (!scenes.value.length || !props.episodeId) return
  // 资产锚守卫：资产库任一类为空且未勾选「导入时一并创建为资产」时，导入前弹确认框。
  // 口径与后端 assertAssetsExist 一致（任一为空即拦）；导入是用户显式行为，故用确认框而非硬拦。
  // 若勾选了创建资产，导入后 createAssets() 会补齐锚，无需确认。
  if (!createUnknownAssets.value) {
    const emptyClasses = []
    if (!episodeAssets.value.characters.length) emptyClasses.push('角色')
    if (!episodeAssets.value.scenes.length) emptyClasses.push('场景')
    if (!episodeAssets.value.props.length) emptyClasses.push('道具')
    if (emptyClasses.length) {
      const ok = await confirmDialog({
        title: '导入的分镜将没有资产锚',
        description: `本集缺少${emptyClasses.join('、')}资产，导入的镜头将没有参考图，出片时环境与画风会漂移。建议先去「设定」页提取资产后再导入。仍要导入吗？`,
        confirmText: '仍要导入',
        cancelText: '取消',
        tone: 'warn',
      })
      if (!ok) return
    }
  }
  if (existingMediaShots.value > 0) {
    const ok = await confirmDialog({
      title: '导入会整本替换当前分镜',
      description: '导入的分镜将覆盖当前内容，此操作不可撤销。',
      details: [
        { label: '待导入', value: `${scenes.value.length} 场` },
        {
          label: '将丢失的产出',
          value: `已有 ${existingMediaShots.value} 个镜头生成过图片 / 视频，替换后这些关联会被清空`,
          tone: 'danger',
        },
      ],
      confirmText: '替换并导入',
      cancelText: '取消导入',
      tone: 'danger',
    })
    if (!ok) return
  }

  importLoading.value = true
  try {
    await api.saveStoryboard(props.episodeId, {
      storyboardScenes: scenes.value,
      storyboard_confirmed: false,
      storyboard_source: 'imported',
    })

    if (createUnknownAssets.value && unknownCount.value) {
      await createAssets()
    }

    if (enrichMissing.value) {
      const missing = scenes.value
        .flatMap((s) => s.shots || [])
        .filter((sh) => !(sh.integratedMultimodalDescription || '').trim()).length
      if (missing > 0) {
        enrichStatus.value = 'loading'
        store.startSbProgressPolling(props.episodeId)
        try {
          const res = await api.enrichStoryboard(props.episodeId, { onlyMissing: true })
          enrichStatus.value = res?.failed > 0
            ? `提示词补全：${res.enriched} 条成功 / ${res.failed} 条失败`
            : `提示词补全完成：${res?.enriched || missing} 条`
        } catch (e) {
          enrichStatus.value = '提示词补全失败：' + (e.message || '未知错误') + '（可稍后在分镜页手动补全）'
        } finally {
          store.stopSbProgressPolling()
          store.settleSbProgress('提示词补全完成')
          store.clearSbProgressAfter()
        }
      }
    }

    store.saveStoryboardInfo(store.scriptContent)
    store.storyboardSource = 'imported'

    emit('imported')
    close()
  } catch (err) {
    console.error('导入失败:', err)
    errorMsg.value = '导入失败：' + (err.message || '未知错误')
    activeTab.value = 'upload'
  } finally {
    importLoading.value = false
  }
}

async function createAssets() {
  const ua = unknownAssets.value
  const name = (it) => (typeof it === 'string' ? it : it?.name || it?.title || '')
  try {
    if (ua.characters.length) {
      const merged = [...episodeAssets.value.characters]
      for (const n of ua.characters) if (!merged.some((c) => name(c) === n)) merged.push({ name: n, description: '' })
      await api.saveCharacters(props.episodeId, { characters: merged })
    }
    if (ua.props.length) {
      const merged = [...episodeAssets.value.props]
      for (const n of ua.props) if (!merged.some((p) => name(p) === n)) merged.push({ name: n, description: '' })
      await api.saveProps(props.episodeId, { props: merged })
    }
    if (ua.scenes.length) {
      const merged = [...episodeAssets.value.scenes]
      for (const n of ua.scenes) if (!merged.some((s) => name(s) === n)) merged.push({ name: n, description: '' })
      await api.saveScenes(props.episodeId, { scenes: merged })
    }
  } catch (e) {
    console.warn('补建资产失败（分镜已导入）:', e.message)
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="modelValue"
      class="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
      @click.self="close"
    >
      <div class="flex h-[82vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border bg-bg-primary shadow-2xl">
        <div class="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 class="text-base font-medium text-white">导入分镜脚本</h2>
          <button
            class="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition hover:bg-bg-hover hover:text-white"
            @click="close"
          >
            <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div class="border-b border-border px-6 py-3 text-xs leading-relaxed text-text-secondary">
          把你手上的分镜文件直接丢进来就行，不用改成任何指定格式。表格、Word、Markdown、CSV、JSON、纯文本都吃；
          表头和字段名认不出来时会按内容猜（最长的列当描述、纯数字列当时长），猜错可以在下方直接改。
        </div>

        <div class="flex border-b border-border px-6">
          <button
            class="px-4 py-2.5 text-xs transition"
            :class="activeTab === 'upload' ? 'border-b-2 border-accent text-accent' : 'text-text-secondary hover:text-white'"
            @click="activeTab = 'upload'"
          >
            选择文件
          </button>
          <button
            class="px-4 py-2.5 text-xs transition"
            :class="activeTab === 'result' ? 'border-b-2 border-accent text-accent' : 'text-text-secondary hover:text-white'"
            @click="activeTab = 'result'"
          >
            解析结果 {{ result?.scenes.length ? `（${result.stats.sceneCount} 场 / ${totalShots} 镜 / ${totalDuration}s）` : '' }}
          </button>
        </div>

        <div v-show="activeTab === 'upload'" class="flex flex-1 flex-col overflow-hidden p-6">
          <input
            ref="fileInput"
            type="file"
            accept=".txt,.md,.csv,.xlsx,.xls,.docx,.json"
            class="hidden"
            @change="handleFileChange"
          />

          <div
            class="flex flex-1 cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed transition"
            :class="dragOver ? 'border-accent bg-accent/5' : 'border-border hover:border-accent/50'"
            @dragover="handleDragOver"
            @dragleave="handleDragLeave"
            @drop="handleDrop"
            @click="triggerFileSelect"
          >
            <template v-if="!selectedFile">
              <svg class="mb-3 h-10 w-10 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              <p class="text-sm text-text-secondary">拖拽分镜文件到此，或点击选择</p>
              <p class="mt-1 text-xs text-text-muted">xlsx / xls / docx / txt / md / csv / json，中文编码自动识别</p>
            </template>

            <template v-else>
              <div class="flex items-center gap-3 rounded-lg border border-border bg-bg-secondary px-5 py-4">
                <svg class="h-8 w-8 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <div class="text-left">
                  <p class="text-sm text-white">{{ selectedFile.name }}</p>
                  <p class="text-xs text-text-muted">{{ (selectedFile.size / 1024).toFixed(1) }} KB</p>
                </div>
                <button
                  class="ml-4 rounded-md border border-border px-2.5 py-1 text-xs text-text-secondary transition hover:text-white"
                  @click.stop="selectedFile = null; result = null; mapping = null; errorMsg = ''"
                >
                  重新选择
                </button>
              </div>
              <p v-if="isParsing && !store.sbProgress" class="mt-4 text-xs text-accent">正在解析...</p>
              <div v-if="isParsing && store.sbProgress" class="mt-4 w-full max-w-md">
                <SbProgressBar :progress="store.sbProgress" compact />
              </div>
              <p v-else-if="errorMsg" class="mt-4 max-w-md text-center text-xs text-red-400">{{ errorMsg }}</p>
              <p v-else-if="result?.scenes.length" class="mt-4 text-xs text-green-400">
                解析成功：{{ result.stats.sceneCount }} 个场次，{{ totalShots }} 个镜头，总时长 {{ totalDuration }} 秒
              </p>
            </template>
          </div>

          <p class="mt-4 text-xs text-text-muted">
            场次写法（场次1 / 第1场 / SCENE 1 / INT. 客厅-日）和镜头写法（镜头1 / 镜1 / Shot 1 / C001 / 1.）
            都能认；通篇没有任何标记的纯段落，会按空行分段，独立成行的短句当场次标题。
          </p>
        </div>

        <div v-show="activeTab === 'result'" class="flex-1 overflow-auto p-6">
          <div v-if="!result?.scenes.length" class="flex h-full flex-col items-center justify-center text-text-muted">
            <p class="text-sm">还没有解析出内容</p>
            <p class="mt-1 text-xs">回到「选择文件」上传一个分镜文件</p>
          </div>

          <div v-else class="space-y-5">
            <div class="rounded-xl border border-border bg-bg-secondary p-4 text-xs">
              <div class="flex flex-wrap items-center gap-2">
                <span class="rounded bg-accent/15 px-2 py-1 text-[11px] font-medium text-accent">
                  {{ result.stats.sceneCount }} 场 / {{ totalShots }} 镜 / {{ totalDuration }}s
                </span>
                <span class="rounded bg-bg-card px-2 py-1 text-[11px] text-text-secondary">
                  来源：{{ { json: 'JSON', table: '表格', text: '纯文本' }[result.format] || result.format }}
                </span>
                <span
                  v-if="shotsMerged"
                  class="rounded px-2 py-1 text-[11px] font-medium"
                  :class="mergeByScene ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400'"
                  :title="mergeByScene ? '按段合并：同场次相邻镜头尽量合并，单镜不超过 '+sceneMaxDuration+' 秒' : '已按你的勾选合并过短镜头，预览与导入的都是合并后的版本'"
                >
                  {{ mergeLabel }}
                </span>
                <span
                  v-else
                  class="rounded bg-green-500/15 px-2 py-1 text-[11px] font-medium text-green-400"
                  title="镜头数量与内容完全来自你的文件，未做任何合并或改写"
                >
                  原样导入
                </span>
                <span
                  v-for="f in Object.keys(result.stats.coverage).filter((k) => !['startTime', 'endTime', 'duration', 'description'].includes(k))"
                  :key="f"
                  class="rounded bg-bg-card px-2 py-1 text-[11px] text-text-muted"
                >
                  {{ { shotType: '景别', cameraMovement: '运镜', soundEffects: '音效', overallSoundscape: '环境声', nonDiegeticMusic: '配乐', dialogue: '台词', actionNote: '动作说明', integratedMultimodalDescription: 'AI 提示词', finalFrame: '最终画面', characters: '角色', sceneAssets: '场景', propAssets: '道具' }[f] || f }}
                  {{ result.stats.coverage[f] }}/{{ totalShots }}
                </span>
              </div>
              <p v-if="result.warnings.length" class="mt-2 text-amber-400">
                {{ result.warnings.slice(0, 3).join('；') }}
              </p>
            </div>

            <div v-if="isTable" class="rounded-xl border border-border bg-bg-secondary p-4">
              <div class="mb-3 flex items-center justify-between">
                <div>
                  <p class="text-xs font-medium text-white">列对应关系</p>
                  <p class="mt-0.5 text-[11px] text-text-muted">
                    系统按表头 + 内容猜的。认错了直接改下面，不用回去改你的文件。
                  </p>
                </div>
                <button
                  class="rounded-md border border-border px-2.5 py-1 text-[11px] text-text-secondary transition hover:text-white"
                  @click="resetMapping"
                >
                  恢复自动
                </button>
              </div>

              <div class="grid grid-cols-2 gap-2">
                <div v-for="f in shownFields" :key="f.key" class="flex items-center gap-2">
                  <div class="flex w-24 shrink-0 items-center gap-1">
                    <span class="truncate text-[11px] text-text-secondary">{{ f.label }}</span>
                    <span
                      v-if="manualFields.has(f.key)"
                      class="shrink-0 rounded bg-accent/15 px-1 text-[9px] text-accent"
                      title="你手动指定的"
                    >
                      手动
                    </span>
                    <span
                      v-else-if="result.table.confidence[f.key]"
                      class="shrink-0 rounded px-1 text-[9px]"
                      :class="confidenceClass[result.table.confidence[f.key]]"
                      :title="confidenceText[result.table.confidence[f.key]]"
                    >
                      {{ result.table.confidence[f.key] === 'high' ? '表头' : '猜' }}
                    </span>
                  </div>
                  <select
                    class="min-w-0 flex-1 rounded border border-border bg-bg-card px-2 py-1 text-[11px] text-white outline-none focus:border-accent/50"
                    :value="mapping?.[f.key] ?? ''"
                    @change="onMappingChange(f.key, $event.target.value)"
                  >
                    <option value="">不使用</option>
                    <option v-for="c in columnOptions" :key="c.index" :value="c.index">
                      {{ c.label }}<template v-if="c.sample"> · {{ c.sample }}</template>
                    </option>
                  </select>
                </div>
              </div>
            </div>

            <div v-if="unknownCount" class="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-xs">
              <p class="text-amber-300">
                这份文件里有 {{ unknownCount }} 个名字不在当前资产库中，已按原文保留（不会改名、不会拦你）：
              </p>
              <div class="mt-2 flex flex-wrap gap-2">
                <span v-for="n in unknownAssets.characters" :key="'c' + n" class="rounded bg-yellow-500/15 px-1.5 py-0.5 text-[11px] text-yellow-300">角色 · {{ n }}</span>
                <span v-for="n in unknownAssets.scenes" :key="'s' + n" class="rounded bg-blue-500/15 px-1.5 py-0.5 text-[11px] text-blue-300">场景 · {{ n }}</span>
                <span v-for="n in unknownAssets.props" :key="'p' + n" class="rounded bg-orange-500/15 px-1.5 py-0.5 text-[11px] text-orange-300">道具 · {{ n }}</span>
              </div>
              <label class="mt-3 flex cursor-pointer items-center gap-2 text-[11px] text-text-secondary">
                <input v-model="createUnknownAssets" type="checkbox" class="accent-amber-400" />
                导入时一并创建为资产（不勾也照常导入，只是这些名字不进资产库）
              </label>
            </div>

            <div v-if="existingMediaShots > 0" class="rounded-lg border border-border bg-bg-secondary p-3 text-xs text-text-secondary">
              当前已有 {{ existingMediaShots }} 个镜头生成过图片/视频，导入将整本替换并清空这些镜头的成果关联。
            </div>

            <div
              v-for="(scene, sIdx) in scenes"
              :key="sIdx"
              class="rounded-xl border border-border bg-bg-secondary p-4"
            >
              <div class="mb-3 flex items-center gap-2">
                <span class="flex h-5 w-5 items-center justify-center rounded bg-accent text-[10px] font-bold text-black">
                  {{ sIdx + 1 }}
                </span>
                <span class="text-sm font-medium text-white">{{ scene.title }}</span>
                <span class="text-xs text-text-muted">{{ scene.shots.length }} 个镜头</span>
              </div>

              <div class="space-y-2">
                <div
                  v-for="(shot, shotIdx) in scene.shots"
                  :key="shotIdx"
                  class="rounded-lg border border-border/50 bg-bg-card p-3 text-xs"
                >
                  <div class="mb-2 flex flex-wrap items-center gap-2 text-text-secondary">
                    <span class="rounded bg-accent/20 px-1.5 py-0.5 text-[10px] text-accent">镜头 {{ shotIdx + 1 }}</span>
                    <span v-if="shot.shotType" class="rounded bg-bg-hover px-1.5 py-0.5 text-[10px]">{{ shot.shotType }}</span>
                    <span v-if="shot.duration" class="rounded bg-bg-hover px-1.5 py-0.5 text-[10px]">{{ shot.duration }}s</span>
                    <span v-if="shot.cameraMovement" class="rounded bg-bg-hover px-1.5 py-0.5 text-[10px]">{{ shot.cameraMovement }}</span>
                    <span v-if="shot.integratedMultimodalDescription" class="rounded bg-green-500/15 px-1.5 py-0.5 text-[10px] text-green-400">已带 AI 提示词</span>
                  </div>
                  <p class="mb-2 leading-relaxed text-text-secondary">{{ shot.description || '（这一镜没有描述）' }}</p>
                  <p v-if="shot.dialogue?.text" class="mb-2 text-[11px] text-text-muted">
                    {{ shot.dialogue.character ? shot.dialogue.character + '：' : '' }}{{ shot.dialogue.text }}
                  </p>
                  <div v-if="shot.characters.length || shot.sceneAssets.length || shot.propAssets.length" class="flex flex-wrap gap-2 text-[10px]">
                    <span v-for="c in shot.characters" :key="c" class="rounded bg-yellow-500/15 px-1.5 py-0.5 text-yellow-300">@{{ c }}</span>
                    <span v-for="s in shot.sceneAssets" :key="s" class="rounded bg-blue-500/15 px-1.5 py-0.5 text-blue-300">@{{ s }}</span>
                    <span v-for="p in shot.propAssets" :key="p" class="rounded bg-orange-500/15 px-1.5 py-0.5 text-orange-300">@{{ p }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="flex items-center justify-between gap-3 border-t border-border px-6 py-4">
          <div v-if="result?.scenes.length" class="flex flex-wrap items-center gap-x-5 gap-y-2">
            <label
              class="flex cursor-pointer items-center gap-2 text-[11px] text-text-secondary"
              title="默认关闭，按文件原样导入。勾选后：不足 3 秒的细切镜头会并入相邻镜头，镜头数量会变少、描述用「；」拼接、景别用「→」连接；合并后尽量控制在 15 秒内（无处可并时略超，优先保证不留碎镜）"
            >
              <input v-model="mergeShort" type="checkbox" class="accent-amber-400" />
              合并过短镜头
            </label>
            <label
              class="flex cursor-pointer items-center gap-2 text-[11px] text-text-secondary"
              title="每场次内相邻镜头尽量合并，描述用「；」拼接、景别用「→」连接、时长累加。单镜超过上限时同场次会拆成多镜。适合已有分镜脚本、每个场次就是一个完整镜头的场景。与「合并过短镜头」互斥"
            >
              <input v-model="mergeByScene" type="checkbox" class="accent-emerald-400" />
              按段合并
            </label>
            <label
              v-if="mergeByScene"
              class="flex items-center gap-1 text-[11px] text-text-secondary"
              title="单镜时长上限，超过此值同场次会拆成多镜。适配 AI 视频生成的单段最大时长"
            >
              上限
              <input
                v-model.number="sceneMaxDuration"
                type="number"
                min="3"
                max="60"
                step="1"
                class="w-12 rounded border border-border bg-transparent px-1.5 py-0.5 text-center text-[11px] text-text-primary outline-none focus:border-emerald-400"
              />
              秒
            </label>
            <label
              class="flex cursor-pointer items-center gap-2 text-[11px] text-text-secondary"
              title="文件里已经写好 AI 视频提示词的镜头会原样保留，只为缺提示词的镜头调用"
            >
              <input v-model="enrichMissing" type="checkbox" class="accent-amber-400" />
              为缺少 AI 提示词的镜头自动补全
            </label>
            <label
              class="flex cursor-pointer items-center gap-2 text-[11px] text-text-secondary"
              title="勾选后，把已读出的分镜内容交给规整型 LLM 重新提取为标准镜头结构（不创作、不增删镜头、不改动你给定的时长，只做结构归一与资产名对齐）。大模型调用，耗时更长"
            >
              <input v-model="aiParse" type="checkbox" class="accent-sky-400" />
              AI 智能解析
            </label>
            <span v-if="enrichStatus" class="text-[11px]" :class="enrichStatus === 'loading' ? 'text-text-muted animate-pulse' : enrichStatus.includes('失败') ? 'text-red-400' : 'text-emerald-400'">
              {{ enrichStatus === 'loading' ? '正在补全提示词...' : enrichStatus }}
            </span>
          </div>
          <span v-else class="text-[10px] text-text-muted">导入后可在分镜页继续编辑</span>

          <div class="flex shrink-0 gap-3">
            <button
              class="rounded-lg border border-border px-5 py-2 text-sm text-text-secondary transition hover:border-border-light hover:text-white"
              @click="close"
            >
              取消
            </button>
            <button
              class="rounded-lg bg-accent px-5 py-2 text-sm font-medium text-black transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="!result?.scenes.length || importLoading"
              @click="handleImport"
            >
              {{ importLoading ? '导入中...' : '确认导入' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
