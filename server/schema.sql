
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '新项目',
  theme TEXT DEFAULT '',
  art_style TEXT DEFAULT '吉卜力风格',
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
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (storyboard_scene_id) REFERENCES storyboard_scenes(id) ON DELETE CASCADE
);

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
  error_msg TEXT DEFAULT ''
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

CREATE TABLE IF NOT EXISTS qc_ignores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  episode_id INTEGER NOT NULL,
  code TEXT NOT NULL,                    
  shot_number TEXT NOT NULL DEFAULT '',  
  reason TEXT DEFAULT '',                
  UNIQUE(episode_id, code, shot_number)
);
CREATE INDEX IF NOT EXISTS idx_qc_ignores_episode ON qc_ignores(episode_id, code);

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

CREATE TABLE IF NOT EXISTS video_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  episode_id INTEGER NOT NULL,
  scene_number INTEGER NOT NULL,          
  segment_index INTEGER NOT NULL,       
  shot_ids TEXT NOT NULL,                
  shot_numbers TEXT NOT NULL DEFAULT '',
  start_time REAL,                       
  end_time REAL,                         
  video_url TEXT DEFAULT '',             
  anchor_frame_url TEXT DEFAULT '',      
  trim_start REAL NOT NULL DEFAULT 0,    
  shots_fp TEXT NOT NULL DEFAULT '',     
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT DEFAULT ''                  
);
CREATE INDEX IF NOT EXISTS idx_video_segments_ep ON video_segments(episode_id, scene_number, segment_index);

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

