
export const QC_LEVEL = { ERROR: 'error', WARNING: 'warning' }

export const QC_ACTION = {
  AIRLOCK_LINK: 'airlock_link',
  AXIS_REPOSITION: 'axis_reposition',
  REGEN_FRAME: 'regen_frame',
  CAMERA_DIVERSIFY: 'camera_diversify',
  MUSIC_REWRITE: 'music_rewrite',
  DIALOGUE_SHIFT: 'dialogue_shift',
  STYLE_POISON_STRIP: 'style_poison_strip',
  CAMERA_MOVE_UNIFY: 'camera_move_unify',
  ACTION_CAMERA_FIX: 'action_camera_fix',
  MUSIC_TRANSLATE: 'music_translate',
  PROMPT_CONDENSE: 'prompt_condense',
  PROMPT_EXPAND: 'prompt_expand',
  LIGHTING_ALIGN: 'lighting_align',
  ACTION_DEDUPE: 'action_dedupe',
  EMOTION_REFRAME: 'emotion_reframe',
  DIALOGUE_CLAMP: 'dialogue_clamp',
  MANUAL: 'manual',
}

// 规则出处档位：official = H3 官方提示词指南明确规定；industry = 影视/配音行业共识或工程必然；heuristic = 项目经验阈值（误报相对常见）
export const QC_BASIS = {
  OFFICIAL: 'official',
  INDUSTRY: 'industry',
  HEURISTIC: 'heuristic',
}

// 出处白名单映射（未列出的码默认 industry）。依据：H3 官方 prompt-writing guide / 影视工业共识 / 项目实测。
// 只把【官方文档有明文行号出处】的码放进 official 档——审计原则：宁可降级，不可凭记忆标官方。
// 三档判定原则（逐条审计 61 码后确立）：
//   official = 官方文档明文（base-en/ref-en/API 文档，可指行号/页面）；
//   industry = 影视/配音/短剧行业共识或工程必然（无数字阈值或数字有行业出处，如中文语速 3-4 字/秒、180 度轴线、30 度规则）；
//   heuristic = 触发条件含本项目拍的数字阈值（2 环因果、45/40/30 配比、钩子秒数、密度上限、窗口余量等——误报相对常见）。
const QC_BASIS_MAP = {
  official: [
    // 官方明文出处（base-en.txt / ref-en.txt / MiniMax API 文档）：
    'MUSIC_MOOD_WORD',       // base-en.txt §4.7："do not use abstract mood words or explain the emotional function of the score"
    'CUT_WITHOUT_GAIN',     // base-en.txt §4.2："A cut should introduce new information about the subject, space, state, viewpoint, or time"
    'PROMPT_OVER_LIMIT',    // MiniMax 官方 API 文档："Prompt length limit ≤ 7000 characters"（注意：官方未说明超限行为，"静默截断"是项目经验推断）
    'DURATION_OUT_OF_RANGE', // MiniMax 官方 API 文档："duration: An integer from 4 to 15 seconds"；validator 默认 4/15 与官方一致（可 env 覆盖）
  ],
  // 以下从 official 降级（审计发现依据站不住，属行业共识/工程约束，非官方明文）：
  //   MULTI_CAMERA_MOVE（官方 §4.3 只定义三维语法、未规定每镜数量；归一的真实动因是本项目 camera_movement 单值存储，见 doubao.js unifyCameraMove 注释）
  //   DIALOGUE_OVERFLOW / DIALOGUE_SPEED_TIGHT（"超载赶读/截断"是配音行业共识（中文语速约 3-4 字/秒，行业有出处），官方仅有 <cutoff> 工具用法描述）
  heuristic: [
    // —— 触发条件含拍的数字阈值（无行业出处），按统一判定原则归 heuristic ——
    'ACTION_DENSITY_HIGH',     // 动作数÷时长上限：项目经验值（"6s 装 6 个动作"历史实锤支撑机制，但阈值数字无出处）
    'CHAIN_REACTION_OVERLOAD', // "≥2 环"因果上限：项目经验值，无行业出处
    'OPENING_HOOK_SLOW',       // 钩子秒数阈值：项目经验值（"黄金三秒"是营销话术不是可引用标准）
    'SHOT_ATTRIBUTE_MONOTONE', // 机位 45%/景别 40%/运镜 30% 三条配比红线：项目经验值
    'DIALOGUE_WINDOW_TIGHT',   // 台词窗口余量阈值：项目经验值
    'MULTI_BEAT_SUSPECT',       // 一镜一拍理论 + 三信号启发式，阈值未验证
    'SILENCE_GAP',              // 留白创作品味
    'EMPTY_LONG_SHOT',          // 死画面判定经验值
    'LONG_SHOT_THIN_PROMPT',    // 长镜提示词长度经验值
    'ENDING_RUSHED',            // 结尾余韵创作品味
    'DIALOGUE_FLOOR',           // 台词量占比经验值
    'DIALOGUE_DROUGHT',         // 连续无台词经验值
    'GAG_REPEAT',               // 梗重复疲劳经验值
    'NO_FAST_CUT',              // 快切节奏经验值
    'SCENE_DURATION_TEMPLATE',  // 场次时长差异化品味
    'EMOTION_SCENE_STATIC',     // 情绪段动镜品味
    'SCENE_INDEX_MISMATCH',     // 自述"提示不是缺陷"
  ],
}


export const QC_CODES = {
  MUST_FIX: {
    level: QC_LEVEL.ERROR,
    title: '必须修（硬错误）',
    hint: '阻断级问题：字段缺失 / 时间轴断裂 / 画风毒词等。生成流程会把这些错误喂回模型重试',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },

  STYLE_POISON: {
    level: QC_LEVEL.ERROR,
    title: '画风毒词',
    hint: '文本含"写实/CGI/照片级"等风格切换词，出片会把整段拉去另一种画风（历史实锤：8 镜返工）',
    action: QC_ACTION.STYLE_POISON_STRIP,
    fixLabel: '去毒词改写',
  },

  AIRLOCK_SIDE_FLIP: {
    level: QC_LEVEL.WARNING,
    title: 'Airlock 复刻侧位相反',
    hint: 'Airlock 段本应逐字复刻上一镜最终画面，角色侧位却相反——首帧空间直接错位',
    action: QC_ACTION.AIRLOCK_LINK,
    fixLabel: '重做 Airlock 衔接',
  },
  SCREEN_SIDE_FLIP: {
    level: QC_LEVEL.WARNING,
    title: '越轴（侧位凭空翻转）',
    hint: '同一角色相邻镜画面侧位翻转，但本镜动作时间轴没有交代走位——180 度轴线被破坏',
    action: QC_ACTION.AXIS_REPOSITION,
    fixLabel: '补走位动作',
  },
  LOCATION_TELEPORT: {
    level: QC_LEVEL.WARNING,
    title: '位置瞬移',
    hint: '同一角色在相邻镜的"位置载体"（背上/坡顶/平地）凭空变化，本镜没有显式移动动作',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },

  AIRLOCK_CHAR_MISSING: {
    level: QC_LEVEL.WARNING,
    title: 'Airlock 角色消失',
    hint: '上一镜最终画面里的角色，本镜未提及——Airlock 要求复刻上一镜画面，角色不应凭空消失',
    action: QC_ACTION.AIRLOCK_LINK,
    fixLabel: '补 Airlock 衔接',
  },

  ASSET_MISSING_IMAGE: {
    level: QC_LEVEL.WARNING,
    title: '资产缺设定图',
    hint: '关联角色的设定图为空，生图时该资产没有参考图，会被照着别的参考图画错',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },
  SCENE_ASSET_EMPTY: {
    level: QC_LEVEL.WARNING,
    title: '场景锚为空',
    hint: '镜头没挂任何场景资产，出片没有场景参考图，环境与画风会跟着角色参考图漂',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },
  SCENE_ASSET_UNKNOWN: {
    level: QC_LEVEL.WARNING,
    title: '场景锚对不上',
    hint: 'sceneAssets 里的名字在场景资产清单里找不到，按名解析会落空，等同没有场景锚',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },

  COSTUME_TEXT_MISMATCH: {
    level: QC_LEVEL.WARNING,
    title: '图文服装打架',
    hint: '描述提到的服装配饰在角色设定与道具清单里都没有——参考图里也没有，生图会两头摇摆',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },
  CHAR_OVER_REGISTERED: {
    level: QC_LEVEL.WARNING,
    title: '角色多登记',
    hint: 'characters 里登记了角色，但描述/提示词/最终画面都没提到，可能多登记导致多画一个角色',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },
  DURATION_OUT_OF_RANGE: {
    level: QC_LEVEL.WARNING,
    title: '时长越界',
    hint: '镜头时长超出允许范围——MiniMax 官方 API 明文 "duration: An integer from 4 to 15 seconds"，出片端会被 clamp（见 storyboardValidator.DURATION_MIN/MAX，默认 4/15 与官方一致）',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },
  DIALOGUE_TIME_OUT_OF_RANGE: {
    level: QC_LEVEL.WARNING,
    title: '台词时间戳越界',
    hint: '台词 startTime 不在本镜时间范围内，出片换算镜内相对秒为负/超时，时间戳被静默丢弃',
    action: QC_ACTION.DIALOGUE_CLAMP,
    fixLabel: '台词时间戳归位',
  },
  TIMELINE_DISCONTINUITY: {
    level: QC_LEVEL.WARNING,
    title: '时间轴断裂',
    hint: '镜头 startTime 与前镜 endTime 不接，或 endTime-startTime ≠ duration',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },
  SCENE_INDEX_MISMATCH: {
    level: QC_LEVEL.WARNING,
    title: '场次数与场景资产数不一致',
    hint: '提示不是缺陷——多个场次共用同一场景资产是合法的（同一地点）',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },

  EMOTION_SHOT_TOO_WIDE: {
    level: QC_LEVEL.WARNING,
    title: '情绪点景别太远',
    hint: '强情绪台词镜却是全景/远景——情绪点在远景里"指甲盖大"，全片情绪最高点打不出来',
    action: QC_ACTION.EMOTION_REFRAME,
    fixLabel: '景别改近',
  },
  SCENE_SHOTTYPE_FLAT: {
    level: QC_LEVEL.WARNING,
    title: '景别平推',
    hint: '单场 ≥3 镜且景别全同——整场一个景别平推是"动态PPT"的典型特征',
    action: QC_ACTION.CAMERA_DIVERSIFY,
    fixLabel: '按景别模板轮换',
  },
  MULTI_BEAT_SUSPECT: {
    level: QC_LEVEL.WARNING,
    title: '一镜多拍嫌疑',
    hint: '一镜塞了多个叙事节拍（连接词+肢体动作+角色切换三信号触发）——一拍一镜才出电影感，建议拆成多镜靠 Airlock 衔接。历史样本验证：纯连接词版零报，三信号版命中真实多拍',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },
  ADJACENT_SHOT_TOO_SIMILAR: {
    level: QC_LEVEL.WARNING,
    title: '相邻镜过近（跳切）',
    hint: '同主体相邻镜景别+机位朝向+运镜全同（30°规则）——两条几乎相同的提示词出两张几乎相同的图，观众以为画面卡了',
    action: QC_ACTION.CAMERA_DIVERSIFY,
    fixLabel: '拉开相邻机位',
  },
  LONG_SHOT_THIN_PROMPT: {
    level: QC_LEVEL.WARNING,
    title: '长镜薄提示词',
    hint: '长镜配过短提示词——出片要么画面死气（模型不敢发挥）要么自由发挥跑偏，长镜更需要过程性描述撑住时长',
    action: QC_ACTION.PROMPT_EXPAND,
    fixLabel: '扩写过程描写',
  },
  CUT_WITHOUT_GAIN: {
    level: QC_LEVEL.WARNING,
    title: '切镜收益不足',
    hint: '相邻同场镜 finalFrame 画面状态高度重复且本镜无台词、未检测到主体/空间/视角/状态/信息变化——这一刀可能没挣到叙事收益。一镜流实验结论："这一刀有没有挣到叙事收益"是合并判据。若有新危险、新发现、新反应或关系变化，应保留切镜',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },
  REACTION_SHOT_MISSING: {
    level: QC_LEVEL.WARNING,
    title: '缺反应镜',
    hint: '上一镜 A 对 B 说话，但本镜 B 既不在画面也没台词——看与被看不对位，观众会等 B 的反应等不到。请在下一镜补 B 的反应，或调整 B 的在场性',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },

  LIGHT_DIRECTION_FLIP: {
    level: QC_LEVEL.WARNING,
    title: '光线跳变',
    hint: '同场相邻镜光线方向 left↔right 或色温 warm↔cool 跳变——同一场戏光线应一致，跳变会让画面空间错位。若是有意的氛围转换（回忆/幻想/时间推移）可忽略',
    action: QC_ACTION.LIGHTING_ALIGN,
    fixLabel: '对齐光线',
  },
  COMBAT_CLASS_MISMATCH: {
    level: QC_LEVEL.WARNING,
    title: '戏型标记与内容不符',
    hint: '本镜 isCombat 标记与按描述/动作/音效关键词的确定性分类结果冲突。漏判武戏会不加载打斗LoRA、画面调性直接废；误判武戏顶多白加载LoRA。请复核本镜到底是文戏还是武戏（关键词分类也可能误判，如"咬"是吃东西）',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },
  ENDING_RUSHED: {
    level: QC_LEVEL.WARNING,
    title: '结尾仓促',
    hint: '结尾镜时长 < 全片平均×1.3——情绪升华需要余韵，结尾该留白让画面多停一拍（台词结束后画面继续停留，给出余味）',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },
  MULTI_CAMERA_MOVE: {
    level: QC_LEVEL.WARNING,
    title: '一镜多运镜',
    hint: '模块1 声明了多个动态运镜——一镜一主运镜，多运镜拆成多镜或只选一个最强的（static 固定机位不算运镜，不计数）',
    action: QC_ACTION.CAMERA_MOVE_UNIFY,
    fixLabel: '归一运镜',
  },
  ACTION_CAMERA_MISMATCH: {
    level: QC_LEVEL.WARNING,
    title: '动作运镜失配',
    hint: '描述含主体强发力动作（扑/跃/撞飞等）但运镜是"固定"——动作即运镜被违反，大动作在静止画框里会死。建议改为跟拍/环绕/手持晃动配合动作；若发力的是环境而非角色主体可忽略',
    action: QC_ACTION.ACTION_CAMERA_FIX,
    fixLabel: '运镜配动作',
  },
  SOUND_ARC_BREAK: {
    level: QC_LEVEL.WARNING,
    title: '声弧断裂',
    hint: '相邻同场镜音乐情绪 calm↔intense 硬跳变，且无剧情转折、音乐文本也无渐变意图——音乐转折该跟剧情走（加过渡，或在 music 里写明渐变）',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },
  SILENCE_GAP: {
    level: QC_LEVEL.WARNING,
    title: '留白处不安静',
    hint: 'description 含情绪低点词（静静/沉默/怔住等）但本镜有台词/音乐——该留白的地方该安静，让观众听到呼吸/风声',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },

  CHAIN_REACTION_OVERLOAD: {
    level: QC_LEVEL.WARNING,
    title: '因果链超载',
    hint: '单镜内多个主体的连锁因果事件（A动作导致B状态变化≥2环）——出片模型只能演开头。按因果转折点拆镜：前一镜停在「因」，后一镜从「果」开始',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },
  EMPTY_LONG_SHOT: {
    level: QC_LEVEL.WARNING,
    title: '死画面长镜',
    hint: '长镜+远景+固定机位+无台词=空转。长镜要有名分：运镜推进、情绪沉淀或空间揭示，四无死画面禁止',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },
  MUSIC_LANGUAGE_INCONSISTENT: {
    level: QC_LEVEL.WARNING,
    title: '音乐语言漂移',
    hint: '音乐文本语言与全片主流不一致（如全片中文、此镜英文）——音乐描述应全片统一语言，混排会让音乐模型理解不稳定',
    action: QC_ACTION.MUSIC_TRANSLATE,
    fixLabel: '统一音乐语言',
  },
  OPENING_HOOK_SLOW: {
    level: QC_LEVEL.WARNING,
    title: '开场钩子慢',
    hint: '开场两镜无冲突/危险/异常画面且无台词，总时长超标——第一镜应让冲突/悬念与建境同镜完成，或把有信息的台词提前',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },

  CUT_ACTION_OVERLAP: {
    level: QC_LEVEL.WARNING,
    title: '切点动作重复',
    hint: '上一镜最终画面停在某个动作上，本镜描述开头又把它从零做了一遍——同一动作被陈述两遍，观众会看到叙事原地倒带。把上镜末帧收在该动作之前，动作整段让给本镜（历史实锤：相邻镜动作倒带）',
    action: QC_ACTION.ACTION_DEDUPE,
    fixLabel: '去重复动作',
  },
  ACTION_DENSITY_HIGH: {
    level: QC_LEVEL.WARNING,
    title: '动作密度超载',
    hint: '肢体动作数 ÷ 时长超过上限——时长装不下这个动作量，出片模型只能演开头或把手部动作演糊。要么按任务边界拆镜，要么延长时长（历史实锤：6s 装 6 个动作只演开头）',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },
  SHOT_ATTRIBUTE_MONOTONE: {
    level: QC_LEVEL.WARNING,
    title: '拍法分布单调',
    hint: '全片单一机位朝向/景别/运镜占比过高（机位>45% / 景别>40% / 运镜>30%）——侧面连成墙、中景承包全片、推近用到第十次就不叫强调了。按"远交代空间→中建立关系→近特写担情绪"轮换（历史实锤：侧面 49%、跟拍 38%）',
    action: QC_ACTION.CAMERA_DIVERSIFY,
    fixLabel: '拉开机位与景别',
  },

  DIALOGUE_SPEED_TIGHT: {
    level: QC_LEVEL.WARNING,
    title: '台词说不完',
    hint: '本镜台词总字数 ÷ 镜时长 超过自然语速上限——配音要么加速到不自然，要么溢出到下一镜，Airlock 首帧对位被破坏',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },

  ENV_STATE_JUMP: {
    level: QC_LEVEL.WARNING,
    title: '环境状态无交代跳变',
    hint: '上一场有的环境要素（雾/光/天气）在本场凭空消失，剧本没写它去哪了——两场之间在观众眼里会被读成"换了地方"（历史实锤：雾跨场消失）',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },
  HANDOFF_ANCHOR_MISSING: {
    level: QC_LEVEL.WARNING,
    title: '跨场缺位移过程',
    hint: '上一场有垂直空间（崖顶/谷底/坡上），本场直接换了高度却没写怎么下去的——分镜拿不到过渡依据，只能硬切，观众会觉得"这两个地方不是一个地方"（历史实锤：下崖过渡缺失）',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },
  HANDOFF_ANCHOR_THIN: {
    level: QC_LEVEL.WARNING,
    title: '跨场位移过程过薄',
    hint: '提了位移但只用一个动作带过（如"沿下山道绕下谷底"），没有过程铺陈——分镜师切不出过渡镜，只能让上一场末镜硬接本场首镜。补出分级递进/连续变化/目标渐近等锚点即可切出 2~3 个过渡镜（历史实锤：单动作带过导致硬接）',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },
  OBJECT_FORM_INCONSISTENT: {
    level: QC_LEVEL.WARNING,
    title: '同一物体形态跨场不一致',
    hint: '同一物体（桥/门/船…）在不同场次的材质结构描述不一致——文字层自己就打架，出图必然画出两个东西（历史实锤：正文写木桥、场景图却画成石桥）',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },
  SUMMARY_SCRIPT_DRIFT: {
    level: QC_LEVEL.WARNING,
    title: '场记摘要与剧本不符',
    hint: '场景资产的 summary 与剧本正文描述的环境对不上——下游分镜读的是 summary，会照着与剧本不同的环境出片（多源事实分裂）',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },

  DIALOGUE_FLOOR: {
    level: QC_LEVEL.WARNING,
    title: '台词总量偏低',
    hint: '全片有台词镜头占比 < 25%——纯动作哑段落撑不起情感线（历史实锤：2 分半仅 3 句台词）',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },
  DIALOGUE_DROUGHT: {
    level: QC_LEVEL.WARNING,
    title: '连续无台词',
    hint: '连续 ≥6 镜完全无台词——观众长时间听不到角色声音，情感线断档',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },
  GAG_REPEAT: {
    level: QC_LEVEL.WARNING,
    title: '同类梗重复',
    hint: '同一桥段在全片出现 ≥3 次——观众第 3 次只会疲劳（历史实锤：同一梗三遍）',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },

  CHARACTER_SPECIES_DRIFT: {
    level: QC_LEVEL.ERROR,
    title: '角色物种漂移',
    hint: '镜头里对角色的描述与角色卡设定的物种不一致（如熊写成兔）——出片会换成另一个物种，前后完全对不上。锚定词必须与角色卡逐字一致',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },

  WS_OUT_EMPTY: {
    level: QC_LEVEL.WARNING,
    title: '出场状态快照缺失',
    hint: '本镜 world_state_out 为空——下一镜的 Airlock 继承与镜间衔接只能退回 finalFrame 文本，状态校验失效。补写出场状态快照（每个出场角色的"画面位置·手持·朝向"与关键道具状态）',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },
  WS_SPEAKER_MISSING: {
    level: QC_LEVEL.ERROR,
    title: '说话人缺出场状态',
    hint: '本镜有台词，但说话角色不在 world_state_out 出场状态快照里——台词归属与画面状态脱节，衔接检查无法追踪该角色',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },
  WS_CHAR_MISSING: {
    level: QC_LEVEL.WARNING,
    title: '出场角色缺状态条目',
    hint: '本镜 characters 里的角色没有出现在 world_state_out 中——出场状态快照漏人，下一镜衔接时该角色状态未知',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },
  WS_PROP_MISSING: {
    level: QC_LEVEL.WARNING,
    title: '关键道具缺状态条目',
    hint: '本镜 propAssets 里的道具没有出现在 world_state_out 中——道具去向无法被下一镜继承（掉在哪个位置、在谁手里）',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },
  WS_SIDE_MISMATCH: {
    level: QC_LEVEL.ERROR,
    title: '出场状态与最终画面侧位冲突',
    hint: 'world_state_out 里写的画面侧位（画面左/右/中）与 finalFrame 里的 frame left/right/center 不一致——结构化快照与英文最终画面互相矛盾，出片必有一边错',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },
  DIALOGUE_IN_AIRLOCK: {
    level: QC_LEVEL.ERROR,
    title: '台词落在 Airlock 锁定期',
    hint: '台词 startTime 落在镜头前段 Airlock 禁语期（默认前 2 秒）——Airlock 期嘴唇应闭合，台词会被口型/时间轴冲突',
    action: QC_ACTION.DIALOGUE_SHIFT,
    fixLabel: '移出禁语期',
  },
  DIALOGUE_OVERFLOW: {
    level: QC_LEVEL.ERROR,
    title: '台词溢出镜头',
    hint: '台词按自然语速估算的结束时间超过镜尾——该句会被截断或溢出到下一镜，破坏 Airlock 首帧对位',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },
  DIALOGUE_WINDOW_TIGHT: {
    level: QC_LEVEL.WARNING,
    title: '台词窗口偏紧',
    hint: '末句到镜尾的剩余时间小于建议窗口——虽不溢出但留白不足，换气/收音容易仓促，建议加长镜头或提前台词',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },
  SCENE_DURATION_TEMPLATE: {
    level: QC_LEVEL.WARNING,
    title: '场次时长模板化',
    hint: '多场总时长高度雷同——观众看三场就能预判下一场呼吸，悬疑与情绪落点被磨平。打破节拍，让各场时长差异化',
    action: QC_ACTION.CAMERA_DIVERSIFY,
    fixLabel: '打散场次节拍',
  },
  NO_FAST_CUT: {
    level: QC_LEVEL.WARNING,
    title: '全片无快切',
    hint: '全片没有 ≤ 快切上限秒的短镜——整片匀速，危机段无法提速。在情绪高点插 2-3 秒碎镜（特写/反应/局部）制造节奏差',
    action: QC_ACTION.CAMERA_DIVERSIFY,
    fixLabel: '补快切碎镜',
  },
  PROP_UNREGISTERED: {
    level: QC_LEVEL.WARNING,
    title: '高频道具未登记',
    hint: '文本高频出现的物件未在 props 表登记——颜色/形态/系法逐镜自由发挥必漂。先登记并生设定图，挂到相关镜头',
    action: QC_ACTION.MANUAL,
    fixLabel: '登记道具资产',
  },
  EMOTION_SCENE_STATIC: {
    level: QC_LEVEL.WARNING,
    title: '情绪段机位过静',
    hint: '情绪段（惊悚/迷雾/离别/夜戏）里固定机位占比过高——该让画面自己焦虑/沉浸的段落却钉死不动，观感接近幻灯片。改用极缓推/手持微晃',
    action: QC_ACTION.CAMERA_DIVERSIFY,
    fixLabel: '情绪段换动镜',
  },
  AXIS_DRIFT: {
    level: QC_LEVEL.WARNING,
    title: '轴线漂移',
    hint: '同一场内同一角色的画面侧位/空间方位多次翻转且无显式走位——180 度轴线被反复破坏，观众空间感混乱',
    action: QC_ACTION.AXIS_REPOSITION,
    fixLabel: '固定空间铁律',
  },

  MUSIC_MOOD_WORD: {
    level: QC_LEVEL.WARNING,
    title: '配乐用了抽象情绪词',
    hint: 'MiniMax H3 官方规范：non_diegetic_music 只写乐器/速度/节奏/动态变化，禁止抽象情绪词、禁止解释音乐的情绪功能。情绪要靠配器与动态表达——把"紧张"改写成"低音鼓点以急促节奏敲击、弦乐音量渐进上行"这类可听见的描述',
    action: QC_ACTION.MUSIC_REWRITE,
    fixLabel: '改为配器/动态描述',
  },
  PROMPT_OVER_LIMIT: {
    level: QC_LEVEL.ERROR,
    title: '提示词超出 H3 上限',
    hint: 'MiniMax H3 单条出片 prompt 硬上限 7000 字符（官方 API 文档明文）。超出后果为项目经验推断：可能被静默截断丢内容（不报错、只丢内容，最危险），也可能直接报错 400（无害但阻断）。大头通常是参考素材：每个 ref 约 230 模板字符 + 英文描述在 subject_definitions/retention_analysis 写两遍 + 场景 lighting/角色多视角句，一张场景图 ≈1000 字符；镜 4-4 一类「跨场次重复挂场景图」是典型成因（出片组装层已自动拦截跨场图）。优先减少单镜挂的场景/道具图，其次精简 description/action_note/final_frame，或按任务边界拆镜',
    action: QC_ACTION.PROMPT_CONDENSE,
    fixLabel: '精简提示词',
  },
  PROMPT_NEAR_LIMIT: {
    level: QC_LEVEL.WARNING,
    title: '提示词贴近 H3 上限',
    hint: '估算长度已达 H3 单条 7000 字符硬上限的 90%（贴线）。组装后长度受英译波动影响（实测残差 ±500 字符量级），出片时可能实际超限被硬阻断。属工程余量预警，非官方规则——建议减少单镜挂的场景/道具图或精简正文，为英译膨胀留出空间',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },
}

export const QC_UNKNOWN_META = {
  level: QC_LEVEL.WARNING,
  title: '',
  hint: '',
  action: QC_ACTION.MANUAL,
  fixLabel: '',
  basis: QC_BASIS.HEURISTIC,
}

// 模块加载时一次性注入出处档位；未列出的码默认 industry（行业共识/工程必然）
for (const [basis, codes] of Object.entries(QC_BASIS_MAP)) {
  for (const code of codes) {
    if (QC_CODES[code]) QC_CODES[code].basis = basis
  }
}

export function qcMeta(code) {
  const c = String(code || '')
  return QC_CODES[c] || { ...QC_UNKNOWN_META, title: c || '未分类问题' }
}


export function isRegisteredQcCode(code) {
  return Object.prototype.hasOwnProperty.call(QC_CODES, String(code || ''))
}

export function summarizeQc(qc = {}) {
  const errors = Array.isArray(qc.errors) ? qc.errors : []
  const warnings = Array.isArray(qc.warnings) ? qc.warnings : []
  const codedErrors = Array.isArray(qc.codedErrors) ? qc.codedErrors : []

  const byCode = new Map()
  const bump = (code, shot, message, levelOverride) => {
    const meta = qcMeta(code)
    const level = levelOverride || meta.level
    let g = byCode.get(code)
    if (!g) {
      g = { code, level, title: meta.title, hint: meta.hint, action: meta.action, fixLabel: meta.fixLabel, basis: meta.basis, items: [] }
      byCode.set(code, g)
    }
    g.items.push({ shot: String(shot ?? ''), message: String(message ?? '') })
  }

  for (const w of warnings) bump(String(w?.code || 'UNKNOWN'), w?.shot, w?.message, null)
  const codedMessages = new Set(codedErrors.map((e) => String(e?.message || '')))
  for (const e of codedErrors) bump(String(e?.code || 'UNKNOWN'), e?.shot, e?.message, QC_LEVEL.ERROR)
  for (const e of errors) {
    if (codedMessages.has(String(e))) continue
    bump('MUST_FIX', '*', e, QC_LEVEL.ERROR)
  }

  const basisRank = { [QC_BASIS.OFFICIAL]: 0, [QC_BASIS.INDUSTRY]: 1, [QC_BASIS.HEURISTIC]: 2 }
  const groups = [...byCode.values()].sort((a, b) => {
    if (a.level !== b.level) return a.level === QC_LEVEL.ERROR ? -1 : 1
    const ra = basisRank[a.basis] ?? 1
    const rb = basisRank[b.basis] ?? 1
    if (ra !== rb) return ra - rb
    return b.items.length - a.items.length
  })

  const errorCount = groups.filter((g) => g.level === QC_LEVEL.ERROR).reduce((n, g) => n + g.items.length, 0)
  const warningCount = groups.filter((g) => g.level === QC_LEVEL.WARNING).reduce((n, g) => n + g.items.length, 0)

  return {
    total: errorCount + warningCount,
    errorCount,
    warningCount,
    groups,
  }
}


