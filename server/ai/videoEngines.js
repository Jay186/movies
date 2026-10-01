// 出片引擎标识的单一事实源。
// 新增引擎：在这里加一个常量 + 在 VIDEO_ENGINES 里登记，再到 generate-video.js
// 注册对应执行器；路由与任务队列不再出现裸字面量。
export const VIDEO_ENGINE_GENERAL = 'h3v4'
export const VIDEO_ENGINE_COMBAT = 'combat'

export const DEFAULT_VIDEO_ENGINE = VIDEO_ENGINE_GENERAL

export const VIDEO_ENGINES = [VIDEO_ENGINE_GENERAL, VIDEO_ENGINE_COMBAT]
