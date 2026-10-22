/*
 * Session storage: the reference resolver, the line reader (with its index),
 * the picture externaliser, and the local/docker scanners that fill the
 * sidebar. Split out of server.js (issue #54, phase 10).
 *
 * The factory receives the names the code used from server.js. `scanState` is a
 * shared object (server.js declares it before the route modules) so the last
 * scan error stays live for /api/sessions instead of being a snapshot.
 */
'use strict';

module.exports = function sessionScanners(deps) {
  const {
    SESSION_DIR,
    StringDecoder,
    execFile,
    fs,
    isSubagentTranscript,
    nameFromText,
    parseSessionDir,
    path,
    readSessionEdges,
    safeSessionPath,
    spawn,
    titleFromHead,
    scanState,
  } = deps;


/* A session file lives either on this machine or inside a container
 * (PI_SESSION_DIR=docker:<ctr>:<dir>). Reading, downloading and deleting one go
 * through these helpers, so no endpoint has to know which of the two it is.
 * The transcript reader used to refuse outright - "docker session dirs are not
 * supported here" - and the UI showed that as "Could not load session" for every
 * session in the sidebar whenever the agent ran in a container. */
/* Run a command in a container and collect its stdout.
 *
 * The container name is validated **here** rather than at each call site (issue
 * #29). It comes from PI_SESSION_DIR, so it is operator-set and was never
 * remotely reachable - but it is an argv element alongside argument lists that
 * *are* built from untrusted data, and the next person adding a call should not
 * have to re-derive which of the two is trusted. Validating in one place means
 * every caller, present and future, inherits it. */
function dockerCapture(container, args, timeoutMs = 60000, maxBuffer = 256 * 1024 * 1024) {
  const ctr = safeContainerName(container);
  if (!ctr) return Promise.resolve('');
  return new Promise((resolve) => {
    execFile('docker', ['exec', ctr, ...args], { timeout: timeoutMs, maxBuffer, shell: false },
      (err, stdout) => resolve(err ? '' : stdout));
  });
}

/* A path from either world, or null when it is not a .jsonl inside the session
 * dir - the check that stops delete/export from being talked into touching
 * anything else. In container mode the path is validated as a container path
 * and only ever read through `docker exec`, never from the host. */
function sessionRef(raw) {
  const remote = parseSessionDir();
  if (!remote) {
    const local = safeSessionPath(raw);
    return local ? { kind: 'local', path: local } : null;
  }
  if (typeof raw !== 'string' || !raw.trim()) return null;
  // Windows paths can arrive with backslashes; inside the container it is a
  // POSIX path either way. 92 is the backslash, spelled this way so the
  // source does not depend on how many escapes survived the editor.
  const posix = (v) => path.posix.normalize(String(v).replaceAll(String.fromCharCode(92), '/'));
  const want = posix(raw.trim());
  const root = posix(remote.dir);
  if (!(want === root || want.startsWith(root === '/' ? '/' : root + '/'))) return null;
  if (path.posix.extname(want).toLowerCase() !== '.jsonl') return null;
  return { kind: 'docker', container: remote.container, path: want };
}

async function readSessionRef(ref) {
  if (ref.kind === 'docker') return (await dockerCapture(ref.container, ['cat', ref.path])) || null;
  // Promises, not readFileSync: a session file can be tens of megabytes, and the
  // synchronous read held the whole bridge's event loop for the duration - the
  // agent's RPC pipe included, so asking for a long transcript froze the agent
  // too. Nothing here needs the file before the next line anyway.
  try { return await fs.promises.readFile(ref.path, 'utf8'); } catch { return null; }
}

/* ── reading a session transcript ───────────────────────────────────────
 * This used to be: read the whole file, split it into an array, JSON.parse
 * every line, build one array of messages, stringify the lot, and only then
 * write the first byte.
 *
 * Measured on a real 70 MB session, the JSON.parse was 49 ms of a 565 ms load -
 * so making the parsing parallel would have been the wrong lever entirely. The
 * cost was elsewhere: 378 ms elapsed before the browser saw a single byte, all
 * of it one unbroken block on the event loop, and roughly 200 MB of resident
 * memory for the duration (the file as a string, the parsed objects, and the
 * re-serialised copy - three copies of the same base64).
 *
 * So: read the file line by line and write each message out as it is parsed.
 * Time-to-first-byte drops to about the cost of the first line, the transfer
 * overlaps the parsing instead of following it, peak memory falls to roughly one
 * message, and the yields between batches stop a long read from stalling the
 * agent's event stream (which is why opening a long session used to visibly
 * pause a running turn). */

/* The file's lines, as an async iterable. Backpressure-aware: the caller's
 * writes are awaited, so a slow client cannot make the bridge buffer the whole
 * transcript in memory to send it later. */
/* ── images in a session file: a reference instead of the bytes ──────────
 *
 * A session file stores every picture the agent ever looked at, or that was
 * ever pasted, as a base64 block inside its JSON line. On a real session here
 * that was 99% of the file: 69 of 70 MB on one, 25 of 221 messages carrying
 * everything. The transcript response was that file again, so opening the
 * session downloaded every picture in it - to render a handful of them as
 * 220-pixel thumbnails, most of them far below the fold.
 *
 * So the transcript now names the pictures instead of carrying them, and the
 * bytes are fetched only for the ones actually on screen. The browser already
 * defers this: lazySrc() sets an <img>'s src when it comes within 1200px of the
 * viewport and takes it away again past 3000px, so scrolling a long session
 * pulls in the pictures you pass and releases the ones you leave.
 *
 * The reference is a plain URL, which means nothing in the renderer has to
 * change shape: the same <img src> works for a URL and for a data URL, and
 * clicking one to view it full size opens the same thing.
 *
 * Two escape hatches, both deliberate:
 *  - `?inline=1` on the transcript puts the bytes back in the response, exactly
 *    as it used to be, for anything that wants a self-contained file;
 *  - pictures below the threshold stay inline, so a small icon in a message
 *    costs no extra request and still opens instantly. */
const IMAGE_INLINE_LIMIT = 8 * 1024;   // base64 characters

/* Where to fetch one picture from. The token is the file's size and mtime, so a
 * session that grows (a new turn appended) or is rewritten invalidates every
 * reference to it, and the browser's own cache does the rest. */
function imageUrl(sessionPath, line, part, stamp) {
  return `/api/session-image?path=${encodeURIComponent(sessionPath)}&line=${line}&part=${part}` +
    (stamp ? `&v=${encodeURIComponent(stamp)}` : '');
}

/* Replace the big image blocks in one message with references. Returns how many
 * were moved out and how many bytes that saved, so the endpoint can report it. */
function externaliseImages(msg, sessionPath, line, stamp) {
  const content = msg && msg.content;
  if (!Array.isArray(content)) return { n: 0, saved: 0 };
  let n = 0, saved = 0;
  for (let i = 0; i < content.length; i++) {
    const b = content[i];
    if (!b || b.type !== 'image' || typeof b.data !== 'string') continue;
    if (b.data.length <= IMAGE_INLINE_LIMIT) continue;
    const bytes = Math.round(b.data.length * 0.75);
    // the payload is replaced in place: the object is freshly parsed from the
    // file and nothing else holds it.
    // `part` is the index in the content array, not a count of pictures - a
    // message shaped [text, image, text, image] has parts 1 and 3, and counting
    // the pictures instead pointed the fetch at the wrong block (a 404, for every
    // image in every message that did not start with one).
    b.data = undefined;
    b.bytes = bytes;
    b.line = line;
    b.part = i;
    b.src = imageUrl(sessionPath, line, i, stamp);
    n++; saved += bytes;
  }
  return { n, saved };
}

/* ── where each line starts ───────────────────────────────────────────────
 *
 * `/api/session-image` has to find one line in a session file, and it used to do
 * that by reading the file from the beginning until it reached it. Cost is
 * therefore O(position of the line): measured on a 36 MB / 60-line session,
 * 6.4 ms for an image on line 2 and 44.9 ms for one on line 60. With N images
 * that is O(N x filesize) - and every image the chat shows costs one of those.
 *
 * The transcript endpoint already reads every line of the file, so it can record
 * where each one started at no extra cost. This is that record: byte offset per
 * line, keyed by the same size+mtime token the image URLs already use, so a
 * session that grows or is rewritten invalidates it exactly as it invalidates
 * the browser's cached copies.
 *
 * Bounded on purpose. These are the newest sessions in a bounded list, and a run
 * that opens hundreds of different sessions should not keep all of them. */
const LINE_INDEX_MAX = 24;
const LINE_INDEX = new Map();   // key -> { offsets: number[] }

function indexKey(ref, stamp) {
  const where = ref.kind === 'docker' ? `${ref.container}:${ref.path}` : ref.path;
  return `${where}|${stamp || ''}`;
}

function indexPut(key, offsets) {
  LINE_INDEX.delete(key);            // re-insert so it counts as most recent
  LINE_INDEX.set(key, { offsets });
  while (LINE_INDEX.size > LINE_INDEX_MAX) LINE_INDEX.delete(LINE_INDEX.keys().next().value);
}

function indexGet(key) {
  const hit = LINE_INDEX.get(key);
  return hit ? hit.offsets : null;
}

/* The size+mtime token for a session, the same one the image URLs carry. */
async function sessionStamp(ref) {
  try {
    if (ref.kind !== 'docker') {
      const s = await fs.promises.stat(ref.path);
      return `${s.size}-${Math.floor(s.mtimeMs)}`;
    }
    return String(await dockerCapture(ref.container, ['stat', '-c', '%s-%Y', ref.path], 20000) || '').trim();
  } catch { return ''; }
}

/* One line, read from a known byte offset, without reading what came before it.
 *
 * This carried a note claiming that "a line longer than the cap is reported as
 * not found, which falls back to the forward scan". That was not what the code
 * did - it returned the truncated bytes as if they were the whole line - and the
 * note has gone with the bug, because believing it is what made the failure look
 * like a missing image. */
/* One line, read from a known byte offset, for the picture endpoint.
 *
 * A session line has no size worth guessing at: a message carries its pictures
 * inline, and one off a phone camera is several megabytes of base64 on a single
 * line. This used to grow its read but stop at 8 MB - smaller than that - so the
 * line came back truncated, JSON.parse threw on it, and the caller reported the
 * image as "no longer at that line" while it sat there in the file. Which is
 * issue #38 exactly: the pictures that failed to load were the phone ones, every
 * other picture worked, and the file was fine all along.
 *
 * So the read grows until it finds the newline or reaches the end of the file.
 * maxBytes is still there for a caller that wants a ceiling; the default is the
 * file. Measured on the session from that issue: line 85 is 10,450,484 chars of
 * base64 and now serves as a 7,837,863-byte PNG.
 *
 * The chunks are joined and decoded ONCE at the end rather than per read: a
 * multi-byte character can straddle two reads, and decoding each chunk on its own
 * would corrupt it - the same reason sessionLines below decodes the way it does. */
async function readLineAt(ref, offset, maxBytes = Number.MAX_SAFE_INTEGER) {
  if (offset < 0) return null;
  if (ref.kind === 'docker') {
    // `tail -c +N` is 1-based, and the path is argv as everywhere else
    const out = await dockerCapture(ref.container, ['tail', '-c', `+${offset + 1}`, ref.path], 30000);
    const text = String(out || '');
    const nl = text.indexOf('\n');
    return nl < 0 ? (text || null) : text.slice(0, nl);
  }
  let fh;
  try { fh = await fs.promises.open(ref.path, 'r'); } catch { return null; }
  try {
    const st = await fh.stat();
    if (offset >= st.size) return null;
    const hardEnd = Math.min(offset + maxBytes, st.size);
    const chunks = [];
    let got = 0;
    let len = Math.min(65536, hardEnd - offset);
    for (;;) {
      if (len <= 0) break;
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, offset + got);
      if (!bytesRead) break;
      const slice = buf.subarray(0, bytesRead);
      const nl = slice.indexOf(0x0a);
      if (nl >= 0) {
        // cut at the newline, so what is decoded holds only whole characters
        chunks.push(slice.subarray(0, nl));
        break;
      }
      chunks.push(slice);
      got += bytesRead;
      if (bytesRead < len) break;                 // the line runs to the end of the file
      if (offset + got >= hardEnd) break;         // a ceiling was asked for
      len = Math.min(len * 4, 64 * 1024 * 1024, hardEnd - offset - got);
    }
    if (!chunks.length) return null;
    return Buffer.concat(chunks).toString('utf8');
  } catch { return null; } finally {
    try { await fh.close(); } catch { /* already closed */ }
  }
}

/* Every line of a session, one at a time, with the byte offset of each.
 *
 * Streaming rather than reading the file whole, because a session can be tens of
 * megabytes; `onLine` is handed the offset before each line so a caller can build
 * the line index that readLineAt above seeks with. */
async function* sessionLines(ref, onLine) {
  if (ref.kind === 'docker') {
    // `docker exec` hands us a live stdout, so the file can be read as it
    // arrives instead of after the whole of it has crossed into this process.
    // The first version used dockerCapture, which collects the entire file into
    // one string before returning - so on the setup the bridge actually runs on
    // (a native bridge driving an agent inside a container) nothing could be
    // sent until the last byte had come back: measured 1513 ms before the first
    // byte on a 70 MB session, 3.3 s to finish.
    const child = spawn('docker', ['exec', ref.container, 'cat', ref.path], { stdio: ['ignore', 'pipe', 'ignore'] });
    // A multi-byte character can straddle two chunks, so the bytes are decoded
    // through a StringDecoder rather than with toString() per chunk - otherwise a
    // session containing any emoji or accented text would be corrupted wherever
    // it happened to fall on a buffer edge.
    const decoder = new StringDecoder('utf8');
    let buf = '';
    let failed = null;
    // bytes consumed before the line now being assembled
    let consumed = 0;
    child.on('error', (e) => { failed = e; });
    try {
      for await (const chunk of child.stdout) {
        const text = buf + decoder.write(chunk);
        const parts = text.split('\n');
        buf = parts.pop();
        for (const line of parts) {
          if (onLine) onLine(consumed);
          // +1 for the newline that was split away
          consumed += Buffer.byteLength(line, 'utf8') + 1;
          yield line;
        }
        if (failed) throw failed;
      }
      buf += decoder.end();
      if (buf) { if (onLine) onLine(consumed); yield buf; }
      if (failed) throw failed;
    } finally {
      try { child.kill(); } catch { /* already gone */ }
    }
    return;
  }
  /* Read the raw bytes and decode them here, rather than letting the stream do
   * the decoding, so that a byte offset per line can be counted. Node's own
   * decode and StringDecoder agree on utf8 - the multi-byte test that guards this
   * function is what proves it - and the docker branch above already decodes
   * this way for the same reason (a character can straddle two chunks). */
  const stream = fs.createReadStream(ref.path, { highWaterMark: 1 << 18 });
  const decoder = new StringDecoder('utf8');
  // `buf` is the partial trailing line carried between chunks. It is declared
  // per-branch on purpose: the docker branch above has its own, and sharing one
  // across both would let a docker read leak a half-line into a local read.
  let buf = '';
  // bytes consumed before the line now being assembled
  let consumed = 0;
  const emit = function* (line, bytes) {
    if (onLine) onLine(consumed);
    consumed += bytes;
    yield line;
  };
  for await (const chunk of stream) {
    const text = decoder.write(chunk);
    let start = 0, nl;
    while ((nl = text.indexOf('\n', start)) >= 0) {
      buf += text.slice(start, nl);
      // +1 for the newline itself
      for (const l of emit(buf, Buffer.byteLength(buf, 'utf8') + 1)) yield l;
      buf = '';
      start = nl + 1;
    }
    if (start < text.length) buf += text.slice(start);
  }
  buf += decoder.end();
  if (buf) { if (onLine) onLine(consumed); yield buf; }
}

/* Let the event loop have the thread back. setImmediate (not a timer) so this is
 * the very next turn of the check phase - no millisecond of latency added. */
const breathe = () => new Promise((r) => setImmediate(r));

/* Write, honouring backpressure.
 *
 * Coalescing matters more than it looks. A session line can be a quarter of a
 * megabyte (one message with a screenshot in it), and writing each one on its own
 * meant the socket buffer filled on every line, the write went async, and the
 * next line was not even read until the previous one had drained - read, parse,
 * write, wait, repeat, all strictly in series. That measured *slower* than the
 * old build-everything-first approach even though it started instantly, because
 * it gave up the memory bandwidth of one big sequential read.
 *
 * So: gather messages into a buffer and send it in reasonably large pieces, and
 * only then wait for the socket. The response is told about a big buffer so it
 * does not report "full" after 16 KB. */
const WRITE_CHUNK = 256 * 1024;
function writeStream(res) {
  const w = { res, buf: [], size: 0, wait: null };
  w.add = (s) => { w.buf.push(s); w.size += s.length; };
  w.flush = async () => {
    if (!w.size) return;
    const chunk = w.buf.length === 1 ? w.buf[0] : w.buf.join('');
    w.buf.length = 0; w.size = 0;
    if (w.res.write(chunk)) return;
    await new Promise((resolve) => w.res.once('drain', resolve));
  };
  return w;
}

/* How big the file is, without reading it.
 *
 * This one line cost more than everything else put together when it was written
 * the obvious way. Asking for the size by reading the file - which is what the
 * first version did, through readSessionRef - pulls the whole thing across
 * `docker exec` before the first line of the response exists, which is precisely
 * the wait streaming was supposed to remove: 1478 ms before the first byte on a
 * 70 MB session, with every streaming change already in place and none of it
 * mattering. `stat` answers in about a millisecond. */
async function sessionSize(ref) {
  try {
    if (ref.kind !== 'docker') return (await fs.promises.stat(ref.path)).size;
    const out = await dockerCapture(ref.container, ['stat', '-c', '%s', ref.path], 20000);
    const n = parseInt(String(out || '').trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch { return 0; }
}

/* Run `fn` over `items` with at most `limit` in flight.
 *
 * The cost here is per-file latency, not CPU, so overlapping the I/O is most of
 * the win - but an unbounded Promise.all over a session directory with thousands
 * of files would hold thousands of descriptors open at once, so the concurrency
 * is capped. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  await Promise.all(workers);
  return out;
}

const SCAN_CONCURRENCY = 24;

async function scanLocalSessions() {
  let files;
  try {
    files = await fs.promises.readdir(SESSION_DIR, { recursive: true })
      .then((f) => f.filter((f) => f.endsWith('.jsonl') && !isSubagentTranscript(f)))
      .then((f) => f.map((f) => path.join(SESSION_DIR, f)));
  } catch {
    return [];
  }
  const edges = await mapLimit(files, SCAN_CONCURRENCY, (f) => readSessionEdges(f));
  const sessions = [];
  for (let i = 0; i < files.length; i++) {
    const e = edges[i];
    if (!e) continue;                             // vanished between readdir and open
    const file = files[i];
    const name = path.basename(file);
    let parent = null;
    // The header records where a fork came from, which is what the sidebar
    // uses to show "this one branched off that one".
    try { parent = JSON.parse(e.head.split('\n')[0]).parentSession || null; } catch { /* old or odd file */ }
    let title = '';
    try { title = titleFromHead(e.head); } catch { /* unreadable */ }
    // prefer an explicit rename (tail) over the derived first-message title.
    // A tail read usually starts mid-line, so the partial first line is dropped -
    // and when there is no newline in the window there is nothing to drop.
    const tailForName = e.tailTruncated ? e.tail.slice(e.tail.indexOf('\n') + 1) : e.tail;
    let explicit = null;
    try { explicit = nameFromText(tailForName); } catch { /* odd file */ }
    sessions.push({
      path: file,
      fileName: name,
      name: explicit || title || name.replace(/\.jsonl$/, ''),
      mtime: e.mtimeMs,
      size: e.size,
      parent,
    });
  }
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions.slice(0, 200);
}

/* A container name that is safe to hand to `docker exec`.
 *
 * The name is always an argv element, never script text, so this is not about
 * shell quoting: it only has to reject values `docker` would read as a flag
 * (leading `-`) and anything a line-oriented reader could not carry. */
function safeContainerName(name) {
  const n = String(name == null ? '' : name).trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(n) ? n : null;
}

/* Run one command in a container. Args are passed positionally - the file list
 * below is a list of argv elements, never text spliced into a script. */
function dockerRun(container, args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    execFile('docker', ['exec', container, ...args],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, shell: false },
      (err, stdout) => resolve(err ? '' : String(stdout || '')));
  });
}

/* Session discovery inside a container.
 *
 * ── why this is written the way it is ──────────────────────────────────────
 *
 * It used to build a shell script out of the file names it had just read:
 *
 *     for f in '<path1>' '<path2>'; do …; done        ->  sh -c
 *
 * A session file whose *name* contained a single quote therefore closed the
 * quote and ran a command of its own. That was not theoretical: one
 * unauthenticated `GET /api/sessions`, with a file named
 * `a'; do touch PWNED_FINAL; done #x.jsonl` in the session directory, created
 * /workspace/PWNED_FINAL inside the container. File names come from `find`, and
 * `find` is not a trusted source of shell-safe text.
 *
 * So the directory is now *data* (`$1`), the paths are *argv* (`"$@"`), and
 * nothing that arrives over the wire or off the filesystem is ever parsed as
 * shell syntax.
 *
 * Two more faults lived in the same function and are fixed with it, because
 * they are the same mistake seen from the other end - treating a path as a
 * string to be rewritten rather than a value to be carried:
 *
 *  - the directory was "sanitised" by deleting every character outside
 *    [A-Za-z0-9_-/], which deleted the dot in `~/.pi/agent/sessions` - the
 *    default session directory - so the scan looked at `/root/pi/agent/sessions`,
 *    which does not exist, and reported **zero sessions with no error at all**,
 *    for ever. Verified against a container: the dotted path listed nothing, the
 *    same directory without a dot listed the session. The container name is now
 *    validated instead, and the directory is passed through untouched.
 *
 *  - it relied on `find -printf`, which is a GNU extension. BusyBox `find`
 *    (Alpine, and many slim images) has no such option, so the listing was
 *    silently empty on those too. `find -print0` plus `stat -c` works on both -
 *    checked on Debian and on Alpine.
 *
 * A file name containing a newline or the marker text is skipped rather than
 * allowed to make the head/tail markers ambiguous. */
const DOCKER_SCAN_LIMIT = 200;
const DOCKER_LIST_BYTES = 2000000;
const TITLE_MARKER = '===PIWEBUI';

/* One warning per distinct reason.
 *
 * The session scan can fail for reasons that are all reported the same way - an
 * empty list - so anything that explains one is worth saying once, and not worth
 * repeating every twenty seconds for the rest of the run (issue #30). */
const SCAN_WARNED = new Set();
function warnScanOnce(key, message) {
  if (SCAN_WARNED.has(key)) return;
  SCAN_WARNED.add(key);
  console.warn(`session scan: ${message}`);
}

async function scanDockerSessions(container, dir) {
  const ctr = safeContainerName(container);
  if (!ctr) {
    /* Say why, once.
     *
     * Every failure in this function used to be silent: the dot-stripping bug
     * and the GNU `find -printf` dependency both presented as HTTP 200 with an
     * empty session list, no error and no log line, so an empty sidebar was
     * indistinguishable from "you have no sessions" (issue #30). A docker mode
     * that cannot be reached at all is worth one line in the console. */
    warnScanOnce('container-name', `session scan skipped: "${String(container).slice(0, 60)}" is not a usable container name`);
    return [];
  }
  const root = String(dir == null ? '' : dir).trim();
  if (!root) return [];

  // 1) the files. NUL-separated, so a space or a quote in a name is just a byte.
  const listRaw = await dockerRun(ctr, ['sh', '-c',
    `find "$1" -name '*.jsonl' -print0 2>/dev/null | head -c ${DOCKER_LIST_BYTES}`, 'sh', root]);
  const paths = listRaw.split('\u0000')
    .map((s) => s.replace(/\r?\n$/, ''))
    .filter(Boolean)
    .filter((p) => p.endsWith('.jsonl') && !isSubagentTranscript(p))
    // a name the marker line below cannot carry unambiguously
    .filter((p) => !/[\r\n]/.test(p) && !p.includes(TITLE_MARKER))
    .slice(0, DOCKER_SCAN_LIMIT);
  if (!paths.length) return [];

  // 2) mtime and size. One `stat` per file, over argv; GNU and BusyBox agree on -c.
  const statRaw = await dockerRun(ctr, ['sh', '-c',
    'for f do stat -c "%Y %s %n" "$f" 2>/dev/null || true; done', 'sh', ...paths]);
  const files = [];
  for (const line of statRaw.split('\n')) {
    const m = /^(\d+) (\d+) ([\s\S]+)$/.exec(line.trim());
    if (!m) continue;
    const p = m[3];
    if (!paths.includes(p)) continue;         // never trust a name we did not ask for
    files.push({
      path: p,
      fileName: p.split('/').pop(),
      mtime: Math.floor(parseFloat(m[1]) * 1000),
      size: parseInt(m[2], 10) || 0,
    });
  }
  if (!files.length) return [];
  files.sort((a, b) => b.mtime - a.mtime);
  const newest = files.slice(0, DOCKER_SCAN_LIMIT);

  // 3) a title from each file's head, and any explicit rename from its tail.
  //    `for f do` walks "$@", so a quote or a space in a name is inert.
  const heads = await dockerRun(ctr, ['sh', '-c',
    'for f do' +
    ` echo "${TITLE_MARKER} $f"; head -c 32768 "$f"; echo;` +
    ` echo "${TITLE_MARKER}TAIL $f"; tail -c 65536 "$f" 2>/dev/null; echo; done`, 'sh',
    ...newest.map((f) => f.path)], 60000);
  const titleByFile = {};
  const explicitByFile = {};
  for (const chunk of heads.split(TITLE_MARKER)) {
    const nl = chunk.indexOf('\n');
    if (nl < 0) continue;
    const marker = chunk.slice(0, nl).trim();
    const body = chunk.slice(nl + 1);
    if (marker.startsWith('TAIL ')) explicitByFile[marker.slice(5).trim()] = nameFromText(body);
    else if (marker) titleByFile[marker] = titleFromHead(body);
  }
  return newest.map((f) => ({
    path: f.path,
    fileName: f.fileName,
    name: explicitByFile[f.path] || titleByFile[f.path] || f.fileName.replace(/\.jsonl$/, ''),
    mtime: f.mtime,
    size: f.size,
  }));
}

/* Discover sessions, and carry the reason if it fails.
 *
 * Returning a bare [] on failure is what made an unreadable session directory
 * indistinguishable from an empty one: the page showed an empty sidebar, which
 * reads as "you have no sessions" rather than "nothing could be read". The scan
 * still returns [] so every existing caller works, but it records why, and
 * /api/sessions passes that on for the UI to show (issue #30). */
/* lastScanError lives on the shared scanState object (server.js declares it). */

async function scanSessions() {
  const remote = parseSessionDir();
  if (remote) {
    const ctr = safeContainerName(remote.container);
    if (!ctr) {
      scanState.lastScanError = `"${String(remote.container).slice(0, 60)}" is not a usable container name`;
      warnScanOnce('container-name', scanState.lastScanError);
      return [];
    }
    try {
      const found = await scanDockerSessions(remote.container, remote.dir);
      scanState.lastScanError = null;
      return found;
    } catch (e) {
      scanState.lastScanError = `could not read ${remote.dir} in ${ctr}: ${e.message}`;
      warnScanOnce('docker-scan', scanState.lastScanError);
      return [];
    }
  }
  try {
    const found = await scanLocalSessions();
    scanState.lastScanError = null;
    return found;
  } catch (e) {
    scanState.lastScanError = `could not read ${SESSION_DIR}: ${e.message}`;
    warnScanOnce('local-scan', lastScanError);
    return [];
  }
}

  return {
    DOCKER_LIST_BYTES,
    DOCKER_SCAN_LIMIT,
    IMAGE_INLINE_LIMIT,
    LINE_INDEX,
    LINE_INDEX_MAX,
    SCAN_CONCURRENCY,
    SCAN_WARNED,
    TITLE_MARKER,
    WRITE_CHUNK,
    breathe,
    dockerCapture,
    dockerRun,
    externaliseImages,
    imageUrl,
    indexGet,
    indexKey,
    indexPut,
    mapLimit,
    readLineAt,
    readSessionRef,
    safeContainerName,
    scanDockerSessions,
    scanLocalSessions,
    scanSessions,
    sessionLines,
    sessionRef,
    sessionSize,
    sessionStamp,
    warnScanOnce,
    writeStream,
    scanState,
  };
};
