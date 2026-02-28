import { useEffect } from "react";
import { Routes, Route, Navigate, useLocation, useMatch } from "react-router-dom";
import { useAuthStore } from "@/stores/auth";
import { useSessionsStore } from "@/stores/sessions";
import { useSettingsStore } from "@/stores/settings";
import { useIsDesktop } from "@/hooks/useMediaQuery";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell } from "@/components/AppShell";
import { LoginPage } from "@/pages/LoginPage";
import { SessionListPage } from "@/pages/SessionListPage";
import { ChatPage } from "@/pages/ChatPage";
import { NewSessionPage } from "@/pages/NewSessionPage";
import { TerminalPage } from "@/pages/TerminalPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { MobileNavBar } from "@/components/MobileNavBar";

function AuthGuard({ children }: { children: React.ReactNode }) {
  const authenticated = useAuthStore((s) => s.authenticated);
  const location = useLocation();
  if (!authenticated) return <Navigate to="/login" state={{ from: location }} replace />;
  return <>{children}</>;
}

function EmptyState() {
  return (
    <div className="flex items-center justify-center h-full text-muted-foreground">
      <p className="text-sm">Select a session or create a new one</p>
    </div>
  );
}

function DesktopRoutes() {
  return (
    <AppShell>
      <Routes>
        <Route index element={<EmptyState />} />
        <Route path="session/:id" element={<ChatPage />} />
        <Route path="new" element={<NewSessionPage />} />
        <Route path="terminal" element={<TerminalPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Routes>
    </AppShell>
  );
}

function MobileLayout() {
  const isChat = useMatch("/session/:id");

  return (
    <div className="flex flex-col h-dvh">
      <div className="flex-1 min-h-0 overflow-hidden">
        <Routes>
          <Route index element={<SessionListPage />} />
          <Route path="session/:id" element={<ChatPage />} />
          <Route path="new" element={<NewSessionPage />} />
          <Route path="terminal" element={<TerminalPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Routes>
      </div>
      {!isChat && <MobileNavBar />}
    </div>
  );
}

export function App() {
  const authenticated = useAuthStore((s) => s.authenticated);
  const fetchConfig = useSessionsStore((s) => s.fetchConfig);
  const fetchSettings = useSettingsStore((s) => s.fetchSettings);
  const isDesktop = useIsDesktop();

  useEffect(() => {
    if (authenticated) {
      fetchConfig();
      fetchSettings();
    }
  }, [authenticated, fetchConfig, fetchSettings]);

  return (
    <TooltipProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/*"
          element={
            <AuthGuard>
              {isDesktop ? <DesktopRoutes /> : <MobileLayout />}
            </AuthGuard>
          }
        />
      </Routes>
    </TooltipProvider>
  );
}
