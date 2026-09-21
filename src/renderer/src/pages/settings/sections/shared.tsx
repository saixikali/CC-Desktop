/**
 * 设置分区共享的小部件（对齐 DSH 设置行设计语言）：
 *  - Field 行：标题 14px 常规字重 + 灰色说明，控件右对齐，行距 16px
 *  - ThemeCubes：DSH 式主题选择方块（选中态 = 平台底色 + 灰蓝描边）
 */
import type { ReactNode } from "react";
import { Moon, Sun } from "lucide-react";
import { t } from "../../../i18n/zh.ts";
import { cn } from "../../../lib/cn.ts";

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-xl border border-border bg-surface-2 p-1", className)}>
      {children}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-6 border-b border-border px-4 py-4 last:border-b-0",
        className,
      )}
    >
      <div className="min-w-0 pt-0.5">
        <p className="text-sm font-normal text-text">{label}</p>
        {hint && <p className="mt-1 text-xs leading-relaxed text-text-faint">{hint}</p>}
      </div>
      {children && (
        <div
          className={cn(
            className?.includes("flex-col")
              ? "w-full"
              : "flex shrink-0 items-center",
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-5 w-9 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "border-accent/60 bg-accent" : "border-border bg-surface-3",
      )}
    >
      <span
        className={cn(
          "absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-white shadow transition-all",
          checked ? "left-[18px]" : "left-[2px]",
        )}
      />
    </button>
  );
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  disabled,
  className,
}: {
  value: T;
  options: Array<{ value: T; label: string; disabled?: boolean }>;
  onChange: (v: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as T)}
      className={cn(
        "h-8 max-w-56 rounded-lg border border-border bg-surface-2 px-2.5 text-xs text-text",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/**
 * DSH 式主题方块：180px 弹性块、16px 圆角、上下 20px 内边距；
 * 选中 = 平台底色（surface-3）+ 灰蓝描边，悬停 = 交互底色。
 */
export function ThemeCubes({
  value,
  onChange,
}: {
  value: "light" | "dark";
  onChange: (v: "light" | "dark") => void;
}) {
  const cubes = [
    { key: "light" as const, label: t.settings.general.themeLight, icon: Sun, dot: "bg-white border border-border" },
    { key: "dark" as const, label: t.settings.general.themeDark, icon: Moon, dot: "bg-[#151517]" },
  ];
  return (
    <div className="flex gap-2 py-1">
      {cubes.map(({ key, label, icon: Icon, dot }) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          className={cn(
            "flex w-[140px] flex-col items-center justify-center gap-1.5 rounded-2xl border px-6 py-4 text-[13px] leading-[22px] transition-colors",
            value === key
              ? "border-[#adb2b8] bg-surface-3 text-text dark:border-[#575a5f]"
              : "border-border bg-surface-2 text-text-muted hover:bg-hover hover:text-text",
          )}
        >
          <span className={cn("h-6 w-6 rounded-full", dot)} />
          <span className="flex items-center gap-1.5">
            <Icon className="h-3.5 w-3.5" strokeWidth={1.8} />
            {label}
          </span>
        </button>
      ))}
    </div>
  );
}
