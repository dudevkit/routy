import { Warning } from "./icons";

/**
 * Shown when the gateway is listening on a network with the dashboard login turned off.
 *
 * Not dismissible. It is a statement about the gateway's current state, not a notice:
 * anyone who can reach this port can read the client keys and edit the CLI tool
 * configs on the machine running routy. It goes away when the state does — turn the
 * login back on in Settings, or bind loopback.
 *
 * The default is a login with a known password, so this banner should be rare: you
 * have to have deliberately switched the login off.
 */
export function SecurityBanner() {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-warning/30 bg-warning/10 px-4 py-2 text-[11px] text-text-muted"
    >
      <Warning size={14} className="shrink-0 text-warning" />
      <span className="min-w-0 flex-1 leading-snug">
        Listening on the network with the dashboard login turned off — anyone who can reach this port
        can read your client keys and edit CLI tool configs.
      </span>
      <a href="/settings" className="ml-auto shrink-0 whitespace-nowrap text-warning underline">
        Turn it on
      </a>
    </div>
  );
}
