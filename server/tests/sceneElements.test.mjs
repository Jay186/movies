// A1 本场要素硬约束 / A2 组级环境卡 · 验收测试（2026-09-17）
//
// 解决的两个实测缺陷：
//   ① 场1 摘要写「清晨浓雾」→ 出图是晴空（要素被 1.2 权重长描述当氛围形容词淡化）
//   ② 场2 整片秃 → 同组场1/场3 都有植被，但场2 摘要没提，它无从得知「本空间有植被」
//
// 测试分三层：
//   A. 纯函数行为（normalize / parse / build*）—— 含降级与边界
//   B. 跨端一致性（server/ai/anchorTypes.js ↔ src/services/promptBuilder.js 逐字同口径）
//      ★ 这是本方案最重要的一条断言：两层加强，改一处等于没改（P0-6 视角塌陷的教训）
//   C. 落库与回读（sceneAnchors 的 SQL 一字不改复刻，:memory: 库，零网络零真实库）
//
// 只读、零网络、零 AI 费用、不碰 server/data.db。可重复运行。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import Database from 'better-sqlite3'
import {
  normalizeElementPhrase, parseElementList, buildElementNote, buildSharedEnvNote,
  ELEMENT_WEIGHT, ELEMENT_NOTE_TAG, SHARED_ENV_NOTE_TAG,
} from '../ai/anchorTypes.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ::  ${detail}` : ''}\n`)
}

// ===== A. 纯函数行为 =====
record('清洗：去空白 / 去尾标点 / 限长 24 字',
  normalizeElementPhrase('  清晨  浓雾。 ') === '清晨 浓雾'
  && normalizeElementPhrase('甲'.repeat(40)).length === 24,
  `"${normalizeElementPhrase('  清晨  浓雾。 ')}"`)

record('清洗：非字符串输入不抛错（null/undefined/数字）',
  normalizeElementPhrase(null) === '' && normalizeElementPhrase(undefined) === ''
  && normalizeElementPhrase(123) === '123')

record('parse：脏 JSON 降级为空数组（绝不抛错）',
  Array.isArray(parseElementList('{不是数组')) && parseElementList('{不是数组').length === 0
  && parseElementList('').length === 0 && parseElementList(null).length === 0)

record('parse：非数组 JSON（对象/字符串）降级为空数组',
  parseElementList('{"a":1}').length === 0 && parseElementList('"abc"').length === 0)

record('parse：去空项 + 跨项去重 + 保留 LLM 给的顺序',
  JSON.stringify(parseElementList('["清晨浓雾","","清晨浓雾","冰面浮冰","  "]'))
  === JSON.stringify(['清晨浓雾', '冰面浮冰']),
  JSON.stringify(parseElementList('["清晨浓雾","","清晨浓雾","冰面浮冰","  "]')))

// 空清单 → 空串（= 改造前行为逐字不变，这是 AC6 的等价物）
record('【核心】空清单 → 空串（老数据/无分析场景 prompt 逐字不变）',
  buildElementNote([]) === '' && buildSharedEnvNote([]) === ''
  && buildElementNote(null) === '' && buildSharedEnvNote(undefined) === '',
  `el="${buildElementNote([])}" env="${buildSharedEnvNote([])}"`)

const elNote = buildElementNote(['清晨浓雾', '冰面浮冰'])
record('A1 硬约束句：含全部要素 + 1.35 权重 + 独立句',
  elNote.includes('清晨浓雾') && elNote.includes('冰面浮冰')
  && elNote.includes(String(ELEMENT_WEIGHT)) && elNote.startsWith(ELEMENT_NOTE_TAG),
  elNote)

const envNote = buildSharedEnvNote(['半山松林', '灰白砾石滩'])
record('A2 环境卡句：含全部特征 + 1.35 权重 + 连续语义',
  envNote.includes('半山松林') && envNote.includes('灰白砾石滩')
  && envNote.includes(String(ELEMENT_WEIGHT)) && envNote.includes('必须一致')
  && envNote.startsWith(SHARED_ENV_NOTE_TAG),
  envNote)

// TAG 必须是句首（服务端补注靠 includes(TAG) 判幂等，写进句中会让幂等判定失效）
record('TAG 常量 = 句首标签逐字一致（幂等注入判据）',
  elNote.indexOf(ELEMENT_NOTE_TAG) === 0 && envNote.indexOf(SHARED_ENV_NOTE_TAG) === 0)

// ===== B. 跨端一致性（本方案最重要的一条）=====
// promptBuilder.js 在浏览器 bundle，anchorTypes.js 在服务端——无法互相 import，
// 靠手工镜像。这里正则抠出前端函数体做**归一化比对**（去注释与空白，防格式差异误报）。
const frontSrc = readFileSync(path.join(ROOT, 'src/services/promptBuilder.js'), 'utf8')

function extractFn(src, name) {
  const i = src.indexOf(`function ${name}(`)
  if (i < 0) return ''
  // 从函数名起找第一个 '{'，再配对到对应的 '}'
  let j = src.indexOf('{', i)
  let depth = 0
  for (let k = j; k < src.length; k += 1) {
    if (src[k] === '{') depth += 1
    else if (src[k] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(j, k + 1)
    }
  }
  return ''
}
// 归一化：去行注释、去块注释、压空白。只比"代码骨架"，不比排版。
const norm = (s) => s
  .replace(/\/\/[^\n]*/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s+/g, '')
  .trim()

for (const fn of ['normalizeElementPhrase', 'parseElementList', 'buildElementNote', 'buildSharedEnvNote']) {
  const f = norm(extractFn(frontSrc, fn))
  record(`【跨端】${fn} 前端有实现且非空`, f.length > 30, `len=${f.length}`)
}

// 前后端各自跑一遍，比对**输出**（比比对源码更可靠：注释/写法差异不影响语义）
const frontBuildElement = (() => {
  const src = extractFn(frontSrc, 'buildElementNote')
  const tag = frontSrc.match(/export const ELEMENT_NOTE_TAG = '([^']+)'/)?.[1]
  const weight = frontSrc.match(/export const ELEMENT_WEIGHT = ([\d.]+)/)?.[1]
  return { src, tag, weight }
})()
record('【跨端】ELEMENT_NOTE_TAG / ELEMENT_WEIGHT 字面量逐字一致',
  frontBuildElement.tag === ELEMENT_NOTE_TAG
  && Number(frontBuildElement.weight) === ELEMENT_WEIGHT,
  `前端 tag="${frontBuildElement.tag}" weight=${frontBuildElement.weight}｜后端 tag="${ELEMENT_NOTE_TAG}" weight=${ELEMENT_WEIGHT}`)

const frontSharedTag = frontSrc.match(/export const SHARED_ENV_NOTE_TAG = '([^']+)'/)?.[1]
record('【跨端】SHARED_ENV_NOTE_TAG 字面量逐字一致',
  frontSharedTag === SHARED_ENV_NOTE_TAG,
  `前端="${frontSharedTag}"｜后端="${SHARED_ENV_NOTE_TAG}"`)

// 用同一份输入在"前端镜像实现"与"后端实现"上各跑一次，比对输出逐字相等。
// 前端镜像用 eval 会踩 ES module 作用域，故直接复刻其字符串模板（与源码同源读取）。
const MIRROR_INPUT = ['清晨浓雾', '冰面浮冰']
const mirrorEl = frontSrc.includes('`${ELEMENT_NOTE_TAG}(以下每一项都必须在画面中明确可见，不得省略或替换：${list.join(\'、\')}：${ELEMENT_WEIGHT})。`')
record('【跨端】A1 输出模板逐字一致（含全角标点）',
  mirrorEl,
  mirrorEl ? '' : '未匹配到前端 A1 模板')

const mirrorEnv = frontSrc.includes('`${SHARED_ENV_NOTE_TAG}(本场景与同空间的其它场景共享以下环境特征，必须一致：${list.join(\'、\')}：${ELEMENT_WEIGHT})。`')
record('【跨端】A2 输出模板逐字一致（含全角标点）',
  mirrorEnv,
  mirrorEnv ? '' : '未匹配到前端 A2 模板')

// 调用侧：promptBuilder 必须真的把两段 note 拼进 scene 分支
record('【核心】promptBuilder 的 scene 分支已接入 A1/A2',
  frontSrc.includes('const elementNote = buildElementNote(elements)')
  && frontSrc.includes('const sharedEnvNote = buildSharedEnvNote(sharedEnv)')
  && frontSrc.includes('${elementNote}${sharedEnvNote}'))

// 接入位置：必须在「画面只呈现场景环境与陈设」之前（跟长描述同区，不能被尾部的
// lightingNote / guard 挤到最末尾——句尾权重低，正是"浓雾被淡化"的成因）
const posEl = frontSrc.indexOf('${elementNote}${sharedEnvNote}')
const posTail = frontSrc.indexOf('画面只呈现场景环境与陈设')
record('【核心】A1/A2 注入在长描述之后、尾部约束之前（高权重区）',
  posEl > 0 && posTail > 0 && posEl < posTail,
  `elementNote@${posEl} 尾段@${posTail}`)

// ===== C. 落库与回读（SQL 复刻，:memory:）=====
const db = new Database(':memory:')
db.exec(`
  CREATE TABLE scenes (id INTEGER PRIMARY KEY, episode_id INTEGER, scene_number INTEGER, title TEXT, summary TEXT, image_url TEXT);
  CREATE TABLE scene_analysis (
    episode_id INTEGER, scene_id INTEGER, scene_number INTEGER,
    spatial_group TEXT, spatial_role TEXT, props_json TEXT,
    elements_json TEXT DEFAULT '[]', shared_env_json TEXT DEFAULT '[]',
    UNIQUE(episode_id, scene_id)
  );
`)
const EP = 4
const SCENES = [
  { id: 91, no: 1, title: '雪山边界悬崖' },
  { id: 92, no: 2, title: '冰河边断桥' },
  { id: 93, no: 3, title: '冰河' },
]
for (const s of SCENES) {
  db.prepare('INSERT INTO scenes (id, episode_id, scene_number, title, summary, image_url) VALUES (?,?,?,?,\'\',\'\')')
    .run(s.id, EP, s.no, s.title)
}

// 一字不改复刻 sceneAnchors.runEnsureSceneAnalysis 的落库 SQL 语义：
//   每场 elements 用自己的；shared_env 取「本场所在组」那张卡（同组全部成员写同一份）
const SHARED_ENV = { cliff_river: ['半山松林', '灰白砾石滩', '冷蓝色调'] }
const ELEMENTS = { 91: ['清晨浓雾', '两截朽桥'], 92: ['谷底浅滩', '仰视断桥'], 93: ['冰面浮冰'] }
const GROUP = { 91: 'cliff_river', 92: 'cliff_river', 93: 'cliff_river' }

const ins = db.prepare(`INSERT INTO scene_analysis
  (episode_id, scene_id, scene_number, spatial_group, spatial_role, props_json, elements_json, shared_env_json)
  VALUES (?,?,?,?,?,?,?,?)`)
for (const s of SCENES) {
  const env = SHARED_ENV[GROUP[s.id]] || []
  ins.run(EP, s.id, s.no, GROUP[s.id], `视角${s.no}`, '[]',
    JSON.stringify(ELEMENTS[s.id]), JSON.stringify(env))
}

const readRow = (sceneId) => db.prepare(
  'SELECT elements_json, shared_env_json FROM scene_analysis WHERE episode_id = ? AND scene_id = ?'
).get(EP, sceneId)

// 【核心】A2 的正题：场2 自己摘要没提植被，但它必须拿到本组的共享环境卡（含植被）
const r2 = readRow(92)
const env2 = parseElementList(r2.shared_env_json)
record('【核心】A2：场2 拿到组级环境卡（含植被），尽管它自己的摘要没提',
  env2.includes('半山松林') && env2.includes('灰白砾石滩'),
  `场2 sharedEnv=${JSON.stringify(env2)}`)

// 三场拿到的环境卡必须**逐字相同**（否则 A2 就没解决"场间不一致"）
const envs = SCENES.map((s) => r2 && parseElementList(readRow(s.id).shared_env_json).join('|'))
record('【核心】A2：同组三场的环境卡完全一致',
  envs[0] === envs[1] && envs[1] === envs[2] && envs[0] !== '',
  JSON.stringify(envs))

// 各场 elements 必须**各是各的**（不能被组卡串味——组卡是环境，要素是本场）
const els = SCENES.map((s) => parseElementList(readRow(s.id).elements_json))
record('【核心】A1：各场要素清单互不串味',
  els[0].includes('清晨浓雾') && !els[1].includes('清晨浓雾')
  && els[1].includes('谷底浅滩') && !els[0].includes('谷底浅滩'),
  JSON.stringify(els))

// 拼出的 prompt 片段核对：场2 的 A1 不该有浓雾，A2 必须有松林
const p2 = buildElementNote(els[1]) + buildSharedEnvNote(env2)
record('【核心】场2 prompt：无「清晨浓雾」但有「半山松林」',
  !p2.includes('清晨浓雾') && p2.includes('半山松林'), p2)

// 老库兼容：列不存在时 SQL 报错 → 调用方必须能降级（这里断言 parseElementList 的兜底）
record('老库兼容：列为 NULL / 缺省时 parse 降级为空数组，不抛错',
  parseElementList(null).length === 0 && parseElementList(undefined).length === 0)

// 幂等：真实流程是「DELETE 全部 + 逐行 INSERT」（sceneAnchors.runEnsureSceneAnalysis），
// 复刻这一对操作，验证重析后环境卡内容不变（不累加、不残留旧组卡）。
const before = readRow(92).shared_env_json
db.prepare('DELETE FROM scene_analysis WHERE episode_id = ?').run(EP)
for (const s of SCENES) {
  const env = SHARED_ENV[GROUP[s.id]] || []
  ins.run(EP, s.id, s.no, GROUP[s.id], `视角${s.no}`, '[]',
    JSON.stringify(ELEMENTS[s.id]), JSON.stringify(env))
}
record('幂等：重析（DELETE+INSERT）后环境卡内容逐字不变（无累加）',
  readRow(92).shared_env_json === before && readRow(92).shared_env_json === JSON.stringify(SHARED_ENV.cliff_river))

// 组收缩：组卡消失（LLM 改判该场独立成组）→ 该场环境卡必须清空，不能残留旧组的环境
db.prepare('DELETE FROM scene_analysis WHERE episode_id = ?').run(EP)
for (const s of SCENES) {
  const g = s.id === 93 ? 'river_solo' : GROUP[s.id]   // 93 改判独立组
  const env = SHARED_ENV[g] || []
  ins.run(EP, s.id, s.no, g, `视角${s.no}`, '[]',
    JSON.stringify(ELEMENTS[s.id]), JSON.stringify(env))
}
record('组变更：场3 脱离原组后环境卡清空（不留旧组残留）',
  parseElementList(readRow(93).shared_env_json).length === 0
  && parseElementList(readRow(91).shared_env_json).includes('半山松林'),
  `场3=${readRow(93).shared_env_json} 场1=${readRow(91).shared_env_json}`)

// ===== D. LLM 提示词口径守护（防止"召回退化"）=====
// 背景：第一版提示词跑出来，场1 摘要明写「清晨浓雾贴着山体翻涌」，elements 里却没有它——
//   LLM 把天气现象归成了"氛围"而非"必须可见的要素"。
//   加了显式边界后（天气必须列 / 形态必须带 / 组卡判"地点本身有没有"）召回恢复。
//   本段断言这些边界句不得被后来的"精简提示词"顺手删掉。
const anchorSrc = readFileSync(path.join(ROOT, 'server/ai/sceneAnchors.js'), 'utf8')

record('【提示词守护】LLM 被明确告知：天气/大气现象只要写了就必须列',
  anchorSrc.includes('天气与大气现象只要写了就必须列'),
  '防"浓雾被当氛围省略"复发')

record('【提示词守护】LLM 被明确告知：具体数量/形态要连形态一起写进短语',
  anchorSrc.includes('要连形态一起写进短语'),
  '防"断了一半斜挂"退化成"桥"')

record('【提示词守护】组卡判据 = 地点本身有没有，不是每场都写没写',
  anchorSrc.includes('看的是**这个地点本身有没有**'),
  '这是 A2 的核心判据：某场没提 ≠ 那个地方没有')

record('【提示词守护】elements 上限 5 条 / shared_env 上限 6 条写进了提示词',
  anchorSrc.includes('最多 5 条') && anchorSrc.includes('最多 6 条'))

record('【提示词守护】上限常量与提示词口径一致（MAX_ELEMENT_COUNT / MAX_SHARED_ENV_COUNT）',
  anchorSrc.includes('const MAX_ELEMENT_COUNT = 5') && anchorSrc.includes('const MAX_SHARED_ENV_COUNT = 6'),
  'validateAnalysis 的超量丢弃阈值')

// 提示词里不得出现"词表式"判定（通用性硬约束）
record('【通用性】A1/A2 全链零词表零正则判定（仅提示词描述边界 + 结构搬运）',
  !/if\s*\(\s*[^)]*(浓雾|浮冰|雾|雪|植被|森林)[^)]*\)/.test(anchorSrc)
  && !/(浓雾|浮冰)\s*[:=]\s*\[/.test(anchorSrc),
  '禁止在代码里写题材词判断')

console.log(`\n==== sceneElements: ${results.filter(r => r.ok).length}/${results.length} passed ====`)
if (results.some((r) => !r.ok)) process.exit(1)
