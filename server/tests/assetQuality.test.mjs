// 场景冷暖自洽校验 · 验收测试（2026-09-18）
//
// 解决什么问题：本校验初版用**四个内容词表正则**判断冷/暖（冰|雪|霜…/ warm|golden…），
//   这直接违反本项目「零题材词表、零内容正则」铁律，并已在真实数据上**误报**：
//     ep4 场6「森林高地巨岩」summary 写「…远处雪峰已成天边一线。夕阳把整片森林染成蜜色…」
//     lighting_en 写「warm golden sunset light…」——两句都是暖调，完全自洽，
//     却因 summary 里"远处雪峰"那个「雪」字被判为冷环境 → 报冲突。
//   重写后判定交 LLM（与 layoutReview 同范式），代码只负责拼 prompt / 解析 / 缓存 / 降级。
//
// 测试重点（都是写错了不会立刻暴露的地方）：
//   A. **铁律护栏** —— 源文件里不得再出现任何题材词表 / 内容正则（这是本模块的立身之本）
//   B. 指纹语义 —— 只含参与判定两字段、trim 敏感、空格不产生新指纹
//   C. 闭集收敛 —— 模型返回闭集外的值必须降级，不得猜
//   D. 缓存 —— 命中省钱 / 指纹变即失效 / 模型变即失效 / 降级结果不写缓存
//   E. 降级铁律 —— LLM 未注入 / 抛错 / 脏 JSON 一律 conflict=false，且 verdict=null（与 false 区分）
//   F. 接线 —— 两个落库点真的调用了校验、真的在事务之外、告警真的带 sceneId
//
// 零网络、零 AI 费用（LLM 全部为注入的 mock）。可重复运行。

import fs from 'node:fs'
import {
  createLightingCheck,
  lightingFingerprint,
  parseLightingVerdict,
  buildLightingPrompt,
  LIGHTING_VERDICTS,
} from '../ai/assetQuality.js'

const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ::  ${detail}` : ''}\n`)
}
function t(name, fn) {
  try { fn() } catch (e) { record(name, false, `EXCEPTION ${e && e.message}`) }
}
// ⚠️ 异步断言必须显式收集 —— 见 E 节末尾说明（不收集会导致退出码假绿）
const asyncTasks = []
function tAsync(name, fn) {
  asyncTasks.push((async () => {
    try { await fn() } catch (e) { record(name, false, `EXCEPTION ${e && e.message}`) }
  })())
}
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8')

/** 造一个内存 DB 替身：只实现本模块用到的三条 SQL 语义。 */
function memDb() {
  const rows = new Map() // key = `${fp}\u0000${model}`
  return {
    queryOne: (sql, params) => {
      if (!/FROM lighting_checks/.test(sql)) return null
      return rows.get(`${params[0]}\u0000${params[1]}`) || null
    },
    query: () => [],
    execute: (sql, params) => {
      if (!/INSERT INTO lighting_checks/.test(sql)) return { changes: 0 }
      rows.set(`${params[0]}\u0000${params[1]}`, {
        fingerprint: params[0], model: params[1], verdict: params[2], reason: params[3],
      })
      return { changes: 1 }
    },
    _rows: rows,
  }
}

// ── A. 铁律护栏：源文件不得含题材词表 / 内容正则 ──────────────────────────────
// 这是本模块的存在理由。若这条挂了，说明有人在往这里塞词表——必须拦住。
t('A1. 四个内容词表常量已彻底移除', () => {
  const src = read('../ai/assetQuality.js')
  // 只看代码，不看注释：把注释剥掉再断言（历史说明里会提到这些名字）
  const code = src
    .split('\n')
    .filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l))
    .join('\n')
  for (const name of ['COLD_ENV', 'WARM_ENV', 'COLD_LIGHT', 'WARM_LIGHT']) {
    record(`A1. 代码里无 ${name}`, !new RegExp(name).test(code))
  }
})

t('A2. 没有任何匹配画面内容的字面量正则', () => {
  const src = read('../ai/assetQuality.js')
  const code = src
    .split('\n')
    .filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l))
    .join('\n')
  // 该模块允许的正则只有两类：提取 JSON 的 \{[^]*\}、以及 crypto 无关。
  // 把源码里所有正则字面量抠出来，逐个检查是否含中文或冷暖英文词。
  const lits = code.match(/\/(?![/*])(?:\\.|\[[^\]]*\]|[^/\n\\])+\/[gimsuy]*/g) || []
  const suspicious = lits.filter((l) => /[\u4e00-\u9fff]/.test(l)
    || /warm|cold|golden|snow|ice|sunset|dusk|mist|fog|frozen|amber|honey|blue|grey|gray/i.test(l))
  record('无内容字面量正则', suspicious.length === 0, suspicious.join(' | ') || `检出 ${lits.length} 个正则，均非内容匹配`)
})

t('A3. prompt 里不得举例任何题材词', () => {
  const p = buildLightingPrompt('场景A', 'lighting A')
  // 规则说明里可以提到「如 snow / mist」作为**反例警示**（告诉模型别被名词带走），
  // 但绝不能出现"冷环境包含这些词"式的词表。这里断言的是**不出现成规模的词表列举**。
  const zhWords = (p.match(/[\u4e00-\u9fff]{2,}/g) || [])
  record('prompt 未列举中文题材词表', !zhWords.some((w) => /冰雪|霜寒|黄昏|夕阳|蜜色/.test(w)))
  record('prompt 含待判定的两段原文', p.includes('场景A') && p.includes('lighting A'))
  record('prompt 要求严格 JSON', /严格 JSON/.test(p))
})

// ── B. 指纹语义 ──────────────────────────────────────────────────────────────
t('B1. 指纹只含参与判定的两个字段', () => {
  const a = lightingFingerprint('描述甲', 'lighting A')
  const b = lightingFingerprint('描述甲', 'lighting A')
  const c = lightingFingerprint('描述甲', 'lighting B')
  const d = lightingFingerprint('描述乙', 'lighting A')
  record('同内容 → 同指纹', a === b && a.length === 32)
  record('改光照 → 指纹变', a !== c)
  record('改描述 → 指纹变', a !== d)
})

t('B2. trim 后比较：首尾空格不产生新指纹', () => {
  record('描述带空格 → 同指纹', lightingFingerprint('  x  ', 'y') === lightingFingerprint('x', 'y'))
  record('光照带空格 → 同指纹', lightingFingerprint('x', '  y  ') === lightingFingerprint('x', 'y'))
})

t('B3. 任一为空 → 返回空指纹（表示不适用）', () => {
  record('描述空 → 空指纹', lightingFingerprint('', 'y') === '')
  record('光照空 → 空指纹', lightingFingerprint('x', '') === '')
  record('皆为 null → 空指纹', lightingFingerprint(null, null) === '')
  record('纯空格 → 空指纹', lightingFingerprint('   ', '  ') === '')
})

t('B4. 两段之间有分隔符，不会拼接歧义', () => {
  // 若无分隔符，"ab"+"c" 与 "a"+"bc" 会撞同一指纹 → 改一处却命中另一处的缓存
  record('无拼接歧义', lightingFingerprint('ab', 'c') !== lightingFingerprint('a', 'bc'))
})

// ── C. 闭集收敛 ──────────────────────────────────────────────────────────────
t('C1. 闭集内的值原样接受', () => {
  for (const v of LIGHTING_VERDICTS) {
    const r = parseLightingVerdict(JSON.stringify({ verdict: v, reason: 'r' }))
    record(`接受 ${v}`, r.verdict === v)
  }
})

t('C2. 闭集外的值一律降级为 unknown（不猜）', () => {
  for (const v of ['yes', 'no', 'CONFLICT!!!', '', 'maybe', 'true']) {
    const r = parseLightingVerdict(JSON.stringify({ verdict: v }))
    record(`拒绝 ${JSON.stringify(v)}`, r.verdict === 'unknown')
  }
})

t('C3. 大小写与空白容错', () => {
  record('CONFLICT → conflict', parseLightingVerdict('{"verdict":"CONFLICT"}').verdict === 'conflict')
  record(' "conflict" → conflict', parseLightingVerdict('{"verdict":" conflict "}').verdict === 'conflict')
})

t('C4. 脏输入不抛错', () => {
  for (const raw of ['', 'not json', '{broken', '{}', '[1,2]', null, undefined]) {
    const r = parseLightingVerdict(raw)
    record(`脏输入 ${JSON.stringify(raw)} 安全降级`, r.verdict === 'unknown' && r.reason === '')
  }
})

t('C5. reason 截断到 300 字（防长文撑爆告警表）', () => {
  const long = 'x'.repeat(500)
  record('reason 已截断', parseLightingVerdict(JSON.stringify({ verdict: 'conflict', reason: long })).reason.length === 300)
})

// ── D. 缓存 ──────────────────────────────────────────────────────────────────
t('D1. 命中缓存不调 LLM', () => {
  const db = memDb()
  let calls = 0
  const checker = createLightingCheck({
    llm: async () => { calls++; return '{"verdict":"conflict","reason":"r"}' },
    cacheKey: 'm1', ...db,
  })
  return checker.check('s', 'l').then((r1) => {
    record('首次真调 LLM', calls === 1 && r1.cached === false)
    return checker.check('s', 'l').then((r2) => {
      record('二次命中缓存，不再调 LLM', calls === 1 && r2.cached === true)
      record('缓存结论一致', r2.conflict === true && r2.reason === 'r')
    })
  })
})

tAsync('D2. 内容变 → 缓存失效重判', async () => {
  const db = memDb()
  let calls = 0
  const checker = createLightingCheck({
    llm: async () => { calls++; return '{"verdict":"consistent","reason":""}' },
    cacheKey: 'm1', ...db,
  })
  await checker.check('s1', 'l')
  await checker.check('s1', 'l')       // 命中
  await checker.check('s2', 'l')       // 描述变了 → 失效
  record('指纹变触发重判', calls === 2, `LLM 调用 ${calls} 次`)
})

tAsync('D3. 换模型 → 缓存失效（同内容不同模型可能结论不同）', async () => {
  const db = memDb()
  let calls = 0
  const mk = (model) => createLightingCheck({
    llm: async () => { calls++; return '{"verdict":"consistent","reason":""}' },
    cacheKey: model, ...db,
  })
  await mk('m1').check('s', 'l')
  await mk('m1').check('s', 'l')       // 命中
  await mk('m2').check('s', 'l')       // 换模型 → 失效
  record('模型变触发重判', calls === 2, `LLM 调用 ${calls} 次`)
})

tAsync('D4. 降级结果不写缓存（免得把"没判成"固化成结论）', async () => {
  const db = memDb()
  const checker = createLightingCheck({
    llm: async () => { throw new Error('boom') },
    cacheKey: 'm1', ...db,
  })
  const r = await checker.check('s', 'l')
  record('降级不冲突', r.conflict === false && r.verdict === null)
  record('降级未写缓存', db._rows.size === 0, `缓存 ${db._rows.size} 行`)
})

tAsync('D5. 模型返回闭集外值 → 不写缓存（下次可重试）', async () => {
  const db = memDb()
  const checker = createLightingCheck({
    llm: async () => '{"verdict":"whatever"}',
    cacheKey: 'm1', ...db,
  })
  const r = await checker.check('s', 'l')
  record('闭集外降级', r.verdict === null)
  record('闭集外未写缓存', db._rows.size === 0)
})

tAsync('D6. 缓存读写故障不影响判定', async () => {
  const checker = createLightingCheck({
    llm: async () => '{"verdict":"conflict","reason":"真冲突"}',
    cacheKey: 'm1',
    queryOne: () => { throw new Error('db read fail') },
    query: () => [],
    execute: () => { throw new Error('db write fail') },
  })
  const r = await checker.check('s', 'l')
  record('读写缓存皆抛错仍得到正确结论', r.conflict === true && r.reason === '真冲突')
})

// ── E. 降级铁律 ──────────────────────────────────────────────────────────────
tAsync('E1. LLM 未注入 → 安全降级，不调任何东西', async () => {
  const checker = createLightingCheck({ cacheKey: 'm1', ...memDb() })
  const r = await checker.check('s', 'l')
  record('未注入 LLM 时冲突为 false', r.conflict === false)
  record('未注入时 verdict 为 null（表"没判成"）', r.verdict === null)
  record('llmEnabled 为 false', checker.llmEnabled === false)
})

tAsync('E2. 模型名缺失 → 同样降级', async () => {
  let calls = 0
  const checker = createLightingCheck({ llm: async () => { calls++; return '{}' }, ...memDb() })
  const r = await checker.check('s', 'l')
  record('无模型名不调 LLM', calls === 0 && r.verdict === null)
})

tAsync('E3. 任一字段为空 → 不适用（不算降级）', async () => {
  let calls = 0
  const checker = createLightingCheck({
    llm: async () => { calls++; return '{"verdict":"conflict"}' }, cacheKey: 'm1', ...memDb(),
  })
  const a = await checker.check('', 'l')
  const b = await checker.check('s', '')
  const c = await checker.check(null, null)
  record('空字段不调 LLM', calls === 0)
  record('空字段返回 insufficient 而非 null', a.verdict === 'insufficient' && b.verdict === 'insufficient' && c.verdict === 'insufficient')
  record('空字段不冲突', a.conflict === false && b.conflict === false && c.conflict === false)
})

tAsync('E4. LLM 抛错 → 降级且不抛出到调用方', async () => {
  const checker = createLightingCheck({
    llm: async () => { throw new Error('超时') }, cacheKey: 'm1', ...memDb(),
  })
  let threw = false
  let r = null
  try { r = await checker.check('s', 'l') } catch { threw = true }
  record('未向调用方抛出', threw === false)
  record('降级为不冲突', r && r.conflict === false && r.verdict === null)
})

tAsync('E4b. cacheKey 绝不作为模型名传给 LLM（本轮的 404 真因）', async () => {
  // 踩过的坑：初版把 cacheKey 当 model 传给 chatCompletion，而它**优先使用显式 model**，
  // 于是拿 'light:qwen3.8-flash' 这个标识串去请求 → 404 model_not_found → 全程降级
  // （表现是"从不报冲突"，恰好被降级逻辑掩盖，不看日志根本发现不了）。
  let captured = null
  const checker = createLightingCheck({
    llm: async (msgs, opts) => { captured = opts; return '{"verdict":"consistent"}' },
    cacheKey: 'light:qwen3.8-flash',
    ...memDb(),
  })
  await checker.check('s', 'l')
  record('未传 model 字段', captured && captured.model === undefined, `model=${JSON.stringify(captured && captured.model)}`)
  record('传了 task 以启用分级', captured && captured.usageContext?.task === 'lighting-check')
})

tAsync('E4c. 工厂源码里 llm 调用不带 model 键（静态双保险）', async () => {
  const src = read('../ai/assetQuality.js')
  // 抠出 llm( ... ) 的调用块，断言里面没有 `model:` 或裸 `model,` 作为属性
  const callMatch = src.match(/await llm\([\s\S]*?\n\s*\)/)
  record('找到 llm 调用', !!callMatch)
  if (callMatch) {
    const block = callMatch[0]
      .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n') // 去注释
    record('llm 调用块中无 model 属性', !/^\s*model\s*[:,]/m.test(block), block.match(/^\s*model\s*[:,].*$/m)?.[0] || '')
  }
})

tAsync('E5. insufficient 不被当作 conflict', async () => {
  const checker = createLightingCheck({
    llm: async () => '{"verdict":"insufficient","reason":"信息不足"}', cacheKey: 'm1', ...memDb(),
  })
  const r = await checker.check('s', 'l')
  record('insufficient → conflict=false', r.conflict === false)
  record('insufficient 保留 verdict 以便统计', r.verdict === 'insufficient')
  record('insufficient 不把 reason 当冲突原因带出', r.reason === '')
})

tAsync('E6. checkMany 与 check 结论一致且保序', async () => {
  const checker = createLightingCheck({
    llm: async (msgs) => (/AA/.test(JSON.stringify(msgs)) ? '{"verdict":"conflict","reason":"c"}' : '{"verdict":"consistent","reason":""}'),
    cacheKey: 'm1', ...memDb(),
  })
  const out = await checker.checkMany([
    { name: 'A', summary: 'AA', lightingEn: 'l1', sceneId: 1 },
    { name: 'B', summary: 'BB', lightingEn: 'l2', sceneId: 2 },
    { name: 'C', summary: 'CC', lightingEn: 'l3', sceneId: 3 },
  ], { episodeId: 9 })
  record('保序且带 name/sceneId', out.length === 3 && out[0].name === 'A' && out[2].sceneId === 3)
  record('逐条结论各自正确', out[0].conflict === true && out[1].conflict === false && out[2].conflict === false)
})

tAsync('E7. checkMany 传入非数组 → 返回空数组不抛错', async () => {
  const checker = createLightingCheck({ llm: async () => '{}', cacheKey: 'm1', ...memDb() })
  const a = await checker.checkMany(null)
  const b = await checker.checkMany(undefined)
  record('非数组安全', Array.isArray(a) && a.length === 0 && Array.isArray(b) && b.length === 0)
})

// ── F. 接线 ──────────────────────────────────────────────────────────────────
t('F1. 两个落库点都改用 runLightingChecks', () => {
  const ep = read('../routes/episodes.js')
  const gs = read('../routes/generate-script.js')
  record('episodes.js 调 runLightingChecks', /runLightingChecks\(/.test(ep))
  record('generate-script.js 调 runLightingChecks', /runLightingChecks\(/.test(gs))
  record('episodes.js 不再引用旧同步函数', !/detectLightingConflict\(/.test(ep))
  record('generate-script.js 不再引用旧同步函数', !/detectLightingConflict\(/.test(gs))
})

t('F2. episodes.js 的判定必须在事务之外', () => {
  const ep = read('../routes/episodes.js')
  const lines = ep.split('\n')
  // 找场景事务的起止：transaction(() => {  ... })
  // 简化判断：runLightingChecks 调用点不得位于任何 transaction 回调内。
  // 做法：从头扫描，维护一个"当前是否在事务回调内"的粗略状态（按缩进 2 空格 + }) 收尾不可靠），
  // 改用更稳的判据：调用点的缩进必须是 2 空格（函数体顶层），事务内代码缩进为 4 空格起。
  const callLine = lines.find((l) => /^\s*runLightingChecks\(/.test(l))
  record('找到了调用点', !!callLine)
  if (callLine) {
    const indent = callLine.match(/^(\s*)/)[1].length
    record('调用点在函数体顶层（非事务内）', indent === 2, `缩进 ${indent} 空格`)
  }
  // 并且必须显式不 await（fire-and-forget），否则保存请求会白等 LLM
  record('episodes.js 刻意不 await（避免保存请求等待 LLM）', /^\s*runLightingChecks\([^)]*\)\s*$/m.test(ep) && /\.catch\(/.test(ep))
})

t('F3. 告警必须带 sceneId（否则前端按场景过滤看不到）', () => {
  const rt = read('../ai/lightingCheckRuntime.js')
  record('runtime 传 sceneId 给 recordAlert', /sceneId:\s*it\?\.sceneId/.test(rt) || /sceneId:\s*it\.sceneId/.test(rt))
  record('runtime 传 sceneNumber 给 recordAlert', /sceneNumber:/.test(rt))
})

t('F4. runtime 注入真实依赖且串行执行', () => {
  const rt = read('../ai/lightingCheckRuntime.js')
  record('注入 chatCompletion', /llm:\s*chatCompletion/.test(rt))
  record('注入 db 三件套', /query,\s*\n?\s*queryOne,\s*\n?\s*execute/.test(rt) || (/query:/.test(rt) && /queryOne:/.test(rt) && /execute:/.test(rt)))
  record('在循环内逐条 await（串行，避免打爆额度闸门）', /await checker\.check\(/.test(rt))
})

t('F5. 缓存键含模型档位（换模型即失效）', () => {
  const rt = read('../ai/lightingCheckRuntime.js')
  record('modelKey 由配置算出而非硬编码', /currentModelKey/.test(rt) && /lightTasks/.test(rt))
  record('档位含 light/main 区分', /light:/.test(rt) && /main:/.test(rt))
})

t('F6. config 已把 lighting-check 登记为轻任务', () => {
  const cfg = read('../config.js')
  record('lightTasks 含 lighting-check', /lighting-check/.test(cfg))
})

t('F7. schema 建了缓存表且是全新表（非老表加列）', () => {
  const schema = read('../schema.sql')
  record('lighting_checks 表存在', /CREATE TABLE IF NOT EXISTS lighting_checks/.test(schema))
  record('唯一键 (fingerprint, model)', /UNIQUE\(fingerprint,\s*model\)/.test(schema))
  // 全新表写 schema.sql 对老库安全；但若它被误当作"加列"塞进 db.js 迁移就会重复建
  const dbjs = read('../db.js')
  record('db.js 未对它做 ALTER TABLE（新表无需迁移）', !/lighting_checks/.test(dbjs))
})

t('F8. 旧同步导出保留为安全兜底（防漏改调用点崩掉）', () => {
  const src = read('../ai/assetQuality.js')
  record('detectLightingConflict 仍导出且恒不冲突', /export function detectLightingConflict\(\)/.test(src) && /deprecated/.test(src))
})

// ── 收尾：必须先把异步断言跑完再汇总，否则退出码会假绿 ──────────────────────
// 踩过的坑（layoutStale 轮）：t('...', async () => {...}) 不 await 收集 Promise 时，
//   断言确实跑了、FAIL 也确实打印了，但收尾汇总与 process.exit(1) 在其 resolve 之前就执行完
//   → 退出码恒为 0 → CI 看到"通过"。所以这里显式 await Promise.all(asyncTasks)。
await Promise.all(asyncTasks)

const failed = results.filter((r) => !r.ok)
process.stdout.write(`\n==== assetQuality: ${results.length - failed.length}/${results.length} passed ====\n`)
if (failed.length) {
  process.stdout.write(`FAILED:\n${failed.map((f) => `  - ${f.name}`).join('\n')}\n`)
  process.exit(1)
}
