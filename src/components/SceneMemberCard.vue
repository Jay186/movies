<script setup>
// 场景空间组成员卡（2026-09-17 空间组视图）
//
// 设计依据：design/scene-groups-design-spec.md §4 MemberCard + 原型 scene-groups-redesign.html
// 职责边界：**只管展示与状态**（场号 / 视角角色 / 锁定 / 生成中 / 多选勾选），
// 一切业务动作（生成 / 改造 / 上传 / 删除 / 详情）emit 给父级 —— 父级（SettingsView）
// 已有全部 handler，本组件不重复接线。
//
// 状态三重编码（可访问性）：锁定 = 灰度 + 锁 icon + 「先定参考图」文字；
// 生成中 = 覆盖层 + spinner + 文案；选中 = ring + 勾选框。
const props = defineProps({
  // store.assetScenes 里的资产对象（id/name/description/imageUrl）
  scene: { type: Object, required: true },
  // 空间组视图数据（status API 的 memberScenes 项）：sceneNumber / spatialRole
  member: { type: Object, default: null },
  locked: { type: Boolean, default: false },      // 组参考图未定 → 成员不可生成
  generating: { type: Boolean, default: false },  // AI 生成中
  multiSelect: { type: Boolean, default: false }, // 多选模式
  selected: { type: Boolean, default: false },    // 多选选中
})

const emit = defineEmits(['card-click', 'generate', 'edit', 'upload', 'delete', 'cancel-generate'])
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
      <!-- 场号 pill（左上）：空间组内的叙事坐标 -->
      <span v-if="member?.sceneNumber" class="absolute left-2 top-2 flex h-5 items-center rounded-pill bg-black/75 px-2 text-micro text-white backdrop-blur">场 {{ member.sceneNumber }}</span>
      <!-- 多选勾选框 -->
      <div
        v-if="multiSelect"
        class="pointer-events-none absolute left-2 top-9 z-10 flex h-6 w-6 items-center justify-center rounded-md border transition"
        :class="[selected ? 'border-accent bg-accent' : 'border-white/70 bg-black/50 backdrop-blur', generating ? 'opacity-40' : '']"
      >
        <svg v-if="selected" class="h-3.5 w-3.5 text-black" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" /></svg>
      </div>
      <!-- 生成中覆盖层 -->
      <div v-if="generating" class="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/60 backdrop-blur-sm">
        <svg class="h-6 w-6 animate-spin text-info" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
        <span class="text-micro text-info">生成中 · 照参考图画</span>
        <button class="rounded bg-white/15 px-2 py-0.5 text-micro text-white transition hover:bg-danger" @click.stop="emit('cancel-generate')">取消</button>
      </div>
      <!-- 锁定覆盖层：组参考图未定（与组卡状态同口径） -->
      <div v-else-if="locked" class="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-bg-primary/35">
        <svg class="h-4 w-4 text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 018 0v4" /></svg>
        <span class="rounded-pill bg-black/70 px-2 py-0.5 text-micro text-text-secondary">先定参考图</span>
      </div>
      <!-- 删除（hover 浮现；多选/生成中隐藏） -->
      <button
        v-if="!generating && !multiSelect && !locked"
        class="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-md bg-black/60 text-white opacity-0 backdrop-blur transition hover:bg-red-500 group-hover:opacity-100"
        title="删除"
        @click.stop="emit('delete')"
      >
        <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
      </button>
      <!-- hover 操作栏（多选/锁定时隐藏） -->
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
      <div class="truncate text-2xs font-medium text-text-primary">{{ scene.name }}</div>
      <!-- 视角角色（spatial_role）：组内视角声明入口 -->
      <div v-if="member?.spatialRole" class="mt-0.5 flex items-center gap-1 truncate text-micro text-text-muted" :title="`组内视角：${member.spatialRole}`">
        <svg class="h-3 w-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5l-5 7 5 7M16 5l5 7-5 7" /></svg>{{ member.spatialRole }}
      </div>
      <p v-else-if="scene.description" class="mt-1 line-clamp-2 text-micro leading-relaxed text-text-secondary">{{ scene.description }}</p>
    </div>
  </div>
</template>
