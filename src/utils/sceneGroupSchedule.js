// 场景图批量生成的「空间组串行」调度（2026-09-18）
//
// 解决什么问题：
//   同一 spatial_group 的场景是同一个物理空间的不同视角，后画的那张必须以先画那张的
//   定稿图为空间锚（后端只认已落库 image_url 的邻场）。并发发出 → 锚点全空 → 各画各的。
//   所以：组内串行、组间并发；组内按 scene_number 升序（场次靠前的先定稿，当后面几场的锚）。
//
// 为什么单独抽成纯函数：
//   调度规则是纯数据变换，放在 store 里没法单测；抽出来后 `server/_check_spatial_lock.mjs`
//   可以直接 import 并断言（不必真的发生图请求）。
//
// 降级原则：拿不到分组信息时返回「一条包含全部场景的链」= 全串行（等价 concurrency=1），
//   绝不做「每组独占一个并发槽还照旧并发」——那等于没修。

/**
 * 把待生成场景切成若干条「串行链」，链内串行、链间并发。
 *
 * @param {Array<{id:number|string}>} targets 待生成场景（store 里的 assetScenes 元素）
 * @param {Object|null} groupInfo 后端 /generate/scene-spatial-groups 的 groups：
 *        { [sceneId]: { group:string, sceneNumber:number } }；null/空 → 降级为全串行
 * @returns {Array<Array<Object>>} 链数组，每条链内的场景必须按顺序串行生成
 */
export function buildSceneGroupChains(targets, groupInfo) {
  const list = Array.isArray(targets) ? targets.slice() : []

  // 降级：无分组信息 → 一条全量链（全串行）。宁可慢，也不能让同组并发出错图。
  if (!groupInfo || !Object.keys(groupInfo).length) return list.length ? [list] : []

  const buckets = new Map() // group → { scenes: [], firstIndex }
  const solo = [] // 没有空间组的场景：彼此无关，各自一条长度为 1 的链
  list.forEach((t, idx) => {
    const g = String(groupInfo[String(t.id)]?.group || groupInfo[t.id]?.group || '').trim()
    if (!g) {
      solo.push({ scene: t, idx })
      return
    }
    if (!buckets.has(g)) buckets.set(g, { scenes: [], firstIndex: idx })
    buckets.get(g).scenes.push({
      scene: t,
      // sceneNumber 缺失（老数据/接口未返回）时用原始顺序兜底，保证排序稳定
      order: Number(groupInfo[String(t.id)]?.sceneNumber || groupInfo[t.id]?.sceneNumber || 0) || idx + 1,
      idx,
    })
  })

  // 组内按场次升序：先画场次靠前的，它的定稿图成为后面几场的空间锚
  for (const b of buckets.values()) {
    b.scenes.sort((a, z) => (a.order - z.order) || (a.idx - z.idx))
  }

  const chains = [...buckets.values()]
    .sort((a, z) => a.firstIndex - z.firstIndex)
    .map((b) => b.scenes.map((x) => x.scene))
  // 无分组的场景各成一条链，排在后面（它们不依赖任何锚点，晚点跑无所谓）
  for (const s of solo) chains.push([s.scene])
  return chains
}
