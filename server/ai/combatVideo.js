import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runWorkflow, uploadMediaFileName, insecureDownload } from './runninghub.js'
import { config } from '../config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const uploadsDir = path.join(__dirname, '..', 'uploads')

const BLANK_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const IDEA_TEMPLATE =
  '根据图像识别适合他的酷炫感和节奏感。需要节奏快，有蓄力和快慢的节奏，然后开头先输出 BUNNY 这个词后再正常输出提示词。\n个人想法输入：'

const COMBAT_ASPECT_RATIOS = config.video.combatAspectRatios
const COMBAT_DURATION_MIN = config.video.combatDurationMin
const COMBAT_DURATION_MAX = config.video.combatDurationMax

function normalizeCombatParams(params = {}) {
  const aspectRatio = COMBAT_ASPECT_RATIOS.includes(params.aspectRatio) ? params.aspectRatio : ''
  const mp = Number(params.megapixels)
  const megapixels = Number.isFinite(mp) && mp >= 0.2 && mp <= 2.0 ? String(mp) : ''
  const duration = Math.min(
    COMBAT_DURATION_MAX,
    Math.max(COMBAT_DURATION_MIN, Math.round(Number(params.duration) || config.video.combatDefaultDuration))
  )
  return { aspectRatio, megapixels, duration }
}

export async function generateShotVideoCombat(params = {}, options = {}) {
  const { idea, storyboardImage = '', shotId = 'x' } = params

  const ideaText = String(idea || '').trim()
  if (!ideaText) {
    return { success: false, error: '打斗工作流要求 idea 打斗设定（对阵双方 / 武器 / 胜负 / 关键动作 / 场景），不能为空' }
  }

  const { aspectRatio, megapixels, duration } = normalizeCombatParams(params)

  options.onProgress?.('uploading', { message: '上传参考图...' })

  let image1
  try {
    image1 = await uploadMediaFileName(storyboardImage || BLANK_PNG)
  } catch (e) {
    return { success: false, error: `参考图上传失败: ${e.message}` }
  }

  const CAMERA_LOCK =
    '全程侧面机位拍摄，镜头与战斗双方连线平行，禁止角色转向镜头或冲向镜头方向移动，禁止面向镜头挥拳。'
  const hasCameraLock = /机位|POV|视角|面向镜头|冲向镜头|转向镜头|镜头固定|固定镜头/.test(ideaText)
  const finalIdeaText = hasCameraLock
    ? ideaText
    : ideaText.replace(/[。，、；,;\s]*$/, '') + '。' + CAMERA_LOCK

  const values = {
    image1,
    idea: IDEA_TEMPLATE + finalIdeaText,
    duration: String(duration),
  }
  if (aspectRatio) values.aspectRatio = aspectRatio
  if (megapixels) values.megapixels = megapixels

  const result = await runWorkflow('h3Combat', values, {
    timeout: config.runninghub.h3CombatTimeoutMs,
    ...options,
    usageContext: { task: 'video-h3-combat', ...options.usageContext },
  })

  if (!result.success || !result.url) {
    return result
  }

  try {
    options.onProgress?.('downloading', { message: '下载成片到本地...' })
    const buf = await insecureDownload(result.url)
    const filename = `shot_${shotId}_h3combat_${Date.now()}.mp4`
    fs.mkdirSync(uploadsDir, { recursive: true })
    fs.writeFileSync(path.join(uploadsDir, filename), buf)
    return { ...result, videoUrl: `/uploads/${filename}` }
  } catch (e) {
    console.warn(
      `[generateShotVideoCombat] 成片落本地失败（shot ${shotId}），返回 24h 云端 URL:`,
      e.message
    )
    return {
      ...result,
      videoUrl: result.url,
      warning: '成片下载到本地失败，当前为 24 小时时效的云端链接，请尽快转存',
    }
  }
}
