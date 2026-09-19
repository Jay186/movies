
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../config.js'
import { chatCompletion } from './doubao.js'
import { mimeFromExt } from './shared.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOADS_DIR = path.resolve(__dirname, '../uploads')

export const MAX_LAYOUT_ATTEMPTS = 3

export const LAYOUT_DEFECT_TYPES = [
  'text',        
  'leader_line', 
  'character',   
  'extra_object',
  'atmosphere',  
]

export function resolveLocalLayoutImage(storedUrl) {
  const s = String(storedUrl || '').trim()
  if (!s) return null
  const m = s.match(/^\/uploads\/([^/?#]+)$/)
  if (!m) return null
  const abs = path.join(UPLOADS_DIR, m[1])
  if (!abs.startsWith(UPLOADS_DIR)) return null
  return fs.existsSync(abs) ? abs : null
}

export function parseLayoutReview(raw) {
  try {
    const m = String(raw || '').match(/\{[\s\S]*\}/)
    if (!m) return { defects: [], summary: '' }
    const parsed = JSON.parse(m[0])
    const defects = Array.isArray(parsed.defects)
      ? parsed.defects
          .filter((d) => d && typeof d.type === 'string')
          .map((d) => ({
            type: LAYOUT_DEFECT_TYPES.includes(d.type) ? d.type : 'text',
            evidence: String(d.evidence || '').slice(0, 200),
          }))
      : []
    return { defects, summary: String(parsed.summary || '').slice(0, 200) }
  } catch {
    return { defects: [], summary: '' }
  }
}

export async function reviewLayoutImage(storedUrl, opts = {}) {
  const model = config.llm?.vlmModel
  if (!model) {
    return { verdict: 'skip', defects: [], summary: '', skipReason: '布局图闸未配置模型（LLM_VLM_MODEL）' }
  }
  const abs = resolveLocalLayoutImage(storedUrl)
  if (!abs) {
    return { verdict: 'skip', defects: [], summary: '', skipReason: '图片本地文件不存在，跳过验收' }
  }

  try {
    const content = [
      {
        type: 'image_url',
        image_url: { url: `data:${mimeFromExt(abs)};base64,${fs.readFileSync(abs).toString('base64')}` },
      },
      {
        type: 'text',
        text: `你是美术设计稿的质检员。这张图是一张**空间布局示意图**（等轴测/俯视的空间关系图），
它会被用作后续多张场景图的参考底图——同组的每一张场景图都会继承它上面的东西，
所以**它上面任何多余的内容都会被放大到每一张成品图里**。

请只判断下面这几类**会污染后续生成**的问题：

【text】**图中出现任何文字**：汉字、字母、数字、标签、注记、标题、题注，无论中文英文，
   也无论是否带引线、是否只是单个字母或数字。（这是最严重的一类）
【leader_line】出现指引线、箭头、图例框、比例尺、指北针、坐标格、机位/眼睛图标等**符号标记**。
【character】出现角色、人物、动物（哪怕很小、哪怕只是剪影），或脚印、足迹等角色痕迹。
【extra_object】出现明显不属于这张空间结构的多余物体（例如凭空多出的树、动物、建筑、器物）。
【atmosphere】画了雾、云、雨、雪、水汽、光晕等大气现象，或明显的光照/色温氛围渲染。

注意：地形、水体、植被、岩石、道具（如桥、路）本身**是正常的**，不属于 extra_object；
扁平色块、简单几何形状、素净的矢量画法**是正常的**，不要因为"画得简单"而判违规。

输出严格 JSON（不要任何其他文字）：
{"defects":[{"type":"text|leader_line|character|extra_object|atmosphere","evidence":"画面中的具体证据，一句话，指出在哪个位置看到了什么"}],"summary":"一句话结论"}
完全没有上述问题时 defects 输出空数组 []。`,
      },
    ]
    const raw = await chatCompletion(
      [{ role: 'user', content }],
      {
        model,
        temperature: 0.2,
        maxTokens: 800,
        responseFormat: { type: 'json_object' },
        usageContext: { episodeId: opts.episodeId, task: 'layout-review' },
      }
    )
    const { defects, summary } = parseLayoutReview(raw)
    return {
      verdict: defects.length ? 'fail' : 'pass',
      defects,
      summary,
      model,
      attempt: opts.attempt || 1,
    }
  } catch (e) {
    console.warn('[layoutReview] 布局图验收失败，跳过（不影响出图）:', e.message)
    return { verdict: 'skip', defects: [], summary: '', skipReason: e.message }
  }
}

export function buildLayoutRetryNote(defects) {
  const types = new Set(
    (Array.isArray(defects) ? defects : [])
      .map((d) => String(d?.type || ''))
      .filter((t) => LAYOUT_DEFECT_TYPES.includes(t))
  )
  if (!types.size) return ''
  const parts = []
  if (types.has('text')) {
    parts.push(
      '**这张图上一个字都不许有。** 不要写任何汉字、字母、数字、标签或标题；' +
      '不要用引线指到物体上再写名字。物体靠**它自己的形状**辨认，不靠文字说明。'
    )
  }
  if (types.has('leader_line')) {
    parts.push('不要画指引线、箭头、图例框、比例尺、指北针、坐标格或任何图标符号。')
  }
  if (types.has('character')) {
    parts.push('不要画任何角色、人物、动物，也不要画脚印或足迹。')
  }
  if (types.has('extra_object')) {
    parts.push('只画清单里列出的东西，不要添加清单之外的任何物体。')
  }
  if (types.has('atmosphere')) {
    parts.push('不要画雾、云、雨、雪、光晕或任何光照氛围。')
  }
  return `\n⚠️ 上一版被判定为不合格，请针对性修正：${parts.join('')}`
}
