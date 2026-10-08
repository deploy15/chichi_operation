// Catering: kitchens (central and temporary), which kitchen feeds which site, stock, staff,
// meal requirements from validated attendance, production, dispatch, receipt, distribution.
const express = require('express');
const db = require('../lib/db');
const { crud } = require('../lib/crud');
const { audit } = require('../lib/audit');
const { requirePerm, siteFilter, kitchenFilter, assertSite, assertKitchen } = require('../lib/auth');
const { wrap, bad, notFound, isDate, today } = require('../lib/http');

const router = express.Router();
const MEALS = ['lunch', 'dinner'];
const dayBefore = (d) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); };

// ---------- Kitchens ----------
crud(router, '/kitchens', {
  table: 'kitchens', entity: 'kitchen', view: ['catering.view', 'finance.view'], manage: ['catering.manage'],
  select: 't.*, p.name AS project_name',
  from: 'kitchens t LEFT JOIN projects p ON p.id = t.project_id',
  filters: { status: 't.status', kitchen_type: 't.kitchen_type' }, search: ['t.name', 't.location'], orderBy: 't.kitchen_type, t.name',
  scope: (u) => kitchenFilter(u, 't.id'),
  fields: {
    name: { type: 'string', required: true, max: 120, label: 'Name' },
    kitchen_type: { type: 'enum', values: ['central', 'temporary'], default: 'central' },
    status: { type: 'enum', values: ['active', 'suspended', 'closed'], default: 'active' },
    project_id: { type: 'int' },
    location: { type: 'string', max: 200 },
    travel_time_minutes: { type: 'int', min: 0 },
    start_date: { type: 'date' },
    planned_close_date: { type: 'date' },
    actual_close_date: { type: 'date' },
    notes: { type: 'string', max: 255 },
  },
  beforeWrite: (data, req, existing) => {
    const merged = { ...(existing || {}), ...data };
    if (merged.kitchen_type === 'temporary') {
      const missing = ['start_date', 'planned_close_date', 'project_id', 'location'].filter((f) => !merged[f]);
      if (missing.length) throw bad(`A temporary kitchen needs: ${missing.join(', ').replace(/_/g, ' ')}`);
    }
    if (data.status === 'closed' && !merged.actual_close_date) data.actual_close_date = today();
    return data;
  },
});

// ---------- Site -> kitchen assignments (history kept) ----------
router.get('/site-kitchens', requirePerm('catering.view'), wrap(async (req, res) => {
  const s = siteFilter(req.user, 'ska.site_id');
  const where = [s.sql]; const params = [...s.params];
  if (req.query.site_id) { where.push('ska.site_id = ?'); params.push(req.query.site_id); }
  if (req.query.kitchen_id) { where.push('ska.kitchen_id = ?'); params.push(req.query.kitchen_id); }
  res.json(await db.query(
    `SELECT ska.*, s.name AS site_name, p.name AS project_name, k.name AS kitchen_name, k.kitchen_type
       FROM site_kitchen_assignments ska JOIN sites s ON s.id = ska.site_id JOIN projects p ON p.id = s.project_id
       JOIN kitchens k ON k.id = ska.kitchen_id WHERE ${where.join(' AND ')} ORDER BY s.name, ska.start_date DESC`, params));
}));

// Assigning a site to a new kitchen automatically closes its current kitchen assignment the day before.
router.post('/site-kitchens', requirePerm('catering.manage'), wrap(async (req, res) => {
  const { site_id: siteId, kitchen_id: kitchenId, start_date: start, end_date: end, notes } = req.body || {};
  if (!siteId || !kitchenId || !isDate(start)) throw bad('Site, kitchen and start date are required');
  if (end && (!isDate(end) || end < start)) throw bad('End date must be on or after the start date');
  assertSite(req.user, siteId);
  const kitchen = await db.one('SELECT status FROM kitchens WHERE id = ?', [kitchenId]);
  if (!kitchen) throw bad('Kitchen not found');
  if (kitchen.status === 'closed') throw bad('This kitchen is closed');
  const id = await db.tx(async (conn) => {
    const [open] = await conn.query(
      'SELECT * FROM site_kitchen_assignments WHERE site_id = ? AND end_date IS NULL AND start_date < ? FOR UPDATE', [siteId, start]);
    for (const o of open) {
      await conn.query('UPDATE site_kitchen_assignments SET end_date = ? WHERE id = ?', [dayBefore(start), o.id]);
      await audit(req, 'end', 'site_kitchen', o.id, { end_date: dayBefore(start) }, conn);
    }
    const [overlap] = await conn.query(
      `SELECT id FROM site_kitchen_assignments WHERE site_id = ? AND start_date <= ? AND (end_date IS NULL OR end_date >= ?)`,
      [siteId, end || '9999-12-31', start]);
    if (overlap.length) throw bad('This site already has a kitchen for part of that period');
    const [r] = await conn.query('INSERT INTO site_kitchen_assignments (site_id, kitchen_id, start_date, end_date, notes, created_by) VALUES (?,?,?,?,?,?)',
      [siteId, kitchenId, start, end || null, notes || null, req.user.id]);
    await audit(req, 'create', 'site_kitchen', r.insertId, req.body, conn);
    return r.insertId;
  });
  res.status(201).json({ id });
}));

// ---------- Kitchen staff and stock ----------
const kitchenScoped = (u) => kitchenFilter(u, 't.kitchen_id');
const checkKitchen = async (req, row) => assertKitchen(req.user, row.kitchen_id);

crud(router, '/kitchen-staff', {
  table: 'kitchen_staff', entity: 'kitchen_staff', view: ['catering.view'], manage: ['kitchen.manage', 'catering.manage'],
  select: 't.*, k.name AS kitchen_name', from: 'kitchen_staff t JOIN kitchens k ON k.id = t.kitchen_id',
  filters: { kitchen_id: 't.kitchen_id' }, orderBy: 'k.name, t.name', scope: kitchenScoped, canAccessRow: checkKitchen, allowDelete: true,
  fields: {
    kitchen_id: { type: 'int', required: true, label: 'Kitchen' },
    worker_id: { type: 'int' },
    name: { type: 'string', required: true, max: 120, label: 'Name' },
    staff_role: { type: 'string', max: 80 },
    start_date: { type: 'date' },
    end_date: { type: 'date' },
  },
});

crud(router, '/stock-items', {
  table: 'stock_items', entity: 'stock_item', view: ['catering.view'], manage: ['kitchen.manage', 'catering.manage'],
  select: 't.*, k.name AS kitchen_name, t.quantity <= t.reorder_level AS low_stock', from: 'stock_items t JOIN kitchens k ON k.id = t.kitchen_id',
  filters: { kitchen_id: 't.kitchen_id' }, search: ['t.name'], orderBy: 'k.name, t.name', scope: kitchenScoped, canAccessRow: checkKitchen,
  fields: {
    kitchen_id: { type: 'int', required: true, label: 'Kitchen' },
    name: { type: 'string', required: true, max: 120, label: 'Item name' },
    unit: { type: 'string', max: 20, default: 'kg' },
    reorder_level: { type: 'number', min: 0, default: 0 },
  },
});

router.get('/stock-items/:id(\\d+)/movements', requirePerm('catering.view'), wrap(async (req, res) => {
  const item = await db.one('SELECT kitchen_id FROM stock_items WHERE id = ?', [req.params.id]);
  if (!item) throw notFound('Stock item');
  assertKitchen(req.user, item.kitchen_id);
  res.json(await db.query(`SELECT m.*, u.name AS created_by_name FROM stock_movements m LEFT JOIN users u ON u.id = m.created_by
    WHERE m.stock_item_id = ? ORDER BY m.movement_date DESC, m.id DESC LIMIT 500`, [req.params.id]));
}));

// in = received, out = used, waste = thrown away, adjustment = stock count correction (+ or -)
router.post('/stock-items/:id(\\d+)/movements', requirePerm('kitchen.manage', 'catering.manage'), wrap(async (req, res) => {
  const { movement_type: type, quantity, movement_date: date, reference, notes } = req.body || {};
  if (!['in', 'out', 'waste', 'adjustment'].includes(type)) throw bad('Movement type must be in, out, waste or adjustment');
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty === 0 || (type !== 'adjustment' && qty < 0)) throw bad('Enter a valid quantity');
  const delta = type === 'in' || type === 'adjustment' ? qty : -qty;
  await db.tx(async (conn) => {
    const [[item]] = await conn.query('SELECT * FROM stock_items WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!item) throw notFound('Stock item');
    assertKitchen(req.user, item.kitchen_id);
    if (Number(item.quantity) + delta < 0) throw bad(`Not enough stock (currently ${item.quantity} ${item.unit})`);
    await conn.query('UPDATE stock_items SET quantity = quantity + ? WHERE id = ?', [delta, item.id]);
    await conn.query('INSERT INTO stock_movements (stock_item_id, movement_type, quantity, movement_date, reference, notes, created_by) VALUES (?,?,?,?,?,?,?)',
      [item.id, type, qty, isDate(date) ? date : today(), reference || null, notes || null, req.user.id]);
    await audit(req, 'stock_' + type, 'stock_item', item.id, { quantity: qty }, conn);
  });
  res.status(201).json(await db.one('SELECT * FROM stock_items WHERE id = ?', [req.params.id]));
}));

// ---------- Meal requirements ----------
// Rule from the requirements: Worker present + valid assignment + meal entitlement = meal required.
// Only validated attendance is counted.
async function computeRequirements(date) {
  return db.query(
    `SELECT a.site_id, me.meal_type, COUNT(*) AS qty
       FROM attendance a
       JOIN worker_assignments wa ON wa.id = a.assignment_id AND wa.status <> 'cancelled'
            AND wa.start_date <= a.work_date AND (wa.end_date IS NULL OR wa.end_date >= a.work_date)
       JOIN meal_entitlements me ON me.assignment_id = wa.id
      WHERE a.work_date = ? AND a.status = 'present' AND a.validated = 1
      GROUP BY a.site_id, me.meal_type`, [date]);
}

router.post('/catering/requirements/calculate', requirePerm('catering.manage'), wrap(async (req, res) => {
  const date = req.body.date || today();
  if (!isDate(date)) throw bad('Invalid date');
  const counts = await computeRequirements(date);
  const kitchens = await db.query('SELECT site_id, kitchen_id FROM site_kitchen_assignments WHERE start_date <= ? AND (end_date IS NULL OR end_date >= ?)', [date, date]);
  const kitchenOf = new Map(kitchens.map((k) => [k.site_id, k.kitchen_id]));
  await db.tx(async (conn) => {
    await conn.query('UPDATE meal_orders SET required_qty = 0, calculated_by = ? WHERE service_date = ?', [req.user.id, date]);
    for (const c of counts) {
      await conn.query(
        `INSERT INTO meal_orders (site_id, kitchen_id, service_date, meal_type, required_qty, calculated_by) VALUES (?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE kitchen_id = VALUES(kitchen_id), required_qty = VALUES(required_qty), calculated_by = VALUES(calculated_by)`,
        [c.site_id, kitchenOf.get(c.site_id) || null, date, c.meal_type, c.qty, req.user.id]);
    }
    await audit(req, 'calculate', 'meal_orders', date, { rows: counts.length }, conn);
  });
  res.json(await requirementsFor(req.user, date));
}));

async function requirementsFor(user, date) {
  const s = siteFilter(user, 'mo.site_id');
  const orders = await db.query(
    `SELECT mo.*, s.name AS site_name, p.name AS project_name, c.name AS client_name, k.name AS kitchen_name
       FROM meal_orders mo JOIN sites s ON s.id = mo.site_id JOIN projects p ON p.id = s.project_id JOIN clients c ON c.id = p.client_id
       LEFT JOIN kitchens k ON k.id = mo.kitchen_id
      WHERE mo.service_date = ? AND ${s.sql} ORDER BY c.name, p.name, s.name, mo.meal_type`, [date, ...s.params]);
  const s2 = siteFilter(user, 'a.site_id');
  const pending = await db.query(
    `SELECT a.site_id, s.name AS site_name, COUNT(*) AS present_not_validated FROM attendance a JOIN sites s ON s.id = a.site_id
      WHERE a.work_date = ? AND a.status = 'present' AND a.validated = 0 AND ${s2.sql} GROUP BY a.site_id, s.name`, [date, ...s2.params]);
  const byKitchen = {};
  for (const o of orders) {
    const key = o.kitchen_id || 0;
    byKitchen[key] = byKitchen[key] || { kitchen_id: o.kitchen_id, kitchen_name: o.kitchen_name || 'No kitchen assigned', lunch: 0, dinner: 0 };
    byKitchen[key][o.meal_type] += o.required_qty;
  }
  return { date, orders, by_kitchen: Object.values(byKitchen), pending_validation: pending };
}

router.get('/catering/requirements', requirePerm('catering.view'), wrap(async (req, res) => {
  const date = isDate(req.query.date) ? req.query.date : today();
  res.json(await requirementsFor(req.user, date));
}));

// ---------- Production plans ----------
router.post('/catering/plans/generate', requirePerm('catering.manage'), wrap(async (req, res) => {
  const date = req.body.date || today();
  if (!isDate(date)) throw bad('Invalid date');
  const totals = await db.query(
    `SELECT kitchen_id, meal_type, SUM(required_qty) AS qty FROM meal_orders
      WHERE service_date = ? AND kitchen_id IS NOT NULL GROUP BY kitchen_id, meal_type`, [date]);
  await db.tx(async (conn) => {
    await conn.query('UPDATE meal_plans SET required_qty = 0 WHERE service_date = ?', [date]);
    for (const t of totals) {
      await conn.query(
        `INSERT INTO meal_plans (kitchen_id, service_date, meal_type, required_qty, planned_qty, created_by) VALUES (?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE required_qty = VALUES(required_qty),
           planned_qty = IF(status = 'draft', VALUES(planned_qty), planned_qty)`,
        [t.kitchen_id, date, t.meal_type, t.qty, t.qty, req.user.id]);
    }
    await audit(req, 'generate', 'meal_plans', date, { rows: totals.length }, conn);
  });
  const unassigned = await db.query(
    `SELECT s.name AS site_name, mo.meal_type, mo.required_qty FROM meal_orders mo JOIN sites s ON s.id = mo.site_id
      WHERE mo.service_date = ? AND mo.kitchen_id IS NULL AND mo.required_qty > 0`, [date]);
  res.json({ plans: await plansFor(req.user, { date }), sites_without_kitchen: unassigned });
}));

async function plansFor(user, { date, kitchenId }) {
  const k = kitchenFilter(user, 'mp.kitchen_id');
  const where = ['mp.service_date = ?', k.sql]; const params = [date, ...k.params];
  if (kitchenId) { where.push('mp.kitchen_id = ?'); params.push(kitchenId); }
  return db.query(
    `SELECT mp.*, k.name AS kitchen_name, k.kitchen_type,
            COALESCE((SELECT SUM(produced_qty) FROM production_batches b WHERE b.meal_plan_id = mp.id), 0) AS produced_qty,
            COALESCE((SELECT SUM(rejected_qty) FROM production_batches b WHERE b.meal_plan_id = mp.id), 0) AS rejected_qty,
            COALESCE((SELECT SUM(dispatched_qty) FROM dispatches d WHERE d.meal_plan_id = mp.id), 0) AS dispatched_qty
       FROM meal_plans mp JOIN kitchens k ON k.id = mp.kitchen_id
      WHERE ${where.join(' AND ')} ORDER BY k.name, mp.meal_type`, params);
}

router.get('/catering/plans', requirePerm('catering.view'), wrap(async (req, res) => {
  const date = isDate(req.query.date) ? req.query.date : today();
  res.json(await plansFor(req.user, { date, kitchenId: req.query.kitchen_id }));
}));

async function getPlan(req, id) {
  const plan = await db.one('SELECT * FROM meal_plans WHERE id = ?', [id]);
  if (!plan) throw notFound('Meal plan');
  assertKitchen(req.user, plan.kitchen_id);
  return plan;
}

router.put('/catering/plans/:id(\\d+)', requirePerm('kitchen.manage', 'catering.manage'), wrap(async (req, res) => {
  const plan = await getPlan(req, req.params.id);
  const b = req.body || {};
  const planned = b.planned_qty === undefined ? plan.planned_qty : Number(b.planned_qty);
  if (!Number.isInteger(planned) || planned < 0) throw bad('Planned quantity must be a whole number');
  const status = b.status || plan.status;
  if (!['draft', 'confirmed', 'in_production', 'completed'].includes(status)) throw bad('Invalid status');
  await db.query('UPDATE meal_plans SET planned_qty = ?, menu = ?, status = ? WHERE id = ?', [planned, b.menu ?? plan.menu, status, plan.id]);
  await audit(req, 'update', 'meal_plan', plan.id, { planned_qty: planned, status, menu: b.menu });
  res.json(await db.one('SELECT * FROM meal_plans WHERE id = ?', [plan.id]));
}));

router.get('/catering/plans/:id(\\d+)/batches', requirePerm('catering.view'), wrap(async (req, res) => {
  await getPlan(req, req.params.id);
  res.json(await db.query('SELECT * FROM production_batches WHERE meal_plan_id = ? ORDER BY produced_at', [req.params.id]));
}));

router.post('/catering/plans/:id(\\d+)/batches', requirePerm('kitchen.manage'), wrap(async (req, res) => {
  const plan = await getPlan(req, req.params.id);
  const produced = Number(req.body.produced_qty || 0); const rejected = Number(req.body.rejected_qty || 0);
  if (!Number.isInteger(produced) || !Number.isInteger(rejected) || produced < 0 || rejected < 0) throw bad('Quantities must be whole numbers');
  if (rejected > produced) throw bad('Rejected/wasted cannot be more than produced');
  const r = await db.query('INSERT INTO production_batches (meal_plan_id, produced_qty, rejected_qty, produced_at, notes, recorded_by) VALUES (?,?,?,NOW(),?,?)',
    [plan.id, produced, rejected, req.body.notes || null, req.user.id]);
  if (plan.status === 'draft' || plan.status === 'confirmed') await db.query("UPDATE meal_plans SET status = 'in_production' WHERE id = ?", [plan.id]);
  await audit(req, 'create', 'production_batch', r.insertId, { meal_plan_id: plan.id, produced, rejected });
  res.status(201).json({ id: r.insertId });
}));

// ---------- Dispatch, receipt, distribution ----------
function dispatchScope(user) {
  // Kitchen managers limited to their kitchens see their dispatches; everyone else is limited by site.
  if (user.can('kitchen.manage') && user.kitchenIds !== null) return kitchenFilter(user, 'd.kitchen_id');
  return siteFilter(user, 'd.site_id');
}

router.get('/catering/dispatches', requirePerm('catering.view', 'meals.receive'), wrap(async (req, res) => {
  const s = dispatchScope(req.user);
  const where = [s.sql]; const params = [...s.params];
  if (isDate(req.query.date)) { where.push('d.service_date = ?'); params.push(req.query.date); }
  for (const k of ['site_id', 'kitchen_id']) if (req.query[k]) { where.push(`d.${k} = ?`); params.push(req.query[k]); }
  res.json(await db.query(
    `SELECT d.*, k.name AS kitchen_name, s.name AS site_name, del.received_qty, del.received_at, del.condition_notes
       FROM dispatches d JOIN kitchens k ON k.id = d.kitchen_id JOIN sites s ON s.id = d.site_id
       LEFT JOIN deliveries del ON del.dispatch_id = d.id
      WHERE ${where.join(' AND ')} ORDER BY d.service_date DESC, k.name, s.name LIMIT 1000`, params));
}));

router.post('/catering/dispatches', requirePerm('kitchen.manage'), wrap(async (req, res) => {
  const b = req.body || {};
  const qty = Number(b.dispatched_qty);
  if (!b.meal_plan_id || !b.site_id || !Number.isInteger(qty) || qty <= 0) throw bad('Meal plan, site and a quantity above 0 are required');
  const id = await db.tx(async (conn) => {
    const [[plan]] = await conn.query('SELECT * FROM meal_plans WHERE id = ? FOR UPDATE', [b.meal_plan_id]);
    if (!plan) throw notFound('Meal plan');
    assertKitchen(req.user, plan.kitchen_id);
    const [[t]] = await conn.query(
      `SELECT COALESCE((SELECT SUM(produced_qty - rejected_qty) FROM production_batches WHERE meal_plan_id = ?), 0) AS good,
              COALESCE((SELECT SUM(dispatched_qty) FROM dispatches WHERE meal_plan_id = ?), 0) AS sent`, [plan.id, plan.id]);
    const available = Number(t.good) - Number(t.sent);
    if (qty > available) throw bad(`Only ${available} good meals are available to dispatch for this plan`);
    const [r] = await conn.query(
      `INSERT INTO dispatches (meal_plan_id, kitchen_id, site_id, service_date, meal_type, dispatched_qty, status, vehicle, driver, dispatched_at, notes, recorded_by)
       VALUES (?,?,?,?,?,?, 'dispatched', ?,?, NOW(), ?, ?)`,
      [plan.id, plan.kitchen_id, b.site_id, plan.service_date, plan.meal_type, qty, b.vehicle || null, b.driver || null, b.notes || null, req.user.id]);
    await audit(req, 'create', 'dispatch', r.insertId, { meal_plan_id: plan.id, site_id: b.site_id, qty }, conn);
    return r.insertId;
  });
  res.status(201).json({ id });
}));

router.post('/catering/dispatches/:id(\\d+)/receive', requirePerm('meals.receive'), wrap(async (req, res) => {
  const qty = Number(req.body.received_qty);
  await db.tx(async (conn) => {
    const [[d]] = await conn.query('SELECT * FROM dispatches WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!d) throw notFound('Dispatch');
    assertSite(req.user, d.site_id);
    if (d.status === 'received') throw bad('This delivery has already been confirmed');
    if (!Number.isInteger(qty) || qty < 0 || qty > d.dispatched_qty) throw bad(`Received quantity must be between 0 and ${d.dispatched_qty}`);
    await conn.query('INSERT INTO deliveries (dispatch_id, received_qty, received_at, received_by, condition_notes) VALUES (?,?,NOW(),?,?)',
      [d.id, qty, req.user.id, req.body.condition_notes || null]);
    await conn.query("UPDATE dispatches SET status = 'received' WHERE id = ?", [d.id]);
    await audit(req, 'receive', 'dispatch', d.id, { received_qty: qty }, conn);
  });
  res.json({ ok: true });
}));

router.get('/catering/distributions', requirePerm('catering.view', 'meals.receive'), wrap(async (req, res) => {
  const s = siteFilter(req.user, 'md.site_id');
  const where = [s.sql]; const params = [...s.params];
  if (isDate(req.query.date)) { where.push('md.service_date = ?'); params.push(req.query.date); }
  if (req.query.site_id) { where.push('md.site_id = ?'); params.push(req.query.site_id); }
  res.json(await db.query(`SELECT md.*, s.name AS site_name FROM meal_distributions md JOIN sites s ON s.id = md.site_id
    WHERE ${where.join(' AND ')} ORDER BY md.service_date DESC, s.name LIMIT 1000`, params));
}));

router.post('/catering/distributions', requirePerm('meals.receive'), wrap(async (req, res) => {
  const { site_id: siteId, service_date: date, meal_type: meal, notes } = req.body || {};
  const qty = Number(req.body.distributed_qty);
  if (!siteId || !isDate(date) || !MEALS.includes(meal) || !Number.isInteger(qty) || qty <= 0) throw bad('Site, date, meal and a quantity above 0 are required');
  assertSite(req.user, siteId);
  const id = await db.tx(async (conn) => {
    const [[rec]] = await conn.query(
      `SELECT COALESCE(SUM(del.received_qty), 0) AS received FROM deliveries del JOIN dispatches d ON d.id = del.dispatch_id
        WHERE d.site_id = ? AND d.service_date = ? AND d.meal_type = ?`, [siteId, date, meal]);
    const [given] = await conn.query(
      'SELECT distributed_qty FROM meal_distributions WHERE site_id = ? AND service_date = ? AND meal_type = ? FOR UPDATE', [siteId, date, meal]);
    const t = { received: rec.received, given: given.reduce((n, g) => n + g.distributed_qty, 0) };
    const left = Number(t.received) - Number(t.given);
    if (qty > left) throw bad(`Only ${left} received meals are left to distribute`);
    const [r] = await conn.query('INSERT INTO meal_distributions (site_id, service_date, meal_type, distributed_qty, notes, recorded_by) VALUES (?,?,?,?,?,?)',
      [siteId, date, meal, qty, notes || null, req.user.id]);
    await audit(req, 'create', 'meal_distribution', r.insertId, { site_id: siteId, date, meal, qty }, conn);
    return r.insertId;
  });
  res.status(201).json({ id });
}));

// Full traceability: Required -> Produced -> Dispatched -> Received -> Distributed -> Remaining
router.get('/catering/traceability', requirePerm('catering.view', 'meals.receive'), wrap(async (req, res) => {
  const date = isDate(req.query.date) ? req.query.date : today();
  const s = siteFilter(req.user, 's.id');
  const sites = await db.query(
    `SELECT s.id AS site_id, s.name AS site_name, p.name AS project_name, c.name AS client_name, m.meal_type,
            COALESCE((SELECT required_qty FROM meal_orders mo WHERE mo.site_id = s.id AND mo.service_date = ? AND mo.meal_type = m.meal_type), 0) AS required,
            COALESCE((SELECT SUM(dispatched_qty) FROM dispatches d WHERE d.site_id = s.id AND d.service_date = ? AND d.meal_type = m.meal_type), 0) AS dispatched,
            COALESCE((SELECT SUM(del.received_qty) FROM deliveries del JOIN dispatches d ON d.id = del.dispatch_id
                       WHERE d.site_id = s.id AND d.service_date = ? AND d.meal_type = m.meal_type), 0) AS received,
            COALESCE((SELECT SUM(distributed_qty) FROM meal_distributions md WHERE md.site_id = s.id AND md.service_date = ? AND md.meal_type = m.meal_type), 0) AS distributed
       FROM sites s JOIN projects p ON p.id = s.project_id JOIN clients c ON c.id = p.client_id
       CROSS JOIN (SELECT 'lunch' AS meal_type UNION ALL SELECT 'dinner') m
      WHERE ${s.sql}
      ORDER BY c.name, p.name, s.name, m.meal_type`, [date, date, date, date, ...s.params]);
  const siteRows = sites
    .map((r) => ({ ...r, remaining: Number(r.received) - Number(r.distributed) }))
    .filter((r) => r.required || r.dispatched || r.received || r.distributed);
  const kitchens = req.user.can('catering.view') ? (await plansFor(req.user, { date })).map((p) => ({
    kitchen_id: p.kitchen_id, kitchen_name: p.kitchen_name, meal_type: p.meal_type, required: p.required_qty, planned: p.planned_qty,
    produced: Number(p.produced_qty), rejected: Number(p.rejected_qty), dispatched: Number(p.dispatched_qty),
    remaining_at_kitchen: Number(p.produced_qty) - Number(p.rejected_qty) - Number(p.dispatched_qty), status: p.status,
  })) : [];
  res.json({ date, sites: siteRows, kitchens });
}));

module.exports = router;
