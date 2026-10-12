/**
 * On-device storage. One record per device (localStorage). Nothing here leaves the phone,
 * except medicine names + times that are synced to the push server for reminders.
 */
import { manilaNow } from './time';

export type GlucoseCtx = 'fasting' | 'after_meal' | 'random';
export interface Med { id: string; name: string; dose: string; times: string[] }
export type LogType = 'glucose' | 'symptom' | 'meal' | 'walk' | 'dose' | 'nudge';
export interface LogEntry {
  id: string; ts: number; type: LogType;
  value?: number; unit?: string; context?: GlucoseCtx | string;
  text?: string; medId?: string; status?: 'taken' | 'missed';
}
export interface NudgeState { idx: number; nextAt: number; snoozeLevel: number }
export interface RecordV1 {
  version: 1;
  deviceId: string;
  createdAt: number;
  meds: Med[];
  doses: Record<string, 'taken' | 'missed'>; // key: date|medId|HH:MM
  logs: LogEntry[];
  nudge: NudgeState;
  pushEnabled: boolean;
  firedLocal: Record<string, number>; // local reminder dedupe
  hints: Record<string, boolean>;
}

const KEY = 'berto.record.v1';
export const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));

function fresh(): RecordV1 {
  return {
    version: 1, deviceId: uid(), createdAt: Date.now(), meds: [], doses: {}, logs: [],
    nudge: { idx: 0, nextAt: 0, snoozeLevel: 0 }, pushEnabled: false, firedLocal: {}, hints: {},
  };
}

let rec: RecordV1 = load();
const listeners = new Set<() => void>();

function load(): RecordV1 {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...fresh(), ...JSON.parse(raw) };
  } catch { /* corrupted -> start fresh */ }
  const r = fresh();
  localStorage.setItem(KEY, JSON.stringify(r));
  return r;
}

export const db = {
  get: () => rec,
  save(mut?: (r: RecordV1) => void) {
    if (mut) mut(rec);
    // prune local dedupe keys older than 3 days
    const cutoff = Date.now() - 3 * 86400000;
    for (const [k, v] of Object.entries(rec.firedLocal)) if (v < cutoff) delete rec.firedLocal[k];
    localStorage.setItem(KEY, JSON.stringify(rec));
    listeners.forEach((f) => f());
  },
  onChange(f: () => void) { listeners.add(f); return () => listeners.delete(f); },
  wipe() { localStorage.removeItem(KEY); rec = load(); listeners.forEach((f) => f()); },

  addLog(e: Omit<LogEntry, 'id' | 'ts'> & { ts?: number }): LogEntry {
    const entry: LogEntry = { id: uid(), ts: Date.now(), ...e };
    db.save((r) => { r.logs.push(entry); });
    return entry;
  },

  setDose(medId: string, time: string, status: 'taken' | 'missed' | null, date = manilaNow().date) {
    const key = `${date}|${medId}|${time}`;
    db.save((r) => {
      if (status) r.doses[key] = status; else delete r.doses[key];
      r.logs = r.logs.filter((l) => !(l.type === 'dose' && l.text === key));
      if (status) r.logs.push({ id: uid(), ts: Date.now(), type: 'dose', medId, status, text: key });
    });
  },
  doseStatus(medId: string, time: string, date = manilaNow().date) {
    return rec.doses[`${date}|${medId}|${time}`];
  },
};

/** Doses for today, sorted by time, with status. */
export function todaysDoses() {
  const out: { med: Med; time: string; status?: 'taken' | 'missed' }[] = [];
  for (const med of rec.meds) for (const time of med.times) out.push({ med, time, status: db.doseStatus(med.id, time) });
  return out.sort((a, b) => a.time.localeCompare(b.time));
}

export function lastGlucose(): LogEntry | undefined {
  return [...rec.logs].reverse().find((l) => l.type === 'glucose');
}

// ---------- Export for the doctor ----------
function medName(id?: string) { return rec.meds.find((m) => m.id === id)?.name ?? ''; }

export function exportJSON(): string {
  const { deviceId, firedLocal, hints, ...rest } = rec;
  void deviceId; void firedLocal; void hints;
  return JSON.stringify({ exportedAt: new Date().toISOString(), app: 'Berto by CareGenicsAI', ...rest }, null, 2);
}

export function exportCSV(): string {
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [['timestamp_manila', 'type', 'value', 'unit', 'context', 'medicine', 'status', 'note']];
  for (const l of [...rec.logs].sort((a, b) => a.ts - b.ts)) {
    const ts = new Date(l.ts).toLocaleString('sv-SE', { timeZone: 'Asia/Manila' });
    rows.push([ts, l.type, l.value ?? '', l.unit ?? '', l.context ?? '', l.type === 'dose' ? medName(l.medId) : '',
      l.status ?? '', l.type === 'dose' ? (l.text ?? '').split('|')[2] ?? '' : l.text ?? ''].map(String));
  }
  return rows.map((r) => r.map(esc).join(',')).join('\n');
}
