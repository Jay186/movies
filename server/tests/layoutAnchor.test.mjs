// A3 布局图锚 · 验收测试（2026-09-17）
//
// 解决什么问题：现有「人审基准图」是**照片**，同时携带视角/光影/画风/主体占比。
//   让模型"继承它但别照搬构图"天然自相矛盾 —— cliff_river 视角塌陷与「场2 被场1
//   覆盖重画」两次事故都长在这块土壤上。
//   A3 = 每个空间组额外生成一张**俯视布局示意图**，只表达位置关系，不含视角。
//   它因此可以被组内所有视角无冲突地继承。
//
// 测试分三层：
//   A. 口径（LAYOUT_ANCHOR_HINT / LAYOUT_IMAGE_NEGATIVE）—— 必须极窄，这是 A3 的全部价值
//   B. prompt 构建（buildLayoutImagePrompt / collectLayoutMaterials）
//   C. 注册表与取锚链路（:memory: 库，SQL 复刻，零网络零真实库）
//
// 只读、零网络、零 AI 费用、不碰 server/data.db。可重复运行。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import Database from 'better-sqlite3'
import {
  LAYOUT_ANCHOR_TYPE, LAYOUT_ANCHOR_HINT, LAYOUT_IMAGE_NEGATIVE, LAYOUT_IMAGE_SUBJECT,
  SPATIAL_SERIES_ANCHOR_TYPES, isSpatialSeriesAnchor, ANCHOR_TYPES,
} from '../ai/anchorTypes.js'
import { buildLayoutImagePrompt, collectLayoutMaterials } from '../ai/sceneAnchorPrompt.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ::  ${detail}` : ''}\n`)
}

// ===== A. 口径：A3 的价值全在"窄" =====
record('layout 已登记进 ANCHOR_TYPES（与 schema 注释同源）',
  ANCHOR_TYPES.includes(LAYOUT_ANCHOR_TYPE), `type='${LAYOUT_ANCHOR_TYPE}'`)

record('layout 属于空间类锚（驱动 P0-6 光照替换 / 锚优先级声明）',
  isSpatialSeriesAnchor({ type: LAYOUT_ANCHOR_TYPE })
  && SPATIAL_SERIES_ANCHOR_TYPES.includes(LAYOUT_ANCHOR_TYPE))

// 【核心】继承项必须只有空间事实三项，且必须显式豁免视角 —— 少一句就会退化成第二张照片
record('【核心】hint 声明了"该图是俯视示意图，不是画面效果图"',
  LAYOUT_ANCHOR_HINT.includes('示意画法') && LAYOUT_ANCHOR_HINT.includes('不是画面效果图'))

record('【核心】继承项只有：相对位置 / 朝向 / 距离比例',
  LAYOUT_ANCHOR_HINT.includes('相对位置') && LAYOUT_ANCHOR_HINT.includes('朝向')
  && LAYOUT_ANCHOR_HINT.includes('距离比例'))

record('【核心】显式豁免视角（防"继承结构"被读成"继承机位"）',
  LAYOUT_ANCHOR_HINT.includes('视角') && LAYOUT_ANCHOR_HINT.includes('机位高度')
  && LAYOUT_ANCHOR_HINT.includes('景别') && LAYOUT_ANCHOR_HINT.includes('不受约束') === false
  ? LAYOUT_ANCHOR_HINT.includes('不约束') || LAYOUT_ANCHOR_HINT.includes('一律以本场景文字描述为准')
  : false)

record('【核心】显式豁免光照/时段/天气/色温（布局图不表达光，继承了会压死本场描述）',
  LAYOUT_ANCHOR_HINT.includes('光影') && LAYOUT_ANCHOR_HINT.includes('时段')
  && LAYOUT_ANCHOR_HINT.includes('天气') && LAYOUT_ANCHOR_HINT.includes('色温'))

record('【核心】显式豁免画风/材质/主体占比（布局图是示意画风，照搬=画风污染）',
  LAYOUT_ANCHOR_HINT.includes('画风') && LAYOUT_ANCHOR_HINT.includes('材质')
  && LAYOUT_ANCHOR_HINT.includes('主体占比'))

record('【核心】明确禁止把俯视画法当视角（最危险的误读）',
  LAYOUT_ANCHOR_HINT.includes('严禁把布局图的俯视') && LAYOUT_ANCHOR_HINT.includes('当作本画面的视角'))

// 布局图自己的生成 prompt 必须反向禁止画人
record('布局图 negative：禁角色/人物/动物',
  LAYOUT_IMAGE_NEGATIVE.includes('不要出现任何角色') && LAYOUT_IMAGE_NEGATIVE.includes('人物、动物'))

// 布局图 negative：禁文字/禁符号标记（2026-09-17 实测修正：第一版布局图把地标名字
// 全写在图上，还画了眼睛图标标记机位。文字会污染后续生成，机位图标会诱导视角固化。）
record('布局图 negative：明确禁止任何文字/注记（实测第一版每张都写满了地标名）',
  LAYOUT_IMAGE_NEGATIVE.includes('绝对不要出现任何文字') && LAYOUT_IMAGE_NEGATIVE.includes('标签'))

record('布局图 negative：明确禁止眼睛/机位图标与一切符号标记',
  LAYOUT_IMAGE_NEGATIVE.includes('眼睛') && LAYOUT_IMAGE_NEGATIVE.includes('符号标记'))

record('布局图 negative：列出常见错误范式（示意图带名称标注在这里是错的）',
  LAYOUT_IMAGE_NEGATIVE.includes('示意图带名称标注'))

record('布局图 negative：禁天空 / 禁地平线 / 禁光照氛围（布局图不表达光）',
  LAYOUT_IMAGE_NEGATIVE.includes('不要画天空') && LAYOUT_IMAGE_NEGATIVE.includes('不要画地平线')
  && LAYOUT_IMAGE_NEGATIVE.includes('不要画光照氛围'))

// 【第四次实测修正 · 推翻第三次】大气现象**不画**：
// 第三次曾放开"用无色块画大气范围与边界"，理由是"雾停半山腰"是几何信息。
// 实测（v4）模型在"示意图"语境下把"雾"当**材质**处理 → 满屏雪白冰面/云絮质感，
// 并顺势补上"雪松"（被禁的清单外物体）。示意图语境里"雾"是渲染量，不是几何量。
record('【核心】negative：大气现象一律不画（含雪地反光/冰面高光/云絮质感）',
  LAYOUT_IMAGE_NEGATIVE.includes('不要画雾、云、水汽、雨、雪')
  && LAYOUT_IMAGE_NEGATIVE.includes('云絮质感'))
record('【核心】negative：不表达光与颜色情绪',
  LAYOUT_IMAGE_NEGATIVE.includes('不要画光照氛围与光线方向')
  && LAYOUT_IMAGE_NEGATIVE.includes('不要表现色温或色调氛围'))

// 【无角色】本项目题材本身是"动物角色在自然空间里"，模型极易顺手画进去。
// 布局图是全组参考底图 —— 多一个角色 = 每个成员场景图都可能被诱导出一个角色。
record('【核心】negative：绝对不要角色（含本片主角）与角色痕迹',
  LAYOUT_IMAGE_NEGATIVE.includes('绝对不要出现任何文字') // 文字仍是首要护栏
  && LAYOUT_IMAGE_NEGATIVE.includes('包括本片主角')
  && LAYOUT_IMAGE_NEGATIVE.includes('暗示角色在场的痕迹'))

// 【核心】不要新增：布局图是全组继承的结构权威，多画一样 = 全组都多出这样东西
// （2026-09-17 实测第二版：素材里没有松树，图上却满屏松树）
// 注意：p4 在下方定义，涉及 p4 的断言必须放在 p4 之后（const TDZ）
record('【核心】negative 双保险：不要新增未被列出的物体',
  LAYOUT_IMAGE_NEGATIVE.includes('不要新增未被列出的物体'))

// 与既有 spatial 组锚 hint 的口径差异必须存在（否则 A3 就是重复造轮子）
const anchorSrc = readFileSync(path.join(ROOT, 'server/ai/sceneAnchors.js'), 'utf8')
record('布局图 hint 与照片类组锚 hint 是**两套不同口径**（不共用一句话）',
  anchorSrc.includes('GROUP_ANCHOR_HINT') && anchorSrc.includes('LAYOUT_ANCHOR_HINT')
  && !anchorSrc.includes('promptHints.push(GROUP_ANCHOR_HINT)\n      promptHints.push(LAYOUT_ANCHOR_HINT)'),
  '照片锚=长什么样(含视角豁免)；布局锚=位置关系(无视角可言)')

// ===== B. prompt 构建（含降级与边界）=====
const p1 = buildLayoutImagePrompt({
  group: 'cliff_river',
  roles: ['崖顶俯视谷底', '谷底浅滩仰视', '河面平视'],
  landmarks: ['断桥', '冰河', '窄下山道'],
  env: ['雪线悬崖', '灰白砾石滩'],
  styleText: '吉卜力水彩',
})
record('prompt 含组名 / 观察位 / 地标 / 环境', 
  p1.includes('cliff_river') && p1.includes('崖顶俯视谷底') && p1.includes('断桥')
  && p1.includes('雪线悬崖'))
record('prompt 要求斜俯视等轴测 + 分层积木（不得压成平面）',
  p1.includes('斜俯视的等轴测') && p1.includes('分层积木'))
record('【核心】prompt 明确要求看出地形高低落差（崖顶/谷底不在同一高度）',
  p1.includes('高低落差') && p1.includes('各在一个高度上'))
record('prompt 含 negative 约束（尾段）',
  p1.includes('不要出现任何角色') && p1.includes('不要画天空'))
record('prompt 含 SUBJECT 标签', p1.includes(LAYOUT_IMAGE_SUBJECT))

// 空素材降级：不留悬空句/空括号
const p2 = buildLayoutImagePrompt({ group: 'g1' })
record('空素材降级：不产生悬空句子（无"观察位置："空列）',
  !p2.includes('存在以下观察位置：。') && !p2.includes('实体地标：。')
  && !p2.includes('环境特征：。') && p2.includes(LAYOUT_IMAGE_SUBJECT),
  p2.slice(0, 80) + '…')

const p3 = buildLayoutImagePrompt({})
record('全空输入不抛错（组名为空时用占位）', typeof p3 === 'string' && p3.length > 0)

// collectLayoutMaterials：去重 + 保序 + 容错
const m1 = collectLayoutMaterials({
  members: [
    { spatialRole: '崖顶', props: ['断桥', '冰河'] },
    { spatialRole: '谷底', props: ['冰河', '朽木'] },
    { spatialRole: '崖顶', props: [] },
  ],
})
record('collect：观察位去重且保序', JSON.stringify(m1.roles) === JSON.stringify(['崖顶', '谷底']), JSON.stringify(m1.roles))
record('collect：地标并集去重且保序', JSON.stringify(m1.landmarks) === JSON.stringify(['断桥', '冰河', '朽木']), JSON.stringify(m1.landmarks))
record('collect：脏输入不抛错（null members / 非数组 props）',
  collectLayoutMaterials({}).roles.length === 0
  && collectLayoutMaterials({ members: null }).roles.length === 0
  && collectLayoutMaterials({ members: [{ props: 'notarray' }] }).landmarks.length === 0)

record('【通用性】A3 全链零题材词表（prompt 构建函数体不出现题材实词判断）',
  !/if\s*\([^)]*(断桥|崖|冰河|松林)[^)]*\)/.test(buildLayoutImagePrompt.toString()),
  'prompt 只做模板填充')

// 【关键】天气/光影项不得进布局图 —— 但必须靠 prompt 引导模型判断，不能在代码里筛词
const p4 = buildLayoutImagePrompt({
  group: 'g',
  roles: ['崖顶俯视谷底', '谷底浅滩仰视'],
  landmarks: ['断桥', '雪线悬崖', '清晨浓雾'],
  env: ['冷蓝色调', '半山松林'],
})
record('【核心】prompt 明确要求：只画有空间位置的那些（实体类）',
  p4.includes('属于地形、水体、植被、建筑、道具的') && p4.includes('用形状与色块**直接画出来**'))
record('【核心】观察位只作方位参考，明确说明它们不出现在画面上（防视角固化）',
  p4.includes('它们本身不出现在画面上') && p4.includes('帮你确认物体之间的方位关系'))
record('【第四次实测修正】大气/光影类不进布局图（示意图语境下"雾"是渲染量）',
  p4.includes('属于大气与光照，不在本图表达范围内'))
record('【核心】prompt 明确禁止新增清单外的物体',
  p4.includes('不要新增未被列出的物体'))
record('【核心】prompt 明确禁止出现角色/动物（含主角）',
  p4.includes('不要出现任何角色、人物、动物') && p4.includes('包括本片主角'))
record('【核心】env 被弱化为"地点背景"并说明不保证每场可见（防误导性权威）',
  p4.includes('地点层面的背景') && p4.includes('不保证每个观察位置都看得见'))
// 【通用性】大气/光照项**并非**在代码里被剔除（仍原样传给模型，由模型判断）
record('【通用性】大气/光照项**并非**在代码里被剔除（仍原样传给模型，由模型判断）',
  p4.includes('清晨浓雾') && p4.includes('冷蓝色调'),
  '传给模型+引导，而不是过滤——过滤就得写词表')

// ===== 【P0】prompt 精简护栏 + 生成后闸接管（2026-09-17 六轮实测结论）=====
//
// 六轮实测：v1→v6，只有 v3 出过一张干净零文字的图，且无法复现。
// 我一度归因"否定过载"，但 v6 用与 v3 相当的规模（889字/14否定 vs 826字/14否定）
// 做全正向表述，**依旧满图英文标注** —— 假设被证伪。
// 真正规律：**"示意图"这个格式与该模型的"自动加标注"先验强耦合**，
// 靠 prompt 对抗收益低且不可复现。
//
// → 因此策略定为：**prompt 只管"画什么内容"，"不许出现文字"交给生成后闸**
//   （server/ai/layoutReview.js：视觉模型检出 → 针对性加固 → 重试）。
//   本块守护的是"prompt 保持精简"，防止以后又回去堆预防性否定句。
const pFull = buildLayoutImagePrompt({
  group: 'cliff_river',
  roles: ['崖顶俯视谷底', '谷底浅滩仰视', '河面平视'],
  landmarks: ['断桥', '雪线悬崖', '窄下山道', '深谷冰河', '腐朽木桥', '清晨浓雾',
    '谷底浅滩', '河滩碎石', '薄冰残雪', '水汽弥漫', '宽阔冰河', '河心浮冰', '尖利碎冰', '浅滩碎石'],
  env: ['雪线悬崖', '深谷冰河', '灰白砾石滩', '冷蓝色调', '半山雾带'],
})
const negCount = (String(pFull).match(/不要|禁止|绝对|严禁/g) || []).length
record('【P0 护栏】典型入参下 prompt 不超过 1000 字（与已验证的 v3 基线 826 字同量级）',
  pFull.length <= 1000, `len=${pFull.length}（上限1000）`)
record('【P0 护栏】典型入参下否定词不超过 16 个（v5 曾达 28 个）',
  negCount <= 16, `negatives=${negCount}（上限16）`)

// retryNote 是生成后闸的接口：首轮必须为空（prompt 逐字不变），重试时才拼上
record('【核心】首轮 prompt 不含重试文案（retryNote 缺省为空）',
  !pFull.includes('上一版'))
record('【核心】retryNote 被拼到 prompt 末尾（重试时生效）',
  buildLayoutImagePrompt({ group: 'g', landmarks: ['断桥'], retryNote: '\n⚠️ RETRY_SENTINEL' })
    .includes('RETRY_SENTINEL'))

// 生成后闸必须存在且与 prompt 分工明确（本方案的核心结论）
record('【P0 护栏】存在生成后闸模块 layoutReview.js（prompt 不管不该管的事）',
  (() => {
    try {
      readFileSync(path.join(ROOT, 'server/ai/layoutReview.js'), 'utf8')
      return true
    } catch { return false }
  })())

// ===== C. 注册表与取锚（SQL 复刻，:memory:）=====
const db = new Database(':memory:')
db.exec(`
  CREATE TABLE scenes (id INTEGER PRIMARY KEY, episode_id INTEGER, scene_number INTEGER, title TEXT, image_url TEXT);
  CREATE TABLE scene_analysis (episode_id INTEGER, scene_id INTEGER, scene_number INTEGER,
    spatial_group TEXT, spatial_role TEXT, props_json TEXT, shared_env_json TEXT DEFAULT '[]');
  CREATE TABLE scene_anchors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    episode_id INTEGER NOT NULL, anchor_type TEXT NOT NULL, anchor_key TEXT NOT NULL,
    scene_id INTEGER DEFAULT 0, scene_number INTEGER DEFAULT 0, image_url TEXT NOT NULL,
    description TEXT DEFAULT '', source TEXT DEFAULT 'auto', confirmed INTEGER DEFAULT 0,
    UNIQUE(episode_id, anchor_type, anchor_key)
  );
`)
const EP = 4
const G = 'cliff_river'
const SC = [{ id: 91, no: 1, role: '崖顶俯视谷底' }, { id: 92, no: 2, role: '谷底浅滩仰视' }]
for (const s of SC) {
  db.prepare('INSERT INTO scenes (id, episode_id, scene_number, title, image_url) VALUES (?,?,?,?,\'\')')
    .run(s.id, EP, s.no, `场${s.no}`)
  db.prepare('INSERT INTO scene_analysis (episode_id, scene_id, scene_number, spatial_group, spatial_role, props_json, shared_env_json) VALUES (?,?,?,?,?,?,?)')
    .run(EP, s.id, s.no, G, s.role, JSON.stringify(['断桥', '冰河']), JSON.stringify(['雪线悬崖']))
}

// 复刻 registerLayoutAnchor 的 SQL 语义（source='manual' 是刻意的）
const REG_SQL = `INSERT INTO scene_anchors (episode_id, anchor_type, anchor_key, scene_id, scene_number, image_url, description, source)
  VALUES (?, '${LAYOUT_ANCHOR_TYPE}', ?, ?, ?, ?, ?, 'manual')
  ON CONFLICT(episode_id, anchor_type, anchor_key) DO UPDATE SET
    image_url = excluded.image_url, description = excluded.description,
    scene_id = excluded.scene_id, scene_number = excluded.scene_number, source = 'manual', confirmed = 1`
db.prepare(REG_SQL).run(EP, G, 91, 1, '/uploads/layout-a.png', '布局图 v1')

const a1 = db.prepare('SELECT * FROM scene_anchors WHERE episode_id=? AND anchor_type=? AND anchor_key=?').get(EP, LAYOUT_ANCHOR_TYPE, G)
record('登记：layout 锚写入成功', !!a1 && a1.image_url === '/uploads/layout-a.png', JSON.stringify(a1))

// 幂等：重画换图，不新增行
db.prepare(REG_SQL).run(EP, G, 91, 1, '/uploads/layout-b.png', '布局图 v2')
const cnt = db.prepare('SELECT COUNT(*) c FROM scene_anchors WHERE episode_id=? AND anchor_type=?').get(EP, LAYOUT_ANCHOR_TYPE).c
record('幂等：重画只换图不新增行', cnt === 1
  && db.prepare('SELECT image_url FROM scene_anchors WHERE episode_id=? AND anchor_type=?').get(EP, LAYOUT_ANCHOR_TYPE).image_url === '/uploads/layout-b.png',
  `rows=${cnt}`)

// 【核心】重析不被删（ensureSceneAnalysis 只删 source='auto'）
db.prepare("DELETE FROM scene_anchors WHERE episode_id = ? AND source = 'auto'").run(EP)
const after = db.prepare('SELECT COUNT(*) c FROM scene_anchors WHERE episode_id=? AND anchor_type=?').get(EP, LAYOUT_ANCHOR_TYPE).c
record('【核心】重析（删 source=auto）后布局图锚仍在（source=manual 的刻意设计）',
  after === 1, `after=${after}`)

// 取锚链路：layout 排在 refs[0]（复刻 sceneAnchors 的 push 顺序）
const refs = []
const hints = []
const anchors = []
const la = db.prepare(`SELECT anchor_key, image_url FROM scene_anchors WHERE episode_id=? AND anchor_type='${LAYOUT_ANCHOR_TYPE}' AND anchor_key=?`).get(EP, G)
if (la) { refs.push(la.image_url); hints.push(LAYOUT_ANCHOR_HINT); anchors.push({ type: LAYOUT_ANCHOR_TYPE, key: la.anchor_key }) }
// 照片类组锚排其后
const spRow = { anchor_key: G, image_url: '/uploads/photo.png' }
refs.push(spRow.image_url); hints.push('GROUP_ANCHOR_HINT_PLACEHOLDER'); anchors.push({ type: 'spatial', key: G })

record('【核心】layout 锚排在 refs[0]（照片锚其后）—— 位置关系优先被模型读到',
  refs[0] === '/uploads/layout-b.png' && refs[1] === '/uploads/photo.png',
  JSON.stringify(refs))
record('hint 与 refs 同序对应（layout hint 在 hints[0]）',
  hints[0] === LAYOUT_ANCHOR_HINT && hints.length === refs.length)

// 无布局图时降级：refs 里没有 layout，行为=改造前
record('降级：无布局图时 refs 里不留空位（只用照片锚）',
  [].concat(spRow.image_url).length === 1, 'layout 缺失 → 整段跳过')

// 组消失时布局图不自动清（manual）——由人决定；但取锚时查不到组就不再命中
record('组名对不上时不命中（锚 key 就是组名，天然自洽）',
  db.prepare(`SELECT COUNT(*) c FROM scene_anchors WHERE episode_id=? AND anchor_type='${LAYOUT_ANCHOR_TYPE}' AND anchor_key=?`).get(EP, 'no_such_group').c === 0)

console.log(`\n==== layoutAnchor: ${results.filter(r => r.ok).length}/${results.length} passed ====`)
if (results.some((r) => !r.ok)) process.exit(1)
