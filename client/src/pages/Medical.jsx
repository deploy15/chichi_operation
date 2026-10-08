import { useState } from 'react';
import { api, fileToBase64, openFile } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, opts } from '../lib/format';
import ResourcePage from '../components/ResourcePage';
import { Alert, Badge, Card, EntityForm, Modal, PageHeader, Table, Tabs, useLoad, useOptions } from '../components/ui';

const TYPES = ['examination', 'appointment', 'fitness', 'restriction', 'certificate', 'incident_followup'];

export default function Medical() {
  const { can } = useAuth();
  const [tab, setTab] = useState('attention');
  return (
    <div>
      <PageHeader title="Medical" subtitle="Confidential. Only authorised medical staff can see this page, and every record opened is logged." />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'attention', label: 'Needs attention' }, { key: 'records', label: 'All records' }]} />
      {tab === 'attention' ? <Attention /> : <Records manage={can('medical.manage')} />}
    </div>
  );
}

function Attention() {
  const { data, error } = useLoad(() => api.get('/medical/summary'), []);
  const cols = [{ key: 'worker_name', label: 'Worker' }, { key: 'title', label: 'Record' }, { key: 'record_date', label: 'Date', type: 'date' },
    { key: 'valid_until', label: 'Valid until', type: 'date' }, { key: 'fitness_result', label: 'Result', type: 'badge' }, { key: 'status', label: 'Status', type: 'badge' }];
  if (error) return <Alert tone="error">{error.message}</Alert>;
  if (!data) return null;
  return (
    <div className="grid-2">
      <Card title="Upcoming appointments"><Table rows={data.upcoming_appointments} columns={cols} empty="None." /></Card>
      <Card title="Clearances expiring within 30 days"><Table rows={data.expiring_soon} columns={cols} empty="None." /></Card>
      <Card title="Expired clearances / certificates"><Table rows={data.expired} columns={cols} empty="None." /></Card>
      <Card title="Unfit or restricted workers"><Table rows={data.restricted_or_unfit} columns={[...cols, { key: 'restriction_details', label: 'Restriction' }]} empty="None." /></Card>
      <Card title="Open incident follow-ups"><Table rows={data.open_followups} columns={cols} empty="None." /></Card>
    </div>
  );
}

function Records({ manage }) {
  const workers = useOptions('/workers', (w) => ({ value: w.id, label: `${w.first_name} ${w.last_name} (${w.worker_code})` }));
  const [upload, setUpload] = useState(null);
  const [v, setV] = useState(0);
  return (
    <>
      <ResourcePage key={v} endpoint="/medical/records" noun="medical record" canManage={manage}
        filters={[{ name: 'record_type', label: 'Type', type: 'select', options: opts(TYPES) }, { name: 'worker_id', label: 'Worker', type: 'select', options: workers }]}
        newDefaults={{ record_date: new Date().toISOString().slice(0, 10), status: 'completed', record_type: 'examination' }}
        columns={[{ key: 'record_date', label: 'Date', type: 'date' }, { key: 'worker_name', label: 'Worker' }, { key: 'record_type', label: 'Type', type: 'label' },
          { key: 'title', label: 'Title' }, { key: 'fitness_result', label: 'Result', type: 'badge' }, { key: 'valid_until', label: 'Valid until', render: (r) => fmtDate(r.valid_until) },
          { key: 'status', label: 'Status', type: 'badge' },
          { key: 'file', label: 'File', render: (r) => (Number(r.has_file) ? <button className="link" onClick={(e) => { e.stopPropagation(); openFile(`/medical/records/${r.id}/file`, r.file_name); }}>{r.file_name}</button> : '') }]}
        rowActions={(r) => manage && <button className="link" onClick={() => setUpload(r)}>Attach file</button>}
        fields={[
          { name: 'worker_id', label: 'Worker', type: 'select', options: workers, required: true },
          { name: 'record_type', label: 'Type', type: 'select', options: opts(TYPES), required: true },
          { name: 'record_date', label: 'Date', type: 'date', required: true },
          { name: 'title', label: 'Title', required: true },
          { name: 'provider', label: 'Doctor / clinic' },
          { name: 'status', label: 'Status', type: 'select', options: opts(['scheduled', 'completed', 'cancelled', 'open', 'closed']) },
          { name: 'fitness_result', label: 'Fitness result', type: 'select', options: opts(['fit', 'fit_with_restrictions', 'unfit', 'pending']) },
          { name: 'valid_until', label: 'Valid until', type: 'date' },
          { name: 'restriction_details', label: 'Work restrictions', wide: true },
          { name: 'hse_incident_id', label: 'Related HSE incident number', type: 'number' },
          { name: 'notes', label: 'Notes', type: 'textarea', wide: true },
        ]} />
      {upload && (
        <Modal title="Attach file" onClose={() => setUpload(null)}>
          <FileUpload onCancel={() => setUpload(null)} onUpload={async (body) => { await api.post(`/medical/records/${upload.id}/file`, body); setUpload(null); setV((x) => x + 1); }} />
        </Modal>
      )}
    </>
  );
}

export function FileUpload({ onUpload, onCancel }) {
  const [file, setFile] = useState(null);
  const [error, setError] = useState(null);
  const go = async () => {
    setError(null);
    if (!file) return setError('Choose a file');
    if (file.size > 5 * 1024 * 1024) return setError('File is too large (max 5 MB)');
    try { await onUpload({ file_base64: await fileToBase64(file), file_name: file.name, file_mime: file.type || 'application/octet-stream' }); } catch (e) { setError(e.message); }
  };
  return (
    <div>
      <Alert tone="error">{error}</Alert>
      <input type="file" accept="image/*,application/pdf,.doc,.docx" capture="environment" onChange={(e) => setFile(e.target.files[0] || null)} aria-label="File" />
      <div className="form-actions"><button className="btn btn-ghost" onClick={onCancel}>Cancel</button><button className="btn" onClick={go}>Upload</button></div>
      <Badge value={file ? file.name : null} />
    </div>
  );
}
