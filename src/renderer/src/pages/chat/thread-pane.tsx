import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUpToLine,
  Coins,
  FolderGit2,
  Loader2,
  TriangleAlert,
} from "lucide-react";
import { t } from "../../i18n/zh.ts";
import { useChatModeStore } from "../../store/chat-mode.ts";
import { useThreadViewStore } from "../../store/thread-view.ts";
import { Badge } from "../../components/ui/badge.tsx";
import { Button } from "../../components/ui/button.tsx";
import { ErrorState } from "../../components/ui/empty-state.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import { BrandMark } from "../../components/brand.tsx";
import { PermissionPill, WorkspacePill } from "../../components/mode-select.tsx";
import { Composer } from "./composer.tsx";
import { TurnGroup } from "../../components/timeline.tsx";

function LoadingPane() {
  return (
    <div className="flex flex-col gap-4 p-6">
      <Skeleton className="h-5 w-72" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-11/12" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

/** 累计 token 用量徽标；有上下文窗口时附使用百分比。 */
function TokenUsageChip() {
  const usage = useThreadViewStore((s) => s.tokenUsage);
  if (!usage || usage.totalTokens <= 0) return null;
  const pct =
    usage.modelContextWindow && usage.modelContextWindow > 0
      ? Math.min(100, Math.round((usage.totalTokens / usage.modelContextWindow) * 100))
      : null;
  const fmt = (n: number) => (n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return (
    <Badge tone="neutral" className="gap-1 font-mono">
      <Coins className="h-3 w-3" />
      {fmt(usage.totalTokens)}
      {pct !== null ? ` / ${pct}%` : ""}
    </Badge>
  );
}

export function ThreadPane() {
  const threadId = useThreadViewStore((s) => s.threadId);
  const thread = useThreadViewStore((s) => s.thread);
  const turns = useThreadViewStore((s) => s.turns);
  const turnsCursor = useThreadViewStore((s) => s.turnsCursor);
  const loading = useThreadViewStore((s) => s.loading);
  const loadingOlder = useThreadViewStore((s) => s.loadingOlder);
  const error = useThreadViewStore((s) => s.error);
  const streaming = useThreadViewStore((s) => s.streaming);
  const warnings = useThreadViewStore((s) => s.warnings);
  const loadOlder = useThreadViewStore((s) => s.loadOlder);

  // 纯对话判定：cwd 命中托管目录。
  const isChatPath = useChatModeStore((s) => s.isChatPath);
  const spaceReady = useChatModeStore((s) => s.spaceReady);
  const initSpace = useChatModeStore((s) => s.initSpace);
  const isChat = useMemo(() => {
    if (!threadId || !thread) return false;
    return isChatPath(thread.cwd);
  }, [threadId, thread, isChatPath, spaceReady]);

  useEffect(() => {
    void initSpace().catch(() => {
      /* 判定保持 false，侧栏挂载时通常已初始化 */
    });
  }, [initSpace]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** 跟随滚动：用户贴近底部时自动跟随新输出，上滚后挂起。 */
  const followRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    followRef.current = distance < 80;
    setShowJump(distance > 240);
  }, []);

  // 内容增长（新回合/流式 delta/条目更新）时贴近底部则跟随。
  useEffect(() => {
    if (followRef.current) scrollToBottom();
  }, [turns, streaming, scrollToBottom]);

  // 切换会话后回到底部。
  useEffect(() => {
    followRef.current = true;
    setShowJump(false);
    requestAnimationFrame(() => scrollToBottom());
  }, [threadId, loading, scrollToBottom]);

  if (!threadId) {
    return (
      <div className="relative flex h-full flex-1 flex-col">
        <div className="welcome-glow absolute inset-0" />
        <div className="relative z-10 flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-4 pb-2">
          <div className="flex flex-col items-center gap-4">
            <BrandMark size={56} radius={15} />
            <div className="flex items-center gap-2.5">
              <h1 className="text-[26px] font-semibold tracking-tight text-text">
                {t.welcome.slogan}
              </h1>
              <span className="rounded-full border border-accent/30 bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent">
                {t.app.badge}
              </span>
            </div>
          </div>
          <div className="flex w-full max-w-3xl items-center justify-center gap-2">
            <WorkspacePill />
            <PermissionPill threadId={null} />
          </div>
          <Composer />
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <span className="truncate text-[13px] font-semibold">
          {thread?.name || thread?.preview || "未命名会话"}
        </span>
        {streaming ? (
          <Badge tone="accent" className="gap-1">
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
            生成中
          </Badge>
        ) : (
          thread?.status && <Badge tone="accent">{thread.status}</Badge>
        )}
        <TokenUsageChip />
        {isChat ? (
          <Badge tone="neutral" className="ml-auto shrink-0">
            {t.sidebar.chatBadge}
          </Badge>
        ) : (
          thread?.cwd && (
            <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-text-faint">
              <FolderGit2 className="h-3 w-3" />
              <span className="max-w-[320px] truncate">{thread.cwd}</span>
            </span>
          )
        )}
      </header>

      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        {loading && <LoadingPane />}
        {!loading && error && <ErrorState message={`${t.chat.turnError}：${error}`} />}
        {!loading && !error && (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6">
            {turns.length === 0 ? (
              <p className="py-16 text-center text-xs text-text-faint">该会话暂无历史回合</p>
            ) : (
              <>
                {turnsCursor && (
                  <div className="flex justify-center">
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={loadingOlder}
                      icon={<ArrowUpToLine className="h-3.5 w-3.5" />}
                      onClick={() => void loadOlder()}
                    >
                      加载更早记录
                    </Button>
                  </div>
                )}
                {turns.map((turn) => (
                  <TurnGroup key={turn.id || `t-${turn.startedAt}`} turn={turn} />
                ))}
              </>
            )}
            {warnings.map((w) => (
              <div
                key={w.key}
                className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning"
              >
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="select-text break-all">{w.message}</span>
              </div>
            ))}
            {streaming && (
              <div className="flex items-center gap-1.5 py-1 text-[11px] text-text-faint">
                <Loader2 className="h-3 w-3 animate-spin" />
                Claude Code 正在工作…
              </div>
            )}
          </div>
        )}
      </div>

      {showJump && (
        <button
          onClick={() => {
            followRef.current = true;
            setShowJump(false);
            scrollToBottom(true);
          }}
          title="回到底部"
          className="absolute bottom-24 right-6 z-20 flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface text-text-muted shadow-lg hover:bg-hover"
        >
          <ArrowDown className="h-4 w-4" />
        </button>
      )}

      <Composer />
    </div>
  );
}
