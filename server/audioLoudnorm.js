// LUFS 响度归一（2026-09-14 上线）：治「每镜独立生成 → 段间响度跳变」的缝合期工程。
//
// 病根：H3 每镜独立出音轨，响度天然各唱各的——第 1 集逐镜实测 -13~-42dB（跨度 29dB），
// MC 接缝另有 -8dB 小瑕疵（89 开头比 88 结尾安静）。拼成片后观众要一直调音量。
// 业界同病同治：HeyGen Video Podcast 管线（主播 -15 vs 嘉宾 -26 LUFS 切镜露馅，LUFS 归一收口）。
//
// 方案两层（缺一不可——只做整片归一平的是整体，段间跳变原样保留，等于白做）：
//   ① 逐镜归一到 -20 LUFS：compose 第 1 步归一化时顺带跑，消除段间跳变；
//      目标留 4dB headroom 给 BGM 混音（amix normalize=0 直接叠加会抬响度）。
//   ② 整片定到 -16 LUFS：BGM 混音之后的终遍（顺序必须在 BGM 后），流媒体交付标准
//      （抖音/Spotify -14~-16 带宽内取稳）。
//
// 两遍式（first pass 测量 → second pass linear 模式按测量值拉平）而非单遍 dynamic：
// dynamic 模式会动态抬/压安静段，产生「呼吸感」——宪法第三条「安静段 7-15s 让情绪
// 落地」禁不起这种抖；linear 是纯增益/衰减，只平移响度不动动态。
//
// 艺术口子：整片归一是线性纯增益，不影响片内相对动态（该安静的段之间仍有差）；
// 逐镜归一会抹平「故意极响/极轻的单镜设计」——路由层留 loudnorm=false 一键关。

import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import ffmpegStaticPath from 'ffmpeg-static'

const execFile = promisify(execFileCb)

export const PER_SHOT_TARGET = -20 // 逐镜：消段间跳变 + BGM headroom
export const FINAL_TARGET = -16    // 整片：流媒体交付标准
export const TRUE_PEAK = -1.5     // 真峰值上限（dBTP），防削波

/**
 * 测量文件的 LUFS 响度（ffmpeg loudnorm 的 first pass，-f null 快测不解码视频流细节）。
 * 返回 { I, tp, lra, thresh, targetOffset }；静音/近静音（< -70 LU）返回 null——
 * 归一无意义且 measured_I="-inf" 进滤镜会炸 NaN，必须跳过。
 */
export async function measureLoudness(file) {
  let stderr = ''
  try {
    ;({ stderr } = await execFile(ffmpegStaticPath, [
      '-hide_banner', '-nostats',
      '-i', file,
      '-af', `loudnorm=I=${FINAL_TARGET}:TP=${TRUE_PEAK}:LRA=11:print_format=json`,
      '-f', 'null', '-',
    ]))
  } catch (e) {
    // ffmpeg 正常跑完也可能走非零退出（部分容器警告），stderr 里 JSON 照找
    stderr = String(e.stderr || '')
  }
  // 正则必须锚定「{ 紧跟 "input_i"」：RH 出片的 mp4 metadata 带 AIGC 标记
  // （如 `AIGC : {"Label": "1", ...}`），杂散 { 早于 JSON 出现——松正则会把
  // 一堆日志裹进 JSON.parse 必炸（2026-09-14 实跑第1集 26 镜全 skip 的根因；
  // 单测素材是 ffmpeg 裸生成的 metadata 干净，没抓到）。
  const m = String(stderr).match(/\{\s*"input_i"\s*:[\s\S]*?\}/)
  if (!m) return null
  try {
    const j = JSON.parse(m[0])
    const I = Number(j.input_i)
    if (!Number.isFinite(I) || I < -70) return null
    return {
      I,
      tp: Number(j.input_tp),
      lra: Number(j.input_lra),
      thresh: Number(j.input_thresh),
      targetOffset: Number(j.target_offset),
    }
  } catch {
    return null
  }
}

/**
 * 拼线性 loudnorm 滤镜串（second pass）。带 measured_* 走 linear=true：
 * 按 first pass 的测量值算一个固定增益，纯平移不动态压缩。
 */
export function loudnormFilter(measured, target = PER_SHOT_TARGET) {
  return `loudnorm=I=${target}:TP=${TRUE_PEAK}:LRA=11`
    + `:measured_I=${measured.I.toFixed(2)}:measured_TP=${measured.tp.toFixed(2)}`
    + `:measured_LRA=${measured.lra.toFixed(2)}:measured_thresh=${measured.thresh.toFixed(2)}`
    + `:offset=${measured.targetOffset.toFixed(2)}:linear=true`
}

/**
 * 整片两遍式归一（BGM 混音之后跑）。就地覆盖 file：视频流 copy 零损失，只重编码音频。
 * 返回 { applied: true, from, to } 或 { applied: false, reason }。
 */
export async function normalizeFinalLoudness(file, tmpDir, { target = FINAL_TARGET } = {}) {
  const measured = await measureLoudness(file)
  if (!measured) return { applied: false, reason: 'silent-or-unreadable' }
  const out = path.join(tmpDir, `ln_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp4`)
  await execFile(ffmpegStaticPath, [
    '-y', '-i', file,
    '-af', loudnormFilter(measured, target),
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart',
    out,
  ])
  fs.copyFileSync(out, file)
  try { fs.rmSync(out) } catch { /* 临时文件清理失败可忽略 */ }
  return { applied: true, from: Math.round(measured.I * 10) / 10, to: target }
}
