/*
 * The pi location (issue #157): which machine pi runs on.
 *
 * GET  /api/agent-source -> the saved choice, whether the environment overrides
 *                           it, and what is actually available here (pi on
 *                           PATH, docker, the containers that exist)
 * POST /api/agent-source -> save { source: 'native'|'docker', container }
 *
 * The file this writes is the one start-webui.sh reads, so the scripts and the
 * WebUI always agree. A change is picked up when the bridge next starts (the
 * scripts have always worked that way), which the reply says explicitly.
 */
'use strict';

module.exports = function sourceRoutes(deps) {
  const { agentSource, execFile, jsonOut } = deps;

  const match = (req) => req.url.startsWith('/api/agent-source');

  async function handle(req, res) {
    if (req.method === 'GET') {
      const saved = agentSource.read();
      const detected = await agentSource.detect(execFile);
      jsonOut(res, 200, {
        ok: true,
        ...saved,
        envCommand: !!process.env.PI_COMMAND,
        envSessionDir: !!(process.env.PI_CODING_AGENT_SESSION_DIR || process.env.PI_SESSION_DIR),
        effective: {
          command: agentSource.command(),
          sessionDir: agentSource.sessionDir() || null,
        },
        detected,
      });
      return;
    }
    if (req.method !== 'POST') { jsonOut(res, 405, { ok: false, error: 'GET or POST' }); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1 << 16) req.destroy(); });
    await new Promise((r) => { req.on('end', r); req.on('error', r); });
    let j = null;
    try { j = JSON.parse(body || '{}'); } catch { j = null; }
    if (!j || typeof j !== 'object') { jsonOut(res, 400, { ok: false, error: 'expected a JSON body' }); return; }
    try {
      const saved = agentSource.write({ source: j.source, container: j.container });
      jsonOut(res, 200, {
        ok: true,
        ...saved,
        restartRequired: true,
        note: 'saved - the bridge uses it the next time it starts (start-webui.sh and the desktop app read the same file)',
      });
    } catch (e) {
      jsonOut(res, 400, { ok: false, error: e.message });
    }
  }

  return { match, handle };
};
