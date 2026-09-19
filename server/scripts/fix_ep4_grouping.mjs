// 一次性数据修复：恢复 episode 4 的空间分组为 4 组，并锁定已确认场次
//
// 背景：LLM 重析把原来的 4 组（cliff_river / forest_edge / forest_valley / forest_high_rock）
//   合并成 2 组（cliff_river / forest_lake），使已确认的组锚 forest_high_rock 变孤儿。
//
// 依据（全部来自 scenes.summary 的明文表述，非人工臆断）：
//   sn4「对岸缓坡草地，草地尽头森林矗立…溪谷方向白色水汽贴着草地在树影间漫上来」
//       → 在草地/森林入口，向溪谷方向**远望** → forest_edge
//   sn5「森林深处的溪谷地带，雾浓到三步外不见物…」
//       → 已进入森林**内部**的溪谷 → forest_valley
//   sn6/sn7「森林高处的巨岩，视野开阔，岩下是湖泊与花海」/「巨岩上，夜幕降临」
//       → 同一处巨岩，昼夜两版 → forest_high_rock（与既有孤儿锚 scene_number=6 吻合）
//
// 锁定策略（按用户决定，2026-09-17 修订）：**锁全部 7 场**。
//   ⚠️ 为什么从"只锁已确认场次"改成"全锁"——实测证据：
//     先按"只锁 sn1-3"执行，紧接着 force 重析，LLM 立刻把 sn4-7 重新合并
//     （forest_lake → forest_lakeside，8 秒内），刚恢复的 4 组当场被冲掉，
//     forest_high_rock 锚**再次变孤儿**。
//     结论：**不锁的场次，恢复多少次都保不住**。要保住 4 组结构（以及挂在 sn6 上的
//     forest_high_rock 人审锚），必须把 4 组涉及的全部场次都锁上。
//   代价（已告知用户）：以后**新增**场次不会自动并入这些已锁组，
//     需人工解一次锁再重析；这是"稳定"换来的必然成本，可接受。

import { initDB, query, execute } from '../db.js'

const EPISODE_ID = 4

// scene_number → spatial_group（本集的分组修正表）
const TARGET_GROUPS = {
  1: 'cliff_river',
  2: 'cliff_river',
  3: 'cliff_river',
  4: 'forest_edge',
  5: 'forest_valley',
  6: 'forest_high_rock',
  7: 'forest_high_rock',
}

// 需要锁定的场次（见文件头的锁定策略说明：全部 7 场）
const LOCKED_SCENE_NUMBERS = [1, 2, 3, 4, 5, 6, 7]

initDB()

const scenes = query(
  'SELECT id, scene_number, title FROM scenes WHERE episode_id = ? ORDER BY scene_number',
  [EPISODE_ID]
)
if (!scenes.length) {
  console.error(`[fix] episode ${EPISODE_ID} 无场景，退出`)
  process.exit(1)
}

// ---- 1. 修正 scene_analysis 的 spatial_group ----
const before = query(
  'SELECT scene_number, spatial_group FROM scene_analysis WHERE episode_id = ? ORDER BY scene_number',
  [EPISODE_ID]
)
console.log('=== 修正前 ===')
for (const r of before) console.log(`  sn${r.scene_number} → ${r.spatial_group}`)

let changed = 0
for (const s of scenes) {
  const target = TARGET_GROUPS[s.scene_number]
  if (!target) continue
  const row = query(
    'SELECT spatial_group FROM scene_analysis WHERE episode_id = ? AND scene_id = ?',
    [EPISODE_ID, s.id]
  )[0]
  if (!row) {
    console.warn(`  [skip] sn${s.scene_number} 无分析行`)
    continue
  }
  if (row.spatial_group === target) continue
  execute(
    'UPDATE scene_analysis SET spatial_group = ? WHERE episode_id = ? AND scene_id = ?',
    [target, EPISODE_ID, s.id]
  )
  changed++
}

const after = query(
  'SELECT scene_number, spatial_group, spatial_role FROM scene_analysis WHERE episode_id = ? ORDER BY scene_number',
  [EPISODE_ID]
)
console.log(`\n=== 修正后（改动 ${changed} 行）===`)
for (const r of after) console.log(`  sn${r.scene_number} → ${r.spatial_group}  |  ${r.spatial_role}`)

// ---- 2. 锁定已确认场次 ----
const byNumber = new Map(scenes.map((s) => [s.scene_number, s]))
let locked = 0
for (const sn of LOCKED_SCENE_NUMBERS) {
  const s = byNumber.get(sn)
  if (!s) continue
  const g = query(
    'SELECT spatial_group FROM scene_analysis WHERE episode_id = ? AND scene_id = ?',
    [EPISODE_ID, s.id]
  )[0]?.spatial_group
  if (!g) continue
  execute(
    `INSERT INTO scene_group_locks (episode_id, scene_id, spatial_group, note)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(episode_id, scene_id) DO UPDATE SET spatial_group = excluded.spatial_group, note = excluded.note`,
    [EPISODE_ID, s.id, g, '人审确认（已出图并通过质检）']
  )
  locked++
}
console.log(`\n=== 锁定 ===\n  已锁 ${locked} 场（sn${LOCKED_SCENE_NUMBERS.join(',')}）`)

// ---- 3. 报告孤儿锚现状 ----
const live = new Set(
  query(
    "SELECT DISTINCT spatial_group FROM scene_analysis WHERE episode_id = ? AND TRIM(spatial_group) != ''",
    [EPISODE_ID]
  ).map((r) => r.spatial_group)
)
const anchors = query(
  "SELECT anchor_key, image_url, confirmed FROM scene_anchors WHERE episode_id = ? AND anchor_type = 'spatial'",
  [EPISODE_ID]
)
console.log('\n=== spatial 组锚归属检查 ===')
for (const a of anchors) {
  const ok = live.has(a.anchor_key)
  console.log(`  ${ok ? '[有归属]' : '[孤儿]  '} ${a.anchor_key}  ${a.image_url}`)
}
const orphans = anchors.filter((a) => !live.has(a.anchor_key))
console.log(`\n  孤儿锚数：${orphans.length}`)
