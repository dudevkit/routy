import { Card } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { StatusDot } from "../components/ui/StatusDot";

/** Tiny inline latency sparkline — no chart dep needed for 0-click health reads. */
function Sparkline({ data, w = 132, h = 36 }: { data: number[]; w?: number; h?: number }) {
  const max = Math.max(...data);
  const min = Math.min(...data);
  const pts = data
    .map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / (max - min || 1)) * (h - 6) - 3}`)
    .join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0" aria-hidden="true">
      <polyline points={pts} fill="none" stroke="var(--color-primary)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" opacity="0.9" />
    </svg>
  );
}

const latency = [420, 380, 355, 402, 348, 330, 372, 341, 318, 335, 302, 310];

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-5 items-center rounded-[6px] border border-border bg-surface-2 px-1.5 font-mono text-[10px] text-text-muted">
      {children}
    </kbd>
  );
}

/** One candidate scheme rendered on real components. */
function SchemePanel({
  schemeClass,
  name,
  tagline,
  recommended = false,
}: {
  schemeClass?: string;
  name: string;
  tagline: string;
  recommended?: boolean;
}) {
  return (
    <div className={schemeClass}>
      <div className="mb-3 flex items-center gap-2 px-1">
        <h2 className="text-base font-semibold text-text-main">{name}</h2>
        {recommended && <Badge variant="primary">recommended</Badge>}
        <span className="text-xs text-text-muted">{tagline}</span>
      </div>

      {/* Mini app surface — real components under this scheme's vars */}
      <div className="rounded-[14px] border border-border-subtle bg-bg p-4">
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {/* stat + sparkline */}
          <Card padding="sm">
            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-xs text-text-muted">TTFT · p50</span>
                <span className="font-mono text-xl font-semibold tabular">380ms</span>
                <span className="text-[10px] text-text-subtle">last 12 requests</span>
              </div>
              <Sparkline data={latency} />
            </div>
          </Card>

          {/* node card */}
          <Card padding="sm" className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <StatusDot tone="green" />
                <span className="truncate text-sm font-semibold text-text-main">OpenRouter Main</span>
                <Badge variant="success" dot size="sm">healthy</Badge>
              </div>
              <Button size="sm" variant="secondary">Test</Button>
            </div>
            <div className="truncate font-mono text-xs text-text-muted">https://openrouter.ai/api/v1</div>
            <div className="flex items-center gap-4 text-xs text-text-muted">
              <span className="font-mono tabular">42ms</span>
              <span className="tabular">38 models</span>
              <span className="font-mono">prefix or/</span>
              <span className="ml-auto font-mono">sk-or-…9f2c</span>
            </div>
          </Card>
        </div>

        {/* controls row */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm">Primary</Button>
          <Button variant="secondary" size="sm">Secondary</Button>
          <Button variant="outline" size="sm">Outline</Button>
          <Button variant="ghost" size="sm">Ghost</Button>
          <Button variant="danger" size="sm">Danger</Button>
          <Badge variant="success" dot size="sm">healthy</Badge>
          <Badge variant="error" dot size="sm">breaker open</Badge>
          <Badge variant="default" size="sm">disabled</Badge>
        </div>
      </div>
    </div>
  );
}

function MonoRow({ fontClass, label }: { fontClass?: string; label: string }) {
  return (
    <div className="flex items-center gap-4 border-b border-border-subtle py-2.5 last:border-0">
      <span className="w-28 shrink-0 text-xs text-text-muted">{label}</span>
      <code className={`min-w-0 truncate text-[13px] text-text-main ${fontClass ?? "font-mono"}`}>
        req_9f2c81ab · https://openrouter.ai/api/v1 · sk-or-v1-88f2…9f2c · TTFT 380ms
      </code>
    </div>
  );
}

export function ThemeSampler() {
  return (
    <div className="flex flex-col gap-10">
      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-text-main">Color scheme candidates</h2>
        <SchemePanel schemeClass="scheme-graphite" name="A · Graphite × Electric Blue" tagline="cool neutral · blue accent" recommended />
        <SchemePanel name="B · Warm Ember" tagline="upstream heritage · coral accent" />
        <SchemePanel schemeClass="scheme-phosphor" name="C · Phosphor" tagline="teal surfaces · mint accent" />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-text-main">Data font candidates</h2>
        <Card padding="sm">
          <MonoRow label="JetBrains Mono" fontClass="mono-jb" />
          <MonoRow label="IBM Plex Mono" fontClass="mono-plex" />
          <MonoRow label="System mono" />
        </Card>
        <p className="text-xs text-text-muted">
          Ligatures stay off for keys and URLs — <code className="font-mono text-text-main">-&gt;</code> and{" "}
          <code className="font-mono text-text-main">==</code> inside tokens must never render as glyphs.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-text-main">Extras under consideration</h2>
        <Card padding="sm" className="flex flex-col gap-3">
          <div className="flex items-center gap-2 text-xs text-text-muted">
            Command palette <Kbd>⌘</Kbd> <Kbd>K</Kbd> · table nav <Kbd>J</Kbd><Kbd>K</Kbd> · open request <Kbd>↵</Kbd>
          </div>
          <div className="flex items-center gap-3 text-xs text-text-muted">
            Skeleton loading:
            <div className="h-4 w-40 animate-pulse rounded-[6px] bg-surface-2" />
            <div className="h-4 w-24 animate-pulse rounded-[6px] bg-surface-2" />
          </div>
          <div className="flex items-center gap-2 text-xs text-text-muted">
            Density: comfortable rows (40px) vs dense rows (32px) — persisted per user
            <span className="rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted">v1.1</span>
          </div>
        </Card>
      </section>
    </div>
  );
}
