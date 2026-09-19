/**
 * Windows shell for the Pi Agent app.
 *
 * The React Native UI is styled by hand, so it can only ever *approximate* the
 * WebUI. On Windows we have a real Chromium surface (the WebView2 native
 * module), so the surest way to get a UI that is identical to the WebUI is to
 * run the WebUI itself — same HTML, same CSS, same app.js, same features.
 *
 * Layout:
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ bar:  Pi Agent   [chat] [shorts]   ⟳  ↗      │  <- React Native (never overlapped)
 *   ├──────────────────────────────────────────────┤
 *   │                                              │
 *   │   WebView2 child HWND                        │  <- the only surface
 *   │   chat   -> the WebUI at http://host:port    │
 *   │   shorts -> instagram / tiktok / youtube     │
 *   │                                              │
 *   └──────────────────────────────────────────────┘
 *
 * The native bar deliberately sits ABOVE the WebView rect: the WebView2 HWND
 * paints on top of the React Native surface, so a bar drawn over it would be
 * invisible.
 *
 * The native module owns one surface, so chat and shorts are modes rather than
 * panes side by side. Switching modes navigates the surface.
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { WebView2, isWebView2Available } from './webview2';
import { FEEDS, FEED_ORDER, userAgentFor } from './feeds';

export function WindowsShell({ httpBase, onUseNativeUi }) {
  const [mode, setMode] = useState('chat'); // 'chat' | 'shorts'
  const [provider, setProvider] = useState(FEED_ORDER[0]);
  const view = useRef(null);

  const feed = FEEDS[provider] || FEEDS[FEED_ORDER[0]];
  const uri = mode === 'chat' ? httpBase : feed.url;
  const ua = mode === 'chat' ? '' : userAgentFor(feed);

  const retry = useCallback(() => {
    if (view.current) view.current.reload();
  }, []);

  const openExternal = useCallback(() => {
    if (uri) {
      // eslint-disable-next-line global-require
      require('react-native').Linking.openURL(uri).catch(() => {});
    }
  }, [uri]);

  const feeds = useMemo(
    () =>
      FEED_ORDER.map((key) => {
        const f = FEEDS[key];
        return (
          <TouchableOpacity
            key={key}
            onPress={() => {
              setMode('shorts');
              setProvider(key);
            }}
            style={[styles.tab, mode === 'shorts' && provider === key && { borderBottomColor: f.accent }]}>
            <Text
              style={[
                styles.tabText,
                mode === 'shorts' && provider === key && { color: f.accent },
              ]}>
              {f.label}
            </Text>
          </TouchableOpacity>
        );
      }),
    [mode, provider],
  );

  return (
    <View style={styles.root}>
      <View style={styles.bar}>
        <Text style={styles.brand}>Pi Agent</Text>

        <TouchableOpacity
          onPress={() => setMode('chat')}
          style={[styles.tab, mode === 'chat' && styles.tabOn]}>
          <Text style={[styles.tabText, mode === 'chat' && styles.tabTextOn]}>chat</Text>
        </TouchableOpacity>
        {feeds}

        <View style={{ flex: 1 }} />

        {mode === 'shorts' ? (
          <TouchableOpacity onPress={retry} style={styles.iconBtn} title="Reload">
            <Text style={styles.iconText}>⟳</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity onPress={openExternal} style={styles.iconBtn} title="Open in browser">
          <Text style={styles.iconText}>↗</Text>
        </TouchableOpacity>
        {onUseNativeUi ? (
          <TouchableOpacity onPress={onUseNativeUi} style={styles.nativeBtn} title="Use the native UI">
            <Text style={styles.nativeText}>native UI</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      <View style={styles.body}>
        {isWebView2Available && httpBase ? (
          <WebView2
            ref={view}
            style={styles.web}
            source={{ uri }}
            userAgent={ua}
          />
        ) : (
          <View style={styles.fallback}>
            <Text style={styles.fallbackTitle}>WebView2 module unavailable</Text>
            <Text style={styles.fallbackText}>
              This build has no PiWebView native module, so the embedded browser cannot start.
              Rebuild with `npm run windows:release`.
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#101318' },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 40,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#1d222b',
    backgroundColor: '#0c0f14',
  },
  brand: { color: '#e6e9ef', fontSize: 14, fontWeight: '700', marginRight: 12 },
  tab: {
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabOn: { borderBottomColor: '#5aa9ff' },
  tabText: { color: '#8b93a3', fontSize: 13, fontWeight: '600' },
  tabTextOn: { color: '#5aa9ff' },
  iconBtn: { paddingHorizontal: 11, paddingVertical: 6 },
  iconText: { color: '#8b93a3', fontSize: 15 },
  nativeBtn: {
    marginLeft: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: '#252b36',
  },
  nativeText: { color: '#8b93a3', fontSize: 12 },
  body: { flex: 1 },
  web: { flex: 1, backgroundColor: '#101318' },
  fallback: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 10 },
  fallbackTitle: { color: '#e6e9ef', fontSize: 16, fontWeight: '700' },
  fallbackText: { color: '#8b93a3', fontSize: 13, textAlign: 'center', maxWidth: 460, lineHeight: 19 },
});
