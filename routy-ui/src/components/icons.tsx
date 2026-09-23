import type { ComponentProps } from "react";
import {
  ArrowsClockwise,
  ArrowCircleUp,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Broadcast,
  CaretRight,
  ChartBar,
  Check,
  CheckSquare,
  CheckCircle,
  Coins,
  Copy,
  DownloadSimple,
  Gauge,
  Gear,
  Info,
  Key,
  List,
  Moon,
  Network,
  Palette,
  PencilSimple,
  Plus,
  Prohibit,
  ShareNetwork,
  SquaresFour,
  Stack,
  Sun,
  TerminalWindow,
  Trash,
  Warning,
  WifiHigh,
  Wrench,
  X,
  XCircle,
} from "@phosphor-icons/react";
import { cn } from "../utils/cn";

export type IconComponent = typeof SquaresFour;

/** Standalone spinner — SVG ring, no icon font or glyph baggage. */
export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className={cn("shrink-0 animate-spin", className)}
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeOpacity="0.25" />
      <path d="M8 2a6 6 0 0 1 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** Phosphor props we actually vary across the app. */
export interface PhosphorProps extends ComponentProps<typeof SquaresFour> {
  size?: number;
  weight?: "thin" | "light" | "regular" | "bold" | "fill" | "duotone";
}

export {
  ArrowsClockwise,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Broadcast,
  CaretRight,
  ChartBar,
  Check,
  CheckSquare,
  CheckCircle,
  Coins,
  Copy,
  DownloadSimple,
  Gauge,
  Gear,
  Info,
  Key,
  List,
  Moon,
  Network,
  Palette,
  PencilSimple,
  Plus,
  Prohibit,
  ShareNetwork,
  SquaresFour,
  Stack,
  Sun,
  TerminalWindow,
  Trash,
  Warning,
  WifiHigh,
  Wrench,
  X,
  XCircle,
  ArrowCircleUp,
};
