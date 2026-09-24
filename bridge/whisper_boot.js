/*
 * Provision a local whisper.cpp server for speech-to-text - on request only.
 *
 * Nothing is downloaded until the UI asks for it (the Whisper backend is not
 * the default), because the binaries are ~200 MB and a model on top of that.
 * Once asked: reuse whatever listens on WHISPER_PORT, otherwise fetch the
 * whisper.cpp Windows binaries and the requested ggml model into bridge/whisper/
 * and start the server. Failures are non-fatal - the browser's own speech
 * recognition stays available.
 *
 * Env: WHISPER_PORT (8081), WHISPER_MODEL (default model id), AUTO_WHISPER=1 to
 * start it on boot anyway.
 */
'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn, execFile, execSync } = require('child_process');

const WHISPER_PORT = process.env.WHISPER_PORT || '8081';

/* The models offered in the UI. Sizes are the ggml .bin downloads; the notes
 * are what actually matters when choosing (accuracy vs speed vs machine). */
const WHISPER_MODELS = [
  { id: 'ggml-tiny.en.bin', label: 'Tiny (English)', size: '75 MB',
    note: 'Fastest, and only understandable for clear English.' },
  { id: 'ggml-base.en.bin', label: 'Base (English)', size: '142 MB',
    note: 'The default: quick and decent for English dictation.' },
  { id: 'ggml-small.en.bin', label: 'Small (English)', size: '466 MB',
    note: 'Noticeably better English accuracy, still quick.' },
  { id: 'ggml-large-v3-turbo.bin', label: 'Large v3 Turbo (multilingual)', size: '1.6 GB',
    note: 'Nearly Large-v3 accuracy for a fraction of the size and time - the better multilingual pick on most machines.' },
  { id: 'ggml-large-v3.bin', label: 'Large v3 (multilingual)', size: '3.1 GB',
    note: 'The biggest multilingual model: best accuracy for any language, needs about 4 GB of memory and a long first download.' }
];
const DEFAULT_MODEL = process.env.WHISPER_MODEL || 'ggml-base.en.bin';
const VENDOR_DIR = path.join(__dirname, 'whisper');
// Note: whisper.cpp's semantic-version releases ship source only; the Windows
// binaries are attached to the tagged nightly builds (b5130 etc.).
const BIN_ZIP_URL = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-x64.zip';

/* Everything this module downloads is checked against a published SHA-256 before
 * it is used, and a download that does not match is deleted instead of run. The
 * whisper server it starts is a native binary and the models are picked up from
 * the public internet, so "it came from the right host" is not good enough.
 *
 * Sources:
 *  - the models: the LFS metadata of huggingface.co/ggerganov/whisper.cpp
 *    (GET /api/models/ggerganov/whisper.cpp?blobs=true -> siblings[].lfs.sha256),
 *    which is what the resolve URL serves. Downloads are pinned to one commit so
 *    the bytes behind a URL cannot change under a hash we stored.
 *  - the Windows binary zip: the release asset digest published by the GitHub API
 *    for tag b5130 (assets[].digest, sha256). whisper.cpp itself ships no
 *    checksums.txt next to that asset, so this is the strongest available source.
 *
 * A model that is not listed here is still downloaded (a user may type any id),
 * with a warning that nothing could be verified. */
const MODEL_REVISION = process.env.WHISPER_MODEL_REVISION || '5359861c739e955e79d9a303bcbc70fb988958b1';
const MODEL_URL = (m) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/${MODEL_REVISION}/${m}`;
const BIN_ZIP_SHA256 = 'f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c';
const MODEL_SHA256 = {
  'ggml-tiny.en.bin': '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f',
  'ggml-base.en.bin': 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002',
  'ggml-small.en.bin': 'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d',
  'ggml-large-v3.bin': '64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2',
  'ggml-large-v3-turbo.bin': '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69',
};

// The whisper-server child we spawned (null if we reused an existing server or
// never started one). Kept so the bridge can stop it on shutdown.
let whisperProc = null;
// What the UI polls: { state, model, url, detail, got, total }
let whisperState = { state: 'off', model: DEFAULT_MODEL, url: null, detail: 'not started', got: 0, total: 0 };
let whisperStart = null;   // in-flight promise, so two clicks cannot download twice

function tcpReachable(port) {
  return new Promise((resolve) => {
    const s = net.connect(Number(port), '127.0.0.1');
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
  });
}

/* Download to `dest`, hashing as the bytes arrive, and only keep the file when
 * the hash matches `expected` (or when no hash is known for it). A mismatch is
 * deleted, so a spoofed or truncated download can never be executed or loaded. */
function download(url, dest, onProgress, expected, what) {
  return new Promise((resolve, reject) => {
    const get = (u, redirects) => {
      const mod = u.startsWith('https:') ? https : http;
      mod.get(u, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 6) {
          res.resume();
          return get(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`${u} -> HTTP ${res.statusCode}`));
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        const out = fs.createWriteStream(dest);
        const hash = crypto.createHash('sha256');
        let got = 0, lastPct = -100;
        res.on('data', (c) => {
          got += c.length;
          hash.update(c);
          const pct = total ? Math.floor((got / total) * 100) : 0;
          if (onProgress) onProgress(got, total);
          if (pct >= lastPct + 10) { lastPct = pct; console.log(`  downloading ${path.basename(dest)} … ${pct}%`); }
        });
        res.pipe(out);
        out.on('finish', () => out.close(() => {
          const digest = hash.digest('hex');
          if (!expected) {
            console.log(`  ⚠ no published checksum for ${what || path.basename(dest)} - downloaded ${digest}, NOT verified`);
            return resolve(digest);
          }
          if (digest !== expected) {
            try { fs.unlinkSync(dest); } catch { /* gone already */ }
            const err = new Error(`${what || path.basename(dest)} failed its SHA-256 check `
              + `(expected ${expected.slice(0, 12)}…, got ${digest.slice(0, 12)}…) - the download was discarded`);
            err.code = 'ESHACHECK';
            return reject(err);
          }
          console.log(`  ✓ ${path.basename(dest)} matches its published SHA-256`);
          resolve(digest);
        }));
        out.on('error', reject);
      }).on('error', reject);
    };
    get(url, 0);
  });
}

function unzip(zip, destDir) {
  return new Promise((resolve, reject) => {
    execFile('powershell', ['-NoProfile', '-Command',
      `Expand-Archive -LiteralPath "${zip}" -DestinationPath "${destDir}" -Force`],
      { timeout: 300000 }, (err) => (err ? reject(err) : resolve()));
  });
}

function findServerExe(dir) {
  const files = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p); else files.push(p);
    }
  })(dir);
  return files.find((p) => /whisper[-.]?server(\.exe)?$/i.test(p))
    || files.find((p) => /(^|\\|\/)server\.exe$/i.test(p))
    || null;
}

async function startWhisper(modelId) {
  if (whisperStart) return whisperStart;      // one download at a time
  whisperStart = doStartWhisper(modelId).finally(() => { whisperStart = null; });
  return whisperStart;
}

async function doStartWhisper(modelId) {
  const modelName = WHISPER_MODELS.some((m) => m.id === modelId) ? modelId : DEFAULT_MODEL;
  // A server that is already up gets reused - but not for a different model.
  // Without this, picking another one changed the setting and nothing else: the
  // old model kept transcribing and the new choice appeared to do nothing.
  if (whisperState.state === 'ready' && whisperState.model && whisperState.model !== modelName) {
    try { await stopWhisper(); } catch { /* already gone */ }
    whisperState = { state: 'off', model: modelName, url: null, detail: 'stopped to switch models', got: 0, total: 0 };
  }
  const url = `http://localhost:${WHISPER_PORT}/inference`;
  whisperState = { state: 'starting', model: modelName, url: null, detail: 'checking for an existing server', got: 0, total: 0 };
  try {
    if (await tcpReachable(WHISPER_PORT)) {
      console.log(`whisper STT: reusing server already listening on port ${WHISPER_PORT}`);
      whisperState = { state: 'ready', model: modelName, url, detail: 'reusing the server already on ' + WHISPER_PORT, got: 0, total: 0 };
      return url;
    }
    fs.mkdirSync(VENDOR_DIR, { recursive: true });
    let serverExe = findServerExe(VENDOR_DIR);
    const model = path.join(VENDOR_DIR, modelName);
    if (!serverExe) {
      console.log('whisper STT: first run — downloading whisper.cpp binaries (~200 MB, once)…');
      whisperState = { state: 'downloading', model: modelName, url: null, detail: 'whisper.cpp binaries (~200 MB, once)', got: 0, total: 0 };
      const zip = path.join(VENDOR_DIR, 'whisper-bin-x64.zip');
      await download(BIN_ZIP_URL, zip, (got, total) => { whisperState.got = got; whisperState.total = total; },
        BIN_ZIP_SHA256, 'the whisper.cpp binaries');
      whisperState.detail = 'unpacking whisper.cpp…';
      await unzip(zip, VENDOR_DIR);
      fs.rmSync(zip, { force: true });
      serverExe = findServerExe(VENDOR_DIR);
    }
    if (!serverExe) {
      console.log('whisper STT: server binary not found after download — skipping (browser voice stays available)');
      whisperState = { state: 'failed', model: modelName, url: null, detail: 'could not unpack the whisper.cpp download', got: 0, total: 0 };
      return null;
    }
    if (!fs.existsSync(model)) {
      console.log(`whisper STT: downloading model ${modelName}…`);
      const info = WHISPER_MODELS.find((m) => m.id === modelName);
      whisperState = { state: 'downloading', model: modelName, url: null, detail: `model ${modelName} (${info ? info.size : ''})`.trim(), got: 0, total: 0 };
      await download(MODEL_URL(modelName), model, (got, total) => { whisperState.got = got; whisperState.total = total; },
        MODEL_SHA256[modelName], `the model ${modelName}`);
    }
    const child = spawn(serverExe, ['-m', model, '--port', String(WHISPER_PORT), '--inference-path', '/inference'], {
      cwd: path.dirname(serverExe),
      stdio: 'ignore',
    });
    child.on('error', (e) => console.log('whisper STT: failed to start:', e.message));
    whisperProc = child;
    whisperState.detail = 'starting the server…';
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (await tcpReachable(WHISPER_PORT)) break;
    }
    if (await tcpReachable(WHISPER_PORT)) {
      console.log(`whisper STT: serving ${modelName} at ${url}`);
      whisperState = { state: 'ready', model: modelName, url, detail: `serving ${modelName}`, got: 0, total: 0 };
      return url;
    }
    console.log('whisper STT: server did not come up — browser voice fallback stays available');
    whisperState = { state: 'failed', model: modelName, url: null, detail: 'the server did not come up', got: 0, total: 0 };
    return null;
  } catch (e) {
    console.log('whisper STT: setup skipped (' + e.message + ')');
    whisperState = { state: 'failed', model: modelName, url: null, detail: e.message, got: 0, total: 0 };
    return null;
  }
}

function whisperStatus() {
  const st = WHISPER_MODELS.find((m) => m.id === whisperState.model);
  return { ...whisperState, models: WHISPER_MODELS, size: st ? st.size : null, running: !!whisperProc || whisperState.state === 'ready' };
}

// Stop the whisper server we started. Only acts if we actually spawned one
// (reused servers are left alone). Synchronous so it is safe to call from a
// process 'exit' handler.
function stopWhisper() {
  if (!whisperProc) return;
  const p = whisperProc;
  whisperProc = null;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /F /T /PID ${p.pid}`, { stdio: 'ignore' });
    } else {
      p.kill('SIGKILL');
    }
  } catch { /* already gone */ }
}

module.exports = { startWhisper, stopWhisper, whisperStatus, WHISPER_MODELS, DEFAULT_MODEL };
