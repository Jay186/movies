// 空间组人审基准图 · 提示词修复（P0-6，第 3 层）
//
// 设计依据：docs/anchor-review/02-incremental-design.md §4.3③ + §1.2
//
// 纯函数模块（无 DB / 无网络依赖），被 server/routes/generate-image.js 在「有空间锚」时调用：
//   swapSceneLightingNote(prompt) —— 把 prompt 中「以场景描述为准」的光照句替换为
//   「以锚图为准」口径，消除与邻场锚 hint「光照方向必须与参考图连续」的对撞（方案 C）。
//   未命中 → 原样返回（no-op），保证无锚场景 prompt 逐字不变（AC6）。
//
// ⚠️ 字面量耦合：PLAIN / LC_RE 必须与 src/services/promptBuilder.js:199-200 逐字符一致
// （含全角标点）。改 promptBuilder.js 的 lightingNote 文案必须同步此处，由
// tests/sceneAnchorPrompt.test.mjs 的「源码静态断言」守护。

// A3 布局图锚口径（单点在 ai/anchorTypes.js，与 sceneAnchors.js 同源）
import { LAYOUT_IMAGE_SUBJECT, LAYOUT_IMAGE_NEGATIVE } from './anchorTypes.js'

// 无光照常量时的冲突句（promptBuilder.js:200 逐字）
const PLAIN = '本画面的时间、光线方向与色调以场景描述为准，画风只统一笔触、上色与线条质感，不改变本场景既定光照。'
// 带光照常量变体（promptBuilder.js:199 逐字，捕获组 = 常量内容）
const LC_RE = /（本场景光照常量：([^）]*)）本画面的时间、光线方向与色调以该光照常量与场景描述为准，画风只统一笔触、上色与线条质感，不改变本场景既定光照。/
// 无常量 → 锚图口径（空间结构/光照方向以锚图为准；视角/构图与时段/天气/色温以文字描述为准）
// ⚠️ 2026-09-17 视角塌陷修复：原口径把「构图」列为以锚图为准，与 sceneAnchors.js 的组锚 hint
// 形成**两层加强**，实测让同组三个视角输出同一机位。现口径把锚图的支配范围收敛为
// 「空间结构 / 地标形态与相对位置 / 光照方向」，并显式声明「视角、机位高度、景别、画面主体占比」
// 不受锚图约束。改此处必须同步 server/ai/sceneAnchors.js 的 GROUP_ANCHOR_HINT 与邻场 hint。
const PLAIN_ANCHORED = '本画面的时段、天气与色温以场景描述为准，画风只统一笔触、上色与线条质感；空间结构、地标物体的形态与相对位置、光照方向以参考锚图为准，与锚图保持连续；但视角、机位高度、景别与画面主体占比不受锚图约束，一律以本场景文字描述为准。'
// 带常量 → 锚图口径变体
const lcAnchored = (lc) =>
  `（本场景光照常量：${lc}）本画面的时段、天气与色温以场景描述为准，画风只统一笔触、上色与线条质感；空间结构、地标物体的形态与相对位置、光照方向以参考锚图为准，与锚图保持连续；但视角、机位高度、景别与画面主体占比不受锚图约束，一律以本场景文字描述为准。`

// sceneHintNote 追加的显式优先级声明（方案 A：兜底 + 正向声明，设计 §1.2）
// 2026-09-17 视角塌陷修复：原文案「构图…冲突时以锚图为准」会把视角一并判给锚图，改为
// 明确排除视角维度——冲突仲裁只覆盖空间结构/地标形态/光照方向三项。
export const ANCHOR_PRIORITY_NOTE =
  '【锚图优先级】当本句与画面描述中关于光照、空间结构或地标物体形态的表述冲突时，以参考图（锚图）为准；' +
  '但视角、机位高度、景别与画面主体占比以本场景文字描述为准，不受锚图约束；' +
  '时段、天气与色温以本场景文字描述为准。'

/**
 * 把 prompt 里的「以场景描述为准」光照句改写为「以锚图为准」口径。
 * 无匹配 → 原样返回（no-op）。
 * @param {string} prompt
 * @returns {string}
 */
export function swapSceneLightingNote(prompt) {
  let s = String(prompt || '')
  s = s.split(PLAIN).join(PLAIN_ANCHORED) // 无常量变体：逐字替换（未命中则 no-op）
  s = s.replace(LC_RE, (_, lc) => lcAnchored(lc)) // 带常量变体：正则替换
  return s
}

// ===================================================================
// A3 布局图锚 · prompt 构建（2026-09-17）
// ===================================================================
//
// 纯函数（无 DB / 无网络），由 routes 在「生成某组的布局图」时调用。
// 输入全部来自 scene_analysis（组内各场的 spatial_role / props / 组级地标 / 环境卡），
// **不含任何题材词表**：该画什么完全由 LLM 前一步的分析结果决定。

/**
 * 构建某空间组的「俯视布局示意图」生成 prompt。
 *
 * 设计要点（每一条都对应一类失败模式）：
 *  ① 必须拿到组内各场的 spatial_role —— 它们是"这个空间有哪些观察位"的权威清单，
 *     布局图要把这些位置的关系画出来，否则布局图对"从哪看"毫无指导价值。
 *  ② 必须拿到组级地标（props ∪ 环境卡里的实体）—— 它们是"要摆什么"的清单。
 *  ③ 显式禁止画机位/视线箭头：一旦画了箭头，模型在生成场景图时会把这个视角关系
 *     当成构图指令照抄，"哪一格是主角机位"会被误读成"我这镜就用这个机位"。
 *  ④ 环境卡里的**非实体**项（色调/天光这类）不进布局图：布局图不表达光。
 *
 * @param {{group:string, roles:string[], landmarks:string[], env:string[], styleText?:string}} p
 * @returns {string}
 */
export function buildLayoutImagePrompt(p = {}) {
  const group = String(p.group || '').trim()
  const roles = (Array.isArray(p.roles) ? p.roles : []).map((s) => String(s || '').trim()).filter(Boolean)
  const landmarks = (Array.isArray(p.landmarks) ? p.landmarks : []).map((s) => String(s || '').trim()).filter(Boolean)
  const env = (Array.isArray(p.env) ? p.env : []).map((s) => String(s || '').trim()).filter(Boolean)
  const styleText = String(p.styleText || '').trim()
  // A3 重试反馈：由 routes 在「上一版被 layoutReview 判定不合格」时传入，
  // 内容是对**实际检出问题**的针对性加固（见 layoutReview.buildLayoutRetryNote）。
  // 首轮传空 → 拼进去的是 ''，prompt 逐字不变。
  const retryNote = String(p.retryNote || '')

  // ⚠️ 2026-09-17 A3 布局图 · 六轮实测记录（这是本方案最贵的一课）：
  //   v1 原始            → 满图中文标注 + 眼睛机位图标
  //   v3                 → 干净、零文字 ✅（**唯一一次**，且之后无法复现）
  //   v4 放开「雾的范围」→ 满屏冰雪质感 + 补画清单外雪松
  //   v5 堆约束(1353字/28否定) → 中英标注全回来 + 指引线 + 图幅卡
  //   v6 全正向表述 + 扁平矢量风格锚(889字/14否定) → 仍是满图英文标注，教科书感更强
  //
  //   ⚠️ 归因修正：我一度判断主因是「否定过载」，但 v6 用与 v3 相当的规模
  //   （889字/14否定 vs 826字/14否定）做全正向表述，**依旧带标注** —— 假设被证伪。
  //   真正的规律是：**格式与标注在这个模型的先验里强耦合**。
  //   只要 prompt 让它认为「我在画一张示意图」，它就会加标签与引线；这是"教科书插图"
  //   这个图像分布的固有属性，**靠 prompt 与之对抗，收益低且不可复现**。
  //
  //   → 因此本文件的策略是：**prompt 只管"画什么内容"，"不许出现文字"交给生成后闸**。
  //     见 server/ai/layoutReview.js（视觉模型检出 → 针对性加固 → 重试，上限 3 次）。
  //     prompt 本身保持精简，不再堆砌预防性否定句（实测证明无效）。

  // 地标清单（正向表述）。
  // 大气类不进本图：第四次实测表明，示意图语境下「雾」不是几何量而是**渲染量**
  // （模型会画成满屏冰雪材质，并顺势补出「雪松」这种清单外物体）。
  // 「雾停半山腰」这类大气层结信息由**场景图阶段**承担（A1 的 elements 已硬约束其必须可见），
  // 本图只负责「物体在哪、朝哪」。
  const landmarksNote = landmarks.length
    ? `空间里要摆出的东西：${landmarks.join('、')}。` +
      `把其中属于地形、水体、植被、建筑、道具的，用形状与色块**直接画出来**，画出它们各自的形态、位置与朝向。` +
      `雾、云、雨、雪、水汽、天光、色调属于大气与光照，不在本图表达范围内。`
    : ''
  // 观察位（正向表述）：只作方位参考，绝不可变成图标。
  // （第一版说了「把它们的相对位置画清楚」，模型就画了眼睛图标来标机位——
  //   那正是本方案要消灭的视角固化。改用正向表述「它们本身不出现在画面上」。）
  const rolesNote = roles.length
    ? `本空间有这几个观察位置：${roles.join('；')}。` +
      `它们的作用只是帮你确认物体之间的方位关系（谁在谁对面、谁在谁上方），` +
      `用来安排物体的相互位置即可，它们本身不出现在画面上。`
    : ''
  // 环境卡弱化：环境卡说的是「整组的这个地点有什么」，不保证每个观察位都看得见。
  // （实测：场1 写的是「缓坡草地 + 绿色森林」，环境卡却是「茂密森林」。若照卡画成成片密林，
  //   就把「远处是森林带」错升级成了「空间内密布针叶林」——**误导性的权威**。
  //   布局图只该断言剧本真的断言过的东西，宁可少画不可多断言。）
  const envNote = env.length
    ? `这个地点的背景交代：${env.join('、')}。` +
      `它们只是地点层面的背景，不保证每个观察位置都看得见，` +
      `画成远处背景的一层色带示意就够，具体形态留到各个场景里去表现。`
    : ''

  // v3 基线口径：接 art_style（六轮实测中唯一复现过『干净零文字』的版本）
  const styleNote = styleText ? `绘制风格：${styleText}，但仅为示意，不追求写实渲染。` : ''

  return (
    `${LAYOUT_IMAGE_SUBJECT}（${group || '该空间'}）。` +
    // 画法：斜俯视等轴测 + 分层积木。高差是这张图最要传达的关系，
    // 原口径把「俯视（鸟瞰）」写在前面，模型一律出正俯视，会把崖体/河谷压平。
    `画法：斜俯视的等轴测，像一块可以拿在手里的**分层积木**——崖顶、坡面、谷底、水面各在一个高度上，` +
    `层与层之间的高低落差一眼就读得出来。` +
    `${landmarksNote}${rolesNote}${envNote}` +
    `物体之间的相对位置、朝向与距离比例要清楚可读，不同物体靠**形状、色块和线条**区分开。` +
    `${styleNote}` +
    `${LAYOUT_IMAGE_NEGATIVE}` +
    `${retryNote}`
  )
}

/**
 * 从组内成员数据抽取布局图所需的素材（纯函数，便于测试）。
 * @param {{members:Array<{spatialRole?:string, props?:string[]}>, env?:string[]}} p
 * @returns {{roles:string[], landmarks:string[]}}
 */
export function collectLayoutMaterials(p = {}) {
  const roles = []
  const landmarks = []
  const seenRole = new Set()
  const seenLand = new Set()
  for (const m of Array.isArray(p.members) ? p.members : []) {
    const role = String(m?.spatialRole || '').trim()
    if (role && !seenRole.has(role)) { seenRole.add(role); roles.push(role) }
    for (const x of Array.isArray(m?.props) ? m.props : []) {
      const s = String(x || '').trim()
      if (s && !seenLand.has(s)) { seenLand.add(s); landmarks.push(s) }
    }
  }
  return { roles, landmarks }
}
