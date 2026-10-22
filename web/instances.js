/*
 * Instances: the switcher, remote mode and the local bridge discovery.
 *
 * Split out of app.js (issue #54). Loaded before app.js; the names stay
 * global, so nothing else changed. Behaviour is unchanged.
 */
'use strict';

/* ── instances ────────────────────────────────────────────────────────────
 * Other pi agents (other machines, or a second bridge on this one) in the
 * sidebar. Switching opens that instance's own WebUI, so its name, picture and
 * every other setting stay with it - each bridge keeps its own settings file.
 * The dot comes from /api/health, the one endpoint that answers cross-origin. */
/* Bridges found running on this machine (issue #57). The page is served by the
 * local bridge, so this stays a direct call even while looking at a remote
 * instance: what it finds is what is running *here*. */
let localInstances = [];
let localInstancesAt = 0;
let localInstancesSig = '';
let instanceMenuAnchor = null;
/* Bridges this UI started (issue #79). The menu shows a stop control on those
 * and only those - a bridge started from a terminal is not ours to kill. */
let startedInstances = [];
let startedInstancesAt = 0;
let startedInstancesSig = '';

async function refreshStartedInstances(force) {
  const now = Date.now();
  if (!force && startedInstancesAt && now - startedInstancesAt < 10000) return startedInstances;
  startedInstancesAt = now;
  try {
    const d = await fetch(api('/api/local-started'), { cache: 'no-store' }).then((r) => r.json());
    const list = (d && d.started) || [];
    const sig = JSON.stringify(list.map((r) => [r.port, r.running]));
    startedInstances = list;
    if (sig !== startedInstancesSig) {
      startedInstancesSig = sig;
      if (openMenuEl && openMenuEl._instances && instanceMenuAnchor) openInstanceMenu(instanceMenuAnchor, true);
    }
  } catch { /* older bridge: no start/stop here */ }
  return startedInstances;
}

/* The record for a bridge URL's port, when this UI started it. */
function startedForUrl(url) {
  let port = null;
  try { const u = new URL(url); port = Number(u.port || (u.protocol === 'https:' ? 443 : 80)); } catch { return null; }
  return startedInstances.find((r) => Number(r.port) === port) || null;
}

async function startInstance(instance) {
  try {
    const body = instance ? JSON.stringify({ instance }) : '{}';
    const d = await fetch(api('/api/start-instance'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).then((r) => r.json());
    if (!d.ok) throw new Error(d.error || 'could not start');
    toast(`${instance ? 'Restarting' : 'Starting'} instance ${d.instance} on port ${d.port}…`);
    // It takes a moment: the launcher starts a bridge, which starts an agent.
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const found = await refreshLocalInstances(true);
      if (found.some((x) => Number(x.port) === Number(d.port))) { toast(`Instance ${d.instance} is up on port ${d.port}`); break; }
    }
    await refreshStartedInstances(true);
    if (openMenuEl && openMenuEl._instances && instanceMenuAnchor) openInstanceMenu(instanceMenuAnchor, true);
  } catch (e) {
    toast(`Could not start it: ${e.message}`, 'error');
  }
}

async function stopInstance(rec) {
  if (!rec) return;
  if (!confirm(`Stop the agent on port ${rec.port}?\n\nIt was started from this UI; whatever it is doing right now is lost.`)) return;
  try {
    const d = await fetch(api('/api/stop-instance'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port: rec.port }) }).then((r) => r.json());
    if (!d.ok) throw new Error(d.error || 'could not stop');
    toast(`Stopped the agent on port ${rec.port}`);
    await refreshStartedInstances(true);
    await refreshLocalInstances(true);
    if (openMenuEl && openMenuEl._instances && instanceMenuAnchor) openInstanceMenu(instanceMenuAnchor, true);
  } catch (e) {
    toast(`Could not stop it: ${e.message}`, 'error');
  }
}

async function refreshLocalInstances(force) {
  const now = Date.now();
  if (!force && localInstancesAt && now - localInstancesAt < 10000) return localInstances;
  localInstancesAt = now;
  try {
    const d = await fetch('/api/local-instances', { cache: 'no-store' }).then((r) => r.json());
    const list = (d && d.instances) || [];
    const sig = JSON.stringify(list);
    localInstances = list;
    if (sig !== localInstancesSig) {
      localInstancesSig = sig;
      // The menu is open: redraw it once with the new rows. Guarded by the
      // signature, so this settles instead of reopening forever.
      if (openMenuEl && openMenuEl._instances && instanceMenuAnchor) openInstanceMenu(instanceMenuAnchor, true);
    }
  } catch { /* older bridge: no discovery - the list itself still works */ }
  return localInstances;
}

/* Add a bridge found on this machine and look at it. One click is the point:
 * the address was only ever something to copy from a terminal. */
async function addFoundInstance(found) {
  const inst = { id: `i${Date.now().toString(36)}`, name: found.name || String(found.url).replace(/^https?:\/\//, ''), url: found.url };
  if (!allInstances().some((i) => i.url === inst.url)) {
    SET.instances = [...(SET.instances || []), inst];
    // The proxy only forwards to origins this bridge knows about, so wait for
    // its settings copy before switching into it.
    await saveSettings();
  }
  toast(`${inst.name} added — switching`);
  enterRemoteMode(inst);
}

function localInstance() { return { id: 'local', name: (SET.agentName || '').trim() || 'this machine', url: location.origin }; }
function allInstances() {
  const out = [localInstance()];
  for (const i of SET.instances || []) if (i && i.url) out.push(i);
  return out;
}
function instanceStatus(url) {
  return S.instanceStatus[url === location.origin ? 'local' : url] || null;
}

async function pollInstances() {
  // Discovery rides along with the health poll: by the time the switcher is
  // clicked, the bridges on this machine are usually already listed.
  refreshLocalInstances().catch(() => {});
  await Promise.all(allInstances().map(async (inst) => {
    const key = inst.url === location.origin ? 'local' : inst.url;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 4000);
      const d = await fetch(`${inst.url}/api/health`, { signal: ctl.signal, cache: 'no-store' }).then((r) => r.json());
      clearTimeout(t);
      S.instanceStatus[key] = { ok: !!d.ok, busy: !!d.busy, name: d.name || null, at: Date.now() };
    } catch {
      S.instanceStatus[key] = { ok: false, busy: false, at: Date.now() };
    }
  }));
  updateInstanceBtn();
  if (openMenuEl && openMenuEl._instances) refreshInstanceMenuInPlace(openMenuEl);
}

/* The other instance's name and picture, for the switcher. /api/instance-card
 * answers cross-origin (like /api/health), so this works before switching. */
/* Asking each instance who it is. Concurrent calls share one round of requests:
 * the menu, the poll and the switcher itself all want this, and a call that
 * triggers another call is how this turned into an endless fetch loop (Firefox
 * said so out loud, and the page had to be closed). */
let instanceCardsPromise = null;
function refreshInstanceCards() {
  if (instanceCardsPromise) return instanceCardsPromise;
  instanceCardsPromise = loadInstanceCards().finally(() => { instanceCardsPromise = null; });
  return instanceCardsPromise;
}

async function loadInstanceCards() {
  await Promise.all(allInstances().map(async (inst) => {
    if (inst.url === location.origin) return;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 4000);
      // Through *this* bridge's proxy, not straight at the other machine: a direct
      // cross-origin fetch needs that bridge to send the right header, and an older
      // one (or a machine behind anything) simply never answers - which is why the
      // other instance's picture was missing from the switcher while switching to
      // it showed the picture fine (that path already went through the proxy).
      const via = api(`/proxy/${encodeURIComponent(inst.url)}/api/instance-card`);
      const d = await fetch(via, { signal: ctl.signal, cache: 'no-store' }).then((r) => r.json());
      clearTimeout(t);
      if (d && d.ok) S.instanceCards[inst.url] = d;
      // The card may carry no picture at all (nothing set there, or an older
      // bridge): fall back to that instance's settings, through the proxy.
      if (d && d.ok && !d.avatar && S.remote === inst.url) loadRemoteLook().catch(() => {});
    } catch { /* unreachable: keep whatever we had */ }
  }));
}

function instanceAvatar(inst) {
  if (!inst) return null;
  if (inst.url === location.origin) {
    const own = SET.avatar || null;
    // the same rule as below: these rows are <img>s
    return own && isVideoSrc(own) ? avatarStillSrc(own) : own;
  }
  const card = S.instanceCards[inst.url];
  const src = (card && card.avatar) || inst.avatar || null;
  if (!src) return null;
  // A picture stored on the other machine is a relative "/api/bg-file?name=..."
  // URL, which this page would ask *this* machine for - that is the broken image
  // in the instance list. Anything not already inline goes through the proxy, so
  // the local bridge fetches it (and an old remote, or one whose media route
  // needs a header, still shows up).
  let url = null;
  if (/^(data:|blob:)/i.test(src)) url = src;
  else if (/^https?:/i.test(src)) {
    try { const u = new URL(src); url = `/proxy/${encodeURIComponent(inst.url)}${u.pathname}${u.search}`; } catch (e) { /* odd url */ }
  }
  if (!url) url = `/proxy/${encodeURIComponent(inst.url)}${src.startsWith('/') ? src : `/${src}`}`;
  // These rows draw an <img>, and an <img> cannot show a video: a video pfp is
  // what produced the broken image in the instance list. Use the still frame the
  // avatar code captures (and re-draws once it exists).
  return isVideoSrc(url) ? avatarStillSrc(url) : url;
}

function updateInstanceBtn() {
  const btn = $('btn-instance');
  if (!btn) return;
  const nameEl = $('instance-name');
  const subEl = $('instance-sub');
  const cur = S.remote ? (S.remoteName || S.remote) : ((SET.agentName || '').trim() || 'this machine');
  if (nameEl) nameEl.textContent = cur;
  const st = instanceStatus(S.remote || location.origin);
  if (subEl) {
    const others = allInstances().length - 1;
    subEl.textContent = S.remote
      ? (st && st.busy ? 'another instance · working' : st && st.ok === false ? 'another instance · unreachable' : 'another instance')
      : `this machine${others ? ` · ${others} other${others > 1 ? 's' : ''}` : ''}`;
  }
  btn.title = S.remote
    ? `Looking at ${cur} — click to switch back or elsewhere`
    : 'pi agent instances - click to switch or add another one';
  btn.classList.toggle('remote', !!S.remote);
  updateRemoteBanner();
}

/* ── looking at another instance without leaving this one ─────────────────
 * The local bridge proxies to it (/proxy/<origin>/...), so the page stays on this
 * origin: the switcher keeps working even when that machine is off, which is the
 * difference between a dead end and a click back. */
async function enterRemoteMode(inst) {
  if (!inst) return;
  if (inst.url === location.origin) return exitRemoteMode();
  let origin;
  try { origin = new URL(inst.url).origin; } catch { toast('That instance URL does not look right', 'error'); return; }
  S.remote = origin;
  S.remoteName = inst.name || origin;
  try { sessionStorage.setItem('piwebui-remote', JSON.stringify({ url: origin, name: S.remoteName })); } catch { /* private mode */ }
  closeMenu();
  toast(`Looking at ${S.remoteName} (through this machine)`);
  await reloadForInstance();
}

function exitRemoteMode() {
  if (!S.remote) return;
  S.remote = null;
  S.remoteName = null;
  try { sessionStorage.removeItem('piwebui-remote'); } catch { /* ignore */ }
  toast('Back to this machine');
  reloadForInstance();
}

/* Everything on screen comes from whichever instance we are looking at, so the
 * socket is reopened (through the proxy) and the whole UI re-read.
 *
 * The socket *is* the agent connection, and it used to be closed through a name
 * that does not exist here - so the old (local) socket stayed open, connect()
 * saw an open socket and did nothing, and from then on the HTTP calls went to the
 * new instance while every RPC still went to the old agent. That is what made
 * "+ new" create the session on the wrong machine. Closing S.ws and clearing it
 * first is the whole fix for that; the rest is dropping the state that belonged
 * to the instance we just left. */
async function reloadForInstance() {
  try { if (S.ws) { S.ws.onclose = null; S.ws.onerror = null; S.ws.close(); } } catch { /* already gone */ }
  S.ws = null;
  // The instance's look (name, picture, background) before anything is drawn.
  S.remoteLook = null;
  S.viewSession = null;
  S.viewSubagent = null;
  S.subagents = new Map();
  S.subagentsFor = null;
  S.sessionsList = [];
  S.forkEntries = [];
  S.compactionMarks = [];
  S.compactionLive = null;
  S.compacting = false;
  S.ctxStats = null;
  S.ctxDisplayTokens = null;
  S.ctxBaseTokens = null;
  S.ctxTurnPeak = 0;
  S.totals = { read: 0, write: 0 };
  S.lastTurn = null;
  S.runStartTs = null;
  S.runMs = null;
  S.state = {};
  S.queue = { steering: [], followUp: [] };
  S.isStreaming = false;
  document.body.classList.remove('compacting');
  // The streaming message - and the parked DOM of the instance we are leaving -
  // must go with it. Keeping S.live meant the *old* agent's half-written answer
  // was re-attached to the new instance's chat (refreshMessages restores the
  // parked fragment) and kept being updated, so it looked like the other machine's
  // agent was typing into this conversation.
  try { if (S.live && S.live.root) releaseVideosIn(S.live.root); } catch { /* not rendered yet */ }
  try {
    if (S.liveDetached && S.liveDetached.frag) {
      S.liveDetached.frag.childNodes.forEach((n) => releaseVideosIn(n));
      S.liveDetached.frag.replaceChildren();
    }
  } catch { /* nothing parked */ }
  S.live = null;
  S.liveDetached = null;
  S.toolCards = new Map();
  S.thinkingEl = null;
  try { $('chat').replaceChildren(); } catch { /* nothing rendered yet */ }
  try { renderQueue(); updateStreamUi(); updateViewBanner(); } catch { /* not wired yet */ }
  updateSubagentsBtn();
  syncSessionHighlight();
  // The other instance's identity (and its background), then reconnect: the
  // socket's onopen runs the whole init against the new one.
  await loadRemoteLook().catch(() => {});
  // Unconditionally, both directions: on the way *back* loadRemoteLook() returns
  // early, and the picture and background would have stayed the other instance's.
  applySettings();
  updateInstanceBtn();
  connect();
}

function updateRemoteBanner() {
  const b = $('remote-banner');
  if (!b) return;
  if (!S.remote) { b.classList.add('hidden'); b.textContent = ''; return; }
  const st = instanceStatus(S.remote);
  // The socket is the honest signal here: an instance that is switched off has no
  // status to read (it never appears in the poll), but there is nothing connected.
  const down = (!S.ws || S.ws.readyState !== 1) || (st && st.ok === false);
  b.classList.remove('hidden');
  b.replaceChildren();
  b.appendChild(el('span', null,
    `Looking at “${S.remoteName || S.remote}” — sessions, chat and models are that machine's.`
    + (down ? ' It is not answering right now.' : '')));
  const back = el('button', 'btn small', 'switch back to this machine');
  back.onclick = () => exitRemoteMode();
  b.appendChild(back);
}

/* The start control the menu rows carry for a bridge this UI stopped (#119). */
function startInstanceButton(rec) {
  const b = el('button', 'btn small', 'start');
  b.title = `Start instance ${rec.instance} again - port ${rec.port}, its own home`;
  b.dataset.startInstance = String(rec.instance);
  return b;
}

/* Forget a stopped instance's record. The home (sessions, auth, settings) stays
 * on disk - deleting it is a separate, explicit question (issue #119). */
function forgetInstanceButton(rec) {
  const b = el('button', 'btn small', 'forget');
  b.title = `Forget instance ${rec.instance} (its home stays on disk)`;
  b.dataset.forgetInstance = String(rec.instance);
  return b;
}

async function forgetInstance(rec) {
  if (!rec) return;
  if (!confirm(`Forget instance ${rec.instance}?\n\nThe record goes away. Its home (~/.pi/webui-instances/${rec.instance}) stays on disk.`)) return;
  try {
    const d = await fetch(api('/api/forget-instance'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instance: rec.instance }),
    }).then((r) => r.json());
    if (!d.ok) throw new Error(d.error || 'could not forget it');
    toast(`Forgot instance ${rec.instance}`);
    await refreshStartedInstances(true);
    await refreshLocalInstances(true);
    if (openMenuEl && openMenuEl._instances && instanceMenuAnchor) openInstanceMenu(instanceMenuAnchor, true);
  } catch (e) {
    toast(`Could not forget it: ${e.message}`, 'error');
  }
}

/* The stop control the menu rows carry for a bridge this UI started (#79). */
function stopInstanceButton(rec) {
  const b = el('button', 'btn small', 'stop');
  b.title = `Stop the agent on port ${rec.port} - it was started from this UI`;
  b.dataset.stopPort = String(rec.port);
  return b;
}

function openInstanceMenu(anchor, force) {
  instanceMenuAnchor = anchor;
  const items = [];
  for (const inst of allInstances()) {
    const st = instanceStatus(inst.url);
    const here = inst.url === location.origin;
    const looking = S.remote ? inst.url === S.remote : here;
    const card = S.instanceCards[inst.url];
    const rec = here ? null : startedForUrl(inst.url);
    items.push({
      avatar: instanceAvatar(inst),
      avatarPlaceholder: !instanceAvatar(inst),
      instanceUrl: inst.url,
      label: (looking ? '● ' : '') + inst.name + (!here && card && card.name ? `  (${card.name})` : ''),
      hint: here ? 'this machine' : String(inst.url).replace(/^https?:\/\//, ''),
      dot: st && st.busy ? 'live-dot' : (st && st.ok ? null : 'off-dot'),
      active: looking,
      // The control follows the record's live state (issue #138): a stopped
      // instance offered "stop" and no way back.
      trailing: rec ? (rec.running === false ? startInstanceButton(rec) : stopInstanceButton(rec)) : null,
      onTrailing: rec ? (rec.running === false ? () => startInstance(rec.instance) : () => stopInstance(rec)) : null,
      onPick: rec && rec.running === false ? () => startInstance(rec.instance) : () => (here ? exitRemoteMode() : enterRemoteMode(inst)),
      onContext: here ? null : (it, row) => openInstanceContextMenu(row, inst),
    });
  }
  // Bridges found running on this machine that are not in the list yet. The
  // cached list is used immediately; a fresh answer redraws once when it lands.
  refreshLocalInstances();
  refreshStartedInstances();
  const listed = new Set(allInstances().map((i) => i.url));
  for (const found of localInstances) {
    if (!found || !found.url || listed.has(found.url)) continue;
    const rec = startedForUrl(found.url);
    const stopped = !!rec && rec.running === false;
    const controls = stopped ? (() => { const c = el('span', 'menu-controls'); c.append(startInstanceButton(rec), forgetInstanceButton(rec)); return c; })() : null;
    items.push({
      label: `found: ${String(found.url).replace(/^https?:\/\//, '')}${rec ? (stopped ? '  (stopped here)' : '  (started here)') : ''}`,
      hint: stopped ? 'start it again, or forget the record' : (found.name || 'another pi agent on this machine - add and switch'),
      dot: stopped ? null : (found.busy ? 'live-dot' : null),
      trailing: stopped ? controls : (rec ? stopInstanceButton(rec) : null),
      onTrailing: stopped
        ? (it, e) => {
            const t = e && e.target;
            if (t && t.dataset && t.dataset.forgetInstance) forgetInstance(rec);
            else startInstance(rec.instance);
          }
        : (rec ? () => stopInstance(rec) : null),
      onPick: stopped ? () => startInstance(rec.instance) : () => addFoundInstance(found),
    });
  }
  /* Instances this UI started that are not running: their port is down, so
   * discovery cannot list them - the record is the only trace left, and it is
   * what carries the start control (issue #119). */
  for (const rec of startedInstances) {
    if (rec.running !== false) continue;
    const url = rec.url || `http://127.0.0.1:${rec.port}`;
    if (listed.has(url)) continue;
    const controls = el('span', 'menu-controls');
    controls.append(startInstanceButton(rec), forgetInstanceButton(rec));
    items.push({
      label: `stopped: ${String(url).replace(/^https?:\/\//, '')}  (instance ${rec.instance})`,
      hint: 'start it again, or forget the record',
      trailing: controls,
      onTrailing: (it, e) => {
        const t = e && e.target;
        if (t && t.dataset && t.dataset.forgetInstance) forgetInstance(rec);
        else startInstance(rec.instance);
      },
      onPick: () => startInstance(rec.instance),
    });
  }
  items.push({ sep: true });
  items.push({ label: 'start another agent on this machine…', hint: 'its own home and port, via the launcher', onPick: () => startInstance() });
  items.push({ label: 'add another pi agent…', hint: 'other machine or port', onPick: () => addInstance() });
  const menu = openMenu(anchor, items, { title: 'pi agents', width: 360, force, hint: 'right-click an instance to remove it' });
  if (menu) menu._instances = true;
  // Names and pictures arrive after the first open; redraw once they are in.
  // Pictures arrive a moment later. Update the rows that are on screen instead of
  // opening the menu again: re-opening re-ran this function, which fetched again,
  // which re-opened again - a loop with no yield, and the page stopped responding.
  refreshInstanceCards().then(() => {
    if (menu && menu.isConnected) refreshInstanceMenuInPlace(menu);
  }).catch(() => {});
}

/* Refresh what the open instance menu shows - the status dots and the pictures -
 * without touching its structure, so nothing the user is pointing at moves. */
function refreshInstanceMenuInPlace(menu) {
  menu = menu || (openMenuEl && openMenuEl._instances ? openMenuEl : null);
  if (!menu) return;
  for (const inst of allInstances()) {
    const row = menu.querySelector(`.model-item[data-instance="${cssEscape(inst.url)}"]`);
    if (!row) continue;
    const st = instanceStatus(inst.url);
    const dot = row.querySelector('.menu-dot');
    const wantDot = st && st.busy ? 'live-dot' : (st && st.ok ? null : 'off-dot');
    if (dot) {
      if (wantDot) dot.className = `menu-dot ${wantDot}`;
      else dot.remove();
    } else if (wantDot) {
      row.insertBefore(el('span', `menu-dot ${wantDot}`), row.querySelector('.model-label'));
    }
    setRowAvatar(row, instanceAvatar(inst));
  }
}

/* Swap the circle at the front of a row for the right picture, whether it is
 * currently a placeholder span or an img with a stale source. */
function setRowAvatar(row, src) {
  const current = row.querySelector('.menu-avatar');
  if (!src) {
    if (current && current.tagName === 'IMG') {
      const span = el('span', 'menu-avatar empty', '');
      current.replaceWith(span);
    }
    return;
  }
  if (current && current.tagName === 'IMG') {
    if (current.getAttribute('src') !== src) current.src = src;
    return;
  }
  const img = el('img', 'menu-avatar');
  img.alt = '';
  // A picture that cannot be fetched must not leave the "broken image" glyph in
  // the list: fall back to the same empty slot as "no picture".
  img.onerror = () => {
    const span = el('span', 'menu-avatar empty', '');
    span.title = 'picture could not be loaded';
    img.replaceWith(span);
  };
  img.src = src;
  if (current) current.replaceWith(img);
  else row.insertBefore(img, row.firstChild);
}

/* Attribute selectors need escaping: instance URLs are full of : and / . */
/* Right-click an instance: switch to it here, open its own page, or take it off
 * the list. Removal used to be a row at the bottom of the menu, which made the
 * list of agents double as a list of delete buttons. */
function openInstanceContextMenu(row, inst) {
  const items = [
    { label: `switch to ${inst.name} here`, hint: 'this window, through this machine', onPick: () => enterRemoteMode(inst) },
    { label: 'open its own page', hint: String(inst.url).replace(/^https?:\/\//, ''), onPick: () => openInstancePage(inst) },
    { sep: true },
    {
      label: `remove ${inst.name} from the list`,
      hint: 'stops showing up in the switcher',
      danger: true,
      onPick: async () => {
        const yes = await askDialog({
          title: `Remove “${inst.name}”?`,
          body: 'It stays reachable at its address; it just leaves this list.',
          okLabel: 'remove',
          danger: true,
        });
        if (!yes) return;
        SET.instances = (SET.instances || []).filter((x) => x.url !== inst.url);
        saveSettings();
        updateInstanceBtn();
        toast(`Removed ${inst.name}`);
      },
    },
  ];
  openMenu(row, items, { title: inst.name, width: 320, force: true, sub: true, at: { x: row.getBoundingClientRect().left, y: row.getBoundingClientRect().bottom } });
}

/* Opening the other instance's own page navigates away and hands the URL to the
 * other bridge, which adds us to its list so there is a way back. */
function openInstancePage(inst) {
  const me = (SET.agentName || '').trim() || 'this machine';
  const sep = inst.url.includes('?') ? '&' : '?';
  location.href = `${inst.url}${sep}from=${encodeURIComponent(location.origin)}&fromName=${encodeURIComponent(me)}`;
}

function switchInstance(inst) {
  if (!inst || inst.url === location.origin) return exitRemoteMode();
  return enterRemoteMode(inst);
}

/* An instance opened through the switcher arrives with ?from=… - add it to the
 * list so the switcher can go back. Runs once, from updateInstanceBtn. */
let absorbedFrom = false;
function absorbFromParam() {
  if (absorbedFrom) return;
  let params;
  try { params = new URL(location.href).searchParams; } catch { absorbedFrom = true; return; }
  const from = params.get('from');
  if (!from) { absorbedFrom = true; return; }
  // Only now is it safe to touch the list: called before the settings arrive,
  // SET was replaced wholesale a moment later and the new entry was lost.
  absorbedFrom = true;
  let base;
  try { base = new URL(from).origin; } catch { return; }
  const name = params.get('fromName') || base;
  if (base && base !== location.origin && !allInstances().some((i) => i.url === base)) {
    SET.instances = [...(SET.instances || []), { id: `i${Date.now().toString(36)}`, name, url: base }];
    saveSettings();
    toast(`Added "${name}" to the instance list so you can switch back`);
  }
  try { history.replaceState(null, '', location.pathname); } catch { /* ignore */ }
}

function addInstance() {
  askDialog({
    title: 'Add another pi agent',
    body: 'Its WebUI address. Add an SSH tunnel or start that bridge with PI_WEBUI_HOST=0.0.0.0 to reach another machine.',
    fields: [
      { name: 'name', label: 'name', placeholder: 'laptop' },
      { name: 'url', label: 'address', placeholder: 'http://192.168.1.20:3080', value: 'http://' },
    ],
    require: ['name', 'url'],
    okLabel: 'add',
  }).then((res) => {
    if (!res) return;
    let url = String(res.url).trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(url)) url = `http://${url}`;
    let base;
    try { base = new URL(url).origin; } catch { toast('That is not a valid address', 'error'); return; }
    if (allInstances().some((i) => i.url === base)) { toast('That instance is already in the list', 'warning'); return; }
    SET.instances = [...(SET.instances || []), { id: `i${Date.now().toString(36)}`, name: res.name, url: base }];
    saveSettings();
    updateInstanceBtn();
    toast(`${res.name} added - click it to switch`);
    pollInstances().catch(() => {});
  });
}
