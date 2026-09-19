/**
 * 分镜导入内核
 *
 * 设计立场：适配用户的文件，而不是让用户适配我们。
 *
 * 四条硬规则：
 * 1. 任何输入都不提前退出。认不出表头就靠内容推断，推断不出就降级为自由文本，
 *    再不行按段落切分。用户不该为格式买单。
 * 2. 表头 / 字段名认不出来时用内容特征猜：最长的列是描述、纯数字列是时长、
 *    全是景别词的列是景别……猜的结果对外暴露，UI 上允许用户改。
 * 3. 用户写的值原样保留。时长不裁剪到 3-15 秒，资产名不强行改成资产库里的名字。
 * 4. 不做任何"你这份文件不属于当前剧本"的拦截。最多给一句软提示。
 */

/* ============================ 语义字段定义 ============================ */

/**
 * key        内部字段名
 * label      UI 展示名（映射下拉用）
 * aliases    表头 / JSON key 别名。匹配时用归一化后的最长命中，先到先得
 * probe      内容特征探测：给定该列采样值，返回 0~1 的"这列像不像该字段"
 * merge      该字段的值如何并进镜头对象
 */
export const FIELD_DEFS = [
  {
    key: 'sceneTitle',
    label: '场次/分组',
    aliases: [
      '场次', '场景号', '场景编号', '场号', '第几场', '场次名称', '场次标题', '所属场次',
      'scene no', 'scene number', 'scene id', 'scene name', 'scene',
    ],
    probe: (vals) => ratio(vals, (v) => /^(场次|第.?[一二三四五六七八九十\d]+场|scene\s*\d+)/i.test(v)),
  },
  {
    key: 'shotNo',
    label: '镜号',
    aliases: [
      '镜头号', '镜号', '镜头编号', '分镜号', '镜位', '编号', '序号',
      'shot no', 'shot number', 'shot id', 'shot',
    ],
    probe: (vals) => {
      const nums = vals.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0)
      if (nums.length < Math.max(2, vals.length * 0.6)) return 0
      // 递增编号是镜号的强信号
      let asc = 0
      for (let i = 1; i < nums.length; i++) if (nums[i] >= nums[i - 1]) asc++
      return nums.length > 1 ? asc / (nums.length - 1) : 0.5
    },
  },
  {
    key: 'description',
    label: '画面描述',
    aliases: [
      '视频画面描述', '画面描述', '画面内容', '镜头描述', '分镜描述', '内容描述', '视频描述',
      '动作描述', '画面', '描述', '内容', '分镜内容', '视频内容',
      'visual', 'shot description', 'video description', 'description', 'desc', 'content', 'action',
    ],
    probe: (vals) => {
      const avg = avgLen(vals)
      if (avg < 8) return 0
      // 描述列是所有列里最长的，给长度打高分，并惩罚"短枚举值"列
      const enumLike = ratio(vals, (v) => v.length <= 6)
      // 句子感（长 + 带逗号句号）是描述列的强信号，防止被运镜/景别词骗走
      const sentenceLike = ratio(vals, (v) => v.length >= 15 && /[，,。；;]/.test(v))
      return Math.min(1, avg / 40) * (1 - enumLike * 0.6) + sentenceLike * 0.4
    },
  },
  {
    key: 'duration',
    label: '时长(秒)',
    aliases: [
      '时长', '秒数', '持续时间', '时间长度', '镜头时长', '长度', '时间',
      'duration', 'length', 'sec', 'seconds', 'time',
    ],
    probe: (vals) => {
      const nums = vals.map((v) => parseDuration(v)).filter((n) => n > 0)
      if (nums.length < Math.max(1, vals.length * 0.5)) return 0
      const inRange = nums.filter((n) => n >= 0.5 && n <= 120).length
      return inRange / vals.length
    },
  },
  {
    key: 'timecode',
    label: '时间轴区间',
    aliases: ['时间轴', '时间码', 'tc in', 'tc out', 'timecode', 'tc', 'in out'],
    probe: (vals) => ratio(vals, (v) => /\d+\s*[:：]\s*\d+/.test(v) || /\d+\s*[-–—~至]\s*\d+\s*[秒s]?/.test(v)),
  },
  {
    key: 'shotType',
    label: '景别',
    aliases: ['景别', '镜头类型', '镜头大小', '画面景别', '取景', '类型', 'shot type', 'type', 'size', 'framing'],
    probe: (vals) => ratio(vals, (v) => v.length <= 10 && matchInList(v, SHOT_TYPE_WORDS)),
  },
  {
    key: 'camera',
    label: '运镜',
    aliases: ['摄影机', '摄影机运动', '运镜', '镜头运动', '拍摄方式', '机位运动', '镜头动作', 'camera movement', 'camera', 'movement'],
    // 描述句里常含"跟拍""拉远"这类词，长句直接排除，只认短枚举值
    probe: (vals) => ratio(vals, (v) => v.length <= 12 && matchInList(v, CAMERA_WORDS)),
  },
  {
    key: 'cameraAngle',
    label: '机位朝向',
    // 2026-09-15 补：camera_angle 是库中一等字段（机位一致性校验的地基，schema.sql 专门注释过），
    // 而 stores/project.js 一直有 cameraAngle 透传——只有导入通道读不到，属漏斗漏了一环。
    // 服务端落库读 shot.camera_angle || shot.cameraAngle（routes/episodes.js），故本字段同名即可直落。
    aliases: [
      '机位朝向', '机位角度', '机位', '拍摄角度', '取景角度', '朝向',
      'camera angle', 'cameraangle', 'angle',
    ],
    // 探测故意保守：只在列里出现「正面/侧面/背面」这类**机位专属词**时才认。
    // 原因：过肩/俯拍/仰拍同时也在 SHOT_TYPE_WORDS 里，若不加这道前置判断，
    // 一个全是「俯拍」的景别列会被机位抢走（无表头文件里两者 probe 同分）。
    // 有「机位」表头时不受此限——表头命中 10+ 分永远压过 probe 的 5 分。
    probe: (vals) => {
      const exclusive = ratio(vals, (v) => /^(正面|侧面|背面|正拍|背拍|front|side|back)$/i.test(String(v || '').trim()))
      if (exclusive === 0) return 0
      return ratio(vals, (v) => v.length <= 8 && matchInList(v, CAMERA_ANGLE_WORDS))
    },
  },
  {
    key: 'actionNote',
    label: '动作说明',
    aliases: ['动作说明', '拍摄要点', '表演', '演员调度', '备注', '说明', 'action note', 'notes', 'note'],
    probe: () => 0, // 内容上无法与描述区分，只靠表头
  },
  {
    key: 'characters',
    label: '角色',
    aliases: ['出场角色', '出场人物', '角色名', '人物', '角色', 'characters', 'actors', 'character', 'cast'],
    probe: (vals) => ratio(vals, (v) => isNameList(v)),
  },
  {
    key: 'sceneAssets',
    label: '场景资产',
    aliases: ['场景资产', '关联场景', '场地', '场景名', '场景', 'scenes', 'scene assets', 'location', 'place', 'setting'],
    probe: (vals) => ratio(vals, (v) => isNameList(v) && v.length <= 16),
  },
  {
    key: 'props',
    label: '道具',
    aliases: ['道具资产', '关联道具', '物件', '道具', 'props', 'prop'],
    probe: (vals) => ratio(vals, (v) => isNameList(v, 8) && v.length <= 12),
  },
  {
    key: 'soundEffects',
    label: '音效',
    aliases: ['画内音效', '音效', 'sound effects', 'sfx', 'sound'],
    probe: () => 0,
  },
  {
    key: 'overallSoundscape',
    label: '环境声',
    aliases: ['环境声', '环境音', '空间氛围', 'overall soundscape', 'ambience', 'ambient'],
    probe: () => 0,
  },
  {
    key: 'nonDiegeticMusic',
    label: '配乐',
    aliases: ['背景音乐', '配乐', '音乐', 'non diegetic music', 'bgm', 'music'],
    probe: () => 0,
  },
  {
    key: 'dialogue',
    label: '台词',
    aliases: ['台词', '对白', 'dialogue', 'dialog', 'lines'],
    probe: (vals) => ratio(vals, (v) => /[“”"'].+[“”"']/.test(v) || /^[^：:]{1,8}[：:]/.test(v)),
  },
  {
    key: 'integrated',
    label: 'AI 视频提示词',
    aliases: ['视频提示词', '多模态描述', 'ai提示词', '提示词', 'integrated multimodal description', 'integrated', 'multimodal', 'prompt'],
    probe: (vals) => {
      const avg = avgLen(vals)
      return avg > 60 ? 1 : avg > 25 ? 0.6 : 0
    },
  },
  {
    key: 'finalFrame',
    label: '最终画面',
    aliases: ['最终画面', '结尾画面', '定格', '尾帧', 'final frame', 'end frame'],
    probe: (vals) => {
      const avg = avgLen(vals)
      return avg > 40 ? 0.8 : 0
    },
  },
]

export const FIELD_LABELS = Object.fromEntries(FIELD_DEFS.map((d) => [d.key, d.label]))

/** 语义字段 → 镜头对象字段名（大部分同名，这两个历史原因不同名） */
const SHOT_FIELD_OF = {
  camera: 'cameraMovement',
  integrated: 'integratedMultimodalDescription',
  props: 'propAssets',
}
const shotFieldOf = (field) => SHOT_FIELD_OF[field] || field

/** 把识别到的值写进镜头对象，统一处理列表字段与字段改名 */
function applyField(shot, field, value) {
  if (field === 'duration' || field === 'timecode') {
    const d = parseDuration(value)
    if (d > 0 && !shot.duration) shot.duration = d
    return
  }
  if (field === 'dialogue') {
    const d = parseDialogue(value)
    if (d && !shot.dialogue) shot.dialogue = d
    return
  }
  if (LIST_FIELDS.has(field)) {
    const key = shotFieldOf(field)
    const names = Array.isArray(value) ? value.map(String).filter(Boolean) : splitNames(value)
    if (names.length && !shot[key].length) shot[key] = names
    return
  }
  if (field === 'sceneTitle') {
    if (!shot._sceneTitle) shot._sceneTitle = isStr(value) ? value : String(value ?? '')
    return
  }
  if (field === 'shotNo') {
    if (!shot._shotNo) shot._shotNo = String(value)
    return
  }
  const key = shotFieldOf(field)
  if (value == null) return
  const v = String(value).trim()
  if (v && !shot[key]) shot[key] = v
}
const LIST_FIELDS = new Set(['characters', 'sceneAssets', 'props'])

const SHOT_TYPE_WORDS = [
  '远景', '大全景', '全景', '中全景', '中景', '中近景', '近景', '特写', '大特写', '过肩', '主观', '俯拍', '仰拍',
  'ws', 'ms', 'mcu', 'cu', 'ecu', 'wide', 'medium', 'close up', 'closeup', 'close-up', 'extreme',
]
const CAMERA_WORDS = [
  '固定', '静止', '推近', '推', '拉远', '拉', '横摇', '摇', '平移', '移', '跟拍', '跟随', '环绕', '升降',
  '俯拍', '仰拍', '手持', '肩扛', '斯坦尼康', '航拍', '变焦', '甩镜',
  'static', 'push in', 'pull out', 'pan', 'tilt', 'tracking', 'dolly', 'orbit', 'handheld', 'crane', 'zoom',
]
// 机位朝向六选一（与 storyboardRules.cameraAngleRule / cameraAngle.js / doubao.js CAMERA_ANGLE_VALUES 同口径）。
// 注意 过肩/俯拍/仰拍 与 SHOT_TYPE_WORDS 重叠——探测侧靠 probe 前置的"专属词"判断避开，见 FIELD_DEFS。
const CAMERA_ANGLE_WORDS = [
  '正面', '侧面', '背面', '过肩', '俯拍', '仰拍', '正拍', '背拍', '平视', '45度', '三分四',
  'front', 'side', 'back', 'over the shoulder', 'over-the-shoulder', 'high angle', 'low angle', 'three-quarter',
]

/* ============================ 通用小工具 ============================ */

const isStr = (v) => typeof v === 'string'
const ratio = (arr, fn) => {
  const list = (arr || []).filter((v) => isStr(v) && v.trim())
  if (!list.length) return 0
  return list.filter(fn).length / list.length
}
const avgLen = (arr) => {
  const list = (arr || []).filter((v) => isStr(v))
  if (!list.length) return 0
  return list.reduce((s, v) => s + v.trim().length, 0) / list.length
}
const matchInList = (v, words) => {
  const s = String(v || '').trim().toLowerCase()
  if (!s || s.length > 20) return false
  return words.some((w) => s === w || s.includes(w))
}
// 「布布、一二」/「布布, 一二」/「布布/一二」这类名字列表。
// 有分隔符时每一段都必须短得像个名字——否则"描述文字，里带逗号"会被误判成角色列表
const isNameList = (v, maxSeg = 6) => {
  const s = String(v || '').trim()
  if (!s || s.length > 30) return false
  if (/[。！？!?；;]/.test(s)) return false
  if (/[、,，\/|]/.test(s)) {
    const segs = s.split(/[,，、\/|]+/).map((x) => x.trim()).filter(Boolean)
    return segs.length > 1 && segs.every((seg) => seg.length <= maxSeg)
  }
  return s.length <= maxSeg
}

/** 归一化 key：小写、去空格下划线连字符点号、去括号内容 */
export function normKey(k) {
  return String(k ?? '')
    .toLowerCase()
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s_\-·.。、]/g, '')
}

/**
 * 表头 / JSON key → 语义字段。
 * 正向包含优先（"视频画面描述" 命中 "画面描述"），
 * 反向包含兜底（key 是别名的缩写，如 "shot" 命中 "shot number"），要求 key 至少 3 字避免误伤。
 */
export function matchSemanticKey(rawKey) {
  const k = normKey(rawKey)
  if (!k) return null
  // 起止时间是时间轴定位字段，不是"时长"。不拦的话 "startTime".includes("time") 会把时长劫走
  if (/^(starttime|endtime|begintime|start|end|开始时间|结束时间|起始时间|起止时间|开始秒|结束秒|入点|出点)$/.test(k)) {
    return null
  }
  let best = null
  let bestLen = -1
  for (const def of FIELD_DEFS) {
    for (const alias of def.aliases) {
      const a = normKey(alias)
      if (!a) continue
      let len = -1
      if (k.includes(a)) len = a.length
      else if (k.length >= 3 && a.includes(k)) len = k.length
      if (len > bestLen) {
        bestLen = len
        best = def.key
      }
    }
  }
  return best
}

/* ============================ 编码与格式探测 ============================ */

const DECOR_CHARS = '\\s\\-=_─━═╌╍┈┉┌┐└┘├┤┬┴┼╔╗╚╝╠╣╦╩╬╭╮╰╯·'
const isDecorLine = (line) => new RegExp(`^[${DECOR_CHARS}]*$`).test(String(line || ''))

/** UTF-8 严格解码失败时回落 GB18030（中文 Windows 记事本默认存的 ANSI） */
export async function decodeFileBuffer(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    try {
      return new TextDecoder('gb18030').decode(buf)
    } catch {
      return new TextDecoder('utf-8').decode(buf)
    }
  }
}

export function detectFormat(text) {
  const src = String(text || '').trim()
  if (!src) return 'empty'
  const unwrapped = src.replace(/^```(?:json|jsonc)?\s*/i, '').replace(/```\s*$/, '')
  if (unwrapped.startsWith('{') || unwrapped.startsWith('[')) {
    try {
      JSON.parse(unwrapped)
      return 'json'
    } catch {
      /* 长得像 JSON 但语法坏了，按文本继续 */
    }
  }
  return 'text'
}

/* ============================ 表格抽取 ============================ */

/** 探测分隔符：优先竖线，其次 tab / 分号 / 逗号。要求大多数行都切得出相同列数 */
function detectDelimiter(lines) {
  const sample = lines.slice(0, 30).filter((l) => l.trim())
  if (sample.length < 2) return null
  const candidates = ['|', '\t', '；', ';', ',', '，']
  let best = null
  for (const d of candidates) {
    const counts = sample.map((l) => splitDelimited(l, d).length)
    const withD = counts.filter((c) => c > 1).length
    if (withD / sample.length < 0.7) continue
    // 列数众数的占比：越一致越像表格
    const freq = new Map()
    counts.forEach((c) => freq.set(c, (freq.get(c) || 0) + 1))
    const modal = Math.max(...freq.values())
    const consistency = modal / counts.length
    if (consistency < 0.6) continue
    const cols = Math.max(...counts)
    if (!best || cols > best.cols || (cols === best.cols && consistency > best.consistency)) {
      best = { d, cols, consistency }
    }
  }
  return best
}

function splitDelimited(line, d) {
  if (line.indexOf('"') === -1) return line.split(d).map((s) => s.trim())
  const out = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"'
        i++
      } else inQ = !inQ
    } else if (ch === d && !inQ) {
      out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  out.push(cur.trim())
  return out
}

/**
 * 字符画表格（│镜头│时间│画面内容│…│）：AI 聊天记录 / Word 导出 txt 最常见的形式。
 * 与通用分隔符探测分开处理，原因有二：
 * 1. 这类文件表格只占全文一部分（前后有说明文字），通用探测的 70% 采样门槛永远过不了
 * 2. 单元格内容被换行拆开（一个镜头占多个物理行）、多张表各带一遍表头——都需要专门处理
 *
 * 返回 { rows, sections }：sections[i].index 指向 rows 中该表格第一个数据行的下标，
 * title 是表格上方最近的「段N/场次N/第X场」标题，供 buildShotsFromRows 还原分组。
 */
function extractBoxTables(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/[│┃║]/g, '|').trim())
  const isBoxLine = (l) => l.startsWith('|') && l.endsWith('|') && l.replace(/\||\s/g, '').length > 0

  const rawRows = []
  const secMarks = []
  let inTable = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (isBoxLine(line)) {
      if (!inTable) {
        inTable = true
        // 表头先占一行；段落标题挂在其后的第一个数据行上
        secMarks.push({ index: rawRows.length + 1, title: findSectionTitle(lines, i) })
        rawRows.push(splitBoxRow(line))
      } else {
        rawRows.push(splitBoxRow(line))
      }
    } else {
      inTable = false
    }
  }
  if (rawRows.length < 3) return null

  // 列数众数过滤：混进来的杂行（列数不同的手写行）剔除
  const freq = new Map()
  rawRows.forEach((r) => freq.set(r.length, (freq.get(r.length) || 0) + 1))
  const [modal, modalN] = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]
  if (modal < 2 || modalN / rawRows.length < 0.7) return null

  // 重复表头剔除（第 2/3 张表自带一模一样的表头），同时重映射 sections 下标
  const headStr = JSON.stringify(rawRows[0])
  const oldToNew = new Map()
  const rows = []
  for (let i = 0; i < rawRows.length; i++) {
    if (rawRows[i].length !== modal) continue
    if (i > 0 && JSON.stringify(rawRows[i]) === headStr) continue
    oldToNew.set(i, rows.length)
    rows.push(rawRows[i])
  }
  const sections = secMarks
    .map((s) => ({ index: oldToNew.get(s.index), title: s.title }))
    .filter((s) => s.index !== undefined && s.index >= 0)

  return rows.length >= 2 ? { rows, sections } : null
}

/**
 * 字符画表格专用切列：按竖线硬切，不做引号感知。
 * 单元格里常出现英文引号（如画面描述里的 "碧海+天际线"），quote 感知解析会把整行吞成一列。
 */
function splitBoxRow(line) {
  return line
    .slice(1, -1)
    .split('|')
    .map((s) => s.trim())
}

/** 表格上方最近的段落标题：段N / 场次N / 第X场 / SCENE N，最多回看 6 个有效行（跳过装饰线和「机位基调：」这类字段行） */
function findSectionTitle(lines, tableStart) {
  const re = /^(?:[-*•·]\s*)?(段|场次|第.{1,3}场|scene)\s*[一二三四五六七八九十\d]/i
  let looked = 0
  for (let j = tableStart - 1; j >= 0 && looked < 6; j--) {
    const t = lines[j]
    if (!t || isDecorLine(t)) continue
    looked++
    if (re.test(t)) return t
    if (/^[^：:]{1,14}[：:]/.test(t)) continue // 字段行（机位基调：…）不算正文，继续往上找
    break // 第一个普通正文行还不是段落标题就放弃
  }
  return ''
}

/**
 * 从任意文本里抽表格：字符画表格、Markdown 表格、CSV、TSV 都认。
 * 全角竖线/粗竖线统一按竖线处理，边框行直接丢弃。
 * 返回 { rows, sections? } 或 null。
 */
export function extractRows(text) {
  const box = extractBoxTables(text)
  if (box) return box

  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/[│┃║]/g, '|').trim())
  const usable = lines.filter((l) => l && !isDecorLine(l) && !/^\|?[\s\-:|]+\|?$/.test(l))
  const delim = detectDelimiter(usable)
  if (!delim) return null

  const rows = []
  for (const line of usable) {
    if (!line.includes(delim.d)) continue
    const cells = splitDelimited(
      line.replace(/^\s*[|│┃║]+\s*/, '').replace(/\s*[|│┃║]+\s*$/, ''),
      delim.d
    ).map((c) => c.replace(/^\s*[|│┃║]+/, '').replace(/[|│┃║]+\s*$/, '').trim())
    if (!cells.some((c) => c && !isDecorLine(c))) continue
    rows.push(cells)
  }
  return rows.length >= 2 ? { rows } : null
}

/**
 * 表头存在性检测。
 * 用户的 Excel 常常第一行就是数据（没有表头），把数据行当表头会整列错位。
 * 判据：表头行通常是「短词 + 无句末标点 + 无长句」。
 */
function looksLikeHeader(row, dataRows) {
  const cells = (row || []).map((c) => String(c || '').trim())
  if (!cells.some(Boolean)) return false
  const nonEmpty = cells.filter(Boolean)
  // 含句末标点的几乎一定是正文
  if (nonEmpty.some((c) => /[。！？!?；;]$/.test(c))) return false
  // 表头很短
  if (nonEmpty.every((c) => c.length <= 12)) {
    // 且下面数据的平均长度明显更长（描述列尤其明显）
    if (dataRows.length) {
      const dataAvg = avgLen(dataRows.flat().filter(Boolean))
      const headAvg = avgLen(nonEmpty)
      if (dataAvg > headAvg * 1.2) return true
    }
    return nonEmpty.every((c) => c.length <= 8)
  }
  return false
}

/**
 * 列 → 语义字段推断。
 * 表头命中给 10 分权重（按命中别名长度），内容特征给 5 分权重。
 * 表头完全不认识时，纯靠内容特征也能挑出来。
 */
export function inferMapping(rows, { hasHeader }) {
  const header = hasHeader ? rows[0].map((c) => String(c || '').trim()) : []
  const body = hasHeader ? rows.slice(1) : rows
  const colCount = Math.max(...rows.map((r) => r.length))
  const columns = []
  for (let i = 0; i < colCount; i++) columns.push(body.map((r) => String(r[i] ?? '')).filter((v) => v.trim()))

  const mapping = {}
  const confidence = {}
  const taken = new Set()

  // 打分矩阵：score[fieldKey][colIndex]
  const scores = []
  for (const def of FIELD_DEFS) {
    const row = []
    for (let i = 0; i < colCount; i++) {
      let s = 0
      const h = header[i] ? normKey(header[i]) : ''
      if (h) {
        let hitLen = 0
        for (const alias of def.aliases) {
          const a = normKey(alias)
          if (!a) continue
          if (h.includes(a)) hitLen = Math.max(hitLen, a.length)
          else if (h.length >= 3 && a.includes(h)) hitLen = Math.max(hitLen, h.length)
        }
        if (hitLen) s += 10 + hitLen
      }
      const probe = def.probe ? def.probe(columns[i]) : 0
      s += probe * 5
      row.push({ score: s, headerHit: !!h && s >= 10, probe })
    }
    scores.push({ key: def.key, row })
  }

  // 全局贪心：先分配分数最高的 (字段, 列) 组合，避免两字段抢同一列
  const all = []
  scores.forEach((s, fi) => s.row.forEach((cell, ci) => all.push({ fi, ci, ...cell })))
  all.sort((a, b) => b.score - a.score)
  for (const item of all) {
    if (item.score < 3) continue
    if (taken.has(item.ci)) continue
    if (mapping[FIELD_DEFS[item.fi].key] !== undefined) continue
    mapping[FIELD_DEFS[item.fi].key] = item.ci
    confidence[FIELD_DEFS[item.fi].key] = item.headerHit ? 'high' : item.probe > 0.5 ? 'mid' : 'low'
    taken.add(item.ci)
  }

  // 描述列兜底：一个都没认出来时，取平均长度最长的那列
  if (mapping.description === undefined && colCount > 0) {
    let bestI = -1
    let bestLen = -1
    for (let i = 0; i < colCount; i++) {
      if (taken.has(i)) continue
      const l = avgLen(columns[i])
      if (l > bestLen) {
        bestLen = l
        bestI = i
      }
    }
    if (bestI >= 0 && bestLen >= 8) {
      mapping.description = bestI
      confidence.description = 'low'
      taken.add(bestI)
    }
  }

  return { mapping, confidence, header, columns }
}

/** 行内复合字段：一个单元格里塞了「景别：中景　时长：5s」这种，拆出来补进镜头 */
function absorbInlineFields(shot, text) {
  if (!text) return
  const re = /([^\s:：;；,，。]{1,10})\s*[:：]\s*([^:：;；]{1,400})/g
  let m
  while ((m = re.exec(text))) {
    const field = matchSemanticKey(m[1])
    if (!field || field === 'description') continue
    const val = m[2].trim()
    if (val) applyField(shot, field, val)
  }
}

/** 按列映射把表格行构建成镜头列表。sections: [{index, title}] 标记哪些行是新段落的开始 */
export function buildShotsFromRows(rows, mapping, { hasHeader, knownAssets, sections } = {}) {
  const body = hasHeader ? rows.slice(1) : rows
  const sectionAt = new Map((sections || []).map((s) => [s.index, s.title]))
  // 镜号/时长列存在时才有资格判断"续行"；都没有的话无法区分续行和真镜头，宁可不合并
  const canMergeWrapped = ['shotNo', 'duration', 'timecode'].some((k) => mapping[k] !== undefined)
  const cellOf = (row, key) => {
    const i = mapping[key]
    return i === undefined || i === null || i < 0 ? '' : String(row[i] ?? '').trim()
  }

  // 先合并被换行拆开的续行：镜号、时长、时间码全空但有其他内容 → 是上一镜的续行，逐列拼回
  // （字符画表格单元格里一行放不下，用户文件里几乎必然出现）。
  // sectionOfMerged[j] = 合并后第 j 行开头遇到的段落标题（还原 段1/段2/段3 分组）
  const merged = []
  const sectionOfMerged = []
  for (let bi = 0; bi < body.length; bi++) {
    const row = body[bi]
    const rowsIdx = bi + (hasHeader ? 1 : 0)

    const nonEmptyCols = row.map((c, i) => (String(c ?? '').trim() ? i : -1)).filter((i) => i >= 0)
    // 仅场次列有值的短行：是分组标题行，不是续行
    const onlySceneCol = nonEmptyCols.length === 1 && nonEmptyCols[0] === mapping.sceneTitle
    const prev = merged[merged.length - 1]
    const isWrapped =
      canMergeWrapped &&
      prev &&
      !cellOf(row, 'shotNo') &&
      !cellOf(row, 'duration') &&
      !cellOf(row, 'timecode') &&
      !onlySceneCol &&
      nonEmptyCols.length > 0
    if (isWrapped) {
      for (const i of nonEmptyCols) {
        prev[i] = `${prev[i] ?? ''}${String(row[i] ?? '').trim()}`
      }
      continue
    }
    merged.push([...row])
    sectionOfMerged.push(sectionAt.has(rowsIdx) ? sectionAt.get(rowsIdx) : '')
  }

  const shots = []
  let pendingSceneTitle = ''

  merged.forEach((row, j) => {
    if (sectionOfMerged[j]) pendingSceneTitle = sectionOfMerged[j]

    const cell = (key) => cellOf(row, key)

    const sceneTitle = cell('sceneTitle')
    const shotNo = cell('shotNo')
    const description = cell('description')
    const durationRaw = cell('duration') || cell('timecode')

    // 整行只有一个场次名、没有画面内容 → 当作场次分组行
    if (!description && !shotNo && sceneTitle) {
      pendingSceneTitle = sceneTitle
      return
    }
    // 整行只有一格有内容且很短 → 多半是插在中间的分组标题，不是镜头
    const nonEmpty = row.map((c) => String(c ?? '').trim()).filter(Boolean)
    if (!shotNo && !durationRaw && nonEmpty.length === 1 && description.length <= 20) {
      pendingSceneTitle = sceneTitle || description
      return
    }
    if (!description && !shotNo && !durationRaw) return

    const shot = emptyShot()
    if (description) shot.description = description
    // ⚠ 这份清单是**独立的第二处白名单**：字段即使已进 FIELD_DEFS、列映射也认出来了，
    // 不在这里列出来照样被静默丢弃（cameraAngle 就是这么漏的：映射 high 命中，值却没进镜头）。
    // 新增语义字段时必须同时改两处：FIELD_DEFS 与本清单。sceneTitle / shotNo 在下方单独处理。
    for (const key of [
      'duration', 'timecode', 'shotType', 'camera', 'cameraAngle', 'actionNote', 'soundEffects',
      'overallSoundscape', 'nonDiegeticMusic', 'dialogue', 'integrated', 'finalFrame',
      'characters', 'sceneAssets', 'props',
    ]) {
      const v = cell(key)
      if (v) applyField(shot, key, v)
    }

    // 未被映射的列：如果里面是「字段名：值」的复合写法，补进来
    const used = new Set(Object.values(mapping))
    row.forEach((c, i) => {
      if (used.has(i)) return
      const t = String(c ?? '').trim()
      if (t && t.includes('：')) absorbInlineFields(shot, t)
    })

    shot._sceneTitle = sceneTitle || pendingSceneTitle
    if (!shot.description) {
      // 没有任何描述时，用其余字段拼一句，保证下游有东西可展示
      shot.description = [shot.actionNote, shot.dialogue?.text].filter(Boolean).join(' ') || ''
    }
    shots.push(shot)
  })

  return groupIntoScenes(shots, knownAssets)
}

/* ============================ JSON 解析 ============================ */

/** 递归收集所有对象数组，带上路径，供后续打分挑选 */
function collectObjectArrays(node, path, out, depth = 0) {
  if (depth > 8 || node == null) return
  if (Array.isArray(node)) {
    const objs = node.filter((n) => n && typeof n === 'object' && !Array.isArray(n))
    if (objs.length) out.push({ path, arr: objs, size: node.length })
    node.forEach((n, i) => collectObjectArrays(n, `${path}[${i}]`, out, depth + 1))
    return
  }
  if (typeof node === 'object') {
    for (const k of Object.keys(node)) collectObjectArrays(node[k], path ? `${path}.${k}` : k, out, depth + 1)
  }
}

function scoreShotArray(arr) {
  const sample = arr.slice(0, 20)
  const keys = new Set()
  sample.forEach((o) => Object.keys(o).forEach((k) => keys.add(normKey(k))))
  let score = 0
  for (const k of keys) {
    const f = matchSemanticKey(k)
    if (f === 'description') score += 5
    else if (f === 'duration' || f === 'timecode') score += 2
    else if (f === 'shotType' || f === 'camera') score += 1
    else if (f) score += 0.5
  }
  // 长文本值是描述的强信号（字段名可能完全不认识）
  const longRatio =
    sample.filter((o) => Object.values(o).some((v) => isStr(v) && v.trim().length > 15)).length / sample.length
  score += longRatio * 4
  score += Math.min(sample.length, 15) * 0.08
  return score
}

function scoreSceneArray(arr) {
  const sample = arr.slice(0, 20)
  const childRatio =
    sample.filter((o) => Object.values(o).some((v) => Array.isArray(v) && v.length)).length / sample.length
  const titleRatio =
    sample.filter((o) => Object.keys(o).some((k) => /title|name|场次|场景|标题|heading/.test(normKey(k)))).length /
    sample.length
  return childRatio * 5 + titleRatio * 2
}

/**
 * 尽力修常见的 JSON 坏法：尾逗号、结尾被截断缺右括号。
 * 只做这两刀——修不好就返回原文，由调用方降级成文本解析，绝不猜内容。
 */
function repairJson(src) {
  let out = String(src).replace(/,\s*([}\]])/g, '$1')
  // 扫括号栈（跳过字符串字面量），结尾缺多少右括号就补多少
  const stack = []
  let inStr = false
  let esc = false
  for (const ch of out) {
    if (esc) {
      esc = false
      continue
    }
    if (ch === '\\') {
      esc = true
      continue
    }
    if (ch === '"') {
      inStr = !inStr
      continue
    }
    if (inStr) continue
    if (ch === '{' || ch === '[') stack.push(ch)
    else if (ch === '}' || ch === ']') stack.pop()
  }
  if (stack.length && stack.length <= 6 && !inStr) {
    const close = { '{': '}', '[': ']' }
    out = out.replace(/[\s,;:]+$/, '') + stack.reverse().map((c) => close[c]).join('')
  }
  return out
}

/**
 * JSON → 镜头。不假设 scenes[].shots[] 这种结构：
 * 递归扫出所有对象数组，挑最像镜头数组的那个；若存在"带子数组 + 带标题"的场次结构则按场次分组。
 */
export function parseJson(text, knownAssets) {
  const unwrapped = String(text).trim().replace(/^```(?:json|jsonc)?\s*/i, '').replace(/```\s*$/, '')
  let data
  try {
    data = JSON.parse(unwrapped)
  } catch {
    // 常见坏法：尾逗号、结尾被截断缺右括号。修一刀再试，别急着降级成文本
    try {
      data = JSON.parse(repairJson(unwrapped))
    } catch {
      return null
    }
  }

  const arrays = []
  collectObjectArrays(data, '', arrays)
  if (!arrays.length) return null

  // 场次数组：元素里有子数组 + 有标题类 key
  const sceneCandidates = arrays.filter((a) => scoreSceneArray(a.arr) >= 5)
  if (sceneCandidates.length) {
    const sceneArr = sceneCandidates.sort((a, b) => scoreSceneArray(b.arr) - scoreSceneArray(a.arr))[0]
    const scenes = []
    for (const node of sceneArr.arr) {
      const childKey = Object.keys(node).find((k) => Array.isArray(node[k]) && node[k].length)
      if (!childKey) continue
      const title =
        node.title ?? node.sceneName ?? node.scene_name ?? node.name ?? node.场次 ?? node.标题 ?? ''
      const shots = node[childKey]
        .filter((s) => s && typeof s === 'object')
        .map((s) => objectToShot(s))
        .filter((s) => s.description || s.duration || s.integrated)
      if (shots.length) scenes.push({ title: String(title || `场次${scenes.length + 1}`), shots })
    }
    if (scenes.length) {
      return { ...groupIntoScenes(flattenScenes(scenes), knownAssets), structure: 'nested' }
    }
  }

  // 没有场次结构：挑最像镜头数组的那组，整包当一个场次
  const shotCandidates = arrays
    .map((a) => ({ ...a, score: scoreShotArray(a.arr) }))
    .filter((a) => a.score >= 2)
    .sort((a, b) => b.score - a.score)
  if (!shotCandidates.length) return null
  const shots = shotCandidates[0].arr.map((o) => objectToShot(o)).filter((s) => s.description || s.duration || s.integratedMultimodalDescription)
  if (!shots.length) return null
  return { ...groupIntoScenes(shots, knownAssets), structure: 'flat' }
}

const flattenScenes = (scenes) => scenes.flatMap((s) => s.shots.map((shot) => ({ ...shot, _sceneTitle: s.title })))

/** 任意结构的对象 → 镜头。字段名靠 matchSemanticKey 模糊认，认不出的长文本当描述 */
function objectToShot(obj) {
  const shot = emptyShot()
  const unknown = []
  let startAt = NaN
  let endAt = NaN
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || v === '') continue
    const nk = normKey(k)
    // 起止时间：单独记下来，缺 duration 时用差值补
    if (/^(starttime|开始时间|起始时间|开始秒)$/.test(nk)) {
      startAt = parseDuration(v)
      continue
    }
    if (/^(endtime|结束时间|结束秒)$/.test(nk)) {
      endAt = parseDuration(v)
      continue
    }
    const field = matchSemanticKey(k)
    if (!field) {
      if (isStr(v) && v.trim().length > 12) unknown.push(v.trim())
      continue
    }
    applyField(shot, field, v)
  }
  if ((!shot.duration || shot.duration <= 0) && Number.isFinite(startAt) && Number.isFinite(endAt) && endAt > startAt) {
    shot.duration = Math.round((endAt - startAt) * 10) / 10
  }
  if (!shot.description && unknown.length) shot.description = unknown[0]
  // 对象里可能藏着 "景别：中景 时长：5s" 这种复合串
  if (shot.description && shot.description.includes('：')) absorbInlineFields(shot, shot.description)
  return shot
}

/* ============================ 自由文本解析 ============================ */

const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
function cn2num(s) {
  if (!s) return NaN
  if (/^\d+$/.test(s)) return Number(s)
  let n = 0
  if (s.includes('十')) {
    const [a, b] = s.split('十')
    n = (a ? CN_NUM[a] || 1 : 1) * 10 + (b ? CN_NUM[b] || 0 : 0)
  } else {
    for (const ch of s) n = n * 10 + (CN_NUM[ch] || 0)
  }
  return n || NaN
}

// 场次：场次1 / 第1场 / 第一场 / 场景1 / 【场次1】 / SCENE 1 / INT.客厅-日 / ## 1. 客厅
const SCENE_RE = /^\s*(?:#{1,6}\s*)?[-*•·]?\s*[【\[（(]?\s*(?:场次|场景|第|scene|sc)\s*[：:.]?\s*([0-9]+|[一二三四五六七八九十]+)\s*[】\]）)]?\s*(?:场|scene)?\s*[：:.\-–—]?\s*(.*)$/i
// 单字「内/外」太容易误伤正文，只认完整写法
const INT_EXT_RE = /^\s*(?:#{1,6}\s*)?(INT\.?|EXT\.?|INT\/EXT\.?|内景|外景|室内|室外)\s*[.。]?\s*[-－—]?\s*(.*)$/i

// 镜头：镜头1 / 镜1 / 【镜头1】 / Shot 1 / C001 / 1. / 1、/ 1) / - 开头
const SHOT_STRONG_RE = /^\s*(?:#{1,6}\s*)?[-*•·]?\s*[【\[（(]?\s*(?:镜头|镜位|镜|shot|scene\s*shot)\s*[：:.]?\s*([0-9]+|[一二三四五六七八九十]+)\s*[】\]）)]?\s*[：:.\-–—]?\s*(.*)$/i
const C_NUM_RE = /^\s*[【\[（(]?\s*([A-Za-z]{1,3})[\s\-_]?(\d{1,4})\s*[】\]）)]?\s*[：:.\-–—]?\s+(.{6,})$/
const NUM_RE = /^\s*(?:#{1,6}\s*)?[-*•·]?\s*[【\[（(]?\s*(\d{1,3})\s*[、.。)）\]】]\s*(.+)$/

export function parseFreeText(text, knownAssets) {
  const lines = String(text || '').split(/\r?\n/)
  const scenes = []
  let current = null
  let pending = null
  let sawShotMarker = false // 出现过"镜头N"这类强标记后，才敢把裸编号行当镜头
  let sawSceneMarker = false

  const ensureScene = (title) => {
    current = { title: title || `场次${scenes.length + 1}`, shots: [] }
    scenes.push(current)
    return current
  }
  const flush = () => {
    if (pending && current) current.shots.push(pending)
    pending = null
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) {
      flush()
      continue
    }
    if (isDecorLine(line)) continue

    // 小节标题（"━━━ 台词时间轴 ━━━" 之类）不携带镜头信息
    if (isSectionLabel(line)) {
      flush()
      continue
    }

    let m = line.match(SCENE_RE)
    if (m) {
      sawSceneMarker = true
      flush()
      const idx = cn2num(m[1])
      const rest = (m[2] || '').trim()
      ensureScene(rest || (Number.isFinite(idx) ? `场次${idx}` : `场次${scenes.length + 1}`))
      if (rest && rest.length > 20) {
        pending = emptyShot()
        pending.description = rest
      }
      continue
    }

    // INT./EXT. 是独立的场景头，每次出现都开新场次
    m = line.match(INT_EXT_RE)
    if (m) {
      sawSceneMarker = true
      flush()
      ensureScene(line.trim())
      continue
    }

    m = line.match(SHOT_STRONG_RE)
    if (m) {
      sawShotMarker = true
      flush()
      if (!current) ensureScene()
      pending = emptyShot()
      applyShotHead(pending, m[2])
      continue
    }

    m = line.match(C_NUM_RE)
    if (m && (sawShotMarker || /^(c|sc|sh)/i.test(m[1]))) {
      flush()
      if (!current) ensureScene()
      pending = emptyShot()
      applyShotHead(pending, m[3])
      continue
    }

    m = line.match(NUM_RE)
    if (m && sawShotMarker) {
      flush()
      if (!current) ensureScene()
      pending = emptyShot()
      applyShotHead(pending, m[2])
      continue
    }

    // 结构化字段：描述：xxx / 时长：5s / 角色：布布、一二
    const fm = line.match(/^([^：:]{1,12})[：:]\s*(.*)$/)
    if (fm) {
      const field = matchSemanticKey(fm[1])
      const val = fm[2].trim()
      if (field && val) {
        if (!current) ensureScene()
        if (!pending) pending = emptyShot()
        if (LIST_FIELDS.has(field)) pending[field] = splitNames(val)
        else if (field === 'dialogue') pending.dialogue = parseDialogue(val)
        else if (field === 'duration' || field === 'timecode') {
          const d = parseDuration(val)
          if (d > 0) pending.duration = d
        } else if (field !== 'sceneTitle') pending[field] = val
        continue
      }
      if (field && !val) continue // 「角色与绑定：」这类小节标题
    }

    // 普通行
    if (pending) {
      pending.description = pending.description ? `${pending.description} ${line}` : line
    } else {
      if (!current) ensureScene()
      pending = emptyShot()
      pending.description = line
    }
  }
  flush()

  // 通篇没有任何场次/镜头标记：整段按空行切块更贴合原意，
  // 否则每个换行都会变成一个镜头，把一段描写切碎
  if (!sawShotMarker && !sawSceneMarker) return parseByParagraph(String(text || ''), knownAssets)

  return groupIntoScenes(
    scenes.flatMap((s) => s.shots.map((shot) => ({ ...shot, _sceneTitle: s.title }))),
    knownAssets
  )
}

function applyShotHead(shot, rest) {
  const text = String(rest || '').trim()
  const dm = text.match(/(.*?)\s*(?:时长|duration)[：:\s]*(\d+(?:\.\d+)?)\s*(?:秒|s)?\s*$/i) || text.match(/(.*?)\s*(\d+(?:\.\d+)?)\s*s(?:ec)?\s*$/i)
  if (dm) {
    shot.description = dm[1].trim()
    const d = parseDuration(dm[2])
    if (d > 0) shot.duration = d
  } else {
    shot.description = text
  }
  if (shot.description.includes('：')) absorbInlineFields(shot, shot.description)
}

/** 兜底：完全没有结构标记时按空行切块。独立成块且短的一行当场次标题，后续块归到它名下 */
function parseByParagraph(text, knownAssets) {
  const blocks = text
    .split(/\n\s*\n+/)
    .map((b) => b.trim())
    .filter((b) => b && !isSectionLabel(b))
  const shots = []
  let pendingTitle = ''

  for (const block of blocks) {
    const lines = block.split(/\n/).map((l) => l.trim()).filter((l) => l && !isSectionLabel(l))
    if (!lines.length) continue
    const first = lines[0]
    const isShortTitle = first.length <= 24 && !/[。！？!?]$/.test(first)

    // 整块就一行且很短 → 是标题，留给后面的块用
    if (lines.length === 1 && isShortTitle) {
      pendingTitle = first.replace(/[：:]$/, '')
      continue
    }
    const shot = emptyShot()
    if (isShortTitle && lines.length > 1) {
      shot._sceneTitle = first.replace(/[：:]$/, '')
      shot.description = lines.slice(1).join(' ')
    } else {
      shot._sceneTitle = pendingTitle
      shot.description = lines.join(' ')
    }
    shots.push(shot)
  }

  if (!shots.length) {
    const one = emptyShot()
    one.description = text.trim()
    shots.push(one)
  }
  return groupIntoScenes(shots, knownAssets)
}

function isSectionLabel(line) {
  const t = String(line || '').trim()
  if (!t) return false
  if (/^#{1,6}\s/.test(t) && !/第\s*\d+\s*场|镜头\s*\d+|场次\s*\d+|scene\s*\d+|shot\s*\d+/i.test(t)) return true
  if (new RegExp(`^[${DECOR_CHARS}].*[${DECOR_CHARS}]$`).test(t)) {
    const inner = t.replace(new RegExp(`[${DECOR_CHARS}]`, 'g'), '')
    if (!/(镜头|画面|特写|中景|近景|全景|时长|分镜)/.test(inner)) return true
  }
  if (
    /(台词时间轴|音效层|角色与绑定|人物与|分镜表|分镜脚本|情绪曲线|配音|字幕提示|备注|说明|场景与|道具与|资产清单)/.test(t) &&
    !/(镜头|画面描述|视频画面|特写|中景|近景|全景)/.test(t)
  )
    return true
  if (/^《.*》/.test(t)) return true
  return false
}

/* ============================ 组装与后处理 ============================ */

function emptyShot() {
  return {
    shotType: '',
    startTime: 0,
    endTime: 0,
    duration: 0,
    description: '',
    integratedMultimodalDescription: '',
    finalFrame: '',
    actionNote: '',
    cameraMovement: '',
    // 机位朝向（六选一）：与 schema 的 shots.camera_angle 对应，服务端落库读 cameraAngle
    cameraAngle: '',
    soundEffects: '',
    overallSoundscape: '',
    nonDiegeticMusic: '',
    dialogue: null,
    characters: [],
    sceneAssets: [],
    propAssets: [],
  }
}

/** 把带 _sceneTitle 的扁平镜头列表按场次分组 */
function groupIntoScenes(shots, knownAssets = {}) {
  const scenes = []
  const byTitle = new Map()
  for (const shot of shots) {
    const title = String(shot._sceneTitle || '').trim()
    let scene = byTitle.get(title)
    if (!scene) {
      scene = { title: title || `场次${scenes.length + 1}`, shots: [] }
      byTitle.set(title, scene)
      scenes.push(scene)
    }
    scene.shots.push(shot)
    delete shot._sceneTitle
  }
  return postProcess(scenes, knownAssets)
}

/** 时间轴、默认值、资产对齐、统计 */
function postProcess(scenes, knownAssets) {
  const warnings = []
  const unknown = { characters: new Set(), scenes: new Set(), props: new Set() }
  const charNames = (knownAssets.characters || []).map((c) => (isStr(c) ? c : c?.name || '')).filter(Boolean)
  const sceneNames = (knownAssets.scenes || []).map((s) => (isStr(s) ? s : s?.title || s?.name || '')).filter(Boolean)
  const propNames = (knownAssets.props || []).map((p) => (isStr(p) ? p : p?.name || '')).filter(Boolean)

  let cursor = 0
  let shotIndex = 0
  const coverage = {}

  for (const scene of scenes) {
    for (const shot of scene.shots) {
      shotIndex++
      // 时长：用户写了就用用户的，不裁剪。没写才兜底 5 秒
      let d = Number(shot.duration)
      if (!Number.isFinite(d) || d <= 0) d = 5
      if (d > 120) {
        warnings.push(`第 ${shotIndex} 镜时长 ${d}s 异常（可能是总时长误填），已按 5s 处理`)
        d = 5
      }
      shot.duration = Math.round(d * 10) / 10
      shot.startTime = Math.round(cursor * 10) / 10
      shot.endTime = Math.round((cursor + shot.duration) * 10) / 10
      cursor += shot.duration

      // 描述里的 @资产名 补进资产数组
      const tagged = extractTagged(shot.description)
      for (const t of tagged) {
        if (charNames.includes(t)) push(shot.characters, t)
        else if (propNames.includes(t)) push(shot.propAssets, t)
        else if (sceneNames.includes(t)) push(shot.sceneAssets, t)
      }

      // 没打 @ 但描述里直呼其名的：按资产库名字补进资产数组。
      // 用户手写的分镜经常不带 @ 标记，但名字和资产库对得上——不补的话页面上角色/道具列全空
      const prose = `${shot.description} ${shot.actionNote}`
      if (!shot.characters.length) {
        for (const n of charNames) if (n.length >= 2 && prose.includes(n)) push(shot.characters, n)
      }
      if (!shot.propAssets.length) {
        for (const n of propNames) if (n.length >= 2 && prose.includes(n)) push(shot.propAssets, n)
      }
      if (!shot.sceneAssets.length) {
        for (const n of sceneNames) if (n.length >= 2 && prose.includes(n)) push(shot.sceneAssets, n)
      }

      // 资产名对齐：只做"高置信"改名，避免「海」被改成「海边」这种误伤
      shot.characters = alignNames(shot.characters, charNames, unknown.characters)
      shot.sceneAssets = alignNames(shot.sceneAssets, sceneNames, unknown.scenes)
      shot.propAssets = alignNames(shot.propAssets, propNames, unknown.props)

      // 音效串里混进来的「角色名(语气)：台词」切到 dialogue
      splitDialogueFromSound(shot, charNames)
      // 挂在对白字段但没有角色名、没有对白结构的：多半是塞在对白列里的音效描述，归回音效
      if (shot.dialogue && !shot.dialogue.character && !/[：:]/.test(shot.dialogue.text || '')) {
        shot.soundEffects = [shot.soundEffects, shot.dialogue.text].filter(Boolean).join('、')
        shot.dialogue = null
      }

      // 没有场景列时，用场次标题兜底当场景名；但自动生成的「场次N」不是真标题，塞进去只会污染未匹配列表
      if (!shot.sceneAssets.length && scene.title && !/^场次\d+$/.test(scene.title)) {
        shot.sceneAssets = alignNames([scene.title], sceneNames, unknown.scenes)
      }

      for (const [k, v] of Object.entries(shot)) {
        const has = Array.isArray(v) ? v.length > 0 : v != null && (!isStr(v) || v.trim())
        if (has) coverage[k] = (coverage[k] || 0) + 1
      }
    }
  }

  return {
    scenes,
    unknownAssets: {
      characters: [...unknown.characters],
      scenes: [...unknown.scenes],
      props: [...unknown.props],
    },
    coverage,
    totalDuration: Math.round(cursor * 10) / 10,
    warnings,
  }
}

const push = (arr, v) => {
  if (v && !arr.includes(v)) arr.push(v)
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 「音效/对白」这类混合列的拆分：用户文件常把音效和对白塞在同一列，
 * 合并换行后形如 "海风轻吹、滑板轮轻响一二：布布——等等我！"。按资产库角色名把对白切出来。
 * 混合串可能落在音效字段（表头按音效识别）也可能落在对白字段（表头带"对白"时），两头都处理。
 */
function splitDialogueFromSound(shot, charNames) {
  if (!charNames.length) return
  const fromDialogue = !!shot.dialogue && !shot.dialogue.character && !!shot.dialogue.text
  const mixed = fromDialogue ? shot.dialogue.text : shot.soundEffects
  if (!mixed) return
  for (const n of charNames) {
    const re = new RegExp(`${escapeRe(n)}\\s*(?:[（(]([^）)]{1,10})[）)])?\\s*[：:]\\s*(.+)$`, 's')
    const m = mixed.match(re)
    if (!m) continue
    const soundPart = mixed.slice(0, m.index).replace(/[，,、\s]+$/, '').trim()
    shot.dialogue = { character: n, tone: (m[1] || '').trim(), text: m[2].trim(), startTime: 0 }
    if (soundPart) {
      shot.soundEffects = shot.soundEffects && !fromDialogue
        ? `${shot.soundEffects}、${soundPart}`.replace(/^、/, '')
        : soundPart
    } else if (fromDialogue) {
      shot.soundEffects = shot.soundEffects || ''
    }
    return
  }
}

/* ============================ 短镜头合并 ============================ */

const round1 = (n) => Math.round(n * 10) / 10

const joinField = (a, b, sep) => {
  const x = String(a || '').trim()
  const y = String(b || '').trim()
  return x && y ? x + sep + y : x || y
}

/** 合并两个相邻镜头：描述/说明/运镜拼接，资产取并集，台词逐条保留，时间区间取并集 */
function combineShots(a, b) {
  const dialogues = [a.dialogue, b.dialogue].filter(Boolean)
  const merged = {
    ...a,
    description: joinField(a.description, b.description, '；'),
    actionNote: joinField(a.actionNote, b.actionNote, '；'),
    cameraMovement: joinField(a.cameraMovement, b.cameraMovement, '→'),
    // 机位与景别同为枚举：不同则用 → 串联（同 shotType 口径），确保合并后不丢机位
    cameraAngle: a.cameraAngle === b.cameraAngle ? (a.cameraAngle || '') : joinField(a.cameraAngle, b.cameraAngle, '→'),
    shotType: a.shotType === b.shotType ? a.shotType || '' : joinField(a.shotType, b.shotType, '→'),
    soundEffects: joinField(a.soundEffects, b.soundEffects, '、'),
    overallSoundscape: a.overallSoundscape || b.overallSoundscape || '',
    nonDiegeticMusic: joinField(a.nonDiegeticMusic, b.nonDiegeticMusic, '、'),
    integratedMultimodalDescription: joinField(a.integratedMultimodalDescription, b.integratedMultimodalDescription, '\n\n'),
    // 合并段的最终画面 = 末镜的最终画面（它是这一段时间轴终点的画面状态）
    finalFrame: b.finalFrame || a.finalFrame || '',
    characters: [...new Set([...(a.characters || []), ...(b.characters || [])])],
    sceneAssets: [...new Set([...(a.sceneAssets || []), ...(b.sceneAssets || [])])],
    propAssets: [...new Set([...(a.propAssets || []), ...(b.propAssets || [])])],
    duration: round1((Number(a.duration) || 0) + (Number(b.duration) || 0)),
  }
  if (!dialogues.length) {
    merged.dialogue = null
  } else if (dialogues.length === 1) {
    merged.dialogue = dialogues[0]
  } else {
    // 多句台词：模型单 dialogue 对象装不下，character 记所有说话人，text 逐行保留原句
    const chars = [...new Set(dialogues.map((d) => d.character).filter(Boolean))]
    merged.dialogue = {
      character: chars.join('、'),
      tone: dialogues.map((d) => d.tone).filter(Boolean)[0] || '',
      text: dialogues
        .map((d) => `${d.character ? `${d.character}${d.tone ? `（${d.tone}）` : ''}：` : ''}${d.text}`)
        .join('\n'),
      startTime: Number(dialogues[0].startTime) || 0,
    }
  }
  merged.startTime = round1(Number(a.startTime) || 0)
  merged.endTime = round1(merged.startTime + merged.duration)
  return merged
}

/**
 * 相邻短镜头合并：时长 < minDuration 的镜头相邻抱团，攒到 ≥ minDuration 落袋（上限 maxDuration）。
 * 前一镜已经达标时不往里塞，保住剪辑结构；只在同一场次内合并。
 * 用途：剪辑级细切单（每镜 1-3s）导入后适配平台"逐镜出片"的粒度。
 *
 * 不变量：pending 存在时其时长必定 < minDuration（一攒够就立刻落袋）。
 * 因此退出循环时若仍有 pending，说明这一组碎镜始终没攒够，必须挂到邻接镜头上——
 * 否则会产出「开了合并却仍是 2 秒」的镜头，正是这个功能要消灭的东西。
 */
export function mergeShortShots(scenes, { minDuration = 3, maxDuration = 15 } = {}) {
  const out = []
  for (const scene of scenes || []) {
    const merged = []
    let pending = null // 连续短镜头攒着，够 minDuration 就落袋

    // 达标落袋：独立成镜，保住原剪辑结构
    const flushPending = () => {
      if (pending) {
        merged.push(pending)
        pending = null
      }
    }

    // 未达标碎镜挂到邻接镜头上：优先回并上一镜，让当前长镜保持完整；
    // 没有上一镜可回并时才向前并入（此时可能略超 maxDuration，取舍是——
    // 一个 2 秒的碎镜远比一个 12 秒的长镜难出片）
    const dissolvePending = () => {
      if (!pending) return
      const last = merged[merged.length - 1]
      if (last) merged[merged.length - 1] = combineShots(last, pending)
      else merged.push(pending)
      pending = null
    }

    for (const shot of scene.shots || []) {
      const d = Number(shot.duration) || 0

      if (d >= minDuration) {
        if (!pending) {
          merged.push({ ...shot })
        } else if (d + pending.duration <= maxDuration || !merged.length) {
          // 向前并入当前长镜：不超上限；或没有上一镜可回并，只能向前
          merged.push(combineShots(pending, { ...shot }))
          pending = null
        } else {
          // 回并上一镜，当前长镜保持完整
          dissolvePending()
          merged.push({ ...shot })
        }
        continue
      }

      // 短镜头：优先续在 pending 上攒；没有 pending 且上一镜自身还偏短时并入上一镜；否则新开一组
      if (pending && pending.duration + d > maxDuration) dissolvePending()
      const last = merged[merged.length - 1]
      if (pending) {
        pending = combineShots(pending, shot)
        if (pending.duration >= minDuration) flushPending()
      } else if (last && last.duration < minDuration) {
        merged[merged.length - 1] = combineShots(last, shot)
      } else {
        pending = { ...shot }
      }
    }

    // 收尾：没攒够的碎镜并入上一镜；整场只有这一个碎镜时无处可并，原样保留
    dissolvePending()
    out.push({ ...scene, shots: merged })
  }
  return out
}

/**
 * 按段合并：每场次内相邻镜头尽量合并为一个镜头，但单镜时长不超过 maxDuration（默认 15 秒）。
 * 适用于用户已经写好分镜脚本、希望每个场次就是一个完整镜头的场景。
 * 描述用分号拼接、景别用箭头连接、台词合并、时长累加、起止时间重算。
 * 若场次只有 1 镜，原样返回不改动。
 *
 * 贪心策略：依次扫描同场次镜头，往当前组里塞，塞不下就落袋另起一组。
 * 举例：场次 5 镜 [3,4,5,4,4]，maxDuration=15 → [3+4+5=12, 4+4=8] = 2 镜
 *       场次 3 镜 [3,4,3]，maxDuration=15  → [3+4+3=10] = 1 镜
 */
export function mergeShotsByScene(scenes, { maxDuration = 15 } = {}) {
  if (!scenes || !scenes.length) return []
  return scenes.map(scene => {
    const shots = scene.shots || []
    if (shots.length <= 1) return { ...scene, shots: [...shots] }
    const groups = []
    let current = null
    for (const shot of shots) {
      const d = Number(shot.duration) || 0
      if (!current) {
        current = { ...shot }
        continue
      }
      // 如果加入这镜后不超限，合并到当前组
      if (current.duration + d <= maxDuration) {
        current = combineShots(current, shot)
      } else {
        // 当前组满了，落袋；这镜作为新组的开头
        groups.push(current)
        current = { ...shot }
      }
    }
    if (current) groups.push(current)
    // 重算时间轴
    let t = 0
    for (const g of groups) {
      g.startTime = round1(t)
      g.endTime = round1(t + g.duration)
      t = g.endTime
    }
    return { ...scene, shots: groups }
  })
}

/**
 * 资产名对齐。只在"几乎就是同一个名字"时才改：
 * 完全相同、忽略标点后相同、或一方是另一方加了个修饰词（长度差 ≤ 2 且前缀相同）。
 * 匹配不上的保留用户原名，登记到 unknown 让上层决定要不要建。
 */
function alignNames(names, known, unknownSet) {
  const out = []
  for (const raw of names || []) {
    const n = String(raw || '').trim()
    if (!n) continue
    const hit = findCloseName(n, known)
    const finalName = hit || n
    if (!hit && known.length) unknownSet.add(n)
    if (!out.includes(finalName)) out.push(finalName)
  }
  return out
}

function findCloseName(name, known) {
  if (!known || !known.length) return null
  const norm = (s) => String(s).replace(/[\s，。！？、,.!?@]/g, '').toLowerCase()
  const n = norm(name)
  if (!n) return null
  for (const k of known) if (norm(k) === n) return k
  // 子串匹配要求长度接近，避免短名被塞进长名
  let best = null
  let bestDiff = Infinity
  for (const k of known) {
    const kn = norm(k)
    if (kn === n) continue
    if ((kn.includes(n) || n.includes(kn)) && Math.abs(kn.length - n.length) <= 2) {
      const diff = Math.abs(kn.length - n.length)
      if (diff < bestDiff) {
        bestDiff = diff
        best = k
      }
    }
  }
  if (best) return best
  // 编辑距离兜底（4 字以内、相似度 ≥ 0.7）
  for (const k of known) {
    const kn = norm(k)
    if (Math.abs(kn.length - n.length) <= 2 && similarity(kn, n) >= 0.7) return k
  }
  return null
}

function similarity(a, b) {
  if (a === b) return 1
  const la = a.length
  const lb = b.length
  const dp = Array.from({ length: la + 1 }, (_, i) => [i, ...Array(lb).fill(0)])
  for (let j = 0; j <= lb; j++) dp[0][j] = j
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
    }
  }
  return 1 - dp[la][lb] / Math.max(la, lb)
}

export function extractTagged(text, marker = '@') {
  if (!text) return []
  const re = new RegExp(`${marker}([^${marker}\\s，。！？、,.;；:：]+)`, 'g')
  const out = []
  let m
  while ((m = re.exec(text))) out.push(m[1].trim())
  return [...new Set(out)]
}

export function splitNames(raw) {
  if (!raw) return []
  if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter(Boolean)
  const s = String(raw).trim()
  if (!s) return []
  // 只在出现明确分隔符时才拆，否则整串当一个名字——否则 "Mickey Mouse" 会被拆成两个人
  if (/[,，、\/|；;]/.test(s)) return s.split(/[,，、\/|；;]+/).map((x) => x.trim()).filter(Boolean)
  return [s]
}

export function parseDialogue(raw) {
  if (!raw) return null
  if (Array.isArray(raw)) {
    const first = raw.find((d) => d && (d.text || isStr(d)))
    if (!first) return null
    const d = parseDialogue(first)
    if (d) d._extra = raw.length - 1
    return d
  }
  if (typeof raw === 'object') {
    return {
      character: String(raw.character || raw.role || raw.speaker || '').trim(),
      tone: String(raw.tone || raw.emotion || '').trim(),
      text: String(raw.text || raw.line || raw.content || '').trim(),
      startTime: Number(raw.startTime ?? raw.start_time ?? 0) || 0,
    }
  }
  const text = String(raw).trim()
  if (!text) return null
  const m = text.match(/^([^：:]{1,10})[：:]\s*(.+)$/)
  if (m) return { character: m[1].trim(), tone: '', text: m[2].trim(), startTime: 0 }
  return { character: '', tone: '', text, startTime: 0 }
}

/**
 * 时长解析。支持：5 / 5s / 5秒 / 00:00-00:06 / 0:00~0:06 / 1分30秒 / 3-8s
 */
export function parseDuration(raw) {
  if (raw == null) return 0
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0
  const val = String(raw).trim()
  if (!val) return 0
  const tc = val.match(/(\d+)\s*[:：]\s*(\d+)(?:\s*[:：]\s*(\d+))?\s*[-–—~至]\s*(\d+)\s*[:：]\s*(\d+)/)
  if (tc) {
    const s1 = Number(tc[1]) * 3600 + Number(tc[2]) * 60 + Number(tc[3] || 0)
    const s2 = Number(tc[1]) * 3600 + Number(tc[4]) * 60 + Number(tc[5])
    return s2 > s1 ? s2 - s1 : 0
  }
  const range = val.match(/(\d+)\s*[:：]\s*(\d+)\s*[-–—~至]\s*(\d+)\s*[:：]\s*(\d+)/)
  if (range) {
    const s1 = Number(range[1]) * 60 + Number(range[2])
    const s2 = Number(range[3]) * 60 + Number(range[4])
    return s2 > s1 ? s2 - s1 : 0
  }
  const secRange = val.match(/(\d+(?:\.\d+)?)\s*[-–—~至]\s*(\d+(?:\.\d+)?)\s*[秒s]?/)
  if (secRange) {
    const s1 = Number(secRange[1])
    const s2 = Number(secRange[2])
    if (s2 > s1) return s2 - s1
  }
  const ms = val.match(/(\d+)\s*分\s*(\d+(?:\.\d+)?)\s*秒?/)
  if (ms) return Number(ms[1]) * 60 + Number(ms[2])
  const n = Number(val.replace(/[^\d.]/g, ''))
  return Number.isFinite(n) ? n : 0
}

/* ============================ 统一入口 ============================ */

/**
 * @param {string} text 文件/粘贴的原文
 * @param {{knownAssets?: {characters?:Array, scenes?:Array, props?:Array}}} options
 * @returns {{
 *   format: 'json'|'table'|'text'|'empty',
 *   scenes: Array<{title:string, shots:Array}>,
 *   table?: {rows: string[][], hasHeader: boolean, mapping: Object, confidence: Object, header: string[]},
 *   stats: {sceneCount:number, shotCount:number, totalDuration:number, coverage:Object},
 *   unknownAssets: {characters:string[], scenes:string[], props:string[]},
 *   warnings: string[]
 * }}
 */
export function parseStoryboard(text, options = {}) {
  const knownAssets = options.knownAssets || {}
  const src = String(text || '').trim()

  if (!src) {
    return {
      format: 'empty',
      scenes: [],
      stats: { sceneCount: 0, shotCount: 0, totalDuration: 0, coverage: {} },
      unknownAssets: { characters: [], scenes: [], props: [] },
      warnings: ['内容为空'],
    }
  }

  const jsonLike = /^```(?:json|jsonc)?\s*/i.test(src) || src.startsWith('{') || src.startsWith('[')

  // 1) JSON：结构最规整，优先
  const jsonResult = parseJson(src, knownAssets)
  if (jsonResult && jsonResult.scenes?.length) {
    return pack('json', jsonResult.scenes, {
      structure: jsonResult.structure,
      unknownAssets: jsonResult.unknownAssets,
      warnings: jsonResult.warnings,
      coverage: jsonResult.coverage,
    })
  }

  // 2) 表格：Excel 导出、Markdown 表格、CSV、字符画表格。
  //    长得像 JSON 就别再当 CSV 拆了——JSON 里的逗号会把字段切烂
  const tableExtract = jsonLike ? null : extractRows(src)
  if (tableExtract && tableExtract.rows.length >= 2) {
    const rows = tableExtract.rows
    const tableResult = packTable(rows, looksLikeHeader(rows[0], rows.slice(1)), knownAssets, pack, tableExtract.sections)
    if (tableResult) return tableResult
    // 表格认出来了但列没匹配上：降级为文本再试，不把用户卡死
  }

  // 3) 自由文本兜底
  const textResult = parseFreeText(src, knownAssets)
  return pack('text', textResult?.scenes || [], {
    unknownAssets: textResult?.unknownAssets,
    warnings: textResult?.warnings,
    coverage: textResult?.coverage,
  })

  function pack(format, scenes, extra = {}) {
    const shotCount = scenes.reduce((n, s) => n + s.shots.length, 0)
    const totalDuration = scenes.reduce((n, s) => n + s.shots.reduce((m, x) => m + (x.duration || 0), 0), 0)
    const coverage = extra.coverage || {}
    return {
      format,
      scenes,
      stats: { sceneCount: scenes.length, shotCount, totalDuration: Math.round(totalDuration * 10) / 10, coverage },
      unknownAssets: extra.unknownAssets || { characters: [], scenes: [], props: [] },
      warnings: extra.warnings || [],
      ...(extra.structure ? { structure: extra.structure } : {}),
      ...(extra.table ? { table: extra.table } : {}),
    }
  }
}

/**
 * Excel / Word 表格已经拿到二维数组时走这里，跳过文本层的分隔符探测。
 * pack 由调用方注入（parseStoryboard 内部的闭包），单独导出时用自己的简版。
 */
function packTable(rows, hasHeader, knownAssets, packFn, sections = []) {
  const { mapping, confidence, header } = inferMapping(rows, { hasHeader })
  const built = buildShotsFromRows(rows, mapping, { hasHeader, knownAssets, sections })
  if (!built.scenes?.length) return null
  const pack = packFn || ((f, scenes, extra = {}) => ({
    format: f,
    scenes,
    stats: {
      sceneCount: scenes.length,
      shotCount: scenes.reduce((n, s) => n + s.shots.length, 0),
      totalDuration: Math.round(scenes.reduce((n, s) => n + s.shots.reduce((m, x) => m + (x.duration || 0), 0), 0) * 10) / 10,
      coverage: extra.coverage || {},
    },
    unknownAssets: extra.unknownAssets || { characters: [], scenes: [], props: [] },
    warnings: extra.warnings || [],
  }))
  return {
    ...pack('table', built.scenes, {
      unknownAssets: built.unknownAssets,
      warnings: built.warnings,
      coverage: built.coverage,
    }),
    table: {
      rows,
      hasHeader,
      mapping,
      confidence,
      header: hasHeader ? header : header.map((_, i) => `第 ${i + 1} 列`),
      rawHeader: hasHeader ? header : [],
      sections,
    },
    unknownAssets: built.unknownAssets,
    warnings: built.warnings,
  }
}

/** 已经是二维数组（Excel/Word 表格）时的入口 */
export function parseStoryboardRows(rows, options = {}) {
  if (!Array.isArray(rows) || rows.length < 1) {
    return { format: 'empty', scenes: [], stats: { sceneCount: 0, shotCount: 0, totalDuration: 0, coverage: {} }, unknownAssets: { characters: [], scenes: [], props: [] }, warnings: ['表格为空'] }
  }
  const hasHeader = options.hasHeader ?? looksLikeHeader(rows[0], rows.slice(1))
  return (
    packTable(rows, hasHeader, options.knownAssets || {}, null) || {
      format: 'empty',
      scenes: [],
      stats: { sceneCount: 0, shotCount: 0, totalDuration: 0, coverage: {} },
      unknownAssets: { characters: [], scenes: [], props: [] },
      warnings: ['这张表里没读出镜头'],
    }
  )
}

/** UI 改了列映射后重建（只重跑构建，不重新探测格式） */
export function rebuildFromTable(rows, mapping, options = {}) {
  const { hasHeader, knownAssets, sections } = options
  const built = buildShotsFromRows(rows, mapping, { hasHeader, knownAssets, sections })
  return {
    scenes: built.scenes,
    stats: {
      sceneCount: built.scenes.length,
      shotCount: built.scenes.reduce((n, s) => n + s.shots.length, 0),
      totalDuration: built.totalDuration,
      coverage: built.coverage,
    },
    unknownAssets: built.unknownAssets,
    warnings: built.warnings,
  }
}
