#!/usr/bin/env node
/**
 * Static and behavioral checks for the IPC contract.
 *
 * Verifies that channels, schemas, and handlers are aligned, malformed payloads
 * are rejected, and filesystem requests are restricted to authorized roots.
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
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
}

const channels = Object.values(CHANNELS).flatMap((group) => Object.values(group));

{
  const missingSchema = channels.filter((channel) => !INPUTS[channel]);
  check("Every channel has a zod schema", missingSchema.length === 0, missingSchema.join(","));

  const handlerSource = readFileSync(join(root, "src/main/ipc/register-ipc.ts"), "utf8");
  const handled = new Set(
    [...handlerSource.matchAll(/\[C\.([a-zA-Z]+)\.([a-zA-Z]+)\]/g)].map(
      (match) => `${match[1]}.${match[2]}`,
    ),
  );
  const missingHandler = channels.filter((channel) => {
    for (const [group, methods] of Object.entries(CHANNELS)) {
      for (const [method, value] of Object.entries(methods)) {
        if (value === channel) return !handled.has(`${group}.${method}`);
      }
    }
    return true;
  });
  check(`Every channel has a handler (${channels.length} channels)`, missingHandler.length === 0, missingHandler.join(","));

  const eventNames = Object.values(EVENTS);
  check(
    "Push event names are non-empty and unique",
    eventNames.length >= 3 && new Set(eventNames).size === eventNames.length,
  );
}

function rejects(channel, payload, label) {
  const result = INPUTS[channel].safeParse(payload);
  check(`${label} is rejected`, !result.success);
}

function accepts(channel, payload, label, retainedKey) {
  const result = INPUTS[channel].safeParse(payload);
  const retained = !retainedKey || result.data?.[retainedKey] === payload[retainedKey];
  check(`${label} is accepted${retainedKey ? ` (${retainedKey} retained)` : ""}`, result.success && retained);
}

rejects(CHANNELS.app.windowControl, { action: "explode" }, "Invalid window action");
rejects(CHANNELS.app.windowControl, {}, "Missing window action");
rejects(CHANNELS.app.showItem, { path: 123 }, "Non-string showItem path");
rejects(CHANNELS.fs.readFile, {}, "Missing fs.readFile path");
rejects(CHANNELS.fs.readFile, { path: "" }, "Empty fs.readFile path");
rejects(CHANNELS.threads.resume, { excludeTurns: true }, "Missing resume threadId");
rejects(CHANNELS.threads.resume, { threadId: "", excludeTurns: true }, "Empty resume threadId");
rejects(CHANNELS.threads.turns, { threadId: "x", limit: 9999 }, "Oversized turns page");
rejects(CHANNELS.turn.start, { threadId: "x", input: [] }, "Empty turn input");
rejects(CHANNELS.approvals.resolveCommand, { localId: "a", decision: "maybe" }, "Invalid approval decision");
rejects(
  CHANNELS.approvals.resolveFileChange,
  { localId: "a", decision: "accept", extra: 1 },
  "Extra strict approval key",
);
rejects(
  CHANNELS.approvals.respondError,
  { localId: "a", code: "bad", message: "x" },
  "Non-numeric approval error code",
);
rejects(CHANNELS.backend.restart, { reason: 99 }, "Non-string restart reason");

accepts(
  CHANNELS.threads.resume,
  { threadId: "t1", excludeTurns: true },
  "Valid resume payload",
  "excludeTurns",
);
accepts(
  CHANNELS.threads.list,
  { limit: 50, projectId: "p1" },
  "Valid list payload",
  "projectId",
);
accepts(
  CHANNELS.approvals.respondError,
  { localId: "a", code: 1, message: "x" },
  "Valid approval error payload",
);
accepts(CHANNELS.backend.status, undefined, "Undefined payload for no-argument channel");

{
  const result = INPUTS[CHANNELS.fs.readFile].safeParse({ path: "C:\\work\\a.txt", extra: 1 });
  check("Strict fs channel rejects extra keys", !result.success);
}

{
  const roots = ["D:\\CC", "D:\\projects\\demo"];
  const allowed = [
    "D:\\CC\\src\\main\\index.ts",
    "D:\\cc\\..\\cc\\package.json",
    "D:\\projects\\demo\\README.md",
    "D:\\projects\\demo\\nested\\deep\\file.txt",
  ];
  for (const path of allowed) {
    try {
      guard.assertWithinRoots(roots, path);
      check(`Authorized path is allowed: ${path}`, true);
    } catch {
      check(`Authorized path is allowed: ${path}`, false);
    }
  }

  const blocked = [
    "D:\\CC\\..\\secret.txt",
    "D:\\CC2\\x.txt",
    "C:\\Windows\\system32\\config\\SAM",
    "\\\\?\\D:\\Other\\x",
    "D:/projects/demo/../../else/x.ts",
  ];
  for (const path of blocked) {
    let denied = false;
    try {
      guard.assertWithinRoots(roots, path);
    } catch (error) {
      denied = error.name === "ForbiddenPathError";
    }
    check(`Out-of-root path is blocked: ${path}`, denied);
  }
}

const failed = results.filter((result) => !result.ok);
console.log(`\nIPC checks: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
