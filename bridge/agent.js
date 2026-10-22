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
    hostOnly,
    hostSpawnDir,
    isWin,
    http,
    lanAddress,
    loadLastSession,
    path,
    proxyWss,
    saveLastSession,
    server,
    sessionFileExists,
    spawn,
    splitProxyPath,
    startWhisper,
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
const clients = new Set();      // connected sockets
// A reload closes the old socket and opens a new one a moment later. Killing the
// agent on the first close meant every reload restarted pi, and a reload right
// after sending a message could kill it before that message's session file had
// been written - the session then looked like it had vanished. Wait for the
// reconnect instead; a browser that really is closed still kills it, a few
// seconds later.
const IDLE_KILL_MS = parseInt(process.env.PI_WEBUI_IDLE_KILL_MS || '25000', 10);
let agentIdleTimer = null;
// rpc request id -> { ws, type, sessionPath }: the socket that sent it (the
// response is routed back to it, not broadcast - ids are only unique per
// client), plus the command so the bridge can track session changes.
const pendingOwner = new Map();
// RPCs issued by the bridge itself (session bookkeeping): their responses are
// consumed here instead of being routed to a client socket.
const bridgePending = new Map(); // request id -> { resolve, reject }
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
    saveLastSession(owner.sessionPath);
  } else if ((cmd === 'prompt' || cmd === 'new_session' || cmd === 'fork' || cmd === 'clone') && !cancelled) {
    // A prompt can be the first thing that creates a session file, and its path
    // is reported nowhere else - re-read it, so the record matches the session
    // the message actually landed in.
    bridgeRpc({ type: 'get_state' }, 15000)
      .then((st) => { if (st && st.sessionFile) saveLastSession(st.sessionFile); })
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
  if (sf) agentStatus.sessionFile = sf;
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

let agentRestarts = [];
let agentRestartTimer = null;

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

function startAgent() {
  if (agent) return agent;

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
   * still goes through the switch below, because the file lives in there. */
  let resumePath = null;
  if (!SESSION_DIR.startsWith('docker:')) {
    try {
      const last = loadLastSession();
      if (last && fs.existsSync(last)) resumePath = last;
    } catch { /* no record, or no fs to check with: start fresh */ }
  }
  const command = resumePath ? `${PI_COMMAND} --session ${shellArg(resumePath)}` : PI_COMMAND;
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
          if (DEBUG_RPC) console.log(`[rpc] -> ${parsed.command || owner.type}${parsed.success ? '' : ' FAILED: ' + (parsed.error || '')}`);
          wsSend(owner.ws, { bridge: 'rpc', payload: parsed });
          trackSessionChange(parsed, owner);
          continue;
        }
      }
      broadcast({ bridge: 'rpc', payload: parsed });
    }
  });

  child.stderr.on('data', (d) => {
    if (child !== agent) return;
    broadcast({ bridge: 'agent_stderr', text: d.toString('utf8') });
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
    failBridgePending('agent exited');
    console.log(`agent exited (code ${code}${signal ? ', signal ' + signal : ''})`);
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
    workspace: WORKSPACE_DIR,
    sessionDir: SESSION_DIR,
  });
  // A fresh agent starts a brand-new empty session; put it back in the one the
  // user was in. Called from here, before this start returns, so the switch is
  // the first command on the pipe and no client can get in front of it.
  if (resumePath) {
    // already in it: there is nothing to switch to
    lastResumed = resumePath;
    console.log(`started in the last session: ${resumePath}`);
    broadcast({ bridge: 'session_resumed', path: resumePath });
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
      saveLastSession(st.sessionFile);
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
  const last = loadLastSession();
  if (!last) { recordCurrentSession(); return; }
  // Ask whether the file is still there *before* switching: a record left behind
  // by a session that has since been deleted (or by another bridge that used a
  // different session dir) used to produce a failed switch, a "could not reopen
  // your last session" toast and - with a pi that does not answer - a wedged
  // agent that had to be restarted. None of that is a resume.
  sessionFileExists(last).then((exists) => {
    if (exists) return resumeInto(last);
    console.warn(`forgetting last session (gone): ${last}`);
    forgetLastSession();
    recordCurrentSession();
  }).catch(() => resumeInto(last));   // a docker failure: let the agent decide
}

function resumeInto(last) {
  bridgeRpc({ type: 'switch_session', sessionPath: last }, 30000)
    .then(() => {
      console.log(`resumed last session: ${last}`);
      lastResumed = last;
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
      sessionFileExists(last)
        .then((exists) => { if (!exists) broadcast({ bridge: 'session_resume_failed', path: last }); })
        .catch(() => { /* container gone; nothing to report */ });
    });
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
  // connections (sleep/wake, WebView2 network hiccups) linger in `clients`
  // forever, so "last one out turns off the lights" never fires for a client
  // that is actually gone.
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  // A client socket error must not take the bridge down — an unhandled
  // 'error' event would crash the process and drop every other client.
  ws.on('error', () => { /* 'close' follows */ });
  startAgent();
  // Tell the newcomer where it is, and let it pull the current state itself.
  wsSend(ws, {
    bridge: 'agent_started',
    command: PI_COMMAND,
    workspace: WORKSPACE_DIR,
    sessionDir: SESSION_DIR,
  });
  // ... and which session the agent was put back into, in case this page missed
  // the broadcast while it was still connecting.
  if (lastResumed) wsSend(ws, { bridge: 'session_resumed', path: lastResumed });

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
    if (agent && agent.stdin.writable) {
      // Remember who asked (and what they asked), so the response goes back
      // to them and not to everybody (ids are only unique per client), and
      // session-changing commands keep the last-session record current.
      if (DEBUG_RPC) console.log(`[rpc] <- ${msg.type}${msg.sessionPath ? ' ' + msg.sessionPath : ''}`);
      if (msg.id) pendingOwner.set(msg.id, { ws, type: msg.type, sessionPath: msg.sessionPath });
      agent.stdin.write(JSON.stringify(msg) + '\n');
    } else {
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
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nStopping Pi Agent WebUI — killing agent processes…');
  if (agent) killTree(agent);
  stopWhisper();
  try { server.close(); } catch { /* ignore */ }
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('exit', () => {
  if (agent) {
    try {
      if (isWin) execSync(`taskkill /F /T /PID ${agent.pid}`, { stdio: 'ignore' });
      else agent.kill('SIGKILL');
    } catch { /* already gone */ }
  }
  try { stopWhisper(); } catch { /* ignore */ }
});

  return { agentStatus };
};
