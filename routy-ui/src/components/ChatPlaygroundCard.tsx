import { useMemo, useState } from "react";
import { useGateway, useKeys, useNodeModels } from "../api/hooks";
import type { UpstreamNode } from "../api/types";
import { COPY_FAILED_HINT, useCopy } from "../hooks/useCopy";
import { Button } from "./ui/Button";
import { Card } from "./ui/Card";
import { Input } from "./ui/Input";
import { Select } from "./ui/Select";
import { Toggle } from "./ui/Toggle";
import { useToast } from "./ui/Toast";
import { Play, Copy, TerminalWindow } from "./icons";
import { fmtMs } from "../utils/format";

export function ChatPlaygroundCard({ node }: { node: UpstreamNode }) {
  const toast = useToast();
  const gateway = useGateway();
  const keys = useKeys();
  const models = useNodeModels(node.id);

  const clientKey = (keys.data ?? []).find((k) => k.enabled !== false)?.key ?? "";
  const endpoint = useMemo(() => {
    const base = gateway.data?.endpoint ?? "http://127.0.0.1:8010/v1";
    return `${base.replace(/\/+$/, "")}/chat/completions`;
  }, [gateway.data?.endpoint]);
  const modelRows = (models.data?.models ?? []).filter(
    (m) => !m.stale && m.enabled !== false && (!m.kind || m.kind === "llm"),
  );
  const defaultModel = modelRows[0]
    ? modelRows[0].model.startsWith(`${node.prefix}/`)
      ? modelRows[0].model
      : `${node.prefix}/${modelRows[0].model}`
    : `${node.prefix}/*`;

  const [selectedModel, setSelectedModel] = useState<string>("");
  const [prompt, setPrompt] = useState<string>("Hello! Please describe yourself in two sentences.");
  const [systemPrompt, setSystemPrompt] = useState<string>("");
  const [stream, setStream] = useState<boolean>(true);
  const [temperature, setTemperature] = useState<string>("0.7");
  const [maxTokens, setMaxTokens] = useState<string>("1024");
  const [busy, setBusy] = useState<boolean>(false);
  const [result, setResult] = useState<{
    status: number;
    ttftMs: number | null;
    durationMs: number | null;
    content: string;
    reasoning?: string;
    raw?: string;
  } | null>(null);

  const { state: copyState, copy } = useCopy();

  const effectiveModel = selectedModel || defaultModel;

  const messages = useMemo(() => {
    const list: Array<{ role: string; content: string }> = [];
    if (systemPrompt.trim()) {
      list.push({ role: "system", content: systemPrompt.trim() });
    }
    list.push({ role: "user", content: prompt || "ping" });
    return list;
  }, [systemPrompt, prompt]);

  const payload = useMemo(
    () => ({
      model: effectiveModel,
      messages,
      stream,
      temperature: Number(temperature) || 0.7,
      max_tokens: Number(maxTokens) || 1024,
    }),
    [effectiveModel, messages, stream, temperature, maxTokens],
  );

  const curl = useMemo(() => {
    const key = clientKey || "sk-your-router-key";
    return [
      `curl -X POST "${endpoint}" \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -H "Authorization: Bearer ${key}" \\`,
      `  -d '${JSON.stringify(payload, null, 2)}'`,
    ].join("\n");
  }, [endpoint, clientKey, payload]);

  const copyCurl = () => {
    void copy(curl);
  };

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setResult(null);

    const t0 = performance.now();
    let firstTokenTime: number | null = null;
    let accumulatedContent = "";
    let accumulatedReasoning = "";

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (clientKey) {
        headers["Authorization"] = `Bearer ${clientKey}`;
      }

      const res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errorText = await res.text();
        const durationMs = Math.round(performance.now() - t0);
        setResult({
          status: res.status,
          ttftMs: null,
          durationMs,
          content: `HTTP ${res.status}: ${errorText}`,
        });
        setBusy(false);
        return;
      }

      if (stream && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(":") || trimmed === "data: [DONE]") continue;
            if (trimmed.startsWith("data:")) {
              const dataStr = trimmed.slice(5).trim();
              try {
                const parsed = JSON.parse(dataStr);
                const delta = parsed.choices?.[0]?.delta;
                if (delta) {
                  if (firstTokenTime === null) {
                    firstTokenTime = Math.round(performance.now() - t0);
                  }
                  if (delta.reasoning_content || delta.reasoning || delta.thinking) {
                    accumulatedReasoning += delta.reasoning_content || delta.reasoning || delta.thinking || "";
                  }
                  if (delta.content) {
                    accumulatedContent += delta.content;
                  }
                  setResult({
                    status: res.status,
                    ttftMs: firstTokenTime,
                    durationMs: Math.round(performance.now() - t0),
                    content: accumulatedContent,
                    reasoning: accumulatedReasoning,
                  });
                }
              } catch {
                // Keep streaming
              }
            }
          }
        }

        const durationMs = Math.round(performance.now() - t0);
        setResult({
          status: res.status,
          ttftMs: firstTokenTime ?? durationMs,
          durationMs,
          content: accumulatedContent || "(empty response)",
          reasoning: accumulatedReasoning,
        });
      } else {
        const json = await res.json();
        const durationMs = Math.round(performance.now() - t0);
        const msg = json.choices?.[0]?.message;
        setResult({
          status: res.status,
          ttftMs: durationMs,
          durationMs,
          content: msg?.content ?? JSON.stringify(json, null, 2),
          reasoning: msg?.reasoning_content || msg?.reasoning,
        });
      }
    } catch (err) {
      const durationMs = Math.round(performance.now() - t0);
      setResult({
        status: 0,
        ttftMs: null,
        durationMs,
        content: err instanceof Error ? err.message : "Network error or aborted request",
      });
      toast("Request failed", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card padding="sm" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-text-main">Interactive Chat Playground</h3>
            <p className="text-xs text-text-muted">
              Send live prompts to this provider through routy to evaluate latency, streaming, and reasoning.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              icon={<Copy size={13} />}
              onClick={copyCurl}
              title={copyState === "fail" ? COPY_FAILED_HINT : undefined}
            >
              {copyState === "ok" ? "Copied curl" : "Copy curl"}
            </Button>
            <Button size="sm" variant="primary" icon={<Play size={13} />} loading={busy} onClick={run}>
              Run prompt
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-text-muted">Model</span>
            {modelRows.length > 0 ? (
              <Select
                value={effectiveModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                options={modelRows.map((r) => {
                  const id = r.model.startsWith(`${node.prefix}/`) ? r.model : `${node.prefix}/${r.model}`;
                  return { value: id, label: id };
                })}
              />
            ) : (
              <Input
                mono
                value={effectiveModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                placeholder={`${node.prefix}/model-name`}
              />
            )}
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-text-muted">Temperature</span>
            <Input
              type="number"
              min="0"
              max="2"
              step="0.1"
              value={temperature}
              onChange={(e) => setTemperature(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-text-muted">Max tokens</span>
            <Input
              type="number"
              min="1"
              max="32768"
              step="64"
              value={maxTokens}
              onChange={(e) => setMaxTokens(e.target.value)}
            />
          </div>

          <div className="flex flex-col justify-end gap-1">
            <Toggle label="Stream response" checked={stream} onChange={setStream} />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-[11px] font-medium text-text-muted">System instructions (optional)</label>
          <Input
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="You are a helpful and concise coding assistant."
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-[11px] font-medium text-text-muted">User prompt</label>
          <textarea
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Type your test message here..."
            className="w-full rounded-[10px] border border-border-subtle bg-surface-2 p-3 font-mono text-xs text-text-main focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </div>
      </Card>

      <Card padding="sm" className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <TerminalWindow size={15} className="text-text-muted" />
            <h4 className="text-xs font-semibold uppercase tracking-wider text-text-muted">Output</h4>
          </div>
          {result && (
            <div className="flex items-center gap-3 font-mono text-xs text-text-muted">
              <span>Status: {result.status === 0 ? "failed" : `HTTP ${result.status}`}</span>
              {result.ttftMs !== null && <span>TTFT: {fmtMs(result.ttftMs)}</span>}
              {result.durationMs !== null && <span>Duration: {fmtMs(result.durationMs)}</span>}
            </div>
          )}
        </div>

        {result?.reasoning && (
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium uppercase tracking-wider text-primary">Reasoning / Thinking</span>
            <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-[8px] border border-primary/20 bg-primary/5 p-3 font-mono text-xs leading-relaxed text-text-muted custom-scrollbar">
              {result.reasoning}
            </pre>
          </div>
        )}

        <pre className="min-h-24 max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded-[8px] border border-border-subtle bg-bg p-3 font-mono text-xs leading-relaxed text-text-main custom-scrollbar">
          {result?.content ?? "// Press 'Run prompt' to execute a live request and observe the stream."}
        </pre>
      </Card>
    </div>
  );
}
