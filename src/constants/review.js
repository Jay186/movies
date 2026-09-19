// 生成前置门禁 / 人审基准图 · 共享枚举（前端，2026-09-17）
//
// 为什么单独成文件（与 server/ai/anchorTypes.js 同因）：
//   审核状态串在**服务端**（写库 + 判定）与**前端**（渲染 + 比较）各出现一次，
//   前端无法 import 服务端模块（构建边界），若两边各写一份字面量，任何一处改名都会
//   静默漂移——表现是「弹窗永远显示未审 / 确认后按钮不消失」这类只在运行时暴露的怪象。
//   故：各层单点声明，跨层一致性由静态断言守护（见 server/_qa_spatial_review.mjs
//   的「枚举同串」断言——与 assetTypes.js 对 schema.sql CHECK 的处置同式）。
//
// ⚠️ 改动本枚举必须同步 server/ai/anchorTypes.js 的 REVIEW_STATUS，并跑
//    node server/_qa_spatial_review.mjs 确认同串断言仍绿。

/** 空间组审核状态（与 DB 列值、API 响应、服务端枚举三处同串） */
export const REVIEW_STATUS = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  SKIPPED: 'skipped',
}

/** 未决状态集合：处于其中任一即视为「还没人审过」 */
export const REVIEW_STATUSES_UNDECIDED = [REVIEW_STATUS.PENDING]

/** 人审决策动作（POST /decide 的 action 取值，与服务端 REVIEW_ACTION 同串） */
export const REVIEW_ACTION = {
  CONFIRM: 'confirm',
  SKIP: 'skip',
}
