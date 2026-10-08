// Fills an EMPTY database with sample data so the system can be tried out.
// Run: npm run seed:demo      (refuses to run if clients already exist)
// Sample users all use the password: Demo1234!
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./lib/db');
const { migrate } = require('./migrate');

const d = (offset) => { const x = new Date(); x.setUTCDate(x.getUTCDate() + offset); return x.toISOString().slice(0, 10); };
const ins = async (table, row) => {
  const cols = Object.keys(row);
  const r = await db.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, cols.map((c) => row[c]));
  return r.insertId;
};

async function main() {
  await migrate({ quiet: true });
  const [{ n }] = await db.query('SELECT COUNT(*) AS n FROM clients');
  if (n > 0) { console.log('The database already has clients - demo data was not added.'); return; }
  const company = (await db.one('SELECT id FROM companies LIMIT 1')).id;

  // Structure from the example in the requirements
  const clientA = await ins('clients', { company_id: company, code: 'CLA', name: 'Client A', contact_name: 'Jane Doe', contact_email: 'jane@clienta.example' });
  const clientB = await ins('clients', { company_id: company, code: 'CLB', name: 'Client B', contact_name: 'John Roe' });
  const projX = await ins('projects', { client_id: clientA, code: 'PX', name: 'Project X', location: 'North Region', start_date: d(-120) });
  const projY = await ins('projects', { client_id: clientA, code: 'PY', name: 'Project Y', location: 'Coastal Zone', start_date: d(-60) });
  const projZ = await ins('projects', { client_id: clientB, code: 'PZ', name: 'Project Z', location: 'Remote Highlands (2h drive)', start_date: d(-90) });
  const sites = [];
  for (const [i, p] of [[1, projX], [2, projX], [3, projX], [4, projY], [5, projY], [6, projZ], [7, projZ]]) {
    sites.push({ id: await ins('sites', { project_id: p, code: `S${i}`, name: `Site ${i}`, location: `Location ${i}` }), project_id: p });
  }

  // Kitchens: one central, one temporary near the remote project
  const central = await ins('kitchens', { name: 'Central Kitchen', kitchen_type: 'central', location: 'Head Office', start_date: d(-365) });
  const temp = await ins('kitchens', { name: 'Highlands Temporary Kitchen', kitchen_type: 'temporary', project_id: projZ, location: 'Project Z camp',
    travel_time_minutes: 120, start_date: d(-30), planned_close_date: d(150) });
  for (const s of sites) {
    if (s.project_id === projZ) {
      await ins('site_kitchen_assignments', { site_id: s.id, kitchen_id: central, start_date: d(-90), end_date: d(-31), notes: 'Before temporary kitchen opened' });
      await ins('site_kitchen_assignments', { site_id: s.id, kitchen_id: temp, start_date: d(-30) });
    } else {
      await ins('site_kitchen_assignments', { site_id: s.id, kitchen_id: central, start_date: d(-365) });
    }
  }
  for (const [k, items] of [[central, [['Rice', 'kg', 400, 100], ['Chicken', 'kg', 120, 50], ['Cooking oil', 'L', 60, 20]]], [temp, [['Rice', 'kg', 80, 40], ['Beans', 'kg', 15, 20]]]]) {
    for (const [name, unit, qty, reorder] of items) await ins('stock_items', { kitchen_id: k, name, unit, quantity: qty, reorder_level: reorder });
  }

  // Workers and assignments
  const first = ['Amina', 'Kwame', 'Fatou', 'Moussa', 'Grace', 'Ibrahim', 'Esther', 'Samuel', 'Aisha', 'Daniel', 'Mariam', 'Joseph', 'Ruth', 'Paul', 'Zainab', 'Peter', 'Halima', 'David', 'Sarah', 'Musa'];
  const last = ['Okafor', 'Mensah', 'Diallo', 'Traore', 'Banda', 'Kamara', 'Mwangi', 'Ndlovu', 'Sow', 'Owusu'];
  const positions = [['Labourer', 'General', 'daily', 25], ['Mason', 'Skilled', 'daily', 40], ['Driver', 'Skilled', 'hourly', 6], ['Electrician', 'Skilled', 'hourly', 8], ['Supervisor', 'Supervisory', 'daily', 60]];
  const assignments = [];
  for (let i = 0; i < 42; i++) {
    const [pos, cat, rateType, rate] = positions[i % positions.length];
    const w = await ins('workers', { worker_code: `W-${String(i + 1).padStart(5, '0')}`, first_name: first[i % first.length], last_name: last[(i * 7) % last.length],
      gender: i % 2 ? 'male' : 'female', phone: `+000 555 ${String(1000 + i)}`, job_position: pos, category: cat, pay_rate: rate, pay_rate_type: rateType });
    const site = sites[i % sites.length];
    if (i < 6) { // some workers have a past assignment, to show history
      const old = sites[(i + 3) % sites.length];
      await ins('worker_assignments', { worker_id: w, project_id: old.project_id, site_id: old.id, start_date: d(-100), end_date: d(-41), status: 'ended', job_position: pos, pay_rate: rate, pay_rate_type: rateType, end_reason: 'Transferred' });
    }
    const a = await ins('worker_assignments', { worker_id: w, project_id: site.project_id, site_id: site.id, start_date: d(-40), job_position: pos, pay_rate: rate, pay_rate_type: rateType });
    await ins('meal_entitlements', { assignment_id: a, meal_type: 'lunch' });
    if (site.project_id === projZ || i % 3 === 0) await ins('meal_entitlements', { assignment_id: a, meal_type: 'dinner' });
    assignments.push({ id: a, worker_id: w, site_id: site.id, project_id: site.project_id });
  }

  // Users for each role
  const roles = Object.fromEntries((await db.query('SELECT id, name FROM roles')).map((r) => [r.name, r.id]));
  const hash = await bcrypt.hash('Demo1234!', 10);
  const users = {};
  for (const [email, name, role] of [
    ['director@demo.local', 'Diana Director', 'Management / Director'], ['hr@demo.local', 'Harry HR', 'Human Resources'],
    ['site1@demo.local', 'Sam Site-Manager', 'Site Manager'], ['catering@demo.local', 'Carla Catering', 'Catering Department'],
    ['kitchen@demo.local', 'Ken Kitchen', 'Kitchen Manager'], ['housing@demo.local', 'Abby Accommodation', 'Accommodation Manager'],
    ['medical@demo.local', 'Dr. Mia Medical', 'Medical Department'], ['hse@demo.local', 'Hank HSE', 'HSE Manager'], ['finance@demo.local', 'Fiona Finance', 'Accounting / Finance'],
  ]) users[email] = await ins('users', { name, email, password_hash: hash, role_id: roles[role] });
  await ins('user_sites', { user_id: users['site1@demo.local'], site_id: sites[0].id });
  await ins('user_sites', { user_id: users['site1@demo.local'], site_id: sites[1].id });
  await ins('user_kitchens', { user_id: users['kitchen@demo.local'], kitchen_id: temp });

  // Attendance for the last 10 days (validated), none yet for today
  for (let day = -10; day <= -1; day++) {
    for (const a of assignments) {
      const absent = (a.worker_id + day) % 9 === 0;
      const ot = !absent && (a.worker_id + day) % 4 === 0 ? 2 : 0;
      const attId = await ins('attendance', { uuid: crypto.randomUUID(), assignment_id: a.id, worker_id: a.worker_id, project_id: a.project_id, site_id: a.site_id,
        work_date: d(day), status: absent ? 'absent' : 'present', late_arrival: !absent && (a.worker_id + day) % 7 === 0 ? 1 : 0,
        normal_hours: absent ? 0 : 8, overtime_hours: ot, validated: 1, validated_by: users['site1@demo.local'] });
      await ins('attendance_history', { attendance_id: attId, version: 1, change_type: 'create', new_data: JSON.stringify({ seeded: true }) });
    }
  }

  // Accommodation
  const fac = await ins('accommodation_facilities', { name: 'North Camp', location: 'Near Project X' });
  const fac2 = await ins('accommodation_facilities', { name: 'Highlands Camp', location: 'Project Z' });
  let roomIds = [];
  for (const [f, bName] of [[fac, 'Block A'], [fac, 'Block B'], [fac2, 'Lodge 1']]) {
    const b = await ins('accommodation_buildings', { facility_id: f, name: bName });
    for (let r = 1; r <= 4; r++) roomIds.push({ id: await ins('accommodation_rooms', { building_id: b, room_number: `${bName.slice(-1)}${r}`, capacity: r === 4 ? 2 : 4 }), cap: r === 4 ? 2 : 4 });
  }
  roomIds = roomIds.flatMap((r) => Array(r.cap).fill(r.id));
  for (let i = 0; i < 20; i++) {
    await ins('room_occupancies', { room_id: roomIds[i], worker_id: assignments[i].worker_id, project_id: assignments[i].project_id, check_in_date: d(-35) });
  }

  // HSE
  const inc1 = await ins('hse_incidents', { occurred_at: `${d(-5)} 10:30:00`, client_id: clientA, project_id: projX, site_id: sites[0].id, location: 'Scaffold zone',
    person_worker_id: assignments[0].worker_id, incident_type: 'injury', description: 'Worker cut hand on sheet metal.', severity: 'medium',
    witnesses: 'Site supervisor', immediate_actions: 'First aid given', reported_by: users['site1@demo.local'] });
  await ins('hse_corrective_actions', { incident_id: inc1, description: 'Provide cut-resistant gloves to all metal workers', responsible_name: 'Site Supervisor', due_date: d(-1) });
  const inc2 = await ins('hse_incidents', { occurred_at: `${d(-40)} 15:00:00`, client_id: clientB, project_id: projZ, site_id: sites[5].id, incident_type: 'near_miss',
    description: 'Truck reversed without a spotter.', severity: 'high', status: 'closed', closed_at: `${d(-30)} 09:00:00`, reported_by: users['hse@demo.local'] });
  await ins('hse_corrective_actions', { incident_id: inc2, description: 'Spotter training for all drivers', responsible_name: 'Transport lead', due_date: d(-32), status: 'done', completed_at: `${d(-33)} 12:00:00` });

  // Medical
  await ins('medical_records', { worker_id: assignments[0].worker_id, record_type: 'incident_followup', record_date: d(-5), title: 'Hand laceration follow-up', status: 'open', hse_incident_id: inc1 });
  await ins('medical_records', { worker_id: assignments[1].worker_id, record_type: 'fitness', record_date: d(-340), title: 'Annual fitness check', fitness_result: 'fit', valid_until: d(20) });
  await ins('medical_records', { worker_id: assignments[2].worker_id, record_type: 'appointment', record_date: d(3), title: 'Pre-employment examination', status: 'scheduled' });

  // Catering expenses
  await ins('catering_expenses', { kitchen_id: central, expense_date: d(-3), category: 'food', supplier: 'Fresh Foods Ltd', description: 'Weekly food purchase', amount: 3200 });
  await ins('catering_expenses', { kitchen_id: temp, expense_date: d(-2), category: 'fuel', supplier: 'Fuel Co', description: 'Generator fuel', amount: 450 });

  // Meal requirements for the past days so cost sharing by meal count has data
  for (let day = -10; day <= -1; day++) {
    const counts = await db.query(
      `SELECT a.site_id, me.meal_type, COUNT(*) AS qty FROM attendance a JOIN meal_entitlements me ON me.assignment_id = a.assignment_id
        WHERE a.work_date = ? AND a.status = 'present' AND a.validated = 1 GROUP BY a.site_id, me.meal_type`, [d(day)]);
    for (const c of counts) {
      const k = await db.one('SELECT kitchen_id FROM site_kitchen_assignments WHERE site_id = ? AND start_date <= ? AND (end_date IS NULL OR end_date >= ?)', [c.site_id, d(day), d(day)]);
      await ins('meal_orders', { site_id: c.site_id, kitchen_id: k ? k.kitchen_id : null, service_date: d(day), meal_type: c.meal_type, required_qty: c.qty });
    }
  }
  console.log('Demo data added. Sample users (password Demo1234!):');
  console.log(Object.keys(users).join('\n'));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
