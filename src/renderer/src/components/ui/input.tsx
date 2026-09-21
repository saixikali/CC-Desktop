import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/cn.ts";

const fieldClass =
  "w-full rounded-lg border border-border bg-surface px-3 text-[13px] text-text " +
  "placeholder:text-text-faint select-text " +
  "hover:border-text-faint/60 focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/20 " +
  "disabled:opacity-50";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...rest }, ref) => (
    <input ref={ref} className={cn(fieldClass, "h-9", className)} {...rest} />
  ),
);
Input.displayName = "Input";

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...rest }, ref) => (
    <textarea ref={ref} className={cn(fieldClass, "py-2 leading-relaxed", className)} {...rest} />
  ),
);
Textarea.displayName = "Textarea";
