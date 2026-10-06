/**
 * 审批 Dock：命令执行 / 文件变更两类待审批卡片，堆叠于聊天区右下角。
 * Claude Code 的 canUseTool 审批映射为这两类（只读纯对话线程未预授权工具自动拒绝，不产生卡片）。
 */
import { useMemo, useState } from "react";
import { FileDiff, FilePlus2, FilePen, Terminal } from "lucide-react";
import { diffLines, summarizeDiff } from "../lib/diff.ts";
import { t } from "../i18n/zh.ts";
import { bridge, call } from "../lib/ipc.ts";
import { useApprovalsStore, type PendingApproval } from "../store/approvals.ts";
import { useToastStore } from "../store/toast.ts";
import { useTerminalStore } from "../store/terminal.ts";
import { cn } from "../lib/cn.ts";
import { Button } from "./ui/button.tsx";

const str = (v: unknown): string => (typeof v === "string" ? v : "");

interface ChangeDetail {
  path?: string;
  kind?: string;
  oldText?: string | null;
  newText?: string | null;
}

/** 单文件 diff 视图：新内容/磁盘现状逐行对比，带增删摘要。 */
function ChangeDiff({ change }: { change: ChangeDetail }) {
  const lines = useMemo(
    () => diffLines(change.oldText ?? "", change.newText ?? ""),
    [change.oldText, change.newText],
  );
  const { added, removed } = useMemo(() => summarizeDiff(lines), [lines]);
  const isNew = change.kind === "add";

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="flex items-center gap-2 border-b border-border bg-surface-2 px-2.5 py-1.5">
        {isNew ? (
          <FilePlus2 className="h-3.5 w-3.5 shrink-0 text-success" strokeWidth={1.8} />
        ) : (
          <FilePen className="h-3.5 w-3.5 shrink-0 text-accent" strokeWidth={1.8} />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text" title={change.path}>
          {change.path ?? "（未知文件）"}
        </span>
        <span className="shrink-0 rounded border border-border px-1 text-[9px] text-text-faint">
          {isNew ? "新建" : "修改"}
        </span>
        <span className="shrink-0 font-mono text-[10px] tabular-nums">
          <span className="text-success">+{added}</span>{" "}
          <span className="text-danger">−{removed}</span>
        </span>
      </div>
      <div className="max-h-64 overflow-auto bg-surface-2">
        <pre className="w-fit min-w-full select-text font-mono text-[11px] leading-[18px]">
          {lines.map((l, i) => (
            <div
              key={i}
              className={cn(
                "flex",
                l.type === "add" && "bg-success/10",
                l.type === "del" && "bg-danger/10",
              )}
            >
              <span
                className={cn(
                  "w-6 shrink-0 select-none text-center",
                  l.type === "add" && "text-success",
                  l.type === "del" && "text-danger",
                  l.type === "ctx" && "text-text-faint",
                )}
              >
                {l.type === "add" ? "+" : l.type === "del" ? "−" : " "}
              </span>
              <span
                className={cn(
                  "whitespace-pre-wrap break-all pr-2",
                  l.type === "add" && "text-success",
                  l.type === "del" && "text-danger",
                )}
              >
                {l.text || " "}
              </span>
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}

function CommandCard({ a }: { a: PendingApproval }) {
  const p = (a.params ?? {}) as Record<string, unknown>;
  const resolve = useApprovalsStore((s) => s.remove);
  const toastError = useToastStore((s) => s.error);
  const [busy, setBusy] = useState(false);

  const act = async (decision: "accept" | "acceptForSession" | "decline") => {
    setBusy(true);
    try {
      await call(() => bridge().approvals.resolveCommand({ localId: a.localId, decision }));
      resolve(a.localId);
    } catch (err) {
      toastError(t.toast.actionFailed, err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-warning/40 bg-surface shadow-lg shadow-shadow">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Terminal className="h-3.5 w-3.5 text-warning" strokeWidth={1.7} />
        <span className="text-xs font-semibold">命令执行请求</span>
        {str(p.reason) && (
          <span className="ml-auto max-w-[220px] truncate text-[10px] text-text-faint">
            {str(p.reason)}
          </span>
        )}
      </header>
      <div className="px-3 py-2">
        <pre className="select-text max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-md bg-black/20 p-2 font-mono text-[11px] text-text">
          {str(p.command) || "（未知命令）"}
        </pre>
        {str(p.cwd) && (
          <p className="mt-1 truncate font-mono text-[10px] text-text-faint">{str(p.cwd)}</p>
        )}
      </div>
      <footer className="flex items-center justify-end gap-1.5 px-3 py-2">
        <Button size="sm" variant="ghost" loading={busy} onClick={() => void act("decline")}>
          {t.approvals.decline}
        </Button>
        <Button size="sm" variant="secondary" loading={busy} onClick={() => void act("acceptForSession")}>
          {t.approvals.acceptSession}
        </Button>
        <Button size="sm" variant="primary" loading={busy} onClick={() => void act("accept")}>
          {t.approvals.accept}
        </Button>
      </footer>
    </div>
  );
}

function FileChangeCard({ a }: { a: PendingApproval }) {
  const p = (a.params ?? {}) as Record<string, unknown>;
  const changes: ChangeDetail[] = Array.isArray(p.changes)
    ? (p.changes as ChangeDetail[]).filter(
        (c) => c && (typeof c.newText === "string" || typeof c.oldText === "string"),
      )
    : [];
  const resolve = useApprovalsStore((s) => s.remove);
  const toastError = useToastStore((s) => s.error);
  const [busy, setBusy] = useState(false);

  const act = async (decision: "accept" | "decline") => {
    setBusy(true);
    try {
      await call(() => bridge().approvals.resolveFileChange({ localId: a.localId, decision }));
      resolve(a.localId);
    } catch (err) {
      toastError(t.toast.actionFailed, err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-warning/40 bg-surface shadow-lg shadow-shadow">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <FileDiff className="h-3.5 w-3.5 text-warning" strokeWidth={1.7} />
        <span className="text-xs font-semibold">文件变更请求</span>
      </header>
      <div className="flex flex-col gap-2 px-3 py-2">
        {changes.length > 0 ? (
          changes.map((c, i) => <ChangeDiff key={c.path ?? i} change={c} />)
        ) : (
          <div className="text-[11px] text-text-muted">
            {str(p.reason) ? <p className="select-text">{str(p.reason)}</p> : <p>Claude Code 请求写入受保护路径。</p>}
          </div>
        )}
        {str(p.grantRoot) && (
          <p className="select-text break-all font-mono text-[10px] text-text-faint">
            写入范围：{str(p.grantRoot)}
          </p>
        )}
      </div>
      <footer className="flex items-center justify-end gap-1.5 px-3 py-2">
        <Button size="sm" variant="ghost" loading={busy} onClick={() => void act("decline")}>
          {t.approvals.decline}
        </Button>
        <Button size="sm" variant="primary" loading={busy} onClick={() => void act("accept")}>
          {t.approvals.accept}
        </Button>
      </footer>
    </div>
  );
}

export function ApprovalsDock() {
  const pending = useApprovalsStore((s) => s.pending);
  const terminalOpen = useTerminalStore((s) => s.open);

  if (pending.length === 0) return null;

  return (
    <div
      className={cn(
        "pointer-events-none absolute right-4 z-30 flex max-h-[70%] w-[340px] flex-col gap-2 overflow-y-auto transition-[bottom] duration-200",
        terminalOpen ? "bottom-[300px]" : "bottom-3",
      )}
    >
      {pending.map((a) => (
        <div key={a.localId} className="pointer-events-auto">
          {a.method === "item/commandExecution/requestApproval" || a.method === "execCommandApproval" ? (
            <CommandCard a={a} />
          ) : a.method === "item/fileChange/requestApproval" || a.method === "applyPatchApproval" ? (
            <FileChangeCard a={a} />
          ) : (
            <div className="rounded-xl border border-warning/40 bg-surface px-3 py-2 text-[11px] text-text-muted shadow-lg shadow-shadow">
              未支持的请求类型：{a.method}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
