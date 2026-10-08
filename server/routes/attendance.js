// Daily attendance, including the synchronisation endpoint used by the offline-capable app.
//
// Every change made on a device is sent as an "operation" with its own unique ID (UUID).
//  - Same operation sent twice (e.g. after a dropped connection)  -> recognised and not applied again.
//  - Device edited an old copy while someone else changed the record -> saved as a "conflict" for a
//    supervisor to decide; the central database is never silently overwritten.
//  - Every change is written to attendance_history.
const express = require('express');
const db = require('../lib/db');
const { audit } = require('../lib/audit');
const { requirePerm, siteFilter, assertSite } = require('../lib/auth');
const { wrap, bad, notFound, isDate, today } = require('../lib/http');

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATA_FIELDS = ['status', 'late_arrival', 'early_departure', 'normal_hours', 'overtime_hours', 'comments'];

const snapshot = (r) => (r ? {
  id: r.id, assignment_id: r.assignment_id, work_date: r.work_date, status: r.status, late_arrival: Number(r.late_arrival),
  early_departure: Number(r.early_departure), normal_hours: Number(r.normal_hours), overtime_hours: Number(r.overtime_hours),
  comments: r.comments, validated: Number(r.validated), version: r.version,
} : null);

// Roster: everyone assigned to a site on a date, with any attendance already recorded.
router.get('/attendance/roster', requirePerm('attendance.view', 'attendance.record'), wrap(async (req, res) => {
  const { site_id: siteId, date } = req.query;
  if (!siteId || !isDate(date)) throw bad('site_id and date are required');
  assertSite(req.user, siteId);
  const rows = await db.query(
    `SELECT wa.id AS assignment_id, wa.worker_id, wa.project_id, wa.site_id, wa.job_position, wa.start_date, wa.end_date, w.worker_code,
            CONCAT(w.first_name, ' ', w.last_name) AS worker_name,
            (SELECT GROUP_CONCAT(me.meal_type) FROM meal_entitlements me WHERE me.assignment_id = wa.id) AS meals,
            a.id, a.status, a.late_arrival, a.early_departure, a.normal_hours, a.overtime_hours, a.comments,
            a.validated, a.version, a.updated_at
       FROM worker_assignments wa
       JOIN workers w ON w.id = wa.worker_id
       LEFT JOIN attendance a ON a.assignment_id = wa.id AND a.work_date = ?
      WHERE wa.site_id = ? AND wa.status <> 'cancelled' AND wa.start_date <= ? AND (wa.end_date IS NULL OR wa.end_date >= ?)
      ORDER BY w.last_name, w.first_name`, [date, siteId, date, date]);
  res.json(rows.map((r) => ({ ...r, meals: r.meals ? r.meals.split(',') : [], version: r.version || 0 })));
}));

function validateOp(op) {
  if (!op || !UUID_RE.test(op.op_id || '')) return 'Missing or invalid operation ID';
  if (!op.assignment_id) return 'Missing assignment';
  if (!isDate(op.work_date)) return 'Invalid date';
  if (!['present', 'absent'].includes(op.status)) return 'Status must be present or absent';
  const n = Number(op.normal_hours || 0); const o = Number(op.overtime_hours || 0);
  if (!(n >= 0 && n <= 24) || !(o >= 0 && o <= 24) || n + o > 24) return 'Hours must be between 0 and 24 per day';
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  if (op.work_date > tomorrow) return 'Attendance cannot be recorded for a future date';
  return null;
}

function normalise(op) {
  const absent = op.status === 'absent';
  return {
    status: op.status,
    late_arrival: !absent && op.late_arrival ? 1 : 0,
    early_departure: !absent && op.early_departure ? 1 : 0,
    normal_hours: absent ? 0 : Number(op.normal_hours || 0),
    overtime_hours: absent ? 0 : Number(op.overtime_hours || 0),
    comments: op.comments ? String(op.comments).slice(0, 500) : null,
  };
}
const sameData = (row, data) => DATA_FIELDS.every((f) => String(row[f] ?? '') === String(data[f] ?? ''));

async function logOp(conn, op, user, deviceId, entityId, result, message) {
  await conn.query(
    'INSERT INTO sync_operations (op_id, user_id, device_id, entity, entity_id, result, message, client_created_at) VALUES (?,?,?,?,?,?,?,?)',
    [op.op_id, user.id, deviceId || null, 'attendance', entityId || null, result, message || null,
      op.created_at ? new Date(op.created_at).toISOString().slice(0, 19).replace('T', ' ') : null]);
}

async function applyOp(req, op, deviceId) {
  const user = req.user;
  const prior = await db.one('SELECT * FROM sync_operations WHERE op_id = ?', [op.op_id || '']);
  if (prior) {
    const rec = prior.entity_id ? await db.one('SELECT * FROM attendance WHERE id = ?', [prior.entity_id]) : null;
    return { op_id: op.op_id, result: prior.result, duplicate: true, message: prior.message, record: snapshot(rec) };
  }
  const invalid = validateOp(op);
  if (invalid) return { op_id: op.op_id, result: 'rejected', message: invalid };

  return db.tx(async (conn) => {
    const [[asg]] = await conn.query('SELECT * FROM worker_assignments WHERE id = ?', [op.assignment_id]);
    const reject = async (message) => {
      await logOp(conn, op, user, deviceId, null, 'rejected', message);
      return { op_id: op.op_id, result: 'rejected', message };
    };
    if (!asg) return reject('Assignment not found');
    if (user.siteIds !== null && !user.siteIds.includes(asg.site_id)) return reject('This site is not assigned to you');
    if (asg.status === 'cancelled' || op.work_date < asg.start_date || (asg.end_date && op.work_date > asg.end_date)) {
      return reject('The worker was not assigned to this site on that date');
    }
    const data = normalise(op);
    const source = op.source === 'offline' ? 'offline' : 'online';
    const [[existing]] = await conn.query('SELECT * FROM attendance WHERE assignment_id = ? AND work_date = ? FOR UPDATE', [asg.id, op.work_date]);
    const baseVersion = Number(op.base_version || 0);

    if (!existing) {
      const [r] = await conn.query(
        `INSERT INTO attendance (uuid, assignment_id, worker_id, project_id, site_id, work_date, status, late_arrival, early_departure,
           normal_hours, overtime_hours, comments, source, recorded_by, updated_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [op.op_id, asg.id, asg.worker_id, asg.project_id, asg.site_id, op.work_date, data.status, data.late_arrival, data.early_departure,
          data.normal_hours, data.overtime_hours, data.comments, source, user.id, user.id]);
      await conn.query('INSERT INTO attendance_history (attendance_id, version, op_id, change_type, new_data, changed_by) VALUES (?,?,?,?,?,?)',
        [r.insertId, 1, op.op_id, 'create', JSON.stringify(data), user.id]);
      await logOp(conn, op, user, deviceId, r.insertId, 'applied');
      const [[rec]] = await conn.query('SELECT * FROM attendance WHERE id = ?', [r.insertId]);
      return { op_id: op.op_id, result: 'applied', record: snapshot(rec) };
    }

    if (sameData(existing, data)) {
      await logOp(conn, op, user, deviceId, existing.id, 'applied', 'No change');
      return { op_id: op.op_id, result: 'applied', record: snapshot(existing) };
    }
    if (existing.validated && !user.can('attendance.validate')) {
      return reject('This attendance has already been validated and can only be changed by a supervisor');
    }
    if (baseVersion !== existing.version) {
      const [c] = await conn.query('INSERT INTO sync_conflicts (op_id, attendance_id, user_id, client_data, server_data) VALUES (?,?,?,?,?)',
        [op.op_id, existing.id, user.id, JSON.stringify({ ...data, assignment_id: asg.id, work_date: op.work_date, base_version: baseVersion }),
          JSON.stringify(snapshot(existing))]);
      await logOp(conn, op, user, deviceId, existing.id, 'conflict', `Changed by someone else meanwhile (conflict #${c.insertId})`);
      return { op_id: op.op_id, result: 'conflict', message: 'Someone else changed this record while you were offline. A supervisor will decide which version to keep.', record: snapshot(existing) };
    }

    const keepValidated = existing.validated && user.can('attendance.validate') ? 1 : 0;
    await conn.query(
      `UPDATE attendance SET status=?, late_arrival=?, early_departure=?, normal_hours=?, overtime_hours=?, comments=?,
         validated=?, validated_by=IF(?, validated_by, NULL), validated_at=IF(?, validated_at, NULL), version = version + 1, updated_by=?, source=?
       WHERE id = ?`,
      [data.status, data.late_arrival, data.early_departure, data.normal_hours, data.overtime_hours, data.comments,
        keepValidated, keepValidated, keepValidated, user.id, source, existing.id]);
    await conn.query('INSERT INTO attendance_history (attendance_id, version, op_id, change_type, old_data, new_data, changed_by) VALUES (?,?,?,?,?,?,?)',
      [existing.id, existing.version + 1, op.op_id, 'update', JSON.stringify(snapshot(existing)), JSON.stringify(data), user.id]);
    await logOp(conn, op, user, deviceId, existing.id, 'applied');
    const [[rec]] = await conn.query('SELECT * FROM attendance WHERE id = ?', [existing.id]);
    return { op_id: op.op_id, result: 'applied', record: snapshot(rec) };
  });
}

// Receives a batch of operations from a device. Each one is handled on its own so one bad
// operation never blocks the rest. Answers with a result for every operation.
router.post('/sync/attendance', requirePerm('attendance.record', 'attendance.validate'), wrap(async (req, res) => {
  const ops = Array.isArray(req.body.operations) ? req.body.operations.slice(0, 500) : [];
  const results = [];
  for (const op of ops) {
    let attempt = 0;
    for (;;) {
      try {
        results.push(await applyOp(req, op, req.body.device_id));
        break;
      } catch (e) {
        // Two devices saving at the same instant: try once more, it will then be seen as a duplicate or a conflict.
        if (e.code === 'ER_DUP_ENTRY' && attempt++ < 2) continue;
        console.error('Sync operation failed', op && op.op_id, e);
        results.push({ op_id: op && op.op_id, result: 'error', message: 'Server error - will retry automatically' });
        break;
      }
    }
  }
  res.json({ results, server_time: new Date().toISOString() });
}));

// Supervisor confirms the day's attendance for a site. Catering uses validated attendance only.
router.post('/attendance/validate', requirePerm('attendance.validate'), wrap(async (req, res) => {
  const { site_id: siteId, date } = req.body || {};
  if (!siteId || !isDate(date)) throw bad('site_id and date are required');
  assertSite(req.user, siteId);
  const count = await db.tx(async (conn) => {
    const [rows] = await conn.query('SELECT * FROM attendance WHERE site_id = ? AND work_date = ? AND validated = 0 FOR UPDATE', [siteId, date]);
    for (const r of rows) {
      await conn.query('UPDATE attendance SET validated = 1, validated_by = ?, validated_at = NOW(), version = version + 1 WHERE id = ?', [req.user.id, r.id]);
      await conn.query('INSERT INTO attendance_history (attendance_id, version, change_type, changed_by) VALUES (?,?,?,?)', [r.id, r.version + 1, 'validate', req.user.id]);
    }
    return rows.length;
  });
  await audit(req, 'validate', 'attendance', null, { site_id: siteId, date, count });
  res.json({ validated: count });
}));

// Attendance list for reports
router.get('/attendance', requirePerm('attendance.view'), wrap(async (req, res) => {
  const from = isDate(req.query.from) ? req.query.from : today();
  const to = isDate(req.query.to) ? req.query.to : from;
  const s = siteFilter(req.user, 'a.site_id');
  const where = ['a.work_date BETWEEN ? AND ?', s.sql];
  const params = [from, to, ...s.params];
  for (const k of ['site_id', 'project_id', 'worker_id']) if (req.query[k]) { where.push(`a.${k} = ?`); params.push(req.query[k]); }
  if (req.query.client_id) { where.push('p.client_id = ?'); params.push(req.query.client_id); }
  res.json(await db.query(
    `SELECT a.*, CONCAT(w.first_name, ' ', w.last_name) AS worker_name, w.worker_code, s.name AS site_name, p.name AS project_name
       FROM attendance a JOIN workers w ON w.id = a.worker_id JOIN sites s ON s.id = a.site_id JOIN projects p ON p.id = a.project_id
      WHERE ${where.join(' AND ')} ORDER BY a.work_date DESC, s.name, w.last_name LIMIT 5000`, params));
}));

router.get('/attendance/:id(\\d+)/history', requirePerm('attendance.view'), wrap(async (req, res) => {
  const a = await db.one('SELECT site_id FROM attendance WHERE id = ?', [req.params.id]);
  if (!a) throw notFound('Attendance');
  assertSite(req.user, a.site_id);
  res.json(await db.query(
    `SELECT h.*, u.name AS changed_by_name FROM attendance_history h LEFT JOIN users u ON u.id = h.changed_by
      WHERE h.attendance_id = ? ORDER BY h.id`, [req.params.id]));
}));

// ---------- Sync conflicts ----------
router.get('/sync/conflicts', requirePerm('attendance.validate'), wrap(async (req, res) => {
  const s = siteFilter(req.user, 'a.site_id');
  res.json(await db.query(
    `SELECT c.*, u.name AS user_name, CONCAT(w.first_name, ' ', w.last_name) AS worker_name, s.name AS site_name, a.work_date
       FROM sync_conflicts c JOIN attendance a ON a.id = c.attendance_id JOIN workers w ON w.id = a.worker_id
       JOIN sites s ON s.id = a.site_id LEFT JOIN users u ON u.id = c.user_id
      WHERE c.status = ? AND ${s.sql} ORDER BY c.created_at DESC LIMIT 500`, [req.query.status || 'open', ...s.params]));
}));

router.post('/sync/conflicts/:id(\\d+)/resolve', requirePerm('attendance.validate'), wrap(async (req, res) => {
  const action = req.body.action;
  if (!['keep_server', 'apply_device'].includes(action)) throw bad('action must be keep_server or apply_device');
  const c = await db.one('SELECT * FROM sync_conflicts WHERE id = ?', [req.params.id]);
  if (!c || c.status !== 'open') throw notFound('Open conflict');
  const att = await db.one('SELECT * FROM attendance WHERE id = ?', [c.attendance_id]);
  assertSite(req.user, att.site_id);
  await db.tx(async (conn) => {
    if (action === 'apply_device') {
      const d = typeof c.client_data === 'string' ? JSON.parse(c.client_data) : c.client_data;
      await conn.query(
        `UPDATE attendance SET status=?, late_arrival=?, early_departure=?, normal_hours=?, overtime_hours=?, comments=?,
           validated=0, validated_by=NULL, validated_at=NULL, version = version + 1, updated_by=? WHERE id = ?`,
        [d.status, d.late_arrival, d.early_departure, d.normal_hours, d.overtime_hours, d.comments, req.user.id, att.id]);
      await conn.query('INSERT INTO attendance_history (attendance_id, version, op_id, change_type, old_data, new_data, changed_by) VALUES (?,?,?,?,?,?,?)',
        [att.id, att.version + 1, c.op_id, 'conflict_applied', JSON.stringify(snapshot(att)), JSON.stringify(d), req.user.id]);
    }
    await conn.query('UPDATE sync_conflicts SET status = ?, resolved_by = ?, resolved_at = NOW() WHERE id = ?',
      [action === 'apply_device' ? 'applied_device' : 'kept_server', req.user.id, c.id]);
    await audit(req, 'resolve_conflict', 'attendance', att.id, { conflict_id: c.id, action }, conn);
  });
  res.json({ ok: true });
}));

module.exports = router;
