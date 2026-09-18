import type { ComponentProps } from "react";
import {
  ArrowsClockwise,
  Broadcast,
  ChartBar,
  Check,
  CheckCircle,
  Coins,
  Copy,
  Gear,
  Info,
  Moon,
  Network,
  Palette,
  Plus,
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

/**
 * Common Phosphor icon props. Sized to 16–18px by default across the app:
 * nav 18px (regular ↔ fill on active), buttons 16px, badges 13px, indicators 14px.
 */
export interface IconProps extends ComponentProps<typeof SquaresFour> {
  size?: number;
  weight?: "thin" | "light" | "regular" | "bold" | "fill" | "duotone";
}

/** Standalone spinner — SVG ring, no icon font / glyph baggage. */
export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className={cn("animate-spin shrink-0", className)}
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeOpacity="0.25" />
      <path
        d="M8 2a6 6 0 0 1 6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export {
  ArrowsClockwise,
  Broadcast,
  ChartBar,
  Check,
  CheckCircle,
  Coins,
  Copy,
  Gear,
  Info,
  Moon,
  Network,
  Palette,
  Plus,
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
};
