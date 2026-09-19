// 空间锚端到端验证：证明「串行后能取到前序定稿图」真的成立（QA / 严过关）
//
// 做法：用 :memory: SQLite 复刻真实约束（sceneAnchors.js:370-377 的空间锚 SQL 一字不改），
// 复刻真实时序（generate-image.js:837 拿锁 → 898 buildAnchorRefsForScene → 1042 UPDATE image_url
// → 1082 finally 放锁），模拟 ep4 的 91/92/93（同属 cliff_river）。
//
// 判定标准：
//   对照组（不串行 = 修复前行为）→ 锚点数 [0, 0, 0]，复现缺陷
//   修复后（串行）              → 锚点数 [0, 1, 2]
// 分布不是这个值就说明修复没生效。
//
// 只读、零网络、零 AI 费用、不碰 server/data.db。可重复运行。

import Database from 'better-sqlite3'
import { acquireSpatialGroupLock, releaseSpatialGroupLock } from '../ai/spatialGroupLock.js'

const results = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function record(name, ok, detail = '') {
  results.push({ name, ok })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ::  ${detail}` : ''}\n`)
}

const EP = 4
const GROUP = 'cliff_river'
// 复刻真实事故现场：第 2 集(episode_id=4) 场景 91/92/93 同属 cliff_river
const SCENES = [
  { id: 91, no: 91, title: '雪山边界悬崖' },
  { id: 92, no: 92, title: '冰河边断桥' },
  { id: 93, no: 93, title: '冰河' },
]

function setupDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE scenes (id INTEGER PRIMARY KEY, episode_id INTEGER, scene_number INTEGER, title TEXT, image_url TEXT);
    CREATE TABLE scene_analysis (episode_id INTEGER, scene_id INTEGER, scene_number INTEGER,
                                 spatial_group TEXT, spatial_role TEXT, props_json TEXT);
  `)
  const insScene = db.prepare('INSERT INTO scenes (id, episode_id, scene_number, title, image_url) VALUES (?,?,?,?,\'\')')
  const insAna = db.prepare('INSERT INTO scene_analysis (episode_id, scene_id, scene_number, spatial_group, spatial_role, props_json) VALUES (?,?,?,?,?,?)')
  for (const s of SCENES) {
    insScene.run(s.id, EP, s.no, s.title)
    insAna.run(EP, s.id, s.no, GROUP, `视角${s.no}`, '[]') // props_json 空 → 只算空间锚
  }
  return db
}

// ===== 一字不改复刻 sceneAnchors.js:370-377（buildAnchorRefsForScene 空间锚段）=====
const MATES_SQL = `SELECT s.id, s.title, s.image_url, s.scene_number, sa.spatial_role
       FROM scene_analysis sa
       JOIN scenes s ON s.id = sa.scene_id
       WHERE sa.episode_id = ? AND sa.spatial_group = ? AND sa.scene_id != ? AND TRIM(s.image_url) != ''
       ORDER BY ABS(s.scene_number - ?) ASC`
const MAX_SPATIAL_REFS = 2 // sceneAnchors.js:38

function spatialAnchorCount(db, sceneId) {
  const row = db.prepare('SELECT spatial_group FROM scene_analysis WHERE episode_id = ? AND scene_id = ?').get(EP, sceneId)
  if (!row || !row.spatial_group) return 0
  const cur = db.prepare('SELECT scene_number FROM scenes WHERE id = ?').get(sceneId)
  return db.prepare(MATES_SQL).all(EP, row.spatial_group, sceneId, cur?.scene_number || 0)
    .slice(0, MAX_SPATIAL_REFS).length
}

// ===== 复刻 /asset-image 的真实时序 =====
// serialize=false 时 lockKey 为空 → acquireSpatialGroupLock 返回 null = 修复前行为
async function generateSceneImage(db, sceneId, { serialize = true, log = null, failAt = null } = {}) {
  const lockKey = serialize ? `${EP}:${GROUP}` : ''
  // generate-image.js:832-844 —— 拿锁（在 buildAnchorRefsForScene 之前）
  const entry = await acquireSpatialGroupLock(lockKey, `scene#${sceneId}`)
  try {
    if (log) log.push(`${sceneId}:acquired`)
    // generate-image.js:898 —— 取空间锚（只认已落库 image_url 的邻场）
    const anchors = spatialAnchorCount(db, sceneId)
    if (log) log.push(`${sceneId}:anchor=${anchors}`)
    await sleep(15) // 模拟生图 HTTP 调用（真实耗时 26~40s）
    if (failAt === sceneId) throw new Error('生图接口 500(模拟)')
    // generate-image.js:1042 —— UPDATE scenes SET image_url
    db.prepare('UPDATE scenes SET image_url = ? WHERE id = ?')
      .run(`/uploads/asset-scene-${sceneId}-${Date.now()}.png`, sceneId)
    if (log) log.push(`${sceneId}:updated`)
    return anchors
  } finally {
    // generate-image.js:1082 —— finally 放锁
    releaseSpatialGroupLock(entry)
    if (log) log.push(`${sceneId}:released`)
  }
}

// ── 用例 1：对照组 —— 不串行（修复前行为）必须复现缺陷 [0,0,0] ──────────────
{
  const db = setupDb()
  const counts = await Promise.all(SCENES.map((s) => generateSceneImage(db, s.id, { serialize: false })))
  record('对照（不串行）锚点数 = [0,0,0]，成功复现缺陷',
    JSON.stringify(counts) === '[0,0,0]', `counts=${JSON.stringify(counts)}`)
  const imgs = db.prepare('SELECT id, image_url FROM scenes ORDER BY id').all()
  record('对照组三张图最后都落库了（只是彼此没当锚）',
    imgs.every((r) => String(r.image_url || '').trim() !== ''), JSON.stringify(imgs.map((r) => !!r.image_url)))
}

// ── 用例 2：修复后（串行）必须得到 [0,1,2] ──────────────────────────────────
{
  const db = setupDb()
  const counts = await Promise.all(SCENES.map((s) => generateSceneImage(db, s.id, { serialize: true })))
  record('修复后（串行）锚点数 = [0,1,2]',
    JSON.stringify(counts) === '[0,1,2]', `counts=${JSON.stringify(counts)}`)
  record('修复后锚点总数显著高于对照组',
    counts.reduce((a, b) => a + b, 0) === 3, `sum=${counts.reduce((a, b) => a + b, 0)}`)
}

// ── 用例 3：时序证据 —— 每张都是「先 UPDATE image_url、后放锁、再下一张取锚」──
{
  const db = setupDb()
  const log = []
  await Promise.all(SCENES.map((s) => generateSceneImage(db, s.id, { serialize: true, log })))
  const expected = [
    '91:acquired', '91:anchor=0', '91:updated', '91:released',
    '92:acquired', '92:anchor=1', '92:updated', '92:released',
    '93:acquired', '93:anchor=2', '93:updated', '93:released',
  ]
  record('时序完全正确（取锚→生图→落库→放锁→下一张取锚）',
    JSON.stringify(log) === JSON.stringify(expected), `log=${JSON.stringify(log)}`)
}

// ── 用例 4：组内首张抛异常 → 后续不许卡死，且仍能取到锚 ─────────────────────
{
  const db = setupDb()
  const log = []
  const out = await Promise.all(SCENES.map((s) =>
    generateSceneImage(db, s.id, { serialize: true, log, failAt: 91 }).catch((e) => `ERR:${e.message}`)))
  record('首张抛异常后，后续两张照常执行（未卡死）',
    typeof out[1] === 'number' && typeof out[2] === 'number', `out=${JSON.stringify(out)}`)
  record('失败的那张没落库，未污染后续锚点',
    String(db.prepare('SELECT image_url FROM scenes WHERE id = 91').get().image_url || '') === '',
    `91.image_url='${db.prepare('SELECT image_url FROM scenes WHERE id = 91').get().image_url}'`)
  record('失败后后续锚点数 = [0,1]（92 无锚、93 以 92 为锚）',
    JSON.stringify([out[1], out[2]]) === '[0,1]', `counts=${JSON.stringify([out[1], out[2]])}`)
}

// ── 用例 5：逆序提交（93,92,91）—— 锁仍生效，但谁当锚由到达顺序决定 ────────
{
  const db = setupDb()
  const counts = await Promise.all([...SCENES].reverse().map((s) => generateSceneImage(db, s.id, { serialize: true })))
  const sum = counts.reduce((a, b) => a + b, 0)
  record('逆序提交时锁依然生效（无并发重叠，锚点总数=3）', sum === 3,
    `counts(93,92,91)=${JSON.stringify(counts)} sum=${sum}`)
  process.stdout.write(`   [提示] 逆序时锚点分布=${JSON.stringify(counts)}（93=0,92=1,91=2）——` +
    `后端锁只保证串行，不保证「场次靠前的先画」，排序由前端 buildSceneGroupChains 负责\n`)
}

// ── 用例 6：不同空间组之间不串行（吞吐未被牺牲）────────────────────────────
{
  const db = setupDb()
  db.prepare('UPDATE scene_analysis SET spatial_group = ? WHERE episode_id = ? AND scene_id = ?').run('other_group', EP, 93)
  let cur = 0
  let peak = 0
  const timed = SCENES.map(async (s) => {
    const entry = await acquireSpatialGroupLock(`${EP}:${s.id === 93 ? 'other_group' : GROUP}`, `scene#${s.id}`)
    cur += 1; peak = Math.max(peak, cur)
    await sleep(20)
    cur -= 1
    releaseSpatialGroupLock(entry)
  })
  await Promise.all(timed)
  record('不同空间组之间并发（峰值>=2）', peak >= 2, `peak=${peak}`)
}

const failed = results.filter((r) => !r.ok)
process.stdout.write(`\n==== sceneSpatialAnchor: ${results.length - failed.length}/${results.length} passed ====\n`)
if (failed.length) {
  process.stdout.write(`FAILED: ${failed.map((f) => f.name).join(', ')}\n`)
  process.exit(1)
}
