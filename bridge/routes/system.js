/*
 * System fonts: the installed-font enumeration (Windows registry / fontconfig)
 * and the /api/system-fonts route that feeds the font picker. Split out of
 * server.js (issue #54, phase 11).
 */
'use strict';

module.exports = function systemRoutes(deps) {
  const {
    execFile,
    fs,
    path,
  } = deps;

  /* Cached for five minutes. This lives in the factory, not in handle(): the
   * handler is called once per request, so a cache declared there was a new
   * object every time and never hit (the Windows registry query is the slow
   * path this comment used to promise to avoid). */
  const fontsCache = { list: null, at: 0 }; // GET /api/system-fonts cache

  /* Decode a UTF-16 name-table string. Node has no utf16be decoder, and in
   * practice name records are found in both byte orders, so try both and pick
   * the one that yields printable text (a wrong order turns ASCII into
   * characters with a zero low byte). */
  function decodeUtf16Name(raw) {
    const be = [], le = [];
    for (let i = 0; i + 1 < raw.length; i += 2) {
      be.push((raw[i] << 8) | raw[i + 1]);
      le.push((raw[i + 1] << 8) | raw[i]);
    }
    const bad = (arr) => arr.filter((c) => c === 0 || (c >= 0x100 && (c & 0xff) === 0)).length;
    const codes = bad(be) <= bad(le) ? be : le;
    return codes.map((c) => String.fromCharCode(c)).join('');
  }

  /* Read the family name (nameID 1) from a TTF/OTF buffer. This is the name
   * CSS font-family actually matches against, and it can differ from the
   * Windows font-registry label — e.g. a font registered as
   * "RWBY-Z-Regular (TrueType)" has family "RWBY-Z", so using the label makes
   * the browser silently fall back to sans-serif. Returns null for WOFF/TTC
   * collections or malformed files. */
  function ttfFamilyName(buf) {
    try {
      if (!buf || buf.length < 12) return null;
      const version = buf.readUInt32BE(0);
      // 0x00010000 = TTF, 'true' = legacy TTF, 'OTTO' = CFF/OTF; WOFF/TTC differ.
      if (version !== 0x00010000 && version !== 0x74727565 && version !== 0x4f54544f) return null;
      const numTables = buf.readUInt16BE(4);
      let off = 12;
      for (let i = 0; i < numTables; i++) {
        const tag = buf.toString('ascii', off, off + 4);
        const tOff = buf.readUInt32BE(off + 8);
        off += 16;
        if (tag !== 'name') continue;
        const count = buf.readUInt16BE(tOff + 2);
        const strBase = tOff + buf.readUInt16BE(tOff + 4);
        const candidates = [];
        for (let j = 0; j < count; j++) {
          const r = tOff + 6 + j * 12;
          const pid = buf.readUInt16BE(r);
          const nid = buf.readUInt16BE(r + 6);
          const len = buf.readUInt16BE(r + 8);
          const sOff = buf.readUInt16BE(r + 10);
          if (nid !== 1 || len < 2 || len % 2) continue;
          const raw = buf.subarray(strBase + sOff, strBase + sOff + len);
          const text = decodeUtf16Name(raw).trim();
          if (text) candidates.push({ pid, text });
        }
        // Prefer the Windows (pid 3) record, then Unicode (1), then whatever came first.
        const pick = candidates.find((c) => c.pid === 3)
          || candidates.find((c) => c.pid === 1)
          || candidates[0];
        return pick ? pick.text : null;
      }
    } catch { /* malformed */ }
    return null;
  }

  function addFamily(families, fam) {
    if (!fam) return;
    const value = String(fam).trim();
    if (!value || /\.(ttf|otf|ttc|woff2?)$/i.test(value)) return;
    families.add(value);
  }

  // Prefer the family name from the font file's own name table (what the
  // browser matches on); fall back to the registry/file label.
  function familyOf(families, file, fallback) {
    let fam = null;
    if (file) {
      try {
        if (fs.statSync(file).size < 10 * 1024 * 1024) fam = ttfFamilyName(fs.readFileSync(file));
      } catch { /* unreadable */ }
    }
    addFamily(families, fam || fallback);
  }

  /* Scan a font directory tree. Used as the fallback on POSIX and on Windows
   * when the registry answers nothing. Depth-limited so a symlink loop cannot
   * hang the request. */
  function readFontDir(families, dir, depth) {
    if (!dir || (depth || 0) > 5) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        readFontDir(families, full, (depth || 0) + 1);
        continue;
      }
      if (!/\.(ttf|otf|ttc|woff2?)$/i.test(ent.name)) continue;
      familyOf(families, full, ent.name.replace(/\.[^.]+$/, ''));
    }
  }

  async function windowsFamilies(families) {
    const windowsFonts = path.win32.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
    const userFonts = path.win32.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows', 'Fonts');
    const regKey = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts';
    const regUser = 'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts';
    for (const key of [regKey, regUser]) {
      try {
        const out = await new Promise((resolve, reject) => {
          execFile('reg', ['query', key], { timeout: 8000 }, (e, stdout) => e ? reject(e) : resolve(stdout || ''));
        });
        for (const line of out.split('\n')) {
          const m = line.trim().match(/^(.+?)\s+REG_SZ\s+(.+)$/);
          if (!m) continue;
          const label = m[1], val = m[2];
          if (val.includes(',')) {
            // Standard layout (machine fonts): key = file name, value =
            // "Family, version".
            familyOf(families, path.win32.join(windowsFonts, label), val.split(',')[0].trim());
          } else if (/\.(ttf|otf|ttc|woff2?)$/i.test(val)) {
            // Reversed layout (user fonts): key = "Label (TrueType)",
            // value = full file path.
            familyOf(families, val.trim(), label.replace(/\s*\([^)]*\)\s*$/i, '').trim());
          }
        }
      } catch { /* registry unavailable / no user fonts */ }
    }
    if (!families.size) {
      for (const dir of [windowsFonts, userFonts]) readFontDir(families, dir, 0);
    }
  }

  /* POSIX: fontconfig is the authority on what the browser can actually match.
   * The old code only knew the Windows registry and C:\Windows\Fonts, so on
   * Linux and macOS the font picker was empty even with hundreds of installed
   * families. fc-list is optional (a minimal container may not have it), so
   * fall back to the usual font directories afterwards. */
  async function posixFamilies(families) {
    try {
      const out = await new Promise((resolve, reject) => {
        execFile('fc-list', ['--format', '%{family[0]}\n'], { timeout: 8000, maxBuffer: 8 * 1024 * 1024 },
          (e, stdout) => e ? reject(e) : resolve(stdout || ''));
      });
      for (const line of out.split('\n')) addFamily(families, line);
    } catch { /* fontconfig not installed: scan dirs below */ }
    if (families.size) return;

    const home = process.env.HOME || '';
    const data = process.env.XDG_DATA_HOME || (home ? path.join(home, '.local', 'share') : '');
    const dirs = [
      '/usr/share/fonts',
      '/usr/local/share/fonts',
      data && path.join(data, 'fonts'),
      home && path.join(home, '.fonts'),
      '/Library/Fonts',
      '/System/Library/Fonts',
      '/System/Library/Fonts/Supplemental',
      home && path.join(home, 'Library', 'Fonts'),
    ];
    for (const dir of dirs) readFontDir(families, dir, 0);
    // A minimal image (the Docker image has no fontconfig or font packages)
    // would otherwise offer nothing at all. Generic CSS families are valid
    // choices everywhere and let the picker still be used there.
    if (!families.size) {
      for (const generic of ['system-ui', 'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy']) {
        addFamily(families, generic);
      }
    }
  }

  async function collectFonts() {
    const families = new Set();
    if (process.platform === 'win32') await windowsFamilies(families);
    else await posixFamilies(families);
    return [...families].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }

  function match(req) {
    if (req.url.startsWith('/api/system-fonts')) return true;
    return false;
  }

  async function handle(req, res) {
    // Installed system fonts (Windows: font registry; POSIX: fontconfig/dirs).
    if (req.url.startsWith('/api/system-fonts')) {
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      const now = Date.now();
      if (fontsCache.list && now - fontsCache.at < 5 * 60 * 1000) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(fontsCache.list));
        return;
      }
      try {
        const fonts = await collectFonts();
        fontsCache.list = { at: now, fonts };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(fontsCache.list));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
  }

  return { match, handle };
};
