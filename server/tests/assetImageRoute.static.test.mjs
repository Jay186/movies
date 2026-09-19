// /asset-image 路由改动面的静态结构验证（QA / 严过关）
//
// 团队负责人已核过一遍时序，这里做**可重复运行**的机器断言，防止后续重构把顺序改回去：
//   · 拿锁必须在 buildAnchorRefsForScene 之前（否则取锚时邻场 image_url 仍是空串）
//   · image_url 的 UPDATE 必须在放锁之前
//   · 放锁必须在 finally 里（异常/失败/提前 return 都覆盖）
//   · 只有 type === 'scene' 才加锁（character / prop 一行不碰）
//
// 只读、零网络、零 AI 费用、不 import 业务模块（避免打开真实 DB）。可重复运行。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ::  ${detail}` : ''}\n`)
}

const route = readFileSync(path.join(ROOT, 'server/routes/generate-image.js'), 'utf8')
const store = readFileSync(path.join(ROOT, 'src/stores/project.js'), 'utf8')
const lineOfIn = (src, needle, from = 0) => {
  const lines = src.split('\n')
  for (let i = from; i < lines.length; i += 1) if (lines[i].includes(needle)) return i + 1
  return 0
}

// ── 1. /asset-image 路由内的关键行 ───────────────────────────────────────────
// 只取 /asset-image 段内的行（该路由在文件中段），用 from 定位
const assetRouteStart = lineOfIn(route, "'/asset-image'")
record('找到 /asset-image 路由', assetRouteStart > 0, `line=${assetRouteStart}`)

const acquireLine = lineOfIn(route, 'acquireSpatialGroupLock(', assetRouteStart)
const anchorLine = lineOfIn(route, 'await buildAnchorRefsForScene(', assetRouteStart)
const updateLine = lineOfIn(route, 'SET image_url = ? WHERE id = ?', assetRouteStart)
const finallyLine = lineOfIn(route, '} finally {', assetRouteStart)
const releaseLine = lineOfIn(route, 'releaseSpatialGroupLock(spatialLock)', assetRouteStart)
const inflightDelLine = lineOfIn(route, 'imageJobsInflight.delete(jobKey)', assetRouteStart)
const sceneGuardLine = lineOfIn(route, "if (type === 'scene') {", assetRouteStart)

record('【核心】拿锁在「查空间锚」之前',
  acquireLine > 0 && anchorLine > 0 && acquireLine < anchorLine,
  `acquire=${acquireLine} anchor=${anchorLine}`)
record('【核心】image_url 落库在放锁之前',
  updateLine > 0 && releaseLine > 0 && updateLine < releaseLine,
  `update=${updateLine} release=${releaseLine}`)
record('【核心】放锁在 finally 里（异常/失败/提前 return 都覆盖）',
  finallyLine > 0 && releaseLine > finallyLine,
  `finally=${finallyLine} release=${releaseLine}`)
record('放锁与 imageJobsInflight.delete 并列（同一 finally 内）',
  Math.abs(releaseLine - inflightDelLine) <= 3,
  `release=${releaseLine} inflightDel=${inflightDelLine}`)
record('只对 type === \'scene\' 加锁',
  sceneGuardLine > 0 && acquireLine > sceneGuardLine,
  `guard=${sceneGuardLine} acquire=${acquireLine}`)
record('拿锁失败降级为不串行（有 try/catch 兜底，不阻断出图）',
  route.includes('空间组串行锁获取失败'), '匹配降级日志文案')

// ── 2. character / prop 零改动回归 ──────────────────────────────────────────
// 逐条确认：本次新增的每一个入口都只在 scene 分支内
record('spatialGroupLock 的 import 只有一处（服务端单入口）',
  (route.match(/from '\.\.\/ai\/spatialGroupLock\.js'/g) || []).length === 1)
record('buildSceneGroupChains 未被服务端引用（纯前端调度）', !route.includes('buildSceneGroupChains'))

// ── 3. 前端：非 scene 分支必须保持「每张一条链」──────────────────────────────
const declLine = lineOfIn(store, 'let chains = targets.map((t) => [t])')
const guardLine = lineOfIn(store, "if (type === 'scene') {", declLine)
record('project.js: 默认「每张一条链」声明存在于 scene 判断之前',
  declLine > 0 && guardLine > 0 && declLine < guardLine, `decl=${declLine} guard=${guardLine}`)
record('project.js: 未出现把非 scene 合成一条全量链的错误写法',
  !/chains\s*=\s*\[targets\]/.test(store) && !/chains\s*=\s*\[targets\.slice\(\)\]/.test(store))

// ── 4. 已知缺口：regenerateStaleAssets 不走空间组调度（后端锁兜底）────────────
const regenLine = lineOfIn(store, 'async function regenerateStaleAssets')
const regenBody = store.split('\n').slice(regenLine - 1, regenLine + 24).join('\n')
record('[已知缺口] regenerateStaleAssets 未调用 buildSceneGroupChains（依赖后端锁兜底）',
  !regenBody.includes('buildSceneGroupChains'),
  `line=${regenLine} —— 同组场景会被同时打出去，靠后端锁串行；「谁当锚」由到达顺序决定`)

// ── 5. T04 新增：人审基准图注入面的静态结构断言（设计 §4.4 / §1.2）──
// 仅追加断言，不动既有断言行；全部用「行内容匹配」而非行号（因头部 import 下移 2 行）。
// asset-image 路由区间：[assetRouteStart, assetRouteEnd)
const assetRouteEnd = lineOfIn(route, "router.post('/scene-anchors/init'", assetRouteStart)
const assetRegion = route.split('\n').slice(assetRouteStart - 1, assetRouteEnd - 1).join('\n')

// ① hasSpatialRef 在 buildAnchorRefsForScene 的 try 块内赋值
//    判据用单点函数 isSpatialSeriesAnchor（AI/anchorTypes.js）——不再内联
//    `a.type === 'scene' || a.type === 'spatial'` 字面量比较（2026-09-17 通用性重构）。
const anchorCallLine = lineOfIn(assetRegion, 'const anchorResult = await buildAnchorRefsForScene(')
const hasSpatialAssignLine = lineOfIn(assetRegion, 'hasSpatialRef = (anchorResult.anchors || []).some(isSpatialSeriesAnchor)')
record('【T04①】hasSpatialRef 声明存在（let hasSpatialRef = false）',
  assetRegion.includes('let hasSpatialRef = false // 本场是否命中空间类锚'),
  '匹配 hasSpatialRef 声明')
record('【T04①】hasSpatialRef 在 buildAnchorRefsForScene 的 try 块内赋值（赋值行在 anchorResult 之后）',
  anchorCallLine > 0 && hasSpatialAssignLine > 0 && hasSpatialAssignLine > anchorCallLine,
  `anchorCall=${anchorCallLine} assign=${hasSpatialAssignLine}`)
record('【T04①】判据走单点函数，不内联锚类型字面量比较',
  assetRegion.includes('isSpatialSeriesAnchor') &&
  !/a\.type === 'scene' \|\| a\.type === 'spatial'/.test(assetRegion),
  '单点判据')

// ② basePrompt 定义先于 prompt 分支链首个消费点
// 断言用**模式**而非精确字面量（2026-09-17 A1/A2 改造）：
//   basePrompt 的右值从 `prompt` 换成了 `promptFinal`（= prompt + 要素硬约束补注），
//   若这里锁死 `swapSceneLightingNote(prompt)`，每次调右值都要改测试——而本断言真正要守的
//   契约是「basePrompt 有定义、且定义在消费点之前」，不是它接的是哪个变量。
//   （同 sceneAnchorPrompt.test.mjs 的「视角守护」处置：模式断言，不锁死措辞。）
const basePromptDefLine = (() => {
  const lines = assetRegion.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    if (/^const basePrompt = .*swapSceneLightingNote\(/.test(lines[i].trim())) return i + 1
  }
  return 0
})()
// 有空间锚时必须以 swapSceneLightingNote 改写（P0-6 方案 C 的实质，不能被改掉）
record('【T04②】basePrompt 仍走 swapSceneLightingNote 改写（P0-6 实质未被破坏）',
  basePromptDefLine > 0)
const firstUseEditLine = lineOfIn(assetRegion, 'String(editInstruction || basePrompt)')
// 用**模式**而非字面量：A4/A5 把 generateImage(basePrompt, imgOpts) 换成了
// generateImage(basePrompt, imgOptsAttempt)（重抽要换文件名，故尺寸对象按尝试构造）。
// 本断言真正要守的契约是「basePrompt 的**第一个消费点**在定义之后」，
// 不是第二个参数叫什么名字 —— 锁死字面量会让每次重命名都误报（同 T04② 既有处置口径）。
const firstUseGenLine = (() => {
  const lines = assetRegion.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    if (/await generateImage\(basePrompt, \w+\)/.test(lines[i])) return i + 1
  }
  return 0
})()
record('【T04②】basePrompt 定义点存在', basePromptDefLine > 0, `def=${basePromptDefLine}`)
record('【T04②】basePrompt 定义先于分支链首个消费点（editInstruction / generateImage）',
  basePromptDefLine > 0 && firstUseEditLine > basePromptDefLine && firstUseGenLine > basePromptDefLine,
  `def=${basePromptDefLine} edit=${firstUseEditLine} gen=${firstUseGenLine}`)

// ②' A1/A2 补注必须在 basePrompt 之前完成（否则补注的要素句进不了任何分支）
const elNoteLine = lineOfIn(assetRegion, 'const elNote = buildElementNote(sceneElements)')
record('【A1/A2】要素补注在 basePrompt 定义之前（补注结果被所有分支吃下）',
  elNoteLine > 0 && basePromptDefLine > elNoteLine,
  `elNote=${elNoteLine} basePromptDef=${basePromptDefLine}`)
record('【A1/A2】要素补注按标题幂等（已由前端注入时不重复追加）',
  assetRegion.includes('!promptFinal.includes(ELEMENT_NOTE_TAG)')
  && assetRegion.includes('!promptFinal.includes(SHARED_ENV_NOTE_TAG)'))
record('【A1/A2】只对 type === \'scene\' 补注（character / prop 一行不碰）',
  (() => {
    const i = assetRegion.indexOf('let promptFinal = String(prompt || \'\')')
    if (i < 0) return false
    const seg = assetRegion.slice(i, i + 600)
    return seg.includes("if (type === 'scene') {")
  })())

// ③ 8 处 prompt→basePrompt 替换已落位（搜 generateImage(prompt) / ${prompt} 应只剩 basePrompt 版本）
record('【T04③】asset-image 路由内已无残留 generateImage(prompt（仅 basePrompt 版本）',
  !assetRegion.includes('generateImage(prompt'), '无裸 prompt 直传 generateImage')
record('【T04③】asset-image 路由内已无残留 ${prompt}（仅 ${basePrompt} 版本）',
  !/\$\{prompt\}/.test(assetRegion), '无 ${prompt} 模板残留')
record('【T04③】editInstruction 分支已用 basePrompt',
  assetRegion.includes('String(editInstruction || basePrompt)'), 'editInstruction||basePrompt')
record('【T04③】generateImage(basePrompt 出现 2 处（无锚图分支兜底 + 末分支）',
  (assetRegion.match(/generateImage\(basePrompt/g) || []).length === 2,
  `count=${(assetRegion.match(/generateImage\(basePrompt/g) || []).length}`)
record('【T04③】${basePrompt} 模板字面量出现 4 处',
  (assetRegion.match(/\$\{(basePrompt)\}/g) || []).length === 4,
  `count=${(assetRegion.match(/\$\{(basePrompt)\}/g) || []).length}`)
record('【T04③】lead + basePrompt + sceneHintNote 分支已用 basePrompt',
  assetRegion.includes('lead + basePrompt + sceneHintNote'), '图生图有参考分支')

// ④ 825-846 段（锁 + finally）未被触碰——行内容匹配（锁段在 baseline 整体下移 2 行）
// 用「行内容匹配」而非行号：从「空间组串行锁」注释取到下一个大段注释「场景锚点集」，
// 该区间覆盖锁的 if 块（含 acquire + 降级 catch），且不含任何注入标记。
const lockStart = lineOfIn(route, '// ===== 空间组串行锁', assetRouteStart)
const lockEnd = lineOfIn(route, '// ===== 场景锚点集', lockStart) // 锁段后的下一个大段注释
const lockBlock = route.split('\n').slice(lockStart - 1, lockEnd - 1).join('\n')
record('【T04④】锁段内容完整：含 acquireSpatialGroupLock + 降级日志文案',
  lockBlock.includes('acquireSpatialGroupLock(') && lockBlock.includes('空间组串行锁获取失败'),
  `lockStart=${lockStart} lockEnd=${lockEnd}`)
record('【T04④】锁段未被本次注入触碰（不含 hasSpatialRef/basePrompt/sceneHintNote/swapSceneLightingNote）',
  !lockBlock.includes('hasSpatialRef') && !lockBlock.includes('basePrompt') &&
  !lockBlock.includes('sceneHintNote') && !lockBlock.includes('swapSceneLightingNote'),
  '锁段纯净')

// ⑤ 6 处 sceneHintNote 消费位点完好（1 处定义 + 6 处模板消费；注释另有 1 处，不计）
// 消费位点（均含「sceneHintNote +」）：938(editPrompt) / 952(p2) / 979·984(redrawPrompt 两形态) / 992(anchorOnly) / 1002(sceneAnchor)
record('【T04⑤】sceneHintNote 定义存在',
  assetRegion.includes('const sceneHintNote = sceneAnchorHints.length'), '定义点')
record('【T04⑤】sceneHintNote 模板消费位点 = 6 处（938/952/979/984/992/1002，均含「sceneHintNote +」）',
  (assetRegion.match(/sceneHintNote \+/g) || []).length === 6,
  `「sceneHintNote +」=${(assetRegion.match(/sceneHintNote \+/g) || []).length}`)

const failed = results.filter((r) => !r.ok)
process.stdout.write(`\n==== assetImageRoute(static): ${results.length - failed.length}/${results.length} passed ====\n`)
if (failed.length) {
  process.stdout.write(`FAILED: ${failed.map((f) => f.name).join(', ')}\n`)
  process.exit(1)
}
