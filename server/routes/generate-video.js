import { Router } from 'express'
import { randomUUID } from 'crypto'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { query, queryOne, execute, transaction } from '../db.js'
import { scriptHash } from '../scriptHash.js'

const execFile = promisify(execFileCb)
import { generateScript, classifyScriptIntent, reviseScriptEdits, applyScriptEdits, rewriteFullScript, rewriteScriptSegment, extractAssets, generateStoryboard, generateStoryboardFromFile, extractBlockingForScene, assembleBlockingPlan, enrichShotIntegrated, chatCompletion } from '../ai/doubao.js'
import { ensureStandardScript } from '../ai/scriptFormat.js'
import { buildSceneGridPrompt, buildShotGridPrompt, buildShotGridContentApp, allocateShotRefs, splitSceneGrid } from '../ai/directorRequest.js'
import { runWorkflow, uploadImageV2, insecureDownload, queryTaskOutput, isPlausibleMp4 } from '../ai/runninghub.js'
import { generateShotVideoCombat } from '../ai/combatVideo.js'
import { generateShotVideoV4, buildShotVideoPromptV4 } from '../ai/v4Video.js'
import { assertScriptConfirmed, assertNotStale, assertNoStylePoison } from '../ai/guards.js'
import { relayLastFrameToNextShot, anchorEpisodeStyle } from '../ai/postHooks.js'
// MC 镜型判定（2026-09-14）：跨场硬关 > 单镜显式 > 全局默认，见 mcPolicy.js 头注
import { resolveMc } from '../ai/mcPolicy.js'
import { generateShotGridApp } from '../ai/rhShotGrid.js'
import { checkSeam, checkOpenerTone } from '../ai/seamCheck.js'
import { reviewShot, reviewShotByShotId } from '../ai/shotReview.js'
// 系统告警（2026-09-13）：出片后置钩子链失败可见化——落 system_alerts，前端亮角标、响应带 warnings
import { recordAlert, resolveAlertsByShot } from '../ai/alerts.js'
// 成片打捞守护（2026-09-15）：本地化全灭后登记队列，后台定时重捞，见 salvageWorker.js 头注
import { enqueueSalvage } from '../salvageWorker.js'
import { buildGlobalSpeakerMap } from '../ai/h3PromptTranslator.js'
import { validateCameraAngle, inferAngleFromText, angleInjection } from '../ai/cameraAngle.js'
import { generateImage, generateStoryboardImage, resolveProvider } from '../ai/image.js'
import { backfillStoryboardAssets } from '../ai/assetBackfill.js'
import { classifyShotCombat } from '../ai/shotClassifier.js'
import { config } from '../config.js'
// cleanText 统一到 ai/shared.js（原此处与 ai/videoPrompt.js 各有一份实现）
import { clean as cleanText, pickInjectableEnglish } from '../ai/shared.js'
// 台词字段读写判据单点（2026-09-18 P0-3）：shots.dialogue 契约是 JSON 数组，但库里存在
// 4 字符字符串 "null" 的历史脏值（写入侧 JSON.stringify(null) 所致）。此前本文件三处
// 各写一遍 `!== 'null' && !== '[]'` 兜底；统一走 dialogue.js，新消费方不会再漏。
import { parseDialogue, hasDialogue } from '../ai/dialogue.js'
import { replaceEpisodeCharacters, mergeMasterIntoEpisodeCharacters, syncProjectCharacterToEpisodes } from '../characterLibrary.js'
import { routeIp, buildCharacterContext, resolveExplicitCharacters } from '../ai/ipRouter.js'
// 成片拼接（保存至成片）：ffmpeg-static 已用于分镜图切分（directorRequest.js），这里复用同一份二进制
import ffmpegStaticPath from 'ffmpeg-static'
import { ASSET_TYPES } from '../ai/assetTypes.js'
// 资产物理状态（P2'，2026-09-17）：判据单点 ai/assetState.js，此处只 import 消费
import { resolveState } from '../ai/assetState.js'
// 道具名跨层归一（2026-09-18，P1-Q1）：shots.prop_assets 的名字与 props 表名可能不一致
// （两趟 LLM 各说各话，ep4 实证「断桥」vs「腐朽木桥」）→ 精确匹配拿不到参考图。
import { resolvePropName } from '../ai/propNameMatch.js'
import { pickEnglish as pickEnglishGuard, stripResidualCjk as stripCjkGuard } from '../ai/v4Video.js'
const router = Router()

// 道具类型键（从共享常量取，避免字面量散落）
const TYPE_PROP = ASSET_TYPES.includes('prop') ? 'prop' : ASSET_TYPES[ASSET_TYPES.length - 1]

// ===== 道具状态描述注入（P2'，单点，供单镜 L282 与段级 L787 共用）=====
// 从 shots.asset_states_json 解析本镜该道具的状态，取 asset_states 行的 description_en
// （经 pickEnglish 护栏，绝不让中文进英文 prompt）；机制关闭/无状态/查不到 → 返回空串
// （与 baseDescEn 拼接后仍可能为空 → 等同改造前行为）。
// ⚠️ 与 v4Video.resolveAssetName 同一「宁缺勿脏」原则：中文状态描述一律丢弃。
function propStateDescEn(shot, propName, baseDescEn) {
  const base = String(baseDescEn || '').trim()
  if (!config.assetState?.enabled) return base
  let map = null
  try {
    map = shot && shot.asset_states_json ? JSON.parse(shot.asset_states_json) : null
  } catch { map = null }
  const entry = (map && typeof map === 'object' && map.prop) ? map.prop[propName] : null
  if (!entry) return base
  try {
    const rows = query(
      `SELECT state_key, label_zh, description, description_en, image_url, is_default
       FROM asset_states WHERE asset_type = ? AND asset_key = ?`,
      [TYPE_PROP, propName]
    )
    if (!rows.length) return base
    const st = resolveState(entry, rows)
    if (!st.resolved) return base
    const stateEn = pickEnglishGuard(st.descriptionEn) || stripCjkGuard(st.descriptionEn)
    if (!stateEn) return base
    return base ? `${base}; ${stateEn}` : stateEn
  } catch (e) {
    console.warn(`[generate-video] 道具状态解析失败（降级为无状态）: ${e.message}`)
    return base
  }
}

// 供 _audit_p0_dualpaths.mjs 静态断言：两处装配必须同式
export const __propStateDescEn = propStateDescEn


const uploadsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'uploads')
fs.mkdirSync(uploadsDir, { recursive: true })

// ===== 全片发声编号表 (Sx) =====
// 官方 base-en.txt §4.4：(Sx) 必须按「全片实际发声先后」只分配一次，且跨镜稳定——
// 同一角色在任何镜头都得是同一个 Sx，模型才能把音色参考稳定映射到人；从不发声的角色不给 ID。
// 逐镜编号会漂移（例如 布布在 3-2 发声时被编 S1，但在 9-1 又变成 S2），故在路由层统一算好。
function episodeSpeakerIds(shot) {
  const sceneRowId = shot?.storyboard_scene_id
  if (!sceneRowId) return new Map()
  const ep = queryOne('SELECT episode_id FROM storyboard_scenes WHERE id = ?', [sceneRowId])
  if (!ep?.episode_id) return new Map()
  const rows = query(
    `SELECT s.dialogue FROM shots s
     JOIN storyboard_scenes ss ON ss.id = s.storyboard_scene_id
     WHERE ss.episode_id = ? ORDER BY s.start_time, s.id`,
    [ep.episode_id]
  )
  return buildGlobalSpeakerMap(rows)
}
/**
 * 镜头戏型解析（决定打斗 LoRA 强度），三级回退，任何剧本通用：
 *   1. shots.is_combat —— AI 分镜时标注 / 人工在前端覆盖（最准）
 *   2. classifyShotCombat() —— 按镜头内容打分（换剧本自动生效）
 *   3. 场次号 —— 仅在数据库无该字段的老数据上兜底
 */
function resolveIsCombat(shot) {
  if (shot?.is_combat === 1 || shot?.is_combat === 0) return shot.is_combat === 1
  return classifyShotCombat(shot)
}
// ===== 单镜出片（MiniMax H3 全能生视频 V4 workflow, h3V4）=====
// 与 /video 同范式：inflight 登记 + 同步等待 + 完成回写 shots.video_url / video_generated。
// 区别：① 参考图槽 9 个（角色/场景/道具全绑，不再只取前 2 角色）；② 提示词走 V4 版 Ref2VA
// （subject 绑定不限 3）；③ 文戏/武戏风格分流（吉卜力 vs 写实物理打击，对标 9月8日.mp4）。
const V4_VIDEO_JOB_STALE_MS = 30 * 60 * 1000
const v4VideoJobsInflight = new Map()

router.get('/video-v4/inflight', (req, res) => {
  const now = Date.now()
  const list = []
  for (const [k, j] of v4VideoJobsInflight) {
    if (now - j.startedAt > V4_VIDEO_JOB_STALE_MS) { v4VideoJobsInflight.delete(k); continue }
    list.push({ shotId: j.shotId, phase: j.phase, taskId: j.taskId || '', startedAt: j.startedAt })
  }
  res.json(list)
})

router.post('/video-v4', async (req, res) => {
  const { shotId, aspectRatio, megapixels, duration, allowSilent, allowNoFrame, secondPass, seed, useMotionContext, ignoreSeamAlert, ignoreAnchorPoison, forceRetry } = req.body
  if (!shotId) return res.status(400).json({ error: 'shotId 必填' })

  const shot = queryOne(
    `SELECT s.*, ss.episode_id, ss.scene_number FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id WHERE s.id = ?`,
    [shotId]
  )
  if (!shot) return res.status(404).json({ error: '镜头不存在' })

  // 下游拦截（锁4，2026-09-12，布哥拍板"约束彻底锁死，不要重复自动重 roll"）：
  // 上一镜有「未处置」的衔接/色向告警时，拒绝继续烧下游——上游不修，下游出了也白出
  // （上游一重生，下游锚帧即过期必须跟着重生，锁1 会作废旧检测）。
  // 「处置」两条路：a) 重生上一镜，新检测覆盖旧记录（alert 变 false 自然放行）；
  // b) 本请求显式传 ignoreSeamAlert —— 人工确认接受现状，在告警记录上落处置戳放行。
  // 处置戳只对「这次告警」有效：上一镜重生后检测记录整体刷新，新告警重新拦截。
  // 只拦新鲜告警（alert===true 且无 acknowledgedAt）；seam_check 为空 / alert=false / 脏 JSON 一律放行。
  const prevShot = queryOne(
    `SELECT s.id, s.shot_number, s.seam_check, s.shot_review, ss.scene_number AS prev_scene FROM shots s
     JOIN storyboard_scenes ss ON ss.id = s.storyboard_scene_id
     WHERE ss.episode_id = ? AND (s.start_time < ? OR (s.start_time = ? AND s.id < ?))
     ORDER BY s.start_time DESC, s.id DESC LIMIT 1`,
    [shot.episode_id, shot.start_time, shot.start_time, shot.id]
  )
  if (prevShot?.seam_check) {
    let prevSeam = null
    try { prevSeam = JSON.parse(prevShot.seam_check) } catch { /* 脏 JSON 视同无记录，不拦 */ }
    if (prevSeam?.alert === true && !prevSeam.acknowledgedAt) {
      if (!ignoreSeamAlert) {
        return res.status(409).json({
          error: `上一镜 ${prevShot.shot_number} 有未处置的${prevSeam.checkType === 'openerTone' ? '开场色调跑偏' : '衔接异常'}告警，出片链已锁死：请先重生上一镜消除告警，或人工确认接受现状后带 ignoreSeamAlert 重试（不会自动重 roll）。`,
          prevShotId: prevShot.id,
          prevShotNumber: prevShot.shot_number,
          seamAlert: prevSeam,
        })
      }
      try {
        prevSeam.acknowledgedAt = new Date().toISOString()
        execute('UPDATE shots SET seam_check = ? WHERE id = ?', [JSON.stringify(prevSeam), prevShot.id])
        console.log(`[/generate/video-v4] shot ${shotId}：人工放行上一镜 ${prevShot.shot_number} 的${prevSeam.checkType === 'openerTone' ? '色向' : '衔接'}告警（ignoreSeamAlert）`)
      } catch { /* 处置戳写失败不拦主流程 */ }
    }
  }

  // 接力锚防污染（锁5，2026-09-14）：上一镜观片 fail 且问题命中「角色一致性/末帧穿帮」类
  // （变成/被替换/漂移/不一致/穿帮/消失）→ 它的末帧已被接力钩子写成下一镜的 continuity 锚，
  // 锚脏了下游全白出（9-14 事故：2-1 末帧布布变棕熊，2-2/2-3/2-4 连带建立在坏锚上）。
  // 放行两条路同锁4：a) 重生上一镜（成片即换，观片闸重新判定，合格自然放行）；
  // b) 人工确认带 ignoreAnchorPoison —— 在观片结论上落处置戳放行（只对本次结论有效，重评即失效）。
  // 口径细节：
  // · 只看 issues+summary，不看 missingBeats——「动作没演」不污染锚（锚跟实际成片走，自洽），
  //   脏的是「画面本身错了」（角色被换/漂移/穿帮）；观片未跑（NULL）/warn/脏 JSON 一律放行。
  // · 跨场不锁：relay 对换场跳切不写接力锚（见 postHooks 跨场判定），场首镜无锚可污染。
  // · v4 重生成功时顺带清本镜旧 shot_review（成片已换旧结论失效），消除重生后旧 fail 的假拦截。
  if (prevShot?.shot_review && Number(prevShot.prev_scene) === Number(shot.scene_number)) {
    let prevReview = null
    try { prevReview = JSON.parse(prevShot.shot_review) } catch { /* 脏 JSON 视同无记录，不拦 */ }
    const poisonText = prevReview ? [...(prevReview.issues || []), prevReview.summary || ''].join('\n') : ''
    if (prevReview?.verdict === 'fail' && /(穿帮|变成|被替换|换成了|漂移|不一致|消失|闯入|选角|错演)/.test(poisonText) && !prevReview.acknowledgedAt) {
      if (!ignoreAnchorPoison) {
        return res.status(409).json({
          error: `上一镜 ${prevShot.shot_number} 观片不合格且问题涉及角色一致性/末帧穿帮（${(prevReview.issues || [])[0] || '详见观片记录'}），接力锚可能已污染，出片链已锁死：请先重生上一镜（新观片合格自动放行），或人工确认接受现状后带 ignoreAnchorPoison 重试（不会自动重 roll）。`,
          prevShotId: prevShot.id,
          prevShotNumber: prevShot.shot_number,
          anchorPoison: true,
          review: prevReview,
        })
      }
      try {
        prevReview.acknowledgedAt = new Date().toISOString()
        prevReview.acknowledgedBy = 'ignoreAnchorPoison'
        execute('UPDATE shots SET shot_review = ? WHERE id = ?', [JSON.stringify(prevReview), prevShot.id])
        console.log(`[/generate/video-v4] shot ${shotId}：人工放行上一镜 ${prevShot.shot_number} 的观片污染告警（ignoreAnchorPoison）`)
      } catch { /* 处置戳写失败不拦主流程 */ }
    }
  }

  // 台词闸门（同 /video）：H3 只念 <d> 标签内台词，无台词需 allowSilent 显式放行。
  // hasDialogue 要求**至少一行有非空正文**——旧写法只比串本身（!== 'null' !== '[]'），
  // 于是 `[{"character":"A"}]` 这种没有正文的脏行也能骗过闸门：钱花了，成片没人说话。
  const hasDlg = hasDialogue(shot.dialogue)
  if (!hasDlg && !allowSilent) {
    return res.status(400).json({ error: '本镜没有台词（dialogue 为空，通常是 AI 分镜生成时漏了台词）：H3 只念 <d> 标签内的台词，无台词=成片没有角色语音。请补全该镜台词或重新生成分镜；若确认为纯动作无声镜头，请传 allowSilent 再出片。' })
  }
  // 构图锚闸门（2026-09-16 导演审计）：frame_url 与 continuity_url 双空 = 出片没有任何
  // 视觉构图锚（分镜构图锚 / 上一镜接力锚都缺）——机位、构图、主体位置全靠文字描述
  // 与模型自由发挥，成片与分镜大概率对不上 → 高概率返工重抽。处置两条路：
  // a) 先出分镜图（出图路由会写 frame_url）再出片；
  // b) 确认要文字裸出片，传 allowNoFrame（与台词闸门 allowSilent 同模式）。
  const hasFrameAnchor = String(shot.frame_url || '').trim() || String(shot.continuity_url || '').trim()
  if (!hasFrameAnchor && !allowNoFrame) {
    return res.status(400).json({ error: '本镜没有分镜图（frame_url 为空）也没有接力锚（continuity_url 为空）：出片没有任何构图锚，机位/构图靠模型自由发挥，成片与分镜大概率对不上。请先生成分镜图再出片；若确认要纯文字出片，请传 allowNoFrame。' })
  }
  // 画风毒词硬闸（V12，同 /video）：风格切换词 400 拦截，不花币出画风跑偏的片
  try {
    assertNoStylePoison(shot, req.body.allowStyleShift)
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message })
  }
  // 防烧币上限闸（eval-in-the-loop 上限 2，兑现 db.js retry_count 迁移注释的承诺）：
  // 该镜已带着验收反馈成功重出过 ≥2 次、现在又攒了新的 fail 反馈——同样的修正两轮没生效，
  // 第 3 次同路径回灌大概率重复失败（单镜 27~40 币）。烧币前先人工看片定根因
  // （画风/音色/构图基线问题不是回灌指令能修的）；确认仍要重试，传 forceRetry: true 越闸。
  const priorRetries = Number(shot.retry_count) || 0
  if (priorRetries >= 2 && String(shot.retry_feedback || '').trim() && !forceRetry) {
    return res.status(409).json({
      error: `镜 ${shot.shot_number} 已按验收反馈自动回灌重出 ${priorRetries} 次仍未过审，且当前又有新的失败反馈：同样的修正两轮没生效，继续同路径重出大概率重复失败。请先人工看片定位根因（画风/音色/构图基线问题不是回灌能修的）；确认仍要重试，请传 forceRetry: true。`,
    })
  }
  try {
    assertScriptConfirmed(shot.episode_id)
    assertNotStale(shot.episode_id, 'storyboard')
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message })
  }

  // 跨通道互斥（P2-6）：该镜可能正被某个「出片中的段」包含（段级通道不会登记本通道的锁）。
  // 不拦就会两条 H3 同时跑，两笔币都花、成片互相覆盖。
  const inSegment = shotBusyInSegmentChannel(shotId)
  if (inSegment) {
    return res.status(409).json({
      error: `该镜头属于正在出片的段（${inSegment.key}），段的成片会切片回填本镜——现在单独出片会与段级出片互相覆盖，且两笔生成费用都花掉。请等该段完成后再操作。`,
      conflict: 'segment', segmentKey: inSegment.key,
    })
  }

  const jobKey = `video-v4:${shotId}`
  if (v4VideoJobsInflight.has(jobKey)) {
    return res.status(409).json({ error: '该镜头正在出片中，请等待完成后再试' })
  }
  v4VideoJobsInflight.set(jobKey, { shotId, startedAt: Date.now(), phase: 'submitting' })

  try {
    // 风格分流（v2 起）：文戏/武戏统一锁项目画风；武戏差异只落在画面内容（物理打击/雪浪/冰晶），
    // 旧"写实物理打击双调性"已废（2026-09-12 画风统一铁律，见下方 COMBAT_STYLE_EN 注释）
    // H3 要求全英文：画风优先取英文描述（prompt_en → label_en），中文画风一律不进正文
    const project = queryOne('SELECT art_style FROM projects WHERE id = (SELECT project_id FROM episodes WHERE id = ?)', [shot.episode_id])
    const styleLabel = project?.art_style || ''
    let stylePrompt = styleLabel
    let stylePromptEn = ''
    try {
      if (styleLabel) {
        const sp = queryOne('SELECT prompt, prompt_en, label_en FROM style_presets WHERE label = ? LIMIT 1', [styleLabel])
        if (sp?.prompt) stylePrompt = sp.prompt
        stylePromptEn = String(sp?.prompt_en || '').trim() || String(sp?.label_en || '').trim()
      }
    } catch { /* 风格库缺失退回风格名 */ }
    const isCombat = resolveIsCombat(shot)
    // 武戏画风 v2（2026-09-12 画风统一铁律）：武戏不换画风。
    // 旧版"Q版角色 + photorealistic CG 巨兽双调性"实测翻车：模型拿到 photoreal CG 就把整镜拉写实，
    // 两小只也被带偏，成片"像换了部片子"（第1集 5-3~8-2 全段返工事故，见 overview.md 09-12 晚）。
    // 正确表达：巨兽的压迫感只用画面内容（体型暴涨/毛发炸立/红眼/蒸汽）+ 武戏物理（重量/惯性/雪浪/冰晶），
    // 画风始终锁在项目画风（吉卜力手绘水彩）——与出片毒词闸（assertNoStylePoison）同口径互为防线。
    // Combat LoRA 触发词（2026-09-13 查证 FourBunny 官方说明后补焊）：该 LoRA 靠触发词激活，
    // 此前 8 镜只挂 0.5 权重却没写触发词 = LoRA 基本休眠（"棉花糖打戏"根因之一）。
    // 官方口径：普通战斗 prfight1；需要明确击倒/终结收尾时追加 prfin1；prslow1 慢镜本项目不用。
    // 权重 0.5 不动（作者警告高权重=倍速感/模糊/乱打无恢复），打击感靠触发词+动作描述，不靠拉权重。
    const combatTriggers = /倒进|倒地|瘫倒|击倒|轰然倒/.test(String(shot.description || '') + String(shot.action_note || ''))
      ? 'prfight1, prfin1'
      : 'prfight1'
    // 武戏内容修饰（含触发词）走独立 combatNote 通道注入 detailed_description——
    // 不能拼进 stylePromptEn：该通道 truncateStyle 300 字截断，长战斗修饰会被整段切掉
    // （触发词 prfight1 放末尾必丢，重量感措辞也保不住，2026-09-13 查出）。
    // COMBAT_STYLE_EN 跨集通用化（2026-09-13）：抽掉第1集雪山专属词（giant bear / snowfield / snow waves /
    // ice crystals / snow bursting），只留画风铁律 + 通用武戏物理（重量/惯性/冲击/跟随）+ 泛化威胁表达。
    // 场景与角色的具体外观一律交给各镜自己的 detailed_description 写，不在此硬编码——
    // 否则第2集（森林暖绿调、零打斗、动作惊险段）会注入"雪地打熊"的错位修饰。
    const COMBAT_STYLE_EN = 'SAME hand-drawn watercolor animation art style as the reference images and the rest of the episode — never switch to any other art register or render style; grounded fight and action choreography with real weight and inertia, every impact lands with full body weight — recoil, shockwaves, debris flying on contact, fast decisive motion with follow-through, intensity and physical danger conveyed through scale, motion and physical detail, no magic aura, no energy effects, ' + combatTriggers
    const combatNote = isCombat ? COMBAT_STYLE_EN : ''
    const finalStyleEn = stylePromptEn
    const finalStyle = stylePrompt

    const parseNames = (v) => { if (!v) return []; try { const r = JSON.parse(v); return Array.isArray(r) ? r : [] } catch { return [] } }
    const charRowsAll = mergeMasterIntoEpisodeCharacters(
      query('SELECT id, name, name_en, description, description_en, image_url, audio_url FROM characters WHERE episode_id = ?', [shot.episode_id])
    )
    // ⚠️ 本行列表必须与段级路径 L804 的 scenes SELECT **逐字一致**（含末尾 lighting_en）：
    // 此前单镜漏了 lighting_en，导致单镜出片时光影常量静默丢失、两路出片光照不一致。
    // 两路同源，改一处必须改另一处（_audit_p0_dualpaths.mjs 静态断言）。
    const sceneRows = query('SELECT id, title, title_en, summary, summary_en, image_url, lighting_en FROM scenes WHERE episode_id = ?', [shot.episode_id])
    const propRows = query('SELECT id, name, name_en, description, description_en, image_url FROM props WHERE episode_id = ?', [shot.episode_id])
    // 道具表名清单（FIX-1 归一用；两路同源，见下方道具 ref 循环）
    const propTableNames = propRows.map((r) => r.name)
    // 场景名清单（R10 悬空告警用：detail 里带上候选，方便人工比对 LLM 命名差在哪）
    const sceneTitles = sceneRows.map((r) => r.title)

    // 参考图：出场角色（全量）+ 场景 + 道具，最多 9 槽（与 <Picture N> 顺序一致）
    const refs = []
    const pushRef = (label, desc, kind, image, labelEn, descEn, lightingEn) => {
      if (!image) return
      if (refs.some((r) => r.image === image)) return
      refs.push({
        label: String(label || ''), desc: String(desc || ''), kind, image,
        labelEn: String(labelEn || ''), descEn: String(descEn || ''),
        // 场景光影常量（仅 scene 槽传值）：v4Video/videoPrompt 逐字注入出片 prompt
        lightingEn: String(lightingEn || ''),
      })
    }
    for (const n of parseNames(shot.characters)) { const c = charRowsAll.find((x) => x.name === n); if (c) pushRef(c.name, c.description, 'character', c.image_url, c.name_en, c.description_en) }
    for (const sn of parseNames(shot.scene_assets)) {
      const s = sceneRows.find((x) => x.title === sn)
      // P0-2b（2026-09-18）：场景名命中的**参考图为空**也要有信号。此前 pushRef 内部
      // `if (!image) return` 静默丢弃——ep4 实测 scenes 129/132 等 4 个场景 image_url 全空，
      // 段 96–108 里 13 段出片拿不到任何场景参考图，而用户看到的只是"画面跑偏"，根因不可见。
      // 注意控制流语义不变：仍是不入 refs（拿不到图就是没得用），只是先记一条 warn。
      if (s && !String(s.image_url || '').trim()) {
        recordAlert({
          episodeId: shot.episode_id, shotId, shotNumber: shot.shot_number, source: 'sceneImage', level: 'warn',
          message: `镜 ${shot.shot_number} 的场景「${s.title}」（场景 id ${s.id}）命中场景表但尚无参考图（image_url 为空）：本镜出片拿不到该场景参考图，构图与光影只能靠模型自由发挥；请到设定页给该场景生成或上传参考图`,
          detail: JSON.stringify({ sceneId: s.id, sceneTitle: s.title, imageUrl: String(s.image_url || '') }).slice(0, 2000),
        })
        continue
      }
      if (s) pushRef(s.title, s.summary, 'scene', s.image_url, s.title_en, s.summary_en, s.lighting_en)
      // R10（2026-09-18，P1）：此前场景查不到时**完全静默**——道具侧有 propName 告警，
      // 场景侧没有 → 用户只看见"道具对不上"，场景那一半根因永远看不见（第2集实测：
      // 接受重提取的新场景名后，42 镜中 29 处场景引用悬空，全部静默）。
      // 现已对称补齐 source:'sceneName' 的 warn，文案不进 prompt，只给人看。
      else {
        recordAlert({
          episodeId: shot.episode_id, shotId, shotNumber: shot.shot_number, source: 'sceneName', level: 'warn',
          message: `镜 ${shot.shot_number} 的场景「${sn}」在场景表中无对应项（多趟 LLM 命名不一致），本镜无该场景参考图；请在设定页核对场景名`,
          detail: JSON.stringify({ raw: sn, candidates: sceneTitles }).slice(0, 2000),
        })
      }
    }
    // ⚠️ 与段级路径（buildSegmentAssets 内同名道具循环）**同源**：都用 propNameList + resolvePropName
    //    做跨层归一。两路必须写成同式，改一处必须改另一处（_audit_p0_dualpaths.mjs 守护脚本已不存在，
    //    只能靠人工保持一致）。
    for (const pn of parseNames(shot.prop_assets)) {
      const matched = resolvePropName(pn, propTableNames)
      if (!matched) {
        recordAlert({
          episodeId: shot.episode_id, shotId, shotNumber: shot.shot_number, source: 'propName', level: 'warn',
          message: `镜 ${shot.shot_number} 的道具「${pn}」在道具表中无对应项（多趟 LLM 命名不一致），本镜无该道具参考图；请在设定页核对道具名`,
          detail: JSON.stringify({ raw: pn, candidates: propTableNames }).slice(0, 2000),
        })
        continue
      }
      const p = propRows.find((x) => x.name === matched)
      if (p) pushRef(p.name, p.description, 'prop', p.image_url, p.name_en, propStateDescEn(shot, p.name, p.description_en))
    }
    // 尾帧锚（shot.frame_url2，长镜 ≥7s 生成的尾帧候选图）：本镜收尾画面的目标帧。
    // 与首帧/连续性锚配对构成官方 FL2VA 式首尾双锚（ref-en §5.3：the shot ends on <Picture N>），
    // 模型在首尾两帧之间插值连续路径，比单首帧锚强。pushRef 自带 image 去重，
    // 与 frame_url 同图时不会重复占槽。
    const frameEndUrl = String(shot.frame_url2 || '').trim()
    if (frameEndUrl) {
      pushRef('endframe', 'the target final frame of this shot', 'endframe', frameEndUrl, '', '')
    }
    // 分镜构图锚（shot.frame_url）：作为 storyboard 参考图进 refs——机位/朝向/布局由
    // 视觉锚锁死，不再只依赖 camera_angle 文字。1-1 根因：文字机位描述被角色正面参考图
    // 的视觉锚压制，模型优先复制参考图视角；storyboard 图把「目标构图」直接画给模型看。
    // （上一镜末帧接力锚已独立为 shots.continuity_url，见上方判断；旧 frame_url 含
    //  /continuity/ 路径的手动实验期机制已于 2026-09-11 数据迁移后删除）
    const frameRefUrl = String(shot.frame_url || '').trim()
    // 末帧回灌锚（shots.continuity_url）：出片成功时自动写入的上一镜成片末帧。
    const continuityUrl = String(shot.continuity_url || '').trim()
    if (continuityUrl) {
      pushRef('continuity', 'final frame of the previous shot, continuity anchor for character and environment state', 'continuity', continuityUrl, '', '')
    } else if (frameRefUrl) {
      pushRef('storyboard', 'composition reference for viewpoint and subject placement', 'storyboard', frameRefUrl, '', '')
    }
    // 全集风格锚（Sora 招，2026-09-12）：每集第一镜成片末帧——remix 语义"永远锚定第一镜"，
    // 所有后续镜头的画风/线稿/调色以此帧为准，接力链漂移到此为止。refs 满 9 时不占槽
    // （角色/帧锚保位优先级更高，风格锁还有毒词闸+COMBAT_STYLE 双保险兜底）。
    let styleAnchorUrl = ''
    try {
      styleAnchorUrl = String(queryOne('SELECT style_anchor_url FROM episodes WHERE id = ?', [shot.episode_id])?.style_anchor_url || '').trim()
    } catch { /* episodes 表缺列（迁移未跑）不拦出片 */ }
    if (styleAnchorUrl && refs.length < 9) {
      pushRef('styleanchor', 'final frame of the episode opening shot, absolute art-style anchor', 'styleanchor', styleAnchorUrl, '', '')
    }
    // h3V4 工作流只有 9 个图槽（nodeMap image0..8）：refs 超 9 必须截断，
    // 否则 prompt 里的 <Picture 10+> 悬空（模型拿不到对应参考图，绑定关系混乱）。
    // 截断顺序：场景/道具从尾部让位（文字描述兜底能力最强），角色与帧锚
    // （continuity/storyboard/endframe，台词/音色/接缝都依赖）保位到最后。
    while (refs.length > 9) {
      const dropIdx = refs.findLastIndex((r) => r.kind === 'scene' || r.kind === 'prop')
      if (dropIdx >= 0) { refs.splice(dropIdx, 1); continue }
      // 全是角色/帧锚的极端情况：硬截到 9（保前 9，prompt 与上传槽仍一致）
      refs.length = 9
    }
    // 音色：只绑「本镜真的会发声」的角色。
    // 为什么不是「所有出场的、有音色的角色」：H3 的 <Audio N> 语义是「给会发声的角色做音色锚点」。
    // 给一个全程不发声的镜头塞音色样本，等于让模型拿到一段"人声参考"却没有 <d> 指示它念什么——
    // 纯动作镜里这既无收益（不需要复刻音色），又多一分"样本语音被误播放/误引用"的风险。
    // 所以：只保留本镜 dialogue 里实际出现、且该角色有音色的槽。
    //
    // ⚠️ 判据必须与 ai/v4Video.js:159 的 vocalEvents 完全一致——那边是
    //    `who 和 text 都非空才算一次发声`。这里若只看 character 不看 text，
    //    遇到「有角色名但台词为空」的脏记录时，两边会得出不同结论（这边多传一个音色）。
    // 台词行解析走判据单点（此处原是第四份内联 JSON.parse 副本）
    const gridDlg = parseDialogue(shot.dialogue)
    const speakingNames = new Set(
      gridDlg
        .filter((d) => cleanText(d?.text || d?.line || d?.content)) // 与 vocalEvents 同判据：无台词文本不算发声
        .map((d) => cleanText(d?.character || d?.speaker || d?.name))
        .filter(Boolean)
    )
    const audioRefs = []
    for (const c of charRowsAll) {
      if (!speakingNames.has(c.name)) continue // 本镜不发声 → 不传音色
      const idx = refs.findIndex((r) => r.kind === 'character' && r.label === c.name)
      if (idx >= 0 && c.audio_url) audioRefs.push({ subjectNum: idx + 1, label: c.name, audio: c.audio_url })
    }

    // ── Motion Context 续镜（音频连贯 #1，2026-09-11）──
    // 反查本集内上一镜成片：有 → 传 prevVideoUrl 走 h3V4mc（上一镜成片回喂，
    // context_frames/context_audio 锚定动态+音色接缝；latent 跨任务被 RH 容器隔离判死，
    // fc 成片回喂是唯一存活路线，见 AGENTS.md 音频连贯段）。
    // 开关优先级：单镜显式 useMotionContext（true/false）> 全局 config.runninghub.motionContext.enabled；
    // 上一镜不存在（首镜/前镜未出片）或 prevVideoUrl 上传失败时自动降级普通出片，不报错。
    // 反查口径与 relayLastFrameToNextShot 的 nextShot 查询同源反向（episode 内 start_time 倒序取最近一镜）。
    // 反查上一镜（含场次号——跨场判定用）：episode 内 start_time 倒序取最近一镜。
    // 2026-09-14 起反查无条件执行（原先只在 mcWanted 时查）：crossScene 判定在开关之前。
    const prevShot = queryOne(
      `SELECT s.id AS prev_id, s.video_url AS prev_video, ss.scene_number AS prev_scene
       FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id
       WHERE ss.episode_id = ? AND s.id != ? AND s.start_time < ?
         AND s.video_url IS NOT NULL AND s.video_url != '' AND s.video_generated = 1
       ORDER BY s.start_time DESC, s.id DESC LIMIT 1`,
      [shot.episode_id, shotId, Number(shot.start_time) || 0]
    )
    // 跨场判定 + 镜型分流（mcPolicy.js，宪法第五条机读层）：
    // 跨场（换场跳切）MC 硬关——上一场画面/环境音不该带进下一场，显式 true 也不开
    //（2026-09-11 的 2-1→3-1 场次盲硬接事故，从手工断锚升级为代码层根治）。
    const crossScene = prevShot
      ? Number(prevShot.prev_scene) !== Number(shot.scene_number)
      : false
    const mcPolicy = resolveMc({
      explicit: useMotionContext,
      globalEnabled: config.runninghub.motionContext.enabled === true,
      crossScene,
    })
    const mcWanted = mcPolicy.wanted
    if (mcPolicy.reason === 'cross-scene') {
      // 设计行为不是故障：不进告警，日志+响应说明即可（否则每个场次首镜都亮角标，噪音）
      console.log(`[/generate/video-v4] MC 跨场自动关：shot ${shotId}（场 ${shot.scene_number}）上一镜 shot ${prevShot.prev_id}（场 ${prevShot.prev_scene}）——换场跳切按设计不接龙`)
    }
    let prevVideoUrl = ''
    let mcDegradeNote = ''
    if (mcWanted) {
      if (prevShot?.prev_video) {
        prevVideoUrl = prevShot.prev_video
        console.log(`[/generate/video-v4] MC 续镜：shot ${shotId} 接上一镜 shot ${prevShot.prev_id} 成片 ${prevVideoUrl}`)
      } else {
        // MC 静默断链可见化（2026-09-12：曾整批 28 次出片全员降级而无人察觉）。
        // 首镜（本集内 start_time 最小）没有上一镜是天经地义，不告警；非首镜查不到才喊。
        const hasAnyPrev = queryOne(
          `SELECT s.id FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id
           WHERE ss.episode_id = ? AND s.id != ? AND s.start_time < ? LIMIT 1`,
          [shot.episode_id, shotId, Number(shot.start_time) || 0]
        )
        if (hasAnyPrev) {
          mcDegradeNote = 'MC 续镜未生效：上一镜尚无成片（或未完成回写），本镜按普通版出片，接缝不保证连贯'
          console.warn(`[/generate/video-v4] shot ${shotId} ${mcDegradeNote}`)
          // 持久化可见（2026-09-13）：出片响应里的 warning 是一次性的，批量出片时容易被刷过去；
          // 落一条 warn 告警，前端镜头卡片亮角标。非致命（成片仍会出），故 warn 不 error。
          recordAlert({ episodeId: shot.episode_id, shotId, shotNumber: shot.shot_number, source: 'mc', level: 'warn',
            message: `镜 ${shot.shot_number} MC 续镜未生效（上一镜无成片/回写未完成），本镜按普通版出片：接缝连贯性不保证` })
        }
      }
    }

    // 闭环回灌（2026-09-12，Character.ai eval-in-the-loop）：上次观片验收 fail 的修正指令
    // （shotReview 写入 shots.retry_feedback），重出时译成英文注入 prompt 的 detailed_description。
    // 通路：fail → 写反馈 → 人触发重出 → 注入 MANDATORY CORRECTION → 出片成功清零。
    let retryNote = ''
    const rawFeedback = String(shot.retry_feedback || '').trim()
    if (rawFeedback && rawFeedback !== 'null') {
      try {
        const fb = JSON.parse(rawFeedback)
        const items = [
          ...(Array.isArray(fb.missingBeats) ? fb.missingBeats : []).map((b) => `剧本节拍未演出：${String(b)}`),
          ...(Array.isArray(fb.issues) ? fb.issues.slice(0, 3) : []),
        ]
        if (items.length) {
          const en = await chatCompletion([
            { role: 'system', content: 'Translate the following Chinese film-direction correction notes into concise English imperatives for an AI video generation model (e.g. "the bear collapses into the snow; the red glow fades from its eyes"). Output ONLY the English sentences joined by semicolons, no preamble.' },
            { role: 'user', content: items.join('\n') },
          ], { temperature: 0.2, maxTokens: 400, disableThinking: true })
          // R14（2026-09-18）：译文**注入前**先过 shared.pickInjectableEnglish——删残 CJK +
          //  要求「至少含一个 ASCII 字母」。
          //  QA 实测漏洞：中文观片反馈被翻成英文后只剩 ',;'（半角标点）时，字面既不含任何
          //  中日韩字符（stripResidualCjk 原样返回）、也非空（truthy），旧守卫放行 →
          //  prompt 里多出一句 `MANDATORY CORRECTION: ,;` 空壳——它不含任何可执行指令，
          //  却占掉模型注意力，等于给英文正文塞噪声。
          //  判据单点在 ai/shared.js 的 pickInjectableEnglish，本处禁止就地抄正则。
          const retryNoteEn = pickInjectableEnglish(en)
          retryNote = retryNoteEn
          if (!retryNoteEn) {
            console.warn(`[/generate/video-v4] shot ${shotId} 验收回灌译文删除残留中文后为空壳（无实质英文指令），本次不注入`)
          } else {
            console.log(`[/generate/video-v4] shot ${shotId} 注入验收失败回灌（第 ${1 + (Number(shot.retry_count) || 0)} 次重试）: ${retryNoteEn.slice(0, 120)}`)
          }
        }
      } catch { /* 反馈解析失败不拦出片 */ }
    }

    const prompt = await buildShotVideoPromptV4(shot, { stylePrompt: finalStyle, stylePromptEn: finalStyleEn, refs, audioRefs, isCombat, speakerIds: episodeSpeakerIds(shot), retryNote, combatNote })

    // 采样层策略：武戏动作密度高→保留二采精修；文戏仅远景/全身（脸小）才需二采提分辨率保脸，
    // 近景/中景/特写把二采降级为 1 步 + 近似零降噪 + 不放大，省掉约 3/4 的二采算力。
    // 精确匹配整串：旧写法 /全景|远景|.../ 是子串匹配，「中全景」会误命中"全景"——
    // 中全景脸并不小，按设计意图不该走二采；且误命中导致相邻镜 1MP/0.5MP 交替跳变
    // （1-1 中全景 768×1376 vs 2-1 中景 544×960 的实锤跳变即由此产生）。
    const WIDE_SHOT_RE = /^(大全景|全景|大远景|远景|全身|广角)$/
    // ⚠️ 有台词镜必须保留完整二采（2026-09-11 实锤）：二采（4 步/0.4 降噪）是音色克隆
    // 生效的必要条件——降级二采（1 步/0.01 近似无操作）会让 <Audio N> 音色条件欠收敛，
    // 模型绕开样本自合成声音。证据链：85 的 9 个历史版本 F0 纵向对比（全二采期 333-438Hz
    // ≈一二样本 372Hz；降级期 296-533Hz 全偏）+ 4s 对照实验（完整二采 F0=276Hz ≈布布样本 286Hz）。
    // 代价：台词镜二采放大到 1MP，单镜成本回升，但音色正确不可省。
    // secondPass 可手动强制：'on' 强制二采（要清晰度）、'off' 强制跳过（要省钱，台词镜慎用——会丢音色），默认 auto 按戏型+景别+有无台词判
    const needSecondPass =
      secondPass === 'on' ? true
      : secondPass === 'off' ? false
      : (isCombat || WIDE_SHOT_RE.test(String(shot.shot_type || '')) || audioRefs.length > 0)
    const firstMegapixels = megapixels || '0.5'
    const sampling = needSecondPass
      ? { firstPassSteps: 6, firstPassDenoise: 1, secondPassSteps: 4, secondPassDenoise: 0.4, upscaleMegapixels: 1 }
      : { firstPassSteps: 6, firstPassDenoise: 1, secondPassSteps: 1, secondPassDenoise: 0.01, upscaleMegapixels: firstMegapixels }

    const result = await generateShotVideoV4(
      { shotId: String(shotId), prompt, refs, audioRefs: audioRefs.map((a) => a.audio), aspectRatio, megapixels, duration: duration ?? shot.duration, combatLoraStrength: isCombat ? '0.5' : '0', seed: seed != null ? seed : undefined, ...sampling, prevVideoUrl: prevVideoUrl || undefined },
      // phase/taskId 回写 inflight（2026-09-16）：此前只 console.log，inflight 永远显示
      // "submitting"、拿不到 RH taskId——误触发想取消都没有抓手（实测踩坑：测试请求
      // 真实提交后只能干等）。与 segment 路由同款：taskId 进 job，GET inflight 透出。
      { onProgress: (phase, info) => {
        const j = v4VideoJobsInflight.get(jobKey)
        if (j) {
          j.phase = String(phase || '')
          if (info?.taskId) j.taskId = String(info.taskId)
        }
        console.log(`[/generate/video-v4] shot ${shotId} ${phase}${info?.message ? ': ' + info.message : ''}`)
      } }
    )

    if (result.success && result.videoUrl) {
      // 本地化补救（2026-09-14）：v4Video 内部下载偶发失败会降级返回云端裸 URL——
      // 直接落库的后果是连环坑：钩子链（接力/接缝/观片）全依赖本地文件 → 全灭；
      // RH 的 COS 裸 URL 实测 1 小时内 404（1-2/2-2 两镜成片即此丢失）→ 成片永久丢。
      // 这里在回写前做最后一道补救：远程 URL → 带重试下载落本地；仍失败才保留远程 URL
      // 并写 error 告警（此时须尽快手动本地化，晚于 ~1 小时即无法挽回）。
      if (!/^\/uploads\//i.test(result.videoUrl)) {
        const localName = `shot_${shotId}_v4_${Date.now()}.mp4`
        const localPath = path.join(uploadsDir, localName)
        let localized = false, lastErr = null
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const buf = await insecureDownload(result.videoUrl)
            if (!isPlausibleMp4(buf)) throw new Error(`下载内容不是有效 mp4（${buf ? buf.length : 0} 字节，疑为错误页/残片）`)
            fs.writeFileSync(localPath, buf)
            console.log(`[/generate/video-v4] shot ${shotId} 云端成片已本地化 → /uploads/${localName}（第 ${attempt} 次）`)
            localized = true
            break
          } catch (e) {
            lastErr = e
            console.warn(`[/generate/video-v4] shot ${shotId} 成片本地化第 ${attempt} 次失败:`, e.message)
            if (attempt < 3) await new Promise((r) => setTimeout(r, 3000 * attempt))
          }
        }
        if (localized) {
          result.videoUrl = `/uploads/${localName}`
        } else if (result.taskId) {
          // 备用输出节点自动捞（2026-09-14）：主 URL 3 次下载失败后不直接放弃——
          // RH 任务常有多个输出节点（如 h3V4 的 2001 主视频 + 245 音轨合成版），
          // 主节点 COS 链接 404 时备用节点往往仍可下载（9-14 实锤：2-2 的 2001 404、245 完好）。
          // 逐个尝试全部 results，带最小体积校验（>10KB，防把 XML 错误页存成 mp4）。
          try {
            const q = await queryTaskOutput(result.taskId)
            const altUrls = (Array.isArray(q?.allResults) ? q.allResults : [])
              .map((r) => String(r?.url || '')).filter(Boolean)
              .filter((u) => u !== result.videoUrl)
            console.log(`[/generate/video-v4] shot ${shotId} 主 URL 下载失败，尝试备用节点（${altUrls.length} 个）`)
            for (const u of altUrls) {
              try {
                const buf = await insecureDownload(u)
                if (!isPlausibleMp4(buf)) continue
                fs.writeFileSync(localPath, buf)
                console.log(`[/generate/video-v4] shot ${shotId} 备用节点下载成功 → /uploads/${localName}（${(buf.length / 1048576).toFixed(1)}MB）`)
                localized = true
                break
              } catch { /* 该节点也失败，继续下一个 */ }
            }
          } catch (e) {
            console.warn(`[/generate/video-v4] shot ${shotId} 备用节点查询失败:`, e.message)
          }
          if (localized) {
            result.videoUrl = `/uploads/${localName}`
          } else {
            recordAlert({ episodeId: shot.episode_id, shotId, shotNumber: shot.shot_number, source: 'writeback', level: 'error',
              message: `镜 ${shot.shot_number} 成片本地化失败（3 次重试 + 备用节点全灭）：video_url 仍是云端 URL——已登记打捞队列，后台每 5 分钟自动重捞（50 分钟窗口）`,
              detail: lastErr })
            enqueueSalvage({ shotId, shotNumber: shot.shot_number, episodeId: shot.episode_id, taskId: result.taskId, url: result.videoUrl })
          }
        } else {
          recordAlert({ episodeId: shot.episode_id, shotId, shotNumber: shot.shot_number, source: 'writeback', level: 'error',
            message: `镜 ${shot.shot_number} 成片本地化失败（3 次重试耗尽）：video_url 仍是云端 URL——已登记打捞队列，后台每 5 分钟自动重捞（50 分钟窗口）`,
            detail: lastErr })
          enqueueSalvage({ shotId, shotNumber: shot.shot_number, episodeId: shot.episode_id, taskId: null, url: result.videoUrl })
        }
      }
      // 闭环回灌清零：本次重出成功 → 清 retry_feedback（下一轮观片闸重新判定），累计重试次数
      // （2026-09-13 修复：占位符 3 个参数曾给 4 个（多塞一个 shotId），better-sqlite3 必抛
      // RangeError 导致回写静默失败——5-3/5-4 两镜"钩子全灭"的根因，勿再改回）
      // 回写单独 try/catch：这条 UPDATE 一挂，下游接力/接缝/观片【全部】拿不到 video_url 而连带失败，
      // 是最危险的单点。显式记一条 error 告警，让"成片在云端但库里没回写"当场可见（钱花了、验不了）。
      // FIX-3（2026-09-18，P1-Q3）：回写失败**不再向上抛**。云端出片已成功且已计费，若把它当
      // "出片失败"返 500，用户极易重复点击出片 → 重复烧钱。改为：保留 error 级告警（文案明确
      // "请勿重复出片"），并把 warning 透传到响应体（success 仍为 true）。
      let wbWarning = ''
      let wbErrCaught = null
      try {
        // shot_review 一并清空（锁5 配套）：成片已换，旧观片结论对旧帧失效——观片闸会对新成片
        // 重新判定。不清会让锁5 拿旧 fail 假拦截刚重生完的镜头。
        execute('UPDATE shots SET video_url = ?, video_generated = 1, retry_feedback = \'\', shot_review = NULL, retry_count = COALESCE(retry_count, 0) + CASE WHEN ? != \'\' THEN 1 ELSE 0 END WHERE id = ?', [result.videoUrl, rawFeedback, shotId])
      } catch (wbErr) {
        wbErrCaught = wbErr
        wbWarning = `回写失败：成片已生成（地址：${result.videoUrl}）+ 数据库回写失败，请勿重复出片，需人工排查`
      }
      console.log('[/generate/video-v4] saved video_url for shot', shotId, result.videoUrl)
      // 新成片已落库 → 清掉本镜的历史告警（旧告警描述的是上一版成片的断链，成片已换结论失效；
      // 口径同 relayLastFrameToNextShot「锚帧一换旧 seam_check 即失效」）。随后各钩子若再失败会重新写入。
      // ⚠️ 顺序刻意如此（FIX-3）：本清理按 shotId **批量清空未处置告警**，若把本次「回写失败」告警
      //    写在它之前，会被自己顺手清掉 → 告警静默消失。故先批量清旧、再补写回写失败告警。
      const clearedAlerts = resolveAlertsByShot(shotId, 'regen')
      if (clearedAlerts) console.log(`[/generate/video-v4] shot ${shotId} 重生成功，清掉 ${clearedAlerts} 条旧告警`)
      if (wbWarning) {
        recordAlert({ episodeId: shot.episode_id, shotId, shotNumber: shot.shot_number, source: 'writeback', level: 'error',
          message: `镜 ${shot.shot_number} ${wbWarning}`,
          detail: wbErrCaught })
      }
      // ── 后置钩子链（全部 fire-and-forget，失败不影响成片，但必须可见）──
      // 2026-09-13 改造：每个钩子的 .catch 从「只 console.warn」升级为「写 system_alerts」。
      // 背景：这四项原本失败只落一行日志，批量出片时无人可见，导致「成片在但验收链全灭」
      // 长期静默（v4 回写 RangeError 事故即此，四项全灭而无人知）。现前端镜头卡片亮红角标。
      const alertCtx = { episodeId: shot.episode_id, shotId, shotNumber: shot.shot_number }

      // 末帧自动接力（布哥 2026-09-11：按出片即接力，不增加手动步骤）：
      // 抽本镜成片末帧写入下一镜 continuity_url，下一镜出片时以官方帧锚定开场。
      // fire-and-forget：失败只记日志+告警，绝不影响出片主流程；重新出片会幂等覆盖。
      relayLastFrameToNextShot({ ...shot, video_url: result.videoUrl })
        .then((r) => {
          console.log(`[/generate/video-v4] shot ${shotId} 末帧已自动接力 → 下一镜 ${r.nextShotNumber || r.nextShotId}`)
          // 首镜时顺手把末帧存为全集风格锚（Sora 招：永远锚定第一镜）
          return anchorEpisodeStyle({ ...shot, video_url: result.videoUrl })
        })
        .then((a) => { if (a) console.log(`[/generate/video-v4] shot ${shotId} 是全集首镜，风格锚已更新: ${a}`) })
        .catch((e) => {
          // 「本集最后一镜」是正常终止态（没有下一镜可接力），不告警，避免每集收尾误报
          const lastShot = /最后一镜|没有下一镜/.test(String(e.message || ''))
          if (!lastShot) {
            recordAlert({ ...alertCtx, source: 'relay', level: 'error', message: `镜 ${shot.shot_number} 末帧自动接力失败：下一镜将以无锚开场（接缝连贯性不保证），需手动补接力`, detail: e })
          }
          console.warn(`[/generate/video-v4] shot ${shotId} 末帧自动接力失败（不影响成片）:`, e.message)
        })
      // 衔接质量自动检测（#3，2026-09-11）：本镜出片用了 continuity 锚（上一镜末帧）时，
      // 抽本镜成片首帧与锚帧比色温/亮度，超阈值写 shots.seam_check，前端镜头卡片标红。
      // fire-and-forget 同上；构图差仅记录不参与告警（跨镜重新取景合法）。
      // 时序安全：本镜 continuity_url 是上一镜接力写的，本镜出片后的接力只写【下一镜】的锚，不冲突。
      if (String(shot.continuity_url || '').trim()) {
        checkSeam({ ...shot, video_url: result.videoUrl })
          .then((r) => console.log(`[/generate/video-v4] shot ${shotId} 衔接检测: CCT差${r.cctDiffK ?? 'n/a'}K / 亮度差${r.lumaDiff} / 构图差${r.hashDist}/64 ${r.alert ? '⚠️ 超阈值，镜头卡片已标红' : 'OK'}`))
          .catch((e) => {
            recordAlert({ ...alertCtx, source: 'seam', level: 'error', message: `镜 ${shot.shot_number} 衔接质量检测失败：本镜接缝质量未知（无色温/亮度结论），上游告警可能漏拦，需手动重检`, detail: e })
            console.warn(`[/generate/video-v4] shot ${shotId} 衔接检测失败（不影响成片）:`, e.message)
          })
      } else {
        // 开场镜色向闸（锁3，2026-09-12）：无锚可比的镜（每集首镜/换场首镜），
        // 拿首帧 R-B 对色调家族带宽——它们是接力链色调源头，跑偏必须当场抓住，
        // 否则锁2 会把错误色调接力放大到全场景。fire-and-forget 口径同上。
        checkOpenerTone({ ...shot, video_url: result.videoUrl })
          .then((r) => console.log(`[/generate/video-v4] shot ${shotId} 开场色向闸: R-B=${r.rb} 带宽[${r.band.rbMin},${r.band.rbMax}] ${r.alert ? '⚠️ 色调跑偏，镜头卡片已标红' : 'OK'}`))
          .catch((e) => {
            recordAlert({ ...alertCtx, source: 'openerTone', level: 'error', message: `镜 ${shot.shot_number} 开场色向闸失败：色调跑偏未被把关（此镜是接力链色调源头，跑偏会顺锚放大到下游），需手动重检`, detail: e })
            console.warn(`[/generate/video-v4] shot ${shotId} 开场色向闸失败（不影响成片）:`, e.message)
          })
      }
      // VLM 观片闸（2026-09-12 满分路线图第一级）：抽 5 帧交视觉大模型当第一观众，
      // 评情绪/一拍一镜/台词对脸/AI味穿帮，结果写 shots.shot_review（独立列，不进 409 拦截）。
      // 模型未配置/额度耗尽时失败——这是「第一观众缺席」，属 error 级告警（不能静默当通过）。
      reviewShot({ ...shot, video_url: result.videoUrl })
        .then((r) => console.log(`[/generate/video-v4] shot ${shotId} 观片闸: 均分${r.avgScore} [${r.verdict}] ${r.summary}`))
        .catch((e) => {
          const notConfigured = /未配置/.test(String(e.message || ''))
          recordAlert({
            ...alertCtx, source: 'review', level: notConfigured ? 'warn' : 'error',
            message: `镜 ${shot.shot_number} 观片闸未出结论：${notConfigured ? 'VLM 模型未配置（配置后可用 POST /generate/shot-review 补评）' : '评审调用失败，本镜无第一观众结论，需人工看片或补评'}`,
            detail: e,
          })
          console.warn(`[/generate/video-v4] shot ${shotId} 观片闸跳过（不影响成片）:`, e.message)
        })
      res.json({ success: true, url: result.videoUrl, taskId: result.taskId, warning: [result.warning, mcDegradeNote, wbWarning].filter(Boolean).join('；') || '', alertsCleared: clearedAlerts })
    } else {
      res.json({ success: false, error: result.error || '出片失败', taskId: result.taskId })
    }
  } catch (err) {
    console.error('[/generate/video-v4] error', { shotId, error: err.message })
    res.status(500).json({ error: err.message })
  } finally {
    v4VideoJobsInflight.delete(jobKey)
  }
})

// ===== 段级出片（E 路线 v2，2026-09-15）=====
// 一段一次生成（段内 N 镜拼成一个 H3 任务），成片落 video_segments，
// **出片成功后自动按镜边界切片回填 shots.video_url**（解决"同段多镜卡片播同一视频"）。
//
// 与 /video-v4 的关系：
//   · prompt 走 buildSegmentVideoPrompt（段级：detailed_description 内多个 [Shot N] 切点）
//   · 资产组装（refs/audioRefs/风格/戏型）与单镜**同源同口径**，不另造一份
//   · 不接 MC（段级与 MC 互斥：MC 会重演上一镜尾部 ~22 帧，与段内切点冲突，见 mcPolicy.js）
//   · 不跑锁4/锁5 的单镜告警链（那是镜级接力机制的护栏）；段级的镜子关系靠段内切点，
//     但**切片回填后**下游镜自己的出片仍会走单镜通道的完整护栏，护栏不失效
//
// ===== 出片互斥锁：跨通道统一视图（2026-09-16 审核修复 P2-6）=====
//
// 问题：出片有三条通道，各自一套内存锁，key 空间互不相通——
//   · /video-v4      → `video-v4:{shotId}`（v4VideoJobsInflight）
//   · /video-segment → `video-segment:{segmentId}`（segmentJobsInflight）
//   · /video-v3      → `videoV3:{shotId}`（v3VideoJobsInflight）
// 于是「同一镜」可同时经单镜通道与段级通道出片（段只锁段、单镜只锁镜）→ 两条 H3 都在跑，
// **两笔币都花**，最后 last-write-wins 互相覆盖成片，用户以为只出了一次。
//
// 修法：不上一把大锁（会误伤"同段内不同镜并行出片"这类合法并发），而做**按镜交叉判定**：
//   · 单镜通道：该镜是否正被某个出片中的段包含
//   · 段级通道：段内是否有任一镜正被单镜通道出片
// 三个 Map 都在本文件内（v3 的声明在下方，但函数在**调用时**才求值，闭包晚绑定无问题）。
const VIDEO_JOB_STALE_MS = 30 * 60 * 1000 // 与各通道既有 STALE_MS 同值

/** 该镜是否正被单镜通道（v4 / v3）出片；顺带清掉过期条目 */
function shotBusyInShotChannels(shotId) {
  const now = Date.now()
  for (const [key, map] of [[`video-v4:${shotId}`, v4VideoJobsInflight], [`videoV3:${shotId}`, v3VideoJobsInflight]]) {
    const j = map.get(key)
    if (!j) continue
    if (now - j.startedAt > VIDEO_JOB_STALE_MS) { map.delete(key); continue }
    return { key, job: j }
  }
  return null
}

/** 该镜是否正被段级通道出片（看各出片段任务的镜集合是否含它） */
function shotBusyInSegmentChannel(shotId) {
  const now = Date.now()
  for (const [key, job] of segmentJobsInflight) {
    if (now - job.startedAt > VIDEO_JOB_STALE_MS) { segmentJobsInflight.delete(key); continue }
    if (!Array.isArray(job.shotIds)) continue
    if (job.shotIds.some((id) => Number(id) === Number(shotId))) return { key, job }
  }
  return null
}

/** 段内是否有任一镜正被单镜通道出片 */
function segmentBusyInShotChannels(shotIds) {
  for (const sid of shotIds || []) {
    const hit = shotBusyInShotChannels(sid)
    if (hit) return { shotId: Number(sid), ...hit }
  }
  return null
}

// 幂等：同一段 inflight 锁；切片阶段可重复跑（已切过的镜跳过重编码）
const segmentJobsInflight = new Map()

/**
 * 启动复位僵尸段（2026-09-16 审核修复 P1-5）。
 *
 * 为什么需要：段出片是**同步长跑**（H3 可达 20 分钟），进行中会把 video_segments.status 置 'running'
 * 并登记内存 inflight。进程被杀/崩溃/重启时，内存 Map 随进程消失，**库里却永远停在 running**：
 *   · 前端「出片中…」永不结束，用户以为还在跑；
 *   · 旧闸门只查内存锁 → 重启后可重复提交同一段，双倍烧币；
 *   · 该段既不能被重出，也不会自然收敛（没有进程在轮询它）。
 * 重启时把所有 running 段复位为 failed 并写明原因——**宁让用户手动重出，也不留静默死锁**。
 * 只在启动期调用（此时内存 inflight 必为空，不存在"复位掉正在跑的任务"的风险）。
 *
 * @returns {number} 复位的段数
 */
export function resetZombieSegments() {
  try {
    const zombies = query("SELECT id, shot_numbers FROM video_segments WHERE status = 'running'")
    if (!zombies.length) return 0
    execute(
      "UPDATE video_segments SET status = 'failed', error = ? WHERE status = 'running'",
      ['出片被中断（服务重启/进程退出）：状态已复位，请重新出片']
    )
    for (const z of zombies) {
      console.warn(`[generate/video-segment] 启动复位僵尸段 ${z.id}（${z.shot_numbers || ''}）：running → failed`)
    }
    return zombies.length
  } catch (e) {
    // 复位失败不能拖垮启动
    console.warn('[generate/video-segment] 僵尸段复位失败（不影响启动）:', e?.message || e)
    return 0
  }
}

router.get('/video-segment/inflight', (req, res) => {
  res.json({ inflight: [...segmentJobsInflight.values()] })
})

// 紧急刹车（2026-09-15）：取消正在出片的段任务——调 RunningHub 云端 cancel，**停止 GPU 计费**。
// taskId 依赖 onProgress 捕获（runWorkflowImpl 会把 taskId 抛给 onProgress info），
// 旧进程发起的任务拿不到 taskId，只能等它自然结束（RunningHub 无"列出账户任务"的接口，无法事后定位）。
// 取消后本地轮询会在下一次查询感知到云端失败状态，自然收敛为 video_segments.status='failed'。
router.post('/video-segment/cancel', async (req, res) => {
  const segmentId = Number(req.body?.segmentId)
  const job = [...segmentJobsInflight.values()].find((j) => j.segmentId === segmentId)
  if (!job) return res.status(404).json({ error: `段 ${segmentId} 没有正在进行的出片任务` })
  if (!job.taskId) return res.status(409).json({ error: '该任务的 taskId 未捕获（旧进程发起或尚未提交成功），无法云端取消，只能等它自然结束' })
  const { cancelTask } = await import('../ai/runninghub.js')
  const ok = await cancelTask(job.taskId)
  if (!ok) return res.status(500).json({ error: `RunningHub 取消失败（taskId=${job.taskId}），可能任务已完成或已不在队列` })
  job.phase = 'cancelling'
  res.json({ success: true, taskId: job.taskId, note: '云端任务已请求取消；本地轮询感知到失败状态后自动收敛，成片不会回灌' })
})

/**
 * 组装段级出片的 refs / audioRefs / 风格 / 戏型。
 * 与 /video-v4 的组装逻辑同口径——以段内**所有镜的资产并集**为准（段内任一镜出场的
 * 角色/场景/道具都要进参考槽，否则该镜拍出来角色丢了）。
 * 本模块与单镜通道共用「按镜并集 → 去重 → 9 槽截断」规则，槽位顺序按首次出场决定。
 */
function buildSegmentAssets(seg, shots) {
  const episodeId = seg.episode_id
  const project = queryOne('SELECT art_style FROM projects WHERE id = (SELECT project_id FROM episodes WHERE id = ?)', [episodeId])
  const styleLabel = project?.art_style || ''
  let stylePrompt = styleLabel
  let stylePromptEn = ''
  try {
    if (styleLabel) {
      const sp = queryOne('SELECT prompt, prompt_en, label_en FROM style_presets WHERE label = ? LIMIT 1', [styleLabel])
      if (sp?.prompt) stylePrompt = sp.prompt
      stylePromptEn = String(sp?.prompt_en || '').trim() || String(sp?.label_en || '').trim()
    }
  } catch { /* 风格库缺失退回风格名 */ }

  const parseNames = (v) => { if (!v) return []; try { const r = JSON.parse(v); return Array.isArray(r) ? r : [] } catch { return [] } }
  const charRowsAll = mergeMasterIntoEpisodeCharacters(
    query('SELECT id, name, name_en, description, description_en, image_url, audio_url FROM characters WHERE episode_id = ?', [episodeId])
  )
  // ⚠️ 本行列表必须与单镜路径 L308 的 scenes SELECT **逐字一致**（两路同源，改一处必须改另一处）：
  // 单镜此前漏了 lighting_en（2026-09-17 已补齐对齐），_audit_p0_dualpaths.mjs 有静态断言。
  const sceneRows = query('SELECT id, title, title_en, summary, summary_en, image_url, lighting_en FROM scenes WHERE episode_id = ?', [episodeId])
  const propRows = query('SELECT id, name, name_en, description, description_en, image_url FROM props WHERE episode_id = ?', [episodeId])
  // 道具表名清单（FIX-1 归一用；与单镜路径同源）
  const propTableNames = propRows.map((r) => r.name)
  // 场景名清单（R10 悬空告警用；与单镜路径同源）
  const sceneTitles = sceneRows.map((r) => r.title)

  const refs = []
  const pushRef = (label, desc, kind, image, labelEn, descEn, lightingEn) => {
    if (!image) return
    if (refs.some((r) => r.image === image)) return
    refs.push({
      label: String(label || ''), desc: String(desc || ''), kind, image,
      labelEn: String(labelEn || ''), descEn: String(descEn || ''),
      lightingEn: String(lightingEn || ''),
    })
  }
  // 段内镜序（播放序）依次收集，首次出场定槽位
  const speakingNames = new Set()
  for (const sh of shots) {
    for (const n of parseNames(sh.characters)) {
      const c = charRowsAll.find((x) => x.name === n)
      if (c) pushRef(c.name, c.description, 'character', c.image_url, c.name_en, c.description_en)
    }
    for (const sn of parseNames(sh.scene_assets)) {
      const s = sceneRows.find((x) => x.title === sn)
      // P0-2b（2026-09-18）：段级同款——pushRef 内部 `if (!image) return` 会把「名命中但图为空」
      // 静默吞掉。段是一次性出 2~3 镜、一次性花币，比单镜更需要有痕可查，故与单镜路径同式告警。
      // 控制流语义不变：仍不入 refs。
      if (s && !String(s.image_url || '').trim()) {
        recordAlert({
          episodeId, shotId: sh.id, shotNumber: sh.shot_number, source: 'sceneImage', level: 'warn',
          message: `镜 ${sh.shot_number} 的场景「${s.title}」（场景 id ${s.id}）命中场景表但尚无参考图（image_url 为空）：本段出片拿不到该场景参考图，构图与光影只能靠模型自由发挥；请到设定页给该场景生成或上传参考图`,
          detail: JSON.stringify({ sceneId: s.id, sceneTitle: s.title, imageUrl: String(s.image_url || '') }).slice(0, 2000),
        })
        continue
      }
      if (s) pushRef(s.title, s.summary, 'scene', s.image_url, s.title_en, s.summary_en, s.lighting_en)
      // R10（2026-09-18，P1）：与单镜路径对称——此前此处是 `if (s) pushRef(...)` 无任何 else，
      //   场景名悬空时零可见信号（段级一次性出 2~3 镜，用户更难察觉）。补齐同式 warn。
      else {
        recordAlert({
          episodeId, shotId: sh.id, shotNumber: sh.shot_number, source: 'sceneName', level: 'warn',
          message: `镜 ${sh.shot_number} 的场景「${sn}」在场景表中无对应项（多趟 LLM 命名不一致），本段无该场景参考图；请在设定页核对场景名`,
          detail: JSON.stringify({ raw: sn, candidates: sceneTitles }).slice(0, 2000),
        })
      }
    }
    // ⚠️ 与单镜路径（/video-v4 的道具 ref 循环）**同源**：都用 propTableNames + resolvePropName
    //    做跨层归一。两路必须写成同式，改一处必须改另一处（_audit_p0_dualpaths.mjs 守护脚本已不存在，
    //    只能靠人工保持一致）。
    for (const pn of parseNames(sh.prop_assets)) {
      const matched = resolvePropName(pn, propTableNames)
      if (!matched) {
        recordAlert({
          episodeId, shotId: sh.id, shotNumber: sh.shot_number, source: 'propName', level: 'warn',
          message: `镜 ${sh.shot_number} 的道具「${pn}」在道具表中无对应项（多趟 LLM 命名不一致），本段无该道具参考图；请在设定页核对道具名`,
          detail: JSON.stringify({ raw: pn, candidates: propTableNames }).slice(0, 2000),
        })
        continue
      }
      const p = propRows.find((x) => x.name === matched)
      if (p) pushRef(p.name, p.description, 'prop', p.image_url, p.name_en, propStateDescEn(sh, p.name, p.description_en))
    }
    // 段内所有镜的台词角色都算发声者（音色槽按并集）
    // 段内台词收集走判据单点（此处原是内联 JSON.parse 副本）：含 "null" / 脏 JSON 一律得 []
    const dlg = parseDialogue(sh.dialogue)
    for (const d of dlg) {
      const who = cleanText(d?.character || d?.speaker || d?.name)
      const text = cleanText(d?.text || d?.line || d?.content)
      if (who && text) speakingNames.add(who)
    }
  }

  // 段间接力锚：上一段成片末帧（anchorMode='prev-segment-last'）
  if (seg.anchor_frame_url) {
    pushRef('continuity', 'final frame of the previous segment, continuity anchor for character and environment state', 'continuity', seg.anchor_frame_url, '', '')
  }
  // 全集风格锚（与单镜同规则，refs 满 9 时让位）
  let styleAnchorUrl = ''
  try {
    styleAnchorUrl = String(queryOne('SELECT style_anchor_url FROM episodes WHERE id = ?', [episodeId])?.style_anchor_url || '').trim()
  } catch { /* 缺列不拦 */ }
  if (styleAnchorUrl && refs.length < 9) {
    pushRef('styleanchor', 'final frame of the episode opening shot, absolute art-style anchor', 'styleanchor', styleAnchorUrl, '', '')
  }
  // 9 槽截断：场景/道具从尾让位，角色/帧锚保位（与单镜同规则）
  while (refs.length > 9) {
    const dropIdx = refs.findLastIndex((r) => r.kind === 'scene' || r.kind === 'prop')
    if (dropIdx >= 0) { refs.splice(dropIdx, 1); continue }
    refs.length = 9
  }

  // 音色槽：段内所有发声角色（最多 3）
  const audioRefs = []
  for (const c of charRowsAll) {
    if (!speakingNames.has(c.name)) continue
    const idx = refs.findIndex((r) => r.kind === 'character' && r.label === c.name)
    if (idx >= 0 && c.audio_url) audioRefs.push({ subjectNum: idx + 1, label: c.name, audio: c.audio_url })
    if (audioRefs.length >= 3) break
  }

  // 戏型：段内任一镜为武戏则整段上打斗 LoRA（段是一体生成，不能半段武戏）
  const isCombat = shots.some((sh) => resolveIsCombat(sh))
  return { stylePrompt, stylePromptEn, refs, audioRefs, isCombat }
}

/**
 * 开场色向闸 + 衔接检测用的「代表镜」：段级检测挂在段首镜上
 * （段的色调源头就是段首，下游镜接的是段成片切片，色向一致性由段内保证）。
 */

router.post('/video-segment/:id', async (req, res) => {
  const segmentId = Number(req.params.id)
  const { allowSilent = false, allowNoFrame = false, forceRetry = false, skipSlice = false } = req.body || {}

  const seg = queryOne('SELECT * FROM video_segments WHERE id = ?', [segmentId])
  if (!seg) return res.status(404).json({ error: '段不存在' })
  if (seg.status === 'unusable') {
    return res.status(400).json({ error: `段 ${segmentId} 标记为 unusable（段长非法），请逐镜出片` })
  }

  // 「出片中」状态闸门（2026-09-16 审核修复 P1-5）：
  //   inflight 是**内存 Map**，进程崩溃/重启后清空，而 video_segments.status 会永久停在 'running'。
  //   旧逻辑只查内存锁 → 重启后可对同一段重复提交，**双倍烧币**；且该段从此卡在 running，
  //   前端「出片中…」永不结束。现同时查库状态：running 一律拒绝，并显式提示如何解锁。
  //   注意：内存锁仍在（拦同进程并发），库状态是它的持久化补充，二者缺一不可。
  //   用户想强行重出，先点「取消」或等启动复位把它清掉（见 index.js resetZombieSegments）。
  if (seg.status === 'running' && !req.body?.forceSteal) {
    return res.status(409).json({
      error: `段 ${segmentId}（${seg.shot_numbers}）当前标记为「出片中」。若你的上一次出片因进程重启而中断，`
        + `该状态可能已失效——请稍候片刻重试（服务启动时会自动复位僵尸段），或用「取消」按钮终止后再出片。`,
      segmentId, running: true,
    })
  }

  const { shots, missingIds } = (await import('../ai/segmentPrompt.js')).loadSegment(segmentId)
  if (!shots.length) return res.status(400).json({ error: `段 ${segmentId} 无镜（shot_ids 为空）` })

  // 段记录完整性闸门（2026-09-16 审核修复 P0-1）：段只存 shot_ids 快照，镜被删/重建后不同步。
  // 旧逻辑只拦「一镜不剩」（上一行的 !shots.length），**部分缺失会被静默放行**——
  // 带着残缺镜集合走完出片：资产少装配、prompt 少写 [Shot N]、切片少切一份，
  // 缺失镜永远拿不到 video_url，而这一段的币已经烧掉了。
  // 现在「记录声称 N 镜、实际查出 M<N 镜」一律拒绝，并提示重算段方案（重算会写入指纹，
  // 与 segmentSlicer 的空指纹判定形成双防线）。forceRetry 不豁免——这是数据完整性，不是质量偏好。
  if (missingIds.length) {
    const alive = shots.map((s) => s.shot_number).join('、')
    return res.status(400).json({
      error: `段 ${segmentId} 的记录已过期：记录含 ${shots.length + missingIds.length} 镜，`
        + `但 ${missingIds.length} 镜已被删除或重建（现存：${alive}）。`
        + `若按此出片，缺失镜的内容不会出现在成片里，且该镜永远拿不到视频。`
        + `请到分镜页「重算段方案」后再出片。`,
      segmentId,
      missingShotIds: missingIds,
      aliveShotNumbers: shots.map((s) => s.shot_number),
    })
  }

  // 段方案新鲜度闸门（2026-09-16，保险丝）：
  // 「缺镜」只覆盖了「镜被删」一种过期形态。镜长/镜号/顺序变了但镜都还在时 missingIds 为空，
  // 旧逻辑会放行 → 烧币出片成功 → 切片器按指纹判过期 → 拒绝切片 → **币花了但镜级 video_url 永久为空**。
  // 这是「生成成功 → 必然切片失败」的唯一可达组合，必须在计费之前掐断。
  // 判定与切片器共用 segmentStaleness 单点实现（同源），保证「闸门放过的，切片一定切得动」。
  // forceRetry 不豁免——这是数据一致性，不是质量偏好（与上一道闸门同口径）。
  {
    const { segmentStaleness } = await import('../ai/segmentBuilder.js')
    const fp = segmentStaleness(seg)
    if (fp.stale) {
      return res.status(400).json({
        error: `段 ${segmentId}（${seg.shot_numbers}）的方案已过期：${fp.reason}。`
          + `若按此出片，成片会在切片那一步被拒绝，本段的生成费用白花且段内镜头拿不到视频。`
          + `请到短片页点「重算分段」后再出片。`,
        segmentId,
        stale: true,
        staleReason: fp.reason,
        storedFingerprint: seg.shots_fp || '',
        currentFingerprint: fp.currentFingerprint,
      })
    }
  }

  // 台词闸门：段内所有镜都无台词 → 需 allowSilent（与单镜同口径）
  const anyDlg = shots.some((sh) => hasDialogue(sh.dialogue))
  if (!anyDlg && !allowSilent) {
    return res.status(400).json({ error: '本段所有镜都没有台词（dialogue 全空）：H3 只念 <d> 标签内的台词，无台词=成片没有角色语音。请补全台词或重新生成分镜；若确认为纯动作无声段，请传 allowSilent 再出片。' })
  }

  // 构图锚闸门（2026-09-16，与单镜 /video-v4 同口径）：段内任一镜 frame_url 与
  // continuity_url 双空 = 该镜出片没有任何构图锚。段是一体生成，一镜跑偏整段返工——
  // 段级比单镜更要拦。清点后整批拒绝并给清单（正合"备场检查"：先把图备齐再开拍）。
  const noAnchorShots = shots.filter((sh) => !String(sh.frame_url || '').trim() && !String(sh.continuity_url || '').trim())
  if (noAnchorShots.length && !allowNoFrame) {
    const list = noAnchorShots.map((s) => s.shot_number).join('、')
    return res.status(400).json({
      error: `段内 ${noAnchorShots.length} 镜没有分镜图也没有接力锚（${list}）：这些镜出片没有构图锚，构图靠模型自由发挥，与分镜大概率对不上——段是一体生成，一镜跑偏整段返工。请先补分镜图再出段；确认纯文字出片请传 allowNoFrame。`,
      missingFrameShots: noAnchorShots.map((s) => ({ shotId: s.id, shotNumber: s.shot_number })),
    })
  }

  // 脚本闸门（与单镜同口径）
  try {
    assertScriptConfirmed(seg.episode_id)
    assertNotStale(seg.episode_id, 'storyboard')
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message })
  }
  // 画风毒词闸：段内任一镜命中即拦（段是一体生成，任一镜带毒词整段跑偏）
  const poisoned = shots.find((sh) => {
    try { assertNoStylePoison(sh, req.body?.allowStyleShift); return false } catch { return true }
  })
  if (poisoned) {
    try { assertNoStylePoison(poisoned, req.body?.allowStyleShift) } catch (err) {
      return res.status(err.status || 400).json({ error: `段内镜 ${poisoned.shot_number} ${err.message}` })
    }
  }
  // 防烧币上限：任一段内镜已回灌 ≥2 次且带新反馈 → 拦（与单镜同口径）
  if (!forceRetry) {
    const tired = shots.find((sh) => (Number(sh.retry_count) || 0) >= 2 && String(sh.retry_feedback || '').trim())
    if (tired) {
      return res.status(409).json({ error: `段内镜 ${tired.shot_number} 已按验收反馈自动回灌 ${tired.retry_count} 次仍未过审，且当前又有新的失败反馈：继续同路径重出大概率重复失败。请先人工看片定位根因；确认仍要重试请传 forceRetry: true。` })
    }
  }

  // 跨通道互斥（P2-6）：段内任一镜若正被单镜通道（v4/v3）出片，则本条段级出片会与之互相覆盖、
  // 两笔币都花。段只锁段、单镜只锁镜，此前两者不互通——这是本项目「双倍烧币」的隐藏路径之一。
  const inShotChannel = segmentBusyInShotChannels(shots.map((s) => s.id))
  if (inShotChannel) {
    const busyShot = shots.find((s) => Number(s.id) === Number(inShotChannel.shotId))
    return res.status(409).json({
      error: `段内镜 ${busyShot?.shot_number || inShotChannel.shotId} 正在单独出片（${inShotChannel.key}）：段的成片会切片覆盖它，两条通道都在烧币。请等该镜完成或取消后再出段。`,
      conflict: 'shot', shotKey: inShotChannel.key, shotId: inShotChannel.shotId,
    })
  }

  const jobKey = `video-segment:${segmentId}`
  if (segmentJobsInflight.has(jobKey)) {
    return res.status(409).json({ error: '该段正在出片中，请等待完成后再试' })
  }
  // shotIds 一并登记：供单镜通道做「该镜是否属于某个出片中的段」的交叉判定（P2-6）
  segmentJobsInflight.set(jobKey, { segmentId, sceneNumber: seg.scene_number, segmentIndex: seg.segment_index, shotIds: shots.map((s) => Number(s.id)), startedAt: Date.now(), phase: 'submitting' })
  execute("UPDATE video_segments SET status = 'running', error = '' WHERE id = ?", [segmentId])

  // FIX-3（2026-09-18，P1-Q3）：记录"成片是否已生成"。外层 catch 据此判断——成片已生成后
  // 才发生的回写/后置步骤异常**不得**把段标 failed、也不得返 500（那会诱导用户重复出片烧钱）。
  let generatedUrl = ''

  try {
    const { buildSegmentVideoPrompt } = await import('../ai/segmentPrompt.js')
    const { sliceSegment, extractSegmentLastFrame } = await import('../ai/segmentSlicer.js')

    const assets = buildSegmentAssets(seg, shots)
    // 段长统一口径（2026-09-16 审核修复 P1-2）：改走 segmentBuilder.segmentDurationSec，
    // 与段方案合法性判定、segmentPrompt 共用同一实现——不再在本层重写一份 clamp 字面量。
    const { segmentDurationSec } = await import('../ai/segmentBuilder.js')
    const duration = segmentDurationSec(seg, shots)
    const speakerIds = episodeSpeakerIds(shots[0])

    // 武戏修饰（与单镜同口径：触发词 + 通用物理，画风不换）
    const combatTriggers = /倒进|倒地|瘫倒|击倒|轰然倒/.test(shots.map((s) => `${s.description || ''}${s.action_note || ''}`).join(' '))
      ? 'prfight1, prfin1'
      : 'prfight1'
    const COMBAT_STYLE_EN = 'SAME hand-drawn watercolor animation art style as the reference images and the rest of the episode — never switch to any other art register or render style; grounded fight and action choreography with real weight and inertia, every impact lands with full body weight — recoil, shockwaves, debris flying on contact, fast decisive motion with follow-through, intensity and physical danger conveyed through scale, motion and physical detail, no magic aura, no energy effects, ' + combatTriggers
    const combatNote = assets.isCombat ? COMBAT_STYLE_EN : ''

    const prompt = await buildSegmentVideoPrompt({
      seg, shots,
      refs: assets.refs,
      audioRefs: assets.audioRefs,
      stylePromptEn: assets.stylePromptEn,
      speakerIds,
      isCombat: assets.isCombat,
      combatNote,
    })

    // 结构校验：prompt 结构错会静默毁掉成片（币已花），出片前硬拦
    const { validateSegmentPrompt } = await import('../ai/segmentPrompt.js')
    const v = validateSegmentPrompt(prompt, shots.length)
    if (!v.ok) {
      const msg = `段级 prompt 结构校验失败：${v.errors.join('；')}`
      execute("UPDATE video_segments SET status = 'failed', error = ? WHERE id = ?", [msg.slice(0, 500), segmentId])
      return res.status(500).json({ error: msg, errors: v.errors })
    }

    segmentJobsInflight.get(jobKey).phase = 'generating'
    console.log(`[/generate/video-segment] 段${segmentId}（场${seg.scene_number}段${seg.segment_index}）提交：${shots.map((s) => s.shot_number).join('+')} ${duration}s，refs ${assets.refs.length} 槽，音色 ${assets.audioRefs.length} 槽，戏型 ${assets.isCombat ? '武戏' : '文戏'}`)

    const result = await generateShotVideoV4(
      {
        shotId: `segment-${segmentId}`,
        prompt,
        refs: assets.refs,
        audioRefs: assets.audioRefs.map((a) => a.audio),
        aspectRatio: shots[0].__aspectRatio || '9:16 (Portrait Widescreen)',
        duration,
        combatLoraStrength: assets.isCombat ? '0.5' : '0',
      },
      { onProgress: (phase, info) => { const j = segmentJobsInflight.get(jobKey); if (j) { j.phase = `${phase}${info?.message ? ': ' + info.message : ''}`; if (info?.taskId) j.taskId = String(info.taskId) } } }
    )

    if (!result.success || !result.videoUrl) {
      execute("UPDATE video_segments SET status = 'failed', error = ? WHERE id = ?", [String(result.error || '出片失败').slice(0, 500), segmentId])
      return res.json({ success: false, error: result.error || '出片失败', taskId: result.taskId })
    }
    // 成片已在云端/本地生成（已计费）→ 从此刻起任何后续异常都不得把段当"出片失败"处理（FIX-3）
    generatedUrl = result.videoUrl

    // 段成片本地化失败的兜底（2026-09-16 审核修复 P1-4）：v4Video 下载本地失败时返回的是
    // **24h 时效的云端 URL**。而切片器只认本地 /uploads/ 路径（uploadsToAbs 返回 null）——
    // 结果：段 status=done 看着正常，切片必失败，段内镜 video_url 永久为空，币花了没画面。
    // 单镜路径此前有打捞兜底（enqueueSalvage），段级一直缺失。这里补齐：登记段级打捞，
    // 后台每 5 分钟重捞云端成片，捞到后回写本地并**自动补切片**（见 salvageWorker）。
    const segmentLocalized = String(result.videoUrl).startsWith('/uploads/')
    if (!segmentLocalized) {
      const segLabel = `${seg.scene_number}-${seg.segment_index}（${seg.shot_numbers}）`
      recordAlert({
        episodeId: seg.episode_id, shotId: shots[0].id, shotNumber: String(shots[0].shot_number || ''),
        source: 'writeback', level: 'error',
        message: `段 ${segLabel} 成片本地化失败：video_url 仍是 24h 时效的云端链接，切片无法进行（段内 ${shots.length} 镜拿不到画面）。已登记段级打捞队列，后台每 5 分钟自动重捞，捞到后自动补切片。`,
        detail: { segmentId, videoUrl: result.videoUrl },
      })
      enqueueSalvage({
        segmentId, segmentLabel: segLabel, episodeId: seg.episode_id,
        taskId: result.taskId, url: result.videoUrl,
      })
    }

    // 段成片落库。FIX-3（2026-09-18，P1-Q3）：回写失败**不再向上抛**——成片已生成且已计费，
    // 若把它当"出片失败"（外层 catch 置 failed + 500），用户极易重复点击出片 → 重复烧钱。
    // 改为：保留 error 告警（文案含"请勿重复出片"），并把 warning 透传到响应体（success 仍 true）。
    let segWbWarning = ''
    try {
      execute("UPDATE video_segments SET status = 'done', video_url = ?, error = ? WHERE id = ?", [result.videoUrl, result.warning || '', segmentId])
    } catch (wbErr) {
      segWbWarning = `回写失败：段成片已生成（地址：${result.videoUrl}）+ 数据库回写失败，请勿重复出片，需人工排查`
      recordAlert({
        episodeId: seg.episode_id, shotId: shots[0].id, shotNumber: String(shots[0].shot_number || ''),
        source: 'writeback', level: 'error',
        message: `段 ${seg.scene_number}-${seg.segment_index}（${seg.shot_numbers}）${segWbWarning}`,
        detail: wbErr,
      })
    }

    // ── 段间接力锚：本段末帧存起来，供**下一段**当 continuity 锚 ──
    // 段内下一段出片时读 anchor_frame_url。跨场不接力（场首段 anchorMode='none'）。
    let anchorUrl = ''
    try {
      const fr = await extractSegmentLastFrame(segmentId)
      if (fr.success) {
        anchorUrl = fr.url
        // 写「同场下一段」的 anchor_frame_url（场不跨，见 segmentBuilder 段前锚语义）
        execute(
          "UPDATE video_segments SET anchor_frame_url = ? WHERE episode_id = ? AND scene_number = ? AND segment_index = ? AND status IN ('pending','failed')",
          [anchorUrl, seg.episode_id, seg.scene_number, seg.segment_index + 1]
        )
      }
    } catch (e) {
      console.warn(`[/generate/video-segment] 段${segmentId} 末帧抽取失败（不影响成片，下游段少一个接力锚）:`, e.message)
    }

    // ── 切片回填：段成片按镜边界切 N 份 → 逐镜写 shots.video_url ──
    let sliceResult = null
    if (!skipSlice) {
      segmentJobsInflight.get(jobKey).phase = 'slicing'
      // force=true：段是「重出」才走到这里，成片已换新，旧切片必须重切。
      // 否则按幂等判据复用旧切片，卡片播的是上一版视频（P1-G）。
      sliceResult = await sliceSegment(segmentId, { force: true })
      if (!sliceResult.success) {
        // 字段名必须是 camelCase（recordAlert 读 a.episodeId / a.shotId / a.shotNumber）——
        // 曾写成 snake_case，episode_id/shot_id/shot_number 全被静默丢弃，告警落库后无归属（P1-2）
        recordAlert({
          level: 'error', source: 'writeback', episodeId: seg.episode_id,
          shotId: shots[0].id, shotNumber: shots[0].shot_number,
          message: `段 ${seg.scene_number}-${seg.segment_index}（${seg.shot_numbers}）切片回填失败：卡片仍会播放整段成片。${sliceResult.warning}`,
          detail: sliceResult,
        })
      }
    }

    res.json({
      success: true,
      url: result.videoUrl,
      taskId: result.taskId,
      anchorUrl,
      slice: sliceResult ? { ok: sliceResult.success, count: sliceResult.slices?.length || 0, warning: sliceResult.warning || '' } : { skipped: true },
      warning: [result.warning, segWbWarning].filter(Boolean).join('；') || '',
    })
  } catch (err) {
    console.error(`[/generate/video-segment] 段${segmentId} error`, err.message)
    // FIX-3（P1-Q3）：成片已生成（generatedUrl 非空）时，回写/后置步骤出错不得判"出片失败"——
    // 段状态不置 failed、HTTP 也不返 500，改为 success:true + warning，从产品层阻断重复出片。
    if (generatedUrl) {
      return res.json({
        success: true,
        url: generatedUrl,
        warning: `段成片已生成（地址：${generatedUrl}），但后续步骤出错：${String(err.message || '').slice(0, 300)}；请勿重复出片，需人工排查`,
      })
    }
    execute("UPDATE video_segments SET status = 'failed', error = ? WHERE id = ?", [String(err.message).slice(0, 500), segmentId])
    res.status(500).json({ error: err.message })
  } finally {
    segmentJobsInflight.delete(jobKey)
  }
})

// ===== 单镜出片（MinimaxH3 八月最强打斗武戏 workflow, h3Combat）=====
// 与 /video-v4 同范式：inflight 登记 + 同步等待 + 完成回写 shots.video_url。
// 区别：
//  ① 调用 generateShotVideoCombat（h3Combat 工作流）
//  ② 无对白闸门、无音频/视频槽：纯动作镜头（打斗音效后期混）
//  ③ idea = 对阵双方 + 关键动作 + 画面描述 + 景别 + 运镜（豆包看图生成电影级打斗提示词）
//  ④ 参考图单槽 image1 = 分镜图（喂豆包识别角色/武器 + H3 ref_image_0）
const V3_VIDEO_JOB_STALE_MS = 30 * 60 * 1000
const v3VideoJobsInflight = new Map()

router.get('/video-v3/inflight', (req, res) => {
  const now = Date.now()
  const jobs = []
  for (const [key, job] of v3VideoJobsInflight) {
    if (now - job.startedAt > V3_VIDEO_JOB_STALE_MS) {
      v3VideoJobsInflight.delete(key)
      continue
    }
    jobs.push({ shotId: job.shotId, startedAt: job.startedAt, phase: job.phase || '' })
  }
  res.json({ jobs })
})

router.post('/video-v3', async (req, res) => {
  const {
    shotId,
    idea,          // 打斗设定（可选；缺省按 shot 字段自动组装）
    bgImage = '',  // 可选参考图覆盖；不传用 shot.frame_url
    aspectRatio,
    megapixels,
    duration,
  } = req.body
  if (!shotId) return res.status(400).json({ error: 'shotId 必填' })

  const shot = queryOne(
    `SELECT s.*, ss.episode_id
     FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id WHERE s.id = ?`,
    [shotId]
  )
  if (!shot) return res.status(404).json({ error: '镜头不存在' })

  // 画风毒词硬闸（V12，同 /video-v4）：打斗工作流照样烧币，一样拦
  try {
    assertNoStylePoison(shot, req.body.allowStyleShift)
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message })
  }

  try {
    assertScriptConfirmed(shot.episode_id)
    assertNotStale(shot.episode_id, 'storyboard')
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message })
  }

  // 跨通道互斥（P2-6）：该镜若正被某个出片中的段包含，同样会互相覆盖 + 双倍烧币
  const v3InSegment = shotBusyInSegmentChannel(shotId)
  if (v3InSegment) {
    return res.status(409).json({
      error: `该镜头属于正在出片的段（${v3InSegment.key}），段的成片会切片回填本镜——现在用打斗通道单独出片会与之互相覆盖且双倍计费。请等该段完成后再操作。`,
      conflict: 'segment', segmentKey: v3InSegment.key,
    })
  }

  // 同镜防重复提交
  const jobKey = `videoV3:${shotId}`
  if (v3VideoJobsInflight.has(jobKey)) {
    return res.status(409).json({ error: '该镜头正在出片（打斗工作流），请等待完成后再试' })
  }
  v3VideoJobsInflight.set(jobKey, { shotId, startedAt: Date.now(), phase: 'submitting' })
  const job = v3VideoJobsInflight.get(jobKey)

  try {
    // 出场角色名（用于对阵描述）
    const parseNames = (v) => {
      if (!v) return []
      try {
        const r = JSON.parse(v)
        return Array.isArray(r) ? r : []
      } catch {
        return []
      }
    }
    const charNames = parseNames(shot.characters)

    // 分镜图：优先前端 bgImage 覆盖，否则 shot.frame_url
    const finalStoryboardImage = bgImage || shot.frame_url || shot.frame_url2 || ''

    // idea：对阵 + 关键动作 + 景别 + 画面描述 + 运镜。
    // 豆包据此 + 参考图生成电影级打斗提示词（胜负交给豆包按角色能力/武器设计，不硬编码）。
    // 拼装规范（2026-09-09）：各项先去掉末尾标点再 join，避免"懵。，"这类标点堆叠；
    // 运镜直接用分镜里的中文词（打斗 idea 喂豆包中文 LLM，无需转英文——
    // 英文运镜短语是 /video-v2 官方 Ref2VA 优化器的约定，两条路线不混用）。
    const cleanClause = (s) => String(s || '').replace(/[。，、；,;\s]+$/g, '').trim()
    const autoIdea = [
      charNames.length ? `对阵：${charNames.join(' 对 ')}` : '',
      shot.action_note ? `关键动作：${cleanText(shot.action_note)}` : '',
      shot.shot_type ? `${cleanText(shot.shot_type)}镜头` : '',
      cleanText(shot.description),
      shot.camera_movement ? `运镜：${cleanText(shot.camera_movement)}` : '',
    ].map(cleanClause).filter(Boolean).join('，') + '。'
    let finalIdea =
      (idea != null && String(idea).trim()) ||
      String(shot.video_prompt_override || '').trim() ||
      autoIdea
    if (!finalIdea) {
      return res.status(400).json({ error: '打斗出片提示词为空：镜头没有画面描述，且未传 idea' })
    }

    // 无画面文字（2026-09-14 布哥定调「默认不要字幕」）：打斗通道的 H3 prompt 同样是工作流内
    // 的豆包从 idea 扩写（IDEA_TEMPLATE + idea → 豆包 → H3），我们拿不到其输出，无法在末端拼
    // guard 行。唯一能施加约束的位置是 idea，让豆包带进最终 prompt。与 V2 通道同口径。
    if (!finalIdea.includes('画面文字')) {
      finalIdea = `${finalIdea}。画面中不得出现任何文字、字幕、水印或标志。`
    }

    const requestedDuration = Number(duration ?? shot.duration) || 6

    const result = await generateShotVideoCombat(
      {
        shotId: String(shotId),
        idea: finalIdea,
        storyboardImage: finalStoryboardImage,
        aspectRatio,
        megapixels,
        duration: requestedDuration,
      },
      {
        onProgress: (phase, info) => {
          job.phase = phase
          console.log(
            `[/generate/video-v3] shot ${shotId} ${phase}${info?.taskId ? ' taskId=' + info.taskId : ''}${info?.message ? ': ' + info.message : ''}`
          )
        },
      }
    )

    if (result.success && result.videoUrl) {
      execute('UPDATE shots SET video_url = ?, video_generated = 1 WHERE id = ?', [
        result.videoUrl,
        shotId,
      ])
      console.log('[/generate/video-v3] saved video_url for shot', shotId, result.videoUrl)
      res.json({
        success: true,
        url: result.videoUrl,
        taskId: result.taskId,
        warning: result.warning || '',
      })
    } else {
      res.json({ success: false, error: result.error || '出片失败', taskId: result.taskId })
    }
  } catch (err) {
    console.error('[/generate/video-v3] error', { shotId, error: err.message })
    res.status(500).json({ error: err.message })
  } finally {
    v3VideoJobsInflight.delete(jobKey)
  }
})

export default router
