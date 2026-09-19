// 空间组人审基准图 · 提示词修复（P0-6）纯函数单测（T02）
//
// 约定（team-lead 红线）：不得 import server/db.js。本文件只测纯函数 sceneAnchorPrompt.js
// （无 DB 依赖），并对 src/services/promptBuilder.js 做【源码静态耦合断言】——
// 改那边 lightingNote 文案必须同步 sceneAnchorPrompt.js 的 PLAIN / LC_RE，否则测试红。
//
// 覆盖设计 §6 T02 验收点 4（黄金串三态）+ 共享知识 11（字面耦合守护）。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { swapSceneLightingNote, ANCHOR_PRIORITY_NOTE } from '../ai/sceneAnchorPrompt.js'

const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ::  ${detail}` : ''}\n`)
}

// 与 sceneAnchorPrompt.js / promptBuilder.js 完全一致的字面量（定义即文档）
const PLAIN = '本画面的时间、光线方向与色调以场景描述为准，画风只统一笔触、上色与线条质感，不改变本场景既定光照。'
// 2026-09-17 视角塌陷修复：锚图口径收敛为「空间结构/地标形态/光照方向」，视角维度显式豁免
const PLAIN_ANCHORED = '本画面的时段、天气与色温以场景描述为准，画风只统一笔触、上色与线条质感；空间结构、地标物体的形态与相对位置、光照方向以参考锚图为准，与锚图保持连续；但视角、机位高度、景别与画面主体占比不受锚图约束，一律以本场景文字描述为准。'
const LC = '（本场景光照常量：warm golden dusk）本画面的时间、光线方向与色调以该光照常量与场景描述为准，画风只统一笔触、上色与线条质感，不改变本场景既定光照。'
const LC_ANCHORED = '（本场景光照常量：warm golden dusk）本画面的时段、天气与色温以场景描述为准，画风只统一笔触、上色与线条质感；空间结构、地标物体的形态与相对位置、光照方向以参考锚图为准，与锚图保持连续；但视角、机位高度、景别与画面主体占比不受锚图约束，一律以本场景文字描述为准。'

// ── 验收点 4：黄金串三态 ──
{
  const prompt = `空无一人的场景环境空镜头：1.3，雪山边界悬崖。${PLAIN}整幅画面风格统一。`
  const out = swapSceneLightingNote(prompt)
  record('态① 含 PLAIN（无常量）→ 替换为 PLAIN_ANCHORED，且不残留旧句',
    out.includes(PLAIN_ANCHORED) && !out.includes('本画面的时间、光线方向与色调'),
    `含锚图口径=${out.includes(PLAIN_ANCHORED)} 残留旧句=${out.includes('本画面的时间、光线方向与色调')}`)
}

{
  const prompt = `空无一人的场景环境空镜头：1.3。${LC}整幅画面风格统一。`
  const out = swapSceneLightingNote(prompt)
  record('态② 含光照常量变体 → 替换为锚图口径变体，且不残留旧句',
    out.includes(LC_ANCHORED) && !out.includes('本画面的时间、光线方向与色调'),
    `含锚图变体=${out.includes(LC_ANCHORED)} 残留旧句=${out.includes('本画面的时间、光线方向与色调')}`)
}

{
  const prompt = '空无一人的场景环境空镜头：1.3，完全无关的描述，没有任何光照句。'
  const out = swapSceneLightingNote(prompt)
  record('态③ 都不含 → 原样返回（no-op，AC6 基础）',
    out === prompt, `out===prompt=${out === prompt}`)
}

{
  // 同一 prompt 同时含 PLAIN 与 LC：两者都应被改写，互不干扰
  const prompt = `A。${PLAIN}B。${LC}`
  const out = swapSceneLightingNote(prompt)
  record('混合态：PLAIN 与 LC 同时改写，无残留旧句',
    out.includes(PLAIN_ANCHORED) && out.includes(LC_ANCHORED) && !out.includes('本画面的时间、光线方向与色调'),
    `PLAIN命中=${out.includes(PLAIN_ANCHORED)} LC命中=${out.includes(LC_ANCHORED)}`)
}

// ── ANCHOR_PRIORITY_NOTE 内容校验（方案 A 显式优先级子句）──
{
  record('ANCHOR_PRIORITY_NOTE 声明「以锚图为准」',
    typeof ANCHOR_PRIORITY_NOTE === 'string' && ANCHOR_PRIORITY_NOTE.includes('以参考图（锚图）为准'),
    ANCHOR_PRIORITY_NOTE)
  record('ANCHOR_PRIORITY_NOTE 声明「时段/天气/色温以文字描述为准」',
    ANCHOR_PRIORITY_NOTE.includes('时段、天气与色温以本场景文字描述为准'))
}

// ── 视角塌陷回归守护（2026-09-17）────────────────────────────────────────────
// 事故：锚图口径曾把「构图」列为必须继承项，cliff_river 组场1/场2/场3 输出同一崖顶机位。
// 守护两条：① 锚图口径绝不出现「构图以参考锚图为准」这类把视角判给锚图的表述；
//          ② 必须显式声明视角/机位维度不被锚图约束。
// 注：断言的是**语义模式**而非整句——口径文案可以再润色，但语义不能倒退。
{
  for (const [name, s] of [['PLAIN_ANCHORED', PLAIN_ANCHORED], ['LC_ANCHORED', LC_ANCHORED], ['ANCHOR_PRIORITY_NOTE', ANCHOR_PRIORITY_NOTE]]) {
    // ① 反向：不得再出现「构图…以锚图/参考图为准」的旧口径（允许「严禁照搬构图」等豁免表述）
    const badPattern = /构图[^。；]*(以参考|以锚图|与锚图保持连续|必须与)/
    record(`视角守护① ${name} 不再把「构图」判给锚图`, !badPattern.test(s), s.slice(0, 60))
    // ② 正向：必须显式豁免视角维度
    record(`视角守护② ${name} 显式声明视角/机位不受锚图约束`,
      s.includes('视角') && (s.includes('机位') || s.includes('景别')) &&
      (s.includes('以本场景文字描述为准') || s.includes('不受锚图约束')),
      s.slice(0, 60))
  }
}

// ── 共享知识 11：promptBuilder.js 源码字面量耦合断言（守护防漂移）──
{
  const pbPath = fileURLToPath(new URL('../../src/services/promptBuilder.js', import.meta.url))
  const pb = readFileSync(pbPath, 'utf-8')
  record('耦合① promptBuilder.js 仍含无常量字面量（PLAIN）', pb.includes(PLAIN),
    pb.includes(PLAIN) ? 'ok' : '缺失 PLAIN')
  record('耦合② promptBuilder.js 仍含光照常量变体字面量（LC）', pb.includes('（本场景光照常量：'),
    pb.includes('（本场景光照常量：') ? 'ok' : '缺失 LC 前缀')
  // 且 promptBuilder 的 lightingNote 两段文案与 sceneAnchorPrompt 的 PLAIN/LC_RE 逐字符一致
  record('耦合③ promptBuilder 无常量句与 PLAIN 逐字相等',
    pb.includes(`本画面的时间、光线方向与色调以场景描述为准，画风只统一笔触、上色与线条质感，不改变本场景既定光照。`))
}

const failed = results.filter((r) => !r.ok)
process.stdout.write(`\n==== sceneAnchorPrompt: ${results.length - failed.length}/${results.length} passed ====\n`)
if (failed.length) {
  process.stdout.write(`FAILED: ${failed.map((f) => f.name).join(', ')}\n`)
  process.exit(1)
}
