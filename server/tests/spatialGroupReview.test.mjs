// 空间组人审基准图 · 服务层单测（T01）
//
// 约定（team-lead 红线）：本文件不得 import server/db.js（import 即开真实 data.db）。
// 因此采用【工厂注入】：用 :memory: SQLite 构造 query/queryOne/execute/ensureSceneAnalysis
// 注入 createSpatialGroupReview —— 与 server/ai/spatialGroupReview.js 的真实导出完全一致，
// 仅 DB 依赖被替换。零网络、零真实库、零 AI 费用、可重复运行。
//
// 覆盖设计 §6 T01 验收点 1-6（含 AC3/AC4/AC8、§3.4-1 孤儿行不计数）。

import Database from 'better-sqlite3'
import { createSpatialGroupReview } from '../ai/spatialGroupReview.js'

const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ::  ${detail}` : ''}\n`)
}

// ── 表结构（逐字来自 schema.sql 的相关片段，必要字段即可）──
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

// 注入：把 :memory: db 包成服务层需要的依赖；ensureSceneAnalysis 用桩（scene_analysis 已预填）
function makeService(db) {
  const query = (sql, params = []) => db.prepare(sql).all(...params)
  const queryOne = (sql, params = []) => db.prepare(sql).get(...params)
  const execute = (sql, params = []) => db.prepare(sql).run(...params)
  const ensureSceneAnalysis = async () => {}
  return createSpatialGroupReview({ query, queryOne, execute, ensureSceneAnalysis })
}

function addEpisode(db, id) {
  db.prepare('INSERT INTO episodes (id) VALUES (?)').run(id)
}
function addScene(db, id, ep, no, title, img = '') {
  db.prepare('INSERT INTO scenes (id, episode_id, scene_number, title, image_url) VALUES (?,?,?,?,?)').run(id, ep, no, title, img)
}
function addAnalysis(db, ep, sceneId, no, group, role = '') {
  db.prepare('INSERT INTO scene_analysis (episode_id, scene_id, scene_number, spatial_group, spatial_role, props_json) VALUES (?,?,?,?,?,?)')
    .run(ep, sceneId, no, group, role, '[]')
}

// ── 用例 1（验收点 1）：首次 sync 建 pending 行，二调 created=0（幂等）──
{
  const db = setupDb()
  addEpisode(db, 3)
  addScene(db, 1, 3, 1, '谷底仰看断桥')
  addScene(db, 2, 3, 2, '崖顶俯视断桥')
  addAnalysis(db, 3, 1, 1, 'cliff_river', '谷底浅滩仰视')
  addAnalysis(db, 3, 2, 2, 'cliff_river', '崖顶俯视谷底')
  const svc = makeService(db)

  const first = await svc.syncSpatialGroupReview(3)
  const rowsAfterFirst = db.prepare('SELECT spatial_group, status FROM spatial_group_review WHERE episode_id=3').all()
  const second = await svc.syncSpatialGroupReview(3)

  record('首次 sync 建立 1 个 pending 行', first.total === 1 && first.created === 1, `total=${first.total} created=${first.created}`)
  record('二调 created=0（幂等不过建）', second.created === 0, `created=${second.created}`)
  record('状态初值 = pending', rowsAfterFirst.length === 1 && rowsAfterFirst[0].status === 'pending', JSON.stringify(rowsAfterFirst))
}

// ── 用例 2（验收点 2）：加场后代表场刷新但 status 不被覆盖 ──
{
  const db = setupDb()
  addEpisode(db, 3)
  addScene(db, 1, 3, 1, '谷底仰看断桥', '/uploads/asset-scene-1.png')
  addScene(db, 2, 3, 2, '崖顶俯视断桥')
  addAnalysis(db, 3, 1, 1, 'cliff_river')
  addAnalysis(db, 3, 2, 2, 'cliff_river')
  const svc = makeService(db)

  await svc.syncSpatialGroupReview(3)
  // confirm（rep 场 1 已有图）
  const d = await svc.decideSpatialGroup({ episodeId: 3, group: 'cliff_river', action: 'confirm' })
  // 加一张更小场次的新场景到同组
  addScene(db, 0, 3, 0, '桥下溪流')
  addAnalysis(db, 3, 0, 0, 'cliff_river')
  await svc.syncSpatialGroupReview(3)
  const row = db.prepare('SELECT rep_scene_id, rep_scene_number, status FROM spatial_group_review WHERE episode_id=3 AND spatial_group=?').get('cliff_river')

  record('confirm 成功写锚行', d.status === 'confirmed' && d.anchorImageUrl === '/uploads/asset-scene-1.png', JSON.stringify(d))
  record('加场后代表场刷新到 scene 0', row.rep_scene_id === 0 && row.rep_scene_number === 0, JSON.stringify(row))
  record('加场后 status 仍以 confirmed（不被覆盖）', row.status === 'confirmed', `status=${row.status}`)
}

// ── 用例 3（验收点 3 / AC3 / AC4）：confirm 写 spatial/manual/confirmed 行；删 auto 锚后仍在 ──
{
  const db = setupDb()
  addEpisode(db, 3)
  addScene(db, 1, 3, 1, '谷底仰看断桥', '/uploads/asset-scene-1.png')
  addAnalysis(db, 3, 1, 1, 'cliff_river')
  const svc = makeService(db)

  await svc.decideSpatialGroup({ episodeId: 3, group: 'cliff_river', action: 'confirm' })
  // 模拟 ensureSceneAnalysis 重建：删掉所有 source='auto' 锚（含道具/场景 auto 锚）
  db.prepare("DELETE FROM scene_anchors WHERE source='auto'").run()
  const anchor = db.prepare("SELECT * FROM scene_anchors WHERE episode_id=3 AND anchor_type='spatial'").get()

  record('存在 spatial 锚行', !!anchor, JSON.stringify(anchor || null))
  record('锚行三条件齐全 (spatial/manual/confirmed=1)',
    anchor && anchor.anchor_type === 'spatial' && anchor.source === 'manual' && anchor.confirmed === 1,
    anchor ? `type=${anchor.anchor_type} src=${anchor.source} conf=${anchor.confirmed}` : 'missing')
  record('删 auto 锚后 spatial/manual 行仍在（AC4）',
    db.prepare("SELECT COUNT(*) c FROM scene_anchors WHERE episode_id=3 AND anchor_type='spatial' AND source='manual'").get().c === 1)
  record('锚行 image_url = 代表场定稿图（裸路径）', anchor && anchor.image_url === '/uploads/asset-scene-1.png', anchor?.image_url)
}

// ── 用例 4（验收点 4 / KD6）：skip 无 spatial 行；先 confirm 再 skip → 行被删除 ──
{
  const db = setupDb()
  addEpisode(db, 3)
  addScene(db, 1, 3, 1, '谷底仰看断桥', '/uploads/asset-scene-1.png')
  addAnalysis(db, 3, 1, 1, 'cliff_river')
  const svc = makeService(db)

  // 直接 skip（无确定行）
  const s1 = await svc.decideSpatialGroup({ episodeId: 3, group: 'cliff_river', action: 'skip' })
  const afterSkip = db.prepare("SELECT COUNT(*) c FROM scene_anchors WHERE episode_id=3 AND anchor_type='spatial'").get().c
  record('skip 后无 spatial 行', s1.status === 'skipped' && afterSkip === 0, `status=${s1.status} count=${afterSkip}`)

  // 先 confirm 再 skip
  await svc.decideSpatialGroup({ episodeId: 3, group: 'cliff_river', action: 'confirm' })
  const before = db.prepare("SELECT COUNT(*) c FROM scene_anchors WHERE episode_id=3 AND anchor_type='spatial'").get().c
  const s2 = await svc.decideSpatialGroup({ episodeId: 3, group: 'cliff_river', action: 'skip' })
  const after = db.prepare("SELECT COUNT(*) c FROM scene_anchors WHERE episode_id=3 AND anchor_type='spatial'").get().c
  record('先 confirm 再 skip：删锚行（KD6）', before === 1 && after === 0, `before=${before} after=${after}`)
  record('skip 后 review 状态 = skipped', s2.status === 'skipped' && db.prepare("SELECT status FROM spatial_group_review WHERE episode_id=3 AND spatial_group=?").get('cliff_river').status === 'skipped')
}

// ── 用例 5（验收点 5 / AC8）：集隔离 —— ep3 全确认后查 ep4 仍全 pending ──
// ⚠️ 2026-09-17 夹具修正：本用例原用**单场景组**，而单场景组现由 SYNC_SOLO_SQL 恒落 skipped
// （参考图对单场景组无下游，见 spatialGroupReview.js 的 SYNC_SOLO_SQL 注释）——夹具不补第二个
// 场景就会被新特性判为 skipped，测的就不再是「集隔离」而是「单场景下沉」。故每组补足 2 个场景，
// 恢复本用例的原始意图（跨集状态隔离）。单场景行为的专项覆盖见下方「用例 9」。
{
  const db = setupDb()
  addEpisode(db, 3)
  addEpisode(db, 4)
  // ep3：cliff_river（scene 1 有图，2 个成员）
  addScene(db, 1, 3, 1, '谷底仰看断桥', '/uploads/asset-scene-1.png')
  addScene(db, 2, 3, 2, '崖顶俯视断桥')
  addAnalysis(db, 3, 1, 1, 'cliff_river', '谷底浅滩仰视')
  addAnalysis(db, 3, 2, 2, 'cliff_river', '崖顶俯视谷底')
  // ep4：bridge（scene 10 无图 —— 测试 pending 计数不要求有图；2 个成员）
  addScene(db, 10, 4, 10, '桥上')
  addScene(db, 11, 4, 11, '桥下')
  addAnalysis(db, 4, 10, 10, 'bridge', '桥面平视')
  addAnalysis(db, 4, 11, 11, 'bridge', '桥下仰视')
  const svc = makeService(db)

  await svc.decideSpatialGroup({ episodeId: 3, group: 'cliff_river', action: 'confirm' })
  const ep3 = (await svc.getSpatialGroupReviewStatus(3)).groups[0]
  const ep4 = await svc.getSpatialGroupReviewStatus(4)

  record('ep3 确认后状态 confirmed', ep3.status === 'confirmed', ep3.status)
  record('ep4 仍为 pending（集隔离）', ep4.total === 1 && ep4.pending === 1 && ep4.groups[0].status === 'pending', `total=${ep4.total} pending=${ep4.pending}`)
  record('ep4 含新组 bridge', ep4.groups[0].group === 'bridge', ep4.groups[0].group)
}

// ── 用例 6（验收点 6 / §3.4-1）：分析中消失的组不进 total/pending ──
// ⚠️ 2026-09-17 夹具修正：同用例 5，补足 2 个场景以避开单场景组下沉逻辑。
{
  const db = setupDb()
  addEpisode(db, 3)
  addScene(db, 1, 3, 1, '谷底仰看断桥', '/uploads/asset-scene-1.png')
  addScene(db, 2, 3, 2, '崖顶俯视断桥')
  addAnalysis(db, 3, 1, 1, 'cliff_river', '谷底浅滩仰视')
  addAnalysis(db, 3, 2, 2, 'cliff_river', '崖顶俯视谷底')
  const svc = makeService(db)
  await svc.syncSpatialGroupReview(3)
  // 手动塞一个孤儿 review 行（对应已从分析里消失的组）
  db.prepare("INSERT INTO spatial_group_review (episode_id, spatial_group, rep_scene_id, rep_scene_number, status) VALUES (3,'ghost',0,0,'pending')").run()
  const status = await svc.getSpatialGroupReviewStatus(3)
  record('孤儿 review 行不进 total', status.total === 1, `total=${status.total}`)
  record('孤儿 review 行不进 pending', status.pending === 1 && status.groups.length === 1, `pending=${status.pending}`)
  record('返回的组是 cliff_river 而非 ghost', status.groups[0].group === 'cliff_river', status.groups[0].group)
}

// ── 用例 7（错误码覆盖）：组不存在 → 404；无基准图 confirm → 409 ──
{
  const db = setupDb()
  addEpisode(db, 3)
  addScene(db, 1, 3, 1, '谷底仰看断桥')  // 无图
  addAnalysis(db, 3, 1, 1, 'cliff_river')
  const svc = makeService(db)

  let err404 = null
  try { await svc.decideSpatialGroup({ episodeId: 3, group: 'nope', action: 'confirm' }) } catch (e) { err404 = e }
  record('组不存在 → 404 group_not_found', err404 && err404.status === 404 && err404.message === 'group_not_found', err404?.message)

  let err409 = null
  try { await svc.decideSpatialGroup({ episodeId: 3, group: 'cliff_river', action: 'confirm' }) } catch (e) { err409 = e }
  record('代表场无图 confirm → 409 no_baseline_image', err409 && err409.status === 409 && err409.message === 'no_baseline_image', err409?.message)

  let err400 = null
  try { await svc.decideSpatialGroup({ episodeId: 3, group: 'cliff_river', action: 'explode' }) } catch (e) { err400 = e }
  record('非法 action → 400', err400 && err400.status === 400, err400?.message)
}

// ── 用例 8（§3.4-3）：代表场离开组 → 回退 pending（与 §3.4-2 刷新不覆盖 status 区分）──
// ⚠️ 2026-09-17 夹具修正：原夹具用单场景组，confirm 会被 SYNC_SOLO_SQL 直接落 skipped，
// 走不到「回退 pending」分支。补足 2 个场景，让本用例真正覆盖 §3.4-3。
{
  const db = setupDb()
  addEpisode(db, 3)
  addScene(db, 1, 3, 1, '谷底仰看断桥', '/uploads/asset-scene-1.png')
  addScene(db, 3, 3, 3, '河心平视')
  addAnalysis(db, 3, 1, 1, 'cliff_river')
  addAnalysis(db, 3, 3, 3, 'cliff_river')
  const svc = makeService(db)
  await svc.decideSpatialGroup({ episodeId: 3, group: 'cliff_river', action: 'confirm' })
  // 代表场 1 离开组：删其 scene_analysis 行；新场景 2 入场成为新代表场
  db.prepare('DELETE FROM scene_analysis WHERE episode_id=3 AND scene_id=1').run()
  addScene(db, 2, 3, 2, '崖顶俯视断桥', '/uploads/asset-scene-2.png')
  addAnalysis(db, 3, 2, 2, 'cliff_river')
  await svc.syncSpatialGroupReview(3)
  const row = db.prepare('SELECT rep_scene_id, status FROM spatial_group_review WHERE episode_id=3 AND spatial_group=?').get('cliff_river')
  record('代表场离开组 → 回退 pending（§3.4-3）', row.status === 'pending' && row.rep_scene_id === 2, JSON.stringify(row))
}

// ── 用例 9（2026-09-17 单场景组下沉）：成员数 ≤1 的组恒落 skipped，不计入 pending ──
// 背景：参考图的价值是「一图定义空间、其余照着画」；只有一个场景时没有"其余"，
// 定参考图无下游。故单场景组恒 skipped、不造待办、不锁成员卡。
// 双向验证：① 单场景组不产生待办；② 组内补进第二个场景后，自动回到 pending 重新待办（自愈）。
{
  const db = setupDb()
  addEpisode(db, 3)
  addScene(db, 1, 3, 1, '独苗场景', '/uploads/asset-scene-1.png')
  addAnalysis(db, 3, 1, 1, 'lone_spot', '唯一视角')
  const svc = makeService(db)

  const solo = await svc.getSpatialGroupReviewStatus(3)
  const soloRow = db.prepare("SELECT status FROM spatial_group_review WHERE episode_id=3 AND spatial_group=?").get('lone_spot')
  record('单场景组恒落 skipped（不造待办）', soloRow.status === 'skipped', `status=${soloRow.status}`)
  record('单场景组不计入 pending', solo.pending === 0 && solo.total === 1, `total=${solo.total} pending=${solo.pending}`)

  // 补进第二个场景 → 回到 pending（自愈）
  addScene(db, 2, 3, 2, '第二个视角', '/uploads/asset-scene-2.png')
  addAnalysis(db, 3, 2, 2, 'lone_spot', '另一机位')
  const grown = await svc.getSpatialGroupReviewStatus(3)
  const grownRow = db.prepare("SELECT status FROM spatial_group_review WHERE episode_id=3 AND spatial_group=?").get('lone_spot')
  record('组内补进第二场后回到 pending（自愈）', grownRow.status === 'pending' && grown.pending === 1, `status=${grownRow.status} pending=${grown.pending}`)
}

const failed = results.filter((r) => !r.ok)
process.stdout.write(`\n==== spatialGroupReview: ${results.length - failed.length}/${results.length} passed ====\n`)
if (failed.length) {
  process.stdout.write(`FAILED: ${failed.map((f) => f.name).join(', ')}\n`)
  process.exit(1)
}
