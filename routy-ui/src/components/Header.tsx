import { useMemo } from "react";
import { useLocation } from "react-router-dom";
import {
  Broadcast,
  ChartBar,
  Coins,
  Gear,
  List,
  Network,
  SquaresFour,
  Stack,
  TerminalWindow,
  Wrench,
  type IconComponent,
} from "./icons";
import { useGateway } from "../api/hooks";
import { Badge } from "./ui/Badge";
import { StatusDot } from "./ui/StatusDot";
import { ThemeToggle } from "./ui/ThemeToggle";

interface PageInfo {
  title: string;
  description: string;
  icon: IconComponent;
}

function getPageInfo(pathname: string): PageInfo {
  if (pathname.includes("/upstreams")) return { title: "Providers", description: "Connect compatible providers, manage keys and models", icon: Broadcast };
  if (pathname.includes("/combos")) return { title: "Combos & Aliases", description: "Group upstreams into fallback combos", icon: Stack };
  if (pathname.includes("/usage")) return { title: "Usage", description: "Requests, tokens, cost and latency", icon: ChartBar };
  if (pathname.includes("/token-saver")) return { title: "Token Saver", description: "Reduce prompt token spend (RTK)", icon: Coins };
  if (pathname.includes("/pools")) return { title: "Proxy Pools", description: "Outbound proxy pools and health", icon: Network };
  if (pathname.includes("/console")) return { title: "Live Console", description: "Streaming gateway logs", icon: TerminalWindow };
  if (pathname.includes("/cli-tools")) return { title: "CLI Tools", description: "Point an installed AI CLI at this gateway", icon: Wrench };
  if (pathname.includes("/settings")) return { title: "Settings", description: "Appearance and gateway configuration", icon: Gear };
  return { title: "Overview", description: "Gateway health and activity", icon: SquaresFour };
}

export function Header({ onMenu }: { onMenu: () => void }) {
  const { pathname } = useLocation();
  const pageInfo = useMemo(() => getPageInfo(pathname), [pathname]);
  const gateway = useGateway();
  const { title, description, icon: Icon } = pageInfo;

  return (
    <header className="shrink-0 flex items-center gap-2 sm:gap-3 px-3 lg:px-8 pt-3 pb-2 border-b border-border-subtle bg-surface/60 backdrop-blur-xl lg:bg-transparent lg:backdrop-blur-none z-20">
      {/* Below lg the rail is display:none, so this button is the only way to change
          screen on a phone. */}
      <button
        onClick={onMenu}
        aria-label="Open menu"
        className="-ml-1.5 shrink-0 rounded-[10px] p-2 text-text-muted transition-colors hover:bg-surface-2 hover:text-text-main lg:hidden"
      >
        <List size={20} weight="bold" />
      </button>
      {/* Page title */}
      <div className="flex flex-col min-w-0 flex-1">
        <div className="flex items-center gap-2.5">
          <Icon size={22} weight="fill" className="shrink-0 text-primary" />
          <h1 className="text-base lg:text-2xl font-semibold tracking-tight truncate">{title}</h1>
        </div>
        {description && (
          <p className="hidden lg:block text-sm text-text-muted truncate">{description}</p>
        )}
      </div>

      {/* Right actions */}
      <div className="flex items-center gap-2 shrink-0">
        <div
          className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full border border-border bg-surface/70 text-xs text-text-muted"
          title="Gateway status"
        >
          <StatusDot tone="green" pulse />
          <span>online</span>
          <Badge variant="primary" size="sm" className="ml-1 font-mono uppercase tracking-wide">
            {gateway.data ? `v${gateway.data.version}` : "—"}
          </Badge>
        </div>
        <ThemeToggle />
      </div>
    </header>
  );
}
