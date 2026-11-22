/*
 * Settings that talk to pi and its first-run services: auto-compaction, the
 * compaction threshold, images.blockImages and SearXNG. Split out of
 * settings-ui.js (issue #263). Loaded before settings-ui.js; the names stay
 * global.
 */
'use strict';

/* pi's own auto-compaction, changed over RPC (issue #56). pi persists it in
 * settings.json, so the checkbox reads the bridge's copy of that file and the
 * RPC is what applies it live. */
/* The slider is a position in this sparse list, not an absolute token count.
 * It doubles from 2K to 128K, then follows 256K, 512K and the 1M cap. That is
 * ten useful stops instead of every integer from 2K to 1M. The
 * number beside it can be clicked to type any exact value. */
const COMPACTION_THRESHOLD_STEPS = [2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1000000];
let compactionThresholdValue = 16384;

function compactionThresholdIndex(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return COMPACTION_THRESHOLD_STEPS.indexOf(16384);
  let best = 0;
  for (let i = 1; i < COMPACTION_THRESHOLD_STEPS.length; i++) {
    if (Math.abs(COMPACTION_THRESHOLD_STEPS[i] - n) < Math.abs(COMPACTION_THRESHOLD_STEPS[best] - n)) best = i;
  }
  return best;
}

function showCompactionThreshold(value) {
  const slider = $('set-pi-compaction-threshold');
  const label = $('set-pi-compaction-threshold-val');
  if (!slider) return;
  const n = Number.isFinite(Number(value)) ? Number(value) : 16384;
  compactionThresholdValue = n;
  slider.min = '0';
  slider.max = String(COMPACTION_THRESHOLD_STEPS.length - 1);
  slider.value = String(compactionThresholdIndex(n));
  if (label) label.textContent = `${n.toLocaleString('en-US')} tokens free`;
  slider.title = 'pi compacts when the free context falls below this many tokens (settings.json compaction.reserveTokens)';
}

function setPiCompactionThreshold(d) {
  const slider = $('set-pi-compaction-threshold');
  if (!slider) return;
  const c = (d && d.compaction) || {};
  const n = Number.isFinite(Number(c.reserveTokens)) ? Number(c.reserveTokens) : 16384;
  showCompactionThreshold(n);
  slider.disabled = false;
}

/* Issue #214: the image toggle is pi's own setting (images.blockImages). It is
 * saved through the same route as the compaction one, so the file pi reads is
 * the file the page writes. */
async function savePiBlockImages(on) {
  const note = $('set-pi-block-images-note');
  try {
    const r = await fetch(api('/api/pi-config'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images: { blockImages: on } }),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || `request failed (${r.status})`);
    if (note) note.textContent = ' saved to pi\'s settings — /reload (or restarting pi) applies it';
  } catch (err) {
    if (note) note.textContent = '';
    toast(`Could not save pi's image setting: ${err.message}`, 'error');
  }
}
if ($('set-pi-block-images')) {
  $('set-pi-block-images').onchange = (e) => savePiBlockImages(e.target.checked);
}

async function loadPiConfig() {
  const box = $('set-pi-compaction');
  const slider = $('set-pi-compaction-threshold');
  const imgBox = $('set-pi-block-images');
  if (!box) return;
  try {
    const d = await fetch(api('/api/pi-config'), { cache: 'no-store' }).then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
    box.checked = !(d && d.compaction && d.compaction.enabled === false);
    box.disabled = false;
    box.title = 'pi compacts the context itself when it passes the threshold (set_auto_compaction) — this is separate from the auto-continue above';
    setPiCompactionThreshold(d);
    setPiCompactionNote('');
    if (imgBox) {
      imgBox.checked = !!(d && d.images && d.images.blockImages === true);
      imgBox.disabled = false;
      imgBox.title = 'pi will not read images and attachments are not sent to the model (settings.json images.blockImages)';
      const n = $('set-pi-block-images-note');
      if (n) n.textContent = '';
    }
  } catch {
    /* An old bridge has no /api/pi-config at all (issue #91): the checkbox
     * could neither read nor write, and a disabled control with no explanation
     * is exactly the "random not working button" from the report. Say what to
     * do instead. */
    box.checked = false;
    box.disabled = true;
    box.title = '';
    if (slider) slider.disabled = true;
    if (imgBox) { imgBox.checked = false; imgBox.disabled = true; imgBox.title = ''; }
    setPiCompactionNote('this bridge is running an older build — restart it to use this setting');
  }
}
/* pi-searxng's config is ~/.pi/searxng.json; the bridge writes it and can prove
 * the endpoint answers. Without this the setup wizard installed a search
 * extension that could only fail with the default localhost:8080 (issue #198). */
async function loadSearxngConfig() {
  const input = $('set-searxng-url');
  if (!input) return;
  try {
    const d = await fetch(api('/api/searxng-config'), { cache: 'no-store' }).then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
    input.value = d.url || 'http://localhost:8080';
    input.disabled = false;
    setSearxngNote(`saved in ${d.file || '~/.pi/searxng.json'}`);
  } catch {
    input.disabled = true;
    setSearxngNote('this bridge is running an older build — restart it to configure SearXNG');
  }
}
function setSearxngNote(text) {
  const n = $('set-searxng-note');
  if (n) n.textContent = text || '';
}
async function saveSearxngConfig(test) {
  const input = $('set-searxng-url');
  if (!input) return;
  const url = input.value.trim();
  if (!url) { setSearxngNote('enter the URL of a running SearXNG instance'); return; }
  input.disabled = true;
  try {
    const r = await fetch(api('/api/searxng-config'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ searxngUrl: url, test: test === true }),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || `request failed (${r.status})`);
    input.value = d.url;
    if (d.test && d.test.ok) setSearxngNote(`saved — SearXNG answered (${d.test.results} result${d.test.results === 1 ? '' : 's'})`);
    else if (d.test && !d.test.ok) setSearxngNote(`saved, but the test failed: ${d.test.error}`);
    else setSearxngNote('saved — use test to check the endpoint');
    toast(test ? 'SearXNG endpoint tested' : 'SearXNG URL saved');
  } catch (err) {
    setSearxngNote(`could not save: ${err.message}`);
    toast(`SearXNG: ${err.message}`, 'error');
  } finally { input.disabled = false; }
}

function setPiCompactionNote(text) {
  const n = $('set-pi-compaction-note');
  if (n) n.textContent = text || '';
}
$('set-pi-compaction').onchange = async (e) => {
  const enabled = e.target.checked;
  e.target.disabled = true;
  try {
    await rpc({ type: 'set_auto_compaction', enabled });
    toast(`pi auto-compaction ${enabled ? 'enabled' : 'disabled'}`);
  } catch (err) {
    e.target.checked = !enabled;   // pi refused: do not show a state that is not there
    toast(`Could not change pi's auto-compaction: ${err.message}`, 'error');
  } finally { e.target.disabled = false; }
};

/* Issue #194: the auto-compaction threshold. pi has no RPC for reserveTokens;
 * the bridge writes pi's settings.json and the value is read back from there. */
async function savePiCompactionThreshold(value) {
  const slider = $('set-pi-compaction-threshold');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 2048 || n > 1000000) {
    toast('The compaction threshold must be a whole number from 2,048 to 1,000,000', 'warning');
    return;
  }
  if (slider) slider.disabled = true;
  try {
    const r = await fetch(api('/api/pi-config'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ compaction: { reserveTokens: n } }),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || `request failed (${r.status})`);
    setPiCompactionThreshold(d);
    toast(`pi will compact when ${n.toLocaleString('en-US')} tokens are left — takes effect when pi reloads`);
    setPiCompactionNote('saved — /reload (or restarting pi) applies the new threshold');
  } catch (err) {
    toast(`Could not save the compaction threshold: ${err.message}`, 'error');
  } finally { if (slider) slider.disabled = false; }
}

if ($('set-pi-compaction-threshold')) {
  const slider = $('set-pi-compaction-threshold');
  const label = $('set-pi-compaction-threshold-val');
  const manual = $('set-pi-compaction-threshold-manual');
  const showThreshold = () => {
    const n = Number(COMPACTION_THRESHOLD_STEPS[Number(slider.value)]);
    showCompactionThreshold(Number.isFinite(n) ? n : 16384);
  };
  slider.addEventListener('input', showThreshold);
  slider.addEventListener('change', () => savePiCompactionThreshold(compactionThresholdValue));

  const beginManual = () => {
    if (!manual || !label || slider.disabled) return;
    manual.value = String(compactionThresholdValue);
    manual.classList.remove('hidden');
    label.classList.add('hidden');
    manual.focus();
    manual.select();
  };
  const finishManual = (keep) => {
    if (!manual || manual.classList.contains('hidden')) return;
    manual.classList.add('hidden');
    label.classList.remove('hidden');
    if (!keep) { showCompactionThreshold(compactionThresholdValue); return; }
    const n = Number(manual.value);
    if (!Number.isSafeInteger(n) || n < 2048 || n > 1000000) {
      toast('The compaction threshold must be a whole number from 2,048 to 1,000,000', 'warning');
      showCompactionThreshold(compactionThresholdValue);
      return;
    }
    showCompactionThreshold(n);
    savePiCompactionThreshold(n);
  };
  label.addEventListener('click', beginManual);
  label.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); beginManual(); }
  });
  manual.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finishManual(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finishManual(false); }
  });
  manual.addEventListener('blur', () => finishManual(true));
}

if ($('set-searxng-url')) {
  $('set-searxng-url').onchange = () => saveSearxngConfig(false);
  $('btn-searxng-test').onclick = () => saveSearxngConfig(true);
  /* The first-run wizard is not the only way in: if it was skipped, or search
   * was not set up then, this installs/starts it from Settings. Docker is used
   * when available; otherwise the bridge's private Python install is used. */
  $('btn-searxng-setup').onclick = async () => {
    const input = $('set-searxng-url');
    const btn = $('btn-searxng-setup');
    if (!input || !btn) return;
    btn.disabled = true;
    btn.textContent = 'setting up…';
    setSearxngNote('setting up a local SearXNG (the first run may install it)…');
    try {
      const r = await fetch(api('/api/websearch-setup'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', camoufox: false }),
      });
      if (r.status === 404) throw new Error('this bridge is an older build — restart it first');
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || `request failed (${r.status})`);
      input.value = d.url;
      const n = d.test && Number.isFinite(d.test.results) ? d.test.results : 0;
      setSearxngNote(`saved in ~/.pi/searxng.json — SearXNG answers (${n} result${n === 1 ? '' : 's'})`);
      toast(`SearXNG is ready at ${d.url}`);
      if (typeof loadSearxngConfig === 'function') loadSearxngConfig().catch(() => {});
    } catch (err) {
      setSearxngNote(`could not set up SearXNG: ${err.message}`);
      toast(`SearXNG: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'set up';
    }
  };
}

/* settings tabs */
document.querySelectorAll('#settings-tabs .tab').forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll('#settings-tabs .tab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('#settings-dialog .tab-panel').forEach((p) => {
      p.classList.toggle('hidden', p.id !== `tab-${t.dataset.tab}`);
    });
    /* Only this tab wants the llama probe; asking for it when the tab is
     * actually shown is what keeps Settings from probing on every open
     * (issue #106). */
    if (t.dataset.tab === 'providers' && typeof loadPiProviders === 'function') loadPiProviders();
  };
});

/* ── first-launch setup ──────────────────────────────────────────────────
 * The one dialog everybody sees once: who the agent is, how it looks, how it
 * should tell you it is done, and whether other devices may reach it. Everything
 * here is also in Settings - the point is not to make people configure a UI
 * before they can type, it is that the handful of things worth choosing up front
 * (a name, a face, a readable text size, notifications, network access) are
 * actually offered. */
let setupLanWas = null;

function setSetupGamerVisible(on) {
  const row = $('setup-gamer-speed-row');
  const label = $('setup-gamer-speed-label');
  if (row) row.classList.toggle('hidden', !on);
  if (label) label.classList.toggle('hidden', !on);
}

function refreshSetupPreview() {
  const prev = $('setup-avatar-preview');
  if (!prev) return;
  if (SET.avatar) {
    const node = avatarNode(undefined, true);
    prev.replaceChildren(...node.childNodes);
    prev.style.visibility = 'visible';
  } else {
    prev.replaceChildren();
    prev.style.visibility = 'hidden';
  }
}

/* The first-run packages step (issue #121): what each package is for, with the
 * ones already in settings.json ticked and locked. The ticked ones are installed
 * when the wizard finishes, and the agent is restarted to pick them up. */
const SETUP_PACKAGES = [
  { source: 'npm:pi-searxng', label: 'Web search', note: 'needs a running SearXNG instance - set its URL in Settings → General → Web search. Camoufox is only for browsing, not search:', links: [['searxng', 'https://github.com/searxng/searxng'], ['camoufox', 'https://github.com/daijro/camoufox']] },
  { source: 'npm:pi-llama-cpp', label: 'Local AI', note: 'point pi at a llama.cpp server - recommended when one is running' },
  { source: 'npm:pi-goal-x', label: 'Goals', note: 'the goal bar, goal records and the goal tools' },
  { source: 'npm:pi-subagents', label: 'Subagents', note: 'run delegated child agents' },
];

function setupShowStep(step) {
  const packages = step === 'packages';
  $('setup-step-packages').classList.toggle('hidden', !packages);
  $('setup-step-prefs').classList.toggle('hidden', packages);
  $('setup-done').textContent = packages ? 'next' : "Let's go";
}

async function renderSetupPackages() {
  const box = $('setup-packages-list');
  if (!box) return;
  box.innerHTML = '';
  let installed = [];
  try {
    const d = await fetch(api('/api/pi-extensions'), { cache: 'no-store' }).then((r) => r.json());
    installed = (d.packages || []).map((p) => String(p.source || ''));
  } catch { /* offline: show them all as not installed */ }
  for (const p of SETUP_PACKAGES) {
    const isIn = installed.includes(p.source);
    const row = el('label', 'check-label');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = isIn;
    cb.disabled = isIn;
    cb.dataset.package = p.source;
    row.appendChild(cb);
    row.appendChild(el('span', null, `${p.label} — ${p.source}${isIn ? ' (installed)' : ''}`));
    box.appendChild(row);
    const note = el('div', 'hint', p.note);
    for (const [text, href] of p.links || []) {
      const a = el('a', null, text);
      a.href = href;
      a.target = '_blank';
      a.rel = 'noreferrer';
      note.appendChild(document.createTextNode(' '));
      note.appendChild(a);
    }
    box.appendChild(note);
  }
}

/* Issue #218: installing pi-searxng is not search working. This asks the bridge
 * to point it at an instance that answers - reusing one already running, or
 * starting the official image with JSON enabled - and to fetch Camoufox, which
 * is what reads the pages afterwards. Both steps report what they did. */
function setWebsearchStatus(text) {
  const n = $('setup-websearch-status');
  if (n) n.textContent = text || '';
}

async function pollCamoufox(done, line) {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    let d = null;
    try { d = await fetch(api('/api/websearch-setup'), { cache: 'no-store' }).then((r) => r.json()); } catch { continue; }
    const c = (d && d.camoufox) || {};
    if (c.running) { setWebsearchStatus(`${line} Camoufox: ${c.log && c.log.length ? c.log[c.log.length - 1] : 'installing…'}`); continue; }
    if (c.available) { setWebsearchStatus(`${line} Camoufox is ready${c.version ? ' (' + c.version + ')' : ''}.`); }
    else if (c.ok === true) { setWebsearchStatus(`${line} Camoufox was installed${c.version ? ' (' + c.version + ')' : ''}.`); }
    else if (c.ok === false) { setWebsearchStatus(`${line} Camoufox could not be installed — see Settings → General → Web search for the command.`); }
    return done(c);
  }
  return done({ available: false, running: false });
}

async function setupWebSearch() {
  setWebsearchStatus('setting up SearXNG (the first run may install it)…');
  let d = null;
  try {
    const r = await fetch(api('/api/websearch-setup'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start', camoufox: true }),
    });
    // An older bridge has no such route (the page is served from disk, so it can
    // be newer than the process): say so instead of printing a 404 as a bug.
    if (r.status === 404) { setWebsearchStatus('this bridge is running an older build — restart it to set up search here.'); return; }
    d = await r.json();
  } catch (err) {
    setWebsearchStatus(`could not set up web search: ${err.message}`);
    return;
  }
  if (!d) {
    setWebsearchStatus('web search setup returned no answer — check the bridge log.');
    return;
  }

  /* Report the two jobs separately. SearXNG can use an instance that already
   * answers, Docker, or (on a host without Docker) a private Python install;
   * Camoufox is a download that starts in the background. A failed SearXNG
   * must not hide Camoufox's state, and a slow Camoufox download must not hide
   * the search result. */
  let line;
  if (d.ok) {
    const n = d.test && Number.isFinite(d.test.results) ? d.test.results : 0;
    line = `SearXNG answers at ${d.url} (${n} result${n === 1 ? '' : 's'} for a test query).`;
  } else {
    line = `web search is not ready: ${d.error || 'unknown error'} — install Docker/uv, or set an existing URL in Settings → General → Web search.`;
  }
  const c = d.camoufox || {};
  if (c.available) {
    setWebsearchStatus(`${line} Camoufox is ready${c.version ? ' (' + c.version + ')' : ''}.`);
  } else if (c.installing || c.running) {
    setWebsearchStatus(`${line} Installing Camoufox…`);
    pollCamoufox(() => {}, line);
  } else if (c.ok === true) {
    setWebsearchStatus(`${line} Camoufox was installed${c.version ? ' (' + c.version + ')' : ''}.`);
  } else if (c.ok === false) {
    setWebsearchStatus(`${line} Camoufox could not be installed${c.log && c.log.length ? ` — ${c.log[c.log.length - 1]}` : ''}.`);
  } else {
    setWebsearchStatus(`${line} Camoufox was not installed.`);
  }
}

/* Install what the wizard ticked. Returns how many were added. */
async function installSetupPackages() {
  const picked = [...document.querySelectorAll('#setup-packages-list input[data-package]')]
    .filter((c) => c.checked && !c.disabled)
    .map((c) => c.dataset.package);
  let added = 0;
  for (const source of picked) {
    try {
      const r = await fetch(api('/api/pi-extensions/package'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', source }),
      });
      if (r.ok) added += 1;
    } catch { /* the count below tells the story */ }
  }
  return added;
}

function maybeShowSetup() {
  if (SET.onboarded) return;
  $('setup-agent-name').value = SET.agentName === 'pi' ? '' : SET.agentName;
  $('setup-shorts-provider').value = SHORTS_FEEDS[SET.shortsProvider] ? SET.shortsProvider : 'instagram';
  $('setup-accent').value = SET.themeAccent || '#5b9dff';
  $('setup-gamer').checked = !!SET.gamerMode;
  $('setup-gamer-speed').value = String(Number(SET.gamerSpeed) || 16);
  $('setup-gamer-speed-val').textContent = `${Number(SET.gamerSpeed) || 16}s`;
  setSetupGamerVisible(!!SET.gamerMode);
  $('setup-font-size').value = String(Number(SET.chatFontSize) || 14);
  $('setup-font-size-val').textContent = `${Number(SET.chatFontSize) || 14}px`;
  $('setup-done-sound').checked = !!SET.doneSound;
  $('setup-done-notify').checked = !!SET.doneNotify;
  $('setup-voice-autosend').checked = !!SET.voiceAutoSend;
  $('setup-lan').checked = false;
  setupLanWas = null;
  // The bridge's own view of the network switch (it lives in a file, not in the
  // UI settings), so the box starts on the truth rather than on "off".
  fetch(api('/api/lan')).then((r) => r.json()).then((d) => {
    setupLanWas = !!d.lan;
    if ($('setup-lan') && $('setup-dialog').open) $('setup-lan').checked = !!d.lan;
  }).catch(() => { /* no bridge answer: leave it off */ });
  refreshSetupPreview();
  setupShowStep('packages');
  renderSetupPackages().catch(() => {});
  $('setup-dialog').showModal();
}
$('setup-skip').onclick = () => {
  SET.onboarded = true;
  saveSettings();
  $('setup-dialog').close();
};
$('setup-accent-reset').onclick = () => { $('setup-accent').value = '#5b9dff'; };
$('setup-gamer').onchange = (e) => {
  setSetupGamerVisible(e.target.checked);
  SET.gamerMode = e.target.checked;
  applySettings();     // so the drift starts (or stops) while you look at it
};
$('setup-gamer-speed').oninput = (e) => {
  SET.gamerSpeed = parseInt(e.target.value, 10) || 16;
  $('setup-gamer-speed-val').textContent = `${SET.gamerSpeed}s`;
};
$('setup-font-size').oninput = (e) => {
  SET.chatFontSize = parseInt(e.target.value, 10) || 14;
  $('setup-font-size-val').textContent = `${SET.chatFontSize}px`;
  applySettings();     // picked to be read, so show it while it is picked
};
$('setup-done-sound').onchange = (e) => { SET.doneSound = e.target.checked; if (e.target.checked) playDoneSound(); };
$('setup-done-notify').onchange = (e) => {
  SET.doneNotify = e.target.checked;
  if (e.target.checked && 'Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
};
// The two uploads reuse the Settings inputs (and their upload, crop and clear
// paths) instead of growing a second copy of them.
$('setup-avatar-upload').onclick = () => $('avatar-input').click();
$('setup-bg-upload').onclick = () => $('bg-input').click();
$('setup-avatar-clear').onclick = () => $('btn-avatar-clear').click();
$('setup-bg-clear').onclick = () => $('btn-bg-clear').click();
$('setup-done').onclick = async () => {
  // Step one is the package checklist; "next" moves on to the preferences.
  if (!$('setup-step-packages').classList.contains('hidden')) {
    const box = $('setup-websearch');
    let searchPicked = [...document.querySelectorAll('#setup-packages-list input[data-package]')]
      .some((c) => c.dataset.package === 'npm:pi-searxng' && c.checked);
    /* "set up web search now" is meaningless unless pi-searxng is selected, and
     * having two boxes where the visible one is already ticked made it look as
     * if search would be installed when it would not. Selecting the setup box
     * selects the package it needs. */
    if (box && box.checked && !searchPicked) {
      const pkg = [...document.querySelectorAll('#setup-packages-list input[data-package]')]
        .find((c) => c.dataset.package === 'npm:pi-searxng');
      if (pkg && !pkg.disabled) { pkg.checked = true; searchPicked = true; }
    }
    if (box && box.checked && searchPicked) {
      $('setup-done').disabled = true;
      try { await setupWebSearch(); } finally { $('setup-done').disabled = false; }
    }
    setupShowStep('prefs');
    return;
  }
  const name = $('setup-agent-name').value.trim();
  if (name) SET.agentName = name;
  const prov = $('setup-shorts-provider').value;
  if (SHORTS_FEEDS[prov] || prov === 'none') SET.shortsProvider = prov;
  const acc = $('setup-accent').value;
  SET.themeAccent = acc && acc !== '#5b9dff' ? acc : null;
  SET.gamerMode = $('setup-gamer').checked;
  SET.gamerSpeed = parseInt($('setup-gamer-speed').value, 10) || 16;
  SET.chatFontSize = parseInt($('setup-font-size').value, 10) || 14;
  SET.doneSound = $('setup-done-sound').checked;
  SET.doneNotify = $('setup-done-notify').checked;
  SET.voiceAutoSend = $('setup-voice-autosend').checked;
  SET.onboarded = true;
  saveSettings();
  $('setup-dialog').close();
  const wantLan = $('setup-lan').checked;
  toast(`Welcome, ${SET.agentName || 'pi'}!`);
  const added = await installSetupPackages();
  if (added) {
    toast(`${added} package${added > 1 ? 's' : ''} added — restarting the agent to pick them up`);
    send({ bridge: 'restart' });
  }
  // Only touch the network switch when the answer changed (it rebinds a socket).
  if (setupLanWas !== null && wantLan !== setupLanWas) setLanAccess(wantLan, $('setup-lan'));
};
