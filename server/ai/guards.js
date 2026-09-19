// 出片/生图/分镜共用的前置守卫（2026-09-14 从 routes/generate.js 抽出）
//
// 抽取背景：generate.js 曾是 3186 行的单体（32 路由、占全项目路由代码 66%）。
// 静态分析发现真正跨路由组复用的纯守卫只有这 3 个，先把它们收敛到一处，
// 再按功能把路由拆到 generate-script/image/video/post 四个文件。
// 三个守卫都是「无状态纯函数」——只查库 + 抛带 status 的错误，调用方统一 try/catch → 400/404/409。
import { queryOne } from '../db.js'
import { scriptHash } from '../scriptHash.js'
import { findStylePoison } from './storyboardValidator.js'

/**
 * 剧本确认闸：未确认剧本前禁止下游生成。
 * @throws {Error} status=404（集不存在）/ 400（未确认）
 */
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

/**
 * 指纹过期强制校验（stale 服务端兜底，不依赖前端自觉）：
 * 资产/分镜提取保存后剧本又被实质修改（指纹不一致）时，拦截下游生成，
 * 强制用户先重新提取资产/重新生成分镜，避免旧数据继续产出不一致内容。
 * fp 为空（老数据，提取时还没有指纹机制）时跳过不拦，保证存量数据可用。
 * @throws {Error} status=404（集不存在）/ 409（已过期）
 */
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

/**
 * 画风毒词硬闸（V12，2026-09-12，与台词闸同级的出片前置拦截）：
 * 镜头文本含"写实/CGI/photoreal/3D render"等风格切换词时直接抛 400 拦下，
 * 不花币出一条画风跑偏的片——第1集武戏段 8 镜全被拉去写实 CGI 的全段返工事故
 * 就是这些词进的 prompt（overview.md 09-12 晚）。词表与 storyboardValidator.js V12
 * 同一份（findStylePoison 导出复用，一处维护）；白名单 = 项目画风文本本身含该词
 * （写实风项目写"写实"合法）。确属有意切画风（如整集异画风实验片）传 allowStyleShift 显式放行。
 * 调用方模式与 assertScriptConfirmed 一致：try { assertNoStylePoison(shot, allow) } catch → 400。
 * @throws {Error} status=400（含毒词）
 */
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
  } catch { /* 画风查不到时无白名单，毒词全拦 */ }
  const hits = findStylePoison(
    [
      shot.description,
      shot.integrated_multimodal_description,
      shot.final_frame,
      // 字段覆盖补齐（2026-09-12 晚复扫实锤 5-3 action_note 残留「写实」）：v4 prompt 组装
      // 消费 action_note（v4Video.js rawAction），grid 路由消费 action_note + video_prompt_override，
      // blocking_plan 也进 v4——凡是能流进出片 prompt 的文本字段，闸门必须同口径全扫。
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
