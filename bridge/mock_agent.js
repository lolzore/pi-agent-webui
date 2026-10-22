/*
 * Minimal mock of `pi --mode rpc` for developing/testing the WebUI without a
 * real agent install. Implements enough of the RPC protocol to exercise every
 * part of the UI: streaming prompts, images, bash, commands, sessions,
 * fork/edit, and extension UI dialogs. Point the bridge at it with:
 *   PI_COMMAND="node mock_agent.js" node server.js
 *
 * Set PI_MOCK_SESSION_FILE to a real .jsonl to have the mock claim to be in that
 * session. Without it the mock reports a path that does not exist, so the page
 * shows an empty transcript - which is fine for testing the UI's own behaviour and
 * useless for anything that depends on the transcript having height and scrolling,
 * such as the sticky-to-bottom path.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const state = {
  model: { id: 'mock-large', name: 'Mock Large', provider: 'mock', reasoning: true, input: ['text', 'image'], contextWindow: 200000 },
  thinkingLevel: 'medium',
  isStreaming: false,
  sessionFile: process.env.PI_MOCK_SESSION_FILE || '/root/.pi/agent/sessions/mock-session.jsonl',
  sessionId: 'mock-session',
  sessionName: 'Mock session',
  messageCount: 0,
  compacting: false,
};
const messages = [];
/* pi keeps steering and follow-up messages in its own queues and abort() does not
 * clear them - only clear_queue does, which pi 1.0.0 exposes over RPC. Mirrored here
 * so the WebUI behaviour around abort can be tested (issue #53). */
const queues = { steering: [], followUp: [] };
function emitQueue() { send({ type: 'queue_update', steering: [...queues.steering], followUp: [...queues.followUp] }); }
const commands = [
  { name: 'echo', description: 'Echo the rest of the message back', source: 'extension' },
  { name: 'dialog', description: 'Demo: exercise extension UI dialogs', source: 'extension' },
  { name: 'review', description: 'Review the current changes', source: 'prompt', location: 'project' },
  { name: 'skill:commit', description: 'Write a git commit message', source: 'skill' },
];

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
function respond(id, command, success, data, error) {
  send({ type: 'response', id, command, success, ...(data !== undefined ? { data } : {}), ...(error ? { error } : {}) });
}
function userText(m) {
  return typeof m.content === 'string' ? m.content : m.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
}
function imgCount(m) {
  return Array.isArray(m.content) ? m.content.filter((b) => b.type === 'image').length : 0;
}

async function streamAssistant(text, usage) {
  state.isStreaming = true;
  send({ type: 'agent_start' });
  send({ type: 'turn_start' });
  send({ type: 'message_start' });
  const chunks = text.match(/[\s\S]{1,24}/g) || [];
  for (const c of chunks) {
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: c, contentIndex: 0 } });
    await new Promise((r) => setTimeout(r, 45));
  }
  send({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0 } });
  const msg = {
    role: 'assistant',
    content: [{ type: 'text', text }],
    provider: 'mock', model: state.model.id,
    usage: usage || { input: 120, output: 60, cacheRead: 0, cacheWrite: 0, totalTokens: 180, cost: { total: 0.0012 } },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
  send({ type: 'message_end', message: msg });
  send({ type: 'turn_end' });
  messages.push(msg);
  state.isStreaming = false;
  send({ type: 'agent_end', messages: [msg] });
  send({ type: 'agent_settled' });
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buffer += d;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line) {
      try {
        handle(JSON.parse(line));
      } catch (e) {
        // Ignore malformed JSON lines
      }
    }
  }
});

/* Optional, for tests: what this mock was started with, and every RPC it is
 * asked for - so a test can assert that the bridge resumes by *starting in* a
 * session instead of switching to it after the fact. */
function noteRpc(type) {
  const f = process.env.PI_MOCK_RPC_LOG;
  if (!f) return;
  try { fs.appendFileSync(f, String(type) + '\n'); } catch { /* best effort */ }
}
if (process.env.PI_MOCK_ARGV_FILE) {
  try { fs.writeFileSync(process.env.PI_MOCK_ARGV_FILE, process.argv.slice(2).join(' ') + '\n'); } catch { /* best effort */ }
}

function handle(msg) {
  noteRpc(msg && msg.type);
  const id = msg.id;
  switch (msg.type) {
    case 'get_state':
      respond(id, msg.type, true, {
        ...state,
        pendingMessageCount: queues.steering.length + queues.followUp.length,
        queuedSteering: [...queues.steering],
        queuedFollowUp: [...queues.followUp],
      });
      return;
    case 'get_messages':
      respond(id, msg.type, true, { messages: [...messages] });
      return;
    case 'get_commands':
      respond(id, msg.type, true, { commands });
      return;
    case 'get_available_models':
      respond(id, msg.type, true, {
        models: [
          state.model,
          { id: 'mock-small', name: 'Mock Small', provider: 'mock', reasoning: false, input: ['text'], contextWindow: 32000 },
        ],
      });
      return;
    case 'set_model':
      state.model = { ...state.model, id: msg.modelId, provider: msg.provider };
      respond(id, msg.type, true);
      return;
    case 'get_available_thinking_levels':
      respond(id, msg.type, true, { levels: ['off', 'minimal', 'low', 'medium', 'high'] });
      return;
    case 'set_thinking_level':
      state.thinkingLevel = msg.level;
      respond(id, msg.type, true);
      return;
    case 'get_session_stats':
      respond(id, msg.type, true, {
        messageCount: messages.length,
        tokens: { input: 120, output: 60, total: 180 },
        cost: { total: 0.0012 },
        contextUsage: { tokens: 180, contextWindow: 200000, percent: 0.09 },
      });
      return;
    case 'get_fork_messages':
      respond(id, msg.type, true, {
        messages: messages
          .filter((m) => m.role === 'user')
          .map((m, i) => ({ entryId: `u${i}`, text: userText(m) })),
      });
      return;
    case 'get_tree': {
      /* The shape the page walks: nodes of { entry, children }, with the leaf id
       * it should walk back from. User entries carry the same ids
       * get_fork_messages reports, so a fork lands on the message it names. */
      let ui = 0;
      const nodes = messages.map((m, i) => ({
        entry: { id: m.role === 'user' ? `u${ui++}` : `a${i}`, message: m },
        children: [],
      }));
      for (let i = 0; i < nodes.length - 1; i++) nodes[i].children.push(nodes[i + 1]);
      respond(id, msg.type, true, {
        tree: nodes.length ? [nodes[0]] : [],
        leafId: nodes.length ? nodes[nodes.length - 1].entry.id : null,
      });
      return;
    }
    case 'fork': {
      const idx = parseInt(String(msg.entryId).replace('u', ''), 10);
      const all = messages.filter((m) => m.role === 'user');
      if (!Number.isNaN(idx) && all[idx]) {
        const cut = messages.indexOf(all[idx]);
        messages.length = cut; // drop the forked message and everything after
        respond(id, msg.type, true, { text: userText(all[idx]) });
      } else {
        respond(id, msg.type, false, undefined, 'unknown entryId');
      }
      return;
    }
    case 'new_session':
      messages.length = 0;
      state.sessionName = 'New session';
      state.sessionFile = '/root/.pi/agent/sessions/mock-' + Date.now() + '.jsonl';
      send({ type: 'agent_start' });
      send({ type: 'agent_end', messages: [] });
      send({ type: 'agent_settled' });
      respond(id, msg.type, true);
      return;
    case 'switch_session':
      messages.length = 0;
      state.sessionFile = msg.sessionPath;
      state.sessionName = msg.sessionPath.split('/').pop();
      state.messageCount = 0;
      send({ type: 'agent_start' });
      send({ type: 'agent_end', messages: [] });
      send({ type: 'agent_settled' });
      respond(id, msg.type, true);
      return;
    case 'set_session_name':
      state.sessionName = msg.name;
      respond(id, msg.type, true);
      return;
    case 'set_steering_mode':
    case 'set_follow_up_mode':
    case 'set_auto_retry':
    case 'abort':
    case 'abort_bash':
    case 'abort_retry':
      state.isStreaming = false;
      respond(id, msg.type, true);
      send({ type: 'agent_end', messages: [] });
      send({ type: 'agent_settled' });
      return;
    case 'set_auto_compaction': {
      // pi persists this one; the mock does too, so the WebUI's read-back and
      // the bridge's /api/pi-config reflect the change (issue #56).
      try {
        const dir = process.env.PI_CODING_AGENT_DIR || process.env.PI_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
        const file = path.join(dir, 'settings.json');
        fs.mkdirSync(dir, { recursive: true });
        let s = {};
        try { s = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { s = {}; }
        s.compaction = Object.assign({}, s.compaction, { enabled: !!msg.enabled });
        fs.writeFileSync(file, JSON.stringify(s, null, 2));
      } catch { /* best effort */ }
      respond(id, msg.type, true);
      return;
    }
    case 'bash': {
      const out = `running: ${msg.command}\nmock output line 1\nmock output line 2`;
      messages.push({
        role: 'bashExecution', command: msg.command, output: out,
        exitCode: 0, cancelled: false, truncated: false, timestamp: Date.now(),
      });
      send({ type: 'agent_start' });
      send({ type: 'bash_execution_update', id, delta: `running: ${msg.command}\n` });
      send({ type: 'bash_execution_update', id, delta: 'mock output line 1\nmock output line 2\n' });
      send({ type: 'agent_end', messages: [] });
      send({ type: 'agent_settled' });
      respond(id, msg.type, true, { output: out, exitCode: 0 });
      return;
    }
    case 'compact': {
      state.compacting = true;
      send({ type: 'compaction_start', reason: 'manual' });
      // Simulate a multi-second compaction (the real one makes an LLM call).
      setTimeout(() => {
        state.compacting = false;
        send({
          type: 'compaction_end', reason: 'manual',
          result: { tokensBefore: 50000, estimatedTokensAfter: 8000 },
          aborted: false, willRetry: false,
        });
        respond(id, msg.type, true, { tokensBefore: 50000, estimatedTokensAfter: 8000 });
      }, 3000);
      return;
    }
    case 'clear_queue': {
      const out = { steering: [...queues.steering], followUp: [...queues.followUp] };
      queues.steering = [];
      queues.followUp = [];
      emitQueue();
      respond(id, msg.type, true, out);
      return;
    }
    case 'prompt': {
      if (state.compacting) {
        respond(id, msg.type, false, undefined, 'Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.');
        return;
      }
      const text = msg.message || '';
      /* goal-x commands, emulated enough for the WebUI (issue #81): pause and
       * resume change the focused goal's status in the workspace, which is what
       * the extension would do; focus and refresh are acknowledged. The UI
       * sends these as ordinary prompts. */
      if (/^\/goal-(pause|resume|focus|refresh)\b/.test(text)) {
        const cmd = text.split(/\s+/)[0];
        if (cmd === '/goal-pause' || cmd === '/goal-resume') {
          try {
            const dir = path.join(process.env.WORKSPACE_DIR || process.cwd(), '.pi', 'goals');
            const name = fs.readdirSync(dir).find((n) => /^active_goal_.*\.md$/.test(n));
            if (name) {
              const full = path.join(dir, name);
              const body = fs.readFileSync(full, 'utf8');
              const next = cmd === '/goal-pause' ? 'paused' : 'active';
              // The record's own status is the first "status" in the file; task
              // statuses live inside taskList, further down.
              fs.writeFileSync(full, body.replace(/"status"\s*:\s*"[^"]*"/, `"status": "${next}"`));
            }
          } catch { /* no goal in this workspace */ }
        }
        respond(id, msg.type, true);
        streamAssistant(`(${cmd} handled by the mock)`);
        send({ type: 'agent_settled' });
        return;
      }
      if (state.isStreaming && (msg.streamingBehavior === 'steer' || msg.streamingBehavior === 'followUp')) {
        (msg.streamingBehavior === 'steer' ? queues.steering : queues.followUp).push(text);
        emitQueue();
        respond(id, msg.type, true);
        return;
      }
      const userMsg = { role: 'user', content: text, timestamp: Date.now(), attachments: [] };
      if (Array.isArray(msg.images) && msg.images.length) {
        userMsg.content = [
          ...msg.images.map((im) => ({ type: 'image', data: im.data, mimeType: im.mimeType })),
          { type: 'text', text },
        ];
        userMsg.attachments = msg.images.map((im, i) => ({
          id: `a${i}`, type: 'image', fileName: `image-${i + 1}`, mimeType: im.mimeType, size: (im.data || '').length,
        }));
      }
      /* Whatever is still queued is delivered by this turn - that is what makes the
       * difference observable: a message left in the queue comes back later as a
       * message nobody typed. */
      for (const queued of [...queues.steering, ...queues.followUp]) {
        const qm = { role: 'user', content: queued, timestamp: Date.now(), attachments: [] };
        messages.push(qm);
        send({ type: 'message_start', message: qm });
        send({ type: 'message_end', message: qm });
      }
      if (queues.steering.length || queues.followUp.length) {
        queues.steering = [];
        queues.followUp = [];
        emitQueue();
      }
      messages.push(userMsg);
      state.messageCount = messages.length;

      if (text.startsWith('/dialog')) {
        respond(id, msg.type, true);
        (async () => {
          send({ type: 'extension_ui_request', id: 'dlg1', method: 'confirm', title: 'Confirm action', message: 'Run the mock destructive step?' });
        })();
        return;
      }
      if (text.startsWith('/echo')) {
        respond(id, msg.type, true);
        streamAssistant('Echo: ' + text.slice(5).trim());
        return;
      }
      if (imgCount(userMsg) > 0) {
        respond(id, msg.type, true);
        streamAssistant(`I received your image (${imgCount(userMsg)} attachment${imgCount(userMsg) > 1 ? 's' : ''}, ${text ? 'plus the text: "' + text + '"' : 'no text'}). Here is some **markdown** and a code block:\n\n\`\`\`js\nconsole.log("hello from mock pi");\n\`\`\`\n\n- list item one\n- list item two`);
        return;
      }
      if (text.startsWith('!')) { // shouldn't happen (UI routes ! to bash) but be safe
        respond(id, msg.type, true);
        streamAssistant('That looks like a bash command.');
        return;
      }
      respond(id, msg.type, true);
      streamAssistant(
        `Mock reply to: "${text}". This is **streaming** markdown with \`inline code\`.\n\n` +
        '```python\nprint("fenced code block")\n```\n\nAnd a second paragraph so you can watch the tokens arrive.'
      );
      return;
    }
    case 'steer':
    case 'follow_up':
      messages.push({ role: 'user', content: msg.message, timestamp: Date.now() });
      respond(id, msg.type, true);
      streamAssistant(`(queued) Mock reply to: "${msg.message}"`);
      return;
    case 'extension_ui_response':
      // The /dialog demo flow: after the browser answers the confirm, ask for
      // text input, then reply.
      if (msg.id === 'dlg1') {
        send({
          type: 'extension_ui_request', id: 'dlg2', method: 'input',
          placeholder: 'Reason for ' + (msg.confirmed ? 'approving' : 'cancelling'),
        });
      } else if (msg.id === 'dlg2') {
        send({ type: 'extension_ui_request', id: 'ntf1', method: 'notify', notifyType: 'info', message: `Noted: "${msg.value}"` });
        streamAssistant(`Dialog flow complete. You answered the confirm and typed: "${msg.value}".`);
      }
      return;
    default:
      respond(id, msg.type, false, undefined, `mock agent does not implement "${msg.type}"`);
  }
}
