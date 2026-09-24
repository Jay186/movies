import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  FIELD_DEFS,
  normKey,
  matchSemanticKey,
  parseDuration,
  splitNames,
  parseDialogue,
  extractTagged,
  parseStoryboard,
  parseStoryboardRows,
  rebuildFromTable,
  mergeShortShots,
  mergeShotsByScene,
} from '../storyboardImport.js'

describe('列名归一化 normKey', () => {
  test('去掉括号内的补充说明', () => {
    assert.equal(normKey('时长(秒)'), '时长')
    assert.equal(normKey('画面描述（AI 用）'), '画面描述')
  })

  test('统一小写并剥离空格/下划线/连字符等分隔符', () => {
    assert.equal(normKey('Shot_No'), 'shotno')
    assert.equal(normKey(' 画面 描述 '), '画面描述')
    assert.equal(normKey('Final-Frame'), 'finalframe')
  })
})

describe('语义列识别 matchSemanticKey', () => {
  test('常见表头映射到对应字段', () => {
    assert.equal(matchSemanticKey('镜号'), 'shotNo')
    assert.equal(matchSemanticKey('画面描述'), 'description')
    assert.equal(matchSemanticKey('时长(秒)'), 'duration')
    assert.equal(matchSemanticKey('台词'), 'dialogue')
    assert.equal(matchSemanticKey('镜头类型'), 'shotType')
    assert.equal(matchSemanticKey('AI 视频提示词'), 'integrated')
    assert.equal(matchSemanticKey('最终画面'), 'finalFrame')
    assert.equal(matchSemanticKey('演员调度'), 'actionNote')
  })

  test('起止时间列不参与字段映射（避免被当成时长/镜号）', () => {
    for (const k of ['开始时间', '结束时间', 'startTime', 'endTime', '入点', '出点']) {
      assert.equal(matchSemanticKey(k), null, `${k} 不应映射`)
    }
  })

  test('无法识别的列返回 null', () => {
    assert.equal(matchSemanticKey('完全陌生的列'), null)
    assert.equal(matchSemanticKey(''), null)
  })

  test('FIELD_DEFS 的 key 唯一（防止重复字段互相抢占列）', () => {
    const keys = FIELD_DEFS.map((d) => d.key)
    assert.equal(new Set(keys).size, keys.length)
  })
})

describe('时长解析 parseDuration', () => {
  test('数字与带单位的写法', () => {
    assert.equal(parseDuration(5), 5)
    assert.equal(parseDuration('5'), 5)
    assert.equal(parseDuration('2.5'), 2.5)
    assert.equal(parseDuration('5秒'), 5)
    assert.equal(parseDuration('1分30秒'), 90)
  })

  test('区间写法取两端差值', () => {
    assert.equal(parseDuration('3-8秒'), 5)
    assert.equal(parseDuration('6~9s'), 3)
  })

  test('无法解析时返回 0，不抛异常', () => {
    assert.equal(parseDuration('abc'), 0)
    assert.equal(parseDuration(''), 0)
    assert.equal(parseDuration(null), 0)
  })

  test('时间轴区间（mm:ss-mm:ss / hh:mm:ss-hh:mm:ss）应解析为秒差', () => {
    assert.equal(parseDuration('00:10-00:18'), 8)
    assert.equal(parseDuration('01:00:00-01:01:30'), 90)
    assert.equal(parseDuration('00:00:05-00:00:12'), 7)
  })
})

describe('名单与台词拆分', () => {
  test('splitNames 支持中英文顿号/逗号/斜杠分隔', () => {
    assert.deepEqual(splitNames('角色甲、角色乙'), ['角色甲', '角色乙'])
    assert.deepEqual(splitNames('角色甲, 角色乙'), ['角色甲', '角色乙'])
    assert.deepEqual(splitNames('角色甲/角色乙'), ['角色甲', '角色乙'])
    assert.deepEqual(splitNames('角色甲'), ['角色甲'])
    assert.deepEqual(splitNames(''), [])
  })

  test('parseDialogue 解析「角色：文本」字符串', () => {
    assert.deepEqual(parseDialogue('角色甲：快跑'), {
      character: '角色甲', tone: '', text: '快跑', startTime: 0,
    })
  })

  test('parseDialogue 规范化对象写法并补全缺失字段', () => {
    assert.deepEqual(parseDialogue({ character: '角色甲', text: '快跑', startTime: 3 }), {
      character: '角色甲', tone: '', text: '快跑', startTime: 3,
    })
  })

  test('parseDialogue 遇数组取首句并标记剩余句数', () => {
    const d = parseDialogue([{ character: '角色甲', text: 'a' }, { character: '角色乙', text: 'b' }])
    assert.equal(d.text, 'a')
    assert.equal(d._extra, 1)
  })

  test('parseDialogue 空值返回 null', () => {
    assert.equal(parseDialogue(''), null)
    assert.equal(parseDialogue(null), null)
  })

  test('extractTagged 抽取 @提及并去重', () => {
    assert.deepEqual(extractTagged('@角色甲 和 @角色乙 和 @角色甲'), ['角色甲', '角色乙'])
    assert.deepEqual(extractTagged('没有提及'), [])
  })
})

describe('parseStoryboard 入口分发', () => {
  test('空内容返回 empty 结构并给出警告', () => {
    const r = parseStoryboard('')
    assert.equal(r.format, 'empty')
    assert.equal(r.stats.shotCount, 0)
    assert.equal(r.stats.totalDuration, 0)
    assert.deepEqual(r.warnings, ['内容为空'])
  })

  test('竖线表格：识别列映射、镜头数与总时长', () => {
    const r = parseStoryboard([
      '| 镜号 | 画面描述 | 时长(秒) |',
      '| 1 | 角色甲在雪地里奔跑 | 5 |',
      '| 2 | 角色乙从树后探出头 | 6 |',
    ].join('\n'))

    assert.equal(r.format, 'table')
    assert.equal(r.table.hasHeader, true)
    assert.deepEqual(r.table.mapping, { shotNo: 0, description: 1, duration: 2 })
    assert.equal(r.table.confidence.description, 'high')
    assert.equal(r.stats.shotCount, 2)
    assert.equal(r.stats.totalDuration, 11)
  })

  test('表格：时间轴首尾相接且不重叠', () => {
    const r = parseStoryboard([
      '| 镜号 | 画面描述 | 时长(秒) |',
      '| 1 | 角色甲在雪地里奔跑 | 5 |',
      '| 2 | 角色乙从树后探出头 | 6 |',
    ].join('\n'))
    const [s1, s2] = r.scenes[0].shots

    assert.equal(s1.startTime, 0)
    assert.equal(s1.endTime, 5)
    assert.equal(s2.startTime, s1.endTime)
    assert.equal(s2.endTime, 11)
    assert.equal(s2.duration, 6)
  })

  test('JSON 扁平数组识别为 flat 结构', () => {
    const r = parseStoryboard(JSON.stringify([
      { description: '角色甲奔跑', duration: 5 },
      { description: '角色乙探头', duration: 6 },
    ]))
    assert.equal(r.format, 'json')
    assert.equal(r.structure, 'flat')
    assert.equal(r.stats.shotCount, 2)
    assert.equal(r.stats.totalDuration, 11)
  })

  test('JSON 嵌套（场次含 shots）识别为 nested 并保留场次标题', () => {
    const r = parseStoryboard(JSON.stringify({
      scenes: [
        { title: '地点甲', shots: [{ description: '角色甲奔跑', duration: 5 }] },
        { title: '地点乙', shots: [{ description: '角色乙探头', duration: 6 }] },
      ],
    }))
    assert.equal(r.format, 'json')
    assert.equal(r.structure, 'nested')
    assert.equal(r.stats.sceneCount, 2)
    assert.deepEqual(r.scenes.map((s) => s.title), ['地点甲', '地点乙'])
  })

  test('自由文本：按「镜头N」切镜并解析行内时长', () => {
    const r = parseStoryboard([
      '镜头1：角色甲在雪地里奔跑 时长5秒',
      '镜头2：角色乙从树后探出头 时长6秒',
    ].join('\n'))

    assert.equal(r.format, 'text')
    assert.equal(r.stats.shotCount, 2)
    assert.equal(r.stats.totalDuration, 11)
    assert.deepEqual(r.scenes[0].shots.map((s) => s.description), [
      '角色甲在雪地里奔跑', '角色乙从树后探出头',
    ])
  })

  test('自由文本：按「场次」分组，跨场次时间轴连续', () => {
    const r = parseStoryboard([
      '场次1 地点甲',
      '镜头1：角色甲奔跑 时长5秒',
      '镜头2：角色乙探头 时长6秒',
      '',
      '场次2 地点乙',
      '镜头3：两人汇合 时长7秒',
    ].join('\n'))

    assert.equal(r.format, 'text')
    assert.equal(r.stats.sceneCount, 2)
    assert.deepEqual(r.scenes.map((s) => s.title), ['地点甲', '地点乙'])
    assert.deepEqual(r.scenes[0].shots.map((s) => [s.startTime, s.endTime]), [[0, 5], [5, 11]])
    assert.deepEqual(r.scenes[1].shots.map((s) => [s.startTime, s.endTime]), [[11, 18]])
  })

  test('自由文本含全角逗号：不应被误判为表格', () => {
    const r = parseStoryboard([
      '镜头1：角色甲在雪地里奔跑，雪浪卷起',
      '镜头2：角色乙追上来，焦急大喊',
    ].join('\n'))

    assert.equal(r.format, 'text')
    assert.equal(r.stats.shotCount, 2)
    assert.deepEqual(r.scenes[0].shots.map((s) => s.description), [
      '角色甲在雪地里奔跑，雪浪卷起', '角色乙追上来，焦急大喊',
    ])
  })
})

describe('parseStoryboardRows / rebuildFromTable', () => {
  const rows = [
    ['镜号', '画面描述', '时长'],
    ['1', '角色甲奔跑', '5'],
    ['2', '角色乙探头', '6'],
  ]

  test('parseStoryboardRows 自动识别表头并汇总', () => {
    const r = parseStoryboardRows(rows)
    assert.equal(r.format, 'table')
    assert.equal(r.stats.shotCount, 2)
    assert.equal(r.stats.totalDuration, 11)
    assert.equal(r.table.hasHeader, true)
  })

  test('rebuildFromTable 按用户指定的 mapping 重建（列序变化时结果一致）', () => {
    const swapped = rows.map((r) => [r[2], r[0], r[1]])
    const r = rebuildFromTable(swapped, { shotNo: 1, description: 2, duration: 0 }, { hasHeader: true })

    assert.equal(r.stats.shotCount, 2)
    assert.equal(r.stats.totalDuration, 11)
    assert.deepEqual(r.scenes[0].shots.map((s) => s.description), ['角色甲奔跑', '角色乙探头'])
  })

  test('空表返回 empty 并提示', () => {
    const r = parseStoryboardRows([])
    assert.equal(r.format, 'empty')
    assert.deepEqual(r.warnings, ['表格为空'])
  })
})

describe('时长兜底与资产挂接', () => {
  test('时长超过 120s 视为误填，回落到 5s 并告警', () => {
    const r = parseStoryboard([
      '| 镜号 | 画面描述 | 时长(秒) |',
      '| 1 | 角色甲奔跑 | 300 |',
      '| 2 | 角色乙探头 | 6 |',
    ].join('\n'))

    assert.equal(r.scenes[0].shots[0].duration, 5)
    assert.equal(r.stats.totalDuration, 11)
    assert.equal(r.warnings.length, 1)
    assert.match(r.warnings[0], /300s/)
  })

  test('描述中的 @提及按 knownAssets 归类到角色/道具', () => {
    const r = parseStoryboard(
      ['| 镜号 | 画面描述 | 时长(秒) |', '| 1 | @角色甲 拿起 @道具甲 | 5 |'].join('\n'),
      { knownAssets: { characters: ['角色甲'], scenes: ['地点甲'], props: ['道具甲'] } },
    )
    const shot = r.scenes[0].shots[0]

    assert.deepEqual(shot.characters, ['角色甲'])
    assert.deepEqual(shot.propAssets, ['道具甲'])
    assert.deepEqual(r.unknownAssets.props, [])
  })

  test('未登记的 @提及不静默丢失，落入 unknownAssets 供提示', () => {
    const r = parseStoryboard(
      ['| 镜号 | 画面描述 | 时长(秒) |', '| 1 | @角色甲 拿起 @神秘道具 | 5 |'].join('\n'),
      { knownAssets: { characters: ['角色甲'], scenes: ['地点甲'], props: ['道具甲'] } },
    )
    const shot = r.scenes[0].shots[0]

    assert.deepEqual(shot.characters, ['角色甲'])
    assert.deepEqual(shot.propAssets, [])
    assert.deepEqual(r.unknownAssets.props, ['神秘道具'])
  })
})

describe('镜头合并', () => {
  test('mergeShortShots：连续短镜合并到达到最小时长', () => {
    const out = mergeShortShots([{ title: 'A', shots: [{ duration: 1 }, { duration: 1 }, { duration: 1 }] }])
    assert.deepEqual(out[0].shots.map((s) => s.duration), [3])
  })

  test('mergeShortShots：孤立短镜并入上一镜而非单独成镜', () => {
    const out = mergeShortShots([{ title: 'A', shots: [{ duration: 5 }, { duration: 1 }] }])
    assert.deepEqual(out[0].shots.map((s) => s.duration), [6])
  })

  test('mergeShotsByScene：不超过上限时整场并为一镜并重排时间轴', () => {
    const out = mergeShotsByScene([{ title: 'A', shots: [{ duration: 3 }, { duration: 3 }, { duration: 3 }] }])
    assert.deepEqual(out[0].shots.map((s) => [s.duration, s.startTime, s.endTime]), [[9, 0, 9]])
  })

  test('mergeShotsByScene：超过 maxDuration 即切分，时间轴首尾相接', () => {
    const out = mergeShotsByScene([{ title: 'A', shots: [{ duration: 8 }, { duration: 8 }] }])
    assert.deepEqual(out[0].shots.map((s) => [s.duration, s.startTime, s.endTime]), [[8, 0, 8], [8, 8, 16]])
  })
})
