import axios from 'axios';

export const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';
export const API_ORIGIN = API_BASE.replace(/\/api\/?$/, '');
export const INSTITUTIONAL_DOMAIN = '@mlrit.ac.in';

export const api = axios.create({ baseURL: API_BASE });
api.interceptors.request.use(config => { const token = localStorage.getItem('learnpool.token'); if (token) config.headers.Authorization = `Bearer ${token}`; return config; });
api.interceptors.response.use(x => x, error => {
  const status = error.response?.status;
  const url = error.config?.url || '';
  // Wrong passwords on these screens are normal errors, not an expired session.
  const authScreen = /\/auth\/(login|change-password|forgot-password|reset-password)/.test(url);
  if (status === 401 && !authScreen) {
    localStorage.removeItem('learnpool.token');
    localStorage.removeItem('learnpool.user');
    window.location.assign('/login');
  }
  if (status === 403 && error.response?.data?.code === 'PASSWORD_CHANGE_REQUIRED') {
    try { const u = JSON.parse(localStorage.getItem('learnpool.user')); if (u) localStorage.setItem('learnpool.user', JSON.stringify({ ...u, mustChangePassword: true })); } catch { /* ignore */ }
    if (window.location.pathname !== '/change-password') window.location.assign('/change-password');
  }
  return Promise.reject(error);
});

export const normalizeRole = role => role === 'faculty' ? 'instructor' : role;
// Every role has its own dashboard address.
export const roleHome = role => `/${normalizeRole(role) || 'student'}/dashboard`;
export const assetUrl = value => !value ? '' : /^(https?:|data:|blob:)/i.test(value) ? value : API_ORIGIN + value;
export const initials = name => (name || 'LP').split(/\s+/).slice(0, 2).map(x => x[0]).join('').toUpperCase();
export const dateLabel = value => value ? new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
