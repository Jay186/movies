// H3 出片 prompt 英文正文「中文泄漏」与判据单点 · 回归测试（2026-09-18）
//
// 事故：第2集（episodes.id=4）第1个视频段（video_segments.id=87，含镜 1-1/1-2）出片时被结构校验硬拦：
//   {"error":"段级 prompt 结构校验失败：<d> 标签外出现中文：雪山边界悬崖"}
// 根因：
//   ① 资产英文名取法 resolveAssetName 曾在三份 prompt 构造器里各写一份拷贝，只有 ai/v4Video.js
//      那份在「浮冰」事件后装了 pickEnglish 复核；ai/segmentPrompt.js 与 ai/videoPrompt.js 两份
//      英文名为空时回退中文名 → 中文落进英文正文（段级被校验器硬拦，V2 链路静默劣化）。
//   ② 说话人引用 `${who || 'the character'}` 未对 who 做中文复核——该角色未进参考槽时中文名
//      直接落进英文正文。
//   ③ 数据源：scenes.title_en/summary_en、props.name_en 的英文字段在资产提取 schema 里没要求模型
//      产出，出片 prompt 的资产名因此退化；且一键流程写 scenes 时丢弃了 LLM 提取的 titleEn/summaryEn。
// 第二轮追加（R1/R2/R3/R5）：
//   ④ retryNote（观片反馈译文）裸注入 detailed_description，无残留校验；V4 无结构校验 → 静默毁片。
//   ⑤ 时间戳格式化三份拷贝：段级 ts() 已修 4 位毫秒缺陷，单镜两条通道未修（rel 小数 ≥0.9995 时
//      输出 `At 00:12.1000` 非法 MM:SS.mmm）→ 收口 shared.formatCutTimestamp。
//   ⑥ truncateStyle 三份拷贝：段级版无词边界（截半截词）→ 收口 shared 词边界版。
//
// 本测试守护修复后的不变量（防再次漂移）：
//   A. 判据行为：resolveAssetName / pickEnglish / stripResidualCjk 的真实数据用例
//   B. 静态守卫：三个 prompt 构造器不再各自定义判据 / 时间戳格式化 / truncateStyle，统一 import 自 ai/shared.js
//   C. 契约：validateSegmentPrompt 对「reference N」版放行、对中文资产名版硬拦
//   D. 属性：任意「英文/中文/混合/空」×「场景/道具/角色」组合，结果永不含 CJK
//   E. 时间戳：formatCutTimestamp 边界值 + 三通道同输入同输出
//   F. truncateStyle：词边界（不截半截词）
//   G. retryNote 中文守卫：译文整段是中文 → 整句不注入（不留空壳）；混合 → 删词保段
//
// 约定：纯 node 断言、零外部依赖（不触网、不调 LLM、不碰 DB——shared.js 仅 import 不查库；
//       v4Video/videoPrompt/segmentPrompt 的 LLM 翻译层一律用注入 stub / override 短路）。
//       自带判卷、PASS/FAIL 前缀、可重复运行。

import fs from 'node:fs'
import { pickEnglish, stripResidualCjk, resolveAssetName, truncateStyle, formatCutTimestamp, pickInjectableEnglish } from '../ai/shared.js'
// F3 救济纯函数（第四轮）：判脏后删残保英文主体；不触 LLM/DB，可直接断言。
import { rescueLeakedFields } from '../ai/h3PromptTranslator.js'
// 从 v4Video.js 再取一次：既是「公开 API 未变」的运行时验证（调用方仍在 import），
// 也把「re-export 与 shared 同源」钉死（同一函数引用，不是又抄一份）。
import { pickEnglish as v4PickEnglish, stripResidualCjk as v4StripResidualCjk, buildShotVideoPromptV4 } from '../ai/v4Video.js'
import { buildShotVideoPrompt } from '../ai/videoPrompt.js'
import { validateSegmentPrompt, buildSegmentVideoPrompt } from '../ai/segmentPrompt.js'

const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ::  ${detail}` : ''}\n`)
}
function t(name, fn) {
  try { fn() } catch (e) { record(name, false, `EXCEPTION ${e && e.message}`) }
}
// ⚠️ 异步断言必须显式收集，收尾 await —— 否则退出码假绿（见 assetQuality.test.mjs 教训）。
const asyncTasks = []
function tAsync(name, fn) {
  asyncTasks.push((async () => {
    try { await fn() } catch (e) { record(name, false, `EXCEPTION ${e && e.message}`) }
  })())
}
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8')
const CJK = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/
// <d> 标签外的汉字（H3 英文正文的唯一合法中文出口就是 <d> 内台词）
const cjkOutsideD = (s) => CJK.test(String(s || '').replace(/<d>[\s\S]*?<\/d>/g, ''))

// ── A. 判据行为：resolveAssetName 的真实数据用例 ──────────────────────────────
// 用例直接取自本轮事故数据（ep4：7 场景 title_en/summary_en 全空、2 道具 name_en 全空）。
t('A1. resolveAssetName 真实数据用例', () => {
  record('英文名为空 + 中文场景名 → 丢弃（宁缺勿脏）',
    resolveAssetName('', '雪山边界悬崖') === '', JSON.stringify(resolveAssetName('', '雪山边界悬崖')))
  record('英文名本身全中文 → 也丢弃（「浮冰」事件：中文不可作英文名常量）',
    resolveAssetName('浮冰', '浮冰') === '', JSON.stringify(resolveAssetName('浮冰', '浮冰')))
  record('英文名合法 → 原样返回',
    resolveAssetName('Snowy Cliff', '雪山边界悬崖') === 'Snowy Cliff', JSON.stringify(resolveAssetName('Snowy Cliff', '雪山边界悬崖')))
  record('英文名含残 CJK → 删词保段',
    resolveAssetName('Snowy 雪山 Cliff', '') === 'Snowy Cliff', JSON.stringify(resolveAssetName('Snowy 雪山 Cliff', '')))
  record('两参皆空 → 空串',
    resolveAssetName('', '') === '')
  record('两参 undefined/缺失 → 不抛错、回空串', (() => {
    let ok = true
    try { ok = resolveAssetName('', undefined) === '' && resolveAssetName(undefined, undefined) === '' } catch { ok = false }
    return ok
  })())
})

t('A2. pickEnglish 用例（英文正文闸门）', () => {
  record('纯英文 → 原样', pickEnglish('Hello World') === 'Hello World')
  record('含汉字 → 丢弃', pickEnglish('Hello 世界') === '')
  record('含假名/谚文 → 丢弃', pickEnglish('テスト') === '' && pickEnglish('안녕') === '')
  record('空白/null → 空串', pickEnglish('   ') === '' && pickEnglish(null) === '')
})

t('A3. stripResidualCjk 用例（删词保段兜底）', () => {
  record('混合名 → 删残 CJK 并折叠空白', stripResidualCjk('Snowy 雪山 Cliff') === 'Snowy Cliff', JSON.stringify(stripResidualCjk('Snowy 雪山 Cliff')))
  record('多处残 CJK → 全删', stripResidualCjk('Ice 浮冰 Floe 冰 drift') === 'Ice Floe drift', JSON.stringify(stripResidualCjk('Ice 浮冰 Floe 冰 drift')))
  record('纯英文 → 不变', stripResidualCjk('Plain English') === 'Plain English')
  record('删词后残留空格+标点 → 收拢（word 冰 . → word.）', stripResidualCjk('word 冰 .') === 'word.', JSON.stringify(stripResidualCjk('word 冰 .')))
  record('空 → 空串', stripResidualCjk('') === '' && stripResidualCjk(null) === '')
  // CJK/全角标点也属「残 CJK」：纯中文串含全角标点必须整体归空，否则 retryNote 会注入空壳
  record('含全角标点的纯中文 → 归空（防 MANDATORY 空壳）',
    stripResidualCjk('剧本节拍未演出：小熊倒地') === '', JSON.stringify(stripResidualCjk('剧本节拍未演出：小熊倒地')))
  record('全角标点残渣单独出现 → 归空', stripResidualCjk('：。、') === '', JSON.stringify(stripResidualCjk('：。、')))
  record('英文句中的全角标点被剔除、英文保留',
    stripResidualCjk('the bear runs：then stops') === 'the bear runs then stops', JSON.stringify(stripResidualCjk('the bear runs：then stops')))
})

t('A4. v4Video.js re-export 与 shared.js 同源（判据单点，runtime 验证）', () => {
  record('pickEnglish 是同一函数引用', v4PickEnglish === pickEnglish)
  record('stripResidualCjk 是同一函数引用', v4StripResidualCjk === stripResidualCjk)
})

// ── B. 静态守卫（防再次漂移）────────────────────────────────────────────────
// 三个文件一律不得再各自定义判据；且必须都从 ./shared.js 引入对应函数。
const PROMPT_FILES = [
  '../ai/v4Video.js',
  '../ai/videoPrompt.js',
  '../ai/segmentPrompt.js',
]
// 定义式：function / const(或 let/var) 赋值 / export const。注释里的裸提及不算。
const DEF_RESOLVE_NAME = /(?:function\s+resolveName\b|(?:const|let|var)\s+resolveName\s*=)/
const DEF_PICK_ENGLISH = /(?:function\s+pickEnglish\b|(?:const|let|var)\s+pickEnglish\s*=)/
const DEF_STRIP_CJK = /(?:function\s+stripResidualCjk\b|(?:const|let|var)\s+stripResidualCjk\s*=)/
const DEF_TRUNCATE_STYLE = /(?:function\s+truncateStyle\b|(?:const|let|var)\s+truncateStyle\s*=)/
const DEF_TS_FN = /(?:function\s+(?:ts|formatCutTimestamp)\b|(?:const|let|var)\s+(?:ts|formatCutTimestamp)\s*=)/
const IMPORTS_SHARED_RESOLVE = /import\s*\{[^}]*\bresolveAssetName\b[^}]*\}\s*from\s*'\.\/shared\.js'/
const IMPORTS_SHARED_TS = /import\s*\{[^}]*\bformatCutTimestamp\b[^}]*\}\s*from\s*'\.\/shared\.js'/
const IMPORTS_SHARED_TRUNC = /import\s*\{[^}]*\btruncateStyle\b[^}]*\}\s*from\s*'\.\/shared\.js'/

for (const rel of PROMPT_FILES) {
  const src = read(rel)
  const label = rel.replace('../ai/', '')
  t(`B. ${label} 不再自持判据且从 shared 引入`, () => {
    record(`${label}: 未定义 resolveName`, !DEF_RESOLVE_NAME.test(src))
    record(`${label}: 未定义 pickEnglish`, !DEF_PICK_ENGLISH.test(src))
    record(`${label}: 未定义 stripResidualCjk`, !DEF_STRIP_CJK.test(src))
    record(`${label}: 从未定义 truncateStyle`, !DEF_TRUNCATE_STYLE.test(src))
    record(`${label}: 从未定义时间戳格式化函数`, !DEF_TS_FN.test(src))
    record(`${label}: 从 ./shared.js 引入 resolveAssetName`, IMPORTS_SHARED_RESOLVE.test(src))
    record(`${label}: 从 ./shared.js 引入 formatCutTimestamp`, IMPORTS_SHARED_TS.test(src))
    record(`${label}: 从 ./shared.js 引入 truncateStyle`, IMPORTS_SHARED_TRUNC.test(src))
    // 局部 CJK_RE 也一并铲除（曾由它派生一份 pickEnglish）
    record(`${label}: 无局部 CJK_RE`, !/(const|let|var)\s+CJK_RE\s*=/.test(src))
  })
}

t('B4. v4Video.js 仍导出 pickEnglish / stripResidualCjk（调用方在 import）', () => {
  const src = read('../ai/v4Video.js')
  record('导出 pickEnglish', /export\s*\{[^}]*\bpickEnglish\b[^}]*\}/.test(src) || /export\s+const\s+pickEnglish\b/.test(src))
  record('导出 stripResidualCjk', /export\s*\{[^}]*\bstripResidualCjk\b[^}]*\}/.test(src) || /export\s+const\s+stripResidualCjk\b/.test(src))
})

t('B5. shared.js 是判据唯一实现处', () => {
  const src = read('../ai/shared.js')
  record('导出 pickEnglish', /export\s+function\s+pickEnglish\b/.test(src))
  record('导出 stripResidualCjk', /export\s+function\s+stripResidualCjk\b/.test(src))
  record('导出 resolveAssetName', /export\s+function\s+resolveAssetName\b/.test(src))
  record('导出 truncateStyle', /export\s+function\s+truncateStyle\b/.test(src))
  record('导出 formatCutTimestamp', /export\s+function\s+formatCutTimestamp\b/.test(src))
  // resolveAssetName 必须经 pickEnglish 复核中文名（浮冰教训）——不得退回「英文名 || 中文名」
  record('中文名经 pickEnglish 复核', /pickEnglish\(nameEn\)[\s\S]*pickEnglish\(nameCn\)/.test(src))
})

t('B6. 说话人引用与 combatNote 均已加中文守卫（两/三条通道逐字同源）', () => {
  const v4 = read('../ai/v4Video.js')
  const seg = read('../ai/segmentPrompt.js')
  const v2 = read('../ai/videoPrompt.js')
  record('v4Video 说话人 who 过 pickEnglish', /\$\{pickEnglish\(who\)\s*\|\|\s*'the character'\}/.test(v4))
  record('segmentPrompt 说话人 who 过 pickEnglish', /\$\{pickEnglish\(who\)\s*\|\|\s*'the character'\}/.test(seg))
  record('videoPrompt 说话人 who 过 pickEnglish', /\$\{pickEnglish\(who\)\s*\|\|\s*'the character'\}/.test(v2))
  record('v4Video combatNote 带守卫', /if\s*\(combatNote\)\s*ddParts\.push\(pickEnglish\(combatNote\)/.test(v4))
  record('segmentPrompt combatNote 带守卫', /if\s*\(combatNote\)\s*ddParts\.push\(pickEnglish\(combatNote\)/.test(seg))
})

t('B7. R5 死 import 已清除（buildShotVideoPrompt / cameraPhrase 零调用点）', () => {
  for (const rel of ['../routes/generate-image.js', '../routes/generate-script.js', '../routes/generate-post.js']) {
    const src = read(rel)
    const label = rel.replace('../routes/', '')
    record(`${label}: 不再 import buildShotVideoPrompt/cameraPhrase`,
      !/import\s*\{[^}]*\b(?:buildShotVideoPrompt|cameraPhrase)\b[^}]*\}\s*from\s*'\.\.\/ai\/videoPrompt\.js'/.test(src))
  }
})

t('B8. R1 retryNote 守卫 + R6 陈旧注释', () => {
  const v4 = read('../ai/v4Video.js')
  // F1（2026-09-18 第四轮）升级：stripResidualCjk + truthy 判空 → pickInjectableEnglish
  // （删残 CJK + 至少一个 ASCII 字母）。旧断言 /stripResidualCjk\(retryNote\)/ 固化旧形状，
  // 会阻止加固（',;' 空壳漏网），已改断言新判据；行为级验证见 G4 端到端用例。
  record('v4Video retryNote 过 pickInjectableEnglish（F1 升级）', /pickInjectableEnglish\(retryNote\)/.test(v4))
  record('v4Video 空守卫则整句不注入', /if\s*\(retryNoteEn\)\s*\{/.test(v4))
  const gv = read('../routes/generate-video.js')
  record('generate-video.js 注释已指向 resolveAssetName', /v4Video\.resolveAssetName/.test(gv) && !/v4Video\.resolveName/.test(gv))
})

// ── C. 契约：validateSegmentPrompt 的行为 ────────────────────────────────────
// guard 行与六段名照 ai/segmentPrompt.js 的 GUARD / SECTIONS 抄（不自己造格式）。
const GUARD = 'Director guidance below is for visual generation only: do not read aloud, narrate, or quote any of it — speak only the dialogue inside <d> tags. The generated video must contain no on-screen text, subtitles, watermark, or logo.'

/** 造一个六段齐备、首行 guard、含 [Shot 1]/[Shot 2]（Shot 2 带切点时间戳）的段级 prompt。 */
function makeSegmentPrompt(sceneSubjectLine) {
  return [
    GUARD,
    'subject_definitions:',
    '<Subject 1> is a small brown bear cub (character) from <Picture 1>, a small brown bear cub with a blue scarf in thick fur.',
    sceneSubjectLine,
    'summary:',
    '[reference generation] The target video is a 5-second 2-shot segment. The scene is set in the snowy cliff. All visual elements must strictly match their reference appearances.',
    'retention_analysis:',
    '<Subject 1> (appears in every shot: [Shot 1], [Shot 2]): fully_preserved - appearance is retained from <Picture 1>.',
    'detailed_description:',
    '[Shot 1] A wide shot, the cub walks forward through the snow. [Shot 2] At 00:03.000, the shot cuts to a medium shot, the cub stops and looks up.',
    'overall_soundscape:',
    'A low howling wind over the snowfield.',
    'non_diegetic_music:',
    'N/A',
  ].join('\n')
}

t('C1. 英文名降级为 reference N 的版本 → 校验通过', () => {
  const prompt = makeSegmentPrompt('<Subject 2> is reference 2 (scene/environment) from <Picture 2>')
  const r = validateSegmentPrompt(prompt, 2)
  record('ok=true', r.ok === true, JSON.stringify(r.errors))
  record('无错误', r.errors.length === 0)
})

t('C2. 中文场景名版本 → 校验失败且报「标签外出现中文」', () => {
  const prompt = makeSegmentPrompt('<Subject 2> is 雪山边界悬崖 (scene/environment) from <Picture 2>')
  const r = validateSegmentPrompt(prompt, 2)
  record('ok=false', r.ok === false)
  record('错误含「标签外出现中文」', r.errors.some((e) => e.includes('标签外出现中文')), JSON.stringify(r.errors))
  record('错误文本带出泄漏词', r.errors.some((e) => e.includes('雪山边界悬崖')), JSON.stringify(r.errors))
})

t('C3. 校验器 <d> 内中文豁免（台词本就该是中文）', () => {
  const withDialogue = makeSegmentPrompt('<Subject 2> is reference 2 (scene/environment) from <Picture 2>')
    .replace('[Shot 1] A wide shot, the cub walks forward through the snow.',
      '[Shot 1] A wide shot. <Subject 1> says softly and steadily, <d>[Chinese] 我们回家吧</d>')
  const r = validateSegmentPrompt(withDialogue, 2)
  record('<d> 内中文不报错', r.ok === true, JSON.stringify(r.errors))
})

// ── D. 属性测试：任意资产名组合，结果永不含 CJK ──────────────────────────────
// 用固定种子 LCG 保证「随机但可复现」——失败能稳定重放，不依赖运行时 entropy。
function lcg(seed) {
  let s = seed >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 }
}
const EN = ['Snowy Cliff', 'Living Room', 'Ice Floe', 'Broken Bridge', 'Rocky Path', '']
const CN = ['雪山边界悬崖', '家中客厅', '浮冰', '腐朽木桥', '一二', '']
const MIX = ['Snowy 雪山 Cliff', 'Ice 浮冰 Floe', 'Room 客厅 warm', '浮冰 Floe 冰 drift', '']
const KINDS = ['scene', 'prop', 'character']

t('D1. 随机组合（英文/中文/混合/空 × 场景/道具/角色）结果永不含 CJK', () => {
  const rnd = lcg(20260918)
  const pick = (pool) => pool[Math.floor(rnd() * pool.length) % pool.length]
  for (const kind of KINDS) {
    let combos = 0
    let bad = null
    for (let i = 0; i < 200; i++) {
      const nameEn = pick(rnd() < 0.7 ? EN : (rnd() < 0.5 ? MIX : CN))
      const nameCn = pick(rnd() < 0.7 ? CN : (rnd() < 0.5 ? MIX : EN))
      const out = resolveAssetName(nameEn, nameCn)
      combos++
      if (CJK.test(out)) { bad = { kind, nameEn, nameCn, out }; break }
    }
    record(`kind=${kind}: ${combos} 组合均无 CJK`, bad === null, bad ? JSON.stringify(bad) : '')
  }
})

t('D2. 全枚举边界：任一参数为中文/空/undefined 都不得产出 CJK', () => {
  const all = ['', undefined, null, ...EN, ...CN, ...MIX]
  let bad = null
  let n = 0
  for (const a of all) {
    for (const b of all) {
      const out = resolveAssetName(a, b)
      n++
      if (CJK.test(out)) { bad = { a, b, out }; break }
    }
    if (bad) break
  }
  record(`全枚举 ${n} 组均无 CJK`, bad === null, bad ? JSON.stringify(bad) : '')
})

// ── E. R2 时间戳：formatCutTimestamp 边界值 ─────────────────────────────────
t('E1. formatCutTimestamp 边界值（先归整整数毫秒再拆分，防 4 位毫秒）', () => {
  record("ts(0) === '00:00.000'", formatCutTimestamp(0) === '00:00.000', formatCutTimestamp(0))
  record("ts(59.9996) === '01:00.000'（旧写法会输出 00:59.1000）", formatCutTimestamp(59.9996) === '01:00.000', formatCutTimestamp(59.9996))
  record("ts(12.0004) === '00:12.000'", formatCutTimestamp(12.0004) === '00:12.000', formatCutTimestamp(12.0004))
  record("ts(3.5) === '00:03.500'", formatCutTimestamp(3.5) === '00:03.500', formatCutTimestamp(3.5))
  record('负值 clamp 到 0', formatCutTimestamp(-1) === '00:00.000', formatCutTimestamp(-1))
  record('结果恒为 MM:SS.mmm 两段式', /^\d{2}:\d{2}\.\d{3}$/.test(formatCutTimestamp(3725.678)), formatCutTimestamp(3725.678))
})

// v4Video / videoPrompt 的翻译层用注入 stub 短路（不调 LLM）；段级用 video_prompt_override 短路。
const stubTranslate = async () => ({
  description_en: 'A small bear walks through the snow.',
  action_note_en: 'It moves forward slowly.',
  soundscape_en: 'A low wind over the snow.',
  music_en: 'N/A',
  tone_en: '',
})
const TS_PROBE = 12.0004
const tsProbeShot = {
  duration: 15, start_time: 0, end_time: 15,
  description: '小熊走过雪地', action_note: '向前走',
  dialogue: JSON.stringify([{ character: 'bear', text: 'hi', startTime: TS_PROBE }]),
}
const atTs = (prompt) => (String(prompt).match(/At (\d{2}:\d{2}\.\d{3}),/) || [])[1]

tAsync('E2. 三通道同输入同输出（均等于 shared.formatCutTimestamp）', async () => {
  const expected = formatCutTimestamp(TS_PROBE) // '00:12.000'
  const p4 = await buildShotVideoPromptV4(tsProbeShot, { translate: stubTranslate })
  // 注意：buildShotVideoPrompt（V2）返回 { prompt, warnings }；V4/段级返回字符串本体。
  const p2 = (await buildShotVideoPrompt(tsProbeShot, { translate: stubTranslate })).prompt
  const segShot = { ...tsProbeShot, video_prompt_override: 'A bear walks through the snow.' }
  const pSeg = await buildSegmentVideoPrompt({
    seg: { start_time: 0, end_time: 15 },
    shots: [segShot],
    refs: [],
  })
  record('V4 通道时间戳', atTs(p4) === expected, `got=${atTs(p4)} want=${expected}`)
  record('V2 通道时间戳', atTs(p2) === expected, `got=${atTs(p2)} want=${expected}`)
  record('段级通道时间戳', atTs(pSeg) === expected, `got=${atTs(pSeg)} want=${expected}`)
  record('三通道互相一致', atTs(p4) === atTs(p2) && atTs(p2) === atTs(pSeg))
})

// ── F. R3 truncateStyle：词边界 ─────────────────────────────────────────────
t('F1. truncateStyle 词边界（不截半截词）', () => {
  record('短串原样', truncateStyle('short style', 300) === 'short style')
  record('超长按空格回退到完整单词', truncateStyle('the atmosphere is thick and heavy today', 15) === 'the atmosphere',
    JSON.stringify(truncateStyle('the atmosphere is thick and heavy today', 15)))
  record('结果不含半截词 "atmospher"', !truncateStyle('the atmosphere is thick', 15).endsWith('atmospher'))
  // 词边界落在前半段之外 → 退化为硬截（宁可硬截也不把前半段几乎全丢）
  record('无合适空格 → 硬截（兜底逻辑保留）', truncateStyle('a bbccddeeffgghhiijjkk', 10) === 'a bbccddee',
    JSON.stringify(truncateStyle('a bbccddeeffgghhiijjkk', 10)))
  record('默认 max=300', truncateStyle('x'.repeat(301)).length === 300)
  record('折叠空白（走 shared.clean）', truncateStyle('a   b') === 'a b')
})

// ── G. R1 retryNote 中文守卫 ────────────────────────────────────────────────
const retryShot = { duration: 5, start_time: 0, description: '小熊走过雪地', action_note: '向前走' }
const MANDATE = 'MANDATORY CORRECTION FROM PREVIOUS FAILED TAKE'

tAsync('G1. retryNote 纯英文 → 正常注入（行为不变）', async () => {
  const p = await buildShotVideoPromptV4(retryShot, { translate: stubTranslate, retryNote: 'the bear collapses into the snow; the red glow fades' })
  record('注入 MANDATORY CORRECTION', p.includes(MANDATE))
  record('保留英文修正内容', p.includes('the bear collapses into the snow'))
  record('正文无标签外中文', !cjkOutsideD(p))
})

tAsync('G2. retryNote 整段中文 → 整句不注入（不留空壳）', async () => {
  const p = await buildShotVideoPromptV4(retryShot, { translate: stubTranslate, retryNote: '剧本节拍未演出：小熊倒地' })
  record('不注入 MANDATORY CORRECTION（无空壳）', !p.includes(MANDATE))
  record('正文无标签外中文', !cjkOutsideD(p))
})

tAsync('G3. retryNote 混合 → 删词保段（保住英文、删掉中文）', async () => {
  const p = await buildShotVideoPromptV4(retryShot, { translate: stubTranslate, retryNote: 'the bear 倒地 collapses now' })
  record('仍注入 MANDATORY CORRECTION', p.includes(MANDATE))
  record('中文被删除、英文保留', p.includes('the bear collapses now'))
  record('正文无标签外中文', !cjkOutsideD(p))
})

// R14：QA 原始反例——LLM 把中文反馈翻译成英文后**只剩半角标点**（',;'）。
// ⚠️ 守卫刻意放在**路由层**（generate-video.js L512 `pickInjectableEnglish(en)`），
//    v4Video.js 自身的注入门仍是 `stripResidualCjk(retryNote)` + truthy 判空——
//    它没有、也不该知道「至少一个字母」这条业务判据（那是调用方的语义）。
//    故本用例按**修复后路由的真实传参**端到端复算：先把 ',;' 过守卫（得到 ''），
//    再把守卫结果喂给 buildShotVideoPromptV4，验证 prompt 里确实不出现空壳。
tAsync('G4. R14 QA 反例 retryNote=",;" → 端到端确认不注入空壳', async () => {
  const guarded = pickInjectableEnglish(',;')
  record("守卫把 ',;' 判为不可用", guarded === '', JSON.stringify(guarded))
  const p = await buildShotVideoPromptV4(retryShot, { translate: stubTranslate, retryNote: guarded })
  record('经守卫后不注入 MANDATORY CORRECTION', !p.includes(MANDATE))
  record('prompt 中不含 ",;" 空壳片段', !p.includes(',;'))
  record('正文无标签外中文', !cjkOutsideD(p))
  // 反向对照：正常英文指令仍必须注入（守卫不得误伤）
  const okNote = 'the bear collapses into the snow'
  const p2 = await buildShotVideoPromptV4(retryShot, { translate: stubTranslate, retryNote: pickInjectableEnglish(okNote) })
  record('正常英文经守卫后仍注入', p2.includes(MANDATE) && p2.includes(okNote))
})

// ── H. 第三轮回归（R10 / R11 / R14 / R15）───────────────────────────────────
//
// R15：脏字符判据收敛为唯一常量 CJK_DIRTY_RE。此前 pickEnglish 用窄集（表意/假名/谚文），
//   全角冒号 U+FF1A 不在窄集里 → pickEnglish('：') === '：'，段级 override 传一个全角标点
//   就能绕过闸门（QA 实测出的漏报）。收敛后 CJK 标点与全角形式一律判脏。
// R14：译文删残后可能只剩半角标点（',;'）—— 既 truthy 又无脏字符，旧守卫放行 → 注入空壳。
//   pickInjectableEnglish 追加「至少含一个 ASCII 字母」判据。
// ⚠️ 方差：generate-video.js 与 extractGuard.js **均 import ../db.js**（import 即开真实
//   data.db，违反本项目测试红线）。故本段对这两个文件采用「**抽取真实实现 → 沙箱求值**」
//   或静态守卫，而不是重新实现一份判据——与本测试 §B 对 v4Video/segmentPrompt 的做法同式
//   （「断言源码里有某段字符串」在逻辑改错时仍会绿，已踩过坑）。

t('H1. R15 pickEnglish 脏字符全集（全角标点 / 全角空格 / CJK 兼容竖排）', () => {
  record("全角冒号 '：'（U+FF1A）→ 丢弃（此前漏过闸门）", pickEnglish('：') === '', JSON.stringify(pickEnglish('：')))
  record("全角逗号+分号 '，；' → 丢弃", pickEnglish('，；') === '', JSON.stringify(pickEnglish('，；')))
  record("全角空格 '　'（U+3000）→ 丢弃", pickEnglish('　') === '', JSON.stringify(pickEnglish('　')))
  // ⚠️ U+FE10–U+FE19（竖排形式的逗号/句号）**不在** CJK_DIRTY_RE 范围内，是本判据的已知边界，
  //    此处刻意不断言它（留报告 §遗留风险跟踪），以免把「当前覆盖边界」误钉成期望行为。
  record('CJK 引号「〝」（U+301D）→ 丢弃', pickEnglish('〝') === '', JSON.stringify(pickEnglish('〝')))
  record('全角花括号「｛」（U+FF5B）→ 丢弃', pickEnglish('｛') === '', JSON.stringify(pickEnglish('｛')))
  record('英文里夹全角标点 → 整段丢弃（宁缺勿脏）', pickEnglish('the bear runs：then stops') === '')
  // 反向保护：ASCII 标点/数字是**合法**英文，不该被误拦（否则会误伤正常英文正文）
  record('半角标点 ",;" 仍算合法英文（脏字符判据不管这个）', pickEnglish(',;') === ',;', JSON.stringify(pickEnglish(',;')))
  record('纯英文+数字+半角标点 原样放行', pickEnglish('v1.2 — Watercolor, soft light.') === 'v1.2 — Watercolor, soft light.')
  record('假名/谚文仍被拦', pickEnglish('テスト') === '' && pickEnglish('안녕') === '')
})

t('H2. R15 全角标点泄漏 → validateSegmentPrompt 必须报错（不得漏报）', () => {
  const base = '<Subject 2> is reference 2 (scene/environment) from <Picture 2>'
  const cases = [
    ['全角冒号', `${base}：`],
    ['全角逗号+分号', `${base}，；`],
    ['CJK 标点「。」', `${base}。`],
  ]
  for (const [label, line] of cases) {
    const r = validateSegmentPrompt(makeSegmentPrompt(line), 2)
    record(`${label}：ok=false`, r.ok === false)
    record(`${label}：报「<d> 标签外出现中文」`, r.errors.some((e) => e.includes('标签外出现中文')), JSON.stringify(r.errors))
  }
  // 回归保护：干净 prompt 不得被新判据误报
  const clean = validateSegmentPrompt(makeSegmentPrompt(base), 2)
  record('干净 prompt 仍通过（无误报）', clean.ok === true, JSON.stringify(clean.errors))
})

t('H3. R15 判据唯一性：CJK_DIRTY_RE 导出且 shared.js 内无第二份字面量', () => {
  const src = read('../ai/shared.js')
  record('导出 CJK_DIRTY_RE', /export\s+const\s+CJK_DIRTY_RE\s*=/.test(src))
  record('RESIDUAL_CJK_RE 由它派生（不再写字面量）', /const RESIDUAL_CJK_RE = new RegExp\(CJK_DIRTY_RE\.source \+ '\+', 'g'\)/.test(src))
  record('pickEnglish 用它判脏', /!CJK_DIRTY_RE\.test\(v\)/.test(src))
  // SEGMENTPROMPT 不得再内联 [\u4e00-\u9fff]
  const seg = read('../ai/segmentPrompt.js')
  record('segmentPrompt 不再内联 [\\u4e00-\\u9fff]', !/match\(\/\[\\u4e00-\\u9fff\]\+\/g\)/.test(seg))
  record('segmentPrompt 从 shared 引入 CJK_DIRTY_RE', /import\s*\{[^}]*\bCJK_DIRTY_RE\b[^}]*\}\s*from\s*'\.\/shared\.js'/.test(seg))
})

t('H4. R14 pickInjectableEnglish（删残 CJK + 至少一个 ASCII 字母）', () => {
  // QA 实测漏洞本体：翻完只剩半角标点
  record("',;' 半角标点空壳 → 弃用", pickInjectableEnglish(',;') === '', JSON.stringify(pickInjectableEnglish(',;')))
  record('纯数字与符号 → 弃用（无字母）', pickInjectableEnglish('123 !!!') === '')
  record('删残 CJK 后只剩标点 → 弃用', pickInjectableEnglish('，；：') === '')
  record('全中文译文删残后为空 → 弃用', pickInjectableEnglish('剧本节拍未演出：小熊倒地') === '')
  // 正常英文必须原样放行（行为不变）
  record('纯英文 → 原样保留', pickInjectableEnglish('the bear collapses; the glow fades') === 'the bear collapses; the glow fades')
  record('混合（英文+中文）→ 删词保段', pickInjectableEnglish('the bear 倒地 collapses') === 'the bear collapses')
  record('空 / undefined / null → 空串', pickInjectableEnglish('') === '' && pickInjectableEnglish(undefined) === '' && pickInjectableEnglish(null) === '')
})

t('H5. R14 + R10：generate-video.js 接线静态守卫（该文件 import db.js，不可运行时 import）', () => {
  const gv = read('../routes/generate-video.js')
  // R14
  record('引入 pickInjectableEnglish', /import\s*\{[^}]*\bpickInjectableEnglish\b[^}]*\}\s*from\s*'\.\.\/ai\/shared\.js'/.test(gv))
  record('retryNote 赋值为守卫结果', /const retryNoteEn = pickInjectableEnglish\(en\)/.test(gv))
  record('不再裸收 String(en).trim()', !/retryNote = String\(en\)\.trim\(\)/.test(gv))
  record('守卫为空时不注入（retryNote 取到空串）', /retryNote = retryNoteEn/.test(gv))
  // R10：场景悬空告警必须**两路**都存在（单镜 + 段级）
  record("场景告警 ≥2 处（单镜+段级）且 source='sceneName'", (gv.match(/source: 'sceneName'/g) || []).length >= 2,
    `命中 ${(gv.match(/source: 'sceneName'/g) || []).length}`)
  record("场景告警 level='warn'", (gv.match(/source: 'sceneName', level: 'warn'/g) || []).length >= 2)
  record('场景告警带 shot 身份（shotId/shotNumber）', /source: 'sceneName', level: 'warn',\s*\n\s*message:[^\n]*/.test(gv))
  record('带场景名候选便于人工核对', /candidates: sceneTitles/.test(gv))
})

// R11：applyKeepForScenes 真实实现沙箱求值（extractGuard.js import db.js → 不可直接 import）
// 抽取**真实函数体**而非重写判据：函体重构/逻辑改错时本用例会真的失败。
function extractFnSafe(src, name) {
  const re = new RegExp(`\\n(?:export\\s+)?(?:async\\s+)?function ${name}\\([^)]*\\) \\{`)
  const m = src.match(re)
  if (!m) return null
  const start = m.index + 1
  const lines = src.slice(start).split('\n')
  let depth = 0
  const out = []
  for (const line of lines) {
    out.push(line)
    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length
    if (depth === 0 && out.length > 1) break
  }
  // 脱掉 `export ` 前缀：抽出的是 export function，但 new Function 体内不得出现 export 关键字。
  return out.join('\n').replace(/^export\s+/, '')
}

t('H6. R11 applyKeepForScenes 英文常量「旧值优先、LLM 兜底」', () => {
  const src = read('../ai/extractGuard.js')
  const normFn = extractFnSafe(src, 'norm')
  const parseFn = extractFnSafe(src, 'parsePropNames')
  const llmStrFn = extractFnSafe(src, 'llmStr')
  const applyFn = extractFnSafe(src, 'applyKeepForScenes')
  record('抽出四个真实函数体', !!(normFn && parseFn && llmStrFn && applyFn),
    [normFn, parseFn, llmStrFn, applyFn].map((f) => (f ? 1 : 0)).join(''))
  if (!applyFn) return

  const applyKeepForScenes = new Function(`
    ${normFn}
    ${parseFn}
    ${llmStrFn}
    ${applyFn}
    return applyKeepForScenes
  `)()

  const incoming = [{ name: '场景甲', titleEn: 'Cliff EN', summaryEn: 'Summary EN', lightingEn: 'Light EN' }]

  // ① 旧值为空 → 必须保留 LLM 新值（本次修复的缺陷本体：旧写法 `old.title_en || ''` 会把新值抹成空）
  const oldEmpty = [{ title: '场景甲', title_en: '', summary_en: '', lighting_en: '' }]
  const r1 = applyKeepForScenes(incoming, oldEmpty)[0]
  record('旧 title_en 空 → 保留 LLM titleEn', r1.titleEn === 'Cliff EN', String(r1.titleEn))
  record('旧 summary_en 空 → 保留 LLM summaryEn', r1.summaryEn === 'Summary EN', String(r1.summaryEn))
  record('旧 lighting_en 空 → 保留 LLM lightingEn', r1.lightingEn === 'Light EN', String(r1.lightingEn))

  // ② 旧值非空 → 旧值胜出（keep = 保留我的）
  const oldFilled = [{ title: '场景甲', title_en: 'OLD En', summary_en: 'OLD Sum', lighting_en: 'OLD Light' }]
  const r2 = applyKeepForScenes(incoming, oldFilled)[0]
  record('旧 title_en 非空 → 旧值胜出', r2.titleEn === 'OLD En', String(r2.titleEn))
  record('旧 summary_en 非空 → 旧值胜出', r2.summaryEn === 'OLD Sum', String(r2.summaryEn))
  record('旧 lighting_en 非空 → 旧值胜出', r2.lightingEn === 'OLD Light', String(r2.lightingEn))

  // ③ snake_case 键名兼容（LLM 输出与库内行两种形态）
  const r3 = applyKeepForScenes([{ name: '场景甲', title_en: 'Snake En', summary_en: 'Snake Sum' }], oldEmpty)[0]
  record('snake_case 兼容 title_en', r3.titleEn === 'Snake En', String(r3.titleEn))
  record('snake_case 兼容 summary_en', r3.summaryEn === 'Snake Sum', String(r3.summaryEn))

  // ④ LLM 侧非字符串 → 安全退化为空，且绝不抛错
  let ok = true
  let r4 = null
  try { r4 = applyKeepForScenes([{ name: '场景甲', titleEn: {}, summaryEn: 123, lightingEn: [] }], oldEmpty)[0] } catch { ok = false }
  record('非字符串值不抛错', ok)
  record("对象 {} 退化为空（不放行 '[object Object]'）", ok && r4.titleEn === '', String(r4?.titleEn))
  record('数字 123 退化为空', ok && r4.summaryEn === '', String(r4?.summaryEn))
  record('空数组 [] 退化为空', ok && r4.lightingEn === '', String(r4?.lightingEn))

  // ⑤ 新增条目（库中无同名）仍保留 LLM 新值，不被改写
  const r5 = applyKeepForScenes([{ name: '新场景', titleEn: 'New En' }], oldEmpty)
  const added = r5.find((x) => (x.name || '') === '新场景')
  record('新增条目原样保留 LLM 值', added && added.titleEn === 'New En', String(added?.titleEn))
})

// ── 收尾：必须先把异步断言跑完再汇总，否则退出码会假绿 ──────────────────────
await Promise.all(asyncTasks)

const failed = results.filter((r) => !r.ok)
process.stdout.write(`\n==== assetNameCjk: ${results.length - failed.length}/${results.length} passed ====\n`)
if (failed.length) {
  process.stdout.write(`FAILED:\n${failed.map((f) => `  - ${f.name}`).join('\n')}\n`)
  process.exit(1)
}
