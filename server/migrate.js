// Creates or updates the database tables and the default data (permissions, roles, settings,
// company and first administrator). Safe to run many times. Heroku runs it on every deploy.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const { config } = require('./lib/db');
const { PERMISSIONS, ROLES, RETIRED_ROLES, FULL_ACCESS_ROLE, DEFAULT_SETTINGS } = require('./lib/permissions');

// Columns added after the first version. Added to older databases if missing.
const NEW_COLUMNS = [
  ['workers', 'deployment_status', "ENUM('available','deployed','absent','unassigned') NOT NULL DEFAULT 'unassigned' AFTER status"],
  ['workers', 'daily_allowance', 'DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER pay_rate_type'],
  ['workers', 'contract_type', 'VARCHAR(40) NULL'],
  ['workers', 'contract_start', 'DATE NULL'],
  ['workers', 'contract_end', 'DATE NULL'],
  ['workers', 'cnss_number', 'VARCHAR(40) NULL'],
  ['workers', 'insurance_provider', 'VARCHAR(120) NULL'],
  ['workers', 'insurance_policy', 'VARCHAR(60) NULL'],
  ['workers', 'insurance_expiry', 'DATE NULL'],
  ['workers', 'candidate_id', 'INT UNSIGNED NULL'],
  ['worker_assignments', 'assignment_type', "ENUM('regular','replacement') NOT NULL DEFAULT 'regular' AFTER status"],
  ['worker_assignments', 'replaces_worker_id', 'INT UNSIGNED NULL AFTER assignment_type'],
  ['worker_assignments', 'staffing_request_id', 'INT UNSIGNED NULL AFTER replaces_worker_id'],
  ['meal_plans', 'menu_id', 'INT UNSIGNED NULL AFTER planned_qty'],
  ['production_batches', 'quality_status', "ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending' AFTER rejected_qty"],
  ['production_batches', 'quality_checked_by', 'INT UNSIGNED NULL AFTER quality_status'],
  ['production_batches', 'quality_checked_at', 'DATETIME NULL AFTER quality_checked_by'],
  ['production_batches', 'quality_notes', 'VARCHAR(255) NULL AFTER quality_checked_at'],
  ['dispatches', 'planned_qty', 'INT UNSIGNED NOT NULL DEFAULT 0 AFTER meal_type'],
  ['dispatches', 'planned_departure', 'DATETIME NULL AFTER planned_qty'],
  ['dispatches', 'loaded_qty', 'INT UNSIGNED NULL AFTER dispatched_qty'],
  ['dispatches', 'validated_by', 'INT UNSIGNED NULL'],
  ['dispatches', 'validated_at', 'DATETIME NULL'],
  ['dispatches', 'loaded_by', 'INT UNSIGNED NULL'],
  ['dispatches', 'loaded_at', 'DATETIME NULL'],
  ['dispatches', 'delivered_by', 'INT UNSIGNED NULL'],
  ['dispatches', 'delivered_at', 'DATETIME NULL'],
  ['catering_expenses', 'document_type', "ENUM('invoice','purchase_order','delivery_note','receipt','other') NOT NULL DEFAULT 'invoice' AFTER reference"],
  ['catering_expenses', 'approval_status', "ENUM('pending','validated','rejected') NOT NULL DEFAULT 'pending' AFTER document_type"],
  ['catering_expenses', 'approved_by', 'INT UNSIGNED NULL AFTER approval_status'],
  ['catering_expenses', 'approved_at', 'DATETIME NULL AFTER approved_by'],
  ['catering_expenses', 'approval_notes', 'VARCHAR(255) NULL AFTER approved_at'],
  ['catering_expenses', 'purchase_request_id', 'INT UNSIGNED NULL AFTER approval_notes'],
  ['hse_corrective_actions', 'approved_by', 'INT UNSIGNED NULL AFTER completed_at'],
  ['hse_corrective_actions', 'approved_at', 'DATETIME NULL AFTER approved_by'],
  ['settings', 'edit_permission', "VARCHAR(60) NOT NULL DEFAULT 'settings.manage'"],
];

async function upgradeColumns(conn, log) {
  for (const [table, column, def] of NEW_COLUMNS) {
    const [rows] = await conn.query(
      'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [table, column]);
    if (!rows.length) {
      await conn.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
      log(`Added ${table}.${column}`);
    }
  }
  // Dispatch steps changed from prepared/dispatched/received to planned/validated/loaded/delivered/received
  const [[col]] = await conn.query(
    "SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dispatches' AND COLUMN_NAME = 'status'");
  if (col && col.t.includes("'prepared'")) {
    await conn.query("ALTER TABLE dispatches MODIFY status ENUM('prepared','dispatched','planned','validated','loaded','delivered','received','cancelled') NOT NULL DEFAULT 'planned'");
    await conn.query("UPDATE dispatches SET status = 'validated', planned_qty = dispatched_qty WHERE status = 'prepared'");
    await conn.query("UPDATE dispatches SET status = 'loaded', planned_qty = dispatched_qty, loaded_qty = dispatched_qty, loaded_at = dispatched_at WHERE status = 'dispatched'");
    await conn.query("UPDATE dispatches SET planned_qty = dispatched_qty, loaded_qty = COALESCE(loaded_qty, dispatched_qty) WHERE status = 'received'");
    await conn.query("ALTER TABLE dispatches MODIFY status ENUM('planned','validated','loaded','delivered','received','cancelled') NOT NULL DEFAULT 'planned'");
    // Batches recorded before quality checks existed count as approved
    await conn.query("UPDATE production_batches SET quality_status = 'approved' WHERE quality_checked_at IS NULL AND quality_status = 'pending' AND created_at < NOW()");
    log('Converted existing deliveries to the new delivery steps.');
  }
}

async function migrate({ quiet = false } = {}) {
  const log = (...a) => !quiet && console.log(...a);
  const conn = await mysql.createConnection(config({ multipleStatements: true }));
  try {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8');
    await conn.query(schema);
    await upgradeColumns(conn, log);
    log('Tables are up to date.');

    for (const [code, module, description] of PERMISSIONS) {
      await conn.query(
        'INSERT INTO permissions (code, module, description) VALUES (?,?,?) ON DUPLICATE KEY UPDATE module=VALUES(module), description=VALUES(description)',
        [code, module, description]);
    }
    // Permissions that no longer exist are removed (and taken away from every role)
    await conn.query('DELETE FROM permissions WHERE code NOT IN (?)', [PERMISSIONS.map((p) => p[0])]);

    // The old full-access role becomes the Managing Director role, so existing administrators keep full access
    const [[oldAdmin]] = await conn.query("SELECT id FROM roles WHERE name = 'Super Administrator'");
    const [[md]] = await conn.query('SELECT id FROM roles WHERE name = ?', [FULL_ACCESS_ROLE]);
    if (oldAdmin && !md) {
      await conn.query('UPDATE roles SET name = ?, description = ? WHERE id = ?', [FULL_ACCESS_ROLE, ROLES[FULL_ACCESS_ROLE].description, oldAdmin.id]);
      log(`Renamed Super Administrator to ${FULL_ACCESS_ROLE}`);
    }

    // Default roles are only filled in when first created, so later edits made on screen are kept.
    for (const [name, role] of Object.entries(ROLES)) {
      const [existing] = await conn.query('SELECT id FROM roles WHERE name = ?', [name]);
      if (!existing.length) {
        const [r] = await conn.query('INSERT INTO roles (name, description, is_system) VALUES (?,?,1)', [name, role.description]);
        await conn.query('INSERT IGNORE INTO role_permissions (role_id, permission_id) SELECT ?, id FROM permissions WHERE code IN (?)', [r.insertId, role.perms]);
        log(`Created role: ${name}`);
      }
    }
    // Roles from the first version that nobody uses any more are removed
    const [retired] = await conn.query(
      'SELECT r.id, r.name FROM roles r WHERE r.name IN (?) AND NOT EXISTS (SELECT 1 FROM users u WHERE u.role_id = r.id)', [RETIRED_ROLES]);
    for (const r of retired) {
      await conn.query('DELETE FROM roles WHERE id = ?', [r.id]);
      log(`Removed unused old role: ${r.name}`);
    }
    // The Managing Director always has every permission, including newly added ones.
    await conn.query(
      `INSERT IGNORE INTO role_permissions (role_id, permission_id)
       SELECT r.id, p.id FROM roles r CROSS JOIN permissions p WHERE r.name = ?`, [FULL_ACCESS_ROLE]);

    for (const [key, value, description, perm] of DEFAULT_SETTINGS) {
      await conn.query(
        `INSERT INTO settings (setting_key, setting_value, description, edit_permission) VALUES (?,?,?,?)
         ON DUPLICATE KEY UPDATE description = VALUES(description), edit_permission = VALUES(edit_permission)`, [key, value, description, perm]);
    }

    const [companies] = await conn.query('SELECT id FROM companies LIMIT 1');
    if (!companies.length) {
      await conn.query('INSERT INTO companies (name) VALUES (?)', [process.env.COMPANY_NAME || 'My Company']);
      log('Created company record.');
    }

    const [users] = await conn.query('SELECT id FROM users LIMIT 1');
    if (!users.length) {
      const email = process.env.ADMIN_EMAIL || 'admin@example.com';
      const password = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
      const [[role]] = await conn.query('SELECT id FROM roles WHERE name = ?', [FULL_ACCESS_ROLE]);
      await conn.query('INSERT INTO users (name, email, password_hash, role_id) VALUES (?,?,?,?)',
        [process.env.ADMIN_NAME || 'Managing Director', email.toLowerCase(), await bcrypt.hash(password, 10), role.id]);
      log(`Created first administrator: ${email} (change the password after first sign-in).`);
    }
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  migrate().then(() => { console.log('Database ready.'); process.exit(0); })
    .catch((e) => { console.error('Database setup failed:', e.message); process.exit(1); });
}
module.exports = { migrate };
