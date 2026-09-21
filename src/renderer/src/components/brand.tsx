/**
 * CC Desktop 品牌标识（自绘 SVG，不使用任何第三方商标）：
 * 圆角方形渐变底 + 白色对话气泡/C 形笔画。
 */
import { cn } from "../lib/cn.ts";

export function BrandMark({
  size = 24,
  className,
  radius = 7,
}: {
  size?: number;
  className?: string;
  /** 外框圆角半径（viewBox 24）。 */
  radius?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="cc-brand-g" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
          <stop stopColor="#5b94ff" />
          <stop offset="1" stopColor="#2f6bf0" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="22" height="22" rx={radius} fill="url(#cc-brand-g)" />
      {/* 对话气泡负形：C 形开口 + 尾部三角 */}
      <path
        d="M15.4 8.2a5 5 0 1 0 0 7.6"
        stroke="#fff"
        strokeWidth="2.1"
        strokeLinecap="round"
        fill="none"
      />
      <path d="M15.6 14.1l2.9 2.5-0.8-3.5z" fill="#fff" />
    </svg>
  );
}

/** 侧栏顶部：标识 + 字标（CC + DESKTOP 小徽标）。 */
export function BrandWordmark({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <BrandMark size={26} />
      <span className="text-[15px] font-semibold tracking-tight text-text">CC</span>
      <span className="rounded border border-border px-1 py-px text-[9px] font-semibold tracking-wider text-text-muted">
        DESKTOP
      </span>
    </div>
  );
}
