import { useState } from 'react';
import { api, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, opts, todayStr } from '../lib/format';
import { Alert, Badge, EntityForm, ErrorMsg, Modal, PageHeader, Table, useLoad, useOptions } from '../components/ui';

// Client staffing requests: the Site Administrator records them and forwards them; the Recruitment Manager fills them.
export default function Staffing() {
  const { can } = useAuth();
  const [status, setStatus] = useState('');
  const list = useLoad(() => api.get(`/staffing-requests${qs({ status })}`), [status]);
  const sites = useOptions('/structure/sites', (s) => ({ value: s.id, label: `${s.name} — ${s.project_name}` }));
  const [modal, setModal] = useState(null);
  const [error, setError] = useState(null);
  const done = () => { setModal(null); list.reload(); };
  const forward = async (r) => {
    setError(null);
    try { await api.post(`/staffing-requests/${r.id}/forward`, {}); list.reload(); } catch (e) { setError(e); }
  };
  return (
    <div>
      <PageHeader title="Staffing requests" subtitle="Workers requested by clients for each site"
        actions={can('staffing.request') && <button className="btn" onClick={() => setModal('new')}>+ Record client request</button>} />
      {can('staffing.manage') && <Alert tone="info">To fill a request, open a worker and add an assignment, choosing the request in the form.</Alert>}
      <div className="toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">All open and closed</option>
          {opts(['received', 'forwarded', 'in_progress', 'filled', 'cancelled']).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      <ErrorMsg error={error || list.error} />
      <Table rows={list.data} empty="No staffing requests."
        columns={[
          { key: 'site_name', label: 'Site' }, { key: 'project_name', label: 'Project' }, { key: 'requested_by_client', label: 'Requested by' },
          { key: 'job_position', label: 'Position' }, { key: 'quantity', label: 'Workers', num: true }, { key: 'workers_assigned', label: 'Assigned', num: true },
          { key: 'needed_from', label: 'From', type: 'date' }, { key: 'needed_until', label: 'To', render: (r) => (r.needed_until ? fmtDate(r.needed_until) : '') },
          { key: 'details', label: 'Details' }, { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> }, { key: 'response_notes', label: 'Recruitment notes' },
          { key: 'act', label: '', render: (r) => (
            <span className="row-actions">
              {can('staffing.request') && r.status === 'received' && <button className="link" onClick={() => forward(r)}>Forward to recruitment</button>}
              {can('staffing.manage') && !['received', 'filled', 'cancelled'].includes(r.status) && <button className="link" onClick={() => setModal({ update: r })}>Update</button>}
            </span>) },
        ]} />
      {modal === 'new' && (
        <Modal title="Client staffing request" onClose={() => setModal(null)}>
          <EntityForm submitLabel="Save" initial={{ needed_from: todayStr(), quantity: 1, forward: true }}
            fields={[{ name: 'site_id', label: 'Site', type: 'select', options: sites, required: true, wide: true },
              { name: 'requested_by_client', label: 'Requested by (client contact)' }, { name: 'job_position', label: 'Position needed', required: true },
              { name: 'quantity', label: 'Number of workers', type: 'number', min: 1, required: true },
              { name: 'needed_from', label: 'Needed from', type: 'date', required: true }, { name: 'needed_until', label: 'Needed until', type: 'date' },
              { name: 'details', label: 'Details', wide: true }, { name: 'forward', label: 'Forward to recruitment now', type: 'checkbox' }]}
            onCancel={() => setModal(null)} onSubmit={async (d) => { await api.post('/staffing-requests', { ...d, quantity: Number(d.quantity) }); done(); }} />
        </Modal>
      )}
      {modal && modal.update && (
        <Modal title={`${modal.update.quantity} × ${modal.update.job_position} for ${modal.update.site_name}`} onClose={() => setModal(null)}>
          <EntityForm submitLabel="Save" initial={{ status: modal.update.status === 'forwarded' ? 'in_progress' : modal.update.status, response_notes: modal.update.response_notes }}
            fields={[{ name: 'status', label: 'Status', type: 'select', required: true, options: opts(['in_progress', 'filled', 'cancelled']) },
              { name: 'response_notes', label: 'Notes for the site', wide: true }]}
            onCancel={() => setModal(null)} onSubmit={async (d) => { await api.post(`/staffing-requests/${modal.update.id}/status`, d); done(); }} />
        </Modal>
      )}
    </div>
  );
}
