/*
 * Which sessions are plain chats.
 *
 * A session file cannot carry this in a field pi knows about, and pi only writes
 * the file once the first message lands. The bridge therefore keeps a small
 * path -> "plain" map beside its own settings. It is deliberately just a mode,
 * not a copy of the conversation: the session file remains the source of truth.
 *
 * The map is read by /api/sessions (so the sidebar can outline a plain chat and
 * by the agent supervisor (so switching to one can start pi in the right mode).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const FILE = 'webui-session-modes.json';
const MAX = 500;

function modeFile(agentDir) {
  return path.join(agentDir || '', FILE);
}

function read(agentDir) {
  let rows;
  try { rows = JSON.parse(fs.readFileSync(modeFile(agentDir), 'utf8')); }
  catch { return {}; }
  if (!rows || typeof rows !== 'object' || Array.isArray(rows)) return {};
  const out = {};
  for (const [p, m] of Object.entries(rows)) {
    if (typeof p === 'string' && p && m === 'plain') out[p] = 'plain';
  }
  return out;
}

/* Only plain is recorded. A normal session needs no entry, and keeping the map
 * append-only means a plain chat does not silently stop being plain when pi is
 * restarted in normal mode. */
function remember(agentDir, sessionPath, mode) {
  if (!sessionPath || mode !== 'plain') return false;
  const all = read(agentDir);
  if (all[sessionPath] === 'plain') return true;
  all[sessionPath] = 'plain';
  const entries = Object.entries(all).slice(-MAX);
  const file = modeFile(agentDir);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(entries)));
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}

function modeFor(agentDir, sessionPath) {
  if (!sessionPath) return 'normal';
  return read(agentDir)[sessionPath] === 'plain' ? 'plain' : 'normal';
}

module.exports = { read, remember, modeFor, modeFile };
