export type TaglishRun = { lang: 'en' | 'fil'; text: string };
export function splitTaglish(text: string, extraTerms?: string[]): TaglishRun[];
export function expandEnglish(text: string): string;
