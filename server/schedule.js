// Pure scheduling logic (Asia/Manila), unit-testable without a network.
export const TZ = 'Asia/Manila';

export function manila(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const g = (t) => p.find((x) => x.type === t).value;
  const hh = Number(g('hour')), mm = Number(g('minute'));
  return { date: `${g('year')}-${g('month')}-${g('day')}`, minutes: hh * 60 + mm };
}

const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
export const fmt12 = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };

/**
 * Which reminders are due now? A reminder fires once per day at its time; if the server was briefly
 * down it still fires within a CATCHUP-minute grace window.
 */
export function dueReminders(devices, sent, now = new Date(), CATCHUP = 5) {
  const { date, minutes } = manila(now);
  const out = [];
  for (const [deviceId, dev] of Object.entries(devices)) {
    if (!dev.subscription) continue;
    for (const r of dev.reminders || []) {
      const diff = minutes - toMin(r.time);
      if (diff < 0 || diff > CATCHUP) continue;
      const key = `${deviceId}|${date}|${r.medId}|${r.time}`;
      if (sent[key]) continue;
      out.push({ deviceId, key, date, reminder: r });
    }
  }
  return out;
}

export function reminderPayload(deviceId, date, r, snoozed = false) {
  return {
    kind: 'reminder', deviceId, date, medId: r.medId, name: r.name, time: r.time,
    title: snoozed ? 'Paalala ulit: oras na ng gamot' : 'Oras na ng gamot',
    body: `${r.name}${r.dose ? ' ' + r.dose : ''} — ${fmt12(r.time)}. Huwag kalimutan!`,
    tag: `med-${r.medId}-${r.time}`,
  };
}
