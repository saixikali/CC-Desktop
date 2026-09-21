import { FolderOpen, RotateCw, TriangleAlert } from "lucide-react";
import { t } from "../i18n/zh.ts";
import { bridge, call } from "../lib/ipc.ts";
import { useBackendStore } from "../store/backend.ts";
import { useToastStore } from "../store/toast.ts";
import { Button } from "./ui/button.tsx";

/**
 * 引擎状态横幅：仅在引擎不可用（fatal）时展示，
 * 提供"重新检测"（重新探活）与打开日志目录两个动作。
 */
export function BackendBanner() {
  const status = useBackendStore((s) => s.status);
  const restarting = useBackendStore((s) => s.restarting);
  const restart = useBackendStore((s) => s.restart);
  const state = status?.state;

  if (state !== "fatal") return null;

  const openLogs = () => {
    void call(() => bridge().app.openLogsDir()).catch((err) =>
      useToastStore.getState().error(t.banner.openLogsFailed, (err as Error).message),
    );
  };

  return (
    <div className="flex shrink-0 items-center gap-2.5 border-b border-danger/30 bg-danger/10 px-4 py-2 text-xs text-danger">
      <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
      <span className="selectable truncate">
        {`${t.banner.fatal}${status?.fatalMessage ? `：${status.fatalMessage}` : ""}`}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <Button size="sm" variant="ghost" icon={<FolderOpen className="h-3 w-3" />} onClick={openLogs}>
          {t.banner.openLogs}
        </Button>
        <Button
          size="sm"
          variant="dangerSoft"
          loading={restarting}
          icon={!restarting ? <RotateCw className="h-3 w-3" /> : undefined}
          onClick={() => void restart("用户点击横幅按钮")}
        >
          {t.banner.restart}
        </Button>
      </div>
    </div>
  );
}
