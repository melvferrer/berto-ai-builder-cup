import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';

/** VAPID keys: from env (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY) or generated once into data/vapid.json. */
export function loadVapid(dataDir) {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY)
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  const file = path.join(dataDir, 'vapid.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.mkdirSync(dataDir, { recursive: true });
  const keys = webpush.generateVAPIDKeys();
  fs.writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 });
  console.log('[berto] generated new VAPID keys in', file);
  return keys;
}
