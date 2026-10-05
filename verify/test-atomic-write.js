// Unit check: the atomic JSON write must land the file whole, leave no staging
// file behind, and never destroy the previous good file when a write fails.
//
// Usage: node test-atomic-write.js <server.js>

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const serverFile = process.argv[2];
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };

const src = execFileSync(process.execPath,
  [path.join(__dirname, 'extract.js'), serverFile, 'function writeJsonAtomic('],
  { encoding: 'utf8' });
const writeJsonAtomic = vm.compileFunction(
  src + '\nreturn writeJsonAtomic;',
  ['fs', 'process'],
)(fs, process);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-'));
try {
  const target = path.join(dir, 'models.json');

  // 1. contents land exactly
  writeJsonAtomic(target, { a: 1, b: [2, 3] });
  const want = JSON.stringify({ a: 1, b: [2, 3] }, null, 2);
  if (fs.readFileSync(target, 'utf8') !== want) fail('contents differ from what was written');

  // 2. no staging file left behind
  const left = fs.readdirSync(dir).filter((f) => f !== 'models.json');
  if (left.length) fail(`temp files left behind: ${left.join(', ')}`);

  // 3. a write that cannot succeed must leave the old file intact
  try {
    writeJsonAtomic(path.join(dir, 'no-such-dir', 'x.json'), { a: 2 });
  } catch { /* expected */ }
  if (!fs.existsSync(target)) fail('a failed write destroyed the previous good file');
  if (fs.readFileSync(target, 'utf8') !== want) fail('a failed write modified the previous good file');

  // 4. overwrite in place works
  writeJsonAtomic(target, { a: 9 });
  if (fs.readFileSync(target, 'utf8') !== JSON.stringify({ a: 9 }, null, 2)) fail('overwrite failed');
  const left2 = fs.readdirSync(dir).filter((f) => f !== 'models.json');
  if (left2.length) fail(`temp files left behind after overwrite: ${left2.join(', ')}`);

  console.log('4');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
