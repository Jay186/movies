// 前端运行时常量唯一来源。
// 背景：src/stores/project.js 单文件 2000+ 行承担 8 个职责，轮询间隔、storage key、
// 默认文案等散落各处且重复（如 8000ms 轮询写了 3 份、AI 欢迎语写了 2 遍）。
// 这里集中收口：要调轮询速度 / 改默认项目名 / 换 storage key，只改本文件。
// 业务数据源（画风 prompt、引擎元数据）不在本文件——它们各自有权威来源：
//   画风 prompt → 后端 /api/styles（style_presets 表）
//   引擎元数据 → src/data/videoEngines.js

/** localStorage 键名（集中登记，避免各处裸字符串互相撞车） */
export const STORAGE_KEYS = {
  CURRENT_PROJECT: 'story-current-project-id',
  EPISODE_SELECTION: 'wb_last_episode_selection',
  PENDING_ASSET_GENS: 'wb_pending_asset_gens',
  IMAGE_MODEL: 'assetImageModel',
  VIDEO_MODEL: 'shotVideoModel',
}
/** 按集动态拼接的 key 前缀（后面接 episodeId） */
export const STORAGE_KEY_PREFIX = {
  EXTRACT_FP: 'extract-fp-',
  STORYBOARD_FP: 'storyboard-fp-',
}

/** 轮询配置：刷新后恢复"生成中"任务状态用的定时轮询 */
export const POLL = {
  INTERVAL_MS: 8000,
  // 各类任务的轮询次数上限（超时即放弃恢复，避免永久遮罩）
  MAX_POLLS: {
    IMAGE_JOB: 40,
    SHOT_GRID: 45,
    VIDEO_JOB: 60,
  },
}

/** 超时与重试 */
export const TIMEOUTS = {
  ASSET_GEN_MS: 15 * 60 * 1000, // 资产生图兜底超时
}
export const DELAYS = {
  LOAD_RETRY_MS: 1200, // 后端瞬时故障（重启/抖动）时的重载退避
  POLL_ERROR_RETRY_MS: 3000, // 轮询报错后的退避
  FULL_GEN_ERROR_STREAK: 10, // 一键全流程：连续失败多少次才停下
  RESULT_BANNER_MS: 5000, // 操作结果提示条（如"补全完成：N 条"）自动消失时长
}

/** 批量生成（分镜图 / 站位图）的并发与重试：调吞吐只改这里 */
export const BATCH_GEN = {
  IMAGE_CONCURRENCY: 5, // 同时生成的分镜图 / 站位图数量（前端 worker 池大小）
  FRAME_RETRY: 1, // 分镜图生成失败自动重试次数（站位图整场调用成本高，固定不重试）
  STORYBOARD_PROGRESS_POLL_MS: 1500, // 分镜提取期间的进度轮询间隔
  // 长任务进度条在"已完成"后保留多久再消失（毫秒）。
  // 需大于轮询间隔，让人看得见收尾结论；太短则"刚完成就没了"。
  // 后端进度缓存保活时长见 server/config.js 的 progress.ttlAfterDoneMs。
  PROGRESS_CLEAR_AFTER_MS: 6000,
}

/** 新建项目/空态时的展示默认值（demo 遗留，接真实配置后可移除） */
export const DEFAULTS = {
  PROJECT_TITLE: '布布与一二的野日记',
  EPISODE_THEME: '做美食',
  ART_STYLE: '吉卜力风格',
  EMPTY_SUMMARY: '（暂无摘要）',
  // AI 编剧欢迎语：初始化与清空对话两处共用，保持同一份
  AI_GREETING: '你可以先输入创作想法，我来生成剧本；也可以先导入剧本，再继续告诉我怎么修改。',
  // 项目级默认宽高比：剧集、生图、出片链路统一沿用。
  // 布哥 2026-09-11 定调：当前项目（一二布布系列）默认竖屏 9:16（短剧发布平台形态）。
  // 枚举与 server/ai/v4Video.js 的 VIDEO_ASPECT_RATIOS 对齐；要扩展比例必须同步改后端白名单。
  ASPECT_RATIO: '9:16 (Portrait Widescreen)',
}

/** 项目级比例枚举：UI 下拉与后端白名单共用。键名对齐 RunningHub 工作流枚举原值，
 *  改任何一个值都需要在 server/ai/* 里同步更新 VIDEO_ASPECT_RATIOS 数组，否则会被静默回落。
 *  默认 9:16（竖屏短剧），9:16 排在第一项。 */
export const ASPECT_RATIO_OPTIONS = [
  { value: '9:16 (Portrait Widescreen)', label: '9:16', desc: '竖屏' },
  { value: '16:9 (Widescreen)', label: '16:9', desc: '横屏' },
  { value: '21:9 (Ultrawide)', label: '21:9', desc: '宽银幕' },
  { value: '1:1 (Square)', label: '1:1', desc: '方形' },
  { value: '4:3 (Standard)', label: '4:3', desc: '横向' },
  { value: '3:4 (Portrait Standard)', label: '3:4', desc: '竖向' },
]

/**
 * 画风兜底占位（仅首屏/后端风格库拉取失败时使用）。
 * 注意：prompt 一律留空——真实文案以后端 style_presets 为准。
 * 早期这里硬编码了一份吉卜力 prompt，与后端表里的写法不一致（"安静治愈系/纹理"
 * vs "宫崎骏原生/肌理"），导致同一项目在不同时机生成的图风格文案不同。
 */
export const FALLBACK_STYLE = {
  key: 'ghibli',
  label: '吉卜力风格',
  labelEn: 'Studio Ghibli Style',
  emoji: '',
  prompt: '',
  category: '2d',
}
