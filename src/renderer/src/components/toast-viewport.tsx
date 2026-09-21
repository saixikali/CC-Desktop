import { CheckCircle2, Info, X, TriangleAlert } from "lucide-react";
import { useToastStore, type ToastKind } from "../store/toast.ts";
import { cn } from "../lib/cn.ts";

const ICONS: Record<ToastKind, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  error: TriangleAlert,
};

const TONE: Record<ToastKind, string> = {
  info: "text-text-muted",
  success: "text-success",
  error: "text-danger",
};

export function ToastViewport() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
      {toasts.map((t) => {
        const Icon = ICONS[t.kind];
        return (
          <div
            key={t.id}
            className="pointer-events-auto flex items-start gap-2.5 rounded-lg border border-border bg-surface-2/95 px-3.5 py-3 shadow-lg shadow-shadow backdrop-blur"
          >
            <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", TONE[t.kind])} strokeWidth={1.8} />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium leading-5">{t.title}</p>
              {t.description && (
                <p className="mt-0.5 select-text break-words text-xs leading-relaxed text-text-muted">
                  {t.description}
                </p>
              )}
            </div>
            <button
              className="text-text-faint hover:text-text"
              onClick={() => dismiss(t.id)}
              aria-label="关闭通知"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
