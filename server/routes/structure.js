// Clients -> Projects -> Sites
const express = require('express');
const db = require('../lib/db');
const { crud } = require('../lib/crud');
const { wrap } = require('../lib/http');

const router = express.Router();

const scopeSql = (user, sqlForSites) => (user.siteIds === null
  ? { sql: '1=1', params: [] }
  : user.siteIds.length ? { sql: sqlForSites, params: [user.siteIds] } : { sql: '1=0', params: [] });

crud(router, '/clients', {
  table: 'clients', entity: 'client', view: ['structure.view'], manage: ['structure.manage'],
  select: 't.*, (SELECT COUNT(*) FROM projects p WHERE p.client_id = t.id) AS project_count',
  search: ['t.name', 't.code'], filters: { status: 't.status' }, orderBy: 't.name',
  scope: (u) => scopeSql(u, 't.id IN (SELECT p.client_id FROM projects p JOIN sites s ON s.project_id = p.id WHERE s.id IN (?))'),
  fields: {
    code: { type: 'string', required: true, max: 30, label: 'Code' },
    name: { type: 'string', required: true, max: 150, label: 'Name' },
    contact_name: { type: 'string', max: 120 },
    contact_email: { type: 'string', max: 150, email: true },
    contact_phone: { type: 'string', max: 40 },
    status: { type: 'enum', values: ['active', 'inactive'], default: 'active' },
  },
  beforeWrite: async (data, req, existing) => {
    if (!existing) {
      const c = await db.one('SELECT id FROM companies ORDER BY id LIMIT 1');
      data.company_id = c.id;
    }
    return data;
  },
  allowDelete: true,
});

crud(router, '/projects', {
  table: 'projects', entity: 'project', view: ['structure.view'], manage: ['structure.manage'],
  select: 't.*, c.name AS client_name, (SELECT COUNT(*) FROM sites s WHERE s.project_id = t.id) AS site_count',
  from: 'projects t JOIN clients c ON c.id = t.client_id',
  search: ['t.name', 't.code', 'c.name'], filters: { client_id: 't.client_id', status: 't.status' }, orderBy: 'c.name, t.name',
  scope: (u) => scopeSql(u, 't.id IN (SELECT s.project_id FROM sites s WHERE s.id IN (?))'),
  fields: {
    client_id: { type: 'int', required: true, label: 'Client' },
    code: { type: 'string', required: true, max: 30, label: 'Code' },
    name: { type: 'string', required: true, max: 150, label: 'Name' },
    location: { type: 'string', max: 200 },
    start_date: { type: 'date' },
    end_date: { type: 'date' },
    status: { type: 'enum', values: ['planned', 'active', 'on_hold', 'completed'], default: 'active' },
  },
  allowDelete: true,
});

crud(router, '/sites', {
  table: 'sites', entity: 'site', view: ['structure.view', 'attendance.record', 'hse.report'], manage: ['structure.manage'],
  select: 't.*, p.name AS project_name, p.client_id, c.name AS client_name',
  from: 'sites t JOIN projects p ON p.id = t.project_id JOIN clients c ON c.id = p.client_id',
  search: ['t.name', 't.code', 'p.name', 'c.name'], filters: { project_id: 't.project_id', status: 't.status', client_id: 'p.client_id' },
  orderBy: 'c.name, p.name, t.name',
  scope: (u) => scopeSql(u, 't.id IN (?)'),
  fields: {
    project_id: { type: 'int', required: true, label: 'Project' },
    code: { type: 'string', required: true, max: 30, label: 'Code' },
    name: { type: 'string', required: true, max: 150, label: 'Name' },
    location: { type: 'string', max: 200 },
    status: { type: 'enum', values: ['active', 'inactive', 'closed'], default: 'active' },
  },
  allowDelete: true,
});

// Everything the user may see, as a nested tree - used by drop-down pickers across the app.
router.get('/tree', wrap(async (req, res) => {
  const s = scopeSql(req.user, 's.id IN (?)');
  const rows = await db.query(
    `SELECT c.id AS client_id, c.name AS client_name, p.id AS project_id, p.name AS project_name,
            s.id AS site_id, s.name AS site_name, s.status AS site_status
       FROM sites s JOIN projects p ON p.id = s.project_id JOIN clients c ON c.id = p.client_id
      WHERE ${s.sql} ORDER BY c.name, p.name, s.name`, s.params);
  const clients = new Map();
  for (const r of rows) {
    if (!clients.has(r.client_id)) clients.set(r.client_id, { id: r.client_id, name: r.client_name, projects: new Map() });
    const c = clients.get(r.client_id);
    if (!c.projects.has(r.project_id)) c.projects.set(r.project_id, { id: r.project_id, name: r.project_name, sites: [] });
    c.projects.get(r.project_id).sites.push({ id: r.site_id, name: r.site_name, status: r.site_status });
  }
  res.json([...clients.values()].map((c) => ({ ...c, projects: [...c.projects.values()] })));
}));

module.exports = router;
