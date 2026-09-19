import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { api } from '../services/api'
import {
  confirmDialog, toastSuccess, toastWarn, toastError, toastInfo,
} from '../services/dialog'
import { buildAssetImagePrompt } from '../services/promptBuilder'
import { reconcilePendingAssetGens } from '../services/pendingAssetGens'
// 场景图批量生成的空间组串行调度（纯函数，见文件头注释）
import { buildSceneGroupChains } from '../utils/sceneGroupSchedule'
import { characterColor } from '../constants/palette'
import { getVideoEngine } from '../data/videoEngines'
import { STORAGE_KEYS, STORAGE_KEY_PREFIX, POLL, TIMEOUTS, DELAYS, DEFAULTS, FALLBACK_STYLE, BATCH_GEN } from '../constants/app'

// 真实数据始终来自当前项目/集
const CURRENT_PROJECT_STORAGE_KEY = STORAGE_KEYS.CURRENT_PROJECT

// 指令回声过滤（前端兜底，与后端 applyScriptEdits 的守卫同口径）：
// AI 偶发把用户指令原文当"新增内容"写进剧本（如"按上述内容把A改成B生成一个30秒的剧本"）。
// 这里把新剧本中「命中指令特征 且 原剧本中不存在」的行剥掉，返回 { text, removed }。
function stripInstructionEcho(originalText, newText) {
  const patterns = [
    /按[上照]述|根据上述/,
    /把.{1,16}改成.{0,40}(生成|一个?\d+\s*秒)/,
    /生成.{0,10}一个?.{0,6}\d+\s*秒.{0,8}的?剧本/,
    /\d+\s*秒(左右)?的(剧本|故事)/,
  ]
  const looksLikeEcho = (line) => {
    const t = line.trim()
    if (!t || t.length > 120) return false
    return patterns.some((re) => re.test(t))
  }
  const originalLines = new Set(String(originalText || '').split('\n').map((l) => l.trim()))
  const lines = String(newText || '').split('\n')
  const kept = []
  let removed = 0
  for (const line of lines) {
    if (looksLikeEcho(line) && !originalLines.has(line.trim())) {
      removed++
      continue
    }
    kept.push(line)
  }
  return { text: kept.join('\n'), removed }
}

// ── P1（2026-09-16）：重新提取的覆盖保护 · 前端最小闭环 ──
// 后端在提取路径落库前会做智能 diff：检测「字段覆盖 / 条目删除」两类风险，
// 有风险且前端未带 decision 时**不落库**，回传 { risk:true, report }。
// 这里把报告转成确认框明细——只列两部分数量 + 涉及条目名，不把逐字段 diff 全铺出来（避免刷屏）。
const ASSET_TABLE_LABEL = { characters: '角色', props: '道具', scenes: '场景' }

function buildOverwriteDetails(report) {
  const details = []
  const counts = report?.counts || {}
  if (counts.overwrites) {
    details.push({ label: '字段覆盖', value: `${counts.overwrites} 处现有内容将被新提取结果替换`, tone: 'warn' })
  }
  if (counts.deletions) {
    details.push({ label: '条目删除', value: `${counts.deletions} 个现有资产在新提取里消失`, tone: 'warn' })
  }
  const names = [
    ...(report?.overwrites || []).map((o) => o.name),
    ...(report?.deletions || []).map((d) => d.name),
  ].filter(Boolean)
  if (names.length) {
    const preview = names.slice(0, 6).join('、') + (names.length > 6 ? ` 等 ${names.length} 项` : '')
    details.push({ label: '涉及', value: preview })
  }
  return details
}

/**
 * 调用受保护的资产保存接口；命中覆盖风险时弹「全部保留我的 / 接受新值」二次确认后重提。
 * 决策结果记在 decisions[table] 上，供「部分保存失败后免扣费重试」路径复用（重试时不再二次弹框）。
 * @returns {Promise<Array|Object>} 后端最终落库结果（成功为数组）
 */
async function saveAssetsGuarded({ episodeId, table, items, saveFn, decisions }) {
  const call = (decision) => saveFn(episodeId, {
    [table]: items,
    source: 'extract',
    ...(decision ? { decision } : {}),
  })
  let result = await call(decisions[table])
  if (result && result.risk) {
    // tone:'warn' → DialogHost 默认焦点落在「取消」按钮；Esc / 点遮罩也解析为 false。
    // 这里把**取消 =「全部保留我的」**（安全侧），确保「手滑 / 习惯性回车」永远不会误选
    // 「接受新值」把用户的劳动覆盖掉；想接受新值必须主动点右侧主按钮。
    const acceptNew = await confirmDialog({
      title: `${ASSET_TABLE_LABEL[table] || '资产'}将被覆盖`,
      description: '新提取结果会覆盖你手工改过或补充过的内容。\n「全部保留我的」= 沿用现有版本、只新增本次新提取的条目；「接受新值」= 用本次提取结果整体替换。',
      details: buildOverwriteDetails(result.report),
      confirmText: '接受新值',
      cancelText: '全部保留我的',
      tone: 'warn',
    })
    const decision = acceptNew ? 'accept' : 'keep'
    decisions[table] = decision
    result = await call(decision)
  }
  return result
}

// AI 编剧意图分流已后端化：前端只区分"空剧本→generate / 有剧本→auto"，
// revise（定点修改）/ rewrite（整本整理）/ generate（全新剧本）由后端模型按语义分类。
// 旧的纯正则分流对措辞敏感："把男生重写成布布"命中"重写"却被误判成整本整理，
// 台词有被模型顺手改掉的风险；分类调用失败时后端兜底为 revise。

function getStoredProjectId() {
  try {
    const value = window.localStorage.getItem(CURRENT_PROJECT_STORAGE_KEY)
    return value ? Number(value) : null
  } catch {
    return null
  }
}

function storeCurrentProjectId(projectId) {
  try {
    if (projectId) window.localStorage.setItem(CURRENT_PROJECT_STORAGE_KEY, String(projectId))
    else window.localStorage.removeItem(CURRENT_PROJECT_STORAGE_KEY)
  } catch {
    // 浏览器禁用本地存储时，仍允许当前页面正常工作
  }
}

function parseScenesFromScript(content) {
  const lines = content.split('\n')
  const scenes = []
  let current = null

  for (const line of lines) {
    const match = line.match(/^场次[一二三四五六七八九十\d]+[：:\s]\s*(.+)/)
    if (match) {
      if (current) scenes.push(current)
      current = {
        id: scenes.length + 1,
        title: line.trim(),
        summary: '',
      }
    } else if (current && line.trim() && !line.match(/^(场景|人物)[：:]/)) {
      const text = line.replace(/^[：:].+[：:]$/, '').trim()
      if (text && !current.summary) {
        current.summary = text.length > 40 ? text.slice(0, 40) + '...' : text
      }
    }
  }
  if (current) scenes.push(current)

  return scenes.map((s, i) => ({
    ...s,
    id: i + 1,
    summary: s.summary || DEFAULTS.EMPTY_SUMMARY,
  }))
}

export const useProjectStore = defineStore('project', () => {
  // ===== 基础状态 =====
  const projectTitle = ref(DEFAULTS.PROJECT_TITLE)
  const currentProjectId = ref(null) // 后端 project ID
  const currentEpisode = ref(1)
  const initialized = ref(false) // store 是否已从后端加载完成
  const currentEpisodeId = ref(null) // 后端 episode ID
  const episodes = ref([]) // 当前项目下的全部剧集 [{ id, episode_number, title, ... }]
  // 段方案（E 路线 v2，2026-09-15）：本集所有段 [{ id, sceneNumber, segmentIndex, shotNumbers,
  // startTime, endTime, duration, status, videoUrl, ... }]。短片页「按场出片」按此渲染。
  // 段是**出片包装层**：镜表/分镜数据不动，一段一次生成，出片后按镜边界切片回填 shots.video_url。
  const segmentPlan = ref([])
  // 项目级默认宽高比：从后端 projects.aspect_ratio 读（迁移默认值 '16:9 (Widescreen)'），
  // 下游生图（rhShotGrid）和出片（V4/标准/武戏）链路通过 aspectRatio getter 读取。
  // 项目级是上游：不在分镜页或短片页里单点配置，避免分镜图和成片比例不一致。
  const aspectRatio = ref(DEFAULTS.ASPECT_RATIO)
  const generatingAssetIds = ref([]) // 当前正在生成图片的资产ID列表（支持并行）
  // 在途资产图生图请求的 AbortController（key=String(id)，非响应式）：
  // 用户点"取消"时 abort 前端等待并清理任务登记
  const assetGenControllers = new Map()

  // 生图模型：设定页/分镜页全局选择（gpt-image-2(ZIKL) / Visionary Nano Banana 系列 / 四宫格通道），
  // localStorage 记忆。默认 zikl。2026-09-16 调整：
  //   - visionary-gpt-image-2 已退役（实测文生图与图生图全部 HTTP 400「当前模型不受支持」）→ 从下拉移除，
  //     旧 localStorage 值迁移到 zikl，避免下拉框空白。
  //   - runninghub 保留但改名为「四宫格通道（文生图）」：只服务分镜四宫格（RunningHub AI 应用，4 槽参考池），
  //     不是通用生图模型。旧值【不迁移】——正在用它跑四宫格的人应保持原选择，避免换通道后质量悄悄退化。
  const LEGACY_IMAGE_MODELS = { 'visionary-gpt-image-2': 'zikl' }
  const storedImageModel = localStorage.getItem(STORAGE_KEYS.IMAGE_MODEL) || ''
  const resolvedImageModel = LEGACY_IMAGE_MODELS[storedImageModel] || storedImageModel || 'zikl'
  if (resolvedImageModel !== storedImageModel) localStorage.setItem(STORAGE_KEYS.IMAGE_MODEL, resolvedImageModel)
  const imageModel = ref(resolvedImageModel)
  watch(imageModel, (v) => localStorage.setItem(STORAGE_KEYS.IMAGE_MODEL, v))
  // 视频出片引擎：短片页/分镜页全局选择（'h3v4' | 'combat'），localStorage 记忆。
  // 合法值与展示文案见 src/data/videoEngines.js；生成入口统一走 generateShotVideoByModel。
  const videoModel = ref(localStorage.getItem(STORAGE_KEYS.VIDEO_MODEL) || 'h3v4')
  watch(videoModel, (v) => localStorage.setItem(STORAGE_KEYS.VIDEO_MODEL, v))
  const generatingStoryboardIds = ref([]) // 正在生成故事板/分镜图的镜头 ID 列表
  const generatingBlockingIds = ref([]) // 正在生成站位图的镜头 ID 列表
  // 正在生成尾帧锚（keyframe）的镜头 ID 列表（2026-09-16「final_frame 一键生图」）。
  // 独立于 generatingStoryboardIds：尾帧锚与分镜图是两个不同产物，共用一把锁会导致
  // 「尾帧锚生成中」把分镜图列也盖上遮罩，用户以为分镜图在重出。
  const generatingKeyframeIds = ref([])
  const generatingSceneGridIds = ref([]) // 正在按场出 2x2 四宫格的场次 ID 列表
  const generatingShotGridIds = ref([]) // 正在出单镜头 2x2 四宫格的镜头 ID 列表
  const shotGridFailed = ref({}) // 四宫格失败状态：shotId → 错误信息（镜头卡片红标，10 分钟后服务端自动清）
  const shotGridStartedAt = ref({}) // 四宫格开始时间：shotId → 时间戳（卡片显示已耗时）
  // 系统告警（2026-09-13）：出片后置钩子链（末帧接力/接缝检测/色向闸/观片闸）失败的可见化列表。
  // 独立于 shot 对象维护——告警是独立表查询，不塞进 loadEpisode 的字段映射表
  // （finalFrame 曾因映射表漏字段被静默清空，教训见 overview）。
  const systemAlerts = ref([])
  const systemAlertCount = ref(0)
  const generatingVideoIds = ref([]) // 正在出单镜成片（YZ金鱼-MiniMax H3 多参考 workflow）的镜头 ID 列表
  const batchStoryboardGenerating = ref(false) // 批量故事板/分镜图生成中
  const batchBlockingGenerating = ref(false) // 批量站位图生成中
  const episodeTheme = ref(DEFAULTS.EPISODE_THEME)
  const artStyle = ref(DEFAULTS.ART_STYLE)

  // 当前选中的画风（完整对象，含 prompt）
  // 首屏占位用 FALLBACK_STYLE（prompt 为空），真实 prompt 从后端风格库取：
  // 早期这里硬编码了一份与后端 style_presets 不一致的吉卜力文案，导致同一项目
  // 在不同时机生成的图风格文案不同。
  const currentStyle = ref({ ...FALLBACK_STYLE })
  // 后端风格库缓存：画风 prompt 的唯一权威来源（style_presets 表）
  const stylePresets = ref([])

  async function ensureStylePresets() {
    if (stylePresets.value.length) return stylePresets.value
    try {
      const data = await api.getStyles()
      stylePresets.value = (data.categories || []).flatMap((c) => c.presets || [])
    } catch {
      /* 风格库拉取失败：保持空，由调用方回退 */
    }
    return stylePresets.value
  }

  /** 当前画风的完整 prompt：优先当前选中对象，其次按名字查后端风格库，最后退化为风格名 */
  function getStylePrompt() {
    const cur = currentStyle.value
    if (cur?.prompt) return cur.prompt
    const name = cur?.label || artStyle.value
    const hit = stylePresets.value.find((p) => p.label === name)
    return hit?.prompt || name || ''
  }

  function setStyle(style) {
    currentStyle.value = style
    artStyle.value = style.label
    // 持久化到项目：刷新页面后 selectProject 按 art_style 恢复同一画风
    // 避免全局风格回落到默认卡片导致各图风格不一致
    if (currentProjectId.value) {
      api.updateProject(currentProjectId.value, { art_style: style.label }).catch(() => {})
    }
  }

  // 按风格名从风格库恢复 currentStyle（含完整画风 prompt）
  async function restoreStyleFromProject(styleName) {
    if (!styleName) return
    artStyle.value = styleName
    // 仅在 currentStyle 已是同一个完整 preset（有 coverUrl）时跳过，
    // 否则 store 里那个只有 label 的默认占位会把恢复吞掉，导致徽章一直显示兜底图标
    if (currentStyle.value?.label === styleName && currentStyle.value?.coverUrl) return
    const list = await ensureStylePresets()
    const hit = list.find((p) => p.label === styleName)
    if (hit) currentStyle.value = hit
  }

  const scriptConfirmed = ref(false)
  const storyboardConfirmed = ref(false)
  const scenes = ref([])
  const activeSceneId = ref(null)
  const scriptContent = ref('')
  const autoExtractAssets = ref(false) // 选完风格后跳转到设定页时，自动提取资产的信号
  // AI 改稿助手：版本历史与待接受改写
  const scriptVersions = ref([]) // [{ v: 'V1', time, note, content }]，v 自 V1 起递增，最新在前
  const pendingRewrite = ref(null) // { selectedText, rewrittenText, instruction }

  const aiMessages = ref([
    {
      role: 'assistant',
      content:
        DEFAULTS.AI_GREETING,
    },
  ])

  const aiInput = ref('')

  // ===== AI 调用状态 =====
  const aiLoading = ref(false)
  const aiStatus = ref('')
  const aiProgressMessage = ref('')
  const currentTaskId = ref('')

  // ===== 长任务结构化进度（2026-09-16）=====
  // 分镜流程三条长任务路径（生成 / 文件规整 / 补全）共用一份进度快照。
  // 与 aiProgressMessage 的区别：这里保留 phase / doneCount / total / percent / elapsedMs，
  // 供进度条渲染定量进度；aiProgressMessage 是纯文案，供文本位展示。
  // 结构：{ active, task, phase, message, currentLabel, doneCount, total, percent, elapsedMs }
  const sbProgress = ref(null)
  // 进度轮询定时器句柄。存成模块级变量而非 ref——它是副作用句柄，不该被模板响应式追踪，
  // 也不该随组件卸载丢失（生成可能跨越页面切换）。
  let sbProgressTimer = null

  // 一键全流程生成状态
  const fullGenRunning = ref(false)
  const fullGenProgress = ref(0)
  const fullGenMessage = ref('')

  // ===== 资产数据 =====
  const characters = ref([])
  const props = ref([])
  // 设定页场景资产（地点类资产，来自资产提取）
  const assetScenes = ref([])
  const storyboardScenes = ref([])
  // 分镜来源：'generated'=剧本 LLM 生成；'imported'=用户导入分镜脚本。imported 来源不随剧本改动提示过期
  const storyboardSource = ref('generated')
  // 项目级 IP 角色库（跨集共享）
  const projectCharacters = ref([])

  // ===== 分镜质检（2026-09-16）=====
  // 把分镜校验器跑出的 errors/warnings 聚合后摊到界面上。此前这些结论只落在服务端
  // console.warn 里，人看不见——实测一开面板就冒出 26 处此前完全静默的 SCENE_ASSET_UNKNOWN。
  // qcReport 结构见 server/routes/qc.js 的 buildQcReport：
  //   { episodeId, counts:{error,warning,total}, groups:[{code,level,title,hint,fixLabel,action,count,shots,items}],
  //     actions:{...}, shotIndex:{shotNumber:[codes]}, generatedAt, truncated }
  const qcReport = ref(null)
  const qcLoading = ref(false)
  const qcFixing = ref([]) // 正在修复的 code 列表（按钮转圈用）
  const qcShowIgnored = ref(false) // 是否显示「已确认忽略」的项
  const qcLastResult = ref('') // 最近一次修复的人话结果（面板顶部提示条）

  // ===== 计算属性 =====
  const wordCount = computed(() => scriptContent.value.replace(/\s/g, '').length)
  const totalShots = computed(() => storyboardScenes.value.reduce((sum, s) => sum + s.shots.length, 0))
  const totalDuration = computed(() => storyboardScenes.value.reduce((sum, s) => sum + s.shots.reduce((ss, shot) => ss + shot.duration, 0), 0))

  // 剧本正文变化时，实时同步分场大纲（编辑/粘贴/生成剧本后自动解析场次）
  watch(scriptContent, (content) => {
    const parsed = parseScenesFromScript(content || '')
    scenes.value = parsed
    const validIds = parsed.map((s) => s.id)
    if (!activeSceneId.value || !validIds.includes(activeSceneId.value)) {
      activeSceneId.value = parsed[0]?.id ?? null
    }
  })

  // 生成结果（图/视频/站位图 URL）统一由后端生成接口直接写库，前端只更新内存状态，不再双写。
  // 用户手工编辑镜头字段的保存仍走各编辑组件的 updateShot 调用。

  function handleAiProgress(status, detail) {
    aiStatus.value = status
    aiProgressMessage.value = detail?.message || ''
    if (detail?.taskId) currentTaskId.value = detail.taskId
  }

  function saveAiChatHistory() {
    if (!currentEpisodeId.value) return
    api.saveAiChatHistory(currentEpisodeId.value, aiMessages.value).catch((e) => {
      console.warn('保存问答记录失败:', e.message)
    })
  }

  // ===== 从后端加载集数据 =====
  async function loadEpisode(episodeId, { retries = 2 } = {}) {
    try {
      const ep = await api.getEpisode(episodeId)
      currentEpisodeId.value = ep.id
      if (currentProjectId.value) rememberEpisodeSelection(currentProjectId.value, ep.id) // 记住选集，刷新后恢复
      loadExtractInfo() // 恢复该集上次提取资产时的指纹（localStorage）
      loadStoryboardInfo() // 恢复该集上次生成分镜时的指纹（localStorage）
      // 数据库下发的剧本指纹与资产/分镜指纹（跨浏览器可靠的过期判断依据）
      episodeScriptHash.value = ep.scriptHash || ''
      episodeAssetsFp.value = ep.assetsScriptFp || ''
      episodeStoryboardFp.value = ep.storyboardScriptFp || ''
      storyboardSource.value = ep.storyboardSource || 'generated'
      scriptContent.value = ep.script_content || ''
      scriptConfirmed.value = !!ep.scriptConfirmed
      storyboardConfirmed.value = !!ep.storyboardConfirmed
      // 每次切换/刷新都以当前集为准，空数组也必须清空旧项目画面
      // 剥离后端下划线字段：保存接口是 c.image_url || c.imageUrl 取值，
      // 若保留旧 image_url，用户替换的 imageUrl 永远存不进去（刷新即回退旧图/旧音频）
      // 英文常量透传（2026-09-16）：characters.name_en / description_en 与 props.name_en
      // 是 H3 全英文提示词的必填生产资产，但下面几处映射此前会把它们丢掉：
      //   · 本函数（loadEpisode）用显式字段重建对象 → 丢
      //   · 「提取资产」映射（mapped.*）压根不带英文键 → 丢
      //   · 保存时把上面的结果整体写回 store → 则 store 里的英文键也没了
      // 结果：设定页一保存就把手工维护的英文常量抹成空（与后端 props/scenes 那次
      // 「英文常量保全」是同一个坑的前端半边）。这里统一补回，且保留后端下划线原值。
      characters.value = (ep.characters || []).map(({ image_url, audio_url, ...c }) => ({
        ...c,
        imageUrl: image_url || c.imageUrl || '',
        audioUrl: audio_url || c.audioUrl || '',
        projectCharacterId: c.project_character_id || c.projectCharacterId || null,
        linkedToProject: c.linkedToProject || !!c.project_character_id || !!c.projectCharacterId,
        // 英文常量：后端返回 name_en/description_en，前端统一暴露为 nameEn/descriptionEn
        nameEn: c.nameEn || c.name_en || '',
        descriptionEn: c.descriptionEn || c.description_en || '',
      }))
      props.value = (ep.props || []).map(({ image_url, ...p }) => ({
        ...p,
        imageUrl: image_url || p.imageUrl || '',
        // 英文常量：props.name_en → nameEn（H3 提示词用，为空会静默回退中文）
        nameEn: p.nameEn || p.name_en || '',
        // 道具英文描述（props.description_en）：H3 模块2「道具描述」逐字复用
        descriptionEn: p.descriptionEn || p.description_en || '',
      }))
      assetScenes.value = (ep.scenes || []).map((s) => ({
        id: s.id,
        name: s.name || s.scene_name || s.title || `场景${s.scene_number || ''}`,
        description: s.description || s.summary || '',
        propNames: Array.isArray(s.propNames) ? s.propNames : [],
        imageUrl: s.image_url || '',
        // 场景地点（scenes.location）：场景基础属性，入出片参考
        location: s.location || '',
        // 场景光影常量（scenes.lighting_en）：出片/生图链路逐字复用的英文光照句
        lightingEn: s.lighting_en || '',
        // 场景英文标题/摘要（scenes.title_en/summary_en）：模块3 环境冻结声明逐字复用
        titleEn: s.title_en || '',
        summaryEn: s.summary_en || '',
        // 空间组机位声明（scene_analysis.spatial_role，后端 /episodes/:id 注入）：
        // 本场在空间组里的视角，如「崖顶俯视谷底」「谷底浅滩仰视」「河面平视」。
        // 用途：拼进场景图 prompt 的机位句（见 promptBuilder.buildAssetImagePrompt 的 scene 分支）
        // —— 同组多视角唯一能区分彼此的信息，缺了它视角会塌陷成基准图机位。
        spatialGroup: s.spatialGroup || '',
        spatialRole: s.spatialRole || '',
        // A1 本场必须可见的要素清单（scene_analysis.elements_json，后端 /episodes/:id 注入）：
        // 本场摘要里明文写了、画面上必须看得见的短语（如「清晨浓雾」「冰面浮冰」）。
        // 用途：以 1.35 权重硬约束进场景图 prompt —— 实测缺陷：摘要写浓雾、出图是晴空，
        // 因为「浓雾」在 1.2 权重的长描述里被模型当成了可省略的氛围形容词。
        elements: Array.isArray(s.elements) ? s.elements : [],
        // A2 组级环境卡（scene_analysis.shared_env_json）：
        // 同组所有场景共享的环境特征（植被/地质/色调/地标）。实测缺陷：场2 摘要没提植被、
        // 出图整片秃，而同组场1/场3 都有植被——共享特征只在那两场的描述里，场2 无从得知。
        sharedEnv: Array.isArray(s.sharedEnv) ? s.sharedEnv : [],
      }))
      // 恢复刷新前未完成的资产生图任务（"生成中"状态跨刷新不丢）——
      // 现在会先向后端确认任务是否真在跑，僵尸 pending 自动清理（async，失败不阻塞页面加载）
      resumePendingAssetGens().catch(() => {})

      // 段方案（E 路线 v2）：后端 GET /episodes/:id 注入，按场展示「按场出片」按钮与进度。
      // 段是出片包装层，镜表不受影响；出片成功后切片回填 shots.video_url。
      segmentPlan.value = ep.segmentPlan || []

      storyboardScenes.value = (ep.storyboardScenes || []).map((s, sceneIndex) => ({
          id: s.id,
          sceneNumber: s.scene_number || sceneIndex + 1,
          title: s.title,
          shots: (s.shots || []).map((shot, shotIndex) => ({
            id: shot.id,
            storyboardSceneId: shot.storyboard_scene_id ?? shot.storyboardSceneId ?? null,
            // 展示和保存都使用逻辑镜头号，避免把数据库自增 ID 当镜头号
            shotNumber: shot.shot_number || `${s.scene_number || sceneIndex + 1}-${shotIndex + 1}`,
            duration: shot.duration,
            displayId: shot.shot_number || `${s.scene_number || sceneIndex + 1}-${shotIndex + 1}`,
            characters: shot.characters || [],
            sceneAssets: shot.sceneAssets || [],
            propAssets: shot.propAssets || [],
            description: shot.description || '',
            shotType: shot.shotType || shot.shot_type || '',
            startTime: shot.startTime ?? shot.start_time ?? 0,
            endTime: shot.endTime ?? shot.end_time ?? 0,
            actionNote: shot.actionNote || shot.action_note || '',
            soundEffects: shot.soundEffects || shot.sound_effects || '',
            cameraMovement: shot.cameraMovement || shot.camera_movement || '',
            // 机位朝向（与后端 camera_angle 同源）：本映射表曾遗漏该字段——loadEpisode 重建
            // 对象后字段消失，confirmStoryboard 回传即把机位从 payload 里丢掉（与 finalFrame
            // 历史坑同类）。保存侧 POST /storyboard 读 camera_angle || cameraAngle，这里透传即可。
            cameraAngle: shot.cameraAngle || shot.camera_angle || '',
            overallSoundscape: shot.overallSoundscape || shot.overall_soundscape || '',
            nonDiegeticMusic: shot.nonDiegeticMusic || shot.non_diegetic_music || '',
            integratedMultimodalDescription: shot.integratedMultimodalDescription || shot.integrated_multimodal_description || '',
            // 末帧画面描述：下一镜 Airlock 逐字复刻的唯一依据，也是跨场衔接的 prevFinalFrame。
            // 历史坑：本映射表早期遗漏该字段 → extractStoryboard 首次保存时它还在库里，
            // 但 loadEpisode 重建对象后字段消失，用户点「确认分镜」回传即把 final_frame
            // UPDATE 成 ''，导致 Airlock 无源可复刻（模型自行编造上镜画面）、跨镜状态跳变，
            // 且 storyboardValidator.checkAirlockInheritance 因取不到 prevFinalFrame 而静默跳过。
            finalFrame: shot.finalFrame || shot.final_frame || '',
            videoPromptOverride: shot.video_prompt_override || '',
            dialogue: shot.dialogue || null,
            frameUrl: shot.frame_url || '',
            frameUrl2: shot.frame_url2 || '',
            // 末帧接力锚：确认分镜回传必须透传（POST storyboard 契约：不传即清——
            // 重新生成/导入的新 shot 对象没有该字段，旧锚对新内容失效要清空）
            continuityUrl: shot.continuityUrl || shot.continuity_url || '',
            blockingUrl: shot.blocking_url || '',
            blockingPlan: (() => {
              try {
                if (shot.blockingPlan) return typeof shot.blockingPlan === 'object' ? shot.blockingPlan : JSON.parse(shot.blockingPlan)
                if (shot.blocking_plan) return JSON.parse(shot.blocking_plan)
                return null
              } catch { return null }
            })(),
            videoUrl: shot.video_url || '',
            // 段级成片（E路线v2）：段盖多镜，镜卡片用段成片+镜内偏移回显；不覆盖 videoUrl
            segmentVideoUrl: shot.segmentVideoUrl || shot.segment_video_url || '',
            segmentOffset: Number(shot.segmentOffset ?? shot.segment_offset ?? 0) || 0,
            segmentLabel: shot.segmentLabel || shot.segment_label || '',
            videoGenerated: shot.videoGenerated,
            // 衔接质量检测结果（#3）：色温差/亮度差/构图差 + alert，成片页镜头卡片标红用
            seamCheck: shot.seamCheck ?? null,
            // VLM 观片闸评审：四维评分 + verdict（pass/warn/fail）+ issues + summary
            shotReview: shot.shotReview ?? null,
            // 戏型：1=武戏（出片加载打斗 LoRA）、0=文戏、null=未判定（后端按内容实时判定）
            isCombat: shot.is_combat === 1 ? 1 : (shot.is_combat === 0 ? 0 : null),
            hasFrame: !!shot.frame_url,
            hasBlocking: !!(shot.blocking_url || shot.blocking_plan),
          })),
        }))

      if (scriptContent.value.trim()) {
        scenes.value = parseScenesFromScript(scriptContent.value)
      }
      if (Array.isArray(ep.aiChatHistory) && ep.aiChatHistory.length) {
        aiMessages.value = ep.aiChatHistory
      } else {
        aiMessages.value = [{
          role: 'assistant',
          content: DEFAULTS.AI_GREETING,
        }]
      }
      // 数据加载完成后，按服务端在跑任务恢复分镜图/故事板的生成中遮罩（刷新页面场景）
      restoreGeneratingImages()
      restoreGeneratingVideos()
      restoreGeneratingShotGrids()
      return { success: true }
    } catch (e) {
      // 后端短暂重启/网络抖动窗口里刷新页面，加载失败会被当成"空项目"渲染，
      // 看起来像所有生成结果都丢了；这里自动重试几次兜住瞬时故障
      if (retries > 0) {
        await new Promise((r) => setTimeout(r, DELAYS.LOAD_RETRY_MS))
        return loadEpisode(episodeId, { retries: retries - 1 })
      }
      console.warn('加载后端数据失败:', e.message)
      return { success: false, error: e.message }
    }
  }

  // ===== 生成中任务恢复：刷新页面后按服务端在跑任务恢复 loading 遮罩 =====
  // 分镜图/故事板生成期间刷新页面：HTTP 中断但服务端继续跑并落库，
  // 这里从服务端 inflight 列表恢复遮罩并轮询，任务完成后只回填图片字段
  //（不整页 loadEpisode，避免把用户未保存的编辑冲掉）
  let imageJobPollTimer = null
  let videoJobPollTimer = null
  async function refreshShotImageFields() {
    if (!currentEpisodeId.value) return
    try {
      const ep = await api.getEpisode(currentEpisodeId.value)
      const freshMap = new Map()
      for (const s of ep.storyboardScenes || []) {
        for (const sh of s.shots || []) freshMap.set(sh.id, sh)
      }
      for (const scene of storyboardScenes.value) {
        for (const f of scene.shots) {
          const fresh = freshMap.get(f.id)
          if (!fresh) continue
          const newFrame = fresh.frame_url || ''
          const newFrame2 = fresh.frame_url2 || ''
          if (newFrame && newFrame !== f.frameUrl) { f.frameUrl = newFrame; f.hasFrame = true }
          if (newFrame2 && newFrame2 !== f.frameUrl2) f.frameUrl2 = newFrame2
        }
      }
    } catch { /* 网络抖动，下轮再试 */ }
  }

  async function restoreGeneratingImages() {
    // 本页批量任务进行中时不动现有遮罩（服务端只有正在跑的 1-3 个，恢复会把队列镜头挤掉）
    if (batchStoryboardGenerating.value || batchBlockingGenerating.value) return
    try {
      const data = await api.getImageJobsInflight()
      const jobs = Array.isArray(data.jobs) ? data.jobs : []
      generatingStoryboardIds.value = jobs.map((j) => j.shotId)
      if (imageJobPollTimer) { clearInterval(imageJobPollTimer); imageJobPollTimer = null }
      if (!jobs.length) return
      let polls = 0
      imageJobPollTimer = setInterval(async () => {
        polls++
        // 轮询上限 ~40 次（单图正常 1-5 分钟）：超时放弃恢复，避免永久遮罩
        if (polls > POLL.MAX_POLLS.IMAGE_JOB) {
          clearInterval(imageJobPollTimer)
          imageJobPollTimer = null
          generatingStoryboardIds.value = []
          return
        }
        try {
          const d = await api.getImageJobsInflight()
          const remaining = Array.isArray(d.jobs) ? d.jobs : []
          if (remaining.length < jobs.length) {
            generatingStoryboardIds.value = remaining.map((j) => j.shotId)
            // 有任务完成即回填新图
            refreshShotImageFields()
          }
          if (!remaining.length) {
            clearInterval(imageJobPollTimer)
            imageJobPollTimer = null
          }
        } catch { /* 网络抖动，下一轮再试 */ }
      }, POLL.INTERVAL_MS)
    } catch (e) {
      console.warn('[restoreGeneratingImages] 恢复生成中任务失败:', e.message)
    }
  }

  // 刷新页面后恢复"出四宫格"状态：轮询 /generate/shot-grid/status，
  // running → 恢复镜头卡片"生成中"遮罩；failed → 恢复失败红标（含错误信息）
  let shotGridJobPollTimer = null
  async function restoreGeneratingShotGrids() {
    try {
      const data = await api.getShotGridJobs()
      const jobs = Array.isArray(data.jobs) ? data.jobs : []
      const failedMap = {}
      const running = []
      for (const j of jobs) {
        if (j.state === 'failed') failedMap[j.shotId] = j.error || '生成失败'
        else if (j.state === 'running') running.push(j.shotId)
      }
      shotGridFailed.value = failedMap
      for (const id of running) {
        if (!generatingShotGridIds.value.includes(id)) generatingShotGridIds.value.push(id)
      }
      if (shotGridJobPollTimer) { clearInterval(shotGridJobPollTimer); shotGridJobPollTimer = null }
      if (!running.length) return
      let polls = 0
      shotGridJobPollTimer = setInterval(async () => {
        polls++
        // 轮询上限 ~45 次（四宫格正常 1-3 分钟）：超时放弃恢复，避免永久遮罩
        if (polls > POLL.MAX_POLLS.SHOT_GRID) {
          clearInterval(shotGridJobPollTimer)
          shotGridJobPollTimer = null
          generatingShotGridIds.value = generatingShotGridIds.value.filter((id) => !running.includes(id))
          return
        }
        try {
          const d = await api.getShotGridJobs()
          const js = Array.isArray(d.jobs) ? d.jobs : []
          const nextFailed = {}
          const nextRunning = []
          for (const j of js) {
            if (j.state === 'failed') nextFailed[j.shotId] = j.error || '生成失败'
            else if (j.state === 'running') nextRunning.push(j.shotId)
          }
          shotGridFailed.value = nextFailed
          // 只增删本函数恢复的那批 id，不动用户在本页新点的任务（避免竞态清掉正常 loading）
          generatingShotGridIds.value = generatingShotGridIds.value.filter(
            (id) => !running.includes(id) || nextRunning.includes(id)
          )
          if (nextRunning.length < running.length) {
            // 有任务落库完成即回填新图
            refreshShotImageFields()
          }
          if (!nextRunning.length) {
            clearInterval(shotGridJobPollTimer)
            shotGridJobPollTimer = null
          }
        } catch { /* 网络抖动，下一轮再试 */ }
      }, POLL.INTERVAL_MS)
    } catch (e) {
      console.warn('[restoreGeneratingShotGrids] 恢复四宫格任务状态失败:', e.message)
    }
  }

  // 刷新页面后恢复"出片中"遮罩：轮询两个引擎的 inflight 接口（combat=/video-v3、
  // h3v4=/video-v4，服务端各用独立 Map 登记），完成即回填 videoUrl。
  async function fetchAllVideoInflightJobs() {
    const results = await Promise.allSettled([
      api.getVideoV3JobsInflight(),
      api.getVideoV4JobsInflight(),
    ])
    const jobs = []
    const seen = new Set()
    for (const r of results) {
      if (r.status !== 'fulfilled') continue
      for (const j of Array.isArray(r.value?.jobs) ? r.value.jobs : []) {
        if (seen.has(j.shotId)) continue
        seen.add(j.shotId)
        jobs.push(j)
      }
    }
    return jobs
  }

  async function restoreGeneratingVideos() {
    try {
      const jobs = await fetchAllVideoInflightJobs()
      generatingVideoIds.value = jobs.map((j) => j.shotId)
      if (videoJobPollTimer) { clearInterval(videoJobPollTimer); videoJobPollTimer = null }
      if (!jobs.length) return
      let polls = 0
      videoJobPollTimer = setInterval(async () => {
        polls++
        // 出片单条 3~15 分钟：轮询上限 ~60 次（8s 间隔 ≈ 8 分钟一轮，共约 48 分钟上限）足够兜住
        if (polls > POLL.MAX_POLLS.VIDEO_JOB) {
          clearInterval(videoJobPollTimer)
          videoJobPollTimer = null
          generatingVideoIds.value = []
          return
        }
        try {
          const remaining = await fetchAllVideoInflightJobs()
          if (remaining.length < jobs.length) {
            generatingVideoIds.value = remaining.map((j) => j.shotId)
            await refreshShotVideoFields()
          }
          if (!remaining.length) {
            clearInterval(videoJobPollTimer)
            videoJobPollTimer = null
          }
        } catch { /* 网络抖动，下一轮再试 */ }
      }, POLL.INTERVAL_MS)
    } catch (e) {
      console.warn('[restoreGeneratingVideos] 恢复出片任务失败:', e.message)
    }
  }

  // 从服务端回填各镜头的成片 URL（出片完成后调用；本地 store 字段名 videoUrl）
  async function refreshShotVideoFields() {
    if (!currentEpisodeId.value) return
    try {
      const ep = await api.getEpisode(currentEpisodeId.value)
      const freshMap = new Map()
      for (const s of ep.storyboardScenes || []) {
        for (const sh of s.shots || []) freshMap.set(sh.id, sh)
      }
      for (const scene of storyboardScenes.value) {
        for (const f of scene.shots) {
          const fresh = freshMap.get(f.id)
          if (!fresh) continue
          const newVideo = fresh.video_url || fresh.videoUrl || ''
          if (newVideo && newVideo !== f.videoUrl) f.videoUrl = newVideo
        }
      }
    } catch { /* 网络抖动，下轮再试 */ }
  }

  async function loadProjectCharacters() {
    if (!currentProjectId.value) {
      projectCharacters.value = []
      return
    }
    try {
      projectCharacters.value = await api.getProjectCharacters(currentProjectId.value)
    } catch (e) {
      console.warn('加载项目角色库失败:', e.message)
      projectCharacters.value = []
    }
  }

  // 清空与「生成过程」绑定的瞬态状态：换集/切项目时必调，防止 A 集的生成态（版本、待接受改写、
  // 指纹、轮询遮罩）污染 B 集画面（此前 A 集剧本版本可 revert 进 B 集）。
  // 注：依赖的 ref/函数在下方声明（函数声明有提升，调用均发生在 setup 完成后的用户操作期，无 TDZ 风险）。
  // pendingAssetSave 不在此清空：它带 episodeId 守卫，保留可让用户切回该集后继续免扣费重试保存。
  function clearGenerationState() {
    // 一键全流程
    fullGenRunning.value = false
    fullGenProgress.value = 0
    fullGenMessage.value = ''
    // 剧本版本历史与待接受改写（换集后不可跨集回滚/应用）
    scriptVersions.value = []
    pendingRewrite.value = null
    // 本地指纹记录与库内下发指纹（换集后由 loadEpisode 重新拉取）
    lastExtractInfo.value = null
    lastStoryboardInfo.value = null
    episodeScriptHash.value = ''
    episodeAssetsFp.value = ''
    episodeStoryboardFp.value = ''
  }

  function clearCurrentEpisode() {
    // 先清生成态（轮询定时器、版本历史、指纹等），再清正文数据
    clearGenerationState()
    currentEpisodeId.value = null
    currentEpisode.value = 1
    episodes.value = []
    segmentPlan.value = []
    scriptContent.value = ''
    scriptConfirmed.value = false
    storyboardConfirmed.value = false
    scenes.value = []
    activeSceneId.value = null
    characters.value = []
    props.value = []
    assetScenes.value = []
    storyboardScenes.value = []
    aiMessages.value = [{
      role: 'assistant',
      content: DEFAULTS.AI_GREETING,
    }]
  }

  // 加载用户选择的项目和当前集
  async function selectProject(projectId) {
    try {
      // 切换项目前先清掉旧项目的生成态（轮询句柄、版本历史、指纹、遮罩），
      // 否则 A 项目的视频轮询会在加载 B 项目后刷新成 B 的数据、A 的版本可 revert 进 B
      clearGenerationState()
      const project = await api.getProject(projectId)
      projectTitle.value = project.title || '未命名项目'
      // 恢复项目级宽高比（生图/出片链路沿用此处；非法值由后端白名单兜底）
      aspectRatio.value = project.aspect_ratio || DEFAULTS.ASPECT_RATIO
      // 恢复全局画风（含完整 prompt），保证刷新后生图仍用用户选定的画风。
      // ensureStylePresets 无条件预热：即使项目没设 art_style，风格库也已在缓存里，
      // stylePromptText() 不会退化成"吉卜力风格"四个字
      await ensureStylePresets()
      await restoreStyleFromProject(project.art_style)
      currentProjectId.value = project.id
      storeCurrentProjectId(project.id)
      storyboardConfirmed.value = false
      const epList = await api.getEpisodes(project.id)
      episodes.value = epList
      await loadProjectCharacters()
      if (epList.length > 0) {
        // 恢复上次选中的集（记住选择跨刷新，避免刷新后总跳回第一集导致操作错集）
        const rememberedId = recallEpisodeSelection(project.id)
        const remembered = epList.find((e) => e.id === rememberedId)
        const first = remembered || epList[0]
        currentEpisode.value = first.episode_number || 1
        await loadEpisode(first.id)
      } else {
        clearCurrentEpisode()
      }
      initialized.value = true
      return { success: true, project }
    } catch (e) {
      console.warn('加载项目失败:', e.message)
      clearCurrentEpisode()
      initialized.value = true
      return { success: false, error: e.message }
    }
  }

  // ===== 剧集管理 =====
  // 选集记忆（按项目存 localStorage）：刷新/重进后恢复上次选中的集
  const EP_SEL_KEY = STORAGE_KEYS.EPISODE_SELECTION
  function rememberEpisodeSelection(projectId, episodeId) {
    try {
      const map = JSON.parse(localStorage.getItem(EP_SEL_KEY) || '{}')
      map[projectId] = episodeId
      localStorage.setItem(EP_SEL_KEY, JSON.stringify(map))
    } catch { /* 存储异常忽略 */ }
  }
  function recallEpisodeSelection(projectId) {
    try {
      const map = JSON.parse(localStorage.getItem(EP_SEL_KEY) || '{}')
      return map[projectId] || null
    } catch { return null }
  }

  // 重新拉取当前项目下的全部剧集（标题/编号可能已变）
  async function loadEpisodes(projectId) {
    if (!projectId) { episodes.value = []; return [] }
    try {
      episodes.value = await api.getEpisodes(projectId)
    } catch (e) {
      console.warn('加载剧集列表失败:', e.message)
      episodes.value = []
    }
    return episodes.value
  }

  // ===== 系统告警（2026-09-13 建 / 2026-09-18 修补可见性洞）=====
  // 出片后置钩子链失败可见化：拉取当前集未处置告警，供成片页镜头卡片亮角标 + 顶部汇总条。
  // 显式传 episodeId，避免把别的集的告警混进当前视图。includeResolved 默认 false（只看未处置）。
  async function loadAlerts({ includeResolved = false, silent = true } = {}) {
    const epId = currentEpisodeId.value
    if (!epId) { systemAlerts.value = []; systemAlertCount.value = 0; return [] }
    try {
      const r = await api.getAlerts({ episodeId: epId, includeResolved })
      systemAlerts.value = Array.isArray(r?.alerts) ? r.alerts : []
      systemAlertCount.value = Number(r?.unresolved) || 0
      return systemAlerts.value
    } catch (e) {
      // 告警拉取失败不能影响主流程（silent=true 时不弹错）
      if (!silent) console.warn('加载系统告警失败:', e.message)
      return []
    }
  }
  // 按镜取未处置告警（镜头卡片角标用）
  //
  // ⚠️ 2026-09-18 修补：原本只按 shot_id 匹配，导致**场景维度告警永远匹配不上任何镜头**
  // （场景告警的 shot_id 是 NULL）。当时无人察觉——因为那时唯一的场景告警源带着
  // shot_id/scene_id 双空的缺陷（见下一条注释），正好也匹配不上，两者互为掩护。
  // 现状：sceneReview（场景图质检）/ asset-lighting（资产质检）都写场景维度告警，
  // 只按 shot_id 过滤会让它们**全部静默不可见**。
  // 修法保持通用：不硬编码 source 名，按告警**自身携带的维度字段**分流。
  //
  // ⚠️ 空值守卫是必须的（2026-09-18 补）：`Number(null) === 0`，若不加守卫，
  // alertsForShot(null) 会把**所有 shot_id 为空的场景维度告警**当成"某镜的告警"返回。
  // 视图当前只传真实 id，但这个契约太脆——一处疏忽就会把场景告警错标成镜头告警。
  // alertsForScene 自建立起就带守卫，此处与其对齐（两函数对称，读代码时不必记差异）。
  function alertsForShot(shotId) {
    if (shotId == null || shotId === '') return []
    return systemAlerts.value.filter((a) => Number(a.shot_id) === Number(shotId))
  }
  // 按场取未处置告警（场维度告警的展示入口）。
  // 走 scene_id 字段，与 shot_id 并列——两者是不同的域，不混用。
  function alertsForScene(sceneId) {
    if (sceneId == null || sceneId === '') return []
    return systemAlerts.value.filter((a) => Number(a.scene_id) === Number(sceneId))
  }
  // 「无处安放」的告警：既没 shot_id 也没 scene_id（历史脏数据 / 只带 episodeId 的告警）。
  // 设计要点：**必须显式暴露**而非丢弃——丢弃会让"顶部数字说有 3 条，列表却一条也找不到"重新出现。
  // 上一版就是这样：systemAlertCount 用后端 unresolved（含全部），而可见的只有按镜匹配上的，
  // 差额部分用户永远看不到也处置不掉。
  function alertsUnattached() {
    return systemAlerts.value.filter((a) => a.shot_id == null && a.scene_id == null)
  }
  // 处置：传 id 处置单条；传 shotId 处置某镜全部；传 sceneId 处置某场全部。
  // 处置后本地同步刷新（不重拉节省一次请求）。
  async function resolveAlerts(payload) {
    try {
      const r = await api.resolveAlert(payload)
      // 本地同步：处置成功的从列表移除，不重拉节省一次请求。
      // ⚠️ 2026-09-18 修补：原本只处理 id / shotId 两种——用 sceneId 处置（场景告警）时
      // 本地列表**没有同步移除**，于是"点了处置但告警还在"，且角标数字也不动。
      // 现在三选一全覆盖。注意三者互斥，用 if/else if 保持"按最具体维度"处置。
      if (payload?.id != null) {
        systemAlerts.value = systemAlerts.value.filter((a) => Number(a.id) !== Number(payload.id))
      } else if (payload?.shotId != null) {
        systemAlerts.value = systemAlerts.value.filter((a) => Number(a.shot_id) !== Number(payload.shotId))
      } else if (payload?.sceneId != null) {
        systemAlerts.value = systemAlerts.value.filter((a) => Number(a.scene_id) !== Number(payload.sceneId))
      }
      // 计数以本地列表为准：保证"顶上写的数字"与"下面能看到的条数"永远一致。
      // 放弃后端 unresolved 的另一个理由：那个数含**所有**维度，而本页只展示当前集可见的部分，
      // 两者口径不同，混用必然对不上。
      systemAlertCount.value = systemAlerts.value.length
      return { success: !!r?.success, resolved: Number(r?.resolved) || 0 }
    } catch (e) {
      return { success: false, error: e.message }
    }
  }

  // 切换到指定剧集：清掉换集前的生成态/版本/指纹，重载该集全部数据
  async function switchEpisode(episodeId) {
    if (!episodeId) return { success: false, error: 'episodeId 必填' }
    if (episodeId === currentEpisodeId.value) {
      // 已是当前集：重载一次保证数据最新
      return loadEpisode(episodeId)
    }
    clearGenerationState()
    const target = episodes.value.find((e) => e.id === episodeId)
    if (target) currentEpisode.value = target.episode_number || currentEpisode.value
    return loadEpisode(episodeId)
  }

  // 更新项目级宽高比。改完存库 + 同步内存，调用方（EpisodesView 下拉）即时反馈。
  // 关键约束：本字段是上游配置，**不会**回填已生成的图/视频；改完之后已出片仍是旧比例。
  // 这一点必须在 UI 文案里讲清楚，否则用户会以为"刷新一下就重渲染"。
  async function updateProjectAspectRatio(ratio) {
    if (!currentProjectId.value) return { success: false, error: '当前没有选中的项目' }
    if (!ratio) return { success: false, error: '比例不能为空' }
    const previous = aspectRatio.value
    // 乐观更新：先改本地再 PATCH；失败回滚。落库失败概率极低（白名单已在前端枚举过）
    aspectRatio.value = ratio
    try {
      await api.updateProject(currentProjectId.value, { aspect_ratio: ratio })
      return { success: true }
    } catch (e) {
      aspectRatio.value = previous
      return { success: false, error: e.message }
    }
  }

  // 新增剧集：创建后自动切换过去（空集，等待用户写剧本/导入）
  async function addEpisode({ title } = {}) {
    if (!currentProjectId.value) {
      toastWarn('请先选择项目')
      return { success: false, error: '当前没有选中的项目' }
    }
    try {
      const ep = await api.createEpisode(currentProjectId.value, { title: title || '' })
      episodes.value = [...episodes.value, ep]
      await switchEpisode(ep.id)
      return { success: true, episode: ep }
    } catch (e) {
      toastError('新增剧集失败', { detail: String(e.message) })
      return { success: false, error: e.message }
    }
  }

  // 重命名剧集（更新标题）
  async function renameEpisode(episodeId, title) {
    const t = String(title || '').trim()
    if (!t) return { success: false, error: '标题不能为空' }
    try {
      const updated = await api.updateEpisodeTitle(episodeId, t)
      episodes.value = episodes.value.map((e) =>
        e.id === episodeId ? { ...e, title: updated.title || t } : e
      )
      return { success: true }
    } catch (e) {
      toastError('重命名失败', { detail: String(e.message) })
      return { success: false, error: e.message }
    }
  }

  // 删除剧集：至少保留 1 集（后端也会拦截最后一集的删除）
  async function removeEpisode(episodeId) {
    if (episodes.value.length <= 1) {
      toastWarn('项目至少保留 1 集，无法删除')
      return { success: false, error: '至少保留 1 集' }
    }
    try {
      await api.deleteEpisode(episodeId)
      const wasCurrent = episodeId === currentEpisodeId.value
      episodes.value = episodes.value.filter((e) => e.id !== episodeId)
      if (wasCurrent) {
        const first = episodes.value[0]
        if (first) await switchEpisode(first.id)
        else clearCurrentEpisode()
      }
      return { success: true }
    } catch (e) {
      toastError('删除剧集失败', { detail: String(e.message) })
      return { success: false, error: e.message }
    }
  }

  // 刷新页面后恢复上次打开的项目；首次直达工作页时加载最新项目
  async function initProject() {
    if (currentProjectId.value) {
      initialized.value = true
      return { success: true }
    }

    let projectId = getStoredProjectId()
    if (!projectId && window.location.pathname !== '/projects') {
      try {
        const projects = await api.getProjects()
        projectId = projects[0]?.id || null
      } catch (e) {
        console.warn('恢复项目列表失败:', e.message)
      }
    }

    if (projectId) return selectProject(projectId)
    initialized.value = true
    return { success: true }
  }

  // 缓存 initProject 的 promise：路由守卫和 App 挂载共用，保证守卫校验前数据一定加载完成
  let initPromise = null
  function ensureReady() {
    if (!initPromise) {
      initPromise = initProject().catch((e) => {
        console.warn('初始化项目失败:', e)
        initialized.value = true
      })
    }
    return initPromise
  }

  // ===== 剧本页：AI 编剧对话 =====
  async function sendAiMessage() {
    if (!aiInput.value.trim() || aiLoading.value) return

    const userMsg = aiInput.value.trim()
    aiMessages.value.push({ role: 'user', content: userMsg })
    saveAiChatHistory()
    aiInput.value = ''

    // 意图分流后端化：空剧本只能整本生成；有剧本时交后端分类（revise/rewrite/generate）
    const hasScript = !!scriptContent.value.trim()
    const mode = hasScript ? 'auto' : 'generate'

    aiLoading.value = true
    handleAiProgress('submitting', { message: hasScript ? '正在分析要求并处理剧本...' : '正在生成剧本...' })

    // 空剧本首次生成时，先从资产库定位出场角色：
    // high → 带 characterIds 给后端，剧本沿用资产库形象；low → 提示用户点名；
    // none / 失败 → 按裸主题生成，与改造前行为一致。revise/rewrite 不路由（剧本角色已定）。
    let routeInfo = null
    if (mode === 'generate') {
      try {
        routeInfo = await api.ipRoute({ prompt: userMsg, projectId: currentProjectId.value })
      } catch { /* 路由失败按裸主题生成 */ }
    }
    const routeCharIds =
      routeInfo?.confidence === 'high' && routeInfo.characters?.length
        ? routeInfo.characters.map((c) => c.id)
        : null

    try {
      // 优先调用后端（阿里云百炼）
      if (currentEpisodeId.value) {
        const result = await api.generateScript({
          episodeId: currentEpisodeId.value,
          prompt: userMsg,
          context: scriptContent.value,
          mode,
          characterIds: routeCharIds,
        })
        if (result.script) {
          const changed = result.changed === true
          const actualMode = ['revise', 'rewrite', 'generate'].includes(result.mode) ? result.mode : 'generate'
          if (actualMode === 'revise') {
            // 定点修改：不直接改正文，存入 pendingRewrite 走 diff 预览，用户接受后才生效
            // （改了哪几行一目了然，replaceAll 误伤台词时也有机会在预览里拦下）
            if (changed) {
              // 指令回声过滤：AI 偶发把用户指令原文当"新增内容"写进剧本，剥掉这类行
              const stripped = stripInstructionEcho(scriptContent.value, result.script)
              pendingRewrite.value = {
                selectedText: scriptContent.value,
                rewrittenText: stripped.text,
                instruction: userMsg,
                source: 'chat',
              }
              const echoNote = stripped.removed
                ? `（已自动过滤 ${stripped.removed} 行疑似指令回声文本，未计入改动）`
                : ''
              aiMessages.value.push({
                role: 'assistant',
                content: `已按你的要求完成修改${echoNote}，请在弹出的预览里核对改动（绿色为新增、红色为删除），未涉及的内容一字未动；点「接受」后生效，接受前的版本会自动存入历史。`,
              })
            } else {
              aiMessages.value.push({
                role: 'assistant',
                content: '这次没有产生修改。可以试试更具体的说法（如"把第2场的开头改成雨夜"），或选中正文段落后直接改写。',
              })
            }
          } else {
            // 整本生成/整理：直接替换正文（后端已落库）；有变化时先把当前正文存为可回滚版本
            if (hasScript && changed) {
              pushScriptVersion(`AI ${actualMode === 'rewrite' ? '整理' : '重写'}前：${userMsg.slice(0, 16)}${userMsg.length > 16 ? '…' : ''}`)
            }
            scriptContent.value = result.script
            // 后端在剧本实质变化时已复位 script_confirmed/storyboard_confirmed，前端镜像同步，
            // 避免「已确认」状态与库不一致导致下游绕过确认（新剧本必须重新走人工确认）
            if (changed) {
              scriptConfirmed.value = false
              storyboardConfirmed.value = false
            }
            // 资产定位结果提示：high 已应用；low 提示点名，不自动绑
            let assetNote = ''
            if (actualMode === 'generate' && routeInfo) {
              const names = (routeInfo.characters || []).map((c) => c.name)
              if (routeInfo.confidence === 'high' && names.length) {
                assetNote = ` 已定位资产角色：${names.join('、')}，形象与音色直接沿用资产库设定。`
              } else if (routeInfo.confidence === 'low' && names.length) {
                assetNote = ` 提示：主题疑似涉及「${names.join('、')}」，置信度不足未自动应用；如需沿用其设定，请在主题里写明角色名。`
              }
            }
            aiMessages.value.push({
              role: 'assistant',
              content:
                actualMode === 'rewrite'
                  ? '已按要求整本整理完成，未要求改动的内容保持原意。整理前的版本已存入版本历史，可随时回滚。'
                  : `剧本已生成，右侧已自动解析分场大纲。满意后点击右下角「确认剧本」选择画风。${assetNote}`,
            })
          }
          saveAiChatHistory()
          aiLoading.value = false
          aiStatus.value = 'done'
          return
        }
      }
      throw new Error('后端未返回剧本')
    } catch (e) {
      // 失败时明确提示，不再用演示剧本掩盖真实错误
      console.warn('AI 剧本处理失败:', e.message)
      aiMessages.value.push({
        role: 'assistant',
        content: `处理失败：${e.message}`,
      })
      saveAiChatHistory()
    }

    aiLoading.value = false
    aiStatus.value = ''
  }

  async function saveDraft() {
    if (!currentEpisodeId.value) {
      toastWarn('当前没有选中的集，无法保存')
      return { success: false, error: '当前没有选中的集' }
    }
    try {
      await api.updateScript(currentEpisodeId.value, {
        script_content: scriptContent.value,
        script_confirmed: scriptConfirmed.value ? 1 : 0,
      })
      toastSuccess('草稿已保存')
      return { success: true }
    } catch (e) {
      toastError('保存草稿失败', { detail: String(e.message) })
      return { success: false, error: e.message }
    }
  }

  function confirmScript() {
    if (!scriptContent.value.trim()) {
      toastWarn('请先编写或生成剧本内容')
      return
    }
    const parsed = parseScenesFromScript(scriptContent.value)
    scenes.value = parsed
    activeSceneId.value = scenes.value[0]?.id ?? null
    scriptConfirmed.value = true
    storyboardConfirmed.value = false

    // 同步到后端；确认时后端会把非标准格式（外部粘贴的变体场次标记、无标记对话稿等）
    // 自动转换为标准格式，转换后的正文回填编辑框，watch 会自动重解析分场大纲
    if (currentEpisodeId.value) {
      api
        .updateScript(currentEpisodeId.value, { script_content: scriptContent.value, script_confirmed: 1 })
        .then((ep) => {
          if (ep?.script_content && ep.script_content !== scriptContent.value) {
            scriptContent.value = ep.script_content
          }
          // 用库内真实状态回填，消除内存与库不一致（后端在内容变化时会复位 storyboard_confirmed）
          scriptConfirmed.value = !!ep?.script_confirmed
          storyboardConfirmed.value = !!ep?.storyboard_confirmed
        })
        .catch((e) => {
          // 保存失败：回退乐观置位，让用户知道没确认成功
          scriptConfirmed.value = false
          toastError('剧本确认失败', { detail: String(e?.message || e) })
        })
    }
  }

  function reconfirmScript() {
    if (!scriptContent.value.trim()) {
      toastWarn('剧本内容不能为空')
      return
    }
    const parsed = parseScenesFromScript(scriptContent.value)
    scenes.value = parsed
    activeSceneId.value = scenes.value[0]?.id ?? null
    toastSuccess('剧本已重新确认，分场大纲已更新')
  }

  // ===== AI 改稿助手：局部改写 + 版本历史 =====
  function pushScriptVersion(note, content = scriptContent.value) {
    const nextV = `V${scriptVersions.value.length + 1}`
    scriptVersions.value.unshift({
      v: nextV,
      time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
      note,
      content,
    })
    return nextV
  }

  // 调用后端局部改写接口，返回改写结果存入 pendingRewrite（不直接改正文，等用户接受）
  async function rewriteScript({ instruction, selectedText }) {
    if (!instruction || !String(instruction).trim()) return { success: false, error: '请填写改写要求' }
    if (!selectedText || !String(selectedText).trim()) return { success: false, error: '请先选中要改写的段落' }
    if (aiLoading.value) return { success: false, error: 'AI 正在处理，请稍候' }

    aiLoading.value = true
    try {
      const result = await api.rewriteScript({
        instruction: String(instruction).trim(),
        selectedText: String(selectedText),
        context: scriptContent.value,
      })
      if (!result.rewrittenText) throw new Error('后端未返回改写结果')
      pendingRewrite.value = {
        selectedText: String(selectedText),
        rewrittenText: result.rewrittenText,
        instruction: String(instruction).trim(),
      }
      return { success: true, pendingRewrite: pendingRewrite.value }
    } catch (e) {
      return { success: false, error: e.message }
    } finally {
      aiLoading.value = false
    }
  }

  // 接受改写：当前正文先入历史版本，再用改写段落替换选中段落
  function acceptRewrite() {
    if (!pendingRewrite.value) return { success: false, error: '没有待接受的改写' }
    const { selectedText, rewrittenText, instruction, source } = pendingRewrite.value
    const next = scriptContent.value.replace(selectedText, rewrittenText)
    if (next === scriptContent.value) return { success: false, error: '正文中未找到选中段落，无法应用' }
    pushScriptVersion(`${source === 'chat' ? 'AI 修改' : 'AI 改写'}：${instruction.slice(0, 24)}${instruction.length > 24 ? '…' : ''}`)
    scriptContent.value = next
    // 正文实质变化，旧确认/分镜确认不再可信，需重新确认
    scriptConfirmed.value = false
    storyboardConfirmed.value = false
    pendingRewrite.value = null
    return { success: true }
  }

  function rejectRewrite() {
    pendingRewrite.value = null
    return { success: true }
  }

  // 另存为新版本：把改写结果登记为可回滚版本，但不应用到正文
  function saveAsVersion() {
    if (!pendingRewrite.value) return { success: false, error: '没有待保存的改写' }
    const { instruction, rewrittenText } = pendingRewrite.value
    pushScriptVersion(
      `AI 改写（另存）：${instruction.slice(0, 24)}${instruction.length > 24 ? '…' : ''}`,
      rewrittenText
    )
    pendingRewrite.value = null
    return { success: true }
  }

  function revertToVersion(v) {
    const ver = scriptVersions.value.find((x) => x.v === v)
    if (!ver) return { success: false, error: '版本不存在' }
    // 回滚到旧版本 = 正文实质变化，已确认状态失效，需重新确认
    if (ver.content !== scriptContent.value) {
      scriptConfirmed.value = false
      storyboardConfirmed.value = false
    }
    scriptContent.value = ver.content
    return { success: true }
  }

  // 锁定剧本快照：零副作用（不确认、不跳转、不扣费），仅登记版本
  function lockScript() {
    if (!scriptContent.value.trim()) return { success: false, error: '请先编写或导入剧本内容' }
    pushScriptVersion('锁定快照')
    return { success: true }
  }

  // ===== 设定页：资产提取 =====
  // 上次成功提取资产的指纹（剧本内容 + 画风标签）。
  // 内存 + localStorage 双写：刷新/切集后仍能判断「剧本/画风是否在提取后变过」。
  // 仅当两者都没变时才拦截重复提取；任一变了 → 放行（那是合理提取）并在画风页提示。
  const lastExtractInfo = ref(null)
  function extractFpKey() {
    return `${STORAGE_KEY_PREFIX.EXTRACT_FP}${currentEpisodeId.value || 'none'}`
  }
  function loadExtractInfo() {
    try {
      const raw = localStorage.getItem(extractFpKey())
      lastExtractInfo.value = raw ? JSON.parse(raw) : null
    } catch {
      lastExtractInfo.value = null
    }
  }
  function saveExtractInfo(script, styleLabel) {
    lastExtractInfo.value = { script, styleLabel }
    try {
      localStorage.setItem(extractFpKey(), JSON.stringify(lastExtractInfo.value))
    } catch { /* localStorage 不可用时退化为内存态 */ }
  }

  // ===== 剧本变更后的下游失效提示 =====
  // 上次成功生成/确认分镜时的剧本指纹（localStorage 持久化，刷新后仍能判断分镜是否过期）
  const lastStoryboardInfo = ref(null)
  function storyboardFpKey() {
    return `${STORAGE_KEY_PREFIX.STORYBOARD_FP}${currentEpisodeId.value || 'none'}`
  }
  function loadStoryboardInfo() {
    try {
      const raw = localStorage.getItem(storyboardFpKey())
      lastStoryboardInfo.value = raw ? JSON.parse(raw) : null
    } catch {
      lastStoryboardInfo.value = null
    }
  }
  function saveStoryboardInfo(script) {
    lastStoryboardInfo.value = { script }
    try {
      localStorage.setItem(storyboardFpKey(), JSON.stringify(lastStoryboardInfo.value))
    } catch { /* localStorage 不可用时退化为内存态 */ }
  }
  // 资产/分镜是否落后于当前剧本：优先用数据库下发的指纹（跨浏览器可靠），
  // 老数据无库内指纹时退回浏览器本地记录（仅当前浏览器有效）；两者都没有则不提示
  const episodeScriptHash = ref('')
  const episodeAssetsFp = ref('')
  const episodeStoryboardFp = ref('')
  const assetsStale = computed(() => {
    if (episodeAssetsFp.value) return episodeAssetsFp.value !== episodeScriptHash.value
    return !!lastExtractInfo.value && lastExtractInfo.value.script !== (scriptContent.value || '')
  })
  const storyboardStale = computed(() => {
    // 用户导入的分镜脚本不随剧本改动提示过期：它是用户独立创作/拆好的镜头，不是剧本的派生产物
    if (storyboardSource.value === 'imported') return false
    if (episodeStoryboardFp.value) return episodeStoryboardFp.value !== episodeScriptHash.value
    return !!lastStoryboardInfo.value && lastStoryboardInfo.value.script !== (scriptContent.value || '')
  })

  // 部分保存失败时暂存已映射好的提取结果 + 指纹，下次提取直接重试保存，不再调 LLM 扣费。
  // 带 episodeId 守卫：换集后自动失效（不同集不会误用旧暂存）
  const pendingAssetSave = ref(null)

  async function extractAssets() {
    if (!scriptContent.value.trim()) {
      toastWarn('请先编写或确认剧本')
      return
    }
    if (aiLoading.value) return

    const fingerprint = scriptContent.value
    const styleLabel = currentStyle.value?.label || artStyle.value || ''
    const episodeId = currentEpisodeId.value

    // 免扣费重试：上次部分保存失败留下的待保存结果，同集再次提取直接走保存，不再调 LLM
    const resumeSave = !!(pendingAssetSave.value && pendingAssetSave.value.episodeId === episodeId)

    if (!resumeSave) {
      // 覆盖提示：已有资产时无论指纹是否一致都确认（含手动添加内容会被覆盖）
      const hasExisting = characters.value.length || assetScenes.value.length || props.value.length
      if (hasExisting) {
        const sameAsLast = lastExtractInfo.value &&
          lastExtractInfo.value.script === fingerprint &&
          lastExtractInfo.value.styleLabel === styleLabel
        // 覆盖确认（结构化）：资产数量是可量化的损失，单独成行比塞进一句话清楚
        // 「重复提取会再次消耗余额」是这条确认里唯一的计费风险，标 warn 色
        const ok = await confirmDialog({
          title: sameAsLast ? '重复提取资产' : '重新提取资产',
          description: sameAsLast
            ? '剧本与画风均与上次提取时一致，本次会再次调用模型并消耗余额。'
            : '剧本或画风已变化，新提取会覆盖现有资产（含手动添加的内容）。',
          details: [
            { label: '角色', value: `${characters.value.length} 个` },
            { label: '场景', value: `${assetScenes.value.length} 个` },
            { label: '道具', value: `${props.value.length} 个` },
            { label: '计费', value: '重新调用模型，会消耗余额', tone: 'warn' },
          ],
          confirmText: '覆盖并重新提取',
          cancelText: '保留现有资产',
          tone: 'warn',
        })
        if (!ok) return { success: false, skipped: true }
      }
    }

    aiLoading.value = true
    handleAiProgress('submitting', { message: resumeSave ? '正在重试保存资产...' : '正在提取角色/场景/道具...' })

    try {
      if (!episodeId) throw new Error('当前没有选中的集')

      let mapped, scriptFp
      if (resumeSave) {
        // 复用上次已映射好的结果与指纹，跳过 LLM 调用
        mapped = pendingAssetSave.value
        scriptFp = mapped.scriptFp
      } else {
        // 先保存旧资产的图片/音频 URL（按名称匹配，重新提取后同名带回，避免已生成的资产图和音色绑定丢失）
        const oldCharImages = {}
        const oldCharAudios = {}
        const oldSceneImages = {}
        const oldSceneLighting = {}
        const oldPropImages = {}
        // 旧描述也要留底：同名带回旧图时，若新描述与旧描述不同，旧图就和新描述"打架"
        // （图文一致性哨兵 2026-09-16：出片时参考图与 prompt 描述矛盾，场1"断桥"实锤）
        const oldCharDesc = {}
        const oldSceneDesc = {}
        const oldPropDesc = {}
        characters.value.forEach(c => {
          if (c.imageUrl) oldCharImages[c.name] = c.imageUrl
          if (c.audioUrl) oldCharAudios[c.name] = c.audioUrl
          oldCharDesc[c.name] = c.description || ''
        })
        assetScenes.value.forEach(s => {
          if (s.imageUrl) oldSceneImages[s.name] = s.imageUrl
          // 场景光影常量：重新提取不抹掉手工维护值（与旧图同语义，同名带回）
          if (s.lightingEn) oldSceneLighting[s.name] = s.lightingEn
          oldSceneDesc[s.name] = s.description || ''
        })
        props.value.forEach(p => {
          if (p.imageUrl) oldPropImages[p.name] = p.imageUrl
          oldPropDesc[p.name] = p.description || ''
        })

        const result = await api.generateAssets({ episodeId, style: styleLabel })
        if (!result.assets) throw new Error('后端未返回资产')
        scriptFp = result.scriptFp || ''

        mapped = {
          episodeId,
          scriptFp,
          characters: (result.assets.characters || []).map((c, i) => ({
            id: Date.now() + i, // 临时 id，保存后由 loadEpisode 替换为后端真实 id
            name: c.name || `角色${i + 1}`,
            role: c.role || '配角',
            description: c.description || '',
            color: characterColor(i),
            imageUrl: oldCharImages[c.name] || '', // 保留旧图
            audioUrl: oldCharAudios[c.name] || '', // 保留旧音色（同名角色跨剧本复用）
            // 英文常量透传（2026-09-16）：提取结果里的 nameEn/descriptionEn 必须带上，
            // 否则保存时后端收不到 → 手工维护的英文外貌描述被抹掉（H3 提示词会混入中文）。
            nameEn: c.nameEn || c.name_en || '',
            descriptionEn: c.descriptionEn || c.description_en || '',
          })),
          props: (result.assets.props || []).map((p, i) => ({
            id: Date.now() + i,
            name: typeof p === 'string' ? p : (p.name || `道具${i + 1}`),
            description: typeof p === 'string' ? '' : (p.description || ''),
            owner: typeof p === 'string' ? '' : (p.owner || ''),
            imageUrl: oldPropImages[typeof p === 'string' ? p : p.name] || '',
            // 英文常量透传（2026-09-16）：props.name_en → nameEn，缺了会被后端按空值重建
            nameEn: typeof p === 'string' ? '' : (p.nameEn || p.name_en || ''),
            descriptionEn: typeof p === 'string' ? '' : (p.descriptionEn || p.description_en || ''),
          })),
          scenes: (result.assets.scenes || []).map((s, i) => ({
            id: Date.now() + i,
            name: s.name || `场景${i + 1}`,
            description: s.description || '',
            propNames: Array.isArray(s.props) ? s.props.map(String) : (Array.isArray(s.propNames) ? s.propNames : []),
            imageUrl: oldSceneImages[s.name] || '',
            // 英文常量透传（2026-09-16）：场景英文键同样必须带上
            titleEn: s.titleEn || s.title_en || '',
            summaryEn: s.summaryEn || s.summary_en || '',
            lightingEn: s.lightingEn || s.lighting_en || '',
            // 场景地点（scenes.location）：LLM 提取结果可能是 snake_case
            location: s.location || s.location_en || '',
          })),
        }

        // 图文一致性哨兵（2026-09-16）：同名带回旧图 + 描述有变化 → 旧图与新描述打架。
        // 不自动重出（旧图可能是用户精修的），落库成功后 toast 告知用户，由其决策一键重出。
        mapped.staleAssets = [
          ...mapped.characters
            .filter(c => oldCharImages[c.name] && (oldCharDesc[c.name] || '') !== (c.description || ''))
            .map(c => ({ type: 'character', name: c.name })),
          ...mapped.props
            .filter(p => oldPropImages[p.name] && (oldPropDesc[p.name] || '') !== (p.description || ''))
            .map(p => ({ type: 'prop', name: p.name })),
          ...mapped.scenes
            .filter(s => oldSceneImages[s.name] && (oldSceneDesc[s.name] || '') !== (s.description || ''))
            .map(s => ({ type: 'scene', name: s.name })),
        ]
      }

      // 治本（修复「提取后刷新就没了」）：之前是「先乐观更新内存 → 再保存」，
      // 保存失败时内存已显示新值、但库里没写进，刷新后从库读旧值，造成假消失。
      // 现在改为「先全部落库、成功后才更新内存」，内存永远 == 已落库结果，刷新前后一致。
      const saveErrors = []
      // P1：三类资产的覆盖决策（'keep' | 'accept'）记在此处，供「部分保存失败后免扣费重试」复用
      const decisions = mapped.decisions || (mapped.decisions = {})
      try {
        if (mapped.characters.length) {
          // source='extract' 让后端以项目角色库主设定为准，避免 LLM 每次重提都覆盖已确认的形象/描述
          await saveAssetsGuarded({ episodeId, table: 'characters', items: mapped.characters, saveFn: api.saveCharacters, decisions })
        }
      } catch (e) { saveErrors.push(`角色：${e.message}`) }
      try {
        if (mapped.props.length) {
          await saveAssetsGuarded({ episodeId, table: 'props', items: mapped.props, saveFn: api.saveProps, decisions })
        }
      } catch (e) { saveErrors.push(`道具：${e.message}`) }
      try {
        if (mapped.scenes.length) {
          await saveAssetsGuarded({ episodeId, table: 'scenes', items: mapped.scenes, saveFn: api.saveScenes, decisions })
        }
      } catch (e) { saveErrors.push(`场景：${e.message}`) }

      if (saveErrors.length) {
        // 暂存已映射结果与指纹，提示用户再次提取将直接重试保存（不再消耗余额）
        pendingAssetSave.value = { ...mapped, scriptFp }
        toastError(`部分资产保存失败（${saveErrors.length} 项）`, {
          detail: `${saveErrors.join('；')}\n已提取的结果已保留，再次点击「提取资产」将直接重试保存，不再消耗余额。`,
        })
        aiLoading.value = false
        aiStatus.value = ''
        // 注意：此处不更新内存，保持旧值（=库里真实值），避免刷新前后不一致
        return { success: false, partial: true }
      }

      // 全部保存成功：仅对非空类别更新内存（空类别保持原值，沿用后端「空列表即拒绝」语义），
      // 重新加载拿真实 id，登记指纹（落库成功才登记，避免 stale 假阴性）
      //
      // ⚠️ 英文常量保全校验（2026-09-16）：mapped.* 现在自带 nameEn/descriptionEn/titleEn/
      // summaryEn/lightingEn（见上方映射），与「保存时后端按同名继承」是双保险——
      // 前端带上 → 后端用显式值；万一没带上 → 后端仍会继承 DB 旧值。两条都不丢。
      // 紧随其后的 loadEpisode() 会用后端真实值整体覆盖，所以这里只是过渡态。
      if (mapped.characters.length) characters.value = mapped.characters
      if (mapped.props.length) props.value = mapped.props
      if (mapped.scenes.length) assetScenes.value = mapped.scenes
      pendingAssetSave.value = null
      await loadEpisode(episodeId)
      if (scriptFp) {
        try { await api.saveExtractInfo(episodeId, scriptFp) } catch (e) { console.warn('[extractAssets] 指纹登记失败:', e.message) }
      }
      saveExtractInfo(fingerprint, styleLabel)
      // 图文一致性哨兵落地：有"描述变了但沿用旧图"的资产 → 提示用户决策（重出 or 忽略），
      // 不再像场1断桥那样零提示，等出片才发现图与描述对不上。
      if (Array.isArray(mapped.staleAssets) && mapped.staleAssets.length) {
        const preview = mapped.staleAssets.slice(0, 5).map(a => a.name).join('、')
          + (mapped.staleAssets.length > 5 ? ` 等 ${mapped.staleAssets.length} 项` : '')
        toastWarn(`${mapped.staleAssets.length} 个资产的描述已更新，但图片还是旧的`, {
          detail: `${preview}\n旧图按之前的描述生成，可能和新描述对不上（出片会图文打架）。点「一键重新生成」按新描述重出这些图（会覆盖现有图）。`,
          action: { label: '一键重新生成', onClick: () => regenerateStaleAssets(mapped.staleAssets) },
          duration: 0, // 等用户决策，不自动消失
        })
      }
      aiLoading.value = false
      aiStatus.value = 'done'
      return { success: true }
    } catch (e) {
      toastError('提取失败', { detail: String(e.message) })
    }

    aiLoading.value = false
    aiStatus.value = ''
    return { success: false }
  }

  // ===== 分镜页：重新提取分镜脚本 =====
  async function extractStoryboard() {
    // 提前退出也统一返回 { success: false }：调用方（如 SettingsView 的
    // handleAiStoryboard）会直接读 result.success，返回 undefined 会抛 TypeError，
    // 把「请先编写剧本」这类正常拦截误报成「生成分镜失败」。
    if (!scriptContent.value.trim()) {
      toastWarn('请先编写或确认剧本')
      return { success: false }
    }
    if (aiLoading.value) return { success: false }

    aiLoading.value = true
    handleAiProgress('submitting', { message: '正在生成分镜脚本...' })
    let sbOk = false

    // 进度轮询（2026-09-15，2026-09-16 抽成公共函数）：后端分场生成实时进度回显
    // （"第 X/Y 场完成" + 阶段 + 已用时），轮询失败静默——进度绝不能影响生成主流程。
    startSbProgressPolling(currentEpisodeId.value)

    try {
      if (currentEpisodeId.value) {
        const result = await api.generateStoryboard({
          episodeId: currentEpisodeId.value,
        })
        if (result.storyboard?.scenes) {
          // 先保存到后端
          await api.saveStoryboard(currentEpisodeId.value, {
            storyboardScenes: result.storyboard.scenes,
            storyboard_confirmed: false,
          })
          storyboardConfirmed.value = false
          // 重新加载以获取真实的镜头ID，并确保页面展示的是后端刚保存的最新方案
          const reloadResult = await loadEpisode(currentEpisodeId.value)
          if (!reloadResult?.success) {
            throw new Error(reloadResult?.error || '分镜已保存，但重新加载失败')
          }
          // 登记分镜对应的剧本指纹，供分镜页判断「剧本已改、分镜过期」
          saveStoryboardInfo(scriptContent.value)
          toastSuccess('分镜提取完成，已加载最新分镜方案', {
            detail: `共 ${totalShots.value} 个镜头，可继续检查或确认分镜。`,
          })
          // 未识别资产提示：分镜里引用了资产库没有的角色/场景/道具名，已被后端静默丢弃，
          // 这里汇总提示用户去设定页补齐后重新生成（不再无声发生）
          const unmatched = result.unmatched || []
          if (unmatched.length) {
            const lines = unmatched.slice(0, 5).map((u) => {
              const parts = []
              if (u.characters?.length) parts.push(`角色 ${u.characters.join('、')}`)
              if (u.scenes?.length) parts.push(`场景 ${u.scenes.join('、')}`)
              if (u.props?.length) parts.push(`道具 ${u.props.join('、')}`)
              return `第${u.shotNumber}镜：${parts.join('，')}`
            })
            const more = unmatched.length > 5 ? `\n…等共 ${unmatched.length} 个镜头` : ''
            console.warn('[extractStoryboard] 未识别资产引用：', unmatched)
            toastWarn(`有 ${unmatched.length} 个镜头引用了不存在的资产（已自动忽略）`, {
              detail: `${lines.join('\n')}${more}\n建议在设定页补齐对应资产后重新生成分镜。`,
            })
          }
          aiLoading.value = false
          aiStatus.value = 'done'
          sbOk = true
          return { success: true }
        }
      }
      throw new Error('后端未返回分镜')
    } catch (e) {
      toastError('提取失败', { detail: String(e.message) })
    } finally {
      // 无论成功失败都要停轮询，避免定时器泄漏；并把快照切成结束态 + 安排清空
      stopSbProgressPolling()
      settleSbProgress(sbOk ? '分镜生成完成' : '生成流程已结束')
      clearSbProgressAfter()
    }

    aiLoading.value = false
    aiStatus.value = ''
    return { success: false }
  }

  // ===== 长任务进度轮询（2026-09-16）=====
  // 三条长任务路径（生成分镜 / 文件规整 / 补全提示词）共用一套轮询：
  //   - 按固定间隔拉取结构化进度，写入 sbProgress 供进度条渲染
  //   - 轮询自身失败一律静默：进度是体验增强，绝不能影响生成主流程
  //   - 防重入：已在轮询时不重复起定时器（否则多个任务并跑会互相打断）
  //   - 任务终态（active=false）读到后自动停，避免空转请求
  //   - 快照防串：记录本次轮询的代次，迟到的响应不覆盖新一轮的快照
  //
  // 轮询代次：每次 start/stop 都自增。异步响应回来时若代次已变，说明这是上一轮的
  // 迟到结果（任务已切换或已停止），直接丢弃——否则会把旧任务的终态盖到新任务上。
  let sbPollGeneration = 0
  // 在途标记：防止 fetch 慢时多个 tick 并发堆积（每个 tick 都带一次网络往返）
  let sbTickInFlight = false
  // 收尾清空代次（2026-09-19）：见 clearSbProgressAfter 的注释——
  // 用代次而不是"快照当前是否活跃"来判断，修掉残留的僵尸进度条。
  let sbClearToken = 0

  function stopSbProgressPolling() {
    if (sbProgressTimer) { clearInterval(sbProgressTimer); sbProgressTimer = null }
    // 代次自增：使在途的迟到响应失效（见 startSbProgressPolling 内注释）
    sbPollGeneration++
  }

  function startSbProgressPolling(episodeId = currentEpisodeId.value) {
    if (!episodeId) return
    // 防重入：先停旧的，保证任何时刻只有一个定时器
    stopSbProgressPolling()
    // 新任务开始：作废上一次安排的收尾清空，避免它把本轮的新快照清掉
    sbClearToken++
    sbProgress.value = null
    const myGeneration = sbPollGeneration
    const tick = async () => {
      // 并发防抖：上一次请求还没回来就跳过本轮，避免慢网络下堆积请求
      if (sbTickInFlight) return
      sbTickInFlight = true
      try {
        const p = await api.getStoryboardProgress(episodeId)
        // 迟到丢弃：本轮已被 stop/restart，响应不再写入
        if (myGeneration !== sbPollGeneration) return
        if (p?.active) {
          sbProgress.value = p
          // 兼容文本位：老组件只读 aiProgressMessage，这里同步一份文案
          if (p.message) aiProgressMessage.value = p.message
        } else if (p && !p.active) {
          // 终态：保留最后一次快照（进度条可显示"完成"），并停止轮询
          sbProgress.value = p
          stopSbProgressPolling()
        }
      } catch { /* 进度轮询失败静默，绝不影响主流程 */ }
      finally { sbTickInFlight = false }
    }
    // 立刻拉一次，避免首个间隔内进度条空白
    tick()
    sbProgressTimer = setInterval(tick, BATCH_GEN.STORYBOARD_PROGRESS_POLL_MS)
  }

  // 请求已返回但快照仍是"进行中"时，立刻把它切成结束态（2026-09-19）：
  // 否则最后几秒仍显示转圈 + 旧文案，配合下面的延迟清空，看起来就像"卡住不动"。
  // 只改展示层字段，不伪造后端结论（message 由调用方按实际成败传入）。
  function settleSbProgress(message) {
    if (!sbProgress.value?.active) return
    sbProgress.value = {
      ...sbProgress.value,
      active: false,
      phase: 'done',
      phaseLabel: '已结束',
      message: message || '生成流程已结束',
      percent: 100,
    }
  }

  // 收尾清空：任务结束后延迟清掉快照，避免"已完成"横幅一直挂着，也避免残留僵尸条。
  // 延迟是为了让用户看到完成状态（而不是刚完成就消失）。时长见 BATCH_GEN.PROGRESS_CLEAR_AFTER_MS。
  //
  // 2026-09-19 修（僵尸进度条）：原实现是"只在快照已非活跃时清"——本意是防止误清新任务的快照，
  // 但判断依据用错了：调用本函数时**主请求已经返回**，此刻界面上的任何"进行中"快照在定义上
  // 都是过期的（最后一个 tick 早于终态，读到的还是 active=true）。于是条件不成立 → 不清 →
  // 进度条永远停在"修补中 6/12"，用户以为卡死（实际后端早已完成并入库）。
  // 改为代次判断：只要期间没有新任务启动（sbClearToken 未变），就无条件清掉。
  function clearSbProgressAfter(ms = BATCH_GEN.PROGRESS_CLEAR_AFTER_MS) {
    const myToken = ++sbClearToken
    setTimeout(() => {
      // 期间又起了新任务（token 已变）→ 本轮清空作废，别动新任务的快照
      if (myToken !== sbClearToken) return
      sbProgress.value = null
      aiProgressMessage.value = ''
    }, ms)
  }

  async function confirmStoryboard() {
    if (!storyboardScenes.value.length || !totalShots.value) {
      toastWarn('请先生成分镜脚本')
      return { success: false }
    }
    if (!currentEpisodeId.value) return { success: false, error: '当前没有选中的集' }
    try {
      await api.saveStoryboard(currentEpisodeId.value, {
        storyboardScenes: storyboardScenes.value,
        storyboard_confirmed: true,
      })
      storyboardConfirmed.value = true
      // 确认即认可当前分镜与当前剧本匹配，登记指纹
      saveStoryboardInfo(scriptContent.value)
      return { success: true }
    } catch (e) {
      toastError('确认分镜失败', { detail: String(e.message) })
      return { success: false, error: e.message }
    }
  }

  // ===== 清空分镜（整本删除，用于重新导入/重新生成）=====
  async function clearStoryboard() {
    if (!currentEpisodeId.value) return { success: false, error: '当前没有选中的集' }
    try {
      await api.clearStoryboard(currentEpisodeId.value)
      storyboardScenes.value = []
      storyboardConfirmed.value = false
      episodeStoryboardFp.value = ''
      storyboardSource.value = 'generated'
      lastStoryboardInfo.value = null
      try {
        localStorage.removeItem(storyboardFpKey())
      } catch { /* localStorage 不可用时忽略 */ }
      // 以数据库为准重新拉一遍，确保清干净
      await loadEpisode(currentEpisodeId.value)
      return { success: true }
    } catch (e) {
      console.error('清空分镜失败', e)
      return { success: false, error: e.message }
    }
  }

  // ===== 找到镜头（兼容数字 ID 和字符串 ID）=====
  function findShot(shotId) {
    for (const scene of storyboardScenes.value) {
      const shot = scene.shots.find((s) => s.id === shotId || String(s.id) === String(shotId))
      if (shot) return { shot, scene }
    }
    return null
  }

  // 汇总镜头涉及资产（角色/场景/道具）的设定描述，拼进生图 prompt
  // 保证同一资产在所有镜头中的文字描述与设定库完全一致（跨图一致性约束）
  function buildAssetBrief(shot) {
    const parts = []
    const lockParts = []
    const push = (names, list, label) => {
      for (const name of (Array.isArray(names) ? names : [])) {
        const item = list.value.find(x => x.name === name)
        if (item?.description) parts.push(`${label}【${name}】：${item.description}`)
      }
    }
    push(shot.characters, characters, '角色')
    push(shot.sceneAssets, assetScenes, '场景')
    push(shot.propAssets, props, '道具')

    // 角色视觉锁定
    for (const name of (shot.characters || [])) {
      const c = characters.value.find(x => x.name === name)
      if (c?.description) {
        lockParts.push(`@${name} exactly as shown, ${c.description}`)
      }
    }
    // 角色冻结
    if (shot.sceneAssets?.length) {
      lockParts.push(`The scene environment remains completely unchanged in structure, color, and arrangement — no element shifts or disappears`)
    }
    // 道具专属（简单声明）
    for (const name of (shot.propAssets || [])) {
      lockParts.push(`The prop【${name}】保持其外观和材质不变`)
    }

    if (!parts.length && !lockParts.length) return ''
    let result = ''
    if (parts.length) result += `。画面要素必须严格遵循以下设定：【${parts.join('、')}】`
    if (lockParts.length) result += `。【视觉锁定】${lockParts.join('、')}`
    return result
  }

  // 视频专用 prompt 组装（H3 协议映射表、形象/比例约束）已拆到
  // src/services/promptBuilder.js 纯函数层，本文件通过 import 使用（依赖经 ctx 注入）

  // 【画风统一约束】所有生成（角色/场景/道具/分镜图还是视频）prompt 的公共后缀
  // 无论角色、场景、道具、分镜图还是视频，全画面的线条、上色、光影、质感
  // 都锁定同一个画风（currentStyle），与镜头内的画风 prompt 首尾呼应
  // 防止后面的长约束（纯白背景、禁止出现…）稀释画风导致各图风格漂移
  function buildStyleGuard() {
    const name = currentStyle.value?.label || artStyle.value || ''
    return name
      ? `。【画风统一约束】整幅画面风格统一为「${name}」画风，线条、上色、光影、质感与上述画面描述完全一致，禁止偏离画风。`
      : ''
  }

  // 画风 prompt（开头注入）：优先当前选中对象，其次查后端风格库，最后回落到风格名
  function stylePromptText() {
    return getStylePrompt()
  }

  // 【站位图专用 prompt】顶视图空间布局，参考区法，强调角色位置/朝向/距离关系
  function buildBlockingPrompt(shot) {
    const parts = []
    const push = (names, list, label) => {
      for (const name of (Array.isArray(names) ? names : [])) {
        const item = list.value.find(x => x.name === name)
        if (item?.description) parts.push(`${label}【${name}】：${item.description}`)
      }
    }
    push(shot.sceneAssets, assetScenes, '场景空间')
    push(shot.characters, characters, '角色')
    push(shot.propAssets, props, '道具')

    const assetBrief = parts.length ? `空间要素：【${parts.join('、')}】` : ''
    const charList = (shot.characters || []).join('、')
    const propList = (shot.propAssets || []).join('、')

    return `导演用站位图（Stage Layout），顶视图（Top-down view），9宫格坐标系（C1左上/C2中上/C3右上/C4左中/C5正中/C6右中/C7左下/C8中下/C9右下），简化平面示意图风格，黑白线稿+淡彩标注。

${assetBrief}

画面必须包含以下元素：
1. 9宫格网线，标注C1-C9区域编号
2. 角色：用彩色圆形人形图标表示，每个角色标注名字和朝向箭头，起始点用实心圆，结束点用箭头指向
3. 道具：用小图标表示，标注道具名称和位置
4. 视线方向：用虚线箭头表示角色之间的视线关系
5. 机位标注：用摄像机图标标注机位位置和拍摄方向
6. 交汇点：角色互动位置用红色双圈标注

本镜角色：${charList || '无'}
本镜道具：${propList || '无'}

镜头动作描述：${shot.description}

整幅图是导演用的站位图，清楚展示人物调度、空间关系、角色位置/朝向/距离，不是写实场景图，不要生成真实人物或场景照片。`
  }

  // ===== 分镜页：单镜头图片生成（支持并行）=====
  // imageType：'frame' 分镜图 / 'blocking' 站位图 / 'keyframe' 尾帧锚（由 final_frame 一键生图）
  async function generateShotImage(shotId, imageType = 'frame', provider) {
    // loading 队列按类型分流，互不干扰：
    //   frame    → generatingStoryboardIds（分镜图列遮罩）
    //   blocking → generatingBlockingIds（站位图列遮罩）
    //   keyframe → generatingKeyframeIds（尾帧锚独立遮罩，不与分镜图列抢同一把锁）
    const idList = imageType === 'blocking'
      ? generatingBlockingIds
      : imageType === 'keyframe'
        ? generatingKeyframeIds
        : generatingStoryboardIds
    if (idList.value.includes(shotId)) return // 防止重复点击

    const found = findShot(shotId)
    if (!found) {
      toastError('未找到镜头', { detail: String(shotId) })
      return
    }
    const targetShot = found.shot

    // 加入生成队列
    idList.value.push(shotId)

    try {
      // 站位图：按场生成（generateBlocking 内部自管 generatingBlockingIds，先释放避免自锁）
      if (imageType === 'blocking') {
        idList.value = idList.value.filter(x => x !== shotId)
        return await generateBlocking(targetShot.id)
      }

      // keyframe（尾帧锚）内容准绳 = 本镜 final_frame（本镜收尾的画面描述）。
      // 没有 final_frame 就退化为分镜提示词——但画面语义会变成"本镜开头"，与「尾帧」名不符，
      // 故此处直接拦下并提示，避免用户以为出了尾帧、实际拿到的却是首帧。
      if (imageType === 'keyframe' && !(targetShot.finalFrame || '').trim()) {
        idList.value = idList.value.filter(x => x !== shotId)
        toastWarn('无法生成尾帧锚：缺少「本镜最终画面」描述', {
          detail: '请先补全提示词，或手动填写本镜最终画面。',
        })
        return { success: false }
      }

      // 故事板/分镜图：优先用结构化多模态描述，没有时回落 description + 资产设定摘要
      const basePrompt = targetShot.integratedMultimodalDescription
        ? targetShot.integratedMultimodalDescription
        : `${targetShot.description}${buildAssetBrief(targetShot)}`
      const imagePrompt = `${stylePromptText()}，${basePrompt}${buildStyleGuard()}`
      console.log('[generateShotImage] prompt length:', imagePrompt.length, 'shotId:', shotId, 'imageType:', imageType)
      const params = { shotId: targetShot.id, prompt: imagePrompt, imageType, provider }
      // 分镜图（frame）/ 尾帧锚（keyframe）走同一条多图生图链：把镜头关联的角色/场景/道具图作为参考图传入
      // node22 = 参考图1（角色图），node30 = 参考图2（场景图）
      if (imageType === 'frame' || imageType === 'keyframe') {
        // 参考图：全部角色图 + 场景图 + 全部道具图。多角色由服务端拼成集合图占「角色」槽
        // （工作流只有 1 角色 + 1 场景两槽，只传第一只会让第二个角色被画成同一只）
        // 角色来源：characters 字段 + prompt 里 @提及的角色（覆盖 Airlock 继承但 characters 漏填的情况）
        const promptText = targetShot.integratedMultimodalDescription || targetShot.description || ''
        const mentionedNames = new Set([
          ...(targetShot.characters || []),
          ...(promptText.match(/@([^，。、；：！？\s]+)/g) || []).map(s => s.slice(1)),
        ])
        const shotChars = Array.from(mentionedNames)
          .map(n => characters.value.find(c => c.name === n))
          .filter(c => c && c.imageUrl)
        const shotScenes = (targetShot.sceneAssets || []).map(n => assetScenes.value.find(s => s.name === n)).filter(s => s && s.imageUrl)
        const shotProps = (targetShot.propAssets || []).map(n => props.value.find(p => p.name === n)).filter(p => p && p.imageUrl)
        params.charImages = shotChars.map(c => c.imageUrl)
        params.sceneImage = shotScenes[0]?.imageUrl || ''
        params.propImages = shotProps.map(p => p.imageUrl)
        if (!params.charImages.length && !params.sceneImage && !params.propImages.length) {
          toastWarn('关联资产都没有图片，分镜图将用默认参考图', {
            detail: '可能与内容不相干。建议先在资产库给关联的角色 / 场景 / 道具生成图片。',
          })
        }
      }
      const result = await api.generateImage(params)
      console.log('[generateShotImage] result:', result)
      if (result.warnings?.length) {
        const w = result.warnings
        toastWarn(w.length > 1 ? `生成完成，有 ${w.length} 项提示` : '生成完成，有 1 项提示', {
          detail: w.join('\n'),
        })
      }
      if (result.success && result.url) {
        if (imageType === 'keyframe') {
          // 尾帧锚独立字段：绝不覆盖 frameUrl/frameUrl2（那是本镜开头，两者都要在）
          targetShot.keyframeUrl = result.url
        } else {
          const urlField = `${imageType}Url`
          targetShot[urlField] = result.url
          // 分镜图一次出 2 张：urls[1] 存在则回填第二张（主图之外候选）
          // 长镜（≥阈值）时服务端按首帧/尾帧生成，记下标志供界面标注
          targetShot.frameUrl2 = result.urls?.[1] || ''
          targetShot.frameDualKeyframe = !!result.dualKeyframe
          targetShot.hasFrame = true
        }
        // 等待保存完成，避免刷新时还没落库
        console.log('[generateShotImage] persisted url:', result.url)
        // 从生成队列移除
        idList.value = idList.value.filter(x => x !== shotId)
        return { success: true, url: result.url }
      }
      throw new Error(result.error || '生成失败')
    } catch (e) {
      console.error('[generateShotImage] error:', e)
      toastError('生成失败', { detail: String(e.message) })
    }

    // 从生成队列移除
    idList.value = idList.value.filter(x => x !== shotId)
    return { success: false }
  }

  // ===== 短片页/分镜页：单镜打斗出片（打斗工作流 h3Combat）=====
  // 与 generateShotVideoV4 互斥：同一镜头同一时刻只跑一个工作流（共用 generatingVideoIds 锁）。
  // 打斗工作流差异：
  //   · 纯动作镜头：无对白、无音色，豆包 doubao-seed 看图自动生成电影级打斗提示词（含 BUNNY 触发词）
  //   · 单参考图（分镜图 image1），3 个战斗 LoRA + two-pass 两轮采样
  //   · 走 /generate/video-v3，idea 缺省由后端按 shot 字段自动组装（对阵/关键动作/景别/运镜）
  async function generateShotVideoCombat(shotId, overrides = {}) {
    if (!shotId) return { success: false, error: 'shotId 必填' }
    if (generatingVideoIds.value.includes(shotId)) return { success: false, error: '该镜正在出片' }

    const found = findShot(shotId)
    if (!found) {
      toastError('未找到镜头', { detail: String(shotId) })
      return { success: false }
    }
    const targetShot = found.shot
    const eng = getVideoEngine(videoModel.value)

    // 计费确认：打斗工作流带豆包 + 3 LoRA + 两轮采样，单条更贵
    const duration = Math.max(
      5,
      Math.min(15, Number(overrides.duration ?? targetShot.duration) || 6)
    )
    if (!overrides.skipConfirm) {
      const ok = await confirmDialog({
        title: '武戏出片 · 计费确认',
        description: '打斗工作流额外带豆包分镜 + 3 组 LoRA + 两轮采样，单条成本高于普通文戏。',
        details: [
          { label: '本镜', value: String(targetShot.shotNumber || targetShot.displayId || targetShot.id) },
          { label: '时长', value: `${duration}s` },
          { label: '引擎', value: eng.label },
          {
            label: '计费',
            value: eng.coinLow != null ? `约 ${eng.coinLow}~${eng.coinHigh} 币/条` : '按 RunningHub 计费',
            tone: 'warn',
          },
        ],
        confirmText: '开始生成',
        cancelText: '取消',
        tone: 'warn',
      })
      if (!ok) return { success: false, cancelled: true }
    }

    generatingVideoIds.value.push(shotId)
    try {
      const result = await api.generateVideoCombat({
        shotId: targetShot.id,
        idea: overrides.idea || '',
        bgImage: overrides.bgImage || '',
        aspectRatio: overrides.aspectRatio ?? aspectRatio.value,
        megapixels: overrides.megapixels,
        duration,
      })
      console.log('[generateShotVideoCombat] result:', result)
      if (result.success && result.url) {
        targetShot.videoUrl = result.url
        if (result.warning) toastWarn('生成完成，有 1 项提示', { detail: String(result.warning) })
        return { success: true, url: result.url }
      }
      throw new Error(result.error || '出片失败')
    } catch (e) {
      console.error('[generateShotVideoCombat] error:', e)
      toastError(`打斗出片失败（${eng.label}）`, { detail: String(e.message) })
    } finally {
      generatingVideoIds.value = generatingVideoIds.value.filter((x) => x !== shotId)
    }
    return { success: false }
  }

  // ===== 分镜页/短片页：单镜出片（全能生视频 V4 工作流 h3V4）=====
  // 9 参考图槽 + 3 音色槽，参考图由后端按镜头 characters/场景/道具全量解析（无需前端传 charImages）。
  // 提示词由后端组装 Ref2VA 结构化格式，文戏/武戏风格在后端分流。与其余引擎互斥（共用 generatingVideoIds 锁）。
  async function generateShotVideoV4(shotId, overrides = {}) {
    if (!shotId) return { success: false, error: 'shotId 必填' }
    if (generatingVideoIds.value.includes(shotId)) return { success: false, error: '该镜正在出片' }

    const found = findShot(shotId)
    if (!found) { toastError('未找到镜头', { detail: String(shotId) }); return { success: false } }
    const targetShot = found.shot

    // ===== 出片前闸门（2026-09-16 合并为一次确认）=====
    // 原来台词 / 构图锚 / 计费是三个连续的原生弹窗：点一次「生成成片」要连点三次确认，
    // 每弹一次都得重读一遍，用户很容易条件反射地点「确定」过去，反而什么都没看。
    // 现在合成一次：所有风险项集中列出，计费单独标色，一次看清「花多少 + 有什么隐患」。
    // 注意 allowSilent / allowNoFrame 必须在 skipConfirm 之外赋值——批量出片跳过确认时
    // 也要带上这两个放行标记，否则后端闸门会把批量任务全部拒掉。
    const dlgText = String(targetShot.dialogue || '').trim()
    const hasDlg = !!dlgText && dlgText !== 'null' && dlgText !== '[]'
    const hasFrameAnchor = !!(String(targetShot.frameUrl || '').trim() || String(targetShot.continuityUrl || '').trim())
    const allowSilent = !hasDlg
    const allowNoFrame = !hasFrameAnchor

    // 时长 clamp 3~15s（2026-09-13 放宽，与后端 v4Video 同口径）
    const duration = Math.max(3, Math.min(15, Number(overrides.duration ?? targetShot.duration) || 5))
    const eng = getVideoEngine('h3v4')

    if (!overrides.skipConfirm) {
      const details = [
        { label: '本镜', value: String(targetShot.shotNumber || targetShot.displayId || targetShot.id) },
        { label: '时长', value: `${duration}s` },
        { label: '引擎', value: eng.label },
      ]
      const risks = []
      if (!hasDlg) {
        details.push({ label: '台词', value: '空 —— 成片不会有角色语音', tone: 'warn' })
        risks.push('本镜没有台词，成片不会有角色语音')
      }
      if (!hasFrameAnchor) {
        details.push({ label: '构图锚', value: '无分镜图也无接力锚 —— 构图靠模型自由发挥', tone: 'warn' })
        risks.push('缺少构图锚，成片大概率与分镜对不上')
      }
      details.push({
        label: '计费',
        value: eng.coinLow != null ? `约 ${eng.coinLow}~${eng.coinHigh} 币/条` : '按 RunningHub 计费',
        tone: 'warn',
      })

      const ok = await confirmDialog({
        title: risks.length ? `出片确认 · 有 ${risks.length} 项需要注意` : '出片确认',
        description: risks.length
          ? `${risks.join('；')}。确认无误就继续，否则先回去补齐再出。`
          : '按当前镜头参数生成一段成片。',
        details,
        confirmText: '开始生成',
        cancelText: '先去补齐',
        tone: risks.length ? 'warn' : 'normal',
      })
      if (!ok) return { success: false, cancelled: true }
    }

    generatingVideoIds.value.push(shotId)
    try {
      const result = await api.generateVideoV4({
        shotId: targetShot.id,
        aspectRatio: overrides.aspectRatio ?? aspectRatio.value,
        megapixels: overrides.megapixels,
        duration,
        allowSilent,
        allowNoFrame,
      })
      console.log('[generateShotVideoV4] result:', result)
      if (result.success && result.url) {
        targetShot.videoUrl = result.url
        if (result.warning) toastWarn('生成完成，有 1 项提示', { detail: String(result.warning) })
        return { success: true, url: result.url }
      }
      throw new Error(result.error || '出片失败')
    } catch (e) {
      console.error('[generateShotVideoV4] error:', e)
      toastError('全能V4 出片失败', { detail: String(e.message) })
    } finally {
      generatingVideoIds.value = generatingVideoIds.value.filter((x) => x !== shotId)
    }
    return { success: false }
  }

  // ===== 出片统一入口：按全局 videoModel 分发到具体引擎 =====
  // videoModel 合法值见 src/data/videoEngines.js；新接入引擎（如其他视频 API）在这里加分支，
  // 分镜页 ShotRow / 短片页 VideoView 都走本入口，保证"选哪个引擎"全局一致。
  // 已在 UI 注册但未在本函数接线的引擎会显式报错（防止静默跑错引擎扣冤枉钱）
  const VIDEO_ENGINE_HANDLERS = {
    combat: (id, o) => generateShotVideoCombat(id, o),
    h3v4: (id, o) => generateShotVideoV4(id, o),
  }
  async function generateShotVideoByModel(shotId, overrides = {}) {
    const handler = VIDEO_ENGINE_HANDLERS[videoModel.value]
    if (!handler) {
      toastError(`出片引擎「${videoModel.value}」尚未在后端接线`, { detail: '请先在 store.generateShotVideoByModel 注册再使用' })
      return { success: false, error: `引擎 ${videoModel.value} 未接线` }
    }
    return handler(shotId, overrides)
  }

  // ===== 分镜页：单镜头 2x2 四宫格分镜图（每镜一张：4 格 = 同一镜头 4 个时间瞬间）=====
  async function generateShotGrid(shotId, provider) {
    if (!shotId) return { success: false, error: 'shotId 必填' }
    if (generatingShotGridIds.value.includes(shotId)) return { success: false, error: '该镜正在出四宫格' }
    generatingShotGridIds.value.push(shotId)
    const key = Number(shotId)
    shotGridStartedAt.value[key] = Date.now()
    delete shotGridFailed.value[key] // 重新出图前清掉上次的失败标记
    try {
      // provider 跟随全局 imageModel：runninghub / zikl / visionary-xxx，
      // 与 generateSceneGrid 同语义；后端按 provider 决定走 RunningHub 工作流还是 zikl/visionary
      // aspectRatio 走项目级（EpisodesView 顶部下拉）；visionary 图生图模式服务端会忽略 size（参考图决定构图），
      // 所以传下去不会让现有竖版三视图被裁成横版。
      const result = await api.generateShotGrid({ shotId, provider: provider || imageModel.value, aspectRatio: aspectRatio.value })
      console.log('[generateShotGrid] result:', result)
      if (result?.success) {
        delete shotGridFailed.value[key]
        // 刷新 shot 数据（让分镜图列拿到新 frame_url）
        if (currentEpisodeId.value) await loadEpisode(currentEpisodeId.value)
        return { success: true, gridImageUrl: result.gridImageUrl }
      }
      throw new Error(result?.error || '生成失败')
    } catch (e) {
      console.error('[generateShotGrid] error:', e)
      // 失败状态落到镜头卡片红标（不再只靠 alert 一闪而过）；服务端也留了同一份，刷新可恢复
      shotGridFailed.value[key] = e.message
      return { success: false, error: e.message }
    } finally {
      generatingShotGridIds.value = generatingShotGridIds.value.filter(x => x !== shotId)
      delete shotGridStartedAt.value[key]
    }
  }

  function clearShotGridFailed(shotId) {
    delete shotGridFailed.value[Number(shotId)]
  }

  // ===== 分镜页：按场出 2x2 四宫格分镜图（一次出 4 镜，自动切分写回 frame_url）=====
  // provider 跟随全局 imageModel；sceneId 必传（从 shot.storyboard_scene_id 拿）
  async function generateSceneGrid(sceneId, provider) {
    if (!sceneId) return { success: false, error: 'sceneId 必填' }
    // 全局并发锁：同一场同时只允许一个任务（切分+写库期间避免重复触发）
    if (generatingSceneGridIds.value.includes(sceneId)) return { success: false, error: '该场正在出四宫格' }
    generatingSceneGridIds.value.push(sceneId)
    try {
      const result = await api.generateSceneGrid({ sceneId, provider: provider || imageModel.value })
      console.log('[generateSceneGrid] result:', result)
      if (result?.success) {
        // 刷新 shot 数据（让分镜图列拿到新 frame_url）
        if (currentEpisodeId.value) await loadEpisode(currentEpisodeId.value)
        return { success: true, gridImageUrl: result.gridImageUrl, shotUpdates: result.shotUpdates }
      }
      throw new Error(result?.error || '生成失败')
    } catch (e) {
      console.error('[generateSceneGrid] error:', e)
      toastError('出四宫格失败', { detail: String(e.message) })
      return { success: false, error: e.message }
    } finally {
      generatingSceneGridIds.value = generatingSceneGridIds.value.filter(x => x !== sceneId)
    }
  }

  // ===== 分镜页：生成程序化站位图（按场一次调用：布局全场共享、镜头链式衔接）=====
  async function generateBlocking(shotId) {
    if (generatingBlockingIds.value.includes(shotId)) return
    const found = findShot(shotId)
    if (!found) {
      toastError('未找到镜头', { detail: String(shotId) })
      return { success: false }
    }
    generatingBlockingIds.value.push(shotId)

    try {
      // 后端按 shotId 定位所在场次整场重排，返回该场全部镜头的最新站位图
      const result = await api.generateBlocking({ shotId: found.shot.id })
      if (result.success && Array.isArray(result.updated)) {
        for (const item of result.updated) {
          const f = findShot(item.shotId)
          if (f) {
            f.shot.blockingPlan = item.plan
            f.shot.hasBlocking = true
          }
        }
        return { success: true, updated: result.updated }
      }
      throw new Error(result.error || '站位图生成失败')
    } catch (e) {
      console.error('[generateBlocking] error:', e)
      toastError('站位图生成失败', { detail: String(e.message) })
    } finally {
      generatingBlockingIds.value = generatingBlockingIds.value.filter((x) => x !== shotId)
    }
    return { success: false }
  }

  // ===== 设定页：生成资产图片（角色/场景/道具）=====
  // ===== 资产生图任务持久化（治本：刷新后恢复"生成中"状态并自动接住结果） =====
  // 生图是前端挂起数分钟的长请求，纯内存状态刷新即丢；而后端会继续生图并落库。
  // 因此把进行中的任务写进 localStorage，刷新后恢复队列 + 轮询库内 imageUrl，
  // 后端落库完成（URL 变化）即自动清除状态并显示新图。
  const ASSET_GEN_KEY = STORAGE_KEYS.PENDING_ASSET_GENS
  const ASSET_GEN_TIMEOUT = TIMEOUTS.ASSET_GEN_MS
  function readPendingGens() {
    try { return JSON.parse(localStorage.getItem(ASSET_GEN_KEY) || '[]') } catch { return [] }
  }
  function writePendingGens(list) {
    try { localStorage.setItem(ASSET_GEN_KEY, JSON.stringify(list)) } catch { /* 存储满等异常忽略 */ }
  }
  function removePendingGen(id) {
    writePendingGens(readPendingGens().filter(t => String(t.id) !== String(id)))
  }
  let assetGenPollTimer = null
  function startAssetGenPoller() {
    if (assetGenPollTimer) return
    assetGenPollTimer = setInterval(async () => {
      const pending = readPendingGens()
      // 只处理当前集的任务（其他集的等切回去再处理）
      const mine = pending.filter(t => String(t.episodeId) === String(currentEpisodeId.value || ''))
      if (!mine.length) {
        // 当前集没有待恢复任务：清掉已超时的其他集任务
        const now = Date.now()
        const rest = pending.filter(t => now - t.startedAt <= ASSET_GEN_TIMEOUT)
        if (rest.length !== pending.length) writePendingGens(rest)
        clearInterval(assetGenPollTimer)
        assetGenPollTimer = null
        return
      }
      try { await loadEpisode(currentEpisodeId.value) } catch { /* 网络抖动下轮再试 */ }
      const now = Date.now()
      const doneIds = []
      const rest = []
      for (const t of pending) {
        if (String(t.episodeId) !== String(currentEpisodeId.value || '')) { rest.push(t); continue }
        if (now - t.startedAt > ASSET_GEN_TIMEOUT) { doneIds.push(t.id); continue } // 超时放弃
        const list = t.type === 'character' ? characters.value : t.type === 'scene' ? assetScenes.value : props.value
        const cur = list.find(x => String(x.id) === String(t.id))
        if (!cur) { doneIds.push(t.id); continue } // 资产已不存在
        if ((cur.imageUrl || '') !== (t.prevUrl || '')) doneIds.push(t.id) // 库内图片已更新 = 后端已落库完成
        else rest.push(t)
      }
      writePendingGens(rest)
      if (doneIds.length) {
        generatingAssetIds.value = generatingAssetIds.value.filter(x => !doneIds.includes(String(x)) && !doneIds.includes(x))
      }
      if (!rest.length) { clearInterval(assetGenPollTimer); assetGenPollTimer = null }
    }, 5000)
  }
  // 刷新/重进页面时恢复资产「生成中」状态。
  // 关键：localStorage 里的 pending 可能因「请求被中断」（服务重启切断连接 / 关页面）而残留，
  // 后端其实早就没在跑了 → 会显示假的「AI生成中」。因此这里先向后端 /image/inflight 的
  // assets 数组（/asset-image 的内存登记）做交集，**只恢复后端确实在跑的任务**；
  // 本地有、后端没有的 = 僵尸 → 直接清理，不显示 loading。
  // 后端查询失败（网络问题）时**保守处理**：不清理，维持现状，交给现有 15 分钟超时兜底，避免误清正在跑的任务。
  async function resumePendingAssetGens() {
    if (!currentEpisodeId.value) return
    const pending = readPendingGens()
    if (!pending.length) return

    // 向后端确认：本集哪些资产任务确实在后端运行。null = 未知（查询失败）→ 保守不清理
    let runningAssetIds = null
    try {
      const data = await api.getImageJobsInflight()
      runningAssetIds = new Set(
        (Array.isArray(data?.assets) ? data.assets : []).map(a => String(a.assetId))
      )
    } catch (e) {
      console.warn('[resumePendingAssetGens] 查询后端 in-flight 资产任务失败，保守保留 pending：', e.message)
    }

    // 对账：本地有、后端没有 = 僵尸（请求被中断后残留）→ 清理，不显示 loading；
    // 后端在跑 = 恢复 loading；查询失败 = 保守保留（交给 15 分钟超时兜底）。
    const { zombies, toRestore, kept } = reconcilePendingAssetGens({
      pending,
      episodeId: currentEpisodeId.value,
      runningAssetIds,
    })
    if (zombies.length) {
      writePendingGens(kept)
      console.log(`[resumePendingAssetGens] 清理僵尸 pending：${zombies.join(',')}`)
    }

    let changed = false
    for (const id of toRestore) {
      if (!generatingAssetIds.value.includes(id)) {
        generatingAssetIds.value.push(id)
        changed = true
      }
    }
    if (changed || generatingAssetIds.value.length) startAssetGenPoller()
  }

  // 图文一致性哨兵 · 一键重出（2026-09-16）：重新提取后「描述变了但沿用旧图」的资产，
  // 逐个走 generateAssetImage 按新描述重出。覆盖式操作，先 confirmDialog 确认（计费+可能覆盖精修图）。
  // 注（2026-09-17 弹窗退役）：生成前置门禁已随 SpatialAnchorReviewDialog 整体退役。
  // 原门禁拦截的「pending 组先出图会抢注 auto 邻场锚」问题，改由组视图双层兜底：
  //   ① 组卡锁定态——pending 组成员在设定页不可单点出图（SpatialGroupCard:locked）；
  //   ② 批量跳过——批量生成自动排除 pending 组成员并汇总提示（SettingsView.handleBatchGenerateScenes）。
  // 确认/跳过动作全部收口到组卡本身（confirm / skip / regen-baseline），不再有全局强阻塞弹窗。

  // 按 name 找回当前列表里的资产（mapped 里的是提取瞬间的临时 id，落库后已被 loadEpisode 刷新）。
  async function regenerateStaleAssets(staleAssets) {
    const targets = []
    for (const s of (staleAssets || [])) {
      const list = s.type === 'character' ? characters.value : s.type === 'scene' ? assetScenes.value : props.value
      const cur = list.find(x => x.name === s.name)
      if (cur) targets.push({ type: s.type, item: cur })
    }
    if (!targets.length) {
      toastWarn('这些资产已不存在，无法重新生成')
      return
    }
    const ok = await confirmDialog({
      title: `按新描述重出 ${targets.length} 张资产图？`,
      description: '会用最新描述重新生成并覆盖现有图片（计费）。若现有图是手动精修过的，建议先去设定页逐张「改造」而不是整体重出。',
      confirmText: `重出 ${targets.length} 张图`,
      tone: 'warn',
    })
    if (!ok) return
    for (const t of targets) {
      generateAssetImage(t.type, t.item.id, `${t.item.name}：${t.item.description || ''}`, imageModel.value)
    }
    toastInfo(`已开始重出 ${targets.length} 张图`, { detail: '生成完成后资产卡片自动更新；期间可继续做别的操作。' })
  }

  async function generateAssetImage(type, id, description, provider, editInstruction = '') {
    // 人环去重：同资产已有调用在途时直接忽略（防重复点击）。
    // 注：2026-09-17 前此处还有「生成前置人审门禁」段，已随弹窗整体退役——
    // pending 组的拦截改由组视图锁定态 + 批量跳过兜底，见上方「弹窗退役」注。
    if (generatingAssetIds.value.includes(id)) return // 防止重复点击
    if (!currentStyle.value?.prompt) {
      toastWarn('请先选择画风')
      return
    }

    // 加入生成队列（支持并行）
    generatingAssetIds.value.push(id)
    // 登记 AbortController：支持用户在卡片上点"取消"中断本次生成
    const abortCtrl = new AbortController()
    assetGenControllers.set(String(id), abortCtrl)
    // 登记持久化任务（快照生成前的图 URL，用于刷新后判断后端是否已落库完成）
    const __list0 = type === 'character' ? characters.value : type === 'scene' ? assetScenes.value : props.value
    const __cur0 = __list0.find(x => String(x.id) === String(id))
    writePendingGens([
      ...readPendingGens().filter(t => String(t.id) !== String(id)),
      { type, id, episodeId: currentEpisodeId.value || '', prevUrl: __cur0?.imageUrl || '', startedAt: Date.now() },
    ])
    startAssetGenPoller()

    try {
      // 图生图改造模式：带指令时以现有设定图为底图（形象强锚），换装/加饰品不漂移
      let refImageUrl = ''
      if (editInstruction) {
        const list = type === 'character' ? characters.value : type === 'scene' ? assetScenes.value : props.value
        const cur = list.find(x => String(x.id) === String(id))
        refImageUrl = cur?.imageUrl || ''
        if (!refImageUrl) {
          toastWarn('该资产还没有图片，无法改造', { detail: '请先用「AI生成」出一张基础形象图' })
          assetGenControllers.delete(String(id)) // 同步注销在途登记，避免 Map 残留
          removePendingGen(id)
          generatingAssetIds.value = generatingAssetIds.value.filter(x => x !== id)
          return { success: false }
        }
      }

      // 资产图 prompt 统一走 promptBuilder.buildAssetImagePrompt：
      // 场景/道具自动剥离画风里的角色指令词 + 追加无角色描述，角色图保持完整画风
      let imagePrompt
      if (type === 'scene') {
        // 场景图做减法：关联道具不在场景中生成（由道具资产图统一代表）
        const scene = assetScenes.value.find(s => s.id === id)
        const sceneName = scene?.name || ''
        const excludeProps = (scene?.propNames || []).filter(Boolean)
        imagePrompt = buildAssetImagePrompt('scene', {
          description, name: sceneName, stylePrompt: stylePromptText(),
          styleLabel: currentStyle.value?.label || artStyle.value || '',
          excludeProps,
          // 2026-09-16 P2-b：把场景的英文光照常量注入资产图 prompt（与出片链同源，消除"图一套光、片一套光"）
          lightingEn: scene?.lightingEn || '',
          // 2026-09-17 视角塌陷修复：注入本场机位声明（scene_analysis.spatial_role）——
          // 同空间组多视角唯一能区分彼此的信息，缺失则全部塌陷成基准图机位。
          spatialRole: scene?.spatialRole || '',
          // 2026-09-17 A1/A2：本场要素清单 + 组级环境卡，以 1.35 权重硬约束进画面。
          // 空数组 → 两段 note 均为空串，prompt 逐字不变（老数据/无分析场景行为完全一致）。
          elements: scene?.elements || [],
          sharedEnv: scene?.sharedEnv || [],
        })
      } else {
        let itemName = ''
        if (type === 'character') {
          const c = characters.value.find(c => c.id === id)
          itemName = c?.name || ''
        } else if (type === 'prop') {
          const p = props.value.find(p => p.id === id)
          itemName = p?.name || ''
        }
        imagePrompt = buildAssetImagePrompt(type, {
          description, name: itemName, stylePrompt: stylePromptText(),
          styleLabel: currentStyle.value?.label || artStyle.value || '',
        })
      }
      const result = await api.generateAssetImage({
        type, id, prompt: imagePrompt, provider,
        ...(editInstruction ? { refImageUrl, editInstruction } : {}),
      }, { signal: abortCtrl.signal })
      console.log('[generateAssetImage] result:', result, 'type:', type, 'id:', id)
      if (result.success && result.url) {
        // 更新 store 的图片URL（后端在改造时已同步主设定描述，随响应带回，直接采用防重复拼接）
        let updated = false
        if (type === 'character') {
          const c = characters.value.find(c => String(c.id) === String(id))
          console.log('[generateAssetImage] find character id=', id, 'found=', !!c, 'ids=', characters.value.map(x => x.id))
          if (c) { c.imageUrl = result.url; if (result.description) c.description = result.description; updated = true; characters.value = [...characters.value] }
        } else if (type === 'scene') {
          const s = assetScenes.value.find(s => String(s.id) === String(id))
          console.log('[generateAssetImage] find scene id=', id, 'found=', !!s)
          if (s) { s.imageUrl = result.url; if (result.description) s.description = result.description; updated = true; assetScenes.value = [...assetScenes.value] }
        } else if (type === 'prop') {
          const p = props.value.find(p => String(p.id) === String(id))
          console.log('[generateAssetImage] find prop id=', id, 'found=', !!p)
          if (p) { p.imageUrl = result.url; if (result.description) p.description = result.description; updated = true; props.value = [...props.value] }
        }
        console.log('[generateAssetImage] updated:', updated)
        // 以库为准重新同步内存：确保落库的本地 URL 已加载，杜绝"乐观显示远程 URL→刷新消失"
        try { await loadEpisode(currentEpisodeId.value) }
        catch (e) { console.warn('[generateAssetImage] reload 失败，沿用内存值', e.message) }
        // 从生成队列移除（同步清持久化任务）
        assetGenControllers.delete(String(id))
        removePendingGen(id)
        generatingAssetIds.value = generatingAssetIds.value.filter(x => x !== id)
        return { success: true, url: result.url, description: result.description || '' }
      }
      throw new Error(result.error || '生成失败')
    } catch (e) {
      // 用户主动取消：不打错误提示，静默清理即可
      const cancelled = e?.isUserCancel || assetGenControllers.get(String(id))?.signal.aborted
      if (!cancelled) toastError('生成失败', { detail: String(e.message) })
      assetGenControllers.delete(String(id))
      removePendingGen(id)
      if (cancelled) {
        // 取消路径必须同样出队：否则卡片的「AI生成中…」遮罩与取消按钮不会消失
        // （遮罩显隐由 generatingAssetIds 决定），用户得再点一次才解开。
        generatingAssetIds.value = generatingAssetIds.value.filter(x => x !== id)
        return { success: false, cancelled: true }
      }
    }

    // 从生成队列移除
    generatingAssetIds.value = generatingAssetIds.value.filter(x => x !== id)
    return { success: false }
  }

  // 用户主动取消资产图生成：abort 在途请求 + 清理任务登记与队列。
  // 说明：后端可能已经在出图，取消只保证前端不再等待/不落库到卡片，
  // 是否产生计费以后端/服务商为准。
  function cancelAssetImageGen(id) {
    const key = String(id)
    const ctrl = assetGenControllers.get(key)
    if (ctrl) {
      ctrl.abort() // generateAssetImage 的 catch 会完成清理
      return
    }
    // 兜底：没有在途请求（如轮询阶段残留）也直接清
    removePendingGen(key)
    generatingAssetIds.value = generatingAssetIds.value.filter(x => String(x) !== key)
  }

  async function batchGenerateImages(imageType = 'frame', provider) {
    const allShots = storyboardScenes.value.flatMap((s) => s.shots)
    if (allShots.length === 0) {
      toastWarn('暂无镜头，请先提取分镜脚本')
      return
    }

    const isBlocking = imageType === 'blocking'
    const batchFlag = isBlocking ? batchBlockingGenerating : batchStoryboardGenerating
    const idList = isBlocking ? generatingBlockingIds : generatingStoryboardIds
    if (batchFlag.value) return

    // 并发与重试集中在 constants/app.js 的 BATCH_GEN（调吞吐只改那里）。
    // ai_calls 实测生图平均 78~98s/张且失败率高（限流/抖动占相当比例）：
    // 提并发拉吞吐，分镜图单次重试对冲抖动失败；站位图整场调用成本高，维持不重试。
    const CONCURRENCY = BATCH_GEN.IMAGE_CONCURRENCY
    const FRAME_MAX_ATTEMPTS = 1 + BATCH_GEN.FRAME_RETRY
    let successCount = 0
    let failCount = 0
    let currentIndex = 0
    // 站位图按场批量（每场一次调用：布局全场共享、镜头链式衔接）；故事板/分镜图仍逐镜
    const sceneTasks = isBlocking
      ? storyboardScenes.value.map((s) => ({ sceneId: s.id, title: s.title, shots: s.shots }))
      : null
    const total = isBlocking ? sceneTasks.length : allShots.length
    const typeLabel = imageType === 'frame' ? '分镜图' : '站位图'

    batchFlag.value = true
    idList.value = allShots.map((s) => s.id)

    async function worker() {
      while (currentIndex < total) {
        const i = currentIndex++

        // 站位图：整场一次调用，返回该场全部镜头的最新站位图（3 路并发按场跑）
        if (isBlocking) {
          const scene = sceneTasks[i]
          try {
            const result = await api.generateBlocking({ sceneId: scene.sceneId })
            if (result.success && Array.isArray(result.updated)) {
              for (const item of result.updated) {
                const f = findShot(item.shotId)
                if (f) {
                  f.shot.blockingPlan = item.plan
                  f.shot.hasBlocking = true
                }
              }
              successCount += result.updated.length
            } else {
              failCount += scene.shots.length
              console.warn('[batchGenerateImages] blocking failed for scene', scene.title, result)
            }
          } catch (e) {
            failCount += scene.shots.length
            console.warn('[batchGenerateImages] blocking exception for scene', scene.title, e)
          }
          continue
        }

        const shot = allShots[i]
        try {
          // 故事板/分镜图用资产描述+画风约束
          const batchImagePrompt = (() => {
            const basePrompt = shot.integratedMultimodalDescription
              ? shot.integratedMultimodalDescription
              : `${shot.description}${buildAssetBrief(shot)}`
            return `${stylePromptText()}，${basePrompt}${buildStyleGuard()}`
          })()
          const params = { shotId: shot.id, prompt: batchImagePrompt, imageType, provider }
          // 批量分镜图同样给「故事板」app 传关联资产参考图
          if (imageType === 'frame') {
            // 与单镜生成同构：全部角色图 + 场景图 + 全部道具图，多角色由服务端拼集合图占角色槽
            // 角色来源：characters 字段 + prompt 里 @提及的角色（覆盖 Airlock 继承但 characters 漏填的情况）
            const promptText = shot.integratedMultimodalDescription || shot.description || ''
            const mentionedNames = new Set([
              ...(shot.characters || []),
              ...(promptText.match(/@([^，。、；：！？\s]+)/g) || []).map(s => s.slice(1)),
            ])
            const shotChars = Array.from(mentionedNames)
              .map(n => characters.value.find(c => c.name === n))
              .filter(c => c && c.imageUrl)
            const shotScenes = (shot.sceneAssets || []).map(n => assetScenes.value.find(s => s.name === n)).filter(s => s && s.imageUrl)
            const shotProps = (shot.propAssets || []).map(n => props.value.find(p => p.name === n)).filter(p => p && p.imageUrl)
            params.charImages = shotChars.map(c => c.imageUrl)
            params.sceneImage = shotScenes[0]?.imageUrl || ''
            params.propImages = shotProps.map(p => p.imageUrl)
          }
          // 分镜图失败自动重试 1 次（间隔 3s 错峰，对冲限流/抖动）；站位图整场成本高维持单次
          const maxAttempts = imageType === 'frame' ? FRAME_MAX_ATTEMPTS : 1
          let result = null
          for (let attempt = 0; attempt < maxAttempts; attempt++) {
            if (attempt > 0) {
              console.warn('[batchGenerateImages] shot', shot.id, '失败，3s 后自动重试一次')
              await new Promise((r) => setTimeout(r, 3000))
            }
            result = await api.generateImage(params)
            if (result?.success && result?.url) break
          }
          if (result?.success && result?.url) {
            shot[`${imageType}Url`] = result.url
            if (imageType === 'frame') {
              shot.frameUrl2 = result.urls?.[1] || ''
              shot.frameDualKeyframe = !!result.dualKeyframe
            }
            if (imageType === 'frame') shot.hasFrame = true
            successCount++
          } else {
            failCount++
            console.warn('[batchGenerateImages] image failed for shot', shot.id, result)
          }
        } catch (e) {
          console.warn('[batchGenerateImages] exception for shot', shot.id, e)
          failCount++
        }
      }
    }

    // 按 CONCURRENCY 起 worker
    const workers = Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker())
    await Promise.all(workers)

    idList.value = []
    batchFlag.value = false
    const batchMsg = `批量生成${typeLabel}完成：成功 ${successCount} 个，失败 ${failCount} 个`
    if (failCount > 0) toastWarn(batchMsg, { detail: '可对失败的项单独重试' })
    else toastSuccess(batchMsg)
    return { success: true, successCount, failCount }
  }

  // ===== 资产图批量生成（设定页「场景 / 道具」批量入口，2026-09-16）=====
  // 与 batchGenerateImages（分镜图/站位图）**完全独立**，不动其既有行为。
  // 复用单张 generateAssetImage 的完整链路（prompt 构建、图生图底图、pending 持久化、
  // 刷新后轮询恢复），不另写一套生图请求逻辑——保证「单张点生成」与「批量生成」产出一致。
  //
  // @param {'character'|'scene'|'prop'} type
  // @param {Object}   [options]
  // @param {boolean}  [options.onlyMissing=true]  true=只补「尚无图」的资产（默认，不覆盖已精修/上传的图）；
  //                                               false=全部重新生成（覆盖式，调用方需自行二次确认）
  // @param {number}   [options.concurrency=3]    受控并发数（避免一次性打满限流）
  // @param {string}   [options.provider]         生图模型，缺省取全局 imageModel
  // @param {Function} [options.onProgress]       (done, total) => void，批量进度回调
  // @returns {{ success:boolean, successCount:number, failCount:number, failedIds:Array, total:number, skipped:number }}
  async function batchGenerateAssetImages(type, options = {}) {
    const {
      onlyMissing = true,
      concurrency = 3,
      provider,
      onProgress,
      // 目标子集（2026-09-17 场景组视图「整组照参考图重画」用）：
      // 传入时只处理这些 id（仍叠加 onlyMissing / 生成中去重）；缺省 = 全部资产。
      ids = null,
    } = options

    const list = type === 'character' ? characters.value : type === 'scene' ? assetScenes.value : props.value
    const all = Array.isArray(list) ? list.slice() : []
    const idSet = Array.isArray(ids) && ids.length ? new Set(ids.map(String)) : null

    const emptyResult = { success: false, successCount: 0, failCount: 0, failedIds: [], total: 0, skipped: 0 }
    if (!all.length) {
      toastWarn('暂无可生成的资产')
      return emptyResult
    }
    if (!currentStyle.value?.prompt) {
      toastWarn('请先选择画风')
      return emptyResult
    }

    // 目标集合：默认只补缺；再排除「已在生成中」的（避免与手动/待恢复任务重复提交）
    const inScope = all.filter((it) => (onlyMissing ? !it.imageUrl : true) && (!idSet || idSet.has(String(it.id))))
    const targets = inScope.filter((it) => !generatingAssetIds.value.includes(it.id))
    const skipped = inScope.length - targets.length

    if (!targets.length) {
      if (skipped > 0) toastInfo('待生成的资产都已在生成中')
      else toastInfo(onlyMissing ? '所有资产都已有图片，无需补生成' : '暂无可生成的资产')
      return { success: true, successCount: 0, failCount: 0, failedIds: [], total: 0, skipped }
    }

    const total = targets.length
    const model = provider || imageModel.value
    let successCount = 0
    let failCount = 0
    const failedIds = []
    let done = 0

    // ===== 场景图：按空间组重排（2026-09-18）=====
    // 同一 spatial_group 的场景是同一物理空间的不同视角，后画的必须以先画的定稿图为空间锚；
    // 后端已经加了串行锁兜底，但前端若不排序，同组请求会挤在锁上排队——既浪费连接、
    // 又让「谁当锚」变成抢跑决定。这里主动切成「链」：链内严格串行、链间仍按 concurrency 并发，
    // 组内按 scene_number 升序（场次靠前的先定稿，当后面几场的锚）。
    // 拿不到分组信息时降级为一条全量链（= 全串行），绝不退回原来的无序并发。
    // 非 scene 类型：每张图各成一条链 —— worker 池照旧按 concurrency 并发，行为与改造前完全一致。
    let chains = targets.map((t) => [t])
    if (type === 'scene') {
      let groupInfo = null
      try {
        const g = await api.getSceneSpatialGroups(currentEpisodeId.value)
        if (g && g.groups && Object.keys(g.groups).length) groupInfo = g.groups
      } catch (e) {
        console.warn('[batchGenerateAssetImages] 空间分组获取失败，场景图退化为全串行:', e.message)
      }
      chains = buildSceneGroupChains(targets, groupInfo)
      if (!groupInfo) {
        console.log('[batchGenerateAssetImages] 场景图无空间分组信息 → 全串行（保证锚点生效）')
      }
    }

    // 单条链：按序串行执行（前一张落库后才发下一张）
    async function runChain(chain) {
      for (const task of chain) {
        try {
          // 描述口径与卡片「AI生成」按钮同源（name：description）
          const res = await generateAssetImage(type, task.id, `${task.name}：${task.description || ''}`, model)
          if (res && res.success) successCount++
          else { failCount++; failedIds.push(task.id) }
        } catch (e) {
          console.warn('[batchGenerateAssetImages] failed for', task.id, e)
          failCount++
          failedIds.push(task.id)
        } finally {
          done++
          if (typeof onProgress === 'function') {
            try { onProgress(done, total) } catch { /* 进度回调异常不影响批量 */ }
          }
        }
      }
    }

    // worker 池：受控并发，逐条串行取「链」，链内再串行——
    // 效果 = 组内串行、组间并发，不牺牲不同空间组之间的吞吐
    let currentIndex = 0
    async function worker() {
      while (currentIndex < chains.length) {
        const chain = chains[currentIndex++]
        await runChain(chain)
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, chains.length) }, () => worker())
    await Promise.all(workers)

    return { success: failCount === 0, successCount, failCount, failedIds, total, skipped }
  }

  // ===== 分镜图双候选：把第 idx 张（1 或 2）设为主图 =====
  // 主图 frame_url 参与下游（视频参考图等），第二张 frame_url2 仅作候选展示
  async function setPrimaryFrame(shotId, idx = 1) {
    const found = findShot(shotId)
    if (!found) return { success: false }
    const shot = found.shot
    const a = shot.frameUrl || ''
    const b = shot.frameUrl2 || ''
    if (idx === 2 && !b) return { success: false }
    const [main, second] = idx === 2 ? [b, a] : [a, b]
    if (!main) return { success: false }
    shot.frameUrl = main
    shot.frameUrl2 = second
    try {
      // 后端 COALESCE 语义：undefined 保留旧值，传空串也不清空——这里两张都有值，直接交换
      await api.updateShot(currentEpisodeId.value, shotId, { frame_url: main, frame_url2: second })
      return { success: true }
    } catch (e) {
      console.error('[setPrimaryFrame] save failed:', e)
      return { success: false, error: e.message }
    }
  }

  // ===== 分镜质检（2026-09-16）=====
  // 拉取质检报告。silent=true 用于「修完顺手刷新」等后台刷新场景，不显示整页 loading。
  async function loadQcReport({ silent = false, includeIgnored } = {}) {
    if (!currentEpisodeId.value) return null
    if (!silent) qcLoading.value = true
    try {
      const inc = includeIgnored !== undefined ? includeIgnored : qcShowIgnored.value
      const res = await api.getQcReport(currentEpisodeId.value, inc)
      qcReport.value = res
      return res
    } catch (e) {
      console.error('[loadQcReport] failed:', e)
      if (!silent) qcLastResult.value = '质检报告获取失败：' + (e.message || '未知错误')
      return null
    } finally {
      if (!silent) qcLoading.value = false
    }
  }

  // 切换「显示已忽略」时立即重拉（忽略项由后端过滤，不在前端做二次过滤，
  // 避免两侧口径漂移——这是本面板的设计前提）
  async function toggleQcShowIgnored() {
    qcShowIgnored.value = !qcShowIgnored.value
    return loadQcReport({ silent: true, includeIgnored: qcShowIgnored.value })
  }

  // 按 code 批量修复。shots 省略 = 修该 code 下全部镜头。
  // 修复动作由后端按 QC_ACTION 分流（补 Airlock 衔接 / 补走位动作 / 重抽分镜图 / 仅人工）。
  // 返回体字段（见 server/routes/qc.js）：{ requested, processed, truncated, fixed, failed, details, message }
  async function qcFix(code, shots) {
    if (!currentEpisodeId.value || !code) return { success: false }
    if (qcFixing.value.includes(code)) return { success: false }
    qcFixing.value = [...qcFixing.value, code]
    qcLastResult.value = ''
    try {
      const res = await api.qcFix({ episodeId: currentEpisodeId.value, code, shots })
      const parts = []
      if (res.fixed) parts.push(`修好 ${res.fixed} 处`)
      if (res.failed) parts.push(`${res.failed} 处未成功`)
      // 截断提示：单批上限由后端给（config.storyboard.qcFixBatchLimit），前端只如实转述
      if (res.truncated) {
        parts.push(`本次只处理前 ${res.processed} 处，还剩 ${res.requested - res.processed} 处需再点一次`)
      }
      qcLastResult.value = parts.length
        ? `${code}：${parts.join('，')}`
        : (res.message || `${code}：处理完成`)
      // 修复会改镜头内容 → 重新加载分镜（否则界面还是旧提示词）+ 重拉报告
      if (res.fixed) {
        await loadEpisode(currentEpisodeId.value)
      }
      await loadQcReport({ silent: true })
      return res
    } catch (e) {
      console.error('[qcFix] failed:', e)
      // 后端对 manual 类/未登记 code 会返回 400 + 可读原因，直接透出（比"修复失败"有用得多）
      qcLastResult.value = e.message || '修复失败'
      return { success: false, error: e.message }
    } finally {
      qcFixing.value = qcFixing.value.filter((c) => c !== code)
    }
  }

  // 人工确认忽略：把某 code 在某镜上的问题标为「已知且接受」，不再出现在报告里（可撤销）
  async function qcIgnore(code, shotNumber) {
    if (!currentEpisodeId.value || !code) return { success: false }
    try {
      await api.qcIgnore({ episodeId: currentEpisodeId.value, code, shotNumber })
      await loadQcReport({ silent: true })
      return { success: true }
    } catch (e) {
      console.error('[qcIgnore] failed:', e)
      qcLastResult.value = `忽略失败：${e.message || '未知错误'}`
      return { success: false, error: e.message }
    }
  }

  // 撤销忽略
  async function qcUnignore(id) {
    if (!currentEpisodeId.value || id == null) return { success: false }
    try {
      await api.qcUnignore({ episodeId: currentEpisodeId.value, id })
      // 撤销后该项要重新出现，故强制带忽略项重拉，否则用户看不到"它回来了"
      await loadQcReport({ silent: true, includeIgnored: true })
      return { success: true }
    } catch (e) {
      console.error('[qcUnignore] failed:', e)
      return { success: false, error: e.message }
    }
  }

  // 某镜命中的质检码（镜头行角标用）。shotIndex 形如 { '1-1': ['CODE_A', 'CODE_B'] }
  function qcCodesForShot(shotNumber) {
    const idx = qcReport.value?.shotIndex || {}
    return idx[String(shotNumber || '')] || []
  }

  // 某镜是否命中「必须修」级别的问题（错误 vs 建议由 QC_LEVEL 决定，前端不自己判断）
  function qcHasErrorForShot(shotNumber) {
    const codes = qcCodesForShot(shotNumber)
    const groups = qcReport.value?.groups || []
    return codes.some((c) => groups.find((g) => g.code === c)?.level === 'error')
  }

  // ===== 一键全流程生成 =====
  async function generateFull(prompt, options = {}) {
    if (!currentEpisodeId.value) {
      toastWarn('请先初始化项目')
      return
    }
    if (fullGenRunning.value) return

    fullGenRunning.value = true
    fullGenProgress.value = 0
    fullGenMessage.value = '提交任务中...'

    try {
      // 一键流程：提交前先从资产库定位出场角色（高置信自动应用形象设定，
      // 后端编剧与分镜直接沿用资产库的参考图和音色；定位失败不影响提交）
      let characterIds = null
      try {
        const route = await api.ipRoute({ prompt, projectId: currentProjectId.value })
        if (route.confidence === 'high' && route.characters?.length) {
          characterIds = route.characters.map((c) => c.id)
        }
      } catch { /* 路由失败按裸主题生成 */ }

      const result = await api.generateFull({
        episodeId: currentEpisodeId.value,
        prompt,
        options: { ...options, characterIds },
      })
      const taskId = result.taskId

      // 查询任务进度（带上限：最多 30 分钟；网络错误连续 10 次则中止，防止任务丢失后无限轮询）
      const maxPolls = 900 // 2s x 900 = 30 分钟
      let pollCount = 0
      let errorStreak = 0
      const poll = async () => {
        pollCount++
        try {
          const task = await api.getTask(taskId)
          errorStreak = 0
          fullGenProgress.value = task.progress || 0
          fullGenMessage.value = task.message || ''

          if (task.status === 'completed') {
            fullGenRunning.value = false
            fullGenMessage.value = '全流程生成完成！'
            // 重新加载数据
            await loadEpisode(currentEpisodeId.value)
            return { success: true }
          }
          if (task.status === 'failed') {
            fullGenRunning.value = false
            fullGenMessage.value = `生成失败：${task.error}`
            return { success: false, error: task.error }
          }
          if (pollCount >= maxPolls) {
            fullGenRunning.value = false
            fullGenMessage.value = '轮询超时（30 分钟），任务仍在后台执行，可稍后刷新页面查看结果'
            return { success: false, error: '任务轮询超时' }
          }
          // 继续轮询
          await new Promise((r) => setTimeout(r, 2000))
          return poll()
        } catch (e) {
          errorStreak++
          if (errorStreak >= DELAYS.FULL_GEN_ERROR_STREAK) {
            fullGenRunning.value = false
            fullGenMessage.value = `查询任务状态连续失败（${e.message}），已停止轮询`
            return { success: false, error: e.message }
          }
          await new Promise((r) => setTimeout(r, DELAYS.POLL_ERROR_RETRY_MS))
          return poll()
        }
      }

      return poll()
    } catch (e) {
      fullGenRunning.value = false
      fullGenMessage.value = `提交失败：${e.message}`
      return { success: false, error: e.message }
    }
  }

  return {
    // 状态
    projectTitle, currentProjectId, currentEpisode, currentEpisodeId, episodes, episodeTheme, artStyle, currentStyle, initialized,
    segmentPlan,
    scriptConfirmed, storyboardConfirmed, scenes, activeSceneId, scriptContent, autoExtractAssets,
    scriptVersions, pendingRewrite,
    aiMessages, aiInput, characters, props, assetScenes, storyboardScenes, storyboardSource, projectCharacters,
    wordCount, totalShots, totalDuration,
    aiLoading, aiStatus, aiProgressMessage, currentTaskId,
    // 长任务结构化进度（2026-09-16）：生成 / 规整 / 补全三条路径共用
    sbProgress, startSbProgressPolling, stopSbProgressPolling, clearSbProgressAfter, settleSbProgress,
    generatingAssetIds,
    generatingStoryboardIds, generatingBlockingIds, generatingKeyframeIds, generatingSceneGridIds, generatingShotGridIds, generatingVideoIds,
    shotGridFailed, shotGridStartedAt, clearShotGridFailed,
    qcReport, qcLoading, qcFixing, qcShowIgnored, qcLastResult,
    loadQcReport, toggleQcShowIgnored, qcFix, qcIgnore, qcUnignore, qcCodesForShot, qcHasErrorForShot,
    systemAlerts, systemAlertCount,
    batchStoryboardGenerating, batchBlockingGenerating,
    fullGenRunning, fullGenProgress, fullGenMessage,
    imageModel, videoModel, aspectRatio,
    // 方法
    initProject, ensureReady, selectProject, loadEpisode, loadProjectCharacters, setStyle,
    loadEpisodes, switchEpisode, addEpisode, renameEpisode, removeEpisode, updateProjectAspectRatio,
    lastExtractInfo, assetsStale, storyboardStale,
    sendAiMessage, saveDraft, confirmScript, reconfirmScript,
    rewriteScript, acceptRewrite, rejectRewrite, saveAsVersion, revertToVersion, lockScript,
    extractAssets, extractStoryboard, confirmStoryboard, clearStoryboard, saveStoryboardInfo,
    generateShotImage, generateSceneGrid, generateShotGrid, batchGenerateImages, setPrimaryFrame, generateAssetImage, cancelAssetImageGen, batchGenerateAssetImages, regenerateStaleAssets, generateBlocking, generateShotVideoCombat, generateShotVideoByModel,
    loadAlerts, alertsForShot, alertsForScene, alertsUnattached, resolveAlerts,
    generateFull,
  }
})
