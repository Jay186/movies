import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const serverDir = path.dirname(fileURLToPath(import.meta.url))

export const uploadsDir = path.join(serverDir, 'uploads')

export const workflowsDir = path.join(serverDir, 'workflows')

export function dirOf(metaUrl) {
  return path.dirname(fileURLToPath(metaUrl))
}
