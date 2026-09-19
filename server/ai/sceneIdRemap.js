// 场景重建后的引用重挂（2026-09-18，P1-Q2）
//
// ── 这个模块解决什么 ────────────────────────────────────────────────────────
// generate-script.js 重提取走 `DELETE FROM scenes WHERE episode_id=?` + 逐条重插 →
// `scenes.id` 全部换新（AUTOINCREMENT）。而 `scene_group_locks.scene_id` 与
// `scene_anchors.scene_id` 仍指向**旧 id** → 悬空。`loadGroupLocks`（ai/sceneGroupLock.js）
// 按 scene_id 查锁 → 查不到 → `applyGroupLocks` 全不命中 → **分组防漂移保护静默归零**
// （ep4 当前锁 7 条无悬空，属潜伏风险，重提取一次即触发）。
//
// ── 做法 ────────────────────────────────────────────────────────────────────
// 场景重建前后各取一次快照（id / title / scene_number），按**稳定键**把旧引用重挂到新 id：
//   稳定键优先级：title（跨重建最稳，generate-script.js 既有 oldSceneMap 亦以 title 为键）
//                 → scene_number（位置稳定，title 不唯一 / 改名时兜底）。
// 唯一性护栏：title 命中必须**恰好一个**新行才采用；否则回退 scene_number（同样要求唯一）；
//   都拿不准 → 归入 unmatched。调用方对 unmatched 只记 warn、**绝不删除**
//   （行保留 → 人在前端可见可处置；静默删数据比留脏更糟）。
//
// ── 通用性硬约束 ────────────────────────────────────────────────────────────
// 只认 id / title / scene_number 三个结构性字段，不含任何题材/语言/词表假设。
//
// ── 纯函数 ──────────────────────────────────────────────────────────────────
// 零副作用、零 IO：便于单测；DB 读写由调用方（generate-script.js）完成。

const toArray = (x) => (Array.isArray(x) ? x : [])
const normTitle = (s) => String(s == null ? '' : s).trim()
const toPosInt = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * 把「指向旧场景的引用行」重挂到新场景 id。
 *
 * @param {Array<{id:number,title:string,scene_number:number}>} oldScenes 重建前快照
 * @param {Array<{id:number,title:string,scene_number:number}>} newScenes 重建后快照
 * @param {Array<{id:number,scene_id:number}>} refRows 待重映射的引用行（scene_group_locks / scene_anchors）
 * @returns {{
 *   updates:Array<{id:number,from:number,to:number,via:string}>,
 *   unmatched:Array<{id:number,scene_id:number}>,
 *   skipped:Array<{id:number,scene_id:number}>,
 *   unchanged:number
 * }}
 *   - updates   ：scene_id 需要变更的行（id=引用行主键，from=旧 scene_id，to=新 scene_id，via='title'|'scene_number'）
 *   - unmatched ：指向的旧场景在重建后找不到对应新行（对应场景被删/改名且场次也变）→ 调用方只记 warn
 *   - skipped   ：scene_id 非正整数、或本就不在旧快照里（从未指向真实场景，如布局锚 scene_id=0）
 *   - unchanged ：新旧 id 一致（无需 UPDATE）
 */
export function remapSceneRefs(oldScenes, newScenes, refRows) {
  // 旧 id → { title, scene_number }
  const oldById = new Map()
  for (const s of toArray(oldScenes)) {
    const id = toPosInt(s?.id)
    if (id == null) continue
    oldById.set(id, { title: normTitle(s?.title), scene_number: toPosInt(s?.scene_number) })
  }

  // 新行索引（只收有效 id；同 title / 同 scene_number 可能多行 → 记成数组，命中数 >1 时判为不确定）
  const newByTitle = new Map()
  const newByNumber = new Map()
  for (const s of toArray(newScenes)) {
    const id = toPosInt(s?.id)
    if (id == null) continue
    const title = normTitle(s?.title)
    if (title) {
      if (!newByTitle.has(title)) newByTitle.set(title, [])
      newByTitle.get(title).push(id)
    }
    const no = toPosInt(s?.scene_number)
    if (no != null) {
      if (!newByNumber.has(no)) newByNumber.set(no, [])
      newByNumber.get(no).push(id)
    }
  }

  const updates = []
  const unmatched = []
  const skipped = []
  let unchanged = 0

  for (const ref of toArray(refRows)) {
    const refId = ref?.id
    const oldId = toPosInt(ref?.scene_id)
    // 非正整数 / 不在旧快照 → 本就未指向真实旧场景，跳过（不计入 unmatched，避免布局锚 scene_id=0 的误报）
    if (oldId == null || !oldById.has(oldId)) {
      skipped.push({ id: refId, scene_id: ref?.scene_id })
      continue
    }
    const old = oldById.get(oldId)

    let newId = null
    let via = ''
    // 稳定键 ①：title（要求唯一命中）
    if (old.title) {
      const hits = newByTitle.get(old.title)
      if (hits && hits.length === 1) { newId = hits[0]; via = 'title' }
    }
    // 稳定键 ②：scene_number（title 不唯一 / 改名时兜底，同样要求唯一命中）
    if (newId == null && old.scene_number != null) {
      const hits = newByNumber.get(old.scene_number)
      if (hits && hits.length === 1) { newId = hits[0]; via = 'scene_number' }
    }

    if (newId == null) { unmatched.push({ id: refId, scene_id: oldId }); continue }
    if (newId === oldId) { unchanged++; continue }
    updates.push({ id: refId, from: oldId, to: newId, via })
  }

  return { updates, unmatched, skipped, unchanged }
}
