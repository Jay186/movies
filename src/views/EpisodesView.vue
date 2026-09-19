<script setup>
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useProjectStore } from '../stores/project'
import { ASPECT_RATIO_OPTIONS } from '../constants/app'

const router = useRouter()
const store = useProjectStore()

onMounted(async () => {
  if (!store.currentProjectId) {
    router.replace('/projects')
    return
  }
  if (!store.episodes.length) {
    await store.loadEpisodes(store.currentProjectId)
  }
})

const episodes = computed(() => store.episodes)

const projectAspectRatio = computed({
  get: () => store.aspectRatio,
  set: (v) => { store.updateProjectAspectRatio(v) },
})
const ratioLabel = computed(() => {
  const opt = ASPECT_RATIO_OPTIONS.find((o) => o.value === store.aspectRatio)
  return opt ? `${opt.label} ${opt.desc}` : store.aspectRatio
})

function hasScript(ep) {
  return (ep.script_content || '').trim().length > 0
}
function epName(ep) {
  return ep.title || `第 ${ep.episode_number} 集`
}

async function openEpisode(ep) {
  await store.switchEpisode(ep.id)
  router.push('/script')
}

async function addEpisode() {
  await store.addEpisode({ title: '' })
}

async function removeEpisode(ep) {
  if (!confirm(`确定删除「${epName(ep)}」吗？该集下的剧本、分镜与素材会一并删除且不可恢复。`)) return
  await store.removeEpisode(ep.id)
}
</script>

<template>
  <div class="min-h-full w-full overflow-y-auto bg-[#151515] text-white">
    <header class="flex h-14 items-center justify-between border-b border-[#242424] bg-black px-14">
      <button class="flex items-center gap-2 text-white/70 transition hover:text-white" @click="router.push('/projects')">
        <span class="rounded border border-white/70 px-2 py-0.5 text-[11px] font-black tracking-wide">RH</span>
        <span class="text-lg font-bold tracking-tight">ST<span class="text-[#c7ff00]">O</span>RY</span>
      </button>
      <div class="flex items-center gap-3 text-xs">
        <button class="rounded-sm border border-[#2c2c2c] bg-[#1b1b1b] px-5 py-2 text-white/80 hover:text-white" @click="router.push('/projects')">我的项目</button>
        <button class="rounded-sm bg-[#c7ff00] px-5 py-2 font-medium text-black">剧集</button>
      </div>
      <div class="flex h-8 w-8 items-center justify-center rounded-full border border-[#5772ff] bg-[#18214d] text-xs">我</div>
    </header>

    <main class="px-14 py-8">
      <div class="mb-6 border-b border-[#262626] pb-5">
        <div class="text-xs text-white/40">我的项目 / <b class="text-white/70">{{ store.projectTitle }}</b></div>
        <div class="mt-2 flex items-end justify-between gap-4">
          <div>
            <h1 class="text-xl font-semibold">{{ store.projectTitle }} · 剧集</h1>
            <p class="mt-1 text-sm text-white/40">点任一集进入它的剧本页 · 数据按集隔离，默认都在第 1 集</p>
          </div>
          <div class="flex items-center gap-2 pb-0.5" title="项目级设置：该项目所有集的分镜图与出片统一使用此比例；只影响新生成的内容">
            <span class="text-xs text-white/40">默认比例</span>
            <select
              v-model="projectAspectRatio"
              class="border border-[#383838] bg-[#1a1a1a] px-2.5 py-1.5 text-xs text-white/80 outline-none focus:border-[#c7ff00]"
            >
              <option
                v-for="opt in ASPECT_RATIO_OPTIONS"
                :key="opt.value"
                :value="opt.value"
                class="bg-[#1a1a1a]"
              >{{ opt.label }}（{{ opt.desc }}）</option>
            </select>
          </div>
        </div>
        <p class="mt-1 text-[11px] text-white/25">当前 {{ ratioLabel }} · 对该项目下所有集生效：分镜图与出片统一使用，已生成的内容不会被追溯修改</p>
      </div>

      <div v-if="!episodes.length" class="border border-dashed border-[#383838] py-20 text-center text-sm text-white/40">
        该项目还没有剧集，点击「新增剧集」开始。
      </div>
      <div v-else class="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-4">
        <div
          v-for="ep in episodes"
          :key="ep.id"
          class="group relative overflow-hidden border border-[#303030] bg-[#1b1b1d] text-left transition hover:-translate-y-1 hover:border-[#c7ff00]/70"
          @click="openEpisode(ep)"
        >
          <div class="relative aspect-[1.72] overflow-hidden bg-[radial-gradient(ellipse_at_center,#5c6629_0%,#25290e_35%,#121212_75%)]">
            <button
              class="absolute bottom-3 right-3 z-10 flex h-7 w-7 items-center justify-center rounded-md bg-black/60 text-white opacity-0 backdrop-blur transition hover:bg-red-500 group-hover:opacity-100"
              title="删除剧集"
              @click.stop="removeEpisode(ep)"
            >
              <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
            </button>
            <span class="absolute right-3 top-3 rounded bg-black/50 px-2 py-1 text-[10px] text-white/60">第 {{ ep.episode_number }} 集</span>
            <span
              class="absolute left-3 top-3 rounded px-2 py-1 text-[10px]"
              :class="hasScript(ep) ? 'bg-[#c7ff00]/20 text-[#c7ff00]' : 'bg-black/40 text-white/40'"
            >{{ hasScript(ep) ? '有内容' : '空' }}</span>
            <div class="absolute inset-0 flex items-center justify-center text-4xl font-bold text-white/85">{{ ep.episode_number }}</div>
          </div>
          <div class="border-t border-[#303030] px-4 py-3">
            <h2 class="truncate text-sm font-medium text-white group-hover:text-[#c7ff00]">{{ epName(ep) }}</h2>
            <p class="mt-1 truncate text-[11px] text-white/35">
              {{ hasScript(ep) ? `剧本 ${ep.script_content.length} 字` : '尚未编写剧本' }}
            </p>
          </div>
        </div>

        <button
          class="flex min-h-[200px] flex-col items-center justify-center border border-dashed border-[#383838] bg-transparent text-white/50 transition hover:border-[#c7ff00] hover:text-[#c7ff00]"
          @click="addEpisode"
        >
          <span class="flex h-10 w-10 items-center justify-center rounded-full border border-current text-xl">+</span>
          <span class="mt-3 text-sm">新增剧集</span>
        </button>
      </div>
    </main>
  </div>
</template>
