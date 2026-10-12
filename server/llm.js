// MedGemma for Berto's free-form health questions (demo). Provider chosen by LLM_PROVIDER:
//   local  (default) -> llama.cpp llama-server on 127.0.0.1 (pm2 'berto-llm', scripts/llm.sh)
//   vertex           -> MedGemma on a Vertex AI endpoint (STUB, not implemented yet)
//   off              -> disabled; the app uses its rule-based fallback
// Safety: emergency / dose questions get fixed replies BEFORE any model call; every model sentence is
// filtered (dose advice, echoed instructions, rice-heavy advice); single-turn; greedy; capped length.
// Only the question text and the latest glucose number are used (no device id, name, or IP); every
// Q/A is appended to server/data/llm-log.jsonl for doctor review.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  emergencyCheck, isDoseQuestion, filterSentence, takeSentences,
  disclaimerFor, doseReplyFor, doctorFallbackFor, busyReplyFor, retryFor, overlap } from '../shared/safety.js';
import { LANGS, normLang } from '../shared/lang.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROVIDER = (process.env.LLM_PROVIDER || 'local').toLowerCase();
const LOCAL_URL = process.env.LLM_URL || 'http://127.0.0.1:8788';
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 30_000);
const MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS || 120);
const MAX_SENTENCES = 4;
const MIN_FREE_KB = Number(process.env.LLM_MIN_FREE_MB || 300) * 1024;
const LOG_FILE = process.env.LLM_LOG || path.join(HERE, 'data', 'llm-log.jsonl');
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
export const MODEL_LABEL = PROVIDER === 'gemini' ? `Gemini (${GEMINI_MODEL})` : 'MedGemma 1.5 4B (Q4_K_M, local demo)';

// PUBLIC STUB: CareGenicsAI's clinical system prompts and few-shot examples are proprietary and
// not included in this repository. This generic prompt is a placeholder for the AI Builder Cup edition.
export function systemPromptFor(lang) {
  const L = lang === 'fil' ? 'Taglish (Filipino mixed with English)' : LANGS[lang].english;
  return [
    'You are Berto, a friendly voice companion for people living with type 2 diabetes and their families.',
    `Always reply ONLY in ${L}. Use 2 to 4 short, simple sentences. Plain text only.`,
    'Give general wellness information only; you are not a doctor. Never give medicine or dose advice.',
    'For anything urgent, tell the user to call local emergency services.',
  ].join(' ');
}
export const SYSTEM_PROMPT = systemPromptFor('fil');
const promptSentencesFor = (lang) => systemPromptFor(lang).split(/(?<=[.;])\s+/);
const FEW_SHOT = [];

function buildMessages(question, glucose, lang = 'fil') {
  const ok = glucose && Number.isFinite(glucose.value) && glucose.ageMin <= 360;
  const g = !ok ? '' : lang === 'fil' ? ` (Huling blood sugar ko: ${Math.round(glucose.value)} mg/dL.)` : ` (My latest blood sugar: ${Math.round(glucose.value)} mg/dL.)`;
  const msgs = [{ role: 'system', content: systemPromptFor(lang) }];
  // Taglish few-shot only for fil: for other languages it pulls MedGemma back into Tagalog.
  if (lang === 'fil') for (const [q, a] of FEW_SHOT) msgs.push({ role: 'user', content: q }, { role: 'assistant', content: a });
  msgs.push({ role: 'user', content: `${question}${g}` });
  return msgs;
}

// ---------- providers: async generator of raw text chunks ----------
async function* localProvider(messages, signal) {
  const res = await fetch(`${LOCAL_URL}/v1/chat/completions`, {
    method: 'POST', signal, headers: { 'content-type': 'application/json' },
    // logit_bias bans <unused94> (token 100), MedGemma 1.5's "start thinking" token: no hidden reasoning, faster answers.
    body: JSON.stringify({ messages, stream: true, temperature: 0, top_k: 1, max_tokens: MAX_TOKENS, cache_prompt: true, logit_bias: [[100, false]] }),
  });
  if (!res.ok || !res.body) throw new Error(`llama-server ${res.status}`);
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try { const d = JSON.parse(data).choices?.[0]?.delta?.content; if (d) yield d; } catch { /* ignore */ }
    }
  }
}

// ============================================================================
// VERTEX AI STUB — NOT IMPLEMENTED. For production: deploy MedGemma from Model Garden to a Vertex AI
// endpoint in Melvin's project, then call its OpenAI-compatible chat endpoint server-side, e.g.
//   POST https://{REGION}-aiplatform.googleapis.com/v1/projects/{PROJECT}/locations/{REGION}/endpoints/{ENDPOINT_ID}/chat/completions
//   Authorization: Bearer <OAuth token from a service account (google-auth-library)>
// with the same messages/stream/temperature/max_tokens as localProvider. Env: VERTEX_PROJECT,
// VERTEX_REGION, VERTEX_ENDPOINT_ID, GOOGLE_APPLICATION_CREDENTIALS. Keep credentials on the server.
// ============================================================================
async function* vertexProvider() { throw new Error('vertex provider not configured'); }

// ============================================================================
// GEMINI (LLM_PROVIDER=gemini) — primary on Cloud Run. Key ONLY from env GEMINI_API_KEY, which Cloud Run
// injects from Secret Manager (secret berto-gemini-api-key). Never logged. Same system prompt, language
// handling and per-sentence safety filters as MedGemma (the filters run on whatever any provider streams).
// ============================================================================
async function* geminiProvider(messages, signal) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('gemini: GEMINI_API_KEY not set');
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const contents = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse`, {
    method: 'POST', signal, headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] }, contents,
      generationConfig: { temperature: 0.3, maxOutputTokens: Number(process.env.GEMINI_MAX_TOKENS || 400), thinkingConfig: { thinkingBudget: 0 } },
      safetySettings: [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' }],
    }),
  });
  if (!res.ok || !res.body) { let m = ''; try { m = (await res.json()).error?.message ?? ''; } catch { /* ignore */ } throw new Error(`gemini ${res.status}: ${String(m).slice(0, 160)}`); }
  const dec = new TextDecoder(); let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      try { const j = JSON.parse(line.slice(5)); const t = (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join(''); if (t) yield t; } catch { /* ignore */ }
    }
  }
}

const providers = { local: localProvider, vertex: vertexProvider, gemini: geminiProvider };

// ---------- helpers ----------
let busy = false;
export const isBusy = () => busy;
function memAvailableKB() {
  try { return Number(/MemAvailable:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo', 'utf8'))?.[1] || Infinity); } catch { return Infinity; }
}
function logQA(entry) {
  try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n'); }
  catch (e) { console.warn('[berto] llm log failed', e.message); }
}
export async function status() {
  if (PROVIDER === 'off') return { provider: 'off', ready: false };
  if (PROVIDER === 'gemini') return { provider: 'gemini', ready: !!process.env.GEMINI_API_KEY, model: MODEL_LABEL, busy: false };
  if (PROVIDER === 'vertex') return { provider: 'vertex', ready: false, model: 'MedGemma (Vertex AI, not configured)' };
  try {
    const r = await fetch(`${LOCAL_URL}/health`, { signal: AbortSignal.timeout(1500) });
    return { provider: 'local', ready: r.ok, model: MODEL_LABEL, busy };
  } catch { return { provider: 'local', ready: false, model: MODEL_LABEL, busy }; }
}

/**
 * Answer one question. emit(event) receives { type: 'sentence', text } while streaming.
 * Resolves { reply, route, emergency?, ms } — route: emergency|dose|medgemma|busy|timeout|error|off|lowmem.
 */
export async function answer(question, glucose, emit = () => {}, lang = 'fil') {
  lang = normLang(lang);
  const t0 = Date.now();
  const base = { ts: new Date().toISOString(), lang, q: question, glucose: glucose?.value ?? null };
  const done = (r) => { const out = { ...r, ms: Date.now() - t0 }; logQA({ ...base, ...out }); return out; };

  const em = emergencyCheck(question, glucose, lang);
  if (em) return done({ route: 'emergency', reply: em.reply, emergency: { level: em.level, value: em.value } });
  if (isDoseQuestion(question)) return done({ route: 'dose', reply: `${doseReplyFor(lang)} ${disclaimerFor(lang)}` });
  if (PROVIDER === 'off') return done({ route: 'off', reply: null });
  // Gemini handles concurrency itself; the busy lock protects the single local llama.cpp slot.
  if (busy && PROVIDER !== 'gemini') return { route: 'busy', reply: busyReplyFor(lang), ms: 0 };
  if (memAvailableKB() < MIN_FREE_KB) return done({ route: 'lowmem', reply: doctorFallbackFor(lang) });

  if (PROVIDER !== 'gemini') busy = true;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const kept = []; const filtered = []; let raw = ''; let buf = ''; let firstMs = null; let route = 'medgemma';
  const push = (s) => {
    if (kept.length >= MAX_SENTENCES) return;
    const f = filterSentence(s, promptSentencesFor(lang), lang);
    if (f.reason) filtered.push(f.reason);
    // skip repeats (MedGemma sometimes says the same thing twice in other words)
    if (!f.text || kept.some((k) => overlap(f.text, k) >= 0.7)) { if (f.text) filtered.push('repeat'); return; }
    kept.push(f.text);
    if (firstMs === null) firstMs = Date.now() - t0;
    emit({ type: 'sentence', text: f.text });
  };
  try {
    for await (const chunk of providers[PROVIDER](buildMessages(question, glucose, lang), ctrl.signal)) {
      raw += chunk; buf += chunk;
      const [sents, rest] = takeSentences(buf); buf = rest;
      sents.forEach(push);
      if (kept.length >= MAX_SENTENCES) { ctrl.abort(); break; }
    }
    if (buf.trim() && kept.length < MAX_SENTENCES) {
      // the token cap may cut the last sentence: keep it only if it ends like a sentence
      if (/[.!?]\s*$/.test(buf.trim())) push(buf.trim());
    }
  } catch (e) {
    route = ctrl.signal.aborted && kept.length < MAX_SENTENCES ? 'timeout' : 'error';
    if (kept.length >= MAX_SENTENCES) route = 'medgemma';
    else console.warn('[berto] llm', route, e.message);
  } finally { clearTimeout(timer); if (PROVIDER !== 'gemini') busy = false; }

  // Casual chat (no health words in the question or answer) gets no disclaimer and a gentle retry line.
  const HEALTH = /sugar|asukal|glucose|diabetes|gamot|medicine|pagkain|\bkain|diet|exercise|lakad|sakit|doktor|hba1c|insulin|timbang|presyon|blood|kanin|prutas|matamis|sintomas|symptom|\bihi\b|uhaw|hilo|\bmg\b|dosis|\bdose|hydrat|tubig|healthy/i;
  const isHealth = (x) => HEALTH.test(x);
  const casual = !isHealth(question) && !isHealth(kept.join(' '));
  const RETRY = retryFor(lang);
  if (!kept.length) return done({ route: route === 'medgemma' ? 'empty' : route, reply: casual ? RETRY : doctorFallbackFor(lang), raw, filtered });
  if (route !== 'medgemma' && !casual) kept.push(doctorFallbackFor(lang));
  const sep = /^(ja|zh)$/.test(lang) ? '' : ' ';
  const reply = casual ? kept.join(sep) : `${kept.join(sep)}${sep}${disclaimerFor(lang)}`;
  return done({ route, reply, raw, filtered, firstSentenceMs: firstMs });
}
