<script setup>
import { ref, computed } from 'vue'
import { MODEL_CONFIG_TEXT as T } from '../constants/modelConfig'

// 可搜索选择 + 手填兜底的模型选择器：
// 底层始终是普通 <input>（保留自由填写），聚焦 / 输入时在下方浮出候选列表，
// 候选项来自启明星模型广场（由父组件传入 options），点选即把 name 写入 model_id。
const props = defineProps({
  modelValue: { type: String, default: '' },
  options: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' },
  placeholder: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue', 'change', 'pick'])

const FIELD_INPUT =
  'w-full min-w-0 rounded-control border border-border-light bg-bg-secondary px-[11px] py-[7px] text-[13px] text-text-primary outline-none transition hover:border-border-strong focus:border-accent read-only:text-text-muted'

const open = ref(false)
const query = ref('')

const filtered = computed(() => {
  const list = Array.isArray(props.options) ? props.options : []
  const q = query.value.trim().toLowerCase()
  if (!q) return list
  return list.filter((m) => {
    const name = String(m?.name || '').toLowerCase()
    const group = String(m?.group_name || '').toLowerCase()
    return name.includes(q) || group.includes(q)
  })
})

// 副行：平台 · 分组 · 官方价 ×倍率（多分组时追加「另有 N 个分组」）
function optionDetail(m) {
  const parts = []
  if (m?.platform) parts.push(String(m.platform))
  if (m?.group_name) parts.push(String(m.group_name))
  if (m?.rate_multiplier != null && m.rate_multiplier !== '') {
    parts.push(`${T.modelPricePrefix} ×${m.rate_multiplier}`)
  }
  const groupCount = Array.isArray(m?.groups) ? m.groups.length : 0
  if (groupCount > 1) parts.push(T.modelGroupsMore(groupCount - 1))
  return parts.join(' · ')
}

function onInput(e) {
  emit('update:modelValue', e.target.value)
  query.value = e.target.value
  open.value = true
}

function onFocus() {
  open.value = true
  query.value = ''
}

function onBlur() {
  open.value = false
  emit('change')
}

function pick(m) {
  emit('update:modelValue', m?.name || '')
  open.value = false
  query.value = ''
  emit('change')
  // 独立的「选中某条候选」事件：与 change（含 blur）区分，供「选中即执行动作」的场景用
  emit('pick', m)
}
</script>

<template>
  <div class="relative min-w-0 flex-1">
    <input
      :value="modelValue"
      :placeholder="placeholder"
      autocomplete="off"
      spellcheck="false"
      class="font-mono"
      :class="FIELD_INPUT"
      @input="onInput"
      @focus="onFocus"
      @blur="onBlur"
      @keydown.esc="open = false"
    />

    <div
      v-if="open"
      class="pop-scroll absolute left-0 right-0 top-full z-30 mt-1 max-h-[220px] overflow-y-auto rounded-control border border-border-light bg-bg-card py-1 shadow-pop"
    >
      <p v-if="loading" class="px-3 py-1.5 text-[11px] text-text-muted">{{ T.modelPickerLoading }}</p>

      <template v-if="error">
        <p class="break-words px-3 py-1.5 text-[11px] text-danger">{{ T.modelPickerFailed(error) }}</p>
        <p class="px-3 pb-1.5 text-[11px] text-text-muted">{{ T.modelPickerManualHint }}</p>
      </template>

      <template v-if="options.length">
        <p v-if="!filtered.length" class="px-3 py-1.5 text-[11px] text-text-muted">{{ T.modelPickerNoMatch }}</p>
        <button
          v-for="m in filtered"
          :key="`${m.name}__${m.group_name || ''}`"
          type="button"
          class="block w-full px-3 py-1.5 text-left transition hover:bg-bg-hover"
          @mousedown.prevent="pick(m)"
        >
          <span class="block truncate font-mono text-[12px] text-text-primary">{{ m.name }}</span>
          <span v-if="optionDetail(m)" class="block truncate text-[11px] text-text-muted">{{ optionDetail(m) }}</span>
        </button>
      </template>

      <p v-else-if="!loading && !error" class="px-3 py-1.5 text-[11px] text-text-muted">
        {{ T.modelPickerEmpty }} · {{ T.modelPickerManualHint }}
      </p>
    </div>
  </div>
</template>

<style scoped>
/* 候选列表滚动条：深色细条，替代浏览器默认的白色宽滚动条 */
.pop-scroll::-webkit-scrollbar {
  width: 6px;
}
.pop-scroll::-webkit-scrollbar-track {
  background: transparent;
}
.pop-scroll::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: #45454f;
}
.pop-scroll::-webkit-scrollbar-thumb:hover {
  background: #5a5a65;
}
.pop-scroll {
  scrollbar-width: thin;
  scrollbar-color: #45454f transparent;
}
</style>
