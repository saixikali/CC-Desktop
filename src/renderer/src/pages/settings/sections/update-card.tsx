/**
 * 关于页更新卡片：更新源配置 + 检查/下载/安装。
 * 状态实时来自 EVENTS.updateState 广播；未配置更新源时显示停用提示。
 */
import { useEffect, useState } from "react";
import { Download, RefreshCw, RotateCw } from "lucide-react";
import { t } from "../../../i18n/zh.ts";
import { bridge, call, onEvent } from "../../../lib/ipc.ts";
import { EVENTS, type UpdateState } from "@shared/ipc/contract.ts";
import { Button } from "../../../components/ui/button.tsx";
import { Input } from "../../../components/ui/input.tsx";
import { Card, Field } from "./shared.tsx";

export function UpdateCard() {
  const [state, setState] = useState<UpdateState | null>(null);
  const [feed, setFeed] = useState<string>("");
  const [feedDirty, setFeedDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void call<UpdateState>(() => bridge().settings.updateGet({})).then(setState).catch(() => undefined);
    void call<{ updateFeedUrl: string | null }>(() => bridge().settings.prefsGet({}))
      .then((p) => setFeed(p.updateFeedUrl ?? ""))
      .catch(() => undefined);
    return onEvent(EVENTS.updateState, (payload) => setState(payload as UpdateState));
  }, []);

  const saveFeed = async (url: string | null) => {
    setSaving(true);
    try {
      await call(() => bridge().settings.prefsSet({ updateFeedUrl: url }));
    } finally {
      setSaving(false);
      setFeedDirty(false);
    }
  };

  const status = state?.status ?? "idle";
  const busy = status === "checking" || status === "downloading";

  let statusLine: string = t.settings.about.update.disabledHint;
  if (state) {
    switch (state.status) {
      case "idle":
        statusLine = feed ? t.settings.about.update.idleHint : t.settings.about.update.disabledHint;
        break;
      case "checking":
        statusLine = t.settings.about.update.checking;
        break;
      case "none":
        statusLine = t.settings.about.update.upToDate;
        break;
      case "available":
        statusLine = `${t.settings.about.update.available}：v${state.version ?? "?"}`;
        break;
      case "downloading":
        statusLine = `${t.settings.about.update.downloading} ${state.progress ?? 0}%`;
        break;
      case "downloaded":
        statusLine = `${t.settings.about.update.downloaded}：v${state.version ?? "?"}`;
        break;
      case "error":
        statusLine = `${t.settings.about.update.failed}：${state.error ?? ""}`;
        break;
    }
  }

  return (
    <Card>
      <Field label={t.settings.about.update.title} hint={t.settings.about.update.hint}>
        {status === "downloaded" ? (
          <Button
            size="sm"
            variant="primary"
            icon={<RotateCw className="h-3.5 w-3.5" />}
            onClick={() => void call(() => bridge().settings.updateInstall({})).catch(() => undefined)}
          >
            {t.settings.about.update.install}
          </Button>
        ) : status === "available" ? (
          <Button
            size="sm"
            variant="secondary"
            loading={busy}
            icon={<Download className="h-3.5 w-3.5" />}
            onClick={() => void call(() => bridge().settings.updateDownload({})).catch(() => undefined)}
          >
            {t.settings.about.update.download}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            loading={status === "checking"}
            icon={<RefreshCw className="h-3.5 w-3.5" />}
            onClick={() => void call(() => bridge().settings.updateCheck({})).catch(() => undefined)}
          >
            {t.settings.about.update.check}
          </Button>
        )}
      </Field>
      <div className="border-t border-border" />
      <Field label={t.settings.about.update.status}>
        <span className="max-w-[360px] select-text break-all text-right text-xs text-text-muted">
          {statusLine}
          {state?.lastCheckedAt ? (
            <span className="ml-1 text-[10px] text-text-faint">
              ({new Date(state.lastCheckedAt).toLocaleTimeString()})
            </span>
          ) : null}
        </span>
      </Field>
      <div className="border-t border-border" />
      <Field label={t.settings.about.update.feed} hint={t.settings.about.update.feedHint}>
        <div className="flex items-center gap-1.5">
          <Input
            value={feed}
            onChange={(e) => {
              setFeed(e.target.value);
              setFeedDirty(true);
            }}
            placeholder="https://…/updates/"
            className="h-8 w-72 font-mono text-[11px]"
          />
          <Button
            size="sm"
            variant={feedDirty ? "primary" : "ghost"}
            loading={saving}
            disabled={!feedDirty}
            onClick={() => void saveFeed(feed.trim() || null)}
          >
            {t.common.save}
          </Button>
        </div>
      </Field>
    </Card>
  );
}
