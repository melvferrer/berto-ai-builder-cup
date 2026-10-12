// Taglish run splitter, shared by the server (server/tts.js) and the app (src/voice.ts).
// Splits an utterance into runs: English terms (medical words, units, drug names, common English
// words used in Taglish, numbers attached to them) vs Filipino text. Each run is then spoken by a
// voice of that language: Filipino -> fil-PH, English -> en-PH (Philippine English).

/** Multi-word English phrases, matched first (longest match). Lowercase. */
const PHRASES = [
  'type 2 diabetes', 'type 1 diabetes', 'blood glucose', 'blood sugar', 'blood pressure', 'after meal', 'before meal',
  'target range', 'brown rice', 'chest pain', 'milligrams per deciliter', 'millimoles per liter', 'text to speech',
  'spoken content', 'add to home screen', 'home screen', 'health ai', 'vertex ai', 'google cloud',
];

/** Single English words (lowercase). Medical terms, units, drug names, common Taglish English words. */
const WORDS = new Set(`
sugar glucose fasting random insulin metformin glimepiride gliclazide glipizide glibenclamide sitagliptin vildagliptin
linagliptin teneligliptin empagliflozin dapagliflozin canagliflozin pioglitazone acarbose losartan amlodipine
atorvastatin rosuvastatin simvastatin aspirin clopidogrel lantus glargine novorapid humalog humulin mixtard insulatard
ozempic semaglutide liraglutide dulaglutide trulicity januvia galvus jardiance forxiga
symptoms symptom hypoglycemia hyperglycemia hypo hyper diabetes diabetic prediabetes hba1c a1c dose doses tablet tablets
tab tabs capsule capsules mg mcg ml g kg units unit iu mmol mg/dl mmol/l milligrams millimoles deciliter liter
check checkup check-up reminder reminders okay ok tip tips test reading readings target range schedule
medicine medicines medication medications doctor emergency normal high low monitor glucometer strip strips lancet
carbs carbohydrates protein diet exercise juice softdrinks soft drinks calories cholesterol kidney eye eyes foot feet
wound neuropathy dialysis hospital clinic app notification notifications settings accessibility voices voice
am pm berto-mvp careGenicsai caregenicsai export csv json pdf online offline wifi
`.trim().toLowerCase().split(/\s+/));

/** Filipino words that must stay Filipino even if they look English. */
const FIL_FORCE = new Set(['at', 'may', 'ako', 'is', 'ano', 'pa', 'na', 'sa', 'ang', 'ng', 'mo', 'ko', 'si', 'ni', 'o', 'ay', 'po']);

const UNIT_RE = /^(mg\/dl|mmol\/l|mg|mcg|ml|g|kg|units?|iu|am|pm|%)$/i;
const NUM_RE = /^\d+(?:[.,:]\d+)*%?$/;

/** Read units/abbreviations the way an English voice should say them. */
export function expandEnglish(text) {
  return text
    .replace(/(\d)\s*mg\/dL/gi, '$1 milligrams per deciliter').replace(/mg\/dL/gi, 'milligrams per deciliter')
    .replace(/(\d)\s*mmol\/L/gi, '$1 millimoles per liter').replace(/mmol\/L/gi, 'millimoles per liter')
    .replace(/(\d)\s*mg\b/gi, '$1 milligrams').replace(/(\d)\s*mcg\b/gi, '$1 micrograms').replace(/(\d)\s*ml\b/gi, '$1 milliliters')
    .replace(/\bHbA1c\b/gi, 'H B A one C').replace(/\bA1c\b/gi, 'A one C')
    .replace(/\bCareGenicsAI\b/gi, 'CareGenics A I')
    .replace(/\b911\b/g, 'nine one one')
    .replace(/(\d)%/g, '$1 percent');
}

function tokenize(text) {
  // words (incl. mg/dL, check-up, 7.5, 8:00), whitespace, punctuation
  return text.match(/[A-Za-zÀ-ÿñÑ0-9]+(?:[\/.:'’-][A-Za-zÀ-ÿñÑ0-9]+)*%?|\s+|[^\sA-Za-zÀ-ÿñÑ0-9]+/g) ?? [];
}

/**
 * @param {string} text
 * @param {string[]} [extraTerms] e.g. the user's medicine names (spoken in English)
 * @returns {{lang: 'en'|'fil', text: string}[]}
 */
export function splitTaglish(text, extraTerms = []) {
  const toks = tokenize(String(text ?? ''));
  const isWord = (t) => /[A-Za-zÀ-ÿñÑ0-9]/.test(t);
  const words = [];
  toks.forEach((t, i) => { if (isWord(t)) words.push(i); });
  const lang = new Array(toks.length).fill(null);
  const extra = new Set(extraTerms.flatMap((n) => String(n).toLowerCase().split(/\s+/)).filter((w) => w.length > 2 && !FIL_FORCE.has(w)));
  const lw = (i) => toks[words[i]].toLowerCase();

  // 1) phrases (longest first), 2) single words
  const phrases = [...PHRASES].sort((a, b) => b.split(' ').length - a.split(' ').length);
  for (let w = 0; w < words.length; w++) {
    if (lang[words[w]]) continue;
    for (const p of phrases) {
      const parts = p.split(' ');
      if (w + parts.length > words.length) continue;
      if (parts.every((pp, k) => lw(w + k) === pp)) { for (let k = 0; k < parts.length; k++) lang[words[w + k]] = 'en'; break; }
    }
  }
  for (let w = 0; w < words.length; w++) {
    const i = words[w];
    if (lang[i]) continue;
    const t = lw(w);
    if (FIL_FORCE.has(t)) lang[i] = 'fil';
    else if (WORDS.has(t) || extra.has(t) || UNIT_RE.test(t)) lang[i] = 'en';
  }
  // 3) numbers: English when attached to an English word/unit (readings, doses, clock times with AM/PM),
  //    Filipino after "alas" (alas 8) or when standing alone in Filipino text.
  for (let w = 0; w < words.length; w++) {
    const i = words[w];
    if (lang[i] || !NUM_RE.test(toks[i])) continue;
    const prev = w > 0 ? lw(w - 1) : '';
    if (prev === 'alas' || prev === 'alas-') { lang[i] = 'fil'; continue; }
    const next = w + 1 < words.length ? words[w + 1] : -1;
    const prevI = w > 0 ? words[w - 1] : -1;
    const nextEn = next >= 0 && (lang[next] === 'en' || UNIT_RE.test(toks[next])) && /^\s*$/.test(toks.slice(i + 1, next).join(''));
    const prevEn = prevI >= 0 && lang[prevI] === 'en' && /^\s*$/.test(toks.slice(prevI + 1, i).join(''));
    if (nextEn || prevEn || toks[i] === '911' || toks[i].endsWith('%')) lang[i] = 'en';
  }
  for (const i of words) if (!lang[i]) lang[i] = 'fil';

  // 4) build runs; whitespace/punctuation joins the preceding run
  const runs = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const L = lang[i];
    if (!L) { if (runs.length) runs[runs.length - 1].text += t; else runs.push({ lang: 'fil', text: t }); continue; }
    const last = runs[runs.length - 1];
    if (last && last.lang === L) last.text += t;
    else if (last && !/[A-Za-zÀ-ÿñÑ0-9]/.test(last.text)) { last.lang = L; last.text += t; }
    else runs.push({ lang: L, text: t });
  }
  // 5) merge again after tidy-up, trim
  const out = [];
  for (const r of runs) {
    const text = r.text.replace(/\s+/g, ' ');
    if (!text.trim()) { if (out.length) out[out.length - 1].text += ' '; continue; }
    const last = out[out.length - 1];
    if (last && last.lang === r.lang) last.text += text; else out.push({ lang: r.lang, text });
  }
  return out.map((r) => ({ lang: r.lang, text: r.text.trim() })).filter((r) => r.text);
}
