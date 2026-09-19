// 进度阶段注册表（2026-09-16）
//
// 解决的问题：阶段名（phase）此前是三处独立的硬编码——后端 ai/doubao.js 里散落字符串字面量、
// 路由层又写一份、前端 SbProgressBar.vue 再维护一份"英文 phase → 中文标签"的映射表。
// 后果：后端改名或新增阶段时，前端不会报错，只是标签**静默消失**（显示空白），
// 这类失效最难发现。
//
// 设计：本表是阶段名的唯一真源。每条记录 = { name（程序用） + label（人看） }。
//   - 后端上报时只写 PHASE.XXX（常量引用，拼错立刻 ReferenceError）
//   - 上报 payload 同时带 phase 与 phaseLabel，前端**直接用后端给的中文**，不再自己映射
//   - 新增阶段只改这一个文件，前后端同时生效
//
// 未登记的处理：progressBus 收到未登记的 phase 时，phaseLabel 填 phase 原值兜底——
// 宁可显示一个英文串，也不要显示空白（空白让人以为"没在跑"）。这保证了"绝不静默消失"。

/**
 * 阶段定义。name 是稳定的程序标识（不要随文案改动），label 是可改的展示文案。
 * 顺序无意义，但建议按任务的生命周期排列，便于阅读。
 */
export const PHASE = {
  // ---- 通用 ----
  START: 'start',            // 任务已受理，准备资源
  PREPARE: 'prepare',        // 准备阶段（读资产、拼上下文）
  DONE: 'done',              // 终态

  // ---- 从剧本创作分镜 ----
  SCENES: 'scenes',          // 分场生成（阶段 1）
  AIRLOCK: 'airlock',        // 跨场画面衔接修补（阶段 2）
  SINGLE: 'single',          // 剧本未分场，整本一次生成

  // ---- 从文件规整分镜 ----
  NORMALIZE: 'normalize',    // 规整结构
  RETRY: 'retry',            // 首次格式有误，自动重试

  // ---- 补全镜头提示词 ----
  ENRICH: 'enrich',          // 逐镜补全提示词
  AXIS: 'axis',              // 补全后的越轴巡检
}

/**
 * phase → 中文标签。前端渲染阶段徽章时读这个值（由上报 payload 透传）。
 * 新增阶段务必在这里补一条；缺失时自动兜底为 phase 原值（见 labelOfPhase）。
 */
const PHASE_LABEL = {
  [PHASE.START]: '准备中',
  [PHASE.PREPARE]: '准备中',
  [PHASE.DONE]: '已完成',

  [PHASE.SCENES]: '分场生成',
  [PHASE.AIRLOCK]: '画面衔接',
  [PHASE.SINGLE]: '整本生成',

  [PHASE.NORMALIZE]: '结构规整',
  [PHASE.RETRY]: '自动重试',

  [PHASE.ENRICH]: '提示词补全',
  [PHASE.AXIS]: '越轴巡检',
}

/**
 * 取阶段的中文标签。未登记的 phase 返回原值兜底（绝不返回空串，避免标签静默消失）。
 * @param {string} phase
 * @returns {string}
 */
export function labelOfPhase(phase) {
  const key = String(phase || '')
  if (!key) return ''
  return PHASE_LABEL[key] || key
}

/** 全部已登记阶段（供测试校验"代码里用到的 phase 都已登记"）。 */
export function allPhases() {
  return Object.values(PHASE)
}
