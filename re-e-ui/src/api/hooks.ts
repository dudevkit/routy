import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { api, streamLogs } from "./transport";
import type { ComboInput, LogRecord, ProxyPoolInput } from "./types";

/* ── query keys ────────────────────────────────────────────────────────────── */
const NODES: QueryKey = ["nodes"];
const CONNECTIONS: QueryKey = ["connections"];
const KEYS: QueryKey = ["keys"];
const GATEWAY: QueryKey = ["gateway"];
const COMBOS: QueryKey = ["combos"];
const ALIASES: QueryKey = ["aliases"];
const POOLS: QueryKey = ["pools"];

/* ── queries ───────────────────────────────────────────────────────────────── */
export const useNodes = () => useQuery({ queryKey: NODES, queryFn: api.listNodes, refetchInterval: 20000 });

export const useConnections = (nodeId: string | null) =>
  useQuery({
    queryKey: [...CONNECTIONS, nodeId],
    queryFn: () => api.listConnections(nodeId as string),
    enabled: !!nodeId,
  });

export const useStats = () =>
  useQuery({ queryKey: ["usage", "stats"], queryFn: api.getStats, refetchInterval: 10000 });

export const useFailures = (limit = 20) =>
  useQuery({ queryKey: ["usage", "failures", limit], queryFn: () => api.getFailures(limit) });

export const useHistory = (params: { since?: number; limit?: number } = {}, enabled = true) =>
  useQuery({
    queryKey: ["usage", "history", params],
    queryFn: () => api.getHistory(params),
    enabled,
    refetchInterval: enabled ? 10000 : false,
  });

export const useDetails = (limit = 50, enabled = true) =>
  useQuery({ queryKey: ["usage", "details", limit], queryFn: () => api.getDetails(limit), enabled });

export const useGateway = () => useQuery({ queryKey: GATEWAY, queryFn: api.getGateway, refetchInterval: 30000 });

export const useHealth = () => useQuery({ queryKey: ["health"], queryFn: api.getHealth, refetchInterval: 30000 });

export const useSettings = () => useQuery({ queryKey: ["settings"], queryFn: api.getSettings });

export const useKeys = () => useQuery({ queryKey: KEYS, queryFn: api.listKeys });

export const useCombos = () => useQuery({ queryKey: COMBOS, queryFn: api.listCombos });

export const useAliases = () => useQuery({ queryKey: ALIASES, queryFn: api.listAliases });

export const usePools = () => useQuery({ queryKey: POOLS, queryFn: api.listPools });

/* ── mutations (invalidate exactly the affected keys) ──────────────────────── */
function useInvalidator(...keys: QueryKey[]) {
  const client = useQueryClient();
  return () => keys.forEach((key) => client.invalidateQueries({ queryKey: key }));
}

export const useAddNode = () => useMutation({ mutationFn: api.addNode, onSuccess: useInvalidator(NODES) });
export const useRemoveNode = () =>
  useMutation({ mutationFn: api.removeNode, onSuccess: useInvalidator(NODES, CONNECTIONS) });
export const useResetBreaker = () => useMutation({ mutationFn: api.resetBreaker, onSuccess: useInvalidator(NODES) });
/** a successful probe caches modelCount on the node → nodes must refresh */
export const useTestNode = () => useMutation({ mutationFn: api.testNode, onSuccess: useInvalidator(NODES) });
export const useTestConnection = () => useMutation({ mutationFn: api.testConnection });

export interface AddConnectionInput {
  nodeId: string;
  name?: string;
  apiKey: string;
}
export const useAddConnection = () =>
  useMutation({
    mutationFn: ({ nodeId, ...input }: AddConnectionInput) => api.addConnection(nodeId, input),
    onSuccess: useInvalidator(CONNECTIONS, NODES),
  });

export const usePutSettings = () =>
  useMutation({ mutationFn: api.putSettings, onSuccess: useInvalidator(["settings"]) });
/** creating or removing a client key changes the gateway's masked key too */
export const useCreateKey = () => useMutation({ mutationFn: api.createKey, onSuccess: useInvalidator(KEYS, GATEWAY) });
export const useRemoveKey = () => useMutation({ mutationFn: api.removeKey, onSuccess: useInvalidator(KEYS, GATEWAY) });

export const useCreateCombo = () => useMutation({ mutationFn: api.createCombo, onSuccess: useInvalidator(COMBOS) });
export interface ComboPatch {
  id: string;
  patch: Partial<ComboInput>;
}
export const useUpdateCombo = () =>
  useMutation({ mutationFn: ({ id, patch }: ComboPatch) => api.updateCombo(id, patch), onSuccess: useInvalidator(COMBOS) });
export const useDeleteCombo = () => useMutation({ mutationFn: api.deleteCombo, onSuccess: useInvalidator(COMBOS) });

export const useSetAlias = () => useMutation({ mutationFn: api.setAlias, onSuccess: useInvalidator(ALIASES) });
export const useDeleteAlias = () => useMutation({ mutationFn: api.deleteAlias, onSuccess: useInvalidator(ALIASES) });

export const useCreatePool = () => useMutation({ mutationFn: api.createPool, onSuccess: useInvalidator(POOLS) });
export interface PoolPatch {
  id: string;
  patch: Partial<ProxyPoolInput>;
}
export const useUpdatePool = () =>
  useMutation({ mutationFn: ({ id, patch }: PoolPatch) => api.updatePool(id, patch), onSuccess: useInvalidator(POOLS) });
export const useDeletePool = () => useMutation({ mutationFn: api.deletePool, onSuccess: useInvalidator(POOLS) });
export const useTestPool = () => useMutation({ mutationFn: api.testPool });

/* ── live log stream ───────────────────────────────────────────────────────── */
const MAX_LINES = 2000;

export interface UseLogStream {
  lines: LogRecord[];
  /** distinct tags in the buffer, for the filter control */
  tags: string[];
  /** frames that arrived as non-JSON — surfaced, never dropped */
  raw: string[];
  connected: boolean;
  usingMock: boolean;
  clear: () => void;
}

/**
 * One log frame is `{ t, level, tag, msg, data? }` serialized as a JSON string.
 * Shape is verified per field before any read; a frame with neither `t` nor
 * `msg` is kept as raw text rather than silently dropped.
 */
function parseLine(text: string): LogRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const rec = parsed as Record<string, unknown>; // object-ness verified above
  const str = (key: string): string | undefined => {
    const value = rec[key];
    return typeof value === "string" ? value : undefined;
  };
  const t = str("t");
  const msg = str("msg");
  if (t === undefined && msg === undefined) return null;
  return { t: t ?? "", level: str("level") ?? "info", tag: str("tag") ?? "LOG", msg: msg ?? text, data: rec.data };
}

/**
 * SSE consumer: `init` snapshot (up to 200 lines) then live `line` events.
 * Buffers ring at MAX_LINES and coalesce bursts to ~10fps re-renders so a busy
 * gateway cannot melt the UI. `clear()` empties the local view only — the backend
 * ring buffer is untouched (no clear endpoint; see contract-requests.md).
 */
export function useLogStream(): UseLogStream {
  const [lines, setLines] = useState<LogRecord[]>([]);
  const [raw, setRaw] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const usingMock = import.meta.env.VITE_API_MODE === "mock";
  const pending = useRef<LogRecord[]>([]);
  const flushTimer = useRef<number | undefined>(undefined);

  const scheduleFlush = () => {
    if (flushTimer.current !== undefined) return;
    flushTimer.current = window.setTimeout(() => {
      flushTimer.current = undefined;
      const incoming = pending.current;
      pending.current = [];
      if (!incoming.length) return;
      setLines((prev) => {
        const overflow = prev.length + incoming.length - MAX_LINES;
        return overflow > 0 ? [...prev.slice(overflow), ...incoming] : [...prev, ...incoming];
      });
    }, 100);
  };

  useEffect(() => {
    const unsubscribe = streamLogs({
      onInit: (snapshot) => {
        const parsed = snapshot.map(parseLine);
        setLines(parsed.filter((record): record is LogRecord => record !== null));
        setRaw(parsed.map((record, i) => (record === null ? snapshot[i] : null)).filter((s): s is string => s !== null));
        setConnected(true);
      },
      onLine: (text) => {
        const record = parseLine(text);
        if (!record) {
          setRaw((prev) => [...prev.slice(-(MAX_LINES - 1)), text]);
          return;
        }
        pending.current.push(record);
        scheduleFlush();
      },
      onOpen: () => setConnected(true),
      onClose: () => setConnected(false),
    });
    return () => {
      unsubscribe();
      clearTimeout(flushTimer.current);
    };
  }, []);

  const tags = useMemo(() => {
    const seen: Record<string, true> = {};
    for (const line of lines) seen[line.tag] = true;
    return Object.keys(seen).sort();
  }, [lines]);

  const clear = () => {
    setLines([]);
    setRaw([]);
  };

  return { lines, tags, raw, connected, usingMock, clear };
}
