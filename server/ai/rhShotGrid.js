// rhShotGrid.js — RunningHub 单镜 2x2 四宫格分镜图调用（AI 应用版）
// 分镜页把生图渠道切到 RunningHub 后，镜头行"出四宫格"按钮走此模块。
// 2026-09-09 由布哥弃用旧 5 槽 workflow（2095734156394323970，见 git 历史），切到
// AI 应用 2048139846660657154（发布在 RunningHub 的 ai-app，经 /openapi/v2/run/ai-app/{id} 调用）：
//   输入：4 张参考图 LoadImage（nodeId 2/8/9/10 = 图1..图4）——通用资源池，由 allocateShotRefs
//         按优先级（出场角色 > 场景 > 道具）动态分配 slot 1..4，本模块按 refs[].slot 填 values['image'+slot]。
//         与旧版不同：空槽直接不上传（调用方 allocateShotRefs 传 fill=false，不做补位占满），
//         靠 prompt 首行"图N是X"文字声明兜底；一张参考图都没有时明确报错（无锚点出图无意义）。
//        + 剧情文本（nodeId 13 prompt）：buildShotGridContentApp 产出——首行"图1是女主、图2是男主、
//         图3是海滩…"（对齐 app 示例格式）+ 画风/统一设定/画面1..4 四时间瞬间硬锁描述。
//        + aspectRatio / resolution（nodeId 14，随 config.runninghub.shotGrid 覆盖）。
//   输出：整张 2x2 网格图（主输出），由调用方落盘为该镜 frame_url。
import { config } from '../config.js'
import { runWorkflow, uploadImageV2 } from './runninghub.js'

/**
 * 运行 RunningHub 单镜四宫格 AI 应用
 * @param {Object} opts
 * @param {string} opts.prompt  buildShotGridContentApp 产出的剧情/分镜文本（覆盖 nodeId 13）
 * @param {Array<{type:string,name:string,url:string,slot:number|null}>} [opts.refs]
 *        allocateShotRefs 产出的参考图分配结果：按 slot 填对应 imageN 槽（slot=null 或无图跳过）
 * @param {Object} [opts.usageContext] { episodeId, task } 透传给 aiLog 观测归集
 * @param {string} [opts.aspectRatio]  项目级宽高比的**短格式**（'9:16' / '16:9'，无括号后缀）；
 *        调用方（routes/generate.js /shot-grid）负责把 projects.aspect_ratio 归一成短格式再传。
 *        未传时回落 config.runninghub.shotGrid?.aspectRatio，再缺省 '16:9'。
 * @returns {Promise<{success: boolean, url?: string, taskId?: string, error?: string, raw?: Object}>}
 */
export async function generateShotGridApp({ prompt, refs = [], usageContext = {}, aspectRatio: aspectRatioOpt } = {}) {
  const workflowId = config.runninghub.workflows.shotGridApp
  const mapping = config.runninghub.nodeMap.shotGridApp
  if (!workflowId) return { success: false, error: 'RunningHub 四宫格 AI 应用（shotGridApp）未配置 id' }
  if (!mapping) return { success: false, error: 'RunningHub 四宫格 AI 应用（shotGridApp）未配置节点映射' }

  // 出图参数：比例 + 分辨率（AI 应用 nodeId 14 的枚举是短格式：16:9/9:16… 与 1k/2k/4k）。
  // 比例/分辨率可经 server/.env 的 RH_SHOT_GRID_ASPECT_RATIO / RH_SHOT_GRID_RESOLUTION 覆盖，
  // 也可由调用方按请求体（前端 project.aspect_ratio 归一后）按次覆盖——优先级：opts > env > 默认。
  const aspectRatio = aspectRatioOpt || config.runninghub.shotGrid?.aspectRatio || '16:9'
  const resolution = config.runninghub.shotGrid?.resolution || '1k'

  const values = {}
  if (mapping.prompt && prompt) values.prompt = prompt
  if (mapping.aspectRatio) values.aspectRatio = aspectRatio
  if (mapping.resolution) values.resolution = resolution

  // 参考图按 refs[].slot 填槽（refs 由 generate.js 调 allocateShotRefs 统一分配，与 prompt 首行
  // "图N是X"声明同源——图/文不漂移）。slot=null 或 dup（补位占位）不上传，空槽靠文字兜底；
  // 槽号超出 nodeMap 映射时告警跳过。
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

  // 兜底：一张参考图都没有时（角色/场景/道具全无图），无一致性锚点，直接返回明确错误提示先补齐美术资产。
  if (!Object.keys(values).some((k) => k.startsWith('image'))) {
    return { success: false, error: '本镜没有任何可用参考图（角色/场景/道具均无图），无法出四宫格；请先在资产库补齐角色/场景/道具图' }
  }

  if (!Object.keys(values).length) {
    return { success: false, error: 'RunningHub 四宫格 AI 应用未收到任何可填参数（无 prompt 槽、无参考图槽）' }
  }

  console.log('[generateShotGridApp] run ai-app', workflowId, '| slots:', Object.keys(values).join(','), '| refs:', refs.filter((r) => r.slot && !r.dup).map((r) => `${r.slot}:${r.type}(${r.name})`).join(' '))
  const result = await runWorkflow('shotGridApp', values, {
    usageContext: { task: 'shot-grid', ...usageContext },
    timeout: 600000, // 2x2 四宫格 + 云端排队，10 分钟兜底（与前端 api.generateShotGrid 一致）
  })

  // 多输出时挑"整张图"：优先选图片 url（跳过 zip 等非图输出；ai-app 若有多个 SaveImage 时
  // results[0] 不保证是整图，逻辑与旧 workflow 版保持一致）。
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
