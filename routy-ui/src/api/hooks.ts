import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { api, streamLogs, type StreamLevel } from "./transport";
import type { ComboInput, LogRecord, ModelBulkAction, ProxyPoolInput } from "./types";

/* ── query keys ────────────────────────────────────────────────────────────── */
const NODES: QueryKey = ["nodes"];
const CONNECTIONS: QueryKey = ["connections"];
const KEYS: QueryKey = ["keys"];
const GATEWAY: QueryKey = ["gateway"];
const COMBOS: QueryKey = ["combos"];
const ALIASES: QueryKey = ["aliases"];
const POOLS: QueryKey = ["pools"];
const UPDATES: QueryKey = ["updates"];
const CLI_TOOLS: QueryKey = ["cli-tools"];
const ROUTABLE: QueryKey = ["routable-models"];

/* ── queries ───────────────────────────────────────────────────────────────── */
export const useNodes = () => useQuery({ queryKey: NODES, queryFn: api.listNodes, refetchInterval: 20000 });

export const useConnections = (nodeId: string | null) =>
  useQuery({
    queryKey: [...CONNECTIONS, nodeId],
    queryFn: () => api.listConnections(nodeId as string),
    enabled: !!nodeId,
  });

/** Model rows for one provider (P6). The list is discovery-only. */
export const useNodeModels = (nodeId: string | null) =>
  useQuery({
    queryKey: [...NODES, nodeId, "models"],
    queryFn: () => api.listModels(nodeId as string),
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
/** Exact payload pair for one usage event (round-2: server-side correlation). */
export const useDetailsForEvent = (usageEventId: number | null) =>
  useQuery({
    queryKey: ["usage", "details", "event", usageEventId],
    queryFn: () => api.getDetails(20, usageEventId ?? undefined),
    enabled: usageEventId !== null,
  });

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
export const useUpdateNode = () =>
  useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Parameters<typeof api.updateNode>[1] }) => api.updateNode(id, patch),
    onSuccess: useInvalidator(NODES, CONNECTIONS),
  });
export const useResetBreaker = () => useMutation({ mutationFn: api.resetBreaker, onSuccess: useInvalidator(NODES) });
export const useTestConnection = () => useMutation({ mutationFn: api.testConnection });

/* ── models + key probes (P6) ────────────────────────────────────────────────
   Invalidating NODES also covers the model-list queries, whose keys are
   [...NODES, nodeId, "models"] — react-query matches by key prefix. */
export const useAddModel = () => {
  const invalidate = useInvalidator(NODES);
  return useMutation({
    mutationFn: ({ nodeId, model }: { nodeId: string; model: string }) => api.addModel(nodeId, { model }),
    onSuccess: () => invalidate(),
  });
};

export const useUpdateModel = () => {
  const invalidate = useInvalidator(NODES);
  return useMutation({
    mutationFn: ({ nodeId, modelId, patch }: { nodeId: string; modelId: string; patch: { model?: string; enabled?: boolean } }) =>
      api.updateModel(nodeId, modelId, patch),
    onSuccess: () => invalidate(),
  });
};

export const useRemoveModel = () => {
  const invalidate = useInvalidator(NODES);
  return useMutation({
    mutationFn: ({ nodeId, modelId }: { nodeId: string; modelId: string }) => api.removeModel(nodeId, modelId),
    onSuccess: () => invalidate(),
  });
};

/** Import merges the upstream list; manual rows and probe results survive. */
export const useImportModels = () => {
  const invalidate = useInvalidator(NODES, CONNECTIONS);
  return useMutation({
    mutationFn: ({ nodeId, connectionId }: { nodeId: string; connectionId?: string }) => api.importModels(nodeId, connectionId),
    onSuccess: () => invalidate(),
  });
};

/** A real streamed probe of one model id — records TTFT on the row. */
export const useTestModel = () => {
  const invalidate = useInvalidator(NODES);
  return useMutation({
    mutationFn: ({ nodeId, modelId, connectionId }: { nodeId: string; modelId: string; connectionId?: string }) =>
      api.testModel(nodeId, modelId, connectionId),
    onSuccess: () => invalidate(),
  });
};

/** Bulk hide/show/delete/test a model selection. */
export const useBulkModels = () => {
  const invalidate = useInvalidator(NODES);
  return useMutation({
    mutationFn: ({ nodeId, ids, action }: { nodeId: string; ids: string[]; action: ModelBulkAction }) =>
      api.bulkModels(nodeId, { ids, action }),
    onSuccess: () => invalidate(),
  });
};

export const useTestKey = () => {
  const invalidate = useInvalidator(CONNECTIONS);
  return useMutation({
    mutationFn: ({ connectionId }: { connectionId: string }) => api.testConnectionKey(connectionId),
    onSuccess: () => invalidate(),
  });
};

export const useTestAllKeys = () => {
  const invalidate = useInvalidator(CONNECTIONS);
  return useMutation({
    mutationFn: ({ nodeId }: { nodeId: string }) => api.testAllKeys(nodeId),
    onSuccess: () => invalidate(),
  });
};

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
export const useUpdateConnection = () =>
  useMutation({ mutationFn: ({ id, patch }: { id: string; patch: { name?: string; status?: string; priority?: number } }) => api.updateConnection(id, patch), onSuccess: useInvalidator(CONNECTIONS, NODES) });
export const useDeleteConnection = () =>
  useMutation({ mutationFn: api.deleteConnection, onSuccess: useInvalidator(CONNECTIONS, NODES) });
export interface BatchAddConnectionsInput {
  nodeId: string;
  entries: { name?: string; apiKey: string }[];
  name?: string;
  priority?: number;
}
export const useBatchAddConnections = () =>
  useMutation({
    mutationFn: ({ nodeId, entries, name, priority }: BatchAddConnectionsInput) => api.batchAddConnections(nodeId, { entries, name, priority }),
    onSuccess: useInvalidator(CONNECTIONS, NODES),
  });

export const usePutSettings = () =>
  useMutation({ mutationFn: api.putSettings, onSuccess: useInvalidator(["settings"]) });
/** creating or removing a client key changes the gateway's masked key too */
export const useCreateKey = () => useMutation({ mutationFn: api.createKey, onSuccess: useInvalidator(KEYS, GATEWAY) });
export const useRemoveKey = () => useMutation({ mutationFn: api.removeKey, onSuccess: useInvalidator(KEYS, GATEWAY) });
/** enabled=false revokes without destroying the key row */
export const useSetKeyEnabled = () => useMutation({ mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.setKeyEnabled(id, enabled), onSuccess: useInvalidator(KEYS) });

/** Routable model ids from /v1/models — provider models, aliases and combos. */
export const useRoutableModels = () =>
  useQuery({
    queryKey: ROUTABLE,
    queryFn: async () => {
      const res = await fetch("/v1/models");
      if (!res.ok) throw new Error(`model list unavailable (${res.status})`);
      const body = (await res.json()) as { data?: { id?: string }[] };
      return (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string" && id.length > 0).sort();
    },
    staleTime: 60_000,
  });

export const useCliTools = () => useQuery({ queryKey: CLI_TOOLS, queryFn: api.listCliTools, staleTime: 30_000 });
export const useConnectCliTool = () =>
  useMutation({
    mutationFn: ({ id, input }: { id: string; input: Parameters<typeof api.connectCliTool>[1] }) => api.connectCliTool(id, input),
    onSuccess: useInvalidator(CLI_TOOLS),
  });
export const useDisconnectCliTool = () => useMutation({ mutationFn: api.disconnectCliTool, onSuccess: useInvalidator(CLI_TOOLS) });

export const useUpdates = () => useQuery({ queryKey: UPDATES, queryFn: api.getUpdates, staleTime: 60_000 });
export const useCheckUpdates = () => useMutation({ mutationFn: api.checkUpdates, onSuccess: useInvalidator(UPDATES) });
export const useDismissUpdate = () => useMutation({ mutationFn: api.dismissUpdate, onSuccess: useInvalidator(UPDATES) });
export const useApplyUpdate = () => useMutation({ mutationFn: api.applyUpdate, onSuccess: useInvalidator(UPDATES, GATEWAY) });

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
/** server-side ring clear — every open console receives the `clear` event */
export const useClearLogs = () => useMutation({ mutationFn: () => api.clearLogs() });

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
 * SSE consumer: `init` snapshot (up to 200 lines) then live `line` events, plus
 * the server's `clear` broadcast. `level` is the *minimum* level streamed
 * (`?level=`), so watching warn+error costs no debug traffic; changing it
 * re-subscribes. Buffers ring at MAX_LINES and coalesce bursts to ~10fps
 * re-renders so a busy gateway cannot melt the UI.
 */
export function useLogStream(level?: StreamLevel): UseLogStream {
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

  const emptyBuffers = () => {
    pending.current = [];
    setLines([]);
    setRaw([]);
  };

  useEffect(() => {
    setLines([]);
    setRaw([]);
    const unsubscribe = streamLogs(
      {
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
        onClear: emptyBuffers,
        onOpen: () => setConnected(true),
        onClose: () => setConnected(false),
      },
      level,
    );
    return () => {
      unsubscribe();
      clearTimeout(flushTimer.current);
    };
  }, [level]);

  const tags = useMemo(() => {
    const seen: Record<string, true> = {};
    for (const line of lines) seen[line.tag] = true;
    return Object.keys(seen).sort();
  }, [lines]);

  /** Empties the local view; call `useClearLogs` to clear the server ring too. */
  const clear = emptyBuffers;

  return { lines, tags, raw, connected, usingMock, clear };
}
