import { NavLink } from "react-router-dom";
import {
  Broadcast,
  ChartBar,
  Coins,
  Gear,
  Network,
  Palette,
  ShareNetwork,
  SquaresFour,
  Stack,
  TerminalWindow,
  type IconComponent,
} from "./icons";
import { cn } from "../utils/cn";

interface NavItemSpec {
  to: string;
  label: string;
  icon: IconComponent;
  end?: boolean;
}

/** Nav model follows upstream ordering; rows are re-formed: left accent bar
 *  + icon weight flip (regular → fill) instead of a tinted background plate. */
const navItems: NavItemSpec[] = [
  { to: "/", label: "Overview", icon: SquaresFour, end: true },
  { to: "/upstreams", label: "Providers", icon: Broadcast },
  { to: "/combos", label: "Combos & Aliases", icon: Stack },
  { to: "/usage", label: "Usage", icon: ChartBar },
  { to: "/token-saver", label: "Token Saver", icon: Coins },
];

const systemItems: NavItemSpec[] = [
  { to: "/pools", label: "Proxy Pools", icon: Network },
  { to: "/console", label: "Live Console", icon: TerminalWindow },
  { to: "/theme", label: "Theme Catalog", icon: Palette },
];

function NavItem({ to, label, icon: Icon, end }: NavItemSpec) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          "relative flex items-center gap-2.5 rounded-md px-2.5 py-1 transition-colors duration-150",
          isActive ? "text-primary" : "text-text-muted hover:text-text-main",
        )
      }
    >
      {({ isActive }) => (
        <>
          {/* Active tick on the rail edge */}
          {isActive && (
            <span className="absolute -left-[11px] top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-full bg-primary" />
          )}
          <Icon size={17} weight={isActive ? "fill" : "regular"} className="shrink-0" />
          <span className={cn("text-[13px]", isActive ? "font-semibold" : "font-medium")}>{label}</span>
        </>
      )}
    </NavLink>
  );
}

export function Sidebar() {
  return (
    <aside className="flex w-72 flex-col border-r border-border-subtle bg-vibrancy backdrop-blur-xl min-h-full">
      {/* Wordmark block — the rail's top anchor (traffic lights removed) */}
      <div className="px-6 pt-6 pb-3">
        <NavLink to="/" className="flex items-center gap-3">
          <div className="flex items-center justify-center size-9 rounded-[10px] bg-gradient-to-br from-brand-500 to-brand-700 shadow-[var(--shadow-warm)]">
            <ShareNetwork size={18} weight="fill" className="text-white" />
          </div>
          <div className="flex flex-col">
            <span className="font-display text-lg font-semibold tracking-tight text-text-main">RE-E</span>
            <span className="text-xs text-text-muted">v0.1.0 · gateway</span>
          </div>
        </NavLink>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-4 py-1 space-y-0.5 overflow-y-auto custom-scrollbar">
        {navItems.map((item) => (
          <NavItem key={item.to} {...item} />
        ))}

        {/* System section */}
        <div className="pt-4 mt-2 space-y-0.5">
          <p className="px-2.5 pb-2 text-[11px] font-semibold uppercase tracking-wider text-text-subtle">System</p>
          {systemItems.map((item) => (
            <NavItem key={item.to} {...item} />
          ))}
          <NavItem to="/settings" label="Settings" icon={Gear} />
        </div>
      </nav>
    </aside>
  );
}
