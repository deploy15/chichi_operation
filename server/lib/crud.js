// Builds standard list / view / create / edit (/ delete) routes for a simple table,
// with field checking, permission checks, site limits and audit logging.
const db = require('./db');
const { audit } = require('./audit');
const { bad, notFound, forbidden, wrap, isDate } = require('./http');

function clean(fields, body, { partial }) {
  const out = {};
  for (const [name, f] of Object.entries(fields)) {
    if (f.readOnly) continue;
    if (!(name in body)) {
      if (!partial && f.required && f.default === undefined) throw bad(`${f.label || name} is required`);
      if (!partial && f.default !== undefined) out[name] = f.default;
      continue;
    }
    let v = body[name];
    if (v === '' || v === undefined) v = null;
    if (v === null) {
      if (f.required) throw bad(`${f.label || name} is required`);
      out[name] = null;
      continue;
    }
    switch (f.type) {
      case 'int':
        v = Number(v);
        if (!Number.isInteger(v)) throw bad(`${f.label || name} must be a whole number`);
        if (f.min !== undefined && v < f.min) throw bad(`${f.label || name} must be at least ${f.min}`);
        break;
      case 'number':
        v = Number(v);
        if (!Number.isFinite(v)) throw bad(`${f.label || name} must be a number`);
        if (f.min !== undefined && v < f.min) throw bad(`${f.label || name} must be at least ${f.min}`);
        break;
      case 'bool':
        v = v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0;
        break;
      case 'date':
        if (!isDate(v)) throw bad(`${f.label || name} must be a date (YYYY-MM-DD)`);
        break;
      case 'datetime': {
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) throw bad(`${f.label || name} must be a date and time`);
        v = d.toISOString().slice(0, 19).replace('T', ' ');
        break;
      }
      case 'enum':
        if (!f.values.includes(v)) throw bad(`${f.label || name} must be one of: ${f.values.join(', ')}`);
        break;
      default:
        v = String(v).trim();
        if (f.max && v.length > f.max) throw bad(`${f.label || name} is too long (max ${f.max} characters)`);
        if (f.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw bad(`${f.label || name} must be a valid email`);
    }
    out[name] = v;
  }
  return out;
}

function crud(router, base, opts) {
  const {
    table, entity = table, fields, view = [], manage = [], search = [], filters = {},
    orderBy = 't.id DESC', allowDelete = false, scope, select = 't.*', from = `${table} t`,
    beforeWrite, afterWrite, canAccessRow, hidden = [],
  } = opts;

  const has = (req, perms) => perms.length === 0 || perms.some((p) => req.user.can(p));
  const strip = (row) => { hidden.forEach((h) => delete row[h]); return row; };

  async function fetchRow(req, id) {
    const s = scope ? scope(req.user) : { sql: '1=1', params: [] };
    const row = await db.one(`SELECT ${select} FROM ${from} WHERE t.id = ? AND (${s.sql})`, [id, ...s.params]);
    if (!row) throw notFound();
    return row;
  }

  router.get(base, wrap(async (req, res) => {
    if (!has(req, view)) throw forbidden();
    const where = [];
    const params = [];
    if (scope) { const s = scope(req.user); where.push(s.sql); params.push(...s.params); }
    for (const [param, column] of Object.entries(filters)) {
      if (req.query[param] !== undefined && req.query[param] !== '') { where.push(`${column} = ?`); params.push(req.query[param]); }
    }
    if (req.query.q && search.length) {
      where.push(`(${search.map((c) => `${c} LIKE ?`).join(' OR ')})`);
      search.forEach(() => params.push(`%${req.query.q}%`));
    }
    const limit = Math.min(Number(req.query.limit) || 500, 2000);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const rows = await db.query(
      `SELECT ${select} FROM ${from} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...params, limit, offset]);
    res.json(rows.map(strip));
  }));

  router.get(`${base}/:id(\\d+)`, wrap(async (req, res) => {
    if (!has(req, view)) throw forbidden();
    res.json(strip(await fetchRow(req, req.params.id)));
  }));

  router.post(base, wrap(async (req, res) => {
    if (!has(req, manage)) throw forbidden();
    let data = clean(fields, req.body || {}, { partial: false });
    if (beforeWrite) data = (await beforeWrite(data, req, null)) || data;
    if (canAccessRow) await canAccessRow(req, data);
    const cols = Object.keys(data);
    const r = await db.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, cols.map((c) => data[c]));
    await audit(req, 'create', entity, r.insertId, data);
    const row = await fetchRow(req, r.insertId).catch(() => ({ id: r.insertId, ...data }));
    if (afterWrite) await afterWrite(row, req);
    res.status(201).json(strip(row));
  }));

  router.put(`${base}/:id(\\d+)`, wrap(async (req, res) => {
    if (!has(req, manage)) throw forbidden();
    const existing = await fetchRow(req, req.params.id);
    let data = clean(fields, req.body || {}, { partial: true });
    if (beforeWrite) data = (await beforeWrite(data, req, existing)) || data;
    if (canAccessRow) await canAccessRow(req, { ...existing, ...data });
    const cols = Object.keys(data);
    if (cols.length) {
      await db.query(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => data[c]), req.params.id]);
      const before = {};
      cols.forEach((c) => { before[c] = existing[c]; });
      await audit(req, 'update', entity, req.params.id, { before, after: data });
    }
    const row = await fetchRow(req, req.params.id);
    if (afterWrite) await afterWrite(row, req);
    res.json(strip(row));
  }));

  if (allowDelete) {
    router.delete(`${base}/:id(\\d+)`, wrap(async (req, res) => {
      if (!has(req, manage)) throw forbidden();
      const existing = await fetchRow(req, req.params.id);
      try {
        await db.query(`DELETE FROM ${table} WHERE id = ?`, [req.params.id]);
      } catch (e) {
        if (e.code === 'ER_ROW_IS_REFERENCED_2') throw bad('This record is used elsewhere and cannot be deleted. Change its status instead.');
        throw e;
      }
      await audit(req, 'delete', entity, req.params.id, strip({ ...existing }));
      res.json({ ok: true });
    }));
  }
}

module.exports = { crud, clean };
