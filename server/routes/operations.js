// Day-to-day records from kitchen, sealing and transport teams, plus feedback from sites.
// Each log type can only be recorded by the role it belongs to.
const express = require('express');
const db = require('../lib/db');
const { audit } = require('../lib/audit');
const { requirePerm, siteFilter, kitchenFilter, assertSite, assertKitchen } = require('../lib/auth');
const { wrap, bad, notFound, forbidden, isDate, today } = require('../lib/http');

const router = express.Router();

// log type -> [permission needed, needs a kitchen, needs a site]
const TYPES = {
  // Sous-chefs
  ingredient_prep: ['kitchen.produce', true, false, 'Ingredient preparation'],
  meals_portioned: ['kitchen.produce', true, false, 'Meals portioned'],
  handover: ['kitchen.produce', true, false, 'Meals handed over to sealing/transport'],
  shortage: ['kitchen.produce', true, false, 'Shortage'],
  kitchen_delay: ['kitchen.produce', true, false, 'Delay in the kitchen'],
  quality_issue: ['kitchen.produce', true, false, 'Quality issue'],
  // Dishwashing, sealing and transport team
  cleaning: ['ops.log', true, false, 'Cleaning task done'],
  equipment_damage: ['ops.log', true, false, 'Damaged equipment'],
  portions_checked: ['ops.log', true, false, 'Portion quantities confirmed'],
  packaging_done: ['ops.log', true, false, 'Packaging completed'],
  labelled: ['ops.log', true, true, 'Meals labelled for site'],
  transport_delay: ['ops.log', true, false, 'Delivery delay'],
  transport_loss: ['ops.log', true, false, 'Meals lost in transport'],
  damaged_packaging: ['ops.log', true, false, 'Damaged packaging'],
  // Anyone allowed to report on stock (cannot change stock levels)
  stock_report: ['stock.report', true, false, 'Stock report (shortage or loss)'],
  // Site Administrators
  site_delay: ['catering.feedback', false, true, 'Meals arrived late'],
  site_complaint: ['catering.feedback', false, true, 'Complaint about meals'],
};

function scope(user) {
  // Catering management sees everything; kitchen staff see their kitchen; sites see their own feedback
  if (user.can('catering.view')) return { sql: '1=1', params: [] };
  const parts = []; const params = [];
  if (user.can('kitchen.view') || user.can('stock.report')) { const k = kitchenFilter(user, 'l.kitchen_id'); parts.push(k.sql); params.push(...k.params); }
  if (user.can('catering.feedback')) { const s = siteFilter(user, 'l.site_id'); parts.push(`(l.kitchen_id IS NULL AND ${s.sql})`); params.push(...s.params); }
  if (!parts.length) return { sql: '1=0', params: [] };
  return { sql: `(${parts.join(' OR ')})`, params };
}

router.get('/operations/types', (req, res) => {
  res.json(Object.entries(TYPES).filter(([, t]) => req.user.can(t[0]))
    .map(([key, t]) => ({ key, label: t[3], needs_kitchen: t[1], needs_site: t[2] })));
});

router.get('/operations/logs', requirePerm('catering.view', 'kitchen.view', 'ops.log', 'stock.report', 'catering.feedback'), wrap(async (req, res) => {
  const s = scope(req.user);
  const where = [s.sql]; const params = [...s.params];
  if (isDate(req.query.date)) { where.push('l.log_date = ?'); params.push(req.query.date); }
  for (const k of ['kitchen_id', 'site_id', 'log_type', 'status']) if (req.query[k]) { where.push(`l.${k} = ?`); params.push(req.query[k]); }
  if (req.query.group === 'feedback') where.push("l.log_type IN ('site_delay','site_complaint')");
  const rows = await db.query(
    `SELECT l.*, k.name AS kitchen_name, s.name AS site_name, si.name AS stock_item_name, u.name AS recorded_by_name, h.name AS handled_by_name
       FROM operation_logs l LEFT JOIN kitchens k ON k.id = l.kitchen_id LEFT JOIN sites s ON s.id = l.site_id
       LEFT JOIN stock_items si ON si.id = l.stock_item_id LEFT JOIN users u ON u.id = l.recorded_by LEFT JOIN users h ON h.id = l.handled_by
      WHERE ${where.join(' AND ')} ORDER BY l.created_at DESC LIMIT 1000`, params);
  res.json(rows.map((r) => ({ ...r, type_label: TYPES[r.log_type] ? TYPES[r.log_type][3] : r.log_type })));
}));

router.post('/operations/logs', wrap(async (req, res) => {
  const b = req.body || {};
  const t = TYPES[b.log_type];
  if (!t) throw bad('Unknown record type');
  if (!req.user.can(t[0])) throw forbidden('Your role cannot record this');
  if (t[1] && !b.kitchen_id) throw bad('Kitchen is required');
  if (t[2] && !b.site_id) throw bad('Site is required');
  if (b.kitchen_id) assertKitchen(req.user, b.kitchen_id);
  if (b.site_id && b.log_type.startsWith('site_')) assertSite(req.user, b.site_id);
  if (b.log_type === 'stock_report') {
    if (!b.stock_item_id) throw bad('Choose the stock item');
    const item = await db.one('SELECT kitchen_id FROM stock_items WHERE id = ?', [b.stock_item_id]);
    if (!item || item.kitchen_id !== Number(b.kitchen_id)) throw bad('This stock item does not belong to that kitchen');
  }
  if (b.dispatch_id) {
    const d = await db.one('SELECT kitchen_id, site_id FROM dispatches WHERE id = ?', [b.dispatch_id]);
    if (!d) throw bad('Delivery not found');
    if (b.kitchen_id && d.kitchen_id !== Number(b.kitchen_id)) throw bad('This delivery is not from that kitchen');
  }
  const qty = b.quantity === undefined || b.quantity === '' || b.quantity === null ? null : Number(b.quantity);
  if (qty !== null && (!Number.isFinite(qty) || qty < 0)) throw bad('Quantity must be 0 or more');
  const r = await db.query(
    `INSERT INTO operation_logs (log_type, kitchen_id, site_id, meal_plan_id, dispatch_id, stock_item_id, quantity, description, log_date, recorded_by)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [b.log_type, b.kitchen_id || null, b.site_id || null, b.meal_plan_id || null, b.dispatch_id || null, b.stock_item_id || null, qty,
      b.description ? String(b.description).slice(0, 1000) : null, isDate(b.log_date) ? b.log_date : today(), req.user.id]);
  await audit(req, 'create', 'operation_log', r.insertId, { log_type: b.log_type, quantity: qty });
  res.status(201).json({ id: r.insertId });
}));

// Catering Director acknowledges or closes a report (e.g. site feedback, shortages)
router.post('/operations/logs/:id(\\d+)/respond', requirePerm('catering.manage'), wrap(async (req, res) => {
  const l = await db.one('SELECT * FROM operation_logs WHERE id = ?', [req.params.id]);
  if (!l) throw notFound('Record');
  const status = req.body.status;
  if (!['acknowledged', 'closed'].includes(status)) throw bad('Status must be acknowledged or closed');
  await db.query('UPDATE operation_logs SET status = ?, response = ?, handled_by = ?, handled_at = NOW() WHERE id = ?',
    [status, req.body.response || l.response, req.user.id, l.id]);
  await audit(req, 'respond', 'operation_log', l.id, { status, response: req.body.response });
  res.json({ ok: true });
}));

module.exports = router;
