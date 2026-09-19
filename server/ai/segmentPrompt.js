
import { query, queryOne } from '../db.js'
import { segmentDurationSec } from './segmentBuilder.js'
import { translateShotFields, translateShotSize, translateCameraMovement, translateCameraAngle, translateTone } from './h3PromptTranslator.js'
import { deShout, cleanVoiceDescription } from './v4Video.js'
import { clean as cleanShared, pickEnglish, stripResidualCjk, resolveAssetName, truncateStyle, formatCutTimestamp, CJK_DIRTY_RE, cleanDesc, lowerFirst, resolveDesc, normalizeTone, dedupeArticles } from './shared.js'
import { parseDialogue } from './dialogue.js'

const clean = (s) => cleanShared(s)

const GUARD = 'Director guidance below is for visual generation only: do not read aloud, narrate, or quote any of it — speak only the dialogue inside <d> tags. The generated video must contain no on-screen text, subtitles, watermark, or logo.'


export function loadSegment(segmentId) {
  const seg = queryOne('SELECT * FROM video_segments WHERE id = ?', [segmentId])
  if (!seg) return null
  let rawIds = []
  try { rawIds = JSON.parse(seg.shot_ids || '[]') } catch { rawIds = [] }
  const shotIds = Array.isArray(rawIds) ? rawIds.map(Number) : []
  if (!shotIds.length) return { seg, shots: [], missingIds: [], shotIds: [] }
  const ph = shotIds.map(() => '?').join(',')
  const rows = query(
    `SELECT s.*, ss.scene_number FROM shots s
       LEFT JOIN storyboard_scenes ss ON s.storyboard_scene_id = ss.id
      WHERE s.id IN (${ph})`,
    shotIds
  )
  const byId = new Map(rows.map((r) => [Number(r.id), r]))
  const shots = shotIds.map((id) => byId.get(id)).filter(Boolean)
  const missingIds = shotIds.filter((id) => !byId.has(id))
  return { seg, shots, missingIds, shotIds }
}

export async function buildSegmentVideoPrompt(p) {
  const { seg, shots, refs = [], audioRefs = [], stylePromptEn = '', speakerIds, isCombat = false, combatNote = '' } = p
  const segStart = Number(seg.start_time) || 0
  const duration = segmentDurationSec(seg, shots)
  const shotCount = shots.length
  const parts = []

  parts.push(GUARD)

  const speakerIdMap = new Map()
  if (speakerIds instanceof Map) {
    refs.forEach((r, i) => {
      const sid = speakerIds.get(r.label) || speakerIds.get(r.labelEn)
      if (sid) speakerIdMap.set(i + 1, sid)
    })
  } else {
    const seen = []
    for (const sh of shots) {
      for (const d of parseDialogue(sh.dialogue)) {
        const who = clean(d?.character || d?.speaker || d?.name)
        const text = clean(d?.text || d?.line || d?.content)
        if (!who || !text || seen.includes(who)) continue
        seen.push(who)
        const idx = refs.findIndex((r) => r.label === who || r.labelEn === who)
        if (idx >= 0) speakerIdMap.set(idx + 1, 'S' + (seen.length))
      }
    }
  }

  const subjectLines = refs.map((r, i) => {
    if (r.kind === 'storyboard') {
      return `<Picture ${i + 1}> is a storyboard reference for [Shot 1], defining its camera viewpoint, subject placement, and composition.`
    }
    if (r.kind === 'continuity') {
      return `<Picture ${i + 1}> is the final frame of the previous segment, provided as a continuity anchor: the characters' positions, postures, orientations, relative sizes, the environment state, AND the exact color temperature, lighting direction, and tonal palette continue seamlessly from this frame — the color grade must match this frame exactly, with no shift toward warmer or cooler tones. It anchors character, environment, and color grade, NOT the camera viewpoint.`
    }
    if (r.kind === 'endframe') {
      return `<Picture ${i + 1}> is the target last frame of the segment, the final composition and character positions the segment must end on.`
    }
    if (r.kind === 'styleanchor') {
      return `<Picture ${i + 1}> is the final frame of the opening shot of this episode, provided as the absolute art-style anchor: every character, environment and effect in this segment MUST stay in this exact hand-drawn watercolor rendering style — same linework, texture, color palette and tonal grade. Never drift toward photorealistic, CGI or 3D rendering in any part of the frame.`
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
  parts.push('Accessories and garment details belong exclusively to the character who wears them in that character\'s own <Picture N> reference image — never add, remove, or transfer any accessory (scarf, hat, bag, glasses) from one character to another, and never dress a character that wears none. Every character keeps the exact body proportions, face structure and rendering style of its own reference image regardless of how its size, power or action is described in this segment.')

  const style = truncateStyle(pickEnglish(stylePromptEn), 300)
  const sceneRef = refs.find((r) => r.kind === 'scene')
  const sceneLabel = sceneRef ? resolveAssetName(sceneRef.labelEn, sceneRef.label) : ''
  const sceneLighting = cleanDesc(pickEnglish(refs.find((r) => r.kind === 'scene' && pickEnglish(r.lightingEn))?.lightingEn))
  const hasFrameAnchor = refs.some((r) => r.kind === 'continuity' || r.kind === 'endframe')
  const taskTypes = ['reference generation']
  if (hasFrameAnchor) taskTypes.push('keyframe completion')
  if (audioRefs.length) taskTypes.push('audio reference')
  const taskPrefix = `[${taskTypes.join(' + ')}]`
  const shotWord = shotCount > 1 ? `${shotCount}-shot segment` : 'single-shot clip'
  const cutsNote = shotCount > 1
    ? ` The segment is composed of ${shotCount} consecutive shots joined by hard cuts at the exact timestamps marked in [Shot N] below.`
    : ''
  parts.push('summary:')
  parts.push(`${taskPrefix} The target video is a ${duration}-second ${shotWord}${style ? ` in the reference style (${style})` : ''}.${sceneLabel ? ` The scene is set in ${sceneLabel}.` : ''}${sceneLighting ? ` Scene lighting: ${sceneLighting}.` : ''}${cutsNote} All visual elements must strictly match their reference appearances.`)

  const shotRefsAll = shots.map((_, i) => `[Shot ${i + 1}]`).join(', ')
  const parseNamesLocal = (v) => { if (!v) return []; try { const r = JSON.parse(v); return Array.isArray(r) ? r : [] } catch { return [] } }
  const refShotsMap = new Map()
  refs.forEach((r, i) => {
    if (r.kind !== 'character' && r.kind !== 'scene' && r.kind !== 'prop') return
    const hit = []
    shots.forEach((sh, si) => {
      const pool = r.kind === 'character' ? parseNamesLocal(sh.characters)
        : r.kind === 'scene' ? parseNamesLocal(sh.scene_assets)
        : parseNamesLocal(sh.prop_assets)
      if (pool.includes(r.label)) hit.push(si)
    })
    refShotsMap.set(i, hit)
  })
  const visualRetention = refs.map((r, i) => {
    if (r.kind === 'storyboard') {
      return `<Picture ${i + 1}> (storyboard reference for [Shot 1]): fully_preserved - the camera viewpoint, subject placement, and composition from <Picture ${i + 1}> are followed in [Shot 1].`
    }
    if (r.kind === 'continuity') {
      return `<Picture ${i + 1}> (continuity anchor for [Shot 1]): partially_preserved - the characters' positions, postures, orientations, relative sizes, the environment state, and the exact color temperature, lighting direction, and tonal palette from <Picture ${i + 1}> are retained at the opening of [Shot 1] with no color shift; the camera viewpoint and composition reframe to [Shot 1]'s described shot size.`
    }
    if (r.kind === 'endframe') {
      return `<Picture ${i + 1}> (segment last frame): fully_preserved - the segment ends on the exact final composition, character positions, and environment state shown in <Picture ${i + 1}>.`
    }
    const d = resolveDesc(r.descEn, r.desc)
    const multiViewHint = r.kind === 'character'
      ? ` When the character is not shown front-facing (e.g. seen from behind, facing away, or in profile), use the matching view from <Picture ${i + 1}> instead of the front view.`
      : ''
    const hitShots = refShotsMap.get(i)
    let appearsNote
    if (!hitShots || !hitShots.length) {
      appearsNote = shotCount > 1 ? ` (appears in ${shotRefsAll})` : ' (appears in [Shot 1])'
    } else if (hitShots.length === shotCount) {
      appearsNote = shotCount > 1 ? ` (appears in every shot: ${hitShots.map((si) => `[Shot ${si + 1}]`).join(', ')})` : ' (appears in [Shot 1])'
    } else {
      appearsNote = ` (appears only in ${hitShots.map((si) => `[Shot ${si + 1}]`).join(', ')}; absent from the other shots — do not add it to any other shot)`
    }
    return `<Subject ${i + 1}>${appearsNote}: fully_preserved - ${d || 'appearance'} is retained from <Picture ${i + 1}>.${multiViewHint}`
  }).join('\n')
  const audioRetention = audioRefs.map((a, i) => {
    const sId = speakerIdMap.get(a.subjectNum)
    const idPart = sId ? ` (${sId})` : ''
    return `<Audio ${i + 1}>: reference - its vocal timbre guides the dialogue delivery of <Subject ${a.subjectNum}>${idPart} without copying the original signal.`
  })
  parts.push('retention_analysis:')
  parts.push([visualRetention, ...audioRetention].filter(Boolean).join('\n'))

  const characterNames = refs.filter((r) => r.kind === 'character').map((r) => r.label)
  const sceneNames = refs.filter((r) => r.kind !== 'character').map((r) => r.label)
  const voicedNames = audioRefs.map((a) => refs[a.subjectNum - 1]?.label).filter(Boolean)
  const voiceClone = audioRefs.length > 0

  const ddParts = []
  if (style) ddParts.push(`The target video is in a cinematic, ${style} style.`)
  if (combatNote) ddParts.push(pickEnglish(combatNote) ? cleanDesc(combatNote) + '.' : '')

  const sbIdx = refs.findIndex((r) => r.kind === 'storyboard')
  const ctIdx = refs.findIndex((r) => r.kind === 'continuity')
  const efIdx = refs.findIndex((r) => r.kind === 'endframe')

  const shotSections = []
  const translatedAll = []
  for (let i = 0; i < shots.length; i++) {
    const sh = shots[i]
    const shotRelStart = Number(sh.start_time) - segStart
    const shotDur = Number(sh.end_time) - Number(sh.start_time)

    const overrideTxt0 = dedupeArticles(cleanDesc(pickEnglish(String(sh.video_prompt_override || ''))))
    const overrideTxt = overrideTxt0 && !/[.!?]$/.test(overrideTxt0) ? overrideTxt0 + '.' : overrideTxt0
    const translated = overrideTxt
      ? { description_en: '', action_note_en: '', soundscape_en: '', music_en: '', tone_en: '', failed: false }
      : { ...(await translateShotFields(sh, {
          characterNames, sceneNames, voiceClone, voicedNames,
        })) }
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
    for (const k of ['description_en', 'action_note_en', 'soundscape_en', 'music_en', 'tone_en']) {
      translated[k] = zhNamesToEn(translated[k])
    }
    translatedAll.push(translated)

    const shotSize = translateShotSize(sh.shot_type)
    const cameraMove = translateCameraMovement(sh.camera_movement)
    const cameraAngle = translateCameraAngle(sh.camera_angle)
    const rawAction = cleanDesc(pickEnglish(translated.action_note_en) || stripResidualCjk(translated.action_note_en) || pickEnglish(sh.action_note))
    const rawVisual = dedupeArticles(cleanDesc(pickEnglish(translated.description_en) || stripResidualCjk(translated.description_en) || pickEnglish(sh.description)))
    const actionDesc = voiceClone ? cleanVoiceDescription(dedupeArticles(rawAction)) : rawAction
    const visualDesc = voiceClone ? cleanVoiceDescription(rawVisual) : rawVisual

    let sec = ''
    if (overrideTxt) {
      sec = i === 0 ? `[Shot 1] ${overrideTxt}` : `[Shot ${i + 1}] At ${formatCutTimestamp(shotRelStart)}, ${overrideTxt}`
      if (i === 0 && ctIdx >= 0) sec += ` The segment begins from <Picture ${ctIdx + 1}>, the final frame of the previous segment: the characters' positions, postures, orientations, the environment state, and the exact color temperature, lighting direction, and tonal palette continue from that frame with no color shift; the camera viewpoint and composition reframe to [Shot 1]'s described shot size.`
    } else if (i === 0) {
      sec = `[Shot 1] A ${shotSize}`
      if (visualDesc) sec += `, ${lowerFirst(visualDesc)}`
      sec += '.'
      if (sceneLighting) sec += ` The scene lighting remains constant throughout: ${sceneLighting}.`
      if (sbIdx >= 0) sec += ` The camera viewpoint, subject placement, and composition of this shot follow <Picture ${sbIdx + 1}>.`
      if (ctIdx >= 0) sec += ` The segment begins from <Picture ${ctIdx + 1}>, the final frame of the previous segment: the characters' positions, postures, orientations, the environment state, and the exact color temperature, lighting direction, and tonal palette continue from that frame with no color shift; the camera viewpoint and composition reframe to [Shot 1]'s described shot size.`
    } else {
      sec = `[Shot ${i + 1}] At ${formatCutTimestamp(shotRelStart)}, the shot cuts to a ${shotSize}`
      if (visualDesc) sec += `, ${lowerFirst(visualDesc)}`
      sec += '.'
    }
    if (!overrideTxt) {
      if (cameraAngle) sec += ` ${cameraAngle.charAt(0).toUpperCase()}${cameraAngle.slice(1)}.`
      if (cameraMove) sec += ` The camera ${cameraMove}.`
      if (actionDesc) sec += ` ${actionDesc}.`
    }
    if (i === shots.length - 1) {
      if (efIdx >= 0) {
        sec += ` The segment ends on <Picture ${efIdx + 1}>, reaching its exact final composition.`
      } else {
        const rawFinal = String(sh.final_frame || sh.finalFrame || '').replace(/@/g, '')
          .replace(/^\s*the\s+final\s+frame\s*[:：]\s*/i, '')
        const finalFrameEn = cleanDesc(pickEnglish(zhNamesToEn(rawFinal)))
        if (finalFrameEn) sec += ` The segment ends on this final frame: ${finalFrameEn}.`
      }
    }

    const lines = parseDialogue(sh.dialogue)
    const distinctTones = new Set(lines.map((d) => clean(d?.tone)).filter(Boolean))
    const toneFallbackEn = distinctTones.size <= 1 ? pickEnglish(translated.tone_en) : ''
    const dlgParts = []
    for (const d of lines) {
      const who = clean(d?.character || d?.speaker || d?.name)
      const text = clean(d?.text || d?.line || d?.content)
      if (!who || !text) continue
      const subjIdx = refs.findIndex((r) => r.label === who || r.labelEn === who)
      const rawTone = normalizeTone(translateTone(d?.tone) || toneFallbackEn)
      const toneEn = voiceClone ? deShout(rawTone) : rawTone
      const sId = (subjIdx >= 0 ? speakerIdMap.get(subjIdx + 1) : null)
        || (speakerIds instanceof Map ? speakerIds.get(who) : null)
      const speakerRef = subjIdx >= 0
        ? `<Subject ${subjIdx + 1}>${sId ? ` (${sId})` : ''}`
        : `${pickEnglish(who) || 'the character'}${sId ? ` (${sId})` : ''}`
      let t = ''
      if (d?.startTime != null && d.startTime !== '') {
        const rel = Number(d.startTime) - segStart
        if (!isNaN(rel) && rel >= 0 && rel <= duration) t = `At ${formatCutTimestamp(rel)}, `
      }
      const aIdx = subjIdx >= 0 ? audioRefs.findIndex((a) => a.subjectNum === subjIdx + 1) : -1
      const timbreClause = aIdx >= 0 ? `, using the voice timbre referenced from <Audio ${aIdx + 1}>` : ''
      const steadyClause = aIdx >= 0 ? ', softly and steadily' : ''
      const toneClause = toneEn ? ` says ${toneEn}${steadyClause}${timbreClause},` : ` says${steadyClause}${timbreClause},`
      dlgParts.push(`${t}${speakerRef}${toneClause} <d>[Chinese] ${text}</d>`)
    }
    if (dlgParts.length) sec += ' ' + dlgParts.join(' ')
    shotSections.push(sec)
  }
  ddParts.push(...shotSections)
  parts.push('detailed_description:')
  parts.push(ddParts.join(' '))

  const ssFirst = pickEnglish(translatedAll[0]?.soundscape_en)
    || stripResidualCjk(translatedAll[0]?.soundscape_en)
    || pickEnglish(shots[0].overall_soundscape)
  parts.push('overall_soundscape:')
  parts.push(ssFirst || 'N/A')

  const muFirst = pickEnglish(translatedAll[0]?.music_en)
    || stripResidualCjk(translatedAll[0]?.music_en)
    || pickEnglish(shots[0].non_diegetic_music)
  parts.push('non_diegetic_music:')
  parts.push(muFirst || 'N/A')

  return parts.join('\n')
}

export function validateSegmentPrompt(prompt, shotCount = 0) {
  const errors = []
  const warnings = []
  const text = String(prompt || '')

  const SECTIONS = ['subject_definitions:', 'summary:', 'retention_analysis:', 'detailed_description:', 'overall_soundscape:', 'non_diegetic_music:']
  const idx = []
  for (const name of SECTIONS) {
    const i = text.indexOf('\n' + name)
    if (i < 0) { errors.push(`缺段：${name}`); idx.push(-1) } else idx.push(i)
  }
  for (let i = 1; i < idx.length; i++) {
    if (idx[i - 1] >= 0 && idx[i] >= 0 && idx[i] < idx[i - 1]) errors.push(`段顺序错误：${SECTIONS[i]} 出现在 ${SECTIONS[i - 1]} 之前`)
  }
  if (!/^Director guidance below is for visual generation only:/.test(text)) {
    errors.push('首行不是标准 guard 行')
  }
  const LAST = SECTIONS.length - 1
  const lastIdx = idx[LAST]
  if (lastIdx >= 0) {
    const tail = text.slice(lastIdx + SECTIONS[LAST].length)
    if (/^\s*\n[a-z_]+:\s*$/m.test(tail)) errors.push('第六段之后仍有段落标题（prompt 必须收在 non_diegetic_music）')
  }
  for (let i = 0; i < SECTIONS.length; i++) {
    if (idx[i] < 0) continue
    const start = idx[i] + SECTIONS[i].length
    const end = i + 1 < SECTIONS.length && idx[i + 1] > idx[i] ? idx[i + 1] : text.length
    const body = text.slice(start, end).trim()
    if (!body) errors.push(`段内容为空（无内容应写 N/A）：${SECTIONS[i]}`)
  }
  const CJK_EXTRACT_RE = new RegExp(CJK_DIRTY_RE.source + '+', 'g')
  const withoutD = text.replace(/<d>[\s\S]*?<\/d>/g, '')
  const cjk = withoutD.match(CJK_EXTRACT_RE)
  if (cjk) errors.push(`<d> 标签外出现中文：${[...new Set(cjk)].slice(0, 5).join('、')}`)

  if (shotCount > 0) {
    for (let i = 1; i <= shotCount; i++) {
      if (!text.includes(`[Shot ${i}]`)) errors.push(`缺镜头标记：[Shot ${i}]`)
    }
    if (shotCount > 1) {
      for (let i = 2; i <= shotCount; i++) {
        const re = new RegExp(`\\[Shot ${i}\\]\\s*At \\d{2}:\\d{2}\\.\\d{3},`)
        if (!re.test(text)) errors.push(`[Shot ${i}] 缺切点时间戳（At MM:SS.mmm,）`)
      }
    }
  }
  const tagRe = /<([A-Za-z][\w-]*)\s*\d*>/g
  const ALLOWED = new Set(['Subject', 'Picture', 'Video', 'Audio', 'd'])
  let m
  while ((m = tagRe.exec(text))) {
    if (!ALLOWED.has(m[1])) errors.push(`非官方标签：<${m[1]}>`)
  }

  return { ok: errors.length === 0, errors, warnings }
}
