#!/usr/bin/env node
// 把 xiaomo-film-studio Skill 的规则同步进工程快照（本脚本所在目录 = 快照目录）。
//
// 用法：
//   node server/ai/rules/sync-from-skill.mjs                  同步（有变化则写入并升版本号）
//   node server/ai/rules/sync-from-skill.mjs --dry-run        只看差异，不写入
//   node server/ai/rules/sync-from-skill.mjs --version 1.2.0  指定新版本号
//
// 源目录可用 SKILL_SOURCE_PATH 覆盖（默认 ~/.workbuddy/skills/xiaomo-film-studio/references）。
// 同步后请 git commit，让规则变更可追溯、可回滚。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const RULE_FILES = ['asset-rules.md', 'storyboard-rules.md', 'visual-quality.md']

// 快照目录固定为 rules/<skill 名>/，与脚本同级的子目录；skill 名可用 SKILL_SNAPSHOT_NAME 覆盖
const SKILL_NAME = process.env.SKILL_SNAPSHOT_NAME || 'xiaomo-film-studio'
const targetDir = path.join(path.dirname(fileURLToPath(import.meta.url)), SKILL_NAME)

if (!fs.existsSync(targetDir)) {
  console.error(`[sync] 快照目录不存在：${targetDir}`)
  process.exit(1)
}
const sourceDir = process.env.SKILL_SOURCE_PATH
  || path.join(os.homedir(), '.workbuddy', 'skills', 'xiaomo-film-studio', 'references')

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const verArg = (() => {
  const i = argv.indexOf('--version')
  return i >= 0 ? argv[i + 1] : ''
})()

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

function bumpPatch(v) {
  const parts = String(v || '0.0.0').split('.')
  while (parts.length < 3) parts.push('0')
  const n = parts.map((x) => Number(x) || 0)
  n[2] += 1
  return n.join('.')
}

if (!fs.existsSync(sourceDir)) {
  console.error(`[sync] 源目录不存在：${sourceDir}`)
  console.error('       未安装 Skill 时，用 SKILL_SOURCE_PATH 指定规则目录。')
  process.exit(1)
}

const manifestPath = path.join(targetDir, 'manifest.json')
const oldManifest = fs.existsSync(manifestPath)
  ? JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
  : null

const changed = []
const files = {}
for (const f of RULE_FILES) {
  const src = path.join(sourceDir, f)
  if (!fs.existsSync(src)) {
    console.error(`[sync] 源目录缺少文件：${src}`)
    process.exit(1)
  }
  const buf = fs.readFileSync(src)
  const hash = sha256(buf)
  files[f] = { sha256: hash, bytes: buf.length }
  const oldHash = oldManifest?.files?.[f]?.sha256
  if (oldHash !== hash) changed.push({ file: f, old: oldHash || '(无记录)', now: hash, buf })
}

if (!changed.length) {
  console.log(`[sync] 已是最新，无需同步（version ${oldManifest?.version || '(无)'}）`)
  process.exit(0)
}

console.log(`[sync] 检测到 ${changed.length} 份规则有变化：`)
for (const c of changed) {
  console.log(`       - ${c.file}  ${String(c.old).slice(0, 12)}… → ${c.now.slice(0, 12)}…`)
}

if (dryRun) {
  console.log('[sync] --dry-run：未写入任何文件')
  process.exit(0)
}

for (const c of changed) {
  fs.writeFileSync(path.join(targetDir, c.file), c.buf)
}

const newVersion = verArg || bumpPatch(oldManifest?.version || '0.0.0')
// 快照必须部署自包含：只记 skill 名与版本，不把本机源路径写进仓库文件（否则换机即失效、且泄露用户名）。
const manifest = {
  version: newVersion,
  skillName: SKILL_NAME,
  syncedAt: new Date().toISOString(),
  files,
  notes: '工程内规则快照，由 sync-from-skill.mjs 生成，不记录本机源路径',
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8')

console.log(`[sync] 已写入快照：${targetDir}`)
console.log(`[sync] 源目录（仅打印，不落盘）：${sourceDir}`)
console.log(`[sync] version ${oldManifest?.version || '(无)'} → ${newVersion}`)
console.log('[sync] 请 git commit 本次变更，保证规则可追溯、可回滚。')
