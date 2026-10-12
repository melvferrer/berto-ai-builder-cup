/**
 * Rule-based Taglish intent parser (MVP). Pure function: text in, structured intent out.
 * Keep this deterministic; an LLM can be layered on top in brain.ts / llm.ts.
 */
import type { GlucoseCtx, Med } from './store';
import { pad } from './time';
import { looksLikeQuestion } from '../shared/safety.js';

export type Intent =
  | { kind: 'emergency' }
  | { kind: 'glucose'; value: number; context: GlucoseCtx; mmol?: number }
  | { kind: 'med_taken'; medIds: string[] }
  | { kind: 'med_missed'; medIds: string[] }
  | { kind: 'meds_today' }
  | { kind: 'med_add'; name: string; dose: string; times: string[] }
  | { kind: 'last_glucose' }
  | { kind: 'walk'; minutes?: number }
  | { kind: 'meal'; text: string }
  | { kind: 'symptom'; text: string }
  | { kind: 'diet' }
  | { kind: 'question' }
  | { kind: 'hello' } | { kind: 'howareyou' } | { kind: 'bye' } | { kind: 'whoami' } | { kind: 'help' } | { kind: 'thanks' }
  | { kind: 'yes' } | { kind: 'no' }
  | { kind: 'unknown' };

const SPANISH: Record<string, number> = {
  una: 1, dos: 2, tres: 3, kwatro: 4, kuwatro: 4, kuatro: 4, singko: 5, sinko: 5, sais: 6, siyete: 7, syete: 7,
  otso: 8, nuwebe: 9, nueve: 9, nwebe: 9, diyes: 10, dyes: 10, onse: 11, dose: 12,
};
const TL_NUM: Record<string, number> = {
  isa: 1, dalawa: 2, tatlo: 3, apat: 4, lima: 5, anim: 6, pito: 7, walo: 8, siyam: 9, sampu: 10,
};

export function norm(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[“”"!?¿¡]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Extract HH:MM times from Taglish/English phrases. Returns times + text with the time phrases removed. */
export function parseTimes(input: string): { times: string[]; rest: string } {
  let s = ` ${norm(input)} `;
  const times: string[] = [];
  const word = Object.keys(SPANISH).join('|');
  const re = new RegExp(
    String.raw`(?:\balas[\s-]*)?\b(\d{1,2}|${word})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|ng umaga|ng tanghali|ng hapon|ng gabi|ng madaling araw|umaga|tanghali|hapon|gabi)?\b`,
    'g',
  );
  s = s.replace(re, (m, hRaw: string, mRaw: string | undefined, ap: string | undefined) => {
    const hasAlas = /alas/.test(m);
    if (!hasAlas && !ap && !mRaw) return m; // a bare number is not a time (could be a dose or a reading)
    let h = SPANISH[hRaw] ?? Number(hRaw);
    const min = mRaw ? Number(mRaw) : 0;
    if (h > 23 || min > 59) return m;
    const a = (ap ?? '').replace(/^ng /, '');
    if (/^p|hapon|gabi/.test(a) && h < 12) h += 12;
    if (/^a|umaga|madaling/.test(a) && h === 12) h = 0;
    if (/tanghali/.test(a) && h < 6) h += 12;
    times.push(`${pad(h)}:${pad(min)}`);
    return ' ';
  });
  s = s.replace(/\btanghali\b/, () => { times.push('12:00'); return ' '; });
  return { times: [...new Set(times)].sort(), rest: s.replace(/\s+/g, ' ').trim() };
}

function findMeds(text: string, meds: Med[]): string[] {
  const n = norm(text);
  return meds.filter((m) => {
    const name = norm(m.name);
    const first = name.split(' ')[0];
    return n.includes(name) || (first.length >= 4 && n.includes(first)) || (first.length >= 5 && n.includes(first.slice(0, 5)));
  }).map((m) => m.id);
}

const has = (s: string, re: RegExp) => re.test(s);

export function parseIntent(raw: string, meds: Med[] = []): Intent {
  const s = norm(raw);
  if (!s) return { kind: 'unknown' };

  if (has(s, /nahimatay|hinimatay|walang malay|hindi (makahinga|magising)|hirap (na )?huminga|chest pain|sakit ng dibdib|sumasakit (ang )?dibdib|naninikip|nangingisay|seizure|stroke|emergency/))
    return { kind: 'emergency' };

  // Add a medicine: "idagdag ang metformin 500mg alas 8 ng umaga at alas 8 ng gabi"
  if (has(s, /\b(idagdag|dagdag|magdagdag|add|bagong gamot|ilagay)\b/)) {
    const { times, rest } = parseTimes(raw);
    const doseM = rest.match(/(\d+(?:\.\d+)?\s?(?:mg|mcg|g|ml|units?|iu|tableta|tablets?|tab|capsules?|kapsula))\b/);
    const dose = doseM ? doseM[1] : '';
    const name = rest
      .replace(doseM ? doseM[0] : '', ' ')
      .replace(/\b(idagdag|dagdag|magdagdag|add|bagong|ilagay|ang|gamot|ko|na|sa|tuwing|ng|at|and|every|araw-araw|araw|daily|po|naman|mo|yung|iyong|listahan|reminder|paalala|para|at|kada|oras)\b/g, ' ')
      .replace(/[^a-z0-9\- ]/g, ' ').replace(/\s+/g, ' ').trim();
    if (name) return { kind: 'med_add', name: name.replace(/\b\w/g, (c) => c.toUpperCase()), dose, times };
  }

  // Small talk first, so casual chat never hits the "hindi ko naintindihan" fallback.
  const st = s.replace(/[.,!?~]+/g, ' ').replace(/\s+/g, ' ').trim();
  const KUMUSTA = String.raw`(k[ou]m[ou]?sta|kam[ou]sta|musta|kmusta|kumsta|how are you|how r u|hru)`;
  if (new RegExp(String.raw`^((hi|hello|helo|hey|uy|oy|psst)\s+)?(berto\s+)?${KUMUSTA}(\s+(ka|po|ka na|na|ka po|na po|ka na po|ka berto|berto|ngayon|araw mo|buhay))*$`).test(st)) return { kind: 'howareyou' };
  if (/^((hi|hello|helo|hey|uy|oy|yo|psst)|(magandang|gandang) (umaga|tanghali|hapon|gabi)|good (morning|afternoon|evening|day)|morning)( po)?( berto)?( po)?$/.test(st) || st === 'berto') return { kind: 'hello' };
  if (/^(salamat|maraming salamat|thank you|thanks|thank u|ty|tnx|tenks)( po)?( berto)?( po)?$/.test(st)) return { kind: 'thanks' };
  if (/^(bye|paalam|ingat|sige na|good night|goodnight|gudnyt|tulog na ako|matutulog na ako|una na ako|mamaya ulit)( po)?( berto)?( po)?$/.test(st)) return { kind: 'bye' };
  if (/^(sino ka|ano ka|ano pangalan mo|anong pangalan mo|who are you)( po)?( berto)?$/.test(st)) return { kind: 'whoami' };
  // Free-form health question ("Ano ang dapat kong kainin kung 250 ang sugar ko?", "Pwede ba ang mangga?"):
  // answered by MedGemma behind the safety layer, never logged as a reading. Questions about Berto itself stay rules.
  if (looksLikeQuestion(raw) && !has(s, /(ano|anong|alin|ilan).*(gamot|iinumin|inumin|meds|medicine)|gamot ko (ngayon|today)|schedule.*gamot|my meds|(huling|last|latest|nakaraang).*(sugar|glucose|asukal|reading)/) && !has(s, /ano (ang )?kaya mo|paano (ka )?(gamitin|gumamit)|paano (mag-?log|magdagdag|mag-?add)|tulong|^help/))
    return { kind: 'question' };

  const negTaken = /(hindi|di) ko (pa )?(na )?(nainom|ininom)|hindi (pa )?(ako )?(nakainom|uminom)|nakalimutan|nalimutan|nakaligtaan|missed|skip/;
  if (has(s, negTaken) && (has(s, /gamot|inom|med/) || findMeds(s, meds).length))
    return { kind: 'med_missed', medIds: findMeds(s, meds) };
  if (has(s, /nainom|ininom|uminom|nakainom|taken|tapos na (ako )?(sa )?gamot|took/) && !has(s, /\b(ano|anong|kailan|ilan)\b/) && !has(s, /\b(tubig|juice|kape|gatas|softdrinks?|coke)\b/))
    return { kind: 'med_taken', medIds: findMeds(s, meds) };

  if (has(s, /(ano|anong|alin|ilan).*(gamot|iinumin|inumin|meds|medicine)|gamot ko (ngayon|today)|schedule.*gamot|my meds/))
    return { kind: 'meds_today' };

  if (has(s, /(huling|last|latest|nakaraang).*(sugar|glucose|asukal|reading)/)) return { kind: 'last_glucose' };


  // Blood glucose reading
  const glucoseWords = /sugar|asukal|glucose|glu|cbg|fbs|rbs|reading|mg\/?dl|mmol|fasting|asukal/;
  const numM = s.match(/(\d{1,3}(?:[.,]\d)?)/);
  const onlyNumber = /^(\d{1,3}(?:[.,]\d)?)\s*(mg\/?dl|mmol\/?l?)?$/.test(s);
  if (numM && (has(s, glucoseWords) || onlyNumber)) {
    let v = Number(numM[1].replace(',', '.'));
    let mmol: number | undefined;
    if (has(s, /mmol/) || (/[.,]/.test(numM[1]) && v < 35)) { mmol = v; v = Math.round(v * 18); }
    if (v >= 20 && v <= 600) {
      let context: GlucoseCtx = 'random';
      if (has(s, /fasting|fbs|bago (ako )?kumain|wala pang kain|hindi pa kumakain|pag ?gising|paggising/)) context = 'fasting';
      else if (has(s, /after|pagkatapos|pagkakain|matapos kumain|busog|2 ?(hours|oras)|post/)) context = 'after_meal';
      return { kind: 'glucose', value: v, context, mmol };
    }
  }

  if (has(s, /naglakad|nag-?lakad|lumakad|nag-?walk|walk|nag-?exercise|nag-?ehersisyo|nag-?jogging/)) {
    const m = s.match(/(\d{1,3})\s*(min|minuto|minutes)/) ?? s.match(/(isang|kalahating) oras/);
    const minutes = m ? (m[1] === 'isang' ? 60 : m[1] === 'kalahating' ? 30 : Number(m[1])) : undefined;
    return { kind: 'walk', minutes };
  }

  if (has(s, /kumain ako|kinain ko|nag-?almusal|nag-?tanghalian|nag-?hapunan|nag-?meryenda|nag-?merienda|ulam ko|nakakain|breakfast|lunch|dinner/)) {
    const text = s.replace(/.*?(kumain ako( ng)?|kinain ko( ay| ang)?|nag-?almusal( ako)?( ng)?|nag-?tanghalian( ako)?( ng)?|nag-?hapunan( ako)?( ng)?|nag-?meryenda( ako)?( ng)?|nag-?merienda( ako)?( ng)?|ulam ko( ay)?|nakakain( na)?( ako)?( ng)?|breakfast|lunch|dinner)/, '').trim();
    return { kind: 'meal', text: text || raw.trim() };
  }

  if (has(s, /hilo|nahihilo|pagod|nanghihina|mahina|uhaw|nauuhaw|ihi|umiihi|malabo|paningin|manhid|namamanhid|tusok|sugat|pawis|pinagpapawisan|nanginginig|sakit ng ulo|masakit|lagnat|nagsusuka|suka|sintomas|symptoms?|nararamdaman|gutom palagi|kinakabahan/))
    return { kind: 'symptom', text: raw.trim() };

  if (has(s, /pagkain|kakainin|diet|pwede.*kain|puwede.*kain|ano.*kain|\bkanin\b|matamis|prutas|softdrinks/)) return { kind: 'diet' };
  if (has(s, /^(oo|opo|yes|oho|sige|tama|meron)\b/)) return { kind: 'yes' };
  if (has(s, /^(hindi|wala|no|hindi pa|di pa|wala pa)\b/)) return { kind: 'no' };
  if (has(s, /salamat|thank/)) return { kind: 'thanks' };
  if (has(s, /^(hi|hello|helo|kumusta|kamusta|magandang|good (morning|afternoon|evening)|uy|berto)\b/)) return { kind: 'hello' };
  if (has(s, /tulong|help|paano|ano ang kaya mo|ano kaya mo/)) return { kind: 'help' };
  // Tagalog number words alone, e.g. "isang daan at apatnapu" is out of scope for MVP.
  void TL_NUM;
  return { kind: 'unknown' };
}

export type GlucoseLevel = 'low' | 'normal' | 'elevated' | 'high' | 'very_high';
export function classifyGlucose(v: number, ctx: GlucoseCtx): GlucoseLevel {
  if (v < 70) return 'low';
  if (v > 300) return 'very_high';
  if (ctx === 'fasting') return v <= 130 ? 'normal' : v <= 180 ? 'elevated' : 'high';
  return v <= 180 ? 'normal' : v <= 250 ? 'elevated' : 'high';
}
