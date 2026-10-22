/* The app's own settings, in the OS's per-user config directory. */
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULTS = {
  host: '127.0.0.1',
  /* The same PORT/PI_WEBUI_PORT the bridge and start-webui.sh use, so a test
   * (or a second copy of the app) can be pointed at its own bridge. */
  port: Number(process.env.PI_WEBUI_PORT || process.env.PORT) || 3080,
  activeFeed: 'instagram',
  paneOpen: false,
  paneWidth: 420,
  /* Empty means the app picks Documents/Pi Agent. Set it here to use another
   * folder; the bridge's uploads live in <workspace>/uploads. */
  workspace: '',
};

let cache = null;
let file = null;
const filePath = () => {
  if (!file) file = path.join(app.getPath('userData'), 'settings.json');
  return file;
};

export function loadSettings() {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(filePath(), 'utf8')) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

export function saveSettings(patch) {
  cache = { ...loadSettings(), ...patch };
  try {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify(cache, null, 2));
  } catch { /* best effort: a full disk must not take the app down */ }
  return cache;
}
