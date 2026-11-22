/*
 * The four small fixes from the issue batch:
 *
 *   #219  settings notes live behind a ? instead of under every row
 *   #221  notifications are compact, with an arrow to show the full text
 *   #222  "new folder…" is the last item in the session-list menu
 *   #220  the page does not switch a second time while the bridge is resuming
 *
 * The #220 case is driven with the real resumeLastSession() and stubbed
 * fetch/rpc calls: the failure was two switches into the same session, and the
 * second one is exactly what a stub can observe without waiting for a container.
 *
 * Usage: node test-ui-issues.js <browserPath>
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const browser = process.argv[2];
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
if (!browser || !fs.existsSync(browser)) { console.error('no browser at ' + browser); process.exit(2); }

const ROOT = path.resolve(__dirname, '..');
const PORT = 3170 + (process.pid % 120);
const DBG = 9700 + (process.pid % 180);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-ui-issues-'));
const agentDir = path.join(scratch, 'agent');
const sessionDir = path.join(scratch, 'sessions');
for (const d of [agentDir, sessionDir, path.join(scratch, 'ws')]) fs.mkdirSync(d, { recursive: true });
for (const [name, text] of [['alpha.jsonl', 'Alpha session'], ['beta.jsonl', 'Beta session']]) {
  fs.writeFileSync(path.join(sessionDir, name), [
    JSON.stringify({ type: 'session', version: 1, sessionFile: path.join(sessionDir, name) }),
    JSON.stringify({ type: 'message', id: 'm1', message: { role: 'user', content: [{ type: 'text', text }] } }),
  ].join('\n') + '\n');
}
fs.writeFileSync(path.join(scratch, 'webui.json'), JSON.stringify({ onboarded: true }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bridge = null;
const cleanup = () => {
  try { if (bridge) bridge.kill(); } catch { /* gone */ }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* gone */ }
};
process.on('exit', cleanup);
const getJson = (port, p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port, path: p }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
    r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

(async () => {
  bridge = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    env: Object.assign({}, process.env, {
      PI_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: sessionDir, PI_SESSION_DIR: sessionDir,
      WORKSPACE_DIR: path.join(scratch, 'ws'),
      PI_WEBUI_SETTINGS: path.join(scratch, 'webui.json'),
      PI_WEBUI_LAST_SESSION: path.join(scratch, 'last.json'),
      PI_WEBUI_SOURCE_FILE: path.join(scratch, 'source.txt'),
      PI_COMMAND: `${process.execPath} ${path.join(ROOT, 'bridge', 'mock_agent.js')}`,
      PI_LLAMA_SCAN: 'off', PORT: String(PORT),
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let berr = ''; bridge.stderr.on('data', (c) => { berr += c; });
  let up = false;
  for (let i = 0; i < 100; i++) {
    try { const d = await getJson(PORT, '/api/health'); if (d.ok) { up = true; break; } } catch { /* not yet */ }
    await sleep(200);
  }
  if (!up) fail('the scratch bridge never came up\n' + berr.slice(-600));

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-ui-issues-browser-'));
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--remote-debugging-port=' + DBG, '--user-data-dir=' + userDir,
    '--window-size=1200,900', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const cleanupBrowser = () => {
    try { child.kill(); } catch { /* gone */ }
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* gone */ }
  };
  process.on('exit', cleanupBrowser);
  let cerr = ''; child.stderr.on('data', (c) => { cerr += c; });
  let ver = null;
  for (let i = 0; i < 100; i++) { try { ver = await getJson(DBG, '/json/version'); break; } catch { await sleep(150); } }
  if (!ver) fail('browser never came up\n' + cerr.slice(-400));

  const WS = require('./ws-min.js');
  const page = (await getJson(DBG, '/json/list')).find((t) => t.type === 'page');
  const ws = new WS(page.webSocketDebuggerUrl);
  await ws.open();
  let id = 0; const pending = new Map(); const problems = [];
  ws.onmessage = (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const e = m.params.exceptionDetails || {};
      problems.push(((e.exception && (e.exception.description || e.exception.value)) || e.text || '?'));
    }
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'assert')) {
      problems.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
    }
  };
  const send = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params: params || {} })); });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error((r.result.exceptionDetails.exception || {}).description || 'eval threw');
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  for (let i = 0; i < 140; i++) {
    if (await evalJs("typeof openSettings === 'function' && typeof resumeLastSession === 'function' && document.querySelectorAll('#session-list .session-item').length >= 2 ? 1 : 0")) break;
    await sleep(250);
  }

  const out = JSON.parse(await evalJs(`(async () => JSON.stringify(await (async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const res = {};
    document.querySelectorAll('dialog[open]').forEach((d) => { try { d.close(); } catch { /* gone */ } });

    /* ── #219: notes behind a ? ───────────────────────────────────────── */
    openSettings();
    await wait(450);
    const dialog = document.getElementById('settings-dialog');
    const notes = [...dialog.querySelectorAll('[data-note-help]')];
    const sink = document.getElementById('settings-help-sources');
    const tips = [...dialog.querySelectorAll('.help-tip')];
    res.notes = notes.length;
    res.tips = tips.length;
    res.notesInSink = notes.every((n) => !!sink && sink.contains(n));
    res.notesHidden = notes.every((n) => n.offsetParent === null);
    res.notesHaveIcons = notes.every((n) => {
      const t = n.getAttribute('data-help-target');
      const target = t ? dialog.querySelector(t) : null;
      return !!(target && target.querySelector('.help-tip'));
    });
    const animateTip = document.querySelector('#label-avatar-animate .help-tip');
    res.iconAfterLabel = !!animateTip && animateTip.parentElement.id === 'label-avatar-animate';
    res.ttsBackendHasNoHelp = !document.querySelector('#label-tts-backend .help-tip');
    res.fishHelpOnFishModel = !!document.querySelector('#tts-fish-model-label .help-tip');
    res.cursorNoteHidden = !!document.querySelector('#settings-help-sources #cursor-note');
    if (animateTip) animateTip.click();
    await wait(250);
    const pop = document.getElementById('help-pop');
    res.helpShown = !!(animateTip && animateTip.getAttribute('aria-expanded') === 'true' && pop && !pop.classList.contains('hidden'));
    res.helpText = pop ? pop.textContent : '';
    if (animateTip) animateTip.click();
    await wait(100);
    res.helpHiddenAgain = !pop || pop.classList.contains('hidden');
    // Pin it, then close the dialog: the popup must not survive into the next
    // open as a stale floating box.
    if (animateTip) animateTip.click();
    await wait(100);
    dialog.close();
    await wait(100);
    res.helpClosedWithDialog = !pop || pop.classList.contains('hidden');
    openSettings();
    await wait(300);
    const popAgain = document.getElementById('help-pop');
    res.helpNotResurrected = !popAgain || popAgain.classList.contains('hidden');
    document.getElementById('settings-dialog').close();

    /* ── #221: compact notifications with an expanding arrow ─────────── */
    S.notices = [];
    S.noticesUnread = 0;
    S.noticesFromCommand = false;
    notice('A short notice.');
    notice('A longer notification that must be clamped in the compact list. '.repeat(8), 'warning',
      'first detail line\\nsecond detail line\\n' + 'more detail '.repeat(20));
    openNoticesDialog();
    await wait(350);
    const rows = [...document.querySelectorAll('#notices-list .notice-row')];
    const long = rows.find((r) => /longer notification/.test(r.textContent));
    const short = rows.find((r) => /A short notice/.test(r.textContent));
    const longText = long && long.querySelector('.n-text');
    const longDetail = long && long.querySelector('.n-detail');
    const toggle = long && long.querySelector('.n-toggle');
    res.noticeRows = rows.length;
    res.noticeClamped = !!longText && longText.getBoundingClientRect().height < 60;
    res.noticeHasArrow = !!toggle;
    res.detailCollapsed = !!longDetail && longDetail.getBoundingClientRect().height === 0;
    res.shortHasNoArrow = !!short && !short.querySelector('.n-toggle');
    if (toggle) toggle.click();
    await wait(250);
    const detail = document.getElementById('notice-detail-dialog');
    const detailBody = document.getElementById('notice-detail-body');
    const detailText = detailBody && detailBody.querySelector('.notice-detail-text');
    const detailCode = detailBody && detailBody.querySelector('.notice-detail-code');
    const dr = detail.getBoundingClientRect();
    res.noticeDetailOpen = !!detail.open;
    res.noticeDetailFull = dr.width > 600 && dr.height > 300;
    res.noticeDetailFormatted = !!detailText && getComputedStyle(detailText).whiteSpace === 'pre-wrap'
      && !!detailCode && getComputedStyle(detailCode).whiteSpace === 'pre-wrap'
      && /first detail line/.test(detailCode.textContent);
    detail.close();
    closeNoticesDialog();
    await wait(100);
    // A toast is the short-lived copy of the same notice; it must lead to the
    // same readable view, not just vanish after five seconds.
    toast('A toast that should open its full notification.', 'warning');
    await wait(100);
    const toastEl = document.querySelector('#toasts .toast');
    if (toastEl) toastEl.click();
    await wait(150);
    res.toastDetailOpen = !!detail.open && /toast that should open/.test((detailBody || {}).textContent || '');
    detail.close();

    /* ── compaction marker survives looking at another session ───────── */
    /* A compaction belongs to the agent's session even while you browse a
     * different one. Switch away during the live marker and while the result is
     * being recorded; coming back must show it, not leave a blank transcript. */
    const alphaPath = ${JSON.stringify(path.join(sessionDir, 'alpha.jsonl'))};
    const betaPath = ${JSON.stringify(path.join(sessionDir, 'beta.jsonl'))};
    S.state.sessionFile = alphaPath;
    S.viewSession = null;
    S.compacting = true;
    handleRpcMessage({ type: 'compaction_start' });
    await wait(100);
    const liveBefore = !!document.querySelector('.msg.compaction.compacting');
    await switchToSession(betaPath);
    await wait(200);
    await switchToSession(alphaPath);
    await wait(300);
    res.compactionLiveBack = !!document.querySelector('.msg.compaction.compacting');
    handleRpcMessage({ type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false,
      result: { summary: 'SWITCH-SUMMARY', tokensBefore: 90000, estimatedTokensAfter: 12000 } });
    await wait(200);
    await switchToSession(betaPath);
    await wait(200);
    await switchToSession(alphaPath);
    await wait(350);
    res.compactionMarkBack = [...document.querySelectorAll('.msg.compaction')].some((n) => /SWITCH-SUMMARY/.test(n.textContent));
    res.compactionPinnedBack = [...document.querySelectorAll('.msg.compaction.pinned')].some((n) => /SWITCH-SUMMARY/.test(n.textContent));
    res.compactionLiveBefore = liveBefore;
    if (S.compactionLive) { try { S.compactionLive.root.remove(); } catch { /* gone */ } S.compactionLive = null; }
    S.compacting = false;
    S.viewSession = null;

    /* ── #222: the folder action is the last item, and its dialog fits ─ */
    const list = document.getElementById('session-list');
    const lr = list.getBoundingClientRect();
    list.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, button: 2,
      clientX: Math.round(lr.x + 40), clientY: Math.round(lr.y + lr.height - 30),
    }));
    await wait(100);
    const menu = MENUS[MENUS.length - 1];
    const labels = menu ? [...menu.querySelectorAll('.model-item .model-label')].map((x) => x.textContent) : [];
    res.menuLabels = labels;
    res.newFolderLast = labels.length === 2 && labels[labels.length - 1] === 'new folder…';
    if (menu) {
      const item = [...menu.querySelectorAll('.model-item')].find((x) => /new folder/.test(x.textContent || ''));
      if (item) item.click();
      await wait(300);
      const ask = document.getElementById('ask-dialog');
      const body = ask && ask.querySelector('#ask-body');
      const row = body && body.querySelector('.ask-row');
      res.folderDialogOpen = !!ask && ask.open;
      res.folderDialogFits = !!ask && ask.scrollWidth <= ask.clientWidth + 1;
      res.folderRowAligned = !!row && getComputedStyle(row).display === 'grid';
      const askButtons = ask && ask.querySelector(':scope > .dialog-buttons');
      res.folderButtonsRight = !!askButtons && getComputedStyle(askButtons).justifyContent === 'flex-end';
      res.folderButtonsRuled = !!askButtons && parseFloat(getComputedStyle(askButtons).borderTopWidth) > 0;
      const askCheck = body && body.querySelector('.ask-check input[type=checkbox]');
      res.folderCheckboxThemed = !!askCheck && getComputedStyle(askCheck).width !== 'auto';
      res.folderBottomOption = !!askCheck;
      if (ask && ask.open) ask.close();
    }

    /* The create dialog's new option, and the folder it produces, really sits
     * after the unfiled sessions. */
    closeAllMenus();
    const createPromise = addFolderDialog();
    await wait(200);
    const createBox = document.querySelector('#ask-body .ask-check input[type=checkbox]');
    res.createBottomOption = !!createBox;
    document.getElementById('ask-cancel').click();
    await createPromise;
    newFolder('bottom folder', null, true);
    await wait(350);
    const topRows = [...document.querySelectorAll('#session-list > *')];
    const lastRow = topRows[topRows.length - 1];
    res.bottomFolderLast = !!lastRow && lastRow.classList.contains('session-folder')
      && /bottom folder/.test(lastRow.textContent || '');
    if (lastRow && lastRow.classList.contains('session-folder')) {
      lastRow.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, button: 2,
        clientX: Math.round(lastRow.getBoundingClientRect().left + 20),
        clientY: Math.round(lastRow.getBoundingClientRect().top + 10),
      }));
      await wait(100);
      const fm = MENUS[MENUS.length - 1];
      const fl = fm ? [...fm.querySelectorAll('.model-label')].map((x) => x.textContent) : [];
      res.folderMenuCanMove = fl.includes('move to the top of the list');
      closeAllMenus();
    }

    /* ── #220: no second switch while the bridge is resuming ─────────── */
    const apiSessions = await fetch('/api/sessions').then((r) => r.json());
    res.resumingField = 'resuming' in apiSessions;
    const realFetch = window.fetch;
    const realRpc = window.rpc;
    const sessions = [
      { path: '/tmp/ui-issues-b.jsonl', name: 'b' },
      { path: '/tmp/ui-issues-c.jsonl', name: 'c' },
    ];
    const runResume = async (opts) => {
      const calls = [];
      S.state.sessionFile = '/tmp/ui-issues-a.jsonl';
      S.viewSession = null;
      S.remote = null;
      localStorage.setItem(lastSessionKey(), '/tmp/ui-issues-b.jsonl');
      window.fetch = async (url, init) => {
        if (!String(url).includes('/api/sessions')) return realFetch(url, init);
        return { json: async () => ({ sessions, remembered: '/tmp/ui-issues-b.jsonl', resuming: opts.resuming || null }) };
      };
      window.rpc = async (cmd) => {
        if (cmd.type !== 'get_state' && cmd.type !== 'switch_session') return realRpc(cmd);
        calls.push(cmd.type + (cmd.sessionPath ? ':' + cmd.sessionPath : ''));
        if (cmd.type === 'get_state') return { sessionFile: opts.state };
        return {};
      };
      await resumeLastSession();
      return { calls, view: S.viewSession, state: S.state.sessionFile };
    };
    res.resumeInFlight = await runResume({ resuming: '/tmp/ui-issues-b.jsonl', state: '/tmp/ui-issues-a.jsonl' });
    res.resumeJustFinished = await runResume({ resuming: null, state: '/tmp/ui-issues-b.jsonl' });
    res.resumeFallback = await runResume({ resuming: null, state: '/tmp/ui-issues-a.jsonl' });
    window.fetch = realFetch;
    window.rpc = realRpc;
    S.viewSession = null;

    /* ── a manual compaction is not cancelled by clicking another session ─ */
    const oldCompacting = S.compacting;
    const oldStreaming = S.isStreaming;
    const oldState = S.state.sessionFile;
    const oldView = S.viewSession;
    const oldLive = S.live;
    const realRender = window.renderSessionFromDisk;
    let switchedDuringCompaction = 0;
    S.compacting = true;
    S.isStreaming = false;
    S.live = null;
    S.state.sessionFile = '/tmp/ui-issues-agent.jsonl';
    S.viewSession = null;
    window.renderSessionFromDisk = async () => {};
    window.rpc = async (cmd) => {
      if (cmd.type === 'switch_session') switchedDuringCompaction++;
      return {};
    };
    await switchToSession('/tmp/ui-issues-compaction-view.jsonl');
    res.compactionView = { switched: switchedDuringCompaction, view: S.viewSession };
    S.compacting = oldCompacting;
    S.isStreaming = oldStreaming;
    S.state.sessionFile = oldState;
    S.viewSession = oldView;
    S.live = oldLive;
    window.renderSessionFromDisk = realRender;
    window.rpc = realRpc;
    return res;
  })()))()`));

  if (!out.notes || !out.tips) fail('the settings notes are not decorated at all: ' + JSON.stringify(out));
  if (out.notesInSink !== true || out.notesHidden !== true) fail('settings notes are still visible: ' + JSON.stringify(out));
  if (out.notesHaveIcons !== true) fail('a settings note has no question mark: ' + JSON.stringify(out));
  if (out.tips !== out.notes) fail('the number of help icons does not match the notes: ' + JSON.stringify({ notes: out.notes, tips: out.tips }));
  if (!out.iconAfterLabel) fail('the ? is not immediately after the setting name: ' + JSON.stringify(out));
  if (!out.ttsBackendHasNoHelp) fail('TTS backend still has a Fish-only ?: ' + JSON.stringify(out));
  if (!out.fishHelpOnFishModel) fail('the Fish note is not attached to the Fish Audio model label: ' + JSON.stringify(out));
  if (!out.cursorNoteHidden) fail('the Custom cursor note is still visible: ' + JSON.stringify(out));
  if (!out.helpShown || !/How many messages keep a moving profile picture/.test(out.helpText)) {
    fail('the help popup does not show the note: ' + JSON.stringify(out));
  }
  if (!out.helpHiddenAgain) fail('clicking the help icon twice did not close it: ' + JSON.stringify(out));
  if (!out.helpClosedWithDialog || !out.helpNotResurrected) fail('the help popup survives closing the settings dialog: ' + JSON.stringify(out));
  if (out.noticeRows !== 2 || !out.noticeClamped || !out.noticeHasArrow || !out.detailCollapsed || !out.shortHasNoArrow) {
    fail('notifications are not compact/expandable: ' + JSON.stringify(out));
  }
  if (!out.noticeDetailOpen || !out.noticeDetailFull || !out.noticeDetailFormatted) {
    fail('the notification arrow does not open a full, properly formatted view: ' + JSON.stringify(out));
  }
  if (!out.toastDetailOpen) fail('clicking a toast does not open its notification details: ' + JSON.stringify(out));
  if (!out.newFolderLast) fail('"new folder…" is not the last item in the session menu: ' + JSON.stringify(out.menuLabels));
  if (!out.folderDialogOpen || !out.folderDialogFits || !out.folderRowAligned) {
    fail('the new-folder dialog is not laid out properly: ' + JSON.stringify(out));
  }
  if (!out.folderButtonsRight || !out.folderButtonsRuled || !out.folderCheckboxThemed) {
    fail('the new-folder dialog still has browser-default button/checkbox formatting: ' + JSON.stringify(out));
  }
  if (!out.folderBottomOption || !out.createBottomOption) fail('the new-folder dialog has no bottom-of-list option: ' + JSON.stringify(out));
  if (!out.bottomFolderLast) fail('a bottom-placed folder is not after the unfiled sessions: ' + JSON.stringify(out));
  if (!out.folderMenuCanMove) fail('a folder menu cannot move it back to the top: ' + JSON.stringify(out));
  if (out.resumingField !== true) fail('/api/sessions does not report a resume in flight');
  if (out.resumeInFlight.calls.length || out.resumeInFlight.view !== '/tmp/ui-issues-b.jsonl') {
    fail('the page switched while the bridge was already resuming: ' + JSON.stringify(out.resumeInFlight));
  }
  if (out.resumeJustFinished.calls.join(',') !== 'get_state' || !/ui-issues-b/.test(out.resumeJustFinished.state)) {
    fail('a resume that had just finished was switched to a second time: ' + JSON.stringify(out.resumeJustFinished));
  }
  /* This one used to require a `switch_session` into the remembered session, and
   * that switch is what lost a real prompt: pi was in a session the scan did not
   * list (pi spells the same file differently once a container path mapping or a
   * moved session directory is involved), so the page decided pi was somewhere it
   * had not put it and moved the agent to the remembered session - which is
   * whatever was written last, i.e. row one of the sidebar. The message that
   * followed was written into that other conversation. A reload may ask where the
   * agent is and show it; it may not move the agent. */
  if (out.resumeFallback.calls.some((c) => c.startsWith('switch_session')) ||
      !/ui-issues-a/.test(out.resumeFallback.state)) {
    fail('the page moved the agent out of a session pi reported as a real file: ' + JSON.stringify(out.resumeFallback));
  }
  if (out.compactionView.switched !== 0 || out.compactionView.view !== '/tmp/ui-issues-compaction-view.jsonl') {
    fail('clicking another session during a manual compaction switched the agent and would cancel it: ' + JSON.stringify(out.compactionView));
  }
  if (!out.compactionLiveBefore || !out.compactionLiveBack || !out.compactionMarkBack) {
    fail('the in-flight/finished compaction marker was lost across a session switch: ' + JSON.stringify(out));
  }
  if (out.compactionPinnedBack) {
    fail('a compaction that finished while its session was on screen was pinned to the bottom on return (the stale marker that a reload cleared)');
  }
  if (problems.length) fail('the page reported errors:\n' + problems.join('\n'));
  console.log('  #219 notes hidden behind ' + out.tips + ' ? icons, with the popup working');
  console.log('  #221 notifications clamp in the list and open full-window from the arrow or a toast');
  console.log('  #222 "new folder…" is last, and its dialog fits');
  console.log('  #220 no second switch while the bridge is resuming, and no switch into another session');
  console.log('  PASS the issue batch behaves as asked');
  cleanupBrowser(); cleanup(); process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
