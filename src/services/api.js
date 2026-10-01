const BASE = '/api'

const DEFAULT_TIMEOUT_MS = 60000
const LLM_TIMEOUT_MS = 480000
const LLM_LONG_TIMEOUT_MS = 1500000
const POLL_TIMEOUT_MS = 5000
const QUERY_TIMEOUT_MS = 120000
const MEDIA_TIMEOUT_MS = 600000
const COMBAT_VIDEO_TIMEOUT_MS = 900000
const VIDEO_TIMEOUT_MS = 1200000
const CONNECT_TEST_TIMEOUT_MS = 30000

async function request(path, options = {}) {
  const timeoutMs = Number(options.timeout) > 0 ? Number(options.timeout) : DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onExternalAbort = () => controller.abort()
  if (options.signal) {
    if (options.signal.aborted) onExternalAbort()
    else options.signal.addEventListener('abort', onExternalAbort)
  }
  let res
  try {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) }
    const token = localStorage.getItem('api_token')
    if (token) headers['x-api-token'] = token
    res = await fetch(`${BASE}${path}`, {
      ...options,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    })
  } catch (e) {
    if (e && e.name === 'AbortError') {
      if (options.signal?.aborted) {
        const cancelErr = new Error('已取消')
        cancelErr.isUserCancel = true
        throw cancelErr
      }
      throw new Error(`请求超时(${Math.round(timeoutMs / 1000)}s)，请检查后端`)
    }
    throw e
  } finally {
    clearTimeout(timer)
    if (options.signal) options.signal.removeEventListener('abort', onExternalAbort)
  }
  const text = await res.text()
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`服务返回异常 (${res.status})，请查看后端日志`)
  }
  if (!res.ok) {
    if (res.status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('wb:unauthorized'))
    }
    const err = new Error(data.error || `请求失败 (${res.status})`)
    err.status = res.status
    throw err
  }
  return data
}

export const api = {
  getProjects: () => request('/projects'),
  getProject: (id) => request(`/projects/${id}`),
  createProject: (data) => request('/projects', { method: 'POST', body: data }),
  updateProject: (id, data) => request(`/projects/${id}`, { method: 'PUT', body: data }),
  deleteProject: (id) => request(`/projects/${id}`, { method: 'DELETE' }),
  getProjectAssets: (id, type) => request(`/projects/${id}/assets${type ? `?type=${type}` : ''}`),

  getEpisodes: (projectId) => request(`/episodes/project/${projectId}`),
  getEpisode: (id) => request(`/episodes/${id}`),
  getStoryboardGraph: (id) => request(`/episodes/${id}/storyboard-graph`),
  createEpisode: (projectId, data = {}) =>
    request('/episodes', { method: 'POST', body: { project_id: projectId, ...data } }),
  updateEpisodeTitle: (id, title) =>
    request(`/episodes/${id}`, { method: 'PUT', body: { title } }),
  deleteEpisode: (id) => request(`/episodes/${id}`, { method: 'DELETE' }),
  updateScript: (id, data) => request(`/episodes/${id}/script`, { method: 'PUT', body: data }),
  previewScriptImport: (id, text) => request(`/episodes/${id}/script/preview`, { method: 'POST', body: { text } }),
  saveAiChatHistory: (id, messages) => request(`/episodes/${id}/script`, {
    method: 'PUT',
    body: { ai_chat_history: messages },
  }),
  saveCharacters: (id, data) => request(`/episodes/${id}/characters`, { method: 'POST', body: data }),
  saveProps: (id, data) => request(`/episodes/${id}/props`, { method: 'POST', body: data }),
  saveScenes: (id, data) => request(`/episodes/${id}/scenes`, { method: 'POST', body: data }),
  saveStoryboard: (id, data) => request(`/episodes/${id}/storyboard`, { method: 'POST', body: data }),
  clearStoryboard: (id) => request(`/episodes/${id}/storyboard`, { method: 'DELETE' }),
  enrichStoryboard: (episodeId, options = {}) =>
    request('/generate/enrich-storyboard', { method: 'POST', body: { episodeId, ...options }, timeout: LLM_LONG_TIMEOUT_MS }),
  updateShot: (episodeId, shotId, data) =>
    request(`/episodes/${episodeId}/shots/${shotId}`, { method: 'PUT', body: data }),
  regenerateShot: (episodeId, shotId, data = {}) =>
    request(`/episodes/${episodeId}/shots/${shotId}/regenerate`, { method: 'POST', body: data, timeout: LLM_TIMEOUT_MS }),
  getShotVersions: (episodeId, shotId) =>
    request(`/episodes/${episodeId}/shots/${shotId}/versions`),
  restoreShotVersion: (episodeId, shotId, versionId) =>
    request(`/episodes/${episodeId}/shots/${shotId}/versions/${versionId}/restore`, { method: 'POST', body: {} }),

  generateFull: (data) => request('/generate/full', { method: 'POST', body: data }),
  generateScript: (data) => request('/generate/script', { method: 'POST', body: data, timeout: LLM_TIMEOUT_MS }),
  ipRoute: (data) => request('/generate/ip-route', { method: 'POST', body: data, timeout: LLM_TIMEOUT_MS }),
  rewriteScript: (data) => request('/generate/script-rewrite', { method: 'POST', body: data, timeout: LLM_TIMEOUT_MS }),
  generateAssets: (data) => request('/generate/assets', { method: 'POST', body: data, timeout: LLM_LONG_TIMEOUT_MS }),
  generateStoryboard: (data) => request('/generate/storyboard', { method: 'POST', body: data, timeout: LLM_LONG_TIMEOUT_MS }),
  getStoryboardProgress: (episodeId) =>
    request(`/generate/storyboard-progress?episodeId=${encodeURIComponent(episodeId)}`, { timeout: POLL_TIMEOUT_MS }),
  extractStoryboardFromFile: (data) => request('/generate/storyboard-from-file', { method: 'POST', body: data, timeout: LLM_LONG_TIMEOUT_MS }),
  generateSceneGrid: (data) => request('/generate/scene-grid', { method: 'POST', body: data, timeout: MEDIA_TIMEOUT_MS }),
  generateShotGrid: (data) => request('/generate/shot-grid', { method: 'POST', body: data, timeout: MEDIA_TIMEOUT_MS }),
  getShotGridJobs: () => request('/generate/shot-grid/status'),
  generateImage: (data) => request('/generate/image', { method: 'POST', body: data, timeout: MEDIA_TIMEOUT_MS }),
  getImageJobsInflight: () => request('/generate/image/inflight'),
  // 出片任务化：提交接口只做校验+建单，毫秒级返回 jobId；结果走 getVideoJobs 轮询
  getShotDurationLimits: () => request('/generate/video/duration-limits', { timeout: QUERY_TIMEOUT_MS }),
  generateVideoCombat: (data) => request('/generate/video-v3', { method: 'POST', body: data, timeout: QUERY_TIMEOUT_MS }),
  generateVideoV4: (data) => request('/generate/video-v4', { method: 'POST', body: data, timeout: QUERY_TIMEOUT_MS }),
  getVideoJobs: (episodeId, activeOnly = false) =>
    request(`/generate/video-jobs?episodeId=${encodeURIComponent(episodeId)}${activeOnly ? '&activeOnly=1' : ''}`, { timeout: POLL_TIMEOUT_MS }),
  getCompositions: (episodeId) =>
    request(`/generate/video/compositions?episodeId=${encodeURIComponent(episodeId)}`, { timeout: QUERY_TIMEOUT_MS }),
  composeVideo: (data) => request('/generate/video/compose', { method: 'POST', body: data, timeout: MEDIA_TIMEOUT_MS }),
  getBgmList: () => request('/generate/bgm-list'),
  getAlerts: (params = {}) => {
    const qs = []
    if (params.episodeId != null) qs.push(`episodeId=${params.episodeId}`)
    if (params.includeResolved) qs.push('includeResolved=1')
    return request(`/generate/alerts${qs.length ? '?' + qs.join('&') : ''}`)
  },
  resolveAlert: (data) => request('/generate/alerts/resolve', { method: 'POST', body: data }),
  deleteShotVideo: (episodeId, shotId) =>
    request(`/episodes/${episodeId}/shots/${shotId}/video`, { method: 'DELETE' }),
  deleteShotsVideo: (episodeId, shotIds) =>
    request(`/episodes/${episodeId}/shots/video-delete`, { method: 'POST', body: { shotIds } }),
  generateAssetImage: (data, options = {}) => request('/generate/asset-image', { method: 'POST', body: data, timeout: MEDIA_TIMEOUT_MS, signal: options.signal }),
  assetHistory: (type, id) => request(`/generate/asset-history?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`, { timeout: QUERY_TIMEOUT_MS }),
  getSceneSpatialGroups: (episodeId) =>
    request(`/generate/scene-spatial-groups?episodeId=${encodeURIComponent(episodeId)}`, { timeout: QUERY_TIMEOUT_MS }),
  getSpatialGroupReviewStatus: (episodeId) =>
    request(`/generate/spatial-group-review/status?episodeId=${encodeURIComponent(episodeId)}`, { timeout: QUERY_TIMEOUT_MS }),
  initSpatialGroupReview: (data) => request('/generate/spatial-group-review/init', { method: 'POST', body: data }),
  decideSpatialGroupReview: (data) => request('/generate/spatial-group-review/decide', { method: 'POST', body: data }),
  getGroupLocks: (episodeId) =>
    request(`/generate/scene-groups/locks?episodeId=${encodeURIComponent(episodeId)}`),
  lockGrouping: (data) => request('/generate/scene-groups/locks', { method: 'POST', body: data }),
  unlockGrouping: (data) =>
    request('/generate/scene-groups/locks', { method: 'DELETE', body: data || {} }),
  getLayoutAnchor: (episodeId, group) =>
    request(`/generate/layout-anchor?episodeId=${encodeURIComponent(episodeId)}&group=${encodeURIComponent(group)}`, { timeout: QUERY_TIMEOUT_MS }),
  generateLayoutAnchor: (data) =>
    request('/generate/layout-anchor', { method: 'POST', body: data, timeout: LLM_LONG_TIMEOUT_MS }),
  setLayoutAnchorEnabled: (data) =>
    request('/generate/layout-anchor/toggle', { method: 'POST', body: data }),
  setAllLayoutAnchorEnabled: (data) =>
    request('/generate/layout-anchor/toggle-all', { method: 'POST', body: data }),
  getLayoutRoute: (episodeId) =>
    request(`/generate/layout-route?episodeId=${encodeURIComponent(episodeId)}`, { timeout: QUERY_TIMEOUT_MS }),
  getSceneOutPlan: (episodeId) =>
    request(`/generate/scene-out-plan?episodeId=${encodeURIComponent(episodeId)}`, { timeout: QUERY_TIMEOUT_MS }),
  deleteLayoutAnchor: (data) =>
    request(`/generate/layout-anchor?episodeId=${encodeURIComponent(data.episodeId)}&group=${encodeURIComponent(data.group)}`, { method: 'DELETE' }),
  uploadLayoutAnchor: (data) =>
    request('/generate/layout-anchor/upload', { method: 'POST', body: data }),
  getLayoutAnchorHistory: (episodeId, group) =>
    request(`/generate/layout-anchor/history?episodeId=${encodeURIComponent(episodeId)}&group=${encodeURIComponent(group)}`),
  restoreLayoutAnchor: (data) =>
    request('/generate/layout-anchor/restore', { method: 'POST', body: data }),
  getAssetImageHistory: (params) => request(`/generate/asset-image/history?type=${params.type}&id=${params.id}`),
  restoreAssetImage: (data) => request('/generate/asset-image/restore', { method: 'POST', body: data }),
  saveExtractInfo: (episodeId, assetsScriptFp) =>
    request(`/episodes/${episodeId}/extract-info`, { method: 'POST', body: { assetsScriptFp } }),
  generateBlocking: (data) => request('/generate/blocking', { method: 'POST', body: data, timeout: LLM_TIMEOUT_MS }),

  getTask: (taskId) => request(`/tasks/${taskId}`),

  getLibraryAssets: (type, page = 1, size = 32, keyword = '', source = 'library') =>
    request(`/library-assets?type=${type}&page=${page}&size=${size}&keyword=${encodeURIComponent(keyword)}&source=${source}`),
  uploadLibraryAsset: (type, name, imageBase64) =>
    request('/library-assets/upload', { method: 'POST', body: { type, name, imageBase64 } }),
  deleteLibraryAsset: (id) =>
    request(`/library-assets/${id}`, { method: 'DELETE' }),
  updateLibraryAsset: (id, data) =>
    request(`/library-assets/${id}`, { method: 'PUT', body: data }),
  getLibraryAssetItems: (clusterKey) =>
    request(`/library-assets/items?clusterKey=${encodeURIComponent(clusterKey)}`),


  uploadCharacterAudio: (episodeId, characterId, audioBase64) =>
    request(`/episodes/${episodeId}/characters/${characterId}/audio`, { method: 'POST', body: { audioBase64 } }),
  deleteCharacterAudio: (episodeId, characterId) =>
    request(`/episodes/${episodeId}/characters/${characterId}/audio`, { method: 'DELETE' }),

  getStyles: () => request('/styles'),
  createStyle: (data) => request('/styles', { method: 'POST', body: data }),
  updateStyle: (key, data) => request(`/styles/${encodeURIComponent(key)}`, { method: 'PATCH', body: data }),
  deleteStyle: (key) => request(`/styles/${encodeURIComponent(key)}`, { method: 'DELETE' }),

  getModelConfig: () => request('/model-config'),
  getModelImageOptions: () => request('/model-config/image-models'),
  getAvailableModels: (refresh = false) =>
    request(`/model-config/available-models${refresh ? '?refresh=1' : ''}`),
  updateModelAccount: (key, data) =>
    request(`/model-config/account/${encodeURIComponent(key)}`, { method: 'PUT', body: data }),
  updateModelText: (data) => request('/model-config/text', { method: 'PUT', body: data }),
  createModelEntry: (data) => request('/model-config/entries', { method: 'POST', body: data }),
  updateModelEntry: (id, data) =>
    request(`/model-config/entries/${encodeURIComponent(id)}`, { method: 'PUT', body: data }),
  deleteModelEntry: (id) =>
    request(`/model-config/entries/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  setModelEntryDefault: (id) =>
    request(`/model-config/entries/${encodeURIComponent(id)}/default`, { method: 'POST', body: {} }),
  testModelConnection: (target) =>
    request('/model-config/test-connection', { method: 'POST', body: { target }, timeout: CONNECT_TEST_TIMEOUT_MS }),

  getProjectCharacters: (projectId) => request(`/project-characters?projectId=${projectId}`),
  updateProjectCharacter: (id, data) => request(`/project-characters/${id}`, { method: 'PUT', body: data }),
  syncProjectCharacter: (id) => request(`/project-characters/${id}/sync`, { method: 'POST' }),
  deleteProjectCharacter: (id) => request(`/project-characters/${id}`, { method: 'DELETE' }),

  getIpCharacters: () => request('/ip-characters'),
  getIpProjectOptions: () => request('/ip-characters/projects'),
  createIpCharacter: (data) => request('/ip-characters', { method: 'POST', body: data }),
  updateIpCharacter: (id, data) => request(`/ip-characters/${id}`, { method: 'PUT', body: data }),
  deleteIpCharacter: (id) => request(`/ip-characters/${id}`, { method: 'DELETE' }),
  applyIpCharacter: (id, payload) => request(`/ip-characters/${id}/apply`, { method: 'POST', body: payload }),
  promoteToIpCharacter: (projectCharacterId) =>
    request('/ip-characters/promote', { method: 'POST', body: { projectCharacterId } }),
  uploadIpAudio: (id, audioBase64) => request(`/ip-characters/${id}/audio`, { method: 'POST', body: { audioBase64 } }),
  deleteIpAudio: (id) => request(`/ip-characters/${id}/audio`, { method: 'DELETE' }),
}
