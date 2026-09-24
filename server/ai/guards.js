import { queryOne } from '../db.js'
import { scriptHash } from '../scriptHash.js'
import { findStylePoison } from './storyboardValidator.js'

export function assertScriptConfirmed(episodeId) {
  const ep = queryOne('SELECT script_confirmed FROM episodes WHERE id = ?', [episodeId])
  if (!ep) {
    const err = new Error('集不存在')
    err.status = 404
    throw err
  }
  if (!ep.script_confirmed) {
    const err = new Error('请先在剧本页确认剧本后再进行此操作')
    err.status = 400
    throw err
  }
}

export function assertNotStale(episodeId, kind) {
  const ep = queryOne('SELECT script_content, assets_script_fp, storyboard_script_fp FROM episodes WHERE id = ?', [episodeId])
  if (!ep) {
    const err = new Error('集不存在')
    err.status = 404
    throw err
  }
  const fp = kind === 'assets' ? ep.assets_script_fp : ep.storyboard_script_fp
  if (!fp) return
  if (fp !== scriptHash(ep.script_content)) {
    const err = new Error(
      kind === 'assets'
        ? '剧本已修改，资产已过期，请先重新提取资产'
        : '剧本已修改，分镜已过期，请先重新生成分镜'
    )
    err.status = 409
    throw err
  }
}

// 资产存在性守卫：characters/scenes/props 任一为空即拒绝。
// 与 assertNotStale 的区别——后者判「资产是否过期」（指纹比对，fp 为空视为无指纹放行），
// 本函数判「资产是否存在」。分镜的资产锚（characters/sceneAssets/propAssets）是"按名匹配"已建资产，
// 空清单会导致镜头无参考图、出片环境与画风漂移，且下游校验多为静默降级，故必须在入口拦截。
const ASSET_CLASSES = [
  { table: 'characters', label: '角色', why: '角色缺了，characters 字段全空，生图没有人物参考图' },
  { table: 'scenes', label: '场景', why: '场景缺了，sceneAssets 全空，环境与画风会跟着角色参考图漂' },
  { table: 'props', label: '道具', why: '道具缺了，propAssets 全空，关键道具会被模型自由发挥' },
]

export function assertAssetsExist(episodeId) {
  const missing = []
  for (const c of ASSET_CLASSES) {
    const row = queryOne(`SELECT count(*) AS n FROM ${c.table} WHERE episode_id = ?`, [episodeId])
    if (!row || !row.n) missing.push({ label: c.label, why: c.why })
  }
  if (missing.length) {
    const err = new Error(
      `本集缺少${missing.map((m) => m.label).join('、')}资产，请先在「设定」页提取/补齐资产后再进行此操作。`
      + `（分镜的资产锚依赖已建资产：${missing.map((m) => m.why).join('；')}）`
    )
    err.status = 409
    err.code = 'ASSETS_MISSING'
    err.missing = missing.map((m) => m.label)
    throw err
  }
}

export function assertNoStylePoison(shot, allowStyleShift) {
  if (allowStyleShift) return
  let styleTexts = ''
  let styleCategory = ''
  try {
    const project = queryOne('SELECT art_style FROM projects WHERE id = (SELECT project_id FROM episodes WHERE id = ?)', [shot.episode_id])
    if (project?.art_style) {
      styleTexts = project.art_style
      const sp = queryOne('SELECT prompt, prompt_en, category_key FROM style_presets WHERE label = ? LIMIT 1', [project.art_style])
      if (sp) {
        styleTexts += '\n' + (sp.prompt || '') + '\n' + (sp.prompt_en || '')
        styleCategory = String(sp.category_key || '').trim()
      }
    }
  } catch {  }
  const hits = findStylePoison(
    [
      shot.description,
      shot.integrated_multimodal_description,
      shot.final_frame,
      shot.action_note,
      shot.blocking_plan,
      shot.video_prompt_override,
    ],
    styleTexts,
    styleCategory
  )
  if (hits.length) {
    const err = new Error(
      `本镜文本含风格切换毒词「${hits.join('、')}」：全片画风统一是铁律（历史实锤：整段被拉去写实画风导致返工）。` +
      `"变强/异变/变身"只能用画面内容表达（体型/毛发/红眼/蒸汽/特效），不能切换画风。` +
      `请编辑该镜描述/prompt 删除这些词；若本集确属有意切换画风，传 allowStyleShift: true 显式放行。`
    )
    err.status = 400
    throw err
  }
}
