// 台词字段（shots.dialogue）的**唯一读写口径**（2026-09-18，第五轮 P0-3）。
//
// 事故回放（为什么需要这个文件）：
//   shots.dialogue 的契约是「JSON 数组 [{character, tone, text, startTime}]」——见
//   ai/doubao.js 分镜 normalize 的注释与 AGENTS.md。但库里实际出现了 **4 字符字符串 "null"**：
//   第2集 ep4 的 42 镜里有 25 镜是这个值。它既不是 SQL NULL 也不是 []，于是**每个消费方
//   都得自己写一遍 `raw !== 'null' && raw !== '[]'` 才不出事**：
//     cameraAngle.js / shotClassifier.js（有无台词判据）/ generate-video.js（单镜闸 + 段级闸
//     + 音色收集 + 段内说话人收集）/ segmentBuilder.js / episodes.js ——六份各自为政的特判
//     （QA 清单只点了 5 处，shotClassifier.js:95 是收口时扫出来的第 6 份）。
//   这是典型的「契约破了用补丁糊」：任何新增消费方漏写一次，就是一次台词丢失或"假装有台词"。
//   （"假装有台词"更阴：出片闸门放行 → 钱花了 → H3 里没有 <d> 行 → 成片压根没人说话。）
//
// 根因（写入侧）：routes/episodes.js 保存分镜时用
//     `typeof shot.dialogue === 'object' ? JSON.stringify(shot.dialogue) : ...`
//   而 `typeof null === 'object'` 为真 → JSON.stringify(null) === 'null' → 落库即 `"null"`。
//   故本模块同时收口写入侧 serializeDialogue：null/undefined 一律落成 ''，
//   **从源头不再产出 "null"**（比逐个修生产方更彻底：任何生产者传 null 都拦得住）。
//
// 为什么判据放这里、不放 ai/shared.js：
//   shared.js 是「字符串清洗 / 英文名挑选 / CJK 判据」的单点，且本轮正由 software-engineer-2
//   并发修改（避免写冲突）；dialogue 是**结构化字段契约**，与本模块零依赖、纯函数，
//   单独立模块更安全，也更好测（server/tests/dataContract.test.mjs）。

/**
 * 读取侧唯一入口：把任意形态的 dialogue 归一为**台词行数组**，**永不抛异常**。
 *
 * 接受：已解析的数组 / 已解析的对象 / JSON 串 / null / undefined / '' / 脏串。
 * 返回：数组（无台词时恒为 []），调用方可以直接 `for (const d of parseDialogue(x))`。
 *
 * @param {any} raw
 * @returns {Array<Object|string>} 台词行数组；无台词恒为 []
 */
export function parseDialogue(raw) {
  // 已经是结构化值（LLM 直出对象 / 前端已经 JSON.parse 过的对象）
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === 'object') return [raw]

  const s = String(raw ?? '').trim()
  if (!s) return []

  let p
  try {
    p = JSON.parse(s)
  } catch {
    // 脏串（含 "undefined"、裸中文、"[" 截断等）：按无台词处理。
    // 吞异常是刻意的——台词字段脏不该反过来搞挂出片主流程（与 alerts.js 同口径）。
    return []
  }
  if (Array.isArray(p)) return p
  // 历史遗留的**单句对象** {character, tone, text}：包成单元素数组把他保住。
  // ⚠️ 这里刻意不按「非数组一律返回 []」处理——那样做会把这些行直接丢掉，
  //    而"台词静默丢失"正是本项目最贵的一类故障（钱花了、成片没人说话）。
  //    空对象 {} 没有任何键，包成 [{}] 只会给下游多一行空壳，故返回 []。
  if (p && typeof p === 'object') return Object.keys(p).length ? [p] : []
  // 标量（JSON 里的裸字符串/数字/布尔/null）：历史上从未合法产出过台词，按无台词
  return []
}

// 台词正文的候选键：与 ai/videoPrompt.js 的取值口径一致（d.text || d.line || d.content）。
// 只为兼容老数据里正文写在 line/content 上的行，避免"有台词被判成没台词"而 400 拦掉本可出片的镜。
// 不猜语义，也不做同义替换——就是三个已知键的机械兜底。
const TEXT_KEYS = ['text', 'line', 'content']

/**
 * 有台词判据（替代散落各处的 `raw !== 'null' && raw !== '[]'`）。
 * 「有台词」= 至少一行有**非空正文**——只有角色名没有话的行（脏数据）不算台词：
 * 出片闸门放行这种行 = 花币出一个没人说话的成片。
 *
 * @param {any} raw
 * @returns {boolean}
 */
export function hasDialogue(raw) {
  return parseDialogue(raw).some((d) =>
    TEXT_KEYS.some((k) => String(d?.[k] ?? '').trim() !== '')
  )
}

/**
 * 写入侧唯一入口：把 dialogue 序列化成落库字符串。
 *
 * 与旧的 `JSON.stringify(shot.dialogue)` 的唯一差别：**null/undefined 落成 ''，不再产出 "null"**。
 * 已是字符串的按原样透传（前端可能直接回传序列化串）；
 * 数组与非 null 对象按原语义 JSON 序列化（保留历史"单对象也照存"的行为，
 * 读取侧 parseDialogue 已能把它包成单元素数组）。
 * JSON.stringify 自身可能抛（循环引用 / BigInt）→ 吞掉落 ''，不让写分镜这块挂掉。
 *
 * @param {any} v
 * @returns {string}
 */
export function serializeDialogue(v) {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v)
    } catch {
      return ''
    }
  }
  return ''
}
