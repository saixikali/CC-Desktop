/**
 * 应用级事件绑定（App 挂载时一次）：
 *  - app:show        托盘/通知点击：进入聊天页（通知携带 approval 时同样落到聊天页审批面板）
 *  - app:new-thread  托盘菜单：新建会话
 *  - app:open-path   第二实例命令行/协议携带目录：以该目录新建会话
 */
import { EVENTS } from "@shared/ipc/contract.ts";
import { onEvent } from "../lib/ipc.ts";
import { createThread, PickedCanceled } from "../lib/new-thread.ts";
import { useRouterStore } from "./router.ts";
import { useThreadViewStore } from "./thread-view.ts";
import { useToastStore } from "./toast.ts";

let bound = false;

export function bindAppEvents(): () => void {
  if (bound) return () => undefined;
  bound = true;

  const unsubs = [
    onEvent(EVENTS.appShow, (payload) => {
      useRouterStore.getState().setView("chat");
      // 托盘/通知点击可能携带 threadId（turn 完成、审批请求）：直接打开该会话。
      const p = payload as { threadId?: unknown } | null;
      if (p && typeof p.threadId === "string" && p.threadId) {
        void useThreadViewStore.getState().open(p.threadId);
      }
    }),

    onEvent(EVENTS.appNewThread, () => {
      useRouterStore.getState().setView("chat");
      void createThread().catch((err) => {
        if (err instanceof PickedCanceled) return;
        useToastStore.getState().error("新建会话失败", (err as Error).message);
      });
    }),

    onEvent(EVENTS.appOpenPath, (payload) => {
      const p = payload as { path?: unknown } | null;
      if (!p || typeof p.path !== "string") return;
      useRouterStore.getState().setView("chat");
      void createThread(p.path).catch((err) => {
        if (err instanceof PickedCanceled) return;
        useToastStore.getState().error("打开目录失败", (err as Error).message);
      });
    }),
  ];

  return () => {
    unsubs.forEach((u) => u());
    bound = false;
  };
}
