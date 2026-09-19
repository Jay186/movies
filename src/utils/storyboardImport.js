

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
      const enumLike = ratio(vals, (v) => v.length <= 6)
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
    probe: (vals) => ratio(vals, (v) => v.length <= 12 && matchInList(v, CAMERA_WORDS)),
  },
  {
    key: 'cameraAngle',
    label: '机位朝向',
    aliases: [
      '机位朝向', '机位角度', '机位', '拍摄角度', '取景角度', '朝向',
      'camera angle', 'cameraangle', 'angle',
    ],
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
    probe: () => 0, 
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

const SHOT_FIELD_OF = {
  camera: 'cameraMovement',
  integrated: 'integratedMultimodalDescription',
  props: 'propAssets',
}
const shotFieldOf = (field) => SHOT_FIELD_OF[field] || field

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
const CAMERA_ANGLE_WORDS = [
  '正面', '侧面', '背面', '过肩', '俯拍', '仰拍', '正拍', '背拍', '平视', '45度', '三分四',
  'front', 'side', 'back', 'over the shoulder', 'over-the-shoulder', 'high angle', 'low angle', 'three-quarter',
]


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

export function normKey(k) {
  return String(k ?? '')
    .toLowerCase()
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s_\-·.。、]/g, '')
}

export function matchSemanticKey(rawKey) {
  const k = normKey(rawKey)
  if (!k) return null
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


const DECOR_CHARS = '\\s\\-=_─━═╌╍┈┉┌┐└┘├┤┬┴┼╔╗╚╝╠╣╦╩╬╭╮╰╯·'
const isDecorLine = (line) => new RegExp(`^[${DECOR_CHARS}]*$`).test(String(line || ''))

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
    }
  }
  return 'text'
}


function detectDelimiter(lines) {
  const sample = lines.slice(0, 30).filter((l) => l.trim())
  if (sample.length < 2) return null
  const candidates = ['|', '\t', '；', ';', ',', '，']
  let best = null
  for (const d of candidates) {
    const counts = sample.map((l) => splitDelimited(l, d).length)
    const withD = counts.filter((c) => c > 1).length
    if (withD / sample.length < 0.7) continue
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

  const freq = new Map()
  rawRows.forEach((r) => freq.set(r.length, (freq.get(r.length) || 0) + 1))
  const [modal, modalN] = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]
  if (modal < 2 || modalN / rawRows.length < 0.7) return null

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

function splitBoxRow(line) {
  return line
    .slice(1, -1)
    .split('|')
    .map((s) => s.trim())
}

function findSectionTitle(lines, tableStart) {
  const re = /^(?:[-*•·]\s*)?(段|场次|第.{1,3}场|scene)\s*[一二三四五六七八九十\d]/i
  let looked = 0
  for (let j = tableStart - 1; j >= 0 && looked < 6; j--) {
    const t = lines[j]
    if (!t || isDecorLine(t)) continue
    looked++
    if (re.test(t)) return t
    if (/^[^：:]{1,14}[：:]/.test(t)) continue 
    break 
  }
  return ''
}

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

function looksLikeHeader(row, dataRows) {
  const cells = (row || []).map((c) => String(c || '').trim())
  if (!cells.some(Boolean)) return false
  const nonEmpty = cells.filter(Boolean)
  if (nonEmpty.some((c) => /[。！？!?；;]$/.test(c))) return false
  if (nonEmpty.every((c) => c.length <= 12)) {
    if (dataRows.length) {
      const dataAvg = avgLen(dataRows.flat().filter(Boolean))
      const headAvg = avgLen(nonEmpty)
      if (dataAvg > headAvg * 1.2) return true
    }
    return nonEmpty.every((c) => c.length <= 8)
  }
  return false
}

export function inferMapping(rows, { hasHeader }) {
  const header = hasHeader ? rows[0].map((c) => String(c || '').trim()) : []
  const body = hasHeader ? rows.slice(1) : rows
  const colCount = Math.max(...rows.map((r) => r.length))
  const columns = []
  for (let i = 0; i < colCount; i++) columns.push(body.map((r) => String(r[i] ?? '')).filter((v) => v.trim()))

  const mapping = {}
  const confidence = {}
  const taken = new Set()

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

export function buildShotsFromRows(rows, mapping, { hasHeader, knownAssets, sections } = {}) {
  const body = hasHeader ? rows.slice(1) : rows
  const sectionAt = new Map((sections || []).map((s) => [s.index, s.title]))
  const canMergeWrapped = ['shotNo', 'duration', 'timecode'].some((k) => mapping[k] !== undefined)
  const cellOf = (row, key) => {
    const i = mapping[key]
    return i === undefined || i === null || i < 0 ? '' : String(row[i] ?? '').trim()
  }

  const merged = []
  const sectionOfMerged = []
  for (let bi = 0; bi < body.length; bi++) {
    const row = body[bi]
    const rowsIdx = bi + (hasHeader ? 1 : 0)

    const nonEmptyCols = row.map((c, i) => (String(c ?? '').trim() ? i : -1)).filter((i) => i >= 0)
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

    if (!description && !shotNo && sceneTitle) {
      pendingSceneTitle = sceneTitle
      return
    }
    const nonEmpty = row.map((c) => String(c ?? '').trim()).filter(Boolean)
    if (!shotNo && !durationRaw && nonEmpty.length === 1 && description.length <= 20) {
      pendingSceneTitle = sceneTitle || description
      return
    }
    if (!description && !shotNo && !durationRaw) return

    const shot = emptyShot()
    if (description) shot.description = description
    for (const key of [
      'duration', 'timecode', 'shotType', 'camera', 'cameraAngle', 'actionNote', 'soundEffects',
      'overallSoundscape', 'nonDiegeticMusic', 'dialogue', 'integrated', 'finalFrame',
      'characters', 'sceneAssets', 'props',
    ]) {
      const v = cell(key)
      if (v) applyField(shot, key, v)
    }

    const used = new Set(Object.values(mapping))
    row.forEach((c, i) => {
      if (used.has(i)) return
      const t = String(c ?? '').trim()
      if (t && t.includes('：')) absorbInlineFields(shot, t)
    })

    shot._sceneTitle = sceneTitle || pendingSceneTitle
    if (!shot.description) {
      shot.description = [shot.actionNote, shot.dialogue?.text].filter(Boolean).join(' ') || ''
    }
    shots.push(shot)
  })

  return groupIntoScenes(shots, knownAssets)
}


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

function repairJson(src) {
  let out = String(src).replace(/,\s*([}\]])/g, '$1')
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

export function parseJson(text, knownAssets) {
  const unwrapped = String(text).trim().replace(/^```(?:json|jsonc)?\s*/i, '').replace(/```\s*$/, '')
  let data
  try {
    data = JSON.parse(unwrapped)
  } catch {
    try {
      data = JSON.parse(repairJson(unwrapped))
    } catch {
      return null
    }
  }

  const arrays = []
  collectObjectArrays(data, '', arrays)
  if (!arrays.length) return null

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

function objectToShot(obj) {
  const shot = emptyShot()
  const unknown = []
  let startAt = NaN
  let endAt = NaN
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || v === '') continue
    const nk = normKey(k)
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
  if (shot.description && shot.description.includes('：')) absorbInlineFields(shot, shot.description)
  return shot
}


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

const SCENE_RE = /^\s*(?:#{1,6}\s*)?[-*•·]?\s*[【\[（(]?\s*(?:场次|场景|第|scene|sc)\s*[：:.]?\s*([0-9]+|[一二三四五六七八九十]+)\s*[】\]）)]?\s*(?:场|scene)?\s*[：:.\-–—]?\s*(.*)$/i
const INT_EXT_RE = /^\s*(?:#{1,6}\s*)?(INT\.?|EXT\.?|INT\/EXT\.?|内景|外景|室内|室外)\s*[.。]?\s*[-－—]?\s*(.*)$/i

const SHOT_STRONG_RE = /^\s*(?:#{1,6}\s*)?[-*•·]?\s*[【\[（(]?\s*(?:镜头|镜位|镜|shot|scene\s*shot)\s*[：:.]?\s*([0-9]+|[一二三四五六七八九十]+)\s*[】\]）)]?\s*[：:.\-–—]?\s*(.*)$/i
const C_NUM_RE = /^\s*[【\[（(]?\s*([A-Za-z]{1,3})[\s\-_]?(\d{1,4})\s*[】\]）)]?\s*[：:.\-–—]?\s+(.{6,})$/
const NUM_RE = /^\s*(?:#{1,6}\s*)?[-*•·]?\s*[【\[（(]?\s*(\d{1,3})\s*[、.。)）\]】]\s*(.+)$/

export function parseFreeText(text, knownAssets) {
  const lines = String(text || '').split(/\r?\n/)
  const scenes = []
  let current = null
  let pending = null
  let sawShotMarker = false 
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
      if (field && !val) continue 
    }

    if (pending) {
      pending.description = pending.description ? `${pending.description} ${line}` : line
    } else {
      if (!current) ensureScene()
      pending = emptyShot()
      pending.description = line
    }
  }
  flush()

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

      const tagged = extractTagged(shot.description)
      for (const t of tagged) {
        if (charNames.includes(t)) push(shot.characters, t)
        else if (propNames.includes(t)) push(shot.propAssets, t)
        else if (sceneNames.includes(t)) push(shot.sceneAssets, t)
      }

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

      shot.characters = alignNames(shot.characters, charNames, unknown.characters)
      shot.sceneAssets = alignNames(shot.sceneAssets, sceneNames, unknown.scenes)
      shot.propAssets = alignNames(shot.propAssets, propNames, unknown.props)

      splitDialogueFromSound(shot, charNames)
      if (shot.dialogue && !shot.dialogue.character && !/[：:]/.test(shot.dialogue.text || '')) {
        shot.soundEffects = [shot.soundEffects, shot.dialogue.text].filter(Boolean).join('、')
        shot.dialogue = null
      }

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


const round1 = (n) => Math.round(n * 10) / 10

const joinField = (a, b, sep) => {
  const x = String(a || '').trim()
  const y = String(b || '').trim()
  return x && y ? x + sep + y : x || y
}

function combineShots(a, b) {
  const dialogues = [a.dialogue, b.dialogue].filter(Boolean)
  const merged = {
    ...a,
    description: joinField(a.description, b.description, '；'),
    actionNote: joinField(a.actionNote, b.actionNote, '；'),
    cameraMovement: joinField(a.cameraMovement, b.cameraMovement, '→'),
    cameraAngle: a.cameraAngle === b.cameraAngle ? (a.cameraAngle || '') : joinField(a.cameraAngle, b.cameraAngle, '→'),
    shotType: a.shotType === b.shotType ? a.shotType || '' : joinField(a.shotType, b.shotType, '→'),
    soundEffects: joinField(a.soundEffects, b.soundEffects, '、'),
    overallSoundscape: a.overallSoundscape || b.overallSoundscape || '',
    nonDiegeticMusic: joinField(a.nonDiegeticMusic, b.nonDiegeticMusic, '、'),
    integratedMultimodalDescription: joinField(a.integratedMultimodalDescription, b.integratedMultimodalDescription, '\n\n'),
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

export function mergeShortShots(scenes, { minDuration = 3, maxDuration = 15 } = {}) {
  const out = []
  for (const scene of scenes || []) {
    const merged = []
    let pending = null 

    const flushPending = () => {
      if (pending) {
        merged.push(pending)
        pending = null
      }
    }

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
          merged.push(combineShots(pending, { ...shot }))
          pending = null
        } else {
          dissolvePending()
          merged.push({ ...shot })
        }
        continue
      }

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

    dissolvePending()
    out.push({ ...scene, shots: merged })
  }
  return out
}

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
      if (current.duration + d <= maxDuration) {
        current = combineShots(current, shot)
      } else {
        groups.push(current)
        current = { ...shot }
      }
    }
    if (current) groups.push(current)
    let t = 0
    for (const g of groups) {
      g.startTime = round1(t)
      g.endTime = round1(t + g.duration)
      t = g.endTime
    }
    return { ...scene, shots: groups }
  })
}

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

  const jsonResult = parseJson(src, knownAssets)
  if (jsonResult && jsonResult.scenes?.length) {
    return pack('json', jsonResult.scenes, {
      structure: jsonResult.structure,
      unknownAssets: jsonResult.unknownAssets,
      warnings: jsonResult.warnings,
      coverage: jsonResult.coverage,
    })
  }

  const tableExtract = jsonLike ? null : extractRows(src)
  if (tableExtract && tableExtract.rows.length >= 2) {
    const rows = tableExtract.rows
    const tableResult = packTable(rows, looksLikeHeader(rows[0], rows.slice(1)), knownAssets, pack, tableExtract.sections)
    if (tableResult) return tableResult
  }

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
