// 时轴顺延：改时长自动平移后续镜头（含跨场）、对白绝对秒同步、delta=0 不动、锁定镜 PUT 拒写
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { useTempDb, createCaller, seedBaseRows, SHOT_COMMON } from './helpers.mjs'

// ⚠️ 必须在任何 server 模块 import 之前调用（config.js 模块加载时固化 db.path）
const tmp = useTempDb('timeline-shift')

describe('时轴顺延（编辑侧联动）', () => {
  let call, queryOne, query, execute, s11, s12, s21

  before(async () => {
    const dbMod = await import('../db.js')
    dbMod.initDB()
    ;({ queryOne, query, execute } = dbMod)
    const router = (await import('../routes/episodes.js')).default
    ;({ call } = createCaller(router))
    seedBaseRows(dbMod, { projectTitle: '顺延验证项目' })
    // 第二场（跨场顺延范围是全集时间轴）
    execute("INSERT INTO scenes (episode_id, scene_number, title, image_url) VALUES (1, 2, '卧室', '/uploads/_t4.png')")

    const scenes = [
      {
        title: '客厅',
        shots: [
          { ...SHOT_COMMON, duration: 5, startTime: 0, endTime: 5, description: '@一二，立在客厅窗边远眺，晨光柔和', finalFrame: '@一二，背对镜头立于窗前', dialogue: [{ character: '一二', tone: '轻快', text: '布布，你看！', startTime: 2.5, endTime: 3.4 }] },
          { ...SHOT_COMMON, duration: 5, startTime: 5, endTime: 10, shotType: '特写', description: '@一二，回身拿起沙发上的布布玩偶端详', finalFrame: '特写：布布玩偶被@一二 的双手托起', propAssets: ['布布玩偶'], dialogue: [{ character: '一二', tone: '温柔', text: '好软呀。', startTime: 7.5, endTime: 8.1 }] },
        ],
      },
      {
        title: '卧室',
        shots: [
          { ...SHOT_COMMON, duration: 5, startTime: 10, endTime: 15, sceneAssets: ['卧室'], description: '@一二，抱着布布玩偶走进卧室，灯光昏黄', finalFrame: '@一二，抱玩偶立于卧室门口', propAssets: ['布布玩偶'], dialogue: [] },
        ],
      },
    ]
    const r = await call('post', '/:id/storyboard', { id: '1' }, { storyboardScenes: scenes, storyboard_source: 'generated' })
    assert.equal(r.body?.success, true, `POST 种子失败: ${JSON.stringify(r.body)}`)
    s11 = queryOne("SELECT * FROM shots WHERE shot_number = '1-1'")
    s12 = queryOne("SELECT * FROM shots WHERE shot_number = '1-2'")
    s21 = queryOne("SELECT * FROM shots WHERE shot_number = '2-1'")
    assert.ok(s11 && s12 && s21, '三镜未就位')
  })

  after(async () => { await tmp.cleanup() })

  test('初始时轴正确', () => {
    assert.equal(s12.start_time, 5)
    assert.equal(s21.start_time, 10)
  })

  test('PUT 拉长 1-1（5→8）：本镜 end 重算，后续镜 +3（含跨场），对白同步平移', async () => {
    const r = await call('put', '/:id/shots/:shotId', { id: '1', shotId: String(s11.id) }, { duration: 8 })
    assert.equal(r.statusCode, 200)
    assert.ok(r.body?.id)

    const a11 = queryOne("SELECT * FROM shots WHERE shot_number = '1-1'")
    const a12 = queryOne("SELECT * FROM shots WHERE shot_number = '1-2'")
    const a21 = queryOne("SELECT * FROM shots WHERE shot_number = '2-1'")
    assert.equal(a11.end_time, 8, `end=${a11.end_time}`)
    assert.equal(a12.start_time, 8)
    assert.equal(a12.end_time, 13)
    assert.equal(a21.start_time, 13, '跨场未顺延')
    assert.equal(a21.end_time, 18)

    const dlg12 = JSON.parse(a12.dialogue || '[]')
    assert.equal(dlg12[0]?.startTime, 10.5, JSON.stringify(dlg12))
    assert.equal(dlg12[0]?.endTime, 11.1, JSON.stringify(dlg12))

    const dlg11 = JSON.parse(a11.dialogue || '[]')
    assert.equal(dlg11[0]?.startTime, 2.5, '本镜对白被误平移')
    assert.equal(dlg11[0]?.endTime, 3.4)
  })

  test('顺延后 QC 无时轴断链错误', () => {
    const all = query("SELECT qc_status, qc_report FROM shots WHERE shot_number IN ('1-1','1-2','2-1')")
    for (const x of all) {
      assert.notEqual(x.qc_status, 'fail', `${x.qc_status}`)
      let items = []
      try { items = JSON.parse(x.qc_report || '{}')?.items || [] } catch {}
      assert.ok(!items.some((it) => it.code === 'TIMELINE_DISCONTINUITY'), '出现时轴断链')
    }
  })

  test('PUT 相同 duration：delta=0 不平移', async () => {
    await call('put', '/:id/shots/:shotId', { id: '1', shotId: String(s11.id) }, { duration: 8 })
    assert.equal(queryOne("SELECT start_time FROM shots WHERE shot_number = '1-2'")?.start_time, 8)
  })

  test('PUT 缩短（8→4）：后续镜 -4', async () => {
    await call('put', '/:id/shots/:shotId', { id: '1', shotId: String(s11.id) }, { duration: 4 })
    assert.equal(queryOne("SELECT end_time FROM shots WHERE shot_number = '1-1'")?.end_time, 4)
    const a12 = queryOne("SELECT start_time, end_time FROM shots WHERE shot_number = '1-2'")
    assert.equal(a12.start_time, 4)
    assert.equal(a12.end_time, 9)
  })

  test('锁定镜 PUT 拒写 / 混合写入拒 / 单独解锁放行 / 解锁后编辑恢复', async () => {
    execute('UPDATE shots SET locked = 1 WHERE id = ?', [s12.id])
    let r = await call('put', '/:id/shots/:shotId', { id: '1', shotId: String(s12.id) }, { description: '试图改锁定镜' })
    assert.equal(r.statusCode, 409)
    assert.equal(queryOne('SELECT description FROM shots WHERE id = ?', [s12.id])?.description, s12.description)

    r = await call('put', '/:id/shots/:shotId', { id: '1', shotId: String(s12.id) }, { locked: 0, description: '混合写入也拒' })
    assert.equal(r.statusCode, 409)

    r = await call('put', '/:id/shots/:shotId', { id: '1', shotId: String(s12.id) }, { locked: 0 })
    assert.equal(r.statusCode, 200)
    assert.equal(r.body?.locked, 0)

    r = await call('put', '/:id/shots/:shotId', { id: '1', shotId: String(s12.id) }, { description: '解锁后可编辑' })
    assert.equal(r.statusCode, 200)
    assert.equal(queryOne('SELECT description FROM shots WHERE id = ?', [s12.id])?.description, '解锁后可编辑')
  })
})
