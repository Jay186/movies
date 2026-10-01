import crypto from 'node:crypto'
import { UPLOADS_URL_SLASH, UPLOADS_PREFIX_RE } from '../paths.js'
import fs from 'node:fs'
import path from 'node:path'

function clean(value) {
  return String(value || '').trim()
}

function localPathFromUpload(url, uploadsDir) {
  const raw = clean(url)
  if (!raw.startsWith(UPLOADS_URL_SLASH) || !uploadsDir) return null
  const relative = decodeURIComponent(raw.split(/[?#]/)[0]).replace(UPLOADS_PREFIX_RE, '')
  if (!relative) return null
  const root = path.resolve(uploadsDir)
  const resolved = path.resolve(root, relative)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null
  return fs.existsSync(resolved) ? resolved : null
}

export function mediaFingerprint(url, { uploadsDir = '' } = {}) {
  const source = clean(url)
  const localPath = localPathFromUpload(source, uploadsDir)
  if (!localPath) return { source, versionKnown: false, revision: '', contentHash: '' }
  try {
    const contentHash = crypto.createHash('sha256').update(fs.readFileSync(localPath)).digest('hex')
    return { source, versionKnown: true, revision: contentHash, contentHash }
  } catch {
    return { source, versionKnown: false, revision: '', contentHash: '' }
  }
}

export function normalizeReferenceSet({ shotId = null, episodeId = null, images = [], audios = [], videos = [], anchor = null, uploadsDir = '' } = {}) {
  const warnings = []
  const seen = new Set()
  const normalizeMedia = (item, slot, kind) => {
    const url = clean(item?.image || item?.audio || item?.url)
    const fp = mediaFingerprint(url, { uploadsDir })
    if (url && seen.has(`${kind}:${url}`)) warnings.push({ code: 'REFERENCE_DUPLICATE', kind, url })
    if (url) seen.add(`${kind}:${url}`)
    if (url && !fp.versionKnown) warnings.push({ code: 'REFERENCE_VERSION_UNKNOWN', kind, url })
    return {
      slot,
      kind,
      assetId: item?.assetId ?? item?.asset_id ?? null,
      name: clean(item?.label || item?.name || item?.title),
      nameSnapshot: clean(item?.label || item?.name || item?.title),
      url,
      source: clean(item?.source || 'shot'),
      revision: clean(item?.revision || fp.revision),
      contentHash: fp.contentHash,
      versionKnown: fp.versionKnown,
      subjectNum: item?.subjectNum ?? null,
      previousShotId: item?.previousShotId ?? null,
    }
  }
  const normalizedImages = (Array.isArray(images) ? images : []).map((item, index) => normalizeMedia(item, index + 1, clean(item?.kind || item?.type || 'image')))
  const normalizedAudios = (Array.isArray(audios) ? audios : []).map((item, index) => normalizeMedia(item, index + 1, 'audio'))
  const normalizedVideos = (Array.isArray(videos) ? videos : []).map((item, index) => normalizeMedia(item, index + 1, 'video'))
  const a = anchor || {}
  return {
    shotId,
    episodeId,
    images: normalizedImages,
    audios: normalizedAudios,
    videos: normalizedVideos,
    anchor: {
      baselineUrl: clean(a.baselineUrl || a.baseline_url),
      layoutUrl: clean(a.layoutUrl || a.layout_url),
      sourceFingerprint: clean(a.sourceFingerprint || a.source_fingerprint),
      degraded: Boolean(a.degraded),
      reason: clean(a.reason),
    },
    warnings,
  }
}
