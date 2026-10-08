const db = require('./db');

// Records who did what. Never throws - a logging problem must not break the action itself.
async function audit(req, action, entity, entityId, details, conn) {
  try {
    const sql = 'INSERT INTO audit_logs (user_id, action, entity, entity_id, details, ip) VALUES (?,?,?,?,?,?)';
    const params = [req.user ? req.user.id : null, action, entity, entityId == null ? null : String(entityId), details ? JSON.stringify(details) : null, req.ip];
    if (conn) await conn.query(sql, params);
    else await db.query(sql, params);
  } catch (e) {
    console.error('Audit log failed:', e.message);
  }
}

module.exports = { audit };
