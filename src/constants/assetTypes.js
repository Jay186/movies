// 资产类型的唯一事实源（前端）。取值与 server/ai/assetTypes.js 严格一致。
// 新增资产类型只改这两个文件（+ DB 的 CHECK 约束），视图与组件代码不动。
export const TYPE_CHARACTER = 'character'
export const TYPE_SCENE = 'scene'
export const TYPE_PROP = 'prop'

export const ASSET_TYPES = [TYPE_CHARACTER, TYPE_SCENE, TYPE_PROP]

export const ASSET_META = {
  [TYPE_CHARACTER]: { label: '角色', table: 'characters' },
  [TYPE_SCENE]: { label: '场景', table: 'scenes' },
  [TYPE_PROP]: { label: '道具', table: 'props' },
}

export const assetLabel = (type) => ASSET_META[type]?.label || ''

// 类型 → 中文标签（供模板直接取用）
export const ASSET_TYPE_LABEL = Object.fromEntries(
  Object.entries(ASSET_META).map(([type, meta]) => [type, meta.label])
)

// 数据表名 → 类型（后端守卫/提示按表名回传时使用）
export const TABLE_TO_TYPE = Object.fromEntries(
  Object.entries(ASSET_META).map(([type, meta]) => [meta.table, type])
)

export const tableLabel = (table) => ASSET_META[TABLE_TO_TYPE[table]]?.label || ''
