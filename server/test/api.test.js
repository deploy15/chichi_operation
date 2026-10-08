// End-to-end checks of the main business rules against a real MySQL database with demo data.
// Run: npm run seed:demo  (once, on an empty database), then  npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const app = require('../index');
const db = require('../lib/db');

let server; let base;
const today = new Date().toISOString().slice(0, 10);
const tokens = {};

async function call(who, method, path, body) {
  const res = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json', ...(tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
async function login(who, email, password = 'Demo1234!') {
  const r = await call(null, 'POST', '/api/auth/login', { email, password });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  tokens[who] = r.body.token;
  return r.body.user;
}

before(async () => {
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  await login('admin', process.env.ADMIN_EMAIL || 'admin@example.com', process.env.ADMIN_PASSWORD || 'ChangeMe123!');
  for (const w of ['site1', 'catering', 'kitchen', 'medical', 'finance', 'hse', 'hr', 'housing']) await login(w, `${w}@demo.local`);
});
after(async () => { server.close(); await db.pool.end(); });

test('wrong password is refused', async () => {
  const r = await call(null, 'POST', '/api/auth/login', { email: 'hr@demo.local', password: 'nope' });
  assert.equal(r.status, 401);
});

test('site manager only sees assigned sites and their workers', async () => {
  const sites = await call('site1', 'GET', '/api/structure/sites');
  assert.deepEqual(sites.body.map((s) => s.name).sort(), ['Site 1', 'Site 2']);
  const all = await call('admin', 'GET', '/api/structure/sites');
  assert.equal(all.body.length >= 7, true);
  const site3 = all.body.find((s) => s.name === 'Site 3');
  const roster = await call('site1', 'GET', `/api/attendance/roster?site_id=${site3.id}&date=${today}`);
  assert.equal(roster.status, 403);
  const workers = await call('site1', 'GET', '/api/workers');
  const allWorkers = await call('admin', 'GET', '/api/workers');
  assert.ok(workers.body.length < allWorkers.body.length);
});

test('offline sync: duplicates ignored, conflicts detected, history kept', async () => {
  const site1 = (await call('site1', 'GET', '/api/structure/sites')).body.find((s) => s.name === 'Site 1');
  const roster = (await call('site1', 'GET', `/api/attendance/roster?site_id=${site1.id}&date=${today}`)).body;
  const row = roster[0];
  assert.equal(row.version, 0);
  const op = { op_id: crypto.randomUUID(), assignment_id: row.assignment_id, work_date: today, status: 'present', normal_hours: 8, overtime_hours: 1, base_version: 0, source: 'offline' };

  let r = await call('site1', 'POST', '/api/sync/attendance', { device_id: 'tablet-1', operations: [op] });
  assert.equal(r.body.results[0].result, 'applied');
  assert.equal(r.body.results[0].record.version, 1);

  r = await call('site1', 'POST', '/api/sync/attendance', { device_id: 'tablet-1', operations: [op] }); // retry after a dropped connection
  assert.equal(r.body.results[0].duplicate, true);
  const [{ n }] = await db.query('SELECT COUNT(*) AS n FROM attendance WHERE assignment_id = ? AND work_date = ?', [row.assignment_id, today]);
  assert.equal(n, 1);

  // Second device edited an old copy (version 0) with different data -> conflict, server record unchanged
  const op2 = { ...op, op_id: crypto.randomUUID(), status: 'absent' };
  r = await call('site1', 'POST', '/api/sync/attendance', { device_id: 'phone-2', operations: [op2] });
  assert.equal(r.body.results[0].result, 'conflict');
  const conflicts = await call('site1', 'GET', '/api/sync/conflicts');
  assert.ok(conflicts.body.some((c) => c.op_id === op2.op_id));

  // Normal edit on the latest version
  const op3 = { ...op, op_id: crypto.randomUUID(), late_arrival: true, base_version: 1 };
  r = await call('site1', 'POST', '/api/sync/attendance', { operations: [op3] });
  assert.equal(r.body.results[0].result, 'applied');
  assert.equal(r.body.results[0].record.version, 2);
  const hist = await call('site1', 'GET', `/api/attendance/${r.body.results[0].record.id}/history`);
  assert.equal(hist.body.length, 2);

  // Bad data is rejected but does not block the other operations in the batch
  const badOp = { ...op, op_id: crypto.randomUUID(), normal_hours: 30 };
  const okOp = { ...op, op_id: crypto.randomUUID(), assignment_id: roster[1].assignment_id };
  r = await call('site1', 'POST', '/api/sync/attendance', { operations: [badOp, okOp] });
  assert.equal(r.body.results[0].result, 'rejected');
  assert.equal(r.body.results[1].result, 'applied');

  // Resolve the conflict by keeping the server version
  const c = conflicts.body.find((x) => x.op_id === op2.op_id);
  r = await call('site1', 'POST', `/api/sync/conflicts/${c.id}/resolve`, { action: 'keep_server' });
  assert.equal(r.status, 200);
});

test('catering: only validated + entitled workers count, then full traceability', async () => {
  const site1 = (await call('site1', 'GET', '/api/structure/sites')).body.find((s) => s.name === 'Site 1');
  const roster = (await call('site1', 'GET', `/api/attendance/roster?site_id=${site1.id}&date=${today}`)).body;
  const ops = roster.map((r) => ({ op_id: crypto.randomUUID(), assignment_id: r.assignment_id, work_date: today, status: 'present', normal_hours: 8, base_version: r.version, late_arrival: !!r.late_arrival }));
  await call('site1', 'POST', '/api/sync/attendance', { operations: ops });

  let req = await call('catering', 'POST', '/api/catering/requirements/calculate', { date: today });
  assert.equal(req.body.orders.filter((o) => o.site_name === 'Site 1').length, 0, 'not validated yet, so no meals');
  assert.ok(req.body.pending_validation.some((p) => p.site_name === 'Site 1'));

  await call('site1', 'POST', '/api/attendance/validate', { site_id: site1.id, date: today });
  req = await call('catering', 'POST', '/api/catering/requirements/calculate', { date: today });
  const lunch = req.body.orders.find((o) => o.site_name === 'Site 1' && o.meal_type === 'lunch');
  const entitledLunch = roster.filter((r) => r.meals.includes('lunch')).length;
  assert.equal(lunch.required_qty, entitledLunch);
  const dinner = req.body.orders.find((o) => o.site_name === 'Site 1' && o.meal_type === 'dinner');
  assert.equal(dinner ? dinner.required_qty : 0, roster.filter((r) => r.meals.includes('dinner')).length);

  const plans = await call('catering', 'POST', '/api/catering/plans/generate', { date: today });
  const plan = plans.body.plans.find((p) => p.kitchen_name === 'Central Kitchen' && p.meal_type === 'lunch');
  assert.ok(plan.required_qty >= lunch.required_qty);

  // The kitchen manager is only assigned the temporary kitchen
  let r = await call('kitchen', 'POST', `/api/catering/plans/${plan.id}/batches`, { produced_qty: 10 });
  assert.equal(r.status, 403);
  r = await call('catering', 'POST', `/api/catering/plans/${plan.id}/batches`, { produced_qty: lunch.required_qty + 2, rejected_qty: 2 });
  assert.equal(r.status, 201);
  r = await call('catering', 'POST', '/api/catering/dispatches', { meal_plan_id: plan.id, site_id: site1.id, dispatched_qty: lunch.required_qty + 1 });
  assert.equal(r.status, 400, 'cannot dispatch more than produced minus rejected');
  r = await call('catering', 'POST', '/api/catering/dispatches', { meal_plan_id: plan.id, site_id: site1.id, dispatched_qty: lunch.required_qty });
  assert.equal(r.status, 201);
  const dispatchId = r.body.id;
  r = await call('site1', 'POST', `/api/catering/dispatches/${dispatchId}/receive`, { received_qty: lunch.required_qty });
  assert.equal(r.status, 200);
  r = await call('site1', 'POST', '/api/catering/distributions', { site_id: site1.id, service_date: today, meal_type: 'lunch', distributed_qty: lunch.required_qty - 1 });
  assert.equal(r.status, 201);
  const trace = await call('catering', 'GET', `/api/catering/traceability?date=${today}`);
  const t = trace.body.sites.find((s) => s.site_name === 'Site 1' && s.meal_type === 'lunch');
  assert.deepEqual([t.required, t.dispatched, t.received, t.distributed, t.remaining].map(Number),
    [lunch.required_qty, lunch.required_qty, lunch.required_qty, lunch.required_qty - 1, 1]);
});

test('site kitchen change keeps history', async () => {
  const sites = (await call('admin', 'GET', '/api/structure/sites')).body;
  const s5 = sites.find((s) => s.name === 'Site 5');
  const kitchens = (await call('catering', 'GET', '/api/kitchens')).body;
  const temp = kitchens.find((k) => k.kitchen_type === 'temporary');
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const r = await call('catering', 'POST', '/api/site-kitchens', { site_id: s5.id, kitchen_id: temp.id, start_date: tomorrow });
  assert.equal(r.status, 201);
  const hist = (await call('catering', 'GET', `/api/site-kitchens?site_id=${s5.id}`)).body;
  assert.equal(hist.length, 2);
  assert.equal(hist.find((h) => h.kitchen_id !== temp.id).end_date, today);
});

test('medical records are hidden from other roles', async () => {
  assert.equal((await call('site1', 'GET', '/api/medical/records')).status, 403);
  assert.equal((await call('hr', 'GET', '/api/medical/records')).status, 403);
  const r = await call('medical', 'GET', '/api/medical/records');
  assert.equal(r.status, 200);
  assert.ok(r.body.length >= 3);
  await call('medical', 'GET', `/api/medical/records/${r.body[0].id}`);
  const [{ n }] = await db.query("SELECT COUNT(*) AS n FROM audit_logs WHERE entity = 'medical_record' AND action = 'view'");
  assert.ok(n >= 1, 'opening a medical record is logged');
});

test('HSE incident fills client and project from the site', async () => {
  const sites = (await call('site1', 'GET', '/api/structure/sites')).body;
  let r = await call('site1', 'POST', '/api/hse/incidents', { occurred_at: new Date().toISOString(), site_id: sites[0].id, incident_type: 'near_miss', description: 'Test', severity: 'low' });
  assert.equal(r.status, 201);
  assert.equal(r.body.client_name, 'Client A');
  const other = (await call('admin', 'GET', '/api/structure/sites')).body.find((s) => s.name === 'Site 6');
  r = await call('site1', 'POST', '/api/hse/incidents', { occurred_at: new Date().toISOString(), site_id: other.id, incident_type: 'near_miss', description: 'Test', severity: 'low' });
  assert.equal(r.status, 403);
  const dash = await call('hse', 'GET', '/api/hse/dashboard');
  assert.ok(dash.body.open_incidents >= 2);
  assert.ok(dash.body.overdue_actions.length >= 1);
});

test('cost allocation by meal count and percentage adds up exactly', async () => {
  const exps = (await call('finance', 'GET', '/api/finance/expenses')).body;
  const food = exps.find((e) => e.category === 'food');
  let r = await call('finance', 'POST', `/api/finance/expenses/${food.id}/allocate`, { method: 'meal_count' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const sum = r.body.lines.reduce((a, l) => a + l.amount, 0);
  assert.equal(Math.round(sum * 100), Math.round(food.amount * 100));
  const sites = (await call('admin', 'GET', '/api/structure/sites')).body;
  r = await call('finance', 'POST', `/api/finance/expenses/${food.id}/allocate`, { method: 'percentage', lines: [{ site_id: sites[0].id, percentage: 60 }, { site_id: sites[1].id, percentage: 30 }] });
  assert.equal(r.status, 400, 'must add up to 100');
  r = await call('finance', 'POST', `/api/finance/expenses/${food.id}/allocate`, { method: 'percentage', lines: [{ site_id: sites[0].id, percentage: 33.33 }, { site_id: sites[1].id, percentage: 66.67 }] });
  assert.equal(r.status, 200);
  const costs = await call('finance', 'GET', '/api/finance/costs');
  assert.ok(costs.body.rows.length >= 2);
});

test('assignments: no overlaps, transfers keep history', async () => {
  const workers = (await call('hr', 'GET', '/api/workers')).body;
  const w = workers.find((x) => x.current_assignment);
  const sites = (await call('hr', 'GET', '/api/structure/sites')).body;
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  let r = await call('hr', 'POST', `/api/workers/${w.id}/assignments`, { site_id: sites[6].id, start_date: tomorrow, meals: ['lunch'] });
  assert.equal(r.status, 400);
  r = await call('hr', 'POST', `/api/workers/${w.id}/assignments`, { site_id: sites[6].id, start_date: tomorrow, meals: ['lunch'], end_previous: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const hist = (await call('hr', 'GET', `/api/workers/${w.id}/assignments`)).body;
  assert.ok(hist.length >= 2);
  assert.equal(hist.find((h) => h.id !== r.body.id && h.status === 'ended' && h.end_date === today).end_date, today);
});

test('accommodation shows capacity, occupied and available; full rooms refuse check-in', async () => {
  const s = (await call('housing', 'GET', '/api/accommodation/summary')).body;
  assert.equal(s.total.capacity - s.total.occupied, s.total.available);
  const rooms = (await call('housing', 'GET', '/api/accommodation/rooms')).body;
  const full = rooms.find((r) => r.occupied >= r.capacity);
  const free = (await call('admin', 'GET', '/api/workers')).body.slice(-1)[0];
  const r = await call('housing', 'POST', '/api/accommodation/check-in', { room_id: full.id, worker_id: free.id });
  assert.equal(r.status, 400);
});

test('payroll and dashboard', async () => {
  const p = await call('finance', 'GET', '/api/payroll');
  assert.equal(p.status, 200);
  assert.ok(p.body.rows.every((r) => r.total_pay === Math.round((r.normal_pay + r.overtime_pay) * 100) / 100));
  const d = await call('admin', 'GET', '/api/dashboard');
  for (const k of ['workforce', 'attendance', 'catering', 'hse', 'accommodation', 'payroll', 'medical']) assert.ok(d.body[k], k);
  const ds = await call('site1', 'GET', '/api/dashboard');
  assert.equal(ds.body.medical, undefined);
  assert.equal(ds.body.payroll, undefined);
});

test('roles can be edited but the admin cannot lock themselves out', async () => {
  const roles = (await call('admin', 'GET', '/api/roles')).body;
  const sa = roles.find((r) => r.name === 'Super Administrator');
  const r = await call('admin', 'PUT', `/api/roles/${sa.id}`, { permissions: ['dashboard.view'] });
  assert.equal(r.status, 400);
  const hse = roles.find((x) => x.name === 'HSE Manager');
  assert.equal((await call('admin', 'PUT', `/api/roles/${hse.id}`, { permissions: [...hse.permissions, 'payroll.view'] })).status, 200);
  assert.equal((await call('hse', 'GET', '/api/payroll')).status, 200, 'permission change applies immediately');
  await call('admin', 'PUT', `/api/roles/${hse.id}`, { permissions: hse.permissions });
});
