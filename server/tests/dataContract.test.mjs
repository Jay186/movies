// 数据契约（shots.dialogue / 场景参考图缺失 / 切片尾部溢出）· 回归测试（2026-09-18，第五轮）
//
// 事故（QA 第2集第一段落实测，docs/audit/ep4-第一段落实测报告.md）：
//   P0-3  shots.dialogue 的契约是「JSON 数组」，但 ep4 42 镜里有 25 镜落成了**字符串 "null"**
//         （既非 SQL NULL 也非 []）。系统靠 5 处各自加 `'null'` 特判硬撑：
//         cameraAngle / generate-video×2 / segmentBuilder / episodes。
//         这是"契约破了用补丁糊"——新增任何消费方漏写一次就是一次台词丢失。
//   P0-2b 场景名命中但 image_url 为空 → pushRef 里 `if (!image) return` **零信号静默丢弃**，
//         ep4 的 4 个无图场景让 22 段里的 13 段出片拿不到任何场景参考图。
//   P1-3  切片尾部溢出按设计丢弃，但静默：段 87 声明 13s / 实测 13.67s，0.67s 素材蒸发无痕。
//
// 本测试守护修复后的不变量（防再次漂移）：
//   A. parseDialogue：任意形态（含 "null"）→ 数组、永不抛异常、合法台词不丢
//   B. serializeDialogue：写入侧不再产出 "null"；null/undefined → ''
//   C. 往返一致：serialize → parse 语义守恒（有台词恒有台词）
//   D. hasDialogue：无正文的脏行不算台词（出片闸门不该放行"没人说话"的镜）
//   E. 静态守卫：4 份本地 parseDialogue 副本已删 / 5 处 'null' 特判已替换
//   F. P0-2b：场景参考图缺失的两侧都落 source:'sceneImage' warn，且控制流仍是「不入 refs」
//   G. P1-3：切片尾部溢出有 warn 记录，且不占用 recordAlert（不是用户可处置的资产告警）
//
// 约定：纯 node 断言、零外部依赖（不触网、不调 LLM、**不 import server/db.js**——
//       路由层只做源码静态守卫，避免打开真实 data.db）。自带判卷、PASS/FAIL 前缀。

import fs from 'node:fs'
import { parseDialogue, serializeDialogue, hasDialogue } from '../ai/dialogue.js'

const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ::  ${detail}` : ''}\n`)
}
function t(name, fn) {
  try { fn() } catch (e) { record(name, false, `EXCEPTION ${e && e.message}`) }
}
const asyncTasks = []
function tAsync(name, fn) {
  asyncTasks.push((async () => {
    try { await fn() } catch (e) { record(name, false, `EXCEPTION ${e && e.message}`) }
  })())
}
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8')
// 只看**代码行**：注释里为了讲清历史会引用旧写法（如 `!== 'null'`），静态守卫不得被注释误触发。
const codeLines = (rel) => read(rel).split('\n')
  .filter((l) => {
    const s = l.trimStart()
    return s !== '' && !s.startsWith('//') && !s.startsWith('*') && !s.startsWith('/*')
  })
const codeOf = (rel) => codeLines(rel).join('\n')
// 安全序列化：循环引用 / BigInt 会把 JSON.stringify 打爆（详情页打印之前先兜住）
const safeStr = (v) => {
  try { return JSON.stringify(v) } catch { return String(v && typeof v === 'object' ? '[object]' : v) }
}

// ── A. parseDialogue：任意形态 → 数组、永不抛异常 ────────────────────────────
const NEVER_THROW_INPUTS = [
  ['null', null],
  ['undefined', undefined],
  ['空串', ''],
  ["字符串 'null'", 'null'],
  ["字符串 'undefined'", 'undefined'],
  ['空数组串', '[]'],
  ['截断 JSON', '[{'],
  ['非法 JSON', '{oops'],
  ['对象串', '{}'],
  ['标量串（字符串）', '"str"'],
  ['标量串（数字）', '123'],
  ['标量串（布尔）', 'true'],
  ['裸中文', '台词原文'],
  ['空白串', '   '],
  ['带空格的 null', ' null '],
  ['循环引用对象', (() => { const o = {}; o.self = o; return o })()],
  ['NaN 数字', NaN],
  ['数组本身', [{ character: 'A', text: 'hi' }]],
]
t('A1. parseDialogue 对所有形态都不抛异常且恒返回数组', () => {
  for (const [label, v] of NEVER_THROW_INPUTS) {
    let r = null
    let threw = false
    try { r = parseDialogue(v) } catch (e) { threw = true; r = `EXCEPTION ${e.message}` }
    record(`${label} → 不抛异常`, !threw, String(r))
    record(`${label} → 返回数组`, Array.isArray(r), safeStr(r))
  }
})

t('A2. "无台词"的各种写法一律归一为 []（这就是 25 镜脏值的修复点）', () => {
  for (const v of [null, undefined, '', 'null', '[]', '   ']) {
    record(`${JSON.stringify(v)} → []`, parseDialogue(v).length === 0, JSON.stringify(parseDialogue(v)))
  }
})

t('A3. 合法台词必须原样保留，一句都不能丢', () => {
  const one = [{ character: 'bear', tone: 'soft', text: 'I am here', startTime: 1.5 }]
  const got = parseDialogue(JSON.stringify(one))
  record('单句数组原样返回（内容逐字段相同）', JSON.stringify(got) === JSON.stringify(one), JSON.stringify(got))
  const two = [{ character: 'A', text: 'x' }, { character: 'B', text: 'y' }]
  record('多句数组长度不变', parseDialogue(JSON.stringify(two)).length === 2, String(parseDialogue(JSON.stringify(two)).length))
  record('已经是数组时原样返回（同一引用）', parseDialogue(two) === two)
  // 历史遗留的单句**对象**：契约要求数组，但旧数据是对象。保住台词 > 教条（'{}' 除外）
  const legacy = parseDialogue('{"character":"bear","text":"I am here"}')
  record('历史单对象 → 包成单元素数组（保住台词）', legacy.length === 1 && legacy[0].text === 'I am here', JSON.stringify(legacy))
  record('空对象 {} → []（不产生空壳行）', parseDialogue('{}').length === 0, JSON.stringify(parseDialogue('{}')))
  // line/content 老键名：不应被判为空
  record('line 键的台词行保留', parseDialogue('[{"character":"A","line":"hi"}]')[0].line === 'hi')
})

t('A4. 脏 JSON 不抛错且退化为 []（与改前 segmentBuilder 行为一致）', () => {
  record('截断 JSON → []', parseDialogue('[{').length === 0)
  record('非法对象 JSON → []', parseDialogue('{oops').length === 0)
  record('裸中文串 → []', parseDialogue('台词原文').length === 0)
})

// ── B. serializeDialogue：写入侧不再产出 "null" ────────────────────────────
t('B1. serializeDialogue 是 "null" 脏值的根因修复点', () => {
  record('null → ""', serializeDialogue(null) === '', JSON.stringify(serializeDialogue(null)))
  record('undefined → ""', serializeDialogue(undefined) === '', JSON.stringify(serializeDialogue(undefined)))
  record('关键：null 不再序列化成 "null"', serializeDialogue(null) !== 'null')
  record('空数组 → "[]"', serializeDialogue([]) === '[]', JSON.stringify(serializeDialogue([])))
  record('数组 → JSON 原样', serializeDialogue([{ text: 'hi' }]) === '[{"text":"hi"}]', serializeDialogue([{ text: 'hi' }]))
  record('对象 → JSON 原样', serializeDialogue({ text: 'hi' }) === '{"text":"hi"}', serializeDialogue({ text: 'hi' }))
  record('已经是字符串 → 原样透传', serializeDialogue('[]') === '[]')
  record('数字 0 → ""（非对象非字符串，无台词语义）', serializeDialogue(0) === '', JSON.stringify(serializeDialogue(0)))
  let circularOut = ''
  let threw = false
  try {
    const o = {}
    o.self = o
    circularOut = serializeDialogue(o)
  } catch { threw = true }
  record('循环引用不抛异常（JSON.stringify 自身会抛）', !threw)
  record('循环引用退化为 ""', circularOut === '', JSON.stringify(circularOut))
})

// ── C. 往返一致：写 → 读，语义守恒 ────────────────────────────────────────
t('C1. serialize → parse 后「有无台词」不变、台词内容不变', () => {
  const cases = [
    ['有台词数组', [{ character: 'bear', tone: 'soft', text: 'I am here', startTime: 0 }]],
    ['无台词 null', null],
    ['无台词 undefined', undefined],
    ['空数组', []],
    ['多句', [{ character: 'A', text: 'x' }, { character: 'B', text: 'y' }]],
    ['历史单对象', { character: 'A', text: 'x' }],
  ]
  for (const [label, v] of cases) {
    const round = parseDialogue(serializeDialogue(v))
    record(`${label}：有无台词守恒`, hasDialogue(round) === hasDialogue(v), `${JSON.stringify(round)} vs ${JSON.stringify(v)}`)
    record(`${label}：行数守恒`, round.length === parseDialogue(v).length, `${round.length} vs ${parseDialogue(v).length}`)
  }
})

// ── D. hasDialogue：出片闸门判据 ──────────────────────────────────────────
t('D1. hasDialogue 对脏值/无正文一律 false', () => {
  for (const v of [null, undefined, '', 'null', '[]', '{}', '[{}]', '[{"character":"A"}]', '[{', '"str"']) {
    record(`${JSON.stringify(v)} → false`, hasDialogue(v) === false, String(hasDialogue(v)))
  }
})

t('D2. hasDialogue 有真台词时才是 true（旧写法被 "null"/"[]" 之外的内容骗过的坑）', () => {
  record('正文 text', hasDialogue('[{"character":"A","text":"hi"}]') === true)
  record('正文在 line 键', hasDialogue('[{"character":"A","line":"hi"}]') === true)
  record('正文在 content 键', hasDialogue('[{"character":"A","content":"hi"}]') === true)
  record('多句里有一句有正文即为 true', hasDialogue('[{"character":"A"},{"character":"B","text":"hi"}]') === true)
  record('历史单对象有正文 → true', hasDialogue('{"character":"A","text":"hi"}') === true)
  record('正文只有空白 → false', hasDialogue('[{"character":"A","text":"   "}]') === false)
})

// ── E. 静态守卫：4 份本地副本已删、5 处特判已换 ──────────────────────────────
// ⚠️ 刻意**不断言** ai/v4Video.js：本轮该文件由 software-engineer-2 并发修改（F1/F3），
//    它里面仍有一份本地 parseDialogue —— 属已知待收口项，交给下一轮，不在此锁死（避免误判冲突）。
const OWNED_FILES = {
  'ai/segmentBuilder.js': '../ai/segmentBuilder.js',
  'ai/segmentPrompt.js': '../ai/segmentPrompt.js',
  'ai/videoPrompt.js': '../ai/videoPrompt.js',
  'ai/cameraAngle.js': '../ai/cameraAngle.js',
  'ai/shotClassifier.js': '../ai/shotClassifier.js',
  'routes/generate-video.js': '../routes/generate-video.js',
  'routes/episodes.js': '../routes/episodes.js',
  'routes/generate-script.js': '../routes/generate-script.js',
}
t('E1. 我收口的 8 个文件里不再有本地 parseDialogue 定义', () => {
  for (const [label, rel] of Object.entries(OWNED_FILES)) {
    const src = read(rel)
    record(`${label} 无本地 parseDialogue 定义`, !/function\s+parseDialogue\s*\(/.test(src))
  }
})

t('E2. 台词相关代码行不再出现旧的 "null"/"[]" 特判（含 QA 未列出的第 6 处 shotClassifier）', () => {
  for (const [label, rel] of Object.entries(OWNED_FILES)) {
    // 只盯台词相关行：retry_feedback 那类字段也有同形态的 `'null'` 兜底（不同列、本轮不改），
    // 断言必须精确，否则会误报，也会把真正的台词漂移淹没在噪音里。
    const bad = codeLines(rel).filter(
      (l) => /dialog|Dlg|dlg/i.test(l) && (l.includes("'null'") || l.includes("'[]'"))
    )
    record(`${label} 台词行无 'null'/'[]' 特判`, bad.length === 0, bad.slice(0, 2).join('  ||  '))
  }
})

t('E3. 消费方统一从 ai/dialogue.js 走判据', () => {
  record('segmentBuilder 从 dialogue.js import', /import\s*\{\s*parseDialogue\s*\}\s*from\s*'\.\/dialogue\.js'/.test(read('../ai/segmentBuilder.js')))
  record('segmentPrompt 从 dialogue.js import', /import\s*\{\s*parseDialogue\s*\}\s*from\s*'\.\/dialogue\.js'/.test(read('../ai/segmentPrompt.js')))
  record('videoPrompt 从 dialogue.js import', /import\s*\{\s*parseDialogue\s*\}\s*from\s*'\.\/dialogue\.js'/.test(read('../ai/videoPrompt.js')))
  record('cameraAngle 从 dialogue.js import hasDialogue', /import\s*\{\s*hasDialogue\s*\}\s*from\s*'\.\/dialogue\.js'/.test(read('../ai/cameraAngle.js')))
  record('shotClassifier 从 dialogue.js import hasDialogue', /import\s*\{\s*hasDialogue\s*\}\s*from\s*'\.\/dialogue\.js'/.test(read('../ai/shotClassifier.js')))
  record('generate-video 从 dialogue.js import', /import\s*\{\s*parseDialogue,\s*hasDialogue\s*\}\s*from\s*'\.\.\/ai\/dialogue\.js'/.test(read('../routes/generate-video.js')))
  record('episodes 从 dialogue.js import 读写两侧', /import\s*\{\s*parseDialogue,\s*serializeDialogue\s*\}\s*from\s*'\.\.\/ai\/dialogue\.js'/.test(read('../routes/episodes.js')))
  record('generate-script 从 dialogue.js import 读写两侧', /import\s*\{\s*parseDialogue,\s*serializeDialogue\s*\}\s*from\s*'\.\.\/ai\/dialogue\.js'/.test(read('../routes/generate-script.js')))
})

t('E4. 写入侧两处都用 serializeDialogue（源头不再产出 "null"）', () => {
  const episodes = codeOf('../routes/episodes.js')
  const script = codeOf('../routes/generate-script.js')
  record('episodes 写侧不再 typeof === object ? JSON.stringify（根因行）', !episodes.includes("typeof shot.dialogue === 'object' ? JSON.stringify(shot.dialogue)"))
  record('episodes 写侧调用 serializeDialogue', episodes.includes('serializeDialogue(shot.dialogue)'))
  record('generate-script 写侧不再 shot.dialogue ? JSON.stringify(...)', !script.includes("shot.dialogue ? JSON.stringify(shot.dialogue) : ''"))
  record('generate-script 写侧调用 serializeDialogue', script.includes('serializeDialogue(shot.dialogue)'))
})

// ── F. P0-2b：场景参考图缺失必须告警（单镜 + 段级两路）──────────────────────
t('F1. sceneImage 告警两落地 + 字段形状与既有告警一致', () => {
  const src = read('../routes/generate-video.js')
  const hits = src.split("source: 'sceneImage'").length - 1
  record('恰好 2 处 sceneImage 告警（单镜 + 段级同源）', hits === 2, String(hits))
  const lines = src.split('\n')
  for (const i of lines.keys()) {
    if (!lines[i].includes("source: 'sceneImage'")) continue
    const chunk = lines.slice(i, i + 10).join('\n')
    record(`L${i + 1} 带 level:'warn'`, /level:\s*'warn'/.test(lines[i]))
    record(`L${i + 1} 带 episodeId/shotId/shotNumber（camelCase，不是 snake_case）`, /episodeId/.test(chunk) && /shotId/.test(chunk) && /shotNumber/.test(chunk))
    record(`L${i + 1} 消息含场景名与场景 id（去重键粒度足够）`, /场景 id \$\{s\.id\}/.test(chunk) && /s\.title/.test(chunk))
    record(`L${i + 1} detail 落 2000 截断（同 propName 口径）`, /detail:/.test(chunk) && /slice\(0, 2000\)/.test(chunk))
    // 控制流语义保持：告警后必须 continue，绝不能继续 pushRef
    record(`L${i + 1} 告警后 continue（不入 refs，与原静默 return 等价）`, /\n\s*continue\n/.test(chunk))
    record(`L${i + 1} 未在该分支调用 pushRef`, !/pushRef\(s\.title/.test(chunk.split('continue')[0]))
  }
})

t('F2. 修复脚本默认 dry-run（不得一跑就写库）', () => {
  const src = read('../scripts/fix_dialogue_null.mjs')
  record('存在 default dry-run 退出分支', src.includes("=== dry-run：以上"))
  record('只有 --apply 才写库', src.includes("--apply") && src.includes("const APPLY = argv.includes('--apply')"))
  record('写前有 data.db 快照备份', src.includes('data.db.bak_before_dialogue_null_fix_'))
  record('只洗 null/undefined 字面量，不动带内容的行', src.includes("v === 'null' || v === 'undefined'"))
})

// ── G. P1-3：切片尾部溢出可见化 ───────────────────────────────────────────
t('G1. 尾部溢出有 warn，且不占 recordAlert（不是用户可处置的资产告警）', () => {
  const src = read('../ai/segmentSlicer.js')
  const idx = src.indexOf('尾部溢出可见化')
  record('存在溢出分支', idx > 0)
  const chunk = src.slice(idx, idx + 1400)
  record('用 console.warn 而非 recordAlert', /console\.warn\(/.test(chunk) && !/recordAlert\(/.test(chunk))
  record('日志含段 id', /\$\{segmentId\}/.test(chunk))
  record('日志含声明时长与实际时长', /declaredSec/.test(chunk) && /videoDur\.toFixed/.test(chunk))
  record('日志含丢弃量', /overflowSec\.toFixed/.test(chunk))
  record('阈值门槛存在（>0.05s 才报，防刷屏）', /overflowSec\s*>\s*0\.05/.test(chunk))
  record('丢弃行为本身没改（末镜仍截到 plannedTotal）', /const avail = videoDur != null \? Math\.min\(videoDur, plannedEnd\) : plannedEnd/.test(src))
})

// ── 收尾：先把异步断言跑完再汇总，否则退出码会假绿 ──────────────────────────
await Promise.all(asyncTasks)

const failed = results.filter((r) => !r.ok)
process.stdout.write(`\n==== dataContract: ${results.length - failed.length}/${results.length} passed ====\n`)
if (failed.length) {
  process.stdout.write(`FAILED:\n${failed.map((f) => `  - ${f.name}`).join('\n')}\n`)
  process.exit(1)
}
