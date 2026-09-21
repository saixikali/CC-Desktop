/**
 * fs IPC 越权防护：所有渲染端请求的文件/目录路径，必须落在已授权 roots 之内。
 * 规范化后按段比较，Windows 大小写/斜杠不敏感；拒绝 `..` 越界、盘符切换、UNC 穿越。
 * 对已存在路径再做 realpath 归一，防止 root 内符号链接/junction 指向 root 外。
 */
import { realpathSync } from "node:fs";
import { resolve, parse, relative, basename, dirname } from "node:path";

export class ForbiddenPathError extends Error {
  readonly target: string;
  constructor(target: string) {
    super(`路径不在已授权工作区内：${target}`);
    this.name = "ForbiddenPathError";
    this.target = target;
  }
}

/** 词法规范化；存在的部分 realpath 展开（符号链接/junction），尾部不存在段原样拼回。 */
function norm(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(cur);
      return tail.length ? resolve(real, ...[...tail].reverse()) : real;
    } catch {
      tail.push(basename(cur));
      const parent = dirname(cur);
      if (parent === cur) return resolve(p); // 盘符都不存在，回退纯词法结果
      cur = parent;
    }
  }
}

/** root 真实路径（root 一定存在；失败回退词法路径）。 */
function normRoot(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function segmentsEqual(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** target 是否等于 root 或位于 root 子树内。 */
export function isPathWithin(root: string, target: string): boolean {
  const r = normRoot(root);
  const t = norm(target);
  if (segmentsEqual(r, t)) return true;
  const rel = relative(r, t);
  return rel !== "" && !rel.startsWith("..") && !parse(rel).root;
}

export function assertWithinRoots(roots: readonly string[], target: string): string {
  if (!target || typeof target !== "string") throw new ForbiddenPathError(String(target));
  const resolved = norm(target);
  for (const root of roots) {
    if (root && isPathWithin(root, resolved)) return resolved;
  }
  throw new ForbiddenPathError(resolved);
}
