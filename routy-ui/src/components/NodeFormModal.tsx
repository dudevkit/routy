import { useEffect, useState } from "react";
import { useAddNode, useTestConnection, useUpdateNode } from "../api/hooks";
import { toastApiError } from "../utils/errors";
import { THINKING_OPTIONS } from "../utils/thinking";
import type { NewNodeInput, TestResult, UpstreamNode } from "../api/types";
import { CheckCircle, Plus, WifiHigh, XCircle } from "./icons";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";
import { Modal } from "./ui/Modal";
import { Select } from "./ui/Select";
import { useToast } from "./ui/Toast";

const emptyForm: NewNodeInput = { name: "", baseUrl: "", apiKey: "", prefix: "", apiType: "openai" };
type TestState = null | "testing" | TestResult;

/** Wire format routy speaks to the upstream. Both are OpenAI-shaped; only the path and
 *  the request/response dialect differ (`core/executors/default.mjs` buildUrl). */
const API_TYPES = [
  { value: "openai", label: "OpenAI — Chat Completions (/chat/completions)" },
  { value: "responses", label: "OpenAI — Responses API (/responses)" },
];

/** Extra headers a relay may demand before it answers — it refuses requests that do not look
 *  like a coding CLI (403 `client_not_allowed`). Codex is the one verified end-to-end against
 *  such a relay; the others mirror routy's own client mappings (`opencode.mjs`,
 *  `mediaCatalog.mjs`). "Custom" is the editor below, for values you have to find yourself. */
type HeaderRow = { name: string; value: string };
const HEADER_PRESETS: { value: string; label: string; headers: HeaderRow[] }[] = [
  { value: "", label: "None", headers: [] },
  {
    value: "codex",
    label: "Codex CLI — verified",
    headers: [
      { name: "originator", value: "codex_cli_rs" },
      { name: "user-agent", value: "codex_cli_rs/0.51.0 (Windows 10.0.19045; x86_64)" },
    ],
  },
  { value: "claude", label: "Claude Code", headers: [{ name: "user-agent", value: "claude-cli/1.0.0" }] },
  {
    value: "opencode",
    label: "OpenCode",
    headers: [
      { name: "user-agent", value: "opencode/1.18.31" },
      { name: "x-opencode-client", value: "desktop" },
    ],
  },
];

/** "" stays distinguishable from 0 so a blank field means "unpriced", not "free". */
const priceOrUndefined = (raw: string): number | undefined => {
  const t = raw.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

/** Pricing is optional: without it the node is unmetered and never hits the budget. */
function PricingFields({
  input,
  output,
  disabled,
  onInput,
  onOutput,
}: {
  input: string;
  output: string;
  disabled: boolean;
  onInput: (v: string) => void;
  onOutput: (v: string) => void;
}) {
  const field =
    "w-full rounded-md border border-border-subtle bg-surface-2 px-3 py-2 font-mono text-sm text-text-main placeholder:text-text-main/40 focus:ring-2 focus:ring-accent/40";
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-text-main">Price per 1M tokens (USD)</span>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-text-muted">Input</span>
          <input className={field} type="number" min={0} step="0.01" placeholder="unpriced" disabled={disabled} value={input} onChange={(e) => onInput(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-text-muted">Output</span>
          <input className={field} type="number" min={0} step="0.01" placeholder="unpriced" disabled={disabled} value={output} onChange={(e) => onOutput(e.target.value)} />
        </label>
      </div>
      <p className="text-[11px] text-text-main/50">
        Leave blank for unmetered — the node then records no cost and keeps serving after the daily budget is spent.
      </p>
    </div>
  );
}

/**
 * Extra headers sent to this upstream. A row is dropped when its name is blank, so adding a
 * row and not filling it in is harmless. Presets write rows; everything stays editable.
 */
function HeaderFields({
  rows,
  disabled,
  onRows,
}: {
  rows: HeaderRow[];
  disabled: boolean;
  onRows: (next: HeaderRow[]) => void;
}) {
  const field =
    "w-full rounded-md border border-border-subtle bg-surface-2 px-3 py-2 font-mono text-xs text-text-main placeholder:text-text-main/40 focus:ring-2 focus:ring-accent/40";
  const set = (i: number, patch: Partial<HeaderRow>) => onRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const matches = HEADER_PRESETS.find(
    (p) => p.value && p.headers.length === rows.length && p.headers.every((h, i) => h.name === rows[i]?.name && h.value === rows[i]?.value),
  );
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-text-main">Custom headers</span>
      <div className="flex items-center gap-2">
        <select
          className="h-8 rounded-md border border-border-subtle bg-surface-2 px-2 text-xs text-text-main"
          disabled={disabled}
          value={matches?.value ?? ""}
          onChange={(e) => onRows(e.target.value ? (HEADER_PRESETS.find((p) => p.value === e.target.value)?.headers ?? []).map((h) => ({ ...h })) : [])}
        >
          <option value="">Preset: Custom</option>
          {HEADER_PRESETS.filter((p) => p.value).map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>
        <button
          type="button"
          className="text-xs text-accent hover:underline disabled:opacity-50"
          disabled={disabled}
          onClick={() => onRows([...rows, { name: "", value: "" }])}
        >
          + Add header
        </button>
      </div>
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <input className={field} placeholder="user-agent" disabled={disabled} value={r.name} onChange={(e) => set(i, { name: e.target.value })} />
          <input className={field} placeholder="codex_cli_rs/0.51.0" disabled={disabled} value={r.value} onChange={(e) => set(i, { value: e.target.value })} />
          <button
            type="button"
            className="shrink-0 px-1 text-text-muted hover:text-danger disabled:opacity-50"
            disabled={disabled}
            aria-label="Remove header"
            onClick={() => onRows(rows.filter((_, j) => j !== i))}
          >
            ×
          </button>
        </div>
      ))}
      <p className="text-[11px] text-text-main/50">
        Sent on every request to this upstream. Some relays reject anything that does not look like a coding CLI — pick{" "}
        <span className="font-mono">Codex CLI</span> for a Responses-only relay.
      </p>
    </div>
  );
}

/**
 * `prefix` is required by the backend (400 otherwise) and `modelCount` stays 0
 * on the saved node until a probe succeeds — Test here probes before saving.
 */
export function NodeFormModal({
  isOpen,
  onClose,
  node = null,
}: {
  isOpen: boolean;
  onClose: () => void;
  /** when set, the modal edits this upstream via PUT /api/nodes/{id} */
  node?: UpstreamNode | null;
}) {
  const toast = useToast();
  const [form, setForm] = useState<NewNodeInput>(emptyForm);
  const [priceIn, setPriceIn] = useState("");
  const [priceOut, setPriceOut] = useState("");
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>([]);
  const [thinking, setThinking] = useState("auto");
  const [test, setTest] = useState<TestState>(null);
  const testConnection = useTestConnection();
  const addNode = useAddNode();
  const updateNode = useUpdateNode();
  const editing = !!node;

  /* one modal for both flows: reseed when the target changes */
  useEffect(() => {
    if (!isOpen) return;
    setForm(node ? { name: node.name, baseUrl: node.baseUrl, apiKey: "", prefix: node.prefix, apiType: node.apiType ?? "openai" } : emptyForm);
    const pricing = node?.data?.pricing;
    setPriceIn(pricing?.inputPer1M !== undefined ? String(pricing.inputPer1M) : "");
    setPriceOut(pricing?.outputPer1M !== undefined ? String(pricing.outputPer1M) : "");
    setHeaderRows(Object.entries(node?.data?.headers ?? {}).map(([name, value]) => ({ name, value: String(value) })));
    setThinking(node?.thinking ?? "auto");
    setTest(null);
  }, [isOpen, node]);

  const close = () => {
    setForm(emptyForm);
    setPriceIn("");
    setPriceOut("");
    setHeaderRows([]);
    setThinking("auto");
    setTest(null);
    onClose();
  };

  const set = (patch: Partial<NewNodeInput>) => {
    setForm((prev) => ({ ...prev, ...patch }));
    if (patch.baseUrl !== undefined) setTest(null);
  };

  const urlLooksValid = /^https?:\/\/.+/.test(form.baseUrl.trim());
  const canSave = form.name.trim().length > 0 && urlLooksValid && form.prefix.trim().length > 0;
  // A blank name is a row the operator added and did not fill in — dropped, not sent.
  const headers = Object.fromEntries(headerRows.filter((r) => r.name.trim()).map((r) => [r.name.trim(), r.value]));

  const runTest = () => {
    setTest("testing");
    testConnection.mutate(
      // Test sends the custom headers too: a relay that gates on client identity would
      // otherwise reject the probe while accepting the real request.
      { baseUrl: form.baseUrl.trim(), apiKey: form.apiKey || undefined, headers },
      {
        onSuccess: (result) => setTest(result),
        onError: (err) => {
          setTest(null);
          toastApiError(toast, err, "Test failed");
        },
      },
    );
  };

  const save = () => {
    // pricing is omitted entirely when both fields are blank, keeping the node unmetered
    const inUsd = priceOrUndefined(priceIn);
    const outUsd = priceOrUndefined(priceOut);
    const pricing = inUsd === undefined && outUsd === undefined ? undefined : { ...(inUsd !== undefined ? { inputPer1M: inUsd } : {}), ...(outUsd !== undefined ? { outputPer1M: outUsd } : {}) };
    // "auto" is the absence of a policy, so it is stored as null — the same way `media` and
    // `headers` clear.
    const thinkingValue = thinking === "auto" ? null : thinking;

    if (!node) {
      const data = {
        ...(pricing ? { pricing } : {}),
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(thinkingValue ? { thinking: thinkingValue } : {}),
      };
      addNode.mutate({ ...form, data: Object.keys(data).length ? data : undefined }, {
        onSuccess: () => {
          toast("Provider added");
          close();
        },
        onError: (err) => toastApiError(toast, err, "Failed to add provider"),
      });
      return;
    }
    /* blank key means "keep it" — the server only rotates credentials when apiKey is a non-empty string */
    const patch: Partial<NewNodeInput> = {
      name: form.name.trim(),
      baseUrl: form.baseUrl.trim(),
      prefix: form.prefix.trim(),
      // merges into the node's data blob, so the cached model list survives; `null` clears a key
      data: { pricing: pricing ?? null, headers: Object.keys(headers).length ? headers : null, thinking: thinkingValue },
    };
    if (form.apiKey.trim()) patch.apiKey = form.apiKey.trim();
    /* apiType is server-managed on OAuth nodes (the API answers 409) — only send it when
       the operator actually changed it, and never for a node that owns its own protocol. */
    if ((form.apiType ?? "openai") !== (node.apiType ?? "openai")) patch.apiType = form.apiType;
    updateNode.mutate(
      { id: node.id, patch },
      {
        onSuccess: () => {
          toast("Provider updated");
          close();
        },
        onError: (err) => toastApiError(toast, err, "Failed to update provider"),
      },
    );
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={close}
      title={editing ? `Edit ${node?.name ?? "provider"}` : "Add Provider"}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={editing ? undefined : <Plus size={16} />}
            disabled={!canSave}
            loading={addNode.isPending || updateNode.isPending}
            onClick={save}
          >
            {editing ? "Save Changes" : "Add Provider"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Input
          label="Name"
          autoFocus
          value={form.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="My provider"
        />
        <Input
          label="Base URL"
          mono
          value={form.baseUrl}
          onChange={(e) => set({ baseUrl: e.target.value })}
          placeholder="https://api.example.com/v1"
        />
        <Select
          label="API type"
          hint="Wire format routy speaks upstream. Responses API sends to /responses; pick it for a relay that refuses /chat/completions."
          options={API_TYPES}
          disabled={!!node?.authProvider}
          value={form.apiType ?? "openai"}
          onChange={(e) => set({ apiType: e.target.value })}
        />
        <Select
          label="Thinking level"
          hint="Applies to every request to this provider. “Force” replaces what the client sends — pick one when a client's own level is refused upstream."
          options={THINKING_OPTIONS}
          value={thinking}
          onChange={(e) => setThinking(e.target.value)}
        />
        <HeaderFields
          rows={headerRows}
          disabled={addNode.isPending || updateNode.isPending}
          onRows={setHeaderRows}
        />
        <Input
          label="API Key"
          mono
          type="password"
          hint={editing ? "Leave blank to keep the current key — it is never read back from the API" : "Stored server-side — the UI only ever reads it back masked"}
          value={form.apiKey}
          onChange={(e) => set({ apiKey: e.target.value })}
          placeholder="sk-…"
        />
        <Input
          label="Model Prefix"
          mono
          required
          hint="Models with this prefix route to the node"
          value={form.prefix}
          onChange={(e) => set({ prefix: e.target.value.replace(/\/+$/, "") })}
          placeholder="or"
        />

        <PricingFields
          input={priceIn}
          output={priceOut}
          disabled={addNode.isPending || updateNode.isPending}
          onInput={setPriceIn}
          onOutput={setPriceOut}
        />

        <div className="flex min-h-7 items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            icon={<WifiHigh size={14} />}
            loading={test === "testing"}
            disabled={!urlLooksValid}
            onClick={runTest}
          >
            Test Connection
          </Button>
          {test && test !== "testing" &&
            (test.ok ? (
              <span className="flex items-center gap-1.5 font-mono text-xs text-success tabular">
                <CheckCircle size={14} weight="fill" className="shrink-0" />
                ok · {test.latencyMs}ms · {test.modelCount} models
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-xs text-danger">
                <XCircle size={14} className="shrink-0" />
                {test.error ?? "unreachable"}
              </span>
            ))}
        </div>
      </div>
    </Modal>
  );
}
