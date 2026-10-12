import { create } from 'zustand';
import api from '../lib/api';

interface AuthState {
  email: string | null;
  ready: boolean;
  setAuth: (email: string) => void;
  logout: () => Promise<void>;
  hydrate: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  email: null,
  ready: false,
  setAuth: (email) => set({ email }),
  logout: async () => {
    await api.post('/auth/logout').catch(() => {});
    set({ email: null });
  },
  hydrate: async () => {
    try {
      const { data } = await api.get('/auth/me');
      set({ email: data.email, ready: true });
    } catch {
      set({ email: null, ready: true });
    }
  },
}));
