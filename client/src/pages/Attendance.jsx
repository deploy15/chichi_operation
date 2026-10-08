// Daily attendance register. Works without Internet: changes are saved on the device
// and sent automatically when the connection returns.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { cache } from '../lib/idb';
import { useAuth } from '../lib/auth';
import { clearNotices, discard, flush, onResults, outbox, queueAttendance, retryFailed, subscribe } from '../lib/sync';
import { fmtDateTime, label, todayStr } from '../lib/format';
import { Alert, Badge, Card, ErrorMsg, PageHeader, Table, Tabs, useLoad } from '../components/ui';

const DEFAULT_HOURS = 8;
const inRange = (r, date) => r.start_date <= date && (!r.end_date || r.end_date >= date);

async function loadSites() {
  try {
    const sites = await api.get('/structure/sites?status=active');
    await cache.set('sites', sites);
    return { sites, offline: false };
  } catch (e) {
    if (!e.offline) throw e;
    return { sites: (await cache.get('sites')) || [], offline: true };
  }
}

async function loadRoster(siteId, date) {
  try {
    const rows = await api.get(`/attendance/roster${qs({ site_id: siteId, date })}`);
    await cache.set(`roster:${siteId}:${date}`, rows);
    await cache.set(`rosterBase:${siteId}`, rows);
    return { rows, offline: false };
  } catch (e) {
    if (!e.offline) throw e;
    const exact = await cache.get(`roster:${siteId}:${date}`);
    if (exact) return { rows: exact, offline: true };
    // A day not opened before: start from the last known list of workers for this site
    const base = (await cache.get(`rosterBase:${siteId}`)) || [];
    return {
      rows: base.filter((r) => inRange(r, date)).map((r) => ({ ...r, id: null, status: null, late_arrival: 0, early_departure: 0, normal_hours: null, overtime_hours: null, comments: null, validated: 0, version: 0 })),
      offline: true,
      fromBase: true,
    };
  }
}

export default function Attendance() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'register';
  const tabs = [{ key: 'register', label: 'Daily register' }];
  if (can('attendance.validate')) tabs.push({ key: 'conflicts', label: 'Offline conflicts' });
  if (can('attendance.view')) tabs.push({ key: 'report', label: 'Attendance report' });
  return (
    <div>
      <PageHeader title="Attendance" subtitle="Record who is present each day. Works offline — changes are sent automatically." />
      <Tabs tabs={tabs} value={tab} onChange={(t) => setParams({ tab: t })} />
      {tab === 'register' && <Register />}
      {tab === 'conflicts' && <Conflicts />}
      {tab === 'report' && <Report />}
    </div>
  );
}

function Register() {
  const { can } = useAuth();
  const [sites, setSites] = useState([]);
  const [siteId, setSiteId] = useState(() => localStorage.getItem('att.site') || '');
  const [date, setDate] = useState(todayStr());
  const [roster, setRoster] = useState(null);
  const [rosterInfo, setRosterInfo] = useState({});
  const [ops, setOps] = useState([]);
  const [edits, setEdits] = useState({});
  const [sync, setSync] = useState({});
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const canRecord = can('attendance.record', 'attendance.validate');

  useEffect(() => subscribe(setSync), []);
  useEffect(() => {
    loadSites().then(({ sites: s }) => {
      setSites(s);
      if (s.length && !s.some((x) => String(x.id) === String(siteId))) setSiteId(String(s[0].id));
      // Save today's lists of workers for all my sites on this device, in case the connection drops later
      if (s.length <= 15) s.forEach((x) => loadRoster(x.id, todayStr()).catch(() => {}));
    }).catch(setError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshOps = useCallback(async () => setOps(await outbox()), []);
  const reload = useCallback(async () => {
    if (!siteId) return;
    localStorage.setItem('att.site', siteId);
    setError(null);
    try {
      const r = await loadRoster(siteId, date);
      setRoster(r.rows);
      setRosterInfo(r);
    } catch (e) { setError(e); setRoster([]); }
    refreshOps();
  }, [siteId, date, refreshOps]);

  useEffect(() => { setEdits({}); reload(); }, [reload]);
  useEffect(() => onResults(() => reload()), [reload]);
  useEffect(() => { refreshOps(); }, [sync.pending, sync.failed, refreshOps]);

  const pendingByAsg = useMemo(() => {
    const m = {};
    for (const o of ops) if (String(o.site_id) === String(siteId) && o.work_date === date) m[o.assignment_id] = o;
    return m;
  }, [ops, siteId, date]);

  const rowValue = (r) => {
    const op = pendingByAsg[r.assignment_id];
    const base = op ? { ...r, ...op } : r;
    return { ...base, ...(edits[r.assignment_id] || {}) };
  };
  const setEdit = (r, patch) => {
    setEdits((e) => {
      const cur = { ...rowValue(r), ...(e[r.assignment_id] || {}) };
      const next = { ...cur, ...patch };
      if (patch.status === 'present' && (cur.normal_hours === null || cur.normal_hours === undefined || cur.status === 'absent')) next.normal_hours = DEFAULT_HOURS;
      if (patch.status === 'absent') Object.assign(next, { normal_hours: 0, overtime_hours: 0, late_arrival: 0, early_departure: 0 });
      return { ...e, [r.assignment_id]: next };
    });
  };
  const locked = (r) => Number(r.validated) && !can('attendance.validate');

  const saveAll = async () => {
    setMessage(null);
    const changed = Object.entries(edits);
    for (const [asgId, v] of changed) {
      const r = roster.find((x) => String(x.assignment_id) === String(asgId));
      if (!v.status) continue;
      await queueAttendance({
        assignment_id: r.assignment_id, site_id: Number(siteId), work_date: date, worker_name: r.worker_name,
        status: v.status, late_arrival: !!Number(v.late_arrival), early_departure: !!Number(v.early_departure),
        normal_hours: Number(v.normal_hours || 0), overtime_hours: Number(v.overtime_hours || 0), comments: v.comments || null,
        base_version: r.version || 0,
      });
    }
    setEdits({});
    await refreshOps();
    setMessage(navigator.onLine ? `${changed.length} change(s) saved.` : `${changed.length} change(s) saved on this device. They will be sent when the connection returns.`);
  };

  const markAllPresent = () => {
    for (const r of roster) {
      const v = rowValue(r);
      if (!v.status && !locked(r)) setEdit(r, { status: 'present' });
    }
  };

  const validateDay = async () => {
    if (!window.confirm('Confirm attendance for this site and day? Catering and payroll use confirmed attendance.')) return;
    try {
      const r = await api.post('/attendance/validate', { site_id: siteId, date });
      setMessage(`${r.validated} record(s) confirmed.`);
      reload();
    } catch (e) { setError(e); }
  };

  const failed = ops.filter((o) => o.state === 'failed');
  const editCount = Object.keys(edits).length;
  const waitingHere = Object.keys(pendingByAsg).length;
  const recorded = roster ? roster.filter((r) => rowValue(r).status).length : 0;
  const notValidated = roster ? roster.filter((r) => r.id && !Number(r.validated)).length : 0;

  return (
    <div>
      <div className="toolbar">
        <div className="field"><label htmlFor="site">Site</label>
          <select id="site" value={siteId} onChange={(e) => setSiteId(e.target.value)}>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name} — {s.project_name}</option>)}
          </select></div>
        <div className="field"><label htmlFor="date">Date</label>
          <input id="date" type="date" value={date} max={todayStr()} onChange={(e) => setDate(e.target.value)} /></div>
        <div className="spacer" />
        {canRecord && <button className="btn btn-ghost" onClick={markAllPresent} disabled={!roster || !roster.length}>Mark everyone else present</button>}
        {canRecord && <button className="btn" onClick={saveAll} disabled={!editCount}>Save {editCount ? `${editCount} change(s)` : 'changes'}</button>}
      </div>

      {!sync.online && <Alert tone="warning">You are offline. Keep recording — everything is saved on this device and sent automatically later.</Alert>}
      {rosterInfo.fromBase && <Alert tone="info">This day has not been opened on this device before, so the list of workers comes from the last time you were online.</Alert>}
      <ErrorMsg error={error} />
      <Alert tone="success" onClose={() => setMessage(null)}>{message}</Alert>
      {sync.notices && sync.notices.length > 0 && (
        <Alert tone="warning" onClose={clearNotices}>
          {sync.notices.map((n, i) => <div key={i}><strong>{n.worker}</strong> ({n.date}): {n.message}</div>)}
        </Alert>
      )}
      {failed.length > 0 && (
        <Card title="Changes the server did not accept">
          <Table rowKey={(o) => o.op_id} rows={failed} columns={[
            { key: 'worker_name', label: 'Worker' }, { key: 'work_date', label: 'Date' }, { key: 'status', label: 'Status', type: 'badge' },
            { key: 'error', label: 'Reason' },
            { key: 'x', label: '', render: (o) => <button className="link danger" onClick={async () => { await discard(o.op_id); refreshOps(); }}>Discard</button> },
          ]} />
          <button className="btn btn-small btn-ghost" onClick={retryFailed}>Try again</button>
        </Card>
      )}

      <div className="register-summary muted">
        {roster && `${roster.length} assigned · ${recorded} recorded`}
        {waitingHere > 0 && ` · ${waitingHere} waiting to be sent`}
        {sync.lastSync && ` · last sent ${fmtDateTime(sync.lastSync)}`}
        {sync.pending > 0 && sync.online && <button className="link" onClick={flush}>Send now</button>}
      </div>

      <div className="register">
        {roster && !roster.length && <p className="empty">No workers are assigned to this site on this day.</p>}
        {roster && roster.map((r) => {
          const v = rowValue(r);
          const dis = !canRecord || locked(r);
          const isPending = !!pendingByAsg[r.assignment_id];
          return (
            <div key={r.assignment_id} className={`reg-row ${edits[r.assignment_id] ? 'edited' : ''}`}>
              <div className="reg-who">
                <strong>{r.worker_name}</strong>
                <span className="muted small">{r.worker_code} · {r.job_position || ''} · meals: {r.meals.map(label).join(', ') || 'none'}</span>
                <span>
                  {Number(r.validated) ? <Badge value="confirmed" tone="green" /> : null}
                  {isPending && <Badge value={pendingByAsg[r.assignment_id].state === 'failed' ? 'not accepted' : 'waiting to send'} tone={pendingByAsg[r.assignment_id].state === 'failed' ? 'red' : 'orange'} />}
                </span>
              </div>
              <div className="reg-status" role="group" aria-label="Status">
                <button className={`seg ${v.status === 'present' ? 'on present' : ''}`} disabled={dis} onClick={() => setEdit(r, { status: 'present' })}>Present</button>
                <button className={`seg ${v.status === 'absent' ? 'on absent' : ''}`} disabled={dis} onClick={() => setEdit(r, { status: 'absent' })}>Absent</button>
              </div>
              <div className="reg-flags">
                <label className="check"><input type="checkbox" disabled={dis || v.status !== 'present'} checked={!!Number(v.late_arrival)} onChange={(e) => setEdit(r, { late_arrival: e.target.checked ? 1 : 0 })} />Late</label>
                <label className="check"><input type="checkbox" disabled={dis || v.status !== 'present'} checked={!!Number(v.early_departure)} onChange={(e) => setEdit(r, { early_departure: e.target.checked ? 1 : 0 })} />Left early</label>
              </div>
              <div className="reg-hours">
                <label>Hours<input type="number" min="0" max="24" step="0.5" disabled={dis || v.status !== 'present'} value={v.normal_hours ?? ''} onChange={(e) => setEdit(r, { normal_hours: e.target.value })} /></label>
                <label>Overtime<input type="number" min="0" max="24" step="0.5" disabled={dis || v.status !== 'present'} value={v.overtime_hours ?? ''} onChange={(e) => setEdit(r, { overtime_hours: e.target.value })} /></label>
              </div>
              <input className="reg-comment" placeholder="Comment" disabled={dis} value={v.comments ?? ''} onChange={(e) => setEdit(r, { comments: e.target.value })} aria-label="Comment" />
            </div>
          );
        })}
      </div>

      {can('attendance.validate') && roster && roster.length > 0 && (
        <div className="form-actions">
          <span className="muted">{notValidated} record(s) not yet confirmed</span>
          <button className="btn btn-ghost" onClick={validateDay} disabled={!sync.online || waitingHere > 0 || editCount > 0 || !notValidated}>Confirm attendance for this day</button>
        </div>
      )}
    </div>
  );
}

function Conflicts() {
  const list = useLoad(() => api.get('/sync/conflicts'), []);
  const resolve = async (c, action) => { await api.post(`/sync/conflicts/${c.id}/resolve`, { action }); list.reload(); };
  const desc = (d) => {
    const x = typeof d === 'string' ? JSON.parse(d) : d;
    if (!x) return '';
    return `${label(x.status)}${Number(x.late_arrival) ? ', late' : ''}${Number(x.early_departure) ? ', left early' : ''} · ${x.normal_hours}h + ${x.overtime_hours}h OT${x.comments ? ` · “${x.comments}”` : ''}`;
  };
  return (
    <div>
      <p className="muted">These changes were made on a device while offline, but someone else changed the same record in the meantime. Choose which version to keep.</p>
      <ErrorMsg error={list.error} />
      <Table rows={list.data} empty="No conflicts. 🎉" columns={[
        { key: 'worker_name', label: 'Worker' }, { key: 'site_name', label: 'Site' }, { key: 'work_date', label: 'Date', type: 'date' },
        { key: 'server', label: 'Current (server) version', render: (c) => desc(c.server_data) },
        { key: 'device', label: 'Device version', render: (c) => `${desc(c.client_data)} — by ${c.user_name}` },
        { key: 'act', label: '', render: (c) => (
          <span className="row-actions">
            <button className="btn btn-small btn-ghost" onClick={() => resolve(c, 'keep_server')}>Keep current</button>
            <button className="btn btn-small" onClick={() => resolve(c, 'apply_device')}>Use device version</button>
          </span>) },
      ]} />
    </div>
  );
}

function Report() {
  const [from, setFrom] = useState(todayStr().slice(0, 8) + '01');
  const [to, setTo] = useState(todayStr());
  const list = useLoad(() => api.get(`/attendance${qs({ from, to })}`), [from, to]);
  return (
    <div>
      <div className="toolbar">
        <div className="field"><label>From</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div className="field"><label>To</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
      </div>
      <ErrorMsg error={list.error} />
      <Table rows={list.data} columns={[
        { key: 'work_date', label: 'Date', type: 'date' }, { key: 'worker_name', label: 'Worker' }, { key: 'site_name', label: 'Site' }, { key: 'project_name', label: 'Project' },
        { key: 'status', label: 'Status', type: 'badge' }, { key: 'late_arrival', label: 'Late', type: 'bool' }, { key: 'early_departure', label: 'Left early', type: 'bool' },
        { key: 'normal_hours', label: 'Hours', num: true }, { key: 'overtime_hours', label: 'Overtime', num: true },
        { key: 'validated', label: 'Confirmed', type: 'bool' }, { key: 'source', label: 'Entered', type: 'label' }, { key: 'comments', label: 'Comment' },
      ]} />
    </div>
  );
}
