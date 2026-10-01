import { Router } from 'express'
import { UPLOADS_URL_SLASH, uploadsUrl, uploadsDir } from '../paths.js'
import { getDB } from '../db.js'
import { removeLocalUploads } from '../ai/shared.js'
import fs from 'fs'
import path from 'path'

import { ASSET_BIZ_TYPE, uploadRefGroupSql, uploadRefCountSql } from '../ai/assetTypes.js'

const router = Router()

router.get('/', (req, res) => {
  const db = getDB()
  const { type = 'character', source = 'library', page = 1, size = 32, keyword = '' } = req.query

    const bizType = ASSET_BIZ_TYPE[type] || 'CHARACTER'
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

  const refRows = db
    .prepare(`SELECT u, COUNT(*) c FROM (${uploadRefGroupSql()}) GROUP BY u`)
    .all()
  const refMap = new Map(refRows.map((r) => [r.u, r.c]))

  const withRef = records.map((r) => ({ ...r, referencedBy: refMap.get(r.cover_url) || 0 }))

  res.json({ code: 0, data: { records: withRef, total, page: pageNum, size: pageSize } })
})

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

router.post('/upload', (req, res) => {
  try {
    const { type = 'character', name = '未命名', imageBase64 } = req.body

    if (!imageBase64) {
      return res.status(400).json({ code: 400, msg: '缺少图片数据' })
    }

    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '')
    const extMatch = imageBase64.match(/^data:image\/(\w+);base64,/)
    const ext = extMatch ? extMatch[1].toLowerCase() : 'png'
    const UPLOAD_EXT_WHITELIST = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'])
    if (!UPLOAD_EXT_WHITELIST.has(ext)) {
      return res.status(400).json({ code: 400, msg: `不支持的图片格式：${ext}（仅支持 ${[...UPLOAD_EXT_WHITELIST].join(' / ')}）` })
    }

    const timestamp = Date.now()
    const random = Math.random().toString(36).substring(2, 8)
    const filename = `mine_${timestamp}_${random}.${ext}`
    const filepath = path.join(uploadsDir, filename)

    fs.writeFileSync(filepath, Buffer.from(base64Data, 'base64'))

    const imageUrl = `${uploadsUrl(filename)}`

    const db = getDB()
        const bizType = ASSET_BIZ_TYPE[type] || 'CHARACTER'
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

router.delete('/:id', (req, res) => {
  try {
    const db = getDB()
    const { id } = req.params

    const asset = db.prepare('SELECT * FROM library_assets WHERE id = ?').get(id)
    if (!asset) {
      return res.status(404).json({ code: 404, msg: '素材不存在' })
    }

    if (asset.source !== 'MINE') {
      return res.status(403).json({ code: 403, msg: '仅我的素材可删除' })
    }

    if (asset.cover_url) {
      const { sql: refSql, paramCount } = uploadRefCountSql()
      const refRow = db.prepare(`SELECT COUNT(*) c FROM (${refSql})`).get(
        ...new Array(paramCount).fill(asset.cover_url)
      )
      if (refRow.c > 0) {
        return res.status(409).json({ code: 409, msg: `该素材正被 ${refRow.c} 处引用，请先解除引用后再删除` })
      }
    }

    if (asset.cover_url && asset.cover_url.startsWith(UPLOADS_URL_SLASH)) {
      removeLocalUploads([asset.cover_url], uploadsDir)
    }

    db.prepare('DELETE FROM library_assets WHERE id = ?').run(id)

    res.json({ code: 0, msg: '删除成功' })
  } catch (e) {
    console.error('[DELETE ERROR]', e)
    res.status(500).json({ code: 500, msg: '删除失败: ' + e.message })
  }
})

export default router
