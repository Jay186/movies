import { Router } from 'express'
import { uploadsUrl, uploadsDir } from '../paths.js'
import fs from 'fs'
import path from 'path'
import { query } from '../db.js'
import { removeLocalUploads, filterUnreferencedUploadUrls } from '../ai/shared.js'

import {
  listIpCharacters,
  getIpCharacter,
  findIpCharacterByName,
  createIpCharacter,
  updateIpCharacter,
  deleteIpCharacter,
  applyIpToProject,
  applyIpToAllProjects,
  promoteProjectCharacterToIp,
} from '../ipLibrary.js'

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true })

const router = Router()

router.get('/', (req, res) => {
  res.json(listIpCharacters())
})

router.get('/projects', (req, res) => {
  res.json(query('SELECT id, title FROM projects ORDER BY id'))
})

router.post('/', (req, res) => {
  const name = String(req.body.name || '').trim()
  if (!name) return res.status(400).json({ error: '角色名必填' })
  const existing = findIpCharacterByName(name)
  if (existing) return res.json(existing)
  const created = createIpCharacter({ ...req.body, name })
  res.json(created)
})

router.put('/:id', (req, res) => {
  const id = Number(req.params.id)
  if (!getIpCharacter(id)) return res.status(404).json({ error: 'IP 角色不存在' })
  res.json(updateIpCharacter(id, req.body, { allowClear: true }))
})

router.delete('/:id', (req, res) => {
  const result = deleteIpCharacter(Number(req.params.id))
  if (result.error) return res.status(404).json(result)
  res.json(result)
})

router.post('/:id/apply', (req, res) => {
  const id = Number(req.params.id)
  if (!getIpCharacter(id)) return res.status(404).json({ error: 'IP 角色不存在' })
  if (req.body?.all) {
    const onlyExisting = req.body.onlyExisting !== false
    return res.json({ success: true, results: applyIpToAllProjects(id, { onlyExisting }) })
  }
  const projectId = Number(req.body?.projectId)
  if (!projectId) return res.status(400).json({ error: 'projectId 必填（或传 all: true）' })
  const onlyExisting = req.body.create !== true
  const result = applyIpToProject(id, projectId, { onlyExisting })
  res.json({ success: true, results: [result] })
})

router.post('/promote', (req, res) => {
  const projectCharacterId = Number(req.body?.projectCharacterId)
  if (!projectCharacterId) return res.status(400).json({ error: 'projectCharacterId 必填' })
  const result = promoteProjectCharacterToIp(projectCharacterId)
  if (result.error) return res.status(404).json(result)
  res.json({ success: true, ...result, ip: getIpCharacter(result.ipCharacterId) })
})

router.post('/:id/audio', (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!getIpCharacter(id)) return res.status(404).json({ error: 'IP 角色不存在' })
    const { audioBase64 } = req.body
    if (!audioBase64) return res.status(400).json({ error: '缺少音频数据' })

    const base64Data = audioBase64.replace(/^data:audio\/\w+;base64,/, '')
    const extMatch = audioBase64.match(/^data:audio\/(\w+);base64,/)
    let ext = extMatch ? extMatch[1] : 'mp3'
    if (ext === 'mpeg') ext = 'mp3'

    const filename = `ip_audio_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${ext}`
    fs.writeFileSync(path.join(uploadsDir, filename), Buffer.from(base64Data, 'base64'))
    updateIpCharacter(id, { audio_url: `${uploadsUrl(filename)}`, audioUrl: `${uploadsUrl(filename)}` })
    res.json(getIpCharacter(id))
  } catch (e) {
    console.error('[IP AUDIO UPLOAD ERROR]', e)
    res.status(500).json({ error: '上传失败: ' + e.message })
  }
})

router.delete('/:id/audio', (req, res) => {
  const id = Number(req.params.id)
  const ip = getIpCharacter(id)
  if (!ip) return res.status(404).json({ error: 'IP 角色不存在' })
  const oldAudioUrl = ip.audio_url
  updateIpCharacter(id, { audio_url: '' })
  if (oldAudioUrl) {
    removeLocalUploads(filterUnreferencedUploadUrls([oldAudioUrl]), uploadsDir)
  }
  res.json(getIpCharacter(id))
})

export default router
