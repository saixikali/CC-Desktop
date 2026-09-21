import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "../../lib/cn.ts";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "dangerSoft";
type Size = "sm" | "md" | "icon";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-accent text-on-accent transition-[filter] hover:brightness-110 active:brightness-95 disabled:bg-accent/40",
  secondary:
    "border border-border bg-surface-2 text-text hover:bg-surface-3 disabled:opacity-50",
  ghost: "text-text-muted hover:bg-hover hover:text-text disabled:opacity-40",
  danger: "bg-danger text-on-accent transition-[filter] hover:brightness-110 disabled:opacity-50",
  dangerSoft:
    "border border-danger/30 bg-danger/10 text-danger hover:bg-danger/20 disabled:opacity-50",
};

const SIZES: Record<Size, string> = {
  sm: "h-7 gap-1.5 rounded-md px-2.5 text-xs",
  md: "h-9 gap-2 rounded-lg px-3.5 text-[13px]",
  icon: "h-8 w-8 rounded-md justify-center",
};

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex select-none items-center justify-center font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
        "disabled:cursor-not-allowed",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : icon}
      {children}
    </button>
  );
}
