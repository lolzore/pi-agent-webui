// Mobile (iOS/Android) implementation - just re-export the real library.
// Metro picks safearea.windows.js instead when bundling for Windows.
export { SafeAreaView, SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
