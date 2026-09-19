// 分组锁的**展示层**纯逻辑（2026-09-17）
//
// 为什么单独成模块：这些都是"把后端账本翻译成界面该显示什么"的判断，没有 Vue 依赖、
// 没有网络、没有副作用 —— 抽出来就能被 server/tests 直接 import 做用例（与
// sceneGroupSchedule.js 同一范式），而不是只能靠肉眼看界面。
//
// 通用性铁律：本模块**不认识任何具体组名、题材或语言**。
// 组名一律当不透明字符串处理，判定依据只有"集合包含关系"和"锁记录指向的场次"，
// 换题材、换命名风格、换成拼音/中文组名都不需要改这个文件。

/**
 * 按组名统计锁定场次数。
 * @param {Array<{group:string}>} locks
 * @returns {Record<string, number>} 组名 → 已锁场次数
 */
export function countLocksByGroup(locks) {
  const map = {}
  for (const l of Array.isArray(locks) ? locks : []) {
    const g = String(l?.group || '').trim()
    if (!g) continue
    map[g] = (map[g] || 0) + 1
  }
  return map
}

/**
 * 该场景是否已被锁。用字符串比较（后端给 number，前端 memberScenes 也可能给字符串）。
 * @param {number|string} sceneId
 * @param {Array<{sceneId:number}>} locks
 */
export function isSceneLocked(sceneId, locks) {
  const id = String(sceneId)
  return (Array.isArray(locks) ? locks : []).some((l) => String(l?.sceneId) === id)
}

/**
 * 该组是否已**完整**锁定 = 组内每一个成员场都在锁里。
 *
 * 为什么要求"全部"而不是"有任意一个"：只要还有一场没锁，LLM 就有机会把它挪走，
 * 这组的分组就还没真正固化。用"有交集"会把半锁的组标成已锁 —— 那是假安全感，
 * 比不显示更糟（用户以为受保护，实际重析照样重组）。
 *
 * @param {{memberScenes?:Array<{id:number|string}>}} group
 * @param {Array<{sceneId:number}>} locks
 */
export function isGroupLocked(group, locks) {
  const members = group?.memberScenes || []
  if (!members.length) return false
  return members.every((m) => isSceneLocked(m.id, locks))
}

/**
 * 把一个孤儿锚匹配到该显示它的那张组卡上。匹配不到返回 null（不硬塞给任何卡）。
 *
 * 难点：孤儿锚的组名**已经不在**任何组的 memberScenes 里 —— 正因如此它才成为孤儿。
 * 而卡片是按**当前**分组渲染的，所以没法靠"组名相等"自然落到某张卡上。
 *
 * 两类证据，按可信度排序：
 *   evidence 1 · 组名相等
 *     锚还在（confirm=1、图也在），只是暂时没有场次归属。最可信，无需推测。
 *   evidence 2 · 该锚的锁记录指向的场次**全部**落在这一张卡的成员里
 *     锁里记的组名是**人审定格时**的组名；漂移把组名改了，但"哪些场被锁过"不会说谎。
 *     这一支必须用 "全部落在" 而非 "有交集"：否则同一批场次会被多个组名同时认领。
 *     实测 ep4 里 forest_edge 与 forest_valley 都是已锁组、都无锚，用"有交集"
 *     会把同一个孤儿锚同时喂给两张卡（复现过）。
 *
 * 额外约束：**已经有锚的组不承接孤儿锚**。孤儿锚是别人组的伤口，
 * 贴到一张已经有基准图的卡上会让人误以为这张卡的基准失效了 —— 假告警比漏告警更伤信任。
 *
 * @param {object} group 当前组（需 group.group 与 group.memberScenes）
 * @param {{locks:Array, orphanAnchors:Array}} overview 后端 /scene-groups/locks 的返回
 * @returns {{group:string, image?:string, confirmed?:boolean}|null}
 */
export function matchOrphanAnchor(group, overview) {
  const anchored = (overview?.orphanAnchors || []).filter((a) => a && String(a.group || '').trim())
  if (!anchored.length) return null

  const name = String(group?.group || '').trim()

  // 证据 1：组名直接相等 —— 锚还在，只是暂时没有场次归属（最可信，先短路）
  const direct = anchored.find((a) => String(a.group).trim() === name)
  if (direct) return direct

  // 本卡当前组是否有自己的锚。已有锚的组不承接孤儿锚：孤儿锚是**别组**的伤口，
  // 贴到一张已经有基准图的卡上会让人误以为这张卡的基准也失效了（假告警比漏告警更伤信任）。
  if (anchored.some((a) => String(a.group).trim() === name)) return null

  const memberIds = new Set((group?.memberScenes || []).map((m) => String(m.id)))
  if (!memberIds.size) return null

  const locks = Array.isArray(overview?.locks) ? overview.locks : []

  // 证据 2：孤儿锚的锁记录指向的场次，**全部且仅**落在本卡成员里。
  // 用"全部落在"而非"有交集"：实测 ep4 里 forest_edge 与 forest_valley 都是已锁组、
  // 都无自己的锚，用"有交集"会把同一个孤儿锚同时喂给两张卡（复现过）。
  // 若该锚的锁覆盖了本卡成员以外的场次 → 它不是本卡的锚，宁可漏挂也不误挂。
  for (const a of anchored) {
    const key = String(a.group).trim()
    const ids = locks.filter((l) => String(l?.group || '').trim() === key).map((l) => String(l?.sceneId))
    if (!ids.length) continue   // 没有锁记录 → 无从判断归属，不猜
    if (!ids.every((id) => memberIds.has(id))) continue
    return a
  }
  return null
}

/**
 * 从概览里统计"有几组的基准失效了"（组卡外的汇总提示用）。
 * 去重按组名 —— 同一个组名出现多次只算一个伤口。
 * @param {{orphanAnchors:Array}} overview
 */
export function countOrphanAnchors(overview) {
  const names = new Set(
    (overview?.orphanAnchors || []).map((a) => String(a?.group || '').trim()).filter(Boolean),
  )
  return names.size
}
