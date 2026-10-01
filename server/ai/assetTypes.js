export const TYPE_CHARACTER = 'character'

export const TYPE_SCENE = 'scene'

export const TYPE_PROP = 'prop'

export const ASSET_TYPES = [TYPE_CHARACTER, TYPE_SCENE, TYPE_PROP]

// 资产类型的单一事实源：类型 → 中文标签 / 数据表 / 主键字段 / 描述字段 / 列表查询列。
// 新增资产类型只改这张表（+ DB 的 CHECK 约束），主流程代码不动。
// 各处不得再用 'character' / 'scene' / 'prop' 裸字面量，也不得各自定义一份中文标签。
export const ASSET_META = {
  [TYPE_CHARACTER]: {
    label: '角色',
    table: 'characters',
    idField: 'id',
    nameField: 'name',
    descField: 'description',
    listCols: 'id, episode_id',
  },
  [TYPE_SCENE]: {
    label: '场景',
    table: 'scenes',
    idField: 'id',
    nameField: 'title',
    descField: 'summary',
    listCols: 'id, episode_id, scene_number, summary',
  },
  [TYPE_PROP]: {
    label: '道具',
    table: 'props',
    idField: 'id',
    nameField: 'name',
    descField: 'description',
    listCols: 'id, episode_id',
  },
}

// 类型 → 素材库业务枚举（大写），避免各处再写一份 bizTypeMap
export const ASSET_BIZ_TYPE = {
  [TYPE_CHARACTER]: 'CHARACTER',
  [TYPE_SCENE]: 'SCENE',
  [TYPE_PROP]: 'PROP',
}

// 上传资源引用列的单一事实源：哪张表的哪个列存 /uploads/ URL。
// 新增资产类型 / 新增一张存资源的表，只在这里加一条数据，清理与引用计数代码不动。
//
// cols        该表记录 uploads URL 的列
// episode     该表如何按「集」归属：null=不随集（全局资源）；'own'=表自带 episode_id；
//             'shot'=需 JOIN storyboard_scenes 才能按集定位
// refTarget   是否算作「素材库封面被引用」的来源（素材库自身不算，否则自己引用自己）
export const UPLOAD_REF_SOURCES = [
  { assetType: TYPE_CHARACTER, table: 'characters', cols: ['image_url', 'audio_url'], episode: 'own', refTarget: true },
  { assetType: TYPE_CHARACTER, table: 'project_characters', cols: ['image_url', 'audio_url'], episode: null, refTarget: true },
  { assetType: TYPE_CHARACTER, table: 'ip_characters', cols: ['image_url', 'audio_url'], episode: null, refTarget: true },
  { assetType: TYPE_PROP, table: 'props', cols: ['image_url'], episode: 'own', refTarget: true },
  { assetType: TYPE_SCENE, table: 'scenes', cols: ['image_url'], episode: 'own', refTarget: true },
  {
    table: 'shots',
    cols: ['storyboard_url', 'frame_url', 'frame_url2', 'blocking_url', 'video_url', 'continuity_url'],
    episode: 'shot',
    refTarget: true,
  },
  { table: 'storyboard_scenes', cols: ['grid_image_url'], episode: 'own', refTarget: true },
  { table: 'library_assets', cols: ['cover_url'], episode: null, refTarget: false },
]

// 全库扫描 SQL（每条一个 UNION ALL 组），用于「哪些上传文件已无人引用」
export const uploadRefGlobalSql = () =>
  UPLOAD_REF_SOURCES.map((s) => s.cols.map((c) => `SELECT ${c} AS u FROM ${s.table}`).join(' UNION ALL '))

// 按集扫描 SQL：返回 { sql, paramCount }，参数均为 episodeId
export function uploadRefEpisodeSql() {
  const parts = []
  let paramCount = 0
  for (const s of UPLOAD_REF_SOURCES) {
    if (!s.episode) continue
    for (const c of s.cols) {
      if (s.episode === 'shot') {
        parts.push(
          `SELECT s.${c} AS u FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id WHERE ss.episode_id = ?`
        )
      } else {
        parts.push(`SELECT ${c} AS u FROM ${s.table} WHERE episode_id = ?`)
      }
      paramCount += 1
    }
  }
  return { sql: parts.join(' UNION ALL '), paramCount }
}

// 素材库封面引用计数 SQL：返回 { sql, paramCount }，参数均为同一个 url
export function uploadRefCountSql() {
  const parts = []
  let paramCount = 0
  for (const s of UPLOAD_REF_SOURCES) {
    if (!s.refTarget) continue
    for (const c of s.cols) {
      parts.push(`SELECT 1 FROM ${s.table} WHERE ${c} = ?`)
      paramCount += 1
    }
  }
  return { sql: parts.join(' UNION ALL '), paramCount }
}

// 素材库封面引用分布 SQL（列表页批量算 referencedBy）
export function uploadRefGroupSql() {
  const parts = []
  for (const s of UPLOAD_REF_SOURCES) {
    if (!s.refTarget) continue
    for (const c of s.cols) {
      parts.push(`SELECT ${c} AS u FROM ${s.table} WHERE ${c} != ''`)
    }
  }
  return parts.join(' UNION ALL ')
}

export const assetMeta = (type) => ASSET_META[type] || null
export const assetLabel = (type) => ASSET_META[type]?.label || ''
export const assetTable = (type) => ASSET_META[type]?.table || ''
export const assetDescField = (type) => ASSET_META[type]?.descField || 'description'
export const isAssetType = (type) => Object.prototype.hasOwnProperty.call(ASSET_META, type)
