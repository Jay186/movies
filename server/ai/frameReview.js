import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chatCompletion } from './doubao.js'
import { config } from '../config.js'
import { mimeFromExt } from './shared.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const uploadsDir = path.join(__dirname, '..', 'uploads')

const HARD_DEFECT_RULE = `只检查下列【硬伤】，不要评价构图美感、不要评价表演、不要评价分镜设计是否合理：
1. limb_anomaly 肢体畸形：手指数量明显错误、四肢断裂或扭曲成不可能的角度、多出一条手臂或一条腿、身体与头部连接错位。
2. face_broken 面部崩坏：五官明显错位或融化塌陷、眼睛数量异常、面部结构严重扭曲到无法辨认。
3. character_duplicated 角色被复制：同一个角色在同一画面里重复出现两次以上（例如同一只小熊出现在两个位置），或角色数量与描述严重不符。
4. text_watermark 文字水印：画面中出现了文字、字幕、水印、角标、UI 元素、角色设定图残留的标注格或色块小格。
5. style_drift 画风漂移：画面不是手绘 / 水彩 / 动画质感，而是写实照片、3D 渲染、或与"吉卜力风格手绘动画"严重不符的质感。
6. panel_split 分栏拼贴：画面被切成多格、并排多个视图、或呈现角色设定图式的多视角排布（应是一个完整单场景）。
每条硬伤必须能在画面中指出具体位置与证据。看不清、拿不准、或只是"不够好看"的，一律不算硬伤。`

function resolveLocalImage(storedUrl) {
  const u = String(storedUrl || '').trim()
  if (!u.startsWith('/uploads/')) return null
  const rel = decodeURIComponent(u.slice('/uploads/'.length))
  if (rel.split('/').some((seg) => seg === '..')) return null
  const p = path.join(uploadsDir, rel)
  return fs.existsSync(p) ? p : null
}


export async function reviewFrameImage(storedUrl, opts = {}) {
  const model = config.llm?.vlmModel
  if (!model) return { verdict: 'skip', defects: [], summary: '', skipReason: '观片闸未配置模型（LLM_VLM_MODEL）' }
  const abs = resolveLocalImage(storedUrl)
  if (!abs) return { verdict: 'skip', defects: [], summary: '', skipReason: '图片本地文件不存在，跳过验收' }

  try {
    const content = [
      {
        type: 'image_url',
        image_url: { url: `data:${mimeFromExt(abs)};base64,${fs.readFileSync(abs).toString('base64')}` },
      },
      {
        type: 'text',
        text: `你是 AI 生成分镜图的画质检员。这张图将作为短剧的一个镜头画面进入成片流程，请判断它是否属于「必须重画」的废图。\n\n${HARD_DEFECT_RULE}\n\n输出严格 JSON（不要任何其他文字）：\n{"defects":[{"type":"limb_anomaly|face_broken|character_duplicated|text_watermark|style_drift|panel_split","evidence":"画面中的具体证据，一句话"}],"summary":"一句话结论"}\n没有硬伤时 defects 输出空数组 []。`,
      },
    ]
    const raw = await chatCompletion(
      [{ role: 'user', content }],
      {
        model,
        temperature: 0.2,
        maxTokens: 800,
        responseFormat: { type: 'json_object' },
        usageContext: { episodeId: opts.episodeId, task: 'frame-review' },
      }
    )
    const m = String(raw).match(/\{[\s\S]*\}/)
    const parsed = JSON.parse(m ? m[0] : raw)
    const defects = Array.isArray(parsed.defects)
      ? parsed.defects
          .filter((d) => d && typeof d.type === 'string')
          .map((d) => ({ type: String(d.type).slice(0, 40), evidence: String(d.evidence || '').slice(0, 200) }))
      : []
    return {
      verdict: defects.length ? 'fail' : 'pass',
      defects,
      summary: String(parsed.summary || '').slice(0, 200),
      model,
    }
  } catch (e) {
    console.warn('[frameReview] 分镜图验收失败，跳过（不影响出图）:', e.message)
    return { verdict: 'skip', defects: [], summary: '', skipReason: e.message }
  }
}
