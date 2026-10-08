// Offline attendance: every change is saved on the device first (with its own unique ID),
// then sent to the server automatically when there is a connection. Failed sends are retried
// with increasing waits. The server ignores operations it has already received.
import { idb, cache } from './idb';
import { api } from './api';

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const DEVICE_ID = (() => {
  try {
    let id = localStorage.getItem('deviceId');
    if (!id) { id = uuid(); localStorage.setItem('deviceId', id); }
    return id;
  } catch { return 'unknown'; }
})();

let state = { pending: 0, failed: 0, syncing: false, lastSync: null, lastError: null, online: navigator.onLine, notices: [] };
const listeners = new Set();
const set = (patch) => { state = { ...state, ...patch }; listeners.forEach((l) => l(state)); };
export const subscribe = (fn) => { listeners.add(fn); fn(state); return () => listeners.delete(fn); };
export const getState = () => state;

const backoff = (attempts) => Math.min(5 * 60 * 1000, 5000 * 2 ** attempts); // 5s, 10s, 20s ... up to 5 min

export async function outbox() {
  return (await idb.all('outbox')).sort((a, b) => a.created_at.localeCompare(b.created_at));
}

async function refreshCounts() {
  const ops = await outbox();
  set({ pending: ops.filter((o) => o.state !== 'failed').length, failed: ops.filter((o) => o.state === 'failed').length });
}

// Save one attendance change on the device and try to send it.
export async function queueAttendance(entry) {
  const ops = await outbox();
  // An unsent change for the same worker and day is replaced (only the latest matters),
  // keeping the version it was based on so conflict detection still works.
  const older = ops.find((o) => o.state !== 'sending' && o.assignment_id === entry.assignment_id && o.work_date === entry.work_date);
  if (older) await idb.del('outbox', older.op_id);
  const op = {
    ...entry,
    base_version: older ? older.base_version : entry.base_version,
    op_id: uuid(),
    created_at: new Date().toISOString(),
    source: navigator.onLine ? 'online' : 'offline',
    attempts: 0,
    next_try: 0,
    state: 'pending',
  };
  await idb.put('outbox', op);
  await refreshCounts();
  flush();
  return op;
}

export async function discard(opId) {
  await idb.del('outbox', opId);
  await refreshCounts();
}

export async function retryFailed() {
  for (const o of await outbox()) if (o.state === 'failed' || o.state === 'pending') await idb.put('outbox', { ...o, state: 'pending', next_try: 0 });
  await refreshCounts();
  flush();
}

// Keep the device's copy of the roster up to date after the server answers
async function updateCachedRoster(op, record) {
  const key = `roster:${op.site_id}:${op.work_date}`;
  const rows = await cache.get(key);
  if (!rows || !record) return;
  await cache.set(key, rows.map((r) => (r.assignment_id === op.assignment_id ? { ...r, ...record, assignment_id: r.assignment_id } : r)));
}

const resultListeners = new Set();
export const onResults = (fn) => { resultListeners.add(fn); return () => resultListeners.delete(fn); };

let running = false;
export async function flush() {
  if (running) return;
  if (!navigator.onLine) { set({ online: false }); return; }
  running = true;
  set({ syncing: true, online: true });
  const notices = [];
  try {
    for (const o of await outbox()) if (o.state === 'sending') await idb.put('outbox', { ...o, state: 'pending' }); // left over from a closed tab
    const due = (await outbox()).filter((o) => o.state === 'pending' && o.next_try <= Date.now());
    for (let i = 0; i < due.length; i += 100) {
      const batch = due.slice(i, i + 100);
      for (const o of batch) await idb.put('outbox', { ...o, state: 'sending' });
      let res;
      try {
        res = await api.post('/sync/attendance', {
          device_id: DEVICE_ID,
          operations: batch.map(({ op_id, assignment_id, work_date, status, late_arrival, early_departure, normal_hours, overtime_hours, comments, base_version, created_at, source }) => ({
            op_id, assignment_id, work_date, status, late_arrival, early_departure, normal_hours, overtime_hours, comments, base_version, created_at, source,
          })),
        });
      } catch (e) {
        // Connection dropped or server unavailable: keep everything and retry later
        for (const o of batch) await idb.put('outbox', { ...o, attempts: o.attempts + 1, next_try: Date.now() + backoff(o.attempts) });
        set({ lastError: e.status === 401 ? 'Please sign in again to send saved attendance.' : e.message });
        return;
      }
      for (const r of res.results) {
        const op = batch.find((o) => o.op_id === r.op_id);
        if (!op) continue;
        if (r.result === 'applied' || r.result === 'conflict') {
          await idb.del('outbox', op.op_id);
          await updateCachedRoster(op, r.record);
          // A newer change to the same row made while this one was being sent builds on our own update
          if (r.result === 'applied' && r.record) {
            for (const later of await outbox()) {
              if (later.assignment_id === op.assignment_id && later.work_date === op.work_date && later.base_version === op.base_version) {
                await idb.put('outbox', { ...later, base_version: r.record.version });
              }
            }
          }
          if (r.result === 'conflict') notices.push({ type: 'conflict', worker: op.worker_name, date: op.work_date, message: r.message });
        } else if (r.result === 'rejected') {
          await idb.put('outbox', { ...op, state: 'failed', error: r.message });
          notices.push({ type: 'rejected', worker: op.worker_name, date: op.work_date, message: r.message });
        } else {
          await idb.put('outbox', { ...op, attempts: op.attempts + 1, next_try: Date.now() + backoff(op.attempts), error: r.message });
        }
      }
      resultListeners.forEach((l) => l(res.results));
    }
    set({ lastSync: new Date().toISOString(), lastError: null });
  } finally {
    running = false;
    await refreshCounts();
    set({ syncing: false, notices: notices.length ? notices : state.notices });
  }
}

export const clearNotices = () => set({ notices: [] });

window.addEventListener('online', () => { set({ online: true }); flush(); });
window.addEventListener('offline', () => set({ online: false }));
setInterval(flush, 30000);
refreshCounts().then(flush).catch(() => {});
