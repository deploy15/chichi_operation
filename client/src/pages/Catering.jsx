import { useState } from 'react';
import { api, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtNum, label, opts, todayStr, utcToLocalInput } from '../lib/format';
import ResourcePage from '../components/ResourcePage';
import { Alert, Badge, Card, EntityForm, ErrorMsg, Modal, PageHeader, Table, Tabs, useLoad, useOptions } from '../components/ui';

const MEALS = opts(['lunch', 'dinner']);

export default function Catering() {
  const { can } = useAuth();
  const tabs = [
    can('catering.view') && { key: 'needs', label: 'Meals needed' },
    can('catering.view', 'kitchen.view') && { key: 'production', label: 'Production' },
    can('catering.view', 'kitchen.view') && { key: 'menus', label: 'Menus' },
    can('catering.view', 'kitchen.view', 'meals.receive') && { key: 'deliveries', label: 'Deliveries' },
    can('catering.view', 'meals.receive') && { key: 'tracking', label: 'Meal tracking' },
    can('catering.view', 'kitchen.view') && { key: 'log', label: 'Kitchen & transport log' },
    can('catering.view', 'catering.feedback') && { key: 'feedback', label: 'Site feedback' },
    can('stock.view', 'stock.report') && { key: 'stock', label: 'Stock' },
    can('catering.view') && { key: 'kitchens', label: 'Kitchens' },
    can('catering.view') && { key: 'sitekitchens', label: 'Site → kitchen' },
    can('catering.view') && { key: 'staff', label: 'Kitchen staff' },
  ].filter(Boolean);
  const [tab, setTab] = useState(tabs[0] ? tabs[0].key : 'deliveries');
  const [date, setDate] = useState(todayStr());
  const dated = ['needs', 'production', 'deliveries', 'tracking', 'log', 'feedback'].includes(tab);
  return (
    <div>
      <PageHeader title="Catering" subtitle="Meals are calculated from confirmed attendance: present + valid assignment + meal entitlement"
        actions={dated && <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />} />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'needs' && <Needs date={date} />}
      {tab === 'production' && <Production date={date} />}
      {tab === 'menus' && <Menus />}
      {tab === 'deliveries' && <Deliveries date={date} />}
      {tab === 'tracking' && <Tracking date={date} />}
      {tab === 'log' && <OpsLog date={date} />}
      {tab === 'feedback' && <Feedback date={date} />}
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
        <p className="muted">Recalculate after sites submit their daily workforce report.</p>
        <div className="spacer" />
        {can('catering.manage') && <button className="btn" onClick={calc} disabled={busy}>{busy ? 'Calculating…' : 'Calculate meals needed'}</button>}
      </div>
      <ErrorMsg error={error || data.error} />
      {d && d.pending_validation.length > 0 && (
        <Alert tone="warning">Not counted yet: workers present but the daily report is not submitted: {d.pending_validation.map((p) => `${p.site_name} (${p.present_not_validated})`).join(', ')}</Alert>
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
  const menus = useOptions('/menus?active=1', (m) => ({ value: m.id, label: m.name, meal_type: m.meal_type }));
  const kitchenSites = useOptions(can('dispatch.plan') ? '/catering/kitchen-sites' : null, (s) => ({ value: s.id, label: s.name, kitchen_id: s.kitchen_id }));
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
  const left = (p) => Number(p.approved_qty) - Number(p.dispatched_qty);
  return (
    <div>
      <div className="toolbar">
        <p className="muted">Sous-chefs record meals cooked; the Catering Director checks quality. Only approved meals can be sent.</p>
        <div className="spacer" />
        {can('catering.manage') && <button className="btn" onClick={generate}>Create / update production plans</button>}
      </div>
      <ErrorMsg error={error || plans.error} />
      <Alert tone="warning">{info}</Alert>
      <Table rows={plans.data} empty="No production plans for this day yet."
        columns={[
          { key: 'kitchen_name', label: 'Kitchen' }, { key: 'meal_type', label: 'Meal', type: 'label' },
          { key: 'menu', label: 'Menu', render: (p) => p.menu_name || p.menu },
          { key: 'required_qty', label: 'Needed', num: true }, { key: 'planned_qty', label: 'Planned', num: true },
          { key: 'produced_qty', label: 'Cooked', num: true }, { key: 'awaiting_check_qty', label: 'Awaiting check', num: true },
          { key: 'approved_qty', label: 'Approved', num: true }, { key: 'rejected_qty', label: 'Rejected', num: true },
          { key: 'dispatched_qty', label: 'Sent', num: true }, { key: 'left', label: 'Left to send', num: true, render: left },
          { key: 'status', label: 'Status', type: 'badge' },
          { key: 'act', label: '', render: (p) => (
            <span className="row-actions">
              {can('catering.manage') && <button className="link" onClick={() => setModal({ edit: p })}>Plan</button>}
              {can('kitchen.produce') && <button className="link" onClick={() => setModal({ batch: p })}>Record meals cooked</button>}
              <button className="link" onClick={() => setModal({ batches: p })}>{can('quality.validate') && Number(p.awaiting_check_qty) ? 'Quality check' : 'Batches'}</button>
              {can('dispatch.plan') && <button className="link" onClick={() => setModal({ dispatch: p })}>Plan delivery</button>}
            </span>) },
        ]} />
      {modal && modal.edit && (
        <Modal title={`Plan: ${modal.edit.kitchen_name} (${label(modal.edit.meal_type)})`} onClose={() => setModal(null)}>
          <EntityForm initial={modal.edit} onCancel={() => setModal(null)}
            fields={[{ name: 'planned_qty', label: 'Meals to prepare', type: 'number', min: 0, required: true },
              { name: 'menu_id', label: 'Menu', type: 'select', options: menus.filter((m) => m.meal_type === modal.edit.meal_type) },
              { name: 'menu', label: 'Menu notes', wide: true },
              { name: 'status', label: 'Status', type: 'select', options: opts(['draft', 'confirmed', 'in_production', 'completed']) }]}
            onSubmit={async (d) => { await api.put(`/catering/plans/${modal.edit.id}`, { ...d, planned_qty: Number(d.planned_qty) }); close(); }} />
        </Modal>
      )}
      {modal && modal.batch && (
        <Modal title="Record meals cooked and portioned" onClose={() => setModal(null)}>
          <EntityForm initial={{ produced_qty: Math.max(modal.batch.planned_qty - modal.batch.produced_qty, 0) || '', rejected_qty: 0 }} onCancel={() => setModal(null)}
            fields={[{ name: 'produced_qty', label: 'Meals cooked and portioned', type: 'number', min: 1, required: true },
              { name: 'rejected_qty', label: 'Spoiled / wasted', type: 'number', min: 0 }, { name: 'notes', label: 'Notes', wide: true }]}
            onSubmit={async (d) => { await api.post(`/catering/plans/${modal.batch.id}/batches`, { ...d, produced_qty: Number(d.produced_qty), rejected_qty: Number(d.rejected_qty || 0) }); close(); }} />
        </Modal>
      )}
      {modal && modal.batches && <Batches plan={modal.batches} onClose={close} />}
      {modal && modal.dispatch && (
        <Modal title={`Plan delivery: ${label(modal.dispatch.meal_type)} from ${modal.dispatch.kitchen_name}`} onClose={() => setModal(null)}>
          <p className="muted">{left(modal.dispatch)} quality-approved meals not yet sent. You validate the final quantity before loading.</p>
          <EntityForm onCancel={() => setModal(null)} submitLabel="Add to delivery schedule"
            fields={[{ name: 'site_id', label: 'Site', type: 'select', options: kitchenSites.filter((s) => s.kitchen_id === modal.dispatch.kitchen_id), required: true },
              { name: 'planned_qty', label: 'Meals to send', type: 'number', min: 1, required: true },
              { name: 'planned_departure', label: 'Departure time', type: 'datetime-local' },
              { name: 'vehicle', label: 'Vehicle' }, { name: 'driver', label: 'Driver' }, { name: 'notes', label: 'Notes', wide: true }]}
            onSubmit={async (d) => {
              await api.post('/catering/dispatches', { ...d, meal_plan_id: modal.dispatch.id, planned_qty: Number(d.planned_qty),
                planned_departure: d.planned_departure ? new Date(d.planned_departure).toISOString() : null });
              close();
            }} />
        </Modal>
      )}
    </div>
  );
}

function Batches({ plan, onClose }) {
  const { can } = useAuth();
  const list = useLoad(() => api.get(`/catering/plans/${plan.id}/batches`), [plan.id]);
  const [checking, setChecking] = useState(null);
  return (
    <Modal title={`Batches: ${plan.kitchen_name} (${label(plan.meal_type)})`} onClose={onClose} wide>
      <ErrorMsg error={list.error} />
      <Table rows={list.data} empty="Nothing cooked yet."
        columns={[{ key: 'produced_at', label: 'Recorded', type: 'datetime' }, { key: 'recorded_by_name', label: 'By' },
          { key: 'produced_qty', label: 'Cooked', num: true }, { key: 'rejected_qty', label: 'Rejected', num: true }, { key: 'notes', label: 'Notes' },
          { key: 'quality_status', label: 'Quality', type: 'badge' },
          { key: 'checked_by_name', label: 'Checked by', render: (b) => (b.checked_by_name ? `${b.checked_by_name}${b.quality_notes ? `: ${b.quality_notes}` : ''}` : '') },
          { key: 'act', label: '', render: (b) => can('quality.validate') && <button className="link" onClick={() => setChecking(b)}>{b.quality_status === 'pending' ? 'Check quality' : 'Change'}</button> }]} />
      {checking && (
        <div className="card">
          <h3>Quality and hygiene check</h3>
          <EntityForm submitLabel="Save check" initial={{ quality_status: 'approved', rejected_qty: checking.rejected_qty, quality_notes: checking.quality_notes }}
            fields={[{ name: 'quality_status', label: 'Result', type: 'select', required: true, options: opts(['approved', 'rejected']) },
              { name: 'rejected_qty', label: `Meals to throw away (of ${checking.produced_qty})`, type: 'number', min: 0, help: 'If the whole batch is rejected, none of it can be sent' },
              { name: 'quality_notes', label: 'Notes', wide: true }]}
            onCancel={() => setChecking(null)}
            onSubmit={async (d) => { await api.post(`/catering/batches/${checking.id}/quality`, { ...d, rejected_qty: d.rejected_qty === '' || d.rejected_qty === null ? undefined : Number(d.rejected_qty) }); setChecking(null); list.reload(); }} />
        </div>
      )}
    </Modal>
  );
}

function Menus() {
  const { can } = useAuth();
  return (
    <ResourcePage endpoint="/menus" noun="menu" canManage={can('menus.manage')}
      filters={[{ name: 'meal_type', label: 'Meal', type: 'select', options: MEALS }]}
      newDefaults={{ meal_type: 'lunch', active: 1 }}
      columns={[{ key: 'name', label: 'Menu' }, { key: 'meal_type', label: 'Meal', type: 'label' }, { key: 'dishes', label: 'Dishes' },
        { key: 'active', label: 'In use', type: 'bool' }]}
      fields={[{ name: 'name', label: 'Menu name', required: true }, { name: 'meal_type', label: 'Meal', type: 'select', options: MEALS, required: true },
        { name: 'dishes', label: 'Dishes', type: 'textarea', wide: true }, { name: 'active', label: 'In use', type: 'checkbox' }]} />
  );
}

const STEP = { planned: 'Waiting for Catering Director', validated: 'Ready to load', loaded: 'On the way', delivered: 'Delivered, waiting for site', received: 'Received by site', cancelled: 'Cancelled' };

function Deliveries({ date }) {
  const { can } = useAuth();
  const list = useLoad(() => api.get(`/catering/dispatches${qs({ date })}`), [date]);
  const dist = useLoad(() => (can('catering.view', 'meals.receive') ? api.get(`/catering/distributions${qs({ date })}`) : Promise.resolve(null)), [date]);
  const sites = useOptions(can('meals.receive') ? '/structure/sites' : null, (s) => ({ value: s.id, label: s.name }));
  const [modal, setModal] = useState(null);
  const [error, setError] = useState(null);
  const close = () => { setModal(null); list.reload(); dist.reload(); };
  const quick = async (path, confirmText) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setError(null);
    try { await api.post(path, {}); close(); } catch (e) { setError(e); }
  };
  const actions = (d) => (
    <span className="row-actions">
      {can('dispatch.plan') && ['planned', 'validated'].includes(d.status) && <>
        <button className="link" onClick={() => setModal({ validate: d })}>{d.status === 'planned' ? 'Validate quantity' : 'Change quantity'}</button>
        <button className="link" onClick={() => setModal({ edit: d })}>Edit schedule</button>
        <button className="link danger" onClick={() => quick(`/catering/dispatches/${d.id}/cancel`, 'Cancel this delivery?')}>Cancel</button>
      </>}
      {can('delivery.execute') && d.status === 'validated' && <button className="btn btn-small" onClick={() => setModal({ load: d })}>Record loading</button>}
      {can('delivery.execute') && d.status === 'loaded' && <button className="btn btn-small" onClick={() => quick(`/catering/dispatches/${d.id}/deliver`, 'Confirm the meals were handed over at the site?')}>Confirm delivered</button>}
      {can('meals.receive') && ['loaded', 'delivered'].includes(d.status) && <button className="btn btn-small" onClick={() => setModal({ receive: d })}>Confirm receipt</button>}
    </span>
  );
  return (
    <div>
      <Card title="Delivery schedule">
        <p className="muted small">Planned by the Catering Director → validated → loaded by the transport team → delivered → received by the site.</p>
        <ErrorMsg error={error || list.error} />
        <Table rows={list.data} empty="No deliveries for this day."
          columns={[
            { key: 'kitchen_name', label: 'From kitchen' }, { key: 'site_name', label: 'To site' }, { key: 'meal_type', label: 'Meal', type: 'label' },
            { key: 'planned_departure', label: 'Departure', type: 'datetime' },
            { key: 'planned_qty', label: 'Planned', num: true },
            { key: 'dispatched_qty', label: 'Validated', num: true, render: (d) => (d.status === 'planned' ? '' : d.dispatched_qty) },
            { key: 'loaded_qty', label: 'Loaded', num: true }, { key: 'received_qty', label: 'Received', num: true },
            { key: 'vehicle', label: 'Vehicle / driver', render: (d) => [d.vehicle, d.driver].filter(Boolean).join(' · ') },
            { key: 'status', label: 'Status', render: (d) => <span title={STEP[d.status]}><Badge value={d.status} /></span> },
            { key: 'condition_notes', label: 'Condition' },
            { key: 'act', label: '', render: actions },
          ]} />
      </Card>
      {dist.data && (
        <Card title="Meals handed out at sites" actions={can('meals.receive') && <button className="btn btn-small" onClick={() => setModal('dist')}>+ Record meals handed out</button>}>
          <Table rows={dist.data} empty="Nothing recorded for this day."
            columns={[{ key: 'site_name', label: 'Site' }, { key: 'meal_type', label: 'Meal', type: 'label' }, { key: 'distributed_qty', label: 'Meals', num: true }, { key: 'notes', label: 'Notes' }]} />
        </Card>
      )}
      {modal && modal.validate && (
        <Modal title={`Validate quantity for ${modal.validate.site_name}`} onClose={() => setModal(null)}>
          <EntityForm submitLabel="Validate" initial={{ dispatched_qty: modal.validate.status === 'planned' ? modal.validate.planned_qty : modal.validate.dispatched_qty }}
            fields={[{ name: 'dispatched_qty', label: 'Meals to send', type: 'number', min: 1, required: true, help: 'Only quality-approved meals can be sent' }]}
            onCancel={() => setModal(null)}
            onSubmit={async (d) => { await api.post(`/catering/dispatches/${modal.validate.id}/validate`, { dispatched_qty: Number(d.dispatched_qty) }); close(); }} />
        </Modal>
      )}
      {modal && modal.edit && (
        <Modal title={`Delivery to ${modal.edit.site_name}`} onClose={() => setModal(null)}>
          <EntityForm initial={{ ...modal.edit, planned_departure: utcToLocalInput(modal.edit.planned_departure) }}
            fields={[{ name: 'planned_qty', label: 'Planned meals', type: 'number', min: 1, required: true }, { name: 'planned_departure', label: 'Departure time', type: 'datetime-local' },
              { name: 'vehicle', label: 'Vehicle' }, { name: 'driver', label: 'Driver' }, { name: 'notes', label: 'Notes', wide: true }]}
            onCancel={() => setModal(null)}
            onSubmit={async (d) => {
              await api.put(`/catering/dispatches/${modal.edit.id}`, { ...d, planned_qty: Number(d.planned_qty), planned_departure: d.planned_departure ? new Date(d.planned_departure).toISOString() : null });
              close();
            }} />
        </Modal>
      )}
      {modal && modal.load && (
        <Modal title={`Loading for ${modal.load.site_name}`} onClose={() => setModal(null)}>
          <EntityForm submitLabel="Confirm loading" initial={{ loaded_qty: modal.load.dispatched_qty }}
            fields={[{ name: 'loaded_qty', label: `Meals loaded (validated: ${modal.load.dispatched_qty})`, type: 'number', min: 0, required: true }]}
            onCancel={() => setModal(null)}
            onSubmit={async (d) => { await api.post(`/catering/dispatches/${modal.load.id}/load`, { loaded_qty: Number(d.loaded_qty) }); close(); }} />
        </Modal>
      )}
      {modal && modal.receive && (
        <Modal title={`Confirm receipt at ${modal.receive.site_name}`} onClose={() => setModal(null)}>
          <EntityForm initial={{ received_qty: modal.receive.loaded_qty }} submitLabel="Confirm" onCancel={() => setModal(null)}
            fields={[{ name: 'received_qty', label: `Dishes received (loaded: ${modal.receive.loaded_qty})`, type: 'number', min: 0, required: true },
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

// Records from sous-chefs and the dishwashing / sealing / transport team
function OpsLog({ date }) {
  const { can } = useAuth();
  const list = useLoad(() => api.get(`/operations/logs${qs({ date })}`), [date]);
  const types = useOptions('/operations/types', (t) => ({ value: t.key, label: t.label, needs_kitchen: t.needs_kitchen, needs_site: t.needs_site }));
  const kitchenTypes = types.filter((t) => t.needs_kitchen && t.value !== 'stock_report');
  const [adding, setAdding] = useState(false);
  const [responding, setResponding] = useState(null);
  const rows = list.data ? list.data.filter((l) => !['site_delay', 'site_complaint'].includes(l.log_type)) : null;
  return (
    <div>
      <div className="toolbar">
        <p className="muted">Preparation, portions, handovers, cleaning, packaging, labelling, transport problems and stock reports.</p>
        <div className="spacer" />
        {kitchenTypes.length > 0 && <button className="btn" onClick={() => setAdding(true)}>+ Add record</button>}
      </div>
      <ErrorMsg error={list.error} />
      <LogTable rows={rows} onRespond={can('catering.manage') ? setResponding : null} />
      {adding && <LogForm types={kitchenTypes} date={date} onClose={() => { setAdding(false); list.reload(); }} />}
      {responding && <Respond log={responding} onClose={() => { setResponding(null); list.reload(); }} />}
    </div>
  );
}

function Feedback({ date }) {
  const { can } = useAuth();
  const [all, setAll] = useState(true);
  const list = useLoad(() => api.get(`/operations/logs${qs({ group: 'feedback', date: all ? '' : date })}`), [date, all]);
  const types = useOptions(can('catering.feedback') ? '/operations/types' : null, (t) => ({ value: t.key, label: t.label, needs_kitchen: t.needs_kitchen, needs_site: t.needs_site }));
  const siteTypes = types.filter((t) => t.value.startsWith('site_'));
  const [adding, setAdding] = useState(false);
  const [responding, setResponding] = useState(null);
  return (
    <div>
      <div className="toolbar">
        <label className="check"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show all dates</label>
        <div className="spacer" />
        {siteTypes.length > 0 && <button className="btn" onClick={() => setAdding(true)}>+ Report delay or complaint</button>}
      </div>
      <ErrorMsg error={list.error} />
      <LogTable rows={list.data} onRespond={can('catering.manage') ? setResponding : null} />
      {adding && <LogForm types={siteTypes} date={date} onClose={() => { setAdding(false); list.reload(); }} />}
      {responding && <Respond log={responding} onClose={() => { setResponding(null); list.reload(); }} />}
    </div>
  );
}

function LogTable({ rows, onRespond }) {
  return (
    <Table rows={rows} empty="Nothing recorded."
      columns={[{ key: 'log_date', label: 'Date', type: 'date' }, { key: 'type_label', label: 'Record' },
        { key: 'where', label: 'Kitchen / site', render: (l) => [l.kitchen_name, l.site_name].filter(Boolean).join(' → ') },
        { key: 'stock_item_name', label: 'Stock item' }, { key: 'quantity', label: 'Qty', num: true, render: (l) => (l.quantity === null ? '' : fmtNum(l.quantity, 1)) },
        { key: 'description', label: 'Details' }, { key: 'recorded_by_name', label: 'By' }, { key: 'created_at', label: 'At', type: 'datetime' },
        { key: 'status', label: 'Status', type: 'badge' },
        { key: 'response', label: 'Response', render: (l) => (l.response ? `${l.response} (${l.handled_by_name})` : '') },
        { key: 'act', label: '', render: (l) => onRespond && l.status !== 'closed' && <button className="link" onClick={() => onRespond(l)}>Respond</button> }]} />
  );
}

function LogForm({ types, date, onClose, fixed = {} }) {
  const kitchens = useOptions('/kitchens', (k) => ({ value: k.id, label: k.name }));
  const kitchenSites = useOptions(types.some((t) => t.needs_kitchen && t.needs_site) ? '/catering/kitchen-sites' : null, (s) => ({ value: s.id, label: s.name, kitchen_id: s.kitchen_id }));
  const mySites = useOptions(types.some((t) => !t.needs_kitchen && t.needs_site) ? '/structure/sites' : null, (s) => ({ value: s.id, label: s.name }));
  const stockItems = useOptions(types.some((t) => t.value === 'stock_report') ? '/stock-items' : null, (i) => ({ value: i.id, label: `${i.name} (${i.kitchen_name})`, kitchen_id: i.kitchen_id }));
  const typeOf = (v) => types.find((t) => t.value === v.log_type) || {};
  return (
    <Modal title={types.length === 1 ? types[0].label : 'New record'} onClose={onClose}>
      <EntityForm submitLabel="Save" initial={{ log_type: types[0] && types[0].value, log_date: date, kitchen_id: kitchens.length === 1 ? kitchens[0].value : undefined, ...fixed }}
        fields={[
          { name: 'log_type', label: 'What happened', type: 'select', options: types, required: true, hidden: types.length === 1 },
          { name: 'kitchen_id', label: 'Kitchen', type: 'select', options: kitchens, showIf: (v) => typeOf(v).needs_kitchen && kitchens.length !== 1 },
          { name: 'site_id', label: 'Site', type: 'select', options: kitchenSites, showIf: (v) => typeOf(v).needs_kitchen && typeOf(v).needs_site },
          { name: 'site_id', label: 'Site', type: 'select', options: mySites, showIf: (v) => !typeOf(v).needs_kitchen && typeOf(v).needs_site },
          { name: 'stock_item_id', label: 'Stock item', type: 'select', options: stockItems, showIf: (v) => v.log_type === 'stock_report' },
          { name: 'quantity', label: 'Quantity (if relevant)', type: 'number', min: 0 },
          { name: 'log_date', label: 'Date', type: 'date' },
          { name: 'description', label: 'Details', type: 'textarea', wide: true },
        ]}
        onCancel={onClose}
        onSubmit={async (d, all) => {
          const t = typeOf(all);
          await api.post('/operations/logs', { ...all, ...d, kitchen_id: t.needs_kitchen ? (all.kitchen_id || (kitchens.length === 1 ? kitchens[0].value : null)) : null, site_id: t.needs_site ? all.site_id : null,
            stock_item_id: all.log_type === 'stock_report' ? all.stock_item_id : null });
          onClose();
        }} />
    </Modal>
  );
}

function Respond({ log, onClose }) {
  return (
    <Modal title={`Respond: ${log.type_label}`} onClose={onClose}>
      <p>{log.description}</p>
      <EntityForm submitLabel="Save" initial={{ status: 'acknowledged', response: log.response }}
        fields={[{ name: 'status', label: 'Status', type: 'select', required: true, options: opts(['acknowledged', 'closed']) }, { name: 'response', label: 'Response', wide: true }]}
        onCancel={onClose} onSubmit={async (d) => { await api.post(`/operations/logs/${log.id}/respond`, d); onClose(); }} />
    </Modal>
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
  const [report, setReport] = useState(null);
  const [history, setHistory] = useState(null);
  const [v, setV] = useState(0);
  const manage = can('stock.manage');
  const actions = (r) => (
    <span className="row-actions">
      {manage && <button className="link" onClick={() => setMove(r)}>Record use / loss / delivery</button>}
      {can('stock.view') && <button className="link" onClick={() => setHistory(r)}>History</button>}
      {can('stock.report') && <button className="link" onClick={() => setReport(r)}>Report shortage or loss</button>}
    </span>
  );
  return (
    <>
      {!manage && <Alert tone="info">You can see stock levels and report shortages or losses. Only the Catering Director changes stock.</Alert>}
      {manage && <Alert tone="info">Need to buy more? Submit a purchase request to the DAF from the Purchases page.</Alert>}
      <ResourcePage key={v} endpoint="/stock-items" noun="stock item" canManage={manage}
        filters={[{ name: 'kitchen_id', label: 'Kitchen', type: 'select', options: kitchens }]}
        columns={[{ key: 'kitchen_name', label: 'Kitchen' }, { key: 'name', label: 'Item' }, { key: 'quantity', label: 'In stock', num: true, render: (r) => `${fmtNum(r.quantity, 1)} ${r.unit}` },
          { key: 'reorder_level', label: 'Reorder at', num: true }, { key: 'low', label: '', render: (r) => (Number(r.low_stock) ? <Badge value="low stock" tone="red" /> : '') }]}
        rowActions={actions}
        newDefaults={{ unit: 'kg', reorder_level: 0 }}
        fields={[{ name: 'kitchen_id', label: 'Kitchen', type: 'select', options: kitchens, required: true }, { name: 'name', label: 'Item name', required: true },
          { name: 'unit', label: 'Unit', help: 'kg, L, pieces…' }, { name: 'reorder_level', label: 'Reorder when below', type: 'number', min: 0 }]} />
      {move && (
        <Modal title={`Stock movement: ${move.name}`} onClose={() => setMove(null)}>
          <p className="muted">Currently {fmtNum(move.quantity, 1)} {move.unit}</p>
          <EntityForm initial={{ movement_type: 'out', movement_date: todayStr() }} onCancel={() => setMove(null)}
            fields={[{ name: 'movement_type', label: 'Type', type: 'select', required: true, options: [{ value: 'out', label: 'Used in the kitchen' }, { value: 'waste', label: 'Lost / spoiled' }, { value: 'in', label: 'Delivered (in)' }, { value: 'adjustment', label: 'Count correction (+/-)' }] },
              { name: 'quantity', label: `Quantity (${move.unit})`, type: 'number', required: true }, { name: 'movement_date', label: 'Date', type: 'date' },
              { name: 'reference', label: 'Reference (delivery note…)' }, { name: 'notes', label: 'Notes', wide: true }]}
            onSubmit={async (d) => { await api.post(`/stock-items/${move.id}/movements`, { ...d, quantity: Number(d.quantity) }); setMove(null); setV((x) => x + 1); }} />
        </Modal>
      )}
      {report && (
        <LogForm types={[{ value: 'stock_report', label: `Report on ${report.name}`, needs_kitchen: true }]} date={todayStr()}
          fixed={{ kitchen_id: report.kitchen_id, stock_item_id: report.id }} onClose={() => setReport(null)} />
      )}
      {history && <StockHistory item={history} onClose={() => setHistory(null)} />}
    </>
  );
}

function StockHistory({ item, onClose }) {
  const list = useLoad(() => api.get(`/stock-items/${item.id}/movements`), [item.id]);
  return (
    <Modal title={`Stock history: ${item.name} (${item.kitchen_name})`} onClose={onClose} wide>
      <ErrorMsg error={list.error} />
      <Table rows={list.data} empty="No movements yet."
        columns={[{ key: 'movement_date', label: 'Date', type: 'date' }, { key: 'movement_type', label: 'Type', type: 'label' },
          { key: 'quantity', label: `Quantity (${item.unit})`, num: true }, { key: 'reference', label: 'Reference' }, { key: 'notes', label: 'Notes' },
          { key: 'created_by_name', label: 'By' }]} />
    </Modal>
  );
}

function Staff() {
  const { can } = useAuth();
  const kitchens = useOptions('/kitchens', (k) => ({ value: k.id, label: k.name }));
  return (
    <ResourcePage endpoint="/kitchen-staff" noun="staff member" canManage={can('catering.manage')} canDelete={can('catering.manage')} search={false}
      filters={[{ name: 'kitchen_id', label: 'Kitchen', type: 'select', options: kitchens }]}
      columns={[{ key: 'kitchen_name', label: 'Kitchen' }, { key: 'name', label: 'Name' }, { key: 'staff_role', label: 'Role' }, { key: 'start_date', label: 'From', type: 'date' }, { key: 'end_date', label: 'To', type: 'date' }]}
      fields={[{ name: 'kitchen_id', label: 'Kitchen', type: 'select', options: kitchens, required: true }, { name: 'name', label: 'Name', required: true },
        { name: 'staff_role', label: 'Role', help: 'Sous-chef, dishwasher, driver…' }, { name: 'start_date', label: 'From', type: 'date' }, { name: 'end_date', label: 'To', type: 'date' }]} />
  );
}
