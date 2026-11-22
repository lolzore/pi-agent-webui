/*
 * Petdex library for the Fun desk pet.
 *
 * Search is proxied through the bridge because petdex.dev does not send CORS
 * headers on its JSON API. The spritesheet itself is downloaded and kept in
 * <agent dir>/pets, so a pet continues to work offline and survives a reload.
 * Only the small set of fields the picker needs is exposed; no account or
 * remote code is involved.
 */
'use strict';

const path = require('path');

module.exports = function petRoutes(deps) {
  const { fs, jsonOut, PI_AGENT_DIR } = deps;
  const DIR = path.join(PI_AGENT_DIR, 'pets');
  const PETDEX_BASE = (process.env.PI_PETDEX_BASE || 'https://petdex.dev').replace(/\/+$/, '');
  const MAX_SPRITE = 24 * 1024 * 1024;
  const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

  const readJson = (file, fallback = null) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
  };
  const writeJson = (file, value) => {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
  };
  const metaFile = (slug) => path.join(DIR, `${slug}.json`);
  const spriteFile = (slug, ext = 'webp') => path.join(DIR, `${slug}.${ext}`);

  function listPets() {
    let names = [];
    try { names = fs.readdirSync(DIR).filter((n) => n.endsWith('.json')); } catch { return []; }
    const pets = [];
    for (const name of names) {
      const slug = name.slice(0, -5);
      if (!SLUG_RE.test(slug)) continue;
      const meta = readJson(path.join(DIR, name));
      if (!meta || !meta.slug) continue;
      const file = path.join(DIR, meta.fileName || '');
      if (!file.startsWith(DIR + path.sep) || !fs.existsSync(file)) continue;
      pets.push({
        slug,
        name: String(meta.name || slug),
        description: String(meta.description || ''),
        spriteVersionNumber: meta.spriteVersionNumber === 2 ? 2 : 1,
        url: `/api/pet-file?name=${encodeURIComponent(path.basename(file))}`,
        downloadedAt: meta.downloadedAt || null,
      });
    }
    pets.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return pets;
  }

  function readBody(req, limit = 64 * 1024) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > limit) { req.destroy(); reject(new Error('request too large')); } });
      req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('invalid JSON')); } });
      req.on('error', reject);
    });
  }

  async function fetchWithTimeout(url, options = {}, ms = 15000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try { return await fetch(url, { ...options, signal: ctrl.signal }); }
    finally { clearTimeout(timer); }
  }

  async function search(query) {
    const url = new URL(`${PETDEX_BASE}/api/pets/search`);
    url.searchParams.set('q', query || '');
    url.searchParams.set('limit', '24');
    url.searchParams.set('sort', 'popular');
    const r = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`Petdex search returned HTTP ${r.status}`);
    const d = await r.json();
    const pets = Array.isArray(d.pets) ? d.pets : [];
    return pets.map((p) => ({
      slug: String(p.slug || ''),
      displayName: String(p.displayName || p.slug || ''),
      description: String(p.description || ''),
      spritesheetPath: String(p.spritesheetPath || ''),
      spriteVersionNumber: p.spriteVersionNumber === 2 ? 2 : 1,
      kind: p.kind || null,
      vibes: Array.isArray(p.vibes) ? p.vibes.slice(0, 8) : [],
    })).filter((p) => p.slug && p.displayName && p.spritesheetPath);
  }

  function allowedSprite(url) {
    let u;
    try { u = new URL(url); } catch { return false; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const base = new URL(PETDEX_BASE).hostname;
    return u.hostname === base || u.hostname === 'assets.petdex.dev' || u.hostname.endsWith('.petdex.dev');
  }

  async function download(body) {
    const slug = String(body.slug || '').trim();
    const source = String(body.spritesheetPath || '').trim();
    if (!SLUG_RE.test(slug)) throw new Error('invalid pet id');
    if (!allowedSprite(source)) throw new Error('spritesheet is not on a Petdex asset host');
    const r = await fetchWithTimeout(source, { headers: { Accept: 'image/webp,image/png,image/*' } }, 30000);
    if (!r.ok) throw new Error(`spritesheet returned HTTP ${r.status}`);
    const type = String(r.headers.get('content-type') || '').toLowerCase();
    const bytes = Buffer.from(await r.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_SPRITE) throw new Error('spritesheet is empty or too large');
    const isWebp = bytes.length > 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    const isPng = bytes.length > 8 && bytes.toString('hex', 0, 8) === '89504e470d0a1a0a';
    if (!isWebp && !isPng) throw new Error('spritesheet is not a WebP or PNG image');
    const ext = isPng ? 'png' : 'webp';
    fs.mkdirSync(DIR, { recursive: true });
    const file = spriteFile(slug, ext);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, file);
    // Remove the other format if a previous copy was PNG/WebP.
    const other = spriteFile(slug, ext === 'png' ? 'webp' : 'png');
    if (other !== file) { try { fs.rmSync(other, { force: true }); } catch { /* absent */ } }
    const meta = {
      slug,
      name: String(body.displayName || slug),
      description: String(body.description || ''),
      spriteVersionNumber: body.spriteVersionNumber === 2 ? 2 : 1,
      fileName: path.basename(file),
      downloadedAt: new Date().toISOString(),
    };
    writeJson(metaFile(slug), meta);
    return listPets().find((p) => p.slug === slug) || null;
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const only = url.pathname;

    if (only === '/api/pets' && req.method === 'GET') {
      jsonOut(res, 200, { ok: true, pets: listPets() });
      return;
    }
    if (only === '/api/petdex-search' && req.method === 'GET') {
      try {
        const pets = await search(url.searchParams.get('q') || '');
        jsonOut(res, 200, { ok: true, pets });
      } catch (e) {
        jsonOut(res, 502, { ok: false, error: e.message });
      }
      return;
    }
    if (only === '/api/pets/download' && req.method === 'POST') {
      try {
        const pet = await download(await readBody(req));
        jsonOut(res, 200, { ok: true, pet });
      } catch (e) {
        jsonOut(res, 400, { ok: false, error: e.message });
      }
      return;
    }
    if (only === '/api/pet-file' && req.method === 'GET') {
      const name = url.searchParams.get('name') || '';
      if (!/^[a-z0-9][a-z0-9-]*\.(webp|png)$/.test(name)) { jsonOut(res, 400, { error: 'invalid pet file' }); return; }
      const file = path.join(DIR, name);
      if (!file.startsWith(DIR + path.sep) || !fs.existsSync(file)) { jsonOut(res, 404, { error: 'pet file not found' }); return; }
      const ext = path.extname(name).toLowerCase();
      res.writeHead(200, {
        'Content-Type': ext === '.png' ? 'image/png' : 'image/webp',
        'Cache-Control': 'public, max-age=3600',
      });
      fs.createReadStream(file).pipe(res);
      return;
    }
    jsonOut(res, 404, { error: 'not found' });
  }

  return {
    match: (req) => req.url.startsWith('/api/pets')
      || req.url.startsWith('/api/petdex-search')
      || req.url.startsWith('/api/pet-file'),
    handle,
  };
};
