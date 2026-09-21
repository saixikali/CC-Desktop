import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "../../lib/cn.ts";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  className?: string;
}

export function Dialog({ open, onClose, title, children, footer, width = 480, className }: DialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ width }}
        className={cn(
          "flex max-h-[85vh] flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl shadow-shadow",
          className,
        )}
      >
        {title && (
          <header className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4">
            <h2 className="text-[13px] font-semibold">{title}</h2>
            <button
              className="flex h-6 w-6 items-center justify-center rounded-md text-text-faint hover:bg-hover hover:text-text"
              onClick={onClose}
              aria-label="关闭对话框"
            >
              <X className="h-4 w-4" />
            </button>
          </header>
        )}
        <div className="flex-1 overflow-y-auto px-4 py-3">{children}</div>
        {footer && (
          <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-surface-2 px-4 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}
