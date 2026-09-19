// 公共工具函数 —— 消除跨模块重复实现
//
// 背景：整改前同一函数在 2~3 个文件里各写一份，改一处不生效。
// 本模块只收「行为完全等价」的实现；**行为不同的绝不合并**（那会静默改变出片行为），
// 差异项在下方「故意不合并清单」里逐条记录，并在原处留了防误合注释。
//
// ── 已合并（行为等价） ────────────────────────────────────────────────
//   clean(s)            文本清洗：去 @ 符号 + 折叠空白 + trim
//   escapeRegExp(s)     正则元字符转义
//   mimeFromExt(name)   按扩展名推断 MIME（含音频/图片全表，超集版本）
//   netErrMsg(e)        网络错误消息：拼上 cause 的 code/message
//   removeLocalUploads(urls, uploadDir)  删除 /uploads/ 下的本地文件（带路径穿越防护）
//   uploadsUrlToAbs(url, uploadDir)      /uploads/ URL → 本地绝对路径（保留子目录 + 防穿越）
//   assertSafeDownloadTarget(url)       下载目标 SSRF 守卫（只放行可解析到公网地址的 http(s)）
//   pickEnglish(s)      只接受不含中日韩字符的文本（H3 英文正文「宁缺勿脏」判据，返回 '' 表示弃用）
//   stripResidualCjk(s) 删词保段兜底：删掉残留 CJK 词、保住整段英文（仅用于翻译层输出）
//   resolveAssetName(nameEn, nameCn)  资产名取英文（英文名 → 删残 CJK → 中文名经 pickEnglish 复核）
//   truncateStyle(s, max)  画风串按词边界截断（超长时落在空格处，不截半截单词）
//   formatCutTimestamp(sec)  相对秒 → `MM:SS.mmm`（H3 官方切点格式；先归整整数毫秒再拆分，防 4 位毫秒）
//
// ⚠️ 上述三个「英文护栏」判据曾在本仓库各写 3 份拷贝（ai/v4Video.js 加固版 + ai/videoPrompt.js、
//    ai/segmentPrompt.js 两份未加固版），只有 v4Video 那份在「浮冰」事件后装了 pickEnglish 复核，
//    另外两份英文名为空时回退中文名 → 中文落进 H3 英文正文（段级被校验器硬拦，V2 链路静默劣化）。
//    2026-09-18 收口到此单点；三个 prompt 构造器一律 import 使用，禁止再抄一份。
//
// ── 故意不合并清单（行为不同，合并＝改行为） ──────────────────────────
//   1. normalizeVideoParams
//      · ai/multiRefVideo.js 默认 '9:16 (Portrait Widescreen)' / 5s
//      · ai/v4Video.js       默认 '9:16 (Portrait Widescreen)' / clamp 3~15s
//      两处默认宽高比 2026-09-11 起统一为竖屏 9:16，与 projects.aspect_ratio 库级默认
//      同源（当前项目=一二布布系列竖屏短剧）；仍保留两份实现——前端会显式传项目级
//      aspect_ratio 覆盖默认，两处各自兜底语义独立。
//      → 保留各自实现，原处有 ⚠ 注释。
//   2. shrinkRef
//      · ai/visionaryImage.js  签名 (buffer, filename, mimeType)，用 promisify(execFile)
//      · ai/ziklImage.js       签名 (ref{...})，2026-09-11 起同样用 promisify(execFile)
//        （旧版对回调版 execFile 直接 await，不等转码完成 → 静默放弃压缩，已修复）
//      → 签名与返回结构不同，保留各自实现。
//   3. clean 的「不折叠空白」变体（ai/directorRequest.js 内 3 处局部定义）
//      · briefShot / extractBlockingText / buildShotGridContentApp 用的是
//        `(s||'').replace(/@/g,'').trim()` —— **不折叠空白**
//      · 本模块的 clean **会**折叠连续空白/换行/制表符
//      当描述文本含多行或缩进时，两者输出不同（已验证）。这些位置是把文本拼进
//      LLM prompt 模板，折叠会改变换行结构 → 保留原实现。
//
// 用法：import { clean } from './shared.js'
import path from 'node:path'
import fs from 'node:fs'
import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { query } from '../db.js'

/**
 * 文本清洗：去掉 @ 锁定符号（历史遗留标记）、折叠连续空白、去首尾空格。
 * 等价于原 videoPrompt.js / generate.js 里的 cleanText()。
 */
export function clean(s) {
  return String(s || '')
    .replace(/@/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// ── 英文正文「脏字符」唯一判据（R15，2026-09-18）─────────────────────────────
//
// 整改前有三份不同源的拷贝：pickEnglish 用窄集（表意/假名/谚文）、stripResidualCjk 用扩集
// （+CJK 标点与全角形式）、ai/segmentPrompt.js 的 validateSegmentPrompt 又内联一份
// [\u4e00-\u9fff]。QA 实测出的漏洞：pickEnglish('：') === '：'（全角冒号 U+FF1A 不在窄集里）
// → 段级 override 只传一个全角标点就能绕过闸门、中文泄漏**漏报**。故收敛为唯一字符集。
//
// 字符集 = 中日韩统一表意文字（基本区 + 扩展 A + 兼容表意）+ 日文假名 + 谚文
//        + CJK 标点 + 全角/半角形式 + 竖排形式 + CJK 部首/康熙部首/笔画。
//
// F2（2026-09-18，第四轮）字符集定案——逐区间评估「英文正文会不会合法出现」：
//   加 \u3400-\u4dbf  CJK 扩展 A：真汉字（如 㐀），绝不合法出现在英文正文。此前
//                     stylePromptEn 单独覆盖它、其余消费端漏判 → 口径分裂，收口补齐。
//   加 ︐-︙  竖排形式标点（竖排逗号/句号等）：绝不合法出现在英文正文。
//   加 \uf900-\ufaff  CJK 兼容表意文字：真汉字的重复编码，同基本区一样判脏。
//   加 \u2e80-\u2eff / \u2f00-\u2fdf / \u31c0-\u31ef  CJK 部首补充/康熙部首/笔画：
//                     全是汉字构件符号，英文正文不可能合法出现。
//   不加 \u3200-\u32ff（Enclosed CJK）：含 ①-⑳ 等圈码/括号文数字，可作列表标记出现在
//                     英文文本里，且不是表意文字（模型不会当中文念）→ 误伤风险 > 收益。
//   不加 Ext B+（U+20000 起，surrogate pair）：生僻度极高、本项目数据从未出现，
//                     维护代理对区间成本高 → 记为已知边界，见第四轮报告。
// ⚠️ 刻意保持**非全局**（无 lastIndex 状态）：本常量供 .test() 反复调用；
//    需要「删词」的用途一律用下方 RESIDUAL_CJK_RE（= 本集合 + 贪婪连续 + g）。
// ⚠️ 消费端一律从 CJK_DIRTY_RE 派生，**禁止再写字面量**（一写字面量就又会漂移）。
export const CJK_DIRTY_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af\u3000-\u303f\ufe30-\ufe4f\ufe10-\ufe19\u2e80-\u2eff\u2f00-\u2fdf\u31c0-\u31ef\uff00-\uffef]/

/**
 * 只接受不含脏字符的文本——用于**必须全英文**的位置（H3 prompt 英文正文）。
 * 返回 '' 表示「这段不能进英文正文」，调用方自行降级（宁缺勿脏，绝不把中文塞进英文句子）。
 */
export function pickEnglish(s) {
  const v = clean(s)
  return v && !CJK_DIRTY_RE.test(v) ? v : ''
}

// 「残 CJK」完整删词集 = 脏字符集 + 贪婪连续 + 全局（stripResidualCjk 删词保段用）。
//
// 为何必须带标点：真实中文串几乎都含全角标点（如「剧本节拍未演出：小熊倒地」的「：」U+FF1A）。
// 只删表意文字会留下「：」这类标点残渣——它不含汉字，validateSegmentPrompt 也不报，
// 但会让「守卫后为空」判据失效、注入出 `MANDATORY CORRECTION: ：` 这种空壳（R1 retryNote 场景）。
// 标点属于「残 CJK」的一部分，删掉才真正达到「宁缺勿脏」。
const RESIDUAL_CJK_RE = new RegExp(CJK_DIRTY_RE.source + '+', 'g')

/**
 * 删词保段兜底：翻译层输出主体必为英文，残留 CJK 只可能是无英文名映射的资产名。
 * pickEnglish 的「整段丢弃」惩罚过重——删掉残留 CJK 词、保住整段英文描述。
 * 仅用于翻译层输出，不得用于 shot.description 等全中文原字段。
 */
export function stripResidualCjk(s) {
  const v = clean(s)
  if (!v) return ''
  return v
    .replace(RESIDUAL_CJK_RE, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim()
}

// R14（2026-09-18）：「至少含一个 ASCII 字母」判据。
//
// 痛点：LLM 译文可能只剩标点——例如中文观片反馈翻英文后输出 ',;'（翻完只剩半角标点）。
// 这类串既不含任何脏字符（stripResidualCjk 原样返回）、也非空（truthy），
// 于是旧守卫 `if (retryNoteEn)` 放它过关 → prompt 里多出一句 `MANDATORY CORRECTION: ,;` 空壳。
// 空壳会占掉模型注意力、又不含任何可执行指令，等于给英文正文塞噪声。
// 判据：必须至少含一个英文字母才算「有内容的英文」。单点在此，调用方禁止就地抄正则。
const ASCII_LETTER_RE = /[A-Za-z]/

/**
 * 抽取「可安全注入英文正文」的片段：先删残 CJK，再要求非空且**至少含一个 ASCII 字母**。
 *
 * 与 pickEnglish 的分工：
 *   · pickEnglish —— 严格闸门：含任一脏字符即整段弃用（用于资产英文名等短常量）；
 *   · pickInjectableEnglish —— 先救后筛：允许删掉残留中文词保住英文主体（用于译文类长文本），
 *     但删完之后若只剩标点/数字/符号，仍判定为不可用（返回 ''）。
 *
 * @param {any} s 候选文本
 * @returns {string} 可注入的英文串；不可注入返回 ''（调用方据此整句不注入，杜绝空壳）
 */
export function pickInjectableEnglish(s) {
  const v = stripResidualCjk(s)
  return v && ASCII_LETTER_RE.test(v) ? v : ''
}

/**
 * 资产名（角色/场景/道具）取英文：英文常量优先；含残 CJK 则删词保段；中文原名仅作最后标签，
 * 但**必须经 pickEnglish 复核**——中文名一律不得进英文正文（「浮冰」事件教训）。
 * 取不到时返回 ''，由调用方以 `reference N` 之类中立标签兜底。
 */
export function resolveAssetName(nameEn, nameCn) {
  return pickEnglish(nameEn) || stripResidualCjk(nameEn) || pickEnglish(nameCn)
}

/**
 * 画风串截断：超长时**按词边界**截断，避免把单词截成半截（如 "atmosphere" → "at"）。
 * 词边界落在 max 的前半段才采用（`i >= max * 0.5`）——否则说明整段没有合适空格，
 * 宁可硬截也不退化成把前半段几乎全丢。
 *
 * ⚠️ 三个 prompt 构造器（v4Video / videoPrompt / segmentPrompt）必须共用本实现：
 *    segmentPrompt 旧版是 `s.slice(0,max).trim()+'…'`（无词边界、且加省略号），
 *    v4Video/videoPrompt 是词边界版——收口到此单点，防再次漂移。
 */
export function truncateStyle(s, max = 300) {
  const v = clean(s)
  if (v.length <= max) return v
  const cut = v.slice(0, max)
  const i = cut.lastIndexOf(' ')
  return i >= max * 0.5 ? cut.slice(0, i) : cut
}

/**
 * 段内/镜内相对秒 → `MM:SS.mmm`（H3 官方切点时间戳格式）。
 *
 * 毫秒必须「先归整到整数毫秒、再拆分」——旧写法 `Math.round(小数部分*1000)` 在
 * 小数部分 ≥0.9995 时会得到 1000，padStart(3) 不截断 → 输出 4 位毫秒
 * （`formatCutTimestamp(59.9996)` → `00:59.1000`），切点时间戳非法（审计 P0-C）。
 * 现在 formatCutTimestamp(59.9996) 正确进位为 `01:00.000`。
 *
 * 格式固定两段式（MM:SS.mmm），**不要改成三段式 HH:MM:SS.mmm**——
 * validateSegmentPrompt 的正则与单镜通道都按两段式契约校验，改了会全段校验失败。
 *
 * ⚠️ 三个 prompt 构造器（v4Video / videoPrompt / segmentPrompt）必须共用本实现：
 *    单镜两条通道旧写法有 4 位毫秒缺陷（小数部分 ≥0.9995 → `00:12.1000`），
 *    只有段级修好过；收口到此单点，防再次漂移。
 */
export function formatCutTimestamp(sec) {
  const t = Math.max(0, Math.round(Number(sec) * 1000))
  const total = Math.floor(t / 1000)
  const mmm = String(t % 1000).padStart(3, '0')
  const mm = String(Math.floor(total / 60)).padStart(2, '0')
  const ss = String(total % 60).padStart(2, '0')
  return `${mm}:${ss}.${mmm}`
}

/**
 * 正则元字符转义：把字符串安全地嵌进 RegExp 构造器。
 * 等价于原 doubao.js / ipRouter.js 里的 escapeRegExp()（取超集：带 String() 强转）。
 */
export function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const AUDIO_MIME_MAP = {
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
  ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', webm: 'audio/webm',
  wma: 'audio/x-ms-wma', amr: 'audio/amr', mpeg: 'audio/mpeg',
}

/**
 * 按文件扩展名推断 MIME 类型。
 * 覆盖 音频表 + jpg/jpeg/webp/png，未识别回落 'image/png'。
 * 等价于原 runninghub.js / visionaryImage.js / ziklImage.js 三处实现（此处为超集）。
 */
export function mimeFromExt(filename) {
  const ext = (String(filename || '').split('.').pop() || '').toLowerCase()
  if (AUDIO_MIME_MAP[ext]) return AUDIO_MIME_MAP[ext]
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  return 'image/png'
}

/**
 * 网络错误消息格式化：把 undici 的 e.cause.code / e.cause.message 拼到主消息后。
 * 等价于原 visionaryImage.js / ziklImage.js 里的 netErrMsg()。
 */
export function netErrMsg(e) {
  const cause = e?.cause?.code || e?.cause?.message
  return cause ? `${e.message} (${cause})` : e?.message
}

/**
 * 删除 /uploads/ 下的本地文件（urls 为 `/uploads/xxx` 形式的路径数组）。
 * 含路径穿越防护：只取 basename，拒绝 . / ..；单文件失败不阻塞。
 *
 * @param {string[]} urls       形如 ['/uploads/a.png'] 的路径列表（允许 undefined）
 * @param {string}   uploadDir  上传目录绝对路径
 */
export function removeLocalUploads(urls, uploadDir) {
  const root = path.resolve(uploadDir)
  for (const u of urls || []) {
    if (!u || !String(u).startsWith('/uploads/')) continue
    try {
      // 保留子目录：资产库文件在 /uploads/library/... 下。旧 basename 写法会把删除目标
      // 错指到根目录同名文件（误删无关文件），子目录文件则永远清不掉（泄漏）。
      // 防穿越：resolve 后必须仍落在 uploadDir 内，剥查询串防 cache-buster
      const rel = decodeURIComponent(String(u).split(/[?#]/)[0]).replace(/^\/uploads\//, '')
      const abs = path.resolve(root, rel)
      if (abs !== root && !abs.startsWith(root + path.sep)) continue
      fs.rmSync(abs, { force: true })
    } catch { /* 单个文件删除失败不阻塞 */ }
  }
}

/**
 * `/uploads/...` URL → 本地绝对路径（**保留子目录**，含路径穿越防护）。
 *
 * 为什么必须保留子目录（2026-09-16 审核修复 P0-2/P0-3）：
 *   项目里存在多个 `/uploads/` 子目录承载不同产物——
 *     `segments/segN/`（段成片按镜边界切片）、`library/scene/`（资产库图）、
 *     `continuity/`（末帧接力锚）、`review/`、`style_anchor/` 等。
 *   旧实现用 `path.basename(url)` 把路径压成文件名再拼到 uploads 根，子目录整段丢失
 *   → 指向不存在的路径。这类"扁平化"在同一仓库出现过两次真实故障：
 *     · generate-post.js 拼片：切片视频 `/uploads/segments/segN/x.mp4` 找不到 → 400
 *     · postHooks.js 末帧接力：同款写法，段切片产出的镜重出时接力失败
 *   而 shotReview.js / seamCheck.js / runninghub.js 用的是保留子目录的正确写法——
 *   口径分裂正是本仓库反复记录过的漂移源，故收口到本函数单点。
 *
 * 防穿越：`resolve` 后必须仍落在 uploadDir 内（拒绝 `..` 与绝对路径逃逸）；
 * 先剥查询串（`?t=...` cache-buster）与 `#` 锚点，文件系统不认。
 *
 * 文件不存在时返回 null（调用方自行决定报错文案），不抛异常。
 *
 * @param {string} url       形如 '/uploads/segments/seg4/1-1_142.mp4'
 * @param {string} uploadDir uploads 目录绝对路径
 * @returns {string|null}    绝对路径；非 /uploads/ 前缀、越界、或文件不存在时返回 null
 */
export function uploadsUrlToAbs(url, uploadDir) {
  if (!url || typeof url !== 'string' || !url.startsWith('/uploads/')) return null
  try {
    const root = path.resolve(uploadDir)
    const rel = decodeURIComponent(String(url).split(/[?#]/)[0]).replace(/^\/uploads\//, '')
    if (!rel) return null
    const abs = path.resolve(root, rel)
    // 防穿越：必须在 uploadDir 之内（root 本身或 root + 分隔符开头）
    if (abs !== root && !abs.startsWith(root + path.sep)) return null
    return fs.existsSync(abs) ? abs : null
  } catch {
    return null // decodeURIComponent 等异常一律视为不可解析
  }
}

// ── 上传文件引用计数 ─────────────────────────────────────────────────
// 同一 /uploads/ 文件常被多行共享：IP→项目主设定→集角色副本的同步链复制的是 URL 字符串、
// 素材库选图/跨项目「从项目选择」也是复制 URL。删除任一实体时直接物理删文件会把
// 其他行还在引用的图/音色删成死链（删一集导致全项目角色图裂开的实锤事故路径）。
// 正确姿势：先删 DB 行，再用本函数筛出「全库已无任何引用」的候选，最后才删文件。
const UPLOAD_REF_SQL = [
  'SELECT image_url AS u FROM characters UNION ALL SELECT audio_url AS u FROM characters',
  'SELECT image_url AS u FROM project_characters UNION ALL SELECT audio_url AS u FROM project_characters',
  'SELECT image_url AS u FROM ip_characters UNION ALL SELECT audio_url AS u FROM ip_characters',
  'SELECT image_url AS u FROM props',
  'SELECT image_url AS u FROM scenes',
  `SELECT storyboard_url AS u FROM shots UNION ALL SELECT frame_url AS u FROM shots
   UNION ALL SELECT frame_url2 AS u FROM shots UNION ALL SELECT blocking_url AS u FROM shots
   UNION ALL SELECT video_url AS u FROM shots UNION ALL SELECT continuity_url AS u FROM shots`,
  'SELECT grid_image_url AS u FROM storyboard_scenes',
  'SELECT cover_url AS u FROM library_assets',
]

/**
 * 从候选 URL 中筛出「全库已无引用」的子集（可安全物理删除）。
 * 调用时机必须在相关 DB 行删除之后——否则自己刚删的行还会被算作引用。
 * @param {string[]} urls 候选 /uploads/ URL
 * @returns {string[]} 无引用的子集
 */
export function filterUnreferencedUploadUrls(urls) {
  const candidates = [...new Set((urls || []).map(String).filter((u) => u.startsWith('/uploads/')))]
  if (!candidates.length) return []
  const referenced = new Set()
  for (const sql of UPLOAD_REF_SQL) {
    try {
      for (const row of query(sql)) { if (row.u) referenced.add(row.u) }
    } catch { /* 表不存在等场景跳过该源，不阻塞删除 */ }
  }
  return candidates.filter((u) => !referenced.has(u))
}

// ── SSRF 防护（2026-09-16） ───────────────────────────────────────────────
//
// 威胁：`shots.video_url` 可由用户经 `PUT /episodes/:id/shots/:shotId` 直接写入，
// 而服务端会拿它去**主动下载**（接缝检测 / 观片闸 / 末帧接力 / 打捞，全部走
// runninghub.insecureDownload）。填 `http://169.254.169.254/latest/meta-data/` 这类地址
// 就能让服务端代替用户请求内网服务或云元数据，响应体还会落盘到 uploads 再被静态服务读回
// —— 完整的「读取 + 外带」链路。原实现还带 `rejectUnauthorized:false`（不校验证书），
// 中间人可篡改。下载点有 20+ 处，故守卫收敛在 `assertSafeDownloadTarget` 单点，
// 由 `insecureDownload` 在每一跳（含重定向）调用，避免逐个调用方加固漏网。

/** 判断 IPv4 是否属于内网 / 保留网段（无法从公网路由到的地址） */
function isPrivateIPv4(ip) {
  const p = String(ip).split('.').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = p
  if (a === 0) return true                              // 0.0.0.0/8   本机
  if (a === 10) return true                             // 10/8        私网
  if (a === 127) return true                            // 127/8       环回
  if (a === 169 && b === 254) return true               // 169.254/16  链路本地（云元数据）
  if (a === 172 && b >= 16 && b <= 31) return true      // 172.16/12   私网
  if (a === 192 && b === 168) return true               // 192.168/16  私网
  if (a === 192 && b === 0 && p[2] === 0) return true   // 192.0.0/24  IETF 保留
  if (a === 100 && b >= 64 && b <= 127) return true     // 100.64/10   CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true  // 198.18/15   基准测试
  if (a >= 224) return true                             // 组播 + 保留 + 广播
  return false
}

/** 把十六进制组（如 '7f00:1'）还原成点分 IPv4（'127.0.0.1'）；解析不出返回空串 */
function hexGroupsToIPv4(rest) {
  const gs = String(rest).split(':').filter(Boolean)
  if (gs.length < 2) return ''
  const hi = parseInt(gs[gs.length - 2], 16)
  const lo = parseInt(gs[gs.length - 1], 16)
  if (!Number.isInteger(hi) || !Number.isInteger(lo) || hi < 0 || lo < 0) return ''
  return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`
}

/** 判断 IPv6 是否属于内网 / 保留网段 */
function isPrivateIPv6(ip) {
  const s = String(ip).toLowerCase().replace(/^\[|\]$/g, '')
  if (s === '::' || s === '::1') return true            // 未指定 / 环回
  if (s.startsWith('fe80')) return true                 // 链路本地
  if (s.startsWith('fec0')) return true                 // 站点本地（已废弃）
  if (/^f[cd]/.test(s)) return true                     // fc00::/7   唯一本地
  if (s.startsWith('ff')) return true                   // 组播

  // IPv4 映射/兼容地址必须还原成 IPv4 再判 —— 这是真实绕过路径：
  // `http://[::ffff:169.254.169.254]/` 会被 URL 规范化为 `[::ffff:a9fe:a9fe]`（十六进制形式），
  // 只匹配点分形式的正则会漏掉它，云元数据端点就此可达。
  const mapped = s.match(/^::ffff:(.+)$/) || s.match(/^::(?!1$|ffff:)(.+)$/)
  if (mapped) {
    const rest = mapped[1]
    const v4 = rest.includes('.') ? rest : hexGroupsToIPv4(rest)
    // 还原不出具体 IPv4 的映射地址一律按危险处理（宁严勿漏）
    if (!v4 || isIP(v4) !== 4) return true
    return isPrivateIPv4(v4)
  }
  return false
}

/**
 * 下载目标安全校验（SSRF 守卫）。**只放行能解析到公网地址的 http(s) URL。**
 *
 * 判定顺序：协议 → 主机名黑名单 → 字面 IP → DNS 解析（**逐个地址**校验，
 * 防「域名解析到内网」与多 A 记录绕过）。
 *
 * @param {string} rawUrl 待校验 URL
 * @param {string[]} [allowHosts] 额外放行的主机（精确或子域匹配），用于自建 CDN 等场景
 * @throws {Error} 不安全时抛错（消息面向用户，可直接展示）
 * @returns {Promise<void>}
 */
export async function assertSafeDownloadTarget(rawUrl, allowHosts = []) {
  let u
  try {
    u = new URL(String(rawUrl))
  } catch {
    throw new Error(`下载地址不是合法 URL：${String(rawUrl).slice(0, 120)}`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`下载地址协议不受支持（仅允许 http/https）：${u.protocol}`)
  }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()

  // 显式白名单优先（自建 CDN / 内网对象存储的部署可在此放行）
  if (allowHosts.some((h) => host === h || host.endsWith('.' + h))) return

  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/.test(host)) {
    throw new Error(`下载地址指向本机/内网主机名，已拒绝（SSRF 防护）：${host}`)
  }

  const ipVer = isIP(host)
  if (ipVer === 4) {
    if (isPrivateIPv4(host)) throw new Error(`下载地址指向内网/保留 IP，已拒绝（SSRF 防护）：${host}`)
    return
  }
  if (ipVer === 6) {
    if (isPrivateIPv6(host)) throw new Error(`下载地址指向内网/保留 IP，已拒绝（SSRF 防护）：${host}`)
    return
  }

  // 域名 → 逐个解析地址校验（全部为公网才放行）
  let addrs = []
  try {
    addrs = await lookup(host, { all: true })
  } catch (e) {
    throw new Error(`下载地址无法解析：${host}（${e?.code || e?.message || 'DNS 失败'}）`)
  }
  if (!addrs.length) throw new Error(`下载地址无法解析：${host}`)
  for (const a of addrs) {
    const bad = a.family === 4 ? isPrivateIPv4(a.address) : isPrivateIPv6(a.address)
    if (bad) throw new Error(`下载地址解析到内网/保留 IP，已拒绝（SSRF 防护）：${host} → ${a.address}`)
  }
}

/**
 * 下载目标是否为公网（不抛错的判定版），供需要宽松处理（如跳过而非报错）的调用方使用。
 * @returns {Promise<boolean>}
 */
export async function isSafeDownloadTarget(rawUrl, allowHosts = []) {
  try { await assertSafeDownloadTarget(rawUrl, allowHosts); return true } catch { return false }
}
