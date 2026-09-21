import { useEffect, useState } from "react";
import { Minus, Square, X } from "lucide-react";
import { bridge, call, onEvent } from "../lib/ipc.ts";
import { EVENTS } from "../../../shared/ipc/channels.ts";
import { t } from "../i18n/zh.ts";
import { useBackendStore } from "../store/backend.ts";
import { cn } from "../lib/cn.ts";

const STATE_DOT: Record<string, string> = {
  idle: "bg-text-faint",
  resolving: "bg-warning animate-pulse",
  connecting: "bg-warning animate-pulse",
  ready: "bg-success",
  reconnecting: "bg-warning animate-pulse",
  closed: "bg-text-faint",
  fatal: "bg-danger",
};

/** Windows 标准「还原」双叠方框：后方块仅画上/右及被前方块遮挡后露出的边段（无填充，hover 不穿帮）。 */
function RestoreIcon() {
  return (
    <svg
      className="h-[13px] w-[13px]"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth={1}
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden
    >
      <path d="M3 1h8v8H9 M3 1v2" />
      <rect x="1" y="3" width="8" height="8" />
    </svg>
  );
}

export function TitleBar() {
  const status = useBackendStore((s) => s.status);
  const state = status?.state ?? "idle";
  const stateLabel = t.status[state as keyof typeof t.status] ?? state;
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let alive = true;
    void call<{ maximized: boolean }>(() => bridge().app.windowState({}))
      .then((s) => {
        if (alive && s) setMaximized(s.maximized);
      })
      .catch(() => {
        /* 取不到时维持单方框 */
      });
    const off = onEvent(EVENTS.appWindowState, (payload) => {
      const m = (payload as { maximized?: boolean } | null)?.maximized;
      if (typeof m === "boolean") setMaximized(m);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  return (
    <header className="titlebar relative flex h-9 shrink-0 items-center border-b border-border bg-panel px-3">
      {/* 左：后端状态小点 */}
      <div
        className="flex items-center gap-1.5"
        title={`${t.app.name} · ${stateLabel}`}
      >
        <span className={cn("h-2 w-2 rounded-full", STATE_DOT[state])} />
      </div>

      <div className="flex-1" />

      {/* 右：应用名 + 版本 + 徽标（对齐 DSH 标题栏布局） */}
      <div className="pointer-events-none flex items-center gap-2 pr-2">
        <span className="text-xs font-semibold text-text">{t.app.name}</span>
        <span className="text-[11px] tabular-nums text-text-faint">
          v{window.cc.versions.app}
        </span>
        <span className="rounded-full border border-accent/30 bg-accent-soft px-1.5 py-px text-[10px] font-medium text-accent">
          {t.app.badge}
        </span>
      </div>

      <div className="titlebar-actions flex items-center">
        <button
          className="flex h-7 w-9 items-center justify-center text-text-muted hover:bg-hover hover:text-text"
          onClick={() => void bridge().app.windowControl({ action: "minimize" })}
          aria-label="最小化"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          className="flex h-7 w-9 items-center justify-center text-text-muted hover:bg-hover hover:text-text"
          onClick={() => void bridge().app.windowControl({ action: "toggleMaximize" })}
          aria-label={maximized ? "还原" : "最大化"}
          title={maximized ? "还原" : "最大化"}
        >
          {maximized ? <RestoreIcon /> : <Square className="h-3 w-3" />}
        </button>
        <button
          className="flex h-7 w-9 items-center justify-center text-text-muted hover:bg-danger hover:text-on-accent"
          onClick={() => void bridge().app.windowControl({ action: "close" })}
          aria-label="关闭"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}
