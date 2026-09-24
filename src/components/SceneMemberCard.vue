<script setup>
const props = defineProps({
  scene: { type: Object, required: true },
  member: { type: Object, default: null },
  locked: { type: Boolean, default: false },
  generating: { type: Boolean, default: false },
  multiSelect: { type: Boolean, default: false },
  selected: { type: Boolean, default: false },
  // { label, detail }：图过时角标（基准已换/布局已变/描述已改），null 不显示
  stale: { type: Object, default: null },
})

const emit = defineEmits(['card-click', 'generate', 'edit', 'upload', 'delete', 'delete-image', 'cancel-generate', 'set-baseline'])
</script>

<template>
  <div
    class="group relative flex w-56 cursor-pointer flex-col overflow-hidden rounded-xl border bg-bg-card transition"
    :class="[
      multiSelect && selected ? 'border-accent ring-2 ring-accent/40' : 'border-border hover:border-accent/30',
      multiSelect && generating ? 'cursor-not-allowed opacity-70' : '',
      locked ? 'pointer-events-none opacity-45 grayscale' : '',
    ]"
    @click="emit('card-click')"
  >
    <div class="relative h-28 overflow-hidden bg-white">
      <img v-if="scene.imageUrl" :src="scene.imageUrl" :alt="scene.name" class="h-full w-full object-cover" />
      <div v-else class="flex h-full items-center justify-center">
        <svg class="h-8 w-8 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
      </div>
      <span v-if="member?.sceneNumber" class="absolute left-2 top-2 flex h-5 items-center rounded-pill bg-black/75 px-2 text-micro text-white backdrop-blur">场 {{ member.sceneNumber }}</span>
      <!-- 过时角标：放遮罩前的 DOM 位置，生成中/锁定遮罩能盖住它；
           hover 时与右上角删除按钮同位，让位淡出（多选/锁定态无删除按钮，不淡出） -->
      <span
        v-if="stale"
        class="pointer-events-none absolute right-2 top-2 flex h-5 items-center rounded-pill bg-amber-500/90 px-2 text-micro font-medium text-black backdrop-blur transition"
        :class="multiSelect || locked ? '' : 'group-hover:opacity-0'"
        :title="stale.detail"
      >{{ stale.label }}</span>
      <div
        v-if="multiSelect"
        class="pointer-events-none absolute left-2 top-9 z-10 flex h-6 w-6 items-center justify-center rounded-md border transition"
        :class="[selected ? 'border-accent bg-accent' : 'border-white/70 bg-black/50 backdrop-blur', generating ? 'opacity-40' : '']"
      >
        <svg v-if="selected" class="h-3.5 w-3.5 text-black" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" /></svg>
      </div>
      <div v-if="generating" class="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/60 backdrop-blur-sm">
        <svg class="h-6 w-6 animate-spin text-info" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
        <span class="text-micro text-info">生成中 · 照参考图画</span>
        <button class="rounded bg-white/15 px-2 py-0.5 text-micro text-white transition hover:bg-danger" @click.stop="emit('cancel-generate')">取消</button>
      </div>
      <div v-else-if="locked" class="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-bg-primary/35">
        <svg class="h-4 w-4 text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 018 0v4" /></svg>
        <span class="rounded-pill bg-black/70 px-2 py-0.5 text-micro text-text-secondary">先定参考图</span>
        <button v-if="scene.imageUrl" class="mt-1 rounded bg-accent px-2.5 py-1 text-micro font-medium text-black transition hover:bg-accent-hover" title="把这张图直接设为这组的参考图，不用重画代表场景" @click.stop="emit('set-baseline')">
          就用这张当参考图
        </button>
      </div>
      <button
        v-if="!generating && !multiSelect && !locked"
        class="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-md bg-black/60 text-white opacity-0 backdrop-blur transition hover:bg-red-500 group-hover:opacity-100"
        title="删除"
        @click.stop="emit('delete')"
      >
        <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
      </button>
      <div v-if="!multiSelect && !locked" class="absolute bottom-0 left-0 right-0 flex gap-1 bg-black/70 p-1.5 opacity-0 backdrop-blur transition group-hover:opacity-100">
        <button class="flex flex-1 items-center justify-center gap-1 rounded bg-accent/90 py-1 text-[11px] font-medium text-black transition hover:bg-accent disabled:opacity-60" :disabled="generating" @click.stop="emit('generate')">
          <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>{{ generating ? '生成中' : 'AI生成' }}
        </button>
        <button v-if="scene.imageUrl" class="flex flex-1 items-center justify-center gap-1 rounded bg-white/10 py-1 text-[11px] text-white transition hover:bg-white/20 disabled:opacity-60" :disabled="generating" title="以当前图为底图调整场景细节，保持整体不变" @click.stop="emit('edit')">
          <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>改造
        </button>
        <button class="flex flex-1 items-center justify-center gap-1 rounded bg-white/10 py-1 text-[11px] text-white transition hover:bg-white/20" @click.stop="emit('upload')">
          <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>上传
        </button>
      </div>
    </div>
    <div class="flex-1 p-2.5">
      <div class="flex items-center gap-1">
        <div class="min-w-0 flex-1 truncate text-2xs font-medium text-text-primary">{{ scene.name }}</div>
        <button
          v-if="!multiSelect && !locked"
          class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-muted transition hover:bg-bg-hover hover:text-white"
          title="上传一张自己的图片（支持上传本地图片，也可从素材库选）"
          @click.stop="emit('upload')"
        >
          <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
        </button>
        <button
          v-if="!multiSelect && !locked && scene.imageUrl"
          class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-muted transition hover:bg-bg-hover hover:text-danger"
          title="删除这张图片（场景卡片和描述都保留）"
          @click.stop="emit('delete-image')"
        >
          <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
        </button>
      </div>
      <div v-if="member?.spatialRole" class="mt-0.5 flex items-center gap-1 truncate text-micro text-text-muted" :title="`组内视角：${member.spatialRole}`">
        <svg class="h-3 w-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5l-5 7 5 7M16 5l5 7-5 7" /></svg>{{ member.spatialRole }}
      </div>
      <p v-if="scene.description" class="mt-1 line-clamp-2 text-micro leading-relaxed text-text-secondary">{{ scene.description }}</p>
    </div>
  </div>
</template>
