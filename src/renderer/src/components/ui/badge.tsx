import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn.ts";

type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

const TONES: Record<Tone, string> = {
  neutral: "border-border bg-surface-2 text-text-muted",
  accent: "border-accent/30 bg-accent-soft text-accent",
  success: "border-success/30 bg-success/10 text-success",
  warning: "border-warning/30 bg-warning/10 text-warning",
  danger: "border-danger/30 bg-danger/10 text-danger",
};

export function Badge({
  tone = "neutral",
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex select-none items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
        TONES[tone],
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}
