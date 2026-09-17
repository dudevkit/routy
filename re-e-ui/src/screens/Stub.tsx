import { useLocation } from "react-router-dom";
import { Card } from "../components/ui/Card";

export function Stub() {
  const { pathname } = useLocation();
  const label = pathname.replace(/^\//, "").replace(/-/g, " ") || "Overview";
  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-6 px-6 py-6">
      <h1 className="text-24 font-semibold capitalize">{label}</h1>
      <Card className="flex flex-col items-center gap-2 px-6 py-16 text-center">
        <p className="text-14 text-gray-700">This screen isn't part of the preview slice yet.</p>
        <p className="text-13 text-gray-600">
          Overview covers the core flow — add an upstream and watch health.
        </p>
      </Card>
    </div>
  );
}
