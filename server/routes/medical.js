// Medical follow-up. Confidential: only roles with medical.view / medical.manage can reach any of
// these routes, and every time a record is opened it is written to the audit log.
const express = require('express');
const db = require('../lib/db');
const { crud } = require('../lib/crud');
const { audit } = require('../lib/audit');
const { requirePerm } = require('../lib/auth');
const { wrap, bad, notFound } = require('../lib/http');

const router = express.Router();
router.use('/medical', requirePerm('medical.view', 'medical.manage'));

// Log every read of an individual record
router.get('/medical/records/:id(\\d+)', (req, res, next) => { audit(req, 'view', 'medical_record', req.params.id); next(); });

crud(router, '/medical/records', {
  table: 'medical_records', entity: 'medical_record', view: ['medical.view'], manage: ['medical.manage'],
  select: `t.id, t.worker_id, t.record_type, t.record_date, t.title, t.provider, t.fitness_result, t.restriction_details, t.valid_until,
           t.status, t.hse_incident_id, t.notes, t.file_name, t.file_mime, t.file_data IS NOT NULL AS has_file, t.created_at, t.updated_at,
           CONCAT(w.first_name, ' ', w.last_name) AS worker_name, w.worker_code`,
  from: 'medical_records t JOIN workers w ON w.id = t.worker_id',
  filters: { worker_id: 't.worker_id', record_type: 't.record_type', status: 't.status' },
  search: ['w.first_name', 'w.last_name', 'w.worker_code', 't.title'], orderBy: 't.record_date DESC, t.id DESC',
  fields: {
    worker_id: { type: 'int', required: true, label: 'Worker' },
    record_type: { type: 'enum', required: true, values: ['examination', 'appointment', 'fitness', 'restriction', 'certificate', 'incident_followup'], label: 'Type' },
    record_date: { type: 'date', required: true, label: 'Date' },
    title: { type: 'string', required: true, max: 150, label: 'Title' },
    provider: { type: 'string', max: 150 },
    fitness_result: { type: 'enum', values: ['fit', 'fit_with_restrictions', 'unfit', 'pending'] },
    restriction_details: { type: 'string', max: 500 },
    valid_until: { type: 'date' },
    status: { type: 'enum', values: ['scheduled', 'completed', 'cancelled', 'open', 'closed'], default: 'completed' },
    hse_incident_id: { type: 'int' },
    notes: { type: 'string', max: 5000 },
  },
});

router.post('/medical/records/:id(\\d+)/file', requirePerm('medical.manage'), wrap(async (req, res) => {
  const { file_base64: data, file_name: name, file_mime: mime } = req.body || {};
  if (!data || !name) throw bad('File is required');
  const buf = Buffer.from(data, 'base64');
  if (buf.length > 5 * 1024 * 1024) throw bad('File is too large (max 5 MB)');
  const r = await db.query('UPDATE medical_records SET file_name = ?, file_mime = ?, file_data = ? WHERE id = ?', [name, mime || 'application/octet-stream', buf, req.params.id]);
  if (!r.affectedRows) throw notFound('Medical record');
  await audit(req, 'upload', 'medical_record', req.params.id, { file_name: name });
  res.json({ ok: true });
}));

router.get('/medical/records/:id(\\d+)/file', requirePerm('medical.view'), wrap(async (req, res) => {
  const r = await db.one('SELECT file_name, file_mime, file_data FROM medical_records WHERE id = ?', [req.params.id]);
  if (!r || !r.file_data) throw notFound('File');
  await audit(req, 'download', 'medical_record', req.params.id);
  res.setHeader('Content-Type', r.file_mime);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(r.file_name)}"`);
  res.send(r.file_data);
}));

// What needs attention: upcoming appointments, clearances expiring soon, unfit/restricted workers, open follow-ups
router.get('/medical/summary', requirePerm('medical.view'), wrap(async (req, res) => {
  const base = `SELECT t.id, t.worker_id, t.record_type, t.record_date, t.title, t.fitness_result, t.valid_until, t.status, t.restriction_details,
                       CONCAT(w.first_name, ' ', w.last_name) AS worker_name, w.worker_code FROM medical_records t JOIN workers w ON w.id = t.worker_id`;
  res.json({
    upcoming_appointments: await db.query(`${base} WHERE t.record_type = 'appointment' AND t.status = 'scheduled' AND t.record_date >= CURDATE() ORDER BY t.record_date LIMIT 50`),
    expiring_soon: await db.query(`${base} WHERE t.valid_until BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 30 DAY) ORDER BY t.valid_until LIMIT 50`),
    expired: await db.query(`${base} WHERE t.record_type IN ('fitness','certificate') AND t.valid_until < CURDATE()
      AND NOT EXISTS (SELECT 1 FROM medical_records n WHERE n.worker_id = t.worker_id AND n.record_type = t.record_type AND n.record_date > t.record_date)
      ORDER BY t.valid_until LIMIT 50`),
    restricted_or_unfit: await db.query(`${base} WHERE (t.fitness_result IN ('unfit','fit_with_restrictions') OR t.record_type = 'restriction')
      AND (t.valid_until IS NULL OR t.valid_until >= CURDATE()) AND t.status NOT IN ('cancelled','closed') ORDER BY t.record_date DESC LIMIT 50`),
    open_followups: await db.query(`${base} WHERE t.record_type = 'incident_followup' AND t.status = 'open' ORDER BY t.record_date LIMIT 50`),
  });
}));

module.exports = router;
