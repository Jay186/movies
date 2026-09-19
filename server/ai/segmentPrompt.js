// 段级 Ref2VA prompt 构造（E 路线 v2，2026-09-15）：
//   把一段内的 N 个镜（N 通常 1–4）合并成**一个 H3 任务**的 prompt——六段结构不变，
//   detailed_description 内用官方 `[Shot N] At MM:SS.mmm` 标记写段内切点。
//
// 与单镜通道（v4Video.buildShotVideoPromptV4）的关系：
//   · 六段骨架、guard 行、subject_definitions/retention 写法、喊叫抑制、音色绑定句式
//     **完全同源**——本模块直接复用 v4Video 的积木，不另造第二份（AGENTS.md §1 忌讳两套并存）。
//   · 差异只在 detailed_description：单镜写一个 [Shot 1]；段级写 [Shot 1] + [Shot 2]...
//     切点带 `At MM:SS.mmm,`，时间轴是**段内相对秒**。
//   · summary 写 "N-shot segment" 而不是 "single-shot clip"，并声明段内切点结构。
//
// 段内切点的官方写法（ref-en §4.3 / base-en §4.3）：
//   [Shot 1] 无时间戳；[Shot 2] 起写 `At MM:SS.mmm,` 表示切点。
//   实测 H3 对切点误差 ≤0.375s（17 帧网格档）——切片回填按镜边界切时这点误差可接受。
//
// 段间接力锚（anchorMode='prev-segment-last'）：
//   上一段成片末帧作为本段 <Picture N> continuity 锚，与单镜的"上一镜末帧"同语义
//   （继承角色/环境状态 + 色温，不锁机位）。
//
// 用法：buildSegmentVideoPrompt(segmentId) → { prompt, refs, audioRefs, duration, shotCount }

import { query, queryOne } from '../db.js'
import { segmentDurationSec } from './segmentBuilder.js'
import { translateShotFields, translateShotSize, translateCameraMovement, translateCameraAngle, translateTone } from './h3PromptTranslator.js'
import { deShout, cleanVoiceDescription } from './v4Video.js'
// clean / pickEnglish / stripResidualCjk / resolveAssetName 统一到 shared.js（判据单点）。
// 本文件原为三份拷贝里「未加固」的一份——英文名为空时回退中文名，中文落进英文正文
// （段级校验器硬拦即本轮 ep4 段1 出片报错的直接来源）。判据已收口，禁止再抄一份。
import { clean as cleanShared, pickEnglish, stripResidualCjk, resolveAssetName, truncateStyle, formatCutTimestamp, CJK_DIRTY_RE } from './shared.js'

const clean = (s) => cleanShared(s)
const cleanDesc = (s) => clean(s).replace(/[。.]+$/, '')
const lowerFirst = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : '')
const resolveDesc = (descEn, descCn) => lowerFirst(cleanDesc(pickEnglish(descEn) || pickEnglish(descCn)))
// truncateStyle 已收口到 ai/shared.js（顶部 import）——旧版无词边界，会把单词截半
// （atmosphere → at），三通道统一用 shared 的词边界版。
// 台词解析判据单点（2026-09-18 P0-3）：本文件原有一份本地 parseDialogue（含 'null'/'[]'
//   两处特判的第三份副本）。统一从 dialogue.js 走，判据不再散落。
import { parseDialogue } from './dialogue.js'
const normalizeTone = (t) => {
  const s = clean(t)
  if (!s) return ''
  // 官方语气词一律小写短句；这里只做首字母小写与去句号
  return s.replace(/[。.]+$/, '').toLowerCase()
}

// 折叠连续重复的冠词/介词：LLM 扩写常产出 "on the the snowy path"、"to the the river"
// （中文源"停在@雪山边界下山道"经扩写后出现 the + 场景名，而场景名自带 the）。
// 只折叠「同一虚词连续出现两次」，不碰实词，不改语义。
const ARTICLE_REPEAT_PAIRS = [
  [/\b(the)\s+the\b/gi, 'the'],
  [/\b(a)\s+a\b/gi, 'a'],
  [/\b(an)\s+an\b/gi, 'an'],
]
const dedupeArticles = (s) => {
  let out = String(s || '')
  let prev = ''
  // 反复折叠直到稳定（"the the the" → "the"）
  while (prev !== out) {
    prev = out
    for (const [re, rep] of ARTICLE_REPEAT_PAIRS) out = out.replace(re, rep)
  }
  return out.replace(/\s+/g, ' ').trim()
}
const GUARD = 'Director guidance below is for visual generation only: do not read aloud, narrate, or quote any of it — speak only the dialogue inside <d> tags. The generated video must contain no on-screen text, subtitles, watermark, or logo.'

// 段内相对秒 → `MM:SS.mmm` 的时间戳格式化已收口到 ai/shared.js 的 formatCutTimestamp
// （顶部 import）——本文件旧版本 `ts()` 曾是三通道里唯一修好的实现，现已提为单点。
// ⚠️ 格式固定两段式（MM:SS.mmm），**不要改成三段式 HH:MM:SS.mmm**——validateSegmentPrompt
// 的正则与单镜通道都按两段式契约校验，改了会全段校验失败（原警告保留于 shared.js）。

/**
 * 读段 + 段内镜（按存储序 = 播放序）。
 *
 * ⚠️ 返回值含 `missingIds`（2026-09-16 审核修复 P0-1）：
 *   段记录只存 shot_ids 快照，镜被删/重建后不会自动同步。**必须**把「记录里有、库里查不到」
 *   的 id 显式回传，否则调用方只看到 shots.length>0 就以为段是完整的——
 *   实测第2集有 3 个段属此形态（记录称 2 镜、实际只剩 1 镜），会带着残缺镜集合出片：
 *   资产少装配、prompt 少写 [Shot N]、切片少切一份 → 缺失镜永远拿不到 video_url，而币已花掉。
 *
 * 排序：按 **shot_ids 的存储序**重建（与 segmentSlicer 同口径），不再按 start_time 二次排序——
 *   段方案落库时 shot_ids 即按播放序写入；start_time 相同的镜排序不稳定会静默切出颠倒的视频。
 *
 * @returns {{ seg: Object, shots: Array, missingIds: number[], shotIds: number[] }|null}
 */
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

/**
 * 段级 prompt 构造。refs/audioRefs 由调用方（路由层）组装后传入，
 * 与单镜通道同源——本函数不自己查资产，避免两处口径漂移。
 *
 * @param {Object} p
 * @param {Object} p.seg - video_segments 行
 * @param {Array}  p.shots - 段内 shots 行（播放序）
 * @param {Array}  p.refs - 参考槽（同单镜通道格式）
 * @param {Array}  p.audioRefs - 音色槽 [{ subjectNum, label, audio }]
 * @param {string} p.stylePromptEn
 * @param {Map}    p.speakerIds - 全片说话人编号 角色名 → Sx
 * @param {boolean} p.isCombat
 * @param {string} p.combatNote
 * @returns {Promise<string>}
 */
export async function buildSegmentVideoPrompt(p) {
  const { seg, shots, refs = [], audioRefs = [], stylePromptEn = '', speakerIds, isCombat = false, combatNote = '' } = p
  const segStart = Number(seg.start_time) || 0
  // 段时长统一走 segmentBuilder.segmentDurationSec（P1-2 修复）：
  // 与段方案合法性判定、切片时间轴共用同一口径，避免"判定 12s / 生成 11s / 切片 11s"三头漂移。
  const duration = segmentDurationSec(seg, shots)
  const shotCount = shots.length
  const parts = []

  // ── 0) guard（六段外唯一允许的一行，同单镜通道） ──
  parts.push(GUARD)

  // ── 说话人编号（与单镜同规则：按全片实际发声先后，跨镜稳定） ──
  const speakerIdMap = new Map()
  if (speakerIds instanceof Map) {
    refs.forEach((r, i) => {
      const sid = speakerIds.get(r.label) || speakerIds.get(r.labelEn)
      if (sid) speakerIdMap.set(i + 1, sid)
    })
  } else {
    // 离线兜底：按段内发声先后编
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

  // ── 1) subject_definitions ──
  const subjectLines = refs.map((r, i) => {
    if (r.kind === 'storyboard') {
      return `<Picture ${i + 1}> is a storyboard reference for [Shot 1], defining its camera viewpoint, subject placement, and composition.`
    }
    if (r.kind === 'continuity') {
      // 段间接力锚：语义等同单镜的上一镜末帧锚（继承状态 + 锁色温，不锁机位）
      return `<Picture ${i + 1}> is the final frame of the previous segment, provided as a continuity anchor: the characters' positions, postures, orientations, relative sizes, the environment state, AND the exact color temperature, lighting direction, and tonal palette continue seamlessly from this frame — the color grade must match this frame exactly, with no shift toward warmer or cooler tones. It anchors character, environment, and color grade, NOT the camera viewpoint.`
    }
    if (r.kind === 'endframe') {
      return `<Picture ${i + 1}> is the target last frame of the segment, the final composition and character positions the segment must end on.`
    }
    if (r.kind === 'styleanchor') {
      return `<Picture ${i + 1}> is the final frame of the opening shot of this episode, provided as the absolute art-style anchor: every character, environment and effect in this segment MUST stay in this exact hand-drawn watercolor rendering style — same linework, texture, color palette and tonal grade. Never drift toward photorealistic, CGI or 3D rendering in any part of the frame.`
    }
    const typeLabel = r.kind === 'character' ? 'character' : (r.kind === 'prop' ? 'prop' : 'scene/environment')
    // 资产名走 shared.resolveAssetName：中文资产名（英文常量为空时）会降级为 `reference N`，
    // **绝不**出现在英文正文——这正是 ep4 段1 报错「<d> 标签外出现中文：雪山边界悬崖」的修法。
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

  // ── 2) summary ──
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

  // ── 3) retention_analysis ──
  const shotRefsAll = shots.map((_, i) => `[Shot ${i + 1}]`).join(', ')
  // §9.1 机制化（2026-09-15）：正文提到不在场角色会把它们拉进画面（失败案例：
  // 1-3 布布单人 ECU 被 retention 并集写法 + 描述里一句"一二的爪子"拉成双人中景）。
  // 按每镜 characters/scene_assets/prop_assets **实算**每个 Subject 的出场镜，
  // 非全场出场的写 `appears only in [Shot N]; absent from the other shots`——
  // 给模型一个显式「缺席声明」。匹配口径与 buildSegmentAssets 的 pushRef 完全对称
  // （都按中文名在 JSON 数组里精确匹配），实算结果必然覆盖该 ref 的来源镜。
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
    // 出场标注：按镜实算优先，实算不到（名字对不上/被图片去重挤掉）退回并集写法，
    // 不向模型断言缺席——错误的缺席声明比并集更危险。
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

  // ── 4) detailed_description（段内多镜，逐镜一节） ──
  const characterNames = refs.filter((r) => r.kind === 'character').map((r) => r.label)
  const sceneNames = refs.filter((r) => r.kind !== 'character').map((r) => r.label)
  const voicedNames = audioRefs.map((a) => refs[a.subjectNum - 1]?.label).filter(Boolean)
  const voiceClone = audioRefs.length > 0

  const ddParts = []
  if (style) ddParts.push(`The target video is in a cinematic, ${style} style.`)
  // 武戏内容修饰：与 v4Video.js 同式加中文守卫——combatNote 含中文（非英文触发词）时整句不入正文，
  // 否则中文落进 detailed_description（段级被校验器硬拦），宁缺勿脏。
  if (combatNote) ddParts.push(pickEnglish(combatNote) ? cleanDesc(combatNote) + '.' : '')

  const sbIdx = refs.findIndex((r) => r.kind === 'storyboard')
  const ctIdx = refs.findIndex((r) => r.kind === 'continuity')
  const efIdx = refs.findIndex((r) => r.kind === 'endframe')

  // 段内时间轴锚：段首照常；[Shot 2] 起写 At MM:SS.mmm（段内相对秒）
  const shotSections = []
  const translatedAll = []
  for (let i = 0; i < shots.length; i++) {
    const sh = shots[i]
    const shotRelStart = Number(sh.start_time) - segStart
    const shotDur = Number(sh.end_time) - Number(sh.start_time)

    // 手工 override 直通（2026-09-15）：video_prompt_override 非纯空即视为该镜
    // detailed_description 片段的英文终稿——**跳过 LLM 翻译层**，零失真落进 prompt。
    // 覆盖范围：景别/机位/运镜/动作节拍（这些不再自动拼装）；台词与末镜 final_frame
    // 句仍由下方常规逻辑追加，六段结构不变。
    const overrideTxt0 = dedupeArticles(cleanDesc(pickEnglish(String(sh.video_prompt_override || ''))))
    // cleanDesc 会剥掉末尾句号，导致 override 句子与后续标记（[Shot N]/承接句/final_frame 句）粘连，
    // 读起来像同一句——补回句号（已有 ?/.! 结尾则不动）
    const overrideTxt = overrideTxt0 && !/[.!?]$/.test(overrideTxt0) ? overrideTxt0 + '.' : overrideTxt0
    const translated = overrideTxt
      ? { description_en: '', action_note_en: '', soundscape_en: '', music_en: '', tone_en: '', failed: false }
      : { ...(await translateShotFields(sh, {
          characterNames, sceneNames, voiceClone, voicedNames,
        })) }
    // 中文角色名 → 英文名（与单镜同款修复：翻译层保留中文名，pickEnglish 会整段丢弃）
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
    // 画面描述里若开头重复了场景名（"the scene opens on the the snowy mountain border path"），
    // 会在 "A {景别}, {描述}" 的模板里与景别拼接后读成 "the the ..."。
    // 归一：折叠连续重复的 the / a / an。
    const rawVisual = dedupeArticles(cleanDesc(pickEnglish(translated.description_en) || stripResidualCjk(translated.description_en) || pickEnglish(sh.description)))
    const actionDesc = voiceClone ? cleanVoiceDescription(dedupeArticles(rawAction)) : rawAction
    const visualDesc = voiceClone ? cleanVoiceDescription(rawVisual) : rawVisual

    // 首镜开头：景别 + 构图锚 + 段间接力句；后续镜：At 时间戳 + 硬切；override 直通
    let sec = ''
    if (overrideTxt) {
      sec = i === 0 ? `[Shot 1] ${overrideTxt}` : `[Shot ${i + 1}] At ${formatCutTimestamp(shotRelStart)}, ${overrideTxt}`
      // override 直通不豁免段间接力：首镜有 continuity 锚时照常追加承接句
      // （retention 层虽已声明锚语义，句子层显式声明色温不漂移是接力连贯的关键，不省）
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
      // 运镜：未命中的中文运镜词不兜底 static（等于向模型断言相反机位），直接省略
      if (cameraMove) sec += ` The camera ${cameraMove}.`
      if (actionDesc) sec += ` ${actionDesc}.`
    }
    // 末镜收尾帧锚：有 endframe 图用图；无图用 final_frame 文字兜底。
    // final_frame 字段本身自带 "The final frame: " 前缀（分镜规则要求），直接用会与
    // 模板的 "The segment ends on this final frame: " 叠成双冒号，故先剥前缀。
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

    // 本镜台词（段内相对秒）
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
      // 说话人引用：命中参考槽写 <Subject N>；未命中（缺图未进 refs / 台词写了清单外的角色名或旁白）
      // 时 who 必须过 pickEnglish 复核——中文角色名一律不得落进英文正文，降级为中立的 'the character'
      // （与 ai/v4Video.js 逐字同源，两条通道判据必须一致）。
      const speakerRef = subjIdx >= 0
        ? `<Subject ${subjIdx + 1}>${sId ? ` (${sId})` : ''}`
        : `${pickEnglish(who) || 'the character'}${sId ? ` (${sId})` : ''}`
      // 台词时间戳：全片绝对 → 段内相对（- segStart）
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

  // ── 5) overall_soundscape（段级：只取【首镜】一句） ──
  // 为什么不逐镜拼：官方要求本段 1–4 句；把 N 镜各 1–4 句拼起来会变成 8+ 句的长篇，
  // 且实测拼接后出现「A low, hollow whistle… / A continuous low rumble…」两层重复描写
  // 同一件事（各镜译文本来就有大量同义环境音）。段级取首镜（段首环境音定调），
  // 后续镜的环境音变化已经在 detailed_description 的各 [Shot N] 里写清楚了。
  const ssFirst = pickEnglish(translatedAll[0]?.soundscape_en)
    || stripResidualCjk(translatedAll[0]?.soundscape_en)
    || pickEnglish(shots[0].overall_soundscape)
  parts.push('overall_soundscape:')
  parts.push(ssFirst || 'N/A')

  // ── 6) non_diegetic_music（段级：同上，取首镜） ──
  const muFirst = pickEnglish(translatedAll[0]?.music_en)
    || stripResidualCjk(translatedAll[0]?.music_en)
    || pickEnglish(shots[0].non_diegetic_music)
  parts.push('non_diegetic_music:')
  parts.push(muFirst || 'N/A')

  return parts.join('\n')
}

/**
 * 结构校验（AGENTS.md §1.1 硬约束）：
 *   · 六段顺序固定、缺段用 N/A、六段之外只允许顶部 guard 一行、prompt 收在第六段
 *   · 段级额外：每个 [Shot N] 都出现且连续（1 起）
 * 出片前调用，异常直接拦（prompt 结构错会静默毁掉成片，且币已经花了）。
 *
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
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
  // 顺序检查
  for (let i = 1; i < idx.length; i++) {
    if (idx[i - 1] >= 0 && idx[i] >= 0 && idx[i] < idx[i - 1]) errors.push(`段顺序错误：${SECTIONS[i]} 出现在 ${SECTIONS[i - 1]} 之前`)
  }
  // 首行 guard
  if (!/^Director guidance below is for visual generation only:/.test(text)) {
    errors.push('首行不是标准 guard 行')
  }
  // 收在最后一段：末段之后不得再有新段落标题或游离句子
  const LAST = SECTIONS.length - 1
  const lastIdx = idx[LAST]
  if (lastIdx >= 0) {
    const tail = text.slice(lastIdx + SECTIONS[LAST].length)
    // 允许 tail 内容（音乐描述），但不允许再出现段落式标题
    if (/^\s*\n[a-z_]+:\s*$/m.test(tail)) errors.push('第六段之后仍有段落标题（prompt 必须收在 non_diegetic_music）')
  }
  // 空段（应为 N/A 而不是空行）
  for (let i = 0; i < SECTIONS.length; i++) {
    if (idx[i] < 0) continue
    const start = idx[i] + SECTIONS[i].length
    const end = i + 1 < SECTIONS.length && idx[i + 1] > idx[i] ? idx[i + 1] : text.length
    const body = text.slice(start, end).trim()
    if (!body) errors.push(`段内容为空（无内容应写 N/A）：${SECTIONS[i]}`)
  }
  // 中文泄漏（<d> 标签外不得有汉字）
  // 判据一律从 shared.CJK_DIRTY_RE 派生（R15）：此前此处内联的是 [\u4e00-\u9fff]，
  // 只认表意文字 → 全角标点（如「：」U+FF1A）**漏报**，而入口闸门 pickEnglish 已扩集，
  // 两处判据不一致。g 版 = 脏字符集 + 贪婪连续，供提取泄漏词用。
  const CJK_EXTRACT_RE = new RegExp(CJK_DIRTY_RE.source + '+', 'g')
  const withoutD = text.replace(/<d>[\s\S]*?<\/d>/g, '')
  const cjk = withoutD.match(CJK_EXTRACT_RE)
  if (cjk) errors.push(`<d> 标签外出现中文：${[...new Set(cjk)].slice(0, 5).join('、')}`)

  // [Shot N] 连续性
  if (shotCount > 0) {
    for (let i = 1; i <= shotCount; i++) {
      if (!text.includes(`[Shot ${i}]`)) errors.push(`缺镜头标记：[Shot ${i}]`)
    }
    if (shotCount > 1) {
      // Shot 2 起必须带切点时间戳
      for (let i = 2; i <= shotCount; i++) {
        const re = new RegExp(`\\[Shot ${i}\\]\\s*At \\d{2}:\\d{2}\\.\\d{3},`)
        if (!re.test(text)) errors.push(`[Shot ${i}] 缺切点时间戳（At MM:SS.mmm,）`)
      }
    }
  }
  // 标签白名单（禁止自创标签）
  const tagRe = /<([A-Za-z][\w-]*)\s*\d*>/g
  const ALLOWED = new Set(['Subject', 'Picture', 'Video', 'Audio', 'd'])
  let m
  while ((m = tagRe.exec(text))) {
    if (!ALLOWED.has(m[1])) errors.push(`非官方标签：<${m[1]}>`)
  }

  return { ok: errors.length === 0, errors, warnings }
}
