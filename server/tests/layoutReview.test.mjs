// A3 布局图生成后闸 · 测试（2026-09-17）
//
// 覆盖三块：
//   A. parseLayoutReview —— 脏输入降级、类型闭集收敛（绝不能让"未知类型"漏成放行）
//   B. buildLayoutRetryNote —— 只针对实际检出项加固；空清单返回 ''（首轮 prompt 逐字不变）
//   C. resolveLocalLayoutImage —— 路径收敛（只收 /uploads/ 下，防目录穿越）
//   D. 静态断言 —— route 里确实接了闭环、且降级不阻断
//   E. 通用性铁律 —— 全链零题材词表、零正则匹配画面内容

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  parseLayoutReview, buildLayoutRetryNote, resolveLocalLayoutImage,
  LAYOUT_DEFECT_TYPES, MAX_LAYOUT_ATTEMPTS,
} from '../ai/layoutReview.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ::  ${detail}` : ''}\n`)
}

// ===== A. parseLayoutReview：脏输入降级 + 类型闭集 =====
record('解析：正常 JSON 抽出 defects 与 summary',
  (() => {
    const r = parseLayoutReview('{"defects":[{"type":"text","evidence":"左上角有 broken bridge 字样"}],"summary":"有文字"}')
    return r.defects.length === 1 && r.defects[0].type === 'text' && r.summary === '有文字'
  })())

record('解析：干净图（defects 为空数组）→ 空清单',
  parseLayoutReview('{"defects":[],"summary":"干净"}').defects.length === 0)

record('解析：非 JSON 垃圾串 → 降级空清单（不抛错、不误杀）',
  parseLayoutReview('模型今天不想说话').defects.length === 0
  && parseLayoutReview('').defects.length === 0
  && parseLayoutReview(null).defects.length === 0)

record('解析：JSON 前后混有解释文字也能抽出（抠 {} 区间）',
  (() => {
    const r = parseLayoutReview('好的，我的判断是：{"defects":[{"type":"character","evidence":"右下有动物剪影"}],"summary":"有角色"} 以上。')
    return r.defects.length === 1 && r.defects[0].type === 'character'
  })())

record('【核心】解析：未知 type **收敛为 text**（最危险的默认，绝不放行）',
  (() => {
    const r = parseLayoutReview('{"defects":[{"type":"unknown_thing","evidence":"x"}],"summary":""}')
    return r.defects.length === 1 && r.defects[0].type === 'text'
  })(),
  '闭集外的类型一律按 text 处理 —— 宁可多判不算，不可漏判')

record('解析：缺 type 的项被丢弃（不会产生 undefined 类型）',
  parseLayoutReview('{"defects":[{"evidence":"no type"},{"type":"text","evidence":"ok"}]}').defects.length === 1)

record('解析：evidence 超长被截断（防超长串污染前端）',
  parseLayoutReview(JSON.stringify({ defects: [{ type: 'text', evidence: 'x'.repeat(500) }], summary: '' }))
    .defects[0].evidence.length === 200)

record('defect 类型是闭集且含五类', LAYOUT_DEFECT_TYPES.length === 5
  && ['text', 'leader_line', 'character', 'extra_object', 'atmosphere'].every((t) => LAYOUT_DEFECT_TYPES.includes(t)))

// ===== B. buildLayoutRetryNote：只针对实际检出项 =====
record('加固：空清单 → 空串（首轮 prompt 因此逐字不变）',
  buildLayoutRetryNote([]) === '' && buildLayoutRetryNote(null) === '' && buildLayoutRetryNote(undefined) === '')

record('加固：检出 text → 含"一个字都不许有"的针对性指令',
  (() => {
    const s = buildLayoutRetryNote([{ type: 'text', evidence: 'e' }])
    return s.includes('一个字都不许有') && s.includes('汉字')
  })())

record('加固：**只**针对检出的类型，不预防性堆砌其他项',
  (() => {
    const s = buildLayoutRetryNote([{ type: 'text' }])
    return s.includes('汉字') && !s.includes('角色、人物、动物') && !s.includes('雾、云、雨、雪')
  })(),
  '实测证明预防性堆砌无效 —— 只加固实际发生的问题')

record('加固：检出 character → 提到角色/动物/脚印',
  (() => {
    const s = buildLayoutRetryNote([{ type: 'character' }])
    return s.includes('角色、人物、动物') && s.includes('脚印')
  })())

record('加固：多个类型叠加（text + atmosphere）',
  (() => {
    const s = buildLayoutRetryNote([{ type: 'text' }, { type: 'atmosphere' }])
    return s.includes('汉字') && s.includes('光晕')
  })())

record('加固：未知类型被忽略（与解析同口径，不产生悬空文案）',
  (() => {
    const s = buildLayoutRetryNote([{ type: 'nonsense' }])
    return s === ''
  })())

record('加固：文案里带"上一版不合格"的交代（让模型知道这是重试）',
  buildLayoutRetryNote([{ type: 'text' }]).includes('上一版'))

// ===== C. resolveLocalLayoutImage：路径收敛 =====
record('取图：合法 /uploads/ 路径（不存在的文件）返回 null 而非抛错',
  resolveLocalLayoutImage('/uploads/__nope__.png') === null)

record('【安全】取图：拒绝目录穿越（/uploads/../data.db）',
  resolveLocalLayoutImage('/uploads/../data.db') === null
  && resolveLocalLayoutImage('/uploads/..%2Fdata.db') === null,
  '只接受 /uploads/<单段文件名>')

record('【安全】取图：拒绝绝对路径与外部 URL',
  resolveLocalLayoutImage('/etc/passwd') === null
  && resolveLocalLayoutImage('C:/Windows/win.ini') === null
  && resolveLocalLayoutImage('http://evil.com/a.png') === null
  && resolveLocalLayoutImage('https://evil.com/uploads/a.png') === null)

record('取图：空/非字符串输入返回 null',
  resolveLocalLayoutImage('') === null && resolveLocalLayoutImage(null) === null
  && resolveLocalLayoutImage(undefined) === null && resolveLocalLayoutImage({}) === null)

record('重试上限是 3（每次重试都是一次付费生图，不可放大）', MAX_LAYOUT_ATTEMPTS === 3)

// ===== D. 静态断言：闭环确实接进了 route =====
const routeSrc = readFileSync(path.join(ROOT, 'server/routes/generate-image.js'), 'utf8')

record('【核心】route 里确实调用了生成后闸 reviewLayoutImage',
  routeSrc.includes('await reviewLayoutImage('))

record('【核心】route 里确实把检出的 defects 转成了重试指令',
  routeSrc.includes('buildLayoutRetryNote(review.defects)'))

record('【核心】重试时把 retryNote 传回 prompt builder',
  /buildLayoutImagePrompt\(\{[\s\S]{0,400}?retryNote,/.test(routeSrc))

record('【核心】重试有上限，不会无限循环',
  routeSrc.includes('attempt <= MAX_LAYOUT_ATTEMPTS'))

record('【降级铁律】闸门故障(verdict!=fail)时放行 —— 只有 fail 才重试',
  /if \(review\.verdict !== 'fail'\) \{[\s\S]{0,120}?break/.test(routeSrc))

record('【降级铁律】重试用尽仍用最后一版，绝不因质检不通过而阻断出图',
  routeSrc.includes('仍用最后一版（不阻断流程）') && routeSrc.includes('if (!finalUrl)'))

record('回执里带 layoutReview（前端可提示质检状态与重试次数）',
  routeSrc.includes('layoutReview: {') && routeSrc.includes('maxAttempts: MAX_LAYOUT_ATTEMPTS'))

// ===== E. 通用性铁律 =====
const reviewSrc = readFileSync(path.join(ROOT, 'server/ai/layoutReview.js'), 'utf8')

record('【通用性】判定逻辑全交视觉模型 —— 代码不读像素、不做图像处理',
  !/sharp|jimp|getPixel|pixelmatch|canvas|Resize/.test(reviewSrc),
  '零图像算法：换题材/换语言不改代码')

record('【通用性】零题材词表（不出现本片题材实词做判断）',
  !/if\s*\([^)]*(断桥|崖|冰河|松林|熊猫|白熊)[^)]*\)/.test(reviewSrc))

record('【通用性】违规类型是**通用视觉概念**（文字/引线/角色/多余物体/大气），非题材概念',
  LAYOUT_DEFECT_TYPES.every((t) => /^[a-z_]+$/.test(t)),
  LAYOUT_DEFECT_TYPES.join(','))

record('【通用性】重试文案只描述通用视觉约束，不含题材实词',
  (() => {
    const s = buildLayoutRetryNote(LAYOUT_DEFECT_TYPES.map((t) => ({ type: t })))
    return !/断桥|崖|冰河|松林|熊猫|白熊/.test(s)
  })())

// 汇总
const passed = results.filter((r) => r.ok).length
const failed = results.length - passed
process.stdout.write(`\n==== layoutReview: ${passed}/${results.length} passed ====\n`)
if (failed) {
  process.stdout.write(`FAILED:\n${results.filter((r) => !r.ok).map((r) => '  - ' + r.name).join('\n')}\n`)
  process.exit(1)
}
