/**
 * ConversationBackend：会话主轴的后端无关抽象。
 *  - 覆盖 threads / turns / approvals 与事件推送（notification / approval）
 *  - fs、PTY 等非对话能力不在此抽象，由主进程本地服务提供
 *  - 事件统一使用通知信封形状（{ method, params }）
 */
import { EventEmitter } from "node:events";

export type BackendId = "claude";

export type ApprovalStatus = "pending" | "resolved" | "expired";

/** 待审批请求（命令执行 / 文件修改），渲染层审批坞与系统通知共用。 */
export interface PendingApproval {
  localId: string;
  serverId: string | number;
  method: string;
  params: unknown;
  threadId?: string;
  receivedAt: number;
  status: ApprovalStatus;
}

export interface ConversationApprovals {
  list(): PendingApproval[];
  resolveCommand(localId: string, decision: unknown): Promise<void>;
  resolveFileChange(localId: string, decision: unknown): Promise<void>;
  respondError(localId: string, code: number, message: string, data?: unknown): Promise<void>;
}

export declare interface ConversationBackend {
  /** 规范化后的通知信封（形状 { method, params }）。 */
  on(event: "notification", listener: (envelope: Record<string, unknown>) => void): this;
  on(event: "approval", listener: (approval: PendingApproval) => void): this;
}

export interface ConversationBackend extends EventEmitter {
  readonly id: BackendId;
  /** 该 threadId 是否由此后端承载（路由判定）。 */
  owns(threadId: string): boolean;
  /** 该 localId 的待审批是否属于此后端。 */
  ownsApproval(localId: string): boolean;

  listThreads(params: unknown): Promise<unknown>;
  readThread(params: { threadId: string }): Promise<unknown>;
  startThread(params: Record<string, unknown>): Promise<unknown>;
  resumeThread(params: { threadId: string } & Record<string, unknown>): Promise<unknown>;
  archiveThread(params: { threadId: string }): Promise<unknown>;
  unarchiveThread(params: { threadId: string }): Promise<unknown>;
  deleteThread(params: { threadId: string }): Promise<unknown>;
  setThreadName(params: Record<string, unknown>): Promise<unknown>;
  listTurns(params: { threadId: string; limit?: number; cursor?: string | null }): Promise<unknown>;
  searchThreads(params: Record<string, unknown>): Promise<unknown>;

  startTurn(params: Record<string, unknown>): Promise<unknown>;
  steerTurn(params: Record<string, unknown>): Promise<unknown>;
  interruptTurn(params: { threadId: string }): Promise<unknown>;

  readonly approvals: ConversationApprovals;

  /** 停止全部会话进程并释放资源（应用退出前调用）。 */
  dispose(): void;
}
