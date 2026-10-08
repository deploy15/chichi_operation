import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { subscribe } from './lib/sync';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Structure from './pages/Structure';
import Workers from './pages/Workers';
import WorkerDetail from './pages/WorkerDetail';
import Attendance from './pages/Attendance';
import Catering from './pages/Catering';
import Finance from './pages/Finance';
import Accommodation from './pages/Accommodation';
import Medical from './pages/Medical';
import Hse from './pages/Hse';
import Payroll from './pages/Payroll';
import Admin from './pages/Admin';
import Account from './pages/Account';

// Menu items appear only if the user's role allows them
const NAV = [
  { to: '/', label: 'Dashboard', perms: ['dashboard.view'], end: true },
  { to: '/attendance', label: 'Attendance', perms: ['attendance.view', 'attendance.record'] },
  { to: '/workers', label: 'Workers', perms: ['workers.view'] },
  { to: '/organisation', label: 'Clients & Sites', perms: ['structure.view'] },
  { to: '/catering', label: 'Catering', perms: ['catering.view', 'meals.receive'] },
  { to: '/accommodation', label: 'Accommodation', perms: ['accommodation.view'] },
  { to: '/hse', label: 'HSE & Incidents', perms: ['hse.view', 'hse.report'] },
  { to: '/medical', label: 'Medical', perms: ['medical.view'] },
  { to: '/payroll', label: 'Payroll', perms: ['payroll.view'] },
  { to: '/finance', label: 'Costs', perms: ['finance.view'] },
  { to: '/admin', label: 'Users & Settings', perms: ['users.manage', 'audit.view'] },
];

function SyncBadge() {
  const [s, setS] = useState(null);
  useEffect(() => subscribe(setS), []);
  if (!s) return null;
  if (!s.online) return <span className="sync sync-off" title="Changes are saved on this device and sent when the connection returns">Offline{s.pending ? ` · ${s.pending} waiting` : ''}</span>;
  if (s.failed) return <NavLink to="/attendance" className="sync sync-bad">{s.failed} not sent</NavLink>;
  if (s.pending) return <span className="sync sync-wait">{s.syncing ? 'Sending…' : `${s.pending} waiting`}</span>;
  return <span className="sync sync-ok">Online</span>;
}

export default function App() {
  const { user, logout, can, checking } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setMenuOpen(false), [location.pathname]);

  if (checking && !user) return <div className="loading">Loading…</div>;
  if (!user) return <Login />;

  const nav = NAV.filter((n) => can(...n.perms));
  const home = nav[0] ? nav[0].to : '/account';

  return (
    <div className="app">
      <header className="topbar">
        <button className="menu-btn" onClick={() => setMenuOpen((o) => !o)} aria-label="Menu" aria-expanded={menuOpen}>☰</button>
        <div className="brand">ChiChi Operations</div>
        <SyncBadge />
        <NavLink to="/account" className="user-chip" title="My account">{user.name}<small>{user.role}</small></NavLink>
      </header>
      <nav className={`sidebar ${menuOpen ? 'open' : ''}`}>
        {nav.map((n) => <NavLink key={n.to} to={n.to} end={n.end}>{n.label}</NavLink>)}
        <button className="link signout" onClick={logout}>Sign out</button>
      </nav>
      <main className="content">
        <Routes>
          {can('dashboard.view') && <Route path="/" element={<Dashboard />} />}
          <Route path="/attendance" element={<Attendance />} />
          <Route path="/workers" element={<Workers />} />
          <Route path="/workers/:id" element={<WorkerDetail />} />
          <Route path="/organisation" element={<Structure />} />
          <Route path="/catering" element={<Catering />} />
          <Route path="/finance" element={<Finance />} />
          <Route path="/accommodation" element={<Accommodation />} />
          <Route path="/medical" element={<Medical />} />
          <Route path="/hse/*" element={<Hse />} />
          <Route path="/payroll" element={<Payroll />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/account" element={<Account />} />
          <Route path="*" element={<Navigate to={home} replace />} />
        </Routes>
      </main>
    </div>
  );
}
