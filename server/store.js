// Tiny JSON-file store for push subscriptions + medicine schedules (names + times only).
import fs from 'node:fs';
import path from 'node:path';

export function createStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'store.json');
  let data = { devices: {}, sent: {}, oneoff: [] };
  try { data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* first run */ }
  let timer = null;
  const persist = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);
    }, 50);
  };
  return { data, persist };
}
