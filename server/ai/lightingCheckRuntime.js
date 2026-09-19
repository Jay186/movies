// 冷暖自洽校验的**运行时接线**（2026-09-18）
//
// 为什么单独一个文件：
//   ai/assetQuality.js 是纯工厂（零 import、可注入 mock 测试）。
//   但真实运行时需要把三样东西接起来：LLM（chatCompletion）、DB（query/queryOne/execute）、
//   以及**缓存键里的模型档位标识**。这段接线若在 episodes.js 与 generate-script.js 各写一份，
//   就必然出现「改了这里忘了那里」——本项目已经踩过多次这类静默失效。
//   故收敛到此处单点，两个路由都 import 这里的实例。
//
// ⚠️ 模型档位标识的计算（modelKey）：
//   判定走 chatCompletion 的**轻任务分级**（task='lighting-check' 命中 config.storyboard.lightTasks
//   → 走 config.llm.lightModel）。因此"实际用哪个模型"取决于配置，不能硬编码。
//   modelKey 用「档位名 + 模型名」表达，任一变化都会让缓存失效重判——
//   这正是我们要的语义：换模型可能换结论，不能复用旧结论。

import { config } from '../config.js'
import { query, queryOne, execute } from '../db.js'
import { chatCompletion } from './doubao.js'
import { createLightingCheck, LIGHTING_TASK } from './assetQuality.js'

/** 判定任务名（与 config.storyboard.lightTasks 里登记的一致），同时作为 ai_calls 归属标记。 */
export { LIGHTING_TASK }

/**
 * 算出当前的判决档位标识。
 * 命中轻任务分级 → `light:<lightModel>`；否则 → `main:<model>`。
 * 这样"把 lighting-check 从 lightTasks 里删掉"也会让缓存失效（因为档位变了）。
 *
 * ⚠️ 这个串**只用于缓存键**，绝不作为模型名传给 LLM——模型选路交给 chatCompletion 的分级。
 *   初版把它当 model 传下去，导致拿 'light:qwen3.8-flash' 当模型名请求 → 404 → 全程降级。
 */
function currentModelKey() {
  const lightTasks = new Set(config.storyboard?.lightTasks || [])
  const light = config.llm?.lightModel
  if (lightTasks.has(LIGHTING_TASK) && light) return `light:${light}`
  return `main:${config.llm?.model || 'unknown'}`
}

/**
 * 构造（并缓存）运行时可用的校验器。
 * 之所以懒构造 + 记忆化：config 在进程启动后即固定，但测试/自检可能改 env 后重新 import。
 */
let _instance = null
let _instanceKey = ''

export function getLightingCheck() {
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

/**
 * 落库后校验一批场景并记录告警。**供路由在事务之外调用**。
 *
 * 设计要点：
 * 1. 逐个判定（工厂内部串行），避免并发打爆额度闸门。
 * 2. 整体 try/catch：本函数是"后置增强"，任何故障都不该让场景保存请求失败。
 * 3. 每条告警都带 sceneId —— 这是上一版最大的缺陷：告警不带 scene_id，
 *    前端所有按场景过滤的展示路径都看不到它（详见 ai/alerts.js 的 scene 维度说明）。
 *
 * @param {Array<{name:string, summary:string, lightingEn:string, sceneId:number|null}>} items
 * @param {number} episodeId
 * @param {Function} recordAlert - 注入 alerts.js 的 recordAlert（避免本模块反向依赖路由）
 * @returns {Promise<{checked:number, conflicts:number, degraded:number}>}
 */
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
      // check 内部已降级，这里只是双保险
      console.warn('[lightingCheck] 场景判定异常（已跳过）:', e.message)
    }
  }
  if (stat.checked) {
    console.log(`[lightingCheck] ep${episodeId}: 判定 ${stat.checked} 场，冲突 ${stat.conflicts}，降级 ${stat.degraded}`)
  }
  return stat
}
