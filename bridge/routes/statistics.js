/*
 * Model/token statistics across every session.
 *
 * There is no separate counter file to drift out of sync: each pi session already
 * records model changes and the usage attached to every assistant message. This
 * route folds those records into per-provider/model totals for the hidden
 * /statistics view, reading the session files in the same streaming way the
 * transcript reader does. The result is cached against the session list's
 * path+mtime+size signature, so opening the view repeatedly does not reread every
 * file until a session actually changes.
 *
 * Reads only. Nothing here writes pi's files or contacts a provider.
 */
'use strict';

module.exports = function statisticsRoutes(deps) {
  const { jsonOut, scanSessions, sessionRef, sessionLines } = deps;
  const CACHE_MS = 20000;
  let cache = { sig: '', at: 0, data: null };

  const number = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const stamp = (v) => {
    const n = typeof v === 'number' ? v : Date.parse(String(v || ''));
    return Number.isFinite(n) ? n : 0;
  };

  async function aggregate() {
    const sessions = await scanSessions();
    const sig = sessions.map((s) => `${s.path}\u0001${s.mtime || 0}\u0001${s.size || 0}`).join('\u0002');
    if (cache.data && cache.sig === sig && Date.now() - cache.at < CACHE_MS) return cache.data;

    const models = new Map();
    const totals = {
      requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      reasoning: 0, totalTokens: 0, cost: 0, sessions: 0, unreadable: 0,
    };
    const bump = (row, key, n) => { row[key] += number(n); };

    for (const s of sessions) {
      const ref = sessionRef(s.path);
      if (!ref) { totals.unreadable++; continue; }
      let current = { provider: 'unknown', model: 'unknown' };
      let sessionTouched = false;
      try {
        for await (const raw of sessionLines(ref)) {
          if (!raw || !raw.trim()) continue;
          let e; try { e = JSON.parse(raw); } catch { continue; }
          if (!e || typeof e !== 'object') continue;
          if (e.type === 'model_change') {
            current = { provider: e.provider || current.provider, model: e.modelId || e.model || current.model };
            continue;
          }
          if (e.type !== 'message' || !e.message) continue;
          const m = e.message;
          if (m.role !== 'assistant' || !m.usage) continue;
          const provider = m.provider || current.provider || 'unknown';
          const model = m.model || m.modelId || current.model || 'unknown';
          const key = `${provider}\u0000${model}`;
          const row = models.get(key) || {
            provider, model, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
            reasoning: 0, totalTokens: 0, cost: 0, lastAt: 0,
          };
          const u = m.usage || {};
          const cost = typeof u.cost === 'number' ? u.cost : number(u.cost && u.cost.total);
          row.requests += 1;
          bump(row, 'input', u.input);
          bump(row, 'output', u.output);
          bump(row, 'cacheRead', u.cacheRead);
          bump(row, 'cacheWrite', u.cacheWrite);
          bump(row, 'reasoning', u.reasoning);
          bump(row, 'totalTokens', u.totalTokens != null ? u.totalTokens : number(u.input) + number(u.output));
          row.cost += cost;
          const at = stamp(m.timestamp || e.timestamp);
          if (at > row.lastAt) row.lastAt = at;
          models.set(key, row);
          totals.requests += 1;
          bump(totals, 'input', u.input);
          bump(totals, 'output', u.output);
          bump(totals, 'cacheRead', u.cacheRead);
          bump(totals, 'cacheWrite', u.cacheWrite);
          bump(totals, 'reasoning', u.reasoning);
          bump(totals, 'totalTokens', u.totalTokens != null ? u.totalTokens : number(u.input) + number(u.output));
          totals.cost += cost;
          sessionTouched = true;
        }
      } catch { totals.unreadable++; }
      if (sessionTouched) totals.sessions++;
    }

    const list = [...models.values()].sort((a, b) => b.totalTokens - a.totalTokens || b.requests - a.requests);
    for (const row of list) row.lastAt = row.lastAt || null;
    const data = { ok: true, generatedAt: Date.now(), models: list, totals };
    cache = { sig, at: Date.now(), data };
    return data;
  }

  return {
    match(req) {
      return req.url.split('?')[0] === '/api/statistics';
    },
    async handle(req, res) {
      if (req.method !== 'GET') { jsonOut(res, 405, { ok: false, error: 'use GET' }); return; }
      try {
        jsonOut(res, 200, await aggregate());
      } catch (e) {
        jsonOut(res, 500, { ok: false, error: `could not read session statistics: ${e.message}` });
      }
    },
  };
};
