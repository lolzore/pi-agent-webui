/**
 * WebView2 for React Native Windows.
 *
 * There is no react-native-webview on Windows (its windows/ target is a legacy
 * UWP project that cannot link into a WinAppSDK / New Architecture app, and
 * react-native-windows 0.84 ships no WebView of its own), so the app carries a
 * small native module: windows/PiAgent/WebView2Module.h.
 *
 * That module hosts a real Chromium surface (the engine Edge uses) in a child
 * HWND of the app window. JS never renders the page -- it only tells the module
 * where to put the child window:
 *
 *   1. this component renders an empty <View> placeholder
 *   2. after layout it measures that view in window coordinates
 *   3. it hands those device-independent pixels to the native module, which
 *      scales them by the window DPI and positions the HWND
 *
 * Two consequences worth knowing:
 *
 *   - The child HWND always paints ON TOP of the React Native surface, so
 *     anything drawn over the placeholder rect is hidden. Keep controls (tab
 *     bars, buttons) OUTSIDE the WebView rect.
 *   - The native module owns a single surface process-wide. Components take a
 *     lease on it; the last one to mount owns it, and only the owner may
 *     navigate or close it.
 */
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { View, NativeModules, Dimensions } from 'react-native';

const Native = NativeModules.PiWebView || null;

/** False when the native module is missing (e.g. an older build). */
export const isWebView2Available = !!Native;

/* Only one surface exists process-wide. Track its owner so an unmounting
   component cannot close a surface another one has taken over. */
let leaseOwner = null;
let leaseSeq = 0;

export const WebView2 = forwardRef(function WebView2(
  { source, style, userAgent, onReady, onUnavailable, ...rest },
  ref,
) {
  const hostRef = useRef(null);
  const uri = (source && source.uri) || '';
  const [lease] = useState(() => `wv2-${++leaseSeq}`);

  const measure = useCallback((cb) => {
    const node = hostRef.current;
    if (!node || !Native) return;
    node.measureInWindow((x, y, width, height) => {
      if (!width || !height) return;
      cb(x, y, width, height);
    });
  }, []);

  /** Point the surface at this placeholder's rect (call after any layout change). */
  const syncBounds = useCallback(() => {
    if (!Native || leaseOwner !== lease) return;
    measure((x, y, width, height) => Native.setBounds(x, y, width, height));
  }, [lease, measure]);

  // Own the surface for as long as this component is mounted.
  useEffect(() => {
    if (!Native) {
      if (onUnavailable) onUnavailable();
      return undefined;
    }
    leaseOwner = lease;
    measure((x, y, width, height) => {
      Native.open(uri, x, y, width, height, userAgent || '');
      if (onReady) onReady();
    });
    const sub = Dimensions.addEventListener('change', syncBounds);
    return () => {
      if (sub && sub.remove) sub.remove();
      if (leaseOwner === lease) {
        leaseOwner = null;
        try {
          Native.close();
        } catch (e) {
          /* module already gone */
        }
      }
    };
    // Mount/unmount only -- URI changes are handled by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow source changes by navigating the existing surface rather than
  // tearing it down, so switching feeds does not flash a blank panel.
  const first = useRef(true);
  useEffect(() => {
    if (!Native) return;
    if (first.current) {
      first.current = false;
      return;
    }
    if (leaseOwner === lease && uri) Native.navigate(uri);
  }, [uri, lease, userAgent]);

  useImperativeHandle(
    ref,
    () => ({
      reload: () => Native && leaseOwner === lease && Native.reload(),
      goBack: () => Native && leaseOwner === lease && Native.goBack(),
      navigate: (next) => Native && leaseOwner === lease && Native.navigate(next),
      syncBounds,
    }),
    [lease, syncBounds],
  );

  return <View ref={hostRef} style={style} onLayout={syncBounds} collapsable={false} {...rest} />;
});

/** Direct access for code that drives the surface without a placeholder. */
export const WebView2Native = Native
  ? {
      open: (url, x, y, w, h, ua) => Native.open(url, x, y, w, h, ua || ''),
      setBounds: (x, y, w, h) => Native.setBounds(x, y, w, h),
      navigate: (url) => Native.navigate(url),
      reload: () => Native.reload(),
      goBack: () => Native.goBack(),
      close: () => Native.close(),
      isOpen: () => !!Native.isOpen(),
    }
  : null;

/* --------------------------------------------------------------------------
 * Flat, object-argument API.
 *
 * `open`/`setBounds` take a rect object instead of positional numbers, which
 * reads better at the call site and makes it obvious that the rect is the same
 * one `measureInWindow` produced. Both spellings are supported, so callers that
 * pass positional numbers keep working.
 * ------------------------------------------------------------------------ */

/** True when the native module is present. */
export const hasNativeWebView = !!Native;

const rect = (a, b, c, d) =>
  a && typeof a === 'object'
    ? { x: a.x || 0, y: a.y || 0, width: a.width || 0, height: a.height || 0 }
    : { x: a || 0, y: b || 0, width: c || 0, height: d || 0 };

/** Opens (or re-points) the surface, e.g. open({ url, x, y, width, height }). */
export function open(urlOrOpts, x, y, width, height, userAgent) {
  if (!Native) return;
  if (urlOrOpts && typeof urlOrOpts === 'object') {
    const o = urlOrOpts;
    Native.open(o.url || '', Math.round(o.x || 0), Math.round(o.y || 0),
      Math.round(o.width || 0), Math.round(o.height || 0), o.userAgent || '');
    return;
  }
  Native.open(urlOrOpts || '', Math.round(x || 0), Math.round(y || 0),
    Math.round(width || 0), Math.round(height || 0), userAgent || '');
}

/** Moves/resizes the surface, e.g. setBounds({ x, y, width, height }). */
export function setBounds(a, b, c, d) {
  if (!Native) return;
  const r = rect(a, b, c, d);
  if (r.width <= 0 || r.height <= 0) return;
  Native.setBounds(Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height));
}

export function navigate(url) {
  if (Native && url) Native.navigate(url);
}

export function reload() {
  if (Native) Native.reload();
}

export function goBack() {
  if (Native) Native.goBack();
}

export function close() {
  if (Native) Native.close();
}

export function isOpen() {
  return !!(Native && Native.isOpen());
}

export default WebView2;
