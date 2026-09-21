/**
 * 设置页：左侧分区导航 + 右侧内容。
 * 分区组件各自拉取数据；引擎状态实时来自 backend store。
 */
import { useEffect, useState } from "react";
import { ArrowLeft, BarChart3, Cpu, Info, Settings2, SquareTerminal } from "lucide-react";
import { t } from "../../i18n/zh.ts";
import { useBackendStore } from "../../store/backend.ts";
import { useRouterStore } from "../../store/router.ts";
import { Badge } from "../../components/ui/badge.tsx";
import { cn } from "../../lib/cn.ts";
import { EngineSection } from "./sections/engine-section.tsx";
import { UsageSection } from "./sections/usage-section.tsx";
import { UpdateCard } from "./sections/update-card.tsx";
import { GeneralSection } from "./sections/general-section.tsx";
import { DiagnosticsSection } from "./sections/diagnostics-section.tsx";

type SectionKey = "engine" | "usage" | "general" | "diagnostics" | "about";

const SECTIONS: Array<{ key: SectionKey; icon: typeof Info; label: string }> = [
  { key: "engine", icon: Cpu, label: t.settings.sections.engine },
  { key: "usage", icon: BarChart3, label: t.settings.sections.usage },
  { key: "general", icon: Settings2, label: t.settings.sections.general },
  { key: "diagnostics", icon: SquareTerminal, label: t.settings.sections.diagnostics },
  { key: "about", icon: Info, label: t.settings.sections.about },
];

function AboutPane() {
  const v = window.cc.versions;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft">
          <Settings2 className="h-5 w-5 text-accent" strokeWidth={1.7} />
        </div>
        <div>
          <p className="text-sm font-semibold">{t.app.name}</p>
          <p className="text-xs text-text-faint">{t.app.tagline}</p>
        </div>
      </div>
      <div className="mt-2">
        <UpdateCard />
      </div>
      <dl className="mt-4 grid grid-cols-[110px_1fr] gap-y-2 text-xs">
        <dt className="text-text-faint">{t.settings.about.version}</dt>
        <dd className="font-mono text-text-muted">{v.app}</dd>
        <dt className="text-text-faint">{t.settings.about.electron}</dt>
        <dd className="font-mono text-text-muted">{v.electron}</dd>
        <dt className="text-text-faint">{t.settings.about.chrome}</dt>
        <dd className="font-mono text-text-muted">{v.chrome}</dd>
        <dt className="text-text-faint">{t.settings.about.node}</dt>
        <dd className="font-mono text-text-muted">{v.node}</dd>
        <dt className="text-text-faint">{t.settings.about.platform}</dt>
        <dd className="font-mono text-text-muted">{window.cc.platform}</dd>
      </dl>
    </div>
  );
}

function SectionPane({ section }: { section: SectionKey }) {
  switch (section) {
    case "engine":
      return <EngineSection />;
    case "usage":
      return <UsageSection />;
    case "general":
      return <GeneralSection />;
    case "diagnostics":
      return <DiagnosticsSection />;
    case "about":
      return <AboutPane />;
  }
}

export function SettingsPage() {
  const [active, setActive] = useState<SectionKey>("engine");
  const routedSection = useRouterStore((s) => s.settingsSection);
  const openSettings = useRouterStore((s) => s.openSettings);
  const setView = useRouterStore((s) => s.setView);
  const engine = useBackendStore((s) => s.status?.claude);
  const backendState = useBackendStore((s) => s.status?.state ?? "idle");

  // 外部（横幅/托盘）请求定位到指定分区时跟随。
  useEffect(() => {
    setActive(routedSection);
  }, [routedSection]);

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-56 shrink-0 flex-col gap-0.5 border-r border-border bg-surface p-2">
        <p className="px-2 pb-1 pt-1 text-[15px] font-semibold tracking-tight text-text">
          {t.settings.title}
        </p>
        <button
          onClick={() => setView("chat")}
          title={t.nav.chat}
          className="mb-1 flex h-8 items-center gap-2 rounded-lg px-2 text-[13px] text-text-muted transition-colors hover:bg-hover hover:text-text"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={1.8} />
          {t.nav.chat}
        </button>
        {SECTIONS.map(({ key, icon: Icon, label }) => (
          <button
            key={key}
            onClick={() => openSettings(key)}
            className={cn(
              "flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] transition-colors",
              active === key
                ? "bg-accent-soft font-medium text-accent"
                : "text-text-muted hover:bg-hover hover:text-text",
            )}
          >
            <Icon className="h-4 w-4" strokeWidth={1.7} />
            {label}
          </button>
        ))}
        {engine && (
          <div className="mt-auto rounded-lg border border-border bg-surface-2 p-2.5">
            <p className="text-[10px] text-text-faint">{t.settings.engine.title}</p>
            <p className="truncate font-mono text-[11px] text-text-muted">{engine.version}</p>
            <Badge tone={backendState === "ready" ? "success" : backendState === "fatal" ? "danger" : "warning"} className="mt-1.5">
              {t.status[backendState]}
            </Badge>
          </div>
        )}
      </aside>
      <section className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-[680px]">
          <h1 className="mb-4 text-[15px] font-semibold tracking-tight">
            {SECTIONS.find((s) => s.key === active)?.label}
          </h1>
          <SectionPane section={active} />
        </div>
      </section>
    </div>
  );
}
