import { useNavigate, useLocation } from "react-router-dom";
import { LayoutList, Terminal, Settings } from "lucide-react";
import { cn } from "@/lib/utils";

const TABS = [
  { label: "Sessions", icon: LayoutList, path: "/" },
  { label: "Terminal", icon: Terminal, path: "/terminal" },
  { label: "Settings", icon: Settings, path: "/settings" },
] as const;

export function MobileNavBar() {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  return (
    <nav aria-label="Bottom navigation" className="flex items-stretch border-t border-border bg-card shrink-0 min-h-[44px]">
      {TABS.map(({ label, icon: Icon, path }) => {
        const active =
          path === "/"
            ? pathname !== "/terminal" && pathname !== "/settings"
            : pathname === path;
        return (
          <button
            key={path}
            onClick={() => navigate(path)}
            className={cn(
              "flex flex-1 flex-col items-center justify-center gap-1 py-2 text-[0.625rem] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              active
                ? "text-primary border-t-2 border-primary -mt-px"
                : "text-muted-foreground border-t-2 border-transparent -mt-px"
            )}
          >
            <Icon className="size-5" />
            {label}
          </button>
        );
      })}
    </nav>
  );
}
