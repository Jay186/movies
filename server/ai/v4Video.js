import path from 'node:path'
import { uploadsUrl, continuityTailImagePath, uploadsDir, continuityDir } from '../paths.js'
import fs from 'node:fs'
import { runWorkflow, uploadMediaFileName, uploadAudioV2, insecureDownload, downloadWithRetry, isPlausibleMp4 } from './runninghub.js'
import { runFfmpeg } from './ffmpeg.js'
import { resolveWorkflowId } from '../modelConfig.js'
import { translateShotFields, translateShotSize, translateCameraMovement, translateCameraAngle, translateCameraAngleElevation, translateLens, translateTone, translateWorldStateOnly } from './h3PromptTranslator.js'
import { config } from '../config.js'
import { clean as cleanShared, pickEnglish, stripResidualCjk, resolveAssetName, truncateStyle, formatCutTimestamp, pickInjectableEnglish, cleanDesc, lowerFirst, resolveDesc, normalizeTone, stripLeadingShotSize, reconcileShotSizeScale, resolvePlaceholderSubjectNames, tagSubjectFirstMentions, identityFeatures, CJK_DIRTY_RE, normalizeCjkPunct } from './shared.js'
import { parseDialogue } from './dialogue.js'

export { pickEnglish, stripResidualCjk }

const BLANK_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

function silenceWavDataUri(seconds = 1) {
  const sampleRate = 16000
  const numSamples = sampleRate * seconds
  const dataSize = numSamples * 2
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataSize, 40)
  return 'data:audio/wav;base64,' + buf.toString('base64')
}
const SILENCE_WAV = silenceWavDataUri(1)

export function normalizeVideoParams(params = {}) {
  return {
    aspectRatio: config.video.combatAspectRatios.includes(params.aspectRatio) ? params.aspectRatio : config.video.defaultAspectRatio,
    megapixels: config.video.megapixels.includes(String(params.megapixels)) ? String(params.megapixels) : config.video.defaultMegapixels,
    duration: Math.min(config.video.shotDurationMax, Math.max(config.video.shotDurationMin, Math.round(Number(params.duration) || config.video.shotDefaultDuration))),
  }
}

const clean = cleanShared

const DE_SHOUT_PAIRS = [
  [/\bwhile shouting\b/gi, 'in a firm steady voice'],
  [/\bshouting\b/gi, 'calling out'],
  [/\bshouts\b/gi, 'calls out'],
  [/\bshouted\b/gi, 'called out'],
  [/\bshout\b/gi, 'call out'],
  [/\bscreaming\b/gi, 'crying out'],
  [/\bscreams\b/gi, 'cries out'],
  [/\bscreamed\b/gi, 'cried out'],
  [/\bscream\b/gi, 'cry out'],
  [/\byelling\b/gi, 'calling out'],
  [/\byells\b/gi, 'calls out'],
  [/\byelled\b/gi, 'called out'],
  [/\byell\b/gi, 'call out'],
  [/\bat the top of (its|his|her|their) lungs\b/gi, 'in a firm steady voice'],
  [/\bforceful shout\b/gi, 'firm call'],
  [/\bfurious roar\b/gi, 'firm strong voice'],
  [/\blow growl\b/gi, 'low steady voice'],
  [/\broaring\b/gi, 'rumbling'],
  [/\broars\b/gi, 'rumbles'],
  [/\broared\b/gi, 'rumbled'],
  [/\broar\b/gi, 'rumble'],
  [/\bgrowling\b/gi, 'grumbling'],
  [/\bgrowls\b/gi, 'grumbles'],
  [/\bgrowled\b/gi, 'grumbled'],
  [/\bgrowl\b/gi, 'grumble'],
  [/\bto project a call out\b/gi, 'to speak steadily'],
  [/\bproject(?:s|ing)? (?:a|the) call(?:\s+out)?\b/gi, 'speaks steadily'],
]
const deShout = (s) => {
  let out = String(s || '')
  for (const [re, rep] of DE_SHOUT_PAIRS) out = out.replace(re, rep)
  return out
}
export { deShout }

const EFFORT_SENT_RE = /\b(cheeks?|mouth|project\w*|maximum extent|volume of air|(?:large|deep|huge)[,\s]+(?:visible\s+)?breath|raises?\s+(?:its|his|her|their|the)\s+voice|forces?\s+the\s+voice|belt\w*\s+out)\b/i
const LIP_LOCK_RE = /\b(mouth|lips?)\b[^.]{0,40}\b(closed|shut)\b|\b(closed|shut)\b[^.]{0,40}\b(mouth|lips?)\b/i
const stripEffortSentences = (s) =>
  String(s || '')
    .split(/(?<=\.)\s+/)
    .map((sent) => (EFFORT_SENT_RE.test(sent) && !LIP_LOCK_RE.test(sent) ? 'Its jaw sets with quiet resolve.' : sent))
    .join(' ')
export const cleanVoiceDescription = (s) => deShout(stripEffortSentences(s))

// world_state 是从上一镜派生的状态快照，可能在本镜主体已经变化后仍保留旧角色。
// 只解析显式的 @主体=状态条目，并与本镜实际挂载的参考资产比对；调用方据此决定
// 是否把该快照送入 H3。这里不修改分镜数据，也不增加分镜导入阻断规则。
export function findUndeclaredWorldStateSubjects(worldState, declaredNames = []) {
  const allowed = new Set(
    (Array.isArray(declaredNames) ? declaredNames : [declaredNames])
      .map((name) => String(name || '').trim().toLocaleLowerCase())
      .filter(Boolean),
  )
  const found = []
  // 状态串通常只在第一项写 @，后续项以「；主体=状态」继续列出；两种都识别。
  const re = /(?:^|[;；])\s*@?([^=：:;；\n]+?)\s*(?:=|：|:)/g
  const source = String(worldState || '')
  let match
  while ((match = re.exec(source))) {
    const name = String(match[1] || '').trim()
    if (!name) continue
    const key = name.toLocaleLowerCase()
    if (!allowed.has(key) && !found.some((item) => item.toLocaleLowerCase() === key)) found.push(name)
  }
  return found
}

// 单镜连续负向块（代码层固定注入）：实测证明写进中文描述的规避清单会被翻译层整段丢弃，必须在组装层原文注入。
// 只放对任意单镜都成立的通用约束（连续单镜/无场景切换/身份连续），不含项目特定内容；config.video.h3SingleTakeBlock 可关
const H3_SINGLE_TAKE_BLOCK = 'One continuous single take: no camera cuts, no scene change, no time skip; every character keeps its identity, appearance, and position throughout, and the environment stays the same location from start to end.'

// 固定机位构图锁定句（仅 camera_movement=固定 时注入）：借鉴 Runway Gen-4 四维锚定法。
// SINGLE_TAKE_BLOCK 锁了换镜/换场/身份/位置，唯独没锁 zoom/reframing——模型会在"固定"镜内
// 自行 zoom out 重新构图（2026-09-25 出片事故：某镜 t≈14.8s 处主体占比 1/2→1/3 缩水）。
// 仅对固定机位注入，避免与推近/拉远等动态运镜矛盾。
const STATIC_CAMERA_LOCK = 'Shot on a locked-off tripod with the framing frozen from first frame to last: no zoom in, no zoom out, no reframing, no dolly, no truck — the field of view and image scale stay identical for the entire duration of the shot.'

// 情绪基调（中文 2-6 字）→ 光色/节奏词素：子串命中即用，无匹配不注入（对自由文本零风险）
const EMOTION_VISUAL_MAP = [
  ['明快', 'a bright, warm tonal palette with gentle, unhurried pacing'],
  ['温暖', 'a warm, soft tonal palette with gentle pacing'],
  ['欢快', 'a lively, bright tonal palette with buoyant pacing'],
  ['压抑', 'a muted, low-key tonal palette with heavy, restrained pacing'],
  ['紧绷', 'a tense, high-contrast tonal palette with taut pacing'],
  ['紧张', 'a tense tonal palette with taut pacing'],
  ['不安', 'an uneasy, slightly cool tonal palette with hesitant pacing'],
  ['悲伤', 'a somber, desaturated tonal palette with slow pacing'],
  ['克制', 'a restrained tonal palette with measured pacing'],
  ['释然', 'a calm, open tonal palette with relaxed pacing'],
  ['坚定', 'a steady, clear tonal palette with resolute pacing'],
  ['惊恐', 'a cold, sharp tonal palette with abrupt pacing'],
]
function emotionVisualOf(tone) {
  const t = String(tone || '').trim()
  if (!t) return ''
  for (const [k, v] of EMOTION_VISUAL_MAP) { if (t.includes(k)) return v }
  return ''
}

export async function buildShotVideoPromptV4(shot = {}, ctx = {}) {
  const { stylePrompt = '', stylePromptEn = '', styleLabelEn = '', refs = [], audioRefs = [], isCombat = false, translate, speakerIds, retryNote = '', combatNote = '', continuationVideo = false } = ctx
  const tr = typeof translate === 'function' ? translate : translateShotFields

  // —— H3 预算制 + 确定性裁剪（三道防线）——
  // 官方两条规则在多 refs 镜上互相打架：ref-en.txt §5.2 要求 detailed_description 扩写
  // 350-500 英文词（≈2200-3100 字符），API 又限单条 ≤7000 字符。refs 模板 + final_frame +
  // 台词行 + 战斗块的静态骨架就已 ~5000 字符，再加满额扩写必超限（实测 9100 即此成因）。
  // 第一道（预算）：真实翻译前，先用「空翻译」把整条 prompt 组一遍量出骨架长度，把
  // 限长 − 骨架 − 余量 折算成英文词数预算传给翻译器——API 硬上限优先于词数质量区间，
  // 预算内先保空间关系/朝向硬信息，再压次要细节。
  // 第二道（裁剪）：LLM 指令遵从非 100%（实测预算产出仍超 329 字符），组装完成后若仍超限，
  // 按「句边界、裁扩写尾部」确定性裁掉超出部分重组装一次——数学保证进线，不依赖 LLM 听话。
  // 若裁空全部可变文本仍超限（refs 挂载过多所致），交由 generate-video 硬阻断报数据问题。
  let wordBudget = null
  if (!ctx.__skeletonPass) {
    const h3Limit = config.storyboard?.h3PromptCharLimit ?? 7000
    const budgetSafety = config.video?.h3PromptBudgetSafety ?? 400 // 英译长度波动余量
    const SOUNDSCAPE_MUSIC_RESERVE = 350 // 声景+配乐+段头预留（空翻译骨架量不到）
    const WORLDSTATE_FINALFRAME_RESERVE = 720 // 开场/收尾状态 + 末帧兜底翻译的字符预留
    const EN_WORD_CHARS = 6              // 英文平均词长含空格（实测标定）
    try {
      const skeleton = await buildShotVideoPromptV4(shot, { ...ctx, __skeletonPass: true, translate: async () => ({}) })
      // 上限封顶官方 §5.2 的 500 词（空间充裕不多给，防反向超写）；下限 80 词保最低叙事结构
      const descActionMax = Math.min(500, Math.max(80, Math.floor((h3Limit - budgetSafety - skeleton.length - SOUNDSCAPE_MUSIC_RESERVE - WORLDSTATE_FINALFRAME_RESERVE) / EN_WORD_CHARS)))
      wordBudget = { descActionMax }
    } catch { wordBudget = null }
  }
  // 裁剪量（第二遍组装由函数尾部的超限检测注入）：从扩写尾部按句边界裁掉
  const enforceTrim = Math.max(0, Number(ctx.__enforceTrim) || 0)
  // 降级上报只在「规范首遍」发生。本函数一次出片会被自身递归调用两次：
  // ①预算遍（__skeletonPass=true，故意用空翻译量骨架量长度）；②裁剪遍（__enforceTrim>0，超限重组装）。
  // 两者都是同一镜的重复组装，再上报一次没有新信息，只会把同一条降级刷两遍（原实现只挡了①，
  // 裁剪遍会把 onDegrade 经 {...ctx} 原样带下去 → 同一 kind 重复入列）。此处用 enforceTrim 判定，
  // 把②也一并纳入「非首遍」。
  const canonicalPass = !ctx.__skeletonPass && enforceTrim === 0
  // 句边界尾部裁剪：裁掉 ≥n 字符，向上找最近的句号/分号断口，找不到就硬切
  const trimTailAtSentence = (s, n) => {
    if (!s) return s
    if (n <= 0) return s
    if (s.length <= n) return ''
    const target = s.length - n
    let cut = target
    for (let i = target; i >= Math.max(0, target - 200); i--) {
      const ch = s[i]
      if (ch === '.' || ch === ';') { cut = i + 1; break }
    }
    return s.slice(0, cut).trim()
  }

  const parts = []

  // 下限 4：MiniMax-H3 官方 duration 取值 4-15 整数秒（platform.minimax.io，2026-09-30 复核）
  const duration = Math.min(
    config.video?.shotDurationMax ?? 15,
    Math.max(config.video?.shotDurationMin ?? 4, Math.round(Number(shot.duration) || config.video?.shotDefaultDuration || 5))
  )
  const shotStart = Number(shot.start_time) || 0
  // VC（video continuation）在 prompt 层是"参考视频续写"语义：
  // 官方 ref-en §2.3 / L137 / L143——注入上一镜视频作参考就必须声明 <Video 1> 并标 video continuation，
  // 不得"挂了素材 prompt 不提"。

  parts.push('Director guidance below is for visual generation only: do not read aloud, narrate, or quote any of it — speak only the dialogue inside <d> tags. The generated video must contain no on-screen text, subtitles, watermark, or logo.')

  const dlg = parseDialogue(shot.dialogue)
  const lines = dlg ? (Array.isArray(dlg) ? dlg : [dlg]) : []
  const vocalEvents = []
  for (const d of lines) {
    const who = clean(d?.character || d?.speaker || d?.name)
    const text = clean(d?.text || d?.line || d?.content)
    if (!text) continue
    vocalEvents.push({ d, who, text, subjIdx: refs.findIndex((r) => r.label === who || r.labelEn === who) })
  }
  const speakerIdMap = new Map()
  if (speakerIds instanceof Map) {
    refs.forEach((r, i) => {
      const sid = speakerIds.get(r.label) || speakerIds.get(r.labelEn)
      if (sid) speakerIdMap.set(i + 1, sid)
    })
  } else {
    for (const ev of vocalEvents) {
      if (ev.subjIdx >= 0 && !speakerIdMap.has(ev.subjIdx + 1)) speakerIdMap.set(ev.subjIdx + 1, 'S' + (speakerIdMap.size + 1))
    }
  }

  const subjectLines = refs.map((r, i) => {
    if (r.kind === 'storyboard') {
      return `<Picture ${i + 1}> is a storyboard reference for [Shot 1], defining its camera viewpoint, subject placement, and composition.`
    }
    if (r.kind === 'continuity') {
      if (continuationVideo) {
        // 官方模板：<Picture N> is the final frame of <Video 1> —— 图锚显式绑定视频末帧，防"图视频打架"。
        return `<Picture ${i + 1}> is the final frame of <Video 1>, the previous shot's tail: [Shot 1] continues <Video 1> seamlessly from it — character positions, postures, orientations, relative sizes, the environment state, and the exact color temperature, lighting direction, and tonal palette carry over with no warm or cool shift. <Video 1> anchors motion flow, environment state, and color grade, NOT camera viewpoint.`
      }
      return `<Picture ${i + 1}> is the previous shot's final frame, a continuity anchor: character positions, postures, orientations, relative sizes, the environment state, and the exact color temperature, lighting direction, and tonal palette continue seamlessly from it — the color grade matches it exactly, with no warm or cool shift. It anchors character, environment, and color grade, NOT camera viewpoint.`
    }
    if (r.kind === 'endframe') {
      return `<Picture ${i + 1}> is the target last frame of [Shot 1], the final composition and character positions this shot must end on.`
    }
    if (r.kind === 'styleanchor') {
      // 画风锚不绑定具体画风：基准随项目 art_style 变化（与 combatStyleAnchorEn / styleDriftClause 同口径）
      const anchorStyle = styleLabelEn ? ` (${styleLabelEn})` : ''
      return `<Picture ${i + 1}> is the final frame of the opening shot of this episode, provided as the absolute art-style anchor${anchorStyle}: every character, environment and effect in this shot MUST stay in this exact same art style — same linework, texture, color palette and tonal grade. Never switch to any other art register or render style in any part of the frame.`
    }
    const typeLabel = r.kind === 'character' ? 'character' : (r.kind === 'prop' ? 'prop' : 'scene/environment')
    const name = resolveAssetName(r.labelEn, r.label) || `reference ${i + 1}`
    // 官方 ref-en.txt L68：只用于定义角色/场景/服装/画风的图，不单列 <Picture N> 条目，
    // 而是在 <Subject N> 定义行内引用 <Picture N> —— 外观由参考图本身承载（图走 RunningHub
    // 独立 image0~image8 节点，不占官方 ≤7000 字符预算）。故文本只承担 L37 要求的
    // 「the main features to follow」，不复述生图用的完整外观（实测 478-660 字符/条）。
    // 完整复述会让 4-5 refs 吃掉 3000-4600 字符，把官方 §5.2 要求的 detailed_description
    //（350-500 英文词 ≈2200-3100 字符）挤到 1476，是撑爆 7000 的真正成因。
    // config.video.h3SubjectFullDesc=1 可回退「原样复述」，用于出片质量对比。
    const rawDesc = resolveDesc(r.descEn, r.desc)
    const d = config.video?.h3SubjectFullDesc ? rawDesc : identityFeatures(rawDesc)
    // 场景光照不在此复述：detailed_description 已写「The scene lighting remains constant
    // throughout」（见下方 shot1 组装），且 summary_en 原文结尾本就自带一遍光照描写——
    // 此前这里是同一信息的第三遍，纯冗余（每个场景条目约 140 字符）。
    // 资产描述自带句点，拼接前剥掉再统一由模板补一个，避免 "...body.." 双句点
    return `<Subject ${i + 1}> is ${name} (${typeLabel}) from <Picture ${i + 1}>${d ? `, ${d.replace(/[.\s]+$/, '')}` : ''}.`
  })
  const audioLines = audioRefs.map((a, i) => {
    const sId = speakerIdMap.get(a.subjectNum)
    const idPart = sId ? ` (${sId})` : ''
    return `<Audio ${i + 1}> is the voice-timbre reference for <Subject ${a.subjectNum}>${idPart}. Extract ONLY the vocal timbre from it. The reference audio contains sample speech that must NEVER be played back, quoted, hummed, or echoed in the generated soundtrack. All spoken output comes exclusively from the <d> dialogue lines below.`
  }).filter(Boolean)
  // <Video N> 与 <Picture N> 各自独立编号：视频走 ref_videos 槽，不挤占 9 张图的编号空间
  if (continuationVideo) {
    // 官方 §2.3：<Video N> 声明续写来源视频（本项目固定为上一镜尾部片段）。
    subjectLines.unshift(`<Video 1> is the final tail segment of the previous shot's video. [Shot 1] is its direct continuation: the motion flow, character blocking, environment state, and color grade flow straight through from <Video 1> into [Shot 1] with no cut, no re-establishment shot, and no style change.`)
  }
  parts.push('subject_definitions:')
  parts.push([...subjectLines, ...audioLines].join('\n'))
  parts.push('Accessories and garments belong only to the character wearing them in that character\'s own <Picture N> — never add, remove, or transfer any accessory (scarf, hat, bag, glasses) between characters, and never dress a character that wears none. Every character keeps the exact body proportions, face structure and rendering style of its own reference image regardless of how its size, power or action is described in this shot.')

  const style = truncateStyle(pickEnglish(stylePromptEn) || pickEnglish(stylePrompt), 300)
  const sceneRef = refs.find((r) => r.kind === 'scene')
  const sceneLabel = sceneRef ? resolveAssetName(sceneRef.labelEn, sceneRef.label) : ''
  const sceneLighting = cleanDesc(pickEnglish(refs.find((r) => r.kind === 'scene' && pickEnglish(r.lightingEn))?.lightingEn))
  const hasFrameAnchor = refs.some((r) => r.kind === 'continuity' || r.kind === 'endframe')
  // 官方任务模板：有参考视频时 [video continuation + keyframe completion]，纯图锚时仍走 [reference generation + keyframe completion]
  const taskTypes = continuationVideo ? ['video continuation'] : ['reference generation']
  if (hasFrameAnchor) taskTypes.push('keyframe completion')
  if (audioRefs.length) taskTypes.push('audio reference')
  const taskPrefix = `[${taskTypes.join(' + ')}]`
  // 官方 ref-en.txt §3：summary 必须用 subject_definitions 中已定义的 <Subject N>/<Picture N>/<Video N>/<Audio N>
  // 标签描述主体、镜头流与参考素材角色，且不得在此引入新标签。故此处逐条点名已定义标签。
  const labelOf = (r, i) => {
    if (r.kind === 'storyboard' || r.kind === 'continuity' || r.kind === 'endframe' || r.kind === 'styleanchor') return `<Picture ${i + 1}>`
    return `<Subject ${i + 1}>`
  }
  const charRefs = refs.map((r, i) => ({ r, i })).filter(({ r }) => r.kind === 'character')
  const envRefs = refs.map((r, i) => ({ r, i })).filter(({ r }) => r.kind === 'scene')
  const propRefs = refs.map((r, i) => ({ r, i })).filter(({ r }) => r.kind === 'prop')
  const anchorRefs = refs.map((r, i) => ({ r, i })).filter(({ r }) => ['storyboard', 'continuity', 'endframe', 'styleanchor'].includes(r.kind))
  const summaryBits = []
  if (continuationVideo) summaryBits.push('continues directly from <Video 1>')
  if (charRefs.length) summaryBits.push(`shows ${charRefs.map(({ r, i }) => `<Subject ${i + 1}>${resolveAssetName(r.labelEn, r.label) ? ` (${resolveAssetName(r.labelEn, r.label)})` : ''}`).join(', ')}`)
  if (envRefs.length) summaryBits.push(`is set in ${envRefs.map(({ i }) => `<Subject ${i + 1}>`).join(', ')}`)
  if (propRefs.length) summaryBits.push(`features ${propRefs.map(({ i }) => `<Subject ${i + 1}>`).join(', ')}`)
  if (anchorRefs.length) summaryBits.push(`uses ${anchorRefs.map(({ r, i }) => `${labelOf(r, i)} as the frame anchor for [Shot 1]`).join(', ')}`)
  if (audioRefs.length) summaryBits.push(`uses ${audioRefs.map((a, i) => `<Audio ${i + 1}> as the voice-timbre reference for <Subject ${a.subjectNum}>`).join(', ')}`)
  const summaryBody = summaryBits.length
    ? `It ${summaryBits.length === 1 ? summaryBits[0] : `${summaryBits.slice(0, -1).join(', ')}, and ${summaryBits[summaryBits.length - 1]}`}. All visual elements strictly match their reference appearances.`
    : 'The target video is a single generation shot with no reference assets beyond its described content.'
  parts.push('summary:')
  // 场景光照只在 detailed_description 里写一次（原 summary 处重复一遍，纯冗余字符）
  parts.push(`${taskPrefix} The target video is a ${duration}-second single-shot clip${style ? ` in the reference style (${style})` : ''}. ${summaryBody}`)

  parts.push('retention_analysis:')
  const visualRetention = refs.map((r, i) => {
    if (r.kind === 'storyboard') {
      return `<Picture ${i + 1}> (storyboard reference for [Shot 1]): fully_preserved - the camera viewpoint, subject placement, and composition from <Picture ${i + 1}> are followed in [Shot 1].`
    }
    if (r.kind === 'continuity') {
      if (continuationVideo) {
        return `<Picture ${i + 1}> (final frame of <Video 1>, continuity anchor for [Shot 1]): partially_preserved - character positions, postures, orientations, relative sizes, the environment state, and the exact color temperature, lighting direction, and tonal palette from <Video 1> are retained at [Shot 1]'s opening with no color shift; <Video 1>'s motion and action flow carry straight into [Shot 1]; camera position and composition fully reframe to [Shot 1]'s described shot size AND camera angle — the anchor never preserves the camera viewpoint.`
      }
      return `<Picture ${i + 1}> (continuity anchor for [Shot 1]): partially_preserved - character positions, postures, orientations, relative sizes, the environment state, and the exact color temperature, lighting direction, and tonal palette from <Picture ${i + 1}> are retained at [Shot 1]'s opening with no color shift; camera position and composition fully reframe to [Shot 1]'s described shot size AND camera angle — the anchor never preserves the camera viewpoint.`
    }
    if (r.kind === 'endframe') {
      return `<Picture ${i + 1}> ([Shot 1] last frame): fully_preserved - the video ends on the exact final composition, character positions, and environment state shown in <Picture ${i + 1}>.`
    }
    // styleanchor 在 subject_definitions 里是 <Picture N>（L165-167），retention 必须沿用同一标签：
    // 官方 ref-en.txt L35 标签全篇含义一致；此前落默认分支会写成 <Subject N>，双标签指同一资产。
    if (r.kind === 'styleanchor') {
      return `<Picture ${i + 1}> (style anchor for [Shot 1]): fully_preserved - the exact rendering style, linework, texture, color palette and tonal grade from <Picture ${i + 1}> are preserved throughout [Shot 1], with no shift to any other art register or render style.`
    }
    // 默认不重复 desc：外观定义已在 subject_definitions 建立，官方 ref-en §4 只要求 retention_analysis
    // "preserve the meaning established in subject_definitions"，句式与官方 <Audio 1>: fully_copy -
    // "...is reused 1:1..." 示例同构（描述保留方式，而非复述外观定义）。重复整段 descEn 是纯冗余——
    // 每个 ref 白白多花约 descEn×1 的预算（实测 5 refs 省 ~1200 字符），挤占 detailed_description
    // 的有效空间。config.video.h3RetentionFullDesc=true 可回退旧行为（出片质量对比用）。
    const d = resolveDesc(r.descEn, r.desc)
    const name = resolveAssetName(r.labelEn, r.label) || `reference ${i + 1}`
    // 道具「本镜状态」：镜头级外观变化走 retention 的 partially_preserved（官方 ref-en L166
    // "some defined characteristics are changed"），不进 subject_definitions（那是资产定义，
    // 只写 main features）。状态串由 createRefCollector 拆分传入（r.stateEn）。
    const stateEn = cleanDesc(pickEnglish(r.stateEn))
    const stateClause = stateEn ? `, with ${lowerFirst(stateEn)}` : ''
    const marker = stateEn ? 'partially_preserved' : 'fully_preserved'
    const body = config.video?.h3RetentionFullDesc
      ? `${d || 'appearance'} is retained from <Picture ${i + 1}>${stateClause}`
      : stateEn
        ? `${name} is retained from <Picture ${i + 1}>${stateClause}`
        : `${name} is retained exactly as defined in <Picture ${i + 1}>`
    const multiViewHint = r.kind === 'character'
      ? ` When the character is not front-facing (from behind, facing away, or in profile), use that matching view from <Picture ${i + 1}> instead of the front view.`
      : ''
    return `<Subject ${i + 1}> (appears in [Shot 1]): ${marker} - ${body}.${multiViewHint}`
  }).join('\n')
  // 官方 ref-en.txt §5.4：Do not write (Sx) in retention_analysis —— 说话人 ID 只出现在
  // subject_definitions 与 detailed_description，此处只保留 <Subject N> 引用（同官方范例）。
  const audioRetention = audioRefs.map((a, i) => {
    return `<Audio ${i + 1}>: reference - its vocal timbre guides the dialogue delivery of <Subject ${a.subjectNum}> without copying the original signal.`
  })
  parts.push([visualRetention, ...audioRetention].filter(Boolean).join('\n'))

  const characterNames = refs.filter((r) => r.kind === 'character').map((r) => r.label)
  const sceneNames = refs.filter((r) => r.kind !== 'character').map((r) => r.label)
  const voicedNames = audioRefs.map((a) => refs[a.subjectNum - 1]?.label).filter(Boolean)
  // A derived world-state snapshot is usable only when every explicit @subject is
  // represented by an asset mounted on this shot. A stale snapshot must not force
  // H3 to render an unreferenced character (or reconcile contradictory framing).
  const declaredWorldStateNames = refs.flatMap((r) => [r.label, r.labelEn]).filter(Boolean)
  const worldStateInSource = String(shot.world_state_in || shot.worldStateIn || '').trim()
  const worldStateOutSource = String(shot.world_state_out || shot.worldStateOut || '').trim()
  const undeclaredWorldStateIn = findUndeclaredWorldStateSubjects(worldStateInSource, declaredWorldStateNames)
  const undeclaredWorldStateOut = findUndeclaredWorldStateSubjects(worldStateOutSource, declaredWorldStateNames)
  const worldStateInUsable = undeclaredWorldStateIn.length === 0
  const worldStateOutUsable = undeclaredWorldStateOut.length === 0
  if (canonicalPass && (!worldStateInUsable || !worldStateOutUsable)) {
    const stale = [
      undeclaredWorldStateIn.length ? `world_state_in: ${undeclaredWorldStateIn.join(', ')}` : '',
      undeclaredWorldStateOut.length ? `world_state_out: ${undeclaredWorldStateOut.join(', ')}` : '',
    ].filter(Boolean).join('; ')
    console.warn(`[v4Video] shot ${shot.id || '?'} 忽略未挂载主体的陈旧 world_state（${stale}）；以本镜 refs/description/final_frame 为准`)
  }
  const translationShot = (worldStateInUsable && worldStateOutUsable)
    ? shot
    : {
        ...shot,
        ...(worldStateInUsable ? {} : { world_state_in: '', worldStateIn: '', world_state_in_en: '', worldStateInEn: '' }),
        ...(worldStateOutUsable ? {} : { world_state_out: '', worldStateOut: '', world_state_out_en: '', worldStateOutEn: '' }),
      }
  const translated = { ...(await tr(translationShot, { characterNames, sceneNames, voiceClone: audioRefs.length > 0, voicedNames, wordBudget })) }
  if (!worldStateInUsable) translated.world_state_en = ''
  if (!worldStateOutUsable) translated.world_state_end_en = ''

  // 库内英文副本兜底（2026-09-27）：world_state 的英文源有两条路——分镜阶段落库的英文副本，
  // 与出片时的 LLM 翻译。翻译器内部已做「副本优先」，但那只覆盖「翻译器正常返回」的情形：
  // 翻译器整体失败（LLM 掉线 / 两次含中文降级 / 异常）时返回的是空壳，副本跟着一起丢——
  // 而副本是**数据**，本就不该依赖 LLM 通路是否可用。此处做组装层兜底：
  // 翻译产物为空时直接把库内副本填回去，让首帧/末帧构图约束在任何 LLM 状态下都成立。
  // 实测口径：修复前 LLM 掉线时 1-2/1-3 的首尾约束整句消失（"开场句(无)、收尾句(无)"）。
  const copyInEn = String(shot.world_state_in_en || shot.worldStateInEn || '').trim()
  const copyOutEn = String(shot.world_state_out_en || shot.worldStateOutEn || '').trim()
  if (worldStateInUsable && !String(translated.world_state_en || '').trim() && copyInEn && !CJK_DIRTY_RE.test(copyInEn)) {
    translated.world_state_en = copyInEn
  }
  if (worldStateOutUsable && !String(translated.world_state_end_en || '').trim() && copyOutEn && !CJK_DIRTY_RE.test(copyOutEn)) {
    translated.world_state_end_en = copyOutEn
  }

  // 首尾状态独立翻译通道（2026-09-27 治本）：库内英文副本只有 15/19 镜（worldStateOutEn 是
  // LLM 自由字段，吐不吐看运气），而主翻译批次是大 batch（description/action/声景/配乐/语气
  // 一起送），一旦整体失败或含中文降级，首尾约束就跟着一起丢——上一镜末态在本镜被重置，
  // 镜间主体/朝向漂移（实测 1-2→1-3 跳帧）。
  // 关键点：world_state_in/out 是**本镜构图的第一硬约束**，不该被大 batch 的成败绑架。
  // 此处用 translateWorldStateOnly（最小请求、独立超时、独立重试）单独补齐——
  // 中文源在、英文仍空时才触发，恰好命中「副本缺失 且 主批次没翻出来」这一条断裂路径；
  // 已有英文（副本或主批次）时零开销、零行为变化。预算遍（__skeletonPass）不触发，
  // 避免为量长度白跑一次 LLM 调用（那是纯浪费，且骨架遍本就不产出 prompt）。
  if (!ctx.__skeletonPass) {
    const needIn = worldStateInUsable && !String(translated.world_state_en || '').trim() && worldStateInSource
    const needOut = worldStateOutUsable && !String(translated.world_state_end_en || '').trim() && worldStateOutSource
    if (needIn || needOut) {
      // 依赖注入点：测试可传 ctx.worldStateTranslator 替换真实 LLM 通道，
      // 否则单测会发出真实 LLM 请求，结果受网络/并发环境影响（全量跑 flaky 的实锤根因）。
      const wsTranslate = typeof ctx.worldStateTranslator === 'function' ? ctx.worldStateTranslator : translateWorldStateOnly
      try {
        const ws = await wsTranslate(
          needIn ? worldStateInSource : '',
          needOut ? worldStateOutSource : '',
          { characterNames, sceneNames, shot },
        )
        if (needIn && String(ws.world_state_en || '').trim() && !CJK_DIRTY_RE.test(ws.world_state_en)) {
          translated.world_state_en = ws.world_state_en
        }
        if (needOut && String(ws.world_state_end_en || '').trim() && !CJK_DIRTY_RE.test(ws.world_state_end_en)) {
          translated.world_state_end_en = ws.world_state_end_en
        }
        if (ws.failed && canonicalPass) {
          console.warn(`[v4Video] shot ${shot.id || '?'} 首尾状态独立翻译失败：本镜首帧/末帧构图约束仍缺失（库内无英文副本），镜间衔接有漂移风险`)
        }
      } catch (e) {
        if (canonicalPass) {
          console.warn(`[v4Video] shot ${shot.id || '?'} 首尾状态独立翻译异常：${e.message}`)
        }
      }
    }
  }

  const zhNameToEn = new Map()
  for (const r of refs) {
    const zh = String(r.label || '').trim()
    const en = String(r.labelEn || '').trim()
    if (zh && en && zh !== en) zhNameToEn.set(zh, en)
  }
  const zhEntries = [...zhNameToEn.entries()].sort((a, b) => b[0].length - a[0].length)
  const zhNamesToEn = (s) => {
    let out = String(s || '')
    for (const [zh, en] of zhEntries) out = out.split(zh).join(en)
    return out
  }
  translated.description_en = zhNamesToEn(translated.description_en)
  translated.action_note_en = zhNamesToEn(translated.action_note_en)
  translated.soundscape_en = zhNamesToEn(translated.soundscape_en)
  translated.music_en = zhNamesToEn(translated.music_en)
  translated.tone_en = zhNamesToEn(translated.tone_en)
  translated.world_state_en = zhNamesToEn(translated.world_state_en)
  translated.world_state_end_en = zhNamesToEn(translated.world_state_end_en)

  const shotSize = translateShotSize(shot.shot_type)
  const cameraMove = translateCameraMovement(shot.camera_movement)
  const cameraAngle = translateCameraAngleElevation(shot.camera_angle, shot.camera_elevation ?? shot.cameraElevation)
  const lensClause = translateLens(shot.lens)
  const voiceClone = audioRefs.length > 0
  const rawAction = cleanDesc(pickEnglish(translated.action_note_en) || stripResidualCjk(translated.action_note_en) || pickEnglish(shot.action_note))
  const rawVisual = cleanDesc(pickEnglish(translated.description_en) || stripResidualCjk(translated.description_en) || pickEnglish(shot.description))

  let actionDesc = voiceClone ? cleanVoiceDescription(rawAction) : rawAction
  let visualDesc = voiceClone ? cleanVoiceDescription(rawVisual) : rawVisual

  // 视频链路不读取 IMD。若作者字段没有可靠英文编译结果，保留为空并由语义门禁阻断；
  // 不从图像提示词的 M2/M4 旁路猜测视频叙事或动作。
  if (enforceTrim > 0) {

    let trimLeft = enforceTrim
    const tVisual = trimTailAtSentence(visualDesc, trimLeft)
    trimLeft -= visualDesc.length - tVisual.length
    visualDesc = tVisual
    if (trimLeft > 0) {
      const tAction = trimTailAtSentence(actionDesc, trimLeft)
      trimLeft -= actionDesc.length - tAction.length
      actionDesc = tAction
    }
    translated.__trimLeftAfterDesc = trimLeft // 剩余量传给声景/配乐裁剪
  }

  const dlgLines = []
  const distinctTones = new Set(vocalEvents.map((ev) => clean(ev.d?.tone)).filter(Boolean))
  const toneFallbackEn = distinctTones.size <= 1 ? pickEnglish(translated.tone_en) : ''
  const shotEnd = shotStart + duration
  for (const ev of vocalEvents) {
    const { d, who, text, subjIdx } = ev
    const rawTone = normalizeTone(translateTone(d?.tone) || toneFallbackEn)
    const toneEn = voiceClone ? deShout(rawTone) : rawTone
    const sId = (subjIdx >= 0 ? speakerIdMap.get(subjIdx + 1) : null)
      || (speakerIds instanceof Map ? speakerIds.get(who) : null)
    const speakerRef = subjIdx >= 0
      ? `<Subject ${subjIdx + 1}>${sId ? ` (${sId})` : ''}`
      : `${pickEnglish(who) || 'the character'}${sId ? ` (${sId})` : ''}`
    let t = ''
    if (d?.startTime != null && d.startTime !== '') {
      const rel = Number(d.startTime) - shotStart
      if (!isNaN(rel) && rel >= 0 && rel <= duration) {
        t = `At ${formatCutTimestamp(rel)}, `
      }
    }
    // 官方 base-en.txt §4.4：同一句台词跨切点时，在两侧连接点标 <scenetrans> 并写明音频跨切连续。
    // 本项目每镜独立出片：若本句 startTime 早于本镜起点，说明它从上镜延续而来 → 标跨切承载。
    const carriesOver = d?.startTime != null && Number(d.startTime) < shotStart - 0.001
    // 官方 §4.4：语音被视频结尾截断时标 <cutoff>。用真实 endTime 判定，不做估算。
    const truncated = d?.endTime != null && d.endTime !== '' && Number(d.endTime) > shotEnd + 0.001
    const aIdx = subjIdx >= 0 ? audioRefs.findIndex((a) => a.subjectNum === subjIdx + 1) : -1
    // 官方 ref-en.txt §5.4：说话人标签 + 说话动作 + 语气/音色，全部写在 <d> 之外，用逗号接 <d>：
    //   <Subject 2> (S1) turns toward the woman and says, <d>...
    //   <Subject 3> (S1) replies in the same clear youthful voice referenced from <Audio 1> with an amused cadence, <d>...
    // 项目的 toneEn 已是从镜头数据翻译出的完整状语短语（in a hushed tone / gently / through gritted teeth ...），
    // 直接作插入语接在 says 之后即可，不再自造与数据无关的固定副词（如 "softly and steadily"）。
    const timbreClause = aIdx >= 0 ? ` in the voice timbre referenced from <Audio ${aIdx + 1}>` : ''
    const toneClause = toneEn
      ? ` says, ${toneEn}${timbreClause},`
      : ` says${timbreClause},`
    const scenetransLead = carriesOver ? '<scenetrans> ' : ''
    const carryNote = carriesOver ? ' This line carries over from the previous shot and remains audible across the cut.' : ''
    const cutoffMark = truncated ? '<cutoff>' : ''
    const cutoffNote = truncated ? ' This line is truncated by the end of the video.' : ''
    dlgLines.push(`${scenetransLead}${t}${speakerRef}${toneClause} <d>[Chinese] ${text}</d>${cutoffMark}${carryNote}${cutoffNote}`)
  }

  const ddParts = []
  if (style) ddParts.push(`The target video is in a cinematic, ${style} style.`)
  if (combatNote) ddParts.push(pickEnglish(combatNote) ? cleanDesc(combatNote) + '.' : '')
  // 首尾状态分别声明为 0.00s 与结束时必须成立的画面状态，避免把 world_state_out
  // 误当开场状态后，上一镜末态在本镜被重置。
  // 首尾状态是「谁在画面哪、什么姿态、面向哪」的直陈事实，先做中文标点归一
  // （「：」「·」直接进英文 prompt 是非法标点，见 shared.normalizeCjkPunct 注释），
  // 再 cleanDesc 收尾。放在此处而非翻译器：无论英文来自库内副本还是 LLM 盲翻都要过这一道。
  // 占位角色名归一（2026-09-27）：英文副本里的 Character A/B 换成中文 @主体名对应的真实英文标签
  // （zhNamesToEn 已含本镜参考图的中→英映射）。中文源是本镜主体的权威，占位名只是 LLM 自造占位。
  const worldStateEn = cleanDesc(normalizeCjkPunct(resolvePlaceholderSubjectNames(
    String(translated.world_state_en || '').trim(),
    worldStateInUsable ? worldStateInSource : '',
    zhNamesToEn,
  )))
  const worldStateEndEn = cleanDesc(normalizeCjkPunct(resolvePlaceholderSubjectNames(
    String(translated.world_state_end_en || '').trim(),
    worldStateOutUsable ? worldStateOutSource : '',
    zhNamesToEn,
  )))
  // 首帧/末帧构图硬约束的英文源现为三级兜底（2026-09-27 起）：① 分镜阶段落库的英文副本
  // （world_state_in_en/out_en，翻译器内副本优先 + 上方组装层副本回填）；② 主翻译批次；
  // ③ translateWorldStateOnly 独立小通道（最小请求、独立超时重试，不被大 batch 成败绑架）。
  // 仍做「中文→英文位置/朝向词表」的确定性兜底是刻意不为：实测中文排版有歧义（「面向画面深处」
  // 同时含位置词与朝向词，规则解析会误判，错误约束比没有约束更糟）。三级都断时只保证「不静默」：
  // 如实上报降级。
  if (canonicalPass) {
    // 库内英文副本（world_state_in_en/out_en）已由 translateShotFields 优先并入 worldStateEn，
    // 此处只在「中文源存在但英文最终为空」时才报降级——即分镜阶段没产出英文副本、
    // 且本次 LLM 翻译也没救回来。已落库英文的镜不再重复报警（它根本没走翻译链路）。
    const hasEnInCopy = Boolean(String(shot.world_state_in_en || '').trim())
    const hasEnOutCopy = Boolean(String(shot.world_state_out_en || '').trim())
    if (worldStateInUsable && !worldStateEn && worldStateInSource && !hasEnInCopy) {
      ctx.onDegrade?.({ kind: 'worldstate-in-lost', source: 'needs-llm-translate', text: '', shotId: shot.id ?? null })
    }
    if (worldStateOutUsable && !worldStateEndEn && worldStateOutSource && !hasEnOutCopy) {
      ctx.onDegrade?.({ kind: 'worldstate-out-lost', source: 'needs-llm-translate', text: '', shotId: shot.id ?? null })
    }
  }
  const sbIdx = refs.findIndex((r) => r.kind === 'storyboard')
  const ctIdx = refs.findIndex((r) => r.kind === 'continuity')
  const efIdx = refs.findIndex((r) => r.kind === 'endframe')
  let shot1 = `[Shot 1] A ${shotSize}`
  // 景别尺度收敛（2026-09-27 治本）：shot_type 是分镜阶段的权威景别决策，
  // LLM 扩写的 description 若自带更极端的景别词（如 shot_type=特写、描述写 extreme close-up），
  // 拼出的 "A close-up, extreme close-up ..." 会让同一条 prompt 出现两个互相打架的尺度，
  // 与末帧要求（拍脸+表情）叠加后模型只能挤变形。此处按 shot_type 档位把更极端的词降回同档，
  // 让尺度只有一个权威来源——是产线数据的确定性归一，不是事后校验。
  if (visualDesc) shot1 += `, ${lowerFirst(stripLeadingShotSize(reconcileShotSizeScale(visualDesc, shotSize)))}`
  shot1 += '.'
  if (worldStateEn) shot1 += ` The opening frame at 0.00s must show exactly: ${worldStateEn}.`
  if (sceneLighting) shot1 += ` The scene lighting remains constant throughout: ${sceneLighting}.`
  if (sbIdx >= 0) shot1 += ` The camera viewpoint, subject placement, and composition of this shot follow <Picture ${sbIdx + 1}>.`
  if (ctIdx >= 0) {
    shot1 += continuationVideo
      ? ` The shot begins from <Picture ${ctIdx + 1}>, the final frame of <Video 1>: character positions, postures, orientations, the environment state, and the exact color temperature, lighting direction, and tonal palette continue with no color shift; <Video 1>'s motion and action flow carry straight into [Shot 1]; camera position and composition fully reframe to [Shot 1]'s described shot size AND camera angle — the anchor never preserves the camera viewpoint.`
      : ` The shot begins from <Picture ${ctIdx + 1}>, the previous shot's final frame: character positions, postures, orientations, the environment state, and the exact color temperature, lighting direction, and tonal palette continue with no color shift; camera position and composition fully reframe to [Shot 1]'s described shot size AND camera angle — the anchor never preserves the camera viewpoint.`
  }
  if (cameraAngle) shot1 += ` ${cameraAngle.charAt(0).toUpperCase()}${cameraAngle.slice(1)}.`
  if (lensClause) shot1 += ` ${lensClause.charAt(0).toUpperCase()}${lensClause.slice(1)}.`
  if (cameraMove) shot1 += ` The camera ${cameraMove}.`
  if (actionDesc) shot1 += ` ${actionDesc}.`
  // H3 常把宽景中的多个时间点压缩成单一行走动作。把动作拍点提升为硬约束，
  // 明确每个时间点都必须在同一条连续镜头内完成，并保留角色之间的依附关系。
  if (actionDesc && /(?:at\s+\d|\d+(?:\.\d+)?s|拍点|时间轴)/i.test(String(shot.action_note || shot.actionNote || visualDesc || ''))) {
    shot1 += ` Every timed action beat listed above is mandatory and must be visibly performed at its stated time; do not skip, merge, or replace any beat with generic walking or idle motion. Preserve all described riding, holding, and attachment relationships while performing the beats.`
  }
  // 软接续镜会继承上一镜仍在场的角色参考图。明确要求这些角色继续存在，
  // 同时允许近景只露出局部，避免模型把未列入本镜动作描述的角色误判为离场。
  const continuityCharacterRefs = refs.filter((r) => r.kind === 'character')
  if (ctIdx >= 0 && continuityCharacterRefs.length > 1) {
    const names = continuityCharacterRefs.map((r) => resolveAssetName(r.labelEn, r.label)).filter(Boolean)
    if (names.length > 1) {
      shot1 += ` The characters ${names.join(' and ')} remain physically present from the previous shot and retain their established positions and attachment relationship; in this reframed close view they may be partially occluded by the foreground subject, but they must not disappear, be replaced, or detach from it.`
    }
  }
  if (worldStateEndEn) {
    shot1 += ` By the final frame, the blocking and object state must be exactly: ${worldStateEndEn}. This is a mandatory state change; the shot must not fall back to its opening state.`
  }
  // 情绪基调 → 光色/节奏词素（导演字段接入出片的第一落点）
  if (config.video?.h3EmotionToneVisual !== false) {
    const emotionVisual = emotionVisualOf(shot.emotion_tone || shot.emotionTone)
    if (emotionVisual) shot1 += ` The emotional register holds ${emotionVisual}.`
  }
  if (efIdx >= 0) {
    shot1 += ` The shot ends on <Picture ${efIdx + 1}>, reaching its exact final composition.`
  } else {
    // finalFrame 兜底（数据模型重构 C）：纯英文原文直用；含中文时用翻译器的 final_frame_en，
    // 不再因 pickEnglish 整段静默丢弃（旧逻辑下含一个中文字即整句报废）。
    // 同时剥掉原文自带的 "The final frame:" 前缀，避免与拼接句 "The shot ends on this final frame:" 重复。
    const ffRawText = zhNamesToEn(String(shot.final_frame || shot.finalFrame || '').replace(/@/g, ''))
      .replace(/^the final frame:\s*/i, '')
    const ffTranslated = String(translated.final_frame_en || '').trim().replace(/^the final frame:\s*/i, '')
    const finalFrameEn = cleanDesc(pickEnglish(ffRawText) || ffTranslated)
    if (finalFrameEn) shot1 += ` The shot ends on this final frame: ${finalFrameEn}.`
  }
  ddParts.push(shot1)
  if (config.video?.h3SingleTakeBlock !== false) ddParts.push(H3_SINGLE_TAKE_BLOCK)
  if (/static shot/i.test(cameraMove)) ddParts.push(STATIC_CAMERA_LOCK)
  if (dlgLines.length) ddParts.push(dlgLines.join(' '))

  const retryNoteEn = pickInjectableEnglish(retryNote)
  if (retryNoteEn) {
    ddParts.push(`MANDATORY CORRECTION FROM PREVIOUS FAILED TAKE — the previous take of this exact shot failed review for these specific reasons, and this take MUST fix them: ${retryNoteEn}`)
  }

  parts.push('detailed_description:')
  // 官方 ref-en.txt §5.2 L231 / §5.3 L246：重要主体首现处打 <Subject N> 标签。
  // 只标 character/scene/prop（anchor/storyboard 走 <Picture N>，已由上方显式引用句承载）；
  // 名字归一化与 subject_definitions L169 同口径，保证标签与定义能对上。
  const taggableSubjects = refs
    .map((r, i) => ({ index: i + 1, kind: r.kind, name: resolveAssetName(r.labelEn, r.label) }))
    .filter((r) => ['character', 'scene', 'prop'].includes(r.kind) && r.name)
  parts.push(tagSubjectFirstMentions(ddParts.join(' '), taggableSubjects))

  let soundscapeEn = pickEnglish(translated.soundscape_en) || stripResidualCjk(translated.soundscape_en) || pickEnglish(shot.overall_soundscape)
  // 与 world_state 同类：overall_soundscape 的英文源同样只有 LLM 翻译一条路（库内 36/36 镜是中文源）。
  // LLM 掉线时整段为空——官方 base-en.txt §4.6 禁止在非静音镜写 N/A，故只能空着；
  // 但「空着」必须让用户知道，否则声景信息无声消失（本镜声音只剩台词行）。
  if (canonicalPass && !soundscapeEn && String(shot.overall_soundscape || '').trim()) {
    ctx.onDegrade?.({ kind: 'soundscape-lost', source: 'needs-llm-translate', text: '', shotId: shot.id ?? null })
  }
  parts.push('overall_soundscape:')
  // 官方 base-en.txt §4.6：overall_soundscape 的 N/A 仅在"用户明确要求全片静音"时使用。
  // 项目无「全片静音」字段，故空值时不写 N/A（写 N/A 会被误判为静音镜）。
  if (enforceTrim > 0) {
    const tSnd = trimTailAtSentence(soundscapeEn, translated.__trimLeftAfterDesc ?? enforceTrim)
    translated.__trimLeftAfterDesc = Math.max(0, (translated.__trimLeftAfterDesc ?? enforceTrim) - (soundscapeEn.length - tSnd.length))
    soundscapeEn = tSnd
  }
  if (soundscapeEn) parts.push(soundscapeEn)

  let musicEn = pickEnglish(translated.music_en) || stripResidualCjk(translated.music_en) || pickEnglish(shot.non_diegetic_music)
  parts.push('non_diegetic_music:')
  // 官方 base-en.txt §4.7：non_diegetic_music 的 N/A 用于"没有配乐"的常规情况。
  if (enforceTrim > 0) musicEn = trimTailAtSentence(musicEn, translated.__trimLeftAfterDesc ?? 0)
  parts.push(musicEn || 'N/A')

  const finalPrompt = parts.join('\n')
  // 第二道防线（确定性裁剪）：预算产出仍超限（LLM 指令遵从残差，实测 7329 案例）→
  // 带裁剪量重组装一次，句边界裁扩写尾部，数学保证进线。骨架遍/裁剪遍不递归。
  if (enforceTrim === 0 && !ctx.__skeletonPass) {
    const h3LimitFinal = config.storyboard?.h3PromptCharLimit ?? 7000
    if (finalPrompt.length > h3LimitFinal) {
      const trimSlack = config.video?.h3PromptTrimSlack ?? 80
      const need = finalPrompt.length - h3LimitFinal + trimSlack
      console.warn(`[v4Video] 预算产出仍超限：${finalPrompt.length} > ${h3LimitFinal}，确定性裁剪 ${need} 字符（句边界、裁扩写尾部）`)
      return buildShotVideoPromptV4(shot, { ...ctx, __enforceTrim: need })
    }
  }
  return finalPrompt
}

async function extractLastFrameForContinuity(shotId, absVideo) {
  fs.mkdirSync(continuityDir, { recursive: true })
  const outPath = continuityTailImagePath(shotId)
  try {
    await runFfmpeg(['-y', '-sseof', '-0.05', '-i', absVideo, '-update', '1', '-frames:v', '1', outPath])
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) throw new Error('尾帧抽取输出为空')
  } catch (e) {
    // 残留的半截文件会让下一镜把坏图当续接锚，失败时必须清掉
    try { fs.rmSync(outPath, { force: true }) } catch {  }
    throw e
  }
  return outPath
}

// Video continuation 尾部片段时长上限：Ref2VA 参考视频语义，取上一镜末尾若干秒即可锚住
// 运动/环境/色调，短片自然取全长（-sseof 越过片头会自动夹到 0）。
const VC_TAIL_MAX_SECONDS = 15

// 抽上一镜成片尾部片段（≤ VC_TAIL_MAX_SECONDS 秒）作 Ref2VA video continuation 参考视频。
// 重新编码而非 -c copy：copy 从非关键帧起剪会开头花屏/定格，坏参考比没参考更糟。
export async function extractTailClipForContinuity(prevShotId, absVideo) {
  fs.mkdirSync(continuityDir, { recursive: true })
  const outPath = path.join(continuityDir, `shot_${prevShotId}_tail.mp4`)
  try {
    await runFfmpeg(['-y', '-sseof', `-${VC_TAIL_MAX_SECONDS}`, '-i', absVideo, '-t', String(VC_TAIL_MAX_SECONDS), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', outPath])
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) throw new Error('尾部片段抽取输出为空')
  } catch (e) {
    // 同尾帧：残留半截文件会被后续镜当有效参考，失败时必须清掉
    try { fs.rmSync(outPath, { force: true }) } catch {  }
    throw e
  }
  return outPath
}

// 占位视频：普通镜（switch=false）不走视频分支，但 ComfyUI 校验要求 LoadVideo 的 file
// 必须是账号里真实存在的文件——每次出片都主动传这个占位文件名，彻底不依赖 JSON 里烙的默认值。
// 占位本身用 ffmpeg 合成 1 秒黑场，落 generated 同级的 continuity 目录（系统自产目录）。
// V5 是唯一出片工作流，所有非续接镜都靠它过 LoadVideo 校验。
let placeholderVideoName = null
async function ensurePlaceholderVideo() {
  if (placeholderVideoName) return placeholderVideoName
  const tmp = path.join(continuityDir, 'placeholder_black_1s.mp4')
  fs.mkdirSync(continuityDir, { recursive: true })
  if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) {
    await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'color=black:s=256x256:d=1', '-c:v', 'libx264', '-preset', 'veryfast', tmp])
  }
  placeholderVideoName = await uploadMediaFileName(tmp)
  return placeholderVideoName
}

export async function generateShotVideoV4(params = {}, options = {}) {
  const { prompt, refs = [], audioRefs = [], shotId = 'x' } = params
  if (!prompt || !String(prompt).trim()) return { success: false, error: '出片提示词（prompt）不能为空' }
  if (!resolveWorkflowId('h3V4vc')) return { success: false, error: '出片工作流未配置：请在「AI 模型配置」的「视频通道」里添加并启用 h3V4vc（全能V5）工作流' }
  const { aspectRatio, megapixels, duration } = normalizeVideoParams(params)

  const refImages = (Array.isArray(refs) ? refs : []).map((r) => r?.image).filter(Boolean)
  const uniq = [...new Set(refImages)].slice(0, 9)
  const images = [...uniq]
  while (images.length < 9) images.push(BLANK_PNG)

  const values = { prompt: String(prompt).trim(), aspectRatio, megapixels, duration: String(duration) }
  // 底模 / 战斗 LoRA 名称与强度属工作流资源，由 config 提供（env 可覆盖），不在代码里写死文件名。
  values.combatLora = params.combatLora || config.video?.combatLoraName || ''
  values.combatLoraStrength = params.combatLoraStrength != null ? String(params.combatLoraStrength) : String(config.video?.combatLoraStrength ?? '0.5')
  values.unetName = params.unetName || config.video?.unetName || ''
  if (params.firstPassSteps != null) values.firstPassSteps = String(params.firstPassSteps)
  if (params.firstPassDenoise != null) values.firstPassDenoise = String(params.firstPassDenoise)
  if (params.secondPassSteps != null) values.secondPassSteps = String(params.secondPassSteps)
  if (params.secondPassDenoise != null) values.secondPassDenoise = String(params.secondPassDenoise)
  if (params.upscaleMegapixels != null) values.upscaleMegapixels = String(params.upscaleMegapixels)
  if (params.seed != null) values.seed = String(params.seed)
  values.refImageSize = params.refImageSize === 'max' ? 'max' : 'match'
    let useVc = false
    try {
    options.onProgress?.('uploading', { message: '上传参考图/音色...' })
    // 硬失败策略：参考图/音色上传失败直接中止本次任务（未消耗生成费），
    // 不再静默塞空白图/静音产废片。上传失败多为瞬态，任务层失败后可重试。
    const uploaded = []
    for (const src of images) {
      try { uploaded.push(await uploadMediaFileName(src)) }
      catch (e) {
        console.warn('[generateShotVideoV4] 参考图上传失败，中止出片:', e.message)
        return { success: false, error: `参考图上传失败，本镜已中止出片（未消耗生成任务）。请重试。原因: ${e.message}` }
      }
    }
    while (uploaded.length < 9) uploaded.push(await uploadMediaFileName(BLANK_PNG))
    for (let i = 0; i < uploaded.length; i++) values['image' + i] = uploaded[i]

    const audios = (Array.isArray(audioRefs) ? audioRefs : []).filter(Boolean).slice(0, 3)
    const audioSlots = [...audios]
    while (audioSlots.length < 3) audioSlots.push(SILENCE_WAV)
    for (let i = 0; i < audioSlots.length; i++) {
      try { values['audio' + i] = await uploadAudioV2(audioSlots[i]) }
      catch (e) {
        console.warn('[generateShotVideoV4] 音色上传失败，中止出片:', e.message)
        return { success: false, error: `音色上传失败，本镜已中止出片（未消耗生成任务）。请重试。原因: ${e.message}` }
      }
    }

    // video continuation（Ref2VA 官方续写通道）：上一镜尾部片段作参考视频，
    // duration 保持本镜原值（"参考视频"语义，非接龙生成）。
    if (params.continuationVideoSrc) {
      try {
        options.onProgress?.('uploading', { message: '上传上一镜尾部片段（video continuation）...' })
        values.video = await uploadMediaFileName(params.continuationVideoSrc)
        // 单图 Switch 版：切到 B 路径（1393B+视频链）。ComfyUI 后端 bool("false")==True，
        // 所以只在续接镜传 "true"；普通镜不传该字段，走默认 false 的 A 路径
        values.vcSwitchC = 'true'
        values.vcSwitchL = 'true'
        useVc = true
      } catch (e) {
        // 硬失败而非静默降级：prompt 已在路由层按 <Video 1> 续接语义构建，
        // 视频没挂上 = 提示词引用了不存在的 <Video 1>，必然出废片——浪费一次生成费还误导排查。
        // 中止让调用方重试（上传失败多为瞬态），比带着毒化提示词继续要便宜得多。
        console.warn('[generateShotVideoV4] 上一镜尾部片段上传失败，中止出片（避免失效续接提示词产废片）:', e.message)
        return { success: false, error: `上一镜尾部片段上传失败，本镜已中止出片（未消耗生成任务）。请重试；重试仍失败则上一镜成片可能损坏，需先重生上一镜。原因: ${e.message}` }
      }
    } else {
      // 普通镜也走 V5：主动传占位视频过 LoadVideo 校验（switch 缺省=false，视频分支不会执行）。
      // V5 是唯一出片工作流，占位失败无退路——硬失败中止（未消耗生成任务，重试便宜）。
      try {
        values.video = await ensurePlaceholderVideo()
      } catch (e) {
        console.warn('[generateShotVideoV4] 占位视频准备失败，中止出片:', e.message)
        return { success: false, error: `占位视频准备失败，本镜已中止出片（未消耗生成任务）。请重试。原因: ${e.message}` }
      }
    }
  } catch (e) {
    return { success: false, error: `参考图/音色上传失败: ${e.message}` }
  }

  const result = await runWorkflow('h3V4vc', values, {
    timeout: config.timeouts.workflow.video,
    ...options,
    usageContext: { task: 'video', ...options.usageContext },
  })
  if (!result.success || !result.url) return result

  try {
    options.onProgress?.('downloading', { message: '下载成片到本地...' })
    let buf = null
    try {
      buf = await downloadWithRetry(result.url, {
        validate: 'mp4', 
        onRetry: (n, waitMs, err) => console.warn(`[generateShotVideoV4] 成片下载第 ${n} 次失败（shot ${shotId}）: ${err.message}，${waitMs}ms 后重试`),
      })
    } catch (mainErr) {
      const altUrls = (Array.isArray(result.allResults) ? result.allResults : [])
        .map((r) => String(r?.url || '')).filter(Boolean)
        .filter((u) => u !== result.url)
      for (const u of altUrls) {
        try {
          const alt = await insecureDownload(u)
          if (isPlausibleMp4(alt)) {
            console.warn(`[generateShotVideoV4] 主节点下载失败（${mainErr.message}），备用节点救回（shot ${shotId}，${(alt.length / 1048576).toFixed(1)}MB）`)
            buf = alt
            break
          }
        } catch {  }
      }
      if (!buf) throw mainErr 
    }
  const filename = `shot_${shotId}_v4_${Date.now()}.mp4`
  fs.mkdirSync(uploadsDir, { recursive: true })
  fs.writeFileSync(path.join(uploadsDir, filename), buf)
  try {
    await extractLastFrameForContinuity(shotId, path.join(uploadsDir, filename))
  } catch (e) {
    console.warn(`[generateShotVideoV4] 尾帧抽取失败（不影响本镜成片，仅影响下一镜续接锚）: shot ${shotId}: ${e.message}`)
  }
  return { ...result, videoUrl: `${uploadsUrl(filename)}`, vcApplied: useVc }
  } catch (e) {
    console.warn(`[generateShotVideoV4] 成片落本地失败（shot ${shotId}），返回 24h 云端 URL:`, e.message)
    return { ...result, videoUrl: result.url, vcApplied: useVc, warning: '成片下载到本地失败，当前为 24 小时时效的云端链接，请尽快转存' }
  }
}
