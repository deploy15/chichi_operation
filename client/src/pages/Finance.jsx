import { useState } from 'react';
import { api, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtMoney, label, opts, todayStr } from '../lib/format';
import ResourcePage from '../components/ResourcePage';
import { Card, EntityForm, ErrorMsg, Modal, PageHeader, Stat, Table, Tabs, useLoad, useOptions } from '../components/ui';

const CATEGORIES = ['food', 'supplier', 'transport', 'fuel', 'staff', 'energy', 'equipment', 'other'];

export default function Finance() {
  const [tab, setTab] = useState('expenses');
  return (
    <div>
      <PageHeader title="Catering costs" subtitle="Record expenses and share them out to Client → Project → Site" />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'expenses', label: 'Expenses' }, { key: 'report', label: 'Cost by client / project / site' }]} />
      {tab === 'expenses' ? <Expenses /> : <CostReport />}
    </div>
  );
}

function Expenses() {
  const { can } = useAuth();
  const kitchens = useOptions('/kitchens', (k) => ({ value: k.id, label: k.name }));
  const [alloc, setAlloc] = useState(null);
  const [v, setV] = useState(0);
  return (
    <>
      <ResourcePage key={v} endpoint="/finance/expenses" noun="expense" canManage={can('finance.manage', 'catering.manage')} canDelete={can('finance.manage')}
        filters={[{ name: 'category', label: 'Category', type: 'select', options: opts(CATEGORIES) }, { name: 'kitchen_id', label: 'Kitchen', type: 'select', options: kitchens }]}
        newDefaults={{ expense_date: todayStr(), category: 'food' }}
        columns={[{ key: 'expense_date', label: 'Date', type: 'date' }, { key: 'category', label: 'Category', type: 'label' }, { key: 'supplier', label: 'Supplier' },
          { key: 'description', label: 'Description' }, { key: 'kitchen_name', label: 'Kitchen' }, { key: 'amount', label: 'Amount', num: true, render: (r) => fmtMoney(r.amount) },
          { key: 'allocated', label: 'Shared out', num: true, render: (r) => (Number(r.allocated_amount) ? `${fmtMoney(r.allocated_amount)} (${label(r.allocation_method)})` : <span className="muted">Not yet</span>) }]}
        rowActions={(r) => can('finance.manage') && <button className="link" onClick={() => setAlloc(r)}>Share out</button>}
        fields={[{ name: 'expense_date', label: 'Date', type: 'date', required: true }, { name: 'category', label: 'Category', type: 'select', options: opts(CATEGORIES), required: true },
          { name: 'amount', label: 'Amount', type: 'number', min: 0, required: true }, { name: 'kitchen_id', label: 'Kitchen (if any)', type: 'select', options: kitchens },
          { name: 'supplier', label: 'Supplier' }, { name: 'reference', label: 'Invoice / reference' }, { name: 'description', label: 'Description', wide: true }]} />
      {alloc && <AllocateModal expense={alloc} onClose={() => { setAlloc(null); setV((x) => x + 1); }} />}
    </>
  );
}

function AllocateModal({ expense, onClose }) {
  const sites = useOptions('/structure/sites', (s) => ({ value: s.id, label: `${s.name} — ${s.project_name} (${s.client_name})` }));
  const current = useLoad(() => api.get(`/finance/expenses/${expense.id}/allocations`), [expense.id]);
  const [method, setMethod] = useState('meal_count');
  const [lines, setLines] = useState([{ site_id: '', value: '' }]);
  const [error, setError] = useState(null);
  const [siteId, setSiteId] = useState('');
  const save = async () => {
    setError(null);
    try {
      const body = { method };
      if (method === 'direct') body.site_id = siteId;
      if (method === 'percentage') body.lines = lines.map((l) => ({ site_id: l.site_id, percentage: Number(l.value) }));
      if (method === 'manual') body.lines = lines.map((l) => ({ site_id: l.site_id, amount: Number(l.value) }));
      await api.post(`/finance/expenses/${expense.id}/allocate`, body);
      onClose();
    } catch (e) { setError(e); }
  };
  return (
    <Modal title={`Share out ${fmtMoney(expense.amount)} — ${label(expense.category)}`} onClose={onClose} wide>
      {current.data && current.data.length > 0 && (
        <Card title="Current split">
          <Table rows={current.data} columns={[{ key: 'client_name', label: 'Client' }, { key: 'project_name', label: 'Project' }, { key: 'site_name', label: 'Site' },
            { key: 'percentage', label: '%', num: true, render: (r) => Number(r.percentage).toFixed(2) }, { key: 'amount', label: 'Amount', num: true, render: (r) => fmtMoney(r.amount) }]} />
        </Card>
      )}
      <ErrorMsg error={error} />
      <div className="field"><label htmlFor="method">Method</label>
        <select id="method" value={method} onChange={(e) => setMethod(e.target.value)}>
          <option value="meal_count">By meal count (sites served by this kitchen, this month)</option>
          <option value="direct">Direct (all to one site)</option>
          <option value="percentage">By percentage</option>
          <option value="manual">Manual amounts</option>
        </select></div>
      {method === 'direct' && (
        <div className="field"><label htmlFor="dsite">Site</label>
          <select id="dsite" value={siteId} onChange={(e) => setSiteId(e.target.value)}><option value="">— Select —</option>{sites.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select></div>
      )}
      {(method === 'percentage' || method === 'manual') && (
        <div className="lines">
          {lines.map((l, i) => (
            <div key={i} className="line">
              <select value={l.site_id} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, site_id: e.target.value } : x)))} aria-label="Site">
                <option value="">— Site —</option>{sites.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
              <input type="number" placeholder={method === 'percentage' ? '%' : 'Amount'} value={l.value} aria-label="Value"
                onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
              <button className="link danger" onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="Remove">×</button>
            </div>
          ))}
          <button className="link" onClick={() => setLines([...lines, { site_id: '', value: '' }])}>+ Add site</button>
          <p className="muted small">Total: {lines.reduce((a, l) => a + Number(l.value || 0), 0)} {method === 'percentage' ? '% (must be 100)' : `(must be ${expense.amount})`}</p>
        </div>
      )}
      <div className="form-actions"><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn" onClick={save}>Save split</button></div>
    </Modal>
  );
}

function CostReport() {
  const [from, setFrom] = useState(`${todayStr().slice(0, 8)}01`);
  const [to, setTo] = useState(todayStr());
  const data = useLoad(() => api.get(`/finance/costs${qs({ from, to })}`), [from, to]);
  const d = data.data;
  return (
    <div>
      <div className="toolbar">
        <div className="field"><label>From</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div className="field"><label>To</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
      </div>
      <ErrorMsg error={data.error} />
      {d && (
        <>
          <div className="stats">
            <Stat label="Total expenses" value={fmtMoney(d.totals.total_expenses)} />
            <Stat label="Not yet shared out" value={fmtMoney(d.totals.unallocated)} tone={Number(d.totals.unallocated) ? 'red' : undefined} />
            {d.by_category.slice(0, 4).map((c) => <Stat key={c.category} label={label(c.category)} value={fmtMoney(c.amount)} />)}
          </div>
          <Table rows={d.rows} rowKey={(r) => r.site_id} empty="No costs shared out in this period."
            columns={[{ key: 'client_name', label: 'Client' }, { key: 'project_name', label: 'Project' }, { key: 'site_name', label: 'Site' }, { key: 'amount', label: 'Cost', num: true, render: (r) => fmtMoney(r.amount) }]} />
        </>
      )}
    </div>
  );
}
