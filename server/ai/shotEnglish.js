// 分镜英文版：单镜英文编译与落列（2026-10-01）。
// 定位与资产 nameEn/descriptionEn 完全一致——英文是分镜数据的普通列：
//   生成/导入 → compileShotEnglish 回填落列
//   编辑保存 → 中文源变化的镜重跑本函数同步英文
//   出片     → 直接读列拼提示词，出片链路零翻译依赖
// 设计依据（db.js world_state_in_en/out_en 注释的既定模式扩展）：
//   分镜阶段 LLM 上下文最全，落库后出片期优先消费，缺字段才回落翻译。
// 翻译本体复用 translateShotFields：内容键缓存（重复编译不重复扣费）、
// 两次重试、含中文删残救济全部继承，不另起炉灶。
import crypto from 'node:crypto'
import { execute, query } from '../db.js'
import { translateShotFields } from './h3PromptTranslator.js'
import { CJK_DIRTY_RE } from './shared.js'

const text = (...values) => values.map((v) => String(v || '').trim()).find(Boolean) || ''

const jsonArray = (value) => {
  try {
    const parsed = JSON.parse(String(value || '[]'))
    return Array.isArray(parsed) ? parsed.map((item) => String(item || '').trim()).filter(Boolean) : []
  } catch {
    return []
  }
}

// 翻译输入的中文源指纹：覆盖送进翻译器的全部中文源（含资产名/台词语气——
// 它们进翻译缓存键，变了就必须重翻）。与 english_source_fp 列对比即知英文是否新鲜。
export function englishSourceFp(shot = {}) {
  const dlgArr = (() => {
    try {
      const p = JSON.parse(String(shot.dialogue || '[]'))
      const arr = Array.isArray(p) ? p : (p ? [p] : [])
      return arr.map((d) => String(d?.tone || '').trim()).filter(Boolean)
    } catch {
      return []
    }
  })()
  const source = {
    description: text(shot.description),
    actionNote: text(shot.action_note, shot.actionNote),
    soundscape: text(shot.overall_soundscape, shot.soundscape),
    soundEffects: text(shot.sound_effects, shot.soundEffects),
    music: text(shot.non_diegetic_music, shot.music),
    tone: dlgArr,
    finalFrame: text(shot.final_frame, shot.finalFrame),
    worldStateOut: text(shot.world_state_out, shot.worldStateOut),
    characters: jsonArray(shot.characters),
    sceneAssets: jsonArray(shot.scene_assets, shot.sceneAssets),
    propAssets: jsonArray(shot.prop_assets, shot.propAssets),
  }
  return crypto.createHash('sha256').update(JSON.stringify(source)).digest('hex')
}

// 末帧是否含"未声明主体"的中文：@角色名/场景名引用（角色名保留原文）不算，
// 剥掉已声明资产名与 @ 后仍有 CJK 才算。enrich 与出片门禁共用同一口径。
export function finalFrameHasUndeclaredChinese(finalFrame, shot = {}) {
  const frame = text(finalFrame)
  if (!frame) return true
  let probe = frame.replace(/@/g, '')
  const declared = [
    ...jsonArray(shot.characters),
    ...jsonArray(shot.scene_assets),
    ...jsonArray(shot.prop_assets),
  ]
  for (const name of declared) {
    if (name) probe = probe.split(name).join('')
  }
  return CJK_DIRTY_RE.test(probe)
}

// 该镜的英文版是否齐备（纯库内判断，出片门禁用）。
// 硬口径只有两条：有中文描述必须有英文描述、有中文动作必须有英文动作、末帧不得含未声明主体的中文。
// 声景/配乐/语气属质量增强项：英文缺失不阻断出片（组装层空值处理），不进完成判定。
export function shotEnglishComplete(shot = {}) {
  if (text(shot.description) && !text(shot.description_en)) return false
  if (text(shot.action_note) && !text(shot.action_note_en)) return false
  // 末帧为空的镜不拦（无末帧设计），有末帧才校验未声明主体中文
  if (text(shot.final_frame) && finalFrameHasUndeclaredChinese(shot.final_frame, shot)) return false
  return true
}

// 该镜是否需要编译：英文不齐 或 中文源指纹不匹配（编辑后英文已过期）。
export function shotEnglishStale(shot = {}) {
  if (!shotEnglishComplete(shot)) return true
  return String(shot.english_source_fp || '') !== englishSourceFp(shot)
}

// 单镜英文编译并落列。幂等：指纹匹配且英文齐备时直接返回（零 LLM）。
// 返回 { ok, reason?, fields }：ok=false 时 reason 为人话原因（供任务失败展示与重试）。
export async function compileShotEnglish(shot = {}, options = {}) {
  const shotId = Number(shot.id)
  if (!shotId) return { ok: false, reason: '镜头数据缺失，无法准备英文版', fields: {} }

  if (!shotEnglishStale(shot)) {
    return { ok: true, alreadyComplete: true, fields: englishFieldsOf(shot) }
  }

  const translated = await translateShotFields(shot, {
    characterNames: jsonArray(shot.characters),
    sceneNames: jsonArray(shot.scene_assets),
    wordBudget: null,
  })

  // 末帧：仅中文末帧才用翻译结果覆盖（enrich 同款口径：英文翻译非空才落）。
  let finalFrame = text(shot.final_frame)
  const finalFrameEn = text(translated.final_frame_en)
  if (finalFrame && CJK_DIRTY_RE.test(finalFrame) && finalFrameEn) finalFrame = finalFrameEn

  // 收尾状态英文副本：translateShotFields 内部已是"库内副本优先于 LLM 盲翻"，
  // 此处落 world_state_out_en（本镜自有字段）；world_state_in_en 保持派生机制不动。
  const worldStateOutEn = text(translated.world_state_end_en)

  const fields = {
    ...englishFieldsOf(shot),
    description_en: text(translated.description_en),
    action_note_en: text(translated.action_note_en),
    soundscape_en: text(translated.soundscape_en),
    music_en: text(translated.music_en),
    tone_en: text(translated.tone_en),
    final_frame: finalFrame,
    world_state_out_en: worldStateOutEn || text(shot.world_state_out_en),
  }

  // 逐字段落完后仍不齐备 = 翻译器降级（LLM 掉线/两次含中文），英文列保留空值、
  // 指纹不落——下次编译指纹仍不匹配，天然支持重试。
  const complete = shotEnglishComplete({ ...shot, ...fields })
  execute(
    `UPDATE shots SET
       description_en = ?, action_note_en = ?, soundscape_en = ?, music_en = ?, tone_en = ?,
       final_frame = ?, world_state_out_en = CASE WHEN ? != '' THEN ? ELSE world_state_out_en END,
       english_source_fp = ?
     WHERE id = ?`,
    [
      fields.description_en,
      fields.action_note_en,
      fields.soundscape_en,
      fields.music_en,
      fields.tone_en,
      finalFrame,
      worldStateOutEn,
      worldStateOutEn,
      complete ? englishSourceFp(shot) : '',
      shotId,
    ]
  )

  if (!complete) {
    return {
      ok: false,
      reason: '本镜的英文版还没准备好（AI 翻译服务暂时不可用），请稍后重试',
      fields,
    }
  }
  return { ok: true, fields }
}

// 集级按需同步：只编译"英文不齐或已过期"的镜（指纹判新鲜，没改的镜零成本跳过）。
// fire-and-forget 调用：保存路由响应后立即在后台跑，不阻塞用户操作；
// 编译失败的镜留待出片任务内兜底（compileShotEnglish 重试）。
export async function syncEpisodeEnglish(episodeId) {
  const rows = query(
    `SELECT s.* FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id
     WHERE ss.episode_id = ? ORDER BY ss.scene_number, s.start_time, s.id`,
    [episodeId]
  )
  let compiled = 0
  for (const shot of rows) {
    if (!shotEnglishStale(shot)) continue
    try {
      const r = await compileShotEnglish(shot)
      if (r.ok && !r.alreadyComplete) compiled++
      if (!r.ok) console.warn(`[shotEnglish] 镜 ${shot.shot_number || shot.id} 英文编译未完成：${r.reason}`)
    } catch (e) {
      console.warn(`[shotEnglish] 镜 ${shot.shot_number || shot.id} 英文编译异常：${e.message}`)
    }
  }
  if (compiled) console.log(`[shotEnglish] 集 ${episodeId}：${compiled} 镜英文版已同步`)
  return compiled
}

export function englishFieldsOf(shot = {}) {
  return {
    description_en: text(shot.description_en),
    action_note_en: text(shot.action_note_en),
    soundscape_en: text(shot.soundscape_en),
    music_en: text(shot.music_en),
    tone_en: text(shot.tone_en),
    world_state_in_en: text(shot.world_state_in_en),
    world_state_out_en: text(shot.world_state_out_en),
  }
}

// 出片组装用的读列翻译器：buildShotVideoPromptV4 的 ctx.translate 注入点。
// 返回结构与 translateShotFields 完全对齐，纯读数据零 LLM——
// 出片链路的翻译依赖从此收敛到"英文列空 → 编译器在任务内补齐"这一条兜底路径。
export function translateFromColumns(shot = {}) {
  return {
    ...englishFieldsOf(shot),
    final_frame_en: '',
    failed: false,
  }
}
