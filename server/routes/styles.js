import { Router } from 'express'
import path from 'path'
import fs from 'fs'
import { query, execute } from '../db.js'
import { translateStylePrompt } from '../ai/stylePromptEn.js'
import { recordAlert } from '../ai/alerts.js'
import { uploadsDir } from '../paths.js'

const router = Router()

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true })

const LABEL_MAX = 32
const PROMPT_MAX = 2000

function refreshStylePromptEn(key, { label, labelEn = '', prompt, expectPrompt }) {
  ;(async () => {
    try {
      const r = await translateStylePrompt({ label, labelEn, prompt })
      if (!r.ok) {
        recordAlert({
          source: 'style',
          level: 'warn',
          message: `画风「${label}」英文串生成失败：${r.reason}——该画风出片时将退化为英文短标签，画风锚减弱`,
        })
        return
      }
      const res = execute(
        `UPDATE style_presets SET prompt_en = ?
         WHERE preset_key = ? AND prompt IS NOT NULL AND prompt = ?
           AND (prompt_en IS NULL OR TRIM(prompt_en) = '')`,
        [r.en, key, expectPrompt]
      )
      if (res.changes > 0) {
        console.log(`[styles] 画风「${label}」英文串已生成（${r.en.split(/\s+/).length} 词）`)
      } else {
        console.log(`[styles] 画风「${label}」英文串结果作废（中文已再次变更或英文已存在）`)
      }
    } catch (e) {
      recordAlert({
        source: 'style',
        level: 'warn',
        message: `画风「${label}」英文串生成异常：${e.message}——该画风出片时将退化为英文短标签`,
        detail: e,
      })
    }
  })()
}

const SENSITIVE_WORDS = [
  '习近平', '毛泽东', '江泽民', '胡锦涛', '温家宝', '李克强',
  '反动', '法轮功', '藏独', '台独', '疆独', '港独',
  '色情', '裸体', '性交', '做爱', '约炮',
  '毒品', '冰毒', '海洛因', '大麻',
]

function hasSensitive(text) {
  if (!text) return false
  for (const w of SENSITIVE_WORDS) {
    if (text.includes(w)) return w
  }
  return null
}

function toPresetKey(label, existingKeys) {
  let base = String(label || 'style')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  if (!base) base = 'style'
  let key = base
  let i = 1
  while (existingKeys.has(key)) {
    key = `${base}-${i++}`
  }
  return key
}

router.get('/', (req, res) => {
  const categories = query('SELECT * FROM style_categories ORDER BY sort_order, id')
  const presets = query('SELECT * FROM style_presets ORDER BY sort_order, id')
  res.json({
    categories: categories
      .map((c) => ({
        key: c.category_key,
        label: c.label,
        labelEn: c.label_en,
        sortOrder: c.sort_order,
        presets: presets
          .filter((p) => p.category_key === c.category_key)
          .map((p) => ({
            key: p.preset_key,
            label: p.label,
            labelEn: p.label_en,
            emoji: p.emoji,
            prompt: p.prompt,
            coverUrl: p.cover_path,
            sortOrder: p.sort_order,
            source: p.source,
          })),
      }))
  })
})

router.post('/', (req, res) => {
  const { label, prompt, categoryKey, coverBase64, emoji } = req.body || {}

  const trimmedLabel = String(label || '').trim()
  if (!trimmedLabel) {
    return res.status(400).json({ error: '请填写风格名称' })
  }
  if (trimmedLabel.length > LABEL_MAX) {
    return res.status(400).json({ error: `风格名称不能超过 ${LABEL_MAX} 个字符` })
  }
  const trimmedPrompt = String(prompt || '').trim()
  if (!trimmedPrompt) {
    return res.status(400).json({ error: '请填写风格提示词' })
  }
  if (trimmedPrompt.length > PROMPT_MAX) {
    return res.status(400).json({ error: `提示词不能超过 ${PROMPT_MAX} 个字符` })
  }
  const hitInLabel = hasSensitive(trimmedLabel)
  if (hitInLabel) return res.status(400).json({ error: `风格名称包含敏感词「${hitInLabel}」，请修改后重试` })
  const hitInPrompt = hasSensitive(trimmedPrompt)
  if (hitInPrompt) return res.status(400).json({ error: `提示词包含敏感词「${hitInPrompt}」，请修改后重试` })
  const targetCategoryKey = (categoryKey || 'custom').trim() || 'custom'
  const cat = query('SELECT * FROM style_categories WHERE category_key = ?', [targetCategoryKey])[0]
  if (!cat) return res.status(400).json({ error: `画风分类不存在：${targetCategoryKey}` })
  let coverPath = ''
  if (coverBase64) {
    const m = String(coverBase64).match(/^data:image\/(\w+);base64,(.+)$/)
    if (!m) return res.status(400).json({ error: '封面图格式不正确（需为 data:image/xxx;base64,...）' })
    const ext = (m[1] || 'png').toLowerCase()
    if (!['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
      return res.status(400).json({ error: `封面图格式不支持：${ext}` })
    }
    const filename = `style_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`
    const filepath = path.join(uploadsDir, filename)
    try {
      fs.writeFileSync(filepath, Buffer.from(m[2], 'base64'))
      coverPath = `/uploads/${filename}`
    } catch (e) {
      return res.status(500).json({ error: '封面图保存失败：' + e.message })
    }
  }
  const existingKeys = new Set(query('SELECT preset_key FROM style_presets').map((r) => r.preset_key))
  const presetKey = toPresetKey(trimmedLabel, existingKeys)
  try {
    const result = execute(
      `INSERT INTO style_presets
       (category_key, preset_key, label, label_en, label_ja, label_ko, emoji, prompt, cover_path, sort_order, source)
       VALUES (?, ?, ?, '', '', '', ?, ?, ?, ?, 'USER')`,
      [targetCategoryKey, presetKey, trimmedLabel, emoji || '', trimmedPrompt, coverPath, 0]
    )
    const created = {
      key: presetKey,
      label: trimmedLabel,
      labelEn: '',
      emoji: emoji || '',
      prompt: trimmedPrompt,
      coverUrl: coverPath,
      sortOrder: 0,
      source: 'USER',
      category: targetCategoryKey,
    }
    res.json({ ok: true, id: result.lastInsertRowid, style: created })
    refreshStylePromptEn(presetKey, { label: trimmedLabel, labelEn: '', prompt: trimmedPrompt, expectPrompt: trimmedPrompt })
  } catch (e) {
    return res.status(500).json({ error: '保存失败：' + e.message })
  }
})

router.patch('/:key', (req, res) => {
  const key = String(req.params.key || '').trim()
  if (!key) return res.status(400).json({ error: '缺少画风标识' })

  const existing = query('SELECT * FROM style_presets WHERE preset_key = ?', [key])[0]
  if (!existing) return res.status(404).json({ error: '画风不存在' })
  if (existing.source !== 'USER') {
    return res.status(403).json({ error: '系统内置画风不可编辑' })
  }

  const body = req.body || {}
  const trimmedLabel = body.label !== undefined ? String(body.label || '').trim() : existing.label
  const trimmedPrompt = body.prompt !== undefined ? String(body.prompt || '').trim() : existing.prompt
  const emoji = body.emoji !== undefined ? String(body.emoji || '') : existing.emoji

  if (body.label !== undefined) {
    if (!trimmedLabel) return res.status(400).json({ error: '请填写风格名称' })
    if (trimmedLabel.length > LABEL_MAX) return res.status(400).json({ error: `风格名称不能超过 ${LABEL_MAX} 个字符` })
    const hit = hasSensitive(trimmedLabel)
    if (hit) return res.status(400).json({ error: `风格名称包含敏感词「${hit}」，请修改后重试` })
  }
  if (body.prompt !== undefined) {
    if (!trimmedPrompt) return res.status(400).json({ error: '请填写风格提示词' })
    if (trimmedPrompt.length > PROMPT_MAX) return res.status(400).json({ error: `提示词不能超过 ${PROMPT_MAX} 个字符` })
    const hit = hasSensitive(trimmedPrompt)
    if (hit) return res.status(400).json({ error: `提示词包含敏感词「${hit}」，请修改后重试` })
  }

  let coverPath = existing.cover_path
  const coverBase64 = body.coverBase64
  if (coverBase64 !== undefined) {
    if (coverBase64 === '') {
      if (existing.cover_path) removeCoverFile(existing.cover_path)
      coverPath = ''
    } else {
      const m = String(coverBase64).match(/^data:image\/(\w+);base64,(.+)$/)
      if (!m) return res.status(400).json({ error: '封面图格式不正确（需为 data:image/xxx;base64,...）' })
      const ext = (m[1] || 'png').toLowerCase()
      if (!['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
        return res.status(400).json({ error: `封面图格式不支持：${ext}` })
      }
      const filename = `style_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`
      const filepath = path.join(uploadsDir, filename)
      try {
        fs.writeFileSync(filepath, Buffer.from(m[2], 'base64'))
        if (existing.cover_path) removeCoverFile(existing.cover_path)
        coverPath = `/uploads/${filename}`
      } catch (e) {
        return res.status(500).json({ error: '封面图保存失败：' + e.message })
      }
    }
  }

  const promptChanged = body.prompt !== undefined && trimmedPrompt !== String(existing.prompt || '')

  try {
    if (promptChanged) {
      execute(
        `UPDATE style_presets SET label = ?, prompt = ?, emoji = ?, cover_path = ?, prompt_en = '' WHERE preset_key = ?`,
        [trimmedLabel, trimmedPrompt, emoji, coverPath, key]
      )
    } else {
      execute(
        `UPDATE style_presets SET label = ?, prompt = ?, emoji = ?, cover_path = ? WHERE preset_key = ?`,
        [trimmedLabel, trimmedPrompt, emoji, coverPath, key]
      )
    }
    const updated = {
      key,
      label: trimmedLabel,
      labelEn: existing.label_en,
      emoji,
      prompt: trimmedPrompt,
      coverUrl: coverPath,
      sortOrder: existing.sort_order,
      source: 'USER',
      category: existing.category_key,
    }
    res.json({ ok: true, style: updated })
    if (promptChanged) {
      refreshStylePromptEn(key, {
        label: trimmedLabel,
        labelEn: existing.label_en || '',
        prompt: trimmedPrompt,
        expectPrompt: trimmedPrompt,
      })
    }
  } catch (e) {
    return res.status(500).json({ error: '更新失败：' + e.message })
  }
})

router.delete('/:key', (req, res) => {
  const key = String(req.params.key || '').trim()
  if (!key) return res.status(400).json({ error: '缺少画风标识' })

  const existing = query('SELECT * FROM style_presets WHERE preset_key = ?', [key])[0]
  if (!existing) return res.status(404).json({ error: '画风不存在' })
  if (existing.source !== 'USER') {
    return res.status(403).json({ error: '系统内置画风不可删除' })
  }

  if (existing.cover_path) {
    try {
      removeCoverFile(existing.cover_path)
    } catch (e) {
      console.warn('[styles] 删除封面文件失败:', e.message)
    }
  }

  try {
    execute('DELETE FROM style_presets WHERE preset_key = ?', [key])
    res.json({ ok: true, key })
  } catch (e) {
    return res.status(500).json({ error: '删除失败：' + e.message })
  }
})

function removeCoverFile(coverPath) {
  if (!coverPath || !/^\/uploads\/style_/.test(coverPath)) return
  const filename = path.basename(coverPath)
  const filepath = path.join(uploadsDir, filename)
  if (fs.existsSync(filepath)) fs.unlinkSync(filepath)
}

export default router