<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { useProjectStore } from '../stores/project'
import { confirmDialog, toastError } from '../services/dialog'
import ImportScriptDialog from '../components/ImportScriptDialog.vue'

const store = useProjectStore()
const router = useRouter()
const showReconfirmDialog = ref(false) // 重新确认剧本的确认弹窗
const showImportDialog = ref(false) // 导入剧本弹窗

// ===== 结构化场次编辑器 =====
// 正文区按「场次N：标题」切成场次卡；编辑卡 → 防抖重建 scriptContent（保持与后端纯文本兼容）
// 分隔符兼容冒号与空白（后端 doubao.js/scriptFormat.js 同口径，「场次N 标题」也认）
const SCENE_HEADER_RE = /^场次[一二三四五六七八九十\d]+[：:\s]\s*(.*)$/
let sceneBlockSeq = 0
const sceneBlocks = ref([]) // [{ id, num, title, body }]，id 稳定用于 DOM key
let rebuildTimer = null

function parseSceneBlocks(content) {
  const lines = String(content || '').split('\n')
  const blocks = []
  let current = null
  for (const line of lines) {
    const m = line.match(SCENE_HEADER_RE)
    if (m) {
      if (current) blocks.push(current)
      current = { id: ++sceneBlockSeq, title: (m[1] || '').trim(), body: '' }
    } else if (current) {
      current.body += (current.body ? '\n' : '') + line
    }
  }
  if (current) blocks.push(current)
  return blocks.map((b, i) => ({ ...b, num: i + 1 }))
}

function rebuildScript(blocks) {
  return blocks.map((b, i) => `场次${i + 1}：${b.title}${b.body ? '\n' + b.body : ''}`).join('\n')
}

function scheduleRebuild() {
  clearTimeout(rebuildTimer)
  rebuildTimer = setTimeout(() => {
    const content = rebuildScript(sceneBlocks.value)
    if (content !== store.scriptContent) store.scriptContent = content
  }, 300)
}

function applyBlocks(next) {
  sceneBlocks.value = next.map((b, i) => ({ ...b, num: i + 1 }))
  scheduleRebuild()
}

// 外部变化（导入 / 改写接受 / 版本回滚 / 确认归一化）→ 重建卡片
watch(
  () => store.scriptContent,
  (content) => {
    // 编辑防抖触发的回声：内容与当前卡片一致时跳过，
    // 否则会重新解析生成全新 id → 所有卡片重挂载 → 焦点丢失且滚动回顶部
    if (sceneBlocks.value.length && content === rebuildScript(sceneBlocks.value)) return
    const next = parseSceneBlocks(content)
    // 与现有块按位置对齐复用 id，保持 :key 稳定，避免整列表重挂载
    const prev = sceneBlocks.value
    if (prev.length === next.length) {
      next.forEach((b, i) => {
        b.id = prev[i].id
      })
    }
    sceneBlocks.value = next
  }
)
sceneBlocks.value = parseSceneBlocks(store.scriptContent)

// 对话式定点修改（source='chat'）：store 填好 pendingRewrite 后自动弹 diff 预览
// 与选中改写共用同一套弹窗/接受/回退流程
watch(
  () => store.pendingRewrite,
  (pr) => {
    if (pr && pr.source === 'chat') showDiffDialog.value = true
  }
)

function updateSceneTitle(id, title) {
  const b = sceneBlocks.value.find((x) => x.id === id)
  if (!b) return
  b.title = title
  scheduleRebuild()
}
function updateSceneBody(id, body) {
  const b = sceneBlocks.value.find((x) => x.id === id)
  if (!b) return
  b.body = body
  scheduleRebuild()
}
function moveScene(id, dir) {
  const idx = sceneBlocks.value.findIndex((x) => x.id === id)
  const to = idx + dir
  if (idx < 0 || to < 0 || to >= sceneBlocks.value.length) return
  const arr = [...sceneBlocks.value]
  const [item] = arr.splice(idx, 1)
  arr.splice(to, 0, item)
  applyBlocks(arr)
  store.activeSceneId = to + 1
}
function addScene(afterId = null) {
  const newBlock = { id: ++sceneBlockSeq, title: '（新场次）', body: '场景：\n人物：\n\n' }
  const arr = [...sceneBlocks.value]
  if (afterId == null || arr.length === 0) {
    arr.push(newBlock)
  } else {
    const idx = arr.findIndex((x) => x.id === afterId)
    arr.splice(idx + 1, 0, newBlock)
  }
  applyBlocks(arr)
  nextTick(() => {
    const num = sceneBlocks.value.find((x) => x.id === newBlock.id)?.num
    const el = document.querySelector(`[data-scene-num="${num}"] .scene-title-input`)
    el?.focus()
    el?.select()
  })
}
async function removeScene(id) {
  const scene = sceneBlocks.value.find((x) => x.id === id)
  const ok = await confirmDialog({
    title: '删除场次',
    description: '删除后不可恢复，但可以从版本历史回滚。',
    details: scene?.title ? [{ label: '场次', value: String(scene.title).slice(0, 60) }] : [],
    confirmText: '删除该场次',
    cancelText: '保留',
    tone: 'danger',
  })
  if (!ok) return
  applyBlocks(sceneBlocks.value.filter((x) => x.id !== id))
}
function focusScene(sceneId) {
  store.activeSceneId = sceneId
  nextTick(() => {
    const el = document.querySelector(`[data-scene-num="${sceneId}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })
}

// ===== 正文自适应高度（全部展开，不出现卡内滚动条） =====
// 注意：量高时先把 height 置 auto 会让长正文瞬间塌缩，导致外层滚动容器
// 的 scrollTop 被浏览器钳制到 0（表现为"一编辑就回到顶部"），
// 因此量高前后必须保存并恢复 scrollTop。
const vAutoGrow = {
  mounted(el) {
    el.style.overflowY = 'hidden'
    const resize = () => {
      const container = el.closest('.overflow-y-auto')
      const savedTop = container ? container.scrollTop : 0
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
      if (container && container.scrollTop !== savedTop) container.scrollTop = savedTop
    }
    el._autoGrowResize = resize
    resize()
  },
  updated(el) {
    el._autoGrowResize?.()
  },
}

// ===== Scrollspy：滚动正文时，右侧大纲高亮跟随当前可见场次 =====
const mainScroll = ref(null)
let spyTimer = null
function onMainScroll() {
  if (spyTimer) return
  spyTimer = setTimeout(() => {
    spyTimer = null
    const container = mainScroll.value
    if (!container || !sceneBlocks.value.length) return
    const cards = container.querySelectorAll('[data-scene-num]')
    const line = container.getBoundingClientRect().top + 96
    let currentNum = null
    for (const card of cards) {
      if (card.getBoundingClientRect().top <= line) currentNum = Number(card.dataset.sceneNum)
      else break
    }
    if (currentNum && store.activeSceneId !== currentNum) store.activeSceneId = currentNum
  }, 120)
}

// 大纲当前项保持可见（scrollspy / 点击锚点后）
watch(
  () => store.activeSceneId,
  () => {
    nextTick(() => {
      document.querySelector('.outline-list .outline-active')?.scrollIntoView({ block: 'nearest' })
    })
  }
)

// ===== 未分场块操作 =====
function convertFreeTextToScene() {
  const text = String(store.scriptContent || '').trim()
  store.scriptContent = '场次1：' + (text.split('\n')[0].slice(0, 16) || '新场次') + '\n' + text
}
function ignoreFreeText() {
  if (!store.scriptContent.trim()) return
  store.scriptContent = ''
}

// ===== 场次卡元数据（原型：摘要/氛围/角色 字段化展示） =====
// 数据来源为该场正文的「场景：」「人物：」行与首句，编辑仍走正文，不引入新数据模型
function parseSceneMeta(body) {
  let summary = ''
  let mood = ''
  let roles = []
  for (const line of String(body || '').split('\n')) {
    const t = line.trim()
    if (!t) continue
    if (/^场景[：:]/.test(t)) {
      mood = t.replace(/^场景[：:]\s*/, '').trim()
    } else if (/^人物[：:]/.test(t)) {
      roles = t.replace(/^人物[：:]\s*/, '').split(/[、,，\s]+/).filter(Boolean)
    } else if (!summary) {
      summary = t.replace(/^[（(]|[）)]$/g, '').slice(0, 32)
    }
  }
  return { summary, mood, roles }
}

// 字数 → 预估秒数（1000 字 ≈ 60 秒，与原型/分镜口径一致）
function durationOf(chars) {
  return Math.max(1, Math.round((chars / 1000) * 60))
}

// 状态条统计（原型六合一：版本/字数/场次/预估时长/角色/未识别）
const sceneStats = computed(() => {
  const totalChars = store.wordCount
  const nScenes = sceneBlocks.value.length
  const roleSet = new Set()
  for (const b of sceneBlocks.value) {
    for (const r of parseSceneMeta(b.body).roles) roleSet.add(r)
  }
  const nRoles = roleSet.size
  const nUnknown = sceneBlocks.value.length === 0 && store.scriptContent.trim() ? 1 : 0
  const version = store.scriptVersions[0]?.v || 'V1'
  return {
    version,
    totalChars,
    nScenes,
    totalDur: durationOf(totalChars),
    nRoles,
    nUnknown,
  }
})

// 下游依赖（原型：设定/分镜/视频 数量）
const downstreamStats = computed(() => {
  const assets = store.characters.length + store.assetScenes.length + store.props.length
  const storyboards = store.storyboardScenes.length
  let videos = 0
  for (const s of store.storyboardScenes) {
    for (const shot of s.shots || []) {
      if (shot.videoUrl || shot.videoGenerated) videos++
    }
  }
  return { assets, storyboards, videos }
})

// 卡头「AI 改写」按钮：整场改写（与选中改写共用 diff 流程）
function aiRewriteScene(id) {
  const b = sceneBlocks.value.find((x) => x.id === id)
  if (!b) return
  store.activeSceneId = b.num
  selectedText.value = b.body.trim()
  if (!selectedText.value) return
  showRewriteBar.value = true
}

// ===== AI 改稿助手：选中→改写→diff =====
const showRewriteBar = ref(false)
const rewriteInstruction = ref('')
const rewriteLoading = ref(false)
const rewriteError = ref('')
const selectedText = ref('')
const showDiffDialog = ref(false)
const lockedJustNow = ref(false) // 刚完成"锁定快照"（零副作用），用于切换"进入画风步骤"
const aiRewrittenIds = ref(new Set()) // 记录 AI 改写过哪些场次（展示徽标）

function detectSelection(e) {
  const el = e?.target
  if (!el || showDiffDialog.value) return
  const start = el.selectionStart
  const end = el.selectionEnd
  if (start !== end) {
    selectedText.value = el.value.slice(start, end)
    showRewriteBar.value = true
  } else {
    showRewriteBar.value = false
  }
}

async function submitRewrite() {
  if (!rewriteInstruction.value.trim()) return
  rewriteLoading.value = true
  rewriteError.value = ''
  const r = await store.rewriteScript({
    instruction: rewriteInstruction.value,
    selectedText: selectedText.value,
  })
  rewriteLoading.value = false
  if (r.success) {
    showRewriteBar.value = false
    rewriteInstruction.value = ''
    showDiffDialog.value = true
  } else {
    rewriteError.value = r.error || '改写失败，请稍后重试'
  }
}

function markAiRewritten() {
  // 优先标记当前活跃场次
  const active = sceneBlocks.value.find((b) => b.num === store.activeSceneId)
  if (active) {
    aiRewrittenIds.value.add(active.id)
    return
  }
  // 兜底：找到包含 selectedText 的场次
  const b = sceneBlocks.value.find((b) => b.body.includes(selectedText.value))
  if (b) aiRewrittenIds.value.add(b.id)
}

function acceptDiff() {
  const r = store.acceptRewrite()
  if (r.success) {
    markAiRewritten()
    showDiffDialog.value = false
  } else {
    toastError('应用改写失败', { detail: String(r.error || '未知错误') })
  }
}
function rejectDiff() {
  store.rejectRewrite()
  showDiffDialog.value = false
}
function saveAsVersionDiff() {
  const r = store.saveAsVersion()
  if (r.success) {
    markAiRewritten()
    showDiffDialog.value = false
  } else {
    toastError('保存版本失败', { detail: String(r.error || '未知错误') })
  }
}

// 行级 LCS diff：返回 [{ type: 'same'|'add'|'del', text }]
function diffLines(oldText, newText) {
  const a = String(oldText || '').split('\n')
  const b = String(newText || '').split('\n')
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const result = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      result.push({ type: 'same', text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: 'del', text: a[i] })
      i++
    } else {
      result.push({ type: 'add', text: b[j] })
      j++
    }
  }
  while (i < n) {
    result.push({ type: 'del', text: a[i] })
    i++
  }
  while (j < m) {
    result.push({ type: 'add', text: b[j] })
    j++
  }
  return result
}

function handleKeydown(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    store.sendAiMessage()
  }
}

function handleLock() {
  const r = store.lockScript()
  if (r.success) {
    lockedJustNow.value = true
  } else {
    toastError('锁定剧本失败', { detail: String(r.error || '未知错误') })
  }
}

function handleConfirm() {
  // 未锁定且未确认：先引导锁定快照（零费用）
  if (!store.scriptConfirmed && !lockedJustNow.value) {
    handleLock()
    return
  }
  // 已锁定未确认：进入画风步骤（此时才真正确认剧本）
  if (!store.scriptConfirmed) {
    store.confirmScript()
    router.push('/art?from=script')
    return
  }
  // 已确认过：弹出重新确认弹窗
  showReconfirmDialog.value = true
}

function confirmReconfirm() {
  // 重新确认：重新锁定并跳转画风步骤重新选择风格、提取资产
  store.confirmScript()
  showReconfirmDialog.value = false
  router.push('/art?from=script&reconfirm=1')
}

function cancelReconfirm() {
  showReconfirmDialog.value = false
}

// ===== 左侧 AI 抽屉（原型：会话状态胶囊 + 可折叠 288px↔48px） =====
const drawerCollapsed = ref(false)
const drawerSession = computed(() => {
  const v = store.scriptVersions[0]?.v || 'V1'
  const locked = store.scriptConfirmed || lockedJustNow.value
  return `${v} · ${locked ? '已锁定' : '草稿'}`
})

// 改稿建议卡片（原型：AI 抽屉顶部的快速改稿建议）
const suggestions = [
  { label: '加强冲突', prompt: '在当前场次中加入更强的冲突或阻碍，让人物动机更鲜明' },
  { label: '减少对白', prompt: '减少当前场次中的对白，多用动作和场景描写推动节奏' },
  { label: '铺垫悬念', prompt: '在开头增加一句细节或物件，为后续剧情埋伏笔' },
  { label: '转场顺畅', prompt: '让当前场次与下一场的衔接更自然，减少跳跃感' },
]
function applySuggestion(prompt) {
  if (!sceneBlocks.value.length) {
    store.aiInput = prompt
    store.sendAiMessage()
    return
  }
  // 对当前活跃场次应用
  const active = sceneBlocks.value.find((b) => b.num === store.activeSceneId) || sceneBlocks.value[0]
  store.activeSceneId = active.num
  selectedText.value = active.body.trim()
  rewriteInstruction.value = prompt
  submitRewrite()
}

// 消息级「应用到当前场次」：只在最后一条 AI 回复、且内容像改稿建议时才显示。
// 总结/通知类回复（"剧本已生成..."）不出现，避免误导点击。
const REWRITE_HINT_RE = /建议|改成|改为|修改|润色|调整|节奏|冲突|悬念|铺垫|伏笔|台词|对白|开场|结尾/
const lastAssistantIndex = computed(() => {
  for (let i = store.aiMessages.length - 1; i >= 0; i--) {
    if (store.aiMessages[i].role === 'assistant') return i
  }
  return -1
})
function canApplyToScene(index) {
  const msg = store.aiMessages[index]
  return index === lastAssistantIndex.value && !!msg && REWRITE_HINT_RE.test(String(msg.content || ''))
}
</script>

<template>
  <div class="flex h-full w-full">
    <!-- AI 编剧（改稿助手） -->
    <aside
      class="shrink-0 flex-col border-r border-border transition-all duration-200"
      :class="drawerCollapsed ? 'flex w-12' : 'flex w-72'"
    >
      <!-- 头部：标题 + 会话状态 + 折叠 -->
      <div class="flex items-center justify-between border-b border-border px-4 py-3">
        <template v-if="!drawerCollapsed">
          <div class="flex items-center gap-2">
            <span class="h-2 w-2 rounded-full bg-accent"></span>
            <h2 class="text-sm font-medium">AI 编剧</h2>
          </div>
          <div class="flex items-center gap-1.5">
            <span class="rounded bg-bg-card px-1.5 py-0.5 text-[10px] text-text-secondary">{{ drawerSession }}</span>
            <button
              class="flex h-6 w-6 items-center justify-center rounded text-text-secondary transition hover:bg-bg-hover hover:text-white"
              title="收起抽屉"
              @click="drawerCollapsed = true"
            >
              <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 18l-6-6 6-6" /></svg>
            </button>
          </div>
        </template>
        <template v-else>
          <button
            class="flex w-full flex-col items-center gap-2 py-1 text-text-secondary transition hover:text-white"
            title="展开 AI 编剧"
            @click="drawerCollapsed = false"
          >
            <span class="h-2 w-2 rounded-full bg-accent"></span>
            <span class="text-[10px] [writing-mode:vertical-lr]">AI 编剧</span>
          </button>
        </template>
      </div>

      <template v-if="!drawerCollapsed">
        <!-- 改稿建议卡 -->
        <div class="border-b border-border p-3">
          <div class="mb-2 flex items-center justify-between">
            <span class="text-[10px] text-text-muted">改稿建议</span>
            <span class="text-[10px] text-text-secondary">{{ sceneBlocks.length ? `当前：S${String(store.activeSceneId || 1).padStart(2, '0')}` : '无场次' }}</span>
          </div>
          <div class="grid grid-cols-2 gap-2">
            <button
              v-for="s in suggestions"
              :key="s.label"
              class="rounded-lg border border-border bg-bg-card px-2 py-1.5 text-left transition hover:border-accent/50 hover:bg-accent/5"
              @click="applySuggestion(s.prompt)"
            >
              <span class="block text-[11px] font-medium text-white">{{ s.label }}</span>
              <span class="block truncate text-[9px] text-text-muted">{{ s.prompt }}</span>
            </button>
          </div>
        </div>

        <div class="flex-1 overflow-y-auto px-4 py-4">
          <div v-if="!store.aiMessages.length" class="flex h-full items-center justify-center px-4 text-center text-xs leading-relaxed text-text-muted">
            开始一段创作对话吧
          </div>

          <div
            v-for="(msg, i) in store.aiMessages"
            :key="i"
            class="mb-3 flex items-end gap-2"
            :class="msg.role === 'user' ? 'justify-end' : 'justify-start'"
          >
            <!-- 助手：小圆点标识（原型：无发光头像） -->
            <div
              v-if="msg.role === 'assistant'"
              class="mb-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[9px] text-accent"
              aria-label="AI"
            >AI</div>

            <div
              class="max-w-[calc(100%-2rem)] rounded-xl border px-3 py-2 text-xs leading-relaxed"
              :class="
                msg.role === 'assistant'
                  ? 'rounded-bl-sm border-border bg-bg-secondary text-text-secondary'
                  : 'rounded-br-sm border-border bg-accent/10 text-white'
              "
            >
              {{ msg.content }}
            </div>
            <!-- 消息级快速操作：仅最后一条 AI 回复且为改稿建议时显示 -->
            <div
              v-if="msg.role === 'assistant' && canApplyToScene(i)"
              class="mt-1 flex flex-wrap gap-1.5 pl-7"
            >
              <button
                class="rounded border border-border px-1.5 py-0.5 text-[10px] text-text-secondary transition hover:border-accent/50 hover:text-white"
                @click="applySuggestion('按上面的建议改当前场次')"
              >应用到当前场次</button>
            </div>

            <!-- 用户：简化头像 -->
            <div
              v-if="msg.role === 'user'"
              class="mb-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-bg-hover text-[9px] text-text-secondary"
              aria-label="用户"
            >我</div>
          </div>

          <!-- 请求进行中 -->
          <div v-if="store.aiLoading" class="mb-3 flex items-end gap-2">
            <div class="mb-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[9px] text-accent">AI</div>
            <div class="rounded-xl rounded-bl-sm border border-border bg-bg-secondary px-3 py-2 text-xs text-text-secondary">
              <span>{{ store.aiProgressMessage || '思考中' }}</span><span class="thinking-dots ml-0.5" aria-hidden="true">...</span>
            </div>
          </div>
        </div>

        <div class="border-t border-border p-3">
          <textarea
            v-model="store.aiInput"
            class="h-20 w-full resize-none rounded-lg border border-border bg-bg-secondary p-2.5 text-xs text-white placeholder-text-muted outline-none focus:border-accent/50"
            :placeholder="store.scriptConfirmed ? '例：把开头改成雨夜场景，增加悬疑氛围……' : '输入想法，或选中正文段落让我改稿……'"
            @keydown="handleKeydown"
          />
          <div class="mt-2 flex items-center justify-between gap-3">
            <span class="text-[10px] text-text-muted">
              {{ store.aiLoading ? 'AI 正在整理你的想法...' : 'Ctrl/Cmd + Enter 发送' }}
            </span>
            <button
              class="rounded-lg bg-accent px-4 py-1.5 text-xs font-medium text-black transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="store.aiLoading"
              @click="store.sendAiMessage"
            >
              {{ store.aiLoading ? '思考中...' : '发送' }}
            </button>
          </div>
        </div>

        <!-- 版本历史（点击可回滚） -->
        <div v-if="store.scriptVersions.length" class="max-h-44 overflow-y-auto border-t border-border p-3">
          <div class="mb-2 text-[10px] text-text-muted">版本历史 · 点击可回到该版本</div>
          <button
            v-for="ver in store.scriptVersions"
            :key="ver.v"
            class="mb-1.5 flex w-full items-center gap-2 rounded-lg border border-border bg-bg-card px-2.5 py-1.5 text-left transition hover:border-border-light"
            @click="store.revertToVersion(ver.v)"
          >
            <span class="shrink-0 rounded bg-accent/20 px-1 text-[10px] font-medium text-accent">{{ ver.v }}</span>
            <span class="shrink-0 text-[10px] text-text-muted">{{ ver.time }}</span>
            <span class="min-w-0 flex-1 truncate text-[10px] text-text-secondary">{{ ver.note }}</span>
          </button>
        </div>
      </template>
    </aside>

    <!-- 剧本正文 -->
    <section class="mx-auto flex w-full max-w-[900px] flex-1 flex-col">
      <div class="flex items-center justify-between border-b border-border px-6 py-3">
        <h2 class="text-sm font-medium">剧本正文</h2>
        <div class="flex items-center gap-4 text-[11px] text-text-muted">
          <span>版本 <b class="text-text-secondary">{{ sceneStats.version }}</b></span><span class="text-border">·</span>
          <span>字数 <b class="text-text-secondary">{{ sceneStats.totalChars }}</b></span><span class="text-border">·</span>
          <span>场次 <b class="text-text-secondary">{{ sceneStats.nScenes }}</b></span><span class="text-border">·</span>
          <span>预估时长 <b class="text-text-secondary">{{ sceneStats.totalDur }}s</b></span><span class="text-border">·</span>
          <span>角色 <b class="text-text-secondary">{{ sceneStats.nRoles }}</b></span><span class="text-border">·</span>
          <span>未识别 <b class="text-text-secondary">{{ sceneStats.nUnknown }}</b></span>
          <span class="text-[10px] text-text-muted">1000 字 ≈ 60 秒</span>
        </div>
      </div>

      <div ref="mainScroll" class="flex-1 overflow-y-auto px-6 py-4" @scroll="onMainScroll">
        <!-- 无场次标记：未分场块（原型 unknown-block，确认剧本时后端自动归一化） -->
        <template v-if="!sceneBlocks.length">
          <div class="mb-3 overflow-hidden rounded-xl border border-border bg-bg-secondary">
            <div class="flex items-center justify-between border-b border-border bg-bg-card/60 px-4 py-2">
              <span class="text-xs font-medium">未分场</span>
              <div class="flex items-center gap-2">
                <span class="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-400">格式未识别</span>
                <button
                  class="rounded border border-border px-2 py-0.5 text-[10px] text-text-secondary transition hover:border-accent/50 hover:text-white"
                  title="把当前文本转为第一场"
                  @click="convertFreeTextToScene"
                >转为新场次</button>
                <button
                  class="rounded border border-border px-2 py-0.5 text-[10px] text-text-secondary transition hover:border-red-500/50 hover:text-red-400"
                  title="清空当前未分场文本"
                  @click="ignoreFreeText"
                >忽略</button>
              </div>
            </div>
            <textarea
              v-model="store.scriptContent"
              v-auto-grow
              class="block w-full bg-transparent px-4 py-3 text-[17px] leading-[1.9] text-white outline-none"
              :placeholder="store.scriptConfirmed ? '' : '请输入剧本正文，支持多场景、对白与舞台指示……'"
              spellcheck="false"
              @mouseup="detectSelection"
              @keyup="detectSelection"
            />
            <p class="border-t border-border/50 px-4 py-1.5 text-[10px] text-text-muted">
              未识别到标准场次标记（如「场次1：标题」）。可点击「转为新场次」手动切分，或确认剧本时自动转换。
            </p>
          </div>
        </template>

        <!-- 结构化场次卡片列表 -->
        <template v-else>
          <div
            v-for="(scene, index) in sceneBlocks"
            :key="scene.id"
            :data-scene-num="scene.num"
            class="scene-card mb-3 overflow-hidden rounded-xl border bg-bg-secondary transition"
            :class="{
              'active': store.activeSceneId === scene.num,
              'border-border hover:border-border-light': store.activeSceneId !== scene.num,
            }"
          >
            <!-- 卡头：场次号 + 标题 + 操作 -->
            <div class="card-head flex items-center gap-2 border-b border-border bg-bg-card/60 px-4 py-2">
              <span class="shrink-0 font-mono text-[11px] font-medium text-accent">S{{ String(scene.num).padStart(2, '0') }}</span>
              <span
                v-if="aiRewrittenIds.has(scene.id)"
                class="shrink-0 rounded bg-accent/15 px-1 py-0.5 text-[10px] font-medium text-accent"
                title="该场次已被 AI 改写"
              >AI 已改写</span>
              <input
                :value="scene.title"
                class="scene-title-input min-w-0 flex-1 bg-transparent text-sm font-medium text-white outline-none"
                placeholder="场次标题"
                spellcheck="false"
                @input="updateSceneTitle(scene.id, $event.target.value)"
              />
              <div class="flex shrink-0 items-center gap-1">
                <button
                  class="flex h-6 items-center rounded border border-border px-1.5 text-[10px] text-text-secondary transition hover:border-accent/50 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
                  title="整场交给 AI 改写（diff 可回退）"
                  @click="aiRewriteScene(scene.id)"
                >AI 改写</button>
                <button
                  class="flex h-6 w-6 items-center justify-center rounded text-text-secondary transition hover:bg-bg-hover hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
                  title="上移（调整叙事顺序）"
                  :disabled="scene.num === 1"
                  @click="moveScene(scene.id, -1)"
                >↑</button>
                <button
                  class="flex h-6 w-6 items-center justify-center rounded text-text-secondary transition hover:bg-bg-hover hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
                  title="下移（调整叙事顺序）"
                  :disabled="scene.num === sceneBlocks.length"
                  @click="moveScene(scene.id, 1)"
                >↓</button>
                <button
                  class="flex h-6 w-6 items-center justify-center rounded text-text-secondary transition hover:bg-bg-hover hover:text-white"
                  title="在此场后新增场次"
                  @click="addScene(scene.id)"
                >＋</button>
                <button
                  class="flex h-6 w-6 items-center justify-center rounded text-text-secondary transition hover:bg-red-500/20 hover:text-red-400"
                  title="删除场次"
                  @click="removeScene(scene.id)"
                >✕</button>
              </div>
            </div>

            <!-- 元数据行（原型：摘要 / 氛围 / 角色） -->
            <div class="meta-row flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/50 px-4 py-1.5">
              <span class="flex items-center gap-1.5 text-[10px] text-text-muted">
                摘要
                <span class="max-w-[220px] truncate text-[10px] text-text-secondary">{{ parseSceneMeta(scene.body).summary || '—' }}</span>
              </span>
              <span class="flex items-center gap-1.5 text-[10px] text-text-muted">
                氛围
                <span class="max-w-[160px] truncate text-[10px] text-text-secondary">{{ parseSceneMeta(scene.body).mood || '—' }}</span>
              </span>
              <span class="flex items-center gap-1 text-[10px] text-text-muted">
                角色
                <template v-if="parseSceneMeta(scene.body).roles.length">
                  <span
                    v-for="r in parseSceneMeta(scene.body).roles"
                    :key="r"
                    class="rounded bg-accent/10 px-1 py-0.5 text-[10px] text-accent"
                  >{{ r }}</span>
                </template>
                <span v-else class="text-[10px] text-text-muted">—</span>
              </span>
            </div>

            <!-- 卡体：该场正文（自适应高度，全部展开） -->
            <textarea
              :value="scene.body"
              v-auto-grow
              class="scene-body block w-full bg-transparent px-4 py-3 text-[17px] leading-[1.9] text-white outline-none"
              placeholder="场景：…&#10;人物：…&#10;（舞台指示）&#10;角色：&quot;台词&quot;"
              spellcheck="false"
              @input="updateSceneBody(scene.id, $event.target.value)"
              @mouseup="detectSelection"
              @keyup="detectSelection"
            />

            <!-- 卡脚：字数 / 预估秒数 -->
            <div class="scene-foot flex items-center gap-3 border-t border-border/50 px-4 py-1.5 text-[10px] text-text-muted">
              <span><b class="text-text-secondary">{{ scene.body.replace(/\s/g, '').length }}</b> 字</span>
              <span>约 <b class="text-text-secondary">{{ durationOf(scene.body.replace(/\s/g, '').length) }}</b> 秒</span>
            </div>
          </div>
          <button
            class="mb-2 flex w-full items-center justify-center gap-1 rounded-xl border border-dashed border-border py-3 text-xs text-text-secondary transition hover:border-accent/50 hover:text-white"
            @click="addScene()"
          >
            ＋ 新增场次
          </button>
        </template>
      </div>

      <!-- AI 改稿助手：选中段落后的改写浮层 -->
      <div
        v-if="showRewriteBar"
        class="flex items-center gap-2 border-t border-border bg-bg-secondary px-6 py-2.5"
      >
        <span class="shrink-0 text-[10px] text-text-muted">已选中 {{ selectedText.length }} 字</span>
        <input
          v-model="rewriteInstruction"
          class="h-8 min-w-0 flex-1 rounded-lg border border-border bg-bg-primary px-3 text-xs text-white placeholder-text-muted outline-none focus:border-accent/50"
          placeholder="输入改写要求，如：把这段改成雨夜氛围，加强悬疑"
          @keyup.enter="submitRewrite"
        />
        <span v-if="rewriteError" class="shrink-0 text-[10px] text-red-400">{{ rewriteError }}</span>
        <button
          class="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary transition hover:border-border-light hover:text-white"
          @click="showRewriteBar = false"
        >
          取消
        </button>
        <button
          class="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-black transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="rewriteLoading || !rewriteInstruction.trim()"
          @click="submitRewrite"
        >
          {{ rewriteLoading ? '改写中...' : 'AI 改写' }}
        </button>
      </div>

      <div class="flex items-center justify-between border-t border-border px-6 py-3">
        <span class="text-xs text-text-muted">
          <template v-if="store.scriptConfirmed || lockedJustNow">
            剧本已锁定（{{ sceneStats.version }}），内容冻结。下一步：选择画风 → 设定页提取资产
          </template>
          <template v-else>
            锁定快照 = 保存当前版本，<b class="text-text-secondary">零费用</b>，可随时回到本版本
          </template>
        </span>
        <div class="flex items-center gap-2">
          <button
            class="rounded-lg border border-border px-4 py-1.5 text-xs text-text-secondary transition hover:border-border-light hover:text-white"
            @click="showImportDialog = true"
          >
            导入剧本
          </button>
          <button
            class="rounded-lg border border-border px-4 py-1.5 text-xs text-text-secondary transition hover:border-border-light hover:text-white"
            @click="store.saveDraft"
          >
            保存草稿
          </button>
          <button
            class="rounded-lg bg-accent px-5 py-1.5 text-xs font-medium text-black transition hover:bg-accent-hover"
            @click="handleConfirm"
          >
            {{
              store.scriptConfirmed
                ? '重新确认剧本'
                : lockedJustNow
                  ? '进入画风步骤 →'
                  : '锁定剧本快照'
            }}
          </button>
        </div>
      </div>
    </section>

    <!-- 分场大纲 -->
    <aside class="flex w-64 shrink-0 flex-col border-l border-border">
      <div class="border-b border-border px-4 py-3">
        <h2 class="text-sm font-medium">分场大纲</h2>
      </div>

      <!-- 空状态 -->
      <div
        v-if="!store.scenes.length"
        class="flex flex-1 items-center justify-center p-6"
      >
        <!-- 正文有内容但解析不到场次：多为外部粘贴的非标准格式，确认剧本时后端会自动转换 -->
        <p v-if="store.scriptContent.trim()" class="text-xs text-text-muted">
          未识别到标准场次标记（如「场次1：标题」），
          确认剧本时将自动转换为标准格式
        </p>
        <p v-else class="text-xs text-text-muted">编写或粘贴剧本后，将自动解析分场大纲</p>
      </div>

      <!-- 场次列表（剧本正文有内容即实时显示） -->
      <template v-else>
        <div class="outline-list flex-1 overflow-y-auto p-3">
          <button
            v-for="scene in store.scenes"
            :key="scene.id"
            class="mb-1.5 flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left transition"
            :class="[
              store.activeSceneId === scene.id
                ? 'outline-active border-accent/60 bg-accent/5'
                : 'border-border bg-bg-card hover:border-border-light',
            ]"
            :title="'跳转到该场次（锚点）'"
            @click="focusScene(scene.id)"
          >
            <span class="shrink-0 font-mono text-[10px] text-accent">S{{ String(scene.id).padStart(2, '0') }}</span>
            <span class="min-w-0 flex-1 truncate text-xs font-medium text-white">{{ scene.title }}</span>
            <span class="shrink-0 text-[10px] text-text-muted">{{ scene.summary.length }} 字</span>
          </button>
        </div>

        <!-- 六合一统计（原型右侧 statGrid） -->
        <div class="grid grid-cols-3 gap-px border-t border-border bg-border">
          <div class="bg-bg-primary px-3 py-2">
            <div class="text-[10px] text-text-muted">版本</div>
            <div class="text-sm font-medium text-text-secondary">{{ sceneStats.version }}</div>
          </div>
          <div class="bg-bg-primary px-3 py-2">
            <div class="text-[10px] text-text-muted">字数</div>
            <div class="text-sm font-medium text-text-secondary">{{ sceneStats.totalChars }}</div>
          </div>
          <div class="bg-bg-primary px-3 py-2">
            <div class="text-[10px] text-text-muted">场次</div>
            <div class="text-sm font-medium text-text-secondary">{{ sceneStats.nScenes }}</div>
          </div>
          <div class="bg-bg-primary px-3 py-2">
            <div class="text-[10px] text-text-muted">预估时长</div>
            <div class="text-sm font-medium text-text-secondary">{{ sceneStats.totalDur }}s</div>
          </div>
          <div class="bg-bg-primary px-3 py-2">
            <div class="text-[10px] text-text-muted">角色</div>
            <div class="text-sm font-medium text-text-secondary">{{ sceneStats.nRoles }}</div>
          </div>
          <div class="bg-bg-primary px-3 py-2">
            <div class="text-[10px] text-text-muted">未识别</div>
            <div class="text-sm font-medium text-text-secondary">{{ sceneStats.nUnknown }}</div>
          </div>
        </div>

        <!-- 下游依赖（原型 downstream） -->
        <div class="flex items-center gap-3 border-t border-border px-4 py-2.5 text-[10px] text-text-muted">
          <span>设定 <b class="text-text-secondary">{{ downstreamStats.assets }}</b></span>
          <span>分镜 <b class="text-text-secondary">{{ downstreamStats.storyboards }}</b></span>
          <span>视频 <b class="text-text-secondary">{{ downstreamStats.videos }}</b></span>
        </div>
      </template>
    </aside>

    <!-- AI 改写 diff 预览弹窗 -->
    <Teleport to="body">
      <div
        v-if="showDiffDialog && store.pendingRewrite"
        class="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4"
        @click.self="rejectDiff"
      >
        <div class="flex max-h-[80vh] w-[640px] flex-col overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-2xl">
          <div class="border-b border-border px-6 py-4">
            <h3 class="text-base font-medium text-white">AI 改写预览</h3>
            <p class="mt-1 text-xs text-text-muted">
              {{ store.pendingRewrite.source === 'chat'
                ? '定点修改，未涉及内容保持原样；接受后当前版本会先存入历史，可随时回滚'
                : '局部改写，不涉及其他场次；接受后当前版本会先存入历史，可随时回滚' }}
            </p>
          </div>
          <div class="flex-1 overflow-y-auto p-4">
            <div class="mb-2 flex items-center gap-3 text-[10px]">
              <span class="rounded bg-green-500/15 px-1.5 py-0.5 text-green-400">+ 新增</span>
              <span class="rounded bg-red-500/15 px-1.5 py-0.5 text-red-400">− 删除</span>
            </div>
            <div class="space-y-0.5 font-mono text-xs leading-6">
              <div
                v-for="(line, i) in diffLines(store.pendingRewrite.selectedText, store.pendingRewrite.rewrittenText)"
                :key="i"
                class="flex items-start gap-2 rounded px-2"
                :class="
                  line.type === 'add'
                    ? 'bg-green-500/15 text-green-300'
                    : line.type === 'del'
                      ? 'bg-red-500/15 text-red-300 line-through'
                      : 'text-text-secondary'
                "
              >
                <span class="w-4 shrink-0 text-center">{{ line.type === 'add' ? '+' : line.type === 'del' ? '−' : '' }}</span>
                <span class="w-8 shrink-0 text-[10px] text-text-muted">{{ line.type === 'add' ? '新增' : line.type === 'del' ? '删除' : '' }}</span>
                <span class="min-w-0 flex-1 whitespace-pre-wrap break-all">{{ line.text || ' ' }}</span>
              </div>
            </div>
          </div>
          <div class="flex items-center justify-between border-t border-border px-6 py-4">
            <span class="text-[10px] text-text-muted">改写说明：{{ store.pendingRewrite.instruction }}</span>
            <div class="flex gap-3">
              <button
                class="rounded-lg border border-border px-4 py-1.5 text-xs text-text-secondary transition hover:border-border-light hover:text-white"
                @click="rejectDiff"
              >
                回退
              </button>
              <button
                class="rounded-lg border border-border px-4 py-1.5 text-xs text-text-secondary transition hover:border-border-light hover:text-white"
                @click="saveAsVersionDiff"
              >
                另存为版本
              </button>
              <button
                class="rounded-lg bg-accent px-4 py-1.5 text-xs font-medium text-black transition hover:bg-accent-hover"
                @click="acceptDiff"
              >
                接受
              </button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 导入剧本弹窗 -->
    <ImportScriptDialog
      v-model="showImportDialog"
      :episode-id="store.currentEpisodeId"
    />

    <!-- 重新确认剧本确认弹窗 -->
    <Teleport to="body">
      <div v-if="showReconfirmDialog" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60" @click.self="cancelReconfirm">
        <div class="w-[440px] rounded-xl border border-border bg-bg-secondary p-6 shadow-2xl">
          <div class="flex items-center gap-2">
            <span class="text-lg text-yellow-500">⚠️</span>
            <h3 class="text-base font-semibold text-white">重新确认剧本</h3>
          </div>
          <p class="mt-4 text-sm leading-relaxed text-text-secondary">
            重新确认将重新拆分场次并覆盖已有的美术素材，是否继续？
          </p>
          <div class="mt-6 flex justify-end gap-3">
            <button
              class="rounded-lg border border-border bg-bg-primary px-5 py-2 text-sm text-text-secondary transition hover:bg-bg-hover"
              @click="cancelReconfirm"
            >
              取消
            </button>
            <button
              class="rounded-lg bg-accent px-5 py-2 text-sm font-medium text-black transition hover:bg-accent-hover"
              @click="confirmReconfirm"
            >
              重新确认剧本
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* 正文区 Editorial 衬线质感（设计令牌：正文 Noto Serif SC 17px/行距1.9） */
.scene-body,
.scene-title-input,
.meta-row {
  font-family: 'Noto Serif SC', 'Songti SC', 'STSong', serif;
}
.scene-body {
  min-height: 96px;
}
/* 锚点跳转时卡片不贴死顶部 */
.scene-card {
  scroll-margin-top: 12px;
}
/* 活跃场次卡：左侧 3px 强调条（原型 .scene-card.active） */
.scene-card.active {
  border-left: 3px solid var(--accent, #c8f542);
  border-left-color: #c8f542;
}

@media (prefers-reduced-motion: reduce) {
  .scene-card,
  aside {
    transition: none !important;
    animation: none !important;
  }
}
</style>
