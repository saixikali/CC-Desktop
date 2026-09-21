import { create } from "zustand";
import { bridge, call } from "../lib/ipc.ts";
import { normalizeThread, type Paginated, type ThreadSummary } from "../lib/types.ts";

const PAGE_SIZE = 50;

type LoadKind = "init" | "more" | "search";

interface ThreadsStore {
  items: ThreadSummary[];
  nextCursor: string | null;
  query: string;
  loading: boolean;
  loadingMore: boolean;
  searching: boolean;
  error: string | null;
  initialized: boolean;
  setQuery: (q: string) => void;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
  search: (q: string) => Promise<void>;
  /** 新建会话：以 cwd 启动 thread，成功后插入列表并返回 id。permission 为初始权限模式。 */
  start: (cwd: string, projectId?: string | null, permission?: string | null) => Promise<string>;
  /** 新建纯对话：托管中性目录 + 只读沙箱 + 免审批，成功后插入列表并返回 id。 */
  startChat: () => Promise<string>;
  rename: (threadId: string, name: string) => Promise<void>;
  setArchived: (threadId: string, archived: boolean) => Promise<void>;
  remove: (threadId: string) => Promise<void>;
  /** 通知驱动：thread 开始时插入/校正列表。 */
  upsert: (thread: ThreadSummary) => void;
  patchStatus: (threadId: string, status: string | null) => void;
  patchName: (threadId: string, name: string | null) => void;
  setArchivedLocal: (threadId: string, archived: boolean) => void;
  dropLocal: (threadId: string) => void;
}

function sortByRecency(a: ThreadSummary, b: ThreadSummary): number {
  return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
}

export const useThreadsStore = create<ThreadsStore>((set, get) => {
  /** 搜索请求代次：丢弃过期响应，防止旧结果覆盖新查询。 */
  let searchSeq = 0;

  /** 首次/刷新/搜索：重置列表。 */
  async function load(kind: LoadKind, opts: { cursor?: string | null; query?: string } = {}) {
    if (kind === "init") set({ loading: true, error: null });
    if (kind === "search") set({ searching: true, error: null });
    // 本次调用的代次；过期响应（旧搜索/旧列表）不得覆盖最新状态，也不得提前清掉 loading。
    let seq = 0;
    try {
      const q = opts.query ?? get().query;
      if (q.trim()) {
        // thread/search 响应为 { data, nextCursor, backwardsCursor }，
        // 早期版本误按裸数组接收，导致任何搜索都静默返回空。
        seq = ++searchSeq;
        const res = await call<{ data?: unknown[] } | null>(() =>
          bridge().threads.search({ query: q.trim() }),
        );
        if (seq !== searchSeq) return;
        set({
          items: (Array.isArray(res?.data) ? res!.data : []).map(normalizeThread).sort(sortByRecency),
          nextCursor: null,
          initialized: true,
        });
        return;
      }
      // 回到列表浏览：使在途搜索及更早的列表请求失效。
      seq = ++searchSeq;
      const page = await call<Paginated<unknown>>(() =>
        bridge().threads.list({ limit: PAGE_SIZE, cursor: opts.cursor ?? null }),
      );
      if (seq !== searchSeq) return;
      const incoming = (page?.data ?? []).map(normalizeThread);
      set((s) => ({
        items:
          kind === "more"
            ? [...s.items, ...incoming].filter(
                (x, i, all) => all.findIndex((y) => y.id === x.id) === i,
              )
            : incoming.sort(sortByRecency),
        nextCursor: page?.nextCursor ?? null,
        initialized: true,
      }));
    } catch (err) {
      if (seq === searchSeq) set({ error: (err as Error).message, initialized: true });
    } finally {
      if (seq === searchSeq) {
        set({ loading: false, loadingMore: false, searching: false });
      } else if (kind === "more") {
        set({ loadingMore: false });
      }
    }
  }

  return {
    items: [],
    nextCursor: null,
    query: "",
    loading: false,
    loadingMore: false,
    searching: false,
    error: null,
    initialized: false,

    setQuery: (q) => set({ query: q }),
    refresh: () => load("init"),
    search: (q) => {
      set({ query: q });
      return load("search", { query: q });
    },
    loadMore: async () => {
      const { nextCursor, loadingMore } = get();
      if (!nextCursor || loadingMore) return;
      set({ loadingMore: true });
      await load("more", { cursor: nextCursor });
    },

    start: async (cwd, projectId, permission) => {
      const payload: { cwd: string; projectId?: string; permissionMode?: string } = { cwd };
      if (projectId) payload.projectId = projectId;
      if (permission) payload.permissionMode = permission;
      const res = await call<Record<string, unknown>>(() => bridge().threads.start(payload));
      const raw = (res?.thread ?? res) as Record<string, unknown>;
      const thread = normalizeThread(raw);
      set((s) => ({
        items: [thread, ...s.items.filter((x) => x.id !== thread.id)],
        query: "",
      }));
      return thread.id;
    },

    startChat: async () => {
      const res = await call<Record<string, unknown>>(() => bridge().threads.startChat({}));
      const raw = (res?.thread ?? res) as Record<string, unknown>;
      const thread = normalizeThread(raw);
      set((s) => ({
        items: [thread, ...s.items.filter((x) => x.id !== thread.id)],
        query: "",
      }));
      return thread.id;
    },

    rename: async (threadId, name) => {
      await call(() => bridge().threads.setName({ threadId, name: name.trim() }));
      get().patchName(threadId, name.trim());
    },

    setArchived: async (threadId, archived) => {
      await call(() =>
        archived
          ? bridge().threads.archive({ threadId })
          : bridge().threads.unarchive({ threadId }),
      );
      get().setArchivedLocal(threadId, archived);
    },

    remove: async (threadId) => {
      await call(() => bridge().threads.remove({ threadId }));
      get().dropLocal(threadId);
    },

    upsert: (thread) =>
      set((s) => ({
        items: [thread, ...s.items.filter((x) => x.id !== thread.id)],
      })),

    patchStatus: (threadId, status) =>
      set((s) => ({
        items: s.items.map((x) => (x.id === threadId ? { ...x, status } : x)),
      })),

    patchName: (threadId, name) =>
      set((s) => ({
        items: s.items.map((x) => (x.id === threadId ? { ...x, name } : x)),
      })),

    setArchivedLocal: (threadId, archived) =>
      set((s) => ({
        items: s.items.map((x) => (x.id === threadId ? { ...x, archived } : x)),
      })),

    dropLocal: (threadId) =>
      set((s) => ({ items: s.items.filter((x) => x.id !== threadId) })),
  };
});
