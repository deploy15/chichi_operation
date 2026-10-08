// MySQL connection pool. Reads the connection address from the environment.
// Heroku add-ons set one of these automatically: JAWSDB_URL, JAWSDB_MARIA_URL, CLEARDB_DATABASE_URL.
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const mysql = require('mysql2/promise');

function connectionUrl() {
  const url = process.env.DATABASE_URL || process.env.JAWSDB_URL || process.env.JAWSDB_MARIA_URL || process.env.CLEARDB_DATABASE_URL;
  if (!url) throw new Error('No database address found. Set DATABASE_URL (or add the JawsDB add-on on Heroku).');
  return url;
}

function config(extra = {}) {
  const u = new URL(connectionUrl());
  const cfg = {
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, '').split('?')[0],
    dateStrings: true,          // return DATE/DATETIME as plain strings (no timezone surprises)
    decimalNumbers: true,
    timezone: 'Z',
    ...extra,
  };
  if (process.env.DB_SSL === 'true') cfg.ssl = { rejectUnauthorized: process.env.DB_SSL_STRICT !== 'false' };
  return cfg;
}

const pool = mysql.createPool({ ...config(), waitForConnections: true, connectionLimit: Number(process.env.DB_POOL_SIZE || 8) });

async function query(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}
async function one(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}
// Runs fn(conn) inside a transaction; rolls back on any error.
async function tx(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = { pool, query, one, tx, config };
