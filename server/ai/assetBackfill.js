
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

// 场次级场景兜底：镜头 sceneAssets 为空时，用场次标题与场景资产名做匹配
// 依据：剧本分场标题与资产场景标题天然对应（含"日/夜/内外"后缀差异），比 @ 提及更结构化可靠
export function backfillSceneByTitle(shot, sceneTitle, sceneNames) {
  if (!shot) return shot
  if (toNames(shot.sceneAssets).length) return shot
  const title = String(sceneTitle || '').trim()
  const names = toNames(sceneNames)
  if (!title || !names.length) return shot

  let hit = names.find((n) => n === title)
  if (!hit) hit = names.find((n) => n.includes(title) || title.includes(n))
  if (!hit) {
    // 清洗后再试：去头部时间/氛围修饰（"黄昏的江边"→"江边"）、去尾部场次标记（"客厅-日"→"客厅"），再做包含匹配
    const strip = (s) => s
      .replace(/^((清晨|黄昏|深夜|夜晚|白天|傍晚|凌晨|午后|雨后)[的之]?)+/, '')
      .replace(/([-—·\s]*[（(]?(日|夜|内|外|晨|黄昏|清晨|深夜|傍[晚夜])[）)]?)+$/, '')
      .trim()
    const a = strip(title)
    if (a && a !== title) {
      hit = names.find((n) => {
        const b = strip(n)
        if (!b) return false
        return b === a || (a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a)))
      })
    }
  }
  if (hit) {
    shot.sceneAssets = [hit]
    console.warn(
      `[assetBackfill] 镜头 ${shot.shotNumber || shot.shot_number || shot.id || ''} sceneAssets 为空，` +
        `按场次标题「${title}」兜底匹配场景「${hit}」`
    )
  }
  return shot
}
