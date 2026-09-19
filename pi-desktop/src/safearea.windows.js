// Windows (desktop) implementation.
//
// react-native-safe-area-context ships no Windows target (it is iOS/Android/
// macOS only), and a desktop window has no notch, status bar or home indicator
// to inset around. So on Windows these are plain no-ops: SafeAreaView is a
// regular View and the insets are all zero.
import React from 'react';
import { View } from 'react-native';

export const SafeAreaView = React.forwardRef(function SafeAreaView({ edges, mode, ...rest }, ref) {
  return <View ref={ref} {...rest} />;
});

export function SafeAreaProvider({ children }) {
  return <>{children}</>;
}

const ZERO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

export function useSafeAreaInsets() {
  return ZERO_INSETS;
}

export function useSafeAreaFrame() {
  return { x: 0, y: 0, width: 0, height: 0 };
}

export const initialWindowMetrics = { insets: ZERO_INSETS, frame: { x: 0, y: 0, width: 0, height: 0 } };
