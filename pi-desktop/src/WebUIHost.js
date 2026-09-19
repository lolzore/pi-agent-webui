/**
 * Mobile host for the *actual* WebUI.
 *
 * Same idea as WebUIHost.windows.js, but mobile has a real WebView component so
 * it needs no native module: point react-native-webview at the bridge's WebUI
 * and the UI is identical to the browser one by definition.
 */
import React, { useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { WebView } from 'react-native-webview';

export function WebUIHost({ url }) {
  const [error, setError] = useState(null);
  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Could not load the Web UI</Text>
        <Text style={styles.note}>{url}</Text>
      </View>
    );
  }
  return (
    <View style={styles.host}>
      <WebView
        source={{ uri: url }}
        style={styles.web}
        startInLoadingState
        renderLoading={() => (
          <View style={styles.center}>
            <ActivityIndicator color="#5aa9ff" />
            <Text style={styles.note}>{url}</Text>
          </View>
        )}
        onError={(e) => setError((e.nativeEvent && e.nativeEvent.description) || 'load failed')}
        setSupportMultipleWindows={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  host: { flex: 1, backgroundColor: '#101318' },
  web: { flex: 1, backgroundColor: '#101318' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20, gap: 8 },
  title: { color: '#e6e9ef', fontSize: 16, fontWeight: '700' },
  note: { color: '#8b93a3', fontSize: 12 },
});
