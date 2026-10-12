// Purchase requests: the Catering Director requests, the DAF approves; above the major-expense
// limit (Settings) only the Managing Director can approve.
const express = require('express');
const db = require('../lib/db');
const { audit } = require('../lib/audit');
const { requirePerm, assertKitchen } = require('../lib/auth');
const { getSettings } = require('../lib/settings');
const { wrap, bad, notFound, forbidden, isDate } = require('../lib/http');

const router = express.Router();
const SELECT = `SELECT r.*, k.name AS kitchen_name, u.name AS requested_by_name, d.name AS decided_by_name,
  (SELECT COALESCE(SUM(e.amount), 0) FROM catering_expenses e WHERE e.purchase_request_id = r.id) AS invoiced_amount
  FROM purchase_requests r LEFT JOIN kitchens k ON k.id = r.kitchen_id LEFT JOIN users u ON u.id = r.requested_by LEFT JOIN users d ON d.id = r.decided_by`;

router.get('/purchases', requirePerm('purchases.request', 'purchases.approve', 'approvals.major', 'finance.view'), wrap(async (req, res) => {
  const where = ['1=1']; const params = [];
  if (req.query.status) { where.push('r.status = ?'); params.push(req.query.status); }
  if (req.query.awaiting_me === '1') {
    where.push("r.status = 'submitted'");
    if (!req.user.can('approvals.major')) where.push('r.requires_major_approval = 0');
  }
  res.json(await db.query(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY r.status = 'submitted' DESC, r.created_at DESC LIMIT 1000`, params));
}));

router.post('/purchases', requirePerm('purchases.request'), wrap(async (req, res) => {
  const b = req.body || {};
  const amount = Number(b.estimated_amount);
  if (!b.items || !Number.isFinite(amount) || amount <= 0) throw bad('Items and an estimated amount above 0 are required');
  if (b.kitchen_id) assertKitchen(req.user, b.kitchen_id);
  const settings = await getSettings();
  const major = amount > Number(settings.major_expense_threshold || Infinity) ? 1 : 0;
  const r = await db.query(
    `INSERT INTO purchase_requests (kitchen_id, items, supplier, estimated_amount, needed_by, justification, requires_major_approval, requested_by)
     VALUES (?,?,?,?,?,?,?,?)`,
    [b.kitchen_id || null, String(b.items).slice(0, 5000), b.supplier || null, amount, isDate(b.needed_by) ? b.needed_by : null, b.justification || null, major, req.user.id]);
  await audit(req, 'create', 'purchase_request', r.insertId, { amount, major });
  res.status(201).json(await db.one(`${SELECT} WHERE r.id = ?`, [r.insertId]));
}));

router.post('/purchases/:id(\\d+)/decision', requirePerm('purchases.approve', 'approvals.major'), wrap(async (req, res) => {
  const p = await db.one('SELECT * FROM purchase_requests WHERE id = ?', [req.params.id]);
  if (!p) throw notFound('Purchase request');
  if (p.status !== 'submitted') throw bad('A decision has already been made');
  if (p.requires_major_approval && !req.user.can('approvals.major')) throw forbidden('This is a major purchase: only the Managing Director can approve it');
  if (!p.requires_major_approval && !req.user.can('purchases.approve') && !req.user.can('approvals.major')) throw forbidden();
  if (p.requested_by === req.user.id && !req.user.can('approvals.major')) throw forbidden('You cannot approve your own request');
  const decision = req.body.decision;
  if (!['approved', 'rejected'].includes(decision)) throw bad('Decision must be approved or rejected');
  await db.query('UPDATE purchase_requests SET status = ?, decision_notes = ?, decided_by = ?, decided_at = NOW() WHERE id = ?', [decision, req.body.notes || null, req.user.id, p.id]);
  await audit(req, decision, 'purchase_request', p.id, { notes: req.body.notes });
  res.json({ ok: true });
}));

router.post('/purchases/:id(\\d+)/cancel', requirePerm('purchases.request'), wrap(async (req, res) => {
  const p = await db.one('SELECT * FROM purchase_requests WHERE id = ?', [req.params.id]);
  if (!p) throw notFound('Purchase request');
  if (p.status !== 'submitted') throw bad('Only requests waiting for a decision can be cancelled');
  if (p.requested_by !== req.user.id) throw forbidden('Only the person who made the request can cancel it');
  await db.query("UPDATE purchase_requests SET status = 'cancelled' WHERE id = ?", [p.id]);
  await audit(req, 'cancel', 'purchase_request', p.id);
  res.json({ ok: true });
}));

module.exports = router;
