import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useHistory, useSettings, usePutSettings } from "../api/hooks";
import { toastApiError } from "../utils/errors";
import { fmtTokens } from "../utils/format";
import { Gauge, TerminalWindow } from "../components/icons";
import { Card } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Skeleton } from "../components/ui/Skeleton";
import { Toggle } from "../components/ui/Toggle";
import { useToast } from "../components/ui/Toast";

/**
 * RTK is the one token-saver kept in v1 (headroom/caveman/ponytail were dropped).
 * The gateway exposes a single master switch — there is no per-filter config API
 * yet, so the filter inventory is described, not faked. A contract request for
 * GET /api/rtk/filters is filed in contract-requests.md.
 */
export function TokenSaver() {
  const toast = useToast();
  const navigate = useNavigate();
  const settings = useSettings();
  const put = usePutSettings();
  const history = useHistory({ limit: 1000 });

  const rtkEnabled = settings.data ? settings.data.rtkEnabled !== false : true;
  const promptTokens = useMemo(() => (history.data ?? []).reduce((sum, r) => sum + (r.prompt_tokens ?? 0), 0), [history.data]);

  const setEnabled = (enabled: boolean) =>
    put.mutate({ rtkEnabled: enabled }, { onError: (err) => toastApiError(toast, err, "Failed to save setting") });

  return (
    <div className="flex flex-col gap-4">
      <Card padding="sm" className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Gauge size={16} className="text-text-muted" />
          <h3 className="text-sm font-semibold text-text-main">RTK — tool-output compression</h3>
          {!settings.isLoading && (
            <Badge variant={rtkEnabled ? "success" : "default"} size="sm" dot>
              {rtkEnabled ? "on" : "off"}
            </Badge>
          )}
        </div>

        <Toggle
          label="Compress tool outputs before they reach the model"
          hint="Applied in the request path before translation. Shell-style outputs (git diff, grep, ls, tree, logs…) are rewritten into denser forms."
          checked={rtkEnabled}
          loading={put.isPending}
          onChange={setEnabled}
        />

        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-[10px] border border-border-subtle bg-bg px-3 py-2.5">
            <div className="text-text-muted">Prompt tokens · last 1000 requests</div>
            <div className="font-display text-lg font-semibold tabular">
              {history.isLoading ? <Skeleton rows={1} className="mt-1" /> : fmtTokens(promptTokens)}
            </div>
          </div>
          <div className="rounded-[10px] border border-border-subtle bg-bg px-3 py-2.5">
            <div className="text-text-muted">Savings are visible as</div>
            <div className="text-text-main">lower prompt-token counts per request</div>
          </div>
        </div>

        <p className="text-[11px] text-text-subtle">
          Compression decisions are logged under the <span className="font-mono text-text-main">RTK</span> tag — open
          the console filtered to that tag to see what was rewritten and by how much.
        </p>

        <div>
          <Button variant="secondary" size="sm" icon={<TerminalWindow size={13} />} onClick={() => navigate("/console")}>
            Open Live Console
          </Button>
        </div>
      </Card>

      <Card padding="sm" className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-text-main">Not in this screen</h3>
        <ul className="flex flex-col gap-1 text-xs text-text-muted">
          <li>· Per-filter on/off and thresholds — no backend surface yet (contract request filed).</li>
          <li>· headroom / caveman / ponytail savers — dropped from RE-E v1 scope.</li>
          <li>· pxpipe — deferred; its screen stays out until the backend lands.</li>
        </ul>
      </Card>
    </div>
  );
}
