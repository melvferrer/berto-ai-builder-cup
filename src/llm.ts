import { LLM } from './config';
import { doctorFallbackFor } from '../shared/safety.js';
import { getLang } from './i18n';

export interface LLMStatus { provider: 'local' | 'vertex' | 'off'; ready: boolean; model?: string }
export interface LLMResult { reply: string | null; route: string; emergency?: { level: 'low' | 'high' | 'symptom'; value?: number } }

let cached: LLMStatus | null = null;
/** Provider status from the server (cached for 60 s). */
export async function llmStatus(force = false): Promise<LLMStatus> {
  if (cached && !force) return cached;
  try {
    const r = await fetch(LLM.statusEndpoint, { cache: 'no-store' });
    cached = r.ok ? await r.json() : { provider: 'off', ready: false };
  } catch { cached = { provider: 'off', ready: false }; }
  setTimeout(() => { cached = null; }, 60_000);
  return cached!;
}
export const llmAvailable = async () => LLM.enabled && (await llmStatus()).ready;

/**
 * Ask MedGemma (via the server). Only the question text and the latest glucose number are sent.
 * Streams: onSentence fires for each safe sentence as soon as it is ready. Resolves with the final reply;
 * on timeout (30 s) or network error resolves with "Itanong natin ito sa doktor mo."
 */
export async function askLLM(text: string, glucose: { value: number; ageMin: number } | null,
  onSentence: (s: string) => void = () => {}): Promise<LLMResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LLM.timeoutMs + 3000);
  let got = 0;
  try {
    const res = await fetch(LLM.endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctrl.signal,
      body: JSON.stringify({ text, glucose, stream: true, lang: getLang() }),
    });
    if (!res.ok || !res.body) return { reply: doctorFallbackFor(getLang()), route: 'error' };
    if (!/event-stream/.test(res.headers.get('content-type') ?? '')) return (await res.json()) as LLMResult;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = block.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        const ev = JSON.parse(line.slice(5));
        if (ev.type === 'sentence') { got++; onSentence(ev.text); }
        else if (ev.type === 'final') return { reply: ev.reply, route: ev.route, emergency: ev.emergency };
      }
    }
    return { reply: doctorFallbackFor(getLang()), route: 'error' };
  } catch {
    return { reply: got ? null : doctorFallbackFor(getLang()), route: 'timeout' };
  } finally { clearTimeout(timer); }
}
