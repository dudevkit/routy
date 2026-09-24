import { useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "../utils/clipboard";

export type CopyState = "idle" | "ok" | "fail";

/**
 * Copy-to-clipboard with an honest outcome, shared by every copy affordance (endpoint
 * chip, API-key chip, table-row button).
 *
 * Each of those used to assume success: fire `navigator.clipboard?.writeText`, swallow
 * the error, show the tick. On the plain-HTTP LAN address this dashboard is actually used
 * from, the clipboard API is unavailable, so the tick confirmed a copy that never
 * happened and the paste came back empty. "fail" is now a real state the UI can render.
 */
export function useCopy(): { state: CopyState; copy: (value: string) => Promise<void> } {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = useCallback(async (value: string) => {
    setState((await copyText(value)) ? "ok" : "fail");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 1800);
  }, []);

  return { state, copy };
}

/**
 * Hint shown when the browser refused both clipboard paths. Selection is the only way
 * left, which is why the value spans carry `selectable` (index.css) — the global
 * `button { user-select: none }` rule would otherwise make them unselectable.
 */
export const COPY_FAILED_HINT = "Copy blocked by the browser — press and hold the value to select it";
