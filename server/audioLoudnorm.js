
import fs from 'node:fs'
import path from 'node:path'


export const PER_SHOT_TARGET = -20 
export const FINAL_TARGET = -16    
export const TRUE_PEAK = -1.5     

export async function measureLoudness(file) {
  let stderr = ''
  try {
    ;({ stderr } = await runFfmpeg([
      '-hide_banner', '-nostats',
      '-i', file,
      '-af', `loudnorm=I=${FINAL_TARGET}:TP=${TRUE_PEAK}:LRA=11:print_format=json`,
      '-f', 'null', '-',
    ]))
  } catch (e) {
    stderr = String(e.stderr || '')
  }
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

export function loudnormFilter(measured, target = PER_SHOT_TARGET) {
  return `loudnorm=I=${target}:TP=${TRUE_PEAK}:LRA=11`
    + `:measured_I=${measured.I.toFixed(2)}:measured_TP=${measured.tp.toFixed(2)}`
    + `:measured_LRA=${measured.lra.toFixed(2)}:measured_thresh=${measured.thresh.toFixed(2)}`
    + `:offset=${measured.targetOffset.toFixed(2)}:linear=true`
}

export async function normalizeFinalLoudness(file, tmpDir, { target = FINAL_TARGET } = {}) {
  const measured = await measureLoudness(file)
  if (!measured) return { applied: false, reason: 'silent-or-unreadable' }
  const out = path.join(tmpDir, `ln_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp4`)
  await runFfmpeg([
    '-y', '-i', file,
    '-af', loudnormFilter(measured, target),
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart',
    out,
  ])
  fs.copyFileSync(out, file)
  try { fs.rmSync(out) } catch {  }
  return { applied: true, from: Math.round(measured.I * 10) / 10, to: target }
}
