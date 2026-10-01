
import { config } from './config.js'
import { queryOne, query } from './db.js'
import { getEffectiveLlm, getEffectiveRunningHub, resolveWorkflowId } from './modelConfig.js'
import { checkSkillRules, skillRulesVersion } from './ai/skillRules.js'

const OK = 'ok', WARN = 'warn', ERROR = 'error'

function line(status, label, detail) {
  const mark = status === OK ? '✓' : status === WARN ? '⚠' : '✗'
  return { status, label, detail: String(detail || ''), mark }
}

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

  // 文本大模型配置：口径改读运行时（「AI 模型配置」的文本通道），避免 .env 配了但抽屉没配时误报"已就绪"
  safe('文本大模型', () => {
    const l = getEffectiveLlm()
    if (!l.configured) return line(ERROR, '文本大模型', '未配置——请在「AI 模型配置」的「文本通道」填写 API Key（剧本/资产/分镜/回灌翻译全部不可用）')
    let host = String(l.baseURL || '')
    try { host = new URL(l.baseURL).host } catch { /* 非法 URL 时直接展示原值 */ }
    return line(OK, '文本大模型', `${l.model} @ ${host}`)
  })
  safe('RunningHub', () => getEffectiveRunningHub().configured
    ? line(OK, 'RunningHub', 'API Key 已配置（出片/生图可用）')
    : line(ERROR, 'RunningHub', 'API Key 未配置——请在「AI 模型配置」的「视频通道」填写（出片与四宫格出图全部不可用）'))

  safe('出片工作流', () => {
    const engines = [
      ['h3V4vc', '全能V5·SelfLift'],
      ['h3Combat', '打斗'],
    ]
    const missing = engines.filter(([k]) => !String(resolveWorkflowId(k) || '').trim()).map(([, name]) => name)
    return missing.length
      ? line(ERROR, '出片工作流', `以下引擎工作流未在「AI 模型配置」的「视频通道」启用：${missing.join('、')}`)
      : line(OK, '出片工作流', `2 套引擎齐备（${engines.map(([, n]) => n).join('/')}）`)
  })

  safe('告警通道', () => {
    const t = queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='system_alerts'")
    if (!t) return line(ERROR, '告警通道', 'system_alerts 表不存在——出片钩子失败将无可见告警，重跑 db.js 迁移')
    const unresolved = queryOne("SELECT COUNT(*) AS n FROM system_alerts WHERE (resolved_at IS NULL OR resolved_at = '')")
    const n = Number(unresolved?.n) || 0
    return n > 0
      ? line(WARN, '告警通道', `就绪；当前有 ${n} 条未处置告警待查（成片页顶部可看明细）`)
      : line(OK, '告警通道', '就绪；当前无未处置告警')
  })

  safe('数据库', () => {
    const tables = query("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name)
    const need = ['projects', 'episodes', 'shots', 'storyboard_scenes', 'characters', 'scenes', 'props']
    const miss = need.filter((t) => !tables.includes(t))
    return miss.length
      ? line(ERROR, '数据库', `缺表：${miss.join('、')}`)
      : line(OK, '数据库', `${tables.length} 张表就绪`)
  })

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

  safe('Skill 规则源（xiaomo-film-studio）', () => {
    const problems = checkSkillRules()
    const ver = skillRulesVersion()
    return problems.length
      ? line(ERROR, 'Skill 规则源', `规则不可用（分镜/资产生成将拒绝工作，不会退回旧规则）：${problems.join('、')}`)
      : line(OK, 'Skill 规则源', `v${ver || '(未版本化)'} 三份规则齐备，指纹一致 @ ${config.skill.rulesPath}`)
  })

  return results
}


export function printBootReport(results, { log = console.log } = {}) {
  const has = (s) => results.filter((r) => r.status === s).length
  const errN = has(ERROR), warnN = has(WARN)
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
