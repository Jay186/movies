import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const serverDir = path.dirname(fileURLToPath(import.meta.url))

export const uploadsDir = path.join(serverDir, 'uploads')

// 跨镜续接锚目录：v4Video 出片后抽取上一镜尾帧（last 帧）供软接续参考
export const continuityDir = path.join(uploadsDir, 'continuity')

export const tasksDir = path.join(serverDir, 'tasks')

// ── 上传资源的 URL 前缀（单一事实源）────────────────────────────────────
// 换存储目录/挂载路径只改这里，不在各路由与 AI 模块里散落 '/uploads/' 字面量。
export const UPLOADS_URL_PREFIX = '/uploads'
export const UPLOADS_URL_SLASH = `${UPLOADS_URL_PREFIX}/`
export const UPLOADS_PREFIX_RE = /^\/uploads\//

export const uploadsUrl = (filename) => `${UPLOADS_URL_PREFIX}/${String(filename || '').replace(/^\/+/, '')}`
export const isUploadUrl = (u) => typeof u === 'string' && u.startsWith(UPLOADS_URL_SLASH)
// URL → 上传目录内的相对路径（去前缀、去查询串、解码）
export const uploadsRelative = (u) =>
  decodeURIComponent(String(u || '').split(/[?#]/)[0]).replace(UPLOADS_PREFIX_RE, '')

// ── 文件名模板（单一事实源）─────────────────────────────────────────────
export const continuityTailImageName = (shotId) => `shot_${shotId}_last.jpg`
export const continuityTailVideoName = (shotId) => `shot_${shotId}_tail.mp4`
export const continuityTailImageUrl = (shotId) => `${UPLOADS_URL_PREFIX}/continuity/${continuityTailImageName(shotId)}`
export const continuityTailImagePath = (shotId) => path.join(continuityDir, continuityTailImageName(shotId))
export const continuityTailVideoPath = (shotId) => path.join(continuityDir, continuityTailVideoName(shotId))
export const shotVideoFilename = (shotId, tag = 'shot') => `shot_${shotId}_${tag}_${Date.now()}.mp4`
