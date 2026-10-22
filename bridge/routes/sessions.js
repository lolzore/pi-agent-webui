/*
 * Session routes, split out of server.js (issue #54, phase 9).
 *
 * Listing sessions, one picture out of a session file, the transcript reader,
 * downloading a session file and deleting one. The blocks were moved verbatim;
 * the factory receives the names they used from server.js, destructured back to
 * the same identifiers.
 */
'use strict';

module.exports = function sessionRoutes(deps) {
  const {
    SESSION_DIR,
    WRITE_CHUNK,
    agentStatus,
    breathe,
    crypto,
    deleteSessionRef,
    dockerCapture,
    externaliseImages,
    fs,
    imageDensity,
    indexGet,
    indexKey,
    indexPut,
    scanState,
    loadLastSession,
    path,
    readLineAt,
    scanSessions,
    sessionLines,
    sessionRef,
    sessionSize,
    sessionStamp,
    spawn,
    writeStream,
    zlib,
  } = deps;

  function match(req) {
    if (req.url.startsWith('/api/sessions')) return true;
    if (req.url.startsWith('/api/session-image')) return true;
    if (req.url.startsWith('/api/session-messages')) return true;
    if (req.url.startsWith('/api/session-file')) return true;
    if (req.url.startsWith('/api/session-delete')) return true;
    return false;
  }

  async function handle(req, res) {
  if (req.url.startsWith('/api/sessions')) {
    // `remembered` is the session this bridge means to be in. The WebUI needs it
    // to tell "the agent is in a chat I just created, whose file does not exist
    // yet" from "the bridge restarted and lost my session" - the two look
    // identical from the outside (a session path that is not in this list), and
    // guessing between them is what made a new chat jump somewhere else on a
    // quick reload.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      sessionDir: SESSION_DIR,
      remembered: loadLastSession(),
      sessions: await scanSessions(),
      // A scan that failed is reported alongside the empty list, so the sidebar
      // can say "the session directory could not be read" instead of looking
      // like an account with no sessions in it (issue #30).
      scanError: scanState.lastScanError,
      // What the agent is doing right now, so a page that reloads in the middle
      // of it (or a second tab) shows the same thing as the one that started it.
      busy: agentStatus.busy,
      compacting: agentStatus.compacting,
    }));
    return;
  }
  // Read-only transcript of a session file. Lets the WebUI browse other
  // sessions while the shared agent keeps running in its own session
  // (the live view of the running session stays in the UI's DOM cache).
  // Local session dirs only — docker dirs would need `docker exec cat`.
  /* One picture out of a session file, as image bytes.
   *
   * The transcript points here instead of carrying the base64, so this is called
   * for the pictures that are actually on screen and not for the rest. The browser
   * caches the result (the URL carries the file's size and mtime, so a session that
   * changed invalidates it), and it is a plain image response - which is also less
   * memory in the page than a data URL, since the decoded bitmap replaces the
   * base64 text rather than sitting alongside it. */
  if (req.url.startsWith('/api/session-image')) {
    const u = new URL(req.url, 'http://x');
    const p = u.searchParams.get('path') || '';
    const wantLine = parseInt(u.searchParams.get('line') || '', 10);
    const wantPart = parseInt(u.searchParams.get('part') || '0', 10);
    const ref = sessionRef(p);
    if (!ref || !Number.isFinite(wantLine) || wantLine < 1) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad path or line' }));
      return;
    }
    try {
      /* Straight to the line when the transcript has already indexed this file.
       *
       * The fallback is the old behaviour - read forward - which is O(position);
       * with the index it is one short read whatever the line. The index is built
       * by /api/session-messages, which is what drew the transcript the picture is
       * being requested for, so in the normal case it is already there. */
      /* Read the line, and say what actually went wrong when it cannot be used.
       *
       * `found` used to mean "a line was read" while a parse failure was swallowed
       * into entry = null, so every such failure came out as the same message -
       * "that image is no longer at that line" - which is a claim about the SESSION
       * being wrong rather than about the reader being wrong. That is what made
       * issue #38 read as a missing image: the line was there, the read of it was
       * broken, and the error blamed the file. */
      let entry = null;
      let read = false;               // a line was located and read
      let badJson = false;            // ... but it did not parse as one entry
      const stampNow = await sessionStamp(ref);
      const offsets = stampNow ? indexGet(indexKey(ref, stampNow)) : null;
      const at = offsets && offsets.length >= wantLine ? offsets[wantLine - 1] : null;
      if (at != null) {
        const raw = await readLineAt(ref, at);
        if (raw != null) {
          read = true;
          try { entry = JSON.parse(raw); } catch { entry = null; badJson = true; }
        }
      }
      if (!read) {
        // no index (or the file moved under it): read forward, as before
        let line = 0;
        for await (const raw of sessionLines(ref)) {
          if (++line !== wantLine) continue;
          read = true;
          try { entry = JSON.parse(raw); } catch { entry = null; badJson = true; }
          break;
        }
      }
      if (badJson) {
        // Neither the session's fault nor the picture's. Say which, so the next
        // person looks at the reader instead of hunting for a lost image.
        res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: `line ${wantLine} could not be read as one session entry` }));
        return;
      }
      const content = entry && entry.message && entry.message.content;
      const block = Array.isArray(content) ? content[wantPart] : null;
      if (!read || !block || block.type !== 'image' || typeof block.data !== 'string') {
        // Genuinely nothing to serve: a wrong line or part, or a session rewritten
        // under a URL that named a position in the old one.
        res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'that image is no longer at that line' }));
        return;
      }
      const mime = String(block.mimeType || 'image/png');
      const data = /^data:/i.test(block.data) ? block.data.slice(block.data.indexOf(',') + 1) : block.data;
      const bytes = Buffer.from(data, 'base64');
      const etag = `"${crypto.createHash('sha1').update(`${ref.path || ref.container}:${wantLine}:${wantPart}:${data.length}`).digest('hex')}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag, 'Cache-Control': 'private, max-age=31536000, immutable' });
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': bytes.length,
        ETag: etag,
        // immutable: the URL changes whenever the file does, so this can be cached
        // for as long as the browser likes and never be revalidated
        'Cache-Control': 'private, max-age=31536000, immutable',
      });
      res.end(bytes);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: `read failed: ${e.message}` }));
    }
    return;
  }

  if (req.url.startsWith('/api/session-messages')) {
    const purl = new URL(req.url, 'http://x');
    const p = purl.searchParams.get('path') || '';
    // `?inline=1` puts the picture bytes back into the response, exactly as this
    // endpoint behaved before. There is no flag for the other way round: naming
    // the pictures is the default, because it is what makes a session open in
    // under a second instead of downloading every picture ever pasted into it.
    const inlineImages = purl.searchParams.get('inline') === '1' || purl.searchParams.get('inline') === 'true';
    if (!p) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing path' }));
      return;
    }
    const ref = sessionRef(p);
    if (!ref) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'path must stay inside the session dir' }));
      return;
    }
    let gz = null;
    let w = null;
    try {
      // Both halves of that are measured, not assumed:
      //
      //  - Base64 is already high-entropy, so gzipping an image-heavy session
      //    costs seconds of CPU to save a fraction of it (1315 ms to save 17 of
      //    70 MB on a real one).
      //  - Compressing anything at all is a loss on loopback, where the transfer
      //    is free and the CPU is not. Measured on the same machine: a 21 MB
      //    session went from 275 ms to 458 ms with compression on, and a 4.5 MB
      //    one from 76 ms to 93 ms - all of it spent compressing bytes that were
      //    going to arrive in a millisecond anyway. Over the LAN the same
      //    compression is a 4x smaller transfer, which is worth far more.
      //
      // So: is the client on this machine? Is the file mostly pictures? Only then
      // is it worth a CPU core.
      //
      // Note the order, which cost a day: asking for the file's size is itself
      // work - a `docker exec stat` in container mode is ~90 ms of container
      // startup - so it happens only when the answer can change the outcome. On
      // loopback the whole question is skipped and the response starts streaming
      // immediately, which is the common case.
      const remote = String((req.socket && req.socket.remoteAddress) || '');
      const local = !remote || remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
      const wantsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
      let compress = false;
      let stamp = '';
      if (wantsGzip && !local) {
        const size = await sessionSize(ref);
        if (size > 256 * 1024) compress = (await imageDensity(ref)) < 0.35;
      }
      // the token on every image reference, so a session that changes invalidates
      // the browser's cached copies of the pictures in it
      if (!inlineImages) {
        try {
          const st = ref.kind === 'docker'
            ? String(await dockerCapture(ref.container, ['stat', '-c', '%s-%Y', ref.path], 20000) || '').trim()
            : (() => { const s = fs.statSync(ref.path); return `${s.size}-${Math.floor(s.mtimeMs)}`; })();
          stamp = st;
        } catch { /* no token: the URL still works, it is just not cache-busted */ }
      }
      if (compress) {
        gz = zlib.createGzip({ level: 1 });
        gz.on('error', () => { /* the client hung up; the socket is already gone */ });
        gz.pipe(res);
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        // no Content-Length on purpose: the length is not known until the last
        // line is parsed, and inventing one is what made this a 378 ms wait
        ...(gz ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}),
        'Cache-Control': 'no-store',
      });
      // A bigger socket buffer, so a chunked transcript is not reported "full"
      // every 16 KB - that alone turned streaming into a slow drip.
      try { res._writableState.highWaterMark = 1 << 20; } catch { /* older node */ }
      // Built AFTER the gzip decision, and pointed at whatever actually carries
      // the bytes. Writing to `res` while the header said gzip produced plain
      // JSON with a gzip label on it, which no browser can read.
      w = writeStream(gz || res);
      w.add(`{"path":${JSON.stringify(p)},"messages":[`);
      await w.flush();
      let first = true, n = 0, parent = null, line = 0, stripped = 0, saved = 0;
      const compactions = [];
      /* Record where each line starts while the file is being read anyway, so
       * /api/session-image can seek straight to one instead of reading up to it.
       * The stamp is taken unconditionally now: it is one stat, it keys the index,
       * and the picture URLs need it in the same form. */
      let stampKey = stamp;
      if (!stampKey) { try { stampKey = await sessionStamp(ref); } catch { /* no index */ } }
      const lineOffsets = [];
      const wantIndex = !!stampKey && !inlineImages;
      for await (const raw of sessionLines(ref, wantIndex ? (off) => lineOffsets.push(off) : undefined)) {
        line++;
        if (!raw.trim()) continue;
        let e; try { e = JSON.parse(raw); } catch { continue; }
        if (!e) continue;
        // The header records where a fork came from - deleting a fork can send
        // you back to its original session instead of a blank one.
        if (e.type === 'session' && e.parentSession) parent = e.parentSession;
        if (e.type === 'message' && e.message) {
          // entryId travels with the message so the UI can offer "fork from
          // here" while reading a session the agent has not loaded.
          const m = { ...e.message, timestamp: e.message.timestamp ?? e.timestamp, entryId: e.id || null };
          if (!inlineImages) {
            const r = externaliseImages(m, p, line, stamp);
            stripped += r.n; saved += r.saved;
          }
          w.add((first ? '' : ',') + JSON.stringify(m));
          first = false;
          if (w.size >= WRITE_CHUNK) await w.flush();
        } else if (e.type === 'compaction' && e.summary) {
          // Compactions are their own entry type (not messages), so they are
          // missing from get_messages - without these the "conversation
          // compacted" markers vanished as soon as the page was reloaded.
          compactions.push({
            summary: e.summary,
            tokensBefore: e.tokensBefore != null ? e.tokensBefore : null,
            estimatedTokensAfter: e.estimatedTokensAfter != null ? e.estimatedTokensAfter : null,
            id: e.id || null,
            timestamp: e.timestamp || null,
          });
        }
        // Hand the thread back every so often, and check whether anything was
        // waiting on us (the agent's stream, another request) before the next
        // batch. Without this a long read froze every socket on the bridge.
        if (++n % 250 === 0) {
          await breathe();
          if (res.writableEnded || res.destroyed) return;
        }
      }
      w.add(`],"compactions":${JSON.stringify(compactions)},"parent":${JSON.stringify(parent)}` +
        (stripped ? `,"imagesOut":${stripped},"imageBytes":${saved}` : '') + '}');
      await w.flush();
      // Only worth keeping if it lines up with what was actually written out.
      if (wantIndex && lineOffsets.length >= line) indexPut(indexKey(ref, stampKey), lineOffsets);
      if (gz) gz.end(); else res.end();
    } catch (e) {
      try { if (gz) gz.destroy(); } catch { /* already gone */ }
      if (w) { try { w.buf.length = 0; w.size = 0; } catch { /* gone */ } }
      if (res.headersSent) { try { res.end(); } catch { /* gone */ } return; }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `read failed: ${e.message}` }));
    }
    return;
  }

  // Download a session file (the sidebar's right-click -> export), and delete
  // one when the user explicitly confirms. Both are restricted to files inside
  // the configured session directory.
  if (req.url.startsWith('/api/session-file')) {
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    const raw = new URL(req.url, 'http://localhost').searchParams.get('path') || '';
    const ref = sessionRef(raw);
    if (!ref) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'session not found' })); return; }
    const name = path.basename(ref.path);
    if (ref.kind === 'docker') {
      // Streamed straight out of the container: a long session can be tens of
      // megabytes, and buffering it here only to hand it on would double it.
      res.writeHead(200, {
        'Content-Type': 'application/jsonl',
        'Content-Disposition': `attachment; filename="${name}"`,
      });
      const child = spawn('docker', ['exec', ref.container, 'cat', ref.path], { stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout.pipe(res);
      child.on('error', () => res.destroy());
      return;
    }
    const st = fs.statSync(ref.path);
    res.writeHead(200, {
      'Content-Type': 'application/jsonl',
      'Content-Length': st.size,
      'Content-Disposition': `attachment; filename="${name}"`,
    });
    fs.createReadStream(ref.path).pipe(res);
    return;
  }
  if (req.url.startsWith('/api/session-delete')) {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', async () => {
      try {
        const { path: raw } = JSON.parse(body || '{}');
        const ref = sessionRef(raw);
        if (!ref) throw new Error('session not found');
        await deleteSessionRef(ref);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: ref.path }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  }

  return { match, handle };
};
