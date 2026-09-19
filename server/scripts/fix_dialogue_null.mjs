// 历史脏数据修复：把 shots.dialogue 里代表"无台词"的非法值（4 字符字符串 "null" 等）
// 统一洗成空串 ''，让库里的数据回到契约形态（JSON 数组 或 空）。
//
// 背景（2026-09-18，第五轮 P0-3）：
//   shots.dialogue 的契约是「JSON 数组 [{character, tone, text, startTime}]」，
//   但写入侧 routes/episodes.js 旧代码 `typeof d === 'object' ? JSON.stringify(d) : ...`
//   因为 typeof null === 'object' 为真，把 LLM 的无台词 null 序列化成了字符串 "null" 落库。
//   第2集 ep4 的 42 镜里有 25 镜是这个值。
//   写入侧已在同轮修好（新数据不会再产生），本脚本只处理**存量脏值**。
//
// 为什么不直接改 data.db：这是写库操作，动的是用户资产，
// 故：**默认 dry-run（只打印，一个字都不写）**，加 --apply 才真写。
//
// 用法：
//   node server/scripts/fix_dialogue_null.mjs                  # dry-run，列出全部待改行
//   node server/scripts/fix_dialogue_null.mjs --episode=4      # 只看第2集
//   node server/scripts/fix_dialogue_null.mjs --apply          # 真写库（不可撤销，会先备份到 _archive_bak）
//
// ⚠️ 洗之前想清楚：有没有"曾经有台词、后来被写成 null"的行？
//   本脚本**只动值为 null / undefined 字面量的行**（它们按契约就是无台词），
//   任何带内容的数组都原样保留 —— 不会丢一句台词。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { initDB, query, execute } from '../db.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ── 参数解析 ─────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const epArg = argv.find((a) => a.startsWith('--episode='))
const ONLY_EPISODE = epArg ? Number(epArg.split('=')[1]) : null
if (epArg && !Number.isFinite(ONLY_EPISODE)) {
  console.error(`[fix-dialogue] --episode 参数不是数字：${epArg}`)
  process.exit(1)
}

// 视为"无台词"的脏值集合：全部是空语义的历史写法，不含任何可能带信息的形态。
const EMPTY_LITERALS = new Set(['null', 'undefined', '[]', ''])

initDB()

// ── 1. 找出脏值行 ───────────────────────────────────────────────────────────
const sql = `
  SELECT s.id, s.shot_number, s.dialogue, s.frame_url, ss.episode_id, ss.scene_number
  FROM shots s
  JOIN storyboard_scenes ss ON ss.id = s.storyboard_scene_id
  ${ONLY_EPISODE != null ? 'WHERE ss.episode_id = ?' : ''}
  ORDER BY ss.episode_id, ss.scene_number, s.start_time, s.id`
const rows = query(sql, ONLY_EPISODE != null ? [ONLY_EPISODE] : [])

const dirty = rows.filter((r) => {
  const v = String(r.dialogue ?? '').trim()
  return v === 'null' || v === 'undefined'
})
// 反向盘点：不属于脏值、也不是合法数组的行（可能有台词但是脏 JSON）——只报告，改前给人看一眼
const suspicious = rows.filter((r) => {
  const v = String(r.dialogue ?? '').trim()
  if (EMPTY_LITERALS.has(v)) return false
  try {
    const p = JSON.parse(v)
    if (Array.isArray(p)) return false
    // 历史单对象也是合法形态（读取侧会包成单元素数组），不算可疑
    return !(p && typeof p === 'object')
  } catch {
    return true // 解析不了的脏 JSON
  }
})

console.log(`=== shots.dialogue 脏值盘点 ===`)
console.log(`  扫描 ${rows.length} 镜${ONLY_EPISODE != null ? `（第${ONLY_EPISODE}集）` : '（全库）'}`)
console.log(`  待洗（"null"/"undefined" 字面量）：${dirty.length} 镜`)

const byEpisode = new Map()
for (const r of dirty) {
  if (!byEpisode.has(r.episode_id)) byEpisode.set(r.episode_id, [])
  byEpisode.get(r.episode_id).push(r)
}
for (const [epId, list] of [...byEpisode.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`\n  ── 第${epId}集：${list.length} 镜`)
  for (const r of list) {
    console.log(`     镜 ${r.shot_number}（场${r.scene_number}，shots.id=${r.id}） 值=${JSON.stringify(r.dialogue)}`)
  }
}

if (suspicious.length) {
  console.log(`\n  ⚠️ 另有 ${suspicious.length} 镜的 dialogue 既非数组也非"null"（脏 JSON / 裸串），本脚本不动它：`)
  for (const r of suspicious.slice(0, 20)) {
    const v = String(r.dialogue ?? '')
    console.log(`     镜 ${r.shot_number}（第${r.episode_id}集 shots.id=${r.id}） 值=${JSON.stringify(v.slice(0, 60))}`)
  }
  if (suspicious.length > 20) console.log(`     ...（其余 ${suspicious.length - 20} 行省略）`)
}

if (!dirty.length) {
  console.log(`\n=== 无需修改，退出 ===`)
  process.exit(0)
}

// ── 2. dry-run vs apply ─────────────────────────────────────────────────────
if (!APPLY) {
  console.log(`\n=== dry-run：以上 ${dirty.length} 行**未做任何修改** ===`)
  console.log(`  确认要洗，重跑加 --apply：`)
  console.log(`    node server/scripts/fix_dialogue_null.mjs${ONLY_EPISODE != null ? ` --episode=${ONLY_EPISODE}` : ''} --apply`)
  process.exit(0)
}

// 写前留一份库快照（一旦改错还能回来）——放 _archive_bak，不污染脚本目录
const DB_PATH = path.join(__dirname, '..', 'data.db')
const ARCHIVE_DIR = path.join(__dirname, '..', '_archive_bak')
if (fs.existsSync(DB_PATH)) {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dest = path.join(ARCHIVE_DIR, `data.db.bak_before_dialogue_null_fix_${stamp}`)
  fs.copyFileSync(DB_PATH, dest)
  console.log(`\n  写前快照：${dest}`)
} else {
  console.warn(`\n  ⚠️ 找不到 ${DB_PATH}，跳过写前快照（仍继续）`)
}

let changed = 0
for (const r of dirty) {
  const res = execute('UPDATE shots SET dialogue = ? WHERE id = ?', ['', r.id])
  changed += Number(res?.changes) || 0
}
console.log(`\n=== --apply 完成：已洗 ${changed}/${dirty.length} 行（dialogue 由 "null" → ''）===`)

// ── 3. 复核 ─────────────────────────────────────────────────────────────────
const remain = query(sql, ONLY_EPISODE != null ? [ONLY_EPISODE] : [])
  .filter((r) => {
    const v = String(r.dialogue ?? '').trim()
    return v === 'null' || v === 'undefined'
  })
console.log(`  复核：剩余脏值行 ${remain.length}`)
