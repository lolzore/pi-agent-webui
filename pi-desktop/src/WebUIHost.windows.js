/**
 * Windows host for the *actual* WebUI.
 *
 * The native PiWebView module (windows/PiAgent/WebView2Module.h) renders a real
 * Chromium surface at a rectangle inside the app window, so pointing it at the
 * bridge's own WebUI gives a UI that is identical to the browser one by
 * definition -- same HTML, same CSS, same JS. No reimplementation to drift.
 *
 * The surface only covers the area below the app's header, so the header (and
 * with it the button that leaves this mode) stays clickable.
 */
import React, { useCallback, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, AppState } from 'react-native';
import * as WV from './webview2';

export function WebUIHost({ url }) {
  const hostRef = useRef(null);
  const openedRef = useRef(false);
  const urlRef = useRef(url);
  urlRef.current = url;

  // Opening needs a real size, which only exists once layout has run. Doing it
  // from a one-shot rAF races layout and silently does nothing, so drive it from
  // measureInWindow and retry until the box has actual width/height.
  const place = useCallback(() => {
    const node = hostRef.current;
    if (!node || !WV.hasNativeWebView) return;
    node.measureInWindow((x, y, width, height) => {
      if (!width || !height) return;
      if (!openedRef.current) {
        openedRef.current = WV.open({ url: urlRef.current, x, y, width, height });
      } else {
        WV.setBounds({ x, y, width, height });
      }
    });
  }, []);

  useEffect(() => {
    if (!WV.hasNativeWebView) return undefined;
    const raf = requestAnimationFrame(place);
    // Re-align when the window resizes / the app is backgrounded and restored.
    const sub = AppState.addEventListener('change', place);
    return () => {
      cancelAnimationFrame(raf);
      sub && sub.remove && sub.remove();
      openedRef.current = false;
      WV.close();
    };
  }, [place]);

  // Same surface, new URL (host/port change).
  useEffect(() => {
    if (openedRef.current) WV.navigate(url);
  }, [url]);

  return (
    <View ref={hostRef} style={styles.host} collapsable={false} onLayout={place}>
      {WV.hasNativeWebView ? null : (
        <View style={styles.fallback}>
          <Text style={styles.title}>Web UI is not available in this build</Text>
          <Text style={styles.note}>{url}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  host: { flex: 1, backgroundColor: '#101318', minHeight: 80 },
  fallback: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20, gap: 10 },
  title: { color: '#e6e9ef', fontSize: 16, fontWeight: '700' },
  note: { color: '#8b93a3', fontSize: 12 },
});
