/*
 * Subagent runs: listing a run's directories and reading its log/artifact, and
 * the /api/subagent-runs and /api/subagent-output routes. Split out of
 * server.js (issue #54, phase 11).
 */
'use strict';

module.exports = function subagentRoutes(deps) {
  const {
    RUN_CACHE,
    SESSION_DIR,
    artifactNamesIn,
    dockerCapture,
    dockerRun,
    fs,
    parseSessionDir,
    path,
    readRunDirsDocker,
    readRunDirsLocal,
    runDirRef,
    safeContainerName,
    sameSessionFilePath,
    tailText,
  } = deps;

  function match(req) {
    if (req.url.startsWith('/api/subagent-runs')) return true;
    if (req.url.startsWith('/api/subagent-output')) return true;
    return false;
  }

  async function handle(req, res) {

async function subagentArtifact(runId, wantLabel) {
  const remote = parseSessionDir();
  const localDir = path.join(SESSION_DIR, 'subagent-artifacts');
  let names = [];
  if (remote) {
    // the directory is argv ($1), not script text - same rule as everywhere else
    // that a path meets a shell in this file
    const ctr = safeContainerName(remote.container);
    if (!ctr) return null;
    const out = await dockerRun(ctr, ['sh', '-c',
      'ls -1 "$1" 2>/dev/null', 'sh', path.posix.join(remote.dir, 'subagent-artifacts')], 20000);
    names = out.split('\n').map((x) => x.trim()).filter(Boolean);
  } else {
    try { names = fs.readdirSync(localDir); } catch { names = []; }
  }
  let mine = names.filter((f) => f.startsWith(`${runId}_`));
  if (!mine.length && wantLabel) mine = names.filter((f) => f.includes(`_${wantLabel}_`) || f.includes(`_${wantLabel}.`));
  if (!mine.length) return null;
  // Prefer the final answer; label is the agent name when the extension put it in
  // the file name (`<runId>_<agent>_output.md`).
  const pick = (suffix) => mine.find((f) => f.endsWith(suffix)) || null;
  // The child's own conversation is the transcript; the output is only its last
  // message. Trying several spellings, because the run id in the tool result and
  // the id in the file name are not always the same thing.
  const byLabel = wantLabel ? mine.filter((f) => f.includes(`_${wantLabel}`)) : [];
  const file = pick('_transcript.jsonl')
    || (byLabel.find((f) => f.endsWith('_transcript.jsonl')) || null)
    || pick('_output.md') || (byLabel.find((f) => f.endsWith('.md')) || null)
    || pick('_resolved.md') || pick('_summary.md') || pick('_meta.json')
    || byLabel[0] || mine[0];
  if (!file) return null;
  const target = remote ? path.posix.join(remote.dir, 'subagent-artifacts', file)
    : path.join(localDir, file);
  const text = remote ? await dockerCapture(remote.container, ['cat', target], 30000)
    : (() => { try { return fs.readFileSync(target, 'utf8'); } catch { return ''; } })();
  if (!text) return null;
  return { file, text: file.endsWith('.jsonl') ? tailText(text) : text };
}

/* A pi-subagents run directory, or null.
 *
 * This value arrives in a query string, so it is a *reference* to validate, not
 * a path to use. The check used to be a regex that only had to match somewhere
 * in the string, after which the value was pasted into `ls -1t '<dir>'/…`
 * inside `sh -c`. Two things followed from that, both verified:
 *
 *   - in container mode, `dir=/tmp/pi-subagents-x/async-subagent-runs/'; touch X; '`
 *     ran `touch X` inside the container (command execution);
 *   - in local mode, `…/async-subagent-runs/../../../secret` walked out of the
 *     run directory and read an unrelated `status.json` (arbitrary file read).
 *
 * So the shape is now *anchored*, and normalisation - which is what collapses
 * `..` - happens before the test:
 *
 *   <something>/pi-subagents<scope>/async-subagent-runs/<one segment>
 *
 * One segment means nothing can be appended to it, and in local mode the path
 * must additionally sit under a run root this bridge actually uses. The
 * character allowlist then removes everything a shell or a glob treats as
 * special, so even a path that passes the shape carries no syntax. */
/* A run directory is *data*: it is always passed as argv and quoted as "$1", so
 * the quoting - not this pattern - is what stops a command running. What follows
 * is belt and braces, and it is a denylist on purpose.
 *
 * The first version of this was an allowlist, [A-Za-z0-9 ._+@:/-], and it was
 * wrong in a way the tests caught: os.tmpdir() on Windows returns the 8.3 short
 * form (C:/Users/THEBLU~1/AppData/Local/Temp), and `~` was not in the set - so
 * every genuine run directory on this machine was refused and the feature the
 * check exists to protect stopped working. An allowlist has to enumerate every
 * character a real path can contain and gets it wrong quietly; a denylist only
 * has to name the ones that are actually dangerous. */

async function subagentRunLog(asyncDir) {
  const ref = runDirRef(asyncDir);
  if (!ref) return null;
  if (ref.kind === 'docker') {
    // The directory is argv, quoted as `$1`, and never part of the script text.
    // (The result of `"$1"` is not re-scanned for expansions, so even a `$(` in
    // it would stay literal - and the denylist above rejects one anyway.)
    const out = await dockerRun(ref.container, ['sh', '-c',
      'ls -1t "$1"/output-*.log "$1"/status.json 2>/dev/null | head -5', 'sh', ref.dir], 20000);
    const first = out.split('\n').map((x) => x.trim()).filter(Boolean)[0];
    if (!first) return null;
    // the file we then read is a bare basename under the run dir, re-joined from
    // a validated name rather than taken as a path
    const base = path.posix.basename(first);
    if (!/^[\w.-]+$/.test(base)) return null;
    const text = await dockerRun(ref.container, ['cat', `${ref.dir}/${base}`], 30000);
    return text ? { file: base, text: tailText(text) } : null;
  }
  let files = [];
  try { files = fs.readdirSync(ref.dir); } catch { return null; }
  const logs = files.filter((f) => /^output-.*\.log$/.test(f)).sort();
  const pick = logs.length ? logs[logs.length - 1] : (files.includes('status.json') ? 'status.json' : null);
  if (!pick) return null;
  try { return { file: pick, text: tailText(fs.readFileSync(path.join(ref.dir, pick), 'utf8')) }; } catch { return null; }
}

/* ── live subagent runs ──────────────────────────────────────────────────
 * pi-subagents keeps one status.json per async run under its temp root, with the
 * fields a panel wants while a child works: state, current tool, turns, tools,
 * start and end time - and, once the child has started, the session file it is
 * running in. Reading those directly (instead of waiting for the parent
 * transcript's widget line) is what makes the panel tick in real time, and what
 * lets a click open the child's own conversation rather than a text dump.
 *
 * All of it is read in one pass per poll and cached for a moment: the panel asks
 * about once a second, and inside Docker every read is a `docker exec`. */

async function listSubagentRuns() {
  const now = Date.now();
  const remote = parseSessionDir();
  const ttl = remote ? 1500 : 400;
  if (RUN_CACHE.data && now - RUN_CACHE.at < ttl) return RUN_CACHE.data;
  let runs = [];
  try { runs = remote ? await readRunDirsDocker(remote) : readRunDirsLocal(); } catch { runs = []; }
  try {
    // One listing per session directory, reused for every run that came from it.
    const listing = new Map();
    for (const r of runs) {
      const dir = r.sessionId ? path.dirname(r.sessionId) : null;
      if (!dir) continue;
      if (!listing.has(dir)) listing.set(dir, await artifactNamesIn(dir).catch(() => []));
      const hit = (listing.get(dir) || []).find((n) => n.startsWith(`${r.runId}_`));
      if (hit) r.agent = hit.slice(r.runId.length + 1).split('_')[0] || r.agent;
      if (!r.mode) r.mode = 'single';
    }
  } catch { /* labels are a nicety */ }
  runs.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  RUN_CACHE.at = now;
  RUN_CACHE.data = runs;
  return runs;
}

/* Path comparison for session files coming from different places (a settings
 * file, a container, a transcript). */

  // Every async subagent run this bridge can see. `session` filters to the runs
  // started from that session, so a panel only ever shows its own subagents -
  // and a reload gets them back from disk instead of an empty list.
  if (req.url.startsWith('/api/subagent-runs')) {
    const q = new URL(req.url, 'http://x').searchParams;
    const want = (q.get('session') || '').trim();
    try {
      const all = await listSubagentRuns();
      const runs = want ? all.filter((r) => sameSessionFilePath(r.sessionId, want)) : all;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, runs, total: all.length }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Local speech-to-text: started on request, never on boot. The Whisper
  // backend downloads ~200 MB of whisper.cpp plus the chosen model, so it waits
  // until someone actually picks it.
  if (req.url.startsWith('/api/subagent-output')) {
    const q = new URL(req.url, 'http://x').searchParams;
    const run = (q.get('run') || '').trim();
    const label = (q.get('label') || '').trim().replace(/[^\w.-]/g, '');
    const dir = (q.get('dir') || '').trim();
    if (!/^[\w.-]{6,80}$/.test(run)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing or odd run id' }));
      return;
    }
    try {
      let got = await subagentRunLog(dir).catch(() => null);
      let notes = got ? `live log: ${got.file}` : '';
      if (!got || !got.text || !got.text.trim()) {
        const art = await subagentArtifact(run, label).catch(() => null);
        if (art) { got = art; notes = `${notes ? notes + ' · ' : ''}artifact: ${art.file}`; }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: !!got, text: got ? got.text : '', file: got ? got.file : null, notes }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  }

  return { match, handle };
};
