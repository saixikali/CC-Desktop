/**
 * preload：contextBridge 唯一暴露面 window.cc。
 * 沙箱开启，仅使用 ipcRenderer；invoke 通道全部来自 shared CHANNELS，无裸通道。
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { IpcResult } from "../shared/ipc/contract.ts";
import { CHANNELS, EVENTS, type PushEventName } from "../shared/ipc/channels.ts";

async function invoke(channel: string, input?: unknown): Promise<unknown> {
  const result = (await ipcRenderer.invoke(channel, input)) as IpcResult<unknown> | null;
  if (result && typeof result === "object" && "ok" in result) {
    if (result.ok) return result.data;
    // contextBridge 会丢弃 Error 实例上的自定义属性，故以普通对象携带 code。
    throw { name: "CCIpcError", code: result.error.code, message: result.error.message };
  }
  return result;
}

type EventListener = (payload: unknown) => void;
type WrappedListener = (event: IpcRendererEvent, msg: { event: string; payload: unknown }) => void;
const listenerWrappers = new Map<string, WrappedListener>();

function onEvent(name: PushEventName, listener: EventListener): void {
  const key = `${name} ${listenerIndex(listener)}`;
  if (listenerWrappers.has(key)) return;
  const wrapped: WrappedListener = (_e, msg) => {
    if (msg?.event === name) listener(msg.payload);
  };
  listenerWrappers.set(key, wrapped);
  ipcRenderer.on("cc:event", wrapped);
}

// contextBridge 下无法用函数引用做 Map 键（跨边界身份不稳定），
// 改为给监听器打自增 id，off 时按 id 精确移除。
let listenerSeq = 0;
const taggedListeners = new WeakMap<EventListener, number>();
function listenerIndex(fn: EventListener): number {
  let id = taggedListeners.get(fn);
  if (id === undefined) {
    id = ++listenerSeq;
    taggedListeners.set(fn, id);
  }
  return id;
}

function offEvent(name: PushEventName, listener: EventListener): void {
  const id = taggedListeners.get(listener);
  if (id === undefined) return;
  const wrapped = listenerWrappers.get(`${name} ${id}`);
  if (wrapped) {
    ipcRenderer.removeListener("cc:event", wrapped);
    listenerWrappers.delete(`${name} ${id}`);
  }
}

// 按 CHANNELS 嵌套结构自动生成命名空间方法。
function buildNamespaces(groups: typeof CHANNELS): Record<string, Record<string, (input?: unknown) => Promise<unknown>>> {
  const out: Record<string, Record<string, (input?: unknown) => Promise<unknown>>> = {};
  for (const [group, channels] of Object.entries(groups)) {
    out[group] = {};
    for (const [method, channel] of Object.entries(channels as Record<string, string>)) {
      out[group][method] = (input?: unknown) => invoke(channel, input);
    }
  }
  return out;
}

const api = {
  platform: process.platform,
  versions: {
    app: __CC_VERSION__,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  events: {
    on: onEvent,
    off: offEvent,
    names: EVENTS,
  },
  ...buildNamespaces(CHANNELS),
};

contextBridge.exposeInMainWorld("cc", api);
export type CCApi = typeof api;
