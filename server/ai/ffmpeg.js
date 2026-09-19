import ffmpegStaticPath from 'ffmpeg-static'
import { execFileAsync } from './exec.js'

export const ffmpegPath = ffmpegStaticPath

export const FFMPEG_MAX_BUFFER = 10 * 1024 * 1024

export function runFfmpeg(args, options = {}) {
  return execFileAsync(ffmpegPath, args, { maxBuffer: FFMPEG_MAX_BUFFER, ...options })
}
