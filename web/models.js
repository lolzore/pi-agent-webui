/*
 * The model and thinking-level selects.
 *
 * Split out of app.js (issue #54). Loaded before app.js; the names stay
 * global, so nothing else changed. Behaviour is unchanged.
 */
'use strict';

/* ───────────────────────── model / thinking selects ───────────────────────── */

/* Issue #176: the model a *new* chat starts on.
 *
 * The picker's choice is per session - it is whatever you last switched to -
 * and a fresh session therefore began on whatever that was, which is not a
 * decision anyone made. The setting is opt-in: "same as last used" (the empty
 * value) keeps the old behaviour.
 */
function populateDefaultModelSelect() {
  const sel = $('set-default-model');
  if (!sel) return;
  const current = SET.defaultModel || '';
  const items = typeof modelMenuItems === 'function' ? modelMenuItems() : [];
  const opts = [el('option', null, 'Same as the last used model')];
  opts[0].value = '';
  for (const it of items) {
    const o = el('option', null, `${it.label}${it.group ? ` — ${it.group}` : ''}`);
    o.value = it.value;
    opts.push(o);
  }
  // a saved model pi no longer lists stays selectable, so the setting is not
  // silently reset by a stale model list
  if (current && !items.some((it) => it.value === current)) {
    const o = el('option', null, `${current.split('||')[1] || current} (not in the list right now)`);
    o.value = current;
    opts.push(o);
  }
  sel.replaceChildren(...opts);
  sel.value = current;
}

/* Switch a fresh session onto the default model, if one is set. Called right
 * after new_session - the three places that start one. */
async function applyDefaultModel() {
  const wanted = SET.defaultModel;
  if (!wanted || typeof rpc !== 'function') return;
  const sep = wanted.indexOf('||');
  const provider = sep >= 0 ? wanted.slice(0, sep) : wanted.split(':')[0];
  const modelId = sep >= 0 ? wanted.slice(sep + 2) : wanted.split(':').slice(1).join(':');
  if (!provider || !modelId) return;
  try {
    await rpc({ type: 'set_model', provider, modelId });
  } catch (e) {
    // pi may not have the model (it was removed, or its server is down): say so
    // rather than starting the chat on something the reader did not choose.
    toast(`Default model not applied (${wanted.split('||')[1] || wanted}): ${e.message}`, 'error');
  }
}

$('set-default-model').onchange = (e) => { SET.defaultModel = e.target.value || ''; saveSettings(); };

$('model-select').onchange = async (e) => {
  // llama.cpp entries use "provider||modelId" because the provider id itself
  // contains colons (llama-server=http://host:8080).
  let provider, modelId;
  const sep = e.target.value.indexOf('||');
  if (sep >= 0) {
    provider = e.target.value.slice(0, sep);
    modelId = e.target.value.slice(sep + 2);
  } else {
    [provider, ...rest] = e.target.value.split(':');
    modelId = rest.join(':');
  }
  let isLlama = provider.startsWith('llama-server=') || /:\/\//.test(String(modelId || ''));
  // A value can lose its "||" (an older page, a value from storage): then the model
  // id carries the server URL ("llama-server=http://host:8080/Model" arrived as the
  // model), and set_model answers "Model not found: llama-server=http://host:8080/Model".
  if (isLlama) {
    const repaired = splitGluedModel(provider, modelId);
    if (repaired) { provider = repaired.provider; modelId = repaired.modelId; }
    // and use the id pi actually has for this server/model (per-model ids included)
    const srv = llamaServerForProvider(provider);
    if (srv) {
      const better = llamaProviderFor(srv, modelId);
      if (better) provider = better;
    }
    isLlama = provider.startsWith('llama-server=');
  }
  // If pi has not registered this llama provider yet (its configured URL is
  // dead), point pi at the live server, restart the agent, then retry.
  if (isLlama && !S.models.some((m) => m.provider === provider)) {
    const live = llamaServerForProvider(provider);
    const all = (llamaLiveServers.length ? llamaLiveServers : [live]);
    if (live && confirm(`pi has not registered the llama.cpp server at ${live.url} yet.\n\nPoint pi at ${all.length > 1 ? `all ${all.length} live servers` : 'it'} and restart the agent? (writes llamaSettings.servers in your pi config)`)) {
      S.pendingModel = { provider, modelId };
      fixLlamaConfig(all.map((x) => x.url));
    }
    return;
  }
  if (/:\/\//.test(String(modelId || ''))) {
    toast(`That model entry is malformed (${String(modelId).slice(0, 60)}…) — the list is stale, close and reopen the model menu`, 'error');
    return;
  }
  try {
    await rpc({ type: 'set_model', provider, modelId });
    // The thinking levels are re-read by applyState, which notices the model
    // changed and refreshes the list (twice, because pi can still be settling
    // when set_model returns). Nothing to add here.
    await rpc({ type: 'get_state' }).then(applyState);
    toast(isLlama ? 'Model switched — loading into llama.cpp…' : 'Model switched');
  } catch (err) {
    toast(err.message + (isLlama
      ? ' — pi does not know this model yet. If the llama.cpp banner is showing, use "Point pi here & reload", or type /models in the chat'
      : ''), 'error');
  }
};

$('thinking-select').onchange = async (e) => {
  const wanted = e.target.value;
  try {
    const d = await rpc({ type: 'set_thinking_level', level: wanted });
    // The button is the only part of this control you can actually see (the
    // select is hidden), and it was refreshed by the full state sync alone - so
    // a new level showed up on the next page load and not before.
    if (d && d.thinkingLevel) syncSelect($('thinking-select'), d.thinkingLevel);
    updateThinkingBtn();
    toast(`Thinking level: ${$('thinking-select').value}`);
  } catch (err) {
    toast(err.message, 'error');
    // Put the old value back: the select had already been moved by the menu.
    rpc({ type: 'get_state' }).then(applyState).catch(() => {});
  }
};
