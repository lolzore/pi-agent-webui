/*
 * Appearance: the custom cursor (load, draw, verify) and the crop dialog
 * (state, geometry, drag, paint, save) for the avatar and background.
 *
 * Split out of app.js (issue #54, phase 8). Loaded before app.js; the names
 * stay global, so nothing else changed. Behaviour is unchanged.
 */
'use strict';

let cursorApplied = { src: '', size: 0, url: '' };   // what is in the CSS right now
let cursorDrawing = false;

function cursorImageLoads(src) {
  return new Promise((resolve) => {
    const img = new Image();
    const done = (ok, w, h) => { img.onload = null; img.onerror = null; resolve({ ok, w, h }); };
    img.onload = () => done((img.naturalWidth || 0) > 0, img.naturalWidth, img.naturalHeight);
    img.onerror = () => done(false, 0, 0);
    setTimeout(() => done(false, 0, 0), 5000);
    img.src = src;
  });
}

function writeCursorVar(url, hx, hy) {
  const root = document.documentElement;
  root.style.setProperty('--cursor', `url("${url}") ${hx} ${hy}, auto`);
  root.classList.add('custom-cursor');
}

function applyCustomCursor() {
  const root = document.documentElement;
  const src = (SET.cursorImage || '').trim();
  if (!src) {
    cursorApplied = { src: '', size: 0, url: '' };
    root.classList.remove('custom-cursor');
    root.style.removeProperty('--cursor');
    return;
  }
  if (/["\\\n\r]/.test(src)) {
    // a quote or a backslash would end the url("...") token and produce a rule
    // that does not parse - the same invisible nothing
    cursorApplied = { src: '', size: 0, url: '' };
    root.classList.remove('custom-cursor');
    root.style.removeProperty('--cursor');
    return;
  }
  const size = Math.max(8, Math.min(CURSOR_MAX, Number(SET.cursorSize) || 32));
  const hx = Math.max(0, Math.min(size - 1, Number(SET.cursorHotX) || 0));
  const hy = Math.max(0, Math.min(size - 1, Number(SET.cursorHotY) || 0));

  // a remote picture is used as it is: drawing a cross-origin image taints the
  // canvas and toDataURL then throws
  if (/^https?:/i.test(src)) {
    cursorApplied = { src, size, url: src };
    writeCursorVar(src, hx, hy);
    return;
  }
  // already normalised for exactly this source and size? nothing to redraw
  if (cursorApplied.url && cursorApplied.src === src && cursorApplied.size === size) return;
  // put the original up straight away, so there is no dead time while it draws
  cursorApplied = { src, size, url: src };
  writeCursorVar(src, hx, hy);
  drawNormalisedCursor(src, size, hx, hy);
}

function drawNormalisedCursor(src, size, hx, hy) {
  if (cursorDrawing) return;                 // one draw at a time; the last one wins
  cursorDrawing = true;
  const img = new Image();
  const giveUp = () => {
    cursorDrawing = false;
    // whatever is up now stays up - a remote or odd picture is still better
    // than no pointer at all
  };
  img.onload = () => {
    try {
      const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
      if (!w || !h) { giveUp(); return; }
      // the source may have moved on while this was drawing
      if ((SET.cursorImage || '').trim() !== src) { cursorDrawing = false; applyCustomCursor(); return; }
      const c = document.createElement('canvas');
      c.width = size; c.height = size;
      const g = c.getContext('2d');
      // letterbox rather than crop: a cursor picture is a sprite, and cutting its
      // corners off to make it square would put the wrong pixel under the pointer
      const sc = Math.min(size / w, size / h);
      const dw = w * sc, dh = h * sc;
      const offX = Math.round((size - dw) / 2), offY = Math.round((size - dh) / 2);
      g.drawImage(img, offX, offY, dw, dh);
      const out = c.toDataURL('image/png');
      // the hotspot is in the *drawn* picture, not the source, and must land
      // inside it or the engine drops the whole thing
      const rx = Math.max(0, Math.min(size - 1, Math.round(hx * sc) + offX));
      const ry = Math.max(0, Math.min(size - 1, Math.round(hy * sc) + offY));
      cursorDrawing = false;
      cursorApplied = { src, size, url: out };
      writeCursorVar(out, rx, ry);
    } catch (e) {
      giveUp();   // a tainted canvas: keep the original
    }
  };
  img.onerror = () => giveUp();
  img.src = src;
}

/* Check the picture and report. Called after every change to cursorImage, not
 * from applySettings (which runs on unrelated settings too and must not redraw
 * an image on each one). */
/* Dragging the size slider redraws the picture on every step, so the note (which
 * reports the size actually drawn) is refreshed once the dragging stops rather
 * than on each step. */
let cursorNoteTimer = null;
function cursorNoteTimerSoon() {
  if (cursorNoteTimer) clearTimeout(cursorNoteTimer);
  cursorNoteTimer = setTimeout(() => { cursorNoteTimer = null; verifyCustomCursor(); }, 350);
}

async function verifyCustomCursor() {
  const src = (SET.cursorImage || '').trim();
  const note = $('cursor-note');
  const say = (t) => { if (note) note.textContent = t; };
  if (!src) { say(''); return true; }
  const seen = await cursorImageLoads(src);
  if (!seen.ok) {
    document.documentElement.classList.remove('custom-cursor');
    cursorApplied = { src: '', size: 0, url: '' };
    say('That picture could not be loaded, so the pointer was left at the normal one. A browser only draws a cursor it can actually decode, and it says nothing when it cannot — use a PNG.');
    return false;
  }
  if (seen.w > CURSOR_MAX || seen.h > CURSOR_MAX) {
    say(`Your picture is ${seen.w}×${seen.h}. A browser drops a CSS cursor larger than ${CURSOR_MAX}×${CURSOR_MAX} without saying anything, so it is redrawn at ${cursorApplied.size || CURSOR_MAX}px and written out as a PNG.`);
  } else {
    say(`Applied — ${cursorApplied.size}px, written as a PNG so the browser will use it. The hotspot is the pixel that sits on the real pointer tip.`);
  }
  return true;
}

let cropState = null;

/* Older crops stored object-position percentages; convert them on the way in. */
function normalizeCrop(crop) {
  if (!crop) return null;
  if (crop.v === 2) return crop;
  const f = (p) => Math.max(-1, Math.min(1, ((p == null ? 50 : Number(p)) - 50) / 50));
  return { v: 2, fx: f(crop.x), fy: f(crop.y), z: Math.max(1, Number(crop.z) || 1) };
}

function cropRatios(node, frameAspect) {
  const nw = node.naturalWidth || node.videoWidth || 0;
  const nh = node.naturalHeight || node.videoHeight || 0;
  const a = frameAspect || 1;
  if (!nw || !nh) return { cw: 1, ch: 1, ready: false };
  const b = nw / nh;
  return { cw: Math.max(1, b / a), ch: Math.max(1, a / b), ready: true };
}

function applyCrop(node, crop, frameAspect) {
  if (!node) return;
  const c = normalizeCrop(crop);
  const nw = node.naturalWidth || node.videoWidth || 0;
  const nh = node.naturalHeight || node.videoHeight || 0;
  if (!c || !nw || !nh) {
    node.style.width = '';
    node.style.height = '';
    node.style.objectFit = '';
    node.style.objectPosition = '';
    node.style.transform = '';
    return;
  }
  /* "Fit picture" shows the whole image instead of filling (and cropping to)
   * the screen. It is the manual answer to a picture whose aspect ratio does
   * not match the window: the user can choose letterboxing over losing edges. */
  if (c.fit === 'contain') {
    node.style.width = '100%';
    node.style.height = '100%';
    node.style.objectFit = 'contain';
    node.style.objectPosition = '50% 50%';
    node.style.transform = 'none';
    return;
  }
  node.style.objectFit = '';
  const { cw, ch } = cropRatios(node, frameAspect);
  const z = Math.max(1, Number(c.z) || 1);
  // The element is sized to the cover rect of its frame (E = cw·B) and the frame
  // wrapper clips it. object-fit content is clipped to the element box, so
  // translating a box the same size as the frame dragged it away from under its
  // own picture and left black gaps - the picture has to be bigger than the
  // frame and move inside it.
  node.style.width = `${cw * 100}%`;
  node.style.height = `${ch * 100}%`;
  node.style.objectPosition = '50% 50%';
  // Pan range at zoom z is (z·E − B)/2, which as a share of the element is
  // 50·(z − B/E) = 50·(z − 1/cw). Negative because moving the visible window to
  // the right means moving the picture to the left.
  const tx = -(Number(c.fx) || 0) * 50 * (z - 1 / cw);
  const ty = -(Number(c.fy) || 0) * 50 * (z - 1 / ch);
  node.style.transform = `translate(${tx}%, ${ty}%) scale(${z})`;
}

/* The natural size - and with it the pan ranges - only exists after load. */
function attachCrop(node, crop, frameAspect) {
  applyCrop(node, crop, frameAspect);
  const again = () => applyCrop(node, crop, frameAspect);
  node.addEventListener('load', again);
  node.addEventListener('loadedmetadata', again);
  return node;
}

/* Where the crop frame sits on the stage, and how much the picture can move.
 * Everything is in stage pixels; the frame stays put and the picture moves. */
function cropGeometry() {
  if (!cropState) return null;
  const { node, frame, fx, fy, z } = cropState;
  const stage = $('crop-stage');
  const nw = node.naturalWidth || node.videoWidth || 0;
  const nh = node.naturalHeight || node.videoHeight || 0;
  if (!stage || !nw || !nh) return null;
  const sr = stage.getBoundingClientRect();
  const s = Math.min(sr.width / nw, sr.height / nh);      // contain fit: whole picture visible
  const b = nw / nh;
  const baseW = b >= frame ? nh * frame : nw;             // biggest frame-shaped rect in the image
  const baseH = b >= frame ? nh : nw / frame;
  const cropW = baseW / z;
  const cropH = baseH / z;
  // How far the crop rect can travel inside the *picture* - using the base rect
  // here instead would leave nothing to pan at zoom 1 and only a fraction of
  // the picture to choose from further in.
  const rangeX = (nw - cropW) / 2;
  const rangeY = (nh - cropH) / 2;
  const cx = nw / 2 + (Number(fx) || 0) * rangeX;
  const cy = nh / 2 + (Number(fy) || 0) * rangeY;
  const left = (sr.width - nw * s) / 2 + (cx - cropW / 2) * s;
  const top = (sr.height - nh * s) / 2 + (cy - cropH / 2) * s;
  return { s, rangeX, rangeY, left, top, w: cropW * s, h: cropH * s };
}

function paintCrop() {
  if (!cropState) return;
  const g = cropGeometry();
  const overlay = $('crop-frame');
  if (g && overlay) {
    overlay.classList.remove('hidden');
    overlay.style.left = `${g.left}px`;
    overlay.style.top = `${g.top}px`;
    overlay.style.width = `${g.w}px`;
    overlay.style.height = `${g.h}px`;
  }
  const { fx, fy, z } = cropState;
  const zoom = $('crop-zoom');
  if (zoom) { zoom.value = String(z); $('crop-zoom-val').textContent = `${z.toFixed(2)}×`; }
  const cx = $('crop-x'); if (cx) cx.value = String(fx);
  const cy = $('crop-y'); if (cy) cy.value = String(fy);
}

/* Move the crop frame by a drag, in pixels, on the (possibly zoomed) stage.
 * The frame follows the pointer - dragging up moves it up. It used to go the
 * other way, and since the picture itself stays put, that read as the picture
 * sliding backwards. */
function cropDrag(dx, dy) {
  if (!cropState) return;
  const g = cropGeometry();
  if (!g) return;   // not loaded yet
  const halfX = g.rangeX * g.s;
  const halfY = g.rangeY * g.s;
  const clamp = (v) => Math.max(-1, Math.min(1, v));
  if (halfX > 0.5) cropState.fx = clamp(cropState.fx + dx / halfX);
  if (halfY > 0.5) cropState.fy = clamp(cropState.fy + dy / halfY);
  paintCrop();
}

/* The dialog is not laid out the moment it opens, and inside an embedded webview
 * window.innerHeight can still read 0 - paintCrop then measured a zero-sized
 * stage and drew its mask over the whole thing, so on some machines the picture
 * was invisible. Retry across a few frames until the stage has a real size. */
function schedulePaint(frames) {
  const stage = $('crop-stage');
  if (!stage) return;
  const n = frames || 0;
  const tiny = stage.clientWidth < 24 || stage.clientHeight < 24;
  // Waiting for layout is a question of time, not of frames: counting frames
  // made this give up sooner on a fast display and later on a slow one.
  if (tiny && n < 40) { requestAnimationFrame(() => schedulePaint(n + 2)); return; }
  // Normally the stylesheet sizes the stage. Only if it really has no size -
  // an embedded webview reporting a 0x0 window before layout - put pixels in.
  if (tiny) {
    const size = Math.max(150, Math.round(Math.min(320, (window.innerHeight || 600) * 0.4)));
    stage.style.width = `${size}px`;
    stage.style.height = `${size}px`;
  }
  paintCrop();
}

/* The background cropper can either fill the screen (cover, the default) or
 * show the whole picture (contain). The latter matters for a portrait picture
 * on a landscape screen - the user asked to be able to fit it instead of losing
 * the sides. Avatar is always a 1:1 circle, so the row is hidden there. */
function syncCropFitUi() {
  if (!cropState) return;
  const isAvatar = cropState.kind === 'avatar';
  const contain = cropState.fit === 'contain';
  const row = $('crop-fit-row');
  const label = $('crop-fit-label');
  if (row) row.classList.toggle('hidden', isAvatar);
  if (label) label.classList.toggle('hidden', isAvatar);
  const cover = $('crop-fit-cover');
  const fit = $('crop-fit-contain');
  if (cover) cover.classList.toggle('on', !contain);
  if (fit) fit.classList.toggle('on', contain);
  for (const id of ['crop-zoom', 'crop-x', 'crop-y']) {
    const input = $(id);
    if (input) input.disabled = contain;
  }
  const hint = $('crop-hint');
  if (hint) {
    const loadNote = /the picture did not load on this device/.test(hint.textContent)
      ? '  (the picture did not load on this device)' : '';
    if (isAvatar) {
      hint.textContent = 'The circle is what the chat will show. Drag the picture to move it, scroll or use the slider to zoom - zooming in lets you slide it further.' + loadNote;
    } else if (contain) {
      hint.textContent = 'The whole picture is shown and will fit the screen with empty space around it. Switch to fill screen to crop it instead.' + loadNote;
    } else {
      hint.textContent = 'The frame is what you will see on screen. Drag the picture to move it, scroll or use the slider to zoom - zooming in lets you slide it further.' + loadNote;
    }
  }
}

function setCropFit(fit) {
  if (!cropState) return;
  cropState.fit = fit === 'contain' ? 'contain' : 'cover';
  cropState.fx = 0; cropState.fy = 0; cropState.z = 1;
  if (typeof cropState.refreshStage === 'function') cropState.refreshStage();
  else { syncCropFitUi(); paintCrop(); }
}

function openCropper(kind) {
  const isAvatar = kind === 'avatar';
  const src = isAvatar ? SET.avatar : SET.themeBg;
  if (!src) {
    toast(isAvatar ? 'Upload a profile image first' : 'Upload a background first', 'warning');
    return;
  }
  const saved = normalizeCrop(isAvatar ? SET.avatarCrop : SET.bgCrop) || {};
  const stage = $('crop-stage');
  const media = $('crop-media');
  const node = mediaNode(src, 'crop-node');
  media.replaceChildren(node);
  // If the picture cannot be decoded here, say so rather than showing an empty
  // frame - a cropper that looks "invisible" usually means this.
  setTimeout(() => {
    const hint = $('crop-hint');
    if (node.naturalWidth || node.videoWidth) return;
    if (hint && !/did not load/.test(hint.textContent)) hint.textContent += '  (the picture did not load on this device)';
  }, 1800);
  $('crop-title').textContent = isAvatar ? 'Crop profile image' : 'Crop background';
  stage.classList.toggle('circle', isAvatar);
  const frame = isAvatar ? 1 : window.innerWidth / Math.max(1, window.innerHeight);
  cropState = {
    kind,
    node,
    frame,
    fit: isAvatar ? 'cover' : (saved.fit === 'contain' ? 'contain' : 'cover'),
    fx: saved.fx == null ? 0 : Number(saved.fx),
    fy: saved.fy == null ? 0 : Number(saved.fy),
    z: saved.z == null ? 1 : Math.max(1, Number(saved.z)),
  };
  // Show the picture at its own shape, so nothing is hidden from the start.
  const setStage = () => {
    const nw = node.naturalWidth || node.videoWidth || 0;
    const nh = node.naturalHeight || node.videoHeight || 0;
    // Sized inline, in pixels: the avatar stage is a square that always fits the
    // window, so the round crop window is a circle and the save/cancel buttons
    // can never end up below the screen. A wide picture keeps its own shape on
    // the background cropper only.
    if (isAvatar) {
      stage.style.aspectRatio = '1 / 1';
      cropState.frame = 1;
    } else if (nw && nh) {
      stage.style.aspectRatio = `${nw} / ${nh}`;
      // Fill uses the window-shaped frame; fit uses the picture's own shape,
      // so the crop frame is the whole picture and nothing is cut off.
      cropState.frame = cropState.fit === 'contain' ? nw / nh : window.innerWidth / Math.max(1, window.innerHeight);
    }
    syncCropFitUi();
    schedulePaint();
  };
  cropState.refreshStage = setStage;
  setStage();
  node.addEventListener('load', setStage);
  node.addEventListener('loadedmetadata', setStage);
  const dlg = $('crop-dialog');
  // Always leave a way out: the dialog scrolls, Escape closes it, and closing it
  // for any reason (not just the buttons) drops the crop state.
  dlg.style.maxHeight = '92vh';
  dlg.style.overflow = 'auto';
  if (!dlg.__wired) {
    dlg.__wired = true;
    dlg.addEventListener('close', () => { cropState = null; });
    // Escape has to work on the fallback overlay too, where there is no native
    // dialog behaviour to close it.
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && $('crop-dialog') && $('crop-dialog').classList.contains('cropper-open')) {
        ev.preventDefault();
        closeCropper();
      }
    });
  }
  if (!dlg.open && !dlg.classList.contains('cropper-open')) showCropDialog(dlg);
}

/* <dialog> + showModal is patchy on older mobile browsers and embedded
 * webviews. Where it does not work the crop dialog simply never appeared - the
 * click looked like it did nothing. Fall back to a plain fixed overlay, and
 * verify afterwards that the dialog is really on screen. */
function showCropDialog(dlg) {
  let modal = false;
  try {
    if (typeof dlg.showModal === 'function') { dlg.showModal(); modal = dlg.open === true; }
  } catch { modal = false; }
  dlg.classList.add('cropper-open');
  document.body.classList.add('modal-open');
  if (!modal) {
    dlg.setAttribute('open', '');
    dlg.classList.add('cropper-forced');
    return;
  }
  // Supported, but check it landed somewhere visible: if not, force the overlay.
  requestAnimationFrame(() => {
    const r = dlg.getBoundingClientRect();
    const h = window.innerHeight || 0;
    if (!r.width || !r.height || r.bottom < 8 || (h && r.top > h)) dlg.classList.add('cropper-forced');
  });
}

function closeCropper() {
  cropState = null;
  const dlg = $('crop-dialog');
  if (dlg && dlg.open) dlg.close();
  if (dlg) {
    dlg.classList.remove('cropper-open', 'cropper-forced');
    dlg.removeAttribute('open');
  }
  // A leftover Escape-opened state used to leave the dialog modal-blocking the
  // page with nothing clickable behind it.
  document.body.classList.remove('modal-open');
}

function saveCrop() {
  if (!cropState) return closeCropper();
  const crop = {
    v: 2,
    fit: cropState.fit === 'contain' ? 'contain' : 'cover',
    fx: Math.round(cropState.fx * 100) / 100,
    fy: Math.round(cropState.fy * 100) / 100,
    z: Math.round(cropState.z * 100) / 100,
  };
  if (cropState.kind === 'avatar') SET.avatarCrop = crop; else SET.bgCrop = crop;
  closeCropper();
  saveSettings();   // applySettings re-renders the background and every avatar
  toast('Crop saved');
}

(function wireCropper() {
  const stage = $('crop-stage');
  if (!stage) return;
  let dragging = null;
  stage.addEventListener('pointerdown', (e) => {
    if (!cropState) return;
    dragging = { x: e.clientX, y: e.clientY };
    stage.classList.add('dragging');
    try { stage.setPointerCapture(e.pointerId); } catch { /* not fatal */ }
    e.preventDefault();
  });
  stage.addEventListener('pointermove', (e) => {
    if (!dragging || !cropState) return;
    cropDrag(e.clientX - dragging.x, e.clientY - dragging.y);
    dragging = { x: e.clientX, y: e.clientY };
  });
  const endDrag = () => { dragging = null; stage.classList.remove('dragging'); };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('wheel', (e) => {
    if (!cropState || cropState.fit === 'contain') return;
    e.preventDefault();
    const z = cropState.z * (e.deltaY > 0 ? 0.92 : 1.08);
    cropState.z = Math.max(1, Math.min(6, z));
    paintCrop();
  }, { passive: false });
  $('crop-zoom').oninput = (e) => { if (cropState) { cropState.z = Number(e.target.value) || 1; paintCrop(); } };
  $('crop-x').oninput = (e) => { if (cropState) { cropState.fx = Number(e.target.value); paintCrop(); } };
  $('crop-y').oninput = (e) => { if (cropState) { cropState.fy = Number(e.target.value); paintCrop(); } };
  $('crop-reset').onclick = () => {
    if (!cropState) return;
    cropState.fx = 0; cropState.fy = 0; cropState.z = 1;
    paintCrop();
  };
  $('crop-fit-cover').onclick = () => setCropFit('cover');
  $('crop-fit-contain').onclick = () => setCropFit('contain');
  $('crop-cancel').onclick = closeCropper;
  $('crop-save').onclick = saveCrop;
  // A close event is queued, not immediate, so one from an earlier close can
  // land after the dialog was reopened - only clear the state when the dialog
  // is really shut, or the fresh cropper would go dead.
  $('crop-dialog').addEventListener('close', () => {
    if (!$('crop-dialog').open) cropState = null;
  });
})();
