
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../config.js'
import { chatCompletion } from './doubao.js'
import { mimeFromExt } from './shared.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOADS_DIR = path.resolve(__dirname, '../uploads')

export const SCENE_DEFECT_TYPES = [
  'element_missing', 
  'env_mismatch',    
  'structure_mismatch', 
  'viewpoint_wrong', 
  'extra_object',    
]

export function resolveLocalSceneImage(storedUrl) {
  const s = String(storedUrl || '').trim()
  if (!s) return null
  const m = s.match(/^\/uploads\/([^/?#]+)$/)
  if (!m) return null
  const abs = path.join(UPLOADS_DIR, m[1])
  if (!abs.startsWith(UPLOADS_DIR)) return null   
  return fs.existsSync(abs) ? abs : null
}

export function parseSceneReview(raw) {
  try {
    const m = String(raw || '').match(/\{[\s\S]*\}/)
    if (!m) return { defects: [], summary: '' }
    const parsed = JSON.parse(m[0])
    const defects = Array.isArray(parsed.defects)
      ? parsed.defects
          .filter((d) => d && typeof d.type === 'string')
          .map((d) => ({
            type: SCENE_DEFECT_TYPES.includes(d.type) ? d.type : 'element_missing',
            evidence: String(d.evidence || '').slice(0, 200),
          }))
      : []
    return { defects, summary: String(parsed.summary || '').slice(0, 200) }
  } catch {
    return { defects: [], summary: '' }
  }
}

export function shouldReviewScene(ctx) {
  const el = Array.isArray(ctx?.elements) ? ctx.elements.filter(Boolean) : []
  const env = Array.isArray(ctx?.sharedEnv) ? ctx.sharedEnv.filter(Boolean) : []
  const role = String(ctx?.spatialRole || '').trim()
  return el.length > 0 || env.length > 0 || !!ctx?.hasSpatialRef || !!role
}

export function buildSceneReviewChecklist(ctx) {
  const parts = []
  const el = Array.isArray(ctx?.elements) ? ctx.elements.filter(Boolean) : []
  const env = Array.isArray(ctx?.sharedEnv) ? ctx.sharedEnv.filter(Boolean) : []
  const role = String(ctx?.spatialRole || '').trim()

  if (el.length) {
    parts.push(`【本场必须可见的要素】${el.join('、')}`)
  }
  if (env.length) {
    parts.push(`【本场景与同空间其它场景共有的环境特征】${env.join('、')}`)
  }
  if (role) {
    parts.push(`【本场机位/视角】${role}`)
  }
  if (ctx?.hasLayout) {
    parts.push('【空间结构基准】本场生成时使用了一张空间布局示意图作为结构参考（它规定了地标物体的位置关系与朝向）。')
  }
  return parts.join('\n')
}

export async function reviewSceneImage(storedUrl, opts = {}) {
  const model = config.llm?.vlmModel
  if (!model) {
    return { verdict: 'skip', defects: [], summary: '', skipReason: '场景图闸未配置模型（LLM_VLM_MODEL）' }
  }
  if (!shouldReviewScene(opts.ctx)) {
    return { verdict: 'skip', defects: [], summary: '', skipReason: '本场无可比对清单（要素/环境/机位均空），跳过内容质检' }
  }
  const abs = resolveLocalSceneImage(storedUrl)
  if (!abs) {
    return { verdict: 'skip', defects: [], summary: '', skipReason: '图片本地文件不存在，跳过质检' }
  }

  const checklist = buildSceneReviewChecklist(opts.ctx)

  try {
    const content = [
      {
        type: 'image_url',
        image_url: { url: `data:${mimeFromExt(abs)};base64,${fs.readFileSync(abs).toString('base64')}` },
      },
      {
        type: 'text',
        text: `你是短剧场景图的质检员。下面给你这张**已经画好的场景图**，以及它**本该呈现**的内容清单。
请逐项核对清单里的内容有没有出现在画面中，以及画面有没有出现清单之外的、明显不该有的主体。

【本该呈现的内容清单】
${checklist}

【判定标准】——只报下列问题，不要评价构图美感、不要评价画得好不好：
1. element_missing 要素缺失：清单里明确列出的某个要素，在画面中**找不到**（看不清也算缺失）。
2. env_mismatch 环境不符：清单描述的环境特征（如雾、雪、光线、天气）与画面明显矛盾，
   例如清单说"浓雾"而画面是通透晴天。
3. structure_mismatch 结构与基准矛盾：清单描述了空间结构基准，而画面里的地标物体位置关系/朝向
   与描述明显冲突（例如描述强调"桥横跨河面"，画面里桥消失了或立在岸上）。
4. viewpoint_wrong 机位不符：清单写明了机位/视角，而画面的视角明显不是那个（例如要求仰视，画面却是俯视）。
5. extra_object 多余主体：画面出现了清单与描述里都没有的、明显抢眼的主体（多出的人物、动物、建筑）。

【重要】以下情况**不算**问题，不要报：
· 画风、笔触、色彩偏好、构图是否好看——一律不评价。
· 清单没提到的东西，画面里**合理存在**（如地面、天空、岩石、植被等自然陪衬）——不算多余。
· 拿不准、看不清、或只是"感觉不太像"——一律不报。宁可漏报也不误杀。

每条问题必须能在画面中指出具体位置与证据。
输出严格 JSON（不要任何其他文字）：
{"defects":[{"type":"element_missing|env_mismatch|structure_mismatch|viewpoint_wrong|extra_object","evidence":"画面中的具体证据，一句话，指出看到了什么/哪里找不到"}],"summary":"一句话结论"}
完全没有上述问题时 defects 输出空数组 []。`,
      },
    ]
    const raw = await chatCompletion(
      [{ role: 'user', content }],
      {
        model,
        temperature: 0.2,
        maxTokens: 900,
        responseFormat: { type: 'json_object' },
        usageContext: { episodeId: opts.episodeId, task: 'scene-review' },
      }
    )
    const { defects, summary } = parseSceneReview(raw)
    return {
      verdict: defects.length ? 'fail' : 'pass',
      defects,
      summary,
      model,
      attempt: opts.attempt || 1,
    }
  } catch (e) {
    console.warn('[sceneReview] 场景图质检失败，跳过（不影响出图）:', e.message)
    return { verdict: 'skip', defects: [], summary: '', skipReason: e.message }
  }
}

export function buildSceneRetryNote(defects) {
  const list = (Array.isArray(defects) ? defects : []).filter(
    (d) => d && SCENE_DEFECT_TYPES.includes(String(d.type || ''))
  )
  if (!list.length) return ''

  const byType = new Map()
  for (const d of list) {
    const t = String(d.type)
    if (!byType.has(t)) byType.set(t, [])
    const ev = String(d.evidence || '').trim()
    if (ev) byType.get(t).push(ev)
  }

  const parts = []
  if (byType.has('element_missing')) {
    const ev = byType.get('element_missing')
    parts.push(
      '**上一版漏画了必须出现的要素**，这一版务必把它们**明确画进画面**（要看得见，不能只是氛围暗示）：' +
      ev.map((e) => `（${e}）`).join('')
    )
  }
  if (byType.has('env_mismatch')) {
    const ev = byType.get('env_mismatch')
    parts.push(
      '**上一版的环境特征与要求不符**，这一版必须按清单描述呈现环境（不要画成相反或不同的天气/光照）：' +
      ev.map((e) => `（${e}）`).join('')
    )
  }
  if (byType.has('structure_mismatch')) {
    const ev = byType.get('structure_mismatch')
    parts.push(
      '**上一版的空间结构与参考底图不一致**，这一版必须保持地标物体的位置关系与朝向与底图相同，不要挪动或替换：' +
      ev.map((e) => `（${e}）`).join('')
    )
  }
  if (byType.has('viewpoint_wrong')) {
    const ev = byType.get('viewpoint_wrong')
    parts.push(
      '**上一版的机位/视角画错了**，这一版必须严格按要求的角度呈现：' +
      ev.map((e) => `（${e}）`).join('')
    )
  }
  if (byType.has('extra_object')) {
    parts.push('**上一版画了不该有的东西**，这一版不要添加要求之外的任何主体（人物、动物、建筑）。')
  }
  return `\n⚠️ 上一版被质检判定为不符合要求，请针对性修正：${parts.join('')}`
}
