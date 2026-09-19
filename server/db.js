import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { join } from 'path'
import { config } from './config.js'
import { serverDir } from './paths.js'

let db = null

export function initDB() {
  db = new Database(config.db.path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  const schema = readFileSync(join(serverDir, 'schema.sql'), 'utf-8')
  db.exec(schema)

  const migrations = [
    ['episodes', 'storyboard_confirmed', 'INTEGER DEFAULT 0'],
    ['episodes', 'ai_chat_history', "TEXT DEFAULT '[]'"],
    ['episodes', 'assets_script_fp', "TEXT DEFAULT ''"],
    ['episodes', 'storyboard_script_fp', "TEXT DEFAULT ''"],
    ['episodes', 'storyboard_source', "TEXT DEFAULT 'generated'"],
    ['episodes', 'director_notes', "TEXT DEFAULT ''"],
    ['scenes', 'image_url', 'TEXT DEFAULT ""'],
    ['scenes', 'prop_names', "TEXT DEFAULT '[]'"],
    ['scenes', 'title_en', "TEXT DEFAULT ''"],
    ['scenes', 'summary_en', "TEXT DEFAULT ''"],
    ['characters', 'name_en', "TEXT DEFAULT ''"],
    ['characters', 'description_en', "TEXT DEFAULT ''"],
    ['project_characters', 'name_en', "TEXT DEFAULT ''"],
    ['project_characters', 'description_en', "TEXT DEFAULT ''"],
    ['props', 'name_en', "TEXT DEFAULT ''"],
    ['style_presets', 'prompt_en', "TEXT DEFAULT ''"],
    ['scenes', 'lighting_en', "TEXT DEFAULT ''"],
    ['props', 'owner', "TEXT DEFAULT ''"],
    ['characters', 'audio_url', 'TEXT DEFAULT ""'],
    ['characters', 'project_character_id', 'INTEGER'],
    ['project_characters', 'ip_character_id', 'INTEGER'],
    ['ip_characters', 'ip_id', 'INTEGER'],
    ['ip_characters', 'aliases', "TEXT DEFAULT ''"],
    ['shots', 'shot_type', 'TEXT DEFAULT ""'],
    ['shots', 'start_time', 'INTEGER DEFAULT 0'],
    ['shots', 'end_time', 'INTEGER DEFAULT 0'],
    ['shots', 'action_note', 'TEXT DEFAULT ""'],
    ['shots', 'sound_effects', 'TEXT DEFAULT ""'],
    ['shots', 'dialogue', 'TEXT DEFAULT ""'],
    ['shots', 'camera_movement', 'TEXT DEFAULT ""'],
    ['shots', 'camera_angle', 'TEXT DEFAULT ""'],
    ['shots', 'overall_soundscape', 'TEXT DEFAULT ""'],
    ['shots', 'non_diegetic_music', 'TEXT DEFAULT ""'],
    ['shots', 'integrated_multimodal_description', 'TEXT DEFAULT ""'],
    ['shots', 'blocking_plan', "TEXT DEFAULT ''"],
    ['shots', 'final_frame', "TEXT DEFAULT ''"],
    ['shots', 'video_prompt_override', "TEXT DEFAULT ''"],
    ['shots', 'frame_url2', "TEXT DEFAULT ''"],
    ['shots', 'continuity_url', "TEXT DEFAULT ''"],
    ['shots', 'keyframe_url', "TEXT DEFAULT ''"],
    ['shots', 'seam_check', "TEXT DEFAULT ''"],
    ['shots', 'shot_review', "TEXT DEFAULT ''"],
    ['shots', 'retry_feedback', "TEXT DEFAULT ''"],
    ['shots', 'retry_count', 'INTEGER DEFAULT 0'],
    ['episodes', 'style_anchor_url', "TEXT DEFAULT ''"],
    ['storyboard_scenes', 'grid_image_url', "TEXT DEFAULT ''"],
    ['shots', 'is_combat', 'INTEGER'],
    ['projects', 'aspect_ratio', "TEXT DEFAULT '9:16 (Portrait Widescreen)'"],
    ['video_segments', 'trim_start', 'REAL NOT NULL DEFAULT 0'],
    ['video_segments', 'shots_fp', "TEXT NOT NULL DEFAULT ''"],
    ['props', 'description_en', "TEXT DEFAULT ''"],
    ['scenes', 'location', "TEXT DEFAULT ''"],
    ['shots', 'asset_states_json', "TEXT DEFAULT ''"],
    ['scene_analysis', 'elements_json', "TEXT DEFAULT '[]'"],
    ['scene_analysis', 'shared_env_json', "TEXT DEFAULT '[]'"],
    ['system_alerts', 'scene_id', 'INTEGER'],
    ['system_alerts', 'scene_number', "TEXT DEFAULT ''"],
    ['scene_anchors', 'source_fingerprint', "TEXT DEFAULT ''"],
  ]
  for (const [table, column, definition] of migrations) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all()
      if (!cols.find(c => c.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
        console.log(`[DB] 迁移：${table} 表添加 ${column} 字段`)
      }
    } catch (e) {
      console.warn(`[DB] 迁移失败 ${table}.${column}:`, e.message)
    }
  }

  const postMigrationIndexes = [
    `CREATE INDEX IF NOT EXISTS idx_system_alerts_scene ON system_alerts(scene_id)`,
  ]
  for (const sql of postMigrationIndexes) {
    try {
      db.exec(sql)
    } catch (e) {
      console.warn('[DB] 索引创建失败（不影响启动）:', e.message)
    }
  }

  const dropMigrations = [
    ['ai_calls', 'coins'],
  ]
  for (const [table, column] of dropMigrations) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all()
      if (cols.find(c => c.name === column)) {
        db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`)
        console.log(`[DB] 迁移：${table} 表删除废弃列 ${column}`)
      }
    } catch (e) {
      console.warn(`[DB] 删列迁移失败 ${table}.${column}:`, e.message)
    }
  }

  const deferredIndexes = [
    ['idx_characters_project_char', 'characters', 'project_character_id'],
    ['idx_project_characters_ip', 'project_characters', 'ip_character_id'],
    ['idx_ip_characters_ip', 'ip_characters', 'ip_id'],
  ]
  for (const [name, table, column] of deferredIndexes) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all()
      if (!cols.find((c) => c.name === column)) continue
      db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${table}(${column})`)
    } catch (e) {
      console.warn(`[DB] 索引创建失败 ${name}:`, e.message)
    }
  }

  console.log('[DB] 数据库初始化完成:', config.db.path)
  return db
}

export function getDB() {
  if (!db) initDB()
  return db
}

export function query(sql, params = []) {
  return getDB().prepare(sql).all(...params)
}

export function queryOne(sql, params = []) {
  return getDB().prepare(sql).get(...params)
}

export function execute(sql, params = []) {
  return getDB().prepare(sql).run(...params)
}

export function transaction(fn) {
  const tx = getDB().transaction(fn)
  return tx()
}
