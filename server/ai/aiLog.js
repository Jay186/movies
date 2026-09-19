import { execute } from '../db.js'

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
    console.warn('[aiLog] 记录失败（已忽略）:', e.message)
  }
}

export function classifyError(err, httpStatus) {
  const msg = String(err?.message || err || '')
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
