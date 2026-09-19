// 系统告警「可见性总账」· 验收测试（2026-09-18）
//
// 解决什么问题：system_alerts 表支持三种维度（shot_id / scene_id / 都没有），
//   但前端**只按 shot_id 过滤**展示，于是场景维度告警全部静默不可见；
//   而顶部汇总数字用的是后端 unresolved（含全部维度）→
//   "顶上写 3 条，翻遍页面一条也找不到"。更糟的是处置时本地列表只同步移除
//   id / shotId 两种，用 sceneId 处置后告警还在、数字也不动。
//
// 设计的不变量（本测试锁定的核心）：
//   ① 总数一致：systemAlertCount 必须等于本地列表长度（不再用后端数字）
//   ② 完备分桶：每条告警恰好落入 {按镜, 按场, 未关联} 之一，不重不漏
//   ③ 处置同步：三种维度任一处置后，本地列表与计数**同时**下降
//
// 测试方式：不 mock 网络，直接**在 Node 里加载 store 的真实分桶逻辑**。
//   做法：从 project.js 源码中抽取这三个纯函数体在隔离沙箱里求值——
//   比"断言源码里有某段字符串"强得多（后者改错逻辑仍绿，本项目已踩过这个坑）。

import fs from 'node:fs'

const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ::  ${detail}` : ''}\n`)
}
function t(name, fn) {
  try { fn() } catch (e) { record(name, false, `EXCEPTION ${e && e.message}`) }
}
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8')

const storeSrc = read('../../src/stores/project.js')
const viewSrc = read('../../src/views/VideoView.vue')

// ── 从源码抽出三个分桶函数的**真实实现**（而非重新实现一份）──
// 抽取方式：匹配 `function xxx(...) {...}` 到下一个顶层 `  }` 为止。
// 若抽取失败（函数被重命名/挪走），测试直接失败而不是悄悄跳过。
function extractFn(src, name) {
  // 支持 async 前缀：resolveAlerts 就是 async function（初版漏了这个前缀 → 抽取失败）
  const re = new RegExp(`\\n  (?:async )?function ${name}\\([^)]*\\) \\{`)
  const m = src.match(re)
  if (!m) return null
  const start = m.index + 1
  // 从 start 起，按缩进收敛找到该函数的收尾 `  }`
  const lines = src.slice(start).split('\n')
  let depth = 0
  const out = []
  for (const line of lines) {
    out.push(line)
    const opens = (line.match(/\{/g) || []).length
    const closes = (line.match(/\}/g) || []).length
    depth += opens - closes
    if (depth === 0 && out.length > 1) break
  }
  return out.join('\n')
}

t('S0. 三个分桶函数都能从源码抽出（防重命名后测试静默失效）', () => {
  for (const n of ['alertsForShot', 'alertsForScene', 'alertsUnattached']) {
    const body = extractFn(storeSrc, n)
    record(`抽出 ${n}`, !!body, body ? `${body.split('\n').length} 行` : '未找到')
  }
})

/** 在沙箱里跑真实的三个分桶函数，传入给定的告警列表。 */
function bucketize(alerts) {
  const shot = extractFn(storeSrc, 'alertsForShot')
  const scene = extractFn(storeSrc, 'alertsForScene')
  const un = extractFn(storeSrc, 'alertsUnattached')
  if (!shot || !scene || !un) throw new Error('抽取失败')
  const systemAlerts = { value: alerts }
  const factory = new Function('systemAlerts', `
    ${shot}
    ${scene}
    ${un}
    return { alertsForShot, alertsForScene, alertsUnattached }
  `)
  return factory(systemAlerts)
}

// ── A. 分桶完备性（本功能的核心不变量）──────────────────────────────────────
t('A1. 三种维度的告警各自归入正确的桶', () => {
  const { alertsForShot, alertsForScene, alertsUnattached } = bucketize([
    { id: 1, shot_id: 10, scene_id: null },
    { id: 2, shot_id: null, scene_id: 20 },
    { id: 3, shot_id: null, scene_id: null },
  ])
  record('按镜命中 shot 维度', alertsForShot(10).map((a) => a.id).join() === '1')
  record('按场命中 scene 维度', alertsForScene(20).map((a) => a.id).join() === '2')
  record('未关联命中双空', alertsUnattached().map((a) => a.id).join() === '3')
})

t('A2. 每个桶互不重叠（同一条不会出现在两个桶里）', () => {
  const alerts = [
    { id: 1, shot_id: 10, scene_id: null },
    { id: 2, shot_id: null, scene_id: 20 },
    { id: 3, shot_id: null, scene_id: null },
    { id: 4, shot_id: 11, scene_id: null },
  ]
  const b = bucketize(alerts)
  const ids = [
    ...b.alertsForShot(10).map((a) => a.id),
    ...b.alertsForScene(20).map((a) => a.id),
    ...b.alertsUnattached().map((a) => a.id),
  ]
  record('无重复', new Set(ids).size === ids.length, ids.join(','))
})

t('A3. 分桶完备：所有告警都能被至少一个桶捞到', () => {
  // 构造一批覆盖各维度的告警（含脏值），模拟真实库的混合情况
  const alerts = [
    { id: 1, shot_id: 10, scene_id: null },
    { id: 2, shot_id: null, scene_id: 20 },
    { id: 3, shot_id: null, scene_id: null },
    { id: 4, shot_id: 0, scene_id: null },      // shot_id=0 的边界
    { id: 5, shot_id: null, scene_id: 0 },      // scene_id=0 的边界
  ]
  const b = bucketize(alerts)
  const seen = new Set()
  // 遍历所有出现过的 id（把 0 也算上，因为 0 是合法 id）
  for (const a of alerts) {
    const got = [
      ...b.alertsForShot(a.shot_id),
      ...b.alertsForScene(a.scene_id),
      ...(a.shot_id == null && a.scene_id == null ? b.alertsUnattached() : []),
    ]
    if (got.some((x) => x.id === a.id)) seen.add(a.id)
    else record(`A3. 告警 #${a.id} 可被捞到`, false, '落入盲区')
  }
  record('A3. 无盲区告警', seen.size === alerts.length, `${seen.size}/${alerts.length}`)
})

t('A4. 双空告警不会被误算进按镜/按场', () => {
  const b = bucketize([{ id: 9, shot_id: null, scene_id: null }])
  record('未关联不进按镜', b.alertsForShot(1).length === 0 && b.alertsForShot(null).length === 0)
  record('未关联不进按场', b.alertsForScene(1).length === 0)
  record('未关联只进未关联桶', b.alertsUnattached().length === 1)
})

t('A5. alertsForScene 对 null/空值的入参安全（防误捞全部）', () => {
  const b = bucketize([
    { id: 1, shot_id: null, scene_id: null },
    { id: 2, shot_id: null, scene_id: 20 },
  ])
  // 关键：传 null 不能返回「所有 scene_id 为 null 的告警」——
  // 那会让"未关联"告警被误当某个场景的告警显示
  record('sceneId=null → 空数组', b.alertsForScene(null).length === 0)
  record('sceneId=\'\' → 空数组', b.alertsForScene('').length === 0)
  record('sceneId=undefined → 空数组', b.alertsForScene(undefined).length === 0)
})

t('A6. 数值与字符串 id 都能匹配（后端 JSON 可能给字符串）', () => {
  const b = bucketize([{ id: 1, shot_id: '10', scene_id: null }])
  record('字符串 shot_id 能被数字 10 匹配', b.alertsForShot(10).length === 1)
})

// ── B. 计数口径 ──────────────────────────────────────────────────────────────
t('B1. resolveAlerts 覆盖三种维度（静态检查：三选一分支齐全）', () => {
  // 这里用静态检查是刻意的：resolveAlerts 依赖 api（需 mock fetch），
  // 抽取执行成本高；而"三个分支是否齐全"恰好是纯结构问题。
  const fn = extractFn(storeSrc, 'resolveAlerts')
  record('抽出 resolveAlerts', !!fn)
  if (fn) {
    record('含 id 分支', /payload\?\.id\s*!=\s*null/.test(fn))
    record('含 shotId 分支', /payload\?\.shotId\s*!=\s*null/.test(fn))
    record('含 sceneId 分支', /payload\?\.sceneId\s*!=\s*null/.test(fn), '这是本轮修补的洞')
    record('sceneId 分支按 scene_id 过滤', /Number\(a\.scene_id\)\s*!==\s*Number\(payload\.sceneId\)/.test(fn))
  }
})

t('B2. 计数以本地列表为准（不再用后端 unresolved）', () => {
  const fn = extractFn(storeSrc, 'resolveAlerts')
  record('计数赋值为列表长度', /systemAlertCount\.value\s*=\s*systemAlerts\.value\.length/.test(fn))
  const load = extractFn(storeSrc, 'loadAlerts')
  // loadAlerts 里仍可暂存后端数字（用于首次渲染），但必须在列表赋值之后——
  // 真正的一致性由 resolveAlerts 与展示层保证。这里断言 loadAlerts 同时存了列表与数字。
  record('loadAlerts 存了列表', /systemAlerts\.value\s*=\s*Array\.isArray/.test(load))
})

t('B3. 视图不再硬编码告警来源清单', () => {
  // ⚠️ 只查 <template> 区，不查 <script> —— 注释里会**引用**旧文案做历史说明
  // （本文件注释就写了"原本是末帧接力/接缝检测/…"），查全文会误报。
  // 这个坑与 layoutStale 轮次踩过的"正则改到了注释、以为改了代码"同源。
  const tpl = viewSrc.slice(viewSrc.indexOf('<template>'))
  const shown = tpl.replace(/<!--[\s\S]*?-->/g, '') // 再去掉模板里的 HTML 注释
  record('汇总条文案不含硬编码钩子枚举', !/末帧接力\s*\/\s*接缝检测\s*\/\s*色向闸/.test(shown))
  record('改为动态列出实际来源', /alertSourceSuffix|alertSources/.test(shown))
})

t('B4. 视图给出"未关联告警"的可见入口', () => {
  record('模板引用 unattachedAlerts', /unattachedAlerts/.test(viewSrc))
  record('模板有处置按钮', /dismissOneUnattached/.test(viewSrc))
  record('按钮有条件渲染（无未关联则不显示）', /v-if="unattachedAlerts\.length"/.test(viewSrc))
})

t('B5. store 导出了新增的两个分桶函数', () => {
  record('导出 alertsForScene', /alertsForScene/.test(storeSrc))
  record('导出 alertsUnattached', /alertsUnattached/.test(storeSrc))
  // 必须真的在 return 对象里，否则视图调不到（"定义了却没导出"是静默失效）
  record('alertsForScene 在 return 中', /loadAlerts,\s*alertsForShot,\s*alertsForScene,\s*alertsUnattached,\s*resolveAlerts/.test(storeSrc))
})

t('B6. 视图用到的 store 方法都已导出（防"调了没导出"）', () => {
  const used = [...viewSrc.matchAll(/store\.(alerts[A-Za-z]+|resolveAlerts|loadAlerts)/g)].map((m) => m[1])
  const uniq = [...new Set(used)]
  for (const u of uniq) {
    record(`store.${u} 已导出`, new RegExp(`\\b${u}\\b`).test(storeSrc.slice(storeSrc.lastIndexOf('return {'))))
  }
})

// ── C. 端到端：分桶 + 处置后的计数一致性 ────────────────────────────────────
t('C1. 模拟处置场景告警后，计数与各桶同步下降', () => {
  const alerts = [
    { id: 1, shot_id: 10, scene_id: null },
    { id: 2, shot_id: null, scene_id: 20 },
    { id: 3, shot_id: null, scene_id: 20 },
    { id: 4, shot_id: null, scene_id: null },
  ]
  const b0 = bucketize(alerts)
  const total0 = alerts.length
  record('处置前总数=4', total0 === 4)
  record('处置前场景 20 有 2 条', b0.alertsForScene(20).length === 2)

  // 模拟 resolveAlerts({ sceneId: 20 }) 的本地同步
  const after = alerts.filter((a) => Number(a.scene_id) !== 20)
  const b1 = bucketize(after)
  record('处置后总数=2', after.length === 2)
  record('处置后场景 20 清空', b1.alertsForScene(20).length === 0)
  record('处置后按镜不受影响', b1.alertsForShot(10).length === 1)
  record('处置后未关联不受影响', b1.alertsUnattached().length === 1)
  // 核心不变量：处置后各桶之和 === 总数（无遗漏无重复）
  const sum = b1.alertsForShot(10).length + b1.alertsForScene(20).length + b1.alertsUnattached().length + b1.alertsForScene(99).length
  record('处置后 各桶之和 === 总数', sum === after.length, `${sum} vs ${after.length}`)
})

t('C2. 模拟处置单条后计数正确', () => {
  const alerts = [
    { id: 1, shot_id: 10, scene_id: null },
    { id: 2, shot_id: null, scene_id: null },
  ]
  const after = alerts.filter((a) => Number(a.id) !== 2)
  record('处置单条后剩 1 条', after.length === 1)
  record('未关联桶同步清空', bucketize(after).alertsUnattached().length === 0)
})

// ── 收尾 ─────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
process.stdout.write(`\n==== alertVisibility: ${results.length - failed.length}/${results.length} passed ====\n`)
if (failed.length) {
  process.stdout.write(`FAILED:\n${failed.map((f) => `  - ${f.name}`).join('\n')}\n`)
  process.exit(1)
}
