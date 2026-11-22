/*
 * A tiny DeepSeek desk pet, inspired by deepseek-harness-pets (MIT):
 * https://github.com/orxz/deepseek-harness-pets
 *
 * The upstream project is a Petdex skin host for a different UI. This is the
 * same idea for the WebUI: a fixed, draggable whale that reacts to the agent's
 * turn without touching the transcript. It is deliberately dependency-free and
 * opt-in (Settings > Fun > Desktop pet).
 */
'use strict';

/* Official DeepSeek whale path (viewBox 0 0 300 300); see the upstream
 * project's pet-art.js. Kept here as an inline SVG so the pet works offline. */
const PET_WHALE_PATH = "M195,166.1c-2.4,1-4.9,1.8-7.2,1.9-3.6.2-7.6-1.3-9.7-3.1-3.3-2.8-5.7-4.4-6.7-9.2-.4-2.1-.2-5.3.2-7.2.9-4-.1-6.5-2.9-8.9-2.3-1.9-5.2-2.4-8.4-2.4s-2.3-.5-3.1-1c-1.3-.7-2.4-2.3-1.4-4.4.3-.7,2-2.3,2.3-2.5,4.3-2.5,9.4-1.7,14,.2,4.3,1.7,7.5,5,12.2,9.5,4.8,5.5,5.6,7,8.4,11.1,2.1,3.2,4.1,6.6,5.4,10.4.8,2.4-.2,4.3-3.1,5.5ZM157.1,146.7c0-2.1,1.7-3.7,3.8-3.7s.9.1,1.3.2c.5.2,1,.5,1.4.9.7.7,1.1,1.6,1.1,2.6,0,2.1-1.7,3.8-3.8,3.8s-3.7-1.7-3.7-3.8ZM144.9,225.2c-25.5-20-37.8-26.6-42.9-26.3-4.8.3-3.9,5.7-2.8,9.3,1.1,3.5,2.5,5.9,4.5,9,1.4,2,2.3,5.1-1.4,7.3-8.2,5.1-22.5-1.7-23.1-2-16.6-9.8-30.5-22.7-40.2-40.3-9.5-17-14.9-35.2-15.8-54.6-.2-4.7,1.1-6.4,5.8-7.2,6.2-1.1,12.5-1.4,18.7-.5,26,3.8,48.1,15.4,66.7,33.8,10.6,10.5,18.6,23,26.8,35.2,8.8,13,18.2,25.4,30.2,35.5,4.3,3.6,7.6,6.3,10.9,8.2-9.8,1.1-26.1,1.3-37.2-7.5ZM293.2,60.4c-3.1-1.5-4.4,1.4-6.3,2.8-.6.5-1.1,1.1-1.7,1.7-4.5,4.8-9.8,8-16.8,7.6-10.1-.6-18.7,2.6-26.4,10.4-1.6-9.5-7-15.2-15.2-18.9-4.3-1.9-8.6-3.8-11.6-7.9-2.1-2.9-2.7-6.2-3.7-9.4-.7-2-1.3-3.9-3.6-4.3-2.4-.4-3.4,1.7-4.3,3.4-3.8,7-5.3,14.6-5.2,22.4.3,17.5,7.7,31.5,22.4,41.4,1.7,1.1,2.1,2.3,1.6,3.9-1,3.4-2.2,6.7-3.3,10.1-.7,2.2-1.7,2.7-4,1.7-8.1-3.4-15-8.4-21.2-14.4-10.4-10.1-19.9-21.2-31.6-30-2.8-2.1-5.5-4-8.4-5.7-12-11.7,1.6-21.3,4.7-22.4,3.3-1.2,1.2-5.3-9.5-5.2-10.6,0-20.3,3.6-32.8,8.4-1.8.7-3.7,1.2-5.7,1.7-11.3-2.1-22.9-2.6-35.1-1.2-23,2.5-41.4,13.4-54.8,32C4.7,110.7.9,136,5.6,162.4c4.9,27.8,19.1,50.9,41,68.9,22.6,18.7,48.7,27.8,78.5,26.1,18.1-1,38.2-3.5,60.9-22.7,5.7,2.8,11.7,4,21.7,4.8,7.7.7,15.1-.4,20.8-1.5,9-1.9,8.4-10.2,5.1-11.7-26.3-12.3-20.5-7.3-25.7-11.3,13.3-15.8,33.5-32.2,41.3-85.4.6-4.2.1-6.9,0-10.3,0-2.1.4-2.9,2.8-3.1,6.6-.8,13-2.6,18.8-5.8,17-9.3,23.9-24.6,25.5-42.9.2-2.8,0-5.7-3-7.2Z";

const PET_STATES = new Set(['idle', 'loading', 'inferring', 'scoring', 'done', 'sota', 'error', 'click', 'fidget', 'run-left', 'run-right', 'jumping']);
const PET_STATE_TEXT = {
  idle: '',
  loading: 'Loading…',
  inferring: 'Inferring…',
  scoring: 'Reviewing…',
  done: 'Done!',
  sota: 'SOTA!',
  error: '[ERROR]',
};
const PET_CLICK_TEXT = ['Yay!', 'Got it!', 'Splash!', 'Blub~'];
const PET_FIDGET_TEXT = ['Just swimming by~', 'Nap time…', 'Wheee!'];
const PET_POSITION_KEY = 'piwebui-pet-position';
let petEl = null;
let petArt = null;
let petBubble = null;
let petBaseState = 'idle';
let petTransient = null;
let petTransientTimer = null;
let petStateTimer = null;
let petHovered = false;
let petDrag = null;
let petSavedPosition = null;
let petLibrary = new Map();
let petLibraryLoaded = false;
let petLibraryPromise = null;
let petCurrentSkinKey = null;
let petSpriteTimer = null;
let petSpriteStartedAt = 0;
let petPaintedState = null;
let petLastResults = [];
let petWanderTimer = null;
let petWanderMoveTimer = null;

const PET_SPRITE_ROWS = Object.freeze({
  idle: 0, loading: 6, inferring: 7, scoring: 8, done: 3,
  sota: 4, error: 5, click: 4, fidget: 3,
  'run-left': 2, 'run-right': 1, jumping: 4,
});
/* Petdex's native frame timing (petdex-desktop-native/src/sprite.zig). Frames
 * are not uniformly spaced: idle holds its first and last cell much longer, and
 * the jumping/waving rows have a deliberate settle at the end. Using a single
 * fps per row made every row except idle look too fast. */
const PET_ROW_DURATIONS = Object.freeze([
  [280, 110, 110, 140, 140, 320],                         // idle
  [120, 120, 120, 120, 120, 120, 120, 220],              // running-right
  [120, 120, 120, 120, 120, 120, 120, 220],              // running-left
  [140, 140, 140, 280],                                   // waving
  [140, 140, 140, 140, 280],                               // jumping
  [140, 140, 140, 140, 140, 140, 140, 240],              // failed
  [150, 150, 150, 150, 150, 260],                          // waiting
  [120, 120, 120, 120, 120, 220],                          // running
  [150, 150, 150, 150, 150, 280],                          // review
]);
const PET_NATIVE_COUNTS = Object.freeze([6, 8, 8, 4, 5, 8, 6, 6, 6]);
const PET_FRAME_FALLBACK_MS = 150;
/* One Petdex cell is 192x208 on a 1536-wide sheet (8 columns). The cell is
 * drawn at its own size and the element is zoomed to the chosen pet size;
 * scaling the *sheet* instead is what let a fractional size sample across a
 * cell boundary and show a sliver of the next sprite (issue #278). */
const PET_CELL_W = 192;
const PET_CELL_H = 208;
const PET_SHEET_W = PET_CELL_W * 8;
let petSpriteCellW = PET_CELL_W;
let petSpriteCellH = PET_CELL_H;

function petFrameAt(elapsedMs, row, count) {
  const table = PET_ROW_DURATIONS[row] || [];
  let total = 0;
  for (let i = 0; i < count; i++) total += table[i] ?? PET_FRAME_FALLBACK_MS;
  if (!total) return 0;
  let t = Math.max(0, elapsedMs) % total;
  for (let i = 0; i < count; i++) {
    const d = table[i] ?? PET_FRAME_FALLBACK_MS;
    if (t < d) return i;
    t -= d;
  }
  return count - 1;
}

function petSizePx() {
  return Math.max(64, Math.min(160, Number(SET.petSize) || 96));
}

function petClamp(x, y, size = petSizePx()) {
  const margin = 8;
  return {
    x: Math.max(margin, Math.min(x, window.innerWidth - size - margin)),
    y: Math.max(margin, Math.min(y, window.innerHeight - size - margin)),
  };
}

function petReadPosition() {
  try {
    const d = JSON.parse(localStorage.getItem(PET_POSITION_KEY) || 'null');
    if (d && Number.isFinite(d.x) && Number.isFinite(d.y)) return { x: d.x, y: d.y };
  } catch { /* private mode / bad old value */ }
  return null;
}

function petStorePosition(pos) {
  petSavedPosition = pos;
  try { localStorage.setItem(PET_POSITION_KEY, JSON.stringify(pos)); } catch { /* private mode / quota */ }
}

function petApplyPosition() {
  if (!petEl) return;
  if (!petSavedPosition) {
    petEl.style.left = '';
    petEl.style.top = '';
    petEl.style.right = '24px';
    petEl.style.bottom = '24px';
    return;
  }
  const p = petClamp(petSavedPosition.x, petSavedPosition.y);
  petSavedPosition = p;
  petEl.style.left = p.x + 'px';
  petEl.style.top = p.y + 'px';
  petEl.style.right = 'auto';
  petEl.style.bottom = 'auto';
}

function petCreate() {
  if (petEl) return;
  petSavedPosition = petReadPosition();
  petEl = el('div', 'pet-overlay hidden');
  petEl.id = 'pet-overlay';
  petEl.tabIndex = 0;
  petEl.setAttribute('role', 'button');
  petEl.setAttribute('aria-label', 'DeepSeek desk pet. Click for a reaction, drag to move.');
  petBubble = el('span', 'pet-bubble hidden');
  petArt = el('div', 'pet-art');
  petEl.append(petBubble, petArt);
  document.body.appendChild(petEl);

  petEl.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    petCancelWander();
    const r = petEl.getBoundingClientRect();
    petDrag = { sx: e.clientX, sy: e.clientY, left: r.left, top: r.top, moved: false };
    petEl.classList.add('dragging');
    try { petEl.setPointerCapture(e.pointerId); } catch { /* synthetic / already released */ }
  });
  petEl.addEventListener('pointermove', (e) => {
    if (!petDrag) return;
    const dx = e.clientX - petDrag.sx;
    const dy = e.clientY - petDrag.sy;
    if (!petDrag.moved && Math.hypot(dx, dy) < 5) return;
    petDrag.moved = true;
    const p = petClamp(petDrag.left + dx, petDrag.top + dy);
    petEl.style.left = p.x + 'px';
    petEl.style.top = p.y + 'px';
    petEl.style.right = 'auto';
    petEl.style.bottom = 'auto';
  });
  const endDrag = (e) => {
    if (!petDrag) return;
    const moved = petDrag.moved;
    petDrag = null;
    petEl.classList.remove('dragging');
    try { petEl.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (moved) {
      const r = petEl.getBoundingClientRect();
      petStorePosition(petClamp(r.left, r.top));
    } else {
      petTransientState('click', 1200);
    }
    petScheduleWander();
  };
  petEl.addEventListener('pointerup', endDrag);
  petEl.addEventListener('pointercancel', (e) => {
    petDrag = null;
    petEl.classList.remove('dragging');
    try { petEl.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  });
  petEl.addEventListener('pointerenter', () => { petHovered = true; petPaint(); });
  petEl.addEventListener('pointerleave', () => { petHovered = false; petPaint(); });
  petEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    petTransientState('click', 1200);
  });
  window.addEventListener('resize', () => {
    if (petSavedPosition) { petApplyPosition(); petStorePosition(petSavedPosition); }
  });
  petApplyPosition();
  petApplySkin();
}

/* ── Petdex library ──────────────────────────────────────────────────────
 * Search is served by this bridge (the Petdex JSON API has no CORS headers);
 * the sprite file is downloaded to the bridge's agent dir and served back from
 * /api/pet-file. The picker therefore still works after a reload and offline. */
function petSkinRows(entry) {
  return entry && entry.spriteVersionNumber === 2 ? 11 : 9;
}

function petStopSprite() {
  if (petSpriteTimer) { clearInterval(petSpriteTimer); petSpriteTimer = null; }
}

/* Petdex pets are not statues: the rows after idle are running-left,
 * running-right and jumping. Let the pet wander around the viewport when it is
 * idle, using the direction row while it moves and a hop now and then. */
function petCancelWander() {
  if (petWanderTimer) { clearTimeout(petWanderTimer); petWanderTimer = null; }
  if (petWanderMoveTimer) { clearTimeout(petWanderMoveTimer); petWanderMoveTimer = null; }
  if (petEl) {
    petEl.classList.remove('wandering');
    petEl.style.transitionDuration = '';
  }
  if (petTransient === 'run-left' || petTransient === 'run-right' || petTransient === 'jumping') {
    petTransient = null;
    petPaint();
  }
}

function petScheduleWander(delay) {
  if (petWanderTimer) { clearTimeout(petWanderTimer); petWanderTimer = null; }
  if (SET.petEnabled !== true) return;
  const ms = delay == null ? 12000 + Math.random() * 18000 : delay;
  petWanderTimer = setTimeout(petWander, ms);
}

function petVisibleForWander() {
  return SET.petEnabled === true && petEl && !petEl.classList.contains('hidden')
    && !petDrag && petBaseState === 'idle' && !petTransient
    && document.visibilityState === 'visible'
    && !document.querySelector('dialog[open]');
}

function petWander() {
  petWanderTimer = null;
  if (!petVisibleForWander()) { petScheduleWander(); return; }
  const size = petSizePx();
  const target = petClamp(8 + Math.random() * (window.innerWidth - size - 16), 8 + Math.random() * (window.innerHeight - size - 16));
  const r = petEl.getBoundingClientRect();
  const dx = target.x - r.left;
  const dy = target.y - r.top;
  const dist = Math.hypot(dx, dy);
  if (dist < 30) {
    petTransientState('jumping', 900);
    petScheduleWander(9000 + Math.random() * 12000);
    return;
  }
  // The default position is right/bottom CSS, which has no left/top transition
  // start. Pin the current pixel position first, then move to the target.
  petEl.style.left = r.left + 'px';
  petEl.style.top = r.top + 'px';
  petEl.style.right = 'auto';
  petEl.style.bottom = 'auto';
  petEl.classList.add('wandering');
  const ms = Math.max(650, Math.min(3200, (dist / 160) * 1000));
  petEl.style.transitionDuration = `${ms}ms`;
  petTransient = dx >= 0 ? 'run-right' : 'run-left';
  petSpriteStartedAt = Date.now();
  petPaint();
  requestAnimationFrame(() => {
    if (!petEl || !petTransient || !petEl.classList.contains('wandering')) return;
    petEl.style.left = target.x + 'px';
    petEl.style.top = target.y + 'px';
  });
  petWanderMoveTimer = setTimeout(() => {
    petWanderMoveTimer = null;
    if (!petEl) return;
    petEl.classList.remove('wandering');
    petEl.style.transitionDuration = '';
    const r2 = petEl.getBoundingClientRect();
    petStorePosition(petClamp(r2.left, r2.top));
    if (petTransient === 'run-left' || petTransient === 'run-right') petTransient = null;
    petPaint();
    // Sometimes celebrate arriving with a hop instead of going straight back
    // to idle. The jump row exists on every Petdex sheet.
    if (Math.random() < 0.3) petTransientState('jumping', 900);
    else petScheduleWander();
  }, ms + 120);
}

function petApplySkin() {
  if (!petEl || !petArt) return;
  const entry = petLibrary.get(SET.petSlug || 'builtin') || null;
  const key = (entry ? entry.slug : 'builtin') + '|' + (entry ? entry.url : '');
  if (petCurrentSkinKey === key) { petPaint(); return; }
  petCurrentSkinKey = key;
  petStopSprite();
  if (!entry) {
    petEl.dataset.kind = 'whale';
    petArt.innerHTML = `<svg viewBox="0 0 300 300" aria-hidden="true"><path d="${PET_WHALE_PATH}" /></svg>`;
    petPaint();
    return;
  }
  const rows = petSkinRows(entry);
  petEl.dataset.kind = 'sprite';
  const sprite = el('div', 'pet-sprite');
  sprite.dataset.rows = String(rows);
  sprite.style.backgroundImage = `url("${String(entry.url).replace(/"/g, '%22')}")`;
  /* The cell is drawn at its native size and the whole layer is zoomed (see
   * .pet-sprite): forcing a square cell with a percentage background-size
   * resamples the sheet, and a fractional size can then pick a pixel from the
   * neighbouring frame - a hat tip or a braid from the next sprite, for some
   * frames only (issue #278).
   *
   * Width-only sizing keeps the sheet's own aspect, so a 9-row v1 sheet and an
   * 11-row v2 sheet both land every row on its true 208px offset. */
  sprite._cellW = PET_CELL_W;
  sprite._cellH = PET_CELL_H;
  sprite.style.backgroundSize = `${PET_SHEET_W}px auto`;
  sprite.style.backgroundPosition = '0px 0px';
  petSpriteCellW = PET_CELL_W;
  petSpriteCellH = PET_CELL_H;
  petArt.replaceChildren(sprite);
  petSpriteStartedAt = Date.now();
  /* Petdex sheets use an 8-column grid, but a row may only use the first 4-6
   * columns (idle, waving, jumping and review do on the published DeepSeek
   * pet). Looping all 8 therefore showed two blank cells and made the pet
   * flicker/ disappear. Measure each row from the sheet itself instead of
   * assuming every row is full; the canvas is same-origin through
   * /api/pet-file, so its pixels are readable. */
  // Stay on the first frame until the sheet has been measured: assuming all
  // eight columns before that is what showed the blank cells for a moment.
  sprite._frameCounts = PET_NATIVE_COUNTS.slice(0, rows);
  const img = new Image();
  img.onload = () => {
    try {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      const px = g.getImageData(0, 0, c.width, c.height).data;
      const fw = c.width / 8;
      const fh = c.height / rows;
      const counts = [];
      for (let row = 0; row < rows; row++) {
        let last = 0;
        for (let col = 0; col < 8; col++) {
          let ink = false;
          const x0 = Math.floor(col * fw);
          const y0 = Math.floor(row * fh);
          const x1 = Math.floor((col + 1) * fw);
          const y1 = Math.floor((row + 1) * fh);
          // Sample every other pixel; enough to distinguish a blank cell from
          // an occupied one without walking a 2 MB sheet one byte at a time.
          for (let y = y0; y < y1 && !ink; y += 2) {
            for (let x = x0; x < x1; x += 2) {
              if (px[(y * c.width + x) * 4 + 3] > 8) { ink = true; break; }
            }
          }
          if (ink) last = col + 1;
        }
        counts.push(Math.max(1, last));
      }
      sprite._frameCounts = counts;
      sprite.dataset.frameCounts = counts.join(',');
      /* Petdex accepts scaled sheets as long as the 8 x rows grid stays on
       * whole cells. Follow the sheet's own cell size so nothing is resampled
       * across a boundary; canonical 1536-wide sheets keep 192x208. */
      if (Number.isFinite(img.naturalWidth) && img.naturalWidth > 0 && Number.isFinite(img.naturalHeight) && img.naturalHeight > 0) {
        const cw = img.naturalWidth / 8;
        const ch = img.naturalHeight / rows;
        if (cw > 0 && ch > 0) {
          sprite._cellW = cw;
          sprite._cellH = ch;
          sprite.style.width = `${cw}px`;
          sprite.style.height = `${ch}px`;
          sprite.style.backgroundSize = `${img.naturalWidth}px auto`;
          // A slower load from a skin the user has already left must not resize
          // the pet that replaced it.
          if (petArt.querySelector('.pet-sprite') === sprite) {
            petSpriteCellW = cw;
            petSpriteCellH = ch;
            petPaint();   // the zoom is relative to the cell width
          }
        }
      }
      petSpriteStartedAt = Date.now();
    } catch { /* canvas unavailable or image not readable: keep the 8-frame fallback */ }
  };
  img.onerror = () => { /* keep frame 0 */ };
  img.src = entry.url;
  petSpriteTimer = setInterval(() => {
    if (!petEl || petEl.classList.contains('hidden')) return;
    const state = petTransient || petBaseState;
    const row = PET_SPRITE_ROWS[state] || 0;
    const count = Math.max(1, sprite._frameCounts?.[row] || PET_NATIVE_COUNTS[row] || 6);
    const frame = petFrameAt(Date.now() - petSpriteStartedAt, row, count);
    // Exact whole-cell offsets, not percentages: a percentage is resolved
    // against the free space in floats and can land a fraction of a pixel off
    // the boundary, which is what sampled the neighbouring frame.
    const cellW = sprite._cellW || petSpriteCellW;
    const cellH = sprite._cellH || petSpriteCellH;
    sprite.style.backgroundPosition = `${-frame * cellW}px ${-row * cellH}px`;
  }, 40);
  petPaint();
}

function renderPetSkinOptions() {
  const sel = $('set-pet-skin');
  if (!sel) return;
  const wanted = SET.petSlug || 'builtin';
  sel.replaceChildren();
  const builtin = el('option', null, 'DeepSeek whale (built-in)');
  builtin.value = 'builtin';
  sel.appendChild(builtin);
  for (const p of [...petLibrary.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    const o = el('option', null, `${p.name} (Petdex)`);
    o.value = p.slug;
    sel.appendChild(o);
  }
  if (!petLibrary.has(wanted)) SET.petSlug = 'builtin';
  sel.value = SET.petSlug || 'builtin';
  if (typeof prettifySettingsSelects === 'function') prettifySettingsSelects();
}

function loadPetLibrary(force) {
  if (petLibraryPromise) return petLibraryPromise;
  if (petLibraryLoaded && !force) { renderPetSkinOptions(); return Promise.resolve(petLibrary); }
  petLibraryPromise = fetch(api('/api/pets'), { cache: 'no-store' })
    .then((r) => r.json().then((d) => {
      if (!r.ok) throw new Error(d.error || `library returned ${r.status}`);
      petLibrary = new Map((Array.isArray(d.pets) ? d.pets : []).map((p) => [p.slug, p]));
      petLibraryLoaded = true;
      renderPetSkinOptions();
      petApplySkin();
      return petLibrary;
    }))
    .catch((e) => {
      petLibraryLoaded = false;
      throw e;
    })
    .finally(() => { petLibraryPromise = null; });
  return petLibraryPromise;
}

function petResultRow(p) {
  const row = el('div', 'pet-result');
  const thumb = el('div', 'pet-thumb');
  const rows = p.spriteVersionNumber === 2 ? 11 : 9;
  thumb.style.backgroundImage = `url("${String(p.spritesheetPath || '').replace(/"/g, '%22')}")`;
  thumb.style.backgroundSize = `800% ${rows * 100}%`;
  const info = el('div', 'pet-result-info');
  info.append(el('div', 'pet-result-name', p.displayName || p.slug), el('div', 'pet-result-desc', p.description || ''));
  const btn = el('button', 'btn small', petLibrary.has(p.slug) ? 'installed' : 'download');
  btn.disabled = petLibrary.has(p.slug);
  btn.onclick = () => petDownload(p, btn);
  row.append(thumb, info, btn);
  return row;
}

function renderPetResults(pets) {
  petLastResults = Array.isArray(pets) ? pets : [];
  const host = $('pet-results');
  if (!host) return;
  host.replaceChildren();
  if (!petLastResults.length) {
    host.appendChild(el('div', 'pet-empty', 'no pets found — try another search'));
    return;
  }
  for (const p of petLastResults) host.appendChild(petResultRow(p));
}

async function petSearch() {
  const input = $('pet-search');
  const btn = $('btn-pet-search');
  if (!input || !btn) return;
  const q = input.value.trim();
  if (!q) { toast('Type a pet name or vibe to search Petdex', 'warning'); return; }
  btn.disabled = true;
  btn.textContent = 'searching…';
  try {
    const r = await fetch(api(`/api/petdex-search?q=${encodeURIComponent(q)}`));
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `search returned ${r.status}`);
    renderPetResults(d.pets || []);
    if (!d.pets || !d.pets.length) toast(`No Petdex pets matched “${q}”`, 'warning');
  } catch (e) {
    toast(`Petdex search failed: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'search';
  }
}

async function petDownload(p, btn) {
  btn.disabled = true;
  btn.textContent = 'downloading…';
  try {
    const r = await fetch(api('/api/pets/download'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(p),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || `download returned ${r.status}`);
    // Select it before the library reloads so the refreshed option list marks
    // the new pet as the chosen skin in the same pass.
    SET.petSlug = p.slug;
    await loadPetLibrary(true);
    renderPetSkinOptions();
    saveSettings();
    petApplySkin();
    renderPetResults(petLastResults);
    toast(`Downloaded ${p.displayName || p.slug} — selected as your pet`);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'download';
    toast(`Could not download that pet: ${e.message}`, 'error');
  }
}

function petBubbleForState() {
  // The reaction lines are written for the bundled DeepSeek whale. Downloaded
  // Petdex characters have their own identities, so do not put words in their
  // mouths; their sprite already carries the expression.
  if ((SET.petSlug || 'builtin') !== 'builtin') return '';
  if (petHovered) return 'Hm?';
  if (petTransient === 'click') return PET_CLICK_TEXT[Math.floor(Math.random() * PET_CLICK_TEXT.length)];
  if (petTransient === 'fidget') return PET_FIDGET_TEXT[Math.floor(Math.random() * PET_FIDGET_TEXT.length)];
  return PET_STATE_TEXT[petBaseState] || '';
}

function petPaint() {
  if (!petEl) return;
  petEl.style.setProperty('--pet-size', `${petSizePx()}px`);
  // The sprite cell is drawn at its native width (192px for a canonical
  // Petdex sheet) and the layer is zoomed, so the chosen pet size never
  // resamples the sheet inside a cell.
  petEl.style.setProperty('--pet-zoom', String(petSizePx() / (petSpriteCellW || PET_CELL_W)));
  const state = petTransient || petBaseState;
  petEl.dataset.state = state;
  if (state !== petPaintedState) { petPaintedState = state; petSpriteStartedAt = Date.now(); }
  if (petBubble) {
    const text = petBubbleForState();
    petBubble.textContent = text;
    petBubble.classList.toggle('hidden', !text);
  }
}

function petClearStateTimer() {
  if (petStateTimer) { clearTimeout(petStateTimer); petStateTimer = null; }
}

function petSetState(state) {
  if (!PET_STATES.has(state)) state = 'idle';
  if (state !== 'idle' && (petTransient === 'run-left' || petTransient === 'run-right' || petTransient === 'jumping')) {
    petCancelWander();
  }
  petBaseState = state;
  petTransient = null;
  if (petTransientTimer) { clearTimeout(petTransientTimer); petTransientTimer = null; }
  petClearStateTimer();
  // Finished/error states get a moment to be seen, then the pet goes back to
  // idling. Loading/inferring/scoring stay until the next agent event.
  if (state === 'done' || state === 'sota' || state === 'error') {
    petStateTimer = setTimeout(() => {
      petStateTimer = null;
      if (!S.isStreaming) { petBaseState = 'idle'; petPaint(); }
    }, 3000);
  }
  if (SET.petEnabled) petPaint();
  if (state === 'idle') petScheduleWander();
}

function petTransientState(state, ms) {
  if (!PET_STATES.has(state)) return;
  if (state !== 'run-left' && state !== 'run-right' && state !== 'jumping') petCancelWander();
  petTransient = state;
  if (petTransientTimer) clearTimeout(petTransientTimer);
  petTransientTimer = setTimeout(() => {
    petTransientTimer = null;
    petTransient = null;
    petPaint();
    if (petBaseState === 'idle') petScheduleWander();
  }, ms);
  if (SET.petEnabled) petPaint();
}

function petNoteTool(name) {
  const n = String(name || '');
  petSetState(/(?<![a-z0-9])(report|summary|score|scoring|grade|eval(?:uate|uation)?)(?![a-z0-9])/i.test(n) ? 'scoring' : 'inferring');
}

function petNoteText(text) {
  if (/(?<![a-z0-9])(sota|new high|record high|new record)(?![a-z0-9])/i.test(String(text || ''))) {
    petSetState('sota');
  }
}

function syncPetOptionVisibility() {
  const on = SET.petEnabled === true;
  for (const el of document.querySelectorAll('[data-pet-option]')) el.classList.toggle('hidden', !on);
}

function applyPetSettings() {
  syncPetOptionVisibility();
  if (SET.petEnabled !== true) {
    petCancelWander();
    if (petEl) petEl.classList.add('hidden');
    petCurrentSkinKey = null; // re-enabling must rebuild/restart a downloaded sprite
    petStopSprite();
    petClearStateTimer();
    if (petTransientTimer) { clearTimeout(petTransientTimer); petTransientTimer = null; }
    return;
  }
  petCreate();
  petEl.classList.remove('hidden');
  petApplyPosition();
  if (!petLibraryLoaded) loadPetLibrary().catch(() => { /* built-in still works */ });
  petApplySkin();
  petPaint();
  petScheduleWander();
}

function petResetPosition() {
  petCancelWander();
  petSavedPosition = null;
  try { localStorage.removeItem(PET_POSITION_KEY); } catch { /* private mode */ }
  petApplyPosition();
  petScheduleWander();
}

if ($('set-pet-enabled')) {
  $('set-pet-enabled').onchange = (e) => {
    SET.petEnabled = e.target.checked;
    saveSettings();
    applyPetSettings();
  };
}
if ($('set-pet-size')) {
  $('set-pet-size').oninput = (e) => {
    SET.petSize = parseInt(e.target.value, 10) || 96;
    $('set-pet-size-val').textContent = `${SET.petSize}px`;
    applyPetSettings();
  };
  $('set-pet-size').onchange = () => saveSettings();
}
if ($('set-pet-skin')) {
  $('set-pet-skin').onchange = (e) => {
    SET.petSlug = e.target.value || 'builtin';
    saveSettings();
    petApplySkin();
    petPaint();
    if (SET.petSlug !== 'builtin') toast(`Pet skin: ${e.target.selectedOptions[0]?.textContent || SET.petSlug}`);
  };
}
if ($('btn-pet-refresh')) {
  $('btn-pet-refresh').onclick = () => {
    loadPetLibrary(true).then(() => toast('Pet library refreshed')).catch((e) => toast(`Could not refresh pets: ${e.message}`, 'error'));
  };
}
if ($('btn-pet-search')) $('btn-pet-search').onclick = () => petSearch().catch((e) => toast(e.message, 'error'));
if ($('pet-search')) {
  $('pet-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); petSearch().catch((err) => toast(err.message, 'error')); }
  });
}
if ($('btn-pet-reset')) {
  $('btn-pet-reset').onclick = () => { petResetPosition(); toast('Pet moved back to the corner'); };
}

/* A little idle fidget, only while the pet is visible and the agent is not
 * working. The upstream pet does the same; it keeps the corner from looking
 * like a static sticker. */
setInterval(() => {
  if (!petEl || petEl.classList.contains('hidden') || petBaseState !== 'idle' || petTransient || petHovered) return;
  petTransientState('fidget', 2200);
}, 35000);
