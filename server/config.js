import path from 'node:path'
import dotenv from 'dotenv'
import { serverDir } from './paths.js'

dotenv.config({ path: path.join(serverDir, '.env') })

const LOCAL_PROXY_URL = process.env.ZIKL_PROXY || 'http://127.0.0.1:7897'

export const config = {
  port: process.env.PORT || 3000,

  host: process.env.SERVER_HOST || '127.0.0.1',

  // 默认画风不写死具体画风：由 DEFAULT_ART_STYLE 环境变量或项目 art_style 决定。
  // 留空时全链路退回中性画风表述，不静默套用某个画风。
  defaultArtStyle: process.env.DEFAULT_ART_STYLE || '',

  skill: {
    // xiaomo-film-studio Skill 规则快照目录：分镜与资产生成的【规则唯一事实源】。
    // 服务器生成时从此目录加载 asset-rules / storyboard-rules / visual-quality 三份规则 + manifest.json。
    // 【部署自包含】默认读工程内快照，服务器不装 Skill 也能跑；部署包自带规则，不依赖外部环境。
    // 本地要试 Skill 最新版时，用 SKILL_RULES_PATH 指向 ~/.workbuddy/skills/.../references 覆盖。
    // 快照内容变更请走 server/ai/rules/sync-from-skill.mjs，同步更新 manifest 版本号。
    rulesPath: process.env.SKILL_RULES_PATH || path.join(serverDir, 'ai', 'rules', 'xiaomo-film-studio'),
  },

  // ── 文本大模型 ──────────────────────────────────────────────────────────
  // 唯一调用入口：server/ai/doubao.js → chatCompletion()（OpenAI 兼容协议）。
  // 运行时取值一律来自库（「AI 模型配置」的文本通道，热生效）；本段仅作【首启 seed 初值 / 旧库迁移取值源】，
  // 运行期【不再回退】本段，未在抽屉里配置会得到可读错误而不是静默套用 .env。
  llm: {
    // Key 统一入口：LLM_API_KEY > DASHSCOPE_API_KEY，配其一即可
    apiKey: process.env.LLM_API_KEY || process.env.DASHSCOPE_API_KEY || '',
    baseURL: process.env.LLM_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    // 与当前可配置的文本模型保持一致；运行期仍以 AI 模型配置库为准。
    model: process.env.LLM_MODEL || 'deepseek-v4.1-flash',
    // 全局并发上限（默认 6）
    maxConcurrent: Math.max(1, Number(process.env.LLM_MAX_CONCURRENT) || 6),
  },

  timeouts: {
    llm: {
      short: Math.max(1000, Number(process.env.LLM_TIMEOUT_SHORT_MS) || 30000),
      translate: Math.max(1000, Number(process.env.LLM_TIMEOUT_TRANSLATE_MS) || 60000),
      repair: Math.max(1000, Number(process.env.LLM_TIMEOUT_REPAIR_MS) || 90000),
      standard: Math.max(1000, Number(process.env.LLM_TIMEOUT_STANDARD_MS) || 180000),
      extended: Math.max(1000, Number(process.env.LLM_TIMEOUT_EXTENDED_MS) || 240000),
      // longScript：分镜 / 整本生成等 maxTokens 30000 的长输出任务。
      // 5 分钟对推理模型（强制 thinking，如 qwen3.8-2.4t-a95b）不够——
      // 思考 2-4k token + 正文 1-2 万 token，按持续输出 ~50 tokens/s 需 8-10 分钟。
      // dashscope 直连无 100s 网关掐断风险；前端 LLM_LONG_TIMEOUT_MS=25 分钟留有余量。
      longScript: Math.max(1000, Number(process.env.LLM_TIMEOUT_LONG_SCRIPT_MS) || 720000),
    },
    http: {
      default: Math.max(1000, Number(process.env.HTTP_TIMEOUT_DEFAULT_MS) || 30000),
      upload: Math.max(1000, Number(process.env.HTTP_TIMEOUT_UPLOAD_MS) || 60000),
      download: Math.max(1000, Number(process.env.HTTP_TIMEOUT_DOWNLOAD_MS) || 180000),
      generate: Math.max(1000, Number(process.env.HTTP_TIMEOUT_GENERATE_MS) || 300000),
    },
    workflow: {
      poll: Math.max(1000, Number(process.env.WORKFLOW_POLL_TIMEOUT_MS) || 600000),
      video: Math.max(1000, Number(process.env.VIDEO_JOB_TIMEOUT_MS) || 1200000),
    },
  },


  storyboard: {
    // 旧美学检查门控（2026-09-26）：分镜美学规则已切换为 xiaomo-film-studio Skill，
    // 按旧规则写就的检查（切镜收益/景别搭配/集级配比/声弧/留白互斥等）默认关闭，避免误报。
    // 置 1 可临时恢复旧口径用于回归对比。
    legacyAestheticChecks: process.env.STORYBOARD_LEGACY_AESTHETIC_CHECKS === '1',
    // 长 Skill 提示词下并发请求会触发文本网关 524；默认顺序生成，明确设为 1 才并行。
    parallel: process.env.STORYBOARD_PARALLEL === '1',
    fixAxis: process.env.STORYBOARD_FIX_AXIS !== '0',
    // DeepSeek 思考模型的 max_tokens 同时覆盖思考与正文；分镜 JSON 需要较大预算，避免只返回 reasoning_content。
    maxOutputTokens: Math.max(1000, Number(process.env.STORYBOARD_MAX_OUTPUT_TOKENS) || 24000),
    enrichConcurrency: Math.max(1, Number(process.env.ENRICH_CONCURRENCY) || 4),
    durationMin: Math.max(1, Number(process.env.SHOT_DURATION_MIN) || 4),
    durationMax: Math.max(1, Number(process.env.SHOT_DURATION_MAX) || 15),
    // 单镜默认时长 / 默认景别：分镜生成、入库、补全、出片各处的兜底值统一读这里，
    // 不再在各文件里各写一份 8 / '中景' 的硬编码副本。
    defaultDuration: Math.max(1, Number(process.env.SHOT_DEFAULT_DURATION) || 8),
    defaultShotType: process.env.SHOT_DEFAULT_TYPE || '中景',
    // H3 出片 prompt 字符预算（官方 ≤7000 为硬上限）。此前代码里三处写死 7000，本键即为单一来源。
    h3PromptCharLimit: Math.max(1000, Number(process.env.H3_PROMPT_CHAR_LIMIT) || 7000),
    speechRateMaxCharsPerSec: Math.max(1, Number(process.env.DIALOGUE_SPEECH_RATE_MAX) || 5),
    speechRateMinChars: Math.max(1, Number(process.env.DIALOGUE_SPEECH_RATE_MIN_CHARS) || 3),
    axisVerify: process.env.STORYBOARD_AXIS_VERIFY !== '0',

    // Airlock 开场冻结已在 2026-09-24 事故整改中整体废除，默认 0 = 不做开场冻结
    //（承接即刻完成、动作与台词可从第 0 秒直接开始）。AIRLOCK_SEC>0 可恢复旧 Airlock 冻结行为，
    // 仅用于对照排查，非推荐值。跨场连戏改由「尾帧参考图 + 提示词承接句」承担。
    airlockSec: process.env.AIRLOCK_SEC != null && process.env.AIRLOCK_SEC !== '' ? Math.max(0, Number(process.env.AIRLOCK_SEC)) : 0,
    // 对话反打是否强制切镜（默认 false=允许合并）：对白驱动的连续戏（双主角对话）若强制切镜，
    // 整场被锁成 6-7s 短镜（2026-09-24 1-1/1-2 节奏稀烂事故）；H3 一镜多说话人由 v4Video 时间轴承载。
    dialogueReverseBlock: process.env.DIALOGUE_REVERSE_BLOCK === '1',
  },

  assetState: {
    enabled: process.env.ASSET_STATE !== '0',
  },

  // ── 剧本生成 ──────────────────────────────────────────────────────────
  // 平台通用：不预设任何具体题材/受众。题材由项目配置经 generateScript 的 options.genre 注入，
  // 平台只提供与题材无关的结构与体量默认值。
  script: {
    minChars: Math.max(1, Number(process.env.SCRIPT_MIN_CHARS) || 800),
    maxChars: Math.max(1, Number(process.env.SCRIPT_MAX_CHARS) || 1500),
    sceneCountMin: Math.max(1, Number(process.env.SCRIPT_SCENE_COUNT_MIN) || 3),
    sceneCountMax: Math.max(1, Number(process.env.SCRIPT_SCENE_COUNT_MAX) || 5),
    temperature: Number(process.env.SCRIPT_TEMPERATURE ?? 0.8),
    maxTokens: Math.max(1, Number(process.env.SCRIPT_MAX_TOKENS) || 6000),
  },

  progress: {
    ttlAfterDoneMs: Math.max(1000, Number(process.env.PROGRESS_TTL_AFTER_DONE_MS) || 30_000),
    staleActiveMs: Math.max(60_000, Number(process.env.PROGRESS_STALE_ACTIVE_MS) || 30 * 60 * 1000),
    maxEntries: Math.max(10, Number(process.env.PROGRESS_MAX_ENTRIES) || 200),
  },

  runninghub: {
    // apiKey 仅作【首启 seed 初值 / 旧库迁移取值源】：运行时取「AI 模型配置」视频通道的值（热生效），不回退此处。
    apiKey: process.env.RUNNINGHUB_API_KEY || '',
    // baseURL 为运行期唯一来源（用户不可配，固定平台地址）；workflows 各 ID 仅作 seed / 迁移取值源。
    baseURL: (process.env.RUNNINGHUB_BASE_URL || 'https://www.runninghub.cn').replace(/\/+$/, ''),
    workflows: {
      // ↓ 以下 4 个为【休眠配置（无代码引用）】：保留定义以便将来需要时直接接线，当前无任何调用点。
      imageGenerator: process.env.RH_IMAGE_GENERATOR_WORKFLOW_ID || '2092078813630001153', 
      storyboardGenerator: process.env.RH_STORYBOARD_GENERATOR_WORKFLOW_ID || '2092895275319910402', 
      frameGridGenerator: process.env.RH_FRAME_GRID_WORKFLOW_ID || '',
      // Qwen 生图（图生图，最多两张参考图）：498=image_1/image_2/aspect_ratio，487=prompt/resolution
      qwenImage: process.env.RH_QWEN_IMAGE_WORKFLOW_ID || '2102954366490734594',
      // ↓ 以下 3 个为在用工作流（经「AI 模型配置」视频通道管理，seed 初值取此处）：
      shotGridApp: process.env.RH_SHOT_GRID_APP_ID || '2048139846660657154',
      h3Combat: process.env.RH_H3_COMBAT_WORKFLOW_ID || '2094872667374571522',
      // 唯一出片工作流（2026-09-24 起：V5-SelfLift 融合改造版替换原 V5 2102257672056827905）：
      // 普通镜走占位视频（switch=false 的 1393 无视频路径），续接镜走真 video continuation
      // （switch=true 的 2103 参考视频路径）。ID 缺省即本账号工作流，可用 env 覆盖。
      h3V4vc: process.env.RH_H3_V4_VC_WORKFLOW_ID || '2102948824707854338',
    },
    h3CombatTimeoutMs: Number(process.env.RH_H3_COMBAT_TIMEOUT_MS) || 60 * 60 * 1000,
    shotGrid: {
      aspectRatio: process.env.RH_SHOT_GRID_ASPECT_RATIO || '9:16',
      resolution: process.env.RH_SHOT_GRID_RESOLUTION || '1k',
    },
    nodeMap: {
      imageGenerator: {
        prompt: { nodeId: '17', fieldName: 'prompt' },
      },
      storyboardGenerator: {
        apiVersion: 'v2',
        kind: 'workflow',
        instanceType: 'default',
        prompt: { nodeId: '1', fieldName: 'prompt' },
        negativePrompt: { nodeId: '13', fieldName: 'prompt' },
        image1: { nodeId: '22', fieldName: 'image' },
        image2: { nodeId: '30', fieldName: 'image' },
        llmApiBaseUrl: { nodeId: '27', fieldName: 'api_baseurl' },
        llmApiKey: { nodeId: '27', fieldName: 'api_key' },
        llmModel: { nodeId: '27', fieldName: 'model' },
      },
      frameGridGenerator: {
        apiVersion: 'v2',
        kind: 'workflow',
        instanceType: 'default',
        image1: { nodeId: '22', fieldName: 'image' },          
        image2: { nodeId: '30', fieldName: 'image' },          
        image3: { nodeId: '31', fieldName: 'image' },          
        userPrompt: { nodeId: '24', fieldName: 'text' },       
        target_vl_size: { nodeId: '1', fieldName: 'target_vl_size' },
        llmApiBaseUrl: { nodeId: '27', fieldName: 'api_baseurl' },
        llmApiKey: { nodeId: '27', fieldName: 'api_key' },
        llmModel: { nodeId: '27', fieldName: 'model' },
      },
      shotGridApp: {
        apiVersion: 'v2',
        kind: 'ai-app',
        instanceType: 'default',
        prompt: { nodeId: '13', fieldName: 'prompt' },
        aspectRatio: { nodeId: '14', fieldName: 'aspectRatio' },
        resolution: { nodeId: '14', fieldName: 'resolution' },
        image1: { nodeId: '2', fieldName: 'image' },
        image2: { nodeId: '8', fieldName: 'image' },
        image3: { nodeId: '9', fieldName: 'image' },
        image4: { nodeId: '10', fieldName: 'image' },
      },
      // Qwen 生图（文生图）：实测（2026-09-27）仅 497.prompt 可从 API 驱动。
      // 498（QwenPERewriteT8）的图片槽/aspect_ratio 被内部 9 图编辑管线接管——
      // 传参不生效或触发引用数校验失败；出图比例固定为工作流内置 9:16。
      // 图生图需在 RunningHub 编辑器解耦 498 后，再补 image1/image2 槽位映射。
      qwenImage: {
        apiVersion: 'v2',
        kind: 'workflow',
        instanceType: 'default',
        prompt: { nodeId: '497', fieldName: 'prompt' },
      },
      h3Combat: {
        apiVersion: 'v2',
        kind: 'workflow',
        instanceType: 'default',
        image1: { nodeId: '526', fieldName: 'image' },
        idea: { nodeId: '528', fieldName: 'prompt' },
        duration: { nodeId: '529', fieldName: 'value' },
        aspectRatio: { nodeId: '456', fieldName: 'aspect_ratio' },
        megapixels: { nodeId: '456', fieldName: 'megapixels' },
      },
      // Ref2VA video continuation 单图 Switch 版（V5-SelfLift 融合改造版，唯一出片工作流）：
      // 1393 无视频链 / 1393B(2103) 带 LoadVideo(2101)→GetVideoComponents(2102)→ref_video_0，
      // 两个 ComfySwitchNode(2104/2105) 切 positive/LATENT。普通镜传占位视频不传 switch
      // （默认 false 走 A 路径），续接镜传 video + switch="true" 走 B。
      // bool("false")==True，所以只传 true、绝不传 false。
      // SelfLift 单管线（2026-09-24 改造）：原一采(124)+二采(1329)双管线已删，换
      // SelfLiftH3Sampler(2106)——8 步调度内完成 低分前缀(6步@0.5)→lift→高分收尾(2步)，
      // 步数/分辨率由工作流内置调参，路由层不再覆盖（覆盖值会让高分收尾被挤掉）。
      // seed 落在 2106 的 seed widget；原 129 noise_seed、1329、1407(悬空) 节点均已不可用。
      // 新增 2111 ref_image_size 开关（match=快/max=身份准），默认 match，已接入 video values。
      h3V4vc: {
        apiVersion: 'v2',
        kind: 'workflow',
        instanceType: 'default',
        prompt: { nodeId: '1400', fieldName: 'value' },
        image0: { nodeId: '1399', fieldName: 'image' },
        image1: { nodeId: '1395', fieldName: 'image' },
        image2: { nodeId: '1394', fieldName: 'image' },
        image3: { nodeId: '1398', fieldName: 'image' },
        image4: { nodeId: '1397', fieldName: 'image' },
        image5: { nodeId: '1396', fieldName: 'image' },
        image6: { nodeId: '1401', fieldName: 'image' },
        image7: { nodeId: '1403', fieldName: 'image' },
        image8: { nodeId: '1402', fieldName: 'image' },
        audio0: { nodeId: '1404', fieldName: 'audio' },
        audio1: { nodeId: '1406', fieldName: 'audio' },
        audio2: { nodeId: '1405', fieldName: 'audio' },
        duration: { nodeId: '1412', fieldName: 'value' },
        aspectRatio: { nodeId: '1410', fieldName: 'aspect_ratio' },
        megapixels: { nodeId: '1410', fieldName: 'megapixels' },
        combatLora: { nodeId: '1414', fieldName: 'lora_name' },
        combatLoraStrength: { nodeId: '1414', fieldName: 'strength_model' },
        unetName: { nodeId: '1380', fieldName: 'unet_name' },
        seed: { nodeId: '2106', fieldName: 'seed' },
        refImageSize: { nodeId: '2111', fieldName: 'switch' },
        video: { nodeId: '2101', fieldName: 'file' },
        vcSwitchC: { nodeId: '2104', fieldName: 'switch' },
        vcSwitchL: { nodeId: '2105', fieldName: 'switch' },
      },
    },
  },

  image: {
    ref: {
      maxBytes: Number(process.env.IMAGE_REF_MAX_BYTES) || 400 * 1024,
      maxEdge: Number(process.env.IMAGE_REF_MAX_EDGE) || 1024,
    },
    // 生图通道（OpenAI 兼容）的【首启 seed 初值 / 旧库迁移取值源】；运行时不读本段，
    // 实际生效值见 modelConfig.js（「AI 模型配置」的生图通道），无配置时报可读错误而非静默回退。
    zikl: {
      apiKey: process.env.ZIKL_API_KEY || '',
      baseURL: process.env.ZIKL_BASE_URL || 'https://img.zikl.dev',
      model: process.env.ZIKL_IMAGE_MODEL || 'gpt-image-2',
      size: process.env.ZIKL_IMAGE_SIZE || '1K',
      assetSize: process.env.ZIKL_ASSET_SIZE || '1536x1024',
      proxy: LOCAL_PROXY_URL,
    },
  },

  qmx: {
    // 启明星模型广场（免鉴权只读）：抽屉里「从启明星拉取模型列表」的唯一数据源。
    // 注意：广场路径 /api/v1/model-plaza 与 OpenAI 兼容 baseURL 前缀 /v1 的路径规则
    // 不兼容（先有 /api 段，且 model-plaza 不属 OpenAI 兼容面），不能由 qmxBaseURL 拼接，
    // 故此处必须独立配置，不复用 QMX_BASE_URL。
    plazaUrl: process.env.QMX_PLAZA_URL || 'https://api.aisj.ai/api/v1/model-plaza',
    plazaTimeoutMs: Number(process.env.QMX_PLAZA_TIMEOUT_MS) || 8000,
    plazaCacheTtlMs: Number(process.env.QMX_PLAZA_CACHE_TTL_MS) || 10 * 60 * 1000,
  },

  db: {
    path: process.env.DB_PATH || path.join(serverDir, 'data.db'),
  },

  retention: {
    aiCallsDays: Math.max(0, Number(process.env.AI_CALL_RETENTION_DAYS) || 180),
  },

  video: {
    defaultAspectRatio: process.env.DEFAULT_ASPECT_RATIO || '9:16 (Portrait Widescreen)',
    aspectRatios: [
      '4:3 (Standard)',
      '9:16 (Portrait Widescreen)',
      '16:9 (Widescreen)',
      '21:9 (Ultrawide)',
      '1:1 (Square)',
      '3:4 (Portrait Standard)',
    ],
    combatAspectRatios: [
      '1:1 (Square)',
      '2:3 (Portrait Photo)',
      '3:2 (Photo)',
      '3:4 (Portrait Standard)',
      '4:3 (Standard)',
      '9:16 (Portrait Widescreen)',
      '16:9 (Widescreen)',
      '21:9 (Ultrawide)',
    ],
    combatDurationMin: Math.max(1, Number(process.env.COMBAT_SHOT_MIN_SEC) || 5),
    combatDurationMax: Math.max(1, Number(process.env.COMBAT_SHOT_MAX_SEC) || 15),
    combatDefaultDuration: Math.max(1, Number(process.env.COMBAT_SHOT_DEFAULT_SEC) || 6),
    megapixels: String(process.env.VIDEO_MEGAPIXELS || '0.5,0.75,1.0').split(',').map((s) => s.trim()).filter(Boolean),
    defaultMegapixels: process.env.VIDEO_DEFAULT_MEGAPIXELS || '0.5',
    // MiniMax-H3 官方 API 文档（platform.minimax.io，2026-09-30 复核）：duration 取值 4-15 整数秒。
    // 下限不得低于 4——传 3 会被官方参数校验直接打回（400）。
    shotDurationMin: Math.max(4, Number(process.env.VIDEO_SHOT_MIN_SEC) || 4),
    shotDurationMax: Math.max(1, Number(process.env.VIDEO_SHOT_MAX_SEC) || 15),
    shotDefaultDuration: Math.max(1, Number(process.env.VIDEO_SHOT_DEFAULT_SEC) || 5),
    h3SingleTakeBlock: process.env.H3_SINGLE_TAKE_BLOCK !== '0',
    h3EmotionToneVisual: process.env.H3_EMOTION_TONE_VISUAL !== '0',
    // 出片任务并发数：同一时刻最多并行执行的镜头出片任务数（排队任务按提交顺序执行）
    jobConcurrency: Math.max(1, Number(process.env.VIDEO_JOB_CONCURRENCY) || 2),
    // subject_definitions 只写官方 ref-en §2 要求的「main features to follow」（2026-09-30 在线核对官方原文属实）：
    // 资产 description_en 是生图用的完整外观，出片按官方口径压到 h3SubjectFeaturesCap 以内
    //（9 张图走独立 image 通道，不占 7000 预算）。
    // 默认 300 是实测标定值，不是保守起步值：cap 过小（如 260）会把多角色之间靠外观细节
    // 区分的特征句（毛色/肤色等）挤出，只剩次要配饰，单边丢特征会加剧角色混淆；
    // 实测 cap=300 时全部角色的特征句存活（角色特征合计 839 字符，占 7000 预算 12%，
    // 远低于 cap=360 的 1034），整条 prompt 4378 字符。
    // 置 H3_SUBJECT_FULL_DESC=1 可回退「原样复述完整外观」，用于出片质量对比。
    h3SubjectFullDesc: process.env.H3_SUBJECT_FULL_DESC === '1',
    h3SubjectFeaturesCap: Math.max(80, Number(process.env.H3_SUBJECT_FEATURES_CAP) || 300),

    // ── 打斗工作流（h3Combat）契约 ──────────────────────────────────────
    // LoRA 触发词、提示词模板、机位约束句均属【工作流契约】，不是平台业务，
    // 换工作流 / 换 LoRA / 换打斗语汇时改配置即可，不改代码。
    combatLoraTrigger: process.env.RH_COMBAT_LORA_TRIGGER || 'prfight1',
    combatLoraTriggerKnockdown: process.env.RH_COMBAT_LORA_TRIGGER_KNOCKDOWN || 'prfight1, prfin1',
    // 命中"击倒"语义时追加击倒触发词；词表数据驱动，不写死在路由里。
    combatKnockdownWords: String(process.env.RH_COMBAT_KNOCKDOWN_WORDS || '倒进,倒地,瘫倒,击倒,轰然倒')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // 出片底模 / 战斗 LoRA 与其强度：属【工作流资源】，换工作流或换底模改配置即可，代码不再写死文件名。
    unetName: process.env.RH_UNET_NAME || 'Minimax-h3_Singularity_ref2va_Pruned_v1.3_int8.safetensors',
    combatLoraName: process.env.RH_COMBAT_LORA_NAME || 'H3_Combat_V2.safetensors',
    combatLoraStrength: process.env.RH_COMBAT_LORA_STRENGTH || '0.5',
    refImageSize: process.env.RH_REF_IMAGE_SIZE || 'match',
    // 出片采样参数（工作流契约）：调画质 / 换工作流改这里，不改路由代码。
    sampling: {
      firstPassSteps: Math.max(1, Number(process.env.VIDEO_FIRST_PASS_STEPS) || 6),
      firstPassDenoise: Number(process.env.VIDEO_FIRST_PASS_DENOISE ?? 1),
      secondPassSteps: Math.max(1, Number(process.env.VIDEO_SECOND_PASS_STEPS) || 4),
      secondPassDenoise: Number(process.env.VIDEO_SECOND_PASS_DENOISE ?? 0.4),
      upscaleMegapixels: Number(process.env.VIDEO_UPSCALE_MEGAPIXELS) || 1,
      // 无需二次采样时的收尾参数（保持工作流最小改动）
      tailSecondPassSteps: Math.max(1, Number(process.env.VIDEO_TAIL_SECOND_PASS_STEPS) || 1),
      tailSecondPassDenoise: Number(process.env.VIDEO_TAIL_SECOND_PASS_DENOISE ?? 0.01),
    },
    // ── IMD（分镜多模态提示词）清洗规则 ────────────────────────────────
    // 平台通用口径：默认【全空 = 不做任何清洗】。
    // 此前代码里写死了一份某一部剧角色外观的专属禁词表（已移除）——
    // 换一部剧会把合法特征（服饰、体型、性别）静默删掉。
    // 某项目确需禁词时用 env 配置，平台主流程不内置任何剧集专属词表。
    integrated: {
      // 命中的从句（"@X, exactly as shown, …"）整段剔除；逗号分隔英文片段
      prohibitedHints: String(process.env.INTEGRATED_PROHIBITED_HINTS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      // 无条件剔除的从句正则；用 || 分隔多条，留空即不剔除
      stripClausePatterns: String(process.env.INTEGRATED_STRIP_CLAUSE_PATTERNS || '')
        .split('||')
        .map((s) => s.trim())
        .filter(Boolean),
    },
    // 打斗 idea 模板属【工作流契约】，平台默认值不内置任何具体剧/具体角色的触发词
    //（"开头先输出 XX 这个词"这类触发词是某一部剧的产物，会污染任意新剧的打斗出片）。
    // 需要特定触发词时用 RH_COMBAT_IDEA_TEMPLATE 覆盖，主流程不写死。
    combatIdeaTemplate:
      process.env.RH_COMBAT_IDEA_TEMPLATE
      || '根据图像识别适合他的酷炫感和节奏感。需要节奏快，有蓄力和快慢的节奏。\n个人想法输入：',
    combatCameraLock:
      process.env.RH_COMBAT_CAMERA_LOCK
      || '全程侧面机位拍摄，镜头与战斗双方连线平行，禁止角色转向镜头或冲向镜头方向移动，禁止面向镜头挥拳。',
  },

  asset: {
    maxRefs: Math.max(1, Number(process.env.ASSET_MAX_REFS) || 4),
  },

  ipRouter: {
    highConfidenceScore: Number(process.env.IP_ROUTER_HIGH_SCORE ?? 4),
    scoreIpName: Number(process.env.IP_ROUTER_SCORE_IP ?? 3),
    scoreCharacter: Number(process.env.IP_ROUTER_SCORE_CHAR ?? 2),
    scoreAlias: Number(process.env.IP_ROUTER_SCORE_ALIAS ?? 1),
    scoreMultiCharacter: Number(process.env.IP_ROUTER_SCORE_MULTI ?? 2),
    scoreBoundIp: Number(process.env.IP_ROUTER_SCORE_BOUND ?? 2),
    enableLlm: process.env.IP_ROUTER_ENABLE_LLM !== '0',
  },

  security: {
    downloadAllowHosts: String(process.env.DOWNLOAD_ALLOW_HOSTS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  },
}
