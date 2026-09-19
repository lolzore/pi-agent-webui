/**
 * React Native CLI / React Native Windows configuration.
 */
module.exports = {
  dependencies: {
    /**
     * Exclude react-native-webview from the *Windows* build only.
     *
     * react-native-webview's windows/ project is a legacy UWP project
     * (ApplicationType "Windows Store", CppWinRT 2.0.200316.3 pulled from a
     * packages.config layout) and cannot be linked into a React Native Windows
     * WinAppSDK / New Architecture app. It also drags in the UWP C++ toolset
     * and the MSIX packaging VS components.
     *
     * Mobile (iOS/Android) keeps the real WebView. On Windows,
     * src/ShortsPanel.windows.js takes over and opens feeds in a real browser
     * window instead (see that file for why an in-app WebView is not possible
     * yet).
     */
    'react-native-webview': {
      platforms: {
        windows: null,
      },
    },
  },
};
