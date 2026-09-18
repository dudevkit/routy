import type { CSSProperties } from "react";
import { Card } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { StatusDot } from "../components/ui/StatusDot";

/**
 * Sparkline with an 8% accent area fill (decoration patch D5.3):
 * reads as volume, not just a line.
 */
function Sparkline({ data, w = 132, h = 36 }: { data: number[]; w?: number; h?: number }) {
  const max = Math.max(...data);
  const min = Math.min(...data);
  const xy = (v: number, i: number) => `${(i / (data.length - 1)) * w},${h - ((v - min) / (max - min || 1)) * (h - 6) - 3}`;
  const pts = data.map(xy).join(" ");
  const area = `0,${h} ${pts} ${w},${h}`;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0" aria-hidden="true">
      <polygon points={area} fill="var(--color-primary)" opacity="0.08" />
      <polyline
        points={pts}
        fill="none"
        stroke="var(--color-primary)"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity="0.9"
      />
    </svg>
  );
}

const latency = [420, 380, 355, 402, 348, 330, 372, 341, 318, 335, 302, 310];

/**
 * One genre rendered on real components. `schemeClass` overrides the semantic
 * vars (and, for some genres, adds texture via scoped CSS in index.css).
 * Panels without a class render the base theme (Graphite Pro).
 */
function CatalogPanel({
  id,
  schemeClass,
  name,
  tagline,
  texture,
}: {
  id: string;
  schemeClass?: string;
  name: string;
  tagline: string;
  texture: string;
}) {
  return (
    <section id={id} className="flex scroll-mt-4 flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-1">
        <h2 className="text-base font-semibold text-text-main">{name}</h2>
        <span className="text-xs text-text-muted">{tagline}</span>
      </div>

      <div
        className={`mini-app relative overflow-hidden rounded-[14px] border border-border-subtle bg-bg p-4 ${schemeClass ?? ""}`}
      >
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <Card padding="sm" className="mini-card">
            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-xs text-text-muted">TTFT · p50</span>
                <span className="font-display text-xl font-semibold tracking-tight tabular">380ms</span>
                <span className="text-[10px] text-text-subtle">last 12 requests</span>
              </div>
              <Sparkline data={latency} />
            </div>
          </Card>

          <Card padding="sm" className="mini-card flex flex-col gap-2.5">
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

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm">Primary</Button>
          <Button variant="secondary" size="sm">Secondary</Button>
          <Button variant="outline" size="sm">Outline</Button>
          <Button variant="ghost" size="sm">Ghost</Button>
          <Button variant="danger" size="sm">Danger</Button>
          <Badge variant="success" dot size="sm">healthy</Badge>
          <Badge variant="warning" dot size="sm">degraded</Badge>
          <Badge variant="error" dot size="sm">breaker open</Badge>
          <Badge variant="default" size="sm">disabled</Badge>
        </div>

        <div className="mt-3 truncate font-mono text-xs text-text-muted">
          req_9f2c81ab · https://openrouter.ai/api/v1 · sk-or-v1-88f2…9f2c · TTFT 380ms
        </div>
      </div>

      <p className="px-1 text-xs text-text-subtle">{texture}</p>
    </section>
  );
}

const catalog = [
  {
    id: "graphite",
    schemeClass: undefined,
    name: "A · Graphite Pro",
    tagline: "default — cool charcoal · electric blue · the Linear/Vercel school",
    texture:
      "Hairline borders, zero decoration — restraint is the texture. Status hues stay maximally separated from the accent.",
  },
  {
    id: "blueprint",
    schemeClass: "scheme-blueprint",
    name: "B · Blueprint Schematic",
    tagline: "ink blue · drafting grid · circuit identity",
    texture:
      "Graph-paper grid behind the cards, cyan ink accent. The gateway drawn as the circuit diagram it literally is.",
  },
  {
    id: "phosphor",
    schemeClass: "scheme-phosphor",
    name: "C · Phosphor Console",
    tagline: "CRT green-tint · mono-first · mission control",
    texture:
      "Scanline overlay (2.5% white), mono carries the UI, glow-ready live dots. Watch the accent/success-green proximity.",
  },
  {
    id: "ember",
    schemeClass: "scheme-ember",
    name: "D · Warm Ember",
    tagline: "upstream heritage · coral · Claude-like warmth",
    texture:
      "Warm neutral surfaces, humanist coral accent, softer chrome. Friendly; coral sits near danger-red.",
  },
  {
    id: "nord",
    schemeClass: "scheme-nord",
    name: "E · Nord Arctic",
    tagline: "frost blue-gray · desaturated · long-session comfort",
    texture:
      "Muted frost palette, low-contrast calm. The most comfortable over hours; the least exciting at first glance.",
  },
  {
    id: "swiss",
    schemeClass: "scheme-swiss",
    name: "F · Swiss Mono Press",
    tagline: "print logic · black/white/red · flat rules",
    texture:
      "Hard 2px rules, square corners, no shadows, red as the only accent. Status leans on dots + labels, not color range.",
  },
  {
    id: "aurora",
    schemeClass: "scheme-aurora",
    name: "G · Aurora Glass",
    tagline: "vibrancy panels over slow aurora gradients",
    texture:
      "Translucent blur cards over gradient glow. Gorgeous for chrome (sidebar/modals); a legibility tax on dense tables.",
  },
];

function MonoRow({
  label,
  note,
  className,
  style,
}: {
  label: string;
  note?: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div className="flex items-center gap-4 border-b border-border-subtle py-2.5 last:border-0">
      <span className="w-44 shrink-0 text-xs text-text-muted">
        {label}
        {note && <span className="text-text-subtle"> · {note}</span>}
      </span>
      <code className={`min-w-0 truncate text-[13px] text-text-main ${className ?? "font-mono"}`} style={style}>
        req_9f2c81ab · https://openrouter.ai/api/v1 · sk-or-v1-88f2…9f2c · 0O1lI · -&gt; == · TTFT 380ms
      </code>
    </div>
  );
}

export function ThemeSampler() {
  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold text-text-main">Theme Catalog</h1>
        <p className="text-xs text-text-muted">
          Seven genre candidates on the approved shell — same components, same blocking; only tokens + texture change.
          Base theme = Graphite Pro. Jump:{" "}
          {catalog.map((c, i) => (
            <span key={c.id}>
              {i > 0 && " · "}
              <a href={`#${c.id}`} className="text-text-muted underline decoration-border-subtle underline-offset-2 hover:text-primary">
                {c.id}
              </a>
            </span>
          ))}
        </p>
      </div>

      {catalog.map((c) => (
        <CatalogPanel key={c.id} {...c} />
      ))}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-text-main">Data fonts — adopted stack</h2>
        <Card padding="sm">
          <MonoRow label="IBM Plex Mono" note="default" />
          <MonoRow label="JetBrains Mono" className="mono-jb" note="candidate" />
          <MonoRow
            label="System mono"
            style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" }}
            note="fallback"
          />
        </Card>
        <p className="text-xs text-text-muted">
          UI font: <span className="text-text-main">IBM Plex Sans</span> · stat numerals + wordmark:{" "}
          <span className="text-text-main">Space Grotesk</span>. Ligatures stay off for keys/URLs —{" "}
          <code className="font-mono text-text-main">-&gt;</code> and <code className="font-mono text-text-main">==</code>{" "}
          inside tokens must never render as glyphs.
        </p>
      </section>
    </div>
  );
}
