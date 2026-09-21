/**
 * 新建会话的统一入口：列表按钮、托盘菜单、外部目录参数都走这里。
 * cwd 优先级：显式传入 > 当前工作区根 > 向导最近目录 > 弹原生目录选择器。
 */
import { bridge, call } from "./ipc.ts";
import { useBackendStore } from "../store/backend.ts";
import { useProjectsStore } from "../store/projects.ts";
import { useThreadViewStore } from "../store/thread-view.ts";
import { useThreadsStore } from "../store/threads.ts";

export class PickedCanceled extends Error {
  constructor() {
    super("canceled");
    this.name = "PickedCanceled";
  }
}

export async function createThread(cwd?: string): Promise<string> {
  const projects = useProjectsStore.getState();
  const threads = useThreadsStore.getState();
  const view = useThreadViewStore.getState();
  const wizard = useBackendStore.getState().wizard;

  const activeProject = projects.items.find((p) => p.id === projects.activeId) ?? null;
  const resolved =
    cwd?.trim() ||
    activeProject?.roots[0] ||
    wizard?.roots[0] ||
    (await call<string | null>(() => bridge().app.pickDirectory(undefined)));

  if (!resolved) throw new PickedCanceled();

  const id = await threads.start(resolved, activeProject?.id ?? null);
  await view.open(id);
  return id;
}
