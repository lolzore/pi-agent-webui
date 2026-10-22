/*
 * Pi providers, the Extensions tab, and /login (auth.json).
 *
 * Split out of app.js (issue #54). Loaded before app.js; the names stay
 * global, so nothing else changed. Behaviour is unchanged.
 */
'use strict';

/* ───────────────────────── pi providers (models.json) ───────────────────────── */


/* ── the Extensions tab (issue #46) ──────────────────────────────────────
 *
 * Lists what pi will actually load - loose extensions, skills, the packages in
 * settings.json, and AGENTS.md - and switches or removes them through the bridge,
 * which writes pi's own +path/-path entries under ~/.pi/agent.
 *
 * Every action goes through postExt() and every one is followed by a reload of the
 * list, so what is on screen is what the file says rather than what was asked for.
 * A change only takes effect in the running agent after a reload, and the panel
 * says so rather than pretending it is live. */
async function postExt(path, payload) {
  const r = await fetch(api(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  let d = {};
  try { d = await r.json(); } catch { /* no body */ }
  if (!r.ok) throw new Error(d.error || `request failed (${r.status})`);
  return d;
}

function extRow(kind, r, reload) {
  const row = el('div', 'prov-row');
  const info = el('div', 'prov-info');
  const name = el('div', 'prov-id', r.name);
  if (!r.enabled) name.classList.add('ext-off');
  info.appendChild(name);
  const bits = [r.kind === 'dir' ? 'directory' : 'file', r.sourceLabel || r.source];
  if (r.size != null) bits.push(`${Math.max(1, Math.round(r.size / 1024))} KB`);
  if (r.writable === false) bits.push(r.note || 'read-only here');
  else bits.push(r.enabled ? 'enabled' : 'disabled');
  info.appendChild(el('div', 'prov-meta', bits.join(' · ')));
  row.appendChild(info);

  // A project skill is enabled in that project's own settings, which this tab
  // does not write (issue #64): listed for reference, with no switch to flip.
  if (r.writable === false) return row;

  const toggle = el('button', 'btn small' + (r.enabled ? '' : ' primary'), r.enabled ? 'disable' : 'enable');
  toggle.title = r.enabled
    ? `Write "-${r.rel}" into settings.json so pi stops loading it`
    : `Write "+${r.rel}" into settings.json so pi loads it again`;
  toggle.onclick = async () => {
    toggle.disabled = true;
    try {
      await postExt('/api/pi-extensions/toggle', { type: kind, name: r.name, source: r.source, enabled: !r.enabled });
      toast(`${r.name} ${r.enabled ? 'disabled' : 'enabled'} — reload the agent to apply it`);
      await reload();
    } catch (e) { toast(e.message, 'error'); } finally { toggle.disabled = false; }
  };

  if (r.source === 'local') {
    const del = el('button', 'btn small', 'uninstall');
    del.title = `Delete ${r.name} from disk. Only loose files under the agent dir can be removed here.`;
    del.onclick = async () => {
      if (!confirm(`Delete ${r.name} from disk?\n\nThis removes the file itself, not just the setting. It cannot be undone from here.`)) return;
      del.disabled = true;
      try {
        const d = await postExt('/api/pi-extensions/delete', { type: kind, name: r.name });
        toast(`Removed ${d.removed}`);
        await reload();
      } catch (e) { toast(e.message, 'error'); } finally { del.disabled = false; }
    };
    row.appendChild(toggle);
    row.appendChild(del);
  } else {
    row.appendChild(toggle);
  }
  return row;
}

/* MCP servers (issue #92): pi reads these from its own mcp.json. The tab lists
 * user and project entries and writes only the user file; a project entry is
 * read-only here, and pi has its own project override rules for it. */
let mcpEditing = null;   // the name the dialog is editing, if any

function mcpRow(r, reload) {
  const row = el('div', 'prov-row');
  const info = el('div', 'prov-info');
  const name = el('div', 'prov-id', r.name);
  if (!r.enabled) name.classList.add('ext-off');
  info.appendChild(name);
  const bits = [];
  if (r.transport === 'stdio') bits.push('stdio · ' + [r.command].concat(r.args || []).join(' '));
  else if (r.transport === 'http') bits.push('http · ' + r.url);
  else bits.push('override');
  bits.push(r.sourceLabel);
  if (r.note) bits.push(r.note);
  if (r.envKeys && r.envKeys.length) bits.push('env: ' + r.envKeys.join(', '));
  if (r.headerKeys && r.headerKeys.length) bits.push('headers: ' + r.headerKeys.join(', '));
  bits.push(r.enabled ? 'enabled' : 'disabled');
  if (r.writable === false) bits.push('read-only here');
  info.appendChild(el('div', 'prov-meta', bits.join(' · ')));
  if (r.description) info.appendChild(el('div', 'prov-meta', r.description));
  row.appendChild(info);

  if (!r.writable) return row;

  const toggle = el('button', 'btn small' + (r.enabled ? '' : ' primary'), r.enabled ? 'disable' : 'enable');
  toggle.title = r.enabled
    ? 'Write enabled:false into mcp.json so pi stops connecting it'
    : 'Take enabled:false out of mcp.json so pi connects it again';
  toggle.onclick = async () => {
    toggle.disabled = true;
    try {
      await postExt('/api/mcp/toggle', { name: r.name, enabled: !r.enabled });
      toast(`${r.name} ${r.enabled ? 'disabled' : 'enabled'} — pi connects it when the session reloads`);
      await reload();
    } catch (e) { toast(e.message, 'error'); } finally { toggle.disabled = false; }
  };

  const edit = el('button', 'btn small', 'edit');
  edit.title = 'Open this server in the dialog';
  edit.onclick = () => openMcpDialog(r);

  const del = el('button', 'btn small', 'remove');
  del.title = 'Take this server out of mcp.json';
  del.onclick = async () => {
    if (!confirm(`Remove ${r.name} from ${r.sourceLabel}?`)) return;
    del.disabled = true;
    try {
      await postExt('/api/mcp/delete', { name: r.name });
      toast(`Removed ${r.name} — pi drops it when the session reloads`);
      await reload();
    } catch (e) { toast(e.message, 'error'); } finally { del.disabled = false; }
  };
  row.append(toggle, edit, del);
  return row;
}

/* One form for add and edit: a target starting with http(s):// is an HTTP
 * server, anything else is a stdio command. */
/* KEY=value lines <-> the object pi stores. A line without an "=" is an
 * error the dialog shows, rather than a silent drop. */
function mcpLinesToObject(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) throw new Error(`"${t.slice(0, 30)}" is not KEY=value`);
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}
const mcpObjectToLines = (obj) => Object.entries(obj || {}).map(([k, v]) => `${k}=${v}`).join('\n');

/* One label and field pair is hidden depending on the transport; the env box
 * doubles as the headers box. */
function mcpTransportChanged() {
  const http = $('mcp-transport').value === 'http';
  for (const id of ['mcp-command', 'mcp-command-label', 'mcp-args', 'mcp-args-label']) $(id).classList.toggle('hidden', http);
  for (const id of ['mcp-url', 'mcp-url-label']) $(id).classList.toggle('hidden', !http);
  $('mcp-env-label').textContent = http ? 'Headers' : 'Environment';
  $('mcp-env').placeholder = http ? 'Authorization=Bearer …' : 'KEY=value, one per line';
}

/* Add or edit one server in a dialog (issue #92). The inline row this replaces
 * was three narrow inputs with no affordance; this is the shape of pi's own
 * mcp.json entry - a name, and either a command with args (stdio) or a URL
 * with headers (http), plus env and an enabled flag. */
function openMcpDialog(row) {
  mcpEditing = row ? row.name : null;
  $('mcp-dialog-title').textContent = row ? `Edit ${row.name}` : 'Add MCP server';
  $('mcp-dialog-error').textContent = '';
  $('mcp-dialog-error').classList.add('hidden');
  $('mcp-name').value = row ? row.name : '';
  const http = !!row && row.transport === 'http';
  $('mcp-transport').value = http ? 'http' : 'stdio';
  $('mcp-command').value = row && row.transport === 'stdio' ? (row.command || '') : '';
  $('mcp-args').value = row && row.transport === 'stdio' ? (row.args || []).join(' ') : '';
  $('mcp-url').value = http ? (row.url || '') : '';
  $('mcp-enabled').checked = row ? row.enabled !== false : true;
  $('mcp-env').value = mcpObjectToLines(http ? (row && row.headers) : (row && row.env));
  mcpTransportChanged();
  $('mcp-dialog').showModal();
  $('mcp-name').focus();
}

function mcpDialogError(msg) {
  const box = $('mcp-dialog-error');
  box.textContent = msg || '';
  box.classList.toggle('hidden', !msg);
}

async function saveMcpDialog() {
  const name = ($('mcp-name').value || '').trim();
  const http = $('mcp-transport').value === 'http';
  const entry = http
    ? { url: ($('mcp-url').value || '').trim() }
    : { command: ($('mcp-command').value || '').trim() };
  if (!http) {
    const args = ($('mcp-args').value || '').trim();
    if (args) entry.args = args.split(/\s+/).filter(Boolean);
  }
  try {
    const vars = mcpLinesToObject($('mcp-env').value);
    if (Object.keys(vars).length) {
      if (http) entry.headers = vars;
      else entry.env = vars;
    }
  } catch (e) { mcpDialogError(e.message); return; }
  if (!$('mcp-enabled').checked) entry.enabled = false;
  $('mcp-save').disabled = true;
  try {
    await postExt('/api/mcp/save', { name, entry });
    $('mcp-dialog').close();
    toast(`${mcpEditing ? 'Saved' : 'Added'} ${name} — pi connects it when the session reloads`);
    mcpEditing = null;
    await loadExtensionsTab();
  } catch (e) {
    // A rejected name or a bad field stays in the dialog, next to the input.
    mcpDialogError(e.message);
  } finally { $('mcp-save').disabled = false; }
}

async function loadExtensionsTab() {
  const extBox = $('ext-extensions');
  const skillBox = $('ext-skills');
  const pkgBox = $('ext-packages');
  const mcpBox = $('ext-mcp');
  if (!extBox || !skillBox) return;
  const reload = () => loadExtensionsTab();
  for (const box of [extBox, skillBox, pkgBox, mcpBox]) {
    if (!box) continue;
    box.innerHTML = '';
    box.appendChild(el('div', 'prov-empty', 'loading…'));
  }
  let d;
  try {
    d = await fetch(api('/api/pi-extensions')).then((r) => r.json());
  } catch (e) {
    for (const box of [extBox, skillBox, pkgBox]) { box.innerHTML = ''; box.appendChild(el('div', 'prov-empty', e.message)); }
    return;
  }
  if (d.error) {
    for (const box of [extBox, skillBox, pkgBox, mcpBox]) {
      if (!box) continue;
      box.innerHTML = '';
      box.appendChild(el('div', 'prov-empty', d.error));
    }
    return;
  }
  /* MCP servers live in pi's own mcp.json, not in the extensions payload
   * (issue #92), so they are fetched alongside it. */
  let m;
  try {
    m = await fetch(api('/api/mcp'), { cache: 'no-store' }).then((r) => r.json());
  } catch (e) { m = { error: e.message }; }
  $('ext-agent-dir').textContent = d.agentDir || '~/.pi/agent';
  $('ext-settings-file').textContent = d.settingsFile ? String(d.settingsFile).split(/[\\/]/).pop() : 'settings.json';
  $('ext-ext-count').textContent = d.counts.extensions ? `${d.counts.extensions}` : '';
  $('ext-skill-count').textContent = d.counts.skills ? `${d.counts.skills}` : '';
  $('ext-pkg-count').textContent = d.counts.packages ? `${d.counts.packages}` : '';

  extBox.innerHTML = '';
  if (!d.extensions.length) {
    extBox.appendChild(el('div', 'prov-empty', 'nothing in ' + (d.agentDir || '') + '/extensions'));
  } else {
    for (const r of d.extensions) extBox.appendChild(extRow('extensions', r, reload));
  }

  skillBox.innerHTML = '';
  if (!d.skills.length) {
    skillBox.appendChild(el('div', 'prov-empty', 'no skill folders (a skill is a directory holding SKILL.md)'));
  } else {
    for (const r of d.skills) skillBox.appendChild(extRow('skills', r, reload));
  }
  /* The roots and their counts, so a short list explains itself (issue #90).
   * Empty project roots are dropped from the text: the walk goes to the
   * filesystem root, and a row of `(0)`s buries the roots that matter. The two
   * global roots always show, even at zero - those are where skills belong. */
  if (Array.isArray(d.skillRoots) && d.skillRoots.length) {
    const shown = d.skillRoots.filter((r) => r.count > 0 || r.source !== 'project');
    const where = el('div', 'prov-empty',
      'looked in: ' + shown.map((r) => `${r.label} (${r.count})`).join(' · '));
    where.title = d.skillRoots.map((r) => `${r.dir} - ${r.count} skill${r.count === 1 ? '' : 's'}`).join('\n');
    skillBox.appendChild(where);
  }

  pkgBox.innerHTML = '';
  if (!d.packages.length) {
    pkgBox.appendChild(el('div', 'prov-empty', 'no packages listed in settings.json'));
  } else {
    for (const p of d.packages) {
      const row = el('div', 'prov-row');
      const info = el('div', 'prov-info');
      info.appendChild(el('div', 'prov-id', p.source));
      const meta = [p.form === 'object' ? 'object form' : 'string form'];
      if (p.filters) {
        for (const [k, v] of Object.entries(p.filters)) meta.push(`${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`);
      }
      info.appendChild(el('div', 'prov-meta', meta.join(' · ')));
      const del = el('button', 'btn small', 'remove');
      del.title = 'Take this entry out of settings.json. The files it installed under ~/.pi stay where they are.';
      del.onclick = async () => {
        if (!confirm(`Remove ${p.source} from settings.json?\n\nThis only edits the list. Anything it installed under ~/.pi/agent stays on disk.`)) return;
        del.disabled = true;
        try {
          await postExt('/api/pi-extensions/package', { action: 'remove', source: p.source });
          toast(`Removed ${p.source} from the package list — reload the agent to apply it`);
          await reload();
        } catch (e) { toast(e.message, 'error'); } finally { del.disabled = false; }
      };
      row.append(info, del);
      pkgBox.appendChild(row);
    }
  }

  // MCP servers from pi's own mcp.json (issue #92).
  if (mcpBox) {
    mcpBox.innerHTML = '';
    const servers = m.servers || [];
    $('ext-mcp-count').textContent = servers.length ? `${servers.length}` : '';
    if (m.file) $('ext-mcp-file').textContent = m.file;
    if (m.error) mcpBox.appendChild(el('div', 'prov-empty', m.error));
    else if (!servers.length) mcpBox.appendChild(el('div', 'prov-empty', 'no MCP servers — add one below'));
    else for (const r of servers) mcpBox.appendChild(mcpRow(r, reload));
  }

  // AGENTS.md: the global file is editable, the project ones are shown as they are.
  const list = $('ext-agents-list');
  const box = $('ext-agents-text');
  list.innerHTML = '';
  try {
    const a = await fetch(api('/api/pi-agents')).then((r) => r.json());
    for (const f of a.files || []) {
      const row = el('div', 'prov-row');
      const info = el('div', 'prov-info');
      info.appendChild(el('div', 'prov-id', f.writable ? 'global — editable here' : f.scope));
      info.appendChild(el('div', 'prov-meta', f.exists ? `${f.path} · ${f.bytes} bytes${f.truncated ? ' (shown in part)' : ''}` : `${f.path} · does not exist yet`));
      row.appendChild(info);
      list.appendChild(row);
    }
    const g = (a.files || []).find((f) => f.writable);
    box.value = (g && g.content) || '';
    box.placeholder = (g && g.exists) ? '' : '# Instructions for the agent (AGENTS.md is created by saving this box)';
  } catch (e) {
    list.appendChild(el('div', 'prov-empty', e.message));
  }
}

if ($('btn-ext-pkg-add')) {
  $('btn-ext-pkg-add').onclick = async () => {
    const input = $('ext-pkg-source');
    const source = (input.value || '').trim();
    if (!source) return;
    if (source.startsWith('-')) { toast('A package source cannot start with "-"', 'warning'); return; }
    $('btn-ext-pkg-add').disabled = true;
    try {
      const d = await postExt('/api/pi-extensions/package', { action: 'add', source });
      toast(d.note || `Added ${source}`);
      input.value = '';
      await loadExtensionsTab();
    } catch (e) { toast(e.message, 'error'); } finally { $('btn-ext-pkg-add').disabled = false; }
  };
}

if ($('btn-ext-agents-save')) {
  $('btn-ext-agents-save').onclick = async () => {
    const content = $('ext-agents-text').value;
    if (content.trim() === '' && !confirm('Save an empty AGENTS.md?\n\nAn empty box deletes the global AGENTS.md.')) return;
    $('btn-ext-agents-save').disabled = true;
    try {
      const d = await postExt('/api/pi-agents', { content });
      toast(d.bytes ? `Saved AGENTS.md (${d.bytes} bytes) — reload the agent to apply it` : 'Global AGENTS.md deleted');
      await loadExtensionsTab();
    } catch (e) { toast(e.message, 'error'); } finally { $('btn-ext-agents-save').disabled = false; }
  };
}

/* The Pi providers tab's list, rebuilt for issue #68.
 *
 * Two things used to leave this looking empty. The llama.cpp section came from
 * a single /api/llama-models probe: when the network sweep had not answered
 * yet, or the server was mid-restart, the answer was "none" and nothing ever
 * asked again - the model menu already retries in the background, this list did
 * not. And the custom providers were only rendered after that probe resolved,
 * so a slow probe parked "loading…" over a list the bridge had already
 * answered.
 *
 * Now the custom providers render as soon as their fetch returns, the llama
 * section renders as its answer arrives, and a bounded retry keeps asking
 * while the dialog is open until a server (and a finished sweep) has answered.
 * Closing the dialog stops it, and a failed fetch says so instead of looking
 * empty. */
const PROV_LLAMA_RETRY_MS = 5000;
/* Bounded retries while the Pi providers tab is the one on screen (issue
 * #106): ten tries at 2.5s kept the section - and the bridge - busy for ~25s
 * every time Settings opened, because each probe waits out an unreachable
 * server's timeout. Three tries at 5s, and only while that tab is visible. */
const PROV_LLAMA_RETRIES = 3;
let provListSeq = 0;              // a slow older call must not overwrite a newer render
let provLlamaTimer = null;
let provLlamaRetriesLeft = 0;

function stopPiProvidersRetry() {
  if (provLlamaTimer) { clearTimeout(provLlamaTimer); provLlamaTimer = null; }
  provLlamaRetriesLeft = 0;
}

/* These two endpoints answer from the bridge's own cache, quickly; the timeout
 * is there so a wedged socket cannot park the tab on "loading…" for good. */
async function fetchJsonWithin(url, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { signal: ctl.signal }).then((r) => r.json()); }
  finally { clearTimeout(t); }
}

/* One llama.cpp server row. Kept in one place so the first render and every
 * retry render the same thing. */
function piProviderLlamaRows(servers, scanning) {
  const out = document.createDocumentFragment();
  out.appendChild(el('div', 'prov-group', 'llama.cpp — found automatically'));
  for (const srv of servers) {
    const row = el('div', 'prov-row');
    const info = el('div', 'prov-info');
    info.appendChild(el('div', 'prov-id', srv.url.replace(/^https?:\/\//, '')));
    const registered = llamaRegistered(srv);
    info.appendChild(el('div', 'prov-meta',
      `${srv.models.length} model${srv.models.length > 1 ? 's' : ''} · ${registered ? 'registered with pi ✓' : 'not registered with pi yet'}`));
    const btn = el('button', 'btn small', registered ? 'use only this one' : 'use only this one & reload');
    btn.title = `Write ${srv.url} into pi's settings (replacing any other llama server) and restart the agent`;
    btn.onclick = () => fixLlamaConfig([srv.url]);
    row.append(info, btn);
    out.appendChild(row);
  }
  if (llamaEnvOverride) {
    out.appendChild(el('div', 'prov-empty',
      `note: LLAMA_SERVER_URL is set to ${llamaEnvOverride} in the bridge's environment, and the pi-llama-cpp extension lets that override this list`));
  }
  if (servers.length > 1) {
    // One provider per configured server: pointing pi at the list means every
    // instance's models are selectable at the same time.
    const all = el('div', 'prov-row');
    const info = el('div', 'prov-info');
    info.appendChild(el('div', 'prov-id', `all ${servers.length} servers at once`));
    const registered = servers.every((srv) => llamaRegistered(srv));
    info.appendChild(el('div', 'prov-meta', registered
      ? 'every one of them is registered with pi ✓'
      : 'pi keeps them all as separate providers, so no switching back and forth'));
    const btn = el('button', 'btn small', registered ? 'point pi at all of them again' : `point pi at all ${servers.length} & reload`);
    btn.title = `Write all ${servers.length} URLs into llamaSettings.servers and restart the agent`;
    btn.onclick = () => fixLlamaConfig(servers.map((s) => s.url));
    all.append(info, btn);
    out.appendChild(all);
  }
  if (scanning) out.appendChild(el('div', 'prov-empty', 'still looking for more on this network…'));
  return out;
}

/* `custom` is the providers object (null/{} is a real answer), `llama` is
 * `{ pending }`, `{ servers, scanning }` or `{}` once the probe has answered,
 * and `customErr` says the providers fetch itself failed. */
function renderPiProviders(list, custom, llama, customErr) {
  const keepScroll = list.scrollTop;
  list.innerHTML = '';
  const pending = !!(llama && llama.pending);
  const servers = (llama && llama.servers) || [];
  const scanning = !!(llama && llama.scanning);

  if (servers.length) {
    list.appendChild(piProviderLlamaRows(servers, scanning));
  } else if (pending || scanning) {
    list.appendChild(el('div', 'prov-empty', 'looking for llama.cpp servers on this machine and the LAN…'));
  } else if (llamaConfiguredUrls.length) {
    // A configured server that did not answer is worth naming: the whole point
    // of the list is that it shows what pi is pointed at (issue #68).
    list.appendChild(el('div', 'prov-empty',
      `pi is configured for ${llamaConfiguredUrls.map((u) => String(u).replace(/^https?:\/\//, '')).join(', ')}, but no server answered just now`));
  }

  if (customErr) {
    list.appendChild(el('div', 'prov-empty', 'could not read pi\'s providers — is the bridge offline?'));
  } else {
    const provs = Object.entries(custom || {});
    if (!provs.length) {
      list.appendChild(el('div', 'prov-empty', (servers.length || pending || scanning) ? 'no providers added by hand' : 'no custom providers yet'));
    } else {
      for (const [id, p] of provs) {
        const row = el('div', 'prov-row');
        const info = el('div', 'prov-info');
        info.appendChild(el('div', 'prov-id', id));
        info.appendChild(el('div', 'prov-meta',
          `${p.baseUrl || '—'} · ${p.models?.length || 0} models · key ${p.hasApiKey ? '✓' : '—'}`));
        const btn = el('button', 'btn small', 'remove');
        btn.title = `Remove provider "${id}" from pi's models.json`;
        btn.onclick = async () => {
          if (!confirm(`Remove provider "${id}" from pi's models.json?`)) return;
          try {
            const r = await fetch(api(`/api/pi-providers?id=${encodeURIComponent(id)}`), { method: 'DELETE' });
            const out = await r.json();
            if (!r.ok) throw new Error(out.error || `failed (${r.status})`);
            toast(`Provider "${id}" removed`);
            loadPiProviders();
            refreshModels();
          } catch (e) { toast(e.message, 'error'); }
        };
        row.append(info, btn);
        list.appendChild(row);
      }
    }
  }
  list.scrollTop = keepScroll;
}

async function loadPiProviders(resetRetry) {
  const list = $('pi-providers-list');
  if (!list) return;
  // A pending retry belongs to the previous call; this call schedules its own
  // if it still needs one. Without this, reopening the dialog could stack two
  // retry loops on the same list.
  if (provLlamaTimer) { clearTimeout(provLlamaTimer); provLlamaTimer = null; }
  if (resetRetry !== false) provLlamaRetriesLeft = PROV_LLAMA_RETRIES;
  const seq = ++provListSeq;

  // The custom providers do not depend on the llama probe, so they are shown
  // the moment they arrive instead of behind it.
  let custom = null;
  let customErr = false;
  try {
    const d = await fetchJsonWithin(api('/api/pi-providers'), 8000);
    custom = d && d.providers ? d.providers : {};
  } catch { customErr = true; }
  if (seq !== provListSeq) return;   // a newer call owns the list now
  renderPiProviders(list, custom, { pending: true }, customErr);

  let llama = {};
  /* The interactive path asks for a fresh probe (the bridge otherwise serves
   * the cached empty answer for 15s, which is what keeps every other caller
   * quiet - issue #106). */
  try { llama = await fetchJsonWithin(api('/api/llama-models?fresh=1'), 8000) || {}; } catch { llama = {}; }
  if (seq !== provListSeq) return;
  renderPiProviders(list, custom, llama, customErr);

  const servers = llama.servers || [];
  const scanning = !!llama.scanning;
  // Keep asking while the sweep is running and when nothing has answered yet -
  // a server that is still starting up shows up on a later try instead of
  // needing the dialog to be closed and reopened (issue #68).
  const unsettled = scanning || !servers.length;
  /* Retries belong to the tab that shows the result: while the General tab is
   * up there is nothing to keep fresh, and that is where the dialog opens. */
  const providersShown = (() => {
    const panel = $('tab-providers');
    return !!panel && !panel.classList.contains('hidden');
  })();
  if (unsettled && providersShown && provLlamaRetriesLeft > 0 && $('settings-dialog').open) {
    provLlamaRetriesLeft--;
    provLlamaTimer = setTimeout(() => { provLlamaTimer = null; loadPiProviders(false); }, PROV_LLAMA_RETRY_MS);
  }
}

$('btn-prov-discover').onclick = async () => {
  const url = $('prov-base-url').value.trim().replace(/\/+$/, '');
  if (!url) { toast('Enter the base URL first', 'warning'); return; }
  const btn = $('btn-prov-discover');
  btn.disabled = true;
  try {
    const r = await fetch(api('/api/probe-models'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `probe failed (${r.status})`);
    if (!d.models.length) { toast('No models found at that URL', 'warning'); return; }
    $('prov-models').value = d.models.map((m) => m.id).join('\n');
    toast(`Found ${d.models.length} models`);
  } catch (e) {
    toast(`Discover failed: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
};

$('btn-prov-test').onclick = async () => {
  const baseUrl = $('prov-base-url').value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(baseUrl)) { toast('Enter a valid base URL first', 'warning'); return; }
  const btn = $('btn-prov-test');
  btn.disabled = true;
  btn.textContent = 'testing…';
  try {
    const r = await fetch(api('/api/probe-provider'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl,
        api: $('prov-api').value,
        apiKey: $('prov-api-key').value.trim(),
      }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `probe failed (${r.status})`);
    if (d.ok) {
      toast(`✓ Connection works — model "${d.model}" replied: ${d.sample || '(empty)'}`);
      if (d.models.length && !$('prov-models').value.trim()) {
        $('prov-models').value = d.models.join('\n');
        toast(`Filled ${d.models.length} discovered models`);
      }
    } else if (d.empty) {
      toast(`✗ Endpoint answered HTTP ${d.status} but with an EMPTY reply — check the URL path (e.g. OpenAI-style needs /v1, not /anthropic)`, 'error');
    } else {
      toast(`✗ ${d.error || `HTTP ${d.status}`}`, 'error');
    }
  } catch (e) {
    toast(`Test failed: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'test connection';
  }
};

$('btn-prov-add').onclick = async () => {
  const id = $('prov-id').value.trim();
  const baseUrl = $('prov-base-url').value.trim();
  const api = $('prov-api').value;
  const apiKey = $('prov-api-key').value.trim();
  const models = $('prov-models').value.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!id) { toast('Provider id is required', 'warning'); return; }
  if (!/^https?:\/\//i.test(baseUrl)) { toast('Base URL must start with http:// or https://', 'warning'); return; }
  const btn = $('btn-prov-add');
  btn.disabled = true;
  try {
    const r = await fetch(api('/api/pi-providers'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, baseUrl, api, apiKey: apiKey || undefined, models }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `failed (${r.status})`);
    toast(`Provider "${id}" saved to pi — new models appear in the model list`);
    $('prov-api-key').value = '';
    $('prov-models').value = '';
    loadPiProviders();
    refreshModels(); // pi re-reads models.json when the model list is opened
  } catch (e) {
    toast(`Save failed: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
};

/* ───────────────────────── pi /login (auth.json) ───────────────────────── */

// Credentials pi's /login saves: ~/.pi/agent/auth.json, keyed by provider id.
// "login" = store an API key, "logout" = remove it. The agent restarts after
// either, because it reads auth.json at startup.
//
// The old UI listed all ~33 known providers at once, which buried the two or
// three that actually matter. Now it is a searchable picker: type (or pick from
// the suggestions) and the state of that one provider is shown below.
let authProviders = {};

async function loadAuthProviders() {
  const status = $('auth-status');
  const list = $('auth-logged-in');
  if (!status || !list) return;
  try {
    const d = await fetch(api('/api/auth-providers')).then((r) => r.json());
    authProviders = d.providers || {};
    renderAuthStatus();
    renderAuthLoggedIn();
  } catch {
    authProviders = {};
    status.className = 'auth-status';
    status.textContent = 'bridge offline';
    list.innerHTML = '';
  }
}

// State of the provider currently in the input (if any).
function renderAuthStatus() {
  const status = $('auth-status');
  if (!status) return;
  const id = ($('auth-provider').value || '').trim();
  status.className = 'auth-status';
  status.textContent = '';
  if (!id) {
    const n = Object.keys(authProviders).length;
    status.textContent = n
      ? 'Type or pick a provider — suggestions appear as you type.'
      : '';
    return;
  }
  const p = authProviders[id];
  const cat = p && p.models ? ` · ${p.models} models in its catalog` : '';
  if (!p) {
    status.textContent = `${id}: not a known pi provider id (any id is accepted) — no credentials stored.`;
    status.classList.add('warn');
  } else if (p.auth === 'key') {
    status.textContent = `${p.name || id} — logged in with an API key ${p.keyMasked || ''}${cat}`;
    status.classList.add('ok');
  } else if (p.auth === 'oauth') {
    status.textContent = `${p.name || id} — logged in via OAuth / subscription${cat}`;
    status.classList.add('ok');
  } else if (p.auth === 'other') {
    status.textContent = `${p.name || id} — configured in auth.json, but not an API key login (cannot be removed here)${cat}`;
    status.classList.add('warn');
  } else {
    status.textContent = `${p.name || id} — no credentials stored yet${cat}${p.custom ? ' (custom provider)' : ''}`;
  }
}

// Only the providers that actually have credentials — usually a short list.
function renderAuthLoggedIn() {
  const list = $('auth-logged-in');
  if (!list) return;
  list.innerHTML = '';
  const ids = Object.keys(authProviders).filter((id) => authProviders[id].auth !== 'none');
  if (!ids.length) {
    list.appendChild(el('div', 'prov-empty', 'no credentials stored yet'));
    return;
  }
  for (const id of ids) {
    const p = authProviders[id];
    const row = el('div', 'prov-row');
    const info = el('div', 'prov-info');
    info.appendChild(el('div', 'prov-id', p.name || id));
    const what = p.auth === 'key' ? `API key ${p.keyMasked || ''}`
      : p.auth === 'oauth' ? 'OAuth / subscription'
      : 'other configuration (protected)';
    info.appendChild(el('div', 'prov-meta', `${id} · ${what}`));
    const btn = el('button', 'btn small', p.auth === 'other' ? 'protected' : 'logout');
    if (p.auth === 'other') {
      btn.disabled = true;
      btn.title = `"${id}" holds configuration beyond a login (an env block, for example) — remove it by hand if you really mean to`;
    } else {
      btn.title = `Remove "${id}" credentials from auth.json (like /logout)`;
      btn.onclick = () => authLogout(id);
    }
    row.append(info, btn);
    row.onclick = (e) => {
      if (e.target === btn) return;
      $('auth-provider').value = id;
      renderAuthStatus();
      $('auth-key').focus();
    };
    list.appendChild(row);
  }
}

// Restart the shared agent so it re-reads auth.json (same mechanism the
// llama.cpp fix uses).
async function authRestartAgent() {
  toast('Restarting the agent to pick up the new credentials…');
  const wait = waitForAgentReady(60000);
  send({ bridge: 'restart' });
  await wait;
  await initSession(true);
}

async function authLogout(id) {
  if (!confirm(`Log out "${id}"?\nRemoves its credentials from auth.json (like /logout).`)) return;
  try {
    const r = await fetch(api(`/api/auth-login?provider=${encodeURIComponent(id)}`), { method: 'DELETE' });
    const out = await r.json();
    if (!r.ok) throw new Error(out.error || `failed (${r.status})`);
    await authRestartAgent();
    toast(`Logged out "${id}"`);
    loadAuthProviders();
    refreshModels();
  } catch (e) {
    toast(e.message, 'error');
  }
}

/* The provider suggestions, as a real dropdown (issue #68).
 *
 * This was a native <datalist>: clicking the field opened nothing (Chromium
 * and Firefox only show a datalist once you type), and the suggestions only
 * matched what had been typed so far, so the list could "not appear when
 * clicked, or [when] something has been typed". This opens on click or focus
 * with every provider, filters on any part of the id or the display name,
 * follows the arrow keys, and stays editable for ids the bridge does not
 * know. */
let authProvMenu = null;
let authProvCursor = -1;

function authProviderMatches(query) {
  const q = (query || '').trim().toLowerCase();
  return Object.keys(authProviders)
    .filter((id) => {
      if (!q) return true;
      const name = String(authProviders[id].name || '').toLowerCase();
      return id.toLowerCase().includes(q) || name.includes(q);
    })
    .sort((a, b) => a.localeCompare(b));
}

function closeAuthProviderMenu() {
  if (authProvMenu) { authProvMenu.remove(); authProvMenu = null; }
  authProvCursor = -1;
}

function pickAuthProvider(id) {
  const inp = $('auth-provider');
  if (!inp) return;
  inp.value = id;
  closeAuthProviderMenu();
  renderAuthStatus();
  $('auth-key').focus();
}

function openAuthProviderMenu() {
  const inp = $('auth-provider');
  if (!inp || !inp.isConnected) return;
  closeAuthProviderMenu();
  const ids = authProviderMatches(inp.value);
  const menu = el('div', 'model-menu suggest-menu');
  if (!ids.length) {
    menu.appendChild(el('div', 'model-empty', Object.keys(authProviders).length
      ? `no provider matches “${inp.value.trim()}”`
      : 'the bridge did not send a provider list'));
  } else {
    const rows = el('div', 'model-list');
    for (const id of ids) {
      const p = authProviders[id] || {};
      const row = el('div', 'model-item');
      row.appendChild(el('span', 'model-label', p.name && p.name !== id ? `${p.name} · ${id}` : id));
      const state = p.auth === 'key' ? `key ${p.keyMasked || ''}`.trim()
        : p.auth === 'oauth' ? 'oauth'
          : p.auth === 'other' ? 'protected'
            : '';
      if (state) row.appendChild(el('span', 'model-provider', state));
      if (p.custom) row.appendChild(el('span', 'model-provider', 'custom'));
      if (p.models) row.appendChild(el('span', 'model-provider', `${p.models} models`));
      // mousedown would blur the input and close the menu before the click lands
      row.onmousedown = (e) => e.preventDefault();
      row.onclick = (e) => { e.stopPropagation(); pickAuthProvider(id); };
      rows.appendChild(row);
    }
    menu.appendChild(rows);
  }
  const r = inp.getBoundingClientRect();
  const w = Math.max(260, Math.min(420, r.width));
  menu.style.width = `${w}px`;
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
  const h = menu.offsetHeight;
  const roomBelow = window.innerHeight - r.bottom - 10;
  if (roomBelow < Math.min(h, 200) && r.top > roomBelow) menu.style.bottom = `${window.innerHeight - r.top + 6}px`;
  else menu.style.top = `${r.bottom + 6}px`;
  // A modal <dialog> lives in the browser's top layer, so a menu outside it is
  // rendered *under* the dialog (the same reason openMenu() does this).
  (document.querySelector('dialog[open]') || document.body).appendChild(menu);
  authProvMenu = menu;
}

function moveAuthProviderCursor(delta) {
  if (!authProvMenu) return;
  const rows = [...authProvMenu.querySelectorAll('.model-item')];
  if (!rows.length) return;
  authProvCursor = (authProvCursor + delta + rows.length) % rows.length;
  rows.forEach((row, i) => row.classList.toggle('sel', i === authProvCursor));
  rows[authProvCursor].scrollIntoView({ block: 'nearest' });
}

$('auth-provider').addEventListener('input', () => { renderAuthStatus(); openAuthProviderMenu(); });
$('auth-provider').addEventListener('change', renderAuthStatus);
$('auth-provider').addEventListener('focus', openAuthProviderMenu);
$('auth-provider').addEventListener('click', openAuthProviderMenu);
$('auth-provider').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); if (!authProvMenu) openAuthProviderMenu(); moveAuthProviderCursor(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); if (authProvMenu) moveAuthProviderCursor(-1); }
  else if (e.key === 'Escape' && authProvMenu) { e.stopPropagation(); closeAuthProviderMenu(); }
  else if (e.key === 'Enter' && authProvMenu) {
    const row = authProvMenu.querySelectorAll('.model-item')[authProvCursor] || authProvMenu.querySelector('.model-item');
    if (row) { e.preventDefault(); row.click(); }
  }
});
// Any click outside the field and its menu dismisses it. Capture phase so a
// handler that stops propagation cannot leave it up.
document.addEventListener('click', (e) => {
  if (!authProvMenu) return;
  if (e.target === $('auth-provider') || authProvMenu.contains(e.target)) return;
  closeAuthProviderMenu();
}, true);

$('btn-auth-login').onclick = async () => {
  const id = $('auth-provider').value.trim();
  const key = $('auth-key').value.trim();
  if (!id) { toast('Enter the provider id first', 'warning'); return; }
  if (!key) { toast('Enter the API key', 'warning'); return; }
  try {
    const r = await fetch(api('/api/auth-login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: id, key }),
    });
    const out = await r.json();
    if (!r.ok) throw new Error(out.error || `failed (${r.status})`);
    $('auth-key').value = '';
    await authRestartAgent();
    toast(`Logged in "${id}" — key saved to auth.json`);
    loadAuthProviders();
    refreshModels();
  } catch (e) {
    toast(`Login failed: ${e.message}`, 'error');
  }
};
$('btn-auth-logout').onclick = () => {
  const id = $('auth-provider').value.trim();
  if (!id) { toast('Enter the provider id first', 'warning'); return; }
  authLogout(id);
};

if ($('btn-ext-mcp-add')) {
  $('btn-ext-mcp-add').onclick = () => openMcpDialog(null);
  $('mcp-cancel').onclick = () => $('mcp-dialog').close();
  $('mcp-save').onclick = saveMcpDialog;
  $('mcp-transport').onchange = mcpTransportChanged;
}
