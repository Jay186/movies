// 衔接质量自动检测（#3，2026-09-11）：
// 出片成功后，把本镜成片首帧与「本镜出片时实际使用的 continuity 锚帧」（上一镜末帧）
// 做三项比对——色温差（McCamy CCT）/ 亮度差 / 构图差（8x8 aHash 汉明距离），
// 超阈值写入 shots.seam_check（JSON），前端镜头卡片标红报警。
//
// 设计口径：
//  - 只检测「锚被无视」：色温/亮度是场景恒定属性，锚帧生效时二者不应跳变；
//    构图差是**参考指标不参与告警**——官方帧锚定句式允许重新取景（景别变化是合法的），
//    拿构图差当告警条件会对合法转镜满屏误报。
//  - 全部用 ffmpeg rawvideo 管道取像素 + 纯 JS 计算，不引入图像库依赖。
//  - fire-and-forget：失败只记日志，绝不影响出片主流程（与末帧接力同口径）。
import path from 'node:path'
import fs from 'node:fs'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import ffmpegStaticPath from 'ffmpeg-static'
import { queryOne, execute } from '../db.js'
// [去重 2026-09-19] 媒体定位收口到 ai/mediaResolve.js（原与 shotReview.js 各写一份近乎相同的
// resolveLocalMedia）。本文件原先直接 import insecureDownload，现已随函数一并移出。
import { resolveLocalMedia } from './mediaResolve.js'

const execFile = promisify(execFileCb)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const uploadsDir = path.join(__dirname, '..', 'uploads')

// ── 告警阈值（经验值，后续按实测校准；存了原始指标，改阈值可离线重判）──
const SEAM_ALERT = {
  cctDiffK: 1000, // 色温差 > 1000K → 告警（同场景同光源，锚生效时不该跳这么多）
  lumaDiff: 45,   // 平均亮度差 > 45/255 → 告警
}

// ── 开场镜色向闸阈值（锁3，2026-09-12；校准自 _tone_probe 实测）──
// 适用对象：没有 continuity 锚的开场镜（每集首镜 / 换场首镜）。
// 接缝检测管不到它们（没有上一镜末帧可比），锚帧锁色温（锁2）也管不到它们
// （没有锚帧可声明）——而它们是整条接力链色调的源头：源头一跑偏，
// 锁2 会把错误色调当"正确"一路接力放大到全场景（实测病例：3-1 暖金跑偏 →
// 3-2 接缝炸 1411K，锁2 生效后此类跑偏会传染而非自愈）。
//
// 指标 = 首帧 R-B（8x8 面积平均的红蓝差）。第1集五镜实测（8 好样本 vs 2 坏样本）：
//   正确镜（1-1/2-1/3-2/4-1 首末帧）：R-B ∈ [-6.1, +2.7]
//   跑偏 3-1（暖金）：R-B = -26.1（首帧）/ -22.0（末帧）
//     ——注意方向反直觉：暖金高光+饱和蓝阴影的混杂漂移，面积平均被蓝主导。
//     所以本闸语义是「色调不属 family」而非「偏暖」，往任一方向漂出带宽都报警。
//   场景插画参考图：-42.2 / -57.7 ← 与 AI 成片不在一个色度空间，
//     「对参考图算绝对色温/R-B」方案已实测枪毙，不得复用。
// 带宽 [-12, +12]：好样本 2 倍余量，坏样本超出 10 单位必被抓。
// 已知边界：场9（雪山冰原·黄昏）是合法暖调，未来出片会触闸——
// 属预期行为：标红+拦截提示人工确认，用 ignoreSeamAlert 一次性放行即可
// （绝不自动重 roll）；拿到场9暖调实测样本后再考虑单独带宽。
const OPENER_TONE_GATE = { rbMin: -12, rbMax: 12 }

// 8x8 均值哈希：两帧各 64 bit，汉明距离（0=完全同构图，64=完全不同）
const hamming = (a, b) => {
  let d = 0
  for (let i = 0; i < 64; i++) if ((a[i] !== b[i])) d++
  return d
}

// sRGB → 线性（CCT 计算前必须去 gamma，否则色温系统性偏低）
const srgbToLinear = (c8) => {
  const c = c8 / 255
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

// 平均 RGB → 相关色温（McCamy 1992 近似）。近黑/近灰帧色度不稳 → 返回 null。
function rgbToCct(r, g, b) {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b)
  // sRGB D65 → XYZ
  const X = 0.4124 * R + 0.3576 * G + 0.1805 * B
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B
  const Z = 0.0193 * R + 0.1192 * G + 0.9505 * B
  const sum = X + Y + Z
  if (sum < 1e-6) return null
  const x = X / sum, y = Y / sum
  const n = (x - 0.3320) / (0.1858 - y)
  const cct = 449 * n ** 3 + 3525 * n ** 2 + 6823.3 * n + 5520.33
  return Number.isFinite(cct) && cct > 500 && cct < 40000 ? Math.round(cct) : null
}

// 抽一帧的 8x8 RGB 原始像素（192 字节），再用 JS 算指标。
// scale=flags=area：box 式面积平均，1 帧 8x8 的开销可忽略。
// encoding:'buffer'：rawvideo 是二进制流，默认 utf8 会把 stdout 当字符串解码损坏。
async function frameGrid8(filePath) {
  const { stdout } = await execFile(ffmpegStaticPath, [
    '-y', '-i', filePath,
    '-vf', 'scale=8:8:flags=area',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ], { maxBuffer: 1 << 20, encoding: 'buffer' })
  if (!stdout || stdout.length < 192) throw new Error(`帧像素读取失败: ${filePath}`)
  return stdout
}

// 一帧的完整指标：meanRGB / luma / cct / aHash(64bit 数组)
function computeMetrics(grid /* Buffer 192B */) {
  let r = 0, g = 0, b = 0
  for (let i = 0; i < 192; i += 3) { r += grid[i]; g += grid[i + 1]; b += grid[i + 2] }
  r /= 64; g /= 64; b /= 64
  const gray = []
  for (let i = 0; i < 192; i += 3) {
    gray.push(0.2126 * grid[i] + 0.7152 * grid[i + 1] + 0.0722 * grid[i + 2])
  }
  const mean = gray.reduce((s, v) => s + v, 0) / 64
  const bits = gray.map((v) => (v >= mean ? 1 : 0))
  return {
    meanRgb: [Math.round(r), Math.round(g), Math.round(b)],
    luma: Math.round(mean),
    cct: rgbToCct(r, g, b),
    hash: bits,
  }
}

// （本地 resolveLocalMedia 已于 2026-09-19 收口到 ai/mediaResolve.js —— 它与
//   shotReview.js 里的同名函数近乎逐字节相同，唯一差别是兜底文件名。见该文件头注。）

// 抽视频首帧（与接力抽末帧同范式；确定性文件名幂等覆盖）
async function extractFirstFrame(absVideo, shotId) {
  const contDir = path.join(uploadsDir, 'continuity')
  fs.mkdirSync(contDir, { recursive: true })
  const outPath = path.join(contDir, `shot_${shotId}_first.jpg`)
  await execFile(ffmpegStaticPath, ['-y', '-i', absVideo, '-update', '1', '-frames:v', '1', outPath])
  if (!fs.existsSync(outPath)) throw new Error('首帧抽取失败：输出为空')
  return outPath
}

/**
 * 衔接质量检测主入口：出片成功后调用。
 * @param {Object} shot - shots 表一行（须含 video_url；continuity_url 为本镜出片时用的锚）
 *   注意时序：锚帧（continuity_url）在本镜出片**之前**已写入（上一镜出片时接力），
 *   本镜出片后它仍是"本镜开场该长成的样子"——正好用来对比本镜实际首帧。
 *   本镜成片的末帧接力会在本函数之后执行，覆盖的是**下一镜**的 continuity_url，互不干扰。
 * @returns {Object} 指标结果（同时已写入 shots.seam_check）
 */
export async function checkSeam(shot) {
  const videoUrl = String(shot.video_url || '').trim()
  const anchorUrl = String(shot.continuity_url || '').trim()
  if (!videoUrl) throw new Error('该镜还没有成片')
  if (!anchorUrl) throw new Error('本镜没有 continuity 锚（首镜/新场景首镜），跳过检测')

  const absVideo = await resolveLocalMedia(videoUrl, uploadsDir, shot.id, 'seam')
  const absAnchor = await resolveLocalMedia(anchorUrl, uploadsDir, shot.id, 'anchor')

  const firstFrame = await extractFirstFrame(absVideo, shot.id)
  const [videoM, anchorM] = await Promise.all([
    frameGrid8(firstFrame).then(computeMetrics),
    frameGrid8(absAnchor).then(computeMetrics),
  ])

  const cctDiff = videoM.cct != null && anchorM.cct != null ? Math.abs(videoM.cct - anchorM.cct) : null
  const lumaDiff = Math.abs(videoM.luma - anchorM.luma)
  const hashDist = hamming(videoM.hash, anchorM.hash)
  const alert =
    (cctDiff != null && cctDiff > SEAM_ALERT.cctDiffK) ||
    lumaDiff > SEAM_ALERT.lumaDiff

  const result = {
    checkedAt: new Date().toISOString(),
    shotId: shot.id,
    checkType: 'anchorSeam',
    anchorUrl,
    video: {
      cct: videoM.cct, luma: videoM.luma, meanRgb: videoM.meanRgb,
    },
    anchor: {
      cct: anchorM.cct, luma: anchorM.luma, meanRgb: anchorM.meanRgb,
    },
    cctDiffK: cctDiff,
    lumaDiff,
    hashDist,
    alert,
    // 阈值快照：改阈值后可离线重判历史数据
    thresholds: { cctDiffK: SEAM_ALERT.cctDiffK, lumaDiff: SEAM_ALERT.lumaDiff },
    note: 'hashDist 为构图参考指标（跨镜重新取景是合法操作，不参与告警）',
  }
  execute('UPDATE shots SET seam_check = ? WHERE id = ?', [JSON.stringify(result), shot.id])
  return result
}

// 兜底手动接口用：按 shotId 现查现检（自动钩子失败或想重检时用）
export async function checkSeamByShotId(shotId) {
  const shot = queryOne('SELECT * FROM shots WHERE id = ?', [Number(shotId)])
  if (!shot) throw new Error(`镜头不存在 (shotId=${shotId})`)
  return checkSeam(shot)
}

/**
 * 开场镜色向闸主入口（锁3）：无锚镜出片成功后调用（有锚镜走 checkSeam，语义不混）。
 * 抽本镜成片首帧，R-B 出 OPENER_TONE_GATE 带宽即告警，写 shots.seam_check
 * （与 checkSeam 同一个字段、同一个 alert 语义，前端标红与锁4 拦截都不用分叉）。
 * fire-and-forget：失败只抛错给调用方记日志，绝不影响出片主流程。
 */
export async function checkOpenerTone(shot) {
  const videoUrl = String(shot.video_url || '').trim()
  if (!videoUrl) throw new Error('该镜还没有成片')

  const absVideo = await resolveLocalMedia(videoUrl, uploadsDir, shot.id, 'tone')
  const firstFrame = await extractFirstFrame(absVideo, shot.id)
  const m = computeMetrics(await frameGrid8(firstFrame))

  const rb = Number((m.meanRgb[0] - m.meanRgb[2]).toFixed(1))
  const alert = rb < OPENER_TONE_GATE.rbMin || rb > OPENER_TONE_GATE.rbMax

  const result = {
    checkedAt: new Date().toISOString(),
    shotId: shot.id,
    checkType: 'openerTone',
    video: { cct: m.cct, luma: m.luma, meanRgb: m.meanRgb },
    rb,
    band: { ...OPENER_TONE_GATE },
    alert,
    // 前端 VideoView 仅在 cctDiffK != null 时拼 "CCT差xxK"：本闸无比对对象，显式置 null 不误导
    cctDiffK: null,
    lumaDiff: null,
    hashDist: null,
    note: '开场镜色向闸：首帧 R-B 出色调家族带宽即告警（校准：正确镜 [-6.1,+2.7]，3-1 跑偏镜 -26.1/-22.0；语义=色调不属 family，不分方向）',
  }
  execute('UPDATE shots SET seam_check = ? WHERE id = ?', [JSON.stringify(result), shot.id])
  return result
}

// 兜底手动接口用：按 shotId 现查现检
export async function checkOpenerToneByShotId(shotId) {
  const shot = queryOne('SELECT * FROM shots WHERE id = ?', [Number(shotId)])
  if (!shot) throw new Error(`镜头不存在 (shotId=${shotId})`)
  return checkOpenerTone(shot)
}
