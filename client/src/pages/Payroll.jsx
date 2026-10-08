import { useState } from 'react';
import { api, qs } from '../lib/api';
import { fmtMoney, fmtNum, todayStr } from '../lib/format';
import { Alert, ErrorMsg, PageHeader, Stat, Table, useLoad, useOptions } from '../components/ui';

function toCsv(rows, cols) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [cols.map((c) => esc(c.label)).join(','), ...rows.map((r) => cols.map((c) => esc(r[c.key])).join(','))].join('\n');
}

export default function Payroll() {
  const [from, setFrom] = useState(`${todayStr().slice(0, 8)}01`);
  const [to, setTo] = useState(todayStr());
  const [siteId, setSiteId] = useState('');
  const [validatedOnly, setValidatedOnly] = useState(true);
  const sites = useOptions('/structure/sites', (s) => ({ value: s.id, label: `${s.name} — ${s.project_name}` }));
  const data = useLoad(() => api.get(`/payroll${qs({ from, to, site_id: siteId, validated_only: validatedOnly ? 1 : 0 })}`), [from, to, siteId, validatedOnly]);
  const d = data.data;
  const cols = [
    { key: 'worker_code', label: 'ID' }, { key: 'worker_name', label: 'Worker' }, { key: 'client_name', label: 'Client' }, { key: 'project_name', label: 'Project' },
    { key: 'site_name', label: 'Site' }, { key: 'days_present', label: 'Days present', num: true }, { key: 'days_absent', label: 'Days absent', num: true },
    { key: 'normal_hours', label: 'Hours', num: true }, { key: 'overtime_hours', label: 'Overtime hours', num: true },
    { key: 'pay_rate', label: 'Rate', num: true, render: (r) => `${fmtMoney(r.pay_rate)}/${r.pay_rate_type === 'hourly' ? 'h' : 'day'}` },
    { key: 'normal_pay', label: 'Normal pay', num: true, render: (r) => fmtMoney(r.normal_pay) },
    { key: 'overtime_pay', label: 'Overtime pay', num: true, render: (r) => fmtMoney(r.overtime_pay) },
    { key: 'total_pay', label: 'Total', num: true, render: (r) => <strong>{fmtMoney(r.total_pay)}</strong> },
  ];
  const download = () => {
    const blob = new Blob([toCsv(d.rows, cols)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `payroll_${from}_${to}.csv`;
    a.click();
  };
  return (
    <div>
      <PageHeader title="Payroll" subtitle="Calculated from attendance. Overtime is paid at the rate set under Users & Settings."
        actions={d && d.rows.length > 0 && <button className="btn btn-ghost" onClick={download}>Download spreadsheet (CSV)</button>} />
      <div className="toolbar">
        <div className="field"><label>From</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div className="field"><label>To</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <div className="field"><label htmlFor="psite">Site</label>
          <select id="psite" value={siteId} onChange={(e) => setSiteId(e.target.value)}><option value="">All sites</option>{sites.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select></div>
        <label className="check"><input type="checkbox" checked={validatedOnly} onChange={(e) => setValidatedOnly(e.target.checked)} />Confirmed attendance only</label>
      </div>
      <ErrorMsg error={data.error} />
      {d && (
        <>
          <div className="stats">
            <Stat label="Total pay" value={fmtMoney(d.totals.total_pay || 0)} />
            <Stat label="Normal pay" value={fmtMoney(d.totals.normal_pay || 0)} />
            <Stat label="Overtime pay" value={fmtMoney(d.totals.overtime_pay || 0)} hint={`${fmtNum(d.totals.overtime_hours || 0, 1)} hours`} />
            <Stat label="Worker-days" value={fmtNum(d.totals.days_present || 0)} />
          </div>
          {!validatedOnly && d.rows.some((r) => Number(r.days_not_validated)) && <Alert tone="warning">Some days included here are not confirmed yet.</Alert>}
          <Table rows={d.rows} rowKey={(r) => r.assignment_id} columns={cols} empty="No attendance in this period." />
        </>
      )}
    </div>
  );
}
