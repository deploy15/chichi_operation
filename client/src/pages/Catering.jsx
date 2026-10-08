import { useState } from 'react';
import { api, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtNum, label, opts, todayStr } from '../lib/format';
import ResourcePage from '../components/ResourcePage';
import { Alert, Badge, Card, EntityForm, ErrorMsg, Modal, PageHeader, Table, Tabs, useLoad, useOptions } from '../components/ui';

const MEALS = opts(['lunch', 'dinner']);

export default function Catering() {
  const { can } = useAuth();
  const [tab, setTab] = useState(can('catering.view') ? 'needs' : 'deliveries');
  const [date, setDate] = useState(todayStr());
  const tabs = [
    can('catering.view') && { key: 'needs', label: 'Meals needed' },
    can('catering.view') && { key: 'production', label: 'Production' },
    { key: 'deliveries', label: 'Deliveries & distribution' },
    { key: 'tracking', label: 'Meal tracking' },
    can('catering.view') && { key: 'kitchens', label: 'Kitchens' },
    can('catering.view') && { key: 'sitekitchens', label: 'Site → kitchen' },
    can('catering.view') && { key: 'stock', label: 'Stock' },
    can('catering.view') && { key: 'staff', label: 'Kitchen staff' },
  ].filter(Boolean);
  const dated = ['needs', 'production', 'deliveries', 'tracking'].includes(tab);
  return (
    <div>
      <PageHeader title="Catering" subtitle="Meals are calculated from confirmed attendance: present + valid assignment + meal entitlement"
        actions={dated && <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Service date" />} />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'needs' && <Needs date={date} />}
      {tab === 'production' && <Production date={date} />}
      {tab === 'deliveries' && <Deliveries date={date} />}
      {tab === 'tracking' && <Tracking date={date} />}
      {tab === 'kitchens' && <Kitchens />}
      {tab === 'sitekitchens' && <SiteKitchens />}
      {tab === 'stock' && <Stock />}
      {tab === 'staff' && <Staff />}
    </div>
  );
}

function Needs({ date }) {
  const { can } = useAuth();
  const data = useLoad(() => api.get(`/catering/requirements${qs({ date })}`), [date]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const calc = async () => {
    setBusy(true); setError(null);
    try { await api.post('/catering/requirements/calculate', { date }); data.reload(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const d = data.data;
  return (
    <div>
      <div className="toolbar">
        <p className="muted">Recalculate after site managers confirm attendance.</p>
        <div className="spacer" />
        {can('catering.manage') && <button className="btn" onClick={calc} disabled={busy}>{busy ? 'Calculating…' : 'Calculate meals needed'}</button>}
      </div>
      <ErrorMsg error={error || data.error} />
      {d && d.pending_validation.length > 0 && (
        <Alert tone="warning">Not counted yet — present but attendance not confirmed: {d.pending_validation.map((p) => `${p.site_name} (${p.present_not_validated})`).join(', ')}</Alert>
      )}
      {d && (
        <div className="grid-2">
          <Card title="Total by kitchen">
            <Table rows={d.by_kitchen} rowKey={(r) => r.kitchen_name} empty="Not calculated yet."
              columns={[{ key: 'kitchen_name', label: 'Kitchen' }, { key: 'lunch', label: 'Lunch', num: true }, { key: 'dinner', label: 'Dinner', num: true }]} />
          </Card>
          <Card title="By site">
            <Table rows={d.orders} empty="Not calculated yet."
              columns={[{ key: 'client_name', label: 'Client' }, { key: 'project_name', label: 'Project' }, { key: 'site_name', label: 'Site' },
                { key: 'meal_type', label: 'Meal', type: 'label' }, { key: 'required_qty', label: 'Meals', num: true },
                { key: 'kitchen_name', label: 'Kitchen', render: (r) => r.kitchen_name || <Badge value="no kitchen" tone="red" /> }]} />
          </Card>
        </div>
      )}
    </div>
  );
}

function Production({ date }) {
  const { can } = useAuth();
  const plans = useLoad(() => api.get(`/catering/plans${qs({ date })}`), [date]);
  const sites = useOptions('/structure/sites', (s) => ({ value: s.id, label: `${s.name} — ${s.project_name}` }));
  const [modal, setModal] = useState(null);
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const generate = async () => {
    setError(null);
    try {
      const r = await api.post('/catering/plans/generate', { date });
      setInfo(r.sites_without_kitchen.length ? `These sites have no kitchen assigned: ${r.sites_without_kitchen.map((s) => s.site_name).join(', ')}` : null);
      plans.reload();
    } catch (e) { setError(e); }
  };
  const close = () => { setModal(null); plans.reload(); };
  return (
    <div>
      <div className="toolbar">
        <p className="muted">One production plan per kitchen and meal, made from the meals needed.</p>
        <div className="spacer" />
        {can('catering.manage') && <button className="btn" onClick={generate}>Create / update production plans</button>}
      </div>
      <ErrorMsg error={error || plans.error} />
      <Alert tone="warning">{info}</Alert>
      <Table rows={plans.data} empty="No production plans for this day yet."
        columns={[
          { key: 'kitchen_name', label: 'Kitchen' }, { key: 'meal_type', label: 'Meal', type: 'label' },
          { key: 'required_qty', label: 'Needed', num: true }, { key: 'planned_qty', label: 'Planned', num: true },
          { key: 'produced_qty', label: 'Produced', num: true }, { key: 'rejected_qty', label: 'Rejected', num: true },
          { key: 'dispatched_qty', label: 'Dispatched', num: true },
          { key: 'left', label: 'Left at kitchen', num: true, render: (p) => p.produced_qty - p.rejected_qty - p.dispatched_qty },
          { key: 'menu', label: 'Menu' }, { key: 'status', label: 'Status', type: 'badge' },
          { key: 'act', label: '', render: (p) => can('kitchen.manage', 'catering.manage') && (
            <span className="row-actions">
              <button className="link" onClick={() => setModal({ edit: p })}>Plan</button>
              {can('kitchen.manage') && <button className="link" onClick={() => setModal({ batch: p })}>Record production</button>}
              {can('kitchen.manage') && <button className="link" onClick={() => setModal({ dispatch: p })}>Dispatch</button>}
            </span>) },
        ]} />
      {modal && modal.edit && (
        <Modal title={`Plan: ${modal.edit.kitchen_name} — ${label(modal.edit.meal_type)}`} onClose={() => setModal(null)}>
          <EntityForm initial={modal.edit} onCancel={() => setModal(null)}
            fields={[{ name: 'planned_qty', label: 'Meals to prepare', type: 'number', min: 0, required: true }, { name: 'menu', label: 'Menu', wide: true },
              { name: 'status', label: 'Status', type: 'select', options: opts(['draft', 'confirmed', 'in_production', 'completed']) }]}
            onSubmit={async (d) => { await api.put(`/catering/plans/${modal.edit.id}`, { ...d, planned_qty: Number(d.planned_qty) }); close(); }} />
        </Modal>
      )}
      {modal && modal.batch && (
        <Modal title="Record production" onClose={() => setModal(null)}>
          <EntityForm initial={{ produced_qty: modal.batch.planned_qty - modal.batch.produced_qty, rejected_qty: 0 }} onCancel={() => setModal(null)}
            fields={[{ name: 'produced_qty', label: 'Meals produced', type: 'number', min: 0, required: true },
              { name: 'rejected_qty', label: 'Rejected / wasted', type: 'number', min: 0 }, { name: 'notes', label: 'Notes', wide: true }]}
            onSubmit={async (d) => { await api.post(`/catering/plans/${modal.batch.id}/batches`, { ...d, produced_qty: Number(d.produced_qty), rejected_qty: Number(d.rejected_qty || 0) }); close(); }} />
        </Modal>
      )}
      {modal && modal.dispatch && (
        <Modal title={`Dispatch ${label(modal.dispatch.meal_type)} from ${modal.dispatch.kitchen_name}`} onClose={() => setModal(null)}>
          <p className="muted">Available: {modal.dispatch.produced_qty - modal.dispatch.rejected_qty - modal.dispatch.dispatched_qty} meals</p>
          <EntityForm onCancel={() => setModal(null)} submitLabel="Dispatch"
            fields={[{ name: 'site_id', label: 'Site', type: 'select', options: sites, required: true },
              { name: 'dispatched_qty', label: 'Meals sent', type: 'number', min: 1, required: true },
              { name: 'vehicle', label: 'Vehicle' }, { name: 'driver', label: 'Driver' }, { name: 'notes', label: 'Notes', wide: true }]}
            onSubmit={async (d) => { await api.post('/catering/dispatches', { ...d, meal_plan_id: modal.dispatch.id, dispatched_qty: Number(d.dispatched_qty) }); close(); }} />
        </Modal>
      )}
    </div>
  );
}

function Deliveries({ date }) {
  const { can } = useAuth();
  const list = useLoad(() => api.get(`/catering/dispatches${qs({ date })}`), [date]);
  const dist = useLoad(() => api.get(`/catering/distributions${qs({ date })}`), [date]);
  const sites = useOptions('/structure/sites', (s) => ({ value: s.id, label: s.name }));
  const [modal, setModal] = useState(null);
  const close = () => { setModal(null); list.reload(); dist.reload(); };
  return (
    <div>
      <Card title="Deliveries to sites">
        <ErrorMsg error={list.error} />
        <Table rows={list.data} empty="Nothing dispatched for this day."
          columns={[
            { key: 'kitchen_name', label: 'From kitchen' }, { key: 'site_name', label: 'To site' }, { key: 'meal_type', label: 'Meal', type: 'label' },
            { key: 'dispatched_qty', label: 'Sent', num: true }, { key: 'received_qty', label: 'Received', num: true },
            { key: 'driver', label: 'Driver' }, { key: 'status', label: 'Status', type: 'badge' }, { key: 'condition_notes', label: 'Condition' },
            { key: 'act', label: '', render: (d) => can('meals.receive') && d.status !== 'received' && <button className="btn btn-small" onClick={() => setModal({ receive: d })}>Confirm receipt</button> },
          ]} />
      </Card>
      <Card title="Meals handed out" actions={can('meals.receive') && <button className="btn btn-small" onClick={() => setModal('dist')}>+ Record meals handed out</button>}>
        <Table rows={dist.data} empty="Nothing recorded for this day."
          columns={[{ key: 'site_name', label: 'Site' }, { key: 'meal_type', label: 'Meal', type: 'label' }, { key: 'distributed_qty', label: 'Meals', num: true }, { key: 'notes', label: 'Notes' }]} />
      </Card>
      {modal && modal.receive && (
        <Modal title={`Confirm receipt at ${modal.receive.site_name}`} onClose={() => setModal(null)}>
          <EntityForm initial={{ received_qty: modal.receive.dispatched_qty }} submitLabel="Confirm" onCancel={() => setModal(null)}
            fields={[{ name: 'received_qty', label: `Meals received (sent: ${modal.receive.dispatched_qty})`, type: 'number', min: 0, required: true },
              { name: 'condition_notes', label: 'Condition / remarks', wide: true }]}
            onSubmit={async (d) => { await api.post(`/catering/dispatches/${modal.receive.id}/receive`, { ...d, received_qty: Number(d.received_qty) }); close(); }} />
        </Modal>
      )}
      {modal === 'dist' && (
        <Modal title="Record meals handed out" onClose={() => setModal(null)}>
          <EntityForm initial={{ service_date: date, meal_type: 'lunch' }} onCancel={() => setModal(null)}
            fields={[{ name: 'site_id', label: 'Site', type: 'select', options: sites, required: true }, { name: 'service_date', label: 'Date', type: 'date', required: true },
              { name: 'meal_type', label: 'Meal', type: 'select', options: MEALS, required: true }, { name: 'distributed_qty', label: 'Meals handed out', type: 'number', min: 1, required: true },
              { name: 'notes', label: 'Notes', wide: true }]}
            onSubmit={async (d) => { await api.post('/catering/distributions', { ...d, distributed_qty: Number(d.distributed_qty) }); close(); }} />
        </Modal>
      )}
    </div>
  );
}

function Tracking({ date }) {
  const data = useLoad(() => api.get(`/catering/traceability${qs({ date })}`), [date]);
  const d = data.data;
  return (
    <div>
      <p className="muted">Needed → Produced → Dispatched → Received → Handed out → Remaining</p>
      <ErrorMsg error={data.error} />
      {d && d.kitchens.length > 0 && (
        <Card title="At the kitchens">
          <Table rows={d.kitchens} rowKey={(r) => `${r.kitchen_id}-${r.meal_type}`}
            columns={[{ key: 'kitchen_name', label: 'Kitchen' }, { key: 'meal_type', label: 'Meal', type: 'label' }, { key: 'required', label: 'Needed', num: true },
              { key: 'planned', label: 'Planned', num: true }, { key: 'produced', label: 'Produced', num: true }, { key: 'rejected', label: 'Rejected', num: true },
              { key: 'dispatched', label: 'Dispatched', num: true }, { key: 'remaining_at_kitchen', label: 'Left at kitchen', num: true }, { key: 'status', label: 'Status', type: 'badge' }]} />
        </Card>
      )}
      {d && (
        <Card title="At the sites">
          <Table rows={d.sites} rowKey={(r) => `${r.site_id}-${r.meal_type}`} empty="No meal activity for this day."
            columns={[{ key: 'client_name', label: 'Client' }, { key: 'project_name', label: 'Project' }, { key: 'site_name', label: 'Site' }, { key: 'meal_type', label: 'Meal', type: 'label' },
              { key: 'required', label: 'Needed', num: true }, { key: 'dispatched', label: 'Dispatched', num: true }, { key: 'received', label: 'Received', num: true },
              { key: 'distributed', label: 'Handed out', num: true }, { key: 'remaining', label: 'Remaining', num: true }]} />
        </Card>
      )}
    </div>
  );
}

function Kitchens() {
  const { can } = useAuth();
  const projects = useOptions('/structure/projects', (p) => ({ value: p.id, label: `${p.name} (${p.client_name})` }));
  return (
    <ResourcePage endpoint="/kitchens" noun="kitchen" canManage={can('catering.manage')}
      filters={[{ name: 'kitchen_type', label: 'Type', type: 'select', options: opts(['central', 'temporary']) }, { name: 'status', label: 'Status', type: 'select', options: opts(['active', 'suspended', 'closed']) }]}
      columns={[{ key: 'name', label: 'Kitchen' }, { key: 'kitchen_type', label: 'Type', type: 'badge' }, { key: 'status', label: 'Status', type: 'badge' },
        { key: 'project_name', label: 'Project' }, { key: 'location', label: 'Location' }, { key: 'travel_time_minutes', label: 'Travel (min)', num: true },
        { key: 'start_date', label: 'Opened', type: 'date' }, { key: 'planned_close_date', label: 'Planned closing', type: 'date' }]}
      newDefaults={{ kitchen_type: 'central', status: 'active' }}
      fields={[
        { name: 'name', label: 'Name', required: true },
        { name: 'kitchen_type', label: 'Type', type: 'select', options: opts(['central', 'temporary']), required: true, help: 'Temporary kitchens are set up near remote projects' },
        { name: 'status', label: 'Status', type: 'select', options: opts(['active', 'suspended', 'closed']) },
        { name: 'project_id', label: 'Project served (required for temporary)', type: 'select', options: projects },
        { name: 'location', label: 'Location' },
        { name: 'travel_time_minutes', label: 'Travel time from central kitchen (minutes)', type: 'number', min: 0 },
        { name: 'start_date', label: 'Start date', type: 'date' },
        { name: 'planned_close_date', label: 'Planned closing date', type: 'date' },
        { name: 'actual_close_date', label: 'Actual closing date', type: 'date' },
        { name: 'notes', label: 'Notes', wide: true },
      ]} />
  );
}

function SiteKitchens() {
  const { can } = useAuth();
  const list = useLoad(() => api.get('/site-kitchens'), []);
  const sites = useOptions('/structure/sites', (s) => ({ value: s.id, label: `${s.name} — ${s.project_name}` }));
  const kitchens = useOptions('/kitchens?status=active', (k) => ({ value: k.id, label: `${k.name} (${label(k.kitchen_type)})` }));
  const [adding, setAdding] = useState(false);
  return (
    <div>
      <div className="toolbar"><p className="muted">Which kitchen feeds each site, and when. Changing a site's kitchen keeps the old record as history.</p>
        <div className="spacer" />{can('catering.manage') && <button className="btn" onClick={() => setAdding(true)}>+ Assign kitchen to site</button>}</div>
      <ErrorMsg error={list.error} />
      <Table rows={list.data} columns={[{ key: 'site_name', label: 'Site' }, { key: 'project_name', label: 'Project' }, { key: 'kitchen_name', label: 'Kitchen' },
        { key: 'kitchen_type', label: 'Type', type: 'badge' }, { key: 'start_date', label: 'From', type: 'date' }, { key: 'end_date', label: 'To', render: (r) => (r.end_date ? fmtDate(r.end_date) : 'Ongoing') }, { key: 'notes', label: 'Notes' }]} />
      {adding && (
        <Modal title="Assign kitchen to site" onClose={() => setAdding(false)}>
          <EntityForm initial={{ start_date: todayStr() }} onCancel={() => setAdding(false)}
            fields={[{ name: 'site_id', label: 'Site', type: 'select', options: sites, required: true }, { name: 'kitchen_id', label: 'Kitchen', type: 'select', options: kitchens, required: true },
              { name: 'start_date', label: 'From', type: 'date', required: true }, { name: 'end_date', label: 'To (optional)', type: 'date' }, { name: 'notes', label: 'Notes', wide: true }]}
            onSubmit={async (d) => { await api.post('/site-kitchens', d); setAdding(false); list.reload(); }} />
        </Modal>
      )}
    </div>
  );
}

function Stock() {
  const { can } = useAuth();
  const kitchens = useOptions('/kitchens', (k) => ({ value: k.id, label: k.name }));
  const [move, setMove] = useState(null);
  const [v, setV] = useState(0);
  const manage = can('kitchen.manage', 'catering.manage');
  return (
    <>
      <ResourcePage key={v} endpoint="/stock-items" noun="stock item" canManage={manage}
        filters={[{ name: 'kitchen_id', label: 'Kitchen', type: 'select', options: kitchens }]}
        columns={[{ key: 'kitchen_name', label: 'Kitchen' }, { key: 'name', label: 'Item' }, { key: 'quantity', label: 'In stock', num: true, render: (r) => `${fmtNum(r.quantity, 1)} ${r.unit}` },
          { key: 'reorder_level', label: 'Reorder at', num: true }, { key: 'low', label: '', render: (r) => (Number(r.low_stock) ? <Badge value="low stock" tone="red" /> : '') }]}
        rowActions={(r) => manage && <button className="link" onClick={() => setMove(r)}>Stock in / out</button>}
        newDefaults={{ unit: 'kg', reorder_level: 0 }}
        fields={[{ name: 'kitchen_id', label: 'Kitchen', type: 'select', options: kitchens, required: true }, { name: 'name', label: 'Item name', required: true },
          { name: 'unit', label: 'Unit', help: 'kg, L, pieces…' }, { name: 'reorder_level', label: 'Reorder when below', type: 'number', min: 0 }]} />
      {move && (
        <Modal title={`Stock movement: ${move.name}`} onClose={() => setMove(null)}>
          <p className="muted">Currently {fmtNum(move.quantity, 1)} {move.unit}</p>
          <EntityForm initial={{ movement_type: 'in', movement_date: todayStr() }} onCancel={() => setMove(null)}
            fields={[{ name: 'movement_type', label: 'Type', type: 'select', required: true, options: [{ value: 'in', label: 'Received (in)' }, { value: 'out', label: 'Used (out)' }, { value: 'waste', label: 'Wasted' }, { value: 'adjustment', label: 'Count correction (+/-)' }] },
              { name: 'quantity', label: `Quantity (${move.unit})`, type: 'number', required: true }, { name: 'movement_date', label: 'Date', type: 'date' },
              { name: 'reference', label: 'Reference (invoice, note…)' }, { name: 'notes', label: 'Notes', wide: true }]}
            onSubmit={async (d) => { await api.post(`/stock-items/${move.id}/movements`, { ...d, quantity: Number(d.quantity) }); setMove(null); setV((x) => x + 1); }} />
        </Modal>
      )}
    </>
  );
}

function Staff() {
  const { can } = useAuth();
  const kitchens = useOptions('/kitchens', (k) => ({ value: k.id, label: k.name }));
  return (
    <ResourcePage endpoint="/kitchen-staff" noun="staff member" canManage={can('kitchen.manage', 'catering.manage')} canDelete={can('catering.manage')} search={false}
      filters={[{ name: 'kitchen_id', label: 'Kitchen', type: 'select', options: kitchens }]}
      columns={[{ key: 'kitchen_name', label: 'Kitchen' }, { key: 'name', label: 'Name' }, { key: 'staff_role', label: 'Role' }, { key: 'start_date', label: 'From', type: 'date' }, { key: 'end_date', label: 'To', type: 'date' }]}
      fields={[{ name: 'kitchen_id', label: 'Kitchen', type: 'select', options: kitchens, required: true }, { name: 'name', label: 'Name', required: true },
        { name: 'staff_role', label: 'Role', help: 'Cook, helper, driver…' }, { name: 'start_date', label: 'From', type: 'date' }, { name: 'end_date', label: 'To', type: 'date' }]} />
  );
}
