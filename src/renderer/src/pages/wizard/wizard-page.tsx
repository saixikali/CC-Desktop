import { useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  FolderOpen,
  Sparkles,
  TerminalSquare,
} from "lucide-react";
import { t } from "../../i18n/zh.ts";
import { useBackendStore } from "../../store/backend.ts";
import { useRouterStore } from "../../store/router.ts";
import { useToastStore } from "../../store/toast.ts";
import { bridge, call } from "../../lib/ipc.ts";
import { Badge } from "../../components/ui/badge.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";

interface WizardCompleteResult {
  project: { id?: string; name?: string } | null;
  degraded: boolean;
}

/** 左侧步骤指示器。 */
function StepNav({ current }: { current: number }) {
  return (
    <ol className="flex flex-col gap-3">
      {t.wizard.steps.map((step, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={step} className="flex items-center gap-2.5 text-xs">
            <span
              className={`flex h-5 w-5 items-center justify-center rounded-full border text-[10px] ${
                active || done
                  ? "border-accent/50 bg-accent-soft text-accent"
                  : "border-border bg-surface-2 text-text-faint"
              }`}
            >
              {done ? <Check className="h-3 w-3" /> : i + 1}
            </span>
            <span className={active || done ? "text-text" : "text-text-faint"}>{step}</span>
            {i < t.wizard.steps.length - 1 && (
              <ChevronRight className="ml-auto h-3 w-3 text-text-faint" />
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function WizardPage() {
  const status = useBackendStore((s) => s.status);
  const restart = useBackendStore((s) => s.restart);
  const restarting = useBackendStore((s) => s.restarting);
  const refreshWizard = useBackendStore((s) => s.refreshWizard);
  const toastError = useToastStore((s) => s.error);
  const state = status?.state ?? "idle";
  const ready = state === "ready";

  const [step, setStep] = useState(0);
  const [dir, setDir] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [completing, setCompleting] = useState(false);
  const [result, setResult] = useState<WizardCompleteResult | null>(null);
  const [finishError, setFinishError] = useState<string | null>(null);

  const pickDir = async () => {
    try {
      const picked = await call<string | null>(() =>
        bridge().app.pickDirectory(dir ? { defaultPath: dir } : undefined),
      );
      if (picked) {
        setDir(picked);
        if (!title.trim()) setTitle(picked.split(/[\\/]/).filter(Boolean).pop() ?? "");
      }
    } catch (err) {
      toastError(t.wizard.dirPickFailed, err instanceof Error ? err.message : String(err));
    }
  };

  const finish = async () => {
    if (!dir || completing) return;
    setCompleting(true);
    setFinishError(null);
    try {
      const r = await call<WizardCompleteResult>(() =>
        bridge().backend.wizardComplete({
          projectPath: dir,
          title: title.trim() || undefined,
        }),
      );
      setResult(r);
      await refreshWizard();
    } catch (err) {
      setFinishError(err instanceof Error ? err.message : String(err));
    } finally {
      setCompleting(false);
    }
  };

  // 进入主界面：无论首次锁定流程还是从侧栏再次进入向导，都显式切回聊天视图，
  // 并刷新向导完成标记（首次流程依赖它解除锁定）。
  const enterApp = () => {
    useRouterStore.getState().setView("chat");
    void refreshWizard();
  };

  const canNext = step === 0 || (step === 1 && dir !== null);

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <div className="flex w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl shadow-shadow">
        <header className="flex items-center gap-3 border-b border-border bg-surface-2 px-6 py-5">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft">
            <TerminalSquare className="h-5 w-5 text-accent" strokeWidth={1.7} />
          </div>
          <div>
            <h1 className="text-[15px] font-semibold">{t.wizard.title}</h1>
            <p className="text-xs text-text-faint">{t.app.tagline}</p>
          </div>
        </header>

        <div className="grid gap-6 px-6 py-6 sm:grid-cols-[200px_1fr]">
          <StepNav current={step} />

          <div className="flex min-h-[260px] flex-col gap-4">
            {/* ---------- Step 0: 引擎检测 ---------- */}
            {step === 0 && (
              <>
                <div>
                  <h2 className="flex items-center gap-2 text-sm font-semibold">
                    <Sparkles className="h-4 w-4 text-accent" strokeWidth={1.7} />
                    {t.wizard.welcome}
                  </h2>
                  <p className="mt-1.5 text-xs leading-relaxed text-text-muted">
                    {t.wizard.welcomeHint}
                  </p>
                </div>
                <div className="rounded-xl border border-border bg-surface-2 p-4">
                  <div className="flex items-center gap-2 text-[13px] font-medium">
                    <Sparkles className="h-4 w-4 text-accent" strokeWidth={1.7} />
                    {t.wizard.claudeEngine}
                    <Badge tone={status?.claude ? "success" : "danger"} className="ml-auto">
                      {status?.claude ? t.wizard.engineReady : t.wizard.engineMissing}
                    </Badge>
                  </div>
                  {status?.claude && (
                    <dl className="mt-3 grid grid-cols-[64px_1fr] gap-y-1.5 text-[11px]">
                      <dt className="text-text-faint">{t.wizard.engineVersion}</dt>
                      <dd className="select-text font-mono text-text-muted">{status.claude.version}</dd>
                      <dt className="text-text-faint">{t.wizard.enginePath}</dt>
                      <dd className="select-text break-all font-mono text-text-muted">
                        {status.claude.path}
                      </dd>
                    </dl>
                  )}
                  {status?.fatalMessage && (
                    <p className="mt-3 select-text text-[11px] leading-relaxed text-danger">
                      {status.fatalMessage}
                    </p>
                  )}
                  <p
                    className={`mt-3 text-[11px] ${status?.claude ? "text-success" : "text-danger"}`}
                  >
                    {status?.claude ? t.wizard.claudeReadyHint : t.wizard.claudeMissingHint}
                  </p>
                  {!ready && (
                    <div className="mt-3 flex items-center gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={restarting}
                        onClick={() => void restart("向导中重新检测")}
                      >
                        {t.wizard.reDetect}
                      </Button>
                    </div>
                  )}
                </div>
              </>
            )}

            {/* ---------- Step 1: 工作目录 ---------- */}
            {step === 1 && (
              <>
                <div>
                  <h2 className="flex items-center gap-2 text-sm font-semibold">
                    <FolderOpen className="h-4 w-4 text-accent" strokeWidth={1.7} />
                    {t.wizard.dirTitle}
                  </h2>
                  <p className="mt-1.5 text-xs leading-relaxed text-text-muted">
                    {t.wizard.dirHint}
                  </p>
                </div>
                <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface-2 p-4">
                  <div className="flex items-center gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<FolderOpen className="h-3.5 w-3.5" />}
                      onClick={() => void pickDir()}
                    >
                      {t.wizard.pickDir}
                    </Button>
                    {dir && (
                      <span className="select-text truncate font-mono text-[11px] text-text-muted">
                        {dir}
                      </span>
                    )}
                  </div>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-[11px] text-text-faint">{t.wizard.projectName}</span>
                    <Input
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder={t.wizard.projectNamePlaceholder}
                      maxLength={200}
                    />
                  </label>
                </div>
              </>
            )}

            {/* ---------- Step 2: 完成 ---------- */}
            {step === 2 && (
              <>
                <div>
                  <h2 className="flex items-center gap-2 text-sm font-semibold">
                    <Sparkles className="h-4 w-4 text-accent" strokeWidth={1.7} />
                    {t.wizard.finishTitle}
                  </h2>
                  <p className="mt-1.5 text-xs leading-relaxed text-text-muted">
                    {t.wizard.finishHint}
                  </p>
                </div>
                <div className="rounded-xl border border-border bg-surface-2 p-4">
                  <dl className="grid grid-cols-[80px_1fr] gap-y-1.5 text-[11px]">
                    <dt className="text-text-faint">{t.wizard.summaryDir}</dt>
                    <dd className="select-text break-all font-mono text-text-muted">{dir ?? "—"}</dd>
                    <dt className="text-text-faint">{t.wizard.summaryWorkspace}</dt>
                    <dd className="select-text font-mono text-text-muted">
                      {title.trim() || (dir ? dir.split(/[\\/]/).filter(Boolean).pop() : "") || "—"}
                    </dd>
                  </dl>
                  {result && (
                    <div className="mt-3 flex flex-col gap-1.5">
                      <p className="flex items-center gap-1.5 text-[11px] text-success">
                        <CircleCheck className="h-3.5 w-3.5" />
                        {result.project?.name ?? t.wizard.doneProject}
                      </p>
                    </div>
                  )}
                  {finishError && (
                    <p className="mt-3 select-text text-[11px] leading-relaxed text-danger">
                      {t.wizard.completeFailed}：{finishError}
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border bg-surface-2 px-6 py-4">
          {step > 0 && step < 2 && (
            <Button variant="ghost" size="sm" onClick={() => setStep((s) => s - 1)}>
              <ChevronLeft className="h-3.5 w-3.5" />
              {t.wizard.back}
            </Button>
          )}
          {step === 0 && (
            <Button
              variant="secondary"
              size="sm"
              loading={restarting}
              onClick={() => void restart("向导中重新检测")}
            >
              {t.wizard.reDetect}
            </Button>
          )}
          {step === 2 && !result && (
            <Button
              size="sm"
              variant="primary"
              loading={completing}
              disabled={!dir}
              onClick={() => void finish()}
            >
              {completing ? t.wizard.creating : t.wizard.createAndFinish}
            </Button>
          )}
          {step < 2 && (
            <Button
              size="sm"
              variant={step === 1 ? "primary" : "secondary"}
              disabled={!canNext}
              onClick={() => setStep((s) => Math.min(s + 1, t.wizard.steps.length - 1))}
            >
              {t.wizard.next}
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          )}
          {step === 2 && result && (
            <Button size="sm" variant="primary" onClick={enterApp}>
              {t.wizard.enter}
            </Button>
          )}
        </footer>
      </div>
    </div>
  );
}
