import crypto from 'node:crypto'
import { CJK_DIRTY_RE } from './shared.js'

export const VIDEO_SEMANTICS_VERSION = 2

const jsonArray = (value) => {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean)
  try {
    const parsed = JSON.parse(String(value || '[]'))
    return Array.isArray(parsed) ? parsed.map((item) => String(item || '').trim()).filter(Boolean) : []
  } catch {
    return []
  }
}

const text = (...values) => values.map((value) => String(value || '').trim()).find(Boolean) || ''
const hasChinese = (value) => CJK_DIRTY_RE.test(String(value || ''))
const cleanEnglish = (value) => String(value || '').replace(/@/g, '').replace(/\s+/g, ' ').trim()

function sourceFingerprint(shot = {}) {
  const source = {
    description: text(shot.description),
    actionNote: text(shot.action_note, shot.actionNote),
    soundscape: text(shot.overall_soundscape, shot.overallSoundscape),
    soundEffects: text(shot.sound_effects, shot.soundEffects),
    finalFrame: text(shot.final_frame, shot.finalFrame),
    worldStateIn: text(shot.world_state_in, shot.worldStateIn),
    worldStateOut: text(shot.world_state_out, shot.worldStateOut),
    worldStateInEn: text(shot.world_state_in_en, shot.worldStateInEn),
    worldStateOutEn: text(shot.world_state_out_en, shot.worldStateOutEn),
    characters: jsonArray(shot.characters),
    sceneAssets: jsonArray(shot.scene_assets || shot.sceneAssets),
    propAssets: jsonArray(shot.prop_assets || shot.propAssets),
    shotType: text(shot.shot_type, shot.shotType),
    cameraMovement: text(shot.camera_movement, shot.cameraMovement),
    cameraAngle: text(shot.camera_angle, shot.cameraAngle),
    cameraElevation: text(shot.camera_elevation, shot.cameraElevation),
    lens: text(shot.lens),
    composition: text(shot.composition),
    depthOfField: text(shot.depth_of_field, shot.depthOfField),
    transitionIn: text(shot.transition_in, shot.transitionIn),
    transitionOut: text(shot.transition_out, shot.transitionOut),
    colorLighting: text(shot.color_lighting, shot.colorLighting),
    dialogue: text(shot.dialogue),
    music: text(shot.non_diegetic_music, shot.nonDiegeticMusic),
    purpose: text(shot.purpose),
    goal: text(shot.goal),
    emotionTone: text(shot.emotion_tone, shot.emotionTone),
    infoPoints: text(shot.info_points, shot.infoPoints),
  }
  return crypto.createHash('sha256').update(JSON.stringify(source)).digest('hex')
}

function isNoCharacterShot(shot, narrative = '') {
  const declared = jsonArray(shot.characters)
  const description = `${shot.description || ''} ${narrative || ''} ${shot.final_frame || shot.finalFrame || ''}`
  return declared.length === 0 && /无人物|无角色|没有角色|空镜|no characters?|no people|no figure|empty scene/i.test(description)
}

function stateSubjects(value) {
  const names = []
  const re = /(?:^|[;；])\s*@?([^=：:;；\n]+?)\s*(?:=|：|:)/g
  let match
  while ((match = re.exec(String(value || '')))) {
    const name = String(match[1] || '').trim()
    if (name && !names.includes(name)) names.push(name)
  }
  return names
}

function stateAllowed(value, allowed) {
  return stateSubjects(value).every((name) => allowed.has(name))
}

function buildTimeline(shot, actionEn) {
  if (!actionEn) return []
  const points = []
  const re = /(?:at\s+)(\d+(?:\.\d+)?)\s*s?\b/gi
  let match
  while ((match = re.exec(actionEn))) {
    const time = Number(match[1])
    if (!Number.isFinite(time) || points.some((point) => point.time === time)) continue
    points.push({ id: `beat-${points.length + 1}`, time, action: actionEn })
  }
  return points
}

export function compileVideoSemantics(shot = {}) {
  const characters = jsonArray(shot.characters)
  const scenes = jsonArray(shot.scene_assets || shot.sceneAssets)
  const props = jsonArray(shot.prop_assets || shot.propAssets)
  const allowed = new Set([...characters, ...scenes, ...props])
  const descriptionEn = text(shot.description_en, shot.descriptionEn)
  const actionEn = text(shot.action_note_en, shot.actionNoteEn)
  const soundscapeEn = text(shot.soundscape_en, shot.soundscapeEn)
  const openingState = text(shot.world_state_in_en, shot.worldStateInEn)
  const endingState = text(shot.world_state_out_en, shot.worldStateOutEn)
  const finalFrame = text(shot.final_frame, shot.finalFrame)
  const narrative = descriptionEn
  const noCharacter = isNoCharacterShot(shot, narrative)
  const errors = []
  const warnings = []

  if (text(shot.description) && !narrative) errors.push({ code: 'VIDEO_DESCRIPTION_EN_MISSING', field: 'description', message: '画面描述没有可靠英文来源' })
  if (text(shot.action_note) && !actionEn) errors.push({ code: 'VIDEO_ACTION_EN_MISSING', field: 'action_note', message: '动作说明没有可靠英文编译结果' })
  if (text(shot.overall_soundscape, shot.sound_effects) && !soundscapeEn) warnings.push({ code: 'VIDEO_SOUNDSCAPE_EN_MISSING', field: 'soundscape', message: '声景没有可靠英文来源' })
  if (text(shot.world_state_in, shot.worldStateIn) && !openingState && !noCharacter) errors.push({ code: 'VIDEO_OPENING_STATE_EN_MISSING', field: 'world_state_in', message: '开场状态没有可靠英文来源' })
  if (text(shot.world_state_out, shot.worldStateOut) && !endingState && !noCharacter) errors.push({ code: 'VIDEO_ENDING_STATE_EN_MISSING', field: 'world_state_out', message: '收尾状态没有可靠英文来源' })
  if (text(shot.final_frame, shot.finalFrame) && (!finalFrame || hasChinese(finalFrame))) errors.push({ code: 'VIDEO_FINAL_FRAME_INVALID', field: 'final_frame', message: '末帧必须是可靠纯英文描述' })
  if (!characters.length && noCharacter) warnings.push({ code: 'VIDEO_NO_CHARACTER_SHOT', field: 'characters', message: '本镜明确无人物，禁止继承上一镜角色状态' })
  if (!stateAllowed(shot.world_state_in || shot.worldStateIn, allowed)) errors.push({ code: 'VIDEO_OPENING_STATE_SUBJECT_CONFLICT', field: 'world_state_in', message: '开场状态引用了本镜未声明主体' })
  if (!stateAllowed(shot.world_state_out || shot.worldStateOut, allowed)) errors.push({ code: 'VIDEO_ENDING_STATE_SUBJECT_CONFLICT', field: 'world_state_out', message: '收尾状态引用了本镜未声明主体' })

  const mustNotShow = noCharacter ? ['people', 'characters', 'animals'] : []
  const mustShow = [...characters, ...scenes, ...props]
  const semantics = {
    schemaVersion: VIDEO_SEMANTICS_VERSION,
    subjects: { visible: characters, scene: scenes, props, offscreen: [], mustNotShow },
    framing: {
      shotType: text(shot.shot_type, shot.shotType),
      cameraAngle: text(shot.camera_angle, shot.cameraAngle),
      cameraElevation: text(shot.camera_elevation, shot.cameraElevation),
      lens: text(shot.lens),
      cameraMovement: text(shot.camera_movement, shot.cameraMovement),
    },
    narrative,
    openingState,
    timeline: buildTimeline(shot, actionEn),
    endingState,
    finalFrame,
    soundscape: soundscapeEn,
    mustShow,
    mustNotShow,
    sourceFingerprint: sourceFingerprint(shot),
    status: errors.length ? 'blocked' : 'ready',
    errors,
    warnings,
  }
  return semantics
}

export function parseVideoSemantics(value) {
  if (!value) return null
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

export function validateVideoSemantics(shot = {}, semantics = null) {
  const current = parseVideoSemantics(semantics)
  if (!current) return { ok: false, code: 'VIDEO_SEMANTICS_MISSING', errors: [{ code: 'VIDEO_SEMANTICS_MISSING', message: '视频语义契约尚未编译' }] }
  const expected = sourceFingerprint(shot)
  const errors = [...(Array.isArray(current.errors) ? current.errors : [])]
  if (current.schemaVersion !== VIDEO_SEMANTICS_VERSION) errors.push({ code: 'VIDEO_SEMANTICS_LEGACY', message: '视频语义契约版本过旧，需要重新编译' })
  if (current.sourceFingerprint !== expected) errors.push({ code: 'VIDEO_SEMANTICS_STALE', message: '视频语义契约已过期，请重新编译分镜英文语义' })
  if (current.status !== 'ready') errors.push({ code: 'VIDEO_SEMANTICS_BLOCKED', message: '视频语义契约未达到 ready 状态' })
  if (!current.narrative && text(shot.description)) errors.push({ code: 'VIDEO_NARRATIVE_MISSING', message: '最终视频语义缺少画面叙事' })
  if (text(shot.action_note) && (!Array.isArray(current.timeline) || current.timeline.length === 0) && !current.action) errors.push({ code: 'VIDEO_TIMELINE_MISSING', message: '最终视频语义缺少动作时间轴' })
  return { ok: errors.length === 0, errors, semantics: current }
}

export { sourceFingerprint }
