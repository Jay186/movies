import { Router } from 'express'
import { getDB } from '../db.js'
import { removeLocalUploads } from '../ai/shared.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads')

const router = Router()

// GET /api/library-assets?type=character&source=library|mine&page=1&size=32&keyword=xxx
router.get('/', (req, res) => {
  const db = getDB()
  const { type = 'character', source = 'library', page = 1, size = 32, keyword = '' } = req.query

  const bizTypeMap = { character: 'CHARACTER', scene: 'SCENE', prop: 'PROP' }
  const bizType = bizTypeMap[type] || 'CHARACTER'
  const sourceFilter = source === 'mine' ? 'MINE' : 'LIBRARY'

  const pageNum = Math.max(1, parseInt(page) || 1)
  const pageSize = Math.min(100, Math.max(1, parseInt(size) || 32))
  const offset = (pageNum - 1) * pageSize

  let where = 'WHERE biz_type = ? AND source = ?'
  const params = [bizType, sourceFilter]

  if (keyword && keyword.trim()) {
    where += ' AND name LIKE ?'
    params.push(`%${keyword.trim()}%`)
  }

  const countRow = db.prepare(`SELECT COUNT(*) as total FROM library_assets ${where}`).get(...params)
  const total = countRow.total

  const records = db.prepare(`SELECT * FROM library_assets ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset)

  // 引用计数：该图被 IP 角色 / 项目角色 / 集角色 引用的总次数
  const refRows = db.prepare(`
    SELECT image_url, COUNT(*) c FROM (
      SELECT image_url FROM ip_characters WHERE image_url != ''
      UNION ALL
      SELECT image_url FROM project_characters WHERE image_url != ''
      UNION ALL
      SELECT image_url FROM characters WHERE image_url != ''
    ) GROUP BY image_url`).all()
  const refMap = new Map(refRows.map((r) => [r.image_url, r.c]))

  const withRef = records.map((r) => ({ ...r, referencedBy: refMap.get(r.cover_url) || 0 }))

  res.json({ code: 0, data: { records: withRef, total, page: pageNum, size: pageSize } })
})

// GET /api/library-assets/items?clusterKey=xxx  素材详情图（同一 cluster 的多机位/多视角图）
// 数据源：library_asset_items 子表（与主表 cluster_key 关联）
router.get('/items', (req, res) => {
  const db = getDB()
  const { clusterKey = '' } = req.query
  if (!clusterKey) return res.json({ code: 0, data: [] })
  const items = db.prepare(
    `SELECT id, cluster_key, biz_type, name, media_url, sort_order
     FROM library_asset_items WHERE cluster_key = ?
     ORDER BY sort_order ASC, id ASC`
  ).all(clusterKey)
  res.json({ code: 0, data: items })
})

// PUT /api/library-assets/:id  重命名（仅我的素材）
router.put('/:id', (req, res) => {
  const db = getDB()
  const id = Number(req.params.id)
  const name = String(req.body?.name || '').trim()
  if (!name) return res.status(400).json({ code: 400, msg: '名称不能为空' })
  const asset = db.prepare('SELECT * FROM library_assets WHERE id = ?').get(id)
  if (!asset) return res.status(404).json({ code: 404, msg: '素材不存在' })
  if (asset.source !== 'MINE') return res.status(400).json({ code: 400, msg: '只能重命名我的素材' })
  db.prepare('UPDATE library_assets SET name = ? WHERE id = ?').run(name, id)
  res.json({ code: 0, data: db.prepare('SELECT * FROM library_assets WHERE id = ?').get(id) })
})

// POST /api/library-assets/upload  本地上传图片到"我的素材"
// body: { type: character|scene|prop, name: string, imageBase64: string }
router.post('/upload', (req, res) => {
  try {
    const { type = 'character', name = '未命名', imageBase64 } = req.body

    if (!imageBase64) {
      return res.status(400).json({ code: 400, msg: '缺少图片数据' })
    }

    // [安全 2026-09-18] 上传类型白名单：SVG 可内嵌 <script>，经 express.static 以
    // image/svg+xml 服务后构成存储型 XSS（用户直接访问文件 URL 即在 localhost 源执行），
    // 一律拒绝；只放行位图格式
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '')
    const extMatch = imageBase64.match(/^data:image\/(\w+);base64,/)
    const ext = extMatch ? extMatch[1].toLowerCase() : 'png'
    const UPLOAD_EXT_WHITELIST = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'])
    if (!UPLOAD_EXT_WHITELIST.has(ext)) {
      return res.status(400).json({ code: 400, msg: `不支持的图片格式：${ext}（仅支持 ${[...UPLOAD_EXT_WHITELIST].join(' / ')}）` })
    }

    // 生成文件名
    const timestamp = Date.now()
    const random = Math.random().toString(36).substring(2, 8)
    const filename = `mine_${timestamp}_${random}.${ext}`
    const filepath = path.join(UPLOAD_DIR, filename)

    // 保存文件
    fs.writeFileSync(filepath, Buffer.from(base64Data, 'base64'))

    // 构造访问 URL
    const imageUrl = `/uploads/${filename}`

    // 保存到数据库
    const db = getDB()
    const bizTypeMap = { character: 'CHARACTER', scene: 'SCENE', prop: 'PROP' }
    const bizType = bizTypeMap[type] || 'CHARACTER'
    const clusterKey = `MINE:${bizType}:${timestamp}`

    const info = db.prepare(`INSERT INTO library_assets 
      (cluster_key, source, biz_type, name, cover_url, media_type, item_count, scene_kind, char_kind, cover_item_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      clusterKey, 'MINE', bizType, name, imageUrl, 'IMAGE', 1, null, null, null
    )

    res.json({
      code: 0,
      data: {
        id: info.lastInsertRowid,
        cluster_key: clusterKey,
        source: 'MINE',
        biz_type: bizType,
        name,
        cover_url: imageUrl,
      },
    })
  } catch (e) {
    console.error('[UPLOAD ERROR]', e)
    res.status(500).json({ code: 500, msg: '上传失败: ' + e.message })
  }
})

// DELETE /api/library-assets/:id  删除素材（仅我的素材可删）
router.delete('/:id', (req, res) => {
  try {
    const db = getDB()
    const { id } = req.params

    // 先查记录
    const asset = db.prepare('SELECT * FROM library_assets WHERE id = ?').get(id)
    if (!asset) {
      return res.status(404).json({ code: 404, msg: '素材不存在' })
    }

    // 仅我的素材可删
    if (asset.source !== 'MINE') {
      return res.status(403).json({ code: 403, msg: '仅我的素材可删除' })
    }

    // 引用保护：素材图被选为 IP/项目/集角色的形象后共享同一文件，
    // 此时删素材会把角色形象一起删成死链（列表页的 referencedBy 就是这套计数）
    if (asset.cover_url) {
      const refRow = db.prepare(`
        SELECT COUNT(*) c FROM (
          SELECT image_url FROM ip_characters WHERE image_url = ?
          UNION ALL
          SELECT image_url FROM project_characters WHERE image_url = ?
          UNION ALL
          SELECT image_url FROM characters WHERE image_url = ?
        )`).get(asset.cover_url, asset.cover_url, asset.cover_url)
      if (refRow.c > 0) {
        return res.status(409).json({ code: 409, msg: `该素材正被 ${refRow.c} 个角色引用，请先解除引用后再删除` })
      }
    }

    // 删除服务器上的图片文件（removeLocalUploads 保留子目录且 resolve 防穿越，
    // 素材图在 /uploads/library/... 子目录下，basename 旧写法删不到还会误指根目录同名文件）
    if (asset.cover_url && asset.cover_url.startsWith('/uploads/')) {
      removeLocalUploads([asset.cover_url], UPLOAD_DIR)
    }

    // 删除数据库记录
    db.prepare('DELETE FROM library_assets WHERE id = ?').run(id)

    res.json({ code: 0, msg: '删除成功' })
  } catch (e) {
    console.error('[DELETE ERROR]', e)
    res.status(500).json({ code: 500, msg: '删除失败: ' + e.message })
  }
})

export default router
