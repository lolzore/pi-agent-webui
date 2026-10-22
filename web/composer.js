/*
 * The composer: sending, the draft, edit & resend.
 *
 * Split out of app.js (issue #54). Loaded before app.js; the names stay
 * global, so nothing else changed. Behaviour is unchanged.
 */
'use strict';

/* ───────────────────────── composer / sending ───────────────────────── */

const input = $('input');

function autoSize() {
  // Empty composer: back to a single line. Without this the box kept the height
  // of whatever had been typed last, leaving a tall empty frame over the chat.
  input.style.height = 'auto';
  input.style.height = input.value.trim() ? Math.min(input.scrollHeight, 200) + 'px' : '';
  syncComposerText();
  // The chat shrinks as the box grows; without this the transcript shifted up
  // and the last thing written (a compaction marker, a tool call) slid out of
  // view while typing.
  if (S.stickToBottom) pinSoon();
}
let draftSaveTimer = null;
function saveDraftSoon() {
  if (draftSaveTimer) clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => { draftSaveTimer = null; saveDraft(); }, 400);
}
input.addEventListener('input', () => { autoSize(); updateSlashMenu(); saveDraftSoon(); });
// The composer is sized to its content, so it has to be re-measured when the
// layout width changes (font size setting, window resize, phone rotation).
let resizeReadingTimer = null;
window.addEventListener('resize', () => {
  // A resize can fire while the scripts are still loading (this file loads
  // before app.js, which owns S) - do nothing until the page is up (issue #54).
  if (typeof S === 'undefined' || !S) return;
  autoSize();
  if (!window.matchMedia('(max-width: 760px)').matches) $('sidebar').classList.remove('open');
  // A reflow moves the scroll position with it (the transcript's height changes).
  // Put the reader back where they were - twice, because the dock's own height
  // settles a frame later.
  if (!S.stickToBottom) {
    if (resizeReadingTimer) clearTimeout(resizeReadingTimer);
    restoreReading(1);
    resizeReadingTimer = setTimeout(() => { resizeReadingTimer = null; restoreReading(1); }, 250);
  }
  // A reflow can leave the view somewhere in the middle of a long transcript, and
  // the message being streamed (which lives in the DOM, not in the session file)
  // has to stay where it is. If we were following the bottom, come back to it.
  if (S.live && !S.live.root.isConnected && !S.viewSession && !S.liveDetached) chat.appendChild(S.live.root);
  if (S.stickToBottom) pinSoon();
});
// On a phone the sidebar is a drawer: tapping the conversation closes it.
chat.addEventListener('click', () => {
  if (window.matchMedia('(max-width: 760px)').matches) $('sidebar').classList.remove('open');
});

async function sendCurrent() {
  const text = input.value.trim();
  if (S.editMode) {
    if (!text) return;
    finishEdit(text);
    return;
  }
  if (!text && !S.attachments.length) return;

  if (text.startsWith('!') && text.length > 1) {
    sendBash(text.slice(1).trim());
    resetComposer();
    return;
  }

  // Prompts go to the agent's own session — never to the one being viewed.
  // (!bash above is session-independent and stays allowed.)
  if (S.viewSession && !text.startsWith('/')) {
    toast(S.isStreaming
      ? 'The agent is running in another session — click it in the list (green dot) to switch back before sending'
      : 'You are viewing another session — switch back before sending');
    return;
  }

  // While compaction is in flight the agent rejects new prompts. Hold the
  // message locally and send it once compaction finishes — don't lose it.
  if (S.compacting && !text.startsWith('/')) {
    S.compactionQueue.push({ text, images: S.attachments.slice() });
    toast(`Compaction in progress — queued your message (will send when it's done)`, 'info');
    resetComposer();
    return;
  }

  // What actually goes to the agent: a skill typed by its short name gets its
  // "skill:" prefix back here (and only here).
  let sendText = text;

  if (text.startsWith('/')) {
    const sp = text.indexOf(' ');
    let name = (sp >= 0 ? text.slice(1, sp) : text.slice(1)).toLowerCase();
    const arg = sp >= 0 ? text.slice(sp + 1).trim() : '';
    sendText = skillAwareCommand(text);
    if (sendText !== text) name = sendText.slice(1, sendText.indexOf(' ') > 0 ? sendText.indexOf(' ') : undefined).toLowerCase();

    /* Anything this command reports opens the notifications panel (issue #5),
     * with one exception: /compact. Its outcome is already drawn inline as the
     * "conversation compacted" marker and toasted, so throwing the panel open on
     * top of that is noise rather than a service - issue #44. The flag is cleared
     * again in the finally, so a later background notice cannot open it by
     * accident. */
    S.noticesFromCommand = name !== 'compact';
    try {

    // Client-local slash commands: executed by the UI, never sent to the agent.
    if (name === 'tts') { setAutoTts(!S.autoTts); resetComposer(); return; }
    if (name === 'autosend') {
      SET.voiceAutoSend = !SET.voiceAutoSend;
      saveSettings();
      toast(`Voice auto-send ${SET.voiceAutoSend ? 'ON — voice results send automatically' : 'OFF'}`);
      resetComposer();
      return;
    }
    if (name === 'thinking' && !arg) {
      // /thinking (no arg) toggles thinking-block visibility. /thinking <level>
      // (with an arg) falls through to the built-in set-thinking-level command.
      SET.showThinking = !(SET.showThinking !== false);
      saveSettings();
      toast(`Thinking blocks ${SET.showThinking !== false ? 'visible' : 'hidden'}`);
      resetComposer();
      return;
    }

    // Built-in pi commands that map to a direct RPC call (e.g. /compact, /new).
    let handled = false;
    try {
      handled = await handleBuiltinCommand(name, arg);
    } catch (e) {
      toast(`Command failed: ${e.message}`, 'error');
      return;
    }
    if (handled) {
      resetComposer();
      return;
    }

    // Only warn for commands not in any known list (local, agent, or pi built-in).
    const known = allCommands().find((c) => c.name.toLowerCase() === name || c.name.toLowerCase() === `skill:${name}`);
    if (!known) {
      toast(`"/${name}" is not a registered agent or UI command — sending to the model as text`, 'warning');
    }

    } finally {
      S.noticesFromCommand = false;
    }
  }

  startRunClock();
  // A real message from the user restarts the budget of automatic continuations.
  S.autoContinueStreak = 0;
  sendPrompt(sendText, S.attachments.slice(), undefined, true);
  resetComposer();
}

/* Built-in pi slash commands that have a direct RPC equivalent. Returns true
 * if the command was handled by the UI (don't send to the agent); false means
 * "send it to the agent as a normal prompt". Commands without a clean RPC
 * mapping (e.g. /tree, /settings, /fork) fall through to the agent. */
async function handleBuiltinCommand(name, arg) {
  // Agent-registered commands (extension/prompt/skill) take precedence over a
  // built-in with the same name — those are sent to the agent instead.
  if (S.commands.some((c) => c.name.toLowerCase() === name || c.name.toLowerCase() === `skill:${name}`)) {
    return false;
  }
  switch (name) {
    case 'compact': {
      if (S.compacting) { toast('Compaction already in progress…', 'warning'); return true; }
      S.compacting = true;
      toast('Compacting session…');
      setCtxRing(null);
      resetCtxHighWater();
      if ($('ctx-label')) $('ctx-label').textContent = ctxLabel('compacting…', '–');
      // Compaction makes an LLM call and can take minutes — the old 120s RPC
      // timeout fired first and reported a false failure while the agent kept
      // compacting. Don't block on the response; track progress via the
      // compaction_start / compaction_end events. The RPC promise is only a
      // backup for the case where those events never arrive.
      rpc({ type: 'compact' }, 10 * 60 * 1000)
        .catch((e) => {
          if (S.compacting) {
            S.compacting = false;
            toast(`Compact failed: ${e.message}`, 'error');
          }
        });
      return true;
    }
    case 'new': {
      try { await rpc({ type: 'new_session' }); await applyDefaultModel(); await initSession(false); }
      catch (e) { toast(`New session failed: ${e.message}`, 'error'); }
      return true;
    }
    case 'name': {
      if (!arg) { toast('Usage: /name <name>'); return true; }
      try { await rpc({ type: 'set_session_name', name: arg }); await refreshSessions(true); }
      catch (e) { toast(`Rename failed: ${e.message}`, 'error'); }
      return true;
    }
    case 'model': {
      const slash = arg.indexOf('/');
      if (slash <= 0) { toast('Usage: /model <provider/model>'); return true; }
      try {
        await rpc({ type: 'set_model', provider: arg.slice(0, slash), modelId: arg.slice(slash + 1) });
        const st = await rpc({ type: 'get_state' }); applyState(st);
      } catch (e) { toast(`Set model failed: ${e.message}`, 'error'); }
      return true;
    }
    case 'thinking': {
      if (!arg) { toast('Usage: /thinking <level>'); return true; }
      try {
        await rpc({ type: 'set_thinking_level', level: arg.split(/\s+/)[0] });
        const st = await rpc({ type: 'get_state' }); applyState(st);
      } catch (e) { toast(`Set thinking failed: ${e.message}`, 'error'); }
      return true;
    }
    case 'clone': {
      try { await rpc({ type: 'clone' }); await refreshSessions(true); }
      catch (e) { toast(`Clone failed: ${e.message}`, 'error'); }
      return true;
    }
    case 'reload': {
      // Same routine as the Settings button: the agent is restarted (which is
      // what re-reads extensions, skills, prompts, keybindings and themes) and
      // the session is resumed afterwards, so nothing is lost.
      await reloadPi();
      return true;
    }
    case 'copy': {
      try {
        const d = await rpc({ type: 'get_last_assistant_text' });
        if (d && d.text) { await navigator.clipboard.writeText(d.text); toast('Copied last assistant message'); }
        else toast('No assistant message to copy', 'warning');
      } catch (e) { toast(`Copy failed: ${e.message}`, 'error'); }
      return true;
    }
    case 'session': {
      await refreshStats();
      try {
        const d = await rpc({ type: 'get_session_stats' });
        const cu = d && d.contextUsage;
        const toks = cu && cu.tokens != null ? `${Math.round(cu.tokens)}/${Math.round(cu.contextWindow)}` : '–';
        const cost = d && d.cost && d.cost.total != null ? `$${Number(d.cost.total).toFixed(3)}` : '–';
        toast(`Session: ${S.sessionName || '(unnamed)'} · context ${toks} · cost ${cost}`);
      } catch { /* ignore */ }
      return true;
    }
    default:
      return false; // not handled here — send to the agent as a prompt
  }
}

function sendPrompt(text, images, behavior, fromComposer) {
  // A message the user sends is the user taking over again: whatever they
  // stopped before is no longer a reason to suppress an auto-continue.
  S.userStopped = false;
  const all = images || [];
  const imgs = all.filter((a) => a.type === 'image');
  const files = all.filter((a) => a.type === 'file');
  /* Frames the bridge took from an uploaded video (issue #72) are image content
   * like any other: they are sent with the prompt so a vision model can see the
   * clip, and they are drawn in the row the user sees. */
  for (const f of files) {
    if (f.kind !== 'video' || !Array.isArray(f.frames)) continue;
    for (const fr of f.frames) imgs.push({ type: 'image', data: fr.data, mimeType: fr.mimeType || 'image/jpeg' });
  }
  // Non-image attachments travel as path references in the prompt text so the
  // agent can open them with its tools (read, bash, etc.). Audio also carries
  // its transcript inline.
  let msg = text || '';
  if (files.length) {
    const refs = files.map((f) => {
      let line = `[Attached ${f.kind}: ${f.name} → ${f.path}]`;
      if (f.kind === 'audio' && f.transcript) line += `\nTranscript: ${f.transcript}`;
      else if (f.kind === 'audio') line += ' (no transcript available)';
      else if (f.kind === 'video' && f.frames && f.frames.length) line += ` (${f.frames.length} frames attached as images)`;
      else if (f.kind === 'video' && f.frameNote) line += ` (no frames: ${f.frameNote})`;
      return line;
    }).join('\n');
    msg = (msg ? msg + '\n\n' : '') + refs;
  }
  const cmd = { type: 'prompt', message: msg };
  if (imgs.length) {
    cmd.images = imgs.map((a) => ({ type: 'image', data: a.data, mimeType: a.mimeType }));
  }
  if (S.isStreaming) cmd.streamingBehavior = behavior || 'steer';
  /* The bubble is drawn at once, and kept only if the agent actually took the
   * message.
   *
   * It used to be drawn unconditionally and left in the DOM whatever happened.
   * Sending while the agent is busy with a compaction is the case that bites: pi
   * rejects the prompt, a toast says so, and the row stays on screen looking
   * delivered - until the next rebuild drops it, because it is not in the session
   * file. That is issue #49, "after a manual compaction my message disappeared ...
   * and after a reload I can see that it never even happened".
   *
   * Now the row is removed and the text goes back into the composer, so a message
   * that was not sent is visibly not sent and cannot be lost. */
  let row = null;
  if (text || all.length) {
    const content = [];
    for (const a of imgs) content.push({ type: 'image', data: a.data, mimeType: a.mimeType });
    if (msg) content.push({ type: 'text', text: msg });
    row = renderUserMessage({ role: 'user', content: content.length ? content : msg, timestamp: Date.now(), __live: true });
    /* Remember which session this row was sent to.
     *
     * The row lives only in the DOM until pi writes it to the file, and
     * refreshMessages() re-appends it after every rebuild so it is not lost in the
     * meantime (issue #1). It had no idea WHICH session it belonged to, so starting a
     * new chat re-appended it there too - the steered message appearing in a chat it
     * was never sent to (issue #52). */
    row.dataset.liveSession = (S.state && S.state.sessionFile) || '';
    S.stickToBottom = true;
    scrollBottom(true);
  }
  rpc(cmd).catch((e) => {
    if (row && row.isConnected) row.remove();
    if (fromComposer) restoreComposer(text, all);
    toast(fromComposer ? `${e.message} — your message is back in the box` : e.message, 'error');
  });
}

/* Send a bash command and stream its output into the card it belongs to.
 *
 * The id has to exist BEFORE the request goes out, because it is the key the
 * card is filed under. It used to be read off the object before `rpc()` had
 * assigned it:
 *
 *     const cmd = { type: 'bash', command };
 *     S.bashCards.set(cmd.id, { body: out });   // cmd.id is undefined
 *     const d = await rpc(cmd);                  // rpc assigns cmd.id only now
 *     S.bashCards.delete(cmd.id);                // the real id - never a key
 *
 * so the card was stored under `undefined` and every `bash_execution_update`
 * (which carries the real request id) missed it - the output only ever appeared
 * at the end, and one `undefined` entry leaked per command. The id is now
 * allocated here, so both the store and the lookup see the same value, and the
 * delete happens whatever the request does. */
async function sendBash(command) {
  const { root, bubble } = makeMsgShell('system', `system · ${timeStr()}`);
  root.querySelector('.who').remove();
  const out = el('div', null, `$ ${command}\n`);
  bubble.appendChild(out);
  transcriptHost().appendChild(root);
  scrollBottom(true);
  const id = `req-${++S.reqId}`;
  try {
    S.bashCards.set(id, { body: out });
    noteTerminalStart({ id, command, session: S.state && S.state.sessionName });
    const d = await rpc({ type: 'bash', command, id });
    out.textContent = `$ ${command}\n${(d && d.output) || '(no output)'}`;
    if (d && d.exitCode) toast(`Command exited with code ${d.exitCode}`, 'warning');
  } catch (e) {
    out.textContent += `\n[error] ${e.message}`;
  } finally {
    S.bashCards.delete(id);
    noteTerminalEnd(id);
  }
}

/* ── the composer's draft ────────────────────────────────────────────────
 * What you have typed but not sent is worth keeping: the UI reloads itself after
 * some webview hiccups, and a reload used to take the text and the attachments
 * with it. Kept per session (and per instance), so switching sessions does not
 * move a draft from one conversation to another. Switching *instances* still
 * starts clean - that changes everything else too. */
function draftKey() {
  const p = S.viewSession || (S.state && S.state.sessionFile) || 'none';
  return `piwebui-draft:${instanceKey()}:${String(p).slice(-120)}`;
}

function saveDraft() {
  const key = draftKey();
  const text = (typeof input !== 'undefined' && input.value) ? input.value : '';
  try {
    if (!text && !(S.attachments || []).length) { localStorage.removeItem(key); return; }
    const attachments = (S.attachments || []).map((a) => {
      /* An image has no path on disk - it IS its bytes - so the old fallthrough
       * here stored `path: a.path` for anything too big to keep, which for an
       * image is undefined. A reload then restored an attachment with no data,
       * which drew nothing and, if it was sent, carried `data: undefined` to the
       * agent. Only what can actually be restored is kept now. */
      if (a.type === 'image') {
        const keep = typeof a.data === 'string' && a.data.length < 400000;
        return keep ? { type: 'image', mimeType: a.mimeType, name: a.name, data: a.data } : null;
      }
      // Non-images are kept by their path on this machine, which is all the agent
      // needs to open them again.
      return { type: a.type, kind: a.kind, name: a.name, path: a.path, size: a.size, mimeType: a.mimeType, transcript: a.transcript };
    }).filter(Boolean);
    localStorage.setItem(key, JSON.stringify({ text, attachments, at: Date.now() }));
  } catch { /* quota or private mode: a convenience, not state */ }
}

function loadDraft() {
  try {
    const raw = localStorage.getItem(draftKey());
    if (!raw) return;
    const d = JSON.parse(raw);
    if (!d || (!d.text && !(d.attachments || []).length)) return;
    if (typeof input !== 'undefined' && d.text) { input.value = d.text; autoSize(); }
    if ((d.attachments || []).length) { S.attachments = d.attachments; renderAttachments(); }
    toast('Restored what you had typed');
  } catch { /* nothing to restore */ }
}

function clearDraft() {
  try { localStorage.removeItem(draftKey()); } catch { /* private mode */ }
}

function resetComposer() {
  clearDraft();
  input.value = '';
  autoSize();
  clearAttachments();
  closeSlashMenu();
  updateEditBanner();
  syncComposerText();
  input.focus();
}

/* Put a message that failed to send back where it came from. The attachments
 * are handed back as they were, so an uploaded picture does not have to be
 * picked again, and the draft is saved so a reload does not lose it either. */
function restoreComposer(text, attachments) {
  if (text) input.value = text;
  if (attachments && attachments.length) { S.attachments = attachments.slice(); renderAttachments(); }
  autoSize();
  syncComposerText();
  saveDraft();
}

/* The ring around the typed text stays visible whenever the composer has
 * content, not only while it is focused, so the box never looks empty. */
function syncComposerText() {
  const row = document.querySelector('.composer-row');
  if (!row) return;
  row.classList.toggle('has-text', !!input.value.trim() || S.attachments.length > 0);
}

$('btn-send').onclick = sendCurrent;
$('btn-stop').onclick = stopAgent;

async function stopAgent() {
  if (speechSynthesis.speaking) { speechSynthesis.cancel(); S.speaking = false; return; }
  try {
    /* Ask pi to hand back its pending queue and drop it (issue #53).
     *
     * pi keeps steering and follow-up messages in its own queue, and abort() does not
     * touch it - `abort()` calls `agent.abort()` and waits for idle, nothing more. So a
     * message that was queued and never taken is still there afterwards and is
     * delivered on the next turn, which is a command you sent earlier reappearing later
     * as though it had been re-sent. pi has had `clearQueue()` all along, documented as
     * "useful for restoring to editor when user aborts", but it was not reachable over
     * RPC - so the WebUI restored its own copy from the last queue_update and left pi's
     * copy in place. pi 1.0.0 added the `clear_queue` command, which returns the
     * pending messages AND empties the queue: exactly this. */
    let restored = [...S.queue.steering, ...S.queue.followUp]
      .map((m) => (typeof m === 'string' ? m : ''))
      .filter(Boolean);
    let cleared = false;
    try {
      const r = await rpc({ type: 'clear_queue' });
      // The returned lists are pi's own, so they are what actually has to come back
      // to the box - not the copy we were keeping from queue_update.
      restored = [...((r && r.steering) || []), ...((r && r.followUp) || [])]
        .map((m) => (typeof m === 'string' ? m : ''))
        .filter(Boolean);
      cleared = true;
    } catch { /* older pi: no clear_queue, fall back to the client-side copy */ }
    await rpc({ type: 'abort' });
    // pi can be mid-retry or running a bash tool when Stop is pressed; these
    // are the commands for exactly that, and are best-effort (an older pi
    // answers an error, which is ignored). Issue #56.
    rpc({ type: 'abort_retry' }).catch(() => {});
    rpc({ type: 'abort_bash' }).catch(() => {});
    S.userStopped = true;
    S.queue = { steering: [], followUp: [] };
    renderQueue();
    if (restored.length) {
      input.value = restored.join('\n---\n') + (input.value ? '\n' + input.value : '');
      autoSize();
    }
    toast(restored.length
      ? `Aborted - ${restored.length} unsent message${restored.length > 1 ? 's' : ''} back in the box${cleared ? '' : ' (this pi version cannot clear its queue, so it may still run them)'}`
      : 'Aborted');
  } catch (e) { toast(e.message, 'error'); }
}

/* ───────────────────────── edit & resend (fork) ───────────────────────── */

async function startEdit(msg, forkIdx) {
  const { text } = messageBlock(msg.content);
  /* The active-branch ids are what makes the fork land on the turn you clicked,
   * and they are only fetched here (see ensureForkTree) - a fork is a
   * deliberate act. If it cannot be had, the cheap list is used. */
  if (typeof ensureForkTree === 'function') await ensureForkTree();
  const lists = [S.forkEntries || [], S.forkable || []];
  const idx = parseInt(forkIdx, 10);
  let f = null;
  for (const list of lists) {
    if (!f && list[idx] && list[idx].text === text) f = list[idx];
  }
  if (!f) {
    for (const list of lists) { if (!f) f = list.find((x) => x.text === text); }
  }
  // still nothing: take the row's place in the conversation rather than refusing
  if (!f) {
    for (const list of lists) { if (!f && list[idx]) f = list[idx]; }
  }
  if (!f) { toast('Cannot locate a fork point for this message', 'error'); return; }
  S.editMode = { entryId: f.entryId, originalText: text };
  input.value = text;
  autoSize();
  updateEditBanner();
  input.focus();
}

function updateEditBanner() {
  const b = $('edit-banner');
  if (S.editMode) {
    b.classList.remove('hidden');
    $('edit-banner-text').textContent = `Editing an earlier message — sending will fork the session from that point. Original: "${S.editMode.originalText.slice(0, 60)}${S.editMode.originalText.length > 60 ? '…' : ''}"`;
  } else {
    b.classList.add('hidden');
  }
}

$('btn-cancel-edit').onclick = () => {
  S.editMode = null;
  input.value = '';
  autoSize();
  updateEditBanner();
};

async function finishEdit(newText) {
  const edit = S.editMode;
  S.editMode = null;
  updateEditBanner();
  try {
    await rpc({ type: 'fork', entryId: edit.entryId });
    // the branch just changed, so anything cached for it is stale
    forkInFlight = null; forkSessionKey = null;
    await refreshMessages();
    await ensureForkable();
    startRunClock();
    sendPrompt(newText, S.attachments.slice(), undefined, true);
    resetComposer();
  } catch (e) {
    toast(`Fork failed: ${e.message}`, 'error');
  }
}
