import { useCallback, useState } from "react";

/** Dark-first: routy's primary target, and the fallback when nothing is stored. */
function storedIsDark(): boolean {
  try {
    const stored = localStorage.getItem("theme");
    return stored ? stored === "dark" : true;
  } catch {
    return true;
  }
}

/**
 * Applied at module load, before the first paint: toggling `.dark` from an effect
 * makes first load render light-then-dark, and any measurement taken across that
 * flip sees tokens from one palette on another's canvas. Same contract as
 * `initLabScheme`.
 */
export function initTheme(): boolean {
  const isDark = storedIsDark();
  document.documentElement.classList.toggle("dark", isDark);
  return isDark;
}

export function useTheme() {
  const [isDark, setIsDark] = useState(storedIsDark);

  const toggleTheme = useCallback(() => {
    /* read the DOM, not state: several components own a toggle and the class is the truth */
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("theme", next ? "dark" : "light");
    } catch {
      /* private mode: this load just will not persist */
    }
    setIsDark(next);
  }, []);

  return { isDark, toggleTheme };
}
