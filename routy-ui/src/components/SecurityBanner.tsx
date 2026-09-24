import { Warning } from "./icons";

/**
 * Shown when the gateway is listening on a network with the management API unlocked.
 *
 * Not dismissible. It is a statement about the gateway's current state, not a notice:
 * anyone who can reach this port can read the client keys and edit the CLI tool
 * configs on the machine running routy. It goes away when the state does — turn on
 * "Require token" in Settings, or bind loopback.
 *
 * The point is consent rather than a wall. The default is open because this is a local
 * gateway and a credential before the dashboard renders is friction nobody asked for;
 * a banner is the honest version of that trade.
 */
export function SecurityBanner() {
  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-warning/30 bg-warning/10 px-4 py-2 text-[11px] text-text-muted"
    >
      <Warning size={14} className="shrink-0 text-warning" />
      <span>
        Listening on the network with the management API unlocked — anyone who can reach this port can
        read your client keys and edit CLI tool configs.
      </span>
      <a href="/settings" className="ml-auto shrink-0 whitespace-nowrap text-warning underline">
        Lock it down
      </a>
    </div>
  );
}
