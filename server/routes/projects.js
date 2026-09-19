import { Router } from 'express'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { query, queryOne, execute } from '../db.js'
// removeLocalUploads 统一到 ai/shared.js（原此处与 episodes.js 各有一份）
import { removeLocalUploads, filterUnreferencedUploadUrls } from '../ai/shared.js'
// [收口 2026-09-19] 建项目时的 art_style 默认值取 config.defaultArtStyle，
// 不再写死 '吉卜力风格'（原本 doubao.js / generate-script.js / 本文件 / qc.js 共 10 处各写一份）。
import { config } from '../config.js'

const router = Router()

const uploadsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'uploads')

// 项目级宽高比白名单：与 server/ai/v4Video.js 的 VIDEO_ASPECT_RATIOS 对齐。
// 严格子集：只接受落库与下游工作流都接受的值；空串/未传 → 不更新（保留原值/落 DEFAULT）。
// 非法值静默回落默认，避免前端脏数据炸 CREATE/UPDATE。
const ASPECT_RATIO_WHITELIST = new Set([
  '4:3 (Standard)',
  '9:16 (Portrait Widescreen)',
  '16:9 (Widescreen)',
  '21:9 (Ultrawide)',
  '1:1 (Square)',
  '3:4 (Portrait Standard)',
])

function normalizeAspectRatio(v) {
  if (v === undefined || v === null || v === '') return null
  return ASPECT_RATIO_WHITELIST.has(v) ? v : null
}

// 获取所有项目
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

// 获取单个项目
router.get('/:id', (req, res) => {
  const project = queryOne('SELECT * FROM projects WHERE id = ?', [req.params.id])
  if (!project) return res.status(404).json({ error: '项目不存在' })
  res.json(project)
})

// 创建项目
router.post('/', (req, res) => {
  const { title = '新项目', theme = '', art_style = config.defaultArtStyle } = req.body
  // 默认竖屏 9:16（短剧形态）；显式传合法值则用传入值
  const aspectRatio = normalizeAspectRatio(req.body.aspect_ratio) || '9:16 (Portrait Widescreen)'
  const result = execute(
    'INSERT INTO projects (title, theme, art_style, aspect_ratio) VALUES (?, ?, ?, ?)',
    [title, theme, art_style, aspectRatio]
  )
  // 自动创建第一集
  execute(
    'INSERT INTO episodes (project_id, episode_number, title) VALUES (?, 1, ?)',
    [result.lastInsertRowid, '第 1 集']
  )
  const project = queryOne('SELECT * FROM projects WHERE id = ?', [result.lastInsertRowid])
  res.status(201).json(project)
})

// 更新项目
router.put('/:id', (req, res) => {
  const { title, theme, art_style } = req.body
  // aspect_ratio 单独处理：null 表示「请求里没带/不带合法值」，不动字段；合法值则覆盖
  const aspectRatio = normalizeAspectRatio(req.body.aspect_ratio)
  if (aspectRatio === null && req.body.aspect_ratio !== undefined && req.body.aspect_ratio !== '') {
    // 调用方显式传了非白名单值：拒绝，避免脏数据落库
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

// 删除项目（外键级联清除其下所有集、剧本、分镜与素材；同时清理 uploads 中的本地生成文件）
router.delete('/:id', (req, res) => {
  execute('PRAGMA foreign_keys = ON')
  // 先收集全部候选文件路径（图片/音频/分镜图/视频/末帧锚/四宫格/项目角色库），
  // 再删 DB（级联），最后只物理删除「全库已无引用」的文件——IP 库/素材库/其他项目
  // 可能通过「从项目选择」「应用到项目」共享同一文件，直接删会误伤
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
  // 项目角色库（主设定）的形象/音色文件
  const pcRows = query(
    'SELECT image_url u FROM project_characters WHERE project_id = ? UNION ALL SELECT audio_url FROM project_characters WHERE project_id = ?',
    [req.params.id, req.params.id]
  )
  candidates.push(...pcRows.map((r) => r.u))
  execute('DELETE FROM projects WHERE id = ?', [req.params.id])
  removeLocalUploads(filterUnreferencedUploadUrls(candidates), uploadsDir)
  res.json({ success: true })
})

// 获取项目中所有集的资产（用于"从项目选择"）
router.get('/:id/assets', (req, res) => {
  const projectId = req.params.id
  const type = req.query.type // characters | scenes | props

  const validTypes = {
    characters: 'SELECT c.* FROM characters c JOIN episodes e ON c.episode_id = e.id WHERE e.project_id = ? ORDER BY c.id',
    scenes: 'SELECT s.* FROM scenes s JOIN episodes e ON s.episode_id = e.id WHERE e.project_id = ? ORDER BY s.id',
    props: 'SELECT p.* FROM props p JOIN episodes e ON p.episode_id = e.id WHERE e.project_id = ? ORDER BY p.id',
  }

  if (type && validTypes[type]) {
    const items = query(validTypes[type], [projectId])
    return res.json(items)
  }

  // 返回全部
  const characters = query(validTypes.characters, [projectId])
  const scenes = query(validTypes.scenes, [projectId])
  const props = query(validTypes.props, [projectId])
  res.json({ characters, scenes, props })
})

export default router
