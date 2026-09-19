import { query, queryOne, execute, transaction } from './db.js'
import {
  snapshotBeforeExtract,
  computeExtractDiff,
  applyKeepForCharacters,
} from './ai/extractGuard.js'

const MASTER_FIELDS = ['name', 'role', 'description', 'appearance', 'image_url', 'audio_url', 'color', 'name_en', 'description_en']

export function getProjectCharacters(projectId) {
  if (!projectId) return []
  return query('SELECT * FROM project_characters WHERE project_id = ? ORDER BY id', [projectId])
}

export function findProjectCharacter(projectId, { id, name }) {
  if (!projectId) return null
  if (id) {
    const row = queryOne('SELECT * FROM project_characters WHERE id = ? AND project_id = ?', [id, projectId])
    if (row) return row
  }
  if (name) {
    return queryOne('SELECT * FROM project_characters WHERE project_id = ? AND name = ?', [projectId, String(name).trim()]) || null
  }
  return null
}

export function createProjectCharacter(projectId, data = {}) {
  const name = String(data.name || '').trim()
  if (!name) return null
  const r = execute(
    `INSERT INTO project_characters (project_id, name, role, description, appearance, image_url, audio_url, color, name_en, description_en)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      projectId,
      name,
      data.role || '配角',
      data.description || '',
      data.appearance || '',
      data.image_url || data.imageUrl || '',
      data.audio_url || data.audioUrl || '',
      data.color || '#6b9bd1',
      data.name_en || data.nameEn || '',
      data.description_en || data.descriptionEn || '',
    ]
  )
  return queryOne('SELECT * FROM project_characters WHERE id = ?', [r.lastInsertRowid])
}


export function updateProjectCharacter(masterId, data = {}, { allowClear = false } = {}) {
  const current = queryOne('SELECT * FROM project_characters WHERE id = ?', [masterId])
  if (!current) return null
  const next = {}
  for (const f of MASTER_FIELDS) {
    const incoming = data[f]
    if (incoming === undefined || incoming === null) continue
    const value = String(incoming)
    if (value === '' && !allowClear) continue
    next[f] = value
  }
  if (Object.keys(next).length === 0) return current
  const sets = Object.keys(next).map((f) => `${f} = ?`).join(', ')
  execute(
    `UPDATE project_characters SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [...Object.values(next), masterId]
  )
  return queryOne('SELECT * FROM project_characters WHERE id = ?', [masterId])
}

export function syncProjectCharacterToEpisodes(masterId) {
  const master = queryOne('SELECT * FROM project_characters WHERE id = ?', [masterId])
  if (!master) return 0
  const r = execute(
    `UPDATE characters SET
       name = ?, role = ?, description = ?, appearance = ?,
       image_url = ?, audio_url = ?, color = ?, name_en = ?, description_en = ?
     WHERE project_character_id = ?`,
    [master.name, master.role, master.description || '', master.appearance || '',
      master.image_url || '', master.audio_url || '', master.color || '#6b9bd1',
      master.name_en || '', master.description_en || '', masterId]
  )
  return r.changes || 0
}

export function unlinkProjectCharacter(masterId) {
  const r = execute('UPDATE characters SET project_character_id = NULL WHERE project_character_id = ?', [masterId])
  return r.changes || 0
}

export function mergeMasterIntoEpisodeCharacters(rows = []) {
  if (!rows.length) return rows
  const ids = [...new Set(rows.map((r) => r.project_character_id).filter(Boolean))]
  if (!ids.length) return rows
  const masters = new Map(
    query(`SELECT * FROM project_characters WHERE id IN (${ids.map(() => '?').join(',')})`, ids).map((m) => [m.id, m])
  )
  return rows.map((row) => {
    const master = masters.get(row.project_character_id)
    if (!master) return row
    return {
      ...row,
      name: master.name,
      role: master.role,
      description: master.description ?? row.description,
      appearance: master.appearance ?? row.appearance,
      image_url: master.image_url ?? row.image_url,
      audio_url: master.audio_url ?? row.audio_url,
      color: master.color || row.color,
      name_en: master.name_en || row.name_en || '',
      description_en: master.description_en || row.description_en || '',
      projectCharacterId: master.id,
      linkedToProject: true,
    }
  })
}

export function replaceEpisodeCharacters(episodeId, projectId, characters = [], { source = 'edit', decision = '', guard = false } = {}) {
  const isExtract = source === 'extract'

  let effectiveCharacters = characters
  if (isExtract) {
    const oldRows = query('SELECT * FROM characters WHERE episode_id = ? ORDER BY id', [episodeId])
    if (guard) {
      const diffOld = mergeMasterIntoEpisodeCharacters(oldRows)
      const incomingRows = characters.map((c) => {
        const name = String(c.name || '').trim()
        const master = findProjectCharacter(projectId, { id: c.projectCharacterId || c.project_character_id, name })
        const eff = master || c
        return {
          name,
          role: eff.role || '配角',
          description: eff.description || '',
          appearance: eff.appearance || '',
          image_url: eff.image_url || eff.imageUrl || '',
          audio_url: eff.audio_url || eff.audioUrl || '',
          color: eff.color || '#6b9bd1',
          name_en: eff.name_en || eff.nameEn || '',
          description_en: eff.description_en || eff.descriptionEn || '',
        }
      })
      const report = computeExtractDiff({ table: 'characters', oldRows: diffOld, incoming: incomingRows })
      if (report.hasRisk && decision !== 'keep' && decision !== 'accept') {
        return { risk: true, table: 'characters', report }
      }
      if (report.hasRisk && decision === 'keep') {
        effectiveCharacters = applyKeepForCharacters(characters, oldRows)
      }
    }
    snapshotBeforeExtract({ episodeId, trigger: 'extract-characters', tables: ['characters'] })
  }

  const isExtractWrite = isExtract
  transaction(() => {
    execute('DELETE FROM characters WHERE episode_id = ?', [episodeId])
    for (const c of effectiveCharacters) {
      const name = String(c.name || '').trim()
      if (!name) continue
      const incoming = {
        name,
        role: c.role || '配角',
        description: c.description || '',
        appearance: c.appearance || '',
        image_url: c.image_url || c.imageUrl || '',
        audio_url: c.audio_url || c.audioUrl || '',
        color: c.color || '#6b9bd1',
        name_en: c.name_en || c.nameEn || '',
        description_en: c.description_en || c.descriptionEn || '',
        project_character_id: c.projectCharacterId || c.project_character_id || null,
      }

      let master = findProjectCharacter(projectId, { id: incoming.project_character_id, name })
      if (!master) {
        master = createProjectCharacter(projectId, incoming)
      } else if (isExtractWrite) {
        const fill = {}
        for (const f of ['image_url', 'audio_url', 'description', 'appearance', 'name_en', 'description_en']) {
          if (!master[f] && incoming[f]) fill[f] = incoming[f]
        }
        if (Object.keys(fill).length) {
          master = updateProjectCharacter(master.id, fill)
          syncProjectCharacterToEpisodes(master.id)
        }
      } else {
        master = updateProjectCharacter(master.id, incoming, { allowClear: true })
        syncProjectCharacterToEpisodes(master.id)
      }

      const effective = master || incoming
      execute(
        'INSERT INTO characters (episode_id, name, role, description, appearance, image_url, color, audio_url, project_character_id, name_en, description_en) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          episodeId,
          effective.name,
          effective.role || '配角',
          effective.description || '',
          effective.appearance || '',
          effective.image_url || '',
          effective.color || '#6b9bd1',
          effective.audio_url || '',
          master?.id ?? null,
          effective.name_en || '',
          effective.description_en || '',
        ]
      )
    }
  })
  return { risk: false }
}

export function countEpisodeUsage(projectId) {
  if (!projectId) return new Map()
  const rows = query(
    `SELECT pc.id AS master_id, COUNT(DISTINCT c.episode_id) AS episodes, COUNT(c.id) AS rows_count
     FROM project_characters pc
     LEFT JOIN characters c ON c.project_character_id = pc.id
     WHERE pc.project_id = ?
     GROUP BY pc.id`,
    [projectId]
  )
  return new Map(rows.map((r) => [r.master_id, { episodes: r.episodes || 0, rows: r.rows_count || 0 }]))
}
