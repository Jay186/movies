// 服务启动自检（2026-09-13）：把「配置类静默降级」在启动瞬间亮出来。
//
// 背景（overview 09-12 实锤）：某次 server 进程带着缺 MC 配置的 env 跑了一整天，
// 28 次出片全部静默降级普通版，无人察觉——因为降级只留一行运行期 console.warn，
// 而「.env 改了 ≠ 跑着的进程知道」（进程级配置无热重载）。当晚只在 index.js 补了 MC 一项自检。
// 本模块把自检扩充为完整健康清单：**开机即亮，缺什么当场喊**，不用翻日志、不用等出片翻车。
//
// 设计原则：
// - 只读不改：本模块绝不修改任何配置或数据，纯粹是「体检报告」；
// - 绝不阻断启动：任何单项检查抛异常都降级成 warn，不能让体检把服务搞挂；
// - 每项都反映真实风险：不写「永远通过」的假检查（那种只会稀释信号）。

import { config } from './config.js'
import { queryOne, query } from './db.js'

// 检查结果三档：ok / warn / error
const OK = 'ok', WARN = 'warn', ERROR = 'error'

function line(status, label, detail) {
  const mark = status === OK ? '✓' : status === WARN ? '⚠' : '✗'
  return { status, label, detail: String(detail || ''), mark }
}

/**
 * 跑一遍全部自检，返回结果数组。每项形如 { status, label, detail, mark }。
 * 单项异常降级为 warn，不影响其它项。
 */
export function runBootChecks() {
  const results = []
  const safe = (label, fn) => {
    try {
      const r = fn()
      results.push(r || line(WARN, label, '检查返回空'))
    } catch (e) {
      results.push(line(WARN, label, `检查本身出错（不影响服务）：${e.message}`))
    }
  }

  // ── 1. 核心服务凭据 ──
  safe('文本大模型', () => config.llm.apiKey
    ? line(OK, '文本大模型', `${config.llm.model} @ ${new URL(config.llm.baseURL).host}`)
    : line(ERROR, '文本大模型', 'API Key 未配置——剧本/资产/分镜/回灌翻译全部不可用'))
  safe('RunningHub', () => config.runninghub.apiKey
    ? line(OK, 'RunningHub', 'API Key 已配置（出片/生图可用）')
    : line(ERROR, 'RunningHub', 'API Key 未配置——出片与生图全部不可用'))

  // ── 2. 观片闸 VLM（"第一观众"，缺失=验收链少一环）──
  safe('观片闸 VLM', () => config.llm.vlmModel
    ? line(OK, '观片闸 VLM', `${config.llm.vlmModel}（出片后自动评审）`)
    : line(WARN, '观片闸 VLM', 'LLM_VLM_MODEL 为空 = 观片闸关闭，出片后无第一观众结论（只剩人工看片）'))

  // ── 3. MC 续镜（接缝连贯命门，2026-09-12 曾整天静默降级）──
  safe('MC 续镜', () => {
    const on = config.runninghub.motionContext?.enabled === true
    const id = String(config.runninghub.workflows?.h3V4mc || '').trim()
    if (!on) return line(WARN, 'MC 续镜', 'RH_MOTION_CONTEXT_ENABLED 非 true = 全片走普通出片，接缝无 MC 锚定（画面/环境音不连贯）')
    if (!id) return line(ERROR, 'MC 续镜', '开关开了但 h3V4mc 工作流 ID 为空 = 全部静默降级普通版！')
    return line(OK, 'MC 续镜', `开启（工作流 ${id}）`)
  })

  // ── 4. 出片工作流 ID（空值 = 该引擎整条不可用）──
  safe('出片工作流', () => {
    const wf = config.runninghub.workflows || {}
    const engines = [
      ['h3V4', '全能V4'],
      ['videoMultiRef', '标准'],
      ['h3StoryboardV2', '增强'],
      ['h3Combat', '打斗'],
    ]
    const missing = engines.filter(([k]) => !String(wf[k] || '').trim()).map(([, name]) => name)
    return missing.length
      ? line(ERROR, '出片工作流', `以下引擎工作流 ID 为空，整条不可用：${missing.join('、')}`)
      : line(OK, '出片工作流', `4 套引擎齐备（${engines.map(([, n]) => n).join('/')}）`)
  })

  // ── 5. 系统告警通道（本次上线，验证表确实建好）──
  safe('告警通道', () => {
    const t = queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='system_alerts'")
    if (!t) return line(ERROR, '告警通道', 'system_alerts 表不存在——出片钩子失败将无可见告警，重跑 db.js 迁移')
    const unresolved = queryOne("SELECT COUNT(*) AS n FROM system_alerts WHERE (resolved_at IS NULL OR resolved_at = '')")
    const n = Number(unresolved?.n) || 0
    return n > 0
      ? line(WARN, '告警通道', `就绪；当前有 ${n} 条未处置告警待查（成片页顶部可看明细）`)
      : line(OK, '告警通道', '就绪；当前无未处置告警')
  })

  // ── 6. 数据库与关键表 ──
  safe('数据库', () => {
    const tables = query("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name)
    const need = ['projects', 'episodes', 'shots', 'storyboard_scenes', 'characters', 'scenes', 'props']
    const miss = need.filter((t) => !tables.includes(t))
    return miss.length
      ? line(ERROR, '数据库', `缺表：${miss.join('、')}`)
      : line(OK, '数据库', `${tables.length} 张表就绪`)
  })

  // ── 7. 画风库英文串覆盖（2026-09-14）──
  // prompt_en 是 H3 出片 prompt 里唯一可用的画风段来源（中文按 AGENTS.md §二 一律丢弃）。
  // 曾经 170 条里 169 条为空，换非「吉卜力风格」的画风立项就静默退化成 label_en 一词锚。
  safe('画风库', () => {
    const total = Number(queryOne('SELECT COUNT(*) AS n FROM style_presets')?.n) || 0
    if (!total) return line(WARN, '画风库', 'style_presets 为空——项目画风取不到描述，只能靠参考图锁画风')
    const miss = Number(queryOne("SELECT COUNT(*) AS n FROM style_presets WHERE prompt_en IS NULL OR TRIM(prompt_en) = ''")?.n) || 0
    if (miss === 0) return line(OK, '画风库', `${total} 条预设英文串齐备（出片 prompt 可取完整画风锚）`)
    const pct = Math.round(((total - miss) / total) * 100)
    return line(
      miss / total > 0.5 ? ERROR : WARN,
      '画风库',
      `${miss}/${total} 条缺英文串（覆盖 ${pct}%）——选中这些画风出片时，画风段只能取英文短标签，画风锚减弱。补齐：node _backfill_style_en.mjs --apply`
    )
  })

  // ── 8. 存量数据概览（顺手把「有多少内容」亮出来，便于判断接下来做什么）──
  safe('内容概览', () => {
    const ep = queryOne('SELECT COUNT(*) AS n FROM episodes')
    const epDone = queryOne('SELECT COUNT(*) AS n FROM episodes WHERE storyboard_confirmed = 1')
    const shots = queryOne('SELECT COUNT(*) AS n FROM shots')
    const vids = queryOne("SELECT COUNT(*) AS n FROM shots WHERE video_url IS NOT NULL AND video_url != '' AND video_generated = 1")
    const nShots = Number(shots?.n) || 0
    const nVids = Number(vids?.n) || 0
    const pct = nShots ? Math.round((nVids / nShots) * 100) : 0
    return line(OK, '内容概览', `${ep?.n || 0} 集（${epDone?.n || 0} 集分镜已确认）/ ${nShots} 镜，已出片 ${nVids} 镜（${pct}%）`)
  })

  return results
}

// 存量的未处置告警（供启动时提示；不改变启动流程）
export function countUnresolvedAlerts() {
  try {
    const r = queryOne("SELECT COUNT(*) AS n FROM system_alerts WHERE (resolved_at IS NULL OR resolved_at = '')")
    return Number(r?.n) || 0
  } catch {
    return 0
  }
}

/** 把自检结果打印成一份紧凑报告 */
export function printBootReport(results, { log = console.log } = {}) {
  const has = (s) => results.filter((r) => r.status === s).length
  const errN = has(ERROR), warnN = has(WARN)
  // 中文按 2 个显示宽度算，否则 padEnd 会错位（终端里中文是双宽字符）
  const dispWidth = (s) => [...String(s)].reduce((w, ch) => w + (/[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1), 0)
  const padTo = (s, width) => String(s) + ' '.repeat(Math.max(0, width - dispWidth(s)))
  const labelW = results.reduce((m, r) => Math.max(m, dispWidth(r.label)), 0) + 2
  log('')
  log('╭─ 启动自检 ──────────────────────────────────')
  for (const r of results) {
    log(`│ ${r.mark} ${padTo(r.label, labelW)}${r.detail}`)
  }
  log('╰─────────────────────────────────────────────')
  if (errN) log(`   ✗ ${errN} 项阻断级问题——这些能力当前不可用，建议先修再出片`)
  else if (warnN) log(`   ⚠ ${warnN} 项提示（不阻断，但会在出片质量上体现）`)
  else log('   全部通过')
  log('')
  return { errN, warnN }
}
