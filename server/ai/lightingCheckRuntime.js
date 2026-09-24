
import { config } from '../config.js'
import { query, queryOne, execute } from '../db.js'
import { chatCompletion } from './doubao.js'
import { createLightingCheck, LIGHTING_TASK } from './assetQuality.js'

export { LIGHTING_TASK }

function currentModelKey() {
  const lightTasks = new Set(config.storyboard?.lightTasks || [])
  const light = config.llm?.lightModel
  if (lightTasks.has(LIGHTING_TASK) && light) return `light:${light}`
  return `main:${config.llm?.model || 'unknown'}`
}

let _instance = null
let _instanceKey = ''

function getLightingCheck() {
  const key = currentModelKey()
  if (_instance && _instanceKey === key) return _instance
  _instanceKey = key
  _instance = createLightingCheck({
    llm: chatCompletion,
    cacheKey: key,
    query,
    queryOne,
    execute,
    useCache: true,
  })
  return _instance
}

export async function runLightingChecks(items, episodeId, recordAlert) {
  const list = Array.isArray(items) ? items : []
  const stat = { checked: 0, conflicts: 0, degraded: 0 }
  if (!list.length || typeof recordAlert !== 'function') return stat
  const checker = getLightingCheck()
  if (!checker.llmEnabled) return stat

  for (const it of list) {
    try {
      const r = await checker.check(it?.summary, it?.lightingEn, { episodeId, sceneId: it?.sceneId })
      stat.checked++
      if (r.verdict == null) stat.degraded++
      if (r.conflict) {
        stat.conflicts++
        recordAlert({
          level: 'warn',
          source: 'asset-lighting',
          episodeId,
          sceneId: it?.sceneId ?? null,
          sceneNumber: it?.sceneNumber != null ? String(it.sceneNumber) : '',
          message: `场景光影常量与描述可能冲突：${it?.name || ''} — ${r.reason}`,
        })
      }
    } catch (e) {
      console.warn('[lightingCheck] 场景判定异常（已跳过）:', e.message)
    }
  }
  if (stat.checked) {
    console.log(`[lightingCheck] ep${episodeId}: 判定 ${stat.checked} 场，冲突 ${stat.conflicts}，降级 ${stat.degraded}`)
  }
  return stat
}
