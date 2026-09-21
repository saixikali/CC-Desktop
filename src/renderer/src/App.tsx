import { useEffect } from "react";
import { TitleBar } from "./components/titlebar.tsx";
import { BackendBanner } from "./components/backend-banner.tsx";
import { ToastViewport } from "./components/toast-viewport.tsx";
import { ChatPage } from "./pages/chat/chat-page.tsx";
import { ChatApp } from "./pages/chat/chat-app.tsx";
import { WizardPage } from "./pages/wizard/wizard-page.tsx";
import { SettingsPage } from "./pages/settings/settings-page.tsx";
import { bindAppEvents } from "./store/app-events.ts";
import { useBackendStore } from "./store/backend.ts";
import { useRouterStore } from "./store/router.ts";
import { useSettingsStore } from "./store/settings.ts";
import { applyTheme } from "./lib/theme.ts";

export function App() {
  const start = useBackendStore((s) => s.start);
  const wizard = useBackendStore((s) => s.wizard);
  const view = useRouterStore((s) => s.view);
  const mode = useRouterStore((s) => s.mode);
  const theme = useSettingsStore((s) => s.prefs?.theme);

  useEffect(() => {
    start();
    void useSettingsStore.getState().loadPrefs().catch(() => undefined);
    return bindAppEvents();
  }, [start]);

  // 以主进程持久化的 prefs 为权威主题来源（设置页切换即时生效）。
  useEffect(() => {
    if (theme) applyTheme(theme);
  }, [theme]);

  // 向导未完成时锁定主界面（设置/聊天不可进入）。
  const locked = wizard !== null && !wizard.completed;
  const effective = locked ? "wizard" : view;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg text-text">
      <TitleBar />
      <BackendBanner />
      {effective === "wizard" && <WizardPage />}
      {effective === "settings" && <SettingsPage />}
      {effective === "chat" && mode === "chat" && <ChatApp />}
      {effective === "chat" && mode === "task" && <ChatPage />}
      <ToastViewport />
    </div>
  );
}
