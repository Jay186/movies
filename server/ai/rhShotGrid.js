import { config } from '../config.js'
import { runWorkflow, uploadImageV2 } from './runninghub.js'

export async function generateShotGridApp({ prompt, refs = [], usageContext = {}, aspectRatio: aspectRatioOpt } = {}) {
  const workflowId = config.runninghub.workflows.shotGridApp
  const mapping = config.runninghub.nodeMap.shotGridApp
  if (!workflowId) return { success: false, error: 'RunningHub 四宫格 AI 应用（shotGridApp）未配置 id' }
  if (!mapping) return { success: false, error: 'RunningHub 四宫格 AI 应用（shotGridApp）未配置节点映射' }

  const aspectRatio = aspectRatioOpt || config.runninghub.shotGrid?.aspectRatio || '16:9'
  const resolution = config.runninghub.shotGrid?.resolution || '1k'

  const values = {}
  if (mapping.prompt && prompt) values.prompt = prompt
  if (mapping.aspectRatio) values.aspectRatio = aspectRatio
  if (mapping.resolution) values.resolution = resolution

  for (const r of refs) {
    if (!r?.slot || r.dup || !r?.url) continue
    const key = 'image' + r.slot
    if (!mapping[key]) {
      console.warn('[generateShotGridApp] 槽号超出 nodeMap 映射，跳过 slot=' + r.slot + ' name=' + r.name)
      continue
    }
    try {
      values[key] = await uploadImageV2(r.url)
    } catch (e) {
      console.error('[generateShotGridApp] 参考图上传失败 name=' + r.name + ':', e.message)
      return { success: false, error: `参考图(${r.name})上传失败: ${e.message}` }
    }
  }

  if (!Object.keys(values).some((k) => k.startsWith('image'))) {
    return { success: false, error: '本镜没有任何可用参考图（角色/场景/道具均无图），无法出四宫格；请先在资产库补齐角色/场景/道具图' }
  }

  if (!Object.keys(values).length) {
    return { success: false, error: 'RunningHub 四宫格 AI 应用未收到任何可填参数（无 prompt 槽、无参考图槽）' }
  }

  console.log('[generateShotGridApp] run ai-app', workflowId, '| slots:', Object.keys(values).join(','), '| refs:', refs.filter((r) => r.slot && !r.dup).map((r) => `${r.slot}:${r.type}(${r.name})`).join(' '))
  const result = await runWorkflow('shotGridApp', values, {
    usageContext: { task: 'shot-grid', ...usageContext },
    timeout: config.timeouts.workflow.poll, 
  })

  if (result.success && Array.isArray(result.allResults) && result.allResults.length > 1) {
    const pick = result.allResults.find((r) => {
      const u = String(r?.url || '').toLowerCase()
      const t = String(r?.outputType || r?.type || '').toLowerCase()
      if (u.endsWith('.zip') || t.includes('zip')) return false
      return /\.(png|jpe?g|webp)(\?|$)/.test(u)
    })
    if (pick?.url) {
      result.url = pick.url
      console.log('[generateShotGridApp] 多输出中选中整图:', pick.url.slice(0, 100))
    }
  }
  return result
}
