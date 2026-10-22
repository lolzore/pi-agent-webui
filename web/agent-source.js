/* Where pi lives: on this machine, or inside a docker container (issue #157).
 *
 * The choice used to be a terminal prompt in start-webui.sh. It is asked here
 * now - on the setup screen and in Settings - and saved through the bridge to
 * the same file the scripts read, so the terminal is optional and the desktop
 * app needs no terminal at all. The bridge picks the change up the next time it
 * starts, which is exactly how the script's prompt always worked.
 */
'use strict';

let agentSourceState = null;

async function loadAgentSource() {
  try {
    agentSourceState = await fetch(api('/api/agent-source')).then((r) => r.json());
  } catch {
    agentSourceState = null;
  }
  return agentSourceState;
}

function fillAgentSourceUi(prefix) {
  const src = $(`${prefix}-source`);
  const box = $(`${prefix}-container`);
  const hint = $(`${prefix}-hint`);
  if (!src || !box) return;
  const st = agentSourceState;
  if (!st) {
    if (hint) hint.textContent = 'could not read the pi location from the bridge';
    return;
  }
  const d = st.detected || {};
  src.value = st.source || 'native';
  /* The container list is what docker has plus whatever is saved, so a saved
   * container that is not running right now is never silently replaced. */
  const names = [...new Set([...(d.containers || []), st.container].filter(Boolean))];
  box.replaceChildren();
  for (const n of names) {
    const o = el('option', null, n);
    o.value = n;
    box.appendChild(o);
  }
  if (!names.length) {
    const o = el('option', null, 'no containers found');
    o.value = '';
    box.appendChild(o);
  }
  if (st.container) box.value = st.container;
  box.classList.toggle('hidden', src.value !== 'docker');
  if (hint) {
    hint.textContent = st.envCommand
      ? 'PI_COMMAND is set for this bridge, so it wins here; the saved choice is what start-webui.sh and the desktop app will use.'
      : st.configured
        ? `saved: ${st.source === 'docker' ? `docker:${st.container}` : 'pi on this machine'} — takes effect when the bridge restarts`
        : `nothing saved yet — pi ${d.pi ? `found at ${d.pi}` : 'is not on PATH'}${d.docker ? ', docker is available' : ', docker is not installed'}`;
  }
}

async function saveAgentSource(prefix) {
  const src = $(`${prefix}-source`);
  const box = $(`${prefix}-container`);
  if (!src) return;
  const body = { source: src.value, container: box ? box.value : '' };
  try {
    const j = await fetch(api('/api/agent-source'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    if (!j.ok) throw new Error(j.error || 'could not save it');
    await loadAgentSource();
    fillAgentSourceUi(prefix);
    toast(`Pi location saved: ${body.source === 'docker' ? `docker:${body.container}` : 'on this machine'} — it takes effect when the bridge restarts`, 'ok');
  } catch (e) {
    toast(`Could not save the pi location: ${e.message}`, 'error');
  }
}

/* Wired once, for both places it is asked (the setup screen and Settings). */
function wireAgentSourceUi() {
  for (const prefix of ['set-pi', 'setup-pi']) {
    const src = $(`${prefix}-source`);
    if (!src || src._wired) continue;
    src._wired = true;
    src.onchange = () => {
      const box = $(`${prefix}-container`);
      if (box) box.classList.toggle('hidden', src.value !== 'docker');
      saveAgentSource(prefix);
    };
    const box = $(`${prefix}-container`);
    if (box) box.onchange = () => saveAgentSource(prefix);
  }
  loadAgentSource().then(() => {
    fillAgentSourceUi('set-pi');
    fillAgentSourceUi('setup-pi');
  }).catch(() => {});
}
