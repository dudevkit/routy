import type { ReactNode } from "react";
import { Card } from "./Card";

export function EmptyState({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <Card className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <p className="text-14 text-gray-700">{message}</p>
      {action}
    </Card>
  );
}
