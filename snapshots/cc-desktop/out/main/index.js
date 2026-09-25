import { ipcMain, dialog, BrowserWindow, shell, app, nativeImage, Tray, Menu, Notification, session, screen } from "electron";
import { existsSync, readFileSync, renameSync, mkdirSync, writeFileSync, createWriteStream, readdirSync, statSync, unlinkSync, mkdtempSync, cpSync, rmSync, realpathSync } from "node:fs";
import { tmpdir, release, homedir } from "node:os";
import { join, resolve, basename, dirname, relative, parse, isAbsolute, extname } from "node:path";
import { EventEmitter } from "node:events";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdir, appendFile, readFile, writeFile, rename, unlink, readdir } from "node:fs/promises";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import pty from "node-pty";
import updaterModule from "electron-updater";
const DEFAULTS$1 = {
  wizardCompleted: false,
  activeProjectId: null,
  roots: [],
  notifyTurnCompleted: true,
  notifyApprovals: true,
  closeToTray: false,
  theme: "light",
  updateFeedUrl: null
};
class AppSettings {
  data = { ...DEFAULTS$1 };
  file;
  constructor(app2) {
    this.file = join(app2.getPath("userData"), "settings.json");
    this.load();
  }
  load() {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      this.data = {
        wizardCompleted: Boolean(raw.wizardCompleted),
        activeProjectId: typeof raw.activeProjectId === "string" ? raw.activeProjectId : null,
        roots: Array.isArray(raw.roots) ? raw.roots.filter((r) => typeof r === "string") : [],
        notifyTurnCompleted: raw.notifyTurnCompleted === void 0 ? true : Boolean(raw.notifyTurnCompleted),
        notifyApprovals: raw.notifyApprovals === void 0 ? true : Boolean(raw.notifyApprovals),
        closeToTray: Boolean(raw.closeToTray),
        theme: raw.theme === "dark" ? "dark" : "light",
        updateFeedUrl: typeof raw.updateFeedUrl === "string" ? raw.updateFeedUrl : null
      };
    } catch {
      try {
        renameSync(this.file, `${this.file}.corrupt`);
      } catch {
      }
      this.data = { ...DEFAULTS$1 };
    }
  }
  get() {
    return { ...this.data, roots: [...this.data.roots] };
  }
  update(patch) {
    this.data = { ...this.data, ...patch };
    const tmp = `${this.file}.tmp`;
    mkdirSync(join(this.file, ".."), { recursive: true });
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
    renameSync(tmp, this.file);
    return this.get();
  }
  addRoots(paths) {
    const set = new Set(this.data.roots);
    for (const p of paths) set.add(p);
    return this.update({ roots: [...set] }).roots;
  }
}
const LEVEL_WEIGHT = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};
const KEEP_FILES = 7;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
function maskSecrets(input) {
  let out = input;
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/_-]{8,}/g, "Bearer ***");
  out = out.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "***JWT***");
  out = out.replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-***");
  out = out.replace(
    /((?:api[_-]?key|auth(?:orization)?[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd)\s*["']?\s*[:=]\s*["']?)([^\s"',}]+)/gi,
    (_m, head) => `${head}***`
  );
  return out;
}
function dayStamp(d = /* @__PURE__ */ new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
class Logger {
  stream = null;
  currentFile = null;
  minLevel = "debug";
  /** app ready 后调用；重复调用会先关闭旧句柄。 */
  init(logDir, minLevel = "debug") {
    this.close();
    this.minLevel = minLevel;
    mkdirSync(logDir, { recursive: true });
    this.rotateIfNeeded(logDir);
    this.currentFile = join(logDir, `cc-${dayStamp()}.log`);
    this.stream = createWriteStream(this.currentFile, { flags: "a" });
    this.info("logging", { logDir, file: this.currentFile });
  }
  get filePath() {
    return this.currentFile;
  }
  rotateIfNeeded(logDir) {
    if (!existsSync(logDir)) return;
    const files = readdirSync(logDir).filter((f) => /^cc-.*\.log$/.test(f)).map((f) => ({ f, mtime: statSync(join(logDir, f)).mtimeMs, size: statSync(join(logDir, f)).size })).sort((a, b) => b.mtime - a.mtime);
    for (const old of files.slice(KEEP_FILES)) {
      try {
        unlinkSync(join(logDir, old.f));
      } catch {
      }
    }
    const today = `cc-${dayStamp()}.log`;
    const current = files.find((x) => x.f === today);
    if (current && current.size > MAX_FILE_BYTES) {
      let i = 1;
      let archive = join(logDir, `cc-${dayStamp()}.${i}.log`);
      while (existsSync(archive)) archive = join(logDir, `cc-${dayStamp()}.${++i}.log`);
      try {
        renameSync(join(logDir, today), archive);
      } catch {
      }
    }
  }
  write(level, message, meta) {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.minLevel]) return;
    const time = (/* @__PURE__ */ new Date()).toISOString();
    let line = `${time} ${level.toUpperCase().padEnd(5)} ${message}`;
    if (meta !== void 0) {
      try {
        const json = JSON.stringify(meta, (_k, v) => typeof v === "bigint" ? Number(v) : v);
        line += ` ${json}`;
      } catch {
        line += " [unserializable meta]";
      }
    }
    line = maskSecrets(line);
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
    this.stream?.write(`${line}
`);
  }
  debug(message, meta) {
    this.write("debug", message, meta);
  }
  info(message, meta) {
    this.write("info", message, meta);
  }
  warn(message, meta) {
    this.write("warn", message, meta);
  }
  error(message, meta) {
    this.write("error", message, meta);
  }
  async close() {
    const stream = this.stream;
    if (!stream) {
      this.currentFile = null;
      return;
    }
    await new Promise((resolve2) => {
      stream.end(() => resolve2());
      setTimeout(resolve2, 1e3).unref?.();
    });
    this.stream = null;
    this.currentFile = null;
  }
}
const logger = new Logger();
const execFileAsync = promisify(execFile);
function nativeCandidates(appPath) {
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const bases = [appPath];
  if (appPath.endsWith(".asar")) {
    bases.unshift(appPath.slice(0, -".asar".length) + ".asar.unpacked");
  }
  return bases.map((b) => join(b, "node_modules", pkg, exe));
}
// SDK 内部用 child_process.spawn 启动引擎，而 Electron 只支持 execFile 执行 asar 内二进制、
// 不重定向 spawn（见 Electron asar 文档），故必须显式给出磁盘上的真实路径（.asar.unpacked）。
function resolveNativeExecutable() {
  return nativeCandidates(app.getAppPath()).find((p) => existsSync(p));
}
async function probeClaudeEngine(appPath, timeoutMs = 15e3) {
  for (const candidate of nativeCandidates(appPath)) {
    if (!existsSync(candidate)) continue;
    try {
      const { stdout } = await execFileAsync(candidate, ["--version"], {
        windowsHide: true,
        timeout: timeoutMs
      });
      const version = stdout.trim().split(/\r?\n/).find(Boolean) ?? "";
      if (version) return { path: candidate, version };
    } catch {
    }
  }
  return null;
}
class BackendService extends EventEmitter {
  constructor(app2, appVersion) {
    super();
    this.app = app2;
    this.appVersion = appVersion;
  }
  app;
  appVersion;
  snapshot = {
    state: "idle",
    claude: null,
    fatalMessage: null
  };
  probing = null;
  init() {
    const level = process.env["CC_LOG_LEVEL"] === "debug" ? "debug" : "info";
    logger.init(join(this.app.getPath("userData"), "logs"), level);
    logger.info("CC Desktop 启动", { version: this.appVersion });
  }
  /** 探活内置 Claude Code 引擎并广播状态；并发调用共用同一在途请求。 */
  probe() {
    if (this.probing) return this.probing;
    this.snapshot = { state: "resolving", claude: null, fatalMessage: null };
    this.emit("status", this.getStatus());
    this.probing = probeClaudeEngine(this.app.getAppPath()).then((info) => {
      if (info) {
        logger.info("Claude Code 引擎就绪", { path: info.path, version: info.version });
        this.snapshot = { state: "ready", claude: info, fatalMessage: null };
      } else {
        this.snapshot = {
          state: "fatal",
          claude: null,
          fatalMessage: "未检测到内置 Claude Code 引擎（Agent SDK 平台原生包缺失），请重新安装应用"
        };
        logger.warn("未检测到 Claude Code 引擎");
      }
    }).catch((err) => {
      this.snapshot = {
        state: "fatal",
        claude: null,
        fatalMessage: `引擎探活失败：${err instanceof Error ? err.message : String(err)}`
      };
      logger.warn("Claude Code 引擎探活失败", {
        message: err instanceof Error ? err.message : String(err)
      });
    }).finally(() => {
      this.probing = null;
      this.emit("status", this.getStatus());
    });
    return this.probing;
  }
  getStatus() {
    return {
      ...this.snapshot,
      claude: this.snapshot.claude ? { ...this.snapshot.claude } : null
    };
  }
  async restart(reason) {
    logger.warn("重新探测引擎", { reason: reason ?? null });
    await this.probe();
    return this.getStatus();
  }
  stop() {
    return Promise.resolve();
  }
}
function ledgerPath(dir) {
  return join(dir, "usage.jsonl");
}
async function appendUsage(dir, entry) {
  try {
    await mkdir(dir, { recursive: true });
    await appendFile(ledgerPath(dir), JSON.stringify(entry) + "\n", "utf8");
  } catch {
  }
}
async function loadUsage(dir) {
  let raw;
  try {
    raw = await readFile(ledgerPath(dir), "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t);
      if (typeof e.ts !== "number" || typeof e.threadId !== "string") continue;
      out.push({
        ts: e.ts,
        threadId: e.threadId,
        model: typeof e.model === "string" && e.model ? e.model : "unknown",
        inputTokens: typeof e.inputTokens === "number" ? e.inputTokens : 0,
        cachedTokens: typeof e.cachedTokens === "number" ? e.cachedTokens : 0,
        outputTokens: typeof e.outputTokens === "number" ? e.outputTokens : 0,
        costUsd: typeof e.costUsd === "number" ? e.costUsd : null,
        durationMs: typeof e.durationMs === "number" ? e.durationMs : null
      });
    } catch {
    }
  }
  return out;
}
function localDay(ts) {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}
function aggregateUsage(entries) {
  const totals = {
    turns: entries.length,
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    hasCost: false,
    firstTs: null
  };
  const days = /* @__PURE__ */ new Map();
  const models = /* @__PURE__ */ new Map();
  const addDay = (day) => {
    let d = days.get(day);
    if (!d) {
      d = { day, turns: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0 };
      days.set(day, d);
    }
    return d;
  };
  const addModel = (model) => {
    let m = models.get(model);
    if (!m) {
      m = { model, turns: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0 };
      models.set(model, m);
    }
    return m;
  };
  for (const e of entries) {
    totals.inputTokens += e.inputTokens;
    totals.cachedTokens += e.cachedTokens;
    totals.outputTokens += e.outputTokens;
    if (e.costUsd !== null) {
      totals.costUsd += e.costUsd;
      totals.hasCost = true;
    }
    if (totals.firstTs === null || e.ts < totals.firstTs) totals.firstTs = e.ts;
    const day = addDay(localDay(e.ts));
    day.turns++;
    day.inputTokens += e.inputTokens;
    day.cachedTokens += e.cachedTokens;
    day.outputTokens += e.outputTokens;
    if (e.costUsd !== null) day.costUsd += e.costUsd;
    const m = addModel(e.model);
    m.turns++;
    m.inputTokens += e.inputTokens;
    m.cachedTokens += e.cachedTokens;
    m.outputTokens += e.outputTokens;
    if (e.costUsd !== null) m.costUsd += e.costUsd;
  }
  const byDay = [...days.values()].sort((a, b) => a.day < b.day ? -1 : 1);
  const byModel = [...models.values()].sort(
    (a, b) => b.costUsd - a.costUsd || b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)
  );
  const recent = [...entries].sort((a, b) => b.ts - a.ts).slice(0, 50);
  return { totals, byDay, byModel, recent };
}
class UserInputQueue {
  buffer = [];
  waiters = [];
  closed = false;
  push(message) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.buffer.push(message);
  }
  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: void 0, done: true });
  }
  async *iterate() {
    for (; ; ) {
      const next = this.buffer.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.closed) return;
      const result = await new Promise(
        (resolve2) => this.waiters.push(resolve2)
      );
      if (result.done) return;
      yield result.value;
    }
  }
}
const FILE_EDIT_TOOLS = /* @__PURE__ */ new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
function s(v) {
  return typeof v === "string" ? v : "";
}
function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function itemForTool(useId, toolName, input) {
  if (toolName === "Bash") {
    return {
      type: "commandExecution",
      id: useId,
      command: s(input["command"]) || toolName,
      status: "inProgress",
      aggregatedOutput: ""
    };
  }
  if (FILE_EDIT_TOOLS.has(toolName)) {
    const path = s(input["file_path"]) || s(input["notebook_path"]) || s(input["path"]);
    const changes = [];
    if (toolName === "MultiEdit" && Array.isArray(input["edits"])) {
      const seen = /* @__PURE__ */ new Set();
      for (const e of input["edits"]) {
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
        ...toolName === "Edit" && s(input["old_string"]) ? {
          diff: [
            "@@ 工作区副本 → 目标文件 @@",
            ...s(input["old_string"]).split("\n").map((l) => `-${l}`),
            ...s(input["new_string"]).split("\n").map((l) => `+${l}`)
          ].join("\n")
        } : {}
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
    progressLog: []
  };
}
function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => c && typeof c === "object" ? s(c["text"]) : "").filter(Boolean).join("\n");
  }
  return "";
}
function mapEffort(effort) {
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
function mapPermissionMode(v) {
  switch (v) {
    case "acceptEdits":
    case "plan":
    case "bypassPermissions":
      return v;
    default:
      return "default";
  }
}
// 费用估算：单价单位为「每百万 token」，按模型名关键字匹配。
// 中转站的模型名可能自定义（如 deepseek-v4-flash），匹配不到时可在
// %APPDATA%/CC Desktop/cost-rates.json 中覆盖：
// { "rates": [ { "match": "deepseek-v4-flash", "currency": "CNY", "input": 2, "cached": 0.5, "output": 8 } ] }
const COST_RATE_TABLE = [
  { match: "deepseek-reasoner", currency: "CNY", input: 4, cached: 1, output: 16 },
  { match: "deepseek", currency: "CNY", input: 2, cached: 0.5, output: 8 },
  { match: "haiku", currency: "USD", input: 0.8, cached: 0.08, output: 4 },
  { match: "opus", currency: "USD", input: 15, cached: 1.5, output: 75 },
  { match: "claude", currency: "USD", input: 3, cached: 0.3, output: 15 }
];
let costRatesOverrideCache = null;
function loadCustomRates() {
  if (costRatesOverrideCache !== null) return costRatesOverrideCache;
  costRatesOverrideCache = [];
  try {
    const p = join(app.getPath("userData"), "cost-rates.json");
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, "utf8"));
      if (Array.isArray(raw?.rates)) {
        costRatesOverrideCache = raw.rates.filter((r) => r && typeof r.match === "string" && typeof r.input === "number" && typeof r.output === "number").map((r) => ({
          match: r.match.toLowerCase(),
          currency: s(r.currency) === "CNY" ? "CNY" : "USD",
          input: num(r.input),
          cached: typeof r.cached === "number" ? num(r.cached) : num(r.input),
          output: num(r.output)
        }));
      }
    }
  } catch {
  }
  return costRatesOverrideCache;
}
function resolveCostRate(modelKey) {
  const key = modelKey.toLowerCase();
  const custom = loadCustomRates().find((r) => key.includes(r.match));
  if (custom) return custom;
  return COST_RATE_TABLE.find((r) => key.includes(r.match)) ?? null;
}
function estimateTurnCost(modelKey, inputTokens, cachedTokens, outputTokens) {
  const rate = resolveCostRate(s(modelKey));
  if (!rate) return null;
  const value = (inputTokens * rate.input + cachedTokens * rate.cached + outputTokens * rate.output) / 1e6;
  return { value, currency: rate.currency, model: s(modelKey) || "unknown" };
}
const APPROVAL_TEXT_CAP = 2e5;
async function readOldText(path) {
  try {
    if (!path || !existsSync(path)) return null;
    if (statSync(path).size > APPROVAL_TEXT_CAP) return null;
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
function capText(text) {
  if (text === null) return null;
  if (text === void 0) return void 0;
  if (text.length <= APPROVAL_TEXT_CAP) return text;
  return text.slice(0, APPROVAL_TEXT_CAP) + "\n…（内容过长已截断）";
}
async function buildFileChanges(toolName, input) {
  const path = s(input["file_path"]) || s(input["notebook_path"]) || toolName;
  const kind = toolName === "Write" ? "add" : "update";
  try {
    if (toolName === "Write") {
      const oldText = kind === "add" ? null : await readOldText(path);
      return [
        { path, kind, oldText: capText(oldText), newText: capText(s(input["content"])) }
      ];
    }
    if (toolName === "Edit") {
      const oldText = await readOldText(path);
      const needle = input["old_string"];
      const replacement = input["new_string"];
      let newText = null;
      if (typeof oldText === "string" && typeof needle === "string" && typeof replacement === "string") {
        newText = input["replace_all"] === true ? oldText.split(needle).join(replacement) : oldText.replace(needle, () => replacement);
      }
      return [
        {
          path,
          kind,
          oldText: capText(newText === null ? typeof needle === "string" ? needle : null : oldText),
          newText: capText(newText === null ? typeof replacement === "string" ? replacement : null : newText)
        }
      ];
    }
    if (toolName === "MultiEdit") {
      const oldText = await readOldText(path);
      const edits = Array.isArray(input["edits"]) ? input["edits"] : [];
      let current = typeof oldText === "string" ? oldText : null;
      if (current !== null) {
        for (const raw of edits) {
          const e = raw ?? {};
          const needle = e["old_string"];
          const replacement = e["new_string"];
          if (typeof needle === "string" && typeof replacement === "string") {
            current = e["replace_all"] === true ? current.split(needle).join(replacement) : current.replace(needle, () => replacement);
          }
        }
      }
      if (current !== null) {
        return [{ path, kind, oldText: capText(oldText), newText: capText(current) }];
      }
      return edits.map((raw) => {
        const e = raw ?? {};
        return {
          path,
          kind,
          oldText: capText(typeof e["old_string"] === "string" ? e["old_string"] : null),
          newText: capText(typeof e["new_string"] === "string" ? e["new_string"] : null)
        };
      });
    }
    const oldSource = s(input["old_source"]);
    const newSource = s(input["new_source"]);
    if (oldSource || newSource) {
      return [{ path, kind, oldText: capText(oldSource || null), newText: capText(newSource || null) }];
    }
    return [{ path, kind, oldText: void 0, newText: void 0 }];
  } catch {
    return [{ path, kind, oldText: void 0, newText: void 0 }];
  }
}
class ClaudeBackend extends EventEmitter {
  constructor(userDataDir) {
    super();
    this.userDataDir = userDataDir;
    this.dir = join(userDataDir, "claude-backend");
  }
  userDataDir;
  id = "claude";
  dir;
  records = /* @__PURE__ */ new Map();
  sessions = /* @__PURE__ */ new Map();
  turnsCache = /* @__PURE__ */ new Map();
  pending = /* @__PURE__ */ new Map();
  loaded = false;
  /* ---------- 存储 ---------- */
  async ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      await mkdir(this.dir, { recursive: true });
      const raw = await readFile(join(this.dir, "registry.json"), "utf8");
      const parsed = JSON.parse(raw);
      for (const rec of parsed.threads ?? []) {
        if (rec?.threadId) this.records.set(rec.threadId, rec);
      }
    } catch {
    }
  }
  async saveRegistry() {
    try {
      await mkdir(this.dir, { recursive: true });
      const tmp = join(this.dir, "registry.json.tmp");
      await writeFile(tmp, JSON.stringify({ version: 1, threads: [...this.records.values()] }));
      await rename(tmp, join(this.dir, "registry.json"));
    } catch (err) {
      logger.warn("Claude 会话登记写入失败", {
        err: err instanceof Error ? err.message : String(err)
      });
    }
  }
  async loadTurns(threadId2) {
    const cached = this.turnsCache.get(threadId2);
    if (cached) return cached;
    const turns = [];
    try {
      const raw = await readFile(join(this.dir, `transcript-${threadId2}.jsonl`), "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.k === "turn" && parsed.turn?.id) turns.push(parsed.turn);
        } catch {
        }
      }
    } catch {
    }
    this.turnsCache.set(threadId2, turns);
    return turns;
  }
  async persistTurn(threadId2, turn) {
    const turns = await this.loadTurns(threadId2);
    const idx = turns.findIndex((t) => t.id === turn.id);
    if (idx >= 0) turns[idx] = turn;
    else turns.push(turn);
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(
        join(this.dir, `transcript-${threadId2}.jsonl`),
        turns.map((t) => JSON.stringify({ k: "turn", turn: t })).join("\n") + "\n",
        "utf8"
      );
    } catch (err) {
      logger.warn("Claude 回合转录写入失败", {
        err: err instanceof Error ? err.message : String(err)
      });
    }
  }
  /* ---------- 视图与事件 ---------- */
  threadRaw(rec) {
    return {
      id: rec.threadId,
      name: rec.name,
      preview: rec.preview,
      cwd: rec.cwd,
      status: "idle",
      archived: rec.archived,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt
    };
  }
  turnRaw(turn) {
    return {
      id: turn.id,
      status: turn.status,
      startedAt: turn.startedAt / 1e3,
      completedAt: turn.endedAt != null ? turn.endedAt / 1e3 : null,
      durationMs: turn.durationMs,
      error: turn.error,
      usage: turn.usage ?? null,
      cost: turn.cost ?? null,
      items: turn.items
    };
  }
  notify(method, params) {
    this.emit("notification", { method, params, emittedAtMs: Date.now() });
  }
  touch(rec) {
    rec.updatedAt = Math.floor(Date.now() / 1e3);
    void this.saveRegistry();
  }
  /* ---------- ConversationBackend ---------- */
  owns(threadId2) {
    return this.records.has(threadId2);
  }
  ownsApproval(localId) {
    return this.pending.has(localId);
  }
  async listThreads(_params) {
    await this.ensureLoaded();
    return { data: [...this.records.values()].map((r) => this.threadRaw(r)), nextCursor: null };
  }
  async readThread(params) {
    await this.ensureLoaded();
    const rec = this.records.get(params.threadId);
    if (!rec) throw new Error("会话不存在或不是 Claude 会话");
    return { thread: this.threadRaw(rec) };
  }
  async startThread(params) {
    await this.ensureLoaded();
    const cwd = s(params["cwd"]) || this.userDataDir;
    await mkdir(cwd, { recursive: true });
    const readOnly = params["sandbox"] === "read-only" || params["approvalPolicy"] === "never" || params["approvalPolicy"] === "untrusted";
    const rec = {
      threadId: randomUUID(),
      sessionId: null,
      cwd,
      name: null,
      preview: "",
      archived: false,
      createdAt: Math.floor(Date.now() / 1e3),
      updatedAt: Math.floor(Date.now() / 1e3),
      model: s(params["model"]) || null,
      readOnly,
      permissionMode: readOnly ? "default" : mapPermissionMode(params["permissionMode"])
    };
    this.records.set(rec.threadId, rec);
    await this.saveRegistry();
    return {
      thread: this.threadRaw(rec),
      model: rec.model ?? "claude",
      cwd,
      runtimeWorkspaceRoots: [cwd]
    };
  }
  async resumeThread(params) {
    await this.ensureLoaded();
    const rec = this.records.get(params.threadId);
    if (!rec) throw new Error("会话不存在或不是 Claude 会话");
    const turns = await this.loadTurns(params.threadId);
    return { thread: this.threadRaw(rec), turns: turns.map((t) => this.turnRaw(t)) };
  }
  async archiveThread(params) {
    const rec = this.records.get(params.threadId);
    if (rec) {
      rec.archived = true;
      this.touch(rec);
      this.notify("thread/archived", { threadId: rec.threadId });
    }
    return {};
  }
  async unarchiveThread(params) {
    const rec = this.records.get(params.threadId);
    if (rec) {
      rec.archived = false;
      this.touch(rec);
      this.notify("thread/unarchived", { threadId: rec.threadId });
    }
    return {};
  }
  async deleteThread(params) {
    const rec = this.records.get(params.threadId);
    if (!rec) return {};
    await this.closeSession(params.threadId);
    this.records.delete(params.threadId);
    this.turnsCache.delete(params.threadId);
    await this.saveRegistry();
    try {
      await unlink(join(this.dir, `transcript-${params.threadId}.jsonl`));
    } catch {
    }
    this.notify("thread/deleted", { threadId: params.threadId });
    return {};
  }
  async setThreadName(params) {
    const threadId2 = s(params["threadId"]);
    const rec = this.records.get(threadId2);
    const name = s(params["name"]) || s(params["threadName"]) || null;
    if (rec) {
      rec.name = name;
      this.touch(rec);
      this.notify("thread/name/updated", { threadId: threadId2, threadName: name });
    }
    return {};
  }
  async listTurns(params) {
    await this.ensureLoaded();
    if (!this.records.has(params.threadId)) return { data: [], nextCursor: null };
    const turns = await this.loadTurns(params.threadId);
    return { data: turns.map((t) => this.turnRaw(t)), nextCursor: null };
  }
  async searchThreads(params) {
    await this.ensureLoaded();
    const q = s(params["query"]).toLowerCase();
    const data = q ? [...this.records.values()].filter(
      (r) => (r.name ?? "").toLowerCase().includes(q) || r.preview.toLowerCase().includes(q)
    ).map((r) => this.threadRaw(r)) : [];
    return { data, nextCursor: null };
  }
  /* ---------- 会话进程 ---------- */
  async closeSession(threadId2) {
    const session2 = this.sessions.get(threadId2);
    if (!session2) return;
    this.sessions.delete(threadId2);
    session2.input.close();
    try {
      session2.controller.abort();
    } catch {
    }
  }
  async ensureSession(rec) {
    const existing = this.sessions.get(rec.threadId);
    if (existing) return existing;
    const input = new UserInputQueue();
    const controller = new AbortController();
    const session2 = {
      record: rec,
      query: null,
      input,
      controller,
      openTurn: null
    };
    const claudeExe = resolveNativeExecutable();
    const options = {
      cwd: rec.cwd,
      model: rec.model ?? void 0,
      permissionMode: rec.permissionMode,
      permissionPrompts: rec.readOnly ? "none" : "host",
      includePartialMessages: true,
      abortController: controller,
      canUseTool: (toolName, toolInput, opts) => this.handleCanUseTool(rec, session2, toolName, toolInput, opts),
      ...claudeExe ? { pathToClaudeCodeExecutable: claudeExe } : {},
      ...rec.sessionId ? { resume: rec.sessionId } : {}
    };
    const q = query({
      prompt: input.iterate(),
      options
    });
    session2.query = q;
    this.sessions.set(rec.threadId, session2);
    void this.pump(rec, session2);
    return session2;
  }
  /** SDK 消息泵：唯一的规范化出口，进程退出时兜底关闭未完成回合。 */
  async pump(rec, session2) {
    try {
      for await (const msg of session2.query) {
        this.handleSdkMessage(rec, session2, msg);
      }
    } catch (err) {
      logger.warn("Claude 会话异常退出", {
        threadId: rec.threadId,
        err: err instanceof Error ? err.message : String(err)
      });
    }
    this.sessions.delete(rec.threadId);
    const open = session2.openTurn;
    if (open) {
      session2.openTurn = null;
      open.status = "failed";
      open.error = { message: "Claude 会话进程已退出" };
      open.endedAt = Date.now();
      open.durationMs = open.endedAt - open.startedAt;
      this.notify("turn/completed", { threadId: rec.threadId, turn: this.turnRaw(open) });
      await this.persistTurn(rec.threadId, open);
      this.touch(rec);
    }
  }
  handleSdkMessage(rec, session2, msg) {
    const m = msg;
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
      this.handleStreamEvent(rec, session2, m);
      return;
    }
    if (type === "assistant") {
      this.handleAssistantMessage(rec, session2, m);
      return;
    }
    if (type === "user") {
      this.handleToolResults(rec, session2, m);
      return;
    }
    if (type === "result") {
      void this.handleResult(rec, session2, m);
      return;
    }
  }
  handleStreamEvent(rec, session2, m) {
    const turn = session2.openTurn;
    if (!turn) return;
    turn.sawStream = true;
    const threadId2 = rec.threadId;
    const event = m["event"] ?? {};
    const index = num(event["index"]);
    const evType = s(event["type"]);
    const turnId = turn.id;
    if (evType === "content_block_start") {
      const block = event["content_block"] ?? {};
      const bType = s(block["type"]);
      if (bType === "text" || bType === "thinking") {
        const itemId = `${turnId}-${bType === "text" ? "a" : "t"}-${index}`;
        const item = bType === "text" ? { type: "agentMessage", id: itemId, text: "" } : { type: "reasoning", id: itemId, summary: [], content: [""] };
        turn.items.push(item);
        turn.blocks.set(index, { itemId, kind: bType, name: "", done: false, json: "" });
        this.notify("item/started", { threadId: threadId2, turnId, item });
        return;
      }
      if (bType === "tool_use") {
        const useId = s(block["id"]) || `${turnId}-tool-${index}`;
        const toolName = s(block["name"]);
        const item = itemForTool(useId, toolName, {});
        turn.items.push(item);
        turn.toolItems.set(useId, { itemId: useId, type: s(item["type"]) });
        turn.blocks.set(index, { itemId: useId, kind: "tool", name: toolName, done: false, json: "" });
        this.notify("item/started", { threadId: threadId2, turnId, item });
        return;
      }
      return;
    }
    if (evType === "content_block_delta") {
      const delta = event["delta"] ?? {};
      const dType = s(delta["type"]);
      const block = turn.blocks.get(index);
      if (dType === "text_delta" && block?.kind === "text" && !block.done) {
        const text = s(delta["text"]);
        if (!text) return;
        const item = turn.items.find((i) => i["id"] === block.itemId);
        if (item) item["text"] = s(item["text"]) + text;
        this.notify("item/agentMessage/delta", { threadId: threadId2, turnId, itemId: block.itemId, delta: text });
        return;
      }
      if (dType === "thinking_delta" && block?.kind === "thinking" && !block.done) {
        const text = s(delta["thinking"]);
        if (!text) return;
        const item = turn.items.find((i) => i["id"] === block.itemId);
        if (item && Array.isArray(item["content"])) item["content"][0] += text;
        this.notify("item/reasoning/textDelta", {
          threadId: threadId2,
          turnId,
          itemId: block.itemId,
          delta: text,
          contentIndex: 0
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
        const item2 = turn.items.find((i) => i["id"] === block.itemId);
        let parsed = null;
        try {
          parsed = block.json ? JSON.parse(block.json) : {};
        } catch {
          parsed = null;
        }
        if (item2 && parsed) {
          Object.assign(item2, itemForTool(block.itemId, block.name, parsed));
          this.notify("item/started", { threadId: threadId2, turnId: turn.id, item: item2 });
        }
        return;
      }
      const item = turn.items.find((i) => i["id"] === block.itemId);
      if (item) this.notify("item/completed", { threadId: threadId2, turnId: turn.id, item });
    }
  }
  /**
   * assistant 消息兜底：
   * - tool_use：补齐流式路径没覆盖的工具块；
   * - text/thinking：部分中转站（如 DeepSeek 兼容端点）不发 stream_event 增量流，
   *   只在 assistant 消息里给完整文本，此时（turn.sawStream=false）需要据此创建回复/思考条目，
   *   否则界面上模型回复为空。
   */
  handleAssistantMessage(rec, session2, m) {
    const turn = session2.openTurn;
    if (!turn || m["parent_tool_use_id"] != null) return;
    const message = m["message"] ?? {};
    const content = Array.isArray(message["content"]) ? message["content"] : [];
    content.forEach((block, idx) => {
      const b = block ?? {};
      const blockType = s(b["type"]);
      if (blockType === "tool_use") {
        const useId = s(b["id"]);
        if (!useId || turn.toolItems.has(useId)) return;
        const toolName = s(b["name"]);
        const input = b["input"] ?? {};
        const item = itemForTool(useId, toolName, input);
        turn.items.push(item);
        turn.toolItems.set(useId, { itemId: useId, type: s(item["type"]) });
        this.notify("item/started", { threadId: rec.threadId, turnId: turn.id, item });
        return;
      }
      if (turn.sawStream) return;
      if (blockType === "text") {
        const text = s(b["text"]);
        if (!text) return;
        const itemId = `${turn.id}-a-msg-${idx}`;
        let item = turn.items.find((i) => i["id"] === itemId);
        if (!item) {
          item = { type: "agentMessage", id: itemId, text };
          turn.items.push(item);
          this.notify("item/started", { threadId: rec.threadId, turnId: turn.id, item });
        } else {
          item["text"] = text;
        }
        this.notify("item/completed", { threadId: rec.threadId, turnId: turn.id, item });
        return;
      }
      if (blockType === "thinking") {
        const text = s(b["thinking"]);
        if (!text) return;
        const itemId = `${turn.id}-t-msg-${idx}`;
        if (turn.items.some((i) => i["id"] === itemId)) return;
        const item = { type: "reasoning", id: itemId, summary: [], content: [text] };
        turn.items.push(item);
        this.notify("item/started", { threadId: rec.threadId, turnId: turn.id, item });
        this.notify("item/completed", { threadId: rec.threadId, turnId: turn.id, item });
      }
    });
  }
  /** user 消息里的 tool_result：闭合对应工具条目（输出/状态）。 */
  handleToolResults(rec, session2, m) {
    const turn = session2.openTurn;
    if (!turn || m["parent_tool_use_id"] != null) return;
    const message = m["message"] ?? {};
    const content = Array.isArray(message["content"]) ? message["content"] : [];
    for (const block of content) {
      const b = block ?? {};
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
  async handleResult(rec, session2, m) {
    const turn = session2.openTurn;
    const subtype = s(m["subtype"]);
    if (!turn) return;
    session2.openTurn = null;
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
    const usage = m["usage"] ?? {};
    const inputTokens = num(usage["input_tokens"]);
    const cached = num(usage["cache_read_input_tokens"]) + num(usage["cache_creation_input_tokens"]);
    const outputTokens = num(usage["output_tokens"]);
    const costUsd = typeof m["total_cost_usd"] === "number" ? m["total_cost_usd"] : null;
    const modelUsage = m["modelUsage"] ?? null;
    const modelKey = modelUsage && typeof modelUsage === "object" ? Object.keys(modelUsage)[0] || rec.model || "claude" : rec.model || "claude";
    turn.usage = {
      totalTokens: inputTokens + cached + outputTokens,
      inputTokens,
      cachedInputTokens: cached,
      outputTokens
    };
    turn.cost = estimateTurnCost(modelKey, inputTokens, cached, outputTokens) ?? (costUsd != null ? { value: costUsd, currency: "USD", model: modelKey } : null);
    this.notify("turn/completed", { threadId: rec.threadId, turn: this.turnRaw(turn) });
    this.notify("thread/tokenUsage/updated", {
      threadId: rec.threadId,
      tokenUsage: {
        total: {
          totalTokens: inputTokens + cached + outputTokens,
          inputTokens,
          cachedInputTokens: cached,
          outputTokens,
          reasoningOutputTokens: 0
        },
        modelContextWindow: null
      }
    });
    await appendUsage(this.dir, {
      ts: Date.now(),
      threadId: rec.threadId,
      model: modelKey,
      inputTokens,
      cachedTokens: cached,
      outputTokens,
      costUsd,
      durationMs: typeof m["duration_ms"] === "number" ? m["duration_ms"] : null
    });
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
      agentItems.length > 0 ? agentItems[agentItems.length - 1]["text"] ?? "" : ""
    );
    if (lastAgent) rec.preview = lastAgent.slice(0, 200);
    await this.persistTurn(rec.threadId, turn);
    this.touch(rec);
  }
  /* ---------- 回合 ---------- */
  extractText(input) {
    if (!Array.isArray(input)) return "";
    return input.map((item) => {
      const i = item ?? {};
      return s(i["text"]);
    }).filter(Boolean).join("\n");
  }
  // 把渲染层 input（文本 + localImage 路径 + inlineImage base64）组装成 Anthropic 消息 content 块。
  // 粘贴的 inlineImage 会落盘到 userData/sent-images，返回路径用于历史记录展示。
  async buildUserContent(input) {
    const blocks = [];
    const display = [];
    const allowMedia = /* @__PURE__ */ new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
    const mediaByExt = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp"
    };
    for (const item of Array.isArray(input) ? input : []) {
      const i = item ?? {};
      if (i["type"] === "localImage") {
        const p = s(i["path"]);
        if (!p) continue;
        const media = mediaByExt[extname(p).toLowerCase()];
        if (!media) throw new Error(`暂不支持的图片格式（仅支持 PNG/JPEG/GIF/WebP）：${basename(p)}`);
        const buf = await readFile(p);
        blocks.push({ type: "image", source: { type: "base64", media_type: media, data: buf.toString("base64") } });
        display.push({ type: "localImage", path: p });
      } else if (i["type"] === "inlineImage") {
        const media = s(i["mediaType"]);
        const dataB64 = s(i["dataBase64"]);
        if (!allowMedia.has(media) || !dataB64) throw new Error("粘贴的图片格式不支持（仅支持 PNG/JPEG/GIF/WebP）");
        const dir = join(app.getPath("userData"), "sent-images");
        mkdirSync(dir, { recursive: true });
        const ext = media === "image/jpeg" ? ".jpg" : `.${media.slice(6)}`;
        const p = join(dir, `${Date.now()}-${randomUUID()}${ext}`);
        writeFileSync(p, Buffer.from(dataB64, "base64"));
        blocks.push({ type: "image", source: { type: "base64", media_type: media, data: dataB64 } });
        display.push({ type: "localImage", path: p });
      } else {
        const text2 = s(i["text"]);
        if (text2) {
          blocks.push({ type: "text", text: text2 });
          display.push({ type: "text", text: text2 });
        }
      }
    }
    return { blocks, display };
  }
  pushUserMessage(session2, content) {
    session2.input.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: session2.record.sessionId ?? ""
    });
  }
  async startTurn(params) {
    await this.ensureLoaded();
    const threadId2 = s(params["threadId"]);
    const rec = this.records.get(threadId2);
    if (!rec) throw new Error("会话不存在或不是 Claude 会话");
    const existing = this.sessions.get(threadId2);
    if (existing?.openTurn) return this.steerTurn(params);
    const session2 = await this.ensureSession(rec);
    if (session2.openTurn) return this.steerTurn(params);
    const text = this.extractText(params["input"]);
    const { blocks: contentBlocks, display } = await this.buildUserContent(params["input"]);
    const turn = {
      id: randomUUID(),
      status: "inProgress",
      startedAt: Date.now(),
      endedAt: null,
      durationMs: null,
      items: [],
      error: null,
      blocks: /* @__PURE__ */ new Map(),
      toolItems: /* @__PURE__ */ new Map(),
      sawStream: false,
      interrupted: false
    };
    session2.openTurn = turn;
    const model = s(params["model"]);
    if (model) {
      rec.model = model;
      void session2.query?.setModel(model).catch(() => void 0);
    }
    const effort = mapEffort(params["effort"]);
    if (effort) {
      void session2.query?.applyFlagSettings({ effortLevel: effort }).catch(() => void 0);
    }
    if (!rec.readOnly && params["permissionMode"] !== void 0) {
      const mode = mapPermissionMode(params["permissionMode"]);
      rec.permissionMode = mode;
      void this.saveRegistry().catch(() => void 0);
      const setMode = session2.query?.setPermissionMode;
      if (typeof setMode === "function") {
        void Promise.resolve(setMode.call(session2.query, mode)).catch(() => void 0);
      }
    }
    this.notify("turn/started", { threadId: threadId2, turn: this.turnRaw(turn) });
    const userItem = { type: "userMessage", id: `user-${turn.id}`, text, content: display };
    turn.items.push(userItem);
    this.notify("item/started", { threadId: threadId2, turnId: turn.id, item: userItem });
    this.notify("item/completed", { threadId: threadId2, turnId: turn.id, item: userItem });
    this.pushUserMessage(session2, contentBlocks);
    return { threadId: threadId2, turn: this.turnRaw(turn) };
  }
  async steerTurn(params) {
    await this.ensureLoaded();
    const threadId2 = s(params["threadId"]);
    const session2 = this.sessions.get(threadId2);
    const turn = session2?.openTurn;
    if (!session2 || !turn) throw new Error("当前没有进行中的回合");
    const text = this.extractText(params["input"]);
    const { blocks: contentBlocks, display } = await this.buildUserContent(params["input"]);
    const userItem = { type: "userMessage", id: `user-${turn.id}-${turn.items.length}`, text, content: display };
    turn.items.push(userItem);
    this.notify("item/started", { threadId: threadId2, turnId: turn.id, item: userItem });
    this.notify("item/completed", { threadId: threadId2, turnId: turn.id, item: userItem });
    this.pushUserMessage(session2, contentBlocks);
    return { threadId: threadId2, turnId: turn.id };
  }
  async interruptTurn(params) {
    await this.ensureLoaded();
    const session2 = this.sessions.get(params.threadId);
    const turn = session2?.openTurn;
    if (!session2 || !turn) return {};
    turn.interrupted = true;
    try {
      await session2.query?.interrupt();
    } catch (err) {
      logger.warn("Claude 中断请求失败", {
        threadId: params.threadId,
        err: err instanceof Error ? err.message : String(err)
      });
    }
    const timer = setTimeout(() => {
      if (session2.openTurn === turn) {
        session2.openTurn = null;
        turn.status = "interrupted";
        turn.endedAt = Date.now();
        turn.durationMs = turn.endedAt - turn.startedAt;
        this.notify("turn/completed", { threadId: params.threadId, turn: this.turnRaw(turn) });
        void this.persistTurn(params.threadId, turn);
      }
    }, 5e3);
    timer.unref?.();
    return {};
  }
  /* ---------- 审批 ---------- */
  async handleCanUseTool(rec, _session, toolName, input, opts) {
    const commandLike = toolName === "Bash" ? s(input["command"]) || toolName : `${toolName} ${JSON.stringify(input).slice(0, 200)}`;
    const isFile = FILE_EDIT_TOOLS.has(toolName);
    const method = isFile ? "item/fileChange/requestApproval" : "item/commandExecution/requestApproval";
    const params = isFile ? {
      threadId: rec.threadId,
      changes: await buildFileChanges(toolName, input)
    } : { threadId: rec.threadId, command: commandLike };
    const approval = {
      localId: randomUUID(),
      serverId: `claude:${toolName}:${Date.now()}`,
      method,
      params,
      threadId: rec.threadId,
      receivedAt: Date.now(),
      status: "pending"
    };
    return new Promise((resolve2) => {
      this.pending.set(approval.localId, {
        approval,
        resolve: resolve2,
        suggestions: Array.isArray(opts.suggestions) ? opts.suggestions : []
      });
      this.emit("approval", approval);
    });
  }
  settleApproval(localId, result) {
    const entry = this.pending.get(localId);
    if (!entry) throw new Error("审批不存在或已处理");
    this.pending.delete(localId);
    entry.approval.status = "resolved";
    entry.resolve(result);
  }
  buildApprovals() {
    const allow = (updatedPermissions) => updatedPermissions && updatedPermissions.length > 0 ? { behavior: "allow", updatedPermissions } : { behavior: "allow" };
    const deny = (message) => ({ behavior: "deny", message });
    const settleWith = (localId, d, denyMessage) => {
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
      }
    };
  }
  _approvals = null;
  get approvals() {
    if (!this._approvals) this._approvals = this.buildApprovals();
    return this._approvals;
  }
  async dispose() {
    for (const threadId2 of [...this.sessions.keys()]) {
      await this.closeSession(threadId2);
    }
  }
}
const normProjectRoot = (p) => p.replace(/\//g, "\\").trim().toLowerCase().replace(/\\+$/, "");
class ProjectsStore {
  data = [];
  file;
  constructor(app2) {
    this.file = join(app2.getPath("userData"), "projects.json");
    this.load();
  }
  load() {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      if (!Array.isArray(raw)) return;
      for (const item of raw) {
        const p = item;
        if (typeof p.id !== "string" || p.id.length === 0) continue;
        this.data.push({
          id: p.id,
          name: typeof p.name === "string" && p.name ? p.name : "未命名工作区",
          roots: Array.isArray(p.roots) ? p.roots.filter((r) => typeof r === "string") : [],
          createdAt: typeof p.createdAt === "number" ? p.createdAt : Date.now() / 1e3,
          updatedAt: typeof p.updatedAt === "number" ? p.updatedAt : Date.now() / 1e3
        });
      }
    } catch {
      try {
        renameSync(this.file, `${this.file}.corrupt`);
      } catch {
      }
      this.data = [];
    }
  }
  save() {
    const tmp = `${this.file}.tmp`;
    mkdirSync(join(this.file, ".."), { recursive: true });
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
    renameSync(tmp, this.file);
  }
  list(_params = {}) {
    return { data: [...this.data], nextCursor: null };
  }
  read(params) {
    return this.data.find((p) => p.id === params.projectId) ?? null;
  }
  /** 查找目录集合完全一致的已有工作区（向导/侧栏共用去重规则）。 */
  findWithRoots(rootPaths) {
    const want = new Set(rootPaths.filter(Boolean).map(normProjectRoot));
    if (want.size === 0) return null;
    for (const p of this.data) {
      const got = new Set(p.roots.map(normProjectRoot));
      if (got.size === want.size && [...want].every((x) => got.has(x))) return p;
    }
    return null;
  }
  create(params) {
    const roots = (params.roots ?? []).map((r) => typeof r === "string" ? r : r?.path).filter((r) => typeof r === "string" && r.length > 0);
    const now = Date.now() / 1e3;
    const record = {
      id: randomUUID(),
      name: params.name?.trim() || "未命名工作区",
      roots,
      createdAt: now,
      updatedAt: now
    };
    this.data.push(record);
    this.save();
    return record;
  }
  update(params) {
    const record = this.data.find((p) => p.id === params.projectId);
    if (!record) return null;
    if (typeof params.name === "string" && params.name.trim()) record.name = params.name.trim();
    if (Array.isArray(params.roots)) {
      record.roots = params.roots.map((r) => typeof r === "string" ? r : r?.path).filter((r) => typeof r === "string" && r.length > 0);
    }
    record.updatedAt = Date.now() / 1e3;
    this.save();
    return record;
  }
  remove(params) {
    const before = this.data.length;
    this.data = this.data.filter((p) => p.id !== params.projectId);
    const removed = this.data.length < before;
    if (removed) this.save();
    return removed;
  }
}
const CHANNELS = {
  app: {
    version: "app:version",
    windowControl: "app:window-control",
    windowState: "app:window-state",
    pickDirectory: "app:pick-directory",
    pickFile: "app:pick-file",
    showItem: "app:show-item",
    openExternal: "app:open-external",
    openLogsDir: "app:open-logs-dir",
    chatSpace: "app:chat-space"
  },
  backend: {
    status: "backend:status",
    restart: "backend:restart",
    wizardGet: "backend:wizard-get",
    wizardComplete: "backend:wizard-complete",
    setActiveProject: "backend:set-active-project"
  },
  projects: {
    list: "projects:list",
    read: "projects:read",
    create: "projects:create",
    update: "projects:update",
    remove: "projects:delete"
  },
  threads: {
    list: "threads:list",
    read: "threads:read",
    start: "threads:start",
    startChat: "threads:start-chat",
    resume: "threads:resume",
    archive: "threads:archive",
    unarchive: "threads:unarchive",
    remove: "threads:delete",
    turns: "threads:turns",
    search: "threads:search",
    setName: "threads:set-name"
  },
  turn: {
    start: "turn:start",
    steer: "turn:steer",
    interrupt: "turn:interrupt",
    revertChanges: "turn:revert-changes"
  },
  approvals: {
    list: "approvals:list",
    resolveCommand: "approvals:resolve-command",
    resolveFileChange: "approvals:resolve-file-change",
    respondError: "approvals:respond-error"
  },
  fs: {
    readFile: "fs:read-file",
    readDirectory: "fs:read-directory"
  },
  process: {
    spawn: "process:spawn",
    writeStdin: "process:write-stdin",
    resizePty: "process:resize-pty",
    kill: "process:kill"
  },
  stats: {
    usage: "stats:usage"
  },
  settings: {
    account: "settings:account",
    exportLogs: "settings:export-logs",
    prefsGet: "settings:prefs-get",
    prefsSet: "settings:prefs-set",
    updateGet: "settings:update-get",
    updateCheck: "settings:update-check",
    updateDownload: "settings:update-download",
    updateInstall: "settings:update-install"
  }
};
const EVENTS = {
  backendStatus: "backend:status-changed",
  approvalChanged: "approval:changed",
  /** 会话后端（Claude Code）推送的通知信封 { method, params }。 */
  backendNotification: "backend:notification",
  /** 窗口最大化/还原状态变化，载荷 { maximized: boolean }。 */
  appWindowState: "app:window-state-changed",
  /** 自动更新状态广播（UpdateState）。 */
  updateState: "update:state-changed",
  processOutputDelta: "process:output-delta",
  processExited: "process:exited",
  /** 托盘/第二实例请求：显示并聚焦窗口。 */
  appShow: "app:show",
  /** 托盘菜单请求新建会话。 */
  appNewThread: "app:new-thread",
  /** 第二实例携带目录参数：载荷 { path }。 */
  appOpenPath: "app:open-path"
};
const voidInput = z.object({}).strict().optional();
const cursorPage = z.object({
  limit: z.number().int().positive().max(200).optional(),
  cursor: z.string().min(1).nullable().optional()
}).passthrough();
const threadId = z.object({ threadId: z.string().min(1) }).passthrough();
const INPUTS = {
  [CHANNELS.app.version]: voidInput,
  [CHANNELS.app.windowState]: voidInput,
  [CHANNELS.app.windowControl]: z.object({ action: z.enum(["minimize", "toggleMaximize", "close"]) }).strict(),
  [CHANNELS.app.pickDirectory]: z.object({ defaultPath: z.string().min(1).optional() }).strict().optional(),
  [CHANNELS.app.pickFile]: z.object({
    defaultPath: z.string().min(1).optional(),
    title: z.string().max(100).optional(),
    filters: z.array(z.object({ name: z.string(), extensions: z.array(z.string()) })).optional()
  }).strict().optional(),
  [CHANNELS.app.showItem]: z.object({ path: z.string().min(1) }).strict(),
  [CHANNELS.app.openExternal]: z.object({ url: z.string().url().refine((u) => /^https?:\/\//i.test(u), "仅允许 http/https 链接") }).strict(),
  [CHANNELS.app.openLogsDir]: voidInput,
  [CHANNELS.app.chatSpace]: voidInput,
  [CHANNELS.backend.status]: voidInput,
  [CHANNELS.backend.restart]: z.object({ reason: z.string().max(200).optional() }).strict().optional(),
  [CHANNELS.backend.wizardGet]: voidInput,
  [CHANNELS.backend.wizardComplete]: z.object({ projectPath: z.string().min(1), title: z.string().max(200).optional() }).strict(),
  [CHANNELS.backend.setActiveProject]: z.object({ projectId: z.string().min(1).nullable() }).strict(),
  [CHANNELS.projects.list]: cursorPage.optional(),
  [CHANNELS.projects.read]: z.object({ projectId: z.string().min(1) }).passthrough(),
  [CHANNELS.projects.create]: z.object({
    name: z.string().max(200).optional(),
    roots: z.array(z.object({ path: z.string().min(1) }).passthrough()).optional()
  }).passthrough(),
  [CHANNELS.projects.update]: z.object({ projectId: z.string().min(1) }).passthrough(),
  [CHANNELS.projects.remove]: z.object({ projectId: z.string().min(1) }).passthrough(),
  [CHANNELS.threads.list]: cursorPage.optional(),
  [CHANNELS.threads.read]: threadId,
  [CHANNELS.threads.start]: z.object({ cwd: z.string().min(1) }).passthrough(),
  [CHANNELS.threads.startChat]: voidInput,
  [CHANNELS.threads.resume]: threadId,
  [CHANNELS.threads.archive]: threadId,
  [CHANNELS.threads.unarchive]: threadId,
  [CHANNELS.threads.remove]: threadId,
  [CHANNELS.threads.turns]: z.object({
    threadId: z.string().min(1),
    limit: z.number().int().positive().max(200).optional(),
    cursor: z.string().min(1).nullable().optional()
  }).passthrough(),
  [CHANNELS.threads.search]: z.object({ query: z.string().max(500) }).passthrough(),
  [CHANNELS.threads.setName]: z.object({ threadId: z.string().min(1), name: z.string().max(200) }).passthrough(),
  [CHANNELS.turn.start]: z.object({ threadId: z.string().min(1), input: z.array(z.unknown()).min(1) }).passthrough(),
  [CHANNELS.turn.steer]: z.object({
    threadId: z.string().min(1),
    expectedTurnId: z.string().min(1),
    input: z.array(z.unknown()).min(1)
  }).passthrough(),
  [CHANNELS.turn.interrupt]: threadId,
  [CHANNELS.turn.revertChanges]: z.object({
    changes: z.array(z.object({
      path: z.string().min(1),
      kind: z.string().max(20).optional(),
      oldText: z.string().nullable().optional(),
      newText: z.string().nullable().optional()
    }).passthrough()).max(200)
  }).passthrough(),
  [CHANNELS.approvals.list]: voidInput,
  [CHANNELS.approvals.resolveCommand]: z.object({
    localId: z.string().min(1),
    decision: z.enum(["accept", "acceptForSession", "decline", "cancel"])
  }).passthrough(),
  [CHANNELS.approvals.resolveFileChange]: z.object({
    localId: z.string().min(1),
    decision: z.enum(["accept", "acceptForSession", "decline", "cancel"])
  }).strict(),
  [CHANNELS.approvals.respondError]: z.object({
    localId: z.string().min(1),
    code: z.number().int(),
    message: z.string().max(500),
    data: z.unknown().optional()
  }).strict(),
  [CHANNELS.fs.readFile]: z.object({ path: z.string().min(1) }).strict(),
  [CHANNELS.fs.readDirectory]: z.object({ path: z.string().min(1) }).strict(),
  [CHANNELS.process.spawn]: z.object({
    cwd: z.string().min(1).optional(),
    shell: z.string().min(1).max(300).optional(),
    title: z.string().max(100).optional()
  }).strict().optional(),
  [CHANNELS.process.writeStdin]: z.object({ id: z.string().min(1), data: z.string().max(64 * 1024) }).strict(),
  [CHANNELS.process.resizePty]: z.object({
    id: z.string().min(1),
    cols: z.number().int().min(2).max(1e3),
    rows: z.number().int().min(2).max(500)
  }).strict(),
  [CHANNELS.process.kill]: z.object({ id: z.string().min(1) }).strict(),
  [CHANNELS.stats.usage]: voidInput,
  [CHANNELS.settings.account]: voidInput,
  [CHANNELS.settings.exportLogs]: voidInput,
  [CHANNELS.settings.updateGet]: voidInput,
  [CHANNELS.settings.updateCheck]: voidInput,
  [CHANNELS.settings.updateDownload]: voidInput,
  [CHANNELS.settings.updateInstall]: voidInput,
  [CHANNELS.settings.prefsGet]: voidInput,
  [CHANNELS.settings.prefsSet]: z.object({
    notifyTurnCompleted: z.boolean().optional(),
    notifyApprovals: z.boolean().optional(),
    closeToTray: z.boolean().optional(),
    theme: z.enum(["light", "dark"]).optional(),
    updateFeedUrl: z.string().url().nullable().optional()
  }).strict()
};
function runPowerShellCompress(srcDir, destZip) {
  return new Promise((resolve2, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Compress-Archive -Path (Join-Path '${srcDir.replace(/'/g, "''")}' *) -DestinationPath '${destZip.replace(/'/g, "''")}' -Force`
      ],
      { windowsHide: true }
    );
    let err = "";
    child.stderr?.on("data", (c) => err += c.toString("utf8"));
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve2() : reject(new Error(`Compress-Archive 失败: ${err.trim()}`)));
  });
}
async function exportLogs(logsDir, envSummary, savePath) {
  const work = mkdtempSync(join(tmpdir(), "cc-diag-"));
  try {
    const bundleDir = join(work, "bundle");
    mkdirSync(bundleDir, { recursive: true });
    if (existsSync(logsDir)) {
      cpSync(logsDir, join(bundleDir, "logs"), { recursive: true });
    }
    writeFileSync(join(bundleDir, "env-summary.json"), JSON.stringify(envSummary, null, 2), "utf8");
    await runPowerShellCompress(bundleDir, savePath);
    logger.info("诊断包导出", { savePath });
    return savePath;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
function buildEnvSummary(extra) {
  const masked = JSON.stringify(extra, null, 2);
  return { generatedAt: (/* @__PURE__ */ new Date()).toISOString(), summary: JSON.parse(maskSecrets(masked)) };
}
class ForbiddenPathError extends Error {
  target;
  constructor(target) {
    super(`路径不在已授权工作区内：${target}`);
    this.name = "ForbiddenPathError";
    this.target = target;
  }
}
function norm(p) {
  let cur = resolve(p);
  const tail = [];
  for (; ; ) {
    try {
      const real = realpathSync(cur);
      return tail.length ? resolve(real, ...[...tail].reverse()) : real;
    } catch {
      tail.push(basename(cur));
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      cur = parent;
    }
  }
}
function normRoot(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}
function segmentsEqual(a, b) {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function isPathWithin(root, target) {
  const r = normRoot(root);
  const t = norm(target);
  if (segmentsEqual(r, t)) return true;
  const rel = relative(r, t);
  return rel !== "" && !rel.startsWith("..") && !parse(rel).root;
}
function assertWithinRoots(roots, target) {
  if (!target || typeof target !== "string") throw new ForbiddenPathError(String(target));
  const resolved = norm(target);
  for (const root of roots) {
    if (root && isPathWithin(root, resolved)) return resolved;
  }
  throw new ForbiddenPathError(resolved);
}
function chatSpaceDir() {
  return join(app.getPath("userData"), "chat-space");
}
async function ensureChatSpace() {
  const dir = chatSpaceDir();
  await mkdir(dir, { recursive: true });
  return dir;
}
function errorShape(err) {
  if (err instanceof z.ZodError) {
    return { code: "BAD_REQUEST", message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  if (err instanceof Error && err.name === "ForbiddenPathError") {
    return { code: "FORBIDDEN_PATH", message: err.message };
  }
  if (err instanceof Error) {
    logger.error("IPC 处理失败", { name: err.name, message: err.message });
    return { code: "INTERNAL", message: err.message };
  }
  return { code: "INTERNAL", message: String(err) };
}
function collectRoots(res) {
  if (!res || typeof res !== "object") return [];
  const r = res;
  const roots = [];
  if (typeof r.cwd === "string") roots.push(r.cwd);
  if (r.thread && typeof r.thread === "object") {
    const t = r.thread;
    if (typeof t.cwd === "string") roots.push(t.cwd);
  }
  return roots;
}
async function claudeAuthInfo() {
  try {
    const file = join(homedir(), ".claude.json");
    if (existsSync(file)) {
      const raw = JSON.parse(await readFile(file, "utf8"));
      const oauth = raw["oauthAccount"];
      const email = typeof oauth?.["emailAddress"] === "string" ? oauth["emailAddress"] : null;
      if (email && email.includes("@")) return { authMode: "oauth", email, apiHost: null };
    }
  } catch {
  }
  try {
    const file = join(homedir(), ".claude", "settings.json");
    if (existsSync(file)) {
      const raw = JSON.parse(await readFile(file, "utf8"));
      const env = raw["env"] ?? {};
      const hasToken = typeof env["ANTHROPIC_AUTH_TOKEN"] === "string" || typeof env["ANTHROPIC_API_KEY"] === "string";
      const base = typeof env["ANTHROPIC_BASE_URL"] === "string" ? env["ANTHROPIC_BASE_URL"] : null;
      if (hasToken && base) {
        try {
          const host = new URL(base).host;
          if (host) return { authMode: "api", email: null, apiHost: host };
        } catch {
        }
      }
    }
  } catch {
  }
  return { authMode: "none", email: null, apiHost: null };
}
const HANDLERS = {
  // ---------- app ----------
  [CHANNELS.app.version]: async (_ctx, _i, appVersion) => appVersion,
  [CHANNELS.app.windowControl]: async (ctx, input) => {
    const win = ctx.getWindow();
    if (!win) return null;
    if (input.action === "minimize") win.minimize();
    else if (input.action === "close") win.close();
    else if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return null;
  },
  // 渲染层标题栏据此初始化最大化按钮图标（事件推送见 index.ts 的窗口监听）。
  [CHANNELS.app.windowState]: async (ctx) => {
    const win = ctx.getWindow();
    return { maximized: win ? win.isMaximized() : false };
  },
  [CHANNELS.app.pickDirectory]: async (_ctx, input) => {
    const r = await dialog.showOpenDialog({
      title: "选择工作目录",
      defaultPath: input?.defaultPath,
      properties: ["openDirectory", "treatPackageAsDirectory"]
    });
    return r.canceled ? null : r.filePaths[0] ?? null;
  },
  [CHANNELS.app.pickFile]: async (_ctx, input) => {
    const r = await dialog.showOpenDialog({
      title: input?.title ?? "选择文件",
      defaultPath: input?.defaultPath,
      properties: ["openFile", "treatPackageAsDirectory"],
      filters: input?.filters
    });
    return r.canceled ? null : r.filePaths[0] ?? null;
  },
  [CHANNELS.app.showItem]: async (_ctx, input) => {
    shell.showItemInFolder(input.path);
    return null;
  },
  [CHANNELS.app.openExternal]: async (_ctx, input) => {
    if (!/^https?:\/\//i.test(input.url)) throw new Error("仅允许 http/https 链接");
    await shell.openExternal(input.url);
    return null;
  },
  [CHANNELS.app.openLogsDir]: async (ctx) => {
    const err = await shell.openPath(ctx.logsDir);
    if (err) throw new Error(err);
    return null;
  },
  [CHANNELS.app.chatSpace]: async () => ensureChatSpace(),
  // ---------- backend / wizard ----------
  [CHANNELS.backend.status]: async (ctx) => ctx.backend.getStatus(),
  [CHANNELS.backend.restart]: async (ctx, input) => ctx.backend.restart(input?.reason),
  [CHANNELS.backend.wizardGet]: async (ctx) => {
    const s2 = ctx.settings.get();
    return { completed: s2.wizardCompleted, activeProjectId: s2.activeProjectId, roots: s2.roots };
  },
  [CHANNELS.backend.wizardComplete]: async (ctx, input) => {
    ctx.settings.addRoots([input.projectPath]);
    const existing = ctx.projects.findWithRoots([input.projectPath]);
    let project;
    if (existing) {
      project = existing;
      ctx.settings.update({
        wizardCompleted: true,
        activeProjectId: existing.id
      });
    } else {
      project = ctx.projects.create({
        name: input.title?.trim() || basename(input.projectPath),
        roots: [{ path: input.projectPath }]
      });
      ctx.settings.update({
        wizardCompleted: true,
        activeProjectId: project.id
      });
    }
    return { project, degraded: false };
  },
  [CHANNELS.backend.setActiveProject]: async (ctx, input) => {
    ctx.settings.update({ activeProjectId: input.projectId });
    return null;
  },
  // ---------- projects（本地注册表） ----------
  [CHANNELS.projects.list]: (ctx, i) => ctx.projects.list(i ?? {}),
  [CHANNELS.projects.read]: (ctx, i) => ctx.projects.read(i),
  [CHANNELS.projects.create]: async (ctx, i) => {
    const rootPaths = (i.roots ?? []).map((r) => r.path).filter(Boolean);
    if (rootPaths.length > 0) {
      const existing = ctx.projects.findWithRoots(rootPaths);
      if (existing) return { project: existing };
    }
    return { project: ctx.projects.create(i) };
  },
  [CHANNELS.projects.update]: (ctx, i) => ctx.projects.update(i),
  [CHANNELS.projects.remove]: (ctx, i) => ctx.projects.remove(i),
  // ---------- threads ----------
  [CHANNELS.threads.list]: async (ctx, i) => ctx.conversation.listThreads(i ?? {}),
  [CHANNELS.threads.read]: (ctx, i) => ctx.conversation.readThread(i),
  [CHANNELS.threads.start]: async (ctx, i) => {
    const res = await ctx.conversation.startThread(i);
    ctx.settings.addRoots(collectRoots(res));
    return res;
  },
  // 纯对话：托管中性目录 + 只读语义 + 免审批；不登记进用户工作区 roots。
  [CHANNELS.threads.startChat]: async (ctx) => {
    const cwd = await ensureChatSpace();
    return ctx.conversation.startThread({
      cwd,
      sandbox: "read-only",
      approvalPolicy: "never"
    });
  },
  [CHANNELS.threads.resume]: async (ctx, i) => {
    const res = await ctx.conversation.resumeThread(i);
    const roots = collectRoots(res).filter(
      (r) => normProjectRoot(r) !== normProjectRoot(chatSpaceDir())
    );
    ctx.settings.addRoots(roots);
    return res;
  },
  [CHANNELS.threads.archive]: (ctx, i) => ctx.conversation.archiveThread(i),
  [CHANNELS.threads.unarchive]: (ctx, i) => ctx.conversation.unarchiveThread(i),
  [CHANNELS.threads.remove]: (ctx, i) => ctx.conversation.deleteThread(i),
  [CHANNELS.threads.turns]: (ctx, i) => ctx.conversation.listTurns(i),
  [CHANNELS.threads.search]: (ctx, i) => ctx.conversation.searchThreads(i ?? {}),
  [CHANNELS.threads.setName]: (ctx, i) => ctx.conversation.setThreadName(i),
  // ---------- turn ----------
  [CHANNELS.turn.start]: (ctx, i) => ctx.conversation.startTurn(i),
  [CHANNELS.turn.steer]: (ctx, i) => ctx.conversation.steerTurn(i),
  [CHANNELS.turn.interrupt]: (ctx, i) => ctx.conversation.interruptTurn(i),
  // 撤销本回合的文件改动：仅当文件当前内容仍等于改动后内容（newText）时才回滚，避免覆盖用户后续手动修改
  [CHANNELS.turn.revertChanges]: async (ctx, input) => {
    const roots = ctx.settings.get().roots;
    const reverted = [];
    const skipped = [];
    for (const raw of Array.isArray(input.changes) ? input.changes : []) {
      const c = raw ?? {};
      const p = s(c.path);
      if (!p) {
        skipped.push({ path: "", reason: "路径为空" });
        continue;
      }
      let target;
      try {
        target = assertWithinRoots(roots, p);
      } catch {
        skipped.push({ path: p, reason: "不在允许访问的目录内" });
        continue;
      }
      const hasOld = c.oldText !== void 0;
      const oldText = c.oldText == null ? null : s(c.oldText);
      const newText = c.newText == null ? null : s(c.newText);
      try {
        const exists = existsSync(target);
        if (newText != null) {
          if (!exists) {
            skipped.push({ path: p, reason: "文件已被移动或删除" });
            continue;
          }
          const cur = await readFile(target, "utf8");
          if (cur !== newText) {
            skipped.push({ path: p, reason: "文件之后又被修改过，为避免覆盖已跳过" });
            continue;
          }
        }
        if (!hasOld) {
          skipped.push({ path: p, reason: "缺少改动前内容，无法撤销" });
          continue;
        }
        if (oldText == null) {
          if (exists) await unlink(target);
        } else {
          await writeFile(target, oldText, "utf8");
        }
        reverted.push(p);
      } catch (err2) {
        skipped.push({ path: p, reason: err2 instanceof Error ? err2.message : String(err2) });
      }
    }
    return { reverted, skipped };
  },
  // ---------- approvals ----------
  [CHANNELS.approvals.list]: (ctx) => ctx.conversation.approvals.list(),
  // 决议必须真正送达后端：不可用时抛错，渲染层保留卡片并提示重试，
  // 绝不能静默回 null 让用户误以为已决议（后端会永久挂起等待）。
  [CHANNELS.approvals.resolveCommand]: async (ctx, i) => {
    await Promise.resolve(ctx.conversation.approvals.resolveCommand(i.localId, i.decision));
    return null;
  },
  [CHANNELS.approvals.resolveFileChange]: async (ctx, i) => {
    await Promise.resolve(ctx.conversation.approvals.resolveFileChange(i.localId, i.decision));
    return null;
  },
  [CHANNELS.approvals.respondError]: async (ctx, i) => {
    await Promise.resolve(ctx.conversation.approvals.respondError(i.localId, i.code, i.message, i.data));
    return null;
  },
  // ---------- fs（roots 白名单，本地直读） ----------
  [CHANNELS.fs.readFile]: async (ctx, input) => {
    // 应用自身管理的“已发送图片”目录（粘贴截图落盘处）不在用户 roots 内，单独放行只读
    let target;
    try {
      target = assertWithinRoots(ctx.settings.get().roots, input.path);
    } catch (err2) {
      const sentDir = join(app.getPath("userData"), "sent-images");
      const candidate = norm(input.path);
      if (isPathWithin(sentDir, candidate)) target = candidate;
      else throw err2;
    }
    const buf = await readFile(target);
    return { dataBase64: buf.toString("base64"), source: "local" };
  },
  [CHANNELS.fs.readDirectory]: async (ctx, input) => {
    const target = assertWithinRoots(ctx.settings.get().roots, input.path);
    const entries = await readdir(target, { withFileTypes: true });
    return { entries: entries.map((d) => ({ name: d.name, isDirectory: d.isDirectory() })), source: "local" };
  },
  // ---------- process（内置终端，ConPTY） ----------
  [CHANNELS.process.spawn]: (ctx, i) => {
    const roots = ctx.settings.get().roots;
    const defaultCwd = roots[0] ?? homedir();
    let cwd = defaultCwd;
    if (i?.cwd) {
      try {
        cwd = assertWithinRoots(roots, i.cwd);
      } catch {
        logger.warn("终端请求的 cwd 不在授权 roots 内，已回退默认", { cwd: i.cwd });
      }
    }
    return ctx.terminal.spawn(i ? { title: i.title } : {}, cwd);
  },
  [CHANNELS.process.writeStdin]: (ctx, i) => {
    ctx.terminal.write(i.id, i.data);
    return null;
  },
  [CHANNELS.process.resizePty]: (ctx, i) => {
    ctx.terminal.resize(i.id, i.cols, i.rows);
    return null;
  },
  [CHANNELS.process.kill]: (ctx, i) => {
    ctx.terminal.kill(i.id);
    return null;
  },
  // ---------- stats ----------
  [CHANNELS.stats.usage]: async (ctx) => aggregateUsage(await loadUsage(ctx.usageDir)),
  // ---------- settings ----------
  [CHANNELS.settings.account]: async () => {
    const info = await claudeAuthInfo();
    return { account: { type: "claude", ...info } };
  },
  [CHANNELS.settings.exportLogs]: async (ctx) => {
    const win = ctx.getWindow();
    const stamp = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    const r = await dialog.showSaveDialog(win ?? new BrowserWindow({ show: false }), {
      title: "导出诊断日志",
      defaultPath: `cc-diag-${stamp}.zip`,
      filters: [{ name: "ZIP", extensions: ["zip"] }]
    });
    if (r.canceled || !r.filePath) return null;
    const s2 = ctx.settings.get();
    const summary = buildEnvSummary({
      app: { version: ctx.appVersion },
      runtime: {
        platform: process.platform,
        osRelease: release(),
        electron: process.versions.electron,
        node: process.versions.node
      },
      settings: {
        wizardCompleted: s2.wizardCompleted,
        activeProjectId: s2.activeProjectId,
        roots: s2.roots,
        notifyTurnCompleted: s2.notifyTurnCompleted,
        notifyApprovals: s2.notifyApprovals,
        closeToTray: s2.closeToTray
      }
    });
    return exportLogs(ctx.logsDir, summary, r.filePath);
  },
  // ---------- update ----------
  [CHANNELS.settings.updateGet]: (ctx) => ctx.update.getState(),
  [CHANNELS.settings.updateCheck]: async (ctx) => ctx.update.checkNow(),
  [CHANNELS.settings.updateDownload]: async (ctx) => ctx.update.download(),
  [CHANNELS.settings.updateInstall]: (ctx) => {
    ctx.update.install();
    return null;
  },
  [CHANNELS.settings.prefsGet]: (ctx) => {
    const s2 = ctx.settings.get();
    return {
      notifyTurnCompleted: s2.notifyTurnCompleted,
      notifyApprovals: s2.notifyApprovals,
      closeToTray: s2.closeToTray,
      theme: s2.theme,
      updateFeedUrl: s2.updateFeedUrl
    };
  },
  [CHANNELS.settings.prefsSet]: (ctx, i) => {
    const patch = { ...i };
    if ("updateFeedUrl" in patch) ctx.update.resetForFeedChange();
    ctx.settings.update(patch);
    const s2 = ctx.settings.get();
    return {
      notifyTurnCompleted: s2.notifyTurnCompleted,
      notifyApprovals: s2.notifyApprovals,
      closeToTray: s2.closeToTray,
      theme: s2.theme,
      updateFeedUrl: s2.updateFeedUrl
    };
  }
};
function registerIpc(ctx, appVersion) {
  const fullCtx = { ...ctx, appVersion };
  for (const [channel, schema] of Object.entries(INPUTS)) {
    const handler = HANDLERS[channel];
    if (!handler) {
      logger.error("IPC 通道缺少 handler", { channel });
      continue;
    }
    ipcMain.handle(channel, async (_event, raw) => {
      const parsed = schema.safeParse(raw === void 0 ? void 0 : raw);
      if (!parsed.success) {
        return { ok: false, error: errorShape(parsed.error) };
      }
      try {
        const data = await handler(fullCtx, parsed.data, appVersion);
        return { ok: true, data: data ?? null };
      } catch (err) {
        return { ok: false, error: errorShape(err) };
      }
    });
  }
}
const currentDir$1 = dirname(fileURLToPath(import.meta.url));
function resourcePath(file) {
  return app.isPackaged ? join(process.resourcesPath, file) : join(currentDir$1, "..", "..", "resources", file);
}
const STATUS_LABEL = {
  idle: "未启动",
  resolving: "检测引擎…",
  ready: "引擎就绪",
  fatal: "引擎不可用"
};
class TrayService {
  tray;
  opts;
  statusItem;
  constructor(opts) {
    this.opts = opts;
    const image = nativeImage.createFromPath(resourcePath("tray.png"));
    this.tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
    this.tray.setToolTip("CC Desktop");
    this.buildMenu({ state: "idle", claude: null, fatalMessage: null });
    this.tray.on("click", () => this.toggleWindow());
    this.tray.on("double-click", () => this.showWindow());
  }
  buildMenu(status) {
    const version = status.claude?.version ? ` · Claude Code ${status.claude.version}` : "";
    const template = [
      {
        id: "show",
        label: "显示主界面",
        click: () => this.showWindow()
      },
      {
        label: "新建会话",
        click: () => {
          this.showWindow();
          this.opts.onNewThread();
        }
      },
      { type: "separator" },
      {
        id: "status",
        label: `引擎：${STATUS_LABEL[status.state]}${version}`,
        enabled: false
      },
      { type: "separator" },
      {
        label: "退出 CC Desktop",
        click: () => this.opts.onQuit()
      }
    ];
    const menu = Menu.buildFromTemplate(template);
    this.tray.setContextMenu(menu);
    this.statusItem = menu.getMenuItemById("status");
  }
  showWindow() {
    const win = this.opts.getWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  hideWindow() {
    const win = this.opts.getWindow();
    if (win && !win.isDestroyed()) win.hide();
  }
  toggleWindow() {
    const win = this.opts.getWindow();
    if (!win) return;
    if (win.isVisible() && !win.isMinimized()) {
      win.hide();
    } else {
      this.showWindow();
    }
  }
  setStatus(status) {
    const version = status.claude?.version ? ` · Claude Code ${status.claude.version}` : "";
    if (this.statusItem) {
      this.statusItem.label = `引擎：${STATUS_LABEL[status.state]}${version}`;
    }
    this.tray.setToolTip(`CC Desktop — ${STATUS_LABEL[status.state]}`);
  }
  destroy() {
    try {
      this.tray.destroy();
    } catch (err) {
      logger.warn("托盘销毁失败", { message: err.message });
    }
  }
}
const APPROVAL_TITLES = {
  "requestPatchApply": "需要确认文件修改",
  "item/commandExecution/requestApproval": "需要确认命令执行",
  "applyPatch": "需要确认文件修改",
  "elicit": "需要你提供信息"
};
class NotificationService {
  constructor(backend2, getWindow, getPrefs, broadcast2) {
    this.backend = backend2;
    this.getWindow = getWindow;
    this.getPrefs = getPrefs;
    this.broadcast = broadcast2;
  }
  backend;
  getWindow;
  getPrefs;
  broadcast;
  notifiedApprovals = /* @__PURE__ */ new Set();
  bind() {
    this.backend.on("notification", (envelope) => this.onTurnNotification(envelope));
    this.backend.on("approval", (approval) => this.onApproval(approval));
  }
  /** 窗口当前可见且聚焦时，系统通知属于打扰，跳过。 */
  userActive() {
    const win = this.getWindow();
    return Boolean(win && win.isVisible() && win.isFocused());
  }
  activate(payload) {
    const win = this.getWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    this.broadcast(EVENTS.appShow, payload);
  }
  notify(title, body, payload) {
    try {
      const n = new Notification({
        title,
        body,
        icon: resourcePath("icon.png"),
        silent: false
      });
      n.on("click", () => this.activate(payload));
      n.show();
      logger.info("系统通知已发送", { title, body });
    } catch (err) {
      logger.warn("系统通知发送失败", { message: err.message });
    }
  }
  onTurnNotification(envelope) {
    if (envelope.method !== "turn/completed") return;
    const prefs = this.getPrefs();
    if (!prefs.notifyTurnCompleted || this.userActive()) return;
    const p = envelope.params ?? {};
    const failed = p.turn?.status === "failed" || Boolean(p.turn?.error);
    this.notify(
      failed ? "Claude Code 回合失败" : "Claude Code 已完成回复",
      failed ? p.turn?.error?.message ?? "点击查看详情" : "点击回到会话",
      { kind: "turn", threadId: p.threadId ?? null, failed }
    );
  }
  onApproval(approval) {
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
  approvalSummary(approval) {
    const params = approval.params ?? {};
    const command = this.findString(params, ["command", "cmd"]);
    if (command) return command.length > 120 ? `${command.slice(0, 120)}…` : command;
    const filePath = this.findString(params, ["path", "filePath", "filename"]);
    if (filePath) return filePath;
    return "点击查看并处理";
  }
  findString(obj, keys) {
    if (!obj || typeof obj !== "object") return null;
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === "string" && v.trim()) return v;
    }
    for (const v of Object.values(obj)) {
      if (v && typeof v === "object") {
        const hit = this.findString(v, keys);
        if (hit) return hit;
      }
    }
    return null;
  }
}
const SHELL_CANDIDATES = ["pwsh.exe", "powershell.exe", "cmd.exe"];
function findOnPath(exe) {
  const dirs = (process.env["PATH"] ?? "").split(";").filter(Boolean);
  for (const dir of dirs) {
    const full = join(dir.trim(), exe);
    if (existsSync(full)) return full;
  }
  return null;
}
function resolveShell(requested) {
  if (requested && requested.endsWith(".exe") && existsSync(requested)) return requested;
  for (const exe of SHELL_CANDIDATES) {
    const found = findOnPath(exe);
    if (found) return found;
  }
  return "cmd.exe";
}
class TerminalService {
  ptys = /* @__PURE__ */ new Map();
  broadcast;
  constructor(broadcast2) {
    this.broadcast = broadcast2;
  }
  spawn(input, defaultCwd) {
    const cwd = input.cwd && existsSync(input.cwd) ? input.cwd : existsSync(defaultCwd) ? defaultCwd : homedir();
    const shell2 = resolveShell(input.shell);
    const title = input.title?.trim() || basename(cwd) || shell2;
    const id = randomUUID();
    let proc;
    try {
      proc = pty.spawn(shell2, [], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd,
        env: { ...process.env }
      });
    } catch (e) {
      logger.error("终端 ConPTY 启动失败", {
        message: e.message,
        stack: e.stack
      });
      throw e;
    }
    this.ptys.set(id, proc);
    proc.onData((data) => {
      this.broadcast(EVENTS.processOutputDelta, { id, data });
    });
    proc.onExit(({ exitCode }) => {
      this.ptys.delete(id);
      logger.info("终端进程退出", { id, exitCode });
      this.broadcast(EVENTS.processExited, { id, exitCode });
    });
    logger.info("终端进程启动", { id, shell: shell2, cwd });
    return { id, shell: shell2, title, cwd };
  }
  write(id, data) {
    this.ptys.get(id)?.write(data);
  }
  resize(id, cols, rows) {
    try {
      this.ptys.get(id)?.resize(cols, rows);
    } catch {
    }
  }
  /** 手动关闭标签；ConPTY kill 会带走整棵子进程树。 */
  kill(id) {
    const proc = this.ptys.get(id);
    if (!proc) return;
    this.ptys.delete(id);
    try {
      proc.kill();
    } catch (err) {
      logger.warn("终端进程 kill 失败", { id, err: String(err) });
    }
  }
  /** 退出应用前统一清理，防止残留 shell 持有工作目录。 */
  killAll() {
    for (const [id, proc] of this.ptys) {
      this.ptys.delete(id);
      try {
        proc.kill();
      } catch {
      }
    }
  }
}
const { autoUpdater } = updaterModule;
const AUTO_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1e3;
class UpdateService extends EventEmitter {
  constructor(broadcast2, getFeedUrl) {
    super();
    this.broadcast = broadcast2;
    this.getFeedUrl = getFeedUrl;
  }
  broadcast;
  getFeedUrl;
  state = {
    status: "idle",
    version: null,
    progress: null,
    error: null,
    lastCheckedAt: null
  };
  timer = null;
  wired = false;
  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.broadcast(EVENTS.updateState, this.getState());
  }
  getState() {
    return { ...this.state };
  }
  configured() {
    const url = this.getFeedUrl();
    return url && /^https?:\/\//i.test(url) ? url : null;
  }
  /** 绑定 electron-updater 事件（打包版首次使用时执行一次）。 */
  wire() {
    if (!app.isPackaged) return false;
    if (this.wired) return true;
    try {
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.on("checking-for-update", () => this.setState({ status: "checking", error: null }));
      autoUpdater.on("update-available", (info) => {
        this.setState({ status: "available", version: info.version ?? null, progress: null });
        logger.info("发现新版本", { version: info.version });
      });
      autoUpdater.on("update-not-available", () => this.setState({ status: "none", version: null }));
      autoUpdater.on("download-progress", (p) => {
        this.setState({ status: "downloading", progress: Math.round(p.percent ?? 0) });
      });
      autoUpdater.on("update-downloaded", (info) => {
        this.setState({ status: "downloaded", version: info.version ?? null, progress: 100 });
        logger.info("更新包下载完成", { version: info.version });
      });
      autoUpdater.on("error", (err) => {
        this.setState({ status: "error", error: err?.message ?? String(err) });
        logger.warn("更新检查失败", { message: err?.message ?? String(err) });
      });
      this.wired = true;
      return true;
    } catch (err) {
      logger.warn("更新服务初始化失败", { message: err.message });
      return false;
    }
  }
  async applyFeed() {
    if (!this.wire()) return false;
    const url = this.configured();
    if (!url) {
      this.setState({ status: "disabled", error: null, progress: null });
      return false;
    }
    autoUpdater.setFeedURL({ provider: "generic", url });
    return true;
  }
  /** 启动钩子：已配置更新源时延迟自动检查 + 定时轮询。 */
  startAutoCheck() {
    if (!app.isPackaged) return;
    const initial = setTimeout(() => {
      void this.checkNow().catch(() => void 0);
    }, 1e4);
    initial.unref?.();
    this.timer = setInterval(() => {
      void this.checkNow().catch(() => void 0);
    }, AUTO_CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }
  /** 更新源变更后调用：回到待命状态，下次检查按新源执行。 */
  resetForFeedChange() {
    if (!app.isPackaged) return;
    this.state = { status: "idle", version: null, progress: null, error: null, lastCheckedAt: this.state.lastCheckedAt };
    this.emit("state", this.getState());
    this.broadcast(EVENTS.updateState, this.getState());
  }
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
  async checkNow() {
    if (!await this.applyFeed()) return this.getState();
    this.setState({ status: "checking", error: null });
    try {
      await autoUpdater.checkForUpdates();
      this.setState({ lastCheckedAt: Date.now() });
    } catch (err) {
      this.setState({
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        lastCheckedAt: Date.now()
      });
    }
    return this.getState();
  }
  async download() {
    if (!this.wired) {
      this.setState({ status: "error", error: "开发模式不支持更新" });
      return this.getState();
    }
    try {
      await autoUpdater.downloadUpdate();
    } catch (err) {
      this.setState({ status: "error", error: err instanceof Error ? err.message : String(err) });
    }
    return this.getState();
  }
  install() {
    if (!this.wired) return;
    if (this.state.status !== "downloaded") return;
    this.stop();
    autoUpdater.quitAndInstall(true, true);
  }
}
const currentDir = dirname(fileURLToPath(import.meta.url));
const preloadPath = join(currentDir, "../preload/index.cjs");
const rendererDistPath = join(currentDir, "../renderer/index.html");
const rendererDevUrl = process.env["ELECTRON_RENDERER_URL"];
const CSP_PROD = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'";
const CSP_DEV = "default-src 'self' http://localhost:* ws://localhost:*; script-src 'self' http://localhost:* 'unsafe-inline'; style-src 'self' http://localhost:* 'unsafe-inline'; img-src 'self' data: blob: http://localhost:*; font-src 'self' data:; connect-src 'self' ws://localhost:* http://localhost:*; object-src 'none'";
function installContentSecurityPolicy() {
  const csp = rendererDevUrl ? CSP_DEV : CSP_PROD;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp],
        "X-Content-Type-Options": ["nosniff"]
      }
    });
  });
  const CLIPBOARD_WRITE_PERMS = /* @__PURE__ */ new Set(["clipboard-write", "clipboard-sanitized-write"]);
  const isClipboardWrite = (permission) => CLIPBOARD_WRITE_PERMS.has(permission);
  session.defaultSession.setPermissionRequestHandler(
    (_wc, permission, callback) => callback(isClipboardWrite(permission))
  );
  session.defaultSession.setPermissionCheckHandler(
    (_wc, permission) => isClipboardWrite(permission)
  );
}
async function createMainWindow(saved) {
  const webPreferences = {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: false,
    webSecurity: true,
    allowRunningInsecureContent: false
  };
  const win = new BrowserWindow({
    ...saved?.bounds ?? { width: 1280, height: 832 },
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#0b0d10",
    title: "CC Desktop",
    frame: false,
    autoHideMenuBar: true,
    icon: process.platform === "win32" ? resourcePath("icon.png") : void 0,
    webPreferences
  });
  if (saved?.maximized) win.maximize();
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    let allowed = false;
    if (rendererDevUrl) {
      allowed = url.startsWith(rendererDevUrl);
    } else {
      const currentUrl = win.webContents.getURL();
      const dirPrefix = currentUrl.slice(0, currentUrl.lastIndexOf("/") + 1);
      allowed = dirPrefix.startsWith("file:///") && url.startsWith(dirPrefix);
    }
    if (!allowed) {
      event.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });
  if (rendererDevUrl) {
    await win.loadURL(rendererDevUrl);
  } else {
    await win.loadFile(rendererDistPath);
  }
  return win;
}
const DEFAULTS = {
  bounds: { x: 120, y: 80, width: 1280, height: 832 },
  maximized: false
};
function isVisible(rect) {
  const minW = 120;
  const minH = 80;
  const corners = [
    [rect.x, rect.y],
    [rect.x + rect.width - minW, rect.y],
    [rect.x, rect.y + rect.height - minH],
    [rect.x + rect.width - minW, rect.y + rect.height - minH]
  ];
  return corners.some(
    ([x, y]) => screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return x >= a.x && x < a.x + a.width && y >= a.y && y < a.y + a.height;
    })
  );
}
class WindowStateStore {
  file;
  state;
  timer = null;
  constructor(app2) {
    this.file = join(app2.getPath("userData"), "window-state.json");
    this.state = this.load();
  }
  load() {
    if (!existsSync(this.file)) return DEFAULTS;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      const b = raw.bounds;
      if (b && typeof b.x === "number" && typeof b.y === "number" && typeof b.width === "number" && typeof b.height === "number" && b.width >= 960 && b.height >= 600 && isVisible(b)) {
        return { bounds: { ...b }, maximized: Boolean(raw.maximized) };
      }
      return DEFAULTS;
    } catch {
      try {
        renameSync(this.file, `${this.file}.corrupt`);
      } catch {
      }
      return DEFAULTS;
    }
  }
  get() {
    return { bounds: { ...this.state.bounds }, maximized: this.state.maximized };
  }
  /** 从当前窗口采集状态（防抖写盘，避免拖动时频繁 IO）。 */
  track(win) {
    const save = () => {
      if (win.isDestroyed()) return;
      this.state.maximized = win.isMaximized();
      if (!this.state.maximized) this.state.bounds = win.getBounds();
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flush(), 400);
    };
    win.on("resize", save);
    win.on("move", save);
    win.on("maximize", save);
    win.on("unmaximize", save);
  }
  flush() {
    try {
      writeFileSync(this.file, JSON.stringify(this.state, null, 2), "utf8");
    } catch {
    }
  }
}
const SELFTEST = process.env["CC_SELFTEST"] === "1";
app.setName("CC Desktop");
if (SELFTEST) {
  app.setPath("userData", join(tmpdir(), "cc-selftest-userdata"));
}
app.setAppUserModelId("com.cc.desktop");
if (app.isPackaged && process.platform === "win32") {
  app.setAsDefaultProtocolClient("cc-desktop");
}
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}
let mainWindow = null;
let backend = null;
let claudeBackend = null;
let tray = null;
let windowState = null;
let isQuitting = false;
const terminal = new TerminalService((event, payload) => broadcast(event, payload));
let updater = null;
function parseOpenArg(argv) {
  for (const arg of argv.slice(1)) {
    if (arg.startsWith("cc-desktop://")) {
      try {
        const url = new URL(arg);
        const p = url.searchParams.get("path");
        if (p && isAbsolute(p) && existsSync(p) && statSync(p).isDirectory()) return p;
      } catch {
      }
      continue;
    }
    if (arg.startsWith("-") || !isAbsolute(arg)) continue;
    try {
      if (existsSync(arg) && statSync(arg).isDirectory()) return arg;
    } catch {
    }
  }
  return null;
}
function broadcast(event, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("cc:event", { event, payload });
  }
}
function showWindow() {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
function bindWindowStateEvents(win) {
  const emit = (maximized) => {
    if (!win.isDestroyed()) {
      win.webContents.send("cc:event", {
        event: EVENTS.appWindowState,
        payload: { maximized }
      });
    }
  };
  win.on("maximize", () => emit(true));
  win.on("unmaximize", () => emit(false));
}
async function runSelfTest(win) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const deadline = Date.now() + 45e3;
  while (Date.now() < deadline && backend?.getStatus().state !== "ready") await sleep(500);
  const probeRoot = join(tmpdir(), "cc-selftest-root");
  const result = await win.webContents.executeJavaScript(`(async () => {
    const out = {};
    out.requireType = typeof require;
    out.processType = typeof process;
    out.ccPresent = !!window.cc;
    out.bridgeKeys = window.cc ? Object.keys(window.cc) : [];
    try { (0, eval)("1+1"); out.evalBlocked = false; } catch { out.evalBlocked = true; }
    try {
      const r = await fetch(location.href);
      out.cspHeader = r.headers.get("content-security-policy");
    } catch (e) { out.cspHeader = "fetch-error:" + e.message; }
    try {
      await window.cc.backend.wizardComplete({ projectPath: ${JSON.stringify(probeRoot)} });
      out.wizard = "ok";
    } catch (e) { out.wizard = "err:" + (e.code || e.message); }
    try {
      await window.cc.fs.readFile({ path: ${JSON.stringify(probeRoot)} + "\\\\..\\\\..\\\\secret.txt" });
      out.traversal = "allowed(!)";
    } catch (e) { out.traversal = e.code || e.message; }
    try {
      await window.cc.threads.resume({});
      out.malformed = "accepted(!)";
    } catch (e) { out.malformed = e.code || e.message; }
    out.status = (await window.cc.backend.status()).state;
    return out;
  })()`);
  console.log("CC_SELFTEST_RESULT " + JSON.stringify(result));
  await backend?.stop();
  await sleep(300);
  app.exit(0);
}
if (gotLock) {
  app.on("second-instance", (_event, argv) => {
    showWindow();
    const openPath = parseOpenArg(argv);
    if (openPath) broadcast(EVENTS.appOpenPath, { path: openPath });
    else broadcast(EVENTS.appShow);
  });
}
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
let quitting = false;
app.on("before-quit", (event) => {
  isQuitting = true;
  if (quitting) {
    event.preventDefault();
    app.exit(0);
    return;
  }
  event.preventDefault();
  quitting = true;
  terminal.killAll();
  void claudeBackend?.dispose();
  tray?.destroy();
  setTimeout(() => app.exit(0), 1500);
});
if (gotLock) {
  app.whenReady().then(async () => {
    installContentSecurityPolicy();
    Menu.setApplicationMenu(null);
    const settings = new AppSettings(app);
    const projects = new ProjectsStore(app);
    windowState = new WindowStateStore(app);
    backend = new BackendService(app, app.getVersion());
    backend.on("status", (snapshot) => {
      broadcast(EVENTS.backendStatus, snapshot);
      tray?.setStatus(snapshot);
    });
    updater = new UpdateService(broadcast, () => settings.get().updateFeedUrl ?? null);
    const claudeConv = new ClaudeBackend(app.getPath("userData"));
    claudeBackend = claudeConv;
    claudeConv.on("notification", (envelope) => broadcast(EVENTS.backendNotification, envelope));
    claudeConv.on("approval", (approval) => broadcast(EVENTS.approvalChanged, approval));
    const logsDir = join(app.getPath("userData"), "logs");
    registerIpc(
      {
        backend,
        settings,
        projects,
        terminal,
        logsDir,
        update: updater,
        usageDir: join(app.getPath("userData"), "claude-backend"),
        getWindow: () => mainWindow,
        conversation: claudeConv
      },
      app.getVersion()
    );
    const notifications = new NotificationService(
      claudeConv,
      () => mainWindow,
      () => settings.get(),
      broadcast
    );
    notifications.bind();
    tray = new TrayService({
      getWindow: () => mainWindow,
      onNewThread: () => broadcast(EVENTS.appNewThread),
      onQuit: () => app.quit()
    });
    mainWindow = await createMainWindow(windowState.get());
    windowState.track(mainWindow);
    bindWindowStateEvents(mainWindow);
    mainWindow.on("close", (event) => {
      if (!isQuitting && settings.get().closeToTray) {
        event.preventDefault();
        mainWindow?.hide();
      }
    });
    mainWindow.on("closed", () => {
      mainWindow = null;
    });
    const openPath = parseOpenArg(process.argv);
    if (openPath) {
      mainWindow.webContents.once(
        "did-finish-load",
        () => broadcast(EVENTS.appOpenPath, { path: openPath })
      );
    }
    backend.init();
    updater.startAutoCheck();
    void backend.probe().finally(() => {
      if (SELFTEST && mainWindow) void runSelfTest(mainWindow);
    });
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createMainWindow(windowState?.get()).then((win) => {
          mainWindow = win;
          windowState?.track(win);
          bindWindowStateEvents(win);
        });
      } else {
        showWindow();
      }
    });
  }).catch((err) => {
    console.error("应用启动失败", err);
  });
}
