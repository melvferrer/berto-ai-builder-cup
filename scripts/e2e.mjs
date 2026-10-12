// End-to-end check with headless Chrome: loads the app, checks manifest + service worker,
// runs intent tests, subscribes to Web Push, and asks the server to send a test push.
// Usage: BASE_URL=https://... node scripts/e2e.mjs
import { chromium } from 'playwright-core';
const BASE = process.env.BASE_URL || 'http://localhost:8787';
import fs from 'node:fs';
const PROFILE = fs.mkdtempSync('/tmp/berto-e2e-');
// Push needs a persistent (non-incognito) profile in Chrome.
const ctx = await chromium.launchPersistentContext(PROFILE, { executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, args: ['--lang=fil-PH'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'fil-PH', timezoneId: 'Asia/Manila' });
await ctx.grantPermissions(['notifications'], { origin: BASE });
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
await page.goto(BASE, { waitUntil: 'networkidle' });

const out = {};
out.manifest = await page.evaluate(async () => { const l = document.querySelector('link[rel=manifest]'); const r = await fetch(l.href); const j = await r.json(); return { status: r.status, name: j.name, icons: j.icons.length, display: j.display }; });
out.swActive = await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; return !!r.active && r.active.scriptURL; });
out.header = await page.evaluate(() => ({ logo: document.querySelector('.brand img')?.getAttribute('src'), name: document.querySelector('.brand span')?.textContent }));
out.forbiddenWords = await page.evaluate(() => /jarvis|bertha|hit the orb/i.test(document.documentElement.outerHTML));

const cases = [
  '140 ang sugar ko', 'fasting 95', 'sugar ko 7.5 mmol', '55 sugar ko', '320 ang sugar ko pagkatapos kumain',
  'idagdag ang metformin 500mg alas 8 ng umaga at alas 8 ng gabi', 'add losartan 50mg 9am',
  'nainom ko na ang metformin', 'hindi ko nainom ang losartan', 'ano ang gamot ko ngayon?',
  'nahihilo ako', 'kumain ako ng kanin at tinola', 'naglakad ako ng 30 minutes', 'ano ang huling sugar ko',
  'hirap huminga si lolo', 'uminom ako ng tubig', 'ano ang pwede kong kainin?', 'xyz qwerty',
];
out.intents = await page.evaluate(async (cases) => {
  const res = [];
  for (const c of cases) { const r = await window.berto.respond(c); res.push([c, r.text.slice(0, 110), r.alert?.level ?? '']); }
  return res;
}, cases);
out.meds = await page.evaluate(() => window.berto.db.get().meds.map((m) => `${m.name} ${m.dose} ${m.times.join(',')}`));

// Push: subscribe via the app's own code path, then ask server for a test push
out.push = await page.evaluate(async () => {
  const mod = await import(document.querySelector('script[type=module]').src).catch(() => null);
  void mod;
  try {
    const reg = await navigator.serviceWorker.ready;
    const { key } = await (await fetch('/api/vapid-public-key')).json();
    const pad = '='.repeat((4 - (key.length % 4)) % 4);
    const raw = Uint8Array.from(atob((key + pad).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const sub = await Promise.race([reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw }), new Promise((_, rej) => setTimeout(() => rej(new Error('subscribe timeout')), 20000))]);
    const deviceId = window.berto.db.get().deviceId;
    const s1 = await fetch('/api/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId, subscription: sub.toJSON() }) });
    window.berto.db.save((r) => { r.pushEnabled = true; });
    const reminders = window.berto.db.get().meds.flatMap((m) => m.times.map((time) => ({ medId: m.id, name: m.name, dose: m.dose, time })));
    const s2 = await fetch('/api/schedule', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId, reminders }) });
    const got = new Promise((res) => { navigator.serviceWorker.addEventListener('message', (e) => res(e.data)); setTimeout(() => res(null), 15000); });
    const t = await fetch('/api/test-push', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId }) });
    return { endpointHost: new URL(sub.endpoint).host, subscribe: s1.status, schedule: (await s2.json()), testPush: { status: t.status, body: await t.json() }, delivered: await got };
  } catch (e) { return { error: String(e) }; }
});
// Simulate push delivery into the service worker via DevTools (FCM delivery to headless Chrome is unreliable).
try {
  const cdp = await ctx.newCDPSession(page);
  const regs = new Promise((res) => cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => { const r = e.registrations.find((x) => x.scopeURL.startsWith(BASE)); if (r) res(r); }));
  await cdp.send('ServiceWorker.enable');
  const reg = await regs;
  await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); });
  const med = await page.evaluate(() => window.berto.db.get().meds[0]);
  await cdp.send('ServiceWorker.deliverPushMessage', { origin: new URL(BASE).origin, registrationId: reg.registrationId,
    data: JSON.stringify({ kind: 'test', title: 'Berto', body: 'CDP test push', tag: 'cdp-test' }) });
  await page.waitForTimeout(1500);
  out.swNotifications = await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => ({ title: n.title, body: n.body, actions: (n.actions || []).map((a) => a.title) })));
  void med;
} catch (e) { out.swNotifications = String(e); }
out.errors = logs.filter((l) => /error/i.test(l));
console.log(JSON.stringify(out, null, 2));
await ctx.close();
