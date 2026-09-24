// 锁定镜头编辑保护：PUT 上锁/解锁、锁定拒写（仅放行单独解锁）、整场重存冻结、GET 透出
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { useTempDb, createCaller, seedBaseRows, SHOT_COMMON } from './helpers.mjs'

// ⚠️ 必须在任何 server 模块 import 之前调用（config.js 模块加载时固化 db.path）
const tmp = useTempDb('locked-put')

describe('锁定镜头编辑保护', () => {
  let call, queryOne, execute, s1

  before(async () => {
    const dbMod = await import('../db.js')
    dbMod.initDB()
    ;({ queryOne, execute } = dbMod)
    const router = (await import('../routes/episodes.js')).default
    ;({ call } = createCaller(router))
    seedBaseRows(dbMod, { projectTitle: '锁定验证项目' })

    const scenes = [{
      title: '客厅',
      shots: [
        { ...SHOT_COMMON, duration: 5, startTime: 0, endTime: 5, description: '@一二，立在客厅窗边远眺，晨光柔和', finalFrame: '@一二，背对镜头立于窗前', dialogue: [] },
        { ...SHOT_COMMON, duration: 5, startTime: 5, endTime: 10, shotType: '特写', description: '@一二，回身拿起沙发上的布布玩偶端详', finalFrame: '特写：布布玩偶被@一二 的双手托起', propAssets: ['布布玩偶'], dialogue: [] },
      ],
    }]
    const r = await call('post', '/:id/storyboard', { id: '1' }, { storyboardScenes: scenes, storyboard_source: 'generated' })
    assert.equal(r.body?.success, true, `POST 种子失败: ${JSON.stringify(r.body)}`)
    s1 = queryOne("SELECT * FROM shots WHERE shot_number = '1-1'")
    assert.ok(s1, '1-1 未落库')
  })

  after(async () => { await tmp.cleanup() })

  test('初始 locked 默认 0', () => {
    assert.equal(s1.locked, 0)
  })

  test('PUT locked=1 上锁：返回体与落库一致', async () => {
    const r = await call('put', '/:id/shots/:shotId', { id: '1', shotId: String(s1.id) }, { locked: 1 })
    assert.ok(r.body?.id, JSON.stringify(r.body))
    assert.equal(r.body?.locked, 1)
    assert.equal(queryOne('SELECT locked FROM shots WHERE id = ?', [s1.id])?.locked, 1)
  })

  test('锁定镜 PUT 内容字段被拒（409，锁定=冻结）', async () => {
    const r = await call('put', '/:id/shots/:shotId', { id: '1', shotId: String(s1.id) }, { description: '@一二，试图改锁定镜' })
    assert.equal(r.statusCode, 409, `status=${r.statusCode}`)
    const cur = queryOne('SELECT locked, description FROM shots WHERE id = ?', [s1.id])
    assert.equal(cur?.description, '@一二，立在客厅窗边远眺，晨光柔和')
    assert.equal(cur?.locked, 1)
  })

  test('锁定镜 PUT 混合写入（解锁+内容）同样被拒', async () => {
    const r = await call('put', '/:id/shots/:shotId', { id: '1', shotId: String(s1.id) }, { locked: 0, description: '混着改' })
    assert.equal(r.statusCode, 409)
    assert.equal(queryOne('SELECT locked FROM shots WHERE id = ?', [s1.id])?.locked, 1)
  })

  test('锁定镜 PUT 仅单独解锁放行', async () => {
    const r = await call('put', '/:id/shots/:shotId', { id: '1', shotId: String(s1.id) }, { locked: 0 })
    assert.equal(r.statusCode, 200)
    assert.equal(queryOne('SELECT locked FROM shots WHERE id = ?', [s1.id])?.locked, 0)
  })

  test('整场重存时锁定镜跳过删除且不被覆盖（同 id、原描述保留）', async () => {
    await call('put', '/:id/shots/:shotId', { id: '1', shotId: String(s1.id) }, { locked: 1 })
    const before = queryOne('SELECT id, description, version FROM shots WHERE shot_number = \'1-1\'')
    // 只重存第二镜（模拟重生成结果整场写回），锁定中的第一镜应被保留
    const scenesV2 = [{
      title: '客厅',
      shots: [
        { ...SHOT_COMMON, duration: 5, startTime: 5, endTime: 10, shotType: '特写', description: '@一二，回身拿起沙发上的布布玩偶端详（重生成版）', finalFrame: '特写：布布玩偶被@一二 的双手托起', propAssets: ['布布玩偶'], dialogue: [] },
      ],
    }]
    const r = await call('post', '/:id/storyboard', { id: '1' }, { storyboardScenes: scenesV2 })
    assert.equal(r.body?.success, true, JSON.stringify(r.body))
    const after = queryOne("SELECT id, description, version FROM shots WHERE shot_number = '1-1'")
    assert.equal(after?.id, before?.id, '锁定镜被删除重建（id 变化）')
    assert.equal(after?.description, '@一二，立在客厅窗边远眺，晨光柔和', '锁定镜描述被重存覆盖')
  })

  test('GET 透出 locked=1', async () => {
    const r = await call('get', '/:id', { id: '1' }, {})
    const allShots = (r.body?.storyboardScenes || []).flatMap((sc) => sc.shots || [])
    const got = allShots.find((x) => String(x.id) === String(s1.id))
    assert.equal(got?.locked, 1)
  })
})
