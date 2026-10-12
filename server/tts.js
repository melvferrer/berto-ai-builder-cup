// Server-side Filipino text-to-speech for Berto, so it speaks on any phone (iOS has no fil-PH voice).
//
// Providers (first match wins):
//   0. Gemini TTS (opt-in, OFF by default) — set TTS_PROVIDER=gemini and GEMINI_API_KEY. One voice speaks the
//      whole Taglish utterance (no run splitting); falls back to edge on error. See geminiProvider below.
//   1. Google Cloud TTS  — set GOOGLE_TTS_API_KEY (recommended for production; see stub below).
//   2. Microsoft Edge neural TTS via the `edge-tts` CLI (free, unofficial; fine for MVP testing).
// True Taglish: each utterance is split into Filipino / English runs (shared/taglish.js). Filipino runs use a
// Filipino voice, English terms (blood glucose, mg/dL, metformin, ...) a Philippine-English voice; the runs are
// synthesized separately (cached per run), silence-trimmed and joined into one MP3 with ffmpeg (cached per utterance).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { splitTaglish, expandEnglish } from '../shared/taglish.js';
import { LANGS } from '../shared/lang.js';
// One edge-tts neural voice per JAPAC language (shared/lang.js); fil/en keep the Taglish run-splitting.
const EDGE_LANG_VOICES = Object.fromEntries(Object.entries(LANGS).filter(([k]) => k !== 'fil' && k !== 'en').map(([k, v]) => [k, process.env[`EDGE_TTS_VOICE_${k.toUpperCase()}`] || v.voice]));

export const MAX_TTS_CHARS = 600;

/** Clean text for speech: symbols removed, whitespace collapsed, length capped. */
export function normalizeForSpeech(text) {
  return String(text ?? '')
    .replace(/[“”"✓›⬆︎⏰🔔🎙📞⬇🎉]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TTS_CHARS);
}

function edgeProvider(root) {
  const candidates = [process.env.EDGE_TTS_BIN, path.join(root, '.venv/bin/edge-tts'), 'edge-tts'].filter(Boolean);
  const bin = candidates.find((c) => !c.includes('/') || fs.existsSync(c)) ?? 'edge-tts';
  const voices = {
    fil: process.env.EDGE_TTS_VOICE || 'fil-PH-AngeloNeural', // Filipino, male
    en: process.env.EDGE_TTS_VOICE_EN || 'en-PH-JamesNeural', // Philippine English, male
    ...EDGE_LANG_VOICES,
  };
  const rate = process.env.EDGE_TTS_RATE || '-5%'; // same calm rate for both voices
  return {
    name: 'edge', voices, rate,
    synth(text, outFile, lang) {
      return new Promise((resolve, reject) => {
        const p = spawn(bin, ['--voice', voices[lang], `--rate=${rate}`, '--text', text, '--write-media', outFile], { stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        p.stderr.on('data', (d) => { err += d; });
        const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('edge-tts timeout')); }, 20_000);
        p.on('error', (e) => { clearTimeout(timer); reject(e); });
        p.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0 && fs.existsSync(outFile) && fs.statSync(outFile).size > 300) resolve();
          else reject(new Error(`edge-tts exit ${code}: ${err.slice(-300)}`));
        });
      });
    },
  };
}

// ============================================================================
// GOOGLE CLOUD TTS — STUB / NOT YET TESTED (no API key available during the MVP).
// Activate by setting GOOGLE_TTS_API_KEY. Uses the same run approach as edge: Filipino runs with a fil-PH
// male voice (fil-PH-Standard-C/-D, fil-PH-Wavenet-C/-D), English runs with an English male voice
// (Google has no en-PH; default en-US-Neural2-D, try en-AU/en-IN voices for a closer accent).
// Alternative: send one SSML request with <lang xml:lang="en-US">blood glucose</lang> inside a fil-PH voice.
// ============================================================================
/** OAuth token from the Cloud Run metadata server (service account; no key file, no API key). */
let adcToken = { v: null, exp: 0 };
async function metadataToken() {
  if (adcToken.v && Date.now() < adcToken.exp - 60_000) return adcToken.v;
  const r = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error(`metadata token ${r.status}`);
  const j = await r.json(); adcToken = { v: j.access_token, exp: Date.now() + j.expires_in * 1000 }; return adcToken.v;
}

function googleProvider(apiKey) {
  const voices = {
    fil: process.env.GOOGLE_TTS_VOICE || 'fil-PH-Wavenet-D',
    en: process.env.GOOGLE_TTS_VOICE_EN || 'en-US-Neural2-D',
  };
  const rate = Number(process.env.GOOGLE_TTS_RATE || 0.95);
  return {
    name: 'google', voices, rate: String(rate),
    async synth(text, outFile, lang) {
      const auth = apiKey ? {} : { authorization: `Bearer ${await metadataToken()}` };
      const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ''}`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({
          input: { text },
          voice: voices[lang] ? { languageCode: voices[lang].split('-').slice(0, 2).join('-'), name: voices[lang] } : { languageCode: LANGS[lang]?.bcp47 ?? 'en-US' },
          audioConfig: { audioEncoding: 'MP3', speakingRate: rate, sampleRateHertz: 24000 },
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`google tts ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const { audioContent } = await res.json();
      fs.writeFileSync(outFile, Buffer.from(audioContent, 'base64'));
    },
  };
}

// ============================================================================
// GEMINI TTS — opt-in comparison provider (TTS_PROVIDER=gemini, key from GEMINI_API_KEY; never logged).
// Uses the Interactions API with a single prebuilt voice for the whole utterance; Gemini handles the
// Filipino/English code-switching itself. Returns raw 24 kHz s16le mono PCM, encoded to MP3 with ffmpeg.
//   GEMINI_TTS_MODEL  default gemini-3.8-flash-lite-tts (or gemini-3.8-flash-tts for higher fidelity)
//   GEMINI_TTS_VOICE  default Algieba (smooth male; Charon / Orus also tested)
//   GEMINI_TTS_STYLE  delivery direction sent as speech_metadata.style (not spoken)
// ============================================================================
const GEMINI_DEFAULT_STYLE = 'Natural Manila Taglish: Filipino words in natural Tagalog, English medical terms '
  + 'pronounced in English with a natural Filipino accent. Calm, warm, reassuring, speaking slightly slowly.';

function geminiProvider(apiKey) {
  const model = process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-lite-tts';
  const voice = process.env.GEMINI_TTS_VOICE || 'Algieba';
  const style = process.env.GEMINI_TTS_STYLE || GEMINI_DEFAULT_STYLE;
  return {
    name: 'gemini', model, voice, style,
    voices: { fil: voice, en: voice },
    async synth(text, outFile) {
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          input: [{ type: 'user_input', content: [{ type: 'text', text, annotations: [{ type: 'speech_metadata', style }] }] }],
          response_format: { type: 'audio', mime_type: 'audio/l16', sample_rate: 24000 },
          generation_config: { speech_config: [{ voice }] },
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        let msg = ''; try { msg = (await res.json()).error?.message ?? ''; } catch { /* ignore */ }
        throw new Error(`gemini tts ${res.status}: ${String(msg).slice(0, 200)}`);
      }
      const j = await res.json();
      const audio = (j.steps ?? []).filter((s) => s.type === 'model_output').flatMap((s) => s.content ?? [])
        .filter((c) => c.type === 'audio').pop();
      if (!audio?.data) throw new Error('gemini tts: no audio in response');
      await pcmToMp3(Buffer.from(audio.data, 'base64'), outFile);
    },
  };
}

/** Encode 24 kHz s16le mono PCM to MP3 (piped through ffmpeg stdin). */
function pcmToMp3(pcm, outFile) {
  return new Promise((resolve, reject) => {
    const args = ['-loglevel', 'error', '-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', 'pipe:0',
      '-c:a', 'libmp3lame', '-b:a', '64k', outFile];
    const p = spawn(process.env.FFMPEG_BIN || 'ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('ffmpeg timeout')); }, 20_000);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${err.slice(-300)}`)); });
    p.stdin.on('error', () => {});
    p.stdin.end(pcm);
  });
}

/** Pause to leave after a run, based on its final punctuation (seconds). */
function gapAfter(text, isLast) {
  if (isLast) return 0.05;
  if (/[.!?]["')\]]*$/.test(text)) return 0.14;
  if (/[,;:—–-]$/.test(text)) return 0.08;
  return 0.06; // mid-sentence language switch: keep it tight so it doesn't sound choppy
}

/** Trim leading/trailing silence of each run, add the gaps, re-encode into one clean MP3. */
function concatRuns(files, gaps, outFile) {
  return new Promise((resolve, reject) => {
    const trim = 'silenceremove=start_periods=1:start_threshold=-48dB:start_silence=0.02:detection=peak';
    const filters = files.map((_, i) =>
      `[${i}:a]aresample=24000,aformat=channel_layouts=mono,${trim},areverse,${trim},areverse,apad=pad_dur=${gaps[i].toFixed(2)}[a${i}]`);
    const fc = `${filters.join(';')};${files.map((_, i) => `[a${i}]`).join('')}concat=n=${files.length}:v=0:a=1,silenceremove=stop_periods=-1:stop_duration=0.22:stop_threshold=-45dB:stop_silence=0.18[out]`;
    const args = ['-loglevel', 'error', '-y', ...files.flatMap((f) => ['-i', f]), '-filter_complex', fc, '-map', '[out]',
      '-ac', '1', '-ar', '24000', '-c:a', 'libmp3lame', '-b:a', '48k', outFile];
    const p = spawn(process.env.FFMPEG_BIN || 'ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('ffmpeg timeout')); }, 20_000);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${err.slice(-300)}`)); });
  });
}

export function createTTS({ root, dataDir }) {
  // TTS_PROVIDER=google-adc: Google Cloud TTS with the Cloud Run service account (recommended on Cloud Run).
  const provider = process.env.GOOGLE_TTS_API_KEY ? googleProvider(process.env.GOOGLE_TTS_API_KEY)
    : process.env.TTS_PROVIDER === 'google-adc' ? googleProvider(null) : edgeProvider(root);
  const gemini = process.env.TTS_PROVIDER === 'gemini' && process.env.GEMINI_API_KEY ? geminiProvider(process.env.GEMINI_API_KEY) : null;
  if (process.env.TTS_PROVIDER === 'gemini' && !gemini) console.warn('[tts] TTS_PROVIDER=gemini but GEMINI_API_KEY is not set; using', provider.name);
  const cacheDir = path.join(dataDir, 'tts-cache');
  const runDir = path.join(cacheDir, 'runs');
  fs.mkdirSync(runDir, { recursive: true });
  const inflight = new Map();
  let running = 0;
  const queue = [];
  const MAX_CONCURRENT = 3;
  const acquire = () => new Promise((r) => { if (running < MAX_CONCURRENT) { running++; r(); } else queue.push(r); });
  const release = () => { const next = queue.shift(); if (next) next(); else running--; };
  const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');

  /** Text runs to speak: Filipino as written; English with units/abbreviations expanded. */
  function plan(text, terms = [], lang = 'fil') {
    if (lang !== 'fil') return [{ lang, text: lang === 'en' ? expandEnglish(text) : text }];
    return splitTaglish(text, terms).map((r) => ({ lang: r.lang, text: r.lang === 'en' ? expandEnglish(r.text) : r.text }));
  }
  /** Gemini speaks the whole utterance in one voice: rejoin the runs (English units/abbreviations expanded). */
  const geminiText = (runs) => runs.map((r) => r.text).join(' ').replace(/\s+/g, ' ').trim();
  const geminiKey = (runs) => hash(`g1|${gemini.model}|${gemini.voice}|${gemini.style}|${geminiText(runs)}`);
  const finalKey = (runs) => hash(`v3|${provider.name}|${provider.voices.fil}|${provider.voices.en}|${provider.rate}|${JSON.stringify(runs)}`);

  /** Run a job once per key (dedupes concurrent identical requests). */
  function once(key, fn) {
    if (inflight.has(key)) return inflight.get(key);
    const job = fn().finally(() => inflight.delete(key));
    inflight.set(key, job);
    return job;
  }

  async function runFile(run) {
    const file = path.join(runDir, `${hash(`${provider.name}|${provider.voices[run.lang]}|${provider.rate}|${run.text}`)}.mp3`);
    if (fs.existsSync(file)) return file;
    return once(file, async () => {
      await acquire();
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp.mp3`;
      try { await provider.synth(run.text, tmp, run.lang); fs.renameSync(tmp, file); return file; }
      finally { release(); fs.rmSync(tmp, { force: true }); }
    });
  }

  /** Gemini path: one request per utterance, cached on disk by model/voice/style/text. */
  async function geminiFile(runs) {
    const file = path.join(cacheDir, `${geminiKey(runs)}.mp3`);
    if (fs.existsSync(file)) return file;
    return once(file, async () => {
      await acquire();
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp.mp3`;
      try { await gemini.synth(geminiText(runs), tmp); fs.renameSync(tmp, file); return file; }
      finally { release(); fs.rmSync(tmp, { force: true }); }
    });
  }

  return {
    info: () => (gemini
      ? { provider: 'gemini', model: gemini.model, voices: gemini.voices, voice: gemini.voice, mode: 'single-voice', fallback: provider.name }
      : { provider: provider.name, voices: provider.voices, voice: provider.voices.fil, mode: 'taglish-runs' }),
    plan,
    cachedPath(text, terms, lang = 'fil') {
      const runs = plan(text, terms, lang);
      if (gemini && lang === 'fil') { const g = path.join(cacheDir, `${geminiKey(runs)}.mp3`); if (fs.existsSync(g)) return g; }
      const f = path.join(cacheDir, `${finalKey(runs)}.mp3`); return fs.existsSync(f) ? f : null;
    },
    /** Returns { file, runs } for an MP3 of this (already cleaned) text. */
    async get(text, terms = [], lang = 'fil') {
      const runs = plan(text, terms, lang);
      if (!runs.length) throw new Error('nothing to say');
      if (gemini && lang === 'fil') {
        try { return { file: await geminiFile(runs), runs }; }
        catch (e) { console.warn('[tts] gemini failed, falling back to', provider.name, '-', e.message); }
      }
      const file = path.join(cacheDir, `${finalKey(runs)}.mp3`);
      if (fs.existsSync(file)) return { file, runs };
      await once(file, async () => {
        const files = await Promise.all(runs.map(runFile));
        const tmp = `${file}.${process.pid}.${Date.now()}.tmp.mp3`;
        try {
          await concatRuns(files, runs.map((r, i) => gapAfter(r.text, i === runs.length - 1)), tmp);
          fs.renameSync(tmp, file);
        } finally { fs.rmSync(tmp, { force: true }); }
      });
      return { file, runs };
    },
  };
}

/** Tiny fixed-window rate limiter per client IP. */
export function rateLimiter({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, windowMs).unref();
  return (ip) => {
    const now = Date.now();
    let h = hits.get(ip);
    if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(ip, h); }
    h.n++;
    return h.n <= max;
  };
}
