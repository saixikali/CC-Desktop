/**
 * 会话后端通知 → 渲染层 store 的单一分发点（ChatPage 挂载时绑定一次）。
 * 通知信封 { method, params } 全部交给 thread-view.applyNotification 归并。
 */
import { EVENTS } from "@shared/ipc/contract.ts";
import { onEvent } from "../lib/ipc.ts";
import { useThreadViewStore } from "./thread-view.ts";

export function bindBackendEvents(): () => void {
  return onEvent(EVENTS.backendNotification, (payload) => {
    const env = payload as { method?: unknown; params?: unknown } | null;
    if (!env || typeof env.method !== "string") return;
    useThreadViewStore.getState().applyNotification({
      method: env.method,
      params: env.params,
    });
  });
}
