
import crypto from 'crypto'
import { query, queryOne, execute, transaction } from '../db.js'
import { chatCompletion } from './doubao.js'
import { SPATIAL_ANCHOR_TYPE, LAYOUT_ANCHOR_TYPE, LAYOUT_ANCHOR_HINT, parseElementList } from './anchorTypes.js'
import { loadGroupLocks, applyGroupLocks, getGroupLockOverview } from './sceneGroupLock.js'
import { bareUrl, parseJsonLoose } from './shared.js'



const MAX_ELEMENT_COUNT = 5
const MAX_SHARED_ENV_COUNT = 6


const GROUP_ANCHOR_HINT =
  '本空间的「人审基准图」已作为参考图提供：本场景与基准图是同一物理空间，' +
  '各物体的形态、朝向与彼此的相对位置关系必须与基准图连续；' +
  '但透视关系、前后景层次、画面占比、取景范围、视角、机位高度、景别与画面主体占比一律以本场景文字描述为准，严禁照搬基准图的构图；' +
  '光照一致性以随本图注入的组级光照常量（共有环境注记中的光照条目）为准，不由基准图承担；' +
  '光源方向、色温、受光面与背光面关系一律以该组级光照常量为准；' +
  '时段与天气细节仅在不与组级光照常量冲突的范围内以本场景文字描述为准'


export function fingerprintOf(scenes) {
  const h = crypto.createHash('md5')
  // spatial_context 纳入指纹：已确认空间关联属于"场景集内容"，变了就该触发重析（与注释承诺一致）
  for (const s of scenes) h.update(`${s.id}${s.scene_number}${s.title}${s.summary}${s.spatial_context || ''}#`)
  return h.digest('hex')
}

// 场景页是按「空间组」渲染的：没归组的场景会掉进平铺小卡区，形态和组卡对不上。
// 手动新增或历史遗留的场景可能没有归组（scene_analysis 无行，或 spatial_group 为空）。
// 这里把这类场景兜底补成「一场一组」——组名取场景标题，同名场景自然并成同一组。
// 只补分组、不动指纹（要不要对齐指纹由调用方决定，见 episodes 保存逻辑）。
export function normalizeSceneGrouping(episodeId) {
  const scenes = query(
    'SELECT id, scene_number, title, summary, image_url FROM scenes WHERE episode_id = ? ORDER BY scene_number',
    [episodeId]
  )
  if (!scenes.length) return { grouped: 0 }

  const analyzed = query(
    'SELECT id, scene_id, spatial_group FROM scene_analysis WHERE episode_id = ?',
    [episodeId]
  )
  const bySceneId = new Map(analyzed.map((r) => [r.scene_id, r]))
  // 新增行沿用本剧集已有指纹，避免插出指纹不一致的行导致下次误判「场景变了」
  const analyzedFp = analyzed.length
    ? String(queryOne('SELECT fingerprint FROM scene_analysis WHERE episode_id = ? LIMIT 1', [episodeId])?.fingerprint || '')
    : ''

  let grouped = 0
  for (const s of scenes) {
    const row = bySceneId.get(s.id)
    if (String(row?.spatial_group || '').trim()) continue
    const groupName = String(s.title || '').trim() || `场景${s.scene_number}`
    if (row) {
      execute('UPDATE scene_analysis SET spatial_group = ?, scene_number = ? WHERE id = ?', [
        groupName, s.scene_number, row.id,
      ])
    } else {
      execute(
        `INSERT INTO scene_analysis (episode_id, scene_id, scene_number, spatial_group, spatial_role, props_json, elements_json, shared_env_json, fingerprint)
         VALUES (?, ?, ?, ?, '', '[]', '[]', '[]', ?)`,
        [episodeId, s.id, s.scene_number, groupName, analyzedFp]
      )
    }
    grouped++
  }
  return { grouped }
}

// 解析提取阶段产出的空间关联 JSON（scenes.spatial_context）：{group, role, landmarks}
// 空串/坏 JSON/全空字段一律返回 null，调用方按"无已确认关联"处理
function parseSpatialContext(raw) {
  try {
    const obj = JSON.parse(String(raw || 'null'))
    if (!obj || typeof obj !== 'object') return null
    const ctx = {
      group: String(obj.group || '').trim(),
      role: String(obj.role || '').trim(),
      landmarks: Array.isArray(obj.landmarks) ? obj.landmarks.map((x) => String(x || '').trim()).filter(Boolean) : [],
    }
    return ctx.group || ctx.role || ctx.landmarks.length ? ctx : null
  } catch {
    return null
  }
}

async function analyzeWithLlm(scenes, episodeId) {
  // 提取阶段已确认的空间关联（skill【同空间关联】节产出，scenes.spatial_context JSON）。
  // 分析器从"全量推断"降级为"采用+补全"：已确认字段直接采用，LLM 只推断缺失项与组级共享信息。
  const extractCtx = new Map()
  for (const s of scenes) {
    extractCtx.set(s.id, parseSpatialContext(s.spatial_context))
  }
  const fmtCtx = (s) => {
    const c = extractCtx.get(s.id)
    if (!c || (!c.group && !c.role && !c.landmarks.length)) return ''
    const parts = []
    if (c.group) parts.push(`空间组=${c.group}`)
    if (c.role) parts.push(`组内视角=${c.role}`)
    if (c.landmarks.length) parts.push(`共享地标=${c.landmarks.join('、')}`)
    return `\n【提取时确认的空间关联】${parts.join('；')}`
  }
  const sceneList = scenes
    .map((s) => `【场景${s.scene_number}】(scene_id=${s.id}) ${s.title}\n${s.summary || '（无描述）'}${fmtCtx(s)}`)
    .join('\n\n')

  const messages = [
    {
      role: 'system',
      content: '你是影视美术统筹，负责跨镜头的视觉连续性资产管理。只输出 JSON，不要输出任何解释。',
    },
    {
      role: 'user',
      content:
        `以下是同一集的全部场景（编号/标题/环境描述；部分场景末尾附【提取时确认的空间关联】）：\n\n${sceneList}\n\n` +
        `【优先级规则】场景末尾附有【提取时确认的空间关联】的，其中空间组/组内视角/共享地标是资产提取阶段已确认的关联事实，` +
        `你的输出必须与之逐字一致，不得改动或重新命名；你只负责：①没有该信息的场景（推断其组与视角）；` +
        `②组级的 shared_landmarks 汇总与 shared_env 提取；③检查同组各场视角是否重复，若重复则微调未确认场景的视角措辞。\n` +
        `请完成视觉连续性分析：\n` +
        `1. spatial_group：把发生在同一物理空间的场景归为同组，组名用简短英文 snake_case（如 valley_river、palace_hall）。\n` +
        `   判断标准：站在一处能互相看见、或同一地点的不同视角/不同高度/内外关系，都算同组；剧情上完全无关的地点各自成组。\n` +
        `   每个场景都必须有组名（独立空间也要给唯一组名），不允许为空。\n` +
        `2. spatial_role：每个场景在其组内的具体位置或视角，用中文短语（如"崖顶俯视谷底""谷底浅滩仰视"）。\n` +
        `3. shared_landmarks（场景固定大型物体）：全集中**在 2 个及以上场景重复出现、外观必须保持一致**、且**角色不与之互动的**固定物体——\n` +
        `   即构成空间本身的、角色只"存在其中"而不施加动作的组成部分：建筑结构、地形、大型植物、固定设施（如岩壁、石阶、门洞、古树、井台）。\n` +
        `   【判定标准】同时满足三条才列：① 不可移动；② 大型（不是能拿在手里的小物件）；③ **角色不与之发生动作**（仅位于/站在/倚靠不算动作）。\n` +
        `   不列天气/光照/水面等泛化环境；名字用简短中文（2~6 字）。\n` +
        `   【范围边界】本任务只提取「角色不与之互动的固定大型物体」；**角色会拿起、使用、操作、踩踏、乘坐、破坏的物件**（无论大小，含桥、船、大型载具）不属于本任务范围（由道具资产单独管理），一律不列。\n` +
        `   ⚠️ 判据是「角色碰没碰」，不是「它大不大」：一座被角色踩上去、踩塌的桥是道具，不是本任务的对象。\n` +
        `4. 每个场景的 landmarks：该场景描述中实际出现的、属于 shared_landmarks 的固定大型物体，名称必须与 shared_landmarks 完全一致。\n` +
        `5. 每个场景的 elements：**该场景描述里明文写了、且必须在画面上看得见**的要素，用 2~6 字中文短语，\n` +
        `   按重要性排序，最多 5 条（如"清晨浓雾""老旧木桥""石阶栈道"）。\n` +
        `   只列**描述里真实写了的**，严禁推断或补充；描述没提的一律不得列入。\n` +
        `   判断标准：一条要素若在画面中缺失，这场景就画错了 —— 只有这样的才列。\n` +
        `   ⚠️ **天气与大气现象只要写了就必须列**（雾/云/雨/雪/风/水汽/天光/日晒/光线）：\n` +
        `   这类词最容易被当成"只是氛围"而被省略，而它们恰恰是最常丢的——描述写了雾，就必须画得出雾。\n` +
        `   ⚠️ 描述里写了**具体数量或形态**的，要连形态一起写进短语（"断了一半斜挂"→"半截斜挂的古桥"，\n` +
        `   "水流挤在乱石堆里翻着白花"→"乱石堆翻白花"）——只写"桥"等于把形态信息丢了。\n` +
        `6. 每组（spatial_group）的 shared_env：**同组所有场景共享**的环境特征，用 2~8 字中文短语，最多 6 条。\n` +
        `   从组内各场描述的交集与空间常识中提取属于该地点本身的稳定特征：植被、地质、水体、色调倾向、标志性地形。\n` +
        `   只写"这个地方长什么样"，不写只在某一场出现的天气/时段，不写可移动器物（可移动器物不属于本任务范围）。\n` +
        `   ⚠️ 判断"是否共享"看的是**这个地点本身有没有**，不是"每场都写了没有"：\n` +
        `   某场若明确写了"这里没有雾"（如"谷底无雾"），说明雾是该地点的**局部现象**，不得进组卡；\n` +
        `   而植被/地质这类实存特征，哪怕某一场的描述只字未提，也照样进组卡——\n` +
        `   某场没提不代表那个地方没有，那一片山墙不会因为某一镜没写就没有爬藤。\n` +
        `   举例：某组是河谷场景，则"灰白砾石滩""半山松林""冷蓝色调"都应列出——它们属于该地点，不随场次改变；\n` +
        `   某组是古宅场景，则"青砖灰瓦""木质门廊""暗暖色调"同样都应列出——规则与题材无关。\n` +
        `7. 【必需】每组 shared_env 必须包含且仅包含一条组级光照常量，固定格式：\n` +
        `   "光照｜{时段}；主光源{方向+色温+强度}；{本组各场的受光面与背光面状态，必须写明低处物体的阴影}"\n` +
        `   （示例："光照｜清晨；主光源对岸高处斜射阳光，暖金；本侧背光冷灰，低处桥体与谷底处于阴影"）\n` +
        `   归并裁决规则：同组场景处于同一物理空间、同一时刻，光照常量全组唯一——组内各场描述矛盾时\n` +
        `   （如一场写"阴天散射"一场写"对岸阳光"），以剧本同一时刻与空间物理为准裁决：有明确光源动机的版本优先，\n` +
        `   阳光只照亮高处时低处必须写阴影。该条目会原样注入同组所有场景的生图提示词，是同组光照一致性的唯一事实源。\n\n` +
        `输出 JSON（严格遵守此结构）：\n` +
        `{"scenes":[{"scene_id":数字,"spatial_group":"...","spatial_role":"...","landmarks":["..."],"elements":["..."]}],` +
        ` "shared_landmarks":["..."],"shared_env":{"组名":["..."]}}`,
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
    parsed = parseJsonLoose(text)
  } catch {
    throw new Error('LLM 场景分析返回非 JSON')
  }
  return validateAnalysis(parsed, scenes)
}

function validateAnalysis(parsed, scenes) {
  const validIds = new Set(scenes.map((s) => s.id))
  const rows = []

  const landmarkSet = new Set()
  if (Array.isArray(parsed?.shared_landmarks)) {
    for (const p of parsed.shared_landmarks) {
      const name = String(p || '').trim()
      if (name) landmarkSet.add(name)
    }
  }
  if (Array.isArray(parsed?.scenes)) {
    for (const r of parsed.scenes) {
      if (!Array.isArray(r?.landmarks)) continue
      for (const p of r.landmarks) {
        const name = String(p || '').trim()
        if (name) landmarkSet.add(name)
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
      landmarks: (Array.isArray(r?.landmarks) ? r.landmarks : [])
        .map((p) => String(p || '').trim())
        .filter((p) => p && landmarkSet.has(p)),
      elements: parseElementList(JSON.stringify(Array.isArray(r?.elements) ? r.elements : [])).slice(0, MAX_ELEMENT_COUNT),
    })
  }
  for (const s of scenes) {
    if (!rows.some((r) => r.scene_id === s.id)) {
      rows.push({ scene_id: s.id, spatial_group: '', spatial_role: '', landmarks: [], elements: [] })
    }
  }

  const liveGroups = new Set(rows.map((r) => r.spatial_group).filter(Boolean))
  const sharedEnv = {}
  const rawEnv = parsed?.shared_env && typeof parsed.shared_env === 'object' ? parsed.shared_env : {}
  for (const [g, list] of Object.entries(rawEnv)) {
    const name = String(g || '').trim()
    if (!name || !liveGroups.has(name)) continue
    // shared_env 放宽到 80 字：组级光照常量条目（固定前缀"光照｜"）需要容纳时段+光源+受光状态，
    // 48 字曾把常量截成半截话（"…低处冰河与谷底隐在阴"），消费端吃到的是残句
    const cleaned = parseElementList(JSON.stringify(Array.isArray(list) ? list : []), 80).slice(0, MAX_SHARED_ENV_COUNT)
    if (cleaned.length) sharedEnv[name] = cleaned
  }

  return { rows, sharedEnv }
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
    'SELECT id, scene_number, title, summary, image_url, spatial_context FROM scenes WHERE episode_id = ? ORDER BY scene_number',
    [episodeId]
  )
  if (!scenes.length) return { ok: false, reason: 'no_scenes', sceneCount: 0 }

  const fp = fingerprintOf(scenes)
  const cur = queryOne('SELECT fingerprint FROM scene_analysis WHERE episode_id = ? LIMIT 1', [episodeId])
  if (!force && cur?.fingerprint === fp) return { ok: true, cached: true, sceneCount: scenes.length }

  const { rows: llmRows, sharedEnv } = await analyzeWithLlm(scenes, episodeId)

  // 提取已确认关联兜底：LLM 留空的组/视角/地标用提取产出补齐——LLM 只做增量推断，不推翻已确认事实
  for (const r of llmRows) {
    const ext = parseSpatialContext(scenes.find((s) => s.id === r.scene_id)?.spatial_context)
    if (!ext) continue
    if (!r.spatial_group && ext.group) r.spatial_group = ext.group
    if (!r.spatial_role && ext.role) r.spatial_role = ext.role
    if (!r.landmarks.length && ext.landmarks.length) r.landmarks = ext.landmarks.slice()
  }

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
      [episodeId, r.scene_id, sn, r.spatial_group, r.spatial_role, JSON.stringify(r.landmarks),
        JSON.stringify(r.elements || []), JSON.stringify(env), fp]
    )
  }

  // 场景图不再登记 scene 锚（登记了没人读，已按用户决策移除）。
  // 此 DELETE 保留：每次重析顺带清掉历史遗留的 auto 锚（scene/prop 类），
  // 跑几轮后旧垃圾自然清空；layout/spatial 锚是 manual 来源，不受影响。
  execute(`DELETE FROM scene_anchors WHERE episode_id = ? AND source = 'auto'`, [episodeId])

  // 重析后组名可能变了，清理失效的 layout 锚及其历史（组名在当前分组里已不存在）。
  execute(
    `DELETE FROM scene_anchors WHERE episode_id = ? AND anchor_type = '${LAYOUT_ANCHOR_TYPE}'
     AND anchor_key NOT IN (SELECT DISTINCT spatial_group FROM scene_analysis WHERE episode_id = ? AND TRIM(spatial_group) != '')`,
    [episodeId, episodeId]
  )
  execute(
    `DELETE FROM layout_anchor_history WHERE episode_id = ? AND spatial_group NOT IN (SELECT DISTINCT spatial_group FROM scene_analysis WHERE episode_id = ? AND TRIM(spatial_group) != '')`,
    [episodeId, episodeId]
  )

  return { ok: true, cached: false, sceneCount: scenes.length }
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
    `SELECT sa.scene_id, sa.scene_number, sa.spatial_group, sa.spatial_role, COALESCE(s.image_url, '') AS image_url,
            COALESCE(sgr.status, '') AS review_status
     FROM scene_analysis sa
     LEFT JOIN scenes s ON s.id = sa.scene_id
     LEFT JOIN spatial_group_review sgr ON sgr.episode_id = sa.episode_id AND sgr.spatial_group = sa.spatial_group
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
    reviewStatus: String(r.review_status || ''),
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
    // confirmed = 0 表示用户已停用该组的布局图参考：整段跳过，
    // refs / hint / anchors 都不带它，下游提示词与质检上下文随之自动一致。
    const la = queryOne(
      `SELECT anchor_key, image_url FROM scene_anchors
       WHERE episode_id = ? AND anchor_type = '${LAYOUT_ANCHOR_TYPE}' AND anchor_key = ?
         AND confirmed = 1`,
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

  // 参考图只保留「布局图（开关控制）+ 人审基准图（手动确认的那一张）」。
  // 不再自动拼装同组邻场图与道具图——那套「自动滚雪球」会造成种子不可控、
  // 参考图上限随入口漂移、以及把固定地标误当道具匹配等问题，已按用户决策移除。

  return {
    refs, promptHints, anchors,
    elements, sharedEnv,
    spatialRole: String(row.spatial_role || '').trim(),
  }
}

export async function buildShotAnchorInjection({ episodeId, sceneNames = [] } = {}) {
  // 分镜出图的空间锚注入：按镜头场景名（shot.scene_assets 解析结果，前者优先）
  // 命中 scenes 表首个场景，取其已确认人审基准图 + 启用中的布局图。
  // 快照不含 budget/degraded，由调用方按实际注入结果补记。
  const names = (Array.isArray(sceneNames) ? sceneNames : []).map((n) => String(n || '').trim()).filter(Boolean)
  const empty = {
    sceneId: 0, sceneTitle: '', group: '',
    baselineUrl: '', layoutUrl: '',
    promptHints: [], elements: [], sharedEnv: [], snapshot: null,
  }
  if (!episodeId || !names.length) return empty

  const rows = query(
    `SELECT id, title FROM scenes WHERE episode_id = ? AND title IN (${names.map(() => '?').join(',')})`,
    [episodeId, ...names]
  )
  let scene = null
  for (const n of names) {
    scene = rows.find((r) => r.title === n)
    if (scene) break
  }
  if (!scene) return empty

  const built = await buildAnchorRefsForScene(episodeId, Number(scene.id))
  const anchors = built.anchors || []
  const baseline = anchors.find((a) => a.type === SPATIAL_ANCHOR_TYPE)
  const layout = anchors.find((a) => a.type === LAYOUT_ANCHOR_TYPE)
  const baselineUrl = baseline?.image || ''
  const layoutUrl = layout?.image || ''

  return {
    sceneId: Number(scene.id),
    sceneTitle: scene.title,
    group: baseline?.key || '',
    baselineUrl,
    layoutUrl,
    promptHints: built.promptHints || [],
    elements: built.elements || [],
    sharedEnv: built.sharedEnv || [],
    snapshot: {
      version: 1,
      generated_at: new Date().toISOString(),
      scene: {
        scene_id: Number(scene.id),
        title: scene.title,
        group: baseline?.key || '',
        baseline_url: baselineUrl,
        layout_url: layoutUrl,
      },
      elements: built.elements || [],
      shared_env: built.sharedEnv || [],
    },
  }
}

// 当前组已确认人审基准图（bare URL）：供列表接口与出图快照比对「依据是否已变」。
// 与 buildShotAnchorInjection 取基准的口径完全一致（manual + confirmed 的组基准）。
export function currentBaselineUrlForGroup(episodeId, group) {
  if (!episodeId || !group) return ''
  const row = queryOne(
    `SELECT image_url FROM scene_anchors
      WHERE episode_id = ? AND anchor_type = '${SPATIAL_ANCHOR_TYPE}' AND anchor_key = ?
        AND source = 'manual' AND confirmed = 1`,
    [Number(episodeId), String(group)]
  )
  return bareUrl(row?.image_url)
}

export function lockCurrentGrouping(episodeId, opts = {}) {
  // 传 sceneIds 时只锁这些场景（组卡上的「锁定这组」，与 unlockGrouping 对称）；
  // 不传时锁该剧集当前的全部分组（「重新锁定分组」这类全量修复入口）。
  const ids = Array.isArray(opts.sceneIds)
    ? opts.sceneIds.map(Number).filter((n) => Number.isFinite(n) && n > 0)
    : []
  const rows = ids.length
    ? query(
      `SELECT scene_id, spatial_group FROM scene_analysis
       WHERE episode_id = ? AND TRIM(spatial_group) != ''
         AND scene_id IN (${ids.map(() => '?').join(',')})`,
      [episodeId, ...ids]
    )
    : query(
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

// —— 集级布局路线开关：全开/全关是管线路由，不是一次性批量操作 ——
// 'on'  = 布局路线激活：出图注入布局底图，未画的组引导先画
// 'off' = 整集不走布局路线：出图一律不带布局、不再引导画、新画/换版本不自动启用
export function ensureLayoutRouteTable() {
  execute(`CREATE TABLE IF NOT EXISTS episode_layout_route (
    episode_id INTEGER PRIMARY KEY,
    route TEXT NOT NULL DEFAULT 'on',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`)
}

export function getLayoutRoute(episodeId) {
  const ep = Number(episodeId)
  if (!ep) return 'on'
  ensureLayoutRouteTable()
  const row = queryOne(`SELECT route FROM episode_layout_route WHERE episode_id = ?`, [ep])
  if (row) return String(row.route) === 'off' ? 'off' : 'on'
  // 无持久记录：从存量锚推导（旧数据兼容——曾批量全关过的集自动识别为 off）
  const rows = query(
    `SELECT confirmed FROM scene_anchors WHERE episode_id = ? AND anchor_type = '${LAYOUT_ANCHOR_TYPE}'`,
    [ep]
  )
  if (rows.length && rows.every((r) => Number(r.confirmed) === 0)) return 'off'
  return 'on'
}

export function setLayoutRoute(episodeId, route) {
  const ep = Number(episodeId)
  if (!ep) return
  ensureLayoutRouteTable()
  execute(
    `INSERT INTO episode_layout_route (episode_id, route, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(episode_id) DO UPDATE SET route = excluded.route, updated_at = CURRENT_TIMESTAMP`,
    [ep, route === 'off' ? 'off' : 'on']
  )
}

export function registerLayoutAnchor(episodeId, group, imageUrl, opts = {}) {
  const g = String(group || '').trim()
  const img = bareUrl(imageUrl)
  if (!g || !img) return { registered: false }
  const fp = String(opts.sourceFingerprint || '')
  // 覆盖前把当前版存进历史带：布局图的污染会被放大到组内每张成品图，
  // 重画/换回都必须可逆。同图不重复入历史（A→B→A 反复切换不堆积）。
  const prev = getLayoutAnchor(episodeId, g)
  if (prev?.imageUrl && prev.imageUrl !== img) {
    const dup = queryOne(
      `SELECT id FROM layout_anchor_history WHERE episode_id = ? AND spatial_group = ? AND image_url = ?`,
      [episodeId, g, prev.imageUrl]
    )
    if (!dup) {
      execute(
        `INSERT INTO layout_anchor_history (episode_id, spatial_group, image_url, description, source_fingerprint)
         VALUES (?, ?, ?, ?, ?)`,
        [episodeId, g, prev.imageUrl, prev.description || '', prev.sourceFingerprint || '']
      )
    }
  }
  // 开关语义：重画/上传/换版本不该悄悄改变参考启用状态——
  // 已有锚保留原 confirmed；新锚只有在布局路线激活（集级 route=on）时才默认启用
  const hasPrev = !!prev?.imageUrl
  const nextConfirmed = hasPrev ? (prev.confirmed ? 1 : 0) : (getLayoutRoute(episodeId) === 'off' ? 0 : 1)
  execute(
    `INSERT INTO scene_anchors (episode_id, anchor_type, anchor_key, scene_id, scene_number, image_url, description, source, source_fingerprint, confirmed)
     VALUES (?, '${LAYOUT_ANCHOR_TYPE}', ?, ?, ?, ?, ?, 'manual', ?, ?)
     ON CONFLICT(episode_id, anchor_type, anchor_key) DO UPDATE SET
       image_url = excluded.image_url,
       description = excluded.description,
       scene_id = excluded.scene_id,
       scene_number = excluded.scene_number,
       source = 'manual',
       source_fingerprint = excluded.source_fingerprint,
       confirmed = excluded.confirmed`,
    [
      episodeId, g, Number(opts.repSceneId) || 0, Number(opts.repSceneNumber) || 0, img,
      String(opts.description || `空间组「${g}」布局示意图`), fp, nextConfirmed,
    ]
  )
  return { registered: true, group: g, image: img, sourceFingerprint: fp, confirmed: nextConfirmed === 1 }
}

export function getLayoutAnchorHistory(episodeId, group) {
  const g = String(group || '').trim()
  if (!g) return []
  const cur = getLayoutAnchor(episodeId, g)
  const rows = query(
    `SELECT id, image_url, description, source_fingerprint, created_at FROM layout_anchor_history
     WHERE episode_id = ? AND spatial_group = ?
     ORDER BY id DESC LIMIT 20`,
    [episodeId, g]
  )
  const out = rows
    .map((r) => ({
      id: Number(r.id),
      imageUrl: bareUrl(r.image_url),
      description: r.description || '',
      sourceFingerprint: String(r.source_fingerprint || ''),
      createdAt: String(r.created_at || ''),
      isCurrent: false,
    }))
    .filter((r) => r.imageUrl)
  if (cur?.imageUrl) {
    out.unshift({
      id: 0,
      imageUrl: cur.imageUrl,
      description: cur.description || '',
      sourceFingerprint: cur.sourceFingerprint || '',
      createdAt: '',
      isCurrent: true,
    })
  }
  return out
}

export function restoreLayoutAnchor(episodeId, group, historyId) {
  const g = String(group || '').trim()
  const hid = Number(historyId)
  if (!g || !Number.isFinite(hid) || hid <= 0) return { restored: false }
  const h = queryOne(
    `SELECT image_url, description, source_fingerprint FROM layout_anchor_history
     WHERE id = ? AND episode_id = ? AND spatial_group = ?`,
    [hid, episodeId, g]
  )
  const img = bareUrl(h?.image_url)
  if (!img) return { restored: false }
  // registerLayoutAnchor 会先把当前版存入历史，实现版本对调；三步写包事务保证原子性
  transaction(() => {
    registerLayoutAnchor(episodeId, g, img, {
      description: h.description || `空间组「${g}」布局示意图（换回的历史版本）`,
      sourceFingerprint: String(h.source_fingerprint || ''),
    })
    execute('DELETE FROM layout_anchor_history WHERE id = ?', [hid])
  })
  return { restored: true, group: g, image: img }
}

export function getLayoutAnchor(episodeId, group) {
  const g = String(group || '').trim()
  if (!g) return null
  const row = queryOne(
    `SELECT anchor_key, image_url, description, source_fingerprint, confirmed FROM scene_anchors
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
        confirmed: Number(row.confirmed ?? 1) === 1,
      }
    : null
}
