// Loads the app, checks console errors, the voice hint, and that a tap triggers server TTS playback.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const BASE = process.env.BASE_URL || 'http://localhost:8787';
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync('/tmp/berto-voice-'), {
  executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true,
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'fil-PH', timezoneId: 'Asia/Manila',
});
const page = ctx.pages()[0] ?? await ctx.newPage();
const errors = [], tts = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(e.message));
page.on('response', (r) => { if (r.url().includes('/api/tts')) tts.push(`${r.status()} ${r.headers()['content-type']} ${decodeURIComponent(r.url().split('text=')[1] ?? '').slice(0, 60)}`); });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(3500);
const hintAfterLoad = await page.locator('#hint-voice').count();
// hook the audio element's events by observing the orb state
await page.waitForSelector('#nudge .nudge', { timeout: 10000 });
await page.click('#nudge [data-a=no]'); // user tap -> unlock + Berto replies aloud
const spoke = await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('Nagsasalita'), null, { timeout: 15000 }).then(() => true).catch(() => false);
const pulsing = await page.evaluate(() => document.querySelector('#orb').classList.contains('busy'));
const backToIdle = await page.waitForFunction(() => !document.querySelector('#orb').classList.contains('busy'), null, { timeout: 30000 }).then(() => true).catch(() => false);
await page.fill('#text', '140 ang sugar ko'); await page.press('#text', 'Enter');
await page.waitForTimeout(4000);
console.log(JSON.stringify({ hintAfterLoad, spoke, pulsingWhileSpeaking: pulsing, backToIdle, tts, errors }, null, 2));
await ctx.close();
