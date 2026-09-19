// 视频出片引擎注册表 —— 前端唯一引擎元数据源。
// 短片页/分镜页的单镜出片"用哪个引擎"由 store.videoModel 决定，此文件描述每个引擎的
// 展示文案与计费提示；UI（下拉框/确认框/底部说明）全部从这里取，不写死。
//
// 后续对接新出片 API（如其他视频大模型 / RunningHub 新工作流 / 自建服务）时：
//   1. 在此表追加一条（value 唯一、stable——会进 localStorage 与统计，别重用/改名）
//   2. store.generateShotVideoByModel 里加分发分支（或后端按 engine 路由）
//   3. 后端实现对应 route 即可，前端其余自动跟随

// workflowKey：后端 config.workflows 的键名。仅「同一后端接口不同工作流」的引擎需要填，
// 走独立接口（combat / h3v4）或旧版接口（standard）的留 null。
export const VIDEO_ENGINES = [
  {
    value: 'combat',
    label: '打斗工作流',
    short: '打斗',
    desc: 'H3 八月最强打斗武戏 · 3战斗LoRA + 豆包电影级打斗提示词 + 两轮采样 · 5~15s',
    coinLow: 60,
    coinHigh: 120,
    workflowKey: null,
  },
  {
    value: 'h3v4',
    label: '全能V4工作流',
    short: '全能V4',
    desc: 'MiniMax H3 全能生视频 V4 · 9参考图+3音色+Ref2VA+一采二采放大 · 5~15s',
    coinLow: 50,
    coinHigh: 110,
    workflowKey: null,
  },
]

/** 按 value 取引擎元数据；未知值回落第一个（standard），保证 UI 不因脏数据空白 */
export function getVideoEngine(value) {
  return VIDEO_ENGINES.find((e) => e.value === value) || VIDEO_ENGINES.find((e) => e.value === 'h3v4') || VIDEO_ENGINES[0]
}

/** 取引擎对应的后端工作流键名；无则返回空串（由后端用默认工作流） */
export function getWorkflowKey(value) {
  return getVideoEngine(value).workflowKey || ''
}
