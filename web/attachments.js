/*
 * Attachments: upload, paste, drop, image shrinking, audio transcription.
 *
 * Split out of app.js (issue #54). Loaded before app.js; the names stay
 * global, so nothing else changed. Behaviour is unchanged.
 */
'use strict';

/* ───────────────────────── attachments (upload / paste / drop) ───────────────────────── */

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function addImageFile(file) {
  if (!file.type.startsWith('image/')) { toast(`Not an image: ${file.name}`, 'warning'); return; }
  const dataUrl = await shrinkImage(await readAsDataUrl(file), file.type);
  S.attachments.push({
    type: 'image',
    data: dataUrl.split(',')[1],
    mimeType: file.type,
    name: file.name || 'pasted-image',
  });
  renderAttachments();
}

/* A picture straight off a phone camera is 3-12 MB, and everything downstream
 * pays for it: the bytes cross this WebSocket as base64 (a third larger again),
 * they are written into the session file, and the provider is asked to look at
 * the whole thing on every turn it stays in the context.
 *
 * It is also the reason a photograph could not be kept in the composer draft -
 * localStorage holds a few megabytes for everything the page keeps, and a phone
 * picture on its own can exceed that. And when a provider rejects a request because
 * of its byte size, its error reads like a context overflow, so a picture that is
 * too big can start a compaction the picture itself can never be summarised out of:
 * pi prices an image at a flat ~1200 tokens no matter how large it is, so the
 * estimate looks small and the image stays in the kept window while each retry
 * carries the same megabytes (issue #38).
 *
 * So anything larger than a sensible viewing size is re-encoded once, on attach.
 * 2048px on the long edge loses nothing anyone can see here, and the base64 that
 * has to travel, be stored and be read is a fraction of what it was. GIFs are left
 * alone so they keep animating, and every failure path returns the original: this
 * is an optimisation and must never be the reason a picture does not arrive. */
const IMAGE_MAX_EDGE = 2048;
const IMAGE_REENCODE_OVER = 300000;   // base64 characters, roughly 225 KB

async function shrinkImage(dataUrl, mimeType) {
  if (typeof dataUrl !== 'string' || dataUrl.length < IMAGE_REENCODE_OVER) return dataUrl;
  if (/gif/i.test(mimeType || '')) return dataUrl;
  try {
    const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const longEdge = Math.max(bmp.width || 0, bmp.height || 0);
    const scale = longEdge > 0 ? Math.min(1, IMAGE_MAX_EDGE / longEdge) : 1;
    if (scale >= 1 && dataUrl.length < IMAGE_REENCODE_OVER * 3) { bmp.close(); return dataUrl; }
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
    bmp.close();
    // PNG for a screenshot (crisp text and flat colour), JPEG for a photograph.
    const type = /png|webp/i.test(mimeType || '') ? 'image/png' : 'image/jpeg';
    const blob = await new Promise((res) => cv.toBlob(res, type, 0.88));
    if (!blob) return dataUrl;
    const shrunk = await readAsDataUrl(blob);
    // Keep it only if it is genuinely smaller - a photo stored as PNG can come
    // back larger from the re-encode, and then the original is the better file.
    return shrunk.length < dataUrl.length ? shrunk : dataUrl;
  } catch {
    return dataUrl;
  }
}

/* File kind for non-image attachments. */
function fileKind(f) {
  if (f.type.startsWith('audio/')) return 'audio';
  if (f.type.startsWith('video/')) return 'video';
  if (f.type === 'application/pdf') return 'pdf';
  return 'file';
}

/* Upload a file to the workspace (bridge saves it under uploads/) so the
 * agent can read it with its tools. Returns {path, size}. */
async function uploadFile(file) {
  // Big files as a raw body: base64 inflates them by a third and the JSON body
  // cap cut the request off - which surfaced as "data (base64) is required",
  // because the server received a truncated object. A background video is often
  // the largest file anyone uploads, and it only ever gets stored, never sent to
  // the model.
  if (file.size > 8 * 1024 * 1024) {
    const q = `name=${encodeURIComponent(file.name || 'file')}&mimeType=${encodeURIComponent(file.type || '')}`;
    const d = await (await fetch(api(`/api/upload-raw?${q}`), {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    })).json();
    if (!d.ok) throw new Error(d.error || 'upload failed');
    if (d.duplicate) toast(`“${file.name}” was uploaded before — reusing it`, 'warning');
    return d;
  }
  const data = await readAsDataUrl(file);
  const d = await (await fetch(api('/api/upload'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: file.name, data: data.split(',')[1], mimeType: file.type }),
  })).json();
  if (!d.ok) throw new Error(d.error || 'upload failed');
  if (d.duplicate) toast(`“${file.name}” was uploaded before — reusing it`, 'warning');
  return d;
}

/* Transcribe an audio file. Tries the bridge's local whisper first, then the
 * user-configured STT endpoint. Audio is converted to 16 kHz mono WAV in the
 * browser first so mp3/m4a/ogg/webm all work. */
async function transcribeAudioFile(file) {
  let wavBlob = file;
  try { wavBlob = await blobToWav(file); } catch { /* not browser-decodable; send raw */ }
  const dataUrl = await readAsDataUrl(wavBlob);
  const b64 = dataUrl.split(',')[1];
  // Whisper backend: make sure the local server is actually up first (it is
  // downloaded on demand), so picking whisper in settings "just works".
  if (SET.sttBackend === 'whisper') await ensureWhisper(true);
  try {
    const d = await (await fetch(api('/api/transcribe'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: b64 }),
    })).json();
    if (d.ok && d.text) return d.text;
  } catch { /* no local STT server */ }
  if (SET.sttEndpoint) {
    const endpoint = sttEndpointUrl();
    const fd = new FormData();
    fd.append('file', wavBlob, wavBlob.name || 'speech.wav');
    if (/\/v1\/audio\/transcriptions\/?$/.test(endpoint)) {
      fd.append('model', 'whisper-1');
      fd.append('response_format', 'json');
    }
    const res = await fetch(endpoint, { method: 'POST', body: fd });
    if (!res.ok) throw new Error(`STT server ${res.status}`);
    const d = await res.json();
    return d.text || d.transcription || '';
  }
  throw new Error('no STT endpoint available');
}

/* Attach any file: images go to the model as vision input; everything else
 * (PDF / audio / video / other) is uploaded to the workspace and referenced
 * by path in the prompt. Audio is transcribed when STT is available. */
/* A picture or a video is something the user might mean as a background (the
 * wallpaper picker takes both). Used to route a dropped file that is too big for
 * the model to the wallpaper instead of refusing it outright. */
async function addFile(file) {
  if (file.type.startsWith('image/')) { await addImageFile(file); return; }
  /* No size cap here: a video is stored by the bridge, never base64'd into a
   * prompt, and uploadFile() switches to the raw-body route above 8 MB, so the
   * big-file limit is the bridge's own (PI_WEBUI_MAX_UPLOAD, 4 GB by default).
   * A local cap only used to make a 200 MB video fail where the server was
   * happy to take it (issue #62); the server's 413 says the real limit. */
  const att = { type: 'file', kind: fileKind(file), name: file.name || 'file', mimeType: file.type, size: file.size };
  try {
    const up = await uploadFile(file);
    att.path = up.path;
    /* Frames the bridge took with ffmpeg (issue #72). pi has no video content
     * block, so pictures are the only way a vision model can see the clip; they
     * ride along with the message and the chip shows what will be sent. */
    if (att.kind === 'video') {
      if (Array.isArray(up.frames) && up.frames.length) att.frames = up.frames;
      if (up.frameNote) att.frameNote = up.frameNote;
    }
  } catch (e) {
    toast(`Upload failed: ${e.message}`, 'error');
    return;
  }
  if (att.kind === 'audio') {
    att.transcribing = true;
    S.attachments.push(att);
    renderAttachments();
    try { att.transcript = await transcribeAudioFile(file); }
    catch (e) { att.transcriptError = e.message; }
    att.transcribing = false;
  } else {
    S.attachments.push(att);
  }
  renderAttachments();
}

function renderAttachments() {
  saveDraft();
  const wrap = $('attachments');
  wrap.innerHTML = '';
  wrap.classList.toggle('hidden', !S.attachments.length);
  syncComposerText();
  S.attachments.forEach((a, i) => {
    const box = el('div', `attachment${a.type === 'file' ? ' file' : ''}`);
    if (a.type === 'image') {
      const dataUrl = `data:${a.mimeType};base64,${a.data}`;
      // A 64px thumbnail cannot show what you are about to send. Clicking it
      // opens the real picture; the same full-size viewer a message image uses,
      // closed by clicking off it or with Esc.
      const view = el('button', 'attachment-view');
      view.type = 'button';
      view.title = `${a.name || 'image'} — click to view it full size`;
      view.setAttribute('aria-label', `view ${a.name || 'this image'} full size`);
      const img = el('img');
      img.src = dataUrl;
      img.alt = '';
      const eye = el('span', 'attachment-eye');
      eye.innerHTML = EYE_SVG;
      view.append(img, eye);
      view.onclick = (e) => { e.stopPropagation(); zoomImage(dataUrl); };
      box.appendChild(view);
    } else if (a.kind === 'video' && a.path) {
      // Play it here, not just a ▶ and a filename: the bridge serves the
      // uploaded bytes back (issue #62). Muted so dropping a clip in does not
      // suddenly play sound; the controls are the real player.
      const v = el('video', 'attachment-video');
      v.controls = true;
      v.muted = true;
      v.preload = 'metadata';
      v.title = a.name || 'video';
      v.src = api(`/api/upload-file?path=${encodeURIComponent(a.path)}`);
      box.appendChild(v);
      if (a.frames && a.frames.length) {
        box.classList.add('has-frames');
        const strip = el('div', 'attachment-frames');
        strip.title = `${a.frames.length} frames from this video go to the model as images`;
        for (const f of a.frames) {
          const im = el('img');
          im.src = `data:${f.mimeType || 'image/jpeg'};base64,${f.data}`;
          im.alt = '';
          strip.appendChild(im);
        }
        strip.appendChild(el('span', 'attachment-frames-note', `${a.frames.length} frames go to the model`));
        box.appendChild(strip);
      } else if (a.frameNote) {
        box.appendChild(el('div', 'attachment-note', a.frameNote));
      }
    } else {
      const icon = el('div', 'file-icon', a.kind === 'pdf' ? 'PDF' : a.kind === 'audio' ? '♪' : a.kind === 'video' ? '▶' : '·');
      const meta = el('div', 'file-meta');
      meta.appendChild(el('div', 'file-name', a.name));
      const status = a.transcribing
        ? 'transcribing…'
        : a.transcript
          ? `transcribed: ${a.transcript.slice(0, 80)}${a.transcript.length > 80 ? '…' : ''}`
          : a.transcriptError
            ? `transcript failed (${a.transcriptError})`
            : fmtSize(a.size);
      meta.appendChild(el('div', 'file-status', status));
      box.append(icon, meta);
    }
    const rm = el('button', 'rm', '×');
    rm.onclick = () => { S.attachments.splice(S.attachments.indexOf(a), 1); renderAttachments(); };
    box.appendChild(rm);
    wrap.appendChild(box);
  });
}

function clearAttachments() {
  S.attachments = [];
  renderAttachments();
  syncComposerText();
  saveDraft();
}

$('btn-attach').onclick = () => $('file-input').click();
$('file-input').onchange = async (e) => {
  for (const f of e.target.files) await addFile(f);
  e.target.value = '';
};

// paste images from clipboard
document.addEventListener('paste', (e) => {
  const items = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith('image/'));
  if (!items.length) return;
  e.preventDefault();
  for (const item of items) {
    const file = item.getAsFile();
    if (file) addImageFile(file);
  }
  toast('Image pasted from clipboard');
});

// drag & drop images onto the window
let dragDepth = 0;
function hideDropOverlay() {
  dragDepth = 0;
  const o = $('drop-overlay');
  if (o) o.classList.add('hidden');
}
document.addEventListener('dragenter', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  // In a dialog, and on a row that takes files itself, the "drop files to attach"
  // overlay is wrong: those spots have their own highlight. Leaving it up (and
  // having no drop event to take it down, because the row stops propagation) is
  // what left it hanging over the page.
  const t = e.target;
  if (t && t.closest && (t.closest('dialog') || t.closest('.avatar-row') || t.closest('.rate-row'))) return;
  dragDepth++;
  $('drop-overlay').classList.remove('hidden');
});
document.addEventListener('dragleave', (e) => {
  // Leaving the window (no relatedTarget) always clears it: the counter can miss
  // a leave when the drag ends inside a nested element.
  if (!e.relatedTarget) { hideDropOverlay(); return; }
  if (--dragDepth <= 0) hideDropOverlay();
});
// the drag ending anywhere - dropped, cancelled, or dropped on a row that stops
// propagation - must take the overlay down
document.addEventListener('dragend', () => hideDropOverlay());
window.addEventListener('blur', () => hideDropOverlay());
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  hideDropOverlay();
  for (const f of e.dataTransfer?.files || []) await addFile(f);
});
