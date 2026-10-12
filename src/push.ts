/**
 * Web Push: subscribe this device and sync its medicine schedule (names + times only) to the server,
 * which sends reminders at the right Asia/Manila time even when the app is closed or the phone is locked.
 */
import { db } from './store';

export const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function permission(): NotificationPermission | 'unsupported' {
  return 'Notification' in window ? Notification.permission : 'unsupported';
}

function b64ToUint8(b64: string): Uint8Array {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function api(path: string, body: unknown) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json();
}

/** Must be called from a user gesture (button tap). */
export async function enablePush(): Promise<'enabled' | 'denied' | 'unsupported' | 'failed'> {
  if (!pushSupported()) return 'unsupported';
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return 'denied';
    const reg = await navigator.serviceWorker.ready;
    const { key } = await (await fetch('/api/vapid-public-key')).json();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(key) as BufferSource });
    await api('/api/subscribe', { deviceId: db.get().deviceId, subscription: sub.toJSON() });
    db.save((r) => { r.pushEnabled = true; });
    await syncSchedule();
    return 'enabled';
  } catch (e) {
    console.warn('enablePush failed', e);
    return 'failed';
  }
}

/** Send only medicine names and times to the server. Called whenever the medicine list changes. */
export async function syncSchedule(): Promise<void> {
  const r = db.get();
  if (!r.pushEnabled) return;
  const reminders = r.meds.flatMap((m) => m.times.map((time) => ({ medId: m.id, name: m.name, dose: m.dose, time })));
  try { await api('/api/schedule', { deviceId: r.deviceId, reminders }); } catch (e) { console.warn('sync failed', e); }
}

/** Re-attach subscription on app start (subscriptions can rotate). */
export async function refreshSubscription(): Promise<void> {
  if (!pushSupported() || Notification.permission !== 'granted' || !db.get().pushEnabled) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) { db.save((r) => { r.pushEnabled = false; }); return; }
    await api('/api/subscribe', { deviceId: db.get().deviceId, subscription: sub.toJSON() });
    await syncSchedule();
  } catch (e) { console.warn('refresh failed', e); }
}

export async function sendTestPush(): Promise<boolean> {
  try { const r = await api('/api/test-push', { deviceId: db.get().deviceId }); return !!r.ok; } catch { return false; }
}
