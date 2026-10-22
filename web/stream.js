/*
 * The event stream and the live turn: pi's RPC messages and events, the
 * streaming assistant message (deltas, paint, finalize), tool-card start, the
 * stream UI and the bars it drives, and the auto-continue decision.
 *
 * Split out of app.js (issue #54, phase 5). Loaded before app.js; the names
 * stay global, so nothing else changed. Behaviour is unchanged.
 */
'use strict';

function handleRpcMessage(msg) {
  if (msg.type === 'response') {
    const p = S.pending.get(msg.id);
    if (p) {
      S.pending.delete(msg.id);
      msg.success ? p.resolve(msg.data) : p.reject(new Error(msg.error || 'request failed'));
      if (!msg.success) {
        // A session whose recorded folder is gone gets its own dialog in
        // switchToSession; the raw pi error is not useful on top of that.
        const handledElsewhere = msg.command === 'switch_session' &&
          /working directory does not exist/i.test(msg.error || '');
        // An oversized-tree stack overflow here is self-inflicted (leafPath) and
        // harmless; putting it in the transcript looked like the agent broke.
        if (/Maximum call stack size exceeded/i.test(String(msg.error))) {
          console.warn(`handled silently (${msg.command}): ${msg.error}`);
        } else if (!handledElsewhere) toast(`Agent error (${msg.command}): ${msg.error}`, 'error');
      }
    }
    return;
  }
  if (msg.type === 'extension_ui_request') { handleExtensionUi(msg); return; }
  handleEvent(msg);
}

/* ───────────────────────── event stream ───────────────────────── */

function handleEvent(msg) {
  switch (msg.type) {
    case 'session_info_changed': {
      // pi emits this when a session is (re)named — keep the topbar in sync and
      // refresh the sidebar so a rename shows up there immediately.
      const name = (msg.name || '').trim();
      if (name) {
        const input = $('session-name');
        input.value = name;
        input.title = `${name} — click to rename`;
      }
      refreshSessions(true).catch(() => {});
      break;
    }
    case 'agent_start':
      S.ctxTurnPeak = 0;
      S.isStreaming = true;
      S.turnEnded = false;
      // a new turn: nothing about the last one is finalised yet, so turn_end will
      // have to check the session if the message never arrived
      S.turnFinalised = false;
      // The turn clock starts here (and covers thinking, tool calls and waiting).
      // It used to be set in a second `case 'agent_start'` label further down -
      // dead code, because the first matching case wins, so every turn was
      // measured as 0.0s.
      S.turnStartTs = Date.now();
      ensureTick();
      updateStreamUi();
      autoOpenShortsIfEnabled();
      break;
    case 'agent_end':
      /* This is the real agent_end arm.
       *
       * The work below used to sit inside `case 'agent_settled':` behind
       * `if (msg.type === 'agent_end')`, which can never be true - `msg.type` is
       * 'agent_settled' throughout that branch - so none of it ever ran: the turn
       * was never finalised here, extension commands registered mid-session were
       * never picked up, the fork list was never refreshed, and the sidebar was
       * not updated at the end of a turn (only by the 20 s idle poll, which skips
       * while streaming and while the tab is hidden). */
      S.turnEnded = true;
      finalizeLive();
      refreshCommands().catch(() => {});   // extensions may register commands late
      refreshStats().catch(() => {});
      ensureForkable();
      refreshSessions().catch(() => {});
      break;
    case 'agent_settled':
      if (msg.type === 'agent_settled') {
        clearRetryBar();   // a retry that ended in a settle leaves no bar behind
        // Only a turn that was actually running gets the chime - agent_settled
        // also arrives for bookkeeping with nothing to report.
        if (S.isStreaming) notifyTurnDone();
        S.isStreaming = false;
        autoCloseShortsIfOurs();
        // The turn total is stamped after the transcript has been finalised
        // below: stamping it here put the number into a bubble that finalizeLive()
        // then replaced, so the total never showed up.
        S.turnPendingStamp = true;
        // The turn is in the session file now: (re)attach fork ids to the rows.
        stampForkIds().catch(() => {});
        // A turn ending is when goal-x writes its files; keep the native bar in
        // step without waiting for the widget event (issue #55).
        refreshGoals().catch(() => {});
        // After a compaction the session history no longer matches the chat
        // DOM (older messages were summarized away and the "compacted" marker
        // is missing) — re-render from the session so the marker shows up.
        if (S.compactionHappened) {
          S.compactionHappened = false;
          refreshMessages().catch(() => {});
        }
        // Threshold/manual compactions stop the agent; keep the task going.
        // Threshold/manual compactions stop the agent; keep the task going. When
        // that happens the task clock keeps running - the task is not finished.
        /* A nudge is for a turn a compaction actually cut short. Anything the
         * agent produced after the compaction ended (S.outputSeq moved past
         * S.compactionSeq), a turn that had already finished, or a stop the user
         * asked for, means continuing would resurrect something that is over
         * (issue #63). */
        const autoContinues = S.compactionNeedsContinue
          && S.outputSeq === S.compactionSeq
          && S.userStopped !== true
          && msg.aborted !== true
          && SET.autoContinueAfterCompaction !== false;
        S.compactionNeedsContinue = false;
        if (autoContinues) maybeAutoContinue();
        if (!autoContinues) finishRunClock(lastAssistantTs());
      }
      updateStreamUi();
      // "Now that the transcript is settled…" used to follow here, wrapped in
      // `if (msg.type === 'agent_end')` - dead, because this arm only ever sees
      // 'agent_settled'. It lives in the real agent_end arm above.
      // Now that the transcript is settled, write the total time the turn took
      // (and put the compaction marker back at the end of the list).
      if (S.turnPendingStamp) {
        S.turnPendingStamp = false;
        setTimeout(stampTurnTimer, 0);
      }
      // A compaction that never reported back would otherwise leave the status
      // bar saying "compacting…" for the rest of the session.
      if (S.compacting) {
        S.compacting = false;
        removeCompactionLive();
        clearCompactLabelSoon();
      }
      // Send the next message the user queued during compaction, now that the
      // agent is idle (agent_settled). No-op when the queue is empty.
      flushCompactionQueue();
      break;
    case 'message_start':
      // A turn that begins with a tool call may not fire agent_start in some
      // versions; make sure the clock is running either way.
      if (!S.turnStartTs) S.turnStartTs = Date.now();
      /* Only the assistant's message has a live shell to stream into.
       *
       * pi emits message_start for the user's own message as well, and opening a
       * shell for it drew an empty assistant message that the matching
       * message_end then had to tear down - and that teardown was the rebuild
       * that lost the message you had just sent (issue #1). */
      if (!msg.message || msg.message.role === 'assistant') { startLive(); S.turnEnded = false; }
      break;
    case 'message_update':
      if (msg.usage && S.live) S.live.lastUsage = msg.usage;
      applyDelta(msg.assistantMessageEvent || {});
      break;
    case 'message_end':
      /* Only the assistant's message_end finishes anything.
       *
       * pi sends message_end for the user's own message too, and it arrives
       * first - when the turn has only just started, so `turnFinalised` is still
       * false and finalizeLive() fell through to refreshMessages(). That
       * rebuilds the whole transcript from the session file, and in a new chat
       * the file has not been written yet, so the optimistic bubble sendPrompt()
       * had just drawn was wiped and nothing put it back: the message you sent
       * disappeared until the page was reloaded, which read the file. Reproduced
       * every time (issue #1). */
      if (msg.message && msg.message.role && msg.message.role !== 'assistant') break;
      finalizeLive(msg.message);
      break;
    case 'turn_end':
      finalizeLive();
      break;
    case 'tool_execution_start':
      startToolCard(msg);
      if (String(msg.toolName || '') === 'bash') {
        noteTerminalStart({
          id: msg.toolCallId || `bash-${Date.now()}`,
          command: (msg.args && (msg.args.command || msg.args.cmd)) || '',
          session: S.state && S.state.sessionName,
        });
      }
      if (SUBAGENT_TOOLS.has(String(msg.toolName || ''))) {
        noteSubagent({
          id: msg.toolCallId || `fg-${Date.now()}`,
          label: (msg.args && (msg.args.agent || msg.args.label || msg.args.name)) || 'subagent',
          state: 'running',
          startedAt: Date.now(),
          background: false,
        });
      }
      break;
    case 'tool_execution_update': {
      const c = S.toolCards.get(msg.toolCallId);
      if (c && msg.partialResult !== undefined) {
        /* A partial with nothing in it must not blank the card (issue #37).
         *
         * This assigned unconditionally, so the first progress event whose
         * payload rendered to an empty string wiped the body and un-hid it -
         * leaving a running command as an empty strip for its whole life, which
         * for a bash call means minutes of looking at nothing. Several shapes pi
         * sends render to empty (`''`, `[]`, `{content: []}`, `{output: ''}`),
         * so this was not a rare edge.
         *
         * Ignoring the empty ones leaves what the card already had - the
         * arguments, which for bash is the command being run. That is the useful
         * thing to show while there is no output yet. */
        const text = toolResultText({ content: msg.partialResult });
        if (text.trim()) {
          c.body.textContent = text;
          if (c.body.dataset) c.body.dataset.kind = 'output';
          c.body.classList.remove('hidden');
        }
      }
      // Foreground subagents report progress inside the tool result details:
      // status, current tool, turns, tools. That is the live feed for them.
      if (SUBAGENT_TOOLS.has(String(msg.toolName || ''))) {
        const det = (msg.partialResult && msg.partialResult.details) || msg.details || {};
        for (const r of det.results || []) {
          const p2 = r.progress || {};
          noteSubagent({
            id: r.runId || r.id || msg.toolCallId || 'fg',
            label: r.label || r.agent || p2.agent || 'subagent',
            state: p2.status || 'running',
            currentTool: p2.currentTool || null,
            turnCount: p2.turnCount || 0,
            toolCount: p2.toolCount || 0,
            startedAt: (S.subagents.get(String(r.runId || r.id || msg.toolCallId || 'fg')) || {}).startedAt || Date.now(),
            background: false,
          });
        }
      }
      break;
    }
    case 'tool_execution_end': {
      if (String(msg.toolName || '') === 'bash') noteTerminalEnd(msg.toolCallId);
      if (SUBAGENT_TOOLS.has(String(msg.toolName || ''))) {
        const det = (msg.result && msg.result.details) || msg.details || {};
        const kids = (det.results || []).map((r) => ({
          id: r.runId || r.id || msg.toolCallId,
          label: r.label || r.agent || 'subagent',
          state: r.status === 'ok' || r.ok === true ? 'done' : (r.status || (r.error ? 'failed' : 'done')),
          output: typeof r.content === 'string' ? r.content : (r.output || ''),
          background: false,
        })).filter((r) => r.id);
        if (kids.length) for (const k of kids) noteSubagent(k);
        else noteSubagent({ id: msg.toolCallId || 'fg', state: msg.isError ? 'failed' : 'done' });
      }
      const c = S.toolCards.get(msg.toolCallId);
      if (c) {
        // the same renderer as history, so a picture the agent reads *during* a
        // turn gets its preview too, not just the ones reloaded from a file
        if (msg.result !== undefined && c.body.dataset.kind !== 'diff') fillToolResultBody(c.body, { content: msg.result });
        stopCardTimer(c, msg.isError ? 'error' : 'done');
        c.stateEl.className = `tool-state ${msg.isError ? 'error' : 'done'}`;
      }
      break;
    }
    case 'bash_execution_update': {
      const c = S.bashCards.get(msg.id);
      if (c) { c.body.textContent += msg.delta || ''; c.body.classList.remove('hidden'); scrollBottom(); }
      break;
    }
    case 'queue_update':
      S.queue = { steering: msg.steering || [], followUp: msg.followUp || [] };
      renderQueue();
      break;
    case 'extension_error':
      toast(`Extension error: ${msg.error}`, 'error');
      break;
    case 'auto_retry_start':
      /* A retry is a state, not a notice: the toast it used to be was gone in
       * seconds while pi kept retrying (issue #83). The bar stays until the
       * retry ends, and Cancel sends abort_retry - pi's own command for it. */
      renderRetryBar(msg);
      break;
    case 'auto_retry_end':
      clearRetryBar();
      if (msg && msg.success === false) toast('Retry did not succeed: ' + (msg.errorMessage || 'unknown error'), 'error');
      break;
    case 'compaction_start':
      S.compacting = true;
      toast('Compacting session…');
      // The pre-compaction token count is now stale; show a dash until the
      // next LLM response reports a real post-compaction context size.
      setCtxRing(null);
      // ...and drop the high-water marks with it, or the peak from before the
      // compaction outlives the context it measured and clamps the next number
      // back up to itself (issue #48).
      resetCtxHighWater();
      if ($('ctx-label')) $('ctx-label').textContent = ctxLabel('compacting…', '–');
      // Live "compacting…" block with an elapsed timer, removed on compaction_end.
      if (!S.compactionLive) S.compactionLive = renderCompactionLive();
      break;
    case 'compaction_end': {
      // Declared out here: these used to be consts inside the `else if (msg.result)`
      // block and read after it, so this handler threw a ReferenceError before it
      // could refresh - leaving "compacting…" in the status bar forever and the
      // compacted-to size nowhere.
      let before = null;
      let after = null;
      S.compacting = false;
      if (msg.aborted) {
        removeCompactionLive();
        clearCompactLabelSoon();
        toast('Compaction cancelled', 'warning');
      } else if (msg.errorMessage) {
        removeCompactionLive();
        clearCompactLabelSoon();
        toast(msg.errorMessage, 'error');
      } else if (msg.result) {
        before = msg.result.tokensBefore;
        after = msg.result.estimatedTokensAfter;
        toast(`Compacted: ${before != null ? formatTok(before) : '?'} → ${after != null ? formatTok(after) : '?'} tokens`);
        S.lastCompaction = msg.result;
        // Remember it so refreshMessages() can put the marker back where it
        // happened instead of re-appending it to the bottom every turn.
        if (!S.compactionMarks.some((k) => k.summary === msg.result.summary)) {
          const mark = { ...msg.result, reason: msg.reason || null, at: Date.now(), session: markSessionPath() };
          S.compactionMarks.push(mark);
          // estimatedTokensAfter and reason exist only on this event. pi computes
          // them at the moment it compacts and writes neither to the session file,
          // so they are kept aside for the reload (issue #47).
          saveCompactionFact(mark.session, mark);
        }
        renderCompactionBlock(msg.result, msg.reason);
        S.compactionHappened = true;
        // willRetry=true (overflow) → pi retries the prompt itself. A manual
        // /compact never auto-continues (the user asked for it, task was done).
        // Only auto-compactions (threshold/overflow without retry) need a nudge.
        /* Only worth continuing if the compaction actually made room.
         *
         * A compaction that barely shrank the context overflows again on the very
         * next request, so continuing straight into it is how the loop feeds
         * itself - and pi's own guard against that (one compact-and-retry per
         * turn) is reset by every new user message, which is exactly what the
         * continue below sends. */
        const useful = before == null || after == null || after < before * 0.9;
        /* Only a compaction that cut a *running* turn short is worth a nudge.
         *
         * pi runs a threshold/overflow compaction without retry either after a
         * completed response ("compact without retrying the completed
         * response") or mid-turn before the next assistant response, after which
         * pi continues the turn itself. In both the agent either finished what
         * it was asked or is still working; the old unconditional "continue the
         * current task" is what told a finished agent to carry on (issue #63).
         * The remaining decision is made at agent_settled: if any assistant
         * output arrived after the compaction, the turn resumed, so nothing is
         * needed either. */
        S.compactionSeq = S.outputSeq;
        S.compactionNeedsContinue = !msg.willRetry && msg.reason !== 'manual'
          && S.turnEnded !== true && useful;
      } else {
        /* pi ended the compaction without a result. Keep a marker instead of
         * deleting the live block: vanishing made it look like the compaction
         * never happened, while the context (correctly) stayed the same
         * (issue #137). The mark lets a rebuild put it back. */
        const why = msg.reason || 'manual';
        if (!S.compactionMarks.some((k) => k.noop && k.reason === why && k.session === markSessionPath())) {
          S.compactionMarks.push({ noop: true, reason: why, at: Date.now(), session: markSessionPath() });
        }
        renderCompactionNoop(why);
        toast('Compaction finished - pi reported no summary; the context was left as it was');
      }
      // Context is unknown to pi right after compaction (it reports tokens:null
      // until the next response), which left the ring showing a dash until the
      // session was switched. Show the estimated size the compaction itself
      // reported, then keep asking until pi has a real number.
      if (after != null) showCompactionEstimate(after);
      clearCompactLabelSoon();
      refreshStats().catch(() => {});
      scheduleStatsRetry();
      flushCompactionQueue();
      break;
    }
    default:
      break;
  }
}

function startLive() {
  const { root, tools, bubble } = makeMsgShell('assistant streaming', '…');
  addCopyButton(tools, () => S.live ? S.live.text : '');
  addSpeakButton(tools, () => stripMarkdown(S.live ? S.live.text : ''));
  // Copy/speak only make sense once the message is final — keep the buttons
  // hidden while streaming. finalizeLive() replaces this shell with the
  // rendered message, where they are visible again.
  tools.classList.add('pending');
  const md = el('div', 'md');
  bubble.appendChild(md);
  const statsEl = el('span', 'agent-stats');
  root.querySelector('.who').insertBefore(statsEl, tools);
  // The "..." dots bob up and down in a wave (each dot delayed) while the
  // agent generates/reads.
  const dots = el('span', 'streaming-dots');
  for (let i = 0; i < 3; i++) dots.appendChild(el('span', 'dot', '.'));
  root.querySelector('.who-text').replaceChildren(document.createTextNode(' · '), dots);
  const stopTurnTimer = startTurnTimer();
  // While another session is on screen the live message stays out of it: new
  // turns used to be appended to whatever transcript was open, so the agent
  // appeared to write into the session you were reading.
  transcriptHost().appendChild(root);
  S.live = { root, md, text: '', thinking: '', thinkingEl: null, caret: el('span', 'streaming-caret'),
    stopTurnTimer,
    toolByIndex: new Map(),   // contentIndex -> tool card while a call is streaming
    toolArgChars: new Map(),  // contentIndex -> argument characters streamed so far
    // incremental paint state: text already committed to stableEl, and the two
    // elements the message is split across (see paintLive)
    paintedUpTo: 0, stableEl: null, tailEl: null,
             startTs: Date.now(), lastUsage: null, statsEl };
  scrollBottom();
}

function applyDelta(ev) {
  if (!S.live) startLive();
  const L = S.live;
  if (ev.type === 'text_delta') { S.outputSeq++; if (!L.firstDeltaTs) L.firstDeltaTs = Date.now(); L.text += ev.delta || ''; }
  else if (ev.type === 'text_start') { /* noop */ }
  else if (ev.type === 'text_end') { /* noop */ }
  else if (ev.type === 'thinking_delta') { S.outputSeq++; if (!L.firstDeltaTs) L.firstDeltaTs = Date.now(); L.thinking += ev.delta || ''; }
  else if (ev.type === 'toolcall_start') {
    // pi streams tool calls keyed by contentIndex and only sends {type,
    // contentIndex} at the start — the id, name and arguments arrive with the
    // deltas/end (assistantMessageEvent.partial is stripped by the RPC layer).
    // Track the card by contentIndex so it can appear and grow while the model
    // is still writing the call, instead of popping in fully formed.
    if (L.toolByIndex.has(ev.contentIndex)) {
      // duplicate start for the same block — keep the card we already have
    } else {
      const card = makeToolCard(ev.toolName || 'tool', { toolCallId: ev.id || `stream-${ev.contentIndex}` });
      card.toolName = ev.toolName || '';
      card._rawArgs = '';
      card._contentIndex = ev.contentIndex;
      L.root.querySelector('.bubble').appendChild(card.card);
      startCardTimer(card);
      L.toolByIndex.set(ev.contentIndex, card);
      if (ev.id) S.toolCards.set(ev.id, card);
      pinSoon();   // a new card above the caret — keep following
    }
  }
  else if (ev.type === 'toolcall_delta') {
    // Stream the arguments as they are written (a `write` shows the file, a
    // `bash` shows the command) — this is the "tool call being generated".
    const c = (ev.contentIndex != null && L.toolByIndex.get(ev.contentIndex)) || (ev.id && S.toolCards.get(ev.id));
    if (c) {
      S.outputSeq++;
      c._rawArgs = (c._rawArgs || '') + (ev.delta || ev.argumentsDelta || ev.partial || ev.partialArgs || '');
      const named = toolNameFromJson(c._rawArgs);
      if (named && named !== c.toolName) {
        c.toolName = named;
        c.card.querySelector('.tool-name').textContent = named;
      }
      c.body.classList.remove('hidden');
      c.body.textContent = liveToolPreview(c.toolName, c._rawArgs);
      // Follow the newest line while the model writes, unless the reader has
      // scrolled up (then it stays where they put it).
      if (c._bodySticky !== false) c.body.scrollTop = c.body.scrollHeight;
      if (!L.toolArgChars) L.toolArgChars = new Map();
      L.toolArgChars.set(ev.contentIndex, c._rawArgs.length);
      scrollBottom();
    }
  }
  else if (ev.type === 'toolcall_end' && ev.toolCall) {
    S.outputSeq++;
    const byIndex = ev.contentIndex != null ? L.toolByIndex.get(ev.contentIndex) : null;
    const existing = byIndex || S.toolCards.get(ev.toolCall.id);
    if (existing) {
      // Reuse the card created by toolcall_start (it already has the live
      // preview and the elapsed timer) instead of appending a duplicate.
      existing.toolName = ev.toolCall.name;
      existing.card.querySelector('.tool-name').textContent = ev.toolCall.name;
      noteToolTimeout(existing, ev.toolCall.arguments);
      if (existing._running && existing._timeoutMs) restartCardTimer(existing);
      fillToolBody(existing, ev.toolCall.name, ev.toolCall.arguments);
      // Re-key to the real tool-call id so the tool_execution_* events (which
      // are keyed by it) find this card.
      if (existing._contentIndex != null) L.toolByIndex.delete(existing._contentIndex);
      existing.toolCallId = ev.toolCall.id;
      S.toolCards.set(ev.toolCall.id, existing);
    } else {
      const card = makeToolCard(ev.toolCall.name, { toolCallId: ev.toolCall.id });
      fillToolBody(card, ev.toolCall.name, ev.toolCall.arguments);
      L.root.querySelector('.bubble').appendChild(card.card);
      S.toolCards.set(ev.toolCall.id, card);
    }
  }
  renderLive();
}

/* The streamed argument JSON sometimes carries the tool name (providers differ);
 * pull it out early so the card can be labelled while it is still being written. */
function toolNameFromJson(raw) {
  const m = /"(?:name|tool|toolName|tool_name)"\s*:\s*"([A-Za-z0-9_.-]{1,40})"/.exec(raw || '');
  return m ? m[1] : null;
}

/* Live preview while a tool call's arguments stream in: for write-like tools
 * show the decoded file content so far, otherwise the raw partial arguments. */
/* Stream a tool call's arguments into its card while the model is still
 * writing them (a `write` shows the file, a `bash` the command).
 *
 * This used to keep only the last 4000 (write/edit) or 2000 (everything else)
 * characters, so the beginning of a long file silently disappeared as it was
 * written - the preview looked like it was deleting content (issue #67). It now
 * keeps a far larger window and says exactly how much it had to leave out; the
 * finished card always shows the whole argument (fillToolBody), so nothing is
 * lost for good.
 *
 * The window is still a cap rather than the whole stream: a runaway write can
 * be a megabyte, and this text goes through textContent on every delta. 60k
 * characters is many screens of the 260px body; past that the marker appears. */
const LIVE_TOOL_PREVIEW_MAX = 60000;

/* One pass instead of a chain of replaces: the chain turned a literal `\n`
 * (a backslash and an n in the file) into a newline, because the "\\n" rule
 * ran before the "\\\\" rule. \uXXXX comes out as the character it names. */
function unescapeJsonText(s) {
  return String(s || '').replace(/\\(u[0-9a-fA-F]{4}|.)/g, (m, g) => {
    if (g[0] === 'u') return String.fromCharCode(parseInt(g.slice(1), 16));
    switch (g) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case 'b': return '\b';
      case 'f': return '\f';
      case '"': return '"';
      case '\\': return '\\';
      case '/': return '/';
      default: return g;
    }
  });
}

function liveToolPreview(name, raw) {
  const text = String(raw || '');
  // Prefer the field a person is watching for this tool over the JSON around
  // it: the file being written, or the command being run.
  const field = /write|edit/i.test(name || '') ? 'content'
    : /bash/i.test(name || '') ? 'command'
      : null;
  let body = text;
  if (field) {
    const m = text.match(new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)`));
    if (m) body = unescapeJsonText(m[1]);
  }
  if (body.length <= LIVE_TOOL_PREVIEW_MAX) return body;
  const shown = body.slice(-LIVE_TOOL_PREVIEW_MAX);
  const hidden = body.length - shown.length;
  return `… ${hidden.toLocaleString()} earlier character${hidden === 1 ? '' : 's'} hidden while streaming (the finished call shows everything)\n${shown}`;
}

/* How often the streaming view is repainted while tokens arrive.
 *
 * This used to be "every animation frame". Each repaint re-parses the whole
 * message so far (renderMarkdown walks every line and every inline span), throws
 * the result away into innerHTML, and then reads scrollHeight to pin the bottom
 * - a forced synchronous layout at the end of every pass. Providers deliver
 * deltas far faster than 60/s, so for most of a turn that meant parsing the same
 * text two or three times to produce a frame nobody could tell apart from the
 * one before it, while the tab was pinned at 100% CPU.
 *
 * 12/s is above the rate at which a change of words is legible, and it turns a
 * long turn into a fraction of the work. The last pass is never skipped (see
 * the settle path), so the finished message is always rendered exactly. */
const LIVE_PAINT_MS = 80;

/* The live paint is deferred while a dialog is open (see paintLive): when the
 * last dialog closes, draw what accumulated behind it. `close` does not bubble,
 * so this listens in the capture phase. */
document.addEventListener('close', () => {
  if (S.live && !document.querySelector('dialog[open]')) renderLive(true);
}, true);

let liveRaf = null;
let liveTimer = null;
let liveLastPaint = 0;
function renderLive(force) {
  if (!S.live) return;
  // A paint is already on its way. A forced one (the turn settling) takes the
  // frame that is already queued rather than adding a second one - that frame
  // is about to run and will paint everything there is.
  if (liveRaf) return;
  if (force) {
    if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; }
    liveRaf = requestAnimationFrame(() => { liveRaf = null; paintLive(); });
    return;
  }
  if (liveTimer) return;                  // the tail of this window is already armed
  const since = Date.now() - liveLastPaint;
  if (since >= LIVE_PAINT_MS) {
    liveRaf = requestAnimationFrame(() => { liveRaf = null; paintLive(); });
    return;
  }
  // Too soon. Wake up exactly when the window opens instead of dropping the
  // update - otherwise the last tokens before the provider pauses would not show
  // up until something unrelated triggered a repaint.
  liveTimer = setTimeout(() => {
    liveTimer = null;
    if (!S.live) return;
    liveRaf = requestAnimationFrame(() => { liveRaf = null; paintLive(); });
  }, Math.max(1, LIVE_PAINT_MS - since));
}

/* The last place in the streamed text that is safe to split markdown at.
 *
 * A blank line, as long as it is not inside a fenced code block: a fence that
 * opens before a split and closes after it would be parsed as two different
 * things on either side, so the two halves would not add up to the whole. */
function markdownSplitPoint(text) {
  let cut = -1;
  let fences = 0;
  for (let i = 0; i < text.length - 1; i++) {
    if (text.charCodeAt(i) === 96 && text.charCodeAt(i + 1) === 96 && text.charCodeAt(i + 2) === 96) {
      fences++;
      i += 2;
      continue;
    }
    if (text.charCodeAt(i) === 10 && text.charCodeAt(i + 1) === 10 && fences % 2 === 0) cut = i + 2;
  }
  return cut;
}

function paintLive() {
  if (!S.live) return;
  if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; }
  /* A dialog is the one thing on screen that must paint *now* (issue #117:
   * the click registered but the dialog appeared late). Re-rendering the
   * streaming message behind the modal competes with it on the main thread, so
   * the live paint waits; the text keeps accumulating and the close handler
   * below forces the deferred paint the moment the dialog goes away. */
  if (document.querySelector('dialog[open]')) return;
  liveLastPaint = Date.now();
  const L = S.live;
  if (L.thinking && !L.thinkingEl) {
    L.thinkingEl = makeThinking('');
    L.md.before(L.thinkingEl);
    pinSoon();   // the block is inserted above the caret — follow it
  }
  if (L.thinkingEl) L.thinkingEl.querySelector('.th-body').textContent = L.thinking;
  /* Only the part that changed is re-rendered.
   *
   * `L.md.innerHTML = renderMarkdown(L.text)` re-parsed and re-laid-out the whole
   * message on every paint. Measured in the browser at 12 paints a second, on a
   * message of the size a long answer reaches:
   *
   *     7 280 chars   1.72 ms per paint    2% of a core
   *    29 120 chars   6.54 ms per paint    8%
   *   116 480 chars  27.52 ms per paint   33%, and over a 16.7 ms frame
   *
   * (that is ~24x the markdown parse itself, which is why making the parser
   * faster was never the answer - the cost is the DOM replacement.)
   *
   * So the message is kept in two pieces: everything up to the last safe block
   * boundary, which is *appended* to as the boundary advances and never re-parsed,
   * and the unfinished tail, which is the only thing re-rendered each paint. The
   * work per paint is proportional to what has arrived since the last boundary
   * rather than to the length of the message. */
  if (L.text) {
    const cut = markdownSplitPoint(L.text);
    if (cut > L.paintedUpTo) {
      if (!L.stableEl) {
        L.stableEl = el('div', 'md-stable');
        L.md.appendChild(L.stableEl);
      }
      // beforeend: parses the new segment only, leaves what is already there alone
      L.stableEl.insertAdjacentHTML('beforeend', renderMarkdown(L.text.slice(L.paintedUpTo, cut)));
      L.paintedUpTo = cut;
    }
    if (!L.tailEl) {
      L.tailEl = el('div', 'md-tail');
      L.md.appendChild(L.tailEl);
    }
    L.tailEl.innerHTML = renderMarkdown(L.text.slice(L.paintedUpTo));
  } else {
    L.md.replaceChildren(el('span', 'streaming-caret'));
  }
  // live token counter, updated as tokens stream in. Until the provider
  // reports usage, estimate written tokens from streamed characters.
  const sec = (Date.now() - L.startTs) / 1000;
  const prefill = L.firstDeltaTs ? (L.firstDeltaTs - L.startTs) / 1000 : null;
  let stats;
  if (L.lastUsage) {
    stats = usageStats(L.lastUsage, sec, prefill);
  } else {
    stats = estStatsText(estWriteTokens(L), sec);
  }
  if (stats) L.statsEl.textContent = ` (${stats})`;
  // Live context ring: pi's last authoritative count + the in-flight message,
  // estimated the same way pi itself does (chars/4).
  liveCtxRing(liveExtraTokens());
  scrollBottom();
}

/* Estimate the tokens the in-flight message will add, using the ratio the
 * session has actually shown (pi itself falls back to chars/4). */
function liveExtraTokens() {
  const L = S.live;
  if (!L) return 0;
  let chars = L.text.length + L.thinking.length;
  if (L.toolArgChars) for (const n of L.toolArgChars.values()) chars += n;
  const ratio = S.tokPerChar || 0.25;
  return Math.round(chars * ratio);
}

function finalizeLive(finalMsg) {
  if (S.live) {
    S.outputSeq++;   // one assistant message finished producing something
    const L = S.live;
    // The streaming view is painted at a fixed rate, so the last few tokens may
    // still be sitting in the buffer. One last synchronous pass before the live
    // node is torn down: whatever the reader was owed, they have seen.
    if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; }
    paintLive();
    if (L.stopTurnTimer) L.stopTurnTimer();
    const elapsedSec = (Date.now() - L.startTs) / 1000;
    const prefillSec = L.firstDeltaTs ? (L.firstDeltaTs - L.startTs) / 1000 : null;
    /* What sits after the live row. A message the user sent while this one was
     * streaming (a steer) is drawn below it, and the session file keeps that
     * order: the assistant message, then the steer, then whatever the assistant
     * says next. Re-rendering the final message at the end of the chat put the
     * steer *above* the reply it steered - the order only came right after a
     * reload (issue #149). The final message goes back where its live shell was. */
    const after = L.root.nextSibling;
    S.live.root.remove();
    S.live = null;
    if (S.liveDetached) {
      // Viewing another session: the final message is already in the session
      // file, so the read-only render will show it. Drop the live state; the
      // agent session's totals refresh when the user switches back.
    } else if (finalMsg && finalMsg.role === 'assistant') {
      const usage = finalMsg.usage || L.lastUsage;
      if (usage) {
        S.totals.read += (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
        S.totals.write += usage.output || 0;
        noteTokenRatio(usage, messageChars(finalMsg));
      }
      const timed = usage && !finalMsg.usage ? { ...finalMsg, usage } : finalMsg;
      // No usage from the provider (some endpoints never send it): keep the
      // estimated counter that was on screen while streaming, so the token rate
      // does not simply vanish when the turn ends.
      const timing = { elapsedSec, prefillSec };
      if (!usage) timing.est = estWriteTokens(L);
      rememberTiming(timed, timing);
      renderAssistantMessage(timed, timing);
      if (after && after.isConnected && after.parentNode === chat) {
        const drawn = chat.lastElementChild;
        if (drawn && drawn !== after) chat.insertBefore(drawn, after);
      }
      updateTotals();
      // this turn is now in the DOM and correct. turn_end arrives afterwards with
      // no message, and must not go and re-read the session to prove it.
      S.turnFinalised = true;
      if (S.autoTts) {
        const text = (finalMsg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
        if (text.trim()) speak(stripMarkdown(text));
      }
    } else {
      // No final message this time. Only worth re-reading the whole transcript
      // if the turn was never actually finalised - otherwise this ran at the end
      // of every single turn and re-read the entire session file, rebuilding the
      // whole conversation from the oldest message upwards, which on a long
      // session is the "it jumps up then slowly comes down" you were seeing.
      if (!S.turnFinalised) refreshMessages().catch(() => {});
    }
  }
  // Do NOT clear S.isStreaming here. finalizeLive() runs on every message_end
  // and turn_end -- including the user's own message -- and clearing it there
  // hid the Stop button the instant the first message ended, and made
  // sendPrompt() omit streamingBehavior, so pi rejected mid-turn sends instead
  // of steering them. The turn is only over at agent_settled (or agent_exit /
  // socket close).
  updateStreamUi();
}

function startToolCard(msg) {
  const existing = msg.toolCallId && S.toolCards.get(msg.toolCallId);
  if (existing) {
    // already created by a streaming toolcall_start — just fill in the name
    if (msg.toolName && !existing.toolName) {
      existing.toolName = msg.toolName;
      existing.card.querySelector('.tool-name').textContent = msg.toolName;
    }
    // It may have been rendered as "done" by the message finalise above; the
    // execution is starting right now, so put the running label back.
    setCardRunning(existing);
    noteToolTimeout(existing, msg.args);
    // With a timeout known, count down from the moment the command starts.
    if (existing._timeoutMs) restartCardTimer(existing);
    else startCardTimer(existing);
    return existing;
  }
  const card = makeToolCard(msg.toolName || msg.name || 'tool', { toolCallId: msg.toolCallId });
  card.toolName = msg.toolName || msg.name || '';
  card._rawArgs = '';
  noteToolTimeout(card, msg.args);
  fillToolBody(card, card.toolName, msg.args);
  startCardTimer(card);
  const parent = S.live ? S.live.root.querySelector('.bubble') : chat;
  parent.appendChild(card.card);
  S.toolCards.set(msg.toolCallId, card);
  scrollBottom();
  pinSoon();
  return card;
}

/* The ring right after a compaction: pi has no number yet, so show the estimate
 * the compaction reported instead of a dash. */
function showCompactionEstimate(tokens) {
  /* The window has to come from S.ctxWindow, and that is half of this fix.
   *
   * Every way into a compaction calls setCtxRing(null) first - compaction_start,
   * and the /compact command handler - which nulls S.ctxStats. So the old lookup
   * (S.ctxStats.contextWindow) was always null by the time this ran, the function
   * returned without drawing anything, and the size the compaction itself
   * reported was never shown. What stayed on screen was the ring's empty "–" or
   * the number from before the compaction, which is issue #48: "right after
   * compaction the counter stays the same".
   *
   * The other half is the high-water marks, which have to go with the context they
   * describe (see resetCtxHighWater). Without that, the peak from before the
   * compaction is read as a floor and this estimate is pushed back up to it.
   *
   * The previous second fallback, S.state.contextWindow, is not set anywhere in
   * this file and never was, so it is gone rather than left looking like a net. */
  const win = (S.ctxStats && S.ctxStats.contextWindow) || S.ctxWindow || null;
  if (!win) return;
  resetCtxHighWater();
  setCtxRing({ tokens, contextWindow: win, percent: Math.max(0, Math.min(100, (tokens / win) * 100)) });
}

/* pi only knows the new context size once it has answered something again, so
 * check a few times instead of leaving the estimate on screen forever. */
function scheduleStatsRetry() {
  [3000, 8000, 20000].forEach((ms) => setTimeout(() => { refreshStats().catch(() => {}); }, ms));
}

/* Put a real number back in the status bar in case the "compacting…" state is
 * left over (a compaction that was cancelled, failed, or whose end event never
 * arrived). Anything the ring has already shown is left alone. */
function clearCompactLabelSoon() {
  setTimeout(() => {
    const label = $('ctx-label');
    if (!label || label.textContent !== ctxLabel('compacting…', '–')) return;
    label.textContent = ctxLabel('–', '–');
    refreshStats().catch(() => {});
  }, 250);
}

function updateStreamUi() {
  // The Stop button appears next to the (always visible) Send button while the
  // agent is generating, so you can stop generation or steer/queue a message.
  $('btn-stop').classList.toggle('hidden', !S.isStreaming);
  // While a run is going, the widget and status lines above the composer keep
  // their space even when an extension clears them for a moment. Setting and
  // clearing a status (an MCP server connecting, the sub-agent widget updating)
  // resized the dock, which moved the composer and the stats row with it - the
  // stack is anchored now, and the space is given back when the run ends.
  document.body.classList.toggle('run-active', !!S.isStreaming);
  setConn(S.isStreaming ? 'busy' : 'on');
  // Reset the ring's high-water mark on every streaming transition so the
  // final authoritative total can settle (even if the estimate overshot), and
  // remember where this turn started so the live number can be anchored to it.
  if (S.isStreaming && S.ctxBaseTokens == null) {
    S.ctxBaseTokens = (S.ctxStats && S.ctxStats.tokens) || 0;
  }
  S.ctxDisplayTokens = null;
  if (S.isStreaming) startCtxPoll(); else { stopCtxPoll(); S.ctxBaseTokens = null; }
  renderQueue();
  updateLiveDot();
  updateViewBanner();
}

// Banner shown while the user is viewing a session other than the agent's own.
function updateViewBanner() {
  const b = $('view-banner');
  if (!b) return;
  if (!S.viewSession) {
    b.classList.add('hidden');
    b.textContent = '';
    return;
  }
  // Reading a subagent's own session: name it, say it is read-only, and keep the
  // way back to the conversation it belongs to right here.
  if (S.viewSubagent) {
    const r = S.viewSubagent;
    const parent = S.state.sessionFile;
    const p = (S.sessionsList || []).find((x) => sameSessionPath(x.path, parent, S.sessionsList || []));
    const pname = (p && p.name) || (parent ? parent.split(/[\\/]/).pop().replace(/\.jsonl$/, '') : 'the main session');
    b.classList.remove('hidden');
    b.textContent = `Subagent “${r.label || 'subagent'}” — its own session, read-only`
      + (isLiveRun(r) ? ' (still running, this follows along)' : '')
      + `. Back to “${pname}”. `;
    const back = el('button', 'btn small', 'back to the conversation');
    back.onclick = () => backFromSubagent();
    b.appendChild(back);
    return;
  }
  const base = S.viewSession.split(/[\\/]/).pop();
  const s = (S.sessionsList || []).find((x) => sameSessionPath(x.path, S.viewSession, S.sessionsList || []));
  const name = (s && s.name) || base.replace(/\.jsonl$/, '');
  b.classList.remove('hidden');
  b.textContent = S.isStreaming
    ? `Viewing “${name}” — the agent is still running in its own session (green dot in the list) and keeps going in the background. `
    : `Viewing “${name}” — read-only. The agent is in its own session; click it in the list to switch back. `;
  const btn = el('button', 'btn small', 'switch back');
  btn.onclick = () => switchToSession(S.state.sessionFile);
  b.appendChild(btn);
}

/* Keep the green "live" dot in the session list in sync with streaming state
 * immediately. A full refreshSessions only runs on session changes or while
 * idle, so without this the dot would appear late or not at all mid-stream
 * (it used to only show up after a page reload). */
function updateLiveDot() {
  const list = $('session-list');
  if (!list) return;
  /* The green dot marks the session the AGENT is running in, which is not always
   * the row that is highlighted: switching away during a turn highlights the row
   * you are reading and leaves the agent in its own session.
   *
   * This used to walk only the `.active` rows, toggle the dot on those, and never
   * take it off a row that was no longer active. So each switch during a run left
   * another green dot behind, and the session actually doing the work lost its
   * own - issue #41, "both sessions indicate that it is active, stacks with each
   * session change if the agent makes a new turn". Walking every row and deciding
   * from S.state.sessionFile fixes both halves, and matches what a full
   * renderSessions() rebuild already computes (`selfLive = isCurrent &&
   * S.isStreaming`) - which is why refreshing used to clear them. */
  const runsIn = (S.state && S.state.sessionFile) || '';
  const sessions = S.sessionsList || [];
  for (const item of list.querySelectorAll('.session-item')) {
    const live = !!S.isStreaming && !!runsIn && sameSessionPath(item.dataset.path || '', runsIn, sessions);
    item.classList.toggle('live', live);
    const nameRow = item.querySelector('.s-name');
    if (!nameRow) continue;
    const dot = nameRow.querySelector('.live-dot');
    if (live && !dot) nameRow.prepend(el('span', 'live-dot', ''));
    else if (!live && dot) dot.remove();
  }
}

/* Live context ring: while the agent is streaming, poll session stats so the
 * ring and the [used/max]ctx label track context growth in real time instead
 * of only updating when switching sessions. */
let ctxPollTimer = null;
function startCtxPoll() {
  if (ctxPollTimer) return;
  refreshStats().catch(() => {});
  ctxPollTimer = setInterval(() => {
    if (S.isStreaming) refreshStats().catch(() => {}); else stopCtxPoll();
  }, 1000);
}
function stopCtxPoll() {
  if (ctxPollTimer) { clearInterval(ctxPollTimer); ctxPollTimer = null; }
}

/* While compaction is running the agent rejects new prompts, so messages the
 * user typed are held here and sent (one at a time) once the agent is idle
 * again. flushCompactionQueue() is called on compaction_end and agent_end. */
function flushCompactionQueue() {
  if (!S.compactionQueue.length) return;
  if (S.isStreaming || S.compacting) return; // wait until the agent is idle
  const next = S.compactionQueue.shift();
  startRunClock();   // a queued message from the user is a new task
  sendPrompt(next.text, next.images, undefined, true);
  // The next agent_end/agent_settled will flush the rest of the queue.
}

/* pi only auto-retries after an *overflow* compaction. After a *threshold*
 * (or manual) compaction it stops and waits for the next user message — even
 * when the task is clearly not done. Nudge it along automatically (once per
 * cooldown) so long tasks keep going. */
/* How many compactions in a row may pull the task along by themselves before this
 * gives up and says so. Reset by the next message the user sends. */
const AUTO_CONTINUE_MAX = 3;

function maybeAutoContinue() {
  if (SET.autoContinueAfterCompaction === false) return;
  if (S.isStreaming || S.compacting) return;
  const now = Date.now();
  if (now - S.lastAutoContinueAt < 120000) return; // don't chain-continue forever
  /* "Don't chain-continue forever" is what the line above says, and it is not
   * what it does: the cooldown bounds how OFTEN the loop turns, not whether it
   * ends. If the context is still over the window after a compaction, the next
   * request overflows, pi compacts again, this continues again - every two
   * minutes, indefinitely. That is issue #38's "infinite cycle of context
   * overflow ... it compacts every time even after compaction". pi caps its own
   * recovery (one compact-and-retry per turn, _overflowRecoveryAttempted) and
   * re-arms it on every new user message; a machine that keeps sending user
   * messages keeps re-arming it. So the count is capped here as well, where the
   * messages actually come from. */
  if (S.autoContinueStreak >= AUTO_CONTINUE_MAX) {
    toast(`Compaction has been needed ${S.autoContinueStreak} times in a row — stopping the automatic continuation. Send a message to carry on.`, 'warning');
    return;
  }
  S.lastAutoContinueAt = now;
  S.autoContinueStreak++;
  toast('Compaction done — continuing the task…', 'info');
  // Deliberately not startRunClock(): this continues the task the user already
  // started, so its clock keeps running (compaction time included).
  sendPrompt('Context was just compacted into a summary. Continue the current task from where it left off — use the compaction summary and the recent messages, and keep working until the task is complete.');
}

/* ── the bars above the composer ─────────────────────────────────────────
 * Extensions set and clear their status/widget while the agent works, and a
 * widget is often cleared for a single frame between updates. Hiding and showing
 * the bar with it changed the height of the composer dock, which resized the
 * transcript area - so the whole conversation moved up and down with every
 * update. That is what "the UI jumps while the agent is running" was.
 *
 * A bar that goes empty now keeps its place for a moment (the next update is
 * usually on its way), and CSS gives it a stable height while it is up. */
const BAR_HIDE_MS = 3000;
const barHideTimers = new Map();

function setBarContent(bar, text) {
  if (!bar) return;
  const key = bar.id || 'bar';
  const pending = barHideTimers.get(key);
  if (pending) { clearTimeout(pending); barHideTimers.delete(key); }
  if (String(text || '').trim()) {
    bar.textContent = text;
    // Remember that this bar has been used at some point during this run. Only
    // such a bar keeps its height while it is momentarily empty (see the
    // data-had-content rules in the stylesheet) - a bar that never appeared
    // would otherwise reserve a block of blank dock for the whole run, which is
    // issue #6.
    bar.dataset.hadContent = '1';
    bar.classList.remove('hidden');
    return;
  }
  barHideTimers.set(key, setTimeout(() => {
    barHideTimers.delete(key);
    // Only if nothing arrived in the meantime (an extension can re-set it).
    if (!String(bar.textContent || '').trim()) {
      bar.textContent = '';
      bar.classList.add('hidden');
    }
  }, BAR_HIDE_MS));
}
