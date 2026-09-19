// 兜底校验：镜头 AI Prompt / finalFrame / 简述里 @ 提到的资产，必须并入镜头关联资产数组。
// 背景：分镜 AI 偶发只登记「说话/主动作角色」，Airlock 继承的在场角色被漏掉
// （实测：某项目镜头 1-3 的 prompt 里 @了一二，characters 却只有布布，
//   生图时缺一二参考图 → 一二被照着布布的参考图画错）。
// 模板已加硬约束，本函数是程序化保险：不依赖 AI 自觉，落库/下发前强制并集。
//
// 用法：backfillShotAssets(shot, { characters, scenes, props })
//   - shot: 镜头对象（会就地修改 characters/sceneAssets/propAssets）
//   - 三类资产均接受对象数组（取 .name）或字符串数组
//
// 可观测性：触发 backfill 时打 warn 日志，含镜头号、补齐的字段、AI 漏掉的角色名。
// 监控该日志的频率可量化「AI 分镜不合规率」，作为模板优化的反馈信号——
// 频率高说明模板硬约束没生效，需要回看 prompt 设计；频率低说明三层防御稳定。

function toNames(list) {
  return (list || [])
    .map((x) => (typeof x === 'string' ? x : (x?.name || x?.title || '')))
    .filter(Boolean)
}

export function backfillShotAssets(shot, assetNames) {
  if (!shot || !assetNames) return shot

  const text = [
    shot.integratedMultimodalDescription || shot.integrated_multimodal_description || '',
    shot.finalFrame || shot.final_frame || '',
    shot.description || '',
  ].join('\n')
  if (!text.includes('@')) return shot

  // 长名优先匹配并从文本中"消费"掉，避免「@布布」误命中更短的「@布」类前缀包含
  const mergeMentioned = (current, candidates) => {
    const set = new Set(current || [])
    const before = new Set(current || [])
    let remaining = text
    const sorted = [...new Set(candidates)].sort((a, b) => b.length - a.length)
    for (const name of sorted) {
      const token = `@${name}`
      if (remaining.includes(token)) {
        set.add(name)
        remaining = remaining.split(token).join(' ')
      }
    }
    return {
      value: [...set],
      added: [...set].filter((n) => !before.has(n)),
    }
  }

  const charRes = mergeMentioned(shot.characters, toNames(assetNames.characters))
  const sceneRes = mergeMentioned(shot.sceneAssets, toNames(assetNames.scenes))
  const propRes = mergeMentioned(shot.propAssets, toNames(assetNames.props))

  shot.characters = charRes.value
  shot.sceneAssets = sceneRes.value
  shot.propAssets = propRes.value

  // 可观测性：只在真有补齐时打日志，避免噪音
  const addedAll = [...charRes.added, ...sceneRes.added, ...propRes.added]
  if (addedAll.length > 0) {
    const label = shot.shotNumber || shot.shot_number || shot.id || 'unknown'
    const parts = []
    if (charRes.added.length) parts.push(`characters+=${charRes.added.join('/')}`)
    if (sceneRes.added.length) parts.push(`sceneAssets+=${sceneRes.added.join('/')}`)
    if (propRes.added.length) parts.push(`propAssets+=${propRes.added.join('/')}`)
    console.warn(
      `[assetBackfill] 镜头 ${label} AI 漏登记资产，已程序化补齐：${parts.join(', ')}。` +
      `说明分镜 AI 仍存在输出不一致（prompt @ 提及但 characters 字段未登记），` +
      `若该日志频繁出现需回看 doubao.js 模板硬约束是否生效。`
    )
  }

  return shot
}

export function backfillStoryboardAssets(storyboard, assetNames) {
  for (const s of (storyboard?.scenes || [])) {
    for (const shot of (s?.shots || [])) backfillShotAssets(shot, assetNames)
  }
  return storyboard
}
