/*
 * The hidden model/token tracker.
 *
 * Nothing in the header points at it: `/statistics` opens this dialog. The bridge
 * folds every session's recorded usage (the model_change entries and the usage
 * attached to each assistant message) into one table, so totals survive session
 * switches, reloads and bridge restarts. It is read-only.
 */
'use strict';

function statisticsCost(n) {
  const v = Number(n) || 0;
  if (!v) return '$0.00';
  return `$${v < 0.01 ? v.toFixed(4) : v.toFixed(3)}`;
}

function statisticsWhen(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch { return '—'; }
}

function renderStatistics(d) {
  const list = $('statistics-list');
  const sub = $('statistics-sub');
  if (!list || !sub) return;
  list.innerHTML = '';
  const models = Array.isArray(d && d.models) ? d.models : [];
  const totals = (d && d.totals) || {};
  const sessions = Number(totals.sessions) || 0;
  sub.textContent = models.length
    ? `${models.length} model${models.length === 1 ? '' : 's'} across ${sessions} session${sessions === 1 ? '' : 's'} · read-only`
    : 'No token usage recorded in any session yet.';
  if (!models.length) {
    list.appendChild(el('div', 'statistics-empty', 'No usage recorded yet. A reply from a model will appear here.'));
    return;
  }
  const table = el('table', 'statistics-table');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of ['model', 'requests', 'input', 'output', 'cache read', 'cache write', 'reasoning', 'total', 'cost', 'last used']) {
    hr.appendChild(el('th', null, h));
  }
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el('tbody');
  for (const m of models) {
    const tr = el('tr');
    const name = el('td');
    name.appendChild(el('div', 'statistics-model', m.model || 'unknown'));
    name.appendChild(el('div', 'statistics-provider', m.provider || 'unknown'));
    tr.appendChild(name);
    tr.appendChild(el('td', null, String(m.requests || 0)));
    tr.appendChild(el('td', null, formatTok(m.input || 0)));
    tr.appendChild(el('td', null, formatTok(m.output || 0)));
    tr.appendChild(el('td', null, formatTok(m.cacheRead || 0)));
    tr.appendChild(el('td', null, formatTok(m.cacheWrite || 0)));
    tr.appendChild(el('td', null, formatTok(m.reasoning || 0)));
    tr.appendChild(el('td', null, formatTok(m.totalTokens || 0)));
    tr.appendChild(el('td', null, statisticsCost(m.cost)));
    tr.appendChild(el('td', null, statisticsWhen(m.lastAt)));
    tbody.appendChild(tr);
  }
  const totalRow = el('tr', 'statistics-total');
  totalRow.appendChild(el('td', null, 'all models'));
  totalRow.appendChild(el('td', null, String(totals.requests || 0)));
  totalRow.appendChild(el('td', null, formatTok(totals.input || 0)));
  totalRow.appendChild(el('td', null, formatTok(totals.output || 0)));
  totalRow.appendChild(el('td', null, formatTok(totals.cacheRead || 0)));
  totalRow.appendChild(el('td', null, formatTok(totals.cacheWrite || 0)));
  totalRow.appendChild(el('td', null, formatTok(totals.reasoning || 0)));
  totalRow.appendChild(el('td', null, formatTok(totals.totalTokens || 0)));
  totalRow.appendChild(el('td', null, statisticsCost(totals.cost)));
  totalRow.appendChild(el('td', null, ''));
  tbody.appendChild(totalRow);
  table.appendChild(tbody);
  list.appendChild(table);
}

async function openStatistics() {
  const dlg = $('statistics-dialog');
  if (!dlg) return;
  if (!dlg.open) dlg.showModal();
  const sub = $('statistics-sub');
  const list = $('statistics-list');
  if (sub) sub.textContent = 'Reading sessions…';
  if (list) list.innerHTML = '';
  try {
    const r = await fetch(api('/api/statistics'), { cache: 'no-store' });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || `request failed (${r.status})`);
    renderStatistics(d);
  } catch (e) {
    if (sub) sub.textContent = `Could not read statistics: ${e.message}`;
    if (list) list.textContent = '';
  }
}

if ($('statistics-close')) $('statistics-close').onclick = () => $('statistics-dialog').close();
