// Client staffing requests: received at the site, forwarded to the Recruitment Manager, then filled.
const express = require('express');
const db = require('../lib/db');
const { audit } = require('../lib/audit');
const { requirePerm, siteFilter, assertSite } = require('../lib/auth');
const { wrap, bad, notFound, forbidden, isDate } = require('../lib/http');

const router = express.Router();

const SELECT = `SELECT r.*, s.name AS site_name, p.name AS project_name, c.name AS client_name, u.name AS received_by_name, h.name AS handled_by_name,
  (SELECT COUNT(*) FROM worker_assignments wa WHERE wa.staffing_request_id = r.id AND wa.status <> 'cancelled') AS workers_assigned
  FROM staffing_requests r JOIN sites s ON s.id = r.site_id JOIN projects p ON p.id = s.project_id JOIN clients c ON c.id = p.client_id
  LEFT JOIN users u ON u.id = r.received_by LEFT JOIN users h ON h.id = r.handled_by`;

router.get('/staffing-requests', requirePerm('staffing.request', 'staffing.manage'), wrap(async (req, res) => {
  const s = siteFilter(req.user, 'r.site_id');
  const where = [s.sql]; const params = [...s.params];
  // Recruitment only sees requests once the site has forwarded them
  if (!req.user.can('staffing.request')) where.push("r.status <> 'received'");
  if (req.query.status) { where.push('r.status = ?'); params.push(req.query.status); }
  res.json(await db.query(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY FIELD(r.status,'forwarded','in_progress','received','filled','cancelled'), r.needed_from LIMIT 1000`, params));
}));

router.post('/staffing-requests', requirePerm('staffing.request'), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.site_id || !b.job_position || !isDate(b.needed_from)) throw bad('Site, position and start date are required');
  const qty = Number(b.quantity || 1);
  if (!Number.isInteger(qty) || qty < 1) throw bad('Number of workers must be at least 1');
  assertSite(req.user, b.site_id);
  const r = await db.query(
    `INSERT INTO staffing_requests (site_id, requested_by_client, job_position, quantity, needed_from, needed_until, details, status, forwarded_at, received_by)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [b.site_id, b.requested_by_client || null, b.job_position, qty, b.needed_from, isDate(b.needed_until) ? b.needed_until : null, b.details || null,
      b.forward ? 'forwarded' : 'received', b.forward ? new Date() : null, req.user.id]);
  await audit(req, 'create', 'staffing_request', r.insertId, b);
  res.status(201).json(await db.one(`${SELECT} WHERE r.id = ?`, [r.insertId]));
}));

router.post('/staffing-requests/:id(\\d+)/forward', requirePerm('staffing.request'), wrap(async (req, res) => {
  const r = await db.one('SELECT * FROM staffing_requests WHERE id = ?', [req.params.id]);
  if (!r) throw notFound('Request');
  assertSite(req.user, r.site_id);
  if (r.status !== 'received') throw bad('This request has already been forwarded');
  await db.query("UPDATE staffing_requests SET status = 'forwarded', forwarded_at = NOW() WHERE id = ?", [r.id]);
  await audit(req, 'forward', 'staffing_request', r.id);
  res.json({ ok: true });
}));

// Recruitment Manager updates progress
router.post('/staffing-requests/:id(\\d+)/status', requirePerm('staffing.manage'), wrap(async (req, res) => {
  const r = await db.one('SELECT * FROM staffing_requests WHERE id = ?', [req.params.id]);
  if (!r) throw notFound('Request');
  if (r.status === 'received') throw forbidden('The site has not forwarded this request yet');
  const status = req.body.status;
  if (!['in_progress', 'filled', 'cancelled'].includes(status)) throw bad('Status must be in progress, filled or cancelled');
  await db.query('UPDATE staffing_requests SET status = ?, response_notes = ?, handled_by = ? WHERE id = ?', [status, req.body.response_notes ?? r.response_notes, req.user.id, r.id]);
  await audit(req, 'status', 'staffing_request', r.id, { status });
  res.json({ ok: true });
}));

module.exports = router;
