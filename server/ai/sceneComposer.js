// 段级拼片（E 路线 v2，AGENTS.md §九 + §8.4 修复分级）：
//   video_segments（status=done）→ 整场成片。
//   规则（§三）：同场段间硬切走 concat 滤镜（不用 xfade）；每条输入统一时基
//   settb=AVTB,setpts=PTS-STARTPTS（音频 asettb/asetpts）；每段 loudnorm 归一 -16 LUFS（§9.5）。
// 用法（模块）：composeSegments({ localPaths, outPath })
// 用法（CLI）：node _compose_segments.mjs <episode_id> <scene_number>
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import ffmpegStatic from 'ffmpeg-static'

const execFile = promisify(execFileCb)
const ffmpeg = ffmpegStatic || './node_modules/ffmpeg-static/ffmpeg.exe'

/**
 * 拼段成场。
 * 音频：两遍 loudnorm（先测 input_i/tp/lra/thresh，再 linear 精拉到 -16 LUFS/TP -1.5）。
 * 高动态段 TP 不允许拉满时会自动回落动态模式，成片比 -16 低——那是"惊吓后余悸"类段落的
 * 剧作性偏静，不是事故（§9.5：段间差 >6 LU 且非剧情需要才人工干预）。
 * @param {string[]} localPaths 段成片本地路径（播放序）
 * @param {string} outPath 输出 mp4 路径
 * @returns {Promise<{success:boolean, outPath?:string, durationSec?:number, loudness?:object, warning?:string}>}
 */
async function measureLoudnorm(file) {
  const { stderr } = await execFile(ffmpeg, [
    '-i', file, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-',
  ], { maxBuffer: 8 * 1024 * 1024 })
  const json = /\{[^{}]*"input_i"[^{}]*\}/.exec(String(stderr))?.[0]
  if (!json) return null
  try { return JSON.parse(json) } catch { return null }
}

export async function composeSegments({ localPaths, outPath }) {
  if (!localPaths?.length) return { success: false, warning: 'no segments' }
  const missing = localPaths.filter((p) => !fs.existsSync(p))
  if (missing.length) return { success: false, warning: `本地缺失: ${missing.join(', ')}` }

  // 第一遍：逐段测 loudnorm 参数
  const measured = []
  for (const p of localPaths) measured.push(await measureLoudnorm(p))

  // 第二遍：视频仅统一时基；音频 linear loudnorm + 统一采样率（loudnorm 内部 192k，concat 前归一 48k）
  const parts = []
  const gains = []
  for (let i = 0; i < localPaths.length; i++) {
    parts.push(`[${i}:v]settb=AVTB,setpts=PTS-STARTPTS[v${i}]`)
    const m = measured[i]
    const ln = m
      ? `loudnorm=linear=true:I=-16:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}`
      : `loudnorm=I=-16:TP=-1.5:LRA=11`
    parts.push(`[${i}:a]asettb=AVTB,asetpts=PTS-STARTPTS,${ln},aresample=48000[a${i}]`)
    if (m) gains.push(`seg${i + 1}: in ${m.input_i} LUFS → 目标 -16（TP ${m.input_tp}）`)
  }
  const concatIn = localPaths.map((_, i) => `[v${i}][a${i}]`).join('')
  const filterComplex = [...parts, `${concatIn}concat=n=${localPaths.length}:v=1:a=1[v][a]`].join(';')

  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  try {
    await execFile(ffmpeg, [
      '-y', ...localPaths.flatMap((p) => ['-i', p]),
      '-filter_complex', filterComplex,
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-crf', '18', '-preset', 'medium',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
      '-movflags', '+faststart',
      outPath,
    ], { maxBuffer: 64 * 1024 * 1024 })

    // ffmpeg -i 无输出参数会报错退出，但 Duration 在 stderr 里（不能用 stdout）
    const probe = await execFile(ffmpeg, ['-i', outPath], { maxBuffer: 4 * 1024 * 1024 }).catch((e) => e)
    const dur = /Duration: (\d+):(\d+):([\d.]+)/.exec(String(probe?.stderr || ''))
    const durationSec = dur ? (+dur[1]) * 3600 + (+dur[2]) * 60 + (+dur[3]) : null
    return { success: true, outPath, durationSec, loudness: gains }
  } catch (err) {
    return { success: false, warning: String(err.message || err).slice(0, 400) }
  }
}

/**
 * `/uploads/...` URL → **仓库相对路径**（形如 `uploads/segments/seg4/x.mp4`）。
 *
 * ⚠️ 与 `shared.uploadsUrlToAbs` 的区别（2026-09-16 审核标注）：
 *   · 本函数返回**相对路径**，专门给 ffmpeg 传参用（相对路径避免 Windows 盘符/
 *     空格转义问题）；且**不校验文件存在**，交给 ffmpeg 报错。
 *   · `uploadsUrlToAbs` 返回**绝对路径**并校验存在性，给 Node fs 调用方用。
 *   二者语义不同，故未合并。但**子目录保留 + 防穿越**两条铁律必须一致——
 *   历史上 `path.basename()` 扁平化写法导致 `/uploads/segments/segN/x.mp4`
 *   解析失败（拼片 400），是本仓库两次真实故障的根因（见 shared.js 头注）。
 *   修改本函数时请对照 shared.uploadsUrlToAbs 保持两条铁律同步。
 */
export function uploadsToLocal(url) {
  if (!url || typeof url !== 'string') return null
  const rel = url.replace(/^\/+/, '').replace(/^uploads\//, '')
  if (!rel || rel.includes('..') || path.isAbsolute(rel)) return null
  return path.join('uploads', rel)
}
