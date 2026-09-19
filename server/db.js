import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { config } from './config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

let db = null

export function initDB() {
  db = new Database(config.db.path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  // 执行建表语句
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8')
  db.exec(schema)

  // 迁移：为历史数据库补齐新增字段
  const migrations = [
    ['episodes', 'storyboard_confirmed', 'INTEGER DEFAULT 0'],
    ['episodes', 'ai_chat_history', "TEXT DEFAULT '[]'"],
    // 资产/分镜最后一次提取生成时所依据剧本的指纹（md5）：与当前剧本指纹不一致即判定过期，
    // 存库而非浏览器本地，任何浏览器/清缓存后仍能正确提示「剧本已改，资产/分镜需重提」
    ['episodes', 'assets_script_fp', "TEXT DEFAULT ''"],
    ['episodes', 'storyboard_script_fp', "TEXT DEFAULT ''"],
    ['episodes', 'storyboard_source', "TEXT DEFAULT 'generated'"],
    // 集级「镜头语言规格」：AI 分镜/提示词生成时必须遵守的全局连续约束（方向/机位/光照/物理规则）。
    // 换剧本=新集独立填写；AI 分镜一键刷新不覆盖 shots.video_prompt_override 的手工定制，二者配合锁跨镜头一致性。
    ['episodes', 'director_notes', "TEXT DEFAULT ''"],
    ['scenes', 'image_url', 'TEXT DEFAULT ""'],
    ['scenes', 'prop_names', "TEXT DEFAULT '[]'"],
    // ── H3 全英文链路的英文字段正式登记（历史库已由 server/_fix_en_fields.py 一次性补过，
    //    这里对未跑过脚本的老库/半新库自动补齐，SELECT 不再撞「列不存在」）──
    ['scenes', 'title_en', "TEXT DEFAULT ''"],
    ['scenes', 'summary_en', "TEXT DEFAULT ''"],
    ['characters', 'name_en', "TEXT DEFAULT ''"],
    ['characters', 'description_en', "TEXT DEFAULT ''"],
    // 主设定英文字段（2026-09-14，选角雷根治）：extractAssets 产 nameEn/descriptionEn
    // 落到 project_characters，同步到各集 characters 行；出片 prompt 六段全英文消费。
    // 此前 description_en 全靠一次性脚本手填，线上无生成链路——新剧本角色会缺英文
    // 外貌描述，v4Video「宁缺勿脏」直接丢弃 → 角色锁定只剩名字，2-1 选角错配即此雷。
    ['project_characters', 'name_en', "TEXT DEFAULT ''"],
    ['project_characters', 'description_en', "TEXT DEFAULT ''"],
    ['props', 'name_en', "TEXT DEFAULT ''"],
    ['style_presets', 'prompt_en', "TEXT DEFAULT ''"],
    // 场景光影常量（#2 场景光影常量，2026-09-11）：光源方位+色温+时间氛围（英文）。
    // 出片 prompt（v4Video/videoPrompt 的场景注入）与分镜图模块3【环境冻结】逐字复用，
    // 跨镜钉死光照；为空则注入层整体跳过。存量场景由 server/_prefill_lighting_en.mjs 预填。
    ['scenes', 'lighting_en', "TEXT DEFAULT ''"],
    ['props', 'owner', "TEXT DEFAULT ''"],
    ['characters', 'audio_url', 'TEXT DEFAULT ""'],
    // 项目级 IP 角色库链接：非空表示该角色是项目主设定的一个"引用实例"，
    // 其 description/appearance/image_url/audio_url 一律以主设定为准（读时合并、写时回写）
    ['characters', 'project_character_id', 'INTEGER'],
    // 全局 IP 角色库链接：非空表示该项目角色由全局 IP 设定派生，
    // 在 IP 库里改形象后"应用到项目"即可覆盖这里的副本
    ['project_characters', 'ip_character_id', 'INTEGER'],
    // IP 容器层：ip_id 非空表示该角色归属于某个 IP（如 一二、布布 → 一二布布）。
    // 编剧时先路由到 IP，再整包继承，避免只靠角色名精确匹配导致断链。
    ['ip_characters', 'ip_id', 'INTEGER'],
    // 角色级别名，逗号分隔。用于 IP 路由召回：剧本里写成"小一""布布酱"也能认出来。
    ['ip_characters', 'aliases', "TEXT DEFAULT ''"],
    ['shots', 'shot_type', 'TEXT DEFAULT ""'],
    ['shots', 'start_time', 'INTEGER DEFAULT 0'],
    ['shots', 'end_time', 'INTEGER DEFAULT 0'],
    ['shots', 'action_note', 'TEXT DEFAULT ""'],
    ['shots', 'sound_effects', 'TEXT DEFAULT ""'],
    ['shots', 'dialogue', 'TEXT DEFAULT ""'],
    ['shots', 'camera_movement', 'TEXT DEFAULT ""'],
    // 机位朝向：正面/侧面/背面/过肩/俯拍/仰拍。机位一致性校验（朝向 vs 运镜语义 vs 分镜图 vs 角色文案）的锚点字段。
    // 背景：1-1 "顺着视线推近" 生成成正面，根因是朝向只存在于描述文字里、没有结构化字段，LLM 自由发挥后无校验可拦。
    ['shots', 'camera_angle', 'TEXT DEFAULT ""'],
    ['shots', 'overall_soundscape', 'TEXT DEFAULT ""'],
    ['shots', 'non_diegetic_music', 'TEXT DEFAULT ""'],
    ['shots', 'integrated_multimodal_description', 'TEXT DEFAULT ""'],
    ['shots', 'blocking_plan', "TEXT DEFAULT ''"],
    ['shots', 'final_frame', "TEXT DEFAULT ''"],
    // 「AI整改」定制的视频提示词：非空时生成视频以它为准（空串=清除定制，恢复自动生成）
    ['shots', 'video_prompt_override', "TEXT DEFAULT ''"],
    // 分镜图第二张（frame 每次并行出 2 张候选，frame_url 为主图）
    ['shots', 'frame_url2', "TEXT DEFAULT ''"],
    // 末帧回灌锚：上一镜成片末帧（POST /generate/continuity-frame 写入），下一镜出片时
    // 作为 continuity 首帧锚（官方 keyframe completion 语义）。独立列，不覆盖 frame_url——
    // frame_url 还装着四宫格拼图/构图锚，覆盖会丢。
    ['shots', 'continuity_url', "TEXT DEFAULT ''"],
    // 尾帧锚（2026-09-16，「final_frame 一键生图」）：由本镜 final_frame 文字描述直接出一张图，
    // 画的是**本镜结束**的画面（frame_url 画的是本镜开头），两者成对才能让相邻镜接缝在画面上
    // 真正对得上。语义与 continuity_url 正交、互不覆盖——continuity_url 是"上一镜成片的真实末帧"
    // （回灌物），keyframe_url 是"本镜收尾的规划画面"（规划物）；两者都可用于下镜首帧参考，
    // 但来源不同，落不同列才能在 UI 上分辨"规划 vs 实测"。独立列，不覆盖 frame_url。
    ['shots', 'keyframe_url', "TEXT DEFAULT ''"],
    // 衔接质量检测结果（#3，2026-09-11）：JSON {cctDiffK, lumaDiff, hashDist, alert, thresholds...}。
    // 出片成功后自动比对「本镜成片首帧 vs 本镜 continuity 锚帧（上一镜末帧）」的色温/亮度写入；
    // alert=true 时前端镜头卡片标红报警。构图为参考指标不参与告警（跨镜重新取景是合法操作）。
    ['shots', 'seam_check', "TEXT DEFAULT ''"],
    // VLM 观片闸评审结果（2026-09-12 满分路线图第一级）：JSON {emotion, clarity, dialogueFace,
    // visualQuality, avgScore, verdict, issues[], summary}。独立于 seam_check——不进锁4 的
    // 409 拦截通道（新闸未上过战场，只亮报告人终审，验证一个项目后可升格）。
    ['shots', 'shot_review', "TEXT DEFAULT ''"],
    // 闭环回灌（2026-09-12，Character.ai eval-in-the-loop 模式）：观片闸 verdict=fail 时
    // 把未执行的剧本节拍+问题清单写进 retry_feedback；下次该镜重出时 v4 prompt 组装自动
    // 注入"上次验收失败，必须修正"指令。retry_count 记录自动重试次数（上限 2，防烧币）。
    ['shots', 'retry_feedback', "TEXT DEFAULT ''"],
    ['shots', 'retry_count', 'INTEGER DEFAULT 0'],
    // 全集风格锚（Sora 招，2026-09-12）：每集第一镜出片成功后末帧自动存此，
    // 后续每镜出片 refs 补风格锚槽——remix 语义"永远锚定第一镜"，防接力链画风漂移。
    ['episodes', 'style_anchor_url', "TEXT DEFAULT ''"],
    // 场级 2x2 四宫格分镜图（导演台段落出片专用：一次生成 4 镜网格，直接喂 storyboard_images）
    ['storyboard_scenes', 'grid_image_url', "TEXT DEFAULT ''"],
    // 镜头戏型：1=武戏（加载打斗 LoRA）、0=文戏（不加载）、NULL=未判定（出片时实时判定）。
    // 换任何剧本都靠它决定 LoRA 强度，不再依赖场次号——场次号是单集专属的，换剧本就失效。
    ['shots', 'is_combat', 'INTEGER'],
    // 项目级默认宽高比（剧集级 / 分镜图 / 出片链路共用）。新建项目走 schema.sql 的 DEFAULT；
    // 历史项目由这条迁移补齐。当前项目默认竖屏 9:16（短剧形态，2026-09-11 布哥定调）。
    // 注意：枚举值带括号后缀与后端 VIDEO_ASPECT_RATIOS 白名单字面一致，否则请求体
    // → 工作流节点校验会被静默回落到工作流默认。
    ['projects', 'aspect_ratio', "TEXT DEFAULT '9:16 (Portrait Widescreen)'"],
    // 段首裁切偏移秒（2026-09-15，E 路线切片回填）：段成片开头若有坏帧/黑场，
    // 用 ffmpeg 裁掉 trim_start 秒再按镜边界切片，避免坏头进入镜级回填视频。
    // 切片器 segmentSlicer.js 消费：每镜切片时间 = (shot.start_time - seg.start_time) + trim_start。
    ['video_segments', 'trim_start', 'REAL NOT NULL DEFAULT 0'],
    // 段方案的镜表指纹（2026-09-15，E 路线切片回填）：段只存 shot_ids 快照，镜被删/改序/改时长后
    // 无从察觉，切片会按错误时间轴静默产出内容错位的视频（审计 P0-A/P0-D）。
    // 落库时写 segmentBuilder.shotsFingerprint(episodeId)，分镜一变即整批判 stale。
    // 空串 = 历史数据（无指纹可依，切片时按「镜数 + 同场」两道校验兜底）。
    ['video_segments', 'shots_fp', "TEXT NOT NULL DEFAULT ''"],
    // ── P0（2026-09-17 资产连续性）props 描述英文列 ──
    // 补道具描述断链：characters 有 description_en、scenes 有 summary_en，独 props 缺英文描述列，
    // 导致出片 prompt 的道具槽 descEn 恒为空（generate-video.js 装配时传 ''）。对照 scenes.summary_en 语义。
    ['props', 'description_en', "TEXT DEFAULT ''"],
    // ── P1（2026-09-17）场景地点列 ──
    // 场景的结构化地点名（= title 派生，见 _backfill_scene_location.mjs）。零 LLM、可重跑。
    // 与 scene_anchors.anchor_key（=场景标题）天然对齐，供后续跨场地点连续性判据使用。
    ['scenes', 'location', "TEXT DEFAULT ''"],
    // ── P2'（2026-09-17）镜头级资产状态映射 ──
    // JSON: {"prop":{"断桥":"broken"},"character":{...},"scene":{...}} —— 业务键→state_key。
    // 空串 = 全部资产走默认态（= 改造前行为，零风险）。消费侧见 ai/assetState.js resolveState()。
    ['shots', 'asset_states_json', "TEXT DEFAULT ''"],
    // ── A1/A2（2026-09-17）场景要素硬约束 + 组级环境卡 ──
    // 起因：场1 摘要写了"清晨浓雾"却出成晴空、场2 摘要没提植被就整片秃——
    // 都是「摘要里明文写了的事实」没能进入画面。这里落两列 LLM 抽出的清单，
    // 出图时由 promptBuilder 以独立权重位硬约束（不是词表/正则，通用性不变）：
    //   elements_json  = 本场要素清单（本场摘要里明文出现、必须在画面中看得见的东西）
    //   shared_env_json= 组级环境卡（同组共享的植被/地质/色调/地标，无新意但不可或缺）
    // 空数组 = 老数据/分析未跑 → 出图 prompt 逐字不变（= 改造前行为）。
    ['scene_analysis', 'elements_json', "TEXT DEFAULT '[]'"],
    ['scene_analysis', 'shared_env_json', "TEXT DEFAULT '[]'"],
    // ── A4/A5（2026-09-17）场景图质检告警的场景维度 ──
    // system_alerts 原本只有镜头身份（shot_id/shot_number），场景图质检的告警无处安放。
    // 不加这两列就只能把场景号塞进 shot_number —— 语义混淆，日后"这条告警属于谁"靠猜。
    // 空值 = 该告警与场景无关（既有的全部告警行），行为完全不变。
    ['system_alerts', 'scene_id', 'INTEGER'],
    ['system_alerts', 'scene_number', "TEXT DEFAULT ''"],
    // ── 布局锚素材指纹（2026-09-18，布局图时效提示）──
    // 布局图用 source='manual'（重析不删，保护花钱生成的图），代价是描述改了它可能过时。
    // 过时的布局图比没有更糟——组内场景会照着错的底图对齐空间，错误顺锚放大到整组。
    // 记下"画它时用的素材指纹"，status 接口就能比对出"素材已变、建议重画"。
    // 空串 = 老数据/非 layout 锚 → 不做时效判断（宁可不提示，也不误报）。
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

  // 列迁移之后才能建「依赖新列」的索引（2026-09-17）：
  // schema.sql 是整段 exec，里面建索引时老库还没补 scene_id 列 → 启动直接崩。
  // 故凡是"索引依赖后补列"的，都必须放在迁移循环**之后**。
  const postMigrationIndexes = [
    // A4/A5 场景图质检告警按场景查询（/alerts 面板与重出后的清告警都要用它）
    `CREATE INDEX IF NOT EXISTS idx_system_alerts_scene ON system_alerts(scene_id)`,
  ]
  for (const sql of postMigrationIndexes) {
    try {
      db.exec(sql)
    } catch (e) {
      // 建索引失败不该阻断启动（缺索引只是慢，不是坏）
      console.warn('[DB] 索引创建失败（不影响启动）:', e.message)
    }
  }

  // 删列迁移（2026-09-14 新增）：schema.sql 只对**新库**生效，历史库里的废弃列靠这里收敛。
  // 只用于「确认无数据、无索引、无视图引用」的列——DROP COLUMN 会重写整表，动手前先确认
  // COUNT(非空)=0。SQLite 需 >= 3.35（本机 better-sqlite3 内置 3.49.2）。
  const dropMigrations = [
    // ai_calls.coins：建表时预留的「RH 币消耗」，但从未有调用方传值（1365 条记录 0 条非空），
    // 属假数据遗留。2026-09-14 随前端假余额展示一并清理，详见 schema.sql 的注释。
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

  // 依赖迁移列的索引：必须在列补齐之后再建，否则老库首次启动会因"列不存在"崩在 CREATE INDEX 上
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

// 通用查询辅助函数
export function query(sql, params = []) {
  return getDB().prepare(sql).all(...params)
}

export function queryOne(sql, params = []) {
  return getDB().prepare(sql).get(...params)
}

export function execute(sql, params = []) {
  return getDB().prepare(sql).run(...params)
}

// 事务
export function transaction(fn) {
  const tx = getDB().transaction(fn)
  return tx()
}
