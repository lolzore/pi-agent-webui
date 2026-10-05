// Defaults for the Pi Agent bridge.
//
// The host matters: on Windows the app runs on the same machine as the bridge,
// so `localhost` is right and needs no setup prompt. A phone is a different
// machine, so it needs the PC's LAN address — which JS cannot discover on its
// own, so the setup dialog asks for it rather than guessing.

/* The default host.
 *
 * Previously a hardcoded LAN address, which was wrong on every
 * machine but one and on every network but that one: change the router, get a
 * new address, or run this on a laptop on Wi-Fi at the office, and the app
 * pointed at a stranger's machine and refused to connect. There is also no way
 * to detect the PC's address from the phone — that needs a native module or a
 * discovery protocol, and a wrong guess is worse than an honest prompt.
 *
 * So: localhost, which is correct on Windows where the app and the bridge share
 * a machine, and on a phone the first-run setup dialog asks for the address and
 * stores it. `PI_AGENT_HOST` overrides it for a build that knows better. */
export const DEFAULT_HOST = (() => {
  if (typeof process !== 'undefined' && process.env && process.env.PI_AGENT_HOST) {
    return process.env.PI_AGENT_HOST;
  }
  return 'localhost';
})();

export const DEFAULT_PORT = 3080;

/** Normalize a host string.
 *
 * People paste whatever is in the address bar, so this has to survive a whole
 * URL. It stripped only a leading `ws://` / `http://` and a trailing slash, which
 * left the path in place for a pasted `ws://host:3080/ws` - and that value is
 * then interpolated into `ws://${host}:${port}/ws`, giving
 * `ws://host:3080/ws:3080/ws`, which fails with a message that says nothing about
 * the cause.
 *
 * So: drop any scheme (not just the two expected ones), drop `user:pass@`, and
 * cut at the first `/` - the host is everything before it. Bracketed IPv6
 * literals (`[::1]:3080`) contain no `/`, so they pass through untouched; the
 * trailing-slash trim stays for the bare `host/` case. */
function normalizeHost(host) {
  let h = String(host || '').trim();
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');   // any scheme
  h = h.replace(/^[^@/]*@/, '');                     // user:pass@
  const slash = h.indexOf('/');
  if (slash >= 0) h = h.slice(0, slash);             // path and anything after it
  return h.replace(/\/+$/, '');
}

/** Normalize a port string: default to 3080 if empty. */
function normalizePort(port) {
  return String(port || '').trim() || '3080';
}

/** Build the ws:// URL for a host/port pair. */
export function wsUrl(host, port) {
  const h = normalizeHost(host);
  const p = normalizePort(port);
  return `ws://${h}:${p}/ws`;
}

/** HTTP base derived from the same host/port (bridge REST endpoints). */
export function httpUrl(host, port) {
  const h = normalizeHost(host);
  const p = normalizePort(port);
  return `http://${h}:${p}`;
}
