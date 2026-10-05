/*
 * Regression test for issue #37: "bash commands empty (sometimes)" - a running
 * command showed an empty card and only filled in once it finished.
 *
 * The cause was one unguarded assignment. `tool_execution_update` wrote the
 * partial result into the card body whatever it was, and several shapes pi sends
 * render to an empty string (`''`, `[]`, `{content: []}`, `{output: ''}`), so the
 * first progress event wiped the arguments - for bash, the command being run -
 * and un-hid the body, leaving a visible empty strip for the rest of the call.
 *
 * That also exposed a second bug. The result step skipped a card that still had
 * a `.diffbox`, meaning "a diff is showing, do not overwrite it". But
 * fillToolBody builds a `.diffbox` for the *arguments* too, so the test only
 * passed by accident: it worked because the update above had destroyed the
 * arguments box. Stop blanking the body and a card would have kept its arguments
 * forever instead of showing the output. The body now says what it holds
 * (`data-kind`), and the diff is preserved on purpose rather than by luck.
 *
 * Usage: node test-tool-card.js <baseUrl> <browserPath>
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const base = process.argv[2];
const browser = process.argv[3];
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
if (!base) { console.error('usage: node test-tool-card.js <baseUrl> <browserPath>'); process.exit(2); }
if (!browser || !fs.existsSync(browser)) { console.error('no browser at ' + browser); process.exit(2); }

const PORT = 9950 + (process.pid % 40);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-toolcard-'));
const child = spawn(browser, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--remote-debugging-port=' + PORT, '--user-data-dir=' + userDir,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
child.stderr.on('data', (c) => { stderr += c; });
const cleanup = () => {
  try { child.kill(); } catch { /* gone */ }
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* gone */ }
};
process.on('exit', cleanup);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
    r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

(async () => {
  let ver = null;
  for (let i = 0; i < 100; i++) { try { ver = await getJson('/json/version'); break; } catch { await sleep(150); } }
  if (!ver) fail('browser never came up\n' + stderr.slice(-400));

  const WS = require('./ws-min.js');
  const page = (await getJson('/json/list')).find((t) => t.type === 'page');
  const ws = new WS(page.webSocketDebuggerUrl);
  await ws.open();
  let id = 0; const pending = new Map();
  ws.onmessage = (raw) => { let m; try { m = JSON.parse(raw); } catch { return; } if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params: params || {} })); });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error((r.result.exceptionDetails.exception || {}).description || 'eval threw');
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: base + '/' });
  await sleep(1500);
  for (let i = 0; i < 80; i++) {
    if (await evalJs("typeof startToolCard === 'function' && typeof handleRpcMessage === 'function' ? 1 : 0")) break;
    await sleep(250);
  }

  const res = await evalJs(`(() => {
    const out = {};
    const ev = (o) => handleRpcMessage(o);
    /* A live turn would take these cards into the live message rather than into
     * #chat (startToolCard appends to S.live when there is one), and the
     * assertions below look in #chat. This test is about what a card shows, not
     * about a turn, so it starts from a quiet page - which also makes it
     * independent of whatever the shared agent was doing when it began, the
     * reason it passed alone and failed in the suite. */
    S.live = null;
    S.liveDetached = null;
    const bodyOf = (id) => {
      const c = S.toolCards.get(id);
      return c ? { text: c.body.textContent.trim(), kind: c.body.dataset.kind || null, hidden: c.body.classList.contains('hidden') } : null;
    };

    // ── a bash tool call, as pi drives it ──────────────────────────────
    document.getElementById('chat').innerHTML = '';
    ev({ type: 'tool_execution_start', toolCallId: 'tc-bash', toolName: 'bash', args: { command: 'npm run build', timeout: 600 } });
    out.afterStart = bodyOf('tc-bash');

    // progress events whose payload renders to nothing - the shapes that caused
    // the empty card
    for (const p of ['', [], { content: [] }, { output: '' }]) {
      ev({ type: 'tool_execution_update', toolCallId: 'tc-bash', toolName: 'bash', partialResult: p });
    }
    out.afterEmptyUpdates = bodyOf('tc-bash');

    // a partial that really has output
    ev({ type: 'tool_execution_update', toolCallId: 'tc-bash', toolName: 'bash', partialResult: { output: 'building…\\n' } });
    out.afterRealUpdate = bodyOf('tc-bash');

    // and the finished result
    ev({ type: 'tool_execution_end', toolCallId: 'tc-bash', toolName: 'bash', isError: false, result: { output: 'built in 4.2s\\n', exitCode: 0 } });
    out.afterEnd = bodyOf('tc-bash');

    // ── an edit tool: the rendered diff must survive the result ────────
    document.getElementById('chat').innerHTML = '';
    ev({ type: 'tool_execution_start', toolCallId: 'tc-edit', toolName: 'edit',
         args: { path: '/tmp/f.txt', oldText: 'one\\ntwo\\n', newText: 'one\\nTWO\\n' } });
    out.editAfterStart = bodyOf('tc-edit');
    ev({ type: 'tool_execution_end', toolCallId: 'tc-edit', toolName: 'edit', isError: false, result: 'Edited /tmp/f.txt' });
    out.editAfterEnd = bodyOf('tc-edit');
    out.editHasDiff = !!document.querySelector('#chat .tool-card .diffbox .dl.add, .tool-card .diffbox .dl');

    document.getElementById('chat').innerHTML = '';
    return JSON.stringify(out);
  })()`);

  const r = JSON.parse(res);
  const show = (label, v) => console.log('  ' + label.padEnd(22) + (v ? JSON.stringify(v).slice(0, 96) : String(v)));

  show('after start', r.afterStart);
  show('after empty updates', r.afterEmptyUpdates);
  show('after real update', r.afterRealUpdate);
  show('after end', r.afterEnd);

  if (!r.afterStart || !/npm run build/.test(r.afterStart.text)) fail('#37 the command is not shown when the card is created');
  if (!r.afterEmptyUpdates || !/npm run build/.test(r.afterEmptyUpdates.text)) {
    fail('#37 an empty progress event blanked the card: ' + JSON.stringify(r.afterEmptyUpdates));
  }
  if (!/building/.test(r.afterRealUpdate.text)) fail('#37 real output did not replace the body: ' + JSON.stringify(r.afterRealUpdate));
  if (!/built in 4/.test(r.afterEnd.text)) fail('#37 the finished result is not shown: ' + JSON.stringify(r.afterEnd));
  if (r.afterEmptyUpdates.hidden) fail('#37 the body is hidden while the command runs');
  console.log('  PASS #37 the command stays visible while running; empty progress cannot blank it');

  show('edit after start', r.editAfterStart);
  show('edit after end', r.editAfterEnd);
  if (r.editAfterStart.kind !== 'diff') fail('#37 an edit call did not render as a diff (kind=' + r.editAfterStart.kind + ')');
  if (r.editAfterEnd.kind !== 'diff') fail('the rendered diff was overwritten by the result (kind=' + r.editAfterEnd.kind + ')');
  if (!r.editHasDiff) fail('the diff body is empty');
  console.log('  PASS an edit diff is still preserved against the result');

  ws.close(); cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
