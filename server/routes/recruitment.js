// Recruitment: job profiles, candidates, document checks, selection and hiring.
const express = require('express');
const db = require('../lib/db');
const { crud } = require('../lib/crud');
const { audit } = require('../lib/audit');
const { requirePerm, assertSite } = require('../lib/auth');
const { wrap, bad, notFound, isDate, today } = require('../lib/http');
const { MEAL_TYPES } = require('../lib/meals');

const router = express.Router();
const ANY = ['recruitment.manage', 'recruitment.verify', 'recruitment.approve'];

crud(router, '/recruitment/job-profiles', {
  table: 'job_profiles', entity: 'job_profile', view: ANY, manage: ['recruitment.manage'],
  select: "t.*, (SELECT COUNT(*) FROM candidates c WHERE c.job_profile_id = t.id AND c.status NOT IN ('rejected','hired')) AS open_candidates",
  filters: { status: 't.status' }, search: ['t.title', 't.category'], orderBy: 't.status, t.title',
  fields: {
    title: { type: 'string', required: true, max: 100, label: 'Job title' },
    category: { type: 'string', max: 60 },
    requirements: { type: 'string', max: 5000 },
    required_documents: { type: 'string', max: 255 },
    status: { type: 'enum', values: ['open', 'closed'], default: 'open' },
  },
});

crud(router, '/recruitment/candidates', {
  table: 'candidates', entity: 'candidate', view: ANY, manage: ['recruitment.manage'],
  select: `t.*, jp.title AS job_title, w.worker_code,
    (SELECT CONCAT(c.name, ' / ', p.name, ' / ', s.name) FROM worker_assignments wa JOIN sites s ON s.id = wa.site_id
       JOIN projects p ON p.id = wa.project_id JOIN clients c ON c.id = p.client_id
      WHERE wa.worker_id = t.worker_id AND wa.status <> 'cancelled' ORDER BY wa.start_date DESC, wa.id DESC LIMIT 1) AS assigned_to`,
  from: 'candidates t LEFT JOIN job_profiles jp ON jp.id = t.job_profile_id LEFT JOIN workers w ON w.id = t.worker_id',
  filters: { status: 't.status', job_profile_id: 't.job_profile_id' }, search: ['t.first_name', 't.last_name', 't.phone', 't.national_id'],
  orderBy: 't.created_at DESC',
  fields: {
    job_profile_id: { type: 'int' },
    first_name: { type: 'string', required: true, max: 80, label: 'First name' },
    last_name: { type: 'string', required: true, max: 80, label: 'Last name' },
    phone: { type: 'string', max: 40 },
    email: { type: 'string', max: 150, email: true },
    national_id: { type: 'string', max: 60 },
    qualifications: { type: 'string', max: 5000 },
  },
  beforeWrite: (data, req, existing) => {
    if (existing && ['hired'].includes(existing.status)) throw bad('This candidate has already been hired');
    if (!existing) data.registered_by = req.user.id;
    return data;
  },
});

async function candidate(id) {
  const c = await db.one('SELECT * FROM candidates WHERE id = ?', [id]);
  if (!c) throw notFound('Candidate');
  return c;
}

// Check ID and qualifications documents
router.post('/recruitment/candidates/:id(\\d+)/verify', requirePerm('recruitment.verify'), wrap(async (req, res) => {
  const c = await candidate(req.params.id);
  if (['approved', 'rejected', 'hired'].includes(c.status)) throw bad('A decision has already been made for this candidate');
  const idOk = req.body.id_document_ok ? 1 : 0;
  const qOk = req.body.qualifications_ok ? 1 : 0;
  const status = idOk && qOk ? 'documents_verified' : 'documents_rejected';
  await db.query('UPDATE candidates SET id_document_ok = ?, qualifications_ok = ?, verification_notes = ?, status = ?, verified_by = ?, verified_at = NOW() WHERE id = ?',
    [idOk, qOk, req.body.notes || null, status, req.user.id, c.id]);
  await audit(req, 'verify', 'candidate', c.id, { id_document_ok: idOk, qualifications_ok: qOk });
  res.json({ ok: true, status });
}));

// Approve or reject the selection (documents must be verified before approval)
router.post('/recruitment/candidates/:id(\\d+)/decision', requirePerm('recruitment.approve'), wrap(async (req, res) => {
  const c = await candidate(req.params.id);
  const decision = req.body.decision;
  if (!['approved', 'rejected'].includes(decision)) throw bad('Decision must be approved or rejected');
  if (c.status === 'hired') throw bad('This candidate has already been hired');
  if (decision === 'approved' && c.status !== 'documents_verified') throw bad('Documents must be verified before the candidate can be approved');
  await db.query('UPDATE candidates SET status = ?, decision_notes = ?, decided_by = ?, decided_at = NOW() WHERE id = ?', [decision, req.body.notes || null, req.user.id, c.id]);
  await audit(req, decision, 'candidate', c.id, { notes: req.body.notes });
  res.json({ ok: true });
}));

// Hire an approved candidate and assign them to a client / project / site.
// The worker record is created together with the assignment, so a recruited person only
// appears on the workers list once they are assigned. A candidate hired before this rule
// (worker without any assignment) can be assigned with the same call.
router.post('/recruitment/candidates/:id(\\d+)/hire', requirePerm('workers.manage'), wrap(async (req, res) => {
  if (!req.user.can('assignments.manage')) throw bad('You need the permission to assign workers to sites to hire a candidate');
  const c = await candidate(req.params.id);
  const b = req.body || {};
  if (!b.site_id) throw bad('Choose the client, project and site the person is assigned to');
  if (!isDate(b.start_date)) throw bad('Start date is required (YYYY-MM-DD)');
  if (b.end_date && (!isDate(b.end_date) || b.end_date < b.start_date)) throw bad('End date must be on or after the start date');
  assertSite(req.user, b.site_id);
  const site = await db.one(
    `SELECT s.id, s.project_id, p.client_id, s.status FROM sites s JOIN projects p ON p.id = s.project_id WHERE s.id = ?`, [b.site_id]);
  if (!site) throw bad('Site not found');
  if (b.project_id && Number(b.project_id) !== site.project_id) throw bad('This site does not belong to the chosen project');
  if (b.client_id && Number(b.client_id) !== site.client_id) throw bad('This project does not belong to the chosen client');
  const meals = Array.isArray(b.meals) ? [...new Set(b.meals.filter((m) => MEAL_TYPES.includes(m)))] : [];

  const result = await db.tx(async (conn) => {
    const [[cand]] = await conn.query('SELECT * FROM candidates WHERE id = ? FOR UPDATE', [c.id]);
    let workerId = cand.worker_id;
    let code = null;
    if (cand.status === 'hired') {
      const [[n]] = await conn.query('SELECT COUNT(*) AS n FROM worker_assignments WHERE worker_id = ?', [workerId || 0]);
      if (!workerId || n.n) throw bad('This candidate has already been hired and assigned');
    } else if (cand.status !== 'approved') {
      throw bad('Only approved candidates can be hired');
    }
    const [[jp]] = await conn.query('SELECT title, category FROM job_profiles WHERE id = ?', [cand.job_profile_id || 0]);
    const position = b.job_position || (jp ? jp.title : null);
    const deployed = b.start_date <= today();
    if (!workerId) {
      const [[n]] = await conn.query("SELECT MAX(CAST(SUBSTRING(worker_code, 3) AS UNSIGNED)) AS n FROM workers WHERE worker_code REGEXP '^W-[0-9]+$'");
      code = b.worker_code || `W-${String((n.n || 0) + 1).padStart(5, '0')}`;
      const [r] = await conn.query(
        `INSERT INTO workers (worker_code, first_name, last_name, national_id, phone, email, job_position, category, status, deployment_status, candidate_id)
         VALUES (?,?,?,?,?,?,?,?, 'active', ?, ?)`,
        [code, cand.first_name, cand.last_name, cand.national_id, cand.phone, cand.email, position, jp ? jp.category : null,
          deployed ? 'deployed' : 'available', cand.id]);
      workerId = r.insertId;
      await conn.query("UPDATE candidates SET status = 'hired', worker_id = ? WHERE id = ?", [workerId, cand.id]);
      await audit(req, 'hire', 'candidate', cand.id, { worker_id: workerId, worker_code: code }, conn);
    } else if (deployed) {
      await conn.query("UPDATE workers SET deployment_status = 'deployed' WHERE id = ?", [workerId]);
    }
    const [a] = await conn.query(
      `INSERT INTO worker_assignments (worker_id, project_id, site_id, start_date, end_date, job_position, notes, created_by)
       VALUES (?,?,?,?,?,?,?,?)`,
      [workerId, site.project_id, site.id, b.start_date, b.end_date || null, position, b.notes || null, req.user.id]);
    for (const m of meals) await conn.query('INSERT INTO meal_entitlements (assignment_id, meal_type) VALUES (?,?)', [a.insertId, m]);
    await audit(req, 'create', 'assignment', a.insertId, { worker_id: workerId, site_id: site.id, start_date: b.start_date, end_date: b.end_date, meals, from_recruitment: cand.id }, conn);
    return { worker_id: workerId, assignment_id: a.insertId };
  });
  res.status(201).json(result);
}));

module.exports = router;
