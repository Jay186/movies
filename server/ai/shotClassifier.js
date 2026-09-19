/**
 * 镜头戏型判定（文戏 / 武戏）
 *
 * 用途：决定出片时打斗 LoRA（H3_Combat_V2）的强度——武戏 0.5，文戏 0。
 * 设计原则：**不依赖场次号**。场次号是单集专属的，换剧本、换集、场次顺序一变就失效。
 * 这里只按镜头自身内容判定，任何剧本通用。
 *
 * 优先级由 generate.js 的 resolveIsCombat 控制：
 *   1. shots.is_combat（AI 分镜时标注 或 人工在前端覆盖）  ← 最准
 *   2. classifyShotCombat() 内容打分                        ← 本文件，自动兜底
 *   3. 场次号                                                ← 仅在以上都拿不到时
 *
 * ── 三档词表（2026-09-13 重构，用第1集落库 26 镜 + 第2集剧本实测校准）──
 *
 * 旧版单档 +2 的教训：物理泛词（冲/卷/碎/裂/震）在自然灾难、逃亡、威胁、惊险动作里
 * 同样高频。第1集 26 镜实测 8 个文戏镜被打成 5~13 分假阳性（雪崩镜 13 分、骑熊
 * 逃亡 13 分、被雪浪卷走 13 分）；第2集「零打斗、冲突全来自自然环境」的冰河惊险段
 * 8 镜里 5 镜误判——出片时会错挂 prfight1 触发词 + 武戏 LoRA，画风被带偏。
 *
 * 新版拆三档：
 *   COMBAT_WORDS  +2  主体对主体的攻击/打斗编排、狂暴变身（拳/咬/缠斗/砸进…）
 *   PHYSICS_WORDS +1  物理冲击泛词——打斗有、灾难/惊险/威胁也有（冲/撞/碎/怒吼…）
 *   ENV_WORDS     -1  自然环境惊险与受难信号（浮冰/雪崩/断桥/吓得/摔倒…）
 *   SLICE_WORDS   -1  对话、情绪、静态观望（沿用旧版）
 *   无台词 +1 / 有台词 -1（沿用旧版）；阈值 ≥3 判武戏
 *
 * 验收数据（第1集落库 26 镜 + 第2集剧本场次三~六构造 8 镜）：
 *   - 第2集冰河惊险段 8/8 全部判文戏（旧版误判 5/8）
 *   - 第1集与人工落库一致 20/26（旧版 16/26），13 分级重灾假阳性全部清零
 *   - 真武戏核心镜（重拳命中/滑铲穿裆/雪球撞面/战败跪地）余量 4~6 分不丢
 *   - 残余 4 个卡线假阳性（3~4 分：骑熊跃起/被甩飞/变身前奏/威胁逼近）与上述
 *     真武戏卡线镜词面重叠，词表已到精度边界——靠 level 1（AI 标注 + 人工前端
 *     覆盖）兜住，这正是三级回退的设计意图。
 *
 * 词表维护注意（踩过的坑，别再踩）：
 *   - 「打」放 PHYSICS 不放 COMBAT：打横/打转/打滚不是打人
 *   - 「扑」必须词组化（扑向/猛扑/扑倒）：雪浪「直扑」坡下是拟人
 *   - 「爪/掌/肌肉/跃/震/硬切/雪浪/甩飞/抓」已移除或降档——伸出爪子/抬起前掌/
 *     没有摔倒/震彻山谷/毛发抓握 全不是打斗，单字误伤面过大
 *   - ENV 不收「冰面」：第1集武戏战场就在冰面雪地上，会误伤雪山打斗
 *   - 新增武戏词优先加 COMBAT（主体对主体），拿不准放 PHYSICS
 */

// 台词有无判据单点（2026-09-18 P0-3）：本文件原就地写 `!== 'null' && !== '[]'` 兜底
// dialogue 脏值，属第六处同款补丁，统一从 dialogue.js 走。
import { hasDialogue } from './dialogue.js'

// 核心武戏词（+2）：主体对主体的攻击/打斗编排、狂暴与变身状态
const COMBAT_WORDS = [
  '打斗', '缠斗', '扭打', '对打', '交手', '出手', '还手',
  '扑向', '猛扑', '扑倒', '扑咬', '咬', '撕', '抡', '挥拳', '出拳', '真拳', '拳',
  '攻击', '反击', '击中', '击倒', '击退', '闪避', '格挡', '挣脱', '锁喉',
  '压制', '碾压', '追击', '滑铲', '猛冲', '撞向', '撞上',
  '掀翻', '卷翻', '砸进', '硬碰硬',
  '狂暴', '暴走', '狂化', '变身', '暴涨', '巨兽', '庞然',
]

// 物理泛词（+1）：打斗有、自然灾难/惊险/威胁也有的冲击类词
const PHYSICS_WORDS = [
  '打', '冲', '卷', '撞', '砸', '甩', '甩飞', '掀', '拍', '碎', '裂', '崩', '轰', '爆', '坠', '摔',
  '怒吼', '咆哮', '冲击', '飞溅', '翻滚', '逼近',
]

// 自然环境降权词（-1）：环境惊险、灾难、失控与受难信号
const ENV_WORDS = [
  '浮冰', '碎冰', '冰坡', '冰层', '冰裂', '冰屑', '冰河', '冰湖',
  '雪崩', '雪浪', '雪雾', '雪堆', '雪块', '雪沫', '雪粒',
  '湍流', '水流', '浪花', '水花', '顺流', '漂流', '漂来', '漂向',
  '断桥', '迷雾', '浓雾', '雾气',
  '下沉', '沉没', '滑落', '滑向', '滑去', '滑下', '打滑', '打横', '打转',
  '惊起', '惊恐', '吓得', '爬起', '趴', '摔倒', '摇晃', '踉跄', '失衡', '瘫', '骑',
]

// 文戏信号词（-1）：对话、情绪、静态观望类
const SLICE_WORDS = [
  '说', '道', '聊', '笑', '望', '坐', '走', '看', '对视', '点头', '招手', '夕阳', '黄昏',
  '沉默', '安静', '静', '回忆', '低声', '轻声', '聊天', '讲故事', '安慰', '拥抱', '牵手',
  '凝视', '眺望', '并肩', '探出', '探头', '晒太阳', '发呆', '呆住', '茫然', '愣',
]

function scoreShotCombat(shot = {}) {
  // actionNote/action_note 双读：调用方既有归一化后的分镜对象（camelCase），
  // 也有 shots 表 DB 行（snake_case，如 generate.js resolveIsCombat）——
  // 只读 camelCase 会让 DB 行丢动作说明，武戏信号词（抡拳/猛扑多在 action_note 里）漏判
  const text = [shot.description, shot.actionNote || shot.action_note, shot.soundEffects || shot.sound_effects].filter(Boolean).join(' ')

  let score = 0
  const hitCombat = COMBAT_WORDS.filter((w) => text.includes(w))
  const hitPhysics = PHYSICS_WORDS.filter((w) => text.includes(w))
  const hitEnv = ENV_WORDS.filter((w) => text.includes(w))
  const hitSlice = SLICE_WORDS.filter((w) => text.includes(w))
  score += hitCombat.length * 2
  score += hitPhysics.length
  score -= hitEnv.length
  score -= hitSlice.length

  // 有台词偏文戏（说话镜通常是文戏），无台词的纯动作镜偏武戏。
  // 台词有无判据单点（2026-09-18 P0-3）：此处原就地写 `rawDlg !== 'null' && !== '[]'`
  // ——那是 dialogue 脏值（字符串 "null"）的第六处补丁，漏一个就二度漂移。统一走 dialogue.js。
  const hasDlg = hasDialogue(shot.dialogue)
  score += hasDlg ? -1 : 1

  return { score, hitCombat, hitPhysics, hitEnv, hitSlice, hasDlg }
}

/**
 * 按镜头内容判定是否武戏
 * @param {Object} shot - { description, actionNote, soundEffects, dialogue, ... }
 * @returns {boolean} true=武戏
 */
export function classifyShotCombat(shot = {}) {
  return scoreShotCombat(shot).score >= 3
}

/**
 * 判定并给出依据（排障/日志用）
 */
export function explainShotCombat(shot = {}) {
  const { score, hitCombat, hitPhysics, hitEnv, hitSlice, hasDlg } = scoreShotCombat(shot)
  return { score, isCombat: score >= 3, hitCombat, hitPhysics, hitEnv, hitSlice, hasDlg }
}
