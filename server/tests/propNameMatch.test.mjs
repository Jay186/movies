// 道具名跨层归一（ai/propNameMatch.js）· 单测（2026-09-18，FIX-1/P1-Q1）
//
// 覆盖：
//   A. normalizePropName：全角空格归一 / 去首尾标点空白 / 脏值安全
//   B. resolvePropName 三级保守策略：①精确 ②去状态后缀 ③唯一候选包含
//   C. 保守性：多候选一律不猜（返回 null）；ep4 实景（断桥 vs 腐朽木桥）不误配
//   D. 纯函数：幂等、不修改入参、异常输入不抛
//   E. 通用性铁律：模块内无 CJK 字符类正则（零题材/语言假设）
//   F. 接入点静态守卫：4 处消费端确实调用了 resolvePropName（含 generate-video 双路同源）
//
// 约定：自带判卷、PASS/FAIL 前缀、零外部依赖（只 import 被测模块 + fs 读源码）、可重复运行。

import fs from 'node:fs'
import { normalizePropName, resolvePropName } from '../ai/propNameMatch.js'

const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ::  ${detail}` : ''}\n`)
}
function t(name, fn) {
  try { fn() } catch (e) { record(name, false, `EXCEPTION ${e && e.message}`) }
}

// ── A. normalizePropName ────────────────────────────────────────────────────
t('A. normalizePropName 归一与清洗', () => {
  record('去首尾全角空格', normalizePropName('\u3000断桥\u3000') === '断桥', JSON.stringify(normalizePropName('\u3000断桥\u3000')))
  record('去首尾标点（书名号）', normalizePropName('《断桥》') === '断桥', normalizePropName('《断桥》'))
  record('去首尾标点（引号/句号）', normalizePropName('「桥」。') === '桥', normalizePropName('「桥」。'))
  record('半角空格 trim', normalizePropName('  桥  ') === '桥', JSON.stringify(normalizePropName('  桥  ')))
  record('全角空格 → 半角（内部保留）', normalizePropName('腐朽\u3000木桥') === '腐朽 木桥', JSON.stringify(normalizePropName('腐朽\u3000木桥')))
  record('空值安全', normalizePropName(null) === '' && normalizePropName(undefined) === '' && normalizePropName('') === '')
  record('数字安全', normalizePropName(123) === '123', normalizePropName(123))
  record('已是干净名字不变', normalizePropName('腐朽木桥') === '腐朽木桥')
})

// ── B. resolvePropName：三级策略 ─────────────────────────────────────────────
t('B1. ① 归一后精确相等', () => {
  record('精确命中', resolvePropName('腐朽木桥', ['浮冰', '腐朽木桥']) === '腐朽木桥')
  record('带首尾噪声仍命中', resolvePropName(' 《腐朽木桥》 ', ['腐朽木桥']) === '腐朽木桥')
  record('全角空格命中', resolvePropName('\u3000浮冰\u3000', ['浮冰']) === '浮冰')
})

t('B2. ② 去状态后缀后精确', () => {
  record('raw 带后缀 → 命中裸名候选', resolvePropName('桥#broken', ['桥']) === '桥')
  record('raw 裸名 → 命中带后缀候选', resolvePropName('腐朽木桥', ['腐朽木桥#broken']) === '腐朽木桥#broken')
})

t('B3. ③ 唯一候选包含', () => {
  record('候选包含 raw（木桥 ⊂ 腐朽木桥）', resolvePropName('腐朽木桥', ['木桥', '浮冰']) === '木桥')
  record('raw 包含候选（反向）', resolvePropName('木桥', ['腐朽木桥']) === '腐朽木桥')
})

// ── C. 保守性：多候选不猜 ────────────────────────────────────────────────────
t('C1. 多候选一律返回 null（宁可不匹配也不错配）', () => {
  record('两个候选都包含 raw → null', resolvePropName('桥', ['木桥', '石桥']) === null)
  record('归一后重名 → null', resolvePropName('桥', ['桥', ' 桥 ']) === null)
  record('去后缀后重名 → null', resolvePropName('桥', ['桥#broken', '桥#intact']) === null)
})

t('C2. 【ep4 实景】断桥 vs 腐朽木桥：语义不等价 → 不误配（返回 null，交调用方记 warn）', () => {
  const r = resolvePropName('断桥', ['浮冰', '腐朽木桥'])
  record('ep4 实景不猜配', r === null, String(r))
})

t('C3. 长度护栏：raw 归一后 <2 不参与包含匹配', () => {
  record('单字 raw 不误配长候选', resolvePropName('桥', ['桥头堡']) === null, String(resolvePropName('桥', ['桥头堡'])))
})

// ── D. 纯函数 / 边界安全 ─────────────────────────────────────────────────────
t('D. 空值与脏数据安全、不改入参、幂等', () => {
  record('raw 空 → null', resolvePropName('', ['a']) === null && resolvePropName(null, ['a']) === null)
  record('候选空 → null', resolvePropName('a', []) === null && resolvePropName('a', null) === null && resolvePropName('a', undefined) === null)
  record('对象/数组 raw 不抛异常', (() => { try { resolvePropName({}, ['a']); resolvePropName(['x'], ['a']); return true } catch { return false } })())
  const candidates = ['浮冰', '腐朽木桥']
  const snapshot = JSON.stringify(candidates)
  resolvePropName('断桥', candidates)
  record('不修改入参数组', JSON.stringify(candidates) === snapshot)
  const a = resolvePropName('腐朽木桥', ['浮冰', '腐朽木桥'])
  const b = resolvePropName('腐朽木桥', ['浮冰', '腐朽木桥'])
  record('幂等', a === b && a === '腐朽木桥')
})

// ── E. 通用性铁律（静态）─────────────────────────────────────────────────────
t('E. 通用性：模块内无 CJK 字符类正则、无具体题材词硬编码', () => {
  const src = fs.readFileSync(new URL('../ai/propNameMatch.js', import.meta.url), 'utf8')
  record('无 CJK 字符类正则（\\u4e00-\\u9fff 等）', !/\\u4e00|\\u9fff|\[一-龥\]/.test(src))
  // 只在**代码体**（去注释）里查具体道具名；注释里出现 exemplar 名字是允许的（说明用）
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  record('代码体不含 exemplar 道具名', !/断桥|腐朽木桥|浮冰/.test(codeOnly))
})

// ── F. 接入点静态守卫（双路同源 + 4 处消费端）───────────────────────────────
t('F. 4 处消费端均接入 resolvePropName，且 generate-video 双路同源', () => {
  const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8')
  const anchors = read('../ai/sceneAnchors.js')
  const video = read('../routes/generate-video.js')
  const image = read('../routes/generate-image.js')
  const count = (s, re) => (s.match(re) || []).length
  record('sceneAnchors 接入', count(anchors, /resolvePropName/g) >= 2, `命中 ${count(anchors, /resolvePropName/g)}`)
  record('generate-image 接入', count(image, /resolvePropName/g) >= 2, `命中 ${count(image, /resolvePropName/g)}`)
  // generate-video：import(1) + 单镜(1) + 段级(1) → 至少 3
  record('generate-video 双路都接入（≥3：import+单镜+段级）', count(video, /resolvePropName/g) >= 3, `命中 ${count(video, /resolvePropName/g)}`)
  record('两路都声明了同源注释', count(video, /同源/g) >= 2)
})

const failed = results.filter((r) => !r.ok)
process.stdout.write(`\n==== propNameMatch: ${results.length - failed.length}/${results.length} passed ====\n`)
if (failed.length) {
  process.stdout.write(`FAILED:\n${failed.map((f) => `  - ${f.name}`).join('\n')}\n`)
  process.exit(1)
}
