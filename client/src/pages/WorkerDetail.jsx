import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fileToBase64, openFile } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtMoney, label, todayStr } from '../lib/format';
import { Alert, Badge, Card, EntityForm, ErrorMsg, Loading, Modal, PageHeader, Table, useLoad } from '../components/ui';
import { WORKER_FIELDS } from './workerFields';

const MEAL_OPTS = [{ value: 'lunch', label: 'Lunch' }, { value: 'dinner', label: 'Dinner' }];

export default function WorkerDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const worker = useLoad(() => api.get(`/workers/${id}`), [id]);
  const assignments = useLoad(() => api.get(`/workers/${id}/assignments`), [id]);
  const docs = useLoad(() => api.get(`/workers/${id}/documents`), [id]);
  const tree = useLoad(() => api.get('/structure/tree'), []);
  const [modal, setModal] = useState(null);
  const [msg, setMsg] = useState(null);

  if (worker.error) return <ErrorMsg error={worker.error} />;
  if (!worker.data) return <Loading />;
  const w = worker.data;
  const siteOptions = (tree.data || []).flatMap((c) => c.projects.flatMap((p) => p.sites.map((s) => ({ value: s.id, label: `${s.name} — ${p.name} (${c.name})` }))));
  const hasOpen = (assignments.data || []).some((a) => a.status === 'active' && !a.end_date);

  return (
    <div>
      <p><Link to="/workers">← All workers</Link></p>
      <PageHeader title={`${w.first_name} ${w.last_name}`} subtitle={`${w.worker_code} · ${w.job_position || 'No position'} · ${w.category || 'No category'}`}
        actions={<><Badge value={w.status} />{can('workers.manage') && <button className="btn btn-ghost" onClick={() => setModal('edit')}>Edit details</button>}</>} />
      <Alert tone="success" onClose={() => setMsg(null)}>{msg}</Alert>
      <div className="grid-2">
        <Card title="Contact and identity">
          <dl className="details">
            <dt>Phone</dt><dd>{w.phone}</dd><dt>Email</dt><dd>{w.email}</dd><dt>Address</dt><dd>{w.address}</dd>
            <dt>Date of birth</dt><dd>{fmtDate(w.date_of_birth)}</dd><dt>National ID</dt><dd>{w.national_id}</dd>
            <dt>Emergency contact</dt><dd>{w.emergency_contact_name} {w.emergency_contact_phone}</dd>
            <dt>Pay rate</dt><dd>{fmtMoney(w.pay_rate)} per {w.pay_rate_type === 'hourly' ? 'hour' : 'day'}</dd>
          </dl>
        </Card>
        <Card title="Documents" actions={can('workers.manage') && <button className="btn btn-small" onClick={() => setModal('doc')}>+ Add document</button>}>
          <Table rows={docs.data} empty="No documents yet."
            columns={[{ key: 'doc_type', label: 'Type' }, { key: 'doc_number', label: 'Number' }, { key: 'expiry_date', label: 'Expires', type: 'date' },
              { key: 'file', label: 'File', render: (d) => (d.has_file ? <button className="link" onClick={() => openFile(`/documents/${d.id}/file`, d.file_name)}>{d.file_name}</button> : '') },
              { key: 'del', label: '', render: (d) => can('workers.manage') && <button className="link danger" onClick={async () => { if (window.confirm('Delete this document?')) { await api.del(`/documents/${d.id}`); docs.reload(); } }}>Delete</button> }]} />
        </Card>
      </div>
      <Card title="Assignment history" actions={can('assignments.manage') && <button className="btn btn-small" onClick={() => setModal('assign')}>+ New assignment</button>}>
        <p className="muted small">Past assignments are kept permanently. To move a worker, add a new assignment — the current one is closed automatically.</p>
        <Table rows={assignments.data} empty="This worker has never been assigned."
          columns={[
            { key: 'client_name', label: 'Client' }, { key: 'project_name', label: 'Project' }, { key: 'site_name', label: 'Site' },
            { key: 'start_date', label: 'From', type: 'date' }, { key: 'end_date', label: 'To', render: (a) => (a.end_date ? fmtDate(a.end_date) : 'Ongoing') },
            { key: 'job_position', label: 'Position' }, { key: 'pay', label: 'Rate', render: (a) => `${fmtMoney(a.pay_rate)}/${a.pay_rate_type === 'hourly' ? 'h' : 'day'}` },
            { key: 'meals', label: 'Meals', render: (a) => a.meals.map(label).join(', ') || 'None' },
            { key: 'status', label: 'Status', type: 'badge' },
            { key: 'act', label: '', render: (a) => can('assignments.manage') && a.status === 'active' && (
              <span className="row-actions">
                <button className="link" onClick={() => setModal({ meals: a })}>Meals</button>
                <button className="link" onClick={() => setModal({ end: a })}>End</button>
              </span>) },
          ]} />
      </Card>

      {modal === 'edit' && (
        <Modal title="Edit worker" wide onClose={() => setModal(null)}>
          <EntityForm fields={WORKER_FIELDS} initial={w} onCancel={() => setModal(null)}
            onSubmit={async (d) => { await api.put(`/workers/${id}`, d); setModal(null); worker.reload(); }} />
        </Modal>
      )}
      {modal === 'assign' && (
        <Modal title="New assignment" onClose={() => setModal(null)}>
          <EntityForm submitLabel="Assign"
            initial={{ start_date: todayStr(), meals: ['lunch'], end_previous: hasOpen, job_position: w.job_position, pay_rate: w.pay_rate, pay_rate_type: w.pay_rate_type }}
            fields={[
              { name: 'site_id', label: 'Site (project and client are filled in automatically)', type: 'select', options: siteOptions, required: true, wide: true },
              { name: 'start_date', label: 'Start date', type: 'date', required: true },
              { name: 'end_date', label: 'End date (leave empty if unknown)', type: 'date' },
              { name: 'job_position', label: 'Job position' },
              { name: 'pay_rate', label: 'Pay rate', type: 'number' },
              { name: 'pay_rate_type', label: 'Paid per', type: 'select', options: [{ value: 'daily', label: 'Day' }, { value: 'hourly', label: 'Hour' }] },
              { name: 'meals', label: 'Meals included', type: 'checkboxes', options: MEAL_OPTS },
              { name: 'end_previous', label: 'End the current assignment the day before', type: 'checkbox', hidden: !hasOpen },
              { name: 'notes', label: 'Notes', wide: true },
            ]}
            onCancel={() => setModal(null)}
            onSubmit={async (d) => { await api.post(`/workers/${id}/assignments`, d); setModal(null); setMsg('Assignment saved.'); assignments.reload(); worker.reload(); }} />
        </Modal>
      )}
      {modal && modal.end && (
        <Modal title="End assignment" onClose={() => setModal(null)}>
          <p>{modal.end.site_name} — {modal.end.project_name}, since {fmtDate(modal.end.start_date)}</p>
          <EntityForm submitLabel="End assignment" initial={{ end_date: todayStr() }}
            fields={[{ name: 'end_date', label: 'Last working day', type: 'date', required: true }, { name: 'reason', label: 'Reason' }]}
            onCancel={() => setModal(null)}
            onSubmit={async (d) => { await api.post(`/assignments/${modal.end.id}/end`, d); setModal(null); assignments.reload(); }} />
        </Modal>
      )}
      {modal && modal.meals && (
        <Modal title="Meal entitlement" onClose={() => setModal(null)}>
          <p className="muted">Only meals ticked here are counted when the worker is present.</p>
          <EntityForm initial={{ meals: modal.meals.meals }} fields={[{ name: 'meals', label: 'Meals included', type: 'checkboxes', options: MEAL_OPTS }]}
            onCancel={() => setModal(null)}
            onSubmit={async (d) => { await api.put(`/assignments/${modal.meals.id}/meals`, d); setModal(null); assignments.reload(); }} />
        </Modal>
      )}
      {modal === 'doc' && (
        <Modal title="Add document" onClose={() => setModal(null)}>
          <DocForm onDone={() => { setModal(null); docs.reload(); }} workerId={id} onCancel={() => setModal(null)} />
        </Modal>
      )}
    </div>
  );
}

function DocForm({ workerId, onDone, onCancel }) {
  const [file, setFile] = useState(null);
  return (
    <>
      <div className="field"><label htmlFor="docfile">File (optional, max 5 MB)</label>
        <input id="docfile" type="file" onChange={(e) => setFile(e.target.files[0] || null)} /></div>
      <EntityForm
        fields={[{ name: 'doc_type', label: 'Document type', required: true, help: 'e.g. ID card, Contract, Work permit' },
          { name: 'doc_number', label: 'Number' }, { name: 'issue_date', label: 'Issued', type: 'date' }, { name: 'expiry_date', label: 'Expires', type: 'date' },
          { name: 'notes', label: 'Notes', wide: true }]}
        onCancel={onCancel}
        onSubmit={async (d) => {
          const body = { ...d };
          if (file) {
            if (file.size > 5 * 1024 * 1024) throw new Error('File is too large (max 5 MB)');
            Object.assign(body, { file_base64: await fileToBase64(file), file_name: file.name, file_mime: file.type });
          }
          await api.post(`/workers/${workerId}/documents`, body);
          onDone();
        }} />
    </>
  );
}
