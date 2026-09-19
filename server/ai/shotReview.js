// VLM 观片闸（满分路线图第一级，2026-09-12）：出片成功后抽 5 帧 → 视觉大模型
// 以「第一观众」身份评审（情绪到位度 / 一句话能否讲清这镜 / 剧情符合性 / 开场衔接 / 台词是否配脸 / AI 味穿帮与画风突变）
// → 结构化 JSON 写 shots.shot_review，前端镜头卡片亮报告。
//
// 2026-09-12 晚补强（第1集武戏段返工事故的闸门复盘）：
// 旧四维全是"单镜内部质量"，8-2"描述写熊倒地、视频里熊站着红眼"这种剧情相反片
// 和 6-3→7-1 布布瞬移全部漏过。新增两维：
//  - scriptFaithfulness（剧情符合性）：视频演的是不是描述写的事，剧情节点相反/缺失打低分
//  - openingContinuity（开场衔接）：首帧 vs 上一镜末帧，角色凭空换位打低分（首镜 null）
//
// 设计口径：
//  - 独立列 shot_review，不碰 seam_check——那是锁4 的 409 拦截通道，观片闸是新兵未上过战场，
//    不允许它误报就掐断出片链；只亮报告，人（布哥）当终审。验证一个项目后可升格。
//  - 模型槽 config.llm.vlmModel（env LLM_VLM_MODEL，默认 qwen3-vl-flash）：
//    调用失败（403 免费额度耗尽等）只记日志跳过，绝不影响出片主流程。
//  - fire-and-forget，与接缝检测/末帧接力同口径。
//  - 指标只存不下结论的阈值：verdict pass/warn/fail 由四项均分映射（≥7 pass / ≥5 warn / <5 fail），
//    原始分都在 JSON 里，阈值改了可离线重判。
import path from 'node:path'
import fs from 'node:fs'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import ffmpegStaticPath from 'ffmpeg-static'
import { query, queryOne, execute } from '../db.js'
import { chatCompletion } from './doubao.js'
import { config } from '../config.js'
// [去重 2026-09-19] 媒体定位收口到 ai/mediaResolve.js（原与 seamCheck.js 各写一份近乎相同的
// resolveLocalMedia）。本文件原先直接 import insecureDownload，现已随函数一并移出。
import { resolveLocalMedia } from './mediaResolve.js'

const execFile = promisify(execFileCb)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const uploadsDir = path.join(__dirname, '..', 'uploads')

const REVIEW_FRAME_COUNT = 5

// （本地 resolveLocalMedia 已于 2026-09-19 收口到 ai/mediaResolve.js —— 它与
//   seamCheck.js 里的同名函数近乎逐字节相同，唯一差别是本文件的兜底文件名写死
//   'review_src'；现统一以 tag='review_src' 传入。见该文件头注。）

// 均匀抽 5 帧（10%/30%/50%/70%/90%），幂等覆盖到 uploads/review/
async function extractFrames(absVideo, shotId, durationSec) {
  const dir = path.join(uploadsDir, 'review')
  fs.mkdirSync(dir, { recursive: true })
  const dur = Number(durationSec) > 0 ? Number(durationSec) : 8
  const out = []
  for (let i = 0; i < REVIEW_FRAME_COUNT; i++) {
    const t = Math.max(0, dur * (0.1 + 0.2 * i) - 0.05).toFixed(2)
    const p = path.join(dir, `shot_${shotId}_f${i}.jpg`)
    await execFile(ffmpegStaticPath, ['-y', '-ss', t, '-i', absVideo, '-frames:v', '1', '-update', '1', '-q:v', '4', p])
    if (!fs.existsSync(p)) throw new Error(`第 ${i} 帧抽取失败：输出为空`)
    out.push(p)
  }
  return out
}

function buildReviewPrompt(shot, prevShot, refChars = [], hasPrevImg = false) {
  const dlg = (() => {
    try {
      const d = JSON.parse(shot.dialogue)
      if (!Array.isArray(d) || !d.length) return '无台词'
      return d.map((x) => `${x.character}（语气:${x.tone}）："${x.text}" @镜内${Number(x.startTime) - Number(shot.start_time)}s`).join('；')
    } catch { return '无台词' }
  })()
  // 图片顺序说明（2026-09-14 升级：内容 = 角色参考图 + 上一镜末帧 + 本镜 5 帧，最后文字）
  const imgOrder = [
    refChars.length ? `最前面 ${refChars.length} 张是【角色参考图】，依次是：${refChars.map((c) => c.name).join('、')}` : '',
    hasPrevImg ? '其后 1 张是【上一镜最终画面】（衔接判定基准）' : '',
    '其余 5 张是【本镜成片帧】（按时间顺序 10%~90%）',
  ].filter(Boolean).join('；')
  const prevFinal = prevShot
    ? `上一镜（${prevShot.shot_number}）最终画面：${hasPrevImg ? '见上述参考帧' : String(prevShot.final_frame || '（未填）').slice(0, 300)}`
    : null
  return [
    '你是短剧成片的第一观众，也是质检员。以下是这个镜头的分镜设定（编号/景别/朝向/运镜/剧情描述/台词）：',
    `镜头编号: ${shot.shot_number}；景别: ${shot.shot_type || '未填'}；机位: ${shot.camera_angle || '未填'}；运镜: ${shot.camera_movement || '未填'}；时长: ${shot.duration}s`,
    `剧情描述: ${shot.description || '（无）'}`,
    `台词: ${dlg}`,
    prevFinal || '（本镜是全片第一镜，无上一镜）',
    imgOrder ? `给你看的图片顺序：${imgOrder}。` : '',
    '',
    '【第 0 步（最高优先级）：角色身份核对】',
    '先看角色参考图认人：逐个记住每个角色的物种/毛色/体型/围巾等硬性视觉特征（相似角色必须靠这些区分，不能靠位置猜）。',
    '再核对 5 帧：剧情描述里的每个 @角色 是否由【正确的角色】出演。若某节拍的执行者身份错了（描述写 @A、画面里实际是 @B），',
    '该节拍 executed=false，并把「选角错误：描述为@A，画面实际是@B」写进 issues 第一条。参考图只用于认人，不代表本镜必须全员在场。',
    '',
    '按时间顺序给你 5 帧（10%~90%）。严格输出 JSON（不要任何多余文字）：',
    '{"beats": [{"beat": "从剧情描述拆出的一个节拍（动词短语）", "executed": true或false, "evidence": "对应画面证据（哪帧看到了/没看到，一句话）"}], "emotion": 0到10的整数, "clarity": 0到10的整数, "openingContinuity": 0到10的整数或null, "dialogueFace": 0到10的整数或null, "visualQuality": 0到10的整数, "styleConsistency": 0到10的整数, "issues": ["具体问题，每条一句话，无问题给空数组"], "summary": "一句话总评"}',
    '',
    '【最重要的一步：剧本节拍验收（rubric）】',
    '1. 把"剧情描述"拆成 2~5 个关键节拍（每个是一个可看见的动作/状态变化，如"雪浪卷翻两小只""红光褪去""熊缩回圆滚滚瘫倒""布布从熊肩跳下"）。',
    '2. 逐拍核对 5 帧：该节拍在视频里演出来了吗？executed=true 必须能在帧里指出证据；演反了（如剧本写倒地、视频站着）executed=false 并在 evidence 写明。',
    '3. 节拍缺失或演反 = 该镜最严重的质量问题，必须写进 issues 第一条（选角错误排更前）。',
    '',
    '评分标准：emotion=情绪表达是否清晰到位；clarity=这镜讲的事能否一句话讲清；',
    'openingContinuity=本镜首帧与上一镜最终画面是否衔接（角色凭空换位/凭空出现/构图与色调突兀打低分；未提供上一镜画面时填null）；',
    'dialogueFace=有台词时台词落点画面是否在角色近景/特写且表情匹配（无台词填null）；',
    'visualQuality=画面有无AI味穿帮（肢体崩坏/物体融化/多余肢体/文字乱码）；',
    'styleConsistency=画风是否与全片统一（吉卜力手绘水彩 Q 版），出现写实CG/3D质感/风格突变打低分。',
  ].join('\n')
}

// 角色参考图 → 本地绝对路径（2026-09-14 升级：评审必须按图认人。
// 背景：2-1 事故——两只小熊只差围巾色，VLM 拿着纯文本"@布布踩桥"把一二认成布布，
// 选角错配两轮静默通过还给错误盖合格章。参考图进评审，选角错误才能被机器看见。）
function resolveCharRefImages(shot) {
  let names = []
  try {
    const p = JSON.parse(shot.characters || '[]')
    if (Array.isArray(p)) names = p.map(String).filter(Boolean)
  } catch { /* 脏 JSON 按无参考图处理，不拦评审 */ }
  if (!names.length) return []
  const ph = names.map(() => '?').join(',')
  let rows = []
  try {
    rows = query(
      `SELECT name, image_url FROM characters WHERE episode_id = ? AND name IN (${ph})
       AND TRIM(COALESCE(image_url, '')) != ''`,
      [shot.episode_id, ...names]
    )
  } catch { return [] }
  const out = []
  for (const r of rows) {
    const u = String(r.image_url || '').trim()
    if (!u.startsWith('/uploads/')) continue // 远端/裸路径不进评审（参考图应已本地化）
    const rel = decodeURIComponent(u.slice('/uploads/'.length))
    if (rel.split('/').some((seg) => seg === '..')) continue
    const p = path.join(uploadsDir, rel)
    if (fs.existsSync(p)) out.push({ name: String(r.name), abs: p })
  }
  return out
}

/**
 * 观片评审主入口：出片成功后调用（fire-and-forget 口径）。
 * @param {Object} shot - shots 表一行（须含 video_url）
 * @returns {Object} 评审结果（同时已写入 shots.shot_review）
 */
export async function reviewShot(shot) {
  const videoUrl = String(shot.video_url || '').trim()
  if (!videoUrl) throw new Error('该镜还没有成片')
  const model = config.llm?.vlmModel
  if (!model) throw new Error('观片闸未配置模型（LLM_VLM_MODEL），跳过')

  const absVideo = await resolveLocalMedia(videoUrl, uploadsDir, shot.id, 'review_src')
  const frames = await extractFrames(absVideo, shot.id, shot.duration)

  // 角色参考图（按图认人，见 resolveCharRefImages 注释）
  const refChars = resolveCharRefImages(shot)

  // 上一镜（开场衔接维度）：同集内 start_time 最近的前一镜，口径与 relayLastFrameToNextShot 的
  // nextShot 反查同源反向。末帧优先用接力钩子落盘的真实帧图（shots.final_frame 文本是设计期
  // 写的，镜头重生后即过期——2026-09-14 修正）；图不存在再回退文本描述；首镜/前镜未落库 → null。
  const prevShot = queryOne(
    `SELECT s.id, s.shot_number, s.final_frame
     FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id
     WHERE ss.episode_id = ? AND s.start_time < ?
     ORDER BY s.start_time DESC LIMIT 1`,
    [shot.episode_id, Number(shot.start_time)]
  )
  const prevFrameImg = prevShot
    ? path.join(uploadsDir, 'continuity', `shot_${prevShot.id}_last.jpg`)
    : null
  const hasPrevImg = prevShot && fs.existsSync(prevFrameImg)

  const toImg = (abs, mime) => ({
    type: 'image_url',
    image_url: { url: `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}` },
  })
  const content = []
  for (const c of refChars) content.push(toImg(c.abs, 'image/png'))
  if (hasPrevImg) content.push(toImg(prevFrameImg, 'image/jpeg'))
  for (const p of frames) content.push(toImg(p, 'image/jpeg'))
  content.push({ type: 'text', text: buildReviewPrompt(shot, prevShot, refChars, !!hasPrevImg) })

  const raw = await chatCompletion(
    [{ role: 'user', content }],
    {
      model,
      temperature: 0.3,
      maxTokens: 1200,
      responseFormat: { type: 'json_object' },
      usageContext: { episodeId: shot.episode_id, task: 'shot-review' },
    }
  )

  let parsed
  try {
    const m = String(raw).match(/\{[\s\S]*\}/)
    parsed = JSON.parse(m ? m[0] : raw)
  } catch (e) {
    throw new Error(`观片闸返回不是合法 JSON: ${String(raw).slice(0, 120)}`)
  }

  // rubric 优先：剧本节拍验收（beats）。scriptFaithfulness 由执行率推导，不再让 VLM 拍脑袋打分
  // ——MSAVBench 结论：逐例 rubric 与人类判断的一致性显著高于绝对打分。
  const beats = Array.isArray(parsed.beats)
    ? parsed.beats.filter((b) => b && typeof b.beat === 'string').map((b) => ({
        beat: String(b.beat).slice(0, 120),
        executed: !!b.executed,
        evidence: String(b.evidence || '').slice(0, 200),
      }))
    : []
  const executedCount = beats.filter((b) => b.executed).length
  const scriptFaithfulness = beats.length
    ? Math.round((executedCount / beats.length) * 10)
    : (Number(parsed.scriptFaithfulness) || 0) // beats 解析失败时退回旧字段

  const scores = ['emotion', 'clarity', 'visualQuality', 'styleConsistency',
    ...(parsed.dialogueFace != null ? ['dialogueFace'] : []),
    ...(parsed.openingContinuity != null ? ['openingContinuity'] : [])]
  const scored = { ...parsed, scriptFaithfulness }
  const avg = scores.reduce((a, k) => a + (Number(scored[k]) || 0), 0) / scores.length
  // 硬性 fail：①均分线（<5）②任一关键剧本节拍未执行（演反/缺失）——8-2"熊倒地又站着"这种必须拦
  const missingBeats = beats.filter((b) => !b.executed)
  const verdict = (avg < 5 || missingBeats.length > 0)
    ? 'fail'
    : avg >= 7 ? 'pass' : 'warn'

  const result = {
    checkedAt: new Date().toISOString(),
    shotId: shot.id,
    checkType: 'vlmReview',
    model,
    beats,
    beatsTotal: beats.length,
    beatsExecuted: executedCount,
    missingBeats: missingBeats.map((b) => b.beat),
    emotion: parsed.emotion,
    clarity: parsed.clarity,
    scriptFaithfulness,
    openingContinuity: parsed.openingContinuity ?? null,
    dialogueFace: parsed.dialogueFace ?? null,
    visualQuality: parsed.visualQuality,
    styleConsistency: parsed.styleConsistency,
    avgScore: Math.round(avg * 10) / 10,
    verdict,
    issues: Array.isArray(parsed.issues) ? parsed.issues : [],
    summary: String(parsed.summary || ''),
  }
  execute('UPDATE shots SET shot_review = ? WHERE id = ?', [JSON.stringify(result), shot.id])

  // 闭环回灌（Character.ai eval-in-the-loop 模式）：fail 时把未执行的剧本节拍 + 问题清单
  // 写进 retry_feedback——下次该镜重出，v4 prompt 组装自动注入"上次验收失败，必须修正"。
  // 只写反馈不自动重出（烧币动作由人触发），通路焊死、扳机留人。
  if (verdict === 'fail') {
    execute('UPDATE shots SET retry_feedback = ? WHERE id = ?', [JSON.stringify({
      at: new Date().toISOString(),
      missingBeats: missingBeats.map((b) => b.beat),
      issues: result.issues,
      summary: result.summary,
    }), shot.id])
    console.log(`[shotReview] 镜 ${shot.shot_number} 验收 fail，已写入 retry_feedback（重出时自动回灌）：${missingBeats.map((b) => b.beat).join('；') || result.summary}`)
  }
  return result
}

/** 按 id 兜底入口（手动补评存量镜头） */
export async function reviewShotByShotId(shotId) {
  const shot = queryOne('SELECT * FROM shots WHERE id = ?', [shotId])
  if (!shot) throw new Error(`镜头 ${shotId} 不存在`)
  return reviewShot(shot)
}
