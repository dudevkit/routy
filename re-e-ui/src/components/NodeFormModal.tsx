import { useEffect, useState } from "react";
import { useAddNode, useTestConnection, useUpdateNode } from "../api/hooks";
import { toastApiError } from "../utils/errors";
import type { NewNodeInput, TestResult, UpstreamNode } from "../api/types";
import { CheckCircle, Plus, WifiHigh, XCircle } from "./icons";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";
import { Modal } from "./ui/Modal";
import { useToast } from "./ui/Toast";

const emptyForm: NewNodeInput = { name: "", baseUrl: "", apiKey: "", prefix: "" };
type TestState = null | "testing" | TestResult;

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
    "w-full rounded-md border border-border-subtle bg-surface-2 px-3 py-2 font-mono text-sm text-text-main placeholder:text-text-main/40 focus:outline-none focus:ring-2 focus:ring-accent/40";
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
 * The connect-in-under-60s flow: one modal, four fields, inline probe.
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
  const [test, setTest] = useState<TestState>(null);
  const testConnection = useTestConnection();
  const addNode = useAddNode();
  const updateNode = useUpdateNode();
  const editing = !!node;

  /* one modal for both flows: reseed when the target changes */
  useEffect(() => {
    if (!isOpen) return;
    setForm(node ? { name: node.name, baseUrl: node.baseUrl, apiKey: "", prefix: node.prefix } : emptyForm);
    const pricing = node?.data?.pricing;
    setPriceIn(pricing?.inputPer1M !== undefined ? String(pricing.inputPer1M) : "");
    setPriceOut(pricing?.outputPer1M !== undefined ? String(pricing.outputPer1M) : "");
    setTest(null);
  }, [isOpen, node]);

  const close = () => {
    setForm(emptyForm);
    setPriceIn("");
    setPriceOut("");
    setTest(null);
    onClose();
  };

  const set = (patch: Partial<NewNodeInput>) => {
    setForm((prev) => ({ ...prev, ...patch }));
    if (patch.baseUrl !== undefined) setTest(null);
  };

  const urlLooksValid = /^https?:\/\/.+/.test(form.baseUrl.trim());
  const canSave = form.name.trim().length > 0 && urlLooksValid && form.prefix.trim().length > 0;

  const runTest = () => {
    setTest("testing");
    testConnection.mutate(
      { baseUrl: form.baseUrl.trim(), apiKey: form.apiKey || undefined },
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

    if (!node) {
      addNode.mutate({ ...form, data: pricing ? { pricing } : undefined }, {
        onSuccess: () => {
          toast("Upstream added");
          close();
        },
        onError: (err) => toastApiError(toast, err, "Failed to add upstream"),
      });
      return;
    }
    /* blank key means "keep it" — the server only rotates credentials when apiKey is a non-empty string */
    const patch: Partial<NewNodeInput> = {
      name: form.name.trim(),
      baseUrl: form.baseUrl.trim(),
      prefix: form.prefix.trim(),
      // merges into the node's data blob, so the cached model list survives
      data: { pricing: pricing ?? null },
    };
    if (form.apiKey.trim()) patch.apiKey = form.apiKey.trim();
    updateNode.mutate(
      { id: node.id, patch },
      {
        onSuccess: () => {
          toast("Upstream updated");
          close();
        },
        onError: (err) => toastApiError(toast, err, "Failed to update upstream"),
      },
    );
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={close}
      title={editing ? `Edit ${node?.name ?? "upstream"}` : "Add Upstream"}
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
            {editing ? "Save Changes" : "Add Upstream"}
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
          placeholder="My upstream"
        />
        <Input
          label="Base URL"
          mono
          value={form.baseUrl}
          onChange={(e) => set({ baseUrl: e.target.value })}
          placeholder="https://api.example.com/v1"
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
          onChange={(e) => set({ prefix: e.target.value })}
          placeholder="or/"
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
                <XCircle size={14} className="shrink-0 shrink-0" />
                {test.error ?? "unreachable"}
              </span>
            ))}
        </div>
      </div>
    </Modal>
  );
}
