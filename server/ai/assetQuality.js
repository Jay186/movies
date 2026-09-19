// 资产质量后置校验（2026-09-16 建；2026-09-18 重写为 LLM 判定）
//
// ===== 本轮重写的理由（重要，勿回退）=====
// 初版用四个**内容词表正则**判断冷暖（COLD_ENV / WARM_ENV / COLD_LIGHT / WARM_LIGHT），
// 这**直接违反本项目「零题材词表、零内容正则」铁律**，且已在真实数据上产生误报：
//
//   实测 server/data.db 的 ep4 场6「森林高地巨岩」被判冲突，原文是：
//     summary  : …远处雪峰已成天边一线。夕阳把整片森林染成蜜色，岩下湖泊闪着金光…
//     lighting : warm golden sunset light from the west, honey-colored glow over the forest…
//   这两句**完全自洽**（都是暖调夕阳），却因为 summary 里"远处雪峰"的「雪」字被
//   判定为"冷环境"→ 报冲突。判据抓的是**远景里的一个名词**，而非场景的整体色调语义。
//
// 根因：冷暖是**语义判断**，而"雪/雾/冰"在中文里既可能是环境主调，也可能只是远处背景。
//   词表无法区分「暴雪悬崖」与「暖阳下一线雪峰」——这正是铁律要求交给 LLM 的那类判断。
//
// 现在的做法：把判定整体交给 LLM（与 layoutReview.js / frameReview.js 同范式），
//   代码只负责"拼 prompt + 调模型 + 解析 JSON + 落缓存 + 降级"。
//   换题材、换语言、换成写实/科幻/黑白一律不需要改这里。
//
// ===== 架构约束 =====
// 纯工厂 + 依赖注入：模块**自身不 import db.js / doubao.js**，
//   所有副作用经 deps 注入，因此测试可注入 mock LLM 与 :memory: SQLite，零网络、零真实库。
//
// ===== 降级铁律 =====
// LLM 未注入 / 无模型 / 调用抛错 / JSON 解析失败 → 一律返回 conflict=false（不告警），
//   **绝不阻断场景写入主流程**。降级时 verdict 记为 null，与"判定过且无冲突"(false) 区分开，
//   便于日后统计"有多少次其实没判成"。

import crypto from 'node:crypto'

/** 判定结论的闭集。模型返回闭集外的值一律收敛为 unknown（不告警）。 */
export const LIGHTING_VERDICTS = ['consistent', 'conflict', 'insufficient']

/**
 * 判定任务名。它同时是两件事的键：
 *   ① chatCompletion 的 usageContext.task —— 决定走哪档模型（见 config.storyboard.lightTasks）
 *   ② 计费/审计归属（ai_calls 表）
 * 与 ai/lightingCheckRuntime.js 的 LIGHTING_TASK 同值，那边 import 此处以免散落两份字符串。
 */
export const LIGHTING_TASK = 'lighting-check'

/**
 * 对「进入判定的两样东西」取指纹。
 * 只取 summary + lighting_en —— 因为只有这两样参与判定；
 * 改场景名、改道具不该让判定缓存失效。
 *
 * 顺序无关不需要处理（这里就是两个固定字段，非集合）；
 * 但要 trim：末尾多个空格不该产生新指纹、白跑一次付费调用。
 * 两边都空则返回 ''（表示无从判定，调用方据此跳过）。
 *
 * @param {string} summary
 * @param {string} lightingEn
 * @returns {string} md5 hex，或空串
 */
export function lightingFingerprint(summary, lightingEn) {
  const s = String(summary == null ? '' : summary).trim()
  const l = String(lightingEn == null ? '' : lightingEn).trim()
  if (!s || !l) return ''
  return crypto.createHash('md5').update(s + '\u0001' + l).digest('hex')
}

/**
 * 从模型返回的原文里解析判定结果。脏输入一律降级（不误杀）。
 * 独立导出以便测试（纯函数，无网络）。
 *
 * @param {string} raw
 * @returns {{verdict:string, reason:string}}
 */
export function parseLightingVerdict(raw) {
  const fallback = { verdict: 'unknown', reason: '' }
  try {
    const m = String(raw || '').match(/\{[\s\S]*\}/)
    if (!m) return fallback
    const parsed = JSON.parse(m[0])
    const v = String(parsed.verdict || '').trim().toLowerCase()
    // 闭集收敛：模型返回闭集外的值 → unknown（不告警），不猜
    if (!LIGHTING_VERDICTS.includes(v)) return fallback
    return { verdict: v, reason: String(parsed.reason || '').slice(0, 300) }
  } catch {
    return fallback
  }
}

/**
 * 构造判定 prompt。独立导出以便测试断言"prompt 里不含任何题材词表"。
 *
 * 设计要点：**不告诉模型任何具体题材词**（不举例"雪/冰是冷"），
 *   只描述"要判断的是整体色调语义"，把词汇知识留给模型自己。
 *   若在这里举例，等于把词表搬进 prompt，换题材时同样会失效。
 *
 * @param {string} summary
 * @param {string} lightingEn
 * @returns {string}
 */
export function buildLightingPrompt(summary, lightingEn) {
  return `你是影视美术指导，负责检查一条**场景设定**的内部自洽性。

一条场景设定由两部分组成：
1. 【场景描述】用中文写的这场戏的画面内容与氛围。
2. 【光影常量】用英文写的一段光照描述，它会被逐字复用到这场戏所有镜头的出图/出片提示词里。

请判断：这两者描述的**整体色调与光照氛围**是否互相矛盾。

【场景描述】
${summary}

【光影常量】
${lightingEn}

判断时请注意：
- 要看**整体主调**，不要因为描述里提到一个远处的、次要的、或作为背景一笔带过的元素就改变结论。
  例如"暖阳下远处山脊有一线积雪"的整体主调是**暖**，不是冷。
- 光影常量里也可能出现环境名词（如 snow / mist）却仍是暖调（如 sunlit），
  要以**色温与光质**为准，不要被单个名词带走。
- 若两段描述谈的根本不是同一个场景、或信息不足以判断色调，判 insufficient。
- 只有确实存在**整体色调方向相反**的矛盾（如通篇冷冽风雪 vs 温暖金色阳光）才判 conflict。

输出严格 JSON（不要任何其他文字）：
{"verdict":"consistent|conflict|insufficient","reason":"若判 conflict，用一句中文说明矛盾点；否则空串"}`
}

/**
 * 创建冷暖校验器（纯工厂）。
 *
 * @param {Object} deps
 * @param {Function} [deps.llm]           LLM 调用，签名 (messages, options) => Promise<string>
 * @param {string}   [deps.cacheKey]      **缓存键里的判定档位标识**（如 'light:qwen3.8-flash'）。
 *                                        ⚠️ 它**只是缓存身份**，绝不作为模型名传给 LLM——
 *                                        模型选路由 chatCompletion 按 usageContext.task 分级决定。
 *                                        初版把它当 model 传下去，chatCompletion 优先用显式 model，
 *                                        于是拿 'light:qwen3.8-flash' 当模型名请求 → 404 → 全程降级。
 * @param {Function} [deps.queryOne]      (sql, params) => row|null
 * @param {Function} [deps.query]         (sql, params) => rows
 * @param {Function} [deps.execute]       (sql, params) => void
 * @param {boolean}  [deps.useCache=true] 是否启用缓存（测试可关）
 * @returns {{check: Function, checkMany: Function}}
 */
export function createLightingCheck(deps = {}) {
  const {
    llm = null,
    cacheKey = '',
    queryOne = null,
    query = null,
    execute = null,
    useCache = true,
  } = deps || {}

  const cacheAvailable = useCache && !!queryOne && !!execute
  const llmAvailable = !!llm && !!cacheKey

  /** 读缓存。任何异常降级为"未命中"。 */
  function readCache(fp) {
    if (!cacheAvailable || !fp) return null
    try {
      return queryOne(
        'SELECT verdict, reason FROM lighting_checks WHERE fingerprint = ? AND model = ?',
        [fp, cacheKey]
      ) || null
    } catch (e) {
      console.warn('[assetQuality] 读冷暖判定缓存失败（当作未命中）:', e.message)
      return null
    }
  }

  /** 写缓存。任何异常只告警——缓存写失败不该影响判定结果。 */
  function writeCache(fp, verdict, reason) {
    if (!cacheAvailable || !fp) return
    try {
      execute(
        `INSERT INTO lighting_checks (fingerprint, model, verdict, reason, checked_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(fingerprint, model) DO UPDATE SET
           verdict = excluded.verdict,
           reason = excluded.reason,
           checked_at = excluded.checked_at`,
        [fp, cacheKey, verdict, reason, new Date().toISOString()]
      )
    } catch (e) {
      console.warn('[assetQuality] 写冷暖判定缓存失败（不影响判定）:', e.message)
    }
  }

  /**
   * 判定单个场景的冷暖自洽性。
   *
   * 返回值：
   *   { conflict: boolean, reason: string, verdict: 'consistent'|'conflict'|'insufficient'|null, cached: boolean }
   *
   * ⚠️ 三档语义：`verdict === null` 表示**没判成**（降级），与"判过且一致"不同。
   *   而 `conflict` 始终是安全的布尔值——降级时恒为 false，调用方无需判断 null 即可直接用于 if。
   *
   * @param {string} summary
   * @param {string} lightingEn
   * @param {Object} [opts] { episodeId, sceneId } 仅用于 LLM 计费归属与日志
   */
  async function check(summary, lightingEn, opts = {}) {
    const s = String(summary == null ? '' : summary).trim()
    const l = String(lightingEn == null ? '' : lightingEn).trim()
    // 任一为空 → 无从判定。这不是降级，是"不适用"（与初版行为一致）
    if (!s || !l) return { conflict: false, reason: '', verdict: 'insufficient', cached: false }

    const fp = lightingFingerprint(s, l)

    // 1) 缓存命中：零成本、零网络
    const hit = readCache(fp)
    if (hit) {
      const v = String(hit.verdict || '')
      return {
        conflict: v === 'conflict',
        reason: String(hit.reason || ''),
        verdict: LIGHTING_VERDICTS.includes(v) ? v : null,
        cached: true,
      }
    }

    // 2) LLM 未就绪 → 降级（不告警、不阻断），且**不写缓存**（免得把"没判成"固化成结论）
    if (!llmAvailable) {
      return { conflict: false, reason: '', verdict: null, cached: false }
    }

    // 3) 真正调用
    try {
      const raw = await llm(
        [{ role: 'user', content: buildLightingPrompt(s, l) }],
        {
          // ⚠️ 刻意**不传 model**：让 chatCompletion 按 usageContext.task='lighting-check'
          // 走 config.storyboard.lightTasks 的分级（→ lightModel），并可享受其
          // 「轻量模型失败自动回退主模型」重试。若在此显式传 model，会覆盖分级机制，
          // 且会把 cacheKey（一个标识串，非模型名）误当模型名发出去 → 404 → 全程降级。
          // 本模块只管"判什么"，"用哪个模型"是基础设施的事。
          temperature: 0.1,
          maxTokens: 400,
          responseFormat: { type: 'json_object' },
          usageContext: { episodeId: opts.episodeId, task: LIGHTING_TASK },
        }
      )
      const { verdict, reason } = parseLightingVerdict(raw)
      if (verdict === 'unknown') {
        // 模型返回了闭集外的值 → 降级，不写缓存（下次可重试）
        return { conflict: false, reason: '', verdict: null, cached: false }
      }
      writeCache(fp, verdict, reason)
      return {
        conflict: verdict === 'conflict',
        reason: verdict === 'conflict' ? reason : '',
        verdict,
        cached: false,
      }
    } catch (e) {
      // 判定故障（额度/网络/超时）绝不能影响场景写入 —— 降级为不冲突
      console.warn('[assetQuality] 冷暖判定失败，跳过（不影响写入）:', e.message)
      return { conflict: false, reason: '', verdict: null, cached: false }
    }
  }

  /**
   * 批量判定：一次处理整批场景，供落库方循环调用（内部串行，避免并发打爆额度）。
   * 返回与输入等长的数组，每项形如 check 的返回值，额外带 { name, sceneId }。
   *
   * @param {Array<{summary:string, lightingEn:string, name?:string, sceneId?:number}>} items
   * @param {Object} [opts] { episodeId }
   */
  async function checkMany(items, opts = {}) {
    const out = []
    for (const it of Array.isArray(items) ? items : []) {
      const r = await check(it?.summary, it?.lightingEn, {
        episodeId: opts.episodeId,
        sceneId: it?.sceneId,
      })
      out.push({ ...r, name: String(it?.name || ''), sceneId: it?.sceneId ?? null })
    }
    return out
  }

  return { check, checkMany, get cacheEnabled() { return cacheAvailable }, get llmEnabled() { return llmAvailable } }
}

// ===== 以下为**同步兼容层**（勿在新代码中使用）=====
// 初版 detectLightingConflict 是同步纯函数，被 episodes.js / generate-script.js 直接 import。
// 改造后判定需异步调 LLM，无法保持同步签名。为免"改了这里忘了那里"造成静默失效，
// 保留一个**恒不冲突**的同名导出：任何仍在用旧签名的调用点都会**安全地什么都不报**，
// 而不是 crash，也不是误报。真实调用点已迁移到 createLightingCheck（见两处 route）。
//
// ⚠️ 这个函数的存在是为兜底，不是为使用。若你在这里看到新调用，说明迁移漏了。
/**
 * @deprecated 已被 createLightingCheck 取代（异步、LLM 判定）。此处恒返回不冲突。
 */
export function detectLightingConflict() {
  return { conflict: false, reason: '', deprecated: true }
}
