
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
