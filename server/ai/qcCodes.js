
export const QC_LEVEL = { ERROR: 'error', WARNING: 'warning' }

export const QC_ACTION = {
  AIRLOCK_LINK: 'airlock_link',
  AXIS_REPOSITION: 'axis_reposition',
  REGEN_FRAME: 'regen_frame',
  CAMERA_DIVERSIFY: 'camera_diversify',
  MANUAL: 'manual',
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
    hint: '文本含"写实/CGI/照片级"等风格切换词，出片会把整段拉去另一种画风（第1集 5-3 实锤，8 镜返工）',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
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
    hint: '同一角色在相邻镜的"位置载体"（熊背上/坡顶/冰面）凭空变化，本镜没有显式移动动作',
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
    hint: '镜头时长超出数据层允许范围（见 storyboardValidator.DURATION_MIN/MAX），出片端会被 clamp',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },
  DIALOGUE_TIME_OUT_OF_RANGE: {
    level: QC_LEVEL.WARNING,
    title: '台词时间戳越界',
    hint: '台词 startTime 不在本镜时间范围内，出片换算镜内相对秒为负/超时，时间戳被静默丢弃',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
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
    action: QC_ACTION.MANUAL,
    fixLabel: '',
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
    hint: '一镜塞了多个叙事节拍（连接词+肢体动作+角色切换三信号触发）——一拍一镜才出电影感，建议拆成多镜靠 Airlock 衔接。第1集42镜验证：旧版纯连接词零报，升级后13条真实多拍全中',
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
    action: QC_ACTION.MANUAL,
    fixLabel: '',
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
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },
  ACTION_CAMERA_MISMATCH: {
    level: QC_LEVEL.WARNING,
    title: '动作运镜失配',
    hint: '描述含主体强发力动作（扑/跃/撞飞等）但运镜是"固定"——动作即运镜被违反，大动作在静止画框里会死。建议改为跟拍/环绕/手持晃动配合动作；若发力的是环境而非角色主体可忽略',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
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
    action: QC_ACTION.MANUAL,
    fixLabel: '',
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
    hint: '上一镜最终画面停在某个动作上，本镜描述开头又把它从零做了一遍——同一动作被陈述两遍，观众会看到叙事原地倒带。把上镜末帧收在该动作之前，动作整段让给本镜（37镜 2-1→2-2 实锤）',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },
  ACTION_DENSITY_HIGH: {
    level: QC_LEVEL.WARNING,
    title: '动作密度超载',
    hint: '肢体动作数 ÷ 时长超过上限——时长装不下这个动作量，出片模型只能演开头或把手部动作演糊。要么按任务边界拆镜，要么延长时长（37镜 2-3 实锤：6s 装 6 个动作）',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },
  SHOT_ATTRIBUTE_MONOTONE: {
    level: QC_LEVEL.WARNING,
    title: '拍法分布单调',
    hint: '全片单一机位朝向/景别/运镜占比过高（机位>45% / 景别>40% / 运镜>30%）——侧面连成墙、中景承包全片、推近用到第十次就不叫强调了。按"远交代空间→中建立关系→近特写担情绪"轮换（37镜 侧面49%、跟拍38% 实锤）',
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
    hint: '上一场有的环境要素（雾/光/天气）在本场凭空消失，剧本没写它去哪了——两场之间在观众眼里会被读成"换了地方"（第2集 场1→场2 雾消失实锤）',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },
  HANDOFF_ANCHOR_MISSING: {
    level: QC_LEVEL.WARNING,
    title: '跨场缺位移过程',
    hint: '上一场有垂直空间（崖顶/谷底/坡上），本场直接换了高度却没写怎么下去的——分镜拿不到过渡依据，只能硬切，观众会觉得"这两个地方不是一个地方"（第2集 场1→场2 下崖缺失实锤）',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },
  HANDOFF_ANCHOR_THIN: {
    level: QC_LEVEL.WARNING,
    title: '跨场位移过程过薄',
    hint: '提了位移但只用一个动作带过（如"沿下山道绕下谷底"），没有过程铺陈——分镜师切不出过渡镜，只能让上一场末镜硬接本场首镜。补出分级递进/连续变化/目标渐近等锚点即可切出 2~3 个过渡镜（第2集 场2 改前原文实锤）',
    action: QC_ACTION.MANUAL,
    fixLabel: '',
  },
  OBJECT_FORM_INCONSISTENT: {
    level: QC_LEVEL.WARNING,
    title: '同一物体形态跨场不一致',
    hint: '同一物体（桥/门/船…）在不同场次的材质结构描述不一致——文字层自己就打架，出图必然画出两个东西（第2集 场2 木桥 vs 场图 石桥实锤）',
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
    hint: '全片有台词镜头占比 < 25%——纯动作哑段落撑不起情感线（第1集 F5 实锤）',
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
    hint: '同一桥段在全片出现 ≥3 次——观众第 3 次只会疲劳（第1集 F6 雪埋梗实锤）',
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
}

export function qcMeta(code) {
  const c = String(code || '')
  return QC_CODES[c] || { ...QC_UNKNOWN_META, title: c || '未分类问题' }
}

export function isQcError(code) {
  return qcMeta(code).level === QC_LEVEL.ERROR
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
      g = { code, level, title: meta.title, hint: meta.hint, action: meta.action, fixLabel: meta.fixLabel, items: [] }
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

  const groups = [...byCode.values()].sort((a, b) => {
    if (a.level !== b.level) return a.level === QC_LEVEL.ERROR ? -1 : 1
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

export function formatQcItem(item) {
  const meta = qcMeta(item?.code)
  const title = meta.title || item?.code || ''
  const where = item?.shot && item.shot !== '*' ? `镜头 ${item.shot}：` : ''
  return `${title ? `[${title}] ` : ''}${where}${item?.message || ''}`
}

export function qcFixResult({ changed = false, reason = '' } = {}) {
  return { success: !!changed, changed: !!changed, reason: String(reason || '') }
}
