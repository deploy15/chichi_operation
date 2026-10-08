const jwt = require('jsonwebtoken');
const db = require('./db');
const { HttpError, forbidden } = require('./http');

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 16) throw new Error('JWT_SECRET must be set to a long random value (at least 16 characters).');
  return s;
}

function signToken(user) {
  return jwt.sign({ sub: user.id }, secret(), { expiresIn: process.env.JWT_EXPIRES_IN || '12h' });
}

// Loads the user with their current permissions and the sites/kitchens they are limited to.
// Loaded fresh on every request, so permission changes and deactivations apply immediately.
async function loadUser(id) {
  const u = await db.one(
    `SELECT u.id, u.name, u.email, u.active, u.role_id, r.name AS role
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`, [id]);
  if (!u || !u.active) return null;
  const perms = await db.query(
    `SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?`, [u.role_id]);
  u.permissions = perms.map((p) => p.code);
  const sites = await db.query('SELECT site_id FROM user_sites WHERE user_id = ?', [id]);
  const kitchens = await db.query('SELECT kitchen_id FROM user_kitchens WHERE user_id = ?', [id]);
  u.assignedSiteIds = sites.map((s) => s.site_id);
  u.assignedKitchenIds = kitchens.map((k) => k.kitchen_id);
  // null means "no limit"
  u.siteIds = u.permissions.includes('all_sites') ? null : u.assignedSiteIds;
  u.kitchenIds = u.permissions.includes('all_kitchens') ? null : u.assignedKitchenIds;
  u.can = (p) => u.permissions.includes(p);
  return u;
}

async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new HttpError(401, 'Please sign in');
    let payload;
    try {
      payload = jwt.verify(token, secret());
    } catch {
      throw new HttpError(401, 'Your session has expired. Please sign in again.');
    }
    const user = await loadUser(payload.sub);
    if (!user) throw new HttpError(401, 'Account not found or disabled');
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
}

// requirePerm('a', 'b') -> user needs at least one of the listed permissions
const requirePerm = (...codes) => (req, res, next) => {
  if (codes.some((c) => req.user.can(c))) return next();
  next(forbidden());
};

// SQL filter limiting rows to the sites the user may see.
function siteFilter(user, column) {
  if (user.siteIds === null) return { sql: '1=1', params: [] };
  if (!user.siteIds.length) return { sql: '1=0', params: [] };
  return { sql: `${column} IN (?)`, params: [user.siteIds] };
}
function kitchenFilter(user, column) {
  if (user.kitchenIds === null) return { sql: '1=1', params: [] };
  if (!user.kitchenIds.length) return { sql: '1=0', params: [] };
  return { sql: `${column} IN (?)`, params: [user.kitchenIds] };
}
function assertSite(user, siteId) {
  if (user.siteIds !== null && !user.siteIds.includes(Number(siteId))) throw forbidden('This site is not assigned to you');
}
function assertKitchen(user, kitchenId) {
  if (user.kitchenIds !== null && !user.kitchenIds.includes(Number(kitchenId))) throw forbidden('This kitchen is not assigned to you');
}

module.exports = { signToken, loadUser, authenticate, requirePerm, siteFilter, kitchenFilter, assertSite, assertKitchen };
