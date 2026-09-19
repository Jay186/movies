import fs from 'fs';
import path from 'path';

const ROOT = path.resolve('.');
const SKIP = /node_modules|_video_trash|\\uploads|_archive_bak|_backup_|_snapshots/;

function walk(dir, out = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (SKIP.test(p)) continue;
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|mjs)$/.test(e.name)) out.push(path.resolve(p));
  }
  return out;
}

const files = walk(ROOT);
const fileSet = new Set(files);
const rel = (p) => p.replace(ROOT + path.sep, '').replace(/\\/g, '/');

const inDeg = {};
const outMap = {};
const unresolved = [];
const REL_RE = /['"]((?:\.\.?\/)[^'"]+)['"]/g;

for (const f of files) {
  inDeg[f] = inDeg[f] || 0;
  let src;
  try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
  const seen = new Set();
  let m;
  REL_RE.lastIndex = 0;
  while ((m = REL_RE.exec(src)) !== null) {
    const spec = m[1];
    const base = path.resolve(path.dirname(f), spec);
    const cands = [base, base + '.js', base + '.mjs', base + '.json', path.join(base, 'index.js'), path.join(base, 'index.mjs')];
    const hit = cands.find((c) => fileSet.has(c));
    if (hit) {
      if (!seen.has(hit)) { seen.add(hit); inDeg[hit] = (inDeg[hit] || 0) + 1; (outMap[f] = outMap[f] || []).push(hit); }
    } else if (!/\.(json|css|png|jpg|svg|txt|md|vue)$/.test(spec)) {
      unresolved.push({ from: rel(f), spec });
    }
  }
}

const allFiles = files.slice().sort();
const zero = allFiles.filter((f) => (inDeg[f] || 0) === 0);
const bySize = (a, b) => fs.statSync(b).size - fs.statSync(a).size;

const L = [];
L.push('########## 1. 总览 ##########');
L.push('扫描 .js/.mjs 文件数: ' + files.length);
L.push('被引用过的文件数: ' + allFiles.filter((f) => inDeg[f] > 0).length);
L.push('入度为 0 的文件数: ' + zero.length);
L.push('');

L.push('########## 2. 入度为 0 的文件(无人 import) ##########');
L.push('(排除入口候选: index.js / tests/ / 以 _ 开头)');
L.push('');
zero.sort(bySize).forEach((f) => {
  const r = rel(f);
  const sz = (fs.statSync(f).size / 1024).toFixed(1);
  const tag = /(^|\/)index\.js$/.test(r) ? '  <-- 可能是入口' : (/^tests\//.test(r) ? '  <-- 测试入口' : (/\/_|^_/.test(r) ? '  <-- 临时' : ''));
  L.push('  ' + sz.padStart(8) + ' KB  ' + r + tag);
});
L.push('');

L.push('########## 3. 未解析的相对引用(悬空 import) ##########');
if (unresolved.length === 0) L.push('  (无)');
else unresolved.forEach((u) => L.push('  ' + u.from + '  ==>  ' + u.spec));
L.push('');

L.push('########## 4. 文件体积 TOP 25 ##########');
allFiles.slice().sort(bySize).slice(0, 25).forEach((f) => {
  L.push('  ' + (fs.statSync(f).size / 1024).toFixed(1).padStart(8) + ' KB  ' + rel(f));
});
L.push('');

L.push('########## 5. 被引用次数 TOP 25(核心枢纽) ##########');
allFiles.slice().sort((a, b) => (inDeg[b] || 0) - (inDeg[a] || 0)).slice(0, 25).forEach((f) => {
  L.push('  ' + String(inDeg[f] || 0).padStart(4) + ' 次  ' + rel(f));
});

fs.writeFileSync('_audit1.txt', L.join('\n'), 'utf8');
console.log('WROTE _audit1.txt');
