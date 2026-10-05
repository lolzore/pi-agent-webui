// A minimal RFC 6455 WebSocket client — just enough to drive Chrome DevTools
// Protocol from a test, so the browser check needs no dependency.
//
// Scope, deliberately: version 13, text frames only, no extensions, no
// fragmentation on send, continuation frames on receive. That is the whole of
// what CDP needs, and it is small enough to read.

const net = require('net');
const crypto = require('crypto');
const { URL } = require('url');

class WS {
  constructor(url) {
    this.url = new URL(url);
    this.onmessage = null;
    this.onerror = null;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.fragOp = 0;
    this.socket = null;
  }

  open() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const port = this.url.port || 80;
      const sock = net.connect(Number(port), this.url.hostname, () => {
        sock.write(
          `GET ${this.url.pathname}${this.url.search} HTTP/1.1\r\n` +
          `Host: ${this.url.host}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n\r\n');
      });
      this.socket = sock;
      sock.setNoDelay(true);

      let handshake = Buffer.alloc(0);
      const onData = (d) => {
        handshake = Buffer.concat([handshake, d]);
        const end = handshake.indexOf('\r\n\r\n');
        if (end < 0) {
          if (handshake.length > 65536) { sock.destroy(new Error('handshake too large')); }
          return;
        }
        const head = handshake.slice(0, end).toString('latin1');
        if (!/^HTTP\/1\.1 101/.test(head)) {
          sock.destroy(new Error('upgrade refused:\n' + head));
          return;
        }
        sock.removeListener('data', onData);
        // anything after the header is already frame data
        const rest = handshake.slice(end + 4);
        sock.on('data', (chunk) => this._onFrame(chunk));
        sock.on('error', (e) => { if (this.onerror) this.onerror(e); });
        if (rest.length) this._onFrame(rest);
        resolve(this);
      };
      sock.on('data', onData);
      sock.on('error', reject);
    });
  }

  _onFrame(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;

      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > 64n * 1024n * 1024n) { this.socket.destroy(new Error('frame too large')); return; }
        len = Number(big);
        off = 10;
      }

      let maskKey = null;
      if (masked) {
        if (this.buf.length < off + 4) return;
        maskKey = this.buf.slice(off, off + 4);
        off += 4;
      }
      if (this.buf.length < off + len) return;

      let payload = Buffer.from(this.buf.slice(off, off + len));
      this.buf = this.buf.slice(off + len);
      if (maskKey) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
      }

      if (opcode === 0x8) { this.socket.end(); return; }             // close
      if (opcode === 0x9) { this._frame(0xA, payload); continue; }  // ping -> pong
      if (opcode === 0xA) continue;                                  // pong

      if (opcode === 0x0) this.fragments.push(payload);
      else { this.fragments = [payload]; this.fragOp = opcode; }

      if (fin) {
        const full = Buffer.concat(this.fragments);
        this.fragments = [];
        if (this.fragOp === 0x1 && this.onmessage) this.onmessage(full.toString('utf8'));
      }
    }
  }

  _frame(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;   // FIN + opcode
    // A client must mask. Without it the server closes the connection.
    const key = crypto.randomBytes(4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= key[i & 3];
    this.socket.write(Buffer.concat([header, key, masked]));
  }

  send(text) { this._frame(0x1, Buffer.from(text, 'utf8')); }

  close() {
    try { this._frame(0x8, Buffer.alloc(0)); } catch { /* already gone */ }
    try { this.socket.end(); } catch { /* already gone */ }
  }
}

module.exports = WS;
