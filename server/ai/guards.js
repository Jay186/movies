import { queryOne } from '../db.js'
import { scriptHash } from '../scriptHash.js'
import { TYPE_CHARACTER, TYPE_SCENE, TYPE_PROP, assetLabel, assetTable } from './assetTypes.js'

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
// 表名与中文标签取自 ASSET_META 单一事实源；why 为该类型的守卫说明文案，随类型走。
const ASSET_CLASSES = [
  { table: assetTable(TYPE_CHARACTER), label: assetLabel(TYPE_CHARACTER), why: '角色缺了，characters 字段全空，生图没有人物参考图' },
  { table: assetTable(TYPE_SCENE), label: assetLabel(TYPE_SCENE), why: '场景缺了，sceneAssets 全空，环境与画风会跟着角色参考图漂' },
  { table: assetTable(TYPE_PROP), label: assetLabel(TYPE_PROP), why: '道具缺了，propAssets 全空，关键道具会被模型自由发挥' },
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

// （QC 画风毒词硬门禁 assertNoStylePoison 已随 QC 整体移除：2026-09-26。
//  画风统一改由提示词规则前置约束——storyboardRules.styleLockRule 引用
//  storyboardValidator 的毒词词典，把禁用词写进生成规则，不再做事后拦截。）
