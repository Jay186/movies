import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'node:crypto'
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
    ['scenes', 'space_type', "TEXT DEFAULT ''"],
    ['scenes', 'space_evidence', "TEXT DEFAULT ''"],
    // 场景提取时产出的同空间关联（skill asset-rules【同空间关联】节）：JSON {group, role, landmarks, transition}
    // sceneAnchors 优先采用它做空间组归并，LLM 只做缺失兜底，避免二次推断的脏数据（场景元素混入道具清单的实证）
    ['scenes', 'spatial_context', "TEXT DEFAULT ''"],
    ['shots', 'camera_elevation', "TEXT DEFAULT ''"],
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
    // 首尾状态的英文副本（2026-09-27）：原实现 world_state_in/out 只有中文自由文本，出片时
    // 靠 LLM 现场盲翻——翻译器看不到前后镜上下文，会把「停步」翻成 paused、把「面向」漏成
    // 中英混排，且 LLM 掉线时英文源整段消失（实测全库 36/36 镜英文落位 0/36）。
    // 改为分镜阶段（LLM 上下文最全：知道上一镜演了什么、本镜要演什么）直接产出英文，
    // 落库后在出片链路优先消费，缺字段才回落翻译。world_state_in_en 与中文同源派生自上一镜 out。
    ['shots', 'world_state_in_en', "TEXT DEFAULT ''"],
    ['shots', 'world_state_out_en', "TEXT DEFAULT ''"],
    // 分镜英文版（2026-10-01）：扩展 world_state_in_en/out_en 的既定模式（分镜期产出、
    // 出片期优先消费、缺字段回落翻译）到画面/动作/声景/配乐/语气五个字段。
    // 英文从"出片期临时翻译的契约缓存"变为分镜数据的普通列，随保存同步更新。
    ['shots', 'description_en', "TEXT DEFAULT ''"],
    ['shots', 'action_note_en', "TEXT DEFAULT ''"],
    ['shots', 'soundscape_en', "TEXT DEFAULT ''"],
    ['shots', 'music_en', "TEXT DEFAULT ''"],
    ['shots', 'tone_en', "TEXT DEFAULT ''"],
    // 英文版的中文源指纹：与 english_* 列配套判断"英文是否与当前中文一致"，
    // 一致则跳过翻译（零 LLM），不一致才重翻——编辑联动失效的精确化（取代契约的粗放全重置）。
    ['shots', 'english_source_fp', "TEXT DEFAULT ''"],
    ['shots', 'shot_role', "TEXT DEFAULT ''"],
    ['shots', 'related_shot_id', 'INTEGER'],
    ['shots', 'script_span', "TEXT DEFAULT ''"],
    ['shots', 'version', 'INTEGER DEFAULT 1'],
    ['shots', 'parent_id', 'INTEGER'],
    ['shots', 'edited_by', "TEXT DEFAULT ''"],
    // 出图依据快照：服务端注入的空间锚（基准/布局/要素/环境）落库，供④分镜页"出图依据"面板展示
    ['shots', 'anchor_refs_snapshot', "TEXT DEFAULT ''"],
    ['shots', 'field_sources_json', "TEXT DEFAULT '{}'"],
    ['shots', 'shot_uid', "TEXT DEFAULT ''"],
    ['shots', 'beat_id', "TEXT DEFAULT ''"],
    ['shots', 'coverage_id', "TEXT DEFAULT ''"],
    ['shots', 'relation_type', "TEXT DEFAULT ''"],
    ['shots', 'related_shots_json', "TEXT DEFAULT '[]'"],
    ['shots', 'composition', "TEXT DEFAULT ''"],
    ['shots', 'lens', "TEXT DEFAULT ''"],
    ['shots', 'depth_of_field', "TEXT DEFAULT ''"],
    ['shots', 'transition_in', "TEXT DEFAULT ''"],
    ['shots', 'transition_out', "TEXT DEFAULT ''"],
    ['shots', 'color_lighting', "TEXT DEFAULT ''"],
    // 镜级空间类型：Skill 契约（skillContract.js）要求每镜自判 S1-S4/O1/O2/X，
    // 此前只有 scenes.space_type，镜级判定产出后无处落库，被静默丢弃。
    ['shots', 'space_type', "TEXT DEFAULT ''"],
    ['shots', 'space_evidence', "TEXT DEFAULT ''"],
    ['shots', 'prompt_provider_id', "TEXT DEFAULT ''"],
    ['shots', 'compiled_prompt', "TEXT DEFAULT ''"],
    ['shots', 'prompt_compiled_at', 'DATETIME'],
    ['shots', 'video_semantics_json', "TEXT DEFAULT ''"],
    ['shots', 'video_semantics_status', "TEXT DEFAULT 'needs_compile'"],
    ['shots', 'video_semantics_version', 'INTEGER DEFAULT 0'],
    ['shots', 'video_semantics_source_fingerprint', "TEXT DEFAULT ''"],
    ['shots', 'video_semantics_error', "TEXT DEFAULT ''"],
    ['shots', 'video_semantics_compiled_at', 'DATETIME'],
    // 快照冗余镜号：整场重存会按时间轴重排镜号，历史版本需能按当时镜号回溯（无此列时回退按 shot_id 关联）
    ['shot_versions', 'shot_number', "TEXT DEFAULT ''"],
    // 生成调用落库的实际提示词（用于「图不满意时查看系统到底说了什么」）
    ['ai_calls', 'prompt', "TEXT DEFAULT ''"],
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

  // 2026-09-30：director_notes（用户规则·导演规格）全链路废弃——UI 无入口、仅孤儿 API 可写。
  // 存量库结构收口：列存在即删除，与新库（schema.sql 无此列）保持一致。
  try {
    const episodeCols = db.prepare('PRAGMA table_info(episodes)').all()
    if (episodeCols.some(c => c.name === 'director_notes')) {
      db.exec('ALTER TABLE episodes DROP COLUMN director_notes')
      console.log('[DB] 迁移：episodes 表删除 director_notes 字段')
    }
  } catch (e) {
    console.warn('[DB] 迁移失败 episodes.director_notes 删除:', e.message)
  }

  const missingShotUids = db.prepare("SELECT id FROM shots WHERE shot_uid IS NULL OR TRIM(shot_uid) = ''").all()
  const setShotUid = db.prepare('UPDATE shots SET shot_uid = ? WHERE id = ?')
  for (const row of missingShotUids) setShotUid.run(randomUUID(), row.id)

  const postMigrationIndexes = [
    `CREATE INDEX IF NOT EXISTS idx_system_alerts_scene ON system_alerts(scene_id)`,
    `DROP INDEX IF EXISTS idx_shots_shot_uid`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_shots_shot_uid ON shots(shot_uid) WHERE shot_uid IS NOT NULL AND TRIM(shot_uid) <> ''`,
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
