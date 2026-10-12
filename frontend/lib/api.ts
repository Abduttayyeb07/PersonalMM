import axios from 'axios';

const api = axios.create({
  // Default is same-origin (/api) so the build is domain-agnostic behind a reverse proxy.
  baseURL: process.env.NEXT_PUBLIC_API_URL || '/api',
  withCredentials: true,
  headers: { 'X-Requested-With': 'zig' },
});

export default api;

// Auth
export const login = (email: string, password: string) =>
  api.post('/auth/login', { email, password });

// Credentials
export const saveCredentials = (exchange: 'mexc' | 'bybit', apiKey: string, apiSecret: string, accountPassword: string, safetyConfirmed = false) =>
  api.post('/credentials', { exchange, apiKey, apiSecret, accountPassword, safetyConfirmed });

export const listCredentials = () => api.get('/credentials');
export const removeCredentials = (exchange: 'mexc' | 'bybit', accountPassword: string) =>
  api.delete(`/credentials/${exchange}`, { data: { accountPassword } });
export const testCredentials = (exchange: 'mexc' | 'bybit') => api.post(`/credentials/${exchange}/test`);
