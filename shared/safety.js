// =====================================================================================
// PUBLIC STUB — AI Builder Cup 2026 edition.
// CareGenicsAI's production safety layer (multilingual emergency detection rules, medicine
// dose-blocking lists, clinical output filters and localized safety replies) is proprietary and
// NOT included in this repository. This file keeps the same interface with a deliberately minimal
// placeholder so the app builds and runs. It is NOT a clinical safety system. Do not use it with
// real patients.
// =====================================================================================

export const DISCLAIMER = 'Reminder: this is not medical advice.';
export const DOSE_LINE = 'Please talk to your doctor before changing any medicine.';
export const DOSE_REPLY = 'I cannot give advice about medicine doses. Please ask your doctor or pharmacist.';
export const DOCTOR_FALLBACK = 'Please ask your doctor about this.';
export const BUSY_REPLY = 'One moment, I am still answering. Please try again in a few seconds.';
export const FILLER = 'One moment...';
export const RICE_LINE = '';
const EMERGENCY_REPLY = 'This may be an emergency. Please call your local emergency services or go to the nearest emergency room now.';

export const disclaimerFor = () => DISCLAIMER;
export const doseReplyFor = () => DOSE_REPLY;
export const doseLineFor = () => DOSE_LINE;
export const doctorFallbackFor = () => DOCTOR_FALLBACK;
export const busyReplyFor = () => BUSY_REPLY;
export const retryFor = () => 'Sorry, I am a bit slow right now. Please try again.';

const n = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();

/** Placeholder: no glucose parsing in the public edition. */
export function glucoseNumbers() { return []; }

// Minimal placeholder keywords (English only). The production rule set is private.
const PLACEHOLDER_EMERGENCY = /\b(emergency|unconscious|fainted|chest pain|can'?t breathe|seizure)\b/;

/** Placeholder emergency check: a few English keywords -> "call local emergency services". */
export function emergencyCheck(text) {
  return PLACEHOLDER_EMERGENCY.test(n(text)) ? { level: 'symptom', reply: EMERGENCY_REPLY } : null;
}

/** Placeholder: blocks anything that mentions a dose; the production classifier is private. */
export function isDoseQuestion(text) { return /\b(dose|dosage|dosis)\b/.test(n(text)); }

/** Placeholder output filter: formatting cleanup only. */
export function filterSentence(sentence) {
  const t = String(sentence).replace(/\*\*|__|`|#+\s*/g, '').replace(/^\s*([-*•]|\d+[.)])\s+/, '').replace(/\s+/g, ' ').trim();
  if (!t || !/\p{L}{2}/u.test(t)) return { text: '', reason: t ? 'fragment' : null };
  return { text: t, reason: null };
}

function words(s) { return new Set(n(s).replace(/[^\p{L}\p{N} ]/gu, ' ').split(' ').filter((w) => w.length > 2)); }
export function overlap(a, b) { const A = words(a), B = words(b); if (!A.size) return 0; let k = 0; for (const w of A) if (B.has(w)) k++; return k / A.size; }

/** Split streamed text into complete sentences; returns [sentences, remainder]. */
export function takeSentences(buf) {
  const out = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    const end = c === '\n' || '。！？।'.includes(c) || ('.!?'.includes(c) && i + 1 < buf.length && /\s/.test(buf[i + 1]));
    if (!end) continue;
    const sent = buf.slice(start, i + 1).trim();
    if (sent) out.push(sent);
    start = i + 1;
  }
  return [out, buf.slice(start)];
}

/** Quick check whether free text is a health question . */
export function looksLikeQuestion(text) {
  const s = n(text);
  return /\?|^(ano|anong|ano ang|ano ba|paano|bakit|pwede|puwede|pede|dapat|bawal|okay lang|ok lang|ok ba|masama|mabuti|gaano|kailan|saan|alin|ilan|what|how|why|can i|should|is it|totoo|tama ba|normal ba)\b|\b(ba|kaya)\b.*\b(kumain|kainin|uminom|mag-?exercise|maglakad|normal|masama|mabuti|delikado|bawal|pwede|puwede)\b|\b(pwede|puwede|dapat|bawal)\b.*\b(ba|ko)\b/.test(s);
}
