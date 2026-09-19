import { useCallback, useEffect, useState } from "react";

/**
 * Theme Lab → live preview.
 *
 * The catalogue normally scopes a scheme to its own panel (`.scheme-x .mini-card`).
 * Applying the class to `<html>` makes the same token overrides cascade through the
 * whole app, so a genre can be judged on real density — tables, row actions, the
 * console — not just on a two-card preview. Preview-only texture rules keyed to
 * `.mini-app` simply do not fire, which is the intended split.
 *
 * `variant` is the second axis: Neuphorism ships several *raised* geometries and the
 * right one can only be picked by wearing each across real screens, so the choice is
 * stored and applied as `data-neu` on the same element that carries the scheme.
 */
const SCHEME_KEY = "re-e.lab-scheme";
const VARIANT_KEY = "re-e.lab-neu";
const VARIANTS = ["a", "b", "c", "d"] as const;

export type NeuVariant = (typeof VARIANTS)[number];

export interface LabState {
  scheme: string | null;
  variant: NeuVariant | null;
}

const listeners = new Set<(state: LabState) => void>();

let current: LabState = { scheme: null, variant: null };

function stored(): LabState {
  try {
    const scheme = localStorage.getItem(SCHEME_KEY);
    const variant = localStorage.getItem(VARIANT_KEY);
    return {
      scheme: scheme && /^scheme-[a-z-]+$/.test(scheme) ? scheme : null,
      variant: (VARIANTS as readonly string[]).includes(variant ?? "") ? (variant as NeuVariant) : null,
    };
  } catch {
    return { scheme: null, variant: null };
  }
}

let painted: string | null = null;

function paint() {
  const root = document.documentElement;
  if (painted && painted !== current.scheme) root.classList.remove(painted);
  if (current.scheme) root.classList.add(current.scheme);
  painted = current.scheme;
  /* the variant only means something inside the neo skin */
  if (current.scheme === "scheme-neo" && current.variant) root.dataset.neu = current.variant;
  else root.removeAttribute("data-neu");
}

function persist() {
  try {
    if (current.scheme) localStorage.setItem(SCHEME_KEY, current.scheme);
    else localStorage.removeItem(SCHEME_KEY);
    if (current.variant) localStorage.setItem(VARIANT_KEY, current.variant);
    else localStorage.removeItem(VARIANT_KEY);
  } catch {
    /* private mode: the preview just will not persist */
  }
}

function publish() {
  paint();
  persist();
  for (const fn of listeners) fn({ ...current });
}

/** Idempotent, safe before React mounts. Returns the state now active. */
export function initLabScheme(): LabState {
  if (!current.scheme && !current.variant) current = stored();
  paint();
  return { ...current };
}

export function setLabScheme(scheme: string | null): void {
  current = { scheme, variant: scheme === "scheme-neo" ? current.variant : null };
  publish();
}

export function setLabVariant(variant: NeuVariant | null): void {
  current = { ...current, variant };
  publish();
}

export function useLabScheme() {
  const [state, setState] = useState<LabState>(current);

  useEffect(() => {
    const fn = (next: LabState) => setState(next);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);

  const toggleScheme = useCallback((candidate: string) => {
    setLabScheme(current.scheme === candidate ? null : candidate);
  }, []);

  return { ...state, toggleScheme, setVariant: setLabVariant, clear: () => setLabScheme(null) };
}
