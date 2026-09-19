// 后端 API 客户端封装
const BASE = '/api'

// 默认请求超时：60s，覆盖 CRUD/查询类快接口（可通过 options.timeout 覆盖，毫秒）
const DEFAULT_TIMEOUT_MS = 60000
// 单次或两次串行 LLM 文本调用：编剧(auto 模式=意图分类30s+生成/改写300s)、
// 改稿、视频提示词整改、站位调度、IP 路由。glm-5.2 为思考型模型，6000 token 剧本
// 常超 60s，按后端最长单链路(分类30s+生成300s+格式兜底)加余量给 8 分钟，
// 让后端有机会正常返回（含自身 LLM 超时后回 500），而不是被前端提前 abort
const LLM_TIMEOUT_MS = 480000
// 多次串行 LLM：分镜按场次 N×300s、资产提取重试 180s×2、enrich 逐镜 180s×N，
// 单次同步等待可能很久，给 25 分钟兜住常见多场/多镜剧本
const LLM_LONG_TIMEOUT_MS = 1500000
// 进度轮询类短请求（分镜提取进度等）：1~2s 一次，超时给 5s——慢请求快速失败，避免轮询堆积
const POLL_TIMEOUT_MS = 5000

async function request(path, options = {}) {
  // 超时控制：AbortController 中断挂起的请求，避免后端无响应时前端无限等待
  const timeoutMs = Number(options.timeout) > 0 ? Number(options.timeout) : DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  // 外部取消（用户主动取消生成等）：外部 signal abort 时联动中断请求
  const onExternalAbort = () => controller.abort()
  if (options.signal) {
    if (options.signal.aborted) onExternalAbort()
    else options.signal.addEventListener('abort', onExternalAbort)
  }
  let res
  try {
    // 可选鉴权：后端设置了 API_TOKEN 时，用户在 localStorage 存 api_token 即自动携带
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
    // fetch 在 abort 时抛 AbortError，区分"用户主动取消"与"超时"
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
  // 后端异常时可能返回空 body 或 HTML，直接 res.json() 会抛出难懂的
  // "Unexpected end of JSON input"，这里统一转成可读错误
  const text = await res.text()
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`服务返回异常 (${res.status})，请查看后端日志`)
  }
  if (!res.ok) {
    // [2026-09-18] 401 未授权：广播全局事件，App.vue 弹出访问令牌输入框，
    // 用户粘贴令牌保存后自动刷新重试（无需手动开控制台写 localStorage）
    if (res.status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('wb:unauthorized'))
    }
    throw new Error(data.error || `请求失败 (${res.status})`)
  }
  return data
}

export const api = {
  // 项目
  getProjects: () => request('/projects'),
  getProject: (id) => request(`/projects/${id}`),
  createProject: (data) => request('/projects', { method: 'POST', body: data }),
  updateProject: (id, data) => request(`/projects/${id}`, { method: 'PUT', body: data }),
  deleteProject: (id) => request(`/projects/${id}`, { method: 'DELETE' }),
  getProjectAssets: (id, type) => request(`/projects/${id}/assets${type ? `?type=${type}` : ''}`),

  // 集
  getEpisodes: (projectId) => request(`/episodes/project/${projectId}`),
  getEpisode: (id) => request(`/episodes/${id}`),
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

  // AI 生成
  generateFull: (data) => request('/generate/full', { method: 'POST', body: data }),
  // auto 模式串行两次 LLM（意图分类 + 生成/改写），glm-5.2 思考型模型易超 60s
  generateScript: (data) => request('/generate/script', { method: 'POST', body: data, timeout: LLM_TIMEOUT_MS }),
  // 创作主题 → 定位资产库角色（编剧前的预路由）
  ipRoute: (data) => request('/generate/ip-route', { method: 'POST', body: data, timeout: LLM_TIMEOUT_MS }),
  rewriteScript: (data) => request('/generate/script-rewrite', { method: 'POST', body: data, timeout: LLM_TIMEOUT_MS }),
  generateAssets: (data) => request('/generate/assets', { method: 'POST', body: data, timeout: LLM_LONG_TIMEOUT_MS }),
  generateStoryboard: (data) => request('/generate/storyboard', { method: 'POST', body: data, timeout: LLM_LONG_TIMEOUT_MS }),
  // 分镜提取进度轮询（2026-09-15）：提取期间按 BATCH_GEN.STORYBOARD_PROGRESS_POLL_MS 拉取，回显"第几场/共几场"
  getStoryboardProgress: (episodeId) =>
    request(`/generate/storyboard-progress?episodeId=${encodeURIComponent(episodeId)}`, { timeout: POLL_TIMEOUT_MS }),
  // 导入分镜时可选「AI 智能解析」：把已读出的分镜内容交给规整型 LLM 提取为标准镜头结构
  extractStoryboardFromFile: (data) => request('/generate/storyboard-from-file', { method: 'POST', body: data, timeout: LLM_LONG_TIMEOUT_MS }),
  // 按场出 2x2 四宫格分镜图（一次出 4 镜分镜图，覆写各 shot.frame_url）
  // 单张 2K 出图 1-2 分钟，给 10 分钟兜底
  generateSceneGrid: (data) => request('/generate/scene-grid', { method: 'POST', body: data, timeout: 600000 }),
  // 单镜头 2x2 四宫格分镜图（每镜一张：4 格 = 同一镜头的 4 个时间瞬间）
  generateShotGrid: (data) => request('/generate/shot-grid', { method: 'POST', body: data, timeout: 600000 }),
  // 查询四宫格任务状态（running/failed）：镜头卡片显示生成中/失败，刷新页面后可恢复
  getShotGridJobs: () => request('/generate/shot-grid/status'),
  // 生图（单图）：gpt-image-2 图生图并行出 2 张候选，正常 1-5 分钟；
  // 60s 默认超时会提前 abort 弹"请求超时"假失败（后端仍会跑完落库），给 10 分钟兜住
  generateImage: (data) => request('/generate/image', { method: 'POST', body: data, timeout: 600000 }),
  // 查询服务端正在生成的单图任务（刷新页面后恢复 loading 遮罩）
  getImageJobsInflight: () => request('/generate/image/inflight'),
  // 单镜打斗出片（MinimaxH3 八月最强打斗武戏 workflow）：纯动作镜头，豆包生成电影级打斗提示词 + 3战斗LoRA + 两轮采样
  generateVideoCombat: (data) => request('/generate/video-v3', { method: 'POST', body: data, timeout: 900000 }),
  // 全能生视频 V4 工作流（9 参考图 + 3 音色 + Ref2VA）；2026-09-13 时长上限放宽到 15s，
  // server 轮询 20 分钟，前端对齐（先掐断会弹"请求超时"假失败，后端实际仍会跑完回写）
  generateVideoV4: (data) => request('/generate/video-v4', { method: 'POST', body: data, timeout: 1200000 }),
  // 查询服务端正在跑的"打斗工作流"出片任务
  getVideoV3JobsInflight: () => request('/generate/video-v3/inflight'),
  // 查询服务端正在跑的"全能V4工作流"出片任务
  getVideoV4JobsInflight: () => request('/generate/video-v4/inflight'),
  // 保存至成片：把该集所有已生成镜头视频按顺序拼接为一个完整 mp4
  // data: { episodeId, fade, bgm }
  //   fade: true=智能转场（默认，同场次硬切/跨场次文戏叠化/动作戏硬切）
  //         false=全硬切 / 'all'=全叠化（旧行为，应急）
  //   bgm: uploads/bgm/ 下的音频文件名（可选）
  // 返回体含 transitions { policy, dissolveCount, cutCount, dissolveSeconds }
  composeVideo: (data) => request('/generate/video/compose', { method: 'POST', body: data, timeout: 600000 }),
  // BGM 音频清单（server/uploads/bgm/ 下的文件）
  getBgmList: () => request('/generate/bgm-list'),
  // 系统告警（2026-09-13）：出片后置钩子链失败可见化。params: { episodeId, includeResolved }
  getAlerts: (params = {}) => {
    const qs = []
    if (params.episodeId != null) qs.push(`episodeId=${params.episodeId}`)
    if (params.includeResolved) qs.push('includeResolved=1')
    return request(`/generate/alerts${qs.length ? '?' + qs.join('&') : ''}`)
  },
  // 处置告警：传 id 处置单条，或传 shotId 处置某镜全部
  resolveAlert: (data) => request('/generate/alerts/resolve', { method: 'POST', body: data }),
  // ===== 段级出片 + 切片回填（E 路线 v2，2026-09-15）=====
  // 段级出片：一段一任务，H3 单次生成上限 15s（单镜最长也 15s，故 1~5 镜拼一段）。
  // 后端串行轮询 + 出片后自动按镜边界切片回填，全程 2~6 分钟，给 20 分钟兜住
  // （与 generateVideoV4 同口径：先掐断会弹"请求超时"假失败，后端实际仍会跑完回写）
  generateVideoSegment: (segmentId) =>
    request(`/generate/video-segment/${segmentId}`, { method: 'POST', body: {}, timeout: 1200000 }),
  // 段方案预览/落库：{ persist, replace }。persist=false 只算不写；replace=true 时已出片段保留
  saveEpisodeSegments: (episodeId, data = {}) =>
    request(`/episodes/${episodeId}/segments`, { method: 'POST', body: data }),
  // 段方案是否已过期（镜表指纹失配）。用于在出片前主动提示「该重算了」，
  // 而不是等切片那一刻才发现（那时币已烧）。口径与切片器同源。
  getSegmentsStaleness: (episodeId) =>
    request(`/episodes/${episodeId}/segments/staleness`),
  // 补切片：段成片已在、切片缺失时按镜边界重切。
  // force=true 忽略磁盘上旧切片强制重切（段重出后必须 force，否则卡片播旧切片）
  sliceEpisodeSegments: (episodeId, data = {}) =>
    request(`/episodes/${episodeId}/segments/slice`, { method: 'POST', body: data }),
  // ===== 成片删除（清空镜头成片，磁盘文件移入服务端回收站，不物理删，可手工找回）=====
  // 单镜删除：清空该镜 video_url。若该镜的视频来自段切片，后端会连带整段一起清理
  // （段是生成包装层，一段成片被删则该段所有镜的切片同时失效，否则会留下"文件已不在"的死切片）。
  // 返回：{ ok, episodeId, shots:[{id,shotNumber}], segments:[{id,sceneNumber,segmentIndex,shotNumbers,shotIds}], movedFiles, skipped:[{shotId,reason}] }
  deleteShotVideo: (episodeId, shotId) =>
    request(`/episodes/${episodeId}/shots/${shotId}/video`, { method: 'DELETE' }),
  // 批量删除：一次提交多个镜号，后端做段联动去重（同段多镜只清一次段）。返回结构与单镜一致。
  deleteShotsVideo: (episodeId, shotIds) =>
    request(`/episodes/${episodeId}/shots/video-delete`, { method: 'POST', body: { shotIds } }),
  // 资产图：单张 gpt-image-2 生成也可能超 60s，同样给 10 分钟
  generateAssetImage: (data, options = {}) => request('/generate/asset-image', { method: 'POST', body: data, timeout: 600000, signal: options.signal }),
  // 场景空间分组（2026-09-18）：批量生图前端调度用，{ groups: { [sceneId]: { group, role, sceneNumber, hasImage } } }
  // 首次调用可能触发 LLM 全集分析（之后指纹命中即秒回），故给 120s；超时由 store 降级为全串行。
  getSceneSpatialGroups: (episodeId) =>
    request(`/generate/scene-spatial-groups?episodeId=${encodeURIComponent(episodeId)}`, { timeout: 120000 }),
  // 空间组审核状态（组视图数据源）：groups/pending 等。首次可能触发 LLM 全集分析（与
  // getSceneSpatialGroups 同档），故给 120s；失败由 SettingsView 降级回平铺视图（降级铁律）。
  getSpatialGroupReviewStatus: (episodeId) =>
    request(`/generate/spatial-group-review/status?episodeId=${encodeURIComponent(episodeId)}`, { timeout: 120000 }),
  // 显式同步/重置（常规流程无需调用；P2-2 重开审核用）。reset='pending' 回退全部组并清 baseline。
  initSpatialGroupReview: (data) => request('/generate/spatial-group-review/init', { method: 'POST', body: data }),
  // 确认/跳过：confirm 写 spatial 锚行；skip 删锚行（KD6）。服务端一律取代表场当前定稿图，不采信前端传图。
  decideSpatialGroupReview: (data) => request('/generate/spatial-group-review/decide', { method: 'POST', body: data }),
  // ===== 分组人审锁定（2026-09-17）=====
  // 动机：spatial_group 由 LLM 逐次自由裁量，重析会重组已验证的组结构，使已确认的组锚变孤儿
  // （实测 4 组→2 组，人审基线静默失效）。锁 = 把「某场归某组」固化成数据，重析时复用。
  // 三个端点都只读写锁、**不触发重析**（锁与重析解耦），失败一律由调用方降级（看不到锁 ≠ 功能不可用）。
  // 查：{ locks:[{sceneId,sceneNumber,group,note}], orphanAnchors:[{group,image,confirmed}] }
  getGroupLocks: (episodeId) =>
    request(`/generate/scene-groups/locks?episodeId=${encodeURIComponent(episodeId)}`),
  // 锁：把**当前**分组状态整体锁住（幂等）。返回 { locked, locks, orphanAnchors }
  lockGrouping: (data) => request('/generate/scene-groups/locks', { method: 'POST', body: data }),
  // 解锁：sceneIds 省略/为空 → 解除该集全部；否则只解指定场
  unlockGrouping: (data) =>
    request('/generate/scene-groups/locks', { method: 'DELETE', body: data || {} }),
  // ===== 布局示意图锚（A3，2026-09-18）=====
  // 动机：人审参考图是一张**照片**，同时携带视角/光影/画风/主体占比。让模型"继承它但别照搬构图"
  // 天然矛盾（视角塌陷与"场2被场1覆盖重画"两次事故都长在这）。布局图只表达
  // 「什么在什么位置、朝向、距离比例」，不含视角/光影/画风，因此可被组内所有视角无冲突继承。
  //
  // 注：组视图渲染不需要逐组调 getLayoutAnchor —— 布局图锚已并入
  // getSpatialGroupReviewStatus 的每组 layoutAnchor 字段（一次请求带全，免 N+1）。
  // 本方法留给"单独查某组最新布局图"的场景（如生成后刷新单卡）。
  getLayoutAnchor: (episodeId, group) =>
    request(`/generate/layout-anchor?episodeId=${encodeURIComponent(episodeId)}&group=${encodeURIComponent(group)}`, { timeout: 120000 }),
  // 生成/重画布局图（幂等 upsert）。服务端含"生成→视觉质检→仅对检出问题针对性重试"闭环，
  // 最多 MAX_LAYOUT_ATTEMPTS 版，故给 25 分钟兜住整条链路（与其它多次串行生图同档）。
  generateLayoutAnchor: (data) =>
    request('/generate/layout-anchor', { method: 'POST', body: data, timeout: LLM_LONG_TIMEOUT_MS }),
  // 形象版本历史：查询（character 挂项目库主设定）
  getAssetImageHistory: (params) => request(`/generate/asset-image/history?type=${params.type}&id=${params.id}`),
  // 恢复历史版本：图 + 描述快照一起回滚
  restoreAssetImage: (data) => request('/generate/asset-image/restore', { method: 'POST', body: data }),
  // 登记资产提取指纹：三类资产全部保存成功后由前端调用（指纹登记与落库解耦，避免 stale 假阴性）
  saveExtractInfo: (episodeId, assetsScriptFp) =>
    request(`/episodes/${episodeId}/extract-info`, { method: 'POST', body: { assetsScriptFp } }),
  generateBlocking: (data) => request('/generate/blocking', { method: 'POST', body: data, timeout: LLM_TIMEOUT_MS }),

  // ===== 分镜质检（2026-09-16）=====
  // 质检报告聚合：把分镜校验器跑出的 errors/warnings 按 code 分组（含 level/title/hint/fixLabel/
  // actions/命中镜头号），前端据此渲染质检面板。includeIgnored=1 时连"已确认忽略"的项一并返回。
  getQcReport: (episodeId, includeIgnored = false) =>
    request(`/generate/qc-report?episodeId=${encodeURIComponent(episodeId)}${includeIgnored ? '&includeIgnored=1' : ''}`),
  // 批量修复：body { episodeId, code, shots? }。shots 省略 = 修该 code 下全部镜头。
  // 后端按 code 对应的 action 分流（补 Airlock 衔接 / 补走位动作 / 重抽分镜图 / 仅人工）
  qcFix: (data) => request('/generate/qc-fix', { method: 'POST', body: data, timeout: LLM_LONG_TIMEOUT_MS }),
  // 人工确认忽略：把某 code 在某镜上的问题标记为"已知且接受"，不再出现在报告里（可撤销）
  qcIgnore: (data) => request('/generate/qc-ignore', { method: 'POST', body: data }),
  qcUnignore: (data) => request('/generate/qc-unignore', { method: 'POST', body: data }),
  getQcIgnores: (episodeId) => request(`/generate/qc-ignores?episodeId=${encodeURIComponent(episodeId)}`),

  // 任务
  getTask: (taskId) => request(`/tasks/${taskId}`),

  // 资产库
  getLibraryAssets: (type, page = 1, size = 32, keyword = '', source = 'library') =>
    request(`/library-assets?type=${type}&page=${page}&size=${size}&keyword=${encodeURIComponent(keyword)}&source=${source}`),
  uploadLibraryAsset: (type, name, imageBase64) =>
    request('/library-assets/upload', { method: 'POST', body: { type, name, imageBase64 } }),
  deleteLibraryAsset: (id) =>
    request(`/library-assets/${id}`, { method: 'DELETE' }),
  updateLibraryAsset: (id, data) =>
    request(`/library-assets/${id}`, { method: 'PUT', body: data }),
  // 素材详情图（同一 cluster 的多机位/多视角图）
  getLibraryAssetItems: (clusterKey) =>
    request(`/library-assets/items?clusterKey=${encodeURIComponent(clusterKey)}`),


  // 角色音频上传/删除
  uploadCharacterAudio: (episodeId, characterId, audioBase64) =>
    request(`/episodes/${episodeId}/characters/${characterId}/audio`, { method: 'POST', body: { audioBase64 } }),
  deleteCharacterAudio: (episodeId, characterId) =>
    request(`/episodes/${episodeId}/characters/${characterId}/audio`, { method: 'DELETE' }),

  // 画风库（存本地数据库）
  getStyles: () => request('/styles'),
  // 新建自定义画风（落到"我的风格"分类；后端会做敏感词过滤、长度校验与封面 base64 落盘）
  // 入参：{ label, prompt, coverBase64? }；返回 { ok, id, style }
  createStyle: (data) => request('/styles', { method: 'POST', body: data }),
  // 编辑自定义画风（仅限 USER 来源）；入参：{ label?, prompt?, emoji?, coverBase64? }；返回 { ok, style }
  updateStyle: (key, data) => request(`/styles/${encodeURIComponent(key)}`, { method: 'PATCH', body: data }),
  // 删除自定义画风（仅限 USER 来源）；返回 { ok, key }
  deleteStyle: (key) => request(`/styles/${encodeURIComponent(key)}`, { method: 'DELETE' }),

  // 项目级角色库（IP 角色跨集共享）
  getProjectCharacters: (projectId) => request(`/project-characters?projectId=${projectId}`),
  updateProjectCharacter: (id, data) => request(`/project-characters/${id}`, { method: 'PUT', body: data }),
  syncProjectCharacter: (id) => request(`/project-characters/${id}/sync`, { method: 'POST' }),
  deleteProjectCharacter: (id) => request(`/project-characters/${id}`, { method: 'DELETE' }),

  // 全局 IP 角色库（跨项目共享）
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
