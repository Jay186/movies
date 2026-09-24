// world_state 镜间衔接检查器：出场完整性、快照空缺（混合判定）、侧位一致性（视线锚不掩盖站位冲突）
// + QC 落库链路（rowToShotForQc 字段透传）
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { useTempDb, createCaller, seedBaseRows } from './helpers.mjs'

// ⚠️ 必须在任何 server 模块 import 之前调用（config.js 模块加载时固化 db.path）
const tmp = useTempDb('ws-seam')
// 文件级收尾：纯函数与 DB 两个 describe 共用同一临时库，只在全部用例结束后清理一次
after(async () => { await tmp.cleanup() })

const ASSETS = {
  characters: [{ name: '一二', description: '白色小熊' }, { name: '布哥熊', description: '棕色熊' }],
  scenes: [{ title: '客厅', summary: '客厅' }],
  props: [{ name: '布布玩偶', description: '布玩偶' }],
}

function mkShot(over = {}) {
  return {
    shotNumber: '1-1', shotType: '中景', duration: 5, startTime: 0, endTime: 5,
    description: '@一二，立在客厅窗边远眺，晨光柔和温暖洒进房间',
    characters: ['一二'], sceneAssets: ['客厅'], propAssets: [],
    dialogue: null, integratedMultimodalDescription: 'Medium shot.', finalFrame: 'The final frame: @一二 at frame left.',
    worldStateOut: '@一二：画面左·手空·面向右',
    ...over,
  }
}
const wrap = (shots) => ({ scenes: [{ sceneNumber: 1, title: '客厅', shots }] })
const wsCodes = (qc) => ({
  errors: qc.codedErrors.map((e) => e.code).filter((c) => c.startsWith('WS_')),
  warns: qc.warnings.map((w) => w.code).filter((c) => c.startsWith('WS_')),
})

describe('world_state 衔接检查（纯函数）', () => {
  let validateStoryboard

  before(async () => {
    ;({ validateStoryboard } = await import('../ai/storyboardValidator.js'))
  })

  test('干净镜头：无 WS 报警', () => {
    const ws = wsCodes(validateStoryboard(wrap([mkShot()]), ASSETS, {}))
    assert.equal(ws.errors.length, 0, JSON.stringify(ws))
    assert.equal(ws.warns.length, 0, JSON.stringify(ws))
  })

  test('说话人缺出场状态 → WS_SPEAKER_MISSING error', () => {
    const ws = wsCodes(validateStoryboard(wrap([mkShot({
      dialogue: [{ character: '布哥熊', tone: '轻快', text: '你好呀。', startTime: 2.5, endTime: 3.1 }],
    })]), ASSETS, {}))
    assert.ok(ws.errors.includes('WS_SPEAKER_MISSING'), JSON.stringify(ws))
  })

  test('出场角色缺条目 → WS_CHAR_MISSING warning；关键道具缺条目 → WS_PROP_MISSING warning', () => {
    let ws = wsCodes(validateStoryboard(wrap([mkShot({ characters: ['一二', '布哥熊'] })]), ASSETS, {}))
    assert.ok(ws.warns.includes('WS_CHAR_MISSING'), JSON.stringify(ws))
    ws = wsCodes(validateStoryboard(wrap([mkShot({ propAssets: ['布布玩偶'] })]), ASSETS, {}))
    assert.ok(ws.warns.includes('WS_PROP_MISSING'), JSON.stringify(ws))
  })

  test('侧位冲突（快照左 vs finalFrame 右）→ WS_SIDE_MISMATCH error；视线锚不掩盖站位冲突', () => {
    // "stands at frame right, gazing toward frame left"：站位 frame right 与快照画面左冲突，
    // 视线锚 frame left 不应放行
    let ws = wsCodes(validateStoryboard(wrap([mkShot({
      finalFrame: 'The final frame: @一二 stands at frame right, gazing toward frame left.',
    })]), ASSETS, {}))
    assert.ok(ws.errors.includes('WS_SIDE_MISMATCH'), JSON.stringify(ws))

    // 侧位一致 → 不报
    ws = wsCodes(validateStoryboard(wrap([mkShot({
      finalFrame: 'The final frame: @一二 stands at frame left, gazing toward frame right.',
    })]), ASSETS, {}))
    assert.ok(!ws.errors.includes('WS_SIDE_MISMATCH'), JSON.stringify(ws))

    // 快照右 + finalFrame 右 → 一致
    ws = wsCodes(validateStoryboard(wrap([mkShot({
      worldStateOut: '@一二：画面右·手空·面向左',
      finalFrame: 'The final frame: @一二 stands at frame right, gazing toward frame left.',
    })]), ASSETS, {}))
    assert.ok(!ws.errors.includes('WS_SIDE_MISMATCH'), JSON.stringify(ws))
  })

  test('finalFrame 未提该角色 → 不报侧位', () => {
    const ws = wsCodes(validateStoryboard(wrap([mkShot({
      finalFrame: 'The final frame: a quiet morning room with soft light.',
    })]), ASSETS, {}))
    assert.ok(!ws.errors.includes('WS_SIDE_MISMATCH'), JSON.stringify(ws))
  })

  test('全集无快照（旧分镜）静默；集内混合（有快照+空镜）→ WS_OUT_EMPTY warning', () => {
    let ws = wsCodes(validateStoryboard(wrap([
      mkShot({ worldStateOut: '' }),
      mkShot({ worldStateOut: '', shotNumber: '1-2', startTime: 5, endTime: 10 }),
    ]), ASSETS, {}))
    assert.ok(!ws.warns.includes('WS_OUT_EMPTY'), JSON.stringify(ws))

    ws = wsCodes(validateStoryboard(wrap([
      mkShot({}),
      mkShot({ worldStateOut: '', shotNumber: '1-2', startTime: 5, endTime: 10, dialogue: null }),
    ]), ASSETS, {}))
    assert.ok(ws.warns.includes('WS_OUT_EMPTY'), JSON.stringify(ws))
  })
})

describe('QC 落库链路（rowToShotForQc 字段透传）', () => {
  let call, queryOne

  before(async () => {
    const dbMod = await import('../db.js')
    dbMod.initDB()
    ;({ queryOne } = dbMod)
    seedBaseRows(dbMod, { projectTitle: '衔接验证' })
    const router = (await import('../routes/episodes.js')).default
    ;({ call } = createCaller(router))
  })

  test('POST storyboard 后 qc_report 含 WS_SIDE_MISMATCH 且 qc_status=fail', async () => {
    const c = {
      shotType: '中景', cameraMovement: '缓推', camera_angle: '平视', characters: ['一二'], sceneAssets: ['客厅'], propAssets: [],
      soundEffects: '', overallSoundscape: '安静室内', nonDiegeticMusic: '',
      integratedMultimodalDescription: 'Medium shot, @一二 in the living room, soft morning light, slow push in.',
      isCombat: false,
    }
    const r = await call('post', '/:id/storyboard', { id: '1' }, { storyboardScenes: [{ title: '客厅', shots: [
      { ...c, duration: 5, startTime: 0, endTime: 5, description: '@一二，立在客厅窗边远眺，晨光柔和温暖', finalFrame: 'The final frame: @一二 stands at frame right.', worldStateOut: '@一二：画面左·手空·面向右', dialogue: [] },
    ] }], storyboard_source: 'generated' })
    assert.equal(r.statusCode, 200)
    assert.equal(r.body?.success, true, JSON.stringify(r.body))

    const persisted = queryOne("SELECT qc_status, qc_report FROM shots WHERE shot_number = '1-1'")
    let codes = []
    try { codes = JSON.parse(persisted.qc_report || '{}')?.items?.filter((it) => String(it.code).startsWith('WS_')).map((it) => it.code) || [] } catch {}
    assert.ok(codes.includes('WS_SIDE_MISMATCH'), JSON.stringify(codes))
    assert.equal(persisted.qc_status, 'fail', persisted.qc_status)
  })
})
