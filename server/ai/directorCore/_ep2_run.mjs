/**
 * 把新内核（导演核）跑在第 2 集的真实剧本上。
 * 只读数据库；不写库、不调模型、不花钱。
 */
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseScreenplay } from './screenplay.js'
import { extractStoryboard, renderStoryboardTable } from './index.js'
import { renderReport } from './validators.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const out = []
const p = (s = '') => out.push(String(s))
const flush = () => fs.writeFileSync(path.join(__dirname, '_ep2_storyboard.txt'), out.join('\n'), 'utf8')

try {
  // WAL 库在 readonly 下打不开（需要 -wal/-shm 可写以完成恢复），故正常打开但只执行 SELECT
  const db = new Database(path.join(__dirname, '..', '..', 'data.db'))
  const ep = db.prepare('SELECT * FROM episodes WHERE project_id = 2 AND episode_number = 2').get()
  if (!ep) { p('未找到第 2 集'); flush(); process.exit(0) }

  const chars = db.prepare('SELECT name, name_en, description FROM characters WHERE episode_id = ?').all(ep.id)
  const scns = db.prepare('SELECT title, summary FROM scenes WHERE episode_id = ?').all(ep.id)
  const prps = db.prepare('SELECT name, description FROM props WHERE episode_id = ?').all(ep.id)
  db.close()

  const assets = {
    characters: chars.map((c) => ({ name: c.name })),
    scenes: scns.map((s) => ({ name: s.title })),
    props: prps.map((x) => ({ name: x.name })),
  }

  p('='.repeat(78))
  p(`第 2 集 · 用新内核（导演核）提取分镜    [运行于 ${new Date().toLocaleString('zh-CN')}]`)
  p('='.repeat(78))
  p(`剧本 ${(ep.script_content || '').length} 字　|　资产：角色 ${chars.length} / 场景 ${scns.length} / 道具 ${prps.length}`)
  p(`角色：${chars.map((c) => `${c.name}(${c.name_en})`).join('、')}`)
  p(`场景：${scns.map((s) => s.title).join('、')}`)
  p(`道具：${prps.map((x) => x.name).join('、') || '—'}`)

  /* ---------- 剧本层 ---------- */
  const sp = parseScreenplay(ep.script_content || '')
  p('\n' + '─'.repeat(78))
  p('【剧本层解析结果】')
  p('─'.repeat(78))
  p(`场次数：${sp.scenes.length}`)
  if (sp.settings) {
    p(`\n全片设定（作者已写，直接可用）`)
    p(`  视觉：${(sp.settings.visual || '').slice(0, 200)}`)
    p(`  声音：${(sp.settings.sound || '').slice(0, 200)}`)
    p(`  冲突：${(sp.settings.conflict || '').slice(0, 120)}`)
  }
  if (sp.cast?.length) p(`\n人物表：${sp.cast.map((c) => `${c.name}=${c.desc || ''}`).join('；')}`)
  if (sp.voiceProfiles && Object.keys(sp.voiceProfiles).length) {
    p('\n台词语声档案：')
    for (const [k, v] of Object.entries(sp.voiceProfiles)) p(`  ${k}：${String(v).slice(0, 120)}`)
  }

  p('\n逐场：')
  for (const s of sp.scenes) {
    p(`\n  场 ${s.index}　${s.title}　[${s.provenance}]`)
    p(`    空间 ${s.space || '—'} · ${s.timeOfDay || '—'} · ${s.intExt || '—'}`)
    p(`    景别计划 ${(s.sizePlan || []).join(' → ') || '—'}`)
    p(`    轴线 ${s.axis?.a || '—'} ←→ ${s.axis?.b || '—'}　(${s.axis?.provenance || '-'})`)
    p(`    锚点 ${(s.anchors || []).join('、') || '—'}`)
    p(`    基调 ${(s.toneCurve || []).join(' → ')}`)
    p(`    节拍 ${s.beats.length} 条　钩子 ${(s.hooks || []).length} 处`)
    p(`    台词 ${s.lines.length} 句：${s.lines.map((l) => `${l.character}「${String(l.text).slice(0, 14)}」`).join(' ')}`)
  }
  if (sp.meta?.warnings?.length) {
    p('\n解析告警：')
    for (const w of sp.meta.warnings) p(`  ! ${w}`)
  }

  /* ---------- 分镜 ---------- */
  p('\n' + '─'.repeat(78))
  p('【分镜提取结果】')
  p('─'.repeat(78))
  const result = extractStoryboard(ep.script_content || '', {
    style: sp.settings?.visual?.slice(0, 60) || '',
    assets,
    profile: 'h3',
  })

  p(renderStoryboardTable(result))
  p('\n' + '─'.repeat(78))
  p('【自检】')
  p('─'.repeat(78))
  p('修前：' + renderReport(result.selfCheck.before).split('\n')[0])
  p('修后：' + renderReport(result.selfCheck.after).split('\n')[0])
  if (result.selfCheck.repairs.length) {
    p('自动修复：')
    for (const r of result.selfCheck.repairs) p(`  · 场${r.scene} [${r.code}] ${r.action}`)
  }
  if (result.selfCheck.after.errors.length) {
    p('\n仍需人判断的硬错误：')
    for (const e of result.selfCheck.after.errors) p(`  · [${e.code}] ${e.shot}　${e.message}`)
  }
  if (result.selfCheck.after.warnings.length) {
    p('\n告警：')
    for (const w of result.selfCheck.after.warnings) p(`  · [${w.code}] ${w.shot}　${w.message}`)
  }
  p('\n【统计】')
  p(JSON.stringify(result.stats, null, 2))
  for (const w of result.warnings) p(`\n⚠ ${w}`)
} catch (e) {
  p('\n【运行错误】' + (e && e.stack ? e.stack : e))
}
flush()
