import { useState } from 'react';
import { useAuth } from '../lib/auth';
import { opts } from '../lib/format';
import ResourcePage from '../components/ResourcePage';
import { PageHeader, Tabs, useOptions } from '../components/ui';

export default function Structure() {
  const { can } = useAuth();
  const [tab, setTab] = useState('clients');
  const manage = can('structure.manage');
  const clients = useOptions('/structure/clients', (c) => ({ value: c.id, label: c.name }));
  const projects = useOptions('/structure/projects', (p) => ({ value: p.id, label: `${p.name} (${p.client_name})` }));
  return (
    <div>
      <PageHeader title="Clients, projects and sites" subtitle="Company → Clients → Projects → Sites" />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'clients', label: 'Clients' }, { key: 'projects', label: 'Projects' }, { key: 'sites', label: 'Sites' }]} />
      {tab === 'clients' && (
        <ResourcePage key="c" endpoint="/structure/clients" noun="client" canManage={manage} canDelete={manage}
          filters={[{ name: 'status', label: 'Status', type: 'select', options: opts(['active', 'inactive']) }]}
          columns={[{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'contact_name', label: 'Contact' },
            { key: 'contact_phone', label: 'Phone' }, { key: 'project_count', label: 'Projects', num: true }, { key: 'status', label: 'Status', type: 'badge' }]}
          fields={[
            { name: 'code', label: 'Code', required: true }, { name: 'name', label: 'Name', required: true },
            { name: 'contact_name', label: 'Contact person' }, { name: 'contact_email', label: 'Contact email', type: 'email' },
            { name: 'contact_phone', label: 'Contact phone' }, { name: 'status', label: 'Status', type: 'select', options: opts(['active', 'inactive']) },
          ]} newDefaults={{ status: 'active' }} />
      )}
      {tab === 'projects' && (
        <ResourcePage key="p" endpoint="/structure/projects" noun="project" canManage={manage} canDelete={manage}
          filters={[{ name: 'client_id', label: 'Client', type: 'select', options: clients }]}
          columns={[{ key: 'code', label: 'Code' }, { key: 'name', label: 'Project' }, { key: 'client_name', label: 'Client' }, { key: 'location', label: 'Location' },
            { key: 'start_date', label: 'Start', type: 'date' }, { key: 'site_count', label: 'Sites', num: true }, { key: 'status', label: 'Status', type: 'badge' }]}
          fields={[
            { name: 'client_id', label: 'Client', type: 'select', options: clients, required: true },
            { name: 'code', label: 'Code', required: true }, { name: 'name', label: 'Name', required: true }, { name: 'location', label: 'Location' },
            { name: 'start_date', label: 'Start date', type: 'date' }, { name: 'end_date', label: 'End date', type: 'date' },
            { name: 'status', label: 'Status', type: 'select', options: opts(['planned', 'active', 'on_hold', 'completed']) },
          ]} newDefaults={{ status: 'active' }} />
      )}
      {tab === 'sites' && (
        <ResourcePage key="s" endpoint="/structure/sites" noun="site" canManage={manage} canDelete={manage}
          filters={[{ name: 'client_id', label: 'Client', type: 'select', options: clients }, { name: 'project_id', label: 'Project', type: 'select', options: projects }]}
          columns={[{ key: 'code', label: 'Code' }, { key: 'name', label: 'Site' }, { key: 'project_name', label: 'Project' }, { key: 'client_name', label: 'Client' },
            { key: 'location', label: 'Location' }, { key: 'status', label: 'Status', type: 'badge' }]}
          fields={[
            { name: 'project_id', label: 'Project', type: 'select', options: projects, required: true },
            { name: 'code', label: 'Code', required: true }, { name: 'name', label: 'Name', required: true }, { name: 'location', label: 'Location' },
            { name: 'status', label: 'Status', type: 'select', options: opts(['active', 'inactive', 'closed']) },
          ]} newDefaults={{ status: 'active' }} />
      )}
    </div>
  );
}
