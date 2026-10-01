import crypto from 'node:crypto'

function arrayValue(value) {
  if (Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(String(value || '[]'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function normalizeItem(item) {
  if (typeof item === 'string') return { id: null, nameSnapshot: item.trim(), legacy: true }
  return {
    id: item?.id ?? item?.assetId ?? item?.asset_id ?? null,
    nameSnapshot: String(item?.nameSnapshot || item?.name || '').trim(),
    legacy: false,
  }
}

export function parseShotAssetRefs(shot = {}) {
  const raw = shot.asset_refs_json || shot.assetRefsJson || shot.assetRefs
  if (raw) {
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
      if (parsed && typeof parsed === 'object') {
        return {
          schemaVersion: Number(parsed.schemaVersion) || 2,
          characters: arrayValue(parsed.characters).map(normalizeItem),
          scenes: arrayValue(parsed.scenes).map(normalizeItem),
          props: arrayValue(parsed.props).map(normalizeItem),
          legacy: false,
        }
      }
    } catch { }
  }
  return {
    schemaVersion: 1,
    characters: arrayValue(shot.characters).map(normalizeItem),
    scenes: arrayValue(shot.scene_assets || shot.sceneAssets).map(normalizeItem),
    props: arrayValue(shot.prop_assets || shot.propAssets).map(normalizeItem),
    legacy: true,
  }
}

export function serializeShotAssetRefs(refs = {}) {
  return JSON.stringify({
    schemaVersion: 2,
    characters: (refs.characters || []).map(normalizeItem),
    scenes: (refs.scenes || []).map(normalizeItem),
    props: (refs.props || []).map(normalizeItem),
  })
}

export function buildShotAssetRefs({ characters = [], scenes = [], props = [] } = {}, assets = {}) {
  const resolve = (items, rows, nameKey) => (Array.isArray(items) ? items : []).map((item) => {
    const name = typeof item === 'string' ? item.trim() : String(item?.nameSnapshot || item?.name || '').trim()
    const row = (rows || []).find((candidate) => String(candidate?.[nameKey] || candidate?.name || '').trim() === name)
    return { id: row?.id ?? null, nameSnapshot: name, legacy: false }
  })
  return {
    schemaVersion: 2,
    characters: resolve(characters, assets.characters, 'name'),
    scenes: resolve(scenes, assets.scenes, 'title'),
    props: resolve(props, assets.props, 'name'),
  }
}

export function resolveShotAssetRefs(shot, assets = {}) {
  const refs = parseShotAssetRefs(shot)
  const warnings = []
  const resolve = (items, rows, nameKey, type) => items.map((ref) => {
    let row = ref.id != null ? (rows || []).find((candidate) => Number(candidate?.id) === Number(ref.id)) : null
    if (!row && ref.nameSnapshot) {
      row = (rows || []).find((candidate) => String(candidate?.[nameKey] || candidate?.name || '').trim() === ref.nameSnapshot)
      if (row && ref.id != null) warnings.push({ code: 'ASSET_ID_FALLBACK_NAME', type, id: ref.id, nameSnapshot: ref.nameSnapshot })
    }
    if (!row) warnings.push({ code: 'ASSET_REFERENCE_BROKEN', type, id: ref.id, nameSnapshot: ref.nameSnapshot })
    return { ...ref, type, row: row || null, broken: !row }
  })
  return {
    schemaVersion: refs.schemaVersion,
    legacy: refs.legacy,
    warnings,
    characters: resolve(refs.characters, assets.characters, 'name', 'character'),
    scenes: resolve(refs.scenes, assets.scenes, 'title', 'scene'),
    props: resolve(refs.props, assets.props, 'name', 'prop'),
  }
}

export function assetRefFingerprint(resolved = {}) {
  const payload = ['characters', 'scenes', 'props'].flatMap((type) => (resolved[type] || []).map((ref) => ({
    type,
    id: ref.id ?? ref.row?.id ?? null,
    nameSnapshot: ref.nameSnapshot || '',
    imageUrl: ref.row?.image_url || '',
  })))
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}
