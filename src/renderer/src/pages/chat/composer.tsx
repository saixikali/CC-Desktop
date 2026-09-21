/**
 * 聊天输入区（DSH Desktop 风格大圆角卡片）：
 *  - Enter 发送 / Shift+Enter 换行（IME 组合中不触发）
 *  - 无会话时以当前工作区根目录自动建会话
 *  - turn/start 支持当轮 model / effort 覆盖（AC-8），选择器并入底部工具条右侧
 *  - 流式进行中可"追加"输入（turn/steer，AC-5）或"停止"（turn/interrupt）
 *  - 支持附加本地图片（localImage）
 *  - 底部工具条左侧为全局沙箱模式选择（写 config.toml，对新会话生效）
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Check, ChevronDown, ImagePlus, Plus, Send, Square, X } from "lucide-react";
import { t } from "../../i18n/zh.ts";
import { bridge, call } from "../../lib/ipc.ts";
import { useApprovalsStore } from "../../store/approvals.ts";
import { useChatModeStore } from "../../store/chat-mode.ts";
import { useProjectsStore } from "../../store/projects.ts";
import { useThreadViewStore } from "../../store/thread-view.ts";
import { useThreadsStore } from "../../store/threads.ts";
import { useToastStore } from "../../store/toast.ts";
import { useTurnOverridesStore } from "../../store/turn-overrides.ts";
import { PermissionPill } from "../../components/mode-select.tsx";
import { cn } from "../../lib/cn.ts";

interface AttachedImage {
  path: string;
  /** data URL 预览，读取失败时仅显示文件名。 */
  preview: string | null;
}

interface ModelRow {
  id: string;
  model: string;
  displayName: string;
  hidden: boolean;
  isDefault: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: Array<{ reasoningEffort: string }>;
}

function AttachedChip({ img, onRemove }: { img: AttachedImage; onRemove: () => void }) {
  return (
    <div className="group relative h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-border bg-surface-3">
      {img.preview ? (
        <img src={img.preview} alt={img.path} className="h-full w-full object-cover" />
      ) : (
        <span className="flex h-full items-center justify-center p-1 text-center text-[9px] leading-tight text-text-faint">
          {img.path.split(/[\\/]/).pop()}
        </span>
      )}
      <button
        onClick={onRemove}
        className="absolute inset-0 hidden items-center justify-center bg-black/50 text-white group-hover:flex"
        title="移除"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

/** 读取本地图片为 data URL 预览（走 fs 白名单，失败不影响发送）。 */
async function readPreview(path: string): Promise<string | null> {
  try {
    const r = await call<{ dataBase64: string }>(() => bridge().fs.readFile({ path }));
    const ext = path.split(".").pop()?.toLowerCase() ?? "png";
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
    return `data:${mime};base64,${r.dataBase64}`;
  } catch {
    return null;
  }
}

const FALLBACK_EFFORTS = ["minimal", "low", "medium", "high"];

/** 模型 + 推理力度组合选择（当轮覆盖，仅作用于本会话）。 */
function ModelEffortSelect({
  threadId,
  modelRows,
  overrides,
  setModelOverride,
  setEffortOverride,
}: {
  threadId: string | null;
  modelRows: ModelRow[];
  overrides: { model: string | null; effort: string | null };
  setModelOverride: (threadId: string | null, v: string | null) => void;
  setEffortOverride: (threadId: string | null, v: string | null) => void;
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

  const selectedRow =
    modelRows.find((m) => m.model === overrides.model) ??
    modelRows.find((m) => m.isDefault) ??
    modelRows[0] ??
    null;
  const effortOptions =
    selectedRow?.supportedReasoningEfforts && selectedRow.supportedReasoningEfforts.length > 0
      ? selectedRow.supportedReasoningEfforts.map((e) => e.reasoningEffort)
      : FALLBACK_EFFORTS;
  const effort =
    overrides.effort ?? selectedRow?.defaultReasoningEffort ?? t.modes.effortFollow;
  const label = selectedRow ? `${selectedRow.displayName} ${effort}` : t.common.loading;

  return (
    <div ref={ref} className="relative">
      <button
        title="仅作用于本会话的回合覆盖，不影响设置页全局默认"
        disabled={modelRows.length === 0}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-8 max-w-[240px] items-center gap-1 rounded-lg px-2 text-xs font-medium text-text-muted transition-colors hover:bg-hover hover:text-text disabled:opacity-50",
          open && "bg-hover text-text",
        )}
      >
        <span className="truncate">{label}</span>
        <ChevronDown className={cn("h-3 w-3 shrink-0 opacity-70 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="absolute bottom-full right-0 z-40 mb-1.5 w-60 overflow-hidden rounded-xl border border-border bg-surface p-1 shadow-lg shadow-shadow">
          <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-medium tracking-wide text-text-faint">
            模型（当轮）
          </p>
          <div className="max-h-52 overflow-y-auto">
            {modelRows.map((m) => (
              <button
                key={m.id}
                onClick={() => {
                  setModelOverride(threadId, m.isDefault ? null : m.model);
                  setEffortOverride(threadId, null);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs",
                  selectedRow?.id === m.id ? "bg-accent-soft text-accent" : "text-text-muted hover:bg-hover hover:text-text",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{m.displayName}</span>
                {selectedRow?.id === m.id && <Check className="h-3.5 w-3.5 shrink-0" />}
              </button>
            ))}
          </div>
          <div className="my-1 border-t border-border" />
          <p className="px-2.5 pb-1 pt-0.5 text-[10px] font-medium tracking-wide text-text-faint">
            推理力度
          </p>
          <div className="flex flex-col">
            <button
              onClick={() => setEffortOverride(threadId, null)}
              className={cn(
                "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs",
                !overrides.effort ? "bg-accent-soft text-accent" : "text-text-muted hover:bg-hover hover:text-text",
              )}
            >
              <span className="flex-1">{t.modes.effortFollow}</span>
              {!overrides.effort && <Check className="h-3.5 w-3.5" />}
            </button>
            {effortOptions.map((eff) => {
              const active = eff === overrides.effort;
              return (
                <button
                  key={eff}
                  onClick={() => setEffortOverride(threadId, eff)}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs capitalize",
                    active ? "bg-accent-soft text-accent" : "text-text-muted hover:bg-hover hover:text-text",
                  )}
                >
                  <span className="flex-1">{eff}</span>
                  {active && <Check className="h-3.5 w-3.5" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function Composer() {
  const threadId = useThreadViewStore((s) => s.threadId);
  const streaming = useThreadViewStore((s) => s.streaming);
  const open = useThreadViewStore((s) => s.open);
  const activeThread = useThreadViewStore((s) => s.thread);
  const startThread = useThreadsStore((s) => s.start);
  const toastError = useToastStore((s) => s.error);

  // 纯对话判定：cwd 命中托管目录（闲聊走独立对话页，这里只处理已开的纯对话线程）。
  const isChatPath = useChatModeStore((s) => s.isChatPath);
  const spaceReady = useChatModeStore((s) => s.spaceReady);
  const initSpace = useChatModeStore((s) => s.initSpace);
  const isChat = useMemo(() => {
    if (!threadId || !activeThread) return false;
    return isChatPath(activeThread.cwd);
    // spaceReady 决定 isChatPath 结果，作为依赖触发重算。
  }, [threadId, activeThread, isChatPath, spaceReady]);

  const activeProject = useProjectsStore((s) => s.items.find((p) => p.id === s.activeId) ?? null);

  useEffect(() => {
    void initSpace().catch(() => {
      /* 判定保持 false，侧栏挂载时通常已初始化 */
    });
  }, [initSpace]);

  // 当轮模型/推理力度覆盖（按会话记忆；新会话用 pending）。
  const overrides = useTurnOverridesStore((s) =>
    threadId ? (s.byThread[threadId] ?? s.pending) : s.pending,
  );
  const setModelOverride = useTurnOverridesStore((s) => s.setModel);
  const setEffortOverride = useTurnOverridesStore((s) => s.setEffort);

  // Claude Code 模型清单（当轮覆盖用；别名由 CLI 解析，默认 Sonnet）。
  const modelRows: ModelRow[] = [
    {
      id: "claude-opus",
      model: "opus",
      displayName: "Opus",
      hidden: false,
      isDefault: false,
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }],
    },
    {
      id: "claude-sonnet",
      model: "sonnet",
      displayName: "Sonnet",
      hidden: false,
      isDefault: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }],
    },
    {
      id: "claude-haiku",
      model: "haiku",
      displayName: "Haiku",
      hidden: false,
      isDefault: false,
      defaultReasoningEffort: "low",
      supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }],
    },
  ];

  const [text, setText] = useState("");
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [busy, setBusy] = useState(false);
  const composing = useRef(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  const send = async () => {
    const body = text.trim();
    if ((!body && images.length === 0) || busy || streaming) return;
    setBusy(true);
    const sentText = body;
    const sentImages = images;
    try {
      let tid = threadId;
      if (!tid) {
        let cwd = activeProject?.roots[0] ?? null;
        if (!cwd) {
          cwd = await call<string | null>(() => bridge().app.pickDirectory(undefined));
          if (!cwd) return;
        }
        const pendingOv = useTurnOverridesStore.getState().pending;
        tid = await startThread(cwd, activeProject?.id ?? null, pendingOv.permission);
        // 建会话前选择的当轮覆盖挂到新会话上。
        useTurnOverridesStore.getState().adoptPending(tid);
        await open(tid);
      }

      const input: Record<string, unknown>[] = [];
      if (sentText) input.push({ type: "text", text: sentText, text_elements: [] });
      for (const img of sentImages) input.push({ type: "localImage", path: img.path });

      const ov = useTurnOverridesStore.getState().get(tid);

      // turn/start 随流式通知结束才返回：立即清空输入，异步等待结果。
      // 失败时回填草稿，避免丢失用户输入。
      void call(() =>
        bridge().turn.start({
          threadId: tid,
          input,
          ...(ov.model ? { model: ov.model } : {}),
          ...(ov.effort ? { effort: ov.effort } : {}),
          ...(ov.permission ? { permissionMode: ov.permission } : {}),
        }),
      ).catch((err) => {
        toastError(t.toast.actionFailed, err instanceof Error ? err.message : String(err));
        setText((prev) => prev || sentText);
        setImages((prev) => (prev.length > 0 ? prev : sentImages));
      });
      setText("");
      setImages([]);
      taRef.current?.focus();
    } catch (err) {
      toastError(t.toast.actionFailed, err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /** 流式过程中向当前回合追加指令（turn/steer，AC-5）。 */
  const steer = async () => {
    const body = text.trim();
    if (!body || busy || !threadId) return;
    const expectedTurnId = useThreadViewStore.getState().activeTurnId;
    if (!expectedTurnId) {
      toastError("无法追加", "当前没有进行中的回合");
      return;
    }
    setBusy(true);
    const sentText = body;
    try {
      await call(() =>
        bridge().turn.steer({
          threadId,
          expectedTurnId,
          input: [{ type: "text", text: sentText, text_elements: [] }],
        }),
      );
      setText("");
      taRef.current?.focus();
    } catch (err) {
      toastError(t.toast.actionFailed, err instanceof Error ? err.message : String(err));
      setText((prev) => prev || sentText);
    } finally {
      setBusy(false);
    }
  };

  const interrupt = async () => {
    if (!threadId) return;
    try {
      // 挂起的审批先取消，否则引擎在等审批响应、回合不会结束。
      // threadId 未知的挂起卡片也一并尝试取消（嵌套参数审批可能不携带 threadId）。
      const pending = useApprovalsStore
        .getState()
        .pending.filter((a) => !a.threadId || a.threadId === threadId);
      for (const a of pending) {
        try {
          if (
            a.method === "item/fileChange/requestApproval" ||
            a.method === "applyPatchApproval"
          ) {
            await call(() =>
              bridge().approvals.resolveFileChange({ localId: a.localId, decision: "cancel" }),
            );
          } else {
            await call(() =>
              bridge().approvals.resolveCommand({ localId: a.localId, decision: "cancel" }),
            );
          }
          useApprovalsStore.getState().remove(a.localId);
        } catch {
          /* 单个审批取消失败不阻断中断 */
        }
      }
      await call(() => bridge().turn.interrupt({ threadId }));
    } catch (err) {
      toastError(t.toast.actionFailed, err instanceof Error ? err.message : String(err));
    }
  };

  const attachImages = async () => {
    try {
      const picked = await call<string | null>(() =>
        bridge().app.pickFile({
          title: "选择图片",
          filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
        }),
      );
      if (!picked) return;
      const preview = await readPreview(picked);
      setImages((prev) =>
        prev.some((x) => x.path === picked) ? prev : [...prev, { path: picked, preview }],
      );
    } catch (err) {
      toastError(t.toast.actionFailed, err instanceof Error ? err.message : String(err));
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || composing.current || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void (streaming ? steer() : send());
  };

  const canSend = text.trim().length > 0 || images.length > 0;

  return (
    <footer className="w-full shrink-0 px-4 pb-4">
      <div className="mx-auto flex max-w-3xl flex-col">
        <div
          className={cn(
            "rounded-2xl border border-border bg-surface-2 shadow-[0_2px_10px_var(--c-shadow)] transition-shadow",
            "focus-within:border-accent/40 focus-within:shadow-[0_6px_24px_var(--c-shadow)]",
          )}
        >
          {images.length > 0 && (
            <div className="flex gap-2 px-3 pt-3">
              {images.map((img) => (
                <AttachedChip
                  key={img.path}
                  img={img}
                  onRemove={() => setImages((prev) => prev.filter((x) => x.path !== img.path))}
                />
              ))}
            </div>
          )}
          <textarea
            ref={taRef}
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onCompositionStart={() => (composing.current = true)}
            onCompositionEnd={() => (composing.current = false)}
            placeholder={
              streaming
                ? "向进行中的回合追加指令（Enter 发送）"
                : isChat
                  ? t.chat.chatInputPlaceholder
                  : t.chat.inputPlaceholder
            }
            className="max-h-48 min-h-[52px] w-full resize-none bg-transparent px-4 py-3 text-[13px] leading-relaxed text-text placeholder:text-text-faint focus:outline-none"
          />
          <div className="flex items-center gap-1 px-2 pb-2">
            <button
              title="附加图片"
              onClick={() => void attachImages()}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-muted hover:bg-hover hover:text-text"
            >
              {images.length > 0 ? <ImagePlus className="h-4 w-4" strokeWidth={1.8} /> : <Plus className="h-[18px] w-[18px]" strokeWidth={1.8} />}
            </button>
            {!isChat && <PermissionPill threadId={threadId} />}
            <div className="flex-1" />

            <ModelEffortSelect
              threadId={threadId}
              modelRows={modelRows}
              overrides={overrides}
              setModelOverride={setModelOverride}
              setEffortOverride={setEffortOverride}
            />
            {streaming ? (
              <>
                <button
                  title="追加到当前回合"
                  onClick={() => void steer()}
                  disabled={busy || !text.trim()}
                  className="ml-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent transition-[filter,opacity] hover:brightness-110 disabled:opacity-40"
                >
                  <Send className="h-4 w-4" strokeWidth={2} />
                </button>
                <button
                  title={t.chat.stop}
                  onClick={() => void interrupt()}
                  className="ml-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-danger/15 text-danger transition-colors hover:bg-danger/25"
                >
                  <Square className="h-4 w-4 fill-current" />
                </button>
              </>
            ) : (
              <button
                title={t.chat.send}
                onClick={() => void send()}
                disabled={busy || !canSend}
                className="ml-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent transition-[filter,opacity] hover:brightness-110 disabled:opacity-40"
              >
                <ArrowUp className="h-[18px] w-[18px]" strokeWidth={2.2} />
              </button>
            )}
          </div>
        </div>
      </div>
    </footer>
  );
}
