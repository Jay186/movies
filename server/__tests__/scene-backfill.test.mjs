// 场次标题兜底匹配场景资产：backfillSceneByTitle 纯函数 + 保存路径集成
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { useTempDb, createCaller } from './helpers.mjs'

// ⚠️ 必须在任何 server 模块 import 之前调用（config.js 模块加载时固化 db.path）
const tmp = useTempDb('scene-backfill')
// 文件级收尾：两个 describe 共用同一临时库，只在全部用例结束后清理一次
after(async () => { await tmp.cleanup() })

const mk = (sceneAssets) => ({ shotNumber: '1-1', sceneAssets, description: '', finalFrame: '' })

describe('场次标题兜底匹配场景资产', () => {
  let backfillSceneByTitle

  before(async () => {
    ;({ backfillSceneByTitle } = await import('../ai/assetBackfill.js'))
  })

  test('精确匹配', () => {
    const t = mk([]); backfillSceneByTitle(t, '客厅', ['客厅', '街道'])
    assert.equal(t.sceneAssets.join(), '客厅')
  })

  test('包含式匹配（标题带日/夜标记）', () => {
    const t = mk([]); backfillSceneByTitle(t, '客厅-日', ['客厅', '街道'])
    assert.equal(t.sceneAssets.join(), '客厅')
  })

  test('反向包含匹配', () => {
    const t = mk([]); backfillSceneByTitle(t, '客厅', ['城市客厅一角', '街道'])
    assert.equal(t.sceneAssets.join(), '城市客厅一角')
  })

  test('尾缀清洗匹配', () => {
    const t = mk([]); backfillSceneByTitle(t, '黄昏的江边', ['江边渡口', '街道'])
    assert.equal(t.sceneAssets.join(), '江边渡口')
  })

  test('非空不覆盖', () => {
    const t = mk(['已有场景']); backfillSceneByTitle(t, '客厅', ['客厅'])
    assert.equal(t.sceneAssets.join(), '已有场景')
  })

  test('无匹配保持空 / 空标题不炸 / 空场景清单不炸', () => {
    let t = mk([]); backfillSceneByTitle(t, '完全不相关', ['客厅', '街道'])
    assert.equal(t.sceneAssets.length, 0)
    t = mk([]); backfillSceneByTitle(t, '', ['客厅'])
    assert.equal(t.sceneAssets.length, 0)
    t = mk([]); backfillSceneByTitle(t, '客厅', [])
    assert.equal(t.sceneAssets.length, 0)
  })
})

describe('保存路径集成（真实路由处理器）', () => {
  let call, queryOne

  before(async () => {
    const dbMod = await import('../db.js')
    dbMod.initDB()
    const { execute } = dbMod
    ;({ queryOne } = dbMod)
    execute("INSERT INTO projects (id, title, art_style) VALUES (1, '场景兜底验证', '手绘绘本风格')")
    execute("INSERT INTO episodes (id, project_id, script_content) VALUES (1, 1, '')")
    execute("INSERT INTO characters (episode_id, name, image_url) VALUES (1, '一二', '/uploads/_t.png')")
    execute("INSERT INTO scenes (episode_id, scene_number, title, image_url) VALUES (1, 1, '客厅', '/uploads/_t2.png')")
    execute("INSERT INTO props (episode_id, name) VALUES (1, '布布玩偶')")
    const router = (await import('../routes/episodes.js')).default
    ;({ call } = createCaller(router))
  })

  test('场次标题带标记 + 镜头 sceneAssets 为空 → 保存后兜底', async () => {
    const payload = {
      storyboardScenes: [{
        title: '客厅-日',
        shots: [{
          duration: 5, startTime: 0, endTime: 5,
          description: '@一二，立在窗边远眺',
          shotType: '中景', cameraMovement: '缓推', camera_angle: '平视',
          characters: ['一二'], sceneAssets: [], propAssets: [],
          soundEffects: '', overallSoundscape: '安静', nonDiegeticMusic: '',
          integratedMultimodalDescription: 'Medium shot, @一二 by the window.',
          finalFrame: '@一二，立于窗前', isCombat: false,
          purpose: '建立场景', goal: '认识空间', emotionTone: '平静', infoPoints: [],
          worldStateOut: '@一二：画面左·手空·面向窗外',
        }],
      }],
    }
    const r = await call('post', '/:id/storyboard', { id: '1' }, payload)
    assert.equal(r.body?.success, true, JSON.stringify(r.body))
    const row = queryOne("SELECT scene_assets FROM shots WHERE shot_number = '1-1'")
    assert.equal(JSON.parse(row?.scene_assets || '[]').join(), '客厅', row?.scene_assets)
  })
})
