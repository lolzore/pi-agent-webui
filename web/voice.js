/*
 * Voice input (browser SpeechRecognition and whisper) and text-to-speech.
 *
 * Split out of app.js (issue #54). Loaded before app.js; the names stay
 * global, so nothing else changed. Behaviour is unchanged.
 */
'use strict';

/* ───────────────────────── voice to text ───────────────────────── */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null, recogBase = '', recogActive = false, recogAborted = false;

if (!SR) {
  $('btn-mic').title = 'Browser voice unavailable — configure a Whisper endpoint in settings for voice input';
} else {
  recog = new SR();
  recog.interimResults = true;
  recog.continuous = true; // keep listening until the mic is clicked again
  recog.lang = navigator.language || 'en-US';

  recog.onresult = (e) => {
    let finalText = '', interim = '';
    for (let i = 0; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    input.value = (recogBase + finalText + interim).replace(/\s+$/, ' ');
    autoSize();
  };
  recog.onend = () => {
    recogActive = false;
    $('btn-mic').classList.remove('recording');
    // Optional hands-free mode: send what was dictated once recognition ends.
    if (SET.voiceAutoSend && !recogAborted && input.value.trim()) sendCurrent();
  };
  recog.onerror = (e) => {
    recogActive = false;
    $('btn-mic').classList.remove('recording');
    if (e.error === 'not-allowed') toast('Microphone permission denied', 'error');
    else if (e.error === 'aborted') recogAborted = true;
    else if (e.error !== 'aborted') toast(`Voice input error: ${e.error}`, 'error');
  };
}

/* Whisper-compatible speech-to-text (whisper.cpp server /inference, or any
 * OpenAI-style /v1/audio/transcriptions). The recording is converted to
 * 16 kHz mono WAV in the browser first, so Firefox (ogg) and Chrome (webm)
 * both work. Falls back to browser SpeechRecognition without an endpoint. */
async function blobToWav(blob) {
  const buf = await blob.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const decoded = await ctx.decodeAudioData(buf);
    const src = decoded.getChannelData(0);
    const rate = 16000;
    // whisper.cpp rejects very short clips - pad to at least 1.2 s of audio
    const minSamples = Math.ceil(1.2 * rate);
    const outLen = Math.max(minSamples, Math.ceil(src.length * rate / decoded.sampleRate));
    const pcm = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const v = src[Math.min(src.length - 1, Math.floor(i * decoded.sampleRate / rate))];
      pcm[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
    }
    const wav = new ArrayBuffer(44 + pcm.length * 2);
    const dv = new DataView(wav);
    const wstr = (o, t) => { for (let i = 0; i < t.length; i++) dv.setUint8(o + i, t.charCodeAt(i)); };
    wstr(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); wstr(8, 'WAVE');
    wstr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    wstr(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
    new Int16Array(wav, 44).set(pcm);
    return new Blob([wav], { type: 'audio/wav' });
  } finally {
    // An AudioContext holds a real audio device and its own thread. close() was
    // only on the happy path, so every audio attachment the browser could not
    // decode leaked one - and the caller catches that failure and carries on, so
    // it leaked silently. 5 s of audio could do it half a dozen times.
    try { ctx.close(); } catch { /* already closed */ }
  }
}

async function transcribeWithWhisper(blob) {
  const wav = await blobToWav(blob);
  const endpoint = sttEndpointUrl();
  const isOpenAI = /\/v1\/audio\/transcriptions\/?$/.test(endpoint);
  const fd = new FormData();
  if (isOpenAI) {
    fd.append('file', wav, 'speech.wav');
    fd.append('model', 'whisper-1');
    fd.append('response_format', 'json');
  } else {
    // whisper.cpp server's /inference reads the audio from the multipart
    // field named "file" (NOT "audio_file"). Any 400 it returns is
    // overwritten by its error handler with the generic "Invalid request",
    // so a wrong field name surfaces as that cryptic message.
    fd.append('file', wav, 'speech.wav');
    fd.append('response_format', 'json');
  }
  const res = await fetch(endpoint, { method: 'POST', body: fd });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 120); } catch { /* ignore */ }
    throw new Error(`STT server ${res.status} ${detail}`);
  }
  const d = await res.json();
  return d.text || d.transcription || '';
}

let mediaRecorder = null, mediaStream = null, recAudioChunks = [], whisperBusy = false;

async function startWhisperRecording() {
  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  recAudioChunks = [];
  mediaRecorder = new MediaRecorder(mediaStream);
  mediaRecorder.ondataavailable = (e) => { if (e.data.size) recAudioChunks.push(e.data); };
  mediaRecorder.onstop = async () => {
    mediaStream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(recAudioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
    $('btn-mic').classList.remove('recording');
    if (blob.size < 800) return; // just a click
    whisperBusy = true;
    $('btn-mic').classList.add('recording'); // stays lit while transcribing
    try {
      const text = await transcribeWithWhisper(blob);
      if (text) {
        input.value = (input.value ? input.value.replace(/\s+$/, '') + ' ' : '') + text.trim();
        autoSize();
        if (SET.voiceAutoSend) sendCurrent();
      } else toast('Whisper heard nothing');
    } catch (e) {
      toast(`Whisper failed: ${e.message}`, 'error');
    } finally {
      whisperBusy = false;
      $('btn-mic').classList.remove('recording');
    }
  };
  mediaRecorder.start();
  $('btn-mic').classList.add('recording');
  toast('Recording… click again to transcribe with Whisper');
}

/* True for endpoints that point at this machine's own whisper server
 * (localhost): those die with the bridge, so a mic click re-checks them and
 * restarts the selected model if needed. A custom endpoint on another machine
 * is trusted as-is. */
function isLocalSttEndpoint(u) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(u || '');
}

/* The URL to actually send audio to. The local whisper server is stored as
 * http://localhost:PORT/… - but when the WebUI is browsed from another machine
 * on the LAN, that "localhost" must mean the machine the bridge runs on (this
 * page's host), not the client's own. Custom endpoints are used as-is. */
function sttEndpointUrl() {
  const u = SET.sttEndpoint;
  if (!u || !isLocalSttEndpoint(u)) return u;
  try {
    const parsed = new URL(u);
    parsed.hostname = location.hostname || 'localhost';
    return parsed.toString();
  } catch { return u; }
}

$('btn-mic').onclick = async () => {
  if (whisperBusy) return;
  const useWhisper = (SET.sttBackend || 'whisper') !== 'browser';
  if (useWhisper) {
    // Second click while recording: stop and transcribe - no server checks.
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      return;
    }
    // Automatic start: make sure the model picked in settings is actually
    // being served - reuse a running local server, switch it to the selected
    // model, or start it (first use downloads whisper.cpp + the model).
    // A custom endpoint on another machine is used as-is.
    if (!SET.sttEndpoint || isLocalSttEndpoint(SET.sttEndpoint)) {
      whisperBusy = true; // no double-clicks while a download is running
      $('btn-mic').classList.add('recording'); // lit while it comes up
      const url = await ensureWhisper(false);
      whisperBusy = false;
      $('btn-mic').classList.remove('recording');
      if (!url && isLocalSttEndpoint(SET.sttEndpoint)) SET.sttEndpoint = ''; // dead local endpoint
    }
    if (SET.sttEndpoint) {
      startWhisperRecording().catch((e) => {
        $('btn-mic').classList.remove('recording');
        toast(`Microphone error: ${e.message}`, 'error');
      });
      return;
    }
    // The local server could not be started (offline, server failed): fall
    // back to browser voice instead of a dead endpoint.
    if (recog) toast('Whisper server is not available - using browser voice instead', 'warning');
  }
  // browser SpeechRecognition fallback
  if (!recog) { toast('This browser has no built-in voice — set a Whisper endpoint in settings (⚙) for voice input', 'warning'); return; }
  if (recogActive) { recogAborted = true; recog.stop(); return; }
  recogBase = input.value ? input.value.replace(/\s+$/, '') + ' ' : '';
  recogAborted = false;
  try {
    recog.start();
    recogActive = true;
    $('btn-mic').classList.add('recording');
    if (SET.voiceAutoSend) toast('Listening… will auto-send when you stop talking');
  } catch { /* already started */ }
};

/* ───────────────────────── TTS ───────────────────────── */

/* The voice list, fetched once and kept.
 *
 * speechSynthesis.getVoices() can block for a second or more the first time it
 * is called - Firefox starts its speech service there - and the settings click
 * asked for it twice (the select's list and the current voice) before
 * showModal(), so the dialog waited on the speech service to come up. The list
 * is fetched once, after the page has painted and whenever the browser says it
 * changed; every later call is a lookup. */
let ttsVoiceCache = null;
function ttsVoices() {
  if (ttsVoiceCache === null) {
    try { ttsVoiceCache = speechSynthesis.getVoices() || []; } catch { ttsVoiceCache = []; }
  }
  return ttsVoiceCache;
}

/* Has the list been fetched yet? (An empty list still counts as fetched - the
 * browser simply has no voices.) The settings voice dropdown uses this to
 * decide whether opening it can just list the voices or has to fetch first. */
function ttsVoicesReady() {
  return ttsVoiceCache !== null;
}

/* The browser told us the list changed (or we are warming it): forget what we
 * had and fetch the new one. */
function refreshTtsVoices() {
  ttsVoiceCache = null;
  return ttsVoices();
}

// Sensible default: prefer a natural-sounding en voice when none is chosen.
function pickDefaultVoice() {
  const voices = ttsVoices();
  if (!voices.length) return null;
  const pref = [
    (v) => /natural|neural/i.test(v.name),
    (v) => /google (us|uk) english/i.test(v.name),
    (v) => /en[-_]/i.test(v.lang) && /microsoft|apple|zira|david|aria/i.test(v.name),
    (v) => /^en/i.test(v.lang),
  ];
  for (const p of pref) {
    const hit = voices.find(p);
    if (hit) return hit;
  }
  return voices[0];
}

function currentTtsVoice() {
  if (SET.ttsVoiceURI) {
    const v = ttsVoices().find((v) => v.voiceURI === SET.ttsVoiceURI);
    if (v) return v;
  }
  return pickDefaultVoice();
}

/* Speak via a local OpenAI-compatible TTS server (/v1/audio/speech):
 * openedai-speech, speaches, alltalk, etc. — small models like Piper with
 * trainable/clonable voices. Returns a promise that resolves when done. */
/* Speech through the bridge, for a cloud voice: a browser cannot call those
 * services itself (no CORS, and the API key would sit in the page). The bridge
 * holds the key and streams the audio back. */
async function speakCloud(text) {
  return speakInBatches(text, async (chunk) => {
    const res = await fetch(api('/api/tts'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: SET.ttsBackend,
        text: chunk,
        model: SET.ttsCloudModel || undefined,
        voice: SET.ttsCloudVoice || undefined,
        baseUrl: SET.ttsCloudUrl || undefined,
      }),
    });
    if (!res.ok) {
      let msg = `TTS ${res.status}`;
      try { const d = await res.json(); if (d && d.error) msg = d.error; } catch { /* not json */ }
      throw new Error(msg);
    }
    return res.blob();
  });
}

async function speakEndpoint(text) {
  return speakInBatches(text, async (chunk) => {
    const res = await fetch(SET.ttsEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: SET.ttsModel || 'piper', input: chunk, voice: SET.ttsVoiceName || undefined, response_format: 'wav' }),
    });
    if (!res.ok) throw new Error(`TTS server ${res.status}`);
    return res.blob();
  });
}

/* Split a reply into pieces a service will accept, hand each one to `getAudio`,
 * and play what comes back in order. */
async function speakInBatches(text, getAudio) {
  const chunks = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
  let batch = '', buffers = [];
  const flush = async () => {
    if (!batch.trim()) return;
    buffers.push(await getAudio(batch.trim()));
    batch = '';
  };
  for (const c of chunks) {
    if ((batch + c).length > 600) await flush();
    batch += c;
  }
  await flush();
  S.speaking = true;
  $('btn-tts').classList.add('on');
  for (const b of buffers) {
    await new Promise((done) => {
      const a = new Audio(URL.createObjectURL(b));
      a.onended = done;
      a.onerror = done;
      a.play();
    });
  }
  S.speaking = false;
  $('btn-tts').classList.remove('on');
}

function speak(text) {
  if (SET.ttsBackend === 'fish' || SET.ttsBackend === 'openai') {
    return speakCloud(text).catch((e) => toast(`Speech failed: ${e.message}`, 'error'));
  }
  if (!('speechSynthesis' in window) && SET.ttsBackend !== 'endpoint') {
    toast('Speech synthesis not supported', 'warning');
    return;
  }
  const clean = stripMarkdown(text);
  if (!clean) return;
  if (SET.ttsBackend === 'endpoint') {
    if (!SET.ttsEndpoint) { toast('Set a TTS server URL in settings first', 'warning'); return; }
    speechSynthesis.cancel();
    speakEndpoint(clean).catch((e) => {
      S.speaking = false;
      $('btn-tts').classList.remove('on');
      toast(`TTS failed: ${e.message}`, 'error');
    });
    return;
  }
  speechSynthesis.cancel();
  const voice = currentTtsVoice();
  // Chunk long text: some engines truncate very long utterances.
  for (const chunk of clean.match(/[\s\S]{1,220}(?=\s|$)|[\s\S]{1,220}/g) || []) {
    const u = new SpeechSynthesisUtterance(chunk);
    if (voice) { u.voice = voice; u.lang = voice.lang; }
    u.rate = SET.ttsRate || 1.05;
    u.onend = () => {
      if (!speechSynthesis.speaking) { S.speaking = false; $('btn-tts').classList.remove('on'); }
    };
    speechSynthesis.speak(u);
  }
  S.speaking = true;
  $('btn-tts').classList.add('on');
}


function setAutoTts(on) {
  S.autoTts = on;
  applySettings();
  $('btn-tts').title = on ? 'Auto-speak ON — click to disable (or type /tts)' : 'Speak agent replies out loud (or type /tts)';
  if (!on) speechSynthesis.cancel();
  toast(on ? `Auto-speak enabled${currentTtsVoice() ? `: ${currentTtsVoice().name}` : ''}` : 'Auto-speak disabled');
}

$('btn-tts').onclick = () => setAutoTts(!S.autoTts);
