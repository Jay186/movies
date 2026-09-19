// ⚠️ 本模块自 2026-09-18 起无任何调用点，出片链已由 ai/v4Video.js（单镜）+ ai/segmentPrompt.js（段级）
//    取代；保留作规格参考。若复活本链路，必须先与那两个文件逐字对齐
//    （见 docs/audit/ep4-中文泄漏面专项审计-v1.md）。
//
// 单镜出片 prompt 组装（MiniMax H3 多参考生视频-优化版 workflow，Ref2VA 官方结构化格式）
// 2026-09-10 按官方规范重写六段格式：全英文主体 + [Shot 1] + 运镜三要素 + 说话人 ID 系统
// 官方文档：github.com/MiniMax-AI/MiniMax-H3 → skills/h3-prompt-writing/references/ref-en.txt
//
// ⚠️ 本文件产出的是【H3 官方六段】（全英文，仅 <d> 内台词中文）：
//      subject_definitions → summary → retention_analysis →
//      detailed_description → overall_soundscape → non_diegetic_music
//    与 DB 字段 shots.integrated_multimodal_description 的【图像六模块】（模块1~6，见
//    ai/storyboardRules.js integratedModulesRule）是两套不同结构，不要互相套用。
//
// 与 V4（ai/v4Video.js）保持同一套合规约束：
//  - <Audio N> 定义归入 subject_definitions 段内，不单独成段
//  - 六个段名恒存在，无内容写 N/A（不得整段消失）；六段之外只允许顶部一行 guard
//  - 风格串、资产描述一律英文；含中文则丢弃（宁缺勿脏）
//  - (Sx) 用全片统一编号表（ctx.speakerIds），从不发声的角色不给 ID
//  - summary 前缀按有无音色引用叠加 + audio reference

import {
  translateShotFields,
  translateShotSize,
  translateCameraMovement,
  translateCameraAngle,
  translateTone,
  lookupCameraMovement,
} from './h3PromptTranslator.js'
// 喊叫抑制与用力句消解：与 V4 同一份实现（v4Video.js 导出），
// V2 链路同样支持音色克隆（audioRefs），缺了这套会复现 88 的「克隆音色被通用嗓音替换」事故
import { deShout, cleanVoiceDescription } from './v4Video.js'

// 台词解析判据单点（2026-09-18 P0-3）：本文件原有一份本地 parseDialogue（第四份副本，
//   且本份返回「对象或 null」而非数组，与其余三份不同形）。统一从 dialogue.js 走：
//   恒返回数组，'null'/''/脏 JSON 一律 []。下游 dialogueLines 本来就兼容数组，行为不变。
import { parseDialogue } from './dialogue.js'

// 台词行 → 数组（兼容对象 / 数组 / 空）
function dialogueLines(dlg) {
  if (!dlg) return []
  if (Array.isArray(dlg)) return dlg
  return [dlg]
}

// 清理描述 + 英文护栏判据统一到 shared.js（原此处与 ai/v4Video.js / ai/segmentPrompt.js 各有一份拷贝，
// 且本份未加固——英文名为空时回退中文名，中文落进 H3 英文正文，V2 链路静默劣化。判据已收口单点。）
import { clean as cleanText, pickEnglish, stripResidualCjk, resolveAssetName, truncateStyle, formatCutTimestamp } from './shared.js'

// 资产描述：优先英文字段，旧字段含中文则丢弃；去尾部标点并小写首字母（该描述固定出现在句中）
function lowerFirst(s) {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : ''
}
function resolveDesc(descEn, descCn) {
  const v = (pickEnglish(descEn) || pickEnglish(descCn)).replace(/[.。]+$/, '')
  return lowerFirst(v)
}
// 去尾部标点：模板会在句末再补一个句号，不剥掉就会出现 "crust.."
function cleanDesc(s) {
  return cleanText(s).replace(/[。.]+$/, '')
}

// 画风串截断（truncateStyle）已收口到 shared.js（见顶部 import）——三通道共用词边界版，
// 防再次漂移。

// 资产名判据已收口到 shared.js 的 resolveAssetName（见顶部 import）——原此处回退中文名，
// 会把中文资产名写进英文正文；现改为 shared 加固版（中文名经 pickEnglish 复核，取不到返回 ''，
// 由调用点 `|| reference N` 兜底中性标签）。

// 语气短语规范化：保证能自然接在 "speaks ..." 之后
function normalizeTone(t) {
  const v = cleanText(t)
  if (!v) return ''
  if (/^(in|with|through|at|while)\b/i.test(v)) return v
  if (/ly$/i.test(v)) return v
  return `in a ${v.replace(/\s+tone$/i, '')} tone`
}

// 中文运镜词 → 官方运镜句式（类型+幅度+速度）。映射表统一维护在 h3PromptTranslator.js，
// 本文件不再自带第二份 CAMERA_PHRASES（历史重复表已删除，避免改一份不生效）。
export function cameraPhrase(cm) {
  const t = String(cm || '').trim()
  if (!t) return ''
  return lookupCameraMovement(t) || translateCameraMovement(t)
}

/**
 * 组装单镜出片 prompt（MiniMax H3 Ref2VA 官方六段格式）
 *
 * @param {Object} shot - shots 表一行
 * @param {Object} ctx
 * @param {string} ctx.stylePrompt - 画风 prompt（中文；含中文会被丢弃，仅作兼容）
 * @param {string} ctx.stylePromptEn - 画风英文描述（优先使用）
 * @param {Array} ctx.refs - 参考槽 [{ label, labelEn, desc, descEn, kind, image }]（最多 3）
 * @param {Array} ctx.audioRefs - 音色参考 [{ subjectNum, label, audio }]
 * @param {Function} [ctx.translate] - 可注入的翻译函数（离线自检用，默认走 LLM）
 * @returns {Promise<{prompt: string, warnings: string[]}>}
 */
export async function buildShotVideoPrompt(shot = {}, ctx = {}) {
  const { stylePrompt = '', stylePromptEn = '', refs = [], audioRefs = [], translate, speakerIds } = ctx
  const tr = typeof translate === 'function' ? translate : translateShotFields
  const warnings = []
  const parts = []
  const pictureRefs = (Array.isArray(refs) ? refs : []).slice(0, 3)

  // 上限口径 2026-09-13 与 v4Video.js 同步放宽到 15s（模型官方 4-15s，工作流无上限，旧 10s 系误记）
  const duration = Math.min(15, Math.max(3, Math.round(Number(shot.duration) || 5)))
  const shotStart = Number(shot.start_time) || 0

  // ── 0) 顶部 guard ──
  // 官方格式只有六段，六段之外只允许这一行（AGENTS.md 禁止六段外游离文本）。
  // 一行合并两条保护：不朗读非台词文本 + 画面不得出现非预期文字/字幕/水印。
  parts.push('Director guidance below is for visual generation only: do not read aloud, narrate, or quote any of it — speak only the dialogue inside <d> tags. The generated video must contain no on-screen text, subtitles, watermark, or logo.')

  // ── 1) 先解析台词，确定实际发声顺序（官方 base-en.txt §4.4：(Sx) 全片分配一次、
  //      按 actual vocal events 排序；从不发声的角色不给 ID）──
  const dlg = parseDialogue(shot.dialogue)
  const lines = dialogueLines(dlg)
  const vocalEvents = []
  for (const d of lines) {
    const who = cleanText(d?.character || d?.speaker || d?.name)
    const text = cleanText(d?.text || d?.line || d?.content)
    if (!text) continue
    vocalEvents.push({ d, who, text, subjIdx: pictureRefs.findIndex((r) => r?.label && (r.label === who || r.labelEn === who)) })
  }
  const speakerIdMap = new Map()
  if (speakerIds instanceof Map) {
    pictureRefs.forEach((r, i) => {
      const sid = speakerIds.get(r?.label) || speakerIds.get(r?.labelEn)
      if (sid) speakerIdMap.set(i + 1, sid)
    })
  } else {
    for (const ev of vocalEvents) {
      if (ev.subjIdx >= 0 && !speakerIdMap.has(ev.subjIdx + 1)) speakerIdMap.set(ev.subjIdx + 1, 'S' + (speakerIdMap.size + 1))
    }
  }

  // ── 2) subject_definitions（<Audio N> 定义属本段段内，不单独成段）──
  if (!pictureRefs.length) warnings.push('无可用参考图槽（角色/场景/分镜图均缺失），角色一致性将明显下降')
  const subjectLines = pictureRefs.map((r, i) => {
    const typeLabel = r?.kind === 'character' ? 'character' : (r?.kind === 'prop' ? 'prop' : 'scene/environment')
    const name = resolveAssetName(r?.labelEn, r?.label) || `reference ${i + 1}`
    const desc = resolveDesc(r?.descEn, r?.desc)
    // 场景光影常量（scenes.lighting_en，#2 光影常量 2026-09-11）：与 v4Video.js 同句式注入
    const lighting = r?.kind === 'scene' ? cleanDesc(pickEnglish(r?.lightingEn)) : ''
    return `<Subject ${i + 1}> is ${name} (${typeLabel}) from <Picture ${i + 1}>${desc ? `, ${desc}` : ''}.${lighting ? ` The lighting of this scene is constant: ${lighting}.` : ''}`
  })
  const audioLines = (Array.isArray(audioRefs) ? audioRefs : [])
    .map((a, i) => {
      const n = Number(a?.subjectNum)
      if (!n) return ''
      const sId = speakerIdMap.get(n)
      const idPart = sId ? ` (${sId})` : ''
      return `<Audio ${i + 1}> is the voice-timbre reference for <Subject ${n}>${idPart}. Extract ONLY the vocal timbre from it. The reference audio contains sample speech that must NEVER be played back, quoted, hummed, or echoed in the generated soundtrack — no word, phrase, or sentence from <Audio ${i + 1}> may appear in the output. All spoken output comes exclusively from the <d> dialogue lines below.`
    })
    .filter(Boolean)
  parts.push('subject_definitions:')
  parts.push([...subjectLines, ...audioLines].join('\n'))

  // ── 3) summary（任务类型前缀；有音色引用时叠加 + audio reference）──
  const style = truncateStyle(pickEnglish(stylePromptEn) || pickEnglish(stylePrompt), 300)
  // 场景槽判据必须是 kind === 'scene'：旧写法 kind !== 'character' 会在场景图缺失时
  // 命中「镜头构图参考」兜底槽，summary 拼出 "The scene is set in 镜头构图参考."——
  // 中文裸文本混进英文正文（H3 可能把它念出来，本项目踩过同类事故）
  const sceneRef = pictureRefs.find((r) => r?.kind === 'scene')
  const sceneLabel = sceneRef ? resolveAssetName(sceneRef.labelEn, sceneRef.label) : ''
  // 场景光影常量：summary / subject / detailed 三处逐字同一句（与 v4Video.js 同构）。
  // 场景槽判据与 typeLabel 一致：非 character 且非 prop（含 legacy 的「镜头构图参考」scene 槽，
  // 该槽 lightingEn 恒空，find 自动跳过）
  const sceneLighting = cleanDesc(pickEnglish(pictureRefs.find((r) => r?.kind === 'scene' && pickEnglish(r?.lightingEn))?.lightingEn))
  const sceneBit = `${sceneLabel ? ` The scene is set in ${sceneLabel}.` : ''}${sceneLighting ? ` Scene lighting: ${sceneLighting}.` : ''}`
  const taskPrefix = audioLines.length ? '[reference generation + audio reference]' : '[reference generation]'
  parts.push('summary:')
  parts.push(`${taskPrefix} The target video is a ${duration}-second single-shot clip${style ? ` in the reference style (${style})` : ''}.${sceneBit} All visual elements must strictly match their reference appearances.`)

  // ── 4) retention_analysis ──
  // 六段恒存在：无参考图时也写 N/A，不得整段消失（官方硬约束，与 V4 同口径）。
  // 音频保留行不可少：<Audio N> 音色克隆的绑定强度靠它（缺了模型会忽略音色样本自合成，
  // 88 实测 F0 525Hz vs 样本 286Hz 即为此因——V2 链路曾漏掉这段）
  const visualRetention = subjectLines.length
    ? pictureRefs.map((r, i) => {
        const desc = resolveDesc(r?.descEn, r?.desc) || 'appearance'
        return `<Subject ${i + 1}> (appears in [Shot 1]): fully_preserved - ${desc} is retained from <Picture ${i + 1}>.`
      }).join('\n')
    : ''
  const audioRetention = (Array.isArray(audioRefs) ? audioRefs : [])
    .map((a, i) => {
      const n = Number(a?.subjectNum)
      if (!n) return ''
      const sId = speakerIdMap.get(n)
      const idPart = sId ? ` (${sId})` : ''
      return `<Audio ${i + 1}>: reference - its vocal timbre guides the dialogue delivery of <Subject ${n}>${idPart} without copying the original signal.`
    })
    .filter(Boolean)
  parts.push('retention_analysis:')
  parts.push([visualRetention, ...audioRetention].filter(Boolean).join('\n') || 'N/A')

  // ── 5) detailed_description（全英文 + [Shot 1] + 翻译/扩写层）──
  const characterNames = pictureRefs.filter((r) => r?.kind === 'character').map((r) => r?.label).filter(Boolean)
  const sceneNames = pictureRefs.filter((r) => r?.kind !== 'character').map((r) => r?.label).filter(Boolean)
  // 音色克隆镜头必须走"平稳发声"口径（翻译层规则 7）+ 喊叫抑制清洗（与 V4 同口径）：
  // 否则"鼓起腮帮喊话"类措辞会让 H3 抛弃 <Audio N> 克隆音色改用通用嗓音
  const voiceClone = Array.isArray(audioRefs) && audioRefs.length > 0
  const voicedNames = voiceClone
    ? audioRefs.map((a) => pictureRefs[Number(a?.subjectNum) - 1]?.label).filter(Boolean)
    : []
  const translated = await tr(shot, { characterNames, sceneNames, voiceClone, voicedNames })

  // 关键修复（与 v4Video.js 同源）：翻译层按规则保留中文角色/场景/道具名，
  // 但下方 pickEnglish 检出任意 CJK 即整段丢弃 —— 导致 description_en / action_note_en
  // 被静默清空，模型从未见过画面描述。先把中文名确定性替换为对应英文名
  // （与 <Subject N> 定义行同源），再交给 pickEnglish。按名字长度降序防前缀误伤。
  const zhNameToEn = new Map()
  for (const r of pictureRefs) {
    const zh = String(r?.label || '').trim()
    const en = String(r?.labelEn || '').trim()
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
  // 兜底只在原字段本身已是英文时才用；中文原字段一律丢弃
  // 同时去掉尾部句号：模板会在句末再补一个，否则出现 "crust.."
  // 克隆镜头过一道喊叫抑制/用力句消解（cleanVoiceDescription，与 V4 同一实现）
  const rawActionDesc = cleanDesc(pickEnglish(translated.action_note_en) || stripResidualCjk(translated.action_note_en) || pickEnglish(shot.action_note))
  const rawVisualDesc = cleanDesc(pickEnglish(translated.description_en) || stripResidualCjk(translated.description_en) || pickEnglish(shot.description))
  const actionDesc = voiceClone ? cleanVoiceDescription(rawActionDesc) : rawActionDesc
  const visualDesc = voiceClone ? cleanVoiceDescription(rawVisualDesc) : rawVisualDesc

  const dlgLines = []
  // 语气回退粒度：translated.tone_en 是全镜所有语气词的合并翻译——本镜有多种不同语气时，
  // 单句未命中映射表就拿合并译文兜底会张冠李戴；仅全镜语气唯一时允许回退（与 V4 同口径）
  const distinctTones = new Set(vocalEvents.map((ev) => cleanText(ev.d?.tone)).filter(Boolean))
  const toneFallbackEn = distinctTones.size <= 1 ? pickEnglish(translated.tone_en) : ''
  for (const ev of vocalEvents) {
    const { d, who, text, subjIdx } = ev
    const toneEn = voiceClone
      ? deShout(normalizeTone(translateTone(d?.tone) || toneFallbackEn))
      : normalizeTone(translateTone(d?.tone) || toneFallbackEn)
    const sId = (subjIdx >= 0 ? speakerIdMap.get(subjIdx + 1) : null)
      || (speakerIds instanceof Map ? speakerIds.get(who) : null)
    // 说话人引用：命中参考槽写 <Subject N>；未命中（缺图未进 refs / 台词写了清单外的角色名或旁白）
    // 时 who 必须过 pickEnglish 复核——中文角色名一律不得落进英文正文，降级为中立的 'the character'
    // （与 ai/v4Video.js / ai/segmentPrompt.js 逐字同源；本文件同属 H3 出片通道，判据必须一致）。
    const speakerRef = subjIdx >= 0
      ? `<Subject ${subjIdx + 1}>${sId ? ` (${sId})` : ''}`
      : `${pickEnglish(who) || 'the character'}${sId ? ` (${sId})` : ''}`
    if (subjIdx < 0 && who) warnings.push(`台词说话人「${who}」不在参考槽角色中，语音音色可能不匹配`)
    // 时间戳走 shared.formatCutTimestamp（与 V4 / 段级同口径）：旧内联写法在 rel 小数部分
    // ≥0.9995 时输出 4 位毫秒（如 At 00:12.1000）——非法 MM:SS.mmm，H3 切点标记失效（审计 P0-C）。
    let t = ''
    if (d?.startTime != null && d.startTime !== '') {
      const rel = Number(d.startTime) - shotStart
      if (!isNaN(rel) && rel >= 0 && rel <= duration) {
        t = `At ${formatCutTimestamp(rel)}, `
      }
    }
    // 官方示例统一用 says（base-en §4.4 / ref-en §5.4）
    // 音色绑定句式 + soft/steady 钉句：缺了模型会忽略音色参考自合成声音（88 实锤，与 V4 同句式）
    const aIdx = subjIdx >= 0 ? audioRefs.findIndex((a) => Number(a?.subjectNum) === subjIdx + 1) : -1
    const timbreClause = aIdx >= 0 ? `, using the voice timbre referenced from <Audio ${aIdx + 1}>` : ''
    const steadyClause = aIdx >= 0 ? ', softly and steadily' : ''
    const toneClause = toneEn ? ` says ${toneEn}${steadyClause}${timbreClause},` : ` says${steadyClause}${timbreClause},`
    dlgLines.push(`${t}${speakerRef}${toneClause} <d>[Chinese] ${text}</d>`)
  }
  if (!dlgLines.length) {
    warnings.push('本镜没有台词，成片将没有角色语音（H3 只念 <d> 标签内的台词）')
  }

  const ddParts = []
  if (style) ddParts.push(`The target video is in a cinematic, ${style} style.`)
  let shot1 = `[Shot 1] A ${shotSize}`
  if (visualDesc) shot1 += `, ${lowerFirst(visualDesc)}`
  shot1 += '.'
  // 场景光影常量：开场一句钉住光照（与 subject_definitions / summary 同一句逐字重复）
  if (sceneLighting) shot1 += ` The scene lighting remains constant throughout: ${sceneLighting}.`
  // 机位角度首字母大写：与 V4（v4Video.js）/ 段级（segmentPrompt.js）逐字同式，三通道必须同源
  // （本文件当前无调用点，但将来若复活本链路，不同源就会带病）。
  if (cameraAngle) shot1 += ` ${cameraAngle.charAt(0).toUpperCase()}${cameraAngle.slice(1)}.`
  if (cameraMove) shot1 += ` The camera ${cameraMove}.`
  if (actionDesc) shot1 += ` ${actionDesc}.`
  ddParts.push(shot1)
  if (dlgLines.length) ddParts.push(dlgLines.join(' '))

  parts.push('detailed_description:')
  parts.push(ddParts.join(' '))

  // ── 6) overall_soundscape ──（官方：无内容写 N/A，不得整段省略）
  const soundscapeEn = pickEnglish(translated.soundscape_en) || stripResidualCjk(translated.soundscape_en) || pickEnglish(shot.overall_soundscape)
  parts.push('overall_soundscape:')
  parts.push(soundscapeEn || 'N/A')

  // ── 7) non_diegetic_music ──
  // prompt 到此结束——六段之后不再追加任何句子，结构严格等于官方格式。
  const musicEn = pickEnglish(translated.music_en) || stripResidualCjk(translated.music_en) || pickEnglish(shot.non_diegetic_music)
  parts.push('non_diegetic_music:')
  parts.push(musicEn || 'N/A')

  return { prompt: parts.join('\n'), warnings }
}
