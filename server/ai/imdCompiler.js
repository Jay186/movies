// IMD 混合编译（#6）：模块2（角色外形锁定）与模块3（环境冻结）由资产库原文程序注入，
// LLM 只负责其余模块（镜头声明 / Airlock / 时间轴动作 / 道具专属 / 最终画面）。
// 生成链路在产出后调 compileIntegratedModules 无条件重写模块2/3，
// 从产生源上消灭 CHARACTER_SPECIES_DRIFT 与场景环境漂移两类硬错误。

const CJK_DIRTY_RE = /[\u4e00-\u9fa5]/

// 按行首特征给 IMD 行分类；null 表示续行（归属上一个已识别模块）
function classifyImdLine(line) {
  const t = String(line || '').trim()
  if (!t) return null
  if (/^\[shot\b/i.test(t)) return 'm1'
  if (/^the camera opens holding/i.test(t)) return 'airlock'
  if (/remains completely unchanged/i.test(t)) return 'm3'
  if (/^at\s+0?\d/i.test(t)) return 'm4'
  if (/belongs exclusively/i.test(t)) return 'm5'
  if (/^the final frame/i.test(t)) return 'm6'
  if (/exactly as shown/i.test(t)) return 'm2'
  return null
}

// 把 IMD 文本切成模块分组（保持原顺序，未识别行跟随上一组）
export function groupImdModules(text) {
  const lines = String(text || '').split('\n')
  const groups = []
  let current = null
  for (const line of lines) {
    const kind = classifyImdLine(line)
    if (kind) {
      current = { kind, lines: [line] }
      groups.push(current)
    } else if (current) {
      current.lines.push(line)
    } else {
      current = { kind: 'other', lines: [line] }
      groups.push(current)
    }
  }
  return groups
}

function toSpeakerList(dialogue) {
  const list = Array.isArray(dialogue) ? dialogue : (dialogue && typeof dialogue === 'object' ? [dialogue] : [])
  const speakers = []
  for (const d of list) {
    const n = String(d?.character || '').trim()
    if (n && !speakers.includes(n)) speakers.push(n)
  }
  return speakers
}

// 模块2 程序版：每个出场角色逐字注入资产库 description_en + 说话规则（由台词推导）。
// 任一角色缺英文描述则返回 null（整段保留 LLM 版，避免中文混入英文外貌锁定模块导致出图角色漂移——IMD 是出图提示词，不进 H3）。
export function buildModule2({ characters = [], dialogue = null } = {}, assets = null) {
  const charMap = new Map()
  for (const c of assets?.characters || []) {
    const name = typeof c === 'string' ? c : String(c?.name || '').trim()
    if (name) charMap.set(name, c)
  }
  const names = [...new Set((characters || []).map((n) => String(n || '').trim()).filter(Boolean))]
  if (!names.length) return null
  const parts = []
  for (const name of names) {
    const row = charMap.get(name)
    const descEn = row && typeof row !== 'string' ? String(row.description_en || '').trim() : ''
    if (!descEn || CJK_DIRTY_RE.test(descEn)) return null
    parts.push(`@${name}, exactly as shown, ${descEn.replace(/[.\s]+$/, '')}.`)
  }
  const speakers = toSpeakerList(dialogue).filter((n) => names.includes(n))
  const silent = names.filter((n) => !speakers.includes(n))
  if (speakers.length && silent.length) {
    parts.push(`Speaking rule for this segment: ${speakers.map((n) => `@${n}`).join(' and ')} speak${speakers.length === 1 ? 's' : ''}; ${silent.map((n) => `@${n}`).join(' and ')} remain${silent.length === 1 ? 's' : ''} completely silent with lip${silent.length === 1 ? '' : 's'} closed.`)
  } else if (speakers.length) {
    parts.push(`Speaking rule for this segment: ${speakers.map((n) => `@${n}`).join(' and ')} speak${speakers.length === 1 ? 's' : ''}.`)
  } else {
    parts.push('Speaking rule for this segment: no dialogue — all characters\' lips remain completely closed.')
  }
  return parts.join('\n')
}

// 模块3 程序版：每个出场场景逐字注入资产库 summary_en + 冻结声明 + 光影常量。
// 任一场景缺英文摘要则返回 null（整段保留 LLM 版）。
export function buildModule3({ sceneAssets = [] } = {}, assets = null) {
  const sceneMap = new Map()
  for (const s of assets?.scenes || []) {
    const name = typeof s === 'string' ? s : String(s?.title || s?.name || '').trim()
    if (name) sceneMap.set(name, s)
  }
  const names = [...new Set((sceneAssets || []).map((n) => String(n || '').trim()).filter(Boolean))]
  if (!names.length) return null
  const parts = []
  for (const name of names) {
    const row = sceneMap.get(name)
    const en = row && typeof row !== 'string' ? String(row.summary_en || '').trim() : ''
    if (!en || CJK_DIRTY_RE.test(en)) return null
    parts.push(`The ${en.replace(/[.\s]+$/, '')} remains completely unchanged in structure, color, and arrangement throughout the entire segment — no layout shifts, no colors fade, no objects disappear.`)
    const lighting = row && typeof row !== 'string' ? String(row.lighting_en || '').trim() : ''
    if (lighting && !CJK_DIRTY_RE.test(lighting)) {
      parts.push(`Lighting stays constant: ${lighting.replace(/[.\s]+$/, '')}.`)
    }
  }
  return parts.join('\n')
}

// 混合编译主入口：重写 IMD 的模块2/3，其余模块原样保留。
// 返回 { text, injected, kept }：injected = 本次程序注入的模块；kept = 资产缺英文原文而保留 LLM 版的模块。
export function compileIntegratedModules(imd, shotInfo = {}, assets = null) {
  const text = String(imd || '')
  if (!text || !assets) return { text, injected: [], kept: [] }
  const groups = groupImdModules(text)
  const module2 = buildModule2(shotInfo, assets)
  const module3 = buildModule3(shotInfo, assets)
  const out = []
  const injected = []
  const kept = []
  let m2Emitted = false
  let m3Emitted = false
  for (const g of groups) {
    if (g.kind === 'm2') {
      if (module2) {
        if (!m2Emitted) {
          out.push(module2)
          injected.push('m2')
          m2Emitted = true
        }
        // 程序版已覆盖，后续 m2 续组（多角色分段）不再需要
      } else {
        out.push(g.lines.join('\n').trim())
        if (!m2Emitted) { kept.push('m2'); m2Emitted = true }
      }
      continue
    }
    if (g.kind === 'm3') {
      if (module3) {
        if (!m3Emitted) {
          out.push(module3)
          injected.push('m3')
          m3Emitted = true
        }
      } else {
        out.push(g.lines.join('\n').trim())
        if (!m3Emitted) { kept.push('m3'); m3Emitted = true }
      }
      continue
    }
    out.push(g.lines.join('\n').replace(/\s+$/, ''))
  }
  return { text: out.filter((s) => s !== '').join('\n'), injected, kept }
}
