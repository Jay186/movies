<script setup>
import { ref, watch } from 'vue'
import { api } from '../services/api'
import { useProjectStore } from '../stores/project'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  episodeId: { type: Number, default: null },
})

const emit = defineEmits(['update:modelValue', 'imported'])
const store = useProjectStore()

const activeTab = ref('paste') 
const pasteText = ref('')
const fileInput = ref(null)
const selectedFile = ref(null)
const fileText = ref('')
const previewing = ref(false)
const previewResult = ref(null) 
const errorMsg = ref('')
const importLoading = ref(false)
const confirmReady = ref(false)
const importedVersion = ref('') 
const backupInfo = ref(null) 

const backupKey = () => `script-backup-${props.episodeId}`

function loadBackupInfo() {
  backupInfo.value = null
  if (!props.episodeId) return
  try {
    const raw = localStorage.getItem(backupKey())
    if (!raw) return
    const parsed = JSON.parse(raw)
    if (parsed?.content?.trim()) backupInfo.value = parsed
  } catch {
  }
}

async function restoreBackup() {
  if (!backupInfo.value || !props.episodeId) return
  importLoading.value = true
  errorMsg.value = ''
  try {
    await api.updateScript(props.episodeId, {
      script_content: backupInfo.value.content,
      script_confirmed: 0,
    })
    store.scriptContent = backupInfo.value.content
    localStorage.removeItem(backupKey())
    backupInfo.value = null
    emit('imported')
    close()
  } catch (e) {
    errorMsg.value = '恢复备份失败：' + (e.message || '未知错误')
  } finally {
    importLoading.value = false
  }
}

function discardBackup() {
  localStorage.removeItem(backupKey())
  backupInfo.value = null
}

watch(
  () => props.modelValue,
  (val) => {
    if (!val) return
    reset()
  }
)

function reset() {
  activeTab.value = 'paste'
  pasteText.value = ''
  fileText.value = ''
  selectedFile.value = null
  previewing.value = false
  previewResult.value = null
  errorMsg.value = ''
  importLoading.value = false
  confirmReady.value = false
  if (fileInput.value) fileInput.value.value = ''
  loadBackupInfo()
}

function close() {
  emit('update:modelValue', false)
}

function getSourceText() {
  return activeTab.value === 'paste' ? pasteText.value : fileText.value
}

function switchTab(tab) {
  activeTab.value = tab
  errorMsg.value = ''
  previewResult.value = null
  confirmReady.value = false
}

async function readFileAsText(file) {
  const buf = await file.arrayBuffer()
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    try {
      return new TextDecoder('gb18030').decode(buf)
    } catch {
      return new TextDecoder('utf-8').decode(buf)
    }
  }
}

async function runPreview() {
  const text = getSourceText().trim()
  if (!text) {
    errorMsg.value = '请先粘贴剧本内容或选择剧本文件'
    return
  }
  if (!props.episodeId) {
    errorMsg.value = '当前没有选中的集，无法导入'
    return
  }
  errorMsg.value = ''
  previewing.value = true
  previewResult.value = null
  confirmReady.value = false
  try {
    const r = await api.previewScriptImport(props.episodeId, text)
    previewResult.value = r
    confirmReady.value = r.sceneCount > 0 || r.changed
  } catch (e) {
    errorMsg.value = e.message || '剧本解析失败'
  } finally {
    previewing.value = false
  }
}

async function handleFileChange(e) {
  const file = e.target.files?.[0]
  if (!file) return
  selectedFile.value = file
  errorMsg.value = ''
  previewResult.value = null
  confirmReady.value = false
  try {
    fileText.value = await readFileAsText(file)
  } catch {
    errorMsg.value = '读取文件失败'
    fileText.value = ''
  }
  e.target.value = ''
}

const methodText = {
  standard: '已是标准格式，无需转换',
  regex: '已自动识别变体标记并转换为标准格式',
  llm: '已由 AI 自动切分场次（仅插入标记，正文未改动）',
}

async function confirmImport() {
  if (!confirmReady.value || !previewResult.value || !props.episodeId) return
  importLoading.value = true
  try {
    const current = store.scriptContent || ''
    if (current.trim()) {
      try {
        localStorage.setItem(
          `script-backup-${props.episodeId}`,
          JSON.stringify({ time: Date.now(), content: current })
        )
      } catch {
      }
    }
    await api.updateScript(props.episodeId, {
      script_content: previewResult.value.normalizedText,
      script_confirmed: 0,
    })
    store.scriptContent = previewResult.value.normalizedText
    importedVersion.value = store.scriptVersions[0]?.v || '新版本'
    emit('imported')
    close()
  } catch (e) {
    errorMsg.value = '导入失败：' + (e.message || '未知错误')
  } finally {
    importLoading.value = false
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
      <div class="flex max-h-[80vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-border bg-bg-primary shadow-2xl">
        <div class="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 class="text-base font-medium text-white">导入剧本</h2>
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
          <p>支持粘贴任意文本或导入 .txt 文件。系统会自动识别场次标记并转换为标准格式，正文内容不会改动。</p>
          <p class="mt-1 text-text-muted">
            已识别的格式：<span class="text-text-secondary">场次1：标题</span> / <span class="text-text-secondary">第1场</span> / <span class="text-text-secondary">Scene 1</span> / <span class="text-text-secondary">【场次一】</span> 等
          </p>
        </div>

        <div
          v-if="backupInfo"
          class="flex items-center justify-between gap-3 border-b border-border bg-amber-500/10 px-6 py-2.5 text-xs"
        >
          <span class="text-amber-300">
            检测到上次导入前的自动备份（{{ new Date(backupInfo.time).toLocaleString('zh-CN') }}）
          </span>
          <span class="flex shrink-0 gap-2">
            <button
              class="rounded border border-amber-500/40 px-2.5 py-1 text-amber-300 transition hover:bg-amber-500/15 disabled:opacity-50"
              :disabled="importLoading"
              @click="restoreBackup"
            >
              {{ importLoading ? '恢复中...' : '恢复该备份' }}
            </button>
            <button
              class="rounded border border-border px-2.5 py-1 text-text-muted transition hover:text-white disabled:opacity-50"
              :disabled="importLoading"
              @click="discardBackup"
            >
              丢弃
            </button>
          </span>
        </div>

        <div class="flex border-b border-border px-6">
          <button
            class="px-4 py-2.5 text-xs transition"
            :class="activeTab === 'paste' ? 'border-b-2 border-accent text-accent' : 'text-text-secondary hover:text-white'"
            @click="switchTab('paste')"
          >
            粘贴文本
          </button>
          <button
            class="px-4 py-2.5 text-xs transition"
            :class="activeTab === 'file' ? 'border-b-2 border-accent text-accent' : 'text-text-secondary hover:text-white'"
            @click="switchTab('file')"
          >
            导入文件
          </button>
        </div>

        <div class="flex min-h-0 flex-1 flex-col p-6">
          <div class="min-h-0 flex-1 overflow-y-auto">
          <div v-if="activeTab === 'paste'">
            <textarea
              v-model="pasteText"
              class="h-56 w-full resize-none rounded-lg border border-border bg-bg-secondary p-3 text-sm leading-7 text-white placeholder-text-muted outline-none focus:border-accent/50"
              placeholder="将剧本内容粘贴到这里，例如：&#10;&#10;场次1：雨夜森林&#10;场景：外景·森林·夜晚·暴雨&#10;布布（焦急）：&quot;一二，快跟上来！&quot;"
              spellcheck="false"
            />
          </div>

          <div v-else>
            <input
              ref="fileInput"
              type="file"
              accept=".txt,text/plain"
              class="hidden"
              @change="handleFileChange"
            />
            <div
              class="flex h-56 cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-border transition hover:border-accent/50"
              @click="fileInput?.click()"
            >
              <template v-if="!selectedFile">
                <svg class="mb-3 h-10 w-10 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
                <p class="text-sm text-text-secondary">点击选择剧本文件</p>
                <p class="mt-1 text-xs text-text-muted">支持 .txt 纯文本（自动识别 UTF-8 / GBK 编码）</p>
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
                    @click.stop="selectedFile = null; fileText = ''; previewResult = null; confirmReady = false"
                  >
                    重新选择
                  </button>
                </div>
              </template>
            </div>
          </div>
          </div>

          <div class="mt-4 shrink-0">
            <button
              class="w-full rounded-lg border border-border bg-bg-secondary py-2 text-xs text-text-secondary transition hover:border-accent/50 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="previewing || (!getSourceText().trim())"
              @click="runPreview"
            >
              {{ previewing ? '解析中...' : '解析预览' }}
            </button>

            <p v-if="errorMsg" class="mt-3 text-xs text-red-400">{{ errorMsg }}</p>

            <div v-else-if="previewResult" class="mt-3 space-y-2 rounded-lg border border-border bg-bg-secondary p-4 text-xs">
              <div class="flex flex-wrap items-center gap-2">
                <span class="rounded bg-accent/15 px-2 py-1 text-[11px] font-medium text-accent">
                  {{ previewResult.sceneCount }} 场次
                </span>
                <span
                  v-if="previewResult.unparsedCount"
                  class="rounded bg-amber-500/15 px-2 py-1 text-[11px] font-medium text-amber-400"
                >
                  {{ previewResult.unparsedCount }} 未识别
                </span>
                <span v-else class="rounded bg-green-500/15 px-2 py-1 text-[11px] font-medium text-green-400">无未识别</span>
                <span class="rounded bg-bg-card px-2 py-1 text-[11px] text-text-secondary">{{ methodText[previewResult.method] || '已转换' }}</span>
              </div>

              <div v-if="previewResult.unparsedLines?.length" class="rounded border border-border/60 bg-bg-card p-2">
                <div class="mb-1.5 text-[10px] text-text-muted">以下标记未被识别，正文仍保留</div>
                <ul class="max-h-24 space-y-1 overflow-y-auto text-[10px] text-text-secondary">
                  <li v-for="(line, idx) in previewResult.unparsedLines" :key="idx" class="truncate font-mono">· {{ line }}</li>
                </ul>
              </div>

              <p class="pt-1 text-text-muted">
                导入后保存为 <span class="text-accent">{{ importedVersion || '新版本' }}</span>（当前内容已自动备份），不会覆盖下游数据。
              </p>
            </div>
          </div>
        </div>

        <div class="flex items-center justify-between border-t border-border px-6 py-4">
          <span class="text-[10px] text-text-muted">导入的剧本暂不确认，确认后才会进入画风与资产提取</span>
          <div class="flex gap-3">
            <button
              class="rounded-lg border border-border px-5 py-2 text-sm text-text-secondary transition hover:border-border-light hover:text-white"
              @click="close"
            >
              取消
            </button>
            <button
              class="rounded-lg bg-accent px-5 py-2 text-sm font-medium text-black transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="!confirmReady || importLoading"
              @click="confirmImport"
            >
              {{ importLoading ? '导入中...' : '确认导入' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
