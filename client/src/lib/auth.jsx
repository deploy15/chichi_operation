import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from './api';

const AuthContext = createContext(null);

// Keeps the signed-in user. The user is also saved on the device so the app still opens offline.
export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('user')); } catch { return null; }
  });
  const [checking, setChecking] = useState(!!localStorage.getItem('token'));

  const logout = useCallback(() => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setUser(null);
  }, []);

  useEffect(() => {
    if (!localStorage.getItem('token')) { setChecking(false); return; }
    api.get('/auth/me')
      .then((u) => { setUser(u); localStorage.setItem('user', JSON.stringify(u)); })
      .catch((e) => { if (!e.offline) logout(); })
      .finally(() => setChecking(false));
  }, [logout]);

  useEffect(() => {
    const onExpired = () => logout();
    window.addEventListener('auth-expired', onExpired);
    return () => window.removeEventListener('auth-expired', onExpired);
  }, [logout]);

  const login = async (email, password) => {
    const { token, user: u } = await api.post('/auth/login', { email, password });
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(u));
    setUser(u);
  };

  const can = useCallback((...perms) => !!user && perms.some((p) => user.permissions.includes(p)), [user]);

  return <AuthContext.Provider value={{ user, login, logout, can, checking }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
