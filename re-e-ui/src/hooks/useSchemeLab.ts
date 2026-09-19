import { useCallback, useEffect, useState } from "react";

/**
 * Theme Lab → live preview.
 *
 * The catalogue normally scopes a scheme to its own panel (`.scheme-x .mini-card`).
 * Applying the class to `<html>` makes the same token overrides cascade through the
 * whole app, so a genre can be judged on real density — tables, row actions, the
 * console — not just on a two-card preview. Preview-only texture rules keyed to
 * `.mini-app` simply do not fire, which is the intended split.
 */
const STORAGE_KEY = "re-e.lab-scheme";
const listeners = new Set<(scheme: string | null) => void>();

let current: string | null = null;

function stored(): string | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value && /^scheme-[a-z-]+$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** Idempotent; safe before React mounts. Returns the scheme now active. */
export function initLabScheme(): string | null {
  if (!current) current = stored();
  if (current) document.documentElement.classList.add(current);
  return current;
}

export function setLabScheme(scheme: string | null): void {
  if (current) document.documentElement.classList.remove(current);
  current = scheme;
  if (scheme) document.documentElement.classList.add(scheme);
  try {
    if (scheme) localStorage.setItem(STORAGE_KEY, scheme);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* private mode: the preview just will not persist */
  }
  for (const fn of listeners) fn(scheme);
}

export function useLabScheme() {
  const [scheme, setScheme] = useState<string | null>(current);

  useEffect(() => {
    const fn = (value: string | null) => setScheme(value);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);

  const toggle = useCallback((candidate: string) => {
    setLabScheme(current === candidate ? null : candidate);
  }, []);

  return { scheme, toggle, clear: () => setLabScheme(null) };
}
