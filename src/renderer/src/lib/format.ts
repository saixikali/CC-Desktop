/** 展示用格式化工具（集中中文本地化）。 */

export function formatTime(unixSeconds: number | null | undefined): string {
  if (!unixSeconds || unixSeconds <= 0) return "";
  const d = new Date(unixSeconds * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const pad = (n: number) => String(n).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (sameDay) return hm;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hm}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  return sameYear
    ? `${d.getMonth() + 1}月${d.getDate()}日`
    : `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

/** 侧栏会话相对时间：今天显示时分，昨天显示“昨天”，7 天内显示“n天”，更早回退日期。 */
export function formatRelativeTime(unixSeconds: number | null | undefined): string {
  if (!unixSeconds || unixSeconds <= 0) return "";
  const d = new Date(unixSeconds * 1000);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (dayDiff <= 0) {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  if (dayDiff === 1) return "昨天";
  if (dayDiff < 8) return `${dayDiff}天`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

/** 把路径压缩成适合侧栏展示的短形式（目录名 + 上级盘符/目录）。 */
export function shortPath(p: string | null | undefined): string {
  if (!p) return "";
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return p;
  return `${parts[0]}…${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}
