import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn.ts";

/** 轻量滚动容器：沿用全局 webkit 滚动条样式，避免引入 radix 依赖。 */
export function ScrollArea({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("overflow-y-auto overflow-x-hidden", className)} {...rest}>
      {children}
    </div>
  );
}
