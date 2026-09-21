/**
 * 设置-通用：本机偏好（通知开关、关闭行为），即时保存。
 */
import { useEffect } from "react";
import { t } from "../../../i18n/zh.ts";
import { useSettingsStore } from "../../../store/settings.ts";
import { useToastStore } from "../../../store/toast.ts";
import { Card, Field, ThemeCubes, Toggle } from "./shared.tsx";
import type { LocalPrefs } from "@shared/ipc/contract.ts";

export function GeneralSection() {
  const prefs = useSettingsStore((s) => s.prefs);
  const loadPrefs = useSettingsStore((s) => s.loadPrefs);
  const setPrefs = useSettingsStore((s) => s.setPrefs);

  useEffect(() => {
    void loadPrefs().catch(() => undefined);
  }, [loadPrefs]);

  const change = (p: Partial<LocalPrefs>) => {
    void setPrefs(p).catch((err) =>
      useToastStore.getState().error(t.settings.general.saveFailed, (err as Error).message),
    );
  };

  if (!prefs) return null;

  return (
    <Card>
      <Field label={t.settings.general.theme} hint={t.settings.general.themeHint} className="flex-col items-stretch">
        <ThemeCubes value={prefs.theme} onChange={(v) => change({ theme: v })} />
      </Field>
      <Field label={t.settings.general.notifyTurnCompleted} hint={t.settings.general.notifyTurnCompletedHint}>
        <Toggle checked={prefs.notifyTurnCompleted} onChange={(v) => change({ notifyTurnCompleted: v })} />
      </Field>
      <Field label={t.settings.general.notifyApprovals} hint={t.settings.general.notifyApprovalsHint}>
        <Toggle checked={prefs.notifyApprovals} onChange={(v) => change({ notifyApprovals: v })} />
      </Field>
      <Field label={t.settings.general.closeToTray} hint={t.settings.general.closeToTrayHint}>
        <Toggle checked={prefs.closeToTray} onChange={(v) => change({ closeToTray: v })} />
      </Field>
    </Card>
  );
}
