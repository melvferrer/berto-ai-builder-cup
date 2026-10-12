/**
 * Voice I/O. Speech out is true Taglish: Filipino words in a Filipino voice, English/medical terms
 * (blood glucose, mg/dL, metformin…) in an English voice. Filipino text is never read by an English voice.
 * Speech in: recorded on the phone and transcribed on Berto's server (Whisper); browser speech recognition
 * and typing are fallbacks only.
 */
import { getLocale, getLang } from './i18n';
import { splitTaglish, expandEnglish } from '../shared/taglish.js';

let filVoice: SpeechSynthesisVoice | null = null;
let voicesChecked = false;

/*
 * Speech out, in fallback order:
 *   1. Berto's server voice (GET /api/tts -> one MP3; Filipino runs fil-PH-AngeloNeural, English runs en-PH-JamesNeural).
 *   2. Device voices: Filipino runs with an installed fil/tl voice; English runs with an en-PH (or other en) voice.
 *      Requires a Filipino voice — without one we stay silent rather than read only fragments.
 *   3. Silent + hint. Filipino text is never spoken by an English voice.
 */
let enVoice: SpeechSynthesisVoice | null = null;
let extraTerms: string[] = [];
/** English terms that aren't in the built-in lexicon, e.g. the user's medicine names. */
export function setSpeechTerms(terms: string[]) { extraTerms = terms.filter(Boolean).slice(0, 30); }
let serverVoice: 'unknown' | 'ok' | 'failed' = 'unknown';
let serverFailures = 0;
const audio = new Audio();
audio.preload = 'auto';
(audio as any).playsInline = true;
let unlocked = false;
let onVoiceLost: (() => void) | null = null;

// Tiny silent MP3 (public/silence.mp3) played during the first user gesture to unlock audio on iOS.
const SILENT_MP3 = '/silence.mp3';

/** Call once at startup. Unlocks the shared <audio> element on the first tap/click/key (required by iOS). */
export function installAudioUnlock() {
  const events = ['touchend', 'click', 'keydown'];
  let unlocking = false;
  const done = () => { unlocked = true; unlocking = false; events.forEach((ev) => document.removeEventListener(ev, unlock, true)); };
  function unlock() {
    if (unlocked || unlocking) return;
    unlocking = true;
    try {
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (AC) { const ac = new AC(); ac.resume?.().then(() => ac.close?.()).catch(() => {}); }
      if (!audio.paused) { done(); return; } // already playing Berto's voice -> already unlocked
      audio.src = SILENT_MP3;
      audio.play().then(done).catch((e: DOMException) => {
        unlocking = false;
        if (e?.name === 'AbortError') done(); // interrupted by real speech in the same tap: still unlocked
      });
    } catch { unlocking = false; }
  }
  events.forEach((ev) => document.addEventListener(ev, unlock, true));
}

function pickVoice(): SpeechSynthesisVoice | null {
  if (!('speechSynthesis' in window)) return null;
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return null;
  voicesChecked = true;
  const isFil = (v: SpeechSynthesisVoice) => /^(fil|tl)([-_]|$)/i.test(v.lang) || /filipino|tagalog/i.test(v.name);
  const fil = voices.filter(isFil);
  fil.sort((a, b) => Number(/fil[-_]PH/i.test(b.lang)) - Number(/fil[-_]PH/i.test(a.lang)) || Number(b.localService) - Number(a.localService));
  // English voice for English runs only: Philippine English first, then any English.
  const en = voices.filter((v) => /^en([-_]|$)/i.test(v.lang));
  en.sort((a, b) => Number(/en[-_]PH/i.test(b.lang)) - Number(/en[-_]PH/i.test(a.lang)) || Number(b.localService) - Number(a.localService));
  enVoice = en[0] ?? null;
  return fil[0] ?? null;
}

async function checkServerVoice(): Promise<boolean> {
  try {
    const r = await fetch('/api/tts/status', { cache: 'no-store' });
    const j = r.ok ? await r.json() : null;
    serverVoice = j?.available ? 'ok' : 'failed';
  } catch { serverVoice = 'failed'; }
  return serverVoice === 'ok';
}

/**
 * Resolve which voices are available. onReady(true) when Berto can speak (server or device fil voice).
 * onLost fires later if the server voice keeps failing and there is no device fil voice.
 */
export function initVoices(onReady: (canSpeak: boolean) => void, onLost?: () => void) {
  onVoiceLost = onLost ?? null;
  let reported = false;
  const deviceReady = new Promise<void>((resolve) => {
    if (!('speechSynthesis' in window)) { voicesChecked = true; resolve(); return; }
    const done = () => { filVoice = pickVoice(); if (voicesChecked) resolve(); };
    done();
    speechSynthesis.addEventListener('voiceschanged', () => { filVoice = pickVoice(); resolve(); });
    setTimeout(() => { voicesChecked = true; filVoice = pickVoice(); resolve(); }, 2500);
  });
  checkServerVoice().then((ok) => {
    if (ok && !reported) { reported = true; onReady(true); }
    else deviceReady.then(() => { if (!reported) { reported = true; onReady(!!filVoice); } });
  });
}

export const hasFilVoice = () => serverVoice === 'ok' || !!filVoice;

/** Clean text for speech: symbols removed (units are expanded per English run). */
function forSpeech(text: string): string {
  return text
    .replace(/[“”"✓›⬆︎⏰🔔🎙📞⬇🎉]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}

type Hooks = { onStart?: () => void; onEnd?: () => void };
let speakToken = 0;
let cancelCurrent: (() => void) | null = null;

function speakDevice(text: string, hooks: Hooks) {
  if (getLang() !== 'fil' && 'speechSynthesis' in window) {
    // non-Taglish languages: one utterance with any installed voice for that language
    const want = getLocale().slice(0, 2).toLowerCase();
    const v = speechSynthesis.getVoices().find((x) => x.lang.toLowerCase().startsWith(want));
    if (!v) { hooks.onEnd?.(); return; }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text); u.voice = v; u.lang = v.lang; u.rate = 0.95;
    u.onstart = () => hooks.onStart?.(); u.onend = u.onerror = () => hooks.onEnd?.();
    speechSynthesis.speak(u); return;
  }
  if (!filVoice || !('speechSynthesis' in window)) { hooks.onEnd?.(); return; }
  speechSynthesis.cancel();
  const runs = splitTaglish(text, extraTerms);
  if (!runs.length) { hooks.onEnd?.(); return; }
  runs.forEach((r, i) => {
    const useEn = r.lang === 'en' && enVoice;
    const v = useEn ? enVoice! : filVoice!; // Filipino runs ALWAYS use the Filipino voice
    const u = new SpeechSynthesisUtterance(useEn ? expandEnglish(r.text) : r.text);
    u.voice = v;
    u.lang = v.lang || getLocale();
    u.rate = 0.95;
    if (i === 0) u.onstart = () => hooks.onStart?.();
    if (i === runs.length - 1) u.onend = () => hooks.onEnd?.();
    u.onerror = () => { if (i === runs.length - 1) hooks.onEnd?.(); };
    speechSynthesis.speak(u);
  });
}

function speakServer(text: string, hooks: Hooks, token: number) {
  let settled = false;
  const finish = (fallback: boolean) => {
    if (settled) return;
    settled = true;
    clearTimeout(startTimer);
    audio.onplaying = audio.onended = audio.onerror = null;
    if (token !== speakToken) return; // superseded by a newer utterance
    if (fallback) speakDevice(text, hooks); else hooks.onEnd?.();
  };
  // Never leave the orb pulsing if audio is slow to start.
  const startTimer = window.setTimeout(() => { audio.pause(); finish(true); }, 10_000);
  cancelCurrent = () => { settled = true; clearTimeout(startTimer); audio.onplaying = audio.onended = audio.onerror = null; };
  audio.onplaying = () => { clearTimeout(startTimer); serverFailures = 0; hooks.onStart?.(); };
  audio.onended = () => finish(false);
  audio.onerror = () => {
    serverFailures++;
    if (serverFailures >= 3) { serverVoice = 'failed'; if (!filVoice) onVoiceLost?.(); }
    finish(true);
  };
  const start = (src: string) => {
    if (settled || token !== speakToken) return;
    audio.src = src;
    audio.play().catch(onPlayError);
  };
  const pre = ttsCache.get(text);
  if (pre) { ttsCache.delete(text); pre.then(start, () => start(ttsUrl(text))); }
  else start(ttsUrl(text));
  function onPlayError(e: DOMException) {
    // NotAllowedError = audio not yet unlocked by a tap (iOS); stay quiet rather than block the UI.
    if (e?.name === 'NotAllowedError') { if (filVoice) finish(true); else { settled = true; clearTimeout(startTimer); hooks.onEnd?.(); } }
    else if (e?.name !== 'AbortError') audio.onerror?.(new Event('error'));
  }
}

/** Server TTS URL for one utterance. */
function ttsUrl(text: string) {
  return `/api/tts?lang=${getLang()}&text=${encodeURIComponent(text)}${extraTerms.length ? `&terms=${encodeURIComponent(extraTerms.join(','))}` : ''}`;
}
/** Audio fetched ahead of time, so queued sentences play back-to-back with no gap. */
const ttsCache = new Map<string, Promise<string>>();
export function prefetchSpeech(raw: string) {
  if (serverVoice === 'failed') return;
  const text = forSpeech(raw);
  if (!text || ttsCache.has(text)) return;
  const p = fetch(ttsUrl(text)).then((r) => { if (!r.ok) throw new Error('tts'); return r.blob(); })
    .then((b) => URL.createObjectURL(b));
  p.catch(() => {});
  ttsCache.set(text, p);
}

export function speak(raw: string, hooks: Hooks = {}) {
  const text = forSpeech(raw);
  const token = ++speakToken;
  stopSpeaking(false);
  if (!text) { hooks.onEnd?.(); return; }
  if (serverVoice !== 'failed') speakServer(text, hooks, token);
  else speakDevice(text, hooks);
}

export function stopSpeaking(bump = true) {
  if (bump) speakToken++;
  cancelCurrent?.();
  cancelCurrent = null;
  try { audio.pause(); } catch { /* ignore */ }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

/*
 * Speech in, in fallback order:
 *   1. Record on the phone (getUserMedia + MediaRecorder; iPhone -> audio/mp4 AAC, Chrome/Android -> audio/webm Opus)
 *      and transcribe on Berto's server (POST /api/stt, local Whisper by default). Works in the iPhone Home Screen
 *      app, where the browser's own speech recognition is missing. Audio is not stored.
 *   2. Browser speech recognition (webkitSpeechRecognition, fil-PH) if recording or the server keeps failing.
 *   3. Typing, only when both are unavailable.
 */
type SR = { lang: string; interimResults: boolean; maxAlternatives: number; continuous: boolean;
  start(): void; stop(): void; abort(): void;
  onresult: ((e: any) => void) | null; onerror: ((e: any) => void) | null; onend: (() => void) | null };

export type ListenCallbacks = {
  onText: (text: string) => void;
  onInterim?: (t: string) => void;
  /** 0..1 microphone level while recording (for the orb). */
  onLevel?: (level: number) => void;
  /** Recording finished; the audio is being transcribed. */
  onProcessing?: () => void;
  onError: (code: string) => void;
  onEnd: () => void;
};

const browserSR = () => { const w = window as any; return w.SpeechRecognition || w.webkitSpeechRecognition; };
const recorderSupported = () => !!((navigator.mediaDevices as any)?.getUserMedia && (window as any).MediaRecorder);
let serverSttFailures = 0;
const useServerStt = () => recorderSupported() && serverSttFailures < 2;

export function sttSupported(): boolean { return recorderSupported() || !!browserSR(); }

const MAX_MS = 15_000;      // hard stop
const SILENCE_MS = 1_500;   // stop after this much quiet once speech started
const NO_SPEECH_MS = 7_000; // give up if nothing is said
const MIN_MS = 600;

function pickMime(): string {
  const MR = (window as any).MediaRecorder;
  for (const m of ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'])
    if (MR.isTypeSupported?.(m)) return m;
  return '';
}

let active: { stop: () => void; kind: 'rec' | 'sr'; phase: 'listening' | 'processing' } | null = null;

async function recordAndTranscribe(cb: ListenCallbacks) {
  const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
  const ac: AudioContext | null = AC ? new AC() : null; // created inside the tap (iOS)
  ac?.resume?.().catch(() => {});
  let stream: MediaStream;
  const state = { stop: () => {}, kind: 'rec' as const, phase: 'listening' as 'listening' | 'processing' };
  active = state;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  } catch (e: any) {
    active = null; ac?.close?.().catch(() => {});
    const n = e?.name;
    cb.onError(n === 'NotAllowedError' || n === 'SecurityError' ? 'not-allowed' : n === 'NotFoundError' ? 'no-mic' : 'rec-failed');
    cb.onEnd(); return;
  }
  const release = () => { stream.getTracks().forEach((t) => t.stop()); ac?.close?.().catch(() => {}); };
  let rec: MediaRecorder;
  try {
    const mime = pickMime();
    rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32_000 } : undefined);
  } catch {
    release(); active = null; cb.onError('rec-failed'); cb.onEnd(); return;
  }
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };

  // Simple level detection: adaptive noise floor; stop after SILENCE_MS of quiet once speech was heard.
  let raf = 0; let heard = false; let lastLoud = 0; let floor = 0.01; const t0 = performance.now();
  let analyser: AnalyserNode | null = null; let buf: Float32Array | null = null;
  try {
    if (ac) { analyser = ac.createAnalyser(); analyser.fftSize = 1024; ac.createMediaStreamSource(stream).connect(analyser); buf = new Float32Array(analyser.fftSize); }
  } catch { analyser = null; }
  const tick = () => {
    if (state.phase !== 'listening') return;
    const now = performance.now(); const el = now - t0;
    if (analyser && buf) {
      analyser.getFloatTimeDomainData(buf as any);
      let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      if (el < 400) floor = Math.max(floor, rms); // ambient noise at the start
      const thr = Math.max(0.015, floor * 2.5);
      if (rms > thr) { heard = true; lastLoud = now; }
      cb.onLevel?.(Math.min(1, rms / 0.15));
      if (heard && now - lastLoud > SILENCE_MS && el > MIN_MS) { finish(); return; }
      if (!heard && el > NO_SPEECH_MS) { finish(); return; }
    }
    if (el > MAX_MS) { finish(); return; }
    raf = requestAnimationFrame(tick);
  };
  // rAF pauses in the background; a timer guarantees the hard stop
  const hardStop = window.setTimeout(() => finish(), MAX_MS + 300);

  const done = new Promise<void>((resolve) => { rec.onstop = () => resolve(); });
  function finish() {
    if (state.phase !== 'listening') return;
    state.phase = 'processing';
    cancelAnimationFrame(raf); clearTimeout(hardStop);
    try { rec.state !== 'inactive' && rec.stop(); } catch { /* ignore */ }
  }
  state.stop = finish;
  rec.start();
  raf = requestAnimationFrame(tick);
  await done;
  release();
  cb.onLevel?.(0);
  const type = (rec.mimeType || chunks[0]?.type || 'audio/mp4').split(';')[0];
  const blob = new Blob(chunks, { type });
  chunks.length = 0;
  if (analyser && !heard) { active = null; cb.onError('no-speech'); cb.onEnd(); return; }
  cb.onProcessing?.();
  try {
    const r = await fetch(`/api/stt?lang=${getLang()}`, { method: 'POST', headers: { 'content-type': type }, body: blob, signal: AbortSignal.timeout?.(25_000) });
    const j = r.ok ? await r.json() : null;
    if (!j) throw new Error(`stt ${r.status}`);
    serverSttFailures = 0;
    active = null;
    if (j.text?.trim()) cb.onText(j.text.trim()); else cb.onError('no-speech');
  } catch {
    serverSttFailures++;
    active = null;
    cb.onError('stt-failed');
  }
  cb.onEnd();
}

function browserListen(cb: ListenCallbacks) {
  const Ctor = browserSR();
  if (!Ctor) { cb.onError('unsupported'); cb.onEnd(); return; }
  const rec: SR = new Ctor();
  rec.lang = getLocale();
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  rec.continuous = false;
  let finalText = '';
  let errored = false;
  rec.onresult = (e: any) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
    }
    if (interim) cb.onInterim?.(interim);
  };
  rec.onerror = (e: any) => { errored = true; cb.onError(e.error || 'error'); };
  rec.onend = () => {
    active = null;
    if (finalText.trim()) cb.onText(finalText.trim()); else if (!errored) cb.onError('no-speech');
    cb.onEnd();
  };
  active = { stop: () => rec.stop(), kind: 'sr', phase: 'listening' };
  try { rec.start(); } catch { active = null; cb.onError('error'); cb.onEnd(); }
}

/** Tap-to-talk: records until ~1.5 s of silence (or stopListening / 15 s), then transcribes. */
export function listen(cb: ListenCallbacks) {
  stopSpeaking();
  if (useServerStt()) {
    let fellBack = false;
    recordAndTranscribe({ ...cb,
      onError: (code) => {
        // recording itself is impossible here (old browser / no recorder) -> try the browser recogniser
        if (code === 'rec-failed' && browserSR()) { serverSttFailures = 99; fellBack = true; return; }
        cb.onError(code);
      },
      onEnd: () => { if (fellBack) browserListen(cb); else cb.onEnd(); },
    });
    return;
  }
  browserListen(cb);
}

/** Stop recording now (the audio is still transcribed). No-op while transcribing. */
export function stopListening() { if (active?.phase === 'listening') active.stop(); }
export const isListening = () => !!active;
export const isTranscribing = () => active?.phase === 'processing';
