// 分组锁展示层逻辑 —— 独立验证（2026-09-17）
//
// 被测对象：src/utils/groupLockView.js（纯函数，零 Vue / 零网络 / 零 AI 费用）
// 打的薄弱处：
//   1. isGroupLocked 的"全锁才算锁"语义（有交集的假安全感必须被判为未锁）
//   2. matchOrphanAnchor 的**排他性** —— 同一批场次不许被两张卡同时认领（实测踩过）
//   3. 已有锚的组不承接孤儿锚（假告警）
//   4. 类型宽容：后端给 number、前端 memberScenes 给 string，必须都认
//   5. 脏数据 / 空数组 / 缺字段一律不抛异常（降级铁律）
//
// 幂等、只读、可重复运行：node server/tests/groupLockView.test.mjs

import {
  countLocksByGroup,
  countOrphanAnchors,
  isGroupLocked,
  isSceneLocked,
  matchOrphanAnchor,
} from '../../src/utils/groupLockView.js'

const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ::  ${detail}` : ''}\n`)
}
function t(name, fn) {
  try {
    fn()
  } catch (e) {
    record(name, false, `EXCEPTION ${e && e.message}`)
  }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ── 1. countLocksByGroup ────────────────────────────────────────────────────
t('countLocksByGroup', () => {
  const m = countLocksByGroup([
    { group: 'cliff_river' }, { group: 'cliff_river' }, { group: 'forest_edge' },
  ])
  record('按组名正确计数', eq(m, { cliff_river: 2, forest_edge: 1 }), JSON.stringify(m))
  record('空/非数组入参返回空对象', eq(countLocksByGroup(null), {}) && eq(countLocksByGroup([]), {}))
  record('组名空白项被忽略', eq(countLocksByGroup([{ group: '  ' }, { group: '' }, { group: null }]), {}))
  // 组名当不透明字符串：首尾空格必须 trim 后归并（后端可能带空格）
  record('组名 trim 后归并', eq(countLocksByGroup([{ group: ' a ' }, { group: 'a' }]), { a: 2 }))
})

// ── 2. isSceneLocked ────────────────────────────────────────────────────────
t('isSceneLocked', () => {
  const locks = [{ sceneId: 126 }, { sceneId: 127 }]
  record('命中 number', isSceneLocked(126, locks) === true)
  record('命中 string（前端 memberScenes 是字符串 id）', isSceneLocked('126', locks) === true)
  record('未命中', isSceneLocked(999, locks) === false)
  record('空锁表恒 false', isSceneLocked(126, []) === false && isSceneLocked(126, null) === false)
  record('不误配前缀相同的 id', isSceneLocked('12', [{ sceneId: 126 }]) === false)
})

// ── 3. isGroupLocked：全锁才算锁（核心语义）────────────────────────────────
t('isGroupLocked', () => {
  const group = { group: 'cliff_river', memberScenes: [{ id: 126 }, { id: 127 }, { id: 128 }] }

  record(
    '成员全锁 → true',
    isGroupLocked(group, [{ sceneId: 126 }, { sceneId: 127 }, { sceneId: 128 }]) === true,
  )
  // 关键：只锁了一部分绝不算已锁。只要还有一场没锁，LLM 就能把它挪走，
  // 标成"已锁定"会给用户假安全感（比不显示更糟）。
  record(
    '只锁一部分 → false（不给假安全感）',
    isGroupLocked(group, [{ sceneId: 126 }, { sceneId: 127 }]) === false,
  )
  record('一条没锁 → false', isGroupLocked(group, []) === false)
  // 成员的 id 为字符串（前端实际形态）也必须认
  record(
    '成员 id 为字符串 → 仍能判定',
    isGroupLocked({ memberScenes: [{ id: '126' }, { id: '127' }] }, [{ sceneId: 126 }, { sceneId: 127 }]) === true,
  )
  record('空成员组 → false（无"分组"可锁）', isGroupLocked({ memberScenes: [] }, [{ sceneId: 1 }]) === false)
  record('缺 memberScenes → false 且不抛', isGroupLocked({}, [{ sceneId: 1 }]) === false)
  record('group 为 null → false 且不抛', isGroupLocked(null, [{ sceneId: 1 }]) === false)
  // 锁表里有不属于本组的场，不影响本组判定
  record(
    '锁表含他组场次不干扰',
    isGroupLocked(group, [{ sceneId: 126 }, { sceneId: 127 }, { sceneId: 128 }, { sceneId: 999 }]) === true,
  )
})

// ── 4. matchOrphanAnchor：证据 1（组名相等）────────────────────────────────
t('matchOrphanAnchor · 组名相等', () => {
  const overview = {
    locks: [{ sceneId: 1, group: 'old_group' }],
    orphanAnchors: [{ group: 'old_group', image: '/uploads/a.png', confirmed: true }],
  }
  const direct = matchOrphanAnchor({ group: 'old_group', memberScenes: [{ id: 1 }] }, overview)
  record('组名相等 → 直接命中（不靠推测）', direct && direct.group === 'old_group')
  record('返回值原样透传 image/confirmed', direct.image === '/uploads/a.png' && direct.confirmed === true)

  // 其他卡不该拿到这个锚
  const other = matchOrphanAnchor(
    { group: 'forest_edge', memberScenes: [{ id: 5 }] },
    overview,
  )
  record('无关的组拿不到这个锚', other === null, JSON.stringify(other))
})

// ── 5. matchOrphanAnchor：排他性（本轮踩过的坑）──────────────────────────────
t('matchOrphanAnchor · 排他性（漂移改名场景）', () => {
  // 真实复现场景（ep4）：漂移把 sn4-7 合并成 forest_lakeside，旧锚 forest_high_rock 变孤儿。
  // 此时卡片是 forest_lakeside（含 sn4,5,6,7），锁里既记着 forest_edge(sn4) /
  // forest_valley(sn5) / forest_high_rock(sn6,7) —— 一张卡、三个旧组名。
  // 用"有交集"判定会让 forest_edge 与 forest_valley 两个旧名都命中这张卡（一个孤儿喂多次）。
  // 正确行为：孤儿的锁记录是 sn6,7，而本卡成员是 sn4,5,6,7 —— sn4/sn5 不在该锚的锁记录里，
  // 但这不影响归属判断：判据是"该锚锁的场**全部**在本卡内"（sn6,7 ⊂ sn4,5,6,7 → 成立）。
  const overview = {
    locks: [
      { sceneId: 129, group: 'forest_edge' },
      { sceneId: 130, group: 'forest_valley' },
      { sceneId: 131, group: 'forest_high_rock' },
      { sceneId: 132, group: 'forest_high_rock' },
    ],
    orphanAnchors: [{ group: 'forest_high_rock', image: '/uploads/x.png', confirmed: true }],
  }
  const drifted = { group: 'forest_lakeside', memberScenes: [{ id: 129 }, { id: 130 }, { id: 131 }, { id: 132 }] }
  const hit = matchOrphanAnchor(drifted, overview)
  record('漂移改名后仍能挂回原卡（靠锁记录的场次归属）', hit && hit.group === 'forest_high_rock')
})

t('matchOrphanAnchor · 排他性（必须全落在本卡内）', () => {
  // 该锚的锁覆盖 sn6,7，但本卡只有 sn6 —— 说明本卡不是该锚的家（可能是又分裂了）。
  // 宁可漏挂也不误挂：挂错卡会让用户到错误的组上去"修基准"。
  const overview = {
    locks: [{ sceneId: 131, group: 'g' }, { sceneId: 132, group: 'g' }],
    orphanAnchors: [{ group: 'g', confirmed: true }],
  }
  const partial = matchOrphanAnchor({ group: 'new_name', memberScenes: [{ id: 131 }] }, overview)
  record('锚的锁记录有场次不在本卡 → null（宁可漏挂不误挂）', partial === null, JSON.stringify(partial))
})

t('matchOrphanAnchor · 已有锚的组不承接孤儿锚', () => {
  // 本卡组名自己就在孤儿列表里 → 直接命中（证据 1 已覆盖）。
  // 这里的用例打的是另一条：本卡组名**不在**孤儿列表，但锚列表里有同名字段残留时，
  // 也不该把别人的孤儿贴过来。
  const overview = {
    locks: [{ sceneId: 1, group: 'a' }, { sceneId: 2, group: 'b' }],
    orphanAnchors: [
      { group: 'a', confirmed: true },
      { group: 'b', confirmed: true },
    ],
  }
  // a 卡命中自己的 a 锚，绝不串到 b
  const cardA = matchOrphanAnchor({ group: 'a', memberScenes: [{ id: 1 }] }, overview)
  record('a 卡命中 a 锚（不串到 b）', cardA && cardA.group === 'a', JSON.stringify(cardA))
  const cardB = matchOrphanAnchor({ group: 'b', memberScenes: [{ id: 2 }] }, overview)
  record('b 卡命中 b 锚（不串到 a）', cardB && cardB.group === 'b', JSON.stringify(cardB))
})

t('matchOrphanAnchor · 降级与脏数据', () => {
  record('无孤儿 → null', matchOrphanAnchor({ group: 'x', memberScenes: [{ id: 1 }] }, { orphanAnchors: [] }) === null)
  record('overview 为 null → null 且不抛', matchOrphanAnchor({ group: 'x' }, null) === null)
  record('孤儿项缺 group → 被过滤，不产生匹配', matchOrphanAnchor(
    { group: 'x', memberScenes: [{ id: 1 }] },
    { locks: [{ sceneId: 1, group: '' }], orphanAnchors: [{ group: '' }] },
  ) === null)
  record('空成员组不硬接孤儿锚', matchOrphanAnchor(
    { group: 'y', memberScenes: [] },
    { locks: [], orphanAnchors: [{ group: 'old' }] },
  ) === null)
  record('无锁记录时不做推测（返回 null）', matchOrphanAnchor(
    { group: 'newname', memberScenes: [{ id: 9 }] },
    { locks: [], orphanAnchors: [{ group: 'oldname' }] },
  ) === null)
})

// ── 6. countOrphanAnchors ───────────────────────────────────────────────────
t('countOrphanAnchors', () => {
  record('按组名去重计数', countOrphanAnchors({
    orphanAnchors: [{ group: 'a' }, { group: 'a' }, { group: 'b' }],
  }) === 2)
  record('空 → 0', countOrphanAnchors({ orphanAnchors: [] }) === 0 && countOrphanAnchors(null) === 0)
  record('空白组名不计入', countOrphanAnchors({ orphanAnchors: [{ group: '  ' }, { group: 'a' }] }) === 1)
})

// ── 7. 通用性护栏：本模块不得出现任何具体题材/组名硬编码 ────────────────────
async function tAsync(name, fn) {
  try {
    await fn()
  } catch (e) {
    record(name, false, `EXCEPTION ${e && e.message}`)
  }
}
await tAsync('通用性护栏（零词表）', async () => {
  const fs = await import('fs')
  const src = fs.readFileSync(new URL('../../src/utils/groupLockView.js', import.meta.url), 'utf8')
  // 去掉注释后再扫：注释里可以举例说明（forest_edge 等），代码里不许有
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const forbidden = ['cliff_river', 'forest_edge', 'forest_valley', 'forest_high_rock', 'snow_mountain_icefield']
  const hits = forbidden.filter((w) => code.includes(w))
  record('代码区零具体组名', hits.length === 0, hits.join(','))
  record('代码区零正则字面量（语义判断不在前端）', !/\.(test|match|exec|replace)\(\s*\//.test(code))
})

// ── 8. 接线护栏：前端真的把锁接上了（防"写了 handler 忘了绑模板"）───────────
// 这类 bug 静态看不出来、点一下才发现，而单测跑不到 Vue 模板 —— 所以扫源码断言连线存在。
await tAsync('前端接线护栏', async () => {
  const fs = await import('fs')
  const view = fs.readFileSync(new URL('../../src/views/SettingsView.vue', import.meta.url), 'utf8')
  const card = fs.readFileSync(new URL('../../src/components/SpatialGroupCard.vue', import.meta.url), 'utf8')
  const api = fs.readFileSync(new URL('../../src/services/api.js', import.meta.url), 'utf8')

  // SettingsView → 卡片：三个绑定一个都不能少
  record('卡片绑定了 :locked', /:locked="[^"]*isGroupLocked/.test(view))
  record('卡片绑定了 :orphan-anchor', /:orphan-anchor="[^"]*orphanAnchorForGroup/.test(view))
  record('卡片绑定了 @toggle-lock', /@toggle-lock="[^"]*toggleGroupLock/.test(view))
  record('换集时清空锁概览（防串集）', /locksOverview\.value = \{ locks: \[\], orphanAnchors: \[\],?[^}]*\}/.test(view))

  // 卡片自身：props + emit 都要在
  record('卡片声明了 locked prop', /locked:\s*\{\s*type:\s*Boolean/.test(card))
  record('卡片声明了 orphanAnchor prop', /orphanAnchor:\s*\{\s*type:\s*Object/.test(card))
  record('卡片 emit 里有 toggle-lock', /defineEmits\(\[[^\]]*'toggle-lock'[^\]]*\]\)/.test(card))

  // api 层三个方法齐备
  record('api 有 getGroupLocks', /getGroupLocks:/.test(api))
  record('api 有 lockGrouping', /lockGrouping:/.test(api))
  record('api 有 unlockGrouping', /unlockGrouping:/.test(api))
  // 端点路径必须与后端契约一致（写错路径只在运行时炸）
  record('api 路径与后端一致', /\/generate\/scene-groups\/locks/.test(api))

  // SettingsView 不得再自留一份判定逻辑（重复实现 = 迟早与 utils 版漂移）
  record('SettingsView 未重复实现判定（已下沉 utils）', !/function isGroupLocked\(group\)\s*\{\s*const members/.test(view))
})

const failed = results.filter((r) => !r.ok)
process.stdout.write(`\n==== groupLockView: ${results.length - failed.length}/${results.length} passed ====\n`)
if (failed.length) {
  process.stdout.write(`FAILED:\n${failed.map((f) => `  - ${f.name}`).join('\n')}\n`)
  process.exit(1)
}
