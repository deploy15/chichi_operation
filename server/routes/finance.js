// Catering expenses and how they are shared out to Client -> Project -> Site.
const express = require('express');
const db = require('../lib/db');
const { crud } = require('../lib/crud');
const { audit } = require('../lib/audit');
const { requirePerm, siteFilter } = require('../lib/auth');
const { wrap, bad, notFound, isDate } = require('../lib/http');

const router = express.Router();

crud(router, '/finance/expenses', {
  table: 'catering_expenses', entity: 'catering_expense', view: ['finance.view', 'catering.manage'], manage: ['finance.manage', 'catering.manage'],
  select: `t.*, k.name AS kitchen_name,
           COALESCE((SELECT SUM(a.amount) FROM catering_cost_allocations a WHERE a.expense_id = t.id), 0) AS allocated_amount,
           (SELECT MIN(a.method) FROM catering_cost_allocations a WHERE a.expense_id = t.id) AS allocation_method`,
  from: 'catering_expenses t LEFT JOIN kitchens k ON k.id = t.kitchen_id',
  filters: { kitchen_id: 't.kitchen_id', category: 't.category' }, search: ['t.supplier', 't.description', 't.reference'],
  orderBy: 't.expense_date DESC, t.id DESC', allowDelete: true,
  fields: {
    kitchen_id: { type: 'int' },
    expense_date: { type: 'date', required: true, label: 'Date' },
    category: { type: 'enum', required: true, values: ['food', 'supplier', 'transport', 'fuel', 'staff', 'energy', 'equipment', 'other'], label: 'Category' },
    supplier: { type: 'string', max: 150 },
    description: { type: 'string', max: 255 },
    amount: { type: 'number', required: true, min: 0, label: 'Amount' },
    reference: { type: 'string', max: 80 },
  },
});

router.get('/finance/expenses/:id(\\d+)/allocations', requirePerm('finance.view', 'catering.manage'), wrap(async (req, res) => {
  res.json(await db.query(
    `SELECT a.*, c.name AS client_name, p.name AS project_name, s.name AS site_name FROM catering_cost_allocations a
       JOIN clients c ON c.id = a.client_id JOIN projects p ON p.id = a.project_id JOIN sites s ON s.id = a.site_id
      WHERE a.expense_id = ? ORDER BY c.name, p.name, s.name`, [req.params.id]));
}));

// Splits `total` by weights, rounding to cents so the parts always add up exactly to the total.
function split(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  const cents = Math.round(total * 100);
  const parts = weights.map((w) => Math.floor((cents * w) / sum));
  let rest = cents - parts.reduce((a, b) => a + b, 0);
  for (let i = 0; rest > 0; i = (i + 1) % parts.length, rest--) parts[i]++;
  return parts.map((p) => p / 100);
}

// Methods: direct (all to one site), meal_count (by meals required at each site served by the
// expense's kitchen during the period), percentage, manual (amounts typed in).
router.post('/finance/expenses/:id(\\d+)/allocate', requirePerm('finance.manage'), wrap(async (req, res) => {
  const exp = await db.one('SELECT * FROM catering_expenses WHERE id = ?', [req.params.id]);
  if (!exp) throw notFound('Expense');
  const { method } = req.body || {};
  const amount = Number(exp.amount);
  let lines = [];

  if (method === 'direct') {
    if (!req.body.site_id) throw bad('Choose the site that receives the full cost');
    lines = [{ site_id: Number(req.body.site_id), amount, percentage: 100 }];
  } else if (method === 'percentage') {
    const input = (req.body.lines || []).filter((l) => l.site_id && Number(l.percentage) > 0);
    const total = input.reduce((a, l) => a + Number(l.percentage), 0);
    if (!input.length || Math.abs(total - 100) > 0.01) throw bad(`Percentages must add up to 100 (currently ${total})`);
    const amounts = split(amount, input.map((l) => Number(l.percentage)));
    lines = input.map((l, i) => ({ site_id: Number(l.site_id), percentage: Number(l.percentage), amount: amounts[i] }));
  } else if (method === 'manual') {
    const input = (req.body.lines || []).filter((l) => l.site_id && Number(l.amount) > 0);
    const total = Math.round(input.reduce((a, l) => a + Number(l.amount), 0) * 100) / 100;
    if (!input.length || Math.abs(total - amount) > 0.001) throw bad(`Amounts must add up to ${amount.toFixed(2)} (currently ${total.toFixed(2)})`);
    lines = input.map((l) => ({ site_id: Number(l.site_id), amount: Number(l.amount), percentage: (Number(l.amount) / amount) * 100 }));
  } else if (method === 'meal_count') {
    const month = exp.expense_date.slice(0, 7);
    const from = isDate(req.body.from) ? req.body.from : `${month}-01`;
    const to = isDate(req.body.to) ? req.body.to : new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
    const params = [from, to];
    let kitchenSql = '';
    if (exp.kitchen_id) { kitchenSql = 'AND kitchen_id = ?'; params.push(exp.kitchen_id); }
    const meals = await db.query(
      `SELECT site_id, SUM(required_qty) AS meals FROM meal_orders WHERE service_date BETWEEN ? AND ? ${kitchenSql}
        GROUP BY site_id HAVING meals > 0`, params);
    if (!meals.length) throw bad(`No meals were recorded between ${from} and ${to}${exp.kitchen_id ? ' for this kitchen' : ''}, so the cost cannot be shared by meal count`);
    const amounts = split(amount, meals.map((m) => Number(m.meals)));
    const totalMeals = meals.reduce((a, m) => a + Number(m.meals), 0);
    lines = meals.map((m, i) => ({ site_id: m.site_id, amount: amounts[i], percentage: (Number(m.meals) / totalMeals) * 100 }));
  } else {
    throw bad('Method must be direct, meal_count, percentage or manual');
  }

  await db.tx(async (conn) => {
    await conn.query('DELETE FROM catering_cost_allocations WHERE expense_id = ?', [exp.id]);
    for (const l of lines) {
      const [[site]] = await conn.query('SELECT s.id, s.project_id, p.client_id FROM sites s JOIN projects p ON p.id = s.project_id WHERE s.id = ?', [l.site_id]);
      if (!site) throw bad(`Site ${l.site_id} not found`);
      await conn.query(
        'INSERT INTO catering_cost_allocations (expense_id, client_id, project_id, site_id, method, percentage, amount, created_by) VALUES (?,?,?,?,?,?,?,?)',
        [exp.id, site.client_id, site.project_id, site.id, method, Math.round(l.percentage * 10000) / 10000, l.amount, req.user.id]);
    }
    await audit(req, 'allocate', 'catering_expense', exp.id, { method, lines }, conn);
  });
  res.json({ ok: true, lines });
}));

// Cost report: allocated catering cost by client, project and site
router.get('/finance/costs', requirePerm('finance.view'), wrap(async (req, res) => {
  const from = isDate(req.query.from) ? req.query.from : '1970-01-01';
  const to = isDate(req.query.to) ? req.query.to : '9999-12-31';
  const s = siteFilter(req.user, 'a.site_id');
  const rows = await db.query(
    `SELECT c.id AS client_id, c.name AS client_name, p.id AS project_id, p.name AS project_name, s.id AS site_id, s.name AS site_name,
            SUM(a.amount) AS amount
       FROM catering_cost_allocations a JOIN catering_expenses e ON e.id = a.expense_id
       JOIN clients c ON c.id = a.client_id JOIN projects p ON p.id = a.project_id JOIN sites s ON s.id = a.site_id
      WHERE e.expense_date BETWEEN ? AND ? AND ${s.sql}
      GROUP BY c.id, c.name, p.id, p.name, s.id, s.name ORDER BY c.name, p.name, s.name`, [from, to, ...s.params]);
  const totals = await db.one(
    `SELECT COALESCE(SUM(e.amount), 0) AS total_expenses,
            COALESCE(SUM(e.amount - COALESCE((SELECT SUM(a.amount) FROM catering_cost_allocations a WHERE a.expense_id = e.id), 0)), 0) AS unallocated
       FROM catering_expenses e WHERE e.expense_date BETWEEN ? AND ?`, [from, to]);
  const byCategory = await db.query('SELECT category, SUM(amount) AS amount FROM catering_expenses WHERE expense_date BETWEEN ? AND ? GROUP BY category ORDER BY amount DESC', [from, to]);
  res.json({ rows, totals, by_category: byCategory });
}));

module.exports = router;
