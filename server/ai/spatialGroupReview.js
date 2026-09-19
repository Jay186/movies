
import { SPATIAL_ANCHOR_TYPE, REVIEW_STATUS, REVIEW_ACTION } from './anchorTypes.js'
import { bareUrl } from './shared.js'

export { SPATIAL_ANCHOR_TYPE }


function HttpError(status, message) {
  const e = new Error(message)
  e.status = status
  return e
}


const GROUPS_SQL = `
  SELECT spatial_group, COUNT(*) AS member_count
  FROM scene_analysis
  WHERE episode_id = ? AND TRIM(COALESCE(spatial_group, '')) != ''
  GROUP BY spatial_group`

const REP_SQL = `
  SELECT s.id AS scene_id, s.scene_number, s.title, s.image_url
  FROM scene_analysis sa
  JOIN scenes s ON s.id = sa.scene_id
  WHERE sa.episode_id = ? AND sa.spatial_group = ?
  ORDER BY s.scene_number ASC, s.id ASC
  LIMIT 1`

const MEMBERS_SQL = `
  SELECT s.id, s.scene_number, s.title, s.image_url, sa.spatial_role, sa.props_json
  FROM scene_analysis sa
  JOIN scenes s ON s.id = sa.scene_id
  WHERE sa.episode_id = ? AND sa.spatial_group = ?
  ORDER BY s.scene_number ASC, s.id ASC`

const SYNC_REP_LEFT_GROUP = `(SELECT COUNT(*) FROM scene_analysis sa2 WHERE sa2.episode_id = spatial_group_review.episode_id AND sa2.spatial_group = spatial_group_review.spatial_group AND sa2.scene_id = spatial_group_review.rep_scene_id) = 0`
const SYNC_SOLO_GROWN = `spatial_group_review.status = '${REVIEW_STATUS.SKIPPED}' AND (SELECT COUNT(*) FROM scene_analysis sa3 WHERE sa3.episode_id = spatial_group_review.episode_id AND sa3.spatial_group = spatial_group_review.spatial_group) > 1`
const SYNC_DEFAULT_SQL = `
  INSERT INTO spatial_group_review (episode_id, spatial_group, rep_scene_id, rep_scene_number, status)
  VALUES (?, ?, ?, ?, '${REVIEW_STATUS.PENDING}')
  ON CONFLICT(episode_id, spatial_group) DO UPDATE SET
    rep_scene_id = excluded.rep_scene_id,
    rep_scene_number = excluded.rep_scene_number,
    status = CASE WHEN (${SYNC_SOLO_GROWN})
                   THEN '${REVIEW_STATUS.PENDING}'
                   WHEN spatial_group_review.status IN ('${REVIEW_STATUS.CONFIRMED}', '${REVIEW_STATUS.SKIPPED}')
                     AND spatial_group_review.rep_scene_id != excluded.rep_scene_id
                     AND ${SYNC_REP_LEFT_GROUP}
                   THEN '${REVIEW_STATUS.PENDING}' ELSE spatial_group_review.status END,
    baseline_image_url = CASE WHEN (${SYNC_SOLO_GROWN})
                   THEN ''
                   WHEN spatial_group_review.status IN ('${REVIEW_STATUS.CONFIRMED}', '${REVIEW_STATUS.SKIPPED}')
                     AND spatial_group_review.rep_scene_id != excluded.rep_scene_id
                     AND ${SYNC_REP_LEFT_GROUP}
                   THEN '' ELSE spatial_group_review.baseline_image_url END,
    updated_at = CURRENT_TIMESTAMP`

const SYNC_RESET_SQL = `
  INSERT INTO spatial_group_review (episode_id, spatial_group, rep_scene_id, rep_scene_number, status)
  VALUES (?, ?, ?, ?, '${REVIEW_STATUS.PENDING}')
  ON CONFLICT(episode_id, spatial_group) DO UPDATE SET
    rep_scene_id = excluded.rep_scene_id,
    rep_scene_number = excluded.rep_scene_number,
    status = '${REVIEW_STATUS.PENDING}',
    baseline_image_url = '',
    updated_at = CURRENT_TIMESTAMP`

const SYNC_SOLO_SQL = `
  INSERT INTO spatial_group_review (episode_id, spatial_group, rep_scene_id, rep_scene_number, status)
  VALUES (?, ?, ?, ?, '${REVIEW_STATUS.SKIPPED}')
  ON CONFLICT(episode_id, spatial_group) DO UPDATE SET
    rep_scene_id = excluded.rep_scene_id,
    rep_scene_number = excluded.rep_scene_number,
    status = '${REVIEW_STATUS.SKIPPED}',
    baseline_image_url = '',
    updated_at = CURRENT_TIMESTAMP`

const ANCHOR_UPSERT_SQL = `
  INSERT INTO scene_anchors (episode_id, anchor_type, anchor_key, scene_id, scene_number, image_url, description, source, confirmed)
  VALUES (?, '${SPATIAL_ANCHOR_TYPE}', ?, ?, ?, ?, ?, 'manual', 1)
  ON CONFLICT(episode_id, anchor_type, anchor_key) DO UPDATE SET
    image_url = excluded.image_url,
    scene_id = excluded.scene_id,
    scene_number = excluded.scene_number,
    confirmed = 1,
    source = 'manual',
    description = excluded.description`

const ANCHOR_DELETE_SQL = `
  DELETE FROM scene_anchors WHERE episode_id = ? AND anchor_type = '${SPATIAL_ANCHOR_TYPE}' AND anchor_key = ?`

const REVIEW_CONFIRM_SQL = `
  UPDATE spatial_group_review SET status = '${REVIEW_STATUS.CONFIRMED}', baseline_image_url = ?, updated_at = CURRENT_TIMESTAMP
  WHERE episode_id = ? AND spatial_group = ?`

const REVIEW_SKIP_SQL = `
  UPDATE spatial_group_review SET status = '${REVIEW_STATUS.SKIPPED}', updated_at = CURRENT_TIMESTAMP
  WHERE episode_id = ? AND spatial_group = ?`

export function createSpatialGroupReview(deps) {
  const {
    query,
    queryOne,
    execute,
    ensureSceneAnalysis,
    getLayoutAnchor = null,
    layoutMaterialsForGroup = null,
    fingerprintOfMaterials = null,
  } = deps || {}

  async function syncSpatialGroupReview(episodeId, { reset } = {}) {
    const groups = query(GROUPS_SQL, [episodeId])
    const existing = query(
      'SELECT spatial_group, status FROM spatial_group_review WHERE episode_id = ?',
      [episodeId]
    )
    const existMap = new Map(existing.map((r) => [r.spatial_group, r]))
    let created = 0
    for (const g of groups) {
      const rep = queryOne(REP_SQL, [episodeId, g.spatial_group])
      const repId = rep?.scene_id || 0
      const repNo = rep?.scene_number || 0
      if (!existMap.has(g.spatial_group)) created++
      const soloGroup = Number(g.member_count) <= 1
      if (soloGroup) {
        execute(SYNC_SOLO_SQL, [episodeId, g.spatial_group, repId, repNo])
        execute(ANCHOR_DELETE_SQL, [episodeId, g.spatial_group])
        continue
      }
      execute(reset === REVIEW_STATUS.PENDING ? SYNC_RESET_SQL : SYNC_DEFAULT_SQL, [
        episodeId, g.spatial_group, repId, repNo,
      ])
    }

    let cleaned = 0
    if (groups.length > 0) {
      const liveGroupNames = new Set(groups.map((g) => g.spatial_group))
      const orphanPending = query(
        `SELECT id, spatial_group FROM spatial_group_review
         WHERE episode_id = ? AND status = ? AND TRIM(COALESCE(baseline_image_url, '')) = ''`,
        [episodeId, REVIEW_STATUS.PENDING]
      ).filter((r) => !liveGroupNames.has(r.spatial_group))
      for (const r of orphanPending) {
        execute('DELETE FROM spatial_group_review WHERE episode_id = ? AND id = ?', [episodeId, r.id])
      }
      cleaned = orphanPending.length
      if (cleaned) {
        console.log(`[spatialGroupReview] 清理 ${cleaned} 条孤儿 pending review 行（episode=${episodeId}）：${orphanPending.map((r) => r.spatial_group).join('、')}`)
      }
    }

    const liveRows = query(
      'SELECT spatial_group, status FROM spatial_group_review WHERE episode_id = ?',
      [episodeId]
    )
    const liveMap = new Map(liveRows.map((r) => [r.spatial_group, r]))
    const pending = groups.filter((g) => {
      if (Number(g.member_count) <= 1) return false
      const r = liveMap.get(g.spatial_group)
      return !r || r.status === REVIEW_STATUS.PENDING
    }).length
    return { total: groups.length, pending, created, cleaned }
  }

  async function getSpatialGroupReviewStatus(episodeId) {
    if (ensureSceneAnalysis) await ensureSceneAnalysis(episodeId)
    const { total, pending } = await syncSpatialGroupReview(episodeId)
    const groups = query(GROUPS_SQL, [episodeId])
    const reviewRows = query(
      'SELECT * FROM spatial_group_review WHERE episode_id = ?',
      [episodeId]
    )
    const reviewMap = new Map(reviewRows.map((r) => [r.spatial_group, r]))

    const outGroups = []
    let done = 0
    for (const g of groups) {
      const rep = queryOne(REP_SQL, [episodeId, g.spatial_group])
      const repId = rep?.scene_id || 0
      const repNo = rep?.scene_number || 0
      const repTitle = rep?.title || ''
      const repImg = bareUrl(rep?.image_url)
      const review = reviewMap.get(g.spatial_group)

      let status = REVIEW_STATUS.PENDING
      let baselineImageUrl = ''
      let baselineReused = false
      if (review) {
        status = review.status
        const reviewBaseline = bareUrl(review.baseline_image_url)
        if (reviewBaseline) {
          baselineImageUrl = reviewBaseline
          baselineReused = false
        } else if (repImg) {
          baselineImageUrl = repImg
          baselineReused = true
        }
      } else if (repImg) {
        baselineImageUrl = repImg
        baselineReused = true
      }
      if (status === REVIEW_STATUS.CONFIRMED || status === REVIEW_STATUS.SKIPPED) done++

      const propSet = new Set()
      const members = query(MEMBERS_SQL, [episodeId, g.spatial_group]).map((m) => {
        let props = []
        try { props = JSON.parse(m.props_json || '[]') } catch { props = [] }
        for (const p of props) {
          const name = String(p || '').trim()
          if (name) propSet.add(name)
        }
        return {
          id: m.id,
          sceneNumber: m.scene_number,
          title: m.title,
          spatialRole: m.spatial_role || '',
          hasImage: String(m.image_url || '').trim() !== '',
          imageUrl: bareUrl(m.image_url),
        }
      })

      let layoutAnchor = null
      let layoutStale = null   
      if (getLayoutAnchor) {
        try {
          layoutAnchor = getLayoutAnchor(episodeId, g.spatial_group) || null
        } catch (e) {
          console.warn('[spatialGroupReview] 读取布局图锚失败（降级为无）:', e.message)
          layoutAnchor = null
        }
      }

      if (layoutAnchor) {
        const storedFp = String(layoutAnchor.sourceFingerprint || '')
        if (storedFp) {
          try {
            const curMaterials = layoutMaterialsForGroup ? layoutMaterialsForGroup(episodeId, g.spatial_group) : null
            const curFp = fingerprintOfMaterials ? fingerprintOfMaterials(curMaterials) : ''
            layoutStale = curFp ? curFp !== storedFp : null
          } catch (e) {
            console.warn('[spatialGroupReview] 布局图时效比对失败（降级为不判断）:', e.message)
            layoutStale = null
          }
        }
      }

      outGroups.push({
        group: g.spatial_group,
        status,
        repSceneId: repId,
        repSceneNumber: repNo,
        repSceneTitle: repTitle,
        baselineImageUrl,
        baselineReused,
        sharedProps: [...propSet],
        memberScenes: members,
        layoutAnchor,
        layoutStale,
      })
    }

    return { success: true, episodeId, total, pending, done, groups: outGroups }
  }

  async function decideSpatialGroup({ episodeId, group, action } = {}) {
    if (!episodeId || !group || !action) {
      throw HttpError(400, 'episodeId/group/action 必填')
    }
    if (action !== REVIEW_ACTION.CONFIRM && action !== REVIEW_ACTION.SKIP) {
      throw HttpError(400, 'action 必须是 confirm 或 skip')
    }
    const grpRow = queryOne(
      'SELECT 1 FROM scene_analysis WHERE episode_id = ? AND spatial_group = ? LIMIT 1',
      [episodeId, group]
    )
    if (!grpRow) throw HttpError(404, 'group_not_found')
    await syncSpatialGroupReview(episodeId)

    if (action === REVIEW_ACTION.CONFIRM) {
      const rep = queryOne(REP_SQL, [episodeId, group])
      const repImg = bareUrl(rep?.image_url)
      if (!repImg) throw HttpError(409, 'no_baseline_image')
      const repId = rep?.scene_id || 0
      const repNo = rep?.scene_number || 0
      const repTitle = rep?.title || ''
      execute(ANCHOR_UPSERT_SQL, [
        episodeId, group, repId, repNo, repImg,
        `空间组「${group}」人审基准图（出自场景「${repTitle}」）`,
      ])
      execute(REVIEW_CONFIRM_SQL, [repImg, episodeId, group])
      return { group, status: REVIEW_STATUS.CONFIRMED, anchorImageUrl: repImg }
    }

    execute(ANCHOR_DELETE_SQL, [episodeId, group])
    execute(REVIEW_SKIP_SQL, [episodeId, group])
    return { group, status: REVIEW_STATUS.SKIPPED, anchorImageUrl: null }
  }

  return { syncSpatialGroupReview, getSpatialGroupReviewStatus, decideSpatialGroup }
}
