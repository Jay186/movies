// QC 状态落库（persistQcToShots 真实模块链路）：fail/warn/pass 分级、豁免回落、幂等、边界
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { useTempDb } from './helpers.mjs'

// ⚠️ 必须在任何 server 模块 import 之前调用（config.js 模块加载时固化 db.path）
const tmp = useTempDb('qc-persist')

describe('QC 状态落库', () => {
  let queryOne, query, execute, persistQcToShots, shotA

  before(async () => {
    const dbMod = await import('../db.js')
    dbMod.initDB()
    ;({ queryOne, query, execute } = dbMod)
    ;({ persistQcToShots } = await import('../routes/qc.js'))

    execute("INSERT INTO projects (id, title, art_style) VALUES (1, 'QC验证项目', '手绘绘本风格')")
    execute("INSERT INTO episodes (id, project_id, script_content) VALUES (1, 1, '')")
    execute("INSERT INTO characters (episode_id, name, image_url) VALUES (1, '一二', '/uploads/_test_char.png')")
    execute("INSERT INTO scenes (episode_id, scene_number, title, image_url) VALUES (1, 1, '客厅', '/uploads/_test_scene.png')")
    execute("INSERT INTO props (episode_id, name, image_url) VALUES (1, '布布玩偶', '/uploads/_test_prop.png')")
    execute("INSERT INTO storyboard_scenes (episode_id, scene_number, title) VALUES (1, 1, '客厅')")
    const sceneId = queryOne('SELECT id FROM storyboard_scenes WHERE episode_id = 1').id

    const BASE = {
      characters: JSON.stringify(['一二']),
      scene_assets: JSON.stringify(['客厅']),
      prop_assets: JSON.stringify([]),
      dialogue: '[]',
      sound_effects: '布料摩擦声',
      overall_soundscape: '安静的室内环境音，远处有钟表滴答',
      action_note: '站立，轻微转头',
    }
    const insertShot = (shotNumber, over = {}) => {
      const cols = { shot_number: shotNumber, duration: 5, ...BASE, ...over }
      const keys = Object.keys(cols)
      execute(
        `INSERT INTO shots (storyboard_scene_id, ${keys.join(', ')}) VALUES (?, ${keys.map(() => '?').join(', ')})`,
        [sceneId, ...keys.map((k) => cols[k])]
      )
      return queryOne('SELECT id FROM shots WHERE shot_number = ?', [shotNumber])
    }

    // A：描述含毒词「照片级」→ STYLE_POISON（ERROR）
    insertShot('1-1', {
      description: '@一二，立在客厅窗边远眺，城市照片级呈现，远处楼群起伏',
      integrated_multimodal_description: '镜头缓缓推进，@一二 立在客厅落地窗前望向远方，晨光柔和，画面明亮温暖，动作节奏平缓',
      final_frame: '@一二，背对镜头立于窗前，窗外是晨雾中的楼群剪影',
      shot_type: '远景', camera_movement: '缓推', camera_angle: '平视', start_time: 0, end_time: 5,
    })
    // B：配乐含抽象情绪词 → MUSIC_MOOD_WORD（WARNING）
    insertShot('1-2', {
      description: '@一二，回到客厅中央，发现布布玩偶的位置变了，停下脚步',
      integrated_multimodal_description: '@一二 缓步走进客厅中央，视线落在沙发上的布布玩偶，脚步停住，缓缓环顾四周，光线略暗',
      final_frame: '@一二，俯身注视沙发上的布布玩偶，眉头微皱，半侧脸面向镜头',
      prop_assets: JSON.stringify(['布布玩偶']),
      shot_type: '中景', camera_movement: '固定', camera_angle: '平视', start_time: 5, end_time: 10,
      non_diegetic_music: '紧张急促的弦乐拨奏',
    })
    // C：干净镜头 → 期望 pass
    insertShot('1-3', {
      description: '特写：@一二 的双手拿起布布玩偶，端详其表情',
      integrated_multimodal_description: '特写镜头横摇，@一二 的双手轻轻托起布布玩偶凑近端详，玩偶表情细节清晰，浅景深',
      final_frame: '特写：布布玩偶被@一二 的双手托在胸前，玩偶脸部正对镜头，浅景深背景虚化',
      prop_assets: JSON.stringify(['布布玩偶']),
      shot_type: '特写', camera_movement: '横摇', camera_angle: '微俯', start_time: 10, end_time: 15,
    })
    shotA = queryOne("SELECT id FROM shots WHERE shot_number = '1-1'")
  })

  after(async () => { await tmp.cleanup() })

  const readStatus = (shotNumber) => {
    const r = queryOne('SELECT qc_status, qc_report FROM shots WHERE shot_number = ?', [shotNumber])
    let report = null
    try { report = JSON.parse(r.qc_report || '') } catch {}
    return { status: r.qc_status, report }
  }
  const codesOf = (entry) => (entry.report?.items || []).map((i) => `${i.code}(${i.level})`)

  test('ERROR 级 → fail（含 STYLE_POISON）；WARNING 级 → warn（含 MUSIC_MOOD_WORD）；干净 → pass', () => {
    persistQcToShots(1)
    const sa = readStatus('1-1'), sb = readStatus('1-2'), sc = readStatus('1-3')
    assert.equal(sa.status, 'fail', codesOf(sa))
    assert.ok((sa.report?.items || []).some((i) => i.code === 'STYLE_POISON' && i.level === 'error'), codesOf(sa))
    assert.equal(sb.status, 'warn', codesOf(sb))
    assert.ok((sb.report?.items || []).some((i) => i.code === 'MUSIC_MOOD_WORD' && i.level === 'warning'), codesOf(sb))
    assert.equal(sc.status, 'pass', `${sc.status} ${codesOf(sc)}`)
    assert.ok([sa, sb, sc].every((e) => e.report && typeof e.report.checkedAt === 'string' && Array.isArray(e.report.items)))
  })

  test('豁免 STYLE_POISON 后：items 消失、状态回落', () => {
    execute('INSERT INTO qc_ignores (episode_id, code, shot_number, shot_id, reason) VALUES (1, ?, ?, ?, ?)', ['STYLE_POISON', '1-1', shotA.id, '验证豁免'])
    persistQcToShots(1)
    const sa2 = readStatus('1-1')
    assert.ok(!(sa2.report?.items || []).some((i) => i.code === 'STYLE_POISON'), codesOf(sa2))
    assert.equal(sa2.status, 'pass', `${sa2.status} ${codesOf(sa2)}`)
  })

  test('幂等：重复执行结果一致', () => {
    const sa2 = readStatus('1-1'), sb = readStatus('1-2')
    persistQcToShots(1)
    const sa3 = readStatus('1-1'), sb3 = readStatus('1-2')
    assert.equal(sa3.status, sa2.status)
    assert.equal(codesOf(sa3).join(), codesOf(sa2).join())
    assert.equal(sb3.status, sb.status)
    assert.equal(codesOf(sb3).join(), codesOf(sb).join())
  })

  test('边界：不存在的集不炸且 persisted=0', () => {
    const r = persistQcToShots(999)
    assert.ok(r && r.persisted === 0, JSON.stringify(r))
  })
})
