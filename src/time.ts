/** All schedule logic runs in Asia/Manila regardless of the phone's timezone setting. */
export const TZ = 'Asia/Manila';

function parts(d: Date) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, hh: Number(g('hour')), mm: Number(g('minute')) };
}

export function manilaNow(d = new Date()) {
  const { date, hh, mm } = parts(d);
  return { date, hh, mm, hhmm: `${pad(hh)}:${pad(mm)}`, minutes: hh * 60 + mm };
}

export const pad = (n: number) => String(n).padStart(2, '0');

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** "08:00" -> "8:00 AM" */
export function fmt12(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const ap = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(m)} ${ap}`;
}

/** Quiet hours for nudges: 9pm–7am Manila. */
export function isQuietHours(d = new Date()): boolean {
  const { hh } = manilaNow(d);
  return hh >= 21 || hh < 7;
}

/** Next 7:00 AM Manila after d (as epoch ms). */
export function nextMorning(d = new Date()): number {
  const { hh, minutes } = manilaNow(d);
  const minsUntil = hh >= 21 ? 24 * 60 - minutes + 7 * 60 : 7 * 60 - minutes;
  return d.getTime() + Math.max(1, minsUntil) * 60_000;
}

export function fmtDateTime(ts: number): string {
  return new Intl.DateTimeFormat('fil-PH', {
    timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(ts));
}

export function relDay(ts: number): string {
  const today = manilaNow().date;
  const that = manilaNow(new Date(ts)).date;
  const y = manilaNow(new Date(Date.now() - 86400000)).date;
  const time = new Intl.DateTimeFormat('fil-PH', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(new Date(ts));
  if (that === today) return `ngayong araw, ${time}`;
  if (that === y) return `kahapon, ${time}`;
  return fmtDateTime(ts);
}
