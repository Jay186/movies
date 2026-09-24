
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
    label: '全能V5工作流',
    short: '全能V5',
    desc: 'MiniMax H3 全能生视频 V5 视频参考版 · 9参考图+3音色+Ref2VA视频续写+一采二采放大 · 5~15s',
    coinLow: 50,
    coinHigh: 110,
    workflowKey: null,
  },
]

export function getVideoEngine(value) {
  return VIDEO_ENGINES.find((e) => e.value === value) || VIDEO_ENGINES.find((e) => e.value === 'h3v4') || VIDEO_ENGINES[0]
}
