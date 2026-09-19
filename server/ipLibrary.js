// 全局 IP 角色库：跨项目共享的角色"源头设定"
//
// 层级关系：IP 角色库 → 项目角色库 → 各集角色
//   ip_characters        唯一源头，与项目无关（布布、一二）
//   project_characters   项目内的主设定，由 IP 派生或项目自建
//   characters           各集引用项目主设定
//
// 改 IP 之后点"应用到项目"，会覆盖项目角色库的同名副本并同步到该项目所有集。
import { query, queryOne, execute, transaction } from './db.js'
import { syncProjectCharacterToEpisodes } from './characterLibrary.js'

const IP_FIELDS = ['name', 'role', 'description', 'appearance', 'image_url', 'audio_url', 'color']

export function listIpCharacters() {
  const rows = query('SELECT * FROM ip_characters ORDER BY id')
  // 统计每个 IP 被多少个项目引用
  const usage = query(
    `SELECT ip_character_id AS ip_id, COUNT(DISTINCT project_id) AS projects
     FROM project_characters WHERE ip_character_id IS NOT NULL GROUP BY ip_character_id`
  )
  const map = new Map(usage.map((u) => [u.ip_id, u.projects]))
  return rows.map((r) => ({
    ...r,
    imageUrl: r.image_url || '',
    audioUrl: r.audio_url || '',
    usedByProjects: map.get(r.id) || 0,
    // 同步状态看板：面板要回答"哪些项目落后了"，直接随列表下发（项目量小，不做开关参数）
    ...getIpSyncSummary(r.id),
  }))
}

// 单个 IP 与各项目副本的同步状态比对
// 查找口径与 applyIpToProject 保持一致：同名 或 ip_character_id 关联
// 比对字段与 apply 覆盖的字段对齐：image_url / description / audio_url
// 状态细分：不一致时用 updated_at 判断"谁新谁有话语权"——
//   项目侧新 → 项目定制（用户故意改的，不必同步）
//   IP 侧新  → 项目落后（IP 改了没推，需要同步）
export function getIpSyncStatus(ipId) {
  const ip = getIpCharacter(ipId)
  if (!ip) return null
  const projects = query('SELECT id, title FROM projects ORDER BY id').map((p) => {
    const pc = queryOne(
      'SELECT * FROM project_characters WHERE project_id = ? AND (name = ? OR ip_character_id = ?)',
      [p.id, ip.name, ipId]
    )
    if (!pc) {
      return { projectId: p.id, title: p.title, status: 'missing', projectCharacterId: null, diffFields: [], stale: false }
    }
    // 字段级 diff
    const diffFields = []
    if (pc.image_url !== (ip.image_url || '')) diffFields.push('image')
    if (pc.description !== (ip.description || '')) diffFields.push('description')
    if (pc.audio_url !== (ip.audio_url || '')) diffFields.push('audio')
    if (diffFields.length === 0) {
      return { projectId: p.id, title: p.title, status: 'synced', projectCharacterId: pc.id, diffFields: [], stale: false }
    }
    // 两侧 updated_at 都是 SQLite CURRENT_TIMESTAMP（YYYY-MM-DD HH:MM:SS），字符串比较可正确排序
    const stale = (pc.updated_at || '') < (ip.updated_at || '')
    return {
      projectId: p.id,
      title: p.title,
      status: 'modified',
      projectCharacterId: pc.id,
      diffFields,
      stale,
    }
  })
  return { ipId, projects }
}

// listIpCharacters 用的展开形式：projects 数组 + 两个计数
function getIpSyncSummary(ipId) {
  const sync = getIpSyncStatus(ipId)
  const projects = sync ? sync.projects : []
  return {
    projects,
    modifiedCount: projects.filter((p) => p.status === 'modified').length,
    missingCount: projects.filter((p) => p.status === 'missing').length,
  }
}

export function getIpCharacter(id) {
  return queryOne('SELECT * FROM ip_characters WHERE id = ?', [id]) || null
}

export function findIpCharacterByName(name) {
  return queryOne('SELECT * FROM ip_characters WHERE name = ?', [String(name || '').trim()]) || null
}

export function createIpCharacter(data = {}) {
  const name = String(data.name || '').trim()
  if (!name) return null
  const r = execute(
    `INSERT INTO ip_characters (name, role, description, appearance, image_url, audio_url, color)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      name,
      data.role || '主角',
      data.description || '',
      data.appearance || '',
      data.image_url || data.imageUrl || '',
      data.audio_url || data.audioUrl || '',
      data.color || '#6b9bd1',
    ]
  )
  return queryOne('SELECT * FROM ip_characters WHERE id = ?', [r.lastInsertRowid])
}

export function updateIpCharacter(id, data = {}, { allowClear = true } = {}) {
  const current = getIpCharacter(id)
  if (!current) return null
  const next = {}
  for (const f of IP_FIELDS) {
    const incoming = data[f]
    if (incoming === undefined || incoming === null) continue
    const value = String(incoming)
    if (value === '' && !allowClear) continue
    next[f] = value
  }
  if (Object.keys(next).length === 0) return current
  const sets = Object.keys(next).map((f) => `${f} = ?`).join(', ')
  execute(
    `UPDATE ip_characters SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [...Object.values(next), id]
  )
  return getIpCharacter(id)
}

// 把 IP 设定写入某个项目的角色库（同名覆盖、没有就新建），并同步该项目所有集
// onlyExisting=true 时只覆盖已有同名角色，不凭空给项目新增角色（「应用到所有项目」的默认行为）
export function applyIpToProject(ipId, projectId, { onlyExisting = false } = {}) {
  const ip = getIpCharacter(ipId)
  if (!ip) return { error: 'IP 角色不存在' }
  if (!projectId) return { error: 'projectId 必填' }

  let pc = queryOne('SELECT * FROM project_characters WHERE project_id = ? AND name = ?', [projectId, ip.name])
    || queryOne('SELECT * FROM project_characters WHERE project_id = ? AND ip_character_id = ?', [projectId, ipId])

  let created = false
  if (!pc && onlyExisting) {
    return { skipped: true, reason: '该项目没有同名角色，已跳过' }
  }
  const values = [ip.name, ip.role || '主角', ip.description || '', ip.appearance || '', ip.image_url || '', ip.audio_url || '', ip.color || '#6b9bd1', ip.id]
  if (!pc) {
    const r = execute(
      `INSERT INTO project_characters (project_id, name, role, description, appearance, image_url, audio_url, color, ip_character_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [projectId, ...values]
    )
    pc = queryOne('SELECT * FROM project_characters WHERE id = ?', [r.lastInsertRowid])
    created = true
  } else {
    execute(
      `UPDATE project_characters SET name=?, role=?, description=?, appearance=?, image_url=?, audio_url=?, color=?, ip_character_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      [...values, pc.id]
    )
  }
  const synced = syncProjectCharacterToEpisodes(pc.id)
  return { projectCharacterId: pc.id, created, syncedEpisodeRows: synced }
}

// 一键应用到所有项目（默认只对齐已有同名角色的项目，不给无关项目凭空加角色）
export function applyIpToAllProjects(ipId, { onlyExisting = true } = {}) {
  const projects = query('SELECT id, title FROM projects ORDER BY id')
  const results = []
  transaction(() => {
    for (const p of projects) {
      const r = applyIpToProject(ipId, p.id, { onlyExisting })
      results.push({ projectId: p.id, title: p.title, ...r })
    }
  })
  return results
}

// 把项目角色提升为全局 IP（按名去重：已有同名 IP 则用项目这份覆盖 IP 设定）
export function promoteProjectCharacterToIp(projectCharacterId) {
  const pc = queryOne('SELECT * FROM project_characters WHERE id = ?', [projectCharacterId])
  if (!pc) return { error: '项目角色不存在' }
  const existing = findIpCharacterByName(pc.name)
  let ip
  if (existing) {
    execute(
      `UPDATE ip_characters SET role=?, description=?, appearance=?, image_url=?, audio_url=?, color=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      [pc.role, pc.description || '', pc.appearance || '', pc.image_url || '', pc.audio_url || '', pc.color || '#6b9bd1', existing.id]
    )
    ip = getIpCharacter(existing.id)
  } else {
    ip = createIpCharacter(pc)
  }
  execute('UPDATE project_characters SET ip_character_id = ? WHERE id = ?', [ip.id, pc.id])
  return { ipCharacterId: ip.id, created: !existing }
}

// 删除 IP：只解除各项目的引用，项目角色保留现有副本，不影响已生成的分镜/视频
export function deleteIpCharacter(id) {
  const ip = getIpCharacter(id)
  if (!ip) return { error: 'IP 角色不存在' }
  const r = execute('UPDATE project_characters SET ip_character_id = NULL WHERE ip_character_id = ?', [id])
  execute('DELETE FROM ip_characters WHERE id = ?', [id])
  return { success: true, unlinkedProjectCharacters: r.changes || 0 }
}
