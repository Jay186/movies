// 版本化落库路径：手动编辑入版本链、删除前快照（可恢复）、无变化不产冗余版本、清空分镜删除前快照
// 覆盖 auto-snapshot / forceSnapshotShot 两条真实代码路径（经 POST/PUT 路由直调，不复制源码）
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { useTempDb, createCaller, seedBaseRows, SHOT_COMMON } from './helpers.mjs'

// ⚠️ 必须在任何 server 模块 import 之前调用（config.js 模块加载时固化 db.path）
const tmp = useTempDb('version-shots')

describe('版本化落库路径', () => {
  let call, query, queryOne, execute, s1, s2

  before(async () => {
    const dbMod = await import('../db.js')
    dbMod.initDB()
    ;({ query, queryOne, execute } = dbMod)
    const router = (await import('../routes/episodes.js')).default
    ;({ call } = createCaller(router))
    seedBaseRows(dbMod, { projectTitle: '版本落库验证项目' })

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
    s2 = queryOne("SELECT * FROM shots WHERE shot_number = '1-2'")
    assert.ok(s1 && s2, '两镜未就位')
  })

  after(async () => { await tmp.cleanup() })

  test('首次整场保存不产生版本（新建镜头无旧值可快照）', () => {
    const n = query('SELECT COUNT(*) AS n FROM shot_versions WHERE shot_id IN (?, ?)', [s1.id, s2.id])[0]?.n
    assert.equal(n, 0, `首存不应有版本，实得 ${n}`)
  })

  test('普通编辑无实质变化：不产生冗余版本', async () => {
    const beforeCount = query('SELECT COUNT(*) AS n FROM shot_versions WHERE shot_id = ?', [s1.id])[0]?.n || 0
    const r = await call('put', '/:id/shots/:shotId', { id: '1', shotId: String(s1.id) }, {
      duration: s1.duration,
      description: s1.description,
    })
    assert.equal(r.statusCode, 200, JSON.stringify(r.body))
    const afterCount = query('SELECT COUNT(*) AS n FROM shot_versions WHERE shot_id = ?', [s1.id])[0]?.n || 0
    assert.equal(beforeCount, 0)
    assert.equal(afterCount, 0, `无变化却产生了版本，实得 ${afterCount}`)
    assert.equal(queryOne('SELECT version FROM shots WHERE id = ?', [s1.id])?.version, 1)
  })

  test('普通编辑有实质变化：旧值入版本表、版本号递增、edited_by 标记 manual', async () => {
    const cur = queryOne('SELECT * FROM shots WHERE id = ?', [s1.id])
    const r = await call('put', '/:id/shots/:shotId', { id: '1', shotId: String(s1.id) }, { description: '@一二，立在客厅窗边远眺，夜色沉沉' })
    assert.equal(r.statusCode, 200, JSON.stringify(r.body))
    const row = queryOne('SELECT version, description, edited_by FROM shots WHERE id = ?', [s1.id])
    assert.equal(row?.description, '@一二，立在客厅窗边远眺，夜色沉沉')
    assert.equal(row?.version, (cur?.version || 1) + 1, `${cur?.version} -> ${row?.version}`)
    assert.equal(row?.edited_by, 'manual')
    const snaps = query("SELECT * FROM shot_versions WHERE shot_id = ? AND reason = 'manual_edit'", [s1.id])
    assert.equal(snaps.length, 1, `manual_edit 快照数 ${snaps.length}`)
    assert.equal(JSON.parse(snaps[0].snapshot).description, cur?.description)
  })

  test('整场重存裁剪镜头：删除前自动快照（reason=save_prune，含原描述与镜号）', async () => {
    // 只提交第一镜（内容 = 测试3 改后的描述）→ 第二镜被裁剪，应留下删除前快照
    const s2Cur = queryOne('SELECT * FROM shots WHERE id = ?', [s2.id])
    assert.ok(s2Cur, '第二镜应在位')
    const scenesV2 = [{
      title: '客厅',
      shots: [
        { ...SHOT_COMMON, duration: 5, startTime: 0, endTime: 5, description: '@一二，立在客厅窗边远眺，夜色沉沉', finalFrame: '@一二，背对镜头立于窗前', dialogue: [] },
      ],
    }]
    const r = await call('post', '/:id/storyboard', { id: '1' }, { storyboardScenes: scenesV2, storyboard_source: 'generated' })
    assert.equal(r.body?.success, true, `body=${JSON.stringify(r.body)} status=${r.statusCode}`)
    const all = query('SELECT id, shot_number, description FROM shots ORDER BY id')
    assert.equal(all.length, 1, `镜头数应裁剪到 1，实得 ${JSON.stringify(all)}`)
    // 内容精确匹配 → 保留的是内容为「夜色沉沉」的既有第一镜，被裁剪的是第二镜
    assert.equal(all[0]?.id, s1.id, `保留镜头应为第一镜，实得 ${JSON.stringify(all)}`)

    const snaps = query("SELECT * FROM shot_versions WHERE shot_id = ? AND reason = 'save_prune'", [s2.id])
    assert.equal(snaps.length, 1, `save_prune 快照数 ${snaps.length}`)
    const snap = JSON.parse(snaps[0].snapshot)
    assert.equal(snap.id, s2.id)
    assert.equal(snap.description, s2Cur.description, '快照未保留删除前描述')
    assert.equal(snap.shot_number, '1-2')
    assert.equal(snaps[0].shot_number, '1-2', '版本行冗余镜号未写入')
    assert.equal(snaps[0].episode_id, 1)
  })

  test('save_prune 快照可完整还原被裁剪镜头的字段', () => {
    const snaps = query("SELECT * FROM shot_versions WHERE shot_id = ? AND reason = 'save_prune'", [s2.id])
    const snap = JSON.parse(snaps[0].snapshot)
    for (const k of ['id', 'storyboard_scene_id', 'shot_number', 'duration', 'description', 'final_frame']) {
      assert.equal(snap[k], s2[k], `还原字段 ${k} 不一致`)
    }
  })

  test('清空分镜：所有镜头删除前快照（reason=storyboard_reset）', async () => {
    const keepRow = queryOne('SELECT * FROM shots ORDER BY id LIMIT 1')
    const r = await call('delete', '/:id/storyboard', { id: '1' }, {})
    assert.equal(r.body?.success, true, JSON.stringify(r.body))
    assert.equal(query('SELECT COUNT(*) AS n FROM shots')[0]?.n, 0, '清空后仍有镜头')
    assert.equal(query('SELECT COUNT(*) AS n FROM storyboard_scenes')[0]?.n, 0, '清空后仍有场次')
    const snaps = query("SELECT * FROM shot_versions WHERE reason = 'storyboard_reset' ORDER BY shot_id")
    assert.ok(snaps.length >= 1, `storyboard_reset 快照数 ${snaps.length}`)
    const kept = snaps.find((v) => v.shot_id === keepRow?.id)
    assert.ok(kept, '清空前仅存镜头未留下 reset 快照')
    assert.equal(JSON.parse(kept.snapshot).description, keepRow?.description)
  })

  test('清空分镜后 episode 分镜标记归位', () => {
    const ep = queryOne('SELECT storyboard_confirmed, storyboard_source, storyboard_script_fp FROM episodes WHERE id = 1')
    assert.equal(ep?.storyboard_confirmed, 0)
    assert.equal(ep?.storyboard_source, 'generated')
    assert.equal(ep?.storyboard_script_fp, null)
  })
})
