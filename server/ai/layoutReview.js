// A3 布局图 · 生成后处理闸（2026-09-17）
//
// 存在理由（六轮实测得出的结论）：
//   布局图是「等轴测示意图」，而示意图在图像模型的先验里**天然带标注文字**——
//   "教科书/说明书插图"这个分布几乎总是有标签与指引线。实测六版：
//     v1 满图中文标注 + 眼睛机位图标
//     v3 干净零文字（唯一一次） ← 之后无论怎么改 prompt 都无法复现
//     v4 满屏冰雪质感 + 补画清单外雪松
//     v5 中英文字标注全回来 + 指引线 + 图幅卡
//     v6 正向表述 + 扁平矢量风格锚 → 仍是满图英文标注，且"教科书感"更强
//   且 v3(826字/14否定) 与 v6(889字/14否定) 规模相当，**证明"否定过载"不是主因**：
//   真正的原因是**格式与标注在这个模型的先验里强耦合**——只要它认为自己在画"示意图"，
//   它就会加标签。纯靠 prompt 与之对抗，收益低且不可复现。
//
//   → 因此改为**工程闭环**（与 frameReview.js 同范式）：
//     生成后用视觉模型判定是否违规，违规则带更强的针对性指令重试（上限 N 次）。
//     这样"文字污染"从一个"赌运气"的问题，变成一个**可检出、可重试、可测试**的问题。
//
// ⚠️ 通用性铁律：本模块**零题材词表、零正则匹配画面内容**。
//   所有判定都交给视觉模型；代码只负责"调模型 + 解析 JSON + 落降级"。
//   换题材/换语言（甚至换成写实题材）都不需要改这里。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../config.js'
import { chatCompletion } from './doubao.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOADS_DIR = path.resolve(__dirname, '../uploads')

/** 重试上限（含首次）。每次重试都是一次付费生图，不可放大。 */
export const MAX_LAYOUT_ATTEMPTS = 3

/**
 * 违规类型（闭集，便于测试与前端展示）。
 * 只列**会污染全组生成**的那些——布局图作为 refs[0] 会被同组每个场景继承，
 * 因此它上面任何"多余的东西"都会被放大到全组。
 */
export const LAYOUT_DEFECT_TYPES = [
  'text',        // 图上出现任何文字/字母/数字/标签/题注
  'leader_line', // 指引线、箭头、图例框、比例尺、指北针、坐标格
  'character',   // 出现角色/人物/动物（含本片主角）或角色痕迹
  'extra_object',// 出现了清单之外的多余物体
  'atmosphere',  // 画了雾/云/雨/雪/光晕等大气与光照氛围
]

/**
 * 把落盘地址解析为本地绝对路径。不存在返回 null（绝不让调用方抛错）。
 * @param {string} storedUrl
 * @returns {string|null}
 */
export function resolveLocalLayoutImage(storedUrl) {
  const s = String(storedUrl || '').trim()
  if (!s) return null
  // 只接受 /uploads/ 下的相对地址（与 frameReview 一致的收敛口径，避免任意路径读取）
  const m = s.match(/^\/uploads\/([^/?#]+)$/)
  if (!m) return null
  const abs = path.join(UPLOADS_DIR, m[1])
  // 目录穿越双保险
  if (!abs.startsWith(UPLOADS_DIR)) return null
  return fs.existsSync(abs) ? abs : null
}

function mimeOf(absPath) {
  const ext = path.extname(absPath).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  return 'image/png'
}

/**
 * 从模型返回的原文里解析出违规清单。脏输入一律降级为 []（不误杀）。
 * 独立导出以便测试（纯函数，无网络）。
 * @param {string} raw
 * @returns {{defects:Array<{type:string,evidence:string}>, summary:string}}
 */
export function parseLayoutReview(raw) {
  try {
    const m = String(raw || '').match(/\{[\s\S]*\}/)
    if (!m) return { defects: [], summary: '' }
    const parsed = JSON.parse(m[0])
    const defects = Array.isArray(parsed.defects)
      ? parsed.defects
          .filter((d) => d && typeof d.type === 'string')
          .map((d) => ({
            // 未知类型收敛为 text（最危险的默认），保证闭集
            type: LAYOUT_DEFECT_TYPES.includes(d.type) ? d.type : 'text',
            evidence: String(d.evidence || '').slice(0, 200),
          }))
      : []
    return { defects, summary: String(parsed.summary || '').slice(0, 200) }
  } catch {
    return { defects: [], summary: '' }
  }
}

/**
 * 判定布局图是否可交付。绝不抛错：任何异常降级为 verdict='skip'（放行，不阻断生成）。
 *
 * @param {string} storedUrl - 落盘后的本地地址（/uploads/xxx.png）
 * @param {Object} opts - { episodeId, attempt }
 * @returns {Promise<{verdict:'pass'|'fail'|'skip', defects:Array, summary:string, model?:string, skipReason?:string}>}
 */
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
        image_url: { url: `data:${mimeOf(abs)};base64,${fs.readFileSync(abs).toString('base64')}` },
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
    // 验收本身故障（额度/网络/JSON）绝不能影响出图主流程 —— 与 frameReview 同口径
    console.warn('[layoutReview] 布局图验收失败，跳过（不影响出图）:', e.message)
    return { verdict: 'skip', defects: [], summary: '', skipReason: e.message }
  }
}

/**
 * 根据上一轮的违规清单，构造**针对性的加固指令**，拼到下一轮 prompt 末尾。
 * 纯函数，便于测试。空清单返回 ''（不改变首轮 prompt 一个字）。
 *
 * 设计要点：只针对**实际检出的**问题加固，不做"预防性堆砌"——
 * 六轮实测表明预防性堆砌无效（甚至有害），而针对性指令才有意义。
 *
 * @param {Array<{type:string,evidence?:string}>} defects
 * @returns {string}
 */
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
