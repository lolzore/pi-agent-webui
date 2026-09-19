import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, FlatList, TextInput, TouchableOpacity, StyleSheet,
  Modal, Dimensions, KeyboardAvoidingView, Platform, Alert, ActivityIndicator,
  ScrollView, BackHandler, StatusBar,
} from 'react-native';
import { SafeAreaView } from './src/safearea';
import { Bridge } from './src/bridge';
import { wsUrl, httpUrl } from './src/config';
import { loadSettings, saveSettings } from './src/store';
import { MessageBubble } from './src/MessageBubble';
import { ShortsPanel } from './src/ShortsPanel';
import { WebUIHost } from './src/WebUIHost';

const C = {
  fg: '#e6e9ef',
  dim: '#8b93a3',
  accent: '#5aa9ff',
  bg: '#101318',
  panel: '#0c0f14',
  border: '#232a36',
  inputBg: '#151a22',
  ok: '#3fb968',
  warn: '#d9a53f',
  danger: '#e5534b',
};

let msgId = 0;
const nextId = () => `m${++msgId}`;

const blockText = (content) =>
  Array.isArray(content)
    ? content.filter((b) => b.type === 'text').map((b) => b.text).join('')
    : String(content || '');

const blockThinking = (content) =>
  Array.isArray(content)
    ? content.filter((b) => b.type === 'thinking').map((b) => b.thinking).join('')
    : '';

const msgsFromRpc = (list) => {
  const out = [];
  for (const m of list || []) {
    if (m.role === 'user') {
      const t = blockText(m.content);
      if (t) out.push({ id: nextId(), role: 'user', text: t });
    } else if (m.role === 'assistant') {
      const text = blockText(m.content);
      const thinking = blockThinking(m.content);
      if (text || thinking) out.push({ id: nextId(), role: 'assistant', text, thinking });
    } else if (m.role === 'compactionSummary') {
      out.push({ id: nextId(), role: 'system', text: 'conversation compacted' });
    }
  }
  return out;
};

export default function App() {
  /* ── settings / connection ── */
  const [settings, setSettings] = useState(null);      // null while loading
  const [showSetup, setShowSetup] = useState(false);
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const [connectNonce, setConnectNonce] = useState(0);

  /* ── agent state ── */
  const [connected, setConnected] = useState(false);
  const [agentReady, setAgentReady] = useState(false);
  const [messages, setMessages] = useState([]);
  const [streaming, setStreaming] = useState(false);
  const [input, setInput] = useState('');
  const [model, setModel] = useState(null);
  const [models, setModels] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [sessionName, setSessionName] = useState('');
  const [renameText, setRenameText] = useState('');
  const [stats, setStats] = useState(null);

  /* ── ui ── */
  const [showModels, setShowModels] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [showRename, setShowRename] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [shortsOpen, setShortsOpen] = useState(false);
  // "Web UI" mode renders the bridge's own WebUI (in the native WebView2 on
  // Windows, react-native-webview on mobile) instead of the native chat, so the
  // UI is identical to the browser one by definition.
  const [webuiMode, setWebuiMode] = useState(true);
  const [bridgeOk, setBridgeOk] = useState(null); // null = checking
  const [shortsExpanded, setShortsExpanded] = useState(false);
  const [shortsProvider, setShortsProvider] = useState('instagram');
  const [autoOpenShorts, setAutoOpenShorts] = useState(false);
  const [dims, setDims] = useState(Dimensions.get('window'));

  const bridgeRef = useRef(null);
  const listRef = useRef(null);
  const liveRef = useRef(null);
  const initedRef = useRef(false);
  // True while the shorts feed is open *because of* auto-open — manual opens
  // are never closed automatically when the agent settles.
  const autoShortsRef = useRef(false);
  // Mirror of the setting for callbacks whose deps don't include it (onEvent).
  const autoOpenShortsRef = useRef(false);
  autoOpenShortsRef.current = autoOpenShorts;

  const landscape = dims.width > dims.height;
  const shortsWidth = landscape ? Math.max(320, Math.min(520, Math.round(dims.width * 0.42))) : 0;
  const sheetHeight = shortsExpanded ? Math.round(dims.height * 0.92) : Math.round(dims.height * 0.55);

  const httpBase = useMemo(() => httpUrl(settings?.host, settings?.port), [settings]);

  /* ── boot: load settings ── */
  useEffect(() => {
    (async () => {
      const s = await loadSettings();
      setSettings(s);
      setHost(s.host);
      setPort(s.port);
      setShortsProvider(s.shortsProvider || 'instagram');
      setAutoOpenShorts(!!s.autoOpenShorts);
    })();
  }, []);

  /*
   * Is the bridge actually there?
   *
   * Web UI mode covers the whole window, so a dead bridge would leave a Chromium
   * error page with no native controls to fix the address. Check /api/health
   * first and show a native "bridge not reachable" screen instead.
   */
  const checkBridge = useCallback(async () => {
    if (!httpBase || httpBase.includes('undefined')) {
      setBridgeOk(false);
      return false;
    }
    try {
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = setTimeout(() => ctl && ctl.abort(), 2500);
      const r = await fetch(`${httpBase}/api/health`, ctl ? { signal: ctl.signal } : undefined);
      clearTimeout(timer);
      const ok = !!r && r.ok;
      setBridgeOk(ok);
      return ok;
    } catch {
      setBridgeOk(false);
      return false;
    }
  }, [httpBase]);

  useEffect(() => {
    checkBridge();
    // Keep checking only while it is down, so a running bridge is not polled.
    const t = setInterval(() => {
      setBridgeOk((prev) => {
        if (prev === false) checkBridge();
        return prev;
      });
    }, 4000);
    return () => clearInterval(t);
  }, [checkBridge]);

  useEffect(() => {
    const sub = Dimensions.addEventListener('change', ({ window }) => setDims(window));
    return () => sub.remove();
  }, []);

  /* ── message list helpers ── */
  const patchMessage = useCallback((id, patch) => {
    setMessages((msgs) =>
      msgs.map((m) => (m.id === id ? (typeof patch === 'function' ? patch(m) : { ...m, ...patch }) : m))
    );
  }, []);

  const appendMessage = useCallback((m) => setMessages((msgs) => [...msgs, m]), []);

  const scrollBottom = useCallback(() => {
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: false }));
  }, []);

  /* ── agent events (mirrors the WebUI's event handling) ── */
  const onEvent = useCallback((msg) => {
    switch (msg.type) {
      case 'agent_start':
        setStreaming(true);
        // Auto-open the shorts feed when the agent starts running (RN-app
        // only; the ref mirrors the setting because this callback's deps
        // don't include it).
        if (autoOpenShortsRef.current) {
          autoShortsRef.current = true;
          setShortsOpen(true);
        }
        break;
      case 'agent_settled':
      case 'agent_end':
        if (msg.type === 'agent_settled') {
          setStreaming(false);
          // Close only when the agent is fully settled (no retry/compaction/
          // follow-up left) — not at the end of every turn.
          if (autoShortsRef.current) {
            autoShortsRef.current = false;
            setShortsOpen(false);
          }
        }
        if (msg.type === 'agent_end') {
          setStreaming(false);
          refreshStats();
          refreshSessions();
        }
        break;
      case 'session_info_changed':
        if (msg.name) setSessionName(msg.name);
        break;
      case 'message_start': {
        const m = msg.message || {};
        if (m.role === 'user') {
          const text = blockText(m.content);
          if (text) appendMessage({ id: nextId(), role: 'user', text });
          scrollBottom();
        } else if (m.role === 'assistant') {
          liveRef.current = { id: nextId() };
          appendMessage({ id: liveRef.current.id, role: 'assistant', text: '', thinking: '', tools: [], streaming: true });
          scrollBottom();
        }
        break;
      }
      case 'message_update': {
        const ev = msg.assistantMessageEvent || {};
        const live = liveRef.current;
        if (!live) break;
        if (ev.type === 'text_delta') {
          patchMessage(live.id, (m) => ({ ...m, text: (m.text || '') + (ev.delta || '') }));
          scrollBottom();
        } else if (ev.type === 'thinking_delta') {
          patchMessage(live.id, (m) => ({ ...m, thinking: (m.thinking || '') + (ev.delta || '') }));
        } else if (ev.type === 'toolcall_start') {
          patchMessage(live.id, (m) => ({ ...m, tools: [...(m.tools || []), { name: ev.toolName || 'tool', args: '' }] }));
        } else if (ev.type === 'toolcall_delta') {
          patchMessage(live.id, (m) => {
            const tools = [...(m.tools || [])];
            if (tools.length) tools[tools.length - 1] = { ...tools[tools.length - 1], args: (tools[tools.length - 1].args || '') + (ev.delta || '') };
            return { ...m, tools };
          });
        }
        break;
      }
      case 'message_end': {
        const m = msg.message || {};
        const live = liveRef.current;
        if (m.role === 'assistant' && live) {
          const text = blockText(m.content);
          const thinking = blockThinking(m.content);
          patchMessage(live.id, (cur) => ({
            ...cur,
            text: text || cur.text,
            thinking: thinking || cur.thinking,
            streaming: false,
          }));
          liveRef.current = null;
        } else if (m.role === 'toolResult') {
          const text = blockText(m.content);
          appendMessage({ id: nextId(), role: 'tool', text: m.toolName || 'tool', detail: String(text).slice(0, 600) });
          scrollBottom();
        }
        break;
      }
      case 'compaction_end': {
        const r = msg.result || {};
        appendMessage({
          id: nextId(),
          role: 'system',
          text: `compacted · ${r.tokensBefore ?? '?'} → ${r.tokensAfter ?? '?'} tok${msg.reason ? ` · ${msg.reason}` : ''}`,
        });
        break;
      }
      default:
        break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appendMessage, patchMessage, scrollBottom]);

  /* ── data refresh ── */
  const refreshModels = useCallback(async (b) => {
    try {
      const d = await b.rpc({ type: 'get_available_models' });
      setModels(Array.isArray(d) ? d : (d.models || []));
    } catch { /* agent not ready */ }
  }, []);

  const refreshSessions = useCallback(async () => {
    if (!httpBase || httpBase.includes('undefined')) return;
    try {
      const r = await fetch(`${httpBase}/api/sessions`);
      const d = await r.json();
      setSessions(d.sessions || []);
    } catch { /* offline */ }
  }, [httpBase]);

  const refreshStats = useCallback(async () => {
    const b = bridgeRef.current;
    if (!b) return;
    try {
      const d = await b.rpc({ type: 'get_session_stats' });
      setStats(d || null);
    } catch { /* ignore */ }
  }, []);

  const loadState = useCallback(async (b) => {
    try {
      const st = await b.rpc({ type: 'get_state' });
      // Reconnected mid-run: if the agent is already streaming, open the feed
      // the same way agent_start would have.
      if (st.isStreaming && autoOpenShortsRef.current) {
        autoShortsRef.current = true;
        setShortsOpen(true);
      }
      if (st.model) setModel(st.model);
      if (st.sessionName) setSessionName(st.sessionName);
      await refreshModels(b);
      await refreshSessions();
      await refreshStats();
      try {
        const d = await b.rpc({ type: 'get_messages' });
        setMessages(msgsFromRpc(d.messages || d || []));
        scrollBottom();
      } catch { /* empty session */ }
    } catch (e) {
      console.warn('loadState failed', e.message);
    }
  }, [refreshModels, refreshSessions, refreshStats, scrollBottom]);

  /* ── bridge lifecycle (reconnects when host/port changes) ── */
  useEffect(() => {
    if (!settings) return undefined;
    initedRef.current = false;
    setAgentReady(false);
    setConnected(false);

    const b = new Bridge({
      url: wsUrl(settings.host, settings.port),
      onEvent,
      onState: (mode) => {
        setConnected(mode === 'on');
        if (mode === 'off') setAgentReady(false);
      },
      onAgentExit: (info) => {
        setAgentReady(false);
        if (info?.error) appendMessage({ id: nextId(), role: 'system', text: `agent exited: ${info.error}` });
      },
    });
    bridgeRef.current = b;
    b.connect();

    const tryInit = async () => {
      if (initedRef.current || !b.ws || b.ws.readyState !== 1) return;
      initedRef.current = true;
      try {
        const r = await fetch(`${httpBase}/api/sessions`);
        const d = await r.json();
        if (d.sessions && d.sessions.length) {
          await b.rpc({ type: 'switch_session', sessionPath: d.sessions[0].path }, 30000).catch(() => {});
        }
      } catch { /* fresh start */ }
      await loadState(b);
      setAgentReady(true);
    };
    const poll = setInterval(tryInit, 350);

    return () => {
      clearInterval(poll);
      b.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.host, settings?.port, connectNonce]);

  /* ── Android back button: close overlays before leaving the app ── */
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (shortsOpen) { autoShortsRef.current = false; setShortsOpen(false); return true; }
      if (showModels) { setShowModels(false); return true; }
      if (showSessions) { setShowSessions(false); return true; }
      if (showSettings) { setShowSettings(false); return true; }
      if (showSetup) { setShowSetup(false); return true; }
      return false;
    });
    return () => sub.remove();
  }, [shortsOpen, showModels, showSessions, showSettings, showSetup]);

  /* ── actions ── */
  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || !bridgeRef.current || !connected) return;
    setInput('');
    try {
      // steering: a message sent mid-turn is delivered at the next tool boundary
      const cmd = { type: 'prompt', message: text };
      if (streaming) cmd.streamingBehavior = 'steer';
      await bridgeRef.current.rpc(cmd);
    } catch (e) {
      appendMessage({ id: nextId(), role: 'system', text: `send failed: ${e.message}` });
    }
  }, [input, connected, streaming, appendMessage]);

  const stop = useCallback(async () => {
    const b = bridgeRef.current;
    if (!b) return;
    try { await b.rpc({ type: 'clear_queue' }); } catch { /* ignore */ }
    try { await b.rpc({ type: 'abort' }); } catch { /* ignore */ }
  }, []);

  const pickModel = useCallback(async (m) => {
    setShowModels(false);
    try {
      await bridgeRef.current.rpc({ type: 'set_model', provider: m.provider, modelId: m.id });
      setModel({ provider: m.provider, id: m.id, name: m.name });
    } catch (e) {
      Alert.alert('Model switch failed', e.message);
    }
  }, []);

  const pickSession = useCallback(async (s) => {
    setShowSessions(false);
    try {
      await bridgeRef.current.rpc({ type: 'switch_session', sessionPath: s.path });
      setSessionName(s.name || '');
      await loadState(bridgeRef.current);
    } catch (e) {
      Alert.alert('Session switch failed', e.message);
    }
  }, [loadState]);

  const newSession = useCallback(async () => {
    setShowSessions(false);
    try {
      await bridgeRef.current.rpc({ type: 'new_session' });
      setMessages([]);
      setSessionName('');
      await loadState(bridgeRef.current);
    } catch (e) {
      Alert.alert('New session failed', e.message);
    }
  }, [loadState]);

  const doRename = useCallback(async () => {
    const name = renameText.trim();
    setShowRename(false);
    if (!name) return;
    try {
      await bridgeRef.current.rpc({ type: 'set_session_name', name });
      setSessionName(name);
      await refreshSessions();
    } catch (e) {
      Alert.alert('Rename failed', e.message);
    }
  }, [renameText, refreshSessions]);

  const applyConnection = useCallback(async () => {
    const h = host.trim();
    const p = port.trim();
    if (!h) { Alert.alert('Missing host', 'Enter your PC\'s IP address.'); return; }
    const next = await saveSettings({ host: h, port: p, setupDone: true });
    if (next) {
      setSettings(next);
      setShowSetup(false);
      setShowSettings(false);
      setConnectNonce((n) => n + 1);
    }
  }, [host, port]);

  const setShortProvider = useCallback((key) => {
    setShortsProvider(key);
    saveSettings({ shortsProvider: key });
  }, []);

  const toggleAutoOpenShorts = useCallback(() => {
    setAutoOpenShorts((v) => {
      saveSettings({ autoOpenShorts: !v });
      return !v;
    });
  }, []);

  /* ── context ring label ── */
  const fmtTok = (n) => {
    if (n == null) return '–';
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(Math.round(n));
  };
  const cu = stats?.contextUsage;
  const ctxPct = cu?.contextWindow ? Math.min(100, Math.round(((cu.tokens || 0) / cu.contextWindow) * 100)) : null;
  const ctxColor = ctxPct == null ? C.dim : ctxPct >= 90 ? C.danger : ctxPct >= 75 ? C.warn : C.ok;

  const modelLabel = model ? (model.name || model.id) : (agentReady ? 'model' : 'starting…');
  const modelsByProvider = useMemo(() => {
    const groups = new Map();
    for (const m of models) {
      const p = m.provider || 'other';
      if (!groups.has(p)) groups.set(p, []);
      groups.get(p).push(m);
    }
    return [...groups.entries()];
  }, [models]);

  if (!settings) {
    return (
      <View style={[styles.root, styles.center]}>
        <StatusBar barStyle="light-content" />
        <ActivityIndicator color={C.accent} />
      </View>
    );
  }

  /* ── chat column ── */
  const chat = (
    <View style={styles.chatWrap}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.logo}>π</Text>
          <View style={{ flex: 1 }}>
            <TouchableOpacity onPress={() => { setRenameText(sessionName); setShowRename(true); }}>
              <Text style={styles.title} numberOfLines={1}>{sessionName || 'Pi Agent'}</Text>
            </TouchableOpacity>
            <Text style={styles.sub} numberOfLines={1}>
              {!connected ? 'connecting…'
                : !agentReady ? 'starting agent…'
                : streaming ? 'streaming…'
                : ctxPct != null ? `context ${ctxPct}%` : 'ready'}
            </Text>
          </View>
        </View>
        <View style={styles.headerBtns}>
          {ctxPct != null ? (
            <View style={[styles.ctxPill, { borderColor: ctxColor }]}>
              <Text style={[styles.ctxText, { color: ctxColor }]}>{ctxPct}%</Text>
            </View>
          ) : null}
          <TouchableOpacity style={styles.modelBtn} onPress={() => setShowModels(true)}>
            <Text style={styles.modelBtnText} numberOfLines={1}>{modelLabel}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.iconBtn} onPress={() => setShowSessions(true)} hitSlop={8}>
            <Text style={styles.iconText}>☰</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.iconBtn} onPress={() => setShowSettings(true)} hitSlop={8}>
            <Text style={styles.iconText}>⚙</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.iconBtn, webuiMode && styles.iconBtnActive]}
            onPress={() => setWebuiMode(!webuiMode)}
            hitSlop={8}
          >
            <Text style={[styles.iconText, webuiMode && { color: C.accent }]}>▤</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.iconBtn, shortsOpen && styles.iconBtnActive]}
            onPress={() => { if (shortsOpen) autoShortsRef.current = false; setShortsOpen(!shortsOpen); }}
            hitSlop={8}
          >
            <Text style={[styles.iconText, shortsOpen && { color: C.accent }]}>▶</Text>
          </TouchableOpacity>
        </View>
      </View>

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m) => m.id}
        renderItem={({ item }) => <MessageBubble m={item} />}
        style={[styles.list, webuiMode && styles.hidden]}
        contentContainerStyle={styles.listContent}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
      />

      <KeyboardAvoidingView
        style={webuiMode && styles.hidden}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.inputBar}>
          {streaming ? (
            <TouchableOpacity style={styles.stopBtn} onPress={stop}>
              <Text style={styles.stopText}>■</Text>
            </TouchableOpacity>
          ) : null}
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={setInput}
            placeholder={streaming ? 'Steer the agent…' : 'Message the agent…'}
            placeholderTextColor={C.dim}
            multiline
            blurOnSubmit={false}
          />
          <TouchableOpacity
            style={[styles.sendBtn, (!input.trim() || !connected) && styles.sendBtnOff]}
            onPress={send}
          >
            <Text style={styles.sendText}>➤</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </View>
  );

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right', 'bottom']}>
      <StatusBar barStyle="light-content" />
      {webuiMode ? (
        /* Web UI mode: the bridge's own UI in the WebView2 surface, covering the
           whole window. Deliberately NO app chrome -- no header, no bar -- so it
           is pixel-for-pixel the browser UI. The only thing drawn natively is
           the unreachable screen, because a Chromium error page would be a dead
           end with no way to correct the host or port. */
        <View style={styles.fill}>
          {bridgeOk === false ? (
            <View style={styles.center}>
              <Text style={styles.bootTitle}>Bridge not reachable</Text>
              <Text style={styles.bootUrl}>{httpBase}</Text>
              <Text style={styles.bootNote}>
                Start it with start-webui.bat and hit Retry. If the bridge runs on another
                machine, set the host and port.
              </Text>
              <View style={styles.bootRow}>
                <TouchableOpacity style={styles.primaryBtn} onPress={checkBridge}>
                  <Text style={styles.primaryBtnText}>Retry</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.modalClose} onPress={() => setShowSettings(true)}>
                  <Text style={styles.modalCloseText}>Host / port</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            <WebUIHost url={httpBase} />
          )}
        </View>
      ) : (
        <View style={styles.main}>
          {chat}
          {shortsOpen ? (
            <View style={landscape
              ? { width: shortsWidth, height: '100%' }
              : { position: 'absolute', left: 0, right: 0, bottom: 0, height: sheetHeight, zIndex: 10 }}>
              <ShortsPanel
                provider={shortsProvider}
                onProviderChange={setShortProvider}
                autoOpen={autoOpenShorts}
                onAutoOpenToggle={toggleAutoOpenShorts}
                onClose={() => { autoShortsRef.current = false; setShortsOpen(false); }}
                compact={!landscape}
                expanded={shortsExpanded}
                onToggleExpand={!landscape ? () => setShortsExpanded((v) => !v) : undefined}
              />
            </View>
          ) : null}
        </View>
      )}

      {/* first-run / settings setup */}
      <Modal visible={showSetup || showSettings} transparent animationType="fade">
        <View style={styles.modalWrap}>
          <View style={[styles.modalBox, styles.setupBox]}>
            <Text style={styles.modalTitle}>{showSetup ? 'Connect to your PC' : 'Settings'}</Text>
            <ScrollView style={styles.setupScroll} keyboardShouldPersistTaps="handled">
            <Text style={styles.setupHint}>
              The bridge runs alongside this app (start-webui.bat), so `localhost` and port 3080
              are usually right. Use the PC's LAN IP only when connecting from another device.
            </Text>
            <Text style={styles.fieldLabel}>Host / IP</Text>
            <TextInput
              style={styles.fieldInput}
              value={host}
              onChangeText={setHost}
              placeholder="localhost"
              placeholderTextColor={C.dim}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={styles.fieldLabel}>Port</Text>
            <TextInput
              style={styles.fieldInput}
              value={port}
              onChangeText={setPort}
              placeholder="3080"
              placeholderTextColor={C.dim}
              keyboardType="number-pad"
            />
            </ScrollView>
            <TouchableOpacity style={styles.primaryBtn} onPress={applyConnection}>
              <Text style={styles.primaryBtnText}>Connect</Text>
            </TouchableOpacity>
            {!showSetup ? (
              <TouchableOpacity style={styles.modalClose} onPress={() => setShowSettings(false)}>
                <Text style={styles.modalCloseText}>Cancel</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity style={styles.modalClose} onPress={() => setShowSetup(false)}>
                <Text style={styles.modalCloseText}>Skip for now</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </Modal>

      {/* model picker (grouped by provider) */}
      <Modal visible={showModels} transparent animationType="slide">
        <View style={styles.modalWrap}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>Model</Text>
            <ScrollView style={{ maxHeight: 440 }}>
              {modelsByProvider.map(([provider, list]) => (
                <View key={provider}>
                  <Text style={styles.groupTitle}>{provider}</Text>
                  {list.map((item) => {
                    const active = model && model.id === item.id && model.provider === item.provider;
                    return (
                      <TouchableOpacity key={`${item.provider}/${item.id}`} style={styles.modalRow} onPress={() => pickModel(item)}>
                        <Text style={[styles.modalRowText, active && { color: C.accent }]} numberOfLines={1}>
                          {item.name || item.id}
                        </Text>
                        {active ? <Text style={{ color: C.accent }}>✓</Text> : null}
                      </TouchableOpacity>
                    );
                  })}
                </View>
              ))}
              {!models.length ? <Text style={styles.emptyText}>No models available</Text> : null}
            </ScrollView>
            <TouchableOpacity style={styles.modalClose} onPress={() => setShowModels(false)}>
              <Text style={styles.modalCloseText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* sessions */}
      <Modal visible={showSessions} transparent animationType="slide">
        <View style={styles.modalWrap}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>Sessions</Text>
            <TouchableOpacity style={styles.modalRow} onPress={newSession}>
              <Text style={[styles.modalRowText, { color: C.accent }]}>+ New session</Text>
            </TouchableOpacity>
            <FlatList
              data={sessions}
              keyExtractor={(s) => s.path}
              style={{ maxHeight: 360 }}
              renderItem={({ item }) => (
                <TouchableOpacity style={styles.modalRow} onPress={() => pickSession(item)}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.modalRowText} numberOfLines={1}>{item.name}</Text>
                    <Text style={styles.modalRowSub}>
                      {new Date(item.mtime).toLocaleDateString()}
                    </Text>
                  </View>
                </TouchableOpacity>
              )}
            />
            <TouchableOpacity style={styles.modalClose} onPress={() => setShowSessions(false)}>
              <Text style={styles.modalCloseText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* rename */}
      <Modal visible={showRename} transparent animationType="fade">
        <View style={styles.modalWrap}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>Rename session</Text>
            <TextInput
              style={styles.fieldInput}
              value={renameText}
              onChangeText={setRenameText}
              placeholder="Session name"
              placeholderTextColor={C.dim}
              autoFocus
            />
            <TouchableOpacity style={styles.primaryBtn} onPress={doRename}>
              <Text style={styles.primaryBtnText}>Save</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.modalClose} onPress={() => setShowRename(false)}>
              <Text style={styles.modalCloseText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  center: { alignItems: 'center', justifyContent: 'center' },
  main: { flex: 1, flexDirection: 'row' },
  chatWrap: { flex: 1, flexDirection: 'column', backgroundColor: C.bg },
  // "Web UI" mode hides the native chat so the WebView2 surface has the space.
  hidden: { display: 'none' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 10, paddingVertical: 8, borderBottomWidth: 1, borderColor: C.border,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  logo: {
    width: 30, height: 30, borderRadius: 15, backgroundColor: '#12203a',
    color: C.accent, fontSize: 18, textAlign: 'center', fontWeight: '700', lineHeight: 30,
  },
  title: { color: C.fg, fontSize: 15, fontWeight: '700' },
  sub: { color: C.dim, fontSize: 11 },
  headerBtns: { flexDirection: 'row', gap: 4, alignItems: 'center' },
  ctxPill: { borderWidth: 1, borderRadius: 7, paddingHorizontal: 6, paddingVertical: 2 },
  ctxText: { fontSize: 11, fontWeight: '700' },
  modelBtn: {
    backgroundColor: C.inputBg, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6,
    borderWidth: 1, borderColor: C.border, maxWidth: 130,
  },
  modelBtnText: { color: C.fg, fontSize: 12 },
  iconBtn: { padding: 6 },
  iconBtnActive: { backgroundColor: C.inputBg, borderRadius: 8 },
  iconText: { color: C.dim, fontSize: 16 },
  list: { flex: 1 },
  listContent: { paddingVertical: 8 },
  inputBar: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 10,
    borderTopWidth: 1, borderColor: C.border, backgroundColor: C.bg,
  },
  input: {
    flex: 1, backgroundColor: C.inputBg, borderRadius: 10, color: C.fg, fontSize: 15,
    paddingHorizontal: 12, paddingVertical: 9, maxHeight: 120,
    borderWidth: 1, borderColor: C.border,
  },
  sendBtn: { width: 42, height: 40, borderRadius: 10, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  sendBtnOff: { backgroundColor: '#2a3140' },
  sendText: { color: '#fff', fontSize: 16 },
  stopBtn: {
    width: 42, height: 40, borderRadius: 10, backgroundColor: '#3a1f1f',
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.danger,
  },
  stopText: { color: C.danger, fontSize: 15 },
  modalWrap: { flex: 1, backgroundColor: 'rgba(0,0,0,0.62)', justifyContent: 'center', padding: 16 },
  modalBox: {
    backgroundColor: C.panel, borderRadius: 16, padding: 14,
    width: '100%', maxWidth: 460, maxHeight: '82%', alignSelf: 'center',
  },
  // The setup / settings pane can get tall on a small window, so it scrolls
  // instead of stretching past the screen.
  setupBox: {},
  setupScroll: { maxHeight: 420 },
  // Web UI mode is a full-window surface with no app chrome; these are only for
  // the "bridge not reachable" screen that replaces it.
  fill: { flex: 1 },
  bootTitle: { color: C.fg, fontSize: 18, fontWeight: '700', marginBottom: 4 },
  bootUrl: { color: C.accent, fontSize: 13, marginBottom: 10 },
  bootNote: { color: C.dim, fontSize: 13, lineHeight: 19, textAlign: 'center', maxWidth: 420 },
  bootRow: { flexDirection: 'row', gap: 10, alignItems: 'center', marginTop: 16 },
  modalTitle: { color: C.fg, fontSize: 15, fontWeight: '700', marginBottom: 8 },
  setupHint: { color: C.dim, fontSize: 12, lineHeight: 17, marginBottom: 10 },
  fieldLabel: { color: C.dim, fontSize: 11, marginTop: 8, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 },
  fieldInput: {
    backgroundColor: C.inputBg, borderWidth: 1, borderColor: C.border, borderRadius: 9,
    color: C.fg, paddingHorizontal: 11, paddingVertical: 10, fontSize: 15,
  },
  primaryBtn: {
    backgroundColor: C.accent, borderRadius: 10, alignItems: 'center',
    paddingVertical: 12, marginTop: 14,
  },
  primaryBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  groupTitle: {
    color: C.dim, fontSize: 11, fontWeight: '700', letterSpacing: 0.6,
    textTransform: 'uppercase', marginTop: 10, marginBottom: 2,
  },
  emptyText: { color: C.dim, fontSize: 13, paddingVertical: 14, textAlign: 'center' },
  modalRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 10, borderBottomWidth: 1, borderColor: C.border,
  },
  modalRowText: { color: C.fg, fontSize: 14, flex: 1 },
  modalRowSub: { color: C.dim, fontSize: 11 },
  modalClose: { alignItems: 'center', paddingVertical: 12, marginTop: 6 },
  modalCloseText: { color: C.dim, fontSize: 14 },
});
