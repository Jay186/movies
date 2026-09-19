// MC（H3-Motion-Context 续镜）适用性判定（2026-09-14 落地）
//
// 方案定调（2026-09-14 三轮讨论收敛，布哥追问「到底用什么方案」后代码化）：
// MC 买的是**音频延续**（画面延续是末帧锚的主场，MC 的 fc 回喂有 H264 一代损失，只是备胎）。
// 适用面按镜型分流——本模块是机读判定层，对应宪法第五条：
//   · 同场次连续镜头 → MC 开（画面/环境音延续，宪法「MC 成片接龙默认开启」）
//   · 跨场次         → MC 硬关：换场跳切是设计，上一场的画面/环境音不该被带进下一场。
//     2026-09-11 实锤：2-1→3-1 跨场被「场次盲接力」硬接，当晚只能手工断锚——
//     本模块是该事故的代码层根治。显式 useMotionContext:true 也不开：
//     跨场开 MC 没有合法场景，显式 true 在跨场时视为误操作。
//   · 段内多切点（E 路线 segment）→ 不走 /video-v4 单镜通道（MC 重演尾部 ~22 帧
//     与段内切点冲突，segment 路线本来就不接 MC），无冲突面，不在此判定。
//   · 清锚镜（插入特写）→ 分镜暂无「清锚」结构化字段，人工用单镜 useMotionContext:false 关。

/**
 * MC 是否该开——优先级：跨场硬关 > 单镜显式 > 全局默认。
 *
 * @param {boolean|undefined} explicit  单镜显式开关（req.body.useMotionContext）
 * @param {boolean} globalEnabled       全局开关（config.runninghub.motionContext.enabled）
 * @param {boolean} crossScene          上一镜与本镜是否跨场次（调用方查库比对 scene_number）
 * @returns {{ wanted: boolean, reason: 'cross-scene'|'explicit-on'|'explicit-off'|'global-on'|'global-off' }}
 */
export function resolveMc({ explicit, globalEnabled, crossScene }) {
  if (crossScene) return { wanted: false, reason: 'cross-scene' }
  if (explicit === true) return { wanted: true, reason: 'explicit-on' }
  if (explicit === false) return { wanted: false, reason: 'explicit-off' }
  return { wanted: globalEnabled === true, reason: globalEnabled === true ? 'global-on' : 'global-off' }
}
