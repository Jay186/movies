// 资产存在性守卫：assertAssetsExist 纯函数 + 三个分镜入口的集成拦截
// 背景：原有 assertNotStale 只判「资产是否过期」（指纹为空即放行），
//       导致「角色/道具在、唯独场景为空」时仍能生成分镜，镜头无场景锚且下游静默降级。
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { useTempDb, createCaller } from './helpers.mjs'

// ⚠️ 必须在任何 server 模块 import 之前调用（config.js 模块加载时固化 db.path）
const tmp = useTempDb('asset-guard')
after(async () => { await tmp.cleanup() })

describe('assertAssetsExist 纯函数', () => {
  let assertAssetsExist, execute

  before(async () => {
    const dbMod = await import('../db.js')
    dbMod.initDB()
    ;({ execute } = dbMod)
    ;({ assertAssetsExist } = await import('../ai/guards.js'))
    execute("INSERT INTO projects (id, title, art_style) VALUES (1, '守卫验证', '手绘绘本风格')")
  })

  const seedEpisode = (id, { chars = 1, scenes = 1, props = 1 } = {}) => {
    execute("INSERT INTO episodes (id, project_id, script_content) VALUES (?, 1, '')", [id])
    for (let i = 0; i < chars; i++) execute("INSERT INTO characters (episode_id, name) VALUES (?, ?)", [id, `角色${i}`])
    for (let i = 0; i < scenes; i++) execute("INSERT INTO scenes (episode_id, scene_number, title) VALUES (?, ?, ?)", [id, i + 1, `场景${i}`])
    for (let i = 0; i < props; i++) execute("INSERT INTO props (episode_id, name) VALUES (?, ?)", [id, `道具${i}`])
  }

  // node:assert 的 assert.throws 不返回错误对象，需显式捕获
  const catchErr = (fn) => {
    try { fn() } catch (e) { return e }
    throw new Error('预期抛错但未抛')
  }

  test('三类齐全 → 通过', () => {
    seedEpisode(101)
    assert.doesNotThrow(() => assertAssetsExist(101))
  })

  test('只缺场景（用户实际案例）→ 抛 409 且 missing 含「场景」', () => {
    seedEpisode(102, { scenes: 0 })
    const err = catchErr(() => assertAssetsExist(102))
    assert.equal(err.status, 409)
    assert.equal(err.code, 'ASSETS_MISSING')
    assert.deepEqual(err.missing, ['场景'])
    assert.match(err.message, /缺少场景资产/)
  })

  test('只缺角色 → missing 含「角色」', () => {
    seedEpisode(103, { chars: 0 })
    const err = catchErr(() => assertAssetsExist(103))
    assert.deepEqual(err.missing, ['角色'])
  })

  test('只缺道具 → missing 含「道具」', () => {
    seedEpisode(104, { props: 0 })
    const err = catchErr(() => assertAssetsExist(104))
    assert.deepEqual(err.missing, ['道具'])
  })

  test('三表全空 → missing 三类都有', () => {
    seedEpisode(105, { chars: 0, scenes: 0, props: 0 })
    const err = catchErr(() => assertAssetsExist(105))
    assert.deepEqual(err.missing.sort(), ['场景', '角色', '道具'].sort())
  })

  test('资产不串集：其他集的资产不算本集', () => {
    seedEpisode(106, { chars: 0, scenes: 0, props: 0 })
    seedEpisode(107) // 106 为空，107 齐全
    const err = catchErr(() => assertAssetsExist(106))
    assert.equal(err.status, 409)
    assert.doesNotThrow(() => assertAssetsExist(107))
  })
})

describe('分镜入口集成拦截（真实路由处理器）', () => {
  let call, queryOne, execute

  before(async () => {
    const dbMod = await import('../db.js')
    dbMod.initDB()
    ;({ queryOne, execute } = dbMod)
    execute("INSERT INTO projects (id, title, art_style) VALUES (2, '入口拦截验证', '手绘绘本风格')")
    // 201：只缺场景（复现用户案例）——剧本已确认
    execute("INSERT INTO episodes (id, project_id, script_content, script_confirmed) VALUES (201, 2, '场次1：客厅-日\n@一二 走进来', 1)")
    execute("INSERT INTO characters (episode_id, name) VALUES (201, '一二')")
    execute("INSERT INTO props (episode_id, name) VALUES (201, '布布玩偶')")
    // 202：三类齐全 —— 作为对照组，验证守卫不误伤
    execute("INSERT INTO episodes (id, project_id, script_content, script_confirmed) VALUES (202, 2, '场次1：客厅-日\n@一二 走进来', 1)")
    execute("INSERT INTO characters (episode_id, name) VALUES (202, '一二')")
    execute("INSERT INTO scenes (episode_id, scene_number, title) VALUES (202, 1, '客厅')")
    execute("INSERT INTO props (episode_id, name) VALUES (202, '布布玩偶')")
    // 203：三类全空 + 未确认剧本
    execute("INSERT INTO episodes (id, project_id, script_content, script_confirmed) VALUES (203, 2, '场次1：客厅-日', 0)")
    const router = (await import('../routes/generate-script.js')).default
    ;({ call } = createCaller(router))
  })

  test('/storyboard 只缺场景 → 409 拦截，且不写入分镜', async () => {
    const r = await call('post', '/storyboard', {}, { episodeId: 201 })
    assert.equal(r.statusCode, 409, JSON.stringify(r.body))
    assert.match(r.body.error, /缺少场景资产/)
    const n = queryOne('SELECT count(*) AS n FROM storyboard_scenes WHERE episode_id = 201')
    assert.equal(n.n, 0, '被拦截时不应产生任何分镜场次')
  })

  test('/storyboard-from-file 只缺场景 → 409 拦截', async () => {
    const r = await call('post', '/storyboard-from-file', {}, { episodeId: 201, fileContent: '场次1：客厅-日\n@一二 走进来' })
    assert.equal(r.statusCode, 409, JSON.stringify(r.body))
    assert.match(r.body.error, /缺少场景资产/)
  })

  test('/enrich-storyboard 只缺场景 → 409 拦截（原为零守卫路径）', async () => {
    const r = await call('post', '/enrich-storyboard', {}, { episodeId: 201 })
    assert.equal(r.statusCode, 409, JSON.stringify(r.body))
    assert.match(r.body.error, /缺少场景资产/)
  })

  test('/enrich-storyboard 未确认剧本 → 400 拦截', async () => {
    const r = await call('post', '/enrich-storyboard', {}, { episodeId: 203 })
    assert.equal(r.statusCode, 400, JSON.stringify(r.body))
    assert.match(r.body.error, /确认剧本/)
  })

  test('守卫不误伤：三类齐全时校验放行（不返回 409）', async () => {
    // 用 /enrich-storyboard 验证——它无分镜时返回成功空跑，不会触发 AI 调用
    const r = await call('post', '/enrich-storyboard', {}, { episodeId: 202 })
    assert.notEqual(r.statusCode, 409, JSON.stringify(r.body))
  })
})
