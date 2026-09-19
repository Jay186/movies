import { Router } from 'express'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads')
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })

// removeLocalUploads 统一到 ai/shared.js（原此处与 projects.js 各有一份）
import { removeLocalUploads as removeLocalUploadsShared, filterUnreferencedUploadUrls } from '../ai/shared.js'
const removeLocalUploads = (urls) => removeLocalUploadsShared(urls, UPLOAD_DIR)

import { query, queryOne, execute, transaction } from '../db.js'
import { ensureStandardScript } from '../ai/scriptFormat.js'
import { scriptHash } from '../scriptHash.js'
import {
  mergeMasterIntoEpisodeCharacters,
  replaceEpisodeCharacters,
  updateProjectCharacter,
  syncProjectCharacterToEpisodes,
} from '../characterLibrary.js'
import { backfillShotAssets } from '../ai/assetBackfill.js'
// 台词读写判据单点（2026-09-18 P0-3）：shots.dialogue 契约是 JSON 数组，读取侧此处原写
// `JSON.parse(shot.dialogue)`（"null" 串解析成 null 才侥幸没炸），写入侧原写
// `typeof d === 'object' ? JSON.stringify(d) : ...` —— typeof null === 'object' 为真，
// 于是 JSON.stringify(null) === 'null' 落库，这就是 ep4 那 25 镜脏值的**根因**。
import { parseDialogue, serializeDialogue } from '../ai/dialogue.js'
import { resolveAlertsByShot, recordAlert } from '../ai/alerts.js'
// 资产质量后置校验（2026-09-16 建 / 2026-09-18 改为 LLM 判定）：
// 场景 summary 与 lighting_en 的冷暖自洽检测（只告警不阻断）。
// ⚠️ 判定为异步调 LLM，**必须放在落库事务之外**——见下方 lightingQueue 的说明。
import { runLightingChecks } from '../ai/lightingCheckRuntime.js'
// 重新提取覆盖保护（2026-09-16 P1）：覆盖前快照 + 智能 diff + 「全部保留我的」决策应用
import {
  snapshotBeforeExtract,
  computeExtractDiff,
  applyKeepForScenes,
  applyKeepForProps,
} from '../ai/extractGuard.js'
import { clearQcIgnores } from './qc.js'
import { config } from '../config.js'
import { ASSET_TYPES } from '../ai/assetTypes.js'
// 空间组视图（2026-09-17）：保存场景后的「纯删除快速通道」复用同一指纹算法顺延 scene_analysis 指纹
import { fingerprintOf } from '../ai/sceneAnchors.js'

const router = Router()

// ── P2' 状态行快照/回迁（2026-09-17）──────────────────────────────────────
// 用途：props/scenes 的 DELETE+INSERT 重建时，保住挂在业务键上的 asset_states 行。
// 设计要点（与既有 oldEn 快照同式，且**每个事务内各自快照，不跨事务共用**）：
//   · asset_states 用业务键 asset_key（道具名/场景标题），重提换 id 不影响键；
//   · 快照-回迁是"再确认"：即便某行此前被并发删除，回迁也会按 UNIQUE 幂等还原；
//   · 机制关闭 → 快照为空、回迁空转（= 改造前行为，零副作用）。
const STATE_COLS = ['asset_type', 'asset_key', 'state_key', 'label_zh', 'description', 'description_en', 'image_url', 'is_default', 'source']

function snapshotAssetStatesForNames(assetType, names) {
  if (!config.assetState?.enabled) return []
  if (!ASSET_TYPES.includes(assetType)) return []
  const keys = [...new Set((names || []).map((n) => String(n || '').trim()).filter(Boolean))]
  if (!keys.length) return []
  try {
    const out = []
    // 逐键查（键数量=本集资产数，量小；避免拼 IN 的占位符与参数上限问题）
    for (const k of keys) {
      const rows = query(
        `SELECT ${STATE_COLS.join(', ')} FROM asset_states WHERE asset_type = ? AND asset_key = ?`,
        [assetType, k]
      )
      out.push(...rows)
    }
    return out
  } catch (e) {
    console.warn(`[episodes] 状态行快照失败（不阻断保存）: ${e.message}`)
    return []
  }
}

function restoreAssetStates(rows) {
  if (!config.assetState?.enabled) return 0
  if (!Array.isArray(rows) || !rows.length) return 0
  let n = 0
  try {
    for (const r of rows) {
      execute(
        `INSERT OR IGNORE INTO asset_states (${STATE_COLS.join(', ')})
         VALUES (${STATE_COLS.map(() => '?').join(', ')})`,
        STATE_COLS.map((c) => r[c])
      )
      n++
    }
  } catch (e) {
    console.warn(`[episodes] 状态行回迁失败（不阻断保存）: ${e.message}`)
  }
  return n
}

// 获取项目下的所有集
router.get('/project/:projectId', (req, res) => {
  const episodes = query(
    'SELECT * FROM episodes WHERE project_id = ? ORDER BY episode_number',
    [req.params.projectId]
  )
  res.json(episodes)
})

// 新增剧集：自动计算下一集编号，默认标题"第 N 集"
router.post('/', (req, res) => {
  const { project_id, title } = req.body || {}
  if (!project_id) return res.status(400).json({ error: 'project_id 必填' })
  const project = queryOne('SELECT id FROM projects WHERE id = ?', [project_id])
  if (!project) return res.status(404).json({ error: '项目不存在' })
  const maxRow = queryOne('SELECT MAX(episode_number) AS m FROM episodes WHERE project_id = ?', [project_id])
  const nextNumber = (maxRow && maxRow.m ? maxRow.m : 0) + 1
  const epTitle = title && String(title).trim() ? String(title).trim() : `第 ${nextNumber} 集`
  const result = execute(
    'INSERT INTO episodes (project_id, episode_number, title) VALUES (?, ?, ?)',
    [project_id, nextNumber, epTitle]
  )
  const episode = queryOne('SELECT * FROM episodes WHERE id = ?', [result.lastInsertRowid])
  res.status(201).json(episode)
})

// 更新剧集标题
router.put('/:id', (req, res) => {
  const { title } = req.body || {}
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'title 必填' })
  const episode = queryOne('SELECT id FROM episodes WHERE id = ?', [req.params.id])
  if (!episode) return res.status(404).json({ error: '集不存在' })
  execute('UPDATE episodes SET title = ? WHERE id = ?', [String(title).trim(), req.params.id])
  const updated = queryOne('SELECT * FROM episodes WHERE id = ?', [req.params.id])
  res.json(updated)
})

// 删除剧集：项目至少保留 1 集；级联清除该集角色/场景/道具/分镜/镜头与本地生成文件
router.delete('/:id', (req, res) => {
  const episode = queryOne('SELECT id, project_id FROM episodes WHERE id = ?', [req.params.id])
  if (!episode) return res.status(404).json({ error: '集不存在' })
  const countRow = queryOne('SELECT COUNT(*) AS c FROM episodes WHERE project_id = ?', [episode.project_id])
  if (countRow.c <= 1) return res.status(400).json({ error: '项目至少保留 1 集，无法删除最后一集' })
  // 无外键表清理用的实体 id：**必须在 DELETE 之前收集**。
  // 级联一跑，scenes/props 行就没了，再用子查询去找它们必然查空 → 清理静默失效。
  const ownedSceneIds = query('SELECT id FROM scenes WHERE episode_id = ?', [episode.id]).map((r) => r.id)
  const ownedPropIds = query('SELECT id FROM props WHERE episode_id = ?', [episode.id]).map((r) => r.id)

  // 收集该集本地生成文件候选（图片/音频/分镜图/视频/末帧锚/场级四宫格）。
  // 注意顺序：先删 DB 行再删文件，且只删「全库已无引用」的文件——链接角色的
  // image_url/audio_url 与项目主设定、其他集副本共享同一文件，直接删会误伤
  const rows = query(
    `SELECT c.image_url u FROM characters c WHERE c.episode_id = ?
     UNION ALL SELECT c2.audio_url FROM characters c2 WHERE c2.episode_id = ?
     UNION ALL SELECT p.image_url FROM props p WHERE p.episode_id = ?
     UNION ALL SELECT sc.image_url FROM scenes sc WHERE sc.episode_id = ?
     UNION ALL SELECT s.storyboard_url FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id WHERE ss.episode_id = ?
     UNION ALL SELECT s.frame_url FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id WHERE ss.episode_id = ?
     UNION ALL SELECT s.frame_url2 FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id WHERE ss.episode_id = ?
     UNION ALL SELECT s.blocking_url FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id WHERE ss.episode_id = ?
     UNION ALL SELECT s.video_url FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id WHERE ss.episode_id = ?
     UNION ALL SELECT s.continuity_url FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id WHERE ss.episode_id = ?
     UNION ALL SELECT ss2.grid_image_url FROM storyboard_scenes ss2 WHERE ss2.episode_id = ?`,
    [episode.id, episode.id, episode.id, episode.id, episode.id, episode.id, episode.id, episode.id, episode.id, episode.id, episode.id]
  )
  execute('DELETE FROM episodes WHERE id = ?', [episode.id])

  // ===== 无外键表：显式清理 =====
  // episodes 的子表绝大多数靠 `ON DELETE CASCADE` 自动带走，但有两张表没有外键
  // （SQLite 建不了「多态引用」与「纯日志」的外键），必须手工兜：
  //   · asset_image_history —— 形象版本历史。asset_id 是**多态**的：character 走
  //     project_characters.id、scene/prop 走集行 id（schema.sql:304），建不了 FK。
  //     只清 scene/prop 两类：character 类挂在项目库主设定上、跨集共用，
  //     删单集不该动它（删角色 / 删项目时才该由各自的接口负责）。
  //   · ai_calls —— AI 调用日志（成本统计）。episode_id 无约束，不会级联。
  //     连带删除是刻意的：日志所属的集已不存在，留着会让「按集统计」出现指向
  //     空集的幻影条目。若日后要保留成本总量，把下面那条 DELETE 换成
  //     `UPDATE ai_calls SET episode_id = NULL WHERE episode_id = ?` 即可 ——
  //     总量仍在，只是不再归属到已删的集。
  // 清理失败只告警、不阻断：主删除已提交，日志/历史的残留不该让整个操作报错。
  try {
    for (const [assetType, ids] of [['scene', ownedSceneIds], ['prop', ownedPropIds]]) {
      if (!ids.length) continue
      execute(
        `DELETE FROM asset_image_history WHERE asset_type = ? AND asset_id IN (${ids.map(() => '?').join(',')})`,
        [assetType, ...ids]
      )
    }
    execute('DELETE FROM ai_calls WHERE episode_id = ?', [episode.id])
  } catch (e) {
    console.warn(`[episodes] 无外键表清理失败（删除已生效，仅残留日志/历史）: ${e.message}`)
  }

  removeLocalUploads(filterUnreferencedUploadUrls(rows.map((r) => r.u)))
  res.json({ success: true })
})

// 获取单集完整数据（剧本+角色+道具+分镜+镜头）
router.get('/:id', (req, res) => {
  const episode = queryOne('SELECT * FROM episodes WHERE id = ?', [req.params.id])
  if (!episode) return res.status(404).json({ error: '集不存在' })

  // 链接了项目角色库的角色：形象/描述/音色一律以项目主设定为准，避免跨集漂移
  const characters = mergeMasterIntoEpisodeCharacters(
    query('SELECT * FROM characters WHERE episode_id = ? ORDER BY id', [req.params.id])
  )
  const props = query('SELECT * FROM props WHERE episode_id = ? ORDER BY id', [req.params.id])
  // 空间组机位声明（scene_analysis.spatial_role）：LEFT JOIN 带上，供前端拼进场景图 prompt。
  // 为什么必须带：spatial_role（如「崖顶俯视谷底」「谷底浅滩仰视」）是 LLM 判定的**本场机位**，
  // 而它此前只出现在设定页 UI 上、从未进入图片 prompt——模型不知道这一场该站在哪，
  // 于是同组多视角全部塌陷成基准图机位（cliff_river 事故）。
  // A1/A2（2026-09-17）同源带出 elements_json / shared_env_json：本场要素清单 + 组级环境卡，
  //   由 promptBuilder 以 1.35 权重硬约束进画面（场1 缺雾、场2 缺植被两处实测缺陷的解法）。
  // LEFT JOIN + COALESCE：未分析/分析失败时为空串，前端行为与改造前完全一致（不注入机位句）。
  // 表可能不存在（老库迁移中）→ 整段 try/catch 降级为不带该字段，绝不阻断 /episodes/:id。
  const roleBySceneId = (() => {
    try {
      const rows = query(
        'SELECT scene_id, spatial_group, spatial_role, elements_json, shared_env_json FROM scene_analysis WHERE episode_id = ?',
        [req.params.id]
      )
      return new Map(rows.map((r) => [r.scene_id, r]))
    } catch (e) {
      console.warn('[GET /episodes/:id] scene_analysis 读取失败（降级为无机位声明）:', e.message)
      return new Map()
    }
  })()
  const scenes = query('SELECT * FROM scenes WHERE episode_id = ? ORDER BY scene_number', [req.params.id]).map((s) => ({
    ...s,
    propNames: (() => {
      try { return JSON.parse(s.prop_names || '[]') } catch { return [] }
    })(),
    // 空间组归属与机位声明（无分析行 → 空串）
    spatialGroup: String(roleBySceneId.get(s.id)?.spatial_group || ''),
    spatialRole: String(roleBySceneId.get(s.id)?.spatial_role || ''),
    // A1/A2 清单（无分析行 / 列缺失 → 空数组，前端不注入）
    elements: (() => {
      try {
        const v = JSON.parse(roleBySceneId.get(s.id)?.elements_json || '[]')
        return Array.isArray(v) ? v : []
      } catch { return [] }
    })(),
    sharedEnv: (() => {
      try {
        const v = JSON.parse(roleBySceneId.get(s.id)?.shared_env_json || '[]')
        return Array.isArray(v) ? v : []
      } catch { return [] }
    })(),
  }))
  let aiChatHistory = []
  try {
    aiChatHistory = JSON.parse(episode.ai_chat_history || '[]')
  } catch {
    aiChatHistory = []
  }

  // 段级成片（E路线v2）：一段盖多镜，成片挂 video_segments，**但成片会被按镜边界切片后
  // 逐镜回填 shots.video_url**（2026-09-15 改为切片回填方案，解决"同段多镜卡片播放同一视频"）。
  // 因此这里连 pending/unusable 段一并查回，供 UI 展示「已分好段、待出片」。
  const segments = query(
    "SELECT * FROM video_segments WHERE episode_id = ? ORDER BY scene_number, segment_index",
    [req.params.id]
  )
  const segmentByShot = new Map()
  for (const seg of segments) {
    if (!seg.video_url) continue
    let segShotIds = []
    try { segShotIds = JSON.parse(seg.shot_ids || '[]') } catch { segShotIds = [] }
    for (const sid of segShotIds) segmentByShot.set(sid, seg)
  }
  // 段方案（含未出片段）：UI「按场出片」按此渲染段队列与进度
  const segmentPlan = segments.map((seg) => {
    let segShotIds = []
    try { segShotIds = JSON.parse(seg.shot_ids || '[]') } catch { segShotIds = [] }
    // 段时长取**区间长度**（end-start），与 segmentBuilder.segmentDurationSec 同口径
    // （P1-2 修复：出片/切片/合法性判定三者统一按区间长度走）。
    // 字段名保持 `duration` 以兼容既有前端消费点（VideoView 用它求「本场待出片总秒数」）；
    // 另补 `durationSec` 别名，表达「权威段时长」语义，新代码请用后者。
    const rawSpan = (seg.start_time != null && seg.end_time != null)
      ? Number(seg.end_time) - Number(seg.start_time)
      : null
    const span = rawSpan != null ? Number(rawSpan.toFixed(3)) : null
    return {
      id: seg.id,
      sceneNumber: seg.scene_number,
      segmentIndex: seg.segment_index,
      shotIds: segShotIds,
      shotNumbers: seg.shot_numbers || '',
      startTime: seg.start_time,
      endTime: seg.end_time,
      duration: span,
      durationSec: span,
      videoUrl: seg.video_url || '',
      anchorFrameUrl: seg.anchor_frame_url || '',
      trimStart: Number(seg.trim_start) || 0,
      status: seg.status || 'pending',
      error: seg.error || '',
    }
  })

  const storyboardScenes = query(
    'SELECT * FROM storyboard_scenes WHERE episode_id = ? ORDER BY scene_number',
    [req.params.id]
  )
  for (const s of storyboardScenes) {
    s.shots = query(
      'SELECT * FROM shots WHERE storyboard_scene_id = ? ORDER BY start_time, id',
      [s.id]
    ).map((shot) => ({
      ...shot,
      characters: JSON.parse(shot.characters || '[]'),
      sceneAssets: JSON.parse(shot.scene_assets || '[]'),
      propAssets: JSON.parse(shot.prop_assets || '[]'),
      videoGenerated: !!shot.video_generated,
      shotNumber: shot.shot_number || '',
      shotType: shot.shot_type || '',
      startTime: shot.start_time || 0,
      endTime: shot.end_time || 0,
      actionNote: shot.action_note || '',
      soundEffects: shot.sound_effects || '',
      cameraMovement: shot.camera_movement || '',
      cameraAngle: shot.camera_angle || '',
      overallSoundscape: shot.overall_soundscape || '',
      nonDiegeticMusic: shot.non_diegetic_music || '',
      integratedMultimodalDescription: shot.integrated_multimodal_description || '',
      blockingPlan: (() => {
        try { return shot.blocking_plan ? JSON.parse(shot.blocking_plan) : null } catch { return null }
      })(),
      finalFrame: shot.final_frame || '',
      // 读侧：无台词 / 脏值一律得 []。对外形状刻意保持「空则 null」：
      // 前端对 dialogue 只有「null」与「数组」两种用法，为了不动已有契约，
      // 空时仍返回 null（与改前逐字节一致），只有确实有台词时才给数组。
      dialogue: (() => {
        const lines = parseDialogue(shot.dialogue)
        return lines.length ? lines : null
      })(),
      description: shot.description || '',
      storyboardUrl: shot.storyboard_url || '',
      frameUrl: shot.frame_url || '',
      frameUrl2: shot.frame_url2 || '',
      videoUrl: shot.video_url || '',
      // 段级成片回显：本镜被段覆盖时用段成片播放（UI 从 segmentOffset 起播本镜区间）。
      // 只做只读注入，不改写 videoUrl——镜级单出片与段级出片互不干扰
      segmentVideoUrl: segmentByShot.get(shot.id)?.video_url || '',
      segmentOffset: (() => {
        const seg = segmentByShot.get(shot.id)
        if (!seg || seg.start_time == null || shot.start_time == null) return 0
        return Math.max(0, Number(shot.start_time) - Number(seg.start_time))
      })(),
      segmentLabel: (() => {
        const seg = segmentByShot.get(shot.id)
        return seg ? `场${seg.scene_number}·段${seg.segment_index}（${seg.shot_numbers || ''}）` : ''
      })(),
      // 末帧接力锚（上一镜出片时写入）：确认分镜回传需要透传，否则 POST storyboard
      // 的「不传即清」逻辑无法区分「确认保留」与「重新生成清空」（与 blockingPlan 同款契约）
      continuityUrl: shot.continuity_url || '',
      // 尾帧锚（2026-09-16，「final_frame 一键生图」）：本镜收尾的规划画面，与 frameUrl 成对。
      // 与 continuityUrl 同款「不传即清」契约——镜头内容重写后旧尾帧锚对新内容失效，
      // 残留会让 UI 把过期的收尾画面当成当前镜头的一部分显示。
      keyframeUrl: shot.keyframe_url || '',
      // 衔接质量检测结果（#3）：色温/亮度/构图差 + alert 标记，VideoView 镜头卡片标红
      seamCheck: (() => {
        try { return shot.seam_check ? JSON.parse(shot.seam_check) : null } catch { return null }
      })(),
      // VLM 观片闸评审（2026-09-12）：情绪/一拍一镜/台词对脸/AI味穿帮 四维评分 + verdict
      shotReview: (() => {
        try { return shot.shot_review ? JSON.parse(shot.shot_review) : null } catch { return null }
      })(),
    }))
  }

  res.json({
    ...episode,
    scriptConfirmed: !!episode.script_confirmed,
    // 剧本指纹 + 资产/分镜提取时的剧本指纹：前端据此判断「剧本已改，下游需重提」（存库跨浏览器有效）
    scriptHash: scriptHash(episode.script_content),
    assetsScriptFp: episode.assets_script_fp || '',
    storyboardScriptFp: episode.storyboard_script_fp || '',
    storyboardSource: episode.storyboard_source || 'generated',
    // 集级「镜头语言规格」：AI 分镜/提示词生成时的全局连续约束（方向/机位/光照/物理规则）
    directorNotes: episode.director_notes || '',
    aiChatHistory,
    characters,
    props,
    scenes,
    // 段方案（E路线v2）：UI 按场展示「段队列」，段内多镜共享一次生成
    segmentPlan,
    storyboardScenes: storyboardScenes.map((scene, sceneIndex) => ({
      ...scene,
      // 场次编号按当前返回顺序重新计算，避免历史自增 ID 影响显示
      scene_number: sceneIndex + 1,
      shots: scene.shots.map((shot, shotIndex) => ({
        ...shot,
        shot_number: shot.shot_number || `${sceneIndex + 1}-${shotIndex + 1}`,
      })),
    })),
    storyboardConfirmed: !!episode.storyboard_confirmed,
  })
})

// 保存集级「镜头语言规格」（AI 分镜/提示词生成时的全局连续约束；空串=清除）
router.put('/:id/director-notes', (req, res) => {
  const { director_notes } = req.body
  if (director_notes === undefined) return res.status(400).json({ error: 'director_notes 必填' })
  execute('UPDATE episodes SET director_notes = ? WHERE id = ?', [String(director_notes), req.params.id])
  res.json({ success: true })
})

// 更新剧本
router.put('/:id/script', async (req, res) => {
  const { script_content, script_confirmed, ai_chat_history } = req.body
  // 剧本发生实质修改后，旧分镜不再可信，需要重新确认
  const current = queryOne('SELECT script_content FROM episodes WHERE id = ?', [req.params.id])

  // 确认剧本时把内容归一化为标准格式：标准稿原样直通；变体场次标记改写；
  // 无标记稿补场次框架（长文由 LLM 只插标记切分）。转换失败不阻塞确认，按原文入库。
  let content = script_content
  if (script_confirmed) {
    const source = script_content !== undefined ? script_content : current?.script_content
    if (source && String(source).trim()) {
      try {
        const normalized = await ensureStandardScript(source, { episodeId: req.params.id })
        if (normalized.changed) content = normalized.text
      } catch (e) {
        console.warn('[script normalize] 确认剧本格式转换失败，按原文入库:', e.message)
      }
    }
  }

  const scriptChanged = content !== undefined && content !== current?.script_content
  execute(
    'UPDATE episodes SET script_content = COALESCE(?, script_content), script_confirmed = COALESCE(?, script_confirmed), ai_chat_history = COALESCE(?, ai_chat_history), storyboard_confirmed = CASE WHEN ? THEN 0 ELSE storyboard_confirmed END WHERE id = ?',
    [
      content,
      script_confirmed,
      ai_chat_history === undefined ? null : JSON.stringify(ai_chat_history),
      scriptChanged ? 1 : 0,
      req.params.id,
    ]
  )
  const episode = queryOne('SELECT * FROM episodes WHERE id = ?', [req.params.id])
  res.json(episode)
})

// 剧本导入预览：任意文本 → 归一化 → 返回场次数/未识别数（不落库，确认导入后再保存）
router.post('/:id/script/preview', async (req, res) => {
  const { text } = req.body
  if (!text || !String(text).trim()) return res.status(400).json({ error: '请粘贴或上传剧本内容' })

  try {
    const raw = String(text)
    const normalized = await ensureStandardScript(raw, { episodeId: req.params.id })

    // 归一化后的标准场次数（行首「场次N：标题」）
    const sceneCount = normalized.text
      .split('\n')
      .filter((l) => /^场次[一二三四五六七八九十\d]+[：:]\s*/.test(l)).length

    // 未识别标记数：形似"场次/分场/镜头"但不在支持变体（【场次N】/===场次N===/第N场/Scene N）内的行
    const unparsedLines = raw.split('\n').map((l) => l.trim()).filter((line) => {
      if (!line) return false
      if (/^场次[一二三四五六七八九十\d]+[：:]/.test(line)) return false
      if (/^(【\s*场次|===\s*场次|第\s*[0-9一二三四五六七八九十百]+\s*场|Scene\s*\d+)/i.test(line)) return false
      return /^(第\s*[0-9一二三四五六七八九十百]+[幕章卷]|Act\s*\d+|Part\s*\d+|镜头\s*\d+|分场\s*\d+)/i.test(line)
    })

    res.json({
      success: true,
      sceneCount,
      unparsedCount: unparsedLines.length,
      unparsedLines: unparsedLines.slice(0, 20),
      changed: normalized.changed,
      method: normalized.method,
      // 完整归一化文本：确认导入时直接保存这一份，避免 LLM 切分结果在预览/保存两次调用间不一致
      normalizedText: normalized.text,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// 保存角色
// source='edit'（默认）= 用户在设定页手动编辑：回写项目角色库主设定，并同步到项目下所有集
// source='extract' = AI 资产提取：主设定为准，不让 LLM 每次提取的猜测覆盖已确认的形象/描述/音色
router.post('/:id/characters', (req, res) => {
  const { characters = [], source = 'edit', decision = '' } = req.body
  // 保护：空列表不执行删除，避免数据被意外清空
  if (!Array.isArray(characters) || characters.length === 0) {
    return res.status(400).json({ error: '角色列表不能为空，已拒绝保存以保护现有数据' })
  }
  const episode = queryOne('SELECT project_id FROM episodes WHERE id = ?', [req.params.id])
  // P1：提取路径启用「智能 diff 确认」——有风险且未决策时不落库，回传风险报告交前端二次确认
  const guardResult = replaceEpisodeCharacters(
    req.params.id,
    episode?.project_id || null,
    characters,
    { source, decision, guard: source === 'extract' }
  )
  if (guardResult?.risk) return res.json(guardResult)

  const result = mergeMasterIntoEpisodeCharacters(
    query('SELECT * FROM characters WHERE episode_id = ? ORDER BY id', [req.params.id])
  )
  res.json(result)
})

// 保存道具
router.post('/:id/props', (req, res) => {
  const { props = [], source = 'edit', decision = '' } = req.body
  if (!Array.isArray(props) || props.length === 0) {
    return res.status(400).json({ error: '道具列表不能为空，已拒绝保存以保护现有数据' })
  }
  const episodeId = Number(req.params.id)

  // P1（2026-09-16）重新提取覆盖保护：仅在提取路径（source='extract'）启用。
  // 手动编辑（设定页/导入分镜合并）走 source='edit'，行为与改造前逐字节一致。
  let effectiveProps = props
  if (source === 'extract') {
    const oldRows = query('SELECT * FROM props WHERE episode_id = ? ORDER BY id', [episodeId])
    // 与 scenes 分支同式：按同名道具匹配旧行，算出「本次将要写入的最终行」，
    // name_en / description_en 也按「显式带值优先」继承旧值后再参与 diff ——
    // 否则会被 diff 误判为风险。
    const incomingRows = props.map((p) => {
      const oldRow = oldRows.find((r) => r.name === p.name)
      return {
        name: p.name,
        description: p.description || '',
        owner: p.owner || '',
        image_url: p.imageUrl || p.image_url || '',
        name_en: p.nameEn ?? oldRow?.name_en ?? '',
        description_en: p.descriptionEn ?? oldRow?.description_en ?? '',
      }
    })
    const report = computeExtractDiff({ table: 'props', oldRows, incoming: incomingRows })
    // decision 白名单 fail-safe（2026-09-16）：仅 'keep'/'accept' 有效。非法值（'Keep'/'ACCEPT'/任意脏值）
    // 一律按「未决策」处理——不落库、返回风险报告交前端确认，绝不落到覆盖分支（原 fail-open 方向错误）。
    if (report.hasRisk && decision !== 'keep' && decision !== 'accept') {
      return res.json({ risk: true, table: 'props', report })
    }
    if (report.hasRisk && decision === 'keep') {
      effectiveProps = applyKeepForProps(props, oldRows)
    }
    snapshotBeforeExtract({ episodeId, trigger: 'extract-props', tables: ['props'] })
  }

  transaction(() => {
    // DELETE+INSERT 重建前快照英文字段（name_en / description_en）与 owner：
    // props 也遵循同样的英文常量保全规则（与上方 scenes 分支同源，2026-09-16 补齐；
    // 2026-09-17 追加 description_en —— 道具英文描述与 name_en 同为 H3 提示词生产资产）。
    // 前端「提取资产」流程映射道具对象时不带 nameEn/descriptionEn 键，盲写空值会把手工维护的
    // 英文常量抹掉。规则：请求里显式带了值 → 用请求值（UI 编辑保存）；
    // 没带（undefined，JSON 里键不存在）→ 按同名道具继承旧值；旧道具也没有 → 空串。
    // 注意：必须用 ?? 而非 ||——空串代表用户主动清空，不能回退旧值。
    const oldEn = new Map(
      query('SELECT name, name_en, description_en, owner FROM props WHERE episode_id = ?', [episodeId])
        .map((r) => [r.name, r])
    )
    // 状态行快照 —— 与 oldEn 同式，在**本事务内**现读，不跨事务共用。
    // asset_states 用业务键（asset_key=道具名），重提换 id 不影响键，故继承是"再确认"：
    // DELETE 前读出本集道具名下的状态行，INSERT 后按业务键 upsert 回（UNIQUE 幂等护栏）。
    // 2026-09-17 删除修复（与 scenes 分支同源）：范围放宽到「请求体名字 ∪ DB 现存名字」，
    // 否则用户在设定页删掉道具后，其状态行会在这个全量重建里被静默清掉。
    const stateSnapshot = snapshotAssetStatesForNames('prop', [
      ...oldEn.keys(),
      ...props.map((p) => p.name),
    ])
    execute('DELETE FROM props WHERE episode_id = ?', [episodeId])
    for (const p of effectiveProps) {
      const imgUrl = p.imageUrl || p.image_url || ''
      const old = oldEn.get(p.name)
      // owner 是道具提示词的「专属角色」约束（doubao.js），空值会让约束静默消失，
      // 故与英文常量同口径继承旧值（显式带值优先）。
      const finalOwner = p.owner ?? old?.owner ?? ''
      execute(
        'INSERT INTO props (episode_id, name, description, owner, image_url, name_en, description_en) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [episodeId, p.name, p.description || '', finalOwner, imgUrl, p.nameEn ?? old?.name_en ?? '', p.descriptionEn ?? old?.description_en ?? '']
      )
    }
    // 状态行回迁（同事务内，业务键不变 → 幂等还原；被删道具的状态行也一并保留，不静默丢失）
    restoreAssetStates(stateSnapshot)
  })
  const result = query('SELECT * FROM props WHERE episode_id = ? ORDER BY id', [episodeId])
  res.json(result)
})

// 保存场景
router.post('/:id/scenes', (req, res) => {
  const { scenes = [], source = 'edit', decision = '', allowEmpty = false } = req.body
  // 保护：空列表默认拒收，防止误清库（如异常请求体把全量重建变成「删光」）。
  // 唯一放行口：source='edit' 且显式 allowEmpty=true —— 对应设定页「多选 → 全选 → 删除」，
  // 前端只在用户确认删光后才带这个标志；提取路径（extract）永远走不到这里，护栏依然生效。
  if (!Array.isArray(scenes) || (scenes.length === 0 && !(source === 'edit' && allowEmpty === true))) {
    return res.status(400).json({ error: '场景列表不能为空，已拒绝保存以保护现有数据' })
  }
  const episodeId = Number(req.params.id)

  // P1（2026-09-16）重新提取覆盖保护：仅在提取路径（source='extract'）启用。
  let effectiveScenes = scenes
  if (source === 'extract') {
    const oldRows = query('SELECT * FROM scenes WHERE episode_id = ? ORDER BY scene_number', [episodeId])
    // 按与下方 INSERT 完全同式的规则，算出「本次将要写入的最终行」——diff 比对的是
    // **最终生效值**（已应用英文常量「显式带值优先」继承），而非 LLM 原始值，
    // 避免把「实际不会被覆盖」的字段误报为风险。
    const incomingRows = scenes.map((s, i) => {
      const name = s.name || s.title || `场景${i + 1}`
      const old = oldRows.find((r) => r.title === name)
      const rawProps = Array.isArray(s.propNames) ? s.propNames : (Array.isArray(s.props) ? s.props : [])
      const propNames = rawProps.map(String).filter(Boolean)
      return {
        scene_number: i + 1,
        title: name,
        summary: s.description || s.summary || '',
        image_url: s.image_url || s.imageUrl || '',
        prop_names: JSON.stringify(propNames),
        title_en: s.titleEn ?? old?.title_en ?? '',
        summary_en: s.summaryEn ?? old?.summary_en ?? '',
        lighting_en: s.lightingEn ?? old?.lighting_en ?? '',
      }
    })
    const report = computeExtractDiff({ table: 'scenes', oldRows, incoming: incomingRows })
    // decision 白名单 fail-safe（2026-09-16）：仅 'keep'/'accept' 有效，非法值按「未决策」处理。
    if (report.hasRisk && decision !== 'keep' && decision !== 'accept') {
      // 有风险但尚未决策：**不落库**，把风险报告交前端二次确认（两个整批按钮：全部保留我的 / 接受新值）
      return res.json({ risk: true, table: 'scenes', report })
    }
    if (report.hasRisk && decision === 'keep') {
      // 「全部保留我的」：同名场景受保护字段回退旧值 + 被删场景整行复原
      effectiveScenes = applyKeepForScenes(scenes, oldRows)
    }
    // 覆盖前自动快照（在 DELETE 之前；无风险静默落库前也留底，失败不阻断）
    snapshotBeforeExtract({ episodeId, trigger: 'extract-scenes', tables: ['scenes'] })
  }

  // 冷暖判定待办清单（2026-09-18）：在事务内**只收集**，事务提交后再异步调 LLM 判定。
  // 见循环内的说明——LLM 是网络 IO，不能放进 better-sqlite3 的同步事务。
  const lightingQueue = []
  transaction(() => {
    // DELETE+INSERT 重建前快照英文字段（title_en/summary_en/lighting_en）：
    // 前端「提取资产」流程映射场景对象时不带这些键，盲写空值会把手工维护的
    // 英文描述与光影常量抹掉（2026-09-11 前的隐性数据丢失坑）。规则：
    // 请求里显式带了值 → 用请求值（UI 编辑保存）；
    // 没带（undefined，JSON 里键不存在）→ 按同名场景继承旧值；旧场景也没有 → 空串。
    const oldEn = new Map(
      query('SELECT title, title_en, summary_en, lighting_en, location FROM scenes WHERE episode_id = ?', [episodeId])
        .map((r) => [r.title, r])
    )
    // P2'（2026-09-17）：状态行快照 —— 与 oldEn 同式，在**本事务内**现读，不跨事务共用（与 props 分支各自独立）。
    // 2026-09-17 删除修复：快照范围从「DB 现存全部场景名」算起，而不是只算 oldEn 的键。
    // 原因：用户在资产设定页单张/批量删掉场景后调本接口是**全量重建**（先 DELETE 再按请求体 INSERT），
    // 若快照只覆盖「请求体里的名字」，被删场景挂在业务键上的 asset_states 行就会在此刻被静默清掉
    // ——删除因此在界面上「没做完」。这里把范围放宽到请求体名字 ∪ DB 现存名字，删除时状态行原样保留。
    const stateSnapshot = snapshotAssetStatesForNames('scene', [
      ...oldEn.keys(),
      ...scenes.map((s, i) => s.name || s.title || `场景${i + 1}`),
    ])
    // ── 2026-09-17 空间组视图 · id 稳定化改造 ───────────────────────────────
    // 旧行为：全表 DELETE+INSERT——删 1 个场景，存活场景的 id 也全部换新。连锁反应：
    //   scene_analysis/scene_anchors 的 scene_id 全成死引用；指纹（含 id）必变 →
    //   每次保存都触发一次全量 LLM 重析（十几秒起）；confirmed 组的空间基准锚失效。
    // 新行为：UPSERT diff——按 id 优先、title 兜底匹配旧行，命中即 UPDATE 保 id；
    //   只有「真删的」才 DELETE、「真新的」才 INSERT。
    //   edit 路径前端带 DB id（新建是临时 id，落空走 title/INSERT）；
    //   extract 路径 LLM 行无旧 id，靠 title 命中保 id——同名场景重提后，
    //   confirmed 组的空间基准锚（scene_id 指向代表场）不再失效。
    const oldRowsTx = query('SELECT * FROM scenes WHERE episode_id = ? ORDER BY scene_number', [episodeId])
    const oldById = new Map(oldRowsTx.map((r) => [r.id, r]))
    const oldByTitle = new Map(oldRowsTx.map((r) => [r.title, r]))
    const seenOldIds = new Set()
    let inserted = 0
    // 指纹语义的变化数（与 fingerprintOf 的构成对齐：scene_number/title/summary；
    // image_url 不算——指纹本就不含图，出图不该触发重析）
    let contentChanged = 0

    for (let i = 0; i < effectiveScenes.length; i++) {
      const s = effectiveScenes[i]
      const name = s.name || s.title || `场景${i + 1}`
      const imgUrl = s.image_url || s.imageUrl || ''
      const rawProps = Array.isArray(s.propNames) ? s.propNames : (Array.isArray(s.props) ? s.props : [])
      // 本行最终落库的场景 id（UPDATE 用旧 id / INSERT 用新 id）——告警要带它
      let finalSceneId = null
      const propNames = rawProps.map(String).filter(Boolean)
      const old = oldEn.get(name)
      // 本次落库的最终值（与 UPDATE/INSERT 参数同式），用于 P3 冷暖自洽校验
      const finalSummary = s.description || s.summary || ''
      const finalLightingEn = s.lightingEn ?? old?.lighting_en ?? ''
      // location 规则不变（2026-09-17 删除修复）：edit 不跨行继承，extract 才回退同名旧值
      const finalLocation = s.location
        ?? (source === 'extract' ? old?.location : undefined)
        ?? name
      const finalTitleEn = s.titleEn ?? old?.title_en ?? ''
      const finalSummaryEn = s.summaryEn ?? old?.summary_en ?? ''

      // 匹配旧行：id 优先（edit 路径前端带 DB id），title 兜底（extract / 临时 id）
      let target = null
      const rawId = Number(s.id)
      if (rawId && oldById.has(rawId)) {
        target = oldById.get(rawId)
      } else {
        const byTitle = oldByTitle.get(name)
        if (byTitle && !seenOldIds.has(byTitle.id)) target = byTitle
      }

      if (target) {
        seenOldIds.add(target.id)
        if (target.scene_number !== i + 1 || target.title !== name || (target.summary || '') !== finalSummary) contentChanged++
        execute(
          'UPDATE scenes SET scene_number = ?, title = ?, summary = ?, image_url = ?, prop_names = ?, title_en = ?, summary_en = ?, lighting_en = ?, location = ? WHERE id = ?',
          [i + 1, name, finalSummary, imgUrl, JSON.stringify(propNames), finalTitleEn, finalSummaryEn, finalLightingEn, finalLocation, target.id]
        )
        finalSceneId = target.id
      } else {
        inserted++
        const ins = execute(
          'INSERT INTO scenes (episode_id, scene_number, title, summary, image_url, prop_names, title_en, summary_en, lighting_en, location) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [episodeId, i + 1, name, finalSummary, imgUrl, JSON.stringify(propNames), finalTitleEn, finalSummaryEn, finalLightingEn, finalLocation]
        )
        finalSceneId = Number(ins.lastInsertRowid) || null
      }
      // P3（2026-09-18 改造）：冷暖自洽校验从「事务内同步词表判断」改为「事务外异步 LLM 判断」。
      //   ⚠️ 为什么必须挪出事务：判定要调 LLM（网络 IO，秒级），而这是 better-sqlite3 的**同步事务**——
      //      在里面 await 会让整个事务长期持锁，且事务回调本身不是 async。故此处只**收集待判清单**，
      //      待 transaction() 返回后统一判定（见本函数末尾的 runLightingChecks 调用）。
      //   sceneId 一并收集：告警必须带场景身份，否则前端按场景过滤的展示路径看不到它
      //      （初版就是这个缺陷——告警只带 episodeId，2 条真实告警成了前端永远看不见的孤儿）。
      lightingQueue.push({
        name,
        sceneId: finalSceneId,
        sceneNumber: i + 1,
        summary: finalSummary,
        lightingEn: finalLightingEn,
      })
    }

    // 真删的才删：旧行没被任何传入行匹配上
    const deletedRows = oldRowsTx.filter((r) => !seenOldIds.has(r.id))
    for (const r of deletedRows) execute('DELETE FROM scenes WHERE id = ?', [r.id])

    // ── 外科清理死引用（同事务）──────────────────────────────────────────
    // scene_analysis 死行（被删场景的分析行；extract 全量换 id 时此处等价全清，
    // 与旧行为一致——指纹随后必变，下次 ensure 全量重析重建）
    execute('DELETE FROM scene_analysis WHERE episode_id = ? AND scene_id NOT IN (SELECT id FROM scenes WHERE episode_id = ?)', [episodeId, episodeId])
    // 空间基准锚的 baseline 场景死了 → 该组回 pending 等人重定 + 锚行删（先取 key 再删）。
    // review 行本身保留：组里还有其他存活成员，重定基准即可，不必抹掉整组审核记录。
    const deadSpatial = query(
      `SELECT anchor_key FROM scene_anchors WHERE episode_id = ? AND anchor_type = 'spatial' AND scene_id NOT IN (SELECT id FROM scenes WHERE episode_id = ?)`,
      [episodeId, episodeId]
    )
    for (const row of deadSpatial) {
      execute(`UPDATE spatial_group_review SET status = 'pending', baseline_image_url = '', updated_at = CURRENT_TIMESTAMP WHERE episode_id = ? AND spatial_group = ?`, [episodeId, row.anchor_key])
      execute(`DELETE FROM scene_anchors WHERE episode_id = ? AND anchor_type = 'spatial' AND anchor_key = ?`, [episodeId, row.anchor_key])
    }
    // 场景锚（anchor_type='scene'）死行。prop 锚不动：图文件仍在且语义挂道具名，
    // 下次重析会从存活场景自动重建。
    execute(`DELETE FROM scene_anchors WHERE episode_id = ? AND anchor_type = 'scene' AND scene_id NOT IN (SELECT id FROM scenes WHERE episode_id = ?)`, [episodeId, episodeId])

    // 状态行回迁（同事务内，业务键不变 → 幂等还原；被删场景的状态行也一并保留，不静默丢失）
    restoreAssetStates(stateSnapshot)

    // ── 纯删除快速通道 ───────────────────────────────────────────────────
    // 纯删除（无新增、无指纹语义变化、只有删除）时：分析行已外科清理，剩余分析对
    // 存活场景仍然有效（空间组是局部关系，删成员不改变其他组的分组）——直接顺延
    // 指纹，让 ensureSceneAnalysis 命中缓存，**不调 LLM**。
    // 前提：scene_analysis 恰好全覆盖存活场景（UNIQUE(episode_id, scene_id) 保证
    // 一一对应）；否则（例如此前就有未分析的新场景）不顺延，交给下次 ensure 全量重析。
    if (deletedRows.length > 0 && inserted === 0 && contentChanged === 0) {
      const analysisCount = queryOne('SELECT COUNT(*) AS c FROM scene_analysis WHERE episode_id = ?', [episodeId])?.c || 0
      const liveCount = queryOne('SELECT COUNT(*) AS c FROM scenes WHERE episode_id = ?', [episodeId])?.c || 0
      if (analysisCount === liveCount) {
        const live = query('SELECT id, scene_number, title, summary, image_url FROM scenes WHERE episode_id = ? ORDER BY scene_number', [episodeId])
        execute('UPDATE scene_analysis SET fingerprint = ? WHERE episode_id = ?', [fingerprintOf(live), episodeId])
      }
    }
  })

  const result = query('SELECT * FROM scenes WHERE episode_id = ? ORDER BY scene_number', [episodeId])

  // 冷暖自洽校验（事务外异步，2026-09-18）：
  //   **不 await** —— 判定要调 LLM（秒级），await 会让"保存场景"这个请求白等好几秒，
  //   而用户此刻只关心"存没存上"。判定是**后置增强**，告警晚几秒到无妨（前端下次 loadAlerts 可见）。
  //   失败也绝不能影响响应：runLightingChecks 内部整体兜底。
  //   ⚠️ 刻意 fire-and-forget 而非 await：与项目既有的"出片后置钩子链"同范式。
  runLightingChecks(lightingQueue, episodeId, recordAlert)
    .catch((e) => console.warn('[lightingCheck] 后置校验整体异常（已忽略）:', e.message))

  res.json(result)
})

// 登记资产提取指纹（提取动作在后端，落库靠前端再调保存接口，二者解耦）：
// 前端在角色/场景/道具三类全部保存成功后调用此端点写入 assets_script_fp，
// 保证「指纹登记」与「资产真正落库」原子一致——提取后放弃保存不会让 stale 判定假阴性
router.post('/:id/extract-info', (req, res) => {
  const { assetsScriptFp } = req.body
  if (!assetsScriptFp || !String(assetsScriptFp).trim()) {
    return res.status(400).json({ error: 'assetsScriptFp 必填' })
  }
  const episode = queryOne('SELECT id FROM episodes WHERE id = ?', [req.params.id])
  if (!episode) return res.status(404).json({ error: '集不存在' })
  execute('UPDATE episodes SET assets_script_fp = ? WHERE id = ?', [String(assetsScriptFp), req.params.id])
  res.json({ success: true })
})

// 保存分镜
router.post('/:id/storyboard', (req, res) => {
  const { storyboardScenes = [], storyboard_confirmed, storyboard_source } = req.body
  // 防御：空数组会把该集全部分镜删光，必须拒绝
  if (!Array.isArray(storyboardScenes) || storyboardScenes.length === 0) {
    return res.status(400).json({ error: 'storyboardScenes 不能为空' })
  }
  transaction(() => {
    // ===== 增量更新：按「场景号 + 镜头号」匹配，已有记录保留原 ID 只更新内容，新增才插入，多余才删除 =====
    // 目的：镜头 ID 稳定，避免前端因「删旧插新」导致的 ID 漂移（"镜头不存在"）
    const episodeId = req.params.id

    // 1. 查现有场景和镜头，建立 (scene_number -> scene.id) 与 (sceneId:shot_number -> shot.id) 映射
    const existingScenes = query('SELECT id, scene_number FROM storyboard_scenes WHERE episode_id = ?', [episodeId])
    const sceneIdByNum = new Map(existingScenes.map((s) => [s.scene_number, s.id]))
    const existingShots = query(
      `SELECT s.id, s.storyboard_scene_id, s.shot_number
       FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id
       WHERE ss.episode_id = ?`,
      [episodeId]
    )

    // 兜底校验用的本集资产名单（@ 提及并集）
    const episodeAssetNames = {
      characters: query('SELECT name FROM characters WHERE episode_id = ?', [episodeId]).map((r) => r.name),
      scenes: query('SELECT title FROM scenes WHERE episode_id = ?', [episodeId]).map((r) => r.title),
      props: query('SELECT name FROM props WHERE episode_id = ?', [episodeId]).map((r) => r.name),
    }
    const shotIdByKey = new Map(existingShots.map((s) => [`${s.storyboard_scene_id}:${s.shot_number}`, s.id]))

    const keepSceneIds = new Set()
    const keepShotIds = new Set()

    // 2. 遍历新分镜：场景和镜头都尽量复用旧 ID
    for (let si = 0; si < storyboardScenes.length; si++) {
      const s = storyboardScenes[si]
      const sceneNumber = si + 1
      const sceneTitle = s.title || `场次${sceneNumber}`
      let sceneId = sceneIdByNum.get(sceneNumber)
      if (sceneId == null) {
        const r = execute(
          'INSERT INTO storyboard_scenes (episode_id, scene_number, title) VALUES (?, ?, ?)',
          [episodeId, sceneNumber, sceneTitle]
        )
        sceneId = r.lastInsertRowid
      } else {
        execute('UPDATE storyboard_scenes SET title = ? WHERE id = ?', [sceneTitle, sceneId])
      }
      keepSceneIds.add(sceneId)

      for (let shi = 0; shi < (s.shots || []).length; shi++) {
        const shot = s.shots[shi]
        const shotNumber = shot.shotNumber || shot.shot_number || `${sceneNumber}-${shi + 1}`
        const shotId = shotIdByKey.get(`${sceneId}:${shotNumber}`)

        // 兜底：AI Prompt/finalFrame 里 @ 提到的资产强制并入关联数组，
        // 防止 Airlock 继承的在场角色被漏登记导致生图缺参考图
        backfillShotAssets(shot, episodeAssetNames)

        const fields = [
          shot.duration || 8,
          shot.description || '',
          JSON.stringify(shot.characters || []),
          JSON.stringify(shot.sceneAssets || []),
          JSON.stringify(shot.propAssets || []),
          shot.storyboardUrl || '',
          shot.frameUrl || '',
          shot.blockingUrl || '',
          shot.videoUrl || '',
          shot.videoGenerated ? 1 : 0,
          shot.shotType || shot.shot_type || '',
          shot.startTime || shot.start_time || 0,
          shot.endTime || shot.end_time || 0,
          shot.actionNote || shot.action_note || '',
          shot.soundEffects || shot.sound_effects || '',
          // 写侧：**这是 "null" 脏值的根因**（typeof null === 'object' → JSON.stringify(null)='null'）。
          // serializeDialogue 把 null/undefined 落成 ''，从源头不再产出 "null"；
          // 已是字符串的按原样透传（前端可直接回传序列化串），其余形态语义不变。
          serializeDialogue(shot.dialogue),
          shot.cameraMovement || shot.camera_movement || '',
          shot.overallSoundscape || shot.overall_soundscape || '',
          shot.nonDiegeticMusic || shot.non_diegetic_music || '',
          shot.integratedMultimodalDescription || shot.integrated_multimodal_description || '',
          shot.finalFrame || shot.final_frame || '',
          // 戏型：AI 标注优先；没标注给 null（出片时按内容实时判定，不覆盖人工设置）
          shot.isCombat === true || shot.isCombat === false
            ? (shot.isCombat ? 1 : 0)
            : (shot.is_combat === 0 || shot.is_combat === 1 ? shot.is_combat : null),
        ]
        // 机位朝向：AI 标注（camera_angle）或前端回传（cameraAngle）；空值给 null，
        // UPDATE 走 COALESCE 保留旧值，避免前端未回传时把已有机位抹掉
        const camAngle = shot.camera_angle || shot.cameraAngle || null

        if (shotId == null) {
          const r = execute(
            `INSERT INTO shots (storyboard_scene_id, shot_number, duration, description, characters, scene_assets, prop_assets, storyboard_url, frame_url, blocking_url, video_url, video_generated, shot_type, start_time, end_time, action_note, sound_effects, dialogue, camera_movement, overall_soundscape, non_diegetic_music, integrated_multimodal_description, final_frame, is_combat, camera_angle)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [sceneId, shotNumber, ...fields, camAngle || '']
          )
          keepShotIds.add(r.lastInsertRowid)
        } else {
          // blocking_plan / frame_url2 / continuity_url 随镜头内容走（同款「不传即清」契约）：
          // - 确认分镜回传：前端全量对象带回 frameUrl2/continuityUrl → 原样写回保留
          // - 重新生成/导入保存：新 shot 对象不带这些字段 → 清空。旧尾帧图/旧成片末帧锚
          //   对新分镜内容失效，残留会让 V4 出片把新镜头锚死在旧构图上（endframe/continuity 双锚）
          const planValue = shot.blockingPlan ? JSON.stringify(shot.blockingPlan) : ''
          const frameUrl2Value = shot.frameUrl2 !== undefined ? shot.frameUrl2 : ''
          const continuityUrlValue = shot.continuityUrl !== undefined ? shot.continuityUrl : ''
          const keyframeUrlValue = shot.keyframeUrl !== undefined ? shot.keyframeUrl : ''
          execute(
            `UPDATE shots SET duration=?, description=?, characters=?, scene_assets=?, prop_assets=?, storyboard_url=?, frame_url=?, blocking_url=?, video_url=?, video_generated=?, shot_type=?, start_time=?, end_time=?, action_note=?, sound_effects=?, dialogue=?, camera_movement=?, overall_soundscape=COALESCE(NULLIF(?, ''), overall_soundscape), non_diegetic_music=COALESCE(NULLIF(?, ''), non_diegetic_music), integrated_multimodal_description=?, final_frame=?, is_combat=COALESCE(?, is_combat), camera_angle=COALESCE(?, camera_angle), blocking_plan=?, frame_url2=?, continuity_url=?, keyframe_url=? WHERE id=?`,
            [...fields, camAngle, planValue, frameUrl2Value, continuityUrlValue, keyframeUrlValue, shotId]
          )
          keepShotIds.add(shotId)
        }
      }
    }

    // 3. 删除不再存在的镜头
    for (const s of existingShots) {
      if (!keepShotIds.has(s.id)) execute('DELETE FROM shots WHERE id = ?', [s.id])
    }
    // 4. 删除不再存在的场景
    for (const s of existingScenes) {
      if (!keepSceneIds.has(s.id)) execute('DELETE FROM storyboard_scenes WHERE id = ?', [s.id])
    }
    // 5. 重编镜头号 = 场次号 + 场次内序号。
    //    根因：上面第 2 步优先沿用前端回传的 shotNumber（旧值），而保存时场次可能已
    //    增删或重排（如插入「雪崩」场次），旧编号不会跟着变，于是出现「场次2 的镜头叫
    //    1-2、场次9 叫 8-1」这类前缀错位（历史坑）。这里把显示号拉回与场次一致。
    //    必须放在 ID 匹配完成之后：匹配依赖旧编号作为稳定键，重编号只改显示值。
    //    顺序基准与前端一致：start_time 升序，相同则按 id（即插入顺序）。
    //    注意 SQLite 里 || 的优先级高于 +，序号的 +1 必须单独用括号包住，
    //    否则会被解析成 ('1-0') + 1 → 2（数值强转），编号全错。
    execute(
      `UPDATE shots SET shot_number = (
         SELECT ss.scene_number || '-' || (
           (SELECT COUNT(*) FROM shots s2
            WHERE s2.storyboard_scene_id = shots.storyboard_scene_id
              AND (s2.start_time < shots.start_time
                   OR (s2.start_time = shots.start_time AND s2.id < shots.id))
           ) + 1
         )
         FROM storyboard_scenes ss WHERE ss.id = shots.storyboard_scene_id
       )
       WHERE storyboard_scene_id IN (SELECT id FROM storyboard_scenes WHERE episode_id = ?)`,
      [episodeId]
    )
  })
  // 分镜成功落库即登记剧本指纹（不再仅确认时登记）：
  // 用户保存分镜 = 认可当前分镜内容与当前剧本匹配；若只提取不保存，指纹不更新，stale 判定仍准确
  const epForFp = queryOne('SELECT script_content FROM episodes WHERE id = ?', [req.params.id])
  if (epForFp?.script_content) {
    execute('UPDATE episodes SET storyboard_script_fp = ? WHERE id = ?', [scriptHash(epForFp.script_content), req.params.id])
  }
  // 来源：generated=AI 从剧本生成；imported=用户上传分镜脚本。导入的分镜不随剧本改动提示过期
  const normalizedSource = storyboard_source === 'imported' ? 'imported' : 'generated'
  execute('UPDATE episodes SET storyboard_source = ? WHERE id = ?', [normalizedSource, req.params.id])
  if (storyboard_confirmed !== undefined) {
    execute('UPDATE episodes SET storyboard_confirmed = ? WHERE id = ?', [storyboard_confirmed ? 1 : 0, req.params.id])
  }
  res.json({ success: true })
})

// 清空该集全部分镜。
// 与 POST /:id/storyboard 的「空数组拒绝」分开：那条防御是拦程序误传空数据，
// 这里是用户明确点名要删，走独立 DELETE 语义，不必为了清空去放宽保存的防御。
router.delete('/:id/storyboard', (req, res) => {
  const episodeId = req.params.id
  try {
    // 删段前先记下段 id（P2-8）：段行一删，切片子目录 segments/seg{id}/ 就再也无从定位，
    // 会变成永不被回收的孤儿目录。先收集、事务后连盘一起清。
    const segIds = query('SELECT id FROM video_segments WHERE episode_id = ?', [episodeId]).map((r) => r.id)
    transaction(() => {
      // 外键是 ON DELETE CASCADE，但数据库未必开了 PRAGMA foreign_keys，显式先删镜头更稳
      execute(
        `DELETE FROM shots WHERE storyboard_scene_id IN (SELECT id FROM storyboard_scenes WHERE episode_id = ?)`,
        [episodeId]
      )
      execute('DELETE FROM storyboard_scenes WHERE episode_id = ?', [episodeId])
      // 段方案随分镜一起清（段是分镜的包装层，镜没了段无意义）
      execute('DELETE FROM video_segments WHERE episode_id = ?', [episodeId])
      // 没有分镜了，指纹、确认态与来源一起归零，避免残留「分镜已过期」或「导入来源」的误提示
      execute('UPDATE episodes SET storyboard_script_fp = NULL, storyboard_confirmed = 0, storyboard_source = ? WHERE id = ?', ['generated', episodeId])
    })
    // 分镜已清空 → 人工忽略记录一并作废（镜头都没了，忽略的"目标"不存在了）
    clearQcIgnores(episodeId)
    // 切片目录回收：镜已全删，切片文件全库 0 引用，可安全整体回收（顺序在改库之后）
    if (segIds.length) {
      const trashDir = path.join(__dirname, '..', '_video_trash', String(Date.now()))
      for (const sid of segIds) recycleSliceDir(path.join('segments', `seg${sid}`), trashDir)
    }
    res.json({ success: true })
  } catch (e) {
    console.error('[清空分镜失败]', e)
    res.status(500).json({ error: e.message || '清空分镜失败' })
  }
})

// ===== 段方案（E 路线 v2）：查看 / 重算 / 落库 =====
// 段是**出片包装层**——镜表与分镜数据一个字不动（改分镜会触发剧本指纹失配，
// 为已完工的集制造返工）。段边界只影响"哪些镜拼成一次生成"。
// GET  : 读现有段方案（已落库的 video_segments）
// POST : 重算段方案（body { persist: true } 时落库；默认只算不写，供前端预览）
router.get('/:id/segments', (req, res) => {
  const episodeId = Number(req.params.id)
  const rows = query(
    'SELECT * FROM video_segments WHERE episode_id = ? ORDER BY scene_number, segment_index',
    [episodeId]
  )
  res.json({
    segments: rows.map((r) => {
      // 同 segmentPlan：权威段时长 = 区间长度（P1-2 修复）
      const span = (r.start_time != null && r.end_time != null)
        ? Number((Number(r.end_time) - Number(r.start_time)).toFixed(3))
        : null
      return {
        id: r.id,
        sceneNumber: r.scene_number,
        segmentIndex: r.segment_index,
        shotNumbers: r.shot_numbers,
        startTime: r.start_time,
        endTime: r.end_time,
        duration: span,
        durationSec: span,
        videoUrl: r.video_url || '',
        anchorFrameUrl: r.anchor_frame_url || '',
        status: r.status,
        error: r.error || '',
      }
    }),
  })
})

// GET /:id/segments/staleness —— 段方案是否已过期（2026-09-16）
//
// 为什么需要这个接口：段方案是按「镜表指纹」校验的，用户改了镜长/删镜/重排后段记录就过期了。
// 但此前「过期」只在**切片那一刻**才被发现——那时币已经烧掉了（出片成功 → 切片才判 stale）。
// 用户没有任何「我现在该重算了」的前置信号，只能靠记住或踩坑。
//
// 本接口把判定提前暴露给 UI：分镜页/短片页可以据此主动提示「分镜已改动，请重算段方案」。
// 判定口径与 segmentSlicer 完全同源（同一 shotsFingerprint + 同一「空指纹视为过期」规则），
// 避免两处实现漂移——这是本项目已踩过的坑（见 overview「口径重复实现」）。
router.get('/:id/segments/staleness', async (req, res) => {
  const episodeId = Number(req.params.id)
  try {
    const { segmentStaleness } = await import('../ai/segmentBuilder.js')
    const rows = query(
      'SELECT id, shots_fp, status, episode_id FROM video_segments WHERE episode_id = ?',
      [episodeId]
    )
    if (!rows.length) {
      return res.json({ episodeId, hasPlan: false, stale: false, staleCount: 0, total: 0, reason: 'no_plan' })
    }
    // 与出片闸门/切片器同源：逐段用 segmentStaleness 判定，不在这里另写一份规则
    const judged = rows.map((r) => ({ row: r, verdict: segmentStaleness(r) }))
    // 显式标了 stale 的段也算（切片器判定后落库的状态）
    const isStale = (j) => j.verdict.stale || j.row.status === 'stale'
    const staleRows = judged.filter(isStale)
    res.json({
      episodeId,
      hasPlan: true,
      stale: staleRows.length > 0,
      staleCount: staleRows.length,
      total: rows.length,
      // 细分原因：空指纹（老数据/未迁移）与指纹失配（分镜改动过）对用户的含义不同
      emptyFingerprint: staleRows.filter((j) => !j.row.shots_fp).length,
      fingerprintMismatch: staleRows.filter((j) => j.row.shots_fp && j.verdict.stale).length,
      currentFingerprint: judged[0]?.verdict.currentFingerprint || '',
      reason: staleRows.length ? 'stale' : 'fresh',
    })
  } catch (e) {
    // 探测失败不能干扰主流程：返回未知态，前端不提示即可（不阻塞出片）
    res.json({ episodeId, hasPlan: false, stale: false, staleCount: 0, total: 0, reason: 'error', error: String(e?.message || e) })
  }
})

router.post('/:id/segments', async (req, res) => {
  const episodeId = Number(req.params.id)
  // replace 默认 true（2026-09-16）：默认 false 时「重算」只补不删、且不重写指纹，
  // 无法修复过期段 —— 与全站「请重算段方案」的提示形成死循环。详见 persistSegments 头注。
  const { persist = false, replace = true, scene = null } = req.body || {}
  try {
    const { buildSegments, formatPlan, persistSegments, SEG_MIN_SEC, SEG_MAX_SEC } = await import('../ai/segmentBuilder.js')
    const plan = buildSegments(episodeId, scene != null ? { scene: Number(scene) } : {})
    let write = null
    if (persist) {
      // unusable 段落库时被过滤（见 persistSegments 头注 P1-1），返回 skipped 供前端告警。
      // 只有「全部段都非法」才会抛错——那不是降级，是无方案可用。
      write = persistSegments(plan, { replace, episodeId })
    }
    // 非法段提示：落库时被跳过的段（时长不在 3–15s）——前端应提示「这几段需逐镜出片」。
    // 注意：即使 unpersist（仅预览）也返回，让用户在落库前就看见。
    const unusableSegments = plan.scenes.flatMap((sc) => sc.segments
      .filter((s) => s.status === 'unusable')
      .map((s) => ({ sceneNumber: s.sceneNumber, segmentIndex: s.segIndexInScene, shotNumbers: s.shotNumbers.join('+'), durationSec: s.durationSec })))
    res.json({
      success: true,
      totals: plan.totals,
      warnings: plan.warnings,
      plan: formatPlan(plan),
      // 镜表指纹：前端可据此判断「页面上展示的段是否基于当前分镜」
      shotsFp: plan.shotsFp || '',
      isEmpty: Boolean(plan.isEmpty),
      // 非法段清单（已从落库中剔除，需逐镜出片）
      unusableSegments,
      segments: plan.scenes.flatMap((sc) => sc.segments.map((s) => ({
        sceneNumber: s.sceneNumber,
        segmentIndex: s.segIndexInScene,
        shotNumbers: s.shotNumbers,
        duration: s.durationSec,
        startTime: s.startTime,
        endTime: s.endTime,
        anchorMode: s.anchorMode,
        status: s.status,
        shotsFp: plan.shotsFp || '',
      }))),
      write,
    })
  } catch (e) {
    console.error('[段方案] 计算失败', e)
    res.status(500).json({ error: e.message || '段方案计算失败' })
  }
})

// 段切片回填（补刀入口）：段成片已存在但切片没跑/跑挂时手动触发。
// 出片端点出片成功后会自动切片，这个入口是给历史数据与故障恢复用的。
router.post('/:id/segments/slice', async (req, res) => {
  const episodeId = Number(req.params.id)
  const { scene = null, force = false, segmentId = null } = req.body || {}
  try {
    const { sliceSegment, sliceEpisode } = await import('../ai/segmentSlicer.js')
    if (segmentId != null) {
      const r = await sliceSegment(Number(segmentId), { force })
      return res.json(r)
    }
    const r = await sliceEpisode(episodeId, { scene: scene != null ? Number(scene) : null, force })
    res.json(r)
  } catch (e) {
    console.error('[段切片] 失败', e)
    res.status(500).json({ error: e.message || '段切片失败' })
  }
})

// 更新单个镜头（用于保存生成的图片/视频URL）
router.put('/:id/shots/:shotId', (req, res) => {
  const {
    storyboard_url, frame_url, frame_url2, blocking_url, video_url, video_generated,
    description, duration, shot_type, start_time, end_time, action_note,
    sound_effects, dialogue, camera_movement, overall_soundscape,
    non_diegetic_music, integrated_multimodal_description, blocking_plan, blockingPlan, final_frame, finalFrame,
    video_prompt_override,
    is_combat,
    camera_angle, cameraAngle,
  } = req.body
  console.log('[/episodes/:id/shots/:shotId] update', { episodeId: req.params.id, shotId: req.params.shotId, hasStoryboardUrl: !!storyboard_url, hasFrameUrl: !!frame_url, hasFrameUrl2: frame_url2 !== undefined, hasBlockingUrl: !!blocking_url, hasBlockingPlan: blocking_plan !== undefined })

  // 集归属校验（2026-09-16 审核修复 P2-7）：本路由原只 `WHERE id = ?` 定位镜头，
  // 不校验该镜是否真属于 URL 里的这集 —— 传错 episodeId 就能改到别的集的镜头。
  // 对照：批量删成片（deleteShotVideos）已用 JOIN 限定本集，此处属唯一漏网。
  // 找不到该镜 / 该镜不属于本集，一律 404（不区分，避免暴露他集镜号是否存在）。
  const ownedShot = queryOne(
    `SELECT s.id FROM shots s
       JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id
      WHERE s.id = ? AND ss.episode_id = ?`,
    [req.params.shotId, req.params.id]
  )
  if (!ownedShot) {
    return res.status(404).json({ error: '镜头不存在或不属于该集' })
  }
  // blocking_plan 兼容对象或字符串：对象则序列化，null/undefined 保留旧值（COALESCE）
  let blockingPlanValue
  if (blocking_plan !== undefined) {
    blockingPlanValue = typeof blocking_plan === 'object' ? JSON.stringify(blocking_plan) : blocking_plan
  } else if (blockingPlan !== undefined) {
    blockingPlanValue = typeof blockingPlan === 'object' ? JSON.stringify(blockingPlan) : blockingPlan
  } else {
    blockingPlanValue = null
  }
  const finalFrameValue = final_frame !== undefined ? final_frame : (finalFrame !== undefined ? finalFrame : null)
  execute(
    `UPDATE shots SET
       storyboard_url = COALESCE(?, storyboard_url),
       frame_url = COALESCE(?, frame_url),
       frame_url2 = COALESCE(?, frame_url2),
       blocking_url = COALESCE(?, blocking_url),
       video_url = COALESCE(?, video_url),
       video_generated = COALESCE(?, video_generated),
       description = COALESCE(?, description),
       duration = COALESCE(?, duration),
       shot_type = COALESCE(?, shot_type),
       start_time = COALESCE(?, start_time),
       end_time = COALESCE(?, end_time),
       action_note = COALESCE(?, action_note),
       sound_effects = COALESCE(?, sound_effects),
       dialogue = COALESCE(?, dialogue),
       camera_movement = COALESCE(?, camera_movement),
       overall_soundscape = COALESCE(NULLIF(?, ''), overall_soundscape),
       non_diegetic_music = COALESCE(NULLIF(?, ''), non_diegetic_music),
       integrated_multimodal_description = COALESCE(?, integrated_multimodal_description),
       blocking_plan = COALESCE(?, blocking_plan),
       final_frame = COALESCE(?, final_frame),
       video_prompt_override = COALESCE(?, video_prompt_override),
       is_combat = COALESCE(?, is_combat),
       camera_angle = COALESCE(?, camera_angle)
     WHERE id = ?`,
    [storyboard_url, frame_url, frame_url2, blocking_url, video_url, video_generated, description, duration,
      shot_type, start_time, end_time, action_note, sound_effects, dialogue,
      camera_movement, overall_soundscape, non_diegetic_music,
      integrated_multimodal_description, blockingPlanValue, finalFrameValue,
      // 手工终稿保护（2026-09-15）：只有非空字符串才更新 override；
      // 空串/空白/未提供一律 → null → COALESCE 保留库内现值。
      // 旧写法 `!== undefined ? v : null` 会让前端表单回传的 '' 穿透 COALESCE，
      // 把已写好的英文终稿静默清空（第 2 集场 1 事故根因）。
      (typeof video_prompt_override === 'string' && video_prompt_override.trim()) ? video_prompt_override.trim() : null,
      is_combat !== undefined ? (is_combat ? 1 : 0) : null,
      (camera_angle !== undefined ? camera_angle : cameraAngle) || null,
      req.params.shotId]
  )
  const shot = queryOne('SELECT * FROM shots WHERE id = ?', [req.params.shotId])
  res.json(shot)
})


// ===== 删除成片（短片页）：单镜删除 + 批量删除 =====
// 语义（与用户确认，勿改）：
//   1) 磁盘 mp4 不物理删除，移入 _video_trash/<时间戳>/ 回收站（可回捞）；
//   2) 批量删除由前端传 shotIds 数组；
//   3) 段级联动——被删镜头的成片若来自段级切片（该镜属于某个 video_segments 且段 video_url 非空），
//      则连带整段一起删：段成片移入回收站、段 video_url='' status='pending'、同段所有镜回退未出片。
//
// 为什么先改库再动盘（与 DELETE /:id 同套路）：同一 uploads 文件可能被多行共享，必须先用
//   filterUnreferencedUploadUrls 筛出「全库已无任何引用」的候选再移文件，否则会产生别处仍引用的死链。
//
// 把本地 /uploads/ 文件移入回收站（保留相对子目录结构）。返回实际移动的文件数。
// 路径穿越防护同 ai/shared.js 的 removeLocalUploads：resolve 后必须仍落在 uploads 目录内，剥查询串；
// 跨设备（uploads 与回收站不同分区）renameSync 会抛 EXDEV，退化为 copyFileSync + unlinkSync。
function moveUploadsToTrash(urls, trashDir) {
  const root = path.resolve(UPLOAD_DIR)
  let moved = 0
  for (const u of urls || []) {
    if (!u || !String(u).startsWith('/uploads/')) continue
    try {
      const rel = decodeURIComponent(String(u).split(/[?#]/)[0]).replace(/^\/uploads\//, '')
      const abs = path.resolve(root, rel)
      if (abs === root || !abs.startsWith(root + path.sep)) continue
      if (!fs.existsSync(abs)) continue
      const dest = path.join(trashDir, rel)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      try {
        fs.renameSync(abs, dest)
      } catch {
        fs.copyFileSync(abs, dest)
        fs.unlinkSync(abs)
      }
      moved++
    } catch { /* 单文件失败不阻塞其余文件 */ }
  }
  return moved
}

/**
 * 回收一个段切片子目录（`segments/seg{id}`）到回收站。返回移动的文件数。
 *
 * 与 moveUploadsToTrash 的区别：那个函数收的是**具体 URL**，这里是**整目录**。
 * 设计约束（沿用本项目已踩过的坑）：
 *   1) 只移动「全库已无引用」的文件（filterUnreferencedUploadUrls 同一实现），不无脑全移；
 *   2) 文件移走后**逐层**判断目录是否真空，空才删——绝不递归强删（教训见 overview 回收站事故）；
 *   3) 路径必须落在 uploads 内（resolve 后前缀校验），防路径穿越。
 */
function recycleSliceDir(relDir, trashDir) {
  const root = path.resolve(UPLOAD_DIR)
  const absDir = path.resolve(root, relDir)
  if (absDir === root || !absDir.startsWith(root + path.sep)) return 0
  if (!fs.existsSync(absDir)) return 0
  let files = []
  try { files = fs.readdirSync(absDir) } catch { return 0 }
  // 目录内文件转成 /uploads/... URL 后走同一「无引用」过滤，只收可以安全移走的
  const urls = files
    .map((f) => `/uploads/${relDir.replace(/\\/g, '/')}/${f}`)
    .filter((u) => fs.existsSync(path.resolve(root, decodeURIComponent(u).replace(/^\/uploads\//, ''))))
  const movable = filterUnreferencedUploadUrls(urls)
  let moved = 0
  for (const u of movable) {
    try {
      const rel = decodeURIComponent(String(u).split(/[?#]/)[0]).replace(/^\/uploads\//, '')
      const abs = path.resolve(root, rel)
      if (abs === root || !abs.startsWith(root + path.sep)) continue
      if (!fs.existsSync(abs)) continue
      const dest = path.join(trashDir, rel)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      try {
        fs.renameSync(abs, dest)
      } catch {
        fs.copyFileSync(abs, dest)
        fs.unlinkSync(abs)
      }
      moved++
    } catch { /* 单文件失败不阻塞其余 */ }
  }
  // 逐层清空目录：仅当真的空了才删（目录里若仍有他处引用的文件，保留）
  try {
    if (fs.existsSync(absDir) && fs.readdirSync(absDir).length === 0) fs.rmdirSync(absDir)
  } catch { /* 非空 / 权限问题一律保留 */ }
  return moved
}

function deleteShotVideos(episodeId, rawShotIds) {
  const skipped = []
  // 归一化：去重 + 只留正整数 ID
  const requested = [...new Set(
    (Array.isArray(rawShotIds) ? rawShotIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0)
  )]

  // 本集镜头（JOIN 限定在本集，防止跨集误删）
  const epShots = query(
    `SELECT s.id, s.shot_number, s.video_url
       FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id
       WHERE ss.episode_id = ?`,
    [episodeId]
  )
  const shotById = new Map(epShots.map((s) => [Number(s.id), s]))

  // 段方案：仅「已出片」（video_url 非空）的段参与联动——段未出片时镜级成片与段无关
  const segments = query('SELECT * FROM video_segments WHERE episode_id = ?', [episodeId])
  const segmentByShot = new Map()
  for (const seg of segments) {
    if (!seg.video_url) continue
    let ids = []
    try { ids = JSON.parse(seg.shot_ids || '[]') } catch { ids = [] }
    for (const sid of ids) segmentByShot.set(Number(sid), seg)
  }

  const segmentIdsToClear = new Map() // segId -> seg
  const shotIdsToClear = new Set()    // 所有需回退未出片的镜（含段联动连带镜）
  for (const sid of requested) {
    const shot = shotById.get(sid)
    if (!shot) { skipped.push({ shotId: sid, reason: '镜头不存在' }); continue }
    const seg = segmentByShot.get(sid)
    if (seg) {
      // 段级联动：整段作废，同段所有镜一并回退
      segmentIdsToClear.set(Number(seg.id), seg)
      let ids = []
      try { ids = JSON.parse(seg.shot_ids || '[]') } catch { ids = [] }
      for (const s2 of ids) if (shotById.has(Number(s2))) shotIdsToClear.add(Number(s2))
    } else if (shot.video_url) {
      shotIdsToClear.add(sid)
    } else {
      // 幂等：本身就没成片，不报错，归入 skipped 即可
      skipped.push({ shotId: sid, reason: '该镜头没有成片' })
    }
  }

  // 候选文件：被清空镜头的 video_url + 被删段的 video_url（云端 URL 非 /uploads/ 开头，后续过滤时自动剔除 → 只清库不动盘）
  const fileCandidates = []
  for (const sid of shotIdsToClear) {
    const u = shotById.get(sid)?.video_url
    if (u) fileCandidates.push(u)
  }
  for (const seg of segmentIdsToClear.values()) {
    if (seg.video_url) fileCandidates.push(seg.video_url)
  }
  // 切片子目录（2026-09-16 审核修复 P2-8）：段成片切片产物落 /uploads/segments/seg{id}/，
  // 此前候选只收「数据库里记着的 URL」——切片 URL 写在 shots.video_url 上、会被上面第一段收走，
  // 但**段被删而镜未被清**（或切片文件比库记录多）时，整个子目录会残留在盘上永不回收。
  // 这里把整目录作为候选交给 moveUploadsToTrash（它按路径剥离相对子目录结构，目录内逐个移）。
  const segmentSliceDirs = []
  for (const seg of segmentIdsToClear.values()) {
    segmentSliceDirs.push(path.join('segments', `seg${seg.id}`))
  }

  // ── 事务：先改库（清镜头 / 清段 / 销打捞队列 / 处置告警）──
  // 打捞队列必须一起销：否则该镜正打捞中（云端 URL 未本地化）时，后台每 5 分钟会把云端 URL
  // 又写回 shots.video_url，用户会看到「删了又回来」。
  transaction(() => {
    for (const sid of shotIdsToClear) {
      // shot_review / seam_check / retry_feedback 是「针对那一版成片的判定」——观片闸打分、
      // 接缝色温亮度检测、LC 失败要点。成片一删，这些结论就失去指涉对象：留着会让一张
      // 「未出片」的空卡片继续亮「观片不合格」红徽章，并被「待处理」筛选捞出来，
      // 而用户根本没有画面可看、无从处置（2026-09-16 实锤：镜 1-2 删片后仍挂 fail 7.8）。
      // 与出片成功时的口径一致：generate-video 回写也把 shot_review 置 NULL。
      execute(
        "UPDATE shots SET video_url = '', video_generated = 0, shot_review = NULL, seam_check = '', retry_feedback = '' WHERE id = ?",
        [sid]
      )
    }
    for (const seg of segmentIdsToClear.values()) {
      execute("UPDATE video_segments SET video_url = '', status = 'pending', error = '' WHERE id = ?", [seg.id])
    }
    for (const sid of shotIdsToClear) {
      // salvage_queue 由 salvageWorker 启动时建表；表缺失等场景跳过，不拖垮删除
      try { execute('DELETE FROM salvage_queue WHERE shot_id = ?', [sid]) } catch { /* ignore */ }
    }
  })

  // 未处置告警一并销：relay/seam/review/writeback/mc 描述的都是「这条出片链」的断点，
  // 成片已删，链条结论失效。不清的话告警面板会留下无法处置的幽灵项（该镜已无成片可重检）。
  let alertsCleared = 0
  for (const sid of shotIdsToClear) alertsCleared += resolveAlertsByShot(sid, 'del')

  // ── 提交后再动盘：只移「全库已无引用」的本地文件 ──
  const trashDir = path.join(__dirname, '..', '_video_trash', String(Date.now()))
  const movedFiles = moveUploadsToTrash(filterUnreferencedUploadUrls(fileCandidates), trashDir)
  // 段切片目录整目录回收（P2-8）：与上面的单文件移动**同一顺序原则**——先改库再动盘。
  // 目录内文件可能被别处引用（极端情况：切片被手工引用到别镜），故仍走「全库无引用」过滤；
  // 目录清空后删除空目录本身（逐层判断，非空绝不删）。
  let removedSliceDirs = 0
  for (const relDir of segmentSliceDirs) {
    removedSliceDirs += recycleSliceDir(relDir, trashDir)
  }

  const shotsOut = [...shotIdsToClear]
    .sort((a, b) => a - b)
    .map((sid) => ({ id: sid, shotNumber: shotById.get(sid)?.shot_number || '' }))
  const segmentsOut = [...segmentIdsToClear.values()]
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((seg) => ({
      id: seg.id,
      sceneNumber: seg.scene_number,
      segmentIndex: seg.segment_index,
      shotNumbers: seg.shot_numbers || '',
      shotIds: (() => { try { return JSON.parse(seg.shot_ids || '[]') } catch { return [] } })(),
    }))

  return { ok: true, episodeId: Number(episodeId), shots: shotsOut, segments: segmentsOut, movedFiles, removedSliceDirs, alertsCleared, skipped }
}

// 删单镜成片
router.delete('/:episodeId/shots/:shotId/video', (req, res) => {
  const episode = queryOne('SELECT id FROM episodes WHERE id = ?', [req.params.episodeId])
  if (!episode) return res.status(404).json({ error: '集不存在' })
  try {
    res.json(deleteShotVideos(episode.id, [req.params.shotId]))
  } catch (e) {
    console.error('[删除成片失败]', e)
    res.status(500).json({ error: e.message || '删除成片失败' })
  }
})

// 批量删成片
router.post('/:episodeId/shots/video-delete', (req, res) => {
  const episode = queryOne('SELECT id FROM episodes WHERE id = ?', [req.params.episodeId])
  if (!episode) return res.status(404).json({ error: '集不存在' })
  const { shotIds } = req.body || {}
  if (!Array.isArray(shotIds)) return res.status(400).json({ error: 'shotIds 必须是数组' })
  try {
    res.json(deleteShotVideos(episode.id, shotIds))
  } catch (e) {
    console.error('[批量删除成片失败]', e)
    res.status(500).json({ error: e.message || '批量删除成片失败' })
  }
})


// 上传角色音频（base64 方式）
router.post('/:id/characters/:characterId/audio', (req, res) => {
  try {
    const { audioBase64 } = req.body
    if (!audioBase64) {
      return res.status(400).json({ error: '缺少音频数据' })
    }

    // 解析 base64（去掉 data:audio/xxx;base64, 前缀）
    const base64Data = audioBase64.replace(/^data:audio\/\w+;base64,/, '')
    const extMatch = audioBase64.match(/^data:audio\/(\w+);base64,/)
    let ext = extMatch ? extMatch[1] : 'mp3'
    // mpeg 扩展名改成 mp3，ComfyUI LoadAudio 节点更兼容 mp3
    if (ext === 'mpeg') ext = 'mp3'

    // 生成文件名
    const timestamp = Date.now()
    const random = Math.random().toString(36).substring(2, 8)
    const filename = `char_audio_${timestamp}_${random}.${ext}`
    const filepath = path.join(UPLOAD_DIR, filename)

    // 保存文件
    fs.writeFileSync(filepath, Buffer.from(base64Data, 'base64'))

    // 构造访问 URL
    const audioUrl = `/uploads/${filename}`

    const target = queryOne('SELECT * FROM characters WHERE id = ?', [req.params.characterId])
    // 链接了项目角色库：音色写回主设定并同步到所有集，保证跨集音色一致
    if (target?.project_character_id) {
      updateProjectCharacter(target.project_character_id, { audio_url: audioUrl })
      syncProjectCharacterToEpisodes(target.project_character_id)
    } else {
      execute('UPDATE characters SET audio_url = ? WHERE id = ?', [audioUrl, req.params.characterId])
    }

    const character = queryOne('SELECT * FROM characters WHERE id = ?', [req.params.characterId])
    res.json(character)
  } catch (e) {
    console.error('[AUDIO UPLOAD ERROR]', e)
    res.status(500).json({ error: '上传失败: ' + e.message })
  }
})

// 删除角色音频
router.delete('/:id/characters/:characterId/audio', (req, res) => {
  try {
    const character = queryOne('SELECT * FROM characters WHERE id = ?', [req.params.characterId])
    if (!character) {
      return res.status(404).json({ error: '角色不存在' })
    }

    // 删除时同样同步项目主设定，否则主设定会在下次同步时把已删音色又推回来
    if (character.project_character_id) {
      updateProjectCharacter(character.project_character_id, { audio_url: '' }, { allowClear: true })
      syncProjectCharacterToEpisodes(character.project_character_id)
    } else {
      execute('UPDATE characters SET audio_url = ? WHERE id = ?', ['', req.params.characterId])
    }

    // 物理删除音频文件：必须先清完 DB 引用再删，且音色可能来自 IP 应用
    // （ip_characters 行还引用同一文件），仅在全库无引用时才删
    if (character.audio_url) {
      removeLocalUploads(filterUnreferencedUploadUrls([character.audio_url]))
    }

    const updated = queryOne('SELECT * FROM characters WHERE id = ?', [req.params.characterId])
    res.json(updated)
  } catch (e) {
    console.error('[AUDIO DELETE ERROR]', e)
    res.status(500).json({ error: '删除失败: ' + e.message })
  }
})

export default router
