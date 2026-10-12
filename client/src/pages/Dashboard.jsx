import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { fmtMoney, fmtNum, label, todayStr } from '../lib/format';
import { BarList, Card, ErrorMsg, Loading, PageHeader, Stat, useLoad } from '../components/ui';

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
          {d.approvals && d.approvals.length > 0 && (
            <Card title="Waiting for you" className="card-attention">
              <ul className="todo">
                {d.approvals.map((a) => <li key={a.label}><Link to={a.link}>{a.label}</Link> <span className="badge badge-orange">{a.count}</span></li>)}
              </ul>
            </Card>
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
            {d.daily_reports && <Stat label="Daily reports submitted" value={`${d.daily_reports.submitted} / ${d.daily_reports.sites}`}
              hint={`${d.daily_reports.on_time} before ${d.daily_reports.deadline}`} tone={d.daily_reports.submitted < d.daily_reports.sites ? 'red' : 'green'} />}
            {d.catering && <Stat label="Open kitchen & site reports" value={d.catering.open_feedback} hint={`${d.catering.batches_to_check} batches waiting for quality check`} />}
            {d.kitchen && <Stat label="Meals planned (my kitchen)" value={fmtNum(d.kitchen.planned)} hint={`${fmtNum(d.kitchen.produced)} cooked · ${fmtNum(d.kitchen.approved)} quality-approved`} />}
            {d.site_meals && <Stat label="Deliveries to receive" value={d.site_meals.awaiting_receipt} hint={`${d.site_meals.received} already received`} tone={d.site_meals.awaiting_receipt ? 'red' : undefined} />}
            {d.medical && <Stat label="Medical follow-ups" value={d.medical.open_followups} hint={`${d.medical.upcoming_appointments} appointments · ${d.medical.expiring_soon} expiring soon`} />}
          </div>
          <div className="grid-3">
            {d.workforce && d.workforce.by_status && <Card title="Workers by deployment status"><BarList items={d.workforce.by_status} /></Card>}
            {d.deliveries && <Card title="Deliveries today by step"><BarList items={d.deliveries} empty="No deliveries planned." /></Card>}
            {d.staffing && <Card title="Open staffing requests"><BarList items={d.staffing} valueKey="workers" empty="No open requests." /></Card>}
            {d.recruitment && <Card title="Candidates in progress"><BarList items={d.recruitment} empty="No candidates in progress." /></Card>}
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
