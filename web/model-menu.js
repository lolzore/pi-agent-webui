/*
 * The model picker, the thinking menu and the dropdown machinery under them:
 * openMenu and the menu stack, the model search list, the thinking level menu,
 * and the llama.cpp entries the picker manages (probe refresh, registration
 * state, the "point pi here" fix).
 *
 * Split out of app.js (issue #54, phase 8). Loaded before app.js; the names
 * stay global, so nothing else changed. Behaviour is unchanged.
 */
'use strict';

/* Open dropdowns, oldest first. A right-click menu stacks on top of the menu it
 * was opened from instead of replacing it: removing an instance from inside the
 * switcher used to close the list you were working in. */
const MENUS = [];
let openMenuEl = null;   // the topmost one, for the code that only reads it
/* When a menu was last opened. The scroll handler ignores the scrolls that
 * opening itself causes (focusing the search box, scrollIntoView), but closes
 * the menu for a real page/dialog scroll: a fixed-position menu does not travel
 * with its anchor, so it would otherwise float over unrelated content. */
let menuOpenedAt = 0;
function closeMenu() {
  const m = MENUS.pop();
  if (!m) { openMenuEl = null; return; }
  if (m._subagents) S.subagentMenuOpen = false;
  m.remove();
  openMenuEl = MENUS[MENUS.length - 1] || null;
}

/* Every opener goes through this, and a capture-phase pointerdown closes whatever
 * was not clicked - so two dropdowns can never sit on screen together by
 * accident, whatever route opened them. A click on an open menu, or on the
 * button that opened it, is left alone: the button's own click handler decides,
 * which is what makes a second click on the same button close its menu. That
 * check is why the model button toggled and the thinking level and the instance
 * switcher did not - this handler closed their menu on pointerdown, so by the
 * time the click arrived there was nothing left to toggle and it reopened. */
function closeAllMenus() {
  while (MENUS.length) closeMenu();
  toggleModelMenu(false);
}

/* A fixed-position dropdown does not move with its anchor. Scrolling the chat,
 * the settings dialog or the sidebar while one is open left the menu floating
 * over unrelated content - the visual break reported after the scroll. Close it
 * instead. Scrolling the menu's own list is part of using the menu, so that is
 * exempt; the short grace period covers the focus/scrollIntoView that opening a
 * menu itself performs. */
function anyDropdownOpen() {
  const modelMenu = $('model-menu');
  return MENUS.length > 0 || !!(modelMenu && !modelMenu.classList.contains('hidden'));
}

window.addEventListener('scroll', (e) => {
  if (!anyDropdownOpen()) return;
  if (Date.now() - menuOpenedAt < 200) return;
  const t = e.target;
  if (t && t.closest && t.closest('.model-menu')) return;
  closeAllMenus();
}, true);

/* A wheel/touch scroll can start moving the page before the scroll event is
 * dispatched; close the menu on the gesture itself so it cannot detach for a
 * frame. Scrolling inside the menu's own list is still the menu's business. */
for (const [event, opts] of [['wheel', { capture: true, passive: true }], ['touchmove', { capture: true, passive: true }]]) {
  window.addEventListener(event, (e) => {
    if (!anyDropdownOpen()) return;
    if (Date.now() - menuOpenedAt < 200) return;
    const t = e.target;
    if (t && t.closest && t.closest('.model-menu')) return;
    closeAllMenus();
  }, opts);
}
document.addEventListener('pointerdown', (e) => {
  const t = e.target;
  if (!t || !t.closest) return;
  // The model picker is a menu of its own (it has a search box and its own
  // toggle), so it is not in MENUS - but its button has to be left alone for the
  // same reason: closing it here meant the click that followed reopened it, and
  // the button never closed on a second click.
  const modelAnchor = !!(t.closest('#model-btn') || t.closest('#model-menu'));
  if (!modelAnchor) toggleModelMenu(false);
  if (modelAnchor) return;
  if (MENUS.some((m) => m.contains(t) || (m._anchor && m._anchor.contains(t)))) return;
  closeAllMenus();
}, true);

function openMenu(anchor, items, opts = {}) {
  const wasOpenFor = MENUS.length > 0 && MENUS[MENUS.length - 1]._anchor === anchor;
  // A submenu (the right-click menu inside the instance switcher) keeps its
  // parent on screen; anything else replaces whatever was open.
  if (opts.sub) toggleModelMenu(false);
  else closeAllMenus();
  if (wasOpenFor && !opts.force) return null;   // clicking the same anchor again closes
  if (!anchor || !items || !items.length) return null;
  const menu = el('div', 'model-menu');
  menu._anchor = anchor;
  let search = null;
  if (opts.search) {
    search = el('input');
    search.type = 'search';
    search.placeholder = opts.search;
    search.autocomplete = 'off';
    search.spellcheck = false;
    menu.appendChild(search);
  }
  if (opts.title) menu.appendChild(el('div', 'model-group', opts.title));
  const list = el('div', 'model-list');
  const render = (q) => {
    list.replaceChildren();
    const query = (q || '').trim().toLowerCase();
    const rows = items.filter((it) => !query ||
      `${it.label || ''} ${it.hint || ''} ${it.group || ''}`.toLowerCase().includes(query));
    if (!rows.length) { list.appendChild(el('div', 'model-empty', 'Nothing matches')); return; }
    let group = null;
    for (const it of rows) {
      if (it.sep) { list.appendChild(el('div', 'menu-sep', '')); group = null; continue; }
      if (it.group && it.group !== group) { group = it.group; list.appendChild(el('div', 'model-group', group)); }
      const row = el('div', 'model-item' + (it.active ? ' sel' : '') + (it.danger ? ' danger' : '') + (it.cls ? ` ${it.cls}` : ''));
      if (it.instanceUrl) row.dataset.instance = it.instanceUrl;
      if (it.id) row.dataset.menuId = String(it.id);
      if (it.avatar || it.avatarPlaceholder) {
        // an instance's own picture, so the switcher shows who is who
        const img = it.avatar ? el('img', 'menu-avatar') : el('span', 'menu-avatar empty', '');
        if (it.avatar) { img.src = it.avatar; img.alt = ''; }
        row.appendChild(img);
      }
      if (it.dot) row.appendChild(el('span', `menu-dot ${it.dot}`, ''));
      row.appendChild(el('span', 'model-label', it.label || ''));
      if (it.hint) row.appendChild(el('span', 'model-provider', it.hint));
      if (it.trailing) {
        // A control inside the row - the instance menu's stop button (issue
        // #79). Clicking it must not also pick the row.
        it.trailing.onclick = (e) => { e.stopPropagation(); if (it.onTrailing) it.onTrailing(it, e); };
        row.appendChild(it.trailing);
      }
      row.onclick = (e) => {
        e.stopPropagation();
        if (it.keepOpen) { it.onPick && it.onPick(it); return; }
        // The whole stack, not just this menu: picking "switch to X" inside an
        // instance's right-click menu must not leave the switcher open behind it.
        closeAllMenus();
        it.onPick && it.onPick(it);
      };
      if (it.onContext) {
        row.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); it.onContext(it, row); };
      }
      list.appendChild(row);
    }
  };
  menu.appendChild(list);
  render('');
  if (search) {
    search.oninput = () => render(search.value);
    search.onkeydown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeAllMenus(); }
      if (e.key === 'Enter') { const first = list.querySelector('.model-item'); if (first) first.click(); }
    };
  }
  // A modal <dialog> is in the browser's top layer, so a menu appended to the
  // body renders *under* it - the settings dropdowns opened behind the dialog and
  // could not be clicked. Inside the dialog the menu stays on top, and its
  // `position: fixed` coordinates are still viewport-relative.
  //
  // Prefer the dialog the anchor actually lives in: the first-run setup dialog
  // and the settings dialog can both be open, and appending the font menu to
  // whichever dialog happened to be first in the DOM put it in the wrong one.
  // An anchor outside every dialog (the instance button in the topbar) still
  // goes into the topmost open dialog so it paints over it.
  const ownDialog = anchor.closest && anchor.closest('dialog[open]');
  const dialogs = document.querySelectorAll('dialog[open]');
  (ownDialog || (dialogs.length ? dialogs[dialogs.length - 1] : document.body)).appendChild(menu);
  MENUS.push(menu);
  openMenuEl = menu;
  menuOpenedAt = Date.now();
  const r = anchor.getBoundingClientRect();
  const w = Math.max(200, Math.min(opts.width || 300, window.innerWidth - 24));
  menu.style.width = `${w}px`;
  const h = menu.offsetHeight;
  if (opts.at) {
    // Right-click menus appear where the pointer is, not at the message header.
    const left = Math.max(8, Math.min(opts.at.x, window.innerWidth - w - 8));
    const top = opts.at.y + h + 8 > window.innerHeight ? Math.max(8, opts.at.y - h - 6) : opts.at.y + 6;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  } else if (opts.below) {
    // Always under the anchor (the font picker, for one): flipping a long list
    // above the field put it over the settings that opened it. Let the list
    // scroll inside whatever room is left below the anchor.
    const top = Math.min(r.bottom + 6, window.innerHeight - 40);
    menu.style.top = `${top}px`;
    menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    const listEl = menu.querySelector('.model-list');
    if (listEl) {
      listEl.style.minHeight = '0';
      listEl.style.maxHeight = `${Math.max(120, window.innerHeight - top - 64)}px`;
    }
  } else {
    const roomBelow = window.innerHeight - r.bottom - 10;
    if (roomBelow < Math.min(h, 220) && r.top > roomBelow) menu.style.bottom = `${window.innerHeight - r.top + 6}px`;
    else menu.style.top = `${Math.min(r.bottom + 6, Math.max(8, window.innerHeight - h - 8))}px`;
    menu.style.left = `${Math.max(8, Math.min(opts.align === 'right' ? r.right - w : r.left, window.innerWidth - w - 8))}px`;
  }
  if (search) search.focus();
  menu.addEventListener('click', (e) => e.stopPropagation());
  setTimeout(() => document.addEventListener('click', closeAllMenus, { once: true }), 0);
  return menu;
}

/* What each thinking level means - shown in the dropdown, not on the button. */
const THINKING_NOTES = {
  off: 'no thinking - fastest replies',
  minimal: 'a quick look before answering',
  low: 'brief reasoning',
  medium: 'balanced - the usual choice',
  high: 'thorough reasoning, slower on hard problems',
  max: 'the most it can do - slowest',
};

/* The visible label lives in its own span, not directly in the button.
 *
 * A bare text node in a <button> is laid out in the button's line box, and the
 * inline box is as tall as the font that ends up shaping the text. In Firefox a
 * fallback font (a CJK model name, an emoji, a provider name the chosen font
 * does not cover) made that inline box taller, and the browser re-centred it
 * inside the fixed 16px line: the pill border and the absolutely-positioned
 * arrow stood still while the text hopped up by a pixel or two. The span has a
 * fixed line box, and the button centres it with flexbox, so every label -
 * ASCII or not - is placed from the same box. */
function pillLabel(btn) {
  let label = btn.firstElementChild;
  if (!label || !label.classList.contains('pill-label')) {
    label = document.createElement('span');
    label.className = 'pill-label';
    btn.replaceChildren(label);
  }
  return label;
}

function updateThinkingBtn() {
  const btn = $('thinking-btn');
  if (!btn) return;
  const sel = $('thinking-select');
  const opt = sel.selectedOptions && sel.selectedOptions[0];
  const level = opt ? opt.value : 'off';
  // Only write when it changed (issue #118, same reason as updateModelBtn).
  const label = pillLabel(btn);
  if (label.textContent !== level) label.textContent = level;
  const title = `Thinking level: ${level} - click to change`;
  if (btn.title !== title) btn.title = title;
}

function openThinkingMenu() {
  const sel = $('thinking-select');
  const levels = [...sel.options].map((o) => o.value);
  openMenu($('thinking-btn'), levels.map((lv) => ({
    label: lv,
    hint: THINKING_NOTES[lv] || '',
    active: sel.value === lv,
    onPick: () => {
      sel.value = lv;
      sel.dispatchEvent(new Event('change'));
    },
  })), { title: 'thinking level', width: 330 });
}

/* ── model picker ─────────────────────────────────────────────────────────
 * A native <select> cannot be searched, and with enough models its popup ran
 * off the bottom of the screen. This adds a searchable, scrollable list on top
 * of it. The hidden <select> stays the source of truth (set_model, state sync,
 * llama.cpp entries) so nothing else had to change. */
/* Issue #174: the llama.cpp extension's models are not offered in the picker.
 *
 * They were unreliable next to the llama-server ones (the llama.cpp server the
 * reader actually runs), and a list that mixes the two made the working choice
 * hard to find. The provider is still usable - pi keeps the model if it is the
 * one you are on, and this only hides it from the list. */
const HIDDEN_MODEL_PROVIDERS = ['llama.cpp'];
const modelProvider = (value) => String(value || '').split('||')[0].toLowerCase();
const isHiddenModel = (value) => HIDDEN_MODEL_PROVIDERS.includes(modelProvider(value));

function modelMenuItems() {
  const sel = $('model-select');
  const current = sel.value;
  const out = [];
  for (const kid of sel.children) {
    if (kid.tagName === 'OPTGROUP') {
      for (const o of kid.children) out.push({ value: o.value, label: o.textContent, group: kid.label || '' });
    } else if (kid.tagName === 'OPTION') {
      out.push({ value: kid.value, label: kid.textContent, group: '' });
    }
  }
  // the model you are on stays visible, whatever it is: the menu is also where
  // you see where you are
  return out.filter((it) => it.value === current || !isHiddenModel(it.value));
}

function updateModelBtn() {
  const btn = $('model-btn');
  if (!btn) return;
  const sel = $('model-select');
  const opt = sel.selectedOptions && sel.selectedOptions[0];
  const text = opt ? opt.textContent : 'no model';
  /* Only write when it changed (issue #118): every state sync calls this, and a
   * replaced text node is re-shaped from scratch, which moved the pill's border
   * and its little arrow up and down while the text beside it stayed put. */
  const label = pillLabel(btn);
  if (label.textContent !== text) label.textContent = text;
  const title = `Model: ${text} — click to search and switch`;
  if (btn.title !== title) btn.title = title;
}

function renderModelMenu(query) {
  const list = $('model-list');
  if (!list) return;
  const q = (query || '').trim().toLowerCase();
  const sel = $('model-select').value;
  const items = modelMenuItems();
  const favs = Array.isArray(SET.favouriteModels) ? SET.favouriteModels.filter((v) => typeof v === 'string') : [];
  const isFav = (v) => favs.includes(v);
  const matches = (it) => !q
    || String(it.label || '').toLowerCase().includes(q)
    || String(it.value || '').toLowerCase().includes(q)
    || String(it.group || '').toLowerCase().includes(q);
  /* A favourite whose model pi no longer reports stays in the list, marked
   * "not available": it is the only place to unstar it, and silently dropping
   * it would leave the setting stuck. */
  const favItems = favs
    .filter((v) => v === sel || !isHiddenModel(v))
    .map((v) => items.find((it) => it.value === v)
      || { value: v, label: v.split('||')[1] || v, group: '', missing: true })
    .filter(matches);
  const rest = items.filter((it) => !isFav(it.value) && matches(it));
  list.replaceChildren();

  const addRow = (it) => {
    const row = el('div', 'model-item' + (it.value === sel ? ' sel' : '') + (it.missing ? ' missing' : ''));
    const star = el('button', 'fav-star' + (isFav(it.value) ? ' on' : ''), isFav(it.value) ? '\u2605' : '\u2606');
    star.type = 'button';
    star.title = isFav(it.value) ? 'remove from favourites' : 'keep this model at the top';
    star.setAttribute('aria-label', star.title);
    star.onclick = (e) => {
      // A star is not a pick: the menu stays open on the model you were looking at.
      e.stopPropagation();
      const set = new Set(Array.isArray(SET.favouriteModels) ? SET.favouriteModels : []);
      if (set.has(it.value)) set.delete(it.value); else set.add(it.value);
      SET.favouriteModels = [...set];
      saveSettings();
      renderModelMenu($('model-search') ? $('model-search').value : '');
    };
    row.appendChild(star);
    row.appendChild(el('span', 'model-label', it.label));
    if (it.missing) row.appendChild(el('span', 'model-provider', 'not available'));
    else if (!it.group) row.appendChild(el('span', 'model-provider', it.value.split('||')[0]));
    row.onclick = () => {
      const s = $('model-select');
      s.value = it.value;
      s.dispatchEvent(new Event('change'));
      toggleModelMenu(false);
    };
    list.appendChild(row);
  };

  if (favItems.length) {
    list.appendChild(el('div', 'model-group', 'favourites'));
    for (const it of favItems) addRow(it);
    if (rest.length) list.appendChild(el('div', 'menu-sep', ''));
  }
  let group = null;
  for (const it of rest) {
    if (it.group && it.group !== group) {
      group = it.group;
      list.appendChild(el('div', 'model-group', group));
    }
    addRow(it);
  }
  if (!favItems.length && !rest.length) {
    list.appendChild(el('div', 'model-empty', q ? `No model matches “${query}”` : 'No models reported yet'));
  }
}

function toggleModelMenu(open) {
  const menu = $('model-menu');
  if (!menu) return;
  const show = open == null ? menu.classList.contains('hidden') : open;
  if (!show) { menu.classList.add('hidden'); return; }
  menuOpenedAt = Date.now();
  closeMenu();   // one dropdown at a time - the thinking menu used to stay open behind it
  const btn = $('model-btn');
  const r = btn.getBoundingClientRect();
  const width = Math.max(280, Math.min(420, window.innerWidth - 24));
  menu.style.width = `${width}px`;
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - width - 8))}px`;
  menu.style.bottom = `${window.innerHeight - r.top + 6}px`;
  $('model-search').value = '';
  renderModelMenu('');
  menu.classList.remove('hidden');
  $('model-search').focus();
  const cur = menu.querySelector('.model-item.sel');
  if (cur) cur.scrollIntoView({ block: 'center' });
}

(function wireModelMenu() {
  const btn = $('model-btn');
  const menu = $('model-menu');
  if (!btn || !menu) return;
  btn.onclick = (e) => { e.stopPropagation(); refreshLlamaGroupThrottled(); toggleModelMenu(); };
  // Any change to the select (state sync, llama.cpp entry, a pick from the list)
  // has to be reflected on the button.
  $('model-select').addEventListener('change', () => updateModelBtn());
  $('model-search').oninput = (e) => renderModelMenu(e.target.value);
  $('model-search').onkeydown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); toggleModelMenu(false); input.focus(); }
    if (e.key === 'Enter') {
      const first = menu.querySelector('.model-item:not(.sel)') || menu.querySelector('.model-item.sel') || menu.querySelector('.model-item');
      if (first) first.click();
    }
  };
  menu.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => toggleModelMenu(false));
})();

/* pi-llama-cpp derives the provider id from the URL the user configured, so the
 * id for a server we discovered can differ by a trailing slash, the case of the
 * host, or localhost vs 127.0.0.1. Comparing the raw string made the UI think a
 * server was not registered: it listed a second copy of every model and selecting
 * one asked to "point pi here" and then failed with provider-not-found. Compare
 * normalised URLs instead, and use the id pi itself reported. */
function normLlamaUrl(u) {
  try {
    const x = new URL(String(u || '').trim());
    let host = x.hostname.toLowerCase();
    if (host === 'localhost') host = '127.0.0.1';
    const port = x.port || (x.protocol === 'https:' ? '443' : '80');
    return `${host}:${port}${x.pathname.replace(/\/+$/, '')}`;
  } catch (e) {
    return String(u || '').trim().replace(/\/+$/, '').toLowerCase();
  }
}

/* Every provider pi has for this server. Usually one (its base URL), but some
 * setups register one per model ("<base>/<model>") - a multi-model server, or a
 * newer pi-llama-cpp - and then a "set_model" with the bare server id is a model
 * that does not exist. */
function llamaRegisteredProviders(srv) {
  if (!srv) return [];
  const base = normLlamaUrl(srv.url);
  const out = [];
  for (const m of (S.models || [])) {
    const p = String(m.provider || '');
    if (!p.startsWith('llama-server=')) continue;
    const u = normLlamaUrl(p.slice('llama-server='.length));
    if ((u === base || u.startsWith(base + '/')) && !out.includes(p)) out.push(p);
  }
  return out;
}

/* The id to use for this server and (when given) this model: the per-model id if
 * pi has one, else the plain server id. Null when pi has nothing for the server. */
function llamaProviderFor(srv, modelId) {
  if (!srv) return null;
  const list = llamaRegisteredProviders(srv);
  // nothing registered: the id the extension *would* derive, so callers always have
  // a usable value (llamaRegistered() is what says whether pi knows the server)
  if (!list.length) return llamaSyntheticProvider(srv);
  if (modelId) {
    const want = '/' + String(modelId).toLowerCase();
    const byModel = list.find((p) => normLlamaUrl(p.slice('llama-server='.length)).toLowerCase().endsWith(want));
    if (byModel) return byModel;
  }
  return list.slice().sort((a, b) => a.length - b.length)[0];   // the plain server id
}

/* The id this server gets when pi has not registered it (what the extension
 * would derive), so the banner can still offer to point pi at it. */
function llamaSyntheticProvider(srv) {
  return srv ? (srv.providerId || `llama-server=${srv.url}`) : null;
}

function llamaRegistered(srv) {
  return llamaRegisteredProviders(srv).length > 0;
}

/* A live server that pi knows this provider id for (by URL, not by spelling). */
function llamaServerForProvider(provider) {
  const id = String(provider || '');
  if (!id.startsWith('llama-server=')) return null;
  const want = normLlamaUrl(id.slice('llama-server='.length));
  return (llamaLiveServers || []).find((x) => {
    const base = normLlamaUrl(x.url);
    return want === base || want.startsWith(base + '/');
  }) || null;
}

/* Repair a value that carries the model inside the URL - "<base>/<model>", which
 * is how a per-model provider id looks when the "||" separator was lost. Returns
 * {provider, modelId} or null when it cannot be told apart. */
function splitGluedModel(provider, modelId) {
  const glued = /:\/\//.test(String(modelId || '')) ? modelId : (/:\/\//.test(String(provider || '')) && !modelId ? provider : null);
  if (!glued) return null;
  const cut = String(glued).lastIndexOf('/');
  if (cut <= 'https://'.length) return null;
  const base = String(glued).slice(0, cut);
  const model = String(glued).slice(cut + 1);
  if (!model) return null;
  const srv = (llamaLiveServers || []).find((x) => normLlamaUrl(x.url) === normLlamaUrl(base));
  return { provider: srv ? (llamaProviderFor(srv, model) || `llama-server=${base}`) : `llama-server=${base}`, modelId: model, srv };
}

async function refreshModels() {
  try {
    const d = await rpc({ type: 'get_available_models' });
    S.models = asArray(d, 'models');
    const sel = $('model-select');
    sel.innerHTML = '';
    for (const m of S.models) {
      const o = el('option', null, `${m.name || m.id}`);
      // "||" separator: provider ids can contain colons (llama-server=http://host:8080)
      o.value = `${m.provider}||${m.id}`;
      sel.appendChild(o);
    }
    ensureLlamaGroup(); // retried in the background until the server answers
    if (S.state.model) syncSelect(sel, `${S.state.model.provider}||${S.state.model.id}`);
    updateModelBtn();
  } catch { /* agent may not implement it */ }
}

/* llama.cpp: query the router(s) directly so every model the server knows
 * about shows up — even ones pi has not registered yet. Selecting one sends
 * set_model with the "llama-server=<url>" provider id the pi-llama-cpp
 * extension uses. If pi has not registered that provider (e.g. its configured
 * URL is unreachable), a banner offers to point pi at the live server and
 * restart the agent so the model becomes selectable. */
let llamaLiveServers = [];
let llamaConfiguredUrls = [];
let llamaEnvOverride = null;   // LLAMA_SERVER_URL wins over the configured list
let llamaMismatchBanner = false;
let llamaFixInFlight = false;

async function refreshLlamaGroup() {
  const sel = $('model-select');
  const old = sel.querySelector('optgroup[data-llama]');
  if (old) old.remove();
  try {
    const [d, cfg] = await Promise.all([
      fetch(api('/api/llama-models')).then((r) => r.json()),
      fetch(api('/api/llama-config')).then((r) => r.json()),
    ]);
    llamaConfiguredUrls = Array.isArray(cfg.urls) ? cfg.urls : (cfg.url ? [cfg.url] : []);
    llamaEnvOverride = cfg.envOverride || null;
    llamaLiveServers = d.servers || [];
    if (!llamaLiveServers.length) {
      hideLlamaMismatch();
      return;
    }
    const known = new Set(S.models.map((m) => `${m.provider}||${m.id}`));
    const group = el('optgroup', null, 'llama.cpp (found on this machine or the LAN)');
    // A sweep that finishes after the menu was built left it stale - which is why
    // the models from the LAN only showed up on the second open.
    const before = ($('model-select').querySelector('optgroup[data-llama]') || {}).innerHTML || '';
    group.dataset.llama = '1';
    let unregistered = null;
    for (const srv of llamaLiveServers) {
      const short = srv.url.replace(/^https?:\/\//, '');
      const registered = llamaRegistered(srv);
      if (!registered && !unregistered) unregistered = srv;
      // the id pi registered this server under, so set_model works and the group
      // never duplicates what pi already listed
      const pid = llamaProviderFor(srv) || llamaSyntheticProvider(srv);
      for (const m of srv.models) {
        // Skip only when pi lists this model *for this server*. Matching the model
        // id alone hid the second instance's copy: two servers very often serve the
        // same file (the same model id), and the LAN one then vanished from the list
        // while its local twin was registered.
        const perModel = llamaProviderFor(srv, m.id);
        const key = `${perModel || pid}||${m.id}`;
        if (known.has(key)) continue;
        const o = el('option', null, llamaLiveServers.length > 1 ? `${m.name || m.id} · ${short}` : (m.name || m.id));
        o.value = key;
        group.appendChild(o);
      }
    }
    // A concurrent refresh (the retry loop below) can append a second group before
    // the first is removed, which showed every model twice. Keep one, and drop
    // options that repeat a value.
    const seenVals = new Set();
    group.querySelectorAll('option').forEach((o) => { if (seenVals.has(o.value)) o.remove(); else seenVals.add(o.value); });
    if (group.children.length) {
      sel.querySelectorAll('optgroup[data-llama]').forEach((g) => g.remove());
      sel.appendChild(group);
    }
    if (unregistered) showLlamaMismatch(unregistered);
    else hideLlamaMismatch();
    const after = ($('model-select').querySelector('optgroup[data-llama]') || {}).innerHTML || '';
    const menu = $('model-menu');
    if (after !== before && menu && !menu.classList.contains('hidden')) {
      renderModelMenu($('model-search') ? $('model-search').value : '');
      updateModelBtn();
    }
  } catch { /* bridge offline or no llama.cpp server */ }
}

function showLlamaMismatch(srv) {
  if (SET.llamaDismissed === srv.url) return;      // told once, not again
  const short = srv.url.replace(/^https?:\/\//, '');
  const isConfigured = llamaConfiguredUrls.some((u) => normLlamaUrl(u) === normLlamaUrl(srv.url));
  const configured = !isConfigured && llamaConfiguredUrls.length
    ? `pi is configured for ${llamaConfiguredUrls.map((u) => u.replace(/^https?:\/\//, '')).join(', ')} (the live server is not registered)`
    : 'pi has not registered it yet';
  showBanner('warn',
    `llama.cpp server found at ${short} with ${srv.models.length} models, but ${configured} — selecting its models will fail until pi is pointed at it. If pi-llama-cpp is not installed, install it with: pi install npm:pi-llama-cpp.`,
    `Point pi at ${llamaLiveServers.length > 1 ? `all ${llamaLiveServers.length} servers` : 'this server'} & reload`,
    () => fixLlamaConfig((llamaLiveServers.length ? llamaLiveServers : [srv]).map((x) => x.url)),
    () => {
      // Kept in the settings, so it does not come back for this server on the
      // next poll, reload or browser. A *different* server still gets a mention.
      SET.llamaDismissed = srv.url;
      saveSettings();
      toast('llama.cpp hint dismissed — the server is still listed in Settings → Pi providers');
    });
  llamaMismatchBanner = true;
}

function hideLlamaMismatch() {
  if (!llamaMismatchBanner) return;
  llamaMismatchBanner = false;
  hideBanner();
}

/* One-click fix: write the live URL into pi's global settings, restart the
 * agent (pi-llama-cpp resolves the URL at startup), then retry the model
 * the user was trying to select. */
/* Point pi at one server, or at all of them at once: the extension registers one
 * provider per entry of llamaSettings.servers, so a list gives every instance's
 * models in the picker without switching back and forth. */
async function fixLlamaConfig(urls) {
  if (llamaFixInFlight) return;
  const list = Array.isArray(urls) ? urls : [urls];
  llamaFixInFlight = true;
  toast(list.length > 1 ? `Pointing pi at ${list.length} servers and restarting the agent…` : 'Updating pi config and restarting the agent…');
  try {
    const r = await fetch(api('/api/llama-config'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: list }),
    });
    const out = await r.json();
    if (!r.ok) throw new Error(out.error || `failed (${r.status})`);
    const wait = waitForAgentReady(60000);
    send({ bridge: 'restart' });
    await wait;
    await initSession(true); // full re-init: resume last session + refresh models
    hideLlamaMismatch();
    if (S.pendingModel) {
      const pm = S.pendingModel;
      S.pendingModel = null;
      try {
        await rpc({ type: 'set_model', provider: pm.provider, modelId: pm.modelId });
        // applyState below picks up the model change and re-reads the levels
        await rpc({ type: 'get_state' }).then(applyState);
        toast(`Model switched: ${pm.modelId}`);
      } catch (e) {
        toast(`Agent restarted, but model switch failed: ${e.message}`, 'error');
      }
    }
  } catch (e) {
    toast(`Fix failed: ${e.message}`, 'error');
  } finally {
    llamaFixInFlight = false;
  }
}

/* The llama.cpp server may still be starting up (or pi's own 1s health check
 * at startup may have skipped it), so keep re-probing in the background until
 * at least one server answers. */
const LLAMA_RETRY_DELAYS = [3000, 5000, 10000, 15000, 20000, 30000];
async function ensureLlamaGroup(attempt = 0) {
  await refreshLlamaGroup();
  const g = $('model-select').querySelector('optgroup[data-llama]');
  // Stop retrying once every live server is registered with pi (its models
  // then appear in the main list, so the optgroup is intentionally empty).
  const allRegistered = llamaLiveServers.length > 0 &&
    llamaLiveServers.every((s) => llamaRegistered(s));
  if ((g && g.children.length) || allRegistered || attempt >= LLAMA_RETRY_DELAYS.length) return;
  const delay = LLAMA_RETRY_DELAYS[attempt] || LLAMA_RETRY_DELAYS[LLAMA_RETRY_DELAYS.length - 1];
  setTimeout(() => { ensureLlamaGroup(attempt + 1); }, delay);
}

let llamaGroupRefreshAt = 0;
$('model-select').addEventListener('focus', () => {
  const now = Date.now();
  if (now - llamaGroupRefreshAt < 10000) return; // throttle: max once per 10s
  llamaGroupRefreshAt = now;
  refreshLlamaGroup();
});
/* The select is hidden behind the model button now, so the same refresh runs
 * when the picker is opened. */
function refreshLlamaGroupThrottled() {
  const now = Date.now();
  if (now - llamaGroupRefreshAt < 10000) return;
  llamaGroupRefreshAt = now;
  refreshLlamaGroup();
  updateModelBtn();
}
