/* Runs in the feed's own world, before its scripts (the autoplay patch has to
 * beat the page's own media handling, which is why it is a preload and not an
 * injected script). */
(() => {
  try { window.__piShortsPreload = true; } catch { /* not ours to write */ }
  try {
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      this.muted = true;
      this.setAttribute('playsinline', '');
      return origPlay.apply(this, arguments).catch(() => {});
    };
  } catch { /* no media elements yet */ }
})();
