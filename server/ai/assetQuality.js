
import crypto from 'node:crypto'

export const LIGHTING_VERDICTS = ['consistent', 'conflict', 'insufficient']

export const LIGHTING_TASK = 'lighting-check'

export function lightingFingerprint(summary, lightingEn) {
  const s = String(summary == null ? '' : summary).trim()
  const l = String(lightingEn == null ? '' : lightingEn).trim()
  if (!s || !l) return ''
  return crypto.createHash('md5').update(s + '\u0001' + l).digest('hex')
}

export function parseLightingVerdict(raw) {
  const fallback = { verdict: 'unknown', reason: '' }
  try {
    const m = String(raw || '').match(/\{[\s\S]*\}/)
    if (!m) return fallback
    const parsed = JSON.parse(m[0])
    const v = String(parsed.verdict || '').trim().toLowerCase()
    if (!LIGHTING_VERDICTS.includes(v)) return fallback
    return { verdict: v, reason: String(parsed.reason || '').slice(0, 300) }
  } catch {
    return fallback
  }
}

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

  async function check(summary, lightingEn, opts = {}) {
    const s = String(summary == null ? '' : summary).trim()
    const l = String(lightingEn == null ? '' : lightingEn).trim()
    if (!s || !l) return { conflict: false, reason: '', verdict: 'insufficient', cached: false }

    const fp = lightingFingerprint(s, l)

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

    if (!llmAvailable) {
      return { conflict: false, reason: '', verdict: null, cached: false }
    }

    try {
      const raw = await llm(
        [{ role: 'user', content: buildLightingPrompt(s, l) }],
        {
          temperature: 0.1,
          maxTokens: 400,
          responseFormat: { type: 'json_object' },
          usageContext: { episodeId: opts.episodeId, task: LIGHTING_TASK },
        }
      )
      const { verdict, reason } = parseLightingVerdict(raw)
      if (verdict === 'unknown') {
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
      console.warn('[assetQuality] 冷暖判定失败，跳过（不影响写入）:', e.message)
      return { conflict: false, reason: '', verdict: null, cached: false }
    }
  }

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

