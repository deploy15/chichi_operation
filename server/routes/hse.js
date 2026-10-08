// Health, Safety & Environment: incident reports, corrective actions, photos/documents, HSE dashboard.
const express = require('express');
const db = require('../lib/db');
const { clean } = require('../lib/crud');
const { audit } = require('../lib/audit');
const { requirePerm, siteFilter, assertSite } = require('../lib/auth');
const { wrap, bad, notFound } = require('../lib/http');

const router = express.Router();
const TYPES = ['injury', 'near_miss', 'property_damage', 'environmental', 'fire', 'vehicle', 'security', 'illness', 'other'];
const SEVERITY = ['low', 'medium', 'high', 'critical'];

const FIELDS = {
  occurred_at: { type: 'datetime', required: true, label: 'Date and time' },
  site_id: { type: 'int', required: true, label: 'Site' },
  location: { type: 'string', max: 200 },
  person_worker_id: { type: 'int' },
  person_name: { type: 'string', max: 150 },
  incident_type: { type: 'enum', values: TYPES, required: true, label: 'Incident type' },
  description: { type: 'string', required: true, max: 10000, label: 'Description' },
  severity: { type: 'enum', values: SEVERITY, required: true, label: 'Severity' },
  witnesses: { type: 'string', max: 5000 },
  immediate_actions: { type: 'string', max: 5000 },
};

const SELECT = `SELECT i.*, s.name AS site_name, p.name AS project_name, c.name AS client_name, u.name AS reported_by_name,
  CONCAT(w.first_name, ' ', w.last_name) AS person_worker_name,
  (SELECT COUNT(*) FROM hse_corrective_actions a WHERE a.incident_id = i.id AND a.status <> 'done') AS open_actions,
  (SELECT COUNT(*) FROM hse_corrective_actions a WHERE a.incident_id = i.id AND a.status <> 'done' AND a.due_date < CURDATE()) AS overdue_actions
  FROM hse_incidents i JOIN sites s ON s.id = i.site_id JOIN projects p ON p.id = i.project_id JOIN clients c ON c.id = i.client_id
  LEFT JOIN users u ON u.id = i.reported_by LEFT JOIN workers w ON w.id = i.person_worker_id`;

router.get('/hse/incidents', requirePerm('hse.view', 'hse.report'), wrap(async (req, res) => {
  const s = siteFilter(req.user, 'i.site_id');
  const where = [s.sql]; const params = [...s.params];
  for (const k of ['status', 'severity', 'site_id', 'project_id', 'client_id', 'incident_type']) {
    if (req.query[k]) { where.push(`i.${k} = ?`); params.push(req.query[k]); }
  }
  // Reporters without hse.view only see what they reported
  if (!req.user.can('hse.view')) { where.push('i.reported_by = ?'); params.push(req.user.id); }
  res.json(await db.query(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY i.occurred_at DESC LIMIT 2000`, params));
}));

async function visibleIncident(req, id) {
  const i = await db.one(`${SELECT} WHERE i.id = ?`, [id]);
  if (!i) throw notFound('Incident');
  assertSite(req.user, i.site_id);
  if (!req.user.can('hse.view') && i.reported_by !== req.user.id) throw notFound('Incident');
  return i;
}

router.get('/hse/incidents/:id(\\d+)', requirePerm('hse.view', 'hse.report'), wrap(async (req, res) => {
  const i = await visibleIncident(req, req.params.id);
  i.actions = await db.query('SELECT * FROM hse_corrective_actions WHERE incident_id = ? ORDER BY due_date', [i.id]);
  i.attachments = await db.query('SELECT id, file_name, file_mime, file_size, created_at FROM hse_attachments WHERE incident_id = ? ORDER BY id', [i.id]);
  res.json(i);
}));

// Client and project are filled in from the site automatically (entered once, reused).
router.post('/hse/incidents', requirePerm('hse.report'), wrap(async (req, res) => {
  const data = clean(FIELDS, req.body || {}, { partial: false });
  assertSite(req.user, data.site_id);
  const site = await db.one('SELECT s.project_id, p.client_id FROM sites s JOIN projects p ON p.id = s.project_id WHERE s.id = ?', [data.site_id]);
  if (!site) throw bad('Site not found');
  Object.assign(data, { project_id: site.project_id, client_id: site.client_id, reported_by: req.user.id });
  const cols = Object.keys(data);
  const r = await db.query(`INSERT INTO hse_incidents (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, cols.map((c) => data[c]));
  await audit(req, 'create', 'hse_incident', r.insertId, { site_id: data.site_id, severity: data.severity, incident_type: data.incident_type });
  res.status(201).json(await db.one(`${SELECT} WHERE i.id = ?`, [r.insertId]));
}));

router.put('/hse/incidents/:id(\\d+)', requirePerm('hse.manage'), wrap(async (req, res) => {
  const i = await visibleIncident(req, req.params.id);
  const data = clean({ ...FIELDS, status: { type: 'enum', values: ['open', 'under_investigation', 'closed'] } }, req.body || {}, { partial: true });
  if (data.site_id && data.site_id !== i.site_id) {
    assertSite(req.user, data.site_id);
    const site = await db.one('SELECT s.project_id, p.client_id FROM sites s JOIN projects p ON p.id = s.project_id WHERE s.id = ?', [data.site_id]);
    Object.assign(data, { project_id: site.project_id, client_id: site.client_id });
  }
  if (data.status === 'closed' && i.status !== 'closed') data.closed_at = new Date().toISOString().slice(0, 19).replace('T', ' ');
  if (data.status && data.status !== 'closed') data.closed_at = null;
  const cols = Object.keys(data);
  if (cols.length) await db.query(`UPDATE hse_incidents SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => data[c]), i.id]);
  await audit(req, 'update', 'hse_incident', i.id, data);
  res.json(await db.one(`${SELECT} WHERE i.id = ?`, [i.id]));
}));

router.post('/hse/incidents/:id(\\d+)/actions', requirePerm('hse.manage'), wrap(async (req, res) => {
  const i = await visibleIncident(req, req.params.id);
  const data = clean({
    description: { type: 'string', required: true, max: 500, label: 'Action' },
    responsible_name: { type: 'string', required: true, max: 150, label: 'Person responsible' },
    due_date: { type: 'date', required: true, label: 'Due date' },
  }, req.body || {}, { partial: false });
  const r = await db.query('INSERT INTO hse_corrective_actions (incident_id, description, responsible_name, due_date, created_by) VALUES (?,?,?,?,?)',
    [i.id, data.description, data.responsible_name, data.due_date, req.user.id]);
  await audit(req, 'create', 'hse_action', r.insertId, data);
  res.status(201).json({ id: r.insertId });
}));

router.put('/hse/actions/:id(\\d+)', requirePerm('hse.manage'), wrap(async (req, res) => {
  const a = await db.one('SELECT * FROM hse_corrective_actions WHERE id = ?', [req.params.id]);
  if (!a) throw notFound('Action');
  await visibleIncident(req, a.incident_id);
  const data = clean({
    description: { type: 'string', max: 500 }, responsible_name: { type: 'string', max: 150 }, due_date: { type: 'date' },
    status: { type: 'enum', values: ['open', 'in_progress', 'done'] },
  }, req.body || {}, { partial: true });
  if (data.status === 'done' && a.status !== 'done') data.completed_at = new Date().toISOString().slice(0, 19).replace('T', ' ');
  if (data.status && data.status !== 'done') data.completed_at = null;
  const cols = Object.keys(data);
  if (cols.length) await db.query(`UPDATE hse_corrective_actions SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => data[c]), a.id]);
  await audit(req, 'update', 'hse_action', a.id, data);
  res.json(await db.one('SELECT * FROM hse_corrective_actions WHERE id = ?', [a.id]));
}));

router.post('/hse/incidents/:id(\\d+)/attachments', requirePerm('hse.report', 'hse.manage'), wrap(async (req, res) => {
  const i = await visibleIncident(req, req.params.id);
  const { file_base64: data, file_name: name, file_mime: mime } = req.body || {};
  if (!data || !name) throw bad('File is required');
  const buf = Buffer.from(data, 'base64');
  if (buf.length > 5 * 1024 * 1024) throw bad('File is too large (max 5 MB)');
  const r = await db.query('INSERT INTO hse_attachments (incident_id, file_name, file_mime, file_size, file_data, uploaded_by) VALUES (?,?,?,?,?,?)',
    [i.id, name, mime || 'application/octet-stream', buf.length, buf, req.user.id]);
  await audit(req, 'upload', 'hse_incident', i.id, { file_name: name });
  res.status(201).json({ id: r.insertId });
}));

router.get('/hse/attachments/:id(\\d+)', requirePerm('hse.view', 'hse.report'), wrap(async (req, res) => {
  const f = await db.one('SELECT * FROM hse_attachments WHERE id = ?', [req.params.id]);
  if (!f) throw notFound('File');
  await visibleIncident(req, f.incident_id);
  res.setHeader('Content-Type', f.file_mime);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(f.file_name)}"`);
  res.send(f.file_data);
}));

router.get('/hse/dashboard', requirePerm('hse.view'), wrap(async (req, res) => {
  const s = siteFilter(req.user, 'i.site_id');
  const W = `WHERE ${s.sql}`;
  const P = s.params;
  const [counts] = await Promise.all([db.one(
    `SELECT SUM(i.status <> 'closed') AS open_incidents, SUM(i.status = 'closed') AS closed_incidents, COUNT(*) AS total FROM hse_incidents i ${W}`, P)]);
  res.json({
    open_incidents: Number(counts.open_incidents || 0),
    closed_incidents: Number(counts.closed_incidents || 0),
    total: Number(counts.total || 0),
    by_site: await db.query(`SELECT s.name AS label, COUNT(*) AS value, SUM(i.status <> 'closed') AS open FROM hse_incidents i JOIN sites s ON s.id = i.site_id ${W} GROUP BY s.id, s.name ORDER BY value DESC`, P),
    by_project: await db.query(`SELECT p.name AS label, COUNT(*) AS value, SUM(i.status <> 'closed') AS open FROM hse_incidents i JOIN projects p ON p.id = i.project_id ${W} GROUP BY p.id, p.name ORDER BY value DESC`, P),
    by_severity: await db.query(`SELECT i.severity AS label, COUNT(*) AS value FROM hse_incidents i ${W} GROUP BY i.severity ORDER BY FIELD(i.severity, 'critical','high','medium','low')`, P),
    by_type: await db.query(`SELECT i.incident_type AS label, COUNT(*) AS value FROM hse_incidents i ${W} GROUP BY i.incident_type ORDER BY value DESC`, P),
    trend: await db.query(`SELECT DATE_FORMAT(i.occurred_at, '%Y-%m') AS label, COUNT(*) AS value FROM hse_incidents i ${W}
      AND i.occurred_at >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH) GROUP BY label ORDER BY label`, P),
    overdue_actions: await db.query(`SELECT a.*, s.name AS site_name, i.incident_type, i.occurred_at FROM hse_corrective_actions a
      JOIN hse_incidents i ON i.id = a.incident_id JOIN sites s ON s.id = i.site_id ${W} AND a.status <> 'done' AND a.due_date < CURDATE() ORDER BY a.due_date`, P),
  });
}));

module.exports = router;
