/** 渲染层使用的领域模型（对后端原始 JSON 做防御式归一）。 */

export interface ThreadSummary {
  id: string;
  name: string | null;
  preview: string;
  cwd: string | null;
  status: string | null;
  archived: boolean;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface ProjectSummary {
  id: string;
  name: string;
  roots: string[];
  createdAt: number | null;
  updatedAt: number | null;
}

export interface Paginated<T> {
  data: T[];
  nextCursor: string | null;
}

export interface TurnSummary {
  id: string;
  status: string | null;
  startedAt: number | null;
  endedAt: number | null;
  raw: unknown;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 时间戳为秒；容错毫秒输入。 */
export function toSeconds(v: unknown): number | null {
  const n = num(v);
  if (n === null) return null;
  return n > 1e12 ? Math.floor(n / 1000) : n;
}

export function normalizeThread(raw: unknown): ThreadSummary {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    id: String(r.id ?? ""),
    name: str(r.name),
    preview: typeof r.preview === "string" ? r.preview : "",
    cwd: str(r.cwd),
    status: str(r.status),
    archived: r.archived === true,
    createdAt: toSeconds(r.createdAt),
    updatedAt: toSeconds(r.updatedAt ?? r.recencyAt),
  };
}

export function normalizeProject(raw: unknown): ProjectSummary {
  const r = (raw ?? {}) as Record<string, unknown>;
  const roots = Array.isArray(r.roots)
    ? r.roots
        .map((x) => {
          if (typeof x === "string") return x;
          const root = (x ?? {}) as Record<string, unknown>;
          return str(root.path) ?? str(root.uri) ?? "";
        })
        .filter(Boolean)
    : [];
  return {
    id: String(r.id ?? ""),
    name: typeof r.name === "string" ? r.name : "未命名工作区",
    roots,
    createdAt: toSeconds(r.createdAt),
    updatedAt: toSeconds(r.updatedAt),
  };
}

export function normalizeTurn(raw: unknown): TurnSummary {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    id: String(r.id ?? ""),
    status: str(r.status),
    startedAt: toSeconds(r.startedAt),
    endedAt: toSeconds(r.endedAt),
    raw,
  };
}
