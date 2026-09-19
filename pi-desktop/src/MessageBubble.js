import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Markdown } from './Markdown';

const C = {
  fg: '#e6e9ef',
  dim: '#8b93a3',
  accent: '#5aa9ff',
  userBg: '#1a2436',
  botBg: '#151a22',
  border: '#232a36',
  toolBg: '#12161d',
};

/* One chat message.
 * m = { id, role: 'user'|'assistant'|'tool'|'system',
 *       text, thinking, tools: [{name, args, result}],
 *       streaming, error }
 */
export function MessageBubble({ m }) {
  const [showThinking, setShowThinking] = useState(false);
  const [openTool, setOpenTool] = useState(null);

  if (m.role === 'user') {
    return (
      <View style={[styles.row, { justifyContent: 'flex-end' }]}>
        <View style={[styles.bubble, styles.userBubble]}>
          <Text style={styles.userText}>{m.text}</Text>
        </View>
      </View>
    );
  }

  if (m.role === 'tool') {
    return (
      <View style={[styles.row, { justifyContent: 'flex-start' }]}>
        <View style={[styles.bubble, styles.toolBubble]}>
          <Text style={styles.toolName}>⚙ {m.text || 'tool'}</Text>
          {m.detail ? <Text style={styles.toolDetail}>{m.detail}</Text> : null}
        </View>
      </View>
    );
  }

  if (m.role === 'system') {
    return (
      <View style={styles.sysRow}>
        <Text style={styles.sysText}>{m.text}</Text>
      </View>
    );
  }

  // assistant
  const hasThinking = !!m.thinking && m.thinking.length > 0;
  return (
    <View style={[styles.row, { justifyContent: 'flex-start' }]}>
      <View style={[styles.bubble, styles.botBubble]}>
        {hasThinking ? (
          <TouchableOpacity onPress={() => setShowThinking(!showThinking)} style={styles.thinkToggle}>
            <Text style={styles.thinkLabel}>{showThinking ? '▾ thinking' : '▸ thinking'}</Text>
          </TouchableOpacity>
        ) : null}
        {hasThinking && showThinking ? (
          <View style={styles.thinkBox}>
            <Text style={styles.thinkText}>{m.thinking}</Text>
          </View>
        ) : null}

        {(m.tools || []).map((t, i) => (
          <TouchableOpacity key={i} onPress={() => setOpenTool(openTool === i ? null : i)} style={styles.toolCard}>
            <Text style={styles.toolCardHead}>
              {openTool === i ? '▾' : '▸'} {t.name}
            </Text>
            {openTool === i ? (
              <Text style={styles.toolCardBody} numberOfLines={12}>
                {t.args || t.result || ''}
              </Text>
            ) : null}
          </TouchableOpacity>
        ))}

        {m.text ? (
          <Markdown text={m.text} />
        ) : m.streaming ? (
          <Text style={styles.dimText}>…</Text>
        ) : null}
        {m.error ? <Text style={styles.errText}>{m.error}</Text> : null}
        {m.streaming && m.text ? <Text style={styles.caret}>▍</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { paddingVertical: 3, paddingHorizontal: 10 },
  bubble: { borderRadius: 12, padding: 10, maxWidth: '92%' },
  userBubble: { backgroundColor: C.userBg, borderTopRightRadius: 4 },
  botBubble: { backgroundColor: C.botBg, borderWidth: 1, borderColor: C.border, borderTopLeftRadius: 4 },
  toolBubble: { backgroundColor: C.toolBg, borderWidth: 1, borderColor: C.border },
  userText: { color: C.fg, fontSize: 15, lineHeight: 21 },
  dimText: { color: C.dim, fontSize: 15 },
  errText: { color: '#ff7b7b', fontSize: 13, marginTop: 6 },
  caret: { color: C.accent },
  sysRow: { alignItems: 'center', paddingVertical: 6 },
  sysText: { color: C.dim, fontSize: 12 },
  toolName: { color: C.accent, fontSize: 13, fontWeight: '600' },
  toolDetail: { color: C.dim, fontSize: 12, marginTop: 4 },
  thinkToggle: { marginBottom: 4 },
  thinkLabel: { color: C.dim, fontSize: 12 },
  thinkBox: {
    backgroundColor: '#0f131a',
    borderRadius: 8,
    padding: 8,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: C.border,
  },
  thinkText: { color: C.dim, fontSize: 12, lineHeight: 17 },
  toolCard: {
    backgroundColor: C.toolBg,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: C.border,
    padding: 8,
    marginBottom: 6,
  },
  toolCardHead: { color: C.accent, fontSize: 13, fontWeight: '600' },
  toolCardBody: { color: C.dim, fontSize: 12, marginTop: 4 },
});
