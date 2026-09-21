import type { CHANNELS, EVENTS, INPUTS, type InputOf, type PushEventName } from "./ipc/contract.ts";

type Channels = typeof CHANNELS;

type InvokeNamespace<G> = {
  [K in keyof G]: G[K] extends keyof INPUTS
    ? (input?: InputOf<G[K]>) => Promise<unknown>
    : never;
};

export type CCBridge = {
  platform: NodeJS.Platform;
  versions: { app: string; electron: string; chrome: string; node: string };
  events: {
    on: (name: PushEventName, listener: (payload: unknown) => void) => void;
    off: (name: PushEventName, listener: (payload: unknown) => void) => void;
    names: typeof EVENTS;
  };
} & { [G in keyof Channels]: InvokeNamespace<Channels[G]> };

declare global {
  /** 由 electron-vite define 注入的应用版本（package.json#version）。 */
  const __CC_VERSION__: string;

  interface Window {
    cc: CCBridge;
  }
}
