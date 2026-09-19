// 追加修复（v1.1）· 回归单测（2026-09-18）
//
// 覆盖 team-lead 追加的 FIX-7 / FIX-8 / I2 / I3 四项（QA 早前用临时脚本验过、但未落成用例）：
//   A. FIX-4  告警级别三档映射 info→info / warn→warn / error→error / 未知→error
//   B. FIX-5  孤儿 review 行清理（pending 且无 baseline 才删；confirmed/skipped/有 baseline 一律保留）
//      I3    护栏：groups.length===0 时不清理（cleaned:0，绝不误清全表 pending）
//   C. FIX-7  统一包含判据 pickContainmentCandidate（道具侧 resolvePropName + 资产侧 doubao.matchAssetName）
//             并列歧义 → null；最短唯一 → 命中；精确/归一不变
//   D. FIX-8  本集道具清单提示段 buildPropLexiconHint（非空→注入全部名单；空→''）
//   E. 静态守卫：接入点确已接线、旧「遍历序最短」实现已移除、归档卫生（lexicons 下无 .bak_*）
//
// 设计红线（team-lead）：
//   · 不得 import server/db.js（import 即开真实 data.db）→ FIX-4 用「源码抽取沙箱求值」，
//     FIX-5/I3 用「:memory: 工厂注入」，FIX-7 资产侧同样抽取沙箱。零网络、零真库、零 AI 费用。
//   · 「抽取真实实现后求值」胜过「断言源码里有某段字符串」——后者逻辑改错仍会绿。
//   · 用例逐字沿用既有风格：自带判卷、PASS/FAIL 前缀、可重复运行。

import fs from 'node:fs'
import Database from 'better-sqlite3'
import { createSpatialGroupReview } from '../ai/spatialGroupReview.js'
import {
  normalizePropName,
  resolvePropName,
  pickContainmentCandidate,
  buildPropLexiconHint,
} from '../ai/propNameMatch.js'

const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ::  ${detail}` : ''}\n`)
}
function t(name, fn) {
  try { fn() } catch (e) { record(name, false, `EXCEPTION ${e && e.message}`) }
}
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8')

// 从源码抽出顶层 `function name(...) {...}` 的真实实现（缩进收敛到收尾 `}`）。
// 抽取失败（函数被重命名/挪走）→ 返回 null，测试显式失败而非静默跳过。
function extractFn(src, name) {
  const re = new RegExp(`\\n(?:async )?function ${name}\\([^)]*\\) \\{`)
  const m = src.match(re)
  if (!m) return null
  const start = m.index + 1
  const lines = src.slice(start).split('\n')
  let depth = 0
  const out = []
  for (const line of lines) {
    out.push(line)
    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length
    if (depth === 0 && out.length > 1) break
  }
  return out.join('\n')
}

// ══════════════════════════════════════════════════════════════════════════════
// A. FIX-4 告警级别三档映射（从 ai/alerts.js 抽取真实三元表达式求值）
// ══════════════════════════════════════════════════════════════════════════════
const alertsSrc = read('../ai/alerts.js')

t('A0. 从 alerts.js 抽出级别映射表达式', () => {
  const m = alertsSrc.match(
    /a\.level === 'info'\s*\?\s*'info'\s*:\s*\(a\.level === 'warn'\s*\?\s*'warn'\s*:\s*'error'\)/
  )
  record('映射表达式可抽出', !!m, m ? m[0].slice(0, 40) + '…' : '未找到')
  if (m) {
    const mapLevel = new Function('a', `return (${m[0]})`)
    record('info → info', mapLevel({ level: 'info' }) === 'info')
    record('warn → warn', mapLevel({ level: 'warn' }) === 'warn')
    record('error → error', mapLevel({ level: 'error' }) === 'error')
    record('未知值 → error（保守，宁可显性）', mapLevel({ level: 'fatal' }) === 'error')
    record('缺省（undefined）→ error', mapLevel({}) === 'error')
    record('空串 → error', mapLevel({ level: '' }) === 'error')
    record('大小写敏感：INFO → error', mapLevel({ level: 'INFO' }) === 'error')
  }
})

t('A1. 三档映射已写入 INSERT 的取值位（源文本守卫）', () => {
  record('旧实现 `=== warn ? warn : error` 已升级为含 info 的三元', /a\.level === 'info'/.test(alertsSrc))
})

// ══════════════════════════════════════════════════════════════════════════════
// B. FIX-5 孤儿 review 行清理 + I3 护栏（:memory: 工厂注入，零真库）
// ══════════════════════════════════════════════════════════════════════════════
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
function addAnalysis(db, ep, sceneId, no, group, role = '') {
  db.prepare('INSERT INTO scene_analysis (episode_id, scene_id, scene_number, spatial_group, spatial_role, props_json) VALUES (?,?,?,?,?,?)')
    .run(ep, sceneId, no, group, role, '[]')
}
function addReview(db, ep, group, status, baseline = '') {
  db.prepare('INSERT INTO spatial_group_review (episode_id, spatial_group, rep_scene_id, rep_scene_number, status, baseline_image_url) VALUES (?,?,?,?,?,?)')
    .run(ep, group, 0, 0, status, baseline)
}
const reviewRow = (db, ep, group) =>
  db.prepare('SELECT * FROM spatial_group_review WHERE episode_id=? AND spatial_group=?').get(ep, group)

// B1：孤儿 pending（无 baseline）被删；live 组保留；total/pending 以当前分析为准
{
  const db = setupDb()
  addEpisode(db, 3)
  addScene(db, 1, 3, 1, '甲', '/a.png')
  addScene(db, 2, 3, 2, '乙')
  addAnalysis(db, 3, 1, 1, 'live_group')
  addAnalysis(db, 3, 2, 2, 'live_group')
  addReview(db, 3, 'ghostA', 'pending', '')   // 孤儿 pending 无 baseline → 应删
  const svc = makeService(db)

  const r = await svc.syncSpatialGroupReview(3)
  record('B1. cleaned=1（删掉 ghostA）', r.cleaned === 1, `cleaned=${r.cleaned}`)
  record('B1. ghostA 行已删', reviewRow(db, 3, 'ghostA') === undefined)
  record('B1. live_group 行仍在', !!reviewRow(db, 3, 'live_group'))
  record('B1. total = 当前分析组数（1）', r.total === 1, `total=${r.total}`)
  record('B1. pending = 1（live_group 待办）', r.pending === 1, `pending=${r.pending}`)
  record('B1. 孤儿不计入 total', r.total === 1)
}

// B2：pending 有 baseline / confirmed / skipped 三类孤儿一律保留
{
  const db = setupDb()
  addEpisode(db, 3)
  addScene(db, 1, 3, 1, '甲', '/a.png')
  addScene(db, 2, 3, 2, '乙')
  addAnalysis(db, 3, 1, 1, 'live_group')
  addAnalysis(db, 3, 2, 2, 'live_group')
  addReview(db, 3, 'ghostBase', 'pending', '/base.png') // 有 baseline → 保留
  addReview(db, 3, 'ghostConf', 'confirmed', '')
  addReview(db, 3, 'ghostSkip', 'skipped', '')
  const svc = makeService(db)

  const r = await svc.syncSpatialGroupReview(3)
  record('B2. cleaned=0（三类孤儿全保留）', r.cleaned === 0, `cleaned=${r.cleaned}`)
  record('B2. 有 baseline 的 pending 保留', !!reviewRow(db, 3, 'ghostBase'))
  record('B2. confirmed 孤儿保留（人审留痕）', reviewRow(db, 3, 'ghostConf')?.status === 'confirmed')
  record('B2. skipped 孤儿保留（人审留痕）', reviewRow(db, 3, 'ghostSkip')?.status === 'skipped')
}

// B3 / I3：当前分析无任何组（groups=[]）→ 清理整体跳过，绝不误清 pending
{
  const db = setupDb()
  addEpisode(db, 3)
  // 无任何 scene_analysis 行 → GROUPS_SQL 返回空 → liveGroupNames 为空
  addReview(db, 3, 'alpha', 'pending', '')
  addReview(db, 3, 'beta', 'pending', '')
  const svc = makeService(db)

  const r = await svc.syncSpatialGroupReview(3)
  record('B3/I3. cleaned=0（护栏生效，未清理）', r.cleaned === 0, `cleaned=${r.cleaned}`)
  record('B3/I3. alpha 行仍在', !!reviewRow(db, 3, 'alpha'))
  record('B3/I3. beta 行仍在', !!reviewRow(db, 3, 'beta'))
  record('B3/I3. total=0（无分析组）', r.total === 0, `total=${r.total}`)
  record('B3/I3. pending=0', r.pending === 0, `pending=${r.pending}`)
}

// B4：护栏只在「groups 为空」时生效；一旦有真实组，孤儿照常清理（对照，防护栏误伤正常清理）
{
  const db = setupDb()
  addEpisode(db, 3)
  addScene(db, 1, 3, 1, '甲', '/a.png')
  addScene(db, 2, 3, 2, '乙')
  addAnalysis(db, 3, 1, 1, 'live_group')
  addAnalysis(db, 3, 2, 2, 'live_group')
  addReview(db, 3, 'ghostA', 'pending', '')
  addReview(db, 3, 'ghostB', 'pending', '')
  const svc = makeService(db)

  const r = await svc.syncSpatialGroupReview(3)
  record('B4. cleaned=2（两个孤儿都被清）', r.cleaned === 2, `cleaned=${r.cleaned}`)
  record('B4. ghostA 已删', reviewRow(db, 3, 'ghostA') === undefined)
  record('B4. ghostB 已删', reviewRow(db, 3, 'ghostB') === undefined)
}

// ══════════════════════════════════════════════════════════════════════════════
// C. FIX-7 统一包含判据
// ══════════════════════════════════════════════════════════════════════════════

// C1：pickContainmentCandidate 判据本体
t('C1. pickContainmentCandidate：0 个→null / 恰好 1 个→采用 / 最短唯一→采用 / 并列→null', () => {
  record('0 个候选 → null', pickContainmentCandidate('木桥', ['浮冰', '盾牌']) === null)
  record('恰好 1 个 → 采用', pickContainmentCandidate('木桥', ['腐朽木桥', '浮冰']) === '腐朽木桥')
  record('最短唯一 → 采用（木桥 ⊂ 腐朽木桥）', pickContainmentCandidate('木桥', ['腐朽木桥', '木桥']) === '木桥')
  record('并列同长 → null（不猜）', pickContainmentCandidate('桥', ['断桥', '木桥']) === null)
  record('并列同长（更长词）→ null', pickContainmentCandidate('木桥', ['腐朽木桥', '老旧木桥']) === null)
})

t('C2. pickContainmentCandidate：空值/脏值/不修改入参', () => {
  record('raw 空 → null', pickContainmentCandidate('', ['a']) === null && pickContainmentCandidate(null, ['a']) === null)
  record('候选空 → null', pickContainmentCandidate('a', []) === null && pickContainmentCandidate('a', null) === null)
  const cand = ['腐朽木桥', '木桥']
  const snap = JSON.stringify(cand)
  pickContainmentCandidate('木桥', cand)
  record('不修改入参', JSON.stringify(cand) === snap)
})

t('C3. pickContainmentCandidate：minRawLen 护栏', () => {
  record('minRawLen=2：单字 raw → null', pickContainmentCandidate('桥', ['桥头堡'], { minRawLen: 2 }) === null)
  record('minRawLen=1（默认）：单字 raw 可参与', pickContainmentCandidate('桥', ['桥头堡']) === '桥头堡')
})

// C4：道具侧 resolvePropName 复用同一判据
t('C4. resolvePropName 第三级复用 pickContainmentCandidate（最短唯一命中 / 并列不猜）', () => {
  record('最短唯一 → 命中', resolvePropName('木桥', ['腐朽木桥', '木桥']) === '木桥')
  record('并列歧义 → null', resolvePropName('木桥', ['腐朽木桥', '老旧木桥']) === null)
})

t('C5. resolvePropName 一、二级（精确 / 去后缀）行为未变', () => {
  record('① 归一精确命中', resolvePropName('《腐朽木桥》', ['浮冰', '腐朽木桥']) === '腐朽木桥')
  record('① 全角空格命中', resolvePropName('\u3000浮冰\u3000', ['浮冰']) === '浮冰')
  record('② 去状态后缀命中', resolvePropName('桥#broken', ['桥']) === '桥')
  record('③ 道具侧单字护栏（raw<2 不参与包含）', resolvePropName('桥', ['桥头堡']) === null)
})

// C6：资产侧 doubao.matchAssetName 复用同一判据（抽取真实实现沙箱求值）
t('C6. doubao.matchAssetName 复用 pickContainmentCandidate（并列→null / 最短唯一→命中 / 精确归一如常）', () => {
  const doubaoSrc = read('../ai/doubao.js')
  const norm = extractFn(doubaoSrc, 'normalizeAssetName')
  const build = extractFn(doubaoSrc, 'buildAssetMaps')
  const match = extractFn(doubaoSrc, 'matchAssetName')
  record('抽出 normalizeAssetName', !!norm)
  record('抽出 buildAssetMaps', !!build)
  record('抽出 matchAssetName', !!match)
  if (!norm || !build || !match) return

  const factory = new Function(
    'pickContainmentCandidate',
    `${norm}\n${build}\n${match}\nreturn { matchAssetName, buildAssetMaps }`
  )
  const { matchAssetName, buildAssetMaps } = factory(pickContainmentCandidate)

  const maps = buildAssetMaps({ characters: [], scenes: [], props: [{ name: '断桥' }, { name: '木桥' }] })
  record('并列歧义（raw=桥）→ null', matchAssetName('桥', maps.props) === null, String(matchAssetName('桥', maps.props)))

  const maps2 = buildAssetMaps({ characters: [], scenes: [], props: [{ name: '腐朽木桥' }, { name: '木桥' }] })
  record('最短唯一（raw=木桥）→ 命中「木桥」', matchAssetName('木桥', maps2.props) === '木桥', String(matchAssetName('木桥', maps2.props)))

  record('精确命中不变', matchAssetName('断桥', maps.props) === '断桥')
  record('归一命中不变（空格）', (() => {
    const m = buildAssetMaps({ characters: [], scenes: [], props: [{ name: '断桥' }] })
    return matchAssetName('断 桥', m.props) === '断桥'
  })())
  record('无包含关系 → null', matchAssetName('盾牌', maps.props) === null)
})

// ══════════════════════════════════════════════════════════════════════════════
// D. FIX-8 本集道具清单提示段
// ══════════════════════════════════════════════════════════════════════════════
t('D1. buildPropLexiconHint：非空清单注入全部名单', () => {
  const hint = buildPropLexiconHint(['腐朽木桥', '浮冰'])
  record('非空 → 含引导语', hint.includes('本集已有道具清单'))
  record('含全部道具名（顿号连接）', hint.includes('腐朽木桥、浮冰'), hint.slice(0, 60))
  record('以换行结尾（插值不粘连下一行）', hint.endsWith('\n'))
  record('要求逐字使用清单写法', hint.includes('逐字使用清单中的写法'))
})

t('D2. buildPropLexiconHint：空/脏清单 → 空串（插值零改动）', () => {
  record('空数组 → ""', buildPropLexiconHint([]) === '')
  record('null → ""', buildPropLexiconHint(null) === '')
  record('undefined → ""', buildPropLexiconHint(undefined) === '')
  record('全空白项 → ""', buildPropLexiconHint(['', '   ', null]) === '')
})

t('D3. buildPropLexiconHint：去重 + 去首尾空白', () => {
  const hint = buildPropLexiconHint(['腐朽木桥', ' 腐朽木桥 ', '浮冰'])
  const namesLine = hint.split('\n')[1]
  record('去重后仅出现一次', (namesLine.match(/腐朽木桥/g) || []).length === 1, namesLine)
  record('去空白后含浮冰', namesLine.includes('浮冰'))
})

// ══════════════════════════════════════════════════════════════════════════════
// E. 静态守卫
// ══════════════════════════════════════════════════════════════════════════════
t('E1. resolvePropName 第三级确已委托 pickContainmentCandidate（判据单点）', () => {
  const src = read('../ai/propNameMatch.js')
  record('含委托调用（道具侧 minRawLen=2）', /pickContainmentCandidate\(target,\s*names,\s*\{\s*minRawLen:\s*2\s*\}\)/.test(src))
})

t('E2. doubao.js 已改用共享判据，旧「遍历序最短」实现已移除', () => {
  const src = read('../ai/doubao.js')
  record('已 import pickContainmentCandidate', /import\s*\{\s*pickContainmentCandidate\s*\}\s*from\s*'\.\/propNameMatch\.js'/.test(src))
  record('matchAssetName 调用 pickContainmentCandidate', /const hit = pickContainmentCandidate\(raw, candidates, \{ normalize: normalizeAssetName \}\)/.test(src))
  record('旧 `let bestKey` 遍历实现已删除', !/let bestBestKey|let bestKey/.test(src))
})

t('E3. sceneAnchors.analyzeWithLlm 已接入 buildPropLexiconHint 且清单来自 props 表', () => {
  const src = read('../ai/sceneAnchors.js')
  record('已 import buildPropLexiconHint', /import\s*\{\s*resolvePropName,\s*buildPropLexiconHint\s*\}/.test(src))
  record('查 props 表取本集道具名', /SELECT name FROM props WHERE episode_id = \?/.test(src))
  record('hint 已插入 prompt', /propLexiconHint \+/.test(src))
})

t('E4. 归档卫生：ai/lexicons 下无残留 .bak_* 文件（I1）', () => {
  const dir = new URL('../ai/lexicons/', import.meta.url)
  const residue = fs.readdirSync(dir).filter((f) => /\.bak(_|$)/.test(f))
  record('lexicons 目录无 .bak_* 残留', residue.length === 0, residue.join(',') || '干净')
})

// ── 收尾 ─────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
process.stdout.write(`\n==== extraFixes: ${results.length - failed.length}/${results.length} passed ====\n`)
if (failed.length) {
  process.stdout.write(`FAILED:\n${failed.map((f) => `  - ${f.name}`).join('\n')}\n`)
  process.exit(1)
}
