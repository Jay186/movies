-- 数据库表结构

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '新项目',
  theme TEXT DEFAULT '',
  art_style TEXT DEFAULT '吉卜力风格',
  -- 项目级默认宽高比：所有集共用，下游生图（rhShotGrid / frame prompt 构图措辞）与出片
  -- （V4/标准/武戏）链路均沿用。当前项目默认竖屏 9:16（短剧发布平台形态，2026-09-11 布哥定调）。
  -- 枚举与 server/ai/v4Video.js 的 VIDEO_ASPECT_RATIOS 对齐；落库值带后缀的写法
  -- 与后端白名单字面一致，避免请求体 → 工作流节点校验时被静默回落。
  -- 历史项目升级时会由 db.js 的 migrations 自动补 '9:16 (Portrait Widescreen)'。
  -- TODO：若未来要做「项目设置面板」（风格库/默认比例/总集数/每集秒数一排），
  -- 该字段是面板首个落点；本轮先在 EpisodesView 顶部以下拉形态上线。
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
  -- 分镜来源：'generated' 表示由剧本经 LLM 生成；'imported' 表示用户通过导入分镜脚本上传
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
  -- 英文字段（H3 全英文 prompt 链路）：角色英文名 / 英文外貌，新库正式登记
  name_en TEXT DEFAULT '',
  description_en TEXT DEFAULT '',
  appearance TEXT DEFAULT '',
  image_url TEXT DEFAULT '',
  color TEXT DEFAULT '#6b9bd1',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
);

-- 全局 IP 角色库（跨项目共享的"源头设定"）
-- 布布、一二这类长期 IP，形象只在这里存一份，与具体项目无关。
-- 项目角色库（project_characters）通过 ip_character_id 引用它；改这里再"应用到项目"，
-- 即可把所有项目里同名角色的形象、描述、音色一次性对齐。
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

-- IP 容器层（世界观 / 画风 / 音色体系 / 人物关系的归属）
-- ip_characters 存的是「角色」，ips 存的是「IP」：一二是角色，布布是角色，
-- 「一二布布」才是 IP。此前两者没有归属关系，世界观、画风、配色、音色体系
-- 没地方存，只能重复写进每个角色的 description，改一次要改多处。
-- 有这层之后：编剧入口先路由到 IP，再把 IP 卡整包注入 prompt，
-- 角色与场景天然继承同一套设定，不再依赖角色名精确匹配。
CREATE TABLE IF NOT EXISTS ips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,          -- IP 名：一二布布
  aliases TEXT DEFAULT '',            -- IP 别名，逗号分隔：一二和布布,一二布布,yierbubu
  worldview TEXT DEFAULT '',          -- 世界观 / 故事调性
  art_style TEXT DEFAULT '',          -- 画风
  palette TEXT DEFAULT '',            -- 主配色
  voice_bind TEXT DEFAULT '',         -- 音色绑定说明（Speaker 编号 → 角色）
  relations TEXT DEFAULT '',          -- 人物关系
  forbidden TEXT DEFAULT '',          -- 禁忌：不许出现的内容
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 项目级 IP 角色库（跨集共享的"主设定"）
-- 布布、一二这类贯穿全剧的主角，设定只在这里存一份；各集 characters 表通过
-- project_character_id 链接过来。改主设定 → 全项目所有集同步生效，杜绝跨集形象漂移。
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
  owner TEXT DEFAULT '', -- 专属角色名（道具专属铁律）
  image_url TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS storyboard_scenes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id INTEGER NOT NULL,
  scene_number INTEGER DEFAULT 1,
  title TEXT DEFAULT '',
  grid_image_url TEXT DEFAULT '', -- 2x2 四宫格分镜图（导演台段落出片专用输入）
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS shots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  storyboard_scene_id INTEGER NOT NULL,
  shot_number TEXT DEFAULT '', -- 如 "1-1"
  duration INTEGER DEFAULT 8,
  description TEXT DEFAULT '',
  characters TEXT DEFAULT '[]', -- JSON 数组
  scene_assets TEXT DEFAULT '[]',
  prop_assets TEXT DEFAULT '[]',
  storyboard_url TEXT DEFAULT '',
  frame_url TEXT DEFAULT '',
  frame_url2 TEXT DEFAULT '', -- 分镜图第二张（每次生成 2 张候选，frame_url 为主图）
  continuity_url TEXT DEFAULT '', -- 末帧回灌锚：上一镜成片末帧，出片时作为本镜 continuity 首帧锚
  keyframe_url TEXT DEFAULT '', -- 尾帧锚（由本镜 final_frame 描述直接出图）：本镜「结束」长什么样，供下镜对齐接缝
  seam_check TEXT DEFAULT '', -- 衔接质量检测 JSON：色温差/亮度差/构图差 + alert 报警标记（#3）
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
  camera_angle TEXT DEFAULT '', -- 机位朝向：正面/侧面/背面/过肩/俯拍/仰拍（机位一致性校验的地基）
  overall_soundscape TEXT DEFAULT '',
  non_diegetic_music TEXT DEFAULT '',
  integrated_multimodal_description TEXT DEFAULT '',
  blocking_plan TEXT DEFAULT '', -- 程序化站位图调度 JSON
  final_frame TEXT DEFAULT '', -- 本镜最终画面描述（供下镜 Airlock 继承）
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (storyboard_scene_id) REFERENCES storyboard_scenes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  episode_id INTEGER,
  type TEXT NOT NULL, -- script / assets / storyboard / image / video / full
  status TEXT DEFAULT 'pending', -- pending / running / completed / failed
  progress INTEGER DEFAULT 0,
  message TEXT DEFAULT '',
  result TEXT DEFAULT '', -- JSON
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
  -- 画风英文描述（H3 全英文 prompt 链路）：新库正式登记
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
-- 注意：project_character_id / ip_character_id 上的索引依赖迁移列，
-- 必须等 db.js 补完列之后再建，否则老库首次启动会因"列不存在"直接崩。
-- 见 db.js 末尾的 deferredIndexes。
CREATE INDEX IF NOT EXISTS idx_shots_storyboard ON shots(storyboard_scene_id);
CREATE INDEX IF NOT EXISTS idx_tasks_episode ON tasks(episode_id);

-- AI 调用观测：所有 LLM / RunningHub 调用落一条记录，
-- 用于成功率、延迟分位、失败原因 Top。
-- 故障排查的核心数据源，查询不阻塞主流程（WAL）。
-- 注：原 coins 列（RH 币消耗）已于 2026-09-14 删除——该列建表时预留但从未有调用方传值
--     （1365 条记录 0 条非空），属"假数据"遗留，连同前端假余额展示一并清理。
CREATE TABLE IF NOT EXISTS ai_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  kind TEXT NOT NULL,             -- 'llm' | 'runninghub'
  model TEXT DEFAULT '',          -- LLM 模型名 或 RunningHub 工作流 key
  episode_id INTEGER,             -- 关联集（可为空，如 IP 路由等非集级调用）
  task TEXT DEFAULT '',            -- 业务用途：'script'/'assets'/'storyboard'/'video'/'image'/'episode'...
  in_tokens INTEGER,              -- LLM 输入 token
  out_tokens INTEGER,             -- LLM 输出 token
  frames INTEGER,                 -- RunningHub 帧数
  latency_ms INTEGER,             -- 耗时
  success INTEGER DEFAULT 0,      -- 1 成功 0 失败
  error_family TEXT DEFAULT '',   -- 'auth'|'rate_limit'|'timeout'|'server'|'content'|'cancelled'|'unknown'
  error_msg TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_ai_calls_created ON ai_calls(created_at);
CREATE INDEX IF NOT EXISTS idx_ai_calls_episode ON ai_calls(episode_id);
CREATE INDEX IF NOT EXISTS idx_ai_calls_kind ON ai_calls(kind);

-- 系统告警（2026-09-13）：出片后置钩子链（末帧接力/风格锚/接缝检测/色向闸/观片闸）失败时的
-- 可见化落库。背景：这些钩子全是 fire-and-forget，失败只落一行 console.warn——批量出片时
-- 无人可见，导致「成片出来了但验收链全灭」长期静默（v4 回写 RangeError 事故即此）。
-- 写库后前端镜头卡片亮红角标、出片响应带 warnings，把「靠人眼在成片里发现」变成「系统当场喊」。
-- level: 'error'（钩子失败，该镜验收缺失）/ 'warn'（非致命降级，如 MC 静默降级）/
--        'info'（成功/信息类，如 salvage 打捞成功；非故障，UI 不上红角标）；
-- resolved_at 非空即已处置（重生该镜自动清，或人工点「已阅」）。
CREATE TABLE IF NOT EXISTS system_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  level TEXT NOT NULL DEFAULT 'error',   -- 'error' | 'warn' | 'info'（三档映射，见 ai/alerts.js）
  source TEXT NOT NULL,                  -- 'relay'|'styleAnchor'|'seam'|'openerTone'|'review'|'writeback'|'mc'...
  episode_id INTEGER,
  shot_id INTEGER,
  shot_number TEXT DEFAULT '',           -- 冗余镜头号，镜头删除后仍可读
  -- 场景维度（2026-09-17，A4/A5 场景图质检）：本表原本只有"镜头"身份，场景告警无处安放。
  -- 与 shot_* 并列而非复用：镜头号与场景号是两个域，混用会让"这条告警属于谁"变得靠猜。
  scene_id INTEGER,
  scene_number TEXT DEFAULT '',          -- 冗余场景号，场景删除后仍可读（同 shot_number 口径）
  message TEXT NOT NULL,                 -- 一句话人话描述
  detail TEXT DEFAULT '',                -- 原始错误堆栈/消息
  resolved_at TEXT DEFAULT ''            -- 处置时间戳；空串=未处置
);
CREATE INDEX IF NOT EXISTS idx_system_alerts_unresolved ON system_alerts(resolved_at, id);
CREATE INDEX IF NOT EXISTS idx_system_alerts_shot ON system_alerts(shot_id);
-- ⚠️ scene_id 索引不写在这里：schema.sql 是**每次启动整段 exec**，而老库还没有 scene_id 列
-- （该列由 db.js 的 migrations 在 schema 之后补）——在这里建索引会让老库启动直接崩
-- （实测报 `no such column: scene_id`）。索引改由 db.js 迁移段之后单独建，见 db.js。

-- 质检忽略记录（2026-09-16）：分镜质检面板里「人工确认过、不必处理」的问题。
-- 背景：storyboardValidator 检出的 warning 有很多是**剧情故意的**（角色按剧情出画、
-- 合法越轴、共用场景资产），一刀切要求全修会改坏内容。人工看过并确认无碍后记一行，
-- 面板刷新即不再重复提示（否则每天开面板都要人肉略过同一批误报，很快就不看了）。
-- 键 = (episode_id, code, shot_number)。问题被真正修好后该记录自然成为孤儿，
-- 由 /qc-report 的读取逻辑顺带清理，不需要额外的失效判定。
CREATE TABLE IF NOT EXISTS qc_ignores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  episode_id INTEGER NOT NULL,
  code TEXT NOT NULL,                    -- 质检码（见 ai/qcCodes.js 注册表）
  shot_number TEXT NOT NULL DEFAULT '',  -- 镜头号；'*' = 整集级问题
  reason TEXT DEFAULT '',                -- 人工备注
  UNIQUE(episode_id, code, shot_number)
);
CREATE INDEX IF NOT EXISTS idx_qc_ignores_episode ON qc_ignores(episode_id, code);

-- 资产形象版本历史：AI 生成 / 图生图改造 / 本地上传 / 恢复 全部留痕。
-- 每条记录 = 一个完整形象快照（图 + 当时描述），恢复时图文一起回滚，杜绝"图回滚了描述没回滚"的图文打架。
-- 当前版本不单独标记：asset 主表 image_url（剥 cache-buster）与历史行比对即当前。
CREATE TABLE IF NOT EXISTS asset_image_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  asset_type TEXT NOT NULL,        -- 'character' | 'scene' | 'prop'
  asset_id INTEGER NOT NULL,       -- character 走项目库主设定 id（project_characters.id），scene/prop 走集行 id
  image_url TEXT NOT NULL,         -- 裸路径（/uploads/xxx.png，无 cache-buster）
  description TEXT DEFAULT '',     -- 该版本对应的描述快照
  source TEXT DEFAULT 'generate',  -- 'generate' | 'edit' | 'upload' | 'initial'
  instruction TEXT DEFAULT ''      -- 改造指令 / 来源说明
);
CREATE INDEX IF NOT EXISTS idx_asset_hist_asset ON asset_image_history(asset_type, asset_id, id);

-- 段级出片（E 路线 v2，AGENTS.md §九）：一段一任务，段是出片包装层，镜表不动。
-- 段不跨场；段总时长 3–15s（下限同 H3 可生成下限，上限为 H3 单次生成上限）；shot_ids 按播放序存 JSON 数组。
-- status: 'pending'（待出）| 'running' | 'done'（有 video_url 成片）| 'failed'
--         | 'unusable'（段长非法，降级逐镜）| 'stale'（分镜已变，段边界/时间轴与镜表不符，需重出）
-- anchor_frame_url：段首接力锚（上一段末帧 /uploads/continuity/...），场首段为空。
-- trim_start：段首裁切偏移秒（§9.3 段首坏 N 秒零成本裁切修法）。切片回填时
--   镜边界须整体后移 trim_start，否则切片内容错位。默认 0。
-- shots_fp：落库时该集镜表指纹（segmentBuilder.shotsFingerprint）。分镜一变整批判 stale——
--   段记录只存 shot_ids 快照，镜被删/改序/改时长后若无指纹则无从察觉，切片会按错误时间轴
--   静默产出内容错位的视频。空串 = 历史数据（无指纹可依，按镜数+同场校验兜底）。
CREATE TABLE IF NOT EXISTS video_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  episode_id INTEGER NOT NULL,
  scene_number INTEGER NOT NULL,          -- 所属场次号（= storyboard_scenes.scene_number）
  segment_index INTEGER NOT NULL,       -- 场内段序号，1 起
  shot_ids TEXT NOT NULL,                -- JSON 数组，播放序 [id1,id2,...]
  shot_numbers TEXT NOT NULL DEFAULT '',-- 冗余 'shot_number>shot_number'，便于直读
  start_time REAL,                       -- 全片时间轴：首镜 start_time
  end_time REAL,                         -- 全片时间轴：末镜 end_time
  video_url TEXT DEFAULT '',             -- 成片 /uploads/...（status=done 时非空）
  anchor_frame_url TEXT DEFAULT '',      -- 段首接力锚（上一段末帧），首段空
  trim_start REAL NOT NULL DEFAULT 0,    -- 段首裁切偏移秒（切片回填用，§9.3）
  shots_fp TEXT NOT NULL DEFAULT '',     -- 落库时镜表指纹，分镜一变整批判 stale
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT DEFAULT ''                  -- failed 时的原因
);
CREATE INDEX IF NOT EXISTS idx_video_segments_ep ON video_segments(episode_id, scene_number, segment_index);
-- ===== 视觉锚点集（2026-09-16 v2，LLM 驱动）=====
--
-- 解决什么问题：场景图独立生成导致"同一座桥画成两个样"——
-- 场景2 不知道场景1 长什么样，文字提示词管不住 AI 的自由发挥。
--
-- 设计：锚点集（Anchor Set）模式，松耦合——
--   不是"场景2 必须参考场景1"（链式，强耦合），
--   而是"所有场景共享一套视觉锚点，生成时按需组合"（星型，可并行、可独立重画）。
--
-- 通用性硬约束：空间分组与共享道具的判定**全部交给 LLM**（见 ai/sceneAnchors.js），
-- 代码里没有任何题材词表/正则规则——换剧本、换题材、换语言都不用改代码。
--
-- 两张表的分工：
--   scene_analysis — LLM 分析缓存（文字层）：每个场景属于哪个空间组、组内视角、
--                    出现了哪些共享道具。按全集场景指纹缓存，场景集变化自动重析。
--   scene_anchors  — 锚点图登记（图片层）：哪个空间组/哪个道具的"定稿图"是哪张。
--                    场景图生成成功后自动登记，供后续场景取参考。

-- LLM 场景分析缓存（每场景一行）
CREATE TABLE IF NOT EXISTS scene_analysis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id INTEGER NOT NULL,
  scene_id INTEGER NOT NULL,
  scene_number INTEGER DEFAULT 0,
  spatial_group TEXT DEFAULT '',     -- 空间组名（LLM 命名）：同组 = 同一物理空间的不同视角/高度/内外
  spatial_role TEXT DEFAULT '',      -- 组内位置/视角（中文短语，如"崖顶俯视谷底"）
  props_json TEXT DEFAULT '[]',      -- 本场出现的共享道具名列表（全集共享道具的子集）
  elements_json TEXT DEFAULT '[]',   -- A1 本场摘要里**明文已写、必须在画面上看得见**的要素短语（如"清晨浓雾""冰面浮冰"）
  shared_env_json TEXT DEFAULT '[]', -- A2 本组（spatial_group）内共享的环境特征，无新意的工作量全在此：植被/地质/色调/地标
  fingerprint TEXT DEFAULT '',       -- 全集场景指纹（md5）：场景集任何变化都会使它失效，触发重析
  analyzed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(episode_id, scene_id),
  FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_scene_analysis_group ON scene_analysis(episode_id, spatial_group);

-- 空间分组人审锁定（2026-09-17）
--
-- 存在理由：spatial_group 是 LLM 逐次自由裁量的产物，**无任何稳定性**。
--   实测同一份剧本连析两次，4 组（cliff_river / forest_edge / forest_valley / forest_high_rock）
--   被合并成 2 组（cliff_river / forest_lake）——而合并会把已确认的 spatial 组锚变成**孤儿**
--   （anchor_key 指向一个不再存在的组），人审基线静默失效。
--
-- 做法：把"某个场景归在哪个组"**固化成人审数据**。一旦锁定，
--   重析时该场景直接复用锁定的组名，LLM 只被要求处理**尚未锁定的场景**。
--   这样重析不再能自由重组已验证过的结构，新场次仍可正常参与分析。
--
-- ⚠️ 通用性：锁的是**分组数据本身**（scene_id → group 的映射），
--   不含任何题材/语言/词表假设。换题材、换语言、换剧本一律照常工作。
--   独立成表（而非给 scene_analysis 加列）是刻意的：
--   scene_analysis 每次重析都 DELETE 全表重建，锁必须能存活于那次删除。
CREATE TABLE IF NOT EXISTS scene_group_locks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  episode_id INTEGER NOT NULL,
  scene_id INTEGER NOT NULL,
  spatial_group TEXT NOT NULL,       -- 被锁定（人审确认过）的组名
  note TEXT DEFAULT '',              -- 锁定原因/来源，纯记录用，不参与逻辑
  UNIQUE(episode_id, scene_id),
  FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_scene_group_locks_ep ON scene_group_locks(episode_id);

-- 锚点图登记（场景锚 + 道具锚）
CREATE TABLE IF NOT EXISTS scene_anchors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  episode_id INTEGER NOT NULL,
  anchor_type TEXT NOT NULL,         -- 'scene'（空间锚，图即该场景定稿图）| 'prop'（道具锚，图为该道具首次定稿的场景图）| 'spatial'（空间组人审基准图，第 3 层）
  anchor_key TEXT NOT NULL,          -- 场景标题 / 道具名（与 scene_analysis.props_json 中的名称一致）
  scene_id INTEGER DEFAULT 0,        -- 锚点图出自哪个场景
  scene_number INTEGER DEFAULT 0,
  image_url TEXT NOT NULL,           -- 锚点图（裸路径，无 cache-buster）
  description TEXT DEFAULT '',
  source TEXT DEFAULT 'auto',        -- 'auto'（自动登记，重析时重建）| 'manual'（人工指定，重析时保留）
  confirmed INTEGER DEFAULT 0,       -- 人工确认标记（预留：前端锚点审核）
  -- 生成该锚所用素材的指纹（md5，2026-09-18）。
  -- 为什么需要：布局图刻意用 source='manual'（重析不删，保护花钱生成的图），代价是
  --   "场景描述改了、布局图可能过时"。过时的布局图**比没有更糟**——组内场景会照着一张错的
  --   底图对齐空间，错误顺锚放大到整组。有了指纹就能在 UI 上显式提示"素材已变，建议重画"。
  -- 只对 layout 锚有意义（照片类锚图即结果，不存在"素材过时"概念）→ 其它类型留空串。
  source_fingerprint TEXT DEFAULT '',
  UNIQUE(episode_id, anchor_type, anchor_key),
  FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_scene_anchors_ep ON scene_anchors(episode_id, anchor_type);

-- ===================== 空间组人审基准图（第 3 层，2026-09-17）=====================
--
-- 解决什么问题：前两层（锚点集 + 串行锁）保证了「后画的参考先画的」，但**第一张**基准
-- 本身错了（断桥画成石拱桥）时，整组跟着错。本表承载「每组先出一张 → 人看 → 确认/重画/
-- 跳过」的审核流程状态；确认结果落在 scene_anchors（anchor_type='spatial'），不在本表。
--
-- 为什么按集+组名做业务键：spatial_group 是 LLM 命名的稳定英文串（scene_analysis 同源），
-- 重提资产换 scene_id 也不漂移。集级「审核完成」**现算**（pending 计数=0），
-- 不在 episodes 加冗余布尔列（加场/换集必漂移）。
CREATE TABLE IF NOT EXISTS spatial_group_review (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  episode_id INTEGER NOT NULL,
  spatial_group TEXT NOT NULL,          -- = scene_analysis.spatial_group 原串
  rep_scene_id INTEGER DEFAULT 0,       -- 代表场 = 组内 scenes.scene_number 最小者（sync 时刷新）
  rep_scene_number INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'confirmed' | 'skipped'（代码层校验，无 CHECK，与库内约定一致）
  baseline_image_url TEXT DEFAULT '',   -- 确认时的基准图快照（裸路径）；未确认时可为空，展示用现算
  UNIQUE(episode_id, spatial_group),
  FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sgr_episode ON spatial_group_review(episode_id, status);

-- ===================== 资产物理状态变体（P2'，2026-09-17）=====================
--
-- 解决什么问题：同一物体跨镜/跨场出现时，其**物理状态**须保持一致
--   （「桥从完好 → 断了半截」这种叙事性变化是有意的；但同一镜内/相邻镜
--   不得无故在「完好」与「破损」间跳变）。此前 sceneAnchors.js 的道具锚
--   提示词已写「须与参考图…破损状态一致」，但没有结构化数据承载"某资产在
--   某场到底处于哪个状态"——这句提示词是空头支票。
--
-- 通用性硬约束（为什么状态键用 ASCII、词表外置）：
--   state_key 是**语言中立的稳定键**（如 intact / broken / cracked），
--   中文展示名走 lexicon 的 stateAliases 段（ai/lexicons/zh-CN.js）反查。
--   换语言只改 lexicon 数据文件，逻辑代码零改动（对照 continuityGuard.js 的语言包体系）。
--
-- 键空间（为什么用业务键 asset_key 而非自增 id）：
--   props/scenes 表是 AUTOINCREMENT，重提资产会 DELETE+INSERT → id 必换新。
--   若状态行挂 id，则每次重提资产状态行必成孤儿（见 ai/sceneAnchors.js 的孤儿兜底）。
--   故用**业务键** asset_key：prop/scene 用「锚点裸名 / 场景标题」，character 用角色名，
--   天然跨"重提取换 id"稳定。名空间与 scene_anchors.anchor_key（去后缀）一致。
--
-- 本表自带 image_url（不复用 asset_image_history）：history 的键空间分裂
--   （character 项目级 1~7 / scene·prop 集级），复用必错配；由调用方按各自名空间
--   解析后写入 image_url，把差异挡在写入侧单点。
CREATE TABLE IF NOT EXISTS asset_states (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  asset_type     TEXT NOT NULL CHECK(asset_type IN ('character','scene','prop')),
  asset_key      TEXT NOT NULL,          -- 业务键（锚点裸名/场景 title/角色名），非自增 id
  state_key      TEXT NOT NULL,          -- ASCII 稳定键（语言中立），如 'intact'/'broken'
  label_zh       TEXT DEFAULT '',        -- 展示名（zh），仅 UI/回填；lexicon 未登记时 UI 回退显示 state_key
  description    TEXT DEFAULT '',        -- zh 状态描述
  description_en TEXT DEFAULT '',        -- en 状态描述（入出片 prompt）
  image_url      TEXT DEFAULT '',        -- 本状态态的图（不复用 history，见上方说明）
  is_default     INTEGER DEFAULT 0,      -- 1=原始/完好版（闪回取此版，对应 state_key='intact'）
  source         TEXT DEFAULT 'manual',  -- 'manual'|'llm'|'inherit'
  UNIQUE(asset_type, asset_key, state_key)
);
CREATE INDEX IF NOT EXISTS idx_asset_states_key ON asset_states(asset_type, asset_key);

-- 场景「描述 ↔ 光影常量」冷暖自洽判定缓存（2026-09-18）
--
-- 存在理由：该判定初版由四个内容词表正则实现（违反「零题材词表、零内容正则」铁律），
--   已在真实数据上误报——ep4 场6 的 summary「…远处雪峰已成天边一线。夕阳把整片森林染成蜜色…」
--   与 lighting_en「warm golden sunset light…」明明都是暖调，却因"远处雪峰"的「雪」字被判冷环境。
--   重写为 LLM 语义判定后，每次落库都要调模型 → 成本与延迟都不可接受（同一场景反复保存会反复调）。
--   故按「内容指纹 + 模型」缓存结论：指纹变（摘要或光影改写）即自动失效重判。
--
-- 键 = (fingerprint, model)，而非 (scene_id)：同一段设定可能被多个场景共用，
--   且 scene 行会被整体重建（id 变化），用内容做键比用 id 稳。
-- 指纹**只含参与判定的两个字段**（summary + lighting_en）：改场景名/改道具不该让缓存失效——
--   否则会出现"只改了个错别字，却白跑一次付费调用"。
--
-- ⚠️ 通用性：本表零题材词表、零语言假设，纯缓存，换题材/换语言照常工作。
-- ⚠️ 本表是**全新表**（非老表加列），故 CREATE TABLE IF NOT EXISTS 写在这里对老库同样安全。
CREATE TABLE IF NOT EXISTS lighting_checks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint TEXT NOT NULL,             -- md5(summary \u0001 lighting_en)
  model       TEXT NOT NULL,             -- 判定所用模型；换模型自动失效（不同模型结论可能不同）
  verdict     TEXT NOT NULL,             -- 'consistent' | 'conflict' | 'insufficient'
  reason      TEXT DEFAULT '',           -- 判 conflict 时的中文原因；否则空串
  checked_at  TEXT DEFAULT '',
  UNIQUE(fingerprint, model)
);

