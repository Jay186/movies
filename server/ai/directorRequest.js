// 分镜图（四宫格）图像工具集：宫格文生图 prompt 构造 + ffmpeg 切分落库。
// 注：视频出片链路（导演台段落出片 / 旧三合一）已整体移除，重新对接时从版本库或交付说明重建。
import { execute } from '../db.js'
// clean 折叠空白版统一到 shared.js。
// ⚠️ 本文件另有 3 处「不折叠空白」的局部 clean（briefShot / extractBlockingText /
//    buildShotGridContentApp），它们刻意保留换行与缩进，**不要**合并到 shared.clean，
//    否则多行描述会被压成单行。详见 ai/shared.js 顶部「故意不合并清单」。
import { clean as cleanShared } from './shared.js'
import path from 'node:path'
import fs from 'node:fs'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import ffmpegPath from 'ffmpeg-static'

const execFile = promisify(execFileCb)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const uploadsDir = path.join(__dirname, '..', 'uploads')

// 占位素材：与 buildShotVideoRequest 同一套防污染策略（云端默认素材会污染画面）

// 单段总时长上限（秒）。导演台官方 demo 为 12s（2x2 宫格），
// 20s 为 4 个 5s 镜头的常见打包；是否支持更久需在 RunningHub 实测后调整。
// 单段最多镜头数：导演台 2x2 宫格 = 4 格（3x3 需改 grid_layout 并放宽此值）

// 构造 2x2 四宫格分镜图的文生图 prompt（导演台段落出片的专用输入图）。
// 让生图模型直接产出"4 镜网格"，省去"逐镜出图 + buildRefGrid 拼图"两步。
// @param {Array} shots 场内的镜头行（取前 4 个，对应 2x2 四格）
// @param {string} stylePrompt 画风描述（风格库完整 prompt）
// @param {Array} charRows 段内出场角色行（顺序必须与参考图数组一致：第 i 个角色 = 参考图 i）
// @param {Object|null} sceneRow 场景设定行（image_url 作为最后一张参考图）
export function buildSceneGridPrompt(shots, stylePrompt = '', charRows = [], sceneRow = null) {
  const stylePart = stylePrompt ? `整幅画面统一为以下画风：${stylePrompt}。` : ''
  const charPart = charRows.length
    ? '【角色绑定】每个格子里的角色外观必须严格与对应参考图一致（exactly as shown），禁止换成其他造型：' +
      charRows.map((c, i) => `${c.name} = 参考图${i + 1}，${c.description || '外观以参考图为准'}`.trim()).join('；')
    : ''
  const scenePart = sceneRow?.image_url
    ? `【场景绑定】场景外观、陈设布局、光线色调严格与最后一张参考图（场景设定图）一致（exactly as shown），四格共享同一场景：${sceneRow.summary || sceneRow.title || '按参考图场景'}`
    : ''
  const panels = shots
    .slice(0, 4)
    .map((s, i) => `第${i + 1}格：${briefShot(s)}`)
  return [
    '请生成一张 2x2 四宫格分镜图，四个格子严格对应四个连续镜头，布局：左上=第1格、右上=第2格、左下=第3格、右下=第4格。',
    '每个格子都是一张独立完整的连贯电影画面，画面之间互不串扰、不共享角色动作；格子之间用细白线分隔。',
    stylePart,
    charPart,
    scenePart,
    ...panels,
    '【约束】每个格子内人物服装、发型、体型、场景陈设必须一致，且全部按【角色绑定】【场景绑定】使用参考图外观；画面禁止出现文字、水印、边框、页码、对话框、字幕；禁止不同格子之间的内容串格；不要写标题。',
  ]
    .filter(Boolean)
    .join('\n')
}

// 精简镜头描述：优先中文字段（景别+机位+动作），无则截取 integrated 英文描述
// 清理剧本 IP 路由标记 @角色名/@道具名（生图时是噪音）
function briefShot(shot) {
  const clean = (s) => (s || '').replace(/@/g, '').trim()
  const parts = []
  if (shot.shot_type) parts.push(shot.shot_type)
  if (shot.camera_movement) parts.push(`镜头${shot.camera_movement}`)
  if (shot.description) parts.push(clean(shot.description))
  if (shot.action_note) parts.push(clean(shot.action_note))
  if (parts.length) return parts.join('，')
  const it = shot.integrated_multimodal_description || ''
  return it ? it.replace(/^\s*\[Shot\s*\d+\]\s*/, '').replace(/@/g, '').slice(0, 120) : '（镜头描述待补充）'
}

// 从 integrated_multimodal_description（英文 6 模块）提取该镜头的 4 个时间瞬间描述。
// 健壮化设计（换剧本不翻车）：
//  - 时间戳正则大小写不敏感（"At 00:00" 与 "at 00:03" 都能抓，支持分号并列）
//  - opening 句多格式兼容（有/无 "—" 都行，边界含 airlock/At/final frame/段尾）
//  - final frame 多边界（段尾/双换行/文本末尾）
//  - 中段动作不足时用"时间相位过渡"描述差异化，禁止 4 格文字重复
//  - 返回 null 时调用方走中文字段 fallback
function extractMoments(integrated) {
  const clean = cleanShared // 与 shared.js 的 clean 等价（去 @ + 折叠空白）
  if (!integrated || !integrated.trim()) return null
  const cleaned = integrated.replace(/^\s*\[Shot\s*\d+\]\s*/, '')

  // 时间戳动作（大小写不敏感；支持 "At 00:00.000, X; at 00:03.000, Y" 并列句式）
  const timeActs = []
  const re = /at\s+00:(\d{2})\.(\d{3}),\s*([^.;]+[.;])/gi
  let m
  while ((m = re.exec(cleaned))) timeActs.push({ t: Number(m[1]), text: clean(m[3]) })
  timeActs.sort((a, b) => a.t - b.t)

  // final frame（边界：段尾/双换行/文本末尾）
  const finalMatch = cleaned.match(/The final frame:\s*([\s\S]+?)(?=\n\s*\n|$)/i)
  const finalText = clean(finalMatch ? finalMatch[1] : '')

  // opening 句（"The camera opens ... — ..."，多边界兼容）
  const idx = cleaned.search(/the camera opens/i)
  const openingText = idx >= 0
    ? clean(cleaned.slice(cleaned.indexOf(' ', idx + 17) + 1).split(/\. The airlock|\.?\s*at 00:|\. The final frame|\n\s*\n/i)[0])
    : null

  const start = timeActs.find((a) => a.t === 0)
  const mids = timeActs.filter((a) => a.t > 0)

  // Panel 1：opening > At 00:00 > 文本头
  const g1 = openingText || (start ? start.text : clean(cleaned.slice(0, 90)))
  // Panel 2/3：中段时间戳 > 差异化过渡描述（禁止与相邻格文字相同）
  const g2 = mids[0]
    ? mids[0].text
    : `${g1 ? g1.slice(0, 60) : 'Opening state'} — moments later, the action begins to develop`
  const g3 = mids[1]
    ? mids[1].text
    : `Transitioning toward the final state — posture and expression shifting${finalText ? `, ${finalText.slice(0, 60)}` : ''}`
  // Panel 4：final frame > 最后时间戳 > 兜底
  const g4 = finalText || (mids.length ? mids[mids.length - 1].text : 'Action complete, final frame')

  return { g1, g2, g3, g4 }
}

// 从 blocking_plan（结构化站位 JSON）提取空间调度文字。
// 数据形态：characters[].{name, start, end, facing, gaze, relation, actions[]}
// relation（"sitting on 米色沙发"）是姿态权威来源，facing/gaze/actions 补朝向与动作序列。
// 不传站位图图片：简笔示意图会污染图生图画风；结构化转文字无此风险且遵从度更高。
function extractBlockingText(blockingPlan) {
  if (!blockingPlan) return null
  let plan
  try {
    plan = typeof blockingPlan === 'string' ? JSON.parse(blockingPlan) : blockingPlan
  } catch {
    return null
  }
  const chars = Array.isArray(plan.characters) ? plan.characters : []
  if (!chars.length) return null
  const clean = (s) => String(s || '').replace(/@/g, '').trim()
  const lines = chars.map((c) => {
    if (!c?.name) return null
    const parts = [clean(c.name)]
    if (c.relation) parts.push(clean(c.relation))
    else if (c.start?.region) parts.push(`in ${clean(c.start.region)} 区`)
    if (c.facing) parts.push(`facing ${clean(c.facing)}`)
    if (c.gaze) parts.push(`gaze ${clean(c.gaze)}`)
    const acts = (Array.isArray(c.actions) ? c.actions : [])
      .map((a) => clean(a?.label))
      .filter(Boolean)
    if (acts.length) parts.push(`actions: ${acts.join(' → ')}`)
    return parts.filter(Boolean).join('，')
  }).filter(Boolean)
  return lines.length ? lines.join('；') : null
}

// 构造单镜头 2x2 四宫格分镜图 prompt（每镜一张，4 格 = 同一镜头的 4 个时间瞬间）
// 防御性设计（换剧本不翻车）：所有锚定段做依赖检测，数据缺失自动降级并记入 warnings。
// @returns {{ prompt: string, warnings: string[] }}
export function buildShotGridPrompt(shot, stylePrompt = '', charRows = [], sceneRow = null) {
  const warnings = []
  const parseArr = (v) => {
    if (!v) return []
    try { const r = JSON.parse(v); return Array.isArray(r) ? r.filter(Boolean) : [] } catch { return [] }
  }

  // ===== 各锚定段（有数据才加，没数据降级 + warning）=====
  const stylePart = stylePrompt ? `整幅画面统一为以下画风：${stylePrompt}。` : ''
  if (!stylePrompt) warnings.push('未取到画风库 prompt（style_presets），仅靠参考图锁画风')

  const charPart = charRows.length
    ? '【角色绑定】所有格子里的角色外观必须严格与对应参考图一致（exactly as shown），禁止换成其他造型：' +
      charRows.map((c, i) => `${c.name} = 参考图${i + 1}，${c.description || '外观以参考图为准'}`.trim()).join('；')
    : ''
  const presentChars = parseArr(shot.characters)
  if (!charRows.length) {
    warnings.push(presentChars.length
      ? `出场角色 ${presentChars.join('、')} 无形象参考图（characters.image_url 缺失），仅靠文字白描锁外观，角色一致性会明显下降`
      : '本镜未声明出场角色（shot.characters 为空）')
  }

  const scenePart = sceneRow?.image_url
    ? `【场景绑定】场景外观、陈设布局、光线色调严格与最后一张参考图（场景设定图）一致（exactly as shown），四格共享同一场景：${sceneRow.summary || sceneRow.title || '按参考图场景'}`
    : ''
  if (!sceneRow?.image_url) {
    const names = parseArr(shot.scene_assets)
    warnings.push(names.length
      ? `场景「${names.join('、')}」未匹配到设定图（scenes 表无同名行或 image_url 为空），场景陈设仅靠文字描述`
      : '本镜未声明场景资产（shot.scene_assets 为空），场景不锁参考')
  }

  const presencePart = presentChars.length
    ? `【角色在场约束 - 最高优先级】本镜头出场角色：${presentChars.join('、')}。每一格都必须包含【全部】出场角色，四格的角色数量与组合必须完全一致——禁止任何一格少画角色（例如只画其中一只）、禁止任何一格凭空新增角色、禁止画成空镜（纯环境无人）。除非某格描述明确写出该角色离场（exits frame / leaves / walks out），该角色才允许缺席，且一旦缺席必须从该格起保持到末格，不得中途重新出现。`
    : ''

  // 服装配饰锁定：网格生成时模型常自由发挥添加围巾/帽子（雪山场景尤其高发），导致格间服装漂移
  const costumePart = charRows.length
    ? `【服装配饰锁定】四格中每个角色的服装与配饰必须与对应参考图完全一致；参考图中不存在的服装、围巾、帽子、背包、披风等配饰一律禁止添加——即使场景是雪地/冬天，也不得自行为角色添衣加帽。四格之间服装必须逐格完全相同。`
    : ''

  // 站位调度（导演级）：blocking_plan 结构化转文字，姿态/朝向/动作序列的权威来源
  const blockingText = extractBlockingText(shot.blocking_plan)
  const blockingPart = blockingText
    ? `【站位调度 - 导演级权威，与 panel 描述冲突时以本段为准】各角色的空间位置/姿态/朝向严格按以下执行：${blockingText}。`
    : ''

  // 机位角度：shots.camera_angle 是与 V4 视频链路同源的确定性机位字段。
  // 四宫格必须和视频同机位——否则选出的格子当 storyboard 锚喂回视频链路时，
  // 锚图机位和 camera_angle 打架，等于自己污染自己（1-1 实测踩过）。
  const cameraAngleText = String(shot.camera_angle || '').trim()
  const cameraPart = cameraAngleText
    ? `【机位角度 - 4 格必须统一】本镜头机位为「${cameraAngleText}」，4 格全部从该机位取景；禁止任何一格把机位画成其他角度（例如机位是「侧面」却画成正面视角）。机位约束优先级高于对参考图正面视角的复制冲动。`
    : ''

  const integrated = shot.integrated_multimodal_description || ''
  const moodPart = extractMood(integrated) || '整体光线与色温：暖色为主，柔和自然光，禁止冷蓝调、纯黑、霓虹色。'
  if (!integrated) warnings.push('本镜无 integrated_multimodal_description（画质修复链路未覆盖），4 格瞬间从中文字段降级生成')

  // ===== 4 个时间瞬间 =====
  const moments = extractMoments(integrated)
  const base = briefShot(shot)
  // 落幅格权威描述：shot.final_frame 是分镜生成时写好的最终画面精确描述（角色精确位置朝向），
  // 直接注入 Panel 4——防止模型把落幅画成角色 180° 掉头等与最终画面相悖的构图（实测：并肩站立被画成一正一背）
  const finalFrameText = String(shot.final_frame || shot.finalFrame || '').trim()
  const panels = moments
    ? [
        `Panel 1 (top-left, earliest): ${moments.g1}`,
        `Panel 2 (top-right, middle): ${moments.g2}`,
        `Panel 3 (bottom-left, later): ${moments.g3}`,
        `Panel 4 (bottom-right, final): ${finalFrameText ? `${moments.g4}。最终画面精确构图（必须严格遵循，含每个角色的位置与朝向）：${finalFrameText}` : moments.g4}`,
      ]
    : [
        // 中文字段 fallback：4 格用不同相位描述，避免"4 格雷同"（配合【4 格差异】约束）
        `Panel 1 (top-left, earliest): ${base} — initial moment, characters in starting positions, action about to begin`,
        `Panel 2 (top-right, middle): ${base} — action in progress, gestures and expressions actively changing`,
        `Panel 3 (bottom-left, later): ${base} — action further developed, tension or interaction at its peak`,
        `Panel 4 (bottom-right, final): ${finalFrameText || `${base} — action complete, settled final state${shot.action_note ? `（${shot.action_note}）` : ''}`}`,
      ]

  const prompt = [
    'Generate a 2x2 storyboard grid showing the SAME single shot at four sequential time points (in order: top-left = earliest, top-right = middle, bottom-left = later, bottom-right = final).',
    'Each panel is a continuous frame of the same scene with the same characters, clothing, position, and props — only facial expression, body language, and subtle camera movement differ between panels. Thin white lines separate the panels.',
    '【同一景别 - 4 格禁止景别突变】all 4 panels must use the SAME camera framing/scale (e.g. medium shot). Do NOT switch to a close-up that fills the panel with one character face — the four panels are 4 frames of the SAME shot at 4 different time points, not a storyboard of 4 different angles.',
    cameraPart,
    '【4 格必须肉眼可见的差异】even when the panel descriptions are similar, you MUST show visible progression across the 4 panels — change facial expression (eyes / mouth / brow), body posture (head tilt / arm position), object state (phone screen glow / hand grip), or spatial relationship. NEVER paint the same frame 4 times.',
    `【场景氛围与灯光 - 4 格必须严格统一】${moodPart}`,
    stylePart,
    charPart,
    costumePart,
    scenePart,
    presencePart,
    blockingPart,
    ...panels,
    '【姿态与空间严格约束 - 最高优先级】each panel MUST respect the character\'s exact physical position and posture described: "stands" means standing (not sitting), "sits" means sitting, "walks/exits" means in motion; spatial directions ("on the left/right side", "facing left/right", "in front of sofa", etc.) must be exactly as described. NEVER change a character\'s posture/position from what the panel description states.',
    '【约束】画面禁止出现任何文字、字母、单词、汉字、字幕、标签、对话框、水印、边框、页码；禁止不同格子之间的内容串格；do not write any title, caption, or text on the image.',
  ]
    .filter(Boolean)
    .join('\n')

  return { prompt, warnings }
}

// 从 integrated 提取场景氛围/灯光/色温关键句，钉到 prompt 顶部
//（防 nano-banana-pro 每次生图随机漂移色调）
function extractMood(integrated) {
  if (!integrated || !integrated.trim()) return null
  // 抓取：time_of_day（傍晚/夜晚/清晨）+ 主光源（台灯/吊灯/窗户光）+ 色温（暖黄/冷蓝）
  // + 场景锁定句（The X remain unchanged ...）
  const parts = []
  const cleaned = integrated
  // 1) 场景锁定句：The X remain/stays unchanged ...
  const lockMatch = cleaned.match(/The [^.]*(?:remain|stays)[^.]*\./i)
  if (lockMatch) parts.push(lockMatch[0].replace(/@/g, '').trim().slice(0, 200))
  // 2) 灯光/氛围关键短语（amber / lamplight / natural daylight / dusk / dawn 等）
  const lightPhrases = []
  const lightRegex = /(warm amber (?:lamplight|light)|natural daylight|soft (?:afternoon|morning) light|candlelight|moonlight|dusk|dawn|night interior|daylight|golden hour|overcast)/gi
  let m
  while ((m = lightRegex.exec(cleaned))) lightPhrases.push(m[0])
  // 3) 显式色温词（amber / warm / cool / dark / bright）
  const colorPhrases = []
  const colorRegex = /(amber|warm (?:yellow|tone)|cool (?:blue|tone)|deep (?:blue|brown)|bright (?:light|sun))/gi
  while ((m = colorRegex.exec(cleaned))) colorPhrases.push(m[0])
  if (lightPhrases.length) parts.push(`主光源：${lightPhrases.slice(0, 3).join('、')}`)
  if (colorPhrases.length) parts.push(`色温：${colorPhrases.slice(0, 3).join('、')}`)
  if (parts.length === 0) return null
  parts.push('四格画面色温、灯光、场景陈设必须完全一致')
  return parts.join('；')
}

// 把 2x2 四宫格图切成 4 份单图（ffmpeg-static），写回 shots.frame_url
// @param {string} gridImagePath /uploads/xxx.png 形式的相对 URL（splitSceneGrid 内部基于
//        directorRequest.js 的 __dirname 解析为 server/uploads/绝对路径，无需外部传入）
// @param {Array} shots 段内镜头行（按生成顺序，前 4 个对应 gridIndex 0-3）
// @param {number} sceneId 场次 id
// @returns {Promise<{cellSize: number, updates: Array<{shotId: number, url: string}>}>}
export async function splitSceneGrid(gridImagePath, shots, sceneId) {
  const basename = path.basename(decodeURIComponent(gridImagePath.split('?')[0]))
  const absSrc = path.join(uploadsDir, basename)
  if (!fs.existsSync(absSrc)) throw new Error(`四宫格图不存在: ${absSrc}`)
  // 解析图片尺寸：ffmpeg-static essentials 不带 ffprobe 元数据能力，手写头解析
  const { w, h } = readImageSize(absSrc)
  if (!w || !h) throw new Error(`无法解析四宫格图尺寸: ${absSrc}`)
  const cellW = Math.floor(w / 2)
  const cellH = Math.floor(h / 2)
  const positions = [
    { x: 0, y: 0 }, { x: cellW, y: 0 }, { x: 0, y: cellH }, { x: cellW, y: cellH },
  ]
  const updates = []
  for (let i = 0; i < Math.min(4, shots.length); i++) {
    const shot = shots[i]
    const { x, y } = positions[i]
    const outName = `scene_${sceneId}_cell_${shot.id}_${Date.now()}.png`
    const outPath = path.join(uploadsDir, outName)
    try {
      await execFile(ffmpegPath, [
        '-y', '-i', absSrc,
        '-vf', `crop=${cellW}:${cellH}:${x}:${y}`,
        outPath,
      ])
      const localUrl = `/uploads/${outName}`
      execute('UPDATE shots SET frame_url = ? WHERE id = ?', [localUrl, shot.id])
      updates.push({ shotId: shot.id, url: localUrl })
    } catch (e) {
      console.warn(`[splitSceneGrid] shot ${shot.id} 切分失败:`, e.message)
    }
  }
  return { cellSize: cellW, updates }
}

// 读 PNG / JPEG 头解析宽高（不依赖 sharp/jimp；只支持 Visionary 输出格式）
function readImageSize(filePath) {
  const fd = fs.openSync(filePath, 'r')
  try {
    const buf = Buffer.alloc(64 * 1024)
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0)
    // PNG: 89 50 4E 47 0D 0A 1A 0A + IHDR at 16
    if (bytes >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
    }
    // JPEG: 扫描 SOF0/SOF2 段，width at +7, height at +5
    if (bytes >= 2 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2
      while (i < bytes - 9) {
        if (buf[i] !== 0xff) return null
        const marker = buf[i + 1]
        const len = buf.readUInt16BE(i + 2)
        if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
          const h = buf.readUInt16BE(i + 5)
          const w = buf.readUInt16BE(i + 7)
          return { w, h }
        }
        i += 2 + len
      }
    }
    return null
  } finally {
    fs.closeSync(fd)
  }
}

// ===== RunningHub 四宫格 AI 应用（2048139846660657154）专用：剧情文本（对应应用 nodeId 13 prompt）=====
// 该应用没有旧工作流那样的独立"布局模板"槽：2x2 布局 / 无缝拼接 / 禁止文字等约束全部
// 由本文本携带（应用内如另有固定模板/LLM 优化器，冗余约束无害，缺了则必乱）。
// 文本结构对齐应用示例（"图1是女主、图2是男生、图3是海滩……\n（剧情）"）：
//   首行 = "图N 是 X" 参考身份声明（N 与提交的第 N 张参考图严格对应），随后 = 剧情主体
//   （统一画风 + 统一设定 + 画面 1..4 四时间瞬间 + 一致性硬锁）。
// 参考槽为通用资源池，不按资产类型写死：allocateShotRefs 按优先级（出场角色 > 场景 > 道具）
// 动态分配 slot 1..4（fill=false 空槽不补位），产出 refs 同时供本函数生成"图N"声明与
// rhShotGrid 填槽——单一真源，图/文不会漂移。当前应用 4 个参考槽连线序：
// 1=#2  2=#8  3=#9  4=#10（nodeMap image1..4）
// @returns {string} 中文剧情文本（喂给应用 prompt 节点）
export function buildShotGridContentApp({ shot, charRows = [], sceneRow = null, propRows = [], refs = [], stylePrompt = '' }) {
  const clean = (s) => String(s || '').replace(/@/g, '').trim()
  const parseArr = (v) => {
    if (!v) return []
    try { const r = JSON.parse(v); return Array.isArray(r) ? r.filter(Boolean) : [] } catch { return [] }
  }
  const presentChars = parseArr(shot.characters)
  const sceneName = sceneRow?.title || parseArr(shot.scene_assets)[0] || ''
  const moodPart = extractMood(shot.integrated_multimodal_description) || '暖色为主，柔和自然光，电影级质感'

  // 画面 1..4：优先 integrated 的 4 个时间瞬间（英文动作流）；缺省走中文字段 4 相位降级
  const moments = extractMoments(shot.integrated_multimodal_description || '')
  const base = briefShot(shot)
  const panels = moments
    ? [moments.g1, moments.g2, moments.g3, moments.g4]
    : [
        `${base} — 初始时刻，角色在起始位置，动作即将开始`,
        `${base} — 动作进行中，表情与肢体姿态正在变化`,
        `${base} — 动作进一步推进，情绪或互动达到高潮`,
        `${base} — 动作完成，定格最终状态${shot.action_note ? `（${clean(shot.action_note)}）` : ''}`,
      ]

  const lines = []
  // 首行 = 图N身份声明（对齐应用示例"图1是女主、图2是男生、图3是海滩…"）。
  // 按 refs 实际分配结果动态生成（refs 由 allocateShotRefs 产出，与 rhShotGrid 填槽严格同源）；
  // 只声明真正分到槽（slot 非 null 且非 dup 复用占位）的资产，没槽/没图的靠剧情文字描述兜底。
  const labeled = refs.filter((r) => r.slot && !r.dup).sort((a, b) => a.slot - b.slot)
  if (labeled.length) {
    const idOf = (r) => {
      if (r.type === 'scene') return `${r.name || '场景'}（场景）`
      if (r.type === 'prop') return `${r.name || '道具'}（道具）`
      return r.name || '角色'
    }
    lines.push(labeled.map((r) => `图${r.slot}是${idOf(r)}`).join('、') + '。')
  }
  // 画风句紧随其后：#114/#79 时代布局模板已取消，画风完全由这里注入——
  // stylePrompt 来自 projects.art_style（→ style_presets 完整 prompt），与生图/视频链路同源。
  if (stylePrompt) {
    lines.push(`整幅画面统一为以下画风：${stylePrompt}。四个画面与所有参考图保持完全一致的画风。\n`)
  }
  const header = ['统一设定']
  if (sceneName) header.push(`地点：${sceneName}`)
  if (presentChars.length) header.push(`人物：${presentChars.join('、')}`)
  header.push(`氛围与灯光：${moodPart}`)
  lines.push(header.join('｜') + '\n')
  // 绑定声明（措辞用"图N"与首行/应用示例一致）：只声明真正分到槽的资产
  const slotOf = (t) => labeled.filter((r) => r.type === t)
  const sceneRefs = slotOf('scene')
  if (sceneRow?.image_url && sceneRefs.length) {
    lines.push(`场景外观、陈设布局、光线色调严格按图${sceneRefs.map((r) => r.slot).join('、')}（场景设定图），四个画面共享同一场景。`)
  }
  const propRefs = slotOf('prop')
  if (propRefs.length) {
    lines.push(`道具外观严格按对应参考图（${propRefs.map((r) => `${r.name}=图${r.slot}`).join('、')}），禁止更改颜色、形态与装饰。`)
  }
  const presentNames = new Set(charRows.map((c) => String(c.name || '')))
  const charRefs = slotOf('char').filter((r) => presentNames.has(r.name))
  if (charRefs.length) {
    lines.push(`出场角色外观严格按对应参考图（${charRefs.map((r) => `${r.name}=图${r.slot}`).join('、')}），禁止更改造型、服装与发型。`)
  }
  panels.forEach((p, i) => {
    const tags = []
    if (shot.shot_type) tags.push(clean(shot.shot_type))
    lines.push(`\n画面${i + 1}${tags.length ? `｜${tags.join('、')}｜` : '｜'}${clean(p)}`)
  })
  lines.push('\n四个画面是同一镜头在同一场景的连续时间瞬间：人物、服装、场景陈设完全一致，仅表情、姿态、动作进程与细微摄影机运动不同。')
  return lines.join('\n')
}

// ===== 通用参考槽分配：把本镜资产图按优先级填进有限槽位 =====
// 参考槽数量有限（旧 5 槽工作流 / 现 AI 应用 4 槽），而本镜角色/场景/道具组合任意，不做固定槽位映射，
// 统一按优先级动态分配 slot 1..slots：出场角色（按出场顺序）> 场景 > 道具。
// 分配不到槽或没图的资产 slot=null，由剧情文本（"图N"声明之外的部分）文字描述兜底。
// fill=true（默认，旧 5 槽工作流需要）：补位角色（charPool 中未出场但有图者）垫底占槽 +
//   真实图不足 slots 时循环复用已分配的图占满空槽——工作流内置参考文件部分无效
//   （如 sanbubu_small.jpg 不存在），空槽运行期报 Invalid image file 直接 FAILED，必须填满。
// fill=false（四宫格 AI 应用 2026-09-09 起）：空槽直接不上传，避免无关角色图/重复图误导模型。
// @returns {Array<{type:'char'|'scene'|'prop'|'char-fill', name:string, url:string, slot:number|null}>}
//          产出同时供 buildShotGridContentApp 生成"图N"声明与 rhShotGrid 填槽，单一真源。
export function allocateShotRefs({ charRows = [], sceneRows = [], propRows = [], charPool = [], slots = 5, fill = true } = {}) {
  const refs = []
  for (const c of charRows) if (c?.image_url) refs.push({ type: 'char', name: String(c.name || ''), url: c.image_url })
  for (const s of sceneRows) if (s?.image_url) refs.push({ type: 'scene', name: String(s.title || s.name || ''), url: s.image_url })
  for (const p of propRows) if (p?.image_url) refs.push({ type: 'prop', name: String(p.name || ''), url: p.image_url })
  // 补位角色仅 fill=true 时启用（占满空槽防工作流 Invalid image file）；fill=false 不引入无关图
  if (fill) {
    const seen = new Set(refs.map((r) => r.url))
    for (const c of charPool) {
      if (c?.image_url && !seen.has(c.image_url)) {
        seen.add(c.image_url)
        refs.push({ type: 'char-fill', name: String(c.name || ''), url: c.image_url })
      }
    }
  }
  // 主分配：前 slots 个拿 slot 1..slots，其余 slot=null（剧情文字兜底）
  refs.forEach((r, i) => { r.slot = i < slots ? i + 1 : null })
  // 补满（仅 fill=true）：真实图不足 slots 时循环复用已分配的图占满空槽（dup=true，不进"图N"声明）。
  // 同一张图多槽占位对 i2i 无语义伤害，远好于空槽；fill=false 时保留真实空槽，调用侧不上传。
  if (fill) {
    const primary = refs.filter((r) => r.slot != null)
    for (let i = primary.length; i < slots && primary.length; i++) {
      const base = primary[i % primary.length]
      refs.push({ type: base.type, name: base.name, url: base.url, slot: i + 1, dup: true })
    }
  }
  return refs
}
