/**
 * 模式选择器（聊天主区顶部/欢迎页/Composer 复用）：
 * - WorkspacePill：工作区过滤（projects store）；
 * - PermissionPill：Claude Code 权限模式（default/plan/acceptEdits/bypassPermissions），
 *   当轮生效，形态对齐 DSH 的「标准模式」药丸。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Bot,
  Briefcase,
  Check,
  ChevronDown,
  Folder,
  NotebookPen,
  ShieldCheck,
  SquarePen,
  TerminalSquare,
  Zap,
} from "lucide-react";
import { t } from "../i18n/zh.ts";
import { useProjectsStore } from "../store/projects.ts";
import { useRouterStore } from "../store/router.ts";
import { useTurnOverridesStore } from "../store/turn-overrides.ts";
import { cn } from "../lib/cn.ts";

function PopoverShell({
  icon,
  label,
  active = false,
  title,
  children,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  title?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        title={title}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition-colors",
          open || active
            ? "border-accent/40 bg-accent-soft text-accent"
            : "border-border bg-surface-2 text-text-muted hover:bg-hover hover:text-text",
        )}
      >
        {icon}
        <span className="max-w-[180px] truncate font-medium">{label}</span>
        <ChevronDown className={cn("h-3 w-3 shrink-0 opacity-70", open && "rotate-180")} />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-40 mb-1.5 w-56 overflow-hidden rounded-xl border border-border bg-surface-2 p-1 shadow-lg shadow-shadow">
          {children}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  selected,
  onClick,
  children,
}: {
  selected?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors",
        selected ? "bg-accent-soft text-accent" : "text-text-muted hover:bg-hover hover:text-text",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {selected && <Check className="h-3.5 w-3.5 shrink-0" />}
    </button>
  );
}

/* ---------------- 工作区 ---------------- */

export function WorkspacePill() {
  const items = useProjectsStore((s) => s.items);
  const activeId = useProjectsStore((s) => s.activeId);
  const setActive = useProjectsStore((s) => s.setActive);
  const active = items.find((p) => p.id === activeId) ?? null;

  return (
    <PopoverShell
      icon={<Briefcase className="h-3.5 w-3.5" strokeWidth={1.8} />}
      label={active ? active.name : t.modes.allWorkspaces}
      active={active !== null}
    >
      <MenuItem selected={activeId === null} onClick={() => void setActive(null)}>
        {t.modes.allWorkspaces}
      </MenuItem>
      {items.length > 0 && <div className="my-1 border-t border-border" />}
      {items.map((p) => (
        <MenuItem key={p.id} selected={activeId === p.id} onClick={() => void setActive(p.id)}>
          <Folder className="h-3 w-3 shrink-0 text-text-faint" />
          <span className="truncate">{p.name}</span>
        </MenuItem>
      ))}
    </PopoverShell>
  );
}

/* ---------------- 权限模式 ---------------- */

export const PERMISSION_MODES = ["default", "plan", "acceptEdits", "bypassPermissions"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

const PERMISSION_META: Record<
  PermissionMode,
  { label: string; hint: string; icon: typeof ShieldCheck }
> = {
  default: { label: t.modes.permDefault, hint: t.modes.permDefaultHint, icon: ShieldCheck },
  plan: { label: t.modes.permPlan, hint: t.modes.permPlanHint, icon: NotebookPen },
  acceptEdits: { label: t.modes.permAcceptEdits, hint: t.modes.permAcceptEditsHint, icon: SquarePen },
  bypassPermissions: { label: t.modes.permBypass, hint: t.modes.permBypassHint, icon: Zap },
};

export function PermissionPill({ threadId }: { threadId: string | null }) {
  const overrides = useTurnOverridesStore((s) =>
    threadId ? (s.byThread[threadId] ?? s.pending) : s.pending,
  );
  const setPermission = useTurnOverridesStore((s) => s.setPermission);
  const current = (overrides.permission ?? "default") as PermissionMode;
  const meta = PERMISSION_META[current] ?? PERMISSION_META.default;
  const Icon = meta.icon;

  return (
    <PopoverShell
      icon={<Icon className="h-3.5 w-3.5" strokeWidth={1.8} />}
      label={meta.label}
      title={meta.hint}
    >
      {PERMISSION_MODES.map((mode) => {
        const m = PERMISSION_META[mode];
        const MIcon = m.icon;
        return (
          <button
            key={mode}
            onClick={() => setPermission(threadId, mode === "default" ? null : mode)}
            className={cn(
              "flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors",
              current === mode
                ? "bg-accent-soft text-accent"
                : "text-text-muted hover:bg-hover hover:text-text",
            )}
          >
            <MIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{m.label}</span>
              <span className="block text-[10px] leading-tight text-text-faint">{m.hint}</span>
            </span>
            {current === mode && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
          </button>
        );
      })}
    </PopoverShell>
  );
}

/* ---------------- 主区模式切换（任务 / 对话） ---------------- */

/** 侧栏顶部的 任务/对话 分段切换（豆包形态的入口）。 */
export function ModeToggle() {
  const mode = useRouterStore((st) => st.mode);
  const setMode = useRouterStore((st) => st.setMode);
  const options = [
    { key: "task" as const, label: t.nav.task, icon: TerminalSquare },
    { key: "chat" as const, label: t.nav.chatMode, icon: Bot },
  ];
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-xl border border-border bg-surface-2 p-0.5">
      {options.map(({ key, label, icon: Icon }) => (
        <button
          key={key}
          onClick={() => setMode(key)}
          className={cn(
            "flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg px-3 text-xs transition-colors",
            mode === key
              ? "bg-surface-3 font-medium text-text shadow-sm"
              : "text-text-faint hover:text-text-muted",
          )}
        >
          <Icon className="h-3.5 w-3.5" strokeWidth={1.8} />
          {label}
        </button>
      ))}
    </div>
  );
}
