// AI 模型配置抽屉：内置建议值与全部文案
// 约束：模型名 / 地址等业务与环境信息不得散落硬编码在组件里，统一收敛到本文件。

// 账号键（与后端 model-config 路由的 :key 一致）：三条用途通道，各自独立配置
export const ACCOUNT_KEYS = ['text', 'image', 'video']

// 账号区静态展示信息（名称 / 角色描述 / 能力区块为界面配置；接口地址与 Key 一律走接口）
// caps 决定该账号卡渲染哪些能力区块：text / image / video
// 文本通道只关联文本模型；生图通道只关联生图条目；视频通道代表 RunningHub 工作流（含出图工作流）
export const ACCOUNT_META = {
  text: { name: '文本通道', role: '文本大模型 · 剧本 / 分镜 / 资产 / 翻译 / 质检', baseUrlReadonly: false, caps: ['text'] },
  image: { name: '生图通道', role: '生图模型 · 角色 / 场景 / 道具 / 分镜帧', baseUrlReadonly: false, caps: ['image'] },
  video: { name: '视频通道', role: 'RunningHub 工作流 · 出片 / 出图', baseUrlReadonly: true, caps: ['video'] },
}

// 文本大模型降级兜底建议值：仅当「可用模型」接口失败且列表为空时作为候选展示，仍允许自由填写
export const TEXT_MODEL_SUGGESTIONS = [
  'glm-5.3',
  'claude-sonnet-5',
  'deepseek-v4.1-flash',
  'gpt-5.5',
  'kimi-k3',
]

// 视频通道工作流「适用引擎」选项：决定后端套用哪套 nodeMap 节点映射
// 标签即用途：出片（打斗 / 全能）与出图（分镜网格）共用 video 通道
export const VIDEO_WORKFLOW_KEYS = [
  { value: 'h3Combat', label: '打斗' },
  { value: 'h3V4vc', label: '全能V5' },
  { value: 'shotGridApp', label: '分镜网格出图' },
]

export function videoWorkflowKeyLabel(key) {
  return VIDEO_WORKFLOW_KEYS.find((o) => o.value === key)?.label || ''
}

// 条目类型元信息：capTitle/capNote/capRight 为设计稿的分区标题与说明
export const ENTRY_KINDS = {
  image: {
    kind: 'image',
    label: '生图模型',
    capTitle: '生图模型',
    capNote: '角色 / 场景 / 道具 / 分镜帧',
    capRight: '可配多个，生成时可选',
    idLabel: '模型 ID',
    idPlaceholder: 'gpt-image-2',
  },
  video: {
    kind: 'video',
    label: 'RunningHub 工作流',
    capTitle: 'RunningHub 工作流',
    capNote: '出片（打斗 / 全能）/ 出图（分镜网格）· 按 RunningHub 计费',
    capRight: '可配多个，出片 / 出图时可选',
    addLabel: '＋ 添加工作流',
    idLabel: 'Workflow ID',
    idPlaceholder: '工作流 ID',
  },
}

export const MODEL_CONFIG_TEXT = {
  drawerTitle: 'AI 模型配置',
  drawerSubtitle: '三条通道各自配置：文本大模型 · 生图模型 · RunningHub 工作流',
  closeAria: '关闭模型配置',

  baseUrlLabel: '接口地址',
  baseUrlFixed: '固定',
  apiKeyLabel: 'API Key',
  keyShow: '显示',
  keyHide: '隐藏',
  keyRequired: '请填写 API Key',

  testConnection: '测试连接',
  testing: '测试中…',

  textCapTitle: '文本模型',
  textCapNote: '剧本 / 分镜 / 资产 / 翻译 / 三道质检闸',
  textCapRight: '全局只生效一个',
  textModelHint: '可选可填',
  textModelPlaceholder: '填入模型 ID',
  visionLabel: '该模型支持图片输入',
  visionHint: '不勾选 = 三道视觉质检闸静默跳过，不报错',

  rowSetDefault: '设为默认',
  rowEdit: '编辑',
  rowRemove: '删除',
  rowEnable: '启用',
  rowDisable: '停用',
  badgeDefault: '默认',
  badgeDisabled: '已停用',

  modalSubtitle: 'Key 与接口地址沿用账号设置，这里只填模型',
  modalCancel: '取消',
  modalSave: '保存',
  modalSaving: '保存中…',
  fieldName: '名称',
  fieldNamePlaceholder: '如：GPT-Image 2',
  fieldEngine: '适用引擎',

  loading: '正在加载模型配置…',
  emptyEntries: '还没有配置，点下面的按钮添加一条',
  // 生图条目改为「下拉选中即添加」，空态与占位文案单独一套
  imageEmptyEntries: '还没有配置，从下方下拉选择模型添加',
  imageAddPlaceholder: '下拉选择生图模型，选中即添加',
  imageAddFallback: '＋ 手动填写模型 ID',
  imageAlreadyAdded: (name) => `「${name}」已在列表里，不用重复添加`,
  loadFailed: '模型配置加载失败',
  retry: '重试',
  unknownError: '未知错误',
  imageSelectPlaceholder: '模型配置加载中…',
  imageSelectEmpty: '无可用生图模型，请在 AI 模型配置中启用',

  // 可用模型选择器（文本 / 生图条目共用）：列表来自启明星模型广场，选型失败不阻塞手填
  modelPickerPlaceholder: '搜索或直接输入模型 ID',
  modelPickerLoading: '正在获取可用模型…',
  modelPickerEmpty: '暂无可用模型',
  modelPickerFailed: (detail) => `可用模型获取失败：${detail}`,
  modelPickerManualHint: '仍可手动输入',
  modelPickerNoMatch: '无匹配模型',
  // 副行信息：平台 · 分组 · 官方价 ×倍率（倍率含义明确，不做单价换算）
  modelPricePrefix: '官方价',
  modelGroupsMore: (n) => `另有 ${n} 个分组`,

  // 状态点文案
  statusIdle: '未测试',
  statusTesting: '探测中…',
  statusOk: '连通正常',
  statusOkRunningHub: 'Key 有效',
  statusErr: '连接失败',

  // 提示与错误
  accountSaved: '接口地址已保存',
  accountSaveFailed: '接口地址保存失败',
  keySaved: 'API Key 已保存',
  keySaveFailed: 'API Key 保存失败',
  textModelSaved: '文本模型已保存',
  textModelSaveFailed: '文本模型保存失败',
  visionOn: '已开启视觉能力',
  visionOff: '已关闭视觉能力（三道视觉质检闸将静默跳过）',
  entryAdded: (name) => `已添加「${name}」`,
  entryUpdated: (name) => `「${name}」已保存`,
  entrySaveFailed: '保存失败',
  entryRemoved: (name) => `已删除「${name}」`,
  entryRemoveFailed: '删除失败',
  entryEnabled: (name) => `已启用「${name}」`,
  entryDisabled: (name) => `已停用「${name}」（不再出现在生图下拉里）`,
  entryToggleFailed: '切换启用状态失败',
  defaultSet: (name) => `已将「${name}」设为默认`,
  defaultSetFailed: '设置默认失败',
  deleteConfirmTitle: (name) => `删除「${name}」？`,
  deleteConfirmDesc: '删除后该项不再出现在选择列表里，已生成的图片不受影响。',
  nameRequired: '请填写名称',
  modelIdRequired: '请填写模型 ID',
  workflowIdRequired: '请填写 Workflow ID',
  engineRequired: '请选择适用引擎',
  // RunningHub 连接测试是轻量探测，必须讲清楚不计费、不跑工作流
  testOk: (label, latencyMs, isRunningHub) => {
    const lat = Number.isFinite(Number(latencyMs)) ? `${latencyMs}ms` : '—'
    return isRunningHub
      ? `${label} 连接正常 · Key 有效 · ${lat}（仅轻量探测，未运行工作流、未消耗计费）`
      : `${label} 连接正常 · ${lat}`
  },
  testFail: (label) => `${label} 连接失败`,
  runningHubFootNote: '仅支持已适配节点映射的工作流（nodeMap 为代码资产）；测试仅验证 Key，不消耗计费、不运行工作流。',
}
