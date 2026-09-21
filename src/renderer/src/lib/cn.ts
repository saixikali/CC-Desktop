import { clsx, type ClassValue } from "clsx";

/** 条件拼接 className（与 shadcn 生态一致的 cn 约定）。 */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
