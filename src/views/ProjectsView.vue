<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../services/api'
import { useProjectStore } from '../stores/project'
import IpLibraryDialog from '../components/IpLibraryDialog.vue'

const router = useRouter()
const showIpLibrary = ref(false)
const store = useProjectStore()
const projects = ref([])
const loading = ref(true)
const error = ref('')
const keyword = ref('')
const sortBy = ref('latest')
const showCreateDialog = ref(false)
const creating = ref(false)
const newProjectTitle = ref('')
const newProjectTheme = ref('')
const showDeleteDialog = ref(false)
const deletingProject = ref(null)
const deleting = ref(false)

const filteredProjects = computed(() => {
  const q = keyword.value.trim().toLowerCase()
  const result = projects.value.filter((project) => {
    if (!q) return true
    return `${project.title || ''} ${project.theme || ''}`.toLowerCase().includes(q)
  })
  return [...result].sort((a, b) => {
    if (sortBy.value === 'name') return String(a.title || '').localeCompare(String(b.title || ''), 'zh-CN')
    if (sortBy.value === 'oldest') return String(a.updated_at || '').localeCompare(String(b.updated_at || ''))
    return String(b.updated_at || '').localeCompare(String(a.updated_at || ''))
  })
})

function formatDate(value) {
  if (!value) return '刚刚更新'
  const date = new Date(value.replace(' ', 'T') + (value.endsWith('Z') ? '' : 'Z'))
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

async function loadProjects() {
  loading.value = true
  error.value = ''
  try {
    projects.value = await api.getProjects()
  } catch (e) {
    error.value = e.message || '项目加载失败'
  } finally {
    loading.value = false
  }
}

async function enterProject(project) {
  await store.selectProject(project.id)
  router.push('/episodes')
}

function openCreate() {
  newProjectTitle.value = ''
  newProjectTheme.value = ''
  showCreateDialog.value = true
}

async function createProject() {
  const title = newProjectTitle.value.trim()
  if (!title || creating.value) return
  creating.value = true
  try {
    const project = await api.createProject({ title, theme: newProjectTheme.value.trim() })
    projects.value = [project, ...projects.value]
    showCreateDialog.value = false
    await enterProject(project)
  } catch (e) {
    error.value = e.message || '创建项目失败'
  } finally {
    creating.value = false
  }
}

async function openDelete(project) {
  deletingProject.value = project
  showDeleteDialog.value = true
}

async function confirmDelete() {
  const project = deletingProject.value
  if (!project || deleting.value) return
  deleting.value = true
  try {
    await api.deleteProject(project.id)
    projects.value = projects.value.filter((p) => p.id !== project.id)
    try {
      if (Number(window.localStorage.getItem('story-current-project-id')) === project.id) {
        window.localStorage.removeItem('story-current-project-id')
      }
    } catch {}
    showDeleteDialog.value = false
    deletingProject.value = null
  } catch (e) {
    error.value = e.message || '删除项目失败'
  } finally {
    deleting.value = false
  }
}

onMounted(loadProjects)
</script>

<template>
  <div class="min-h-full w-full overflow-y-auto bg-[#151515] text-white">
    <header class="flex h-14 items-center justify-between border-b border-[#242424] bg-black px-14">
      <button class="flex items-center gap-2" @click="router.push('/projects')">
        <span class="rounded border border-white/70 px-2 py-0.5 text-[11px] font-black tracking-wide">RH</span>
        <span class="text-lg font-bold tracking-tight">ST<span class="text-[#c7ff00]">O</span>RY</span>
      </button>
      <nav class="flex items-center gap-3 text-xs">
        <button class="rounded-sm border border-[#2c2c2c] bg-[#1b1b1b] px-5 py-2 text-white/80 hover:text-white" @click="openCreate">开始创作</button>
        <button class="rounded-sm border border-[#2c2c2c] bg-[#1b1b1b] px-5 py-2 text-white/60">视频重绘</button>
        <button class="rounded-sm bg-[#c7ff00] px-5 py-2 font-medium text-black">我的项目</button>
        <button class="rounded-sm border border-[#2c2c2c] bg-[#1b1b1b] px-5 py-2 text-white/60 hover:border-[#c7ff00]/60 hover:text-white" @click="showIpLibrary = true">IP 角色库</button>
      </nav>
      <div class="flex items-center gap-5 text-sm text-white/70">
        <span class="font-bold text-[#c7ff00]">R</span><span>♧</span><span>♧</span>
        <span class="flex h-7 w-7 items-center justify-center rounded-full border border-[#5772ff] bg-[#18214d] text-xs">我</span>
      </div>
    </header>

    <main class="px-14 py-8">
      <div class="mb-8 flex items-end justify-between border-b border-[#262626]">
        <div class="flex gap-8">
          <button class="border-b-2 border-[#c7ff00] pb-4 text-sm text-white">我的项目</button>
          <button class="pb-4 text-sm text-white/40">我的发布</button>
        </div>
      </div>

      <section class="mb-5 flex items-center justify-between">
        <div class="flex items-center gap-8">
          <h1 class="text-xl font-semibold">剧本项目</h1>
          <button class="text-sm text-white/35">重绘项目</button>
        </div>
        <div class="flex items-center gap-3">
          <label class="relative">
            <span class="sr-only">搜索项目</span>
            <input v-model="keyword" class="w-64 border border-[#383838] bg-[#1a1a1a] px-3 py-2 text-xs text-white outline-none placeholder:text-white/30 focus:border-[#c7ff00]" placeholder="搜索项目名称/简介" />
          </label>
          <select v-model="sortBy" class="border border-[#383838] bg-[#1a1a1a] px-3 py-2 text-xs text-white/75 outline-none">
            <option value="latest">排序　最新</option>
            <option value="oldest">排序　最早</option>
            <option value="name">排序　名称</option>
          </select>
          <button class="border border-[#c7ff00] px-4 py-2 text-xs text-[#c7ff00] hover:bg-[#c7ff00]/10">发布至剧场</button>
          <button class="bg-[#c7ff00] px-5 py-2 text-xs font-semibold text-black hover:bg-[#d8ff4a]" @click="openCreate">新建项目</button>
        </div>
      </section>

      <div v-if="loading" class="py-20 text-center text-sm text-white/40">正在加载项目...</div>
      <div v-else-if="error" class="border border-red-400/30 bg-red-400/10 p-4 text-sm text-red-200">{{ error }} <button class="ml-3 underline" @click="loadProjects">重试</button></div>
      <div v-else-if="!filteredProjects.length" class="border border-dashed border-[#383838] py-20 text-center text-sm text-white/40">没有匹配的项目，点击“新建项目”开始创作。</div>
      <div v-else class="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-4">
        <div v-for="project in filteredProjects" :key="project.id" class="group relative overflow-hidden border border-[#303030] bg-[#1b1b1d] text-left transition hover:-translate-y-1 hover:border-[#c7ff00]/70" @click="enterProject(project)">
          <div class="relative aspect-[1.72] overflow-hidden bg-[radial-gradient(ellipse_at_center,#5c6629_0%,#25290e_35%,#121212_75%)]">
            <button class="absolute bottom-3 right-3 z-10 flex h-7 w-7 items-center justify-center rounded-md bg-black/60 text-white opacity-0 backdrop-blur transition hover:bg-red-500 group-hover:opacity-100" title="删除项目" @click.stop="openDelete(project)">
              <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
            </button>
            <div class="absolute inset-x-8 bottom-7 h-8 rounded-[50%] border border-[#c7ff00]/40 shadow-[0_0_30px_#b9e40055]" />
            <div class="absolute inset-0 bg-[linear-gradient(135deg,transparent_0%,transparent_42%,#c7ff0015_43%,transparent_44%,transparent_65%,#c7ff0010_66%,transparent_67%)]" />
            <div class="absolute inset-0 flex items-center justify-center text-xl font-bold tracking-tight text-white/85">RH <span class="text-[#c7ff00]">STORY</span></div>
            <span class="absolute right-3 top-3 rounded bg-black/50 px-2 py-1 text-[10px] text-white/60">项目 {{ project.id }}</span>
          </div>
          <div class="border-t border-[#303030] px-4 py-3">
            <h2 class="truncate text-sm font-medium text-white group-hover:text-[#c7ff00]">{{ project.title || '未命名项目' }}</h2>
            <p class="mt-2 truncate text-[11px] text-white/35">{{ project.episode_count || 0 }} 集 · {{ formatDate(project.updated_at) }}</p>
          </div>
        </div>
      </div>
    </main>

    <div v-if="showCreateDialog" class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" @click.self="showCreateDialog = false">
      <form class="w-full max-w-md border border-[#3c3c3c] bg-[#202020] p-6 shadow-2xl" @submit.prevent="createProject">
        <div class="mb-5 flex items-center justify-between"><h2 class="text-lg font-semibold">新建项目</h2><button type="button" class="text-white/40 hover:text-white" @click="showCreateDialog = false">×</button></div>
        <label class="mb-4 block text-xs text-white/60">项目名称<input v-model="newProjectTitle" autofocus class="mt-2 w-full border border-[#404040] bg-[#151515] px-3 py-2.5 text-sm outline-none focus:border-[#c7ff00]" placeholder="例如：布布与一二的野餐日记" /></label>
        <label class="mb-6 block text-xs text-white/60">项目简介（可选）<textarea v-model="newProjectTheme" rows="3" class="mt-2 w-full resize-none border border-[#404040] bg-[#151515] px-3 py-2.5 text-sm outline-none focus:border-[#c7ff00]" placeholder="一句话描述故事主题" /></label>
        <div class="flex justify-end gap-3"><button type="button" class="border border-[#444] px-4 py-2 text-xs text-white/60" @click="showCreateDialog = false">取消</button><button type="submit" class="bg-[#c7ff00] px-5 py-2 text-xs font-semibold text-black disabled:opacity-50" :disabled="creating || !newProjectTitle.trim()">{{ creating ? '创建中...' : '创建并开始' }}</button></div>
      </form>
    </div>

    <div v-if="showDeleteDialog" class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" @click.self="showDeleteDialog = false">
      <div class="w-full max-w-md border border-[#3c3c3c] bg-[#202020] p-6 shadow-2xl">
        <div class="mb-4 flex items-center gap-2">
          <span class="text-lg text-red-400">⚠️</span>
          <h2 class="text-lg font-semibold">删除项目</h2>
        </div>
        <p class="mb-6 text-sm leading-relaxed text-white/70">确定删除「{{ deletingProject && deletingProject.title ? deletingProject.title : '未命名项目' }}」吗？该项目下的所有集、剧本、分镜与素材会一并删除，且不可恢复。</p>
        <div class="flex justify-end gap-3">
          <button type="button" class="border border-[#444] px-4 py-2 text-xs text-white/60" @click="showDeleteDialog = false">取消</button>
          <button type="button" class="bg-red-500 px-5 py-2 text-xs font-semibold text-white hover:bg-red-600 disabled:opacity-50" :disabled="deleting" @click="confirmDelete">{{ deleting ? '删除中...' : '删除' }}</button>
        </div>
      </div>
    </div>

    <IpLibraryDialog v-if="showIpLibrary" @close="showIpLibrary = false" />
  </div>
</template>
