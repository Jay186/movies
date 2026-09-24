// 叙事四件套 + worldState 派生 + 对白 endTime 的落库往返（INSERT / 整场重存 COALESCE / PUT / GET 驼峰）
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { useTempDb, createCaller, seedBaseRows, SHOT_COMMON } from './helpers.mjs'

// ⚠️ 必须在任何 server 模块 import 之前调用（config.js 模块加载时固化 db.path）
const tmp = useTempDb('narrative')

describe('叙事四件套落库往返', () => {
  let call, queryOne, s1, s2, scenesV1

  before(async () => {
    const dbMod = await import('../db.js')
    dbMod.initDB()
    ;({ queryOne } = dbMod)
    const router = (await import('../routes/episodes.js')).default
    ;({ call } = createCaller(router))
    seedBaseRows(dbMod, { projectTitle: '叙事验证项目' })

    scenesV1 = [{
      title: '客厅',
      shots: [
        {
          ...SHOT_COMMON, duration: 5, startTime: 0, endTime: 5,
          description: '@一二，立在客厅窗边远眺，晨光柔和',
          finalFrame: '@一二，背对镜头立于窗前',
          dialogue: [{ character: '一二', tone: '轻快', text: '布布，你看！', startTime: 2.5, endTime: 3.4 }],
          purpose: '建立空间与人物关系', goal: '观众认识主角与客厅环境',
          emotionTone: '明快温暖', infoPoints: ['窗边站位', '晨光氛围'],
          worldStateOut: '@一二：画面左·手空·面向窗外',
        },
        {
          ...SHOT_COMMON, duration: 5, startTime: 5, endTime: 10,
          shotType: '特写', cameraMovement: '横摇',
          description: '@一二，回身拿起沙发上的布布玩偶端详',
          finalFrame: '特写：布布玩偶被@一二 的双手托起',
          propAssets: ['布布玩偶'],
          purpose: '推进：引入关键道具', goal: '观众注意到玩偶的特殊性',
          emotionTone: '好奇', infoPoints: ['玩偶外观'],
          worldStateOut: '@一二：画面右·双手持@布布玩偶·面向镜头',
        },
      ],
    }]
    const r = await call('post', '/:id/storyboard', { id: '1' }, { storyboardScenes: scenesV1, storyboard_source: 'generated' })
    assert.equal(r.body?.success, true, `POST 种子失败: ${JSON.stringify(r.body)}`)
    s1 = queryOne("SELECT * FROM shots WHERE shot_number = '1-1'")
    s2 = queryOne("SELECT * FROM shots WHERE shot_number = '1-2'")
    assert.ok(s1 && s2, '两镜未就位')
  })

  after(async () => { await tmp.cleanup() })

  test('INSERT 路径：叙事字段全部落库', () => {
    assert.equal(s1?.purpose, '建立空间与人物关系')
    assert.equal(s1?.goal, '观众认识主角与客厅环境')
    assert.equal(s1?.emotion_tone, '明快温暖')
    assert.deepEqual(JSON.parse(s1?.info_points || '[]'), ['窗边站位', '晨光氛围'])
    assert.equal(s1?.world_state_out, '@一二：画面左·手空·面向窗外')
  })

  test('world_state_in 派生：首镜为空，第二镜 = 上一镜 out', () => {
    assert.equal(s1?.world_state_in, '')
    assert.equal(s2?.world_state_in, '@一二：画面左·手空·面向窗外')
  })

  test('对白 endTime 存活 + QC 状态已落库', () => {
    const dlg = JSON.parse(s1?.dialogue || '[]')
    assert.equal(dlg[0]?.endTime, 3.4, JSON.stringify(dlg))
    assert.ok(['pass', 'warn', 'fail'].includes(s1?.qc_status), s1?.qc_status)
  })

  test('整场重存缺叙事字段 → COALESCE 保留旧值，描述更新，版本递增', async () => {
    const scenesV2 = JSON.parse(JSON.stringify(scenesV1))
    for (const sc of scenesV2) for (const sh of sc.shots) {
      delete sh.purpose; delete sh.goal; delete sh.emotionTone; delete sh.infoPoints; delete sh.worldStateOut
      sh.description = sh.description + '（重生成版）'
    }
    const r = await call('post', '/:id/storyboard', { id: '1' }, { storyboardScenes: scenesV2 })
    assert.equal(r.body?.success, true, JSON.stringify(r.body).slice(0, 200))

    const s1b = queryOne("SELECT * FROM shots WHERE shot_number = '1-1'")
    assert.equal(s1b?.purpose, '建立空间与人物关系')
    assert.equal(s1b?.world_state_out, '@一二：画面左·手空·面向窗外')
    assert.ok(String(s1b?.description || '').includes('重生成版'))
    assert.ok((s1b?.version || 1) >= 2, String(s1b?.version))

    const s2b = queryOne("SELECT * FROM shots WHERE shot_number = '1-2'")
    assert.equal(s2b?.world_state_in, '@一二：画面左·手空·面向窗外')
  })

  test('PUT 手动编辑单镜叙事字段：目标更新、其他保留、版本递增', async () => {
    const r = await call('put', '/:id/shots/:shotId', { id: '1', shotId: String(s1.id) }, { purpose: '手动改的叙事任务' })
    assert.ok(r.body?.id, JSON.stringify(r.body).slice(0, 150))
    const s1c = queryOne('SELECT * FROM shots WHERE id = ?', [s1.id])
    assert.equal(s1c?.purpose, '手动改的叙事任务')
    assert.equal(s1c?.goal, '观众认识主角与客厅环境')
    assert.equal(s1c?.emotion_tone, '明快温暖')
    assert.ok((s1c?.version || 1) >= 3, String(s1c?.version))
  })

  test('GET 返回驼峰结构：purpose / infoPoints / worldStateIn/Out / 对白 endTime', async () => {
    const r = await call('get', '/:id', { id: '1' }, {})
    const got = r.body?.storyboardScenes?.[0]?.shots?.find((x) => x.shotNumber === '1-1')
    assert.equal(got?.purpose, '手动改的叙事任务', JSON.stringify(got?.purpose))
    assert.ok(Array.isArray(got?.infoPoints) && got.infoPoints.length === 2, JSON.stringify(got?.infoPoints))
    assert.equal(got?.worldStateOut, '@一二：画面左·手空·面向窗外')
    assert.equal(typeof got?.worldStateIn, 'string')
    assert.ok(Array.isArray(got?.dialogue) && got.dialogue[0]?.endTime === 3.4, JSON.stringify(got?.dialogue))
  })
})
