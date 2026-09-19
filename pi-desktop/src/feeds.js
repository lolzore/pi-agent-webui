// Shorts feed providers.
//
// These are loaded TOP-LEVEL in a real native WebView (not an <iframe>), so
// X-Frame-Options does NOT apply — the genuine infinite feed (Instagram
// Reels / TikTok For You / YouTube Shorts) plays inside the app.
//
// `ua` picks which identity the site sees:
//   'mobile'  — the phone web experience (best for YouTube Shorts)
//   'desktop' — the full web experience; IG/TikTok gate the mobile web with
//               "open the app" interstitials, while desktop web shows the feed.
//
// `appUrl` is the OS deep link used by the "open in app" escape hatch when a
// site insists on its native app.
export const FEEDS = {
  instagram: {
    key: 'instagram',
    label: 'Reels',
    url: 'https://www.instagram.com/reels/',
    home: 'https://www.instagram.com/',
    appUrl: 'instagram://app',
    ua: 'desktop',
    accent: '#e1306c',
  },
  tiktok: {
    key: 'tiktok',
    label: 'TikTok',
    url: 'https://www.tiktok.com/foryou',
    home: 'https://www.tiktok.com/',
    appUrl: 'tiktok://',
    ua: 'desktop',
    accent: '#25f4ee',
  },
  youtube: {
    key: 'youtube',
    label: 'Shorts',
    url: 'https://www.youtube.com/shorts/',
    home: 'https://www.youtube.com/',
    appUrl: 'vnd.youtube://',
    ua: 'mobile',
    accent: '#ff0033',
  },
};

export const FEED_ORDER = ['instagram', 'tiktok', 'youtube'];

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MOBILE_ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

export function userAgentFor(feed) {
  return feed && feed.ua === 'mobile' ? MOBILE_ANDROID_UA : DESKTOP_UA;
}

// CSS injected into every feed: hide scrollbars and kill the rubber-band
// overscroll so the feed behaves like a native full-screen list.
export const FEED_CSS = `
  ::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }
  html, body { overscroll-behavior: none !important; background: #000 !important; }
  * { -webkit-tap-highlight-color: transparent !important; }
`;

// Runs before page scripts: capture <video> so we can start playback without a
// user gesture (autoplay policies otherwise block it in the webview).
export const FEED_JS_BEFORE = `
  (function () {
    try {
      var origPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        this.muted = true;
        this.setAttribute('playsinline', '');
        return origPlay.apply(this, arguments).catch(function () {});
      };
    } catch (e) {}
  })();
  true;
`;

// Runs after load: hide cookie/app-install nags that cover the feed.
export const FEED_JS_AFTER = `
  (function () {
    var kill = [
      '[data-testid="cookie-policy-manage-dialog"]',
      '.cookie-banner', '#onetrust-banner-sdk', '#onetrust-consent-sdk',
      '.tiktok-cookie-banner', '[class*="CookieBanner"]',
      'ytd-consent-bump-v2-lightbox', 'tp-yt-paper-dialog#consent-bump'
    ];
    function scrub() {
      kill.forEach(function (sel) {
        document.querySelectorAll(sel).forEach(function (n) { n.style.display = 'none'; });
      });
      document.body && (document.body.style.overflow = 'auto');
    }
    scrub();
    setTimeout(scrub, 1200);
    setTimeout(scrub, 3000);
  })();
  true;
`;
