// Users, roles, permissions, settings and the audit log.
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../lib/db');
const { audit } = require('../lib/audit');
const { requirePerm } = require('../lib/auth');
const { wrap, bad, notFound } = require('../lib/http');

const router = express.Router();
const admin = requirePerm('users.manage');

const USER_SELECT = `SELECT u.id, u.name, u.email, u.active, u.role_id, r.name AS role_name, u.last_login_at, u.created_at,
  (SELECT GROUP_CONCAT(site_id) FROM user_sites WHERE user_id = u.id) AS site_ids,
  (SELECT GROUP_CONCAT(kitchen_id) FROM user_kitchens WHERE user_id = u.id) AS kitchen_ids
  FROM users u JOIN roles r ON r.id = u.role_id`;
const ids = (s) => (s ? String(s).split(',').map(Number) : []);
const fmtUser = (u) => ({ ...u, site_ids: ids(u.site_ids), kitchen_ids: ids(u.kitchen_ids) });

router.get('/users', admin, wrap(async (req, res) => {
  res.json((await db.query(`${USER_SELECT} ORDER BY u.name`)).map(fmtUser));
}));

async function saveLinks(conn, userId, siteIds, kitchenIds) {
  if (Array.isArray(siteIds)) {
    await conn.query('DELETE FROM user_sites WHERE user_id = ?', [userId]);
    for (const s of siteIds) await conn.query('INSERT INTO user_sites (user_id, site_id) VALUES (?,?)', [userId, s]);
  }
  if (Array.isArray(kitchenIds)) {
    await conn.query('DELETE FROM user_kitchens WHERE user_id = ?', [userId]);
    for (const k of kitchenIds) await conn.query('INSERT INTO user_kitchens (user_id, kitchen_id) VALUES (?,?)', [userId, k]);
  }
}

router.post('/users', admin, wrap(async (req, res) => {
  const { name, email, password, role_id: roleId, site_ids: siteIds, kitchen_ids: kitchenIds } = req.body || {};
  if (!name || !email || !roleId) throw bad('Name, email and role are required');
  if (!password || String(password).length < 8) throw bad('Password must be at least 8 characters');
  const hash = await bcrypt.hash(String(password), 10);
  const id = await db.tx(async (conn) => {
    let r;
    try {
      [r] = await conn.query('INSERT INTO users (name, email, password_hash, role_id, active) VALUES (?,?,?,?,1)', [name, String(email).toLowerCase().trim(), hash, roleId]);
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') throw bad('A user with this email already exists');
      throw e;
    }
    await saveLinks(conn, r.insertId, siteIds, kitchenIds);
    await audit(req, 'create', 'user', r.insertId, { name, email, role_id: roleId, site_ids: siteIds, kitchen_ids: kitchenIds }, conn);
    return r.insertId;
  });
  res.status(201).json(fmtUser(await db.one(`${USER_SELECT} WHERE u.id = ?`, [id])));
}));

router.put('/users/:id(\\d+)', admin, wrap(async (req, res) => {
  const u = await db.one('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!u) throw notFound('User');
  const b = req.body || {};
  if (Number(req.params.id) === req.user.id && (b.active === false || b.active === 0)) throw bad('You cannot deactivate your own account');
  await db.tx(async (conn) => {
    await conn.query('UPDATE users SET name = ?, email = ?, role_id = ?, active = ? WHERE id = ?',
      [b.name ?? u.name, b.email ? String(b.email).toLowerCase().trim() : u.email, b.role_id ?? u.role_id, b.active === undefined ? u.active : (b.active ? 1 : 0), u.id]);
    if (b.password) {
      if (String(b.password).length < 8) throw bad('Password must be at least 8 characters');
      await conn.query('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(String(b.password), 10), u.id]);
    }
    await saveLinks(conn, u.id, b.site_ids, b.kitchen_ids);
    await audit(req, 'update', 'user', u.id, { ...b, password: b.password ? '(changed)' : undefined }, conn);
  });
  res.json(fmtUser(await db.one(`${USER_SELECT} WHERE u.id = ?`, [u.id])));
}));

router.get('/permissions', admin, wrap(async (req, res) => {
  res.json(await db.query('SELECT * FROM permissions ORDER BY module, code'));
}));

router.get('/roles', requirePerm('users.manage'), wrap(async (req, res) => {
  const roles = await db.query(`SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS user_count,
    (SELECT GROUP_CONCAT(p.code) FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = r.id) AS permissions
    FROM roles r ORDER BY r.id`);
  res.json(roles.map((r) => ({ ...r, permissions: r.permissions ? r.permissions.split(',') : [] })));
}));

async function setRolePerms(conn, roleId, codes) {
  await conn.query('DELETE FROM role_permissions WHERE role_id = ?', [roleId]);
  if (codes.length) await conn.query('INSERT INTO role_permissions (role_id, permission_id) SELECT ?, id FROM permissions WHERE code IN (?)', [roleId, codes]);
}

router.post('/roles', admin, wrap(async (req, res) => {
  const { name, description, permissions = [] } = req.body || {};
  if (!name) throw bad('Role name is required');
  const id = await db.tx(async (conn) => {
    let r;
    try { [r] = await conn.query('INSERT INTO roles (name, description) VALUES (?,?)', [name, description || null]); } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') throw bad('A role with this name already exists');
      throw e;
    }
    await setRolePerms(conn, r.insertId, permissions);
    await audit(req, 'create', 'role', r.insertId, { name, permissions }, conn);
    return r.insertId;
  });
  res.status(201).json({ id });
}));

router.put('/roles/:id(\\d+)', admin, wrap(async (req, res) => {
  const role = await db.one('SELECT * FROM roles WHERE id = ?', [req.params.id]);
  if (!role) throw notFound('Role');
  const { name, description, permissions } = req.body || {};
  if (role.name === 'Super Administrator' && ((name && name !== role.name) || permissions)) throw bad('The Super Administrator role always has full access and cannot be changed');
  if (role.id === req.user.role_id && Array.isArray(permissions) && !permissions.includes('users.manage')) {
    throw bad('You cannot remove user management from your own role (you would lock yourself out)');
  }
  await db.tx(async (conn) => {
    await conn.query('UPDATE roles SET name = ?, description = ? WHERE id = ?', [name || role.name, description ?? role.description, role.id]);
    if (Array.isArray(permissions)) await setRolePerms(conn, role.id, permissions);
    await audit(req, 'update', 'role', role.id, { name, description, permissions }, conn);
  });
  res.json({ ok: true });
}));

router.delete('/roles/:id(\\d+)', admin, wrap(async (req, res) => {
  const role = await db.one('SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS n FROM roles r WHERE r.id = ?', [req.params.id]);
  if (!role) throw notFound('Role');
  if (role.name === 'Super Administrator') throw bad('This role cannot be deleted');
  if (role.n > 0) throw bad('Move the users in this role to another role first');
  await db.query('DELETE FROM roles WHERE id = ?', [role.id]);
  await audit(req, 'delete', 'role', role.id, { name: role.name });
  res.json({ ok: true });
}));

router.get('/settings', wrap(async (req, res) => {
  res.json(await db.query('SELECT * FROM settings ORDER BY setting_key'));
}));

router.put('/settings', admin, wrap(async (req, res) => {
  const entries = Object.entries(req.body || {});
  for (const [k, v] of entries) {
    await db.query('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [String(v), k]);
  }
  await audit(req, 'update', 'settings', null, req.body);
  res.json({ ok: true });
}));

router.get('/audit', requirePerm('audit.view'), wrap(async (req, res) => {
  const where = ['1=1']; const params = [];
  if (req.query.entity) { where.push('l.entity = ?'); params.push(req.query.entity); }
  if (req.query.user_id) { where.push('l.user_id = ?'); params.push(req.query.user_id); }
  if (req.query.from) { where.push('l.created_at >= ?'); params.push(req.query.from); }
  if (req.query.to) { where.push('l.created_at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(req.query.to); }
  res.json(await db.query(`SELECT l.*, u.name AS user_name FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id
    WHERE ${where.join(' AND ')} ORDER BY l.id DESC LIMIT ?`, [...params, Math.min(Number(req.query.limit) || 300, 2000)]));
}));

// Lookup lists used by drop-downs (names only)
router.get('/lookups', wrap(async (req, res) => {
  const out = {};
  if (req.user.can('users.manage') || req.user.can('catering.view') || req.user.can('finance.view')) {
    out.kitchens = await db.query('SELECT id, name, kitchen_type, status FROM kitchens ORDER BY name');
  }
  if (req.user.can('users.manage')) out.roles = await db.query('SELECT id, name FROM roles ORDER BY name');
  res.json(out);
}));

module.exports = router;
