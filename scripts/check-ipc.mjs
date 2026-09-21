#!/usr/bin/env node
/**
 * Task 4 验收（可在无 Electron 环境运行的部分）：
 *  TR-4.2 任一 IPC 通道畸形/越权 payload 被 zod 拒绝（返回错误而非崩溃）
 *  TR-4.4 fs 读取被限制在已授权 roots（.. / 跨盘符 / UNC 拒绝）
 *  TR-4.5 CHANNELS / INPUTS / HANDLERS 三方覆盖一致
 *  TR-4.1/4.3（CSP、横幅、DevTools）由 dev 运行人工核验。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const shared = await import(pathToFileURL(join(root, "src/shared/ipc/contract.ts")).href);
const guard = await import(pathToFileURL(join(root, "src/main/ipc/path-guard.ts")).href);
const { CHANNELS, INPUTS, EVENTS } = shared;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const leaves = Object.values(CHANNELS).flatMap((g) => Object.values(g));

// ---------- TR-4.5 覆盖 ----------
{
  const missingSchema = leaves.filter((ch) => !INPUTS[ch]);
  check("TR-4.5 每个通道都有 zod schema", missingSchema.length === 0, missingSchema.join(","));

  const handlerSrc = readFileSync(join(root, "src/main/ipc/register-ipc.ts"), "utf8");
  // 提取 HANDLERS 表内出现的通道引用，如 [C.threads.resume]
  const handled = new Set([...handlerSrc.matchAll(/\[C\.([a-zA-Z]+)\.([a-zA-Z]+)\]/g)].map((m) => `${m[1]}.${m[2]}`));
  const missingHandler = leaves.filter((ch) => {
    // ch 形如 "threads:resume"，反查 CHANNELS 路径
    for (const [g, map] of Object.entries(CHANNELS)) {
      for (const [m, val] of Object.entries(map)) {
        if (val === ch) return !handled.has(`${g}.${m}`);
      }
    }
    return true;
  });
  check(`TR-4.5 每个通道都有 handler（${leaves.length} 通道）`, missingHandler.length === 0, missingHandler.join(","));

  const pushNames = Object.values(EVENTS);
  check("TR-4.5 推送事件名集合非空且唯一", new Set(pushNames).size === pushNames.length && pushNames.length >= 3);
}

// ---------- TR-4.2 畸形入参 ----------
const rejects = (channel, payload, label) => {
  const r = INPUTS[channel].safeParse(payload);
  check(`TR-4.2 ${label} 被拒`, !r.success);
};
const accepts = (channel, payload, label, retainKey) => {
  const r = INPUTS[channel].safeParse(payload);
  const ok = r.success && (!retainKey || r.data?.[retainKey] === payload[retainKey]);
  check(`TR-4.2 ${label} 放行${retainKey ? `（保留 ${retainKey}）` : ""}`, ok);
};

rejects(CHANNELS.app.windowControl, { action: "explode" }, "windowControl 非法枚举");
rejects(CHANNELS.app.windowControl, {}, "windowControl 缺 action");
rejects(CHANNELS.app.showItem, { path: 123 }, "showItem 路径非字符串");
rejects(CHANNELS.fs.readFile, {}, "fs.readFile 缺 path");
rejects(CHANNELS.fs.readFile, { path: "" }, "fs.readFile 空路径");
rejects(CHANNELS.threads.resume, { excludeTurns: true }, "resume 缺 threadId");
rejects(CHANNELS.threads.resume, { threadId: "", excludeTurns: true }, "resume 空 threadId");
rejects(CHANNELS.threads.turns, { threadId: "x", limit: 9999 }, "turns 分页超限");
rejects(CHANNELS.turn.start, { threadId: "x", input: [] }, "turn.start 空 input");
rejects(CHANNELS.approvals.resolveCommand, { localId: "a", decision: "maybe" }, "审批非法 decision");
rejects(CHANNELS.approvals.resolveFileChange, { localId: "a", decision: "accept", evil: 1 }, "strict 通道拒绝多余键");
rejects(CHANNELS.approvals.resolveUserInput, { localId: "a", answers: { q: ["x"] } }, "userInput answers 结构错误");
rejects(CHANNELS.backend.restart, { reason: 99 }, "restart reason 类型错误");

accepts(CHANNELS.threads.resume, { threadId: "t1", excludeTurns: true }, "resume 合法", "excludeTurns");
accepts(CHANNELS.threads.list, { limit: 50, projectId: "p1" }, "threads.list 合法并透传", "projectId");
accepts(CHANNELS.approvals.resolveUserInput, { localId: "a", answers: { q: { answers: ["yes"] } } }, "userInput 合法");
accepts(CHANNELS.backend.status, undefined, "无参通道 undefined");
accepts(CHANNELS.backend.status, undefined, "无参通道缺省");
{
  const r = INPUTS[CHANNELS.fs.readFile].safeParse({ path: "C:\\work\\a.txt", extra: 1 });
  check("TR-4.2 fs 严格通道拒绝多余键", !r.success);
}

// ---------- TR-4.4 roots 守卫 ----------
{
  const roots = ["D:\\CC", "D:\\projects\\demo"];
  const okInside = [
    "D:\\CC\\src\\main\\index.ts",
    "D:\\cc\\..\\cc\\package.json",
    "D:\\projects\\demo\\README.md",
    "D:\\projects\\demo\\nested\\deep\\file.txt",
  ];
  for (const p of okInside) {
    try {
      guard.assertWithinRoots(roots, p);
      check(`TR-4.4 授权内路径放行：${p}`, true);
    } catch {
      check(`TR-4.4 授权内路径放行：${p}`, false);
    }
  }
  const bad = [
    "D:\\CC\\..\\secret.txt",
    "D:\\CC2\\x.txt",
    "C:\\Windows\\system32\\config\\SAM",
    "\\\\?\\D:\\Other\\x",
    "D:/projects/demo/../../else/x.ts",
  ];
  for (const p of bad) {
    let blocked = false;
    try {
      guard.assertWithinRoots(roots, p);
    } catch (e) {
      blocked = e.name === "ForbiddenPathError";
    }
    check(`TR-4.4 越界路径拒绝：${p}`, blocked);
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\ncheck-ipc: ${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
