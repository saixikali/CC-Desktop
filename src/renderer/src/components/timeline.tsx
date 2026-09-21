import { useEffect, useMemo, useState } from "react";
import {
  BrainCircuit,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleX,
  Clock3,
  Code,
  FileDiff,
  Gavel,
  Globe,
  Image as ImageIcon,
  ListTodo,
  Minimize2,
  Terminal,
  TriangleAlert,
  User,
  Wrench,
} from "lucide-react";
import { bridge, call } from "../lib/ipc.ts";
import { cn } from "../lib/cn.ts";
import { Markdown } from "./markdown.tsx";
import { formatTime } from "../lib/format.ts";
import { Badge } from "./ui/badge.tsx";

/* ---------- 通用工具 ---------- */

type AnyItem = Record<string, unknown> & { type?: string };

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return null;
  const tone =
    status === "completed" || status === "success"
      ? "success"
      : status === "failed" || status === "declined"
        ? "danger"
        : status === "inProgress" || status === "executing"
          ? "accent"
          : "neutral";
  return <Badge tone={tone}>{status}</Badge>;
}

/** 折叠容器：默认收起，点击展开。 */
function Collapsible({
  label,
  children,
  defaultOpen = false,
}: {
  label: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        className="flex items-center gap-1 text-[11px] text-text-faint hover:text-text-muted"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {label}
      </button>
      {open && <div className="mt-1.5">{children}</div>}
    </div>
  );
}

/* ---------- 用户消息 ---------- */

/** localImage 走 fs 读取（限已授权 roots），失败时回退路径展示。 */
function LocalImage({ path }: { path: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    call<{ dataBase64: string }>(() => bridge().fs.readFile({ path }))
      .then((r) => {
        if (cancelled) return;
        const ext = path.split(".").pop()?.toLowerCase() ?? "png";
        const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
        setDataUrl(`data:${mime};base64,${r.dataBase64}`);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (failed || !dataUrl) {
    return (
      <span className="flex items-center gap-1.5 rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[11px]">
        <ImageIcon className="h-3 w-3" />
        {path}
      </span>
    );
  }
  return <img src={dataUrl} alt={path} className="max-h-48 rounded-lg border border-border" />;
}

function UserMessage({ item }: { item: AnyItem }) {
  const content = Array.isArray(item.content) ? item.content : [];
  return (
    <div className="flex justify-end">
      <div className="flex max-w-[85%] flex-col items-end gap-1.5">
        <div className="select-text rounded-2xl rounded-br-md bg-accent/15 px-3.5 py-2 text-[13px] leading-relaxed text-text">
          {content.map((c, i) => {
            const ci = (c ?? {}) as AnyItem;
            if (ci.type === "text") {
              return (
                <p key={i} className="whitespace-pre-wrap">
                  {str(ci.text)}
                </p>
              );
            }
            if (ci.type === "localImage") {
              return <LocalImage key={i} path={str(ci.path)} />;
            }
            if (ci.type === "mention" || ci.type === "skill") {
              return (
                <span key={i} className="mx-0.5 rounded bg-surface-3 px-1.5 py-0.5 text-[11px]">
                  @{str(ci.name) || str(ci.path)}
                </span>
              );
            }
            return null;
          })}
        </div>
      </div>
    </div>
  );
}

/* ---------- 推理 / 计划 ---------- */

function Reasoning({ item }: { item: AnyItem }) {
  const summary = Array.isArray(item.summary) ? item.summary.map(str).filter(Boolean) : [];
  const content = Array.isArray(item.content) ? item.content.map(str).filter(Boolean) : [];
  const text = [...summary, ...content].join("\n\n");
  if (!text) return null;
  return (
    <div className="rounded-lg border border-border/60 bg-surface-2/60 px-3 py-2">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-text-faint">
        <BrainCircuit className="h-3.5 w-3.5" strokeWidth={1.7} />
        思考过程
      </div>
      <div className="mt-1">
        <Collapsible label="展开">
          <div className="select-text border-l-2 border-border pl-2.5 text-[12px] leading-relaxed text-text-faint">
            <Markdown content={text} />
          </div>
        </Collapsible>
      </div>
    </div>
  );
}

function PlanItem({ item }: { item: AnyItem }) {
  const text = str(item.text);
  if (!text) return null;
  return (
    <div className="rounded-lg border border-accent/25 bg-accent/5 px-3 py-2">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-accent">
        <ListTodo className="h-3.5 w-3.5" strokeWidth={1.7} />
        计划
      </div>
      <div className="select-text mt-1.5 text-[12px] leading-relaxed text-text-muted">
        <Markdown content={text} />
      </div>
    </div>
  );
}

/* ---------- 命令执行 ---------- */

function CommandExecution({ item }: { item: AnyItem }) {
  const command = str(item.command);
  const cwd = str(item.cwd);
  const status = typeof item.status === "string" ? item.status : null;
  const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
  const output = str(item.aggregatedOutput);

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface-2">
      <div className="flex items-center gap-2 border-b border-border/70 bg-surface-3/40 px-3 py-1.5">
        <Terminal className="h-3.5 w-3.5 shrink-0 text-text-muted" strokeWidth={1.7} />
        <span className="select-text truncate font-mono text-[11.5px] text-text-muted">
          {command}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[10px] text-text-faint">
          {typeof item.durationMs === "number" && (
            <span className="flex items-center gap-0.5">
              <Clock3 className="h-2.5 w-2.5" />
              {item.durationMs >= 1000
                ? `${(item.durationMs / 1000).toFixed(1)}s`
                : `${item.durationMs}ms`}
            </span>
          )}
          {exitCode !== null && (
            <Badge tone={exitCode === 0 ? "success" : "danger"}>exit {exitCode}</Badge>
          )}
          <StatusBadge status={status} />
        </span>
      </div>
      <div className="px-3 py-2">
        {cwd && (
          <p className="select-text truncate font-mono text-[10px] text-text-faint">{cwd}</p>
        )}
        {output && (
          <Collapsible
            label={`输出（${output.split("\n").length} 行）`}
            defaultOpen={output.length <= 2000}
          >
            <pre className="select-text max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md bg-[#0d1117] p-2.5 font-mono text-[11px] leading-relaxed text-[#c9d1d9]">
              {output}
            </pre>
          </Collapsible>
        )}
      </div>
    </div>
  );
}

/* ---------- 文件变更 ---------- */

function DiffView({ diff }: { diff: string }) {
  const lines = useMemo(() => diff.split("\n"), [diff]);
  return (
    <pre className="select-text overflow-x-auto rounded-md bg-[#0d1117] p-2.5 font-mono text-[11px] leading-[1.6]">
      {lines.map((line, i) => {
        const add = line.startsWith("+") && !line.startsWith("+++");
        const del = line.startsWith("-") && !line.startsWith("---");
        return (
          <span
            key={i}
            className={cn(
              "block whitespace-pre",
              add && "bg-emerald-500/10 text-emerald-300",
              del && "bg-red-500/10 text-red-300",
              !add && !del && "text-[#8b949e]",
            )}
          >
            {line || " "}
          </span>
        );
      })}
    </pre>
  );
}

const KIND_LABEL: Record<string, string> = {
  add: "新增",
  delete: "删除",
  update: "修改",
};

function FileChange({ item }: { item: AnyItem }) {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const status = typeof item.status === "string" ? item.status : null;
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface-2">
      <div className="flex items-center gap-2 border-b border-border/70 bg-surface-3/40 px-3 py-1.5">
        <FileDiff className="h-3.5 w-3.5 shrink-0 text-text-muted" strokeWidth={1.7} />
        <span className="text-[11.5px] font-medium text-text-muted">文件变更</span>
        <span className="ml-auto shrink-0">
          <StatusBadge status={status} />
        </span>
      </div>
      <div className="flex flex-col gap-1.5 px-3 py-2">
        {changes.map((c, i) => {
          const ci = (c ?? {}) as AnyItem;
          const kind =
            typeof ci.kind === "object" && ci.kind !== null
              ? str((ci.kind as AnyItem).type)
              : str(ci.kind);
          const diff = str(ci.diff);
          return (
            <div key={str(ci.path) || i} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <Code className="h-3 w-3 shrink-0 text-text-faint" />
                <span className="select-text truncate font-mono text-[11px] text-text-muted">
                  {str(ci.path)}
                </span>
                <Badge
                  tone={kind === "add" ? "success" : kind === "delete" ? "danger" : "accent"}
                  className="ml-auto shrink-0"
                >
                  {KIND_LABEL[kind] ?? kind}
                </Badge>
              </div>
              {diff && (
                <Collapsible label="查看 diff" defaultOpen={changes.length <= 2 && diff.length < 4000}>
                  <DiffView diff={diff} />
                </Collapsible>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- MCP 工具 ---------- */

function McpToolCall({ item }: { item: AnyItem }) {
  const server = str(item.server);
  const tool = str(item.tool);
  const status = typeof item.status === "string" ? item.status : null;
  const args = item.arguments != null ? JSON.stringify(item.arguments, null, 2) : "";
  const result = item.result as { content?: unknown } | null;
  const error = item.error as { message?: unknown } | null;
  const progressLog = Array.isArray(item.progressLog) ? item.progressLog.map(str).filter(Boolean) : [];
  const resultText = result
    ? typeof result.content === "string"
      ? result.content
      : result.content
        ? JSON.stringify(result.content, null, 2)
        : JSON.stringify(result, null, 2)
    : "";
  const errorText = error ? str(error.message) || JSON.stringify(error, null, 2) : "";

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface-2">
      <div className="flex items-center gap-2 border-b border-border/70 bg-surface-3/40 px-3 py-1.5">
        <Wrench className="h-3.5 w-3.5 shrink-0 text-text-muted" strokeWidth={1.7} />
        <span className="select-text truncate text-[11.5px] text-text-muted">
          <span className="font-medium">{server}</span>
          <span className="text-text-faint"> / </span>
          {tool}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {typeof item.durationMs === "number" && (
            <span className="text-[10px] text-text-faint">
              {item.durationMs >= 1000 ? `${(item.durationMs / 1000).toFixed(1)}s` : `${item.durationMs}ms`}
            </span>
          )}
          <StatusBadge status={status} />
        </span>
      </div>
      <div className="flex flex-col gap-1.5 px-3 py-2">
        {progressLog.length > 0 && (
          <div className="rounded-md bg-surface-3/60 px-2 py-1.5">
            {progressLog.slice(-5).map((line, i) => (
              <p key={i} className="select-text break-all text-[10.5px] leading-relaxed text-text-faint">
                {line}
              </p>
            ))}
          </div>
        )}
        {args && (
          <Collapsible label="参数">
            <pre className="select-text max-h-48 overflow-auto rounded-md bg-[#0d1117] p-2.5 font-mono text-[11px] text-[#c9d1d9]">
              {args}
            </pre>
          </Collapsible>
        )}
        {resultText && (
          <Collapsible label="结果">
            <pre className="select-text max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md bg-[#0d1117] p-2.5 font-mono text-[11px] text-[#c9d1d9]">
              {resultText}
            </pre>
          </Collapsible>
        )}
        {errorText && (
          <p className="select-text rounded-md bg-danger/10 px-2.5 py-1.5 font-mono text-[11px] text-danger">
            {errorText}
          </p>
        )}
      </div>
    </div>
  );
}

/* ---------- 其他条目 ---------- */

function GenericItem({ item }: { item: AnyItem }) {
  const type = str(item.type) || "item";
  const ICONS: Record<string, React.ReactNode> = {
    webSearch: <Globe className="h-3.5 w-3.5" strokeWidth={1.7} />,
    contextCompaction: <Minimize2 className="h-3.5 w-3.5" strokeWidth={1.7} />,
    functionCallOutput: <Wrench className="h-3.5 w-3.5" strokeWidth={1.7} />,
    enteredReviewMode: <Gavel className="h-3.5 w-3.5" strokeWidth={1.7} />,
    exitedReviewMode: <Gavel className="h-3.5 w-3.5" strokeWidth={1.7} />,
    imageView: <ImageIcon className="h-3.5 w-3.5" strokeWidth={1.7} />,
    imageGeneration: <ImageIcon className="h-3.5 w-3.5" strokeWidth={1.7} />,
    subAgentActivity: <User className="h-3.5 w-3.5" strokeWidth={1.7} />,
  };
  const detail =
    str(item.path) ||
    str(item.agentPath) ||
    str(item.name) ||
    (typeof item.review === "string" ? item.review : "");
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border/60 px-3 py-1.5 text-[11px] text-text-faint">
      {ICONS[type] ?? <Wrench className="h-3.5 w-3.5" strokeWidth={1.7} />}
      <span className="shrink-0">{type}</span>
      {detail && <span className="select-text truncate font-mono">{detail}</span>}
      <CircleCheck className="ml-auto h-3 w-3 shrink-0" />
    </div>
  );
}

/* ---------- 条目分发 ---------- */

function ThreadItemView({ item }: { item: unknown }) {
  const it = (item ?? {}) as AnyItem;
  switch (it.type) {
    case "userMessage":
      return <UserMessage item={it} />;
    case "agentMessage":
      return (
        <div className="select-text max-w-[92%] self-start text-[13px] leading-relaxed text-text">
          <Markdown content={str(it.text)} />
        </div>
      );
    case "reasoning":
      return <Reasoning item={it} />;
    case "plan":
      return <PlanItem item={it} />;
    case "commandExecution":
      return <CommandExecution item={it} />;
    case "fileChange":
      return <FileChange item={it} />;
    case "mcpToolCall":
      return <McpToolCall item={it} />;
    case "contextCompaction":
      return (
        <div className="flex items-center justify-center gap-1.5 py-1 text-[10px] text-text-faint">
          <Minimize2 className="h-3 w-3" />
          上下文已压缩
        </div>
      );
    default:
      return <GenericItem item={it} />;
  }
}

/* ---------- 回合分组 ---------- */

export function TurnGroup({ turn }: { turn: import("../store/thread-view.ts").TurnView }) {
  const items = turn.items;
  const failed = turn.status === "failed";
  const error = (turn.error ?? null) as { message?: unknown } | null;
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2 text-[10px] text-text-faint">
        <span className="h-px flex-1 bg-border" />
        <span className="font-mono">{turn.id.slice(0, 8)}</span>
        {turn.status && (
          <Badge tone={turn.status === "completed" ? "success" : turn.status === "failed" ? "danger" : "neutral"}>
            {turn.status}
          </Badge>
        )}
        {turn.durationMs != null && (
          <span className="flex items-center gap-0.5">
            <Clock3 className="h-2.5 w-2.5" />
            {turn.durationMs >= 1000
              ? `${(turn.durationMs / 1000).toFixed(1)}s`
              : `${turn.durationMs}ms`}
          </span>
        )}
        {turn.startedAt != null && <span>{formatTime(turn.startedAt)}</span>}
        <span className="h-px flex-1 bg-border" />
      </div>
      {items.map((item, i) => (
        <ThreadItemView key={i} item={item} />
      ))}
      {(failed || error?.message != null) && (
        <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
          <CircleX className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="select-text break-all">
            {str(error?.message) || "该回合执行失败"}
          </span>
        </div>
      )}
      {turn.notices.map((n, i) => (
        <div
          key={i}
          className={cn(
            "flex items-start gap-2 rounded-lg px-3 py-2 text-[12px]",
            n.level === "error"
              ? "border border-danger/30 bg-danger/10 text-danger"
              : "border border-warning/30 bg-warning/10 text-warning",
          )}
        >
          {n.level === "error" ? (
            <CircleX className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          ) : (
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          )}
          <span className="select-text break-all">
            {n.message}
            {n.willRetry ? "（将自动重试）" : ""}
          </span>
        </div>
      ))}
      {items.length === 0 && !failed && (
        <p className="py-1 text-center text-[10px] text-text-faint">（空回合）</p>
      )}
    </div>
  );
}
