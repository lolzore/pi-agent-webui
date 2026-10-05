/*
 * Minimal mock of `pi --mode rpc` for developing/testing the WebUI without a
 * real agent install. Implements enough of the RPC protocol to exercise every
 * part of the UI: streaming prompts, images, bash, commands, sessions,
 * fork/edit, and extension UI dialogs. Point the bridge at it with:
 *   PI_COMMAND="node mock_agent.js" node server.js
 */
'use strict';

const state = {
  model: { id: 'mock-large', name: 'Mock Large', provider: 'mock', reasoning: true, input: ['text', 'image'], contextWindow: 200000 },
  thinkingLevel: 'medium',
  isStreaming: false,
  sessionFile: '/root/.pi/agent/sessions/mock-session.jsonl',
  sessionId: 'mock-session',
  sessionName: 'Mock session',
  messageCount: 0,
  compacting: false,
};
const messages = [];
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

function handle(msg) {
  const id = msg.id;
  switch (msg.type) {
    case 'get_state':
      respond(id, msg.type, true, { ...state, pendingMessageCount: 0 });
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
    case 'set_auto_compaction':
    case 'set_auto_retry':
    case 'clear_queue':
      respond(id, msg.type, true, msg.type === 'clear_queue' ? { steering: [], followUp: [] } : undefined);
      return;
    case 'abort':
      state.isStreaming = false;
      respond(id, msg.type, true);
      send({ type: 'agent_end', messages: [] });
      send({ type: 'agent_settled' });
      return;
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
    case 'prompt': {
      if (state.compacting) {
        respond(id, msg.type, false, undefined, 'Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.');
        return;
      }
      const text = msg.message || '';
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
