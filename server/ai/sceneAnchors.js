
import crypto from 'crypto'
import { query, queryOne, execute } from '../db.js'
import { chatCompletion } from './doubao.js'
import { config } from '../config.js'
import { recordAlert } from './alerts.js'
import { ASSET_TYPES, TYPE_PROP } from './assetTypes.js'
import { SCENE_ANCHOR_TYPE, PROP_ANCHOR_TYPE, SPATIAL_ANCHOR_TYPE, LAYOUT_ANCHOR_TYPE, LAYOUT_ANCHOR_HINT, parseElementList } from './anchorTypes.js'
import { loadGroupLocks, applyGroupLocks, getGroupLockOverview } from './sceneGroupLock.js'
import {
  buildAnchorKey, stripStateSuffix, scanOrphanStates, resolveState, displayLabel,
} from './assetState.js'
import { resolvePropName, buildPropLexiconHint } from './propNameMatch.js'
import { bareUrl } from './shared.js'



const MAX_ELEMENT_COUNT = 5
const MAX_SHARED_ENV_COUNT = 6


const GROUP_ANCHOR_HINT =
  '本空间的「人审基准图」已作为参考图提供：本场景与基准图是同一物理空间，' +
  '空间结构、地标物体的形态与相对位置、光照方向必须与基准图连续；' +
  '但视角、机位高度、景别与画面主体占比一律以本场景文字描述为准，严禁照搬基准图的构图；' +
  '时段、天气、色温同样以本场景文字描述为准'


function loadPropStateRows(propName) {
  if (!config.assetState?.enabled) return []
  const name = String(propName || '').trim()
  if (!name) return []
  try {
    return query(
      `SELECT id, state_key, label_zh, description, description_en, image_url, is_default
       FROM asset_states WHERE asset_type = ? AND asset_key = ?`,
      [TYPE_PROP, name]
    )
  } catch (e) {
    console.warn(`[sceneAnchors] 读资产状态失败（降级为默认态）: ${e.message}`)
    return []
  }
}

function defaultPropStateKey(propName) {
  const rows = loadPropStateRows(propName)
  if (!rows.length) return ''
  const def = rows.find((r) => Number(r.is_default) === 1) || rows[0]
  return String(def?.state_key || '')
}

function stateHintFor(propName) {
  const rows = loadPropStateRows(propName)
  if (!rows.length) return ''
  const def = rows.find((r) => Number(r.is_default) === 1) || rows[0]
  const st = resolveState(def?.state_key, rows)
  if (!st.resolved) return ''
  const label = displayLabel(st.stateKey, st.labelZh)
  return `道具「${propName}」本场应处于「${label}」状态` +
    (st.descriptionEn ? `（${st.descriptionEn}）` : '') +
    `，其形态、颜色、材质与破损程度必须与该状态一致`
}

export function fingerprintOf(scenes) {
  const h = crypto.createHash('md5')
  for (const s of scenes) h.update(`${s.id}${s.scene_number}${s.title}${s.summary}#`)
  return h.digest('hex')
}

async function analyzeWithLlm(scenes, episodeId) {
  const sceneList = scenes
    .map((s) => `【场景${s.scene_number}】(scene_id=${s.id}) ${s.title}\n${s.summary || '（无描述）'}`)
    .join('\n\n')

  const propLexiconHint = buildPropLexiconHint(
    query('SELECT name FROM props WHERE episode_id = ?', [episodeId]).map((r) => r.name)
  )

  const messages = [
    {
      role: 'system',
      content: '你是影视美术统筹，负责跨镜头的视觉连续性资产管理。只输出 JSON，不要输出任何解释。',
    },
    {
      role: 'user',
      content:
        `以下是同一集的全部场景（编号/标题/环境描述）：\n\n${sceneList}\n\n` +
        `请完成视觉连续性分析：\n` +
        `1. spatial_group：把发生在同一物理空间的场景归为同组，组名用简短英文 snake_case（如 cliff_river、palace_hall）。\n` +
        `   判断标准：站在一处能互相看见、或同一地点的不同视角/不同高度/内外关系，都算同组；剧情上完全无关的地点各自成组。\n` +
        `   每个场景都必须有组名（独立空间也要给唯一组名），不允许为空。\n` +
        `2. spatial_role：每个场景在其组内的具体位置或视角，用中文短语（如"崖顶俯视谷底""谷底浅滩仰视"）。\n` +
        `3. shared_props：全集中**在 2 个及以上场景重复出现、外观必须保持一致**的具体有形物体（如桥、船、门、马车、古树）。\n` +
        `   只列有形物体，不列天气/光照/水面等泛化环境；名字用简短中文（2~6 字）。\n` +
        propLexiconHint +
        `4. 每个场景的 props：该场景描述中实际出现的、属于 shared_props 的物体，名称必须与 shared_props 完全一致。\n` +
        `5. 每个场景的 elements：**该场景描述里明文写了、且必须在画面上看得见**的要素，用 2~6 字中文短语，\n` +
        `   按重要性排序，最多 5 条（如"清晨浓雾""冰面浮冰""两截朽桥""石阶栈道"）。\n` +
        `   只列**描述里真实写了的**，严禁推断或补充；描述没提的一律不得列入。\n` +
        `   判断标准：一条要素若在画面中缺失，这场景就画错了 —— 只有这样的才列。\n` +
        `   ⚠️ **天气与大气现象只要写了就必须列**（雾/云/雨/雪/风/水汽/天光/日晒/光线）：\n` +
        `   这类词最容易被当成"只是氛围"而被省略，而它们恰恰是最常丢的——描述写了雾，就必须画得出雾。\n` +
        `   ⚠️ 描述里写了**具体数量或形态**的，要连形态一起写进短语（"断了一半斜挂"→"半截斜挂的断桥"，\n` +
        `   "水流挤在乱石堆里翻着白花"→"乱石堆翻白花"）——只写"桥"等于把形态信息丢了。\n` +
        `6. 每组（spatial_group）的 shared_env：**同组所有场景共享**的环境特征，用 2~8 字中文短语，最多 6 条。\n` +
        `   从组内各场描述的交集与空间常识中提取属于该地点本身的稳定特征：植被、地质、水体、色调倾向、标志性地形。\n` +
        `   只写"这个地方长什么样"，不写只在某一场出现的天气/时段，不写可移动道具（那些归 shared_props）。\n` +
        `   ⚠️ 判断"是否共享"看的是**这个地点本身有没有**，不是"每场都写了没有"：\n` +
        `   某场若明确写了"这里没有雾"（如"谷底无雾"），说明雾是该地点的**局部现象**，不得进组卡；\n` +
        `   而植被/地质这类实存特征，哪怕某一场的描述只字未提，也照样进组卡——\n` +
        `   某场没提不代表那个地方没有，那一片山崖不会因为某一镜没写就没有松林。\n` +
        `   举例：某组是冰河峡谷，则"灰白砾石滩""半山松林""冷蓝色调"都应列出——它们属于该地点，不随场次改变。\n\n` +
        `输出 JSON（严格遵守此结构）：\n` +
        `{"scenes":[{"scene_id":数字,"spatial_group":"...","spatial_role":"...","props":["..."],"elements":["..."]}],` +
        ` "shared_props":["..."],"shared_env":{"组名":["..."]}}`,
    },
  ]

  const text = await chatCompletion(messages, {
    responseFormat: { type: 'json_object' },
    temperature: 0.2,
    maxTokens: 4000,
    usageContext: { task: 'scene_anchor_analysis', episodeId },
  })

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    const m = text.match(/\{[\s\S]*\}/)
    if (!m) throw new Error('LLM 场景分析返回非 JSON')
    parsed = JSON.parse(m[0])
  }
  return validateAnalysis(parsed, scenes)
}

function validateAnalysis(parsed, scenes) {
  const validIds = new Set(scenes.map((s) => s.id))
  const rows = []

  const propSet = new Set()
  if (Array.isArray(parsed?.shared_props)) {
    for (const p of parsed.shared_props) {
      const name = String(p || '').trim()
      if (name) propSet.add(name)
    }
  }
  if (Array.isArray(parsed?.scenes)) {
    for (const r of parsed.scenes) {
      if (!Array.isArray(r?.props)) continue
      for (const p of r.props) {
        const name = String(p || '').trim()
        if (name) propSet.add(name)
      }
    }
  }

  for (const r of Array.isArray(parsed?.scenes) ? parsed.scenes : []) {
    const sceneId = Number(r?.scene_id)
    if (!validIds.has(sceneId)) continue
    rows.push({
      scene_id: sceneId,
      spatial_group: String(r?.spatial_group || '').trim(),
      spatial_role: String(r?.spatial_role || '').trim(),
      props: (Array.isArray(r?.props) ? r.props : [])
        .map((p) => String(p || '').trim())
        .filter((p) => p && propSet.has(p)),
      elements: parseElementList(JSON.stringify(Array.isArray(r?.elements) ? r.elements : [])).slice(0, MAX_ELEMENT_COUNT),
    })
  }
  for (const s of scenes) {
    if (!rows.some((r) => r.scene_id === s.id)) {
      rows.push({ scene_id: s.id, spatial_group: '', spatial_role: '', props: [], elements: [] })
    }
  }

  const liveGroups = new Set(rows.map((r) => r.spatial_group).filter(Boolean))
  const sharedEnv = {}
  const rawEnv = parsed?.shared_env && typeof parsed.shared_env === 'object' ? parsed.shared_env : {}
  for (const [g, list] of Object.entries(rawEnv)) {
    const name = String(g || '').trim()
    if (!name || !liveGroups.has(name)) continue
    const cleaned = parseElementList(JSON.stringify(Array.isArray(list) ? list : [])).slice(0, MAX_SHARED_ENV_COUNT)
    if (cleaned.length) sharedEnv[name] = cleaned
  }

  return { rows, sharedProps: [...propSet], sharedEnv }
}

const analysisInFlight = new Map()

export function ensureSceneAnalysis(episodeId, { force = false } = {}) {
  const key = `${episodeId}:${force ? 'force' : 'auto'}`
  const running = analysisInFlight.get(key)
  if (running) return running
  const task = runEnsureSceneAnalysis(episodeId, { force })
    .finally(() => { analysisInFlight.delete(key) })
  analysisInFlight.set(key, task)
  return task
}

async function runEnsureSceneAnalysis(episodeId, { force = false } = {}) {
  const scenes = query(
    'SELECT id, scene_number, title, summary, image_url FROM scenes WHERE episode_id = ? ORDER BY scene_number',
    [episodeId]
  )
  if (!scenes.length) return { ok: false, reason: 'no_scenes', sceneCount: 0 }

  const fp = fingerprintOf(scenes)
  const cur = queryOne('SELECT fingerprint FROM scene_analysis WHERE episode_id = ? LIMIT 1', [episodeId])
  if (!force && cur?.fingerprint === fp) return { ok: true, cached: true, sceneCount: scenes.length }

  const { rows: llmRows, sharedProps, sharedEnv } = await analyzeWithLlm(scenes, episodeId)

  const locks = loadGroupLocks(episodeId, { query, queryOne })
  const { rows, lockedCount, changedCount } = applyGroupLocks(llmRows, locks)
  if (lockedCount) {
    console.log(`[sceneAnchors] 分组锁定生效：${lockedCount} 场已锁（其中 ${changedCount} 场纠正了 LLM 的重组）`)
  }

  execute('DELETE FROM scene_analysis WHERE episode_id = ?', [episodeId])
  for (const r of rows) {
    const sn = scenes.find((s) => s.id === r.scene_id)?.scene_number || 0
    const env = (r.spatial_group && sharedEnv[r.spatial_group]) || []
    execute(
      `INSERT INTO scene_analysis (episode_id, scene_id, scene_number, spatial_group, spatial_role, props_json, elements_json, shared_env_json, fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [episodeId, r.scene_id, sn, r.spatial_group, r.spatial_role, JSON.stringify(r.props),
        JSON.stringify(r.elements || []), JSON.stringify(env), fp]
    )
  }

  execute(`DELETE FROM scene_anchors WHERE episode_id = ? AND source = 'auto'`, [episodeId])
  for (const s of scenes) {
    const img = bareUrl(s.image_url)
    if (img) registerSceneAnchors(episodeId, s.id, img)
  }

  try {
    if (config.assetState?.enabled) {
      const stateRows = query(
        `SELECT id, asset_key, state_key FROM asset_states WHERE asset_type = ?`,
        [TYPE_PROP]
      )
      const liveAnchorKeys = query(
        `SELECT anchor_key FROM scene_anchors WHERE episode_id = ? AND anchor_type = '${PROP_ANCHOR_TYPE}'`,
        [episodeId]
      ).map((a) => a.anchor_key)
      const orphanReport = scanOrphanStates(stateRows, liveAnchorKeys)
      if (orphanReport.orphans.length) {
        recordAlert({
          level: 'warn',
          source: 'assetState',
          episodeId,
          message: `资产状态漂移：${orphanReport.orphans.length} 条状态行找不到对应锚点（重提资产后 id 变更所致），需人工重建`,
          detail: JSON.stringify(orphanReport.orphans).slice(0, 2000),
        })
      }
    }
  } catch (e) {
    console.warn('[sceneAnchors] 状态孤儿扫描失败（已忽略，不阻断）:', e.message)
  }

  return { ok: true, cached: false, sceneCount: scenes.length, sharedProps }
}

export async function resolveSceneSpatialGroup(episodeId, sceneId) {
  const empty = { group: '', role: '', sceneNumber: 0 }
  try {
    await ensureSceneAnalysis(episodeId)
  } catch (e) {
    console.warn(`[sceneAnchors] 空间组解析失败（降级为不串行）: ${e.message}`)
    return empty
  }
  const row = queryOne(
    'SELECT spatial_group, spatial_role, scene_number FROM scene_analysis WHERE episode_id = ? AND scene_id = ?',
    [episodeId, sceneId]
  )
  if (!row) return empty
  return {
    group: String(row.spatial_group || '').trim(),
    role: String(row.spatial_role || '').trim(),
    sceneNumber: Number(row.scene_number || 0),
  }
}

export async function listSceneSpatialGroups(episodeId) {
  try {
    await ensureSceneAnalysis(episodeId)
  } catch (e) {
    console.warn(`[sceneAnchors] 空间分组列表查询失败（降级为空）: ${e.message}`)
    return []
  }
  const rows = query(
    `SELECT sa.scene_id, sa.scene_number, sa.spatial_group, sa.spatial_role, COALESCE(s.image_url, '') AS image_url
     FROM scene_analysis sa
     LEFT JOIN scenes s ON s.id = sa.scene_id
     WHERE sa.episode_id = ?
     ORDER BY sa.scene_number ASC`,
    [episodeId]
  )
  return rows.map((r) => ({
    sceneId: Number(r.scene_id),
    sceneNumber: Number(r.scene_number || 0),
    spatialGroup: String(r.spatial_group || '').trim(),
    spatialRole: String(r.spatial_role || '').trim(),
    hasImage: String(r.image_url || '').trim() !== '',
  }))
}

export async function buildAnchorRefsForScene(episodeId, sceneId) {
  const empty = { refs: [], promptHints: [], anchors: [], elements: [], sharedEnv: [], spatialRole: '' }
  try {
    await ensureSceneAnalysis(episodeId)
  } catch (e) {
    console.warn(`[sceneAnchors] 场景分析失败（降级为无锚点）: ${e.message}`)
    return empty
  }

  const row = queryOne('SELECT * FROM scene_analysis WHERE episode_id = ? AND scene_id = ?', [episodeId, sceneId])
  if (!row) return empty

  const elements = parseElementList(row.elements_json)
  const sharedEnv = parseElementList(row.shared_env_json)

  const refs = []
  const promptHints = []
  const anchors = []

  if (row.spatial_group) {
    const la = queryOne(
      `SELECT anchor_key, image_url FROM scene_anchors
       WHERE episode_id = ? AND anchor_type = '${LAYOUT_ANCHOR_TYPE}' AND anchor_key = ?`,
      [episodeId, row.spatial_group]
    )
    const laImg = bareUrl(la?.image_url)
    if (laImg) {
      refs.push(laImg)
      promptHints.push(LAYOUT_ANCHOR_HINT)
      anchors.push({ type: LAYOUT_ANCHOR_TYPE, key: la.anchor_key, image: laImg, role: '空间布局示意图' })
    }
  }

  if (row.spatial_group) {
    const ga = queryOne(
      `SELECT anchor_key, scene_id, scene_number, image_url FROM scene_anchors
       WHERE episode_id = ? AND anchor_type = '${SPATIAL_ANCHOR_TYPE}' AND anchor_key = ?
         AND source = 'manual' AND confirmed = 1`,
      [episodeId, row.spatial_group]
    )
    const gaImg = bareUrl(ga?.image_url)
    if (gaImg) {
      refs.push(gaImg)                       
      promptHints.push(GROUP_ANCHOR_HINT)
      anchors.push({ type: SPATIAL_ANCHOR_TYPE, key: ga.anchor_key, image: gaImg, role: '人审基准图' })
    }
  }

  if (row.spatial_group) {
    const cur = queryOne('SELECT scene_number FROM scenes WHERE id = ?', [sceneId])
    const mates = query(
      `SELECT s.id, s.title, s.image_url, s.scene_number, sa.spatial_role
       FROM scene_analysis sa
       JOIN scenes s ON s.id = sa.scene_id
       WHERE sa.episode_id = ? AND sa.spatial_group = ? AND sa.scene_id != ? AND TRIM(s.image_url) != ''
       ORDER BY ABS(s.scene_number - ?) ASC`,
      [episodeId, row.spatial_group, sceneId, cur?.scene_number || 0]
    ).slice(0, config.asset.maxSpatialRefs)

    for (const m of mates) {
      const img = bareUrl(m.image_url)
      if (!img || refs.includes(img)) continue
      refs.push(img)
      promptHints.push(
        `参考图是本空间的「${m.spatial_role || m.title}」视角：本场景与它是同一物理空间，` +
        `空间结构、地标物体的形态与相对位置、光照方向必须与参考图连续；` +
        `但视角、机位高度、景别与画面主体占比一律以本场景文字描述为准，严禁照搬参考图的构图；` +
        `时段、天气、色温同样以本场景文字描述为准`
      )
      anchors.push({ type: SCENE_ANCHOR_TYPE, key: m.title, image: img, role: m.spatial_role })
    }
  }

  let props = []
  try { props = JSON.parse(row.props_json || '[]') } catch { props = [] }
  let propCount = 0
  for (const name of props) {
    if (propCount >= config.asset.maxPropRefs) break
    const stateKey = defaultPropStateKey(name)
    const keyWithState = buildAnchorKey(name, stateKey)
    let a = keyWithState === name
      ? null
      : queryOne(
        `SELECT * FROM scene_anchors WHERE episode_id = ? AND anchor_type = '${PROP_ANCHOR_TYPE}' AND anchor_key = ?`,
        [episodeId, keyWithState]
      )
    if (!a) {
      a = queryOne(
        `SELECT * FROM scene_anchors WHERE episode_id = ? AND anchor_type = '${PROP_ANCHOR_TYPE}' AND anchor_key = ?`,
        [episodeId, name]
      )
    }
    if (!a) continue
    const img = bareUrl(a.image_url)
    if (!img) continue
    if (!refs.includes(img)) refs.push(img)
    const stateHint = stateKey ? stateHintFor(name) : ''
    promptHints.push(
      stateHint
      || `道具「${name}」必须与参考图中的同一物体保持形态、颜色、材质与破损状态一致`
    )
    anchors.push({ type: PROP_ANCHOR_TYPE, key: stripStateSuffix(a.anchor_key || name), image: img })
    propCount++
  }

  return {
    refs, promptHints, anchors,
    elements, sharedEnv,
    spatialRole: String(row.spatial_role || '').trim(),
  }
}

export function registerSceneAnchors(episodeId, sceneId, imageUrl) {
  const img = bareUrl(imageUrl)
  if (!img) return { registered: false }

  const scene = queryOne('SELECT title, scene_number FROM scenes WHERE id = ?', [sceneId])
  if (!scene) return { registered: false }

  execute(
    `INSERT INTO scene_anchors (episode_id, anchor_type, anchor_key, scene_id, scene_number, image_url, description, source)
     VALUES (?, '${SCENE_ANCHOR_TYPE}', ?, ?, ?, ?, ?, 'auto')
     ON CONFLICT(episode_id, anchor_type, anchor_key)
     DO UPDATE SET image_url = excluded.image_url, scene_id = excluded.scene_id, scene_number = excluded.scene_number`,
    [episodeId, scene.title, sceneId, scene.scene_number || 0, img, `场景「${scene.title}」定稿图`]
  )

  const row = queryOne('SELECT props_json FROM scene_analysis WHERE episode_id = ? AND scene_id = ?', [episodeId, sceneId])
  let props = []
  try { props = row ? JSON.parse(row.props_json || '[]') : [] } catch { props = [] }

  const propTableNames = query('SELECT name FROM props WHERE episode_id = ?', [episodeId]).map((r) => r.name)

  for (const rawName of props) {
    const matchedPropName = resolvePropName(rawName, propTableNames)
    if (!matchedPropName) {
      try {
        recordAlert({
          level: 'warn',
          source: 'propName',
          episodeId,
          message: `场景分析道具名「${rawName}」在道具表中无对应项（多趟 LLM 命名不一致），其锚点按原名登记，下游出片可能匹配不到该道具参考图，建议在设定页核对道具名`,
          detail: JSON.stringify({ raw: rawName, candidates: propTableNames }).slice(0, 2000),
        })
      } catch {  }
    }
    const name = matchedPropName || rawName
    const anchorKey = buildAnchorKey(name, defaultPropStateKey(name))
    execute(
      `INSERT INTO scene_anchors (episode_id, anchor_type, anchor_key, scene_id, scene_number, image_url, description, source)
       VALUES (?, '${PROP_ANCHOR_TYPE}', ?, ?, ?, ?, ?, 'auto')
       ON CONFLICT(episode_id, anchor_type, anchor_key) DO UPDATE SET
         image_url = excluded.image_url,
         scene_id = excluded.scene_id,
         scene_number = excluded.scene_number
       WHERE scene_anchors.scene_id = excluded.scene_id`,
      [episodeId, anchorKey, sceneId, scene.scene_number || 0, img, `出自场景「${scene.title}」（首次定稿）`]
    )
  }
  return { registered: true, props }
}


export function lockCurrentGrouping(episodeId, opts = {}) {
  const rows = query(
    "SELECT scene_id, spatial_group FROM scene_analysis WHERE episode_id = ? AND TRIM(spatial_group) != ''",
    [episodeId]
  )
  if (!rows.length) return { locked: 0, reason: '无可锁的分组（分析未跑或组名为空）' }
  const note = String(opts.note || '人审确认').slice(0, 200)
  let locked = 0
  for (const r of rows) {
    const sid = Number(r.scene_id)
    const g = String(r.spatial_group || '').trim()
    if (!Number.isFinite(sid) || sid <= 0 || !g) continue
    execute(
      `INSERT INTO scene_group_locks (episode_id, scene_id, spatial_group, note)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(episode_id, scene_id) DO UPDATE SET spatial_group = excluded.spatial_group, note = excluded.note`,
      [episodeId, sid, g, note]
    )
    locked++
  }
  console.log(`[sceneAnchors] 已锁定 ${locked} 场的分组（episode=${episodeId}）`)
  return { locked }
}

export function unlockGrouping(episodeId, opts = {}) {
  const ids = Array.isArray(opts.sceneIds)
    ? opts.sceneIds.map(Number).filter((n) => Number.isFinite(n) && n > 0)
    : []
  if (!ids.length) {
    const before = queryOne('SELECT COUNT(*) AS c FROM scene_group_locks WHERE episode_id = ?', [episodeId])
    execute('DELETE FROM scene_group_locks WHERE episode_id = ?', [episodeId])
    return { removed: Number(before?.c || 0) }
  }
  execute(
    `DELETE FROM scene_group_locks WHERE episode_id = ? AND scene_id IN (${ids.map(() => '?').join(',')})`,
    [episodeId, ...ids]
  )
  return { removed: ids.length }
}

export function describeGroupLocks(episodeId) {
  return getGroupLockOverview(episodeId, { query, queryOne })
}

export async function initAnchorSetFromExisting(episodeId) {
  const r = await ensureSceneAnalysis(episodeId, { force: true })
  if (!r.ok) return r
  const anchors = query(
    'SELECT anchor_type, anchor_key, scene_id, scene_number, image_url FROM scene_anchors WHERE episode_id = ? ORDER BY anchor_type, scene_number',
    [episodeId]
  )
  const analysis = query(
    'SELECT scene_id, scene_number, spatial_group, spatial_role, props_json, elements_json, shared_env_json FROM scene_analysis WHERE episode_id = ? ORDER BY scene_number',
    [episodeId]
  )
  return { ...r, anchorCount: anchors.length, anchors, analysis }
}


export function collectGroupLayoutMaterials(episodeId, group) {
  const g = String(group || '').trim()
  if (!g) return null
  const members = query(
    `SELECT s.scene_number, s.title, sa.spatial_role, sa.props_json, sa.elements_json, sa.shared_env_json
     FROM scene_analysis sa
     JOIN scenes s ON s.id = sa.scene_id
     WHERE sa.episode_id = ? AND sa.spatial_group = ?
     ORDER BY s.scene_number ASC`,
    [episodeId, g]
  )
  if (!members.length) return null

  const roles = []
  const landmarks = []
  const env = []
  const seen = { roles: new Set(), landmarks: new Set(), env: new Set() }
  const parseArr = (raw) => {
    try {
      const v = JSON.parse(raw || '[]')
      return Array.isArray(v) ? v : []
    } catch { return [] }
  }

  for (const m of members) {
    const role = String(m.spatial_role || '').trim()
    if (role && !seen.roles.has(role)) { seen.roles.add(role); roles.push(role) }
    for (const list of [parseArr(m.props_json), parseArr(m.elements_json)]) {
      for (const x of list) {
        const s = String(x || '').trim()
        if (s && !seen.landmarks.has(s)) { seen.landmarks.add(s); landmarks.push(s) }
      }
    }
  }
  for (const x of parseArr(members[0].shared_env_json)) {
    const s = String(x || '').trim()
    if (s && !seen.env.has(s)) { seen.env.add(s); env.push(s) }
  }

  return { group: g, roles, landmarks, env, memberCount: members.length }
}

export function layoutMaterialsFingerprint(materials) {
  if (!materials) return ''
  const norm = (arr) => [...new Set((arr || []).map((x) => String(x || '').trim()).filter(Boolean))].sort()
  const payload = [
    norm(materials.roles).join('\u0001'),
    norm(materials.landmarks).join('\u0001'),
    norm(materials.env).join('\u0001'),
  ].join('\u0002')
  if (!payload.replace(/[\u0001\u0002]/g, '')) return ''
  return crypto.createHash('md5').update(payload).digest('hex')
}

export function registerLayoutAnchor(episodeId, group, imageUrl, opts = {}) {
  const g = String(group || '').trim()
  const img = bareUrl(imageUrl)
  if (!g || !img) return { registered: false }
  const fp = String(opts.sourceFingerprint || '')
  execute(
    `INSERT INTO scene_anchors (episode_id, anchor_type, anchor_key, scene_id, scene_number, image_url, description, source, source_fingerprint)
     VALUES (?, '${LAYOUT_ANCHOR_TYPE}', ?, ?, ?, ?, ?, 'manual', ?)
     ON CONFLICT(episode_id, anchor_type, anchor_key) DO UPDATE SET
       image_url = excluded.image_url,
       description = excluded.description,
       scene_id = excluded.scene_id,
       scene_number = excluded.scene_number,
       source = 'manual',
       source_fingerprint = excluded.source_fingerprint,
       confirmed = 1`,
    [
      episodeId, g, Number(opts.repSceneId) || 0, Number(opts.repSceneNumber) || 0, img,
      String(opts.description || `空间组「${g}」布局示意图`), fp,
    ]
  )
  return { registered: true, group: g, image: img, sourceFingerprint: fp }
}

export function getLayoutAnchor(episodeId, group) {
  const g = String(group || '').trim()
  if (!g) return null
  const row = queryOne(
    `SELECT anchor_key, image_url, description, source_fingerprint FROM scene_anchors
     WHERE episode_id = ? AND anchor_type = '${LAYOUT_ANCHOR_TYPE}' AND anchor_key = ?`,
    [episodeId, g]
  )
  if (!row) return null
  const img = bareUrl(row.image_url)
  return img
    ? {
        group: row.anchor_key,
        imageUrl: img,
        description: row.description || '',
        sourceFingerprint: String(row.source_fingerprint || ''),
      }
    : null
}
