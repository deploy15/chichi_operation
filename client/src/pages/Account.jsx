import { useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Alert, Card, EntityForm, PageHeader } from '../components/ui';

export default function Account() {
  const { user, logout } = useAuth();
  const [done, setDone] = useState(false);
  return (
    <div>
      <PageHeader title="My account" subtitle={`${user.name} · ${user.email} · ${user.role}`} actions={<button className="btn btn-ghost" onClick={logout}>Sign out</button>} />
      <Card title="Change password">
        {done && <Alert tone="success">Password changed.</Alert>}
        <EntityForm key={String(done)} submitLabel="Change password"
          fields={[
            { name: 'currentPassword', label: 'Current password', type: 'password', required: true },
            { name: 'newPassword', label: 'New password (at least 8 characters)', type: 'password', required: true },
          ]}
          onSubmit={async (d) => { await api.post('/auth/change-password', d); setDone(true); }} />
      </Card>
    </div>
  );
}
