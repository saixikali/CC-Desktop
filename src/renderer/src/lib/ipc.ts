/**
 * 渲染端 IPC 访问层：
 * - call() 把 preload 抛出的 {code,message} 普通对象归一为 BridgeError
 * - onEvent() 订阅主进程推送并返回退订函数
 * 业务层只依赖这里，不直接散落 window.cc 调用。
 */
import type { PushEventName } from "@shared/ipc/contract.ts";

export class BridgeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
  }
}

/** 调用一个 bridge 方法，成功返回 data，失败抛 BridgeError。 */
export async function call<T>(invoker: () => Promise<unknown>): Promise<T> {
  try {
    return (await invoker()) as T;
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown };
    throw new BridgeError(
      typeof e?.code === "string" ? e.code : "INTERNAL",
      typeof e?.message === "string" ? e.message : "未知错误",
    );
  }
}

/** 订阅主进程推送事件，返回退订函数。 */
export function onEvent(name: PushEventName, listener: (payload: unknown) => void): () => void {
  window.cc.events.on(name, listener);
  return () => window.cc.events.off(name, listener);
}

export const bridge = () => window.cc;
