const db = require('./db');

async function getSettings() {
  const rows = await db.query('SELECT setting_key, setting_value FROM settings');
  return Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value]));
}

// Pay for one assignment over a period.
// Hourly rate: normal hours x rate + overtime hours x rate x overtime multiplier.
// Daily rate:  days present x rate + overtime hours x (rate / standard hours) x overtime multiplier.
function computePay(row, settings) {
  const mult = Number(settings.overtime_multiplier || 1.5);
  const std = Number(settings.standard_hours_per_day || 8);
  const rate = Number(row.pay_rate || 0);
  const hourly = row.pay_rate_type === 'hourly' ? rate : rate / std;
  const normal = row.pay_rate_type === 'hourly' ? Number(row.normal_hours) * rate : Number(row.days_present) * rate;
  const overtime = Number(row.overtime_hours) * hourly * mult;
  const r2 = (n) => Math.round(n * 100) / 100;
  return { normal_pay: r2(normal), overtime_pay: r2(overtime), total_pay: r2(normal + overtime) };
}

module.exports = { getSettings, computePay };
