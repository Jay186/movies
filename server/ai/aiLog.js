// AI 调用观测：把每次 LLM / RunningHub 调用落一条记录到 ai_calls 表。
// 设计原则：日志绝不阻塞或打断主业务流程——任何内部异常都吞掉只 console.warn，
// 避免"为了记日志把生成功能搞挂"的二次故障。
import { execute } from '../db.js'

/**
 * 记录一次 AI 调用到 ai_calls 表
 * @param {Object} r
 * @param {string} r.kind          - 'llm' | 'runninghub'
 * @param {string} [r.model]       - 模型名 / 工作流 key
 * @param {number} [r.episodeId]  - 关联集 id
 * @param {string} [r.task]        - 业务用途标签
 * @param {number} [r.inTokens]
 * @param {number} [r.outTokens]
 * @param {number} [r.frames]
 * @param {number} [r.latencyMs]
 * @param {boolean} [r.success]
 * @param {string} [r.errorFamily] - 错误家族：auth/rate_limit/timeout/server/content/cancelled/unknown
 * @param {string} [r.errorMsg]
 */
export function logAiCall(r = {}) {
  try {
    execute(
      `INSERT INTO ai_calls
        (kind, model, episode_id, task, in_tokens, out_tokens, frames, latency_ms, success, error_family, error_msg)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        r.kind || 'unknown',
        r.model || '',
        r.episodeId ?? null,
        r.task || '',
        r.inTokens ?? null,
        r.outTokens ?? null,
        r.frames ?? null,
        r.latencyMs ?? null,
        r.success ? 1 : 0,
        r.errorFamily || '',
        (r.errorMsg || '').slice(0, 500),
      ]
    )
  } catch (e) {
    // 日志失败不能影响业务，只告警
    console.warn('[aiLog] 记录失败（已忽略）:', e.message)
  }
}

/**
 * 错误家族分类：把底层错误归到有限几类，便于失败模式统计与前端差异化提示。
 * 返回 { family, message }，family 取值：
 *  - auth        401/403（Key 错或无权限）
 *  - rate_limit  429（限流，可重试）
 *  - timeout     超时/AbortError
 *  - server      5xx / 服务端异常
 *  - content     模型返回空内容或结构异常
 *  - cancelled   任务被用户取消
 *  - unknown     其它
 */
export function classifyError(err, httpStatus) {
  const msg = String(err?.message || err || '')
  // 免费额度耗尽：403 里最常见的一类，单独识别并给出明确提示（否则会被误报成"Key 错误"）
  if (/Free quota exhausted|额度|quota exhausted|AllocationQuota/i.test(msg)) {
    return { family: 'auth', message: '模型免费额度已耗尽，请充值或在 .env 切换到其它可用模型' }
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return { family: 'auth', message: 'AI 服务授权失败（API Key 错误或无权限），请联系管理员' }
  }
  if (httpStatus === 429 || /rate.*limit|429|too many|频率|限流/i.test(msg)) {
    return { family: 'rate_limit', message: 'AI 服务限流，请稍候重试' }
  }
  if (err?.name === 'AbortError' || /超时|timeout|abort/i.test(msg)) {
    return { family: 'timeout', message: 'AI 请求超时，请稍后重试' }
  }
  if (httpStatus >= 500 || /5\d\d|server|internal|bad gateway|service unavailable/i.test(msg)) {
    return { family: 'server', message: 'AI 服务暂时不可用，请稍后重试' }
  }
  if (/空内容|empty|解析失败|结构异常|截断/i.test(msg)) {
    return { family: 'content', message: msg }
  }
  if (/cancel|取消/i.test(msg)) {
    return { family: 'cancelled', message: '任务已取消' }
  }
  return { family: 'unknown', message: msg }
}
