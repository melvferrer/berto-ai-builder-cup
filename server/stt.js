// Speech-to-text for Berto's orb. Provider chosen by STT_PROVIDER:
//   local  (default) -> faster-whisper worker on 127.0.0.1:8789 (pm2 'berto-stt', scripts/stt.sh). Audio stays on this server.
//   gemini           -> Gemini API audio transcription (GEMINI_API_KEY; never logged). Falls back to local on error.
// Privacy: audio is held in memory only for the request, never written to disk or logged; only the transcript
// is returned (and, if the user's words are later sent to MedGemma, the existing Q/A log stores the text).
import { spokenNumbersToDigits } from '../shared/spoken-numbers.js';
import { LANGS } from '../shared/lang.js';

export const PROVIDER = (process.env.STT_PROVIDER || 'local').toLowerCase();
const LOCAL_URL = process.env.STT_URL || 'http://127.0.0.1:8789';
const TIMEOUT_MS = Number(process.env.STT_TIMEOUT_MS || 15_000);
const GEMINI_MODEL = process.env.GEMINI_STT_MODEL || 'gemini-3.8-flash';
const GEMINI_PROMPT = 'Transcribe this short voice message from a Filipino person with diabetes, speaking Tagalog, English, '
  + 'or Taglish. Write exactly what was said, in the words used (keep English medical terms like blood sugar, metformin, '
  + 'mg/dL). Write numbers as digits. Output only the transcript, nothing else. If there is no speech, output nothing.';

async function local(buf, lang = 'fil') {
  const r = await fetch(`${LOCAL_URL}/transcribe?lang=${encodeURIComponent(LANGS[lang]?.whisper ?? 'tl')}`, {
    method: 'POST', body: buf, headers: { 'content-type': 'application/octet-stream' }, signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`local stt ${r.status}: ${j.error ?? ''}`);
  return { text: j.text ?? '', provider: 'local', audioS: j.audio_s };
}

async function gemini(buf, mime, lang = 'fil') {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('gemini stt: no key');
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: lang === 'fil' ? GEMINI_PROMPT : `Transcribe this short voice message from a person with diabetes speaking ${LANGS[lang].english} (English medical terms may be mixed in). Write exactly what was said in the original script. Write numbers as digits. Output only the transcript. If there is no speech, output nothing.` }, { inline_data: { mime_type: mime, data: buf.toString('base64') } }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 200, thinkingConfig: { thinkingBudget: 0 } },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) { let m = ''; try { m = (await r.json()).error?.message ?? ''; } catch { /* ignore */ } throw new Error(`gemini stt ${r.status}: ${String(m).slice(0, 160)}`); }
  const j = await r.json();
  const text = (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join(' ').trim();
  return { text, provider: 'gemini' };
}

/** Normalised mime for the upload: iPhone sends audio/mp4 (AAC), Chrome/Android audio/webm (Opus). */
export function audioMime(ct) {
  const m = String(ct || '').split(';')[0].trim().toLowerCase();
  if (/^audio\/(mp4|m4a|x-m4a|aac)$/.test(m) || m === 'video/mp4') return 'audio/mp4';
  if (m === 'audio/webm' || m === 'video/webm') return 'audio/webm';
  if (/^audio\/(ogg|wav|x-wav|wave|mpeg|mp3)$/.test(m)) return m.replace('x-wav', 'wav').replace('wave', 'wav').replace('mp3', 'mpeg');
  return null;
}

export async function transcribe(buf, mime, provider = PROVIDER, lang = 'fil') {
  const t = Date.now();
  let out;
  if (provider === 'gemini') {
    try { out = await gemini(buf, mime, lang); } catch (e) { if (process.env.STT_NO_LOCAL === '1') throw e; console.warn('[berto] stt', e.message, '-> local'); out = await local(buf, lang); }
  } else out = await local(buf, lang);
  const raw = out.text.replace(/\s+/g, ' ').trim();
  // Whisper sometimes "hears" the prompt or stock phrases on silence; treat those as no speech.
  const junk = /^(thank you\.?|thanks for watching!?|salamat po sa panonood\.?|\.+|…)$/i.test(raw) || /Taglish na usapan/i.test(raw);
  const text = junk ? '' : (lang === 'fil' || lang === 'en' ? spokenNumbersToDigits(raw) : raw).slice(0, 300);
  return { text, provider: out.provider, lang, ms: Date.now() - t };
}

export async function status() {
  if (PROVIDER === 'gemini') return { provider: 'gemini', ready: !!process.env.GEMINI_API_KEY, model: GEMINI_MODEL };
  try {
    const r = await fetch(`${LOCAL_URL}/health`, { signal: AbortSignal.timeout(2000) });
    const j = await r.json();
    return { provider: 'local', ready: !!j.ok, model: `whisper-${j.model}` };
  } catch { return { provider: 'local', ready: false }; }
}
