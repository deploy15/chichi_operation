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

const ROLE_USERS = ['md', 'daf', 'recruitment', 'site1', 'chef', 'souschef', 'transport', 'medical', 'hse', 'housing'];
before(async () => {
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  await login('admin', process.env.ADMIN_EMAIL || 'admin@example.com', process.env.ADMIN_PASSWORD || 'ChangeMe123!');
  for (const w of ROLE_USERS) await login(w, `${w}@demo.local`);
});
after(async () => { server.close(); await db.pool.end(); });

test('wrong password is refused', async () => {
  const r = await call(null, 'POST', '/api/auth/login', { email: 'daf@demo.local', password: 'nope' });
  assert.equal(r.status, 401);
});

test('site administrator only sees assigned sites; no access to workers, stock, finance or payroll', async () => {
  const sites = await call('site1', 'GET', '/api/structure/sites');
  assert.deepEqual(sites.body.map((s) => s.name).sort(), ['Site 1', 'Site 2']);
  const all = await call('admin', 'GET', '/api/structure/sites');
  assert.equal(all.body.length >= 7, true);
  const site3 = all.body.find((s) => s.name === 'Site 3');
  assert.equal((await call('site1', 'GET', `/api/attendance/roster?site_id=${site3.id}&date=${today}`)).status, 403);
  for (const path of ['/api/workers', '/api/stock-items', '/api/finance/expenses', '/api/payroll', '/api/purchases', '/api/catering/plans']) {
    assert.equal((await call('site1', 'GET', path)).status, 403, path);
  }
  const w = (await call('admin', 'GET', '/api/workers')).body[0];
  assert.equal((await call('site1', 'POST', `/api/workers/${w.id}/assignments`, { site_id: sites.body[0].id, start_date: today })).status, 403, 'cannot assign workers');
  assert.equal((await call('site1', 'PUT', '/api/settings', { overtime_multiplier: '2' })).status, 403, 'cannot change payroll rules');
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

test('daily workforce report, then catering: plan, produce, quality check, deliver, receive', async () => {
  const site1 = (await call('site1', 'GET', '/api/structure/sites')).body.find((s) => s.name === 'Site 1');
  const roster = (await call('site1', 'GET', `/api/attendance/roster?site_id=${site1.id}&date=${today}`)).body;
  const ops = roster.map((r) => ({ op_id: crypto.randomUUID(), assignment_id: r.assignment_id, work_date: today, status: 'present', normal_hours: 8, base_version: r.version, late_arrival: !!r.late_arrival }));
  await call('site1', 'POST', '/api/sync/attendance', { operations: ops });

  let req = await call('chef', 'POST', '/api/catering/requirements/calculate', { date: today });
  assert.equal(req.body.orders.filter((o) => o.site_name === 'Site 1').length, 0, 'not submitted yet, so no meals');

  // Daily workforce report: submitted by the Site Administrator, on time is recorded
  let r = await call('site1', 'POST', '/api/attendance/validate', { site_id: site1.id, date: today });
  assert.equal(r.status, 200);
  assert.ok([0, 1].includes(r.body.report.on_time));
  assert.equal(r.body.report.present_count, roster.length);
  const reports = (await call('md', 'GET', `/api/attendance/daily-reports?date=${today}`)).body;
  assert.ok(reports.find((x) => x.site_name === 'Site 1').id);

  req = await call('chef', 'POST', '/api/catering/requirements/calculate', { date: today });
  const lunch = req.body.orders.find((o) => o.site_name === 'Site 1' && o.meal_type === 'lunch');
  assert.equal(lunch.required_qty, roster.filter((x) => x.meals.includes('lunch')).length);
  const plans = await call('chef', 'POST', '/api/catering/plans/generate', { date: today });
  const plan = plans.body.plans.find((p) => p.kitchen_name === 'Central Kitchen' && p.meal_type === 'lunch');
  const kitchenId = plan.kitchen_id;

  // Menus: Catering Director only
  assert.equal((await call('souschef', 'POST', '/api/menus', { name: 'X', meal_type: 'lunch' })).status, 403);
  assert.equal((await call('daf', 'POST', '/api/menus', { name: 'X', meal_type: 'lunch' })).status, 403);
  assert.equal((await call('chef', 'POST', '/api/menus', { name: 'Fish & rice', meal_type: 'lunch' })).status, 201);
  assert.equal((await call('souschef', 'PUT', `/api/catering/plans/${plan.id}`, { planned_qty: 1 })).status, 403, 'sous-chef cannot change quantities');
  assert.equal((await call('daf', 'PUT', `/api/catering/plans/${plan.id}`, { planned_qty: 1 })).status, 403, 'DAF cannot change catering production');

  // Sous-chef records production; only the Catering Director validates quality
  r = await call('souschef', 'POST', `/api/catering/plans/${plan.id}/batches`, { produced_qty: lunch.required_qty + 2, rejected_qty: 0 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const batches = (await call('souschef', 'GET', `/api/catering/plans/${plan.id}/batches`)).body;
  const batch = batches.find((b) => b.quality_status === 'pending');
  assert.equal((await call('souschef', 'POST', `/api/catering/batches/${batch.id}/quality`, { quality_status: 'approved' })).status, 403);
  assert.equal((await call('chef', 'POST', `/api/catering/batches/${batch.id}/quality`, { quality_status: 'approved', rejected_qty: 2 })).status, 200);

  // Delivery schedule: planned and validated by the Catering Director only
  assert.equal((await call('souschef', 'POST', '/api/catering/dispatches', { meal_plan_id: plan.id, site_id: site1.id, planned_qty: 5 })).status, 403);
  assert.equal((await call('transport', 'POST', '/api/catering/dispatches', { meal_plan_id: plan.id, site_id: site1.id, planned_qty: 5 })).status, 403);
  r = await call('chef', 'POST', '/api/catering/dispatches', { meal_plan_id: plan.id, site_id: site1.id, planned_qty: lunch.required_qty });
  assert.equal(r.status, 201);
  const dispatchId = r.body.id;
  assert.equal((await call('transport', 'POST', `/api/catering/dispatches/${dispatchId}/load`, { loaded_qty: 1 })).status, 400, 'not validated yet');
  assert.equal((await call('transport', 'POST', `/api/catering/dispatches/${dispatchId}/validate`, {})).status, 403);
  assert.equal((await call('chef', 'POST', `/api/catering/dispatches/${dispatchId}/validate`, { dispatched_qty: 100000 })).status, 400, 'cannot send more than approved meals');
  assert.equal((await call('chef', 'POST', `/api/catering/dispatches/${dispatchId}/validate`, {})).status, 200);
  assert.equal((await call('transport', 'PUT', `/api/catering/dispatches/${dispatchId}`, { planned_qty: 1 })).status, 403, 'team cannot edit delivery schedule');

  // Transport team loads and delivers; Site Administrator receives
  assert.equal((await call('transport', 'POST', `/api/catering/dispatches/${dispatchId}/load`, { loaded_qty: lunch.required_qty + 1 })).status, 400);
  assert.equal((await call('transport', 'POST', `/api/catering/dispatches/${dispatchId}/load`, { loaded_qty: lunch.required_qty })).status, 200);
  assert.equal((await call('transport', 'POST', `/api/catering/dispatches/${dispatchId}/deliver`, {})).status, 200);
  assert.equal((await call('transport', 'POST', `/api/catering/dispatches/${dispatchId}/receive`, { received_qty: 1 })).status, 403);
  r = await call('site1', 'POST', `/api/catering/dispatches/${dispatchId}/receive`, { received_qty: lunch.required_qty });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('site1', 'POST', '/api/catering/distributions', { site_id: site1.id, service_date: today, meal_type: 'lunch', distributed_qty: lunch.required_qty - 1 });
  assert.equal(r.status, 201);
  const trace = await call('chef', 'GET', `/api/catering/traceability?date=${today}`);
  const t = trace.body.sites.find((s) => s.site_name === 'Site 1' && s.meal_type === 'lunch');
  assert.deepEqual([t.required, t.dispatched, t.received, t.distributed, t.remaining].map(Number),
    [lunch.required_qty, lunch.required_qty, lunch.required_qty, lunch.required_qty - 1, 1]);

  // Kitchen and transport records; site feedback goes back to the Catering Director
  assert.equal((await call('souschef', 'POST', '/api/operations/logs', { log_type: 'ingredient_prep', kitchen_id: kitchenId, description: 'Onions chopped' })).status, 201);
  assert.equal((await call('souschef', 'POST', '/api/operations/logs', { log_type: 'cleaning', kitchen_id: kitchenId })).status, 403, 'cleaning is the team\'s job');
  assert.equal((await call('transport', 'POST', '/api/operations/logs', { log_type: 'damaged_packaging', kitchen_id: kitchenId, dispatch_id: dispatchId, quantity: 2 })).status, 201);
  assert.equal((await call('transport', 'POST', '/api/operations/logs', { log_type: 'meals_portioned', kitchen_id: kitchenId })).status, 403);
  r = await call('site1', 'POST', '/api/operations/logs', { log_type: 'site_complaint', site_id: site1.id, description: 'Food was cold' });
  assert.equal(r.status, 201);
  assert.equal((await call('site1', 'POST', `/api/operations/logs/${r.body.id}/respond`, { status: 'closed' })).status, 403);
  assert.equal((await call('chef', 'POST', `/api/operations/logs/${r.body.id}/respond`, { status: 'acknowledged', response: 'Will use insulated boxes' })).status, 200);
});

test('stock: Catering Director records movements; sous-chefs and team can only report', async () => {
  const items = (await call('souschef', 'GET', '/api/stock-items')).body;
  assert.ok(items.length > 0, 'sous-chef sees stock of own kitchen');
  const allItems = (await call('chef', 'GET', '/api/stock-items')).body;
  assert.ok(allItems.length > items.length, 'sous-chef only sees own kitchen');
  const item = items[0];
  for (const who of ['souschef', 'transport', 'daf', 'site1']) {
    assert.equal((await call(who, 'POST', `/api/stock-items/${item.id}/movements`, { movement_type: 'out', quantity: 1 })).status, 403, who);
  }
  assert.equal((await call('souschef', 'PUT', `/api/stock-items/${item.id}`, { quantity: 0 })).status, 403);
  let r = await call('chef', 'POST', `/api/stock-items/${item.id}/movements`, { movement_type: 'out', quantity: 1, notes: 'Used today' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  r = await call('souschef', 'POST', '/api/operations/logs', { log_type: 'stock_report', kitchen_id: item.kitchen_id, stock_item_id: item.id, quantity: 5, description: 'Running low' });
  assert.equal(r.status, 201);
  assert.equal((await call('daf', 'GET', '/api/stock-items')).status, 200, 'DAF can view stock');
  assert.equal((await call('recruitment', 'GET', '/api/stock-items')).status, 403);
});

test('purchases: Catering Director requests, DAF approves; major purchases need the MD', async () => {
  const kitchens = (await call('chef', 'GET', '/api/kitchens')).body;
  let r = await call('chef', 'POST', '/api/purchases', { kitchen_id: kitchens[0].id, items: '50 kg sugar', estimated_amount: 40000 });
  assert.equal(r.status, 201);
  const small = r.body;
  assert.equal(small.requires_major_approval, 0);
  assert.equal((await call('chef', 'POST', `/api/purchases/${small.id}/decision`, { decision: 'approved' })).status, 403, 'cannot approve purchases');
  assert.equal((await call('site1', 'POST', '/api/purchases', { items: 'x', estimated_amount: 10 })).status, 403);
  assert.equal((await call('daf', 'POST', `/api/purchases/${small.id}/decision`, { decision: 'approved' })).status, 200);

  r = await call('chef', 'POST', '/api/purchases', { kitchen_id: kitchens[0].id, items: 'New truck', estimated_amount: 9000000 });
  assert.equal(r.body.requires_major_approval, 1);
  assert.equal((await call('daf', 'POST', `/api/purchases/${r.body.id}/decision`, { decision: 'approved' })).status, 403);
  assert.equal((await call('md', 'POST', `/api/purchases/${r.body.id}/decision`, { decision: 'approved' })).status, 200);

  // Expenses: recorded and validated by finance; the Catering Director can only view them
  assert.equal((await call('chef', 'GET', '/api/finance/expenses')).status, 200);
  assert.equal((await call('chef', 'POST', '/api/finance/expenses', { kitchen_id: kitchens[0].id, expense_date: today, category: 'food', amount: 10 })).status, 403);
  r = await call('daf', 'POST', '/api/finance/expenses', { kitchen_id: kitchens[0].id, expense_date: today, category: 'food', amount: 40000, document_type: 'invoice', purchase_request_id: small.id });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal((await call('daf', 'POST', `/api/finance/expenses/${r.body.id}/approve`, { decision: 'validated' })).status, 200);
  r = await call('daf', 'POST', '/api/finance/expenses', { kitchen_id: kitchens[0].id, expense_date: today, category: 'equipment', amount: 5000000 });
  assert.equal((await call('daf', 'POST', `/api/finance/expenses/${r.body.id}/approve`, { decision: 'validated' })).status, 403, 'major expense needs the MD');
  assert.equal((await call('md', 'POST', `/api/finance/expenses/${r.body.id}/approve`, { decision: 'validated' })).status, 200);
});

test('budgets: DAF creates and approves; others cannot', async () => {
  let r = await call('daf', 'POST', '/api/finance/budgets', { name: 'Q4 catering', period_start: today, period_end: today, amount: 500000 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal((await call('chef', 'POST', `/api/finance/budgets/${r.body.id}/decision`, { decision: 'approved' })).status, 403);
  assert.equal((await call('daf', 'POST', `/api/finance/budgets/${r.body.id}/decision`, { decision: 'approved' })).status, 200);
  assert.equal((await call('recruitment', 'GET', '/api/finance/budgets')).status, 403);
});

test('site kitchen change keeps history', async () => {
  const sites = (await call('admin', 'GET', '/api/structure/sites')).body;
  const s5 = sites.find((s) => s.name === 'Site 5');
  const kitchens = (await call('chef', 'GET', '/api/kitchens')).body;
  const temp = kitchens.find((k) => k.kitchen_type === 'temporary');
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const r = await call('chef', 'POST', '/api/site-kitchens', { site_id: s5.id, kitchen_id: temp.id, start_date: tomorrow });
  assert.equal(r.status, 201);
  const hist = (await call('chef', 'GET', `/api/site-kitchens?site_id=${s5.id}`)).body;
  assert.equal(hist.length, 2);
  assert.equal(hist.find((h) => h.kitchen_id !== temp.id).end_date, today);
});

test('medical records are hidden from other roles', async () => {
  assert.equal((await call('site1', 'GET', '/api/medical/records')).status, 403);
  for (const who of ['daf', 'recruitment', 'chef', 'hse']) assert.equal((await call(who, 'GET', '/api/medical/records')).status, 403, who);
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
  const exps = (await call('daf', 'GET', '/api/finance/expenses')).body;
  const food = exps.find((e) => e.category === 'food');
  let r = await call('daf', 'POST', `/api/finance/expenses/${food.id}/allocate`, { method: 'meal_count' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const sum = r.body.lines.reduce((a, l) => a + l.amount, 0);
  assert.equal(Math.round(sum * 100), Math.round(food.amount * 100));
  const sites = (await call('admin', 'GET', '/api/structure/sites')).body;
  r = await call('daf', 'POST', `/api/finance/expenses/${food.id}/allocate`, { method: 'percentage', lines: [{ site_id: sites[0].id, percentage: 60 }, { site_id: sites[1].id, percentage: 30 }] });
  assert.equal(r.status, 400, 'must add up to 100');
  r = await call('daf', 'POST', `/api/finance/expenses/${food.id}/allocate`, { method: 'percentage', lines: [{ site_id: sites[0].id, percentage: 33.33 }, { site_id: sites[1].id, percentage: 66.67 }] });
  assert.equal(r.status, 200);
  const costs = await call('daf', 'GET', '/api/finance/costs');
  assert.ok(costs.body.rows.length >= 2);
});

test('assignments: Recruitment Manager assigns and replaces; others cannot; transfers keep history', async () => {
  const workers = (await call('recruitment', 'GET', '/api/workers')).body;
  const w = workers.find((x) => x.current_assignment);
  const sites = (await call('recruitment', 'GET', '/api/structure/sites')).body;
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  for (const who of ['daf', 'chef', 'site1']) {
    assert.equal((await call(who, 'POST', `/api/workers/${w.id}/assignments`, { site_id: sites[0].id, start_date: tomorrow, end_previous: true })).status, 403, who);
  }
  let r = await call('recruitment', 'POST', `/api/workers/${w.id}/assignments`, { site_id: sites[6].id, start_date: tomorrow, meals: ['lunch'] });
  assert.equal(r.status, 400);
  r = await call('recruitment', 'POST', `/api/workers/${w.id}/assignments`, { site_id: sites[6].id, start_date: tomorrow, meals: ['lunch'], end_previous: true, pay_rate: 999999 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(Number(r.body.pay_rate), Number(w.pay_rate), 'recruitment cannot set pay');
  const hist = (await call('recruitment', 'GET', `/api/workers/${w.id}/assignments`)).body;
  assert.ok(hist.length >= 2);
  assert.equal(hist.find((h) => h.id !== r.body.id && h.status === 'ended').end_date, today);

  // Replace an absent worker with an available one
  const created = await call('recruitment', 'POST', '/api/workers', { worker_code: 'W-REPL1', first_name: 'Reggie', last_name: 'Replacement' });
  assert.equal(created.status, 201);
  const absent = workers.find((x) => x.current_assignment && x.id !== w.id);
  r = await call('recruitment', 'POST', `/api/workers/${created.body.id}/assignments`, { site_id: sites[0].id, start_date: today, replaces_worker_id: absent.id, meals: ['lunch'] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.assignment_type, 'replacement');
  assert.equal((await call('md', 'GET', `/api/workers/${absent.id}`)).body.deployment_status, 'absent');
  assert.equal((await call('md', 'GET', `/api/workers/${created.body.id}`)).body.deployment_status, 'deployed');
});

test('worker records: each role can only change its own part', async () => {
  const w = (await call('md', 'GET', '/api/workers')).body[0];
  // Recruitment: personal details yes, pay no (silently ignored), CNSS yes
  let r = await call('recruitment', 'PUT', `/api/workers/${w.id}`, { phone: '+111', pay_rate: 1, cnss_number: 'CNSS-1' });
  assert.equal(r.status, 200);
  assert.equal(r.body.phone, '+111');
  assert.equal(Number(r.body.pay_rate), Number(w.pay_rate));
  assert.equal(r.body.cnss_number, 'CNSS-1');
  // DAF: pay, allowance and administrative files yes; personal details and deployment no
  r = await call('daf', 'PUT', `/api/workers/${w.id}`, { phone: '+222', pay_rate: 7000, daily_allowance: 500, insurance_provider: 'AXA', deployment_status: 'unassigned' });
  assert.equal(r.status, 200);
  assert.equal(r.body.phone, '+111');
  assert.equal(Number(r.body.pay_rate), 7000);
  assert.equal(Number(r.body.daily_allowance), 500);
  assert.equal(r.body.insurance_provider, 'AXA');
  assert.notEqual(r.body.deployment_status, 'unassigned');
  assert.equal((await call('daf', 'POST', '/api/workers', { worker_code: 'X1', first_name: 'a', last_name: 'b' })).status, 403);
  // Catering Director: view only
  assert.equal((await call('chef', 'GET', '/api/workers')).status, 200);
  assert.equal((await call('chef', 'PUT', `/api/workers/${w.id}`, { phone: '+333' })).status, 403);
  for (const who of ['souschef', 'transport', 'site1']) assert.equal((await call(who, 'GET', '/api/workers')).status, 403, who);
  // Payroll includes the allowance
  const p = (await call('daf', 'GET', '/api/payroll')).body;
  assert.ok(p.rows.every((x) => Math.abs(x.total_pay - (x.normal_pay + x.overtime_pay + (x.allowance_pay || 0))) < 0.011));
  assert.equal((await call('recruitment', 'GET', '/api/payroll')).status, 403, 'recruitment cannot see finance');
});

test('attendance: only the Site Administrator (and MD) can edit it', async () => {
  const site1 = (await call('site1', 'GET', '/api/structure/sites')).body.find((s) => s.name === 'Site 1');
  const roster = (await call('site1', 'GET', `/api/attendance/roster?site_id=${site1.id}&date=${today}`)).body;
  const op = { op_id: crypto.randomUUID(), assignment_id: roster[0].assignment_id, work_date: today, status: 'absent', base_version: roster[0].version };
  for (const who of ['daf', 'recruitment', 'chef', 'souschef', 'transport']) {
    assert.equal((await call(who, 'POST', '/api/sync/attendance', { operations: [op] })).status, 403, who);
    assert.equal((await call(who, 'POST', '/api/attendance/validate', { site_id: site1.id, date: today })).status, 403, who);
  }
  for (const who of ['daf', 'recruitment', 'chef']) assert.equal((await call(who, 'GET', `/api/attendance/roster?site_id=${site1.id}&date=${today}`)).status, 200, `${who} can view`);
  assert.equal((await call('souschef', 'GET', '/api/attendance')).status, 403);
});

test('recruitment: register, verify documents, approve, hire; staffing requests flow from sites', async () => {
  const profile = await call('recruitment', 'POST', '/api/recruitment/job-profiles', { title: 'Cook helper', category: 'General' });
  assert.equal(profile.status, 201);
  assert.equal((await call('daf', 'POST', '/api/recruitment/job-profiles', { title: 'x' })).status, 403);
  const c = await call('recruitment', 'POST', '/api/recruitment/candidates', { job_profile_id: profile.body.id, first_name: 'Ada', last_name: 'Obi' });
  assert.equal(c.status, 201);
  assert.equal((await call('recruitment', 'POST', `/api/recruitment/candidates/${c.body.id}/decision`, { decision: 'approved' })).status, 400, 'documents must be verified first');
  assert.equal((await call('daf', 'POST', `/api/recruitment/candidates/${c.body.id}/verify`, { id_document_ok: true, qualifications_ok: true })).status, 200, 'DAF validates recruitment documents');
  assert.equal((await call('daf', 'POST', `/api/recruitment/candidates/${c.body.id}/decision`, { decision: 'approved' })).status, 403);
  assert.equal((await call('recruitment', 'POST', `/api/recruitment/candidates/${c.body.id}/decision`, { decision: 'approved' })).status, 200);
  const hired = await call('recruitment', 'POST', `/api/recruitment/candidates/${c.body.id}/hire`, { worker_code: 'W-HIRE1' });
  assert.equal(hired.status, 201, JSON.stringify(hired.body));

  const sites = (await call('site1', 'GET', '/api/structure/sites')).body;
  let r = await call('site1', 'POST', '/api/staffing-requests', { site_id: sites[0].id, job_position: 'Labourer', quantity: 2, needed_from: today, forward: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const other = (await call('md', 'GET', '/api/structure/sites')).body.find((s) => s.name === 'Site 6');
  assert.equal((await call('site1', 'POST', '/api/staffing-requests', { site_id: other.id, job_position: 'x', quantity: 1, needed_from: today })).status, 403);
  const list = (await call('recruitment', 'GET', '/api/staffing-requests')).body;
  assert.ok(list.some((x) => x.id === r.body.id));
  assert.equal((await call('site1', 'POST', `/api/staffing-requests/${r.body.id}/status`, { status: 'filled' })).status, 403);
  assert.equal((await call('recruitment', 'POST', `/api/staffing-requests/${r.body.id}/status`, { status: 'filled' })).status, 200);
});

test('HSE: corrective actions are approved by the MD only', async () => {
  const inc = (await call('hse', 'GET', '/api/hse/incidents')).body.find((i) => i.description.startsWith('Worker cut hand'));
  const detail = (await call('hse', 'GET', `/api/hse/incidents/${inc.id}`)).body;
  const action = detail.actions[0];
  assert.equal((await call('hse', 'PUT', `/api/hse/actions/${action.id}`, { status: 'done' })).status, 200);
  assert.equal((await call('hse', 'POST', `/api/hse/actions/${action.id}/approve`, {})).status, 403);
  assert.equal((await call('md', 'POST', `/api/hse/actions/${action.id}/approve`, {})).status, 200);
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

test('dashboard shows each role only its own sections and approvals', async () => {
  const d = await call('admin', 'GET', '/api/dashboard');
  for (const k of ['workforce', 'attendance', 'catering', 'hse', 'accommodation', 'payroll', 'medical']) assert.ok(d.body[k], k);
  const ds = await call('site1', 'GET', '/api/dashboard');
  assert.equal(ds.body.medical, undefined);
  assert.equal(ds.body.payroll, undefined);
  assert.equal(ds.body.finance, undefined);
  const dd = (await call('daf', 'GET', '/api/dashboard')).body;
  assert.ok(dd.approvals.some((a) => a.link.includes('purchases')), 'DAF sees purchases to approve');
  const dm = (await call('md', 'GET', '/api/dashboard')).body;
  assert.ok(dm.approvals.length >= 1);
  const dk = (await call('souschef', 'GET', '/api/dashboard')).body;
  assert.equal(dk.workforce, undefined);
  assert.equal(dk.finance, undefined);
});

test('roles can be edited but the admin cannot lock themselves out', async () => {
  const roles = (await call('admin', 'GET', '/api/roles')).body;
  const sa = roles.find((r) => r.name === 'Managing Director (MD / DG)');
  const r = await call('admin', 'PUT', `/api/roles/${sa.id}`, { permissions: ['dashboard.view'] });
  assert.equal(r.status, 400);
  const hse = roles.find((x) => x.name === 'HSE Manager');
  assert.equal((await call('admin', 'PUT', `/api/roles/${hse.id}`, { permissions: [...hse.permissions, 'payroll.view'] })).status, 200);
  assert.equal((await call('hse', 'GET', '/api/payroll')).status, 200, 'permission change applies immediately');
  assert.equal((await call('daf', 'GET', '/api/roles')).status, 403, 'only the MD manages users and roles');
  await call('admin', 'PUT', `/api/roles/${hse.id}`, { permissions: hse.permissions });
});
