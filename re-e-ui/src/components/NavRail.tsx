import { NavLink } from "react-router-dom";
import {
  BarChart3,
  Globe,
  Layers,
  LayoutGrid,
  Network,
  PiggyBank,
  Server,
  Settings,
  Terminal,
} from "lucide-react";
import { cn } from "../utils/cn";
import { StatusDot } from "./ui/StatusDot";

interface NavItemSpec {
  to: string;
  label: string;
  icon: typeof LayoutGrid;
  end?: boolean;
}

const gatewayItems: NavItemSpec[] = [
  { to: "/", label: "Overview", icon: LayoutGrid, end: true },
  { to: "/upstreams", label: "Upstreams", icon: Server },
  { to: "/combos", label: "Combos & Aliases", icon: Layers },
  { to: "/token-saver", label: "Token Saver", icon: PiggyBank },
  { to: "/pools", label: "Proxy Pools", icon: Globe },
];

const insightItems: NavItemSpec[] = [
  { to: "/usage", label: "Usage", icon: BarChart3 },
  { to: "/console", label: "Live Console", icon: Terminal },
];

function NavItem({ to, label, icon: Icon, end }: NavItemSpec) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          "flex h-7 items-center gap-2.5 rounded-md px-2.5 text-13 transition-colors duration-150 focus-ring",
          isActive
            ? "bg-blue-100 font-medium text-blue-800"
            : "text-gray-700 hover:bg-gray-alpha-200 hover:text-gray-1000",
        )
      }
    >
      <Icon size={15} strokeWidth={1.75} />
      {label}
    </NavLink>
  );
}

function NavSection({ label, items }: { label: string; items: NavItemSpec[] }) {
  return (
    <div className="px-2">
      <p className="px-2 pt-4 pb-1 text-11 font-medium tracking-wider text-gray-600 uppercase">
        {label}
      </p>
      {items.map((item) => (
        <NavItem key={item.to} {...item} />
      ))}
    </div>
  );
}

export function NavRail() {
  return (
    <aside className="flex w-[248px] shrink-0 flex-col border-r border-gray-alpha-300 bg-background-100">
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-2">
        <div className="flex size-8 items-center justify-center rounded-md bg-blue-600 text-white">
          <Network size={16} strokeWidth={2} />
        </div>
        <div className="flex flex-col">
          <span className="text-14 leading-4 font-semibold">RE-E</span>
          <span className="flex items-center gap-1.5 text-11 leading-4 text-gray-600">
            <StatusDot tone="green" pulse />
            online · v0.1.0
          </span>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto pb-4">
        <NavSection label="Gateway" items={gatewayItems} />
        <NavSection label="Insights" items={insightItems} />
      </nav>

      <div className="border-t border-gray-alpha-200 px-2 py-2">
        <NavItem to="/settings" label="Settings" icon={Settings} />
      </div>
    </aside>
  );
}
