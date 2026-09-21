import { create } from "zustand";

export type ToastKind = "info" | "success" | "error";

export interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string;
  duration: number;
}

interface ToastStore {
  toasts: ToastItem[];
  push: (toast: Omit<ToastItem, "id">) => number;
  success: (title: string, description?: string) => number;
  error: (title: string, description?: string) => number;
  info: (title: string, description?: string) => number;
  dismiss: (id: number) => void;
}

let seq = 1;

// 便捷方法在初始化器外部定义，避免 create 初始化器自引用造成隐式 any 循环。
export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  push: (toast) => {
    const id = seq++;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { ...toast, id }] }));
    if (toast.duration > 0) {
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));
      }, toast.duration);
    }
    return id;
  },
  success: () => 0,
  error: () => 0,
  info: () => 0,
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));

useToastStore.setState({
  success: (title, description) =>
    useToastStore.getState().push({ kind: "success", title, description, duration: 3200 }),
  error: (title, description) =>
    useToastStore.getState().push({ kind: "error", title, description, duration: 5000 }),
  info: (title, description) =>
    useToastStore.getState().push({ kind: "info", title, description, duration: 3200 }),
});
