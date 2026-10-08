// Workers, their documents and their project/site assignments (with full history).
const express = require('express');
const db = require('../lib/db');
const { crud } = require('../lib/crud');
const { audit } = require('../lib/audit');
const { requirePerm, siteFilter, assertSite } = require('../lib/auth');
const { wrap, bad, notFound, isDate, today } = require('../lib/http');

const router = express.Router();
const MAX_FILE_BYTES = 5 * 1024 * 1024;

function workerScope(user) {
  if (user.siteIds === null) return { sql: '1=1', params: [] };
  if (!user.siteIds.length) return { sql: '1=0', params: [] };
  return { sql: 't.id IN (SELECT wa.worker_id FROM worker_assignments wa WHERE wa.site_id IN (?))', params: [user.siteIds] };
}

crud(router, '/workers', {
  table: 'workers', entity: 'worker', view: ['workers.view'], manage: ['workers.manage'],
  select: `t.*, (SELECT CONCAT(s.name, ' / ', p.name) FROM worker_assignments wa JOIN sites s ON s.id = wa.site_id
             JOIN projects p ON p.id = wa.project_id
            WHERE wa.worker_id = t.id AND wa.status = 'active' AND wa.start_date <= CURDATE()
              AND (wa.end_date IS NULL OR wa.end_date >= CURDATE()) ORDER BY wa.start_date DESC LIMIT 1) AS current_assignment`,
  search: ['t.worker_code', 't.first_name', 't.last_name', 't.phone', 't.national_id', 't.job_position'],
  filters: { status: 't.status', category: 't.category' },
  orderBy: 't.last_name, t.first_name',
  scope: workerScope,
  fields: {
    worker_code: { type: 'string', required: true, max: 30, label: 'Worker ID' },
    first_name: { type: 'string', required: true, max: 80, label: 'First name' },
    last_name: { type: 'string', required: true, max: 80, label: 'Last name' },
    gender: { type: 'enum', values: ['male', 'female', 'other'] },
    date_of_birth: { type: 'date' },
    national_id: { type: 'string', max: 60 },
    phone: { type: 'string', max: 40 },
    email: { type: 'string', max: 150, email: true },
    address: { type: 'string', max: 255 },
    emergency_contact_name: { type: 'string', max: 120 },
    emergency_contact_phone: { type: 'string', max: 40 },
    status: { type: 'enum', values: ['active', 'inactive', 'suspended', 'terminated'], default: 'active' },
    job_position: { type: 'string', max: 100 },
    category: { type: 'string', max: 60 },
    pay_rate: { type: 'number', min: 0, default: 0 },
    pay_rate_type: { type: 'enum', values: ['hourly', 'daily'], default: 'daily' },
  },
});

// Suggests the next free worker ID, e.g. W-00042
router.get('/workers/next-code', requirePerm('workers.manage'), wrap(async (req, res) => {
  const r = await db.one("SELECT MAX(CAST(SUBSTRING(worker_code, 3) AS UNSIGNED)) AS n FROM workers WHERE worker_code REGEXP '^W-[0-9]+$'");
  res.json({ code: `W-${String((r.n || 0) + 1).padStart(5, '0')}` });
}));

async function visibleWorker(req, id) {
  const s = workerScope(req.user);
  const w = await db.one(`SELECT t.* FROM workers t WHERE t.id = ? AND (${s.sql})`, [id, ...s.params]);
  if (!w) throw notFound('Worker');
  return w;
}

// ---------- Assignments ----------
const ASSIGNMENT_SELECT = `
  SELECT wa.*, s.name AS site_name, p.name AS project_name, c.id AS client_id, c.name AS client_name,
         CONCAT(w.first_name, ' ', w.last_name) AS worker_name, w.worker_code,
         (SELECT GROUP_CONCAT(me.meal_type ORDER BY me.meal_type) FROM meal_entitlements me WHERE me.assignment_id = wa.id) AS meals
    FROM worker_assignments wa
    JOIN workers w ON w.id = wa.worker_id
    JOIN sites s ON s.id = wa.site_id
    JOIN projects p ON p.id = wa.project_id
    JOIN clients c ON c.id = p.client_id`;

const withMeals = (r) => ({ ...r, meals: r.meals ? r.meals.split(',') : [] });

router.get('/workers/:id(\\d+)/assignments', requirePerm('workers.view'), wrap(async (req, res) => {
  await visibleWorker(req, req.params.id);
  const rows = await db.query(`${ASSIGNMENT_SELECT} WHERE wa.worker_id = ? ORDER BY wa.start_date DESC, wa.id DESC`, [req.params.id]);
  res.json(rows.map(withMeals));
}));

router.get('/assignments', requirePerm('workers.view', 'attendance.view'), wrap(async (req, res) => {
  const where = [];
  const params = [];
  const s = siteFilter(req.user, 'wa.site_id');
  where.push(s.sql); params.push(...s.params);
  if (req.query.site_id) { where.push('wa.site_id = ?'); params.push(req.query.site_id); }
  if (req.query.project_id) { where.push('wa.project_id = ?'); params.push(req.query.project_id); }
  if (req.query.active_on && isDate(req.query.active_on)) {
    where.push("wa.status <> 'cancelled' AND wa.start_date <= ? AND (wa.end_date IS NULL OR wa.end_date >= ?)");
    params.push(req.query.active_on, req.query.active_on);
  }
  const rows = await db.query(`${ASSIGNMENT_SELECT} WHERE ${where.join(' AND ')} ORDER BY s.name, w.last_name LIMIT 2000`, params);
  res.json(rows.map(withMeals));
}));

async function findOverlap(conn, workerId, start, end, excludeId = 0) {
  const [rows] = await conn.query(
    `SELECT wa.id, wa.start_date, wa.end_date, s.name AS site_name FROM worker_assignments wa JOIN sites s ON s.id = wa.site_id
      WHERE wa.worker_id = ? AND wa.id <> ? AND wa.status <> 'cancelled'
        AND wa.start_date <= ? AND (wa.end_date IS NULL OR wa.end_date >= ?)`,
    [workerId, excludeId, end || '9999-12-31', start]);
  return rows[0];
}

// New assignment. If end_previous is true, an open assignment that overlaps is closed the day before.
router.post('/workers/:id(\\d+)/assignments', requirePerm('assignments.manage'), wrap(async (req, res) => {
  const worker = await visibleWorker(req, req.params.id);
  const b = req.body || {};
  if (!b.site_id) throw bad('Site is required');
  if (!isDate(b.start_date)) throw bad('Start date is required (YYYY-MM-DD)');
  if (b.end_date && (!isDate(b.end_date) || b.end_date < b.start_date)) throw bad('End date must be on or after the start date');
  assertSite(req.user, b.site_id);
  const site = await db.one('SELECT id, project_id FROM sites WHERE id = ?', [b.site_id]);
  if (!site) throw bad('Site not found');
  const meals = Array.isArray(b.meals) ? b.meals.filter((m) => ['lunch', 'dinner'].includes(m)) : [];

  const id = await db.tx(async (conn) => {
    let overlap = await findOverlap(conn, worker.id, b.start_date, b.end_date);
    if (overlap && b.end_previous && !overlap.end_date && overlap.start_date < b.start_date) {
      const prevEnd = new Date(`${b.start_date}T00:00:00Z`);
      prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
      const endStr = prevEnd.toISOString().slice(0, 10);
      await conn.query("UPDATE worker_assignments SET end_date = ?, status = 'ended', end_reason = ?, ended_by = ?, ended_at = NOW() WHERE id = ?",
        [endStr, 'Transferred to a new assignment', req.user.id, overlap.id]);
      await audit(req, 'end', 'assignment', overlap.id, { end_date: endStr, reason: 'transfer' }, conn);
      overlap = await findOverlap(conn, worker.id, b.start_date, b.end_date);
    }
    if (overlap) {
      throw bad(`This worker already has an assignment at ${overlap.site_name} from ${overlap.start_date}${overlap.end_date ? ` to ${overlap.end_date}` : ' (no end date)'}. End it first, or tick "end the current assignment".`);
    }
    const [r] = await conn.query(
      `INSERT INTO worker_assignments (worker_id, project_id, site_id, start_date, end_date, job_position, pay_rate, pay_rate_type, notes, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [worker.id, site.project_id, site.id, b.start_date, b.end_date || null, b.job_position || worker.job_position,
        b.pay_rate !== undefined && b.pay_rate !== '' ? Number(b.pay_rate) : worker.pay_rate,
        ['hourly', 'daily'].includes(b.pay_rate_type) ? b.pay_rate_type : worker.pay_rate_type, b.notes || null, req.user.id]);
    for (const m of meals) await conn.query('INSERT INTO meal_entitlements (assignment_id, meal_type) VALUES (?,?)', [r.insertId, m]);
    await audit(req, 'create', 'assignment', r.insertId, { worker_id: worker.id, site_id: site.id, start_date: b.start_date, end_date: b.end_date, meals }, conn);
    return r.insertId;
  });
  res.status(201).json(withMeals(await db.one(`${ASSIGNMENT_SELECT} WHERE wa.id = ?`, [id])));
}));

async function visibleAssignment(req, id) {
  const a = await db.one('SELECT * FROM worker_assignments WHERE id = ?', [id]);
  if (!a) throw notFound('Assignment');
  assertSite(req.user, a.site_id);
  return a;
}

// Closing an assignment keeps it as history - it is never deleted or overwritten.
router.post('/assignments/:id(\\d+)/end', requirePerm('assignments.manage'), wrap(async (req, res) => {
  const a = await visibleAssignment(req, req.params.id);
  if (a.status !== 'active') throw bad('This assignment is already closed');
  const endDate = req.body.end_date || today();
  if (!isDate(endDate) || endDate < a.start_date) throw bad('End date must be on or after the start date');
  await db.query("UPDATE worker_assignments SET end_date = ?, status = 'ended', end_reason = ?, ended_by = ?, ended_at = NOW() WHERE id = ?",
    [endDate, req.body.reason || null, req.user.id, a.id]);
  await audit(req, 'end', 'assignment', a.id, { end_date: endDate, reason: req.body.reason });
  res.json(withMeals(await db.one(`${ASSIGNMENT_SELECT} WHERE wa.id = ?`, [a.id])));
}));

router.put('/assignments/:id(\\d+)/meals', requirePerm('assignments.manage'), wrap(async (req, res) => {
  const a = await visibleAssignment(req, req.params.id);
  const meals = (Array.isArray(req.body.meals) ? req.body.meals : []).filter((m) => ['lunch', 'dinner'].includes(m));
  await db.tx(async (conn) => {
    await conn.query('DELETE FROM meal_entitlements WHERE assignment_id = ?', [a.id]);
    for (const m of meals) await conn.query('INSERT INTO meal_entitlements (assignment_id, meal_type) VALUES (?,?)', [a.id, m]);
    await audit(req, 'update_meals', 'assignment', a.id, { meals }, conn);
  });
  res.json({ ok: true, meals });
}));

// ---------- Documents ----------
router.get('/workers/:id(\\d+)/documents', requirePerm('workers.view'), wrap(async (req, res) => {
  await visibleWorker(req, req.params.id);
  res.json(await db.query(
    `SELECT id, worker_id, doc_type, doc_number, issue_date, expiry_date, notes, file_name, file_mime, created_at,
            file_data IS NOT NULL AS has_file FROM worker_documents WHERE worker_id = ? ORDER BY created_at DESC`, [req.params.id]));
}));

router.post('/workers/:id(\\d+)/documents', requirePerm('workers.manage'), wrap(async (req, res) => {
  await visibleWorker(req, req.params.id);
  const b = req.body || {};
  if (!b.doc_type) throw bad('Document type is required');
  let buf = null;
  if (b.file_base64) {
    buf = Buffer.from(b.file_base64, 'base64');
    if (buf.length > MAX_FILE_BYTES) throw bad('File is too large (max 5 MB)');
  }
  const r = await db.query(
    `INSERT INTO worker_documents (worker_id, doc_type, doc_number, issue_date, expiry_date, notes, file_name, file_mime, file_data, uploaded_by)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [req.params.id, b.doc_type, b.doc_number || null, isDate(b.issue_date) ? b.issue_date : null, isDate(b.expiry_date) ? b.expiry_date : null,
      b.notes || null, buf ? b.file_name : null, buf ? b.file_mime : null, buf, req.user.id]);
  await audit(req, 'create', 'worker_document', r.insertId, { worker_id: req.params.id, doc_type: b.doc_type });
  res.status(201).json({ id: r.insertId });
}));

router.get('/documents/:id(\\d+)/file', requirePerm('workers.view'), wrap(async (req, res) => {
  const d = await db.one('SELECT worker_id, file_name, file_mime, file_data FROM worker_documents WHERE id = ?', [req.params.id]);
  if (!d || !d.file_data) throw notFound('File');
  await visibleWorker(req, d.worker_id);
  res.setHeader('Content-Type', d.file_mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(d.file_name || 'document')}"`);
  res.send(d.file_data);
}));

router.delete('/documents/:id(\\d+)', requirePerm('workers.manage'), wrap(async (req, res) => {
  const d = await db.one('SELECT worker_id, doc_type FROM worker_documents WHERE id = ?', [req.params.id]);
  if (!d) throw notFound('Document');
  await visibleWorker(req, d.worker_id);
  await db.query('DELETE FROM worker_documents WHERE id = ?', [req.params.id]);
  await audit(req, 'delete', 'worker_document', req.params.id, d);
  res.json({ ok: true });
}));

module.exports = router;
