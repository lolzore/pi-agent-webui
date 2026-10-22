/* Issue #175: look at what an html or svg code block actually renders.
 *
 * The eye on such a block opens a preview over the chat - the page in a
 * sandboxed frame, the svg as the picture itself - with the code one click away
 * (copy) and an X to close. While the agent is still writing the block, the
 * preview keeps up: the block is re-read from the live message and the picture
 * redraws as the code arrives.
 *
 * Safety: the frame is sandboxed without allow-same-origin, so a page the agent
 * wrote cannot reach this origin, and the svg goes into an <img> as a data URL,
 * which never runs script or event handlers.
 */
'use strict';

let codePreviewTimer = null;
let codePreviewWatch = null;   // { index, lang } of the block being followed, in the live message

function codeFromBox(box) {
  const pre = box && box.querySelector('pre');
  return pre ? pre.textContent : '';
}

/* The frame has no origin of its own (sandbox without allow-same-origin), so a
 * relative link inside it resolved against *this* page's URL - clicking a link
 * in a preview loaded the WebUI itself into the frame, where its scripts cannot
 * run, and nothing appeared. The base pins the document to itself, and the guard
 * stops navigation altogether: a preview is something to look at, and a click on
 * a link says so instead of breaking. */
function previewDocument(code) {
  const guard = `<base href="about:srcdoc">
<script>
document.addEventListener('click', function (e) {
  var a = e.target && e.target.closest ? e.target.closest('a') : null;
  if (!a) return;
  e.preventDefault();
  try { parent.postMessage({ piCodePreview: 'link', href: a.getAttribute('href') || '' }, '*'); } catch (err) {}
}, true);
document.addEventListener('submit', function (e) { e.preventDefault(); }, true);
<\/script>`;
  if (/<head[\s>]/i.test(code)) return code.replace(/<head([^>]*)>/i, (m) => m + guard);
  if (/<html[\s>]/i.test(code)) return code.replace(/<html([^>]*)>/i, (m) => m + `<head>${guard}</head>`);
  return guard + code;
}

function svgDataUrl(code) {
  // a data URL, so the picture is embedded and cannot script anything
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(code)}`;
}

function renderCodePreview(lang, code) {
  const body = $('code-preview-body');
  const title = $('code-preview-title');
  if (!body) return;
  if (title) title.textContent = lang === 'svg' ? 'svg' : 'html page';
  if (lang === 'svg') {
    let img = body.querySelector('img.code-preview-svg');
    if (!img) {
      body.replaceChildren();
      img = el('img', 'code-preview-svg');
      img.alt = 'SVG preview';
      body.appendChild(img);
    }
    img.src = svgDataUrl(code);
    return;
  }
  let frame = body.querySelector('iframe.code-preview-frame');
  if (!frame) {
    body.replaceChildren();
    frame = el('iframe', 'code-preview-frame');
    frame.setAttribute('sandbox', 'allow-scripts allow-popups allow-modals');
    frame.setAttribute('title', 'HTML preview');
    body.appendChild(frame);
  }
  frame.srcdoc = previewDocument(code);
}

/* The viewable blocks in a piece of markdown, in order - the same split the
 * renderer does, so block N here is block N in the chat. A block whose fence is
 * still open (the agent is mid-write) is included: that is the one being
 * watched. */
function codeBlocksIn(src) {
  const out = [];
  String(src || '').split('```').forEach((seg, i) => {
    if (i % 2 !== 1) return;
    const nl = seg.indexOf('\n');
    const lang = (nl >= 0 ? seg.slice(0, nl) : '').trim().toLowerCase();
    if (lang !== 'html' && lang !== 'htm' && lang !== 'svg') return;
    out.push({ lang, code: nl >= 0 ? seg.slice(nl + 1) : seg });
  });
  return out;
}

/* Follow a block that is still being written.
 *
 * From the live *text*, not the DOM: while a dialog is open the streaming paint
 * is deferred (issue #131 - the dialog's own first frame comes first), so the
 * chat's copy of the block can be a moment behind, and the preview is the one
 * thing that has to keep up. */
function followLiveBlock(box, lang) {
  if (codePreviewTimer) { clearInterval(codePreviewTimer); codePreviewTimer = null; }
  codePreviewWatch = null;
  if (typeof S !== 'object' || !S.live || !S.live.root || !S.live.root.contains(box)) return;
  const boxes = [...S.live.root.querySelectorAll('.codebox.viewable')];
  const index = boxes.indexOf(box);
  if (index < 0) return;
  codePreviewWatch = { index, lang };
  let last = codeFromBox(box);
  codePreviewTimer = setInterval(() => {
    if (!codePreviewWatch || typeof S !== 'object' || !S.live) { stopFollowing(); return; }
    const block = codeBlocksIn(S.live.text)[codePreviewWatch.index];
    if (!block) return;
    if (block.code !== last) {
      last = block.code;
      renderCodePreview(codePreviewWatch.lang, block.code);
    }
  }, 250);
}

function stopFollowing() {
  if (codePreviewTimer) { clearInterval(codePreviewTimer); codePreviewTimer = null; }
  codePreviewWatch = null;
}

function openCodePreview(box) {
  const dialog = $('code-preview');
  if (!dialog || !box) return;
  const lang = (box.dataset.lang || 'html').toLowerCase();
  const code = codeFromBox(box);
  dialog._lang = lang;
  dialog._code = code;
  renderCodePreview(lang, code);
  if (!dialog.open) dialog.showModal();
  followLiveBlock(box, lang);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Code copied', 'ok');
  } catch {
    toast('Could not copy the code', 'error');
  }
}

function closeCodePreview() {
  const dialog = $('code-preview');
  stopFollowing();
  if (dialog && dialog.open) dialog.close();
}

function wireCodePreview() {
  const dialog = $('code-preview');
  if (!dialog) return;
  /* The markdown is inserted as HTML, so the buttons are caught by delegation. */
  document.addEventListener('click', (e) => {
    const hit = e.target && e.target.closest ? e.target.closest('.code-eye, .code-copy') : null;
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    const box = hit.closest('.codebox');
    if (hit.classList.contains('code-copy')) {
      copyText(codeFromBox(box));
      return;
    }
    openCodePreview(box);
  });
  /* A link inside a preview says so rather than navigating the frame. */
  window.addEventListener('message', (e) => {
    if (e.data && e.data.piCodePreview === 'link') {
      toast('Links are not followed in the preview - copy the code and open it yourself', 'warning');
    }
  });
  const close = $('code-preview-close');
  if (close) close.onclick = closeCodePreview;
  const copy = $('code-preview-copy');
  if (copy) {
    copy.onclick = async () => {
      const code = (dialog._code !== undefined) ? dialog._code : '';
      copyText(code);
    };
  }
  dialog.addEventListener('close', stopFollowing);
}
