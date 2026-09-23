import type { NodeStatus } from "../api/types";

/**
 * Single source for how a node status reads across Overview, Upstreams and any
 * future surface: badge variant + label + dot tone. Label is always present —
 * color never carries the state alone.
 */
export const statusMeta: Record<
  NodeStatus,
  { badge: "success" | "warning" | "error" | "default"; label: string; dot: "green" | "yellow" | "red" | "gray" }
> = {
  healthy: { badge: "success", label: "healthy", dot: "green" },
  degraded: { badge: "warning", label: "degraded", dot: "yellow" },
  down: { badge: "error", label: "breaker open", dot: "red" },
  disabled: { badge: "default", label: "disabled", dot: "gray" },
};
