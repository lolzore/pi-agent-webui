/*
 * The transcript: user and assistant messages, tool cards, thinking blocks,
 * compaction blocks, and the session reader that turns a session file into
 * those nodes.
 *
 * Split out of app.js (issue #54, phase 4). Loaded before app.js; the names
 * stay global, so nothing else changed. Behaviour is unchanged.
 */
'use strict';

/* pi's user messages and the forkable list are both in order, so pair them up as
 * the transcript renders; identical texts then keep working. The list comes from
 * get_entries, not get_fork_messages: get_entries keeps pre-compaction history
 * and abandoned branches, so an old message - or one before the last compaction
 * - is still forkable instead of only the tail of the session. */
let forkQueue = [];
function resetForkQueue() { forkQueue = (S.forkEntries || []).map((f) => ({ ...f, used: false })); }
function takeForkable(text) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const t = norm(text);
  let hit = forkQueue.find((f) => !f.used && norm(f.text) === t);
  if (!hit) hit = forkQueue.find((f) => !f.used);
  if (hit) hit.used = true;
  return hit || null;
}

/* One "[Attached …: name → path]" line as the file it names. The bridge serves
 * the uploads directory back (and nothing outside it); a path that is gone or
 * outside falls back to the plain reference, so nothing is hidden. */
function attachmentRefNode(ref) {
  const wrap = el('div', 'msg-attach');
  const url = api(`/api/upload-file?path=${encodeURIComponent(ref.path)}`);
  if (ref.kind === 'video') {
    const v = el('video', 'msg-video');
    v.controls = true;
    v.preload = 'metadata';
    v.src = url;
    v.onerror = () => {
      v.remove();
      wrap.appendChild(el('div', 'msg-attach-bad', `[Attached video: ${ref.name} → ${ref.path}]`));
    };
    wrap.appendChild(v);
    wrap.appendChild(el('div', 'msg-attach-name', ref.name));
    return wrap;
  }
  const a = el('a', 'msg-attach-file', ref.name);
  a.href = url;
  a.target = '_blank';
  a.rel = 'noreferrer';
  a.title = ref.path;
  wrap.appendChild(a);
  return wrap;
}

function renderUserMessage(msg) {
  const { text, images } = messageBlock(msg.content);
  const { root, tools, bubble } = makeMsgShell('user', `you · ${timeStr(msg.timestamp)}`);
  root._msg = msg;
  /* Marked so a transcript rebuild can tell this row apart from one that came
   * from the session file. A row drawn here from a send exists only in the DOM:
   * pi has not written the message yet, so a rebuild - which renders from the
   * file - would otherwise drop it. See the carry-over in refreshMessages(). */
  if (msg.__live) root.dataset.live = '1';
  // Fork entry for this turn. A session read from disk carries its entry id;
  // for the agent's own session it is matched from the entry list. A row that
  // was just sent by this window is skipped: it is not in the file yet, so it
  // has no entry to point at, and consuming one would shift every later match.
  const fk = msg.entryId ? { entryId: msg.entryId } : (msg.__live ? null : takeForkable(text));
  if (fk) { root.dataset.fork = fk.entryId; root.dataset.forktext = text.slice(0, 300); }
  addCopyButton(tools, () => text);
  // fork index is (re)written onto the element by refreshMessages; read it at click time
  addToolButton(tools, 'edit', 'Edit & resend (forks the session from here)',
    () => startEdit(msg, root.dataset.forkIdx));

  if (images.length) {
    for (const im of images) {
      const src = imageDataUrl(im);
      if (!src) continue;
      const img = el('img', 'msg-img');
      lazySrc(img, src);
      img.onclick = () => zoomImage(img.dataset.src || src);
      // a picture the bridge named but that has since moved (a compaction
      // rewrote the file) answers 404: show that rather than a broken glyph
      img.onerror = () => { img.classList.add('img-missing'); img.removeAttribute('src'); };
      bubble.appendChild(img);
    }
  }
  /* Uploaded files are referenced in the text as "[Attached video: name →
   * path]" so the agent's tools can open them. The transcript shows the file
   * that line names - a playable video, or a chip that opens it - instead of
   * only the path (issue #62). Copy and fork still use the full text. */
  const refs = [];
  const bodyText = text.replace(/^\[Attached (video|audio|pdf|file): (.*?) → (.*?)\]$/gm, (m, kind, name, p) => {
    refs.push({ kind, name, path: p });
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();
  for (const ref of refs) bubble.appendChild(attachmentRefNode(ref));
  if (bodyText) {
    const body = el('div', 'md');
    body.innerHTML = renderMarkdown(bodyText).replace(/^<p>/, '').replace(/<\/p>$/, '');
    bubble.appendChild(body);
  }
  transcriptHost().appendChild(root);
  scrollBottom();
  // Returned so a caller that drew this row optimistically can take it back if
  // the message turns out not to have been delivered (see sendPrompt).
  return root;
}

/* Estimated written tokens for a live message, used while streaming and as a
 * fallback when the provider never reports usage. */
function estWriteTokens(L) {
  if (!L) return 0;
  return Math.round((L.text.length + L.thinking.length) / 4);
}

/* Remember how long a message took so a later re-render (tool cards arriving,
 * a session re-read, a page reload) keeps the tokens/sec figure instead of
 * silently dropping it. Keyed by the message timestamp pi stores. */
function rememberTiming(msg, timing) {
  const key = msg && (msg.timestamp != null ? `t${msg.timestamp}` : (msg.id ? `i${msg.id}` : null));
  if (key && timing) S.msgTiming.set(key, timing);
  return timing;
}

function timingFor(msg, timing) {
  if (timing && (timing.elapsedSec || timing.prefillSec || timing.est)) {
    return rememberTiming(msg, timing);
  }
  const key = msg && (msg.timestamp != null ? `t${msg.timestamp}` : (msg.id ? `i${msg.id}` : null));
  if (key && S.msgTiming.has(key)) return S.msgTiming.get(key);
  return timing || null;
}

/* Messages read back from a session file have no live timings. The gap to the
 * previous message is the turn's duration, which is enough to show a rate - it
 * includes the prompt read, so the figure is a little conservative. */
function noteHistoryTiming(msg, prevTs) {
  const key = msg && msg.timestamp != null ? `t${msg.timestamp}` : null;
  if (!key || S.msgTiming.has(key)) return;
  if (prevTs == null || msg.timestamp == null) return;
  const sec = (msg.timestamp - prevTs) / 1000;
  if (sec > 0.05 && sec < 3600) S.msgTiming.set(key, { elapsedSec: sec, prefillSec: null });
}

/* Why a turn stopped, when it stopped because something failed (issue #59).
 *
 * A failed turn arrives as an assistant message with stopReason "error", an
 * errorMessage holding the actual reason, and content: [] - nothing to render. The
 * transcript fell through to the literal text "(empty message)" and the reason was
 * only ever shown in a toast that goes away, so a reload lost it. The complaint was
 * exact: "'Provider network error' is the only thing I see in the webui, meanwhile
 * in pi agent I can see the exact reason for it."
 *
 * Across the sessions on this machine there are 548 of these, and the reasons are
 * specific and worth having: "Provider finish_reason: network_error",
 * '429: {"message":"Concurrent request limit exceeded..."}', "502 <html>...",
 * "504 <html>...", "Request timed out.", "400: {\"code\":400,\"message\":\"request
 * (65188 tokens) exceeds the available...\"}". pi's own terminal shows these; this
 * does now too, and pi writes errorMessage into the session file, so it survives a
 * reload rather than living in a toast.
 *
 * Folded when long: a provider can return a whole HTML error page, and one failure
 * should not fill the screen. The text is in a <pre> so it can be selected and
 * copied - it is usually the thing you paste into a search. */
/* A one-line headline for an error, which is not the same as its first line.
 *
 * The most common long failure here is an nginx error page, whose first line is
 * "502 <html>" - true, and useless. Its <title> says "502 Bad Gateway", which is
 * what a person needs. So a first line that is mostly markup is passed over in
 * favour of the title. */
function errorHeadline(text) {
  const title = /<title>([^<]{2,140})<\/title>/i.exec(text);
  const first = (text.split(/\r?\n/).find((l) => l.trim()) || '').trim();
  const plain = first.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (plain.length >= 12) return plain;
  if (title) return title[1].replace(/\s+/g, ' ').trim();
  return plain || text.slice(0, 80);
}

function makeErrorBlock(msg) {
  const text = String(msg.errorMessage || '').trim() || 'The turn failed without a reason from the provider.';
  const where = [msg.provider, msg.model].filter(Boolean).join(' · ');
  const d = el('details', 'msg-error');
  /* Folded when it is more than a line or two. A short reason is the whole point of
   * the block, so it is open; an HTML error page is not something to unfold the
   * transcript for, and its headline is on the summary either way. */
  const headline = errorHeadline(text);
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).length;
  d.open = text.length <= 240 && lines <= 3;
  const sum = el('summary');
  sum.appendChild(el('span', 'msg-error-head', 'stopped: ' + (headline.length > 110 ? headline.slice(0, 110) + '…' : headline)));
  if (where) sum.appendChild(el('span', 'msg-error-where', where));
  d.appendChild(sum);
  const body = el('pre', 'msg-error-body', text);
  body.title = 'click to select the whole reason';
  body.onclick = () => {
    // One click selects it all: the reason is short enough that picking part of it
    // out by dragging is more work than copying the lot.
    try {
      const r = document.createRange();
      r.selectNodeContents(body);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    } catch { /* selection is a convenience */ }
  };
  d.appendChild(body);
  const tools = el('div', 'msg-error-tools');
  const copy = el('button', 'btn small', 'copy the reason');
  copy.onclick = (e) => { e.preventDefault(); copyText(text, 'Copied the reason'); };
  tools.appendChild(copy);
  if (where) tools.appendChild(el('span', 'msg-error-where', where));
  d.appendChild(tools);
  return d;
}

function renderAssistantMessage(msg, timing) {
  timing = timingFor(msg, timing);
  const { root, tools, bubble } = makeMsgShell('assistant', timeStr(msg.timestamp));
  root._msg = msg;
  ensureTick();     // the newest messages take the animated avatars over from the old ones
  const textBlocks = [];
  let stats = usageStats(msg.usage, timing && timing.elapsedSec, timing && timing.prefillSec);
  if (!stats && timing && timing.est) stats = estStatsText(timing.est, timing.elapsedSec);
  if (stats) {
    const s = el('span', 'agent-stats', ` (${stats})`);
    s.title = (msg.usage
      ? 'token usage: input+cache read / output written'
      : 'estimated token usage - this provider did not report any') +
      (timing && timing.elapsedSec ? ` over ${Math.round(timing.elapsedSec)}s of streaming` : '');
    // Stats before the action buttons: "Pi · 04:30 PM (↑ 43.6K read · ↓ 523 write) [copy] [speak]"
    root.querySelector('.who').insertBefore(s, tools);
  }
  addCopyButton(tools, () => textBlocks.join('\n\n'));
  addSpeakButton(tools, () => stripMarkdown(textBlocks.join('\n\n')));

  /* Narration that exists only to introduce a tool call is hidden with the tool
   * calls themselves (issue #36).
   *
   * With the tool cards off, what is left of a message like "Let me check that
   * file" is text about a call the reader cannot see - and pi emits one before
   * most calls, so a turn reads as a wall of it. The text *after* the first
   * toolCall is kept: that is not narration, it is the message continuing.
   *
   * Nothing is hidden that would leave a gap: renderAssistantMessage's caller
   * already marks a message with no visible content as hollow and hides it, so a
   * message that was only narration disappears entirely rather than leaving an
   * empty bubble with a timestamp in it. */
  const blocks = msg.content || [];
  const firstToolAt = SET.showToolCalls === false ? blocks.findIndex((b) => b && b.type === 'toolCall') : -1;
  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi];
    if (block.type === 'text') {
      if (firstToolAt >= 0 && bi < firstToolAt) continue;   // narration for a hidden call
      textBlocks.push(block.text);
      const d = el('div', 'md');
      d.innerHTML = renderMarkdown(block.text);
      bubble.appendChild(d);
    } else if (block.type === 'thinking') {
      bubble.appendChild(makeThinking(block.thinking || ''));
    } else if (block.type === 'toolCall') {
      // A call can still be executing when its assistant message is finalised
      // (message_end arrives before the tool runs), and finalizeLive re-renders
      // the message from history here. Keep such a card running, timer and all,
      // instead of showing a finished-looking card for a command that is
      // literally still executing.
      const prev = S.toolCards.get(block.id);
      const wasRunning = !!(prev && prev._timer);
      const card = makeToolCard(block.name, { toolCallId: block.id, state: wasRunning ? 'running' : 'done' });
      if (wasRunning) {
        clearInterval(prev._timer);
        card._start = prev._start;
        card._timeoutMs = prev._timeoutMs || 0;
        startCardTimer(card);
      }
      noteToolTimeout(card, block.arguments);
      fillToolBody(card, block.name, block.arguments);
      bubble.appendChild(card.card);
      S.toolCards.set(block.id, card);
    }
  }
  /* The reason, in the transcript rather than in a toast (issue #59). Placed after
   * the blocks so a turn that produced some text before failing shows both, and
   * before the "(empty message)" fallback below, which is what a failed turn used
   * to display. */
  if (msg.errorMessage || msg.stopReason === 'error') bubble.appendChild(makeErrorBlock(msg));
  if (!bubble.childNodes.length) bubble.appendChild(el('div', 'md', '(empty message)'));
  transcriptHost().appendChild(root);  scrollBottom();
}

function makeThinking(text) {
  const d = el('details', 'thinking');
  d.open = SET.autoExpandThinking === true;
  d.appendChild(el('summary', null, 'thinking'));
  const body = el('div', 'th-body', text);
  d.appendChild(body);
  return d;
}

/* Three dots that bob in a wave. Used by the live message header and by the
 * "running" label on a tool card - the text itself deliberately stays still. */
function makeDots(cls) {
  const dots = el('span', cls || 'streaming-dots');
  for (let i = 0; i < 3; i++) dots.appendChild(el('span', 'dot', '.'));
  return dots;
}

/* Put a tool card back into its running state (the label is a bare "running"
 * with the animated dots after it, so only the dots move). */
function setCardRunning(card) {
  if (!card) return;
  const label = card.stateEl.querySelector('.tool-state-label');
  if (label) label.textContent = 'running';
  else card.stateEl.textContent = 'running';
  if (!card.stateEl.querySelector('.streaming-dots')) card.stateEl.appendChild(makeDots());
  card.stateEl.className = 'tool-state running';
}

function makeToolCard(name, opts = {}) {
  const card = el('div', `tool-card${name === 'bash' ? ' bash-card' : ''}`);
  const head = el('div', 'tool-head');
  head.appendChild(el('span', 'tool-name', `${name}`));
  const state = opts.state || 'running';
  // finished cards keep their colour too: the rebuilt-from-history cards used to
  // come back with no state class at all, so a done call lost its green label
  const stateCls = state === 'running' ? ' running' : (state === 'done' || state === 'error' ? ` ${state}` : '');
  const stateEl = el('span', `tool-state${stateCls}`);
  stateEl.appendChild(el('span', 'tool-state-label', state));
  if (state === 'running') stateEl.appendChild(makeDots());
  head.appendChild(stateEl);
  const timerEl = el('span', 'tool-timer hidden');
  head.appendChild(timerEl);
  const body = el('div', 'tool-body hidden');
  head.onclick = () => body.classList.toggle('hidden');
  card.append(head, body);
  const cardObj = { card, head, body, stateEl, timerEl, _timer: null, _start: 0, _running: false, _timeoutMs: 0, _bodySticky: true };
  /* While the arguments stream in, the body follows the newest line. If the
   * reader scrolls up to look at an earlier part, that must not be yanked back
   * down by the next delta (issue #67). */
  body.addEventListener('scroll', () => {
    cardObj._bodySticky = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
  });
  return cardObj;
}

/* pi's bash tool takes `timeout` in seconds; remember it so the card can count
 * down instead of just counting up. */
function noteToolTimeout(card, args) {
  if (!card || !args || typeof args !== 'object') return;
  const t = args.timeoutSeconds != null ? args.timeoutSeconds
    : (args.timeout_ms != null ? Number(args.timeout_ms) / 1000
      : (args.timeoutMs != null ? Number(args.timeoutMs) / 1000 : args.timeout));
  const secs = Number(t);
  if (Number.isFinite(secs) && secs > 0) card._timeoutMs = secs * 1000;
}

/* Edit-style tool calls (old text -> new text) render as a color diff. */
function editArgsPairs(args) {
  if (!args || typeof args !== 'object') return [];
  const lower = {};
  for (const k of Object.keys(args)) lower[k.toLowerCase()] = args[k];
  const out = [];
  if (Array.isArray(lower.edits)) {
    for (const e of lower.edits) {
      if (!e || typeof e !== 'object') continue;
      const o = e.oldText ?? e.old ?? e.oldStr ?? e.old_string;
      const n = e.newText ?? e.new ?? e.newStr ?? e.new_string;
      if (typeof o === 'string' || typeof n === 'string') out.push([o ?? '', n ?? '']);
    }
    return out;
  }
  let oldV = null, newV = null;
  for (const k of ['oldstr', 'oldtext', 'old_string', 'search', 'find']) {
    if (k in lower && typeof lower[k] === 'string') { oldV = lower[k]; break; }
  }
  for (const k of ['newstr', 'newtext', 'new_string', 'replace']) {
    if (k in lower && typeof lower[k] === 'string') { newV = lower[k]; break; }
  }
  if (oldV != null || newV != null) out.push([oldV ?? '', newV ?? '']);
  return out;
}


function lineDiff(a, b) {
  const A = (a || '').split('\n');
  const B = (b || '').split('\n');
  const N = A.length, M = B.length;
  if (N * M > 400000) {
    return [...A.map((s) => ({ t: 'del', s })), ...B.map((s) => ({ t: 'add', s }))];
  }
  const dp = Array.from({ length: N + 1 }, () => new Uint32Array(M + 1));
  for (let i = N - 1; i >= 0; i--) {
    for (let j = M - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < N && j < M) {
    if (A[i] === B[j]) { out.push({ t: 'same', s: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: 'del', s: A[i++] }); }
    else { out.push({ t: 'add', s: B[j++] }); }
  }
  while (i < N) out.push({ t: 'del', s: A[i++] });
  while (j < M) out.push({ t: 'add', s: B[j++] });
  return out;
}

/* Fill a tool card body: diff for edits, pretty JSON otherwise. Diff bodies
 * are shown automatically since the diff is the interesting part. */
function fillToolBody(card, name, args) {
  const filePath = args && typeof args === 'object'
    ? (args.path || args.file || args.file_path || args.filePath || '') : '';
  const lowerArgs = {};
  if (args && typeof args === 'object') for (const k of Object.keys(args)) lowerArgs[k.toLowerCase()] = args[k];
  const pairs = editArgsPairs(args);
  if (pairs.length) {
    card.body.innerHTML = '';
    // Marked so the result step knows a real diff is showing and leaves it
    // alone. A `.diffbox` alone cannot say that: the branch below makes one too,
    // for the arguments, and testing for the class meant a card still holding
    // its arguments never received its result (see the guards in
    // renderToolResult and tool_execution_end).
    card.body.dataset.kind = 'diff';
    const box = el('div', 'diffbox');
    let adds = 0, dels = 0;
    const header = (label, a, d) => {
      const h = el('div', 'diff-file');
      h.appendChild(el('span', null, label));
      const cnt = el('span', 'diff-count');
      const plus = el('span', 'c-add', `+${a}`);
      const minus = el('span', 'c-del', ` −${d}`);
      cnt.append(plus, minus);
      h.appendChild(cnt);
      box.appendChild(h);
    };
    pairs.forEach(([o, nn], idx) => {
      const lines = lineDiff(o, nn);
      const a = lines.filter((l) => l.t === 'add').length;
      const d = lines.filter((l) => l.t === 'del').length;
      adds += a; dels += d;
      header(idx === 0 ? filePath : '…', a, d);
      for (const { t, s } of lines) {
        box.appendChild(el('div', `dl ${t}`, s));
      }
    });
    if (pairs.length > 1) header('total', adds, dels);
    card.body.appendChild(box);
    card.body.classList.remove('hidden');
  } else if (args !== undefined) {
    card.body.innerHTML = '';
    card.body.dataset.kind = 'args';
    const box = el('div', 'diffbox');
    if (filePath) box.appendChild(el('div', 'diff-file', filePath));
    const pre = el('div', 'dl');
    pre.textContent = typeof lowerArgs.content === 'string'
      ? lowerArgs.content
      : JSON.stringify(args, null, 2);
    box.appendChild(pre);
    card.body.appendChild(box);
    card.body.classList.remove('hidden');
  }
}

function renderToolResult(msg) {
  const card = S.toolCards.get(msg.toolCallId);
  if (card) {
    // keep a rendered edit diff — the result line adds nothing to it
    if (card.body.dataset.kind !== 'diff') fillToolResultBody(card.body, msg);
    stopCardTimer(card, msg.isError ? 'error' : 'done');
    card.stateEl.className = `tool-state ${msg.isError ? 'error' : 'done'}`;
    if (!card.body.textContent && !card.body.firstChild) card.body.classList.add('hidden');
  } else {
    const { root, bubble } = makeMsgShell('tool', `${msg.toolName || 'tool'} result · ${timeStr(msg.timestamp)}`);
    const c = makeToolCard(msg.toolName || 'tool', { state: msg.isError ? 'error' : 'done' });
    c.stateEl.className = `tool-state ${msg.isError ? 'error' : 'done'}`;
    fillToolResultBody(c.body, msg);
    c.body.classList.remove('hidden');
    bubble.appendChild(c.card);
    root.querySelector('.who').remove();
    transcriptHost().appendChild(root);
    scrollBottom();
  }
}

/* A picture a tool returned - the agent reading an image puts the whole thing in
 * the session file as a base64 block. It used to be flattened to the text
 * "[image image/png]", which meant the only trace that a picture had been looked
 * at was a placeholder and the picture itself was unreachable from the chat.
 * It is kept here instead, behind a small eye, and clicking it opens it full
 * size (click off it, or Esc, to close - the same viewer a message image uses). */
const EYE_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';

/* Where a picture's bytes are.
 *
 * Two forms reach the chat. A message that is on screen right now comes from
 * pi over RPC, with the picture inline as base64. A message reloaded from the
 * session file comes from /api/session-messages, which *names* the pictures
 * instead of carrying them - the bytes are fetched from the bridge only for the
 * ones actually near the viewport (lazySrc puts the src on within 1200px and
 * takes it off again past 3000px), so opening a session no longer downloads
 * every picture that was ever pasted into it.
 *
 * Both are just a URL as far as the renderer is concerned: an <img src> does not
 * care whether it is a data: URL or an http one, which is the whole reason this
 * could be done without touching the message renderer. */
function imageDataUrl(block) {
  if (!block) return null;
  if (block.src) return String(block.src);          // named by the bridge
  if (!block.data) return null;                     // nothing to show
  if (/^data:/i.test(String(block.data))) return String(block.data);
  return `data:${block.mimeType || 'image/png'};base64,${block.data}`;
}

function imageChip(block) {
  const src = imageDataUrl(block);
  if (!src) return null;
  const kb = block.bytes || Math.max(1, Math.round(String(block.data || '').length * 0.75 / 1024));
  const btn = el('button', 'img-chip');
  btn.type = 'button';
  btn.title = `image · ${block.mimeType || 'unknown type'} · ${kb} KB — click to view it full size`;
  btn.setAttribute('aria-label', 'view this image full size');
  const thumb = el('img', 'img-chip-thumb');
  thumb.alt = '';
  lazySrc(thumb, src);
  const eye = el('span', 'img-chip-eye');
  eye.innerHTML = EYE_SVG;
  btn.append(thumb, eye);
  btn.onclick = (e) => { e.stopPropagation(); zoomImage(src); };
  return btn;
}

/* Fill a tool-result body from a content value: text as text, images as the
 * previews above, in the order they came. */
function fillToolResultBody(box, msg) {
  const c = msg && msg.content !== undefined ? msg.content : undefined;
  box.innerHTML = '';
  // The body holds a result now, not arguments and not a diff, so anything that
  // asks what is in here gets the right answer.
  if (box.dataset) box.dataset.kind = 'result';
  if (c == null) return;
  if (typeof c === 'string') { box.textContent = c; return; }
  if (!Array.isArray(c)) {
    // Unwrap the shapes a result actually arrives in before giving up and
    // printing JSON - see toolResultText. Issue #7: a bash result rendered as
    // `{ "content": [] }` instead of the command's output.
    if (c && typeof c === 'object') {
      if (Array.isArray(c.content)) { fillToolResultBody(box, { content: c.content }); return; }
      for (const k of ['output', 'text', 'stdout', 'result', 'message']) {
        if (typeof c[k] === 'string') { box.textContent = c[k]; return; }
      }
    }
    try { box.textContent = JSON.stringify(c, null, 2); } catch { box.textContent = String(c); }
    return;
  }
  let wrote = false;
  const sep = () => { if (wrote) box.appendChild(el('br')); wrote = true; };
  for (const b of c) {
    if (b && b.type === 'image') {
      const chip = imageChip(b);
      if (chip) { sep(); box.appendChild(chip); }
      continue;
    }
    if (b && b.type === 'text') { sep(); box.appendChild(document.createTextNode(b.text || '')); continue; }
    sep(); box.appendChild(document.createTextNode(JSON.stringify(b)));
  }
}

/* The text of a tool result, whatever shape it arrived in.
 *
 * A result is not always a string or an array of blocks. pi's bash tool answers
 * with an object ({output, exitCode, …}), and a wrapper may carry one under
 * `content`. Falling through to JSON.stringify put a literal
 *
 *     { "content": [] }
 *
 * in the card where the command's output should be - which is what "some bash
 * commands are only displayed as (image)" was (issue #7). The same unwrapping
 * applies to a partial result while a tool is still running. */
function toolResultText(msg) {
  const c = msg && msg.content;
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((b) => {
      if (!b || typeof b !== 'object') return String(b === undefined || b === null ? '' : b);
      if (b.type === 'text') return b.text;
      if (b.type === 'image') return `[image ${b.mimeType || ''}]`;
      return JSON.stringify(b);
    }).join('\n');
  }
  if (typeof c === 'object') {
    if (Array.isArray(c.content)) return toolResultText({ content: c.content });
    for (const k of ['output', 'text', 'stdout', 'result', 'message']) {
      if (typeof c[k] === 'string') return c[k];
    }
  }
  try { return JSON.stringify(c, null, 2); } catch { return String(c); }
}

/* Console/shell output renders as a plain "system" text box. */
function renderBashExecution(msg) {
  const { root, bubble } = makeMsgShell('system', `system · ${timeStr(msg.timestamp)}`);
  root.querySelector('.who').remove();
  bubble.textContent = `$ ${msg.command}\n${msg.output || '(no output)'}`;
  transcriptHost().appendChild(root);
  scrollBottom();
}

/* The compaction summary message (role: "compactionSummary") marks where the old
 * history was compressed into a summary.
 *
 * It is deliberately NOT rendered inline where it sits in the session order:
 * pi rebuilds the context as [compaction summary, kept entries…], so the marker
 * lands at the very TOP of the transcript — hundreds of messages above the
 * viewport. The user saw the live "compacting…" block appear, then vanish, with
 * nothing at the bottom to show for it.
 *
 * Instead the newest compaction is pinned to the END of the chat (right where
 * the live block was), so it is always visible and its summary expandable.
 * Older compactions still render inline so scrolling back stays accurate. */
function renderCompactionSummary(msg, extra) {
  transcriptHost().appendChild(buildCompactionSummary(msg, extra));
}

/* Build the "conversation compacted" marker WITHOUT inserting it, so callers can
 * put it exactly where the compaction happened. */
function buildCompactionSummary(msg, extra) {
  const live = !!(extra && extra.live);
  const root = el('div', 'msg compaction');
  const who = el('div', 'who');
  /* A compaction pi finished without a summary - it can answer a manual
   * /compact that way when there was nothing to cut. This used to delete the
   * live block and draw nothing, so the compaction appeared to vanish while the
   * context (correctly) stayed the same (issue #137). */
  if (msg && msg.noop) {
    const why = extra && extra.reason ? ` · ${extra.reason}` : '';
    who.textContent = `compaction finished${why} · pi reported no summary (the context was left as it was)`;
    root.appendChild(who);
    return root;
  }
  const before = msg.tokensBefore != null ? `${formatTok(msg.tokensBefore)} tok` : 'context';
  const after = extra && extra.estimatedTokensAfter != null
    ? ` → ${formatTok(extra.estimatedTokensAfter)} tok` : '';
  /* The reason was drawn only by renderCompactionBlock(), the live marker, so
   * even a rebuild in the same page session dropped "· manual" - not just a
   * reload. That is half of issue #47. */
  const reason = extra && extra.reason ? ` · ${extra.reason}` : '';
  who.textContent = `conversation compacted · ${before}${after}${reason}`;
  if (extra && extra.count > 1) {
    const badge = el('span', 'compaction-count', `${extra.count}✕`);
    badge.title = `${extra.count} compactions in this session`;
    who.appendChild(badge);
  }
  const detail = el('details', 'compaction-detail');
  detail.appendChild(el('summary', null, 'show compacted summary'));
  const body = el('div', 'md compaction-body');
  body.innerHTML = renderMarkdown(msg.summary || '');
  detail.appendChild(body);
  root.append(who, detail);
  return root;
}

/* Transcript images are inline data: URLs, and a long session with a few dozen
 * of them used to keep every one of them decoded for the life of the page -
 * hundreds of megabytes. The source waits in a data attribute and the element
 * only gets it while it is near the viewport; far away the bitmap is dropped
 * again, so scrolling back and forth reloads instead of hoarding. */
let mediaNear = null;
let mediaFar = null;
function lazySrc(node, src) {
  if (!node || !src) return node;
  node.dataset.src = src;
  node.decoding = 'async';
  node.setAttribute('loading', 'lazy');
  if (!mediaNear) {
    mediaNear = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const n = e.target;
        const want = n.dataset.src;
        if (!e.isIntersecting || !want) continue;
        if (n.getAttribute('src') !== want) n.setAttribute('src', want);
      }
    }, { rootMargin: '1200px 0px' });
    mediaFar = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const n = e.target;
        if (e.isIntersecting) continue;
        if (n.tagName === 'VIDEO') { try { n.pause(); } catch { } }
        n.removeAttribute('src');
        if (n.tagName === 'VIDEO') { try { n.load(); } catch { } }
      }
    }, { rootMargin: '3000px 0px' });
  }
  mediaNear.observe(node);
  mediaFar.observe(node);
  return node;
}

/* Live "compacting…" marker, shown the moment compaction_start arrives so the
 * user sees compaction happen in real time (with an elapsed timer). Replaced
 * by renderCompactionBlock() when compaction_end arrives. */
function renderCompactionLive(since) {
  const root = el('div', 'msg compaction compacting');
  const who = el('div', 'who');
  const spin = el('span', 'compaction-spin');
  who.appendChild(spin);
  who.appendChild(document.createTextNode(' compacting conversation… '));
  const timer = el('span', 'tool-timer');
  who.appendChild(timer);
  root.appendChild(who);
  transcriptHost().appendChild(root);
  // `since` is the bridge's start time when the block is restored after a reload,
  // so the elapsed time continues instead of starting from zero again.
  let start = Number(since) || Date.now();
  const tick = () => { timer.textContent = fmtElapsed(Date.now() - start); };
  const t = setInterval(tick, 500);
  tick();
  if (S.stickToBottom) scrollBottom();
  return { root, t, setSince: (s2) => { if (Number(s2)) { start = Number(s2); tick(); } } };
}
function removeCompactionLive() {
  if (S.compactionLive) {
    clearInterval(S.compactionLive.t);
    S.compactionLive.root.remove();
    S.compactionLive = null;
  }
}

/* Live compaction marker, rendered the moment compaction_end arrives so the
 * event is visible immediately (the session history only contains the marker
 * after the next full re-render, which happens on agent_settled). */
/* The marker for a compaction that ended without a summary (issue #137). */
function renderCompactionNoop(reason) {
  removeCompactionLive();
  for (const old of chat.querySelectorAll('.msg.compaction.pinned')) old.remove();
  const root = buildCompactionSummary({ noop: true }, { reason });
  root.classList.add('pinned');
  /* transcriptHost() can be a detached fragment (a rebuild in progress, or a
   * read-only view); this marker belongs on screen, so fall back to the chat
   * itself when the host is not connected. */
  const host = transcriptHost();
  (host && host.isConnected === false ? chat : host).appendChild(root);
  if (S.stickToBottom) scrollBottom();
}

function renderCompactionBlock(result, reason) {
  removeCompactionLive();
  for (const old of chat.querySelectorAll('.msg.compaction.pinned')) old.remove();
  const root = el('div', 'msg compaction pinned');
  const who = el('div', 'who');
  const before = result.tokensBefore != null ? `${formatTok(result.tokensBefore)} tok` : 'context';
  const after = result.estimatedTokensAfter != null ? ` → ${formatTok(result.estimatedTokensAfter)} tok` : '';
  who.textContent = `conversation compacted · ${before}${after}${reason ? ` · ${reason}` : ''}`;
  const detail = el('details', 'compaction-detail');
  detail.appendChild(el('summary', null, 'show compacted summary'));
  const body = el('div', 'md compaction-body');
  body.innerHTML = renderMarkdown(result.summary || '');
  detail.appendChild(body);
  root.append(who, detail);
  transcriptHost().appendChild(root);
  if (S.stickToBottom) scrollBottom();
}

// Read a session transcript from the bridge (messages + the compaction
// entries, which are not messages and so are absent from get_messages).
/* ── the compaction facts pi does not persist ─────────────────────────
 *
 * The session file's `compaction` entry, and the compactionSummary message pi
 * builds from it, carry the summary, an id, a timestamp and tokensBefore. The
 * post-compaction size and the reason are computed by pi at the moment it
 * compacts, emitted on the compaction_end event, and never written down - so a
 * marker read back from the file could only ever say "conversation compacted ·
 * 833.3K tok", while the same marker when it happened said "... · 833.3K tok →
 * 24.4K tok · manual". That is issue #47, and it is why the type appears to be
 * "lost" on reload rather than mis-set.
 *
 * Both facts are a number and a short word, so they are kept here. The key is a
 * hash of the summary: it is the one field that survives into the file and is
 * unique per compaction. The summary text itself is NOT stored - it is already
 * on disk, it runs to tens of kilobytes, and localStorage is small and shared
 * with the drafts. */
const COMPACT_FACT_MAX = 60;

function summaryHash(s) {
  const str = String(s || '');
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return `${h.toString(36)}.${str.length.toString(36)}`;
}

function compactionFactKey(sessionPath) {
  return `piwebui-compact:${instanceKey()}:${String(sessionPath || 'none').slice(-120)}`;
}

/* Newest first wins, so an old record for the same summary cannot overwrite a
 * newer one. */
function loadCompactionFacts(sessionPath) {
  const out = new Map();
  let rows;
  try { rows = JSON.parse(localStorage.getItem(compactionFactKey(sessionPath)) || '[]'); }
  catch { return out; }
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    if (!r || typeof r.h !== 'string') continue;
    if (!out.has(r.h)) out.set(r.h, r);
  }
  return out;
}

function saveCompactionFact(sessionPath, mark) {
  if (!mark || !mark.summary) return;
  const key = compactionFactKey(sessionPath);
  let rows;
  try { rows = JSON.parse(localStorage.getItem(key) || '[]'); } catch { rows = []; }
  if (!Array.isArray(rows)) rows = [];
  const h = summaryHash(mark.summary);
  rows = rows.filter((r) => r && r.h !== h);
  rows.unshift({
    h,
    a: mark.estimatedTokensAfter != null ? mark.estimatedTokensAfter : null,
    r: mark.reason || null,
    t: mark.at || Date.now(),
  });
  try { localStorage.setItem(key, JSON.stringify(rows.slice(0, COMPACT_FACT_MAX))); }
  catch { /* quota or private mode: a nicety, not state */ }
}

/* A compaction mark belongs to one session. */
function markSessionPath() { return (S.state && S.state.sessionFile) || ''; }
function markBelongsTo(k, sessionPath) {
  const a = (k && k.session) || '';
  const b = sessionPath || '';
  // An unsaved new session has no path on either side; keep them together
  // rather than losing the marker, and let the summary dedupe handle the rest.
  if (!a || !b) return !a && !b;
  return sameSessionPath(a, b, S.sessionsList || []);
}

/* pi writes timestamps as ISO strings; every comparison below is numeric, and
 * Number("2026-09-20T...") is NaN - which is why every compaction marker landed
 * at the top of the transcript instead of where it happened. */
function tsMs(v) {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(n) ? n : 0;
}

/* How many messages are built before the transcript render hands the page back
 * for a frame. Small enough that a click is answered quickly, large enough that
 * the yields themselves are not the cost. */
const RENDER_CHUNK = 40;

/* How many of the newest messages are rendered before anything else happens.
 *
 * Measured on the longest real session here - 5441 messages, 21 MB: reading the
 * file costs 214 ms and parsing the JSON another 242 ms, so neither is the
 * problem. Building the DOM is: 155 ms for the newest 200, and 62 seconds for
 * the remaining 5241 - about 12 ms a message, because a real message is markdown
 * plus a thinking block plus tool cards rather than a line of text. No amount of
 * chunking improves that arithmetic; the only thing that helps is not doing it
 * first.
 *
 * So the newest slice goes in immediately - the conversation is readable in about
 * a fifth of a second - and the rest is built above it in the background with
 * the view held, so nothing the reader is looking at moves. Nothing is dropped,
 * nothing is fetched twice, and the whole history is in place by the time anyone
 * scrolls to it. Under this count there is nothing to gain, so it renders in one
 * pass as before. */
const RENDER_NEWEST_FIRST = 250;

/* How many messages go into one batch of the *background* history fill.
 *
 * Smaller than RENDER_CHUNK on purpose. A batch is one uninterrupted block of
 * work, and a real message costs about 12 ms to build, so forty of them is half
 * a second of blocked main thread arriving repeatedly in the seconds after a
 * session opens - a stutter, every batch, while the person is trying to read.
 * Twelve is roughly 150 ms, which is short enough to stay under the threshold
 * where a frame is dropped, and it still fills the history in a couple of
 * seconds. The first pass, which is what the reader is waiting for, keeps the
 * larger chunk so the newest messages land quickly. */
const RENDER_BATCH = 12;

/* Give the browser one frame back. `scheduler.yield()` exists in Chromium and
 * hands the main thread over at a point of the *browser's* choosing (a real
 * priority split, so input wins), which is exactly what a long render wants;
 * everywhere else a frame via rAF is the next best thing. */
function yieldToPage() {
  if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') {
    return scheduler.yield();
  }
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function fetchSession(sessionPath, signal) {
  const r = await fetch(api(`/api/session-messages?path=${encodeURIComponent(sessionPath)}`), signal ? { signal } : undefined);
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || `failed (${r.status})`);
  return {
    messages: d.messages || [],
    compactions: (d.compactions || []).map((c) => ({
      ...c,
      at: tsMs(c.timestamp),
    })),
  };
}

async function refreshMessages(prefetched) {
  /* Which load owns the transcript. Every load takes a number; a load that is
   * superseded stops at its next yield instead of carrying on and writing over
   * the newer one.
   *
   * Without this, switching sessions quickly was not just slow, it was wrong:
   * the two renders interleaved at their yield points and fought over the same
   * chat element, so the session you asked for lost the race against the one you
   * were leaving, and you had to wait for the old one to finish before the new
   * one could start. */
  const gen = ++S.historyGen;
  const mine = () => gen === S.historyGen;
  // and the request itself is cancelled, so a session you switched away from
  // stops pulling bytes rather than finishing into the void
  if (S.historyAbort) { try { S.historyAbort.abort(); } catch { /* already gone */ } }
  const ac = new AbortController();
  S.historyAbort = ac;
  // A read-only view carries its own entry ids, and a session switch used to
  // block on the fork list before it fetched the transcript at all.
  if (!S.viewSession) ensureForkable();
  else resetForkQueue();
  // Subagent runs belong to the session you are looking at. The bridge answers
  // per session, so switching cannot show another one's jobs - and a reload gets
  // them back from disk instead of an empty panel.
  const subKey = subagentSessionKey();
  if (S.subagentsFor !== subKey) {
    S.subagents = new Map();
    S.subagentsFor = subKey;
    updateSubagentsBtn();
  }
  refreshSubagents(true).catch(() => {});
  let msgs;
  let fileMarks = [];
  // True while what we render is a window into the session rather than all of it
  // (the agent's post-compaction context view, or the newest N messages). A
  // compaction marker older than the oldest message on screen has no place to go
  // in that case - see the marker loop below.
  let partial = false;
  if (S.viewSession) {
    // Viewing another session while the agent runs in its own: read it
    // read-only from the file (the get_messages RPC only knows the agent's
    // own session).
    let d;
    try { d = await fetchSession(S.viewSession, ac.signal); }
    catch (err) { if (isCancelled(err) || !mine()) return; throw err; }
    if (!mine()) return;
    msgs = d.messages;
    fileMarks = d.compactions;  } else {
    /* The agent's own session. Two sources: the session file on disk, and pi's
     * `get_messages`.
     *
     * They used to be taken one after the other - `get_messages` first, and only
     * then the file - which made the slow one the first one. On a 21 MB session
     * pi took **nineteen seconds** to answer, because it has to serialise the
     * whole context before it says anything, and the file read sat behind it the
     * whole time.
     *
     * The file is the better source anyway: it is already on disk, and it is the
     * *more* complete of the two, since `get_messages` returns pi's current
     * context - after a compaction, the summary plus what came after it. So the
     * file is read and drawn from, and pi is not waited for. Asking for it is
     * also actively harmful: it is a many-megabyte reply, pi answers one request
     * at a time, so ask on every switch and they queue - switch three sessions
     * quickly and the fourth click's `get_state` waits behind three abandoned
     * 20 MB replies. That was the "still about a second between sessions" that
     * survived every render fix.
     *
     * pi's view therefore has one job left, and it is a small one: the messages
     * the transcript does not have. Which is either a send from seconds ago that
     * is not written yet (so: only while streaming), or a file that is behind
     * the context pi is holding in memory. In the second case - and in the
     * moment before the agent has a session at all, when the path it reports is
     * the sessions *directory* - there is nothing to draw from disk and pi is
     * the only source, and it may take twenty seconds to answer. So the screen is
     * never emptied and left blank for that long: it keeps whatever real session
     * it was showing, and pi's view is handed to the next load and drawn when it
     * lands. */
    const path = S.state.sessionFile;
    const rpcP = () => rpc({ type: 'get_messages' }).catch(() => null);

    if (adoptedMessages && mine()) {
      // pi's view, handed over by the load that waited for it
      msgs = adoptedMessages;
      adoptedMessages = null;
      partial = true;
    } else {
      const fileP = path
        ? (prefetched && prefetched.path === path ? prefetched.promise : fetchSession(path, ac.signal))
        : null;
      const rpcPromise = (fileP || S.isStreaming) ? rpcP() : null;

      let f = null;
      if (fileP) {
        try { f = await fileP; }
        catch (err) { if (isCancelled(err) || !mine()) return; f = null; }
      }
      if (!mine()) return;

      /* Anything pi holds that the transcript does not, appended rather than
       * waited for, and only if it turns out to be something. */
      const adopt = (d) => {
        if (!d) return;
        const rpcMsgs = asArray(d, 'messages');
        if (!rpcMsgs.length) return;
        const newest = msgs.reduce((acc, m) => Math.max(acc, Date.parse((m && m.timestamp) || '') || 0), 0);
        const pending = rpcMsgs.filter((m) => (Date.parse((m && m.timestamp) || '') || 0) > newest);
        if (!pending.length) return;
        // a newer load took over, a read-only view owns the screen, or a live
        // turn is already drawing the bottom of it
        if (gen !== S.historyGen || S.viewSession || S.isStreaming) return;
        const live = S.live && S.live.root.isConnected ? S.live.root : null;
        transcriptTarget = chat;
        for (const m of pending) drawMessage(m);
        transcriptTarget = null;
        if (live && live.parentNode === chat) chat.appendChild(live);
        markHollowMessages();
        if (!S.userScrolling) pinSoon();
      };

      if (f && f.messages.length) {
        fileMarks = f.compactions;
        msgs = f.messages;
        if (rpcPromise) rpcPromise.then(adopt);
      } else if (path) {
        /* Nothing on disk to draw.
         *
         * Two ways that happens, and they want opposite things.
         *
         * The agent has no session of its own: it reports the sessions
         * *directory*, and pi's view is a slow answer about a context the file
         * describes better. There is nothing to draw and no reason to empty the
         * screen, so it is left alone and pi's answer is handed to the next load.
         *
         * But a session that is simply *new* - the file is there and empty, or
         * has not been written yet - is a different thing entirely. That is the
         * one case where the old conversation has to go: "new session" that
         * leaves the previous transcript on screen looks like it did nothing.
         * So an empty session file is drawn as an empty transcript. */
        if (!isSessionFile(path)) {
          (rpcPromise || rpcP()).then((d) => {
            if (!d || gen !== S.historyGen || S.viewSession) return;
            if (!asArray(d, 'messages').length) return;
            adoptedMessages = asArray(d, 'messages');
            refreshMessages();
          });
          return;   // the screen keeps what it was showing
        }
        msgs = [];
        partial = true;
        rpcP().then(adopt);
      } else {
        // No path at all: pi's view is all there is, and there is nothing to
        // read ahead of it.
        const d = await rpcP();
        if (!mine()) return;
        msgs = asArray(d, 'messages');
        partial = true;
      }
    }
  }
  // Markers we watched happen in this page session, plus the ones already in
  // the file. Deduped by summary text so a watched compaction is not doubled.
  //
  // Only the marks belonging to THIS session, though. The list is the page's
  // memory of compactions it saw, and it was replayed into every session opened
  // afterwards - so session A's "conversation compacted" markers showed up in
  // session B until a reload. That is issue #40, and the reload fixing it is the
  // tell: a fresh page starts the list empty.
  const renderSession = S.viewSession || (S.state && S.state.sessionFile) || '';
  const facts = loadCompactionFacts(renderSession);
  const marks = S.compactionMarks.filter((k) => markBelongsTo(k, renderSession)).map((k) => ({ ...k }));
  const markSeen = new Set(marks.map((k) => k.summary));
  for (const k of fileMarks) if (k.summary && !markSeen.has(k.summary)) marks.push(k);
  // Put back the two facts pi never writes to the file (issue #47).
  for (const k of marks) {
    if (k.estimatedTokensAfter != null && k.reason) continue;
    const f = k.summary ? facts.get(summaryHash(k.summary)) : null;
    if (!f) continue;
    if (k.estimatedTokensAfter == null && f.a != null) k.estimatedTokensAfter = f.a;
    if (!k.reason && f.r) k.reason = f.r;
  }
  for (const m of msgs) {
    if (m && m.timestamp != null && typeof m.timestamp !== 'number') {
      const n = Date.parse(m.timestamp);
      if (Number.isFinite(n)) m.timestamp = n;
    }
  }
  // Keep the reading position (distance from the bottom) across the re-render.
  const distFromBottom = chatScroller().scrollHeight - chatScroller().scrollTop - chatScroller().clientHeight;
  /* Rows drawn from a send that the session file does not have yet.
   *
   * The rebuild below renders from the file, and a message that has just been
   * sent is not in it - pi writes it a moment later. Without this the row was
   * simply destroyed by the innerHTML reset and reappeared only on a reload
   * (issue #1). They are carried across and re-appended after the rebuild, and
   * dropped naturally once the file version is on screen. */
  const pendingLiveRows = [...chat.querySelectorAll('.msg.user[data-live="1"]')];
  releaseVideosIn(chat);
  chat.innerHTML = '';
  if (!S.viewSession) {
    // Only the agent's own session owns the live tool cards; a read-only
    // render of another session must not touch them. Normally this re-render
    // wipes the cards (they are rebuilt from the message content below), but
    // if a live message is in flight its cards must survive: they keep
    // receiving tool_execution_update/end events and are re-attached with
    // S.live below.
    const liveCards = S.live
      ? [...S.toolCards.entries()].filter(([, c]) => S.live.root.contains(c.card))
      : [];
    const liveIds = new Set(liveCards.map(([id]) => id));
    // Cards whose tool is still executing must keep their running state: they
    // are rebuilt from the message below, and this loop used to mark every card
    // that was not part of the live message as "done" - so a long command could
    // show done while it was still running.
    const keepCards = new Map();
    for (const [id, card] of S.toolCards) {
      if (liveIds.has(id)) continue;
      if (card._running) { keepCards.set(id, card); continue; }
      if (card._timer) stopCardTimer(card, 'done');
    }
    S.toolCards.clear();
    for (const [id, card] of liveCards) S.toolCards.set(id, card);
    for (const [id, card] of keepCards) S.toolCards.set(id, card);
    // Keep the live "compacting…" marker through a re-render: a compaction that
    // starts after the turn settled had its marker wiped here, so the status
    // only showed up once it was already over.
    if (S.compacting) {
      if (S.compactionLive) chat.appendChild(S.compactionLive.root);
    } else {
      removeCompactionLive();
    }
  }
  // session token totals summed from per-message usage
  let read = 0;
  let write = 0, prevTs = null;
  /* Every message in the session is rendered, always.
   *
   * This used to keep only the newest 400 and put a "load 812 older messages"
   * button above the rest. That was a bad trade in both directions: clicking the
   * button re-read the entire session file and re-parsed it, so reaching the top
   * of a long conversation cost one full parse per 400 messages, and a session
   * that needed three clicks was parsed three times over. One read, one parse,
   * the whole thing.
   *
   * The reason it was capped in the first place still holds, so it is handled
   * here instead of by throwing messages away: the rows are built in chunks with
   * a yield between them (RENDER_CHUNK), so a long transcript never blocks the
   * page and the composer, the scrollbar and the button keep answering while it
   * goes up. */
  S.historyPartial = !!partial;
  // Render one message the same way whichever end of the session it came from.
  const drawMessage = (m) => {
    const host = S.renderInto || chat;   // an older batch lives away from the chat
    const firstNew = host.children.length;
    if (m.role === 'user') renderUserMessage(m);
    else if (m.role === 'assistant') {
      noteHistoryTiming(m, prevTs);
      renderAssistantMessage(m);
    }
    else if (m.role === 'toolResult') renderToolResult(m);
    else if (m.role === 'bashExecution') renderBashExecution(m);
    else if (m.role === 'compactionSummary') {
      // In place, in order - a compaction marker belongs at the point in the
      // conversation where it happened, and it scrolls away with it. Pinning the
      // newest one to the bottom left a marker permanently on screen.
      // pi's version of this message carries the summary and tokensBefore and
      // nothing else, so the rest is looked up from what we kept (issue #47).
      const f = m.summary ? facts.get(summaryHash(m.summary)) : null;
      renderCompactionSummary(m, f ? { estimatedTokensAfter: f.a, reason: f.r } : undefined);
    }
    // Stamp whatever node(s) this message produced, so a compaction marker can
    // be anchored to a point in time instead of a shifting position.
    if (m.timestamp != null) {
      for (let k = firstNew; k < host.children.length; k++) host.children[k].dataset.ts = String(m.timestamp);
      prevTs = m.timestamp;
    }
    // Totals count every message, rendered or not.
    if (m.usage) {
      read += (m.usage.input || 0) + (m.usage.cacheRead || 0) + (m.usage.cacheWrite || 0);
      write += m.usage.output || 0;
    }
  };

  /* Newest first, then the history above it.
   *
   * Everything rendered in one pass means waiting for the whole conversation
   * before the newest message is readable - and on a long session that is a
   * minute of watching the transcript grow from the top down. So for anything
   * bigger than RENDER_NEWEST_FIRST, the newest slice is drawn into the chat
   * straight away, the view is put at the bottom (which is where a conversation
   * is read from), and the remaining history is built *above* it in the
   * background.
   *
   * "Above" is one insert per batch, not per message: the batch is built in a
   * detached element and moved in as a whole. That element is
   * `display: contents`, so its children lay out exactly as if they had been
   * appended to the chat directly - no wrapper, no CSS change, no second layout
   * pass. */
  const newestFirst = msgs.length > RENDER_NEWEST_FIRST;
  const anchor = newestFirst ? document.createComment('older history follows') : null;
  if (anchor) chat.appendChild(anchor);
  transcriptTarget = chat;   // this rebuild is for the transcript on screen
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (newestFirst && i < msgs.length - RENDER_NEWEST_FIRST) continue;   // drawn later, above
    drawMessage(m);
    // Hand the page back for one frame every RENDER_CHUNK messages. Without
    // this a long session is one uninterrupted block of work and the tab stops
    // answering to anything at all.
    if ((i + 1) % RENDER_CHUNK === 0 && i + 1 < msgs.length) {
      transcriptTarget = null;
      await yieldToPage();
      // A newer load took over while this one was yielding: stop touching the
      // chat. Everything below this point writes to the DOM.
      if (!mine()) return;
      if (!S.userScrolling) scrollBottom(true);
      transcriptTarget = chat;   // a live turn took over
    }
  }
  transcriptTarget = null;
  if (newestFirst) {
    // readable now; the rest is on its way in above
    if (!S.userScrolling) scrollBottom(true);
    await yieldToPage();
    if (!mine()) return;
    // The history, oldest last, in batches of RENDER_BATCH: one build off-screen
    // and one move into place per batch. (The first version of this counted the
    // messages it had built *cumulatively* and compared that to the batch size,
    // so only the very first batch was ever drawn - the transcript came out 173
    // messages long instead of 5441 and looked complete.)
    // Each batch is *older* than the one before it, so it has to go on top of it,
    // not at the anchor: inserting at the anchor stacks them newest-first at the
    // top of the history and leaves the oldest sitting next to the newest slice,
    // which is the whole transcript in blocks of forty, upside down.
    let historyTop = null;
    let from = msgs.length - RENDER_NEWEST_FIRST;
    while (from > 0) {
      const batch = document.createElement('div');
      batch.className = 'older-batch';
      S.renderInto = batch;
      transcriptTarget = batch;
      const start = Math.max(0, from - RENDER_BATCH);
      // ascending, and that matters: a tool result arrives *after* the assistant
      // message carrying its tool call, and a result rendered first finds no card
      // to update and builds one of its own - so the tool cards were doubled.
      // Batches are what get stacked in the other direction, not messages
      // within a batch.
      for (let k = start; k < from; k++) drawMessage(msgs[k]);
      from = start;
      S.renderInto = null;
      transcriptTarget = null;
      if (batch.firstChild) {
        chat.insertBefore(batch, historyTop || anchor);
        historyTop = batch;
      } else batch.remove();
      /* Keep the bottom pinned as the history arrives.
       *
       * The batches go in *above* what is already on screen, so the conversation
       * grows upward and the newest message - the one being read - should not
       * move. But a batch added above makes the content taller, and without
       * re-pinning the reader is left looking at the same part of the document
       * while it grows beneath them: the transcript appears to fill in from the
       * top downwards, which is the wrong way round for a conversation and reads
       * as the page still loading. A reader who has deliberately scrolled up is
       * left alone. */
      if (!S.userScrolling) scrollBottom(true);
      await yieldToPage();
      if (!mine()) return;
    }
    if (anchor.parentNode) anchor.remove();
    /* Pin once more now that the history is complete.
     *
     * The last batch goes in above and a frame later `restoreReading` runs and
     * can leave the view a little short of the bottom - twenty-odd pixels of
     * "still loading" sitting under the newest message after everything has
     * arrived. This is the point at which the session is, in fact, loaded. */
    if (!S.userScrolling) scrollBottom(true);
  }
  // Put the message that is being streamed right now back: it is not in the
  // session file yet, so the rebuild above could not have rendered it, and it
  // used to be dropped from the DOM - the streamed text disappeared until the
  // turn ended and it came back as a finished message.
  if (S.live && !S.live.root.isConnected && !S.viewSession && !S.liveDetached) {
    chat.appendChild(S.live.root);
    pinSoon();
  }
  markHollowMessages();
  // A rebuild (a reload, a compaction re-read, a resize) must not move the reader.
  // restoreReading() itself decides, from what was recorded, whether they were
  // following the bottom - a fresh page has no idea, so the guard cannot live here.
  requestAnimationFrame(() => restoreReading(5));
  // A compaction marker sits at the end of the transcript, so typing or a new
  // answer never pushes it out of sight.
  if (!S.viewSession) {
    // A compaction we watched happen is re-placed at the point it happened,
    // anchored by timestamp. Its entry is in the session file too once the turn
    // is saved, and that copy is rendered in order above, so skip those.
    const inFile = new Set(msgs.filter((m) => m.role === 'compactionSummary' && m.summary).map((m) => m.summary));
    const plain = [...chat.querySelectorAll('.msg:not(.compaction)')];
    for (const k of marks) {
      if (k.summary && inFile.has(k.summary)) continue;
      const at = tsMs(k.at);
      let target = null;
      let firstTs = 0;
      for (const n of plain) {
        const ts = Number(n.dataset.ts) || 0;
        if (!firstTs && ts) firstTs = ts;
        if (ts && at && ts <= at) target = n;
      }
      const node = buildCompactionSummary(k, { count: marks.length, reason: k.reason });
      // Before the first rendered message only if it really is older than it;
      // otherwise it belongs after the newest content, not at the top.
      if (target) target.after(node);
      else if (at && firstTs && at < firstTs) {
        // Older than everything on screen. That is only "at the top" when the
        // whole session is rendered: while a window is shown, the messages this
        // marker belongs between are not loaded, and pinning it to the first row
        // put every old compaction on the ceiling. Leave it out; loading the
        // older messages brings it back in its real place.
        if (!S.historyPartial) plain[0].before(node);
      } else chat.appendChild(node);
    }
    // A compaction still in flight keeps its "compacting…" indicator: the
    // re-render above wiped the DOM node it lived in.
    if (S.compacting && !S.compactionLive) S.compactionLive = renderCompactionLive();
  }
  // Totals are high-water marks: a compaction removes the older messages from
  // the session file, and recomputing the sum from what is left made the read /
  // write counters drop right after a compaction. They only reset when you
  // switch to another session.
  const base = S.sessionTotals && S.sessionTotals.path === S.state.sessionFile ? S.sessionTotals : null;
  const totals = {
    path: S.state.sessionFile,
    read: Math.max(read, (base && base.read) || 0),
    write: Math.max(write, (base && base.write) || 0),
  };
  S.sessionTotals = totals;
  S.totals = { read: totals.read, write: totals.write };
  updateTotals();
  // The last turn's total belongs on the last message: bring it back after a
  // re-render (a settle, a reload, a session re-read). A reload has no memory of
  // it, so it is read back from the per-session store first.
  if (!S.lastTurn && !S.viewSession) {
    const kept = loadSessionUi();
    if (kept && kept.lastTurn && kept.lastTurn.ms) S.lastTurn = kept.lastTurn;
  }
  if (S.lastTurn && S.lastTurn.ms) {
    const bubbles = chat.querySelectorAll('.msg.assistant .bubble');
    const b = bubbles.length ? bubbles[bubbles.length - 1] : null;
    if (b) {
      b.querySelectorAll('.turn-timer').forEach((n) => n.remove());
      b.appendChild(el('div', 'turn-timer', `turn took ${fmtElapsed(S.lastTurn.ms)}`));
    }
  }
  // Re-wire fork indexes for user messages in order.
  const userEls = [...chat.querySelectorAll('.msg.user')];
  userEls.forEach((e, i) => e.dataset.forkIdx = String(i));
  // Fork ids belong to rows by position on the active branch, not by matching
  // message text - two turns with the same wording got each other's id, so a
  // fork was taken from the wrong turn. Re-stamp after every render.
  stampForkIds().catch(() => {});
  // Back on the agent's own session mid-stream: re-attach the in-flight live
  // message (it was parked in S.liveDetached while viewing elsewhere). Only
  // when the agent is still in the session the live view belongs to.
  if (!S.viewSession && S.liveDetached && S.live && S.liveDetached.path === S.state.sessionFile) {
    chat.appendChild(S.liveDetached.frag);
  }
  S.liveDetached = null;
  /* Put back any message that was sent but is not in the file yet.
   *
   * Matched on the bubble's text against what the rebuild drew, so a row
   * disappears as soon as the file carries the same message - and until then it
   * stays on screen, through any number of rebuilds, rather than being lost the
   * moment something re-read the session (issue #1). */
  if (pendingLiveRows.length) {
    const shown = new Set([...chat.querySelectorAll('.msg.user .bubble')].map((b) => b.textContent));
    for (const row of pendingLiveRows) {
      /* A row sent to a different session is not ours to show (issue #52). An empty
       * tag matches an unsaved new chat, where neither side has a path yet. */
      const sentTo = row.dataset.liveSession || '';
      const belongs = (!sentTo || !renderSession)
        ? (!sentTo && !renderSession)
        : sameSessionPath(sentTo, renderSession, S.sessionsList || []);
      if (!belongs) continue;
      const bubble = row.querySelector('.bubble');
      if (shown.has(bubble ? bubble.textContent : '')) continue;   // the file has it now
      chat.appendChild(row);
    }
  }
  if (S.stickToBottom) scrollBottom(true);
  else chatScroller().scrollTop = chatScroller().scrollHeight - chatScroller().clientHeight - distFromBottom;
  S.historyRender++;
  updateJumpTop();
}

/* A load that was cancelled is not a failure.
 *
 * Superseding a load aborts its fetch, and that surfaces as an AbortError thrown
 * out of refreshMessages - into whoever was awaiting it (switchToSession, the
 * /reload routine, a compaction) and, when nobody was, onto the page as an
 * unhandled rejection with a scary-looking message. It means "you asked for
 * something else", which is not something to report, so it is swallowed here and
 * only real errors are re-thrown. */
function isCancelled(e) {
  return !!e && (e.name === 'AbortError' || /aborted/i.test(String(e.message || '')));
}

/* Is this something a transcript can actually be read from?
 *
 * pi reports the sessions *directory* as the current session when it has not
 * opened one yet, and asking the bridge for a "session file" at that path quietly
 * returns no messages at all - which is how a page loaded a second after the
 * agent started sat blank for twenty seconds, waiting on the slow fallback for
 * messages it could have had immediately. */
function isSessionFile(p) {
  return !!p && /\.jsonl$/i.test(String(p));
}

/* pi's view of the agent's session, handed from one load to the next.
 *
 * `get_messages` is a slow answer about a context the session file usually
 * describes better, so it is only asked for when the file has nothing - and
 * then it can take twenty seconds. Rather than empty the transcript and leave it
 * blank for that long, the load that asked hands the answer here and returns,
 * leaving the screen as it was; the load it starts picks this up and draws it. */
let adoptedMessages = null;

/* Full-size view of an image. The old version reused the drag-and-drop overlay,
 * which is pointer-events: none, so it could never be closed. */
function zoomImage(src) {
  const ov = el('div', 'img-zoom');
  const img = el('img');
  img.src = src;
  const close = el('button', 'img-zoom-close', '✕');
  close.title = 'Close (Esc)';
  close.onclick = (e) => { e.stopPropagation(); ov.remove(); };
  ov.append(img, close);
  ov.onclick = (e) => { if (e.target !== img) ov.remove(); };
  const onKey = (e) => {
    if (!document.body.contains(ov)) { document.removeEventListener('keydown', onKey); return; }
    if (e.key === 'Escape') { ov.remove(); document.removeEventListener('keydown', onKey); }
  };
  document.addEventListener('keydown', onKey);
  document.body.appendChild(ov);
}
