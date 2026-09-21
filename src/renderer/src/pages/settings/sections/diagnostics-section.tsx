/**
 * 设置-诊断：引擎状态概览、日志目录、诊断日志 zip 导出。
 */
import { useEffect } from "react";
import { Download, FolderOpen } from "lucide-react";
import { t } from "../../../i18n/zh.ts";
import { bridge, call } from "../../../lib/ipc.ts";
import { useBackendStore } from "../../../store/backend.ts";
import { useSettingsStore } from "../../../store/settings.ts";
import { useToastStore } from "../../../store/toast.ts";
import { Badge } from "../../../components/ui/badge.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Card, Field } from "./shared.tsx";

const STATE_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  ready: "success",
  resolving: "warning",
  idle: "neutral",
  fatal: "danger",
};

export function DiagnosticsSection() {
  const status = useBackendStore((s) => s.status);
  const exporting = useSettingsStore((s) => s.exportingLogs);
  const exportLogs = useSettingsStore((s) => s.exportLogs);
  const state = status?.state ?? "idle";
  const engine = status?.claude ?? null;

  // 应用信息（关于页之外的运行时摘要）。
  const v = window.cc.versions;

  useEffect(() => {
    void useSettingsStore.getState().loadPrefs().catch(() => undefined);
  }, []);

  const doExport = async () => {
    try {
      const path = await exportLogs();
      if (path) useToastStore.getState().success(t.settings.diagnostics.exportDone.replace("{path}", path));
    } catch (err) {
      useToastStore.getState().error(t.settings.diagnostics.exportFailed, (err as Error).message);
    }
  };

  const openLogs = async () => {
    try {
      await call(() => bridge().app.openLogsDir());
    } catch (err) {
      useToastStore.getState().error(t.banner.openLogsFailed, (err as Error).message);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <Field label={t.settings.engine.title}>
          <Badge tone={STATE_TONE[state] ?? "neutral"}>{t.status[state] ?? state}</Badge>
        </Field>
        <div className="border-t border-border" />
        <Field label={t.settings.engine.version}>
          <span className="font-mono text-xs text-text-muted">{engine?.version ?? "—"}</span>
        </Field>
        {status?.fatalMessage && (
          <p className="select-text rounded-lg border border-danger/30 bg-danger/10 px-2.5 py-2 text-[11px] leading-relaxed text-danger">
            {status.fatalMessage}
          </p>
        )}
      </Card>

      <Card>
        <Field label={t.settings.diagnostics.runtime}>
          <dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-1 text-[11px] text-text-muted">
            <dt className="text-text-faint">App</dt>
            <dd className="font-mono">{v.app}</dd>
            <dt className="text-text-faint">Electron</dt>
            <dd className="font-mono">{v.electron}</dd>
            <dt className="text-text-faint">Platform</dt>
            <dd className="font-mono">{window.cc.platform}</dd>
          </dl>
        </Field>
      </Card>

      <Card>
        <Field label={t.settings.diagnostics.openLogs}>
          <Button size="sm" variant="ghost" icon={<FolderOpen className="h-3.5 w-3.5" />} onClick={() => void openLogs()}>
            {t.settings.diagnostics.openLogs}
          </Button>
        </Field>
        <div className="border-t border-border" />
        <Field label={t.settings.diagnostics.exportLogs} hint={exporting ? t.settings.diagnostics.exporting : undefined}>
          <Button size="sm" variant="secondary" loading={exporting} icon={<Download className="h-3.5 w-3.5" />} onClick={() => void doExport()}>
            {t.settings.diagnostics.exportLogs}
          </Button>
        </Field>
      </Card>
    </div>
  );
}
