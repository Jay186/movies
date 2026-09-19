// A4/A5 场景图内容质检 —— 独立验证（2026-09-17）
//
// 被测对象：server/ai/sceneReview.js（纯逻辑部分，零网络、零 AI 费用）
// 打的薄弱处：
//   1. parseSceneReview 的脏输入降级（模型返回带 markdown 围栏 / 缺字段 / 类型非法）
//   2. 未知类型必须收敛为 element_missing（最保守默认，不是最危险的那个）
//   3. shouldReviewScene 的"没得比就不判"语义 —— 空清单不能当合格
//   4. buildSceneReviewChecklist 的空项省略（不留空标题，不给模型噪音）
//   5. buildSceneRetryNote 的同类型归并 + 空清单返回 ''（首轮 prompt 逐字不变）
//   6. 通用性护栏：零题材词表、零正则匹配画面内容
//
// 幂等、只读、可重复运行：node server/tests/sceneReview.test.mjs

import fs from 'node:fs'
import {
  SCENE_DEFECT_TYPES,
  parseSceneReview,
  shouldReviewScene,
  buildSceneReviewChecklist,
  buildSceneRetryNote,
  resolveLocalSceneImage,
} from '../ai/sceneReview.js'

const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ::  ${detail}` : ''}\n`)
}
function t(name, fn) {
  try { fn() } catch (e) { record(name, false, `EXCEPTION ${e && e.message}`) }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ── 1. 闭集定义 ─────────────────────────────────────────────────────────────
t('闭集', () => {
  record('5 类问题齐备', SCENE_DEFECT_TYPES.length === 5, SCENE_DEFECT_TYPES.join(','))
  record('含 element_missing', SCENE_DEFECT_TYPES.includes('element_missing'))
})

// ── 2. parseSceneReview 脏输入 ──────────────────────────────────────────────
t('parseSceneReview 脏输入', () => {
  record('空串 → 空清单', eq(parseSceneReview(''), { defects: [], summary: '' }))
  record('null → 空清单', eq(parseSceneReview(null), { defects: [], summary: '' }))
  record('非 JSON → 空清单', eq(parseSceneReview('模型今天不想说话'), { defects: [], summary: '' }))
  record('坏 JSON → 空清单', eq(parseSceneReview('{"defects":['), { defects: [], summary: '' }))

  // markdown 围栏包裹（实测模型常这样返回）
  const fenced = '```json\n{"defects":[{"type":"element_missing","evidence":"画面里看不到雾"}],"summary":"要素缺失"}\n```'
  const r1 = parseSceneReview(fenced)
  record('markdown 围栏能剥出 JSON', r1.defects.length === 1 && r1.summary === '要素缺失')
  record('evidence 正确保留', r1.defects[0].evidence === '画面里看不到雾')

  // defects 非数组 → 空清单
  record('defects 非数组 → 空清单', parseSceneReview('{"defects":"nope"}').defects.length === 0)
  record('defects 为 null → 空清单', parseSceneReview('{"defects":null}').defects.length === 0)
  record('缺 defects 字段 → 空清单', parseSceneReview('{"summary":"ok"}').defects.length === 0)

  // 非法 type：必须收敛为 element_missing（保守默认），不是透传
  const r2 = parseSceneReview('{"defects":[{"type":"totally_made_up","evidence":"e"}]}')
  record('未知 type 收敛为 element_missing', r2.defects[0].type === 'element_missing', r2.defects[0].type)

  // 缺 evidence / 超长 evidence
  const r3 = parseSceneReview('{"defects":[{"type":"env_mismatch"}]}')
  record('缺 evidence → 空串（不抛）', r3.defects[0].evidence === '')
  const long = 'x'.repeat(500)
  const r4 = parseSceneReview(`{"defects":[{"type":"env_mismatch","evidence":"${long}"}]}`)
  record('evidence 截断 200 字', r4.defects[0].evidence.length === 200)

  // 非法项（无 type / null）被过滤
  const r5 = parseSceneReview('{"defects":[null,{"evidence":"no type"},{"type":"env_mismatch"}]}')
  record('无 type 的项被过滤', r5.defects.length === 1)
})

// ── 3. shouldReviewScene：没得比就不判 ──────────────────────────────────────
t('shouldReviewScene', () => {
  record('有要素 → 判', shouldReviewScene({ elements: ['浓雾'] }) === true)
  record('有环境卡 → 判', shouldReviewScene({ sharedEnv: ['雪地'] }) === true)
  record('有机位 → 判', shouldReviewScene({ spatialRole: '仰视' }) === true)
  record('有结构锚 → 判', shouldReviewScene({ hasSpatialRef: true }) === true)
  // 关键：全空 → 不判。空清单时"画面好看"不能冒充合格
  record('全空 → 不判（不是合格，是没得比）', shouldReviewScene({}) === false)
  record('空数组等同没有', shouldReviewScene({ elements: [], sharedEnv: [] }) === false)
  record('null 入参不抛', shouldReviewScene(null) === false)
  record('纯空白串不算机位', shouldReviewScene({ spatialRole: '   ' }) === false)
  // 空字符串项应被过滤（不能因为数组 length>0 就认为有基准）
  record('数组里只有空串 → 不判', shouldReviewScene({ elements: ['', ''] }) === false)
})

// ── 4. buildSceneReviewChecklist ────────────────────────────────────────────
t('buildSceneReviewChecklist', () => {
  const full = buildSceneReviewChecklist({
    elements: ['浓雾', '断桥'],
    sharedEnv: ['雪地'],
    spatialRole: '谷底浅滩仰视',
    hasLayout: true,
  })
  record('四项齐备时都有标题', ['本场必须可见的要素', '共有的环境特征', '机位/视角', '空间结构基准'].every((k) => full.includes(k)))
  record('要素用顿号连接', full.includes('浓雾、断桥'))

  // 空项不留空标题（否则模型会看到"【机位/视角】"后面什么都没有）
  const onlyEl = buildSceneReviewChecklist({ elements: ['浓雾'] })
  record('空项不留空标题', !onlyEl.includes('机位') && !onlyEl.includes('空间结构'))
  record('只有要素时只输出一段', onlyEl.split('\n').length === 1)

  record('全空 → 空串', buildSceneReviewChecklist({}) === '')
  record('null → 空串且不抛', buildSceneReviewChecklist(null) === '')
})

// ── 5. buildSceneRetryNote ──────────────────────────────────────────────────
t('buildSceneRetryNote', () => {
  // 空清单 → ''。这是"首轮 prompt 逐字不变"的保证
  record('空清单 → 空串（首轮 prompt 逐字不变）', buildSceneRetryNote([]) === '')
  record('null → 空串', buildSceneRetryNote(null) === '')
  record('非法类型全被过滤 → 空串', buildSceneRetryNote([{ type: 'made_up' }]) === '')

  const one = buildSceneRetryNote([{ type: 'element_missing', evidence: '看不到雾' }])
  record('单条 → 含针对句与证据', one.includes('漏画') && one.includes('看不到雾'))
  record('单条以 ⚠️ 开头（与 layout 同款）', one.trimStart().startsWith('⚠️'))

  // 同类型多条 → 归并成一句，不堆砌
  const two = buildSceneRetryNote([
    { type: 'element_missing', evidence: '看不到雾' },
    { type: 'element_missing', evidence: '看不到桥' },
  ])
  record('同类型多条只加一次指令', (two.match(/漏画了必须出现的要素/g) || []).length === 1)
  record('同类型多条证据都保留', two.includes('看不到雾') && two.includes('看不到桥'))

  // 多类型 → 各自一段
  const multi = buildSceneRetryNote([
    { type: 'element_missing', evidence: 'a' },
    { type: 'env_mismatch', evidence: 'b' },
    { type: 'viewpoint_wrong', evidence: 'c' },
  ])
  record('多类型各自出指令', multi.includes('漏画') && multi.includes('环境特征') && multi.includes('机位'))

  // 无 evidence 的类型不该产生空括号
  const noEv = buildSceneRetryNote([{ type: 'extra_object' }])
  record('无 evidence 时不产生空括号', !noEv.includes('（）'))
})

// ── 6. resolveLocalSceneImage：路径收敛（防目录穿越）────────────────────────
t('resolveLocalSceneImage', () => {
  record('空 → null', resolveLocalSceneImage('') === null)
  record('null → null', resolveLocalSceneImage(null) === null)
  record('非 /uploads/ 前缀 → null', resolveLocalSceneImage('/etc/passwd') === null)
  record('http 远程地址 → null', resolveLocalSceneImage('https://x.com/a.png') === null)
  record('目录穿越 → null', resolveLocalSceneImage('/uploads/../../etc/passwd') === null)
  record('子目录 → null（只收单段）', resolveLocalSceneImage('/uploads/sub/a.png') === null)
  record('带 query 的地址 → null（应先裸化）', resolveLocalSceneImage('/uploads/a.png?t=1') === null)
})

// ── 7. 通用性护栏：零题材词表 / 零正则匹配画面内容 ─────────────────────────
// 扫源码前必须先把「注释、模板字符串、普通字符串」全部剥掉——
// 否则中文说明里的斜杠（如 '要素/环境/机位'）会被误判成正则字面量（实测踩过）。
function stripNonCode(src) {
  let s = src
  s = s.replace(/\/\*[\s\S]*?\*\//g, ' ')        // 块注释
  s = s.replace(/`(?:\\[\s\S]|[^\\`])*`/g, '``')  // 模板字符串（含转义，贪婪到真正闭合）
  s = s.replace(/'(?:\\[\s\S]|[^\\'\n])*'/g, "''") // 单引号字符串
  s = s.replace(/"(?:\\[\s\S]|[^\\"\n])*"/g, '""') // 双引号字符串
  s = s.replace(/\/\/[^\n]*/g, ' ')              // 行注释（放在最后，避免吃掉字符串里的 //）
  return s
}

t('通用性护栏', () => {
  const src = fs.readFileSync(new URL('../ai/sceneReview.js', import.meta.url), 'utf8')
  const code = stripNonCode(src)

  const forbidden = ['cliff_river', 'forest_edge', '断桥', '浓雾', '雪地', '雪山', '一二布布']
  const hits = forbidden.filter((w) => code.includes(w))
  record('代码区零题材词表', hits.length === 0, hits.join(','))

  // 只找**代码位置**上的正则字面量：= / 、( / 、, / 、return / 、.test( / 等
  const codeRe = /(?:[=(,:[!&|?{};]\s*|\breturn\s+|\bcatch\s*\(\s*)\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+\/[gimsuy]*/
  const reLits = code.match(codeRe) || []
  // 允许：JSON 提取 \{...\}（解析模型输出）、文件名解析 ^\/uploads\/（路径收敛）
  const allowed = (r) => r.includes('\\{') || r.includes('uploads')
  const suspicious = reLits.filter((r) => !allowed(r))
  record('无"内容匹配"型正则', suspicious.length === 0, suspicious.join(' | '))
  record('护栏自身有效（能识别出允许的那两条）', reLits.length >= 1, `检出 ${reLits.length} 条`)
})

// 护栏可信度：拿一段**故意写的**内容匹配正则喂进去，必须被识别出来
t('护栏自测（防止护栏本身失效）', () => {
  const fake = "if (/浓雾/.test(desc)) return true"
  const codeRe = /(?:[=(,:[!&|?{};]\s*|\breturn\s+|\bcatch\s*\(\s*)\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+\/[gimsuy]*/
  const reLits = fake.match(codeRe) || []
  const allowed = (r) => r.includes('\\{') || r.includes('uploads')
  const suspicious = reLits.filter((r) => !allowed(r))
  record('故意写的内容正则会被告警', suspicious.length > 0, suspicious.join('|') || '(未检出)')

  // 中文字符串里的斜杠**不该**被告警（这是之前误报的那类）
  const okCode = stripNonCode("return { skipReason: '要素/环境/机位均空' }")
  const okHits = (okCode.match(codeRe) || []).filter((r) => !allowed(r))
  record('字符串里的斜杠不误报', okHits.length === 0, okHits.join('|'))
})

// ── 8. 接线护栏：路由真的把闸接上了 ────────────────────────────────────────
t('接线护栏', () => {
  const route = fs.readFileSync(new URL('../routes/generate-image.js', import.meta.url), 'utf8')
  record('路由 import 了质检模块', /from '\.\.\/ai\/sceneReview\.js'/.test(route))
  record('路由调用了 reviewSceneImage', /await reviewSceneImage\(/.test(route))
  record('路由调用了 buildSceneRetryNote', /buildSceneRetryNote\(/.test(route))
  record('有 sceneReview 开关读取', /config\.storyboard\?\.sceneReview/.test(route))
  record('回执带 sceneReview 字段', /result\.sceneReview = \{/.test(route))
  record('不合格落告警 source=sceneReview', /source: 'sceneReview'/.test(route))
  record('合格清旧告警 resolveAlertsByScene', /resolveAlertsByScene\(/.test(route))

  // config 开关存在
  const cfg = fs.readFileSync(new URL('../config.js', import.meta.url), 'utf8')
  record('config 有 sceneReview 开关', /sceneReview:/.test(cfg))
  record('config 有 sceneReviewRetry', /sceneReviewRetry:/.test(cfg))
  record('默认关（须显式 SCENE_REVIEW=1 才开）', /sceneReview: process\.env\.SCENE_REVIEW === '1'/.test(cfg))

  // alerts 表与函数
  const alerts = fs.readFileSync(new URL('../ai/alerts.js', import.meta.url), 'utf8')
  record('alerts 导出 resolveAlertsByScene', /export function resolveAlertsByScene/.test(alerts))
  record('recordAlert 写入 scene_id/scene_number', /scene_id, scene_number/.test(alerts))
  const schema = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')
  record('schema 有 scene_id 列', /scene_id INTEGER/.test(schema))
  record('schema 有 scene_number 列', /scene_number TEXT DEFAULT ''/.test(schema))
  const dbjs = fs.readFileSync(new URL('../db.js', import.meta.url), 'utf8')
  record('db.js 有历史库迁移（老库自动补列）', /\['system_alerts', 'scene_id'/.test(dbjs) && /\['system_alerts', 'scene_number'/.test(dbjs))
})

// ── 8b. 接线一致性护栏：调用了却没 import（本轮真实踩到的坑）────────────────
// 背景：/alerts/resolve 加了 resolveAlertsByScene 调用，但 import 语句没跟着补——
// 语法检查、构建、静态扫描全都看不出问题（字符串里长得就是对的），
// 只有**真的点一次那个按钮**才会 ReferenceError。这类"漏导入"必须在测试里堵死。
//
// 设计要点（都是踩出来的）：
//   · 不硬编码文件清单 —— 谁 import 了 alerts.js 就查谁（写死的清单会随重构腐烂）
//   · 只在**代码位置**上匹配调用 —— 先 stripNonCode，避免注释/字符串里的示例误报
//   · 反向也查"import 了却没用到" —— 宽导入会制造噪音，让上面的检查失去诊断价值
t('接线一致性（调用了却没 import）', () => {
  const ALERT_FNS = ['recordAlert', 'listAlerts', 'countUnresolved', 'resolveAlert', 'resolveAlertsByShot', 'resolveAlertsByScene', 'alertSummaryForShot']

  // 解析 import 语句里被导入的本地标识符（支持 `a as b`）
  const importedFrom = (src, modPath) => {
    const names = new Set()
    const esc = modPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`import\\s+\\{([^}]*)\\}\\s+from\\s+'${esc}'`, 'g')
    let m
    while ((m = re.exec(src))) {
      for (const piece of m[1].split(',')) {
        const raw = piece.trim()
        if (!raw) continue
        const parts = raw.split(/\s+as\s+/)
        names.add((parts[1] || parts[0]).trim())
      }
    }
    return names
  }

  // 使用检测：标识符被**引用**即算使用（不限于 `fn(` 的调用形态）。
  //
  // ⚠️ 2026-09-18 修正：原来是 isCalled（只认 `fn(` 形态），漏掉「把函数**作为实参传递**」
  // 这一常见用法 —— episodes.js 把 recordAlert 传给 runLightingChecks(…, recordAlert)，
  // 于是被误报成"闲置 import"。护栏本身漏检比没有护栏更麻烦：它逼着人去掉正确的 import。
  //
  // 现判据：标识符出现，且前面不是 `.`（排除 obj.fn）也不是标识符字符（排除 myFn / fnXxx）。
  // 仍只在 stripNonCode 后的代码上匹配，注释与字符串里的同名不会误判。
  const isUsed = (code, fn) => new RegExp(`(?<![.\\w$])${fn}(?![\\w$])`).test(code)

  const routesDir = new URL('../routes/', import.meta.url)
  const routeFiles = fs.readdirSync(routesDir).filter((f) => f.endsWith('.js'))

  let checkedFiles = 0
  for (const file of routeFiles) {
    const src = fs.readFileSync(new URL(file, routesDir), 'utf8')
    if (!src.includes("ai/alerts.js")) continue // 不碰 alerts 的文件不参与
    checkedFiles++
    const imported = importedFrom(src, '../ai/alerts.js')
    const code = stripNonCode(src)
    const used = new Set(ALERT_FNS.filter((fn) => isUsed(code, fn)))

    const missing = [...used].filter((fn) => !imported.has(fn))
    record(`routes/${file} 用到的 alerts 函数都已 import`, missing.length === 0, missing.length ? `缺 import: ${missing.join(', ')}` : `用到 ${used.size} 个`)

    // 反向：导入了却一处都没用到 → 宽导入，会给上面的检查制造假信号
    const unused = [...imported].filter((fn) => !used.has(fn))
    record(`routes/${file} 无闲置 alerts import`, unused.length === 0, unused.length ? `未使用: ${unused.join(', ')}` : `import ${imported.size} 个全部在用`)
  }
  record('至少检查到一个 import alerts.js 的路由文件', checkedFiles >= 2, `checked ${checkedFiles} 个文件`)

  // 三选一的处置端点必须三个分支都在（id / shotId / sceneId）
  const gp = fs.readFileSync(new URL('../routes/generate-post.js', import.meta.url), 'utf8')
  record('处置端点支持 id 分支', /if \(id != null\)/.test(gp))
  record('处置端点支持 shotId 分支', /if \(shotId != null\)/.test(gp))
  record('处置端点支持 sceneId 分支', /if \(sceneId != null\)/.test(gp))
})

// ── 9. 降级铁律：默认关时行为与改造前一致 ──────────────────────────────────
t('降级铁律', () => {
  const route = fs.readFileSync(new URL('../routes/generate-image.js', import.meta.url), 'utf8')
  // sceneReviewEnabled 为 false 时 sceneReviewRetry 必须为 0 → 循环只跑一轮 → 行为同改造前
  record('关时重抽次数归零', /sceneReviewRetry = sceneReviewEnabled \? .* : 0/.test(route))
  // 首轮必须传空 retryNote（prompt 不加任何东西）
  record('首轮传空 retryNote', /runSceneGeneration\(attempt === 0 \? '' : lastRetryNote/.test(route))
  // 生成失败要 break，不能继续质检/重抽
  record('生成失败即中断循环', /if \(!result\?\.success\) break/.test(route))
})

const failed = results.filter((r) => !r.ok)
process.stdout.write(`\n==== sceneReview: ${results.length - failed.length}/${results.length} passed ====\n`)
if (failed.length) {
  process.stdout.write(`FAILED:\n${failed.map((f) => `  - ${f.name}`).join('\n')}\n`)
  process.exit(1)
}
