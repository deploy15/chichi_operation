// Web server: serves the API under /api and the React app for everything else.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const { authenticate } = require('./lib/auth');
const { HttpError } = require('./lib/http');
const db = require('./lib/db');

const app = express();
app.set('trust proxy', 1); // Heroku sits behind a proxy

// Force HTTPS on Heroku (encrypted communications)
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] === 'http') {
    return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
  }
  next();
});
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: { 'img-src': ["'self'", 'data:', 'blob:'], 'connect-src': ["'self'"] },
  },
}));
app.use(compression());
app.use(express.json({ limit: '8mb' }));

app.get('/api/health', async (req, res) => {
  try { await db.query('SELECT 1'); res.json({ ok: true, database: 'connected' }); } catch (e) { res.status(503).json({ ok: false, database: 'unreachable' }); }
});
app.use('/api/auth', require('./routes/auth'));

// Everything below needs a signed-in user
const api = express.Router();
api.use(authenticate);
api.use('/structure', require('./routes/structure'));
for (const r of ['workers', 'attendance', 'catering', 'finance', 'accommodation', 'medical', 'hse', 'payroll', 'dashboard', 'admin']) {
  api.use(require(`./routes/${r}`));
}
app.use('/api', api);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// React app (built into client/dist)
const dist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, {
    setHeaders: (res, file) => {
      if (file.endsWith('sw.js') || file.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  }));
  app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// Errors -> plain-language JSON messages
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'The upload is too large' });
  if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'This record already exists (a code or name is already in use)' });
  if (err.code === 'ER_NO_REFERENCED_ROW_2') return res.status(400).json({ error: 'A linked record was not found' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

const port = process.env.PORT || 4000;
if (require.main === module) {
  app.listen(port, () => console.log(`Server running on port ${port}`));
}
module.exports = app;
