// IMD 混合编译（纯函数）：模块分组、物种漂移/毒词清除、资产原文注入、缺英文保留 LLM 版、Airlock 保留
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { useTempDb } from './helpers.mjs'

// imdCompiler 是纯函数模块，但保险起见仍指向临时库（防传递依赖意外触库）
const tmp = useTempDb('imd-compile')

const ASSETS = {
  characters: [
    { name: '一二', description: '白色圆滚小熊', description_en: 'a white panda dumpling with two solid dark-brown round ears, small black dot eyes, pink blush cheeks' },
    { name: '布哥熊', description: '棕色的熊', description_en: 'a light-brown bear dumpling with small round brown ears and a pink nose' },
  ],
  scenes: [
    { title: '客厅', summary: '温暖的客厅', summary_en: 'warm living room with wooden floor and a big window', lighting_en: 'Warm morning sunlight streams through the window' },
    { title: '江边', summary: '黄昏江边', summary_en: 'riverside at dusk with reeds' },
  ],
  props: [
    { name: '布布玩偶', description: '旧布玩偶', description_en: 'an old patchwork plush doll' },
  ],
}

const LLM_IMD = [
  '[Shot 1] 2D hand-drawn watercolor animation, warm morning light. Wide shot, 中距离, 正前方平视, slow push in.',
  '@一二, exactly as shown, a realistic CGI grey wolf with sharp teeth and photorealistic fur. @布哥熊, exactly as shown, a small blue bird.',
  'The frozen glacier remains completely unchanged in structure, color, and arrangement throughout the entire segment.',
  'At 00:02.000, @一二 picks up @布布玩偶 gently, the doll rests upright in her paws, its weave unchanged, it does not fall.',
  'The 布布玩偶 belongs exclusively to @一二, and @布哥熊 does not hold it at any point.',
  'The final frame: @一二 stands at frame left, gazing toward frame right.',
].join('\n')

describe('IMD 混合编译', () => {
  let compileIntegratedModules, buildModule2, buildModule3, groupImdModules

  before(async () => {
    ;({ compileIntegratedModules, buildModule2, buildModule3, groupImdModules } = await import('../ai/imdCompiler.js'))
  })

  after(async () => { await tmp.cleanup() })

  test('模块分组：6 模块分类正确', () => {
    const groups = groupImdModules(LLM_IMD)
    assert.equal(groups.length, 6, JSON.stringify(groups.map((g) => g.kind)))
    assert.deepEqual(groups.map((g) => g.kind), ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'])
  })

  test('混合编译主流程：模块2/3 被注入，漂移与毒词被清除', () => {
    const r = compileIntegratedModules(LLM_IMD, {
      characters: ['一二', '布哥熊'],
      sceneAssets: ['客厅'],
      propAssets: ['布布玩偶'],
      dialogue: [{ character: '一二', tone: '轻快', text: '布哥熊，你看！' }],
    }, ASSETS)
    assert.equal(r.injected.join(','), 'm2,m3', JSON.stringify(r.injected))
    assert.ok(!/wolf|grey/i.test(r.text) && r.text.includes('a white panda dumpling'), '物种漂移未清除')
    assert.ok(r.text.includes('a light-brown bear dumpling'))
    assert.ok(!/realistic|photoreal/i.test(r.text), '画风毒词未清除')
    assert.ok(/@一二 speaks/.test(r.text) && /@布哥熊 remains completely silent/.test(r.text), 'speaking rule 推导错误')
    assert.ok(r.text.includes('warm living room with wooden floor and a big window'))
    assert.ok(r.text.includes('Lighting stays constant: Warm morning sunlight streams through the window'))
    assert.ok(!/glacier/i.test(r.text), 'LLM 版错误场景未清除')
    assert.ok(r.text.startsWith('[Shot 1]'), '模块1 未保留')
    assert.ok(r.text.includes('At 00:02.000'), '模块4 未保留')
    assert.ok(r.text.includes('belongs exclusively to @一二'), '模块5 未保留')
    assert.ok(r.text.includes('The final frame: @一二 stands at frame left'), '模块6 未保留')
    const idx = (s) => r.text.indexOf(s)
    assert.ok(
      idx('[Shot 1]') < idx('a white panda dumpling')
      && idx('a white panda dumpling') < idx('warm living room')
      && idx('warm living room') < idx('At 00:02.000')
      && idx('At 00:02.000') < idx('belongs exclusively')
      && idx('belongs exclusively') < idx('The final frame:'),
      '模块顺序被打乱',
    )
  })

  test('无对白 → 全员闭嘴', () => {
    const r = compileIntegratedModules(LLM_IMD, {
      characters: ['一二'], sceneAssets: ['客厅'], propAssets: [], dialogue: null,
    }, ASSETS)
    assert.ok(r.text.includes("no dialogue — all characters' lips remain completely closed"), r.text)
  })

  test('角色缺 description_en → 模块2 保留 LLM 版', () => {
    const r = compileIntegratedModules(LLM_IMD, {
      characters: ['一二', '新角色'], sceneAssets: ['客厅'], propAssets: [], dialogue: null,
    }, ASSETS)
    assert.ok(r.kept.includes('m2') && !r.injected.includes('m2'), JSON.stringify({ injected: r.injected, kept: r.kept }))
    assert.ok(r.injected.includes('m3'), '模块3 不应受影响')
  })

  test('场景缺 summary_en → 模块3 保留 LLM 版', () => {
    const r = compileIntegratedModules(LLM_IMD, {
      characters: ['一二'], sceneAssets: ['新场景'], propAssets: [], dialogue: null,
    }, ASSETS)
    assert.ok(r.kept.includes('m3') && !r.injected.includes('m3'))
  })

  test('description_en 含中文（脏数据）→ 模块2 保留 LLM 版', () => {
    const r = compileIntegratedModules(LLM_IMD, {
      characters: ['一二'], sceneAssets: ['客厅'], propAssets: [], dialogue: null,
    }, { characters: [{ name: '一二', description_en: '白色小熊（中文脏数据）' }], scenes: ASSETS.scenes })
    assert.ok(r.kept.includes('m2'), JSON.stringify(r))
  })

  test('多场景模块3：逐个注入，无光影常量不加 Lighting 句', () => {
    const m3 = buildModule3({ sceneAssets: ['客厅', '江边'] }, ASSETS)
    assert.ok(m3.includes('warm living room') && m3.includes('riverside at dusk'), m3)
    assert.ok(!/riverside at dusk[\s\S]*Lighting/.test(m3), '无 lighting_en 的场景不应有 Lighting 句')
  })

  test('Airlock 段保留且位于模块2 之前', () => {
    const IMD_AIRLOCK = [
      '[Shot 1] 2D hand-drawn style. Medium shot.',
      'The camera opens holding the exact final-frame composition of the previous segment — @一二 at frame left.',
      '@一二, exactly as shown, a grey wolf.',
      'The room remains completely unchanged in structure, color, and arrangement throughout the entire segment.',
      'The final frame: @一二 at frame left.',
    ].join('\n')
    const r = compileIntegratedModules(IMD_AIRLOCK, {
      characters: ['一二'], sceneAssets: ['客厅'], propAssets: [], dialogue: null,
    }, ASSETS)
    const a = r.text.indexOf('The camera opens holding')
    const m2 = r.text.indexOf('a white panda dumpling')
    assert.ok(a !== -1 && a < m2, r.text)
  })

  test('buildModule2 直测：单角色单说话人 / 空角色 / 无 assets', () => {
    const m2 = buildModule2({ characters: ['一二'], dialogue: [{ character: '一二', text: 'x' }] }, ASSETS)
    assert.equal(m2, '@一二, exactly as shown, a white panda dumpling with two solid dark-brown round ears, small black dot eyes, pink blush cheeks.\nSpeaking rule for this segment: @一二 speaks.', m2)
    assert.equal(buildModule2({ characters: [] }, ASSETS), null)
    assert.equal(buildModule2({ characters: ['一二'] }, null), null)
  })
})
