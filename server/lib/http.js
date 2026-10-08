// Small helpers shared by all routes.
class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
const bad = (msg, details) => new HttpError(400, msg, details);
const notFound = (what = 'Record') => new HttpError(404, `${what} not found`);
const forbidden = (msg = 'You do not have permission to do this') => new HttpError(403, msg);

// Wraps async route handlers so errors reach the error handler.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const today = () => new Date().toISOString().slice(0, 10);
const toInt = (v) => (v === undefined || v === null || v === '' ? null : Number.parseInt(v, 10));

function requireFields(body, fields) {
  const missing = fields.filter((f) => body[f] === undefined || body[f] === null || body[f] === '');
  if (missing.length) throw bad(`Missing required field(s): ${missing.join(', ')}`);
}

module.exports = { HttpError, bad, notFound, forbidden, wrap, isDate, today, toInt, requireFields };
