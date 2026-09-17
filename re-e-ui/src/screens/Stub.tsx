import { useLocation } from "react-router-dom";
import { Card } from "../components/ui/Card";

export function Stub() {
  const { pathname } = useLocation();
  const label = pathname.replace(/^\//, "").replace(/-/g, " ") || "Overview";
  return (
    <Card className="flex flex-col items-center justify-center gap-3 py-20 text-center">
      <span className="material-symbols-outlined text-[40px] text-text-subtle">construction</span>
      <p className="text-sm text-text-muted">This screen isn't part of the preview slice yet.</p>
      <p className="text-xs text-text-muted">Overview covers the core flow — add an upstream and watch health.</p>
      <span className="text-[10px] uppercase tracking-wider text-text-subtle">{label}</span>
    </Card>
  );
}
