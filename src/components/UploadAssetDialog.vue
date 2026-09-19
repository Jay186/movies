<script setup>
import { ref, watch } from 'vue'
import { api } from '../services/api'
import { toastWarn, toastError } from '../services/dialog'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  type: { type: String, default: 'character' }, // character | scene | prop
})

const emit = defineEmits(['update:modelValue', 'uploaded'])

const name = ref('')
const selectedFile = ref(null)
const previewUrl = ref('')
const uploading = ref(false)
const fileInput = ref(null)


watch(() => props.modelValue, (val) => {
  if (val) {
    name.value = ''
    selectedFile.value = null
    previewUrl.value = ''
    uploading.value = false
  }
})

function triggerFileSelect() {
  fileInput.value?.click()
}

function handleFileChange(e) {
  const file = e.target.files?.[0]
  if (!file) return
  if (!file.type.startsWith('image/')) {
    toastWarn('请选择图片文件')
    e.target.value = ''
    return
  }
  if (file.size > 10 * 1024 * 1024) {
    toastWarn('图片大小不能超过 10MB', { detail: '请先压缩后再上传' })
    e.target.value = ''
    return
  }
  selectedFile.value = file
  // 生成预览
  const reader = new FileReader()
  reader.onload = () => { previewUrl.value = reader.result }
  reader.readAsDataURL(file)
  e.target.value = ''
}

function clearFile() {
  selectedFile.value = null
  previewUrl.value = ''
}

async function handleUpload() {
  if (!selectedFile.value) {
    toastWarn('请选择图片')
    return
  }
  uploading.value = true
  try {
    // 读取文件转 base64
    const base64 = await readFileAsBase64(selectedFile.value)
    // 名称：用户填了用用户的，没填用文件名（去掉扩展名）
    const finalName = name.value.trim() || selectedFile.value.name.replace(/\.[^/.]+$/, '')
    // 上传（后端存入"我的素材"并返回新记录，供选择器在替换场景下自动应用）
    const res = await api.uploadLibraryAsset(props.type, finalName, base64)
    emit('uploaded', res?.data || null)
    close()
  } catch (err) {
    console.error('上传失败:', err)
    toastError('上传失败', { detail: String(err.message || '未知错误') })
  } finally {
    uploading.value = false
  }
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function close() {
  emit('update:modelValue', false)
}
</script>

<template>
  <Teleport to="body">
    <div v-if="modelValue" class="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4" @click.self="close">
      <div class="w-full max-w-lg overflow-hidden rounded-2xl border border-border bg-bg-primary shadow-2xl">
        <!-- 标题栏 -->
        <div class="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 class="text-base font-medium text-white">上传图片</h2>
          <button class="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition hover:bg-bg-hover hover:text-white" @click="close">
            <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div class="px-6 py-5">
          <!-- 名称 -->
          <div class="mb-5">
            <label class="mb-1.5 block text-xs text-text-secondary">名称</label>
            <input v-model="name" class="w-full rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-white placeholder:text-text-muted focus:border-accent focus:outline-none" placeholder="素材名称（建议填写，不填则显示为「我的素材 #N」）" />
          </div>

          <!-- 选择图片 -->
          <div class="mb-2">
            <label class="mb-1.5 block text-xs text-text-secondary">选择图片</label>
            <input ref="fileInput" type="file" accept="image/*" class="hidden" @change="handleFileChange" />

            <!-- 未选择：虚线框 -->
            <div v-if="!selectedFile" class="flex cursor-pointer items-center justify-center rounded-lg border border-dashed border-border py-8 transition hover:border-accent/50" @click="triggerFileSelect">
              <div class="flex items-center gap-2 text-text-muted">
                <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 4v16m8-8H4" /></svg>
                <span class="text-sm">选择图片</span>
              </div>
            </div>

            <!-- 已选择：预览图 -->
            <div v-else class="relative overflow-hidden rounded-lg border border-border">
              <img :src="previewUrl" alt="预览" class="max-h-48 w-full object-contain bg-white" />
              <button class="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-md bg-black/60 text-white backdrop-blur transition hover:bg-red-500" @click="clearFile">
                <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
              <div class="absolute bottom-0 left-0 right-0 bg-black/60 px-3 py-1.5 text-xs text-white backdrop-blur">
                {{ selectedFile.name }} ({{ (selectedFile.size / 1024).toFixed(1) }} KB)
              </div>
            </div>
          </div>
        </div>

        <!-- 底部按钮 -->
        <div class="flex justify-end gap-3 border-t border-border px-6 py-4">
          <button class="rounded-lg border border-border px-5 py-2 text-sm text-text-secondary transition hover:border-border-light hover:text-white" @click="close">取消</button>
          <button class="rounded-lg bg-accent px-5 py-2 text-sm font-medium text-black transition hover:bg-accent-hover disabled:opacity-50" :disabled="uploading || !selectedFile" @click="handleUpload">
            {{ uploading ? '上传中...' : '上传' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
