// 出片引擎的单一事实源。
// 新增引擎 = 在这张表里加一条：kind 决定走哪条生成链路（general / combat），
// 前端调度、下拉、计费展示、默认值全部由数据驱动，业务代码不动。

export const VIDEO_ENGINE_KIND = {
  GENERAL: 'general',
  COMBAT: 'combat',
}

export const VIDEO_ENGINES = [
  {
    value: 'combat',
    kind: VIDEO_ENGINE_KIND.COMBAT,
    label: '打斗工作流',
    short: '打斗',
    desc: '武戏专用工作流 · 打斗镜头提示词 + 两轮采样',
    coinLow: 60,
    coinHigh: 120,
    workflowKey: 'h3Combat',
  },
  {
    value: 'h3v4',
    kind: VIDEO_ENGINE_KIND.GENERAL,
    label: '全能V5工作流',
    short: '全能V5',
    desc: '通用出片工作流 · 多参考图 + 音色 + 视频续写 + 二次采样放大',
    coinLow: 50,
    coinHigh: 110,
    workflowKey: 'h3V4vc',
    isDefault: true,
  },
]

// 默认引擎由数据标记决定，新增引擎只改上面这张表
export const DEFAULT_VIDEO_ENGINE = VIDEO_ENGINES.find((e) => e.isDefault) || VIDEO_ENGINES[0]

export function getVideoEngine(value) {
  return VIDEO_ENGINES.find((e) => e.value === value) || DEFAULT_VIDEO_ENGINE
}

// 计费文案：有区间写区间，没有就退化成中性表述（不暴露供应商名）
export function engineCostText(eng) {
  if (!eng) return ''
  if (eng.coinLow != null && eng.coinHigh != null) return `约 ${eng.coinLow}~${eng.coinHigh} 币/条`
  return '按所选引擎计费'
}
