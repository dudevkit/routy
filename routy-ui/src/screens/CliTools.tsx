import { useState } from "react";
import { useCliTools } from "../api/hooks";
import type { CliTool } from "../api/types";
import { CliToolDetail } from "../components/CliToolDetail";
import { TerminalWindow } from "../components/icons";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Skeleton } from "../components/ui/Skeleton";

/**
 * The list is for choosing a tool; the detail view does the configuring.
 *
 * Detection reads PATH and config files and writes nothing. Selecting a card opens
 * the settings for that tool — model, key, and what will be written where.
 */
function ToolCard({ tool, onOpen }: { tool: CliTool; onOpen: () => void }) {
  return (
    <Card padding="sm" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <TerminalWindow size={16} className="text-text-muted" />
        <h3 className="text-sm font-semibold text-text-main">{tool.name}</h3>
        {!tool.installed ? (
          <Badge variant="default" size="sm">not installed</Badge>
        ) : tool.connected ? (
          <Badge variant="success" size="sm">connected</Badge>
        ) : (
          <Badge variant="default" size="sm">available</Badge>
        )}
        {tool.managed && <Badge variant="info" size="sm">written by routy</Badge>}
      </div>

      <div className="flex flex-col gap-1 font-mono text-[11px] text-text-subtle">
        {tool.configPath && <span className="truncate" title={tool.configPath}>{tool.configPath}</span>}
        <span className="truncate">
          {tool.baseUrl ? `→ ${tool.baseUrl}` : "→ not pointed at a gateway"}
        </span>
      </div>

      {tool.note && <p className="line-clamp-2 text-[11px] text-text-muted">{tool.note}</p>}

      <div className="mt-auto flex items-center gap-2">
        <Button variant={tool.connected ? "secondary" : "primary"} size="sm" onClick={onOpen}>
          {!tool.writable ? "Details" : tool.connected ? "Configure" : "Set up"}
        </Button>
        {tool.installed && tool.writable && !tool.connected && (
          <span className="text-[11px] text-text-subtle">choose a model and key</span>
        )}
      </div>
    </Card>
  );
}

export function CliTools() {
  const tools = useCliTools();
  const [selected, setSelected] = useState<CliTool | null>(null);
  const list = tools.data?.tools ?? [];
  // Installed first, but never only installed. A tool that is absent is information
  // too — it is how you find out routy supports it at all — and an empty screen that
  // says "nothing found" gives you no way to tell "unsupported" from "detection
  // missed it", which are different problems with different fixes.
  const sorted = [...list].sort((a, b) => Number(b.installed) - Number(a.installed));
  const installedCount = list.filter((t) => t.installed).length;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold text-text-main">CLI Tools</h1>
        <p className="text-xs text-text-muted">
          Point an AI CLI installed on this machine at routy. Detection reads your PATH, the
          usual user install directories, and config files; nothing is written until you connect.
        </p>
      </div>

      {tools.isLoading ? (
        <Skeleton rows={3} />
      ) : list.length === 0 ? (
        <Card padding="sm" className="flex flex-col items-center gap-3 py-12 text-center">
          <TerminalWindow size={28} className="text-text-subtle" />
          <p className="text-sm text-text-muted">Could not read the tool list.</p>
          <p className="max-w-md text-xs text-text-subtle">
            The gateway returned no tools at all, which means the request failed rather than
            finding nothing — reload, and check the Live Console if it persists.
          </p>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {sorted.map((t) => (
              <ToolCard key={t.id} tool={t} onOpen={() => setSelected(t)} />
            ))}
          </div>
          <p className="text-[11px] text-text-subtle">
            {installedCount === 0
              ? `None of the ${list.length} supported tools were found on this machine.`
              : `${installedCount} of ${list.length} supported tools found on this machine.`}{" "}
            Install one and reload.
          </p>
        </>
      )}

      <CliToolDetail tool={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
