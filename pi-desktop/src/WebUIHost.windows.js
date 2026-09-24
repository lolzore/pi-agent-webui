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
  // Whether the native surface exists is module state, not component state: this
  // component gets remounted whenever the app's layout changes (window resize,
  // rotation, the Shorts panel opening), and closing the WebView on unmount
  // reloaded the whole UI - losing the transcript view, the Shorts panel and
  // every running timer. The surface is now kept and just re-bounded, so a
  // resize leaves the page alone.
  const openedRef = WV.opened || (WV.opened = { current: false });
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
      // Deliberately no WV.close() here: an unmount is a layout change, not the
      // end of the app. The surface stays where it is (or gets re-bounded by the
      // next mount) and the page keeps its state.
      cancelAnimationFrame(raf);
      sub && sub.remove && sub.remove();
    };
  }, [place]);

  // Same surface, new URL (host/port change) - and only for a real change.
  // This component is remounted by every layout change, and the effect also runs
  // on mount: navigating to the URL the surface is already showing is a full page
  // load in WebView2, which is what made a one-pixel window resize reload every
  // element and restart the background video on frame 0.
  const lastUrlRef = useRef(null);
  useEffect(() => {
    const first = lastUrlRef.current === null;
    if (lastUrlRef.current === url) return;
    lastUrlRef.current = url;
    if (!first && openedRef.current) WV.navigate(url);
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
