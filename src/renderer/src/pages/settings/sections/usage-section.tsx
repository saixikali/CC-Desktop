/**
 * 设置-用量统计：回合数、tokens（输入/缓存/输出）、费用（SDK 上报）、
 * 近 14 天分布与按模型明细。数据来自本机用量台账（usage.jsonl）。
 */
import { useEffect, useState } from "react";
import { t } from "../../../i18n/zh.ts";
import { bridge, call } from "../../../lib/ipc.ts";
import { Card, Field } from "./shared.tsx";
import { Skeleton } from "../../../components/ui/skeleton.tsx";

interface UsageDay {
  day: string;
  turns: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  costUsd: number;
}
interface UsageModelRow {
  model: string;
  turns: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  costUsd: number;
}
interface UsageStats {
  totals: {
    turns: number;
    inputTokens: number;
    cachedTokens: number;
    outputTokens: number;
    costUsd: number;
    hasCost: boolean;
    firstTs: number | null;
  };
  byDay: UsageDay[];
  byModel: UsageModelRow[];
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtCost(n: number): string {
  if (n <= 0) return "—";
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface-2 p-3">
      <p className="text-[11px] text-text-faint">{label}</p>
      <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-text">{value}</p>
      {sub && <p className="mt-0.5 truncate text-[10px] text-text-faint">{sub}</p>}
    </div>
  );
}

export function UsageSection() {
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    call<UsageStats>(() => bridge().stats.usage({}))
      .then((r) => {
        if (!cancelled) setStats(r);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <Card>
        <p className="text-xs text-text-faint">
          {t.settings.usage.loadFailed}：{error}
        </p>
      </Card>
    );
  }
  if (!stats) return <Skeleton className="h-48 w-full" />;

  const { totals, byDay, byModel } = stats;
  const last14 = byDay.slice(-14);
  const maxDay = Math.max(1, ...last14.map((d) => d.inputTokens + d.cachedTokens + d.outputTokens));
  const daysSpanned =
    totals.firstTs !== null
      ? Math.max(1, Math.ceil((Date.now() - totals.firstTs) / 86_400_000))
      : 0;

  return (
    <div className="flex flex-col gap-3">
      {totals.turns === 0 ? (
        <Card>
          <p className="text-xs text-text-faint">{t.settings.usage.empty}</p>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <StatTile label={t.settings.usage.turns} value={String(totals.turns)} />
            <StatTile
              label={t.settings.usage.totalTokens}
              value={fmtTokens(totals.inputTokens + totals.cachedTokens + totals.outputTokens)}
              sub={`${t.settings.usage.input} ${fmtTokens(totals.inputTokens)} · ${t.settings.usage.cached} ${fmtTokens(totals.cachedTokens)} · ${t.settings.usage.output} ${fmtTokens(totals.outputTokens)}`}
            />
            <StatTile
              label={t.settings.usage.cost}
              value={totals.hasCost ? fmtCost(totals.costUsd) : "—"}
              sub={totals.hasCost ? undefined : t.settings.usage.costUnknown}
            />
            <StatTile label={t.settings.usage.days} value={String(daysSpanned)} />
          </div>

          {last14.length > 0 && (
            <Card>
              <Field label={t.settings.usage.daily} />
              <div className="flex h-28 items-end gap-1.5 px-1">
                {last14.map((d) => {
                  const total = d.inputTokens + d.cachedTokens + d.outputTokens;
                  const h = Math.max(4, Math.round((total / maxDay) * 100));
                  return (
                    <div
                      key={d.day}
                      className="group relative flex-1"
                      title={`${d.day} · ${t.settings.usage.turns} ${d.turns} · ${fmtTokens(total)} tokens${d.costUsd > 0 ? ` · ${fmtCost(d.costUsd)}` : ""}`}
                    >
                      <div
                        className="w-full rounded-t-md bg-accent/70 transition-colors group-hover:bg-accent"
                        style={{ height: `${h}px` }}
                      />
                    </div>
                  );
                })}
              </div>
              <div className="mt-1 flex justify-between px-1 text-[10px] tabular-nums text-text-faint">
                <span>{last14[0]?.day.slice(5)}</span>
                <span>{last14[last14.length - 1]?.day.slice(5)}</span>
              </div>
            </Card>
          )}

          <Card>
            <Field label={t.settings.usage.byModel} />
            <div className="flex flex-col gap-1.5">
              {byModel.map((m) => (
                <div
                  key={m.model}
                  className="flex items-center gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text">
                    {m.model}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-text-muted">
                    {t.settings.usage.turns} {m.turns}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-text-muted">
                    {fmtTokens(m.inputTokens + m.cachedTokens + m.outputTokens)}
                  </span>
                  <span className="w-20 shrink-0 text-right font-mono text-[11px] tabular-nums text-text-muted">
                    {m.costUsd > 0 ? fmtCost(m.costUsd) : "—"}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </>
      )}
      <p className="px-1 text-[10px] leading-relaxed text-text-faint">{t.settings.usage.note}</p>
    </div>
  );
}
