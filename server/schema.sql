
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '新项目',
  theme TEXT DEFAULT '',
  art_style TEXT DEFAULT '',
  aspect_ratio TEXT DEFAULT '9:16 (Portrait Widescreen)',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  episode_number INTEGER DEFAULT 1,
  title TEXT DEFAULT '',
  script_content TEXT DEFAULT '',
  script_confirmed INTEGER DEFAULT 0,
  storyboard_confirmed INTEGER DEFAULT 0,
  ai_chat_history TEXT DEFAULT '[]',
  storyboard_source TEXT DEFAULT 'generated',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS scenes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id INTEGER NOT NULL,
  scene_number INTEGER DEFAULT 1,
  title TEXT DEFAULT '',
  summary TEXT DEFAULT '',
  location TEXT DEFAULT '',
  time_of_day TEXT DEFAULT '',
  prop_names TEXT DEFAULT '[]',
  space_type TEXT DEFAULT '',
  space_evidence TEXT DEFAULT '',
  spatial_context TEXT DEFAULT '',
  gen_context TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS characters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  role TEXT DEFAULT '配角',
  description TEXT DEFAULT '',
  name_en TEXT DEFAULT '',
  description_en TEXT DEFAULT '',
  appearance TEXT DEFAULT '',
  image_url TEXT DEFAULT '',
  color TEXT DEFAULT '#6b9bd1',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ip_characters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  role TEXT DEFAULT '主角',
  description TEXT DEFAULT '',
  appearance TEXT DEFAULT '',
  image_url TEXT DEFAULT '',
  audio_url TEXT DEFAULT '',
  color TEXT DEFAULT '#6b9bd1',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,          
  aliases TEXT DEFAULT '',            
  worldview TEXT DEFAULT '',          
  art_style TEXT DEFAULT '',          
  palette TEXT DEFAULT '',            
  voice_bind TEXT DEFAULT '',         
  relations TEXT DEFAULT '',          
  forbidden TEXT DEFAULT '',          
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS project_characters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  role TEXT DEFAULT '配角',
  description TEXT DEFAULT '',
  appearance TEXT DEFAULT '',
  image_url TEXT DEFAULT '',
  audio_url TEXT DEFAULT '',
  color TEXT DEFAULT '#6b9bd1',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS props (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  owner TEXT DEFAULT '', 
  image_url TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS storyboard_scenes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id INTEGER NOT NULL,
  scene_number INTEGER DEFAULT 1,
  title TEXT DEFAULT '',
  grid_image_url TEXT DEFAULT '', 
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS shots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  storyboard_scene_id INTEGER NOT NULL,
  shot_number TEXT DEFAULT '', 
  duration INTEGER DEFAULT 8,
  description TEXT DEFAULT '',
  characters TEXT DEFAULT '[]', 
  scene_assets TEXT DEFAULT '[]',
  prop_assets TEXT DEFAULT '[]',
  storyboard_url TEXT DEFAULT '',
  frame_url TEXT DEFAULT '',
  frame_url2 TEXT DEFAULT '', 
  continuity_url TEXT DEFAULT '', 
  keyframe_url TEXT DEFAULT '', 
  seam_check TEXT DEFAULT '', 
  blocking_url TEXT DEFAULT '',
  video_url TEXT DEFAULT '',
  video_generated INTEGER DEFAULT 0,
  shot_type TEXT DEFAULT '',
  start_time INTEGER DEFAULT 0,
  end_time INTEGER DEFAULT 0,
  action_note TEXT DEFAULT '',
  sound_effects TEXT DEFAULT '',
  dialogue TEXT DEFAULT '',
  camera_movement TEXT DEFAULT '',
  camera_angle TEXT DEFAULT '', 
  overall_soundscape TEXT DEFAULT '',
  non_diegetic_music TEXT DEFAULT '',
  integrated_multimodal_description TEXT DEFAULT '',
  blocking_plan TEXT DEFAULT '', 
  final_frame TEXT DEFAULT '',
  locked INTEGER DEFAULT 0,
  purpose TEXT DEFAULT '',
  goal TEXT DEFAULT '',
  emotion_tone TEXT DEFAULT '',
  info_points TEXT DEFAULT '[]',
  world_state_in TEXT DEFAULT '',
  world_state_out TEXT DEFAULT '',
  world_state_in_en TEXT DEFAULT '',
  world_state_out_en TEXT DEFAULT '',
  -- 分镜英文版（2026-10-01）：与资产 nameEn/descriptionEn 同模型——英文是分镜数据的一部分，
  -- 分镜生成/保存时产出，出片直接读取，不再是出片期才翻译的过程产物。
  description_en TEXT DEFAULT '',
  action_note_en TEXT DEFAULT '',
  soundscape_en TEXT DEFAULT '',
  music_en TEXT DEFAULT '',
  tone_en TEXT DEFAULT '',
  english_source_fp TEXT DEFAULT '',
  shot_role TEXT DEFAULT '',
  related_shot_id INTEGER,
  script_span TEXT DEFAULT '',
  version INTEGER DEFAULT 1,
  parent_id INTEGER,
  edited_by TEXT DEFAULT '',
  anchor_refs_snapshot TEXT DEFAULT '',
  field_sources_json TEXT DEFAULT '{}',
  shot_uid TEXT DEFAULT '',
  beat_id TEXT DEFAULT '',
  coverage_id TEXT DEFAULT '',
  relation_type TEXT DEFAULT '',
  related_shots_json TEXT DEFAULT '[]',
  composition TEXT DEFAULT '',
  lens TEXT DEFAULT '',
  depth_of_field TEXT DEFAULT '',
  transition_in TEXT DEFAULT '',
  transition_out TEXT DEFAULT '',
  color_lighting TEXT DEFAULT '',
  camera_elevation TEXT DEFAULT '',
  space_type TEXT DEFAULT '',
  space_evidence TEXT DEFAULT '',
  prompt_provider_id TEXT DEFAULT '',
  compiled_prompt TEXT DEFAULT '',
  prompt_compiled_at DATETIME,
  video_semantics_json TEXT DEFAULT '',
  video_semantics_status TEXT DEFAULT 'needs_compile',
  video_semantics_version INTEGER DEFAULT 0,
  video_semantics_source_fingerprint TEXT DEFAULT '',
  video_semantics_error TEXT DEFAULT '',
  video_semantics_compiled_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (storyboard_scene_id) REFERENCES storyboard_scenes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS shot_prompt_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id INTEGER NOT NULL,
  shot_id INTEGER NOT NULL,
  shot_version INTEGER NOT NULL DEFAULT 1,
  semantic_fingerprint TEXT NOT NULL DEFAULT '',
  reference_set_json TEXT NOT NULL DEFAULT '{}',
  provider_id TEXT NOT NULL DEFAULT '',
  workflow_id TEXT NOT NULL DEFAULT '',
  template_version TEXT NOT NULL DEFAULT '',
  generation_params_json TEXT NOT NULL DEFAULT '{}',
  retry_feedback_hash TEXT NOT NULL DEFAULT '',
  retry_feedback_text TEXT NOT NULL DEFAULT '',
  input_fingerprint TEXT NOT NULL,
  compiled_prompt TEXT NOT NULL,
  compile_status TEXT NOT NULL DEFAULT 'ready',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_prompt_snapshot_shot_fingerprint ON shot_prompt_snapshots(shot_id, input_fingerprint, id);

CREATE TABLE IF NOT EXISTS shot_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shot_id INTEGER NOT NULL,
  episode_id INTEGER NOT NULL,
  storyboard_scene_id INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  edited_by TEXT DEFAULT '',
  reason TEXT DEFAULT '',
  snapshot TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_shot_versions_shot ON shot_versions(shot_id, version);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  episode_id INTEGER,
  type TEXT NOT NULL, 
  status TEXT DEFAULT 'pending', 
  progress INTEGER DEFAULT 0,
  message TEXT DEFAULT '',
  result TEXT DEFAULT '', 
  error TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS style_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  label_en TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  source TEXT DEFAULT 'SYSTEM'
);

CREATE TABLE IF NOT EXISTS style_presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_key TEXT NOT NULL,
  preset_key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  label_en TEXT DEFAULT '',
  label_ja TEXT DEFAULT '',
  label_ko TEXT DEFAULT '',
  emoji TEXT DEFAULT '',
  prompt TEXT DEFAULT '',
  prompt_en TEXT DEFAULT '',
  cover_path TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  source TEXT DEFAULT 'SYSTEM',
  FOREIGN KEY (category_key) REFERENCES style_categories(category_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_styles_category ON style_presets(category_key);

CREATE INDEX IF NOT EXISTS idx_episodes_project ON episodes(project_id);
CREATE INDEX IF NOT EXISTS idx_scenes_episode ON scenes(episode_id);
CREATE INDEX IF NOT EXISTS idx_characters_episode ON characters(episode_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_characters_unique ON project_characters(project_id, name);
CREATE INDEX IF NOT EXISTS idx_shots_storyboard ON shots(storyboard_scene_id);
CREATE INDEX IF NOT EXISTS idx_tasks_episode ON tasks(episode_id);

CREATE TABLE IF NOT EXISTS ai_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  kind TEXT NOT NULL,             
  model TEXT DEFAULT '',          
  episode_id INTEGER,             
  task TEXT DEFAULT '',            
  in_tokens INTEGER,              
  out_tokens INTEGER,             
  frames INTEGER,                 
  latency_ms INTEGER,             
  success INTEGER DEFAULT 0,      
  error_family TEXT DEFAULT '',   
  error_msg TEXT DEFAULT '',
  prompt TEXT DEFAULT ''          
);
CREATE INDEX IF NOT EXISTS idx_ai_calls_created ON ai_calls(created_at);
CREATE INDEX IF NOT EXISTS idx_ai_calls_episode ON ai_calls(episode_id);
CREATE INDEX IF NOT EXISTS idx_ai_calls_kind ON ai_calls(kind);

CREATE TABLE IF NOT EXISTS system_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  level TEXT NOT NULL DEFAULT 'error',   
  source TEXT NOT NULL,                  
  episode_id INTEGER,
  shot_id INTEGER,
  shot_number TEXT DEFAULT '',           
  scene_id INTEGER,
  scene_number TEXT DEFAULT '',          
  message TEXT NOT NULL,                 
  detail TEXT DEFAULT '',                
  resolved_at TEXT DEFAULT ''            
);
CREATE INDEX IF NOT EXISTS idx_system_alerts_unresolved ON system_alerts(resolved_at, id);
CREATE INDEX IF NOT EXISTS idx_system_alerts_shot ON system_alerts(shot_id);

CREATE TABLE IF NOT EXISTS asset_image_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  asset_type TEXT NOT NULL,        
  asset_id INTEGER NOT NULL,       
  image_url TEXT NOT NULL,         
  description TEXT DEFAULT '',     
  source TEXT DEFAULT 'generate',  
  instruction TEXT DEFAULT ''      
);
CREATE INDEX IF NOT EXISTS idx_asset_hist_asset ON asset_image_history(asset_type, asset_id, id);

CREATE TABLE IF NOT EXISTS scene_analysis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id INTEGER NOT NULL,
  scene_id INTEGER NOT NULL,
  scene_number INTEGER DEFAULT 0,
  spatial_group TEXT DEFAULT '',     
  spatial_role TEXT DEFAULT '',      
  props_json TEXT DEFAULT '[]',      
  elements_json TEXT DEFAULT '[]',   
  shared_env_json TEXT DEFAULT '[]', 
  fingerprint TEXT DEFAULT '',       
  analyzed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(episode_id, scene_id),
  FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_scene_analysis_group ON scene_analysis(episode_id, spatial_group);

CREATE TABLE IF NOT EXISTS scene_group_locks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  episode_id INTEGER NOT NULL,
  scene_id INTEGER NOT NULL,
  spatial_group TEXT NOT NULL,       
  note TEXT DEFAULT '',              
  UNIQUE(episode_id, scene_id),
  FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_scene_group_locks_ep ON scene_group_locks(episode_id);

CREATE TABLE IF NOT EXISTS scene_anchors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  episode_id INTEGER NOT NULL,
  anchor_type TEXT NOT NULL,         
  anchor_key TEXT NOT NULL,          
  scene_id INTEGER DEFAULT 0,        
  scene_number INTEGER DEFAULT 0,
  image_url TEXT NOT NULL,           
  description TEXT DEFAULT '',
  source TEXT DEFAULT 'auto',        
  confirmed INTEGER DEFAULT 0,       
  source_fingerprint TEXT DEFAULT '',
  UNIQUE(episode_id, anchor_type, anchor_key),
  FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_scene_anchors_ep ON scene_anchors(episode_id, anchor_type);

CREATE TABLE IF NOT EXISTS layout_anchor_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  episode_id INTEGER NOT NULL,
  spatial_group TEXT NOT NULL,
  image_url TEXT NOT NULL,
  description TEXT DEFAULT '',
  source_fingerprint TEXT DEFAULT '',
  FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_layout_anchor_history_ep ON layout_anchor_history(episode_id, spatial_group, id);

CREATE TABLE IF NOT EXISTS episode_layout_route (
  episode_id INTEGER PRIMARY KEY,
  route TEXT NOT NULL DEFAULT 'on',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS spatial_group_review (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  episode_id INTEGER NOT NULL,
  spatial_group TEXT NOT NULL,          
  rep_scene_id INTEGER DEFAULT 0,       
  rep_scene_number INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',  
  baseline_image_url TEXT DEFAULT '',   
  UNIQUE(episode_id, spatial_group),
  FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sgr_episode ON spatial_group_review(episode_id, status);

CREATE TABLE IF NOT EXISTS asset_states (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  asset_type     TEXT NOT NULL CHECK(asset_type IN ('character','scene','prop')),
  asset_key      TEXT NOT NULL,          
  state_key      TEXT NOT NULL,          
  label_zh       TEXT DEFAULT '',        
  description    TEXT DEFAULT '',        
  description_en TEXT DEFAULT '',        
  image_url      TEXT DEFAULT '',        
  is_default     INTEGER DEFAULT 0,      
  source         TEXT DEFAULT 'manual',  
  UNIQUE(asset_type, asset_key, state_key)
);
CREATE INDEX IF NOT EXISTS idx_asset_states_key ON asset_states(asset_type, asset_key);

CREATE TABLE IF NOT EXISTS lighting_checks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint TEXT NOT NULL,             
  model       TEXT NOT NULL,             
  verdict     TEXT NOT NULL,             
  reason      TEXT DEFAULT '',           
  checked_at  TEXT DEFAULT '',
  UNIQUE(fingerprint, model)
);

-- ── AI 模型配置（运行时热生效，唯一事实源在库；.env 仅作首启 seed 初值 / 旧库迁移取值源）──────
-- ai_accounts：用途通道级凭据（provider_key = 'text' | 'image' | 'video'）
--   旧库为两厂商形态（'qimingxing' | 'runninghub'），启动时由 modelConfig.migrateLegacyModelConfig() 幂等重塑。
CREATE TABLE IF NOT EXISTS ai_accounts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_key TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL DEFAULT '',
  base_url     TEXT NOT NULL DEFAULT '',
  api_key      TEXT NOT NULL DEFAULT '',
  updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ai_model_entries：通道下的模型条目（kind = text | image | video；account_key 与 kind 一一对应）
--   image=模型ID；video=workflow_id；text=模型ID
--   workflow_key 仅 video 使用（h3Combat | h3V4vc | shotGridApp）；vision 仅 text 使用
CREATE TABLE IF NOT EXISTS ai_model_entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_key  TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK(kind IN ('text','image','video')),
  name         TEXT NOT NULL DEFAULT '',
  model_id     TEXT NOT NULL DEFAULT '',
  workflow_key TEXT DEFAULT '',
  vision       INTEGER DEFAULT 0,
  is_default   INTEGER DEFAULT 0,
  enabled      INTEGER DEFAULT 1,
  sort_order   INTEGER DEFAULT 0,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_entries_unique ON ai_model_entries(account_key, kind, model_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_entries_default ON ai_model_entries(account_key, kind) WHERE is_default = 1;
CREATE INDEX IF NOT EXISTS idx_ai_entries_list ON ai_model_entries(account_key, kind, sort_order);

CREATE TABLE IF NOT EXISTS ai_model_config_meta (key TEXT PRIMARY KEY, value TEXT);

-- ── 出片任务系统：提交与执行分离，状态落库，重启可恢复 ──────
CREATE TABLE IF NOT EXISTS video_jobs (
  id TEXT PRIMARY KEY,
  episode_id INTEGER NOT NULL,
  shot_id INTEGER NOT NULL,
  engine TEXT NOT NULL DEFAULT 'h3v4',
  status TEXT NOT NULL DEFAULT 'queued',  -- queued/running/succeeded/failed/interrupted
  phase TEXT DEFAULT '',
  provider_task_id TEXT DEFAULT '',
  error TEXT DEFAULT '',
  result_url TEXT DEFAULT '',
  params_json TEXT DEFAULT '{}',
  attempts INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME,
  finished_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_video_jobs_episode ON video_jobs(episode_id, status);
CREATE INDEX IF NOT EXISTS idx_video_jobs_shot ON video_jobs(shot_id, status);

-- ── 拼片产物登记：历史成片可回放下载 ──────
CREATE TABLE IF NOT EXISTS compose_outputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  shot_count INTEGER DEFAULT 0,
  total_seconds REAL DEFAULT 0,
  params_json TEXT DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_compose_outputs_episode ON compose_outputs(episode_id, id);
