// 分组人审锁定 · 测试（2026-09-17）
//
// 覆盖：
//   A. applyGroupLocks 纯函数语义（锁定覆盖 / 未锁保留 / 只改一个字段）
//   B. 读写锁（:memory: 真表，含幂等与部分解锁）
//   C. 概览与**孤儿组锚检测** —— 这是本方案要解决的伤口的直接体现
//   D. 静态断言：sceneAnchors 真在重析路径上应用了锁
//   E. 通用性铁律：锁的是数据（scene_id→组名），零题材词表/零正则

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import Database from 'better-sqlite3'
import {
  loadGroupLocks, applyGroupLocks, saveGroupLocks, clearGroupLocks, getGroupLockOverview,
} from '../ai/sceneGroupLock.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ::  ${detail}` : ''}\n`)
}

// ===== A. applyGroupLocks：纯函数语义 =====
record('【核心】锁定场景：组名被强制改为锁定值（覆盖 LLM 的重组）',
  (() => {
    const rows = [{ scene_id: 1, spatial_group: 'merged_group' }]
    const out = applyGroupLocks(rows, new Map([[1, 'original_group']]))
    return out.rows[0].spatial_group === 'original_group'
  })())

record('【核心】未锁定场景：保留 LLM 判定（新增场次照常分析）',
  (() => {
    const rows = [{ scene_id: 1, spatial_group: 'locked_g' }, { scene_id: 2, spatial_group: 'llm_new_g' }]
    const out = applyGroupLocks(rows, new Map([[1, 'locked_g']]))
    return out.rows[1].spatial_group === 'llm_new_g'
  })())

record('【核心】只覆盖 spatial_group，其余字段一律保留 LLM 本轮结果',
  (() => {
    const rows = [{ scene_id: 1, spatial_group: 'x', spatial_role: '新视角', props: ['a'], elements: ['b'] }]
    const out = applyGroupLocks(rows, new Map([[1, 'locked']]))
    const r = out.rows[0]
    return r.spatial_role === '新视角' && r.props[0] === 'a' && r.elements[0] === 'b'
  })(),
  '锁是"分组"一把锁，不该顺手冻住角色/道具/要素 —— 那些每轮都该重算')

record('计数正确：lockedCount = 命中锁的行数',
  (() => {
    const out = applyGroupLocks(
      [{ scene_id: 1, spatial_group: 'a' }, { scene_id: 2, spatial_group: 'b' }, { scene_id: 3, spatial_group: 'c' }],
      new Map([[1, 'a'], [3, 'c']])
    )
    return out.lockedCount === 2
  })())

record('计数正确：changedCount 只统计"被纠正"的行（组名真变了）',
  (() => {
    const out = applyGroupLocks(
      [{ scene_id: 1, spatial_group: 'same' }, { scene_id: 2, spatial_group: 'diff' }],
      new Map([[1, 'same'], [2, 'locked']])
    )
    return out.lockedCount === 2 && out.changedCount === 1
  })())

record('无锁（空 Map）→ rows 原样返回，逐字退回未改造行为',
  (() => {
    const rows = [{ scene_id: 1, spatial_group: 'a' }]
    const out = applyGroupLocks(rows, new Map())
    return out.rows === rows && out.lockedCount === 0
  })())

record('脏输入不抛错（null rows / 非 Map 锁 / 缺字段的行）',
  (() => {
    return applyGroupLocks(null, new Map()).rows.length === 0
      && applyGroupLocks([], null).rows.length === 0
      && applyGroupLocks([{}], new Map([[1, 'g']])).rows.length === 1
      && applyGroupLocks([{ scene_id: '1', spatial_group: '' }], new Map()).rows.length === 1
  })())

record('不新增也不删除行（行数守恒）',
  applyGroupLocks([{ scene_id: 1 }, { scene_id: 2 }], new Map([[99, 'ghost']])).rows.length === 2,
  '锁里指向已不存在的场次时，不会凭空造行')

// ===== B. 读写锁（:memory:）=====
const db = new Database(':memory:')
db.exec(`
  CREATE TABLE scene_group_locks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, episode_id INTEGER NOT NULL, scene_id INTEGER NOT NULL,
    spatial_group TEXT NOT NULL, note TEXT DEFAULT '',
    UNIQUE(episode_id, scene_id));
`)
const adapter = {
  query: (sql, p = []) => db.prepare(sql).all(...p),
  queryOne: (sql, p = []) => db.prepare(sql).get(...p),
  execute: (sql, p = []) => db.prepare(sql).run(...p),
}

const saved = saveGroupLocks(1, [{ scene_id: 11, spatial_group: 'cliff_river', spatial_role: 'x' }], adapter, { note: '人审' })
record('写入锁成功', saved.locked === 1)

const loaded = loadGroupLocks(1, adapter)
record('回读锁：scene_id → 组名 映射正确', loaded.get(11) === 'cliff_river', JSON.stringify([...loaded]))

saveGroupLocks(1, [{ scene_id: 11, spatial_group: 'new_group' }], adapter, { note: '改' })
record('幂等：同一 scene_id 重复锁 → 更新组名而非新增行', (() => {
  const c = db.prepare('SELECT COUNT(*) AS c FROM scene_group_locks WHERE episode_id = 1').get()
  return c.c === 1 && loadGroupLocks(1, adapter).get(11) === 'new_group'
})())

saveGroupLocks(1, [{ scene_id: 12, spatial_group: 'g2' }, { scene_id: 13, spatial_group: 'g3' }], adapter)
record('多场次锁互不干扰', loadGroupLocks(1, adapter).size === 3)

record('集隔离：不同 episode 的锁互不可见', (() => {
  saveGroupLocks(2, [{ scene_id: 11, spatial_group: 'other_ep' }], adapter)
  return loadGroupLocks(1, adapter).get(11) === 'new_group'
    && loadGroupLocks(2, adapter).get(11) === 'other_ep'
})())

record('部分解锁：只解指定场次，其余保留', (() => {
  const r = clearGroupLocks(1, adapter, { sceneIds: [12] })
  const m = loadGroupLocks(1, adapter)
  return r.removed === 1 && !m.has(12) && m.has(11) && m.has(13)
})())

record('全部解锁：不给 sceneIds → 清空该集', (() => {
  const r = clearGroupLocks(1, adapter, {})
  return r.removed === 2 && loadGroupLocks(1, adapter).size === 0
})())

record('解锁不影响别的集', loadGroupLocks(2, adapter).size === 1)

record('表不存在时读锁降级为空 Map（不抛错，退回未改造行为）', (() => {
  const empty = new Database(':memory:')
  const bad = {
    query: (sql, p = []) => empty.prepare(sql).all(...p),
    queryOne: (sql, p = []) => empty.prepare(sql).get(...p),
    execute: () => {},
  }
  return loadGroupLocks(1, bad).size === 0
})())

// ===== C. 概览 + 孤儿组锚检测（本方案要解决的伤口）=====
const db2 = new Database(':memory:')
db2.exec(`
  CREATE TABLE scene_group_locks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, episode_id INTEGER NOT NULL, scene_id INTEGER NOT NULL,
    spatial_group TEXT NOT NULL, note TEXT DEFAULT '', UNIQUE(episode_id, scene_id));
  CREATE TABLE scenes (id INTEGER PRIMARY KEY, scene_number INTEGER, title TEXT);
  CREATE TABLE scene_analysis (episode_id INTEGER, scene_id INTEGER, spatial_group TEXT);
  CREATE TABLE scene_anchors (episode_id INTEGER, anchor_type TEXT, anchor_key TEXT, image_url TEXT, confirmed INTEGER DEFAULT 0);
`)
dbdbInit()
function dbdbInit() {
  const ins = db2.prepare('INSERT INTO scenes (id, scene_number, title) VALUES (?,?,?)')
  ins.run(1, 1, '雪山边界悬崖'); ins.run(2, 2, '冰河边断桥'); ins.run(3, 3, '冰河')
  ins.run(6, 6, '森林高地巨岩'); ins.run(7, 7, '森林高地巨岩夜景')
  const sa = db2.prepare('INSERT INTO scene_analysis (episode_id, scene_id, spatial_group) VALUES (?,?,?)')
  // 现状：场1-3 一组，场6-7 被并进了 forest_lake
  sa.run(4, 1, 'cliff_river'); sa.run(4, 2, 'cliff_river'); sa.run(4, 3, 'cliff_river')
  sa.run(4, 6, 'forest_lake'); sa.run(4, 7, 'forest_lake')
  const an = db2.prepare('INSERT INTO scene_anchors (episode_id, anchor_type, anchor_key, image_url, confirmed) VALUES (?,?,?,?,?)')
  an.run(4, 'spatial', 'cliff_river', '/uploads/live.png', 1)        // 有归属，正常
  an.run(4, 'spatial', 'forest_high_rock', '/uploads/orphan.png', 1) // 无场次归属 → 孤儿
  an.run(4, 'layout', 'cliff_river', '/uploads/layout.png', 1)       // 非 spatial，不该被算进来
}
const adapter2 = {
  query: (sql, p = []) => db2.prepare(sql).all(...p),
  queryOne: (sql, p = []) => db2.prepare(sql).get(...p),
  execute: (sql, p = []) => db2.prepare(sql).run(...p),
}

record('【核心】孤儿组锚被检出（这正是分组漂移造成的伤口）', (() => {
  const ov = getGroupLockOverview(4, adapter2)
  return ov.orphanAnchors.length === 1 && ov.orphanAnchors[0].group === 'forest_high_rock'
})())

record('【核心】有归属的组锚不被误报为孤儿',
  !getGroupLockOverview(4, adapter2).orphanAnchors.some((a) => a.group === 'cliff_river'))

record('【核心】非 spatial 类型锚（如 layout）不参与孤儿判定',
  !getGroupLockOverview(4, adapter2).orphanAnchors.some((a) => a.group === 'layout'))

record('孤儿锚带 confirmed 标记（前端可区分"人审基綫失效"与普通锚）',
  getGroupLockOverview(4, adapter2).orphanAnchors[0].confirmed === true)

record('概览：锁清单含场次号与组名，按场次排序', (() => {
  saveGroupLocks(4, [{ scene_id: 3, spatial_group: 'cliff_river' }, { scene_id: 1, spatial_group: 'cliff_river' }], adapter2)
  const ov = getGroupLockOverview(4, adapter2)
  return ov.locks.length === 2 && ov.locks[0].sceneNumber === 1 && ov.locks[0].group === 'cliff_river'
})())

record('概览：坏库不抛错（缺表 → 空结果 + 降级）', (() => {
  const empty = new Database(':memory:')
  const bad = {
    query: (sql, p = []) => empty.prepare(sql).all(...p),
    queryOne: (sql, p = []) => empty.prepare(sql).get(...p),
    execute: () => {},
  }
  const ov = getGroupLockOverview(1, bad)
  return Array.isArray(ov.locks) && Array.isArray(ov.orphanAnchors)
    && ov.locks.length === 0 && ov.orphanAnchors.length === 0
})())

// ===== D. 静态断言：锁真的接在重析路径上 =====
const anchorSrc = readFileSync(path.join(ROOT, 'server/ai/sceneAnchors.js'), 'utf8')

record('【核心】重析路径里真的调用了 loadGroupLocks',
  anchorSrc.includes('loadGroupLocks(episodeId,'))

record('【核心】重析路径里真的调用了 applyGroupLocks（LLM 结果被锁覆盖）',
  /const \{ rows, lockedCount, changedCount \} = applyGroupLocks\(llmRows, locks\)/.test(anchorSrc))

record('【核心】锁在落库（DELETE/INSERT）之前生效',
  anchorSrc.indexOf('applyGroupLocks(llmRows, locks)') < anchorSrc.indexOf("DELETE FROM scene_analysis WHERE episode_id = ?"),
  '顺序反了就等于没锁')

record('【核心】锁表不在重析的 DELETE 范围内（表存活）',
  !/DELETE FROM scene_group_locks[\s\S]{0,80}?ensureSceneAnalysis/.test(anchorSrc))

const routeSrc = readFileSync(path.join(ROOT, 'server/routes/generate-image.js'), 'utf8')
record('路由暴露三个锁定端点（查/锁/解锁）',
  routeSrc.includes("router.get('/scene-groups/locks'")
  && routeSrc.includes("router.post('/scene-groups/locks'")
  && routeSrc.includes("router.delete('/scene-groups/locks'"))

record('端点不触发重析（锁与重析解耦，避免误触）',
  (() => {
    const seg = routeSrc.slice(routeSrc.indexOf("router.get('/scene-groups/locks'"))
    const block = seg.slice(0, seg.indexOf('// 形象版本历史'))
    return !/ensureSceneAnalysis\(/.test(block)
  })())

const schemaSql = readFileSync(path.join(ROOT, 'server/schema.sql'), 'utf8')
record('schema.sql 建了 scene_group_locks 表（老库靠 CREATE TABLE IF NOT EXISTS 自动补）',
  /CREATE TABLE IF NOT EXISTS scene_group_locks/.test(schemaSql))

// ===== E. 通用性铁律 =====
const lockSrc = readFileSync(path.join(ROOT, 'server/ai/sceneGroupLock.js'), 'utf8')

record('【通用性】锁的是数据（scene_id → 组名字符串），代码不解析组名语义',
  !/group\.(split|match|includes|startsWith|test)\(/.test(lockSrc),
  '组名是 LLM 命名的任意 snake_case 串，代码只当不透明字符串搬运')

record('【通用性】零题材词表（不出现任何题材实词做判断）',
  !/if\s*\([^)]*(断桥|崖|冰河|松林|森林|湖泊|熊猫|白熊)[^)]*\)/.test(lockSrc))

record('【通用性】零正则匹配组名（不假设命名规则）',
  !/new RegExp|\.replace\(\/|\/\\w\+/.test(lockSrc))

record('【通用性】不新增告警体系（复用既有 alerts 之外也不自造）',
  !/recordAlert/.test(lockSrc),
  '孤儿锚通过接口暴露给前端，不写库告警 —— 避免与既有告警语义重叠')

// 【踩过的坑】SQLite 里双引号是标识符、单引号才是字符串字面量。
// 空串比较若写成 != "" 会直接报 `no such column: ""`（实测踩过并修）。
// 这条守护的是"别再写回去"，且扫的是**全仓后端代码**而非单个文件。
record('【踩坑护栏】后端代码不含 SQL 里的双引号空串比较（!= "" / == ""）', (() => {
  const dirs = ['server/ai', 'server/routes']
  for (const d of dirs) {
    const abs = path.join(ROOT, d)
    let entries = []
    try { entries = readdirSync(abs) } catch { continue }
    for (const f of entries) {
      if (!f.endsWith('.js') || f.includes('.bak')) continue
      const src = readFileSync(path.join(abs, f), 'utf8')
      if (/!=\s*""|==\s*""/.test(src)) return false
    }
  }
  return true
})(), 'SQLite 双引号是标识符 —— 空串必须用单引号')

// 汇总
const passed = results.filter((r) => r.ok).length
const failed = results.length - passed
process.stdout.write(`\n==== sceneGroupLock: ${passed}/${results.length} passed ====\n`)
if (failed) {
  process.stdout.write(`FAILED:\n${results.filter((r) => !r.ok).map((r) => '  - ' + r.name).join('\n')}\n`)
  process.exit(1)
}
