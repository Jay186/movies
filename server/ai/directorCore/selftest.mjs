/**
 * 导演核 · 离线自验
 * ============================================================================
 * 这个脚本不联网、不调用任何大模型。它证明一件事：
 * **从剧本到镜头序列的全部决定，都可以由确定性规则完成，并且可复现。**
 *
 * 运行： node server/ai/directorCore/selftest.mjs
 */

import { extractStoryboard, renderStoryboardTable, renderReport, renderShotBrief, buildShotExpressionMessages } from './index.js'

/* 终端管道会按本地代码页转码，中文会乱。这里把完整报告同时落一份 UTF-8 文件。 */
import fs from 'node:fs'
const _lines = []
const _log = console.log.bind(console)
console.log = (...a) => { const s = a.join(' '); _lines.push(s); _log(s) }
process.on('exit', () => {
  try { fs.writeFileSync(new URL('./_selftest-report.txt', import.meta.url), _lines.join('\n'), 'utf8') } catch { /* 落盘失败不影响自验 */ }
})
/* 报错也写进报告：终端被转码吞掉时，这是唯一能看见堆栈的地方 */
process.on('uncaughtException', (e) => {
  _lines.push('', '【运行错误】' + (e && e.stack ? e.stack : String(e)))
  try { fs.writeFileSync(new URL('./_selftest-report.txt', import.meta.url), _lines.join('\n'), 'utf8') } catch { /* ignore */ }
  process.exitCode = 1
})

/* ==========================================================================
 * 测试用例：一精写标注本 + 一纯裸本
 * 两种输入都要能跑通，因为真实生产里两者都会遇到。
 * ========================================================================== */

const SCRIPT = `# 场 01 · 珊瑚浅滩 · 傍晚 · 外
@轴线 一二 ←→ 布布
@锚点 礁石群、木栈道
@基调 舒缓 → 紧张
节拍 01 | 一二在浅水里踩水，布布坐在岸边礁石上看着
节拍 02 | 布布发现礁石外涌起的白浪，站起来喊一二
节拍 03 | 一二回头，浪已经拍到脚边
@行动 一二 | 想玩水 | 潮汐 | 相信布布
@行动 布布 | 想护住一二 | 一二玩得太疯 | 出声打断
@道具 竹篮 | 一二
@台词 布布（急）| 一二，回来！

# 场 02 · 木栈道 · 入夜 · 外
一二抱着竹篮跑上栈道，布布在后面追。
布布：慢点！
一二回头笑，脚下一滑，竹篮飞了出去。
`

const ASSETS = {
  characters: [{ name: '一二' }, { name: '布布' }],
  scenes: [{ name: '珊瑚浅滩' }, { name: '木栈道' }],
  props: [{ name: '竹篮' }],
}

/* ==========================================================================
 * 跑
 * ========================================================================== */

const line = (s = '') => console.log(s)
const rule = (t = '') => line(`\n${'─'.repeat(78)}${t ? `\n${t}\n${'─'.repeat(78)}` : ''}`)

rule('【1】剧本层：裸本 → 标注本（确定性推断，不调用模型）')

import { parseScreenplay, renderScreenplay } from './screenplay.js'
const parsed = parseScreenplay(SCRIPT)
for (const s of parsed.scenes) {
  line(`场 ${s.index}　${s.title}　[${s.provenance}]`)
  line(`   空间 ${s.space || '—'} · ${s.timeOfDay || '—'} · ${s.intExt || '—'}`)
  line(`   轴线 ${s.axis?.a || '—'} ←→ ${s.axis?.b || '—'}　(${s.axis?.provenance})`)
  line(`   锚点 ${s.anchors.join('、') || '—'}`)
  line(`   基调 ${s.toneCurve.join(' → ')}`)
  line(`   节拍 ${s.beats.length} 条`)
  for (const b of s.beats) line(`      ${b.index}. ${b.text}　[${b.provenance}]`)
  line(`   道具 ${s.props.map((p) => `${p.name}@${p.owner || '—'}`).join('、') || '—'}`)
  line(`   台词 ${s.lines.map((l) => `${l.character}「${l.text}」`).join('；') || '—'}`)
}

rule('【2】提取分镜（内核全自动，含自检与自动修复）')

const result = extractStoryboard(SCRIPT, {
  style: '吉卜力风格',
  assets: ASSETS,
  profile: 'h3',
  keepEvents: true,
})

/* 事件序列是"切镜决策"的原料。原料错了，后面再对也是错的，所以单独打出来看。 */
line('▸ 观看事件序列（切镜决策的全部原料）')
for (const scene of result.scenes) {
  line(`  场 ${scene.index}：`)
  for (const e of scene._events || []) {
    line(`    ${e.id} 拍${e.beatIndex} [${e.cls}] 主语=${e.subject || '—'} 动词=${e.verb || '—'} 宾语=${e.object || '—'} 半径=${e.radius} 时长=${e.duration}s${e.danger ? ' ⚠危险' : ''}${e.discovery ? ' ◇发现' : ''}  「${e.text}」`)
  }
}
line('')

line(renderStoryboardTable(result))

rule('【3】自检报告')
line('修前：' + renderReport(result.selfCheck.before).split('\n')[0])
line('修后：' + renderReport(result.selfCheck.after).split('\n')[0])
if (result.selfCheck.repairs.length) {
  line('\n自动修复明细：')
  for (const r of result.selfCheck.repairs) line(`  · 场${r.scene} [${r.code}] ${r.action}　—— ${r.reason}`)
} else {
  line('无结构错误，未触发自动修复。')
}
const remaining = result.selfCheck.after.errors
if (remaining.length) {
  line('\n仍需人工判断的硬错误：')
  for (const e of remaining) line(`  · [${e.code}] ${e.shot} ${e.message}`)
}

rule('【4】统计')
line(JSON.stringify(result.stats, null, 2))
if (result.fit) line(`\n目标时长校准：${result.fit.totalBefore}s → ${result.fit.totalAfter}s（目标 ${result.fit.target}s，缩放 ${result.fit.scale}，偏差 ${result.fit.driftAfter.toFixed(1)}%）`)
for (const w of result.warnings) line(`⚠ ${w}`)

rule('【5】可复现性验证（同剧本跑两次，逐字比对）')
const a = JSON.stringify(extractStoryboard(SCRIPT, { style: '吉卜力风格', assets: ASSETS, profile: 'h3' }).scenes)
const b = JSON.stringify(extractStoryboard(SCRIPT, { style: '吉卜力风格', assets: ASSETS, profile: 'h3' }).scenes)
line(a === b ? '✅ 两次运行结果逐字相同 —— 切镜决策完全确定，不受概率影响' : '❌ 两次结果不一致，内核存在不确定性')

rule('【5b】目标时长校准（只微调单镜，绝不删场次）')
const fitDemo = extractStoryboard(SCRIPT, { style: '吉卜力风格', assets: ASSETS, profile: 'h3', targetDuration: 60 })
const f = fitDemo.fit
line(`目标 ${f.target}s：${f.totalBefore}s → ${f.totalAfter}s（缩放 ${f.scale}，动了 ${f.adjusted} 镜，其中 ${f.unreachable} 镜撞到单镜边界夹不动，残留偏差 ${f.driftAfter.toFixed(1)}%）`)
line(`场次数 ${fitDemo.stats.sceneCount} → 与原始一致：${fitDemo.stats.sceneCount === result.stats.sceneCount ? '✅ 一场没删' : '❌ 有场次丢失'}`)

rule('【6】交办单示例（这是唯一交给大模型的东西：它只负责写，不负责决定）')
const s1 = result.scenes[0]
const sample = s1.shots[Math.min(1, s1.shots.length - 1)]
line(renderShotBrief(sample, s1, { style: '吉卜力风格' }))
line('')
line(`交给模型的系统提示词长度：${buildShotExpressionMessages(sample, s1, { style: '吉卜力风格' })[0].content.length} 字`)
line(`（对比：旧内核的单条系统提示词约 6000+ 字，且其中大部分内容是"请你自己判断"）`)

rule('【7】逐镜回执：每个镜头都要能回答"它为什么存在"')
for (const scene of result.scenes) {
  for (const s of scene.shots) {
    const gains = s.cutIn
      ? [...(s.cutIn.dims || []).map((d) => `${d.label}：${d.note}`), ...(s.cutIn.gates || []).map((g) => `${g.label}：${g.note}`)].join(' ／ ')
      : '本场首镜（无切镜收益概念）'
    line(`${s.id}  ${s.duration}s  ${s.framing.size}/${s.framing.angle}/${s.framing.side}`)
    line(`    存在理由：${s.intent}`)
    line(`    运镜理由：${s.movement.motivation}`)
    line(`    切镜理由：${gains}`)
  }
}

line('\n完成。整条内核 0 次网络请求、0 次模型调用。')
