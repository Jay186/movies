// 重新提取的覆盖保护（2026-09-16，审计 P1 —— 唯一会永久丢失用户劳动成果的问题）
//
// 背景（审计报告 §P1）：三条落库路径都是「DELETE 整表 + INSERT 重建」，
// 重建时只保护英文三字段（title_en/summary_en/lighting_en）与 image_url：
//   - 中文 summary/description/prop_names 一律被 LLM 新值覆盖 —— 用户手工改的设定无声丢失；
//   - 新提取里没有的同名资产被整行删除 —— 用户手工补充的资产直接消失，且不可恢复。
//
// 本模块提供三层保护（纯函数 + 文件 IO，不直接持有业务路由外的东西）：
//   A. 覆盖前自动快照：DELETE 之前把「将被删除的行」整表存成 JSON，保留最近 10 份，可手工还原。
//      —— 这是**兜底**：即便智能 diff 判错，最坏也只是回到快照。
//   B. 智能 diff 确认：落库前比对「本次将写入的最终行」与「库中现有行」，检出两类风险
//      （字段覆盖 / 条目删除），仅在**有风险**时交给前端二次确认；无风险静默落库，零打扰。
//   C. 决策应用：用户选「全部保留我的」时，同名条目的受保护字段回退为旧值、被删条目整行复原；
//      选「接受新值」时维持 LLM 覆盖行为。
//
// 设计原则：
//   - 快照失败**绝不能**阻断提取（同 alerts.js 的教训：辅助链路失败不能搞挂主流程）
//     → 内部 try/catch + recordAlert，返回 {ok:false} 由调用方继续；
//   - 无风险路径落库结果与改造前**逐字节一致**（决策应用只在 keep 时改写输入）；
//   - 判据（哪些字段受保护、如何匹配条目、什么算「空」）集中在本模块一处，
//     供三条落库路径复用，杜绝判据在两处各存一份迟早漂移。

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { query, execute, transaction } from '../db.js'
import { recordAlert } from './alerts.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 快照目录：默认 server/_snapshots；测试可用 EXTRACT_SNAPSHOT_DIR 指向临时目录，
// 避免验收脚本往真实目录里灌测试快照。
const SNAPSHOT_DIR = process.env.EXTRACT_SNAPSHOT_DIR
  ? path.resolve(process.env.EXTRACT_SNAPSHOT_DIR)
  : path.join(__dirname, '..', '_snapshots')
// 保留最近 N 份快照（工单要求：keep 10）
const SNAPSHOT_KEEP = 10

// 每张资产表的：匹配键（判断「同名条目」用哪一列）+ 受保护字段（被覆盖即算风险 / keep 时回退）。
// 说明：
//   - image_url 也纳入受保护：虽然前端提取流程会带回旧图，但一键全流程等旁路未必，
//     纳入后一旦被覆盖也会提示，符合「不漏报用户损失」的目标。
//   - scenes 的 title_en/lighting_en 等英文常量早就有「旧值优先」逻辑，这里仍纳入 diff，
//     保证「用户手工维护的英文常量被覆盖」同样能被看见。
const TABLE_META = {
  characters: {
    key: 'name',
    protected: ['role', 'description', 'appearance', 'image_url', 'audio_url', 'color', 'name_en', 'description_en'],
  },
  props: {
    key: 'name',
    // name_en 于 2026-09-16 补齐：props 与 characters/scenes 一样有「英文常量保全」需求
    // （H3 提示词全英文，name_en 为空会静默回退中文）。此前漏登记 → 「手工维护的英文常量
    // 将被抹掉」既不被 diff 检出、keep 时也不回填，是反复丢数据的根因。
    // description_en 于 2026-09-17 补齐：同一个坑在道具英文描述上重演过一次——
    // 前端已能提交它、后端已能落库，但这里没登记就仍然「不报警、keep 也不回填」。
    protected: ['description', 'owner', 'image_url', 'name_en', 'description_en'],
  },
  scenes: {
    key: 'title',
    // location 于 2026-09-17 补齐：场景地点（入出片参考）同为前端可提交、后端可落库的字段，
    // 未登记则重提取时被 LLM 新值静默覆盖、keep 也保不住。判据与 description_en 同：
    // 受保护字段列表 = 「用户可能手工维护、不能被 LLM 静默覆盖」的字段全集。
    protected: ['summary', 'prop_names', 'image_url', 'title_en', 'summary_en', 'lighting_en', 'location'],
  },
}

// ─────────────────────────── 工具 ───────────────────────────

function pad2(n) {
  return String(n).padStart(2, '0')
}

// 文件名时间戳：YYYYmmdd_HHMMSS（工单规范）
function stamp(d = new Date()) {
  return (
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`
    + `_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  )
}

function norm(v) {
  return v == null ? '' : String(v)
}

// 字段级归一化：用于「是否算内容 / 是否相同」的比较。
// prop_names 特殊：空数组 '[]' 与空串等价（无内容可丢），且 JSON 数组按排序后比较
// （道具顺序变化不应误报为「字段覆盖」）。
function normField(field, v) {
  let s = norm(v).trim()
  if (field === 'prop_names') {
    if (s === '' || s === '[]' || s === 'null') return ''
    try {
      const arr = JSON.parse(s)
      if (Array.isArray(arr)) return JSON.stringify(arr.map(String).sort())
    } catch { /* 非 JSON 原样比较 */ }
  }
  return s
}

export function snapshotDir() {
  return SNAPSHOT_DIR
}

// ─────────────────────────── A. 覆盖前快照 ───────────────────────────

/**
 * 覆盖前快照：把将要被 DELETE 的整表行存成 JSON 文件。
 * **绝不抛错**——失败记一条 warn 告警后返回 {ok:false}，由调用方继续提取主流程。
 *
 * @param {Object} o
 * @param {number|string} o.episodeId
 * @param {string} [o.trigger]  触发来源标记（如 'extract-scenes'/'pipeline-scenes'），写进 meta
 * @param {string[]|string} o.tables 将被删除的表名（characters/props/scenes）
 * @returns {{ok:boolean, file?:string, meta?:Object, error?:string}}
 */
export function snapshotBeforeExtract({ episodeId, trigger = 'extract', tables = [] } = {}) {
  try {
    const list = (Array.isArray(tables) ? tables : [tables]).filter((t) => TABLE_META[t])
    if (!list.length) return { ok: false, error: 'no valid tables' }

    if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true })

    const createdAt = new Date()
    const data = {}
    for (const t of list) {
      data[t] = query(`SELECT * FROM ${t} WHERE episode_id = ?`, [episodeId])
    }

    const payload = {
      meta: {
        episodeId: Number(episodeId),
        trigger: String(trigger || 'extract'),
        createdAt: createdAt.toISOString(),
        tables: list.map((t) => ({ table: t, count: data[t].length })),
      },
      data,
    }

    // 工单规范文件名：extract_snapshot_ep<N>_<YYYYmmdd_HHMMSS>.json
    // 同一秒内对同一集多次快照（多表分次 DELETE）会撞名 → 追加序号保证唯一。
    const base = `extract_snapshot_ep${episodeId}_${stamp(createdAt)}`
    let file = path.join(SNAPSHOT_DIR, `${base}.json`)
    let n = 1
    while (fs.existsSync(file)) file = path.join(SNAPSHOT_DIR, `${base}_${++n}.json`)

    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8')
    pruneSnapshots(SNAPSHOT_KEEP)
    return { ok: true, file, meta: payload.meta }
  } catch (e) {
    try {
      recordAlert({
        level: 'warn',
        source: 'extract-snapshot',
        episodeId,
        message: `覆盖前快照失败（不影响提取，继续执行）：${e.message}`,
      })
    } catch { /* 连告警都记不上也不能影响主流程 */ }
    return { ok: false, error: e.message }
  }
}

/** 列出快照（按时间倒序；传 episodeId 只看该集）。坏文件跳过 meta 但不丢条目。 */
export function listSnapshots(episodeId = null) {
  try {
    if (!fs.existsSync(SNAPSHOT_DIR)) return []
    const files = fs.readdirSync(SNAPSHOT_DIR)
      .filter((f) => f.startsWith('extract_snapshot_ep') && f.endsWith('.json'))
    const items = []
    for (const f of files) {
      const abs = path.join(SNAPSHOT_DIR, f)
      let mtimeMs = 0
      try { mtimeMs = fs.statSync(abs).mtimeMs } catch { continue }
      let meta = null
      try { meta = JSON.parse(fs.readFileSync(abs, 'utf8'))?.meta || null } catch { /* 损坏文件 */ }
      items.push({ file: f, path: abs, mtimeMs, meta })
    }
    const filtered = episodeId == null
      ? items
      : items.filter((i) => Number(i.meta?.episodeId) === Number(episodeId))
    return filtered.sort((a, b) => b.mtimeMs - a.mtimeMs)
  } catch {
    return []
  }
}

/** 只保留最近 keep 份快照（全局，按 mtime 倒序），删除更旧的。 */
export function pruneSnapshots(keep = SNAPSHOT_KEEP) {
  try {
    const all = listSnapshots(null)
    for (const item of all.slice(Math.max(0, keep))) {
      try { fs.unlinkSync(item.path) } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

/**
 * 从快照文件还原某集资产（**按需手工调用，绝不自动回滚**）。
 * 对快照里出现的每张表：先删该集现有行，再按快照行插回。
 * 列以「目标表实际列（PRAGMA）× 快照行键」求交集，兼容历史快照含已废弃列的情况。
 *
 * @param {string} file 绝对路径或 _snapshots 下的文件名
 * @returns {Object} 每张表还原的行数
 */
export function restoreSnapshot(file) {
  const abs = path.isAbsolute(file) ? file : path.join(SNAPSHOT_DIR, file)
  const payload = JSON.parse(fs.readFileSync(abs, 'utf8'))
  const episodeId = Number(payload?.meta?.episodeId)
  const data = payload?.data || {}
  if (!episodeId) throw new Error('快照缺少 episodeId')

  const result = {}
  transaction(() => {
    for (const table of Object.keys(data)) {
      if (!TABLE_META[table]) continue
      const rows = Array.isArray(data[table]) ? data[table] : []
      const cols = query(`PRAGMA table_info(${table})`).map((c) => c.name).filter((c) => c !== 'id')
      execute(`DELETE FROM ${table} WHERE episode_id = ?`, [episodeId])
      let inserted = 0
      for (const row of rows) {
        const useCols = cols.filter((c) => Object.prototype.hasOwnProperty.call(row, c))
        if (!useCols.length) continue
        const sql = `INSERT INTO ${table} (${useCols.join(', ')}) VALUES (${useCols.map(() => '?').join(', ')})`
        execute(sql, useCols.map((c) => row[c]))
        inserted++
      }
      result[table] = inserted
    }
  })
  return result
}

/** 还原某集最近一份快照（便利入口）。无快照返回 null。 */
export function restoreLatestSnapshot(episodeId) {
  const [latest] = listSnapshots(episodeId)
  if (!latest) return null
  return restoreSnapshot(latest.path)
}

// ─────────────────────────── B. 智能 diff ───────────────────────────

/**
 * 比对「将被写入的最终行」与「库中现有行」，检出两类覆盖风险。纯函数，不查库、不抛错。
 *
 * 风险判据：
 *   1. 字段覆盖：同名条目、某受保护字段「旧值非空」且「本次写入值不同」——
 *      旧值非空代表用户已付出劳动，被改写即损失（含被清空）。
 *   2. 条目删除：库中存在、但本次写入列表里没有的条目——整行将被 DELETE 抹掉。
 * 新增条目（新键）不算风险。
 *
 * @param {Object} o
 * @param {'characters'|'props'|'scenes'} o.table
 * @param {Array<Object>} o.oldRows  库中现有行（真实列名）
 * @param {Array<Object>} o.incoming 本次将要写入的最终行（按各自 key 匹配，含受保护字段）
 * @returns {{hasRisk:boolean, table:string, overwrites:Array, deletions:Array, counts:Object}}
 */
export function computeExtractDiff({ table, oldRows = [], incoming = [] } = {}) {
  const meta = TABLE_META[table]
  if (!meta) {
    return { hasRisk: false, table, overwrites: [], deletions: [], counts: { overwrites: 0, deletions: 0 } }
  }
  const key = meta.key

  const oldByKey = new Map()
  for (const r of oldRows) {
    const k = norm(r[key]).trim()
    if (k) oldByKey.set(k, r)
  }

  const newKeys = new Set()
  const overwrites = []
  for (const row of incoming) {
    const k = norm(row[key]).trim()
    if (!k) continue
    newKeys.add(k)
    const old = oldByKey.get(k)
    if (!old) continue // 新增条目，不是风险
    const fields = []
    for (const f of meta.protected) {
      const ov = normField(f, old[f])
      const nv = normField(f, row[f])
      if (ov && ov !== nv) fields.push({ field: f, from: ov, to: nv })
    }
    if (fields.length) overwrites.push({ name: k, fields })
  }

  const deletions = []
  for (const [k, old] of oldByKey) {
    if (!newKeys.has(k)) deletions.push({ name: k, row: old })
  }

  return {
    hasRisk: overwrites.length > 0 || deletions.length > 0,
    table,
    overwrites,
    deletions,
    counts: { overwrites: overwrites.length, deletions: deletions.length },
  }
}

// ─────────────────────────── C. 决策应用（「全部保留我的」）──────────────────────────
//
// 说明：这三个函数只在 decision='keep' 时调用；返回**与各路由 INSERT 循环同形状**的
// 输入数组（同名条目受保护字段回退为旧值 + 被删条目整行复原追加）。
// 这样路由既有的 INSERT 循环（含英文常量「显式带值优先」继承、P3 冷暖校验）一字不改即可复用。

function parsePropNames(v) {
  try {
    const arr = JSON.parse(norm(v) || '[]')
    return Array.isArray(arr) ? arr.map(String).filter(Boolean) : []
  } catch {
    return []
  }
}

/**
 * 取 LLM 侧英文常量：兼容 camelCase（LLM 输出）与 snake_case（库内行形状）两种键名。
 *
 * 为何不直接 `s.titleEn || s.title_en`：LLM 偶尔会给出非字符串（数字/对象/数组），
 * 裸 `||` 会把 `{}` 这种值放过去，落到 INSERT 时被 String() 成 '[object Object]' ——
 * 它不含任何中日韩字符，pickEnglish 闸门照样放行 → 垃圾串混进出片 prompt 的英文正文。
 * 故只认**非空字符串**，其余一律视为缺失（安全退化为空，由 `||` 继续向后兜底）。
 * 与 generate-script.js 的 finalTitleEn / finalSummaryEn / finalLightingEn 同口径。
 */
function llmStr(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim() !== '') return v
  }
  return ''
}

/** scenes：入参为路由前端形状 [{name,description,propNames,imageUrl,titleEn?,...}] */
export function applyKeepForScenes(incoming = [], oldRows = []) {
  const oldByTitle = new Map(oldRows.map((r) => [norm(r.title).trim(), r]))
  const patched = incoming.map((s) => {
    const name = norm(s.name || s.title).trim()
    const old = oldByTitle.get(name)
    if (!old) return s // 新增条目：保留 LLM 新值
    return {
      ...s,
      // 受保护字段回退为「我的旧值」（旧值为空则保留 LLM 新值，避免把有值顶成空）
      description: old.summary || s.description || '',
      propNames: parsePropNames(old.prop_names),
      imageUrl: old.image_url || s.imageUrl || s.image_url || '',
      // titleEn/summaryEn/lightingEn（2026-09-18 修正）：必须与紧邻上方注释同义——
      // 「旧值优先、LLM 新值兜底」。此前写成 `old.title_en || ''`，与注释、与兄弟函数
      // applyKeepForProps 的 nameEn、与 generate-script.js 的 finalTitleEn/finalSummaryEn/
      // finalLightingEn **三处口径都矛盾**（漏改）：旧值为空时把 LLM 刚提取出的英文名静默抹掉。
      // ⚠️ 不影响覆盖弹窗：computeExtractDiff 只在旧值**非空**时才判覆盖风险，故此处
      //    回填 LLM 值不会凭空弹出「将被覆盖」提示。
      titleEn: old.title_en || llmStr(s.titleEn, s.title_en),
      summaryEn: old.summary_en || llmStr(s.summaryEn, s.summary_en),
      lightingEn: old.lighting_en || llmStr(s.lightingEn, s.lighting_en),
      // location（2026-09-17 补齐）：⚠️ 此处**不能**照抄上面几行的 `||`。
      // location 走「显式带值优先」语义（同 episodes.js INSERT），旧值来自 DB 且 location
      // 列已由 P1 回填保证非空 → old.location ?? ... 恒等于 old.location。
      // 即 keep = 无条件保留我的旧地点；若用 `||` 反而在旧值恰为空串时把 LLM 值放进来。
      location: old.location ?? s.location ?? s.location_en ?? '',
    }
  })
  const have = new Set(incoming.map((s) => norm(s.name || s.title).trim()))
  for (const old of oldRows) {
    if (have.has(norm(old.title).trim())) continue
    // 被 LLM 删掉的旧场景：整行复原（追加到末尾，scene_number 由循环重排）
    patched.push({
      name: old.title,
      description: old.summary || '',
      propNames: parsePropNames(old.prop_names),
      imageUrl: old.image_url || '',
      titleEn: old.title_en || '',
      summaryEn: old.summary_en || '',
      lightingEn: old.lighting_en || '',
      // 整行复原：旧地点可能为空串，如实带回（与 location 列语义一致，不凭空造值）
      location: old.location ?? '',
      __restored: true,
    })
  }
  return patched
}

/** props：入参为路由前端形状 [{name,description,owner,imageUrl,nameEn?}] */
export function applyKeepForProps(incoming = [], oldRows = []) {
  const oldByName = new Map(oldRows.map((r) => [norm(r.name).trim(), r]))
  const patched = incoming.map((p) => {
    const name = norm(p.name).trim()
    const old = oldByName.get(name)
    if (!old) return p
    return {
      ...p,
      description: old.description || p.description || '',
      owner: old.owner || p.owner || '',
      imageUrl: old.image_url || p.imageUrl || p.image_url || '',
      // 英文常量保全（2026-09-16 补齐，与 applyKeepForCharacters 同式）：
      // 「我的旧值」优先，旧值为空才用新值，避免把手工维护的英文名顶成空。
      nameEn: old.name_en || p.nameEn || p.name_en || '',
      // description_en（2026-09-17 补齐）：keep 的契约是「保留我的」→ 旧值必须**无条件**胜出。
      // ⚠️ 不能写成 `p.descriptionEn ?? old.description_en`：LLM 重提取时 payload 往往显式带
      // descriptionEn（新值），那样会让新值反压旧值，keep 等于 accept（实测踩过）。
      // 也不能照抄上面几行的 `old.x || p.x`：`||` 在旧值为空串时会把新值放进来，
      // 而空串是「用户主动清空」的合法状态，必须被保住。
      // 故用 `old.description_en ?? p.descriptionEn ?? p.description_en ?? ''`：
      // 旧值来自 DB、该列 NOT NULL DEFAULT ''，故恒取旧值 —— 正是 keep 应有的行为。
      descriptionEn: old.description_en ?? p.descriptionEn ?? p.description_en ?? '',
    }
  })
  const have = new Set(incoming.map((p) => norm(p.name).trim()))
  for (const old of oldRows) {
    if (have.has(norm(old.name).trim())) continue
    patched.push({
      name: old.name,
      description: old.description || '',
      owner: old.owner || '',
      imageUrl: old.image_url || '',
      // 整行复原时同样带回英文常量，否则「被删道具还原」也会丢 name_en
      nameEn: old.name_en || '',
      // 整行复原：旧描述如实带回，不凭空造值
      descriptionEn: old.description_en ?? '',
      __restored: true,
    })
  }
  return patched
}

/** characters：入参为 replaceEpisodeCharacters 的前端形状 [{name,role,description,imageUrl,...}] */
export function applyKeepForCharacters(incoming = [], oldRows = []) {
  const oldByName = new Map(oldRows.map((r) => [norm(r.name).trim(), r]))
  const patched = incoming.map((c) => {
    const name = norm(c.name).trim()
    const old = oldByName.get(name)
    if (!old) return c
    return {
      ...c,
      role: old.role || c.role || '配角',
      description: old.description || c.description || '',
      appearance: old.appearance || c.appearance || '',
      imageUrl: old.image_url || c.imageUrl || c.image_url || '',
      audioUrl: old.audio_url || c.audioUrl || c.audio_url || '',
      color: old.color || c.color || '#6b9bd1',
      nameEn: old.name_en || c.nameEn || c.name_en || '',
      descriptionEn: old.description_en || c.descriptionEn || c.description_en || '',
    }
  })
  const have = new Set(incoming.map((c) => norm(c.name).trim()))
  for (const old of oldRows) {
    if (have.has(norm(old.name).trim())) continue
    patched.push({
      name: old.name,
      role: old.role || '配角',
      description: old.description || '',
      appearance: old.appearance || '',
      imageUrl: old.image_url || '',
      audioUrl: old.audio_url || '',
      color: old.color || '#6b9bd1',
      nameEn: old.name_en || '',
      descriptionEn: old.description_en || '',
      projectCharacterId: old.project_character_id || old.projectCharacterId || null,
      __restored: true,
    })
  }
  return patched
}

// 供测试与调试：暴露受保护字段口径
export const _tableMeta = TABLE_META
