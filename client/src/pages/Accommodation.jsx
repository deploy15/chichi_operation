import { useState } from 'react';
import { api, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, opts, todayStr } from '../lib/format';
import ResourcePage from '../components/ResourcePage';
import { Card, EntityForm, ErrorMsg, Modal, PageHeader, Stat, Table, Tabs, useLoad, useOptions } from '../components/ui';

export default function Accommodation() {
  const { can } = useAuth();
  const manage = can('accommodation.manage');
  const [tab, setTab] = useState('occupants');
  const summary = useLoad(() => api.get('/accommodation/summary'), [tab]);
  const s = summary.data;
  return (
    <div>
      <PageHeader title="Accommodation" subtitle="Total capacity → occupied → available" />
      {s && (
        <div className="stats">
          <Stat label="Total beds" value={s.total.capacity} /><Stat label="Occupied" value={s.total.occupied} /><Stat label="Available" value={s.total.available} tone="green" />
          {s.facilities.map((f) => <Stat key={f.facility_id} label={f.facility_name} value={`${f.available} free`} hint={`${f.occupied} of ${f.capacity} occupied · ${f.rooms} rooms`} />)}
        </div>
      )}
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'occupants', label: 'Who is staying' }, { key: 'rooms', label: 'Rooms' }, { key: 'buildings', label: 'Buildings' }, { key: 'facilities', label: 'Facilities' }, { key: 'history', label: 'History' }]} />
      {tab === 'occupants' && <Occupants manage={manage} active onChange={summary.reload} />}
      {tab === 'history' && <Occupants manage={false} />}
      {tab === 'rooms' && <Rooms manage={manage} />}
      {tab === 'buildings' && <Buildings manage={manage} />}
      {tab === 'facilities' && (
        <ResourcePage endpoint="/accommodation/facilities" noun="facility" canManage={manage} canDelete={manage}
          columns={[{ key: 'name', label: 'Facility' }, { key: 'location', label: 'Location' }, { key: 'capacity', label: 'Beds', num: true }, { key: 'notes', label: 'Notes' }]}
          fields={[{ name: 'name', label: 'Name', required: true }, { name: 'location', label: 'Location' }, { name: 'notes', label: 'Notes', wide: true }]} />
      )}
    </div>
  );
}

function Buildings({ manage }) {
  const facilities = useOptions('/accommodation/facilities', (f) => ({ value: f.id, label: f.name }));
  return (
    <ResourcePage endpoint="/accommodation/buildings" noun="building" canManage={manage} canDelete={manage} search={false}
      filters={[{ name: 'facility_id', label: 'Facility', type: 'select', options: facilities }]}
      columns={[{ key: 'facility_name', label: 'Facility' }, { key: 'name', label: 'Building' }]}
      fields={[{ name: 'facility_id', label: 'Facility', type: 'select', options: facilities, required: true }, { name: 'name', label: 'Name', required: true }]} />
  );
}

function Rooms({ manage }) {
  const buildings = useOptions('/accommodation/buildings', (b) => ({ value: b.id, label: `${b.facility_name} — ${b.name}` }));
  const facilities = useOptions('/accommodation/facilities', (f) => ({ value: f.id, label: f.name }));
  return (
    <ResourcePage endpoint="/accommodation/rooms" noun="room" canManage={manage}
      filters={[{ name: 'facility_id', label: 'Facility', type: 'select', options: facilities }, { name: 'status', label: 'Status', type: 'select', options: opts(['available', 'maintenance', 'closed']) }]}
      newDefaults={{ capacity: 1, status: 'available' }}
      columns={[{ key: 'facility_name', label: 'Facility' }, { key: 'building_name', label: 'Building' }, { key: 'room_number', label: 'Room' },
        { key: 'occupancy', label: 'Occupied', render: (r) => `${r.occupied} / ${r.capacity}` }, { key: 'status', label: 'Status', type: 'badge' }, { key: 'notes', label: 'Notes' }]}
      fields={[{ name: 'building_id', label: 'Building', type: 'select', options: buildings, required: true }, { name: 'room_number', label: 'Room number', required: true },
        { name: 'capacity', label: 'Beds', type: 'number', min: 1, required: true }, { name: 'status', label: 'Status', type: 'select', options: opts(['available', 'maintenance', 'closed']) },
        { name: 'notes', label: 'Notes', wide: true }]} />
  );
}

function Occupants({ manage, active, onChange }) {
  const list = useLoad(() => api.get(`/accommodation/occupancies${qs({ active: active ? 1 : '' })}`), [active]);
  const rooms = useOptions('/accommodation/rooms?status=available', (r) => ({ value: r.id, label: `${r.facility_name} ${r.building_name} — room ${r.room_number} (${r.occupied}/${r.capacity})` }));
  const workers = useOptions('/workers?status=active', (w) => ({ value: w.id, label: `${w.first_name} ${w.last_name} (${w.worker_code})` }));
  const [checkIn, setCheckIn] = useState(false);
  const [out, setOut] = useState(null);
  const done = () => { setCheckIn(false); setOut(null); list.reload(); onChange && onChange(); };
  return (
    <Card actions={manage && <button className="btn" onClick={() => setCheckIn(true)}>+ Check in</button>}>
      <ErrorMsg error={list.error} />
      <Table rows={list.data} empty={active ? 'Nobody is checked in.' : 'No history yet.'}
        columns={[{ key: 'worker_name', label: 'Worker' }, { key: 'worker_code', label: 'ID' }, { key: 'facility_name', label: 'Facility' }, { key: 'building_name', label: 'Building' },
          { key: 'room_number', label: 'Room' }, { key: 'project_name', label: 'Project' }, { key: 'check_in_date', label: 'Checked in', type: 'date' },
          { key: 'check_out_date', label: 'Checked out', render: (o) => (o.check_out_date ? fmtDate(o.check_out_date) : '—') },
          { key: 'act', label: '', render: (o) => manage && !o.check_out_date && <button className="link" onClick={() => setOut(o)}>Check out</button> }]} />
      {checkIn && (
        <Modal title="Check in" onClose={() => setCheckIn(false)}>
          <p className="muted small">The project is taken from the worker's current assignment.</p>
          <EntityForm initial={{ check_in_date: todayStr() }} onCancel={() => setCheckIn(false)} submitLabel="Check in"
            fields={[{ name: 'worker_id', label: 'Worker', type: 'select', options: workers, required: true }, { name: 'room_id', label: 'Room', type: 'select', options: rooms, required: true },
              { name: 'check_in_date', label: 'Date', type: 'date', required: true }, { name: 'notes', label: 'Notes', wide: true }]}
            onSubmit={async (d) => { await api.post('/accommodation/check-in', d); done(); }} />
        </Modal>
      )}
      {out && (
        <Modal title={`Check out ${out.worker_name}`} onClose={() => setOut(null)}>
          <EntityForm initial={{ check_out_date: todayStr() }} onCancel={() => setOut(null)} submitLabel="Check out"
            fields={[{ name: 'check_out_date', label: 'Date', type: 'date', required: true }]}
            onSubmit={async (d) => { await api.post(`/accommodation/occupancies/${out.id}/check-out`, d); done(); }} />
        </Modal>
      )}
    </Card>
  );
}
