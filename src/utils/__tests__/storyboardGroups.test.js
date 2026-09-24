import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { buildSceneGroupChains } from '../sceneGroupSchedule.js'
import {
  isSceneLocked,
  isGroupLocked,
  matchOrphanAnchor,
  countOrphanAnchors,
} from '../groupLockView.js'

const scene = (id) => ({ id })

describe('buildSceneGroupChains', () => {
  test('没有分组信息时整批视为一条链', () => {
    const targets = [scene(1), scene(2)]
    assert.deepEqual(buildSceneGroupChains(targets, {}), [[targets[0], targets[1]]])
    assert.deepEqual(buildSceneGroupChains(targets, null), [[targets[0], targets[1]]])
  })

  test('空目标返回空数组', () => {
    assert.deepEqual(buildSceneGroupChains([], { 1: { group: 'A' } }), [])
    assert.deepEqual(buildSceneGroupChains(null, {}), [])
  })

  test('同一分组按 sceneNumber 升序，而非表格出现顺序', () => {
    // 表格顺序 1,2,3；sceneNumber 依次为 3,1,2 —— 期望链内顺序为 2,3,1
    const targets = [scene(1), scene(2), scene(3)]
    const groupInfo = {
      1: { group: 'A', sceneNumber: 3 },
      2: { group: 'A', sceneNumber: 1 },
      3: { group: 'A', sceneNumber: 2 },
    }
    const chains = buildSceneGroupChains(targets, groupInfo)

    assert.equal(chains.length, 1)
    assert.deepEqual(chains[0].map((s) => s.id), [2, 3, 1])
  })

  test('多个分组按各自首次出现的顺序排列，未分组场次单列其后', () => {
    const targets = [scene(1), scene(2), scene(3), scene(4)]
    const groupInfo = {
      1: { group: 'B', sceneNumber: 1 },
      2: { group: 'A', sceneNumber: 1 },
      3: { group: 'B', sceneNumber: 2 },
    }
    const chains = buildSceneGroupChains(targets, groupInfo)

    assert.deepEqual(chains.map((c) => c.map((s) => s.id)), [[1, 3], [2], [4]])
  })

  test('分组号支持数字或字符串 id 两种写法', () => {
    const targets = [scene(1), scene(2)]
    const byString = { 1: { group: 'A', sceneNumber: 1 }, 2: { group: 'A', sceneNumber: 2 } }
    const byNumber = { 1: { group: 'A', sceneNumber: 1 }, 2: { group: 'A', sceneNumber: 2 } }

    assert.deepEqual(
      buildSceneGroupChains(targets, byString)[0].map((s) => s.id),
      buildSceneGroupChains(targets, byNumber)[0].map((s) => s.id),
    )
  })

  test('parallel 模式：同组也各成单链（组内并行交给 worker 池）', () => {
    const targets = [scene(1), scene(2), scene(3), scene(4)]
    const groupInfo = {
      1: { group: 'A', sceneNumber: 1 },
      2: { group: 'A', sceneNumber: 2 },
      3: { group: 'B', sceneNumber: 1 },
    }
    const chains = buildSceneGroupChains(targets, groupInfo, { parallel: true })
    assert.deepEqual(chains.map((c) => c.map((s) => s.id)), [[1], [2], [3], [4]])
  })

  test('parallel 模式：无分组信息同样平铺单链', () => {
    const targets = [scene(1), scene(2)]
    assert.deepEqual(buildSceneGroupChains(targets, null, { parallel: true }), [[targets[0]], [targets[1]]])
  })

  test('不传 options 时保持旧的编链行为（同组一条链）', () => {
    const targets = [scene(1), scene(2)]
    const groupInfo = { 1: { group: 'A', sceneNumber: 1 }, 2: { group: 'A', sceneNumber: 2 } }
    assert.equal(buildSceneGroupChains(targets, groupInfo).length, 1)
  })
})

describe('分组锁定状态 isSceneLocked / isGroupLocked', () => {
  const locks = [{ sceneId: 1 }, { sceneId: 2 }]

  test('isSceneLocked 比较时兼容数字与字符串 id', () => {
    assert.equal(isSceneLocked(1, locks), true)
    assert.equal(isSceneLocked('1', locks), true)
    assert.equal(isSceneLocked(9, locks), false)
  })

  test('空锁列表不锁定任何场次', () => {
    assert.equal(isSceneLocked(1, null), false)
    assert.equal(isSceneLocked(1, []), false)
  })

  test('isGroupLocked 要求全部成员场次都已锁定', () => {
    assert.equal(isGroupLocked({ memberScenes: [{ id: 1 }, { id: 2 }] }, locks), true)
    assert.equal(isGroupLocked({ memberScenes: [{ id: 1 }, { id: 9 }] }, locks), false)
  })

  test('无成员或空锁列表的分组视为未锁定', () => {
    assert.equal(isGroupLocked({ memberScenes: [] }, locks), false)
    assert.equal(isGroupLocked({ memberScenes: [{ id: 1 }] }, []), false)
    assert.equal(isGroupLocked({}, locks), false)
  })
})

describe('孤儿锚点匹配 matchOrphanAnchor', () => {
  test('无孤儿锚点时返回 null', () => {
    assert.equal(matchOrphanAnchor({ group: 'A', memberScenes: [{ id: 1 }] }, {}), null)
    assert.equal(matchOrphanAnchor({ group: 'A', memberScenes: [{ id: 1 }] }, { orphanAnchors: [] }), null)
  })

  test('组名可直接命中时返回该锚点', () => {
    const anchor = { group: 'A', imageUrl: 'x.png' }
    const overview = { orphanAnchors: [anchor], locks: [] }
    assert.equal(matchOrphanAnchor({ group: 'A', memberScenes: [{ id: 1 }] }, overview), anchor)
  })

  test('组名不同但锁定成员完全一致时按成员 id 归位（分组改名场景）', () => {
    const anchor = { group: '旧组名' }
    const overview = {
      orphanAnchors: [anchor],
      locks: [
        { group: '旧组名', sceneId: '1' },
        { group: '旧组名', sceneId: '2' },
      ],
    }
    const group = { group: '新组名', memberScenes: [{ id: 1 }, { id: 2 }] }
    assert.equal(matchOrphanAnchor(group, overview), anchor)
  })

  test('成员只是部分重合时不认领', () => {
    const overview = {
      orphanAnchors: [{ group: '旧组名' }],
      locks: [
        { group: '旧组名', sceneId: '1' },
        { group: '旧组名', sceneId: '9' },
      ],
    }
    const group = { group: '新组名', memberScenes: [{ id: 1 }, { id: 2 }] }
    assert.equal(matchOrphanAnchor(group, overview), null)
  })

  test('分组无成员时无法归位', () => {
    const overview = { orphanAnchors: [{ group: '旧组名' }], locks: [{ group: '旧组名', sceneId: '1' }] }
    assert.equal(matchOrphanAnchor({ group: '新组名', memberScenes: [] }, overview), null)
  })
})

describe('countOrphanAnchors', () => {
  test('按组名去重统计，忽略空组名', () => {
    const overview = {
      orphanAnchors: [{ group: 'A' }, { group: 'A' }, { group: 'B' }, { group: '  ' }, {}],
    }
    assert.equal(countOrphanAnchors(overview), 2)
  })

  test('无数据时为 0', () => {
    assert.equal(countOrphanAnchors({}), 0)
    assert.equal(countOrphanAnchors({ orphanAnchors: [] }), 0)
  })
})
