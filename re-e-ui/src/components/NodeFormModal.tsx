import { useState } from "react";
import { useAddNode, useTestConnection } from "../api/hooks";
import { toastApiError } from "../utils/errors";
import type { NewNodeInput, TestResult } from "../api/types";
import { CheckCircle, Plus, WifiHigh, XCircle } from "./icons";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";
import { Modal } from "./ui/Modal";
import { useToast } from "./ui/Toast";

const emptyForm: NewNodeInput = { name: "", baseUrl: "", apiKey: "", prefix: "" };
type TestState = null | "testing" | TestResult;

/**
 * The connect-in-under-60s flow: one modal, four fields, inline probe.
 * `prefix` is required by the backend (400 otherwise) and `modelCount` stays 0
 * on the saved node until a probe succeeds — Test here probes before saving.
 */
export function NodeFormModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState<NewNodeInput>(emptyForm);
  const [test, setTest] = useState<TestState>(null);
  const testConnection = useTestConnection();
  const addNode = useAddNode();

  const close = () => {
    setForm(emptyForm);
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

  const save = () =>
    addNode.mutate(form, {
      onSuccess: () => {
        toast("Upstream added");
        close();
      },
      onError: (err) => toastApiError(toast, err, "Failed to add upstream"),
    });

  return (
    <Modal
      isOpen={isOpen}
      onClose={close}
      title="Add Upstream"
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={<Plus size={16} />}
            disabled={!canSave}
            loading={addNode.isPending}
            onClick={save}
          >
            Add Upstream
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
          hint="Stored server-side — the UI only ever reads it back masked"
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
