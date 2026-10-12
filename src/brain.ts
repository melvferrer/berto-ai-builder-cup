/**
 * Berto's "brain": turns user text into an action + Taglish reply.
 * Rule-based for the MVP; LLM (askLLM) is consulted only for things the rules don't understand.
 */
import { t } from './i18n';
import { parseIntent, classifyGlucose, parseTimes } from './intents';
import { db, todaysDoses, lastGlucose, uid, type GlucoseCtx } from './store';
import { manilaNow, toMinutes, fmt12, relDay } from './time';
import { llmAvailable } from './llm';

export interface Reply {
  text: string; alert?: { level: 'low' | 'high'; value: number }; refresh?: boolean;
  /** Free-form health question for MedGemma: main.ts streams the answer (with filler + orb "working" state). */
  ask?: { question: string };
}

export function listJoin(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${t('bot.and')} ${items[items.length - 1]}`;
}

export function logGlucose(value: number, context: GlucoseCtx): Reply {
  db.addLog({ type: 'glucose', value, unit: 'mg/dL', context });
  const level = classifyGlucose(value, context);
  const base = t('bot.glucoseSaved', { value, context: t(`bot.ctx.${context}`) });
  const extra = {
    low: t('bot.glucoseLow'), normal: t('bot.glucoseNormal'), elevated: t('bot.glucoseElevated'),
    high: t('bot.glucoseHigh'), very_high: t('bot.glucoseVeryHigh'),
  }[level];
  const alert = value < 70 ? { level: 'low' as const, value } : value > 300 ? { level: 'high' as const, value } : undefined;
  return { text: `${base} ${extra}`, alert, refresh: true };
}

/** Pick which scheduled dose of a medicine the user most likely means: the pending one closest to now. */
function closestPending(medId: string): string | undefined {
  const now = manilaNow().minutes;
  const cands = todaysDoses().filter((d) => d.med.id === medId && !d.status);
  cands.sort((a, b) => Math.abs(toMinutes(a.time) - now) - Math.abs(toMinutes(b.time) - now));
  return cands[0]?.time ?? db.get().meds.find((m) => m.id === medId)?.times[0];
}

export async function respond(input: string): Promise<Reply> {
  const r = db.get();
  const intent = parseIntent(input, r.meds);

  switch (intent.kind) {
    case 'emergency':
      return { text: t('bot.emergency') };

    case 'glucose':
      return logGlucose(intent.value, intent.context);

    case 'med_add': {
      if (!intent.times.length) return { text: t('bot.medAddNeedTime', { name: intent.name }) };
      db.save((rec) => { rec.meds.push({ id: uid(), name: intent.name, dose: intent.dose, times: intent.times }); });
      return { text: t('bot.medAdded', { name: intent.name, times: listJoin(intent.times.map(fmt12)) }), refresh: true };
    }

    case 'med_taken':
    case 'med_missed': {
      if (!r.meds.length) return { text: t('bot.noMeds') };
      let ids = intent.medIds;
      if (!ids.length) {
        if (r.meds.length === 1) ids = [r.meds[0].id];
        else {
          // the single pending dose within ±3h of now
          const now = manilaNow().minutes;
          const near = todaysDoses().filter((d) => !d.status && Math.abs(toMinutes(d.time) - now) <= 180);
          const uniq = [...new Set(near.map((d) => d.med.id))];
          if (uniq.length === 1) ids = uniq;
        }
      }
      if (!ids.length) return { text: t('bot.medTakenUnknown', { list: listJoin(r.meds.map((m) => m.name)) }) };
      const names: string[] = [];
      for (const id of ids) {
        const time = closestPending(id);
        if (time) db.setDose(id, time, intent.kind === 'med_taken' ? 'taken' : 'missed');
        names.push(r.meds.find((m) => m.id === id)!.name);
      }
      return { text: t(intent.kind === 'med_taken' ? 'bot.medTaken' : 'bot.medMissed', { name: listJoin(names) }), refresh: true };
    }

    case 'meds_today': {
      if (!r.meds.length) return { text: t('bot.noMeds') };
      const pending = todaysDoses().filter((d) => !d.status);
      if (!pending.length) return { text: t('bot.medsAllDone') };
      const list = pending.map((d) => `${d.med.name}${d.med.dose ? ' ' + d.med.dose : ''} ng ${fmt12(d.time)}`);
      return { text: t('bot.medsToday', { list: listJoin(list) }) };
    }

    case 'last_glucose': {
      const g = lastGlucose();
      if (!g) return { text: t('bot.noGlucose') };
      return { text: t('bot.lastGlucose', { value: g.value!, context: t(`bot.ctx.${g.context ?? 'random'}`), when: relDay(g.ts) }) };
    }

    case 'walk':
      db.addLog({ type: 'walk', value: intent.minutes, unit: intent.minutes ? 'min' : undefined, text: input });
      return { text: t('bot.walkSaved', { minutes: intent.minutes ? ` (${intent.minutes} minuto)` : '' }), refresh: true };

    case 'meal':
      db.addLog({ type: 'meal', text: intent.text });
      return { text: t('bot.mealSaved', { text: intent.text }), refresh: true };

    case 'symptom':
      db.addLog({ type: 'symptom', text: intent.text });
      return { text: t('bot.symptomSaved', { text: intent.text }), refresh: true };

    case 'diet': return { text: t('bot.dietTip') };
    case 'question':
      // Rice and food questions get the vetted healthy-plate tip, not a model guess.
      if (/\bkanin\b|\brice\b|pagkain|kakainin|matamis|prutas|softdrinks/i.test(input)) return { text: t('bot.dietTip') };
      if (await llmAvailable()) return { text: '', ask: { question: input } };
      return { text: /kain|pagkain|diet|kanin|prutas|matamis|mangga|saging/i.test(input) ? t('bot.dietTip') : t('bot.fallback') };
    case 'hello': return { text: pick(t('bot.hello')) };
    case 'howareyou': return { text: pick(t('bot.howAreYou')) };
    case 'bye': return { text: pick(t('bot.bye')) };
    case 'whoami': return { text: t('bot.whoami') };
    case 'help': return { text: t('bot.help') };
    case 'thanks': return { text: pick(t('bot.thanks')) };
    default: {
      // Anything else (health question or casual chat) goes to the conversational model; safety rules still apply.
      if (await llmAvailable()) return { text: '', ask: { question: input } };
      return { text: t('bot.fallback') };
    }
  }
}

/** Several reply variants live in one string separated by " || "; pick one so Berto doesn't sound robotic. */
function pick(s: string): string {
  const opts = s.split(' || ');
  return opts[Math.floor(Math.random() * opts.length)];
}

export { parseTimes };
