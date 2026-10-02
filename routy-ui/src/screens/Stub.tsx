import { Link, useLocation } from "react-router-dom";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { XCircle } from "../components/icons";

export function Stub() {
  const { pathname } = useLocation();
  const label = pathname.replace(/^\//, "").replace(/-/g, " ") || "unknown";
  return (
    <Card className="flex flex-col items-center justify-center gap-3 py-20 text-center">
      <XCircle size={40} className="text-text-subtle" />
      <h2 className="text-base font-semibold text-text-main">Page not found</h2>
      <p className="text-sm text-text-muted">
        The path <code className="font-mono text-xs text-text-main">/{label}</code> does not exist on this gateway.
      </p>
      <Link to="/" className="mt-2">
        <Button variant="primary" size="sm">
          Return to Overview
        </Button>
      </Link>
    </Card>
  );
}
