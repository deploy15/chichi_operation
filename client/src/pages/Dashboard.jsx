import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { fmtMoney, fmtNum, label, todayStr } from '../lib/format';
import { Alert, BarList, Card, ErrorMsg, Loading, PageHeader, Stat, useLoad } from '../components/ui';

export default function Dashboard() {
  const [date, setDate] = useState(todayStr());
  const { data: d, error, loading } = useLoad(() => api.get(`/dashboard${qs({ date })}`), [date]);
  return (
    <div>
      <PageHeader title="Dashboard" subtitle="What is happening across clients, projects and sites"
        actions={<input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />} />
      <ErrorMsg error={error} />
      {loading && !d && <Loading />}
      {d && (
        <>
          {d.open_sync_conflicts > 0 && (
            <Alert tone="warning">{d.open_sync_conflicts} attendance change(s) from offline devices need a decision. <Link to="/attendance?tab=conflicts">Review them</Link></Alert>
          )}
          <div className="stats">
            {d.workforce && <Stat label="Active workers" value={fmtNum(d.workforce.active_workers)} />}
            {d.attendance && <Stat label="Present" value={fmtNum(d.attendance.present)} hint={`of ${d.attendance.expected} expected`} tone="green" />}
            {d.attendance && <Stat label="Absent" value={fmtNum(d.attendance.absent)} hint={`${d.attendance.not_recorded} not recorded yet`} tone={d.attendance.absent ? 'red' : undefined} />}
            {d.attendance && <Stat label="Overtime hours" value={fmtNum(d.attendance.overtime_hours, 1)} hint={`${d.attendance.late} late · ${d.attendance.early_departure} left early`} />}
            {d.catering && <Stat label="Meals required" value={fmtNum(d.catering.meals.reduce((a, m) => a + Number(m.value), 0))}
              hint={d.catering.meals.map((m) => `${label(m.label)}: ${m.value}`).join(' · ') || 'Not calculated yet'} />}
            {d.hse && <Stat label="Open HSE incidents" value={d.hse.open_incidents} hint={`${d.hse.open_serious} serious · ${d.hse.overdue_actions} overdue actions`} tone={d.hse.open_serious ? 'red' : undefined} />}
            {d.accommodation && <Stat label="Beds available" value={fmtNum(d.accommodation.available)} hint={`${d.accommodation.occupied} of ${d.accommodation.capacity} occupied`} />}
            {d.payroll && <Stat label="Labour cost this month" value={fmtMoney(d.payroll.estimated_cost)} hint={`${fmtNum(d.payroll.overtime_hours, 1)} overtime hours`} />}
            {d.finance && <Stat label="Catering expenses this month" value={fmtMoney(d.finance.month_expenses)} />}
            {d.medical && <Stat label="Medical follow-ups" value={d.medical.open_followups} hint={`${d.medical.upcoming_appointments} appointments · ${d.medical.expiring_soon} expiring soon`} />}
          </div>
          <div className="grid-3">
            {d.workforce && <Card title="Workers by client"><BarList items={d.workforce.by_client} /></Card>}
            {d.workforce && <Card title="Workers by project"><BarList items={d.workforce.by_project} /></Card>}
            {d.workforce && <Card title="Workers by site"><BarList items={d.workforce.by_site} /></Card>}
            {d.attendance && <Card title="Present today by site"><BarList items={d.attendance.by_site} valueKey="present" empty="No attendance recorded for this day." /></Card>}
            {d.attendance && <Card title="Absences by site"><BarList items={d.attendance.by_site.filter((s) => Number(s.absent))} valueKey="absent" empty="No absences." /></Card>}
            {d.attendance && <Card title="Overtime by site (hours)"><BarList items={d.attendance.by_site.filter((s) => Number(s.overtime))} valueKey="overtime" empty="No overtime." /></Card>}
          </div>
        </>
      )}
    </div>
  );
}
