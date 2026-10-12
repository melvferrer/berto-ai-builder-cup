// Speech-to-text check.
//  1) POSTs Taglish clips (iPhone-style audio/mp4 AAC and Chrome-style audio/webm Opus) to /api/stt.
//  2) Taps the orb in headless Chrome with a fake microphone playing a clip: MediaRecorder -> /api/stt ->
//     transcript bubble -> Berto's reply (exercises auto-stop on silence).
// Clips: CLIPS_DIR with c<N>.m4a / c<N>.webm / fake<N>.wav (make them with edge-tts + ffmpeg, see README).
// Usage: BASE_URL=http://127.0.0.1:8787 CLIPS_DIR=/workspace/caregenics/stt-test node scripts/stt-check.mjs
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const DIR = process.env.CLIPS_DIR || '/workspace/caregenics/stt-test';
const refs = fs.existsSync(path.join(DIR, 'ref.txt')) ? fs.readFileSync(path.join(DIR, 'ref.txt'), 'utf8').trim().split('\n') : [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('status', await (await fetch(`${BASE}/api/stt/status`)).json());
for (let i = 1; i <= refs.length; i++) {
  for (const [ext, type] of [['m4a', 'audio/mp4'], ['webm', 'audio/webm;codecs=opus']]) {
    const f = path.join(DIR, `c${i}.${ext}`);
    if (!fs.existsSync(f)) continue;
    const t = Date.now();
    const r = await fetch(`${BASE}/api/stt`, { method: 'POST', headers: { 'content-type': type }, body: fs.readFileSync(f) });
    const j = await r.json();
    console.log(`${ext.padEnd(4)} ${String(Date.now() - t).padStart(5)} ms  said: ${JSON.stringify(refs[i - 1])}  heard: ${JSON.stringify(j.text ?? j.error)}`);
    await sleep(3200); // stay under the per-IP rate limit
  }
}

for (const n of (process.env.FAKE || '1,3').split(',')) {
  const wav = path.join(DIR, `fake${n}.wav`);
  if (!fs.existsSync(wav)) continue;
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}%noloop`, '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, locale: 'fil-PH', timezoneId: 'Asia/Manila', permissions: ['microphone'] });
  await ctx.addInitScript(() => { delete window.webkitSpeechRecognition; delete window.SpeechRecognition; }); // like an iPhone Home Screen app
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(BASE, { waitUntil: 'networkidle' });
  const t = Date.now();
  await p.click('#orb');
  await p.waitForSelector('#orb.listening', { timeout: 3000 }).catch(() => {});
  const listening = await p.$eval('#orb', (o) => o.classList.contains('listening'));
  await p.waitForFunction(() => document.querySelectorAll('.bubble.me').length > 0, null, { timeout: 25000 }).catch(() => {});
  const ms = Date.now() - t;
  await sleep(2500);
  const out = await p.evaluate(() => ({ me: [...document.querySelectorAll('.bubble.me')].map((x) => x.textContent), bot: [...document.querySelectorAll('.bubble.bot')].slice(-1).map((x) => x.textContent), toast: document.querySelector('.toast')?.textContent ?? '' }));
  console.log(`orb tap (fake mic ${n}): listening=${listening}  tap->transcript ${ms} ms (includes ~1.5 s silence wait)`, JSON.stringify(out), errs.length ? errs : '');
  await b.close();
}
