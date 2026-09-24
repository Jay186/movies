import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  validateShot,
  validateStoryboard,
  hasExplicitReposition,
  extractScreenSides,
  buildAliasMap,
  findStylePoison,
  checkSceneIndexAlignment,
  rowToShotForQc,
  suggestUnregisteredProps,
} from '../storyboardValidator.js'

// 基线镜头：提示词长度需超过 thinPromptChars（默认 80），否则会触发 LONG_SHOT_THIN_PROMPT
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
  ...overrides,
})

const codes = (list) => list.map((w) => w.code)

describe('画面地理：走位与侧位识别', () => {
  test('hasExplicitReposition 只在动作时间轴写明走位时为真', () => {
    assert.equal(hasExplicitReposition('At 00:03.000, @角色甲 walks to frame right', 'right'), true)
    assert.equal(hasExplicitReposition('@角色甲 stands at frame right', 'right'), false)
    assert.equal(hasExplicitReposition('@角色甲 walks to frame right', 'left'), false)
    assert.equal(hasExplicitReposition('', 'right'), false)
  })

  test('extractScreenSides 用绝对画面坐标判定侧位', () => {
    const sides = extractScreenSides('@角色甲 at frame left, @角色乙 at frame right', ['角色甲', '角色乙'])
    assert.equal(sides.get('角色甲'), 'left')
    assert.equal(sides.get('角色乙'), 'right')
  })

  test('extractScreenSides 支持 center frame 与别名（name_en / aliases）', () => {
    assert.equal(extractScreenSides('@角色甲 at center frame', ['角色甲']).get('角色甲'), 'center')

    const aliasMap = buildAliasMap([{ name: '角色甲', name_en: 'Abu' }])
    assert.equal(extractScreenSides('@Abu at frame left', ['角色甲'], aliasMap).get('角色甲'), 'left')
  })

  test('buildAliasMap 合并 name_en 与 aliases，无别名的角色不入表', () => {
    const map = buildAliasMap([
      { name: '角色甲', name_en: 'Abu,ABU', aliases: '小布' },
      { name: '角色乙' },
    ])
    assert.deepEqual(map.get('角色甲'), ['Abu', 'ABU', '小布'])
    assert.equal(map.has('角色乙'), false)
  })
})

describe('画风毒词 findStylePoison', () => {
  test('检出中英文风格切换词', () => {
    assert.deepEqual(findStylePoison(['画面很写实']), ['写实'])
    assert.deepEqual(findStylePoison(['a photoreal look']), ['photoreal'])
  })

  test('否定语境（无/非/禁止…）不算毒词', () => {
    assert.deepEqual(findStylePoison(['无写实风格']), [])
    assert.deepEqual(findStylePoison(['no photoreal rendering']), [])
  })

  test('项目画风本身包含该词时不重复告警', () => {
    assert.deepEqual(findStylePoison(['写实CGI 风格'], '写实CGI风格'), [])
  })

  test('无文本时返回空', () => {
    assert.deepEqual(findStylePoison([]), [])
    assert.deepEqual(findStylePoison(['', null]), [])
  })
})

describe('场次索引对齐 checkSceneIndexAlignment', () => {
  test('数量一致时不提示', () => {
    assert.deepEqual(checkSceneIndexAlignment([1, 2, 3], [{ scene_number: 1 }, { scene_number: 2 }, { scene_number: 3 }]), [])
  })

  test('数量不一致时给出「提示非缺陷」的说明', () => {
    const out = checkSceneIndexAlignment([1, 2], [{ scene_number: 1 }, { scene_number: 2 }, { scene_number: 3 }])
    assert.equal(out.length, 1)
    assert.match(out[0], /分镜 2 场/)
    assert.match(out[0], /场景资产 3 个/)
    assert.match(out[0], /提示不是缺陷/)
  })
})

describe('rowToShotForQc', () => {
  test('把数据库 snake_case 行映射为校验用的 camelCase 镜头', () => {
    const shot = rowToShotForQc({
      id: 7,
      shot_number: '3',
      shot_type: '特写',
      camera_angle: '正面',
      camera_movement: '固定',
      duration: 6,
      description: '角色甲奔跑',
      characters: '["角色甲"]',
      scene_assets: '["场景甲"]',
      prop_assets: '[]',
      start_time: 10,
      end_time: 16,
      action_note: '注意节奏',
      dialogue: '{"character":"角色甲","text":"快跑","startTime":11}',
      integrated_multimodal_description: 'prompt',
      final_frame: 'frame',
      non_diegetic_music: '鼓点',
      blocking_plan: null,
      video_prompt_override: '',
      is_combat: 0,
    })

    assert.equal(shot.id, 7)
    assert.equal(shot.shotNumber, '3')
    assert.equal(shot.shotType, '特写')
    assert.equal(shot.cameraAngle, '正面')
    assert.deepEqual(shot.characters, ['角色甲'])
    assert.deepEqual(shot.sceneAssets, ['场景甲'])
    assert.deepEqual(shot.propAssets, [])
    assert.equal(shot.startTime, 10)
    assert.equal(shot.endTime, 16)
    assert.deepEqual(shot.dialogue, { character: '角色甲', text: '快跑', startTime: 11 })
    assert.equal(shot.blockingPlan, null)
  })

  test('字段缺失或 JSON 非法时回落默认值而不抛异常', () => {
    const shot = rowToShotForQc({ characters: '{坏 JSON', dialogue: 'not json', scene_assets: '[]' })
    assert.deepEqual(shot.characters, [])
    assert.equal(shot.dialogue, null)
    assert.equal(shot.shotNumber, '')
  })
})

describe('validateShot', () => {
  test('合规律的镜头不报错也不告警', () => {
    const r = validateShot(makeShot())
    assert.deepEqual(r.errors, [])
    assert.deepEqual(codes(r.warnings), [])
  })

  test('缺少 finalFrame / integratedMultimodalDescription 直接判错', () => {
    const r = validateShot({ duration: 5, startTime: 0, endTime: 5 })
    assert.equal(r.errors.length, 2)
    assert.match(r.errors[0], /finalFrame 字段为空/)
    assert.match(r.errors[1], /integratedMultimodalDescription 字段为空/)
  })

  test('duration 缺失或非数字判错', () => {
    const r = validateShot(makeShot({ duration: undefined }))
    assert.ok(r.errors.some((e) => /duration 缺失或非数字/.test(e)))
  })

  test('duration 超出 4-15s 区间给出 DURATION_OUT_OF_RANGE 警告', () => {
    const r = validateShot(makeShot({ duration: 20, endTime: 20 }))
    assert.ok(codes(r.warnings).includes('DURATION_OUT_OF_RANGE'))
  })

  test('台词落在 Airlock 禁语期内判错并带 QC 码', () => {
    const r = validateShot(makeShot({ dialogue: { character: '角色甲', text: '快跑啊', startTime: 1 } }))
    assert.ok(r.errors.some((e) => /Airlock 禁语期/.test(e)))
    assert.ok(r.codedErrors.some((c) => c.code === 'DIALOGUE_IN_AIRLOCK'))
  })

  test('台词移到 Airlock 之后即放行', () => {
    const r = validateShot(makeShot({ dialogue: { character: '角色甲', text: '快跑啊', startTime: 3 } }))
    assert.deepEqual(r.errors, [])
    assert.ok(!r.codedErrors.some((c) => c.code === 'DIALOGUE_IN_AIRLOCK'))
  })

  test('台词时间戳超出本镜范围给出 DIALOGUE_TIME_OUT_OF_RANGE', () => {
    const r = validateShot(makeShot({ dialogue: { character: '角色甲', text: '快跑啊', startTime: 99 } }))
    assert.ok(codes(r.warnings).includes('DIALOGUE_TIME_OUT_OF_RANGE'))
  })

  test('画风毒词判错并带 STYLE_POISON 码', () => {
    const r = validateShot(makeShot({ description: '写实CGI 风格的画面' }))
    assert.ok(r.errors.some((e) => /风格切换毒词/.test(e)))
    assert.ok(r.codedErrors.some((c) => c.code === 'STYLE_POISON'))
  })

  test('出片提示词源字段总长超出 H3 上限判错（PROMPT_OVER_LIMIT）', () => {
    const r = validateShot(makeShot({ description: '描'.repeat(8000) }))
    assert.ok(r.codedErrors.some((c) => c.code === 'PROMPT_OVER_LIMIT'))
  })

  test('配乐出现抽象情绪词给出 MUSIC_MOOD_WORD', () => {
    const r = validateShot(makeShot({ nonDiegeticMusic: '紧张急促的鼓点' }))
    assert.ok(codes(r.warnings).includes('MUSIC_MOOD_WORD'))
  })

  test('assetNames 存在时，@提及但漏登记的角色被程序化补齐', () => {
    const r = validateShot(makeShot({ characters: [] }), {
      assetNames: { characters: ['角色甲'], scenes: [], props: [] },
    })
    assert.equal(r.fixed.length, 1)
    assert.match(r.fixed[0], /characters 已程序化补齐/)
    assert.match(r.fixed[0], /角色甲/)
  })

  test('登记的资产在文本中毫无提及，给出 CHAR_OVER_REGISTERED', () => {
    const r = validateShot(
      makeShot({
        characters: ['角色甲', '角色乙'],
        description: '场景甲全景',
        integratedMultimodalDescription: PROMPT.replace(/@角色甲/g, '他'),
        finalFrame: 'snow field at frame left, warm golden light from frame left',
      }),
      { assetNames: { characters: ['角色甲', '角色乙'], scenes: [], props: [] } },
    )
    assert.ok(codes(r.warnings).includes('CHAR_OVER_REGISTERED'))
  })
})

describe('validateStoryboard 聚合', () => {
  test('场次内景别单一平推给出 SCENE_SHOTTYPE_FLAT', () => {
    const board = {
      scenes: [{
        sceneNumber: 1,
        title: '场景甲',
        shots: [1, 2, 3].map((n) => makeShot({
          shotNumber: `S${n}`,
          startTime: (n - 1) * 8,
          endTime: n * 8,
          shotType: '全景',
          cameraAngle: n % 2 ? '正面' : '侧面',
          cameraMovement: n % 2 ? '固定' : '推近',
        })),
      }],
    }
    const r = validateStoryboard(board, null)

    assert.equal(r.summary.shotCount, 3)
    assert.ok(codes(r.warnings).includes('SCENE_SHOTTYPE_FLAT'))
  })

  test('时间轴断裂（startTime 不接上一镜 endTime）给出 TIMELINE_DISCONTINUITY', () => {
    const board = {
      scenes: [{
        sceneNumber: 1,
        title: '场景甲',
        shots: [
          makeShot({ shotNumber: 'S1', startTime: 0, endTime: 8 }),
          makeShot({ shotNumber: 'S2', startTime: 9, endTime: 15, duration: 6 }),
        ],
      }],
    }
    const r = validateStoryboard(board, null)
    const issues = r.warnings.filter((w) => w.code === 'TIMELINE_DISCONTINUITY')

    assert.ok(issues.length >= 1)
    assert.ok(issues.some((w) => /startTime=9/.test(w.message)))
  })

  test('summary 汇总镜头数并统计错误/警告数量', () => {
    const board = {
      scenes: [{
        sceneNumber: 1,
        title: '场景甲',
        shots: [makeShot({ shotNumber: 'S1' }), makeShot({ shotNumber: 'S2', startTime: 8, endTime: 16 })],
      }],
    }
    const r = validateStoryboard(board, null)

    assert.equal(r.summary.shotCount, 2)
    assert.equal(r.summary.errorCount, r.errors.length)
    assert.equal(r.summary.warningCount, r.warnings.length)
  })

  test('所有告警都带 level（由 QC 码表补齐），便于分级展示', () => {
    const board = {
      scenes: [{
        sceneNumber: 1,
        title: '场景甲',
        shots: [makeShot({ duration: 20, endTime: 20 })],
      }],
    }
    const r = validateStoryboard(board, null)

    assert.ok(r.warnings.length > 0)
    for (const w of r.warnings) assert.ok(w.level, `告警 ${w.code} 缺少 level`)
  })
})

describe('suggestUnregisteredProps', () => {
  test('反复出现的未登记道具会被建议补建资产', () => {
    const shot = makeShot({
      description: '@角色甲 举起灯笼 照亮前路',
      integratedMultimodalDescription: `${PROMPT} @角色甲 raises 灯笼 high.`,
      propAssets: [],
    })
    const board = { scenes: [{ sceneNumber: 1, shots: [shot, shot, shot] }] }
    const sug = suggestUnregisteredProps(board, { characters: ['角色甲'], scenes: [], props: [] })

    assert.ok(sug.some((s) => s.name === '灯笼'))
    assert.equal(sug.find((s) => s.name === '灯笼').shotCount, 3)
  })

  test('已登记的道具不再重复建议', () => {
    const shot = makeShot({
      description: '@角色甲 举起灯笼 照亮前路',
      integratedMultimodalDescription: `${PROMPT} @角色甲 raises 灯笼 high.`,
      propAssets: ['灯笼'],
    })
    const board = { scenes: [{ sceneNumber: 1, shots: [shot, shot, shot] }] }
    const sug = suggestUnregisteredProps(board, { characters: ['角色甲'], scenes: [], props: ['灯笼'] })

    assert.ok(!sug.some((s) => s.name === '灯笼'))
  })
})
