// Lightweight markdown → React Native renderer (no dependencies).
// Handles: code fences, inline code, bold, italic, links, headings, lists.
import React from 'react';
import { Text, View, StyleSheet, Linking } from 'react-native';

const C = {
  fg: '#e6e9ef',
  dim: '#8b93a3',
  accent: '#5aa9ff',
  codeBg: '#0b0e13',
  codeFg: '#d7e0ee',
  border: '#232a36',
};

/* ── inline: tokenize **bold**, *italic*, `code`, [text](url) ── */

function parseInline(text, keyBase) {
  const out = [];
  let i = 0;
  let k = 0;
  const push = (node) => out.push(node);

  while (i < text.length) {
    const rest = text.slice(i);

    // code span
    let m = rest.match(/^`([^`]+)`/);
    if (m) {
      push(<Text key={`${keyBase}c${k++}`} style={styles.inlineCode}>{m[1]}</Text>);
      i += m[0].length;
      continue;
    }
    // link
    m = rest.match(/^\[([^\]]+)\]\(([^)\s]+)\)/);
    if (m) {
      push(
        <Text
          key={`${keyBase}l${k++}`}
          style={styles.link}
          onPress={() => Linking.openURL(m[2]).catch(() => {})}
        >
          {m[1]}
        </Text>
      );
      i += m[0].length;
      continue;
    }
    // bold
    m = rest.match(/^\*\*([^*]+)\*\*/);
    if (m) {
      push(<Text key={`${keyBase}b${k++}`} style={{ fontWeight: '700' }}>{m[1]}</Text>);
      i += m[0].length;
      continue;
    }
    // italic
    m = rest.match(/^\*([^*]+)\*/);
    if (m) {
      push(<Text key={`${keyBase}i${k++}`} style={{ fontStyle: 'italic' }}>{m[1]}</Text>);
      i += m[0].length;
      continue;
    }
    // plain run until next special char
    const next = text.slice(i + 1).search(/[`*\[]/);
    const len = next === -1 ? text.length - i : next + 1;
    if (len > 0) {
      push(<Text key={`${keyBase}t${k++}`}>{text.slice(i, i + len)}</Text>);
      i += len;
    } else {
      i += 1;
    }
  }
  return out;
}

/* ── block level ── */

export function Markdown({ text, baseFontSize = 15 }) {
  if (!text) return null;
  const blocks = [];
  let key = 0;

  // split on fenced code blocks
  const parts = text.split(/```/);
  for (let p = 0; p < parts.length; p++) {
    const chunk = parts[p];
    if (p % 2 === 1) {
      // code block: first line may be the language
      const lines = chunk.replace(/^\n/, '').split('\n');
      const lang = lines[0] && lines[0].length < 20 && !lines[0].includes(' ') ? lines.shift() : null;
      blocks.push(
        <View key={key++} style={styles.codeBlock}>
          {lang ? <Text style={styles.codeLang}>{lang}</Text> : null}
          <Text style={styles.codeText}>{lines.join('\n')}</Text>
        </View>
      );
      continue;
    }
    // text chunk → lines → paragraphs / headings / lists
    const lines = chunk.split('\n');
    let listBuf = [];
    const flushList = () => {
      if (!listBuf.length) return;
      blocks.push(
        <View key={key++}>
          {listBuf.map((item, j) => (
            <Text key={j} style={{ fontSize: baseFontSize, lineHeight: 22, color: C.fg }}>
              {'  •  '}{item}
            </Text>
          ))}
        </View>
      );
      listBuf = [];
    };
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) { flushList(); continue; }
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        flushList();
        const size = [baseFontSize + 8, baseFontSize + 6, baseFontSize + 3, baseFontSize + 1][h[1].length - 1];
        blocks.push(
          <Text key={key++} style={{ fontSize: size, fontWeight: '700', color: C.fg, marginTop: 6, marginBottom: 2 }}>
            {h[2]}
          </Text>
        );
        continue;
      }
      const li = line.match(/^\s*[-*]\s+(.*)$/);
      if (li) { listBuf.push(li[1]); continue; }
      flushList();
      blocks.push(
        <Text key={key++} style={{ fontSize: baseFontSize, lineHeight: 22, color: C.fg }}>
          {parseInline(line, `k${key}`)}
        </Text>
      );
    }
    flushList();
  }

  return <View style={{ gap: 4 }}>{blocks}</View>;
}

const styles = StyleSheet.create({
  codeBlock: {
    backgroundColor: C.codeBg,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: C.border,
    padding: 10,
    marginTop: 4,
    marginBottom: 4,
  },
  codeLang: { fontSize: 11, color: C.dim, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 1 },
  codeText: { fontSize: 13, color: C.codeFg, fontFamily: 'monospace' },
  inlineCode: {
    backgroundColor: C.codeBg,
    borderRadius: 4,
    paddingVertical: 1,
    paddingHorizontal: 4,
    color: C.codeFg,
    fontFamily: 'monospace',
  },
  link: { color: C.accent, textDecorationLine: 'underline' },
});
