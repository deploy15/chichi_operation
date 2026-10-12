import { useState } from 'react';
import { api, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtMoney, opts } from '../lib/format';
import { Alert, Badge, EntityForm, ErrorMsg, Modal, PageHeader, Table, useLoad, useOptions } from '../components/ui';

// Purchase requests: the Catering Director submits, the DAF approves, and the Managing Director approves major ones.
export default function Purchases() {
  const { can, user } = useAuth();
  const [status, setStatus] = useState('');
  const list = useLoad(() => api.get(`/purchases${qs({ status })}`), [status]);
  const settings = useLoad(() => api.get('/settings'), []);
  const kitchens = useOptions(can('purchases.request') ? '/kitchens' : null, (k) => ({ value: k.id, label: k.name }));
  const [modal, setModal] = useState(null);
  const [error, setError] = useState(null);
  const done = () => { setModal(null); list.reload(); };
  const limit = settings.data ? settings.data.find((s) => s.setting_key === 'major_expense_threshold') : null;
  const canDecide = (p) => p.status === 'submitted' && (p.requires_major_approval ? can('approvals.major') : can('purchases.approve', 'approvals.major'))
    && (p.requested_by !== user.id || can('approvals.major'));
  const cancel = async (p) => {
    if (!window.confirm('Cancel this request?')) return;
    setError(null);
    try { await api.post(`/purchases/${p.id}/cancel`, {}); list.reload(); } catch (e) { setError(e); }
  };
  return (
    <div>
      <PageHeader title="Purchase requests" subtitle="Requested by the Catering Director, approved by the DAF"
        actions={can('purchases.request') && <button className="btn" onClick={() => setModal('new')}>+ New purchase request</button>} />
      {limit && <Alert tone="info">Requests above {fmtMoney(limit.setting_value)} are major purchases and need the Managing Director's approval.</Alert>}
      <div className="toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">All requests</option>
          {opts(['submitted', 'approved', 'rejected', 'cancelled']).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      <ErrorMsg error={error || list.error} />
      <Table rows={list.data} empty="No purchase requests."
        columns={[
          { key: 'created_at', label: 'Date', type: 'date' }, { key: 'kitchen_name', label: 'Kitchen' }, { key: 'items', label: 'Items' },
          { key: 'supplier', label: 'Supplier' }, { key: 'estimated_amount', label: 'Estimated', num: true, render: (p) => fmtMoney(p.estimated_amount) },
          { key: 'needed_by', label: 'Needed by', render: (p) => fmtDate(p.needed_by) },
          { key: 'major', label: '', render: (p) => (Number(p.requires_major_approval) ? <Badge value="major" tone="purple" /> : '') },
          { key: 'requested_by_name', label: 'Requested by' }, { key: 'status', label: 'Status', type: 'badge' },
          { key: 'decided_by_name', label: 'Decided by', render: (p) => (p.decided_by_name ? `${p.decided_by_name}${p.decision_notes ? `: ${p.decision_notes}` : ''}` : '') },
          { key: 'act', label: '', render: (p) => (
            <span className="row-actions">
              {canDecide(p) && <button className="link" onClick={() => setModal({ decide: p })}>Approve / reject</button>}
              {p.status === 'submitted' && p.requested_by === user.id && <button className="link" onClick={() => cancel(p)}>Cancel</button>}
            </span>) },
        ]} />
      {modal === 'new' && (
        <Modal title="New purchase request" onClose={() => setModal(null)}>
          <EntityForm submitLabel="Submit to DAF"
            fields={[{ name: 'kitchen_id', label: 'For kitchen', type: 'select', options: kitchens }, { name: 'items', label: 'Items and quantities', type: 'textarea', required: true, wide: true },
              { name: 'supplier', label: 'Supplier' }, { name: 'estimated_amount', label: 'Estimated amount', type: 'number', min: 0, required: true },
              { name: 'needed_by', label: 'Needed by', type: 'date' }, { name: 'justification', label: 'Reason', wide: true }]}
            onCancel={() => setModal(null)} onSubmit={async (d) => { await api.post('/purchases', { ...d, estimated_amount: Number(d.estimated_amount) }); done(); }} />
        </Modal>
      )}
      {modal && modal.decide && (
        <Modal title="Purchase decision" onClose={() => setModal(null)}>
          <p>{modal.decide.items}</p>
          <p className="muted">Estimated {fmtMoney(modal.decide.estimated_amount)} · requested by {modal.decide.requested_by_name}</p>
          <EntityForm submitLabel="Save decision" initial={{ decision: 'approved' }}
            fields={[{ name: 'decision', label: 'Decision', type: 'select', required: true, options: opts(['approved', 'rejected']) }, { name: 'notes', label: 'Notes', wide: true }]}
            onCancel={() => setModal(null)} onSubmit={async (d) => { await api.post(`/purchases/${modal.decide.id}/decision`, d); done(); }} />
        </Modal>
      )}
    </div>
  );
}
