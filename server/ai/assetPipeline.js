// 资产提取管线的统一落库模块。
// 把此前散落在 runFullPipeline（generate-script.js）、POST /generate/assets、
// 前端 store.extractAssets 三处的「提取 → 合并 → 写库」逻辑收敛到这一个实现：
//   归一化（去重/家具过滤）→ guard 风险预检（三表全有或全无）→ 快照 → 三表写入
//   → 场景引用重挂 + 孤儿清理 → 光影校验 → 指纹回写。
// 两条调用路径：
//   · 独立提取（POST /generate/assets）：guard=true，有风险先返回决策报告，拍板后带 decision 重入；
//   · 一键全流程（runFullPipeline）：guard=false，不拦截，覆盖风险以告警留证（recordAlerts）。
import { query, queryOne, execute, transaction } from '../db.js'
import { scriptHash } from '../scriptHash.js'
import { CJK_DIRTY_RE } from './shared.js'
import {
  replaceEpisodeCharacters,
  mergeMasterIntoEpisodeCharacters,
  findProjectCharacter,
} from '../characterLibrary.js'
import {
  snapshotBeforeExtract,
  computeExtractDiff,
  applyKeepForCharacters,
  applyKeepForProps,
  applyKeepForScenes,
} from './extractGuard.js'
import { recordAlert } from './alerts.js'
import { remapSceneRefs } from './sceneIdRemap.js'
import { config } from '../config.js'
import { ASSET_TYPES } from './assetTypes.js'

// ───────────────────────── 归一化（从 generate-script.js 移入） ─────────────────────────

export function dedupeAssets(list, keyFn) {
  if (!Array.isArray(list)) return list || []
  const seen = new Set()
  const result = []
  for (const item of list) {
    const raw = keyFn(item)
    if (!raw) continue
    const norm = String(raw).replace(/[\s，。！？、,.\s]/g, '').toLowerCase()
    if (!norm || seen.has(norm)) continue
    seen.add(norm)
    result.push(item)
  }
  return result
}

const FURNITURE_KEYWORDS = [
  '沙发', '茶几', '电视', '柜子', '桌子', '椅子', '书架', '衣柜', '餐桌',
  '地毯', '窗帘', '冰箱', '空调', '楼梯', '地板', '天花板', '台灯', '吊灯',
  '凳子', '床头柜', '鞋柜', '橱柜', '灶台',
]

function isFurniture(name) {
  const n = String(name || '').trim()
  return FURNITURE_KEYWORDS.some((kw) => {
    const k = kw.trim()
    return k && n.includes(k) && n.length <= k.length + 2
  })
}

export function filterFurnitureProps(assets) {
  if (Array.isArray(assets?.props)) {
    assets.props = assets.props.filter((p) => {
      const name = typeof p === 'string' ? p : p.name
      return !isFurniture(name)
    })
  }
  if (Array.isArray(assets?.scenes)) {
    for (const s of assets.scenes) {
      if (Array.isArray(s.props)) {
        s.props = s.props.filter((n) => !isFurniture(n))
      }
    }
  }
  return assets
}

// 提取结果的统一入口整形：数组兜底、空结果抛错、按名去重、家具类道具/挂件过滤。
// 幂等，extract 与 persist 两处调用无副作用。
export function normalizeExtractedAssets(assets) {
  const out = assets && typeof assets === 'object' ? assets : {}
  out.characters = Array.isArray(out.characters) ? out.characters : []
  out.props = Array.isArray(out.props) ? out.props : []
  out.scenes = Array.isArray(out.scenes) ? out.scenes : []
  if (!out.characters.length && !out.props.length && !out.scenes.length) {
    throw new Error('AI 未提取到任何资产，请重试')
  }
  out.characters = dedupeAssets(out.characters, (c) => (typeof c === 'string' ? c : c.name))
  out.props = dedupeAssets(out.props, (p) => (typeof p === 'string' ? p : p.name))
  out.scenes = dedupeAssets(out.scenes, (s) => (typeof s === 'string' ? s : s.name))
  filterFurnitureProps(out)
  return out
}

// ───────────────── 提取结果暂存（决策重试用，避免重复烧 LLM） ─────────────────

const STAGE_TTL_MS = 30 * 60 * 1000
const stagedAssets = new Map()

function pruneStaged(now = Date.now()) {
  for (const [k, v] of stagedAssets) {
    if (now - v.at > STAGE_TTL_MS) stagedAssets.delete(k)
  }
}

export function stageAssets(episodeId, assets) {
  if (episodeId == null || !assets) return
  pruneStaged()
  stagedAssets.set(String(episodeId), { assets, at: Date.now() })
}

// 取出并消费（一次性）：无暂存或已过期返回 null
export function takeStagedAssets(episodeId) {
  pruneStaged()
  const key = String(episodeId)
  const entry = stagedAssets.get(key)
  if (!entry) return null
  stagedAssets.delete(key)
  return entry.assets
}

export function clearStagedAssets(episodeId) {
  stagedAssets.delete(String(episodeId))
}

// ─────────────── asset_states 行快照（从 routes/episodes.js 移入共享） ───────────────

const STATE_COLS = ['asset_type', 'asset_key', 'state_key', 'label_zh', 'description', 'description_en', 'image_url', 'is_default', 'source']

export function snapshotAssetStatesForNames(assetType, names) {
  if (!config.assetState?.enabled) return []
  if (!ASSET_TYPES.includes(assetType)) return []
  const keys = [...new Set((names || []).map((n) => String(n || '').trim()).filter(Boolean))]
  if (!keys.length) return []
  try {
    const out = []
    for (const k of keys) {
      const rows = query(
        `SELECT ${STATE_COLS.join(', ')} FROM asset_states WHERE asset_type = ? AND asset_key = ?`,
        [assetType, k]
      )
      out.push(...rows)
    }
    return out
  } catch (e) {
    console.warn(`[assetPipeline] 状态行快照失败（不阻断保存）: ${e.message}`)
    return []
  }
}

export function restoreAssetStates(rows) {
  if (!config.assetState?.enabled) return 0
  if (!Array.isArray(rows) || !rows.length) return 0
  let n = 0
  try {
    for (const r of rows) {
      execute(
        `INSERT OR IGNORE INTO asset_states (${STATE_COLS.join(', ')})
         VALUES (${STATE_COLS.map(() => '?').join(', ')})`,
        STATE_COLS.map((c) => r[c])
      )
      n++
    }
  } catch (e) {
    console.warn(`[assetPipeline] 状态行回写失败（不阻断保存）: ${e.message}`)
  }
  return n
}

// ───────────────── 场景重建后的引用 reconcile（原 generate-script.js 私有函数） ─────────────────

export function remapSceneReferencesAfterRebuild(episodeId, oldScenes) {
  try {
    const newScenes = query('SELECT id, title, scene_number FROM scenes WHERE episode_id = ?', [episodeId])
    for (const table of ['scene_group_locks', 'scene_anchors']) {
      const refs = query(`SELECT id, scene_id FROM ${table} WHERE episode_id = ?`, [episodeId])
      const { updates, unmatched } = remapSceneRefs(oldScenes, newScenes, refs)
      for (const u of updates) {
        execute(`UPDATE ${table} SET scene_id = ? WHERE id = ?`, [u.to, u.id])
      }
      if (updates.length) {
        console.log(`[sceneIdRemap] ${table}: ${updates.length} 行 scene_id 已按稳定键重挂到新场景 id（episode=${episodeId}）`)
      }
      if (unmatched.length) {
        recordAlert({
          level: 'warn', source: 'sceneIdRemap', episodeId,
          message: `场景重建后有 ${unmatched.length} 条 ${table} 引用无法按标题/场次重挂（对应旧场景已不存在，行已保留待人工处置）`,
          detail: JSON.stringify(unmatched).slice(0, 2000),
        })
      }
    }
  } catch (e) {
    console.warn(`[sceneIdRemap] 引用重挂失败（不影响重建结果）: ${e.message}`)
  }
}

// 场景整表重建后的孤儿清理（对齐 routes/episodes.js 场景保存的清理口径）：
// 挂到已删除场景的 scene_analysis / scene 锚点直接删；spatial 锚点连带重置空间组评审。
export function cleanupOrphanedSceneRefs(episodeId) {
  try {
    execute('DELETE FROM scene_analysis WHERE episode_id = ? AND scene_id NOT IN (SELECT id FROM scenes WHERE episode_id = ?)', [episodeId, episodeId])
    const deadSpatial = query(
      `SELECT anchor_key FROM scene_anchors WHERE episode_id = ? AND anchor_type = 'spatial' AND scene_id NOT IN (SELECT id FROM scenes WHERE episode_id = ?)`,
      [episodeId, episodeId]
    )
    for (const row of deadSpatial) {
      execute(`UPDATE spatial_group_review SET status = 'pending', baseline_image_url = '', updated_at = CURRENT_TIMESTAMP WHERE episode_id = ? AND spatial_group = ?`, [episodeId, row.anchor_key])
      execute(`DELETE FROM scene_anchors WHERE episode_id = ? AND anchor_type = 'spatial' AND anchor_key = ?`, [episodeId, row.anchor_key])
    }
    execute(`DELETE FROM scene_anchors WHERE episode_id = ? AND anchor_type = 'scene' AND scene_id NOT IN (SELECT id FROM scenes WHERE episode_id = ?)`, [episodeId, episodeId])
  } catch (e) {
    console.warn(`[assetPipeline] 场景孤儿引用清理失败（不影响重建结果）: ${e.message}`)
  }
}

// ───────────────── 覆盖风险告警（一键全流程不拦截，留证即可） ─────────────────

export function recordPipelineDiff(trigger, episodeId, table, oldMap, incoming, label = '资产提取') {
  try {
    const oldRows = [...oldMap.values()]
    const incomingRows = buildIncomingForDiff(table, oldMap, incoming)
    const report = computeExtractDiff({ table, oldRows, incoming: incomingRows })
    if (report.hasRisk) {
      const MAX_DETAIL = 5
      const owDetail = (report.overwrites || []).map(
        (o) => `${o.name}(${(o.fields || []).map((f) => f.field).join(',')})`
      )
      const delDetail = (report.deletions || []).map((d) => `${d.name}(整条删除)`)
      const allDetail = [...owDetail, ...delDetail]
      const shown = allDetail.slice(0, MAX_DETAIL).join('；')
      const more = allDetail.length > MAX_DETAIL ? ` 等共 ${allDetail.length} 项` : ''
      const detailText = allDetail.length ? `明细：${shown}${more}。` : ''
      recordAlert({
        level: 'warn',
        source: 'extract-overwrite',
        episodeId,
        message: `${label}重建 ${table} 检测到覆盖风险（${trigger}，集 ${episodeId}）：`
          + `字段覆盖 ${report.counts.overwrites} 项、条目删除 ${report.counts.deletions} 项。`
          + `${detailText}已写入覆盖前快照，可在资产的「还原快照」里回退。`,
      })
    }
  } catch (e) {
    console.warn(`[extract-overwrite] ${trigger} 留证失败（已忽略）:`, e.message)
  }
}

// ───────────────── diff 用的 incoming 行构造（风险预检与告警共用） ─────────────────

function llmStr(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim() !== '') return v
  }
  return ''
}

// 角色：主设定优先（与 replaceEpisodeCharacters 的 guard 口径一致），无 master 时用提取值
function buildIncomingCharacters(projectId, characters) {
  return characters.map((c) => {
    const isStr = typeof c === 'string'
    const name = isStr ? String(c).trim() : String(c.name || '').trim()
    const master = findProjectCharacter(projectId, { id: c?.projectCharacterId || c?.project_character_id, name })
    const eff = master || (isStr ? { name } : c)
    return {
      name,
      role: eff.role || '配角',
      description: eff.description || '',
      appearance: eff.appearance || '',
      image_url: eff.image_url || eff.imageUrl || '',
      audio_url: eff.audio_url || eff.audioUrl || '',
      color: eff.color || '#6b9bd1',
      name_en: eff.name_en || eff.nameEn || '',
      description_en: eff.description_en || eff.descriptionEn || '',
    }
  })
}

function buildIncomingForDiff(table, oldMap, incoming) {
  return (incoming || []).map((item) => {
    const isStr = typeof item === 'string'
    const name = isStr ? item : (item.name || '')
    const old = oldMap.get(name)
    if (table === 'props') {
      return {
        name,
        description: isStr ? '' : (item.description || ''),
        owner: old?.owner || (isStr ? '' : (item.owner || '')) || '',
        image_url: old?.image_url || '',
        name_en: old?.name_en || (isStr ? '' : (item.nameEn ?? item.name_en ?? '')) || '',
      }
    }
    return {
      title: name,
      summary: isStr ? '' : (item.description || ''),
      image_url: old?.image_url || '',
      prop_names: JSON.stringify(isStr ? [] : (item.props || item.propNames || [])),
      title_en: old?.title_en || '',
      summary_en: old?.summary_en || '',
      lighting_en: old?.lighting_en || '',
      location: old?.location ?? (isStr ? '' : (item.location ?? item.location_en ?? '')) ?? '',
      space_type: (isStr ? '' : (item.spaceType || item.space_type)) || old?.space_type || '',
      space_evidence: (isStr ? '' : (item.spaceEvidence || item.space_evidence)) || old?.space_evidence || '',
      spatial_context: (isStr ? '' : (item.spatialContext || item.spatial_context)) || old?.spatial_context || '',
    }
  })
}

// ───────────────── 核心：统一落库 ─────────────────

// options:
//   guard          独立提取路径=true：先三表风险预检，有风险且未拍板则整体不写，返回 { risk, reports }
//   decision       '' | 'keep'（保留现有字段/补回被删项） | 'accept'（按提取结果覆盖）
//   mergeStrategy  角色与主设定合并策略：'preserve'（默认，只补空） | 'overwrite'（提取值覆盖主设定）
//   trigger        快照/告警前缀（独立提取 'extract-assets'，全流程 'pipeline'）
//   recordAlerts   不拦截但留证覆盖风险（全流程=true）
// 成功返回 { risk: false, saved: { characters, props, scenes }, staleAssets, scriptFp }
export async function persistAssets(episodeId, assets, options = {}) {
  const {
    guard = false,
    decision = '',
    mergeStrategy = 'preserve',
    trigger = 'extract-assets',
    recordAlerts = false,
  } = options

  const episode = queryOne('SELECT id, project_id, script_content FROM episodes WHERE id = ?', [episodeId])
  if (!episode) throw new Error(`集不存在：${episodeId}`)
  const projectId = episode.project_id

  const norm = normalizeExtractedAssets(assets)
  const { characters, props, scenes } = norm

  const wantsKeep = decision === 'keep'
  const wantsAccept = decision === 'accept'

  // 旧行快照（stale 判定、字段保留、diff 留证共用）
  const oldCharRows = query('SELECT * FROM characters WHERE episode_id = ? ORDER BY id', [episodeId])
  const oldPropRows = query('SELECT * FROM props WHERE episode_id = ? ORDER BY id', [episodeId])
  const oldSceneRows = query('SELECT * FROM scenes WHERE episode_id = ? ORDER BY scene_number', [episodeId])
  const oldCharByName = new Map(oldCharRows.map((r) => [r.name, r]))
  const oldPropByName = new Map(oldPropRows.map((r) => [r.name, r]))
  const oldSceneByTitle = new Map(oldSceneRows.map((r) => [r.title, r]))

  // ── 风险预检：guard 模式且未拍板时，三表任一有风险 → 整体不写库 ──
  if (guard && !wantsKeep && !wantsAccept) {
    const reports = {}
    if (characters.length) {
      const oldEffective = mergeMasterIntoEpisodeCharacters(oldCharRows)
      const report = computeExtractDiff({ table: 'characters', oldRows: oldEffective, incoming: buildIncomingCharacters(projectId, characters) })
      if (report.hasRisk) reports.characters = report
    }
    if (props.length) {
      const report = computeExtractDiff({ table: 'props', oldRows: oldPropRows, incoming: buildIncomingForDiff('props', oldPropByName, props) })
      if (report.hasRisk) reports.props = report
    }
    if (scenes.length) {
      const report = computeExtractDiff({ table: 'scenes', oldRows: oldSceneRows, incoming: buildIncomingForDiff('scenes', oldSceneByTitle, scenes) })
      if (report.hasRisk) reports.scenes = report
    }
    if (Object.keys(reports).length) return { risk: true, reports }
  }

  const effectiveCharacters = wantsKeep ? applyKeepForCharacters(characters, oldCharRows) : characters
  const effectiveProps = wantsKeep ? applyKeepForProps(props, oldPropRows) : props
  const effectiveScenes = wantsKeep ? applyKeepForScenes(scenes, oldSceneRows) : scenes

  const staleAssets = []

  // ── 角色：走 characterLibrary 的主设定联动写入（含其内部快照） ──
  if (effectiveCharacters.length) {
    if (recordAlerts) recordPipelineDiff(trigger, episodeId, 'characters', oldCharByName, effectiveCharacters, '一键全流程')
    replaceEpisodeCharacters(episodeId, projectId, effectiveCharacters, {
      source: 'extract', guard: false, mergeStrategy,
    })
    for (const r of query('SELECT name, description, image_url FROM characters WHERE episode_id = ? ORDER BY id', [episodeId])) {
      const old = oldCharByName.get(r.name)
      if (old?.image_url && (old.description || '') !== (r.description || '')) {
        staleAssets.push({ type: 'character', name: r.name })
      }
    }
  }

  // ── 道具：整表重建，旧行的图/英文/归属保留 ──
  if (effectiveProps.length) {
    if (recordAlerts) recordPipelineDiff(trigger, episodeId, 'props', oldPropByName, effectiveProps, '一键全流程')
    snapshotBeforeExtract({ episodeId, trigger: `${trigger}-props`, tables: ['props'] })
    transaction(() => {
      const oldByName = new Map(
        query('SELECT name, name_en, description_en, owner, image_url FROM props WHERE episode_id = ?', [episodeId])
          .map((r) => [r.name, r])
      )
      const stateSnapshot = snapshotAssetStatesForNames('prop', [
        ...oldByName.keys(),
        ...effectiveProps.map((p) => (typeof p === 'string' ? p : p.name)).filter(Boolean),
      ])
      execute('DELETE FROM props WHERE episode_id = ?', [episodeId])
      for (const p of effectiveProps) {
        const isStr = typeof p === 'string'
        const name = isStr ? p : (p.name || '')
        if (!name) continue
        const old = oldByName.get(name)
        const finalOwner = isStr ? (old?.owner || '') : (p.owner ?? old?.owner ?? '')
        const imgUrl = isStr ? (old?.image_url || '') : (p.imageUrl || p.image_url || old?.image_url || '')
        const finalNameEn = old?.name_en || (isStr ? '' : (p.nameEn ?? p.name_en ?? '')) || ''
        const finalDescriptionEn = old?.description_en ?? (isStr ? '' : (p.descriptionEn ?? p.description_en ?? '')) ?? ''
        execute(
          'INSERT INTO props (episode_id, name, description, owner, image_url, name_en, description_en) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [episodeId, name, isStr ? '' : (p.description || ''), finalOwner, imgUrl, finalNameEn, finalDescriptionEn]
        )
      }
      restoreAssetStates(stateSnapshot)
    })
    for (const r of query('SELECT name, description, image_url FROM props WHERE episode_id = ? ORDER BY id', [episodeId])) {
      const old = oldPropByName.get(r.name)
      if (old?.image_url && (old.description || '') !== (r.description || '')) {
        staleAssets.push({ type: 'prop', name: r.name })
      }
    }
  }

  // ── 场景：整表重建，旧行的图/英文/光效/空间类型保留，图未换则保留出图快照 ──
  if (effectiveScenes.length) {
    if (recordAlerts) recordPipelineDiff(trigger, episodeId, 'scenes', oldSceneByTitle, effectiveScenes, '一键全流程')
    snapshotBeforeExtract({ episodeId, trigger: `${trigger}-scenes`, tables: ['scenes'] })
    const oldSceneIdSnapshot = query('SELECT id, title, scene_number FROM scenes WHERE episode_id = ?', [episodeId])
    transaction(() => {
      const oldByTitle = new Map(
        query('SELECT * FROM scenes WHERE episode_id = ? ORDER BY scene_number', [episodeId]).map((r) => [r.title, r])
      )
      const stateSnapshot = snapshotAssetStatesForNames('scene', [
        ...oldByTitle.keys(),
        ...effectiveScenes.map((s, i) => (typeof s === 'string' ? s : (s.name || `场景${i + 1}`))),
      ])
      execute('DELETE FROM scenes WHERE episode_id = ?', [episodeId])
      let sceneNum = 0
      for (const s of effectiveScenes) {
        sceneNum++
        const isStr = typeof s === 'string'
        const name = isStr ? s : (s.name || `场景${sceneNum}`)
        const description = isStr ? '' : (s.description || '')
        const rawProps = isStr ? [] : (s.props || s.propNames || [])
        const propNames = rawProps.map(String).filter(Boolean)
        const old = oldByTitle.get(name)
        const imgUrl = isStr ? (old?.image_url || '') : (s.image_url || s.imageUrl || old?.image_url || '')
        const llmLighting = isStr ? '' : String(s.lightingEn || '').trim()
        const llmLightingEn = llmLighting && !CJK_DIRTY_RE.test(llmLighting) ? llmLighting : ''
        // lighting_en 已退出提取契约：重提取以 LLM 新值为准（通常为空），不再保留旧值——
        // 旧值若为提取期错例会被永久固化（详见 extractGuard 的字段保护说明）
        const finalLightingEn = llmLightingEn || ''
        const finalLocation = old?.location ?? (isStr ? '' : (s.location ?? s.location_en ?? '')) ?? ''
        const finalTitleEn = old?.title_en || (isStr ? '' : (s.titleEn || s.title_en)) || ''
        const finalSummaryEn = old?.summary_en || (isStr ? '' : (s.summaryEn || s.summary_en)) || ''
        const finalSpaceType = (isStr ? '' : (s.spaceType || s.space_type)) || old?.space_type || ''
        const finalSpaceEvidence = (isStr ? '' : (s.spaceEvidence || s.space_evidence)) || old?.space_evidence || ''
        // 同空间关联：LLM 按契约为 camelCase 三字段（spatialGroup/spatialRole/sharedLandmarks），
        // 在此组装成 {group, role, landmarks} JSON 落库；sceneAnchors 读该 JSON 做"采用+补全"。
        // 兼容直接传入 JSON 字符串（spatialContext/spatial_context）的情况；本次无产出时保留旧值。
        let finalSpatialContext = (isStr ? '' : (s.spatialContext || s.spatial_context)) || ''
        if (!finalSpatialContext && !isStr) {
          const g = String(s.spatialGroup || '').trim()
          const r = String(s.spatialRole || '').trim()
          const lm = Array.isArray(s.sharedLandmarks) ? s.sharedLandmarks.map((x) => String(x || '').trim()).filter(Boolean) : []
          if (g || r || lm.length) finalSpatialContext = JSON.stringify({ group: g, role: r, landmarks: lm })
        }
        if (!finalSpatialContext) finalSpatialContext = old?.spatial_context || ''
        // 出图快照属于旧图：图没换才保留 gen_context，换了（或新场景）清空
        const imgChanged = String(imgUrl || '').split('?')[0] !== String(old?.image_url || '').split('?')[0]
        const genContext = imgChanged ? '' : (old?.gen_context || '')
        const ins = execute(
          'INSERT INTO scenes (episode_id, scene_number, title, summary, image_url, prop_names, title_en, summary_en, lighting_en, location, space_type, space_evidence, spatial_context, gen_context) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [episodeId, sceneNum, name, description, imgUrl, JSON.stringify(propNames), finalTitleEn, finalSummaryEn, finalLightingEn, finalLocation, finalSpaceType, finalSpaceEvidence, finalSpatialContext, genContext]
        )
      }
      restoreAssetStates(stateSnapshot)
    })
    remapSceneReferencesAfterRebuild(episodeId, oldSceneIdSnapshot)
    cleanupOrphanedSceneRefs(episodeId)
    for (const r of query('SELECT title, summary, image_url FROM scenes WHERE episode_id = ? ORDER BY scene_number', [episodeId])) {
      const old = oldSceneByTitle.get(r.title)
      if (old?.image_url && (old.summary || '') !== (r.summary || '')) {
        staleAssets.push({ type: 'scene', name: r.title })
      }
    }
  }

  // ── 指纹回写：按同口径对齐 assets_script_fp，解除后续分镜的过期守卫 ──
  const freshFp = scriptHash(episode.script_content || '')
  execute('UPDATE episodes SET assets_script_fp = ? WHERE id = ?', [freshFp, episodeId])

  const saved = {
    characters: mergeMasterIntoEpisodeCharacters(
      query('SELECT * FROM characters WHERE episode_id = ? ORDER BY id', [episodeId])
    ),
    props: query('SELECT * FROM props WHERE episode_id = ? ORDER BY id', [episodeId]),
    scenes: query('SELECT * FROM scenes WHERE episode_id = ? ORDER BY scene_number', [episodeId]),
  }
  return { risk: false, saved, staleAssets, scriptFp: freshFp }
}
