// 全局 IP 角色库 API（跨项目共享的角色源头设定）
import { Router } from 'express'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
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

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads')
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })

const router = Router()

// 列表（带"被多少个项目引用"统计）
router.get('/', (req, res) => {
  res.json(listIpCharacters())
})

// 项目列表（供"应用到项目"下拉选择）
router.get('/projects', (req, res) => {
  res.json(query('SELECT id, title FROM projects ORDER BY id'))
})

// 新建 IP 角色（同名直接返回既有记录）
router.post('/', (req, res) => {
  const name = String(req.body.name || '').trim()
  if (!name) return res.status(400).json({ error: '角色名必填' })
  const existing = findIpCharacterByName(name)
  if (existing) return res.json(existing)
  const created = createIpCharacter({ ...req.body, name })
  res.json(created)
})

// 修改 IP 设定
router.put('/:id', (req, res) => {
  const id = Number(req.params.id)
  if (!getIpCharacter(id)) return res.status(404).json({ error: 'IP 角色不存在' })
  res.json(updateIpCharacter(id, req.body, { allowClear: true }))
})

// 删除 IP（只解除项目引用，不动项目现有数据）
router.delete('/:id', (req, res) => {
  const result = deleteIpCharacter(Number(req.params.id))
  if (result.error) return res.status(404).json(result)
  res.json(result)
})

// 应用到项目：{ projectId } 指定项目，{ all: true } 应用到全部项目
router.post('/:id/apply', (req, res) => {
  const id = Number(req.params.id)
  if (!getIpCharacter(id)) return res.status(404).json({ error: 'IP 角色不存在' })
  if (req.body?.all) {
    // 默认只对齐已有同名角色的项目，不往无关项目里塞角色
    const onlyExisting = req.body.onlyExisting !== false
    return res.json({ success: true, results: applyIpToAllProjects(id, { onlyExisting }) })
  }
  const projectId = Number(req.body?.projectId)
  if (!projectId) return res.status(400).json({ error: 'projectId 必填（或传 all: true）' })
  // 与 all 分支保持一致：默认只覆盖已有同名角色，不凭空给项目新增角色。
  // 只有请求体显式传 create:true 时才允许新建（否则同一动作两种语义，会污染项目角色库）
  const onlyExisting = req.body.create !== true
  const result = applyIpToProject(id, projectId, { onlyExisting })
  res.json({ success: true, results: [result] })
})

// 从项目角色提升为全局 IP：{ projectCharacterId }
router.post('/promote', (req, res) => {
  const projectCharacterId = Number(req.body?.projectCharacterId)
  if (!projectCharacterId) return res.status(400).json({ error: 'projectCharacterId 必填' })
  const result = promoteProjectCharacterToIp(projectCharacterId)
  if (result.error) return res.status(404).json(result)
  res.json({ success: true, ...result, ip: getIpCharacter(result.ipCharacterId) })
})

// 上传 IP 角色音色（base64）
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
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), Buffer.from(base64Data, 'base64'))
    updateIpCharacter(id, { audio_url: `/uploads/${filename}`, audioUrl: `/uploads/${filename}` })
    res.json(getIpCharacter(id))
  } catch (e) {
    console.error('[IP AUDIO UPLOAD ERROR]', e)
    res.status(500).json({ error: '上传失败: ' + e.message })
  }
})

// 删除 IP 角色音色
router.delete('/:id/audio', (req, res) => {
  const id = Number(req.params.id)
  const ip = getIpCharacter(id)
  if (!ip) return res.status(404).json({ error: 'IP 角色不存在' })
  const oldAudioUrl = ip.audio_url
  // 先清 DB 引用再删文件：音色可能已「应用到项目」（project_characters/characters
  // 共享同一文件），全库还有其他引用时文件必须保留
  updateIpCharacter(id, { audio_url: '' })
  if (oldAudioUrl) {
    removeLocalUploads(filterUnreferencedUploadUrls([oldAudioUrl]), UPLOAD_DIR)
  }
  res.json(getIpCharacter(id))
})

export default router
