
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { query, execute, transaction } from '../db.js'
import { recordAlert } from './alerts.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SNAPSHOT_DIR = process.env.EXTRACT_SNAPSHOT_DIR
  ? path.resolve(process.env.EXTRACT_SNAPSHOT_DIR)
  : path.join(__dirname, '..', '_snapshots')
const SNAPSHOT_KEEP = 10

const TABLE_META = {
  characters: {
    key: 'name',
    protected: ['role', 'description', 'appearance', 'image_url', 'audio_url', 'color', 'name_en', 'description_en'],
  },
  props: {
    key: 'name',
    protected: ['description', 'owner', 'image_url', 'name_en', 'description_en'],
  },
  scenes: {
    key: 'title',
    protected: ['summary', 'prop_names', 'image_url', 'title_en', 'summary_en', 'lighting_en', 'location'],
  },
}


function pad2(n) {
  return String(n).padStart(2, '0')
}

function stamp(d = new Date()) {
  return (
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`
    + `_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  )
}

function norm(v) {
  return v == null ? '' : String(v)
}

function normField(field, v) {
  let s = norm(v).trim()
  if (field === 'prop_names') {
    if (s === '' || s === '[]' || s === 'null') return ''
    try {
      const arr = JSON.parse(s)
      if (Array.isArray(arr)) return JSON.stringify(arr.map(String).sort())
    } catch {  }
  }
  return s
}

export function snapshotDir() {
  return SNAPSHOT_DIR
}


export function snapshotBeforeExtract({ episodeId, trigger = 'extract', tables = [] } = {}) {
  try {
    const list = (Array.isArray(tables) ? tables : [tables]).filter((t) => TABLE_META[t])
    if (!list.length) return { ok: false, error: 'no valid tables' }

    if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true })

    const createdAt = new Date()
    const data = {}
    for (const t of list) {
      data[t] = query(`SELECT * FROM ${t} WHERE episode_id = ?`, [episodeId])
    }

    const payload = {
      meta: {
        episodeId: Number(episodeId),
        trigger: String(trigger || 'extract'),
        createdAt: createdAt.toISOString(),
        tables: list.map((t) => ({ table: t, count: data[t].length })),
      },
      data,
    }

    const base = `extract_snapshot_ep${episodeId}_${stamp(createdAt)}`
    let file = path.join(SNAPSHOT_DIR, `${base}.json`)
    let n = 1
    while (fs.existsSync(file)) file = path.join(SNAPSHOT_DIR, `${base}_${++n}.json`)

    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8')
    pruneSnapshots(SNAPSHOT_KEEP)
    return { ok: true, file, meta: payload.meta }
  } catch (e) {
    try {
      recordAlert({
        level: 'warn',
        source: 'extract-snapshot',
        episodeId,
        message: `覆盖前快照失败（不影响提取，继续执行）：${e.message}`,
      })
    } catch {  }
    return { ok: false, error: e.message }
  }
}

export function listSnapshots(episodeId = null) {
  try {
    if (!fs.existsSync(SNAPSHOT_DIR)) return []
    const files = fs.readdirSync(SNAPSHOT_DIR)
      .filter((f) => f.startsWith('extract_snapshot_ep') && f.endsWith('.json'))
    const items = []
    for (const f of files) {
      const abs = path.join(SNAPSHOT_DIR, f)
      let mtimeMs = 0
      try { mtimeMs = fs.statSync(abs).mtimeMs } catch { continue }
      let meta = null
      try { meta = JSON.parse(fs.readFileSync(abs, 'utf8'))?.meta || null } catch {  }
      items.push({ file: f, path: abs, mtimeMs, meta })
    }
    const filtered = episodeId == null
      ? items
      : items.filter((i) => Number(i.meta?.episodeId) === Number(episodeId))
    return filtered.sort((a, b) => b.mtimeMs - a.mtimeMs)
  } catch {
    return []
  }
}

export function pruneSnapshots(keep = SNAPSHOT_KEEP) {
  try {
    const all = listSnapshots(null)
    for (const item of all.slice(Math.max(0, keep))) {
      try { fs.unlinkSync(item.path) } catch {  }
    }
  } catch {  }
}

export function restoreSnapshot(file) {
  const abs = path.isAbsolute(file) ? file : path.join(SNAPSHOT_DIR, file)
  const payload = JSON.parse(fs.readFileSync(abs, 'utf8'))
  const episodeId = Number(payload?.meta?.episodeId)
  const data = payload?.data || {}
  if (!episodeId) throw new Error('快照缺少 episodeId')

  const result = {}
  transaction(() => {
    for (const table of Object.keys(data)) {
      if (!TABLE_META[table]) continue
      const rows = Array.isArray(data[table]) ? data[table] : []
      const cols = query(`PRAGMA table_info(${table})`).map((c) => c.name).filter((c) => c !== 'id')
      execute(`DELETE FROM ${table} WHERE episode_id = ?`, [episodeId])
      let inserted = 0
      for (const row of rows) {
        const useCols = cols.filter((c) => Object.prototype.hasOwnProperty.call(row, c))
        if (!useCols.length) continue
        const sql = `INSERT INTO ${table} (${useCols.join(', ')}) VALUES (${useCols.map(() => '?').join(', ')})`
        execute(sql, useCols.map((c) => row[c]))
        inserted++
      }
      result[table] = inserted
    }
  })
  return result
}

export function restoreLatestSnapshot(episodeId) {
  const [latest] = listSnapshots(episodeId)
  if (!latest) return null
  return restoreSnapshot(latest.path)
}


export function computeExtractDiff({ table, oldRows = [], incoming = [] } = {}) {
  const meta = TABLE_META[table]
  if (!meta) {
    return { hasRisk: false, table, overwrites: [], deletions: [], counts: { overwrites: 0, deletions: 0 } }
  }
  const key = meta.key

  const oldByKey = new Map()
  for (const r of oldRows) {
    const k = norm(r[key]).trim()
    if (k) oldByKey.set(k, r)
  }

  const newKeys = new Set()
  const overwrites = []
  for (const row of incoming) {
    const k = norm(row[key]).trim()
    if (!k) continue
    newKeys.add(k)
    const old = oldByKey.get(k)
    if (!old) continue 
    const fields = []
    for (const f of meta.protected) {
      const ov = normField(f, old[f])
      const nv = normField(f, row[f])
      if (ov && ov !== nv) fields.push({ field: f, from: ov, to: nv })
    }
    if (fields.length) overwrites.push({ name: k, fields })
  }

  const deletions = []
  for (const [k, old] of oldByKey) {
    if (!newKeys.has(k)) deletions.push({ name: k, row: old })
  }

  return {
    hasRisk: overwrites.length > 0 || deletions.length > 0,
    table,
    overwrites,
    deletions,
    counts: { overwrites: overwrites.length, deletions: deletions.length },
  }
}


function parsePropNames(v) {
  try {
    const arr = JSON.parse(norm(v) || '[]')
    return Array.isArray(arr) ? arr.map(String).filter(Boolean) : []
  } catch {
    return []
  }
}

function llmStr(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim() !== '') return v
  }
  return ''
}

export function applyKeepForScenes(incoming = [], oldRows = []) {
  const oldByTitle = new Map(oldRows.map((r) => [norm(r.title).trim(), r]))
  const patched = incoming.map((s) => {
    const name = norm(s.name || s.title).trim()
    const old = oldByTitle.get(name)
    if (!old) return s 
    return {
      ...s,
      description: old.summary || s.description || '',
      propNames: parsePropNames(old.prop_names),
      imageUrl: old.image_url || s.imageUrl || s.image_url || '',
      titleEn: old.title_en || llmStr(s.titleEn, s.title_en),
      summaryEn: old.summary_en || llmStr(s.summaryEn, s.summary_en),
      lightingEn: old.lighting_en || llmStr(s.lightingEn, s.lighting_en),
      location: old.location ?? s.location ?? s.location_en ?? '',
    }
  })
  const have = new Set(incoming.map((s) => norm(s.name || s.title).trim()))
  for (const old of oldRows) {
    if (have.has(norm(old.title).trim())) continue
    patched.push({
      name: old.title,
      description: old.summary || '',
      propNames: parsePropNames(old.prop_names),
      imageUrl: old.image_url || '',
      titleEn: old.title_en || '',
      summaryEn: old.summary_en || '',
      lightingEn: old.lighting_en || '',
      location: old.location ?? '',
      __restored: true,
    })
  }
  return patched
}

export function applyKeepForProps(incoming = [], oldRows = []) {
  const oldByName = new Map(oldRows.map((r) => [norm(r.name).trim(), r]))
  const patched = incoming.map((p) => {
    const name = norm(p.name).trim()
    const old = oldByName.get(name)
    if (!old) return p
    return {
      ...p,
      description: old.description || p.description || '',
      owner: old.owner || p.owner || '',
      imageUrl: old.image_url || p.imageUrl || p.image_url || '',
      nameEn: old.name_en || p.nameEn || p.name_en || '',
      descriptionEn: old.description_en ?? p.descriptionEn ?? p.description_en ?? '',
    }
  })
  const have = new Set(incoming.map((p) => norm(p.name).trim()))
  for (const old of oldRows) {
    if (have.has(norm(old.name).trim())) continue
    patched.push({
      name: old.name,
      description: old.description || '',
      owner: old.owner || '',
      imageUrl: old.image_url || '',
      nameEn: old.name_en || '',
      descriptionEn: old.description_en ?? '',
      __restored: true,
    })
  }
  return patched
}

export function applyKeepForCharacters(incoming = [], oldRows = []) {
  const oldByName = new Map(oldRows.map((r) => [norm(r.name).trim(), r]))
  const patched = incoming.map((c) => {
    const name = norm(c.name).trim()
    const old = oldByName.get(name)
    if (!old) return c
    return {
      ...c,
      role: old.role || c.role || '配角',
      description: old.description || c.description || '',
      appearance: old.appearance || c.appearance || '',
      imageUrl: old.image_url || c.imageUrl || c.image_url || '',
      audioUrl: old.audio_url || c.audioUrl || c.audio_url || '',
      color: old.color || c.color || '#6b9bd1',
      nameEn: old.name_en || c.nameEn || c.name_en || '',
      descriptionEn: old.description_en || c.descriptionEn || c.description_en || '',
    }
  })
  const have = new Set(incoming.map((c) => norm(c.name).trim()))
  for (const old of oldRows) {
    if (have.has(norm(old.name).trim())) continue
    patched.push({
      name: old.name,
      role: old.role || '配角',
      description: old.description || '',
      appearance: old.appearance || '',
      imageUrl: old.image_url || '',
      audioUrl: old.audio_url || '',
      color: old.color || '#6b9bd1',
      nameEn: old.name_en || '',
      descriptionEn: old.description_en || '',
      projectCharacterId: old.project_character_id || old.projectCharacterId || null,
      __restored: true,
    })
  }
  return patched
}

export const _tableMeta = TABLE_META
