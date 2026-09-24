import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { api } from '../services/api'
import {
  confirmDialog, toastSuccess, toastWarn, toastError, toastInfo,
} from '../services/dialog'
import { buildAssetImagePrompt } from '../services/promptBuilder'
import { reconcilePendingAssetGens } from '../services/pendingAssetGens'
import { buildSceneGroupChains } from '../utils/sceneGroupSchedule'
import { hasId, sameId } from '../utils/assetId.js'
import { characterColor } from '../constants/palette'
import { getVideoEngine } from '../data/videoEngines'
import { STORAGE_KEYS, STORAGE_KEY_PREFIX, POLL, TIMEOUTS, DELAYS, DEFAULTS, FALLBACK_STYLE, BATCH_GEN } from '../constants/app'

const CURRENT_PROJECT_STORAGE_KEY = STORAGE_KEYS.CURRENT_PROJECT

// 分镜行（后端蛇形）→ 组件驼峰结构的单一映射源，loadEpisode 与 refreshStoryboardShots 共用
function mapStoryboardScenes(rawScenes) {
  return (rawScenes || []).map((s, sceneIndex) => ({
      id: s.id,
      sceneNumber: s.scene_number || sceneIndex + 1,
      title: s.title,
      shots: (s.shots || []).map((shot, shotIndex) => ({
        id: shot.id,
        storyboardSceneId: shot.storyboard_scene_id ?? shot.storyboardSceneId ?? null,
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
        cameraAngle: shot.cameraAngle || shot.camera_angle || '',
        overallSoundscape: shot.overallSoundscape || shot.overall_soundscape || '',
        nonDiegeticMusic: shot.nonDiegeticMusic || shot.non_diegetic_music || '',
        integratedMultimodalDescription: shot.integratedMultimodalDescription || shot.integrated_multimodal_description || '',
        finalFrame: shot.finalFrame || shot.final_frame || '',
        purpose: shot.purpose || '',
        goal: shot.goal || '',
        emotionTone: shot.emotionTone || shot.emotion_tone || '',
        infoPoints: Array.isArray(shot.infoPoints)
          ? shot.infoPoints
          : (() => { try { const v = JSON.parse(shot.info_points || '[]'); return Array.isArray(v) ? v : [] } catch { return [] } })(),
        worldStateIn: shot.worldStateIn || shot.world_state_in || '',
        worldStateOut: shot.worldStateOut || shot.world_state_out || '',
        videoPromptOverride: shot.video_prompt_override || '',
        dialogue: shot.dialogue || null,
        frameUrl: shot.frame_url || '',
        frameUrl2: shot.frame_url2 || '',
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
        videoGenerated: shot.videoGenerated ?? (shot.video_generated === 1 || shot.video_generated === true || shot.video_generated === '1'),
        seamCheck: shot.seamCheck ?? null,
        isCombat: shot.is_combat === 1 ? 1 : (shot.is_combat === 0 ? 0 : null),
        locked: shot.locked === 1 || shot.locked === true,
        version: shot.version || 1,
        qcStatus: shot.qc_status || '',
        qcItems: (() => {
          try {
            const raw = typeof shot.qc_report === 'string' ? JSON.parse(shot.qc_report || '{}') : (shot.qc_report || null)
            return Array.isArray(raw?.items) ? raw.items : []
          } catch { return [] }
        })(),
        hasFrame: !!shot.frame_url,
        hasBlocking: !!(shot.blocking_url || shot.blocking_plan),
        // 回存标识：整场保存靠 (sceneNumber, shotNumber) 定位既有镜头，必须用服务端原值，
        // 否则后端重排后的镜号与前端本地值不一致时会被误判为「新增+删除」，导致镜头被重建（版本链断裂）
        __sceneNumber: s.scene_number ?? sceneIndex + 1,
        __shotNumber: shot.shot_number ?? null,
      })),
    }))
}

// 前端分镜结构 → 回存载荷：本地视图字段不下发（后端不消费），镜号回填服务端原值
// 保留对象引用未变字段的语义：只做浅拷贝 + 剔除，不深改业务字段
function toStoryboardPayload(scenes) {
  return (scenes || []).map((s, sceneIndex) => ({
    ...s,
    sceneNumber: s.__sceneNumber ?? s.sceneNumber ?? sceneIndex + 1,
    shots: (s.shots || []).map((shot) => {
      const { displayId, hasFrame, hasBlocking, seamCheck, __sceneNumber, __shotNumber, ...rest } = shot
      return { ...rest, shotNumber: __shotNumber || shot.shotNumber }
    }),
  }))
}

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

const ASSET_TABLE_LABEL = { characters: '角色', props: '道具', scenes: '场景' }

const PROPS_ID_OFFSET = 100000
const SCENES_ID_OFFSET = 200000

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

async function saveAssetsGuarded({ episodeId, table, items, saveFn, decisions }) {
  const call = (decision) => saveFn(episodeId, {
    [table]: items,
    source: 'extract',
    ...(decision ? { decision } : {}),
  })
  let result = await call(decisions[table])
  if (result && result.risk) {
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
  const projectTitle = ref(DEFAULTS.PROJECT_TITLE)
  const currentProjectId = ref(null) 
  const currentEpisode = ref(1)
  const initialized = ref(false) 
  const currentEpisodeId = ref(null) 
  const episodes = ref([]) 
  const aspectRatio = ref(DEFAULTS.ASPECT_RATIO)
  const generatingAssetIds = ref([]) 
  const assetGenControllers = new Map()

  const LEGACY_IMAGE_MODELS = { 'visionary-gpt-image-2': 'zikl' }
  const storedImageModel = localStorage.getItem(STORAGE_KEYS.IMAGE_MODEL) || ''
  const resolvedImageModel = LEGACY_IMAGE_MODELS[storedImageModel] || storedImageModel || 'zikl'
  if (resolvedImageModel !== storedImageModel) localStorage.setItem(STORAGE_KEYS.IMAGE_MODEL, resolvedImageModel)
  const imageModel = ref(resolvedImageModel)
  watch(imageModel, (v) => localStorage.setItem(STORAGE_KEYS.IMAGE_MODEL, v))
  const videoModel = ref(localStorage.getItem(STORAGE_KEYS.VIDEO_MODEL) || 'h3v4')
  watch(videoModel, (v) => localStorage.setItem(STORAGE_KEYS.VIDEO_MODEL, v))
  const generatingStoryboardIds = ref([]) 
  const generatingBlockingIds = ref([]) 
  const generatingKeyframeIds = ref([])
  const generatingSceneGridIds = ref([]) 
  const generatingShotGridIds = ref([]) 
  const shotGridFailed = ref({}) 
  const shotGridStartedAt = ref({}) 
  const systemAlerts = ref([])
  const systemAlertCount = ref(0)
  const generatingVideoIds = ref([]) 
  const batchStoryboardGenerating = ref(false) 
  const batchBlockingGenerating = ref(false) 
  const artStyle = ref(DEFAULTS.ART_STYLE)

  const currentStyle = ref({ ...FALLBACK_STYLE })
  const stylePresets = ref([])

  async function ensureStylePresets() {
    if (stylePresets.value.length) return stylePresets.value
    try {
      const data = await api.getStyles()
      stylePresets.value = (data.categories || []).flatMap((c) => c.presets || [])
    } catch {
    }
    return stylePresets.value
  }

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
    if (currentProjectId.value) {
      api.updateProject(currentProjectId.value, { art_style: style.label }).catch(() => {})
    }
  }

  async function restoreStyleFromProject(styleName) {
    if (!styleName) return
    artStyle.value = styleName
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
  const scriptVersions = ref([]) 
  const pendingRewrite = ref(null) 

  const aiMessages = ref([
    {
      role: 'assistant',
      content:
        DEFAULTS.AI_GREETING,
    },
  ])

  const aiInput = ref('')

  const aiLoading = ref(false)
  const aiStatus = ref('')
  const aiProgressMessage = ref('')
  const currentTaskId = ref('')

  const sbProgress = ref(null)
  let sbProgressTimer = null

  const fullGenRunning = ref(false)
  const fullGenProgress = ref(0)
  const fullGenMessage = ref('')

  const characters = ref([])
  const props = ref([])
  const assetScenes = ref([])
  const storyboardScenes = ref([])
  const storyboardSource = ref('generated')
  const projectCharacters = ref([])

  const qcReport = ref(null)
  const qcLoading = ref(false)
  const qcFixing = ref([]) 
  const qcShowIgnored = ref(false) 
  const qcLastResult = ref('')
  const qcFixDetails = ref([]) 

  const wordCount = computed(() => scriptContent.value.replace(/\s/g, '').length)
  const totalShots = computed(() => storyboardScenes.value.reduce((sum, s) => sum + s.shots.length, 0))
  const totalDuration = computed(() => storyboardScenes.value.reduce((sum, s) => sum + s.shots.reduce((ss, shot) => ss + shot.duration, 0), 0))

  watch(scriptContent, (content) => {
    const parsed = parseScenesFromScript(content || '')
    scenes.value = parsed
    const validIds = parsed.map((s) => s.id)
    if (!activeSceneId.value || !validIds.includes(activeSceneId.value)) {
      activeSceneId.value = parsed[0]?.id ?? null
    }
  })


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

  async function loadEpisode(episodeId, { retries = 2 } = {}) {
    try {
      const ep = await api.getEpisode(episodeId)
      currentEpisodeId.value = ep.id
      if (currentProjectId.value) rememberEpisodeSelection(currentProjectId.value, ep.id) 
      loadExtractInfo() 
      loadStoryboardInfo() 
      episodeScriptHash.value = ep.scriptHash || ''
      episodeAssetsFp.value = ep.assetsScriptFp || ''
      episodeStoryboardFp.value = ep.storyboardScriptFp || ''
      storyboardSource.value = ep.storyboardSource || 'generated'
      scriptContent.value = ep.script_content || ''
      scriptConfirmed.value = !!ep.scriptConfirmed
      storyboardConfirmed.value = !!ep.storyboardConfirmed
      characters.value = (ep.characters || []).map(({ image_url, audio_url, ...c }) => ({
        ...c,
        imageUrl: image_url || c.imageUrl || '',
        audioUrl: audio_url || c.audioUrl || '',
        projectCharacterId: c.project_character_id || c.projectCharacterId || null,
        linkedToProject: c.linkedToProject || !!c.project_character_id || !!c.projectCharacterId,
        nameEn: c.nameEn || c.name_en || '',
        descriptionEn: c.descriptionEn || c.description_en || '',
      }))
      props.value = (ep.props || []).map(({ image_url, ...p }) => ({
        ...p,
        imageUrl: image_url || p.imageUrl || '',
        nameEn: p.nameEn || p.name_en || '',
        descriptionEn: p.descriptionEn || p.description_en || '',
      }))
      assetScenes.value = (ep.scenes || []).map((s) => ({
        id: s.id,
        sceneNumber: s.scene_number || 0,
        name: s.name || s.scene_name || s.title || `场景${s.scene_number || ''}`,
        description: s.description || s.summary || '',
        propNames: Array.isArray(s.propNames) ? s.propNames : [],
        imageUrl: s.image_url || '',
        location: s.location || '',
        lightingEn: s.lighting_en || '',
        titleEn: s.title_en || '',
        summaryEn: s.summary_en || '',
        spatialGroup: s.spatialGroup || '',
        spatialRole: s.spatialRole || '',
        elements: Array.isArray(s.elements) ? s.elements : [],
        sharedEnv: Array.isArray(s.sharedEnv) ? s.sharedEnv : [],
      }))
      resumePendingAssetGens().catch(() => {})

      storyboardScenes.value = mapStoryboardScenes(ep.storyboardScenes)

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
      restoreGeneratingImages()
      restoreGeneratingVideos()
      restoreGeneratingShotGrids()
      return { success: true }
    } catch (e) {
      if (retries > 0) {
        await new Promise((r) => setTimeout(r, DELAYS.LOAD_RETRY_MS))
        return loadEpisode(episodeId, { retries: retries - 1 })
      }
      console.warn('加载后端数据失败:', e.message)
      return { success: false, error: e.message }
    }
  }

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
    } catch {  }
  }

  // —— 单镜 AI 重写 / 版本链刷新（重生成、回退、时长顺延后统一走这里）——
  const regeneratingShotIds = ref([])

  // 拉取服务端最新分镜行，按 id 就地覆盖本地镜像（内容/时轴/QC/锁定全量刷新）；
  // 场次或镜头数量与本地不一致（锁定镜跳过删除、清空重来等结构变化）时整体重建
  async function refreshStoryboardShots() {
    if (!currentEpisodeId.value) return
    try {
      const ep = await api.getEpisode(currentEpisodeId.value)
      const mapped = mapStoryboardScenes(ep.storyboardScenes)
      const local = storyboardScenes.value
      const sameShape = mapped.length === local.length && mapped.every((s, i) =>
        s.id === local[i].id
        && s.shots.length === local[i].shots.length
        && s.shots.every((sh, j) => sh.id === local[i].shots[j].id)
      )
      if (!sameShape) {
        storyboardScenes.value = mapped
        return
      }
      for (let i = 0; i < mapped.length; i++) {
        for (let j = 0; j < mapped[i].shots.length; j++) {
          Object.assign(local[i].shots[j], mapped[i].shots[j])
        }
      }
    } catch (e) {
      console.warn('[refreshStoryboardShots] 刷新分镜失败:', e.message)
    }
  }

  // 单镜 AI 重写：上下文由后端组装（前镜 Airlock 继承/后镜出画约束/剧本片段/资产清单），完成后全量刷新
  async function regenerateShot(shotId, instruction = '') {
    if (!currentEpisodeId.value) return { success: false, error: '未加载剧集' }
    if (regeneratingShotIds.value.includes(shotId)) return { success: false, error: '该镜头正在重写中' }
    regeneratingShotIds.value.push(shotId)
    try {
      const r = await api.regenerateShot(currentEpisodeId.value, shotId, { instruction: String(instruction || '').trim() })
      await refreshStoryboardShots()
      return { success: true, shot: r.shot }
    } catch (e) {
      return { success: false, error: e.message }
    } finally {
      regeneratingShotIds.value = regeneratingShotIds.value.filter((id) => id !== shotId)
    }
  }

  async function restoreGeneratingImages() {
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
            refreshShotImageFields()
          }
          if (!remaining.length) {
            clearInterval(imageJobPollTimer)
            imageJobPollTimer = null
          }
        } catch {  }
      }, POLL.INTERVAL_MS)
    } catch (e) {
      console.warn('[restoreGeneratingImages] 恢复生成中任务失败:', e.message)
    }
  }

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
          generatingShotGridIds.value = generatingShotGridIds.value.filter(
            (id) => !running.includes(id) || nextRunning.includes(id)
          )
          if (nextRunning.length < running.length) {
            refreshShotImageFields()
          }
          if (!nextRunning.length) {
            clearInterval(shotGridJobPollTimer)
            shotGridJobPollTimer = null
          }
        } catch {  }
      }, POLL.INTERVAL_MS)
    } catch (e) {
      console.warn('[restoreGeneratingShotGrids] 恢复四宫格任务状态失败:', e.message)
    }
  }

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
        } catch {  }
      }, POLL.INTERVAL_MS)
    } catch (e) {
      console.warn('[restoreGeneratingVideos] 恢复出片任务失败:', e.message)
    }
  }

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
    } catch {  }
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

  function clearGenerationState() {
    fullGenRunning.value = false
    fullGenProgress.value = 0
    fullGenMessage.value = ''
    scriptVersions.value = []
    pendingRewrite.value = null
    lastExtractInfo.value = null
    lastStoryboardInfo.value = null
    episodeScriptHash.value = ''
    episodeAssetsFp.value = ''
    episodeStoryboardFp.value = ''
  }

  function clearCurrentEpisode() {
    clearGenerationState()
    currentEpisodeId.value = null
    currentEpisode.value = 1
    episodes.value = []
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

  async function selectProject(projectId) {
    try {
      clearGenerationState()
      const project = await api.getProject(projectId)
      projectTitle.value = project.title || '未命名项目'
      aspectRatio.value = project.aspect_ratio || DEFAULTS.ASPECT_RATIO
      await ensureStylePresets()
      await restoreStyleFromProject(project.art_style)
      currentProjectId.value = project.id
      storeCurrentProjectId(project.id)
      storyboardConfirmed.value = false
      const epList = await api.getEpisodes(project.id)
      episodes.value = epList
      await loadProjectCharacters()
      if (epList.length > 0) {
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

  const EP_SEL_KEY = STORAGE_KEYS.EPISODE_SELECTION
  function rememberEpisodeSelection(projectId, episodeId) {
    try {
      const map = JSON.parse(localStorage.getItem(EP_SEL_KEY) || '{}')
      map[projectId] = episodeId
      localStorage.setItem(EP_SEL_KEY, JSON.stringify(map))
    } catch {  }
  }
  function recallEpisodeSelection(projectId) {
    try {
      const map = JSON.parse(localStorage.getItem(EP_SEL_KEY) || '{}')
      return map[projectId] || null
    } catch { return null }
  }

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

  async function loadAlerts({ includeResolved = false, silent = true } = {}) {
    const epId = currentEpisodeId.value
    if (!epId) { systemAlerts.value = []; systemAlertCount.value = 0; return [] }
    try {
      const r = await api.getAlerts({ episodeId: epId, includeResolved })
      systemAlerts.value = Array.isArray(r?.alerts) ? r.alerts : []
      systemAlertCount.value = Number(r?.unresolved) || 0
      return systemAlerts.value
    } catch (e) {
      if (!silent) console.warn('加载系统告警失败:', e.message)
      return []
    }
  }
  function alertsForShot(shotId) {
    if (shotId == null || shotId === '') return []
    return systemAlerts.value.filter((a) => Number(a.shot_id) === Number(shotId))
  }
  function alertsUnattached() {
    return systemAlerts.value.filter((a) => a.shot_id == null && a.scene_id == null)
  }
  async function resolveAlerts(payload) {
    try {
      const r = await api.resolveAlert(payload)
      if (payload?.id != null) {
        systemAlerts.value = systemAlerts.value.filter((a) => Number(a.id) !== Number(payload.id))
      } else if (payload?.shotId != null) {
        systemAlerts.value = systemAlerts.value.filter((a) => Number(a.shot_id) !== Number(payload.shotId))
      } else if (payload?.sceneId != null) {
        systemAlerts.value = systemAlerts.value.filter((a) => Number(a.scene_id) !== Number(payload.sceneId))
      }
      systemAlertCount.value = systemAlerts.value.length
      return { success: !!r?.success, resolved: Number(r?.resolved) || 0 }
    } catch (e) {
      return { success: false, error: e.message }
    }
  }

  async function switchEpisode(episodeId) {
    if (!episodeId) return { success: false, error: 'episodeId 必填' }
    if (episodeId === currentEpisodeId.value) {
      return loadEpisode(episodeId)
    }
    clearGenerationState()
    const target = episodes.value.find((e) => e.id === episodeId)
    if (target) currentEpisode.value = target.episode_number || currentEpisode.value
    return loadEpisode(episodeId)
  }

  async function updateProjectAspectRatio(ratio) {
    if (!currentProjectId.value) return { success: false, error: '当前没有选中的项目' }
    if (!ratio) return { success: false, error: '比例不能为空' }
    const previous = aspectRatio.value
    aspectRatio.value = ratio
    try {
      await api.updateProject(currentProjectId.value, { aspect_ratio: ratio })
      return { success: true }
    } catch (e) {
      aspectRatio.value = previous
      return { success: false, error: e.message }
    }
  }

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

  async function sendAiMessage() {
    if (!aiInput.value.trim() || aiLoading.value) return

    const userMsg = aiInput.value.trim()
    aiMessages.value.push({ role: 'user', content: userMsg })
    saveAiChatHistory()
    aiInput.value = ''

    const hasScript = !!scriptContent.value.trim()
    const mode = hasScript ? 'auto' : 'generate'

    aiLoading.value = true
    handleAiProgress('submitting', { message: hasScript ? '正在分析要求并处理剧本...' : '正在生成剧本...' })

    let routeInfo = null
    if (mode === 'generate') {
      try {
        routeInfo = await api.ipRoute({ prompt: userMsg, projectId: currentProjectId.value })
      } catch {  }
    }
    const routeCharIds =
      routeInfo?.confidence === 'high' && routeInfo.characters?.length
        ? routeInfo.characters.map((c) => c.id)
        : null

    try {
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
            if (changed) {
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
            if (hasScript && changed) {
              pushScriptVersion(`AI ${actualMode === 'rewrite' ? '整理' : '重写'}前：${userMsg.slice(0, 16)}${userMsg.length > 16 ? '…' : ''}`)
            }
            scriptContent.value = result.script
            if (changed) {
              scriptConfirmed.value = false
              storyboardConfirmed.value = false
            }
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

    if (currentEpisodeId.value) {
      api
        .updateScript(currentEpisodeId.value, { script_content: scriptContent.value, script_confirmed: 1 })
        .then((ep) => {
          if (ep?.script_content && ep.script_content !== scriptContent.value) {
            scriptContent.value = ep.script_content
          }
          scriptConfirmed.value = !!ep?.script_confirmed
          storyboardConfirmed.value = !!ep?.storyboard_confirmed
        })
        .catch((e) => {
          scriptConfirmed.value = false
          toastError('剧本确认失败', { detail: String(e?.message || e) })
        })
    }
  }

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

  function acceptRewrite() {
    if (!pendingRewrite.value) return { success: false, error: '没有待接受的改写' }
    const { selectedText, rewrittenText, instruction, source } = pendingRewrite.value
    const next = scriptContent.value.replace(selectedText, rewrittenText)
    if (next === scriptContent.value) return { success: false, error: '正文中未找到选中段落，无法应用' }
    pushScriptVersion(`${source === 'chat' ? 'AI 修改' : 'AI 改写'}：${instruction.slice(0, 24)}${instruction.length > 24 ? '…' : ''}`)
    scriptContent.value = next
    scriptConfirmed.value = false
    storyboardConfirmed.value = false
    pendingRewrite.value = null
    return { success: true }
  }

  function rejectRewrite() {
    pendingRewrite.value = null
    return { success: true }
  }

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
    if (ver.content !== scriptContent.value) {
      scriptConfirmed.value = false
      storyboardConfirmed.value = false
    }
    scriptContent.value = ver.content
    return { success: true }
  }

  function lockScript() {
    if (!scriptContent.value.trim()) return { success: false, error: '请先编写或导入剧本内容' }
    pushScriptVersion('锁定快照')
    return { success: true }
  }

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
    } catch {  }
  }

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
    } catch {  }
  }
  const episodeScriptHash = ref('')
  const episodeAssetsFp = ref('')
  const episodeStoryboardFp = ref('')
  const assetsStale = computed(() => {
    if (episodeAssetsFp.value) return episodeAssetsFp.value !== episodeScriptHash.value
    return !!lastExtractInfo.value && lastExtractInfo.value.script !== (scriptContent.value || '')
  })
  const storyboardStale = computed(() => {
    if (storyboardSource.value === 'imported') return false
    if (episodeStoryboardFp.value) return episodeStoryboardFp.value !== episodeScriptHash.value
    return !!lastStoryboardInfo.value && lastStoryboardInfo.value.script !== (scriptContent.value || '')
  })

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

    const resumeSave = !!(pendingAssetSave.value && pendingAssetSave.value.episodeId === episodeId)

    if (!resumeSave) {
      const hasExisting = characters.value.length || assetScenes.value.length || props.value.length
      if (hasExisting) {
        const sameAsLast = lastExtractInfo.value &&
          lastExtractInfo.value.script === fingerprint &&
          lastExtractInfo.value.styleLabel === styleLabel
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
        mapped = pendingAssetSave.value
        scriptFp = mapped.scriptFp
      } else {
        const oldCharImages = {}
        const oldCharAudios = {}
        const oldSceneImages = {}
        const oldSceneLighting = {}
        const oldPropImages = {}
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

        const assetBatchBase = Date.now() * 1000
        mapped = {
          episodeId,
          scriptFp,
          characters: (result.assets.characters || []).map((c, i) => ({
            id: assetBatchBase + i, 
            name: c.name || `角色${i + 1}`,
            role: c.role || '配角',
            description: c.description || '',
            color: characterColor(i),
            imageUrl: oldCharImages[c.name] || '', 
            audioUrl: oldCharAudios[c.name] || '', 
            nameEn: c.nameEn || c.name_en || '',
            descriptionEn: c.descriptionEn || c.description_en || '',
          })),
          props: (result.assets.props || []).map((p, i) => ({
            id: assetBatchBase + PROPS_ID_OFFSET + i,
            name: typeof p === 'string' ? p : (p.name || `道具${i + 1}`),
            description: typeof p === 'string' ? '' : (p.description || ''),
            owner: typeof p === 'string' ? '' : (p.owner || ''),
            imageUrl: oldPropImages[typeof p === 'string' ? p : p.name] || '',
            nameEn: typeof p === 'string' ? '' : (p.nameEn || p.name_en || ''),
            descriptionEn: typeof p === 'string' ? '' : (p.descriptionEn || p.description_en || ''),
          })),
          scenes: (result.assets.scenes || []).map((s, i) => ({
            id: assetBatchBase + SCENES_ID_OFFSET + i,
            name: s.name || `场景${i + 1}`,
            description: s.description || '',
            propNames: Array.isArray(s.props) ? s.props.map(String) : (Array.isArray(s.propNames) ? s.propNames : []),
            imageUrl: oldSceneImages[s.name] || '',
            titleEn: s.titleEn || s.title_en || '',
            summaryEn: s.summaryEn || s.summary_en || '',
            lightingEn: s.lightingEn || s.lighting_en || '',
            location: s.location || s.location_en || '',
          })),
        }

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

      const saveErrors = []
      const decisions = mapped.decisions || (mapped.decisions = {})
      try {
        if (mapped.characters.length) {
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
        pendingAssetSave.value = { ...mapped, scriptFp }
        toastError(`部分资产保存失败（${saveErrors.length} 项）`, {
          detail: `${saveErrors.join('；')}\n已提取的结果已保留，再次点击「提取资产」将直接重试保存，不再消耗余额。`,
        })
        aiLoading.value = false
        aiStatus.value = ''
        return { success: false, partial: true }
      }

      if (mapped.characters.length) characters.value = mapped.characters
      if (mapped.props.length) props.value = mapped.props
      if (mapped.scenes.length) assetScenes.value = mapped.scenes
      pendingAssetSave.value = null
      await loadEpisode(episodeId)
      if (scriptFp) {
        try { await api.saveExtractInfo(episodeId, scriptFp) } catch (e) { console.warn('[extractAssets] 指纹登记失败:', e.message) }
      }
      saveExtractInfo(fingerprint, styleLabel)
      if (Array.isArray(mapped.staleAssets) && mapped.staleAssets.length) {
        const preview = mapped.staleAssets.slice(0, 5).map(a => a.name).join('、')
          + (mapped.staleAssets.length > 5 ? ` 等 ${mapped.staleAssets.length} 项` : '')
        toastWarn(`${mapped.staleAssets.length} 个资产的描述已更新，但图片还是旧的`, {
          detail: `${preview}\n旧图按之前的描述生成，可能和新描述对不上（出片会图文打架）。点「一键重新生成」按新描述重出这些图（会覆盖现有图）。`,
          action: { label: '一键重新生成', onClick: () => regenerateStaleAssets(mapped.staleAssets) },
          duration: 0, 
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

  async function extractStoryboard() {
    if (!scriptContent.value.trim()) {
      toastWarn('请先编写或确认剧本')
      return { success: false }
    }
    // 前置校验：三类资产任一为空即拦住，避免 AI 空跑后才发现无资产锚（后端 assertAssetsExist 为权威防线）
    // 注意用 assetScenes（已建场景资产），不是 scenes（从剧本解析的场次结构）
    const missingAssets = []
    if (!characters.value.length) missingAssets.push('角色')
    if (!assetScenes.value.length) missingAssets.push('场景')
    if (!props.value.length) missingAssets.push('道具')
    if (missingAssets.length) {
      toastWarn(`本集缺少${missingAssets.join('、')}资产`, {
        detail: '请先在「设定」页提取/补齐资产，再生成分镜。分镜的资产锚（角色/场景/道具）依赖已建资产，缺了会导致镜头没有参考图、出片环境与画风漂移。',
      })
      return { success: false }
    }
    if (aiLoading.value) return { success: false }

    aiLoading.value = true
    handleAiProgress('submitting', { message: '正在生成分镜脚本...' })
    let sbOk = false

    startSbProgressPolling(currentEpisodeId.value)

    try {
      if (currentEpisodeId.value) {
        const result = await api.generateStoryboard({
          episodeId: currentEpisodeId.value,
        })
        if (result.storyboard?.scenes) {
          await api.saveStoryboard(currentEpisodeId.value, {
            storyboardScenes: result.storyboard.scenes,
            storyboard_confirmed: false,
          })
          storyboardConfirmed.value = false
          const reloadResult = await loadEpisode(currentEpisodeId.value)
          if (!reloadResult?.success) {
            throw new Error(reloadResult?.error || '分镜已保存，但重新加载失败')
          }
          saveStoryboardInfo(scriptContent.value)
          toastSuccess('分镜提取完成，已加载最新分镜方案', {
            detail: `共 ${totalShots.value} 个镜头，可继续检查或确认分镜。`,
          })
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
      stopSbProgressPolling()
      settleSbProgress(sbOk ? '分镜生成完成' : '生成流程已结束')
      clearSbProgressAfter()
    }

    aiLoading.value = false
    aiStatus.value = ''
    return { success: false }
  }

  let sbPollGeneration = 0
  let sbTickInFlight = false
  let sbClearToken = 0

  function stopSbProgressPolling() {
    if (sbProgressTimer) { clearInterval(sbProgressTimer); sbProgressTimer = null }
    sbPollGeneration++
  }

  function startSbProgressPolling(episodeId = currentEpisodeId.value) {
    if (!episodeId) return
    stopSbProgressPolling()
    sbClearToken++
    sbProgress.value = null
    const myGeneration = sbPollGeneration
    const tick = async () => {
      if (sbTickInFlight) return
      sbTickInFlight = true
      try {
        const p = await api.getStoryboardProgress(episodeId)
        if (myGeneration !== sbPollGeneration) return
        if (p?.active) {
          sbProgress.value = p
          if (p.message) aiProgressMessage.value = p.message
        } else if (p && !p.active) {
          sbProgress.value = p
          stopSbProgressPolling()
        }
      } catch {  }
      finally { sbTickInFlight = false }
    }
    tick()
    sbProgressTimer = setInterval(tick, BATCH_GEN.STORYBOARD_PROGRESS_POLL_MS)
  }

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

  function clearSbProgressAfter(ms = BATCH_GEN.PROGRESS_CLEAR_AFTER_MS) {
    const myToken = ++sbClearToken
    setTimeout(() => {
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
        storyboardScenes: toStoryboardPayload(storyboardScenes.value),
        storyboard_confirmed: true,
      })
      storyboardConfirmed.value = true
      saveStoryboardInfo(scriptContent.value)
      return { success: true }
    } catch (e) {
      toastError('确认分镜失败', { detail: String(e.message) })
      return { success: false, error: e.message }
    }
  }

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
      } catch {  }
      await loadEpisode(currentEpisodeId.value)
      return { success: true }
    } catch (e) {
      console.error('清空分镜失败', e)
      return { success: false, error: e.message }
    }
  }

  function findShot(shotId) {
    for (const scene of storyboardScenes.value) {
      const shot = scene.shots.find((s) => s.id === shotId || String(s.id) === String(shotId))
      if (shot) return { shot, scene }
    }
    return null
  }

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

    for (const name of (shot.characters || [])) {
      const c = characters.value.find(x => x.name === name)
      if (c?.description) {
        lockParts.push(`@${name} exactly as shown, ${c.description}`)
      }
    }
    if (shot.sceneAssets?.length) {
      lockParts.push(`The scene environment remains completely unchanged in structure, color, and arrangement — no element shifts or disappears`)
    }
    for (const name of (shot.propAssets || [])) {
      lockParts.push(`The prop【${name}】保持其外观和材质不变`)
    }

    if (!parts.length && !lockParts.length) return ''
    let result = ''
    if (parts.length) result += `。画面要素必须严格遵循以下设定：【${parts.join('、')}】`
    if (lockParts.length) result += `。【视觉锁定】${lockParts.join('、')}`
    return result
  }


  function buildStyleGuard() {
    const name = currentStyle.value?.label || artStyle.value || ''
    return name
      ? `。【画风统一约束】整幅画面风格统一为「${name}」画风，线条、上色、光影、质感与上述画面描述完全一致，禁止偏离画风。`
      : ''
  }

  function stylePromptText() {
    return getStylePrompt()
  }

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

  async function generateShotImage(shotId, imageType = 'frame', provider) {
    const idList = imageType === 'blocking'
      ? generatingBlockingIds
      : imageType === 'keyframe'
        ? generatingKeyframeIds
        : generatingStoryboardIds
    if (idList.value.includes(shotId)) return 

    const found = findShot(shotId)
    if (!found) {
      toastError('未找到镜头', { detail: String(shotId) })
      return
    }
    const targetShot = found.shot

    idList.value.push(shotId)

    try {
      if (imageType === 'blocking') {
        idList.value = idList.value.filter(x => x !== shotId)
        return await generateBlocking(targetShot.id)
      }

      if (imageType === 'keyframe' && !(targetShot.finalFrame || '').trim()) {
        idList.value = idList.value.filter(x => x !== shotId)
        toastWarn('无法生成尾帧锚：缺少「本镜最终画面」描述', {
          detail: '请先补全提示词，或手动填写本镜最终画面。',
        })
        return { success: false }
      }

      const basePrompt = targetShot.integratedMultimodalDescription
        ? targetShot.integratedMultimodalDescription
        : `${targetShot.description}${buildAssetBrief(targetShot)}`
      const imagePrompt = `${stylePromptText()}，${basePrompt}${buildStyleGuard()}`
      console.log('[generateShotImage] prompt length:', imagePrompt.length, 'shotId:', shotId, 'imageType:', imageType)
      const params = { shotId: targetShot.id, prompt: imagePrompt, imageType, provider }
      if (imageType === 'frame' || imageType === 'keyframe') {
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
          targetShot.keyframeUrl = result.url
        } else {
          const urlField = `${imageType}Url`
          targetShot[urlField] = result.url
          targetShot.frameUrl2 = result.urls?.[1] || ''
          targetShot.frameDualKeyframe = !!result.dualKeyframe
          targetShot.hasFrame = true
        }
        // 服务端注入管线的出图依据快照：单帧出图不重拉列表，本地同步给锚徽标/依据面板
        if (result.anchorSnapshot !== undefined) {
          targetShot.anchorSnapshot = result.anchorSnapshot || null
          targetShot.anchorStale = false
        }
        console.log('[generateShotImage] persisted url:', result.url)
        idList.value = idList.value.filter(x => x !== shotId)
        return { success: true, url: result.url }
      }
      throw new Error(result.error || '生成失败')
    } catch (e) {
      console.error('[generateShotImage] error:', e)
      toastError('生成失败', { detail: String(e.message) })
    }

    idList.value = idList.value.filter(x => x !== shotId)
    return { success: false }
  }

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

  async function generateShotVideoV4(shotId, overrides = {}) {
    if (!shotId) return { success: false, error: 'shotId 必填' }
    if (generatingVideoIds.value.includes(shotId)) return { success: false, error: '该镜正在出片' }

    const found = findShot(shotId)
    if (!found) { toastError('未找到镜头', { detail: String(shotId) }); return { success: false } }
    const targetShot = found.shot

    const dlgText = String(targetShot.dialogue || '').trim()
    const hasDlg = !!dlgText && dlgText !== 'null' && dlgText !== '[]'
    const allowSilent = !hasDlg

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
      // 衔接告警锁（409）的人工放行：确认后带 ignoreSeamAlert 重试（循环而非递归，
      // 避免 inflight 状态未清导致重试被"该镜正在出片"拦截而静默失败）
      let ignoreSeamAlert = Boolean(overrides.ignoreSeamAlert)
      for (;;) {
        let result
        try {
          result = await api.generateVideoV4({
            shotId: targetShot.id,
            aspectRatio: overrides.aspectRatio ?? aspectRatio.value,
            megapixels: overrides.megapixels,
            duration,
            allowSilent,
            ignoreSeamAlert,
          })
        } catch (e) {
          if (e?.status === 409 && !ignoreSeamAlert && /出片链已锁死/.test(String(e.message || ''))) {
            const ok = await confirmDialog({
              title: '衔接告警 · 人工放行',
              description: String(e.message || ''),
              confirmText: '忽略告警，继续出片',
              cancelText: '先去重生上一镜',
              tone: 'warn',
            })
            if (ok) { ignoreSeamAlert = true; continue }
          }
          throw e
        }
        console.log('[generateShotVideoV4] result:', result)
        if (result.success && result.url) {
          targetShot.videoUrl = result.url
          if (result.warning) toastWarn('生成完成，有 1 项提示', { detail: String(result.warning) })
          return { success: true, url: result.url }
        }
        throw new Error(result.error || '出片失败')
      }
    } catch (e) {
      console.error('[generateShotVideoV4] error:', e)
      toastError('全能V4 出片失败', { detail: String(e.message) })
    } finally {
      generatingVideoIds.value = generatingVideoIds.value.filter((x) => x !== shotId)
    }
    return { success: false }
  }

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

  async function generateShotGrid(shotId, provider) {
    if (!shotId) return { success: false, error: 'shotId 必填' }
    if (generatingShotGridIds.value.includes(shotId)) return { success: false, error: '该镜正在出四宫格' }
    generatingShotGridIds.value.push(shotId)
    const key = Number(shotId)
    shotGridStartedAt.value[key] = Date.now()
    delete shotGridFailed.value[key] 
    try {
      const result = await api.generateShotGrid({ shotId, provider: provider || imageModel.value, aspectRatio: aspectRatio.value })
      console.log('[generateShotGrid] result:', result)
      if (result?.success) {
        delete shotGridFailed.value[key]
        if (currentEpisodeId.value) await loadEpisode(currentEpisodeId.value)
        return { success: true, gridImageUrl: result.gridImageUrl }
      }
      throw new Error(result?.error || '生成失败')
    } catch (e) {
      console.error('[generateShotGrid] error:', e)
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

  async function generateSceneGrid(sceneId, provider) {
    if (!sceneId) return { success: false, error: 'sceneId 必填' }
    if (generatingSceneGridIds.value.includes(sceneId)) return { success: false, error: '该场正在出四宫格' }
    generatingSceneGridIds.value.push(sceneId)
    try {
      const result = await api.generateSceneGrid({ sceneId, provider: provider || imageModel.value })
      console.log('[generateSceneGrid] result:', result)
      if (result?.success) {
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

  async function generateBlocking(shotId) {
    if (generatingBlockingIds.value.includes(shotId)) return
    const found = findShot(shotId)
    if (!found) {
      toastError('未找到镜头', { detail: String(shotId) })
      return { success: false }
    }
    generatingBlockingIds.value.push(shotId)

    try {
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

  const ASSET_GEN_KEY = STORAGE_KEYS.PENDING_ASSET_GENS
  const ASSET_GEN_TIMEOUT = TIMEOUTS.ASSET_GEN_MS
  function readPendingGens() {
    try { return JSON.parse(localStorage.getItem(ASSET_GEN_KEY) || '[]') } catch { return [] }
  }
  function writePendingGens(list) {
    try { localStorage.setItem(ASSET_GEN_KEY, JSON.stringify(list)) } catch {  }
  }
  function removePendingGen(id) {
    writePendingGens(readPendingGens().filter(t => String(t.id) !== String(id)))
  }
  let assetGenPollTimer = null
  function startAssetGenPoller() {
    if (assetGenPollTimer) return
    assetGenPollTimer = setInterval(async () => {
      const pending = readPendingGens()
      const mine = pending.filter(t => String(t.episodeId) === String(currentEpisodeId.value || ''))
      if (!mine.length) {
        const now = Date.now()
        const rest = pending.filter(t => now - t.startedAt <= ASSET_GEN_TIMEOUT)
        if (rest.length !== pending.length) writePendingGens(rest)
        clearInterval(assetGenPollTimer)
        assetGenPollTimer = null
        return
      }
      try { await loadEpisode(currentEpisodeId.value) } catch {  }
      const now = Date.now()
      const doneIds = []
      const rest = []
      for (const t of pending) {
        if (String(t.episodeId) !== String(currentEpisodeId.value || '')) { rest.push(t); continue }
        if (now - t.startedAt > ASSET_GEN_TIMEOUT) { doneIds.push(t.id); continue } 
        const list = t.type === 'character' ? characters.value : t.type === 'scene' ? assetScenes.value : props.value
        const cur = list.find(x => String(x.id) === String(t.id))
        if (!cur) { doneIds.push(t.id); continue } 
        if ((cur.imageUrl || '') !== (t.prevUrl || '')) doneIds.push(t.id) 
        else rest.push(t)
      }
      writePendingGens(rest)
      if (doneIds.length) {
        generatingAssetIds.value = generatingAssetIds.value.filter(x => !hasId(doneIds, x))
      }
      if (!rest.length) { clearInterval(assetGenPollTimer); assetGenPollTimer = null }
    }, 5000)
  }
  async function resumePendingAssetGens() {
    if (!currentEpisodeId.value) return
    const pending = readPendingGens()
    if (!pending.length) return

    let runningAssetIds = null
    try {
      const data = await api.getImageJobsInflight()
      runningAssetIds = new Set(
        (Array.isArray(data?.assets) ? data.assets : []).map(a => String(a.assetId))
      )
    } catch (e) {
      console.warn('[resumePendingAssetGens] 查询后端 in-flight 资产任务失败，保守保留 pending：', e.message)
    }

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
      if (!hasId(generatingAssetIds.value, id)) {
        generatingAssetIds.value.push(id)
        changed = true
      }
    }
    if (changed || generatingAssetIds.value.length) startAssetGenPoller()
  }


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
    if (hasId(generatingAssetIds.value, id)) return 
    if (!currentStyle.value?.prompt) {
      toastWarn('请先选择画风')
      return
    }

    generatingAssetIds.value.push(id)
    const abortCtrl = new AbortController()
    assetGenControllers.set(String(id), abortCtrl)
    const __list0 = type === 'character' ? characters.value : type === 'scene' ? assetScenes.value : props.value
    const __cur0 = __list0.find(x => String(x.id) === String(id))
    writePendingGens([
      ...readPendingGens().filter(t => String(t.id) !== String(id)),
      { type, id, episodeId: currentEpisodeId.value || '', prevUrl: __cur0?.imageUrl || '', startedAt: Date.now() },
    ])
    startAssetGenPoller()

    try {
      let refImageUrl = ''
      if (editInstruction) {
        const list = type === 'character' ? characters.value : type === 'scene' ? assetScenes.value : props.value
        const cur = list.find(x => String(x.id) === String(id))
        refImageUrl = cur?.imageUrl || ''
        if (!refImageUrl) {
          toastWarn('该资产还没有图片，无法改造', { detail: '请先用「AI生成」出一张基础形象图' })
          assetGenControllers.delete(String(id)) 
          removePendingGen(id)
          generatingAssetIds.value = generatingAssetIds.value.filter(x => !sameId(x, id))
          return { success: false }
        }
      }

      let imagePrompt
      if (type === 'scene') {
        const scene = assetScenes.value.find(s => s.id === id)
        const sceneName = scene?.name || ''
        const excludeProps = (scene?.propNames || []).filter(Boolean)
        imagePrompt = buildAssetImagePrompt('scene', {
          description, name: sceneName, stylePrompt: stylePromptText(),
          styleLabel: currentStyle.value?.label || artStyle.value || '',
          excludeProps,
          lightingEn: scene?.lightingEn || '',
          spatialRole: scene?.spatialRole || '',
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
        try { await loadEpisode(currentEpisodeId.value) }
        catch (e) { console.warn('[generateAssetImage] reload 失败，沿用内存值', e.message) }
        assetGenControllers.delete(String(id))
        removePendingGen(id)
        generatingAssetIds.value = generatingAssetIds.value.filter(x => !sameId(x, id))
        return { success: true, url: result.url, description: result.description || '' }
      }
      throw new Error(result.error || '生成失败')
    } catch (e) {
      const cancelled = e?.isUserCancel || assetGenControllers.get(String(id))?.signal.aborted
      if (!cancelled) toastError('生成失败', { detail: String(e.message) })
      assetGenControllers.delete(String(id))
      removePendingGen(id)
      if (cancelled) {
        generatingAssetIds.value = generatingAssetIds.value.filter(x => !sameId(x, id))
        return { success: false, cancelled: true }
      }
    }

    generatingAssetIds.value = generatingAssetIds.value.filter(x => !sameId(x, id))
    return { success: false }
  }

  function cancelAssetImageGen(id) {
    const key = String(id)
    const ctrl = assetGenControllers.get(key)
    if (ctrl) {
      ctrl.abort() 
      return
    }
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

    const CONCURRENCY = BATCH_GEN.IMAGE_CONCURRENCY
    const FRAME_MAX_ATTEMPTS = 1 + BATCH_GEN.FRAME_RETRY
    let successCount = 0
    let failCount = 0
    let currentIndex = 0
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
          const batchImagePrompt = (() => {
            const basePrompt = shot.integratedMultimodalDescription
              ? shot.integratedMultimodalDescription
              : `${shot.description}${buildAssetBrief(shot)}`
            return `${stylePromptText()}，${basePrompt}${buildStyleGuard()}`
          })()
          const params = { shotId: shot.id, prompt: batchImagePrompt, imageType, provider }
          if (imageType === 'frame') {
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

    const workers = Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker())
    await Promise.all(workers)

    idList.value = []
    batchFlag.value = false
    const batchMsg = `批量生成${typeLabel}完成：成功 ${successCount} 个，失败 ${failCount} 个`
    if (failCount > 0) toastWarn(batchMsg, { detail: '可对失败的项单独重试' })
    else toastSuccess(batchMsg)
    return { success: true, successCount, failCount }
  }

  async function batchGenerateAssetImages(type, options = {}) {
    const {
      onlyMissing = true,
      concurrency = 3,
      provider,
      onProgress,
      ids = null,
      // 组内出图模式：true=并行（同组同时出，快，默认）；false=串联（同组一张画完再画下一张，保锚点时序）
      groupParallel = true,
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

    const inScope = all.filter((it) => (onlyMissing ? !it.imageUrl : true) && (!idSet || idSet.has(String(it.id))))
    const targets = inScope.filter((it) => !hasId(generatingAssetIds.value, it.id))
    let skipped = inScope.length - targets.length

    if (!targets.length) {
      if (skipped > 0) toastInfo('待生成的资产都已在生成中')
      else toastInfo(onlyMissing ? '所有资产都已有图片，无需补生成' : '暂无可生成的资产')
      return { success: true, successCount: 0, failCount: 0, failedIds: [], total: 0, skipped }
    }

    const model = provider || imageModel.value
    let successCount = 0
    let failCount = 0
    const failedIds = []
    let done = 0

    let chains = targets.map((t) => [t])
    if (type === 'scene') {
      let groupInfo = null
      try {
        const g = await api.getSceneSpatialGroups(currentEpisodeId.value)
        if (g && g.groups && Object.keys(g.groups).length) groupInfo = g.groups
      } catch (e) {
        console.warn('[batchGenerateAssetImages] 空间分组获取失败，场景图退化为全串行:', e.message)
      }

      // 组还没定基准图（pending）的场景不允许出图：先定基准，其余成员才能照基准画。
      // 与成员卡的「先定参考图」锁、服务端 409 拦截三层对齐。
      if (groupInfo) {
        const pendingTargets = targets.filter((t) => groupInfo[String(t.id)]?.status === 'pending')
        if (pendingTargets.length) {
          const names = pendingTargets.slice(0, 3).map((t) => t.name).join('、')
          toastWarn(`有 ${pendingTargets.length} 个场景所在组还没定参考图，已跳过（${names}${pendingTargets.length > 3 ? '等' : ''}）。先去场景页确认基准图`)
          for (const t of pendingTargets) {
            const idx = targets.indexOf(t)
            if (idx >= 0) targets.splice(idx, 1)
          }
          skipped += pendingTargets.length
        }
      }

      if (!targets.length) {
        toastWarn('所选场景所在的组都还没定参考图，先去场景页定基准')
        return { success: true, successCount: 0, failCount: 0, failedIds: [], total: 0, skipped }
      }

      chains = buildSceneGroupChains(targets, groupInfo, { parallel: groupParallel })
      if (!groupInfo && !groupParallel) {
        console.log('[batchGenerateAssetImages] 场景图无空间分组信息 → 全串行（保证锚点生效）')
      }
    }

    const total = targets.length

    async function runChain(chain) {
      for (const task of chain) {
        try {
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
            try { onProgress(done, total) } catch {  }
          }
        }
      }
    }

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
      await api.updateShot(currentEpisodeId.value, shotId, { frame_url: main, frame_url2: second })
      return { success: true }
    } catch (e) {
      console.error('[setPrimaryFrame] save failed:', e)
      return { success: false, error: e.message }
    }
  }

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

  async function toggleQcShowIgnored() {
    qcShowIgnored.value = !qcShowIgnored.value
    return loadQcReport({ silent: true, includeIgnored: qcShowIgnored.value })
  }

  async function qcFix(code, shots, title = '') {
    if (!currentEpisodeId.value || !code) return { success: false }
    if (qcFixing.value.includes(code)) return { success: false }
    qcFixing.value = [...qcFixing.value, code]
    qcLastResult.value = ''
    qcFixDetails.value = []
    const label = title || code
    try {
      const res = await api.qcFix({ episodeId: currentEpisodeId.value, code, shots })
      const parts = []
      if (res.fixed) parts.push(`修好 ${res.fixed} 处`)
      if (res.failed) parts.push(`${res.failed} 处未成功`)
      if (res.truncated) {
        parts.push(`本次只处理前 ${res.processed} 处，还剩 ${res.requested - res.processed} 处需再点一次`)
      }
      qcLastResult.value = parts.length
        ? `「${label}」${parts.join('，')}`
        : (res.message || `「${label}」处理完成`)
      qcFixDetails.value = Array.isArray(res.details) ? res.details : []
      if (res.fixed) {
        await loadEpisode(currentEpisodeId.value)
      }
      await loadQcReport({ silent: true })
      return res
    } catch (e) {
      console.error('[qcFix] failed:', e)
      qcLastResult.value = `「${label}」修复失败：${e.message || '未知错误'}`
      qcFixDetails.value = []
      return { success: false, error: e.message }
    } finally {
      qcFixing.value = qcFixing.value.filter((c) => c !== code)
    }
  }

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

  async function qcUnignore(id) {
    if (!currentEpisodeId.value || id == null) return { success: false }
    try {
      await api.qcUnignore({ episodeId: currentEpisodeId.value, id })
      await loadQcReport({ silent: true, includeIgnored: true })
      return { success: true }
    } catch (e) {
      console.error('[qcUnignore] failed:', e)
      return { success: false, error: e.message }
    }
  }

  function qcCodesForShot(shotNumber) {
    const idx = qcReport.value?.shotIndex || {}
    return idx[String(shotNumber || '')] || []
  }

  function qcHasErrorForShot(shotNumber) {
    const codes = qcCodesForShot(shotNumber)
    const groups = qcReport.value?.groups || []
    return codes.some((c) => groups.find((g) => g.code === c)?.level === 'error')
  }

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
      let characterIds = null
      try {
        const route = await api.ipRoute({ prompt, projectId: currentProjectId.value })
        if (route.confidence === 'high' && route.characters?.length) {
          characterIds = route.characters.map((c) => c.id)
        }
      } catch {  }

      const result = await api.generateFull({
        episodeId: currentEpisodeId.value,
        prompt,
        options: { ...options, characterIds },
      })
      const taskId = result.taskId

      const maxPolls = 900 
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
    projectTitle, currentProjectId, currentEpisode, currentEpisodeId, episodes, artStyle, currentStyle, initialized,
    scriptConfirmed, storyboardConfirmed, scenes, activeSceneId, scriptContent,
    scriptVersions, pendingRewrite,
    aiMessages, aiInput, characters, props, assetScenes, storyboardScenes, storyboardSource, projectCharacters,
    wordCount, totalShots, totalDuration,
    aiLoading, aiStatus, aiProgressMessage, currentTaskId,
    sbProgress, startSbProgressPolling, stopSbProgressPolling, clearSbProgressAfter, settleSbProgress,
    generatingAssetIds,
    generatingStoryboardIds, generatingBlockingIds, generatingKeyframeIds, generatingSceneGridIds, generatingShotGridIds, generatingVideoIds,
    shotGridFailed, shotGridStartedAt, clearShotGridFailed,
    qcReport, qcLoading, qcFixing, qcShowIgnored, qcLastResult, qcFixDetails,
    loadQcReport, toggleQcShowIgnored, qcFix, qcIgnore, qcUnignore, qcCodesForShot, qcHasErrorForShot,
    systemAlerts, systemAlertCount,
    batchStoryboardGenerating, batchBlockingGenerating,
    fullGenRunning, fullGenProgress, fullGenMessage,
    imageModel, videoModel, aspectRatio,
    initProject, ensureReady, selectProject, loadEpisode, loadProjectCharacters, setStyle,
    loadEpisodes, switchEpisode, addEpisode, removeEpisode, updateProjectAspectRatio,
    lastExtractInfo, assetsStale, storyboardStale,
    sendAiMessage, saveDraft, confirmScript,
    rewriteScript, acceptRewrite, rejectRewrite, saveAsVersion, revertToVersion, lockScript,
    extractAssets, extractStoryboard, confirmStoryboard, clearStoryboard, saveStoryboardInfo,
    generateShotImage, generateSceneGrid, generateShotGrid, batchGenerateImages, setPrimaryFrame, generateAssetImage, cancelAssetImageGen, batchGenerateAssetImages, regenerateStaleAssets, generateBlocking, generateShotVideoCombat, generateShotVideoByModel,
    regeneratingShotIds, regenerateShot, refreshStoryboardShots,
    loadAlerts, alertsForShot, alertsUnattached, resolveAlerts,
    generateFull,
  }
})
