<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { RouterView } from 'vue-router'
import AppHeader from './components/AppHeader.vue'
import DialogHost from './components/DialogHost.vue'
import { useProjectStore } from './stores/project'

const store = useProjectStore()
const appReady = ref(false)

// [2026-09-18] 全局 401 处理：后端启用 API_TOKEN 鉴权后，任何接口返回 401 都会弹出
// 令牌输入框；用户粘贴令牌保存到 localStorage 后自动刷新（api.js 在 401 时广播
// wb:unauthorized）。在 setup 顶层注册监听，保证早于任何 API 请求
// （子组件 mounted 早于父组件 onMounted，放 onMounted 里可能错过首轮 401）。
const showTokenDialog = ref(false)
const tokenInput = ref('')
const onUnauthorized = () => {
  tokenInput.value = ''
  showTokenDialog.value = true
}
window.addEventListener('wb:unauthorized', onUnauthorized)
onBeforeUnmount(() => window.removeEventListener('wb:unauthorized', onUnauthorized))

function saveToken() {
  const t = tokenInput.value.trim()
  if (!t) return
  localStorage.setItem('api_token', t)
  location.reload()
}

onMounted(async () => {
  // ensureReady 与路由守卫共用同一个初始化 promise，避免重复初始化
  await store.ensureReady()
  appReady.value = true
})
</script>

<template>
  <div class="flex h-full flex-col bg-bg-primary">
    <!-- 加载状态 -->
    <div v-if="!appReady" class="flex h-full items-center justify-center">
      <div class="flex flex-col items-center gap-3">
        <svg class="h-8 w-8 animate-spin text-accent" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
        </svg>
        <span class="text-sm text-text-secondary">加载中...</span>
      </div>
    </div>
    <template v-else>
      <AppHeader v-if="$route.meta.tab !== 'projects' && $route.meta.tab !== 'episodes'" />
      <main class="flex flex-1 overflow-hidden">
        <RouterView />
      </main>
    </template>

    <!-- 统一弹窗宿主：确认框 + 右下角提示条。
         全项目唯一的挂载点——放在最外层，所以无论当前在哪一页、
         甚至弹窗由 store 内部触发，都能正确渲染。 -->
    <DialogHost />

    <!-- 全局 401 访问令牌弹窗：后端启用 API_TOKEN 鉴权后，任何接口返回 401 都会触发。
         放在最外层、不依赖 appReady，加载阶段也能弹出。 -->
    <div v-if="showTokenDialog" class="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4">
      <form class="w-full max-w-md border border-[#3c3c3c] bg-[#202020] p-6 shadow-2xl" @submit.prevent="saveToken">
        <h2 class="mb-2 text-lg font-semibold text-white">需要访问令牌</h2>
        <p class="mb-4 text-xs leading-relaxed text-white/50">后端已启用 API 鉴权（安全加固）。请粘贴 server/.env 中 API_TOKEN 的值，保存后页面自动刷新。</p>
        <input v-model="tokenInput" autofocus autocomplete="off" class="mb-5 w-full border border-[#404040] bg-[#151515] px-3 py-2.5 font-mono text-sm text-white outline-none focus:border-[#c7ff00]" placeholder="粘贴 API_TOKEN" />
        <div class="flex justify-end">
          <button type="submit" class="bg-[#c7ff00] px-5 py-2 text-xs font-semibold text-black disabled:opacity-50" :disabled="!tokenInput.trim()">保存并刷新</button>
        </div>
      </form>
    </div>
  </div>
</template>
