import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from '../config.js'

// Skill 规则加载器（xiaomo-film-studio = 分镜/资产生成的规则唯一事实源）
// 设计原则：
//   - 快照制：工程内 server/ai/rules/<skill>/ 存已验证的规则快照 + manifest.json（版本 + sha256）。
//     部署自包含——服务器不装 Skill 也能跑；规则不再随外部 Skill 目录隐式漂移。
//   - 缺失即硬失败 / 指纹不符即硬失败：宁可启动或生成时报错，不静默退回旧规则
//     （静默退回 = 规则双源打架，跨集风格不一致且无法追溯）。
//   - 进程内缓存：规则文件启动后不变，读一次常驻。
//   - 本地试新版：SKILL_RULES_PATH 指向 Skill 安装目录（该目录无 manifest）时自动跳过指纹校验。

const REF_FILES = Object.freeze({
  storyboard: 'storyboard-rules.md',   // 模块B 分镜导演全量细则
  visualQuality: 'visual-quality.md',  // 视觉质感总纲（共用）
  asset: 'asset-rules.md',             // 模块A 资产提取全量细则
})

const MANIFEST_FILE = 'manifest.json'

let cache = null

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

// 快照目录带 manifest → 校验指纹；外部覆盖（SKILL_RULES_PATH）无 manifest → 返回 null 跳过校验
function loadManifest(rulesPath) {
  const p = path.join(rulesPath, MANIFEST_FILE)
  if (!fs.existsSync(p)) return null
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch (e) {
    throw new Error(`[skillRules] manifest.json 解析失败：${p} —— ${e.message}`)
  }
}

function readRef(name, fileName, manifest) {
  const filePath = path.join(config.skill.rulesPath, fileName)
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `[skillRules] 找不到 Skill 规则文件：${filePath}\n` +
      '分镜/资产生成依赖 xiaomo-film-studio Skill 规则（唯一事实源），缺失时不会退回旧规则。\n' +
      '修复：确认 server/ai/rules/xiaomo-film-studio/ 快照完整，或用 SKILL_RULES_PATH 指向规则目录。'
    )
  }
  const buf = fs.readFileSync(filePath)
  const expected = manifest?.files?.[fileName]?.sha256
  if (expected) {
    const actual = sha256(buf)
    if (actual !== expected) {
      throw new Error(
        `[skillRules] 规则文件指纹不符：${fileName}\n` +
        `  manifest 记录：${expected}\n  实际文件    ：${actual}\n` +
        '文件被改动但未同步 manifest——请重跑 server/ai/rules/sync-from-skill.mjs，' +
        '或确认这是有意改动后同步更新 manifest。'
      )
    }
  }
  return buf.toString('utf-8')
}

export function loadSkillRules() {
  if (cache) return cache
  const manifest = loadManifest(config.skill.rulesPath)
  const rules = {
    version: manifest?.version || '',
    syncedAt: manifest?.syncedAt || '',
  }
  for (const [key, fileName] of Object.entries(REF_FILES)) {
    rules[key] = readRef(key, fileName, manifest)
  }
  cache = Object.freeze(rules)
  return cache
}

// 供 bootCheck 使用：只校验不抛完整错误（返回问题清单，空数组 = 正常）
export function checkSkillRules() {
  const dir = config.skill.rulesPath
  if (!fs.existsSync(dir)) return [`规则目录不存在：${dir}`]
  let manifest = null
  try {
    manifest = loadManifest(dir)
  } catch (e) {
    return [e.message]
  }
  const problems = []
  for (const fileName of Object.values(REF_FILES)) {
    const filePath = path.join(dir, fileName)
    if (!fs.existsSync(filePath)) {
      problems.push(`缺文件 ${fileName}`)
      continue
    }
    const expected = manifest?.files?.[fileName]?.sha256
    if (expected && sha256(fs.readFileSync(filePath)) !== expected) {
      problems.push(`${fileName} 指纹不符`)
    }
  }
  return problems
}

// 快照版本号（供启动自检与分镜落库追溯用）
export function skillRulesVersion() {
  const m = loadManifest(config.skill.rulesPath)
  return m?.version || ''
}

// 测试或热重载用
export function __clearSkillRulesCache() {
  cache = null
}
