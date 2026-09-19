// A4/A5 · 场景图视觉质检闭环（2026-09-17）
//
// 存在理由：A1/A2 已经把「本场必须可见的要素」与「同空间共有环境」注入 prompt，
//   A3 又把布局图作为 refs[0] 注入空间结构——但**注入 ≠ 画出来**。
//   实测过的两类静默失败：
//     · 摘要写「清晨浓雾」，出图是晴空（要素被模型当"氛围形容词"淡化）
//     · 布局图上的断桥在成品图里消失 / 换了形制（结构没被继承）
//   这两类都是"图看着挺好、但与剧本不符"，肉眼抽查才能发现。本模块把它变成**自动可检出**。
//
// 与 frameReview.js / layoutReview.js 的分工（三者互补，不重叠）：
//   frameReview  —— 分镜图「废图硬伤」（畸形/崩脸/文字/画风），**不看内容对不对**
//   layoutReview —— 布局示意图「文字污染」（它自己作为参考底图会被全组继承）
//   本模块       —— 场景图「**内容符合度**」：该有的要素有没有、结构对不对、机位对不对
//
// ⚠️ 通用性铁律：本模块**零题材词表、零正则匹配画面内容**。
//   判定依据只有两个：① 调用方传进来的 prompt（剧本侧真值）② 图片本身。
//   代码只负责"调模型 + 解析 JSON + 落降级"，不做任何语义判断。
//   换题材/换语言都不需要改这里——因为"该有什么"是 prompt 里写的，不是代码里写的。
//
// 设计口径（沿用 frameReview 的失败哲学）：
//   · 判定必须保守：误杀会把好图打回并白烧一次生图（~90s），所以只认**清单里写明的东西没画**，
//     且要求给出画面证据；拿不准一律放过。
//   · 本函数绝不抛错：模型不可用/额度耗尽/返回异常 → verdict='skip'，由调用方原样出图。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../config.js'
import { chatCompletion } from './doubao.js'
// [去重 2026-09-19] MIME 推断收口到 shared.mimeFromExt（原本文件/layoutReview/sceneReview
// 各写一份逐字节相同的 mimeOf）。shared 版本是超集：额外覆盖音频扩展名。
import { mimeFromExt } from './shared.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOADS_DIR = path.resolve(__dirname, '../uploads')

/**
 * 问题类型（闭集，便于测试与前端展示）。
 * 只列**能由 prompt 侧真值直接比对**的几类——不掺任何主观美术评价。
 */
export const SCENE_DEFECT_TYPES = [
  'element_missing', // 要素清单里写明的东西在画面里看不到
  'env_mismatch',    // 共有环境（如雾/雪/光照）与清单不符
  'structure_mismatch', // 空间结构/物体位置与布局图矛盾（桥没了、地形改了）
  'viewpoint_wrong', // 机位/视角与要求的空间角色不符（要求仰视画成了俯视）
  'extra_object',    // 出现 prompt 中完全没有的多余主体（凭空多出的人物/建筑）
]

/**
 * 把落盘地址解析为本地绝对路径。不存在返回 null（绝不让调用方抛错）。
 * 只接受 /uploads/<单段文件名>，防目录穿越（与 layoutReview 同口径）。
 * @param {string} storedUrl
 * @returns {string|null}
 */
export function resolveLocalSceneImage(storedUrl) {
  const s = String(storedUrl || '').trim()
  if (!s) return null
  const m = s.match(/^\/uploads\/([^/?#]+)$/)
  if (!m) return null
  const abs = path.join(UPLOADS_DIR, m[1])
  if (!abs.startsWith(UPLOADS_DIR)) return null   // 目录穿越双保险
  return fs.existsSync(abs) ? abs : null
}

/**
 * 从模型返回的原文里解析出问题清单。脏输入一律降级为 []（不误杀）。
 * 独立导出以便测试（纯函数，无网络）。
 * @param {string} raw
 * @returns {{defects:Array<{type:string,evidence:string}>, summary:string}}
 */
export function parseSceneReview(raw) {
  try {
    const m = String(raw || '').match(/\{[\s\S]*\}/)
    if (!m) return { defects: [], summary: '' }
    const parsed = JSON.parse(m[0])
    const defects = Array.isArray(parsed.defects)
      ? parsed.defects
          .filter((d) => d && typeof d.type === 'string')
          .map((d) => ({
            // 未知类型收敛为 element_missing（最保守的默认：指向"东西没画出来"，
            // 而不是指向"多画了东西"——多画才需要重画，少画有时可接受）
            type: SCENE_DEFECT_TYPES.includes(d.type) ? d.type : 'element_missing',
            evidence: String(d.evidence || '').slice(0, 200),
          }))
      : []
    return { defects, summary: String(parsed.summary || '').slice(0, 200) }
  } catch {
    return { defects: [], summary: '' }
  }
}

/**
 * 判断"这张场景图有没有资格进入质检"。
 *
 * 为什么要有这道门：质检的全部价值来自「与 prompt 里写明的清单比对」。
 * 若清单是空的（老数据 / 分析未跑的场景），比对基准不存在——此时不能拿"画面很好看"
 * 当合格证据，而应**整体跳过**（不产生任何判定），否则就是在用模型偏好冒充质检。
 *
 * 纯函数，便于测试。
 * @param {{elements?:string[], sharedEnv?:string[], hasSpatialRef?:boolean, spatialRole?:string}} ctx
 * @returns {boolean}
 */
export function shouldReviewScene(ctx) {
  const el = Array.isArray(ctx?.elements) ? ctx.elements.filter(Boolean) : []
  const env = Array.isArray(ctx?.sharedEnv) ? ctx.sharedEnv.filter(Boolean) : []
  const role = String(ctx?.spatialRole || '').trim()
  // 没有任何可比对的真值 → 无从质检（不是"合格"，是"没得比"）
  return el.length > 0 || env.length > 0 || !!ctx?.hasSpatialRef || !!role
}

/**
 * 组装喂给视觉模型的"真值清单"段落。空项自动省略（不留空标题）。
 * 纯函数，便于测试 —— 也让"到底拿什么当比对基准"这件事有单一事实来源。
 *
 * @param {{elements?:string[], sharedEnv?:string[], spatialRole?:string, hasLayout?:boolean}} ctx
 * @returns {string}
 */
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

/**
 * 场景图内容质检。绝不抛错：任何异常降级为 verdict='skip'（放行，不阻断出图）。
 *
 * @param {string} storedUrl - 落盘后的本地地址（/uploads/xxx.png）
 * @param {Object} opts - { episodeId, sceneId, sceneNumber, ctx, attempt }
 *        ctx = { elements, sharedEnv, spatialRole, hasLayout }
 * @returns {Promise<{verdict:'pass'|'fail'|'skip', defects:Array, summary:string, model?:string, skipReason?:string}>}
 */
export async function reviewSceneImage(storedUrl, opts = {}) {
  const model = config.llm?.vlmModel
  if (!model) {
    return { verdict: 'skip', defects: [], summary: '', skipReason: '场景图闸未配置模型（LLM_VLM_MODEL）' }
  }
  // 没有可比对真值 → 跳过（见 shouldReviewScene 注释：不是"合格"，是"没得比"）
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
    // 质检本身故障（额度/网络/JSON）绝不能影响出图主流程 —— 与 frameReview/layoutReview 同口径
    console.warn('[sceneReview] 场景图质检失败，跳过（不影响出图）:', e.message)
    return { verdict: 'skip', defects: [], summary: '', skipReason: e.message }
  }
}

/**
 * 根据上一轮检出的问题，构造**针对性的加固指令**，拼到下一轮 prompt 末尾。
 * 纯函数，便于测试。空清单返回 ''（不改变首轮 prompt 一个字）。
 *
 * 设计要点（与 layoutReview 同）：只针对**实际检出的**问题加固，不做预防性堆砌。
 * 逐条把"上一版画错了什么"回述给模型，比泛泛地说"要画全"有效得多。
 *
 * @param {Array<{type:string,evidence?:string}>} defects
 * @returns {string}
 */
export function buildSceneRetryNote(defects) {
  const list = (Array.isArray(defects) ? defects : []).filter(
    (d) => d && SCENE_DEFECT_TYPES.includes(String(d.type || ''))
  )
  if (!list.length) return ''

  // 按类型归并，同类只加一次指令（多条 element_missing 合并成一句，避免重复堆砌）
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
