/**
 * Windows shorts panel.
 *
 * Unlike mobile (which mounts a react-native-webview per provider), the Windows
 * build drives the native PiWebView module: a WebView2 living in a child window
 * of the app window. React Native owns the *layout*, the native module owns the
 * *pixels*, so this component's only real job is to measure where the feed
 * should sit and keep the native bounds in sync as the window resizes.
 *
 * If the native module is unavailable the panel degrades to opening the feed in
 * the default browser, which still works because a browser window is a
 * top-level context.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Linking, AppState } from 'react-native';
import { FEEDS, FEED_ORDER, userAgentFor } from './feeds';
import * as WV from './webview2';

export function ShortsPanel({ provider, onProviderChange, onClose, compact, expanded, onToggleExpand, autoOpen = false, onAutoOpenToggle }) {
  const feed = FEEDS[provider] || FEEDS[FEED_ORDER[0]];
  const hostRef = useRef(null);
  const [bounds, setBounds] = useState(null);
  const [status, setStatus] = useState(WV.hasNativeWebView ? 'starting' : 'unavailable');
  const providerRef = useRef(provider);
  providerRef.current = provider;
  const openedRef = useRef(false);

  const syncBounds = useCallback((opts = {}) => {
    const node = hostRef.current;
    if (!node || !WV.hasNativeWebView) return;
    node.measureInWindow((x, y, width, height) => {
      if (!width || !height) return;
      setBounds({ x, y, width, height });
      // Open the first time we have a real size -- a resize-triggered call must
      // not try to re-create the surface.
      if (!openedRef.current) {
        openedRef.current = WV.open({
          url: FEEDS[providerRef.current].url,
          x,
          y,
          width,
          height,
          userAgent: userAgentFor(FEEDS[providerRef.current]),
        });
        if (openedRef.current) setStatus('live');
      } else {
        WV.setBounds({ x, y, width, height });
      }
    });
  }, []);

  // Mount: put the native surface where the placeholder is, then load the feed.
  useEffect(() => {
    if (!WV.hasNativeWebView) return undefined;
    const raf = requestAnimationFrame(() => syncBounds({}));
    // Keep it aligned when the window resizes / rotates.
    const sub = AppState.addEventListener('change', () => syncBounds({}));
    return () => {
      cancelAnimationFrame(raf);
      sub && sub.remove && sub.remove();
      openedRef.current = false;
      WV.close();
    };
  }, [syncBounds]);

  // Provider switch: same native surface, new feed (keeps the login session).
  useEffect(() => {
    if (!WV.hasNativeWebView) return;
    syncBounds({});
    if (status === 'live') WV.navigate(feed.url);
  }, [provider, feed.url, status, syncBounds]);

  const openInBrowser = () => {
    Linking.openURL(feed.url).catch(() => {});
  };

  return (
    <View style={[styles.root, compact && styles.rootCompact]}>
      <View style={styles.bar}>
        {FEED_ORDER.map((key) => {
          const on = key === provider;
          const f = FEEDS[key];
          return (
            <TouchableOpacity
              key={key}
              onPress={() => onProviderChange && onProviderChange(key)}
              style={[styles.tab, on && { borderBottomColor: f.accent }]}>
              <Text style={[styles.tabText, on && { color: f.accent }]}>{f.label}</Text>
            </TouchableOpacity>
          );
        })}
        {onAutoOpenToggle ? (
          /* "auto" = auto-open/close this feed while the agent runs. The
             setting lives here, next to the feed it controls, instead of the
             main settings dialog (where nobody could find it). */
          <TouchableOpacity
            onPress={onAutoOpenToggle}
            accessibilityLabel="Auto-open shorts while the agent is running"
            style={[styles.tab, autoOpen && { borderBottomColor: '#5b9dff' }]}>
            <Text style={[styles.tabText, autoOpen && { color: '#5b9dff' }]}>auto</Text>
          </TouchableOpacity>
        ) : null}
        <View style={{ flex: 1 }} />
        {WV.hasNativeWebView ? (
          <>
            <TouchableOpacity onPress={() => WV.reload()} style={styles.iconBtn}>
              <Text style={styles.iconText}>⟳</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => WV.goBack()} style={styles.iconBtn}>
              <Text style={styles.iconText}>‹</Text>
            </TouchableOpacity>
          </>
        ) : null}
        <TouchableOpacity onPress={onClose} style={styles.iconBtn}>
          <Text style={styles.iconText}>✕</Text>
        </TouchableOpacity>
      </View>

      {/* The native WebView2 floats above this box; it is just a measuring frame. */}
      <View ref={hostRef} style={styles.host} collapsable={false} onLayout={() => syncBounds({})}>
        {status === 'unavailable' ? (
          <View style={styles.fallback}>
            <Text style={styles.title}>{feed.label} shorts</Text>
            <Text style={styles.note}>
              The embedded WebView2 is not available in this build, so the feed opens in your
              default browser instead.
            </Text>
            <TouchableOpacity style={[styles.cta, { backgroundColor: feed.accent }]} onPress={openInBrowser}>
              <Text style={styles.ctaText}>Open {feed.label}</Text>
            </TouchableOpacity>
          </View>
        ) : bounds ? null : (
          <View style={styles.fallback}>
            <Text style={styles.note}>Starting the embedded browser…</Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0c0f14' },
  rootCompact: { flex: 0, height: 420 },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#1d222b',
    paddingHorizontal: 6,
  },
  tab: { paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabText: { color: '#8b93a3', fontSize: 13, fontWeight: '600' },
  iconBtn: { paddingHorizontal: 12, paddingVertical: 9 },
  iconText: { color: '#8b93a3', fontSize: 15 },
  host: { flex: 1, minHeight: 120 },
  fallback: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20, gap: 12 },
  title: { color: '#e6e9ef', fontSize: 17, fontWeight: '700' },
  note: { color: '#8b93a3', fontSize: 13, lineHeight: 19, textAlign: 'center', maxWidth: 420 },
  cta: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 9 },
  ctaText: { color: '#0b0e13', fontSize: 14, fontWeight: '700' },
});
