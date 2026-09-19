
import { hasDialogue } from './dialogue.js'

const COMBAT_WORDS = [
  '打斗', '缠斗', '扭打', '对打', '交手', '出手', '还手',
  '扑向', '猛扑', '扑倒', '扑咬', '咬', '撕', '抡', '挥拳', '出拳', '真拳', '拳',
  '攻击', '反击', '击中', '击倒', '击退', '闪避', '格挡', '挣脱', '锁喉',
  '压制', '碾压', '追击', '滑铲', '猛冲', '撞向', '撞上',
  '掀翻', '卷翻', '砸进', '硬碰硬',
  '狂暴', '暴走', '狂化', '变身', '暴涨', '巨兽', '庞然',
]

const PHYSICS_WORDS = [
  '打', '冲', '卷', '撞', '砸', '甩', '甩飞', '掀', '拍', '碎', '裂', '崩', '轰', '爆', '坠', '摔',
  '怒吼', '咆哮', '冲击', '飞溅', '翻滚', '逼近',
]

const ENV_WORDS = [
  '浮冰', '碎冰', '冰坡', '冰层', '冰裂', '冰屑', '冰河', '冰湖',
  '雪崩', '雪浪', '雪雾', '雪堆', '雪块', '雪沫', '雪粒',
  '湍流', '水流', '浪花', '水花', '顺流', '漂流', '漂来', '漂向',
  '断桥', '迷雾', '浓雾', '雾气',
  '下沉', '沉没', '滑落', '滑向', '滑去', '滑下', '打滑', '打横', '打转',
  '惊起', '惊恐', '吓得', '爬起', '趴', '摔倒', '摇晃', '踉跄', '失衡', '瘫', '骑',
]

const SLICE_WORDS = [
  '说', '道', '聊', '笑', '望', '坐', '走', '看', '对视', '点头', '招手', '夕阳', '黄昏',
  '沉默', '安静', '静', '回忆', '低声', '轻声', '聊天', '讲故事', '安慰', '拥抱', '牵手',
  '凝视', '眺望', '并肩', '探出', '探头', '晒太阳', '发呆', '呆住', '茫然', '愣',
]

function scoreShotCombat(shot = {}) {
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

  const hasDlg = hasDialogue(shot.dialogue)
  score += hasDlg ? -1 : 1

  return { score, hitCombat, hitPhysics, hitEnv, hitSlice, hasDlg }
}

export function classifyShotCombat(shot = {}) {
  return scoreShotCombat(shot).score >= 3
}

export function explainShotCombat(shot = {}) {
  const { score, hitCombat, hitPhysics, hitEnv, hitSlice, hasDlg } = scoreShotCombat(shot)
  return { score, isCombat: score >= 3, hitCombat, hitPhysics, hitEnv, hitSlice, hasDlg }
}
