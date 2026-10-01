// 运行时 AI 模型配置层：库为唯一事实源。三条用途通道（text / image / video）的凭据与条目全部来自库，
// 运行时【不再回退 .env】；.env（config.js 快照）仅作【首启 seed 初值】与【旧库迁移取值源】，不参与运行期取值。
// 本模块是全链路的运行时读取入口，写操作后 invalidate() 使改动即时生效，无需重启。
// 注意：不得在本模块 import 任何 ai/* 消费模块，避免环依赖。
import { config } from './config.js'
import { query, queryOne, execute, transaction } from './db.js'
import { openaiChatUrl, openaiModelsUrl } from './ai/openaiUrl.js'

// 账号 = 用途通道：text=文本大模型通道，image=生图通道，video=视频通道（RunningHub 工作流）。
// 一个通道恰好承载一套 base_url + api_key；ai_model_entries.account_key 与 kind 一一对应（写入时强制 equal）。
export const ACCOUNT_KEYS = ['text', 'image', 'video']
const ACCOUNT_NAME = { text: '文本通道', image: '生图通道', video: '视频通道' }
// 旧库（两厂商形态）遗留的账号键，仅供迁移识别与清理
const LEGACY_ACCOUNT_KEYS = ['qimingxing', 'runninghub']
const MASK_TOKEN = '••••'

// 探测超时上限：走 config，避免把请求挂死（不硬编码）。
const PROBE_TIMEOUT_MS = config.timeouts.http.default
const PROBE_MAX_TOKENS = Math.max(32, Number(process.env.LLM_PROBE_MAX_TOKENS) || 2048)

let cache = null

export function invalidate() {
  cache = null
}

function mapEntry(row) {
  return {
    id: row.id,
    account_key: row.account_key,
    kind: row.kind,
    name: row.name || '',
    model_id: row.model_id || '',
    // video 条目的「ID」即 workflow_id（DB 内复用 model_id 列存储），此处给出便捷别名
    workflow_id: row.kind === 'video' ? (row.model_id || '') : '',
    workflow_key: row.workflow_key || '',
    vision: !!row.vision,
    is_default: !!row.is_default,
    enabled: !!row.enabled,
    sort_order: Number(row.sort_order) || 0,
  }
}

function loadCache() {
  const accounts = {}
  for (const r of query('SELECT * FROM ai_accounts')) {
    accounts[r.provider_key] = {
      provider_key: r.provider_key,
      name: r.name || ACCOUNT_NAME[r.provider_key] || '',
      base_url: r.base_url || '',
      api_key: r.api_key || '',
    }
  }
  const entries = query('SELECT * FROM ai_model_entries ORDER BY sort_order ASC, id ASC').map(mapEntry)
  cache = { accounts, entries }
  return cache
}

function getCache() {
  return cache || loadCache()
}

// ── 掩码 ──────────────────────────────────────────────────────────────────
export function maskKey(k) {
  const s = String(k == null ? '' : k)
  if (!s) return ''
  if (s.length < 7) return MASK_TOKEN
  return `${s.slice(0, 3)}${MASK_TOKEN}${s.slice(-4)}`
}

function hasRealKey(v) {
  return !!String(v == null ? '' : v).trim()
}

function isMaskedInput(v) {
  return String(v == null ? '' : v).includes(MASK_TOKEN)
}

// ── 首启 seed（只做一次；此后用户删除记录不再自动重建，也【没有 .env 回退】——
//    删掉即视为有意停用，运行时以「未配置」可读错误暴露，不会静默用 .env 顶上）────────
function ensureAccount(providerKey, data) {
  execute(
    'INSERT OR IGNORE INTO ai_accounts (provider_key, name, base_url, api_key, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)',
    [providerKey, data.name || '', data.base_url || '', data.api_key || '']
  )
}

function insertEntry(data) {
  execute(
    `INSERT INTO ai_model_entries (account_key, kind, name, model_id, workflow_key, vision, is_default, enabled, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    [
      data.account_key,
      data.kind,
      data.name || data.model_id || '',
      data.model_id || '',
      data.workflow_key || '',
      data.vision ? 1 : 0,
      data.is_default ? 1 : 0,
      data.sort_order || 0,
    ]
  )
}

/**
 * 凭据 seed 严格【成对】：主源（QMX_*）必须 base_url 与 api_key 同时有值才整对采用，
 * 否则整对回落到该通道自己的 seed 源。绝不允许跨源拼装（禁止「A 的 base_url + B 的 api_key」这类错配）。
 * 这是设计硬约束：错配会让原本可用的链路（如生图网关）被拼上文本网关的地址而整体瘫痪。
 */
function pairedCredentials(primaryUrl, primaryKey, fallbackUrl, fallbackKey) {
  const url = String(primaryUrl || '').trim()
  const key = String(primaryKey || '').trim()
  if (url && key) return { base_url: url, api_key: key }
  return { base_url: String(fallbackUrl || '').trim(), api_key: String(fallbackKey || '').trim() }
}

// 各通道首启 seed / 旧库迁移的凭据源（.env 只在这里被读取，运行期一律走库）。
//   text  ：QMX_* 成对 → 否则 config.llm（现网实际生效的文本网关）
//   image ：QMX_* 成对 → 否则 config.image.zikl（现网实际生效的生图通道，与文本网关不同源）
//   video ：config.runninghub（base_url 用户不可配，固定平台地址）
function channelSeedCredentials() {
  const qmxUrl = process.env.QMX_BASE_URL
  const qmxKey = process.env.QMX_API_KEY
  return {
    text: pairedCredentials(qmxUrl, qmxKey, config.llm.baseURL, config.llm.apiKey),
    image: pairedCredentials(qmxUrl, qmxKey, config.image.zikl.baseURL, config.image.zikl.apiKey),
    video: { base_url: config.runninghub.baseURL, api_key: config.runninghub.apiKey },
  }
}

function isKnownAccountKey(key) {
  return LEGACY_ACCOUNT_KEYS.includes(key) || ACCOUNT_KEYS.includes(key)
}

// 视频通道的 3 条工作流定义（首启 seed 与旧库迁移共用同一份，避免两处定义漂移）。
// kind='video' 语义 = RunningHub 工作流：model_id 存 workflow_id、workflow_key 存键名，取值路径与生图/文本一致。
function videoWorkflowDefs() {
  return [
    { key: 'h3V4vc', name: '全能V5工作流', id: config.runninghub.workflows.h3V4vc, is_default: 1, sort: 0 },
    { key: 'h3Combat', name: '打斗工作流', id: config.runninghub.workflows.h3Combat, is_default: 0, sort: 1 },
    { key: 'shotGridApp', name: '分镜网格出图', id: config.runninghub.workflows.shotGridApp, is_default: 0, sort: 2 },
  ]
}

/**
 * 旧库（账号 = qimingxing / runninghub 两厂商）→ 新形态（账号 = text / image / video 三用途通道）的幂等重塑。
 *
 * 为什么是独立函数而非塞进 seed 分支：'seeded' 是「首启 seed 只跑一次」的标记，与「数据形态重塑」是两件事。
 * 真实库 seeded 已为 1，若寄居在 seed 分支内，重塑永远不会执行（抽屉里就补不出 shotGridApp、账号也仍是旧键）。
 * 独立函数可重复执行、不依赖 seeded、也不改写 seeded 的既有语义。
 *
 * 幂等性：以元标记 'channels_v2' 限定「一次性补齐」只发生一次；所有写入用 INSERT OR IGNORE / 按存在性判断，
 * 重复执行结果一致。
 * 断言式保护：遇到不属于 {qimingxing, runninghub, text, image, video} 的未知 account_key，或 kind 无法对应
 * 三通道的行 → 不猜、不静默丢弃，打印明确错误并跳过该行（保留原行不动）。
 */
export function migrateLegacyModelConfig() {
  const done = queryOne("SELECT value FROM ai_model_config_meta WHERE key = 'channels_v2'")
  if (done && String(done.value) === '1') return false

  const accounts = query('SELECT * FROM ai_accounts')
  const entries = query('SELECT * FROM ai_model_entries')
  const seed = channelSeedCredentials()
  let changed = false

  transaction(() => {
    // ① 条目 account_key 按行【自身 kind】改写（text→text / image→image / video→video），不动 is_default。
    for (const e of entries) {
      if (!ACCOUNT_KEYS.includes(e.kind)) {
        console.error(`[modelConfig] 迁移跳过条目 id=${e.id}：kind='${e.kind}' 无法对应 text/image/video 任一通道`)
        continue
      }
      if (!isKnownAccountKey(e.account_key)) {
        console.error(`[modelConfig] 迁移跳过条目 id=${e.id}：未知 account_key='${e.account_key}'，不猜测来源`)
        continue
      }
      if (e.account_key === e.kind) continue
      try {
        execute('UPDATE ai_model_entries SET account_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [e.kind, e.id])
        changed = true
      } catch (err) {
        console.error(`[modelConfig] 迁移条目 id=${e.id} → account_key='${e.kind}' 失败（保留原行）：${err.message}`)
      }
    }

    // ② 未知账号行：仅记录，不动它（既不删也不改名）
    for (const a of accounts) {
      if (!isKnownAccountKey(a.provider_key)) {
        console.error(`[modelConfig] 迁移忽略未知账号 provider_key='${a.provider_key}'（保留原样，未做任何改写）`)
      }
    }

    // ③ 账号重塑：旧 qimingxing 成对有真实值 → text 与 image 两行都沿用它；否则各通道取自己的 seed 源；
    //    video 沿用旧 runninghub 行的值（为空则取 config.runninghub）。已是新形态的行不覆盖（保留用户改动）。
    const byKey = Object.fromEntries(accounts.map((a) => [a.provider_key, a]))
    const qmx = byKey.qimingxing
    const rh = byKey.runninghub
    const qmxPaired = Boolean(qmx && String(qmx.base_url || '').trim() && String(qmx.api_key || '').trim())
    const target = {
      text: qmxPaired ? { base_url: qmx.base_url, api_key: qmx.api_key } : seed.text,
      image: qmxPaired ? { base_url: qmx.base_url, api_key: qmx.api_key } : seed.image,
      video: {
        base_url: (rh && String(rh.base_url || '').trim()) || config.runninghub.baseURL,
        api_key: (rh && String(rh.api_key || '').trim()) || config.runninghub.apiKey,
      },
    }
    for (const k of ACCOUNT_KEYS) {
      if (byKey[k]) continue
      execute(
        'INSERT OR IGNORE INTO ai_accounts (provider_key, name, base_url, api_key, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)',
        [k, ACCOUNT_NAME[k], target[k].base_url || '', target[k].api_key || '']
      )
      changed = true
    }
    const legacyPresent = accounts.some((a) => LEGACY_ACCOUNT_KEYS.includes(a.provider_key))
    if (legacyPresent) {
      execute("DELETE FROM ai_accounts WHERE provider_key IN ('qimingxing', 'runninghub')")
      changed = true
    }

    // ④ 补 video 通道的三条工作流：仅当库里【已有条目】（= 早已 seed 过、seed 分支不会再跑）时补齐缺口。
    //    全新库（无任何条目）交由 seed 一次性写入，避免与此处重复插入撞唯一索引。
    const provisioned = entries.length > 0
    if (provisioned) {
      const existingKeys = new Set(entries.filter((e) => e.kind === 'video').map((e) => e.workflow_key))
      for (const v of videoWorkflowDefs()) {
        const id = String(v.id || '').trim()
        if (!id || existingKeys.has(v.key)) continue
        try {
          insertEntry({ account_key: 'video', kind: 'video', name: v.name, model_id: id, workflow_key: v.key, is_default: 0, sort_order: v.sort })
          changed = true
        } catch (err) {
          console.error(`[modelConfig] 迁移补齐 video 工作流 '${v.key}' 失败：${err.message}`)
        }
      }
      // 已有条目即视为「非首启」：补 seeded 标记，防止随后 seed 分支重复插入同组条目
      execute("INSERT OR REPLACE INTO ai_model_config_meta (key, value) VALUES ('seeded', '1')")
      ensureDefault('video', 'video')
    }

    execute("INSERT OR REPLACE INTO ai_model_config_meta (key, value) VALUES ('channels_v2', '1')")
  })

  if (changed) console.log('[modelConfig] 迁移完成：账号归并为 text/image/video 三通道，条目 account_key 与 video 工作流同步')
  return changed
}

export function initModelConfig() {
  // 迁移必须先于 seeded 检查：真实库 seeded 已为 1，否则账号/条目永远停留在旧形态
  migrateLegacyModelConfig()
  const seeded = queryOne("SELECT value FROM ai_model_config_meta WHERE key = 'seeded'")
  if (!seeded || String(seeded.value) !== '1') {
    transaction(() => {
      const seed = channelSeedCredentials()
      for (const k of ACCOUNT_KEYS) {
        ensureAccount(k, { name: ACCOUNT_NAME[k], ...seed[k] })
      }

      // 文本大模型：1 条，默认项，支持图片输入
      const textModel = String(config.llm.model || '').trim()
      if (textModel) {
        insertEntry({ account_key: 'text', kind: 'text', name: textModel, model_id: textModel, vision: 1, is_default: 1, sort_order: 0 })
      }

      // 生图模型：默认 1 条；QMX_IMAGE_MODELS（逗号分隔）存在时逐条 seed，第一条为默认
      const imageModels = String(process.env.QMX_IMAGE_MODELS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const imageList = imageModels.length ? imageModels : [String(config.image.zikl.model || '').trim()].filter(Boolean)
      imageList.forEach((m, i) => {
        insertEntry({ account_key: 'image', kind: 'image', name: m, model_id: m, is_default: i === 0 ? 1 : 0, sort_order: i })
      })

      // 视频通道：3 条（出片主工作流 + 打斗 + 分镜网格出图）。
      // kind='video' 语义 = RunningHub 工作流（model_id 存 workflow_id、workflow_key 存键名），
      // 分镜网格出图此前只读 .env、不在抽屉里，现并入本条通道统一管理。
      for (const v of videoWorkflowDefs()) {
        const id = String(v.id || '').trim()
        if (!id) continue
        insertEntry({ account_key: 'video', kind: 'video', name: v.name, model_id: id, workflow_key: v.key, is_default: v.is_default, sort_order: v.sort })
      }

      execute("INSERT OR REPLACE INTO ai_model_config_meta (key, value) VALUES ('seeded', '1')")
    })
    console.log('[modelConfig] 首次启动：模型配置已从 .env seed 入库')
  }
  invalidate()
}

// ── 掩码视图（任何接口在任何情况下都不得回传明文 Key）──────────────────────
export function getModelConfig() {
  const { accounts, entries } = getCache()
  const view = (key) => {
    const a = accounts[key]
    return {
      name: (a && a.name) || ACCOUNT_NAME[key] || '',
      base_url: (a && a.base_url) || '',
      api_key: maskKey(a && a.api_key),
    }
  }
  const text = entries.find((e) => e.kind === 'text' && e.account_key === 'text') || entries.find((e) => e.kind === 'text') || null
  // 响应边界显式归一：契约字段（is_default/enabled/vision 布尔、video 的 workflow_id）在此处再保证一次，
  // 不依赖内部缓存形状（mapEntry），避免后续内部重构悄悄破坏对外契约。保留内部字段的超集。
  const viewEntry = (e) => ({
    ...e,
    workflow_id: e.kind === 'video' ? (e.workflow_id || e.model_id || '') : '',
    is_default: !!e.is_default,
    enabled: !!e.enabled,
    vision: !!e.vision,
  })
  const accountsView = {}
  for (const k of ACCOUNT_KEYS) accountsView[k] = view(k)
  return {
    accounts: accountsView,
    // 文本条目的展示名就是实际模型 ID。历史库可能存在 name/model_id 脱节，
    // 对外也必须返回运行时实际采用的值，避免设置页把旧 model_id 写回库。
    text: text ? { id: text.id, model_id: text.name || text.model_id, vision: !!text.vision } : null,
    imageEntries: entries.filter((e) => e.kind === 'image').map(viewEntry),
    videoEntries: entries.filter((e) => e.kind === 'video').map(viewEntry),
    seeded: true,
  }
}

// ── 有效值解析（只读通道账号；运行期不再回退 .env，未配置由消费侧给可读错误）──
// 返回对象额外带 configured 布尔（通道是否已填真实 Key），字段向后兼容保留 apiKey/baseURL/model/vision。
export function getEffectiveLlm() {
  const { accounts, entries } = getCache()
  const acc = accounts.text || {}
  const text = entries.find((e) => e.kind === 'text') || null
  // 文本条目的 name 就是设置页显示和选择的模型 ID。历史版本曾只更新
  // model_id，留下 name=qwen、model_id=deepseek 这种脱节状态，导致请求
  // 发出一个账号根本不支持的 ID。优先使用 name 可自动修复该存量配置。
  const model = text ? String(text.name || text.model_id || '') : ''
  const vision = text ? !!text.vision : true
  return { apiKey: acc.api_key || '', baseURL: acc.base_url || '', model, vision, configured: hasRealKey(acc.api_key) }
}

export function getEffectiveImageAccount() {
  const { accounts } = getCache()
  const acc = accounts.image || {}
  return { baseURL: acc.base_url || '', apiKey: acc.api_key || '', configured: hasRealKey(acc.api_key) }
}

export function getEffectiveRunningHub() {
  const { accounts } = getCache()
  const acc = accounts.video || {}
  return { baseURL: acc.base_url || '', apiKey: acc.api_key || '', configured: hasRealKey(acc.api_key) }
}

// ── 条目查询 ──────────────────────────────────────────────────────────────
function entryById(id) {
  const n = Number(id)
  if (!Number.isInteger(n) || n <= 0) return null
  return getCache().entries.find((e) => e.id === n) || null
}

export function getImageEntry(id) {
  const e = entryById(id)
  return e && e.kind === 'image' ? e : null
}

// 只在启用条目中选默认。全部停用 / 无条目 → 返回 null —— 运行期不再回退 .env 生图通道，
// 由生图消费侧（image.js resolveProvider）给出「请到生图通道配置」的可读错误。
export function getDefaultImageEntry() {
  const images = getCache().entries.filter((e) => e.kind === 'image' && e.enabled)
  return images.find((e) => e.is_default) || images[0] || null
}

// 视频条目 workflow_key → workflow_id；无对应条目（或全部停用）→ 返回空串（不再回退 config.runninghub.workflows）。
// 空 ID 由 runWorkflow() 转成「工作流未配置」可读错误，绝不会把空 workflowId 发出去。
export function resolveWorkflowId(workflowKey) {
  const key = String(workflowKey || '')
  const list = getCache().entries.filter((e) => e.kind === 'video' && e.workflow_key === key && e.enabled)
  const chosen = list.find((e) => e.is_default) || list[0] || null
  return (chosen && chosen.model_id) || ''
}

// 该组【当前生效默认】的条目 id：在启用条目中优先取带 is_default 的，否则取排序最靠前者；
// 无启用条目 → null。取值规则与 getDefaultImageEntry() / resolveWorkflowId() 完全一致，
// 供写路由回传给前端同步，避免「后端已提升到 Y、前端仍显示 X 是默认」的状态漂移。
export function getDefaultEntryId(accountKey, kind) {
  const row = queryOne(
    `SELECT id FROM ai_model_entries
     WHERE account_key = ? AND kind = ? AND enabled = 1
     ORDER BY (is_default = 1) DESC, sort_order ASC, id ASC
     LIMIT 1`,
    [accountKey, kind]
  )
  return row ? Number(row.id) : null
}

// ── 写操作 ────────────────────────────────────────────────────────────────
function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 })
}
function notFound(message = '条目不存在') {
  return Object.assign(new Error(message), { status: 404 })
}
function conflict(message) {
  return Object.assign(new Error(message), { status: 409 })
}

function translateSqliteError(e) {
  const code = e?.code || ''
  const msg = String(e?.message || '')
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/.test(msg)) {
    return conflict('该模型 / 工作流 ID 已存在，请勿重复添加')
  }
  if (code === 'SQLITE_CONSTRAINT_CHECK' || /CHECK constraint failed/.test(msg)) {
    return badRequest('字段取值不合法')
  }
  return e
}

export function saveAccount(key, patch = {}) {
  if (!ACCOUNT_KEYS.includes(key)) throw badRequest('账号 key 无效')
  const fields = []
  const params = []
  if (patch.name != null) { fields.push('name = ?'); params.push(String(patch.name)) }
  if (patch.base_url != null) { fields.push('base_url = ?'); params.push(String(patch.base_url).trim()) }
  // api_key 回传掩码 → 视为「不修改」，跳过该字段
  if (patch.api_key != null && !isMaskedInput(patch.api_key)) { fields.push('api_key = ?'); params.push(String(patch.api_key)) }
  if (!fields.length) return false
  fields.push('updated_at = CURRENT_TIMESTAMP')
  params.push(key)
  execute(`UPDATE ai_accounts SET ${fields.join(', ')} WHERE provider_key = ?`, params)
  invalidate()
  return true
}

export function saveText(patch = {}) {
  const entry = getCache().entries.find((e) => e.kind === 'text')
  if (!entry) throw notFound('文本模型条目不存在')
  const fields = []
  const params = []
  if (patch.model_id != null && String(patch.model_id).trim()) {
    const modelId = String(patch.model_id).trim()
    fields.push('model_id = ?'); params.push(modelId)
    // 文本模型没有独立的展示名：两列必须保持同一模型 ID，避免下次启动再次漂移。
    fields.push('name = ?'); params.push(modelId)
  }
  if (patch.vision != null) { fields.push('vision = ?'); params.push(patch.vision ? 1 : 0) }
  if (patch.name != null) { fields.push('name = ?'); params.push(String(patch.name)) }
  if (!fields.length) return false
  fields.push('updated_at = CURRENT_TIMESTAMP')
  params.push(entry.id)
  execute(`UPDATE ai_model_entries SET ${fields.join(', ')} WHERE id = ?`, params)
  invalidate()
  return true
}

function enabledEntryCount(accountKey, kind) {
  const row = queryOne('SELECT COUNT(*) AS n FROM ai_model_entries WHERE account_key = ? AND kind = ? AND enabled = 1', [accountKey, kind])
  return Number(row?.n) || 0
}

export function addEntry(kind, data = {}) {
  if (kind !== 'image' && kind !== 'video') throw badRequest('kind 必须为 image 或 video')
  // 通道与 kind 一一对应：image 条目必属生图通道，video 条目必属视频通道
  const accountKey = kind
  const name = String(data.name || '').trim()
  const modelId = String((kind === 'video' ? (data.workflow_id ?? data.model_id) : data.model_id) || '').trim()
  const workflowKey = kind === 'video' ? String(data.workflow_key || '').trim() : ''
  if (!name) throw badRequest('name 必填')
  if (!modelId) throw badRequest(kind === 'video' ? 'workflow_id 必填' : 'model_id 必填')
  if (kind === 'video' && !workflowKey) throw badRequest('workflow_key 必填')

  const maxRow = queryOne('SELECT MAX(sort_order) AS m FROM ai_model_entries WHERE account_key = ? AND kind = ?', [accountKey, kind])
  const sortOrder = (maxRow?.m == null ? -1 : Number(maxRow.m)) + 1
  // 新增条目恒为 enabled=1。这里只统计【启用】条目：让「有启用项 ⇒ 恰有一条默认」这条不变式
  // 在「组内只剩停用项时新增」的情形下也成立，避免出现「有启用项却没有任何一行带『默认』徽标」
  // ——徽标直接读 is_default，不读 getDefaultEntryId() 的回退排序，读取侧兜不住 UI。
  const isDefault = enabledEntryCount(accountKey, kind) === 0 ? 1 : 0
  try {
    const info = execute(
      `INSERT INTO ai_model_entries (account_key, kind, name, model_id, workflow_key, vision, is_default, enabled, sort_order)
       VALUES (?, ?, ?, ?, ?, 0, ?, 1, ?)`,
      [accountKey, kind, name, modelId, workflowKey, isDefault, sortOrder]
    )
    invalidate()
    return { id: Number(info.lastInsertRowid), defaultId: getDefaultEntryId(accountKey, kind) }
  } catch (e) {
    throw translateSqliteError(e)
  }
}

// 同组内顺位提升默认项：清掉该组既有 is_default 后，在【启用】条目中取 sort_order ASC, id ASC
// 最小者设为默认。无启用条目 → 该组暂时无默认（不报错），由 getDefaultEntryId()/getDefaultImageEntry()
// 返回 null、生成链路回退 .env。必须在 transaction 内调用。
function promoteNextDefault(accountKey, kind, excludeId = null) {
  execute('UPDATE ai_model_entries SET is_default = 0 WHERE account_key = ? AND kind = ?', [accountKey, kind])
  const row = queryOne(
    'SELECT id FROM ai_model_entries WHERE account_key = ? AND kind = ? AND enabled = 1 AND id != ? ORDER BY sort_order ASC, id ASC LIMIT 1',
    [accountKey, kind, excludeId == null ? 0 : excludeId]
  )
  if (row) execute('UPDATE ai_model_entries SET is_default = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [row.id])
}

function defaultEntryCount(accountKey, kind) {
  const row = queryOne('SELECT COUNT(*) AS n FROM ai_model_entries WHERE account_key = ? AND kind = ? AND is_default = 1', [accountKey, kind])
  return Number(row?.n) || 0
}

// 兜底不变式：只要该组存在 >=1 条启用条目，就必须恰有 1 条 is_default=1。
// 「启用某条」这条写路径单独走不到 promoteNextDefault（后者只在停用默认项/删默认项时触发），
// 所以在「组内原本全停用、def=0」时启用一条，会出现 en=1 但 def=0 —— 抽屉里没有任何一行
// 带「默认」徽标（徽标直接读 is_default，不读 getDefaultEntryId() 的回退排序）。
// 必须在 transaction 内调用；幂等：已有唯一默认或无启用项时直接返回。
function ensureDefault(accountKey, kind, preferId = null) {
  if (enabledEntryCount(accountKey, kind) === 0) return // 无启用项 → 允许零默认
  if (defaultEntryCount(accountKey, kind) === 1) return // 已有唯一默认 → 不动
  if (preferId != null) {
    const prefer = queryOne('SELECT id FROM ai_model_entries WHERE id = ? AND enabled = 1', [preferId])
    if (prefer) {
      execute('UPDATE ai_model_entries SET is_default = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [prefer.id])
      return
    }
  }
  promoteNextDefault(accountKey, kind, null) // 兜底：从启用项里按 sort_order 取最小
}

export function updateEntry(id, patch = {}) {
  const entry = entryById(id)
  if (!entry) throw notFound()
  const fields = []
  const params = []
  if (patch.name != null) { fields.push('name = ?'); params.push(String(patch.name).trim()) }
  if (entry.kind === 'video') {
    const wid = patch.workflow_id != null ? patch.workflow_id : patch.model_id
    if (wid != null) { fields.push('model_id = ?'); params.push(String(wid).trim()) }
    if (patch.workflow_key != null) { fields.push('workflow_key = ?'); params.push(String(patch.workflow_key).trim()) }
  } else if (entry.kind === 'text') {
    if (patch.model_id != null) { fields.push('model_id = ?'); params.push(String(patch.model_id).trim()) }
    if (patch.vision != null) { fields.push('vision = ?'); params.push(patch.vision ? 1 : 0) }
  } else {
    if (patch.model_id != null) { fields.push('model_id = ?'); params.push(String(patch.model_id).trim()) }
  }
  if (patch.enabled != null) { fields.push('enabled = ?'); params.push(patch.enabled ? 1 : 0) }
  const defaultIdOfGroup = () => getDefaultEntryId(entry.account_key, entry.kind)
  // 无字段可改：保持原「未改动」标记，但同样带上 defaultId 供调用方同步
  if (!fields.length) return { ok: false, defaultId: defaultIdOfGroup() }
  // 停用一条【默认】条目 → 必须一并清掉它的 is_default，并在同组启用项中顺位提升，
  // 使 is_default 永远只指向启用项（否则「字段说是默认」与「实际生效默认」静默背离）。
  // 启用一条（patch.enabled 为 true）→ 走下方 ensureDefault() 补默认；改动其它字段 → 不碰 is_default。
  const disablingDefault = patch.enabled === false && entry.is_default
  if (disablingDefault) fields.push('is_default = 0')
  fields.push('updated_at = CURRENT_TIMESTAMP')
  params.push(entry.id)
  try {
    transaction(() => {
      execute(`UPDATE ai_model_entries SET ${fields.join(', ')} WHERE id = ?`, params)
      if (disablingDefault) promoteNextDefault(entry.account_key, entry.kind, entry.id)
      // 启用某条时补默认：组内原本全停用(def=0) → 启用后 en=1 却 def=0 的缺口在此补齐；
      // 停用路径下本句为幂等 no-op（要么已有默认、要么该组已无启用项），故保留上面两层逻辑。
      if (patch.enabled != null) ensureDefault(entry.account_key, entry.kind, patch.enabled ? entry.id : null)
    })
    invalidate()
    return { ok: true, defaultId: defaultIdOfGroup() }
  } catch (e) {
    throw translateSqliteError(e)
  }
}

export function deleteEntry(id) {
  const entry = entryById(id)
  if (!entry) throw notFound()
  transaction(() => {
    const rows = query(
      'SELECT id, is_default FROM ai_model_entries WHERE account_key = ? AND kind = ? ORDER BY sort_order ASC, id ASC',
      [entry.account_key, entry.kind]
    )
    if (rows.length <= 1) throw conflict('至少保留一条，不能删除该分类下的最后一条记录')
    execute('DELETE FROM ai_model_entries WHERE id = ?', [entry.id])
    // 删除的是默认项 → 在【启用】条目中顺位提升 sort_order 最小者（不得提升停用项，
    // 否则 is_default 会再次落到停用条目上）。
    if (entry.is_default) promoteNextDefault(entry.account_key, entry.kind, entry.id)
  })
  invalidate()
  return { ok: true, defaultId: getDefaultEntryId(entry.account_key, entry.kind) }
}

export function setDefault(id) {
  const entry = entryById(id)
  if (!entry) throw notFound()
  transaction(() => {
    execute('UPDATE ai_model_entries SET is_default = 0 WHERE account_key = ? AND kind = ?', [entry.account_key, entry.kind])
    // 设为默认 = 会被实际使用，故一并置 enabled=1，避免出现「默认项却是停用」的矛盾状态
    execute('UPDATE ai_model_entries SET is_default = 1, enabled = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [entry.id])
  })
  invalidate()
  return true
}

// ── 连通测试（只做轻量鉴权探测，不跑工作流、不消耗计费；超时上限 AbortController）──
async function fetchProbe(url, init) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`请求超时（${Math.round(PROBE_TIMEOUT_MS / 1000)}s）`)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

// 文本 / 生图通道共用（都走 OpenAI 兼容协议）。GET /v1/models 只能证明账号能列模型，
// 最终结果必须由一次短对话确认，否则「连接成功」仍可能在真正生成时返回空正文。
async function testOpenAICompatibleChannel(accountKey, label, model) {
  const acc = getCache().accounts[accountKey] || {}
  const baseURL = String(acc.base_url || '')
  const apiKey = String(acc.api_key || '')
  if (!hasRealKey(baseURL)) return { ok: false, latencyMs: null, message: `${label} Base URL 未配置（请在「AI 模型配置」填写）` }
  if (!hasRealKey(apiKey)) return { ok: false, latencyMs: null, message: `${label} API Key 未配置（请在「AI 模型配置」填写）` }
  const startedAt = Date.now()
  let modelsStatus = null
  try {
    const res = await fetchProbe(openaiModelsUrl(baseURL), {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    modelsStatus = res.status
  } catch {
    // 列模型失败时仍尝试对话；部分兼容网关只实现 chat/completions。
  }
  if (!hasRealKey(model)) {
    return { ok: false, latencyMs: Date.now() - startedAt, message: `${label} 未配置模型 ID，无法做对话探测` }
  }
  const chatStart = Date.now()
  try {
    const endpoint = openaiChatUrl(baseURL)
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }
    const request = (disableThinking) => fetchProbe(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: '只回复 OK，不要解释。' }],
        max_tokens: PROBE_MAX_TOKENS,
        temperature: 0,
        ...(disableThinking ? { enable_thinking: false } : {}),
      }),
    })
    let res = await request(true)
    let text = ''
    if (!res.ok) text = await res.text().catch(() => '')
    // 某些 DeepSeek 兼容网关强制开启思考：去掉参数后再验证一次正文能力。
    if (!res.ok && /enable_thinking parameter is restricted to True/i.test(text)) {
      res = await request(false)
      text = res.ok ? '' : await res.text().catch(() => '')
    }
    const latencyMs = Date.now() - chatStart
    if (!res.ok) {
      return { ok: false, latencyMs, message: `对话通道探测失败 (HTTP ${res.status})${text ? ': ' + text.slice(0, 200) : ''}` }
    }
    const data = await res.json().catch(() => null)
    const choice = data?.choices?.[0]
    const content = Array.isArray(choice?.message?.content)
      ? choice.message.content.map((p) => typeof p === 'string' ? p : (p?.text || p?.content || '')).join('').trim()
      : String(choice?.message?.content || '').trim()
    if (!content) {
      const finish = String(choice?.finish_reason || '')
      const suffix = finish === 'length' ? '（finish_reason=length，思考阶段可能耗尽输出预算）' : ''
      return { ok: false, latencyMs, message: `${label} 对话返回空正文${suffix}` }
    }
    const modelHint = modelsStatus ? `，模型列表 HTTP ${modelsStatus}` : ''
    return { ok: true, latencyMs, message: `${label} 对话通道已连通（HTTP ${res.status}${modelHint}）` }
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - chatStart, message: `对话通道连通失败: ${e.message}` }
  }
}

async function testVideoChannel() {
  const acc = getCache().accounts.video || {}
  // baseURL 用户不可配，固定读 config（与 runninghub.js 一致）；apiKey 走运行时通道值
  const baseURL = String(acc.base_url || config.runninghub.baseURL || '')
  const apiKey = String(acc.api_key || '')
  if (!hasRealKey(apiKey)) return { ok: false, latencyMs: null, message: '视频通道 API Key 未配置（请在「AI 模型配置」填写）' }
  const startedAt = Date.now()
  const root = String(baseURL || '').replace(/\/+$/, '')
  try {
    // 官方账号信息端点（仅校验鉴权，不跑工作流、不消耗计费）
    const res = await fetchProbe(`${root}/uc/openapi/accountStatus`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ apikey: apiKey }),
    })
    const latencyMs = Date.now() - startedAt
    let jr = null
    try { jr = await res.json() } catch { jr = null }
    if (res.ok && jr && Number(jr.code) === 0) {
      const coins = jr.data?.remainCoins
      return { ok: true, latencyMs, message: `账号已连通${coins != null ? `，剩余额度 ${coins}` : ''}` }
    }
    const detail = jr?.msg || jr?.message || `HTTP ${res.status}`
    return { ok: false, latencyMs, message: `鉴权探测未通过: ${String(detail).slice(0, 200)}` }
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - startedAt, message: `连通失败: ${e.message}` }
  }
}

// target = 通道键（text | image | video）
export async function testConnection(target) {
  if (target === 'text') return testOpenAICompatibleChannel('text', ACCOUNT_NAME.text, getEffectiveLlm().model)
  if (target === 'image') return testOpenAICompatibleChannel('image', ACCOUNT_NAME.image, getDefaultImageEntry()?.model_id || '')
  if (target === 'video') return testVideoChannel()
  throw badRequest('target 必须为 text、image 或 video')
}
