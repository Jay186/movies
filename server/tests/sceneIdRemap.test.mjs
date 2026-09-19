// 场景重建引用重挂（ai/sceneIdRemap.js）· 单测（2026-09-18，FIX-2/P1-Q2）
//
// 覆盖：
//   A. 稳定键 ①title 命中 → 重挂到新 id
//   B. 稳定键 ②scene_number 兜底（改名 / title 不唯一）
//   C. unmatched：对应旧场景重建后已不存在（→ 调用方只记 warn、不删行）
//   D. skipped：非正整数 / 从未指向真实旧场景（如布局锚 scene_id=0）
//   E. unchanged：新旧 id 一致（无需 UPDATE）
//   F. 唯一性护栏：title 与 scene_number 都拿不准 → unmatched（不猜）
//   G. 纯函数：脏数据不抛、不修改入参、幂等
//   H. 接入点静态守卫：generate-script.js 重建后确实调用重挂
//
// 约定：自带判卷、PASS/FAIL 前缀、零外部依赖、可重复运行。

import fs from 'node:fs'
import { remapSceneRefs } from '../ai/sceneIdRemap.js'

const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ::  ${detail}` : ''}\n`)
}
function t(name, fn) {
  try { fn() } catch (e) { record(name, false, `EXCEPTION ${e && e.message}`) }
}

const OLD = [
  { id: 1, title: 'A', scene_number: 1 },
  { id: 2, title: 'B', scene_number: 2 },
  { id: 3, title: 'C', scene_number: 3 },
]
const NEW = [
  { id: 11, title: 'A', scene_number: 1 },
  { id: 12, title: 'B', scene_number: 2 },
]

// ── A/B/C/D/E：基础映射 ──────────────────────────────────────────────────────
t('A. title 命中 → 重挂（via=title）', () => {
  const refs = [{ id: 100, scene_id: 1 }, { id: 101, scene_id: 2 }]
  const r = remapSceneRefs(OLD, NEW, refs)
  record('两条都按 title 重挂',
    r.updates.length === 2 && r.updates.every((u) => u.via === 'title') &&
    r.updates[0].to === 11 && r.updates[1].to === 12, JSON.stringify(r.updates))
})

t('B. title 不命中 → 回退 scene_number（改名兜底）', () => {
  const old = [{ id: 1, title: '旧名', scene_number: 5 }]
  const nw = [{ id: 77, title: '新名', scene_number: 5 }]
  const r = remapSceneRefs(old, nw, [{ id: 100, scene_id: 1 }])
  record('按场次号重挂', r.updates.length === 1 && r.updates[0].to === 77 && r.updates[0].via === 'scene_number', JSON.stringify(r.updates))
})

t('C. 对应旧场景已不存在 → unmatched（保留行，交调用方 warn）', () => {
  const r = remapSceneRefs(OLD, NEW, [{ id: 102, scene_id: 3 }])
  record('C 归入 unmatched、无 update', r.unmatched.length === 1 && r.unmatched[0].scene_id === 3 && r.updates.length === 0, JSON.stringify(r.unmatched))
})

t('D. scene_id 非正整数 / 不在旧快照 → skipped（不计 unmatched）', () => {
  const refs = [{ id: 103, scene_id: 0 }, { id: 104, scene_id: -1 }, { id: 105, scene_id: 999 }, { id: 106, scene_id: null }]
  const r = remapSceneRefs(OLD, NEW, refs)
  record('全部 skipped，无 update/unmatched', r.skipped.length === 4 && r.updates.length === 0 && r.unmatched.length === 0, JSON.stringify(r.skipped))
})

t('E. 新旧 id 一致 → unchanged（无需 UPDATE）', () => {
  const r = remapSceneRefs([{ id: 1, title: 'A', scene_number: 1 }], [{ id: 1, title: 'A', scene_number: 1 }], [{ id: 100, scene_id: 1 }])
  record('unchanged=1、无 update', r.unchanged === 1 && r.updates.length === 0, JSON.stringify(r))
})

// ── F. 唯一性护栏 ────────────────────────────────────────────────────────────
t('F1. title 不唯一但场次号唯一 → 用场次号', () => {
  const old = [{ id: 1, title: 'X', scene_number: 1 }, { id: 2, title: 'X', scene_number: 2 }]
  const nw = [{ id: 11, title: 'X', scene_number: 1 }, { id: 12, title: 'X', scene_number: 2 }]
  const r = remapSceneRefs(old, nw, [{ id: 100, scene_id: 1 }, { id: 101, scene_id: 2 }])
  record('按场次号各归其位', r.updates.length === 2 && r.updates[0].to === 11 && r.updates[1].to === 12 && r.updates.every((u) => u.via === 'scene_number'), JSON.stringify(r.updates))
})

t('F2. title 与 scene_number 都歧义 → unmatched（不猜）', () => {
  const old = [{ id: 1, title: 'X', scene_number: 1 }]
  const nw = [{ id: 11, title: 'X', scene_number: 1 }, { id: 12, title: 'X', scene_number: 1 }]
  const r = remapSceneRefs(old, nw, [{ id: 100, scene_id: 1 }])
  record('归入 unmatched', r.unmatched.length === 1 && r.updates.length === 0, JSON.stringify(r))
})

// ── G. 纯函数 / 脏数据安全 ───────────────────────────────────────────────────
t('G. 脏数据不抛、不改入参、幂等', () => {
  record('全空入参不抛', (() => { try { const r = remapSceneRefs(null, undefined, null); return r.updates.length === 0 && r.unmatched.length === 0 } catch { return false } })())
  record('非数组入参不抛', (() => { try { remapSceneRefs('x', 5, {}); return true } catch { return false } })())
  record('refs 含 null 项不抛', (() => { try { remapSceneRefs(OLD, NEW, [null, { id: 1, scene_id: 1 }]); return true } catch { return false } })())
  const refs = [{ id: 100, scene_id: 1 }]
  const snap = JSON.stringify(refs)
  remapSceneRefs(OLD, NEW, refs)
  record('不修改 refs 入参', JSON.stringify(refs) === snap)
  const a = JSON.stringify(remapSceneRefs(OLD, NEW, refs))
  const b = JSON.stringify(remapSceneRefs(OLD, NEW, refs))
  record('幂等', a === b)
})

// ── H. 接入点静态守卫 ────────────────────────────────────────────────────────
t('H. generate-script.js 场景重建后确实调用了重挂', () => {
  const src = fs.readFileSync(new URL('../routes/generate-script.js', import.meta.url), 'utf8')
  record('import remapSceneRefs', /import\s*\{[^}]*remapSceneRefs[^}]*\}\s*from\s*'\.\.\/ai\/sceneIdRemap\.js'/.test(src))
  record('重建前快照旧 scenes', /oldSceneIdSnapshot\s*=\s*query\(/.test(src))
  record('重建后调用重挂', /remapSceneReferencesAfterRebuild\(episodeId,\s*oldSceneIdSnapshot\)/.test(src))
  record('重挂覆盖两张表', /scene_group_locks',\s*'scene_anchors'/.test(src))
})

const failed = results.filter((r) => !r.ok)
process.stdout.write(`\n==== sceneIdRemap: ${results.length - failed.length}/${results.length} passed ====\n`)
if (failed.length) {
  process.stdout.write(`FAILED:\n${failed.map((f) => `  - ${f.name}`).join('\n')}\n`)
  process.exit(1)
}
