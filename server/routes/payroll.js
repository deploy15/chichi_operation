// Payroll figures calculated from attendance (attendance is entered once and reused here).
const express = require('express');
const db = require('../lib/db');
const { requirePerm, siteFilter } = require('../lib/auth');
const { getSettings, computePay } = require('../lib/settings');
const { wrap, isDate, today } = require('../lib/http');

const router = express.Router();

async function payrollRows(user, { from, to, siteId, projectId, validatedOnly }) {
  const s = siteFilter(user, 'a.site_id');
  const where = ['a.work_date BETWEEN ? AND ?', s.sql];
  const params = [from, to, ...s.params];
  if (validatedOnly) where.push('a.validated = 1');
  if (siteId) { where.push('a.site_id = ?'); params.push(siteId); }
  if (projectId) { where.push('a.project_id = ?'); params.push(projectId); }
  const rows = await db.query(
    `SELECT wa.id AS assignment_id, w.id AS worker_id, w.worker_code, CONCAT(w.first_name, ' ', w.last_name) AS worker_name,
            s.name AS site_name, p.name AS project_name, c.name AS client_name, wa.pay_rate, wa.pay_rate_type,
            SUM(a.status = 'present') AS days_present, SUM(a.status = 'absent') AS days_absent,
            SUM(a.late_arrival) AS late_count, SUM(a.early_departure) AS early_count,
            SUM(a.normal_hours) AS normal_hours, SUM(a.overtime_hours) AS overtime_hours, SUM(a.validated = 0) AS days_not_validated
       FROM attendance a JOIN worker_assignments wa ON wa.id = a.assignment_id JOIN workers w ON w.id = a.worker_id
       JOIN sites s ON s.id = a.site_id JOIN projects p ON p.id = a.project_id JOIN clients c ON c.id = p.client_id
      WHERE ${where.join(' AND ')}
      GROUP BY wa.id, w.id, w.worker_code, worker_name, s.name, p.name, c.name, wa.pay_rate, wa.pay_rate_type
      ORDER BY c.name, p.name, s.name, worker_name`, params);
  const settings = await getSettings();
  return rows.map((r) => ({ ...r, ...computePay(r, settings) }));
}

router.get('/payroll', requirePerm('payroll.view'), wrap(async (req, res) => {
  const t = today();
  const from = isDate(req.query.from) ? req.query.from : `${t.slice(0, 7)}-01`;
  const to = isDate(req.query.to) ? req.query.to : t;
  const rows = await payrollRows(req.user, {
    from, to, siteId: req.query.site_id, projectId: req.query.project_id, validatedOnly: req.query.validated_only !== '0',
  });
  const totals = rows.reduce((acc, r) => {
    for (const k of ['days_present', 'normal_hours', 'overtime_hours', 'normal_pay', 'overtime_pay', 'total_pay']) acc[k] = Math.round(((acc[k] || 0) + Number(r[k])) * 100) / 100;
    return acc;
  }, {});
  res.json({ from, to, rows, totals });
}));

module.exports = router;
module.exports.payrollRows = payrollRows;
