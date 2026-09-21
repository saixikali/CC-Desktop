import type { ReactNode } from "react";
import { Inbox, TriangleAlert } from "lucide-react";
import { Button } from "./button.tsx";

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: { label: string; onClick: () => void };
}

export function EmptyState({ icon, title, hint, action }: EmptyStateProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 py-12 text-center">
      <div className="mb-1 flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-surface-2 text-text-faint">
        {icon ?? <Inbox className="h-5 w-5" strokeWidth={1.6} />}
      </div>
      <p className="text-[13px] font-medium text-text-muted">{title}</p>
      {hint && <p className="max-w-xs text-xs leading-relaxed text-text-faint">{hint}</p>}
      {action && (
        <Button size="sm" variant="secondary" className="mt-2" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}

interface ErrorStateProps {
  message?: string;
  onRetry?: () => void;
  retryLabel?: string;
}

export function ErrorState({ message, onRetry, retryLabel = "重试" }: ErrorStateProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 py-12 text-center">
      <TriangleAlert className="h-6 w-6 text-danger" strokeWidth={1.6} />
      <p className="text-[13px] font-medium text-text-muted">{message ?? "加载失败"}</p>
      {onRetry && (
        <Button size="sm" variant="secondary" className="mt-1" onClick={onRetry}>
          {retryLabel}
        </Button>
      )}
    </div>
  );
}
