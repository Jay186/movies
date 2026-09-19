import fs from 'fs';
import path from 'path';

const root = process.cwd();
const out = [];

function walk(dir, acc = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name.startsWith('_')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(js|mjs)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

const files = walk(root);
out.push('扫描 JS/MJS 文件数: ' + files.length);
out.push('');

const refCount = new Map();
const importers = new Map();

for (const f of files) {
  let src = '';
  try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
  const re = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue;
    const base = path.resolve(path.dirname(f), spec);
    const cands = [base, base + '.js', base + '.mjs', path.join(base, 'index.js')];
    const seen = new Set();
    for (const c of cands) {
      if (seen.has(c)) continue;
      seen.add(c);
      refCount.set(c, (refCount.get(c) || 0) + 1);
      if (!importers.has(c)) importers.set(c, []);
      importers.get(c).push(path.relative(root, f));
    }
  }
}

out.push('===== [1] 疑似僵尸模块:ai/ 下没有任何 import =====');
let orphan = 0;
for (const f of files) {
  if (!f.startsWith(path.join(root, 'ai'))) continue;
  const n = refCount.get(f) || 0;
  if (n === 0) { out.push('  ' + path.relative(root, f)); orphan++; }
}
out.push('  小计: ' + orphan + ' 个');
out.push('');

out.push('===== [2] 被引用次数最低的 ai/ 模块(<=1 次,含孤儿) =====');
const low = [];
for (const f of files) {
  if (!f.startsWith(path.join(root, 'ai'))) continue;
  const n = refCount.get(f) || 0;
  if (n <= 1) low.push([path.relative(root, f), n, importers.get(f) || []]);
}
low.sort((a, b) => a[1] - b[1]);
for (const [f, n, imp] of low) {
  out.push('  ' + String(n) + '  ' + f + (imp.length ? '   <- ' + imp.join(', ') : ''));
}
out.push('');

out.push('===== [3] 硬编码:绝对路径 / 项目名字面量 =====');
const HARD = [
  { re: /C:\\+Users/i, label: '绝对路径' },
  { re: /C:\/Users/i, label: '绝对路径' },
  { re: /分镜项目/, label: '项目名字面量' },
  { re: /吉卜力/, label: '写死风格' },
  { re: /localhost:\d+/, label: '写死端口' },
  { re: /127\.0\.0\.1/, label: '写死IP' },
  { re: /D:\\+nvm|D:\/nvm/i, label: '绝对路径' },
];
const hardHits = [];
for (const f of files) {
  let src = '';
  try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const h of HARD) {
      h.re.lastIndex = 0;
      if (h.re.test(lines[i])) {
        hardHits.push('  [' + h.label + '] ' + path.relative(root, f) + ':' + (i + 1) + '  ' + lines[i].trim().slice(0, 100));
      }
    }
  }
}
out.push(...hardHits);
out.push('  小计: ' + hardHits.length + ' 处');
out.push('');

out.push('===== [4] 同名导出:同一函数名在多个文件里定义 =====');
const nameMap = new Map();
for (const f of files) {
  let src = '';
  try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
  const re = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g;
  let m;
  const seenN = new Set();
  while ((m = re.exec(src)) !== null) {
    const n = m[1];
    if (seenN.has(n)) continue;
    seenN.add(n);
    if (!nameMap.has(n)) nameMap.set(n, []);
    nameMap.get(n).push(path.relative(root, f));
  }
}
const dup = [...nameMap.entries()].filter(([, v]) => v.length >= 2);
dup.sort((a, b) => b[1].length - a[1].length);
for (const [n, v] of dup.slice(0, 45)) {
  out.push('  ' + n + '  (' + v.length + ' 处)');
  out.push('      ' + v.join('  |  '));
}
out.push('  重复函数名总数: ' + dup.length);
out.push('');

out.push('===== [5] 常量可疑重复:CJK / 字符集 / 正则常量定义处 =====');
const constNames = ['CJK_DIRTY_RE', 'RESIDUAL_CJK_RE', 'CJK_RE', 'stripResidualCjk', 'pickEnglish', 'validateSegmentPrompt', 'resolveAssetName', 'resolveName'];
for (const cn of constNames) {
  const hits = [];
  for (const f of files) {
    let src = '';
    try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (new RegExp('(function|const|let|var)\\s+' + cn + '\\b').test(src)) hits.push(path.relative(root, f));
  }
  out.push('  ' + cn + ': ' + (hits.length ? hits.join(' | ') : '(无定义)'));
}

fs.writeFileSync('_audit_report.txt', out.join('\n'), 'utf8');
console.log('WROTE _audit_report.txt lines=' + out.length);
