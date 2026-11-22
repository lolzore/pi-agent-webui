/*
 * Small media primitives shared by messages, avatars and the background:
 * image vs video, the element for a source, and releasing a decoder. Split out
 * of app.js (issue #263). Loaded before app.js; the names stay global.
 */
'use strict';

const VIDEO_SRC = /\.(mp4|webm|mov|m4v|ogv|mkv)([?#]|$)/i;
function isVideoSrc(src) {
  return /^data:video\//i.test(src || '') || VIDEO_SRC.test(src || '');
}

function mediaNode(src, cls) {
  if (!src) return null;
  let node;
  if (isVideoSrc(src)) {
    node = el('video', cls);
    // A background video is muted unless the user asked for its sound; browsers
    // block audible autoplay until the page has been interacted with, so that
    // case waits for the first click instead of playing silently forever.
    const wantsSound = cls === 'bg-node' && !!SET.bgAudio;
    node.muted = !wantsSound;
    node.volume = Math.max(0, Math.min(1, (SET.bgVolume == null ? 50 : Number(SET.bgVolume)) / 100));
    node.loop = true; node.autoplay = true; node.playsInline = true;
    node.setAttribute('playsinline', '');
    // A background picture is decoration. Without this the browser offers its
    // own menu on it - speed, sound, loop, "save video as" - which is useless
    // for a file the user picked locally, and it swallows the right-click that
    // should reach the page (spell-check suggestions included).
    node.controls = false;
    node.disablePictureInPicture = true;
    node.setAttribute('disablepictureinpicture', '');
    node.setAttribute('controlslist', 'nodownload noplaybackrate noremoteplayback');
    node.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); return false; };
    if (wantsSound) armBgAudioUnlock(node);
  } else {
    node = el('img', cls);
  }
  node.src = src;
  return node;
}

function releaseMedia(node) {
  if (!node || node.tagName !== 'VIDEO') return;
  try { node.pause(); } catch (e) { /* ignore */ }
  node.removeAttribute('src');
  try { node.load(); } catch (e) { /* ignore */ }
}

function releaseVideosIn(root) {
  if (!root || !root.querySelectorAll) return;
  root.querySelectorAll('video').forEach(releaseMedia);
}

/* Apply SET.themeBg to the page. Images, GIFs and videos all render as a real
 * element behind the app, so one code path (and one crop) covers all three -
 * a body background-image could not be zoomed or panned by hand. */
/* The accent, the outline colour and the avatar size: everything that gamer mode
 * (or a settings change) has to be able to put back on its own. */
function applyThemeColours() {
  const rootStyle = document.documentElement.style;
  // text outline: a 4-way shadow keeps glyphs readable when the panels are
  // translucent and the background image shows through.
  document.body.classList.toggle('text-outline', SET.textOutline !== false);
  rootStyle.setProperty('--outline-color', SET.textOutlineColor || '#000000');
  if (SET.themeAccent) {
    rootStyle.setProperty('--accent', SET.themeAccent);
    rootStyle.setProperty('--accent-dim', `color-mix(in srgb, ${SET.themeAccent} 35%, #171b22)`);
  } else {
    rootStyle.removeProperty('--accent');
    rootStyle.removeProperty('--accent-dim');
  }
}

function applyBackgroundMedia() {
  const host = $('bg-media');
  // Another instance brings its own background (its own file, served by its own
  // bridge) - showing this machine's picture behind another machine's chat was
  // the "background carries over" report. How it is shown (volume, crop applied)
  // stays this machine's preference.
  const look = instanceLook();
  const src = instanceMediaUrl(look.themeBg) || '';
  if (!host) return;
  const frame = window.innerWidth / Math.max(1, window.innerHeight);
  const current = host.querySelector('img, video');
  // Same source: keep the element. Rebuilding it restarted a background video
  // from the beginning every time any unrelated setting was saved.
  if (current && current.getAttribute('src') === src) {
    applyCrop(current, look.bgCrop, frame);
    applyBgAudio(current);
    return;
  }
  // If the element does have to be rebuilt, the video must not start over: keep
  // the playhead, the mute state and whether it was playing (a resize, a settings
  // save or a theme change used to send it back to the beginning, audio and all).
  const before = current && current.tagName === 'VIDEO'
    ? { at: current.currentTime, playing: !current.paused, muted: current.muted }
    : null;
  host.innerHTML = '';
  if (!src) { host.classList.add('hidden'); return; }
  const node = attachCrop(mediaNode(src, 'bg-node'), look.bgCrop, frame);
  if (before && node.tagName === 'VIDEO') {
    try { node.currentTime = before.at; } catch { /* not seekable yet */ }
    node.muted = before.muted;
    if (before.playing) node.addEventListener('loadeddata', () => node.play().catch(() => {}), { once: true });
  }
  node.onerror = () => toast(isVideoSrc(src) ? 'Background video failed to load' : 'Background image failed to load', 'error');
  host.appendChild(node);
  host.classList.remove('hidden');
}

/* Volume and mute live on the element, so changing them must not rebuild the
 * video (which would restart it from the beginning). */
function applyBgAudio(node) {
  if (!node || node.tagName !== 'VIDEO') return;
  node.volume = Math.max(0, Math.min(1, (SET.bgVolume == null ? 50 : Number(SET.bgVolume)) / 100));
  // `wantedPlay` is what the background *should* be doing, so the tab going
  // hidden can pause it and coming back can resume it without having to guess.
  node.dataset.wantedPlay = SET.bgAudio ? '1' : '0';
  // A background clip nobody is looking at is a decoder and a buffer for
  // nothing, so it is held while the tab is in the background and let go when
  // the tab comes back.
  if (document.visibilityState !== 'visible') { try { node.pause(); } catch { /* ignore */ } return; }
  if (!SET.bgAudio) { node.muted = true; return; }
  if (!node.muted && !node.paused) return;
  node.muted = false;
  node.play().catch(() => { node.muted = true; armBgAudioUnlock(node); });
}

/* Audible playback needs a user gesture: wait for the first click or key, then
 * unmute - the setting asked for sound, so it should actually be heard. */
function armBgAudioUnlock(node) {
  const unlock = () => {
    document.removeEventListener('pointerdown', unlock, true);
    document.removeEventListener('keydown', unlock, true);
    if (!SET.bgAudio) return;
    node.muted = false;
    node.play().catch(() => { /* still blocked; leave it muted */ });
  };
  document.addEventListener('pointerdown', unlock, true);
  document.addEventListener('keydown', unlock, true);
}

/* ── the tab icon ─────────────────────────────────────────────────────────
 * One frame, painted once.
 *
 * This used to repaint the icon every 250ms whenever the agent's picture was a
 * video or a GIF, on the theory that an animated avatar should animate in the
 * tab. It does not: a favicon is a single image as far as every browser is
 * concerned, so those four canvases a second bought nothing anybody could see.
 * What they did buy was a 64x64 canvas allocated and PNG-encoded four times a
 * second for the entire life of the page, plus a <video> that stayed in the
 * document decoding frames nobody looked at. The tab looks exactly the same
 * and the page goes quiet. */
let favIconPainted = false;
let defaultFaviconHref = null;

function updateFavicon() {
  const link = document.querySelector('link[rel="icon"]');
  if (!link) return;
  if (defaultFaviconHref == null) defaultFaviconHref = link.getAttribute('href') || '';
  const src = instanceMediaUrl(instanceLook().avatar) || '';
  if (src === S.favSource && (S.favNode || favIconPainted)) return;   // already showing it
  S.favSource = src;
  favIconPainted = false;
  if (S.favNode) { try { S.favNode.remove(); } catch { /* gone */ } S.favNode = null; }
  if (!src) { link.setAttribute('href', defaultFaviconHref); favIconPainted = true; return; }
  const media = mediaNode(src, 'fav-source');
  if (!media) return;
  // In the document, a few pixels off screen: a detached video never decodes a
  // frame, so there would be nothing to draw.
  const isVideo = media.tagName === 'VIDEO';
  if (isVideo) {
    media.muted = true;
    media.loop = false;
    media.autoplay = false;
    media.playsInline = true;
    // 'auto' and not 'metadata': a video stopped at metadata knows its size but
    // has decoded nothing, and drawing it then produces an empty canvas.
    media.preload = 'auto';
  }
  S.favNode = media;
  document.body.appendChild(media);

  /* Paint the icon from the first frame, and only if there *is* one.
   *
   * The failure this guards against is silent and total: a video that has its
   * dimensions but no decoded frame reports a perfectly good videoWidth, so the
   * draw goes ahead, paints nothing, and a fully transparent PNG replaces the
   * default icon - a black square in the tab that nothing ever repairs. Asking
   * the canvas whether it is actually empty is the only way to notice, because
   * the browser says nothing either way. */
  const paint = () => {
    try {
      const c = document.createElement('canvas');
      c.width = 64; c.height = 64;
      const g = c.getContext('2d');
      const w = media.naturalWidth || media.videoWidth || 0;
      const h = media.naturalHeight || media.videoHeight || 0;
      if (!w || !h) return false;
      // fills the square, cropped through the middle - like the avatar itself
      const sc = Math.max(64 / w, 64 / h);
      g.drawImage(media, (64 - w * sc) / 2, (64 - h * sc) / 2, w * sc, h * sc);
      // one opaque pixel is enough to know a frame really landed
      const px = g.getImageData(0, 0, 64, 64).data;
      let any = false;
      for (let i = 3; i < px.length; i += 4) { if (px[i]) { any = true; break; } }
      if (!any) return false;
      link.setAttribute('href', c.toDataURL('image/png'));
      favIconPainted = true;
      return true;
    } catch { return false; }
  };

  /* One attempt, with a few tries: decoding a frame is not instantaneous, and a
   * video only produces one once it has actually started. The icon is left
   * exactly as it was until a real frame exists, so a clip that will not decode
   * at all leaves the default icon rather than a black one. */
  let tries = 0;
  const giveUpAt = 6;
  const attempt = () => {
    if (S.favNode !== media) { drop(); return; }   // superseded by a newer avatar
    if (paint() || ++tries >= giveUpAt) {
      release();
      drop();
      return;
    }
    // a video that has metadata but no frame needs to be started before it will
    // decode one; muted, so this is allowed without a click
    if (isVideo && media.paused) media.play().catch(() => { /* retry below */ });
    setTimeout(attempt, 180);
  };
  const release = () => {
    if (S.favNode !== media) return;
    S.favNode = null;
    if (!isVideo) return;
    // a video element left in the document keeps its decoder and its decoded
    // frames alive for the rest of the session, and it is on screen for nobody
    try { media.pause(); media.removeAttribute('src'); media.load(); } catch { /* ignore */ }
  };
  /* Off the page as soon as there is nothing left to do with it - a <video> is a
   * decoder, and an <img> holding a GIF keeps animating. The timeout below is
   * only a backstop for a source that never resolves one way or the other. */
  const drop = () => { try { media.remove(); } catch { /* gone */ } };

  // The src is set when the node is built, so a decoded image (a data URL, a
  // small file) can already be there; a video usually needs the attempts above.
  if (!paint()) attempt();
  else { release(); drop(); }
  // and a backstop, for a source that never resolves one way or the other
  setTimeout(drop, giveUpAt * 180 + 900);
}

const avatarStillCache = new Map();   // src -> dataURL | 'pending' | 'failed'
const avatarStillPending = new Set();

/* The picture to show for `src`: the source itself for a normal image, a still
 * for a video (null until the capture finishes, so no <video> is ever created
 * for a message header). */
function avatarStillSrc(src) {
  if (!src) return null;
  if (!isVideoSrc(src)) return src;
  const hit = avatarStillCache.get(src);
  if (hit === 'failed') return null;
  if (hit && hit !== 'pending') return hit;
  if (!avatarStillPending.has(src)) captureAvatarStill(src);
  return null;
}

/* Decode one frame off-screen, draw it square (the crop frame's default shape)
 * and keep the PNG. Never hangs: a timeout falls back to a failed mark. */
function captureAvatarStill(src) {
  avatarStillPending.add(src);
  avatarStillCache.set(src, 'pending');
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  let settled = false;
  const finish = (ok) => {
    if (settled) return;
    settled = true;
    avatarStillPending.delete(src);
    if (ok) {
      try {
        const w = v.videoWidth || 96;
        const h = v.videoHeight || 96;
        const side = Math.max(1, Math.min(w, h));
        const size = Math.min(160, side);
        const c = document.createElement('canvas');
        c.width = size;
        c.height = size;
        c.getContext('2d').drawImage(v, (w - side) / 2, (h - side) / 2, side, side, 0, 0, size, size);
        avatarStillCache.set(src, c.toDataURL('image/png'));
      } catch (e) {
        avatarStillCache.set(src, 'failed');
      }
    } else {
      avatarStillCache.set(src, 'failed');
    }
    releaseMedia(v);
    refreshAvatars();          // swap the still in
  };
  v.addEventListener('loadeddata', () => { try { v.currentTime = 0.05; } catch (e) { finish(!!v.videoWidth); } }, { once: true });
  v.addEventListener('seeked', () => finish(!!v.videoWidth), { once: true });
  v.addEventListener('loadedmetadata', () => { if (!v.videoWidth) finish(false); }, { once: true });
  v.addEventListener('error', () => finish(false), { once: true });
  setTimeout(() => finish(!!v.videoWidth), 5000);
  v.src = src;
}

/* The frame every animated avatar should be showing: one wall-clock position,
 * taken from page load, wrapped by the clip's duration. All of them play the same
 * file, so aligning each to this clock is enough to keep the group together - and
 * unlike "follow the first video that is playing" it cannot be dragged off by a
 * freshly built one (a transcript rebuild creates videos at 0, and following one
 * of those pulled the whole group back to the start). */
const avatarClockAt = performance.now();
function avatarClockNow() {
  return (performance.now() - avatarClockAt) / 1000;
}
function alignAvatarVideo(v) {
  if (!v || v.readyState < 1) return;
  // A video that is still loading can report a bogus (tiny) duration, and
  // `t %= tiny` is ~0 - which pinned the whole group on the first frame. Only
  // wrap for a believable duration, and only seek inside what is really seekable.
  const d = v.duration;
  if (!isFinite(d) || d < 2) return;
  const t = Math.max(0, avatarClockNow()) % d;   // the group loops, so the position wraps
  if (Math.abs(v.currentTime - t) < 0.12) return;
  try { v.currentTime = t; } catch (e) { /* not seekable yet */ }
}

/* Keep every animated avatar on that clock. A seek only happens when one has
 * drifted, so a settled group costs nothing. */
function syncAvatarVideos() {
  const vids = [...document.querySelectorAll('video.avatar')];
  // A background tab still gets its requestAnimationFrame ticks (browsers clamp
  // them to ~1/s but do not stop them) and the browser does not skip decoding
  // for an element nobody can see. Pausing the whole group when the document is
  // hidden is the difference between an idle second tab costing nothing and
  // costing four video decoders' worth of CPU.
  const hidden = document.visibilityState !== 'visible';
  for (const v of vids) {
    if (hidden) { if (!v.paused) { try { v.pause(); } catch { /* ignore */ } } continue; }
    if (v.paused) v.play().catch(() => {});
    if (v.readyState < 2) { v.addEventListener('canplay', () => alignAvatarVideo(v), { once: true }); continue; }
    alignAvatarVideo(v);
  }
}

/* Pause every video this page owns when it is not on screen, and start it again
 * when it is. The same argument as the avatars above, applied to the background
 * clip: a decorative video behind a minimised window is a decoder and a buffer
 * for nothing. The background only plays when it is meant to be heard or seen,
 * and never on a tab nobody is looking at. */
function pauseMediaWhenHidden() {
  const hidden = document.visibilityState !== 'visible';
  if (hidden) {
    document.querySelectorAll('#bg-media video').forEach((v) => { if (!v.paused) { try { v.pause(); } catch { /* ignore */ } } });
    document.querySelectorAll('video.avatar').forEach((v) => { if (!v.paused) { try { v.pause(); } catch { /* ignore */ } } });
  } else {
    const bg = document.querySelector('#bg-media video');
    if (bg) {
      const wanted = bg.dataset.wantedPlay === '1';
      if (wanted) bg.play().catch(() => {});
    }
    syncAvatarVideos();
  }
}
