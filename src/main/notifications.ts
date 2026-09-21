/**
 * 系统通知（主进程）：
 *  - turn 完成/失败：遵循 notifyTurnCompleted；
 *  - 审批请求：遵循 notifyApprovals，同一 localId 只通知一次，结案后去重集清空；
 *  - 窗口可见且聚焦时不打扰；点击通知激活窗口并广播上下文，
 *    渲染层据此切到聊天/定位审批。
 */
import { Notification, type BrowserWindow } from "electron";
import { EVENTS } from "../shared/ipc/contract.ts";
import { logger } from "./logging.ts";
import { resourcePath } from "./tray.ts";
import type { PendingApproval } from "./backend/conversation-backend.ts";
import type { LocalPrefs } from "../shared/ipc/contract.ts";

type Broadcast = (event: string, payload?: unknown) => void;

const APPROVAL_TITLES: Record<string, string> = {
  "requestPatchApply": "需要确认文件修改",
  "item/commandExecution/requestApproval": "需要确认命令执行",
  "applyPatch": "需要确认文件修改",
  "elicit": "需要你提供信息",
};

export class NotificationService {
  private readonly notifiedApprovals = new Set<string>();

  constructor(
    private readonly backend: import("node:events").EventEmitter,
    private readonly getWindow: () => BrowserWindow | null,
    private readonly getPrefs: () => LocalPrefs,
    private readonly broadcast: Broadcast,
  ) {}

  bind(): void {
    this.backend.on("notification", (envelope) => this.onTurnNotification(envelope));
    this.backend.on("approval", (approval) => this.onApproval(approval));
  }

  /** 窗口当前可见且聚焦时，系统通知属于打扰，跳过。 */
  private userActive(): boolean {
    const win = this.getWindow();
    return Boolean(win && win.isVisible() && win.isFocused());
  }

  private activate(payload: unknown): void {
    const win = this.getWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    this.broadcast(EVENTS.appShow, payload);
  }

  private notify(title: string, body: string, payload: unknown): void {
    try {
      const n = new Notification({
        title,
        body,
        icon: resourcePath("icon.png"),
        silent: false,
      });
      n.on("click", () => this.activate(payload));
      n.show();
      logger.info("系统通知已发送", { title, body });
    } catch (err) {
      logger.warn("系统通知发送失败", { message: (err as Error).message });
    }
  }

  private onTurnNotification(envelope: { method?: string; params?: unknown }): void {
    if (envelope.method !== "turn/completed") return;
    const prefs = this.getPrefs();
    if (!prefs.notifyTurnCompleted || this.userActive()) return;

    const p = (envelope.params ?? {}) as {
      threadId?: string;
      turn?: { status?: string; error?: { message?: string } | null };
    };
    const failed = p.turn?.status === "failed" || Boolean(p.turn?.error);
    this.notify(
      failed ? "Claude Code 回合失败" : "Claude Code 已完成回复",
      failed ? p.turn?.error?.message ?? "点击查看详情" : "点击回到会话",
      { kind: "turn", threadId: p.threadId ?? null, failed },
    );
  }

  private onApproval(approval: PendingApproval): void {
    // 只在新挂起时通知；resolved/expired 时清理去重记录。
    if (approval.status !== "pending") {
      this.notifiedApprovals.delete(approval.localId);
      return;
    }
    const prefs = this.getPrefs();
    if (!prefs.notifyApprovals || this.userActive()) return;
    if (this.notifiedApprovals.has(approval.localId)) return;
    this.notifiedApprovals.add(approval.localId);

    const title = APPROVAL_TITLES[approval.method] ?? "需要你的确认";
    const body = this.approvalSummary(approval);
    this.notify(title, body, { kind: "approval", threadId: approval.threadId ?? null });
  }

  private approvalSummary(approval: PendingApproval): string {
    const params = (approval.params ?? {}) as Record<string, unknown>;
    const command = this.findString(params, ["command", "cmd"]);
    if (command) return command.length > 120 ? `${command.slice(0, 120)}…` : command;
    const filePath = this.findString(params, ["path", "filePath", "filename"]);
    if (filePath) return filePath;
    return "点击查看并处理";
  }

  private findString(obj: unknown, keys: string[]): string | null {
    if (!obj || typeof obj !== "object") return null;
    for (const k of keys) {
      const v = (obj as Record<string, unknown>)[k];
      if (typeof v === "string" && v.trim()) return v;
    }
    // 浅递归一层，覆盖 {input:{command}} 之类的包装。
    for (const v of Object.values(obj as Record<string, unknown>)) {
      if (v && typeof v === "object") {
        const hit = this.findString(v, keys);
        if (hit) return hit;
      }
    }
    return null;
  }
}
