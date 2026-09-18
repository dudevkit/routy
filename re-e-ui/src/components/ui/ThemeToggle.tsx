import { useTheme } from "../../hooks/useTheme";
import { Moon, Sun } from "../icons";
import { cn } from "../../utils/cn";

export function ThemeToggle({ className, variant = "default" }: { className?: string; variant?: "default" | "card" }) {
  const { isDark, toggleTheme } = useTheme();

  const variants = {
    default: cn(
      "flex items-center justify-center size-9 rounded-[10px]",
      "text-text-muted hover:text-text-main",
      "hover:bg-surface-2 transition-colors",
    ),
    card: cn(
      "flex items-center justify-center size-11 rounded-full",
      "bg-surface/60 hover:bg-surface",
      "border border-border",
      "backdrop-blur-md shadow-sm hover:shadow-[var(--shadow-warm)]",
      "text-text-muted hover:text-primary",
      "transition-all group",
    ),
  };

  return (
    <button
      onClick={toggleTheme}
      className={cn(variants[variant], className)}
      aria-label={`Switch to ${isDark ? "light" : "dark"} mode`}
      title={`Switch to ${isDark ? "light" : "dark"} mode`}
    >
      {isDark ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}
