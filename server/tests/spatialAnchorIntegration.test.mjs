// 空间组人审基准图 · 端到端集成（T04）
//
// 约定（team-lead 红线）：不得 import server/db.js（import 即开真实 data.db）。
// 因此采用【工厂注入】：服务层用 :memory: SQLite 注入（与 spatialGroupReview.test.mjs 同手法）；
// buildAnchorRefsForScene 的 SQL 一字不改复刻（sceneAnchors.js:375-453 自身 import db.js，
// 故这里复刻其 SQL，与 sceneSpatialAnchor.test.mjs「复刻真实约束」同手法）。
//
// 全链 SQL 时序复刻：
//   sync 建 pending 行 → confirm 写 spatial 锚行(manual/confirmed=1)
//   → 模拟批量首推：第二场 buildAnchorRefsForScene 命中组锚 refs[0] 且不占 MAX_SPATIAL_REFS 名额
//   → skip 回退：删锚行后同查询不再命中
//
// 覆盖设计 §6 T04 验收点 + AC3 / AC4 / AC5 / AC7。
// 只读、零网络、零真实库、零 AI 费用、可重复运行。

import Database from 'better-sqlite3'
import { createSpatialGroupReview, SPATIAL_ANCHOR_TYPE } from '../ai/spatialGroupReview.js'

const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ::  ${detail}` : ''}\n`)
}

// ── 表结构（与 spatialGroupReview.test.mjs 一致，必要字段即可）──
const SCHEMA = `
  CREATE TABLE episodes (id INTEGER PRIMARY KEY);
  CREATE TABLE scenes (id INTEGER PRIMARY KEY, episode_id INTEGER, scene_number INTEGER, title TEXT, image_url TEXT);
  CREATE TABLE scene_analysis (episode_id INTEGER, scene_id INTEGER, scene_number INTEGER, spatial_group TEXT, spatial_role TEXT, props_json TEXT);
  CREATE TABLE scene_anchors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    anchor_type TEXT NOT NULL,
    anchor_key TEXT NOT NULL,
    scene_id INTEGER DEFAULT 0,
    scene_number INTEGER DEFAULT 0,
    image_url TEXT NOT NULL,
    description TEXT DEFAULT '',
    source TEXT DEFAULT 'auto',
    confirmed INTEGER DEFAULT 0,
    UNIQUE(episode_id, anchor_type, anchor_key)
  );
  CREATE TABLE spatial_group_review (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    episode_id INTEGER NOT NULL,
    spatial_group TEXT NOT NULL,
    rep_scene_id INTEGER DEFAULT 0,
    rep_scene_number INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    baseline_image_url TEXT DEFAULT '',
    UNIQUE(episode_id, spatial_group)
  );
`

function setupDb() {
  const db = new Database(':memory:')
  db.exec(SCHEMA)
  return db
}
function makeService(db) {
  const query = (sql, params = []) => db.prepare(sql).all(...params)
  const queryOne = (sql, params = []) => db.prepare(sql).get(...params)
  const execute = (sql, params = []) => db.prepare(sql).run(...params)
  const ensureSceneAnalysis = async () => {}
  return createSpatialGroupReview({ query, queryOne, execute, ensureSceneAnalysis })
}
function addEpisode(db, id) { db.prepare('INSERT INTO episodes (id) VALUES (?)').run(id) }
function addScene(db, id, ep, no, title, img = '') {
  db.prepare('INSERT INTO scenes (id, episode_id, scene_number, title, image_url) VALUES (?,?,?,?,?)').run(id, ep, no, title, img)
}
function addAnalysis(db, ep, sceneId, no, group, role = '', props = '[]') {
  db.prepare('INSERT INTO scene_analysis (episode_id, scene_id, scene_number, spatial_group, spatial_role, props_json) VALUES (?,?,?,?,?,?)')
    .run(ep, sceneId, no, group, role, props)
}

// ── 一字不改复刻 sceneAnchors.js:375-453 buildAnchorRefsForScene（仅 0.组锚 + 1.邻场 + 2.道具）──
const bareUrl = (u) => String(u || '').split('?')[0].trim()
const MAX_SPATIAL_REFS = 2
const MAX_PROP_REFS = 2
// 组锚 hint（sceneAnchors.js:GROUP_ANCHOR_HINT 逐字）
// 2026-09-17 视角塌陷修复：继承项收敛为 空间结构/地标形态/光照方向，视角维度显式豁免
const GROUP_ANCHOR_HINT =
  '本空间的「人审基准图」已作为参考图提供：本场景与基准图是同一物理空间，' +
  '空间结构、地标物体的形态与相对位置、光照方向必须与基准图连续；' +
  '但视角、机位高度、景别与画面主体占比一律以本场景文字描述为准，严禁照搬基准图的构图；' +
  '时段、天气、色温同样以本场景文字描述为准'
const NEIGHBOR_HINT = (role, title) =>
  `参考图是本空间的「${role || title}」视角：本场景与它是同一物理空间，` +
  `空间结构、地标物体的形态与相对位置、光照方向必须与参考图连续；` +
  `但视角、机位高度、景别与画面主体占比一律以本场景文字描述为准，严禁照搬参考图的构图；` +
  `时段、天气、色温同样以本场景文字描述为准`
const PROP_HINT = (name) =>
  `道具「${name}」必须与参考图中的同一物体保持形态、颜色、材质与破损状态一致`

function buildAnchorRefsForScene(db, episodeId, sceneId) {
  const row = db.prepare('SELECT * FROM scene_analysis WHERE episode_id = ? AND scene_id = ?').get(episodeId, sceneId)
  if (!row) return { refs: [], promptHints: [], anchors: [] }
  const refs = []
  const promptHints = []
  const anchors = []
  // 0. 组锚（人审基准图，第 3 层）
  if (row.spatial_group) {
    const ga = db.prepare(
      `SELECT anchor_key, scene_id, scene_number, image_url FROM scene_anchors
       WHERE episode_id = ? AND anchor_type = '${SPATIAL_ANCHOR_TYPE}' AND anchor_key = ?
         AND source = 'manual' AND confirmed = 1`
    ).get(episodeId, row.spatial_group)
    const gaImg = bareUrl(ga?.image_url)
    if (gaImg) {
      refs.push(gaImg)
      promptHints.push(GROUP_ANCHOR_HINT)
      anchors.push({ type: 'spatial', key: ga.anchor_key, image: gaImg, role: '人审基准图' })
    }
  }
  // 1. 空间锚（邻场）
  if (row.spatial_group) {
    const cur = db.prepare('SELECT scene_number FROM scenes WHERE id = ?').get(sceneId)
    const mates = db.prepare(
      `SELECT s.id, s.title, s.image_url, s.scene_number, sa.spatial_role
       FROM scene_analysis sa
       JOIN scenes s ON s.id = sa.scene_id
       WHERE sa.episode_id = ? AND sa.spatial_group = ? AND sa.scene_id != ? AND TRIM(s.image_url) != ''
       ORDER BY ABS(s.scene_number - ?) ASC`
    ).all(episodeId, row.spatial_group, sceneId, cur?.scene_number || 0).slice(0, MAX_SPATIAL_REFS)
    for (const m of mates) {
      const img = bareUrl(m.image_url)
      if (!img || refs.includes(img)) continue
      refs.push(img)
      promptHints.push(NEIGHBOR_HINT(m.spatial_role, m.title))
      anchors.push({ type: 'scene', key: m.title, image: img, role: m.spatial_role })
    }
  }
  // 2. 道具锚（状态机制关闭 → 默认文案，与改造前一致）
  let props = []
  try { props = JSON.parse(row.props_json || '[]') } catch { props = [] }
  let propCount = 0
  for (const name of props) {
    if (propCount >= MAX_PROP_REFS) break
    const a = db.prepare(
      `SELECT * FROM scene_anchors WHERE episode_id = ? AND anchor_type = 'prop' AND anchor_key = ?`
    ).get(episodeId, name)
    if (!a) continue
    const img = bareUrl(a.image_url)
    if (!img) continue
    if (!refs.includes(img)) refs.push(img)
    promptHints.push(PROP_HINT(name))
    anchors.push({ type: 'prop', key: name, image: img })
    propCount++
  }
  return { refs, promptHints, anchors }
}

// ══════════════════════════════════════════════════════════════════════════════
// 用例 1：全链 SQL 时序 —— sync → confirm → 批量首推(组锚 refs[0]) → AC3/AC4/AC5
// ══════════════════════════════════════════════════════════════════════════════
{
  const EP = 7
  const db = setupDb()
  addEpisode(db, EP)
  // cliff_river 组 4 场：91 代表场(A)、92(B)、93(C)、94(待生成，第二场)
  addScene(db, 91, EP, 1, '崖顶俯视断桥', '/uploads/asset-scene-91.png') // A = 组锚基准图
  addScene(db, 92, EP, 2, '谷底仰看断桥', '/uploads/asset-scene-92.png') // B
  addScene(db, 93, EP, 3, '崖下溪流', '/uploads/asset-scene-93.png')     // C
  addScene(db, 94, EP, 4, '断桥残骸', '')                                // 无图（批量首推目标）
  addAnalysis(db, EP, 91, 1, 'cliff_river', '崖顶俯视谷底', '["断桥","木栈"]')
  addAnalysis(db, EP, 92, 2, 'cliff_river', '谷底浅滩仰视', '["断桥","木栈"]')
  addAnalysis(db, EP, 93, 3, 'cliff_river', '崖下视角', '["断桥","木栈"]')
  addAnalysis(db, EP, 94, 4, 'cliff_river', '断桥残骸特写', '["断桥","木栈"]')
  // 注册两个道具锚（auto），供道具锚段命中
  const insProp = db.prepare(
    'INSERT INTO scene_anchors (episode_id, anchor_type, anchor_key, scene_id, scene_number, image_url, description, source) VALUES (?,?,?,?,?,?,\'\',\'auto\')'
  )
  insProp.run(EP, 'prop', '断桥', 91, 1, '/uploads/prop-bridge.png')
  insProp.run(EP, 'prop', '木栈', 92, 2, '/uploads/prop-plank.png')
  const svc = makeService(db)

  // ① sync 建 pending 行
  const synced = await svc.syncSpatialGroupReview(EP)
  const pendingRow = db.prepare('SELECT * FROM spatial_group_review WHERE episode_id=? AND spatial_group=?').get(EP, 'cliff_river')
  record('① sync 建立 cliff_river 的 pending 行（total=1, pending=1, created=1）',
    synced.total === 1 && synced.pending === 1 && synced.created === 1 && pendingRow?.status === 'pending',
    `total=${synced.total} pending=${synced.pending} created=${synced.created} status=${pendingRow?.status}`)

  // ② confirm 写 spatial 锚行
  const d = await svc.decideSpatialGroup({ episodeId: EP, group: 'cliff_river', action: 'confirm' })
  const anchor = db.prepare("SELECT * FROM scene_anchors WHERE episode_id=? AND anchor_type='spatial'").get(EP)
  record('② confirm 返回 status=confirmed 且回传基准图', d.status === 'confirmed' && d.anchorImageUrl === '/uploads/asset-scene-91.png', JSON.stringify(d))
  // AC3：锚行字段齐全
  record('AC3 锚行三条件齐全 (type=spatial / key=组名 / scene_id=代表场 / source=manual / confirmed=1)',
    !!anchor && anchor.anchor_type === 'spatial' && anchor.anchor_key === 'cliff_river' &&
    anchor.scene_id === 91 && anchor.source === 'manual' && anchor.confirmed === 1,
    anchor ? `type=${anchor.anchor_type} key=${anchor.anchor_key} scene=${anchor.scene_id} src=${anchor.source} conf=${anchor.confirmed}` : 'missing')
  record('AC3 锚行 image_url = 代表场定稿图裸路径 + description 含「人审基准图」',
    !!anchor && anchor.image_url === '/uploads/asset-scene-91.png' && String(anchor.description || '').includes('人审基准图'),
    anchor ? `img=${anchor.image_url} desc=${anchor.description}` : '')

  // ③ 模拟批量首推：第二场 94 取锚（必须在 AC4 删 auto 锚之前，否则道具锚会被清掉）
  const r94 = buildAnchorRefsForScene(db, EP, 94)
  const groupImg = '/uploads/asset-scene-91.png'
  const propImgs = ['/uploads/prop-bridge.png', '/uploads/prop-plank.png']
  const neighborImgs = r94.refs.filter((u) => u !== groupImg && !propImgs.includes(u))
  record('AC5 refs[0] = 组锚图（固定排第一，不随邻场顺序漂移）', r94.refs[0] === groupImg, `refs[0]=${r94.refs[0]}`)
  record('AC5 组锚不占 MAX_SPATIAL_REFS 名额：邻场锚仍有 2 张（=名额上限）',
    neighborImgs.length === 2, `neighbors=${JSON.stringify(neighborImgs)}`)
  record('AC5 道具锚 ≤ 2（本例 2 张，未超上限）',
    propImgs.every((p) => r94.refs.includes(p)) && r94.refs.filter((u) => propImgs.includes(u)).length === 2,
    `props=${JSON.stringify(r94.refs.filter((u) => propImgs.includes(u)))}`)
  record('AC5 组锚 hint 含「空间结构…光照方向…连续」',
    r94.promptHints[0] === GROUP_ANCHOR_HINT &&
    r94.promptHints[0].includes('空间结构') && r94.promptHints[0].includes('光照方向') &&
    r94.promptHints[0].includes('连续'),
    r94.promptHints[0] || '')
  record('AC5 邻场 hint 同样含「连续」声明（与组锚口径对齐，修复 P0-6 冲突）',
    r94.promptHints.filter((h) => h.includes('必须与参考图连续')).length >= 2,
    `连续声明数=${r94.promptHints.filter((h) => h.includes('必须与参考图连续')).length}`)
  // 2026-09-17 视角塌陷回归守护：组锚/邻场 hint 都不得把「构图」判给锚图，
  // 且都必须显式豁免视角维度——否则同组多视角会被并成同一机位（cliff_river 事故）。
  const spatialHints = r94.promptHints.filter((h) => h.includes('同一物理空间'))
  record('AC5 视角守护：空间类 hint 均不含「构图必须与锚图连续」旧口径',
    spatialHints.length >= 2 && spatialHints.every((h) => !/构图[^。；]*(必须与|以参考|与锚图保持连续)/.test(h)),
    `hint 数=${spatialHints.length}`)
  record('AC5 视角守护：空间类 hint 均显式声明视角/机位以本场描述为准',
    spatialHints.length >= 2 && spatialHints.every((h) => h.includes('视角') && h.includes('机位高度') && h.includes('景别')),
    `hint 数=${spatialHints.length}`)

  // AC4：执行既有 ensureSceneAnalysis 的重建 SQL（删 auto 锚）后 spatial/manual 行仍在
  db.prepare("DELETE FROM scene_anchors WHERE episode_id=? AND source='auto'").run(EP)
  const after = db.prepare("SELECT COUNT(*) c FROM scene_anchors WHERE episode_id=? AND anchor_type='spatial' AND source='manual'").get(EP)
  record('AC4 删 auto 锚后 spatial/manual 行仍在（image_url 不变，重析不重建）',
    after.c === 1 && db.prepare("SELECT image_url FROM scene_anchors WHERE episode_id=? AND anchor_type='spatial'").get(EP).image_url === '/uploads/asset-scene-91.png',
    `count=${after.c}`)
}

// ══════════════════════════════════════════════════════════════════════════════
// 用例 2：组锚与邻场同图 → 去重（AC5 去重点）
// ══════════════════════════════════════════════════════════════════════════════
{
  const EP = 8
  const db = setupDb()
  addEpisode(db, EP)
  // 让代表场 91 与邻场 92 用同一张图 A（代表场图 = 组锚图，也是 92 的定稿图）
  addScene(db, 91, EP, 1, '崖顶俯视断桥', '/uploads/asset-scene-91.png')
  addScene(db, 92, EP, 2, '谷底仰看断桥', '/uploads/asset-scene-91.png') // 同图
  addScene(db, 93, EP, 3, '崖下溪流', '/uploads/asset-scene-93.png')
  addScene(db, 94, EP, 4, '断桥残骸', '')
  addAnalysis(db, EP, 91, 1, 'cliff_river')
  addAnalysis(db, EP, 92, 2, 'cliff_river')
  addAnalysis(db, EP, 93, 3, 'cliff_river')
  addAnalysis(db, EP, 94, 4, 'cliff_river')
  const svc = makeService(db)
  await svc.syncSpatialGroupReview(EP)
  await svc.decideSpatialGroup({ episodeId: EP, group: 'cliff_river', action: 'confirm' })

  const r94 = buildAnchorRefsForScene(db, EP, 94)
  const groupImg = '/uploads/asset-scene-91.png'
  record('AC5 组锚与邻场同图去重：refs 中组锚图仅出现 1 次',
    r94.refs[0] === groupImg && r94.refs.filter((u) => u === groupImg).length === 1,
    `refs=${JSON.stringify(r94.refs)}`)
  record('AC5 去重后另有 93 的异图邻场（不漏锚）',
    r94.refs.includes('/uploads/asset-scene-93.png'), JSON.stringify(r94.refs))
}

// ══════════════════════════════════════════════════════════════════════════════
// 用例 3：skip 回退 —— 删锚行后同查询不再命中（AC7）
// ══════════════════════════════════════════════════════════════════════════════
{
  const EP = 9
  const db = setupDb()
  addEpisode(db, EP)
  addScene(db, 91, EP, 1, '崖顶俯视断桥', '/uploads/asset-scene-91.png')
  addScene(db, 94, EP, 4, '断桥残骸', '')
  addAnalysis(db, EP, 91, 1, 'cliff_river')
  addAnalysis(db, EP, 94, 4, 'cliff_river')
  const svc = makeService(db)
  await svc.syncSpatialGroupReview(EP)
  await svc.decideSpatialGroup({ episodeId: EP, group: 'cliff_river', action: 'confirm' })

  // skip 前：组锚命中
  const before = buildAnchorRefsForScene(db, EP, 94)
  const beforeSpatial = db.prepare("SELECT COUNT(*) c FROM scene_anchors WHERE episode_id=? AND anchor_type='spatial'").get(EP)
  record('skip 前组锚已生效（refs[0]=组锚，库中存在 spatial 行）',
    before.refs[0] === '/uploads/asset-scene-91.png' && beforeSpatial.c === 1,
    `refs[0]=${before.refs[0]} count=${beforeSpatial.c}`)

  // skip（KD6：删既有组锚）
  const s = await svc.decideSpatialGroup({ episodeId: EP, group: 'cliff_river', action: 'skip' })
  const afterCount = db.prepare("SELECT COUNT(*) c FROM scene_anchors WHERE episode_id=? AND anchor_type='spatial'").get(EP).c
  const afterStatus = db.prepare('SELECT status FROM spatial_group_review WHERE episode_id=? AND spatial_group=?').get(EP, 'cliff_river').status
  record('AC7 skip 后 review 状态=skipped', s.status === 'skipped' && afterStatus === 'skipped', `status=${afterStatus}`)
  record('AC7 skip 后无 spatial 锚行（KD6 删除）', afterCount === 0, `count=${afterCount}`)

  // skip 后：同查询不再命中组锚。
  // 注意：按 anchors 明细判定锚来源，而非 URL——设计 §4.2：skip 后 refs[0] 可能仍是代表场 91 的
  // 邻场 auto 锚（与组锚图同 URL），属正确行为，不能据此判「组锚仍命中」。
  const after = buildAnchorRefsForScene(db, EP, 94)
  record('AC7 skip 后 anchors 中不再含 type===\'spatial\' 条目（组锚确实消失，refs[0] 同图归邻场锚）',
    after.anchors.every((a) => a.type !== 'spatial'),
    `refs[0]=${after.refs[0]} anchors=${JSON.stringify(after.anchors.map((a) => a.type))}`)
}

const failed = results.filter((r) => !r.ok)
process.stdout.write(`\n==== spatialAnchorIntegration: ${results.length - failed.length}/${results.length} passed ====\n`)
if (failed.length) {
  process.stdout.write(`FAILED: ${failed.map((f) => f.name).join(', ')}\n`)
  process.exit(1)
}
