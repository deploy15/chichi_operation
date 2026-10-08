import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtMoney, opts } from '../lib/format';
import ResourcePage from '../components/ResourcePage';
import { EntityForm, Modal, PageHeader } from '../components/ui';
import { WORKER_FIELDS } from './workerFields';

export default function Workers() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(null);
  const [version, setVersion] = useState(0);
  const startAdd = async () => {
    const { code } = await api.get('/workers/next-code').catch(() => ({ code: '' }));
    setAdding({ worker_code: code, status: 'active', pay_rate_type: 'daily', pay_rate: 0 });
  };
  return (
    <div>
      <PageHeader title="Workers" subtitle="Daily and temporary workers, their documents and assignment history"
        actions={can('workers.manage') && <button className="btn" onClick={startAdd}>+ Add worker</button>} />
      <ResourcePage key={version} endpoint="/workers" noun="worker" canManage={false} fields={WORKER_FIELDS}
        onRowClick={(r) => navigate(`/workers/${r.id}`)}
        filters={[{ name: 'status', label: 'Status', type: 'select', options: opts(['active', 'inactive', 'suspended', 'terminated']) }]}
        columns={[
          { key: 'worker_code', label: 'ID' },
          { key: 'name', label: 'Name', render: (r) => `${r.first_name} ${r.last_name}` },
          { key: 'job_position', label: 'Position' }, { key: 'category', label: 'Category' },
          { key: 'current_assignment', label: 'Current site / project', render: (r) => r.current_assignment || <span className="muted">Not assigned</span> },
          { key: 'pay', label: 'Pay rate', num: true, render: (r) => `${fmtMoney(r.pay_rate)} / ${r.pay_rate_type === 'hourly' ? 'hour' : 'day'}` },
          { key: 'status', label: 'Status', type: 'badge' },
        ]} />
      {adding && (
        <Modal title="New worker" wide onClose={() => setAdding(null)}>
          <EntityForm fields={WORKER_FIELDS} initial={adding} onCancel={() => setAdding(null)}
            onSubmit={async (d) => { const w = await api.post('/workers', d); setAdding(null); setVersion((v) => v + 1); navigate(`/workers/${w.id}`); }} />
        </Modal>
      )}
    </div>
  );
}
