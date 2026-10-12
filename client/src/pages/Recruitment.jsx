import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { opts } from '../lib/format';
import ResourcePage from '../components/ResourcePage';
import { EntityForm, Modal, PageHeader, Tabs, useOptions } from '../components/ui';

const CANDIDATE_STATUSES = ['registered', 'documents_verified', 'documents_rejected', 'approved', 'rejected', 'hired'];

export default function Recruitment() {
  const [tab, setTab] = useState('candidates');
  return (
    <div>
      <PageHeader title="Recruitment" subtitle="Job profiles, candidates, document checks and selection" />
      <Tabs tabs={[{ key: 'candidates', label: 'Candidates' }, { key: 'profiles', label: 'Job profiles' }]} value={tab} onChange={setTab} />
      {tab === 'candidates' ? <Candidates /> : <Profiles />}
    </div>
  );
}

function Candidates() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const profiles = useOptions('/recruitment/job-profiles', (p) => ({ value: p.id, label: p.title }));
  const [modal, setModal] = useState(null);
  const [v, setV] = useState(0);
  const done = () => { setModal(null); setV((x) => x + 1); };
  const actions = (c) => (
    <span className="row-actions">
      {can('recruitment.verify') && ['registered', 'documents_rejected', 'documents_verified'].includes(c.status) &&
        <button className="link" onClick={() => setModal({ verify: c })}>Check documents</button>}
      {can('recruitment.approve') && c.status === 'documents_verified' && <button className="link" onClick={() => setModal({ decide: c })}>Decide</button>}
      {can('workers.manage') && c.status === 'approved' && <button className="link" onClick={() => setModal({ hire: c })}>Hire</button>}
      {c.status === 'hired' && c.worker_id && <button className="link" onClick={() => navigate(`/workers/${c.worker_id}`)}>Worker {c.worker_code}</button>}
    </span>
  );
  return (
    <>
      <ResourcePage key={v} endpoint="/recruitment/candidates" noun="candidate" canManage={can('recruitment.manage')}
        filters={[{ name: 'status', label: 'Status', type: 'select', options: opts(CANDIDATE_STATUSES) }, { name: 'job_profile_id', label: 'Job profile', type: 'select', options: profiles }]}
        columns={[
          { key: 'name', label: 'Name', render: (c) => `${c.first_name} ${c.last_name}` }, { key: 'job_title', label: 'Job profile' },
          { key: 'phone', label: 'Phone' }, { key: 'national_id', label: 'ID no.' },
          { key: 'docs', label: 'Documents', render: (c) => (c.verified_at ? `ID ${c.id_document_ok ? '✓' : '✗'} · Qualifications ${c.qualifications_ok ? '✓' : '✗'}` : '') },
          { key: 'status', label: 'Status', type: 'badge' }, { key: 'created_at', label: 'Registered', type: 'date' },
        ]}
        rowActions={actions}
        fields={[{ name: 'job_profile_id', label: 'Job profile', type: 'select', options: profiles }, { name: 'first_name', label: 'First name', required: true },
          { name: 'last_name', label: 'Last name', required: true }, { name: 'phone', label: 'Phone' }, { name: 'email', label: 'Email', type: 'email' },
          { name: 'national_id', label: 'National ID / passport no.' }, { name: 'qualifications', label: 'Qualifications and experience', type: 'textarea', wide: true }]} />
      {modal && modal.verify && (
        <Modal title={`Check documents: ${modal.verify.first_name} ${modal.verify.last_name}`} onClose={() => setModal(null)}>
          <p className="muted">ID no. {modal.verify.national_id || 'not given'} · {modal.verify.qualifications || 'No qualifications recorded'}</p>
          <EntityForm submitLabel="Save check" initial={{ id_document_ok: !!modal.verify.id_document_ok, qualifications_ok: !!modal.verify.qualifications_ok, notes: modal.verify.verification_notes }}
            fields={[{ name: 'id_document_ok', label: 'ID document is valid', type: 'checkbox' }, { name: 'qualifications_ok', label: 'Qualifications are valid', type: 'checkbox' },
              { name: 'notes', label: 'Notes', wide: true }]}
            onCancel={() => setModal(null)} onSubmit={async (d) => { await api.post(`/recruitment/candidates/${modal.verify.id}/verify`, d); done(); }} />
        </Modal>
      )}
      {modal && modal.decide && (
        <Modal title={`Selection: ${modal.decide.first_name} ${modal.decide.last_name}`} onClose={() => setModal(null)}>
          <EntityForm submitLabel="Save decision" initial={{ decision: 'approved' }}
            fields={[{ name: 'decision', label: 'Decision', type: 'select', required: true, options: opts(['approved', 'rejected']) }, { name: 'notes', label: 'Notes', wide: true }]}
            onCancel={() => setModal(null)} onSubmit={async (d) => { await api.post(`/recruitment/candidates/${modal.decide.id}/decision`, d); done(); }} />
        </Modal>
      )}
      {modal && modal.hire && (
        <Modal title={`Hire ${modal.hire.first_name} ${modal.hire.last_name}`} onClose={() => setModal(null)}>
          <p className="muted">Creates a worker record marked "available", ready to be assigned to a site.</p>
          <EntityForm submitLabel="Create worker" fields={[{ name: 'worker_code', label: 'Worker ID (leave empty for the next free number)' }]}
            onCancel={() => setModal(null)} onSubmit={async (d) => { const r = await api.post(`/recruitment/candidates/${modal.hire.id}/hire`, d); navigate(`/workers/${r.worker_id}`); }} />
        </Modal>
      )}
    </>
  );
}

function Profiles() {
  const { can } = useAuth();
  return (
    <ResourcePage endpoint="/recruitment/job-profiles" noun="job profile" canManage={can('recruitment.manage')}
      filters={[{ name: 'status', label: 'Status', type: 'select', options: opts(['open', 'closed']) }]}
      newDefaults={{ status: 'open' }}
      columns={[{ key: 'title', label: 'Job' }, { key: 'category', label: 'Category' }, { key: 'required_documents', label: 'Documents required' },
        { key: 'open_candidates', label: 'Candidates in progress', num: true }, { key: 'status', label: 'Status', type: 'badge' }]}
      fields={[{ name: 'title', label: 'Job title', required: true }, { name: 'category', label: 'Category', help: 'e.g. General, Skilled' },
        { name: 'status', label: 'Status', type: 'select', options: opts(['open', 'closed']) },
        { name: 'required_documents', label: 'Documents required', help: 'e.g. ID card, trade certificate', wide: true },
        { name: 'requirements', label: 'Requirements', type: 'textarea', wide: true }]} />
  );
}

