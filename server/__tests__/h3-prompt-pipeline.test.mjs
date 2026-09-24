// H3 出片管线防线测试（2026-09-23 超限事故后补）：
// ① collectShot 跨场次场景挂载拦截（生产代码 createRefCollector 直调，不复制源码）
// ② QC 长度估算含参考素材开销（estimateShotVideoPromptChars / estimateRefsPromptCost）
// ③ retention_analysis 去重复开关（buildShotVideoPromptV4 真实组装）
// ④ 出片 prompt 官方结构钉死（段落顺序 + 标签格式，防静默漂移）
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { useTempDb } from './helpers.mjs'

const tmp = useTempDb('h3-prompt-pipeline')

describe('H3 出片管线防线', () => {
  let query, queryOne
  let createRefCollector, estimateRefsPromptCost, estimateShotVideoPromptChars, buildShotVideoPromptV4, config

  before(async () => {
    const dbMod = await import('../db.js')
    dbMod.initDB()
    ;({ query, queryOne } = dbMod)
    ;({ createRefCollector } = await import('../routes/generate-video.js'))
    ;({ estimateRefsPromptCost, estimateShotVideoPromptChars } = await import('../ai/storyboardValidator.js'))
    ;({ buildShotVideoPromptV4 } = await import('../ai/v4Video.js'))
    ;({ config } = await import('../config.js'))
  })

  after(async () => {
    try { if (config?.video) delete config.video.h3RetentionFullDesc } catch {}
    await tmp.cleanup()
  })

  const mkCtx = () => ({
    charRowsAll: [
      { name: '大白熊', name_en: 'the Great White Bear', description: '', description_en: 'A'.repeat(175), image_url: '/c1.png' },
      { name: '一二', name_en: 'Yier', description: '', description_en: 'B'.repeat(237), image_url: '/c2.png' },
      { name: '布布', name_en: 'Bubu', description: '', description_en: 'C'.repeat(233), image_url: '/c3.png' },
    ],
    sceneRows: [
      { title: '冰河中央', scene_number: 4, title_en: 'Ice River Center', summary: '', summary_en: 'D'.repeat(349), image_url: '/s4.png', lighting_en: 'E'.repeat(114) },
      { title: '冰河边', scene_number: 2, title_en: 'Ice River Bank', summary: '', summary_en: 'F'.repeat(332), image_url: '/s2.png', lighting_en: 'G'.repeat(106) },
    ],
    propRows: [
      { name: '浮冰', name_en: 'Floating Ice', description: '', description_en: 'H'.repeat(154), image_url: '/p1.png' },
    ],
    propTableNames: ['浮冰'],
    sceneTitles: ['冰河中央', '冰河边'],
  })

  test('① 跨场次场景挂载：挂错场的图不进 refs，并落一条 sceneCrossScene 告警', () => {
    const collector = createRefCollector({ episodeId: 1, ctx: mkCtx(), scopeLabel: '镜' })
    collector.collectShot({
      characters: JSON.stringify(['大白熊']),
      scene_assets: JSON.stringify(['冰河中央', '冰河边']),  // 冰河边属场2，本镜场4
      prop_assets: JSON.stringify(['浮冰']),
      scene_number: 4,
      shot_number: '4-4',
    }, 999)
    const kinds = collector.refs.map((r) => `${r.kind}:${r.label}`)
    assert.deepEqual(kinds, ['character:大白熊', 'scene:冰河中央', 'prop:浮冰'],
      `跨场场景「冰河边」应被拦截，实得 refs=${JSON.stringify(kinds)}`)
    const alert = queryOne("SELECT * FROM system_alerts WHERE source = 'sceneCrossScene' AND shot_id = 999")
    assert.ok(alert, '应落 sceneCrossScene 告警')
    assert.match(alert.message, /冰河边/)
  })

  test('① 本场挂载不受影响（零误伤）', () => {
    const collector = createRefCollector({ episodeId: 1, ctx: mkCtx(), scopeLabel: '镜' })
    collector.collectShot({
      characters: JSON.stringify(['一二']),
      scene_assets: JSON.stringify(['冰河中央']),
      prop_assets: '[]',
      scene_number: 4,
      shot_number: '4-1',
    }, 998)
    assert.equal(collector.refs.length, 2, `本场挂载应全进 refs，实得 ${collector.refs.length}`)
    assert.equal(queryOne("SELECT COUNT(*) AS n FROM system_alerts WHERE source = 'sceneCrossScene' AND shot_id = 998")?.n, 0)
  })

  test('② 估算：无资产数据时按 850/ref 均值兜底（宁高估不误放）', () => {
    const shot = { characters: ['a', 'b'], sceneAssets: ['s1', 's2', 's3'], propAssets: ['p1'] }
    assert.equal(estimateRefsPromptCost(shot), 6 * 850)
  })

  test('② 估算：4-4 真实形状估算 = 6153（标定值钉死，防回归）', () => {
    const shot = {
      characters: ['大白熊', '一二', '布布'],
      sceneAssets: ['冰河中央', '冰河边', '冰河'],
      propAssets: ['浮冰'],
    }
    const ctx = {
      assetNames: {
        characters: mkCtx().charRowsAll,
        scenes: [
          { name: '冰河中央', title: '冰河中央', scene_number: 4, description_en: 'D'.repeat(349), lighting_en: 'E'.repeat(114) },
          { name: '冰河边', title: '冰河边', scene_number: 2, description_en: 'F'.repeat(332), lighting_en: 'G'.repeat(106) },
          { name: '冰河', title: '冰河', scene_number: 3, description_en: 'I'.repeat(268), lighting_en: 'J'.repeat(107) },
        ],
        props: [{ name: '浮冰', description_en: 'H'.repeat(154) }],
      },
    }
    assert.equal(estimateRefsPromptCost(shot, ctx), 6153)
    const est = estimateShotVideoPromptChars(shot, ctx)
    assert.ok(est.estimated > 7000, `7 refs 的 4-4 形状估算应超限，实得 ${est.estimated}`)
  })

  test('③ retention 默认去重复；h3RetentionFullDesc=true 回退旧行为', async () => {
    const shot = { shot_type: '中景', camera_movement: '固定', camera_angle: '平视', duration: 6, description: '', action_note: '', final_frame: '', dialogue: '', overall_soundscape: '', non_diegetic_music: '' }
    const refs = [{ kind: 'character', label: '一二', labelEn: 'Yier', desc: '', descEn: 'A fluffy white bear cub with a red scarf.', image: '/c.png' }]
    const ctx = { stylePrompt: '', stylePromptEn: '', refs, audioRefs: [], translate: async () => ({}) }

    const p1 = await buildShotVideoPromptV4(shot, ctx)
    assert.match(p1, /fully_preserved - Yier is retained exactly as defined in <Picture 1>\./)
    assert.ok(!p1.includes('A fluffy white bear cub with a red scarf. is retained'), '默认不应重复 descEn')

    config.video = config.video || {}
    config.video.h3RetentionFullDesc = true
    const p2 = await buildShotVideoPromptV4(shot, ctx)
    assert.match(p2, /a fluffy white bear cub with a red scarf is retained from <Picture 1>\./, '开关打开应回退旧行为')
    delete config.video.h3RetentionFullDesc
  })

  test('④ 官方结构钉死：段落顺序、标签格式、关键防护句在位', async () => {
    const shot = { shot_type: '中景', camera_movement: '固定', camera_angle: '平视', duration: 6, description: '', action_note: '', final_frame: '', dialogue: '', overall_soundscape: '', non_diegetic_music: '' }
    const refs = [{ kind: 'character', label: '一二', labelEn: 'Yier', desc: '', descEn: 'small cub', image: '/c.png' }]
    const prompt = await buildShotVideoPromptV4(shot, { stylePrompt: '', stylePromptEn: '', refs, audioRefs: [], translate: async () => ({}) })

    const sections = ['subject_definitions:', 'summary:', 'retention_analysis:', 'detailed_description:', 'overall_soundscape:', 'non_diegetic_music:']
    let lastIdx = -1
    for (const s of sections) {
      const i = prompt.indexOf(s)
      assert.ok(i > lastIdx, `段落 ${s} 缺失或乱序`)
      lastIdx = i
    }
    assert.match(prompt, /<Subject 1> is Yier \(character\) from <Picture 1>/)
    assert.match(prompt, /\[Shot 1\]/)
    assert.match(prompt, /fully_preserved|partially_preserved|weak_reference/)
    assert.match(prompt, /speak only the dialogue inside <d> tags/, '防念提示词防护句必须在')
    assert.match(prompt, /no on-screen text, subtitles, watermark, or logo/)
  })

  // ===== ⑤ 2026-09-23 9627 事故追加：夹具形状纪律 + 跨场同口径 + 贴线预警 =====
  // 夹具纪律（教训）：一律用 DB 行形状（snake_case + JSON 字符串字段）经 rowToShotForQc
  // 转换后测试——上次手搓驼峰数组当生产形状，parseAssetNameList 字符串路径失真未被测试发现。
  // 资产名用中性占位（角色A/场景甲/道具P），不写死任何具体项目内容（AGENTS.md 6.1）。
  const REF_TEMPLATE_COST_V = 230
  const CHAR_MULTIVIEW_COST_V = 130
  const SCENE_LIGHTING_COST_V = 110

  function dbRow(over = {}) {
    return {
      id: 1,
      shot_number: '4-4',
      shot_type: 'medium',
      camera_movement: 'slow push in',
      duration: 6,
      description: 'a'.repeat(200),
      characters: JSON.stringify(['角色A', '角色B', '角色C']),
      scene_assets: JSON.stringify(['场景甲', '场景乙', '场景丙']),
      prop_assets: JSON.stringify(['道具P']),
      action_note: 'b'.repeat(100),
      dialogue: JSON.stringify([{ speaker: '角色A', text: 'c'.repeat(50) }]),
      final_frame: 'd'.repeat(100),
      integrated_multimodal_description: 'm'.repeat(50),
      non_diegetic_music: '',
      is_combat: 0,
      ...over,
    }
  }

  function assetNamesV() {
    return {
      characters: [
        { name: '角色A', description_en: 'e'.repeat(300) },
        { name: '角色B', description_en: 'e'.repeat(300) },
        { name: '角色C', description_en: 'e'.repeat(300) },
      ],
      scenes: [
        { title: '场景甲', scene_number: 4, description_en: 's'.repeat(300), lighting_en: 'l'.repeat(50) },
        { title: '场景乙', scene_number: 2, description_en: 's'.repeat(300), lighting_en: 'l'.repeat(50) },
        { title: '场景丙', scene_number: 3, description_en: 's'.repeat(300), lighting_en: 'l'.repeat(50) },
      ],
      props: [{ name: '道具P', description_en: 'p'.repeat(200) }],
      projectStyleText: '',
      projectId: null,
    }
  }

  test('⑤ rowToShotForQc 把 DB 行的 JSON 字符串字段解析成数组（夹具形状纪律）', async () => {
    const { rowToShotForQc } = await import('../ai/storyboardValidator.js')
    const shot = rowToShotForQc(dbRow())
    assert.deepEqual(shot.characters, ['角色A', '角色B', '角色C'])
    assert.deepEqual(shot.sceneAssets, ['场景甲', '场景乙', '场景丙'])
    assert.deepEqual(shot.propAssets, ['道具P'])
  })

  test('⑤ DB 行形状经 rowToShotForQc 后 refs 开销非 0（夹具失真回归）', async () => {
    const { rowToShotForQc } = await import('../ai/storyboardValidator.js')
    const shot = rowToShotForQc(dbRow())
    const ctx = { assetNames: assetNamesV(), sceneNumber: 4 }
    const cost = estimateRefsPromptCost(shot, ctx)
    assert.ok(cost > 0, 'refs 开销不应为 0（parseAssetNameList 必须吃到数组）')
  })

  test('⑤ 估算跨场场景 ref 与出片拦截同口径：跨场的不计；sceneNumber 缺失不排除（高估安全）', async () => {
    const { rowToShotForQc } = await import('../ai/storyboardValidator.js')
    const shot = rowToShotForQc(dbRow())
    const ctx = { assetNames: assetNamesV(), sceneNumber: 4 }
    // 场景甲=场4（计入），场景乙=场2、场景丙=场3（跨场，出片会拦，估算不计）
    const expected =
      3 * (REF_TEMPLATE_COST_V + 300 * 2 + CHAR_MULTIVIEW_COST_V) + // 角色 ×3
      (REF_TEMPLATE_COST_V + 300 * 2 + SCENE_LIGHTING_COST_V + 50) + // 场景甲
      (REF_TEMPLATE_COST_V + 200 * 2) // 道具P
    const cost = estimateRefsPromptCost(shot, ctx)
    assert.equal(cost, expected)
    const costNoSceneNo = estimateRefsPromptCost(shot, { assetNames: assetNamesV() })
    assert.ok(costNoSceneNo > cost, 'ctx.sceneNumber 缺失时应按不排除口径高估')
  })

  test('⑤ 4-4 形状经 DB 行转换：7 refs 挂载但跨场 2 个，估算只按出片口径 5 refs 计', async () => {
    const { rowToShotForQc } = await import('../ai/storyboardValidator.js')
    const shot = rowToShotForQc(dbRow())
    const ctx = { assetNames: assetNamesV(), sceneNumber: 4 }
    const est = estimateShotVideoPromptChars(shot, ctx)
    // fieldTotal = 200(desc)+100(action)+100(final)+50(dialogue)+12(camera 'slow push in')+6('medium') = 468
    assert.equal(est.fieldTotal, 468)
    assert.equal(est.estimated, 468 + 2000 + est.refsCost)
  })

  test('⑤ PROMPT_NEAR_LIMIT 贴线预警：6300 < estimated ≤ 7000 报 warn，不报 error', async () => {
    const { rowToShotForQc, validateShot } = await import('../ai/storyboardValidator.js')
    // 构造 estimated = 6500：refsCost=2580（1角色300/1场景300+50/1道具200）+ 骨架 2000 → fieldTotal 需 1920
    // fieldTotal = 800(desc)+600(action)+400(final)+102(dialogue)+12(camera)+6(type) = 1920
    const shot = rowToShotForQc(dbRow({
      characters: JSON.stringify(['角色A']),
      scene_assets: JSON.stringify(['场景甲']),
      prop_assets: JSON.stringify(['道具P']),
      description: 'a'.repeat(800),
      action_note: 'b'.repeat(600),
      final_frame: 'd'.repeat(400),
      dialogue: JSON.stringify([{ speaker: '角色A', text: 'c'.repeat(102) }]),
    }))
    const ctx = { assetNames: assetNamesV(), sceneNumber: 4, shotLabel: '4-4' }
    const est = estimateShotVideoPromptChars(shot, ctx)
    assert.equal(est.estimated, 6500)
    const { errors, warnings, codedErrors } = validateShot(shot, ctx)
    assert.equal(errors.length, 0, '贴线不应报 error')
    const warn = warnings.find((w) => w.code === 'PROMPT_NEAR_LIMIT')
    assert.ok(warn, '应有 PROMPT_NEAR_LIMIT warn')
    const { QC_LEVEL } = await import('../ai/qcCodes.js')
    assert.equal(warn.level, QC_LEVEL.WARNING, 'makeWarnings 应按 qcMeta 补 level')
    assert.ok(!codedErrors.some((c) => c.code === 'PROMPT_OVER_LIMIT'))
  })

  test('⑤ PROMPT_OVER_LIMIT 超限仍报 error，且不与贴线 warn 重复', async () => {
    const { rowToShotForQc, validateShot } = await import('../ai/storyboardValidator.js')
    // estimated = 7001（贴线夹具 description +501）
    const shot = rowToShotForQc(dbRow({
      characters: JSON.stringify(['角色A']),
      scene_assets: JSON.stringify(['场景甲']),
      prop_assets: JSON.stringify(['道具P']),
      description: 'a'.repeat(1301),
      action_note: 'b'.repeat(600),
      final_frame: 'd'.repeat(400),
      dialogue: JSON.stringify([{ speaker: '角色A', text: 'c'.repeat(102) }]),
    }))
    const ctx = { assetNames: assetNamesV(), sceneNumber: 4, shotLabel: '4-4' }
    const { errors, warnings, codedErrors } = validateShot(shot, ctx)
    assert.ok(codedErrors.some((c) => c.code === 'PROMPT_OVER_LIMIT'), '应有 PROMPT_OVER_LIMIT')
    assert.ok(errors.length > 0, '应有 error 文案')
    assert.ok(!warnings.some((w) => w.code === 'PROMPT_NEAR_LIMIT'), '超限时不应同时报贴线 warn')
  })

  test('⑤ 远低于贴线阈值无预警', async () => {
    const { rowToShotForQc, validateShot } = await import('../ai/storyboardValidator.js')
    // 1 角色 + 1 场景（本场）refsCost=1950，字段短：4188 < 6300 无预警
    const shot = rowToShotForQc(dbRow({
      characters: JSON.stringify(['角色A']),
      scene_assets: JSON.stringify(['场景甲']),
      prop_assets: JSON.stringify([]),
      description: 'a'.repeat(100),
      action_note: 'b'.repeat(50),
      final_frame: 'd'.repeat(50),
      dialogue: JSON.stringify([{ speaker: '角色A', text: 'c'.repeat(20) }]),
    }))
    const ctx = { assetNames: assetNamesV(), sceneNumber: 4, shotLabel: '4-4' }
    const est = estimateShotVideoPromptChars(shot, ctx)
    assert.ok(est.estimated < 6300, `估算应低于贴线阈值，实际 ${est.estimated}`)
    const { warnings, codedErrors } = validateShot(shot, ctx)
    assert.ok(!warnings.some((w) => w.code === 'PROMPT_NEAR_LIMIT'))
    assert.ok(!codedErrors.some((c) => c.code === 'PROMPT_OVER_LIMIT'))
  })

  test('⑤ PROMPT_NEAR_LIMIT 已在 qcCodes 注册（qcMeta 可查且为 WARNING 级）', async () => {
    const { qcMeta, QC_LEVEL } = await import('../ai/qcCodes.js')
    const meta = qcMeta('PROMPT_NEAR_LIMIT')
    assert.equal(meta.level, QC_LEVEL.WARNING)
  })

  // ===== ⑥ 2026-09-23 9100 事故追加：预算制（两遍组装）——
  // 官方 ref-en §5.2「扩写 350-500 词」与 API「单条 ≤7000 字符」在多 refs 镜上互斥，
  // builder 先量骨架、按剩余空间给翻译器下词数预算，API 硬上限优先于词数质量区间。
  const mkBudgetShot = () => ({ shot_type: '中景', camera_movement: '固定', camera_angle: '平视', duration: 6, description: 'd'.repeat(100), action_note: '', final_frame: 'f'.repeat(300), dialogue: '', overall_soundscape: '', non_diegetic_music: '' })
  const mkBudgetRefs = (n, descLen) => Array.from({ length: n }, (_, i) => ({ kind: 'character', label: `角色${i + 1}`, labelEn: `Char ${i + 1}`, desc: '', descEn: 'x'.repeat(descLen), image: `/c${i}.png` }))

  test('⑥ 重 refs 镜：预算传给翻译器且明显收缩；按预算产出最终 prompt ≤7000', async () => {
    let seenBudget = null
    const translate = async (shot, tctx) => { seenBudget = tctx.wordBudget; return {} }
    const shot = mkBudgetShot()
    const ctx = { stylePrompt: '', stylePromptEn: '', refs: mkBudgetRefs(7, 300), audioRefs: [], translate }
    await buildShotVideoPromptV4(shot, ctx)
    assert.ok(seenBudget, '应把 wordBudget 传给翻译器')
    assert.ok(seenBudget.descActionMax >= 80, '预算下限 80 词兜底')
    assert.ok(seenBudget.descActionMax < 350, `重 refs 镜预算应收缩到官方下限之下（实得 ${seenBudget.descActionMax}）`)

    // 模拟翻译器按预算上限产出（×6 字符/词）+ 声景配乐占满预留，最终 prompt 仍须进线
    const translate2 = async (s, tctx) => ({ description_en: 'y'.repeat(tctx.wordBudget.descActionMax * 6), action_note_en: '', soundscape_en: 'z'.repeat(175), music_en: 'w'.repeat(175) })
    const prompt2 = await buildShotVideoPromptV4(shot, { ...ctx, translate: translate2 })
    assert.ok(prompt2.length <= 7000, `按预算产出的最终 prompt 应 ≤7000，实得 ${prompt2.length}`)
  })

  test('⑥ 轻 refs 镜：预算封顶官方 500 词上限（空间充裕不多给，防反向超写）', async () => {
    let seenBudget = null
    const translate = async (shot, tctx) => { seenBudget = tctx.wordBudget; return {} }
    const shot = mkBudgetShot()
    const ctx = { stylePrompt: '', stylePromptEn: '', refs: mkBudgetRefs(1, 60), audioRefs: [], translate }
    await buildShotVideoPromptV4(shot, ctx)
    assert.equal(seenBudget.descActionMax, 500, '轻 refs 镜预算应封顶在官方 500 词')
  })

  test('⑥ 预算参数不破坏翻译器契约：空字段在发 LLM 前直接返回空（无网络调用）', async () => {
    const { translateShotFields } = await import('../ai/h3PromptTranslator.js')
    const shot = { description: '', action_note: '', overall_soundscape: '', non_diegetic_music: '' }
    const base = { characterNames: [], sceneNames: [], voiceClone: false, voicedNames: [] }
    // 全空字段走 LLM 前置短路（h3PromptTranslator 空值缓存路径），不会发起网络调用
    const p1 = await translateShotFields(shot, { ...base, wordBudget: { descActionMax: 120 } })
    assert.equal(p1.failed, false)
    assert.equal(p1.description_en, '')
  })

  // ===== ⑦ 2026-09-23 7329 事故追加：确定性裁剪（第二道防线）——
  // 预算制生效后翻译器仍超预算 329 字符（LLM 指令遵从残差），组装后按句边界裁扩写尾部，
  // 数学保证进线，不再依赖 LLM 听话。
  test('⑦ 翻译器无视预算严重超写：确定性裁剪兜底，最终 prompt 仍 ≤7000 且结构完整', async () => {
    const shot = mkBudgetShot()
    const heavyCtx = { stylePrompt: '', stylePromptEn: '', refs: mkBudgetRefs(7, 300), audioRefs: [] }
    // 恶意翻译器：完全无视预算，返回远超预算的扩写（模拟 LLM 不遵从）
    const rogueTranslate = async () => ({
      description_en: ('v'.repeat(599) + '. ').repeat(10), // ~6000 字符，远超任何预算
      action_note_en: '',
      soundscape_en: 'z'.repeat(175),
      music_en: 'w'.repeat(175),
    })
    const prompt = await buildShotVideoPromptV4(shot, { ...heavyCtx, translate: rogueTranslate })
    assert.ok(prompt.length <= 7000, `无视预算的产出也必须被裁进线，实得 ${prompt.length}`)
    // 结构完整性：六段仍在且有序
    const sections = ['subject_definitions:', 'summary:', 'retention_analysis:', 'detailed_description:', 'overall_soundscape:', 'non_diegetic_music:']
    let lastIdx = -1
    for (const s of sections) {
      const i = prompt.indexOf(s)
      assert.ok(i > lastIdx, `裁剪后段落 ${s} 缺失或乱序`)
      lastIdx = i
    }
    // 裁的是扩写尾部，头部应保留（首帧锚定信息优先）
    assert.ok(prompt.includes('v'.repeat(200)), '扩写头部应保留（裁的是尾部不是全部）')
  })

  test('⑦ 裁剪保句边界：扩写文本被裁后不残留半截句', async () => {
    const shot = mkBudgetShot()
    const heavyCtx = { stylePrompt: '', stylePromptEn: '', refs: mkBudgetRefs(7, 300), audioRefs: [] }
    const rogueTranslate = async () => ({
      description_en: ('full sentence one. full sentence two. full sentence three. ').repeat(30),
      action_note_en: '',
      soundscape_en: '',
      music_en: '',
    })
    const prompt = await buildShotVideoPromptV4(shot, { ...heavyCtx, translate: rogueTranslate })
    assert.ok(prompt.length <= 7000, `实得 ${prompt.length}`)
    // detailed_description 段内首句（头部锚定）必须在——裁的是尾部
    const dd = prompt.slice(prompt.indexOf('detailed_description:'))
    assert.ok(dd.includes('full sentence one.'), '首句（头部锚定）必须在')
  })
})
