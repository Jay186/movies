// 空间组人审基准图（第 3 / 3 层）路由：3 端点薄路由
//
// 设计依据：docs/anchor-review/02-incremental-design.md §2
// 挂载于 /api/generate（server/index.js: app.use('/api/generate', spatialGroupReviewRouter)）
//
// 所有 DB 依赖在此接线（运行时才 import 真实 db.js），服务层本身不依赖 db.js，
// 因此测试可注入 :memory: 库。日志前缀统一 [spatialGroupReview]（共享知识 9）。

import { Router } from 'express'
import { query, queryOne, execute } from '../db.js'
import { ensureSceneAnalysis, getLayoutAnchor, collectGroupLayoutMaterials, layoutMaterialsFingerprint } from '../ai/sceneAnchors.js'
import { createSpatialGroupReview } from '../ai/spatialGroupReview.js'

const router = Router()
// 注入真实实现（2026-09-18）：组视图每组带布局图锚 + 时效判断 → 前端布局图卡。
// 服务层保持纯工厂（可注入 :memory: 测试），DB 读取与素材汇总在这里接线。
const review = createSpatialGroupReview({
  query, queryOne, execute, ensureSceneAnalysis,
  getLayoutAnchor,
  layoutMaterialsForGroup: collectGroupLayoutMaterials,
  fingerprintOfMaterials: layoutMaterialsFingerprint,
})

// 校验 episode 是否存在（不存在 → 404）
function assertEpisode(episodeId, res) {
  const ep = queryOne('SELECT id FROM episodes WHERE id = ?', [episodeId])
  if (!ep) {
    res.status(404).json({ error: 'episode 不存在' })
    return false
  }
  return true
}

// 2.1 GET /status?episodeId=N —— 批量入口唯一前置调用（内部幂等 sync）
router.get('/spatial-group-review/status', async (req, res) => {
  const episodeId = Number(req.query.episodeId)
  if (!episodeId) return res.status(400).json({ error: 'episodeId 必填' })
  try {
    if (!assertEpisode(episodeId, res)) return
    const data = await review.getSpatialGroupReviewStatus(episodeId)
    res.json(data)
  } catch (e) {
    console.error('[spatialGroupReview] GET /status 失败:', e.message)
    res.status(e.status || 500).json({ error: e.message })
  }
})

// 2.2 POST /init —— 显式同步/重置（reset:'pending' = 重开审核；缺省 = 幂等补齐）
router.post('/spatial-group-review/init', async (req, res) => {
  const { episodeId, reset } = req.body || {}
  const ep = Number(episodeId)
  if (!ep) return res.status(400).json({ error: 'episodeId 必填' })
  if (reset !== undefined && reset !== null && reset !== 'pending') {
    return res.status(400).json({ error: 'reset 必须是 pending 或缺省' })
  }
  try {
    if (!assertEpisode(ep, res)) return
    const { total, pending, created } = await review.syncSpatialGroupReview(ep, { reset })
    res.json({ success: true, total, pending, created })
  } catch (e) {
    console.error('[spatialGroupReview] POST /init 失败:', e.message)
    res.status(e.status || 500).json({ error: e.message })
  }
})

// 2.3 POST /decide —— confirm 写 spatial 锚行 / skip 删锚行
router.post('/spatial-group-review/decide', async (req, res) => {
  const { episodeId, group, action } = req.body || {}
  const ep = Number(episodeId)
  if (!ep || !group || !action) {
    return res.status(400).json({ error: 'episodeId/group/action 必填' })
  }
  try {
    if (!assertEpisode(ep, res)) return
    const result = await review.decideSpatialGroup({ episodeId: ep, group, action })
    res.json({ success: true, ...result })
  } catch (e) {
    console.error('[spatialGroupReview] POST /decide 失败:', e.message)
    res.status(e.status || 500).json({ error: e.message })
  }
})

export default router
