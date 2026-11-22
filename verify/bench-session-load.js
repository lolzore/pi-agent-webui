/*
 * How long does it take to load every session on this machine?
 *
 * Not part of the test matrix - a measurement tool. Run it when the cost of
 * opening (or listing) sessions is in question:
 *
 *   node verify/bench-session-load.js "$HOME/.pi/agent/sessions"
 *   node verify/bench-session-load.js "$HOME/.pi/agent/sessions" --endpoint http://127.0.0.1:3077
 *
 * Three numbers per session:
 *   read   streaming the file and splitting it into lines (what the reader does)
 *   parse  the JSON.parse calls inside that loop, measured around the call only
 *   http   the real /api/session-messages round trip ("opening" the session)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const dir = process.argv[2];
const epIdx = process.argv.indexOf('--endpoint');
const endpoint = epIdx > 0 ? process.argv[epIdx + 1] : '';
if (!dir || !fs.existsSync(dir)) { console.error('usage: node bench-session-load.js <sessionsDir> [--endpoint http://host:port]'); process.exit(2); }

const hrtime = process.hrtime.bigint;
const ms = (a, b) => Number(b - a) / 1e6;
const now = () => hrtime();

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

/* One pass, streaming, timing only the parse calls. A 548MB session read as one
 * string is 1GB+ in memory and tells you nothing the stream does not. */
async function measure(file) {
  const size = fs.statSync(file).size;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let lines = 0;
  let parseNs = 0n;
  let bytes = 0;
  const t0 = now();
  for await (const line of rl) {
    lines += 1;
    bytes += line.length + 1;
    const a = now();
    try { JSON.parse(line); } catch { /* a truncated tail is not a parse cost */ }
    parseNs += (now() - a);
  }
  const wall = ms(t0, now());
  return { file, size, lines, wall, parse: Number(parseNs) / 1e6, bytes };
}

async function httpJson(url, method = 'GET') {
  const t0 = now();
  const r = await fetch(url, { method });
  const text = await r.text();
  return { ms: ms(t0, now()), bytes: text.length, status: r.status };
}

(async () => {
  const files = walk(dir).sort();
  const totalBytes = files.reduce((n, f) => n + fs.statSync(f).size, 0);
  console.log(`${files.length} sessions, ${(totalBytes / 1e6).toFixed(1)} MB in ${dir}\n`);

  if (endpoint) {
    const list = await httpJson(`${endpoint}/api/sessions`);
    console.log(`sidebar: GET /api/sessions  ${list.ms.toFixed(0)} ms  (${(list.bytes / 1024).toFixed(0)} KB, ${list.status})\n`);
  }

  const rows = [];
  for (const f of files) rows.push(await measure(f));

  let sumWall = 0, sumParse = 0, sumHttp = 0;
  for (const r of rows) {
    sumWall += r.wall; sumParse += r.parse;
    r.httpMs = null;
    if (endpoint) {
      const u = `${endpoint}/api/session-messages?path=${encodeURIComponent(r.file)}`;
      try {
        const h = await httpJson(u);
        r.httpMs = h.ms; r.httpBytes = h.bytes; r.httpStatus = h.status;
        if (h.status === 200) sumHttp += h.ms;
      } catch (e) { r.httpStatus = String(e.message || e); }
    }
  }

  const pad = (s, n) => String(s).padStart(n);
  const padR = (s, n) => String(s).padEnd(n);
  console.log(`${padR('session', 46)} ${pad('MB', 7)} ${pad('lines', 8)} ${pad('read', 7)} ${pad('parse', 7)} ${pad('parse%', 7)} ${pad('http', 7)}`);
  const shown = rows.slice().sort((a, b) => b.size - a.size).slice(0, 15);
  for (const r of shown) {
    const short = path.basename(r.file).slice(0, 44);
    const pct = r.wall > 0 ? (r.parse / r.wall) * 100 : 0;
    console.log(`${padR(short, 46)} ${pad((r.size / 1e6).toFixed(1), 7)} ${pad(r.lines, 8)} ${pad(r.wall.toFixed(0), 7)} ${pad(r.parse.toFixed(0), 7)} ${pad(pct.toFixed(1) + '%', 7)} ${pad(r.httpMs == null ? '-' : r.httpMs.toFixed(0), 7)}`);
  }
  if (rows.length > shown.length) console.log(`... ${rows.length - shown.length} smaller sessions not listed`);

  const pct = (arr, p) => { const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))] || 0; };
  console.log('');
  console.log(`all ${rows.length} sessions, sequential:`);
  console.log(`  read + parse   ${sumWall.toFixed(0)} ms  (${(totalBytes / 1e6).toFixed(0)} MB, ${(totalBytes / 1e6 / (sumWall / 1000)).toFixed(0)} MB/s)`);
  console.log(`  of which parse ${sumParse.toFixed(0)} ms  (${(sumParse / sumWall * 100).toFixed(1)}% of the load, ${(totalBytes / 1e6 / (sumParse / 1000)).toFixed(0)} MB/s)`);
  const walls = rows.map((r) => r.wall);
  console.log(`  median ${pct(walls, 0.5).toFixed(0)} ms, p95 ${pct(walls, 0.95).toFixed(0)} ms, slowest ${Math.max(...walls).toFixed(0)} ms; ${rows.filter((r) => r.wall > 1000).length} of ${rows.length} sessions take over 1s`);
  if (endpoint) {
    console.log(`  http total     ${sumHttp.toFixed(0)} ms  (overlap with parsing included; that is the number a reader waits for)`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
