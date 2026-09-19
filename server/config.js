// 后端配置
// 敏感信息从环境变量读取，没有则用默认值（开发用）
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

const serverDir = path.dirname(fileURLToPath(import.meta.url))

// 无论从项目根目录还是 server 目录启动，都固定读取 server/.env。
// dotenv 默认只查找当前工作目录，容易导致从项目根目录启动时漏读密钥。
dotenv.config({ path: path.join(serverDir, '.env') })

export const config = {
  port: process.env.PORT || 3000,

  // 文本大模型（兼容 OpenAI 格式：阿里云百炼 / 智谱等，按 .env 配置切换）
  llm: {
    apiKey: process.env.ZHIPU_API_KEY || process.env.DASHSCOPE_API_KEY || '',
    baseURL: process.env.LLM_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: process.env.LLM_MODEL || 'glm-5.2', // glm-5.2 / qwen-plus / qwen-turbo / qwen3.7-plus
    // 轻量模型（2026-09-15 分级调度）：翻译/格式化类直给任务专用（h3-prompt-translate / style-prompt-en），
    // 创作类任务（分镜/enrich/剧本）仍走主模型。置空字符串 = 关闭分级、全部走主模型。
    // 同 vlmModel 教训：必须用 ?? 不用 ||，env 显式空串要如实透传。
    lightModel: process.env.LLM_LIGHT_MODEL ?? 'qwen3.8-flash',
    // 观片闸视觉模型（shotReview.js）：qwen3.8 主系原生吃图（image_url content）。
    // 2026-09-12 实测：专用 VL 系（qwen-vl-plus / qwen3-vl-flash / qwen3-vl-30b-a3b）
    // 全部 403"Free quota exhausted"（账户仅免费额度模式且 VL 免费额度耗尽），
    // 而 qwen3.8-flash/max 走图像输入 HTTP 200 且准确识别画面。回声与响应侧
    // doubao.chatCompletion 均兼容数组 content。置空字符串 = 显式关闭观片闸。
    // ⚠️ 必须用 ?? 不能用 ||（2026-09-13 修正）：env 显式设为空串时，|| 会 fallback 到
    //    默认值，导致"置空即关闭"这行注释从未生效过——观片闸根本关不掉。?? 只在
    //    env 完全未定义时才取默认值，空串会如实透传（启动自检会提示观片闸已关闭）。
    vlmModel: process.env.LLM_VLM_MODEL ?? 'qwen3.8-flash',
    // LLM 并发闸门上限（信号量）：批量生图/生视频时多个请求并发易触发 429，用计数信号量削峰。
    // 集中在此（原为 doubao.js 顶部散读 process.env），env LLM_MAX_CONCURRENT 可覆盖。
    maxConcurrent: Math.max(1, Number(process.env.LLM_MAX_CONCURRENT) || 6),
  },

  // 分镜流程集中配置（2026-09-15）：所有开关 / 并发数 / 重试数统一在此读取，
  // 业务代码只读 config、不再散读 process.env——避免同一参数在 N 处各写一份默认值。
  // 全部可由 server/.env 覆盖；默认值 = 当前生效行为（改默认值只动这里）。
  storyboard: {
    // 两阶段并行分场生成（阶段1 全场并行 + 阶段2 Airlock 衔接修补）；false 回退旧串行接力
    parallel: process.env.STORYBOARD_PARALLEL !== '0',
    // 阶段3 越轴自动修补（检出侧位翻转无走位 → 自动补模块4 走位）；false 则只检出不改写
    fixAxis: process.env.STORYBOARD_FIX_AXIS !== '0',
    // 补全提示词的 worker 池并发数（镜头间零依赖）
    enrichConcurrency: Math.max(1, Number(process.env.ENRICH_CONCURRENCY) || 4),
    // 分镜图 VLM 出图即验收（硬伤检出）；frameReviewRetry = 不合格自动重抽次数
    frameReview: process.env.FRAME_REVIEW !== '0',
    frameReviewRetry: Math.max(0, Number(process.env.FRAME_REVIEW_RETRY ?? 1)),
    // 场景图 VLM 内容质检（A4/A5，2026-09-17）：核对「要素清单/共有环境/机位/布局结构」有没有真画出来。
    // 与 frameReview 是两件事：那个只看废图硬伤（畸形/崩脸），这个看内容符不符合剧本。
    // 默认关（false）：它要对每张场景图多花一次 VLM 调用，且失败会触发付费重抽——
    // 让布哥在真实项目上主动开启验证，而不是被默认值悄悄扣费。env SCENE_REVIEW=1 启用。
    sceneReview: process.env.SCENE_REVIEW === '1',
    // 不合格时的自动重抽次数（0 = 只检出、告警、不重抽）。与 frameReviewRetry 同口径。
    sceneReviewRetry: Math.max(0, Number(process.env.SCENE_REVIEW_RETRY ?? 1)),
    // 轻任务分级：命中的 task 走轻量模型（逗号分隔；env LLM_LIGHT_TASKS 增删，置空=关闭分级）
    // lighting-check（2026-09-18）：场景「描述 ↔ 光影常量」冷暖自洽判定。典型轻量语义判断题——
    //   输入两段短文本、只输出一个闭集结论，不需要创作能力，走轻量模型即可（快 3~5 倍、成本低一个量级）。
    // 修补类改写（2026-09-19）：storyboard-airlock / storyboard-axis / storyboard-geography 是
    //   机械式局部改写（补一句衔接/走位/侧位），不需要创作能力，且**失败可降级**。
    //   用主模型跑这些轻任务要 60s+/次，14 个并行排队等 6 个并发槽位 → 每次都在"最后一处"卡住；
    //   轻量模型单次约 3.5s，全部跑完只要十几秒——这是"反复卡在 N-1/N"的根治，硬上限只是兜底。
    lightTasks: (process.env.LLM_LIGHT_TASKS ?? 'h3-prompt-translate,style-prompt-en,lighting-check,storyboard-airlock,storyboard-axis,storyboard-geography')
      .split(',').map((s) => s.trim()).filter(Boolean),
    // 镜头时长数据层允许范围（秒）：与 ai/storyboardValidator.js 的 DURATION_MIN/MAX 同源。
    // 校验器从配置读，QC 面板与时长编辑控件也从这里读——改口径只动这一处。
    durationMin: Math.max(1, Number(process.env.SHOT_DURATION_MIN) || 4),
    durationMax: Math.max(1, Number(process.env.SHOT_DURATION_MAX) || 15),
    // 台词语速上限（字/秒，2026-09-16 声音节奏质检）：中文配音自然语速约 4-5 字/秒，
    // 超过 = 配音赶（TTS 加速不自然）或台词溢出到下一镜（破坏 Airlock 首帧对位）。
    // 只数中英文与数字，标点不念不算字。儿童向内容（一二布布）宁可慢，默认给 5。
    speechRateMaxCharsPerSec: Math.max(1, Number(process.env.DIALOGUE_SPEECH_RATE_MAX) || 5),
    // 低于该字数的台词不参与语速检查（"嗯""快跑"这类语气词本来就能急促念出）。
    speechRateMinChars: Math.max(1, Number(process.env.DIALOGUE_SPEECH_RATE_MIN_CHARS) || 3),
    // 长镜薄提示词（2026-09-16 镜头语言质检）：时长 ≥ longShotMinSec 且提示词有效字数
    // < thinPromptChars → 长镜没有足够的过程性描述撑住时长。8s/80字 是"明显缺过程"的
    // 保守线（正常补全后的提示词 300-800 字），宁可漏报不误报。
    longShotMinSec: Math.max(1, Number(process.env.LONG_SHOT_MIN_SEC) || 8),
    thinPromptChars: Math.max(1, Number(process.env.THIN_PROMPT_CHARS) || 80),
    // 质检面板（2026-09-16）：分镜页「质检」面板单次最多返回的问题条数（防超大集拖垮前端）
    qcPanelLimit: Math.max(50, Number(process.env.QC_PANEL_LIMIT) || 2000),
    // 一键修复动作的单次批量上限（防误点把整个 LLM 额度打光）
    qcFixBatchLimit: Math.max(1, Number(process.env.QC_FIX_BATCH_LIMIT) || 20),
    // 越轴修补闭环复检（2026-09-16）：补完走位后回头再验一次，未修好的降级为 warning 明示
    axisVerify: process.env.STORYBOARD_AXIS_VERIFY !== '0',

    // ===== 七层美学心法 P0（2026-09-18 分镜规则重构）=====
    // 背景：第1集42镜真实数据验证——旧 MULTI_BEAT_SUSPECT 纯靠连接词，模型不用连接词
    // 也能塞多拍（"她看见熊，缩肩，转头就跑"），13条真实多拍旧规则零报。
    // 一镜一任务（L1）：去台词后肢体动作动词+角色切换+连接词三信号，任一触发即报。
    multiBeatActionThreshold: Math.max(1, Number(process.env.MULTI_BEAT_ACTION_THRESHOLD) || 4),
    multiBeatActionWithConnector: Math.max(1, Number(process.env.MULTI_BEAT_ACTION_WITH_CONNECTOR) || 3),
    multiBeatConnectorThreshold: Math.max(1, Number(process.env.MULTI_BEAT_CONNECTOR_THRESHOLD) || 3),
    // 接缝（L6 切镜收益）：相邻同场镜 finalFrame 词袋 Jaccard > 阈值 且下镜无台词豁免
    // → 这一刀可能没挣到叙事收益，建议合并走一镜流。弱信号告警由人判。
    // 阈值 0.4：第1集 8-4→8-5(0.425) 真合并候选能进；宁可多抓不漏报，LLM 第二层精判留 P1。
    cutGainJaccardThreshold: Number(process.env.CUT_GAIN_JACCARD_THRESHOLD) || 0.4,
    // L6 是否启用 LLM 第二层精判（P1 增强，默认关）：开则 Jaccard 粗筛可疑池过轻量 LLM 判
    cutGainLlmVerify: process.env.CUT_GAIN_LLM_VERIFY === '1',
    // L6 结构性收益二次筛选：默认开启。画面相似但下镜出现新危险/发现/状态变化时，不报 CUT_WITHOUT_GAIN。
    cutGainStructuralCheck: process.env.CUT_GAIN_STRUCTURAL_CHECK !== '0',
    // 视角（L4 反应镜）：本镜 A 对 B 说话（画面或台词 text 提到 B），下一镜 B 既不在画面
    // 也没台词 → 缺反应镜。弱信号告警由人判（偷看/暗恋场景有意不对位不抓——判据只看对戏）。
    reactionShotEnabled: process.env.REACTION_SHOT_CHECK !== '0',
    // ===== 七层美学心法 P2（2026-09-18）：L2 光线 / L3 结尾留白 / L5 运镜 / L7 声弧 =====
    // 判据先经 scripts/verify_p2_checks.py 在第1集 42 镜真实数据调准（3 条真告警、0 误报）再落地。
    // 节奏（L3 结尾留白）：结尾镜时长 < 全片平均×本值 → ENDING_RUSHED。
    // 阈值 1.3：第1集 8-5 结尾镜 6s < 平均 6.1s×1.3=7.9s，压轴镜仓促（真问题）能抓到。
    endingRushedRatio: Number(process.env.ENDING_RUSHED_RATIO) || 1.3,
    // 主体锁（L2 光线一致性）：同场相邻镜光线方向 left↔right / 色温 warm↔cool 跳变 → LIGHT_DIRECTION_FLIP。
    // 弱信号告警由人判（开场镜 mod1 带风格声明、连续镜是继承模板，提取源不对称时人工排除）。
    lightFlipEnabled: process.env.LIGHT_FLIP_CHECK !== '0',
    // 运镜（L5）：一镜一主运镜（static 不计）→ MULTI_CAMERA_MOVE；
    // 主体强发力动作（扑/跃/撞飞等）+ 固定运镜 → ACTION_CAMERA_MISMATCH。词表严格收紧，不收中等/环境动作。
    cameraMoveCheckEnabled: process.env.CAMERA_MOVE_CHECK !== '0',
    // 声弧（L7a）：相邻同场镜音乐情绪 calm↔intense 硬跳变，且无剧情转折、无音乐变化意图 → SOUND_ARC_BREAK。
    // 双豁免：description 转折词 + music 文本变化类词（渐/骤/转折/柔和下来…）。第1集 5 条候选全是有意设计，豁免后 0 误报。
    soundArcEnabled: process.env.SOUND_ARC_CHECK !== '0',
    // 留白（L7b）：description 含情绪低点词（静静/沉默/怔住…）但本镜有台词/音乐 → SILENCE_GAP。防御性判据。
    silenceGapEnabled: process.env.SILENCE_GAP_CHECK !== '0',
    // ===== 第四轮美学级（2026-09-19）=====
    // 因果链超载：单镜 ≥3 主体 + 因果词 + ≥4 动作 → CHAIN_REACTION_OVERLOAD。实测抓 34镜 3-3（起跳→冰歪→熊换脚→冰被拖走）。
    chainReactionCheckEnabled: process.env.CHAIN_REACTION_CHECK !== '0',
    // 死画面长镜：≥本秒数 + 远/全景 + 固定机位 + 无台词 → EMPTY_LONG_SHOT。防御性判据（当前34镜 0 条）。
    // 两层豁免：音乐名分（music 写明渐弱/骤停等过渡意图）与结尾镜（结尾留白归 L3 节奏曲线管，鼓励长镜余韵，不在此打）。
    emptyLongShotEnabled: process.env.EMPTY_LONG_SHOT_CHECK !== '0',
    emptyLongShotMinSec: Number(process.env.EMPTY_LONG_SHOT_MIN_SEC) || 8,
    // 音乐语言漂移：单镜音乐文本主语言与全片主流不一致 → MUSIC_LANGUAGE_INCONSISTENT。实测抓 34镜 5-1（英文）。
    musicLangCheckEnabled: process.env.MUSIC_LANG_CHECK !== '0',
    // 开场钩子慢：前两镜无冲突词 + 无台词 + 总时长 > 本秒数 → OPENING_HOOK_SLOW。实测 34镜 1-1+1-2=14s 命中。
    // 注意：prompt 层要求"3秒建冲突/禁纯氛围>4秒"是生成期硬约束（卡第一镜内部结构）；此处 10s 是验收期弱信号（卡前两镜合计节奏）。
    // 生成严、验收宽，两层阈值不同属刻意设计，不要为对齐而改小本值——改小会误报有设计意图的开场。
    openingHookCheckEnabled: process.env.OPENING_HOOK_CHECK !== '0',
    openingHookMaxSec: Number(process.env.OPENING_HOOK_MAX_SEC) || 10,
    // ===== 第五轮 纪律级（2026-09-19）切点重复 + 动作密度 + 属性分布 =====
    // 定位：前三轮解决"生成期该怎么写"，这一轮是"生成结果的纪律体检"——三条都是纯机械判据，
    // 不依赖模型自觉，重提后照清单过一遍即可，不必每版都从头用肉眼扫。
    // 切点动作重复：上镜末帧正在做的动作，被下镜描述又从零做一遍 → CUT_ACTION_OVERLAP。
    // 实测抓 37镜 2-1→2-2（上镜"踩上第一块桥板" + 下镜"踩上桥板" = 同一动作陈述两遍）。
    cutActionOverlapCheckEnabled: process.env.CUT_ACTION_OVERLAP_CHECK !== '0',
    // 动作密度：肢体动作数 ÷ 时长 > 本值 → ACTION_DENSITY_HIGH。实测 37镜 2-3（6s 装 6 个动作 = 1.0）。
    actionDensityCheckEnabled: process.env.ACTION_DENSITY_CHECK !== '0',
    actionDensityMax: Number(process.env.ACTION_DENSITY_MAX) || 0.6,
    // 属性分布单调：单一机位朝向/景别/运镜占比超上限 → SHOT_ATTRIBUTE_MONOTONE（集级，每类最多 1 条）。
    // 实测 37镜 侧面 49%、跟拍 38% 命中。阈值取电影常见配比的宽松上限，避免把正常配比报成问题。
    attrMonotoneCheckEnabled: process.env.ATTR_MONOTONE_CHECK !== '0',
    attrMonotoneAngleMax: Number(process.env.ATTR_MONOTONE_ANGLE_MAX) || 0.45,
    attrMonotoneShotTypeMax: Number(process.env.ATTR_MONOTONE_SHOTTYPE_MAX) || 0.4,
    attrMonotoneMoveMax: Number(process.env.ATTR_MONOTONE_MOVE_MAX) || 0.3,
  },

  // 资产物理状态机制（P2'，2026-09-17）：同一物体跨镜的物理状态（完好/破损…）一致性。
  // 关闭时（ASSET_STATE=0）全部资产走默认态，产物与改造前**逐字节一致**（= 优雅降级承诺）。
  // 业务代码只读 config.assetState.enabled，禁止散读 process.env（铁律：开关单点）。
  assetState: {
    // 默认开（对齐 storyboard 各开关风格）；env ASSET_STATE=0 关闭。
    enabled: process.env.ASSET_STATE !== '0',
  },

  // 长任务进度总线（2026-09-16）：进度是内存态的瞬时数据，不落库。
  // 全部阈值集中在此——原为 ai/progressBus.js 内的散落常量，改口径要翻代码。
  progress: {
    // 终态保活时长：任务结束后进度保留多久（毫秒）。
    // 必须大于前端轮询间隔，否则前端会在"任务结束"与"定时器停止"之间读到空进度，
    // 表现为进度条闪一下就消失。前端间隔见 src/constants/app.js 的 STORYBOARD_PROGRESS_POLL_MS。
    ttlAfterDoneMs: Math.max(1000, Number(process.env.PROGRESS_TTL_AFTER_DONE_MS) || 30_000),
    // 活跃任务的兜底过期：超过此时长没更新视为僵尸（进程被 kill / 忘标终态），可被清理。
    // 给得宽松，避免误杀正常长跑任务（分镜+补全全流程可达十几分钟）。
    staleActiveMs: Math.max(60_000, Number(process.env.PROGRESS_STALE_ACTIVE_MS) || 30 * 60 * 1000),
    // 内存表条目上限：超过则淘汰最旧的终态项（活跃项永不淘汰，保护正在跑的任务）。
    maxEntries: Math.max(10, Number(process.env.PROGRESS_MAX_ENTRIES) || 200),
  },

  // RunningHub
  runninghub: {
    apiKey: process.env.RUNNINGHUB_API_KEY || '',
    baseURL: 'https://www.runninghub.cn',
    workflows: {
      imageGenerator: '2092078813630001153', // 文生图（z_image_turbo）
      storyboardGenerator: '2092895275319910402', // 分镜图工作流（多图生图 Qwen-Image）
      // 网格拼图分镜工作流（v2：1~9 张资产拼网格单图入口 + LLM 逐格说明）
      // 导入《多图拼图 分镜_v2.json》跑通后填 workflowId；留空则走 storyboardGenerator 两槽老路线
      frameGridGenerator: process.env.RH_FRAME_GRID_WORKFLOW_ID || '',
      // 单镜 2x2 四宫格分镜图（RunningHub AI 应用版，4 格 = 同一镜头 4 个时间瞬间）：
      // 分镜页切到 RunningHub 后，镜头行"出四宫格"按钮走此 AI 应用。
      // 2026-09-09 弃用旧低价渠道 workflow 2095734156394323970（5 参考槽 + #79 布局模板；
      //   .env 旧变量 RH_SHOT_GRID_WORKFLOW_ID 保留可回滚），切到 AI 应用 2048139846660657154：
      //   输入 4 参考图槽（nodeId 2/8/9/10 = 图1~图4）+ 剧情文本（nodeId 13）
      //   + aspectRatio/resolution（nodeId 14），输出整张 2x2 网格图。
      //   节点映射见 nodeMap.shotGridApp（按布哥提供的 AI 应用 API 文档核对）。
      shotGridApp: process.env.RH_SHOT_GRID_APP_ID || '2048139846660657154',
      // 单镜出片（MinimaxH3 八月最强打斗武戏 workflow）：
      // 打斗专用：3 个战斗 LoRA（武术物理 wushu_spatial_physics / 战斗 H3_Combat / 兔兔武器 Bunny_weapon_combat）
      // 固化在工作流内，由豆包 doubao-seed 看图生成电影级打斗提示词 + two-pass 两轮采样。
      // 仅 1 张参考图 + idea 打斗设定，无音频/视频槽（纯动作镜头）。
      // 2026-09-09 接入；节点映射见 nodeMap.h3Combat（按《八月最强打斗武戏_api.json》连线核对）。
      h3Combat: process.env.RH_H3_COMBAT_WORKFLOW_ID || '2094872667374571522',
      // 单镜出片（MiniMax H3 全能生视频 V4 workflow）：
      // 9 参考图槽 + 3 音色槽 + Ref2VA 结构化 prompt（subject_definitions + <d>[Chinese] 台词</d>）
      // + H3_Combat_V2(0.5 固化) + ref2v turbo + 一采→二采放大。无提示词优化器，prompt 必须手工 Ref2VA。
      // 2026-09-09 接入；节点映射见 nodeMap.h3V4（按《4-MiniMaxh-H3-全能生视频工作流-V4 (分享).json》连线核对）。
      h3V4: process.env.RH_H3_V4_WORKFLOW_ID || '2097709786870673409',
      // 单镜出片（h3V4 的 Motion Context 续镜版，fc 成片回喂，音频连贯 #1，2026-09-11 落地）：
      // h3V4 全链 + 四件套（LoadVideo #2001 → GetVideoComponents #2002 →
      // MiniMaxH3MotionContext #2003(22/24) → Trim #2004(match_tail)），上一镜成片经
      // context_frames/context_audio 锚定接缝（latent 跨 API 任务被 RH 容器隔离判死，
      // 见 AGENTS.md 音频连贯段）。上传《4-MiniMaxh-H3-V4-全槽-MC-fc续镜版.json》后填 ID。
      h3V4mc: process.env.RH_H3_V4_MC_WORKFLOW_ID || '',
    },
    // Motion Context fc 接龙总开关（音频连贯 #1，2026-09-11 落地）：开启后 v4 续镜出片
    // 自动反查上一镜成片走 h3V4mc；单镜请求可用 useMotionContext: true/false 显式覆盖。
    // 验收期先保持 false，用单镜 useMotionContext: true 实测接缝质量后再开。
    motionContext: {
      enabled: process.env.RH_MOTION_CONTEXT_ENABLED === 'true',
    },
    // 打斗出片（h3Combat）轮询超时：豆包 + 3 LoRA + two-pass 两轮采样整体耗时长，给 60 分钟。
    // 集中在此（原为 combatVideo.js 散读 process.env），env RH_H3_COMBAT_TIMEOUT_MS 可覆盖。
    h3CombatTimeoutMs: Number(process.env.RH_H3_COMBAT_TIMEOUT_MS) || 60 * 60 * 1000,
    // 单镜四宫格 AI 应用出图参数（每次调用覆盖线上应用默认值，保证与项目出片比例一致）。
    // 比例：'9:16'（竖版短剧，2026-09-11 起与项目级默认统一）| '16:9'（横版）；
    // 注意：前端每次出四宫格都会显式传 projects.aspect_ratio 覆盖这里，本值只是无请求级参数时的兜底。
    // 分辨率：'1k' 高效 | '2k' 均衡 | '4k' 高质
    shotGrid: {
      aspectRatio: process.env.RH_SHOT_GRID_ASPECT_RATIO || '9:16',
      resolution: process.env.RH_SHOT_GRID_RESOLUTION || '1k',
    },
    // 工作流节点映射
    nodeMap: {
      imageGenerator: {
        prompt: { nodeId: '17', fieldName: 'prompt' },
      },
      storyboardGenerator: {
        // 多图生图工作流（Qwen-Image，经工作流 JSON 确认）
        // v2 接口：Bearer 鉴权 + /openapi/v2/run/workflow/{id} + /openapi/v2/query
        // node 22 = LoadImage（image）：参考图1（角色图）
        // node 30 = LoadImage（image）：参考图2（场景图）
        // node 1  = TextEncodeQwenImageEditPlusAdvance（prompt）：正面提示词
        // node 13 = TextEncodeQwenImageEditPlus（prompt）：负面提示词
        // node 27 = RH_LLMAPI_NODE（api_baseurl/api_key/model）：LLM 节点配置（必须配置，否则工作流失败）
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
        // 三槽分镜工作流（v3：角色 / 场景 / 道具 各一个原生参考槽）
        // 导入《多图三槽分镜_v3.json》到 RunningHub 并手动跑通一次后，
        // 把 workflowId 填到 workflows.frameGridGenerator（或 .env RH_FRAME_GRID_WORKFLOW_ID）。
        // 未配置时 frame 路由自动回落 storyboardGenerator 两槽老路线。
        apiVersion: 'v2',
        kind: 'workflow',
        instanceType: 'default',
        image1: { nodeId: '22', fieldName: 'image' },          // 角色设定集合图
        image2: { nodeId: '30', fieldName: 'image' },          // 场景图
        image3: { nodeId: '31', fieldName: 'image' },          // 道具设定集合图
        userPrompt: { nodeId: '24', fieldName: 'text' },       // 槽位说明 + 本镜头需求
        target_vl_size: { nodeId: '1', fieldName: 'target_vl_size' },
        llmApiBaseUrl: { nodeId: '27', fieldName: 'api_baseurl' },
        llmApiKey: { nodeId: '27', fieldName: 'api_key' },
        llmModel: { nodeId: '27', fieldName: 'model' },
      },
      shotGridApp: {
        // 单镜 2x2 四宫格分镜图（RunningHub AI 应用 2048139846660657154，2026-09-09 接入）
        // 弃用旧 5 槽 workflow（2095734156394323970）的原因与结构差异见 workflows.shotGridApp 注释。
        // 节点结构以布哥提供的 AI 应用 API 文档为准：
        //   #2 / #8 / #9 / #10 LoadImage(image) = 参考图 1..4：通用资源池，无固定资产类型语义，
        //     由 allocateShotRefs（directorRequest.js）按优先级（出场角色 > 场景 > 道具）动态分配
        //     slot 1..4，rhShotGrid 按 refs[].slot 填 values['image'+slot]（即"图N"）。
        //     与旧版不同：不再要求补位填满空槽——空槽直接不上传（fill=false），靠 prompt 文本兜底。
        //   #13 CR Text(prompt) = 剧情/分镜文本：第一行"图N是X"声明参考身份 + 画风/设定/画面1..4
        //     （buildShotGridContentApp 产出，措辞贴近 app 示例"图1是女主、图2是男生、图3是海滩…"）。
        //   #14 出图节点：aspectRatio / resolution（枚举与 app 一致：16:9/9:16…，1k/2k/4k）。
        // 输出：整张 2x2 网格图（results[].url，由调用方落盘为该镜 frame_url）。
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
      h3Combat: {
        // MiniMax H3 八月最强打斗武戏 workflow（RunningHub 2094872667374571522，2026-09-09 接入）
        // 打斗专用：3 战斗 LoRA 固化在工作流内 + 豆包 doubao-seed-2-0-pro 看图生成电影级打斗提示词
        // + two-pass 两轮采样（一轮 8 步出动作骨架 + H3 Sigma Refiner 精修）。
        // 结构（按《八月最强打斗武戏_api.json》连线核对）：
        //   #526 LoadImage → 参考图（唯一图片输入；经 #482 缩放后喂豆包 #557 识别 + H3 #338 ref_image_0）
        //   #528 CR Prompt Text → 豆包输入模板（"…个人想法输入：" 后缀由业务侧拼接打斗设定）
        //   #557 RH_LLMAPI_Pro_Node → 豆包 doubao-seed-2-0-pro 生成最终打斗提示词 → #558 → #338.prompt
        //   #551 UNET(hybrid_fl2va_ref2va) → #554 wushu@0.3 → #552 Combat@0.75 → #560 Bunny@0.7 → #553 turbo@1.0
        //   #529 PrimitiveFloat(value) → 时长秒（#457 表达式转 length 帧数）
        //   #456 ResolutionSelector → aspect_ratio / megapixels
        // 无音频/视频槽：纯动作镜头（打斗通常无对白，音效后期混）。v2 接口 Bearer + /openapi/v2/run/workflow/{id}
        apiVersion: 'v2',
        kind: 'workflow',
        instanceType: 'default',
        image1: { nodeId: '526', fieldName: 'image' },
        idea: { nodeId: '528', fieldName: 'prompt' },
        duration: { nodeId: '529', fieldName: 'value' },
        aspectRatio: { nodeId: '456', fieldName: 'aspect_ratio' },
        megapixels: { nodeId: '456', fieldName: 'megapixels' },
      },
      h3V4: {
        // MiniMax H3 全能生视频 V4（ComfyUI 导入版，2026-09-09 核对连线）：
        //   #1400 PrimitiveStringMultiline → #1393.prompt（Ref2VA 结构化格式）；该节点字段名是 value（非 text）
        //   9 参考图：ref_image_0←1399, 1←1395, 2←1394, 3←1398, 4←1397, 5←1396, 6←1401, 7←1403, 8←1402
        //   3 音色：ref_audio_0←1404, 1←1406, 2←1405
        //   #1412 PrimitiveFloat(秒) → #1411 ComfyMathExpression → #1393.length
        //   #1410 ResolutionSelector → #1393.width/height
        //   #1414 H3_Combat_V2(0.5) + #1299 ref2v turbo(1.0) 固化；输出 #245 VHS_VideoCombine
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
        // 打斗 LoRA 文件名：本地导出时带了 minimax_h3\ 子目录前缀，云端扁平命名不带前缀，
        // 运行时覆盖成云端真实名 H3_Combat_V2.safetensors（对照《八月最强打斗武戏_api.json》）。
        combatLora: { nodeId: '1414', fieldName: 'lora_name' },
        // 打斗 LoRA 强度：武戏 0.5（沿用工作流固化值），文戏 0（等效不加载打斗 LoRA）。
        combatLoraStrength: { nodeId: '1414', fieldName: 'strength_model' },
        // UNET 主模型：本地导出带了 MiniMax-H3\ 子目录前缀，云端扁平命名为 Minimax-h3_Singularity_ref2va_Pruned_v1.3_int8
        unetName: { nodeId: '1380', fieldName: 'unet_name' },
        // ---- 采样层（动态步数/降噪，用于文戏降本、武戏精修）----
        //   #124  BasicScheduler widgets=["simple",6,1]  → 一采（6 步 / denoise 1.0）
        //   #1329 BasicScheduler widgets=["beta",4,0.4]  → 二采（4 步 / denoise 0.4）
        //   #1407 PrimitiveFloat(值1) → #1317 MinimaxH3LatentUpscaler3D.mode.megapixels（二采目标分辨率）
        firstPassSteps: { nodeId: '124', fieldName: 'steps' },
        firstPassDenoise: { nodeId: '124', fieldName: 'denoise' },
        secondPassSteps: { nodeId: '1329', fieldName: 'steps' },
        secondPassDenoise: { nodeId: '1329', fieldName: 'denoise' },
        upscaleMegapixels: { nodeId: '1407', fieldName: 'value' },
        // 随机种子：#129 RandomNoise（导出件里 seed 控件为 randomize 模式 → 每次云端随机，
        // 这就是同 prompt 重跑构图漂移的来源；该控件 ue_connectable，可经 API 覆盖）。
        // 传固定 seed = 锁种子：同 seed 下微调 prompt 重跑，构图骨架基本不变，
        // 用于「保住满意构图、精修局部描述」的跨镜连贯性微调。不传则维持 randomize。
        seed: { nodeId: '129', fieldName: 'noise_seed' },
      },
      // h3V4mc（Motion Context 续镜版）= h3V4 全槽映射 + video 槽：
      //   上一镜成片 → LoadVideo #2001，字段名是 'file' 而非 'video'
      //   （create 实测报 NODE_INFO_MISMATCH，ComfyUI 核心 LoadVideo 字段为 file，见 AGENTS.md 音频连贯段）。
      get h3V4mc() {
        return { ...this.h3V4, video: { nodeId: '2001', fieldName: 'file' } }
      },
    },
  },

  // 生图引擎：纯文生图默认走 ZIKL 生图站（gpt-image-2），可切回 RunningHub 工作流，或走 Visionary（gpt-image-2 / Nano Banana）。
  // 分镜图（frame，多图生图、需角色/场景参考图）现在也可走 zikl / visionary；RunningHub  storyboardGenerator 路线已下线。
  image: {
    // 'zikl'（默认，gpt-image-2）| 'runninghub'（imageGenerator 文生图工作流）| 'visionary'
    provider: process.env.IMAGE_PROVIDER || 'zikl',
    zikl: {
      apiKey: process.env.ZIKL_API_KEY || '',
      baseURL: process.env.ZIKL_BASE_URL || 'https://img.zikl.dev',
      model: process.env.ZIKL_IMAGE_MODEL || 'gpt-image-2',
      // 分辨率档位：1K / 2K / 4K / auto（1K 分组最高 1K；4K 分组支持 1K/2K/4K）
      // 注意：该档位仅对文生图（/v1/images/generations）生效；
      // 图生图（/v1/images/edits）按文档要求不传 size（沿用参考图尺寸），见 ziklImage.js ziklEditImage
      size: process.env.ZIKL_IMAGE_SIZE || '1K',
      // 代理地址（集中在此，原为 ziklImage.js 散读 process.env）：
      // EnvHttpProxyAgent 只认进程环境变量，服务若没带 HTTPS_PROXY 启动会退化成直连被墙，
      // 故默认显式固定本机代理端口；'direct' = 跟随环境变量自适应（无变量=直连）。
      proxy: process.env.ZIKL_PROXY || 'http://127.0.0.1:7897',
    },
    // Visionary（https://visionary.beer）：异步任务接口，支持 gpt-image-2 / nano-banana-pro / nano-banana-pro-cl / nano-banana-2-lite
    visionary: {
      apiKey: process.env.VISIONARY_API_KEY || '',
      baseURL: process.env.VISIONARY_BASE_URL || 'https://api.visionary.beer',
      // 结果图下载**兜底**代理（2026-09-16 修正）：主路径是**直连**（insecureDownload，
      // https.get + rejectUnauthorized:false 容忍证书异常）；**只有直连失败**
      // （超时 / ECONNRESET / 证书）才降级走这个代理重试。代理仅兜底，**不作主路径**。
      // ⚠️ 修正此前错误结论：并非"CDN 直连会超时所以必须走代理"——实测直连可用，反而是代理
      // 链路可能不通（TLS 握手前即断开），一旦把代理当主路径会全线 fetch failed / CERT_HAS_EXPIRED。
      // VISIONARY_PROXY 可覆盖，'direct' = 跟随环境变量自适应（无变量=直连）。
      proxy: process.env.VISIONARY_PROXY || process.env.ZIKL_PROXY || 'http://127.0.0.1:7897',
      // 默认模型：可被单次请求 options.model 覆盖
      model: process.env.VISIONARY_IMAGE_MODEL || 'nano-banana-pro',
      // 默认清晰度：1K / 2K / 4K（不同模型支持不同，见 API 文档）
      resolution: process.env.VISIONARY_IMAGE_RESOLUTION || '2K',
      // 默认比例：1:1 / 16:9 / 9:16 等
      size: process.env.VISIONARY_IMAGE_SIZE || '16:9',
      // AI 增强（仅 nano-banana-pro 生效）
      optimizeChineseText: process.env.VISIONARY_OPTIMIZE_CHINESE_TEXT === 'true',
      // 轮询间隔（毫秒），任务返回 retry_after 时会优先使用返回值
      pollIntervalMs: Number(process.env.VISIONARY_POLL_INTERVAL_MS) || 3000,
      // 最大轮询时间（毫秒）
      maxPollMs: Number(process.env.VISIONARY_MAX_POLL_MS) || 600000,
    },
  },

  // 数据库
  db: {
    // 固定到 server 目录，避免从不同工作目录启动时读到错误的空数据库
    path: process.env.DB_PATH || path.join(serverDir, 'data.db'),
  },

  // IP 路由打分参数。全部可由环境变量覆盖，调参不必改业务代码。
  // 改动的唯一理由是"在你的 IP 库规模下分档不准"，不是"换了个 IP"——
  // 换 IP 只需要往 ips / ip_characters 里加数据，这里一个字都不用动。
  ipRouter: {
    // 总分达到该值即判定高置信，直接绑定，不再调用模型
    highConfidenceScore: Number(process.env.IP_ROUTER_HIGH_SCORE ?? 4),
    // 命中 IP 主名 / 别名
    scoreIpName: Number(process.env.IP_ROUTER_SCORE_IP ?? 3),
    // 命中角色本名
    scoreCharacter: Number(process.env.IP_ROUTER_SCORE_CHAR ?? 2),
    // 命中角色别名（比本名低：别名是人补的，可靠性不如本名）
    scoreAlias: Number(process.env.IP_ROUTER_SCORE_ALIAS ?? 1),
    // 一句话同时点到两个以上角色的加成
    scoreMultiCharacter: Number(process.env.IP_ROUTER_SCORE_MULTI ?? 2),
    // 项目已绑定 IP 的先验加成
    scoreBoundIp: Number(process.env.IP_ROUTER_SCORE_BOUND ?? 2),
    // 置为 0 则只走别名层，完全不调模型（省成本 / 离线用）
    enableLlm: process.env.IP_ROUTER_ENABLE_LLM !== '0',
  },

  // 安全相关（2026-09-16）
  security: {
    // 下载出站白名单（SSRF 防护的放行名单）。
    // 默认空 = 只允许能解析到公网地址的 http(s) 目标；
    // 若部署在自建 CDN / 内网对象存储后面，把主机名写进来（逗号分隔，支持子域匹配）。
    // 例：DOWNLOAD_ALLOW_HOSTS=cos.internal.example.com,cdn.mycorp.cn
    downloadAllowHosts: String(process.env.DOWNLOAD_ALLOW_HOSTS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  },
}
