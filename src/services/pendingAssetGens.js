// 资产生图 pending 任务对账（纯函数，无副作用、无框架依赖，便于单测）。
//
// 背景：资产生图任务在刷新/重进页面时靠 localStorage（PENDING_ASSET_GENS）恢复「生成中」态。
// 但请求被中断（服务重启切断连接 / 用户关页面）时 catch 不一定执行，pending 会残留 ——
// 后端其实早就没在跑，前端却显示假的「AI生成中」。
//
// 解法：把本地 pending 与后端 in-flight 资产任务（/generate/image/inflight 的 assets 数组）对账：
//   · 本地有、后端没有 → 僵尸（请求已中断）→ 清理，不恢复 loading
//   · 后端确实在跑     → 恢复 loading（继续轮询等图片落库）
//   · 后端查询失败     → 保守处理：不清理，全部按「待恢复」处理，交给 15 分钟超时兜底
//
// @param {Object}   p
// @param {Array}    p.pending          - 本地 pending 列表（元素含 { type, id, episodeId, prevUrl, startedAt }）
// @param {string}   p.episodeId        - 当前集 id（只处理本集任务；其他集留待切回时处理）
// @param {Set|null} p.runningAssetIds  - 后端在跑的资产 id 集合（字符串化）；null = 查询失败（未知）
// @returns {{ zombies: string[], toRestore: (string|number)[], kept: Array }}
//          zombies   - 判定为僵尸、应从 localStorage 清掉的资产 id（字符串）
//          toRestore - 应恢复 loading 的资产 id（保持原始类型，便于与 generatingAssetIds 比对）
//          kept      - 清理后应写回 localStorage 的完整 pending 列表（其他集任务原样保留）
export function reconcilePendingAssetGens({ pending = [], episodeId = '', runningAssetIds = null } = {}) {
  const epId = String(episodeId)
  const mine = (Array.isArray(pending) ? pending : []).filter((t) => String(t.episodeId) === epId)

  const zombies = []
  const toRestore = []
  for (const t of mine) {
    // runningAssetIds === null：后端查询失败 → 保守保留（不判僵尸）
    if (runningAssetIds && !runningAssetIds.has(String(t.id))) {
      zombies.push(String(t.id))
    } else {
      toRestore.push(t.id)
    }
  }

  // 写回时按 id 过滤僵尸；查询失败（null）时保持原样，一件不减
  const zombieSet = new Set(zombies)
  const kept = runningAssetIds
    ? (Array.isArray(pending) ? pending : []).filter((t) => !zombieSet.has(String(t.id)))
    : (Array.isArray(pending) ? pending : []).slice()

  return { zombies, toRestore, kept }
}
