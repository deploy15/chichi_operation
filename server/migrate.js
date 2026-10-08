// Creates or updates the database tables and the default data (permissions, roles, settings,
// company and first administrator). Safe to run many times. Heroku runs it on every deploy.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const { config } = require('./lib/db');
const { PERMISSIONS, ROLES, DEFAULT_SETTINGS } = require('./lib/permissions');

async function migrate({ quiet = false } = {}) {
  const log = (...a) => !quiet && console.log(...a);
  const conn = await mysql.createConnection(config({ multipleStatements: true }));
  try {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8');
    await conn.query(schema);
    log('Tables are up to date.');

    for (const [code, module, description] of PERMISSIONS) {
      await conn.query(
        'INSERT INTO permissions (code, module, description) VALUES (?,?,?) ON DUPLICATE KEY UPDATE module=VALUES(module), description=VALUES(description)',
        [code, module, description]);
    }
    // Default roles are only filled in when first created, so later edits made on screen are kept.
    for (const [name, role] of Object.entries(ROLES)) {
      const [existing] = await conn.query('SELECT id FROM roles WHERE name = ?', [name]);
      let roleId = existing[0] && existing[0].id;
      if (!roleId) {
        const [r] = await conn.query('INSERT INTO roles (name, description, is_system) VALUES (?,?,1)', [name, role.description]);
        roleId = r.insertId;
        await conn.query(
          'INSERT IGNORE INTO role_permissions (role_id, permission_id) SELECT ?, id FROM permissions WHERE code IN (?)', [roleId, role.perms]);
        log(`Created role: ${name}`);
      }
    }
    // The Super Administrator always has every permission, including newly added ones.
    await conn.query(
      `INSERT IGNORE INTO role_permissions (role_id, permission_id)
       SELECT r.id, p.id FROM roles r CROSS JOIN permissions p WHERE r.name = 'Super Administrator'`);

    for (const [key, value, description] of DEFAULT_SETTINGS) {
      await conn.query('INSERT IGNORE INTO settings (setting_key, setting_value, description) VALUES (?,?,?)', [key, value, description]);
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
      const [[role]] = await conn.query("SELECT id FROM roles WHERE name = 'Super Administrator'");
      await conn.query('INSERT INTO users (name, email, password_hash, role_id) VALUES (?,?,?,?)',
        [process.env.ADMIN_NAME || 'System Administrator', email.toLowerCase(), await bcrypt.hash(password, 10), role.id]);
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
