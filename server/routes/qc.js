// 分镜质检面板 + 一键修复（2026-09-16）。
//
// 背景：storyboardValidator 已经能查出十几类问题（越轴 / Airlock 角色消失 / 场景锚为空 /
// 资产缺设定图 …），但结论只落在后端 console.warn 里——**系统查得出来，人却看不见**。
// 库里躺着上百条 warning 无人处理，于是"能发现问题"这件事从未转化成"能修好问题"。
//
// 本模块把质检变成产品能力，三个端点：
//   GET  /generate/qc-report            跑一遍校验 → 按类型聚合的问题清单（面板数据源）
//   POST /generate/qc-fix               按 code 批量修（当前支持 airlock_link / axis_reposition）
//   POST /generate/qc-ignore            标记"人工确认过、不必处理"（避免重复提示）
//
// 设计原则：
// 1. **不引入新的校验逻辑** —— 复用 storyboardValidator.validateStoryboard，单一口径。
//    这里只做「从库里取数据 → 喂给校验器 → 聚合结果」。
// 2. **修复动作由 qcCodes 注册表驱动** —— 本文件不写 if (code === 'XXX') 分支，
//    新增可修复类型只需在注册表登记 + 注册一个 handler。
// 3. **修复是增量、可回退的** —— 只改写目标镜头的 imd 字段，失败保留原稿；
//    不做任何删除操作。人工忽略记录落 qc_ignores 表，可解除。

import { Router } from 'express'
import { query, queryOne, execute, transaction } from '../db.js'
import { config } from '../config.js'
import {
  validateStoryboard,
  rowToShotForQc,
  extractScreenSides,
  hasExplicitReposition,
  buildAliasMap,
} from '../ai/storyboardValidator.js'
import {
  repairShotAirlock,
  repairShotAxis,
  enrichShotIntegrated,
  extractFinalFrameFromIntegrated,
} from '../ai/doubao.js'
import { summarizeQc, qcMeta, isRegisteredQcCode, QC_ACTION } from '../ai/qcCodes.js'
import { checkContinuity } from '../ai/continuityGuard.js'
import { splitScriptScenes } from '../ai/scriptFormat.js'
import { mergeMasterIntoEpisodeCharacters } from '../characterLibrary.js'

const router = Router()

// ===== 数据装配：从库里取出「校验器视角」的整集分镜 =====
// 与 generate-script.js /enrich-storyboard 的取数口径一致（按场次号 + start_time 排序），
// 保证面板里看到的镜头顺序与分镜页、出片顺序完全一致。
function loadEpisodeShots(episodeId) {
  const sceneRows = query(
    'SELECT id, scene_number, title FROM storyboard_scenes WHERE episode_id = ? ORDER BY scene_number',
    [episodeId]
  )
  const scenes = []
  const shotIndex = new Map() // id → { sceneIdx, shot }
  for (let i = 0; i < sceneRows.length; i++) {
    const rows = query(
      'SELECT * FROM shots WHERE storyboard_scene_id = ? ORDER BY start_time, id',
      [sceneRows[i].id]
    )
    const shots = rows.map((r, idx) => {
      const s = rowToShotForQc(r)
      // 镜头号缺失时按场次内序号兜底（与前端展示口径一致）
      if (!s.shotNumber) s.shotNumber = `${sceneRows[i].scene_number}-${idx + 1}`
      shotIndex.set(r.id, { sceneIdx: i, shot: s, raw: r })
      return s
    })
    scenes.push({ sceneNumber: sceneRows[i].scene_number, title: sceneRows[i].title, shots })
  }
  return { scenes, sceneRows, shotIndex }
}

// ===== 资产名单（校验器的 ctx.assetNames）=====
// 必需：V6 角色补齐 / V7 缺设定图 / V16 场景锚 都靠它，缺失会让这三类检查静默空转。
function loadAssetNames(episodeId) {
  const episode = queryOne('SELECT project_id FROM episodes WHERE id = ?', [episodeId])
  const characters = mergeMasterIntoEpisodeCharacters(
    query('SELECT name, description, image_url, project_character_id FROM characters WHERE episode_id = ?', [episodeId])
  )
  return {
    characters,
    scenes: query('SELECT title AS name, title, summary AS description, image_url FROM scenes WHERE episode_id = ?', [episodeId]),
    props: query('SELECT name, description, image_url FROM props WHERE episode_id = ?', [episodeId]),
    projectStyleText: (() => {
      const p = episode ? queryOne('SELECT art_style FROM projects WHERE id = ?', [episode.project_id]) : null
      return p?.art_style || ''
    })(),
    projectId: episode?.project_id ?? null,
  }
}

// ===== 跨场事理检查（continuityGuard 接入，2026-09-16）=====
// storyboardValidator 查的是**镜级**问题（字段、景别、越轴、画风），场与场之间"接不接得上"
// 它管不着——第2集"场1 和场2 的桥一看就是两个地方"就是这类：单看每一镜都合规，
// 连起来却断裂。本函数把剧本正文按场次切开，喂给 continuityGuard 做场级检查。
//
// 为什么要在这里重新切场，而不用 storyboard_scenes.title：
//   · 分镜场次标题是 AI 生成时给的（可能被改写、可能合并/拆分场次），
//     拿它去和剧本正文比对，会把"分镜改过标题"误报成"剧本有问题"；
//   · 事理检查的对象是**剧本**——场次边界必须与编剧写的场次行完全一致。
//   故以 episodes.script_content 为唯一事实源，用与剧本落库同源的
//   splitScriptScenes 切场（判据集中一处，两处各写一份迟早漂移）。
function loadScriptSceneTexts(episodeId) {
  const ep = queryOne('SELECT script_content FROM episodes WHERE id = ?', [episodeId])
  const script = String(ep?.script_content || '')
  if (!script.trim()) return []
  return splitScriptScenes(script)
}

// 把 continuityGuard 的告警转成面板通用的 warning 结构。
// 只做字段搬运，不改判据、不改文案——判据在 continuityGuard，文案在它的语言包里。
// shot 字段放场次标签（这些是场级结论，没有具体镜头；面板对非 '*' 的值会显示为可点击标签，
// 但点击只会尝试定位镜头，找不到就不动——不额外改前端）。
//
// 返回 { warnings, scriptSceneCount }：场次数一并回报——
// 事理检查读的是**剧本场次**，与分镜场次数是两回事（实测第1集分镜被清空、剧本还在，
// 若只报分镜场次数会出现"0 镜 0 场次却检出问题"的困惑）。
function collectContinuityWarnings(episodeId) {
  try {
    const scenes = loadScriptSceneTexts(episodeId)
    if (scenes.length < 2) return { warnings: [], scriptSceneCount: scenes.length }
    const { warnings } = checkContinuity({ scenes }, { only: ['env', 'handoff', 'form'] })
    return {
      scriptSceneCount: scenes.length,
      warnings: warnings.map((w) => ({
        code: w.code,
        shot: `场次${w.scene}`,
        message: w.message,
      })),
    }
  } catch (e) {
    // 降级：事理检查失败绝不能拖垮整个质检报告（面板仍应显示镜级问题）
    console.warn('[qc] 跨场事理检查失败（已跳过）:', e.message)
    return { warnings: [], scriptSceneCount: 0 }
  }
}

// ===== 忽略记录（人工确认"这不是问题"）=====
// 键 = (episode_id, code, shot_number)：同一个镜头同一类问题被人工确认后不再出现在面板里。
// 镜头内容变了怎么办？——修好该问题后记录自然失效：面板只对**仍被检出**的问题做忽略过滤，
// 问题消失即忽略记录成为孤儿（下面 getActiveIgnores 顺带清理孤儿，防表无限膨胀）。
function ensureIgnoreTable() {
  // schema.sql 已建表；这里只做兜底（历史库未跑建表语句时仍可用）
  try {
    execute(`CREATE TABLE IF NOT EXISTS qc_ignores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      episode_id INTEGER NOT NULL,
      code TEXT NOT NULL,
      shot_number TEXT NOT NULL DEFAULT '',
      shot_id INTEGER,
      reason TEXT DEFAULT '',
      UNIQUE(episode_id, code, shot_number)
    )`)
    // 迁移（2026-09-16）：老表补 shot_id 列。SQLite 的 ADD COLUMN 重复执行会报错，故吞掉。
    try { execute('ALTER TABLE qc_ignores ADD COLUMN shot_id INTEGER') } catch { /* 列已存在 */ }
  } catch (e) {
    console.warn('[qc] 建 qc_ignores 表失败（忽略功能降级）:', e.message)
  }
}

// 忽略记录的两套键（2026-09-16 审核修正：原来只用镜号，而镜号会重排）：
//  · byId  —— `${code}\0${shotId}`：镜头的**真身份**。场次增删/保存分镜会让编号整体平移
//             （episodes.js 保存时把 shot_number 拉回与场次一致），镜号不是稳定键；
//             shots.id 才是（保存时优先沿用前端回传的 id）。绑 id 后，编号怎么变忽略都跟得住。
//  · byNum —— `${code}\0${shotNumber}`：老记录兜底（迁移前写入的没有 shot_id），
//             以及集级问题（shot='*' 本就没有具体镜头）。
// 顺带清理孤儿（兑现原注释的承诺）：指向的镜头已不存在（分镜重建/删场次后 id 失效）的记录直接删掉。
function getActiveIgnores(episodeId) {
  const byId = new Set()
  const byNum = new Set()
  try {
    // 先跑一次建表/迁移：本函数是**读路径**（报告生成），历史库的表可能还没有 shot_id 列——
    // 不迁移就 SELECT 会抛错被下面的 catch 吞掉，表现为"忽略全部失效"的静默降级（最难查）。
    ensureIgnoreTable()
    execute(
      `DELETE FROM qc_ignores WHERE episode_id = ? AND shot_id IS NOT NULL AND shot_id NOT IN (
         SELECT s.id FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id
         WHERE ss.episode_id = ?)`,
      [episodeId, episodeId]
    )
    const rows = query('SELECT code, shot_number, shot_id FROM qc_ignores WHERE episode_id = ?', [episodeId])
    for (const r of rows) {
      if (r.shot_id != null) byId.add(`${r.code}\u0000${r.shot_id}`)
      else byNum.add(`${r.code}\u0000${r.shot_number}`)
    }
  } catch { /* 表未就绪：当作无忽略 */ }
  return { byId, byNum }
}

// 镜号 → shots.id 反查表（忽略记录按 id 比对用）
function buildNumToId(shotIndex) {
  const map = new Map()
  for (const [rawId, entry] of shotIndex) map.set(String(entry.shot.shotNumber), rawId)
  return map
}

// 单条问题是否被忽略（先按 id 命中，再退回按镜号命中）
function isIgnored(ignores, code, shotNumber, numToId) {
  if (!ignores) return false
  const sid = numToId?.get(String(shotNumber))
  if (sid != null && ignores.byId.has(`${code}\u0000${sid}`)) return true
  return ignores.byNum.has(`${code}\u0000${shotNumber}`)
}

/**
 * 清空某集的人工忽略记录（2026-09-16 审核补充）。
 *
 * 为什么必须清：忽略记录按 (episode_id, code, shot_number) 存，而 shot_number 是
 * **重建后重排**的序号（generate-script 落库时写 `${si+1}-${shi+1}`）。分镜一旦重新生成/
 * 重新导入/清空，旧记录的"目标"已经不存在，但记录还在——若新分镜里恰好有同一镜号 + 同一 code
 * 的问题，它会被**静默屏蔽**（面板看起来干净，实际是漏检）。这类"看不见的漏检"是最难查的失败模式，
 * 所以分镜换了，"已知且接受"的结论就该一起作废。
 *
 * 供分镜整体重建/清空的路径调用（保存分镜 / 删除分镜）。容错：失败只告警，绝不拖垮主流程。
 */
export function clearQcIgnores(episodeId) {
  try {
    ensureIgnoreTable()
    execute('DELETE FROM qc_ignores WHERE episode_id = ?', [episodeId])
  } catch (e) {
    console.warn('[qc] 清空忽略记录失败（不影响分镜保存）:', e.message)
  }
}

/**
 * 跑一遍整集质检并按类型聚合（面板数据源）。
 * @param {number} episodeId
 * @param {object} [opts] { includeIgnored:boolean }
 */
export function buildQcReport(episodeId, opts = {}) {
  const { scenes, sceneRows, shotIndex } = loadEpisodeShots(episodeId)
  const assetNames = loadAssetNames(episodeId)
  // 复用唯一的校验实现——口径与生成时、出片闸完全一致，不另写一套"面板版检查"
  const qc = validateStoryboard(
    { scenes },
    { characters: assetNames.characters, scenes: assetNames.scenes, props: assetNames.props },
    { projectStyleText: assetNames.projectStyleText, sceneRows }
  )
  // 跨场事理检查（场级）：与镜级检查合流进同一份 warnings，由 summarizeQc 统一按 code 归类。
  // 放在 validateStoryboard 之后、summarizeQc 之前——两条来源的 code 不同，不会互相覆盖。
  const continuity = collectContinuityWarnings(episodeId)
  qc.warnings.push(...continuity.warnings)
  const summary = summarizeQc(qc)

  const numToId = buildNumToId(shotIndex)
  const ignores = opts.includeIgnored ? null : getActiveIgnores(episodeId)
  if (ignores && (ignores.byId.size || ignores.byNum.size)) {
    for (const g of summary.groups) {
      g.items = g.items.filter((it) => !isIgnored(ignores, g.code, it.shot, numToId))
      g.count = g.items.length
    }
    summary.groups = summary.groups.filter((g) => g.items.length > 0)
    summary.ignoredCount = (summary.total - summary.groups.reduce((n, g) => n + g.items.length, 0))
    summary.errorCount = summary.groups.filter((g) => g.level === 'error').reduce((n, g) => n + g.items.length, 0)
    summary.warningCount = summary.groups.filter((g) => g.level === 'warning').reduce((n, g) => n + g.items.length, 0)
    summary.total = summary.errorCount + summary.warningCount
  }

  // 上限保护：超大集 + 某类问题爆炸（如 127 条 ASSET_MISSING_IMAGE）时不让前端一次拉几千条
  const limit = config.storyboard?.qcPanelLimit || 2000
  let trimmed = false
  for (const g of summary.groups) {
    g.count = g.items.length
    if (g.items.length > limit) { g.items = g.items.slice(0, limit); trimmed = true }
  }

  return {
    episodeId,
    total: summary.total,
    errorCount: summary.errorCount,
    warningCount: summary.warningCount,
    ignoredCount: summary.ignoredCount || 0,
    shotCount: qc.summary?.shotCount || 0,
    sceneCount: sceneRows.length,
    // 剧本场次数：跨场事理检查的作用域（与 sceneCount 的分镜场次数区分开——
    // 分镜可能被清空/重建，剧本才是事理检查的事实源）
    scriptSceneCount: continuity.scriptSceneCount,
    fixedCount: qc.summary?.fixedCount || 0,
    trimmed,
    groups: summary.groups,
    // 修复动作枚举透出，前端按钮与后端 handler 用同一份定义（新增动作无需改前端映射表）
    actions: QC_ACTION,
  }
}

// GET /generate/qc-report?episodeId=&includeIgnored=1
router.get('/qc-report', (req, res) => {
  const episodeId = Number(req.query.episodeId)
  if (!Number.isFinite(episodeId) || episodeId <= 0) {
    return res.status(400).json({ error: 'episodeId 必填' })
  }
  try {
    ensureIgnoreTable()
    const episode = queryOne('SELECT id FROM episodes WHERE id = ?', [episodeId])
    if (!episode) return res.status(404).json({ error: '集不存在' })
    const includeIgnored = req.query.includeIgnored === '1' || req.query.includeIgnored === 'true'
    res.json({ success: true, ...buildQcReport(episodeId, { includeIgnored }) })
  } catch (e) {
    console.error('[qc-report] 失败:', e)
    res.status(500).json({ error: e.message || '质检失败' })
  }
})

// ===== 机位重排轮换模板（CAMERA_DIVERSIFY 专用）=====
// 有台词的镜只能用露嘴机位（正面/侧面/过肩）——背面/俯仰拍会让口型对不上台词音频。
const REFRAME_TYPES = ['全景', '中景', '近景', '特写']
const REFRAME_ANGLES_ANY = ['正面', '侧面', '过肩', '背面', '俯拍', '仰拍']
const REFRAME_ANGLES_DIALOGUE = ['正面', '侧面', '过肩']

// ===== 修复动作注册表 =====
// key = QC_ACTION 的值；每个 handler 收到 (episodeId, items, ctx) → { fixed, failed, details[] }
// ctx 提供：{ shotIndex, assetNames, style }
// 约定：handler 绝不抛错给外层（单点失败记进 failed 继续跑其余项），避免一条坏数据毁掉整批。
const FIX_HANDLERS = {
  // 补 Airlock 跨镜衔接：把上一镜最终画面复刻进本镜开头
  [QC_ACTION.AIRLOCK_LINK]: async (episodeId, items, ctx) => {
    const details = []
    let fixed = 0
    let failed = 0
    // 顺序处理（不是并行）：每个镜头都要读"上一镜的 finalFrame"，并行时会读到彼此改写的中间态
    for (const it of items) {
      const entry = findShotEntry(episodeId, ctx, it.shot)
      if (!entry) { failed++; details.push({ shot: it.shot, ok: false, reason: '镜头不存在' }); continue }
      const { sceneIdx, shot, raw } = entry
      const prev = prevShotOf(episodeId, ctx, sceneIdx, shot)
      if (!prev) { failed++; details.push({ shot: it.shot, ok: false, reason: '没有上一镜（本镜是全集首镜）' }); continue }
      const prevFinal = prev.shot.finalFrame || ''
      if (!prevFinal) { failed++; details.push({ shot: it.shot, ok: false, reason: '上一镜没有最终画面描述（final_frame 为空），无法复刻' }); continue }
      try {
        const rewritten = await repairShotAirlock(shot, prevFinal, ctx.style)
        if (!rewritten) { failed++; details.push({ shot: it.shot, ok: false, reason: 'AI 未产出有效的 Airlock 改写' }); continue }
        execute('UPDATE shots SET integrated_multimodal_description = ? WHERE id = ?', [rewritten, raw.id])
        shot.integratedMultimodalDescription = rewritten
        fixed++
        details.push({ shot: it.shot, ok: true })
      } catch (e) {
        failed++
        details.push({ shot: it.shot, ok: false, reason: e.message })
      }
    }
    return { fixed, failed, details }
  },

  // 补走位动作：让侧位翻转成为合法调度（模块4 加 walks from frame X toward frame Y）
  [QC_ACTION.AXIS_REPOSITION]: async (episodeId, items, ctx) => {
    const details = []
    let fixed = 0
    let failed = 0
    for (const it of items) {
      const entry = findShotEntry(episodeId, ctx, it.shot)
      if (!entry) { failed++; details.push({ shot: it.shot, ok: false, reason: '镜头不存在' }); continue }
      const { sceneIdx, shot, raw } = entry
      const prev = prevShotOf(episodeId, ctx, sceneIdx, shot)
      if (!prev) { failed++; details.push({ shot: it.shot, ok: false, reason: '没有上一镜，无法判定侧位翻转' }); continue }
      const charNames = (ctx.assetNames.characters || []).map((c) => c.name).filter(Boolean)
      // 现场重新解析侧位（不信面板传来的旧结论——期间可能已改过稿）。
      // aliasMap 与质检检查口径一致：否则会出现"面板报了越轴、点修复却说没检出翻转"的分裂。
      const aliasMap = buildAliasMap(ctx.assetNames.characters || [])
      const prevSides = extractScreenSides(prev.shot.finalFrame || '', charNames, aliasMap)
      const currSides = extractScreenSides(shot.finalFrame || '', charNames, aliasMap)
      let done = false
      let lastReason = '未检出侧位翻转'
      for (const [name, pSide] of prevSides) {
        const cSide = currSides.get(name)
        if (!cSide || pSide === 'center' || cSide === 'center' || cSide === pSide) continue
        if (hasExplicitReposition(shot.integratedMultimodalDescription || '', cSide)) continue // 已有走位交代 = 已解决
        try {
          const rewritten = await repairShotAxis(shot, name, pSide, cSide, ctx.style)
          if (!rewritten) { lastReason = `@${name} 的走位改写未产出有效结果`; continue }
          execute('UPDATE shots SET integrated_multimodal_description = ? WHERE id = ?', [rewritten, raw.id])
          shot.integratedMultimodalDescription = rewritten
          done = true
          fixed++
          details.push({ shot: it.shot, ok: true, note: `已补 @${name} 走位（frame ${pSide} → frame ${cSide}）` })
          break
        } catch (e) {
          lastReason = e.message
        }
      }
      if (!done) {
        // 已经有走位交代的情况：视为"问题已不存在"，算成功（面板刷新后自动消失）
        const alreadyOk = [...prevSides].every(([name, pSide]) => {
          const cSide = currSides.get(name)
          if (!cSide || pSide === 'center' || cSide === 'center' || cSide === pSide) return true
          return hasExplicitReposition(shot.integratedMultimodalDescription || '', cSide)
        })
        if (alreadyOk) { fixed++; details.push({ shot: it.shot, ok: true, note: '本镜已有走位交代，问题已不存在' }) }
        else { failed++; details.push({ shot: it.shot, ok: false, reason: lastReason }) }
      }
    }
    return { fixed, failed, details }
  },

  // 机位重排（2026-09-16）：跳切 / 景别平推一键修。
  // 两类问题共用一套"改枚举 + 重生成提示词"动作：
  //   · ADJACENT_SHOT_TOO_SIMILAR（镜级）：与上一镜「景别+机位朝向(+运镜)」全同 → 换机位朝向破 30° 同构；
  //   · SCENE_SHOTTYPE_FLAT（场级，item.shot = "场次N"）：整场同景别 → 首镜（交代镜）保留，其余按模板轮换景别+机位。
  // 关键事实：enrichShotIntegrated 只读 shotType，不读 camera_angle / camera_movement ——
  // 新枚举值必须经 actionNote 注入才能进提示词；因此"改枚举"与"重生成"同生共死：
  // 先重生成到内存，成功才把枚举字段 + imd + final_frame 一并落库；失败原稿一行不动。
  // 只改枚举值，不动 description / 台词 / 时长——内容零改写，只重排机位。
  [QC_ACTION.CAMERA_DIVERSIFY]: async (episodeId, items, ctx) => {
    const details = []
    let fixed = 0
    let failed = 0
    // 顺序处理（同 AIRLOCK 的理由）：相邻镜互为前后参照，并行会读到彼此改写的中间态，
    // 连环跳切（N 与 N+1 都报）修不干净。
    for (const it of items) {
      const sceneMatch = /^场次(\d+)$/.exec(String(it.shot || '').trim())
      if (sceneMatch) {
        const r = await reframeFlatScene(episodeId, ctx, Number(sceneMatch[1]), details)
        fixed += r.fixed
        failed += r.failed
      } else {
        const r = await reframeOneShot(episodeId, ctx, String(it.shot).trim(), details)
        fixed += r.fixed
        failed += r.failed
      }
    }
    return { fixed, failed, details }
  },
}

// 按镜头号在已装配的 scenes 里定位（找到则返回场次序号 + shot 对象 + 原始行）
function findShotEntry(episodeId, ctx, shotNumber) {
  const key = String(shotNumber)
  for (const [rawId, entry] of ctx.shotIndex) {
    if (entry.shot.shotNumber === key) return { ...entry, rawId }
  }
  return null
}

// 全集扁平序列里的上一镜（跨场也成立：上一场末镜就是本场首镜的上一镜）
function prevShotOf(episodeId, ctx, sceneIdx, shot) {
  const flat = []
  for (const sc of ctx.scenes) for (const s of sc.shots) flat.push(s)
  const i = flat.findIndex((s) => s.shotNumber === shot.shotNumber)
  if (i <= 0) return null
  const prevShot = flat[i - 1]
  const entry = findShotEntry(episodeId, ctx, prevShot.shotNumber)
  return entry ? { shot: prevShot, ...entry } : { shot: prevShot }
}

// ===== CAMERA_DIVERSIFY 辅助 =====
// QC shot 的 dialogue 经 parseObj 解析（对象/数组/null 都有可能），这里用与校验器
// hasDialogueContent 相同的口径做轻量判定——决定本镜能进哪个机位候选池。
function hasDialogueContentLocal(d) {
  if (d == null) return false
  let arr = d
  if (typeof d === 'string') {
    const s = d.trim()
    if (!s || s === 'null') return false
    try { arr = JSON.parse(s) } catch { return s.length > 2 }
  }
  if (Array.isArray(arr)) return arr.some((x) => String(x?.text || '').trim())
  if (typeof arr === 'object') return Boolean(String(arr.text || '').trim())
  return false
}

// 从候选池挑第一个不在 avoid 列表里的值；全冲突则回退候选池第一项（保证一定有结果）。
function pickDifferent(candidates, ...avoid) {
  const avoidSet = new Set(avoid.filter(Boolean))
  return candidates.find((c) => !avoidSet.has(c)) || candidates[0]
}

// 场级修复（SCENE_SHOTTYPE_FLAT）：首镜是交代镜保留，shots[1..] 轮换景别 + 机位朝向。
async function reframeFlatScene(episodeId, ctx, sceneNumber, details) {
  const scene = ctx.scenes.find((s) => Number(s.sceneNumber) === sceneNumber)
  const label = `场次${sceneNumber}`
  if (!scene) { details.push({ shot: label, ok: false, reason: '场次不存在' }); return { fixed: 0, failed: 1 } }
  const shots = scene.shots || []
  // 幂等预检（同 AXIS 的 alreadyOk 模式）：不到 3 镜、或景别已不再全同 = 问题已不存在。
  // 复用校验器 V11b 的判定口径，不信任面板传来的旧结论。
  const types = shots.map((s) => String(s.shotType || '').trim()).filter(Boolean)
  if (types.length < 3 || new Set(types).size > 1) {
    details.push({ shot: label, ok: true, note: '本场景别已不再全同，问题已不存在' })
    return { fixed: 1, failed: 0 }
  }
  let fixed = 0
  let failed = 0
  let prevType = String(shots[0].shotType || '').trim()
  let prevAngle = String(shots[0].cameraAngle || '').trim()
  for (let i = 1; i < shots.length; i++) {
    const shot = shots[i]
    const shotLabel = shot.shotNumber || `${label}-${i + 1}`
    const entry = findShotEntry(episodeId, ctx, shotLabel)
    if (!entry) { failed++; details.push({ shot: shotLabel, ok: false, reason: '镜头不存在' }); continue }
    const newType = pickDifferent(REFRAME_TYPES, String(shot.shotType || '').trim(), prevType)
    const pool = hasDialogueContentLocal(shot.dialogue) ? REFRAME_ANGLES_DIALOGUE : REFRAME_ANGLES_ANY
    const newAngle = pickDifferent(pool, String(shot.cameraAngle || '').trim(), prevAngle)
    const ok = await regenerateWithFrame(entry, shot, { shotType: newType, cameraAngle: newAngle }, ctx, shotLabel, details)
    if (ok) { fixed++; prevType = newType; prevAngle = newAngle } else { failed++ }
  }
  return { fixed, failed }
}

// 镜级修复（ADJACENT_SHOT_TOO_SIMILAR）：只换机位朝向（最小干预破 30° 同构），景别运镜不动。
async function reframeOneShot(episodeId, ctx, shotNumber, details) {
  const entry = findShotEntry(episodeId, ctx, shotNumber)
  if (!entry) { details.push({ shot: shotNumber, ok: false, reason: '镜头不存在' }); return { fixed: 0, failed: 1 } }
  const { sceneIdx, shot } = entry
  const scene = ctx.scenes[sceneIdx]
  const idx = (scene?.shots || []).findIndex((s) => s.shotNumber === shot.shotNumber)
  // V19 只约束同场相邻（跨场新空间不比），所以上一镜只在本场序列里找；
  // 本镜是场首镜 = 必然不构成跳切。
  const prev = idx > 0 ? scene.shots[idx - 1] : null
  const t = (s) => String(s?.shotType || '').trim()
  const a = (s) => String(s?.cameraAngle || '').trim()
  const m = (s) => String(s?.cameraMovement || '').trim()
  // 复用校验器 V19 的判定口径做幂等预检：景别或机位任一不同/缺失、运镜不同、主体不同、
  // 跨场（场首镜无同场上镜）→ 已不违反。空值不与空值"相等"，避免误修缺机位数据的镜头。
  const stillViolates = Boolean(prev)
    && t(prev) && t(prev) === t(shot)
    && a(prev) && a(prev) === a(shot)
    && (!m(prev) || m(prev) === m(shot))
    && (() => {
        const pc = new Set(prev.characters || [])
        const cc = new Set(shot.characters || [])
        return (pc.size === 0 && cc.size === 0) || [...cc].some((c) => pc.has(c))
      })()
  if (!stillViolates) {
    details.push({ shot: shotNumber, ok: true, note: '与上一镜已不再同构（或跨场），问题已不存在' })
    return { fixed: 1, failed: 0 }
  }
  const pool = hasDialogueContentLocal(shot.dialogue) ? REFRAME_ANGLES_DIALOGUE : REFRAME_ANGLES_ANY
  const newAngle = pickDifferent(pool, a(shot), a(prev))
  const ok = await regenerateWithFrame(entry, shot, { cameraAngle: newAngle }, ctx, shotNumber, details)
  return ok ? { fixed: 1, failed: 0 } : { fixed: 0, failed: 1 }
}

// 共用重生成 + 落库：先 enrichShotIntegrated 到内存，成功才一把写
// camera_angle / shot_type / imd / final_frame；失败原稿不动。
// 新枚举值经 actionNote 注入（enrich 不读 camera 字段），这是唯一进提示词的路径。
async function regenerateWithFrame(entry, shot, frame, ctx, label, details) {
  const { raw } = entry
  const note = `【机位重排·质检修复】硬性要求：本镜必须采用${frame.shotType ? frame.shotType + '景、' : ''}${frame.cameraAngle}机位拍摄`
    + `（以此覆盖一切默认机位假设），运镜与其余调度保持原样。`
  const shotForAI = {
    description: shot.description || '',
    duration: shot.duration || 8,
    shotType: frame.shotType || shot.shotType || '中景',
    characters: shot.characters || [],
    sceneAssets: shot.sceneAssets || [],
    propAssets: shot.propAssets || [],
    dialogue: shot.dialogue || null,
    actionNote: note + (shot.actionNote ? `\n原动作说明：${shot.actionNote}` : ''),
  }
  try {
    const integrated = await enrichShotIntegrated(shotForAI, ctx.assetNames, ctx.style)
    if (!integrated) { details.push({ shot: label, ok: false, reason: 'AI 未产出有效的提示词改写' }); return false }
    // final_frame 直接覆盖：旧值描述的是旧机位画面，留着会污染 V19 / 越轴的下一轮复检。
    const finalFrame = extractFinalFrameFromIntegrated(integrated) || ''
    execute(
      'UPDATE shots SET camera_angle = ?, shot_type = ?, integrated_multimodal_description = ?, final_frame = ? WHERE id = ?',
      [frame.cameraAngle || shot.cameraAngle || '', shotForAI.shotType, integrated, finalFrame, raw.id]
    )
    // 同步内存对象：同批后续镜头的"上一镜"判定必须读到新值，否则连环跳切修不干净。
    if (frame.cameraAngle) shot.cameraAngle = frame.cameraAngle
    if (frame.shotType) shot.shotType = frame.shotType
    shot.integratedMultimodalDescription = integrated
    shot.finalFrame = finalFrame
    details.push({ shot: label, ok: true, note: `已重排为${frame.shotType ? frame.shotType + '景 + ' : ''}${frame.cameraAngle}机位并重生成提示词` })
    return true
  } catch (e) {
    details.push({ shot: label, ok: false, reason: e.message })
    return false
  }
}

// POST /generate/qc-fix { episodeId, code, shots?: string[] }
// shots 省略 = 修复该 code 下的全部问题（受 qcFixBatchLimit 限制）
router.post('/qc-fix', async (req, res) => {
  const { episodeId, code, shots = null } = req.body || {}
  const epId = Number(episodeId)
  if (!Number.isFinite(epId) || epId <= 0) return res.status(400).json({ error: 'episodeId 必填' })
  if (!code || !String(code).trim()) return res.status(400).json({ error: 'code 必填' })

  const meta = qcMeta(code)
  const handler = FIX_HANDLERS[meta.action]
  if (!handler) {
    // 区分两种情况，避免误导：
    //  · 已登记的 manual 类（如 SCENE_ASSET_UNKNOWN）→ 确实"需要人工改内容"
    //  · 未登记 code（走 QC_UNKNOWN_META 兜底）→ 只是没登记修复动作，不是"该人工"
    //    （笼统说"需要人工处理"会让人以为这类问题本来就得手改，实际只是缺 handler）
    const registered = isRegisteredQcCode(code)
    const message = !registered
      ? `未登记的质检码「${code}」没有一键修复动作（在 server/ai/qcCodes.js 登记 action 后即可支持）`
      : meta.action === QC_ACTION.MANUAL
        ? `「${meta.title || code}」需要人工处理，没有一键修复（这类问题涉及剧情/资产设定，自动改会改坏内容）`
        : `暂不支持自动修复该问题类型（${code}）`
    return res.status(400).json({ error: message, action: meta.action, registered })
  }

  try {
    const { scenes, shotIndex } = loadEpisodeShots(epId)
    const assetNames = loadAssetNames(epId)
    // 目标镜头清单：显式传入优先；否则现跑一次质检，取该 code 下的全部问题镜头
    let targets
    if (Array.isArray(shots) && shots.length) {
      targets = shots.map((s) => String(s))
    } else {
      const report = buildQcReport(epId, { includeIgnored: false })
      const g = report.groups.find((x) => x.code === code)
      if (!g) return res.json({ success: true, fixed: 0, failed: 0, details: [], message: '该问题当前已不存在（可能已被修复或已被忽略）' })
      // 只修"镜头级"问题（shot === '*' 的是集级问题，没有具体镜头可改）
      targets = g.items.map((it) => it.shot).filter((s) => s && s !== '*')
      if (!targets.length) {
        return res.status(400).json({ error: `「${meta.title || code}」是整集级问题（不指向具体镜头），需要人工处理` })
      }
    }

    const batchLimit = config.storyboard?.qcFixBatchLimit || 20
    const truncated = targets.length > batchLimit
    const work = truncated ? targets.slice(0, batchLimit) : targets

    const ctx = { scenes, shotIndex, assetNames, style: assetNames.projectStyleText || config.defaultArtStyle }
    const result = await handler(epId, work.map((s) => ({ shot: s })), ctx)
    console.log(`[qc-fix] code=${code} 目标 ${work.length} 镜 → 修好 ${result.fixed}，失败 ${result.failed}`)
    res.json({
      success: true,
      code,
      title: meta.title,
      requested: targets.length,
      processed: work.length,
      truncated,
      batchLimit,
      fixed: result.fixed,
      failed: result.failed,
      details: result.details,
      message: truncated
        ? `本次处理前 ${work.length} 镜（单批上限 ${batchLimit}），剩余 ${targets.length - work.length} 镜请再次点击`
        : `处理完成：修好 ${result.fixed} 镜${result.failed ? `，${result.failed} 镜未成功` : ''}`,
    })
  } catch (e) {
    console.error('[qc-fix] 失败:', e)
    res.status(500).json({ error: e.message || '修复失败' })
  }
})

// POST /generate/qc-ignore { episodeId, code, shots: string[], reason? }
// shots 省略或传 ['*'] = 忽略该 code 的全部问题
router.post('/qc-ignore', (req, res) => {
  const { episodeId, code, shots = null, reason = '' } = req.body || {}
  const epId = Number(episodeId)
  if (!Number.isFinite(epId) || epId <= 0) return res.status(400).json({ error: 'episodeId 必填' })
  if (!code || !String(code).trim()) return res.status(400).json({ error: 'code 必填' })
  try {
    ensureIgnoreTable()
    let targets = Array.isArray(shots) && shots.length ? shots.map((s) => String(s)) : null
    if (!targets) {
      const report = buildQcReport(epId, { includeIgnored: false })
      const g = report.groups.find((x) => x.code === code)
      if (!g) return res.json({ success: true, ignored: 0, message: '该问题当前已不存在' })
      targets = g.items.map((it) => it.shot)
    }
    // 写入时把镜号解析成 shots.id 一起存：镜号会被重排（保存分镜时重编号），
    // id 才是镜头身份——绑 id 后忽略能跟着镜头走，不会因编号平移而错位/漏检。
    const numToId = buildNumToId(loadEpisodeShots(epId).shotIndex)
    let n = 0
    transaction(() => {
      for (const s of targets) {
        try {
          execute(
            'INSERT OR REPLACE INTO qc_ignores (episode_id, code, shot_number, shot_id, reason) VALUES (?, ?, ?, ?, ?)',
            [epId, String(code), String(s), numToId.get(String(s)) ?? null, String(reason).slice(0, 300)]
          )
          n++
        } catch { /* 单条失败不阻断 */ }
      }
    })
    res.json({ success: true, ignored: n })
  } catch (e) {
    console.error('[qc-ignore] 失败:', e)
    res.status(500).json({ error: e.message || '标记失败' })
  }
})

// POST /generate/qc-unignore { episodeId, code, shots? } —— 解除忽略（全清或指定镜头）
router.post('/qc-unignore', (req, res) => {
  const { episodeId, code, shots = null } = req.body || {}
  const epId = Number(episodeId)
  if (!Number.isFinite(epId) || epId <= 0) return res.status(400).json({ error: 'episodeId 必填' })
  try {
    ensureIgnoreTable()
    const params = [epId]
    let sql = 'DELETE FROM qc_ignores WHERE episode_id = ?'
    if (code) { sql += ' AND code = ?'; params.push(String(code)) }
    if (Array.isArray(shots) && shots.length) {
      sql += ` AND shot_number IN (${shots.map(() => '?').join(',')})`
      params.push(...shots.map((s) => String(s)))
    }
    execute(sql, params)
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /generate/qc-ignores?episodeId= —— 查看被忽略的清单（面板"已忽略"折叠区）
router.get('/qc-ignores', (req, res) => {
  const epId = Number(req.query.episodeId)
  if (!Number.isFinite(epId) || epId <= 0) return res.status(400).json({ error: 'episodeId 必填' })
  try {
    ensureIgnoreTable()
    const rows = query(
      'SELECT id, code, shot_number, reason, created_at FROM qc_ignores WHERE episode_id = ? ORDER BY id DESC',
      [epId]
    )
    res.json({ success: true, ignores: rows.map((r) => ({ ...r, title: qcMeta(r.code).title || r.code })) })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router
