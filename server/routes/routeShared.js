// generate-*.js 三个路由的公共运行时辅助（2026-09-19 去重）。
//
// 存在理由：buildAssetContextForPrompt / persistRemoteAsset / updateTask / dedupeAssets /
// isFurniture / filterFurnitureProps 这 6 个函数原本在 generate-script.js、
// generate-image.js、generate-post.js 里各存一份**逐字节相同**的拷贝——
// 「改一处不生效」的典型：修了 script 里的家具过滤，image 那边照旧把家具当道具。
// 与之同源的还有两个常量：
//   · FRAME_DUAL_KEYFRAME_SEC —— 只在 generate-image.js 被使用，另两处是死声明；
//   · runningFullTasks（/full 防重入锁）—— 全项目只有 generate-script.js 的
//     `router.post('/full')` 用它，另两处是死变量。二者均收口到本模块，单点定义。
//
// ⚠️ 与 ai/shared.js 的分工：那边是**纯函数**工具（无 IO、无 DB），可独立单测；
//    本模块依赖 DB（execute/queryOne）与网络下载（insecureDownload），只给路由层用。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { queryOne, execute } from '../db.js'
import { insecureDownload } from '../ai/runninghub.js'
import { routeIp, buildCharacterContext, resolveExplicitCharacters } from '../ai/ipRouter.js'

/** server/uploads 绝对路径（三个路由原本各算一次，结果相同）。 */
export const uploadsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'uploads')
fs.mkdirSync(uploadsDir, { recursive: true })

/**
 * 分镜图自动出图规则（无需配置，按镜头自带时长自动判定）：
 * - 长镜（时长 ≥ 本阈值）：动作有过程，出 2 张「首帧 + 尾帧」，分别锁定动作起始与结束状态，
 *   作为视频工作流的起止锚点（主图=首帧 frame_url，候选=尾帧 frame_url2）
 * - 短镜（时长 < 本阈值）：动作单一，只出 1 张代表画面（frame_url），不再出同拍双候选
 */
export const FRAME_DUAL_KEYFRAME_SEC = 7

/**
 * 一键生成（/full）进行中的集（episodeId 字符串集合）：
 * 同一集同时只允许一个 /full 任务，防止两个任务交错删插分镜/资产互相覆盖。
 * 唯一消费点是 generate-script.js 的 `router.post('/full')`。
 */
export const runningFullTasks = new Set()

/**
 * 资产定位 → 编剧上下文。
 * 前端确认过角色时传 characterIds（显式指定，直接用）；
 * 没传则自动路由，仅高置信（主题里点了角色名）才注入，绝不瞎绑。
 * 定位失败不挡生成流程 —— 最坏情况回到裸主题生成，与改造前行为一致。
 */
export async function buildAssetContextForPrompt(prompt, episodeId, characterIds = null) {
  try {
    if (Array.isArray(characterIds) && characterIds.length) {
      const resolved = resolveExplicitCharacters(characterIds)
      if (resolved.characters.length) {
        return buildCharacterContext(resolved.characters, resolved.ip)
      }
    }
    const ep = queryOne('SELECT project_id FROM episodes WHERE id = ?', [episodeId])
    const route = await routeIp(String(prompt || ''), { projectId: ep?.project_id })
    if (route.confidence === 'high' && route.characters.length) {
      return buildCharacterContext(route.characters, route.ip)
    }
    return ''
  } catch (e) {
    console.warn('[ip-route] 资产定位失败，按裸主题生成:', e.message)
    return ''
  }
}

/**
 * 下载 RunningHub 生成产物到本地，返回可直接存库的 /uploads/ 路径；
 * 失败时返回原 URL（退化为 24h 有效）。
 * server/uploads：资产图落本地（RunningHub 输出 URL 仅 24h 有效，落盘后永久可用）
 */
export async function persistRemoteAsset(url, filename) {
  if (!url || url.startsWith('/uploads/')) return url
  try {
    const buf = await insecureDownload(url)
    fs.writeFileSync(path.join(uploadsDir, filename), buf)
    return `/uploads/${filename}`
  } catch (e) {
    console.warn(`[persistRemoteAsset] 落本地失败（${filename}），保留原 URL:`, e.message)
    return url
  }
}

/** 更新任务状态（updates 里对象值统一 JSON 序列化后落库）。 */
export function updateTask(taskId, updates) {
  const fields = []
  const values = []
  for (const [key, value] of Object.entries(updates)) {
    fields.push(`${key} = ?`)
    values.push(typeof value === 'object' ? JSON.stringify(value) : value)
  }
  values.push(taskId)
  execute(`UPDATE tasks SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, values)
}

/**
 * 资产去重：同名/近似同名（去除标点空格后一致）只保留第一条，
 * 兼容字符串与对象格式（keyFn 负责取键）。
 */
export function dedupeAssets(list, keyFn) {
  if (!Array.isArray(list)) return list || []
  const seen = new Set()
  const result = []
  for (const item of list) {
    const raw = keyFn(item)
    if (!raw) continue
    const norm = String(raw).replace(/[\s，。！？、,.\s]/g, '').toLowerCase()
    if (!norm || seen.has(norm)) continue
    seen.add(norm)
    result.push(item)
  }
  return result
}

/**
 * 大型固定家具属于场景陈设而非独立道具：若提取为道具，
 * 场景生图会把家具排除出画面、镜头又会画出来，两边互相打架。
 * 判据：名称包含关键词，且长度不超过「关键词 + 2」（防「沙发抱枕」被误判成沙发）。
 */
const FURNITURE_KEYWORDS = [
  '沙发', '茶几', '电视', '柜子', '桌子', '椅子', '书架', '衣柜', '餐桌',
  '地毯', '窗帘', '冰箱', '空调', '楼梯', '地板', '天花板', '台灯', '吊灯',
  '凳子', '床头柜', '鞋柜', '橱柜', '灶台',
]

export function isFurniture(name) {
  const n = String(name || '').trim()
  return FURNITURE_KEYWORDS.some((kw) => {
    const k = kw.trim()
    return k && n.includes(k) && n.length <= k.length + 2
  })
}

/** 家具类道具从 props 中剔除，并同步清掉场景关联里的对应名称。 */
export function filterFurnitureProps(assets) {
  if (Array.isArray(assets?.props)) {
    assets.props = assets.props.filter((p) => {
      const name = typeof p === 'string' ? p : p.name
      return !isFurniture(name)
    })
  }
  if (Array.isArray(assets?.scenes)) {
    for (const s of assets.scenes) {
      if (Array.isArray(s.props)) {
        s.props = s.props.filter((n) => !isFurniture(n))
      }
    }
  }
  return assets
}
