const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../lib/db');
const { signToken, authenticate } = require('../lib/auth');
const { audit } = require('../lib/audit');
const { wrap, bad, HttpError } = require('../lib/http');

const router = express.Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Please wait 15 minutes and try again.' } });

const publicUser = (u) => ({
  id: u.id, name: u.name, email: u.email, role: u.role, permissions: u.permissions,
  siteIds: u.siteIds, kitchenIds: u.kitchenIds,
});

router.post('/login', loginLimiter, wrap(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) throw bad('Email and password are required');
  const row = await db.one('SELECT id, password_hash, active FROM users WHERE email = ?', [String(email).toLowerCase().trim()]);
  if (!row || !row.active || !(await bcrypt.compare(String(password), row.password_hash))) {
    await audit(req, 'login_failed', 'user', null, { email });
    throw new HttpError(401, 'Wrong email or password');
  }
  await db.query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [row.id]);
  const { loadUser } = require('../lib/auth');
  const user = await loadUser(row.id);
  req.user = user;
  await audit(req, 'login', 'user', user.id);
  res.json({ token: signToken(user), user: publicUser(user) });
}));

router.get('/me', authenticate, (req, res) => res.json(publicUser(req.user)));

router.post('/change-password', authenticate, wrap(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 8) throw bad('The new password must be at least 8 characters');
  const row = await db.one('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  if (!(await bcrypt.compare(String(currentPassword || ''), row.password_hash))) throw bad('Current password is wrong');
  await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(String(newPassword), 10), req.user.id]);
  await audit(req, 'change_password', 'user', req.user.id);
  res.json({ ok: true });
}));

module.exports = router;
