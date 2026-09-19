import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Linking,
} from 'react-native';
import { WebView } from 'react-native-webview';
import {
  FEEDS, FEED_ORDER, userAgentFor, FEED_CSS, FEED_JS_BEFORE, FEED_JS_AFTER,
} from './feeds';

const C = {
  fg: '#e6e9ef',
  dim: '#8b93a3',
  accent: '#5aa9ff',
  bg: '#0c0f14',
  border: '#232a36',
  tabBg: '#151a22',
  danger: '#e5534b',
};

/* Which hosts are "in feed" — anything else opens in the system browser so a
 * link tap inside a reel never traps the user in the shorts panel. */
const SITE_HOSTS = {
  instagram: ['instagram.com', 'cdninstagram.com', 'facebook.com'],
  tiktok: ['tiktok.com', 'tiktokcdn.com', 'byteoversea.com', 'ibytedtos.com'],
  youtube: ['youtube.com', 'youtu.be', 'googlevideo.com', 'google.com', 'ytimg.com', 'gstatic.com'],
};

function sameSite(url, provider) {
  try {
    const host = String(url).split('/')[2] || '';
    const allow = SITE_HOSTS[provider] || [];
    return allow.some((d) => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

/**
 * Seamless in-app shorts feed.
 *
 * - The feed is a real top-level WebView, so the *actual* infinite feed loads
 *   (X-Frame-Options only binds nested frames). No new tabs, no popups.
 * - One WebView instance per provider is kept mounted, so switching tabs is
 *   instant and each feed keeps its session/scroll context.
 * - Cookies + DOM storage + cache are shared with the OS browser engine, so a
 *   login made once inside the panel sticks.
 * - `setSupportMultipleWindows={false}` forces target=_blank / window.open()
 *   links to load in the same view instead of opening a blank window.
 * - A loading bar, an error state with retry, and an "open in app" fallback
 *   cover the cases where a site blocks the web experience.
 */
export function ShortsPanel({ provider, onProviderChange, onClose, compact, expanded, onToggleExpand }) {
  const refs = useRef({});
  const [progress, setProgress] = useState({});
  const [errors, setErrors] = useState({});
  const [loaded, setLoaded] = useState({});
  const [nonce, setNonce] = useState({}); // per-provider reload counter

  const feed = FEEDS[provider] || FEEDS[FEED_ORDER[0]];
  const busy = !loaded[provider] && !errors[provider];

  /* Only one feed should make noise: pause whatever the hidden ones are doing
   * (the instances stay mounted so their session/scroll state survives). */
  useEffect(() => {
    for (const key of FEED_ORDER) {
      if (key === provider) continue;
      const w = refs.current[key];
      if (!w) continue;
      w.injectJavaScript(
        `document.querySelectorAll('video,audio').forEach(function(m){try{m.pause();}catch(e){}});true;`
      );
    }
  }, [provider]);

  const reload = useCallback((key) => {
    setErrors((e) => ({ ...e, [key]: null }));
    setLoaded((l) => ({ ...l, [key]: false }));
    const w = refs.current[key];
    setNonce((n) => ({ ...n, [key]: (n[key] || 0) + 1 }));
    if (w) w.reload();
  }, []);

  const openInApp = useCallback(async () => {
    const url = feed.appUrl;
    try {
      const ok = await Linking.canOpenURL(url).catch(() => false);
      if (ok) await Linking.openURL(url);
      else await Linking.openURL(feed.home);
    } catch {
      try { await Linking.openURL(feed.home); } catch { /* nothing else to do */ }
    }
  }, [feed]);

  /* Keep feed navigation inside the panel; send anything off-site to the OS. */
  const onShouldStartLoadWithRequest = useCallback((req) => {
    const { url } = req;
    if (req.navigationType === 'click' && !sameSite(url, provider)) {
      Linking.openURL(url).catch(() => {});
      return false;
    }
    return true;
  }, [provider]);

  const header = (
    <View style={styles.header}>
      <View style={styles.tabs}>
        {FEED_ORDER.map((key) => {
          const active = key === provider;
          return (
            <TouchableOpacity
              key={key}
              onPress={() => onProviderChange(key)}
              style={[styles.tab, active && { borderColor: FEEDS[key].accent, backgroundColor: '#101823' }]}
              hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
            >
              <Text style={[styles.tabText, active && styles.tabTextActive]}>{FEEDS[key].label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <View style={styles.headerBtns}>
        <TouchableOpacity onPress={() => reload(provider)} style={styles.iconBtn} hitSlop={8}>
          <Text style={styles.iconText}>⟳</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={openInApp} style={styles.iconBtn} hitSlop={8}>
          <Text style={styles.iconText}>↗</Text>
        </TouchableOpacity>
        {onToggleExpand && compact ? (
          <TouchableOpacity onPress={onToggleExpand} style={styles.iconBtn} hitSlop={8}>
            <Text style={styles.iconText}>{expanded ? '⤡' : '⤢'}</Text>
          </TouchableOpacity>
        ) : null}
        {onClose ? (
          <TouchableOpacity onPress={onClose} style={styles.iconBtn} hitSlop={8}>
            <Text style={styles.iconText}>✕</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );

  return (
    <View style={[styles.wrap, compact && styles.wrapCompact]}>
      {compact ? (
        <TouchableOpacity style={styles.grabber} onPress={onToggleExpand} activeOpacity={0.7}>
          <View style={styles.grabberBar} />
        </TouchableOpacity>
      ) : null}
      {header}

      <View style={styles.body}>
        {FEED_ORDER.map((key) => {
          const active = key === provider;
          return (
            <View key={key} style={[StyleSheet.absoluteFill, !active && styles.hiddenFeed]} pointerEvents={active ? 'auto' : 'none'}>
              <WebView
                ref={(w) => { if (w) refs.current[key] = w; }}
                source={{ uri: FEEDS[key].url }}
                // a fresh key per provider-retry so RN actually tears down & rebuilds
                key={`${key}-${nonce[key] || 0}`}
                style={styles.webview}
                originWhitelist={['*']}
                // identity + storage: this is what makes the feed usable (a
                // logged-in cookie set survives app restarts)
                userAgent={userAgentFor(FEEDS[key])}
                applicationNameForUserAgent="PiAgent/1.0"
                sharedCookiesEnabled
                thirdPartyCookiesEnabled
                domStorageEnabled
                javaScriptEnabled
                cacheEnabled
                incognito={false}
                // media: play inline, no tap needed
                allowsInlineMediaPlayback
                mediaPlaybackRequiresUserAction={false}
                allowsFullscreenVideo
                // keep target=_blank / window.open() inside this view
                setSupportMultipleWindows={false}
                onOpenWindow={(e) => {
                  const target = e?.nativeEvent?.targetUrl;
                  if (target && refs.current[key]) refs.current[key].injectJavaScript(`window.location.href=${JSON.stringify(target)};true;`);
                }}
                onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
                injectedJavaScriptBeforeContentLoaded={FEED_JS_BEFORE}
                injectedJavaScript={FEED_JS_AFTER}
                onLoadStart={() => { setLoaded((l) => ({ ...l, [key]: false })); }}
                onLoadProgress={({ nativeEvent }) => setProgress((p) => ({ ...p, [key]: nativeEvent.progress }))}
                onLoadEnd={() => { setLoaded((l) => ({ ...l, [key]: true })); setErrors((e) => ({ ...e, [key]: null })); }}
                onError={() => setErrors((e) => ({ ...e, [key]: 'Could not load the feed' }))}
                onHttpError={({ nativeEvent }) => {
                  if (nativeEvent.statusCode >= 400) setErrors((e) => ({ ...e, [key]: `HTTP ${nativeEvent.statusCode}` }));
                }}
                // iOS: swipe back through in-feed navigation feels native
                allowsBackForwardNavigationGestures
                // keep the panel from being covered by the keyboard
                keyboardDisplayRequiresUserAction={false}
                // Android: let the feed own the scroll container
                nestedScrollEnabled
                overScrollMode="never"
                textZoom={100}
              />
            </View>
          );
        })}

        {busy ? (
          <View style={styles.loading} pointerEvents="none">
            <ActivityIndicator color={C.accent} />
            <Text style={styles.loadingText}>loading {feed.label.toLowerCase()}…</Text>
          </View>
        ) : null}

        {errors[provider] ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorTitle}>{feed.label} didn't load</Text>
            <Text style={styles.errorSub}>{errors[provider]}</Text>
            <Text style={styles.errorHint}>
              Sites sometimes block embedded browsers or ask you to log in. Retry, or open the
              native app and the panel keeps your chat running.
            </Text>
            <View style={styles.errorBtns}>
              <TouchableOpacity style={styles.errBtn} onPress={() => reload(provider)}>
                <Text style={styles.errBtnText}>Retry</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.errBtn, styles.errBtnAlt]} onPress={openInApp}>
                <Text style={styles.errBtnText}>Open in app</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : null}

        {progress[provider] != null && progress[provider] < 1 && !errors[provider] ? (
          <View style={[styles.progressTrack, { width: `${Math.max(4, Math.round(progress[provider] * 100))}%` }]} />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: C.bg, borderLeftWidth: 1, borderColor: C.border, overflow: 'hidden' },
  wrapCompact: { borderTopLeftRadius: 16, borderTopRightRadius: 16, borderLeftWidth: 0 },
  grabber: { alignItems: 'center', paddingVertical: 6 },
  grabberBar: { width: 44, height: 4, borderRadius: 2, backgroundColor: '#3a4354' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderColor: C.border,
  },
  tabs: { flexDirection: 'row', gap: 6 },
  tab: {
    backgroundColor: C.tabBg,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: C.border,
  },
  tabText: { color: C.dim, fontSize: 13, fontWeight: '600' },
  tabTextActive: { color: C.fg },
  headerBtns: { flexDirection: 'row', gap: 2, alignItems: 'center' },
  iconBtn: { padding: 5 },
  iconText: { color: C.dim, fontSize: 16 },
  body: { flex: 1, backgroundColor: '#000' },
  hiddenFeed: { opacity: 0, zIndex: -1 },
  webview: { flex: 1, backgroundColor: '#000' },
  loading: { position: 'absolute', top: 14, alignSelf: 'center', alignItems: 'center', gap: 6 },
  loadingText: { color: C.dim, fontSize: 11 },
  progressTrack: { position: 'absolute', top: 0, left: 0, height: 2, backgroundColor: C.accent },
  errorBox: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center', padding: 22, gap: 6,
    backgroundColor: C.bg,
  },
  errorTitle: { color: C.fg, fontSize: 15, fontWeight: '700' },
  errorSub: { color: C.danger, fontSize: 12 },
  errorHint: { color: C.dim, fontSize: 12, textAlign: 'center', lineHeight: 17, marginTop: 4 },
  errorBtns: { flexDirection: 'row', gap: 10, marginTop: 12 },
  errBtn: { backgroundColor: C.accent, borderRadius: 9, paddingHorizontal: 16, paddingVertical: 9 },
  errBtnAlt: { backgroundColor: '#2a3140' },
  errBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
});
