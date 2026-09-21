/**
 * 对话页（豆包形态）：左侧对话列表 + 右侧气泡式聊天主区。
 *  - 复用 threads / thread-view / 通知管线；纯对话线程为托管目录 + 只读免审批
 *  - 空态：居中问候 + 大输入框；会话态：用户消息右气泡、助手消息左侧 Markdown
 *  - 流式中发送 = steer；停止 = interrupt（纯对话无审批卡片，无需先核销）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, MessagesSquare, Plus, Search, Settings as SettingsIcon, Square } from "lucide-react";
import { t } from "../../i18n/zh.ts";
import { bridge, call } from "../../lib/ipc.ts";
import { Markdown } from "../../components/markdown.tsx";
import { BrandMark } from "../../components/brand.tsx";
import { ModeToggle } from "../../components/mode-select.tsx";
import { AccountButton } from "./sidebar.tsx";
import { useBackendStore } from "../../store/backend.ts";
import { useChatModeStore } from "../../store/chat-mode.ts";
import { useApprovalsStore } from "../../store/approvals.ts";
import { useThreadViewStore, type TurnView } from "../../store/thread-view.ts";
import { useThreadsStore } from "../../store/threads.ts";
import { useRouterStore } from "../../store/router.ts";
import { useToastStore } from "../../store/toast.ts";
import { bindBackendEvents } from "../../store/backend-events.ts";
import { formatRelativeTime } from "../../lib/format.ts";
import { cn } from "../../lib/cn.ts";
import type { ThreadSummary } from "../../lib/types.ts";

type DayKey = "today" | "yesterday" | "week" | "earlier";

function dayKeyOf(updatedAt: number | null): DayKey {
  if (!updatedAt) return "earlier";
  const ms = updatedAt > 1e12 ? updatedAt : updatedAt * 1000;
  const d = new Date(ms);
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.floor((startOf(now) - startOf(d)) / 86_400_000);
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays <= 7) return "week";
  return "earlier";
}

const DAY_ORDER: DayKey[] = ["today", "yesterday", "week", "earlier"];

/* ---------------- 对话列表侧栏 ---------------- */

function ChatSidebar({ onNewChat }: { onNewChat: () => void }) {
  const { items, loading, initialized, query } = useThreadsStore();
  const refresh = useThreadsStore((s) => s.refresh);
  const search = useThreadsStore((s) => s.search);
  const backendReady = useBackendStore((s) => s.status?.state === "ready");
  const activeThreadId = useThreadViewStore((s) => s.threadId);
  const openThread = useThreadViewStore((s) => s.open);
  const isChatPath = useChatModeStore((s) => s.isChatPath);
  const initSpace = useChatModeStore((s) => s.initSpace);
  const spaceReady = useChatModeStore((s) => s.spaceReady);

  const setView = useRouterStore((s) => s.setView);
  const pendingCount = useApprovalsStore((s) => s.pending.length);

  const [draft, setDraft] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    void initSpace().catch(() => undefined);
  }, [initSpace]);

  useEffect(() => {
    if (backendReady && !initialized) void refresh();
  }, [backendReady, initialized, refresh]);

  useEffect(() => {
    const q = draft.trim();
    const id = setTimeout(() => {
      if (q !== query) void search(q);
    }, 300);
    return () => clearTimeout(id);
  }, [draft, query, search]);

  const chatThreads = useMemo(
    () =>
      items
        .filter((th) => isChatPath(th.cwd))
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
    [items, isChatPath, spaceReady],
  );

  const grouped = useMemo(() => {
    const out: Array<{ key: DayKey; label: string; threads: ThreadSummary[] }> = [];
    for (const key of DAY_ORDER) {
      const threads = chatThreads.filter((th) => dayKeyOf(th.updatedAt) === key);
      if (threads.length > 0) {
        out.push({ key, label: t.chatPage[key], threads });
      }
    }
    return out;
  }, [chatThreads]);

  const empty = initialized && chatThreads.length === 0;

  return (
    <aside className="flex w-[280px] shrink-0 flex-col border-r border-border bg-surface">
      <div className="flex h-14 shrink-0 items-center gap-2 px-4">
        <BrandMark size={28} radius={8} className="shrink-0" />
        <span className="min-w-0 truncate text-[15px] font-semibold tracking-tight text-text">
          {t.app.name}
        </span>
      </div>

      <div className="shrink-0 px-3 pb-2">
        <ModeToggle />
      </div>

      <div className="shrink-0 px-3 pb-1">
        <button
          onClick={onNewChat}
          className="flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-border bg-surface-2 text-[13px] font-medium text-text transition-colors hover:bg-hover"
        >
          <Plus className="h-4 w-4" strokeWidth={1.8} />
          {t.chatPage.newChat}
        </button>
      </div>

      <div className="shrink-0 px-3 pb-2 pt-1">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-faint" />
          <input
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setSearchOpen(true);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setDraft("");
                setSearchOpen(false);
              }
            }}
            placeholder={t.chatPage.searchPlaceholder}
            className="h-8 w-full rounded-lg border border-border bg-surface-2 pl-8 pr-3 text-xs text-text placeholder:text-text-faint focus:border-accent/50 focus:outline-none"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {loading && !initialized ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-text-faint" />
          </div>
        ) : empty ? (
          <p className="px-3 py-6 text-center text-xs text-text-faint">{t.chatPage.empty}</p>
        ) : null}
        {!loading &&
          (searchOpen && draft.trim()
            ? chatThreads.map((th) => (
                <ConversationRow
                  key={th.id}
                  thread={th}
                  active={activeThreadId === th.id}
                  onOpen={() => void openThread(th.id)}
                />
              ))
            : grouped.map((g) => (
                <div key={g.key} className="mb-1">
                  <p className="px-2.5 pb-1 pt-2 text-[10px] font-medium tracking-wide text-text-faint">
                    {g.label}
                  </p>
                  {g.threads.map((th) => (
                    <ConversationRow
                      key={th.id}
                      thread={th}
                      active={activeThreadId === th.id}
                      onOpen={() => void openThread(th.id)}
                    />
                  ))}
                </div>
              )))}
      </div>

      <div className="flex h-14 shrink-0 items-center gap-1 border-t border-border px-2.5">
        <AccountButton />
        <button
          title={t.nav.settings}
          onClick={() => setView("settings")}
          className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-faint hover:bg-hover hover:text-text"
        >
          <SettingsIcon className="h-4 w-4" strokeWidth={1.8} />
          {pendingCount > 0 && (
            <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-danger ring-2 ring-surface" />
          )}
        </button>
      </div>
    </aside>
  );
}

function ConversationRow({
  thread,
  active,
  onOpen,
}: {
  thread: ThreadSummary;
  active: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      onClick={onOpen}
      className={cn(
        "group flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors",
        active ? "bg-surface-3" : "hover:bg-hover",
      )}
    >
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate text-[13px]",
            active ? "font-medium text-text" : "text-text-muted group-hover:text-text",
          )}
        >
          {thread.name || thread.preview || t.chatPage.unnamed}
        </span>
      </span>
      <span className="shrink-0 text-[10px] tabular-nums text-text-faint">
        {formatRelativeTime(thread.updatedAt)}
      </span>
    </button>
  );
}

/* ---------------- 气泡消息 ---------------- */

function BubbleList({ turns, streaming }: { turns: TurnView[]; streaming: boolean }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && followRef.current) el.scrollTo({ top: el.scrollHeight });
  }, [turns, streaming]);

  return (
    <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
        {turns.map((turn) => (
          <TurnBubbles key={turn.id} turn={turn} streaming={streaming} />
        ))}
      </div>
    </div>
  );
}

function TurnBubbles({ turn, streaming }: { turn: TurnView; streaming: boolean }) {
  const visible = turn.items.filter(
    (it) => it.type === "userMessage" || (it.type === "agentMessage" && str2(it.text)),
  );
  return (
    <>
      {visible.map((it, idx) => {
        const isLast = idx === visible.length - 1;
        if (it.type === "userMessage") {
          return (
            <div key={`${turn.id}-u-${it.id ?? idx}`} className="flex justify-end">
              <div className="max-w-[78%] rounded-2xl rounded-br-md bg-accent px-3.5 py-2 text-[13px] leading-relaxed text-on-accent select-text whitespace-pre-wrap break-words">
                {str2(it.text)}
              </div>
            </div>
          );
        }
        const emptyText = !str2(it.text);
        return (
          <div key={`${turn.id}-a-${it.id ?? idx}`} className="flex items-start gap-2.5">
            <BrandMark size={26} radius={8} className="mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              {emptyText ? (
                <span className="inline-flex items-center gap-1.5 py-1 text-[11px] text-text-faint">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {t.chatPage.thinking}
                </span>
              ) : (
                <div className="markdown-body text-[13px]">
                  <Markdown content={str2(it.text)} />
                </div>
              )}
              {streaming && isLast && !emptyText && (
                <span className="mt-1 inline-flex items-center gap-1 text-[11px] text-text-faint">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {t.chatPage.thinking}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}

function str2(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/* ---------------- 输入区 ---------------- */

function ChatComposer({ threadId }: { threadId: string | null }) {
  const streaming = useThreadViewStore((s) => s.streaming);
  const open = useThreadViewStore((s) => s.open);
  const startChatThread = useThreadsStore((s) => s.startChat);
  const toastError = useToastStore((s) => s.error);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const composing = useRef(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  const send = async () => {
    const body = text.trim();
    if (!body || busy || streaming) return;
    setBusy(true);
    const sentText = body;
    try {
      let tid = threadId;
      if (!tid) {
        tid = await startChatThread();
        useThreadViewStore.setState({
          threadId: tid,
          thread: null,
          turns: [],
          turnsCursor: null,
          loading: false,
          error: null,
          warnings: [],
        });
        void open(tid);
      }
      const input: Record<string, unknown>[] = [
        { type: "text", text: sentText, text_elements: [] },
      ];
      void call(() => bridge().turn.start({ threadId: tid, input })).catch((err) => {
        toastError(t.toast.actionFailed, err instanceof Error ? err.message : String(err));
        setText((prev) => prev || sentText);
      });
      setText("");
      taRef.current?.focus();
    } catch (err) {
      toastError(t.toast.actionFailed, err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const steer = async () => {
    const body = text.trim();
    if (!body || busy || !threadId) return;
    const expectedTurnId = useThreadViewStore.getState().activeTurnId;
    if (!expectedTurnId) return;
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
      await call(() => bridge().turn.interrupt({ threadId }));
    } catch (err) {
      toastError(t.toast.actionFailed, err instanceof Error ? err.message : String(err));
    }
  };

  const submit = () => void (streaming ? steer() : send());

  return (
    <div className="shrink-0 px-4 pb-4">
      <div className="mx-auto max-w-3xl">
        <div className="rounded-2xl border border-border bg-surface-2 shadow-[0_2px_10px_var(--c-shadow)] transition-shadow focus-within:border-accent/40 focus-within:shadow-[0_6px_24px_var(--c-shadow)]">
          <textarea
            ref={taRef}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !composing.current) {
                e.preventDefault();
                submit();
              }
            }}
            onCompositionStart={() => (composing.current = true)}
            onCompositionEnd={() => (composing.current = false)}
            placeholder={t.chatPage.inputPlaceholder}
            className="max-h-40 min-h-[46px] w-full resize-none bg-transparent px-4 py-3 text-[13px] leading-relaxed text-text placeholder:text-text-faint focus:outline-none"
          />
          <div className="flex items-center gap-1 px-3 pb-2.5">
            <div className="flex-1" />
            {streaming ? (
              <button
                title={t.chat.stop}
                onClick={() => void interrupt()}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-danger/15 text-danger transition-colors hover:bg-danger/25"
              >
                <Square className="h-4 w-4 fill-current" />
              </button>
            ) : (
              <button
                title={t.chat.send}
                onClick={submit}
                disabled={busy || !text.trim()}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-accent text-on-accent transition-[filter,opacity] hover:brightness-110 disabled:opacity-40"
              >
                <MessagesSquare className="h-4 w-4" strokeWidth={2} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- 页面 ---------------- */

export function ChatApp() {
  useEffect(() => bindBackendEvents(), []);

  const threadId = useThreadViewStore((s) => s.threadId);
  const thread = useThreadViewStore((s) => s.thread);
  const turns = useThreadViewStore((s) => s.turns);
  const streaming = useThreadViewStore((s) => s.streaming);
  const close = useThreadViewStore((s) => s.close);
  const isChatPath = useChatModeStore((s) => s.isChatPath);

  // 当前打开的不是纯对话线程（如从任务页切来）时按空态展示。
  const activeChat = threadId !== null && (thread === null || isChatPath(thread.cwd));

  const newChat = () => {
    close();
  };

  return (
    <div className="flex min-h-0 flex-1">
      <ChatSidebar onNewChat={newChat} />
      <main className="relative flex min-w-0 flex-1 flex-col">
        <div className="welcome-glow pointer-events-none absolute inset-0 opacity-60" />
        {activeChat && threadId ? (
          <>
            <header className="relative z-10 flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
              <span className="truncate text-[13px] font-medium text-text-muted">
                {thread?.name || thread?.preview || t.chatPage.unnamed}
              </span>
              {streaming && (
                <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px] text-text-faint">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {t.chatPage.thinking}
                </span>
              )}
            </header>
            <div className="relative z-10 flex min-h-0 flex-1 flex-col">
              <BubbleList turns={turns} streaming={streaming} />
              <ChatComposer threadId={threadId} />
            </div>
          </>
        ) : (
          <div className="relative z-10 flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-4 pb-2">
            <div className="flex flex-col items-center gap-3">
              <BrandMark size={52} radius={14} />
              <h1 className="text-[24px] font-semibold tracking-tight text-text">
                {t.chatPage.greeting}
              </h1>
              <p className="text-xs text-text-faint">{t.chatPage.greetingSub}</p>
            </div>
            <div className="w-full max-w-3xl">
              <ChatComposer threadId={null} />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
