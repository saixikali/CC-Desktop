/**
 * 会话分组全局状态：
 * - spaceDir：主进程托管的中性目录 userData/chat-space。cwd 命中该目录的 thread
 *   即为「纯对话」会话（只读沙箱 + 免审批），侧栏归入「对话」分组展示。
 */
import { create } from "zustand";
import { bridge, call } from "../lib/ipc.ts";

/** Windows 路径归一化：斜杆统一、去尾部反斜杠、小写比较（与主进程 normProjectRoot 一致）。 */
function norm(p: string): string {
  return p.replace(/\//g, "\\").trim().toLowerCase().replace(/\\+$/, "");
}

interface ChatModeState {
  spaceDir: string | null;
  spaceReady: boolean;
  /** 拉取托管目录（主进程负责 mkdir）；幂等，并发调用共用同一个在途请求。 */
  initSpace: () => Promise<void>;
  /** cwd 是否为纯对话托管目录。spaceDir 未就绪时一律 false（列表会短暂归入任务侧，就绪后自动纠正）。 */
  isChatPath: (cwd: string | null | undefined) => boolean;
}

let inflight: Promise<void> | null = null;

export const useChatModeStore = create<ChatModeState>((set, get) => ({
  spaceDir: null,
  spaceReady: false,

  initSpace: () => {
    if (get().spaceReady) return Promise.resolve();
    if (!inflight) {
      inflight = (async () => {
        const dir = await call<string>(() => bridge().app.chatSpace({}));
        set({ spaceDir: dir, spaceReady: true });
      })().catch((err) => {
        // 失败允许后续重试。
        inflight = null;
        throw err;
      });
    }
    return inflight;
  },

  isChatPath: (cwd) => {
    const dir = get().spaceDir;
    if (!cwd || !dir) return false;
    return norm(cwd) === norm(dir);
  },
}));
