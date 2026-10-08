import { useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { api, openFile, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtDateTime, label, opts, todayStr, utcToLocalInput } from '../lib/format';
import { Alert, Badge, BarList, Card, EntityForm, ErrorMsg, Loading, Modal, PageHeader, Stat, Table, Tabs, useLoad, useOptions } from '../components/ui';
import { FileUpload } from './Medical';

const TYPES = ['injury', 'near_miss', 'property_damage', 'environmental', 'fire', 'vehicle', 'security', 'illness', 'other'];
const SEVERITY = ['low', 'medium', 'high', 'critical'];

export default function Hse() {
  return (
    <Routes>
      <Route path="/" element={<HseHome />} />
      <Route path="/:id" element={<IncidentDetail />} />
    </Routes>
  );
}

function incidentFields(sites, workers) {
  return [
    { name: 'occurred_at', label: 'Date and time', type: 'datetime-local', required: true },
    { name: 'site_id', label: 'Site (client and project are filled in automatically)', type: 'select', options: sites, required: true },
    { name: 'location', label: 'Exact location on site' },
    { name: 'incident_type', label: 'Type', type: 'select', options: opts(TYPES), required: true },
    { name: 'severity', label: 'Severity', type: 'select', options: opts(SEVERITY), required: true },
    { name: 'person_worker_id', label: 'Person involved (worker)', type: 'select', options: workers },
    { name: 'person_name', label: 'Person involved (if not a worker)' },
    { name: 'description', label: 'What happened', type: 'textarea', required: true, wide: true },
    { name: 'witnesses', label: 'Witnesses', type: 'textarea', wide: true },
    { name: 'immediate_actions', label: 'Immediate actions taken', type: 'textarea', wide: true },
  ];
}

function HseHome() {
  const { can } = useAuth();
  const [tab, setTab] = useState(can('hse.view') ? 'dashboard' : 'incidents');
  const tabs = [can('hse.view') && { key: 'dashboard', label: 'HSE dashboard' }, { key: 'incidents', label: 'Incidents' }].filter(Boolean);
  return (
    <div>
      <PageHeader title="HSE & incidents" subtitle="Health, safety and environment" />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'dashboard' ? <HseDashboard /> : <Incidents />}
    </div>
  );
}

function HseDashboard() {
  const { data: d, error } = useLoad(() => api.get('/hse/dashboard'), []);
  if (error) return <ErrorMsg error={error} />;
  if (!d) return <Loading />;
  return (
    <div>
      <div className="stats">
        <Stat label="Open incidents" value={d.open_incidents} tone={d.open_incidents ? 'red' : undefined} />
        <Stat label="Closed incidents" value={d.closed_incidents} tone="green" />
        <Stat label="Overdue corrective actions" value={d.overdue_actions.length} tone={d.overdue_actions.length ? 'red' : undefined} />
      </div>
      <div className="grid-3">
        <Card title="Incidents by site"><BarList items={d.by_site} /></Card>
        <Card title="Incidents by project"><BarList items={d.by_project} /></Card>
        <Card title="By severity"><BarList items={d.by_severity} /></Card>
        <Card title="By type"><BarList items={d.by_type} /></Card>
        <Card title="Trend (last 12 months)"><BarList items={d.trend} /></Card>
      </div>
      <Card title="Overdue corrective actions">
        <Table rows={d.overdue_actions} empty="No overdue actions."
          columns={[{ key: 'description', label: 'Action', render: (a) => <Link to={`/hse/${a.incident_id}`}>{a.description}</Link> }, { key: 'responsible_name', label: 'Responsible' },
            { key: 'due_date', label: 'Due', type: 'date' }, { key: 'site_name', label: 'Site' }, { key: 'incident_type', label: 'Incident', type: 'label' }]} />
      </Card>
    </div>
  );
}

function Incidents() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [filters, setFilters] = useState({ status: '' });
  const list = useLoad(() => api.get(`/hse/incidents${qs(filters)}`), [JSON.stringify(filters)]);
  const sites = useOptions('/structure/sites', (s) => ({ value: s.id, label: `${s.name} — ${s.project_name}` }));
  const workers = useOptions(can('workers.view') ? '/workers' : null, (w) => ({ value: w.id, label: `${w.first_name} ${w.last_name}` }));
  const [adding, setAdding] = useState(false);
  return (
    <div>
      <div className="toolbar">
        <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })} aria-label="Status">
          <option value="">All statuses</option>{opts(['open', 'under_investigation', 'closed']).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select value={filters.severity || ''} onChange={(e) => setFilters({ ...filters, severity: e.target.value })} aria-label="Severity">
          <option value="">All severities</option>{opts(SEVERITY).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <div className="spacer" />
        {can('hse.report') && <button className="btn" onClick={() => setAdding(true)}>+ Report incident</button>}
      </div>
      <ErrorMsg error={list.error} />
      <Table rows={list.data} onRowClick={(r) => navigate(`/hse/${r.id}`)} empty="No incidents reported."
        columns={[{ key: 'id', label: 'No.' }, { key: 'occurred_at', label: 'When', type: 'datetime' }, { key: 'site_name', label: 'Site' }, { key: 'project_name', label: 'Project' },
          { key: 'incident_type', label: 'Type', type: 'label' }, { key: 'severity', label: 'Severity', type: 'badge' }, { key: 'status', label: 'Status', type: 'badge' },
          { key: 'actions', label: 'Open actions', render: (r) => <>{r.open_actions}{Number(r.overdue_actions) ? <Badge value={`${r.overdue_actions} overdue`} tone="red" /> : null}</> }]} />
      {adding && (
        <Modal title="Report an incident" wide onClose={() => setAdding(false)}>
          <EntityForm fields={incidentFields(sites, workers)} initial={{ occurred_at: `${todayStr()}T${new Date().toTimeString().slice(0, 5)}` }} submitLabel="Submit report"
            onCancel={() => setAdding(false)}
            onSubmit={async (d) => { const i = await api.post('/hse/incidents', { ...d, occurred_at: new Date(d.occurred_at).toISOString() }); setAdding(false); navigate(`/hse/${i.id}`); }} />
        </Modal>
      )}
    </div>
  );
}

function IncidentDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const inc = useLoad(() => api.get(`/hse/incidents/${id}`), [id]);
  const sites = useOptions('/structure/sites', (s) => ({ value: s.id, label: s.name }));
  const [modal, setModal] = useState(null);
  if (inc.error) return <ErrorMsg error={inc.error} />;
  if (!inc.data) return <Loading />;
  const i = inc.data;
  const manage = can('hse.manage');
  const close = () => { setModal(null); inc.reload(); };
  return (
    <div>
      <p><Link to="/hse">← All incidents</Link></p>
      <PageHeader title={`Incident ${i.id}: ${label(i.incident_type)}`} subtitle={`${fmtDateTime(i.occurred_at)} · ${i.site_name} · ${i.project_name} · ${i.client_name}`}
        actions={<><Badge value={i.severity} /><Badge value={i.status} />{manage && <button className="btn btn-ghost" onClick={() => setModal('edit')}>Update</button>}</>} />
      <div className="grid-2">
        <Card title="Details">
          <dl className="details">
            <dt>Location</dt><dd>{i.location}</dd>
            <dt>Person involved</dt><dd>{i.person_worker_name || i.person_name}</dd>
            <dt>What happened</dt><dd className="pre">{i.description}</dd>
            <dt>Witnesses</dt><dd className="pre">{i.witnesses}</dd>
            <dt>Immediate actions</dt><dd className="pre">{i.immediate_actions}</dd>
            <dt>Reported by</dt><dd>{i.reported_by_name} on {fmtDateTime(i.reported_at)}</dd>
            {i.closed_at && <><dt>Closed</dt><dd>{fmtDateTime(i.closed_at)}</dd></>}
          </dl>
        </Card>
        <Card title="Photos and documents" actions={can('hse.report', 'hse.manage') && <button className="btn btn-small" onClick={() => setModal('file')}>+ Add photo / file</button>}>
          <Table rows={i.attachments} empty="None yet." columns={[{ key: 'file_name', label: 'File', render: (f) => <button className="link" onClick={() => openFile(`/hse/attachments/${f.id}`, f.file_name)}>{f.file_name}</button> },
            { key: 'created_at', label: 'Added', type: 'datetime' }]} />
        </Card>
      </div>
      <Card title="Corrective actions" actions={manage && <button className="btn btn-small" onClick={() => setModal('action')}>+ Add action</button>}>
        <Table rows={i.actions} empty="No corrective actions yet."
          rowClass={(a) => (a.status !== 'done' && a.due_date < todayStr() ? 'overdue' : '')}
          columns={[{ key: 'description', label: 'Action' }, { key: 'responsible_name', label: 'Responsible' }, { key: 'due_date', label: 'Due', render: (a) => fmtDate(a.due_date) },
            { key: 'status', label: 'Status', type: 'badge' },
            { key: 'act', label: '', render: (a) => manage && a.status !== 'done' && (
              <span className="row-actions">
                {a.status === 'open' && <button className="link" onClick={async () => { await api.put(`/hse/actions/${a.id}`, { status: 'in_progress' }); inc.reload(); }}>Start</button>}
                <button className="link" onClick={async () => { await api.put(`/hse/actions/${a.id}`, { status: 'done' }); inc.reload(); }}>Mark done</button>
              </span>) }]} />
      </Card>
      {modal === 'edit' && (
        <Modal title="Update incident" wide onClose={() => setModal(null)}>
          <EntityForm initial={{ ...i, occurred_at: utcToLocalInput(i.occurred_at) }} onCancel={() => setModal(null)}
            fields={[{ name: 'status', label: 'Status', type: 'select', options: opts(['open', 'under_investigation', 'closed']), required: true },
              ...incidentFields(sites, []).filter((f) => !['person_worker_id', 'person_name'].includes(f.name))]}
            onSubmit={async (d) => { await api.put(`/hse/incidents/${id}`, { ...d, occurred_at: new Date(d.occurred_at).toISOString() }); close(); }} />
        </Modal>
      )}
      {modal === 'action' && (
        <Modal title="Add corrective action" onClose={() => setModal(null)}>
          <EntityForm onCancel={() => setModal(null)}
            fields={[{ name: 'description', label: 'Action to take', type: 'textarea', required: true, wide: true }, { name: 'responsible_name', label: 'Person responsible', required: true },
              { name: 'due_date', label: 'Due date', type: 'date', required: true }]}
            onSubmit={async (d) => { await api.post(`/hse/incidents/${id}/actions`, d); close(); }} />
        </Modal>
      )}
      {modal === 'file' && (
        <Modal title="Add photo or document" onClose={() => setModal(null)}>
          <FileUpload onCancel={() => setModal(null)} onUpload={async (b) => { await api.post(`/hse/incidents/${id}/attachments`, b); close(); }} />
        </Modal>
      )}
      <Alert tone="info">{i.status === 'closed' && i.actions.some((a) => a.status !== 'done') ? 'This incident is closed but still has open corrective actions.' : null}</Alert>
    </div>
  );
}
