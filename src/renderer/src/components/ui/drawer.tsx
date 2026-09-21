import type { ReactNode } from "react";
import { cn } from "../../lib/cn.ts";

interface DrawerProps {
  open: boolean;
  side?: "right" | "left";
  width?: number;
  children: ReactNode;
  className?: string;
}

/** 侧滑抽屉（审批队列、终端面板等）。 */
export function Drawer({ open, side = "right", width = 380, children, className }: DrawerProps) {
  return (
    <div
      className={cn(
        "h-full shrink-0 overflow-hidden border-border transition-[width] duration-200 ease-out",
        side === "right" ? "border-l" : "border-r",
        open ? "w-[var(--drawer-w)]" : "w-0",
        className,
      )}
      style={{ ["--drawer-w" as string]: `${width}px` }}
    >
      <div style={{ width }} className="h-full bg-surface">
        {children}
      </div>
    </div>
  );
}
