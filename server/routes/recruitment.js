// Recruitment: job profiles, candidates, document checks, selection and hiring.
const express = require('express');
const db = require('../lib/db');
const { crud } = require('../lib/crud');
const { audit } = require('../lib/audit');
const { requirePerm } = require('../lib/auth');
const { wrap, bad, notFound } = require('../lib/http');

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
  select: 't.*, jp.title AS job_title, w.worker_code',
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

// Turn an approved candidate into a worker record (entered once, reused)
router.post('/recruitment/candidates/:id(\\d+)/hire', requirePerm('workers.manage'), wrap(async (req, res) => {
  const c = await candidate(req.params.id);
  if (c.status !== 'approved') throw bad('Only approved candidates can be hired');
  const workerId = await db.tx(async (conn) => {
    const [[n]] = await conn.query("SELECT MAX(CAST(SUBSTRING(worker_code, 3) AS UNSIGNED)) AS n FROM workers WHERE worker_code REGEXP '^W-[0-9]+$'");
    const code = req.body.worker_code || `W-${String((n.n || 0) + 1).padStart(5, '0')}`;
    const [[jp]] = await conn.query('SELECT title, category FROM job_profiles WHERE id = ?', [c.job_profile_id || 0]);
    const [r] = await conn.query(
      `INSERT INTO workers (worker_code, first_name, last_name, national_id, phone, email, job_position, category, status, deployment_status, candidate_id)
       VALUES (?,?,?,?,?,?,?,?, 'active', 'available', ?)`,
      [code, c.first_name, c.last_name, c.national_id, c.phone, c.email, jp ? jp.title : null, jp ? jp.category : null, c.id]);
    await conn.query("UPDATE candidates SET status = 'hired', worker_id = ? WHERE id = ?", [r.insertId, c.id]);
    await audit(req, 'hire', 'candidate', c.id, { worker_id: r.insertId, worker_code: code }, conn);
    return r.insertId;
  });
  res.status(201).json({ worker_id: workerId });
}));

module.exports = router;
