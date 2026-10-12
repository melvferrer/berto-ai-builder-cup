// Berto server: serves the PWA (dist/) and sends Web Push medicine reminders on an Asia/Manila schedule.
import express from 'express';
import webpush from 'web-push';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.js';
import { loadVapid } from './vapid.js';
import { dueReminders, reminderPayload, manila } from './schedule.js';
import { createTTS, rateLimiter, normalizeForSpeech } from './tts.js';
import * as llm from './llm.js';
import * as stt from './stt.js';
import * as SAFETY from '../shared/safety.js';
import { normLang, detectLang } from '../shared/lang.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 8787);
const CONTACT = process.env.VAPID_SUBJECT || 'mailto:berto@caregenics.ai';

const vapid = loadVapid(DATA_DIR);
webpush.setVapidDetails(CONTACT, vapid.publicKey, vapid.privateKey);
const { data, persist } = createStore(DATA_DIR);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '32kb' }));

const okId = (s) => typeof s === 'string' && /^[\w-]{8,64}$/.test(s);
const okTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const clean = (s, n = 60) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').slice(0, n);

app.get('/api/health', (_req, res) => res.json({ ok: true, devices: Object.keys(data.devices).length, manila: manila() }));
app.get('/api/vapid-public-key', (_req, res) => res.json({ key: vapid.publicKey }));

app.post('/api/subscribe', (req, res) => {
  const { deviceId, subscription } = req.body || {};
  if (!okId(deviceId) || !subscription?.endpoint || !/^https:\/\//.test(subscription.endpoint) || !subscription.keys?.p256dh || !subscription.keys?.auth)
    return res.status(400).json({ error: 'bad subscription' });
  const dev = (data.devices[deviceId] ||= { reminders: [] });
  dev.subscription = { endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } };
  dev.updatedAt = Date.now();
  persist();
  res.json({ ok: true });
});

app.post('/api/schedule', (req, res) => {
  const { deviceId, reminders } = req.body || {};
  if (!okId(deviceId) || !Array.isArray(reminders) || reminders.length > 50) return res.status(400).json({ error: 'bad schedule' });
  const list = reminders.filter((r) => okTime(r?.time) && r?.medId && r?.name)
    .map((r) => ({ medId: clean(r.medId, 64), name: clean(r.name), dose: clean(r.dose, 30), time: r.time }));
  const dev = (data.devices[deviceId] ||= {});
  dev.reminders = list;
  dev.updatedAt = Date.now();
  persist();
  res.json({ ok: true, count: list.length });
});

app.post('/api/unsubscribe', (req, res) => {
  const { deviceId } = req.body || {};
  if (okId(deviceId)) { delete data.devices[deviceId]; persist(); }
  res.json({ ok: true });
});

app.post('/api/snooze', (req, res) => {
  const { deviceId, medId, time, minutes = 10 } = req.body || {};
  const dev = data.devices[deviceId];
  const r = dev?.reminders?.find((x) => x.medId === medId && x.time === time);
  if (!okId(deviceId) || !r) return res.status(404).json({ error: 'not found' });
  data.oneoff.push({ deviceId, at: Date.now() + Math.min(Math.max(Number(minutes) || 10, 1), 120) * 60_000, payload: reminderPayload(deviceId, manila().date, r, true) });
  persist();
  res.json({ ok: true });
});

app.post('/api/test-push', async (req, res) => {
  const { deviceId } = req.body || {};
  if (!okId(deviceId) || !data.devices[deviceId]?.subscription) return res.status(404).json({ error: 'no subscription' });
  const r = await send(deviceId, { kind: 'test', title: 'Berto', body: 'Gumagana ang paalala mo! 🎉', tag: 'berto-test' });
  res.json(r); // always 200 (Cloudflare replaces 5xx bodies); check r.ok
});

// ---- Text-to-speech: Berto's own Filipino voice (MP3) ----
const tts = createTTS({ root: ROOT, dataDir: DATA_DIR });
const ttsLimit = rateLimiter({ windowMs: 60_000, max: Number(process.env.TTS_RATE_PER_MIN || 40) });
const clientIp = (req) => req.get('cf-connecting-ip') || req.ip || 'unknown';
app.get('/api/tts/status', (_req, res) => res.json({ available: true, ...tts.info() }));
async function handleTTS(req, res) {
  const raw = req.method === 'GET' ? req.query.text : req.body?.text;
  const lang = normLang(String((req.method === 'GET' ? req.query.lang : req.body?.lang) ?? 'fil'));
  // optional extra English terms (e.g. the user's medicine names), comma-separated, spoken by the English voice
  const termsRaw = req.method === 'GET' ? req.query.terms : req.body?.terms;
  const terms = (Array.isArray(termsRaw) ? termsRaw.join(',') : String(termsRaw ?? '')).split(',')
    .map((x) => x.replace(/[^\p{L}\p{N} -]/gu, '').trim().slice(0, 40)).filter(Boolean).slice(0, 30);
  if (typeof raw !== 'string' || !raw.trim()) return res.status(400).json({ error: 'text required' });
  if (raw.length > 1000) return res.status(413).json({ error: 'text too long' });
  const text = normalizeForSpeech(raw);
  if (!text) return res.status(400).json({ error: 'empty text' });
  // cached phrases are cheap; only count uncached synthesis against the limit
  if (!tts.cachedPath(text, terms, lang) && !ttsLimit(clientIp(req))) return res.status(429).json({ error: 'too many requests' });
  try {
    const { file, runs } = await tts.get(text, terms, lang);
    if (process.env.TTS_LOG_RUNS !== '0') console.log('[berto] tts runs', JSON.stringify(runs.map((r) => `${r.lang}:${r.text}`)));
    res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=31536000, immutable',
      'X-TTS-Runs': encodeURIComponent(JSON.stringify(runs)).slice(0, 4000) });
    res.sendFile(file);
  } catch (e) {
    console.warn('[berto] tts failed', e.message);
    res.status(503).json({ error: 'tts unavailable' });
  }
}
app.get('/api/tts', handleTTS);
app.post('/api/tts', handleTTS);

// ---- Free-form health questions: MedGemma (demo) behind deterministic guardrails (server/llm.js) ----
// Body: { text, glucose?: { value, ageMin }, stream?: boolean }. Only the question and the latest
// glucose number are accepted; nothing identifying is read or logged.
const llmLimit = rateLimiter({ windowMs: 60_000, max: Number(process.env.LLM_RATE_PER_MIN || 12) });
app.get('/api/llm/status', async (_req, res) => res.json(await llm.status()));
app.post('/api/llm', async (req, res) => {
  const text = clean(req.body?.text, 300).trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  const gv = Number(req.body?.glucose?.value), ga = Number(req.body?.glucose?.ageMin);
  const glucose = gv >= 20 && gv <= 600 && ga >= 0 ? { value: Math.round(gv), ageMin: Math.round(ga) } : null;
  const stream = req.body?.stream === true;
  // reply language: the user's selection, but follow the script they actually typed in (auto-follow)
  const lang = normLang(detectLang(text) ?? String(req.body?.lang ?? 'fil'));
  if (!llmLimit(clientIp(req))) return res.json({ route: 'busy', reply: SAFETY.busyReplyFor(lang) });
  if (!stream) {
    const r = await llm.answer(text, glucose, () => {}, lang);
    return res.json({ reply: r.reply, route: r.route, emergency: r.emergency, ms: r.ms });
  }
  // Server-sent events: {type:'sentence',text}* then {type:'final',reply,route,emergency,ms}
  res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write(': ok\n\n');
  const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 5000);
  try {
    const r = await llm.answer(text, glucose, send, lang);
    send({ type: 'final', reply: r.reply, route: r.route, emergency: r.emergency, ms: r.ms });
  } catch (e) {
    console.warn('[berto] llm failed', e.message);
    send({ type: 'final', reply: SAFETY.doctorFallbackFor(lang), route: 'error' });
  } finally { clearInterval(ping); res.end(); }
});

// ---- Speech-to-text for the orb (server/stt.js). Body = raw recorded audio (audio/mp4 from iPhone,
// audio/webm from Chrome). Audio is never stored; only { text } is returned.
const sttLimit = rateLimiter({ windowMs: 60_000, max: Number(process.env.STT_RATE_PER_MIN || 20) });
app.get('/api/stt/status', async (_req, res) => res.json(await stt.status()));
app.post('/api/stt', express.raw({ type: () => true, limit: '2mb' }), async (req, res) => {
  const mime = stt.audioMime(req.get('content-type'));
  if (!mime) return res.status(415).json({ error: 'unsupported audio type' });
  if (!Buffer.isBuffer(req.body) || req.body.length < 200) return res.status(400).json({ error: 'audio required' });
  if (!sttLimit(clientIp(req))) return res.status(429).json({ error: 'too many requests' });
  try {
    const r = await stt.transcribe(req.body, mime, undefined, normLang(String(req.query.lang ?? 'fil')));
    console.log('[berto] stt', r.provider, mime, `${req.body.length}B`, `${r.ms}ms`, `${r.text.length} chars`); // no transcript/audio in logs
    res.json(r);
  } catch (e) {
    console.warn('[berto] stt failed', e.message);
    res.status(503).json({ error: 'stt unavailable' });
  } finally { req.body = null; }
});

async function send(deviceId, payload) {
  const dev = data.devices[deviceId];
  if (!dev?.subscription) return { ok: false, error: 'no subscription' };
  try {
    const r = await webpush.sendNotification(dev.subscription, JSON.stringify(payload), { TTL: 60 * 60, urgency: 'high', topic: undefined });
    return { ok: true, status: r.statusCode };
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) { delete dev.subscription; persist(); }
    console.warn('[berto] push failed', deviceId.slice(0, 8), e.statusCode, e.body || e.message);
    return { ok: false, status: e.statusCode, error: String(e.body || e.message).slice(0, 200) };
  }
}

async function tick() {
  const now = new Date();
  for (const due of dueReminders(data.devices, data.sent, now)) {
    data.sent[due.key] = Date.now();
    persist();
    const r = await send(due.deviceId, reminderPayload(due.deviceId, due.date, due.reminder));
    console.log('[berto] reminder', due.reminder.time, due.deviceId.slice(0, 8), r.ok ? 'sent' : r.status);
  }
  const ready = data.oneoff.filter((o) => o.at <= now.getTime());
  if (ready.length) {
    data.oneoff = data.oneoff.filter((o) => o.at > now.getTime());
    persist();
    for (const o of ready) await send(o.deviceId, o.payload);
  }
  // prune sent keys older than 2 days
  const cutoff = Date.now() - 2 * 86400000;
  for (const [k, v] of Object.entries(data.sent)) if (v < cutoff) { delete data.sent[k]; persist(); }
}
setInterval(() => tick().catch((e) => console.error(e)), 20_000);
tick();

// ---- static PWA ----
const dist = path.join(ROOT, 'dist');
app.get('/sw.js', (_req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(dist, 'sw.js')); });
app.use('/assets', express.static(path.join(dist, 'assets'), { immutable: true, maxAge: '1y' }));
app.use(express.static(dist, { maxAge: '1h', setHeaders: (res, p) => { if (p.endsWith('.webmanifest')) res.type('application/manifest+json'); if (p.endsWith('index.html')) res.set('Cache-Control', 'no-cache'); } }));
app.get(/^\/(?!api\/).*/, (_req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(dist, 'index.html')); });

app.listen(PORT, () => console.log(`[berto] listening on http://localhost:${PORT} (LLM_PROVIDER=${llm.PROVIDER}, STT_PROVIDER=${stt.PROVIDER})`));
