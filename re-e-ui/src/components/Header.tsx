import { useMemo } from "react";
import { useLocation } from "react-router-dom";
import { StatusDot } from "./ui/StatusDot";
import { ThemeToggle } from "./ui/ThemeToggle";

interface PageInfo {
  title: string;
  description: string;
  icon?: string;
}

function getPageInfo(pathname: string): PageInfo {
  if (pathname.includes("/upstreams")) return { title: "Upstreams", description: "Connect compatible nodes and manage API keys", icon: "dns" };
  if (pathname.includes("/combos")) return { title: "Combos & Aliases", description: "Group upstreams into fallback combos", icon: "layers" };
  if (pathname.includes("/usage")) return { title: "Usage", description: "Requests, tokens, cost and latency", icon: "bar_chart" };
  if (pathname.includes("/token-saver")) return { title: "Token Saver", description: "Reduce prompt token spend (RTK)", icon: "savings" };
  if (pathname.includes("/pools")) return { title: "Proxy Pools", description: "Outbound proxy pools and health", icon: "lan" };
  if (pathname.includes("/console")) return { title: "Live Console", description: "Streaming gateway logs", icon: "terminal" };
  if (pathname.includes("/settings")) return { title: "Settings", description: "Appearance and gateway configuration", icon: "settings" };
  return { title: "Overview", description: "Gateway health and activity", icon: "space_dashboard" };
}

export function Header() {
  const { pathname } = useLocation();
  const pageInfo = useMemo(() => getPageInfo(pathname), [pathname]);
  const { title, description, icon } = pageInfo;

  return (
    <header className="shrink-0 flex items-center justify-between gap-3 px-4 lg:px-8 pt-3 pb-2 border-b border-border-subtle bg-surface/60 backdrop-blur-xl lg:bg-transparent lg:backdrop-blur-none z-20">
      {/* Page title */}
      <div className="flex flex-col min-w-0 flex-1">
        <div>
          <div className="flex items-center gap-2">
            {icon && <span className="material-symbols-outlined text-primary text-xl lg:text-2xl">{icon}</span>}
            <h1 className="text-base lg:text-2xl font-semibold tracking-tight truncate">{title}</h1>
          </div>
          {description && (
            <p className="hidden lg:block text-sm text-text-muted truncate">{description}</p>
          )}
        </div>
      </div>

      {/* Right actions */}
      <div className="flex items-center gap-1 shrink-0">
        <div
          className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-border bg-surface/70 text-xs text-text-muted"
          title="Gateway status"
        >
          <StatusDot tone="green" pulse />
          <span>online</span>
          <span className="ml-2 shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
            v0.1.0
          </span>
        </div>
        <ThemeToggle />
      </div>
    </header>
  );
}
