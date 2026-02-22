import { create } from "zustand";

interface AuthState {
  token: string;
  authenticated: boolean;
  setToken: (token: string) => void;
  login: () => void;
  logout: () => void;
}

function safeGetItem(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

const storedToken = safeGetItem("api_token");

export const useAuthStore = create<AuthState>((set) => ({
  token: storedToken,
  authenticated: storedToken.length > 0,
  setToken: (token) => set({ token }),
  login: () => {
    const token = useAuthStore.getState().token;
    try { localStorage.setItem("api_token", token); } catch { /* private browsing */ }
    set({ authenticated: true });
  },
  logout: () => {
    try { localStorage.removeItem("api_token"); } catch { /* private browsing */ }
    set({ token: "", authenticated: false });
  },
}));
