import './style.css';
import { t, getLang, setLang, languages, followLanguageOf } from './i18n';
import { db, todaysDoses, exportCSV, exportJSON, uid, type GlucoseCtx, type LogEntry } from './store';
import { respond, logGlucose, listJoin, type Reply } from './brain';
import { parseTimes, parseIntent, classifyGlucose } from './intents';
import { initVoices, installAudioUnlock, setSpeechTerms, speak, listen, stopListening, isListening, isTranscribing, sttSupported, prefetchSpeech } from './voice';
import { enablePush, syncSchedule, refreshSubscription, sendTestPush, pushSupported, permission, isIOS, isStandalone } from './push';
import { dueNudge, answered, snooze, FIRST_DELAY_MS, type NudgeKind } from './nudge';
import { manilaNow, fmt12, toMinutes, relDay } from './time';
import { askLLM, llmStatus } from './llm';
import { lastGlucose } from './store';
import { emergencyCheck, isDoseQuestion, doseReplyFor, disclaimerFor, doctorFallbackFor } from '../shared/safety.js';
import { LANGS } from '../shared/lang.js';

/** Swap the header logo here (file lives in /public). */
const LOGO_SRC = '/logo.svg';

// ---------- tiny DOM helpers ----------
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
function el(html: string): HTMLElement { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild as HTMLElement; }

const S = (d: string, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;
const ICON = {
  send: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3.4 20.4 21 12 3.4 3.6 3.4 10l12.6 2-12.6 2z"/></svg>',
  talk: S('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.2" fill="currentColor"/>'),
  meds: S('<rect x="3" y="8.5" width="18" height="7" rx="3.5" transform="rotate(-35 12 12)"/><path d="m9.2 7.9 5.6 8.2"/>'),
  log: S('<path d="M4 19V5m0 14h16"/><path d="m7 15 4-5 3 3 5-6"/>'),
  mic: S('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>'),
  clock: S('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  check: S('<path d="m5 12.5 4.2 4.2L19 7"/>', 'stroke-width="3"'),
  x: S('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>', 'stroke-width="2.6"'),
  plus: S('<path d="M12 5v14M5 12h14"/>'),
  download: S('<path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19.5h14"/>'),
  info: S('<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.2"/>'),
  phone: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg>',
  alert: S('<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.5M12 17.2v.2"/>', 'stroke-width="2.2"'),
  sparkle: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5c.5 4.6 2.9 7 7.5 7.5-4.6.5-7 2.9-7.5 7.5-.5-4.6-2.9-7-7.5-7.5 4.6-.5 7-2.9 7.5-7.5zM19 15c.25 2 1 2.75 3 3-2 .25-2.75 1-3 3-.25-2-1-2.75-3-3 2-.25 2.75-1 3-3z"/></svg>',
  drop: S('<path d="M12 3.5s6 6.4 6 10.6a6 6 0 0 1-12 0C6 9.9 12 3.5 12 3.5z"/>'),
  note: S('<path d="M5 4.5h14v15H5z"/><path d="M8.5 9h7M8.5 12.5h7M8.5 16h4"/>'),
  bowl: S('<path d="M3.5 11.5h17a8.5 8.5 0 0 1-17 0z"/><path d="M9 8c0-1.5 1-1.5 1-3M13 8c0-1.5 1-1.5 1-3"/>'),
  walk: S('<circle cx="13" cy="4.5" r="1.8"/><path d="m9 21 2.5-6.5L14 17v4M8 11.5l3-3.5 3.5 1.5 2 3M11.5 14.5 12.5 8"/>'),
  bell: S('<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>'),
  ok: S('<circle cx="12" cy="12" r="9"/><path d="m8 12.3 2.8 2.8L16.2 9.5"/>'),
};

// ---------- layout ----------
const app = $('#app');
app.innerHTML = `
  <header>
    <h1 class="sr-only">${esc(t('app.name'))}</h1>
    <button class="brand" id="logoBtn" aria-label="${esc(t('app.openAbout'))}">
      <img src="/brand/mark.svg" alt="${esc(t('app.logoAlt'))}" width="34" height="34" />
      <span>${esc(t('app.name'))}</span>
    </button>
    <button class="lang-btn" id="langBtn" aria-label="${esc(t('settings.language'))}">🌐 ${esc(LANGS[getLang()].native)}</button>
  </header>
  <main>
    <div id="hints"></div>
    <div id="reminders"></div>
    <div id="nudge"></div>
    <section class="orb-zone">
      <button class="orb" id="orb" aria-label="${esc(t('orb.tapToTalk'))}">
        <span class="ring r2"></span><span class="ring r1"></span><span class="ball"></span>
      </button>
      <div class="orb-label">${esc(t('orb.label'))}</div>
      <div class="status" id="status" aria-live="polite"></div>
    </section>
    <section class="chat" id="chat" role="log" aria-live="polite" aria-relevant="additions text"></section>
  </main>
  <div class="stick">
    <form class="composer" id="composer" autocomplete="off" aria-label="${esc(t('composer.placeholder'))}">
      <input id="text" type="text" enterkeyhint="send" placeholder="${esc(t('composer.placeholder'))}" aria-label="${esc(t('composer.placeholder'))}" />
      <button class="icon-btn" type="submit" aria-label="${esc(t('composer.send'))}">${ICON.send}</button>
    </form>
    <nav class="tabs" aria-label="${esc(t('nav.label'))}">
      <button class="on" data-tab="talk" aria-current="page"><span class="ico">${ICON.talk}</span><span>${esc(t('nav.talk'))}</span></button>
      <button data-tab="meds"><span class="ico">${ICON.meds}</span><span>${esc(t('nav.meds'))}</span></button>
      <button data-tab="log"><span class="ico">${ICON.log}</span><span>${esc(t('nav.log'))}</span></button>
    </nav>
  </div>`;

const orb = $('#orb');
const statusEl = $('#status');
const chat = $('#chat');
const input = $<HTMLInputElement>('#text');

// ---------- haptics (Android/Chrome; silently ignored on iOS) ----------
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
function haptic(p: number | number[] = 8) { try { navigator.vibrate?.(p); } catch { /* not allowed */ } }
document.addEventListener('pointerdown', (e) => {
  if ((e.target as HTMLElement).closest?.('.btn, .icon-btn, nav.tabs button, .seg button, .hint button, .brand')) haptic(6);
}, { passive: true });

// header hairline once content scrolls under it
{
  const hdr = document.querySelector('header')!;
  const onScroll = () => hdr.classList.toggle('scrolled', window.scrollY > 4);
  window.addEventListener('scroll', onScroll, { passive: true }); onScroll();
}

// ---------- toast ----------
let toastTimer: number | undefined;
function toast(msg: string) {
  document.querySelector('.toast')?.remove();
  const n = el(`<div class="toast" role="status">${ICON.ok}<span>${esc(msg)}</span></div>`);
  document.body.append(n);
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { n.classList.add('out'); setTimeout(() => n.remove(), 220); }, 3200);
}

// ---------- overlays: focus trap, Escape, restore focus, exit animation ----------
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';
function mountOverlay(o: HTMLElement, opts: { onEscape?: () => void; focus?: string } = {}) {
  const prev = document.activeElement as HTMLElement | null;
  const onKey = (e: KeyboardEvent) => {
    if (!o.isConnected) { document.removeEventListener('keydown', onKey); return; }
    if (e.key === 'Escape' && opts.onEscape) { e.preventDefault(); opts.onEscape(); }
    if (e.key === 'Tab') {
      const f = [...o.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener('keydown', onKey);
  document.body.append(o);
  requestAnimationFrame(() => (o.querySelector<HTMLElement>(opts.focus ?? '[data-autofocus]') ?? o.querySelector<HTMLElement>(FOCUSABLE))?.focus({ preventScroll: true }));
  let closed = false;
  return function close() {
    if (closed) return; closed = true;
    document.removeEventListener('keydown', onKey);
    o.classList.add('closing');
    setTimeout(() => o.remove(), reduceMotion.matches ? 0 : 300);
    if (prev?.isConnected) prev.focus({ preventScroll: true });
  };
}

/** Calm in-app confirm (replaces the browser's confirm box). */
function confirmDialog(message: string, okLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    const o = el(`<div class="overlay center" role="alertdialog" aria-modal="true" aria-labelledby="cfMsg"><div class="dialog confirm">
      <p id="cfMsg">${esc(message)}</p>
      <div class="btn-row"><button class="btn outline lg" data-no data-autofocus>${esc(t('common.cancel'))}</button><button class="btn danger-solid lg" data-yes>${esc(okLabel)}</button></div>
    </div></div>`);
    const done = (v: boolean) => { close(); resolve(v); };
    const close = mountOverlay(o, { onEscape: () => done(false) });
    o.addEventListener('click', (e) => { if (e.target === o) done(false); });
    o.querySelector('[data-no]')!.addEventListener('click', () => done(false));
    o.querySelector('[data-yes]')!.addEventListener('click', () => done(true));
  });
}

// ---------- orb state ----------
function setStatus(text: string) { statusEl.innerHTML = text ? `<span>${esc(text)}</span>` : ''; }
type OrbState = 'idle' | 'listening' | 'thinking' | 'working' | 'speaking';
function setOrb(s: OrbState) {
  orb.classList.toggle('busy', s !== 'idle');
  orb.classList.toggle('working', s === 'working');
  setStatus(s === 'idle' ? '' : t(`orb.${s}`));
}

// ---------- chat ----------
const MAX_BUBBLES = 6;
function bubble(who: 'me' | 'bot', text: string) {
  chat.append(el(`<div class="bubble ${who}">${esc(text)}</div>`));
  while (chat.children.length > MAX_BUBBLES) chat.firstElementChild!.remove();
  chat.lastElementChild!.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/** Speak aloud (server Filipino voice -> device fil voice -> silent); orb pulses while speaking. */
function speakOut(text: string) {
  speak(text, { onStart: () => setOrb('speaking'), onEnd: () => { if (!isListening()) setOrb('idle'); } });
}

function say(text: string) {
  bubble('bot', text);
  speakOut(text);
}

function handleReply(r: Reply) {
  say(r.text);
  if (r.alert) showGlucoseAlert(r.alert.level, r.alert.value);
  if (r.refresh) { renderReminders(); refreshOpenSheet(); }
}

/** Pending one-shot handler (e.g. nudge asked "Ilan ang reading mo?"). */
let pendingAnswer: ((text: string) => boolean) | null = null;

async function handleUserText(text: string) {
  text = text.trim();
  if (!text) return;
  bubble('me', text);
  // Auto-follow: if they clearly wrote/spoke another language, Berto answers (and speaks/listens) in it from now on.
  const switched = followLanguageOf(text);
  if (switched) { toast(t('settings.switched', { lang: LANGS[switched].native })); updateLangBtn(); }
  if (pendingAnswer) {
    const h = pendingAnswer; pendingAnswer = null;
    if (h(text)) return;
  }
  if (askingLLM) { say(t('bot.busy')); return; }
  setOrb('thinking');
  const medsBefore = JSON.stringify(db.get().meds);
  // Safety first on every message (not only MedGemma questions): danger signs always raise the emergency alert.
  const em = emergencyCheck(text, recentGlucose(), getLang());
  if (em) {
    const logged = await respond(text); // still save the reading or symptom
    setOrb('idle');
    handleReply({ ...logged, ask: undefined, alert: undefined, text: em.reply });
    showEmergency(em.level, em.value);
    return;
  }
  const reply = await respond(text);
  setOrb('idle');
  if (reply.ask) { await askBerto(reply.ask.question); return; }
  handleReply(reply);
  if (JSON.stringify(db.get().meds) !== medsBefore) { syncSchedule(); maybeOfferPush(); }
}

// ---------- Free-form health questions (MedGemma demo) ----------
/** Sentence-by-sentence speech: each sentence is spoken as soon as it arrives, in order. */
const speechQueue: string[] = [];
let queueSpeaking = false;
let askingLLM = false;
function enqueueSpeech(text: string) { prefetchSpeech(text); speechQueue.push(text); if (!queueSpeaking) speakNext(); }
function speakNext() {
  const next = speechQueue.shift();
  if (next === undefined) { queueSpeaking = false; setOrb(askingLLM ? 'working' : 'idle'); return; }
  queueSpeaking = true;
  speak(next, { onStart: () => setOrb('speaking'), onEnd: speakNext });
}

function alertDialog(title: string, body: string) {
  haptic([60, 80, 60]);
  const o = el(`<div class="overlay center" role="alertdialog" aria-modal="true" aria-labelledby="alTitle" aria-describedby="alBody">
    <div class="dialog alert-box">
      <div class="alert-icon" aria-hidden="true">${ICON.alert}</div>
      <h2 id="alTitle">${esc(title)}</h2>
      <p id="alBody">${esc(body)}</p>
      <div class="alert-actions">
        <a class="btn danger-solid block" href="tel:911" data-autofocus>${ICON.phone}${esc(t('alert.call'))}</a>
        <button class="btn outline block" data-ok>${esc(t('alert.ok'))}</button>
      </div>
    </div></div>`);
  const close = mountOverlay(o, { onEscape: () => close() });
  o.querySelector('[data-ok]')!.addEventListener('click', () => close());
}

function showEmergency(level: 'low' | 'high' | 'symptom', value?: number) {
  if (level === 'symptom') alertDialog(t('alert.symptomTitle'), t('alert.symptomBody'));
  else showGlucoseAlert(level, value ?? 0);
}

/** Latest reading for context: only the number and its age, only if from the last 6 hours. */
function recentGlucose(): { value: number; ageMin: number } | null {
  const g = lastGlucose();
  if (!g?.value) return null;
  const ageMin = Math.round((Date.now() - g.ts) / 60000);
  return ageMin <= 360 ? { value: g.value, ageMin } : null;
}

async function askBerto(question: string) {
  // 1) Safety rules on the phone first: emergencies and dose questions never reach the model.
  const glucose = recentGlucose();
  const em = emergencyCheck(question, glucose, getLang());
  if (em) { say(em.reply); showEmergency(em.level, em.value); return; }
  if (isDoseQuestion(question)) { say(`${doseReplyFor(getLang())} ${disclaimerFor(getLang())}`); return; }
  // 2) MedGemma: orb "working", spoken filler, then stream sentences into one bubble and speak each one.
  askingLLM = true;
  setOrb('working');
  const b = el(`<div class="bubble bot ai pending" aria-busy="true"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="txt">…</span><span class="ai-tag">${ICON.sparkle}MedGemma (demo)</span></div>`);
  chat.append(b);
  while (chat.children.length > MAX_BUBBLES) chat.firstElementChild!.remove();
  b.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  const txt = b.querySelector('.txt') as HTMLElement;
  const parts: string[] = [];
  const r = await askLLM(question, glucose, (sentence) => {
    parts.push(sentence);
    b.classList.remove('pending'); b.removeAttribute('aria-busy');
    txt.textContent = parts.join(' ');
    enqueueSpeech(sentence);
    b.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  askingLLM = false;
  const final = r.reply ?? `${parts.join(' ')} ${doctorFallbackFor(getLang())}`;
  b.classList.remove('pending'); b.removeAttribute('aria-busy');
  txt.textContent = final;
  // speak whatever the stream did not already say (disclaimer, fallback, or a non-streamed reply)
  const spoken = parts.join(' ');
  const rest = final.startsWith(spoken) ? final.slice(spoken.length).trim() : final;
  if (rest) enqueueSpeech(rest);
  else if (!queueSpeaking) setOrb('idle');
  if (r.emergency) showEmergency(r.emergency.level, r.emergency.value);
}

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = input.value; input.value = '';
  handleUserText(v);
});

// ---------- voice ----------
function startListening(onText: (s: string) => void = handleUserText) {
  if (isTranscribing()) return;                       // already working on what was said
  if (isListening()) { stopListening(); return; }     // tap again = done talking
  if (!sttSupported()) { toast(t('composer.noMic')); input.focus(); return; }
  setOrb('listening');
  orb.classList.add('listening');
  const lvl = (v: number) => orb.style.setProperty('--lvl', v.toFixed(2));
  listen({
    onLevel: lvl,
    onInterim: (s) => { setStatus(`“${s}”`); },
    onProcessing: () => { orb.classList.remove('listening'); lvl(0); setOrb('thinking'); setStatus(t('orb.transcribing')); },
    onText: (s) => { orb.classList.remove('listening'); setOrb('idle'); onText(s); },
    onError: (code) => {
      orb.classList.remove('listening'); lvl(0);
      setOrb('idle');
      if (code === 'not-allowed' || code === 'service-not-allowed') { addHint('mic', t(isIOS() ? 'composer.micDeniedIOS' : 'composer.micDenied'), false); }
      else if (code === 'unsupported' || code === 'no-mic') toast(t('composer.noMic'));
      else if (code === 'stt-failed') toast(t('composer.sttFailed'));
      else if (code !== 'aborted') toast(t('composer.didNotHear'));
    },
    onEnd: () => {
      orb.classList.remove('listening'); lvl(0);
      if (orb.classList.contains('busy') && statusEl.textContent !== t('orb.speaking') && !askingLLM) setOrb('idle');
    },
  });
}
orb.addEventListener('click', () => startListening());

installAudioUnlock();
const syncTerms = () => setSpeechTerms(db.get().meds.map((m) => m.name));
syncTerms();
db.onChange(syncTerms);
const showVoiceHint = () => { if (!db.get().hints.voice) addHint('voice', t('voice.noFilVoice')); };
initVoices(
  (canSpeak) => { if (canSpeak) document.getElementById('hint-voice')?.remove(); else showVoiceHint(); },
  showVoiceHint, // server voice kept failing and no device Filipino voice
);

// ---------- hints ----------
function addHint(id: string, text: string, remember = true) {
  if (document.getElementById(`hint-${id}`)) return;
  const n = el(`<div class="hint enter" id="hint-${id}" role="note"><span class="hint-icon">${ICON.info}</span><div>${esc(text)}</div><button>${esc(t('voice.dismiss'))}</button></div>`);
  n.querySelector('button')!.addEventListener('click', () => { if (remember) db.save((r) => { r.hints[id] = true; }); n.remove(); });
  $('#hints').append(n);
}

// ---------- glucose alert ----------
function showGlucoseAlert(level: 'low' | 'high', value: number) {
  const k = level === 'low' ? 'low' : 'high';
  alertDialog(t(`alert.${k}Title`, { value }), t(`alert.${k}Body`));
}

// ---------- About ----------
function openAbout() {
  const o = el(`<div class="overlay center" role="dialog" aria-modal="true" aria-labelledby="aboutTitle">
    <div class="dialog about">
      <div class="about-top"><img src="${LOGO_SRC}" alt="${esc(t('app.logoAlt'))}" /><h2 id="aboutTitle">${esc(t('about.title'))}</h2></div>
      <section class="about-sec"><h3><label for="langSel">${esc(t('settings.language'))}</label></h3>
        <select id="langSel" class="lang-sel">${languages().map((l) => `<option value="${l.code}"${l.code === getLang() ? ' selected' : ''}>${esc(l.native)}${l.native !== l.name ? ` — ${esc(l.name)}` : ''}</option>`).join('')}</select>
        <p class="muted">${esc(t('settings.languageAuto'))}</p></section>
      <section class="about-sec"><h3>${esc(t('about.gapTitle'))}</h3><p>${esc(t('about.gap'))}</p></section>
      <section class="about-sec"><h3>${esc(t('about.missionTitle'))}</h3><p class="mission">${esc(t('about.mission'))}</p></section>
      <section class="about-sec"><h3>${esc(t('about.bertoTitle'))}</h3><p>${esc(t('about.berto'))}</p></section>
      <section class="about-sec"><h3>${esc(t('about.privacyTitle'))}</h3><p>${esc(t('about.privacy'))}</p></section>
      <section class="about-sec"><h3>${esc(t('about.aiTitle'))} <span class="chip skeleton" id="aiState">${esc(t('about.aiChecking'))}</span></h3><p>${esc(t('about.ai'))}</p>
        <p class="license">${esc(t('about.aiLicense'))} <a href="https://developers.google.com/health-ai-developer-foundations/terms" target="_blank" rel="noopener">${esc(t('about.aiTerms'))}</a></p></section>
      <p class="disclaimer">${ICON.info}<span>${esc(t('about.disclaimer'))}</span></p>
      <div class="dialog-foot">
        <span class="muted">${esc(t('about.version'))}</span>
        <button class="btn primary" data-close style="min-width:120px">${esc(t('about.close'))}</button>
      </div>
    </div></div>`);
  const close = mountOverlay(o, { onEscape: () => close(), focus: '[data-close]' });
  o.addEventListener('click', (e) => { if (e.target === o || (e.target as HTMLElement).closest('[data-close]')) close(); });
  llmStatus(true).then((st) => {
    const pill = o.querySelector('#aiState') as HTMLElement | null;
    if (!pill) return;
    pill.textContent = st.ready ? t('about.aiOn') : t('about.aiOff');
    pill.classList.remove('skeleton');
    pill.classList.add(st.ready ? 'ok' : 'plain');
  });
}
$('#logoBtn').addEventListener('click', openAbout);
function updateLangBtn() { $('#langBtn').textContent = `🌐 ${LANGS[getLang()].native}`; }
$('#langBtn').addEventListener('click', openAbout);
// Picker change: persist and reload so every screen re-renders in the new language.
document.addEventListener('change', (e) => {
  const s = e.target as HTMLSelectElement;
  if (s?.id === 'langSel' && setLang(s.value)) location.reload();
});

// ---------- sheets ----------
let openSheet: { name: 'meds' | 'log'; el: HTMLElement; close: () => void } | null = null;
function closeSheet() { openSheet?.close(); openSheet = null; setTab('talk'); }
function setTab(name: string) {
  document.querySelectorAll<HTMLElement>('nav.tabs button').forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
}
function showSheet(name: 'meds' | 'log') {
  if (openSheet) { openSheet.el.remove(); openSheet = null; }
  const o = el(`<div class="overlay"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle"></div></div>`);
  o.addEventListener('click', (e) => { if (e.target === o) closeSheet(); });
  const close = mountOverlay(o, { onEscape: closeSheet, focus: '#sheetTitle' });
  openSheet = { name, el: o, close };
  setTab(name);
  refreshOpenSheet();
  (o.querySelector('#sheetTitle') as HTMLElement | null)?.focus({ preventScroll: true });
}
function refreshOpenSheet() {
  if (!openSheet) return;
  const s = openSheet.el.querySelector('.sheet') as HTMLElement;
  const scroll = s.scrollTop;
  s.innerHTML = '';
  (openSheet.name === 'meds' ? renderMeds : renderLog)(s);
  bindSheetDrag(s);
  s.scrollTop = scroll;
}
document.querySelectorAll<HTMLElement>('nav.tabs button').forEach((b) => b.addEventListener('click', () => {
  const tab = b.dataset.tab!;
  if (tab === 'talk') closeSheet(); else showSheet(tab as 'meds' | 'log');
}));

function sheetHeader(title: string) {
  return `<div class="sheet-head" title="${esc(t('common.dragToClose'))}"><span class="grab" aria-hidden="true"></span>
    <div class="sheet-title"><h2 id="sheetTitle" tabindex="-1">${esc(title)}</h2><button class="btn outline sm" data-close>${esc(t('common.close'))}</button></div></div>`;
}

/** Drag the sheet header down to dismiss (spring back if not far enough). */
function bindSheetDrag(s: HTMLElement) {
  const head = s.querySelector<HTMLElement>('.sheet-head');
  if (!head) return;
  let y0 = 0, t0 = 0, dy = 0, active = false;
  head.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    active = true; y0 = e.clientY; t0 = performance.now(); dy = 0;
    s.classList.remove('settle'); s.classList.add('dragging');
    head.setPointerCapture(e.pointerId);
  });
  head.addEventListener('pointermove', (e) => {
    if (!active) return;
    dy = Math.max(0, e.clientY - y0);
    s.style.transform = `translateY(${dy}px)`;
    (s.parentElement as HTMLElement).style.backgroundColor = `rgba(9,22,44,${Math.max(0.1, 0.42 - dy / 900)})`;
  });
  const end = () => {
    if (!active) return; active = false;
    s.classList.remove('dragging');
    const v = dy / Math.max(1, performance.now() - t0);
    if (dy > 110 || (dy > 40 && v > 0.6)) { closeSheet(); return; }
    s.classList.add('settle'); s.style.transform = ''; (s.parentElement as HTMLElement).style.backgroundColor = '';
  };
  head.addEventListener('pointerup', end);
  head.addEventListener('pointercancel', end);
}

// ---------- Medicines ----------
function pushStatusHTML(): string {
  const r = db.get();
  if (!r.meds.length) return '';
  if (!pushSupported()) {
    if (isIOS() && !isStandalone()) return `<div class="hint" role="note"><span class="hint-icon">${ICON.info}</span><div>${esc(t('push.iosInstall'))}</div></div>`;
    return `<p class="muted">${esc(t('push.unsupported'))}</p>`;
  }
  if (r.pushEnabled && permission() === 'granted')
    return `<div class="row" style="justify-content:space-between"><span class="chip ok">${esc(t('push.enabled'))}</span><button class="btn outline sm" data-test-push>${esc(t('push.test'))}</button></div>`;
  if (permission() === 'denied') return `<p class="muted">${esc(t('push.denied'))}</p>`;
  return `<div class="card enter"><div class="rem-head" style="margin-bottom:8px"><span class="rem-icon" style="background:var(--aim)">${ICON.bell}</span>
    <div style="font-weight:var(--fw-heavy);font-size:var(--fs-lg);line-height:1.25">${esc(t('push.enableTitle'))}</div></div>
    <p style="margin:0 0 14px;color:var(--ink-2)">${esc(t('push.enableBody'))}</p>
    <button class="btn green block" data-enable-push>${ICON.bell}${esc(t('push.enableBtn'))}</button></div>`;
}

function renderMeds(s: HTMLElement) {
  const r = db.get();
  const doses = todaysDoses();
  const now = manilaNow().minutes;
  const taken = doses.filter((d) => d.status === 'taken').length;
  const timeline = doses.map((d) => {
    const mins = toMinutes(d.time);
    const late = !d.status && mins < now;
    const due = !d.status && mins <= now && now - mins <= DUE_WINDOW_MIN;
    const cls = d.status ? `is-${d.status}` : due ? 'is-due' : 'is-pending';
    const chip = d.status ? `<span class="chip ${d.status === 'taken' ? 'ok' : 'danger'}">${esc(t(`meds.${d.status}`))}</span>`
      : due ? `<span class="chip warn">${esc(t('meds.now'))}</span>` : `<span class="chip">${esc(t('meds.pending'))}</span>`;
    const node = d.status === 'taken' ? ICON.check : d.status === 'missed' ? ICON.x : '';
    const btns = d.status
      ? `<button class="btn ghost sm" data-undo="${d.med.id}|${d.time}">${esc(t('meds.undo'))}</button>`
      : `<button class="btn green" data-take="${d.med.id}|${d.time}">${ICON.check}${esc(t('meds.markTaken'))}</button>${late ? `<button class="btn danger" data-miss="${d.med.id}|${d.time}">${esc(t('meds.markMissed'))}</button>` : ''}`;
    const [hm, ap] = fmt12(d.time).split(' ');
    return `<li class="tl-item ${cls}">
      <div class="tl-time"><span class="hm">${esc(hm)}</span><span class="ap">${esc(ap ?? '')}</span></div>
      <div class="tl-node" aria-hidden="true">${node}</div>
      <div class="tl-body"><div class="tl-title">${esc(d.med.name)}</div>
        <div class="tl-sub">${d.med.dose ? `<span>${esc(d.med.dose)}</span>` : ''}${chip}</div>
        <div class="tl-actions">${btns}</div></div></li>`;
  }).join('');
  const pct = doses.length ? Math.round((taken / doses.length) * 100) : 0;
  s.innerHTML = `${sheetHeader(t('meds.title'))}
    <div id="pushBox" style="margin-top:4px">${pushStatusHTML()}</div>
    <h3>${esc(t('meds.today'))}</h3>
    ${doses.length ? `<div class="card progress-card" style="margin-bottom:12px">
        <div class="p-text">${esc(taken === doses.length ? t('meds.allDone') : t('meds.progress', { done: taken, total: doses.length }))}</div>
        <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="${doses.length}" aria-valuenow="${taken}" aria-label="${esc(t('meds.progress', { done: taken, total: doses.length }))}"><i style="width:${pct}%"></i></div></div>
      <ol class="timeline">${timeline}</ol>`
      : `<div class="empty"><span class="empty-ico">${ICON.meds}</span><p>${esc(t('meds.empty'))}</p></div>`}
    ${r.meds.length ? `<h3>${esc(t('meds.list'))}</h3><div class="list">${r.meds.map((m) => `
      <div class="item"><span class="avatar">${ICON.meds}</span><div class="main"><div class="title">${esc(m.name)} ${m.dose ? `<span class="muted">${esc(m.dose)}</span>` : ''}</div>
      <div class="times-chips">${m.times.map((x) => `<span class="chip plain info num">${esc(fmt12(x))}</span>`).join('')}</div></div>
      <button class="btn danger sm" data-del="${m.id}" aria-label="${esc(t('meds.delete'))} ${esc(m.name)}">${esc(t('meds.delete'))}</button></div>`).join('')}</div>` : ''}
    <h3>${esc(t('meds.add'))}</h3>
    <form id="medForm" class="card form-card" novalidate>
      <label class="field">${esc(t('meds.name'))}<input name="name" placeholder="${esc(t('meds.namePh'))}" autocapitalize="words" required /></label>
      <label class="field">${esc(t('meds.dose'))}<input name="dose" placeholder="${esc(t('meds.dosePh'))}" /></label>
      <div class="field" role="group" aria-label="${esc(t('meds.times'))}">${esc(t('meds.times'))}
        <div class="times" id="times"><div class="time-field"><input class="input" type="time" name="time" value="08:00" required aria-label="${esc(t('meds.times'))} 1" /></div></div>
        <button type="button" class="btn outline sm" id="addTime" style="align-self:flex-start;margin-top:4px">${ICON.plus}${esc(t('meds.addTime').replace(/^\+\s*/, ''))}</button></div>
      <button class="btn primary lg block" type="submit">${esc(t('meds.add'))}</button>
    </form>`;

  s.querySelector('[data-close]')!.addEventListener('click', closeSheet);
  s.querySelector('#addTime')!.addEventListener('click', () => {
    const box = s.querySelector('#times')!;
    const f = el(`<div class="time-field removable enter"><input class="input" type="time" name="time" value="20:00" aria-label="${esc(t('meds.times'))} ${box.children.length + 1}" />
      <button type="button" class="rm" aria-label="${esc(t('meds.removeTime'))}">${ICON.x}</button></div>`);
    f.querySelector('.rm')!.addEventListener('click', () => f.remove());
    box.append(f);
    f.querySelector('input')!.focus();
  });
  s.querySelector<HTMLFormElement>('#medForm')!.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target as HTMLFormElement);
    const name = String(fd.get('name') ?? '').trim();
    const times = [...new Set(fd.getAll('time').map(String).filter(Boolean))].sort();
    if (!name || !times.length) { toast(t('meds.needName')); return; }
    const first = db.get().meds.length === 0;
    db.save((rec) => { rec.meds.push({ id: uid(), name, dose: String(fd.get('dose') ?? '').trim(), times }); });
    toast(t('meds.added', { name }));
    syncSchedule();
    refreshOpenSheet();
    renderReminders();
    if (first) maybeOfferPush();
  });
  s.querySelectorAll<HTMLElement>('[data-take],[data-miss],[data-undo]').forEach((b) => b.addEventListener('click', () => {
    const [id, time] = (b.dataset.take ?? b.dataset.miss ?? b.dataset.undo)!.split('|');
    if (b.dataset.take) haptic([10, 40, 14]);
    db.setDose(id, time, b.dataset.take ? 'taken' : b.dataset.miss ? 'missed' : null);
    refreshOpenSheet(); renderReminders();
  }));
  s.querySelectorAll<HTMLElement>('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    const m = db.get().meds.find((x) => x.id === b.dataset.del);
    if (!m || !(await confirmDialog(t('meds.confirmDelete', { name: m.name }), t('meds.delete')))) return;
    db.save((rec) => { rec.meds = rec.meds.filter((x) => x.id !== m.id); });
    syncSchedule(); refreshOpenSheet(); renderReminders();
  }));
  bindPushButtons(s);
}

function bindPushButtons(root: HTMLElement) {
  root.querySelector('[data-enable-push]')?.addEventListener('click', async () => {
    const res = await enablePush();
    toast(t(res === 'enabled' ? 'push.enabled' : res === 'denied' ? 'push.denied' : res === 'unsupported' ? 'push.unsupported' : 'push.failed'));
    refreshOpenSheet();
    document.getElementById('push-offer')?.remove();
  });
  root.querySelector('[data-test-push]')?.addEventListener('click', async () => {
    toast(t((await sendTestPush()) ? 'push.testSent' : 'push.failed'));
  });
}

/** Offer notifications right after the first reminder is added (never on page load). */
function maybeOfferPush() {
  const r = db.get();
  if (!r.meds.length || (r.pushEnabled && permission() === 'granted') || permission() === 'denied') return;
  if (openSheet?.name === 'meds') return; // the sheet already shows the button
  if (document.getElementById('push-offer')) return;
  const n = el(`<div id="push-offer">${pushStatusHTML()}</div>`);
  $('#hints').append(n);
  bindPushButtons(n);
}

// ---------- Log / history ----------
const LEVEL_TONE: Record<string, string> = { low: 'danger', very_high: 'danger', high: 'warn', elevated: 'warn', normal: 'ok' };
const LEVEL_COLOR: Record<string, string> = { low: '#B3261E', very_high: '#B3261E', high: '#B45F00', elevated: '#B45F00', normal: '#14653A' };

/** Lightweight SVG sparkline of recent readings with the 70–180 mg/dL band shaded. */
function sparkline(pts: { v: number; lvl: string }[]): string {
  const W = 320, H = 96, PX = 10, PY = 10;
  const vals = pts.map((p) => p.v);
  const lo = Math.min(60, Math.min(...vals) - 10), hi = Math.max(220, Math.max(...vals) + 20);
  const x = (i: number) => (pts.length === 1 ? W / 2 : PX + (i * (W - 2 * PX)) / (pts.length - 1));
  const y = (v: number) => PY + (1 - (v - lo) / (hi - lo)) * (H - 2 * PY);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(pts.length - 1).toFixed(1)} ${H} L${x(0).toFixed(1)} ${H} Z`;
  const last = pts[pts.length - 1];
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t('log.trendAria', { n: pts.length, min: Math.min(...vals), max: Math.max(...vals), last: last.v }))}">
    <defs><linearGradient id="sparkFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#0072BC" stop-opacity=".18"/><stop offset="1" stop-color="#0072BC" stop-opacity="0"/></linearGradient></defs>
    <rect x="0" y="${y(180).toFixed(1)}" width="${W}" height="${(y(70) - y(180)).toFixed(1)}" rx="8" fill="rgba(0,166,81,.10)"/>
    <line x1="0" x2="${W}" y1="${y(180).toFixed(1)}" y2="${y(180).toFixed(1)}" stroke="rgba(26,115,64,.45)" stroke-dasharray="4 4"/>
    <line x1="0" x2="${W}" y1="${y(70).toFixed(1)}" y2="${y(70).toFixed(1)}" stroke="rgba(26,115,64,.45)" stroke-dasharray="4 4"/>
    ${pts.length > 1 ? `<path d="${area}" fill="url(#sparkFill)"/><path d="${line}" fill="none" stroke="#00529B" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>` : ''}
    ${pts.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="${i === pts.length - 1 ? 6.5 : 4}" fill="${LEVEL_COLOR[p.lvl]}" stroke="#fff" stroke-width="2"/>`).join('')}
  </svg>`;
}

let glucoseCtx: GlucoseCtx = 'fasting';
function renderLog(s: HTMLElement) {
  const r = db.get();
  const items = [...r.logs].filter((l) => l.type !== 'nudge' || l.context === 'walk').reverse().slice(0, 60);
  const medName = (id?: string) => r.meds.find((m) => m.id === id)?.name ?? '—';
  const lvlOf = (l: LogEntry) => classifyGlucose(l.value!, (l.context as GlucoseCtx) ?? 'random');
  const TYPE_ICON: Record<string, [string, string]> = { glucose: [ICON.drop, ''], dose: [ICON.meds, 'green'], symptom: [ICON.note, 'warn'], meal: [ICON.bowl, 'green'], walk: [ICON.walk, 'green'], nudge: [ICON.walk, 'green'] };
  const line = (l: LogEntry) => {
    let main = '', pill = '', sub = t(`log.type.${l.type}`);
    if (l.type === 'glucose') {
      const lvl = lvlOf(l);
      main = `${l.value} mg/dL`; sub = t(`bot.ctx.${l.context ?? 'random'}`);
      pill = `<span class="chip ${LEVEL_TONE[lvl]}">${esc(t(`log.level.${lvl}`))}</span>`;
    } else if (l.type === 'dose') { main = medName(l.medId); pill = `<span class="chip ${l.status === 'taken' ? 'ok' : 'danger'}">${esc(t(`meds.${l.status}`))}</span>`; }
    else if (l.type === 'nudge') { main = `${t('log.type.walk')}: ${l.text}`; }
    else if (l.type === 'walk') { main = l.value ? t('log.minutes', { n: l.value }) : t('log.type.walk'); }
    else main = l.text ?? '';
    const [ico, tone] = TYPE_ICON[l.type] ?? [ICON.note, ''];
    return `<div class="item"><span class="avatar ${tone}">${ico}</span><div class="main"><div class="title">${esc(main)}</div><div class="sub">${esc(sub)} · ${esc(relDay(l.ts))}</div></div>${pill}</div>`;
  };
  const readings = r.logs.filter((l) => l.type === 'glucose' && l.value).slice(-14);
  const latest = readings[readings.length - 1];
  const hero = latest ? (() => {
    const lvl = lvlOf(latest);
    return `<div class="card hero">
      <div class="eyebrow">${esc(t('log.latest'))}</div>
      <div class="hero-row"><span class="big">${latest.value}</span><span class="unit">mg/dL</span><span class="chip ${LEVEL_TONE[lvl]}">${esc(t(`log.level.${lvl}`))}</span></div>
      <div class="meta">${esc(t(`bot.ctx.${latest.context ?? 'random'}`))} · ${esc(relDay(latest.ts))}</div>
      ${sparkline(readings.map((l) => ({ v: l.value!, lvl: lvlOf(l) })))}
      <div class="spark-legend"><span class="band">${esc(t('log.target'))}</span><span>${esc(t('log.trendCount', { n: readings.length }))}</span></div>
    </div>`;
  })() : `<div class="empty"><span class="empty-ico">${ICON.drop}</span><p>${esc(t('log.noReadings'))}</p></div>`;
  s.innerHTML = `${sheetHeader(t('log.title'))}
    ${hero}
    <h3>${esc(t('log.glucose'))}</h3>
    <form id="gForm" class="card form-card">
      <div class="seg" role="radiogroup" aria-label="${esc(t('log.glucose'))}">${(['fasting', 'after_meal', 'random'] as GlucoseCtx[]).map((c) =>
        `<button type="button" role="radio" aria-checked="${c === glucoseCtx}" data-ctx="${c}" class="${c === glucoseCtx ? 'on' : ''}">${esc(t(c === 'fasting' ? 'log.fasting' : c === 'after_meal' ? 'log.afterMeal' : 'log.random'))}</button>`).join('')}</div>
      <div class="inline-form num-form">
        <div class="num-field"><input class="input" name="v" type="number" inputmode="numeric" min="20" max="600" placeholder="${esc(t('log.glucosePh'))}" aria-label="${esc(t('log.glucose'))} (${esc(t('log.unit'))})" /><span class="suffix" aria-hidden="true">${esc(t('log.unit'))}</span></div>
        <button class="btn primary" type="submit">${esc(t('log.save'))}</button>
      </div>
    </form>
    <h3>${esc(t('log.symptoms'))}</h3>
    <form id="sForm" class="inline-form"><input class="input" name="v" placeholder="${esc(t('log.symptomsPh'))}" aria-label="${esc(t('log.symptoms'))}" /><button class="btn primary">${esc(t('log.save'))}</button></form>
    <h3>${esc(t('log.meal'))}</h3>
    <form id="mForm" class="inline-form"><input class="input" name="v" placeholder="${esc(t('log.mealPh'))}" aria-label="${esc(t('log.meal'))}" /><button class="btn primary">${esc(t('log.save'))}</button></form>
    <h3>${esc(t('log.history'))}</h3>
    ${items.length ? `<div class="list">${items.map(line).join('')}</div>` : `<div class="empty"><span class="empty-ico">${ICON.note}</span><p>${esc(t('log.noHistory'))}</p></div>`}
    <h3>${esc(t('log.export'))}</h3>
    <div class="export-row"><button class="btn outline" data-exp="csv">${ICON.download}${esc(t('log.exportCsv'))}</button><button class="btn outline" data-exp="json">${ICON.download}${esc(t('log.exportJson'))}</button></div>
    <div class="wipe"><button class="btn link-danger sm" data-wipe>${esc(t('log.deleteAll'))}</button></div>`;

  s.querySelector('[data-close]')!.addEventListener('click', closeSheet);
  s.querySelectorAll<HTMLElement>('[data-ctx]').forEach((b) => b.addEventListener('click', () => { glucoseCtx = b.dataset.ctx as GlucoseCtx; refreshOpenSheet(); }));
  s.querySelector('#gForm')!.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = Number(new FormData(e.target as HTMLFormElement).get('v'));
    if (!(v >= 20 && v <= 600)) { toast(t('log.invalidGlucose')); return; }
    const rep = logGlucose(v, glucoseCtx);
    if (rep.alert) showGlucoseAlert(rep.alert.level, rep.alert.value); else { haptic([10, 40, 14]); toast(t('log.saved')); }
    refreshOpenSheet();
  });
  for (const [id, type] of [['#sForm', 'symptom'], ['#mForm', 'meal']] as const) {
    s.querySelector(id)!.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = String(new FormData(e.target as HTMLFormElement).get('v') ?? '').trim();
      if (!v) return;
      db.addLog({ type, text: v }); toast(t('log.saved')); refreshOpenSheet();
    });
  }
  s.querySelectorAll<HTMLElement>('[data-exp]').forEach((b) => b.addEventListener('click', () => {
    const csv = b.dataset.exp === 'csv';
    const blob = new Blob([csv ? '\ufeff' + exportCSV() : exportJSON()], { type: csv ? 'text/csv' : 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `berto-talaan-${manilaNow().date}.${csv ? 'csv' : 'json'}`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }));
  s.querySelector('[data-wipe]')!.addEventListener('click', async () => {
    if (!(await confirmDialog(t('log.confirmDeleteAll'), t('meds.delete')))) return;
    db.wipe(); closeSheet(); renderReminders(); chat.innerHTML = '';
  });
}

// ---------- Reminders: in-app card + local fallback while open ----------
const DUE_WINDOW_MIN = 120; // show "time to take" card for 2h after the scheduled time

function renderReminders() {
  const box = $('#reminders');
  const now = manilaNow().minutes;
  const due = todaysDoses().filter((d) => !d.status && toMinutes(d.time) <= now && now - toMinutes(d.time) <= DUE_WINDOW_MIN);
  box.innerHTML = due.map((d) => `
    <div class="card reminder enter" role="region" aria-label="${esc(t('reminder.title'))}">
      <div class="rem-head"><span class="rem-icon">${ICON.clock}</span>
        <div><div class="t">${esc(t('reminder.title'))}</div><div class="num" style="font-weight:var(--fw-heavy);font-size:var(--fs-lg);line-height:1.2">${esc(fmt12(d.time))}</div></div></div>
      <div class="rem-med">${esc(d.med.name)} ${d.med.dose ? `<span>${esc(d.med.dose)}</span>` : ''}</div>
      <div class="btn-row" style="margin-top:14px"><button class="btn green" data-take="${d.med.id}|${d.time}">${ICON.check}${esc(t('meds.markTaken'))}</button>
      <button class="btn danger" data-miss="${d.med.id}|${d.time}">${esc(t('meds.markMissed'))}</button></div>
    </div>`).join('');
  box.querySelectorAll<HTMLElement>('[data-take],[data-miss]').forEach((b) => b.addEventListener('click', () => {
    const [id, time] = (b.dataset.take ?? b.dataset.miss)!.split('|');
    const name = db.get().meds.find((m) => m.id === id)?.name ?? '';
    if (b.dataset.take) haptic([10, 40, 14]);
    db.setDose(id, time, b.dataset.take ? 'taken' : 'missed');
    say(t(b.dataset.take ? 'bot.medTaken' : 'bot.medMissed', { name }));
    renderReminders(); refreshOpenSheet();
  }));
}

/** While the app is open: speak + (if allowed) show a local notification at each dose time. */
function localReminderTick() {
  const { date, hhmm } = manilaNow();
  const fired: string[] = [];
  for (const d of todaysDoses()) {
    const key = `${date}|${d.med.id}|${d.time}`;
    if (d.status || d.time !== hhmm || db.get().firedLocal[key]) continue;
    db.save((r) => { r.firedLocal[key] = Date.now(); });
    fired.push(d.med.name);
    // If push is on, the server push covers the system notification; otherwise show one locally.
    if (!db.get().pushEnabled && permission() === 'granted') {
      navigator.serviceWorker?.ready.then((reg) => reg.showNotification(t('reminder.title'), {
        body: t('reminder.body', { name: d.med.name, dose: d.med.dose ? ` ${d.med.dose}` : '', time: fmt12(d.time) }),
        icon: '/icons/icon-192.png', tag: `med-${key}`,
        data: { kind: 'reminder', medId: d.med.id, time: d.time, date },
      }));
    }
  }
  if (fired.length) say(t('reminder.say', { name: listJoin(fired) }));
  renderReminders();
}

function markFromNotification(medId: string, time: string, date?: string) {
  const med = db.get().meds.find((m) => m.id === medId);
  if (!med) return;
  db.setDose(medId, time, 'taken', date || manilaNow().date);
  say(t('reminder.loggedTaken', { name: med.name }));
  renderReminders(); refreshOpenSheet();
}

navigator.serviceWorker?.addEventListener('message', (e) => {
  const m = e.data || {};
  if (m.type === 'push' && m.data?.kind === 'reminder') {
    const key = `${m.data.date}|${m.data.medId}|${m.data.time}`;
    if (!db.get().firedLocal[key]) { db.save((r) => { r.firedLocal[key] = Date.now(); }); say(t('reminder.say', { name: m.data.name })); }
    renderReminders();
  } else if (m.type === 'push' && m.data?.kind === 'test') {
    bubble('bot', m.data.body);
  } else if (m.type === 'notification-click' && m.action === 'taken' && m.data?.kind === 'reminder') {
    markFromNotification(m.data.medId, m.data.time, m.data.date);
  }
});

// Opened from a notification: /?r=<medId>&t=<HH:MM>&d=<date>&a=taken
{
  const q = new URLSearchParams(location.search);
  if (q.get('r') && q.get('t')) {
    if (q.get('a') === 'taken') markFromNotification(q.get('r')!, q.get('t')!, q.get('d') ?? undefined);
    history.replaceState(null, '', '/');
  }
}

// ---------- Health nudge ----------
function renderNudge(kind: NudgeKind) {
  const box = $('#nudge');
  box.innerHTML = `<div class="card nudge enter" role="region" aria-labelledby="nudgeQ">
    <div class="nudge-head"><img class="nudge-mark" src="/brand/mark.svg" alt="" aria-hidden="true" /><div class="q" id="nudgeQ">${esc(t(`nudge.${kind}`))}</div>
      <button class="btn ghost sm later" data-a="later">${esc(t('nudge.later'))}</button></div>
    <div class="nudge-actions">
      <button class="btn green" data-a="yes">${esc(t('nudge.yes'))}</button>
      <button class="btn outline" data-a="no">${esc(t('nudge.no'))}</button>
      <button class="btn primary" data-a="say">${ICON.mic}${esc(t('nudge.say'))}</button>
    </div></div>`;
  speakOut(t(`nudge.${kind}`)); // may stay silent until the first tap unlocks audio (iOS)
  const done = () => { box.innerHTML = ''; };
  const ask = { glucose: 'nudge.askGlucose', symptoms: 'nudge.askSymptoms', meal: 'nudge.askMeal', walk: '' }[kind];

  /** Interpret a free answer (spoken or typed) for this nudge. */
  const takeAnswer = (text: string): boolean => {
    if (kind === 'glucose') {
      const it = parseIntent(/\d/.test(text) && !/sugar|glucose/i.test(text) ? `${text} fasting sugar` : text, db.get().meds);
      if (it.kind === 'glucose') { answered(kind, 'value', it.value); handleReply(logGlucose(it.value, 'fasting')); done(); return true; }
      if (it.kind === 'no') { answered(kind, 'no'); say(t('nudge.glucoseNo')); done(); return true; }
      return false;
    }
    const it = parseIntent(text, db.get().meds);
    if (kind === 'walk') {
      if (it.kind === 'no') { answered(kind, 'no'); say(t('nudge.walkNo')); }
      else { answered(kind, 'yes'); db.addLog({ type: 'walk', text }); say(t('nudge.walkYes')); }
      done(); return true;
    }
    if (it.kind === 'no') { answered(kind, 'no'); if (kind === 'symptoms') db.addLog({ type: 'symptom', text: 'walang symptoms' }); say(t(kind === 'symptoms' ? 'nudge.symptomsNo' : 'nudge.mealNo')); done(); return true; }
    if (it.kind === 'yes') return false;
    answered(kind, 'yes');
    db.addLog({ type: kind === 'symptoms' ? 'symptom' : 'meal', text });
    say(t('nudge.thanks')); done(); return true;
  };

  const askFollowUp = () => {
    say(t(ask));
    pendingAnswer = takeAnswer;
    input.placeholder = t(ask); input.focus();
    setTimeout(() => { input.placeholder = t('composer.placeholder'); }, 15000);
  };

  box.querySelectorAll<HTMLElement>('[data-a]').forEach((b) => b.addEventListener('click', () => {
    const a = b.dataset.a;
    if (a === 'later') { snooze(); toast(t('nudge.snoozed')); done(); return; }
    if (a === 'say') { startListening((s) => { bubble('me', s); if (!takeAnswer(s)) { pendingAnswer = takeAnswer; say(t(ask || `nudge.${kind}`)); } }); return; }
    if (a === 'no') { takeAnswer('hindi pa'); return; }
    // yes
    if (kind === 'walk') { answered(kind, 'yes'); db.addLog({ type: 'walk', text: 'Oo' }); say(t('nudge.walkYes')); done(); return; }
    askFollowUp();
  }));
}

function nudgeTick() {
  if ($('#nudge').children.length) return;
  const k = dueNudge();
  if (k) renderNudge(k);
}

// ---------- boot ----------
function greet() {
  const { hh } = manilaNow();
  bubble('bot', t(hh < 12 ? 'greeting.morning' : hh < 18 ? 'greeting.afternoon' : 'greeting.evening'));
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(() => refreshSubscription()).catch((e) => console.warn('SW failed', e));
}

if (isIOS() && !isStandalone() && !db.get().hints.ios) addHint('ios', t('push.iosInstall'));
greet();
renderReminders();
maybeOfferPush();
setTimeout(nudgeTick, FIRST_DELAY_MS);
setInterval(() => { localReminderTick(); nudgeTick(); }, 15_000);
localReminderTick();
document.addEventListener('visibilitychange', () => { if (!document.hidden) { localReminderTick(); nudgeTick(); } });

// exposed for debugging / tests
(window as any).berto = { db, respond, parseTimes, askBerto, isAsking: () => askingLLM };

// Fade out the instant-open splash (index.html) once the app has rendered.
requestAnimationFrame(() => {
  const s = document.getElementById('splash');
  if (s) { s.style.opacity = '0'; setTimeout(() => s.remove(), 300); }
});
