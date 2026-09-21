/**
 * 单个终端标签的 xterm 实例（Task 14）：
 *  - 挂载时接管 store 输出并回放暂存区；卸载时归还给暂存区
 *  - onData → writeStdin；onResize / 容器尺寸变化 → fit + resizePty
 */
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { bridge } from "../../lib/ipc.ts";
import { useTerminalStore, type TerminalSession } from "../../store/terminal.ts";

const TERMINAL_THEME = {
  background: "#0d1117",
  foreground: "#c9d1d9",
  cursor: "#c9d1d9",
  cursorAccent: "#0d1117",
  selectionBackground: "#264f78",
  black: "#484f58",
  red: "#ff7b72",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#b1bac4",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#f0f6fc",
} as const;

export function TerminalView({ session }: { session: TerminalSession }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const fontSize = useTerminalStore((s) => s.fontSize);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;

    const term = new Terminal({
      fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
      fontSize: useTerminalStore.getState().fontSize,
      cursorBlink: true,
      scrollback: 5000,
      theme: TERMINAL_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    termRef.current = term;
    fitRef.current = fit;
    try {
      fit.fit();
    } catch {
      /* 容器尺寸为 0 时忽略，ResizeObserver 会再次触发 */
    }

    // 先接管输出（同步切换 live 标记并取走暂存区），再回放，保证无缝衔接。
    const pending = useTerminalStore.getState().attachLive(session.id, (data) => term.write(data));
    if (pending) term.write(pending);

    const dataSub = term.onData((data) => {
      void bridge()
        .process.writeStdin({ id: session.id, data })
        .catch(() => {
          /* 进程刚退出时的写入失败静默 */
        });
    });
    const resizeSub = term.onResize(({ cols, rows }) => {
      void bridge()
        .process.resizePty({ id: session.id, cols, rows })
        .catch(() => {
          /* 与退出竞态时忽略 */
        });
    });

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* 容器隐藏时高度为 0，忽略 */
      }
    });
    ro.observe(el);

    return () => {
      dataSub.dispose();
      resizeSub.dispose();
      ro.disconnect();
      useTerminalStore.getState().detachLive(session.id);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅按会话 id 重建实例
  }, [session.id]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    try {
      fitRef.current?.fit();
    } catch {
      /* 忽略 */
    }
  }, [fontSize]);

  return (
    <div className="relative h-full w-full">
      <div ref={rootRef} className="h-full w-full overflow-hidden rounded-lg" />
      {session.exited && (
        <div className="pointer-events-none absolute inset-0 flex items-start justify-end p-3">
          <span className="rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] text-text-muted shadow">
            进程已退出{session.exitCode != null ? `（退出码 ${session.exitCode}）` : ""}
          </span>
        </div>
      )}
    </div>
  );
}
