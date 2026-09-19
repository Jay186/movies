// 空间组人审基准图（第 3 / 3 层）审核服务层
//
// 设计依据：docs/anchor-review/02-incremental-design.md §2 / §3 / §4
//
// 依赖注入：本模块是「纯工厂」——所有 DB 访问经 deps 注入，模块自身不 import db.js，
// 因此测试可用 :memory: SQLite 注入、零网络、零真实库。运行时由 server/routes/
// spatial-group-review.js 用真实 db.js 的 query/queryOne/execute + ensureSceneAnalysis 接线。
//
// 状态/动作枚举一律取 ai/anchorTypes.js 的单点常量（与 DB / API / 前端同串，跨层一致性
// 由 server/_qa_spatial_review.mjs 的「枚举同串」静态断言守护）

// 依赖：锚类型/审核状态/决策动作的唯一定义处
import { SPATIAL_ANCHOR_TYPE, REVIEW_STATUS, REVIEW_ACTION } from './anchorTypes.js'

// 兼容再导出：既有调用方仍可从本模块取 SPATIAL_ANCHOR_TYPE
export { SPATIAL_ANCHOR_TYPE }

const bareUrl = (u) => String(u || '').split('?')[0].trim()

function HttpError(status, message) {
  const e = new Error(message)
  e.status = status
  return e
}

// ── SQL 模板（逐字对照设计 §3.3）─────────────────────────────────────────────

// 当前分析中存在的空间组（孤儿 review 行不在其列 → §3.4-1 不计数）
// member_count：组内成员数。单场景组（=1）不需要参考图——参考图的价值是「一图定义空间、
// 其余照着画」，只有一个场景时没有"其余"，定参考图无下游。此类组在 sync 时直接落 skipped，
// 不计入待办、不锁定成员卡（2026-09-17 布哥反馈：单场景组仍显示「就用这张当参考图」，
// 点了图也不变，且造出假待办）。
const GROUPS_SQL = `
  SELECT spatial_group, COUNT(*) AS member_count
  FROM scene_analysis
  WHERE episode_id = ? AND TRIM(COALESCE(spatial_group, '')) != ''
  GROUP BY spatial_group`

// 组内代表场 = scene_number 最小者，并列取 id 较小者（设计 §附 假设）
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

// sync 默认（不覆盖 status）：
//   · 代表场漂移（同组内加入了更小场次的新场景）→ 仅刷新 rep_scene_id，status 不变（§3.4-2）
//   · 代表场已离开组内（旧 rep_scene_id 在 scene_analysis 中不再属于该组）→ 回退 pending 并清 baseline（§3.4-3）
//   · 单场景组长大（原 skipped 但现已有 >1 成员）→ 回到 pending 重新待办（2026-09-17 补，见 SOLO_GROWN）
// 区分依据：旧 rep_scene_id 是否仍存在于本组 scene_analysis（防御 #3 才回退）。
const SYNC_REP_LEFT_GROUP = `(SELECT COUNT(*) FROM scene_analysis sa2 WHERE sa2.episode_id = spatial_group_review.episode_id AND sa2.spatial_group = spatial_group_review.spatial_group AND sa2.scene_id = spatial_group_review.rep_scene_id) = 0`
// 【单场景组长大的自愈判据】2026-09-17 补：SYNC_SOLO_SQL 会把 ≤1 成员的组单向下沉为 skipped，
// 而 SYNC_DEFAULT_SQL 原本只在「代表场离开组」时才回退 pending——于是**单纯长大**（skipped 的单场景组
// 被重析补进第二个场景）会永远卡在 skipped，再也回不到待办列表。这与 SYNC_SOLO_SQL 上方注释声称的
// 「补进第二个场景 → 走 SYNC_DEFAULT_SQL 回到 pending（正常）」相矛盾，是注释先于实现的漏网。
// 判据：原状态为 skipped 且该组现在已有 >1 个成员 → 重置为 pending 并清 baseline。
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

// sync reset='pending'：全部回退 pending 并清空 baseline（P2-2 重开审核）
const SYNC_RESET_SQL = `
  INSERT INTO spatial_group_review (episode_id, spatial_group, rep_scene_id, rep_scene_number, status)
  VALUES (?, ?, ?, ?, '${REVIEW_STATUS.PENDING}')
  ON CONFLICT(episode_id, spatial_group) DO UPDATE SET
    rep_scene_id = excluded.rep_scene_id,
    rep_scene_number = excluded.rep_scene_number,
    status = '${REVIEW_STATUS.PENDING}',
    baseline_image_url = '',
    updated_at = CURRENT_TIMESTAMP`

// sync 单场景组（member_count = 1）：恒落 skipped + 清 baseline + 删掉可能存在的组锚。
// 为什么恒写而不"仅新建时写"：组内成员数会变——
//   · 单场景组被 AI 重析补进第二个场景 → 走 SYNC_DEFAULT_SQL 回到 pending 重新待办（正常）
//   · 多场景组被删到只剩 1 个 → 必须回落 skipped，否则它带着一个永远不该定的待办卡在列表里
// 故每次 sync 都以当前成员数为准单向下沉，是幂等且自愈的。
// 一并删锚：组缩到 1 人时旧的组锚已无下游，留着会污染后续生成的取锚。
const SYNC_SOLO_SQL = `
  INSERT INTO spatial_group_review (episode_id, spatial_group, rep_scene_id, rep_scene_number, status)
  VALUES (?, ?, ?, ?, '${REVIEW_STATUS.SKIPPED}')
  ON CONFLICT(episode_id, spatial_group) DO UPDATE SET
    rep_scene_id = excluded.rep_scene_id,
    rep_scene_number = excluded.rep_scene_number,
    status = '${REVIEW_STATUS.SKIPPED}',
    baseline_image_url = '',
    updated_at = CURRENT_TIMESTAMP`

// confirm：upsert spatial 组锚行（source='manual', confirmed=1）
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

/**
 * 工厂：注入 DB 依赖与 ensureSceneAnalysis，返回审核服务实例。
 * 测试传 :memory: 库的 query/queryOne/execute + 桩 ensureSceneAnalysis；
 * 运行时由路由传真实 db.js + 真实 sceneAnchors.ensureSceneAnalysis。
 */
export function createSpatialGroupReview(deps) {
  const {
    query,
    queryOne,
    execute,
    ensureSceneAnalysis,
    // 布局图锚读取（2026-09-18，A3 布局图卡片 UI）：
    // 组视图每组要多带一张「俯视布局示意图」的锚信息给前端卡片。
    // 为什么走注入而不是直接 import sceneAnchors.js：本模块是纯工厂，必须保持可注入
    // :memory: 库测试（见文件头注释）。缺省为 null → 降级为「该组没有布局图」，
    // 既不抛错也不阻断状态查询（降级铁律）。
    getLayoutAnchor = null,
    // 布局图时效比对所需的两个纯函数（2026-09-18）：
    //   layoutMaterialsForGroup = collectGroupLayoutMaterials（读当前素材）
    //   fingerprintOfMaterials  = layoutMaterialsFingerprint（对素材取指纹）
    // 同样走注入以保持本模块的纯工厂性质（可注入 :memory: 测试）。
    // 缺省 null → layoutStale 恒为 null（= 不做时效判断），行为退回本轮之前。
    layoutMaterialsForGroup = null,
    fingerprintOfMaterials = null,
  } = deps || {}

  // ── sync：按当前分析 upsert（不覆盖 status），返回聚合 ──
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
      // 单场景组：无下游可参考，直接判定为「无需参考图」（落 skipped，语义等同"这组不用定"）。
      // 不能用 reset 全刷 pending 覆盖它——reset 是「重开审核」，与"本来就不需要"无关。
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

    // ── 孤儿 review 行清理（2026-09-18，Q5/P2）──────────────────────────────
    // 背景：sync 只对「当前分析组」upsert，历次重析中消失的组名其 review 行**永不清除**
    //   → 孤儿行持续累积、误导人工排查（ep4 实测残留 2 行：forest_highland / forest_lake，
    //     均为历次重析的历史组名）。
    // 删除判据（三条**必须同时满足**，缺一不可）：
    //   ① 属于本集；② 组名不在当前 scene_analysis 的组集合（groups）内；
    //   ③ status='pending' 且 baseline_image_url 为空（未定的待办才清）。
    // 刻意保留 confirmed/skipped 的孤儿行：那是**人审留痕**（谁确认过、谁跳过过），有审计价值——
    //   静默删除比残留更糟（与「orphanAnchors 只提示不擅删」同口径）。
    // I3 护栏（2026-09-18）：`groups.length === 0` 表示「当前 scene_analysis 没有任何组」——
    //   这既可能是"分析尚未跑"（如路由直接调本 sync 而未先 ensureSceneAnalysis），也可能是
    //   "所有场景组名皆空"。此时 liveGroupNames 为空 → 会把该集**全部** pending 且无 baseline 的
    //   行误清光（数据损失）。故 groups 为空时**直接跳过清理**（cleaned:0）。
    //   护栏放在清理逻辑**内部**（而非调用方）：任何调用路径都受保护。
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

    // pending 以「组落库后的真实状态」为基准，而不是 upsert 前快照（existMap）——
    // 快照漏算两类本回合刚被改写的组：
    //   ① reset 模式：所有组刚被刷成 pending；
    //   ② skipped 单场景组长大的自愈：快照里还是 skipped，实际刚被 SYNC_DEFAULT_SQL 重置为 pending。
    // 故这里直接回查 DB（组数很少，查询代价可忽略），语义最稳且不依赖对 SQL 分支的复述。
    // 单场景组一律不计入（它们恒为 skipped，不是待办，见 SYNC_SOLO_SQL）。
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

  // ── status：确保分析最新 → 幂等补齐/刷新 → 聚合返回（设计 §2.1）──
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

      // 组级地标清单（2026-09-17 空间组视图）：成员 props 的并集——
      // 设定页基准卡副标用（人审判断依据：这张基准图是否画全了组内反复出现的地标）。
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

      // 布局图锚（A3，2026-09-18）：每组附一张俯视布局示意图的信息。
      // 为什么放在 status 里而不是让前端逐组去查：组视图一次渲染 N 张卡，
      //   逐组查就是 N 次请求（N+1）；而这里本来就已经在逐组循环，加上零成本。
      // 降级：读取失败/未注入 → null（= 这组还没画过布局图），绝不抛错打断状态查询。
      let layoutAnchor = null
      let layoutStale = null   // null = 不适用（没有布局图 / 没有可比对的指纹）
      if (getLayoutAnchor) {
        try {
          layoutAnchor = getLayoutAnchor(episodeId, g.spatial_group) || null
        } catch (e) {
          console.warn('[spatialGroupReview] 读取布局图锚失败（降级为无）:', e.message)
          layoutAnchor = null
        }
      }

      // 时效判断（2026-09-18）：布局图记着"画它时的素材指纹"，与**当前**素材指纹比对。
      // 不一致 = 场景描述改过、布局图可能不再对应实际空间 → 前端提示重画。
      //
      // 为什么值得做：布局图是 source='manual'（重析不删，保护花钱生成的图），
      //   代价就是它会悄悄过时。而**过时的布局图比没有更糟**——组内场景照着一张
      //   错的底图对齐空间，错误顺锚放大到整组。以前这个状态完全静默。
      //
      // 三档语义（必须区分，否则会误报或漏报）：
      //   null  = 不适用 —— 没图（还没画），或图/素材任一缺指纹（老数据）
      //   false = 素材没变，图仍然有效
      //   true  = 素材变了，建议重画
      // 缺指纹一律判 null 而非 true：老数据没有指纹是**我们**的历史欠账，
      //   不能让用户看到一片"建议重画"却不知道为什么（那会变成噪音，提示就废了）。
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

  // ── decide：confirm 写 spatial 锚行 + review='confirmed'；skip 删锚行 + review='skipped' ──
  async function decideSpatialGroup({ episodeId, group, action } = {}) {
    if (!episodeId || !group || !action) {
      throw HttpError(400, 'episodeId/group/action 必填')
    }
    if (action !== REVIEW_ACTION.CONFIRM && action !== REVIEW_ACTION.SKIP) {
      throw HttpError(400, 'action 必须是 confirm 或 skip')
    }
    // 组必须存在于当前 scene_analysis（否则 404）
    const grpRow = queryOne(
      'SELECT 1 FROM scene_analysis WHERE episode_id = ? AND spatial_group = ? LIMIT 1',
      [episodeId, group]
    )
    if (!grpRow) throw HttpError(404, 'group_not_found')
    // 确保 review 行存在（幂等补齐）
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

    // skip（KD6：撤销既有组锚，若有）
    execute(ANCHOR_DELETE_SQL, [episodeId, group])
    execute(REVIEW_SKIP_SQL, [episodeId, group])
    return { group, status: REVIEW_STATUS.SKIPPED, anchorImageUrl: null }
  }

  return { syncSpatialGroupReview, getSpatialGroupReviewStatus, decideSpatialGroup }
}
