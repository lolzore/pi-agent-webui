/* The WebUI's bridge to the Electron shell.
 *
 * The React Native/WebView2 shell gave the page window.chrome.webview.postMessage
 * for its split-pane surface. Electron has no such object, so the page used the
 * iframe fallback and the real Reels feed never loaded. Expose the same one-way
 * postMessage (and a small state query) under a namespaced object; web/shorts.js
 * checks for it before window.chrome.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('piDesktop', {
  postMessage: (msg) => ipcRenderer.send('piagent:webview', String(msg)),
  embedState: () => ipcRenderer.invoke('piagent:embed-state'),
  /* Editable right-clicks are rendered by the page's own menu component, with
   * the suggestions Electron's spellchecker found; the native GTK menu looked
   * nothing like the rest of the app. */
  onContextMenu: (cb) => ipcRenderer.on('piagent:context-menu', (_e, data) => cb(data)),
  contextAction: (action, value) => ipcRenderer.send('piagent:context-action', String(action), value == null ? '' : String(value)),
});
