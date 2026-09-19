import path from 'node:path'
import fs from 'node:fs'
import { queryOne, execute } from '../db.js'
import { resolveLocalMedia } from './runninghub.js'
import { uploadsDir } from '../paths.js'


const SEAM_ALERT = {
  cctDiffK: 1000, 
  lumaDiff: 45,   
}

const OPENER_TONE_GATE = { rbMin: -12, rbMax: 12 }

const hamming = (a, b) => {
  let d = 0
  for (let i = 0; i < 64; i++) if ((a[i] !== b[i])) d++
  return d
}

const srgbToLinear = (c8) => {
  const c = c8 / 255
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function rgbToCct(r, g, b) {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b)
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

async function frameGrid8(filePath) {
  const { stdout } = await runFfmpeg([
    '-y', '-i', filePath,
    '-vf', 'scale=8:8:flags=area',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ], { maxBuffer: 1 << 20, encoding: 'buffer' })
  if (!stdout || stdout.length < 192) throw new Error(`帧像素读取失败: ${filePath}`)
  return stdout
}

function computeMetrics(grid ) {
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


async function extractFirstFrame(absVideo, shotId) {
  const contDir = path.join(uploadsDir, 'continuity')
  fs.mkdirSync(contDir, { recursive: true })
  const outPath = path.join(contDir, `shot_${shotId}_first.jpg`)
  await runFfmpeg(['-y', '-i', absVideo, '-update', '1', '-frames:v', '1', outPath])
  if (!fs.existsSync(outPath)) throw new Error('首帧抽取失败：输出为空')
  return outPath
}

export async function checkSeam(shot) {
  const videoUrl = String(shot.video_url || '').trim()
  const anchorUrl = String(shot.continuity_url || '').trim()
  if (!videoUrl) throw new Error('该镜还没有成片')
  if (!anchorUrl) throw new Error('本镜没有 continuity 锚（首镜/新场景首镜），跳过检测')

  const absVideo = await resolveLocalMedia(videoUrl, shot.id, 'seam')
  const absAnchor = await resolveLocalMedia(anchorUrl, shot.id, 'anchor')

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
    thresholds: { cctDiffK: SEAM_ALERT.cctDiffK, lumaDiff: SEAM_ALERT.lumaDiff },
    note: 'hashDist 为构图参考指标（跨镜重新取景是合法操作，不参与告警）',
  }
  execute('UPDATE shots SET seam_check = ? WHERE id = ?', [JSON.stringify(result), shot.id])
  return result
}

export async function checkSeamByShotId(shotId) {
  const shot = queryOne('SELECT * FROM shots WHERE id = ?', [Number(shotId)])
  if (!shot) throw new Error(`镜头不存在 (shotId=${shotId})`)
  return checkSeam(shot)
}

export async function checkOpenerTone(shot) {
  const videoUrl = String(shot.video_url || '').trim()
  if (!videoUrl) throw new Error('该镜还没有成片')

  const absVideo = await resolveLocalMedia(videoUrl, shot.id, 'tone')
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
    cctDiffK: null,
    lumaDiff: null,
    hashDist: null,
    note: '开场镜色向闸：首帧 R-B 出色调家族带宽即告警（校准：正确镜 [-6.1,+2.7]，3-1 跑偏镜 -26.1/-22.0；语义=色调不属 family，不分方向）',
  }
  execute('UPDATE shots SET seam_check = ? WHERE id = ?', [JSON.stringify(result), shot.id])
  return result
}

export async function checkOpenerToneByShotId(shotId) {
  const shot = queryOne('SELECT * FROM shots WHERE id = ?', [Number(shotId)])
  if (!shot) throw new Error(`镜头不存在 (shotId=${shotId})`)
  return checkOpenerTone(shot)
}
