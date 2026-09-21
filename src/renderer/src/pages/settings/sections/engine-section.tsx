/**
 * 设置-引擎：内置 Claude Code 引擎状态（探活路径/版本）、本机接入方式、重新检测。
 */
import { useEffect, useState } from "react";
import { Cpu, RotateCw } from "lucide-react";
import { t } from "../../../i18n/zh.ts";
import { bridge, call } from "../../../lib/ipc.ts";
import { useBackendStore } from "../../../store/backend.ts";
import { Badge } from "../../../components/ui/badge.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Card, Field } from "./shared.tsx";

const STATE_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  ready: "success",
  resolving: "warning",
  idle: "neutral",
  fatal: "danger",
};

interface AccountInfo {
  authMode?: "oauth" | "api" | "none";
  email?: string | null;
  apiHost?: string | null;
}

export function EngineSection() {
  const status = useBackendStore((s) => s.status);
  const restarting = useBackendStore((s) => s.restarting);
  const restart = useBackendStore((s) => s.restart);
  const state = status?.state ?? "idle";
  const engine = status?.claude ?? null;
  const [auth, setAuth] = useState<AccountInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    call<{ account?: AccountInfo | null }>(() => bridge().settings.account({}))
      .then((r) => {
        if (!cancelled) setAuth(r?.account ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const authLabel =
    auth?.authMode === "oauth"
      ? `${t.settings.engine.authOauth}${auth.email ? `（${auth.email}）` : ""}`
      : auth?.authMode === "api"
        ? `${t.settings.engine.authApi}${auth.apiHost ? `（${auth.apiHost}）` : ""}`
        : t.settings.engine.authNone;

  return (
    <Card>
      <Field label={t.settings.engine.title} hint={t.settings.engine.hint}>
        <Badge tone={STATE_TONE[state] ?? "neutral"}>{t.status[state] ?? state}</Badge>
      </Field>
      <div className="border-t border-border" />
      <Field
        label={t.settings.engine.version}
        hint={engine ? undefined : t.settings.engine.missing}
      >
        <span className="font-mono text-xs text-text-muted">{engine?.version ?? "—"}</span>
      </Field>
      <div className="border-t border-border" />
      <Field label={t.settings.engine.path}>
        <span className="block max-w-[340px] truncate font-mono text-xs text-text-muted" title={engine?.path ?? ""}>
          {engine?.path ?? "—"}
        </span>
      </Field>
      <div className="border-t border-border" />
      <Field label={t.settings.engine.account} hint={t.settings.engine.accountHint}>
        <span className="flex items-center gap-1.5 text-xs text-text-muted">
          <Cpu className="h-3.5 w-3.5 shrink-0 text-text-faint" />
          {authLabel}
        </span>
      </Field>
      <div className="border-t border-border" />
      <Field label={t.settings.engine.reDetect} hint={t.settings.engine.reDetectHint}>
        <Button
          size="sm"
          variant="secondary"
          loading={restarting}
          icon={<RotateCw className="h-3.5 w-3.5" />}
          onClick={() => void restart("设置页重新检测")}
        >
          {t.settings.engine.reDetect}
        </Button>
      </Field>
    </Card>
  );
}
