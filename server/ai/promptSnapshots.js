import crypto from 'node:crypto'
import { normalizeReferenceSet as normalizeReferenceSetWithHashes } from './referenceSet.js'
import { query, queryOne, execute } from '../db.js'

export const PROMPT_SNAPSHOT_VERSION = 1

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
  }
  return value
}

export function normalizeReferenceSet(refs = [], audioRefs = [], continuity = {}, extra = {}) {
  return {
    images: (Array.isArray(refs) ? refs : []).map((ref, index) => ({
      slot: index + 1,
      kind: String(ref?.kind || ''),
      label: String(ref?.label || ''),
      labelEn: String(ref?.labelEn || ''),
      image: String(ref?.image || ''),
      version: String(ref?.version || ref?.imageVersion || ''),
    })),
    audio: (Array.isArray(audioRefs) ? audioRefs : []).map((audio, index) => ({
      slot: index + 1,
      subjectNum: Number(audio?.subjectNum) || null,
      label: String(audio?.label || ''),
      audio: String(audio?.audio || ''),
      version: String(audio?.version || audio?.audioVersion || ''),
    })),
    continuity: {
      previousShotId: continuity?.previousShotId ?? null,
      tailFrame: String(continuity?.tailFrame || ''),
      tailFrameVersion: String(continuity?.tailFrameVersion || ''),
      continuationVideo: String(continuity?.continuationVideo || ''),
      continuationVideoVersion: String(continuity?.continuationVideoVersion || ''),
    },
    ...extra,
  }
}

export function fingerprintPromptSnapshotInput(input = {}) {
  const { inputFingerprint: _ignored, ...source } = input || {}
  const canonical = stable({ schemaVersion: PROMPT_SNAPSHOT_VERSION, ...source })
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

export function buildPromptSnapshotInput({ shot, semantic, referenceSet, prompt, providerId, workflowId, templateVersion, generationParams, retryFeedback }) {
  const semanticFingerprint = String(semantic?.sourceFingerprint || shot?.video_semantics_source_fingerprint || '')
  const input = {
    shotId: shot?.id ?? null,
    shotVersion: Number(shot?.version) || 1,
    semanticVersion: Number(semantic?.schemaVersion) || 0,
    semanticFingerprint,
    referenceSet: referenceSet?.images && referenceSet?.audios
      ? referenceSet
      : normalizeReferenceSetWithHashes({ images: referenceSet?.images || referenceSet, audios: referenceSet?.audio || [], videos: [], anchor: referenceSet?.continuity || {} }),
    providerId: String(providerId || ''),
    workflowId: String(workflowId || ''),
    templateVersion: String(templateVersion || ''),
    generationParams: generationParams || {},
    retryFeedback: String(retryFeedback || ''),
  }
  return { ...input, inputFingerprint: fingerprintPromptSnapshotInput(input) }
}

export function findPromptSnapshot(shotId, inputFingerprint) {
  return queryOne(
    `SELECT * FROM shot_prompt_snapshots
     WHERE shot_id = ? AND input_fingerprint = ? AND compile_status = 'ready'
     ORDER BY id DESC LIMIT 1`,
    [shotId, inputFingerprint],
  )
}

export function savePromptSnapshot({ episodeId, shotId, shotVersion, input, prompt }) {
  const result = execute(
    `INSERT INTO shot_prompt_snapshots
      (episode_id, shot_id, shot_version, semantic_fingerprint, reference_set_json,
       provider_id, workflow_id, template_version, generation_params_json,
       retry_feedback_hash, retry_feedback_text, input_fingerprint, compiled_prompt,
       compile_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready')`,
    [
      episodeId ?? null,
      shotId,
      shotVersion || 1,
      input.semanticFingerprint || '',
      JSON.stringify(input.referenceSet || {}),
      input.providerId || '',
      input.workflowId || '',
      input.templateVersion || '',
      JSON.stringify(input.generationParams || {}),
      crypto.createHash('sha256').update(String(input.retryFeedback || '')).digest('hex'),
      String(input.retryFeedback || ''),
      input.inputFingerprint,
      String(prompt || ''),
    ],
  )
  return queryOne('SELECT * FROM shot_prompt_snapshots WHERE id = ?', [result.lastInsertRowid])
}
