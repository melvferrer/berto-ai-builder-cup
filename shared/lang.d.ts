export type LangInfo = { name: string; native: string; bcp47: string; whisper: string; voice: string; english: string };
export const LANGS: Record<string, LangInfo>;
export const LANG_CODES: string[];
export function normLang(l: string | null | undefined): string;
export function detectLang(text: string): string | null;
