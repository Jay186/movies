// 镜头合并引擎（分镜切分根治层）
//
// 背景：提示词层已写「任务边界切镜」，但 LLM 仍倾向把连续戏拆成多条碎镜；
// 本引擎把「连续叙事默认合并」落成确定性代码：生成管线里各场生成后、Airlock 修补前执行。
//
// 设计原则（v3 · 黑名单制）：
// 1. 纯函数，无 LLM 参与——宁可不合并，也不冒内容失真的风险；
// 2. 连续叙事默认合并：同场景 + 主体连续 + 非对话反打 + 时长可行 → 合并，
//    只拦必须切的信号（新主体 / 对话反打 / 场景切换 / 超时长 / 运镜对偶冲突）；
// 3. 目标效果：同一段连续戏合成一条长镜，运镜承载过渡（豆志刚式一镜到底感）；
// 4. 失败不阻断：任何原因不合并都保留原镜头，管线继续走。
//
// 时间轴约定：
// - 合并输入为已 normalize 过的镜头（duration/startTime/endTime 合法）；分场模式下，各场在
//   buildAndRun 内按 perSceneDuration 各自 normalize，startTime 为「场局部时间轴」（各场从 0 起），
//   mergeAllScenes 在各场生成完毕后、全局 normalize 与 Airlock/越轴修补之前执行。
// - dialogue.startTime 为绝对秒，合并中原样保留（合并镜内位置不变，无需偏移）。
// - 合并后镜头数减少但总时长不变（组时长 = 组员时长和），本引擎只修正合并镜自身的时间轴，
//   全局重排（跨场累计 startTime）由管线后续的 normalizeStoryboard 统一完成。

// 对偶运镜：方向相反的组合拼进一条镜头语义矛盾
const MOVE_OPPOSITE_PAIRS = [
  ['推近', '拉远'],
  ['变焦推近', '变焦拉远'],
  ['左摇', '右摇'],
  ['左移', '右移'],
  ['摇上', '摇下'],
  ['升高', '降低'],
]

const ROUND2 = (n) => Math.round(n * 100) / 100

function moveOf(shot) {
  return String(shot?.cameraMovement || shot?.camera_movement || '').trim()
}

function movesCompatible(a, b) {
  if (!a || !b || a === b) return true
  return !MOVE_OPPOSITE_PAIRS.some(([x, y]) => (a === x && b === y) || (a === y && b === x))
}

// 合并后的单值运镜：固定机位让位给运动镜，其余以后镜收尾运动为主
// （过程性演变由 actionNote 拍点承载——出片提示词的时间轴来源是 actionNote）
function mergedMove(a, b) {
  if (a === b) return a || '固定'
  if (a === '固定') return b
  if (b === '固定') return a
  return b
}

// 主体连续：后镜不得引入前镜没有的角色（引入新主体 = 切镜有收益，不合并）
function subjectsContinuous(prev, curr) {
  const pc = (prev?.characters || []).map(String)
  const cc = (curr?.characters || []).map(String)
  if (!pc.length || !cc.length) return true
  const pset = new Set(pc)
  return cc.every((c) => pset.has(c))
}

// 场景连续性：完全相等 → 连续；任一为空（AI 漏登记/被清洗，属常态）→ 视为连续
// （与 subjectsContinuous 的"任一为空即通过"对称）；有交集（如 [冰河] 与 [冰河,森林入口]
// 这类重叠场景挂载）→ 连续；只有两组场景完全无交集才视为真正的场景切换。
function sameScene(prev, curr) {
  const ps = (prev?.sceneAssets || []).map(String)
  const cs = (curr?.sceneAssets || []).map(String)
  if (!ps.length || !cs.length) return true
  const pset = new Set(ps)
  return cs.some((c) => pset.has(c))
}

function asDialogueList(d) {
  if (Array.isArray(d)) return d
  if (d && typeof d === 'object') return [d]
  return []
}

// 对话反打：双方都有非空文本台词、且说话人集合不同 → 说话人切换需要独立承接，必须切。
// 单边台词（只有一侧有台词：行进中的即时台词/呼喊）与同一人继续说 → 不拦，同镜闭合。
function isDialogueReverse(prev, curr) {
  const textsAndSpeakers = (shot) => {
    const list = asDialogueList(shot?.dialogue)
    const texts = list.filter((d) => String(d?.text || '').trim())
    const speakers = [...new Set(texts.map((d) => String(d?.character || '').trim()))].sort()
    return { hasText: texts.length > 0, speakers: speakers.join('|') }
  }
  const a = textsAndSpeakers(prev)
  const b = textsAndSpeakers(curr)
  if (!a.hasText || !b.hasText) return false
  return a.speakers !== b.speakers
}

// 判定相邻两镜是否可合并（黑名单制：连续叙事默认合并，只拦必须切的信号）。
// 必须切的信号（任一命中即不合并）：
//   1. 合并后超单镜时长上限（H3 硬边界）
//   2. 场景不同（空间切换）
//   3. 后镜引入新主体（新角色首次入画）
//   4. 运镜对偶冲突（推近+拉远等方向相反组合，拼进一条语义矛盾）
//   5. 对话反打（仅当 config.storyboard.dialogueReverseBlock=true；默认 false——
//      对白驱动的连续戏若强制切镜，双主角对话场会被锁成 6-7s 短镜（2026-09-24 事故），
//      H3 一镜多说话人由 v4Video 的 <d> 台词时间轴承载，合并收益远大于口型风险；
//      且本引擎出口有 QC 前后对比守卫，合并引入的硬错误会整体回退）
// 其余情况（景别变化、动作推进、结构词、单边台词、画面差异）一律默认合并——
// 「运镜能带观众走到的，不用切镜去看」。
export function canMergePair(prev, curr, opts = {}) {
  const durationMax = opts.durationMax ?? 15
  const no = (why) => ({ mergeable: false, why, sim: 0 })
  if (!prev || !curr) return no('镜头缺失')
  const pd = Number(prev.duration) || 0
  const cd = Number(curr.duration) || 0
  if (pd + cd > durationMax) return no(`合并后 ${pd + cd}s 超单镜上限 ${durationMax}s`)
  if (!sameScene(prev, curr)) return no('场景不同')
  if (!subjectsContinuous(prev, curr)) return no('后镜引入新主体')
  if (!movesCompatible(moveOf(prev), moveOf(curr))) return no(`运镜对偶冲突（${moveOf(prev)} + ${moveOf(curr)}）`)
  if (opts.dialogueReverseBlock && isDialogueReverse(prev, curr)) return no('对话反打（说话人切换）')
  return { mergeable: true, why: '连续叙事默认合并', sim: 1 }
}

// ---- 拍点/台词偏移 ----
// 后镜并入合并镜时的语义（关键：前镜内容在合并镜前段【位置不变】，只有后镜整体后移）：
//   后镜拍点 y（相对后镜）→ y + offset（offset = 前镜/前组累计时长）
//   后镜「末 t s」＝合并镜末尾 t 秒，位置不变 → 转写为 At (mergedDur - t) s
// 正则顺序必须是 区间 → At → 末：末段转出的 At 时刻不能再被 At 正则二次偏移
// offset=0（前镜自身）时区间/At 位移为恒等，跳过替换以字面「原样保留」前镜拍点，只处理「末」。
function shiftNextActionNote(note, offset, mergedDur) {
  let s = String(note || '').trim()
  if (!s) return s
  if (offset) {
    s = s.replace(/(\d+(?:\.\d+)?)\s*[-—~至]\s*(\d+(?:\.\d+)?)\s*s/g, (_m, a, b) => `${ROUND2(Number(a) + offset)}-${ROUND2(Number(b) + offset)}s`)
    s = s.replace(/At\s*(\d+(?:\.\d+)?)\s*s/g, (_m, t) => `At ${ROUND2(Number(t) + offset)}s`)
  }
  s = s.replace(/末\s*(\d+(?:\.\d+)?)\s*s/g, (_m, t) => `At ${ROUND2(mergedDur - Number(t))}s`)
  return s
}

function concatUnique(a, b) {
  const out = []
  const seen = new Set()
  for (const item of [...(a || []), ...(b || [])]) {
    const v = String(item || '').trim()
    if (!v || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

function joinText(a, b, sep = '；') {
  return [String(a || '').trim(), String(b || '').trim()].filter(Boolean).join(sep)
}

function shotNum(shot) {
  return String(shot?.shotNumber || shot?.shot_number || '').trim()
}

// 确定性合并一对相邻镜头（prev 在合并镜前段、curr 在后段）。
// 字段取舍原则：
// - 前镜的时间内容（拍点/台词/时长位置）原样保留；后镜拍点整体后移 prev.duration
//   （台词为绝对秒、位置不变，不偏移）；
// - 结束状态（finalFrame/worldStateOut）取后镜——Airlock 继承依赖的是「最终画面」；
// - IMD 取后镜（前后画面本就高度相似，后镜 IMD 已锁定主体外貌与场景；
//   过程动作由 actionNote 完整承载，出片提示词不读 IMD 模块4）；
// - isCombat 取「或」：任一镜是武戏，整镜按武戏处理（打斗 LoRA 宁可多加载不可漏）；
// - shotType 取前镜：合并镜从那里起幅；camera_angle 取后镜（收尾机位）。
export function mergeShotPair(prev, curr) {
  const pd = Number(prev.duration) || 0
  const cd = Number(curr.duration) || 0
  const duration = pd + cd
  const baseStart = Number(prev.startTime) || 0

  const prevDialogue = asDialogueList(prev.dialogue)
  const currDialogue = asDialogueList(curr.dialogue)
  // 台词 startTime 为绝对秒（合并镜内位置不变），无需偏移；后镜有文本台词时本不会进入合并，空文本条目在此过滤
  const dialogue = [...prevDialogue, ...currDialogue].filter((d) => String(d?.text || '').trim())
  const dialogueOut = dialogue.length ? dialogue : null

  return {
    shotType: prev.shotType || prev.shot_type || '中景',
    startTime: baseStart,
    endTime: baseStart + duration,
    duration,
    // 合并取两镜描述「；」拼接，不按 40-80 字裁剪（信息完整性优先）；字数约束属生成提示词层，
    // 下游 v4Video.js 有 7000 字符预算 + 确定性裁剪两道防线兜底，QC(validateStoryboard) 无 description 上限硬校验。
    description: joinText(prev.description, curr.description),
    actionNote: joinText(shiftNextActionNote(prev.actionNote || prev.action_note, 0, pd), shiftNextActionNote(curr.actionNote || curr.action_note, pd, duration)),
    cameraMovement: mergedMove(moveOf(prev), moveOf(curr)),
    camera_angle: curr.camera_angle || curr.cameraAngle || prev.camera_angle || prev.cameraAngle || '',
    soundEffects: joinText(prev.soundEffects, curr.soundEffects),
    overallSoundscape: joinText(prev.overallSoundscape, curr.overallSoundscape),
    nonDiegeticMusic: String(curr.nonDiegeticMusic || curr.non_diegetic_music || prev.nonDiegeticMusic || prev.non_diegetic_music || '').trim(),
    dialogue: dialogueOut,
    characters: concatUnique(prev.characters, curr.characters),
    sceneAssets: concatUnique(prev.sceneAssets, curr.sceneAssets),
    propAssets: concatUnique(prev.propAssets, curr.propAssets),
    finalFrame: String(curr.finalFrame || curr.final_frame || '').trim(),
    purpose: joinText(prev.purpose, curr.purpose),
    goal: joinText(prev.goal, curr.goal),
    emotionTone: String(curr.emotionTone || curr.emotion_tone || prev.emotionTone || prev.emotion_tone || '').trim(),
    infoPoints: concatUnique(prev.infoPoints, curr.infoPoints),
    worldStateOut: String(curr.worldStateOut || curr.world_state_out || '').trim(),
    integratedMultimodalDescription: String(curr.integratedMultimodalDescription || curr.integrated_multimodal_description || '').trim(),
    isCombat: prev.isCombat === true || curr.isCombat === true
      ? true
      : (prev.isCombat === false && curr.isCombat === false ? false : undefined),
  }
}

// 对一个场次的镜头序列执行合并：从左到右贪心扩展合并组。
// 组内累计时长不得超过 durationMax；任何一对不满足 canMergePair 即断组收尾。
// opts.forbidFirstShotMerge=true 时首镜不参与合并扩展（直接保留，尝试合并从第 2 镜起）。
// 返回 { shots, mergedCount, mergeLog }。
export function applyShotMerge(shots, opts = {}) {
  const list = Array.isArray(shots) ? shots.filter(Boolean) : []
  const mergeLog = []
  if (list.length < 2) return { shots: list, mergedCount: 0, mergeLog }

  const out = []
  let i = 0
  // 首镜保护：非首场场景首镜承载跨场 Airlock 衔接语义，不参与合并扩展
  if (opts.forbidFirstShotMerge) {
    out.push(list[0])
    i = 1
  }
  while (i < list.length) {
    let current = list[i]
    let j = i + 1
    while (j < list.length) {
      const verdict = canMergePair(current, list[j], opts)
      const fromLabel = shotNum(current) || current.mergedFrom || '(合并组)'
      const toLabel = shotNum(list[j])
      if (!verdict.mergeable) {
        mergeLog.push({ from: fromLabel, to: toLabel, merged: false, why: verdict.why })
        break
      }
      const merged = mergeShotPair(current, list[j])
      merged.mergedFrom = [current.mergedFrom || shotNum(current) || '(首镜)', toLabel || `第${j + 1}镜`].join('+')
      mergeLog.push({ from: fromLabel, to: toLabel, merged: true, sim: ROUND2(verdict.sim) })
      current = merged
      j++
    }
    out.push(current)
    i = j
  }

  // 修正合并镜时间轴（未合并镜位置不变：组时长=组员时长和，后续镜天然不受影响）。
  // 防御性重算 startTime/endTime 的连续性，起点继承首镜。
  let cursor = Number(out[0]?.startTime) || 0
  for (const shot of out) {
    const d = Number(shot.duration) || 0
    shot.startTime = cursor
    shot.endTime = ROUND2(cursor + d)
    cursor = shot.endTime
  }

  const mergedCount = list.length - out.length
  return { shots: out, mergedCount, mergeLog }
}

// 对整个 storyboard（scenes[].shots[]）执行合并，返回新 storyboard 与统计
// opts.forbidFirstShotForScene（可选，函数 (sceneIndex) => boolean）：逐场决定是否禁止首镜合并。
export function applyShotMergeToStoryboard(storyboard, opts = {}) {
  const scenes = Array.isArray(storyboard?.scenes) ? storyboard.scenes : []
  let totalMerged = 0
  const mergeLog = []
  const newScenes = scenes.map((scene, idx) => {
    // 有 forbidFirstShotForScene 时逐场计算首镜保护；否则原样透传 opts（行为与现状一致）
    const sceneOpts = opts.forbidFirstShotForScene
      ? { ...opts, forbidFirstShotMerge: !!opts.forbidFirstShotForScene(idx) }
      : opts
    const { shots, mergedCount, mergeLog: sceneLog } = applyShotMerge(scene?.shots || [], sceneOpts)
    totalMerged += mergedCount
    mergeLog.push(...sceneLog)
    return { ...scene, shots }
  })
  return { storyboard: { ...storyboard, scenes: newScenes }, mergedCount: totalMerged, mergeLog }
}
