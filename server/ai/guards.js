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

export function assertNoStylePoison(shot, allowStyleShift) {
  if (allowStyleShift) return
  let styleTexts = ''
  try {
    const project = queryOne('SELECT art_style FROM projects WHERE id = (SELECT project_id FROM episodes WHERE id = ?)', [shot.episode_id])
    if (project?.art_style) {
      styleTexts = project.art_style
      const sp = queryOne('SELECT prompt, prompt_en FROM style_presets WHERE label = ? LIMIT 1', [project.art_style])
      if (sp) styleTexts += '\n' + (sp.prompt || '') + '\n' + (sp.prompt_en || '')
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
    styleTexts
  )
  if (hits.length) {
    const err = new Error(
      `本镜文本含风格切换毒词「${hits.join('、')}」：全片画风统一是铁律（第1集武戏段全写实CGI返工事故的根因）。` +
      `"变强/异变/变身"只能用画面内容表达（体型/毛发/红眼/蒸汽/特效），不能切换画风。` +
      `请编辑该镜描述/prompt 删除这些词；若本集确属有意切换画风，传 allowStyleShift: true 显式放行。`
    )
    err.status = 400
    throw err
  }
}
