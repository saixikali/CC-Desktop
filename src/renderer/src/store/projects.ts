import { create } from "zustand";
import type { WizardState } from "@shared/ipc/contract.ts";
import { bridge, call } from "../lib/ipc.ts";
import { normalizeProject, type Paginated, type ProjectSummary } from "../lib/types.ts";

interface ProjectsStore {
  items: ProjectSummary[];
  activeId: string | null;
  loading: boolean;
  error: string | null;
  initialized: boolean;
  seeded: boolean;
  refresh: () => Promise<void>;
  /** 切换当前工作区并持久化（null = 全部会话）。 */
  setActive: (id: string | null) => Promise<void>;
  create: (name: string, roots: string[]) => Promise<ProjectSummary>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export const useProjectsStore = create<ProjectsStore>((set, get) => ({
  items: [],
  activeId: null,
  loading: false,
  error: null,
  initialized: false,
  seeded: false,

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const page = await call<Paginated<unknown>>(() => bridge().projects.list({ limit: 100 }));
      const patch: Partial<ProjectsStore> = {
        items: (page?.data ?? []).map(normalizeProject),
        initialized: true,
      };
      // 首次刷新时用持久化的 activeProjectId 种子。
      if (!get().seeded) {
        set({ seeded: true });
        try {
          const w = await call<WizardState>(() => bridge().backend.wizardGet());
          patch.activeId = w.activeProjectId;
        } catch {
          /* 后端未就绪时忽略 */
        }
      }
      set(patch);
    } catch (err) {
      set({ error: (err as Error).message, initialized: true });
    } finally {
      set({ loading: false });
    }
  },

  setActive: async (id) => {
    set({ activeId: id });
    try {
      await call(() => bridge().backend.setActiveProject({ projectId: id }));
    } catch {
      /* 持久化失败不影响本次会话内切换 */
    }
  },

  create: async (name, roots) => {
    const res = await call<{ project?: unknown }>(() =>
      bridge().projects.create({
        name: name.trim() || undefined,
        roots: roots.map((path) => ({ path })),
      }),
    );
    await get().refresh();
    const raw = (res?.project ?? res) as Record<string, unknown>;
    const id = typeof raw?.id === "string" ? raw.id : null;
    const project = normalizeProject(raw);
    if (id) await get().setActive(id);
    return project;
  },

  rename: async (id, name) => {
    await call(() => bridge().projects.update({ projectId: id, name: name.trim() }));
    await get().refresh();
  },

  remove: async (id) => {
    await call(() => bridge().projects.remove({ projectId: id }));
    if (get().activeId === id) await get().setActive(null);
    await get().refresh();
  },
}));
