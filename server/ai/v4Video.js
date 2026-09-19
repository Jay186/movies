import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runWorkflow, uploadMediaFileName, uploadAudioV2, insecureDownload, downloadWithRetry, isPlausibleMp4 } from './runninghub.js'
import { translateShotFields, translateShotSize, translateCameraMovement, translateCameraAngle, translateTone } from './h3PromptTranslator.js'
import { config } from '../config.js'
import { clean as cleanShared, pickEnglish, stripResidualCjk, resolveAssetName, truncateStyle, formatCutTimestamp, pickInjectableEnglish } from './shared.js'
import { parseDialogue } from './dialogue.js'
export { pickEnglish, stripResidualCjk }

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const uploadsDir = path.join(__dirname, '..', 'uploads')

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

const VIDEO_ASPECT_RATIOS = [
  '1:1 (Square)', '2:3 (Portrait Photo)', '3:2 (Photo)', '3:4 (Portrait Standard)',
  '4:3 (Standard)', '9:16 (Portrait Widescreen)', '16:9 (Widescreen)', '21:9 (Ultrawide)',
]
const VIDEO_MEGAPIXELS = ['0.5', '0.75', '1.0']

function normalizeVideoParams(params = {}) {
  return {
    aspectRatio: VIDEO_ASPECT_RATIOS.includes(params.aspectRatio) ? params.aspectRatio : '9:16 (Portrait Widescreen)',
    megapixels: VIDEO_MEGAPIXELS.includes(String(params.megapixels)) ? String(params.megapixels) : '0.5',
    duration: Math.min(15, Math.max(3, Math.round(Number(params.duration) || 5))),
  }
}

const clean = cleanShared
const cleanDesc = (s) => clean(s).replace(/[。.]+$/, '')


const lowerFirst = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : '')
const resolveDesc = (descEn, descCn) => lowerFirst(cleanDesc(pickEnglish(descEn) || pickEnglish(descCn)))



const normalizeTone = (t) => {
  const v = clean(t)
  if (!v) return ''
  if (/^(in|with|through|at|while)\b/i.test(v)) return v
  if (/ly$/i.test(v)) return v
  return `in a ${v.replace(/\s+tone$/i, '')} tone`
}

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


export async function buildShotVideoPromptV4(shot = {}, ctx = {}) {
  const { stylePrompt = '', stylePromptEn = '', refs = [], audioRefs = [], isCombat = false, translate, speakerIds, retryNote = '', combatNote = '' } = ctx
  const tr = typeof translate === 'function' ? translate : translateShotFields
  const parts = []

  const duration = Math.min(15, Math.max(3, Math.round(Number(shot.duration) || 5)))
  const shotStart = Number(shot.start_time) || 0

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
      return `<Picture ${i + 1}> is the final frame of the previous shot, provided as a continuity anchor: the characters' positions, postures, orientations, relative sizes, the environment state (snow cover, ice field), AND the exact color temperature, lighting direction, and tonal palette continue seamlessly from this frame — the color grade must match this frame exactly, with no shift toward warmer or cooler tones. It anchors character, environment, and color grade, NOT the camera viewpoint.`
    }
    if (r.kind === 'endframe') {
      return `<Picture ${i + 1}> is the target last frame of [Shot 1], the final composition and character positions this shot must end on.`
    }
    if (r.kind === 'styleanchor') {
      return `<Picture ${i + 1}> is the final frame of the opening shot of this episode, provided as the absolute art-style anchor: every character, environment and effect in this shot MUST stay in this exact hand-drawn watercolor rendering style — same linework, texture, color palette and tonal grade. Never drift toward photorealistic, CGI or 3D rendering in any part of the frame.`
    }
    const typeLabel = r.kind === 'character' ? 'character' : (r.kind === 'prop' ? 'prop' : 'scene/environment')
    const name = resolveAssetName(r.labelEn, r.label) || `reference ${i + 1}`
    const d = resolveDesc(r.descEn, r.desc)
    const lighting = r.kind === 'scene' ? cleanDesc(pickEnglish(r.lightingEn)) : ''
    return `<Subject ${i + 1}> is ${name} (${typeLabel}) from <Picture ${i + 1}>${d ? `, ${d}` : ''}.${lighting ? ` The lighting of this scene is constant: ${lighting}.` : ''}`
  })
  const audioLines = audioRefs.map((a, i) => {
    const sId = speakerIdMap.get(a.subjectNum)
    const idPart = sId ? ` (${sId})` : ''
    return `<Audio ${i + 1}> is the voice-timbre reference for <Subject ${a.subjectNum}>${idPart}. Extract ONLY the vocal timbre from it. The reference audio contains sample speech that must NEVER be played back, quoted, hummed, or echoed in the generated soundtrack. All spoken output comes exclusively from the <d> dialogue lines below.`
  }).filter(Boolean)
  parts.push('subject_definitions:')
  parts.push([...subjectLines, ...audioLines].join('\n'))
  parts.push('Accessories and garment details belong exclusively to the character who wears them in that character\'s own <Picture N> reference image — never add, remove, or transfer any accessory (scarf, hat, bag, glasses) from one character to another, and never dress a character that wears none. Every character keeps the exact body proportions, face structure and rendering style of its own reference image regardless of how its size, power or action is described in this shot.')

  const style = truncateStyle(pickEnglish(stylePromptEn) || pickEnglish(stylePrompt), 300)
  const sceneRef = refs.find((r) => r.kind === 'scene')
  const sceneLabel = sceneRef ? resolveAssetName(sceneRef.labelEn, sceneRef.label) : ''
  const sceneLighting = cleanDesc(pickEnglish(refs.find((r) => r.kind === 'scene' && pickEnglish(r.lightingEn))?.lightingEn))
  const hasFrameAnchor = refs.some((r) => r.kind === 'continuity' || r.kind === 'endframe')
  const taskTypes = ['reference generation']
  if (hasFrameAnchor) taskTypes.push('keyframe completion')
  if (audioRefs.length) taskTypes.push('audio reference')
  const taskPrefix = `[${taskTypes.join(' + ')}]`
  parts.push('summary:')
  parts.push(`${taskPrefix} The target video is a ${duration}-second single-shot clip${style ? ` in the reference style (${style})` : ''}.${sceneLabel ? ` The scene is set in ${sceneLabel}.` : ''}${sceneLighting ? ` Scene lighting: ${sceneLighting}.` : ''} All visual elements must strictly match their reference appearances.`)

  parts.push('retention_analysis:')
  const visualRetention = refs.map((r, i) => {
    if (r.kind === 'storyboard') {
      return `<Picture ${i + 1}> (storyboard reference for [Shot 1]): fully_preserved - the camera viewpoint, subject placement, and composition from <Picture ${i + 1}> are followed in [Shot 1].`
    }
    if (r.kind === 'continuity') {
      return `<Picture ${i + 1}> (continuity anchor for [Shot 1]): partially_preserved - the characters' positions, postures, orientations, relative sizes, the environment state, and the exact color temperature, lighting direction, and tonal palette from <Picture ${i + 1}> are retained at the opening of [Shot 1] with no color shift; the camera viewpoint and composition reframe to [Shot 1]'s described shot size.`
    }
    if (r.kind === 'endframe') {
      return `<Picture ${i + 1}> ([Shot 1] last frame): fully_preserved - the video ends on the exact final composition, character positions, and environment state shown in <Picture ${i + 1}>.`
    }
    const d = resolveDesc(r.descEn, r.desc)
    const multiViewHint = r.kind === 'character'
      ? ` When the character is not shown front-facing (e.g. seen from behind, facing away, or in profile), use the matching view from <Picture ${i + 1}> instead of the front view.`
      : ''
    return `<Subject ${i + 1}> (appears in [Shot 1]): fully_preserved - ${d || 'appearance'} is retained from <Picture ${i + 1}>.${multiViewHint}`
  }).join('\n')
  const audioRetention = audioRefs.map((a, i) => {
    const sId = speakerIdMap.get(a.subjectNum)
    const idPart = sId ? ` (${sId})` : ''
    return `<Audio ${i + 1}>: reference - its vocal timbre guides the dialogue delivery of <Subject ${a.subjectNum}>${idPart} without copying the original signal.`
  })
  parts.push([visualRetention, ...audioRetention].filter(Boolean).join('\n'))

  const characterNames = refs.filter((r) => r.kind === 'character').map((r) => r.label)
  const sceneNames = refs.filter((r) => r.kind !== 'character').map((r) => r.label)
  const voicedNames = audioRefs.map((a) => refs[a.subjectNum - 1]?.label).filter(Boolean)
  const translated = { ...(await tr(shot, { characterNames, sceneNames, voiceClone: audioRefs.length > 0, voicedNames })) }

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
  const voiceClone = audioRefs.length > 0
  const rawAction = cleanDesc(pickEnglish(translated.action_note_en) || stripResidualCjk(translated.action_note_en) || pickEnglish(shot.action_note))
  const rawVisual = cleanDesc(pickEnglish(translated.description_en) || stripResidualCjk(translated.description_en) || pickEnglish(shot.description))
  const actionDesc = voiceClone ? cleanVoiceDescription(rawAction) : rawAction
  const visualDesc = voiceClone ? cleanVoiceDescription(rawVisual) : rawVisual

  const dlgLines = []
  const distinctTones = new Set(vocalEvents.map((ev) => clean(ev.d?.tone)).filter(Boolean))
  const toneFallbackEn = distinctTones.size <= 1 ? pickEnglish(translated.tone_en) : ''
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
    const aIdx = subjIdx >= 0 ? audioRefs.findIndex((a) => a.subjectNum === subjIdx + 1) : -1
    const timbreClause = aIdx >= 0 ? `, using the voice timbre referenced from <Audio ${aIdx + 1}>` : ''
    const steadyClause = aIdx >= 0 ? ', softly and steadily' : ''
    const toneClause = toneEn ? ` says ${toneEn}${steadyClause}${timbreClause},` : ` says${steadyClause}${timbreClause},`
    dlgLines.push(`${t}${speakerRef}${toneClause} <d>[Chinese] ${text}</d>`)
  }

  const ddParts = []
  if (style) ddParts.push(`The target video is in a cinematic, ${style} style.`)
  if (combatNote) ddParts.push(pickEnglish(combatNote) ? cleanDesc(combatNote) + '.' : '')
  const sbIdx = refs.findIndex((r) => r.kind === 'storyboard')
  const ctIdx = refs.findIndex((r) => r.kind === 'continuity')
  const efIdx = refs.findIndex((r) => r.kind === 'endframe')
  let shot1 = `[Shot 1] A ${shotSize}`
  if (visualDesc) shot1 += `, ${lowerFirst(visualDesc)}`
  shot1 += '.'
  if (sceneLighting) shot1 += ` The scene lighting remains constant throughout: ${sceneLighting}.`
  if (sbIdx >= 0) shot1 += ` The camera viewpoint, subject placement, and composition of this shot follow <Picture ${sbIdx + 1}>.`
  if (ctIdx >= 0) shot1 += ` The shot begins from <Picture ${ctIdx + 1}>, the final frame of the previous shot: the characters' positions, postures, orientations, the environment state, and the exact color temperature, lighting direction, and tonal palette continue from that frame with no color shift; the camera viewpoint and composition reframe to [Shot 1]'s described shot size.`
  if (cameraAngle) shot1 += ` ${cameraAngle.charAt(0).toUpperCase()}${cameraAngle.slice(1)}.`
  if (cameraMove) shot1 += ` The camera ${cameraMove}.`
  if (actionDesc) shot1 += ` ${actionDesc}.`
  if (efIdx >= 0) {
    shot1 += ` The shot ends on <Picture ${efIdx + 1}>, reaching its exact final composition.`
  } else {
    const finalFrameEn = cleanDesc(pickEnglish(zhNamesToEn(String(shot.final_frame || shot.finalFrame || '').replace(/@/g, ''))))
    if (finalFrameEn) shot1 += ` The shot ends on this final frame: ${finalFrameEn}.`
  }
  ddParts.push(shot1)
  if (dlgLines.length) ddParts.push(dlgLines.join(' '))

  const retryNoteEn = pickInjectableEnglish(retryNote)
  if (retryNoteEn) {
    ddParts.push(`MANDATORY CORRECTION FROM PREVIOUS FAILED TAKE — the previous take of this exact shot failed review for these specific reasons, and this take MUST fix them: ${retryNoteEn}`)
  }

  parts.push('detailed_description:')
  parts.push(ddParts.join(' '))

  const soundscapeEn = pickEnglish(translated.soundscape_en) || stripResidualCjk(translated.soundscape_en) || pickEnglish(shot.overall_soundscape)
  parts.push('overall_soundscape:')
  parts.push(soundscapeEn || 'N/A')

  const musicEn = pickEnglish(translated.music_en) || stripResidualCjk(translated.music_en) || pickEnglish(shot.non_diegetic_music)
  parts.push('non_diegetic_music:')
  parts.push(musicEn || 'N/A')

  return parts.join('\n')
}

export async function generateShotVideoV4(params = {}, options = {}) {
  const { prompt, refs = [], audioRefs = [], shotId = 'x' } = params
  if (!prompt || !String(prompt).trim()) return { success: false, error: '出片提示词（prompt）不能为空' }
  const { aspectRatio, megapixels, duration } = normalizeVideoParams(params)

  const refImages = (Array.isArray(refs) ? refs : []).map((r) => r?.image).filter(Boolean)
  const uniq = [...new Set(refImages)].slice(0, 9)
  const images = [...uniq]
  while (images.length < 9) images.push(BLANK_PNG)

  const values = { prompt: String(prompt).trim(), aspectRatio, megapixels, duration: String(duration) }
  values.combatLora = params.combatLora || 'H3_Combat_V2.safetensors'
  values.combatLoraStrength = params.combatLoraStrength != null ? String(params.combatLoraStrength) : '0.5'
  values.unetName = params.unetName || 'Minimax-h3_Singularity_ref2va_Pruned_v1.3_int8.safetensors'
  if (params.firstPassSteps != null) values.firstPassSteps = String(params.firstPassSteps)
  if (params.firstPassDenoise != null) values.firstPassDenoise = String(params.firstPassDenoise)
  if (params.secondPassSteps != null) values.secondPassSteps = String(params.secondPassSteps)
  if (params.secondPassDenoise != null) values.secondPassDenoise = String(params.secondPassDenoise)
  if (params.upscaleMegapixels != null) values.upscaleMegapixels = String(params.upscaleMegapixels)
  if (params.seed != null) values.seed = String(params.seed)
  let useMc = false
  try {
    options.onProgress?.('uploading', { message: '上传参考图/音色...' })
    const uploaded = []
    for (const src of images) {
      try { uploaded.push(await uploadMediaFileName(src)) }
      catch (e) {
        console.warn('[generateShotVideoV4] 参考图上传失败，空白图原位占位:', e.message)
        uploaded.push(await uploadMediaFileName(BLANK_PNG))
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
        console.warn('[generateShotVideoV4] 音色上传失败，静音原位占位:', e.message)
        values['audio' + i] = await uploadAudioV2(SILENCE_WAV)
      }
    }

    if (params.prevVideoUrl && config.runninghub?.workflows?.h3V4mc) {
      try {
        options.onProgress?.('uploading', { message: '上传上一镜成片（Motion Context 接龙）...' })
        values.video = await uploadMediaFileName(params.prevVideoUrl)
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
    timeout: 20 * 60 * 1000,
    ...options,
    usageContext: { task: 'video', ...options.usageContext },
  })
  if (params.prevVideoUrl && !useMc && result.success) {
    result.warning = 'Motion Context 续镜降级为普通出片（上一镜成片上传失败或工作流未配置），镜头接缝不保证连贯'
  }
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
    return { ...result, videoUrl: `/uploads/${filename}` }
  } catch (e) {
    console.warn(`[generateShotVideoV4] 成片落本地失败（shot ${shotId}），返回 24h 云端 URL:`, e.message)
    return { ...result, videoUrl: result.url, warning: '成片下载到本地失败，当前为 24 小时时效的云端链接，请尽快转存' }
  }
}
