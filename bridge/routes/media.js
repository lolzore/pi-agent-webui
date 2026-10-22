/*
 * Media and proxy routes, split out of server.js (issue #54, phase 9).
 *
 * `/api/bg-file` serves an uploaded background back to the page, and
 * `/proxy/<origin>/...` forwards a request to another instance. The blocks were
 * moved verbatim; the factory receives the names they used from server.js.
 */
'use strict';

module.exports = function mediaRoutes(deps) {
  const {
    UPLOAD_DIRS,
    fs,
    path,
    proxyHttp,
    splitProxyPath,
  } = deps;

  function match(req) {
    if (req.url.startsWith('/proxy/')) return true;
    if (req.url.startsWith('/api/bg-file')) return true;
    return false;
  }

  async function handle(req, res) {
  /* Opening the WebUI to the network is a decision people should be able to make
   * in the UI rather than by editing a JSON file next to the bridge. Reading and
   * writing the same file the startup banner reads keeps one source of truth, and
   * the server rebinds live, so no restart is needed. */
  if (req.url.startsWith('/proxy/')) {
    const parsed = splitProxyPath(req.url);
    if (!parsed) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not a configured instance' }));
      return;
    }
    proxyHttp(req, res, parsed.base, parsed.path);
    return;
  }

  // Serve a previously uploaded file back to the browser. Used for background
  // images / GIFs / videos, which would otherwise blow the localStorage quota
  // as data URLs. Only files inside an uploads dir are reachable (basename-only,
  // no traversal).
  if (req.url.startsWith('/api/bg-file')) {
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    try {
      const raw = new URL(req.url, 'http://localhost').searchParams.get('name') || '';
      const name = path.basename(decodeURIComponent(raw));
      let file = null;
      for (const dir of UPLOAD_DIRS) {
        const cand = path.join(dir, name);
        if (name && cand.startsWith(dir + path.sep) && fs.existsSync(cand)) { file = cand; break; }
      }
      if (!file) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      const types = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
        '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
        '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v',
        '.ogv': 'video/ogg', '.mkv': 'video/x-matroska',
        // Audio: the "when the agent finishes" sound the user picked. Without a
        // correct type the browser downloads it and then refuses to decode it,
        // which shows up as a notification that silently never plays. (.webm is
        // listed once, as video: it is both, and video is what this app plays
        // far more of - an audio/webm response still decodes as audio.)
        '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
        '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.opus': 'audio/opus',
        '.weba': 'audio/webm',
        '.cur': 'image/x-icon', '.ico': 'image/x-icon',
      };
      const st = fs.statSync(file);
      const type = types[path.extname(file).toLowerCase()] || 'application/octet-stream';
      const headers = {
        'Content-Type': type,
        // Videos have to be advertised as seekable: a player cannot position
        // itself in a file the server will only send from the start, and the
        // animated avatars are kept on a shared frame by seeking them.
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=86400',
      };
      // Range requests, so one download can feed several elements (ten animated
      // avatars of the same clip used to open ten full downloads, and the ones
      // that did not fit the connection limit stalled).
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(String(range));
        let start = m && m[1] ? Number(m[1]) : 0;
        let end = m && m[2] ? Number(m[2]) : st.size - 1;
        if (!Number.isFinite(start) || start < 0) start = 0;
        if (!Number.isFinite(end) || end >= st.size) end = st.size - 1;
        if (start > end || start >= st.size) {
          res.writeHead(416, { ...headers, 'Content-Range': `bytes */${st.size}` });
          res.end();
          return;
        }
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
        fs.createReadStream(file, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, { ...headers, 'Content-Length': st.size });
      fs.createReadStream(file).pipe(res);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad request' }));
    }
    return;
  }
  }

  return { match, handle };
};
