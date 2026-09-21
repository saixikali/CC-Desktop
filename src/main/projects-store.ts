/**
 * 本地工作区注册表：userData/projects.json。
 *  - 替代后端 projects API：桌面端自持工作区记录（id/名称/roots/时间戳）
 *  - 原子写（tmp+rename）；文件损坏时回退空表并保留 .corrupt 备份
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { App } from "electron";

export interface ProjectRecord {
  id: string;
  name: string;
  roots: string[];
  createdAt: number;
  updatedAt: number;
}

/** Windows 下归一化工作目录（反斜杠/小写/去尾部斜杠），用于同目录判定。 */
export const normProjectRoot = (p: string): string =>
  p.replace(/\//g, "\\").trim().toLowerCase().replace(/\\+$/, "");

export class ProjectsStore {
  private data: ProjectRecord[] = [];
  private readonly file: string;

  constructor(app: App) {
    this.file = join(app.getPath("userData"), "projects.json");
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      if (!Array.isArray(raw)) return;
      for (const item of raw) {
        const p = item as Partial<ProjectRecord>;
        if (typeof p.id !== "string" || p.id.length === 0) continue;
        this.data.push({
          id: p.id,
          name: typeof p.name === "string" && p.name ? p.name : "未命名工作区",
          roots: Array.isArray(p.roots) ? p.roots.filter((r): r is string => typeof r === "string") : [],
          createdAt: typeof p.createdAt === "number" ? p.createdAt : Date.now() / 1000,
          updatedAt: typeof p.updatedAt === "number" ? p.updatedAt : Date.now() / 1000,
        });
      }
    } catch {
      try {
        renameSync(this.file, `${this.file}.corrupt`);
      } catch {
        /* 忽略备份失败 */
      }
      this.data = [];
    }
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    mkdirSync(join(this.file, ".."), { recursive: true });
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
    renameSync(tmp, this.file);
  }

  list(_params: { limit?: number; cursor?: string | null } = {}): {
    data: ProjectRecord[];
    nextCursor: null;
  } {
    // 本地登记表一次性返回；分页参数仅做兼容吸收。
    return { data: [...this.data], nextCursor: null };
  }

  read(params: { projectId: string }): ProjectRecord | null {
    return this.data.find((p) => p.id === params.projectId) ?? null;
  }

  /** 查找目录集合完全一致的已有工作区（向导/侧栏共用去重规则）。 */
  findWithRoots(rootPaths: string[]): ProjectRecord | null {
    const want = new Set(rootPaths.filter(Boolean).map(normProjectRoot));
    if (want.size === 0) return null;
    for (const p of this.data) {
      const got = new Set(p.roots.map(normProjectRoot));
      if (got.size === want.size && [...want].every((x) => got.has(x))) return p;
    }
    return null;
  }

  create(params: { name?: string; roots?: Array<{ path: string } | string> }): ProjectRecord {
    const roots = (params.roots ?? [])
      .map((r) => (typeof r === "string" ? r : r?.path))
      .filter((r): r is string => typeof r === "string" && r.length > 0);
    const now = Date.now() / 1000;
    const record: ProjectRecord = {
      id: randomUUID(),
      name: params.name?.trim() || "未命名工作区",
      roots,
      createdAt: now,
      updatedAt: now,
    };
    this.data.push(record);
    this.save();
    return record;
  }

  update(params: { projectId: string; name?: string; roots?: Array<{ path: string } | string> }):
    | ProjectRecord
    | null {
    const record = this.data.find((p) => p.id === params.projectId);
    if (!record) return null;
    if (typeof params.name === "string" && params.name.trim()) record.name = params.name.trim();
    if (Array.isArray(params.roots)) {
      record.roots = params.roots
        .map((r) => (typeof r === "string" ? r : r?.path))
        .filter((r): r is string => typeof r === "string" && r.length > 0);
    }
    record.updatedAt = Date.now() / 1000;
    this.save();
    return record;
  }

  remove(params: { projectId: string }): boolean {
    const before = this.data.length;
    this.data = this.data.filter((p) => p.id !== params.projectId);
    const removed = this.data.length < before;
    if (removed) this.save();
    return removed;
  }
}
