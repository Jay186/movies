import { Router } from 'express'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { query, queryOne, execute } from '../db.js'
import { removeLocalUploads, filterUnreferencedUploadUrls } from '../ai/shared.js'
import { config } from '../config.js'

const router = Router()

const uploadsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'uploads')

const ASPECT_RATIO_WHITELIST = new Set(config.video.aspectRatios)

function normalizeAspectRatio(v) {
  if (v === undefined || v === null || v === '') return null
  return ASPECT_RATIO_WHITELIST.has(v) ? v : null
}

router.get('/', (req, res) => {
  const projects = query(`
    SELECT p.*, COUNT(e.id) AS episode_count
    FROM projects p
    LEFT JOIN episodes e ON e.project_id = p.id
    GROUP BY p.id
    ORDER BY p.updated_at DESC
  `)
  res.json(projects)
})

router.get('/:id', (req, res) => {
  const project = queryOne('SELECT * FROM projects WHERE id = ?', [req.params.id])
  if (!project) return res.status(404).json({ error: '项目不存在' })
  res.json(project)
})

router.post('/', (req, res) => {
  const { title = '新项目', theme = '', art_style = config.defaultArtStyle } = req.body
  const aspectRatio = normalizeAspectRatio(req.body.aspect_ratio) || config.video.defaultAspectRatio
  const result = execute(
    'INSERT INTO projects (title, theme, art_style, aspect_ratio) VALUES (?, ?, ?, ?)',
    [title, theme, art_style, aspectRatio]
  )
  execute(
    'INSERT INTO episodes (project_id, episode_number, title) VALUES (?, 1, ?)',
    [result.lastInsertRowid, '第 1 集']
  )
  const project = queryOne('SELECT * FROM projects WHERE id = ?', [result.lastInsertRowid])
  res.status(201).json(project)
})

router.put('/:id', (req, res) => {
  const { title, theme, art_style } = req.body
  const aspectRatio = normalizeAspectRatio(req.body.aspect_ratio)
  if (aspectRatio === null && req.body.aspect_ratio !== undefined && req.body.aspect_ratio !== '') {
    return res.status(400).json({ error: `aspect_ratio 非法：${req.body.aspect_ratio}（白名单：${[...ASPECT_RATIO_WHITELIST].join(' / ')}）` })
  }
  const sets = [
    'title = COALESCE(?, title)',
    'theme = COALESCE(?, theme)',
    'art_style = COALESCE(?, art_style)',
  ]
  const params = [title, theme, art_style]
  if (aspectRatio !== null) {
    sets.push('aspect_ratio = ?')
    params.push(aspectRatio)
  }
  sets.push('updated_at = CURRENT_TIMESTAMP')
  params.push(req.params.id)
  execute(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`, params)
  const project = queryOne('SELECT * FROM projects WHERE id = ?', [req.params.id])
  res.json(project)
})

router.delete('/:id', (req, res) => {
  execute('PRAGMA foreign_keys = ON')
  const candidates = []
  const epRows = query('SELECT id FROM episodes WHERE project_id = ?', [req.params.id])
  for (const ep of epRows) {
    const rows = query(
      `SELECT c.image_url u FROM characters c WHERE c.episode_id = ?
       UNION ALL SELECT c2.audio_url FROM characters c2 WHERE c2.episode_id = ?
       UNION ALL SELECT p.image_url FROM props p WHERE p.episode_id = ?
       UNION ALL SELECT sc.image_url FROM scenes sc WHERE sc.episode_id = ?
       UNION ALL SELECT s.storyboard_url FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id WHERE ss.episode_id = ?
       UNION ALL SELECT s.frame_url FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id WHERE ss.episode_id = ?
       UNION ALL SELECT s.frame_url2 FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id WHERE ss.episode_id = ?
       UNION ALL SELECT s.blocking_url FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id WHERE ss.episode_id = ?
       UNION ALL SELECT s.video_url FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id WHERE ss.episode_id = ?
       UNION ALL SELECT s.continuity_url FROM shots s JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id WHERE ss.episode_id = ?
       UNION ALL SELECT ss2.grid_image_url FROM storyboard_scenes ss2 WHERE ss2.episode_id = ?`,
      [ep.id, ep.id, ep.id, ep.id, ep.id, ep.id, ep.id, ep.id, ep.id, ep.id, ep.id]
    )
    candidates.push(...rows.map((r) => r.u))
  }
  const pcRows = query(
    'SELECT image_url u FROM project_characters WHERE project_id = ? UNION ALL SELECT audio_url FROM project_characters WHERE project_id = ?',
    [req.params.id, req.params.id]
  )
  candidates.push(...pcRows.map((r) => r.u))
  execute('DELETE FROM projects WHERE id = ?', [req.params.id])
  removeLocalUploads(filterUnreferencedUploadUrls(candidates), uploadsDir)
  res.json({ success: true })
})

router.get('/:id/assets', (req, res) => {
  const projectId = req.params.id
  const type = req.query.type 

  const validTypes = {
    characters: 'SELECT c.* FROM characters c JOIN episodes e ON c.episode_id = e.id WHERE e.project_id = ? ORDER BY c.id',
    scenes: 'SELECT s.* FROM scenes s JOIN episodes e ON s.episode_id = e.id WHERE e.project_id = ? ORDER BY s.id',
    props: 'SELECT p.* FROM props p JOIN episodes e ON p.episode_id = e.id WHERE e.project_id = ? ORDER BY p.id',
  }

  if (type && validTypes[type]) {
    const items = query(validTypes[type], [projectId])
    return res.json(items)
  }

  const characters = query(validTypes.characters, [projectId])
  const scenes = query(validTypes.scenes, [projectId])
  const props = query(validTypes.props, [projectId])
  res.json({ characters, scenes, props })
})

export default router
