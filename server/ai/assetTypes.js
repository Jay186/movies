// 资产类型枚举（共享常量，2026-09-17）
//
// 为什么单独成文件：`asset_states.asset_type` 的取值集合要同时被三处引用——
//   ① schema.sql 的 CHECK 约束（字面写死，SQL 层无法 import）；
//   ② ai/assetState.js 的判据；
//   ③ routes/episodes.js 的状态继承。
// 若三处各写一份字符串数组，任何一处增删都会静默漂移（本项目 hasExplicitReposition
// 三处重复的教训）。故抽成单点常量，JS 侧一律 import。
//
// ⚠️ 与 schema.sql 的 `CHECK(asset_type IN ('character','scene','prop'))` 必须同步：
//    改这里必须同步改 schema 的 CHECK（SQL 无法 import JS 常量，只能人工对齐 + 静态断言）。

export const ASSET_TYPES = ['character', 'scene', 'prop']
