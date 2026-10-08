import { useState } from 'react';
import { useAuth } from '../lib/auth';
import { Alert } from '../components/ui';

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try { await login(email, password); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <h1>ChiChi Operations</h1>
        <p className="muted">Workforce and operations management</p>
        <Alert tone="error">{error}</Alert>
        <div className="field"><label htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div className="field"><label htmlFor="pw">Password</label>
          <input id="pw" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></div>
        <button className="btn btn-block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}
