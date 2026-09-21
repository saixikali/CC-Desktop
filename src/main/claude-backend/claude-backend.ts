/**
 * ClaudeBackend：基于 @anthropic-ai/claude-agent-sdk 的第二会话后端。
 *
 * 设计要点：
 *  - 每个线程一个常驻 query()（流式输入模式），回合 = 向输入流推一条用户消息；
 *    回合中追加消息（steer）= 再推一条，由 CLI 折入当前回合
 *  - SDK 消息在泵循环中规范化为统一通知信封（turn/*、item/*、error、
 *    thread/tokenUsage/updated），渲染层 thread-view/timeline 零改动复用
 *  - canUseTool 审批映射为 PendingApproval（命令 → commandExecution 卡、
 *    文件编辑 → fileChange 卡），决议在适配器内闭合，无需回传 JSON-RPC
 *  - 会话登记（registry.json）+ 回合转录（transcript-<id>.jsonl）持久化到
 *    userData/claude-backend/，支撑线程列表、搜索与历史恢复
 *  - session_id 在 system/init 到达后登记；resume 线程用 options.resume 续接
 *
 * 已知边界（v1）：
 *  - AskUserQuestion 等交互式提问直接拒绝（渲染层卡片形状待适配）
 *  - 子代理（Task）内部输出不展示；Windows 无系统级沙箱，只读语义靠
 *    permissionPrompts:"none"（未预授权工具一律拒绝）近似
 */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  query,
  type Query,
  type PermissionResult,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { logger } from "../logging.ts";
import type { PendingApproval } from "../backend/conversation-backend.ts";
import type { ConversationApprovals, ConversationBackend } from "../backend/conversation-backend.ts";
import { appendUsage } from "./usage-ledger.ts";

/* ---------------- 持久化模型 ---------------- */

interface ClaudeThreadRecord {
  threadId: string;
  sessionId: string | null;
  cwd: string;
  name: string | null;
  preview: string;
  archived: boolean;
  /** 秒级时间戳（normalizeThread 直接可读）。 */
  createdAt: number;
  updatedAt: number;
  model: string | null;
  /** 只读聊天线程：未预授权工具一律自动拒绝，不弹审批。 */
  readOnly: boolean;
  /** 会话级权限模式（default/acceptEdits/plan/bypassPermissions）。 */
  permissionMode: "default" | "acceptEdits" | "plan" | "bypassPermissions";
}

interface StoredTurn {
  id: string;
  status: "inProgress" | "completed" | "failed" | "interrupted";
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  items: Array<Record<string, unknown>>;
  error: { message: string } | null;
}

interface OpenTurn extends StoredTurn {
  /** 流式块登记：text/thinking 记条目 id，tool 记名称与累积的 input JSON。 */
  blocks: Map<
    number,
    { itemId: string; kind: "text" | "thinking" | "tool"; name: string; done: boolean; json: string }
  >;
  toolItems: Map<string, { itemId: string; type: string }>;
  sawStream: boolean;
  interrupted: boolean;
}

interface ClaudeSession {
  record: ClaudeThreadRecord;
  query: Query | null;
  input: UserInputQueue;
  controller: AbortController;
  openTurn: OpenTurn | null;
}

/* ---------------- 输入队列（流式输入模式的可推送源） ---------------- */

class UserInputQueue {
  private buffer: SDKUserMessage[] = [];
  private waiters: Array<(r: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.buffer.push(message);
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }

  async *iterate(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = this.buffer.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.closed) return;
      const result = await new Promise<IteratorResult<SDKUserMessage>>((resolve) =>
        this.waiters.push(resolve),
      );
      if (result.done) return;
      yield result.value;
    }
  }
}

/* ---------------- 工具映射 ---------------- */

const FILE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function s(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Claude 工具调用 → 渲染层 timeline 条目。 */
function itemForTool(useId: string, toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  if (toolName === "Bash") {
    return {
      type: "commandExecution",
      id: useId,
      command: s(input["command"]) || toolName,
      status: "inProgress",
      aggregatedOutput: "",
    };
  }
  if (FILE_EDIT_TOOLS.has(toolName)) {
    const path = s(input["file_path"]) || s(input["notebook_path"]) || s(input["path"]);
    const changes: Array<Record<string, unknown>> = [];
    if (toolName === "MultiEdit" && Array.isArray(input["edits"])) {
      const seen = new Set<string>();
      for (const e of input["edits"] as Array<Record<string, unknown>>) {
        const p = s(e?.["file_path"]) || path;
        if (p && !seen.has(p)) {
          seen.add(p);
          changes.push({ path: p, kind: "update" });
        }
      }
    }
    if (changes.length === 0 && path) {
      changes.push({
        path,
        kind: toolName === "Write" ? "add" : "update",
        // Edit 携带 old/new 字符串，可合成 ± diff 供 DiffView 渲染。
        ...(toolName === "Edit" && s(input["old_string"])
          ? {
              diff: [
                "@@ 工作区副本 → 目标文件 @@",
                ...s(input["old_string"]).split("\n").map((l) => `-${l}`),
                ...s(input["new_string"]).split("\n").map((l) => `+${l}`),
              ].join("\n"),
            }
          : {}),
      });
    }
    return { type: "fileChange", id: useId, changes, status: "inProgress" };
  }
  return {
    type: "mcpToolCall",
    id: useId,
    server: "claude",
    tool: toolName,
    status: "inProgress",
    arguments: input,
    progressLog: [],
  };
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" ? s((c as Record<string, unknown>)["text"]) : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** 推理力度 → Claude effortLevel（尽力映射，SDK 不支持时静默忽略）。 */
function mapEffort(effort: unknown): "low" | "medium" | "high" | null {
  switch (effort) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
    case "ultra":
      return "high";
    default:
      return null;
  }
}

/** 权限模式白名单（SDK permissionMode）；未知值回退 default。 */
function mapPermissionMode(v: unknown): "default" | "acceptEdits" | "plan" | "bypassPermissions" {
  switch (v) {
    case "acceptEdits":
    case "plan":
    case "bypassPermissions":
      return v;
    default:
      return "default";
  }
}

/* ---------------- 文件审批的 diff 数据 ---------------- */

/** 审批卡 diff 内容单侧上限（字符），超出截断并标记，防止超大文件撑爆 UI。 */
const APPROVAL_TEXT_CAP = 200_000;

interface FileChangeDetail {
  path: string;
  kind: "add" | "update";
  /** 磁盘现状（新建文件为 null）；读取失败/超大文件缺省，渲染端回退通用卡片。 */
  oldText?: string | null;
  newText?: string | null;
}

/** 尽力读取磁盘现状，供审批卡渲染 diff；任何失败静默降级。 */
async function readOldText(path: string): Promise<string | null> {
  try {
    if (!path || !existsSync(path)) return null;
    if (statSync(path).size > APPROVAL_TEXT_CAP) return null;
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function capText(text: string | null): string | null | undefined {
  if (text === null) return null;
  if (text === undefined) return undefined;
  if (text.length <= APPROVAL_TEXT_CAP) return text;
  return text.slice(0, APPROVAL_TEXT_CAP) + "\n…（内容过长已截断）";
}

/** 把 Write/Edit/MultiEdit/NotebookEdit 的入参整理成带新旧内容的变更明细。 */
async function buildFileChanges(
  toolName: string,
  input: Record<string, unknown>,
): Promise<FileChangeDetail[]> {
  const path = s(input["file_path"]) || s(input["notebook_path"]) || toolName;
  const kind: "add" | "update" = toolName === "Write" ? "add" : "update";
  try {
    if (toolName === "Write") {
      const oldText = kind === "add" ? null : await readOldText(path);
      return [
        { path, kind, oldText: capText(oldText), newText: capText(s(input["content"])) },
      ];
    }
    if (toolName === "Edit") {
      const oldText = await readOldText(path);
      const needle = input["old_string"];
      const replacement = input["new_string"];
      let newText: string | null = null;
      if (typeof oldText === "string" && typeof needle === "string" && typeof replacement === "string") {
        newText =
          input["replace_all"] === true
            ? oldText.split(needle).join(replacement)
            : oldText.replace(needle, () => replacement);
      }
      return [
        {
          path,
          kind,
          oldText: capText(newText === null ? (typeof needle === "string" ? needle : null) : oldText),
          newText: capText(newText === null ? (typeof replacement === "string" ? replacement : null) : newText),
        },
      ];
    }
    if (toolName === "MultiEdit") {
      const oldText = await readOldText(path);
      const edits = Array.isArray(input["edits"]) ? input["edits"] : [];
      let current = typeof oldText === "string" ? oldText : null;
      if (current !== null) {
        for (const raw of edits) {
          const e = (raw ?? {}) as Record<string, unknown>;
          const needle = e["old_string"];
          const replacement = e["new_string"];
          if (typeof needle === "string" && typeof replacement === "string") {
            current =
              e["replace_all"] === true
                ? current.split(needle).join(replacement)
                : current.replace(needle, () => replacement);
          }
        }
      }
      if (current !== null) {
        return [{ path, kind, oldText: capText(oldText), newText: capText(current) }];
      }
      // 磁盘现状不可读：退化为逐条 old/new 片段对照。
      return edits.map((raw) => {
        const e = (raw ?? {}) as Record<string, unknown>;
        return {
          path,
          kind,
          oldText: capText(typeof e["old_string"] === "string" ? e["old_string"] : null),
          newText: capText(typeof e["new_string"] === "string" ? e["new_string"] : null),
        } satisfies FileChangeDetail;
      });
    }
    // NotebookEdit：replace 模式带 old_source/new_source。
    const oldSource = s(input["old_source"]);
    const newSource = s(input["new_source"]);
    if (oldSource || newSource) {
      return [{ path, kind, oldText: capText(oldSource || null), newText: capText(newSource || null) }];
    }
    return [{ path, kind, oldText: undefined, newText: undefined }];
  } catch {
    return [{ path, kind, oldText: undefined, newText: undefined }];
  }
}

/* ---------------- ClaudeBackend ---------------- */

export declare interface ClaudeBackend {
  on(event: "notification", listener: (envelope: Record<string, unknown>) => void): this;
  on(event: "approval", listener: (approval: PendingApproval) => void): this;
}

export class ClaudeBackend extends EventEmitter implements ConversationBackend {
  readonly id = "claude" as const;

  private readonly dir: string;
  private readonly records = new Map<string, ClaudeThreadRecord>();
  private readonly sessions = new Map<string, ClaudeSession>();
  private readonly turnsCache = new Map<string, StoredTurn[]>();
  private readonly pending = new Map<
    string,
    {
      approval: PendingApproval;
      resolve: (r: PermissionResult) => void;
      suggestions: Array<Record<string, unknown>>;
    }
  >();
  private loaded = false;

  constructor(private readonly userDataDir: string) {
    super();
    this.dir = join(userDataDir, "claude-backend");
  }

  /* ---------- 存储 ---------- */

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      await mkdir(this.dir, { recursive: true });
      const raw = await readFile(join(this.dir, "registry.json"), "utf8");
      const parsed = JSON.parse(raw) as { threads?: ClaudeThreadRecord[] };
      for (const rec of parsed.threads ?? []) {
        if (rec?.threadId) this.records.set(rec.threadId, rec);
      }
    } catch {
      /* 首次运行无登记文件 */
    }
  }

  private async saveRegistry(): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
      const tmp = join(this.dir, "registry.json.tmp");
      await writeFile(tmp, JSON.stringify({ version: 1, threads: [...this.records.values()] }));
      await rename(tmp, join(this.dir, "registry.json"));
    } catch (err) {
      logger.warn("Claude 会话登记写入失败", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async loadTurns(threadId: string): Promise<StoredTurn[]> {
    const cached = this.turnsCache.get(threadId);
    if (cached) return cached;
    const turns: StoredTurn[] = [];
    try {
      const raw = await readFile(join(this.dir, `transcript-${threadId}.jsonl`), "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as { k?: string; turn?: StoredTurn };
          if (parsed.k === "turn" && parsed.turn?.id) turns.push(parsed.turn);
        } catch {
          /* 跳过损坏行 */
        }
      }
    } catch {
      /* 无转录 */
    }
    this.turnsCache.set(threadId, turns);
    return turns;
  }

  private async persistTurn(threadId: string, turn: StoredTurn): Promise<void> {
    const turns = await this.loadTurns(threadId);
    const idx = turns.findIndex((t) => t.id === turn.id);
    if (idx >= 0) turns[idx] = turn;
    else turns.push(turn);
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(
        join(this.dir, `transcript-${threadId}.jsonl`),
        turns.map((t) => JSON.stringify({ k: "turn", turn: t })).join("\n") + "\n",
        "utf8",
      );
    } catch (err) {
      logger.warn("Claude 回合转录写入失败", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /* ---------- 视图与事件 ---------- */

  private threadRaw(rec: ClaudeThreadRecord): Record<string, unknown> {
    return {
      id: rec.threadId,
      name: rec.name,
      preview: rec.preview,
      cwd: rec.cwd,
      status: "idle",
      archived: rec.archived,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
    };
  }

  private turnRaw(turn: StoredTurn): Record<string, unknown> {
    return {
      id: turn.id,
      status: turn.status,
      startedAt: turn.startedAt / 1000,
      completedAt: turn.endedAt != null ? turn.endedAt / 1000 : null,
      durationMs: turn.durationMs,
      error: turn.error,
      items: turn.items,
    };
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.emit("notification", { method, params, emittedAtMs: Date.now() });
  }

  private touch(rec: ClaudeThreadRecord): void {
    rec.updatedAt = Math.floor(Date.now() / 1000);
    void this.saveRegistry();
  }

  /* ---------- ConversationBackend ---------- */

  owns(threadId: string): boolean {
    return this.records.has(threadId);
  }

  ownsApproval(localId: string): boolean {
    return this.pending.has(localId);
  }

  async listThreads(_params: unknown): Promise<unknown> {
    await this.ensureLoaded();
    return { data: [...this.records.values()].map((r) => this.threadRaw(r)), nextCursor: null };
  }

  async readThread(params: { threadId: string }): Promise<unknown> {
    await this.ensureLoaded();
    const rec = this.records.get(params.threadId);
    if (!rec) throw new Error("会话不存在或不是 Claude 会话");
    return { thread: this.threadRaw(rec) };
  }

  async startThread(params: Record<string, unknown>): Promise<unknown> {
    await this.ensureLoaded();
    const cwd = s(params["cwd"]) || this.userDataDir;
    // 确保工作目录存在：Windows 下 spawn 的 cwd 不存在会抛 ENOENT。
    await mkdir(cwd, { recursive: true });
    const readOnly =
      params["sandbox"] === "read-only" ||
      params["approvalPolicy"] === "never" ||
      params["approvalPolicy"] === "untrusted";
    const rec: ClaudeThreadRecord = {
      threadId: randomUUID(),
      sessionId: null,
      cwd,
      name: null,
      preview: "",
      archived: false,
      createdAt: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000),
      model: s(params["model"]) || null,
      readOnly,
      permissionMode: readOnly ? "default" : mapPermissionMode(params["permissionMode"]),
    };
    this.records.set(rec.threadId, rec);
    await this.saveRegistry();
    return {
      thread: this.threadRaw(rec),
      model: rec.model ?? "claude",
      cwd,
      runtimeWorkspaceRoots: [cwd],
    };
  }

  async resumeThread(params: { threadId: string }): Promise<unknown> {
    await this.ensureLoaded();
    const rec = this.records.get(params.threadId);
    if (!rec) throw new Error("会话不存在或不是 Claude 会话");
    const turns = await this.loadTurns(params.threadId);
    return { thread: this.threadRaw(rec), turns: turns.map((t) => this.turnRaw(t)) };
  }

  async archiveThread(params: { threadId: string }): Promise<unknown> {
    const rec = this.records.get(params.threadId);
    if (rec) {
      rec.archived = true;
      this.touch(rec);
      this.notify("thread/archived", { threadId: rec.threadId });
    }
    return {};
  }

  async unarchiveThread(params: { threadId: string }): Promise<unknown> {
    const rec = this.records.get(params.threadId);
    if (rec) {
      rec.archived = false;
      this.touch(rec);
      this.notify("thread/unarchived", { threadId: rec.threadId });
    }
    return {};
  }

  async deleteThread(params: { threadId: string }): Promise<unknown> {
    const rec = this.records.get(params.threadId);
    if (!rec) return {};
    await this.closeSession(params.threadId);
    this.records.delete(params.threadId);
    this.turnsCache.delete(params.threadId);
    await this.saveRegistry();
    try {
      await unlink(join(this.dir, `transcript-${params.threadId}.jsonl`));
    } catch {
      /* 无转录文件 */
    }
    this.notify("thread/deleted", { threadId: params.threadId });
    return {};
  }

  async setThreadName(params: Record<string, unknown>): Promise<unknown> {
    const threadId = s(params["threadId"]);
    const rec = this.records.get(threadId);
    const name = s(params["name"]) || s(params["threadName"]) || null;
    if (rec) {
      rec.name = name;
      this.touch(rec);
      this.notify("thread/name/updated", { threadId, threadName: name });
    }
    return {};
  }

  async listTurns(params: { threadId: string; limit?: number }): Promise<unknown> {
    await this.ensureLoaded();
    if (!this.records.has(params.threadId)) return { data: [], nextCursor: null };
    const turns = await this.loadTurns(params.threadId);
    return { data: turns.map((t) => this.turnRaw(t)), nextCursor: null };
  }

  async searchThreads(params: Record<string, unknown>): Promise<unknown> {
    await this.ensureLoaded();
    const q = s(params["query"]).toLowerCase();
    const data = q
      ? [...this.records.values()]
          .filter(
            (r) =>
              (r.name ?? "").toLowerCase().includes(q) || r.preview.toLowerCase().includes(q),
          )
          .map((r) => this.threadRaw(r))
      : [];
    return { data, nextCursor: null };
  }

  /* ---------- 会话进程 ---------- */

  private async closeSession(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;
    this.sessions.delete(threadId);
    session.input.close();
    try {
      session.controller.abort();
    } catch {
      /* 忽略 */
    }
  }

  private async ensureSession(rec: ClaudeThreadRecord): Promise<ClaudeSession> {
    const existing = this.sessions.get(rec.threadId);
    if (existing) return existing;
    const input = new UserInputQueue();
    const controller = new AbortController();
    const session: ClaudeSession = {
      record: rec,
      query: null,
      input,
      controller,
      openTurn: null,
    };
    const options: Record<string, unknown> = {
      cwd: rec.cwd,
      model: rec.model ?? undefined,
      permissionMode: rec.permissionMode,
      permissionPrompts: rec.readOnly ? "none" : "host",
      includePartialMessages: true,
      abortController: controller,
      canUseTool: (toolName: string, toolInput: Record<string, unknown>, opts: {
        signal: AbortSignal;
        suggestions?: unknown;
      }) => this.handleCanUseTool(rec, session, toolName, toolInput, opts),
      ...(rec.sessionId ? { resume: rec.sessionId } : {}),
    };
    const q = query({
      prompt: input.iterate(),
      options: options as Parameters<typeof query>[0]["options"],
    });
    session.query = q;
    this.sessions.set(rec.threadId, session);
    void this.pump(rec, session);
    return session;
  }

  /** SDK 消息泵：唯一的规范化出口，进程退出时兜底关闭未完成回合。 */
  private async pump(rec: ClaudeThreadRecord, session: ClaudeSession): Promise<void> {
    try {
      for await (const msg of session.query!) {
        this.handleSdkMessage(rec, session, msg);
      }
    } catch (err) {
      logger.warn("Claude 会话异常退出", {
        threadId: rec.threadId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    this.sessions.delete(rec.threadId);
    const open = session.openTurn;
    if (open) {
      session.openTurn = null;
      open.status = "failed";
      open.error = { message: "Claude 会话进程已退出" };
      open.endedAt = Date.now();
      open.durationMs = open.endedAt - open.startedAt;
      this.notify("turn/completed", { threadId: rec.threadId, turn: this.turnRaw(open) });
      await this.persistTurn(rec.threadId, open as StoredTurn);
      this.touch(rec);
    }
  }

  private handleSdkMessage(
    rec: ClaudeThreadRecord,
    session: ClaudeSession,
    msg: SDKMessage,
  ): void {
    const m = msg as unknown as Record<string, unknown>;
    const type = s(m["type"]);

    if (type === "system" && s(m["subtype"]) === "init") {
      const sid = s(m["session_id"]);
      if (sid && sid !== rec.sessionId) {
        rec.sessionId = sid;
        void this.saveRegistry();
      }
      return;
    }

    if (type === "stream_event") {
      this.handleStreamEvent(rec, session, m);
      return;
    }

    if (type === "assistant") {
      this.handleAssistantMessage(rec, session, m);
      return;
    }

    if (type === "user") {
      this.handleToolResults(rec, session, m);
      return;
    }

    if (type === "result") {
      void this.handleResult(rec, session, m);
      return;
    }
  }

  private handleStreamEvent(
    rec: ClaudeThreadRecord,
    session: ClaudeSession,
    m: Record<string, unknown>,
  ): void {
    const turn = session.openTurn;
    if (!turn) return;
    turn.sawStream = true;
    const threadId = rec.threadId;
    const event = (m["event"] ?? {}) as Record<string, unknown>;
    const index = num(event["index"]);
    const evType = s(event["type"]);
    const turnId = turn.id;

    if (evType === "content_block_start") {
      const block = (event["content_block"] ?? {}) as Record<string, unknown>;
      const bType = s(block["type"]);
      if (bType === "text" || bType === "thinking") {
        const itemId = `${turnId}-${bType === "text" ? "a" : "t"}-${index}`;
        const item: Record<string, unknown> =
          bType === "text"
            ? { type: "agentMessage", id: itemId, text: "" }
            : { type: "reasoning", id: itemId, summary: [], content: [""] };
        turn.items.push(item);
        turn.blocks.set(index, { itemId, kind: bType, name: "", done: false, json: "" });
        this.notify("item/started", { threadId, turnId, item });
        return;
      }
      if (bType === "tool_use") {
        const useId = s(block["id"]) || `${turnId}-tool-${index}`;
        const toolName = s(block["name"]);
        const item = itemForTool(useId, toolName, {});
        turn.items.push(item);
        turn.toolItems.set(useId, { itemId: useId, type: s(item["type"]) });
        turn.blocks.set(index, { itemId: useId, kind: "tool", name: toolName, done: false, json: "" });
        this.notify("item/started", { threadId, turnId, item });
        return;
      }
      return;
    }

    if (evType === "content_block_delta") {
      const delta = (event["delta"] ?? {}) as Record<string, unknown>;
      const dType = s(delta["type"]);
      const block = turn.blocks.get(index);
      if (dType === "text_delta" && block?.kind === "text" && !block.done) {
        const text = s(delta["text"]);
        if (!text) return;
        const item = turn.items.find((i) => i["id"] === block.itemId);
        if (item) item["text"] = s(item["text"]) + text;
        this.notify("item/agentMessage/delta", { threadId, turnId, itemId: block.itemId, delta: text });
        return;
      }
      if (dType === "thinking_delta" && block?.kind === "thinking" && !block.done) {
        const text = s(delta["thinking"]);
        if (!text) return;
        const item = turn.items.find((i) => i["id"] === block.itemId);
        if (item && Array.isArray(item["content"])) (item["content"] as string[])[0] += text;
        this.notify("item/reasoning/textDelta", {
          threadId,
          turnId,
          itemId: block.itemId,
          delta: text,
          contentIndex: 0,
        });
        return;
      }
      if (dType === "input_json_delta") {
        const b = turn.blocks.get(index);
        if (b?.kind === "tool") b.json += s(delta["partial_json"]);
        return;
      }
      return;
    }

    if (evType === "content_block_stop") {
      const block = turn.blocks.get(index);
      if (!block || block.done) return;
      block.done = true;
      if (block.kind === "tool") {
        // 工具入参经 input_json_delta 分片累积，块结束时解析并回填条目字段
        //（命令行 / 文件路径 / 参数），仍由 tool_result 负责最终闭合。
        const item = turn.items.find((i) => i["id"] === block.itemId);
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = block.json ? (JSON.parse(block.json) as Record<string, unknown>) : {};
        } catch {
          parsed = null;
        }
        if (item && parsed) {
          Object.assign(item, itemForTool(block.itemId, block.name, parsed));
          this.notify("item/started", { threadId, turnId: turn.id, item });
        }
        return;
      }
      const item = turn.items.find((i) => i["id"] === block.itemId);
      if (item) this.notify("item/completed", { threadId, turnId: turn.id, item });
    }
  }

  /** assistant 消息：只兜底创建流式路径没覆盖的 tool_use 块。 */
  private handleAssistantMessage(
    rec: ClaudeThreadRecord,
    session: ClaudeSession,
    m: Record<string, unknown>,
  ): void {
    const turn = session.openTurn;
    if (!turn || m["parent_tool_use_id"] != null) return;
    const message = (m["message"] ?? {}) as Record<string, unknown>;
    const content = Array.isArray(message["content"]) ? message["content"] : [];
    for (const block of content) {
      const b = (block ?? {}) as Record<string, unknown>;
      if (s(b["type"]) !== "tool_use") continue;
      const useId = s(b["id"]);
      if (!useId || turn.toolItems.has(useId)) continue;
      const toolName = s(b["name"]);
      const input = (b["input"] ?? {}) as Record<string, unknown>;
      const item = itemForTool(useId, toolName, input);
      turn.items.push(item);
      turn.toolItems.set(useId, { itemId: useId, type: s(item["type"]) });
      this.notify("item/started", { threadId: rec.threadId, turnId: turn.id, item });
    }
  }

  /** user 消息里的 tool_result：闭合对应工具条目（输出/状态）。 */
  private handleToolResults(
    rec: ClaudeThreadRecord,
    session: ClaudeSession,
    m: Record<string, unknown>,
  ): void {
    const turn = session.openTurn;
    if (!turn || m["parent_tool_use_id"] != null) return;
    const message = (m["message"] ?? {}) as Record<string, unknown>;
    const content = Array.isArray(message["content"]) ? message["content"] : [];
    for (const block of content) {
      const b = (block ?? {}) as Record<string, unknown>;
      if (s(b["type"]) !== "tool_result") continue;
      const useId = s(b["tool_use_id"]);
      const entry = useId ? turn.toolItems.get(useId) : null;
      if (!entry) continue;
      const item = turn.items.find((i) => i["id"] === entry.itemId);
      if (!item) continue;
      const text = toolResultText(b["content"]);
      const failed = b["is_error"] === true;
      if (entry.type === "commandExecution") {
        item["aggregatedOutput"] = text;
        item["status"] = failed ? "failed" : "completed";
        item["exitCode"] = failed ? 1 : 0;
      } else if (entry.type === "fileChange") {
        item["status"] = failed ? "failed" : "completed";
      } else {
        item["status"] = failed ? "failed" : "completed";
        item["result"] = { content: text };
        if (failed) item["error"] = { message: text };
      }
      this.notify("item/completed", { threadId: rec.threadId, turnId: turn.id, item });
    }
  }

  private async handleResult(
    rec: ClaudeThreadRecord,
    session: ClaudeSession,
    m: Record<string, unknown>,
  ): Promise<void> {
    const turn = session.openTurn;
    const subtype = s(m["subtype"]);
    if (!turn) return;
    session.openTurn = null;
    turn.endedAt = Date.now();
    turn.durationMs = turn.endedAt - turn.startedAt;
    const isError = m["is_error"] === true || subtype !== "success";
    if (turn.interrupted) {
      turn.status = "interrupted";
    } else if (isError) {
      turn.status = "failed";
      const errors = Array.isArray(m["errors"]) ? m["errors"].map(s).filter(Boolean) : [];
      const resultText = s(m["result"]);
      const message = errors[0] || resultText || `回合失败（${subtype || "unknown"}）`;
      turn.error = { message };
      this.notify("error", { threadId: rec.threadId, turnId: turn.id, error: { message }, willRetry: false });
    } else {
      turn.status = "completed";
    }
    this.notify("turn/completed", { threadId: rec.threadId, turn: this.turnRaw(turn) });

    // 用量：normalizeTokenUsage 读取 total.{totalTokens,inputTokens,...}。
    const usage = (m["usage"] ?? {}) as Record<string, unknown>;
    const inputTokens = num(usage["input_tokens"]);
    const cached = num(usage["cache_read_input_tokens"]) + num(usage["cache_creation_input_tokens"]);
    const outputTokens = num(usage["output_tokens"]);
    this.notify("thread/tokenUsage/updated", {
      threadId: rec.threadId,
      tokenUsage: {
        total: {
          totalTokens: inputTokens + cached + outputTokens,
          inputTokens,
          cachedInputTokens: cached,
          outputTokens,
          reasoningOutputTokens: 0,
        },
        modelContextWindow: null,
      },
    });

    // 用量台账：供设置页统计（费用/分模型取 SDK modelUsage，中转下为真实模型名）。
    const costUsd = typeof m["total_cost_usd"] === "number" ? m["total_cost_usd"] : null;
    const modelUsage = (m["modelUsage"] ?? null) as Record<string, Record<string, unknown>> | null;
    const modelKey =
      modelUsage && typeof modelUsage === "object"
        ? Object.keys(modelUsage)[0] || rec.model || "claude"
        : rec.model || "claude";
    await appendUsage(this.dir, {
      ts: Date.now(),
      threadId: rec.threadId,
      model: modelKey,
      inputTokens,
      cachedTokens: cached,
      outputTokens,
      costUsd,
      durationMs: typeof m["duration_ms"] === "number" ? m["duration_ms"] : null,
    });

    // 首个回合结束后用首条用户输入命名线程。
    if (!rec.name) {
      const firstUser = turn.items.find((i) => i["type"] === "userMessage");
      const text = firstUser ? s(firstUser["text"]) : "";
      if (text) {
        rec.name = text.slice(0, 40);
        this.notify("thread/name/updated", { threadId: rec.threadId, threadName: rec.name });
      }
    }
    const agentItems = turn.items.filter((i) => i["type"] === "agentMessage");
    const lastAgent = s(
      agentItems.length > 0
        ? ((agentItems[agentItems.length - 1] as Record<string, unknown>)["text"] ?? "")
        : "",
    );
    if (lastAgent) rec.preview = lastAgent.slice(0, 200);
    await this.persistTurn(rec.threadId, turn as StoredTurn);
    this.touch(rec);
  }

  /* ---------- 回合 ---------- */

  private extractText(input: unknown): string {
    if (!Array.isArray(input)) return "";
    return input
      .map((item) => {
        const i = (item ?? {}) as Record<string, unknown>;
        return s(i["text"]);
      })
      .filter(Boolean)
      .join("\n");
  }

  private pushUserMessage(session: ClaudeSession, text: string): void {
    session.input.push({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
      session_id: session.record.sessionId ?? "",
    } as SDKUserMessage);
  }

  async startTurn(params: Record<string, unknown>): Promise<unknown> {
    await this.ensureLoaded();
    const threadId = s(params["threadId"]);
    const rec = this.records.get(threadId);
    if (!rec) throw new Error("会话不存在或不是 Claude 会话");
    const existing = this.sessions.get(threadId);
    if (existing?.openTurn) return this.steerTurn(params);

    const session = await this.ensureSession(rec);
    if (session.openTurn) return this.steerTurn(params);

    const text = this.extractText(params["input"]);
    const turn: OpenTurn = {
      id: randomUUID(),
      status: "inProgress",
      startedAt: Date.now(),
      endedAt: null,
      durationMs: null,
      items: [],
      error: null,
      blocks: new Map(),
      toolItems: new Map(),
      sawStream: false,
      interrupted: false,
    };
    session.openTurn = turn;

    // 逐回合覆盖：模型 / 推理力度（尽力而为，SDK 拒绝时静默忽略）。
    const model = s(params["model"]);
    if (model) {
      rec.model = model;
      void session.query?.setModel(model).catch(() => undefined);
    }
    const effort = mapEffort(params["effort"]);
    if (effort) {
      void session.query
        ?.applyFlagSettings({ effortLevel: effort } as never)
        .catch(() => undefined);
    }
    // 当轮权限模式覆盖：SDK 支持时即时生效，否则静默忽略（下次会话生效）。
    if (!rec.readOnly && params["permissionMode"] !== undefined) {
      const mode = mapPermissionMode(params["permissionMode"]);
      rec.permissionMode = mode;
      void this.saveRegistry().catch(() => undefined);
      const setMode = (session.query as { setPermissionMode?: (m: string) => Promise<void> | void })
        ?.setPermissionMode;
      if (typeof setMode === "function") {
        void Promise.resolve(setMode.call(session.query, mode)).catch(() => undefined);
      }
    }

    this.notify("turn/started", { threadId, turn: this.turnRaw(turn) });
    const userItem = { type: "userMessage", id: `user-${turn.id}`, text };
    turn.items.push(userItem);
    this.notify("item/started", { threadId, turnId: turn.id, item: userItem });
    this.notify("item/completed", { threadId, turnId: turn.id, item: userItem });
    this.pushUserMessage(session, text);
    return { threadId, turn: this.turnRaw(turn) };
  }

  async steerTurn(params: Record<string, unknown>): Promise<unknown> {
    await this.ensureLoaded();
    const threadId = s(params["threadId"]);
    const session = this.sessions.get(threadId);
    const turn = session?.openTurn;
    if (!session || !turn) throw new Error("当前没有进行中的回合");
    const text = this.extractText(params["input"]);
    const userItem = { type: "userMessage", id: `user-${turn.id}-${turn.items.length}`, text };
    turn.items.push(userItem);
    this.notify("item/started", { threadId, turnId: turn.id, item: userItem });
    this.notify("item/completed", { threadId, turnId: turn.id, item: userItem });
    this.pushUserMessage(session, text);
    return { threadId, turnId: turn.id };
  }

  async interruptTurn(params: { threadId: string }): Promise<unknown> {
    await this.ensureLoaded();
    const session = this.sessions.get(params.threadId);
    const turn = session?.openTurn;
    if (!session || !turn) return {};
    turn.interrupted = true;
    try {
      await session.query?.interrupt();
    } catch (err) {
      logger.warn("Claude 中断请求失败", {
        threadId: params.threadId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    // 兜底：部分 CLI 版本中断后不再发 result，5s 后强制闭合。
    const timer = setTimeout(() => {
      if (session.openTurn === turn) {
        session.openTurn = null;
        turn.status = "interrupted";
        turn.endedAt = Date.now();
        turn.durationMs = turn.endedAt - turn.startedAt;
        this.notify("turn/completed", { threadId: params.threadId, turn: this.turnRaw(turn) });
        void this.persistTurn(params.threadId, turn as StoredTurn);
      }
    }, 5000);
    timer.unref?.();
    return {};
  }

  /* ---------- 审批 ---------- */

  private async handleCanUseTool(
    rec: ClaudeThreadRecord,
    _session: ClaudeSession,
    toolName: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; suggestions?: unknown },
  ): Promise<PermissionResult> {
    const commandLike =
      toolName === "Bash"
        ? s(input["command"]) || toolName
        : `${toolName} ${JSON.stringify(input).slice(0, 200)}`;
    const isFile = FILE_EDIT_TOOLS.has(toolName);
    const method = isFile
      ? "item/fileChange/requestApproval"
      : "item/commandExecution/requestApproval";
    const params: Record<string, unknown> = isFile
      ? {
          threadId: rec.threadId,
          changes: await buildFileChanges(toolName, input),
        }
      : { threadId: rec.threadId, command: commandLike };

    const approval: PendingApproval = {
      localId: randomUUID(),
      serverId: `claude:${toolName}:${Date.now()}`,
      method,
      params,
      threadId: rec.threadId,
      receivedAt: Date.now(),
      status: "pending",
    };
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(approval.localId, {
        approval,
        resolve,
        suggestions: Array.isArray(opts.suggestions)
          ? (opts.suggestions as Array<Record<string, unknown>>)
          : [],
      });
      this.emit("approval", approval);
    });
  }

  private settleApproval(localId: string, result: PermissionResult): void {
    const entry = this.pending.get(localId);
    if (!entry) throw new Error("审批不存在或已处理");
    this.pending.delete(localId);
    entry.approval.status = "resolved";
    entry.resolve(result);
  }

  private buildApprovals(): ConversationApprovals {
    const allow = (updatedPermissions?: Array<Record<string, unknown>>): PermissionResult =>
      updatedPermissions && updatedPermissions.length > 0
        ? { behavior: "allow", updatedPermissions: updatedPermissions as never }
        : { behavior: "allow" };
    const deny = (message: string): PermissionResult => ({ behavior: "deny", message });
    const settleWith = (localId: string, d: unknown, denyMessage: string): void => {
      const entry = this.pending.get(localId);
      if (!entry) throw new Error("审批不存在或已处理");
      if (d === "decline" || d === "cancel") this.settleApproval(localId, deny(denyMessage));
      else if (d === "acceptForSession") this.settleApproval(localId, allow(entry.suggestions));
      else this.settleApproval(localId, allow());
    };
    return {
      list: () => [...this.pending.values()].map((e) => e.approval),
      resolveCommand: (localId, decision) => {
        settleWith(localId, decision, "用户拒绝了该命令");
        return Promise.resolve();
      },
      resolveFileChange: (localId, decision) => {
        settleWith(localId, decision, "用户拒绝了该文件修改");
        return Promise.resolve();
      },
      respondError: (localId, _code, message) => {
        this.settleApproval(localId, deny(message || "审批响应异常"));
        return Promise.resolve();
      },
    };
  }

  private _approvals: ConversationApprovals | null = null;
  get approvals(): ConversationApprovals {
    if (!this._approvals) this._approvals = this.buildApprovals();
    return this._approvals;
  }

  async dispose(): Promise<void> {
    for (const threadId of [...this.sessions.keys()]) {
      await this.closeSession(threadId);
    }
  }
}
