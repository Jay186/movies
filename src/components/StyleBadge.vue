<script setup>
import { ref, computed } from 'vue'
import { useProjectStore } from '../stores/project'

const store = useProjectStore()

const style = computed(() => store.currentStyle || null)
const coverUrl = computed(() => style.value?.coverUrl || '')
const label = computed(() => style.value?.label || '未选择画风')
const emoji = computed(() => style.value?.emoji || '')
const failed = ref(false)
</script>

<template>
  <span
    class="flex min-w-0 items-center gap-1.5"
    :title="`当前画风：${label}（在画风页修改）`"
  >
    <span class="relative block h-5 w-5 shrink-0 overflow-hidden rounded-[6px] bg-bg-primary">
      <img
        v-if="coverUrl && !failed"
        :src="coverUrl"
        :alt="label"
        class="h-full w-full object-cover"
        @error="failed = true"
      />
      <span v-else-if="emoji" class="flex h-full w-full items-center justify-center text-text-muted">
        <span class="text-xs">{{ emoji }}</span>
      </span>
    </span>
    <span class="max-w-[96px] truncate text-[12px] text-text-secondary">{{ label }}</span>
  </span>
</template>
