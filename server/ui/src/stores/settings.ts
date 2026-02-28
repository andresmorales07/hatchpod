import { create } from "zustand";
import { useAuthStore } from "./auth";

export interface SettingsState {
  theme: "dark" | "light";
  terminalFontSize: number;
  terminalScrollback: number;
  terminalShell: string;

  fetchSettings: () => Promise<void>;
  updateSettings: (partial: Partial<Omit<SettingsState, "fetchSettings" | "updateSettings">>) => Promise<void>;
}

const DEFAULTS = {
  theme: "dark" as const,
  terminalFontSize: 14,
  terminalScrollback: 1000,
  terminalShell: "/bin/bash",
};

function applyTheme(theme: "dark" | "light"): void {
  if (theme === "dark") {
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.classList.remove("dark");
  }
}

export const useSettingsStore = create<SettingsState>((set) => ({
  ...DEFAULTS,

  fetchSettings: async () => {
    const token = useAuthStore.getState().token;
    try {
      const res = await fetch("/api/settings", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = await res.json() as Partial<SettingsState>;
      const theme = (data.theme === "light" ? "light" : "dark") as "dark" | "light";
      set({
        theme,
        terminalFontSize: data.terminalFontSize ?? DEFAULTS.terminalFontSize,
        terminalScrollback: data.terminalScrollback ?? DEFAULTS.terminalScrollback,
        terminalShell: data.terminalShell ?? DEFAULTS.terminalShell,
      });
      applyTheme(theme);
    } catch {
      // Network error — silently use defaults
    }
  },

  updateSettings: async (partial) => {
    // Optimistic update
    set(partial);
    if (partial.theme !== undefined) applyTheme(partial.theme);

    const token = useAuthStore.getState().token;
    try {
      await fetch("/api/settings", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(partial),
      });
    } catch {
      // Server-side failure — the optimistic update stays in place
    }
  },
}));
