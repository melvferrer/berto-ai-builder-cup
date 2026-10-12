// One-off machine translation of src/locales/fil.json into the JAPAC locales (+en).
// ALL OUTPUT IS MACHINE-TRANSLATED and listed in REVIEW-translations.md for native-speaker + medical review.
import fs from 'node:fs';
const SRC = JSON.parse(fs.readFileSync('src/locales/fil.json', 'utf8'));
const TARGETS = { en: ['en', 'en-PH'], ja: ['ja', 'ja-JP'], ko: ['ko', 'ko-KR'], zh: ['zh-CN', 'zh-CN'], hi: ['hi', 'hi-IN'], id: ['id', 'id-ID'], ms: ['ms', 'ms-MY'], th: ['th', 'th-TH'], vi: ['vi', 'vi-VN'], bn: ['bn', 'bn-IN'], ta: ['ta', 'ta-IN'] };
const only = process.argv.slice(2);
const KEEP = new Set(['locale', 'about.mission', 'about.version', 'about.aiTitle', 'about.aiTerms', 'log.unit', 'app.name', 'log.exportCsv', 'log.exportJson']);
const flat = []; (function f(o, p) { for (const [k, v] of Object.entries(o)) { const q = p ? `${p}.${k}` : k; typeof v === 'object' ? f(v, q) : flat.push([q, v]); } })(SRC, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function tr(texts, tl) {
  const qs = texts.map((t) => `q=${encodeURIComponent(t)}`).join('&');
  for (let a = 0; a < 5; a++) {
    const r = await fetch(`https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=tl&tl=${tl}&${qs}`);
    if (r.ok) { const j = await r.json(); return j.map((x) => (Array.isArray(x) ? x[0] : x)); }
    await sleep(2000 * (a + 1));
  }
  throw new Error('translate failed');
}
// protect placeholders and brand terms
const prot = (s) => { const m = []; const t = s.replace(/\{\w+\}|Berto|CareGenicsAI|MedGemma[\w .]*?(?=[ ,)]|$)|mg\/dL|911/g, (x) => { m.push(x); return `[${m.length - 1}]`; }); return [t, m]; };
const unprot = (s, m) => s.replace(/\[\s*(\d+)\s*\]/g, (_, i) => m[+i] ?? '');
for (const [code, [tl, locale]] of Object.entries(TARGETS)) {
  if (only.length && !only.includes(code)) continue;
  const out = structuredClone(SRC); out.locale = locale;
  const items = []; // [key, partIndex, text]
  for (const [k, v] of flat) { if (KEEP.has(k)) continue; v.split(' || ').forEach((p, i) => items.push([k, i, p])); }
  const res = new Map();
  for (let i = 0; i < items.length; i += 12) {
    const chunk = items.slice(i, i + 12); const pr = chunk.map((c) => prot(c[2]));
    const t = await tr(pr.map((p) => p[0]), tl);
    chunk.forEach((c, j) => { const v = unprot(t[j], pr[j][1]); const miss = pr[j][1].filter((x) => !v.includes(x)); const key = c[0]; if (!res.has(key)) res.set(key, []); res.get(key)[c[1]] = miss.length ? `${v} ${miss.filter((x) => x.startsWith('{')).join(' ')}`.trim() : v; });
    await sleep(300);
  }
  for (const [k, parts] of res) { const path = k.split('.'); let o = out; for (const p of path.slice(0, -1)) o = o[p]; o[path.at(-1)] = parts.join(' || '); }
  fs.writeFileSync(`src/locales/${code}.json`, JSON.stringify(out, null, 2) + '\n');
  console.log(code, res.size, 'keys');
}
