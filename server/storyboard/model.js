import { randomUUID } from 'node:crypto'

export const STORYBOARD_SCHEMA_VERSION = 2

export const FIELD_SOURCE = Object.freeze({
  MANUAL: 'manual',
  AI: 'ai',
  IMPORTED: 'imported',
  DERIVED: 'derived',
  VERSION_RESTORE: 'version_restore',
  LEGACY: 'legacy',
})

export const STORYBOARD_FIELD_MAP = Object.freeze({
  description: ['description'],
  shot_type: ['shotType', 'shot_type'],
  camera_movement: ['cameraMovement', 'camera_movement'],
  camera_angle: ['cameraAngle', 'camera_angle'],
  camera_elevation: ['cameraElevation', 'camera_elevation'],
  action_note: ['actionNote', 'action_note'],
  sound_effects: ['soundEffects', 'sound_effects'],
  dialogue: ['dialogue'],
  overall_soundscape: ['overallSoundscape', 'overall_soundscape'],
  non_diegetic_music: ['nonDiegeticMusic', 'non_diegetic_music'],
  integrated_multimodal_description: ['integratedMultimodalDescription', 'integrated_multimodal_description'],
  final_frame: ['finalFrame', 'final_frame'],
  purpose: ['purpose'],
  goal: ['goal'],
  emotion_tone: ['emotionTone', 'emotion_tone'],
  info_points: ['infoPoints', 'info_points'],
  world_state_out: ['worldStateOut', 'world_state_out'],
  characters: ['characters'],
  scene_assets: ['sceneAssets', 'scene_assets'],
  prop_assets: ['propAssets', 'prop_assets'],
  composition: ['composition'],
  lens: ['lens'],
  depth_of_field: ['depthOfField', 'depth_of_field'],
  transition_in: ['transitionIn', 'transition_in'],
  transition_out: ['transitionOut', 'transition_out'],
  color_lighting: ['colorLighting', 'color_lighting'],
  space_type: ['spaceType', 'space_type'],
  space_evidence: ['spaceEvidence', 'space_evidence'],
})

export const STORYBOARD_AUTHORING_FIELDS = Object.freeze(Object.keys(STORYBOARD_FIELD_MAP))

function pickValue(input, keys) {
  for (const key of keys) {
    if (input?.[key] !== undefined) return input[key]
  }
  return undefined
}

function hasAuthoredValue(value) {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim() !== ''
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

export function parseFieldSources(value) {
  if (!value) return {}
  if (typeof value === 'object' && !Array.isArray(value)) return { ...value }
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function mergeFieldSources(existing = {}, incoming = {}) {
  const merged = parseFieldSources(existing)
  for (const [field, source] of Object.entries(parseFieldSources(incoming))) {
    if (field && source) merged[field] = source
  }
  return merged
}

export function buildFieldSourcesForInput(input = {}, source = FIELD_SOURCE.LEGACY, fields = STORYBOARD_AUTHORING_FIELDS) {
  const result = {}
  for (const field of fields) {
    const value = pickValue(input, STORYBOARD_FIELD_MAP[field] || [field])
    if (hasAuthoredValue(value)) result[field] = source
  }
  return result
}

export function resolveStoryboardSource(source) {
  return source === 'imported' ? FIELD_SOURCE.IMPORTED : FIELD_SOURCE.AI
}

export function buildStructuralFieldsForInput(input = {}) {
  const result = {}
  const setValue = (field, keys, transform = (value) => value ?? '') => {
    const value = pickValue(input, keys)
    if (value !== undefined) result[field] = transform(value)
  }
  setValue('beat_id', ['beatId', 'beat_id'])
  setValue('coverage_id', ['coverageId', 'coverage_id'])
  setValue('relation_type', ['relationType', 'relation_type'])
  setValue('related_shots_json', ['relatedShots', 'related_shots_json', 'related_shots'], (value) => JSON.stringify(value ?? []))
  setValue('composition', ['composition'])
  setValue('lens', ['lens'])
  setValue('camera_elevation', ['cameraElevation', 'camera_elevation'])
  setValue('depth_of_field', ['depthOfField', 'depth_of_field'])
  setValue('transition_in', ['transitionIn', 'transition_in'])
  setValue('transition_out', ['transitionOut', 'transition_out'])
  setValue('color_lighting', ['colorLighting', 'color_lighting'])
  setValue('space_type', ['spaceType', 'space_type'])
  setValue('space_evidence', ['spaceEvidence', 'space_evidence'])
  return result
}

export function buildPromptProvenanceForInput(input = {}) {
  const result = {}
  const setValue = (field, keys) => {
    const value = pickValue(input, keys)
    if (value !== undefined) result[field] = value ?? ''
  }
  setValue('prompt_provider_id', ['promptProviderId', 'prompt_provider_id'])
  setValue('compiled_prompt', ['compiledPrompt', 'compiled_prompt'])
  setValue('prompt_compiled_at', ['promptCompiledAt', 'prompt_compiled_at'])
  return result
}

export function ensureShotUid(value) {
  return String(value || '').trim() || randomUUID()
}

export function parseRelatedShots(value) {
  if (Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(value || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function normalizeStoryboardDocument(input = {}, options = {}) {
  const rawScenes = Array.isArray(input.scenes) ? input.scenes : []
  return {
    schemaVersion: STORYBOARD_SCHEMA_VERSION,
    source: options.source || input.source || '',
    providerId: options.providerId || input.providerId || '',
    scenes: rawScenes.map((scene, sceneIndex) => ({
      ...scene,
      sceneNumber: scene.sceneNumber ?? scene.scene_number ?? sceneIndex + 1,
      shots: (Array.isArray(scene.shots) ? scene.shots : []).map((shot, shotIndex) => ({
        ...shot,
        shotNumber: shot.shotNumber ?? shot.shot_number ?? `${scene.sceneNumber ?? scene.scene_number ?? sceneIndex + 1}-${shotIndex + 1}`,
        shotUid: ensureShotUid(shot.shotUid || shot.shot_uid),
        beatId: shot.beatId || shot.beat_id || `beat-${scene.sceneNumber ?? scene.scene_number ?? sceneIndex + 1}-${shotIndex + 1}`,
        coverageId: shot.coverageId || shot.coverage_id || `coverage-${scene.sceneNumber ?? scene.scene_number ?? sceneIndex + 1}`,
        relatedShots: parseRelatedShots(shot.relatedShots ?? shot.related_shots_json ?? shot.related_shots),
        fieldSources: parseFieldSources(shot.fieldSources || shot.field_sources_json),
      })),
    })),
  }
}

export function buildShotRelationGraph(input = {}) {
  const document = Array.isArray(input.scenes) ? input : normalizeStoryboardDocument(input)
  const nodes = []
  const edges = []
  const beatGroups = new Map()
  const coverageGroups = new Map()
  for (const scene of document.scenes || []) {
    for (const shot of scene.shots || []) {
      const id = shot.shotUid || shot.shot_id || shot.id
      nodes.push({ id, shotNumber: shot.shotNumber || shot.shot_number || '', beatId: shot.beatId || shot.beat_id || '', coverageId: shot.coverageId || shot.coverage_id || '' })
      const beatId = shot.beatId || shot.beat_id || ''
      const coverageId = shot.coverageId || shot.coverage_id || ''
      if (beatId) beatGroups.set(beatId, [...(beatGroups.get(beatId) || []), id])
      if (coverageId) coverageGroups.set(coverageId, [...(coverageGroups.get(coverageId) || []), id])
      for (const target of parseRelatedShots(shot.relatedShots ?? shot.related_shots_json)) {
        edges.push({ from: id, to: target.shotUid || target.shot_uid || target.id || target, type: shot.relationType || shot.relation_type || 'related' })
      }
    }
  }
  return { nodes, edges, beatGroups: Object.fromEntries(beatGroups), coverageGroups: Object.fromEntries(coverageGroups) }
}
