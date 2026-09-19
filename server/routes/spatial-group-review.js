
import { Router } from 'express'
import { query, queryOne, execute } from '../db.js'
import { ensureSceneAnalysis, getLayoutAnchor, collectGroupLayoutMaterials, layoutMaterialsFingerprint } from '../ai/sceneAnchors.js'
import { createSpatialGroupReview } from '../ai/spatialGroupReview.js'

const router = Router()
const review = createSpatialGroupReview({
  query, queryOne, execute, ensureSceneAnalysis,
  getLayoutAnchor,
  layoutMaterialsForGroup: collectGroupLayoutMaterials,
  fingerprintOfMaterials: layoutMaterialsFingerprint,
})

function assertEpisode(episodeId, res) {
  const ep = queryOne('SELECT id FROM episodes WHERE id = ?', [episodeId])
  if (!ep) {
    res.status(404).json({ error: 'episode 不存在' })
    return false
  }
  return true
}

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
