/**
 * 导演核 · 表达层
 * ============================================================================
 * 这是 LLM 在整个内核里**唯一**被允许出场的地方，而且它的权限被收得很窄：
 *
 *   它不决定切不切镜（那是 planner 的事）
 *   它不决定运镜（那是 designMovement 的事）
 *   它不决定时长（那是时长模型的事）
 *   它不决定机位朝向与侧位（那是轴线几何的事）
 *
 *   它只做一件事：**把已经确定下来的镜头，写成文字。**
 *
 * 为什么这样分？
 *   因为大模型的强项是表达，弱项是坚持。让它同时做决策和表达，
 *   它会在每一次调用里重新做一遍决定 —— 于是同一个剧本跑两遍，镜数不同。
 *   把决策拿走后，剩下的表达任务既短、又稳、还能单镜并行重试。
 */

import { ACTION_CLASSES, FRAME_SIDE_EN, MOVE_AMPLITUDE, SIZE_BY_KEY } from './ontology.js'

/* ==========================================================================
 * 一、把镜头设计渲染成"给模型看的交办单"
 * ========================================================================== */

export function renderShotBrief(shot, scene, ctx = {}) {
  const sizeDef = SIZE_BY_KEY[shot.framing.size]
  const moveDef = shot.movement
  const amp = moveDef.amplitude ? MOVE_AMPLITUDE[moveDef.amplitude] : null

  const L = []
  L.push('【这一镜已经被定死了，你的工作只是把它写出来】')
  L.push('')
  L.push(`镜号：${shot.id}`)
  L.push(`这一镜为什么存在：${shot.intent}`)
  L.push(`景别：${shot.framing.size}${sizeDef ? `（画面能装下的信息尺度：${sizeDef.sees}）` : ''}`)
  L.push(`机位朝向：${shot.framing.angle}｜观看归属：${shot.framing.ownership}`)
  L.push(`机位侧位：${shot.framing.side}${scene.axis?.a ? `（轴线 ${scene.axis.a} ←→ ${scene.axis.b || '—'}）` : ''}`)
  L.push(`运镜：${moveDef.key}${amp ? `（${moveDef.amplitude}幅度 · ${amp.note}）` : ''}`)
  L.push(`运镜的理由：${moveDef.motivation}`)
  L.push(`时长：${shot.duration} 秒`)

  if (shot.beats?.length) {
    L.push('')
    L.push('镜内节拍（时间轴已定，不要改动）：')
    for (const b of shot.beats) L.push(`  ${fmtTime(b.at)}  ${b.what}`)
  }

  if (shot.lines?.length) {
    L.push('')
    L.push('台词（逐字照用，不要改写、不要并句、不要转成旁白）：')
    for (const l of shot.lines) L.push(`  ${l.character}${l.tone ? `（${l.tone}）` : ''}：「${l.text}」`)
  }

  const a = shot.assets || {}
  L.push('')
  L.push(`出场资产：角色 ${fmtAssets(a.characters)}｜场景 ${fmtAssets(a.scenes)}｜道具 ${fmtAssets(a.props)}`)

  L.push('')
  L.push('入口状态（本镜第一帧必须与此一致，这是上一镜交给你的画面）：')
  L.push(indent(renderState(shot.entry)))
  L.push('出口状态（本镜最后一帧必须与此一致，这是你交给下一镜的画面）：')
  L.push(indent(renderState(shot.exit)))

  if (ctx.style) {
    L.push('')
    L.push(`画风：${ctx.style}`)
  }

  return L.join('\n')
}

function fmtAssets(list) {
  return list && list.length ? list.map((x) => `@${x}`).join(' ') : '无'
}
function fmtTime(t) {
  const m = Math.floor(t / 60)
  const s = (t % 60).toFixed(2).padStart(5, '0')
  return `${String(m).padStart(2, '0')}:${s}`
}
function indent(text) {
  return String(text).split('\n').map((l) => `    ${l}`).join('\n')
}

/** 状态渲染：把结构化状态写成模型能读懂的两句话（中文给人看，英文给模型用） */
export function renderState(state) {
  if (!state) return '（无）'
  const subj = (state.subjects || [])
    .filter((s) => s.side !== 'not in frame')
    .map((s) => `${s.name} 在${cnSide(s.side)}${s.posture && s.posture !== 'standing' ? `，姿态：${s.posture}` : ''}`)
  const props = (state.props || []).map((p) => `${p.name}（${p.holder || '无主'}·${p.state}）`)
  const env = state.env || {}
  const bits = []
  bits.push(subj.length ? subj.join('；') : '画面无主要角色')
  if (props.length) bits.push(`道具：${props.join('、')}`)
  if (env.anchor) bits.push(`环境锚点：${env.anchor}`)
  if (env.light) bits.push(`光线：${env.light}`)
  return bits.join('\n')
}
function cnSide(en) {
  if (en === FRAME_SIDE_EN.left) return '画面左'
  if (en === FRAME_SIDE_EN.right) return '画面右'
  if (en === FRAME_SIDE_EN.center) return '画面中'
  return '画外'
}

/* ==========================================================================
 * 二、单镜表达：提示词
 * ========================================================================== */

export function buildShotExpressionMessages(shot, scene, ctx = {}) {
  const system = [
    '你是分镜执行者，不是分镜设计者。',
    '上面这份交办单里的每一个决定（景别、机位、运镜、时长、节拍、台词、入口/出口状态）都已经由导演定死，',
    '你的任务是把它准确地写成文字，而不是重新设计它。',
    '',
    '【绝对禁止】',
    '- 改变景别、机位朝向、机位侧位、运镜方式、镜头时长',
    '- 增加交办单里没有的角色、道具、场景元素',
    '- 删改、并句、改写台词，或把台词转成旁白/画外音',
    '- 把出口状态改成与交办单不一致的画面',
    '- 写任何形式的元注释（"无BGM""本镜无对白"这类括号说明），除非交办单明确要求',
    '',
    '【画面描述要求】',
    '- 一句连贯的中文叙事，40–80 字，不分段、不列表、不写小标题',
    '- 只写观众眼睛能看见的东西：谁在哪里、在做什么、结果是什么',
    '- 用 @名字 标记每一个出现的资产',
    '- 不写音效、不写配乐、不写摄影机参数（那些另有字段）',
    '',
    '【视觉提示词要求】',
    '- 英文，按固定顺序书写：画风 → 景别与机位 → 主体外貌 → 发生的事（带时间戳）→ 最后一个确定状态',
    '- 主体外貌必须【逐字复制】资产清单里给的描述，不得自行添加清单外的特征',
    '- 必须显式写出画面侧位（at frame left / at frame right / at center frame），因为下游要靠它锁定朝向',
    '- 结尾用 "The final frame: ..." 完整复述出口状态',
    ctx.styleLock ? `- 画风锁定：整幅画面严格统一为「${ctx.style}」` : '',
    '',
    '只输出一个 JSON 对象，形如：',
    '{"visualDescription":"...","visualPrompt":"..."}',
    '不要输出任何其他文字。',
  ].filter(Boolean).join('\n')

  const user = [
    renderShotBrief(shot, scene, ctx),
    '',
    ctx.assetList ? `【资产清单（外貌以此为准）】\n${ctx.assetList}` : '',
  ].filter(Boolean).join('\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

/* ==========================================================================
 * 三、剧本导演化：把裸剧本提升为带标注的剧本（可选路径）
 * --------------------------------------------------------------------------
 * 内核不需要这一步也能工作（screenplay.js 会自己做确定性推断）。
 * 但只要预算允许，这一步能把推断变成**有依据的判断**，尤其是"行动线"：
 * 谁想要什么、被什么挡住、最后选了哪条路 —— 这三样决定了整场戏的镜头该往哪边偏。
 * ========================================================================== */

export function buildScreenplayAnnotationMessages(rawScript) {
  const system = [
    '你是场记，不是编剧。你的任务是把一份剧本整理成"导演可用的标注本"，**不得改动任何台词，不得增删情节**。',
    '',
    '对每个场次，补齐以下六项。缺哪项就按剧本内容如实提炼，剧本没写的一律留空，不要编。',
    '',
    '1. 空间：地点 + 时间 + 内外。地点从剧本里已有的名词取，不要另起名字。',
    '2. 轴线：本场戏里空间关系最需要被守住的两个主体，写成「A ←→ B」。只有一个人的场次留空。',
    '3. 锚点：本场里不动的、可以作为空间参照的物体（礁石、门、树、桌），最多四个。',
    '4. 基调：本场情绪走向，用「起点 → 终点」表示，只能从这七个词里选：舒缓/平稳/紧张/危险/压抑/爆发/欢快。',
    '5. 行动线：每个主要角色一行，四段式「谁 | 想要什么 | 被什么挡住 | 最后选了哪条路」。',
    '6. 节拍：把本场切成有序的、每一条都是一个可被看见的事件，一行一拍。',
    '',
    '输出严格 JSON：',
    '{"scenes":[{"title":"","space":"","timeOfDay":"","intExt":"","axis":{"a":"","b":""},"anchors":[],"toneCurve":[],"actionLines":[{"subject":"","want":"","obstacle":"","choice":""}],"beats":["",""]}]}',
    '只输出 JSON。',
  ].join('\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: `剧本原文：\n${rawScript}` },
  ]
}

/* ==========================================================================
 * 四、表达结果校验：模型有没有越权
 * --------------------------------------------------------------------------
 * 模型最常见的越权不是"写错"，而是"多写"：偷偷加了人物、偷偷改了侧位、
 * 把台词写成了旁白。这些都是可以离线判定的，因此不靠模型自觉。
 * ========================================================================== */

export function checkExpression(shot, output) {
  const issues = []
  const zh = String(output?.visualDescription || '').trim()
  const en = String(output?.visualPrompt || '').trim()

  if (!zh) issues.push({ code: 'EMPTY_DESC', message: '画面描述为空' })
  if (!en) issues.push({ code: 'EMPTY_PROMPT', message: '视觉提示词为空' })

  if (zh) {
    const len = zh.replace(/\s/g, '').length
    if (len < 30) issues.push({ code: 'DESC_TOO_SHORT', message: `画面描述只有 ${len} 字，短到交代不清一个动作` })
    if (len > 100) issues.push({ code: 'DESC_TOO_LONG', message: `画面描述 ${len} 字，超长会把重点冲散` })
    if (/\n/.test(zh)) issues.push({ code: 'DESC_MULTILINE', message: '画面描述出现换行，应为一句话' })
    if (/(音效|配乐|BGM|bgm)\s*[:：]/.test(zh)) issues.push({ code: 'DESC_FIELD_LEAK', message: '画面描述里混进了音效/配乐字段' })
    for (const name of shot.assets?.characters || []) {
      if (!zh.includes(name)) issues.push({ code: 'ASSET_MISSING_IN_DESC', message: `画面描述里没提到出场角色「${name}」` })
    }
  }

  if (en) {
    for (const name of (shot.exit.subjects || []).filter((s) => s.side !== 'not in frame')) {
      const side = String(name.side || '')
      const enSide = side === 'at frame left' ? /frame left/i : side === 'at frame right' ? /frame right/i : /center frame/i
      if (!enSide.test(en)) issues.push({ code: 'SIDE_MISSING', message: `视觉提示词没有声明「${name.name}」的画面侧位（${side}），下游会锁不住朝向` })
    }
    if (!/the final frame\s*:/i.test(en)) issues.push({ code: 'FINAL_FRAME_MISSING', message: '视觉提示词缺少 "The final frame:" 段落，下一镜将拿不到确定的入口' })
    // 台词必须保留在提示词里，用于锁定口型与说话状态
    for (const l of shot.lines || []) {
      if (l.text && !en.includes(l.text)) issues.push({ code: 'LINE_MISSING', message: `台词「${l.text}」没有进入视觉提示词，口型对不上` })
    }
  }

  return { ok: issues.length === 0, issues }
}
