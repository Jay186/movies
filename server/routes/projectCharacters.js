import { Router } from 'express'
import { query, queryOne, execute, transaction } from '../db.js'
import {
  getProjectCharacters,
  createProjectCharacter,
  updateProjectCharacter,
  syncProjectCharacterToEpisodes,
  unlinkProjectCharacter,
  countEpisodeUsage,
} from '../characterLibrary.js'

const router = Router()

router.get('/', (req, res) => {
  const projectId = Number(req.query.projectId)
  if (!projectId) return res.status(400).json({ error: 'projectId 必填' })
  const usage = countEpisodeUsage(projectId)
  const list = getProjectCharacters(projectId).map((c) => {
    const u = usage.get(c.id) || { episodes: 0, rows: 0 }
    return {
      ...c,
      imageUrl: c.image_url || '',
      audioUrl: c.audio_url || '',
      usageEpisodes: u.episodes,
      usageRows: u.rows,
    }
  })
  res.json(list)
})

router.post('/', (req, res) => {
  const projectId = Number(req.body.projectId)
  if (!projectId) return res.status(400).json({ error: 'projectId 必填' })
  const name = String(req.body.name || '').trim()
  if (!name) return res.status(400).json({ error: '角色名必填' })
  const existing = queryOne('SELECT * FROM project_characters WHERE project_id = ? AND name = ?', [projectId, name])
  if (existing) return res.json(existing)
  const created = createProjectCharacter(projectId, { ...req.body, name })
  res.json(created)
})

router.put('/:id', (req, res) => {
  const id = Number(req.params.id)
  const master = queryOne('SELECT * FROM project_characters WHERE id = ?', [id])
  if (!master) return res.status(404).json({ error: '角色不存在' })
  let synced = 0
  transaction(() => {
    updateProjectCharacter(id, req.body, { allowClear: true })
    synced = syncProjectCharacterToEpisodes(id)
  })
  res.json({
    ...queryOne('SELECT * FROM project_characters WHERE id = ?', [id]),
    syncedEpisodeRows: synced,
  })
})

router.post('/:id/sync', (req, res) => {
  const id = Number(req.params.id)
  if (!queryOne('SELECT id FROM project_characters WHERE id = ?', [id])) {
    return res.status(404).json({ error: '角色不存在' })
  }
  const synced = syncProjectCharacterToEpisodes(id)
  res.json({ success: true, syncedEpisodeRows: synced })
})

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id)
  if (!queryOne('SELECT id FROM project_characters WHERE id = ?', [id])) {
    return res.status(404).json({ error: '角色不存在' })
  }
  const unlinked = unlinkProjectCharacter(id)
  execute('DELETE FROM project_characters WHERE id = ?', [id])
  res.json({ success: true, unlinkedEpisodeRows: unlinked })
})

router.post('/link-episode', (req, res) => {
  const { episodeId } = req.body || {}
  if (!episodeId) return res.status(400).json({ error: 'episodeId 必填' })
  const episode = queryOne('SELECT project_id FROM episodes WHERE id = ?', [episodeId])
  if (!episode) return res.status(404).json({ error: '集不存在' })
  const rows = query('SELECT * FROM characters WHERE episode_id = ?', [episodeId])
  let linked = 0
  let created = 0
  transaction(() => {
    for (const row of rows) {
      let master = queryOne('SELECT * FROM project_characters WHERE project_id = ? AND name = ?', [episode.project_id, row.name])
      if (!master) {
        master = createProjectCharacter(episode.project_id, row)
        created++
      }
      execute('UPDATE characters SET project_character_id = ? WHERE id = ?', [master.id, row.id])
      linked++
    }
  })
  res.json({ success: true, linked, created })
})

export default router
