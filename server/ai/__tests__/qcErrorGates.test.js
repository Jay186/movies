import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { config } from '../../config.js'
import { validateStoryboard } from '../storyboardValidator.js'
import { QC_CODES, QC_LEVEL } from '../qcCodes.js'

// DIALOGUE_IN_AIRLOCK 是 ERROR 级「回退码」：仅在旧 Airlock 冻结模式（AIRLOCK_SEC>0）下产出。
// 本门禁 selftest 要求每个 ERROR 码都有试咬样本，故把 config.storyboard.airlockSec 置为 2
//（默认 0 时该门不产出，样例会失效）。validator 判定时读取当前 config，故同进程切换即生效。
config.storyboard.airlockSec = 2

// ERROR 级门禁 selftest 样本集（改 validator / qcCodes 后必跑：node --test ai/__tests__/qcErrorGates.test.js）
// 结构：1 个 good 样本（0 error，证明门不乱咬好人）+ 每个 ERROR 码 1 个 bad 样本
// （只踩中自己那道门——若额外命中其它 ERROR 码，说明样本构造污染，需修正样本而非放宽断言）。
// 新增 ERROR 码时「覆盖率」测试会强制要求补样本，防止门禁静默失咬。

const ERROR_CODES = Object.entries(QC_CODES)
  .filter(([, m]) => m.level === QC_LEVEL.ERROR)
  .map(([code]) => code)

const PROMPT =
  'The camera opens holding the exact final-frame composition of the previous segment. ' +
  '@角色甲 stands at frame left, breathing gently, warm golden light from frame left, ' +
  'snow crystals glinting on the fur, the pine tree stands at frame right behind him.'

const makeShot = (overrides = {}) => ({
  shotNumber: 'S1',
  duration: 8,
  startTime: 0,
  endTime: 8,
  description: '@角色甲 在雪地里奔跑，望向远处的场景乙。',
  integratedMultimodalDescription: PROMPT,
  finalFrame:
    '@角色甲 stands at frame left, warm golden light from frame left, gazes toward the forest, ' +
    'the pine tree stands at frame right behind him.',
  characters: ['角色甲'],
  sceneAssets: [],
  propAssets: [],
  dialogue: null,
  shotType: '中景',
  cameraAngle: '正面',
  cameraMovement: '固定',
  nonDiegeticMusic: '低音鼓点逐渐加强，弦乐缓慢上行',
  overallSoundscape: '风声与踩雪声',
  soundEffects: '',
  actionNote: 'At 0.0s 保持站立呼吸；At 2.0s 望向远处；末 1.0s 静止',
  worldStateOut: '',
  ...overrides,
})

const run = (shot, { assetNames = null, scriptText = '' } = {}) =>
  validateStoryboard({ scenes: [{ shots: [shot] }] }, assetNames, scriptText ? { scriptText } : {})

const errorCodesOf = (r) => [...new Set(r.codedErrors.map((c) => c.code))]

// 只踩中一门：命中设计码，且不命中任何其它 ERROR 码
function assertSingleGate(r, expected) {
  const codes = errorCodesOf(r)
  assert.ok(codes.includes(expected), `应命中 ${expected}，实际命中：${codes.join('、') || '（无）'}；errors=${r.errors.join(' | ')}`)
  const others = codes.filter((c) => c !== expected && ERROR_CODES.includes(c))
  assert.deepEqual(others, [], `样本污染：额外命中其它 ERROR 码 ${others.join('、')}`)
}

// —— bad 样本表：每行 = [错误码, 样本变异函数, 运行选项] ——
const BAD_SAMPLES = [
  ['STYLE_POISON',
    (s) => ({ ...s, description: '画面很写实，光影逼真' }),
    {}],
  ['CHARACTER_SPECIES_DRIFT',
    (s) => ({ ...s, description: '@角色甲 竖起长长的耳朵，像兔子一样跳动。' }),
    { assetNames: { characters: [{ name: '角色甲', description: '棕色的小熊，圆耳朵' }], scenes: [], props: [] } }],
  ['WS_SPEAKER_MISSING',
    (s) => ({ ...s, worldStateOut: '@角色乙：画面左·直立', dialogue: { character: '角色甲', text: '站住', startTime: 3 } }),
    {}],
  ['WS_SIDE_MISMATCH',
    (s) => ({ ...s, worldStateOut: '@角色甲：画面左·直立',
      finalFrame: '@角色甲 stands at frame right, warm golden light from frame left.' }),
    {}],
  ['DIALOGUE_IN_AIRLOCK',
    (s) => ({ ...s, dialogue: { character: '角色甲', text: '快跑', startTime: 1 } }),
    {}],
  ['DIALOGUE_OVERFLOW',
    (s) => ({ ...s, dialogue: { character: '角色甲', text: '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十', startTime: 6 } }),
    {}],
  ['PROMPT_OVER_LIMIT',
    (s) => ({ ...s, description: '描'.repeat(8000) }),
    {}],
]

describe('QC ERROR 级门禁 selftest 样本集', () => {
  test('good 样本：0 error（门不乱咬好人）', () => {
    const r = run(makeShot())
    assert.deepEqual(r.errors, [])
    assert.deepEqual(errorCodesOf(r), [])
  })

  for (const [code, mutate, opts] of BAD_SAMPLES) {
    test(`bad 样本只踩中 ${code}`, () => {
      const r = run(mutate(makeShot()), opts)
      assertSingleGate(r, code)
    })
  }

  test('MUST_FIX（无码硬错误）：finalFrame/IMD 缺失即报错', () => {
    const r = run({ duration: 5, startTime: 0, endTime: 5 })
    assert.ok(r.errors.length >= 2, `应至少报 finalFrame 与 IMD 两个硬错误，实际：${r.errors.join(' | ')}`)
    assert.deepEqual(errorCodesOf(r), [])
  })

  test('DIALOGUE_VERBATIM：逐字命中剧本原文不报错', () => {
    const shot = makeShot({ dialogue: { character: '角色甲', text: '站住，别再靠近。', startTime: 3 } })
    const r = run(shot, { scriptText: '角色甲从树后闪出，喝道：站住，别再靠近。对方停步。' })
    assert.ok(!errorCodesOf(r).includes('DIALOGUE_VERBATIM'))
  })

  test('DIALOGUE_VERBATIM：改写一字（。→！）即命中', () => {
    const shot = makeShot({ dialogue: { character: '角色甲', text: '站住，别再靠近！', startTime: 3 } })
    const r = run(shot, { scriptText: '角色甲从树后闪出，喝道：站住，别再靠近。对方停步。' })
    assertSingleGate(r, 'DIALOGUE_VERBATIM')
  })

  test('DIALOGUE_VERBATIM：不传剧本原文不查（旧链路不制造洪水）', () => {
    const shot = makeShot({ dialogue: { character: '角色甲', text: '任意一句台词', startTime: 3 } })
    const r = run(shot)
    assert.deepEqual(errorCodesOf(r), [])
  })

  test('覆盖率：每个 ERROR 码都必须有试咬样本', () => {
    const covered = new Set([...BAD_SAMPLES.map(([code]) => code), 'DIALOGUE_VERBATIM', 'MUST_FIX'])
    const missing = ERROR_CODES.filter((c) => !covered.has(c))
    assert.deepEqual(missing, [], `缺少试咬样本的 ERROR 码：${missing.join('、')}（请在 BAD_SAMPLES 补充）`)
  })
})
