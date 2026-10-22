/*
 * The llama.cpp routes: /api/llama-models and /api/llama-config. Split out of
 * server.js (issue #54, phase 11).
 */
'use strict';

module.exports = function llamaRoutes(deps) {
  const {
    PI_SETTINGS_FILE,
    fetchLlamaModels,
    fs,
    isLocalLlamaAddress,
    llamaConfiguredUrls,
    llamaLan,
    llamaLanUrls,
    llamaModelsCache,
    llamaServerCandidates,
    llamaServerIdentity,
    path,
    readLlamaServerUrl,
  } = deps;

  function match(req) {
    if (req.url.startsWith('/api/llama-models')) return true;
    if (req.url.startsWith('/api/llama-config')) return true;
    return false;
  }

  async function handle(req, res) {

  // llama.cpp: list every model each reachable server knows about. The
  // providerId matches what the pi-llama-cpp extension registers
  // ("llama-server=<baseUrl>"), so the WebUI can set_model directly.
  if (req.url.startsWith('/api/llama-models')) {
    /* 5s cache when a server answered: the UI probes on connect, on focus and
     * after a settings change, and the server may be busy.
     *
     * An *empty* answer is cached much longer (issue #106). Each probe waits
     * out the unreachable servers' timeouts (0.8-1.4s on a machine with a dead
     * configured server), and the providers tab used to retry on top of that -
     * so opening Settings looked like it was loading for seconds. `?fresh=1`
     * is the explicit "ask again now": the providers tab and its bounded
     * retries use it, everything else takes the cache. */
    const fresh = new URL(req.url, 'http://x').searchParams.get('fresh') === '1';
    const ttl = llamaModelsCache.data && llamaModelsCache.data.servers.length ? 5000 : 15000;
    if (!fresh && llamaModelsCache.data && Date.now() - llamaModelsCache.at < ttl) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(llamaModelsCache.data));
      return;
    }
    const candidates = [...llamaServerCandidates(), ...llamaLanUrls()];
    const unique = [...new Set(candidates)];
    const configured = readLlamaServerUrl();
    const rank = (u) => (configured && u === configured ? 0
      : /\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(u) ? 1 : 2);
    const answered = (await Promise.all(unique.map(async (url, i) => {
      const models = await fetchLlamaModels(url);
      if (!models || !models.length) return null;
      return { url, i, models, key: await llamaServerIdentity(url) };
    }))).filter(Boolean);
    // best address first, so the entry that survives dedupe is the one worth using
    answered.sort((a, b) => rank(a.url) - rank(b.url) || a.i - b.i);
    const byKey = new Map();
    const servers = [];
    for (const s of answered) {
      let key = s.key || 'models:' + s.models.map((m) => m.id).sort().join(',');
      // a second machine stays its own entry even when it serves the same file
      if (!isLocalLlamaAddress(s.url)) {
        try { key += '|host:' + new URL(s.url).host.toLowerCase(); } catch (e) { key += '|host:' + s.url; }
      }
      const seen = byKey.get(key);
      if (seen) { seen.alsoAt.push(s.url); continue; }
      const entry = { url: s.url, providerId: `llama-server=${s.url}`, models: s.models, alsoAt: [] };
      byKey.set(key, entry);
      servers.push(entry);
    }
    const payload = { servers, scanning: llamaLan.scanning };
    llamaModelsCache.at = Date.now();
    llamaModelsCache.data = payload;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
    return;
  }

  // Read / write the llamaServerUrl in pi's global settings (~/.pi/agent/settings.json).
  // pi-llama-cpp resolves this URL at agent startup, so after a change the agent
  // must be restarted (the UI sends {bridge:'restart'}) for it to take effect.
  if (req.url.startsWith('/api/llama-config')) {
    if (req.method === 'GET') {
      let url = null;
      let urls = [];
      try {
        const st = JSON.parse(fs.readFileSync(PI_SETTINGS_FILE, 'utf8'));
        urls = llamaConfiguredUrls(st);
        url = urls[0] || null;
      } catch { /* no file */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // LLAMA_SERVER_URL overrides the configured list in the extension, so the UI
      // has to say so - otherwise "point pi at both" looks like it did nothing.
      res.end(JSON.stringify({ url, urls, envOverride: String(process.env.LLAMA_SERVER_URL || '').trim() || null }));
      return;
    }
    if (req.method === 'POST') {
      let body0 = '';
      req.on('data', (c) => { body0 += c; if (body0.length > 64 * 1024) req.destroy(); });
      req.on('end', () => {
        try {
          const body = JSON.parse(body0 || '{}');
          // `urls` (a list) is the extension's recommended form and registers every
          // server at once; `url` is the older single-value spelling.
          const wanted = Array.isArray(body.urls) ? body.urls : (body.url != null ? [body.url] : []);
          if (!wanted.length) throw new Error('send url or urls');
          const clean = [];
          for (const raw of wanted) {
            if (typeof raw !== 'string' || !/^https?:\/\//i.test(raw.trim())) {
              throw new Error(`"${String(raw).slice(0, 60)}" is not an http(s) base URL`);
            }
            const u = raw.trim().replace(/\/+$/, '');
            if (!clean.includes(u)) clean.push(u);
          }
          if (clean.length > 16) throw new Error('at most 16 servers');
          let settings = {};
          try { settings = JSON.parse(fs.readFileSync(PI_SETTINGS_FILE, 'utf8')); } catch { /* defaults */ }
          const previous = llamaConfiguredUrls(settings);
          // pi-llama-cpp currently resolves llamaServerUrl at startup, and its
          // documented multi-server format is semicolon-separated URLs. The
          // llamaSettings.servers list is kept for newer versions of the
          // extension, but on its own it is ignored by the installed version —
          // which made the UI say it had pointed pi at the LAN server while pi
          // continued registering only 127.0.0.1.
          settings.llamaServerUrl = clean.join(';');
          settings.llamaSettings = Object.assign({}, settings.llamaSettings, {
            servers: clean.map((url) => ({ url })),
          });
          fs.mkdirSync(path.dirname(PI_SETTINGS_FILE), { recursive: true });
          fs.writeFileSync(PI_SETTINGS_FILE, JSON.stringify(settings, null, 2));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, previous, urls: clean, format: 'semicolon-separated llamaServerUrl' }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    res.writeHead(405).end();
    return;
  }
  }

  return { match, handle };
};
