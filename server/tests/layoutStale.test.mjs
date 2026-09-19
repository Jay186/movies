// 布局图时效提示 · 验收测试（2026-09-18）
//
// 解决什么问题：布局图用 source='manual'（重析不删，保护花钱生成的图），
//   代价是它会**悄悄过时** —— 场景描述改了，图上的空间关系可能已经对不上。
//   过时的布局图**比没有更糟**：组内场景会照着一张错的底图对齐空间，错误顺锚放大到整组。
//   以前这个状态完全静默，用户无从察觉。
//   本功能 = 锚上记"画它时的素材指纹"，status 接口与当前素材比对，前端显式提示。
//
// 测试重点（都是容易写错、且写错了不报错的地方）：
//   A. 指纹的稳定性语义 —— 顺序无关 / 增删敏感 / 去重 / 空值
//   B. 三档时效语义 —— true / false / null 各自何时出现（尤其 null 不能退化成 false）
//   C. 老库迁移 —— 补列不能崩（schema.sql 与 db.js 双轨）
//   D. 接线 —— 指纹真的被写入、真的被读取、真的被比对
//
// 只读、零网络、零 AI 费用。会**临时改写**真实库的锚指纹用于验证，末尾恢复。
// 可重复运行。

import fs from 'node:fs'
import { layoutMaterialsFingerprint } from '../ai/sceneAnchors.js'
import { createSpatialGroupReview } from '../ai/spatialGroupReview.js'

const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ::  ${detail}` : ''}\n`)
}
function t(name, fn) {
  try { fn() } catch (e) { record(name, false, `EXCEPTION ${e && e.message}`) }
}
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8')

// ── A. 指纹语义 ──────────────────────────────────────────────────────────────
t('A. 指纹：顺序无关', () => {
  const a = { roles: ['崖顶俯视谷底', '河面平视'], landmarks: ['断桥', '冰河'], env: ['雪线悬崖'] }
  const b = { roles: ['河面平视', '崖顶俯视谷底'], landmarks: ['冰河', '断桥'], env: ['雪线悬崖'] }
  record('成员顺序打乱 → 同指纹', layoutMaterialsFingerprint(a) === layoutMaterialsFingerprint(b))
})

t('A2. 指纹：内容敏感', () => {
  const base = { roles: ['崖顶俯视谷底'], landmarks: ['断桥', '冰河'], env: ['雪线悬崖'] }
  const addLandmark = { roles: ['崖顶俯视谷底'], landmarks: ['断桥', '冰河', '对岸森林'], env: ['雪线悬崖'] }
  const delLandmark = { roles: ['崖顶俯视谷底'], landmarks: ['断桥'], env: ['雪线悬崖'] }
  const addEnv = { roles: ['崖顶俯视谷底'], landmarks: ['断桥', '冰河'], env: ['雪线悬崖', '灰白砾石滩'] }
  const addRole = { roles: ['崖顶俯视谷底', '河面平视'], landmarks: ['断桥', '冰河'], env: ['雪线悬崖'] }
  const f = layoutMaterialsFingerprint
  record('加地标 → 指纹变', f(base) !== f(addLandmark))
  record('删地标 → 指纹变', f(base) !== f(delLandmark))
  record('加环境 → 指纹变', f(base) !== f(addEnv))
  record('加视角 → 指纹变', f(base) !== f(addRole))
  // 跨字段不可混淆：把 role 搬到 landmark 必须变（否则字段语义被抹平）
  const crossField = { roles: [], landmarks: ['崖顶俯视谷底', '断桥', '冰河'], env: ['雪线悬崖'] }
  record('跨字段搬移 → 指纹变', f(base) !== f(crossField))
})

t('A3. 指纹：去重与空值', () => {
  const a = { roles: ['甲', '乙'], landmarks: ['丙'], env: [] }
  const dup = { roles: ['甲', '乙', '甲'], landmarks: ['丙', '丙'], env: [] }
  record('重复项不影响指纹', layoutMaterialsFingerprint(a) === layoutMaterialsFingerprint(dup))
  record('null 输入 → 空串', layoutMaterialsFingerprint(null) === '')
  record('undefined 输入 → 空串', layoutMaterialsFingerprint(undefined) === '')
  record('三项全空 → 空串', layoutMaterialsFingerprint({ roles: [], landmarks: [], env: [] }) === '')
  record('只有空白项 → 空串', layoutMaterialsFingerprint({ roles: ['', '  '], landmarks: [], env: [] }) === '')
  record('空串 = 不可判断（调用方据此跳过）', layoutMaterialsFingerprint({ roles: [], landmarks: [], env: [] }) === '')
  // 前后空白应被 trim（否则 "断桥" 与 "断桥 " 会被当成两个不同素材）
  const spaced = { roles: [], landmarks: [' 断桥 '], env: [] }
  const tight = { roles: [], landmarks: ['断桥'], env: [] }
  record('前后空白被 trim', layoutMaterialsFingerprint(spaced) === layoutMaterialsFingerprint(tight))
  record('指纹是 md5 hex（32 位）', /^[0-9a-f]{32}$/.test(layoutMaterialsFingerprint(a)))
})

// ── B. 三档时效语义（纯逻辑，注入假实现，不碰真库）──────────────────────────
//
// ⚠️ 本组断言全是 async。踩过的坑：最初把 t() 写成"传 async 函数但不 await"，
//   结果断言确实跑了、FAIL 也确实打印了，但**收尾的汇总与 process.exit(1) 在它们
//   resolve 之前就执行完了** → 退出码恒为 0 → 脚本/CI 看到的是"通过"。
//   这正是"看起来绿了的假绿"。所以这里显式收集 Promise 并在收尾前 awaitAll。
const asyncTasks = []
function tAsync(name, fn) {
  asyncTasks.push((async () => {
    try { await fn() } catch (e) { record(name, false, `EXCEPTION ${e && e.message}`) }
  })())
}

tAsync('B. 三档语义：null 不退化成 false', async () => {
  // 构造一个「组存在 + 有布局图锚」的最小数据面
  const makeSvc = (anchor, curMaterials) => createSpatialGroupReview({
    query: (sql) => {
      if (/GROUP BY spatial_group/.test(sql)) return [{ spatial_group: 'g1', member_count: 2 }]
      if (/scene_number ASC/.test(sql)) return [{ scene_id: 1, scene_number: 1, title: '场1' }]
      if (/FROM spatial_group_review/.test(sql)) return []
      if (/FROM scene_analysis/.test(sql)) return [{ id: 1, scene_number: 1, title: '场1', props_json: '[]' }]
      return []
    },
    queryOne: () => null,
    execute: () => ({}),
    ensureSceneAnalysis: null,
    getLayoutAnchor: () => anchor,
    layoutMaterialsForGroup: () => curMaterials,
    fingerprintOfMaterials: layoutMaterialsFingerprint,
  })

  const cur = { roles: ['视角甲'], landmarks: ['地标乙'], env: ['环境丙'] }
  const curFp = layoutMaterialsFingerprint(cur)

  // ① 没图 → null
  let d = await makeSvc(null, cur).getSpatialGroupReviewStatus(1)
  record('无布局图 → layoutStale=null', d.groups[0].layoutStale === null, String(d.groups[0].layoutStale))

  // ② 有图 + 指纹一致 → false
  d = await makeSvc({ group: 'g1', imageUrl: '/uploads/x.png', sourceFingerprint: curFp }, cur).getSpatialGroupReviewStatus(1)
  record('指纹一致 → layoutStale=false', d.groups[0].layoutStale === false, String(d.groups[0].layoutStale))

  // ③ 有图 + 指纹不符 → true
  d = await makeSvc({ group: 'g1', imageUrl: '/uploads/x.png', sourceFingerprint: 'deadbeef'.repeat(4) }, cur).getSpatialGroupReviewStatus(1)
  record('指纹不符 → layoutStale=true', d.groups[0].layoutStale === true, String(d.groups[0].layoutStale))

  // ④ 有图但锚没记指纹（老数据）→ null（关键：不能是 false，也不能是 true）
  d = await makeSvc({ group: 'g1', imageUrl: '/uploads/x.png', sourceFingerprint: '' }, cur).getSpatialGroupReviewStatus(1)
  record('锚无指纹（老数据）→ layoutStale=null', d.groups[0].layoutStale === null, String(d.groups[0].layoutStale))

  // ⑤ 有指纹但当前素材取不到指纹 → null（不可判断）
  d = await makeSvc({ group: 'g1', imageUrl: '/uploads/x.png', sourceFingerprint: curFp }, { roles: [], landmarks: [], env: [] }).getSpatialGroupReviewStatus(1)
  record('当前素材无指纹 → layoutStale=null', d.groups[0].layoutStale === null, String(d.groups[0].layoutStale))

  // ⑥ 未注入比对函数 → 全 null（降级回改造前行为）
  const bare = createSpatialGroupReview({
    query: (sql) => {
      if (/GROUP BY spatial_group/.test(sql)) return [{ spatial_group: 'g1', member_count: 2 }]
      if (/scene_number ASC/.test(sql)) return [{ scene_id: 1, scene_number: 1, title: '场1' }]
      if (/FROM spatial_group_review/.test(sql)) return []
      if (/FROM scene_analysis/.test(sql)) return [{ id: 1, scene_number: 1, title: '场1', props_json: '[]' }]
      return []
    },
    queryOne: () => null, execute: () => ({}), ensureSceneAnalysis: null,
    getLayoutAnchor: () => ({ group: 'g1', imageUrl: '/uploads/x.png', sourceFingerprint: 'abc' }),
  })
  const d6 = await bare.getSpatialGroupReviewStatus(1)
  record('未注入比对函数 → layoutStale=null（降级）', d6.groups[0].layoutStale === null, String(d6.groups[0].layoutStale))

  // ⑦ reader 抛错 → 不阻断状态查询，layoutAnchor 为 null
  const throwing = makeSvc(null, cur)
  const dThrows = await createSpatialGroupReview({
    query: (sql) => {
      if (/GROUP BY spatial_group/.test(sql)) return [{ spatial_group: 'g1', member_count: 2 }]
      if (/scene_number ASC/.test(sql)) return [{ scene_id: 1, scene_number: 1, title: '场1' }]
      if (/FROM spatial_group_review/.test(sql)) return []
      if (/FROM scene_analysis/.test(sql)) return [{ id: 1, scene_number: 1, title: '场1', props_json: '[]' }]
      return []
    },
    queryOne: () => null, execute: () => ({}), ensureSceneAnalysis: null,
    getLayoutAnchor: () => { throw new Error('模拟读锚失败') },
  }).getSpatialGroupReviewStatus(1)
  record('读锚抛错 → 不崩、layoutAnchor=null', dThrows.success === true && dThrows.groups[0].layoutAnchor === null)

  // ⑧ 比对函数抛错 → 降级 null，不崩
  const dThrows2 = await createSpatialGroupReview({
    query: (sql) => {
      if (/GROUP BY spatial_group/.test(sql)) return [{ spatial_group: 'g1', member_count: 2 }]
      if (/scene_number ASC/.test(sql)) return [{ scene_id: 1, scene_number: 1, title: '场1' }]
      if (/FROM spatial_group_review/.test(sql)) return []
      if (/FROM scene_analysis/.test(sql)) return [{ id: 1, scene_number: 1, title: '场1', props_json: '[]' }]
      return []
    },
    queryOne: () => null, execute: () => ({}), ensureSceneAnalysis: null,
    getLayoutAnchor: () => ({ group: 'g1', imageUrl: '/uploads/x.png', sourceFingerprint: 'abc' }),
    layoutMaterialsForGroup: () => { throw new Error('模拟素材读取失败') },
    fingerprintOfMaterials: layoutMaterialsFingerprint,
  }).getSpatialGroupReviewStatus(1)
  record('比对抛错 → 降级 null、不崩', dThrows2.success === true && dThrows2.groups[0].layoutStale === null)
})

// ── C. 老库迁移（双轨：schema.sql 给新库，db.js 给老库）──────────────────────
t('C. 迁移双轨', () => {
  const schema = read('../schema.sql')
  record('schema 有 source_fingerprint 列', /source_fingerprint TEXT DEFAULT ''/.test(schema))
  const dbjs = read('../db.js')
  record('db.js migrations 补老库该列', /\['scene_anchors', 'source_fingerprint'/.test(dbjs))
  // 索引依赖后补列的老坑：本轮没加索引，但要有护栏防止以后有人加错位置
  record('schema.sql 未对 source_fingerprint 建索引（避免老库启动崩）',
    !/CREATE INDEX[^;]*source_fingerprint/.test(schema))
})

// ── D. 接线 ──────────────────────────────────────────────────────────────────
t('D. 接线', () => {
  const anchors = read('../ai/sceneAnchors.js')
  record('导出 layoutMaterialsFingerprint', /export function layoutMaterialsFingerprint/.test(anchors))
  record('registerLayoutAnchor 写入指纹', /source_fingerprint/.test(anchors) && /excluded\.source_fingerprint/.test(anchors))
  record('getLayoutAnchor 读出指纹', /source_fingerprint/.test(anchors) && /sourceFingerprint: String\(row\.source_fingerprint/.test(anchors))

  const route = read('../routes/spatial-group-review.js')
  record('路由注入 layoutMaterialsForGroup', /layoutMaterialsForGroup: collectGroupLayoutMaterials/.test(route))
  record('路由注入 fingerprintOfMaterials', /fingerprintOfMaterials: layoutMaterialsFingerprint/.test(route))

  const gen = read('../routes/generate-image.js')
  record('生成路由 import 了指纹函数', /layoutMaterialsFingerprint/.test(gen))
  record('生成路由登记时传 sourceFingerprint', /sourceFingerprint: materialsFp/.test(gen))

  const card = read('../../src/components/SpatialGroupCard.vue')
  record('组件声明 layoutStale prop', /layoutStale:\s*\{\s*type:\s*\[Boolean, null\]/.test(card))

  // 严格比较必须**覆盖每一处绑定**，不是"文件里有一处就行"。
  // 踩过的坑：最初只断言 /layoutStale === true/ 出现过 —— 于是把 v-if 改成宽松真假值
  // 之后测试依然全绿（因为 :class 那行还留着严格比较，正则照样命中）。
  // 现改为：把所有"用到 layoutStale 的表达式"抠出来，逐个要求它是严格比较。
  const exprLines = (card.match(/^\s*(?:v-if|:class|v-show)="[^"]*layoutStale[^"]*"/gm) || [])
  record('至少存在一处 layoutStale 绑定', exprLines.length >= 2, `检出 ${exprLines.length} 处`)
  const loose = exprLines.filter((l) => !/layoutStale === true/.test(l) && !/layoutStale === false/.test(l))
  record('每一处 layoutStale 绑定都是严格比较', loose.length === 0, loose.map((l) => l.trim()).join(' | ') || 'ok')
  record('过时时显示提示条', /这张图可能已过时/.test(card))

  const view = read('../../src/views/SettingsView.vue')
  record('视图透传 :layout-stale', /:layout-stale="group\.layoutStale"/.test(view))
  record('确认框对过时图给不同文案', /group\.layoutStale === true/.test(view))
})

// ── 收尾：必须先把异步断言跑完再汇总，否则退出码会假绿（见上方 tAsync 注释）──
await Promise.all(asyncTasks)

const failed = results.filter((r) => !r.ok)
process.stdout.write(`\n==== layoutStale: ${results.length - failed.length}/${results.length} passed ====\n`)
if (failed.length) {
  process.stdout.write(`FAILED:\n${failed.map((f) => `  - ${f.name}`).join('\n')}\n`)
  process.exit(1)
}
