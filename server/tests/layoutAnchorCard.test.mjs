// A3 布局图卡片 UI · 接线验收测试（2026-09-18）
//
// 解决什么问题：A3 的后端能力（buildLayoutImagePrompt / collectGroupLayoutMaterials /
//   registerLayoutAnchor / layoutReview 质检闭环 + /layout-anchor 双端点）早已就绪，
//   但**前端没有任何入口** —— 能力白做，用户根本碰不到。
//   本轮的活就是把这条链路接通，并用测试把"接通了"这件事钉死。
//
// 为什么测试重点放在**接线**而不是逻辑：
//   这一层几乎全是"胶水"（字段透传、事件绑定、API 路径），逻辑极少但断点极多，
//   而且断了之后静态检查全绿、只有用户点下去才炸（本轮 generate-post 的
//   漏导入就是这么来的）。所以这里逐条断言"线的两端都在"。
//
// 测试分三层：
//   A. 后端 status 带出 layoutAnchor（含降级：未注入 reader 时必须为 null 且不抛）
//   B. 前端 API 两个方法存在且路径/超时正确
//   C. 组件与视图的绑定齐全（props / emit / handler / 模板绑定）
//
// 只读、零网络、零 AI 费用、不碰 server/data.db。可重复运行。

import fs from 'node:fs'
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

// ── A. 后端：status 聚合带出 layoutAnchor ────────────────────────────────────
t('A. status 带出 layoutAnchor', () => {
  const src = read('../ai/spatialGroupReview.js')
  record('工厂接收 getLayoutAnchor 依赖', /getLayoutAnchor = null/.test(src))
  record('outGroups 里带上 layoutAnchor 字段', /^\s+layoutAnchor,$/m.test(src))
  record('读取失败降级为 null（不抛）', /读取布局图锚失败（降级为无）/.test(src))

  // 依赖缺失时必须优雅降级：不注入 reader → 全 null、不抛、组数不变
  const rows = []
  const fakeSvc = createSpatialGroupReview({
    query: (sql) => {
      // 造两个组、每组一个成员的最小数据面
      if (/GROUP BY spatial_group/.test(sql)) return [{ spatial_group: 'g1', member_count: 1 }, { spatial_group: 'g2', member_count: 1 }]
      if (/scene_number ASC/.test(sql)) return [{ scene_id: 1, scene_number: 1, title: '场1' }]
      if (/FROM spatial_group_review/.test(sql)) return []
      if (/FROM scene_analysis/.test(sql)) return []
      return rows
    },
    queryOne: () => null,
    execute: () => ({}),
    ensureSceneAnalysis: null,
    // 刻意不传 getLayoutAnchor —— 模拟"没接上"的降级场景
  })
  return fakeSvc.getSpatialGroupReviewStatus(1).then((d) => {
    record('未注入 reader 时不抛错', true)
    record('未注入 reader 时 layoutAnchor 全为 null', d.groups.length > 0 && d.groups.every((g) => g.layoutAnchor === null), `groups=${d.groups.length}`)
  }).catch((e) => {
    record('未注入 reader 时不抛错', false, e.message)
  })
})

t('A2. 路由注入了真实 reader', () => {
  const route = read('../routes/spatial-group-review.js')
  record('从 sceneAnchors 导入 getLayoutAnchor', /import \{[^}]*getLayoutAnchor[^}]*\} from '\.\.\/ai\/sceneAnchors\.js'/.test(route))
  record('createSpatialGroupReview 收到 getLayoutAnchor', /createSpatialGroupReview\(\{[^}]*getLayoutAnchor[^}]*\}\)/.test(route))

  const anchors = read('../ai/sceneAnchors.js')
  record('sceneAnchors 导出 getLayoutAnchor', /export function getLayoutAnchor/.test(anchors))
  record('getLayoutAnchor 只读不写（无 INSERT/UPDATE/DELETE）', (() => {
    const m = anchors.match(/export function getLayoutAnchor[\s\S]*?\n\}/)
    if (!m) return false
    return !/INSERT|UPDATE|DELETE/i.test(m[0])
  })())
})

// ── B. 前端 API：两个方法存在且口径正确 ──────────────────────────────────────
t('B. 前端 API 方法', () => {
  const api = read('../../src/services/api.js')
  record('有 getLayoutAnchor', /getLayoutAnchor:\s*\(episodeId, group\)/.test(api))
  record('getLayoutAnchor 打到正确路径', /\/generate\/layout-anchor\?episodeId=/.test(api))
  record('有 generateLayoutAnchor', /generateLayoutAnchor:\s*\(data\)/.test(api))
  record('generateLayoutAnchor 用 POST', /generateLayoutAnchor[\s\S]{0,200}method:\s*'POST'/.test(api))
  // 生成链路含多次串行生图 + 质检，必须给长超时，否则前端会先 abort
  record('generateLayoutAnchor 给长超时', /generateLayoutAnchor[\s\S]{0,220}LLM_LONG_TIMEOUT_MS/.test(api))
  record('group 参数做了 encodeURIComponent', /group=\$\{encodeURIComponent\(group\)\}/.test(api))
})

// ── C. 组件与视图接线 ────────────────────────────────────────────────────────
t('C1. SpatialGroupCard props/emit', () => {
  const card = read('../../src/components/SpatialGroupCard.vue')
  record('声明 layoutAnchor prop', /layoutAnchor:\s*\{\s*type:\s*Object/.test(card))
  record('声明 layoutBusy prop', /layoutBusy:\s*\{\s*type:\s*Boolean/.test(card))
  record('emit 含 generate-layout', /defineEmits\(\[[^\]]*'generate-layout'/.test(card))
  record('emit 含 preview-layout', /defineEmits\(\[[^\]]*'preview-layout'/.test(card))
  record('单场景组不显示布局卡（showLayout 要求 >1）', /showLayout = computed\(\(\) => !isSolo\.value && memberCount\.value > 1\)/.test(card))
  record('有图/无图分流（hasLayout）', /hasLayout = computed\(\(\) => !!props\.layoutAnchor\?\.imageUrl\)/.test(card))
  record('按钮 emit generate-layout', /@click="emit\('generate-layout'\)"/.test(card))
  record('点图 emit preview-layout', /@click="emit\('preview-layout', layoutAnchor\)"/.test(card))
  record('重画按钮文案随有无图变化', /\{\{ hasLayout \? '重画布局图' : '生成布局图' \}\}/.test(card))
  record('生成中显示遮罩文案', /正在画布局图/.test(card))
})

t('C2. SettingsView 绑定与处理函数', () => {
  const view = read('../../src/views/SettingsView.vue')
  record('下发 :layout-anchor', /:layout-anchor="group\.layoutAnchor"/.test(view))
  record('下发 :layout-busy', /:layout-busy="layoutBusyKey === group\.group"/.test(view))
  record('接 @generate-layout', /@generate-layout="generateLayout\(group\)"/.test(view))
  record('接 @preview-layout', /@preview-layout="previewLayout\(\$event\)"/.test(view))
  record('有 layoutBusyKey 状态', /const layoutBusyKey = ref\(''\)/.test(view))
  record('有 generateLayout 函数', /function generateLayout\(group\)/.test(view))
  record('有 doGenerateLayout 函数', /async function doGenerateLayout\(group\)/.test(view))
  record('有 previewLayout 函数', /function previewLayout\(layoutAnchor\)/.test(view))
  record('调用 api.generateLayoutAnchor', /api\.generateLayoutAnchor\(/.test(view))
  record('重画前二次确认（已有图才弹）', /group\.layoutAnchor\?\.imageUrl/.test(view) && /openConfirmDialog\(/.test(view))
  record('质检未通过会提示用户', /rv\.verdict === 'fail'/.test(view) && /质检没过/.test(view))
  record('生成后刷新组数据', /await fetchSceneGroups\(true\)/.test(view))
  record('finally 清理 busy（异常也不卡死）', /finally \{\s*layoutBusyKey\.value = ''/.test(view))
  record('新窗口预览带 noopener', /window\.open\(url, '_blank', 'noopener'\)/.test(view))
})

// 接线一致性：视图里 emit 的事件名必须与组件声明的完全一致（本轮踩过的"两端对不上"类问题）
t('C3. 事件名两端一致', () => {
  const card = read('../../src/components/SpatialGroupCard.vue')
  const view = read('../../src/views/SettingsView.vue')
  const declared = (() => {
    const m = card.match(/defineEmits\(\[([^\]]*)\]\)/)
    if (!m) return []
    return (m[1].match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1))
  })()
  const listened = (view.match(/@([a-z-]+)="[^"]*"/g) || [])
    .map((s) => s.slice(1).replace(/=".*$/, ''))
    .filter((n) => !['click', 'input', 'change', 'keydown', 'submit'].includes(n))
  const relevant = ['confirm', 'skip', 'regen-baseline', 'refresh-group', 'restore-version', 'toggle-lock', 'generate-layout', 'preview-layout']
  const missingInCard = relevant.filter((n) => !declared.includes(n))
  record('组件声明了全部组操作事件', missingInCard.length === 0, missingInCard.join(',') || `声明 ${declared.length} 个`)
  // 视图监听的事件必须都在组件声明里（否则是永不会触发的死监听）
  const ghostListeners = listened.filter((n) => relevant.includes(n) && !declared.includes(n))
  record('视图没有死监听（监听了未声明的事件）', ghostListeners.length === 0, ghostListeners.join(',') || 'ok')
})

const failed = results.filter((r) => !r.ok)
process.stdout.write(`\n==== layoutAnchorCard: ${results.length - failed.length}/${results.length} passed ====\n`)
if (failed.length) {
  process.stdout.write(`FAILED:\n${failed.map((f) => `  - ${f.name}`).join('\n')}\n`)
  process.exit(1)
}
