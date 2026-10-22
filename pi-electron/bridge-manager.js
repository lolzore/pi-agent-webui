/* Keep a bridge for this app, without requiring node on the machine.
 *
 * If one is already listening (the user's own bridge, or another instance of
 * this app) it is reused and left alone. Otherwise the bridge is started with
 * ELECTRON_RUN_AS_NODE, which runs it on Electron's bundled node - so a
 * packaged build needs nothing installed. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* Where bridge/ and web/ live: next to this app in the repo, or under the
 * packaged resources (electron-builder copies them to app-bridge/). */
export function bridgeRoot() {
  const packaged = path.join(process.resourcesPath || '', 'app-bridge');
  if (fs.existsSync(path.join(packaged, 'bridge', 'server.js'))) return packaged;
  return path.join(HERE, '..');
}

async function healthy(url, timeoutMs = 1500) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const r = await fetch(`${url}/api/health`, { signal: ac.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

export async function ensureBridge({ host, port, userData, workspace }) {
  const url = `http://${host}:${port}`;
  if (await healthy(url)) return { url, started: false, child: null };
  const root = bridgeRoot();
  const script = path.join(root, 'bridge', 'server.js');
  if (!fs.existsSync(script)) throw new Error(`the bridge is not here: ${script}`);
  /* The bridge's cwd is inside the app bundle, which is read-only in a
   * packaged AppImage (and under Program Files on Windows). Its uploads
   * directory and the agent's working directory both hang off WORKSPACE_DIR,
   * so without this the first profile-picture/background upload failed with
   * "mkdir .../resources/app-bridge/uploads: no such file or directory".
   * The app's userData always exists and is writable; the caller may pass a
   * more visible workspace (Documents/Pi Agent). */
  const workspaceDir = workspace || path.join(userData, 'workspace');
  try { fs.mkdirSync(workspaceDir, { recursive: true }); } catch (e) {
    throw new Error(`cannot create the workspace ${workspaceDir}: ${e.message}`);
  }
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(port),
      // the bridge writes these next to itself; in a packaged app that is
      // read-only, so they are pointed at the app's own config directory
      PI_WEBUI_LAN: path.join(userData, 'lan.json'),
      PI_WEBUI_LAST_SESSION: path.join(userData, 'last-session.json'),
      WORKSPACE_DIR: workspaceDir,
      // the bridge's one dependency (ws) ships unpacked with this app, so a
      // packaged build needs no npm install anywhere
      NODE_PATH: [path.join(process.resourcesPath || '', 'app.asar.unpacked', 'node_modules'), process.env.NODE_PATH || ''].filter(Boolean).join(path.delimiter),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => { /* the bridge logs to stdout; nothing to do */ });
  child.stderr.on('data', (d) => console.error('[bridge]', String(d).trimEnd()));
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await healthy(url)) return { url, started: true, child };
    if (child.exitCode !== null) throw new Error(`the bridge exited with code ${child.exitCode}`);
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('the bridge did not answer /api/health within 30 seconds');
}
