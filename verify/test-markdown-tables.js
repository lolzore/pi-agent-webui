/*
 * Issue #60: "Implementing full markdown to the chat".
 *
 * The screenshot attached to it is a table arriving as raw pipes - the renderer is a
 * hand-written line parser that handled headings, lists, quotes and fenced code, and
 * had no idea what a table was, so `| a | b |` came out as literal text in a <p>.
 *
 * This drives the real renderMarkdown() with the table from that screenshot and with
 * the awkward shapes around it, and asserts on the DOM that comes out - not on the
 * HTML string, because "there are <table> tags in it" is not the same as a table
 * being there.
 *
 * Usage: node test-markdown-tables.js <baseUrl> <browserPath>
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
const ok = (m) => console.log('  PASS ' + m);
if (!base) { console.error('usage: node test-markdown-tables.js <baseUrl> <browserPath>'); process.exit(2); }
if (!browser || !fs.existsSync(browser)) { console.error('no browser at ' + browser); process.exit(2); }

const PORT = 9990 + (process.pid % 4);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-md-'));
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

/* The table from the screenshot, which is the shape pi's own terminal renders. */
const TABLE = [
  '| RPC | sent id | source table |',
  '|---|---|---|',
  '| ClientBuyMaterial (bAll=1 **推荐**) | **posID** | shop.csv port 1 |',
  '| ClientBuyMaterial (bAll=3 specialPrize) | posID | shop.csv port 3 |',
  '| ClientBuyRole / ClientBuyClothes | nID | shop.csv port 3 |',
  '| ClientBuyMysteryShop | MysteryShopMap slot key | mysteryshop_item.csv |',
  '| ClientActivityExchange | (activityID, exchangeID) | Events.csv + ExchangeShop.csv |',
].join('\n');

const CASES = {
  screenshot: TABLE,
  aligned: '| left | centre | right |\n|:---|:---:|---:|\n| a | b | c |',
  afterText: 'So the id semantics per RPC:\n\n' + TABLE.split('\n').slice(0, 3).join('\n') + '\n',
  thenText: TABLE + '\nand that is all.',
  noDelimiter: '| this | is not |\n| a table at all | really |',
  inCode: '```\n| not | a table |\n|---|---|\n```',
  beforeList: TABLE + '\n- a bullet after it\n- another',
};

(async () => {
  let ver = null;
  for (let i = 0; i < 100; i++) { try { ver = await getJson('/json/version'); break; } catch { await sleep(150); } }
  if (!ver) fail('browser never came up\n' + stderr.slice(-400));

  const WS = require('./ws-min.js');
  const page = (await getJson('/json/list')).find((t) => t.type === 'page');
  const ws = new WS(page.webSocketDebuggerUrl);
  await ws.open();
  let id = 0; const pending = new Map();
  const problems = [];
  ws.onmessage = (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      problems.push(((d.exception && (d.exception.description || d.exception.value)) || d.text || '?'));
    }
  };
  const send = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params: params || {} })); });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error((r.result.exceptionDetails.exception || {}).description || 'eval threw');
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: base + '/' });
  await sleep(3000);
  for (let i = 0; i < 60; i++) {
    if (await evalJs("typeof renderMarkdown === 'function' ? 1 : 0")) break;
    await sleep(250);
  }

  // Render each case into a detached div and describe what the DOM actually holds.
  const out = JSON.parse(await evalJs(`(() => {
    const cases = ${JSON.stringify(CASES)};
    const res = {};
    for (const [name, src] of Object.entries(cases)) {
      const d = document.createElement('div');
      d.innerHTML = renderMarkdown(src);
      const table = d.querySelector('table');
      const heads = table ? [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim()) : [];
      const rows = table ? [...table.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim())) : [];
      const aligns = table ? [...table.querySelectorAll('thead th')].map((th) => th.style.textAlign || '') : [];
      res[name] = {
        tables: d.querySelectorAll('table').length,
        heads, rows, aligns,
        rowCells: table ? [...table.querySelectorAll('tbody tr')].map((tr) => tr.querySelectorAll('td').length) : [],
        rawPipes: /\\|[^|]*\\|/.test(d.textContent.replace(/\\s+/g, ' ')) && !table,
        boldInCell: table ? !!table.querySelector('tbody b, tbody strong') : false,
        codeBlocks: d.querySelectorAll('.codebox').length,
        hasListAfter: !!d.querySelector('ul li'),
        text: d.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80),
        // Uncut: the table's own text is longer than 80 chars, so an assertion about
        // what follows it has to look past the truncation used for the log line.
        fullText: d.textContent.replace(/\\s+/g, ' ').trim(),
      };
    }
    return JSON.stringify(res);
  })()`));

  const s = out.screenshot;
  console.log(`  the screenshot's table: ${s.tables} table, ${s.heads.length} columns, ${s.rows.length} rows`);
  console.log(`    header: ${JSON.stringify(s.heads)}`);
  console.log(`    row 1 : ${JSON.stringify(s.rows[0])}`);
  if (s.tables !== 1) fail(`the table from the screenshot rendered ${s.tables} table(s) - it is still raw pipes: ${JSON.stringify(s.text)}`);
  if (s.heads.length !== 3) fail('the header row lost columns: ' + JSON.stringify(s.heads));
  if (s.rows.length !== 5) fail(`expected 5 body rows, got ${s.rows.length}`);
  if (!s.rows.every((r) => r.length === 3)) fail('a body row has the wrong number of cells: ' + JSON.stringify(s.rowCells));
  if (!/ClientBuyMysteryShop/.test(JSON.stringify(s.rows))) fail('the cell text is not in the table: ' + JSON.stringify(s.rows.slice(0, 2)));
  if (!s.boldInCell) fail('**bold** inside a cell was not rendered');
  ok('#60 the table renders as a table, with its header, 5 rows and inline markdown');

  const a = out.aligned;
  console.log(`  alignment: ${JSON.stringify(a.aligns)} (left, centre, right)`);
  if (a.tables !== 1) fail('an aligned table did not render');
  if (a.aligns.join(',') !== 'left,center,right') fail('the colons on the delimiter row were ignored: ' + JSON.stringify(a.aligns));
  ok('#60 :--, :-: and --: set the column alignment');

  for (const name of ['afterText', 'thenText']) {
    if (out[name].tables !== 1) fail(`a table ${name === 'afterText' ? 'after a paragraph' : 'followed by text'} did not render (${out[name].tables} tables)`);
  }
  if (!out.thenText.fullText.includes('and that is all')) fail('the text after a table was swallowed: ' + JSON.stringify(out.thenText.fullText.slice(-70)));
  if (!out.beforeList.hasListAfter) fail('the list after a table was swallowed');
  ok('#60 a table renders between other blocks without swallowing them');

  // A pipe line with no delimiter row is text, not a table - otherwise every
  // sentence with a pipe in it becomes one.
  if (out.noDelimiter.tables !== 0) fail('a pipe line without a delimiter row became a table - every line with a | in it would');
  if (!/a table at all/.test(out.noDelimiter.fullText)) fail('the text of that line disappeared');
  ok('#60 a line with pipes but no delimiter row stays text');

  // Inside a fenced code block it must stay code, untouched.
  if (out.inCode.tables !== 0) fail('a table inside a code block was rendered');
  if (!out.inCode.fullText.includes('| not | a table |')) fail('the code block lost its content');
  if (out.inCode.codeBlocks !== 1) fail('the code block is not a code block after the table change');
  ok('#60 a table inside a code fence is left as code');

  // The source is built here and passed in: a fenced block needs backticks, and a
  // backtick inside the page expression's template literal would end it.
  const BT = String.fromCharCode(96);
  const MD_SIMPLE = [
    '# h1', '', '## h2', '',
    'text with **bold** and *italic* and ' + BT + 'code' + BT, '',
    '- one', '- two', '', '1. first', '', '> quoted', '',
    BT + BT + BT, 'block', BT + BT + BT,
  ].join('\n');
  // And the ordinary markdown still works, since the loop was rewritten for this.
  const stillWorks = JSON.parse(await evalJs(`(() => {
    const d = document.createElement('div');
    d.innerHTML = renderMarkdown(${JSON.stringify(MD_SIMPLE)});
    return JSON.stringify({
      h1: !!d.querySelector('h1'), h2: !!d.querySelector('h2'), bold: !!d.querySelector('b'),
      italic: !!d.querySelector('i'), code: !!d.querySelector('code.inline'),
      ul: !!d.querySelector('ul'), ol: !!d.querySelector('ol'), quote: !!d.querySelector('blockquote'),
      fence: !!d.querySelector('.codebox'), tables: d.querySelectorAll('table').length,
    });
  })()`));
  const missing = Object.entries(stillWorks).filter(([k, v]) => k !== 'tables' && !v).map(([k]) => k);
  if (missing.length) fail('the table change broke existing markdown: ' + missing.join(', '));
  if (stillWorks.tables !== 0) fail('plain markdown produced a table');
  ok('#60 headings, lists, quotes, code, bold and italic all still work');

  if (problems.length) fail(problems.slice(0, 3).join(' | '));
  ws.close(); cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); fail(e && e.stack ? e.stack : String(e)); });
