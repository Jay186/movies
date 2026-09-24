import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const serverDir = path.dirname(fileURLToPath(import.meta.url))

export const uploadsDir = path.join(serverDir, 'uploads')

// 跨镜续接锚（首帧/尾帧）统一存放目录：seamCheck 写 first 帧，v4Video 出片后写 last 帧
export const continuityDir = path.join(uploadsDir, 'continuity')

export const tasksDir = path.join(serverDir, 'tasks')
