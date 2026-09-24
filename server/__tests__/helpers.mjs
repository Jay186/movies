// 测试共享工具（node:test 基建）
// ⚠️ 本文件不 import 任何 server 模块：config.js 在模块加载时就固化 db.path，
//    所以 DB_PATH 必须在任何 server 模块动态 import 之前设置（各测试文件在顶层调用 useTempDb）
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'

// 把 DB_PATH 指到独立临时库；返回 cleanup（关连接 + 删目录）
// 每个测试文件一个独立进程（node --test 按文件并发），临时目录互不冲突
export function useTempDb(name) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), `drama-${name}-`))
  process.env.DB_PATH = join(dir, 'test.db')
  return {
    dir,
    async cleanup() {
      try {
        const { getDB } = await import('../db.js')
        try { getDB().close() } catch {}
      } catch {}
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
    },
  }
}

// express 路由直调工具：从 router.stack 找真实处理器，mock req/res 直调（绕过 HTTP 层）
export function createCaller(router) {
  function findHandler(method, path) {
    for (const layer of router.stack) {
      if (!layer.route || layer.route.path !== path) continue
      if (!layer.route.methods[method]) continue
      return layer.route.stack[0].handle
    }
    return null
  }
  async function call(method, path, params, body) {
    const handler = findHandler(method, path)
    if (!handler) throw new Error(`route not found: ${method} ${path}`)
    const state = { body: null, sent: false, statusCode: 200 }
    const res = {
      status(c) { state.statusCode = c; return res },
      json(x) { state.body = x; state.sent = true; return res },
    }
    await handler({ params, body, query: {} }, res)
    return state
  }
  return { call, findHandler }
}

// 通用种子（测试夹具）：project/episode/character/scene/prop 各一行
export function seedBaseRows({ execute }, opts = {}) {
  execute('INSERT INTO projects (id, title, art_style) VALUES (1, ?, \'手绘绘本风格\')', [opts.projectTitle || '测试项目'])
  execute("INSERT INTO episodes (id, project_id, script_content) VALUES (1, 1, '')")
  execute("INSERT INTO characters (episode_id, name, image_url) VALUES (1, '一二', '/uploads/_t.png')")
  execute("INSERT INTO scenes (episode_id, scene_number, title, image_url) VALUES (1, 1, '客厅', '/uploads/_t2.png')")
  if (opts.props !== false) {
    execute("INSERT INTO props (episode_id, name, image_url) VALUES (1, '布布玩偶', '/uploads/_t3.png')")
  }
}

// 镜头公共字段（测试夹具，各测试文件按需展开覆盖）
export const SHOT_COMMON = {
  shotType: '中景', cameraMovement: '缓推', camera_angle: '平视',
  characters: ['一二'], sceneAssets: ['客厅'], propAssets: [],
  soundEffects: '', overallSoundscape: '安静的室内环境音', nonDiegeticMusic: '',
  integratedMultimodalDescription: 'Medium shot, @一二 in the living room, soft morning light.',
  isCombat: false,
}
