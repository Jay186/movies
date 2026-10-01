<script setup>
import { ref, computed, watch } from 'vue'
import { api } from '../services/api'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  type: { type: String, default: 'character' }, 
  projectId: { type: [Number, String], default: null },
})
const emit = defineEmits(['update:modelValue', 'create', 'select'])

const tab = ref('manual') 
const loading = ref(false)
const projectItems = ref([])
const selectedIds = ref(new Set())

const form = ref({
  name: '',
  role: '配角',
  identity: '', 
  appearance: '', 
  visualPrompt: '', 
  outfits: [{ label: '主形象', desc: '' }], 
})

const titles = {
  character: '新建角色',
  scene: '新建场景',
  prop: '新建道具',
}

const nameLabels = {
  character: '角色名字',
  scene: '场景名称',
  prop: '道具名称',
}

const namePlaceholders = {
  character: '例如：角色名 / 角色名（幼年）',
  scene: '例如：城市天台',
  prop: '例如：青铜钥匙',
}

const show = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
})

watch(() => props.modelValue, (v) => {
  if (v) {
    tab.value = 'manual'
    form.value = {
      name: '', role: '配角', identity: '', appearance: '', visualPrompt: '',
      outfits: [{ label: '主形象', desc: '' }],
    }
    selectedIds.value = new Set()
    projectItems.value = []
  }
})

async function switchTab(t) {
  tab.value = t
  if (t === 'project' && props.projectId && projectItems.value.length === 0) {
    loading.value = true
    try {
      const typeMap = { character: 'characters', scene: 'scenes', prop: 'props' }
      projectItems.value = await api.getProjectAssets(props.projectId, typeMap[props.type])
    } catch (e) {
      console.warn('获取项目资产失败:', e.message)
    } finally {
      loading.value = false
    }
  }
}

function addOutfit() {
  form.value.outfits.push({ label: `服饰${form.value.outfits.length + 1}`, desc: '' })
}

function removeOutfit(i) {
  form.value.outfits.splice(i, 1)
}

function toggleSelect(id) {
  if (selectedIds.value.has(id)) {
    selectedIds.value.delete(id)
  } else {
    selectedIds.value.add(id)
  }
}

function canCreate() {
  if (!form.value.name.trim()) return false
  if (props.type === 'character') {
    return form.value.identity.trim() && form.value.appearance.trim()
  }
  return form.value.visualPrompt.trim()
}

function handleCreate() {
  if (!canCreate()) return
  const data = { name: form.value.name.trim() }
  if (props.type === 'character') {
    data.role = form.value.role
    data.description = `身份：${form.value.identity.trim()}\n外貌：${form.value.appearance.trim()}`
    if (form.value.outfits.some(o => o.desc.trim())) {
      data.description += '\n服饰：' + form.value.outfits.filter(o => o.desc.trim()).map(o => `${o.label}：${o.desc.trim()}`).join('；')
    }
  } else {
    data.description = form.value.visualPrompt.trim()
  }
  emit('create', data)
  show.value = false
}

function handleSelect() {
  const items = projectItems.value.filter(i => selectedIds.value.has(i.id))
  if (items.length === 0) return
  emit('select', items)
  show.value = false
}

function close() {
  show.value = false
}
</script>

<template>
  <Teleport to="body">
    <div v-if="show" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60" @click.self="close">
      <div class="flex max-h-[85vh] w-[560px] flex-col overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-2xl">
        <div class="flex items-center justify-between border-b border-border px-6 py-4">
          <h3 class="text-base font-semibold text-white">{{ titles[type] }}</h3>
          <button class="text-text-muted hover:text-white" @click="close">
            <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div class="flex gap-2 px-6 pt-4">
          <button
            class="rounded-lg px-5 py-2 text-sm font-medium transition"
            :class="tab === 'manual' ? 'bg-bg-hover text-white' : 'text-text-secondary hover:text-white'"
            @click="switchTab('manual')"
          >
            手填新建
          </button>
          <button
            class="rounded-lg px-5 py-2 text-sm font-medium transition"
            :class="tab === 'project' ? 'bg-bg-hover text-white' : 'text-text-secondary hover:text-white'"
            @click="switchTab('project')"
          >
            从项目选择
          </button>
        </div>

        <div class="flex-1 overflow-y-auto px-6 py-4">
          <div v-if="tab === 'manual'" class="space-y-4">
            <div>
              <label class="mb-1.5 block text-sm text-text-secondary">
                {{ nameLabels[type] }} <span class="text-red-500">*必填</span>
              </label>
              <input
                v-model="form.name"
                type="text"
                :placeholder="namePlaceholders[type]"
                class="w-full rounded-lg border border-border bg-bg-primary px-3 py-2.5 text-sm text-white placeholder-text-muted outline-none focus:border-accent/50"
              />
            </div>

            <template v-if="type === 'character'">
              <div>
                <label class="mb-1.5 block text-sm text-text-secondary">
                  主体人物（性别/年龄/身份/性格） <span class="text-red-500">*必填</span>
                </label>
                <input
                  v-model="form.identity"
                  type="text"
                  placeholder="例如：一句话写清身份与性格特征"
                  class="w-full rounded-lg border border-border bg-bg-primary px-3 py-2.5 text-sm text-white placeholder-text-muted outline-none focus:border-accent/50"
                />
              </div>
              <div>
                <label class="mb-1.5 block text-sm text-text-secondary">
                  外貌特征（五官/体型/发型/肤色） <span class="text-red-500">*必填</span>
                </label>
                <textarea
                  v-model="form.appearance"
                  rows="3"
                  placeholder="例如：外貌的英文描述，体型 / 配色 / 五官 / 服饰……"
                  class="w-full resize-none rounded-lg border border-border bg-bg-primary px-3 py-2.5 text-sm text-white placeholder-text-muted outline-none focus:border-accent/50"
                />
              </div>
              <div>
                <div class="mb-1.5 flex items-center justify-between">
                  <label class="text-sm text-text-secondary">服饰（{{ form.outfits.length }}套）</label>
                  <button
                    class="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-text-secondary hover:border-accent/50 hover:text-white"
                    @click="addOutfit"
                  >
                    <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
                    </svg>
                    添加服饰
                  </button>
                </div>
                <div v-for="(outfit, i) in form.outfits" :key="i" class="mb-2 flex gap-2">
                  <input
                    v-model="outfit.label"
                    type="text"
                    class="w-20 shrink-0 rounded-lg border border-border bg-bg-primary px-2 py-2 text-xs text-accent outline-none focus:border-accent/50"
                  />
                  <input
                    v-model="outfit.desc"
                    type="text"
                    placeholder="穿搭、颜色、材质等可见描述"
                    class="flex-1 rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-white placeholder-text-muted outline-none focus:border-accent/50"
                  />
                  <button
                    v-if="form.outfits.length > 1"
                    class="shrink-0 text-text-muted hover:text-red-400"
                    @click="removeOutfit(i)"
                  >
                    <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
            </template>

            <template v-else>
              <div>
                <label class="mb-1.5 block text-sm text-text-secondary">
                  视觉提示词（用于生成图片） <span class="text-red-500">*必填</span>
                </label>
                <textarea
                  v-model="form.visualPrompt"
                  rows="4"
                  placeholder="环境、光线、色调、材质、细节等可见描述"
                  class="w-full resize-none rounded-lg border border-border bg-bg-primary px-3 py-2.5 text-sm text-white placeholder-text-muted outline-none focus:border-accent/50"
                />
              </div>
            </template>
          </div>

          <div v-if="tab === 'project'" class="min-h-[200px]">
            <div v-if="loading" class="flex h-40 items-center justify-center text-sm text-text-muted">
              <svg class="mr-2 h-4 w-4 animate-spin text-accent" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
              </svg>
              加载中...
            </div>
            <div v-else-if="projectItems.length === 0" class="flex h-40 items-center justify-center text-sm text-text-muted">
              项目中暂无可用的{{ type === 'character' ? '角色' : type === 'scene' ? '场景' : '道具' }}
            </div>
            <div v-else class="space-y-2">
              <label
                v-for="item in projectItems"
                :key="item.id"
                class="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-bg-primary p-3 transition hover:border-accent/30"
                :class="{ 'border-accent/60': selectedIds.has(item.id) }"
              >
                <input
                  type="checkbox"
                  :checked="selectedIds.has(item.id)"
                  class="mt-0.5 accent-accent"
                  @change="toggleSelect(item.id)"
                />
                <div class="flex-1">
                  <div class="flex items-center gap-2">
                    <span v-if="item.role" class="rounded bg-bg-hover px-1.5 py-0.5 text-[10px] text-text-secondary">{{ item.role }}</span>
                    <span class="text-sm font-medium text-white">{{ item.name || item.title }}</span>
                  </div>
                  <p v-if="item.description || item.summary" class="mt-1 text-xs leading-relaxed text-text-secondary line-clamp-2">
                    {{ item.description || item.summary }}
                  </p>
                </div>
              </label>
            </div>
          </div>
        </div>

        <div class="flex justify-end gap-3 border-t border-border px-6 py-4">
          <button
            class="rounded-lg border border-border px-5 py-2 text-sm text-text-secondary transition hover:bg-bg-hover"
            @click="close"
          >
            取消
          </button>
          <button
            v-if="tab === 'manual'"
            class="rounded-lg bg-accent px-5 py-2 text-sm font-medium text-black transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="!canCreate()"
            @click="handleCreate"
          >
            创建{{ type === 'character' ? '角色' : type === 'scene' ? '场景' : '道具' }}
          </button>
          <button
            v-else
            class="rounded-lg bg-accent px-5 py-2 text-sm font-medium text-black transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="selectedIds.size === 0"
            @click="handleSelect"
          >
            添加{{ selectedIds.size > 0 ? `（${selectedIds.size}）` : '' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
