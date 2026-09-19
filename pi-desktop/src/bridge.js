// Native client for the Pi Agent bridge (same WS protocol as the WebUI).
// The bridge spawns one `pi --mode rpc` agent per connection; this class
// manages the socket, request/response correlation, and event dispatch.
export class Bridge {
  constructor({ url, onEvent, onState, onAgentExit } = {}) {
    this.url = url;
    this.ws = null;
    this.onEvent = onEvent;          // (msg) => void   — agent events (message_*, agent_*, tool_*)
    this.onState = onState;          // (mode) => void  — 'on' | 'off'
    this.onAgentExit = onAgentExit;  // (info) => void
    this.pending = new Map();        // id -> {resolve, reject, timer}
    this.reqId = 0;
    this.connected = false;
    this.closing = false;
    this.retryDelay = 1000;
    this.retryTimer = null;
  }

  connect() {
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return; // CONNECTING/OPEN
    this.closing = false;
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this.retryDelay = 1000;
      if (this.onState) this.onState('on');
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.bridge === 'rpc' && msg.payload) {
        this.handleRpc(msg.payload);
      } else if (msg.bridge === 'agent_started') {
        if (this.onEvent) this.onEvent({ type: 'agent_started', ...msg });
      } else if (msg.bridge === 'agent_exit') {
        if (this.onAgentExit) this.onAgentExit(msg);
      } else if (msg.bridge === 'agent_stderr' && msg.text) {
        if (this.onEvent) this.onEvent({ type: 'bridge_stderr', text: msg.text });
      }
    };

    ws.onclose = () => {
      this.connected = false;
      this.rejectAll('connection closed');
      if (this.onState) this.onState('off');
      if (!this.closing) this.scheduleReconnect();
    };

    ws.onerror = () => { /* onclose follows */ };
  }

  scheduleReconnect() {
    if (this.closing) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, 15000);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { if (!this.closing) this.connect(); }, delay);
  }

  close() {
    this.closing = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (this.ws) {
      try { this.ws.close(); } catch { /* already closed */ }
      this.ws = null;
    }
  }

  handleRpc(msg) {
    if (msg.type === 'response') {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        msg.success ? p.resolve(msg.data) : p.reject(new Error(msg.error || 'request failed'));
      }
      return;
    }
    if (this.onEvent) this.onEvent(msg);
  }

  rpc(obj, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) {
        reject(new Error('not connected to the bridge'));
        return;
      }
      const id = `m${++this.reqId}`;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${obj.type}: timed out`));
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ ...obj, id }));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  restartAgent() {
    if (this.ws && this.ws.readyState === 1) {
      try { this.ws.send(JSON.stringify({ bridge: 'restart' })); } catch { /* ignore */ }
    }
  }

  rejectAll(reason) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
