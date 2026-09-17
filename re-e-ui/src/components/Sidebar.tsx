import { NavLink } from "react-router-dom";
import { cn } from "../utils/cn";

interface NavItemSpec {
  to: string;
  label: string;
  icon: string;
  end?: boolean;
}

/** Nav model follows the upstream Sidebar ordering, mapped to RE-E screens. */
const navItems: NavItemSpec[] = [
  { to: "/", label: "Overview", icon: "space_dashboard", end: true },
  { to: "/upstreams", label: "Upstreams", icon: "dns" },
  { to: "/combos", label: "Combos & Aliases", icon: "layers" },
  { to: "/usage", label: "Usage", icon: "bar_chart" },
  { to: "/token-saver", label: "Token Saver", icon: "savings" },
];

const systemItems: NavItemSpec[] = [
  { to: "/pools", label: "Proxy Pools", icon: "lan" },
  { to: "/console", label: "Live Console", icon: "terminal" },
];

function NavItem({ to, label, icon, end }: NavItemSpec) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-3 px-3 py-1 rounded-lg transition-all group",
          isActive
            ? "bg-primary/10 text-primary"
            : "text-text-muted hover:bg-surface-2 hover:text-text-main",
        )
      }
    >
      {({ isActive }) => (
        <>
          <span className={cn("material-symbols-outlined text-[18px]", isActive ? "fill-1" : "group-hover:text-primary transition-colors")}>
            {icon}
          </span>
          <span className="text-[13px] font-medium">{label}</span>
        </>
      )}
    </NavLink>
  );
}

export function Sidebar() {
  return (
    <aside className="flex w-72 flex-col border-r border-border-subtle bg-vibrancy backdrop-blur-xl min-h-full">
      {/* Traffic lights */}
      <div className="flex items-center gap-2 px-6 pt-5 pb-2">
        <div className="traffic-lights">
          <div className="traffic-light red" />
          <div className="traffic-light yellow" />
          <div className="traffic-light green" />
        </div>
      </div>

      {/* Logo */}
      <div className="px-6 py-4 flex flex-col gap-2">
        <NavLink to="/" className="flex items-center gap-3">
          <div className="flex items-center justify-center size-9 rounded-[10px] bg-gradient-to-br from-brand-500 to-brand-700 shadow-[var(--shadow-warm)]">
            <span className="material-symbols-outlined text-white text-[20px]">hub</span>
          </div>
          <div className="flex flex-col">
            <h1 className="text-lg font-semibold tracking-tight text-text-main">RE-E</h1>
            <span className="text-xs text-text-muted">v0.1.0</span>
          </div>
        </NavLink>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-4 py-2 space-y-0.5 overflow-y-auto custom-scrollbar">
        {navItems.map((item) => (
          <NavItem key={item.to} {...item} />
        ))}

        {/* System section */}
        <div className="pt-3 mt-2 space-y-0.5">
          <p className="px-4 text-xs font-semibold text-text-muted/60 uppercase tracking-wider mb-2">System</p>
          {systemItems.map((item) => (
            <NavItem key={item.to} {...item} />
          ))}
          <NavItem to="/settings" label="Settings" icon="settings" />
        </div>
      </nav>
    </aside>
  );
}
