<script setup>
import { ref, computed } from 'vue'
import { useProjectStore } from '../stores/project'

// 纯展示：显示当前选中的画风（封面小图 + 名称），不可点击修改。
// 2026-09-16 精简：去掉「当前画风」文字标注与自带边框。
//  - 标注是冗余的：缩略图 + 风格名本身已足够表意，写「当前画风」等于在标题上写「这是标题」
//  - 自带边框会与命令栏的视图组容器形成「框中框」，视觉噪音大
// 现在只输出「图 + 名」两个元素，外框交给父级容器统一处理。
const store = useProjectStore()

const style = computed(() => store.currentStyle || null)
const coverUrl = computed(() => style.value?.coverUrl || '')
const label = computed(() => style.value?.label || '未选择画风')
const emoji = computed(() => style.value?.emoji || '')
const failed = ref(false)
</script>

<template>
  <!-- 2026-09-17：根节点由 div 改为 span。
       本组件现在会被嵌进 <button>（设定页工具条的「画风」胶囊），而 button 的内容模型
       只接受短语内容（phrasing content），块级 div 属非法嵌套。改 span 后 HTML 合法，
       布局不变——flex 容器内的 flex 子项会被块化，inline-flex 与 flex 表现一致。 -->
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
