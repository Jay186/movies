<script setup>
import { ref, computed, watch } from 'vue'
import { api } from '../services/api'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  // 传入即进入「编辑模式」：标题变「编辑风格」、预填数据、提交走 update
  editStyle: { type: Object, default: null },
})
const emit = defineEmits(['update:modelValue', 'created', 'updated'])

const LABEL_MAX = 32
const PROMPT_MAX = 2000

const label = ref('')
const prompt = ref('')
const coverFile = ref(null) // 待选文件（未提交）
const coverPreview = ref('') // 预览地址（新建=FileReader dataURL；编辑=已有封面 URL）
const pendingClear = ref(false) // 编辑模式下用户主动移除已有封面
const submitting = ref(false)
const errorMsg = ref('')
const fileInput = ref(null)

const isEdit = computed(() => !!props.editStyle)

const labelCount = computed(() => label.value.length)
const promptCount = computed(() => prompt.value.length)

const canSubmit = computed(
  () => label.value.trim().length > 0 && prompt.value.trim().length > 0 && !submitting.value
)

watch(
  () => props.modelValue,
  (v) => {
    if (v) {
      // 打开时重置（确保多次打开互不污染）
      errorMsg.value = ''
      submitting.value = false
      pendingClear.value = false
      coverFile.value = null
      if (props.editStyle) {
        label.value = props.editStyle.label || ''
        prompt.value = props.editStyle.prompt || ''
        coverPreview.value = props.editStyle.coverUrl || ''
      } else {
        label.value = ''
        prompt.value = ''
        coverPreview.value = ''
      }
    }
  }
)

function close() {
  if (submitting.value) return
  emit('update:modelValue', false)
}

function triggerFileSelect() {
  fileInput.value?.click()
}

function handleFileChange(e) {
  const file = e.target.files?.[0]
  if (!file) return
  if (!file.type.startsWith('image/')) {
    errorMsg.value = '请选择图片文件'
    e.target.value = ''
    return
  }
  if (file.size > 10 * 1024 * 1024) {
    errorMsg.value = '封面图不能超过 10MB'
    e.target.value = ''
    return
  }
  errorMsg.value = ''
  coverFile.value = file
  pendingClear.value = false
  const reader = new FileReader()
  reader.onload = () => {
    coverPreview.value = reader.result
  }
  reader.readAsDataURL(file)
  e.target.value = ''
}

function clearCover() {
  // 编辑模式下且原本有封面：标记「清除」，提交时传 coverBase64='' 以删除
  if (isEdit.value && props.editStyle?.coverUrl && !coverFile.value) {
    pendingClear.value = true
  }
  coverFile.value = null
  coverPreview.value = ''
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

async function submit() {
  if (!canSubmit.value) return
  errorMsg.value = ''
  submitting.value = true
  try {
    const body = {
      label: label.value.trim(),
      prompt: prompt.value.trim(),
    }
    // 封面：新建——有文件才传；编辑——有文件传替换、明确清除传空串、其余不动
    if (coverFile.value) {
      body.coverBase64 = await readFileAsBase64(coverFile.value)
    } else if (isEdit.value && pendingClear.value) {
      body.coverBase64 = ''
    }

    if (isEdit.value) {
      const res = await api.updateStyle(props.editStyle.key, body)
      if (res?.style) emit('updated', res.style)
    } else {
      const res = await api.createStyle(body)
      if (res?.style) emit('created', res.style)
    }
    emit('update:modelValue', false)
  } catch (e) {
    errorMsg.value = e.message || (isEdit.value ? '保存失败' : '创建失败')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="modelValue"
      class="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      @click.self="close"
    >
      <div class="flex max-h-[85vh] w-[480px] max-w-[95vw] flex-col overflow-hidden rounded-2xl border border-border bg-bg-card shadow-2xl">
        <!-- 标题栏 -->
        <div class="flex shrink-0 items-center justify-between border-b border-border px-5 py-3.5">
          <h2 class="text-base font-semibold text-white">{{ isEdit ? '编辑风格' : '新建风格' }}</h2>
          <button
            class="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition hover:bg-bg-hover hover:text-white"
            :disabled="submitting"
            @click="close"
          >
            <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <!-- 表单 -->
        <div class="flex-1 overflow-y-auto px-5 py-4">
          <!-- 风格名称 -->
          <div class="mb-4">
            <div class="mb-1.5 flex items-center justify-between">
              <label class="text-xs text-text-secondary">风格名称</label>
              <span class="text-[10px] text-text-muted">{{ labelCount }}/{{ LABEL_MAX }}</span>
            </div>
            <input
              v-model="label"
              type="text"
              :maxlength="LABEL_MAX"
              placeholder="例如：水墨写意"
              class="w-full rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-white placeholder:text-text-muted focus:border-accent focus:outline-none"
              :disabled="submitting"
              @input="errorMsg = ''"
            />
          </div>

          <!-- 提示词 -->
          <div class="mb-4">
            <div class="mb-1.5 flex items-center justify-between">
              <label class="text-xs text-text-secondary">提示词</label>
              <span class="text-[10px] text-text-muted">{{ promptCount }}/{{ PROMPT_MAX }}</span>
            </div>
            <textarea
              v-model="prompt"
              :maxlength="PROMPT_MAX"
              rows="5"
              placeholder="描述这种风格的画面特征，例如：水墨晕染、写意线条、留白构图..."
              class="w-full resize-none rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm leading-relaxed text-white placeholder:text-text-muted focus:border-accent focus:outline-none"
              :disabled="submitting"
              @input="errorMsg = ''"
            />
            <p class="mt-1.5 text-[11px] leading-relaxed text-text-muted">
              保存时会过一次内容审核，命中敏感词将被拒绝。
            </p>
          </div>

          <!-- 封面图 -->
          <div class="mb-1">
            <label class="mb-1.5 block text-xs text-text-secondary">封面图</label>
            <input
              ref="fileInput"
              type="file"
              accept="image/*"
              class="hidden"
              @change="handleFileChange"
            />

            <!-- 未选择：虚线框 -->
            <div
              v-if="!coverPreview"
              class="flex cursor-pointer items-center justify-center rounded-lg border border-dashed border-border py-6 transition hover:border-accent/50"
              @click="triggerFileSelect"
            >
              <div class="flex flex-col items-center gap-1.5 text-text-muted">
                <svg class="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
                <span class="text-xs">点击上传封面图（可选）</span>
              </div>
            </div>

            <!-- 已选择 / 已有封面：预览图 + 移除按钮 -->
            <div v-else class="relative overflow-hidden rounded-lg border border-border bg-white">
              <img :src="coverPreview" alt="封面预览" class="max-h-48 w-full object-contain" />
              <button
                class="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-md bg-black/60 text-white backdrop-blur transition hover:bg-red-500"
                :disabled="submitting"
                :title="isEdit && !coverFile && pendingClear ? '已标记移除封面' : '移除封面'"
                @click="clearCover"
              >
                <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              <div class="absolute bottom-0 left-0 right-0 bg-black/60 px-3 py-1.5 text-[11px] text-white backdrop-blur">
                {{ coverFile ? coverFile.name + ' (' + (coverFile.size / 1024).toFixed(1) + ' KB)' : (pendingClear ? '将移除封面' : '当前封面（点击上方可替换）') }}
              </div>
            </div>
          </div>

          <!-- 错误提示 -->
          <div v-if="errorMsg" class="mt-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-400">
            {{ errorMsg }}
          </div>
        </div>

        <!-- 底部按钮 -->
        <div class="flex shrink-0 justify-end gap-3 border-t border-border px-5 py-3.5">
          <button
            class="rounded-lg border border-border px-4 py-2 text-sm text-text-secondary transition hover:border-border-light hover:text-white"
            :disabled="submitting"
            @click="close"
          >
            取消
          </button>
          <button
            class="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-black transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="!canSubmit"
            @click="submit"
          >
            {{ submitting ? (isEdit ? '保存中...' : '创建中...') : (isEdit ? '保存' : '创建') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
