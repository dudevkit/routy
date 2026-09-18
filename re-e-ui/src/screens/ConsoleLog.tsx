import { useEffect, useMemo, useRef, useState } from "react";
import { useLogStream } from "../api/hooks";
import type { LogRecord } from "../api/types";
import { fmtClockMs } from "../utils/format";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import { StatusDot } from "../components/ui/StatusDot";
import { CaretRight, Trash } from "../components/icons";
import { cn } from "../utils/cn";

const LEVELS = ["debug", "info", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];

const levelTextClass: Record<Level, string> = {
  debug: "text-info",
  info: "text-success",
  warn: "text-warning",
  error: "text-danger",
};

function asLevel(level: string): Level {
  return (LEVELS as readonly string[]).includes(level) ? (level as Level) : "info";
}

/** Rendering cap keeps the DOM honest on a chatty gateway; the buffer holds more. */
const RENDER_CAP = 600;

function LogRow({ line }: { line: LogRecord }) {
  const [open, setOpen] = useState(false);
  const level = asLevel(line.level);
  const hasData = line.data !== undefined && line.data !== null;

  return (
    <>
      <div
        role={hasData ? "button" : undefined}
        tabIndex={hasData ? 0 : undefined}
        onClick={hasData ? () => setOpen((v) => !v) : undefined}
        onKeyDown={
          hasData
            ? (e) => {
                if (e.key === "Enter") setOpen((v) => !v);
              }
            : undefined
        }
        className={cn(
          "flex w-full items-baseline gap-3 px-3 py-[3px] text-left font-mono text-[11.5px] leading-relaxed transition-colors hover:bg-surface-2/60",
          hasData && "cursor-pointer",
        )}
      >
        <span className="shrink-0 tabular text-text-subtle">{fmtClockMs(line.t)}</span>
        <span className={cn("w-11 shrink-0 uppercase", levelTextClass[level])}>{level}</span>
        <span className="w-16 shrink-0 truncate text-text-muted">{line.tag}</span>
        <span className="min-w-0 flex-1 break-all text-text-main">
          {hasData && <CaretRight size={10} className={cn("mr-1 inline-block transition-transform", open && "rotate-90")} />}
          {line.msg}
        </span>
      </div>
      {open && hasData && (
        <pre className="mx-3 mb-1 max-h-52 overflow-auto whitespace-pre-wrap break-all rounded-[8px] border border-border-subtle bg-bg p-2 font-mono text-[11px] text-text-muted custom-scrollbar">
          {JSON.stringify(line.data, null, 2)}
        </pre>
      )}
    </>
  );
}

export function ConsoleLog() {
  const { lines, tags, raw, connected, usingMock, clear } = useLogStream();
  const [levels, setLevels] = useState<Record<Level, boolean>>({ debug: true, info: true, warn: true, error: true });
  const [tag, setTag] = useState("all");
  const [search, setSearch] = useState("");
  const [follow, setFollow] = useState(true);
  const scroller = useRef<HTMLDivElement | null>(null);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return lines.filter((l) => {
      if (!levels[asLevel(l.level)]) return false;
      if (tag !== "all" && l.tag !== tag) return false;
      if (!needle) return true;
      return `${l.tag} ${l.msg}`.toLowerCase().includes(needle);
    });
  }, [levels, tag, search, lines]);

  const shown = visible.length > RENDER_CAP ? visible.slice(visible.length - RENDER_CAP) : visible;

  useEffect(() => {
    if (!follow || !scroller.current) return;
    scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [shown, follow]);

  const toggleLevel = (level: Level) => setLevels((prev) => ({ ...prev, [level]: !prev[level] }));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {LEVELS.map((level) => (
            <button
              key={level}
              onClick={() => toggleLevel(level)}
              aria-pressed={levels[level]}
              className={cn(
                "rounded-full border px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-colors",
                levels[level]
                  ? "border-transparent bg-primary/10 text-primary"
                  : "border-border-subtle text-text-subtle hover:text-text-muted",
              )}
            >
              {level}
            </button>
          ))}
          <select
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            className="h-6 rounded-full border border-border-subtle bg-surface-2 px-2 font-mono text-[10px] text-text-muted focus:outline-none"
          >
            <option value="all">all tags</option>
            {tags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter messages"
            className="w-48"
            inputClassName="h-8 py-0 text-xs"
          />
          <Button size="sm" variant={follow ? "secondary" : "outline"} onClick={() => setFollow((v) => !v)}>
            {follow ? "Following" : "Paused"}
          </Button>
          <Button size="sm" variant="ghost" icon={<Trash size={13} />} onClick={clear} aria-label="Clear view" />
        </div>
      </div>

      <Card padding="none" className="overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-border-subtle bg-bg-alt px-3 py-1.5">
          <div className="flex items-center gap-2 text-[11px] text-text-muted">
            <StatusDot tone={connected ? "green" : "red"} pulse={connected} />
            <span>{connected ? "streaming" : "disconnected"}</span>
            <span className="font-mono tabular">
              {visible.length.toLocaleString()} lines{visible.length > RENDER_CAP ? ` (showing last ${RENDER_CAP})` : ""}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {raw.length > 0 && (
              <Badge variant="warning" size="sm">
                {raw.length} unparsed
              </Badge>
            )}
            <Badge variant="default" size="sm">
              /api/logs/stream
            </Badge>
          </div>
        </div>

        <div ref={scroller} className="h-[calc(100vh-300px)] min-h-[380px] overflow-y-auto custom-scrollbar bg-bg py-1">
          {usingMock && (
            <p className="px-3 py-2 text-xs text-text-subtle">
              Mock transport: no log stream. Drop VITE_API_MODE to watch the live gateway.
            </p>
          )}
          {!usingMock && shown.length === 0 && raw.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <p className="text-sm text-text-muted">No log lines match the current filter.</p>
              <p className="text-xs text-text-subtle">Send a request through /v1 and lines arrive here.</p>
            </div>
          )}
          {shown.map((l, i) => (
            <LogRow key={`${l.t}-${i}`} line={l} />
          ))}
          {raw.map((r, i) => (
            <div key={`raw-${i}`} className="px-3 py-[3px] break-all font-mono text-[11.5px] text-text-subtle">
              {r}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
