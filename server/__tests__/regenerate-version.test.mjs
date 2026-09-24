// 单镜 AI 重生成 + 版本链：锁定 409、重写落库、产出物清空、版本快照/列表/回退（可撤销）、404 分支
// LLM 用 globalThis.fetch mock 拦截（不调真 API）；临时库不碰生产库
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { useTempDb, createCaller, seedBaseRows, SHOT_COMMON } from './helpers.mjs'

// ⚠️ 必须在任何 server 模块 import 之前调用（config.js 模块加载时固化 db.path）
const tmp = useTempDb('regen-version')

// mock LLM 响应（doubao.js 运行时走 globalThis.fetch，在动态 import 之前安装）
process.env.DASHSCOPE_API_KEY = 'test-key'
// 测试固定台词语速口径（5 字/秒），不随部署 .env 的 DIALOGUE_SPEECH_RATE_MAX 变化——
// dotenv 不覆盖已存在的 process.env，故必须在 import 任何 server 模块之前设置
process.env.DIALOGUE_SPEECH_RATE_MAX = '5'
const MOCK_SHOT = {
  shotType: '近景',
  startTime: 5,
  cameraMovement: '缓推',
  camera_angle: '正面',
  duration: 5,
  description: '@一二，在客厅窗边轻抚@布布玩偶，神情专注而温柔，晨光洒在侧脸',
  actionNote: '手部轻抚动作特写',
  soundEffects: '布料摩擦声',
  overallSoundscape: '安静室内的钟摆声',
  nonDiegeticMusic: '轻柔钢琴独奏',
  isCombat: false,
  purpose: '深化角色与道具的情感联结',
  goal: '观众感知玩偶的重要性',
  emotionTone: '温柔专注',
  infoPoints: ['玩偶的磨损细节', '窗边站位'],
  worldStateOut: '@一二：画面左·双手持@布布玩偶·面向右',
  dialogue: [{ character: '一二', tone: '轻柔', text: '布布，不怕。', startTime: 6 }],
  characters: ['一二'],
  sceneAssets: ['客厅'],
  propAssets: ['布布玩偶'],
  finalFrame: 'The final frame: @一二 sits at frame left near the window, cradling @布布玩偶 gently in both paws, gazing toward frame right, warm morning light on her cheek.',
  integratedMultimodalDescription: '[Shot 1] 2D hand-drawn style, warm morning light.\n@一二, exactly as shown.\nThe living room remains completely unchanged.\nAt 00:01.000, @一二 strokes @布布玩偶 gently; the doll rests upright in her paws, unchanged.\n@布布玩偶 belongs exclusively to @一二.\nThe final frame: @一二 at frame left cradling the doll, gazing toward frame right.',
}
let llmCallCount = 0
globalThis.fetch = async () => {
  llmCallCount++
  return {
    ok: true, status: 200,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ shot: MOCK_SHOT }) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    }),
  }
}

describe('单镜重生成 + 版本链', () => {
  let call, queryOne, query, execute, s1, s2, shotBefore, shotAfter, versionsBefore, llmCallsBefore

  before(async () => {
    const dbMod = await import('../db.js')
    dbMod.initDB()
    ;({ queryOne, query, execute } = dbMod)
    const router = (await import('../routes/episodes.js')).default
    ;({ call } = createCaller(router))
    seedBaseRows(dbMod, { projectTitle: '重生成验证项目' })

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

  test('三个新路由已注册', async () => {
    const router = (await import('../routes/episodes.js')).default
    const { findHandler } = createCaller(router)
    assert.ok(findHandler('post', '/:id/shots/:shotId/regenerate'), 'regenerate 路由缺失')
    assert.ok(findHandler('get', '/:id/shots/:shotId/versions'), 'versions 路由缺失')
    assert.ok(findHandler('post', '/:id/shots/:shotId/versions/:versionId/restore'), 'restore 路由缺失')
  })

  test('锁定镜拒绝重生成（409 且内容不动）', async () => {
    execute('UPDATE shots SET locked = 1, frame_url = ?, video_url = ? WHERE id = ?', ['/uploads/fake.png', '/uploads/fake.mp4', s2.id])
    const r = await call('post', '/:id/shots/:shotId/regenerate', { id: '1', shotId: String(s2.id) }, { instruction: '更温柔一点' })
    assert.equal(r.statusCode, 409, `status=${r.statusCode}`)
    assert.equal(queryOne('SELECT description FROM shots WHERE id = ?', [s2.id])?.description, s2.description)
    execute('UPDATE shots SET locked = 0 WHERE id = ?', [s2.id])
  })

  test('解锁后正常重生成：内容全量重写、时轴不动、产出物清空、版本递增', async () => {
    shotBefore = queryOne('SELECT * FROM shots WHERE id = ?', [s2.id])
    versionsBefore = query('SELECT COUNT(*) AS n FROM shot_versions WHERE shot_id = ?', [s2.id])[0]?.n || 0
    llmCallsBefore = llmCallCount
    const r = await call('post', '/:id/shots/:shotId/regenerate', { id: '1', shotId: String(s2.id) }, { instruction: '更温柔一点' })
    assert.equal(r.statusCode, 200, `status=${r.statusCode}`)
    assert.equal(r.body?.success, true, JSON.stringify(r.body).slice(0, 200))

    shotAfter = queryOne('SELECT * FROM shots WHERE id = ?', [s2.id])
    assert.ok(llmCallCount > llmCallsBefore, 'fetch mock 未被调用')
    assert.equal(shotAfter?.description, MOCK_SHOT.description)
    assert.equal(shotAfter?.integrated_multimodal_description, MOCK_SHOT.integratedMultimodalDescription)
    assert.equal(shotAfter?.final_frame, MOCK_SHOT.finalFrame)
    assert.equal(shotAfter?.purpose, '深化角色与道具的情感联结')
    assert.equal(shotAfter?.world_state_out, MOCK_SHOT.worldStateOut)
    assert.equal(shotAfter?.duration, 5)
    assert.equal(shotAfter?.start_time, 5)
    assert.equal(shotAfter?.end_time, 10)
    assert.equal(shotAfter?.locked, 0)
    assert.equal(shotAfter?.shot_number, '1-2')
    assert.equal(shotAfter?.frame_url, '')
    assert.equal(shotAfter?.video_url, '')
    assert.equal(shotAfter?.video_generated, 0)
    assert.equal(shotAfter?.version, (shotBefore?.version || 1) + 1, `${shotBefore?.version} -> ${shotAfter?.version}`)
    const dlg = JSON.parse(shotAfter?.dialogue || '[]')
    assert.equal(dlg[0]?.startTime, 6, JSON.stringify(dlg))
    assert.equal(dlg[0]?.endTime, 6.8, JSON.stringify(dlg))
  })

  test('regenerate 前快照已入库（旧内容 + 旧产出物）', () => {
    const snaps = query("SELECT * FROM shot_versions WHERE shot_id = ? AND reason = 'regenerate'", [s2.id])
    assert.equal(snaps.length, 1, `n=${snaps.length}`)
    const snap = snaps[0] ? JSON.parse(snaps[0].snapshot) : {}
    assert.equal(snap.description, shotBefore.description)
    assert.equal(snap.frame_url, '/uploads/fake.png')
  })

  test('版本列表：当前版 + 历史快照倒序', async () => {
    const r = await call('get', '/:id/shots/:shotId/versions', { id: '1', shotId: String(s2.id) }, {})
    assert.equal(r.statusCode, 200)
    assert.ok(Array.isArray(r.body?.versions))
    assert.equal(r.body?.current?.version, shotAfter.version)
    const v = r.body?.versions?.find((x) => x.reason === 'regenerate')
    assert.ok(v, '列表缺 regenerate 快照')
    assert.equal(v?.snapshot?.description, shotBefore.description)
  })

  test('版本回退：内容恢复、产出物恢复、version 再递增、回退本身已快照', async () => {
    const snaps = query("SELECT * FROM shot_versions WHERE shot_id = ? AND reason = 'regenerate'", [s2.id])
    const r = await call('post', '/:id/shots/:shotId/versions/:versionId/restore', { id: '1', shotId: String(s2.id), versionId: String(snaps[0]?.id) }, {})
    assert.equal(r.statusCode, 200, `status=${r.statusCode}`)
    assert.equal(r.body?.success, true)
    const restored = queryOne('SELECT * FROM shots WHERE id = ?', [s2.id])
    assert.equal(restored?.description, shotBefore.description)
    assert.equal(restored?.frame_url, '/uploads/fake.png')
    assert.equal(restored?.video_url, '/uploads/fake.mp4')
    assert.equal(restored?.version, shotAfter.version + 1, `${shotAfter.version} -> ${restored?.version}`)
    assert.equal(query("SELECT * FROM shot_versions WHERE shot_id = ? AND reason = 'version_restore'", [s2.id]).length, 1)
  })

  test('不存在镜头 / 不存在版本返回 404', async () => {
    let r = await call('post', '/:id/shots/:shotId/regenerate', { id: '1', shotId: '99999' }, {})
    assert.equal(r.statusCode, 404)
    r = await call('post', '/:id/shots/:shotId/versions/:versionId/restore', { id: '1', shotId: String(s2.id), versionId: '99999' }, {})
    assert.equal(r.statusCode, 404)
  })
})
