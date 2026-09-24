import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { join } from 'path'
import { config } from './config.js'
import { serverDir } from './paths.js'

let db = null

const RETENTION_RULES = [
  { table: 'ai_calls', dateColumn: 'created_at', days: () => config.retention?.aiCallsDays },
]

function applyRetentionPolicy() {
  for (const rule of RETENTION_RULES) {
    const days = Math.max(0, Number(rule.days?.()) || 0)
    if (!days) continue
    try {
      const r = db.prepare(`DELETE FROM ${rule.table} WHERE ${rule.dateColumn} < datetime('now', ?)`).run(`-${days} days`)
      if (r.changes) console.log(`[DB] 保留策略：${rule.table} 清理 ${r.changes} 条 ${days} 天前的记录`)
    } catch (e) {
      console.warn(`[DB] 保留策略执行失败 ${rule.table}:`, e.message)
    }
  }
}

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
    ['props', 'description_en', "TEXT DEFAULT ''"],
    ['scenes', 'location', "TEXT DEFAULT ''"],
    ['shots', 'asset_states_json', "TEXT DEFAULT ''"],
    ['scene_analysis', 'elements_json', "TEXT DEFAULT '[]'"],
    ['scene_analysis', 'shared_env_json', "TEXT DEFAULT '[]'"],
    ['system_alerts', 'scene_id', 'INTEGER'],
    ['system_alerts', 'scene_number', "TEXT DEFAULT ''"],
    ['scene_anchors', 'source_fingerprint', "TEXT DEFAULT ''"],
    ['shots', 'locked', 'INTEGER DEFAULT 0'],
    ['shots', 'purpose', "TEXT DEFAULT ''"],
    ['shots', 'goal', "TEXT DEFAULT ''"],
    ['shots', 'emotion_tone', "TEXT DEFAULT ''"],
    ['shots', 'info_points', "TEXT DEFAULT '[]'"],
    ['shots', 'world_state_in', "TEXT DEFAULT ''"],
    ['shots', 'world_state_out', "TEXT DEFAULT ''"],
    ['shots', 'shot_role', "TEXT DEFAULT ''"],
    ['shots', 'related_shot_id', 'INTEGER'],
    ['shots', 'script_span', "TEXT DEFAULT ''"],
    ['shots', 'qc_status', "TEXT DEFAULT ''"],
    ['shots', 'qc_report', "TEXT DEFAULT ''"],
    ['shots', 'qc_waived', "TEXT DEFAULT '[]'"],
    ['shots', 'version', 'INTEGER DEFAULT 1'],
    ['shots', 'parent_id', 'INTEGER'],
    ['shots', 'edited_by', "TEXT DEFAULT ''"],
    // 出图依据快照：服务端注入的空间锚（基准/布局/要素/环境）落库，供④分镜页"出图依据"面板展示
    ['shots', 'anchor_refs_snapshot', "TEXT DEFAULT ''"],
    // 快照冗余镜号：整场重存会按时间轴重排镜号，历史版本需能按当时镜号回溯（无此列时回退按 shot_id 关联）
    ['shot_versions', 'shot_number', "TEXT DEFAULT ''"],
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
    ['idx_props_episode', 'props', 'episode_id'],
    ['idx_storyboard_scenes_episode', 'storyboard_scenes', 'episode_id'],
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

  // shot_versions.shot_number 自愈回填：历史版本首次升级时按 shot_id 关联当前镜号补值
  // 仅补空值，不动已有值（避免覆盖掉重排前的真实镜号）
  try {
    const svCols = db.prepare('PRAGMA table_info(shot_versions)').all()
    if (svCols.find((c) => c.name === 'shot_number')) {
      const r = db.prepare(
        `UPDATE shot_versions SET shot_number = COALESCE((
           SELECT s.shot_number FROM shots s WHERE s.id = shot_versions.shot_id
         ), '')
         WHERE shot_number IS NULL OR shot_number = ''`
      ).run()
      if (r.changes) console.log(`[DB] 回填 shot_versions.shot_number：${r.changes} 行`)
    }
  } catch (e) {
    console.warn('[DB] shot_versions.shot_number 回填失败（不影响启动）:', e.message)
  }

  applyRetentionPolicy()

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
