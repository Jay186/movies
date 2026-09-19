// 切片回填（E 路线 v2 收官件，2026-09-15）：
//   段成片（一段盖 N 镜）按镜边界切成 N 份，逐镜回填 shots.video_url。
//
// 为什么必须切（本模块存在的理由）：
//   段级出片让"1-1 和 1-2 两张卡片播放完全相同的 mp4"——因为段成片是整段一文件，
//   UI 只能整段播（segmentVideoUrl + segmentOffset 的 seek 打法只能在浏览器里装，
//   一旦导出/分享/真成片就是错的）。切片后每镜有自己的文件，卡片各播各的，
//   同时**保留段级出片的收益**（生成次数 40→22，省 45%，段内画风/表演一致）。
//
// 为什么不"逐镜重出"（否决方案）：
//   逐镜重出 = 段级省下的币又烧回去，且段内一致性反而丢了（不同次生成的光影/表演漂移）。
//
// 切片点精度：
//   段成片内部是 H3 按 prompt 的 [Shot N] At MM:SS.mmm 标记执行的切点，实测误差 ≤0.375s
//   （17 帧网格档）。切片时按**镜在段内的相对时间**切，与 prompt 声称一致；
//   若段首有坏帧/黑场，用 trim_start 整体后移（§9.3 零成本裁切修法）。
//
// 重编码而非 -c copy：
//   H264 关键帧间隔通常 2s，段内切点几乎不可能落在关键帧上，copy 会切出黑屏首帧。
//   故重编码 CRF 18（与 sceneComposer 拼场同档），单段 ≤15s、每段 ≤5 镜，耗时可接受。
//
// 用法（模块）：
//   import { sliceSegment } from './ai/segmentSlicer.js'
//   const r = await sliceSegment(segId)   // 读库、切片、回填 video_url
//
// 用法（HTTP）：POST /api/generate/video-segment/:id/slice（见 routes/generate-video.js）

import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ffmpegStatic from 'ffmpeg-static'
import { query, queryOne, execute, transaction } from '../db.js'
import { segmentStaleness } from './segmentBuilder.js'
import { recordAlert } from './alerts.js'
import { uploadsUrlToAbs } from './shared.js'

const execFile = promisify(execFileCb)
const ffmpeg = ffmpegStatic || './node_modules/ffmpeg-static/ffmpeg.exe'

// uploads 根：以本文件位置推导（server/ai/ → server/uploads），不依赖 process.cwd()。
// cwd 是运行时的——服务从别的目录启动（如 `node server/index.js` 于仓库根、
// 或 pm2/systemd 指定 WorkingDirectory）时，process.cwd() 会指向错误位置，
// 路径解析静默失败。收口到 shared.uploadsUrlToAbs（P0-2/P0-3 同一实现）。
const UPLOAD_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'uploads')

// 切片点容差：H3 切点实测误差 ≤0.375s。若某镜切片时长因此 < 此值，说明切点漂了，
// 标记告警而不是硬切出一个 0.1s 的碎片镜。
const MIN_SLICE_SEC = 0.8

/**
 * `/uploads/...` URL → 本地绝对路径（保留子目录）。
 *
 * 2026-09-16 收口：本函数原为第三份独立实现（与 shared.uploadsUrlToAbs、
 * sceneComposer.uploadsToLocal 三处并存），且用 `process.cwd()` 作基准。
 * 现薄封装 shared 的单点实现，基准改为由本文件位置推导的 UPLOAD_DIR。
 * 保留本函数名作为模块内别名（调用点 2 处，避免改动扩散）。
 */
export function uploadsToAbs(url) {
  return uploadsUrlToAbs(url, UPLOAD_DIR)
}

/** 取 mp4 时长（ffmpeg -i 无输出参数报错退出，Duration 在 stderr） */
async function probeDuration(absPath) {
  const probe = await execFile(ffmpeg, ['-i', absPath], { maxBuffer: 4 * 1024 * 1024 }).catch((e) => e)
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(String(probe?.stderr || ''))
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : null
}

/**
 * 切一段：-ss 放在 -i 之后（精确 seek，慢但对齐帧），重编码 CRF 18。
 *
 * 原子落盘（P1-6）：先写 `${outAbs}.${pid}.tmp.mp4` 再 renameSync 到最终名。
 * 原因：ffmpeg 进程被杀会留下截断文件，若直接写最终名，下次重跑的"文件已存在"幂等判断
 * 会把半成品当成品跳过 → 永久性坏切片。临时名带 pid，并发重跑也不会互相覆盖。
 */
async function cutOne(absIn, outAbs, startSec, durSec) {
  fs.mkdirSync(path.dirname(outAbs), { recursive: true })
  const tmpAbs = `${outAbs}.${process.pid}.tmp.mp4`
  try {
    await execFile(ffmpeg, [
      '-y',
      '-i', absIn,
      '-ss', String(startSec),
      '-t', String(durSec),
      '-c:v', 'libx264', '-crf', '18', '-preset', 'medium',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
      '-movflags', '+faststart',
      // 输出帧率与源一致，避免 H3 出片的帧率被 ffmpeg 默认改写
      '-fps_mode', 'passthrough',
      tmpAbs,
    ], { maxBuffer: 64 * 1024 * 1024 })
    fs.renameSync(tmpAbs, outAbs)
  } catch (err) {
    try { fs.rmSync(tmpAbs, { force: true }) } catch { /* 清理失败不掩盖原错误 */ }
    throw err
  }
}

/**
 * 段成片 → 按镜边界切成 N 份 → 回填 shots.video_url。
 *
 * 幂等：已切过的镜（video_url 已指向本段切片目录）跳过重切，可安全重跑。
 *
 * @param {number} segmentId video_segments.id
 * @param {{ force?: boolean, dryRun?: boolean }} [opts]
 * @returns {Promise<{success:boolean, slices?:Array, warning?:string, skipped?:Array}>}
 */
export async function sliceSegment(segmentId, opts = {}) {
  const seg = queryOne('SELECT * FROM video_segments WHERE id = ?', [segmentId])
  if (!seg) return { success: false, warning: `段 ${segmentId} 不存在` }
  if (seg.status !== 'done' || !seg.video_url) {
    return { success: false, warning: `段 ${segmentId} 未出片（status=${seg.status}），先出片再切` }
  }

  let shotIds = []
  try { shotIds = JSON.parse(seg.shot_ids || '[]') } catch { shotIds = [] }
  if (!shotIds.length) return { success: false, warning: `段 ${segmentId} shot_ids 为空` }

  const absIn = uploadsToAbs(seg.video_url)
  if (!absIn) return { success: false, warning: `段成片本地缺失：${seg.video_url}` }

  // 镜按 **shot_ids 的存储顺序** 重建（段方案落库时即按播放序写入），
  // 不再按 start_time 排序——同 start_time 的镜排序不稳定，会静默切出内容颠倒的视频（P1-4）。
  const placeholders = shotIds.map(() => '?').join(',')
  const rows = query(
    `SELECT id, shot_number, storyboard_scene_id, start_time, end_time, duration, video_url
       FROM shots WHERE id IN (${placeholders})`,
    shotIds
  )
  const byId = new Map(rows.map((s) => [Number(s.id), s]))
  const shots = shotIds.map((id) => byId.get(Number(id))).filter(Boolean)

  // ── 段记录过期校验（P0-A：数据损坏级）──
  // 段只存 shot_ids 快照，镜被删/重建/移场后段记录不会自动同步。三道校验从强到弱，
  // 任一不过即判「段记录已过期」：拒绝切片 + 标 stale + 落告警，绝不用错误时间轴硬切。
  const staleReasons = []
  if (shots.length !== shotIds.length) {
    staleReasons.push(`段内 ${shotIds.length} 镜中有 ${shotIds.length - shots.length} 镜已被删除或重建`)
  }
  // 同场校验：段不跨场（铁律 1），镜被移到别场说明分镜已重排
  const sceneIds = new Set(shots.map((s) => Number(s.storyboard_scene_id)))
  if (sceneIds.size > 1) {
    staleReasons.push(`段内镜已不属于同一场（查到 ${sceneIds.size} 个场），分镜已重排`)
  }
  // 镜表指纹：最完整的一道（覆盖删镜/改序/改时长/改场次）
  //
  // ⚠️ 空指纹必须视为「需校验」而不是「免检」（2026-09-16 审核修复 P0-1）：
  //   旧判据 `if (seg.shots_fp && seg.shots_fp !== curFp)` 在 shots_fp 为空串时短路，
  //   整条 stale 校验被跳过。而指纹机制 2026-09-15 才落地——此前落库的段全是空指纹，
  //   于是「空指纹 = 不过期」在迁移期实际变成了「空指纹 = 免检」：实测第2集 22/22 段
  //   都是空指纹，其中 5 段引用的镜早已被删，切到一半才发现（或永远发现不了）。
  //   现在空指纹一律判 stale：无法证明段与当前镜表一致，就不能拿它去切。
  //   修法是「重算段方案」（POST /:id/segments?persist=1）——正常路径会写入指纹，
  //   此后本段即恢复正常校验；重算时已出片的段按边界比对保留。
  //
  //   2026-09-16：判定逻辑收口到 segmentBuilder.segmentStaleness 单点实现。
  //   同一判据此前在切片器/出片闸门/UI 探测接口各写一份，易静默漂移
  //   （出现「出片时认为新鲜、切片时认为过期」的自相矛盾状态）。
  const fp = segmentStaleness(seg)
  if (fp.stale) staleReasons.push(fp.reason)

  if (staleReasons.length) {
    const reason = `段 ${seg.scene_number}-${seg.segment_index}（${seg.shot_numbers}）记录已过期：${staleReasons.join('；')}。请到分镜页重算段方案后重出，本段不再切片。`
    execute("UPDATE video_segments SET status = 'stale', error = ? WHERE id = ?", [reason.slice(0, 500), segmentId])
    try {
      recordAlert({
        level: 'error', source: 'writeback', episodeId: seg.episode_id,
        shotId: shots[0]?.id ?? null, shotNumber: String(shots[0]?.shot_number || ''),
        message: reason, detail: { segmentId, staleReasons, storedFp: seg.shots_fp, currentFp: fp.currentFingerprint },
      })
    } catch { /* 告警失败不覆盖主错误 */ }
    return { success: false, stale: true, warning: reason }
  }

  // 单调性检查（不阻断）：ordered 按存储序重建后，start_time 理应递增。
  // 不单调说明段记录与镜表存在可疑错位，先告警留痕，不阻断切片（数据可疑但未必错）。
  for (let i = 1; i < shots.length; i++) {
    if (Number(shots[i].start_time) < Number(shots[i - 1].start_time)) {
      console.warn(`[segmentSlicer] 段${segmentId} 镜序与 start_time 不同调（第 ${i} 镜 ${shots[i].shot_number}）：按存储序切片，请核查段记录`)
      break
    }
  }

  const trimStart = Number(seg.trim_start) || 0
  const segStart = Number(seg.start_time) || 0
  const segEnd = Number(seg.end_time) || 0
  const videoDur = await probeDuration(absIn)

  // 时间轴（全部相对段首，含 trim 偏移）：
  //   镜 i 切点 = (shot.start_time - seg.start_time) + trim_start
  //   段首坏 N 秒时 trim_start=N，整体后移，坏头被跳掉
  //   镜表区间映射到源视频的总长 = (seg.end_time - seg.start_time) + trim_start（同样含 trim）
  const plannedTotal = Math.max(0, (segEnd - segStart) + trimStart)
  const cuts = shots.map((s, i) => {
    const relStart = Number(s.start_time) - segStart
    const start = Math.max(0, relStart + trimStart)
    const next = i + 1 < shots.length
      ? Math.max(0, Number(shots[i + 1].start_time) - segStart + trimStart)
      : null
    // 末镜：以镜表 seg.end_time 为上限，H3 尾部溢出直接丢掉（卡片时长须与镜表一致）。
    // 源视频比声称短时取源视频剩余（min），比声称长时截到 plannedTotal。
    const plannedEnd = next != null ? next : plannedTotal
    const avail = videoDur != null ? Math.min(videoDur, plannedEnd) : plannedEnd
    const dur = next != null ? (next - start) : (avail - start)
    return { shot: s, index: i, start: Number(start.toFixed(3)), dur: Number(Math.max(MIN_SLICE_SEC, dur).toFixed(3)) }
  })

  // 尾部溢出可见化（2026-09-18，P1-3）：
  //   源视频比「段声明时长 + 前跳 trim」长时，多出来的尾巴按设计**直接丢弃**（见上方 cuts 注释：
  //   卡片时长必须与镜表一致）。这是设计行为不是 BUG，但此前完全静默——第2集实测段 87 声明
  //   13s、ffprobe 实测 13.67s，末镜 0.67s 素材蒸发无痕；22 段批量累计约 10~15s。
  //   用 console.warn 而不是 recordAlert：告警表是给用户在 UI 上处置的**资产/断链告警**，
  //   而这里没有任何用户可执行动作（不能"补齐"已有的素材），落进去只会稀释真正要处置的告警。
  //   ⚠️ 阈值 0.05s：低于此不报（ffprobe 抖动 + 浮点误差级），避免每段都刷一行。
  if (videoDur != null) {
    const declaredSec = Math.max(0, segEnd - segStart)
    const overflowSec = videoDur - plannedTotal
    if (overflowSec > 0.05) {
      console.warn(
        `[segmentSlicer] 段${segmentId} 尾部溢出 ${overflowSec.toFixed(2)}s 已丢弃（设计行为）：`
        + `段声明 ${declaredSec.toFixed(2)}s + 前跳 trim ${trimStart.toFixed(2)}s = ${plannedTotal.toFixed(2)}s，`
        + `源视频实测 ${videoDur.toFixed(2)}s；末镜收尾约 ${overflowSec.toFixed(2)}s 素材不进成片`
        + `${overflowSec > 0.5 ? '（>0.5s，建议复查该段 AI 声明时长是否偏短）' : ''}`
      )
    }
  }

  // 保险：切片时长过短（切点漂移 / 数据错位）→ 拒绝切，避免产生碎片镜
  const tooShort = cuts.filter((c) => c.dur < MIN_SLICE_SEC)
  if (tooShort.length) {
    return {
      success: false,
      warning: `切点异常：${tooShort.map((c) => `镜${c.shot.shot_number} ${c.dur}s`).join('、')} 短于 ${MIN_SLICE_SEC}s——段成片切点与镜表不符，未切片（先核查段内镜时长）`,
    }
  }

  if (opts.dryRun) {
    return { success: true, dryRun: true, slices: cuts.map((c) => ({ shotId: c.shot.id, shotNumber: c.shot.shot_number, start: c.start, dur: c.dur })) }
  }

  // 输出目录：uploads/segments/seg{segmentId}/ 下按镜号命名，重切覆盖同目录（不散落）
  // 基准同 UPLOAD_DIR（本文件位置推导），不用 process.cwd()——见文件头说明。
  const outDirRel = path.join('segments', `seg${segmentId}`)
  const outDirAbs = path.join(UPLOAD_DIR, outDirRel)
  fs.mkdirSync(outDirAbs, { recursive: true })

  // ── 阶段 1：切片落盘（不写库）──
  // 先切完再统一回填：中途失败则整体不回填，避免「半个段」——
  // 段内前几镜回填成功、后几镜失败，卡片一半指向新切片、一半指向旧视频（P1-5）。
  const slices = []
  const skipped = []
  for (const c of cuts) {
    // 文件名带 shot.id 保唯一：shot_number 可能含中文/特殊字符，
    // 净化后「1-1特写」与「1-1近景」会撞成同一个名字互相覆盖（P2-5）。
    const fileName = `${String(c.shot.shot_number).replace(/[^\w-]/g, '_')}_${c.shot.id}.mp4`
    const outAbs = path.join(outDirAbs, fileName)
    const outUrl = `/uploads/${outDirRel.replace(/\\/g, '/')}/${fileName}`

    // 幂等：已有切片且非 force → 只回填 URL，不重编码。
    // 判据是「探测时长与本次应切时长吻合（±0.2s）」，不是「文件够大」——
    // 文件大小判据会把上一次方案切出的旧切片、或 ffmpeg 被杀留下的截断文件当成品跳过（P1-6）。
    let reuse = false
    if (!opts.force && fs.existsSync(outAbs)) {
      const existDur = await probeDuration(outAbs)
      reuse = existDur != null && Math.abs(existDur - c.dur) <= 0.2
    }

    if (reuse) {
      skipped.push({ shotId: c.shot.id, shotNumber: c.shot.shot_number, url: outUrl })
    } else {
      try {
        await cutOne(absIn, outAbs, c.start, c.dur)
      } catch (err) {
        // 整体不落库：已切出的文件留在磁盘无妨（下次重跑按幂等判据复用或覆盖）
        return {
          success: false,
          warning: `镜 ${c.shot.shot_number} 切片失败（起 ${c.start}s 长 ${c.dur}s）：${String(err.message || err).slice(0, 300)}。本段所有镜均未回填（避免半个段）。`,
          slices: [],
        }
      }
    }

    slices.push({
      shotId: c.shot.id,
      shotNumber: c.shot.shot_number,
      url: outUrl,
      start: c.start,
      dur: c.dur,
      reused: reuse,
    })
  }

  // ── 阶段 2：统一回填（事务）──
  // 回填：video_url 指向本镜切片 + video_generated=1
  // 不动 continuity_url（段间接力锚由 postHooks 管），不动 shot_review（段级观片在段上做）
  transaction(() => {
    for (const sl of slices) {
      execute(
        "UPDATE shots SET video_url = ?, video_generated = 1 WHERE id = ?",
        [sl.url, sl.shotId]
      )
    }
  })

  // 段上记切片结果（error 字段复用为「切片状态」会污染语义，故只在 console 留痕）
  console.log(`[segmentSlicer] 段${segmentId} 切片完成：${slices.length} 份（复用 ${skipped.length}）`)

  return { success: true, slices, skipped }
}

/**
 * 段成片末帧抽帧 → 供下一段当接力锚（anchorMode='prev-segment-last'）。
 * postHooks.relayLastFrameToNextShot 是**镜级**接力；段级接力是本函数。
 *
 * @param {number} segmentId 已完成出片的段
 * @returns {Promise<{success:boolean, url?:string, absPath?:string, warning?:string}>}
 */
export async function extractSegmentLastFrame(segmentId) {
  const seg = queryOne('SELECT * FROM video_segments WHERE id = ?', [segmentId])
  if (!seg) return { success: false, warning: `段 ${segmentId} 不存在` }
  if (!seg.video_url) return { success: false, warning: `段 ${segmentId} 无成片，抽不到末帧` }

  const absIn = uploadsToAbs(seg.video_url)
  if (!absIn) return { success: false, warning: `段成片本地缺失：${seg.video_url}` }

  const relPath = path.join('continuity', `seg${segmentId}_last.jpg`)
  const absOut = path.join(UPLOAD_DIR, relPath)
  fs.mkdirSync(path.dirname(absOut), { recursive: true })

  try {
    // -sseof 从尾部 seek，取 1 帧（与 postHooks 镜级抽帧同款打法）
    await execFile(ffmpeg, ['-y', '-sseof', '-0.1', '-i', absIn, '-update', '1', '-frames:v', '1', absOut])
  } catch (err) {
    return { success: false, warning: `段${segmentId} 末帧抽取失败：${String(err.message || err).slice(0, 200)}` }
  }
  if (!fs.existsSync(absOut)) return { success: false, warning: `段${segmentId} 末帧文件未生成` }

  const url = `/uploads/continuity/seg${segmentId}_last.jpg`
  return { success: true, url, absPath: absOut }
}

/**
 * 批量切片：把某集（或某场）所有 done 段切成镜级视频。
 * 串行执行，逐段返回结果——任一段失败不中断后续（失败段进 failed 列表）。
 *
 * @param {number} episodeId
 * @param {{ scene?: number, force?: boolean }} [opts]
 */
export async function sliceEpisode(episodeId, opts = {}) {
  let sql = "SELECT id FROM video_segments WHERE episode_id = ? AND status = 'done' ORDER BY scene_number, segment_index"
  const params = [episodeId]
  if (opts.scene != null) { sql = "SELECT id FROM video_segments WHERE episode_id = ? AND scene_number = ? AND status = 'done' ORDER BY segment_index"; params.push(Number(opts.scene)) }
  const segRows = query(sql, params)

  const results = []
  for (const r of segRows) {
    const res = await sliceSegment(r.id, { force: opts.force })
    results.push({ segmentId: r.id, ...res })
  }
  const ok = results.filter((r) => r.success).length
  return {
    total: results.length,
    ok,
    failed: results.filter((r) => !r.success).map((r) => ({ segmentId: r.segmentId, warning: r.warning })),
    results,
  }
}
