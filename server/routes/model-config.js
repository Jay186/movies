import { Router } from 'express'
import {
  ACCOUNT_KEYS,
  getModelConfig,
  saveAccount,
  saveText,
  addEntry,
  updateEntry,
  deleteEntry,
  setDefault,
  testConnection,
} from '../modelConfig.js'
import { fetchModelPlaza } from '../ai/modelPlaza.js'

const router = Router()

function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res)
    } catch (e) {
      const status = Number(e?.status) || 500
      if (status >= 500) console.error('[model-config]', e?.stack || e)
      res.status(status).json({ error: e?.message || '服务错误' })
    }
  }
}

const ENTRY_KINDS = ['image', 'video']

router.get('/', (req, res) => {
  res.json(getModelConfig())
})

// 轻量生图下拉选项：仅启用项，不涉 Key
router.get('/image-models', (req, res) => {
  const list = getModelConfig().imageEntries
    .filter((e) => e.enabled)
    .map((e) => ({ id: e.id, name: e.name, model_id: e.model_id, is_default: !!e.is_default }))
  res.json(list)
})

// 启明星模型广场：供抽屉「从网站拉取模型列表」使用。免鉴权只读，失败不影响手动填写。
router.get('/available-models', handle(async (req, res) => {
  const refresh = req.query?.refresh === '1' || req.query?.refresh === 'true'
  try {
    res.json(await fetchModelPlaza({ refresh }))
  } catch (e) {
    throw Object.assign(new Error(`启明星模型列表获取失败：${e?.message || '未知错误'}`), { status: 502 })
  }
}))

router.put('/account/:key', handle((req, res) => {
  const { key } = req.params
  if (!ACCOUNT_KEYS.includes(key)) throw Object.assign(new Error('账号 key 无效'), { status: 400 })
  const body = req.body || {}
  const patch = {}
  if (body.base_url != null) {
    const v = String(body.base_url).trim()
    if (!v) throw Object.assign(new Error('base_url 不能为空'), { status: 400 })
    patch.base_url = v
  }
  if (body.api_key != null) {
    const v = String(body.api_key)
    // 掩码原样回传 → 视为不修改；显式空串 → 拒绝，避免误清空 Key
    if (!v.includes('••••')) {
      if (!v.trim()) throw Object.assign(new Error('api_key 不能为空'), { status: 400 })
      patch.api_key = v
    }
  }
  if (body.name != null) patch.name = String(body.name)
  saveAccount(key, patch)
  res.json({ ok: true })
}))

router.put('/text', handle((req, res) => {
  const body = req.body || {}
  const patch = {}
  if (body.model_id != null) {
    const v = String(body.model_id).trim()
    if (!v) throw Object.assign(new Error('model_id 不能为空'), { status: 400 })
    patch.model_id = v
  }
  if (body.vision != null) patch.vision = !!body.vision
  saveText(patch)
  res.json({ ok: true })
}))

router.post('/entries', handle((req, res) => {
  const { kind, name, model_id, workflow_id, workflow_key } = req.body || {}
  if (!ENTRY_KINDS.includes(kind)) throw Object.assign(new Error('kind 必须为 image 或 video'), { status: 400 })
  if (!String(name || '').trim()) throw Object.assign(new Error('name 必填'), { status: 400 })
  if (kind === 'video') {
    if (!String(workflow_id || '').trim()) throw Object.assign(new Error('workflow_id 必填'), { status: 400 })
    if (!String(workflow_key || '').trim()) throw Object.assign(new Error('workflow_key 必填'), { status: 400 })
  } else if (!String(model_id || '').trim()) {
    throw Object.assign(new Error('model_id 必填'), { status: 400 })
  }
  const created = addEntry(kind, { name, model_id, workflow_id, workflow_key })
  // 回传统一口径的 defaultId（该组当前生效默认 id），与 PUT/DELETE 一致，前端三条写路径复用同一段同步逻辑
  res.status(201).json({ id: created.id, defaultId: created.defaultId })
}))

router.put('/entries/:id', handle((req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) throw Object.assign(new Error('id 无效'), { status: 400 })
  const body = req.body || {}
  const patch = {}
  if (body.name != null) {
    const v = String(body.name).trim()
    if (!v) throw Object.assign(new Error('name 不能为空'), { status: 400 })
    patch.name = v
  }
  if (body.model_id != null) {
    if (!String(body.model_id).trim()) throw Object.assign(new Error('model_id 不能为空'), { status: 400 })
    patch.model_id = String(body.model_id).trim()
  }
  if (body.workflow_id != null) {
    if (!String(body.workflow_id).trim()) throw Object.assign(new Error('workflow_id 不能为空'), { status: 400 })
    patch.workflow_id = String(body.workflow_id).trim()
  }
  if (body.workflow_key != null) {
    if (!String(body.workflow_key).trim()) throw Object.assign(new Error('workflow_key 不能为空'), { status: 400 })
    patch.workflow_key = String(body.workflow_key).trim()
  }
  if (body.enabled != null) patch.enabled = !!body.enabled
  if (body.vision != null) patch.vision = !!body.vision
  const result = updateEntry(id, patch)
  // 停用默认项会顺位提升同组启用项 → 回传 defaultId 供前端同步本地 is_default
  res.json({ ok: true, defaultId: result.defaultId })
}))

router.delete('/entries/:id', handle((req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) throw Object.assign(new Error('id 无效'), { status: 400 })
  const result = deleteEntry(id)
  // 删除默认项同样会顺位提升 → 回传 defaultId，前端以此为准（不再靠数组顺序猜测）
  res.json({ ok: true, defaultId: result.defaultId })
}))

router.post('/entries/:id/default', handle((req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) throw Object.assign(new Error('id 无效'), { status: 400 })
  setDefault(id)
  // setDefault 会一并启用该项，回传 enabled 供前端同步本地状态，避免「后端已启用、前端仍显示停用」漂移
  res.json({ ok: true, enabled: true })
}))

router.post('/test-connection', handle(async (req, res) => {
  const { target } = req.body || {}
  const result = await testConnection(target)
  res.json(result)
}))

export default router
