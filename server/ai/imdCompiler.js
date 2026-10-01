// IMD 混合编译（#6）：模块2（角色外形锁定）与模块3（环境冻结）由资产库原文程序注入，
// LLM 只负责其余模块（镜头声明 / Airlock / 时间轴动作 / 道具专属 / 最终画面）。
// 生成链路在产出后调 compileIntegratedModules 无条件重写模块2/3，
// 从产生源上消灭 CHARACTER_SPECIES_DRIFT 与场景环境漂移两类硬错误。

const CJK_DIRTY_RE = /[\u4e00-\u9fa5]/

// IMD 实际产出格式（enrich 链路）：六个模块全部挤在同一行，模块标记由 LLM 按 IMD 生成
// 模板（doubao.js 的 integratedMultimodalDescription 契约）写出，**英文全称形式**：
//   "Module 2 [Style & Character Lock]: … Module 4 [Timeline Action]: At 00:01.000, … Module 6 [Final Frame]: …"
// 简写 M1:..M6: 形式在库内实测为 0 镜（全 24/24 镜均为 Module N [名称]: 形式）。
// 原实现只认「行首英文特征」（m4 要匹配 /^at\s+0?\d/i）与 M 前缀，对真实格式一个模块都认不出，
// 整段被判成 m1：出片侧 imdAction 恒空 → 镜内动作时间轴丢失。
// 该缺陷长期被 LLM 翻译路径掩盖（action_note_en 顶替 actionDesc，观感正常），
// 仅在 LLM 掉线时暴露——2026-09-29 镜 1-3 实锤：翻译服务 502，M4 时刻表直连失效，
// 出片 prompt 只剩「A wide shot.」+ 光照 + 末帧，动作/声景全丢，成片基本静止并出现悬浮物。
const IMD_MODULE_PREFIX_RE = /^m([1-6])\s*[:：]/i
// 英文全称模块标记（LLM 模板契约）：`Module 4 [Timeline Action]: …` / `Module 4: …`
const IMD_MODULE_EN_PREFIX_RE = /^module\s*([1-6])\s*(?:\[[^\]]*\])?\s*[:：]/i
// 中文模块标记（2026-09-27 实锤）：库内存在「模块5【道具专属声明】…」「模块6【最终画面】…」写法
// （markup 没走 M5: 格式）。不认它的后果是双重的：① 该行靠英文行首特征侥幸归类，
// 整段中文标记进 prompt，被 stripResidualCjk 剥掉汉字后只剩「5」「6」数字前缀；
// ② 更严重——「模块6【最终画面】The final frame:」因行首不是 the final frame 而分类失败，
// 被当成上一模块的续行，M6 末帧内容串进 M5，[Shot 1] 里末帧句被写两遍。
// 因此中文标记必须与 M 前缀同等对待：先认标记，再走英文特征兜底。
const IMD_MODULE_CN_PREFIX_RE = /^模块\s*([1-6])\s*[【\[（(]?/
// 空模块（"M5: none." / "Module 5 [Prop Declaration]: none." / "M5: N/A."）：前缀在但无实质内容，
// 不该作为一个模块产出，否则会被当成道具专属内容写进出片提示词。
const IMD_EMPTY_MODULE_RE = /^(?:m\s*[1-6]|module\s*[1-6]\s*(?:\[[^\]]*\])?|模块\s*[1-6])\s*[:：]?\s*(none|n\/a|无|no(?:ne)?)\s*[.。]?\s*$/i

// 剥掉模块标记（M5: / Module 5 [Prop Declaration]: / 模块5【道具专属声明】）：
// 出片侧只取正文，标记不是提示词内容。
// 三处消费点（v4Video 的 actionDesc / M2 兜底 / 本文件内部）共用一处定义，不各写魔法串。
export function stripImdModuleMarker(line) {
  return String(line || '')
    .replace(/^module\s*[1-6]\s*(?:\[[^\]]*\])?\s*[:：]?\s*/i, '')
    .replace(/^m\s*[1-6]\s*[:：]?\s*/i, '')
    .replace(/^模块\s*[1-6]\s*(?:[【\[（(][^】\])）]*[】\])）])?\s*/, '')
}

// 把「单行多模块」的 IMD 按模块标记切成逻辑行，再交给原有按行分组逻辑。
// 单前缀（原本的多行格式）原样按行切，不破坏既有行为。
function splitImdSegments(text) {
  const out = []
  for (const line of String(text || '').split('\n')) {
    // 三种模块标记同级：M 前缀 / 英文全称 Module N [名称] / 中文「模块5【…】」。
    // 同一行写了多个模块时同样要切开；module 分支必须存在，否则真实产出（全 Module N 形式）
    // 一行都切不开，整段 IMD 归为单个 m1，M4 时刻表与 M5 道具声明永远提取不到。
    const starts = [...line.matchAll(/(?:^|\s)(?=(?:module|m|模块)\s*[1-6]\s*(?:[:：【\[(]|$))/gi)].map((m) => m.index)
    if (starts.length <= 1) { out.push(line); continue }
    // 首个模块标记之前的前导文本必须原样保留：Module N 形式的 m1（"[Shot 1] 镜头声明"）
    // 正好落在这个位置，丢它会让 compileIntegratedModules 回写时把 m1 段永久抹掉
    // （M 前缀形式 starts[0] 恒为 0，本分支不触发，既有行为不变）。
    if (starts[0] > 0) out.push(line.slice(0, starts[0]).trim())
    for (let i = 0; i < starts.length; i++) {
      out.push(line.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : undefined).trim())
    }
  }
  return out
}

// 按行首特征给 IMD 行分类；null 表示续行（归属上一个已识别模块）
function classifyImdLine(line) {
  const t = String(line || '').trim()
  if (!t) return null
  // 模块标记是 enrich 链路的权威来源，优先于英文行首特征识别。
  // 三种写法同级：M 前缀 / 英文全称 Module N [名称] / 中文「模块5【道具专属声明】」。
  const mPrefix = t.match(IMD_MODULE_PREFIX_RE)
  if (mPrefix) return `m${mPrefix[1]}`
  const mEn = t.match(IMD_MODULE_EN_PREFIX_RE)
  if (mEn) return `m${mEn[1]}`
  const mCn = t.match(IMD_MODULE_CN_PREFIX_RE)
  if (mCn) return `m${mCn[1]}`
  if (/^\[shot\b/i.test(t)) return 'm1'
  if (/^the camera opens holding/i.test(t)) return 'airlock'
  if (/remains completely unchanged/i.test(t)) return 'm3'
  if (/^at\s+0?\d/i.test(t)) return 'm4'
  if (/belongs exclusively/i.test(t)) return 'm5'
  if (/^the final frame/i.test(t)) return 'm6'
  if (/exactly as shown/i.test(t)) return 'm2'
  return null
}

// 把 IMD 文本切成模块分组（保持原顺序，未识别行跟随上一组）
export function groupImdModules(text) {
  const lines = splitImdSegments(text)
  const groups = []
  let current = null
  for (const line of lines) {
    if (IMD_EMPTY_MODULE_RE.test(String(line || '').trim())) continue
    const kind = classifyImdLine(line)
    if (kind) {
      current = { kind, lines: [line] }
      groups.push(current)
    } else if (current) {
      current.lines.push(line)
    } else {
      current = { kind: 'other', lines: [line] }
      groups.push(current)
    }
  }
  return groups
}

function toSpeakerList(dialogue) {
  const list = Array.isArray(dialogue) ? dialogue : (dialogue && typeof dialogue === 'object' ? [dialogue] : [])
  const speakers = []
  for (const d of list) {
    const n = String(d?.character || '').trim()
    if (n && !speakers.includes(n)) speakers.push(n)
  }
  return speakers
}

// 程序版模块2（buildModule2 产出）的固定句式：`@<角色>, exactly as shown, <description_en>.`
// 加一行 `Speaking rule for this segment: ...`。它是**外观描述 + 说话规则**，不是本镜叙事。
// 出片侧（v4Video）在 LLM 掉线时用 IMD M2 兜底「镜内叙事」，必须能识别并排除它——
// 否则一旦资产 description_en 补齐、compileIntegratedModules 开始程序重写 M2，
// 资产外观描述会被当成 [Shot 1] 的动作写进 detailed_description（静默语义错误，且与
// subject_definitions 重复占预算）。句式契约放这里，两个模块共用一处定义，不各写一份魔法串。
const PROGRAMMATIC_M2_RE = /exactly as shown|speaking rule for this segment/i
export function isProgrammaticModule2(text) {
  return PROGRAMMATIC_M2_RE.test(String(text || ''))
}

// —— IMD 角色称呼确定性归一（治本 2026-09-27）——
// 出片侧把资产 name_en 首现替换为 <Subject N> 的前提是「IMD 文本里的称呼能与 name_en 对上」。
// 生成侧契约要求写 @中文名，但 LLM 会产生音译/缩略偏差（实测全库：两字中文名 25/25 镜被音译、
// 描述型中文名 0/11 命中）——偏差一旦发生，绑定静默丢失且无人察觉。这里在落库前做一道确定性归一：
//   权威 = 资产表（name/name_en），不引入需维护的别名表，不做开放式模糊匹配。
// 变形③前置词白名单：闭集（介词+连词，语言学上不生长），判「前面是句首/标点/介词/连词」才是
// 叙事指代；形容词/冠词/动词前置一律不动。存量 36 镜 5 例裸省略全部落在白名单内。
const BARE_TAIL_PRE_OK = new Set([
  // 介词
  'against', 'on', 'at', 'by', 'beside', 'near', 'behind', 'under', 'over', 'around', 'from', 'to', 'of',
  'with', 'into', 'onto', 'off', 'past', 'toward', 'towards', 'across', 'along',
  // 连词
  'and', 'but', 'or', 'then', 'as', 'so', 'yet', 'while', 'when', 'till', 'until',
])
// 只处理三条有判据的变形，判不了的保留原样（由 verify-subject-tagging 与出片兜底告警兜住）：
//   ① 音译后缀：token 以 name_en 开头、多 1-2 个小写字母（"LiuBei" → "LiuBe"）。
//      角色名不会出现在外貌/环境描述原文里，故此替换不会误伤逐字复制的资产描述。
//   ② 冠词+尾部缩略（仅多词且 the 开头的 name_en）："the + 末尾连续词段(≥2 词)" 判为指代
//      （"the young warrior" → "the Fierce Young Warrior"）。
//   ③ 无冠词裸省略（同②的 name_en 门槛）：叙事区里裸尾部词段(≥2 词) 判为指代
//      （"Young warrior charging forward" → "The Fierce Young Warrior charging forward"）。
//      判据是结构性的：资产描述原文只出现在程序版模块2（逐字注入，可被 isProgrammaticModule2 的
//      句式信号精确识别），先把这些行屏蔽再替换，叙事区内裸词段即安全。防自伤守卫：长尾优先、
//      禁跟在冠词(the/a/an)后、禁跟在 fierce 后（规范名内部）。裸词段若带形容词前置
//      （"the weary young warrior"）则与②同款盲区：当前全库 0 例，不猜，由核验脚本命中直方图兜底暴露。
// 返回 { text, replaced }；replaced 供调用方记日志/告警。assets.characters 接受行对象或纯名串
// （纯名串没有 name_en 可对照时本函数空转，绝不硬猜）。
export function canonicalizeImdCharacterNames(imd, assets = {}) {
  let text = String(imd || '')
  const replaced = []
  if (!text) return { text, replaced }
  const rows = (assets?.characters || [])
    .map((c) => (typeof c === 'string' ? null : { name: String(c?.name || '').trim(), nameEn: String(c?.name_en || '').trim() }))
    .filter((r) => r && r.name && r.nameEn && r.nameEn.length >= 4 && !CJK_DIRTY_RE.test(r.nameEn))
  // 程序版 M2 保护区：buildModule2 产出的行（"@角色, exactly as shown, desc." 与 Speaking rule 行）
  // 里是逐字复制的资产描述原文（"a weary young warrior"），变形③绝不可触碰；变形①②按既有
  // 不变式本就不碰（角色名不出现在描述里、描述无 the+词段形态）。按行屏蔽，处理完再还原。
  const protectedLines = []
  text = text.replace(/^[^\n]*(?:exactly as shown|speaking rule for this segment)[^\n]*$/gim, (line) => {
    protectedLines.push(line)
    return ` M2PROT${protectedLines.length - 1} `
  })
  for (const r of rows) {
    const esc = r.nameEn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // 变形①：音译后缀（全词界、大小写不敏感，必须真带 1-2 个尾巴字母）
    const v1 = new RegExp(`\\b${esc}([a-z]{1,2})\\b`, 'gi')
    let m, n1 = 0
    while ((m = v1.exec(text))) {
      if (m[1]) {
        text = text.slice(0, m.index) + r.nameEn + text.slice(m.index + m[0].length)
        v1.lastIndex = m.index + r.nameEn.length
        n1++
      }
    }
    if (n1) replaced.push({ name: r.name, kind: 'romanization-suffix', count: n1 })
    // 变形②：冠词 + 尾部缩略（the 开头、≥3 词的 name_en 才有意义）
    const words = r.nameEn.split(/\s+/)
    if (words.length >= 3 && /^the$/i.test(words[0])) {
      for (let start = 2; start <= words.length - 2; start++) {
        const tail = words.slice(start).join(' ')
        const tailEsc = tail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const v2 = new RegExp(`\\bthe ${tailEsc}\\b`, 'gi')
        let mm, n2 = 0
        while ((mm = v2.exec(text))) {
          text = text.slice(0, mm.index) + r.nameEn + text.slice(mm.index + mm[0].length)
          v2.lastIndex = mm.index + r.nameEn.length
          n2++
        }
        if (n2) { replaced.push({ name: r.name, kind: 'article-tail', count: n2 }); break }
      }
    }
    // 变形③：无冠词裸省略（同②的 name_en 门槛）。start 从 1（去 the 后的最长尾段）升序遍历，
    // 长尾先替。防误伤判据 = 前置词白名单（闭集，不生长）：匹配点前是句首/标点，或前置词是
    // 介词/连词，才判为叙事指代；前置任何其他实词（冠词 a/an/the、形容词 weary/old、
    // 动词、代词…）一律不动——资产描述原文（"a weary young warrior"）正是形容词链前置，
    // 逐字存活；规范名内部尾段（前是 the/fierce）同理被白名单挡住。被挡的残留裸省略与
    // 形容词插入形态（"the weary young warrior"）同款处理：不猜，由 verify-subject-tagging
    // 命中直方图兜底暴露。句首大写匹配 → "The ..."，小写 → "the ..."。
    if (words.length >= 3 && /^the$/i.test(words[0])) {
      for (let start = 1; start <= words.length - 2; start++) {
        const tail = words.slice(start).join(' ')
        const tailEsc = tail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const v3 = new RegExp(`\\b${tailEsc}\\b`, 'gi')
        let mv, n3 = 0
        while ((mv = v3.exec(text))) {
          const before = text.slice(Math.max(0, mv.index - 40), mv.index)
          const preWord = before.match(/([A-Za-z]+)\s*$/)
          const pre = preWord ? preWord[1].toLowerCase() : ''
          if (pre && !BARE_TAIL_PRE_OK.has(pre)) { v3.lastIndex = mv.index + mv[0].length; continue }
          const canonical = /^[A-Z]/.test(mv[0]) ? r.nameEn.replace(/^the /, 'The ') : r.nameEn
          text = text.slice(0, mv.index) + canonical + text.slice(mv.index + mv[0].length)
          v3.lastIndex = mv.index + canonical.length
          n3++
        }
        if (n3) replaced.push({ name: r.name, kind: 'bare-tail', count: n3 })
      }
    }
  }
  if (protectedLines.length) {
    text = text.replace(/ M2PROT(\d+) /g, (_, i) => protectedLines[Number(i)])
  }
  return { text, replaced }
}

// 模块2 程序版：每个出场角色逐字注入资产库 description_en + 说话规则（由台词推导）。
// 任一角色缺英文描述则返回 null（整段保留 LLM 版，避免中文混入英文外貌锁定模块导致出图角色漂移——IMD 是出图提示词，不进 H3）。
export function buildModule2({ characters = [], dialogue = null } = {}, assets = null) {
  const charMap = new Map()
  for (const c of assets?.characters || []) {
    const name = typeof c === 'string' ? c : String(c?.name || '').trim()
    if (name) charMap.set(name, c)
  }
  const names = [...new Set((characters || []).map((n) => String(n || '').trim()).filter(Boolean))]
  if (!names.length) return null
  const parts = []
  for (const name of names) {
    const row = charMap.get(name)
    const descEn = row && typeof row !== 'string' ? String(row.description_en || '').trim() : ''
    if (!descEn || CJK_DIRTY_RE.test(descEn)) return null
    parts.push(`@${name}, exactly as shown, ${descEn.replace(/[.\s]+$/, '')}.`)
  }
  const speakers = toSpeakerList(dialogue).filter((n) => names.includes(n))
  const silent = names.filter((n) => !speakers.includes(n))
  if (speakers.length && silent.length) {
    parts.push(`Speaking rule for this segment: ${speakers.map((n) => `@${n}`).join(' and ')} speak${speakers.length === 1 ? 's' : ''}; ${silent.map((n) => `@${n}`).join(' and ')} remain${silent.length === 1 ? 's' : ''} completely silent with lip${silent.length === 1 ? '' : 's'} closed.`)
  } else if (speakers.length) {
    parts.push(`Speaking rule for this segment: ${speakers.map((n) => `@${n}`).join(' and ')} speak${speakers.length === 1 ? 's' : ''}.`)
  } else {
    parts.push('Speaking rule for this segment: no dialogue — all characters\' lips remain completely closed.')
  }
  return parts.join('\n')
}

// 模块3 程序版：每个出场场景逐字注入资产库 summary_en + 冻结声明 + 光影常量。
// 任一场景缺英文摘要则返回 null（整段保留 LLM 版）。
export function buildModule3({ sceneAssets = [] } = {}, assets = null) {
  const sceneMap = new Map()
  for (const s of assets?.scenes || []) {
    const name = typeof s === 'string' ? s : String(s?.title || s?.name || '').trim()
    if (name) sceneMap.set(name, s)
  }
  const names = [...new Set((sceneAssets || []).map((n) => String(n || '').trim()).filter(Boolean))]
  if (!names.length) return null
  const parts = []
  for (const name of names) {
    const row = sceneMap.get(name)
    const en = row && typeof row !== 'string' ? String(row.summary_en || '').trim() : ''
    if (!en || CJK_DIRTY_RE.test(en)) return null
    parts.push(`The ${en.replace(/[.\s]+$/, '')} remains completely unchanged in structure, color, and arrangement throughout the entire segment — no layout shifts, no colors fade, no objects disappear.`)
    const lighting = row && typeof row !== 'string' ? String(row.lighting_en || '').trim() : ''
    if (lighting && !CJK_DIRTY_RE.test(lighting)) {
      parts.push(`Lighting stays constant: ${lighting.replace(/[.\s]+$/, '')}.`)
    }
  }
  return parts.join('\n')
}

// 混合编译主入口：重写 IMD 的模块2/3，其余模块原样保留。
// 返回 { text, injected, kept }：injected = 本次程序注入的模块；kept = 资产缺英文原文而保留 LLM 版的模块。
export function compileIntegratedModules(imd, shotInfo = {}, assets = null) {
  const text = String(imd || '')
  if (!text || !assets) return { text, injected: [], kept: [] }
  const groups = groupImdModules(text)
  const module2 = buildModule2(shotInfo, assets)
  const module3 = buildModule3(shotInfo, assets)
  const out = []
  const injected = []
  const kept = []
  let m2Emitted = false
  let m3Emitted = false
  for (const g of groups) {
    if (g.kind === 'm2') {
      if (module2) {
        if (!m2Emitted) {
          out.push(module2)
          injected.push('m2')
          m2Emitted = true
        }
        // 程序版已覆盖，后续 m2 续组（多角色分段）不再需要
      } else {
        out.push(g.lines.join('\n').trim())
        if (!m2Emitted) { kept.push('m2'); m2Emitted = true }
      }
      continue
    }
    if (g.kind === 'm3') {
      if (module3) {
        if (!m3Emitted) {
          out.push(module3)
          injected.push('m3')
          m3Emitted = true
        }
      } else {
        out.push(g.lines.join('\n').trim())
        if (!m3Emitted) { kept.push('m3'); m3Emitted = true }
      }
      continue
    }
    out.push(g.lines.join('\n').replace(/\s+$/, ''))
  }
  return { text: out.filter((s) => s !== '').join('\n'), injected, kept }
}
