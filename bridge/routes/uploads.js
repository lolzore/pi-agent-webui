/*
 * Uploads, split out of server.js as bridge/routes/uploads.js (issue #54).
 *
 * /api/upload (base64 JSON, small files), /api/upload-raw (the body is the
 * file) and /api/upload-file (serve an uploaded file back to the page, with
 * Range). The routes were moved verbatim; the factory receives the names they
 * used from server.js, destructured back to the same identifiers.
 */
'use strict';

const { spawnSync } = require('child_process');

const VIDEO_EXT = new Set(['.mp4', '.m4v', '.webm', '.mov', '.ogv', '.mkv']);

const UPLOAD_MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.ogv': 'video/ogg', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8',
};

module.exports = function uploadRoutes(deps) {
  const {
    UPLOAD_DIRS,
    crypto,
    fs,
    http,
    path,
  } = deps;

  /* ── frames from a video (issue #72) ──────────────────────────────────
   * pi has no video content block, so the only way a vision model can see an
   * uploaded video is as pictures. On upload the bridge takes a handful of
   * evenly spaced frames with ffmpeg and hands them back with the file; the
   * page sends them as image content next to the video's path. ffmpeg is
   * optional infrastructure here: when it is missing the upload still
   * succeeds and says so, and the model gets the path only.
   *
   * PI_WEBUI_FFMPEG overrides the binary; "off"/"none"/empty disables the
   * extraction (the tests use it to drive both paths deterministically). */
  const FFMPEG_SETTING = process.env.PI_WEBUI_FFMPEG === undefined ? 'ffmpeg' : String(process.env.PI_WEBUI_FFMPEG).trim();
  const FFMPEG_OFF = FFMPEG_SETTING === '' || /^(off|none|0|false)$/i.test(FFMPEG_SETTING);
  const FFMPEG_BIN = FFMPEG_SETTING || 'ffmpeg';
  let ffmpegChecked = null;
  const ffmpegAvailable = () => {
    if (FFMPEG_OFF) return false;
    if (ffmpegChecked !== null) return ffmpegChecked;
    try {
      const r = spawnSync(FFMPEG_BIN, ['-version'], { timeout: 5000, stdio: 'ignore' });
      ffmpegChecked = !r.error && r.status === 0;
    } catch { ffmpegChecked = false; }
    return ffmpegChecked;
  };

  const probeDuration = (file) => {
    const probe = /[\\/]/.test(FFMPEG_BIN) ? path.join(path.dirname(FFMPEG_BIN), 'ffprobe') : 'ffprobe';
    try {
      const r = spawnSync(probe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { timeout: 15000, encoding: 'utf8' });
      const n = parseFloat(String(r.stdout || '').trim());
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch { return null; }
  };

  const isVideo = (file, mimeType) => /^video\//i.test(mimeType || '') || VIDEO_EXT.has(path.extname(file).toLowerCase());

  /* null for a non-video; otherwise {frames, frameNote}. Never throws - an
   * upload must not fail because ffmpeg did. */
  function extractVideoFrames(file, mimeType) {
    if (!isVideo(file, mimeType)) return null;
    if (FFMPEG_OFF) {
      return { frames: [], frameNote: 'video frames are switched off on this bridge - the model gets the path, not pictures from it' };
    }
    if (!ffmpegAvailable()) {
      return { frames: [], frameNote: 'ffmpeg is not installed on this bridge - the model gets the video\'s path, not pictures from it' };
    }
    let outDir = file + '.frames';
    try {
      const duration = probeDuration(file);
      const count = duration ? Math.max(3, Math.min(6, Math.round(duration / 5))) : 4;
      const fps = duration ? count / duration : 1;
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.mkdirSync(outDir, { recursive: true });
      const r = spawnSync(FFMPEG_BIN, [
        '-v', 'error', '-i', file,
        '-vf', `fps=${fps.toFixed(4)},scale=768:-2`,
        '-frames:v', String(count), '-q:v', '3',
        path.join(outDir, 'f%02d.jpg'),
      ], { timeout: 120000, maxBuffer: 1 << 20 });
      if (r.error || r.status !== 0) {
        const why = String((r.stderr || '') + (r.error ? r.error.message : '')).trim().split('\n').pop() || 'ffmpeg failed';
        return { frames: [], frameNote: 'could not read frames from this video (' + why.slice(0, 200) + ')' };
      }
      const names = fs.readdirSync(outDir).filter((n) => /\.jpe?g$/i.test(n)).sort();
      const frames = [];
      let total = 0;
      for (const n of names) {
        const full = path.join(outDir, n);
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        if (total + st.size > 3 * 1024 * 1024) break;
        total += st.size;
        frames.push({ name: n, mimeType: 'image/jpeg', size: st.size, data: fs.readFileSync(full).toString('base64') });
      }
      if (!frames.length) return { frames: [], frameNote: 'ffmpeg produced no frames from this video' };
      return { frames, frameNote: null };
    } catch (e) {
      return { frames: [], frameNote: 'could not read frames from this video (' + e.message + ')' };
    }
  }

  /* The upload response, plus what the model will be able to see of it. */
  function withFrames(payload, file, mimeType) {
    try {
      const got = extractVideoFrames(file, mimeType);
      if (got) {
        payload.frames = got.frames;
        if (got.frameNote) payload.frameNote = got.frameNote;
      }
    } catch (e) {
      payload.frameNote = 'could not read frames from this video (' + e.message + ')';
    }
    return payload;
  }



  function match(req) {
    return req.url === '/api/upload' || req.url.startsWith('/api/upload?')
      || req.url.startsWith('/api/upload-raw') || req.url.startsWith('/api/upload-file');
  }

  function handle(req, res) {
  // Exact route: "/api/upload-raw" also starts with "/api/upload", and reading a
  // raw body as JSON gave "Unexpected token '\0'" on the first big upload.
  if (req.url.startsWith('/api/upload?') || req.url === '/api/upload') {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let body = '';
    const MAX = 256 * 1024 * 1024; // base64 of ~190 MB
    req.on('data', (c) => { body += c; if (body.length > MAX) { req.destroy(); } });
    req.on('end', () => {
      try {
        const { name, data, mimeType } = JSON.parse(body || '{}');
        if (typeof name !== 'string' || !name) throw new Error('name is required');
        if (typeof data !== 'string' || !data) throw new Error('data (base64) is required');
        const safe = name.replace(/[^\w.\- ()\[\]]/g, '_').slice(0, 120);
        const buf = Buffer.from(data, 'base64');
        const dir = UPLOAD_DIRS[0];
        fs.mkdirSync(dir, { recursive: true });
        // The same bytes are the same file: uploading the same screenshots again
        // (the usual way this happens) used to write another copy next to the
        // first one, with a new timestamp and the same content. The hash index
        // lives in the upload directory so it survives a bridge restart.
        const hash = crypto.createHash('sha256').update(buf).digest('hex');
        const indexFile = path.join(dir, '.uploads-by-hash.json');
        let index = {};
        try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')) || {}; } catch { /* first run */ }
        const known = index[hash];
        if (known) {
          try {
            const st = fs.statSync(known);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(withFrames({ ok: true, path: known, size: st.size, mimeType: mimeType || null, duplicate: true }, known, mimeType || '')));
            return;
          } catch { delete index[hash]; }   // the file was removed by hand
        }
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const file = path.join(dir, `${stamp}-${safe}`);
        fs.writeFileSync(file, buf);
        index[hash] = file;
        try { fs.writeFileSync(indexFile, JSON.stringify(index)); } catch { /* index is a nicety */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(withFrames({ ok: true, path: file, size: buf.length, mimeType: mimeType || null }, file, mimeType || '')));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  /* Upload without base64: the file *is* the body, so a 300 MB background video
   * costs 300 MB instead of 400 and never hits a JSON body cap. The base64 route
   * above stays for the small stuff (and for old pages). */
  if (req.url.startsWith('/api/upload-raw')) {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    const q = new URL(req.url, 'http://x').searchParams;
    const rawName = String(q.get('name') || 'file');
    const safe = rawName.replace(/[^\w.\- ()\[\]]/g, '_').slice(0, 120);
    const dir = UPLOAD_DIRS[0];
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
    const tmp = path.join(dir, `.incoming-${process.pid}-${Date.now()}`);
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(tmp);
    const MAX_RAW = Number(process.env.PI_WEBUI_MAX_UPLOAD || 4 * 1024 * 1024 * 1024);
    let got = 0;
    let failed = null;
    const cleanup = () => { try { fs.rmSync(tmp, { force: true }); } catch { /* gone */ } };
    req.on('data', (c) => {
      got += c.length;
      if (got > MAX_RAW) { failed = `file is larger than the ${Math.round(MAX_RAW / 1073741824)} GB upload limit`; req.destroy(); return; }
      hash.update(c);
    });
    req.on('error', () => { cleanup(); });
    out.on('error', (e) => { failed = e.message; cleanup(); });
    req.pipe(out);
    out.on('finish', () => {
      if (failed) {
        if (!res.headersSent) { res.writeHead(failed.indexOf('larger') === 0 ? 413 : 500, { 'Content-Type': 'application/json' }); }
        res.end(JSON.stringify({ error: failed }));
        return;
      }
      try {
        const digest = hash.digest('hex');
        const indexFile = path.join(dir, '.uploads-by-hash.json');
        let index = {};
        try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')) || {}; } catch { /* first run */ }
        const known = index[digest];
        if (known) {
          try {
            const st = fs.statSync(known);
            cleanup();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(withFrames({ ok: true, path: known, size: st.size, duplicate: true }, known, '')));
            return;
          } catch { delete index[digest]; }
        }
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const file = path.join(dir, `${stamp}-${safe}`);
        fs.renameSync(tmp, file);
        index[digest] = file;
        try { fs.writeFileSync(indexFile, JSON.stringify(index)); } catch { /* index is a nicety */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(withFrames({ ok: true, path: file, size: got }, file, '')));
      } catch (e) {
        cleanup();
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  /* Serve an uploaded file back to the page (issue #62). The agent already reads
   * these files from disk; the page could not show them at all, so an uploaded
   * video was a filename and a ▶. Only files *inside* the upload directories are
   * reachable, checked on the realpath so a symlink cannot point out of them,
   * and Range is honoured because a <video> seeks with it. */
  if (req.url.startsWith('/api/upload-file')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    const q = new URL(req.url, 'http://x').searchParams;
    let real = null;
    try { real = fs.realpathSync(String(q.get('path') || '')); } catch { /* missing */ }
    const insideUploads = (dir) => {
      try {
        const realDir = fs.realpathSync(dir);
        return real === realDir || String(real).startsWith(realDir + path.sep);
      } catch { return false; }
    };
    if (!real || !UPLOAD_DIRS.some(insideUploads)) {
      res.writeHead(real ? 403 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not an uploaded file' }));
      return;
    }
    let st = null;
    try { st = fs.statSync(real); } catch { /* gone */ }
    if (!st || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'no such file' }));
      return;
    }
    res.setHeader('Content-Type', UPLOAD_MIME[path.extname(real).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    // A single range, which is all a media element sends.
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
    let start = 0, end = st.size - 1, partial = false;
    if (m && (m[1] || m[2])) {
      start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2]));
      end = m[1] && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start >= st.size || end < start) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        res.end();
        return;
      }
      partial = true;
    }
    if (partial) res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    else res.writeHead(200, { 'Content-Length': st.size });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(real, { start, end }).pipe(res);
    return;
  }
  }

  return { match, handle };
};
