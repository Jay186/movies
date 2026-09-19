// 前端调度正确性验证（QA / 严过关）—— 直接 import 纯函数，不起 dev server
//
// 重点打三处：
//   A. 分组正确、组内按 scene_number 升序（乱序输入验证）
//   B. 任务不丢不重（总数守恒）
//   C. 非 scene 类型（character / prop）并发度必须与改造前一致 —— 本次最大回归面。
//      工程师自述第一版曾错写成「一条全量链」导致 character/prop 退化成全串行，
//      必须确认当前 project.js 里非 scene 分支真的是「每张一条链」。
//
// 只读、零网络、零 AI 费用。可重复运行。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { buildSceneGroupChains } from '../../src/utils/sceneGroupSchedule.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const results = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function record(name, ok, detail = '') {
  results.push({ name, ok })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ::  ${detail}` : ''}\n`)
}

// 复刻真实事故现场：91/92/93 同组 cliff_river；另有一个 cave 组（95/94 乱序）；97 无组
const TARGETS = [
  { id: 93, name: '冰河' },
  { id: 95, name: '洞内深处' },
  { id: 91, name: '雪山边界悬崖' },
  { id: 97, name: '独立空镜' },
  { id: 94, name: '洞口' },
  { id: 92, name: '冰河边断桥' },
]
const GROUP_INFO = {
  91: { group: 'cliff_river', sceneNumber: 91 },
  92: { group: 'cliff_river', sceneNumber: 92 },
  93: { group: 'cliff_river', sceneNumber: 93 },
  94: { group: 'cave', sceneNumber: 94 },
  95: { group: 'cave', sceneNumber: 95 },
  // 97 故意不出现在 groupInfo 里 → 应各成一条链
}

// ── A1 分组正确 ─────────────────────────────────────────────────────────────
{
  const chains = buildSceneGroupChains(TARGETS, GROUP_INFO)
  const byId = (id) => chains.find((c) => c.some((t) => t.id === id))
  const cliff = byId(91)
  const cave = byId(95)
  record('同组场景被分到同一条链（cliff_river 含 91/92/93）',
    cliff.length === 3 && [91, 92, 93].every((id) => cliff.some((t) => t.id === id)),
    `chain=${JSON.stringify(cliff.map((t) => t.id))}`)
  record('不同组不混链（cave 只含 94/95）',
    cave.length === 2 && cave.every((t) => [94, 95].includes(t.id)),
    `chain=${JSON.stringify(cave.map((t) => t.id))}`)
}

// ── A2 组内按 scene_number 升序（输入是乱序的）────────────────────────────────
{
  const chains = buildSceneGroupChains(TARGETS, GROUP_INFO)
  const cliff = chains.find((c) => c.some((t) => t.id === 91))
  const cave = chains.find((c) => c.some((t) => t.id === 95))
  record('cliff_river 组内按场次升序 = [91,92,93]（输入为乱序 93→91→92）',
    JSON.stringify(cliff.map((t) => t.id)) === '[91,92,93]',
    `实际=${JSON.stringify(cliff.map((t) => t.id))}`)
  record('cave 组内按场次升序 = [94,95]（输入为乱序 95→94）',
    JSON.stringify(cave.map((t) => t.id)) === '[94,95]',
    `实际=${JSON.stringify(cave.map((t) => t.id))}`)
}

// ── B 任务不丢不重（总数守恒）────────────────────────────────────────────────
{
  const chains = buildSceneGroupChains(TARGETS, GROUP_INFO)
  const flat = chains.flat()
  record('任务总数守恒（不丢）', flat.length === TARGETS.length, `flat=${flat.length} targets=${TARGETS.length}`)
  const ids = flat.map((t) => t.id).sort((a, b) => a - b)
  record('任务无重复（不重）', new Set(ids).size === ids.length, `ids=${JSON.stringify(ids)}`)
  record('无分组场景（97）未丢失、各成一条链',
    chains.some((c) => c.length === 1 && c[0].id === 97), `chains=${JSON.stringify(chains.map((c) => c.map((t) => t.id)))}`)
}

// ── C 降级：拿不到分组信息 → 一条全量链（全串行），不许崩、不许丢任务 ──────────
{
  for (const gi of [null, undefined, {}]) {
    const chains = buildSceneGroupChains(TARGETS, gi)
    const flat = chains.flat()
    record(`无分组信息(${JSON.stringify(gi)}) → 一条全量链且任务不丢`,
      chains.length === 1 && flat.length === TARGETS.length,
      `chains=${chains.length} flat=${flat.length}`)
  }
  record('空 targets → 空链数组（不返回 [[]]）',
    JSON.stringify(buildSceneGroupChains([], GROUP_INFO)) === '[]' &&
    JSON.stringify(buildSceneGroupChains(null, GROUP_INFO)) === '[]')
}

// ── D 静态源码断言：非 scene 分支必须是「每张一条链」──────────────────────────
{
  const src = readFileSync(path.join(ROOT, 'src/stores/project.js'), 'utf8')
  const lines = src.split('\n')
  // 从头找，或用 fromLine 从指定行之后找（避免匹配到文件中更早的同名判断）
  const lineOf = (needle, fromLine = 0) => {
    for (let i = fromLine; i < lines.length; i += 1) {
      if (lines[i].includes(needle)) return i + 1
    }
    return 0
  }

  const declLine = lineOf('let chains = targets.map((t) => [t])')
  // 必须取 declLine 之后最近的那处 scene 判断，否则会匹配到文件里更早的 `if (type === 'scene')`
  const guardLine = lineOf('if (type === \'scene\') {', declLine)
  const callLine = lineOf('chains = buildSceneGroupChains(targets, groupInfo)')

  record('project.js 存在「默认每张一条链」的声明', declLine > 0, `line=${declLine}`)
  record('该声明在 `if (type === \'scene\')` 之前（即非 scene 类型的默认行为）',
    declLine > 0 && guardLine > 0 && declLine < guardLine, `decl=${declLine} guard=${guardLine}`)
  record('buildSceneGroupChains 只被 scene 分支调用（在 if 之后）',
    callLine > 0 && guardLine > 0 && callLine > guardLine, `call=${callLine} guard=${guardLine}`)

  // 反例检测：绝不允许出现「一条全量链」的写法
  const hasFullChain = /chains\s*=\s*\[targets\]/.test(src) || /chains\s*=\s*\[targets\.slice\(\)\]/.test(src)
  record('未出现「非 scene 退化成一条全量链」的错误写法', !hasFullChain, `matched=${hasFullChain}`)

  // worker 池必须是「逐条取链，链内串行」
  const workerLine = lineOf('const chain = chains[currentIndex++]')
  record('worker 池是「逐条取链」而非按索引分片', workerLine > 0, `line=${workerLine}`)
  const poolLine = lineOf('Math.min(concurrency, chains.length)')
  record('worker 数 = min(concurrency, 链数)', poolLine > 0, `line=${poolLine}`)
}

// ── E 动态模拟 worker 池：验证真实并发度 ─────────────────────────────────────
// 复刻 project.js:2627-2658 的 worker 池算法，量峰值并发
async function simulate(chains, concurrency) {
  let cur = 0
  let peak = 0
  const executed = []
  async function runChain(chain) {
    for (const task of chain) {
      cur += 1; peak = Math.max(peak, cur)
      executed.push(task.id)
      await sleep(12)
      cur -= 1
    }
  }
  let idx = 0
  async function worker() {
    while (idx < chains.length) {
      const chain = chains[idx]; idx += 1
      await runChain(chain)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, chains.length) }, () => worker()))
  return { peak, executed }
}

{
  // character / prop：chains = targets.map(t => [t])，并发度必须 = concurrency(3)
  const charTargets = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }]
  const chains = charTargets.map((t) => [t]) // ← project.js:2611 的真实写法
  const r = await simulate(chains, 3)
  record('character/prop 峰值并发 = 3（与改造前一致，未退化成串行）',
    r.peak === 3, `peak=${r.peak} chains=${chains.length}`)
  record('character/prop 全部任务被执行且不重复',
    r.executed.length === 6 && new Set(r.executed).size === 6, `executed=${JSON.stringify(r.executed)}`)
}

{
  // scene 且拿不到分组 → 一条全量链 → 峰值并发 = 1（有意为之的降级）
  const chains = buildSceneGroupChains(TARGETS, null)
  const r = await simulate(chains, 3)
  record('scene 无分组信息 → 全串行（峰值并发=1，有意的降级）',
    r.peak === 1, `peak=${r.peak} chains=${chains.length}`)
}

{
  // scene 有分组 → 组间并发、组内串行
  const chains = buildSceneGroupChains(TARGETS, GROUP_INFO)
  const r = await simulate(chains, 3)
  // chains: [cliff(3), cave(2), solo(97)] → 3 条链 3 个 worker，峰值可达 3
  record('scene 有分组 → 组间并发（峰值>=2）', r.peak >= 2, `peak=${r.peak} chains=${JSON.stringify(chains.map((c) => c.map((t) => t.id)))}`)
  record('scene 有分组 → 任务不丢不重',
    r.executed.length === TARGETS.length && new Set(r.executed).size === TARGETS.length,
    `executed=${JSON.stringify(r.executed)}`)
  // 链内顺序：cliff 必须是 91→92→93
  const order = r.executed.filter((id) => [91, 92, 93].includes(id))
  record('cliff_river 链内实际执行顺序 = 91→92→93（场次靠前的先定稿当锚）',
    JSON.stringify(order) === '[91,92,93]', `order=${JSON.stringify(order)}`)
}

const failed = results.filter((r) => !r.ok)
process.stdout.write(`\n==== sceneGroupSchedule: ${results.length - failed.length}/${results.length} passed ====\n`)
if (failed.length) {
  process.stdout.write(`FAILED: ${failed.map((f) => f.name).join(', ')}\n`)
  process.exit(1)
}
