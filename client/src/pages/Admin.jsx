import { useState } from 'react';
import { api, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { label } from '../lib/format';
import { Alert, Card, EntityForm, ErrorMsg, Modal, PageHeader, Table, Tabs, useLoad, useOptions } from '../components/ui';

export default function Admin() {
  const { can } = useAuth();
  const tabs = [can('users.manage') && { key: 'users', label: 'Users' }, can('users.manage') && { key: 'roles', label: 'Roles & permissions' },
    can('users.manage') && { key: 'settings', label: 'Settings' }, can('audit.view') && { key: 'audit', label: 'Audit log' }].filter(Boolean);
  const [tab, setTab] = useState(tabs[0] ? tabs[0].key : 'audit');
  return (
    <div>
      <PageHeader title="Users & settings" />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'users' && <Users />}
      {tab === 'roles' && <Roles />}
      {tab === 'settings' && <Settings />}
      {tab === 'audit' && <Audit />}
    </div>
  );
}

function Users() {
  const list = useLoad(() => api.get('/users'), []);
  const roles = useOptions('/roles', (r) => ({ value: r.id, label: r.name }));
  const sites = useOptions('/structure/sites', (s) => ({ value: s.id, label: `${s.name} (${s.project_name})` }));
  const kitchens = useOptions('/kitchens', (k) => ({ value: k.id, label: k.name }));
  const [editing, setEditing] = useState(null);
  const siteNames = (ids) => ids.map((id) => (sites.find((s) => s.value === id) || {}).label).filter(Boolean).join(', ');
  const fields = [
    { name: 'name', label: 'Full name', required: true }, { name: 'email', label: 'Email (used to sign in)', type: 'email', required: true },
    { name: 'role_id', label: 'Role', type: 'select', options: roles, required: true },
    { name: 'password', label: editing && editing.id ? 'New password (leave empty to keep)' : 'Password (at least 8 characters)', type: 'password', required: !(editing && editing.id) },
    { name: 'active', label: 'Account active', type: 'checkbox' },
    { name: 'site_ids', label: 'Sites this user is responsible for (needed for site managers)', type: 'checkboxes', options: sites, wide: true },
    { name: 'kitchen_ids', label: 'Kitchens this user manages (needed for kitchen managers)', type: 'checkboxes', options: kitchens, wide: true },
  ];
  return (
    <div>
      <div className="toolbar"><div className="spacer" /><button className="btn" onClick={() => setEditing({ active: true, site_ids: [], kitchen_ids: [] })}>+ Add user</button></div>
      <ErrorMsg error={list.error} />
      <Table rows={list.data} onRowClick={(u) => setEditing({ ...u, active: !!u.active })}
        columns={[{ key: 'name', label: 'Name' }, { key: 'email', label: 'Email' }, { key: 'role_name', label: 'Role' },
          { key: 'sites', label: 'Sites', render: (u) => siteNames(u.site_ids) }, { key: 'active', label: 'Status', render: (u) => (u.active ? 'Active' : 'Disabled') },
          { key: 'last_login_at', label: 'Last sign-in', type: 'datetime' }]} />
      {editing && (
        <Modal title={editing.id ? 'Edit user' : 'New user'} wide onClose={() => setEditing(null)}>
          <EntityForm fields={fields} initial={editing} onCancel={() => setEditing(null)}
            onSubmit={async (d) => {
              const body = { ...d, site_ids: (d.site_ids || []).map(Number), kitchen_ids: (d.kitchen_ids || []).map(Number) };
              if (!body.password) delete body.password;
              if (editing.id) await api.put(`/users/${editing.id}`, body); else await api.post('/users', body);
              setEditing(null); list.reload();
            }} />
        </Modal>
      )}
    </div>
  );
}

function Roles() {
  const roles = useLoad(() => api.get('/roles'), []);
  const perms = useLoad(() => api.get('/permissions'), []);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(null);
  const modules = perms.data ? [...new Set(perms.data.map((p) => p.module))] : [];
  const save = async () => {
    setError(null);
    try {
      if (editing.id) await api.put(`/roles/${editing.id}`, { name: editing.name, description: editing.description, permissions: editing.name === 'Super Administrator' ? undefined : editing.permissions });
      else await api.post('/roles', editing);
      setSaved(`Role "${editing.name}" saved. Changes apply immediately.`);
      setEditing(null); roles.reload();
    } catch (e) { setError(e); }
  };
  const toggle = (code) => setEditing((r) => ({ ...r, permissions: r.permissions.includes(code) ? r.permissions.filter((c) => c !== code) : [...r.permissions, code] }));
  return (
    <div>
      <Alert tone="success" onClose={() => setSaved(null)}>{saved}</Alert>
      <div className="toolbar"><p className="muted">Each role is a set of permissions. Users get the permissions of their role.</p><div className="spacer" />
        <button className="btn" onClick={() => setEditing({ name: '', description: '', permissions: [] })}>+ New role</button></div>
      <Table rows={roles.data} onRowClick={(r) => setEditing({ ...r })}
        columns={[{ key: 'name', label: 'Role' }, { key: 'description', label: 'Description' }, { key: 'user_count', label: 'Users', num: true },
          { key: 'permissions', label: 'Permissions', num: true, render: (r) => r.permissions.length }]} />
      {editing && (
        <Modal title={editing.id ? `Role: ${editing.name}` : 'New role'} wide onClose={() => setEditing(null)}>
          <ErrorMsg error={error} />
          <div className="form-grid">
            <div className="field"><label htmlFor="rname">Name</label><input id="rname" value={editing.name} disabled={editing.name === 'Super Administrator'} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></div>
            <div className="field"><label htmlFor="rdesc">Description</label><input id="rdesc" value={editing.description || ''} onChange={(e) => setEditing({ ...editing, description: e.target.value })} /></div>
          </div>
          {editing.name === 'Super Administrator' && <Alert tone="info">This role always has every permission.</Alert>}
          {modules.map((m) => (
            <fieldset key={m} className="perm-group">
              <legend>{m}</legend>
              {perms.data.filter((p) => p.module === m).map((p) => (
                <label key={p.code} className="check perm">
                  <input type="checkbox" checked={editing.permissions.includes(p.code)} disabled={editing.name === 'Super Administrator'} onChange={() => toggle(p.code)} />
                  {p.description}
                </label>
              ))}
            </fieldset>
          ))}
          <div className="form-actions">
            {editing.id && !editing.user_count && editing.name !== 'Super Administrator' && (
              <button className="btn btn-danger-ghost" onClick={async () => { if (window.confirm('Delete this role?')) { try { await api.del(`/roles/${editing.id}`); setEditing(null); roles.reload(); } catch (e) { setError(e); } } }}>Delete role</button>
            )}
            <div className="spacer" />
            <button className="btn btn-ghost" onClick={() => setEditing(null)}>Cancel</button><button className="btn" onClick={save}>Save role</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Settings() {
  const s = useLoad(() => api.get('/settings'), []);
  const [saved, setSaved] = useState(false);
  if (!s.data) return <ErrorMsg error={s.error} />;
  return (
    <Card>
      {saved && <Alert tone="success">Settings saved.</Alert>}
      <EntityForm initial={Object.fromEntries(s.data.map((x) => [x.setting_key, x.setting_value]))}
        fields={s.data.map((x) => ({ name: x.setting_key, label: label(x.setting_key), help: x.description, required: true }))}
        onSubmit={async (d) => { await api.put('/settings', d); setSaved(true); }} />
    </Card>
  );
}

function Audit() {
  const [entity, setEntity] = useState('');
  const list = useLoad(() => api.get(`/audit${qs({ entity })}`), [entity]);
  return (
    <div>
      <div className="toolbar"><input placeholder="Filter by record type, e.g. worker, attendance, medical_record" value={entity} onChange={(e) => setEntity(e.target.value)} aria-label="Record type" /></div>
      <ErrorMsg error={list.error} />
      <Table rows={list.data} columns={[{ key: 'created_at', label: 'When', type: 'datetime' }, { key: 'user_name', label: 'Who' }, { key: 'action', label: 'Action', type: 'label' },
        { key: 'entity', label: 'Record', type: 'label' }, { key: 'entity_id', label: 'No.' },
        { key: 'details', label: 'Details', render: (l) => <code className="small">{l.details ? JSON.stringify(l.details).slice(0, 160) : ''}</code> }, { key: 'ip', label: 'IP' }]} />
      <p className="muted small">Showing the latest 300 entries. Times are in your local time.</p>
    </div>
  );
}
