// 单镜打斗出片服务（MinimaxH3 八月最强打斗武戏 workflow, h3Combat）：
//  - 输入：参考图（image1，必填，喂豆包识别角色/武器 + H3 ref_image_0）+ idea（打斗设定，拼接豆包模板后缀）
//  - 无音频/视频槽：纯动作镜头（打斗通常无对白，音效后期混）。
//  - 打斗能力由工作流内 3 个战斗 LoRA（wushu_spatial_physics / H3_Combat / Bunny_weapon_combat）
//    + 豆包 doubao-seed-2-0-pro 电影级打斗提示词 + two-pass 两轮采样提供。
//  - v2 接口：Bearer + /openapi/v2/run/workflow/{id}
//  - 成片云端 URL 仅 24h 有效，生成后立即下载落 server/uploads（insecureDownload 绕过老 CDN 证书问题）
//  - 2026-09-09 接入；节点映射见 config.js nodeMap.h3Combat
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runWorkflow, uploadMediaFileName, insecureDownload } from './runninghub.js'
import { config } from '../config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const uploadsDir = path.join(__dirname, '..', 'uploads')

// 全透明 1x1 PNG：无可用参考图时的兜底占位，防止云端默认示例图污染画面（与 multiRefVideoV2.js 同）
const BLANK_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

// 打斗工作流 #528 CR Prompt Text 的豆包输入模板：固定引导 + "个人想法输入：" 后缀，业务侧 idea 拼在此后。
// 必须与线上工作流 #528 的原文保持一致（否则覆盖掉"电影级导演 + BUNNY 触发词"引导，打斗效果退化）。
const IDEA_TEMPLATE =
  '根据图像识别适合他的酷炫感和节奏感。需要节奏快，有蓄力和快慢的节奏，然后开头先输出 BUNNY 这个词后再正常输出提示词。\n个人想法输入：'

// 分辨率白名单：aspect_ratio 与 h3StoryboardV2 的 ResolutionSelector 枚举一致；
// megapixels 打斗工作流枚举较宽（0.2~2.0），做数字范围校验而非固定档位。
const COMBAT_ASPECT_RATIOS = [
  '1:1 (Square)',
  '2:3 (Portrait Photo)',
  '3:2 (Photo)',
  '3:4 (Portrait Standard)',
  '4:3 (Standard)',
  '9:16 (Portrait Widescreen)',
  '16:9 (Widescreen)',
  '21:9 (Ultrawide)',
]
const COMBAT_DURATION_MIN = 5
const COMBAT_DURATION_MAX = 15

/**
 * 归一化打斗出片参数：非法值回落空串（不传，工作流用默认 16:9 / 0.7），避免整条任务被节点校验打回。
 * duration 夹到 5~15（工作流 #457 表达式 max(5,...) 对 <5s 归一，15s 是豆包模板的默认时长）。
 */
function normalizeCombatParams(params = {}) {
  const aspectRatio = COMBAT_ASPECT_RATIOS.includes(params.aspectRatio) ? params.aspectRatio : ''
  const mp = Number(params.megapixels)
  const megapixels = Number.isFinite(mp) && mp >= 0.2 && mp <= 2.0 ? String(mp) : ''
  const duration = Math.min(
    COMBAT_DURATION_MAX,
    Math.max(COMBAT_DURATION_MIN, Math.round(Number(params.duration) || 6))
  )
  return { aspectRatio, megapixels, duration }
}

/**
 * 生成单镜打斗成片（h3Combat 工作流）。
 * @param {Object} params
 * @param {string} params.idea - 打斗设定（谁对谁、武器、胜负、关键动作、场景）；拼在豆包模板后缀，不能为空
 * @param {string} [params.storyboardImage] - 参考图 URL（image1 必填槽；缺省用透明占位图避免云端示例污染）
 * @param {string} params.shotId - 镜头 ID（用于落盘文件命名）
 * @param {string} [params.aspectRatio] - 宽高比（见 COMBAT_ASPECT_RATIOS）
 * @param {number|string} [params.megapixels] - 清晰度（0.2~2.0）
 * @param {number} [params.duration] - 时长秒数（5~15）
 * @param {Object} options - 透传 runWorkflow：{ onProgress, cancelToken, timeout, usageContext }
 * @returns {Promise<{success: boolean, videoUrl?: string, taskId?: string, error?: string, warning?: string}>}
 */
export async function generateShotVideoCombat(params = {}, options = {}) {
  const { idea, storyboardImage = '', shotId = 'x' } = params

  const ideaText = String(idea || '').trim()
  if (!ideaText) {
    return { success: false, error: '打斗工作流要求 idea 打斗设定（对阵双方 / 武器 / 胜负 / 关键动作 / 场景），不能为空' }
  }

  const { aspectRatio, megapixels, duration } = normalizeCombatParams(params)

  options.onProgress?.('uploading', { message: '上传参考图...' })

  // image1 = 参考图（唯一图片输入，喂豆包识别角色/武器 + H3 ref_image_0），缺省用透明占位
  let image1
  try {
    image1 = await uploadMediaFileName(storyboardImage || BLANK_PNG)
  } catch (e) {
    return { success: false, error: `参考图上传失败: ${e.message}` }
  }

  // 组装 values：idea 拼到豆包模板后缀；aspectRatio/megapixels 只在给了合法值时传（空值被 runWorkflow 跳过，工作流用默认）。
  // 机位锁（2026-09-09 shot37 实测）：原作者豆包模板没有机位约束，模型会自由发挥成"冲向镜头"的
  // 抖音式炫酷镜头（v1 翻车：布布前 2.5s 一直冲屏幕）。实测在 idea 尾部追加侧面机位硬约束后
  // （v2，taskId 2097493727600930817），全程锁定侧面机位。业务 idea 已含机位/镜头/视角类约束词时
  // 视为显式指定（想要冲镜头特写的镜头可自己写"面向镜头"），不重复追加。
  const CAMERA_LOCK =
    '全程侧面机位拍摄，镜头与战斗双方连线平行，禁止角色转向镜头或冲向镜头方向移动，禁止面向镜头挥拳。'
  // 注意：检测词不能用单独的"镜头"——自动组装的 idea 必含"近景镜头"等景别词，会误判为已有机位约束。
  // 只匹配明确的机位约束词组（面向/冲向/转向镜头、机位、POV、视角、镜头固定等）。
  const hasCameraLock = /机位|POV|视角|面向镜头|冲向镜头|转向镜头|镜头固定|固定镜头/.test(ideaText)
  // 拼接处标点适配：idea 末尾先统一为单个句号再接机位锁，避免"固定。。全程"这类双句号
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

  // 提交 + 轮询：豆包 + 3 LoRA + two-pass 两轮采样整体耗时较久，放宽到 60 分钟
  // （超时集中在 config.runninghub.h3CombatTimeoutMs，env RH_H3_COMBAT_TIMEOUT_MS 可覆盖）
  const result = await runWorkflow('h3Combat', values, {
    timeout: config.runninghub.h3CombatTimeoutMs,
    ...options,
    usageContext: { task: 'video-h3-combat', ...options.usageContext },
  })

  if (!result.success || !result.url) {
    return result
  }

  // 成片落地：云端 URL 仅 24h 有效，立即下载到 server/uploads
  try {
    options.onProgress?.('downloading', { message: '下载成片到本地...' })
    const buf = await insecureDownload(result.url)
    const filename = `shot_${shotId}_h3combat_${Date.now()}.mp4`
    fs.mkdirSync(uploadsDir, { recursive: true })
    fs.writeFileSync(path.join(uploadsDir, filename), buf)
    return { ...result, videoUrl: `/uploads/${filename}` }
  } catch (e) {
    // 下载失败不判整单失败：退化返回云端 URL（24h 内仍可播放），并在结果里带警告
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
