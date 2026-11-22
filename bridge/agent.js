/*
 * Agent supervision, split out of server.js as bridge/agent.js (issue #54,
 * phase 6).
 *
 * One `pi --mode rpc` child, shared by every connected client: the spawn and
 * its environment, the JSON-lines RPC pipe in both directions, the WebSocket
 * fan-out, the idle kill and the restart bookkeeping, session resume, and the
 * server's shutdown path. The factory receives the names it used from
 * server.js, destructured back to the same identifiers; it returns the one
 * thing the rest of server.js reads - agentStatus, which the HTTP handlers
 * answer /api/health and the instance card from.
 */
'use strict';

const sessionModes = require('./session-modes');
const plainModels = require('./plain-models');

module.exports = function agentSupervision(deps) {
  const {
    DEBUG_RPC,
    DEFAULT_MODEL,
    HOST,
    PI_AGENT_DIR,
    PI_COMMAND,
    PORT,
    SESSION_DIR,
    WORKSPACE_DIR,
    WebSocketServer,
    agentStatus,
    allowedHostNames,
    execSync,
    fs,
    forgetLastSession,
    forgetLastSessionIf,
    hostOnly,
    hostSpawnDir,
    isWin,
    http,
    lanAddress,
    lastSessionSkipped,
    loadLastSession,
    path,
    proxyWss,
    saveLastSession,
    server,
    sessionProblem,
    sessionProblemNow,
    spawn,
    splitProxyPath,
    startWhisper,
    stopStartedInstances,
    stopWhisper,
    whisperUrl,
  } = deps;

const wss = new WebSocketServer({ noServer: true });

/*
 * ONE agent, shared by every connected client.
 *
 * The bridge used to spawn a `pi --mode rpc` child per WebSocket, which meant
 * the browser WebUI and the native app were two independent agents: separate
 * sessions, separate models, and events only one of them ever saw -- so the two
 * UIs drifted apart until a manual refresh.
 *
 * Now there is a single child. Every client writes its commands to it, every
 * event is broadcast to every client, and all UIs stay in lockstep in real time.
 *
 * Command ids are only unique per client, so a `response` is routed back to the
 * socket that asked (pendingOwner) rather than broadcast -- otherwise two
 * clients using "req-1" would resolve each other's requests.
 */
let agent = null;               // the shared child process
let agentMode = 'normal';       // 'normal' | 'plain' (no tools/extensions/skills/AGENTS.md)
const PLAIN_FLAGS = '--no-tools --no-extensions --no-skills --no-context-files --no-mcp';
// A mode switch to a specific session (a plain chat from the sidebar, or a
// normal chat while the bridge happens to be in plain mode) has to start pi in
// that session rather than in a fresh one. startAgent consumes this once.
let pendingStartPath = null;
const clients = new Set();      // connected sockets
// A reload closes the old socket and opens a new one a moment later. Killing the
// agent on the first close meant every reload restarted pi, and a reload right
// after sending a message could kill it before that message's session file had
// been written - the session then looked like it had vanished. Wait for the
// reconnect instead; a browser that really is closed still kills it, a few
// seconds later.
const IDLE_KILL_MS = parseInt(process.env.PI_WEBUI_IDLE_KILL_MS || '25000', 10);
let agentIdleTimer = null;
/* Requests on the wire are keyed by an id this bridge assigns, never by the
 * client's own id. Every page numbers its requests from zero, so two tabs both
 * send `req-1`; keying by that id meant the second tab overwrote the first and
 * one of them was handed the other's answer (while the other timed out). The
 * client's id is kept beside the owner and written back into the response, so
 * each page still sees the id it sent.
 *
 * wire id -> { ws, clientId, type, sessionPath, agent }: the socket that sent
 * it, its own id, and the command so session changes can be tracked. */
const pendingOwner = new Map();
let wireReqId = 0;
// RPCs issued by the bridge itself (session bookkeeping): their responses are
// consumed here instead of being routed to a client socket.
const bridgePending = new Map(); // request id -> { resolve, reject }

function rememberPlainSession(sessionPath) {
  if (!sessionPath || agentMode !== 'plain') return;
  try { sessionModes.remember(PI_AGENT_DIR, sessionPath, 'plain'); } catch { /* mode is a nicety */ }
}
let bridgeReqId = 0;

function bridgeRpc(commandObj, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    if (!agent || !agent.stdin.writable) return reject(new Error('agent not running'));
    const id = `bridge-req-${++bridgeReqId}`;
    const entry = {
      resolve: (v) => { clearTimeout(t); resolve(v); },
      reject: (e) => { clearTimeout(t); reject(e); },
    };
    const t = setTimeout(() => {
      if (bridgePending.has(id)) { bridgePending.delete(id); entry.reject(new Error(`${commandObj.type}: timed out`)); }
    }, timeoutMs);
    bridgePending.set(id, entry);
    agent.stdin.write(JSON.stringify({ ...commandObj, id }) + '\n');
  });
}

function failBridgePending(reason) {
  for (const [id, entry] of bridgePending) {
    bridgePending.delete(id);
    entry.reject(new Error(reason));
  }
}

/* The same for the commands a *client* is waiting on.
 *
 * Every request in pendingOwner was written to a pipe that just closed, so none
 * of them will ever be answered. Dropping them silently is what left the page
 * waiting: the send path on the client keeps the message row on screen until the
 * request settles, and its request timeout is two minutes. The page has to be
 * told, or nothing it does with that row can ever be right. */
function failPendingOwners(reason) {
  for (const [id, owner] of pendingOwner) {
    pendingOwner.delete(id);
    wsSend(owner.ws, {
      bridge: 'rpc',
      payload: { type: 'response', id, command: owner.type, success: false, error: reason },
    });
  }
}

/* Keep the "last session" record current so a restarted agent can resume it.
 * switch_session says which file directly; new_session/fork/clone create a
 * file whose path the agent only reports via get_state. Cancelled switches
 * (an extension vetoed them) leave the agent where it was, so they are not
 * recorded. */
function trackSessionChange(parsed, owner) {
  if (!parsed || !parsed.success || !owner) return;
  const cmd = parsed.command || owner.type;
  const cancelled = parsed.data && parsed.data.cancelled === true;
  if (cmd === 'switch_session' && owner.sessionPath && !cancelled) {
    agentStatus.sessionFile = owner.sessionPath;
    // The user (or a page) moved deliberately: whatever resume failed before is
    // no longer what this agent is about.
    lastResumeFailed = null;
    rememberPlainSession(owner.sessionPath);
    if (agentMode !== 'plain') saveLastSession(owner.sessionPath);
  } else if (cmd === 'get_state' && parsed.data && parsed.data.sessionFile) {
    // The page asks for this on every session open and after a fresh start.
    // It is also how a new plain chat's filename becomes known: pi does not
    // create the file until the first message, so this is the only path the
    // sidebar can show (and remember as plain) in the meantime.
    agentStatus.sessionFile = parsed.data.sessionFile;
    rememberPlainSession(parsed.data.sessionFile);
  } else if (cmd === 'get_available_models' && parsed.data && Array.isArray(parsed.data.models)) {
    // Remember the normal agent's complete catalogue (extension providers
    // included); the plain child cannot run those extensions to discover them.
    if (agentMode !== 'plain') plainModels.rememberSnapshot(PI_AGENT_DIR, parsed.data.models);
  } else if ((cmd === 'prompt' || cmd === 'new_session' || cmd === 'fork' || cmd === 'clone') && !cancelled) {
    // A prompt can be the first thing that creates a session file, and its path
    // is reported nowhere else - re-read it, so the record matches the session
    // the message actually landed in.
    bridgeRpc({ type: 'get_state' }, 15000)
      .then((st) => {
        if (!st || !st.sessionFile) return;
        rememberPlainSession(st.sessionFile);
        if (agentMode !== 'plain') saveLastSession(st.sessionFile);
      })
      .catch(() => { /* agent gone; nothing to record */ });
  }
}

function broadcast(obj, except) {
  for (const ws of clients) {
    if (ws !== except) wsSend(ws, obj);
  }
}

// Tiny activity tracker for /api/health, which other instances poll to show a
// pulsing dot. agent_start .. agent_settled is exactly "a turn is running".
/* agentStatus is the caller's object (server.js declares it before the
 * route modules so they can read it; this module fills it in). */
function noteAgentActivity(obj) {
  if (!obj || typeof obj !== 'object') return;
  const sf = obj.sessionFile || (obj.session && obj.session.file) || null;
  if (sf) { agentStatus.sessionFile = sf; rememberPlainSession(sf); }
  switch (obj.type) {
    case 'agent_start': agentStatus.busy = true; break;
    case 'agent_settled':
    case 'agent_end': agentStatus.busy = false; break;
    case 'session_info_changed': if (obj.name) agentStatus.sessionName = obj.name; break;
    case 'agent_exit': agentStatus.busy = false; break;
    // A compaction is long (it reads the whole conversation and asks a model to
    // summarise it), and the "compacting…" block only lived in the page that
    // started it: reload while it runs and the page looked idle, with no way to
    // tell a finished compaction from one that never happened.
    case 'compaction_start':
      agentStatus.compacting = { since: Date.now(), session: agentStatus.sessionFile || null, automatic: !!obj.automatic };
      break;
    case 'compaction_end':
      agentStatus.compacting = null;
      break;
    default: break;
  }
}

/* isWin is the caller's (server.js declares it; the font enumeration wants it too). */

// Kill a child and (on Windows) its whole process tree. `shell: true` spawns
// cmd.exe which then spawns the real agent, so a plain child.kill() would
// orphan the agent and keep it running in the background. taskkill /T kills
// the entire tree; on POSIX we kill the child's process group.
function killTree(child) {
  if (!child || child.pid == null) return;
  try {
    if (isWin) {
      execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  } catch { /* already gone */ }
}

function wsSend(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch { /* dead socket; keepalive reaps it */ }
  }
}

/* A wedged extension runner, cleared by restarting the agent.
 *
 * pi invalidates every extension context when the session is replaced or the
 * extensions are reloaded. If an agent ends up running its turns against one of
 * those dead contexts, pi answers every extension handler with the same error -
 * "This extension ctx is stale after session replacement or reload" - turn after
 * turn, and the boundary reports "turn_end could not resolve the persisted
 * assistant entry ID" with it. The page cannot repair that, and neither can a
 * /reload: the session keeps streaming into a runner nobody rebuilt. A fresh
 * child is the one reliable repair, and the session it was in comes back from
 * the usual last-session record.
 *
 * Only between turns: a restart mid-answer would throw the answer away. Bounded
 * to three repairs an hour, because an extension that is broken in a way a
 * restart cannot fix must not become a restart loop. */
const STALE_EXTENSION_CTX = /extension ctx is stale|stale after session replacement or reload/i;
let staleRepairs = [];
let staleRepairTimer = null;
let staleRepairRunning = false;
let staleRepairGaveUp = false;

function noteExtensionHealth(parsed) {
  if (!parsed || parsed.type !== 'extension_error') return;
  if (!STALE_EXTENSION_CTX.test(String(parsed.error || ''))) return;
  if (staleRepairTimer || staleRepairRunning) return; // already queued or running
  staleRepairTimer = setTimeout(tryStaleRepair, 1500);
}

function tryStaleRepair() {
  staleRepairTimer = null;
  if (!agent || shuttingDown) return;
  // Wait for the turn to finish: the stale batch arrives at turn_end and at the
  // start of the next request, so the answer is usually still streaming.
  if (agentStatus.busy) { staleRepairTimer = setTimeout(tryStaleRepair, 1500); return; }
  const now = Date.now();
  staleRepairs = staleRepairs.filter((t) => now - t < 3600000);
  if (staleRepairs.length >= 3) {
    if (!staleRepairGaveUp) {
      staleRepairGaveUp = true;
      console.error('extension contexts are still stale after three restarts; not restarting again for now');
      broadcast({ bridge: 'agent_stderr', text: 'The agent keeps reporting stale extension contexts (an extension is holding a replaced session) - restart it from the top bar to clear it.' });
    }
    return;
  }
  staleRepairGaveUp = false;
  staleRepairs.push(now);
  staleRepairRunning = true;
  const child = agent;
  console.log('extension contexts are stale - restarting the agent to clear them');
  // Record where we are first, so the restart resumes this session rather than
  // whatever the last record said.
  recordCurrentSession(8000).finally(() => {
    staleRepairRunning = false;
    if (!agent || agent !== child) return;
    // The exit handler schedules the restart; leave `agent` alone so it sees the
    // exit as the current child's and brings it back with the session recorded.
    try { killTree(child); } catch (e) { console.error('stale-ctx repair kill failed:', e.message); }
  });
}

let agentRestarts = [];
let agentRestartTimer = null;

/* Why the agent is not in the session the bridge meant to be in.
 *
 * A resume that is skipped (or a start that dies because of the session it was
 * given) is not something the page can see on its own: it looks like the last
 * conversation simply vanished. The news is kept, like lastResumed, because the
 * bridge decides it before the browser's socket is open - a plain broadcast would
 * have no listener. */
let lastResumeFailed = null;   // { path, reason: 'file'|'folder', explicit?: boolean }

function announceResumeFailure(info) {
  if (!info) return;
  lastResumeFailed = info;
  lastResumed = null;
  broadcast({ bridge: 'session_resume_failed', path: info.path, reason: info.reason, explicit: !!info.explicit });
}

/* Bring the agent back after it exited with clients still connected. Bounded: a
 * command that cannot start at all must not respawn in a tight loop. */
function scheduleAgentRestart() {
  const now = Date.now();
  agentRestarts = agentRestarts.filter((t) => now - t < 60000);
  if (agentRestarts.length >= 5) {
    console.error('agent keeps exiting; not restarting again for now');
    broadcast({ bridge: 'agent_stderr', text: 'The agent keeps exiting - check the console for why.' });
    return;
  }
  agentRestarts.push(now);
  if (agentRestartTimer) return;
  agentRestartTimer = setTimeout(() => {
    agentRestartTimer = null;
    if (agent || shuttingDown || clients.size === 0) return;
    console.log('restarting the agent');
    try { startAgent(); } catch (e) { console.error('restart failed:', e.message); }
  }, 800);
}

/* One argument, quoted for the shell the agent command goes through (spawn uses
 * shell: true, because pi is an npm .cmd shim on Windows). */
function shellArg(value) {
  const str = String(value);
  if (isWin) return `"${str.replace(/"/g, '""')}"`;
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

/* Switch between the normal agent and a plain-chat agent. A mode change needs a
 * new pi process because tools/extensions/skills/context files are fixed when pi
 * starts. Session bookkeeping deliberately keeps lastSession pointing at the
 * last normal chat, so leaving plain mode returns to the conversation the user
 * was in before it. */
function setAgentMode(mode, sessionPath) {
  const next = mode === 'plain' ? 'plain' : (mode === 'normal' ? 'normal' : null);
  if (!next) throw new Error('mode must be "normal" or "plain"');
  if (agentStatus.busy || agentStatus.compacting) {
    return { ok: false, error: 'the agent is busy; wait for the current turn to finish', busy: true };
  }
  agentMode = next;
  agentStatus.mode = next;
  agentStatus.resuming = null;
  lastResumed = null;
  lastResumeFailed = null;
  pendingStartPath = sessionPath ? String(sessionPath) : null;
  // The old path belongs to the old process/mode. Clear it until the new child
  // answers get_state (or use the requested target) so the sidebar cannot paint
  // the old session with the new mode's outline in the gap.
  agentStatus.sessionFile = pendingStartPath || null;
  failBridgePending('agent mode changed');
  const old = agent;
  agent = null;
  if (old) killTree(old);
  broadcast({ bridge: 'agent_mode', mode: next });
  setTimeout(() => { if (!agent && !shuttingDown) startAgent(); }, 120).unref?.();
  return { ok: true, mode: next, sessionPath: pendingStartPath };
}

function startAgent() {
  if (agent) return agent;
  // A new child makes any resume belonging to the previous one moot; clearing
  // it here keeps /api/sessions from claiming a resume that can no longer land.
  agentStatus.resuming = null;

  // pi keeps its own idea of where its config and sessions live, and nothing
  // was telling it about the ones this bridge was pointed at: set
  // PI_SESSION_DIR (or PI_AGENT_DIR) and the sidebar listed a directory the
  // agent never wrote to, while the models.json and the llama endpoint saved in
  // Settings were read from a file pi never looked at. pi honours both as env
  // vars - PI_CODING_AGENT_DIR and PI_CODING_AGENT_SESSION_DIR - so it is told
  // exactly what the bridge itself uses. A docker:<ctr>:<dir> session dir is a
  // host-side alias for a path inside the container; the agent is already in
  // there and has no use for it.
  const childEnv = { ...process.env };
  if (!SESSION_DIR.startsWith('docker:')) {
    childEnv.PI_CODING_AGENT_SESSION_DIR = SESSION_DIR;
    childEnv.PI_CODING_AGENT_DIR = PI_AGENT_DIR;
  }
  /* Resume the last session by *starting in it*, not by switching to it once
   * the agent is up.
   *
   * A switch replaces the session under pi's own extensions and under commands
   * that were already in flight - pi then answers every extension that its ctx
   * is stale ("This extension ctx is stale after session replacement or
   * reload"), once for each command the page sends while the switch lands,
   * which is the line that appeared several times per start. It is also the
   * race that could show an empty transcript until something re-rendered it.
   * Starting in the session has neither problem: the first get_state the page
   * sends is already about the right session.
   *
   * A local session file is checked here, synchronously; the container case
   * still goes through the switch below, because the file lives in there.
   *
   * "Checked" has to mean more than "the file is there": pi exits code 1 when
   * the session's recorded working directory is gone, and starting in the
   * session is exactly how that message becomes a dead agent. See
   * sessionProblemNow() in server.js - a stale record used to make every restart
   * resume the same dead session, so the page never got a running agent again. */
  let resumePath = null;
  let resumeProblem = null;   // the session we wanted and could not use, if any
  let resumeExplicit = false; // the user picked this session (a mode switch)
  if (pendingStartPath) {
    resumePath = pendingStartPath;
    pendingStartPath = null;
    // A session the user picked can be stale too (a mode switch into a plain
    // chat whose project folder was renamed). Ask the same question.
    const problem = sessionProblemNow(resumePath);
    if (problem) {
      resumeProblem = { path: resumePath, reason: problem, explicit: true };
      forgetLastSessionIf(resumePath);
      resumePath = null;
    } else {
      resumeExplicit = true;
    }
  } else if (agentMode !== 'plain' && !SESSION_DIR.startsWith('docker:')) {
    try {
      const last = loadLastSession();
      if (last && fs.existsSync(last)) resumePath = last;
    } catch { /* no record, or no fs to check with: start fresh */ }
    // loadLastSession forgets a record it cannot use; report why this start is in
    // a fresh session rather than the one the user left.
    if (!resumePath) resumeProblem = (lastSessionSkipped && lastSessionSkipped()) || null;
  }
  // Plain chat is a separate pi process: no tools, no extensions (including
  // built-in MCP), no skills, and no AGENTS.md/CLAUDE.md context files. It never
  // resumes the previous session; a new chat starts empty.
  const command = agentMode === 'plain'
    ? `${PI_COMMAND} ${PLAIN_FLAGS}${resumePath ? ` --session ${shellArg(resumePath)}` : ''}`
    : (resumePath ? `${PI_COMMAND} --session ${shellArg(resumePath)}` : PI_COMMAND);
  /* A plain child has no extensions, and extensions are where llama.cpp and
   * SchizoDev register their providers. Give that child a temporary agent dir
   * with a models.json merged from models-store/auth instead, so its picker is
   * not reduced to the custom models.json providers. The real config is never
   * written; the overlay is discarded when the child is replaced. */
  if (agentMode === 'plain') {
    const overlay = plainModels.create(PI_AGENT_DIR, PI_COMMAND);
    if (overlay) {
      plainModels.setActive(overlay);
      childEnv.PI_CODING_AGENT_DIR = overlay;
    }
  } else {
    plainModels.setActive(null);
  }
  /* A resume path in a container is a path *in there*; pi is started in the
   * same container, so it is valid where it is used. Only the local check can
   * answer the cwd question, and sessionProblemNow says "cannot tell" for a
   * container path rather than "gone". */
  const startedAt = Date.now();
  let child;
  try {
    child = spawn(command, {
      shell: true, // pi is an npm .cmd shim on Windows; shell handles both platforms
      cwd: hostSpawnDir(),
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: !isWin, // POSIX: own process group so killTree can kill the whole tree
    });
  } catch (e) {
    console.error(`could not start the agent (${command}): ${e.message}`);
    broadcast({
      bridge: 'agent_exit',
      error: `Failed to start "${command}": ${e.message}. ` +
             `Is the pi coding agent installed and on PATH? (npm install -g @mariozechner/pi-coding-agent)`,
    });
    return null;
  }

  // Writing to an agent that is on its way out raises EPIPE / ECONNRESET on the
  // next flush, not on the write itself - so `child.stdin.writable` is true at
  // the moment the decision is made and the failure arrives a tick later, with
  // nobody listening. That is an unhandled 'error' event and it kills the whole
  // bridge: no agent, no other tab, no WebSocket. It happens on every restart
  // (/reload, a changed model, a /login) and every idle shutdown, whenever a
  // command from a client is still in flight.
  child.stdin.on('error', (err) => {
    if (DEBUG_RPC) console.log(`[rpc] agent stdin closed: ${err.message}`);
  });

  let buf = '';
  child.stdout.on('data', (d) => {
    // Only the current agent speaks for the bridge. A previous child that has
    // been replaced can still have output in flight, and its answers are about a
    // session nobody is in any more - that is how a client ended up looking at a
    // fresh, empty session while the real one sat right there.
    if (child !== agent) return;
    // Protocol requires splitting on \n only (not U+2028/U+2029 like readline).
    buf += d.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        broadcast({ bridge: 'agent_raw', line });
        continue;
      }
      // A response belongs only to the client that issued the request; events
      // (everything without a matching owner) go to everybody.
      noteAgentActivity(parsed);
      noteExtensionHealth(parsed);
      if (parsed && parsed.type === 'response' && parsed.id) {
        const bp = bridgePending.get(parsed.id);
        if (bp) {
          bridgePending.delete(parsed.id);
          parsed.success ? bp.resolve(parsed.data) : bp.reject(new Error(parsed.error || 'request failed'));
          continue;
        }
        if (pendingOwner.has(parsed.id)) {
          const owner = pendingOwner.get(parsed.id);
          pendingOwner.delete(parsed.id);
          const payload = owner.clientId !== undefined && owner.clientId !== parsed.id
            ? { ...parsed, id: owner.clientId }
            : parsed;
          // A response from a child that has been replaced describes the wrong
          // session (and the wrong mode). Settle the caller with an error rather
          // than letting it write a stale session path into bookkeeping.
          if (owner.agent !== agent) {
            wsSend(owner.ws, { bridge: 'rpc', payload: {
              type: 'response', id: payload.id, command: parsed.command || owner.type,
              success: false, error: 'agent restarted',
            } });
            continue;
          }
          if (DEBUG_RPC) console.log(`[rpc] -> ${parsed.command || owner.type}${parsed.success ? '' : ' FAILED: ' + (parsed.error || '')}`);
          wsSend(owner.ws, { bridge: 'rpc', payload });
          trackSessionChange(parsed, owner);
          continue;
        }
      }
      /* Request-scoped events carry the id of the request that caused them
       * (`bash_execution_update` does). The id on the wire is the bridge's, so
       * it is translated back and sent to the caller only: broadcasting it
       * would let another tab with the same client-side id show output from a
       * command it did not run. */
      if (parsed && parsed.type === 'bash_execution_update' && parsed.id && pendingOwner.has(parsed.id)) {
        const owner = pendingOwner.get(parsed.id);
        wsSend(owner.ws, { bridge: 'rpc', payload: { ...parsed, id: owner.clientId } });
        continue;
      }
      broadcast({ bridge: 'rpc', payload: parsed });
    }
  });

  child.stderr.on('data', (d) => {
    if (child !== agent) return;
    const text = d.toString('utf8');
    if (DEBUG_RPC) console.error(`[agent stderr] ${text.trimEnd()}`);
    broadcast({ bridge: 'agent_stderr', text });
  });

  child.on('error', (err) => {
    // Without this, a command the shell cannot run at all (a bad path, a missing
    // docker, a workspace that does not exist here) failed in complete silence:
    // the console showed the startup banner and nothing else, and the UI sat
    // there empty with no reason given.
    console.error(`could not start the agent (${PI_COMMAND}): ${err.message}`);
    broadcast({
      bridge: 'agent_exit',
      error: `Failed to start "${PI_COMMAND}": ${err.message}. ` +
             `Is the pi coding agent installed and on PATH? (npm install -g @mariozechner/pi-coding-agent)`,
    });
  });

  child.on('exit', (code, signal) => {
    const wasCurrent = agent === child;
    if (wasCurrent) agent = null;
    if (!wasCurrent) return;   // a replaced child; its exit is not the bridge's business
    agentStatus.busy = false;
    agentStatus.resuming = null;
    failBridgePending('agent exited');
    failPendingOwners('the agent exited before it answered - the command was not run');
    console.log(`agent exited (code ${code}${signal ? ', signal ' + signal : ''})`);
    /* A child that dies moments after being started *in a session* died because
     * of that session. That is pi's behaviour when the session's recorded
     * working directory is gone - it prints the reason and exits 1 - and it is
     * also what any other fatal, session-specific startup failure looks like
     * from here. Retrying the same start forever is what turned one stale record
     * into "the agent is not running" for every command: five restarts, the same
     * wall, no agent. Drop the record once and come back in a fresh session, so
     * the UI recovers by itself and the conversation is still in the sidebar. */
    if (resumePath && Date.now() - startedAt < 5000) {
      console.warn(`the agent died right after starting in ${resumePath} - not resuming it again`);
      forgetLastSessionIf(resumePath);
      announceResumeFailure({ path: resumePath, reason: 'start', explicit: !!resumeExplicit });
    }
    broadcast({ bridge: 'agent_exit', code, signal });
    // pi can end on its own - a container settling, a provider dropping the RPC
    // loop. Waiting for somebody to press "restart" leaves the page sitting in
    // whatever empty session the next start would create; bringing it back with
    // the recorded session is what the user actually wants to see.
    if (clients.size > 0 && !shuttingDown) scheduleAgentRestart();
  });

  agent = child;
  broadcast({
    bridge: 'agent_started',
    command: PI_COMMAND,
    mode: agentMode,
    workspace: WORKSPACE_DIR,
    sessionDir: SESSION_DIR,
  });
  // A fresh agent starts a brand-new empty session; put it back in the one the
  // user was in. Called from here, before this start returns, so the switch is
  // the first command on the pipe and no client can get in front of it.
  if (resumePath) {
    // already in it: there is nothing to switch to
    lastResumed = resumePath;
    lastResumeFailed = null;
    agentStatus.sessionFile = resumePath;
    rememberPlainSession(resumePath);
    if (agentMode !== 'plain') saveLastSession(resumePath);
    console.log(`started in the last session: ${resumePath}`);
    broadcast({ bridge: 'session_resumed', path: resumePath });
    recordCurrentSession();
  } else if (resumeProblem) {
    // The session we meant to open cannot be opened. Say so (and remind late
    // arrivals when they connect), then start in a fresh one - never in the dead
    // session, which would take the whole agent down.
    console.warn(`not starting in ${resumeProblem.path}: the session's ${resumeProblem.reason === 'folder' ? 'working directory is gone' : 'file is gone'}`);
    announceResumeFailure(resumeProblem);
    recordCurrentSession();
  } else if (agentMode === 'plain') {
    // A plain chat is a new chat. Resuming the last normal session here was the
    // reason the outlined plain row kept pointing at the normal conversation.
    recordCurrentSession();
  } else {
    resumeLastSessionOnAgent();
  }
  return child;
}

/* Ask the agent which session it is in and remember it. This is the record a
 * restart resumes from, so it is also taken just before the agent is stopped. */
async function recordCurrentSession(timeoutMs = 15000) {
  try {
    const st = await bridgeRpc({ type: 'get_state' }, timeoutMs);
    if (st && st.sessionFile) {
      if (DEBUG_RPC) console.log(`[session] recorded ${st.sessionFile}`);
      agentStatus.sessionFile = st.sessionFile;
      rememberPlainSession(st.sessionFile);
      if (agentMode !== 'plain') saveLastSession(st.sessionFile);
      return st.sessionFile;
    }
  } catch { /* agent gone or too slow - the previous record still stands */ }
  return null;
}

/* Put a freshly started agent back into the session the user was in.
 *
 * The switch has to be the first thing written to the agent's pipe, with nothing
 * awaited before it. pi starts every run in a new, empty session, and that
 * session's file does not exist until the first message arrives. This used to
 * wait for an existence check first (a `docker exec test -f` in container mode,
 * easily hundreds of milliseconds), while the browser connecting in the same
 * breath sent its own get_state and prompt. Those overtook the switch: the page
 * showed the fresh session, the prompt went into it, and the switch arriving
 * afterwards moved the agent off it again. Send a message, reload immediately,
 * and the session you were writing in looked like it had disappeared.
 *
 * Now the switch is written immediately - a missing file only makes it fail, and
 * that is handled below - so a client's commands can only be processed after it.
 */
// The session the last resume landed in. A page that connects after the resume
// has finished (the usual case: the bridge resumes within a few hundred
// milliseconds of starting, while the browser is still opening its socket) never
// sees the broadcast that goes with it, and renders the empty transcript of the
// fresh session its own get_state came back with. Handing late arrivals the same
// news is what makes the transcript come back.
let lastResumed = null;

function resumeLastSessionOnAgent() {
  // Plain chat never resumes the remembered normal session; its own target is
  // passed to startAgent as pendingStartPath instead.
  if (agentMode === 'plain') { recordCurrentSession(); return; }
  const last = loadLastSession();
  if (!last) { agentStatus.resuming = null; recordCurrentSession(); return; }
  // Publish "a resume is in flight" before the existence check. In container
  // mode that check is a `docker exec` that can take hundreds of milliseconds;
  // a page connecting during it used to see a fresh session and issue its own
  // switch to the same path. That second switch made pi start the session twice
  // - and an extension that asks a question on session_start (goal-x's "Resume
  // paused goal?") asked it twice as well (issue #220).
  agentStatus.resuming = last;
  // Ask whether the session can still be opened *before* switching: a record
  // left behind by a session that has since been deleted, or whose recorded
  // working directory is gone, used to produce a failed switch, a "could not
  // reopen your last session" toast and - with a pi that does not answer - a
  // wedged agent that had to be restarted. None of that is a resume.
  sessionProblem(last).then((problem) => {
    if (!problem) return resumeInto(last);
    console.warn(`forgetting last session (${problem === 'folder' ? 'its folder is gone' : 'gone'}): ${last}`);
    forgetLastSession();
    announceResumeFailure({ path: last, reason: problem });
    recordCurrentSession();
  }).catch(() => resumeInto(last))   // a docker failure: let the agent decide
    .finally(() => { if (agentStatus.resuming === last) agentStatus.resuming = null; });
}

function resumeInto(last) {
  agentStatus.resuming = last;
  return bridgeRpc({ type: 'switch_session', sessionPath: last }, 30000)
    .then(() => {
      console.log(`resumed last session: ${last}`);
      lastResumed = last;
      lastResumeFailed = null;
      agentStatus.sessionFile = last;
      broadcast({ bridge: 'session_resumed', path: last });
      recordCurrentSession();
    })
    .catch(async (e) => {
      // Gone, or its working directory is gone: the agent stays in its fresh
      // session (the WebUI offers the usual folder-recreate flow when the old
      // session is clicked in the sidebar).
      console.warn(`could not resume last session ${last}: ${e.message}`);
      const answer = await recordCurrentSession(8000);
      if (!answer && agent) {
        // The switch did not fail so much as stop: an agent that cannot even
        // say which session it is in is wedged, and every later command would
        // queue behind it. Drop the record that led here (so the restart cannot
        // hit the same wall) and give it a fresh start.
        console.warn('agent did not answer after the failed resume - restarting it');
        forgetLastSession();
        killTree(agent);
        agent = null;
        startAgent();
        return;
      }
      // The agent stayed in its fresh session, so the page has to be told: it
      // left the user in a conversation that is not the one on screen. A switch
      // can fail for a reason no check can see (an unreadable session, an
      // extension's error), and the answer used to be silence.
      const missingCwd = /working directory does not exist/i.test(e.message || '');
      if (missingCwd) forgetLastSessionIf(last);
      announceResumeFailure({ path: last, reason: missingCwd ? 'folder' : 'start' });
    })
    .finally(() => { if (agentStatus.resuming === last) agentStatus.resuming = null; });
}

server.on('upgrade', (req, socket, head) => {
  /* The socket is the whole agent: every RPC, including `bash`, goes over it. A
   * WebSocket handshake carries Origin, so a page on another site can open one to
   * this bridge - and the same-origin policy does not stop it establishing the
   * connection, only reading the result. Same two checks as an HTTP write
   * (issue #23). */
  const refused = (() => {
    const host = hostOnly(req.headers.host);
    if (!host) return 'no Host header';
    if (!allowedHostNames().has(host)) return `Host "${host}" is not an address this bridge answers on`;
    const origin = req.headers.origin;
    if (!origin) return null;                     // not a browser
    try {
      const u = new URL(String(origin));
      const selfProto = req.socket && req.socket.encrypted ? 'https:' : 'http:';
      if (hostOnly(u.host) === host && u.protocol === selfProto) return null;
    } catch { return `Origin "${String(origin).slice(0, 60)}" is not a URL`; }
    return `Origin "${String(origin).slice(0, 60)}" is not this bridge`;
  })();
  if (refused) {
    console.warn(`refused websocket ${String(req.url).slice(0, 60)}: ${refused}`);
    try {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    } catch { /* already gone */ }
    socket.destroy();
    return;
  }

  const parsed = splitProxyPath(req.url);
  if (parsed) {
    proxyWss.handleUpgrade(req, socket, head, (client) => proxyWss.emit('connection', client, req, parsed));
    return;
  }
  if ((req.url || '').startsWith('/ws')) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    return;
  }
  socket.destroy();
});

wss.on('connection', (ws) => {
  clients.add(ws);
  if (agentIdleTimer) { clearTimeout(agentIdleTimer); agentIdleTimer = null; }
  // Keepalive bookkeeping: the bridge pings every 30s (see below) and a dead
  // client is terminated once it misses a round. Without this, half-open
  // connections (sleep/wake, embedded-browser network hiccups) linger in `clients`
  // forever, so "last one out turns off the lights" never fires for a client
  // that is actually gone.
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  // A client socket error must not take the bridge down — an unhandled
  // 'error' event would crash the process and drop every other client.
  ws.on('error', () => { /* 'close' follows */ });
  // Was there an agent already? If not, startAgent below is the one that starts
  // it, and it broadcasts the resume news to every client as it goes - sending
  // it again to this socket would show the same toast twice.
  const hadAgent = !!agent;
  startAgent();
  // Tell the newcomer where it is, and let it pull the current state itself.
  wsSend(ws, {
    bridge: 'agent_started',
    command: PI_COMMAND,
    mode: agentMode,
    workspace: WORKSPACE_DIR,
    sessionDir: SESSION_DIR,
  });
  // ... and which session the agent was put back into, in case this page missed
  // the broadcast while it was still connecting. If a resume had to be abandoned,
  // that is the news instead - otherwise the page just looks like the last
  // conversation vanished.
  if (lastResumed) wsSend(ws, { bridge: 'session_resumed', path: lastResumed });
  else if (lastResumeFailed && hadAgent) wsSend(ws, { bridge: 'session_resume_failed', ...lastResumeFailed });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (msg.bridge === 'restart') {
      // Shared process: everyone gets the fresh agent.
      const old = agent;
      agent = null;
      if (old) killTree(old);
      setTimeout(() => startAgent(), 150);
      return;
    }
    if (msg.bridge) return; // bridge-level chatter is not forwarded
    /* An answer to an extension dialog is not an RPC of ours, and its id is not
     * ours to change. pi keeps the dialogs it asked for in a map keyed by the id
     * it put on the request (`pendingExtensionRequests.get(response.id)` in its
     * rpc mode) and silently drops an answer whose id it does not know. Every
     * client request is rewritten to a unique wire id so two tabs cannot collide
     * (issue #227), and rewriting this one turned `dlg1` into `wire-7`: the
     * extension's await never resolved, so accepting a goal menu sent nothing
     * (issues #274, #275) and the session that was waiting on it stopped
     * answering anything until the server was restarted (issue #276).
     *
     * Passed through untouched, for the agent that asked for it. */
    if (msg.type === 'extension_ui_response') {
      if (agent && agent.stdin.writable) agent.stdin.write(JSON.stringify(msg) + '\n');
      return;
    }
    if (agent && agent.stdin.writable) {
      // Remember who asked (and what they asked), so the response goes back
      // to them and not to everybody. The id is replaced on the wire: client
      // ids are only unique per page, and two tabs both use `req-1`. The
      // client's own id is restored on the way back (see the response arm).
      if (DEBUG_RPC) console.log(`[rpc] <- ${msg.type}${msg.sessionPath ? ' ' + msg.sessionPath : ''}`);
      if (msg.id) {
        const clientId = msg.id;
        msg.id = `wire-${++wireReqId}`;
        pendingOwner.set(msg.id, { ws, clientId, type: msg.type, sessionPath: msg.sessionPath, agent });
      }
      agent.stdin.write(JSON.stringify(msg) + '\n');
    } else {
      /* Answer the request itself, not just the console.
       *
       * A command that arrives while the agent is down used to get one
       * broadcast 'agent_stderr' line, which the page writes to its console and
       * shows nowhere. The request id was never answered, so the caller sat on
       * its full timeout - two minutes for a prompt - with the message already
       * drawn in the transcript and the composer already cleared. A reload in
       * that window destroyed the row and the text together, which is the "I
       * sent a message and it was discarded" report.
       *
       * A real response rejects the caller immediately, so sendPrompt's error
       * path runs: the row comes off the screen and the text goes back into the
       * box. The message was not sent, and now it visibly was not sent. */
      if (msg.id) {
        wsSend(ws, {
          bridge: 'rpc',
          payload: {
            type: 'response', id: msg.id, command: msg.type, success: false,
            error: 'The agent is not running - the message was not sent. Try again in a moment.',
          },
        });
      }
      wsSend(ws, { bridge: 'agent_stderr', text: 'Agent process is not running.' });
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    // Drop any requests this client will never read.
    for (const [id, owner] of pendingOwner) {
      if (owner.ws === ws) pendingOwner.delete(id);
    }
    // Last one out turns off the lights (after the grace period above), so an
    // abandoned agent is not left running in the background. The session is
    // recorded first: this is the last moment the agent can say which session it
    // is in, and that record is what the next start resumes from.
    if (clients.size === 0 && agent && !agentIdleTimer) {
      agentIdleTimer = setTimeout(async () => {
        agentIdleTimer = null;
        if (clients.size > 0 || !agent) return;
        await recordCurrentSession(8000);
        if (clients.size > 0) return;   // somebody came back while we waited
        killTree(agent);
        agent = null;
      }, IDLE_KILL_MS);
      if (agentIdleTimer.unref) agentIdleTimer.unref();
    }
  });
});

// Keepalive: ping every client every 30s and terminate any that miss a round.
// The browser/WebView answers pings automatically, so a pong proves the whole
// path (page -> WebView -> bridge) is alive. This is what lets both ends
// notice a half-open connection: the client side runs its own liveness
// heartbeat (web/app.js) and auto-reconnects.
setInterval(() => {
  for (const ws of clients) {
    if (ws.readyState !== ws.OPEN) continue;
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* socket already closing */ }
  }
}, 30000);

// A failed listen() (usually EADDRINUSE from an older bridge still running)
// must produce a readable message instead of a stack trace.
//
// The error is delivered on both objects: `ws` re-emits the http server's
// 'error' event on the WebSocketServer, and it registers that forwarder first -
// so without a listener on the WebSocketServer the unhandled 'error' throw
// happens before the http server's own handler ever runs.
let listening = false;
function onFatalServerError(err) {
  if (listening) {
    // Already serving - a stray socket error must not take the bridge down.
    console.error('socket error (ignored):', (err && err.message) || err);
    return;
  }
  if (err && err.code === 'EADDRINUSE') {
    console.error('');
    console.error(`  Port ${PORT} is already in use - another Pi Agent WebUI is probably`);
    console.error('  still running (maybe an old window you forgot about).');
    console.error('');
    console.error('  Either close that window, or free the port with:');
    console.error(`    netstat -ano | findstr :${PORT}`);
    console.error('    taskkill /PID <pid> /F');
    console.error('');
    console.error('  (start-webui.bat offers to stop the old one for you.)');
    console.error('');
    process.exit(1);
  }
  if (err && err.code === 'EACCES') {
    console.error(`  Cannot bind port ${PORT} - permission denied. Try a port above 1024.`);
    process.exit(1);
  }
  console.error('server error:', (err && err.message) || err);
  process.exit(1);
}

server.on('error', onFatalServerError);
wss.on('error', onFatalServerError);
// Same story one level up: a TCP connection that is reset before the request
// even parses (a browser that gave up on a slow one) arrives here. Without a
// listener Node prints it and, for some codes, tears the process down.
server.on('clientError', (err, socket) => {
  try { socket.destroy(); } catch { /* already gone */ }
});

server.listen(PORT, HOST, () => {
  listening = true;
  console.log(`Pi Agent WebUI`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  agent command : ${PI_COMMAND}`);
  console.log(`  workspace     : ${WORKSPACE_DIR}`);
  console.log(`  session dir   : ${SESSION_DIR}`);
  if (HOST === '0.0.0.0' || HOST === '::') {
    console.log('');
    console.log('  !! reachable from your network, not just this machine.');
    const lan = lanAddress();
    if (lan) console.log(`     from other devices on the LAN:  http://${lan}:${PORT}`);
    console.log('     Anyone on the LAN can drive this agent - there is no login.');
    console.log('     Set "lan": false in bridge/lan.json (or PI_WEBUI_HOST) to keep it local again.');
    console.log('');
  }
  console.log('  speech to text: browser by default; the local whisper.cpp server is');
  console.log('                  downloaded on first use (mic click or Settings > Voice)');
  if (process.env.AUTO_WHISPER === '1') {
    startWhisper(DEFAULT_MODEL).then((u) => { whisperUrl = u; });
  }
});

// ---------------------------------------------------------------- shutdown

// Ctrl+C (SIGINT) or a stop signal (SIGTERM) should cleanly stop the agent
// subprocesses and the whisper server instead of leaving them running in the
// background. The 'exit' handler is a synchronous last resort that also covers
// "close the console window" on Windows, where the signal handlers may not get
// a chance to run.
let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nStopping Pi Agent WebUI — killing agent processes…');
  /* Instances this bridge started live in their own process groups (issue
   * #268). Stop them first, while the event loop can still wait for the
   * health check that makes stop() safe against a reused pid. */
  try {
    try { if (stopStartedInstances) await stopStartedInstances(); } catch { /* keep shutting down */ }
    if (agent) killTree(agent);
    stopWhisper();
    try { server.close(); } catch { /* ignore */ }
  } finally {
    process.exit(code);
  }
}
const stopOnSignal = () => { shutdown(0).catch(() => process.exit(0)); };
process.on('SIGINT', stopOnSignal);
process.on('SIGTERM', stopOnSignal);
process.on('exit', () => {
  if (agent) {
    try {
      if (isWin) execSync(`taskkill /F /T /PID ${agent.pid}`, { stdio: 'ignore' });
      else agent.kill('SIGKILL');
    } catch { /* already gone */ }
  }
  try { stopWhisper(); } catch { /* ignore */ }
});

  return { agentStatus, setAgentMode, broadcast };
};
