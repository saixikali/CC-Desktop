import { useEffect } from "react";
import { Sidebar } from "./sidebar.tsx";
import { ThreadPane } from "./thread-pane.tsx";
import { ApprovalsDock } from "../../components/approvals-dock.tsx";
import { TerminalDrawer } from "../../components/terminal/terminal-drawer.tsx";
import { useApprovalsStore } from "../../store/approvals.ts";
import { useProjectsStore } from "../../store/projects.ts";
import { useTerminalStore } from "../../store/terminal.ts";
import { bindBackendEvents } from "../../store/backend-events.ts";
import { bindTerminalEvents } from "../../store/terminal.ts";

export function ChatPage() {
  const startApprovals = useApprovalsStore((s) => s.start);
  const refreshProjects = useProjectsStore((s) => s.refresh);
  const terminalOpen = useTerminalStore((s) => s.open);

  useEffect(() => {
    startApprovals();
    const offBackend = bindBackendEvents();
    const offTerminal = bindTerminalEvents();
    return () => {
      offBackend();
      offTerminal();
    };
  }, [startApprovals]);

  // 工作区为本地注册表，不依赖引擎状态。
  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  return (
    <div className="flex min-h-0 flex-1">
      <Sidebar />
      <main className="relative flex min-w-0 flex-1 flex-col">
        <ThreadPane />
        <ApprovalsDock />
        {terminalOpen && <TerminalDrawer />}
      </main>
    </div>
  );
}
