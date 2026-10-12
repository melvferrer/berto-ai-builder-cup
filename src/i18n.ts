import fil from './locales/fil.json';
import { LANGS, normLang, detectLang } from '../shared/lang.js';

type Dict = { [k: string]: string | Dict };
// All locale files (src/locales/<code>.json), bundled. fil.json is the source of truth for keys.
const files = import.meta.glob('./locales/*.json', { eager: true, import: 'default' }) as Record<string, Dict>;
const DICTS: Record<string, Dict> = {};
for (const [p, d] of Object.entries(files)) DICTS[p.replace(/^.*\/(\w+)\.json$/, '$1')] = d;

const KEY = 'berto.lang';
let lang: string = (() => { try { return normLang(localStorage.getItem(KEY)); } catch { return 'fil'; } })();
const listeners: ((l: string) => void)[] = [];

export const getLang = () => lang;
export const getLocale = () => LANGS[lang]?.bcp47 ?? 'fil-PH';
export const languages = () => Object.entries(LANGS).filter(([k]) => DICTS[k]).map(([code, v]) => ({ code, native: v.native, name: v.name }));
export function onLangChange(fn: (l: string) => void) { listeners.push(fn); }
/** Set + persist the language (settings picker or auto-follow). */
export function setLang(l: string) {
  const next = normLang(l);
  if (next === lang) return false;
  lang = next;
  try { localStorage.setItem(KEY, lang); } catch { /* ignore */ }
  document.documentElement.lang = getLocale();
  listeners.forEach((f) => f(lang));
  return true;
}
/** Auto-follow: switch when the user clearly typed/spoke another language. Returns the new code or null. */
export function followLanguageOf(text: string): string | null {
  const d = detectLang(text);
  return d && DICTS[d] && setLang(d) ? d : null;
}
if (typeof document !== 'undefined') document.documentElement.lang = getLocale();

function lookup(d: Dict, key: string): string | undefined {
  let node: string | Dict | undefined = d;
  for (const part of key.split('.')) node = typeof node === 'object' ? node[part] : undefined;
  return typeof node === 'string' ? node : undefined;
}
/** Look up a UI string by dotted key in the current locale (falls back to fil.json), filling {placeholders}. */
export function t(key: string, vars: Record<string, string | number> = {}): string {
  const s = lookup(DICTS[lang] ?? (fil as unknown as Dict), key) ?? lookup(fil as unknown as Dict, key);
  if (s === undefined) return key;
  return s.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}

/** @deprecated use getLocale(); kept for old imports (value at load time). */
export const LOCALE = getLocale();
