import { useEffect, useMemo, useRef, useState } from "react";
import { useClearLogs, useLogStream, usePutSettings, useSettings } from "../api/hooks";
import type { LogRecord } from "../api/types";
import type { StreamLevel } from "../api/transport";
import { toastApiError } from "../utils/errors";
import { fmtClockMs } from "../utils/format";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import { StatusDot } from "../components/ui/StatusDot";
import { useToast } from "../components/ui/Toast";
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
          "flex w-full items-baseline gap-3 px-3 py-[3px] text-left font-mono text-xs leading-relaxed transition-colors hover:bg-surface-2/60 sm:text-[11.5px]",
          hasData && "cursor-pointer",
        )}
      >
        <span className="shrink-0 tabular text-text-subtle">{fmtClockMs(line.t)}</span>
        <span className={cn("w-11 shrink-0 uppercase", levelTextClass[level])}>{level}</span>
        <span className="w-16 shrink-0 truncate text-text-muted" title={line.tag}>{line.tag}</span>
        <span className="min-w-0 flex-1 break-all text-text-main">
          {hasData && <CaretRight size={10} className={cn("mr-1 inline-block transition-transform", open && "rotate-90")} />}
          {line.msg}
        </span>
      </div>
      {open && hasData && (
        <pre className="mx-3 mb-1 max-h-52 overflow-auto whitespace-pre-wrap break-all rounded-[8px] border border-border-subtle bg-bg p-2 font-mono text-xs text-text-muted custom-scrollbar sm:text-[11px]">
          {JSON.stringify(line.data, null, 2)}
        </pre>
      )}
    </>
  );
}

export function ConsoleLog() {
  const [levels, setLevels] = useState<Record<Level, boolean>>({ debug: true, info: true, warn: true, error: true });
  const [tag, setTag] = useState("all");
  const [search, setSearch] = useState("");
  const [follow, setFollow] = useState(true);
  const scroller = useRef<HTMLDivElement | null>(null);
  const toast = useToast();
  const clearLogs = useClearLogs();
  const settings = useSettings();
  const put = usePutSettings();
  /** What the gateway *records* (vs `levels`, which only filters what is shown). */
  const capture = (settings.data?.logLevel as Level) ?? "info";

  const setCaptureLevel = (level: Level) =>
    put.mutate(
      { logLevel: level },
      {
        onSuccess: () =>
          toast(
            level === "debug"
              ? "Capturing debug — upstream dispatch, responses, retries and stream ends are now logged"
              : `Capture level set to ${level}`,
          ),
        onError: (err) => toastApiError(toast, err, "Failed to set capture level"),
      },
    );

  /**
   * When the enabled chips form a suffix of the level order, ask the server to stop
   * streaming the rest (`?level=`) so a warn-only view pays no debug traffic.
   * Non-contiguous sets stay fully streamed and are filtered in-view.
   */
  const streamLevel = useMemo<StreamLevel | undefined>(() => {
    const enabled = LEVELS.filter((l) => levels[l]);
    if (enabled.length === 0 || enabled.length === LEVELS.length) return undefined;
    const floor = LEVELS.indexOf(enabled[0]);
    return enabled.every((l, i) => LEVELS.indexOf(l) === floor + i) ? enabled[0] : undefined;
  }, [levels]);

  const { lines, tags, raw, connected, usingMock, clear } = useLogStream(streamLevel);

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

  /** Server-side clear: empties the gateway ring and notifies every open console. */
  const onClear = () => {
    if (usingMock) {
      clear();
      return;
    }
    clearLogs.mutate(undefined, {
      onSuccess: () => clear(),
      onError: (err) => toastApiError(toast, err, "Failed to clear gateway logs"),
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {LEVELS.map((level) => (
            <button
              key={level}
              onClick={() => toggleLevel(level)}
              aria-pressed={levels[level]}
              className={cn(
                "rounded-full border px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-wider transition-colors sm:text-[10px]",
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
            className="h-6 min-w-0 max-w-full rounded-full border border-border-subtle bg-surface-2 px-2 font-mono text-[11px] text-text-muted focus:outline-none sm:text-[10px]"
          >
            <option value="all">all tags</option>
            {tags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <label
            className="flex min-w-0 items-center gap-1.5 text-[11px] uppercase tracking-wider text-text-subtle sm:text-[10px]"
            title="How much the gateway records. 'info' shows requests and probes; 'debug' also logs every upstream dispatch, response, retry and stream end."
          >
            capture
            <select
              value={capture}
              onChange={(e) => setCaptureLevel(e.target.value as Level)}
              disabled={put.isPending}
              className="h-6 rounded-full border border-border-subtle bg-surface-2 px-2 font-mono text-[11px] normal-case tracking-normal text-text-main focus:outline-none sm:text-[10px]"
            >
              {LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter messages"
            className="min-w-0 basis-48"
            inputClassName="h-8 py-0 text-xs"
          />
          <Button size="sm" variant={follow ? "secondary" : "outline"} onClick={() => setFollow((v) => !v)}>
            {follow ? "Following" : "Paused"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<Trash size={13} />}
            onClick={onClear}
            loading={clearLogs.isPending}
            title="Clears the gateway ring buffer for every open console"
            aria-label="Clear gateway logs"
          />
        </div>
      </div>

      <Card padding="none" className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle bg-bg-alt px-3 py-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-text-muted sm:text-[11px]">
            <StatusDot tone={connected ? "green" : "red"} pulse={connected} />
            <span>{connected ? "streaming" : "disconnected"}</span>
            <span className="font-mono tabular">
              {visible.length.toLocaleString()} lines{visible.length > RENDER_CAP ? ` (showing last ${RENDER_CAP})` : ""}
            </span>
          </div>
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
            {raw.length > 0 && (
              <Badge variant="warning" size="sm">
                {raw.length} unparsed
              </Badge>
            )}
            <Badge variant="default" size="sm">
              {streamLevel ? `/api/logs/stream?level=${streamLevel}` : "/api/logs/stream"}
            </Badge>
          </div>
        </div>

        <div ref={scroller} className="h-[calc(100vh-300px)] min-h-[380px] overflow-y-auto custom-scrollbar bg-bg py-1">
          {usingMock && (
            <p className="px-3 py-2 text-xs text-text-subtle">
              Mock transport: no log stream. Drop VITE_API_MODE to watch the live gateway.
            </p>
          )}
          {!usingMock && lines.length === 0 && raw.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <p className="text-sm text-text-muted">No lines in the gateway ring since boot or the last clear.</p>
              <p className="text-xs text-text-subtle">
                The gateway buffers only at its own <code className="font-mono">ROUTY_LOG_LEVEL</code> floor, and the
                healthy-path REQ line is still pending (contract-requests §5) — so silence here does not mean no traffic.
              </p>
            </div>
          )}
          {!usingMock && lines.length > 0 && shown.length === 0 && raw.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <p className="text-sm text-text-muted">
                No log lines match the current filter ({lines.length.toLocaleString()} buffered).
              </p>
              <p className="text-xs text-text-subtle">Widen the level or tag filter to see them.</p>
            </div>
          )}
          {shown.map((l, i) => (
            <LogRow key={`${l.t}-${i}`} line={l} />
          ))}
          {raw.map((r, i) => (
            <div key={`raw-${i}`} className="min-w-0 break-all px-3 py-[3px] font-mono text-xs text-text-subtle sm:text-[11.5px]">
              {r}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
