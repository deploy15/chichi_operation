// Dashboard. Each section only appears if the user's role allows it, and figures are limited
// to the sites and kitchens the user may see.
const express = require('express');
const db = require('../lib/db');
const { requirePerm, siteFilter, kitchenFilter } = require('../lib/auth');
const { payrollRows } = require('./payroll');
const { getSettings } = require('../lib/settings');
const { wrap, isDate, today } = require('../lib/http');

const router = express.Router();
const num = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Number(v)]));

router.get('/dashboard', requirePerm('dashboard.view'), wrap(async (req, res) => {
  const u = req.user;
  const date = isDate(req.query.date) ? req.query.date : today();
  const out = { date };
  const s = siteFilter(u, 'wa.site_id');
  const activeAsg = `wa.status <> 'cancelled' AND wa.start_date <= ? AND (wa.end_date IS NULL OR wa.end_date >= ?) AND ${s.sql}`;
  const ap = [date, date, ...s.params];

  if (u.can('workers.view') || u.can('attendance.view')) {
    const [{ n }] = await db.query(
      `SELECT COUNT(DISTINCT wa.worker_id) AS n FROM worker_assignments wa JOIN workers w ON w.id = wa.worker_id
        WHERE w.status = 'active' AND ${activeAsg}`, ap);
    out.workforce = {
      active_workers: n,
      by_client: await db.query(`SELECT c.name AS label, COUNT(DISTINCT wa.worker_id) AS value FROM worker_assignments wa
        JOIN projects p ON p.id = wa.project_id JOIN clients c ON c.id = p.client_id WHERE ${activeAsg} GROUP BY c.id, c.name ORDER BY value DESC`, ap),
      by_project: await db.query(`SELECT p.name AS label, COUNT(DISTINCT wa.worker_id) AS value FROM worker_assignments wa
        JOIN projects p ON p.id = wa.project_id WHERE ${activeAsg} GROUP BY p.id, p.name ORDER BY value DESC`, ap),
      by_site: await db.query(`SELECT st.name AS label, COUNT(DISTINCT wa.worker_id) AS value FROM worker_assignments wa
        JOIN sites st ON st.id = wa.site_id WHERE ${activeAsg} GROUP BY st.id, st.name ORDER BY value DESC`, ap),
    };
    if (u.can('workers.view')) {
      out.workforce.by_status = await db.query("SELECT deployment_status AS label, COUNT(*) AS value FROM workers WHERE status = 'active' GROUP BY deployment_status ORDER BY value DESC");
    }
  }

  if (u.can('attendance.view')) {
    const as = siteFilter(u, 'a.site_id');
    const t = await db.one(
      `SELECT COALESCE(SUM(a.status = 'present'), 0) AS present, COALESCE(SUM(a.status = 'absent'), 0) AS absent,
              COALESCE(SUM(a.late_arrival), 0) AS late, COALESCE(SUM(a.early_departure), 0) AS early_departure,
              COALESCE(SUM(a.normal_hours), 0) AS normal_hours, COALESCE(SUM(a.overtime_hours), 0) AS overtime_hours,
              COALESCE(SUM(a.validated = 0), 0) AS not_validated
         FROM attendance a WHERE a.work_date = ? AND ${as.sql}`, [date, ...as.params]);
    const [{ expected }] = await db.query(`SELECT COUNT(*) AS expected FROM worker_assignments wa WHERE ${activeAsg}`, ap);
    out.attendance = { ...num(t), expected, not_recorded: Math.max(expected - Number(t.present) - Number(t.absent), 0) };
    out.attendance.by_site = await db.query(
      `SELECT st.name AS label, SUM(a.status = 'present') AS present, SUM(a.status = 'absent') AS absent, SUM(a.overtime_hours) AS overtime
         FROM attendance a JOIN sites st ON st.id = a.site_id WHERE a.work_date = ? AND ${as.sql} GROUP BY st.id, st.name ORDER BY st.name`, [date, ...as.params]);
    const rs = siteFilter(u, 'st.id');
    const settings = await getSettings();
    out.daily_reports = {
      deadline: settings.daily_report_deadline,
      ...num(await db.one(
        `SELECT COUNT(*) AS sites, COALESCE(SUM(r.id IS NOT NULL), 0) AS submitted, COALESCE(SUM(r.on_time = 1), 0) AS on_time
           FROM sites st LEFT JOIN site_daily_reports r ON r.site_id = st.id AND r.report_date = ? WHERE st.status = 'active' AND ${rs.sql}`, [date, ...rs.params])),
    };
  }

  if (u.can('catering.view')) {
    const ms = siteFilter(u, 'mo.site_id');
    out.catering = {
      meals: await db.query(`SELECT mo.meal_type AS label, SUM(mo.required_qty) AS value FROM meal_orders mo
        WHERE mo.service_date = ? AND ${ms.sql} GROUP BY mo.meal_type`, [date, ...ms.params]),
      kitchens: await db.query("SELECT kitchen_type AS label, COUNT(*) AS value FROM kitchens WHERE status = 'active' GROUP BY kitchen_type"),
      open_feedback: (await db.one("SELECT COUNT(*) AS n FROM operation_logs WHERE status = 'open'")).n,
      batches_to_check: (await db.one("SELECT COUNT(*) AS n FROM production_batches WHERE quality_status = 'pending'")).n,
    };
  }

  if (u.can('kitchen.view')) {
    const ks = kitchenFilter(u, 'mp.kitchen_id');
    out.kitchen = num(await db.one(
      `SELECT COALESCE(SUM(mp.planned_qty), 0) AS planned,
              COALESCE(SUM((SELECT SUM(produced_qty) FROM production_batches b WHERE b.meal_plan_id = mp.id)), 0) AS produced,
              COALESCE(SUM((SELECT SUM(produced_qty - rejected_qty) FROM production_batches b WHERE b.meal_plan_id = mp.id AND b.quality_status = 'approved')), 0) AS approved
         FROM meal_plans mp WHERE mp.service_date = ? AND ${ks.sql}`, [date, ...ks.params]));
    const ds = kitchenFilter(u, 'd.kitchen_id');
    out.deliveries = await db.query(`SELECT d.status AS label, COUNT(*) AS value FROM dispatches d WHERE d.service_date = ? AND ${ds.sql} GROUP BY d.status`, [date, ...ds.params]);
  }

  if (u.can('meals.receive') && !u.can('catering.view')) {
    const ds = siteFilter(u, 'd.site_id');
    out.site_meals = num(await db.one(
      `SELECT COALESCE(SUM(d.status IN ('loaded','delivered')), 0) AS awaiting_receipt, COALESCE(SUM(d.status = 'received'), 0) AS received
         FROM dispatches d WHERE d.service_date = ? AND ${ds.sql}`, [date, ...ds.params]));
  }

  if (u.can('staffing.manage') || u.can('staffing.request')) {
    const ss = siteFilter(u, 'r.site_id');
    out.staffing = await db.query(`SELECT r.status AS label, COUNT(*) AS value, SUM(r.quantity) AS workers FROM staffing_requests r
      WHERE r.status NOT IN ('filled','cancelled') AND ${ss.sql} GROUP BY r.status`, ss.params);
  }
  if (u.can('recruitment.manage') || u.can('recruitment.verify') || u.can('recruitment.approve')) {
    out.recruitment = await db.query("SELECT status AS label, COUNT(*) AS value FROM candidates WHERE status NOT IN ('hired','rejected') GROUP BY status");
  }

  if (u.can('hse.view')) {
    const hs = siteFilter(u, 'i.site_id');
    out.hse = num(await db.one(
      `SELECT COALESCE(SUM(i.status <> 'closed'), 0) AS open_incidents,
              COALESCE(SUM(i.status <> 'closed' AND i.severity IN ('high','critical')), 0) AS open_serious,
              (SELECT COUNT(*) FROM hse_corrective_actions ca JOIN hse_incidents i2 ON i2.id = ca.incident_id
                WHERE ca.status <> 'done' AND ca.due_date < CURDATE() AND ${hs.sql.replace(/i\./g, 'i2.')}) AS overdue_actions,
              COALESCE(SUM(i.occurred_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)), 0) AS last_30_days
         FROM hse_incidents i WHERE ${hs.sql}`, [...hs.params, ...hs.params]));
  }

  if (u.can('accommodation.view')) {
    const r = await db.one(
      `SELECT COALESCE(SUM(capacity), 0) AS capacity,
              (SELECT COUNT(*) FROM room_occupancies WHERE check_out_date IS NULL) AS occupied
         FROM accommodation_rooms WHERE status = 'available'`);
    out.accommodation = { capacity: Number(r.capacity), occupied: Number(r.occupied), available: Math.max(Number(r.capacity) - Number(r.occupied), 0) };
  }

  if (u.can('payroll.view')) {
    const rows = await payrollRows(u, { from: `${date.slice(0, 7)}-01`, to: date, validatedOnly: false });
    out.payroll = {
      period: `${date.slice(0, 7)}-01 to ${date}`,
      workers_paid: new Set(rows.map((r) => r.worker_id)).size,
      normal_hours: rows.reduce((a, r) => a + Number(r.normal_hours), 0),
      overtime_hours: rows.reduce((a, r) => a + Number(r.overtime_hours), 0),
      estimated_cost: Math.round(rows.reduce((a, r) => a + r.total_pay, 0) * 100) / 100,
    };
  }

  if (u.can('finance.view')) {
    out.finance = num(await db.one(
      'SELECT COALESCE(SUM(amount), 0) AS month_expenses FROM catering_expenses WHERE expense_date BETWEEN ? AND ?', [`${date.slice(0, 7)}-01`, date]));
  }

  if (u.can('medical.view')) {
    out.medical = await db.one(
      `SELECT (SELECT COUNT(*) FROM medical_records WHERE record_type = 'appointment' AND status = 'scheduled' AND record_date >= CURDATE()) AS upcoming_appointments,
              (SELECT COUNT(*) FROM medical_records WHERE valid_until BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 30 DAY)) AS expiring_soon,
              (SELECT COUNT(*) FROM medical_records WHERE record_type = 'incident_followup' AND status = 'open') AS open_followups`);
  }

  // Things waiting for this user's approval
  const approvals = [];
  const add = async (label, link, sql, params = []) => { const r = await db.one(sql, params); if (Number(r.n)) approvals.push({ label, link, count: Number(r.n) }); };
  if (u.can('approvals.major')) await add('Major purchase requests', '/purchases', "SELECT COUNT(*) AS n FROM purchase_requests WHERE status = 'submitted' AND requires_major_approval = 1");
  if (u.can('purchases.approve')) await add('Purchase requests', '/purchases', "SELECT COUNT(*) AS n FROM purchase_requests WHERE status = 'submitted' AND requires_major_approval = 0");
  if (u.can('expenses.approve') || u.can('approvals.major')) {
    const limit = Number((await getSettings()).major_expense_threshold || 0);
    if (u.can('expenses.approve')) await add('Invoices and delivery notes to validate', '/finance', "SELECT COUNT(*) AS n FROM catering_expenses WHERE approval_status = 'pending' AND amount <= ?", [limit]);
    if (u.can('approvals.major')) await add('Major expenses to validate', '/finance', "SELECT COUNT(*) AS n FROM catering_expenses WHERE approval_status = 'pending' AND amount > ?", [limit]);
  }
  if (u.can('budgets.approve')) await add('Budgets to approve', '/finance', "SELECT COUNT(*) AS n FROM budgets WHERE status = 'draft'");
  if (u.can('hse.approve')) await add('Corrective actions to approve', '/hse', "SELECT COUNT(*) AS n FROM hse_corrective_actions WHERE status = 'done' AND approved_at IS NULL");
  if (u.can('recruitment.verify')) await add('Candidate documents to verify', '/recruitment', "SELECT COUNT(*) AS n FROM candidates WHERE status = 'registered'");
  if (u.can('recruitment.approve')) await add('Candidates to approve', '/recruitment', "SELECT COUNT(*) AS n FROM candidates WHERE status = 'documents_verified'");
  if (u.can('quality.validate')) await add('Production batches to quality-check', '/catering', "SELECT COUNT(*) AS n FROM production_batches WHERE quality_status = 'pending'");
  if (u.can('dispatch.plan')) await add('Deliveries to validate', '/catering', "SELECT COUNT(*) AS n FROM dispatches WHERE status = 'planned'");
  if (u.can('staffing.manage')) await add('Staffing requests from sites', '/staffing', "SELECT COUNT(*) AS n FROM staffing_requests WHERE status = 'forwarded'");
  if (u.can('attendance.validate')) {
    const cs = siteFilter(u, 'a.site_id');
    await add('Offline attendance conflicts', '/attendance?tab=conflicts',
      `SELECT COUNT(*) AS n FROM sync_conflicts c JOIN attendance a ON a.id = c.attendance_id WHERE c.status = 'open' AND ${cs.sql}`, cs.params);
  }
  out.approvals = approvals;
  res.json(out);
}));

module.exports = router;
