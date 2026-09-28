import { useMemo, useState } from "react";
import { useGateway, useKeys, useNodeModels } from "../api/hooks";
import { MEDIA_KIND_INFO, type MediaKind, type UpstreamNode } from "../api/types";
import { Button } from "./ui/Button";
import { Card } from "./ui/Card";
import { Input } from "./ui/Input";
import { Select } from "./ui/Select";
import { useToast } from "./ui/Toast";

/**
 * Run a real request against this media provider — 9Router's "Example" card, ported.
 *
 * The whole point of a media provider is that it answers one endpoint, so the only honest way to
 * know a key works is to send a request the provider actually understands: routy's key probe
 * speaks the chat API, which search/fetch/embedding hosts do not have. So this card builds the
 * curl, runs it, and shows what came back — with the key it uses visible (masked) and the request
 * shown in full before it is sent.
 *
 * It SPENDS the provider's quota when Run is pressed — that is the request it is testing — which
 * is why Run is a deliberate click and never automatic.
 */
/** Text generation's entry. Chat is not a media kind, but the card is the same shape, so the
 *  provider page reuses it — one request tester, not one per surface. */
const CHAT_INFO = { id: "llm", label: "Chat", method: "POST", path: "/v1/chat/completions", modelList: "node" };

export function ExampleCard({ node, kind: kindProp }: { node: UpstreamNode; kind?: MediaKind | "llm" }) {
  const toast = useToast();
  const gateway = useGateway();
  const keys = useKeys();
  const models = useNodeModels(node.id);
  const kind = kindProp ?? (node.mediaKinds?.[0] as MediaKind | undefined);
  const info = kind === "llm" ? CHAT_INFO : kind ? MEDIA_KIND_INFO.find((k) => k.id === kind) : undefined;

  // The provider key: the gateway's client key, which is what /v1/* asks for.
  const clientKey = (keys.data ?? []).find((k) => k.enabled !== false)?.key ?? "";
  const endpoint = useMemo(() => {
    if (!info || !gateway.data?.endpoint) return "";
    try { return `${new URL(gateway.data.endpoint).origin}${info.path}`; } catch { return info.path; }
  }, [gateway.data?.endpoint, info]);

  const modelRows = (models.data?.models ?? []).filter((m) => !m.stale && m.enabled !== false && (!kind || m.kind === kind || (kind === "llm" && (m.kind === "llm" || !m.kind))));
  const defaultModel = info?.modelList === "none" ? node.prefix : modelRows[0] ? `${node.prefix}/${modelRows[0].model}` : "";

  // Kind-specific fields, kept as strings so an empty box is a field the caller simply did not set.
  const [model, setModel] = useState(defaultModel);
  const [input, setInput] = useState("Say hello in five words.");
  const [query, setQuery] = useState("routy gateway");
  const [maxResults, setMaxResults] = useState("5");
  const [url, setUrl] = useState("https://example.com");
  const [format, setFormat] = useState("markdown");
  const [maxChars, setMaxChars] = useState("0");
  const [prompt, setPrompt] = useState("a watercolor fox in a foggy forest");
  const [message, setMessage] = useState("Reply with exactly: pong");
  const [maxTokens, setMaxTokens] = useState("64");

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ status: number; ms: number; body: string } | null>(null);

  if (!info || !kind) return null;

  const usedModel = model || defaultModel;

  const payload = (): Record<string, unknown> => {
    switch (kind) {
      case "webFetch": {
        const body: Record<string, unknown> = { model: usedModel, url, format };
        if (maxChars.trim() !== "" && Number(maxChars) > 0) body.max_characters = Number(maxChars);
        return body;
      }
      case "webSearch": {
        const body: Record<string, unknown> = { model: usedModel, query };
        if (maxResults.trim() !== "") body.max_results = Number(maxResults);
        return body;
      }
      case "llm": {
        const body: Record<string, unknown> = { model: usedModel, messages: [{ role: "user", content: message }] };
        if (maxTokens.trim() !== "" && Number(maxTokens) > 0) body.max_tokens = Number(maxTokens);
        return body;
      }
      case "embedding": return { model: usedModel, input };
      case "image": return { model: usedModel, prompt };
      case "tts": return { model: usedModel, input };
      default: return { model: usedModel };
    }
  };

  const body = payload();
  const curl = [
    `curl -X ${info.method} ${endpoint} \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -H "Authorization: Bearer ${clientKey || "YOUR_KEY"}" \\`,
    `  -d '${JSON.stringify(body)}'`,
  ].join("\n");

  const copyCurl = async () => {
    try {
      await navigator.clipboard.writeText(curl);
      toast("curl copied");
    } catch {
      toast("Could not copy — select the text instead");
    }
  };

  const run = async () => {
    if (!clientKey) {
      toast("No gateway key yet — create one under Settings → Keys");
      return;
    }
    if (!usedModel) {
      toast(`Add a ${info.label.toLowerCase()} model row first — the request needs a model id`);
      return;
    }
    setBusy(true);
    setResult(null);
    const t0 = Date.now();
    try {
      const res = await fetch(endpoint, {
        method: info.method,
        headers: { "content-type": "application/json", authorization: `Bearer ${clientKey}` },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let shown = text;
      try { shown = JSON.stringify(JSON.parse(text), null, 2); } catch { /* not JSON: audio, html, plain text */ }
      setResult({ status: res.status, ms: Date.now() - t0, body: shown });
    } catch (err) {
      setResult({ status: 0, ms: Date.now() - t0, body: String(err instanceof Error ? err.message : err) });
    } finally {
      setBusy(false);
    }
  };

  const masked = clientKey ? `${clientKey.slice(0, 8)}${"•".repeat(Math.min(24, Math.max(0, clientKey.length - 8)))}` : "— no key —";

  return (
    <Card padding="sm" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-text-main">Example</h3>
        <span className="max-w-md text-right text-[11px] text-text-muted">
          Runs through routy — the gateway key authenticates your call, this provider&apos;s own key
          authenticates upstream. <b>Run spends the provider&apos;s quota.</b>
        </span>
      </div>

      <div className="grid grid-cols-1 gap-2">
        <Row label="Endpoint">
          <Input value={endpoint} readOnly />
        </Row>
        <Row label="Gateway key">
          <Input value={masked} readOnly />
        </Row>
        <Row label="Provider key">
          <Input
            readOnly
            value={
              node.media?.noAuth === true
                ? "— none needed —"
                : node.keyMasked && node.keyMasked !== "—"
                  ? `${node.keyMasked} — sent upstream as this provider's credential`
                  : "no key added yet — add it under Keys below"
            }
          />
        </Row>

        {kind === "webFetch" && (
          <>
            <Row label="URL"><Input value={url} onChange={(e) => setUrl(e.target.value)} /></Row>
            <Row label="Format">
              <Select value={format} onChange={(e) => setFormat(e.target.value)} options={[
                { value: "markdown", label: "markdown" },
                { value: "text", label: "text" },
                { value: "html", label: "html" },
              ]} />
            </Row>
            <Row label="Max chars"><Input value={maxChars} onChange={(e) => setMaxChars(e.target.value)} /></Row>
          </>
        )}
        {kind === "webSearch" && (
          <>
            <Row label="Query"><Input value={query} onChange={(e) => setQuery(e.target.value)} /></Row>
            <Row label="Max results"><Input value={maxResults} onChange={(e) => setMaxResults(e.target.value)} /></Row>
          </>
        )}
        {(kind === "embedding" || kind === "tts") && (
          <Row label={kind === "tts" ? "Text to speak" : "Input"}>
            <Input value={input} onChange={(e) => setInput(e.target.value)} />
          </Row>
        )}
        {kind === "image" && (
          <Row label="Prompt"><Input value={prompt} onChange={(e) => setPrompt(e.target.value)} /></Row>
        )}
        {kind === "llm" && (
          <>
            <Row label="Message">
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={3}
                className="w-full rounded border border-border-subtle bg-background px-3 py-2 font-mono text-sm text-text-main focus:outline-none focus:border-accent"
              />
            </Row>
            <Row label="Max tokens"><Input value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} /></Row>
          </>
        )}
        {info.modelList !== "none" && (
          <Row label="Model">
            <Input
              value={usedModel}
              placeholder={modelRows.length ? defaultModel : `a ${info.label} model row (none yet)`}
              onChange={(e) => setModel(e.target.value)}
            />
          </Row>
        )}
      </div>

      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Request</span>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={copyCurl}>Copy</Button>
          <Button size="sm" variant="primary" loading={busy} onClick={run}>Run</Button>
        </div>
      </div>
      <pre className="overflow-x-auto rounded border border-border-subtle bg-sidebar p-3 font-mono text-[11px] leading-relaxed text-text-main">{curl}</pre>

      <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Response</div>
      {result ? (
        <>
          <div className="font-mono text-[11px] text-text-muted">
            {result.status === 0 ? "request failed" : `HTTP ${result.status}`} · {result.ms}ms
          </div>
          <pre className="max-h-72 overflow-auto rounded border border-border-subtle bg-sidebar p-3 font-mono text-[11px] leading-relaxed text-text-main">{result.body}</pre>
        </>
      ) : (
        <pre className="rounded border border-dashed border-border-subtle bg-sidebar p-3 font-mono text-[11px] text-text-subtle">
          {"{ … }"} — press Run to send it
        </pre>
      )}
    </Card>
  );
}

/** One labelled field row, matching the reference layout: label left, control right. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[110px_1fr]">
      <span className="text-xs text-text-muted">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
