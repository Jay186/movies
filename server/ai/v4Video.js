// 单镜出片服务（MiniMax H3 全能生视频 V4 workflow, h3V4）：
//  - 输入：参考图最多 9 槽（角色/场景/道具）+ 角色音色最多 3 槽 + 结构化 Ref2VA prompt → 5~15s 成片 mp4
//  - 与 multiRefVideo.js 同构，差异：参考图槽从 3 扩到 9；无视频参考槽、无提示词优化器，
//    prompt 必须为 Ref2VA 结构化格式（subject_definitions + <d>[Chinese] 台词</d>）。
//  - 2026-09-09 接入；节点映射见 config.js nodeMap.h3V4。
//
// ⚠️ 本文件产出的是【H3 官方六段】（全英文，仅 <d> 内台词中文）：
//      subject_definitions → summary → retention_analysis →
//      detailed_description → overall_soundscape → non_diegetic_music
//    与 DB 字段 shots.integrated_multimodal_description 的【图像六模块】（模块1~6，见
//    ai/storyboardRules.js integratedModulesRule）是**两套不同结构**，字段和消费方都不同，
//    不要互相套用。
//  - 结构约束：六段之外只允许顶部一行 guard（见下方 §0）；prompt 必须收在第六段。
//  - 规范：base-en.txt（T2VA 公共核心）/ ref-en.txt（全参考模式）
//  - Motion Context 续镜（音频连贯 #1，2026-09-11）：路由层反查上一镜成片传入
//    prevVideoUrl 时自动切 h3V4mc 工作流（h3V4 + 四件套：LoadVideo→GetVideoComponents→
//    MiniMaxH3MotionContext→Trim），上一镜成片经 context_frames/context_audio 锚定接缝；
//    latent 跨 API 任务被 RH 容器隔离判死，fc 成片回喂是唯一存活路线（见 AGENTS.md）。
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runWorkflow, uploadMediaFileName, uploadAudioV2, insecureDownload, downloadWithRetry, isPlausibleMp4 } from './runninghub.js'
import { translateShotFields, translateShotSize, translateCameraMovement, translateCameraAngle, translateTone } from './h3PromptTranslator.js'
import { config } from '../config.js'
// clean / pickEnglish / stripResidualCjk / resolveAssetName 统一到 shared.js（判据单点）。
// 原始背景：这三个「英文护栏」判据曾在本仓库各写 3 份拷贝（本文件 + ai/videoPrompt.js +
// ai/segmentPrompt.js），只有本文件在「浮冰」事件后给资产名装了 pickEnglish 复核——
// 另外两份英文名为空时回退中文名 → 中文落进 H3 英文正文。2026-09-18 收口到 ai/shared.js
// 单点，本文件改为 import 使用，禁止再抄一份。
import { clean as cleanShared, pickEnglish, stripResidualCjk, resolveAssetName, truncateStyle, formatCutTimestamp, pickInjectableEnglish } from './shared.js'
// parseDialogue 收口到 ai/dialogue.js（台词字段唯一读写口径，2026-09-18 第五轮 P0-3）。
import { parseDialogue } from './dialogue.js'
// 保持公开 API 不变：routes/generate-video.js 与 ai/videoPrompt.js 仍在 import 这两个判据。
export { pickEnglish, stripResidualCjk }

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const uploadsDir = path.join(__dirname, '..', 'uploads')

// 全透明 1x1 PNG：参考图全空时的兜底占位，防云端默认示例图污染画面
const BLANK_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

// 静音 WAV（data URI）：音色槽空占位，防云端示例音频污染成片音色
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

const VIDEO_ASPECT_RATIOS = [
  '1:1 (Square)', '2:3 (Portrait Photo)', '3:2 (Photo)', '3:4 (Portrait Standard)',
  '4:3 (Standard)', '9:16 (Portrait Widescreen)', '16:9 (Widescreen)', '21:9 (Ultrawide)',
]
const VIDEO_MEGAPIXELS = ['0.5', '0.75', '1.0']

// ⚠️ 故意与 ai/multiRefVideo.js 的 normalizeVideoParams 保持两份实现，不要合并！
//    · 本文件（V4 / 9 参考槽 Ref2VA）：默认 '9:16 (Portrait Widescreen)'，duration clamp 3~15s
//    · multiRefVideo.js（标准 / 3 参考槽）：默认 '9:16 (Portrait Widescreen)'，duration clamp 3~15s
//    两处默认 2026-09-11 起统一为竖屏 9:16，与 projects.aspect_ratio 的库级默认同源
//    （当前项目=一二布布系列，竖屏短剧形态）。
//    出片请求由前端从项目级 aspect_ratio 显式传入合法值覆盖；本兜底仅在漏传时生效，
//    且与项目级默认一致，不会出现"项目设了竖屏、漏传后悄悄变横屏"的漂移。
//    详见 ai/shared.js 顶部「故意不合并清单」。
function normalizeVideoParams(params = {}) {
  return {
    // 竖屏短剧默认 9:16；显式传入合法值则覆盖
    aspectRatio: VIDEO_ASPECT_RATIOS.includes(params.aspectRatio) ? params.aspectRatio : '9:16 (Portrait Widescreen)',
    megapixels: VIDEO_MEGAPIXELS.includes(String(params.megapixels)) ? String(params.megapixels) : '0.5',
    // ⚠️ 实际成片时长 ≠ 请求时长：H3 的 duration 输入会 snap 到模型 17 帧每块（17k+5 帧）网格
    // @24fps（官方 ComfyUI Prompt guide 明文）。有效档位（帧→秒）：73→3.04 / 90→3.75 / 107→4.46 /
    // 124→5.17 / 141→5.88 / 158→6.58 / 175→7.29 / 192→8.00 / 209→8.71 / 226→9.42 / 243→10.13 /
    // 260→10.83 / 277→11.54 / 294→12.25 / 311→12.96 / 328→13.67 / 345→14.38 / 362→15.08。
    // MC 验证实测的"5.17s"正是 124 帧档；overview.md 记录的"实际时长比 duration 字段长 ~0.5s"
    // 除 +1s MC 补偿外，此网格 snap 也在加时长（8s 请求 → 8.708s 成片）。
    // 上限口径（2026-09-13 放宽）：H3 官方模型支持 4-15s，h3V4 工作流 #1411 数学表达式
    // （max(5,·)+17帧对齐）无上限 clamp、#1412 的 10 只是默认值——旧"工作流上限 10s"系误记，
    // 已全链路统一放宽到 15s（V2/武戏引擎本来就是 5-15，不受影响）。
    duration: Math.min(15, Math.max(3, Math.round(Number(params.duration) || 5))),
  }
}

// clean 统一到 shared.js（原此处与 ai/videoPrompt.js / routes/generate.js 各有一份）
const clean = cleanShared
const cleanDesc = (s) => clean(s).replace(/[。.]+$/, '')
// parseDialogue 已从 ai/dialogue.js 引入（顶部 import）。⚠️ 返回值形态差异：
// dialogue.js 版恒返回**台词行数组**（无台词=[]），本文件旧本地版返回对象/null——
// 下方 `dlg ? (Array.isArray(dlg) ? dlg : [dlg]) : []` 对两种形态都归一为数组，行为等价
// （含 'null'/'{}'/脏串/单对象串等全边界，逐案核对过）。

// pickEnglish / stripResidualCjk 的实现已收口到 ai/shared.js（见顶部 import 处说明）。
// 此处原为第二份拷贝，已删除，禁止再抄一份——判据三份拷贝正是本轮中文泄漏事故的根因之一。

// 资产描述：优先用英文字段，回退到不含中文的旧字段；含中文则丢弃
// 去尾部标点（避免模板又加一个句号出现「..」），并小写首字母（该描述固定出现在句中/破折号后）
const lowerFirst = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : '')
const resolveDesc = (descEn, descCn) => lowerFirst(cleanDesc(pickEnglish(descEn) || pickEnglish(descCn)))

// 画风串截断（truncateStyle）已收口到 ai/shared.js（顶部 import），不再就地处一份。

// 资产名判据已收口到 ai/shared.js 的 resolveAssetName（顶部 import），不再就地处一份。
// 「浮冰」事件教训：中文原名经 pickEnglish 复核后返回 ''，由调用点 `|| reference N`
// 兜底给中性标签，绝不把中文塞进英文正文。

// 语气短语规范化：保证能自然接在 "speaks ..." 之后
// 映射表已按此规范产出；此处只兜底翻译层可能返回的裸短语（如 "hushed tone" → "in a hushed tone"）
const normalizeTone = (t) => {
  const v = clean(t)
  if (!v) return ''
  if (/^(in|with|through|at|while)\b/i.test(v)) return v
  if (/ly$/i.test(v)) return v
  return `in a ${v.replace(/\s+tone$/i, '')} tone`
}

// ── 喊叫抑制（2026-09-11 实验 C 实锤）──
// H3 一旦进入"喊叫合成模式"，会抛弃 <Audio N> 克隆音色、改用通用嗓音。
// 证据：同样 5 张参考槽 + 同一句台词 + 同一时间戳，仅把"鼓起腮帮喊话"改成"低声坚定地说"，
// F0 中位从 492Hz 回到 294Hz（布布样本 286Hz）、声纹与已验证好克隆相似度 0.807；
// 88 三版（含完整二采）全部因喊叫措辞失守。
// 处理：凡本镜存在音色克隆（audioRefs 非空），画面/动作/语气描述里的 shout/scream/yell/roar
// 类措辞一律换成稳的替词；视觉动作（挺胸、张嘴、攥拳）保留不动——那是给眼睛看的，不影响发声方式。
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
  // 裸 roar/growl 词族：TONE_MAP「咆哮 → in a roar」「低吼 → in a low growl」及 LLM 自由
  // 扩写里的 roars/roaring 都会穿透上面的成对词组。AGENTS.md 明文 roar/growl 同属高危词类。
  // 注意必须排在 furious roar / low growl 之后（成对词组优先命中，bare 词兜底）
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
// 导出给 videoPrompt.js（V2 链路语气词同口径收敛）
export { deShout }

// 发声用力「整句」消解（比换词更根本）：鼓腮 / 张大嘴 / 大口吸气 / 用力投射这类描写
// 即使不含 shout 一词，也会让模型判定"这是喊叫场景"而抛弃克隆音色（88 终版复现：
// 词层已无 shout，但"cheeks puff out dramatically… mouth opens wide… project a call out"
// 仍在，F0 依旧 543Hz）。凡克隆镜头，命中整句直接换成中性句。
// 模式放宽：LLM 每轮改写措辞（puffing its cheeks / opening its mouth wide / a large visible breath…），
// 字面匹配会漏，所以凡是句子提到 cheeks/mouth/project/大口吸气 就整句替换——克隆镜头宁保守勿冒险。
const EFFORT_SENT_RE = /\b(cheeks?|mouth|project\w*|maximum extent|volume of air|(?:large|deep|huge)[,\s]+(?:visible\s+)?breath|raises?\s+(?:its|his|her|their|the)\s+voice|forces?\s+the\s+voice|belt\w*\s+out)\b/i
// 口型锁定句豁免：「mouth/lips + closed/shut」是非说话角色的良性锁定（lips remain closed），
// 不是发声用力描写——误杀会让 H3 给不发声角色动嘴（克隆镜头尤其高危）
const LIP_LOCK_RE = /\b(mouth|lips?)\b[^.]{0,40}\b(closed|shut)\b|\b(closed|shut)\b[^.]{0,40}\b(mouth|lips?)\b/i
const stripEffortSentences = (s) =>
  String(s || '')
    .split(/(?<=\.)\s+/)
    .map((sent) => (EFFORT_SENT_RE.test(sent) && !LIP_LOCK_RE.test(sent) ? 'Its jaw sets with quiet resolve.' : sent))
    .join(' ')
// 克隆镜头的描述清洗管线：先消解用力整句，再收敛喊叫词
// （导出给 videoPrompt.js——V2 出片链路同口径喊叫抑制，别再造第二份）
export const cleanVoiceDescription = (s) => deShout(stripEffortSentences(s))

// 运镜表已统一收敛到 h3PromptTranslator.js（本文件曾有一份 CAMERA_PHRASES 死代码，已删除）

/**
 * V4 版 Ref2VA 结构化提示词（官方规范六段格式）：
 * subject_definitions → summary → retention_analysis → detailed_description → overall_soundscape → non_diegetic_music
 * 官方文档：github.com/MiniMax-AI/MiniMax-H3 → skills/h3-prompt-writing/references/ref-en.txt
 *
 * 关键规则：
 *  - 全英文书写，只有 <d> 里的台词保留中文
 *  - summary 前缀：[reference generation]，有帧锚（continuity/endframe）叠加
 *    [keyframe completion]，有音色再叠加 [audio reference]（多类型 " + " 连接）
 *  - detailed_description 以 [Shot 1] 开头
 *  - 帧锚定句式（官方 ref-en §5.3）：continuity/endframe 用 The shot begins from /
 *    The shot ends on，storyboard 构图锚用 The camera viewpoint ... follow
 *  - 场景光影常量（scenes.lighting_en → refs[].lightingEn）：subject_definitions /
 *    summary / detailed_description 三处逐字同一句，跨镜钉死光照（#2 光影常量）
 *  - 运镜三要素：类型 + 幅度 + 速度
 *  - 说话人格式：<Subject N> (Sx) ... says, <d>[Chinese] ...</d>
 *
 * @param {Object} shot - shots 表一行
 * @param {Object} ctx - { stylePrompt, refs, audioRefs, isCombat }
 * @returns {Promise<string>} 完整 prompt
 */
export async function buildShotVideoPromptV4(shot = {}, ctx = {}) {
  const { stylePrompt = '', stylePromptEn = '', refs = [], audioRefs = [], isCombat = false, translate, speakerIds, retryNote = '', combatNote = '' } = ctx
  const tr = typeof translate === 'function' ? translate : translateShotFields
  const parts = []

  const duration = Math.min(15, Math.max(3, Math.round(Number(shot.duration) || 5)))
  const shotStart = Number(shot.start_time) || 0

  // ── 0) 顶部 guard ──
  // 官方格式只有六段，六段之外**只允许这一行**（AGENTS.md 禁止六段外游离文本）。
  // 一行合并两条保护：① 不朗读/复述非台词文本（历史坑：guard 中文被模型当台词念出来）
  //                    ② 画面不得出现非预期文字、字幕、水印
  // 放在最顶部而非末尾：模型对首尾权重更高；且 prompt 必须严格收在第六段，
  // 否则末尾的游离句子会被当作待生成内容的一部分。
  parts.push('Director guidance below is for visual generation only: do not read aloud, narrate, or quote any of it — speak only the dialogue inside <d> tags. The generated video must contain no on-screen text, subtitles, watermark, or logo.')

  // ── 1) 先解析台词，确定【实际发声顺序】──
  // 官方 base-en.txt §4.4：(Sx) 全片只分配一次、按 actual vocal events 先后排序，
  // 且「characters who never vocalize receive no speaker ID」——所以不能逐镜重编、
  // 也不能给不发声的角色编号（逐镜编号会让同一角色在不同镜头拿到不同 Sx）。
  const dlg = parseDialogue(shot.dialogue)
  const lines = dlg ? (Array.isArray(dlg) ? dlg : [dlg]) : []
  const vocalEvents = []
  for (const d of lines) {
    const who = clean(d?.character || d?.speaker || d?.name)
    const text = clean(d?.text || d?.line || d?.content)
    if (!text) continue
    vocalEvents.push({ d, who, text, subjIdx: refs.findIndex((r) => r.label === who || r.labelEn === who) })
  }
  // subjectNum → Sx：只登记「全片会发声」的角色。
  // speakerIds 由路由层按全片播放顺序预先算好（角色名 → Sx），跨镜稳定；
  // 缺失时（离线自检/单测）退化为按本镜发声顺序编号，保持可跑。
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

  // ── 2) subject_definitions ──
  // 官方完整示例中 <Audio N> 音色定义属于本段【段内】，不得单独成段。
  const subjectLines = refs.map((r, i) => {
    // storyboard 图走官方 <Picture N> 独立定义（ref-en.txt §2.2）：它是构图锚
    // （机位/主体布局/构图），不是可复用主体，因此不进 <Subject N> 序列。
    if (r.kind === 'storyboard') {
      return `<Picture ${i + 1}> is a storyboard reference for [Shot 1], defining its camera viewpoint, subject placement, and composition.`
    }
    // continuity（上一镜末帧）：继承角色/环境状态 + **色温/光照/色调**（2026-09-12 锁2），不锁机位——
    // 与 storyboard 构图锚分流：跨镜景别变化（如全景→中景）时锁机位会把本镜拍成上一镜的复制；
    // 但色温必须锁：3-1 暖金夕阳 vs 3-2 冷蓝（CCT差1411K）实锤「色温归文字管」会被光影措辞带漂。
    if (r.kind === 'continuity') {
      return `<Picture ${i + 1}> is the final frame of the previous shot, provided as a continuity anchor: the characters' positions, postures, orientations, relative sizes, the environment state (snow cover, ice field), AND the exact color temperature, lighting direction, and tonal palette continue seamlessly from this frame — the color grade must match this frame exactly, with no shift toward warmer or cooler tones. It anchors character, environment, and color grade, NOT the camera viewpoint.`
    }
    // endframe（本镜目标尾帧，frame_url2）：官方 ref-en §2.2 的 last-frame 用法——
    // 与首帧/连续性锚配对成首尾双锚，成片必须收在该帧的构图上
    if (r.kind === 'endframe') {
      return `<Picture ${i + 1}> is the target last frame of [Shot 1], the final composition and character positions this shot must end on.`
    }
    // styleanchor（全集风格锚，Sora 招，2026-09-12）：每集第一镜成片末帧——
    // Sora remix 官方建议"后续生成永远锚定第一个视频"，防接力链把画风逐步带偏。
    // 锚死全序列的画风/线稿/水彩质感/调色，写实化漂移到此为止。
    if (r.kind === 'styleanchor') {
      return `<Picture ${i + 1}> is the final frame of the opening shot of this episode, provided as the absolute art-style anchor: every character, environment and effect in this shot MUST stay in this exact hand-drawn watercolor rendering style — same linework, texture, color palette and tonal grade. Never drift toward photorealistic, CGI or 3D rendering in any part of the frame.`
    }
    const typeLabel = r.kind === 'character' ? 'character' : (r.kind === 'prop' ? 'prop' : 'scene/environment')
    const name = resolveAssetName(r.labelEn, r.label) || `reference ${i + 1}`
    const d = resolveDesc(r.descEn, r.desc)
    // 场景光影常量（scenes.lighting_en，#2 光影常量 2026-09-11）：同一场景所有镜头
    // 逐字复用同一句，跨镜钉死光源方位/色温。pickEnglish 护栏：空/含中文一律不注入。
    const lighting = r.kind === 'scene' ? cleanDesc(pickEnglish(r.lightingEn)) : ''
    return `<Subject ${i + 1}> is ${name} (${typeLabel}) from <Picture ${i + 1}>${d ? `, ${d}` : ''}.${lighting ? ` The lighting of this scene is constant: ${lighting}.` : ''}`
  })
  const audioLines = audioRefs.map((a, i) => {
    // (Sx) 用全片编号；该角色全片从不发声时干脆不写 (Sx)，而不是编一个不存在的号
    const sId = speakerIdMap.get(a.subjectNum)
    const idPart = sId ? ` (${sId})` : ''
    return `<Audio ${i + 1}> is the voice-timbre reference for <Subject ${a.subjectNum}>${idPart}. Extract ONLY the vocal timbre from it. The reference audio contains sample speech that must NEVER be played back, quoted, hummed, or echoed in the generated soundtrack. All spoken output comes exclusively from the <d> dialogue lines below.`
  }).filter(Boolean)
  parts.push('subject_definitions:')
  parts.push([...subjectLines, ...audioLines].join('\n'))
  // 属性串味防线（2026-09-13）：6-3 实测——布布的蓝围巾被"转移"到巨熊脖子上（同框时显著服饰特征
  // 被错配到体型最大的角色），且巨熊形体漂成写实北极熊（资产的钢针炸毛萌兽形态丢失）。
  // 修法：在 subject_definitions 段内加一条通用归属声明（官方允许的段落内说明，不新增标签）：
  // 服饰/配饰只属于其自己参考图里的角色；形体比例与脸部结构照各自参考图，不随体型/动作描述漂移。
  parts.push('Accessories and garment details belong exclusively to the character who wears them in that character\'s own <Picture N> reference image — never add, remove, or transfer any accessory (scarf, hat, bag, glasses) from one character to another, and never dress a character that wears none. Every character keeps the exact body proportions, face structure and rendering style of its own reference image regardless of how its size, power or action is described in this shot.')

  // ── 3) summary（任务类型前缀；有音色引用时按官方要求叠加 + audio reference）──
  // 风格串必须是英文：中文画风描述一律不进正文（旧 stylePrompt 仅在其本身为英文时才用）
  const style = truncateStyle(pickEnglish(stylePromptEn) || pickEnglish(stylePrompt), 300)
  const sceneRef = refs.find((r) => r.kind === 'scene')
  const sceneLabel = sceneRef ? resolveAssetName(sceneRef.labelEn, sceneRef.label) : ''
  // 场景光影常量：取第一个带 lighting 的场景槽（多场景镜少见，以首个非空为准）。
  // summary / subject_definitions / detailed_description 三处逐字同一句——
  // 结构性重复注入本身就是「常量」语义的锚定手段（同 continuation 帧锚的多点声明）。
  const sceneLighting = cleanDesc(pickEnglish(refs.find((r) => r.kind === 'scene' && pickEnglish(r.lightingEn))?.lightingEn))
  // 任务类型前缀（官方 ref-en §3）：帧锚——continuity（上一镜末帧作本镜开场）和
  // endframe（本镜目标尾帧）——语义是 "an image serves as the target video's first
  // frame / last frame"，必须叠加 keyframe completion；storyboard 构图锚是
  // shot-planning reference，仍属 reference generation。多类型用 " + " 连接，顺序不限重复不写。
  const hasFrameAnchor = refs.some((r) => r.kind === 'continuity' || r.kind === 'endframe')
  const taskTypes = ['reference generation']
  if (hasFrameAnchor) taskTypes.push('keyframe completion')
  if (audioRefs.length) taskTypes.push('audio reference')
  const taskPrefix = `[${taskTypes.join(' + ')}]`
  parts.push('summary:')
  parts.push(`${taskPrefix} The target video is a ${duration}-second single-shot clip${style ? ` in the reference style (${style})` : ''}.${sceneLabel ? ` The scene is set in ${sceneLabel}.` : ''}${sceneLighting ? ` Scene lighting: ${sceneLighting}.` : ''} All visual elements must strictly match their reference appearances.`)

  // ── 4) retention_analysis ──
  // 角色参考图是三视图合并图（正面/侧面/背面）。若只写「fully_preserved」，
  // 模型会无脑复制整张图里最大最显眼的正面视角，导致「背对/侧面」等构图指令失效
  // （历史坑：1-1 分镜要求小熊只露后脑勺、大白熊背对镜头，成片却拍成正面合影）。
  // 所以对角色追加一条「按朝向选对应角度」的条件式提示；场景/道具非三视图，不加。
  parts.push('retention_analysis:')
  const visualRetention = refs.map((r, i) => {
    if (r.kind === 'storyboard') {
      return `<Picture ${i + 1}> (storyboard reference for [Shot 1]): fully_preserved - the camera viewpoint, subject placement, and composition from <Picture ${i + 1}> are followed in [Shot 1].`
    }
    // continuity 锚：partially_preserved——保留角色/环境状态 + 色温/光照/色调（锁2），机位与构图按本镜景别重新取景
    if (r.kind === 'continuity') {
      return `<Picture ${i + 1}> (continuity anchor for [Shot 1]): partially_preserved - the characters' positions, postures, orientations, relative sizes, the environment state, and the exact color temperature, lighting direction, and tonal palette from <Picture ${i + 1}> are retained at the opening of [Shot 1] with no color shift; the camera viewpoint and composition reframe to [Shot 1]'s described shot size.`
    }
    // endframe 锚：fully_preserved——成片必须收在该帧的构图/角色位置上（官方 §4.1 标记）
    if (r.kind === 'endframe') {
      return `<Picture ${i + 1}> ([Shot 1] last frame): fully_preserved - the video ends on the exact final composition, character positions, and environment state shown in <Picture ${i + 1}>.`
    }
    const d = resolveDesc(r.descEn, r.desc)
    const multiViewHint = r.kind === 'character'
      ? ` When the character is not shown front-facing (e.g. seen from behind, facing away, or in profile), use the matching view from <Picture ${i + 1}> instead of the front view.`
      : ''
    return `<Subject ${i + 1}> (appears in [Shot 1]): fully_preserved - ${d || 'appearance'} is retained from <Picture ${i + 1}>.${multiViewHint}`
  }).join('\n')
  // 音频保留关系（官方 ref-en §4.2 标记 + §5 完整示例：音色参考用 reference 标记且必须单独成行——
  // 缺了这行 <Audio N> 绑定强度不够，模型会忽略音色样本、自己合成一把声音。88 实测 F0 525Hz
  // vs 布布样本 286Hz 即为此因）
  const audioRetention = audioRefs.map((a, i) => {
    const sId = speakerIdMap.get(a.subjectNum)
    const idPart = sId ? ` (${sId})` : ''
    return `<Audio ${i + 1}>: reference - its vocal timbre guides the dialogue delivery of <Subject ${a.subjectNum}>${idPart} without copying the original signal.`
  })
  parts.push([visualRetention, ...audioRetention].filter(Boolean).join('\n'))

  // ── 5) detailed_description（全英文 + [Shot 1] + 翻译/扩写层）──
  const characterNames = refs.filter((r) => r.kind === 'character').map((r) => r.label)
  const sceneNames = refs.filter((r) => r.kind !== 'character').map((r) => r.label)
  // 音色克隆镜头的译文必须走"平稳发声"口径（翻译层规则 7）：把发声角色名传下去，
  // 否则翻译层会把"鼓起腮帮喊话"扩写成 puffed cheeks / mouth wide open / projecting 之类用力描写
  const voicedNames = audioRefs.map((a) => refs[a.subjectNum - 1]?.label).filter(Boolean)
  // 克隆一份再改：translateShotFields 的结果会被 translationCache 缓存复用，
  // 原地改写（下方 zhNamesToEn 中文名→英文名替换）会污染缓存——同文本但 refs 不同的
  // 下一镜（如角色英文名改过）命中缓存时拿到的是上一镜替换过的旧名字
  const translated = { ...(await tr(shot, { characterNames, sceneNames, voiceClone: audioRefs.length > 0, voicedNames })) }

  // 关键修复：翻译层按规则保留中文角色/场景/道具名（h3PromptTranslator 的 user message
  // 明确要求"保留原文不翻译"），但下方 pickEnglish 检出任意 CJK 即整段丢弃 ——
  // 这导致所有镜头的 description_en / action_note_en 被静默清空，H3 从未见过画面描述
  // （soundscape/tone 不含人名才幸存）。这里先把中文名确定性替换为对应英文名
  // （与 <Subject N> 定义行同源，替换后描述还能和 Subject 对上号），再交给 pickEnglish。
  // 按名字长度降序替换，防止短名前缀误伤长名。
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

  const shotSize = translateShotSize(shot.shot_type)
  const cameraMove = translateCameraMovement(shot.camera_movement)
  const cameraAngle = translateCameraAngle(shot.camera_angle)
  // 兜底只在原字段本身已是英文时才用——中文原字段一律丢弃（宁缺勿脏）
  // 同时去掉尾部句号：模板会在句末再补一个句号，否则出现 "crust.."
  // 本镜有音色克隆时再过一道喊叫抑制（见 deShout 注释：喊叫措辞会让模型丢弃克隆音色）
  const voiceClone = audioRefs.length > 0
  const rawAction = cleanDesc(pickEnglish(translated.action_note_en) || stripResidualCjk(translated.action_note_en) || pickEnglish(shot.action_note))
  const rawVisual = cleanDesc(pickEnglish(translated.description_en) || stripResidualCjk(translated.description_en) || pickEnglish(shot.description))
  const actionDesc = voiceClone ? cleanVoiceDescription(rawAction) : rawAction
  const visualDesc = voiceClone ? cleanVoiceDescription(rawVisual) : rawVisual

  const dlgLines = []
  // 语气回退粒度：translated.tone_en 是全镜所有语气词的合并翻译——本镜有多种不同语气时，
  // 单句未命中映射表就拿合并译文兜底，会把别句的语气张冠李戴；仅全镜语气唯一时允许回退
  const distinctTones = new Set(vocalEvents.map((ev) => clean(ev.d?.tone)).filter(Boolean))
  const toneFallbackEn = distinctTones.size <= 1 ? pickEnglish(translated.tone_en) : ''
  for (const ev of vocalEvents) {
    const { d, who, text, subjIdx } = ev
    // 语气：确定性映射优先 → 翻译层英文 → 省略（绝不回传中文）
    // 同样过喊叫抑制："大喊/喊道 → while shouting"、"'怒吼 → furious roar" 都会毁掉克隆音色
    const rawTone = normalizeTone(translateTone(d?.tone) || toneFallbackEn)
    const toneEn = voiceClone ? deShout(rawTone) : rawTone
    // (Sx) 取全片编号：优先按参考槽定位，其次按角色名；
    // 全片从不发声者拿不到编号 → 不写 (Sx)，也不编造 'S1'
    const sId = (subjIdx >= 0 ? speakerIdMap.get(subjIdx + 1) : null)
      || (speakerIds instanceof Map ? speakerIds.get(who) : null)
    // 说话人引用：命中参考槽写 <Subject N>；未命中（缺图未进 refs / 台词写了清单外的角色名或旁白）
    // 时 **who 必须过 pickEnglish 复核**——中文角色名一律不得落进英文正文，降级为中立的
    // 'the character'（与 ai/segmentPrompt.js 逐字同源，两条通道判据必须一致）。
    const speakerRef = subjIdx >= 0
      ? `<Subject ${subjIdx + 1}>${sId ? ` (${sId})` : ''}`
      : `${pickEnglish(who) || 'the character'}${sId ? ` (${sId})` : ''}`
    // 时间戳：dialogue.startTime 为全片绝对秒，换算成镜内相对秒。
    // 走 shared.formatCutTimestamp（与段级同口径）：旧内联写法在 rel 小数部分 ≥0.9995 时
    // 会输出 4 位毫秒（如 At 00:12.1000）——非法 MM:SS.mmm，H3 切点标记失效（审计 P0-C）。
    let t = ''
    if (d?.startTime != null && d.startTime !== '') {
      const rel = Number(d.startTime) - shotStart
      if (!isNaN(rel) && rel >= 0 && rel <= duration) {
        t = `At ${formatCutTimestamp(rel)}, `
      }
    }
    // 官方示例统一用 says（base-en §4.4 / ref-en §5.4：`... (S1) says, <d>...`）
    // 音色绑定句式（官方 ref-en §5 示例：'...using the ... voice timbre referenced from
    // <Audio 1>, exclaims...'）——放在 says/tone 之后、<d> 之前；缺了它 + retention 行，
    // 模型会忽略音色参考自合成声音（88 实测踩坑）
    const aIdx = subjIdx >= 0 ? audioRefs.findIndex((a) => a.subjectNum === subjIdx + 1) : -1
    const timbreClause = aIdx >= 0 ? `, using the voice timbre referenced from <Audio ${aIdx + 1}>` : ''
    // 克隆发言额外钉一句"不升调"：88 实测仅去掉 shout 词不够（用力描写仍在），
    // 显式声明 soft/steady 才能让模型留在克隆音色区（对照实验 C 的成功句式）
    const steadyClause = aIdx >= 0 ? ', softly and steadily' : ''
    const toneClause = toneEn ? ` says ${toneEn}${steadyClause}${timbreClause},` : ` says${steadyClause}${timbreClause},`
    // 官方格式：<Subject N> (Sx) <说话方式> says, <d>[Chinese] 台词</d>
    dlgLines.push(`${t}${speakerRef}${toneClause} <d>[Chinese] ${text}</d>`)
  }

  const ddParts = []
  // 风格句（在 [Shot 1] 之前）
  if (style) ddParts.push(`The target video is in a cinematic, ${style} style.`)
  // 武戏内容修饰独立通道（2026-09-13）：combatNote 含 Combat LoRA 触发词（prfight1/prfin1）
  // 与打击重量感措辞，整句走 detailed_description，不经 truncateStyle 300 字截断的 style 通道。
  if (combatNote) ddParts.push(pickEnglish(combatNote) ? cleanDesc(combatNote) + '.' : '')
  // [Shot 1] 开头 + 景别 + 画面描述 + 构图锚声明 + 机位角度 + 运镜 + 动作
  const sbIdx = refs.findIndex((r) => r.kind === 'storyboard')
  const ctIdx = refs.findIndex((r) => r.kind === 'continuity')
  const efIdx = refs.findIndex((r) => r.kind === 'endframe')
  let shot1 = `[Shot 1] A ${shotSize}`
  if (visualDesc) shot1 += `, ${lowerFirst(visualDesc)}`
  shot1 += '.'
  // 场景光影常量：开场一句钉住光照（与 subject_definitions / summary 同一句逐字重复）。
  // 放在帧锚/机位之前——先给场景级光照，再谈本镜取景。
  if (sceneLighting) shot1 += ` The scene lighting remains constant throughout: ${sceneLighting}.`
  // 构图锚声明放在机位角度之前：先给模型视觉锚，再用 camera_angle 文字补强同一件事
  if (sbIdx >= 0) shot1 += ` The camera viewpoint, subject placement, and composition of this shot follow <Picture ${sbIdx + 1}>.`
  // 末帧继承（官方帧锚定句式 ref-en §5.3「the shot begins from <Picture N>」）：
  // 开场承接上一镜末帧的角色/环境状态，机位仍按本镜景别重新取景（不锁机位——
  // 跨镜景别变化时锁机位会把本镜拍成上一镜的复制，与 storyboard 构图锚互不冲突）
  if (ctIdx >= 0) shot1 += ` The shot begins from <Picture ${ctIdx + 1}>, the final frame of the previous shot: the characters' positions, postures, orientations, the environment state, and the exact color temperature, lighting direction, and tonal palette continue from that frame with no color shift; the camera viewpoint and composition reframe to [Shot 1]'s described shot size.`
  if (cameraAngle) shot1 += ` ${cameraAngle.charAt(0).toUpperCase()}${cameraAngle.slice(1)}.`
  if (cameraMove) shot1 += ` The camera ${cameraMove}.`
  if (actionDesc) shot1 += ` ${actionDesc}.`
  // 尾帧锚（官方句式「the shot ends on <Picture N>」）：与首帧/连续性锚配对，
  // 模型在首尾两帧之间插值连续路径（FL2VA 思想），成片收在该帧构图上。
  // 视觉锚（frame_url2）缺失时，用 final_frame 文字兜底——final_frame 是分镜必填的
  // 「本镜最终画面英文精确描述」（角色位置/朝向/道具状态），历史上 frame_url2 全空、
  // final_frame 又没喂，导致「成片收在什么画面」完全无约束（2026-09-14 审计）。
  // 文字版走同一「The shot ends on」句式，与视觉锚语义一致；有图用图、无图用文，不叠加。
  if (efIdx >= 0) {
    shot1 += ` The shot ends on <Picture ${efIdx + 1}>, reaching its exact final composition.`
  } else {
    const finalFrameEn = cleanDesc(pickEnglish(zhNamesToEn(String(shot.final_frame || shot.finalFrame || '').replace(/@/g, ''))))
    if (finalFrameEn) shot1 += ` The shot ends on this final frame: ${finalFrameEn}.`
  }
  ddParts.push(shot1)
  if (dlgLines.length) ddParts.push(dlgLines.join(' '))

  // 闭环回灌（2026-09-12，Character.ai eval-in-the-loop）：上次观片验收 fail 的修正指令，
  // 由路由层译成英文从 ctx.retryNote 传入，注入 detailed_description 段内（不违反"六段之外
  // 无游离文本"约束）。8-2"剧本写倒地、视频站着"这类节拍级错误靠它在重出时被强制修正。
  //
  // ⚠️ retryNote 必须过守卫后才能落进英文正文：路由层只是**口头**要求 LLM
  // 译成英文（无残留校验），而 V4 单镜通道**没有结构校验**（只有段级 validateSegmentPrompt），
  // 中文残留会静默落进英文正文、毁掉成片而币照烧。
  // 判据选择（F1，2026-09-18 升级为 pickInjectableEnglish = 删残 CJK + 至少一个 ASCII 字母）：
  // 这里**不能用 pickEnglish**——retryNote 是「译文片段」，pickEnglish 检出任意 CJK
  // 即整段丢弃，会静默吃掉用户的重出修正指令；删词保段能保住英文部分。
  // 旧写法 stripResidualCjk + truthy 判空会放过 ',;' / '!!!' 这类只剩标点的译文空壳
  // （既无脏字符又非空）→ 注入 `MANDATORY CORRECTION: ,;` 占模型注意力、无可执行指令。
  // 守卫后为空则**整句不注入**（不留 `MANDATORY CORRECTION:` 空壳）。
  const retryNoteEn = pickInjectableEnglish(retryNote)
  if (retryNoteEn) {
    ddParts.push(`MANDATORY CORRECTION FROM PREVIOUS FAILED TAKE — the previous take of this exact shot failed review for these specific reasons, and this take MUST fix them: ${retryNoteEn}`)
  }

  parts.push('detailed_description:')
  parts.push(ddParts.join(' '))

  // ── 6) overall_soundscape ──（官方：无内容写 N/A，不得整段消失）
  const soundscapeEn = pickEnglish(translated.soundscape_en) || stripResidualCjk(translated.soundscape_en) || pickEnglish(shot.overall_soundscape)
  parts.push('overall_soundscape:')
  parts.push(soundscapeEn || 'N/A')

  // ── 7) non_diegetic_music ──（官方完整示例结尾即 non_diegetic_music: / N/A）
  // prompt 到此结束——六段之后不再追加任何句子，保证结构严格等于官方格式。
  const musicEn = pickEnglish(translated.music_en) || stripResidualCjk(translated.music_en) || pickEnglish(shot.non_diegetic_music)
  parts.push('non_diegetic_music:')
  parts.push(musicEn || 'N/A')

  return parts.join('\n')
}

/**
 * 生成单镜成片（h3V4 工作流；传 prevVideoUrl 时自动切 h3V4mc 续镜版）。
 * @param {Object} params
 * @param {string} params.prompt - Ref2VA 结构化提示词（buildShotVideoPromptV4 产出）
 * @param {Array} params.refs - 参考槽 [{ label, desc, kind, image }]，最多 9 个
 * @param {Array} params.audioRefs - 角色音色源列表（/uploads/ 路径），最多 3 个
 * @param {string} params.shotId
 * @param {string} params.aspectRatio / params.megapixels / params.duration
 * @param {string|number} [params.combatLoraStrength] - 打斗 LoRA 强度（武戏 0.5 / 文戏 0）
 * @param {string} [params.prevVideoUrl] - 上一镜成片（/uploads/ 路径或 http URL），
 *   传入即走 Motion Context 续镜（h3V4mc：上一镜成片 → context_frames/context_audio 锚定接缝）
 * @param {Object} options - 透传 runWorkflow
 */
export async function generateShotVideoV4(params = {}, options = {}) {
  const { prompt, refs = [], audioRefs = [], shotId = 'x' } = params
  if (!prompt || !String(prompt).trim()) return { success: false, error: '出片提示词（prompt）不能为空' }
  const { aspectRatio, megapixels, duration } = normalizeVideoParams(params)

  const refImages = (Array.isArray(refs) ? refs : []).map((r) => r?.image).filter(Boolean)
  const uniq = [...new Set(refImages)].slice(0, 9)
  // 全槽启用后 9 个参考图槽必须传满，未用槽填透明图防示例图污染
  const images = [...uniq]
  while (images.length < 9) images.push(BLANK_PNG)

  const values = { prompt: String(prompt).trim(), aspectRatio, megapixels, duration: String(duration) }
  // 打斗 LoRA：本地导出时 lora_name 带了 minimax_h3\ 前缀，云端是扁平命名，运行时覆盖为正确名
  values.combatLora = params.combatLora || 'H3_Combat_V2.safetensors'
  // 打斗 LoRA 强度：武戏 0.5、文戏 0（由调用方按场次判断传入），未传时沿用工作流固化 0.5
  values.combatLoraStrength = params.combatLoraStrength != null ? String(params.combatLoraStrength) : '0.5'
  // UNET 主模型：本地导出带 MiniMax-H3\ 子目录前缀，云端扁平命名（运行时覆盖，去前缀）
  values.unetName = params.unetName || 'Minimax-h3_Singularity_ref2va_Pruned_v1.3_int8.safetensors'
  // 采样层：仅在调用方显式传入时覆盖，未传则沿用工作流固化值（一采 simple/6 步/1.0，二采 beta/4 步/0.4，放大 1MP）
  if (params.firstPassSteps != null) values.firstPassSteps = String(params.firstPassSteps)
  if (params.firstPassDenoise != null) values.firstPassDenoise = String(params.firstPassDenoise)
  if (params.secondPassSteps != null) values.secondPassSteps = String(params.secondPassSteps)
  if (params.secondPassDenoise != null) values.secondPassDenoise = String(params.secondPassDenoise)
  if (params.upscaleMegapixels != null) values.upscaleMegapixels = String(params.upscaleMegapixels)
  // 随机种子：仅在显式传入时锁定（修跨镜连贯性时保住满意构图微调 prompt）；
  // 不传则云端按工作流 randomize 模式随机（nodeMap.h3V4.seed → #129 RandomNoise）
  if (params.seed != null) values.seed = String(params.seed)
  // 注意：1317 二采模型(fp16)、1309 预览 tiny_vae(taeh3) 的默认值云端都有（无前缀），不覆盖
  // MC 续镜开关：声明在 try 块外——runWorkflow 的工作流选择要用（曾因块级作用域炸 useMc is not defined）
  let useMc = false
  try {
    options.onProgress?.('uploading', { message: '上传参考图/音色...' })
    const uploaded = []
    for (const src of images) {
      try { uploaded.push(await uploadMediaFileName(src)) }
      catch (e) {
        // 空白图【原位】占位：跳过该槽会让后续图全部前移一位，
        // prompt 里 <Picture N>/<Subject N> 与 image(N-1) 槽整体错位（声画不对人）
        console.warn('[generateShotVideoV4] 参考图上传失败，空白图原位占位:', e.message)
        uploaded.push(await uploadMediaFileName(BLANK_PNG))
      }
    }
    while (uploaded.length < 9) uploaded.push(await uploadMediaFileName(BLANK_PNG))
    for (let i = 0; i < uploaded.length; i++) values['image' + i] = uploaded[i]

    // 3 个音色槽传满，未用槽填静音防示例音频污染（纯动作镜成片仍无语音）
    const audios = (Array.isArray(audioRefs) ? audioRefs : []).filter(Boolean).slice(0, 3)
    const audioSlots = [...audios]
    while (audioSlots.length < 3) audioSlots.push(SILENCE_WAV)
    for (let i = 0; i < audioSlots.length; i++) {
      try { values['audio' + i] = await uploadAudioV2(audioSlots[i]) }
      catch (e) {
        // 失败槽补静音原位：空槽不上传会沿用云端工作流的示例音频
        // （未用槽填静音正是为了防示例音频污染，失败跳过等于破防）
        console.warn('[generateShotVideoV4] 音色上传失败，静音原位占位:', e.message)
        values['audio' + i] = await uploadAudioV2(SILENCE_WAV)
      }
    }

    // ── Motion Context 续镜（音频连贯 #1）──
    // 上一镜成片回喂：上传后经 h3V4mc 的 context_frames/context_audio 锚定接缝（fc 路线，
    // latent 跨任务被 RH 容器隔离判死）。上传失败 / h3V4mc 未配置 ID 时降级普通 h3V4——
    // 降级后 values.video 在 h3V4 的 nodeMap 无槽，runWorkflowImpl 会自动忽略，接缝不保证但出片不中断。
    if (params.prevVideoUrl && config.runninghub?.workflows?.h3V4mc) {
      try {
        options.onProgress?.('uploading', { message: '上传上一镜成片（Motion Context 接龙）...' })
        values.video = await uploadMediaFileName(params.prevVideoUrl)
        // Trim(match_tail) 裁掉开头 pinned 22 帧重演段（~0.9s，2026-09-11 验证版实测量 5.17→4.25s），
        // duration +1s 补偿，clamp 模型档位上限 15s（2026-09-13 放宽，旧 10s 系误记）
        values.duration = String(Math.min(15, duration + 1))
        useMc = true
      } catch (e) {
        console.warn('[generateShotVideoV4] 上一镜成片上传失败，降级普通版（接缝不保证）:', e.message)
      }
    }
  } catch (e) {
    return { success: false, error: `参考图/音色上传失败: ${e.message}` }
  }

  const result = await runWorkflow(useMc ? 'h3V4mc' : 'h3V4', values, {
    // 15s 成片含二采精修 + 1.5x 放大比 10s 档更久（10s 实测 3~8 分钟），给 20 分钟兜底
    timeout: 20 * 60 * 1000,
    ...options,
    usageContext: { task: 'video', ...options.usageContext },
  })
  // MC 续镜降级提示（上一镜成片上传失败/未配置时 useMc=false，成片已出但接缝不保证）
  if (params.prevVideoUrl && !useMc && result.success) {
    result.warning = 'Motion Context 续镜降级为普通出片（上一镜成片上传失败或工作流未配置），镜头接缝不保证连贯'
  }
  if (!result.success || !result.url) return result

  try {
    options.onProgress?.('downloading', { message: '下载成片到本地...' })
    // 退避重试（2026-09-12）：出片后 COS/CDN 偶发未就绪窗口，单次+立即重试连撞同一堵墙
    // （第 1 集实锤 ~40% 失败：105/87/109 三次手动转存，且失败时下游钩子各自下载也跟着挂）。
    // 2s/5s/10s 跨过就绪窗口；全部失败才降级 24h 云端 URL。
    let buf = null
    try {
      buf = await downloadWithRetry(result.url, {
        validate: 'mp4', // ftyp+体积校验：COS 偶发 200 返回错误页/残片，假成片当失败进重试
        onRetry: (n, waitMs, err) => console.warn(`[generateShotVideoV4] 成片下载第 ${n} 次失败（shot ${shotId}）: ${err.message}，${waitMs}ms 后重试`),
      })
    } catch (mainErr) {
      // 主节点全灭 → 当场换备用输出节点（2026-09-15 实锤：主节点 2001 的 URL 生成即 404，
      // 245 音轨合成节点却完好——1-4/2-2 连烧 6 次出片都是主节点假死，245 一手救回）。
      // allResults 是 SUCCESS 时 v2 接口返回的全部输出，不用再调 API，零成本兜底。
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
        } catch { /* 该节点也失败，继续下一个 */ }
      }
      if (!buf) throw mainErr // 备用节点也全灭，走原降级
    }
    const filename = `shot_${shotId}_v4_${Date.now()}.mp4`
    fs.mkdirSync(uploadsDir, { recursive: true })
    fs.writeFileSync(path.join(uploadsDir, filename), buf)
    return { ...result, videoUrl: `/uploads/${filename}` }
  } catch (e) {
    console.warn(`[generateShotVideoV4] 成片落本地失败（shot ${shotId}），返回 24h 云端 URL:`, e.message)
    return { ...result, videoUrl: result.url, warning: '成片下载到本地失败，当前为 24 小时时效的云端链接，请尽快转存' }
  }
}
