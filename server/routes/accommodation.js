// Accommodation: facilities -> buildings -> rooms, and who stays in each room (history kept).
const express = require('express');
const db = require('../lib/db');
const { crud } = require('../lib/crud');
const { audit } = require('../lib/audit');
const { requirePerm } = require('../lib/auth');
const { wrap, bad, notFound, isDate, today } = require('../lib/http');

const router = express.Router();
const V = ['accommodation.view'];
const M = ['accommodation.manage'];

crud(router, '/accommodation/facilities', {
  table: 'accommodation_facilities', entity: 'facility', view: V, manage: M, orderBy: 't.name', allowDelete: true,
  select: `t.*, (SELECT COALESCE(SUM(r.capacity), 0) FROM accommodation_rooms r JOIN accommodation_buildings b ON b.id = r.building_id
             WHERE b.facility_id = t.id AND r.status = 'available') AS capacity`,
  fields: { name: { type: 'string', required: true, max: 120, label: 'Name' }, location: { type: 'string', max: 200 }, notes: { type: 'string', max: 255 } },
});

crud(router, '/accommodation/buildings', {
  table: 'accommodation_buildings', entity: 'building', view: V, manage: M, orderBy: 'f.name, t.name', allowDelete: true,
  select: 't.*, f.name AS facility_name', from: 'accommodation_buildings t JOIN accommodation_facilities f ON f.id = t.facility_id',
  filters: { facility_id: 't.facility_id' },
  fields: { facility_id: { type: 'int', required: true, label: 'Facility' }, name: { type: 'string', required: true, max: 120, label: 'Name' } },
});

crud(router, '/accommodation/rooms', {
  table: 'accommodation_rooms', entity: 'room', view: V, manage: M, orderBy: 'f.name, b.name, t.room_number',
  select: `t.*, b.name AS building_name, f.id AS facility_id, f.name AS facility_name,
           (SELECT COUNT(*) FROM room_occupancies o WHERE o.room_id = t.id AND o.check_out_date IS NULL) AS occupied`,
  from: 'accommodation_rooms t JOIN accommodation_buildings b ON b.id = t.building_id JOIN accommodation_facilities f ON f.id = b.facility_id',
  filters: { building_id: 't.building_id', facility_id: 'b.facility_id', status: 't.status' }, search: ['t.room_number', 'b.name', 'f.name'],
  fields: {
    building_id: { type: 'int', required: true, label: 'Building' },
    room_number: { type: 'string', required: true, max: 30, label: 'Room number' },
    capacity: { type: 'int', required: true, min: 1, label: 'Capacity' },
    status: { type: 'enum', values: ['available', 'maintenance', 'closed'], default: 'available' },
    notes: { type: 'string', max: 255 },
  },
});

router.get('/accommodation/occupancies', requirePerm(...V), wrap(async (req, res) => {
  const where = ['1=1']; const params = [];
  if (req.query.active === '1') where.push('o.check_out_date IS NULL');
  for (const k of ['room_id', 'worker_id']) if (req.query[k]) { where.push(`o.${k} = ?`); params.push(req.query[k]); }
  res.json(await db.query(
    `SELECT o.*, CONCAT(w.first_name, ' ', w.last_name) AS worker_name, w.worker_code, r.room_number, b.name AS building_name,
            f.name AS facility_name, p.name AS project_name
       FROM room_occupancies o JOIN workers w ON w.id = o.worker_id JOIN accommodation_rooms r ON r.id = o.room_id
       JOIN accommodation_buildings b ON b.id = r.building_id JOIN accommodation_facilities f ON f.id = b.facility_id
       LEFT JOIN projects p ON p.id = o.project_id
      WHERE ${where.join(' AND ')} ORDER BY o.check_out_date IS NULL DESC, o.check_in_date DESC LIMIT 2000`, params));
}));

router.post('/accommodation/check-in', requirePerm(...M), wrap(async (req, res) => {
  const { room_id: roomId, worker_id: workerId, notes } = req.body || {};
  const date = req.body.check_in_date || today();
  if (!roomId || !workerId || !isDate(date)) throw bad('Room, worker and check-in date are required');
  const id = await db.tx(async (conn) => {
    const [[room]] = await conn.query('SELECT * FROM accommodation_rooms WHERE id = ? FOR UPDATE', [roomId]);
    if (!room) throw notFound('Room');
    if (room.status !== 'available') throw bad(`This room is ${room.status}`);
    const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM room_occupancies WHERE room_id = ? AND check_out_date IS NULL', [roomId]);
    if (n >= room.capacity) throw bad(`This room is full (${n} of ${room.capacity})`);
    const [already] = await conn.query('SELECT id FROM room_occupancies WHERE worker_id = ? AND check_out_date IS NULL', [workerId]);
    if (already.length) throw bad('This worker is already checked in to a room. Check them out first.');
    // Project is taken from the worker's current assignment (entered once, reused here)
    const [[asg]] = await conn.query(
      `SELECT project_id FROM worker_assignments WHERE worker_id = ? AND status = 'active' AND start_date <= ?
          AND (end_date IS NULL OR end_date >= ?) ORDER BY start_date DESC LIMIT 1`, [workerId, date, date]);
    const [r] = await conn.query('INSERT INTO room_occupancies (room_id, worker_id, project_id, check_in_date, notes, created_by) VALUES (?,?,?,?,?,?)',
      [roomId, workerId, asg ? asg.project_id : null, date, notes || null, req.user.id]);
    await audit(req, 'check_in', 'room_occupancy', r.insertId, { room_id: roomId, worker_id: workerId, date }, conn);
    return r.insertId;
  });
  res.status(201).json({ id });
}));

router.post('/accommodation/occupancies/:id(\\d+)/check-out', requirePerm(...M), wrap(async (req, res) => {
  const o = await db.one('SELECT * FROM room_occupancies WHERE id = ?', [req.params.id]);
  if (!o) throw notFound('Stay');
  if (o.check_out_date) throw bad('Already checked out');
  const date = req.body.check_out_date || today();
  if (!isDate(date) || date < o.check_in_date) throw bad('Check-out date must be on or after check-in');
  await db.query('UPDATE room_occupancies SET check_out_date = ? WHERE id = ?', [date, o.id]);
  await audit(req, 'check_out', 'room_occupancy', o.id, { date });
  res.json({ ok: true });
}));

// Total capacity -> occupied -> available
router.get('/accommodation/summary', requirePerm(...V), wrap(async (req, res) => {
  const rows = await db.query(
    `SELECT f.id AS facility_id, f.name AS facility_name,
            COALESCE(SUM(CASE WHEN r.status = 'available' THEN r.capacity ELSE 0 END), 0) AS capacity,
            COALESCE(SUM((SELECT COUNT(*) FROM room_occupancies o WHERE o.room_id = r.id AND o.check_out_date IS NULL)), 0) AS occupied,
            COUNT(r.id) AS rooms
       FROM accommodation_facilities f
       LEFT JOIN accommodation_buildings b ON b.facility_id = f.id
       LEFT JOIN accommodation_rooms r ON r.building_id = b.id
      GROUP BY f.id, f.name ORDER BY f.name`);
  const facilities = rows.map((r) => ({ ...r, capacity: Number(r.capacity), occupied: Number(r.occupied), available: Math.max(Number(r.capacity) - Number(r.occupied), 0) }));
  const total = facilities.reduce((t, f) => ({ capacity: t.capacity + f.capacity, occupied: t.occupied + f.occupied, available: t.available + f.available }),
    { capacity: 0, occupied: 0, available: 0 });
  res.json({ total, facilities });
}));

module.exports = router;
