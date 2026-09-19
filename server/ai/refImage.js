import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { config } from '../config.js'
import { runFfmpeg } from './ffmpeg.js'

export async function shrinkRefImage(buffer, tag = 'ref', filename = 'ref.jpg', mimeType = 'image/jpeg') {
  if (!buffer || buffer.length <= config.image.ref.maxBytes) return { buffer, filename, mimeType }
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const tmpDir = os.tmpdir()
  const inPath = path.join(tmpDir, `${tag}_ref_in_${stamp}.img`)
  const outPath = path.join(tmpDir, `${tag}_ref_out_${stamp}.jpg`)
  try {
    fs.writeFileSync(inPath, buffer)
    await runFfmpeg([
      '-y', '-i', inPath,
      '-vf', `scale='min(${config.image.ref.maxEdge},iw)':-2`,
      '-q:v', '4', outPath,
    ])
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
      return { buffer: fs.readFileSync(outPath), filename: 'ref.jpg', mimeType: 'image/jpeg' }
    }
  } catch (e) {
    console.warn(`[${tag}Image] 参考图压缩失败，改用原图:`, e.message)
  } finally {
    for (const p of [inPath, outPath]) {
      try { fs.rmSync(p, { force: true }) } catch {  }
    }
  }
  return { buffer, filename, mimeType }
}
