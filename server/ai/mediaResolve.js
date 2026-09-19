// 出片后处理链的公共「媒体定位」工具（2026-09-19 去重）。
//
// 存在理由：seamCheck.js（衔接检测）与 shotReview.js（观片闸）各有一份
// 近乎逐字节相同的 resolveLocalMedia —— 唯一差别是远端下载兜底时的落盘文件名
// （seamCheck 用 `shot_${id}_${tag}.mp4`，shotReview 把 tag 写死成 'review_src'）。
// 两处注释互相写着「与 X 同范式」，但改一处另一处不生效。
//
// ⚠️ 为什么不放进 ai/shared.js：
//   shared.js 是**低层纯工具**（不依赖任何 AI 供应商模块），而本模块需要
//   ai/runninghub.js 的 insecureDownload；而 runninghub.js 自身要 import shared.js
//   （mimeFromExt / assertSafeDownloadTarget / uploadsUrlToAbs）。若把本函数塞进
//   shared.js 就会形成 shared ↔ runninghub 循环导入。故独立成中间层：
//        shared.js  ←(无依赖)  mediaResolve.js  →  runninghub.js  →  shared.js ✔ 无环
//
// 两条铁律（与 shared.uploadsUrlToAbs 同口径，历史由 path.basename 扁平化写法
// 导致 `/uploads/segments/segN/x.mp4` 解析失败、段级出片后拼片 400）：
//   ① 保留子目录：不得用 basename 压平路径；
//   ② 防路径穿越：URL 里不允许出现 `..` 段。
import fs from 'node:fs'
import path from 'node:path'
import { insecureDownload } from './runninghub.js'

/**
 * 把媒体地址解析成本地绝对路径。
 * · `/uploads/...` → 直接映射到本地（保留子目录、防穿越、校验存在性）；
 * · `http(s)://...` → 下载兜底（确定性文件名，幂等覆盖不堆积）；
 * · 其他 → 抛错。
 *
 * @param {string} url 媒体地址（落库的 video_url / continuity_url 等）
 * @param {string} uploadDir server/uploads 绝对路径
 * @param {string|number} id 镜头 id（仅用于远端兜底文件名，保证同一镜反复调用幂等）
 * @param {string} tag 用途标签（如 'seam' / 'anchor' / 'tone' / 'review_src'），决定兜底文件名
 * @returns {Promise<string>} 本地绝对路径
 */
export async function resolveLocalMedia(url, uploadDir, id, tag) {
  const u = String(url || '').trim()
  if (u.startsWith('/uploads/')) {
    const rel = decodeURIComponent(u.slice('/uploads/'.length))
    // 防路径穿越：URL 不允许出现 .. 段
    if (rel.split('/').some((seg) => seg === '..')) throw new Error(`非法的媒体地址: ${u}`)
    const p = path.join(uploadDir, rel)
    if (!fs.existsSync(p)) throw new Error(`本地文件已不存在: ${u}`)
    return p
  }
  if (/^https?:/i.test(u)) {
    const buf = await insecureDownload(u)
    const p = path.join(uploadDir, `shot_${id}_${tag}.mp4`)
    fs.writeFileSync(p, buf)
    return p
  }
  throw new Error(`无法识别的媒体地址: ${u}`)
}
