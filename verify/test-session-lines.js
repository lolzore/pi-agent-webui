// Unit check: sessionLines must yield a real JSONL file back, byte for byte,
// in the original order — and must do it lazily.
//
// Laziness is the point. The regression this was written for rewrote the line
// splitter to collect every line into an array and yield them all at the end,
// which (a) made the first thing a caller saw the trailing partial line instead
// of the session header, and (b) meant a caller that only wanted a few lines
// still paid to read the whole file. A 70 MB session is the real case.
//
// Usage: node test-session-lines.js <server.js> <session.jsonl>

const fs = require('fs');
const { StringDecoder } = require('string_decoder');
const vm = require('vm');
const { execFileSync } = require('child_process');

const serverFile = process.argv[2];
const sessionFile = process.argv[3];

function extract(decl) {
  return execFileSync(process.execPath,
    [__dirname + '/extract.js', serverFile, decl],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

const src = extract('async function* sessionLines(');
const sessionLines = vm.compileFunction(
  src + '\nreturn sessionLines;',
  ['fs', 'spawn', 'StringDecoder'],
)(fs, () => {}, StringDecoder);

const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };

(async () => {
  const want = fs.readFileSync(sessionFile, 'utf8').split('\n').filter((l) => l !== '');

  // 1. every line, in order, unchanged
  const seen = [];
  for await (const line of sessionLines({ kind: 'local', path: sessionFile })) seen.push(line);
  if (seen.length !== want.length) fail(`line count ${seen.length} != ${want.length}`);
  for (let i = 0; i < want.length; i++) {
    if (seen[i] !== want[i]) {
      fail(`line ${i} differs: got ${seen[i].length} bytes, want ${want[i].length}`);
    }
  }

  // 2. each line still parses. A multi-byte character split across a read
  //    boundary shows up here and nowhere else.
  for (let i = 0; i < seen.length; i++) {
    try { JSON.parse(seen[i]); }
    catch (e) { fail(`line ${i} is not valid JSON (${e.message}) — likely a split multi-byte character`); }
  }

  // 3. the header is first. The UI reads the session name and parent from it, so
  //    an out-of-order first line is exactly how a chat comes up blank.
  if (JSON.parse(seen[0]).type !== 'session') {
    fail(`first line is "${JSON.parse(seen[0]).type}", expected "session"`);
  }

  // 4. lazy: taking 3 lines must not read the file to the end.
  const it = sessionLines({ kind: 'local', path: sessionFile });
  const got = [];
  for await (const line of it) { got.push(line); if (got.length === 3) break; }
  if (got.length !== 3) fail(`early break yielded ${got.length} lines, expected 3`);
  if (JSON.parse(got[0]).type !== 'session') fail('early break returned lines out of order');

  console.log(`${seen.length}`);
})().catch((e) => fail(e && e.stack ? e.stack : String(e)));
