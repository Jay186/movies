import path from 'node:path'
import fs from 'node:fs'
import { queryOne } from '../db.js'
import { chatCompletion } from './doubao.js'
import { config } from '../config.js'
import { mimeFromExt, parseJsonLoose } from './shared.js'
import { uploadsDir } from '../paths.js'


// style_drift 不绑定任何具体画风：画风基准随项目 art_style 变化。
// scope：单图验收用“画面”，四宫格逐格验收用“任一格”。
function styleDriftClause(styleLabel, scope = '画面') {
  return styleLabel
    ? `5. style_drift 画风漂移：${scope}整体渲染质感与项目设定画风「${styleLabel}」明显不符、出现异质画面（例如该是动画/手绘的却出成写实照片或3D渲染，或该是写实摄影的却出成手绘动画/3D质感）。`
    : `5. style_drift 画风漂移：${scope}内部出现两种明显不同的渲染质感（如手绘动画与写实照片/3D渲染混杂），或整体质感与参考图严重不符。`
}

function buildHardDefectRule(styleLabel = '') {
  return `只检查下列【硬伤】，不要评价构图美感、不要评价表演、不要评价分镜设计是否合理：
1. limb_anomaly 肢体畸形：手指数量明显错误、四肢断裂或扭曲成不可能的角度、多出一条手臂或一条腿、身体与头部连接错位。
2. face_broken 面部崩坏：五官明显错位或融化塌陷、眼睛数量异常、面部结构严重扭曲到无法辨认。
3. character_duplicated 角色被复制：同一个角色在同一画面里重复出现两次以上（例如同一角色出现在两个不同位置），或角色数量与描述严重不符。
4. text_watermark 文字水印：画面中出现了文字、字幕、水印、角标、UI 元素、角色设定图残留的标注格或色块小格。
${styleDriftClause(styleLabel)}
6. panel_split 分栏拼贴：画面被切成多格、并排多个视图、或呈现角色设定图式的多视角排布（应是一个完整单场景）。
每条硬伤必须能在画面中指出具体位置与证据。看不清、拿不准、或只是"不够好看"的，一律不算硬伤。`
}

// 四宫格验收模式（opts.grid）：图本身是 2×2 分镜拼图，panel_split 不适用；
// 逐格评残，另加格间一致性检查。画风漂移同样随项目画风变化。
function buildHardDefectRuleGrid(styleLabel = '') {
  return `只检查下列【硬伤】，不要评价构图美感、不要评价表演、不要评价分镜设计是否合理：
1. limb_anomaly 肢体畸形：任一格中手指数量明显错误、四肢断裂或扭曲成不可能的角度、多出一条手臂或一条腿、身体与头部连接错位。
2. face_broken 面部崩坏：任一格中五官明显错位或融化塌陷、眼睛数量异常、面部结构严重扭曲到无法辨认。
3. character_duplicated 角色被复制：同一格内同一角色重复出现两次以上、或某格角色数量与该镜头描述严重不符（不同格之间同一角色再次出现属正常分镜，不算）。
4. text_watermark 文字水印：任一格中出现文字、字幕、水印、角标、UI 元素、角色设定图残留的标注格或色块小格。
${styleDriftClause(styleLabel, '任一格')}
6. cross_cell_inconsistency 格间不一致：同一角色在不同格之间外形、服饰、配色明显不一致，或同一场景在不同格之间空间结构、色调明显对不上。
每条硬伤必须指明所在格（左上/右上/左下/右下）与具体证据。看不清、拿不准、或只是"不够好看"的，一律不算硬伤。`
}

function resolveProjectStyleLabel(episodeId) {
  if (!episodeId) return ''
  try {
    const row = queryOne(
      `SELECT p.art_style AS art_style
       FROM projects p JOIN episodes e ON e.project_id = p.id
       WHERE e.id = ? LIMIT 1`,
      [episodeId]
    )
    return String(row?.art_style || '').trim()
  } catch {
    return ''
  }
}

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
  if (!model) return { verdict: 'skip', defects: [], summary: '', skipReason: '视觉模型未配置（LLM_VLM_MODEL）' }
  const abs = resolveLocalImage(storedUrl)
  if (!abs) return { verdict: 'skip', defects: [], summary: '', skipReason: '图片本地文件不存在，跳过验收' }
  const gridMode = Boolean(opts.grid)
  const styleLabel = resolveProjectStyleLabel(opts.episodeId)

  try {
    const askText = gridMode
      ? `你是 AI 生成分镜图的画质检员。这张图是同一镜头的 2×2 四宫格分镜拼图（四个机位画面，将切分后进入成片流程），请判断它是否属于「必须重画」的废图。\n\n${buildHardDefectRuleGrid(styleLabel)}\n\n输出严格 JSON（不要任何其他文字）：\n{"defects":[{"type":"limb_anomaly|face_broken|character_duplicated|text_watermark|style_drift|cross_cell_inconsistency","evidence":"所在格与具体证据，一句话"}],"summary":"一句话结论"}\n没有硬伤时 defects 输出空数组 []。`
      : `你是 AI 生成分镜图的画质检员。这张图将作为短剧的一个镜头画面进入成片流程，请判断它是否属于「必须重画」的废图。\n\n${buildHardDefectRule(styleLabel)}\n\n输出严格 JSON（不要任何其他文字）：\n{"defects":[{"type":"limb_anomaly|face_broken|character_duplicated|text_watermark|style_drift|panel_split","evidence":"画面中的具体证据，一句话"}],"summary":"一句话结论"}\n没有硬伤时 defects 输出空数组 []。`
    const content = [
      {
        type: 'image_url',
        image_url: { url: `data:${mimeFromExt(abs)};base64,${fs.readFileSync(abs).toString('base64')}` },
      },
      {
        type: 'text',
        text: askText,
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
    const parsed = parseJsonLoose(raw)
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
